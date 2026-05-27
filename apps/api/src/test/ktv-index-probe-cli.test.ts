import { describe, expect, it } from "vitest";
import {
  parseKtvIndexProbeCliOptions,
  runKtvIndexProbeCli
} from "../scripts/ktv-index-probe.js";

describe("ktv-index-probe CLI", () => {
  it("parses probe limits, concurrency, retry, dry-run, asset id, database URL, and path mappings", () => {
    expect(
      parseKtvIndexProbeCliOptions(
        [
          "--limit",
          "300",
          "--concurrency",
          "8",
          "--retry-failed",
          "--dry-run",
          "--asset-id",
          "ktv-asset-1",
          "--database-url",
          "postgres://cli"
        ],
        { MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲" }
      )
    ).toEqual({
      assetId: "ktv-asset-1",
      concurrency: 8,
      databaseUrl: "postgres://cli",
      dryRun: true,
      help: false,
      limit: 300,
      mediaPathMappings: "/mnt/nas/KTV歌曲=/nas/KTV歌曲",
      retryFailed: true
    });
  });

  it("uses DATABASE_URL and prints a compact summary", async () => {
    const output: string[] = [];
    const closed: string[] = [];
    const serviceInputs: unknown[] = [];

    const exitCode = await runKtvIndexProbeCli(
      ["--limit", "300", "--concurrency", "2"],
      {
        env: {
          DATABASE_URL: "postgres://env",
          MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲"
        },
        createDbClient: (databaseUrl) => ({
          async connect() {
            output.push(`connect:${databaseUrl}`);
          },
          async end() {
            closed.push(databaseUrl);
          },
          async query() {
            return { rows: [] };
          }
        }),
        createService: (_db, options) => ({
          async probeKtvIndexAssets(input) {
            serviceInputs.push({ input, options });
            return {
              selected: 300,
              probed: 298,
              failed: 2,
              skipped: 0,
              singleTrack: 12,
              dualTrack: 280,
              multiTrack: 6,
              elapsedMs: 12345
            };
          }
        }),
        stdout: (line) => output.push(line)
      }
    );

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["postgres://env"]);
    expect(serviceInputs).toEqual([
      {
        input: {
          limit: 300,
          concurrency: 2,
          retryFailed: false,
          dryRun: false,
          assetId: undefined
        },
        options: {
          pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: "/nas/KTV歌曲" }]
        }
      }
    ]);
    expect(output).toEqual([
      "connect:postgres://env",
      "KTV index probe summary",
      "selected=300 probed=298 failed=2 skipped=0",
      "tracks:1=12 tracks:2=280 tracks:3+=6 elapsedMs=12345"
    ]);
  });

  it("supports pool-like database clients without a required connect step", async () => {
    const closed: string[] = [];
    const serviceInputs: unknown[] = [];

    const exitCode = await runKtvIndexProbeCli(
      ["--concurrency", "8"],
      {
        env: {
          DATABASE_URL: "postgres://env"
        },
        createDbClient: (databaseUrl) => ({
          async end() {
            closed.push(databaseUrl);
          },
          async query() {
            return { rows: [] };
          }
        }),
        createService: () => ({
          async probeKtvIndexAssets(input) {
            serviceInputs.push(input);
            return {
              selected: 0,
              probed: 0,
              failed: 0,
              skipped: 0,
              singleTrack: 0,
              dualTrack: 0,
              multiTrack: 0,
              elapsedMs: 0
            };
          }
        }),
        stdout: () => {}
      }
    );

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["postgres://env"]);
    expect(serviceInputs).toEqual([
      {
        limit: undefined,
        concurrency: 8,
        retryFailed: false,
        dryRun: false,
        assetId: undefined
      }
    ]);
  });

  it("does not hang forever when database client close is slow", async () => {
    const output: string[] = [];

    const result = await Promise.race([
      runKtvIndexProbeCli(
        [],
        {
          closeTimeoutMs: 1,
          env: {
            DATABASE_URL: "postgres://env"
          },
          createDbClient: () => ({
            async end() {
              await new Promise(() => {});
            },
            async query() {
              return { rows: [] };
            }
          }),
          createService: () => ({
            async probeKtvIndexAssets() {
              return {
                selected: 0,
                probed: 0,
                failed: 0,
                skipped: 0,
                singleTrack: 0,
                dualTrack: 0,
                multiTrack: 0,
                elapsedMs: 0
              };
            }
          }),
          stdout: (line) => output.push(line)
        }
      ),
      sleep(50).then(() => "timeout" as const)
    ]);

    expect(result).toBe(0);
    expect(output).toContain("KTV index probe summary");
  });

  it("throws when no database URL is configured", async () => {
    await expect(runKtvIndexProbeCli([], { env: {} })).rejects.toThrow("DATABASE_URL or --database-url is required");
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
