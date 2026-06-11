# scripts/tools 工具脚本说明

这个目录放项目级工具脚本，主要用于部署自检、真实服务器 smoke、视觉截图、封面批处理、风格标签批处理和仓库卫生检查。这里的脚本不是业务运行时主流程，但很多会被 `package.json`、`deploy/source/ktv.sh` 或 `deploy/docker/ktv.sh` 调用。

原则：

- 正式可复用工具放在这里，并配套测试或 runbook。
- 临时调研输出、日志、截图和批处理结果不要放进这个目录；它们应写到 `runtime/`、`logs/` 或其它已忽略目录。
- Python 批处理脚本负责长任务和外部接口批量调用；Node 脚本主要负责部署、Web smoke 和浏览器截图检查。

## 脚本总览

| 文件 | 作用 | 常用入口 |
| --- | --- | --- |
| `deploy-doctor.mjs` | 部署环境自检，检查 env、CORS、媒体路径、服务状态和公开 URL。 | `pnpm deploy:doctor` / `bash deploy/source/ktv.sh doctor` |
| `web-deploy-smoke.mjs` | 部署后的公开入口 smoke，验证 CORS、TV bootstrap、heartbeat、控制端看到 TV 在线、推荐列表非空。 | `pnpm deploy:smoke` / `bash deploy/source/ktv.sh smoke` |
| `repo-hygiene-check.mjs` | 提交前仓库卫生检查，区分 tracked dirty、高风险未跟踪文件和本地运行产物。 | `pnpm repo:hygiene` |
| `fetch_song_covers.py` | 批量查询、下载并缓存歌曲封面，也支持单首歌封面探测；把本地公开封面 URL 写回 `ktv_songs.cover_image_url`。 | `bash deploy/source/ktv.sh fetch-covers -- ...` / `python3 scripts/tools/fetch_song_covers.py probe 夜之光 花姐` |
| `generate_cover_thumbnails.py` | 把 NAS 封面原图批量压缩成固定 `160x160` JPEG 缩略图；默认跳过已生成且比原图新的文件，可重复运行续跑。 | `bash deploy/source/ktv.sh cover-thumbnails -- --source-root runtime/media/covers/nas --concurrency 20` |
| `fetch_hot_song_candidates.py` | Python 入口，复用 `packages/hot-songs` 现有流水线，并发抓热门歌曲来源后输出总榜候选。 | `python3 scripts/tools/fetch_hot_song_candidates.py collect --concurrency 10` |
| `fetch_chart_scores.py` | 抓取中文主流音乐平台全部榜单，按歌曲在不同榜单出现次数累计积分，输出聚合 CSV 供曲库清理筛选。 | `python3 scripts/tools/fetch_chart_scores.py collect --platforms qq,kugou,kuwo,migu --concurrency 10` |
| `fetch_playlist_scores.py` | 抓取中文主流音乐平台的用户歌单歌曲，支持关键词搜歌单和直接抓歌单链接/ID，按歌曲在不同歌单出现次数累计积分。 | `python3 scripts/tools/fetch_playlist_scores.py collect --keywords 周杰伦 --concurrency 10` |
| `merge_music_scores.py` | 合并热门歌曲、全部榜单、歌单三份积分产物，按歌曲名+歌手去重，输出总分表。 | `python3 scripts/tools/merge_music_scores.py merge --hot-input <dir> --chart-input <dir> --playlist-input <dir>` |
| `delete_uncovered_songs.py` | 根据待删 CSV 执行删歌，删除数据库记录、封面缓存和 NAS 媒体文件；支持 `plan` 和 `apply`。 | `python3 scripts/tools/delete_uncovered_songs.py plan --input runtime/.../delete-uncovered-songs.csv` |
| `run_style_tagging_llm_batch.py` | 离线批量给歌曲补风格标签，先生成 JSONL，再导入 `ktv_songs.style_tags`。 | `pnpm ktv:tags:llm-batch:py -- ...` |
| `android_app_icon_pipeline.py` | 从生成图候选中裁切 Android TV 应用图标，重建透明圆角，生成 launcher WebP 和 TV banner PNG，并执行 TinyPNG 类压缩。 | `python3 scripts/tools/android_app_icon_pipeline.py --candidate 1` |
| `ui-visual-check.mjs` | 控制端和 Admin 的 Chrome 截图检查。 | `pnpm ui:visual-check` |
| `tv-visual-check.mjs` | Web TV 的 Chrome 截图检查。 | `pnpm tv:visual-check` |
| `real-mv-playback-risk-spike.mjs` | 真实 MV 播放兼容性调研，输出 Markdown 风险报告。 | `pnpm real-mv:risk-spike -- ...` |
| `source-deployment-docs.test.mjs` | 源码部署文档和部署脚本的契约测试。 | `node --test scripts/tools/source-deployment-docs.test.mjs` |

`*.test.mjs` 和 `*_test.py` 是对应工具的测试文件，不是生产脚本入口。

## 测试文件清单

| 文件 | 覆盖内容 |
| --- | --- |
| `deploy-doctor.test.mjs` | 部署 doctor 的 env 解析、CORS、媒体路径、网络重试、服务状态和 KTV 索引诊断输出。 |
| `web-deploy-smoke.test.mjs` | Web smoke 的 CORS、页面可达性、TV bootstrap/heartbeat、控制端 session 和 discovery 检查。 |
| `repo-hygiene-check.test.mjs` | Git 状态解析、高风险未跟踪路径识别和 dirty 报告。 |
| `fetch_song_covers_test.py` | 封面路径、公开 URL、并发调度、图片校验、历史跳过、匹配评分、provider fallback、单首探测和 JSONL 历史读取。 |
| `generate_cover_thumbnails_test.py` | 缩略图脚本的 CLI 默认值、跳过/覆盖规划和固定尺寸 JPEG 输出。 |
| `fetch_hot_song_candidates_test.py` | 热门歌曲 Python 入口的 CLI 默认值、来源筛选、并发调度和聚合报告格式。 |
| `fetch_chart_scores_test.py` | 榜单积分脚本的 CLI 默认值、并发调度、歌曲归一化、积分聚合和各平台榜单解析契约。 |
| `fetch_playlist_scores_test.py` | 歌单积分脚本的 CLI 默认值、歌单引用解析、并发调度、歌曲归一化、积分聚合和各平台歌单解析契约。 |
| `merge_music_scores_test.py` | 三份积分 CSV 的路径解析、归一化去重、分数合并和本地输出写入。 |
| `delete_uncovered_songs_test.py` | 待删 CSV 读取、路径转换、删除 SQL 模板和 dry-run 报告输出。 |
| `run_style_tagging_llm_batch_test.py` | LLM 标签批处理的短 ID prompt、返回校验、标签过滤和导入 SQL。 |
| `android_app_icon_pipeline_test.py` | Android TV 应用图标生成脚本的候选裁切、输出文件和尺寸契约。 |
| `ui-visual-check.test.mjs` | 控制端视觉截图 URL 的 pairing token 刷新和错误处理。 |
| `real-mv-playback-risk-spike.test.mjs` | MV 播放风险报告的 controlled/local sample 输出。 |
| `source-deployment-docs.test.mjs` | 源码部署文档、部署 wrapper、Vite preview 端口和旧 Docker app 停止策略。 |

## android_app_icon_pipeline.py

`android_app_icon_pipeline.py` 用于把 AI 生成的应用图标候选图整理成 Android TV 可直接使用的资源。脚本本身用 Python 编写，图像处理依赖 Pillow；如果本机安装了 `cwebp`、`pngquant`、`oxipng`，会自动做有损 WebP、PNG 调色板量化和 PNG 二次优化，效果接近 TinyPNG 的本地处理流程。

核心逻辑：

1. 默认读取仓库归档源图；如果传入横排候选图，则按编号裁出指定图标。
2. 缩放成 1024x1024 源图，并重建真正透明的圆角 alpha。
3. 生成 Android launcher 所需的 48/72/96/144/192 WebP。
4. 生成 Android TV banner 使用的 432x243 PNG。
5. 保存压缩后的源图到 `docs/assets/app-icons/home-ktv-app-icon-source.png`，方便后续追溯。

首次使用建议安装依赖：

```bash
python3 -m pip install --user Pillow
brew install webp pngquant oxipng
```

常用命令：

```bash
python3 scripts/tools/android_app_icon_pipeline.py --candidate 1
python3 scripts/tools/android_app_icon_pipeline.py --source /path/to/generated-sheet.png --candidate 1 --webp-quality 78
```

相关测试：

```bash
python3 -m unittest scripts.tools.android_app_icon_pipeline_test
```

## deploy-doctor.mjs

`deploy-doctor.mjs` 用来回答“当前部署环境是否具备启动和访问 HomeKTV 的基本条件”。它支持 Docker 和源码部署两种模式。

核心逻辑：

1. 读取部署 `.env`。
2. 组装 API、Admin、Controller、TV Web、媒体路径和路径映射配置。
3. 检查必需环境变量是否存在。
4. 检查 CORS 是否包含前端来源。
5. 检查媒体路径和 NAS 映射。
6. 可选执行服务状态命令。
7. 可选访问公开 URL 和 KTV 索引诊断。

常用命令：

```bash
node scripts/tools/deploy-doctor.mjs --mode source --env-file deploy/source/.env
node scripts/tools/deploy-doctor.mjs --mode docker --env-file deploy/docker/.env --json
```

源码部署 wrapper 会调用它：

```bash
bash deploy/source/ktv.sh doctor
```

相关测试：

```bash
node --test scripts/tools/deploy-doctor.test.mjs
```

## web-deploy-smoke.mjs

`web-deploy-smoke.mjs` 是每次部署后通知测试前要跑的公开入口 smoke。它不是只检查页面 200，而是会模拟 TV 和控制端的最小联动。

核心逻辑：

1. 检查 Controller 和 TV Web 来源的 CORS。
2. 检查 TV Web 和 Controller 静态页面可访问。
3. 检查前端构建产物里嵌入的默认 API base URL。
4. 调用 `/player/bootstrap` 注册一台临时 TV。
5. 调用 `/player/heartbeat` 上报 TV 在线。
6. 用 pairing token 创建控制端 session，并确认控制端看到 TV 在线。
7. 调用歌曲 discovery，确认推荐列表非空。

常用命令：

```bash
node scripts/tools/web-deploy-smoke.mjs \
  --api-base-url https://ktv-api.shaolongfei.com \
  --controller-base-url https://ktv-controller.shaolongfei.com \
  --tv-web-base-url https://ktv-tv.shaolongfei.com \
  --room living-room
```

源码部署 wrapper 会调用它：

```bash
bash deploy/source/ktv.sh smoke
```

相关测试：

```bash
node --test scripts/tools/web-deploy-smoke.test.mjs
```

## repo-hygiene-check.mjs

`repo-hygiene-check.mjs` 用于提交或部署前检查仓库是否混入了不该提交的内容。

核心逻辑：

1. 读取 `git status --porcelain`。
2. 区分 tracked dirty 和 untracked。
3. 把 `apps/`、`clients/`、`packages/`、`deploy/`、`scripts/`、`docs/` 等目录下的未跟踪文件标为高风险。
4. 列出 `runtime/`、`logs/`、`songs-sample/` 等本地运行目录。
5. `--fail-on-dirty` 模式下，如果存在 tracked dirty 或高风险未跟踪文件，就以非 0 退出。

常用命令：

```bash
pnpm repo:hygiene
pnpm repo:hygiene -- --fail-on-dirty
```

详细规则见 [仓库卫生 Runbook](../../docs/runbooks/repo-hygiene.md)。

相关测试：

```bash
node --test scripts/tools/repo-hygiene-check.test.mjs
```

## fetch_song_covers.py

`fetch_song_covers.py` 用于批量补歌曲封面。当前只处理 NAS 曲库，把图片下载到本地缓存目录，再把公开图片地址写回 `ktv_songs.cover_image_url`。

核心逻辑：

1. 从 `ktv_songs` 读取 `missing_at is null`、歌名和主歌手非空的歌曲。
2. 读取历史 JSONL，默认跳过上次 `failed` 或 `not_found` 的歌曲，避免重复打外部源。
3. 如果本地已有封面文件但数据库 URL 不一致，只修复数据库 URL。
4. 如果数据库已有外部图片 URL，优先尝试下载该外链。
5. 否则按 provider 顺序查询：`netease`、`cloud`、`tencent`、`kugou`、`kuwo`、`spotify`。
6. 候选结果先在全部 provider 中按歌名和歌手严格匹配；严格匹配都没有命中时，再按 provider 顺序退回只按歌名匹配。
7. 下载图片到 `$MEDIA_ROOT/covers/nas/<song-id>.jpg`。
8. 写回 `ktv_songs.cover_image_url` 和 `cover_updated_at`。
9. 每首歌向 JSONL 追加一行结果，并周期性刷新 state 文件。

子命令：

- `fetch`：实际下载封面并写数据库。
- `coverage`：只测 provider 覆盖率，不写数据库。
- `probe`：单首歌探测，按同一套 provider 顺序返回首个可用封面，可选下载图片。
- `status`：打印数据库覆盖情况和历史任务摘要。

常用命令：

```bash
bash deploy/source/ktv.sh cover-status
bash deploy/source/ktv.sh cover-coverage -- --limit 100 --concurrency 4 --delay-ms 200
bash deploy/source/ktv.sh fetch-covers -- --limit 1000 --concurrency 4 --delay-ms 150
python3 scripts/tools/fetch_song_covers.py probe 冲动的惩罚 刀郎 --providers netease,cloud --netease-base-url http://127.0.0.1:4300
python3 scripts/tools/fetch_song_covers.py probe 夜之光 花姐 --providers cloud --download runtime/probes/night-light.jpg
bash deploy/source/ktv.sh cover-coverage -- --providers netease,cloud,spotify --limit 100 --delay-ms 100
```

`spotify` provider 会优先使用 `SpotifyScraper` 的公开接口读取 track 信息和专辑图片。如果当前 Python 环境未安装该库，脚本仍可使用 Spotify 搜索结果里的封面 URL 作为兜底；需要启用完整能力时安装：

```bash
python3 -m pip install --user spotifyscraper
```

服务器如果提示 `externally-managed-environment`，使用：

```bash
python3 -m pip install --user --break-system-packages spotifyscraper
```

详细运行和重跑策略见 [歌曲封面缓存 Runbook](../../docs/runbooks/song-cover-fetching.md)。

相关测试：

```bash
python3 scripts/tools/fetch_song_covers_test.py
```

## generate_cover_thumbnails.py

`generate_cover_thumbnails.py` 用于把已经缓存到本地的 NAS 封面原图生成控制端首屏使用的小缩略图。数据库仍只保存原图地址 `ktv_songs.cover_image_url`，API 会把本地原图地址 `/media/covers/nas/<song-id>.jpg` 派生为 `/media/covers/nas/thumbs/<song-id>.jpg`，控制端优先加载缩略图，失败时再回退原图。

核心逻辑：

1. 扫描 `--source-root` 下的 `*.jpg` 原图。
2. 输出到 `--output-root`，默认是源目录下的 `thumbs/`。
3. 使用 Pillow 按比例缩放并居中填充到固定 `160x160`。
4. 生成 progressive JPEG，默认 `quality=82`。
5. 默认跳过已经存在且更新时间不早于原图的缩略图；需要重建时加 `--overwrite`。
6. 使用线程池并发处理，默认 `--concurrency 20`。

服务器常用命令：

```bash
bash deploy/source/ktv.sh cover-thumbnails -- \
  --source-root /opt/home-ktv-system/runtime/media/covers/nas \
  --output-root /opt/home-ktv-system/runtime/media/covers/nas/thumbs \
  --size 160 \
  --concurrency 20
```

如果缺少 Pillow：

```bash
python3 -m pip install --user pillow
```

相关测试：

```bash
python3 scripts/tools/generate_cover_thumbnails_test.py
```

## fetch_chart_scores.py

`fetch_chart_scores.py` 用于离线抓取中文主流音乐平台的榜单歌曲，并按“同一首歌每出现在一个榜单里记 10 分”的规则输出聚合结果，作为后续曲库淘汰的基础表单。

当前脚本入口只提供 `collect` 子命令，默认 `--concurrency 10`。第一版支持：

- `qq`
- `kugou`
- `kuwo`
- `migu`
- `netease`（依赖本地 `NeteaseCloudMusicApiBackup`，默认 `http://127.0.0.1:4300`）

核心逻辑：

1. 拉取各平台榜单入口，枚举全部榜单。
2. 逐个榜单抓歌名和歌手。
3. 对歌名和歌手做归一化，去掉常见噪音，如 `Live`、`DJ版`、括号版型差异、全半角差异、空白差异。
4. 同一榜单内重复歌曲只计一次分。
5. 汇总到 `runtime/chart-scores/run-时间戳/` 或显式 `--output` 目录。

输出文件：

- `source-report.json`：每个平台/榜单抓取状态，便于看哪些源失败
- `chart-rows.json`：原始榜单行
- `aggregated-songs.csv`：最终积分表

常用命令：

```bash
python3 scripts/tools/fetch_chart_scores.py collect
python3 scripts/tools/fetch_chart_scores.py collect --platforms qq,kugou,kuwo,migu --concurrency 10 --output runtime/chart-scores/smoke
python3 scripts/tools/fetch_chart_scores.py collect --platforms netease --netease-base-url http://127.0.0.1:4300
```

常用参数：

- `--platforms`：逗号分隔的平台列表，默认 `netease,qq,kugou,kuwo,migu`
- `--per-source-points`：每命中一个榜单加多少分，默认 `10`
- `--output`：输出目录
- `--request-timeout-ms`：单请求超时，默认 `8000`
- `--delay-ms`：请求之间的延迟，默认 `300`
- `--concurrency`：榜单抓取并发数，默认 `10`
- `--max-kugou-pages`：酷狗榜单最多翻页数，默认 `50`
- `--netease-base-url`：本地网易云 API 地址

说明：

- `netease` 在本机未启动 API 时不会让整次任务失败，而会在 `source-report.json` 里记录 discovery error。
- 2026-06-03 本地 smoke 已验证 `qq`、`kugou`、`kuwo`、`migu` 可抓取到真实榜单数据；`netease` 在当前机器上因 `127.0.0.1:4300` 未启动而返回连接失败记录。

相关测试：

```bash
python3 scripts/tools/fetch_chart_scores_test.py
```

## fetch_playlist_scores.py

`fetch_playlist_scores.py` 用于离线抓取歌单里的歌曲，并按“同一首歌每出现在一个歌单里记 10 分”的规则输出聚合结果。它和榜单脚本、热门歌曲脚本分开维护，后续再由单独的合并脚本统一汇总三份产物。

当前脚本入口只提供 `collect` 子命令，默认 `--concurrency 10`。第一版支持两种模式：

- 关键词搜歌单：
  - `netease`
  - `kuwo`
- 直接抓歌单链接或 ID：
  - `netease`
  - `qq`
  - `kugou`
  - `kuwo`

核心逻辑：

1. 读取关键词和歌单链接 / ID 输入。
2. 对 `netease`、`kuwo` 做关键词搜歌单，拿前 N 个歌单。
3. 对发现的歌单和直接输入的歌单，拉取其中歌曲的歌名和歌手。
4. 对歌名和歌手做归一化，去掉常见噪音，如 `Live`、`DJ版`、括号版型差异、全半角差异、空白差异。
5. 同一歌单内重复歌曲只计一次分。
6. 汇总到 `runtime/playlist-scores/run-时间戳/` 或显式 `--output` 目录。

输出文件：

- `source-report.json`：每个平台 / 歌单抓取状态，便于看哪些源失败
- `playlist-rows.json`：原始歌单歌曲行
- `aggregated-songs.csv`：最终积分表

常用命令：

```bash
python3 scripts/tools/fetch_playlist_scores.py collect --keywords 周杰伦
python3 scripts/tools/fetch_playlist_scores.py collect \
  --keywords 周杰伦 \
  --keywords 林俊杰 \
  --search-limit-per-keyword 20 \
  --concurrency 10 \
  --netease-base-url http://127.0.0.1:4300
python3 scripts/tools/fetch_playlist_scores.py collect \
  --playlist-urls https://music.163.com/#/playlist?id=123456 \
  --playlist-urls https://y.qq.com/n/ryqq/playlist/987654321
python3 scripts/tools/fetch_playlist_scores.py collect \
  --keywords-file runtime/playlist-inputs/keywords.txt \
  --playlist-urls-file runtime/playlist-inputs/playlist-urls.txt
```

常用参数：

- `--keywords`：关键词，可重复传入，也支持逗号分隔
- `--keywords-file`：关键词文件，每行一个
- `--playlist-urls`：歌单链接、平台前缀 ID，如 `qq:12345`，可重复传入
- `--playlist-urls-file`：歌单链接 / ID 文件，每行一个
- `--keyword-platforms`：关键词搜歌单的平台，默认 `netease,kuwo`
- `--direct-platforms`：直接抓歌单的平台，默认 `netease,qq,kugou,kuwo`
- `--search-limit-per-keyword`：每个平台每个关键词最多抓多少个歌单，默认 `10`
- `--per-source-points`：每命中一个歌单加多少分，默认 `10`
- `--output`：输出目录
- `--request-timeout-ms`：单请求超时，默认 `8000`
- `--delay-ms`：请求之间的延迟，默认 `300`
- `--concurrency`：歌单抓取并发数，默认 `10`
- `--fetch-concurrency`：旧参数别名，优先级高于 `--concurrency`
- `--netease-base-url`：网易云 API 地址

说明：

- `netease` 关键词搜歌单和歌单详情依赖 `NeteaseCloudMusicApiBackup`。
- `kuwo` 关键词搜歌单和歌单详情会调用仓库内调研代码里的 `kuwo.js` 生成 `reqId` 和 `Secret`。
- `qq`、`kugou` 在第一版里只支持直接歌单抓取，不支持关键词搜歌单。
- 关键词命中的同一歌单如果重复出现，只会按一个歌单计分，不会重复加分。

相关测试：

```bash
python3 scripts/tools/fetch_playlist_scores_test.py
```

## fetch_hot_song_candidates.py

`fetch_hot_song_candidates.py` 是热门歌曲工具的 Python 编排入口。它不会重写 `packages/hot-songs` 的采集/归一化/融合逻辑，而是：

1. 读取 `packages/hot-songs/config/sources.example.json`
2. 按 source 并发调用现有 `pnpm hot-songs:sources -- --source <id>`
3. 合并 `source-rows.json` 和 `source-report.json`
4. 继续调用现有 `hot-songs:normalize` 和 `hot-songs:fuse`
5. 在一个输出目录里保留完整中间产物和最终 `ranked-songs.csv`

默认并发是 `10`。这让三个音乐抓取脚本都统一成 Python 入口和相同的并发参数风格。

输出目录：

- `source-rows.json`
- `source-report.json`
- `normalized/candidate-snapshot.json`
- `fused/ranked-songs.csv`
- `ranked-songs.csv`
- `ranked-songs.audit.json`
- `near-duplicates.csv`

常用命令：

```bash
python3 scripts/tools/fetch_hot_song_candidates.py collect
python3 scripts/tools/fetch_hot_song_candidates.py collect --concurrency 10 --output runtime/hot-song-candidates/smoke
python3 scripts/tools/fetch_hot_song_candidates.py collect --source qq-hot-toplist --source kugou-top500
python3 scripts/tools/fetch_hot_song_candidates.py collect --fixture --output runtime/hot-song-candidates/fixture
```

常用参数：

- `--manifest`：热门歌曲来源 manifest，默认 `packages/hot-songs/config/sources.example.json`
- `--output`：输出目录
- `--concurrency`：来源并发数，默认 `10`
- `--timeout-ms`：传给底层单来源抓取的超时，默认 `10000`
- `--source`：只抓指定来源，可重复传入
- `--fixture`：底层用 fixture 数据跑，不访问真实网络
- `--aliases`：融合时传入 alias 文件

相关测试：

```bash
python3 scripts/tools/fetch_hot_song_candidates_test.py
```

## merge_music_scores.py

`merge_music_scores.py` 用于把三份已经抓好的积分结果合并成一张总表：

- `fetch_hot_song_candidates.py` 的 `ranked-songs.csv`
- `fetch_chart_scores.py` 的 `aggregated-songs.csv`
- `fetch_playlist_scores.py` 的 `aggregated-songs.csv`

它不访问网络，也不重新抓取数据，只做本地读表、归一化去重和分数相加。

合并规则：

1. 用和榜单/歌单脚本一致的歌曲归一化规则构造 `normalized_key`
2. 按 `歌曲名 + 歌手` 去重
3. `score = hot_score + chart_score + playlist_score`

输入既可以是 CSV 文件，也可以是对应脚本的输出目录：

- 热门歌曲目录会自动读取 `ranked-songs.csv`
- 榜单目录会自动读取 `aggregated-songs.csv`
- 歌单目录会自动读取 `aggregated-songs.csv`

输出目录：

- `merged-songs.csv`
- `merge-report.json`

`merged-songs.csv` 字段：

- `title`
- `artist_name`
- `score`
- `hot_score`
- `chart_score`
- `playlist_score`
- `normalized_key`

常用命令：

```bash
python3 scripts/tools/merge_music_scores.py merge \
  --hot-input runtime/hot-song-candidates/fixture-20260603 \
  --chart-input runtime/chart-scores/smoke-20260603 \
  --playlist-input runtime/playlist-scores/smoke-20260603

python3 scripts/tools/merge_music_scores.py merge \
  --hot-input runtime/hot-song-candidates/fixture-20260603/ranked-songs.csv \
  --chart-input runtime/chart-scores/smoke-20260603/aggregated-songs.csv \
  --playlist-input runtime/playlist-scores/smoke-20260603/aggregated-songs.csv \
  --output runtime/merged-music-scores/smoke
```

相关测试：

```bash
python3 scripts/tools/merge_music_scores_test.py
```

## delete_uncovered_songs.py

`delete_uncovered_songs.py` 用于消费 `delete-uncovered-songs.csv` 这类待删清单，并真正执行清理。它默认假设：

- 数据库在 `dev`，通过 `docker exec home-ktv-postgres-1 psql` 删除 `queue_entries` 和 `ktv_songs`
- 封面缓存也在 `dev`，路径默认 `/opt/home-ktv-system/runtime/media/covers/nas`
- NAS 媒体文件在 `pve`，把 CSV 里的 `/mnt/nas/...` 转成 `/hdd-pool/nas/...` 再删除

子命令：

- `plan`：只读 CSV，输出待删歌曲数、封面数、媒体文件数和体积汇总
- `apply`：实际删除数据库记录、封面文件和 NAS 媒体文件

常用命令：

```bash
python3 scripts/tools/delete_uncovered_songs.py plan \
  --input runtime/merged-music-scores/final-20260603/delete-uncovered-songs.csv

python3 scripts/tools/delete_uncovered_songs.py apply \
  --input runtime/merged-music-scores/final-20260603/delete-uncovered-songs.csv
```

输出：

- 默认会在输入 CSV 同目录写 `delete-uncovered-songs.plan.json` 或 `delete-uncovered-songs.apply.json`
- `apply` 报告里会包含数据库删除数量、封面删除结果和媒体文件删除结果

相关测试：

```bash
python3 scripts/tools/delete_uncovered_songs_test.py
```

## run_style_tagging_llm_batch.py

`run_style_tagging_llm_batch.py` 用于离线批量给歌曲补风格标签。它不在 API 请求链路里调用 LLM，而是先批量生成 JSONL，再显式导入数据库，降低长任务失败对数据库的影响。

核心逻辑：

1. 从 `ktv_songs` 选择当前标签数量少于阈值的歌曲。
2. 按 batch 组装给 LLM 的 prompt。
3. prompt 内使用短 ID，避免把真实 song id 暴露给模型或让模型回写错误长 ID。
4. 校验 LLM 返回 JSON，只保留预定义 taxonomy 里的标签。
5. 把结果追加到 JSONL，并刷新 state 文件。
6. `import` 阶段验证 JSONL 后，把标签写入 `ktv_songs.style_tags`。

子命令：

- `status`：查看候选数量和任务状态。
- `run`：调用 LLM 生成标签 JSONL。
- `import`：导入 JSONL 到数据库；默认 dry-run，必须显式 `--apply` 才写库。
- `run-and-import`：先 run 再 import。

常用命令：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py status --env-file deploy/source/.env
python3 scripts/tools/run_style_tagging_llm_batch.py run --env-file deploy/source/.env --max-existing-tags 1 --batch-size 30
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --dry-run
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --apply
```

相关测试：

```bash
python3 scripts/tools/run_style_tagging_llm_batch_test.py
```

## ui-visual-check.mjs

`ui-visual-check.mjs` 用 Chrome headless 截图检查控制端和 Admin 的基本视觉状态。

核心逻辑：

1. 读取 Admin URL、API URL、控制端 URL 和 Chrome 路径。
2. 如果没有传 `MOBILE_VISUAL_URL`，会调用 API 刷新 pairing token，拿到带 token 的控制端 URL。
3. 用 Chrome 分别截手机控制端和 Admin 的几个视口。
4. 检查截图文件存在且非空。

常用命令：

```bash
pnpm ui:visual-check
MOBILE_VISUAL_URL="https://ktv-controller.shaolongfei.com/controller?token=..." pnpm ui:visual-check
```

输出目录：

```text
logs/visual/
```

相关测试：

```bash
node --test scripts/tools/ui-visual-check.test.mjs
```

## tv-visual-check.mjs

`tv-visual-check.mjs` 用 Chrome headless 截图检查 Web TV 调试端。

核心逻辑：

1. 读取 `TV_VISUAL_URL` 和 `CHROME_BIN`。
2. 用固定 TV 视口截图。
3. 检查截图文件存在且非空。

常用命令：

```bash
pnpm tv:visual-check
TV_VISUAL_URL="https://ktv-tv.shaolongfei.com/" pnpm tv:visual-check
```

输出目录：

```text
logs/visual/
```

## real-mv-playback-risk-spike.mjs

`real-mv-playback-risk-spike.mjs` 用于真实 MV 播放风险调研，尤其是 MKV/MPG 兼容性和浏览器音轨切换能力。

核心逻辑：

1. 检查 Chrome 的 `canPlayType` 和 `audioTracks` 支持。
2. 可生成受控 fixture 做最小能力验证。
3. 如果提供本地 MKV/MPG 样本，使用 `ffprobe` 做媒体信息摘要。
4. 可选用数据库 URL 交叉检查 NAS 索引里的真实文件信息。
5. 输出 Markdown 风险报告。

常用命令：

```bash
pnpm real-mv:risk-spike -- --controlled-only --output runtime/reports/real-mv-risk.md
MEDIA_ROOT=/path/to/media pnpm real-mv:risk-spike -- --output runtime/reports/real-mv-risk.md
pnpm real-mv:risk-spike -- --sample-mkv sample.mkv --sample-mpg sample.mpg --output runtime/reports/real-mv-risk.md
```

相关测试：

```bash
node --test scripts/tools/real-mv-playback-risk-spike.test.mjs
```

## source-deployment-docs.test.mjs

这个文件是源码部署相关文档和脚本的契约测试，不是工具入口。它防止部署文档、源码部署 wrapper、Vite preview 端口和旧 Docker 容器停止策略出现回退。

覆盖点：

- `deploy/source/ktv.sh help` 需要包含一键 deploy 和 smoke。
- `docs/deployment.md` 和 `docs/runbooks/deploy-lxc-dev.md` 需要明确源码部署是服务器默认路径。
- 源码部署 preview 命令需要把端口正确传给 Vite。
- 源码部署停止旧 Docker app 容器时不能停止 PostgreSQL。
- Admin、Controller、TV Web 的 Vite 配置需要允许部署域名。

运行：

```bash
node --test scripts/tools/source-deployment-docs.test.mjs
```

## 常用验证命令

改动这些脚本后，按影响范围运行：

```bash
node --test scripts/tools/*.test.mjs
python3 scripts/tools/fetch_song_covers_test.py
python3 scripts/tools/run_style_tagging_llm_batch_test.py
pnpm repo:hygiene
```

涉及部署链路时，再跑：

```bash
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh smoke
```
