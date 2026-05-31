# KTV Full Index Technical Design

## Current State

- Source root: `/mnt/nas/KTV歌曲` on `lxc-nas`
- Current counts change whenever the NAS library is rescanned. Use SQL against the live PostgreSQL database for exact numbers.

## Architecture

The index keeps the NAS folder layout unchanged. Video files stay under `/mnt/nas/KTV歌曲`; PostgreSQL stores searchable metadata and the absolute file path.

Tables:

- `ktv_songs`: one row per playable NAS file. It stores title, artist array, style-tag array, file path, parse confidence, technical metadata, missing marker, and request counters.
- `song_cover_cache`: cover lookup cache keyed by `source_kind + source_song_id`.

The old artist, asset, index-run, and style relation tables were merged into `ktv_songs` by `0021_catalog_schema_simplification.sql`. This KTV index is the lookup layer for finding song versions, artist catalogs, style tags, and playable file paths.

## Admission Policy

真实曲库默认全自动入库。只要文件被索引、`missing_at is null`，搜索和点歌链路就可以展示并使用它，不需要 Admin 人工审核后才变为可点。

Admin 的职责是查看和管理资源：检查文件路径、可读性、技术元数据、音轨数量、播放失败证据和重新扫描结果。它不承担歌曲可用性的前置审核职责。

如果索引资源已探测出只有一条音轨，手机控制端会标记“单音轨歌曲源”。这类歌曲仍然可以点歌播放，只是没有双音轨原唱/伴唱切换能力。

## Technical Probe Flow

完整文件名索引和媒体技术探测保持分离。索引负责让歌曲可搜索、可点歌；技术探测负责随后回填音轨数量、编码和时长等播放诊断元数据，不阻塞真实使用。

Docker 部署先跑 300 首样本：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

确认耗时和失败率可接受后，再全量高并发回填：

```bash
bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

探测只保存必要摘要：

- `technical_status = 'probed'` 与 `technical_metadata.mediaInfoSummary`
- `technical_metadata.mediaInfoProvenance`
- 失败时保存 `technical_status = 'failed'` 与 `technical_metadata.probeError`

探测不保存完整 ffprobe raw JSON。探测失败不会让歌曲不可用，只表示音轨数量等技术元数据暂时未知，后续可通过 `--retry-failed` 重试。

## Filename Rules

Each top-level source folder has one strict parser rule. The current folders all use the same rule:

- `流行歌曲(2.5万首880G)`
- `国语-知名歌星专辑 11000首850G`
- `酷狗排行TOP`

Format:

```text
歌手-歌曲名-语种-原始分类.ext
```

Details:

- Full-width dashes such as `－` are normalized to `-`.
- Titles may contain `-`; parsing is done from the tail.
- The first segment is artist.
- The second-to-last segment must be a known language marker.
- The last segment is treated as source parsing evidence only. `ktv_songs.category` is no longer a durable classification field.
- The middle segments are joined back as `title`.
- Language is only used to validate the filename. It is not stored as a business field.
- Trailing display markers such as `(MTV)` are removed from title.

Exception policy:

- If a file does not match the folder rule, delete it or add a new explicit folder rule before making it part of the active library.
- After cleanup, all active songs should have `parse_strategy = 'filename'` and `parse_confidence = 0.98`.

## Style Tags

歌曲风格不再依赖文件名中的原始分类。当前数据库把标签直接保存到 `ktv_songs.style_tags text[]`。

一首歌有多个标签时写成数组，例如 `{'国语','流行','KTV必点'}`。数据库不再保存标签字典、打标关系表、打标运行状态或缓存；这些状态由外部脚本自己的 JSONL 和 state 文件承担。标签回填不影响搜索、点歌和播放。

LLM 批量补标签使用独立 Python runner。它会先把结果追加到 JSONL 和 state 文件，全部完成后再统一导入数据库：

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

Docker 部署时同样使用这个脚本，只是从 `api` 容器内执行：

```bash
docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py run \
  --max-existing-tags 1 \
  --batch-size 30 \
  --output /data/home-ktv-media/tagging/llm-style-tags.jsonl

docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py import \
  --output /data/home-ktv-media/tagging/llm-style-tags.jsonl \
  --dry-run

docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py import \
  --output /data/home-ktv-media/tagging/llm-style-tags.jsonl \
  --apply
```

`--max-existing-tags` 控制候选范围，默认补齐标签数不超过 1 的歌曲。`status` 子命令可以查看当前候选数量和结果文件摘要。

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
4. Upsert one `ktv_songs` row per playable file.
5. Mark rows not seen in the current full run as `missing_at = now()`.

The command is idempotent. Running it again does not duplicate songs. If a previously missing file reappears, the row is restored by setting `missing_at = null`.

For smoke tests only:

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --ssh-host lxc-nas \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv \
  --limit 100
```

`--limit` does not mark missing songs, so it is safe for test runs.

## Verification SQL

Active count and size:

```sql
select
  count(*) filter (where missing_at is null) as active_songs,
  count(*) filter (where missing_at is not null) as missing_songs,
  pg_size_pretty(coalesce(sum(size_bytes) filter (where missing_at is null), 0)) as active_file_size
from ktv_songs;
```

Parser coverage:

```sql
select parse_strategy, count(*)
from ktv_songs
where missing_at is null
group by parse_strategy
order by count desc;
```

Low-confidence rows:

```sql
select count(*) as active_songs,
       count(*) filter (where parse_confidence < 0.75) as low_confidence,
       min(parse_confidence) as min_confidence
from ktv_songs
where missing_at is null;
```

## Adding New Songs

1. Copy the new files into one of the known top-level source folders.
2. Make sure the filename follows that folder's rule.
3. Run the full index command.
4. Check parser coverage. If anything is not `filename`, either delete that exception or add a folder-specific rule.
5. Songs become searchable after indexing; no manual approval step is required.

## Adding A New Folder Rule

If a new top-level folder has a different filename format:

1. Add the folder match in `ruleForRootFolder()` in `apps/api/src/modules/ingest/ktv-sample-index.ts`.
2. Add a focused parser test in `apps/api/src/test/ktv-sample-index.test.ts`.
3. Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-sample-index.test.ts src/test/ktv-full-index.test.ts
pnpm -F @home-ktv/api typecheck
```
