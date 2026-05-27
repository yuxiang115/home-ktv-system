# KTV Full Index Integration Guide

## Contract

Application code should query only active assets:

```sql
where ktv_song_assets.missing_at is null
```

Core fields for the KTV system:

- `ktv_songs.title`
- `ktv_songs.primary_artist_name`
- `ktv_songs.category`
- `ktv_song_assets.file_path`
- `ktv_song_assets.technical_metadata`

Do not depend on folder structure for search. Use the indexed database fields, then use `file_path` only when handing the selected asset to the player.

The KTV index is an automatic admission path. Active assets are searchable and queueable without Admin approval. Admin can inspect and repair resources, but it is not a review gate.

## Query Examples

Find all versions of a song title:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  s.category,
  a.id as asset_id,
  a.file_path,
  a.extension,
  a.size_bytes,
  jsonb_array_length(coalesce(a.technical_metadata->'mediaInfoSummary'->'audioTracks', a.technical_metadata->'audioTracks', '[]'::jsonb)) as audio_track_count
from ktv_songs s
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and s.normalized_title = $1
order by s.primary_artist_name, s.category, a.file_path;
```

Find all versions by title and artist:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  s.category,
  a.id as asset_id,
  a.file_path,
  a.size_bytes
from ktv_songs s
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and s.normalized_title = $1
  and s.normalized_primary_artist_name = $2
order by s.category, a.file_path;
```

Find all songs by artist:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  s.category,
  a.id as asset_id,
  a.file_path
from ktv_artists ar
join ktv_song_artists sa on sa.artist_id = ar.id
join ktv_songs s on s.id = sa.song_id
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and ar.normalized_name = $1
order by s.title, s.category, a.file_path;
```

Find all songs in a category:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  s.category,
  a.id as asset_id,
  a.file_path
from ktv_songs s
join ktv_song_assets a on a.song_id = s.id
where a.missing_at is null
  and s.category = $1
order by s.primary_artist_name, s.title, a.file_path;
```

Fuzzy title search:

```sql
select
  s.id as song_id,
  s.title,
  s.primary_artist_name,
  s.category,
  similarity(s.normalized_title, $1) as score
from ktv_songs s
where s.normalized_title % $1
order by score desc, s.title
limit 30;
```

Use `normalizeSearchText()` from `apps/api/src/modules/catalog/search-normalization.ts` before passing title or artist query terms into normalized fields.

## Suggested API Shape

These routes are not implemented yet, but this is the recommended read model:

- `GET /ktv/search?q=<keyword>`: fuzzy title and artist search.
- `GET /ktv/songs/:songId/assets`: playable versions for one indexed song.
- `GET /ktv/artists/:artist/songs`: all active songs for one artist.
- `GET /ktv/categories/:category/songs`: all active songs under one category.

Implementation notes:

- Put SQL in a read-only repository module.
- Always use parameterized queries.
- Always filter `missing_at is null`.
- Return all matching assets first; automatic "best version" selection can be added later after ffprobe resolution and bitrate metadata is populated.
- Expose audio track count when technical metadata is present. Controller UI uses `audioTrackCount = 1` to show the “单音轨歌曲源” label.

## Refreshing The Index

After copying new media into `/mnt/nas/KTV歌曲`, rerun:

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --ssh-host lxc-nas \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv
```

The refresh is safe to repeat. Existing rows are updated, new files are inserted, and deleted files are hidden through `missing_at`.
