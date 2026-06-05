# 歌曲导入 Runbook

## 目标

本文记录当前 HomeKTV 从外部下载歌曲到完成入库的标准流程。导入不是“扫进数据库”就结束；只有完成媒体探测、标签、封面和必要筛选后，才算导入完成。

当前曲库仍以 NAS 文件为唯一播放来源，数据库读模型是 `ktv_songs`。一行就是一个可播放文件。

## 总流程

```text
OpenList 下载到指定目录
  -> 扫描导入目录并写入 ktv_songs
  -> 可选：初步筛选，必要时删除一部分
  -> probe 媒体探测，补音轨和编码信息
  -> 风格标签补全
  -> 封面缓存补全
  -> 基于重复度、音轨、封面、标签和榜单分数继续筛选
  -> 验证搜索、推荐、播放和后台诊断
```

## 目录约定

OpenList 下载目标应放在 NAS 曲库根目录下面，例如：

```text
/mnt/nas/KTV歌曲/_imports/<批次名>/
```

文件最终必须位于 `/mnt/nas/KTV歌曲` 下面，才能被当前曲库扫描纳入。

正式导入使用 partial import 脚本。它只扫描指定批次目录，并用完整 NAS 曲库根目录计算 `relative_path`；不会把主曲库其它歌曲标记为 `missing`。

不要把全量索引脚本 `index:ktv --source-root` 指向 `_imports/<批次名>` 这种子目录来做正式入库。

正式导入时，批次目录仍应位于完整曲库根目录下面：

```bash
bash deploy/source/ktv.sh import-songs -- \
  --import-root /mnt/nas/KTV歌曲/_imports/<批次名> \
  --library-root /mnt/nas/KTV歌曲
```

## 1. 用 OpenList 下载歌曲

在 OpenList 中把歌曲下载到约定导入目录。下载完成前不要启动扫描，避免扫到未完成文件。

下载后先做基本检查：

```bash
find /mnt/nas/KTV歌曲/_imports/<批次名> -type f \
  \( -iname '*.mkv' -o -iname '*.mpg' -o -iname '*.mpeg' \) | wc -l
```

当前支持的媒体扩展名：

```text
.mkv
.mpg
.mpeg
```

推荐文件名继续保持：

```text
歌手-歌曲名-语种-分类.ext
```

不符合规则的目录或文件名，应先补解析规则和测试，再纳入主曲库。

## 2. 扫描导入目录入库

在 `lxc-dev` 上执行。源码部署会通过 `deploy/source/.env` 提供数据库连接等环境变量：

```bash
cd /opt/home-ktv-system
set -a
. deploy/source/.env
set +a

bash deploy/source/ktv.sh import-songs -- \
  --import-root /mnt/nas/KTV歌曲/_imports/<批次名> \
  --library-root /mnt/nas/KTV歌曲
```

涉及代码：

```text
apps/api/src/scripts/ktv-full-index.ts
apps/api/src/scripts/ktv-song-import.ts
apps/api/src/modules/ingest/ktv-full-index.ts
apps/api/src/modules/ingest/ktv-sample-index.ts
```

这一步会：

- 遍历 `--import-root` 下的 `.mkv`、`.mpg`、`.mpeg` 文件。
- 解析歌名、歌手、文件路径、文件大小和修改时间。
- 按 `file_path` upsert 到 `ktv_songs`。
- 新入库歌曲默认 `technical_status = 'pending'`。
- 默认保留同路径已有记录的标题、歌手、标签、封面和探测信息，只刷新存在性和文件信息。
- 不标记其它目录歌曲为 `missing`。

如果确实要重解析并覆盖同路径已有歌曲的元数据，可以显式加 `--overwrite-existing`：

```bash
bash deploy/source/ktv.sh import-songs -- \
  --import-root /mnt/nas/KTV歌曲/_imports/<批次名> \
  --library-root /mnt/nas/KTV歌曲 \
  --overwrite-existing
```

扫描后可查看曲库总量：

```bash
psql "$DATABASE_URL" -c "
select
  count(*) filter (where missing_at is null) as active_songs,
  count(*) filter (where missing_at is not null) as missing_songs
from ktv_songs;
"
```

## 3. 可选：初步筛选

扫描后可以先做一轮人工或脚本筛选，但这不是必做阶段。筛选可能删除一部分歌曲，常见依据包括：

- 文件名明显不合规。
- 歌手和歌名解析错误。
- 文件大小异常。
- 重复度高。
- 来源目录本身不可靠。

当前已有删除工具：

```text
scripts/tools/delete_uncovered_songs.py
```

它按准备好的 CSV 删除数据库记录、封面缓存和媒体文件。CSV 至少应包含脚本需要的字段，例如 `id`、`title`、`primary_artist_name`、`artist_names`、`cover_image_url`、`file_path`、`size_bytes`。

先生成计划：

```bash
python3 scripts/tools/delete_uncovered_songs.py plan \
  --input runtime/imports/<批次名>/delete-songs.csv \
  --output runtime/imports/<批次名>/delete-songs.plan.json
```

确认后再执行：

```bash
python3 scripts/tools/delete_uncovered_songs.py apply \
  --input runtime/imports/<批次名>/delete-songs.csv \
  --output runtime/imports/<批次名>/delete-songs.apply.json \
  --db-ssh-host lxc-dev \
  --cover-ssh-host lxc-dev \
  --media-ssh-host lxc-dev \
  --media-source-prefix /mnt/nas \
  --media-target-prefix /mnt/nas
```

删除前后都要确认没有队列断引用：

```bash
psql "$DATABASE_URL" -c "
select count(*) as queue_invalid_refs
from queue_entries q
left join ktv_songs s on s.id = q.song_id
where q.song_id is not null
  and s.id is null;
"
```

## 4. 媒体探测

索引只让歌曲进入曲库；媒体探测用于补音轨、编码、时长等播放诊断信息。

源码部署推荐：

```bash
cd /opt/home-ktv-system
bash deploy/source/ktv.sh probe-index -- --concurrency 20
```

如果之前有失败记录，修复文件或环境后重试：

```bash
bash deploy/source/ktv.sh probe-index -- --retry-failed --concurrency 20
```

涉及代码：

```text
apps/api/src/scripts/ktv-index-probe.ts
apps/api/src/modules/ktv-index/ktv-index-technical-probe.ts
apps/api/src/modules/ingest/media-probe.ts
```

系统依赖：

```bash
ffprobe
```

验证：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/admin/ktv-index/diagnostics?sampleSize=0' \
  | jq '{technicalStatusCounts, probePendingCount, probeFailedCount, probeCoveragePercent}'
```

导入完成前，新增歌曲不应长期停留在 `pending`。

## 5. 风格标签补全

标签写入 `ktv_songs.style_tags`。当前使用独立 Python 批处理脚本，先生成 JSONL，再导入数据库。

涉及脚本：

```text
scripts/tools/run_style_tagging_llm_batch.py
scripts/tools/run_style_tagging_llm_batch_test.py
```

查看待处理数量：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py status \
  --env-file deploy/source/.env \
  --max-existing-tags 0
```

运行一批：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py run \
  --env-file deploy/source/.env \
  --max-existing-tags 0 \
  --batch-size 30 \
  --output runtime/tagging/llm/<批次名>.jsonl
```

导入前 dry-run：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py import \
  --env-file deploy/source/.env \
  --output runtime/tagging/llm/<批次名>.jsonl \
  --dry-run
```

确认后写库：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py import \
  --env-file deploy/source/.env \
  --output runtime/tagging/llm/<批次名>.jsonl \
  --apply
```

验证标签覆盖：

```bash
psql "$DATABASE_URL" -c "
select
  count(*) as active_songs,
  count(*) filter (where cardinality(style_tags) > 0) as with_tags,
  count(*) filter (where cardinality(style_tags) = 0) as without_tags
from ktv_songs
where missing_at is null;
"
```

## 6. 封面补全

封面写入 `ktv_songs.cover_image_url`，图片缓存到本地媒体目录。

涉及脚本：

```text
scripts/tools/fetch_song_covers.py
scripts/tools/fetch_song_covers_test.py
scripts/tools/generate_cover_thumbnails.py
scripts/tools/generate_cover_thumbnails_test.py
apps/api/src/routes/media.ts
apps/api/src/modules/covers/song-cover-repository.ts
```

查看覆盖情况：

```bash
bash deploy/source/ktv.sh cover-status
```

批量拉取封面：

```bash
bash deploy/source/ktv.sh fetch-covers -- \
  --limit 0 \
  --concurrency 4 \
  --delay-ms 200
```

重试失败或未命中：

```bash
bash deploy/source/ktv.sh fetch-covers -- --retry-failed --limit 500 --concurrency 3 --delay-ms 300
bash deploy/source/ktv.sh fetch-covers -- --retry-not-found --limit 500 --concurrency 3 --delay-ms 300
```

生成缩略图：

```bash
bash deploy/source/ktv.sh cover-thumbnails -- \
  --source-root /opt/home-ktv-system/runtime/media/covers/nas \
  --output-root /opt/home-ktv-system/runtime/media/covers/nas/thumbs \
  --size 160 \
  --concurrency 20
```

详细策略见 [歌曲封面缓存 Runbook](song-cover-fetching.md)。

## 7. 后续筛选

导入完成后，还需要根据曲库质量继续筛选。常见维度：

- 重复度：同歌手同歌名、同名不同歌手、综艺/现场/翻唱版本。
- 音轨信息：单音轨、双音轨、多音轨、探测失败。
- 文件质量：0 字节、无法 ffprobe、异常小文件。
- 标签覆盖：无标签或标签明显不合适。
- 封面覆盖：长期没有封面或封面错误。
- 热度分数：热门榜单、歌单、历史点歌次数。

可用脚本：

```text
scripts/tools/fetch_hot_song_candidates.py
scripts/tools/fetch_chart_scores.py
scripts/tools/fetch_playlist_scores.py
scripts/tools/merge_music_scores.py
scripts/tools/delete_uncovered_songs.py
```

热门、榜单和歌单分数可用于生成“保留/删除候选表”，再交给删除脚本执行。

## 导入完成标准

一次导入完成需要同时满足：

- 新歌曲已进入 `ktv_songs`，且 `missing_at is null`。
- 后台诊断没有新增长期 `pending`。
- 真实坏文件已经删除或明确保留。
- 新歌曲已完成标签补全，或明确进入后续补标队列。
- 新歌曲已完成封面补全，或明确进入后续补封面队列。
- 搜索、歌手分类、风格分类和首页推荐能看到新歌曲。
- `queue_entries` 没有断引用。
- `bash deploy/source/ktv.sh smoke` 通过。

常用最终检查：

```bash
bash deploy/source/ktv.sh smoke
bash deploy/source/ktv.sh cover-status
curl -sS 'https://ktv-api.shaolongfei.com/admin/ktv-index/diagnostics?sampleSize=0' \
  | jq '{activeAssetCount, songCount, technicalStatusCounts, probePendingCount, probeFailedCount, probeCoveragePercent}'
```
