import { describe, expect, it } from "vitest";
import {
  parseSongCoverCoverageCliOptions,
  runSongCoverCoverageCli
} from "../scripts/song-cover-coverage.js";

describe("song cover coverage CLI", () => {
  it("parses safe defaults and explicit providers", () => {
    const options = parseSongCoverCoverageCliOptions(
      [
        "--limit",
        "120",
        "--delay-ms",
        "300",
        "--source",
        "ktv-index",
        "--providers",
        "tencent,kugou,netease",
        "--progress-every",
        "25",
        "--database-url",
        "postgres://cli"
      ],
      {}
    );

    expect(options).toEqual({
      databaseUrl: "postgres://cli",
      delayMs: 300,
      help: false,
      limit: 120,
      progressEvery: 25,
      providers: ["tencent", "kugou", "netease"],
      requestTimeoutMs: 6000,
      searchLimit: 8,
      source: "ktv-index"
    });
  });

  it("uses DATABASE_URL and prints a compact read-only summary", async () => {
    const output: string[] = [];
    const closed: string[] = [];
    const queried: unknown[] = [];
    const requestedSongs: unknown[] = [];

    const exitCode = await runSongCoverCoverageCli(["--limit", "3", "--delay-ms", "1", "--progress-every", "2"], {
      env: { DATABASE_URL: "postgres://env" },
      now: () => 1000,
      createDbClient: (databaseUrl) => ({
        async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          queried.push({ sql, params });
          return {
            rows: [
              { sourceSongId: "song-1", title: "晴天", artistName: "周杰伦" },
              { sourceSongId: "song-2", title: "十年", artistName: "陈奕迅" },
              { sourceSongId: "song-3", title: "冷门歌", artistName: "佚名" }
            ] as T[]
          };
        },
        async end() {
          closed.push(databaseUrl);
        }
      }),
      createProvider: (options) => ({
        options,
        async findCover(song) {
          requestedSongs.push(song);
          if (song.sourceSongId === "song-3") {
            return null;
          }
          return {
            provider: "tencent",
            providerSongId: `provider-${song.sourceSongId}`,
            title: song.title,
            artistNames: [song.artistName],
            albumName: song.title,
            imageUrl: `https://cover.example/${song.sourceSongId}.jpg`,
            confidence: 100,
            payload: {}
          };
        }
      }),
      sleep: async () => {},
      stdout: (line) => output.push(line)
    });

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["postgres://env"]);
    expect(queried).toHaveLength(1);
    expect(requestedSongs).toEqual([
      { source: "ktv-index", sourceSongId: "song-1", title: "晴天", artistName: "周杰伦" },
      { source: "ktv-index", sourceSongId: "song-2", title: "十年", artistName: "陈奕迅" },
      { source: "ktv-index", sourceSongId: "song-3", title: "冷门歌", artistName: "佚名" }
    ]);
    expect(output).toContain("[coverage] progress=2/3 found=2 not_found=0 failed=0 hitRate=100.0%");
    expect(output.at(-1)).toContain('"hitRate": "66.7%"');
    expect(output.at(-1)).toContain('"failed": 0');
  });

  it("throws when no database URL is configured", async () => {
    await expect(runSongCoverCoverageCli([], { env: {} })).rejects.toThrow("DATABASE_URL or --database-url is required");
  });
});
