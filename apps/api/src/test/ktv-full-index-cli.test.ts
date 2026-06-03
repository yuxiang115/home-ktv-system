import { describe, expect, it } from "vitest";
import {
  parseKtvFullIndexCliOptions,
  runKtvFullIndexCli
} from "../scripts/ktv-full-index.js";

describe("ktv-full-index CLI", () => {
  it("parses preserve-existing and core options", () => {
    expect(
      parseKtvFullIndexCliOptions(
        [
          "--source-root",
          "/mnt/nas/KTV歌曲",
          "--database-url",
          "postgres://cli",
          "--limit",
          "20",
          "--preserve-existing"
        ],
        {}
      )
    ).toEqual({
      databaseUrl: "postgres://cli",
      help: false,
      limit: 20,
      preserveExisting: true,
      sourceRoot: "/mnt/nas/KTV歌曲",
      sshHost: undefined
    });
  });

  it("forwards preserveExisting to the importer", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];

    const exitCode = await runKtvFullIndexCli(
      ["--database-url", "postgres://cli", "--preserve-existing"],
      {
        createDbClient: () => ({
          async connect() {},
          async end() {},
          async query() {
            return { rows: [] };
          }
        }),
        discoverMediaFiles: async () => [
          {
            sourcePath: "/mnt/nas/KTV歌曲/流行歌曲/周杰伦-简单爱-国语-流行.mkv",
            relativePath: "流行歌曲/周杰伦-简单爱-国语-流行.mkv",
            sizeBytes: 123,
            mtimeMs: 456
          }
        ],
        indexAssetDrafts: async (_db, input) => {
          calls.push(input);
          return {
            runId: "run-1",
            filesSeen: 1,
            songsUpserted: 1,
            assetsUpserted: 1,
            assetsMarkedMissing: 0
          };
        },
        stdout: (line) => output.push(line)
      }
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({
        preserveExisting: true,
        sourceRoot: "/mnt/nas/KTV歌曲",
        markMissingAssets: true
      })
    ]);
    expect(output).toEqual([
      "KTV index run id: run-1",
      "Discovered media files: 1",
      "Indexed files: 1",
      "Songs upserted: 1",
      "Assets upserted: 1",
      "Assets marked missing: 0"
    ]);
  });
});
