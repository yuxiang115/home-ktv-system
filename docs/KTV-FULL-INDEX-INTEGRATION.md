# KTV Full Index Integration Guide

## Contract

Application code should query only active assets:

```sql
where ktv_song_assets.missing_at is null
```

Core fields for the KTV system:

- `ktv_songs.id`
- `ktv_songs.title`
- `ktv_songs.primary_artist_name`
- `ktv_song_assets.id`
- `ktv_song_assets.file_path`
- `ktv_song_assets.technical_metadata`
- `ktv_song_style_tags.tag_id`

Do not depend on folder structure for search. Use indexed database fields, then use `file_path` only when handing the selected asset to the player.

The KTV index is an automatic admission path. Active assets are searchable and queueable without Admin approval. Admin can inspect and repair resources, but it is not a review gate.

`ktv_songs.category` has been removed from the durable read model. Category-style browsing should use the style tag tables.

## Query Examples

Find all versions of a song title:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  a.id as asset_id,
  a.file_path,
  a.extension,
  a.size_bytes,
  jsonb_array_length(coalesce(a.technical_metadata->'mediaInfoSummary'->'audioTracks', a.technical_metadata->'audioTracks', '[]'::jsonb)) as audio_track_count
from ktv_songs s
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and s.normalized_title = $1
order by s.primary_artist_name, a.file_path;
```

Find all versions by title and artist:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  a.id as asset_id,
  a.file_path,
  a.size_bytes
from ktv_songs s
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and s.normalized_title = $1
  and s.normalized_primary_artist_name = $2
order by a.file_path;
```

Find all songs by artist:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  a.id as asset_id,
  a.file_path
from ktv_artists ar
join ktv_song_artists sa on sa.artist_id = ar.id
join ktv_songs s on s.id = sa.song_id
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and ar.normalized_name = $1
order by s.title, a.file_path;
```

Find all songs under one style tag:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  t.name as style_tag,
  a.id as asset_id,
  a.file_path
from ktv_style_tags t
join ktv_song_style_tags st on st.tag_id = t.id
join ktv_songs s on s.id = st.song_id
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and t.name = $1
order by s.primary_artist_name, s.title, a.file_path;
```

Fuzzy title search:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  similarity(s.normalized_title, $1) as score
from ktv_songs s
where s.normalized_title % $1
order by score desc, s.title
limit 30;
```

Use `normalizeSearchText()` from `apps/api/src/modules/catalog/search-normalization.ts` before passing title or artist query terms into normalized fields.

## API Shape

Current read APIs are implemented under the API routes for discovery, Admin diagnostics, and queue commands. The important contract is:

- Search results are grouped by song and expose playable assets/versions.
- Queue commands can point at a real KTV index asset.
- Admin diagnostics can inspect raw index metrics and media readability.
- Style browsing should use style tags, not the removed `category` field.

Implementation notes:

- Put SQL in a read-only repository module.
- Always use parameterized queries.
- Always filter `missing_at is null`.
- Return all matching assets first; automatic "best version" selection can be added later after enough playback evidence is collected.
- Expose audio track count when technical metadata is present. Controller UI uses `audioTrackCount = 1` to show the “单音轨歌曲源” label.
- Technical probing is non-blocking. Failed probes should keep resources searchable and queueable; they only leave `audioTrackCount` unknown until a later retry.

## Refreshing The Index

After copying new media into `/mnt/nas/KTV歌曲`, rerun the full index script from the API package or the server deployment wrapper used by the current environment.

The refresh is safe to repeat. Existing rows are updated, new files are inserted, and deleted files are hidden through `missing_at`.

## Probing Technical Metadata

Run a bounded sample first:

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

Then run the full backfill after checking elapsed time and failure rate:

```bash
bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

The probe stores compact `mediaInfoSummary`, `mediaInfoProvenance`, and failure summaries only. Do not persist full ffprobe raw JSON in `technical_metadata`.

## Style Tagging

Run a bounded NetEase sample first:

```bash
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --apply
```

For full-library work, use the JSONL staging flow so tagging can continue while the database is being rebuilt:

```bash
bash deploy/docker/ktv.sh tag-styles-export -- --out /data/home-ktv-media/tagging/full/songs.jsonl
bash deploy/docker/ktv.sh tag-styles-jsonl -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl --source netease --concurrency 5
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --dry-run
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --apply
```

`tag-styles-jsonl` has no database dependency. It skips existing `songKey + source` rows in the result file on resume. Use `--concurrency` for bounded in-process parallelism; start with 5 and check provider failure rate before increasing. Low-coverage songs can be supplemented by the LLM fallback in batches. Tagging failures do not affect search, queueing, or playback.

For server-scale runs, prefer the independent job container:

```bash
bash deploy/docker/ktv.sh tag-styles-job start -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl
bash deploy/docker/ktv.sh tag-styles-job status
bash deploy/docker/ktv.sh tag-styles-job logs
bash deploy/docker/ktv.sh tag-styles-job stats
```

The job uses `home-ktv-style-tags-job` and stores host-side state under `/opt/home-ktv-jobs/style-tagging`, so normal main-service rebuilds do not stop the tagging process.
