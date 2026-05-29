# KTV 风格标签表精简设计

## 目标

把当前风格标签相关的 6 张表精简为 1 张运行时关系表，删除已经被独立 Python 打标脚本接管的运行态表，保持控制端和搜索端仍然可以按标签分类、展示和检索。

## 结论

最终只保留一张标签关系表：

`ktv_song_style_tags(song_id, tag_name, tag_group, created_at, updated_at)`

一首歌有多个标签时，就插入多行记录。每行表示“一首歌命中的一个标签”。

## 为什么这样做

当前风格体系里，真正被产品读取的是“歌曲有哪些标签”，而不是“标签字典本身如何管理”。`ktv_style_groups`、`ktv_style_tags`、`ktv_song_tagging_runs`、`ktv_song_tagging_status`、`ktv_song_tagging_cache` 里，前两张是字典层，后三张是打标作业层。现在打标逻辑已经独立成 Python 脚本，数据库不再需要保存运行状态和缓存。

保留一张关系表后：

- 结构更简单，维护面更小。
- 查询仍然直接，首页分类和搜索联想都还能做。
- 后续要增加人工补标，只需要往同一张表补行。

## 表结构

### `ktv_song_style_tags`

字段：

- `song_id`：歌曲 ID，指向 `ktv_songs.id`。
- `tag_name`：标签名，例如 `流行`、`抒情`、`KTV必点`。
- `tag_group`：标签分组，例如 `核心曲风`、`主题情绪`、`语种地区`。
- `created_at`：写入时间。
- `updated_at`：更新时间。

约束：

- `UNIQUE(song_id, tag_name, tag_group)`，防止重复标签。
- `song_id` 外键级联删除，歌曲删掉时标签自动清理。

### 记录方式

一首歌有 3 个标签时，表里会有 3 行：

```text
song_id = s1, tag_name = 流行, tag_group = 核心曲风
song_id = s1, tag_name = 抒情, tag_group = 主题情绪
song_id = s1, tag_name = 90年代, tag_group = 年代版本
```

## 要删除的旧表

以下表不再保留：

- `ktv_style_groups`
- `ktv_style_tags`
- `ktv_song_tagging_runs`
- `ktv_song_tagging_status`
- `ktv_song_tagging_cache`

这些表要么只是字典层，要么只服务旧的应用内打标流程。新的 Python 打标脚本只负责把结果写进最小关系表。

## 迁移思路

1. 先从旧表把现有标签数据转换成 `song_id + tag_name + tag_group` 形式。
2. 把转换结果写入新的 `ktv_song_style_tags`。
3. 校验新表去重后行数、歌曲覆盖率和分组覆盖率。
4. 切换读路径到新表。
5. 删除旧的字典表和打标运行态表。

如果迁移期间还要兼容旧读路径，可以临时保留旧表和新表并行一个版本，但最终目标仍然是只保留新表。

## 代码影响范围

- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrations/*`
- `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- `apps/api/src/routes/song-search.ts`
- `apps/api/src/routes/song-discovery.ts`
- `apps/api/src/test/ktv-style-tags-schema.test.ts`
- `docs/database-schema.md`

## 验证标准

- 风格标签相关旧表从最终 schema 中消失。
- 查询接口仍能返回 `styleTags` 和 `category` 派生展示。
- 所有已标记歌曲仍能查到标签。
- 数据库里不再保留打标运行状态和缓存表。

