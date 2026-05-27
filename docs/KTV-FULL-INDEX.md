# KTV Full Index Technical Design

## Current State

- Source root: `/mnt/nas/KTV歌曲` on `lxc-nas`
- Latest full run: `96288717-1299-4d0c-beed-326697548cc3`
- Active media assets: `34,385`
- Missing historical assets: `28`
- Active file size: `1745 GB`
- Active parse strategy: `filename = 34,385`
- Low-confidence active rows: `0`
- Songs: `31,893`
- Artists: `8,568`

## Architecture

The index keeps the NAS folder layout unchanged. Video files stay under `/mnt/nas/KTV歌曲`; PostgreSQL stores searchable metadata and the absolute file path.

Tables:

- `ktv_index_runs`: every index run, source root, status, counts, errors.
- `ktv_artists`: normalized artist names plus pinyin and initials.
- `ktv_songs`: title, primary artist, category, normalized search keys.
- `ktv_song_artists`: many-to-many song/artist links for duet and multi-artist songs.
- `ktv_song_assets`: actual playable files, path, size, parse confidence, technical metadata, missing marker.

The existing playback catalog remains separate. This KTV index is the fast lookup layer for finding song versions, artist catalogs, categories, and playable file paths.

## Filename Rules

Each top-level source folder has one strict parser rule. The current folders all use the same rule:

- `流行歌曲(2.5万首880G)`
- `国语-知名歌星专辑 11000首850G`
- `酷狗排行TOP`

Format:

```text
歌手-歌曲名-语种-分类.ext
```

Details:

- Full-width dashes such as `－` are normalized to `-`.
- Titles may contain `-`; parsing is done from the tail.
- The first segment is artist.
- The second-to-last segment must be a known language marker.
- The last segment is stored as `category`.
- The middle segments are joined back as `title`.
- Language is only used to validate the filename. It is not stored as a business field.
- Trailing display markers such as `(MTV)` are removed from title.

Exception policy:

- If a file does not match the folder rule, delete it or add a new explicit folder rule before making it part of the active library.
- After cleanup, all active assets should have `parse_strategy = 'filename'` and `parse_confidence = 0.98`.

## Rebuild Flow

Run migrations:

```bash
DATABASE_URL=postgresql://ktv:ktv@127.0.0.1:5432/home_ktv pnpm -F @home-ktv/api migrate
```

Run the full index:

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --ssh-host lxc-nas \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv
```

What it does:

1. SSH to `lxc-nas`.
2. Discover `.mkv`, `.mpg`, and `.mpeg` files under the source root.
3. Parse metadata by folder rule.
4. Upsert artists, songs, artist links, and assets.
5. Mark assets not seen in the current full run as `missing_at = now()`.

The command is idempotent. Running it again does not duplicate songs or assets. If a previously missing file reappears, the asset is restored by setting `missing_at = null`.

For smoke tests only:

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --ssh-host lxc-nas \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv \
  --limit 100
```

`--limit` does not mark missing assets, so it is safe for test runs.

## Verification SQL

Active count and size:

```sql
select
  count(*) filter (where missing_at is null) as active_assets,
  count(*) filter (where missing_at is not null) as missing_assets,
  pg_size_pretty(coalesce(sum(size_bytes) filter (where missing_at is null), 0)) as active_file_size
from ktv_song_assets;
```

Parser coverage:

```sql
select parse_strategy, count(*)
from ktv_song_assets
where missing_at is null
group by parse_strategy
order by count desc;
```

Low-confidence rows:

```sql
select count(*) as active_assets,
       count(*) filter (where parse_confidence < 0.75) as low_confidence,
       min(parse_confidence) as min_confidence
from ktv_song_assets
where missing_at is null;
```

## Adding New Songs

1. Copy the new files into one of the known top-level source folders.
2. Make sure the filename follows that folder's rule.
3. Run the full index command.
4. Check parser coverage. If anything is not `filename`, either delete that exception or add a folder-specific rule.

## Adding A New Folder Rule

If a new top-level folder has a different filename format:

1. Add the folder match in `ruleForRootFolder()` in `apps/api/src/modules/ingest/ktv-sample-index.ts`.
2. Add a focused parser test in `apps/api/src/test/ktv-sample-index.test.ts`.
3. Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-sample-index.test.ts src/test/ktv-full-index.test.ts
pnpm -F @home-ktv/api typecheck
```

