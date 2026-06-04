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
        relativePath: "2024/2024-10/TF家族-等你的回答-国语-流行.mkv",
        expected: {
          title: "等你的回答",
          artistName: "TF家族",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2025/2025-10/任素汐_任宥纶-亲爱的你啊-国语-流行.mkv",
        expected: {
          title: "亲爱的你啊",
          artistName: "任素汐_任宥纶",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "经典老歌(1.2万首450G)/经典老歌10/五月天-彩虹(演)-国语-流行歌曲.mkv",
        expected: {
          title: "彩虹",
          artistName: "五月天",
          category: "流行歌曲",
          parseStrategy: "filename"
        }
      },
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

  it("parses 2025 new-year files with parenthesized language markers", () => {
    const cases = [
      {
        relativePath: "2025/2025-11new/新年喜庆歌曲/UNIQ&宇宙少女-新年快乐{HD}(国语).mpg",
        expected: {
          title: "新年快乐{HD}",
          artistName: "UNIQ&宇宙少女",
          category: "新年喜庆歌曲",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2025/2025-11new/新年喜庆歌曲/区瑞强-财神到(粤语)-喜庆歌.mpg",
        expected: {
          title: "财神到",
          artistName: "区瑞强",
          category: "喜庆歌",
          parseStrategy: "filename"
        }
      }
    ] as const;

    for (const testCase of cases) {
      expect(inferKtvSampleMetadata(testCase.relativePath)).toMatchObject(testCase.expected);
    }
  });

  it("parses exception formats from the 2024 root profile", () => {
    const cases = [
      {
        relativePath: "2024/2024-4/如風 - 记住这份缘(原版)国语-流行.mpg",
        expected: {
          title: "记住这份缘",
          artistName: "如風",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2024/2024-6/海来铁子 - 命苦的孩子该走了-彝语-流行.mpg",
        expected: {
          title: "命苦的孩子该走了",
          artistName: "海来铁子",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2024/2024-7/闲也想你忙也想你-国语-流行.mpg",
        expected: {
          title: "闲也想你忙也想你",
          artistName: "Unknown Artist",
          category: "流行",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2024/2024-8/祁隆-雨中的思念_国语_流行.mpg",
        expected: {
          title: "雨中的思念",
          artistName: "祁隆",
          category: "流行",
          parseStrategy: "filename"
        }
      }
    ] as const;

    for (const testCase of cases) {
      expect(inferKtvSampleMetadata(testCase.relativePath)).toMatchObject(testCase.expected);
    }
  });

  it("parses exception formats from the 2025 root profile", () => {
    const cases = [
      {
        relativePath: "2025/2025-11/DJ鬼鬼于航-烟花叹.mkv",
        expected: {
          title: "烟花叹",
          artistName: "DJ鬼鬼于航",
          category: null,
          parseStrategy: "hybrid"
        }
      },
      {
        relativePath: "2025/2025-11/吴欣达&蔡宜汝-金色海岸-闽语-合唱.mkv",
        expected: {
          title: "金色海岸",
          artistName: "吴欣达&蔡宜汝",
          category: "合唱",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2025/2025-11new/新年喜庆歌曲/邓志驹_蒋文端-新年蜜运最成功(MTV)-粤语.mkv",
        expected: {
          title: "新年蜜运最成功",
          artistName: "邓志驹_蒋文端",
          category: "新年喜庆歌曲",
          parseStrategy: "filename"
        }
      },
      {
        relativePath: "2025/2025-8new/文夫-背着风流泪-囯语-流行.mkv",
        expected: {
          title: "背着风流泪",
          artistName: "文夫",
          category: "流行",
          parseStrategy: "filename"
        }
      }
    ] as const;

    for (const testCase of cases) {
      expect(inferKtvSampleMetadata(testCase.relativePath)).toMatchObject(testCase.expected);
    }
  });

  it("strips variety-show title markers for comprehensive compilation variety roots", () => {
    const result = inferKtvSampleMetadata(
      "综合专辑 9300首1.4T/综艺专区1（2900首）/中国好声音/康树龙-魔鬼中的天使(2018中国好声音)-国语-流行.mpg"
    );

    expect(result).toMatchObject({
      title: "魔鬼中的天使",
      artistName: "康树龙",
      category: "流行",
      parseStrategy: "filename"
    });
  });

  it("strips bracketed variety-show title markers from the variety roots", () => {
    const cases = [
      {
        relativePath: "综合专辑 9300首1.4T/综艺专区1（2900首）/不凡的改变/腾格尔-隐形的翅膀[不凡的改变]-国语-流行.mpg",
        title: "隐形的翅膀"
      },
      {
        relativePath: "综合专辑 9300首1.4T/综艺专区2（1000首）/异口同声/李琦-你的样子（异口同声720P）-国语-流行.mpg",
        title: "你的样子"
      },
      {
        relativePath: "综合专辑 9300首1.4T/综艺专区2（1000首）/异口同声/黄龄-傻瓜与傻丫头（异口同声720P）-国语-流行.mpg",
        title: "傻瓜与傻丫头"
      }
    ] as const;

    for (const testCase of cases) {
      expect(inferKtvSampleMetadata(testCase.relativePath)).toMatchObject({
        title: testCase.title,
        category: "流行",
        parseStrategy: "filename"
      });
    }
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
