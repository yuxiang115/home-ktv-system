# 逐字歌词对齐精度提升到原生 KTV 级——实施计划

## 背景诊断(已侦察确认,按影响排序)

1. **E1 语种误判(Baby 实锤)**: `alignerLanguageForSpecName` 对规范名第 3 段「其他」默认 Chinese → 英文歌按中文对齐+字符预算分行,unit 粘连("whoaYou")、词时长畸变(3.68s vs 0.16s)
2. **E2 分块信 LRC 时间戳**: chunk 窗口(前导仅 1s/尾部 +8s)由录音室版 LRC 决定,MV 带片头时逐块错位不同 →「忽快忽慢」的直接来源
3. **E3 词行分配无再同步**: 顺序消费 unit 的预算启发式,块内漂移累积、aligner 丢词时整行消失
4. **E4 人声轨未持久化**: 入库后 vocals.wav 被清理,重对齐退化为混音对齐(用户洞察:应永远以人声为基准)
5. **E5 渲染时钟 200ms 轮询**: 无 rAF/外推,扫光每 200ms 突进一截;伴唱 remux 兜底流 `-c copy` keyframe 回退 + make_zero 平移造成 GOP 级超前
6. **E6 无质量校验**: 现有校验只查"JSON 非空",坏时间轴照常入库

结论: **模型不换**(Qwen3-ForcedAligner-0.6B 为当前 SOTA,优于 WhisperX/NFA/MFA),重构"喂什么音频、怎么分段、怎么分行、怎么渲染"。

## 方案总览: VAD 分段 + 逐行独立对齐 + 人声 sidecar + rAF 渲染

### Phase A: 语种自动检测(止血,立刻见效)
`apps/api/python/align_lyrics.py`: language 参数支持 `auto`——按 LRC 文本 CJK 字符占比判定(>30% → Chinese/Cantonese 保持传入值,否则 English 等);`align-handler.ts` 的 `alignerLanguageForSpecName` 对「其他/未知」返回 `auto` 而非 `Chinese`。媒体名有明确语种时仍用映射表。

### Phase B: 对齐算法重构(核心)
`align_lyrics.py` 主流程重写为:

1. **人声优先**: 音频源顺序 vocals.wav → `<safeName>.vocals.m4a` sidecar → mkv 混音(仅兜底)
2. **VAD 分段**: 用已装的 librosa 对人声做能量 VAD → 演唱段 [start,end] 列表(合并 <0.3s 间隙、丢弃 <0.5s 毛刺)——人声轨上 VAD 近乎完美
3. **行↔段映射**: LRC 行按顺序与演唱段配对,依据文本长度占总文本比例与段时长比例的贪心匹配(处理前奏/间奏/ad-lib 造成的数量不齐:多余段忽略、缺段行插值或丢弃并计数)
4. **逐行独立对齐**: 每行切出自己的段音频(±0.3s 余量),单独调 `model.align(text=该行文本)`——误差不累积、LRC 时间戳完全不参与、行长自动校准
5. **QA 门禁**: 输出前校验行时间单调、覆盖率(匹配行/总行 ≥80%)、词时长中位数在 0.05~2s;不合格 → 不写 karaoke.json(降级 LRC 扫光,宁缺毋滥),日志输出质量报告
6. `media_sidecar.py` 的 align 命令同步走新流程(它 import align_lyrics 的函数,改调用入口即可)

### Phase C: 人声 sidecar 持久化
- `index-handler.ts`: 入库时若 vocals stem 存在,压缩为 `_online/<safeName>.vocals.m4a`(16k mono,~2-5MB/首)随曲库保留;清理逻辑不再影响它
- `backfill-lyrics.ts`: 重对齐优先用 sidecar,无则 mkv(现有 `KTV_BACKFILL_USE_DEMUCS=1` 仍可强制重分离)

### Phase D: 渲染端原生级流畅(tv-web)
1. **rAF 时钟**: `LyricsOverlay` 改用 `requestAnimationFrame` 每帧直接读 `video.currentTime`(经 runtime 暴露的 `getPositionMs()` 回调,替代 positionMs 数值 prop)→ 60fps 平滑扫光;保留 prop 兼容作降级
2. **remux 伴唱流偏移修正**: `media.ts` remux 输出后 ffprobe 实际起始偏移,客户端 `switch-controller` 的 `positionBaseMs` 按实际偏移校准(消除 keyframe snap 造成的 GOP 级超前)——开伴唱瞬间不错位
3. 去掉 sweep 的 `Math.round(p*1000)/10` 量化(浮点直传)

### Phase E: 存量重对齐 + 验收
1. 全量重跑: 删现有 karaoke.json → DB 置 NULL → backfill(新管线)
2. 验收标准(用户主观 + 客观): Baby 英文词独立清晰、高亮与人声误差 <150ms(逐行目测)、伴唱模式高亮不错位、扫光无步进感
3. 中文歌(童话/演員)回归:新管线不劣化

## 涉及文件
- python: `apps/api/python/align_lyrics.py`(重写核心)、`media_sidecar.py`(入口适配)
- api TS: `align-handler.ts`(auto 语种/sidecar 优先)、`index-handler.ts`(sidecar 拷贝)、`backfill-lyrics.ts`(sidecar 优先)、`media.ts`(remux 偏移)
- tv-web: `use-tv-playback-runtime.ts`(getPositionMs 回调)、`LyricsOverlay.tsx`(rAF)
- 测试: VAD 分段与行段映射的纯函数单测(python,模型调用 mock)、tv-web rAF/回调测试、api handler 测试更新

## 风险与边界
- VAD 参数(阈值/间隙合并)需要用现有 5 首歌实测调参——这是本计划唯一需要经验校准的部分
- 逐行对齐调用次数 = 行数(30-60 次/首),GPU 单次秒级,单首总耗时与现在相当(sidecar 模式下模型不重载)
- 伴唱 remux 修正依赖 ffprobe 输出包级时间戳的稳定性,若不可靠则退化为"重编码首个 GOP"方案
- 磁盘:每首多 ~3MB sidecar,家庭库量级无压力