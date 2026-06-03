# KTV 安全补库模式设计

日期：2026-06-03

## 目标

为 `index:ktv` 增加一个显式的安全补库模式，用于把新增 NAS 歌曲补充进现有 `ktv_songs` 数据库，同时保证：

- 同一路径已存在的歌曲不覆盖原有人工或批量维护结果
- 之前被标记为 `missing_at` 的歌曲如果文件又出现，可以恢复为存在中
- 新路径歌曲仍然正常插入

## 当前风险

当前 `apps/api/src/modules/ingest/ktv-full-index.ts` 的 upsert 逻辑在 `ON CONFLICT (file_path)` 时会覆盖：

- 标题与搜索字段
- 主歌手与歌手数组
- `style_tags`
- `parse_strategy` / `parse_confidence`
- `technical_status` / `technical_metadata`

这意味着如果直接跑当前 `index:ktv`：

- 已经补好的风格标签会被清空
- 已有人为修正的标题和歌手可能被文件名重新覆盖
- 已有技术探测结果会被重置成 `pending`

封面字段 `cover_image_url` 当前没有在 upsert 中被覆盖，但标签和解析元数据仍然存在严重风险。

## 已确认约束

- 用户明确要求：如果发现路径一致就跳过，不要覆盖原本数据。
- 用户进一步确认：若同路径记录当前是 `missing_at`，应恢复为存在中。
- 当前最合理的产品形态是保留默认全量索引语义，再额外提供一个显式安全模式，而不是直接改变默认行为。

## 方案选型

### 方案 A：给 `index:ktv` 增加显式安全模式参数

做法：

- 为 CLI 增加 `--preserve-existing`
- 为 importer 增加 `preserveExisting` 选项
- 当该选项开启时，遇到同路径冲突只更新安全字段，不覆盖已有业务数据

优点：

- 风险最可控
- 行为显式，适合生产环境补库
- 未来仍保留“全量重建元数据”的默认能力

缺点：

- 需要多传一个参数

### 方案 B：直接把当前默认 upsert 改成永远保守

优点：

- 用户不用记参数

缺点：

- 会改变现有全量索引默认语义
- 后续如果想用文件名刷新解析结果，会失去这个能力

### 方案 C：单独写一次性补库脚本

优点：

- 与现有索引流程完全隔离

缺点：

- 会复制扫描和写库逻辑
- 维护成本高

## 推荐方案

采用方案 A。

## 详细设计

### 新增 CLI 参数

在 `pnpm -F @home-ktv/api index:ktv -- ...` 中支持：

```bash
--preserve-existing
```

含义：

- 新文件正常插入
- 同路径文件进入“保守更新”分支

### Importer 行为

为 `IndexKtvAssetDraftsInput` 增加：

- `preserveExisting?: boolean`

当 `preserveExisting` 为 `false` 或未传时：

- 保持当前行为不变

当 `preserveExisting` 为 `true` 时：

- `INSERT` 路径不变，新歌照常入库
- `ON CONFLICT (file_path) DO UPDATE` 只更新安全字段

### 冲突时保留不覆盖的字段

同路径已存在时，保留原数据库值：

- `title`
- `normalized_title`
- `title_pinyin`
- `title_initials`
- `primary_artist_name`
- `normalized_primary_artist_name`
- `artist_names`
- `style_tags`
- `parse_strategy`
- `parse_confidence`
- `technical_status`
- `technical_metadata`
- `cover_image_url`
- `cover_updated_at`

其中封面字段当前本来就不会被当前 upsert 改写，本轮不需要额外处理。

### 冲突时允许更新的字段

同路径已存在时，允许更新：

- `relative_path`
- `file_name`
- `extension`
- `size_bytes`
- `mtime_ms`
- `source_root`
- `ssh_host`
- `last_seen_run_id`
- `missing_at = NULL`
- `updated_at = now()`

这保证：

- 路径命中即视为文件仍然存在
- 之前缺失的歌曲能恢复为可用
- 文件大小、修改时间等探测前元信息会刷新

### `missing_at` 恢复语义

如果旧记录是：

- `file_path` 相同
- `missing_at is not null`

并且本轮扫描再次发现该文件，则：

- 不覆盖已有标题、标签、封面等
- 只把 `missing_at` 清空
- 更新 `last_seen_run_id`

### `markMissingAssets` 交互

安全模式不会改变“全量扫描后标记本轮没看到的旧文件为 missing”这条规则。

也就是说：

- 新扫到的同路径文件会恢复 `missing_at = NULL`
- 本轮没扫到的旧路径仍会在最后被标记 `missing_at = now()`

这符合补库和恢复存在状态的预期。

## 代码落点

- `apps/api/src/modules/ingest/ktv-full-index.ts`
  - 为 importer 增加 `preserveExisting`
  - 将 upsert SQL 拆成默认模式和安全模式

- `apps/api/src/scripts/ktv-full-index.ts`
  - 增加 `--preserve-existing`
  - 将 CLI 提炼为可测试的 `run...` / `parse...` 结构

- `apps/api/src/test/ktv-full-index.test.ts`
  - 增加 importer 的安全模式测试

- `apps/api/src/test/ktv-full-index-cli.test.ts`
  - 覆盖 CLI flag 解析和参数透传

## 验证方式

- importer 测试确认安全模式 SQL 不再覆盖 `style_tags` 和解析/技术字段
- importer 测试确认仍会恢复 `missing_at`
- CLI 测试确认 `--preserve-existing` 能被解析并传入 importer
- 跑 `ktv-full-index` 和新 CLI 测试通过

## 生产使用方式

代码完成后，生产补库命令应类似：

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url postgresql://... \
  --preserve-existing
```

如果在 `lxc-dev` 上直接执行，则继续使用服务器上的真实数据库连接串。
