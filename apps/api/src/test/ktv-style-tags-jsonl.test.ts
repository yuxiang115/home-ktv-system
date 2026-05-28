import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildStyleTaggingSongKey,
  importStyleTaggingJsonlResults,
  runStyleTaggingJsonl
} from "../modules/ktv-index/style-tagging-jsonl.js";

describe("style tagging JSONL staging", () => {
  it("builds a stable key from normalized title, artist, and asset path", () => {
    expect(
      buildStyleTaggingSongKey({
        title: " 稻 香 ",
        artistName: "周杰伦",
        assetPaths: ["/mnt/nas/KTV歌曲/周杰伦-稻香-国语-流行.mkv"]
      })
    ).toBe("稻香|周杰伦|/mnt/nas/ktv歌曲/周杰伦-稻香-国语-流行.mkv");
  });

  it("appends result rows and skips already processed songs on resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-tags-jsonl-"));
    const inputPath = path.join(dir, "songs.jsonl");
    const outputPath = path.join(dir, "results.jsonl");

    await writeFile(
      inputPath,
      [
        JSON.stringify({ schemaVersion: 1, title: "稻香", artistName: "周杰伦" }),
        JSON.stringify({ schemaVersion: 1, title: "一壶老酒", artistName: "陆树铭" })
      ].join("\n") + "\n",
      "utf8"
    );

    const tagSong = vi.fn(async (song: { title: string }) => ({
      tags: song.title === "稻香"
        ? [{ tag: "华语", confidence: 0.8, evidence: ["fixture"] }]
        : [],
      evidence: { provider: "fixture" }
    }));

    const first = await runStyleTaggingJsonl({
      inputPath,
      outputPath,
      source: "netease-playlist-v1",
      tagger: { tagSong },
      now: () => new Date("2026-05-28T00:00:00.000Z").getTime()
    });

    expect(first).toMatchObject({ selected: 2, processed: 2, skipped: 0, tagged: 1, empty: 1, failed: 0 });
    expect(tagSong).toHaveBeenCalledTimes(2);

    const rows = (await readFile(outputPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      schemaVersion: 1,
      source: "netease-playlist-v1",
      status: "tagged",
      song: { title: "稻香", artistName: "周杰伦" },
      tags: [{ tag: "华语", confidence: 0.8 }]
    });
    expect(rows[1]).toMatchObject({ status: "empty", tags: [] });

    const second = await runStyleTaggingJsonl({
      inputPath,
      outputPath,
      source: "netease-playlist-v1",
      tagger: { tagSong }
    });

    expect(second).toMatchObject({ selected: 2, processed: 0, skipped: 2 });
    expect(tagSong).toHaveBeenCalledTimes(2);
  });

  it("skips duplicate song keys within the same JSONL run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-tags-jsonl-dupes-"));
    const inputPath = path.join(dir, "songs.jsonl");
    const outputPath = path.join(dir, "results.jsonl");

    await writeFile(
      inputPath,
      [
        JSON.stringify({ schemaVersion: 1, title: "稻香", artistName: "周杰伦" }),
        JSON.stringify({ schemaVersion: 1, title: " 稻 香 ", artistName: "周杰伦" })
      ].join("\n") + "\n",
      "utf8"
    );

    const tagSong = vi.fn(async () => ({
      tags: [{ tag: "华语", confidence: 0.8, evidence: ["fixture"] }],
      evidence: { provider: "fixture" }
    }));

    const result = await runStyleTaggingJsonl({
      inputPath,
      outputPath,
      source: "netease-playlist-v1",
      tagger: { tagSong }
    });

    expect(result).toMatchObject({ selected: 2, processed: 1, skipped: 1, tagged: 1 });
    expect(tagSong).toHaveBeenCalledTimes(1);
  });

  it("imports staged results by current database identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-tags-import-"));
    const inputPath = path.join(dir, "results.jsonl");
    await writeFile(
      inputPath,
      JSON.stringify({
        schemaVersion: 1,
        source: "netease-playlist-v1",
        songKey: "稻香|周杰伦",
        sourceSongId: "old-song-id",
        song: {
          title: "稻香",
          artistName: "周杰伦",
          normalizedTitle: "稻香",
          normalizedArtistName: "周杰伦"
        },
        status: "tagged",
        tags: [{ tag: "华语", confidence: 0.8, evidence: ["fixture"] }],
        evidence: {},
        processedAt: "2026-05-28T00:00:00.000Z",
        elapsedMs: 12
      }) + "\n",
      "utf8"
    );

    const queries: string[] = [];
    const db = {
      async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        queries.push(sql);
        if (sql.includes("FROM ktv_songs s")) {
          return { rows: [{ id: "new-song-id" }] as T[] };
        }
        return { rows: [] };
      }
    };

    const summary = await importStyleTaggingJsonlResults({ db, inputPath, apply: true });

    expect(summary).toMatchObject({ total: 1, imported: 1, unmatched: 0, dryRun: false });
    expect(queries.some((sql) => sql.includes("DELETE FROM ktv_song_style_tags"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO ktv_song_style_tags"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO ktv_song_tagging_status"))).toBe(true);
  });
});
