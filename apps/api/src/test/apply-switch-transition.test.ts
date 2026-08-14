import { describe, expect, it } from "vitest";
import { withRemuxStartPosition } from "../modules/playback/apply-switch-transition.js";

describe("withRemuxStartPosition", () => {
  it("rewrites the start query param with the exact client position", () => {
    expect(withRemuxStartPosition("http://ktv.local/media/nas/asset-1?audio=1&start=0", 83_456)).toBe(
      "http://ktv.local/media/nas/asset-1?audio=1&start=83456"
    );
  });

  it("adds a start param when the fallback url has none", () => {
    expect(withRemuxStartPosition("http://ktv.local/media/nas/asset-1?audio=0", 1_200)).toBe(
      "http://ktv.local/media/nas/asset-1?audio=0&start=1200"
    );
  });

  it("clamps negative positions to zero", () => {
    expect(withRemuxStartPosition("http://ktv.local/media/nas/asset-1?audio=1", -5)).toBe(
      "http://ktv.local/media/nas/asset-1?audio=1&start=0"
    );
  });

  it("returns the url untouched when it cannot be parsed", () => {
    expect(withRemuxStartPosition("not a url", 1_000)).toBe("not a url");
  });
});
