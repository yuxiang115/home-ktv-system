# Online Supplement: Lyrics 阶段 + Demucs 打磨 + 测试修复 实施计划

> **给接手的 agent:** 本文档自包含,context 丢失后可直接从「状态跟踪」和「任务详情」继续执行。
> 每完成一个任务,请把对应条目的 `[ ]` 改成 `[x]` 并按需补充「执行记录」。

## 状态跟踪

- [x] Task 0: 写本计划文档
- [x] Task 1: 修复 `ktv-sample-index.test.ts` 2 个失败(strict 解析器回归)
- [x] Task 2: 修复 `ktv-index-technical-probe.test.ts` 1 个失败(mapMediaPath Windows 路径)
- [x] Task 3: 实现 lyrics 阶段(LRCLIB)
- [x] Task 4: demucs 阶段打磨(模型可配 + runner 可注入 + 中间文件清理)
- [x] Task 5: 新增 lyrics / vocal-remove / mix handler 单测
- [x] Task 6: 全量验证(typecheck + vitest),更新本状态

## Goal

在已有的「在线补歌」流水线(搜索 YouTube → 下载 → LLM 规范命名 → [Demucs 伴奏 → ffmpeg 双音轨合成] → 入库)基础上:

1. 修 3 个预存失败测试(与补歌功能无关的回归)
2. 补齐 `lyrics` 阶段:从 LRCLIB 拉同步 LRC,落盘 `.lrc` 并写入 `ktv_songs.lyric_file`
3. 打磨 `vocal_remove`(demucs)阶段:模型可配、命令执行器可注入(可单测)、入库后清理中间文件

## 背景快照(2026-08-14,全部为工作区未提交改动)

### 已有实现(不要重做)

在线补歌功能已完整存在于工作区(未提交),链路:

- **手机端** `apps/controller/src/App.tsx`:本地搜索无结果时显示「在线补歌(YouTube)」面板,搜索/请求按钮;runtime 钩子在 `use-room-controller-runtime.ts`(state: `onlineSupplementCandidates/Query/Status`)
- **API** `apps/api/src/routes/online-supplement.ts`:`GET /rooms/:slug/online-supplement/search`(yt-dlp flat-playlist 搜索)、`POST .../request`(建任务)
- **任务表** `online_supplement_tasks`(migration `0025_online_supplement_tasks.sql`);`ktv_songs.lyric_file` 列已建(migration `0026_ktv_songs_lyric_file.sql`)
- **Worker** `apps/api/src/worker/supplement-worker.ts`(`pnpm -F @home-ktv/api supplement:worker`):lease/claim 轮询模型,`FOR UPDATE SKIP LOCKED`,进度经 pg LISTEN/NOTIFY(`supplement_progress` 频道)推给 API 进程刷新房间快照
- **阶段 handler** 在 `apps/api/src/modules/online-supplement/handlers/`:
  - `download-handler.ts`:yt-dlp 下载到 `<workDir>/_downloads/<taskId>.mkv`(muxed 流避 403,3 次重试)
  - `rename-llm-handler.ts`:LLM 输出规范名 `歌手-歌名-语种-分类`(词内空格用 `_`),无 LLM 时 fallback 清洗
  - `vocal-remove-handler.ts`:demucs `--two-stems vocals -n <model> -d <device>`,输出 `<workDir>/_stems/<taskId>/<model>/<taskId>/no_vocals.wav`,2 次重试,续 lease 15min
  - `mix-handler.ts`:ffmpeg 双输入 → `<workDir>/_mixed/<taskId>.mkv`,视频 copy、音轨标 `原唱`/`伴奏`(title metadata,`inferTrackRolesFromRealMv` 正则识别)
  - `index-handler.ts`:拷到 `<workDir>/_online/<safeName>.mkv` → `indexKtvAssetDrafts` 入 `ktv_songs` → 按 file_path 查 id → ffprobe 填 technical_metadata
- **编排** `supplement-orchestrator.ts`:`WORKFLOW_STAGES` 定义阶段序列;`BATCH_STAGES = {rename, vocal_remove}`;`nextStageFor` 推进;terminal 阶段 `markReady`
- **domain** `packages/domain/src/index.ts`:`SupplementTaskStage` 枚举已含 `lyrics`(DB CHECK 约束同样已含,无需新迁移);controller 端阶段标签已含「获取歌词」
- **配置** `config.ts` + `.env.example`:`ONLINE_SUPPLEMENT_ENABLED`(默认 false)、`SUPPLEMENT_IMPORT_ROOT`、`YT_DLP_BIN/ARGS`、`YOUTUBE_COOKIE(S_FROM_BROWSER)`、`DEMUCS_BIN/ARGS/DEVICE`、`FFMPEG_BIN` 等

### 已确认的决策

- **歌词来源**:LRCLIB 优先(`LYRICS_LRCLIB_BASE_URL`,默认 `https://lrclib.net`),不做 yt-dlp 字幕回退
- **lyrics 加到两个工作流**:basic = `[download, rename, lyrics, index]`,enhanced = `[download, rename, lyrics, vocal_remove, mix, index]`
- **lyrics 尽力而为**:找不到/网络错 → `completed` + message,不阻塞出歌
- **demucs**:打磨现有阶段(模型可配/可测/清理),不做曲库批量补伴奏
- 歌名/歌手解析:优先 `task.llmRenamedTitle`(规范名 `歌手-歌名-语种-分类`,`-` 切四段,词内空格为 `_`),回退 `task.artistName + task.title`

### 3 个预存失败测试根因

1. **`ktv-sample-index.test.ts` × 2**(commit `5418336` 引入的回归:strict 解析器加了 `parts.length >= 3` 兜底分支,抢走了原本落到 loose 解析器的用例)
   - `2024/.../如風 - 记住这份缘(原版)国语-流行.mpg`:3 段无语种标记 → 兜底分支把 `记住这份缘(原版)国语` 原样当 title。修法:兜底分支的 title 先过 `extractTitleWithInlineLanguage`(能剥 `(原版)国语` 内联语种尾缀)
   - `2025/2025-11new/新年喜庆歌曲/邓志驹_蒋文端-新年蜜运最成功(MTV)-粤语.mkv`:3 段、末段 `粤语` 是语种标记 → 兜底分支把 `粤语` 当分类,父目录分类 `新年喜庆歌曲` 没生效。修法:strict 解析器新增「3 段且末段是语种标记」分支 → 只取 artist/title 不带 genre,让 `parseKtvFilename` 里现有的 `inferKtvParentCategory` 父目录补丁(仅 2024/2025 根)填分类
   - 注意:`闲也想你忙也想你-国语-流行.mpg`(3 段、中段是语种)也在同一循环里,当前因前面的用例先失败而未被断言;修法需一并覆盖:新增「3 段且中段是语种标记」分支 → `buildFilenameMetadata(null, parts[0], parts[2])`(artist 为 "Unknown Artist")
   - 已核对全部 16 个用例 + `ktv-full-index.test.ts` 的 30 个夹具:新分支不影响现有通过用例(4+ 段走 branch 1 languageIndex 逻辑,不受影响)
2. **`ktv-index-technical-probe.test.ts` × 1**:`mapMediaPath`(apps/api/src/modules/assets/media-path-mapping.ts)用 `path.resolve(toRoot, relative)` 拼接,Windows 上把 POSIX 风格 `to` 根(`/nas/KTV歌曲`)锚到当前盘符 → `C:\nas\KTV歌曲\a.mkv`。修法:改保根字符串拼接(按 `to` 根的分隔符风格),Linux 上输出与 `path.resolve` 等价、行为不变

## 任务详情

### Task 1: 修 strict 解析器(apps/api/src/modules/ingest/ktv-sample-index.ts)

`parseStrictDashTailKtvFilenameWithOptions` 中,在「`languageIndex >= 3 && languageIndex === parts.length - 1`」分支之后、`parts.length >= 3` 兜底分支之前,新增两个分支:

```ts
if (parts.length === 3 && isKtvLanguageMarker(parts[2])) {
  // 歌手-歌名-语种(无分类):不带 genre,交给 inferKtvParentCategory 父目录补丁
  const artistName = parts[0];
  const title = parts[1];
  if (artistName && title) {
    return { artistName, title: stripTrailingTitleMarker(title, options.trailingTitleMarkerMode) };
  }
}

if (parts.length === 3 && isKtvLanguageMarker(parts[1])) {
  // 歌名-语种-分类(无歌手)
  return buildFilenameMetadata(null, parts[0], parts[2]);
}
```

兜底分支改为:rawTitle 先试 `extractTitleWithInlineLanguage(rawTitle, category)`,命中用其 title,否则维持 `stripTrailingTitleMarker(rawTitle, mode)`。

验证:`pnpm -F @home-ktv/api exec vitest run src/test/ktv-sample-index.test.ts src/test/ktv-full-index.test.ts`

### Task 2: 修 mapMediaPath(apps/api/src/modules/assets/media-path-mapping.ts)

`mapMediaPath` 命中映射后,不再 `path.resolve(toRoot, relative)`,改为用原始 `mapping.to`(trim 后)做保根拼接:相对部分按 `/`、`\` 切分后用 `to` 根风格的重连(`to` 只含 `/` → 用 `/`,否则 `path.sep`)。Linux 输出与原先等价。

验证:`pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-technical-probe.test.ts`

### Task 3: lyrics 阶段

- **新建** `apps/api/src/modules/online-supplement/handlers/lyrics-handler.ts`:
  - `LyricsStageHandler implements StageHandler`,`stage = "lyrics"`
  - 名字解析 `supplementSearchNames(task)`:llmRenamedTitle 按 `-` 切段取前两段(artist=parts[0], track=parts[1]),`_` 还原为空格;否则 task.artistName + task.title
  - LRCLIB 请求链:`GET /api/get?artist_name&track_name&duration(秒)` → 404 则不带 duration 重试 `/api/get` → 再 404 则 `/api/search?artist_name&track_name` 取第一个有 `syncedLyrics` 且非 `instrumental` 的记录
  - `fetchImpl` 可注入(测试);超时 10s(`AbortSignal.timeout`)
  - 拿到 syncedLyrics → 写 `<workDir>/_lyrics/<taskId>.lrc`,返回 `{ status: "completed", lyricFile }`;任何失败/未命中 → `{ status: "completed", message: "..." }` 不带 lyricFile
- **`supplement-orchestrator.ts`**:`WORKFLOW_STAGES` 改为 basic/enhanced 都含 `lyrics`(见上);lyrics 不进 `BATCH_STAGES`(串行即可)
- **`handlers/index-handler.ts`**:入库成功后,若 `task.lyricFile` 存在 → 拷为 `<onlineDir>/<safeName>.lrc` 并 `UPDATE ktv_songs SET lyric_file = $1 WHERE id = $2`;result 里回传最终 lyricFile
- **`supplement-handlers.ts`**:options 加 `lrclibBaseUrl`,注册 lyrics handler
- **`config.ts`**:`lyricsLrclibBaseUrl`(env `LYRICS_LRCLIB_BASE_URL`,默认 `https://lrclib.net`),`demucsModel`(env `DEMUCS_MODEL`,默认 `htdemucs`)——Task 4 一并加
- **`worker/supplement-worker.ts`**:HandlerDeps + buildSupplementHandlers 传 `lrclibBaseUrl`
- **`.env.example`**:补 `LYRICS_LRCLIB_BASE_URL`、`DEMUCS_MODEL`,并修正 workflow 注释(lyrics 已实现)

### Task 4: demucs 打磨

- **config.ts**:`demucsModel` 接线(env `DEMUCS_MODEL`,默认 `htdemucs`)
- **`vocal-remove-handler.ts`**:
  - `options.run?: (bin, args, timeoutMs) => Promise<void>` 可注入,默认包 `execFileAsync`(忽略 stdout)
  - model 已有 `options.model` 字段,由 `supplement-handlers.ts` 传入 `demucsModel`
- **`mix-handler.ts`**:
  - 同样加可注入 `run`;`options.model` 同样接 `demucsModel`(**关键**:mix 依赖 `<model>` 目录名找 `no_vocals.wav`,model 改了 mix 不知道会断链)
- **`handlers/index-handler.ts`**:成功入库后 best-effort 清理中间产物:`_downloads/<taskId>.mkv`、`_stems/<taskId>/`(rm recursive)、`_mixed/<taskId>.mkv`、`_lyrics/<taskId>.lrc`(拷贝完之后)

### Task 5: 新增单测(apps/api/src/test/supplement-stage-handlers.test.ts)

- LyricsStageHandler:注入 fetchImpl —— 命中 `/api/get` 写 .lrc + lyricFile;404+search 命中;全 404 → completed 无 lyricFile;fetch 抛错 → completed 不失败;spec 名字解析(`llmRenamedTitle` 含 `_` 还原)
- VocalRemoveStageHandler:注入 run —— 断言参数含 `--two-stems vocals -n <model> -d <device>` 与输出目录;run 两次都抛错 → failed 带 `demucs failed`;源文件缺失 → failed;成功 → completed
- MixStageHandler:注入 run(顺带创建输出文件)—— 断言 ffmpeg 参数含双音轨 map 与 `title=原唱/伴奏` metadata;缺 accompaniment → failed
- 工具:临时目录 `mkdtemp`,伪造 `StageExecuteInput`(renewLease/reportProgress 为 no-op async)

### Task 6: 全量验证

```bash
pnpm -F @home-ktv/api typecheck
pnpm -F @home-ktv/api test
```

预期:47+ 测试文件全绿(含新增)。

## 执行记录

- 2026-08-14:计划文档创建(Task 0 完成)。工作区基线:`git status` 见「背景快照」,基于 commit `68a1d3d`。
- 2026-08-14:Task 1-6 全部完成。验证结果:`pnpm -F @home-ktv/api test` 48 文件 / 219 测试全绿(基线 47 文件 / 207 测试、3 失败);`pnpm typecheck` 13 包全过。实现与计划的差异:
  - `ktv-sample-index.ts` 按计划加了两个 3 段语种分支 + 兜底分支内联语种清理
  - `media-path-mapping.ts` 新增 `joinUnderRoot`(按 `to` 根分隔符风格拼接),`mapMediaPath` 改用它
  - lyrics handler 落在 `handlers/lyrics-handler.ts`,请求链 get(带时长)→ get(不带时长)→ search
  - `vocal-remove-handler.ts` 导出 `StageCommandRunner` / `defaultStageCommandRunner`,`mix-handler.ts` 复用
  - `index-handler.ts` 增加 `copyLyricIntoLibrary`(UPDATE ktv_songs.lyric_file)与 `cleanupIntermediates`
  - `config.ts` 新增 `lyricsLrclibBaseUrl` / `demucsModel`;`source-queue-command-route.test.ts` 的 createConfig 夹具补了这两个字段
  - 新测试文件 `src/test/supplement-stage-handlers.test.ts`(12 个用例)
  - 遗留(未做,后续可选):TV 端(android-tv, libVLC)不渲染歌词,`lyric_file` 仅持久化;在线源歌词下载的合规边界沿用 LRCLIB 开放 API
