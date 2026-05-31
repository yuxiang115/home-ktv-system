# Python 歌曲封面缓存设计

## 背景

当前封面拉取逻辑在 TypeScript 脚本中，查询到的封面地址直接写入 `ktv_songs.cover_image_url`。数据库已经精简为 `ktv_songs` 单表保存 NAS 曲库，封面相关字段只保留：

- `cover_image_url`
- `cover_updated_at`

下一步目标是把所有 NAS 歌曲的封面下载到本地缓存，让控制端读取稳定的本地图片 URL，而不是依赖外部音乐平台图片地址。

## 设计选择

新增 Python 脚本 `scripts/tools/fetch_song_covers.py`，替代现有 TS 批量封面脚本。

原因：

- 和现有风格标签 Python 脚本保持一致，便于服务器上直接运行。
- 只依赖 Python 标准库和 `psql`，不引入新的 pip 依赖。
- 可以自然记录 JSONL 进度，支持中断后继续。

## 数据流

1. 从 `ktv_songs` 读取 `missing_at is null` 的 NAS 歌曲。
2. 对每首歌先检查本地缓存文件：
   - 文件存在且数据库 URL 正确：跳过。
   - 文件存在但数据库 URL 不正确：只修复数据库。
3. 如果 `cover_image_url` 已经是外部图片 URL，先尝试下载这个外链。
4. 如果没有可用外链，则按 provider 顺序搜索封面：
   - `tencent`
   - `kugou`
   - `kuwo`
5. 下载成功后写入：
   - 本地文件：`<MEDIA_ROOT>/covers/nas/<song-id>.jpg`
   - 数据库：`ktv_songs.cover_image_url = <PUBLIC_BASE_URL>/media/covers/nas/<song-id>.jpg`
   - 数据库：`ktv_songs.cover_updated_at = now()`
6. 未命中或失败时不写封面 URL，只更新 `cover_updated_at`，同时把结果追加到 JSONL 日志。

## 本地图片路由

后端新增：

```text
GET /media/covers/nas/:songId
```

路由只读取 `MEDIA_ROOT/covers/nas/<songId>.jpg`，不会访问 NAS 视频目录。`songId` 不允许包含 `/`、`.` 或路径分隔符，避免路径穿越。

## 进度与重复运行

脚本默认写：

```text
runtime/covers/song-covers.jsonl
runtime/covers/song-covers.state.json
```

每首歌处理完成后追加一行 JSONL：

```json
{"songId":"...","status":"found","provider":"tencent","publicUrl":"...","createdAt":"..."}
```

重复运行时：

- 本地文件存在且数据库 URL 正确：跳过。
- 本地文件存在但数据库 URL 缺失或不正确：修复数据库。
- 上次 `not_found` 默认跳过，传 `--retry-not-found` 可重试。
- 上次 `failed` 默认跳过，传 `--retry-failed` 可重试。
- `--force` 会重新处理当前选择范围。

## 命令入口

保留现有命令语义：

```bash
pnpm covers:songs -- --limit 300
pnpm covers:coverage -- --limit 100
```

底层改为：

```bash
python3 scripts/tools/fetch_song_covers.py fetch
python3 scripts/tools/fetch_song_covers.py coverage
```

## 边界

- 第一版不实现网易云 provider。网易云搜索需要加密请求，当前收益不足；腾讯、酷狗、酷我可以覆盖大部分封面。
- 不新增数据库字段，不保存 provider payload、置信度或错误详情。调试信息保存在 JSONL。
- 不在首页接口实时访问外部平台。
