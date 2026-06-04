import { describe, expect, it } from "vitest";
import {
  buildCleanupPlan,
  parseCleanVarietyShowMetadataOptions
} from "../scripts/clean-variety-show-metadata.js";

describe("clean variety show metadata CLI", () => {
  it("defaults to dry-run and reads DATABASE_URL from env", () => {
    const options = parseCleanVarietyShowMetadataOptions([], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options).toMatchObject({
      apply: false,
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });
  });

  it("parses apply and limit flags", () => {
    const options = parseCleanVarietyShowMetadataOptions([
      "--",
      "--apply",
      "--limit",
      "10",
      "--database-url",
      "postgres://example"
    ]);

    expect(options).toMatchObject({
      apply: true,
      limit: 10,
      databaseUrl: "postgres://example"
    });
  });

  it("builds cleanup plans from selected database rows", () => {
    const plan = buildCleanupPlan([
      {
        id: "song-1",
        title: "你的样子（异口同声720P）",
        primary_artist_name: "李琦",
        artist_names: ["李琦", "异口同声"],
        relative_path: "综合专辑 9300首1.4T/综艺专区2（1000首）/异口同声/李琦-你的样子（异口同声720P）-国语-流行.mpg"
      }
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      title: "你的样子",
      artistNames: ["李琦"]
    });
  });
});
