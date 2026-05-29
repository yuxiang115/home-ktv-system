import type { QueryExecutor } from "../../db/query-executor.js";
import {
  isAllowedKtvStyleTag,
  ktvStyleTagId,
  ktvStyleTaxonomy,
  normalizeKtvStyleTagName
} from "./style-taxonomy.js";
import type { KtvStyleTaggerResult } from "./netease-style-tagger.js";

export interface KtvStyleTaggingSong {
  id: string;
  title: string;
  artistName: string;
}

export interface KtvStyleTagger {
  tagSong(song: KtvStyleTaggingSong): Promise<KtvStyleTaggerResult>;
}

export interface KtvBatchStyleTagger extends KtvStyleTagger {
  tagSongs(songs: readonly KtvStyleTaggingSong[]): Promise<ReadonlyMap<string, KtvStyleTaggerResult>>;
}

export interface KtvStyleTaggingRunInput {
  source: string;
  limit: number;
  apply: boolean;
  onlyMissing: boolean;
  batch?: boolean;
  maxExistingTags?: number;
  requiredStatusSource?: string;
  onProgress?: (event: KtvStyleTaggingProgressEvent) => void;
}

export interface KtvStyleTaggingProgressEvent {
  selected: number;
  processed: number;
  title: string;
  artistName: string;
  status: "tagged" | "empty" | "failed";
  tagCount: number;
  elapsedMs: number;
  errorMessage: string | null;
}

export interface KtvStyleTaggingRunResult {
  runId: string | null;
  selected: number;
  processed: number;
  taggedSongs: number;
  emptySongs: number;
  failedSongs: number;
  writtenTags: number;
  averageTags: number;
  elapsedMs: number;
}

interface KtvStyleTaggingServiceOptions {
  tagger: KtvStyleTagger;
  now?: () => number;
}

interface KtvSongRow {
  id: string;
  title: string;
  primary_artist_name: string;
}

interface IdRow {
  id: string;
}

export class KtvStyleTaggingService {
  constructor(
    private readonly db: QueryExecutor,
    private readonly options: KtvStyleTaggingServiceOptions
  ) {}

  async run(input: KtvStyleTaggingRunInput): Promise<KtvStyleTaggingRunResult> {
    const startedAt = this.now();
    const songs = await this.selectSongs(input);
    const runId = input.apply ? await this.startRun(input, songs.length) : null;
    let taggedSongs = 0;
    let emptySongs = 0;
    let failedSongs = 0;
    let writtenTags = 0;
    let totalTags = 0;
    let processed = 0;

    if (input.apply) {
      await this.ensureTaxonomy();
    }

    if (input.batch) {
      const batchResult = await this.runBatch(input, songs, runId, startedAt);
      if (input.apply && runId) {
        await this.finishRun(runId, batchResult);
      }
      return batchResult;
    }

    for (const row of songs) {
      const song: KtvStyleTaggingSong = {
        id: row.id,
        title: row.title,
        artistName: row.primary_artist_name
      };
      try {
        const result = await this.options.tagger.tagSong(song);
        const tags = result.tags.filter((tag) => isAllowedKtvStyleTag(tag.tag));
        totalTags += tags.length;
        processed += 1;

        if (tags.length === 0) {
          emptySongs += 1;
          if (input.apply) {
            await this.replaceSongTags(song.id, input.source, []);
            await this.upsertStatus({ songId: song.id, source: input.source, status: "empty", tagCount: 0, runId });
          }
          input.onProgress?.({
            selected: songs.length,
            processed,
            title: song.title,
            artistName: song.artistName,
            status: "empty",
            tagCount: 0,
            elapsedMs: this.now() - startedAt,
            errorMessage: null
          });
          continue;
        }

        taggedSongs += 1;
        if (input.apply) {
          await this.replaceSongTags(song.id, input.source, tags);
          await this.upsertStatus({
            songId: song.id,
            source: input.source,
            status: "tagged",
            tagCount: tags.length,
            confidence: average(tags.map((tag) => tag.confidence)),
            runId
          });
          writtenTags += tags.length;
        }
        input.onProgress?.({
          selected: songs.length,
          processed,
          title: song.title,
          artistName: song.artistName,
          status: "tagged",
          tagCount: tags.length,
          elapsedMs: this.now() - startedAt,
          errorMessage: null
        });
      } catch (error) {
        processed += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedSongs += 1;
        if (input.apply) {
          await this.upsertStatus({
            songId: song.id,
            source: input.source,
            status: "failed",
            tagCount: 0,
            runId,
            errorMessage
          });
        }
        input.onProgress?.({
          selected: songs.length,
          processed,
          title: song.title,
          artistName: song.artistName,
          status: "failed",
          tagCount: 0,
          elapsedMs: this.now() - startedAt,
          errorMessage
        });
      }
    }

    const result: KtvStyleTaggingRunResult = {
      runId,
      selected: songs.length,
      processed: songs.length,
      taggedSongs,
      emptySongs,
      failedSongs,
      writtenTags,
      averageTags: taggedSongs > 0 ? Math.round((totalTags / taggedSongs) * 1000) / 1000 : 0,
      elapsedMs: this.now() - startedAt
    };

    if (input.apply && runId) {
      await this.finishRun(runId, result);
    }

    return result;
  }

  private async runBatch(
    input: KtvStyleTaggingRunInput,
    rows: readonly KtvSongRow[],
    runId: string | null,
    startedAt: number
  ): Promise<KtvStyleTaggingRunResult> {
    const tagger = asBatchTagger(this.options.tagger);
    const songs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      artistName: row.primary_artist_name
    }));
    const batchResults = await tagger.tagSongs(songs);
    let taggedSongs = 0;
    let emptySongs = 0;
    let writtenTags = 0;
    let totalTags = 0;
    let processed = 0;

    for (const song of songs) {
      const result = batchResults.get(song.id);
      if (!result) {
        throw new Error(`Batch tagger did not return song id ${song.id}`);
      }
      const tags = result.tags.filter((tag) => isAllowedKtvStyleTag(tag.tag));
      totalTags += tags.length;
      processed += 1;

      if (tags.length === 0) {
        emptySongs += 1;
        if (input.apply) {
          await this.replaceSongTags(song.id, input.source, []);
          await this.upsertStatus({ songId: song.id, source: input.source, status: "empty", tagCount: 0, runId });
        }
        input.onProgress?.({
          selected: songs.length,
          processed,
          title: song.title,
          artistName: song.artistName,
          status: "empty",
          tagCount: 0,
          elapsedMs: this.now() - startedAt,
          errorMessage: null
        });
        continue;
      }

      taggedSongs += 1;
      if (input.apply) {
        await this.replaceSongTags(song.id, input.source, tags);
        await this.upsertStatus({
          songId: song.id,
          source: input.source,
          status: "tagged",
          tagCount: tags.length,
          confidence: average(tags.map((tag) => tag.confidence)),
          runId
        });
        writtenTags += tags.length;
      }
      input.onProgress?.({
        selected: songs.length,
        processed,
        title: song.title,
        artistName: song.artistName,
        status: "tagged",
        tagCount: tags.length,
        elapsedMs: this.now() - startedAt,
        errorMessage: null
      });
    }

    return {
      runId,
      selected: songs.length,
      processed: songs.length,
      taggedSongs,
      emptySongs,
      failedSongs: 0,
      writtenTags,
      averageTags: taggedSongs > 0 ? Math.round((totalTags / taggedSongs) * 1000) / 1000 : 0,
      elapsedMs: this.now() - startedAt
    };
  }

  private async selectSongs(input: KtvStyleTaggingRunInput): Promise<KtvSongRow[]> {
    if (input.maxExistingTags !== undefined) {
      const requiredStatusJoin = input.requiredStatusSource
        ? `JOIN ktv_song_tagging_status base_status
           ON base_status.song_id = s.id
          AND base_status.source = $5
          AND base_status.status IN ('tagged', 'empty', 'failed')`
        : "";
      const values = input.requiredStatusSource
        ? [input.source, input.onlyMissing, input.limit, input.maxExistingTags, input.requiredStatusSource]
        : [input.source, input.onlyMissing, input.limit, input.maxExistingTags];
      const result = await this.db.query<KtvSongRow>(
        `WITH existing_tags AS (
           SELECT s.id AS song_id,
                  count(DISTINCT st.tag_id)::integer AS tag_count
           FROM ktv_songs s
           LEFT JOIN ktv_song_style_tags st ON st.song_id = s.id
           GROUP BY s.id
         )
         SELECT s.id, s.title, s.primary_artist_name
         FROM ktv_songs s
         JOIN ktv_song_assets a ON a.song_id = s.id AND a.missing_at IS NULL
         ${requiredStatusJoin}
         JOIN existing_tags ON existing_tags.song_id = s.id
         LEFT JOIN ktv_song_tagging_status status
           ON status.song_id = s.id AND status.source = $1
         WHERE ($2::boolean = false OR status.song_id IS NULL OR NOT (status.status = 'tagged'))
           AND existing_tags.tag_count <= $4
         GROUP BY s.id, s.title, s.primary_artist_name, s.updated_at, existing_tags.tag_count
         ORDER BY existing_tags.tag_count ASC, s.updated_at DESC, s.id ASC
         LIMIT $3`,
        values
      );
      return result.rows;
    }

    const result = await this.db.query<KtvSongRow>(
      `SELECT s.id, s.title, s.primary_artist_name
       FROM ktv_songs s
       JOIN ktv_song_assets a ON a.song_id = s.id AND a.missing_at IS NULL
       LEFT JOIN ktv_song_tagging_status status
         ON status.song_id = s.id AND status.source = $1
       WHERE $2::boolean = false
          OR status.song_id IS NULL
          OR status.status IN ('pending', 'empty', 'failed')
       GROUP BY s.id, s.title, s.primary_artist_name, s.updated_at
       ORDER BY s.updated_at DESC, s.id ASC
       LIMIT $3`,
      [input.source, input.onlyMissing, input.limit]
    );
    return result.rows;
  }

  private async startRun(input: KtvStyleTaggingRunInput, selectedCount: number): Promise<string> {
    const result = await this.db.query<IdRow>(
      `INSERT INTO ktv_song_tagging_runs (source, selected_count, options)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [
        input.source,
        selectedCount,
        JSON.stringify({
          apply: input.apply,
          batch: input.batch ?? false,
          onlyMissing: input.onlyMissing,
          limit: input.limit,
          maxExistingTags: input.maxExistingTags ?? null,
          requiredStatusSource: input.requiredStatusSource ?? null
        })
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("ktv_song_tagging_runs insert did not return id");
    }
    return row.id;
  }

  private async ensureTaxonomy(): Promise<void> {
    for (const group of ktvStyleTaxonomy) {
      await this.db.query(
        `INSERT INTO ktv_style_groups (id, name, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (name)
         DO UPDATE SET sort_order = EXCLUDED.sort_order,
                       enabled = true,
                       updated_at = now()`,
        [group.id, group.name, group.sortOrder]
      );
      for (let index = 0; index < group.tags.length; index += 1) {
        const tag = group.tags[index]!;
        await this.db.query(
          `INSERT INTO ktv_style_tags (group_id, id, name, normalized_name, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (normalized_name)
           DO UPDATE SET group_id = EXCLUDED.group_id,
                         name = EXCLUDED.name,
                         sort_order = EXCLUDED.sort_order,
                         enabled = true,
                         updated_at = now()`,
          [group.id, ktvStyleTagId(tag), tag, normalizeKtvStyleTagName(tag), index + 1]
        );
      }
    }
  }

  private async replaceSongTags(
    songId: string,
    source: string,
    tags: KtvStyleTaggerResult["tags"]
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM ktv_song_style_tags
       WHERE song_id = $1
         AND source = $2
         AND locked = false`,
      [songId, source]
    );

    for (const tag of tags) {
      await this.db.query(
        `INSERT INTO ktv_song_style_tags (song_id, tag_id, source, confidence, evidence)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (song_id, tag_id, source)
         DO UPDATE SET confidence = EXCLUDED.confidence,
                       evidence = EXCLUDED.evidence,
                       updated_at = now()`,
        [
          songId,
          ktvStyleTagId(tag.tag),
          source,
          clampConfidence(tag.confidence),
          JSON.stringify({ tag: tag.tag, evidence: tag.evidence })
        ]
      );
    }
  }

  private async upsertStatus(input: {
    songId: string;
    source: string;
    status: "tagged" | "empty" | "failed";
    tagCount: number;
    runId: string | null;
    confidence?: number | undefined;
    errorMessage?: string | undefined;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ktv_song_tagging_status (
         song_id, source, status, tag_count, confidence, run_id, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (song_id, source)
       DO UPDATE SET status = EXCLUDED.status,
                     tag_count = EXCLUDED.tag_count,
                     confidence = EXCLUDED.confidence,
                     run_id = EXCLUDED.run_id,
                     error_message = EXCLUDED.error_message,
                     updated_at = now()`,
      [
        input.songId,
        input.source,
        input.status,
        input.tagCount,
        input.confidence ?? null,
        input.runId,
        input.errorMessage ?? null
      ]
    );
  }

  private async finishRun(runId: string, result: KtvStyleTaggingRunResult): Promise<void> {
    await this.db.query(
      `UPDATE ktv_song_tagging_runs
       SET status = 'completed',
           processed_count = $2,
           tagged_count = $3,
           empty_count = $4,
           failed_count = $5,
           average_tags = $6,
           summary = $7::jsonb,
           finished_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [
        runId,
        result.processed,
        result.taggedSongs,
        result.emptySongs,
        result.failedSongs,
        result.averageTags,
        JSON.stringify(result)
      ]
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function asBatchTagger(tagger: KtvStyleTagger): KtvBatchStyleTagger {
  if ("tagSongs" in tagger && typeof tagger.tagSongs === "function") {
    return tagger as KtvBatchStyleTagger;
  }
  throw new Error("Batch tagging requires a tagger that implements tagSongs");
}
