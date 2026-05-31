import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { NasPlayableMediaRepository } from "../modules/media/nas-playable-media-repository.js";

describe("NasPlayableMediaRepository", () => {
  it("resolves a NAS asset with song metadata, playback profile, and inferred track roles", async () => {
    const db = new RecordingDb([
      createNasAssetRow({
        id: "ktv-asset-1",
        song_id: "ktv-asset-1",
        title: "晴天",
        primary_artist_name: "周杰伦",
        file_name: "晴天.mkv",
        file_path: "/nas/晴天.mkv",
        technical_metadata: {
          mediaInfoSummary: {
            container: "matroska,webm",
            durationMs: 241000,
            videoCodec: "h264",
            resolution: { width: 1920, height: 1080 },
            fileSizeBytes: 123456,
            audioTracks: [
              { index: 0, id: "0x1100", label: "Original vocal", language: "chi", codec: "aac", channels: 2 },
              { index: 1, id: "0x1101", label: "Instrumental", language: "chi", codec: "aac", channels: 2 }
            ]
          },
          mediaInfoProvenance: {
            source: "ffprobe",
            sourceVersion: "7.0",
            probedAt: "2026-05-01T10:00:00.000Z",
            importedFrom: "/nas/晴天.mkv"
          }
        }
      })
    ]);

    const repository = new NasPlayableMediaRepository(db);
    const asset = await repository.findPlayableBySource({ sourceType: "nas", assetId: "ktv-asset-1" });

    expect(db.queries[0]).toContain("FROM ktv_songs");
    expect(db.queries[0]).not.toContain("ktv_song_assets");
    expect(asset).toMatchObject({
      sourceType: "nas",
      songId: "ktv-asset-1",
      assetId: "ktv-asset-1",
      title: "晴天",
      artistName: "周杰伦",
      displayName: "晴天.mkv",
      filePath: "/nas/晴天.mkv",
      status: "ready",
      durationMs: 241000,
      compatibilityStatus: "playable",
      playbackProfile: {
        kind: "single_file_audio_tracks",
        container: "matroska,webm",
        videoCodec: "h264",
        audioCodecs: ["aac"],
        requiresAudioTrackSelection: true
      },
      trackRoles: {
        original: { index: 0, id: "0x1100", label: "Original vocal" },
        instrumental: { index: 1, id: "0x1101", label: "Instrumental" }
      }
    });
  });

  it("does not resolve missing NAS assets", async () => {
    const db = new RecordingDb([
      createNasAssetRow({
        id: "ktv-asset-missing",
        missing_at: new Date("2026-05-01T10:00:00.000Z")
      })
    ]);
    const repository = new NasPlayableMediaRepository(db);

    await expect(repository.findPlayableBySource({ sourceType: "nas", assetId: "ktv-asset-missing" })).resolves.toBeNull();
  });

  it("marks NAS assets without audio tracks unavailable", async () => {
    const db = new RecordingDb([
      createNasAssetRow({
        id: "ktv-asset-no-audio",
        technical_metadata: {
          mediaInfoSummary: {
            container: "matroska,webm",
            durationMs: 1000,
            videoCodec: "h264",
            resolution: null,
            fileSizeBytes: 100,
            audioTracks: []
          }
        }
      })
    ]);
    const repository = new NasPlayableMediaRepository(db);

    const asset = await repository.findPlayableBySource({ sourceType: "nas", assetId: "ktv-asset-no-audio" });

    expect(asset).toMatchObject({
      status: "unavailable",
      compatibilityStatus: "unsupported",
      compatibilityReasons: [
        {
          code: "missing-audio-tracks",
          severity: "error",
          source: "probe"
        }
      ],
      playbackProfile: {
        kind: "single_file_audio_tracks",
        requiresAudioTrackSelection: false
      }
    });
  });

  it("does not claim online playback support from the NAS repository", async () => {
    const db = new RecordingDb([]);
    const repository = new NasPlayableMediaRepository(db);

    await expect(repository.findPlayableBySource({ sourceType: "online", assetId: "online-asset-1" })).resolves.toBeNull();
    expect(db.queries).toHaveLength(0);
  });
});

class RecordingDb implements QueryExecutor {
  readonly queries: string[] = [];
  readonly values: (readonly unknown[] | undefined)[] = [];

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async query<TRow>(text: string, values?: readonly unknown[]) {
    this.queries.push(text);
    this.values.push(values);
    return { rows: this.rows as TRow[] };
  }
}

function createNasAssetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { id, asset_id: assetId, ...rest } = overrides;
  return {
    song_id: "ktv-song-1",
    file_path: "/nas/default.mkv",
    file_name: "default.mkv",
    extension: ".mkv",
    size_bytes: 123,
    technical_status: "probed",
    technical_metadata: {},
    missing_at: null,
    title: "默认歌曲",
    primary_artist_name: "默认歌手",
    ...rest,
    asset_id: assetId ?? id ?? "ktv-asset-1"
  };
}
