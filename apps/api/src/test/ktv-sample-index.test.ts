import { describe, expect, it } from "vitest";
import {
  buildKtvSampleReportMarkdown,
  buildKtvSampleRow,
  inferKtvSampleMetadata,
  pickRandomSample
} from "../modules/ingest/ktv-sample-index.js";

describe("ktv sample index helpers", () => {
  it("uses filename metadata and genre as the category", () => {
    const result = inferKtvSampleMetadata(
      "流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv"
    );

    expect(result).toMatchObject({
      title: "七里香",
      artistName: "周杰伦",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("marks unexpected filenames as low-confidence path metadata", () => {
    const result = inferKtvSampleMetadata(
      "国语-知名歌星专辑 11000首850G/张学友/吻别/video.mkv"
    );

    expect(result).toMatchObject({
      title: "吻别",
      artistName: "张学友",
      category: "国语-知名歌星专辑 11000首850G",
      parseStrategy: "path"
    });
    expect(result.parseConfidence).toBeLessThan(0.75);
  });

  it("parses tail language/category markers without storing language as a field", () => {
    const result = inferKtvSampleMetadata(
      "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv"
    );

    expect(result).toMatchObject({
      title: "练舞功",
      artistName: "谢金燕",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("keeps hyphenated title parts before the tail language/category markers", () => {
    const result = inferKtvSampleMetadata(
      "流行歌曲(2.5万首880G)/推荐0067/沈美娟-孟丽君-见书房寂寂无声好清净(MTV)-国语-戏曲.mkv"
    );

    expect(result).toMatchObject({
      title: "孟丽君-见书房寂寂无声好清净",
      artistName: "沈美娟",
      category: "戏曲",
      parseStrategy: "filename"
    });
  });

  it("uses the kugou folder rule for dash-delimited files", () => {
    const result = inferKtvSampleMetadata(
      "酷狗排行TOP/陈雪凝-你的酒馆对我打了烊-国语歌曲-流行.mkv"
    );

    expect(result).toMatchObject({
      title: "你的酒馆对我打了烊",
      artistName: "陈雪凝",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("uses directory-level filename profiles for the known first-level roots", () => {
    const cases = [
      {
        relativePath: "流行歌曲/周杰伦-简单爱(MTV)-国语-流行.mkv",
        expected: {
          title: "简单爱",
          artistName: "周杰伦",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "流行精选/冷酷-握不住手中沙-国语-流行.mkv",
        expected: {
          title: "握不住手中沙",
          artistName: "冷酷",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "网络热歌(有新歌加入)/DJ小鱼儿-爱的病变-国语-流行.mkv",
        expected: {
          title: "爱的病变",
          artistName: "DJ小鱼儿",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "本店2026年更新MPG720超清（更新中）/01月/梁静茹-情歌[720P]-国语-流行.mpg",
        expected: {
          title: "情歌[720P]",
          artistName: "梁静茹",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "1080P全高清MPG2026年更新（更新中）/01月MPG1080/F4-第一时间 (Live)[1080P]-国语-合唱.mpg",
        expected: {
          title: "第一时间 (Live)[1080P]",
          artistName: "F4",
          category: "合唱",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "国语-知名歌星专辑 11000首850G/知名歌星个人专辑（65人6600首）/邓丽君151/邓丽君-你的心我的心(人物)-国语-流行.mpg",
        expected: {
          title: "你的心我的心",
          artistName: "邓丽君",
          category: "流行",
          parseStrategy: "filename"
        }
      }
    ] as const;

    for (const testCase of cases) {
      expect(inferKtvSampleMetadata(testCase.relativePath)).toMatchObject(testCase.expected);
    }
  });

  it("keeps variety-show title parentheses for the comprehensive compilation root", () => {
    const result = inferKtvSampleMetadata(
      "综合专辑 9300首1.4T/综艺专区1（2900首）/中国好声音/康树龙-魔鬼中的天使(2018中国好声音)-国语-流行.mpg"
    );

    expect(result).toMatchObject({
      title: "魔鬼中的天使(2018中国好声音)",
      artistName: "康树龙",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("does not support underscore-delimited exception files after cleanup", () => {
    const result = inferKtvSampleMetadata(
      "流行歌曲(2.5万首880G)/推荐0002/毛不易-像我这样的人_国语_流行 .mkv"
    );

    expect(result).toMatchObject({
      parseStrategy: "path"
    });
    expect(result.parseConfidence).toBeLessThan(0.75);
  });

  it("does not support bracketed exception files after cleanup", () => {
    const result = inferKtvSampleMetadata(
      "流行歌曲(2.5万首880G)/推荐0002/大庆小芳-敖包相恋[国语][流行].MKV"
    );

    expect(result).toMatchObject({
      parseStrategy: "path"
    });
    expect(result.parseConfidence).toBeLessThan(0.75);
  });

  it("returns unique random samples", () => {
    const result = pickRandomSample(["a", "b", "c", "d"], 2, () => 0);

    expect(result).toHaveLength(2);
    expect(new Set(result).size).toBe(2);
  });

  it("builds a sample row from the source path", () => {
    const row = buildKtvSampleRow({
      sourcePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
      sizeBytes: 123,
      mtimeMs: 456
    });

    expect(row).toMatchObject({
      sourcePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
      title: "七里香",
      artistName: "周杰伦",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("builds a markdown report with the sampled rows", () => {
    const report = buildKtvSampleReportMarkdown({
      sourceRoot: "/mnt/nas/KTV歌曲",
      sshHost: "lxc-nas",
      totalFiles: 34513,
      sampleSize: 200,
      rows: [
        buildKtvSampleRow({
          sourcePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
          relativePath: "流行歌曲(2.5万首880G)/周杰伦/七里香/周杰伦-七里香-国语-流行.mkv",
          sizeBytes: 123,
          mtimeMs: 456
        })
      ]
    });

    expect(report).toContain("lxc-nas");
    expect(report).toContain("34,513");
    expect(report).toContain("七里香");
    expect(report).toContain("周杰伦");
  });
});
