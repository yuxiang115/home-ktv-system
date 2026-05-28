import { describe, expect, it } from "vitest";
import { NeteaseStyleTagger, type NeteaseStyleTaggerClient } from "../modules/ktv-index/netease-style-tagger.js";

describe("NeteaseStyleTagger", () => {
  it("keeps title-specific playlist evidence and filters one-off broad artist playlist noise", async () => {
    const tagger = new NeteaseStyleTagger({
      client: new FakeNeteaseClient(),
      playlistDetailLimit: 3,
      playlistSearchLimit: 3,
      maxTags: 8
    });

    const result = await tagger.tagSong({
      artistName: "鲁士郎",
      title: "高手高手高高手"
    });

    expect(result.tags.map((tag) => tag.tag)).toContain("影视金曲");
    expect(result.tags.map((tag) => tag.tag)).not.toContain("儿歌");
    expect(result.tags.map((tag) => tag.tag)).not.toContain("甜蜜");
  });
});

class FakeNeteaseClient implements NeteaseStyleTaggerClient {
  async searchSongs() {
    return [{ id: 1, name: "高手高手高高手", ar: [{ name: "鲁士郎" }] }];
  }

  async searchPlaylists() {
    return [
      { id: 1, name: "鲁士郎（童年回忆）", tags: ["儿童", "快乐"] },
      { id: 2, name: "高手高手高高手电影原声", tags: [] }
    ];
  }

  async getPlaylistDetail(id: number) {
    if (id === 1) {
      return { id, name: "鲁士郎（童年回忆）", tags: ["儿童", "快乐"] };
    }
    return { id, name: "高手高手高高手电影原声", tags: [] };
  }
}
