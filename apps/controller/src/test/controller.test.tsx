import type { SongDiscoveryResponse, SongDiscoverySong } from "@home-ktv/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { DEFAULT_ROOM_VOLUME_PERCENT, type RoomControlSnapshot } from "@home-ktv/player-contracts";
import {
  addQueueEntry,
  deleteQueueEntry,
  getOrCreateDeviceId,
  promoteQueueEntry,
  requestSupplement,
  setVolume,
  skipCurrent,
  switchVocalMode,
  undoDeleteQueueEntry
} from "../api/client.js";
import { App } from "../App.js";
import { fallbackPollingIntervalMs, sessionRefreshIntervalMs, useRoomController } from "../runtime/use-room-controller.js";

type RequestRecord = {
  url: string;
  method: string;
  body: unknown;
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
  window.history.pushState({}, "", "/controller?room=living-room");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile controller API client", () => {
  it("stores only home_ktv_device_id and never stores pairing or control tokens", () => {
    const deviceId = getOrCreateDeviceId();

    expect(deviceId).toMatch(/^mobile-/u);
    expect(localStorage.getItem("home_ktv_device_id")).toBe(deviceId);
    expect(Object.keys(localStorage)).toEqual(["home_ktv_device_id"]);
  });

  it("falls back to a generated device id when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    const deviceId = getOrCreateDeviceId();

    expect(deviceId).toMatch(/^mobile-/u);
    expect(localStorage.getItem("home_ktv_device_id")).toBe(deviceId);
  });

  it("falls back to a generated device id when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      }
    });

    const deviceId = getOrCreateDeviceId();

    expect(deviceId).toMatch(/^mobile-/u);
  });

  it("sends commandId, sessionVersion, and deviceId with all command helpers", async () => {
    const { requests } = installFetchMock();
    const base = {
      roomSlug: "living-room",
      deviceId: "phone-1",
      sessionVersion: 7
    };

    await addQueueEntry({ ...base, songId: "song-1" });
    await deleteQueueEntry({ ...base, queueEntryId: "queue-1" });
    await undoDeleteQueueEntry({ ...base, queueEntryId: "queue-1" });
    await promoteQueueEntry({ ...base, queueEntryId: "queue-2" });
    await skipCurrent({ ...base, confirmSkip: true });
    await switchVocalMode({ ...base, playbackPositionMs: 1234 });
    await setVolume({ ...base, volumePercent: 65 });
    await requestSupplement({
      ...base,
      provider: "demo-provider",
      providerCandidateId: "remote-qilixiang"
    });

    expect(requests.map((request) => request.url)).toEqual([
      "/rooms/living-room/commands/add-queue-entry",
      "/rooms/living-room/commands/delete-queue-entry",
      "/rooms/living-room/commands/undo-delete-queue-entry",
      "/rooms/living-room/commands/promote-queue-entry",
      "/rooms/living-room/commands/skip-current",
      "/rooms/living-room/commands/switch-vocal-mode",
      "/rooms/living-room/commands/set-volume",
      "/rooms/living-room/commands/request-supplement"
    ]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.body).toMatchObject({
        commandId: expect.stringMatching(/^mobile-command-/u),
        sessionVersion: 7,
        deviceId: "phone-1"
      });
    }
  });

  it("sends indexedAssetId without canonical ids for indexed queue commands", async () => {
    const { requests } = installFetchMock();

    await addQueueEntry({
      roomSlug: "living-room",
      deviceId: "phone-1",
      sessionVersion: 7,
      indexedAssetId: "ktv-asset-sunny-mkv"
    });

    const body = requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      commandId: expect.stringMatching(/^mobile-command-/u),
      sessionVersion: 7,
      deviceId: "phone-1",
      indexedAssetId: "ktv-asset-sunny-mkv"
    });
    expect(body).not.toHaveProperty("songId");
    expect(body).not.toHaveProperty("assetId");
  });
});

describe("mobile controller runtime", () => {
  it("switches the KTV controller chrome between Chinese and English", async () => {
    const user = userEvent.setup();
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    await screen.findByRole("heading", { name: "点歌控制台" });
    await user.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("heading", { name: "KTV controller" })).toBeTruthy();
    expect(screen.getByText("TV online")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "中文" }));

    expect(screen.getByRole("heading", { name: "点歌控制台" })).toBeTruthy();
    expect(screen.getByText("电视在线")).toBeTruthy();
    expect(screen.getByRole("region", { name: "当前播放" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "播放队列" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "首页" })).toBeTruthy();
  });

  it("starts on the discovery home and keeps playback controls behind the control tab", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    const search = await screen.findByRole("region", { name: "搜索歌曲" });
    const recommendations = screen.getByRole("region", { name: "推荐歌曲" });
    expect(search.compareDocumentPosition(recommendations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("region", { name: "当前播放" })).toBeNull();

    await openControlTab();
    const current = screen.getByRole("region", { name: "当前播放" });
    const queue = screen.getByRole("region", { name: "播放队列" });

    expect(current).toBeTruthy();
    expect(queue).toBeTruthy();
  });

  it("shows an empty online supplement state when a search has no local result and no candidates", async () => {
    const user = userEvent.setup();
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: emptySongSearchResponse
    });
    installWebSocketMock();

    render(<App />);

    await screen.findByRole("button", { name: "打开搜索" });
    const dialog = await typeSearchQuery(user, "不存在的歌曲");
    expect(dialog).toBeTruthy();

    expect(await screen.findByText("暂未找到在线补歌候选")).toBeTruthy();
    expect(screen.getByText("当前没有可请求的在线候选，可以换关键词或稍后重试。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "请求补歌" })).toBeNull();
  });

  it("loads empty song search results after control-session restore", async () => {
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await screen.findByRole("button", { name: "打开搜索" });
    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=&limit=30")).toBe(true);
    expect(requests.some((request) => request.url.startsWith("/rooms/living-room/songs/discovery?"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/available-songs"))).toBe(false);
  });

  it("renders artist, genre, and vertical recommendation discovery sections with refresh", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    expect(await screen.findByText("歌手点歌")).toBeTruthy();
    expect(screen.getByText("风格点歌")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /歌手点歌/u })).getByText("周杰伦")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /歌手点歌/u })).getByText("五月天")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /风格点歌/u })).getByText("流行")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /风格点歌/u })).getByText("摇滚")).toBeTruthy();
    expect(screen.getByRole("region", { name: "互动快捷操作" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "发表情" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "发弹幕" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "送祝福" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "推荐歌曲" })).toBeTruthy();
    expect(screen.getAllByText("周杰伦").length).toBeGreaterThan(0);
    expect(screen.getAllByText("流行").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^推荐歌曲/u, { selector: "strong" })).toHaveLength(30);
    const recommendations = screen.getByRole("region", { name: "推荐歌曲" });
    expect(within(recommendations).queryByText("本地可播")).toBeNull();
    expect(within(recommendations).queryByText("流行")).toBeNull();
    expect(within(recommendations).queryByText(/次点歌/u)).toBeNull();
    expect(recommendations.querySelector(".result-meta")).toBeNull();

    const initialDiscoveryRequests = requests.filter((request) => request.url.startsWith("/rooms/living-room/songs/discovery?"));
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await flush();

    const refreshedDiscoveryRequests = requests.filter((request) => request.url.startsWith("/rooms/living-room/songs/discovery?"));
    expect(refreshedDiscoveryRequests.length).toBeGreaterThan(initialDiscoveryRequests.length);
  });

  it("adds indexed discovery recommendations through the indexed queue command", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songDiscoveryResponse: indexedSongDiscoveryResponse
    });
    installWebSocketMock();

    render(<App />);

    const recommendations = await screen.findByRole("region", { name: "推荐歌曲" });
    expect(await within(recommendations).findByText("索引晴天")).toBeTruthy();

    await user.click(within(recommendations).getByRole("button", { name: "点歌 索引晴天" }));
    await flush();

    const addRequest = requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry");
    expect(addRequest?.body).toMatchObject({
      indexedAssetId: "ktv-asset-discovery-sunny"
    });
    expect(addRequest?.body).not.toHaveProperty("songId");
    expect(addRequest?.body).not.toHaveProperty("assetId");
  });

  it("sends emoji, bullet, and blessing shortcut interactions", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await screen.findByRole("button", { name: "发表情" });
    await user.click(screen.getByRole("button", { name: "发表情" }));
    const emojiDialog = screen.getByRole("dialog", { name: "发表情" });
    expect(emojiDialog.className).toContain("interaction-sheet");
    expect(emojiDialog.querySelectorAll(".interaction-option--emoji")).toHaveLength(48);
    expect(within(emojiDialog).getByRole("button", { name: "😀" })).toBeTruthy();
    expect(within(emojiDialog).getByRole("button", { name: "🏆" })).toBeTruthy();
    expect(within(emojiDialog).getByRole("button", { name: "🚀" })).toBeTruthy();
    expect(within(emojiDialog).getByRole("button", { name: "🎸" })).toBeTruthy();
    expect(within(emojiDialog).getByRole("button", { name: "🍿" })).toBeTruthy();
    expect(within(emojiDialog).getByRole("button", { name: "🌊" })).toBeTruthy();
    await user.click(within(emojiDialog).getByRole("button", { name: "😀" }));
    expect(screen.getByRole("dialog", { name: "发表情" })).toBeTruthy();
    await user.click(within(screen.getByRole("dialog", { name: "发表情" })).getByRole("button", { name: "🚀" }));
    await flush();

    await user.click(screen.getByRole("button", { name: "发弹幕" }));
    const bulletDialog = screen.getByRole("dialog", { name: "发弹幕" });
    expect(bulletDialog.className).toContain("interaction-sheet");
    expect(bulletDialog.querySelector(".interaction-sheet__footer")).toBeTruthy();
    await user.clear(within(bulletDialog).getByLabelText("互动内容"));
    await user.type(within(bulletDialog).getByLabelText("互动内容"), "唱得太好了");
    await user.click(within(bulletDialog).getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "发弹幕" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "送祝福" }));
    const blessingDialog = screen.getByRole("dialog", { name: "送祝福" });
    await user.click(within(blessingDialog).getByRole("button", { name: "祝家人朋友天天开心" }));
    await user.click(within(blessingDialog).getByRole("button", { name: "发送" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "送祝福" })).toBeTruthy();

    const interactionRequests = requests.filter((request) => request.url === "/rooms/living-room/interactions");
    expect(interactionRequests.map((request) => request.body)).toEqual([
      expect.objectContaining({ deviceId: "mobile-test-uuid", kind: "emoji", message: "😀" }),
      expect.objectContaining({ deviceId: "mobile-test-uuid", kind: "emoji", message: "🚀" }),
      expect.objectContaining({ deviceId: "mobile-test-uuid", kind: "bullet", message: "唱得太好了" }),
      expect.objectContaining({ deviceId: "mobile-test-uuid", kind: "blessing", message: "祝家人朋友天天开心" })
    ]);
  });

  it("repeats emoji interactions during a long press and stops after the send window", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "发表情" }));
    const emojiButton = within(screen.getByRole("dialog", { name: "发表情" })).getByRole("button", { name: "🚀" });

    fireEvent.pointerDown(emojiButton, { pointerId: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(requests.filter((request) => request.url === "/rooms/living-room/interactions")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(requests.filter((request) => request.url === "/rooms/living-room/interactions")).toHaveLength(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(requests.filter((request) => request.url === "/rooms/living-room/interactions")).toHaveLength(25);

    fireEvent.pointerUp(emojiButton, { pointerId: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(requests.filter((request) => request.url === "/rooms/living-room/interactions")).toHaveLength(25);
  });

  it("opens a search overlay with local history, instant results, and clear history", async () => {
    const user = userEvent.setup();
    localStorage.setItem("home_ktv_search_history_v1", JSON.stringify(["七里香"]));
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await screen.findByRole("button", { name: "打开搜索" });
    await user.click(screen.getByRole("button", { name: "打开搜索" }));

    expect(screen.getByRole("dialog", { name: "搜索歌曲" })).toBeTruthy();
    expect(screen.getByText("最近搜索")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "七里香" }));
    expect(await screen.findByText("七里香", { selector: "strong" })).toBeTruthy();

    const dialog = screen.getByRole("dialog", { name: "搜索歌曲" });
    await user.clear(within(dialog).getByLabelText("搜索关键词"));
    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(localStorage.getItem("home_ktv_search_history_v1")).toBe("[]");
    expect(screen.queryByRole("button", { name: "七里香" })).toBeNull();
  });

  it("debounces song search query changes by 250ms", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();
    const controller = renderControllerProbe();
    await flush();
    requests.length = 0;

    act(() => {
      controller.current?.setSongSearchQuery("qlx");
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=qlx&limit=30")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await flush();
    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=qlx&limit=30")).toBe(true);
  });

  it("submits the latest song search query immediately", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();
    const controller = renderControllerProbe();
    await flush();
    requests.length = 0;

    act(() => {
      controller.current?.setSongSearchQuery("qlx");
      controller.current?.submitSongSearch();
    });
    await flush();

    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=qlx&limit=30")).toBe(true);
  });

  it("sends selected assetId when adding a song version", async () => {
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();
    const controller = renderControllerProbe();
    await flush();

    await act(async () => {
      await controller.current?.addSongVersion("song-ready", "asset-ready-alt");
    });

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      songId: "song-ready",
      assetId: "asset-ready-alt"
    });
  });

  it("requires duplicate confirmation before re-adding a queued song version", async () => {
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();
    const controller = renderControllerProbe();
    await flush();

    act(() => {
      controller.current?.requestAddSongVersion("song-ready", "asset-ready-alt", "Ready Song", "queued");
    });

    expect(controller.current?.duplicateConfirm).toEqual({
      kind: "canonical",
      songId: "song-ready",
      assetId: "asset-ready-alt",
      title: "Ready Song"
    });
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);

    await act(async () => {
      await controller.current?.confirmDuplicateAdd();
    });

    expect(controller.current?.duplicateConfirm).toBeNull();
    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      songId: "song-ready",
      assetId: "asset-ready-alt"
    });
  });

  it("requires duplicate confirmation before re-adding a queued indexed asset", async () => {
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();
    const controller = renderControllerProbe();
    await flush();

    act(() => {
      controller.current?.requestAddIndexedAsset("ktv-asset-sunny-mkv", "索引晴天", "queued");
    });

    expect(controller.current?.duplicateConfirm).toEqual({
      kind: "indexed",
      indexedAssetId: "ktv-asset-sunny-mkv",
      title: "索引晴天"
    });
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);

    await act(async () => {
      await controller.current?.confirmDuplicateAdd();
    });

    expect(controller.current?.duplicateConfirm).toBeNull();
    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      indexedAssetId: "ktv-asset-sunny-mkv"
    });
  });

  it("tries cookie restore before token exchange and removes token after success", async () => {
    window.history.pushState({}, "", "/controller?room=living-room&token=pair-token");
    const { requests } = installControllerFetchMock({
      restoreResponses: [json({ code: "CONTROL_SESSION_REQUIRED" }, 401)],
      createResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    expect(requests.slice(0, 2).map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /rooms/living-room/control-session?deviceId=mobile-test-uuid",
      "POST /rooms/living-room/control-sessions"
    ]);
    expect(window.location.search).toBe("?room=living-room");
  });

  it("falls back to cookie restore when token exchange returns INVALID_PAIRING_TOKEN", async () => {
    window.history.pushState({}, "", "/controller?room=living-room&token=expired-token");
    const { requests } = installControllerFetchMock({
      restoreResponses: [json({ code: "CONTROL_SESSION_REQUIRED" }, 401), json(sessionResponse(roomSnapshot()))],
      createResponses: [json({ code: "INVALID_PAIRING_TOKEN" }, 401)]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    expect(requests.slice(0, 3).map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /rooms/living-room/control-session?deviceId=mobile-test-uuid",
      "POST /rooms/living-room/control-sessions",
      "GET /rooms/living-room/control-session?deviceId=mobile-test-uuid"
    ]);
    expect(window.location.search).toBe("?room=living-room");
  });

  it("shows reconnect state and polls every 5000ms after WebSocket disconnect", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot())), json(sessionResponse(roomSnapshot({ sessionVersion: 2 })))]
    });
    const sockets = installWebSocketMock();

    render(<App />);
    await flush();
    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    sockets[0]?.emitOpen();
    sockets[0]?.emitClose();

    await flush();
    expect(screen.getByText("连接中断，正在重连")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(fallbackPollingIntervalMs);
    expect(requests.filter((request) => request.url.includes("/control-session")).length).toBeGreaterThanOrEqual(2);
  });

  it("refreshes the httpOnly cookie Max-Age every 15 minutes while WebSocket is connected", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot())), json(sessionResponse(roomSnapshot({ sessionVersion: 2 })))]
    });
    const sockets = installWebSocketMock();

    render(<App />);
    await flush();
    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    sockets[0]?.emitOpen();
    await vi.advanceTimersByTimeAsync(sessionRefreshIntervalMs);
    expect(requests.filter((request) => request.url.includes("/control-session")).length).toBeGreaterThanOrEqual(2);
  });

  it("confirms skip before sending confirmSkip true", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/skip-current": json({ status: "accepted", snapshot: roomSnapshot({ sessionVersion: 2 }) })
      }
    });
    installWebSocketMock();

    render(<App />);
    await openControlTab();
    await user.click(screen.getByRole("button", { name: "切歌" }));
    expect(screen.getByRole("dialog", { name: "确认切歌" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认" }));
    await flush();

    expect(requests.some((request) => request.url === "/rooms/living-room/commands/skip-current")).toBe(true);
    expect(requests.find((request) => request.url === "/rooms/living-room/commands/skip-current")?.body).toMatchObject({
      confirmSkip: true
    });
  });

  it("marks destructive queue and skip actions with danger styling hooks", async () => {
    const user = userEvent.setup();
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    await screen.findByText("下一首");
    expect(screen.getByRole("button", { name: "删除" }).className).toContain("danger-button");

    await user.click(screen.getByRole("button", { name: "切歌" }));
    expect(screen.getByRole("button", { name: "确认" }).className).toContain("danger-button");
  });

  it("deletes immediately and shows undo only from server undoExpiresAt", async () => {
    const user = userEvent.setup();
    const undoExpiresAt = "2026-05-04T10:01:00.000Z";
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/delete-queue-entry": json({
          status: "accepted",
          snapshot: roomSnapshot({ queueUndoExpiresAt: undoExpiresAt, queueStatus: "removed", sessionVersion: 2 }),
          undo: { queueEntryId: "queue-next", undoExpiresAt }
        }),
        "/rooms/living-room/commands/undo-delete-queue-entry": json({
          status: "accepted",
          snapshot: roomSnapshot({ sessionVersion: 3 })
        })
      }
    });
    installWebSocketMock();

    render(<App />);
    await openControlTab();
    await screen.findByText("下一首");
    expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(await screen.findByRole("button", { name: "撤销" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/undo-delete-queue-entry")).toBe(true);
  });

  it("sends vocal switch immediately without confirmation", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/switch-vocal-mode": json({
          status: "accepted",
          snapshot: roomSnapshot({ sessionVersion: 2 })
        })
      }
    });
    installWebSocketMock();

    render(<App />);
    await openControlTab();
    await screen.findByRole("button", { name: "切到原唱" });
    await user.click(screen.getByRole("button", { name: "切到原唱" }));
    await flush();

    expect(requests.some((request) => request.url === "/rooms/living-room/commands/switch-vocal-mode")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "确认切歌" })).toBeNull();
  });

  it("shows the switch-to-instrumental control when the current track is original", async () => {
    const user = userEvent.setup();
    const baseSnapshot = roomSnapshot();
    const currentTarget = baseSnapshot.currentTarget!;
    const switchTarget = baseSnapshot.switchTarget!;
    const originalSnapshot: RoomControlSnapshot = {
      ...baseSnapshot,
      currentTarget: {
        currentQueueEntryPreview: currentTarget.currentQueueEntryPreview,
        nextQueueEntryPreview: currentTarget.nextQueueEntryPreview,
        queueEntryId: currentTarget.queueEntryId,
        resumePositionMs: currentTarget.resumePositionMs,
        roomId: currentTarget.roomId,
        sessionVersion: currentTarget.sessionVersion,
        assetId: "asset-original",
        playbackUrl: "http://ktv.local/media/asset-original",
        switchFamily: currentTarget.switchFamily,
        vocalMode: "original"
      },
      switchTarget: {
        playbackUrl: "http://ktv.local/media/asset-instrumental",
        queueEntryId: switchTarget.queueEntryId,
        resumePositionMs: switchTarget.resumePositionMs,
        rollbackAssetId: "asset-original",
        roomId: switchTarget.roomId,
        sessionVersion: switchTarget.sessionVersion,
        switchKind: "asset",
        switchFamily: switchTarget.switchFamily,
        fromAssetId: "asset-original",
        toAssetId: "asset-instrumental",
        vocalMode: "instrumental"
      }
    };
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(originalSnapshot))],
      commandResponses: {
        "/rooms/living-room/commands/switch-vocal-mode": json({
          status: "accepted",
          snapshot: {
            ...originalSnapshot,
            sessionVersion: 2
          }
        })
      }
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    expect(screen.getByRole("button", { name: "切到伴唱" })).toBeTruthy();
    expect(screen.getByLabelText("current-vocal-mode").textContent).toContain("原唱");

    await user.click(screen.getByRole("button", { name: "切到伴唱" }));
    await flush();

    expect(requests.some((request) => request.url === "/rooms/living-room/commands/switch-vocal-mode")).toBe(true);
    expect(requests.find((request) => request.url === "/rooms/living-room/commands/switch-vocal-mode")?.body).toMatchObject({
      playbackPositionMs: 1234
    });
  });

  it("shows the current vocal mode clearly in the playback panel", async () => {
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(requests.some((request) => request.url.includes("/control-session"))).toBe(true);
    const modeSummary = screen.getByLabelText("current-vocal-mode");
    expect(modeSummary.textContent).toContain("当前模式");
    expect(modeSummary.textContent).toContain("伴唱");
  });

  it("renders one room volume slider and sends set-volume after adjustment", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot({ volumePercent: 70 })))],
      commandResponses: {
        "/rooms/living-room/commands/set-volume": json({
          status: "accepted",
          snapshot: roomSnapshot({ sessionVersion: 2, volumePercent: 65 })
        })
      }
    });
    installWebSocketMock();

    render(<App />);

    await flush();
    await openControlTab();
    expect(screen.getByText("电视在线")).toBeTruthy();
    expect(screen.getByText("音量")).toBeTruthy();
    expect(screen.getByText("70%")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("音量"), { target: { value: "65" } });
    expect(screen.getByText("65%")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(220);
    await flush();

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/set-volume")?.body).toMatchObject({
      volumePercent: 65
    });
  });

  it("falls back to 50 when the restored snapshot omits volume", async () => {
    const snapshotWithoutVolume = roomSnapshot();
    delete (snapshotWithoutVolume as { volumePercent?: number }).volumePercent;
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(snapshotWithoutVolume))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(screen.getByText("音量")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("does not expose raw playback or vocal enum labels in the Chinese controller", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    expect(screen.getByText("播放中")).toBeTruthy();
    expect(screen.getAllByText("伴唱").length).toBeGreaterThan(0);
    expect(screen.getByText("当前模式")).toBeTruthy();

    const appText = screen.getByLabelText("Home KTV 点歌控制台").textContent ?? "";
    expect(appText).not.toContain("unknown");
    expect(appText).not.toContain("original");
    expect(appText).not.toContain("instrumental");
    expect(appText).not.toContain("playing");
  });

  it("searches while typing and submits immediately from the search form", async () => {
    vi.useFakeTimers();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);
    await flush();
    expect(screen.getByRole("button", { name: "打开搜索" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开搜索" }));
    const dialog = screen.getByRole("dialog", { name: "搜索歌曲" });
    const searchInput = within(dialog).getByLabelText("搜索关键词");
    requests.length = 0;

    fireEvent.change(searchInput, { target: { value: "qlx" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=qlx&limit=30")).toBe(true);

    requests.length = 0;
    fireEvent.change(searchInput, { target: { value: "晴天" } });
    fireEvent.submit(searchInput.closest("form")!);
    await flush();
    expect(requests.some((request) => request.url === "/rooms/living-room/songs/search?q=%E6%99%B4%E5%A4%A9&limit=30")).toBe(true);
  });

  it("renders local search results, statuses, version hints, and selected asset add buttons", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(user, "晴天");
    const search = within(dialog);
    expect(await search.findByText("晴天", { selector: "strong" })).toBeTruthy();
    expect(search.getByText("本地可播")).toBeTruthy();
    expect(search.getByText("已点 / 队列中")).toBeTruthy();
    expect(search.getByText("1 个版本")).toBeTruthy();
    expect(search.getByText("2 个版本")).toBeTruthy();
    expect(search.getByText("推荐")).toBeTruthy();
    expect(search.getByText("现场版")).toBeTruthy();

    await user.click(search.getByRole("button", { name: "点歌" }));
    await flush();

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      songId: "song-sunny",
      assetId: "asset-sunny-main"
    });
    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).not.toHaveProperty(
      "vocalMode"
    );
  });

  it("keeps disabled real MV search results visible without queueing them", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [
          {
            songId: "song-real-mv-needs-preprocess",
            title: "真实 MV 样本",
            artistName: "样本歌手",
            language: "mandarin",
            matchReason: "title",
            queueState: "not_queued",
            versions: [
              {
                assetId: "asset-real-mv-needs-preprocess",
                displayName: "MKV 双声轨",
                sourceType: "local",
                sourceLabel: "本地",
                durationMs: 60000,
                qualityLabel: "需处理",
                isRecommended: true,
                queueState: "needs_preprocess",
                canQueue: false,
                disabledLabel: "需预处理"
              }
            ]
          }
        ],
        online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
      })
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(user, "真实 MV 样本");
    const search = within(dialog);
    await search.findByText("真实 MV 样本", { selector: "strong" });
    expect(search.getAllByText("需预处理").length).toBeGreaterThanOrEqual(1);
    const disabledButton = search.getByRole("button", { name: "需预处理" }) as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    await user.click(disabledButton);

    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);
  });

  it("queues indexed KTV search versions with indexedAssetId only and inline pending state", async () => {
    const user = userEvent.setup();
    const indexedCommand = deferred<Response>();
    const nasPathPrefix = ["/m", "nt", "/n", "as"].join("");
    const rawCamelPathKey = ["file", "Path"].join("");
    const rawSnakePathKey = ["file", "_", "path"].join("");
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/add-queue-entry": indexedCommand.promise
      },
      songSearchResponse: (query) => ({
        query,
        local: [],
        indexed: {
          status: "available",
          message: "找到 KTV 索引结果",
          results: [
            {
              indexedSongId: "ktv-song-sunny",
              title: "索引晴天",
              artistName: "周杰伦",
              category: "流行",
              sourceLabel: "KTV索引",
              matchReason: "title",
              versions: [
                {
                  indexedAssetId: "ktv-asset-sunny-mkv",
                  displayName: "索引晴天.mkv",
                  sourceLabel: "KTV索引",
                  extension: ".mkv",
                  sizeBytes: 734003200,
                  audioTrackCount: 1,
                  category: "流行",
                  queueState: "not_queued",
                  canQueue: true,
                  disabledLabel: null,
                  [rawCamelPathKey]: `${nasPathPrefix}/KTV歌曲/索引晴天.mkv`
                },
                {
                  indexedAssetId: "ktv-asset-sunny-mpg",
                  displayName: "索引晴天.mpg",
                  sourceLabel: "KTV索引",
                  extension: ".mpg",
                  sizeBytes: null,
                  category: "流行",
                  queueState: "queued",
                  canQueue: true,
                  disabledLabel: null,
                  [rawSnakePathKey]: `${nasPathPrefix}/KTV歌曲/索引晴天.mpg`
                }
              ]
            }
          ]
        },
        online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
      })
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(user, "索引晴天");
    const search = within(dialog);
    expect(await search.findByText("KTV 索引结果")).toBeTruthy();
    expect(search.getByText("索引晴天")).toBeTruthy();
    expect(search.getAllByText("KTV索引").length).toBeGreaterThan(0);
    expect(search.getByText("2 个索引版本")).toBeTruthy();
    expect(search.getByText("单音轨歌曲源")).toBeTruthy();
    expect(search.getByText("未知大小")).toBeTruthy();
    const addButton = search.getByRole("button", { name: "点歌" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    expect(search.getByRole("button", { name: "已点" })).toBeTruthy();

    await user.click(addButton);

    const pendingButton = await search.findByRole("button", { name: "正在加入..." });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    const body = requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")
      ?.body as Record<string, unknown>;
    expect(body).toMatchObject({ indexedAssetId: "ktv-asset-sunny-mkv" });
    expect(body).not.toHaveProperty("songId");
    expect(body).not.toHaveProperty("assetId");
    expect(JSON.stringify(body)).not.toContain(nasPathPrefix);
    expect(JSON.stringify(body)).not.toContain(rawCamelPathKey);
    expect(JSON.stringify(body)).not.toContain(rawSnakePathKey);
    const searchPanelText = dialog.textContent ?? "";
    expect(searchPanelText).not.toContain(nasPathPrefix);
    expect(searchPanelText).not.toContain(rawCamelPathKey);
    expect(searchPanelText).not.toContain(rawSnakePathKey);

    indexedCommand.resolve(
      json({
        status: "accepted",
        commandId: "mobile-command-test",
        sessionVersion: 2,
        snapshot: roomSnapshot({ sessionVersion: 2 })
      })
    );
    await flush();
  });

  it("opens duplicate confirmation from a queued indexed search version before sending indexedAssetId", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [],
        indexed: {
          status: "available",
          message: "找到 KTV 索引结果",
          results: [
            {
              indexedSongId: "ktv-song-sunny",
              title: "索引晴天",
              artistName: "周杰伦",
              category: "流行",
              sourceLabel: "KTV索引",
              matchReason: "title",
              versions: [
                {
                  indexedAssetId: "ktv-asset-sunny-mpg",
                  displayName: "索引晴天.mpg",
                  sourceLabel: "KTV索引",
                  extension: ".mpg",
                  sizeBytes: 734003200,
                  category: "流行",
                  queueState: "queued",
                  canQueue: true,
                  disabledLabel: null
                }
              ]
            }
          ]
        },
        online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
      })
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(user, "索引晴天");
    const search = within(dialog);
    await search.findByText("索引晴天");
    await user.click(search.getByRole("button", { name: "已点" }));

    expect(screen.getByRole("dialog", { name: "重复点歌" })).toBeTruthy();
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);

    await user.click(screen.getByRole("button", { name: "确认加点" }));
    await flush();

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      indexedAssetId: "ktv-asset-sunny-mpg"
    });
  });

  it("keeps disabled indexed KTV states visible with explicit labels", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [],
        indexed: {
          status: "available",
          message: "找到 KTV 索引结果",
          results: [
            {
              indexedSongId: "ktv-song-disabled",
              title: "索引失效歌曲",
              artistName: "样本歌手",
              category: "流行",
              sourceLabel: "KTV索引",
              matchReason: "title",
              versions: [
                {
                  indexedAssetId: "ktv-asset-stale",
                  displayName: "索引失效.mkv",
                  sourceLabel: "KTV索引",
                  extension: ".mkv",
                  sizeBytes: 1024,
                  category: "流行",
                  queueState: "source_missing",
                  canQueue: false,
                  disabledLabel: "索引已失效"
                },
                {
                  indexedAssetId: "ktv-asset-unreadable",
                  displayName: "不可读.mpg",
                  sourceLabel: "KTV索引",
                  extension: ".mpg",
                  sizeBytes: 2048,
                  category: "流行",
                  queueState: "file_unreadable",
                  canQueue: false,
                  disabledLabel: "文件不可读"
                }
              ]
            }
          ]
        },
        online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
      })
    });
    installWebSocketMock();

    render(<App />);

    await typeSearchQuery(userEvent.setup(), "索引失效");
    expect(await screen.findByRole("button", { name: "索引已失效" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "文件不可读" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "索引已失效" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "文件不可读" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("falls back to a short disabled real MV search label", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [
          {
            songId: "song-real-mv-disabled",
            title: "暂不可播 MV",
            artistName: "样本歌手",
            language: "mandarin",
            matchReason: "title",
            queueState: "not_queued",
            versions: [
              {
                assetId: "asset-real-mv-disabled",
                displayName: "MPG 双声轨",
                sourceType: "local",
                sourceLabel: "本地",
                durationMs: 60000,
                qualityLabel: "未知兼容性",
                isRecommended: false,
                queueState: "temporarily_unavailable",
                canQueue: false,
                disabledLabel: null
              }
            ]
          }
        ],
        online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
      })
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(userEvent.setup(), "暂不可播 MV");
    const search = within(dialog);
    await search.findByText("暂不可播 MV", { selector: "strong" });
    expect(search.getByRole("button", { name: "暂不可播放" })).toBeTruthy();
  });

  it("confirms queued multi-version duplicate add before sending the selected assetId", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))]
    });
    installWebSocketMock();

    render(<App />);
    await typeSearchQuery(user, "七里香");
    const versionButtons = screen.getAllByRole("button", { name: "点这个版本" });

    await user.click(versionButtons[1]!);

    expect(screen.getByRole("dialog", { name: "重复点歌" })).toBeTruthy();
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认加点" }));
    await flush();

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/add-queue-entry")?.body).toMatchObject({
      songId: "song-qlx",
      assetId: "asset-qlx-live"
    });
  });

  it("keeps real MV vocal switching available when the source asset has no switch family", async () => {
    const user = userEvent.setup();
    const realMvSnapshot = realMvControlSnapshot();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(realMvSnapshot))],
      commandResponses: {
        "/rooms/living-room/commands/switch-vocal-mode": json({
          status: "accepted",
          snapshot: {
            ...realMvSnapshot,
            sessionVersion: 2
          }
        })
      }
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    const switchButton = screen.getByRole("button", { name: "切到原唱" }) as HTMLButtonElement;
    expect(switchButton.disabled).toBe(false);
    await user.click(switchButton);
    await flush();

    expect(requests.some((request) => request.url === "/rooms/living-room/commands/switch-vocal-mode")).toBe(true);
  });

  it("shows a Chinese switch unavailable error without permanently disabling the switch", async () => {
    const user = userEvent.setup();
    const realMvSnapshot = realMvControlSnapshot();
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(realMvSnapshot))],
      commandResponses: {
        "/rooms/living-room/commands/switch-vocal-mode": json({ code: "SWITCH_TARGET_NOT_AVAILABLE" }, 409)
      }
    });
    installWebSocketMock();

    render(<App />);

    await openControlTab();
    const switchButton = (await screen.findByRole("button", { name: "切到原唱" })) as HTMLButtonElement;
    await user.click(switchButton);

    expect(await screen.findByText("当前歌曲暂不支持切换原唱/伴唱")).toBeTruthy();
    expect(switchButton.disabled).toBe(false);
  });

  it("renders switch failure notices from the room snapshot", async () => {
    installControllerFetchMock({
      restoreResponses: [
        json(
          sessionResponse({
            ...roomSnapshot(),
            notice: {
              kind: "switch_failed_reverted",
              message: "原唱/伴唱切换失败，已保持当前播放。"
            }
          })
        )
      ]
    });
    installWebSocketMock();

    render(<App />);

    expect(await screen.findByText("原唱/伴唱切换失败，已保持当前播放。")).toBeTruthy();
  });

  it("shows local empty state before actionable online supplement candidates without disabled duplicate controls", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [],
        online: {
          status: "available",
          message: "找到在线补歌候选",
          requestSupplement: { visible: true, label: "请求补歌" },
          candidates: [
            {
              provider: "demo-provider",
              providerCandidateId: "remote-qilixiang",
              title: "七里香",
              artistName: "周杰伦",
              sourceLabel: "Demo Provider",
              durationMs: 180000,
              candidateType: "mv",
              reliabilityLabel: "high",
              riskLabel: "normal",
              taskState: "discovered",
              taskId: "task-1"
            }
          ]
        }
      })
    });
    installWebSocketMock();

    render(<App />);

    await screen.findByRole("button", { name: "打开搜索" });
    const dialog = await typeSearchQuery(userEvent.setup(), "不存在的在线候选");
    const search = within(dialog);
    expect(search.getByText("本地未找到")).toBeTruthy();
    expect(search.getByText("找到在线补歌候选")).toBeTruthy();
    const requestButtons = search.getAllByRole("button", { name: "请求补歌" }) as HTMLButtonElement[];
    expect(requestButtons).toHaveLength(1);
    expect(requestButtons[0]?.disabled).toBe(false);
    expect(search.getByText("七里香", { selector: "strong" })).toBeTruthy();
    expect(search.getByText("MV")).toBeTruthy();
    expect(search.getByText("高可靠")).toBeTruthy();
    expect(search.getByText("普通风险")).toBeTruthy();
    expect(search.getByText("已发现")).toBeTruthy();
    expect(search.queryByRole("button", { name: "加点" })).toBeNull();
    expect(search.queryByRole("button", { name: "点歌" })).toBeNull();
  });

  it("renders online supplement candidates below local results when both exist", async () => {
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      songSearchResponse: (query) => ({
        query,
        local: [
          {
            songId: "song-sunny",
            title: "晴天",
            artistName: "周杰伦",
            language: "mandarin",
            matchReason: "title",
            queueState: "not_queued",
            versions: [
              {
                assetId: "asset-sunny-main",
                displayName: "高清版",
                sourceType: "local",
                sourceLabel: "本地",
                durationMs: 180000,
                qualityLabel: "HD",
                isRecommended: true
              }
            ]
          }
        ],
        online: {
          status: "available",
          message: "找到在线补歌候选",
          requestSupplement: { visible: true, label: "请求补歌" },
          candidates: [
            {
              provider: "demo-provider",
              providerCandidateId: "remote-qilixiang",
              title: "远端七里香",
              artistName: "周杰伦",
              sourceLabel: "Demo Provider",
              durationMs: 180000,
              candidateType: "mv",
              reliabilityLabel: "high",
              riskLabel: "normal",
              taskState: "discovered",
              taskId: "task-1"
            }
          ]
        }
      })
    });
    installWebSocketMock();

    render(<App />);

    const dialog = await typeSearchQuery(userEvent.setup(), "晴天");
    const search = within(dialog);
    await search.findByText("晴天", { selector: "strong" });
    await search.findByText("远端七里香");
    const searchPanelText = dialog.textContent ?? "";
    const localIndex = searchPanelText.indexOf("晴天");
    const onlineIndex = searchPanelText.indexOf("远端七里香");

    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(onlineIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeLessThan(onlineIndex);
  });

  it("keeps request supplement disabled while submission is pending and then shows ready state", async () => {
    const user = userEvent.setup();
    const supplement = deferred<Response>();
    installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/request-supplement": supplement.promise
      },
      songSearchResponse: (query) => ({
        query,
        local: [],
        online: {
          status: "available",
          message: "找到在线补歌候选",
          requestSupplement: { visible: true, label: "请求补歌" },
          candidates: [
            {
              provider: "demo-provider",
              providerCandidateId: "remote-qilixiang",
              title: "七里香",
              artistName: "周杰伦",
              sourceLabel: "Demo Provider",
              durationMs: 180000,
              candidateType: "mv",
              reliabilityLabel: "high",
              riskLabel: "normal",
              taskState: "discovered",
              taskId: "task-1"
            }
          ]
        }
      })
    });
    installWebSocketMock();

    render(<App />);

    await typeSearchQuery(user, "七里香");
    await screen.findByText("七里香", { selector: "strong" });
    const requestButton = screen.getByRole("button", { name: "请求补歌" }) as HTMLButtonElement;
    expect(requestButton.disabled).toBe(false);
    await user.click(requestButton);

    const pendingButton = await screen.findByRole("button", { name: "提交中" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);

    supplement.resolve(
      json({
        status: "accepted",
        commandId: "mobile-command-test",
        sessionVersion: 2,
        task: readySupplementTask()
      })
    );
    await flush();

    expect(screen.getAllByText("已准备").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "已准备" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requests supplement explicitly from an online candidate without auto-enqueueing", async () => {
    const user = userEvent.setup();
    const { requests } = installControllerFetchMock({
      restoreResponses: [json(sessionResponse(roomSnapshot()))],
      commandResponses: {
        "/rooms/living-room/commands/request-supplement": json({
          status: "accepted",
          commandId: "mobile-command-test",
          sessionVersion: 2,
          task: {
            id: "task-1",
            roomId: "living-room",
            provider: "demo-provider",
            providerCandidateId: "remote-qilixiang",
            title: "七里香",
            artistName: "周杰伦",
            sourceLabel: "Demo Provider",
            durationMs: 180000,
            candidateType: "mv",
            reliabilityLabel: "high",
            riskLabel: "normal",
            status: "ready",
            failureReason: null,
            recentEvent: { type: "ready" },
            providerPayload: {},
            readyAssetId: "asset-ready-online",
            createdAt: "2026-05-04T10:00:00.000Z",
            updatedAt: "2026-05-04T10:00:01.000Z",
            selectedAt: "2026-05-04T10:00:00.500Z",
            reviewRequiredAt: null,
            fetchingAt: "2026-05-04T10:00:00.600Z",
            fetchedAt: "2026-05-04T10:00:00.700Z",
            readyAt: "2026-05-04T10:00:01.000Z",
            failedAt: null,
            staleAt: null,
            promotedAt: null,
            purgedAt: null
          }
        })
      },
      songSearchResponse: (query) => ({
        query,
        local: [],
        online: {
          status: "available",
          message: "找到在线补歌候选",
          requestSupplement: { visible: true, label: "请求补歌" },
          candidates: [
            {
              provider: "demo-provider",
              providerCandidateId: "remote-qilixiang",
              title: "七里香",
              artistName: "周杰伦",
              sourceLabel: "Demo Provider",
              durationMs: 180000,
              candidateType: "mv",
              reliabilityLabel: "high",
              riskLabel: "normal",
              taskState: "discovered",
              taskId: "task-1"
            }
          ]
        }
      })
    });
    installWebSocketMock();

    render(<App />);

    await typeSearchQuery(user, "七里香");
    await screen.findByText("七里香", { selector: "strong" });
    await user.click(screen.getByRole("button", { name: "请求补歌" }));
    await flush();

    expect(requests.find((request) => request.url === "/rooms/living-room/commands/request-supplement")?.body).toMatchObject({
      provider: "demo-provider",
      providerCandidateId: "remote-qilixiang"
    });
    expect(screen.getAllByText("已准备").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "已准备" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.some((request) => request.url === "/rooms/living-room/commands/add-queue-entry")).toBe(false);
  });
});

function installFetchMock() {
  const requests: RequestRecord[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), "http://controller.test");
      requests.push({
        url: `${requestUrl.pathname}${requestUrl.search}`,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      return new Response(JSON.stringify({ status: "accepted", sessionVersion: 8, snapshot: null }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    })
  );
  return { requests };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openControlTab() {
  fireEvent.click(screen.getByRole("button", { name: /控制|Control/u }));
  await flush();
  return screen.getByRole("region", { name: /当前播放|Current playback/u });
}

async function openSearchOverlay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "打开搜索" }));
  return screen.getByRole("dialog", { name: "搜索歌曲" });
}

async function typeSearchQuery(user: ReturnType<typeof userEvent.setup>, query: string) {
  const dialog = await openSearchOverlay(user);
  const input = within(dialog).getByLabelText("搜索关键词");
  await user.clear(input);
  await user.type(input, query);
  return dialog;
}

function installControllerFetchMock(options: {
  restoreResponses?: Response[];
  createResponses?: Response[];
  commandResponses?: Record<string, Response | Promise<Response>>;
  songSearchResponse?: (query: string) => unknown;
  songDiscoveryResponse?: (seed: string) => unknown;
} = {}) {
  const requests: RequestRecord[] = [];
  const restoreResponses = [...(options.restoreResponses ?? [json(sessionResponse(roomSnapshot()))])];
  const createResponses = [...(options.createResponses ?? [json(sessionResponse(roomSnapshot()))])];
  const commandResponses = options.commandResponses ?? {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), "http://controller.test");
      const url = `${requestUrl.pathname}${requestUrl.search}`;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });

      if (method === "GET" && requestUrl.pathname.endsWith("/control-session")) {
        return restoreResponses.shift() ?? json(sessionResponse(roomSnapshot()));
      }

      if (method === "POST" && requestUrl.pathname.endsWith("/control-sessions")) {
        return createResponses.shift() ?? json(sessionResponse(roomSnapshot()));
      }

      if (method === "GET" && requestUrl.pathname.endsWith("/available-songs")) {
        return json({
          songs: [{ songId: "song-ready", title: "晴天", artistName: "周杰伦", language: "mandarin", defaultAssetId: "asset-ready", durationMs: 180000 }]
        });
      }

      if (method === "GET" && requestUrl.pathname.endsWith("/songs/search")) {
        const query = requestUrl.searchParams.get("q") ?? "";
        return json((options.songSearchResponse ?? songSearchResponse)(query));
      }

      if (method === "GET" && requestUrl.pathname.endsWith("/songs/discovery")) {
        const seed = requestUrl.searchParams.get("seed") ?? "";
        return json((options.songDiscoveryResponse ?? songDiscoveryResponse)(seed));
      }

      if (method === "POST" && requestUrl.pathname.endsWith("/interactions")) {
        return json({
          status: "accepted",
          interaction: {
            id: "interaction-test",
            roomId: "living-room",
            roomSlug: "living-room",
            kind: body?.kind,
            message: body?.message,
            senderDeviceId: body?.deviceId,
            senderName: "Phone",
            createdAt: "2026-05-27T10:00:00.000Z",
            expiresAt: "2026-05-27T10:00:07.000Z"
          }
        });
      }

      const commandResponse = commandResponses[requestUrl.pathname];
      if (method === "POST" && commandResponse) {
        return commandResponse;
      }

      if (method === "POST" && requestUrl.pathname.includes("/commands/")) {
        return json({ status: "accepted", snapshot: roomSnapshot({ sessionVersion: 2 }) });
      }

      return json({ code: "NOT_FOUND" }, 404);
    })
  );

  return { requests };
}

function renderControllerProbe() {
  const holder: { current: any } = { current: null };

  function ControllerProbe() {
    const controller = useRoomController();
    useEffect(() => {
      holder.current = controller;
    }, [controller]);
    return null;
  }

  render(<ControllerProbe />);
  return holder;
}

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  close(): void {}

  emitOpen(): void {
    this.onopen?.();
  }

  emitClose(): void {
    this.onclose?.();
  }

  emitSnapshot(snapshot: RoomControlSnapshot): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "room.control.snapshot.updated",
        payload: snapshot
      })
    });
  }
}

function installWebSocketMock(): FakeWebSocket[] {
  const sockets: FakeWebSocket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
  );
  return sockets;
}

function sessionResponse(snapshot: RoomControlSnapshot) {
  return {
    controlSession: {
      id: "control-session-1",
      roomId: "living-room",
      roomSlug: "living-room",
      deviceId: "mobile-test-uuid",
      deviceName: "Phone",
      expiresAt: "2026-05-04T12:00:00.000Z",
      lastSeenAt: "2026-05-04T10:00:00.000Z"
    },
    snapshot
  };
}

function songSearchResponse(query: string) {
  return {
    query,
    local: [
      {
        songId: "song-sunny",
        title: "晴天",
        artistName: "周杰伦",
        language: "mandarin",
        matchReason: query ? "initials" : "default",
        queueState: "not_queued",
        versions: [
          {
            assetId: "asset-sunny-main",
            displayName: "高清版",
            sourceType: "local",
            sourceLabel: "本地",
            durationMs: 180000,
            qualityLabel: "HD",
            isRecommended: true
          }
        ]
      },
      {
        songId: "song-qlx",
        title: "七里香",
        artistName: "周杰伦",
        language: "mandarin",
        matchReason: query ? "initials" : "default",
        queueState: "queued",
        versions: [
          {
            assetId: "asset-qlx-hd",
            displayName: "高清版",
            sourceType: "local",
            sourceLabel: "本地",
            durationMs: 240000,
            qualityLabel: "HD",
            isRecommended: true
          },
          {
            assetId: "asset-qlx-live",
            displayName: "现场版",
            sourceType: "online_cached",
            sourceLabel: "缓存",
            durationMs: 245000,
            qualityLabel: "Live",
            isRecommended: false
          }
        ]
      }
    ],
    online: { status: "disabled", message: "本地未入库，补歌功能后续可用", candidates: [] }
  };
}

function songDiscoveryResponse(seed: string): SongDiscoveryResponse {
  const recommended = Array.from({ length: 30 }, (_, index) =>
    discoverySong({
      songId: `song-recommend-${index + 1}`,
      title: `推荐歌曲${index + 1}`,
      artistId: index % 2 === 0 ? "artist-jay" : "artist-mayday",
      artistName: index % 2 === 0 ? "周杰伦" : "五月天",
      genre: index % 2 === 0 ? ["流行"] : ["摇滚"],
      playCount: 30 - index
    })
  );

  return {
    seed,
    recommended,
    artists: [
      {
        artistId: "artist-jay",
        artistName: "周杰伦",
        songCount: 2,
        songs: [recommended[0]!, recommended[2]!]
      },
      {
        artistId: "artist-mayday",
        artistName: "五月天",
        songCount: 2,
        songs: [recommended[1]!, recommended[3]!]
      }
    ],
    genres: [
      {
        genre: "流行",
        songCount: 2,
        songs: [recommended[0]!, recommended[2]!]
      },
      {
        genre: "摇滚",
        songCount: 2,
        songs: [recommended[1]!, recommended[3]!]
      }
    ]
  };
}

function indexedSongDiscoveryResponse(seed: string): SongDiscoveryResponse {
  const song: SongDiscoverySong = {
    source: "ktv-index",
    songId: "song-ktv-ktv-song-discovery-sunny",
    indexedSongId: "ktv-song-discovery-sunny",
    title: "索引晴天",
    artistId: "ktv-index-artist-zhou-jie-lun",
    artistName: "周杰伦",
    language: "mandarin",
    genre: ["流行"],
    matchReason: "default",
    queueState: "not_queued",
    playCount: 0,
    recommendationWeight: 1,
    versions: [
      {
        indexedAssetId: "ktv-asset-discovery-sunny",
        displayName: "周杰伦-晴天-国语-流行.mkv",
        sourceLabel: "KTV索引",
        extension: ".mkv",
        sizeBytes: 123456,
        audioTrackCount: 2,
        styleTags: ["流行"],
        category: "流行",
        queueState: "not_queued",
        canQueue: true,
        disabledLabel: null
      }
    ]
  };

  return {
    seed,
    recommended: [song],
    artists: [
      {
        artistId: "ktv-index-artist-zhou-jie-lun",
        artistName: "周杰伦",
        songCount: 1,
        songs: [song]
      }
    ],
    genres: [
      {
        genre: "流行",
        songCount: 1,
        songs: [song]
      }
    ]
  };
}

function discoverySong(input: {
  songId: string;
  title: string;
  artistId: string;
  artistName: string;
  genre: string[];
  playCount: number;
}): SongDiscoverySong {
  return {
    source: "formal",
    songId: input.songId,
    title: input.title,
    artistId: input.artistId,
    artistName: input.artistName,
    language: "mandarin",
    genre: input.genre,
    matchReason: "default",
    queueState: "not_queued",
    playCount: input.playCount,
    recommendationWeight: input.playCount + 1,
    versions: [
      {
        assetId: `asset-${input.songId}`,
        displayName: "高清版",
        sourceType: "local",
        sourceLabel: "本地",
        durationMs: 180000,
        qualityLabel: "HD",
        isRecommended: true,
        queueState: "queueable",
        canQueue: true,
        disabledLabel: null
      }
    ]
  };
}

function emptySongSearchResponse(query: string) {
  return {
    query,
    local: [],
    online: {
      status: "disabled",
      message: "本地未入库，补歌功能后续可用",
      requestSupplement: { visible: true, label: "请求补歌" },
      candidates: []
    }
  };
}

function readySupplementTask() {
  return {
    id: "task-1",
    roomId: "living-room",
    provider: "demo-provider",
    providerCandidateId: "remote-qilixiang",
    title: "七里香",
    artistName: "周杰伦",
    sourceLabel: "Demo Provider",
    durationMs: 180000,
    candidateType: "mv",
    reliabilityLabel: "high",
    riskLabel: "normal",
    status: "ready",
    failureReason: null,
    recentEvent: { type: "ready" },
    providerPayload: {},
    readyAssetId: "asset-ready-online",
    createdAt: "2026-05-04T10:00:00.000Z",
    updatedAt: "2026-05-04T10:00:01.000Z",
    selectedAt: "2026-05-04T10:00:00.500Z",
    reviewRequiredAt: null,
    fetchingAt: "2026-05-04T10:00:00.600Z",
    fetchedAt: "2026-05-04T10:00:00.700Z",
    readyAt: "2026-05-04T10:00:01.000Z",
    failedAt: null,
    staleAt: null,
    promotedAt: null,
    purgedAt: null
  };
}

function realMvControlSnapshot(): RoomControlSnapshot {
  const snapshot = roomSnapshot();
  return {
    ...snapshot,
    currentTarget: {
      ...snapshot.currentTarget!,
      assetId: "asset-real-mv",
      playbackUrl: "http://ktv.local/media/asset-real-mv",
      vocalMode: "instrumental",
      switchFamily: null,
      playbackProfile: {
        kind: "single_file_audio_tracks",
        container: "matroska",
        videoCodec: "mpeg2video",
        audioCodecs: ["aac", "aac"],
        requiresAudioTrackSelection: true
      },
      selectedTrackRef: {
        index: 1,
        id: "0x1101",
        label: "伴唱"
      }
    },
    switchTarget: null
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function roomSnapshot(options: {
  queueStatus?: "queued" | "removed";
  queueUndoExpiresAt?: string | null;
  sessionVersion?: number;
  volumePercent?: number;
} = {}): RoomControlSnapshot {
  const queueStatus = options.queueStatus ?? "queued";
  return {
    type: "room.control.snapshot",
    roomId: "living-room",
    roomSlug: "living-room",
    sessionVersion: options.sessionVersion ?? 1,
    state: "playing",
    volumePercent: options.volumePercent ?? DEFAULT_ROOM_VOLUME_PERCENT,
    pairing: {
      roomSlug: "living-room",
      controllerUrl: "http://ktv.local/controller?room=living-room",
      qrPayload: "http://ktv.local/controller?room=living-room",
      token: "token",
      tokenExpiresAt: "2026-05-04T10:10:00.000Z"
    },
    tvPresence: { online: true, deviceName: "TV", lastSeenAt: "2026-05-04T10:00:00.000Z", conflict: null },
    controllers: { onlineCount: 1 },
    currentTarget: {
      roomId: "living-room",
      sessionVersion: options.sessionVersion ?? 1,
      queueEntryId: "queue-current",
      assetId: "asset-current",
      currentQueueEntryPreview: { queueEntryId: "queue-current", songTitle: "七里香", artistName: "周杰伦" },
      playbackUrl: "http://ktv.local/media/asset-current",
      resumePositionMs: 1234,
      vocalMode: "instrumental",
      switchFamily: "family-main",
      nextQueueEntryPreview: { queueEntryId: "queue-next", songTitle: "下一首", artistName: "歌手" }
    },
    switchTarget: {
      roomId: "living-room",
      sessionVersion: options.sessionVersion ?? 1,
      queueEntryId: "queue-current",
      switchKind: "asset",
      fromAssetId: "asset-current",
      toAssetId: "asset-original",
      playbackUrl: "http://ktv.local/media/asset-original",
      switchFamily: "family-main",
      vocalMode: "original",
      resumePositionMs: 1234,
      rollbackAssetId: "asset-current"
    },
    queue: [
      {
        queueEntryId: "queue-next",
        songId: "song-next",
        assetId: "asset-next",
        songTitle: "下一首",
        artistName: "歌手",
        requestedBy: "phone-1",
        queuePosition: 2,
        status: queueStatus,
        canPromote: queueStatus === "queued",
        canDelete: queueStatus === "queued",
        undoExpiresAt: options.queueUndoExpiresAt ?? null
      }
    ],
    notice: null,
    generatedAt: "2026-05-04T10:00:00.000Z"
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {};
  Object.defineProperties(storage, {
    length: {
      get() {
        return values.size;
      }
    },
    clear: {
      value() {
        values.clear();
      }
    },
    getItem: {
      value(key: string) {
        return values.get(key) ?? null;
      }
    },
    key: {
      value(index: number) {
        return [...values.keys()][index] ?? null;
      }
    },
    removeItem: {
      value(key: string) {
        values.delete(key);
      }
    },
    setItem: {
      value(key: string, value: string) {
        values.set(key, value);
        Object.defineProperty(storage, key, {
          configurable: true,
          enumerable: true,
          value
        });
      }
    }
  });
  return storage as Storage;
}
