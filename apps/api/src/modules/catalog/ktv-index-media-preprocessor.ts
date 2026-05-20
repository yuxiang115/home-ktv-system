import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CompatibilityReason,
  CompatibilityStatus,
  MediaInfoProvenance,
  MediaInfoSummary,
  PlaybackProfile,
  TrackRef,
  TrackRoles
} from "@home-ktv/domain";
import {
  buildSingleFileAudioTrackPlaybackProfile,
  inferTrackRolesFromRealMv
} from "../media/real-mv-compatibility.js";
import { probeMediaFile, type MediaProbeSummary } from "../ingest/media-probe.js";

const execFileAsync = promisify(execFile);

export interface PreparedKtvIndexedMedia {
  filePath: string;
  durationMs: number;
  compatibilityStatus: CompatibilityStatus;
  compatibilityReasons: readonly CompatibilityReason[];
  mediaInfoSummary: MediaInfoSummary;
  mediaInfoProvenance: MediaInfoProvenance;
  trackRoles: TrackRoles;
  playbackProfile: PlaybackProfile;
}

export interface PrepareKtvIndexedMediaInput {
  indexedAssetId: string;
  sourceFilePath: string;
  mediaRoot: string;
}

export interface KtvIndexedMediaPreprocessorDependencies {
  probeMedia?: (filePath: string) => Promise<MediaProbeSummary>;
  transcode?: (input: {
    sourceFilePath: string;
    outputFilePath: string;
    sourceMediaInfo: MediaInfoSummary;
  }) => Promise<void>;
}

export async function prepareKtvIndexedMediaForWeb(
  input: PrepareKtvIndexedMediaInput,
  dependencies: KtvIndexedMediaPreprocessorDependencies = {}
): Promise<PreparedKtvIndexedMedia> {
  const probeMedia = dependencies.probeMedia ?? probeMediaFile;
  const sourceProbe = await probeMedia(input.sourceFilePath);
  const sourceSummary = sourceProbe.mediaInfoSummary;

  if (!needsWebCompatibleCopy(sourceSummary)) {
    return toPreparedMedia({
      filePath: input.sourceFilePath,
      summary: sourceSummary,
      provenance: sourceProbe.mediaInfoProvenance,
      compatibilityReasons: []
    });
  }

  const outputFilePath = webCompatibleOutputPath(input.mediaRoot, input.indexedAssetId);
  if (!(await isReadableFile(outputFilePath))) {
    const tempFilePath = `${outputFilePath}.${process.pid}.${Date.now()}.tmp.mp4`;
    await mkdir(path.dirname(outputFilePath), { recursive: true });
    try {
      await (dependencies.transcode ?? transcodeToWebCompatibleMp4)({
        sourceFilePath: input.sourceFilePath,
        outputFilePath: tempFilePath,
        sourceMediaInfo: sourceSummary
      });
      await rename(tempFilePath, outputFilePath);
    } catch (error) {
      await rm(tempFilePath, { force: true });
      throw error;
    }
  }

  const preparedProbe = await probeMedia(outputFilePath);
  return toPreparedMedia({
    filePath: outputFilePath,
    summary: preparedProbe.mediaInfoSummary,
    provenance: {
      ...preparedProbe.mediaInfoProvenance,
      importedFrom: input.sourceFilePath
    },
    compatibilityReasons: [
      {
        code: "ktv-index-web-compatible-copy",
        severity: "warning",
        message: "KTV indexed media was converted to a web-compatible playback copy",
        source: "scanner"
      }
    ]
  });
}

export function buildWebCompatibleFfmpegArgs(input: {
  sourceFilePath: string;
  outputFilePath: string;
  sourceMediaInfo: MediaInfoSummary;
}): string[] {
  const videoCodec = input.sourceMediaInfo.videoCodec?.toLowerCase() ?? "";
  const videoArgs = videoCodec === "h264" || videoCodec === "hevc" || videoCodec === "h265"
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];

  return [
    "-y",
    "-i",
    input.sourceFilePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    ...videoArgs,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    input.outputFilePath
  ];
}

function needsWebCompatibleCopy(summary: MediaInfoSummary): boolean {
  const container = summary.container?.toLowerCase() ?? "";
  const audioCodecs = summary.audioTracks
    .map((track) => track.codec?.toLowerCase() ?? "")
    .filter(Boolean);
  const videoCodec = summary.videoCodec?.toLowerCase() ?? "";
  const webContainer = container.includes("mp4") || container.includes("webm") || container.includes("quicktime");
  const webVideo =
    videoCodec === "h264" ||
    videoCodec === "hevc" ||
    videoCodec === "h265" ||
    videoCodec === "vp8" ||
    videoCodec === "vp9";
  const webAudio = audioCodecs.length > 0 && audioCodecs.every((codec) => codec === "aac" || codec === "mp3" || codec === "opus");

  return !(webContainer && webVideo && webAudio);
}

async function transcodeToWebCompatibleMp4(input: {
  sourceFilePath: string;
  outputFilePath: string;
  sourceMediaInfo: MediaInfoSummary;
}): Promise<void> {
  await execFileAsync("ffmpeg", buildWebCompatibleFfmpegArgs(input), {
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  });
}

function toPreparedMedia(input: {
  filePath: string;
  summary: MediaInfoSummary;
  provenance: MediaInfoProvenance;
  compatibilityReasons: readonly CompatibilityReason[];
}): PreparedKtvIndexedMedia {
  return {
    filePath: input.filePath,
    durationMs: input.summary.durationMs ?? 0,
    compatibilityStatus: input.summary.audioTracks.length > 0 ? "playable" : "unsupported",
    compatibilityReasons: input.summary.audioTracks.length > 0
      ? input.compatibilityReasons
      : [
          ...input.compatibilityReasons,
          {
            code: "missing-audio-tracks",
            severity: "error",
            message: "No audio tracks were detected",
            source: "probe"
          }
        ],
    mediaInfoSummary: input.summary,
    mediaInfoProvenance: input.provenance,
    trackRoles: inferTrackRolesWithOrderFallback(input.summary),
    playbackProfile: buildSingleFileAudioTrackPlaybackProfile(input.summary)
  };
}

function inferTrackRolesWithOrderFallback(summary: MediaInfoSummary): TrackRoles {
  const inferred = inferTrackRolesFromRealMv({ mediaInfoSummary: summary });
  return {
    original: inferred.original ?? toTrackRef(summary.audioTracks[0]),
    instrumental: inferred.instrumental ?? toTrackRef(summary.audioTracks[1])
  };
}

function toTrackRef(track: MediaInfoSummary["audioTracks"][number] | undefined): TrackRef | null {
  return track ? { index: track.index, id: track.id, label: track.label } : null;
}

function webCompatibleOutputPath(mediaRoot: string, indexedAssetId: string): string {
  const safeAssetId = indexedAssetId.replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return path.resolve(mediaRoot, "generated", "ktv-index", `${safeAssetId}.mp4`);
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
