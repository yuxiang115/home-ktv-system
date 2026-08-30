import { describe, expect, it } from "vitest";
import { artistTrackFromStem } from "../modules/online-supplement/lrclib-client.js";

describe("artistTrackFromStem", () => {
  it("parses artist and track from the four-segment supplement naming", () => {
    expect(artistTrackFromStem("薛之謙_Joker_Xue-演員-國語-流行")).toEqual({
      artistName: "薛之謙 Joker Xue",
      trackName: "演員"
    });
  });

  it("parses two-segment names without language/category", () => {
    expect(artistTrackFromStem("林俊傑-江南")).toEqual({
      artistName: "林俊傑",
      trackName: "江南"
    });
  });

  it("returns null when the stem has fewer than two segments", () => {
    expect(artistTrackFromStem("只有一段")).toBeNull();
    expect(artistTrackFromStem("a--b")).toEqual({ artistName: "a", trackName: "b" });
  });

  it("returns null when a parsed name is empty after underscore normalization", () => {
    expect(artistTrackFromStem("_-歌名-国语-流行")).toBeNull();
  });
});
