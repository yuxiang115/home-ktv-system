import { Client } from "pg";

export const SUPPLEMENT_PROGRESS_CHANNEL = "supplement_progress";

export async function notifySupplementProgress(
  db: { query: (text: string, values?: readonly unknown[]) => Promise<unknown> },
  roomId: string
): Promise<void> {
  await db.query("SELECT pg_notify($1, $2)", [SUPPLEMENT_PROGRESS_CHANNEL, roomId]);
}

export interface SupplementProgressListenerHandle {
  stop(): Promise<void>;
}

export interface StartSupplementProgressListenerOptions {
  databaseUrl: string;
  onProgress: (roomId: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

export async function startSupplementProgressListener(
  options: StartSupplementProgressListenerOptions
): Promise<SupplementProgressListenerHandle> {
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  await client.query(`LISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`);

  client.on("notification", (message) => {
    const roomId = message.payload ?? "";
    Promise.resolve(options.onProgress(roomId)).catch((error) => options.onError?.(error));
  });
  client.on("error", (error) => options.onError?.(error));

  return {
    stop: async () => {
      try {
        await client.query(`UNLISTEN ${SUPPLEMENT_PROGRESS_CHANNEL}`);
      } finally {
        await client.end();
      }
    }
  };
}
