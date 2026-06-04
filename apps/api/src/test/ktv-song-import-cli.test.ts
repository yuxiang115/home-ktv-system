import { describe, expect, it } from "vitest";
import { parseKtvSongImportCliOptions, runKtvSongImportCli } from "../scripts/ktv-song-import.js";

describe("ktv-song-import CLI", () => {
  it("parses import root, library root, and preserve-existing defaults", () => {
    expect(
      parseKtvSongImportCliOptions(
        [
          "--import-root",
          "/mnt/nas/KTV歌曲/_imports/new-batch",
          "--library-root",
          "/mnt/nas/KTV歌曲",
          "--database-url",
          "postgres://cli"
        ],
        {}
      )
    ).toEqual({
      databaseUrl: "postgres://cli",
      help: false,
      importRoot: "/mnt/nas/KTV歌曲/_imports/new-batch",
      libraryRoot: "/mnt/nas/KTV歌曲",
      limit: undefined,
      overwriteExisting: false,
      preserveExisting: true,
      sshHost: undefined
    });
  });

  it("imports one directory without marking other songs missing", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];

    const exitCode = await runKtvSongImportCli(
      [
        "--import-root",
        "/mnt/nas/KTV歌曲/_imports/new-batch",
        "--library-root",
        "/mnt/nas/KTV歌曲",
        "--database-url",
        "postgres://cli"
      ],
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
            sourcePath: "/mnt/nas/KTV歌曲/_imports/new-batch/周杰伦-简单爱-国语-流行.mkv",
            relativePath: "_imports/new-batch/周杰伦-简单爱-国语-流行.mkv",
            sizeBytes: 123,
            mtimeMs: 456
          }
        ],
        indexAssetDrafts: async (_db, input) => {
          calls.push(input);
          return {
            runId: "import-1",
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
        sourceRoot: "/mnt/nas/KTV歌曲",
        markMissingAssets: false,
        preserveExisting: true
      })
    ]);
    expect(output).toEqual([
      "KTV song import run id: import-1",
      "Discovered media files: 1",
      "Imported files: 1",
      "Songs upserted: 1",
      "Assets upserted: 1",
      "Assets marked missing: 0"
    ]);
  });
});
