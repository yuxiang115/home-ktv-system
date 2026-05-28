import { describe, expect, it } from "vitest";
import { selectBestCoverCandidate } from "../modules/covers/cover-matcher.js";

describe("song cover matcher", () => {
  it("selects an exact title and artist match", () => {
    const match = selectBestCoverCandidate(
      { title: "晴天", artistName: "周杰伦" },
      [
        {
          provider: "tencent",
          providerSongId: "wrong",
          title: "晴天",
          artistNames: ["不是周杰伦"],
          albumName: "翻唱",
          picId: "wrong-pic"
        },
        {
          provider: "tencent",
          providerSongId: "qingtian",
          title: "晴天",
          artistNames: ["周杰伦"],
          albumName: "叶惠美",
          picId: "qingtian-pic"
        }
      ]
    );

    expect(match).toMatchObject({
      provider: "tencent",
      providerSongId: "qingtian",
      confidence: 100
    });
  });

  it("rejects weak title matches even when the artist matches", () => {
    const match = selectBestCoverCandidate(
      { title: "晴天", artistName: "周杰伦" },
      [
        {
          provider: "kugou",
          providerSongId: "rainbow",
          title: "彩虹",
          artistNames: ["周杰伦"],
          albumName: "我很忙",
          picId: "rainbow-pic"
        }
      ]
    );

    expect(match).toBeNull();
  });

  it("prefers the original-looking result over live and DJ variants", () => {
    const match = selectBestCoverCandidate(
      { title: "晴天", artistName: "周杰伦" },
      [
        {
          provider: "kugou",
          providerSongId: "dj",
          title: "晴天 DJ版",
          artistNames: ["周杰伦"],
          albumName: "晴天 DJ版",
          picId: "dj-pic"
        },
        {
          provider: "kugou",
          providerSongId: "live",
          title: "晴天 Live",
          artistNames: ["周杰伦"],
          albumName: "演唱会",
          picId: "live-pic"
        },
        {
          provider: "kugou",
          providerSongId: "original",
          title: "晴天",
          artistNames: ["周杰伦"],
          albumName: "叶惠美",
          picId: "original-pic"
        }
      ]
    );

    expect(match?.providerSongId).toBe("original");
  });
});
