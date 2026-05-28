# KTV Full Index Technical Design

## Current State

- Source root: `/mnt/nas/KTV歌曲` on `lxc-nas`
- Current counts change whenever the NAS library is rescanned. Use SQL against the live PostgreSQL database for exact numbers.

## Architecture

The index keeps the NAS folder layout unchanged. Video files stay under `/mnt/nas/KTV歌曲`; PostgreSQL stores searchable metadata and the absolute file path.

Tables:

- `ktv_index_runs`: every index run, source root, status, counts, errors.
- `ktv_artists`: normalized artist names plus pinyin and initials.
- `ktv_songs`: title, primary artist, normalized search keys.
- `ktv_song_artists`: many-to-many song/artist links for duet and multi-artist songs.
- `ktv_song_assets`: actual playable files, path, size, parse confidence, technical metadata, missing marker.
- `ktv_style_groups`, `ktv_style_tags`, `ktv_song_style_tags`: multi-style tagging model. One song can belong to multiple style tags.

The existing playback catalog remains separate. This KTV index is the fast lookup layer for finding song versions, artist catalogs, style tags, and playable file paths.

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
- After cleanup, all active assets should have `parse_strategy = 'filename'` and `parse_confidence = 0.98`.

## Style Tags

歌曲风格不再依赖文件名中的原始分类。当前使用独立标签表：

- `ktv_style_groups`: 标签分组，例如语言、年代、情绪、曲风。
- `ktv_style_tags`: 具体标签。
- `ktv_song_style_tags`: 歌曲和标签的多对多关系，带来源字段。
- `ktv_song_tagging_status`: 每首歌在某个标签来源下的处理状态。

主标签来源优先使用网易云 API；低覆盖歌曲可以用 LLM 批量补充。标签回填不影响搜索、点歌和播放。

长时间全量打标签时优先使用 JSONL 暂存流程，避免 PostgreSQL 重建、迁移或重启中断任务：

```bash
pnpm ktv:tags:export -- --out runtime/media/tagging/full/songs.jsonl
pnpm ktv:tags:jsonl -- --input runtime/media/tagging/full/songs.jsonl --output runtime/media/tagging/full/results.jsonl --source netease
pnpm ktv:tags:import -- --input runtime/media/tagging/full/results.jsonl --dry-run
pnpm ktv:tags:import -- --input runtime/media/tagging/full/results.jsonl --apply
```

Docker 部署建议把暂存文件放在媒体挂载目录，容器重建后仍然保留：

```bash
bash deploy/docker/ktv.sh tag-styles-export -- --out /data/home-ktv-media/tagging/full/songs.jsonl
bash deploy/docker/ktv.sh tag-styles-jsonl -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl --source netease
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --apply
```

`tag-styles-jsonl` 不连接 PostgreSQL，只读取 `songs.jsonl` 并追加 `results.jsonl`，可安全续跑。导入阶段会先按旧 `sourceSongId` 匹配当前歌曲，再按归一化歌名和歌手匹配。

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
