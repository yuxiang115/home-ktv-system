import type {
  ControllerSongHistoryEntry,
  SongDiscoveryResponse,
  SongSearchNasQueueState,
  SongSearchQueueState,
  SongSearchResponse
} from "@home-ktv/domain";
import { DEFAULT_ROOM_VOLUME_PERCENT, type RoomControlSnapshot, type RoomInteractionKind } from "@home-ktv/player-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addQueueEntry,
  ControllerApiError,
  type ControllerUser,
  createControlSession,
  deleteQueueEntry,
  fetchControllerSongHistory,
  fetchSongDiscovery,
  getCurrentControllerUser,
  loginControllerUser,
  logoutControllerUser,
  promoteQueueEntry,
  realtimeUrl,
  regenerateAssetLyrics,
  registerControllerUser,
  restoreControlSession,
  searchOnlineSupplement,
  searchSongs,
  sendRoomInteraction,
  requestOnlineSupplement,
  type OnlineSupplementCandidate,
  seek as seekCommand,
  setVolume,
  shuffleQueue,
  skipCurrent,
  switchVocalMode,
  updateControllerUserProfile,
  undoDeleteQueueEntry
} from "../api/client.js";
import { getOrCreateDeviceId } from "../api/client.js";

export const fallbackPollingIntervalMs = 5000;
export const sessionRefreshIntervalMs = 15 * 60 * 1000;
// 搜索结果按 query 缓存的 TTL:同一 query 在窗口内重复提交直接复用当前结果,
// 超时或补歌任务 ready(曲库变化)后缓存失效,重新请求
export const songSearchCacheTtlMs = 60_000;

// 「生成歌词」单资产行内结果:found 时按钮直接消失(hasLyrics 就地置 true),
// 只有这两个结局需要留在行内提示
export type LyricsRegenerationOutcome = "not_found" | "error";

interface ControllerCommandInput {
  roomSlug: string;
  deviceId: string;
  sessionVersion: number;
}

interface ControllerCommandResponse {
  status?: string;
  snapshot?: RoomControlSnapshot | null;
  undo?: { queueEntryId: string; undoExpiresAt: string };
}

export interface RoomControllerState {
  authStatus: "checking" | "authenticated" | "unauthenticated";
  authUser: ControllerUser | null;
  connectionStatus: "connecting" | "connected" | "reconnecting" | "error";
  deviceId: string;
  duplicateConfirm:
    | { kind: "canonical"; songId: string; assetId: string; title: string }
    | { kind: "nas"; assetId: string; title: string }
    | null;
  errorMessage: string | null;
  pendingNasAssetId: string | null;
  pendingInteractionKind: RoomInteractionKind | null;
  pendingUndo: { queueEntryId: string; undoExpiresAt: string } | null;
  /** 正在重查歌词的 assetId(按钮 pending 态,防连点) */
  lyricsRegenerationPending: readonly string[];
  /** 每个 assetId 最近一次生成歌词的失败结局(not_found/错误),行内提示用 */
  lyricsRegenerationResults: Readonly<Record<string, LyricsRegenerationOutcome>>;
  roomSlug: string;
  skipConfirmOpen: boolean;
  songDiscovery: SongDiscoveryResponse | null;
  songDiscoveryStatus: "idle" | "loading" | "success" | "error";
  songHistory: ControllerSongHistoryEntry[];
  songHistoryStatus: "idle" | "loading" | "success" | "error";
  songLibraryRefreshVersion: number;
  songSearch: SongSearchResponse | null;
  songSearchQuery: string;
  songSearchStatus: "idle" | "loading" | "success" | "error";
  onlineSupplementCandidates: OnlineSupplementCandidate[];
  onlineSupplementQuery: string;
  onlineSupplementStatus: "idle" | "loading" | "success" | "error";
  onlineSupplementNotice: string | null;
  snapshot: RoomControlSnapshot | null;
  volumePercent: number;
  addSongVersion(songId: string, assetId: string): Promise<void>;
  addNasAsset(assetId: string): Promise<void>;
  cancelDuplicateAdd(): void;
  confirmSkip(): Promise<void>;
  confirmDuplicateAdd(): Promise<void>;
  deleteQueueEntry(queueEntryId: string): Promise<void>;
  promoteQueueEntry(queueEntryId: string): Promise<void>;
  shuffleQueue(): Promise<void>;
  requestAddSongVersion(songId: string, assetId: string, title: string, queueState: SongSearchQueueState): boolean;
  requestAddNasAsset(assetId: string, title: string, queueState: SongSearchNasQueueState): boolean;
  regenerateLyrics(assetId: string): void;
  sendInteraction(kind: RoomInteractionKind, message: string): Promise<void>;
  requestSkip(): void;
  refreshSongDiscovery(): void;
  refreshSongHistory(): Promise<void>;
  setSongSearchQuery(query: string): void;
  runOnlineSupplementSearch(query: string): void;
  requestOnlineSupplementCandidate(candidate: OnlineSupplementCandidate): Promise<void>;
  clearOnlineSupplementSearch(): void;
  setVolumePercent(volumePercent: number): void;
  nudgeSeek(deltaMs: number): void;
  submitSongSearch(): void;
  switchVocalMode(): Promise<void>;
  undoDelete(queueEntryId: string): Promise<void>;
  cancelSkip(): void;
  login(input: { phone: string; password: string }): Promise<void>;
  register(input: { phone: string; password: string; displayName: string }): Promise<void>;
  logout(): Promise<void>;
  updateDisplayName(displayName: string): Promise<void>;
}

export function useRoomControllerRuntime(): RoomControllerState {
  const initial = useMemo(() => readRuntimeParams(), []);
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [authStatus, setAuthStatus] = useState<RoomControllerState["authStatus"]>("checking");
  const [authUser, setAuthUser] = useState<ControllerUser | null>(null);
  const [snapshot, setSnapshot] = useState<RoomControlSnapshot | null>(null);
  const [songSearch, setSongSearch] = useState<SongSearchResponse | null>(null);
  const [songSearchQuery, setSongSearchQueryState] = useState("");
  const [songSearchStatus, setSongSearchStatus] = useState<RoomControllerState["songSearchStatus"]>("idle");
  const [duplicateConfirm, setDuplicateConfirm] = useState<RoomControllerState["duplicateConfirm"]>(null);
  const [connectionStatus, setConnectionStatus] = useState<RoomControllerState["connectionStatus"]>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  const [songDiscovery, setSongDiscovery] = useState<SongDiscoveryResponse | null>(null);
  const [songDiscoveryStatus, setSongDiscoveryStatus] = useState<RoomControllerState["songDiscoveryStatus"]>("idle");
  const [songHistory, setSongHistory] = useState<ControllerSongHistoryEntry[]>([]);
  const [songHistoryStatus, setSongHistoryStatus] = useState<RoomControllerState["songHistoryStatus"]>("idle");
  const [onlineSupplementCandidates, setOnlineSupplementCandidates] = useState<OnlineSupplementCandidate[]>([]);
  const [onlineSupplementQuery, setOnlineSupplementQuery] = useState("");
  const [onlineSupplementStatus, setOnlineSupplementStatus] = useState<RoomControllerState["onlineSupplementStatus"]>("idle");
  const [onlineSupplementNotice, setOnlineSupplementNotice] = useState<string | null>(null);
  const [pendingNasAssetId, setPendingNasAssetId] = useState<string | null>(null);
  const [pendingInteractionKind, setPendingInteractionKind] = useState<RoomInteractionKind | null>(null);
  const [pendingUndo, setPendingUndo] = useState<{ queueEntryId: string; undoExpiresAt: string } | null>(null);
  const [pendingVolumePercent, setPendingVolumePercent] = useState<number | null>(null);
  const [lyricsRegenerationPending, setLyricsRegenerationPending] = useState<string[]>([]);
  const [lyricsRegenerationResults, setLyricsRegenerationResults] = useState<Record<string, LyricsRegenerationOutcome>>({});
  const [songLibraryRefreshVersion, setSongLibraryRefreshVersion] = useState(0);
  const snapshotRef = useRef<RoomControlSnapshot | null>(null);
  const songSearchQueryRef = useRef("");
  const searchRequestIdRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const songSearchCacheRef = useRef<{ query: string; fetchedAtMs: number } | null>(null);
  const readySupplementTaskIdsRef = useRef<readonly string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadUser = async () => {
      try {
        const response = await getCurrentControllerUser();
        if (!cancelled) {
          setAuthUser(response.user);
          setAuthStatus("authenticated");
        }
      } catch (error) {
        if (!cancelled) {
          if (isApiCode(error, "AUTH_REQUIRED")) {
            setAuthUser(null);
            setAuthStatus("unauthenticated");
            setConnectionStatus("connecting");
            return;
          }
          setAuthUser(null);
          setAuthStatus("unauthenticated");
          setErrorMessage(errorMessageFrom(error, "登录状态检查失败"));
        }
      }
    };

    void loadUser();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const clearSearchDebounce = useCallback(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
  }, []);

  const clearVolumeDebounce = useCallback(() => {
    if (volumeDebounceRef.current) {
      clearTimeout(volumeDebounceRef.current);
      volumeDebounceRef.current = null;
    }
  }, []);

  const runSongSearch = useCallback(
    async (query: string) => {
      clearSearchDebounce();
      searchAbortRef.current?.abort();
      const requestId = searchRequestIdRef.current + 1;
      searchRequestIdRef.current = requestId;
      songSearchQueryRef.current = query;
      const abortController = new AbortController();
      searchAbortRef.current = abortController;
      setSongSearchStatus("loading");

      try {
        const response = await searchSongs({
          roomSlug: initial.roomSlug,
          query,
          limit: 30,
          signal: abortController.signal
        });
        if (searchRequestIdRef.current === requestId && response.query === songSearchQueryRef.current) {
          setSongSearch(response);
          setSongSearchStatus("success");
          songSearchCacheRef.current = { query, fetchedAtMs: Date.now() };
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        if (searchRequestIdRef.current === requestId) {
          setSongSearchStatus("error");
          setErrorMessage(errorMessageFrom(error, "SONG_SEARCH_FAILED"));
        }
      }
    },
    [clearSearchDebounce, initial.roomSlug]
  );

  const runSongDiscovery = useCallback(
    async (seed: string) => {
      discoveryAbortRef.current?.abort();
      const abortController = new AbortController();
      discoveryAbortRef.current = abortController;
      setSongDiscoveryStatus("loading");

      try {
        const response = await fetchSongDiscovery({
          roomSlug: initial.roomSlug,
          seed,
          signal: abortController.signal
        });
        if (!abortController.signal.aborted) {
          setSongDiscovery(response);
          setSongDiscoveryStatus("success");
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        setSongDiscoveryStatus("error");
        setErrorMessage(errorMessageFrom(error, "DISCOVERY_LOAD_FAILED"));
      }
    },
    [initial.roomSlug]
  );

  const runSongHistory = useCallback(async () => {
    setSongHistoryStatus("loading");
    try {
      const response = await fetchControllerSongHistory();
      setSongHistory(response.songs);
      setSongHistoryStatus("success");
    } catch (error) {
      if (isApiCode(error, "AUTH_REQUIRED")) {
        setSongHistory([]);
        setSongHistoryStatus("idle");
        return;
      }
      setSongHistoryStatus("error");
      setErrorMessage(errorMessageFrom(error, "点歌历史加载失败"));
    }
  }, []);

  const runOnlineSupplementSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      setOnlineSupplementQuery(trimmed);
      if (!trimmed) {
        setOnlineSupplementCandidates([]);
        setOnlineSupplementStatus("idle");
        return;
      }
      setOnlineSupplementStatus("loading");
      try {
        const response = await searchOnlineSupplement({
          roomSlug: initial.roomSlug,
          deviceId,
          query: trimmed
        });
        setOnlineSupplementCandidates(response.candidates);
        setOnlineSupplementStatus("success");
      } catch (error) {
        if (isApiCode(error, "ONLINE_SUPPLEMENT_DISABLED")) {
          setOnlineSupplementCandidates([]);
          setOnlineSupplementStatus("idle");
          return;
        }
        setOnlineSupplementStatus("error");
        setErrorMessage(errorMessageFrom(error, "在线搜索失败"));
      }
    },
    [initial.roomSlug, deviceId]
  );

  const requestOnlineSupplementCandidate = useCallback(
    async (candidate: OnlineSupplementCandidate) => {
      try {
        const response = await requestOnlineSupplement({
          roomSlug: initial.roomSlug,
          deviceId,
          candidate
        });
        setErrorMessage(null);
        setOnlineSupplementCandidates([]);
        setOnlineSupplementStatus("idle");
        setOnlineSupplementQuery("");
        setOnlineSupplementNotice(
          response.taskStatus === "failed"
            ? `已重新提交「${candidate.title}」,开始处理`
            : `已提交「${candidate.title}」,处理中…完成后自动进入曲库`
        );
      } catch (error) {
        setErrorMessage(errorMessageFrom(error, "请求补歌失败"));
      }
    },
    [initial.roomSlug, deviceId]
  );

  const clearOnlineSupplementSearch = useCallback(() => {
    setOnlineSupplementCandidates([]);
    setOnlineSupplementStatus("idle");
    setOnlineSupplementQuery("");
    setOnlineSupplementNotice(null);
  }, []);

  useEffect(() => {
    if (!onlineSupplementNotice) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => {
      setOnlineSupplementNotice(null);
    }, 10_000);
    return () => globalThis.clearTimeout(timeoutId);
  }, [onlineSupplementNotice]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      setSongHistory([]);
      setSongHistoryStatus("idle");
      return;
    }
    void runSongHistory();
  }, [authStatus, runSongHistory]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }
    let cancelled = false;
    let websocket: WebSocket | null = null;
    let realtimeConnecting = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const stopFallbackPolling = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const stopSessionRefresh = () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    };

    const applySessionResponse = async (response: Awaited<ReturnType<typeof restoreControlSession>>) => {
      if (cancelled) {
        return;
      }
      setSnapshot(response.snapshot);
      setErrorMessage(null);
      removeTokenFromUrl();
      setSongSearchQueryState("");
      songSearchQueryRef.current = "";
      await Promise.all([runSongSearch(""), runSongDiscovery(createDiscoverySeed())]);
    };

    const pollRestore = async () => {
      try {
        const restored = await restoreControlSession({ roomSlug: initial.roomSlug, deviceId });
        if (!cancelled) {
          setSnapshot(restored.snapshot);
          setErrorMessage(null);
          openRealtime();
        }
      } catch {
        if (!cancelled) {
          setConnectionStatus("reconnecting");
        }
      }
    };

    const startFallbackPolling = () => {
      if (cancelled) {
        return;
      }
      stopSessionRefresh();
      setConnectionStatus("reconnecting");
      if (!fallbackTimer) {
        fallbackTimer = setInterval(() => {
          void pollRestore();
        }, fallbackPollingIntervalMs);
      }
    };

    const openRealtime = () => {
      if (cancelled) {
        return;
      }

      if (realtimeConnecting) {
        return;
      }

      let nextWebSocket: WebSocket;
      try {
        nextWebSocket = new WebSocket(realtimeUrl({ roomSlug: initial.roomSlug, deviceId }));
      } catch {
        startFallbackPolling();
        return;
      }
      realtimeConnecting = true;
      websocket = nextWebSocket;
      nextWebSocket.onopen = () => {
        if (cancelled) {
          return;
        }
        realtimeConnecting = false;
        stopFallbackPolling();
        stopSessionRefresh();
        setConnectionStatus("connected");
        refreshTimer = setInterval(() => {
          void restoreControlSession({ roomSlug: initial.roomSlug, deviceId }).then((response) => {
            if (!cancelled) {
              setSnapshot(response.snapshot);
            }
          });
        }, sessionRefreshIntervalMs);
      };
      nextWebSocket.onmessage = (event) => {
        if (websocket !== nextWebSocket) {
          return;
        }
        const message = parseRealtimeMessage(event.data);
        if (message?.type === "room.control.snapshot.updated" && message.payload) {
          setSnapshot(message.payload);
          setErrorMessage(null);
        }
      };
      const handleRealtimeDisconnect = () => {
        if (websocket === nextWebSocket) {
          websocket = null;
        }
        realtimeConnecting = false;
        startFallbackPolling();
      };
      nextWebSocket.onclose = handleRealtimeDisconnect;
      nextWebSocket.onerror = handleRealtimeDisconnect;
    };

    const start = async () => {
      try {
        const restored = await restoreControlSession({ roomSlug: initial.roomSlug, deviceId });
        await applySessionResponse(restored);
        openRealtime();
      } catch (restoreError) {
        if (!initial.pairingToken) {
          setConnectionStatus("error");
          setErrorMessage(errorMessageFrom(restoreError, "CONTROL_SESSION_REQUIRED"));
          return;
        }

        try {
          const created = await createControlSession({
            roomSlug: initial.roomSlug,
            pairingToken: initial.pairingToken,
            deviceId
          });
          await applySessionResponse(created);
          openRealtime();
        } catch (createError) {
          if (isApiCode(createError, "INVALID_PAIRING_TOKEN")) {
            try {
              const restored = await restoreControlSession({ roomSlug: initial.roomSlug, deviceId });
              await applySessionResponse(restored);
              openRealtime();
              return;
            } catch {}
          }

          setConnectionStatus("error");
          setErrorMessage(errorMessageFrom(createError, "INVALID_PAIRING_TOKEN"));
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopFallbackPolling();
      stopSessionRefresh();
      websocket?.close();
      clearSearchDebounce();
      clearVolumeDebounce();
      searchAbortRef.current?.abort();
      discoveryAbortRef.current?.abort();
    };
  }, [authStatus, clearSearchDebounce, clearVolumeDebounce, deviceId, initial.pairingToken, initial.roomSlug, runSongDiscovery, runSongSearch]);

  useEffect(() => {
    if (pendingVolumePercent != null && snapshot?.volumePercent === pendingVolumePercent) {
      setPendingVolumePercent(null);
    }
  }, [pendingVolumePercent, snapshot?.volumePercent]);

  // 在线补歌任务 ready(processing→ready,歌曲已落库)时,本地曲库数据需要失效重拉:
  // 首页 discovery、当前搜索结果、浏览明细都不随快照自动更新,不处理就会出现
  // "新歌搜不到/列表不显示,必须手动刷新页面"。对比上一次快照的 ready 任务集合,
  // 只有出现新的 ready 任务才触发,避免每条快照都重复请求。
  useEffect(() => {
    const readyTaskIds = (snapshot?.onlineTasks?.tasks ?? [])
      .filter((task) => task.status === "ready")
      .map((task) => task.taskId);
    const previousReadyTaskIds = readySupplementTaskIdsRef.current;
    readySupplementTaskIdsRef.current = readyTaskIds;
    if (previousReadyTaskIds === null || !readyTaskIds.some((taskId) => !previousReadyTaskIds.includes(taskId))) {
      return;
    }

    songSearchCacheRef.current = null;
    setSongLibraryRefreshVersion((version) => version + 1);
    void runSongDiscovery(createDiscoverySeed());
    if (songSearchQueryRef.current) {
      void runSongSearch(songSearchQueryRef.current);
    }
  }, [runSongDiscovery, runSongSearch, snapshot?.onlineTasks]);

  const runCommand = useCallback(
    async <TResponse extends ControllerCommandResponse>(
      command: (input: ControllerCommandInput) => Promise<TResponse>,
      options: { retryOnConflict?: boolean } = {}
    ) => {
      const current = snapshotRef.current;
      if (!current) {
        return null;
      }

      const applyResponse = (response: TResponse) => {
        if (response?.snapshot) {
          setSnapshot(response.snapshot);
        }
        if (response?.undo) {
          setPendingUndo(response.undo);
        }
      };

      try {
        const response = await command({
          roomSlug: initial.roomSlug,
          deviceId,
          sessionVersion: current.sessionVersion
        });
        applyResponse(response);
        return response;
      } catch (error) {
        if (isApiCode(error, "SESSION_VERSION_CONFLICT") && error instanceof ControllerApiError) {
          const payload = error.payload as { snapshot?: RoomControlSnapshot };
          if (payload.snapshot) {
            setSnapshot(payload.snapshot);
          }
          if (!options.retryOnConflict || !payload.snapshot) {
            return null;
          }

          try {
            const response = await command({
              roomSlug: initial.roomSlug,
              deviceId,
              sessionVersion: payload.snapshot.sessionVersion
            });
            applyResponse(response);
            return response;
          } catch (retryError) {
            if (isApiCode(retryError, "SESSION_VERSION_CONFLICT") && retryError instanceof ControllerApiError) {
              const retryPayload = retryError.payload as { snapshot?: RoomControlSnapshot };
              if (retryPayload.snapshot) {
                setSnapshot(retryPayload.snapshot);
              }
              return null;
            }

            throw retryError;
          }
        }

        throw error;
      }
    },
    [deviceId, initial.roomSlug]
  );

  const addSongVersion = useCallback(
    async (songId: string, assetId: string) => {
      await runCommand((input) => addQueueEntry({ ...input, sourceType: "nas", assetId }), { retryOnConflict: true });
      await runSongHistory();
    },
    [runCommand, runSongHistory]
  );

  const addNasAsset = useCallback(
    async (assetId: string) => {
      setPendingNasAssetId(assetId);
      try {
        await runCommand((input) => addQueueEntry({ ...input, sourceType: "nas", assetId }), { retryOnConflict: true });
        const restored = await restoreControlSession({ roomSlug: initial.roomSlug, deviceId });
        setSnapshot(restored.snapshot);
        await runSongSearch(songSearchQueryRef.current);
        await runSongHistory();
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(errorMessageFrom(error, "点歌失败"));
      } finally {
        setPendingNasAssetId((current) => (current === assetId ? null : current));
      }
    },
    [deviceId, initial.roomSlug, runCommand, runSongHistory, runSongSearch]
  );

  // 「生成歌词」:只重查该资产的 LRCLIB 歌词并落库,不重跑下载/伴奏/对齐。
  // found 时把当前搜索结果里该版本的 hasLyrics 就地置 true(不重跑整个搜索);
  // not_found/网络错误留在行内提示,重试前先清掉旧提示。
  const regenerateLyrics = useCallback(
    (assetId: string) => {
      if (lyricsRegenerationPending.includes(assetId)) {
        return;
      }

      setLyricsRegenerationPending((current) => [...current, assetId]);
      setLyricsRegenerationResults((current) => {
        if (!(assetId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[assetId];
        return next;
      });

      void regenerateAssetLyrics({ assetId })
        .then((response) => {
          if (response.status === "found") {
            setSongSearch((current) =>
              current
                ? {
                    ...current,
                    nas: {
                      ...current.nas,
                      results: current.nas.results.map((result) => ({
                        ...result,
                        versions: result.versions.map((version) =>
                          version.assetId === assetId ? { ...version, hasLyrics: true } : version
                        )
                      }))
                    }
                  }
                : current
            );
            // 「我的点歌」历史行同样就地置 true,免得刷新前还挂着「生成歌词」按钮。
            setSongHistory((current) =>
              current.map((entry) => (entry.assetId === assetId ? { ...entry, hasLyrics: true } : entry))
            );
            return;
          }
          setLyricsRegenerationResults((current) => ({ ...current, [assetId]: "not_found" }));
        })
        .catch(() => {
          setLyricsRegenerationResults((current) => ({ ...current, [assetId]: "error" }));
        })
        .finally(() => {
          setLyricsRegenerationPending((current) => current.filter((id) => id !== assetId));
        });
    },
    [lyricsRegenerationPending]
  );

  const sendInteraction = useCallback(
    async (kind: RoomInteractionKind, message: string) => {
      const normalizedMessage = message.trim();
      if (!normalizedMessage) {
        return;
      }

      setPendingInteractionKind(kind);
      try {
        await sendRoomInteraction({
          roomSlug: initial.roomSlug,
          deviceId,
          kind,
          message: normalizedMessage
        });
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(errorMessageFrom(error, "互动发送失败"));
      } finally {
        setPendingInteractionKind((current) => (current === kind ? null : current));
      }
    },
    [deviceId, initial.roomSlug]
  );

  const submitSongSearch = useCallback(() => {
    const cached = songSearchCacheRef.current;
    if (cached && cached.query === songSearchQueryRef.current && Date.now() - cached.fetchedAtMs < songSearchCacheTtlMs) {
      return;
    }
    void runSongSearch(songSearchQueryRef.current);
  }, [runSongSearch]);

  const commitVolumePercent = useCallback(
    async (volumePercent: number) => {
      try {
        const response = await runCommand((input) => setVolume({ ...input, volumePercent }));
        if (!response?.snapshot || response.snapshot.volumePercent !== volumePercent) {
          setPendingVolumePercent(null);
        }
        setErrorMessage(null);
      } catch (error) {
        setPendingVolumePercent(null);
        setErrorMessage(errorMessageFrom(error, "音量调整失败"));
      }
    },
    [runCommand]
  );

  // 手机端快进/快退:每次点按立即发命令(服务端以心跳位置为基准算目标,
  // commandId 幂等),连点即连发,无需电视端那种停顿合并
  const nudgeSeek = useCallback(
    (deltaMs: number) => {
      if (!Number.isFinite(deltaMs) || deltaMs === 0) {
        return;
      }
      void runCommand((input) => seekCommand({ ...input, deltaMs }))
        .then(() => setErrorMessage(null))
        .catch((error: unknown) => setErrorMessage(errorMessageFrom(error, "快进/快退失败")));
    },
    [runCommand]
  );

  return {
    authStatus,
    authUser,
    connectionStatus,
    deviceId,
    duplicateConfirm,
    errorMessage,
    pendingNasAssetId,
    pendingInteractionKind,
    pendingUndo,
    lyricsRegenerationPending,
    lyricsRegenerationResults,
    roomSlug: initial.roomSlug,
    skipConfirmOpen,
    songDiscovery,
    songDiscoveryStatus,
    songHistory,
    songHistoryStatus,
    songLibraryRefreshVersion,
    songSearch,
    songSearchQuery,
    songSearchStatus,
    snapshot,
    volumePercent: pendingVolumePercent ?? snapshot?.volumePercent ?? DEFAULT_ROOM_VOLUME_PERCENT,
    addSongVersion,
    addNasAsset,
    cancelDuplicateAdd: () => setDuplicateConfirm(null),
    cancelSkip: () => setSkipConfirmOpen(false),
    login: async (input) => {
      try {
        const response = await loginControllerUser(input);
        setAuthUser(response.user);
        setAuthStatus("authenticated");
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(authErrorMessageFrom(error, "登录失败"));
        throw error;
      }
    },
    register: async (input) => {
      try {
        const response = await registerControllerUser(input);
        setAuthUser(response.user);
        setAuthStatus("authenticated");
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(authErrorMessageFrom(error, "注册失败"));
        throw error;
      }
    },
    logout: async () => {
      try {
        await logoutControllerUser();
      } finally {
        setAuthUser(null);
        setAuthStatus("unauthenticated");
        setSnapshot(null);
        setSongSearch(null);
        setSongDiscovery(null);
        setSongHistory([]);
        setSongHistoryStatus("idle");
        setSongSearchQueryState("");
        songSearchQueryRef.current = "";
        songSearchCacheRef.current = null;
        setErrorMessage(null);
      }
    },
    updateDisplayName: async (displayName) => {
      try {
        const response = await updateControllerUserProfile({ displayName });
        setAuthUser(response.user);
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(authErrorMessageFrom(error, "昵称修改失败"));
        throw error;
      }
    },
    confirmDuplicateAdd: async () => {
      const selection = duplicateConfirm;
      if (!selection) {
        return;
      }
      if (selection.kind === "nas") {
        await addNasAsset(selection.assetId);
      } else {
        await addSongVersion(selection.songId, selection.assetId);
      }
      setDuplicateConfirm(null);
    },
    confirmSkip: async () => {
      setSkipConfirmOpen(false);
      await runCommand((input) => skipCurrent({ ...input, confirmSkip: true }));
    },
    deleteQueueEntry: async (queueEntryId) => {
      await runCommand((input) => deleteQueueEntry({ ...input, queueEntryId }));
    },
    promoteQueueEntry: async (queueEntryId) => {
      await runCommand((input) => promoteQueueEntry({ ...input, queueEntryId }));
    },
    shuffleQueue: async () => {
      await runCommand((input) => shuffleQueue(input));
    },
    requestAddSongVersion: (songId, assetId, title, queueState) => {
      if (queueState === "queued") {
        setDuplicateConfirm({ kind: "canonical", songId, assetId, title });
        return false;
      }

      void addSongVersion(songId, assetId);
      return true;
    },
    requestAddNasAsset: (assetId, title, queueState) => {
      if (queueState === "queued") {
        setDuplicateConfirm({ kind: "nas", assetId, title });
        return false;
      }

      void addNasAsset(assetId);
      return true;
    },
    regenerateLyrics,
    sendInteraction,
    requestSkip: () => setSkipConfirmOpen(true),
    refreshSongDiscovery: () => {
      void runSongDiscovery(createDiscoverySeed());
    },
    refreshSongHistory: runSongHistory,
    setSongSearchQuery: (query) => {
      songSearchQueryRef.current = query;
      setSongSearchQueryState(query);
      clearSearchDebounce();
      searchDebounceRef.current = setTimeout(() => {
        void runSongSearch(query);
      }, 250);
    },
    nudgeSeek,
    setVolumePercent: (volumePercent) => {
      const normalized = normalizeVolumePercent(volumePercent);
      setPendingVolumePercent(normalized);
      clearVolumeDebounce();
      volumeDebounceRef.current = setTimeout(() => {
        void commitVolumePercent(normalized);
      }, 180);
    },
    submitSongSearch,
    runOnlineSupplementSearch,
    requestOnlineSupplementCandidate,
    clearOnlineSupplementSearch,
    onlineSupplementCandidates,
    onlineSupplementQuery,
    onlineSupplementStatus,
    onlineSupplementNotice,
    switchVocalMode: async () => {
      try {
        await runCommand((input) =>
          switchVocalMode({ ...input, playbackPositionMs: snapshotRef.current?.currentTarget?.resumePositionMs ?? 0 })
        );
        setErrorMessage(null);
      } catch (error) {
        if (isApiCode(error, "SWITCH_TARGET_NOT_AVAILABLE")) {
          setErrorMessage("当前歌曲暂不支持切换原唱/伴唱");
          return;
        }

        setErrorMessage(errorMessageFrom(error, "切换原唱/伴唱失败"));
      }
    },
    undoDelete: async (queueEntryId) => {
      setPendingUndo(null);
      await runCommand((input) => undoDeleteQueueEntry({ ...input, queueEntryId }));
    }
  };
}

function normalizeVolumePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ROOM_VOLUME_PERCENT;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function readRuntimeParams(): { roomSlug: string; pairingToken: string | null } {
  const search = new URLSearchParams(window.location.search);
  return {
    roomSlug: "living-room",
    pairingToken: search.get("token")
  };
}

function createDiscoverySeed(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function removeTokenFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) {
    return;
  }

  url.searchParams.delete("token");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function parseRealtimeMessage(data: unknown): { type?: string; payload?: RoomControlSnapshot } | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    return JSON.parse(data) as { type?: string; payload?: RoomControlSnapshot };
  } catch {
    return null;
  }
}

function isApiCode(error: unknown, code: string): boolean {
  return error instanceof ControllerApiError && error.code === code;
}

function errorMessageFrom(error: unknown, fallback: string): string {
  if (error instanceof ControllerApiError) {
    if (error.code === "CONTROL_SESSION_REQUIRED") {
      return "请从电视端二维码重新进入控制端";
    }
    if (error.code === "INVALID_PAIRING_TOKEN") {
      return "配对码已失效，请重新扫描电视端二维码";
    }
  }

  return error instanceof Error ? error.message : fallback;
}

function authErrorMessageFrom(error: unknown, fallback: string): string {
  if (error instanceof ControllerApiError) {
    if (error.code === "INVALID_CREDENTIALS") {
      return "手机号或密码不正确";
    }
    if (error.code === "USER_ALREADY_EXISTS") {
      return "这个手机号已经注册";
    }
    if (error.code === "INVALID_PASSWORD") {
      return "密码至少 5 位";
    }
    if (error.code === "INVALID_PHONE") {
      return "请输入正确的手机号";
    }
    if (error.code === "INVALID_DISPLAY_NAME") {
      return "昵称不能为空";
    }
  }
  return error instanceof Error ? error.message : fallback;
}
