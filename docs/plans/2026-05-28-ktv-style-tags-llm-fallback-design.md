# 曲库标签 LLM 兜底设计

## 背景

网易云 API 对 300 首真实曲库样本打标签后，结果为 `tagged=277`、`empty=23`、`failed=0`，平均每首已打标签歌曲 `3.881` 个标签。它可以作为主来源，但仍有约 7.7% 空结果，另有一批歌曲只有 1 个标签。

## 决策

保留 `netease-playlist-v1` 作为低成本主来源，引入 `llm-style-v1` 作为补缺来源。LLM 不全量运行，只处理以下歌曲：

- 网易云为空结果的歌曲。
- 当前已聚合标签数小于等于阈值的歌曲，默认阈值为 `1`。

LLM 只接收歌名、歌手和白名单标签，不读取媒体文件，不保存推理过程全文。返回结果仍写入 `ktv_song_style_tags`，保留来源、置信度和简短证据。

## 数据模型修正

`ktv_song_style_tags` 已支持多来源并存，但 `ktv_song_tagging_status` 目前以 `song_id` 为主键，会导致网易云状态和 LLM 状态互相覆盖。需要迁移为 `(song_id, source)` 复合主键，让每个来源独立记录运行状态。

## CLI

沿用现有 `tag-styles` 入口，增加：

- `--source llm`
- `--llm-base-url`
- `--llm-api-key`
- `--llm-model`
- `--max-existing-tags`

示例：

```bash
bash deploy/docker/ktv.sh tag-styles -- \
  --source llm \
  --llm-base-url http://192.168.5.103:8317 \
  --llm-api-key sk-... \
  --limit 100 \
  --apply
```

## 输出约束

LLM 输出必须是 JSON，结构为：

```json
{"tags":["华语","流行","情歌"]}
```

服务端只接受 `style-taxonomy.ts` 中的白名单标签，最多保留 6 个。非法标签直接丢弃。

## 验证

- 单元测试覆盖 LLM JSON 解析、非法标签过滤、状态表复合主键、CLI 参数。
- 服务器先对空结果和低覆盖样本运行小批量 apply。
- 查询 `llm-style-v1` 的覆盖率、失败数和新增标签分布。
