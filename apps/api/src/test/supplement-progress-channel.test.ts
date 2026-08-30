import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUPPLEMENT_PROGRESS_CHANNEL,
  computeReconnectDelayMs,
  startSupplementProgressListener,
  type SupplementProgressClient,
  type SupplementProgressClientFactory
} from "../modules/online-supplement/supplement-progress-channel.js";

class FakeClient extends EventEmitter implements SupplementProgressClient {
  readonly queries: string[] = [];
  connectAttempts = 0;
  ended = false;
  connectError: Error | null = null;

  async connect(): Promise<unknown> {
    this.connectAttempts += 1;
    if (this.connectError) {
      throw this.connectError;
    }
    return undefined;
  }

  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    return undefined;
  }

  async end(): Promise<void> {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.emit("end");
  }

  simulateDisconnect(): void {
    this.emit("error", new Error("connection reset"));
    this.emit("end");
  }
}

interface HarnessOptions {
  failConnectForFirst?: number;
  onResync?: () => Promise<void>;
}

interface Harness {
  clients: FakeClient[];
  onProgress: ReturnType<typeof vi.fn>;
  onResync: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  handlePromise: Promise<{ stop(): Promise<void> }>;
}

function clientAt(clients: FakeClient[], index: number): FakeClient {
  const found = clients[index];
  if (!found) {
    throw new Error(`expected fake client #${index} to exist`);
  }
  return found;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clients: FakeClient[] = [];
  const onProgress = vi.fn(async (_roomId: string): Promise<void> => undefined);
  const onResync = vi.fn(
    options.onResync ??
      (async (): Promise<void> => {
        return undefined;
      })
  );
  const onError = vi.fn();
  const createClient: SupplementProgressClientFactory = () => {
    const fake = new FakeClient();
    if (clients.length < (options.failConnectForFirst ?? 0)) {
      fake.connectError = new Error("connect refused");
    }
    clients.push(fake);
    return fake;
  };
  const handlePromise = startSupplementProgressListener({
    databaseUrl: "postgres://listener-test",
    onProgress,
    onResync,
    onError,
    createClient
  });
  return { clients, onProgress, onResync, onError, handlePromise };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("computeReconnectDelayMs", () => {
  it("starts at 3s, doubles per attempt, and caps at 30s", () => {
    expect(computeReconnectDelayMs(0)).toBe(3000);
    expect(computeReconnectDelayMs(1)).toBe(6000);
    expect(computeReconnectDelayMs(2)).toBe(12000);
    expect(computeReconnectDelayMs(3)).toBe(24000);
    expect(computeReconnectDelayMs(4)).toBe(30000);
    expect(computeReconnectDelayMs(10)).toBe(30000);
  });

  it("honors custom bounds", () => {
    expect(computeReconnectDelayMs(0, { initialDelayMs: 100, maxDelayMs: 400 })).toBe(100);
    expect(computeReconnectDelayMs(1, { initialDelayMs: 100, maxDelayMs: 400 })).toBe(200);
    expect(computeReconnectDelayMs(5, { initialDelayMs: 100, maxDelayMs: 400 })).toBe(400);
  });
});

describe("supplement progress listener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens, replays the initial snapshot once connected, and forwards notifications", async () => {
    const harness = createHarness();
    await harness.handlePromise;
    await flush();

    expect(harness.clients).toHaveLength(1);
    const first = clientAt(harness.clients, 0);
    expect(first.connectAttempts).toBe(1);
    expect(first.queries).toEqual([`LISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`]);
    expect(harness.onResync).toHaveBeenCalledTimes(1);

    first.emit("notification", { payload: "room-1" });
    first.emit("notification", {});
    await flush();
    expect(harness.onProgress).toHaveBeenCalledTimes(2);
    expect(harness.onProgress).toHaveBeenNthCalledWith(1, "room-1");
    expect(harness.onProgress).toHaveBeenNthCalledWith(2, "");
  });

  it("reconnects after 3s when the connection drops and replays the snapshot", async () => {
    const harness = createHarness();
    const handle = await harness.handlePromise;
    await flush();

    const first = clientAt(harness.clients, 0);
    first.simulateDisconnect();
    expect(harness.onError).toHaveBeenCalled();
    // No immediate reconnect: the retry is delayed.
    expect(harness.clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(harness.clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.clients).toHaveLength(2);
    const second = clientAt(harness.clients, 1);
    expect(second.queries).toContain(`LISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`);
    expect(first.ended).toBe(true);
    expect(harness.onResync).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("coalesces error, end and close events into a single reconnect", async () => {
    const harness = createHarness();
    const handle = await harness.handlePromise;
    await flush();

    const first = clientAt(harness.clients, 0);
    first.emit("error", new Error("ECONNRESET"));
    first.emit("end");
    first.emit("close");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.clients).toHaveLength(2);

    await handle.stop();
  });

  it("backs off exponentially and caps the retry delay at 30s", async () => {
    const harness = createHarness({ failConnectForFirst: Number.POSITIVE_INFINITY });
    const handle = await harness.handlePromise;

    await flush(); // t=0: client #1 fails to connect
    expect(harness.clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3000); // t=3000: client #2
    expect(harness.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6000); // t=9000: client #3
    expect(harness.clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12_000); // t=21000: client #4
    expect(harness.clients).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(24_000); // t=45000: client #5
    expect(harness.clients).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(30_000); // t=75000: client #6 (capped)
    expect(harness.clients).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(30_000); // t=105000: still 30s, not 60s
    expect(harness.clients).toHaveLength(7);
    expect(harness.onError).toHaveBeenCalled();

    await handle.stop();
  });

  it("resets the backoff after a successful reconnection", async () => {
    const harness = createHarness({ failConnectForFirst: 2 });
    const handle = await harness.handlePromise;

    await vi.advanceTimersByTimeAsync(9000); // t=0 fail, t=3000 fail, t=9000 success
    expect(harness.clients).toHaveLength(3);
    expect(harness.onResync).toHaveBeenCalledTimes(1);

    const third = clientAt(harness.clients, 2);
    third.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(2999);
    expect(harness.clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); // back to the initial 3s delay
    expect(harness.clients).toHaveLength(4);

    await handle.stop();
  });

  it("unlistens and ends the client on stop without reconnecting afterwards", async () => {
    const harness = createHarness();
    const handle = await harness.handlePromise;
    await flush();

    const first = clientAt(harness.clients, 0);
    await handle.stop();
    expect(first.queries).toEqual([
      `LISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`,
      `UNLISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`
    ]);
    expect(first.ended).toBe(true);

    first.simulateDisconnect();
    first.emit("notification", { payload: "room-1" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.clients).toHaveLength(1);
    expect(harness.onProgress).not.toHaveBeenCalled();
    expect(harness.onResync).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending reconnect when stopped", async () => {
    const harness = createHarness();
    const handle = await harness.handlePromise;
    await flush();

    const first = clientAt(harness.clients, 0);
    first.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(1500);
    await handle.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.clients).toHaveLength(1);
  });

  it("keeps the connection when the post-reconnect snapshot replay fails", async () => {
    let resyncCalls = 0;
    const harness = createHarness({
      onResync: async (): Promise<void> => {
        resyncCalls += 1;
        if (resyncCalls === 1) {
          throw new Error("snapshot build failed");
        }
      }
    });
    const handle = await harness.handlePromise;
    await flush();

    expect(harness.onError).toHaveBeenCalledWith(new Error("snapshot build failed"));

    const first = clientAt(harness.clients, 0);
    first.emit("notification", { payload: "room-1" });
    await flush();
    expect(harness.onProgress).toHaveBeenCalledWith("room-1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.clients).toHaveLength(1);
    expect(first.ended).toBe(false);

    await handle.stop();
  });
});
