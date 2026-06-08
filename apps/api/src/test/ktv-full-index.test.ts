import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { schemaSql, tableNames } from "../db/schema.js";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  buildKtvIndexAssetDraft,
  indexKtvAssetDrafts,
  type KtvIndexAssetDraft
} from "../modules/ingest/ktv-full-index.js";

const migrationUrl = new URL("../db/migrations/0008_ktv_full_index.sql", import.meta.url);
const migrationSql = existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : "";
const activeAssetIndexMigrationUrl = new URL("../db/migrations/0009_ktv_active_asset_indexes.sql", import.meta.url);
const activeAssetIndexMigrationSql = existsSync(activeAssetIndexMigrationUrl)
  ? readFileSync(activeAssetIndexMigrationUrl, "utf8")
  : "";

describe("KTV full index schema", () => {
  it("keeps a single playable-file ktv_songs table in the final schema", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ktv_song_assets");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS ktv_songs");
    for (const removedTable of [
      "CREATE TABLE IF NOT EXISTS ktv_index_runs",
      "CREATE TABLE IF NOT EXISTS ktv_artists",
      "CREATE TABLE IF NOT EXISTS ktv_song_artists",
      "CREATE TABLE IF NOT EXISTS ktv_song_assets"
    ]) {
      expect(schemaSql).not.toContain(removedTable);
    }

    expect(tableNames.ktvSongs).toBe("ktv_songs");
    expect(Object.values(tableNames)).not.toContain("ktv_song_assets");
  });

  it("indexes title, artist, and path lookup columns without retaining legacy category", () => {
    for (const expected of [
      "ktv_songs_normalized_title_trgm_idx",
      "ktv_songs_artist_names_gin_idx",
      "ktv_songs_file_path_uq"
    ]) {
      expect(schemaSql).toContain(expected);
    }
    expect(schemaSql).not.toContain("category text NOT NULL");
    expect(schemaSql).not.toContain("ktv_songs_category_idx");
  });

  it("adds partial indexes for active playable songs", () => {
    for (const expected of [
      "ktv_songs_active_idx",
      "WHERE missing_at IS NULL"
    ]) {
      expect(schemaSql).toContain(expected);
    }
    expect(activeAssetIndexMigrationSql).toContain("ktv_song_assets_active_song_idx");
  });
});

describe("KTV full index importer", () => {
  it("builds a full index asset draft from a source file", () => {
    const draft = buildKtvIndexAssetDraft({
      sourcePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      sizeBytes: 123,
      mtimeMs: 456
    });

    expect(draft).toMatchObject({
      title: "练舞功",
      artistNames: ["谢金燕"],
      filePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      technicalStatus: "pending"
    });
  });

  it("cleans display-only markers from imported song titles", () => {
    const cases = [
      {
        relativePath: "国语-知名歌星专辑 11000首850G/知名歌星个人专辑（65人6600首）/李克勤（国语21）/李克勤-酒干倘卖无(蒙面歌王)流行-国语-流行.mpg",
        title: "酒干倘卖无",
        normalizedTitle: "酒干倘卖无"
      },
      {
        relativePath: "综合专辑 9300首1.4T/K歌排行/70后/张靓颖-如果这就是爱情[720高清]-国语-流行.mpg",
        title: "这就是爱情",
        normalizedTitle: "这就是爱情"
      },
      {
        relativePath: "1080P全高清MPG2026年更新（更新中）/02月MPG1080/全幺九-别回头 (错过的人不必挽留)[1080P]-国语-流行.mpg",
        title: "别回头",
        normalizedTitle: "别回头"
      },
      {
        relativePath: "1080P全高清MPG2026年更新（更新中）/02月MPG1080/刘德华 十五运会和残特奥会-共赴山海 (粤语版)[1080P]-粤语-流行.mpg",
        title: "共赴山海",
        normalizedTitle: "共赴山海"
      },
      {
        relativePath: "1080P全高清MPG2026年更新（更新中）/04月mpg1080/KKSTR-三年之约 (今日我再重复一次)(DJ)[1080P]-舞曲-DJ.mpg",
        title: "三年之约",
        normalizedTitle: "三年之约"
      },
      {
        relativePath: "2024/2024-11/曹龙-同喜同乐同发财(演唱会)[现场]-国语-流行.mkv",
        title: "同喜同乐同发财",
        normalizedTitle: "同喜同乐同发财"
      },
      {
        relativePath: "1080P全高清MPG2026年更新（更新中）/01月MPG1080/周杰伦-以父之名 (2004无与伦比演唱会)(ai修复版)[1080P]-国语-流行.mpg",
        title: "以父之名",
        normalizedTitle: "以父之名"
      },
      {
        relativePath: "综艺精选/魏雪漫-我是真的爱你中国好声音第三季-国语-流行歌曲.mkv",
        title: "我是真的爱你",
        normalizedTitle: "我是真的爱你"
      },
      {
        relativePath: "综艺精选/中国好声音16强学员-火中国好声音第三季-国语-流行歌曲.mkv",
        title: "火",
        normalizedTitle: "火"
      },
      {
        relativePath: "综艺精选/张丹丹-爱是一颗幸福的子弹 LIVE中国好声音第三季-国语-流行歌曲.mkv",
        title: "爱是一颗幸福的子弹",
        normalizedTitle: "爱是一颗幸福的子弹"
      },
      {
        relativePath: "流行歌曲/姜育恒-再回首-演唱会-国语-流行.mkv",
        title: "再回首",
        normalizedTitle: "再回首"
      },
      {
        relativePath: "综艺精选/巴图-她来听我的演唱会(跨界歌王)-国语-流行.mkv",
        title: "她来听我的演唱会",
        normalizedTitle: "她来听我的演唱会"
      },
      {
        relativePath: "综合专辑 9300首1.4T/K歌排行/90后/汪苏泷-不够成熟[2]-国语-流行.mpg",
        title: "不够成熟",
        normalizedTitle: "不够成熟"
      },
      {
        relativePath: "国语-知名歌星专辑 11000首850G/刀郎（国语50）/刀郎-手心里的温柔[R]-国语-流行.mpg",
        title: "手心里的温柔",
        normalizedTitle: "手心里的温柔"
      },
      {
        relativePath: "2024/2024-01/韩磊_谭维维-不忘初心 (2017春晚版)-国语-流行.mkv",
        title: "不忘初心",
        normalizedTitle: "不忘初心"
      },
      {
        relativePath: "经典老歌(1.2万首450G)/经典老歌1/辛晓琪-领悟〖演唱会〗-国语-流行.mkv",
        title: "领悟",
        normalizedTitle: "领悟"
      }
    ] as const;

    for (const testCase of cases) {
      const draft = buildKtvIndexAssetDraft({
        sourcePath: `/mnt/nas/KTV歌曲/${testCase.relativePath}`,
        relativePath: testCase.relativePath,
        sizeBytes: 123,
        mtimeMs: 456
      });

      expect(draft.title).toBe(testCase.title);
      expect(draft.normalizedTitle).toBe(testCase.normalizedTitle);
    }
  });

  it("parses new top-level import folders with filename metadata", () => {
    const cases = [
      {
        relativePath: "合唱歌曲/一阳_益佳-明明很用心-国语-情歌对唱.mkv",
        title: "明明很用心",
        artists: ["一阳", "益佳"]
      },
      {
        relativePath: "综艺精选/邓紫棋-喜欢你(盖世英雄)-粤语-流行.mkv",
        title: "喜欢你",
        artists: ["邓紫棋"]
      },
      {
        relativePath: "综艺精选/光良-第一次(歌手)-国语-流行-流行.mkv",
        title: "第一次",
        artists: ["光良"]
      },
      {
        relativePath: "综艺精选/孙美琪-La Vie En Rose(中国好声音2020)-法语-流行.mkv",
        title: "La Vie En Rose",
        artists: ["孙美琪"]
      },
      {
        relativePath: "综艺精选/贺三-耶利亚女郎-演唱会(中国好声音2021)-流行.mkv",
        title: "耶利亚女郎",
        artists: ["贺三"]
      },
      {
        relativePath: "综艺精选/黄致列-像中枪一样（WSGSIIII）-黄致列.mkv",
        title: "像中枪一样",
        artists: ["黄致列"]
      }
    ] as const;

    for (const testCase of cases) {
      const draft = buildKtvIndexAssetDraft({
        sourcePath: `/mnt/nas/KTV歌曲/${testCase.relativePath}`,
        relativePath: testCase.relativePath,
        sizeBytes: 123,
        mtimeMs: 456
      });

      expect(draft.title).toBe(testCase.title);
      expect(draft.normalizedTitle).toBeTruthy();
      expect(draft.artistNames).toEqual(testCase.artists);
    }
  });

  it("does not treat variety show names as artists when splitting filename artist text", () => {
    const cases = [
      {
        relativePath: "流行歌曲(2.5万首880G)/推荐0038/张杰_吴汶芳_最美和声-夜夜夜夜(演唱会)-国语-流行.mkv",
        expectedArtists: ["张杰", "吴汶芳"]
      },
      {
        relativePath: "流行歌曲(2.5万首880G)/推荐0062/姚贝娜_中国好声音-DEAR FRIEND(演唱会)-国语-流行.mkv",
        expectedArtists: ["姚贝娜"]
      },
      {
        relativePath: "综合专辑 9300首1.4T/综艺专区2（1000首）/我是歌手/张宇_我是歌手-20岁的眼泪(演唱会)-国语-流行.mpg",
        expectedArtists: ["张宇"]
      }
    ] as const;

    for (const testCase of cases) {
      const draft = buildKtvIndexAssetDraft({
        sourcePath: `/mnt/nas/KTV歌曲/${testCase.relativePath}`,
        relativePath: testCase.relativePath,
        sizeBytes: 123,
        mtimeMs: 456
      });

      expect(draft.artistNames).toEqual(testCase.expectedArtists);
    }
  });

  it("upserts one playable song row per NAS file", async () => {
    const db = createRecordingDb();
    const drafts: KtvIndexAssetDraft[] = [
      createDraft({ filePath: "/media/a.mkv" }),
      createDraft({ filePath: "/media/b.mpg" })
    ];

    const result = await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      sshHost: "lxc-nas",
      drafts,
      batchSize: 1
    });

    expect(result).toMatchObject({
      filesSeen: 2,
      songsUpserted: 2,
      assetsUpserted: 2
    });
    expect(db.queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO ktv_songs"),
      expect.stringContaining("ON CONFLICT (file_path)")
    ]));
    expect(db.queries.map((query) => query.text).join("\n")).not.toContain("ktv_song_assets");
    expect(db.queries.map((query) => query.text).join("\n")).not.toContain("ktv_artists");
  });

  it("marks previously indexed assets missing during a full rebuild", async () => {
    const db = createRecordingDb();

    const result = await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      drafts: [createDraft({ filePath: "/media/current.mkv" })],
      markMissingAssets: true
    });

    expect(result.assetsMarkedMissing).toBe(3);
    expect(db.queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE ktv_songs"),
      expect.stringContaining("last_seen_run_id IS DISTINCT FROM $1"),
      expect.stringContaining("missing_at IS NULL")
    ]));
  });

  it("preserves existing same-path metadata when preserveExisting is enabled", async () => {
    const db = createRecordingDb();

    await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      drafts: [createDraft({ filePath: "/media/existing.mkv" })],
      preserveExisting: true
    });

    const upsertQuery = db.queries.find((query) => query.text.includes("ON CONFLICT (file_path)"));
    expect(upsertQuery?.text).toBeDefined();
    expect(upsertQuery?.text).toContain("last_seen_run_id = EXCLUDED.last_seen_run_id");
    expect(upsertQuery?.text).toContain("missing_at = NULL");
    expect(upsertQuery?.text).toContain("size_bytes = EXCLUDED.size_bytes");
    expect(upsertQuery?.text).not.toContain("title = EXCLUDED.title");
    expect(upsertQuery?.text).not.toContain("primary_artist_name = EXCLUDED.primary_artist_name");
    expect(upsertQuery?.text).not.toContain("artist_names = EXCLUDED.artist_names");
    expect(upsertQuery?.text).not.toContain("style_tags = EXCLUDED.style_tags");
    expect(upsertQuery?.text).not.toContain("parse_strategy = EXCLUDED.parse_strategy");
    expect(upsertQuery?.text).not.toContain("technical_status = EXCLUDED.technical_status");
    expect(upsertQuery?.text).not.toContain("technical_metadata = EXCLUDED.technical_metadata");
  });

  it("updates normalized title when overwriting existing song metadata", async () => {
    const db = createRecordingDb();

    await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      drafts: [createDraft({ filePath: "/media/existing.mkv" })],
      preserveExisting: false
    });

    const upsertQuery = db.queries.find((query) => query.text.includes("ON CONFLICT (file_path)"));
    expect(upsertQuery?.text).toContain("title = EXCLUDED.title");
    expect(upsertQuery?.text).toContain("normalized_title = EXCLUDED.normalized_title");
  });
});

function createDraft(overrides: Partial<KtvIndexAssetDraft> = {}): KtvIndexAssetDraft {
  return {
    title: "七里香",
    normalizedTitle: "七里香",
    titlePinyin: "qilixiang",
    titleInitials: "qlx",
    artistNames: ["周杰伦"],
    filePath: "/media/周杰伦-七里香-国语-流行.mkv",
    relativePath: "周杰伦-七里香-国语-流行.mkv",
    fileName: "周杰伦-七里香-国语-流行.mkv",
    extension: ".mkv",
    sizeBytes: null,
    mtimeMs: null,
    parseStrategy: "filename",
    parseConfidence: 0.98,
    technicalStatus: "pending",
    technicalMetadata: {},
    ...overrides
  };
}

function createRecordingDb(): QueryExecutor & { queries: Array<{ text: string; values: readonly unknown[] }> } {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  let idCounter = 0;
  const db: QueryExecutor & { queries: Array<{ text: string; values: readonly unknown[] }> } = {
    queries,
    async query<TRow>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("count(*)::int AS count")) {
        return { rows: [{ count: 3 }] as TRow[] };
      }
      if (text.includes("RETURNING id")) {
        idCounter += 1;
        return { rows: [{ id: `id-${idCounter}` }] as TRow[] };
      }
      return { rows: [] as TRow[] };
    }
  };
  return db;
}
