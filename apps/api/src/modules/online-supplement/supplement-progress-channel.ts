import { Client } from "pg";

export const SUPPLEMENT_PROGRESS_CHANNEL = "supplement_progress";

const RECONNECT_INITIAL_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;

export async function notifySupplementProgress(
  db: { query: (text: string, values?: readonly unknown[]) => Promise<unknown> },
  roomId: string
): Promise<void> {
  await db.query("SELECT pg_notify($1, $2)", [SUPPLEMENT_PROGRESS_CHANNEL, roomId]);
}

/**
 * The subset of pg.Client the listener depends on. Injectable so tests can
 * drive connection loss and reconnection with a fake client.
 */
export interface SupplementProgressClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (message: { payload?: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
}

export type SupplementProgressClientFactory = (databaseUrl: string) => SupplementProgressClient;

export interface SupplementProgressListenerHandle {
  stop(): Promise<void>;
}

export interface SupplementProgressReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface StartSupplementProgressListenerOptions {
  databaseUrl: string;
  onProgress: (roomId: string) => Promise<void>;
  /**
   * Replayed once after every successful (re)connection, before any subsequent
   * onProgress delivery: notifications emitted while the connection was down
   * are lost, so consumers should rebuild and push the current snapshot the
   * same way the initial snapshot is built for a freshly connected client.
   */
  onResync?: () => Promise<void>;
  onError?: (error: unknown) => void;
  createClient?: SupplementProgressClientFactory;
  reconnect?: SupplementProgressReconnectOptions;
}

/** Delay before reconnect attempt `attempt` (0-based): 3s, 6s, 12s, 24s, then capped at 30s. */
export function computeReconnectDelayMs(
  attempt: number,
  options: SupplementProgressReconnectOptions = {}
): number {
  const initialDelayMs = options.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  let delayMs = Math.min(initialDelayMs, maxDelayMs);
  for (let i = 0; i < attempt && delayMs < maxDelayMs; i += 1) {
    delayMs = Math.min(delayMs * RECONNECT_BACKOFF_FACTOR, maxDelayMs);
  }
  return delayMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultCreateClient(databaseUrl: string): SupplementProgressClient {
  // pg's conditional `on()` overload signatures do not line up structurally with
  // the per-event overloads of SupplementProgressClient, but the runtime shapes
  // match exactly (connect/query/end + notification/error/end events).
  return new Client({ connectionString: databaseUrl }) as unknown as SupplementProgressClient;
}

/**
 * Owns the pg LISTEN connection for supplement progress notifications.
 *
 * A single pg server restart or network flap used to leave the listener dead
 * forever (the old code only logged the error). This class rebuilds the client
 * and re-runs LISTEN with exponential backoff whenever the connection signals
 * error/end/close, and replays the initial snapshot after every successful
 * (re)connection so consumers can catch up on missed notifications.
 */
export class SupplementProgressListener {
  private readonly databaseUrl: string;
  private readonly onProgress: (roomId: string) => Promise<void>;
  private readonly onResync: (() => Promise<void>) | undefined;
  private readonly reportError: (error: unknown) => void;
  private readonly createClient: SupplementProgressClientFactory;
  private readonly reconnectOptions: SupplementProgressReconnectOptions;

  private client: SupplementProgressClient | null = null;
  private listening = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectLoop: Promise<void> | null = null;
  private connecting: Promise<boolean | void> | null = null;

  constructor(options: StartSupplementProgressListenerOptions) {
    this.databaseUrl = options.databaseUrl;
    this.onProgress = options.onProgress;
    this.onResync = options.onResync;
    this.reportError = options.onError ?? (() => undefined);
    this.createClient = options.createClient ?? defaultCreateClient;
    this.reconnectOptions = options.reconnect ?? {};
  }

  /**
   * Starts the first connection attempt in the background. Connection failures
   * are reported via onError and retried; they never throw out of start().
   */
  start(): void {
    this.connecting = this.attemptConnect().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.connecting) {
      await this.connecting;
    }
    await this.endClient();
  }

  private async attemptConnect(): Promise<void> {
    if (await this.connectOnce()) {
      return;
    }
    if (!this.stopped) {
      this.scheduleReconnect();
    }
  }

  private async connectOnce(): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    this.listening = false;
    const client = this.createClient(this.databaseUrl);
    this.client = client;
    this.attach(client);
    try {
      await client.connect();
      if (this.stopped) {
        await this.endClient();
        return false;
      }
      await client.query(`LISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`);
    } catch (error) {
      this.reportError(error);
      return false;
    }
    this.listening = true;
    this.reconnectAttempts = 0;
    if (this.stopped) {
      await this.endClient();
      return false;
    }
    // The LISTEN session is (re)established: anything notified while we were
    // offline is gone, so replay the initial-snapshot request once before any
    // onProgress delivery.
    try {
      await this.onResync?.();
    } catch (error) {
      // A failed snapshot replay must not tear down a healthy LISTEN connection.
      this.reportError(error);
    }
    return true;
  }

  private attach(client: SupplementProgressClient): void {
    client.on("notification", (message) => {
      if (this.stopped) {
        return;
      }
      const roomId = message.payload ?? "";
      void Promise.resolve(this.onProgress(roomId)).catch((error) => this.reportError(error));
    });

    const handleConnectionLost = (error?: Error): void => {
      if (this.stopped) {
        return;
      }
      this.listening = false;
      this.reportError(error ?? new Error(`${SUPPLEMENT_PROGRESS_CHANNEL} listener connection lost`));
      this.scheduleReconnect();
    };
    // pg emits "error" on connection faults and "end" when the socket goes away
    // (server restart, network flap, client.end()). "close" is attached
    // defensively for teardown paths surfaced directly on the client emitter.
    client.on("error", handleConnectionLost);
    client.on("end", () => handleConnectionLost());
    client.on("close", () => handleConnectionLost());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectLoop) {
      return;
    }
    this.reconnectLoop = this.runReconnectLoop()
      .catch(() => undefined)
      .finally(() => {
        this.reconnectLoop = null;
      });
  }

  private async runReconnectLoop(): Promise<void> {
    while (!this.stopped) {
      const delayMs = computeReconnectDelayMs(this.reconnectAttempts, this.reconnectOptions);
      this.reconnectAttempts += 1;
      await sleep(delayMs);
      if (this.stopped) {
        return;
      }
      // Drop the dead client first; its "end" event is a no-op while this loop runs.
      await this.endClient();
      this.connecting = this.connectOnce().catch(() => false);
      if (await this.connecting) {
        // Healthy again. The next drop restarts this loop from the initial delay.
        return;
      }
    }
  }

  private async endClient(): Promise<void> {
    const client = this.client;
    const wasListening = this.listening;
    this.client = null;
    this.listening = false;
    if (!client) {
      return;
    }
    if (wasListening) {
      try {
        await client.query(`UNLISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`);
      } catch {
        // Best-effort unsubscribe; end() below closes the session regardless.
      }
    }
    try {
      await client.end();
    } catch {
      // Already torn down.
    }
  }
}

export async function startSupplementProgressListener(
  options: StartSupplementProgressListenerOptions
): Promise<SupplementProgressListenerHandle> {
  const listener = new SupplementProgressListener(options);
  listener.start();
  return {
    stop: () => listener.stop()
  };
}
