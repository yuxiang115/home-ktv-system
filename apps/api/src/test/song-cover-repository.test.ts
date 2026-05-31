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

});

function createCoverDb(rows: Array<Record<string, unknown>>): QueryExecutor & {
  queries: Array<{ text: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    queries,
    async query<TRow>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return { rows: rows as TRow[] };
    }
  };
}
