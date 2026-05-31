import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { PgSongCoverRepository } from "../modules/covers/song-cover-repository.js";

describe("song cover repository", () => {
  it("reads cover URLs from ktv_songs", async () => {
    const db = createCoverDb([
      {
        source_kind: "nas",
        source_song_id: "song-1",
        cover_image_url: "https://cover.example/song-1.jpg"
      }
    ]);
    const repository = new PgSongCoverRepository(db);

    const covers = await repository.findBySongKeys([{ source: "nas", sourceSongId: "song-1" }]);

    expect(covers.get("nas:song-1")?.imageUrl).toBe("https://cover.example/song-1.jpg");
    expect(db.queries[0]?.text).toContain("FROM ktv_songs");
    expect(db.queries[0]?.text).not.toContain("song_cover_cache");
  });

  it("lists unprocessed NAS songs as cover candidates", async () => {
    const db = createCoverDb([
      {
        source_kind: "nas",
        source_song_id: "song-1",
        title: "七里香",
        artist_name: "周杰伦"
      }
    ]);
    const repository = new PgSongCoverRepository(db);

    const candidates = await repository.listCoverCandidates({ limit: 20 });

    expect(candidates).toEqual([
      {
        source: "nas",
        sourceSongId: "song-1",
        title: "七里香",
        artistName: "周杰伦"
      }
    ]);
    expect(db.queries[1]?.text).toContain("s.cover_image_url IS NULL");
    expect(db.queries[1]?.text).toContain("s.cover_updated_at IS NULL");
  });

  it("writes found cover URLs back to ktv_songs", async () => {
    const db = createCoverDb([]);
    const repository = new PgSongCoverRepository(db);

    await repository.upsertCoverResult({
      source: "nas",
      sourceSongId: "song-1",
      title: "七里香",
      artistName: "周杰伦",
      status: "found",
      imageUrl: "https://cover.example/song-1.jpg"
    });

    expect(db.queries[0]).toMatchObject({
      values: ["nas", "song-1", "found", "https://cover.example/song-1.jpg"]
    });
    expect(db.queries[0]?.text).toContain("UPDATE ktv_songs");
    expect(db.queries[0]?.text).toContain("cover_image_url");
    expect(db.queries[0]?.text).not.toContain("song_cover_cache");
  });
});

function createCoverDb(rows: Array<Record<string, unknown>>): QueryExecutor & {
  queries: Array<{ text: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    queries,
    async query<TRow>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("information_schema.columns")) {
        return { rows: [{ exists: true }] as TRow[] };
      }
      return { rows: rows as TRow[] };
    }
  };
}
