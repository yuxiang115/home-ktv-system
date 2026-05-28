import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  CachedNeteaseStyleTaggerClient,
  type NeteaseStyleTaggerClient
} from "../modules/ktv-index/netease-style-tagger.js";

describe("CachedNeteaseStyleTaggerClient", () => {
  it("stores and reuses Netease search responses by source and cache key", async () => {
    const db = new FakeCacheDb();
    const upstream = new FakeNeteaseClient();
    const client = new CachedNeteaseStyleTaggerClient(db, upstream, "netease-playlist-v1");

    const first = await client.searchSongs({ keywords: "周杰伦 七里香", limit: 8 });
    const second = await client.searchSongs({ keywords: "周杰伦 七里香", limit: 8 });

    expect(first).toEqual(second);
    expect(upstream.songSearchCalls).toBe(1);
    expect(db.cache.size).toBe(1);
  });
});

class FakeNeteaseClient implements NeteaseStyleTaggerClient {
  songSearchCalls = 0;

  async searchSongs() {
    this.songSearchCalls += 1;
    return [{ id: 1, name: "七里香", ar: [{ name: "周杰伦" }] }];
  }

  async searchPlaylists() {
    return [];
  }

  async getPlaylistDetail() {
    return null;
  }
}

class FakeCacheDb implements QueryExecutor {
  readonly cache = new Map<string, unknown>();

  async query<TRow>(text: string, values: readonly unknown[] = []) {
    if (text.includes("FROM ktv_song_tagging_cache")) {
      const key = `${values[0]}:${values[1]}`;
      const payload = this.cache.get(key);
      return { rows: payload === undefined ? [] : ([{ payload }] as TRow[]) };
    }

    if (text.includes("INSERT INTO ktv_song_tagging_cache")) {
      const key = `${values[0]}:${values[1]}`;
      this.cache.set(key, JSON.parse(String(values[2])));
      return { rows: [] as TRow[] };
    }

    return { rows: [] as TRow[] };
  }
}
