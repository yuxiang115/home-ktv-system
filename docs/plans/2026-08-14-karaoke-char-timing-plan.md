# KTV 逐字时间轴(Qwen3-ForcedAligner)实施计划

> **给接手的 agent:** 自包含。完成后更新状态与执行记录。

## 状态跟踪

- [ ] Task 1: Python 对齐脚本 `apps/api/python/align_lyrics.py`
- [ ] Task 2: DB(migration 0027:stage 加 align + ktv_songs.karaoke_lyrics_file)
- [ ] Task 3: align 阶段 handler + 工作流/配置/worker/label
- [ ] Task 4: index 拷贝 karaoke JSON + API 路由 `/karaoke-lyrics`
- [ ] Task 5: TV 逐字渲染(降级 LRC 扫光)
- [ ] Task 6: 测试 + 全量验证 + backfill --with-karaoke

## Goal

把行级 LRC 升级为**逐字 karaoke 时间轴**:demucs 的 vocals.wav + LRCLIB 歌词 →
Qwen3-ForcedAligner-0.6B(本地 RTX 3070)→ 每字 start/end JSON → TV 一个字一个字点亮。

## 关键事实(调研结论)

- 调用方式:`pip install qwen-asr` 后
  `Qwen3ForcedAligner.from_pretrained("Qwen/Qwen3-ForcedAligner-0.6B", dtype=bf16, device_map="cuda:0")`;
  `model.align(audio=path, text=..., language="Chinese")` → `[(text, start_time, end_time)]`(秒)。
- 语言:Chinese/Cantonese/English/French/German/Italian/Japanese/Korean/Portuguese/Russian/Spanish。
  规范名第 3 段映射:国语/普通话/闽南语→Chinese,粤语→Cantonese,英语→English,日语→Japanese,
  韩语→Korean,法语→French,德语→German,西班牙语→Spanish,俄语→Russian,默认 Chinese。
- **单次 align ≤ 5 分钟音频** → 脚本按 LRC 行边界分 ~240s 段,ffmpeg 切音频,结果加偏移。
- vocals.wav 已存在:enhanced 工作流 `_stems/<taskId>/<model>/<taskId>/vocals.wav`(index 前清理)。
- lyrics 阶段产出 `_lyrics/<taskId>.lrc`(task.lyricFile)。

## 设计

- **新阶段 align**(仅 enhanced):`download→rename→lyrics→vocal_remove→align→mix→index`。
  basic 工作流不变(无 vocals,LRC 扫光降级)。
- **karaoke JSON 约定路径** `_lyrics/<taskId>.karaoke.json`(不给 tasks 表加列,orchestrator
  无需透传);格式 `{"lines":[{"start":62.31,"end":66.82,"text":"...","words":[{"text":"我","start":62.31,"end":62.58}]}]}`(秒)。
- **入库**:index-handler 拷为 `<onlineDir>/<safeName>.karaoke.json` + UPDATE
  `ktv_songs.karaoke_lyrics_file`(新列,migration 0027;tasks 表 stage CHECK 同批加 'align')。
- **API**:`GET /media/ktv-index/:assetId/karaoke-lyrics`(raw repo 查 karaoke_lyrics_file;
  null/缺失→404 KARAOKE_NOT_FOUND;成功 application/json)。
- **align handler 尽力而为**:无 alignerBin/无 vocals/无 lrc → completed+message 不阻塞;
  模型失败同理(failure 只记日志)。可注入 runner 供单测。
- **配置**:ALIGNER_BIN(默认空=禁用)、ALIGNER_MODEL(默认 Qwen/Qwen3-ForcedAligner-0.6B)、
  ALIGNER_DEVICE(默认 cuda)、ALIGNER_DTYPE(默认 bfloat16)、ALIGNER_SCRIPT(默认
  `<apiRoot>/python/align_lyrics.py`)。dev 脚本探测 `python -c "import qwen_asr"` 成功则设 ALIGNER_BIN。
- **TV**:karaoke 优先,lrc 兜底。渲染:当前行按 word.startMs <= pos 点亮(accent),
  未唱 muted;上一行淡、下一行预示。LRC 时保留现有整行扫光。
- **回填**:backfill-lyrics 加 `--with-karaoke`:对库内 mkv 跑 demucs(临时)→ align → 写 JSON+DB。

## 执行记录

- 2026-08-14:计划创建。基线 5e0dfaf + 未提交的 TV 歌词渲染改动。
