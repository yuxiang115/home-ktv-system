import { describe, expect, it } from "vitest";
import {
  buildRepairPlan,
  parseRepairKtvSongMetadataOptions
} from "../scripts/repair-ktv-song-metadata.js";

describe("repair KTV song metadata CLI", () => {
  it("defaults to dry-run for the two recent import roots", () => {
    const options = parseRepairKtvSongMetadataOptions([], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options).toMatchObject({
      apply: false,
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
      roots: ["合唱歌曲", "综艺精选"],
      requireFilenameParse: true
    });
  });

  it("builds a metadata-only repair plan from filename parsing", () => {
    const plan = buildRepairPlan([
      {
        id: "song-1",
        title: "一阳_益佳-明明很用心-国语-情歌对唱",
        normalized_title: "一阳益佳明明很用心国语情歌对唱",
        title_pinyin: "yiyangyijiamingminghenyongxinguoyuqinggeduichang",
        title_initials: "yyyjmmhyxgyqgdc",
        primary_artist_name: "合唱歌曲",
        normalized_primary_artist_name: "合唱歌曲",
        artist_names: ["合唱歌曲"],
        file_path: "/mnt/nas/KTV歌曲/合唱歌曲/一阳_益佳-明明很用心-国语-情歌对唱.mkv",
        relative_path: "合唱歌曲/一阳_益佳-明明很用心-国语-情歌对唱.mkv",
        size_bytes: 123,
        mtime_ms: 456,
        parse_strategy: "path",
        parse_confidence: 0.72
      }
    ]);

    expect(plan.skipped).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      title: "明明很用心",
      normalizedTitle: "明明很用心",
      primaryArtistName: "一阳",
      artistNames: ["一阳", "益佳"],
      parseStrategy: "filename",
      previousPrimaryArtistName: "合唱歌曲"
    });
    expect(plan.items[0]?.titlePinyin).toBeTruthy();
    expect(plan.items[0]?.titleInitials).toBeTruthy();
  });

  it("skips rows that still cannot be parsed from filename by default", () => {
    const plan = buildRepairPlan([
      {
        id: "song-2",
        title: "bad-file",
        normalized_title: "badfile",
        title_pinyin: "badfile",
        title_initials: "b",
        primary_artist_name: "综艺精选",
        normalized_primary_artist_name: "综艺精选",
        artist_names: ["综艺精选"],
        file_path: "/mnt/nas/KTV歌曲/综艺精选/bad-file.mkv",
        relative_path: "综艺精选/bad-file.mkv",
        size_bytes: 123,
        mtime_ms: 456,
        parse_strategy: "path",
        parse_confidence: 0.72
      }
    ]);

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toEqual([
      {
        id: "song-2",
        relativePath: "综艺精选/bad-file.mkv",
        parseStrategy: "path"
      }
    ]);
  });
});
