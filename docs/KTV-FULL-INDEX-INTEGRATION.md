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
- `ktv_song_style_tags.tag_name`
- `ktv_song_style_tags.tag_group`

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
  st.tag_name as style_tag,
  st.tag_group as style_group,
  a.id as asset_id,
  a.file_path
from ktv_song_style_tags st
join ktv_songs s on s.id = st.song_id
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and st.tag_name = $1
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

当前不再保留风格字典表或独立运行态表。风格标签只写入 `ktv_song_style_tags(song_id, tag_name, tag_group)`，一首歌多个标签就写多行。

低覆盖补标签使用独立 Python runner。它会先把结果写到 JSONL 和 state 文件，再统一导入数据库：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py run \
  --max-existing-tags 1 \
  --batch-size 30 \
  --output runtime/tagging/llm/llm-style-tags.jsonl

python3 scripts/tools/run_style_tagging_llm_batch.py import \
  --output runtime/tagging/llm/llm-style-tags.jsonl \
  --dry-run

python3 scripts/tools/run_style_tagging_llm_batch.py import \
  --output runtime/tagging/llm/llm-style-tags.jsonl \
  --apply
```

如果在 Docker 里跑，把命令改成：

```bash
docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py run --max-existing-tags 1 --batch-size 30
```

`status` 子命令可以查看候选数量、输出文件和 state 摘要。标签回填不影响搜索、队列或播放。
