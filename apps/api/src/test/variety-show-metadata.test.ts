import { describe, expect, it } from "vitest";
import {
  cleanKtvSongVarietyMetadata,
  isVarietyShowName,
  stripVarietyShowTitleMarker
} from "../modules/ingest/variety-show-metadata.js";

describe("variety show metadata cleanup", () => {
  it("recognizes configured variety show names", () => {
    expect(isVarietyShowName("中国好声音")).toBe(true);
    expect(isVarietyShowName("中国好歌曲(替换)")).toBe(true);
    expect(isVarietyShowName("张惠妹")).toBe(false);
  });

  it("strips trailing variety show title markers", () => {
    expect(stripVarietyShowTitleMarker("你的样子（异口同声720P）")).toBe("你的样子");
    expect(stripVarietyShowTitleMarker("隐形的翅膀[不凡的改变]")).toBe("隐形的翅膀");
    expect(stripVarietyShowTitleMarker("魔鬼中的天使(2018中国好声音)")).toBe("魔鬼中的天使");
  });

  it("cleans title and artists for comprehensive variety paths", () => {
    const cleaned = cleanKtvSongVarietyMetadata({
      id: "song-1",
      title: "你的样子（异口同声720P）",
      primaryArtistName: "李琦",
      artistNames: ["李琦", "异口同声"],
      relativePath: "综合专辑 9300首1.4T/综艺专区2（1000首）/异口同声/李琦-你的样子（异口同声720P）-国语-流行.mpg"
    });

    expect(cleaned).toMatchObject({
      title: "你的样子",
      primaryArtistName: "李琦",
      artistNames: ["李琦"],
      changed: true
    });
  });

  it("removes variety show names from artists outside the variety roots", () => {
    const cleaned = cleanKtvSongVarietyMetadata({
      id: "song-2",
      title: "夜夜夜夜",
      primaryArtistName: "张杰",
      artistNames: ["张杰", "吴汶芳", "最美和声"],
      relativePath: "流行歌曲(2.5万首880G)/推荐0038/张杰_吴汶芳_最美和声-夜夜夜夜(演唱会)-国语-流行.mkv"
    });

    expect(cleaned).toMatchObject({
      title: "夜夜夜夜",
      primaryArtistName: "张杰",
      artistNames: ["张杰", "吴汶芳"],
      changed: true
    });
  });
});
