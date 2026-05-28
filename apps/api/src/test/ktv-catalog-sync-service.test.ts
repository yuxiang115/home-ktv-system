import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../db/schema.js";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  KtvCatalogSyncError,
  PgKtvCatalogSyncService
} from "../modules/catalog/ktv-catalog-sync-service.js";

const sourceIdentityMigrationUrl = new URL(
  "../db/migrations/0010_ktv_catalog_sync_source_identity.sql",
  import.meta.url
);

describe("KTV catalog sync source identity schema", () => {
  it("adds a partial unique source_records identity for KTV indexed assets", async () => {
    const migrationSql = await readFile(sourceIdentityMigrationUrl, "utf8");

    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain("source_records_ktv_index_asset_uq");
      expect(sql).toContain("provider = 'ktv-index'");
      expect(sql).toContain("WHERE provider = 'ktv-index' AND provider_item_id IS NOT NULL");
    }
  });
});

describe("PgKtvCatalogSyncService", () => {
  it("idempotently syncs one indexed asset into canonical song asset and source record rows", async () => {
    const db = new FakeKtvCatalogSyncDb();
    const service = new PgKtvCatalogSyncService(db, { checkFileAccess: false });

    const first = await service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" });
    const second = await service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" });

    expect(first).toMatchObject({
      songId: "song-ktv-ktv-song-1",
      assetId: "asset-ktv-ktv-asset-1",
      indexedSongId: "ktv-song-1",
      indexedAssetId: "ktv-asset-1",
      sourceRecordId: "source-ktv-index-asset-ktv-asset-1",
      status: "created"
    });
    expect(second).toMatchObject({
      songId: first.songId,
      assetId: first.assetId,
      sourceRecordId: first.sourceRecordId,
      status: "updated"
    });
    expect(db.sourceRecords).toHaveLength(1);
    expect(db.songs.get("song-ktv-ktv-song-1")).toMatchObject({
      title: "七里香",
      artistName: "周杰伦",
      genre: ["流行"],
      tags: ["ktv-index"],
      defaultAssetId: "asset-ktv-ktv-asset-1"
    });
    expect(db.assets.get("asset-ktv-ktv-asset-1")).toMatchObject({
      songId: "song-ktv-ktv-song-1",
      displayName: "周杰伦-七里香-国语-流行.mkv",
      filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
      mediaInfoSummary: expect.objectContaining({ fileSizeBytes: 123456 }),
      mediaInfoProvenance: expect.objectContaining({ importedFrom: "ktv-index" }),
      playbackProfile: expect.objectContaining({ kind: "single_file_audio_tracks" })
    });
    expect(db.sourceRecords[0]).toMatchObject({
      id: "source-ktv-index-asset-ktv-asset-1",
      assetId: "asset-ktv-ktv-asset-1",
      provider: "ktv-index",
      providerItemId: "ktv-asset-1",
      sourceUri: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
      rawMeta: expect.objectContaining({
        indexedSongId: "ktv-song-1",
        indexedAssetId: "ktv-asset-1",
        filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
        relativePath: "周杰伦/七里香.mkv",
        title: "七里香",
        primaryArtistName: "周杰伦",
        styleTags: ["流行"],
        extension: ".mkv",
        sizeBytes: 123456,
        parseConfidence: 0.98
      })
    });
  });

  it("maps indexed NAS paths to local readable paths while preserving the raw source metadata", async () => {
    const db = new FakeKtvCatalogSyncDb();
    const accessedPaths: string[] = [];
    const service = new PgKtvCatalogSyncService(db, {
      pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: "/Volumes/nas/KTV歌曲" }],
      accessFile: async (filePath) => {
        accessedPaths.push(filePath);
      }
    });

    await service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" });

    expect(accessedPaths).toEqual(["/Volumes/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv"]);
    expect(db.assets.get("asset-ktv-ktv-asset-1")).toMatchObject({
      filePath: "/Volumes/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv"
    });
    expect(db.sourceRecords[0]).toMatchObject({
      sourceUri: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
      rawMeta: expect.objectContaining({
        filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv"
      })
    });
  });

  it("writes preprocessed web media metadata when an indexed asset needs a playback copy", async () => {
    const db = new FakeKtvCatalogSyncDb();
    const prepareCalls: Array<Record<string, unknown>> = [];
    const service = new PgKtvCatalogSyncService(db, {
      checkFileAccess: false,
      pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: "/Volumes/nas/KTV歌曲" }],
      prepareMedia: async (input: Record<string, unknown>) => {
        prepareCalls.push(input);
        return {
          filePath: "/media-root/generated/ktv-index/ktv-asset-1.mp4",
          durationMs: 222_388,
          compatibilityStatus: "playable",
          compatibilityReasons: [],
          mediaInfoSummary: {
            container: "mov,mp4,m4a,3gp,3g2,mj2",
            durationMs: 222_388,
            videoCodec: "h264",
            resolution: { width: 720, height: 480 },
            fileSizeBytes: 12_345_678,
            audioTracks: [
              { index: 1, id: "stream-1", label: "Audio 1", language: null, codec: "aac", channels: 2 },
              { index: 2, id: "stream-2", label: "Audio 2", language: null, codec: "aac", channels: 2 }
            ]
          },
          mediaInfoProvenance: {
            source: "ffprobe",
            sourceVersion: null,
            probedAt: "2026-05-20T14:30:00.000Z",
            importedFrom: "/Volumes/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv"
          },
          trackRoles: {
            original: { index: 1, id: "stream-1", label: "Audio 1" },
            instrumental: { index: 2, id: "stream-2", label: "Audio 2" }
          },
          playbackProfile: {
            kind: "single_file_audio_tracks",
            container: "mov,mp4,m4a,3gp,3g2,mj2",
            videoCodec: "h264",
            audioCodecs: ["aac"],
            requiresAudioTrackSelection: true
          }
        };
      }
    });

    await service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" });

    expect(prepareCalls).toEqual([
      expect.objectContaining({
        indexedAssetId: "ktv-asset-1",
        sourceFilePath: "/Volumes/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv"
      })
    ]);
    expect(db.assets.get("asset-ktv-ktv-asset-1")).toMatchObject({
      filePath: "/media-root/generated/ktv-index/ktv-asset-1.mp4",
      mediaInfoSummary: expect.objectContaining({
        durationMs: 222_388,
        audioTracks: [
          expect.objectContaining({ codec: "aac" }),
          expect.objectContaining({ codec: "aac" })
        ]
      }),
      trackRoles: {
        original: { index: 1, id: "stream-1", label: "Audio 1" },
        instrumental: { index: 2, id: "stream-2", label: "Audio 2" }
      },
      playbackProfile: expect.objectContaining({
        audioCodecs: ["aac"],
        requiresAudioTrackSelection: true
      })
    });
  });

  it("rejects missing or stale indexed assets with a stable Chinese error", async () => {
    const service = new PgKtvCatalogSyncService(new FakeKtvCatalogSyncDb({ missingAt: new Date("2026-05-20T00:00:00Z") }), {
      checkFileAccess: false
    });

    await expect(service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" })).rejects.toMatchObject({
      code: "KTV_INDEX_ASSET_STALE",
      message: "索引已失效"
    });

    await expect(
      new PgKtvCatalogSyncService(new FakeKtvCatalogSyncDb({ rows: [] }), { checkFileAccess: false }).syncIndexedAsset({
        indexedAssetId: "missing"
      })
    ).rejects.toMatchObject({
      code: "KTV_INDEX_ASSET_STALE",
      message: "索引已失效"
    });
  });

  it("rejects unreadable indexed file paths before writing canonical rows", async () => {
    const db = new FakeKtvCatalogSyncDb();
    const service = new PgKtvCatalogSyncService(db, {
      accessFile: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
    });

    await expect(service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" })).rejects.toMatchObject({
      code: "KTV_INDEX_FILE_UNREADABLE",
      message: "文件不可读"
    });
    expect(db.songs.size).toBe(0);
    expect(db.assets.size).toBe(0);
    expect(db.sourceRecords).toHaveLength(0);
  });

  it("does not leave asset or source records behind when a later write fails", async () => {
    const db = new FakeKtvCatalogSyncDb({ failOnAssetInsert: true });
    const service = new PgKtvCatalogSyncService(db, { checkFileAccess: false });

    await expect(service.syncIndexedAsset({ indexedAssetId: "ktv-asset-1" })).rejects.toBeInstanceOf(KtvCatalogSyncError);
    expect(db.assets.size).toBe(0);
    expect(db.sourceRecords).toHaveLength(0);
  });
});

interface FakeIndexedAssetRow {
  id: string;
  song_id: string;
  file_path: string;
  relative_path: string;
  file_name: string;
  extension: string;
  size_bytes: number | string | null;
  parse_confidence: number | string;
  missing_at: Date | null;
  title: string;
  primary_artist_name: string;
  style_tags: string[] | null;
  source_root: string | null;
}

class FakeKtvCatalogSyncDb implements QueryExecutor {
  readonly songs = new Map<string, Record<string, unknown>>();
  readonly assets = new Map<string, Record<string, unknown>>();
  readonly sourceRecords: Array<Record<string, unknown>> = [];
  private readonly rows: FakeIndexedAssetRow[];
  private readonly failOnAssetInsert: boolean;

  constructor(input: { rows?: FakeIndexedAssetRow[]; missingAt?: Date | null; failOnAssetInsert?: boolean } = {}) {
    this.rows = input.rows ?? [createIndexedAssetRow({ missing_at: input.missingAt ?? null })];
    this.failOnAssetInsert = input.failOnAssetInsert ?? false;
  }

  async query<TRow>(text: string, values: readonly unknown[] = []) {
    if (text.includes("FROM source_records")) {
      const existing = this.sourceRecords.find((record) => record.providerItemId === values[0]);
      return { rows: existing ? ([{ id: existing.id, asset_id: existing.assetId }] as TRow[]) : [] };
    }

    if (text.includes("FROM ktv_song_assets")) {
      const row = this.rows.find((candidate) => candidate.id === values[0]);
      return { rows: row ? ([row] as TRow[]) : [] };
    }

    if (text.includes("INSERT INTO songs")) {
      this.songs.set(String(values[0]), {
        id: values[0],
        title: values[1],
        normalizedTitle: values[2],
        titlePinyin: values[3],
        titleInitials: values[4],
        artistId: values[5],
        artistName: values[6],
        artistPinyin: values[7],
        artistInitials: values[8],
        genre: values[9],
        tags: ["ktv-index"],
        searchHints: values[10],
        defaultAssetId: null
      });
      return { rows: [] as TRow[] };
    }

    if (text.includes("INSERT INTO assets")) {
      if (this.failOnAssetInsert) {
        throw new Error("asset insert failed");
      }
      this.assets.set(String(values[0]), {
        id: values[0],
        songId: values[1],
        displayName: values[2],
        filePath: values[3],
        durationMs: values[4],
        compatibilityStatus: values[5],
        compatibilityReasons: parseJsonbParam(values[6]),
        mediaInfoSummary: parseJsonbParam(values[7]),
        mediaInfoProvenance: parseJsonbParam(values[8]),
        trackRoles: parseJsonbParam(values[9]),
        playbackProfile: parseJsonbParam(values[10])
      });
      return { rows: [] as TRow[] };
    }

    if (text.includes("INSERT INTO source_records")) {
      const existingIndex = this.sourceRecords.findIndex((record) => record.id === values[0]);
      const record = {
        id: values[0],
        assetId: values[1],
        provider: "ktv-index",
        providerItemId: values[2],
        sourceUri: values[3],
        rawMeta: parseJsonbParam(values[4])
      };
      if (existingIndex >= 0) {
        this.sourceRecords[existingIndex] = record;
      } else {
        this.sourceRecords.push(record);
      }
      return { rows: [] as TRow[] };
    }

    if (text.includes("UPDATE songs") && text.includes("default_asset_id")) {
      const song = this.songs.get(String(values[0]));
      if (song) {
        song.defaultAssetId = values[1];
      }
      return { rows: [] as TRow[] };
    }

    return { rows: [] as TRow[] };
  }
}

function parseJsonbParam(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("jsonb parameters must be serialized before reaching pg");
  }
  return JSON.parse(value);
}

function createIndexedAssetRow(input: Partial<FakeIndexedAssetRow> = {}): FakeIndexedAssetRow {
  return {
    id: "ktv-asset-1",
    song_id: "ktv-song-1",
    file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
    relative_path: "周杰伦/七里香.mkv",
    file_name: "周杰伦-七里香-国语-流行.mkv",
    extension: ".mkv",
    size_bytes: "123456",
    parse_confidence: "0.980",
    missing_at: null,
    title: "七里香",
    primary_artist_name: "周杰伦",
    style_tags: ["流行"],
    source_root: "/mnt/nas/KTV歌曲",
    ...input
  };
}
