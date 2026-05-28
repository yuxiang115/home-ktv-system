import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  KtvStyleTaggingService,
  type KtvStyleTagger,
  type KtvStyleTaggingSong
} from "../modules/ktv-index/ktv-style-tagging-service.js";

describe("KtvStyleTaggingService", () => {
  it("tags selected songs and records empty or failed outcomes", async () => {
    const db = new FakeStyleTaggingDb();
    const service = new KtvStyleTaggingService(db, {
      tagger: new FakeTagger(),
      now: () => 1000
    });

    const result = await service.run({
      source: "netease-playlist-v1",
      limit: 3,
      apply: true,
      onlyMissing: true
    });

    expect(result).toMatchObject({
      selected: 3,
      processed: 3,
      taggedSongs: 1,
      emptySongs: 1,
      failedSongs: 1,
      writtenTags: 2,
      averageTags: 2
    });
    expect(db.songTags.get("song-1")).toEqual([
      { tagName: "国语", source: "netease-playlist-v1" },
      { tagName: "流行", source: "netease-playlist-v1" }
    ]);
    expect(db.status.get("song-2")).toMatchObject({ status: "empty", tagCount: 0 });
    expect(db.status.get("song-3")).toMatchObject({ status: "failed", errorMessage: "netease failed" });
    expect(db.deletedSources).toContain("song-1:netease-playlist-v1");
  });

  it("does not write database tag rows during dry run", async () => {
    const db = new FakeStyleTaggingDb();
    const service = new KtvStyleTaggingService(db, {
      tagger: new FakeTagger(),
      now: () => 1000
    });

    const result = await service.run({
      source: "netease-playlist-v1",
      limit: 1,
      apply: false,
      onlyMissing: true
    });

    expect(result).toMatchObject({
      selected: 1,
      processed: 1,
      taggedSongs: 1,
      writtenTags: 0
    });
    expect(db.songTags.size).toBe(0);
    expect(db.runs).toHaveLength(0);
  });

  it("reports progress after each processed song", async () => {
    const db = new FakeStyleTaggingDb();
    const progress: Array<Record<string, unknown>> = [];
    const service = new KtvStyleTaggingService(db, {
      tagger: new FakeTagger(),
      now: () => 1000
    });

    await service.run({
      source: "netease-playlist-v1",
      limit: 3,
      apply: false,
      onlyMissing: true,
      onProgress: (event) => progress.push(event)
    });

    expect(progress).toEqual([
      expect.objectContaining({ processed: 1, selected: 3, status: "tagged", title: "七里香", artistName: "周杰伦", tagCount: 2 }),
      expect.objectContaining({ processed: 2, selected: 3, status: "empty", title: "未知歌", artistName: "未知歌手", tagCount: 0 }),
      expect.objectContaining({ processed: 3, selected: 3, status: "failed", title: "失败歌", artistName: "失败歌手", tagCount: 0 })
    ]);
  });
});

class FakeTagger implements KtvStyleTagger {
  async tagSong(song: KtvStyleTaggingSong) {
    if (song.id === "song-1") {
      return {
        tags: [
          { tag: "国语", confidence: 0.8, evidence: ["playlist.tag:国语"] },
          { tag: "流行", confidence: 0.7, evidence: ["playlist.name:流行"] },
          { tag: "不在白名单", confidence: 1, evidence: ["bad"] }
        ],
        evidence: { source: "fake" }
      };
    }
    if (song.id === "song-2") {
      return { tags: [], evidence: { source: "fake" } };
    }
    throw new Error("netease failed");
  }
}

class FakeStyleTaggingDb implements QueryExecutor {
  readonly runs: Array<Record<string, unknown>> = [];
  readonly groups = new Map<string, string>();
  readonly tags = new Map<string, { id: string; groupName: string; name: string }>();
  readonly songTags = new Map<string, Array<{ tagName: string; source: string }>>();
  readonly status = new Map<string, Record<string, unknown>>();
  readonly deletedSources: string[] = [];
  private runCounter = 0;

  async query<TRow>(text: string, values: readonly unknown[] = []) {
    if (text.includes("FROM ktv_songs")) {
      return {
        rows: [
          { id: "song-1", title: "七里香", primary_artist_name: "周杰伦" },
          { id: "song-2", title: "未知歌", primary_artist_name: "未知歌手" },
          { id: "song-3", title: "失败歌", primary_artist_name: "失败歌手" }
        ].slice(0, Number(values.at(-1) ?? 3)) as TRow[]
      };
    }

    if (text.includes("INSERT INTO ktv_song_tagging_runs")) {
      this.runCounter += 1;
      const id = `run-${this.runCounter}`;
      this.runs.push({ id, source: values[0], selectedCount: values[1] });
      return { rows: [{ id }] as TRow[] };
    }

    if (text.includes("INSERT INTO ktv_style_groups")) {
      this.groups.set(String(values[0]), String(values[1]));
      return { rows: [] as TRow[] };
    }

    if (text.includes("INSERT INTO ktv_style_tags")) {
      this.tags.set(String(values[2]), { id: String(values[1]), groupName: String(values[0]), name: String(values[2]) });
      return { rows: [] as TRow[] };
    }

    if (text.includes("DELETE FROM ktv_song_style_tags")) {
      this.deletedSources.push(`${values[0]}:${values[1]}`);
      this.songTags.delete(String(values[0]));
      return { rows: [] as TRow[] };
    }

    if (text.includes("INSERT INTO ktv_song_style_tags")) {
      const songId = String(values[0]);
      const tagName = this.findTagNameById(String(values[1]));
      const tags = this.songTags.get(songId) ?? [];
      tags.push({ tagName, source: String(values[2]) });
      this.songTags.set(songId, tags);
      return { rows: [] as TRow[] };
    }

    if (text.includes("INSERT INTO ktv_song_tagging_status")) {
      this.status.set(String(values[0]), {
        source: values[1],
        status: values[2],
        tagCount: values[3],
        confidence: values[4],
        runId: values[5],
        errorMessage: values[6]
      });
      return { rows: [] as TRow[] };
    }

    return { rows: [] as TRow[] };
  }

  private findTagNameById(tagId: string): string {
    for (const tag of this.tags.values()) {
      if (tag.id === tagId) {
        return tag.name;
      }
    }
    return tagId;
  }
}
