# 真实曲库索引

最后更新：2026-06-01。

本文描述当前真实 NAS 曲库的索引、查询和维护方式。历史 sample 索引、旧双表曲库模型和线上曲库占位结构不再作为当前说明保留。

## 当前状态

- 曲库根目录：`/mnt/nas/KTV歌曲`
- 当前部署：`lxc-dev` 源码部署优先，PostgreSQL 可继续由旧 Docker PostgreSQL 提供
- 当前读模型：`ktv_songs`
- 当前播放来源：NAS 文件
- 当前线上曲库：未启用，线上候选只记录在 `candidate_tasks`

准确数量以服务器数据库为准：

```sql
select
  count(*) filter (where missing_at is null) as active_songs,
  count(*) filter (where missing_at is not null) as missing_songs,
  count(*) filter (where cover_image_url is not null) as songs_with_cover
from ktv_songs;
```

## 数据模型

`ktv_songs` 是真实曲库的唯一持久读模型。一行就是一个可播放 NAS 文件，不再区分“逻辑歌曲”和“资源文件”两层。

核心字段：

- `id`: 歌曲和媒体资源共用的 ID。
- `title`: 歌名。
- `primary_artist_name`: 主歌手。
- `artist_names`: 多歌手数组。
- `style_tags`: 多风格标签数组。
- `file_path`: NAS 文件绝对路径。
- `technical_status` / `technical_metadata`: 媒体探测结果。
- `request_count` / `last_requested_at`: 点歌统计，首页推荐使用。
- `cover_image_url` / `cover_updated_at`: 控制端展示封面。
- `missing_at`: 为空表示当前文件存在且可展示。

完整字段见 [数据库结构](database-schema.md)。

## 入库策略

真实曲库默认全自动入库。只要文件被索引、`missing_at is null`，就可以搜索和点歌，不需要 Admin 人工审核后才变为可用。

Admin 的职责是查看和管理资源：检查文件路径、可读性、技术元数据、音轨数量、播放失败证据和重新扫描结果。它不承担歌曲可用性的前置审核职责。

## 文件名规则

当前已接入的主目录使用同一类文件名规则：

```text
歌手-歌曲名-语种-原始分类.ext
```

约定：

- 支持 `.mkv`、`.mpg`、`.mpeg`。
- 全角连接号会归一化。
- 歌名中可以包含 `-`，解析从尾部识别语种和分类。
- 文件名中的原始分类只作为解析证据，不再写入长期分类字段。
- 歌曲风格看 `ktv_songs.style_tags`。

例外处理：

- 如果新目录文件名规则不同，应先补明确 parser 规则和测试，再纳入曲库。
- 不符合规则的文件不应靠手工 SQL 修补入库。

## 索引流程

全量索引从 API 包运行：

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv
```

如果数据库里已经有一批人工维护过标签、封面或修正过歌名歌手的数据，补充新增歌曲时应使用安全模式：

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv \
  --preserve-existing
```

安全模式会：

- 新路径正常插入
- 同路径保留原有标题、歌手、标签、技术探测和封面字段
- 如果旧记录此前被标记为 `missing_at`，本次重新扫到后恢复为存在中
- 仍会标记本轮全量扫描未看到的旧路径为 `missing`

在当前 `lxc-dev` 源码部署中，NAS 已经通过 bind mount 挂载到 `/mnt/nas`，因此不需要 `--ssh-host`。只有从不能直接读取 NAS 路径的机器执行索引时，才额外传 `--ssh-host <host>`。

行为：

1. 遍历曲库根目录下可播放文件。
2. 按文件名规则解析歌名、歌手、语种和来源证据。
3. 按 `file_path` upsert 到 `ktv_songs`。
4. 当前全量扫描没有看到的旧文件会标记 `missing_at`。
5. `--limit` 只用于样本测试，不标记缺失歌曲。

## 技术探测

索引让歌曲可搜索、可点歌；技术探测补充音轨、编码、时长等播放诊断信息。探测失败不会让歌曲不可用。

源码部署推荐使用部署 wrapper：

```bash
cd /opt/home-ktv-system
bash deploy/source/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/source/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

探测只保存摘要：

- `technical_status = 'probed'` 或 `failed`
- `technical_metadata.mediaInfoSummary`
- `technical_metadata.mediaInfoProvenance`
- 失败时保存简短错误信息

不保存完整 ffprobe raw JSON。

验证音轨数量：

```sql
select title,
       primary_artist_name,
       jsonb_array_length(coalesce(technical_metadata->'mediaInfoSummary'->'audioTracks', '[]'::jsonb)) as audio_tracks
from ktv_songs
where missing_at is null
  and title = '冲动的惩罚';
```

## 搜索和分类查询

所有用户侧查询都必须过滤：

```sql
where missing_at is null
```

按歌名查版本：

```sql
select id, title, primary_artist_name, file_path, extension, size_bytes
from ktv_songs
where missing_at is null
  and normalized_title = $1
order by primary_artist_name, file_path;
```

按歌手分类：

```sql
select unnest(artist_names) as artist_name, count(*) as song_count
from ktv_songs
where missing_at is null
group by artist_name
order by song_count desc, artist_name asc;
```

按风格分类：

```sql
select unnest(style_tags) as style_tag, count(*) as song_count
from ktv_songs
where missing_at is null
group by style_tag
order by song_count desc, style_tag asc;
```

模糊歌名搜索：

```sql
select id, title, primary_artist_name, similarity(normalized_title, $1) as score
from ktv_songs
where missing_at is null
  and normalized_title % $1
order by score desc, title
limit 30;
```

API 侧传入搜索词前应使用 `apps/api/src/modules/catalog/search-normalization.ts` 中的归一化逻辑。

## 风格标签

风格标签直接保存在 `ktv_songs.style_tags text[]`。数据库不再保存标签字典、关系表、打标运行状态或缓存。

批量补标签使用 Python runner：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py status --env-file deploy/source/.env
python3 scripts/tools/run_style_tagging_llm_batch.py run --env-file deploy/source/.env --max-existing-tags 1 --batch-size 30
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --dry-run
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --apply
```

脚本先写 JSONL 和 state 文件，再显式导入数据库。标签回填不影响搜索、队列或播放。

## 封面

封面只在 `ktv_songs.cover_image_url` 保存展示地址。批量拉取脚本会下载图片到本地缓存，再把公开 URL 写回数据库。

当前封面脚本见 [歌曲封面缓存 Runbook](runbooks/song-cover-fetching.md)。

## 推荐列表

首页推荐读取 `ktv_songs.request_count` 作为权重来源。只要歌曲被点过，后端会递增长期计数；队列清空不会清除这个计数。

当前推荐逻辑应只从 `missing_at is null` 的 NAS 曲库中选择歌曲。

## 验证

曲库数量：

```sql
select
  count(*) filter (where missing_at is null) as active_songs,
  count(*) filter (where missing_at is not null) as missing_songs,
  pg_size_pretty(coalesce(sum(size_bytes) filter (where missing_at is null), 0)) as active_file_size
from ktv_songs;
```

解析覆盖：

```sql
select parse_strategy, count(*)
from ktv_songs
where missing_at is null
group by parse_strategy
order by count desc;
```

标签覆盖：

```sql
select
  count(*) as active_songs,
  count(*) filter (where cardinality(style_tags) > 0) as with_tags,
  count(*) filter (where cardinality(style_tags) = 0) as without_tags
from ktv_songs
where missing_at is null;
```

封面覆盖：

```sql
select
  count(*) as active_songs,
  count(*) filter (where cover_image_url is not null) as with_cover,
  count(*) filter (where cover_image_url is null) as without_cover
from ktv_songs
where missing_at is null;
```

发现页 smoke：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?seed=server-check&limit=30' \
  | jq '{count: (.recommended | length), recommended: [.recommended[0:5][] | {title, artistName, coverImageUrl}]}'
```

媒体流抽查：

```bash
curl -I -H 'Range: bytes=0-1023' 'https://ktv-api.shaolongfei.com/media/nas/<song-id>'
```
