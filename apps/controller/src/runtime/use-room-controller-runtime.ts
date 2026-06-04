import type {
  OnlineCandidateTask,
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
  createControlSession,
  deleteQueueEntry,
  fetchSongDiscovery,
  promoteQueueEntry,
  realtimeUrl,
  restoreControlSession,
  requestSupplement,
  searchSongs,
  sendRoomInteraction,
  setVolume,
  skipCurrent,
  switchVocalMode,
  undoDeleteQueueEntry
} from "../api/client.js";
import { getOrCreateDeviceId } from "../api/client.js";

export const fallbackPollingIntervalMs = 5000;
export const sessionRefreshIntervalMs = 15 * 60 * 1000;

interface ControllerCommandInput {
  roomSlug: string;
  deviceId: string;
  sessionVersion: number;
}

interface ControllerCommandResponse {
  status?: string;
  snapshot?: RoomControlSnapshot | null;
  task?: OnlineCandidateTask;
  undo?: { queueEntryId: string; undoExpiresAt: string };
}

export interface RoomControllerState {
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
  pendingSupplementKeys: readonly string[];
  roomSlug: string;
  skipConfirmOpen: boolean;
  songDiscovery: SongDiscoveryResponse | null;
  songDiscoveryStatus: "idle" | "loading" | "success" | "error";
  songSearch: SongSearchResponse | null;
  songSearchQuery: string;
  songSearchStatus: "idle" | "loading" | "success" | "error";
  snapshot: RoomControlSnapshot | null;
  volumePercent: number;
  addSongVersion(songId: string, assetId: string): Promise<void>;
  addNasAsset(assetId: string): Promise<void>;
  cancelDuplicateAdd(): void;
  confirmSkip(): Promise<void>;
  confirmDuplicateAdd(): Promise<void>;
  deleteQueueEntry(queueEntryId: string): Promise<void>;
  promoteQueueEntry(queueEntryId: string): Promise<void>;
  requestAddSongVersion(songId: string, assetId: string, title: string, queueState: SongSearchQueueState): boolean;
  requestAddNasAsset(assetId: string, title: string, queueState: SongSearchNasQueueState): boolean;
  sendInteraction(kind: RoomInteractionKind, message: string): Promise<void>;
  requestSupplement(provider: string, providerCandidateId: string): Promise<void>;
  requestSkip(): void;
  refreshSongDiscovery(): void;
  setSongSearchQuery(query: string): void;
  setVolumePercent(volumePercent: number): void;
  submitSongSearch(): void;
  switchVocalMode(): Promise<void>;
  undoDelete(queueEntryId: string): Promise<void>;
  cancelSkip(): void;
}

export function useRoomControllerRuntime(): RoomControllerState {
  const initial = useMemo(() => readRuntimeParams(), []);
  const [deviceId] = useState(() => getOrCreateDeviceId());
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
  const [pendingNasAssetId, setPendingNasAssetId] = useState<string | null>(null);
  const [pendingInteractionKind, setPendingInteractionKind] = useState<RoomInteractionKind | null>(null);
  const [pendingUndo, setPendingUndo] = useState<{ queueEntryId: string; undoExpiresAt: string } | null>(null);
  const [pendingSupplementKeys, setPendingSupplementKeys] = useState<readonly string[]>([]);
  const [pendingVolumePercent, setPendingVolumePercent] = useState<number | null>(null);
  const snapshotRef = useRef<RoomControlSnapshot | null>(null);
  const songSearchQueryRef = useRef("");
  const searchRequestIdRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
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
  }, [clearSearchDebounce, clearVolumeDebounce, deviceId, initial.pairingToken, initial.roomSlug, runSongDiscovery, runSongSearch]);

  useEffect(() => {
    if (pendingVolumePercent != null && snapshot?.volumePercent === pendingVolumePercent) {
      setPendingVolumePercent(null);
    }
  }, [pendingVolumePercent, snapshot?.volumePercent]);

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
    },
    [runCommand]
  );

  const addNasAsset = useCallback(
    async (assetId: string) => {
      setPendingNasAssetId(assetId);
      try {
        await runCommand((input) => addQueueEntry({ ...input, sourceType: "nas", assetId }), { retryOnConflict: true });
        const restored = await restoreControlSession({ roomSlug: initial.roomSlug, deviceId });
        setSnapshot(restored.snapshot);
        await runSongSearch(songSearchQueryRef.current);
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage(errorMessageFrom(error, "点歌失败"));
      } finally {
        setPendingNasAssetId((current) => (current === assetId ? null : current));
      }
    },
    [deviceId, initial.roomSlug, runCommand, runSongSearch]
  );

  const requestOnlineSupplement = useCallback(
    async (provider: string, providerCandidateId: string) => {
      const key = supplementKey(provider, providerCandidateId);
      setPendingSupplementKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
      try {
        const response = await runCommand((input) =>
          requestSupplement({
            ...input,
            provider,
            providerCandidateId
          })
        );
        if (response?.task) {
          setSongSearch((current) => applySupplementTask(current, response.task));
        }
      } catch (error) {
        setErrorMessage(errorMessageFrom(error, "请求补歌失败"));
      } finally {
        setPendingSupplementKeys((keys) => keys.filter((item) => item !== key));
      }
    },
    [runCommand]
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

  return {
    connectionStatus,
    deviceId,
    duplicateConfirm,
    errorMessage,
    pendingNasAssetId,
    pendingInteractionKind,
    pendingUndo,
    pendingSupplementKeys,
    roomSlug: initial.roomSlug,
    skipConfirmOpen,
    songDiscovery,
    songDiscoveryStatus,
    songSearch,
    songSearchQuery,
    songSearchStatus,
    snapshot,
    volumePercent: pendingVolumePercent ?? snapshot?.volumePercent ?? DEFAULT_ROOM_VOLUME_PERCENT,
    addSongVersion,
    addNasAsset,
    cancelDuplicateAdd: () => setDuplicateConfirm(null),
    cancelSkip: () => setSkipConfirmOpen(false),
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
    sendInteraction,
    requestSupplement: requestOnlineSupplement,
    requestSkip: () => setSkipConfirmOpen(true),
    refreshSongDiscovery: () => {
      void runSongDiscovery(createDiscoverySeed());
    },
    setSongSearchQuery: (query) => {
      songSearchQueryRef.current = query;
      setSongSearchQueryState(query);
      clearSearchDebounce();
      searchDebounceRef.current = setTimeout(() => {
        void runSongSearch(query);
      }, 250);
    },
    setVolumePercent: (volumePercent) => {
      const normalized = normalizeVolumePercent(volumePercent);
      setPendingVolumePercent(normalized);
      clearVolumeDebounce();
      volumeDebounceRef.current = setTimeout(() => {
        void commitVolumePercent(normalized);
      }, 180);
    },
    submitSongSearch,
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
    roomSlug: search.get("room") || "living-room",
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

export function supplementKey(provider: string, providerCandidateId: string): string {
  return `${provider}:${providerCandidateId}`;
}

function applySupplementTask(
  current: SongSearchResponse | null,
  task: Awaited<ReturnType<typeof requestSupplement>>["task"]
): SongSearchResponse | null {
  if (!current) {
    return current;
  }

  return {
    ...current,
    online: {
      ...current.online,
      candidates: current.online.candidates.map((candidate) =>
        candidate.provider === task.provider && candidate.providerCandidateId === task.providerCandidateId
          ? {
              ...candidate,
              taskId: task.id,
              taskState: task.status
            }
          : candidate
      )
    }
  };
}
