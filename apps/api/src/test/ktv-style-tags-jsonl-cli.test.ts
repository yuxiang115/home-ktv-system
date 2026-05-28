import { describe, expect, it } from "vitest";
import { parseKtvStyleTagsExportCliOptions } from "../scripts/ktv-style-tags-export.js";
import { parseKtvStyleTagsImportCliOptions } from "../scripts/ktv-style-tags-import.js";
import { parseKtvStyleTagsJsonlCliOptions } from "../scripts/ktv-style-tags-jsonl.js";

describe("KTV style tags JSONL CLI options", () => {
  it("parses export options that require a database and output path", () => {
    const options = parseKtvStyleTagsExportCliOptions(
      ["--out", "runtime/media/tagging/full/songs.jsonl", "--limit", "300"],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );

    expect(options).toMatchObject({
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
      outPath: "runtime/media/tagging/full/songs.jsonl",
      limit: 300
    });
  });

  it("parses JSONL tagging options without requiring DATABASE_URL", () => {
    const options = parseKtvStyleTagsJsonlCliOptions(
      [
        "--input",
        "runtime/media/tagging/full/songs.jsonl",
        "--output",
        "runtime/media/tagging/full/results.jsonl",
        "--source",
        "netease",
        "--base-url",
        "http://127.0.0.1:3301",
        "--progress-every",
        "25"
      ],
      {}
    );

    expect(options).toMatchObject({
      inputPath: "runtime/media/tagging/full/songs.jsonl",
      outputPath: "runtime/media/tagging/full/results.jsonl",
      source: "netease",
      taggingSource: "netease-playlist-v1",
      baseUrl: "http://127.0.0.1:3301",
      progressEvery: 25
    });
  });

  it("parses import dry-run and apply modes", () => {
    const dryRun = parseKtvStyleTagsImportCliOptions(
      ["--input", "runtime/media/tagging/full/results.jsonl", "--dry-run"],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );
    const apply = parseKtvStyleTagsImportCliOptions(
      ["--input", "runtime/media/tagging/full/results.jsonl", "--apply"],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );

    expect(dryRun).toMatchObject({ apply: false });
    expect(apply).toMatchObject({ apply: true });
  });
});
