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
