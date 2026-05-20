import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildWebCompatibleFfmpegArgs,
  prepareKtvIndexedMediaForWeb
} from "../modules/catalog/ktv-index-media-preprocessor.js";
import type { MediaProbeSummary } from "../modules/ingest/media-probe.js";

describe("KTV indexed media preprocessor", () => {
  it("creates a web-compatible AAC MP4 copy for indexed MKV files with MP2 audio", async () => {
    const mediaRoot = await mkdtemp(path.join(tmpdir(), "home-ktv-index-preprocess-"));
    const sourceFilePath = "/Volumes/nas/KTV歌曲/周杰伦-稻香.mkv";
    const sourceProbe = createProbeSummary({
      filePath: sourceFilePath,
      container: "matroska,webm",
      videoCodec: "h264",
      audioCodecs: ["mp2", "mp2"]
    });
    const preparedProbe = createProbeSummary({
      filePath: path.join(mediaRoot, "generated", "ktv-index", "ktv-asset-1.mp4"),
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      videoCodec: "h264",
      audioCodecs: ["aac", "aac"]
    });
    const probeMedia = vi.fn(async (filePath: string) => (
      filePath === sourceFilePath ? sourceProbe : preparedProbe
    ));
    const transcode = vi.fn(async (input: { outputFilePath: string }) => {
      await import("node:fs/promises").then((fs) => fs.writeFile(input.outputFilePath, "mp4"));
    });

    const prepared = await prepareKtvIndexedMediaForWeb({
      indexedAssetId: "ktv-asset-1",
      sourceFilePath,
      mediaRoot
    }, { probeMedia, transcode });

    expect(transcode).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilePath,
      sourceMediaInfo: sourceProbe.mediaInfoSummary
    }));
    expect(prepared.filePath).toBe(path.join(mediaRoot, "generated", "ktv-index", "ktv-asset-1.mp4"));
    await expect(readFile(prepared.filePath, "utf8")).resolves.toBe("mp4");
    expect(prepared.mediaInfoSummary.audioTracks.map((track) => track.codec)).toEqual(["aac", "aac"]);
    expect(prepared.trackRoles).toMatchObject({
      original: { index: 1, id: "stream-1", label: "Audio 1" },
      instrumental: { index: 2, id: "stream-2", label: "Audio 2" }
    });
    expect(prepared.playbackProfile).toMatchObject({
      kind: "single_file_audio_tracks",
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      audioCodecs: ["aac"],
      requiresAudioTrackSelection: true
    });
    expect(prepared.compatibilityStatus).toBe("playable");
  });

  it("uses video stream copy and AAC audio conversion when H264 video is already present", () => {
    const args = buildWebCompatibleFfmpegArgs({
      sourceFilePath: "/media/source.mkv",
      outputFilePath: "/media/output.mp4",
      sourceMediaInfo: createProbeSummary({
        filePath: "/media/source.mkv",
        container: "matroska,webm",
        videoCodec: "h264",
        audioCodecs: ["mp2", "mp2"]
      }).mediaInfoSummary
    });

    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-c:a", "aac"]));
    expect(args).toEqual(expect.arrayContaining(["-map", "0:v:0", "-map", "0:a?"]));
  });
});

function createProbeSummary(input: {
  filePath: string;
  container: string;
  videoCodec: string;
  audioCodecs: readonly string[];
}): MediaProbeSummary {
  return {
    durationMs: 222_388,
    formatName: input.container,
    videoCodec: input.videoCodec,
    audioCodec: input.audioCodecs[0] ?? null,
    width: 720,
    height: 480,
    mediaInfoSummary: {
      container: input.container,
      durationMs: 222_388,
      videoCodec: input.videoCodec,
      resolution: { width: 720, height: 480 },
      fileSizeBytes: 48_806_876,
      audioTracks: input.audioCodecs.map((codec, index) => ({
        index: index + 1,
        id: `stream-${index + 1}`,
        label: `Audio ${index + 1}`,
        language: null,
        codec,
        channels: 2
      }))
    },
    mediaInfoProvenance: {
      source: "ffprobe",
      sourceVersion: null,
      probedAt: "2026-05-20T14:30:00.000Z",
      importedFrom: input.filePath
    },
    raw: {}
  };
}
