import { describe, expect, it } from "vitest";

import { buildPinyinSearchKeys, normalizeSearchText } from "../modules/catalog/search-normalization.js";

describe("catalog search normalization", () => {
  it("normalizes full-width latin text and separators", () => {
    expect(normalizeSearchText(" Ｑｉ Li-Xiang ")).toBe("qilixiang");
  });

  it("converts traditional Chinese text to simplified normalized text", () => {
    expect(normalizeSearchText("後來")).toBe("后来");
  });

  it("keeps medley separators in normalized titles", () => {
    expect(normalizeSearchText("望春風^雨夜花")).toBe("望春风^雨夜花");
    expect(normalizeSearchText("断了线 + 回家")).toBe("断了线+回家");
  });

  it("builds full pinyin and initials search keys", () => {
    expect(buildPinyinSearchKeys("七里香")).toEqual({
      pinyin: "qilixiang",
      initials: "qlx"
    });
  });

});
