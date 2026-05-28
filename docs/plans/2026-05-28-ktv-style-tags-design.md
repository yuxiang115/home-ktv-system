# 真实曲库多标签设计

## 目标

为 `ktv_*` 真实曲库建立歌曲级多标签体系，用于后续控制端按歌手、风格、场景浏览和筛选。`ktv_songs.category` 不再保留，旧文件名里的风格片段只作为历史解析信息，不进入产品分类逻辑。

## 架构

标签是独立维度，不再绑定到歌曲主表。`ktv_songs` 只保留歌曲身份字段：歌名、主歌手、搜索字段和时间戳。风格、语种、场景、情绪、年代等信息进入 `ktv_style_groups`、`ktv_style_tags`、`ktv_song_style_tags`。

初始打标签只启用网易云 API 路径：用 `title + primary_artist_name` 搜索歌曲和歌单，从歌单标题与 tags 里按白名单投票。大模型暂不接入，等网易云样本统计出来后再决定是否补缺。

## 数据模型

- `ktv_style_groups`: 标签分组，例如语种地区、核心曲风、主题情绪、KTV场景、年代版本。
- `ktv_style_tags`: 标签白名单，按分组管理。
- `ktv_song_style_tags`: 歌曲和标签的多对多关系，保留来源、置信度和证据。
- `ktv_song_tagging_runs`: 每次打标签运行的统计。
- `ktv_song_tagging_status`: 每首歌最近一次打标签状态，用于断点续跑和统计失败。

`ktv_song_style_tags` 使用 `(song_id, tag_id, source)` 作为主键。后续如果加入人工修正或大模型兜底，可以与网易云结果并存；查询层按 `tag_id` 去重。

## category 迁移

迁移时先按 `(normalized_title, normalized_primary_artist_name)` 合并历史重复歌曲行，把所有 asset 迁到保留的 song 上，再删除 `ktv_songs.category` 和旧 category 索引，建立新的歌曲唯一索引。

同步到正式播放 catalog 时，不再从 `ktv_songs.category` 生成 genre。正式 catalog 可以先使用空 genre，后续在产品分类页接入多标签。

## 打标签流程

1. CLI 从 `ktv_songs` 选择歌曲，默认只处理未完成网易云打标的歌曲。
2. 对每首歌调用本地 `NeteaseCloudMusicApi`：
   - `/cloudsearch?type=1` 确认歌曲候选。
   - `/cloudsearch?type=1000` 搜索相关歌单。
   - `/playlist/detail` 获取歌单 name 和 tags。
3. 根据白名单关键词规则投票，保留最多 8 个标签。
4. 写入 `ktv_song_style_tags`，并更新 `ktv_song_tagging_status`。
5. 输出覆盖率、空标签数、失败数、平均标签数和耗时。

## 验证策略

先跑 300 首样本，不启用大模型。验收重点是：

- 数据库迁移后应用仍能启动和搜索。
- `ktv_songs` 不再有 `category` 列。
- 样本运行有统计报告。
- 标签全部来自白名单。
- 空标签和失败歌曲可追踪，便于决定是否引入大模型。
