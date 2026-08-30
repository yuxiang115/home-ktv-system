# TV 歌词渲染(KTV 式同步歌词)实施计划

> **给接手的 agent:** 本文档自包含。每完成一个任务把 `[ ]` 改成 `[x]`,并在「执行记录」补充差异。

## 状态跟踪

- [x] Task 1: API `GET /media/ktv-index/:assetId/lyrics` 路由
- [x] Task 2: TV 端 LRC 解析 + fetchSongLyrics + LyricsOverlay + App 接线
- [x] Task 3: lrclib-client.ts 抽取 + backfill-lyrics.mjs 存量回填
- [x] Task 4: 单测 + 全量验证 + 回填 + 重启

## 追加(2026-08-14):逐字扫光

用户要求 KTV 式"一个字一个字高亮"。LRC 只有行级时间戳,采用行内线性插值:
`lyricLineSpan`(startMs=本行, endMs=下一行, 末行 +10s)+ `lyricLineProgress`(0..1),
LyricsOverlay 当前行用 `linear-gradient(90deg, accent p%, muted p%)` + `background-clip: text`
实现扫光,p 随进度推进,已唱亮色/未唱底色。TV 播放帧 tick 已提前到 200ms。

## Goal

补完歌词链路最后一环:TV 端播放时显示 KTV 式同步滚动歌词(知道什么时候唱什么)。
上游已就绪:supplement worker 的 lyrics 阶段(LRCLIB)写 `.lrc` 并 UPDATE `ktv_songs.lyric_file`
(migration 0026 的列已存在)。存量 2 首歌(演員/童话)在 lyrics 阶段上线前处理,`lyric_file` 为空,需脚本回填。

## 背景(接手须知)

- 基线 commit:`5e0dfaf`(feat: online supplement pipeline)。工作区此后应无未提交改动。
- **DB**:`ktv_songs.lyric_file text`(migration `0026_ktv_songs_lyric_file.sql`),`_online` 歌曲的 mkv 与 `.lrc` 同目录(`home-ktv-media/_online/歌手-歌名-语种-分类.mkv`)。
- **index-handler**(apps/api/src/modules/online-supplement/handlers/index-handler.ts):入库时把 `_lyrics/<taskId>.lrc` 拷为 `<onlineDir>/<safeName>.lrc` 并写 lyric_file。probe 后清理中间产物。
- **LyricsStageHandler**(handlers/lyrics-handler.ts):LRCLIB 三级请求链 get(带时长)→get(不带)→search;名字取自 `supplementSearchNames`(llmRenamedTitle `歌手-歌名-语种-分类` 切段,`_`→空格)。尽力而为不阻塞。
- **媒体路由**(apps/api/src/routes/media.ts):已有 `/media/ktv-index/:id/raw`(`PgKtvIndexRawAssetRepository.findRawAssetById` 只查 id/file_path)+ `/media/nas/:assetId`。`MediaPathResolver.resolveAssetFile` 做根目录安全校验。
- **TV 播放运行时**(apps/tv-web/src/runtime/use-tv-playback-runtime.ts):`playbackPositionMs` 每秒 tick(1s interval)+ remux 切换时含 `activePositionBaseMs` 基准——歌词跟随用这个值,切伴奏不漂移。快照每秒广播,不把歌词塞 snapshot。
- **TV 组件**:PlayingScreen.tsx(inline styles + tvTheme),footer 在底部;歌词覆盖层放 footer 上方。App.tsx 持有 activeVideoRef/standbyVideoRef,`runtime.snapshot.currentTarget.assetId` 标识当前歌。
- **player-client.ts**(tv-web):`fetchSnapshot`/`getJson` 已有,apiBaseUrl 从 location 推导。

## 已确认决策

- 歌词样式:**KTV 式 3 行滚动窗口**(当前行大字高亮,上一行淡、下一行预示);200ms 自刷新
- 回填范围:**仅 `_online` 存量**(演員/童话);NAS 大库不做
- 传输:TV 按歌 `GET` 拉一次文本(404=无歌词静默),不进 snapshot 广播
- 渲染端:tv-web(浏览器);android-tv 客户端后续另说

## 任务详情

### Task 1: API 歌词路由

- media.ts:`PgKtvIndexRawAssetRepository.findRawAssetById` 增查 `lyric_file`(row 带 `lyricFile: string | null`);新增 `GET /media/ktv-index/:assetId/lyrics`:row 无 lyricFile → 404 `{error:"LYRICS_NOT_FOUND"}`;`mediaPathResolver.resolveAssetFile(lyricFile)` 失败按现有 `sendRawMediaPathError`;成功读文件返回 `text/plain; charset=utf-8`,`cache-control: no-store`(歌词文件小,整读即可,无需 Range)。

### Task 2: TV 端

- **`apps/tv-web/src/runtime/lrc.ts`**:
  - `export interface LrcLine { timeMs: number; text: string }`
  - `export function parseLrc(content: string): LrcLine[]`:逐行匹配 `^((?:\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$`,一行多时间戳展开;文本空或无时间戳行跳过(元数据行 `[ti:..]` 自然被过滤);按 timeMs 升序稳定排序
  - `export function activeLyricIndex(lines: LrcLine[], positionMs: number): number`:最后一个 timeMs <= positionMs 的下标,空数组/-1
- **player-client.ts**:`async fetchSongLyrics(assetId: string): Promise<string | null>` → getJson 失败(404)时返回 null
- **`apps/tv-web/src/components/LyricsOverlay.tsx`**:
  - props `{ lines: LrcLine[]; positionMs: number }`;内部 200ms interval 自增帧驱动重渲染
  - 取 `i = activeLyricIndex`;渲染 i-1(淡)、i(高亮大字)、i+1(预示)三行,无边框纯覆盖层,left 24 / bottom 120(footer 上方),zIndex 2
  - lines 空数组时返回 null
- **App.tsx**:`const lyrics = useSongLyrics(runtime.snapshot?.currentTarget?.assetId ?? null)`(自实现小 hook:按 assetId 缓存含 null;404 不重试同歌);`<LyricsOverlay lines={...} positionMs={runtime.playbackPositionMs} />` 渲染在 PlayingScreen 同层(App 内,不影响其他 screen)
- **use-tv-playback-runtime.ts**:无需改(playbackPositionMs 已有);如需 200ms 精度,把播放帧 tick 的 interval 从 1000ms 调成 200ms(影响小,时钟也用)

### Task 3: 回填

- **`apps/api/src/modules/online-supplement/lrclib-client.ts`**:从 LyricsStageHandler 抽 `fetchBestLrclibRecord(input { artistName, trackName, durationMs, baseUrl, fetchImpl?, timeoutMs? })`;handler 改为薄壳调用;导出 `LrclibRecord`
- **`apps/api/scripts/backfill-lyrics.mjs`**(直接用 tsx?不,mjs+pg 仿 reconcile-online-library.mjs;LRCLIB 用原生 fetch):
  - `SELECT id, file_path, lyric_file, title FROM ktv_songs WHERE file_path LIKE '%\_online%' ESCAPE '\' AND missing_at IS NULL AND lyric_file IS NULL`
  - stem = basename 去扩展名,按 `-` 切 4 段:artist=parts[0]、track=parts[1],`_`→空格;不足 2 段跳过
  - 调 LRCLIB(get→get→search),拿到 syncedLyrics → 写 `<stem>.lrc`(同目录)→ `UPDATE ktv_songs SET lyric_file`
  - 逐首打日志;`--dry-run` 可选参数只打印

### Task 4: 验证

- 新单测:`apps/tv-web/src/test/lrc.test.ts`(多时间戳/坏行/排序/activeLyricIndex 边界);api 侧 backfill 的 stem 解析若抽了纯函数则补测
- `pnpm -F @home-ktv/api typecheck && test`;`pnpm -F @home-ktv/tv-web typecheck && test`
- 跑 `node apps/api/scripts/backfill-lyrics.mjs` 补演員/童话 → DB 确认 lyric_file 非空、文件存在
- `powershell scripts/dev-start.ps1` 重启,TV 播放验证歌词滚动

## 执行记录

- 2026-08-14:计划创建。
