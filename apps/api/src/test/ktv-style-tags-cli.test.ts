import { describe, expect, it } from "vitest";
import { parseKtvStyleTagsCliOptions } from "../scripts/ktv-style-tags.js";

describe("ktv-style-tags CLI options", () => {
  it("parses safe sample defaults and explicit apply mode", () => {
    const options = parseKtvStyleTagsCliOptions(
      ["--source", "netease", "--base-url", "http://127.0.0.1:3301", "--limit", "300", "--apply"],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );

    expect(options).toMatchObject({
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
      source: "netease",
      taggingSource: "netease-playlist-v1",
      baseUrl: "http://127.0.0.1:3301",
      limit: 300,
      apply: true,
      onlyMissing: true
    });
  });

  it("defaults to dry-run unless --apply is present", () => {
    const options = parseKtvStyleTagsCliOptions(["--limit", "50"], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options.apply).toBe(false);
    expect(options.onlyMissing).toBe(true);
    expect(options.limit).toBe(50);
  });
});
