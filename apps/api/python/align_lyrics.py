#!/usr/bin/env python
"""Char/word-level karaoke timing via Qwen3-ForcedAligner (v2, audio-driven).

Input : audio (vocals wav preferred; any ffmpeg-readable media like the downloaded
        mkv also works — converted once to 16k mono) + line-level LRC
Output: JSON {"lines":[{"start","end","text","words":[{"text","start","end"}]}]} (seconds)

v2 replaces the old "chunk by LRC timestamps + character budget" flow, whose
failure modes were: studio LRC timestamps drift against MV audio (intros shift
every chunk -> karaoke runs fast/slow), English songs aligned with Chinese
character budgets (words glue together / durations collapse), and budget drift
inside a chunk silently swallowed whole lines.

New pipeline (v3 — LRC timestamps as COARSE anchors, not discarded):
  1. language: --language auto (spec name marker "其他" etc.) is resolved from
     the LRC text itself — CJK ratio >= 30% -> Chinese (Japanese/Korean by their
     own scripts), otherwise English. Resolved BEFORE the model is called: the
     aligner tokenizes by the language label, so "auto" never reaches it.
  2. VAD: 16k mono energy frames -> voiced segments (pure function, unit
     tested). Vocals stems make instrumental parts near-silent, so segments
     approximate sung phrases.
  3. GLOBAL OFFSET d*: MVs carry intro dialogue/footage that the studio LRC
     lacks, so LRC time and audio time differ by one ~constant lag per song
     (演員 MV: studio LRC lags the MV vocals by ~9-17s; Baby: ~0s). d* is
     estimated by a pure-function sweep: for each candidate d, each of the
     first 10 LRC lines scores a hit when a VAD segment STARTS within ±3s of
     (LRC time + d) with a duration proportional to the line's length; the
     reward decays linearly with distance so exact hits dominate (a dense
     quasi-periodic vocal track makes far offsets look deceptively good to a
     binary hit count — the decay + smaller-|d| tie-break keep it honest).
  4. WINDOWED line<->segment pairing: each line takes the nearest VAD segment
     start within (LRC time + d*) ± 5s; a segment far too short for the text
     absorbs the following contiguous segment (intro chants split by breaths,
     e.g. Baby's "Oh whoa" triple); a segment shared by several lines (rap
     density) is split between them at anchor midpoints; no segment in the
     window => unmatched.
  5. per-line alignment: each line is aligned independently against its own
     segment (+/-0.3s margin) by the cached model, so one wrong segment can
     never poison the rest of the song.
  6. quality gate (before writing anything): line times strictly increasing,
     matched line coverage >= 60%, median word duration within 0.05~2s, word
     timings not collapsed (<40% words under 20ms; lines >50% collapsed are
     dropped as unmatched), plus HARD timeline checks — the output timeline
     must be the audio's, not the LRC's: every line must sit inside its mapped
     VAD segment (+/-1s), and the first output line must start within 3s of
     the first adopted VAD segment (catches studio-LRC-timeline leakage on
     MVs with intros).
     Failure => no output file, one-line report on stderr, exit code 4
     (= alignment quality below bar; callers degrade best-effort to LRC).

v4 adds an ASR-anchored path on top of v3: when an ASR service is configured
(KTV_ASR_BASE_URL), the vocals are transcribed once (Qwen3-ASR, whisper-style
/v1/audio/transcriptions) and each LRC line is anchored by fuzzy text matching
(difflib.SequenceMatcher over language-aware tokens) to its sung words. Word
timestamps kill the "52 VAD segments vs 29 LRC lines" mismatch class outright
(long breathy lines VAD shatters into fragments); per-line ForcedAligner still
produces the char-level times inside each anchored window. ASR disabled /
unreachable / anchor success rate < 50% => the v3 VAD path runs unchanged
(fallback, not replacement). The quality gate is identical on both paths; the
report line notes anchor=asr|vad.

Invariant (regression-tested): output line start/end may ONLY originate from
VAD segment boundaries, ASR word times and aligner unit times. LRC timestamps
steer WHICH segment each line is paired with (global offset + per-line window)
but never contribute a single output timestamp directly; a line that cannot be
aligned to a segment is dropped from the output entirely (counted into
coverage), NEVER backfilled with its LRC timestamp.

Exit codes: 0 ok / 3 skipped (no lyrics / audio missing) / 4 quality gate / 1 error.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Mapping, NamedTuple, Sequence

LRC_TS = re.compile(r"\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]")
# 增强版(A2)行内逐字时间戳 <mm:ss.xx>:不参与对齐文本(否则污染字符预算),剥离
LRC_WORD_TS = re.compile(r"<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>")
# offset 元数据(毫秒):正值 => 歌词提前(时间轴前移),即 time -= offset/1000
LRC_OFFSET = re.compile(r"\[offset:([+-]?\d+(?:\.\d+)?)\]", re.IGNORECASE)

SAMPLE_RATE = 16000

# ---- Phase A: language auto-detection -----------------------------------
# 文本侧语种检测只服务 --language auto(规范名语种段「其他/未知」):CJK 占比
# >= AUTO_CJK_RATIO 判中文;假名/谚文各自更特异,单独判日/韩;<阈值判英文。
# 更细分的语种(法/德/…)按需在此扩展。
AUTO_CJK_RATIO = 0.30
KANA_DETECT_RATIO = 0.15
CJK_RANGES = ((0x3040, 0x30FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))
KANA_RANGES = ((0x3040, 0x30FF),)
HANGUL_RANGES = ((0xAC00, 0xD7AF),)

# ---- Phase B: VAD --------------------------------------------------------
VAD_FRAME_SECONDS = 0.03
VAD_THRESHOLD_FACTOR = 2.0  # 基础阈值 = 能量中位数 * 该倍数(参数化,便于调参)
VAD_LOUD_PERCENTILE = 0.9   # "响部"分位:人声 stem 上即演唱响度
VAD_LOUD_CEILING_FRACTION = 0.5  # 阈值上限 = 响部的该比例(见 voiced_segments_from_energy)
VAD_MIN_GAP_SECONDS = 0.3   # 间隙小于该值的相邻有声段合并(句中换气)
VAD_MIN_SEGMENT_SECONDS = 0.5  # 时长小于该值的段丢弃(咳嗽/单击噪声)
VAD_ENERGY_FLOOR = 1e-5     # 数字静音的中位数*倍数可能仍 ~0,抬到可听门槛

# ---- Phase B: global offset estimation (LRC timeline -> audio timeline) ----
# MV 带(片头对白/剧情)而录音室 LRC 没有内容时,整首歌存在一个近似常数的
# 全局滞后 d*:真实音频里第 i 行的演唱时刻 ≈ LRC 时间戳 + d*(演員 MV 实测
# +9s,Baby 实测 ~0s)。d* 由纯函数扫描估计:候选 d 步进 1s;前 N 行在
# (LRC时间+d)±窗口 内有「起点贴近且时长与行长成比例」的 VAD 段即得分,
# 得分随距离线性衰减(密集准周期人声段会让纯命中计数在大范围 d 上饱和,
# 衰减 + 偏好小 |d| 的平手规则把估计拉回唯一解)。
OFFSET_MIN_SECONDS = -10.0        # 负向:MV 比 LRC 更早进入正歌(少见,留少量)
OFFSET_MAX_SECONDS = 90.0         # 正向:MV 片头(对白/剧情)最长容忍
OFFSET_STEP_SECONDS = 1.0
OFFSET_ANCHOR_LINE_COUNT = 10     # 用前 N 行做粗对齐(演員/Baby 实测 N=10 判别最好)
OFFSET_SCAN_SECONDS = 90.0        # 只有起点在前 90s 的段参与投票(片头区即分战场)
OFFSET_MATCH_WINDOW_SECONDS = 3.0 # 行锚点与段起点的最大判读距离
OFFSET_RATIO_BAND = (0.04, 0.8)   # 段时长/非空白字符数 的合理带(英文~0.08-0.15,
                                  # 中文~0.15-0.45 s/char;出带视为「时长不成比例」)

# ---- Phase B: windowed line<->segment matching --------------------------------
# d* 确定后每行在 (LRC时间+d*) ± 窗口 内取「起点最近」的段;段远短于文本
# 应有时长(如换气/吟唱被 VAD 切开,Baby 前奏 "Oh whoa" 三连)时吞并紧随的
# 相邻段;多行选中同一底段(rap 一段多行)时按锚点中点切分共享,保证每行都有
# 自己的时间片;窗口内无段 => unmatched。
LINE_MATCH_WINDOW_SECONDS = 5.0
ABSORB_MIN_SEC_PER_CHAR = 0.09    # 段时长/行长 低于该值 => 段对文本太短,尝试吞并
                                  # (英文名义 ~0.08-0.13 s/char,中文 ~0.15-0.45;
                                  # 阈值取两者之间:只吞并「连英文都嫌短」的碎段)
ABSORB_MAX_GAP_SECONDS = 2.5      # 只吞并间隔 <= 该值的紧邻段("Oh whoa" 三连
                                  # 的乐句间隔实测 ~2.1s;再宽会吞进下一行)
ABSORB_MAX_SEC_PER_CHAR = 0.8     # 吞并后的时长/行长 上限(与比例带上界一致)

# ---- Phase B: per-line alignment -----------------------------------------
LINE_MARGIN_SECONDS = 0.3  # 切段时两侧余量,VAD 边界切掉半个字时兜底
MIN_CLIP_SECONDS = 0.2     # 短于该值的切片直接判 unmatched(模型对空切片不稳)

# ---- Phase C: ASR 词级锚定 -------------------------------------------------
# VAD 行段映射把「行↔段」当纯时间配对问题解:52段/29行类错配(换气密集的长
# 吟唱行被 VAD 切碎)会整行配错段,进而被门禁拒绝(童话/江南/有何不可)。
# ASR 词级时间戳回答「每个词什么时候被唱出来」,行锚定退化为文本模糊匹配,
# 天然免疫段数错配。ASR 不可用/锚定成功率过低时完整回退 VAD 路径(不是替换)。
ASR_DEFAULT_MODEL = "mlx-community/Qwen3-ASR-1.7B-4bit"
ASR_DEFAULT_TIMEOUT_SECONDS = 600.0
ASR_PROMPT_CHAR_BUDGET = 200    # 转写上下文偏置:歌词前 N 字(专有名词命中率)
ASR_MIN_ANCHOR_COVERAGE = 0.5   # 锚定成功率低于该值 => 放弃 ASR,走 VAD 兜底
# 行↔ASR 词序列模糊匹配阈值:匹配 token 数/行 token 数 < 该值 => 该行 unmatched
# (整行没被唱 / 转写差异过大),不参与锚定成功率分子。
ANCHOR_MIN_SIMILARITY = 0.5
# 锚定 span 合理性上限(秒/非空白字符,与 OFFSET_RATIO_BAND 上界一致):副歌
# 重复行的部分 token 可能吸到远处的重复出现,首/末词 span 被拉到几分钟长——
# 这种锚定不可信,按 unmatched 丢弃,交给 VAD 兜底或逐行门禁。
ANCHOR_MAX_SEC_PER_CHAR = 0.8

# ---- Phase B: quality gate ------------------------------------------------
# 门禁按真实 MV 数据(6 首含对白/吟唱/ad-lib 的门禁集)校准:覆盖率 80% 在
# 「MV 里没人声的 LRC 行」面前过紧,60% 保住主体歌词;塌缩率 30% 在半念白
# 首行(演員实测 45%)面前过紧,40% 仍能拦住时间轴级错配;首行偏差 2s 放宽
# 到 3s 容纳 VAD 段起点比真实起唱早一点(前奏尾的弱人声被并进段头)。
MIN_LINE_COVERAGE = 0.6
WORD_DURATION_RANGE = (0.05, 2.0)
# 塌缩词检测:模型把文本硬塞进不含该语音的切片时,词时长会大面积塌缩到 ~0
# (Baby 实测 46% 的词 <20ms,首行 6 词 4 个 start==end)。词时长中位数对这种
# 分布不敏感(0.08s 仍在 [0.05,2] 内),必须按占比判:单行超半数词塌缩 =>
# 该行对齐失败,丢弃(unmatched);整文件剩余词塌缩率超 40% => 拒绝输出。
WORD_COLLAPSE_SECONDS = 0.02
LINE_MAX_COLLAPSED_WORD_FRACTION = 0.5
FILE_MAX_COLLAPSED_WORD_FRACTION = 0.4
# 硬时间轴校验:输出行时间只能来自 VAD 段边界 + aligner unit 时间。每行必须
# 落在其映射段 [start-1, end+1] 内(1s 容纳切片余量 0.3s + 模型边界毛刺);
# 越界行按 unmatched 丢弃,绝不回退 LRC 时间戳。
SEGMENT_CONTAINMENT_MARGIN_SECONDS = 1.0
# 输出首行与「首个被采用的 VAD 段」起点的偏差上限。超过 3s 说明输出时间轴
# 不是这段音频的(典型:输出复刻 LRC 录音室时间轴,而 MV 带片头)——直接
# 整体拒绝,宁可降级行级 LRC 也不能输出错误时间轴。
FIRST_LINE_SEGMENT_MAX_DEVIATION_SECONDS = 3.0


class AlignmentSkipped(RuntimeError):
    """输入不可用(无歌词/音频缺失),调用方应按 skip 处理而非失败。"""


class QualityGateError(RuntimeError):
    """对齐质量不达标:输出文件不写,CLI 以 exit 4 退出。"""


class AsrWord(NamedTuple):
    """ASR 词级时间戳近似(段级转写在段时长内均匀展开;text 已归一:去标点/小写)。"""

    text: str
    start: float
    end: float


def ffmpeg_cmd() -> str:
    return os.environ.get("FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg"


def parse_lrc(path: Path) -> list[tuple[float, str]]:
    lines: list[tuple[float, str]] = []
    offset_ms = 0.0
    for raw in path.read_text(encoding="utf-8").splitlines():
        offset_match = LRC_OFFSET.search(raw)
        if offset_match:
            offset_ms = float(offset_match.group(1))
            continue
        stamps = LRC_TS.findall(raw)
        if not stamps:
            continue
        text = LRC_WORD_TS.sub("", LRC_TS.sub("", raw)).strip()
        # LRCLIB 常见用 "." 这类纯符号行占位前奏;无字母数字的行不参与对齐
        if not text or not any(ch.isalnum() for ch in text):
            continue
        for minutes, seconds in stamps:
            start = int(minutes) * 60 + float(seconds.replace(":", ".")) - offset_ms / 1000.0
            lines.append((start, text))
    lines.sort(key=lambda item: item[0])
    return lines


# ---- Phase A: language auto-detection -------------------------------------


def _char_ratio(text: str, ranges: tuple[tuple[int, int], ...]) -> float:
    chars = [ord(char) for char in text if not char.isspace()]
    if not chars:
        return 0.0
    hits = sum(1 for code in chars if any(low <= code <= high for low, high in ranges))
    return hits / len(chars)


def cjk_char_ratio(text: str) -> float:
    return _char_ratio(text, CJK_RANGES)


def resolve_language(language: str, lrc_text: str, threshold: float = AUTO_CJK_RATIO) -> str:
    """Resolve --language "auto" from the LRC text into a concrete aligner language.

    CJK(汉字+假名+兼容区)占非空白字符 >= threshold 时:显式传入的 CJK 系语言
    (Chinese/Cantonese/Japanese)原样保留,其余(含 auto 自身)解析为 Chinese;
    否则 English。谚文/假名占比足够高时直接判 Korean/Japanese(与汉字文本互相
    区分的判别式)。非 auto 的显式语言不做任何改写(规范名映射表已可信)。
    """
    explicit = (language or "").strip()
    if explicit.lower() != "auto":
        return explicit
    if _char_ratio(lrc_text, HANGUL_RANGES) >= threshold:
        return "Korean"
    if _char_ratio(lrc_text, KANA_RANGES) >= KANA_DETECT_RATIO:
        return "Japanese"
    if cjk_char_ratio(lrc_text) >= threshold:
        return "Chinese"
    return "English"


# ---- Phase B: VAD ----------------------------------------------------------


def frame_energies(
    audio: "np.ndarray", sr: int = SAMPLE_RATE, frame_seconds: float = VAD_FRAME_SECONDS
) -> tuple[list[float], float]:
    """16k mono 波形 -> 每帧 RMS 能量列表 + 实际帧率(sr / hop)。"""
    import numpy as np

    if audio.size == 0:
        return [], sr / max(1, int(round(frame_seconds * sr)))
    hop = max(1, int(round(frame_seconds * sr)))
    count = audio.size // hop
    if count == 0:
        energy = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
        return [energy], sr / hop
    frames = audio[: count * hop].reshape(count, hop)
    energies = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    return energies.tolist(), sr / hop


def _voiced_threshold(
    ordered_energy: Sequence[float],
    threshold_factor: float,
    energy_floor: float,
) -> float:
    """基础阈值 = median * threshold_factor,但封顶到响部(p90)的一半。

    纯中位数倍数在双峰分布上会翻车:有声帧占比过半时中位数本身就是人声
    能量,*2 后全曲判静音。封顶保证"有声帧只要不比演唱响度的一半还轻"就
    会被算进段里;而中位数倍数这条主规则继续负责把静音/弱噪声压在阈值下。
    """
    if not ordered_energy:
        return energy_floor
    middle = len(ordered_energy) // 2
    if len(ordered_energy) % 2:
        median = ordered_energy[middle]
    else:
        median = (ordered_energy[middle - 1] + ordered_energy[middle]) / 2.0
    loud = ordered_energy[min(len(ordered_energy) - 1, int(len(ordered_energy) * VAD_LOUD_PERCENTILE))]
    ceiling = loud * VAD_LOUD_CEILING_FRACTION
    return max(min(median * threshold_factor, ceiling), energy_floor)


def voiced_segments_from_energy(
    energy: Sequence[float],
    frame_rate: float,
    threshold_factor: float = VAD_THRESHOLD_FACTOR,
    min_gap_seconds: float = VAD_MIN_GAP_SECONDS,
    min_segment_seconds: float = VAD_MIN_SEGMENT_SECONDS,
    energy_floor: float = VAD_ENERGY_FLOOR,
) -> list[tuple[float, float]]:
    """(纯函数) 能量帧序列 -> 有声段 [start,end](秒)。

    阈值规则见 _voiced_threshold(median*factor,p90 一半封顶,floor 兜底);
    帧能量 >= 阈值的连续 run 即段;段间间隙 < min_gap_seconds 合并;时长
    < min_segment_seconds 丢弃。输入输出都不依赖 numpy,便于单测。
    """
    if frame_rate <= 0 or not energy:
        return []
    threshold = _voiced_threshold(sorted(energy), threshold_factor, energy_floor)

    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(energy):
        if value >= threshold:
            if start is None:
                start = index
        elif start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(energy)))

    merged: list[list[float]] = []
    for begin, end in runs:
        seg_start, seg_end = begin / frame_rate, end / frame_rate
        if merged and seg_start - merged[-1][1] < min_gap_seconds:
            merged[-1][1] = seg_end
        else:
            merged.append([seg_start, seg_end])
    return [(start, end) for start, end in merged if end - start >= min_segment_seconds]


# ---- Phase B: line<->segment mapping ----------------------------------------


def line_weight(text: str) -> float:
    # 行"长度":非空白字符数。中文按字、拼音文字按字母,与演唱时长的相关性都
    # 远好于词数;同一首歌内语种单一,归一化占比只受行间相对差异影响。
    return sum(1 for char in text if not char.isspace())


def _segment_start_distance(
    anchor: float,
    weight: float,
    segments: Sequence[tuple[float, float]],
    window: float = OFFSET_MATCH_WINDOW_SECONDS,
    ratio_band: tuple[float, float] = OFFSET_RATIO_BAND,
) -> float | None:
    """锚点到「可用段」起点的最小距离;无可用段返回 None。

    可用 = 段起点距锚点 <= window 且 段时长/行长 在 ratio_band 内(时长与
    文本长度成比例,排除把长行配到 0.5s 碎段/短行配到 10s 长段的假命中)。
    """
    best: float | None = None
    for start, end in segments:
        distance = abs(start - anchor)
        if distance > window:
            continue
        sec_per_char = (end - start) / max(weight, 1.0)
        if ratio_band[0] <= sec_per_char <= ratio_band[1]:
            if best is None or distance < best:
                best = distance
    return best


def estimate_global_offset(
    lrc_times: Sequence[float],
    line_weights: Sequence[float],
    segments: Sequence[tuple[float, float]],
) -> float:
    """(纯函数) 估计 LRC 时间轴到音频时间轴的全局偏移 d*(秒)。

    打分:对每个候选 d(OFFSET_MIN..OFFSET_MAX 步进 OFFSET_STEP),
        score(d) = Σ_{前 N 行} (1 - dist/窗口) ,
    dist = (LRC时间+d) 到可用段起点的距离(可用段限起点在前 OFFSET_SCAN_SECONDS
    秒内;锚点为负或出音频范围的行为不计分)。奖励随距离线性衰减,精确命中
    (dist≈0)接近满分,擦边命中(dist≈3s)只拿零头——纯命中计数会在密集准
    周期的人声段上大范围饱和(演員前 90s 任意 +5~15s 偏移都能 5/5 全中),
    衰减项把「每行都贴着段起点」的唯一偏移顶到最高分。平手时偏好小 |d|
    (无偏移先验),再偏好小 d。
    完全无命中 => 0.0(视 LRC 与音频同轴)。
    """
    head_segments = [
        (start, end) for start, end in segments if start <= OFFSET_SCAN_SECONDS
    ]
    anchor_count = min(OFFSET_ANCHOR_LINE_COUNT, len(lrc_times))
    best_score = -1.0
    best_offset = 0.0
    steps = int(round((OFFSET_MAX_SECONDS - OFFSET_MIN_SECONDS) / OFFSET_STEP_SECONDS))
    for step in range(steps + 1):
        offset = OFFSET_MIN_SECONDS + step * OFFSET_STEP_SECONDS
        score = 0.0
        for index in range(anchor_count):
            anchor = lrc_times[index] + offset
            if anchor < 0 or not head_segments or anchor > head_segments[-1][1]:
                continue
            distance = _segment_start_distance(anchor, line_weights[index], head_segments)
            if distance is not None:
                score += 1.0 - distance / OFFSET_MATCH_WINDOW_SECONDS
        if score > best_score + 1e-9 or (
            abs(score - best_score) <= 1e-9 and abs(offset) < abs(best_offset)
        ):
            best_score = score
            best_offset = offset
    return best_offset


def _absorb_segment(
    base_index: int,
    weight: float,
    segments: Sequence[tuple[float, float]],
    window_end: float,
) -> tuple[float, float]:
    """底段对文本过短时吞并紧邻后段,返回吞并后的 [start, end]。

    换气被 VAD 切开时一行歌词会碎成两段:只拿第一段,后半个句子的词会大面积
    塌缩被丢弃。吞并条件:当前时长/行长 < ABSORB_MIN_SEC_PER_CHAR,且下一段
    与当前段间隔 <= ABSORB_MAX_GAP_SECONDS 且其起点仍在行窗口内;吞并到比例
    上限(ABSORB_MAX_SEC_PER_CHAR)为止,避免把下一行也吞进来。
    """
    start, end = segments[base_index]
    sec_per_char = (end - start) / max(weight, 1.0)
    while sec_per_char < ABSORB_MIN_SEC_PER_CHAR and base_index + 1 < len(segments):
        next_start, next_end = segments[base_index + 1]
        if not 0.0 <= next_start - end <= ABSORB_MAX_GAP_SECONDS:
            break
        if next_start > window_end:
            break
        if (next_end - start) / max(weight, 1.0) > ABSORB_MAX_SEC_PER_CHAR:
            break
        end = next_end
        base_index += 1
        sec_per_char = (end - start) / max(weight, 1.0)
    return start, end


def map_lines_to_segments_windowed(
    lrc_times: Sequence[float],
    line_weights: Sequence[float],
    segments: Sequence[tuple[float, float]],
    offset: float,
    window: float = LINE_MATCH_WINDOW_SECONDS,
) -> list[tuple[float, float] | None]:
    """(纯函数) 窗口化行段配对:行 i -> 段区间或 None(unmatched)。

    每行锚点 = LRC时间 + offset,在锚点 ± window 内选「起点距锚点最近」的段;
    窗口内无段 => None。同一底段被多行选中(rap 一段多行)时按锚点中点把段
    切分给各行(切片边界仍源自 VAD 段边界与锚点间距,不引入 LRC 时间戳本身)。
    """
    picks: list[tuple[int, float] | None] = []  # (底段下标, |段起点-锚点|)
    for time, weight in zip(lrc_times, line_weights):
        anchor = time + offset
        low, high = anchor - window, anchor + window
        best: tuple[int, float] | None = None
        for index, (start, end) in enumerate(segments):
            if end < low or start > high:
                continue
            distance = abs(start - anchor)
            if best is None or distance < best[1]:
                best = (index, distance)
        picks.append(best)

    result: list[tuple[float, float] | None] = [None] * len(lrc_times)
    groups: dict[int, list[int]] = {}  # 底段下标 -> 行下标(升序)
    for line_index, pick in enumerate(picks):
        if pick is not None:
            groups.setdefault(pick[0], []).append(line_index)

    for segment_index, group in groups.items():
        anchors = [lrc_times[line_index] + offset for line_index in group]
        total_weight = sum(line_weights[line_index] for line_index in group)
        start, end = _absorb_segment(
            segment_index, total_weight, segments, max(anchors) + window
        )
        # 多行共享底段:相邻行锚点的中点为切分线(clip 进段内),每行得到
        # 自己的时间片;单行组退化为整个(可能吞并后的)段。切分线被 clip
        # 挤到一起时可能产生退化零宽片 => 该行 unmatched。
        cuts = [
            min(max((left + right) / 2.0, start), end)
            for left, right in zip(anchors, anchors[1:])
        ]
        bounds = [start] + cuts + [end]
        for position, line_index in enumerate(group):
            if bounds[position + 1] - bounds[position] >= MIN_CLIP_SECONDS:
                result[line_index] = (bounds[position], bounds[position + 1])
    return result


# ---- Phase C: ASR 词级锚定 -----------------------------------------------------


def _is_cjk_char(char: str) -> bool:
    code = ord(char)
    return any(low <= code <= high for low, high in CJK_RANGES)


def tokenize_for_match(text: str) -> list[str]:
    """(纯函数) 混合语种分词:CJK 逐字,连续非 CJK 字母数字合成一词(小写)。

    空白/标点天然丢弃(归一);ASR 段文本与 LRC 行文本必须用同一分词器,
    SequenceMatcher 的 token 相等比较才有可比粒度(中文按字、英文按词)。
    """
    tokens: list[str] = []
    run: list[str] = []
    for char in text:
        if _is_cjk_char(char):
            if run:
                tokens.append("".join(run).lower())
                run.clear()
            tokens.append(char.lower())
        elif char.isalnum():
            run.append(char)
        else:
            if run:
                tokens.append("".join(run).lower())
                run.clear()
    if run:
        tokens.append("".join(run).lower())
    return tokens


def expand_asr_segments_to_words(
    segments: Sequence[Mapping[str, object]],
) -> list[AsrWord]:
    """(纯函数) whisper 风格段级转写 -> 词级时间戳近似。

    转写服务的 segments 是段级(通常 2-6s),不是词级:把每段 text 分词后在
    段时长内均匀展开。近似对「行锚定」足够(行窗口再交 ForcedAligner 出字级),
    均匀假设只在段内不跨段。输出按 start 排序,时间非降。
    """
    words: list[AsrWord] = []
    for segment in segments:
        text = str(segment.get("text") or "")
        try:
            start = float(segment.get("start"))  # type: ignore[arg-type]
            end = float(segment.get("end"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        tokens = tokenize_for_match(text)
        if not tokens or end < start:
            continue
        step = (end - start) / len(tokens)
        for position, token in enumerate(tokens):
            words.append(AsrWord(token, start + position * step, start + (position + 1) * step))
    words.sort(key=lambda word: word.start)
    return words


def anchor_lines_to_asr(
    lrc_lines: Sequence[tuple[float, str]],
    asr_words: Sequence[AsrWord],
    min_similarity: float = ANCHOR_MIN_SIMILARITY,
    max_sec_per_char: float = ANCHOR_MAX_SEC_PER_CHAR,
) -> list[tuple[str, float, float] | None]:
    """(纯函数) LRC 行 -> ASR 词序列模糊锚定:每行 (text, start, end) 或 None。

    文本归一(tokenize_for_match:去空白/标点/小写,CJK 逐字)后,用
    difflib.SequenceMatcher(标准库,零新依赖)把每行 token 序列与「剩余」ASR
    词序列做模糊匹配:行时间 = 首个匹配词 start ~ 末个匹配词 end;行 token
    覆盖率(匹配数/行 token 数)< min_similarity 或 span 超过
    max_sec_per_char 秒/字 => None(unmatched)。游标只向后推进(在上一行末个
    匹配词之后搜索),保证副歌重复行各自锚到自己的出现位置,而不是全部吸到
    第一次出现;unmatched 行不推进游标,后续行仍可正常锚定。
    """
    anchors: list[tuple[str, float, float] | None] = []
    cursor = 0
    for _time, text in lrc_lines:
        tokens = tokenize_for_match(text)
        if not tokens or cursor >= len(asr_words):
            anchors.append(None)
            continue
        matcher = difflib.SequenceMatcher(
            None, tokens, [word.text for word in asr_words[cursor:]], autojunk=False
        )
        blocks = [block for block in matcher.get_matching_blocks() if block.size > 0]
        if not blocks or sum(block.size for block in blocks) / len(tokens) < min_similarity:
            anchors.append(None)
            continue
        first = cursor + min(block.b for block in blocks)
        last = cursor + max(block.b + block.size for block in blocks) - 1
        start, end = asr_words[first].start, asr_words[last].end
        if (end - start) / max(line_weight(text), 1.0) > max_sec_per_char:
            anchors.append(None)
            continue
        anchors.append((text, start, end))
        cursor = last + 1
    return anchors


def asr_settings(env: Mapping[str, str] | None = None) -> tuple[str, str, float]:
    """(纯函数) ASR 配置:KTV_ASR_BASE_URL(空=禁用,走 VAD 兜底)/
    KTV_ASR_MODEL(默认 mlx-community/Qwen3-ASR-1.7B-4bit)/KTV_ASR_TIMEOUT_S
    (默认 600s,非法值回退默认)。"""
    source = os.environ if env is None else env
    base_url = (source.get("KTV_ASR_BASE_URL") or "").strip().rstrip("/")
    model = (source.get("KTV_ASR_MODEL") or "").strip() or ASR_DEFAULT_MODEL
    raw_timeout = (source.get("KTV_ASR_TIMEOUT_S") or "").strip()
    try:
        timeout = float(raw_timeout) if raw_timeout else ASR_DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        timeout = ASR_DEFAULT_TIMEOUT_SECONDS
    return base_url, model, timeout


# 探测 requests(装了就用,没装则 urllib 手写 multipart);导入失败不影响模块加载
try:
    import requests as _requests_module
except Exception:  # pragma: no cover - depends on env
    _requests_module = None  # type: ignore[assignment]


def transcribe_via_asr(
    vocals_path: Path,
    lrclib_text: str,
    base_url: str | None = None,
    model: str | None = None,
    timeout_s: float | None = None,
    env: Mapping[str, str] | None = None,
) -> list[AsrWord]:
    """人声音频 -> ASR 词级时间戳近似(multipart POST {base}/v1/audio/transcriptions)。

    音频先 ffmpeg 转 16k mono m4a(临时文件,上传后随临时目录删除);prompt 用
    歌词前 ASR_PROMPT_CHAR_BUDGET 字做上下文偏置(提高专有名词命中)。任何失败
    (ffmpeg/网络/超时/HTTP 非 200/解析失败/无词级可用)抛 RuntimeError,由上层
    捕获后回退 VAD 锚定路径。
    """
    env_base, env_model, env_timeout = asr_settings(env)
    base = (base_url if base_url is not None else env_base).strip().rstrip("/")
    asr_model = (model if model is not None else env_model).strip() or ASR_DEFAULT_MODEL
    timeout = env_timeout if timeout_s is None else timeout_s
    if not base:
        raise RuntimeError("KTV_ASR_BASE_URL is not configured")

    prompt = re.sub(r"\s+", " ", lrclib_text or "").strip()[:ASR_PROMPT_CHAR_BUDGET]
    with tempfile.TemporaryDirectory(prefix="ktv-asr-") as tmp_name:
        m4a = Path(tmp_name) / "vocals-16k-mono.m4a"
        subprocess.run(
            [
                ffmpeg_cmd(), "-y", "-nostdin",
                "-i", str(vocals_path),
                "-vn",
                "-ac", "1", "-ar", str(SAMPLE_RATE),
                "-c:a", "aac", str(m4a),
            ],
            check=True,
            capture_output=True,
        )
        payload = _post_transcription(base, asr_model, m4a, prompt, timeout)
    words = expand_asr_segments_to_words(payload.get("segments") or [])
    if not words:
        excerpt = str(payload.get("text") or "")[:40]
        raise RuntimeError(f"asr returned no word timestamps (text={excerpt!r})")
    return words


def _multipart_body(
    fields: Mapping[str, str], file_field: str, file_name: str, file_bytes: bytes
) -> tuple[bytes, str]:
    """(纯函数) 手写 multipart/form-data 请求体(requests 未安装时的兜底)。

    返回 (body, boundary):字段按给定顺序编码,file 字段以 audio/mp4 附上。
    """
    boundary = "----ktv-asr-" + uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{file_name}"\r\n'
            f"Content-Type: audio/mp4\r\n\r\n"
        ).encode("utf-8")
    )
    parts.append(file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), boundary


def _post_transcription(
    base_url: str, model: str, m4a_path: Path, prompt: str, timeout: float
) -> dict:
    """POST 转写并解析 JSON 响应;requests 可用走 requests,否则 urllib 手写 multipart。"""
    url = f"{base_url}/v1/audio/transcriptions"
    if _requests_module is not None:
        try:
            with m4a_path.open("rb") as handle:
                response = _requests_module.post(
                    url,
                    files={"file": (m4a_path.name, handle, "audio/mp4")},
                    data={"model": model, "prompt": prompt},
                    timeout=timeout,
                )
        except Exception as error:
            raise RuntimeError(f"asr request failed: {error}") from error
        if response.status_code != 200:
            raise RuntimeError(
                f"asr http {response.status_code}: {response.text[:200]}"
            )
        try:
            return response.json()
        except ValueError as error:
            raise RuntimeError(f"asr response is not JSON: {error}") from error

    body, boundary = _multipart_body(
        {"model": model, "prompt": prompt}, "file", m4a_path.name, m4a_path.read_bytes()
    )
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise RuntimeError(f"asr http {response.status}")
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read()[:200]
        raise RuntimeError(f"asr http {error.code}: {detail!r}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise RuntimeError(f"asr request failed: {error}") from error





# ---- Phase B/C: per-line alignment (shared by VAD and ASR anchor paths) -------


def align_single_line(
    model,
    audio: "np.ndarray",
    sr: int,
    text: str,
    language: str,
    segment: tuple[float, float],
    margin: float = LINE_MARGIN_SECONDS,
) -> dict | None:
    """一行文本在自己段内独立对齐;失败/空结果返回 None(该行 unmatched)。

    词时间 = 模型输出的段内时间 + 切片起点偏移;行 start/end = 首/末词。
    """
    duration = audio.size / sr
    clip_start = max(0.0, segment[0] - margin)
    clip_end = min(duration, segment[1] + margin)
    if clip_end - clip_start < MIN_CLIP_SECONDS:
        return None
    low, high = int(clip_start * sr), int(clip_end * sr)
    clip = audio[low:high]
    try:
        results = model.align(audio=(clip, sr), text=text, language=language)
    except Exception:
        return None
    words: list[dict] = []
    for unit in results[0] if results else []:
        if unit.start_time is None or unit.end_time is None:
            continue
        start = clip_start + float(unit.start_time)
        end = clip_start + float(unit.end_time)
        if end < start:
            continue
        words.append({"text": unit.text, "start": round(start, 3), "end": round(end, 3)})
    if not words:
        return None
    return {"start": words[0]["start"], "end": words[-1]["end"], "text": text, "words": words}


def line_within_segment(
    entry: dict,
    segment: tuple[float, float],
    margin: float = SEGMENT_CONTAINMENT_MARGIN_SECONDS,
) -> bool:
    """(纯函数) 硬校验:对齐出的行时间必须落在其映射段的 [start-margin, end+margin] 内。

    输出时间的唯一合法来源是段边界 + unit 时间,正常情况行 start >= 段起点-0.3s
    (切片余量)、end <= 段终点+0.3s;margin 放宽到 1s 只为容忍模型边界毛刺。
    越界 = 该行对齐结果不可信,调用方必须丢弃该行(unmatched),不得输出。
    """
    return entry["start"] >= segment[0] - margin and entry["end"] <= segment[1] + margin


def collapsed_word_fraction(entry: dict, collapse_seconds: float = WORD_COLLAPSE_SECONDS) -> float:
    """(纯函数) 行内「塌缩词」占比:时长 < collapse_seconds 的词 / 总词数。

    正常对齐里几乎不存在 <20ms 的词(中文单字/英文短词也 ~100ms+);模型把
    整行文本硬塞进不含该语音的切片时会大面积产生 start==end 的词。占比是
    该行对齐是否可信的判别式(比词时长中位数敏感:中位数会被半数健康词顶住)。
    """
    words = entry["words"]
    if not words:
        return 1.0
    collapsed = sum(1 for word in words if word["end"] - word["start"] < collapse_seconds)
    return collapsed / len(words)


def _align_lines_to_windows(
    audio: "np.ndarray",
    sr: int,
    line_texts: Sequence[str],
    language: str,
    model,
    windows: Sequence[tuple[float, float] | None],
) -> tuple[list[dict], list[int], float | None]:
    """逐行独立对齐 + 行内可信度校验 + 时间单调兜底(VAD/ASR 两路共用)。

    windows[i] = 行 i 的对齐窗口 (start, end) 或 None(unmatched);VAD 路径传
    「配对段」,ASR 路径传「锚定词 span」——两条路都只把窗口交给
    align_single_line(内部再扩 ±LINE_MARGIN_SECONDS),输出时间只能来自窗口
    内的 aligner unit 时间。返回 (输出行, unmatched 行号, 首个被采用窗口的
    start —— 供质量门禁校验输出时间轴是否音频的)。
    """
    output_lines: list[tuple[int, dict]] = []
    unmatched_lines: list[int] = []
    first_window_start: float | None = None
    for index, text in enumerate(line_texts):
        window = windows[index] if index < len(windows) else None
        if window is None:
            unmatched_lines.append(index)
            continue
        entry = align_single_line(model, audio, sr, text, language, window)
        if (
            entry is None
            or not line_within_segment(entry, window)
            or collapsed_word_fraction(entry) > LINE_MAX_COLLAPSED_WORD_FRACTION
        ):
            unmatched_lines.append(index)
            continue
        if first_window_start is None:
            first_window_start = window[0]
        output_lines.append((index, entry))
    # 时间单调兜底:相邻窗口重叠/切分毛刺可能让后一行 start <= 前一行。局部
    # 毛刺按行丢弃(unmatched),不让整文件被「非严格递增」门禁拒掉;
    # evaluate_quality 的递增校验保留作最后防线。
    monotone_lines: list[dict] = []
    previous_start: float | None = None
    for index, entry in output_lines:
        if previous_start is not None and entry["start"] <= previous_start:
            unmatched_lines.append(index)
            continue
        previous_start = entry["start"]
        monotone_lines.append(entry)
    return monotone_lines, unmatched_lines, first_window_start


def align_lines(
    audio: "np.ndarray",
    sr: int,
    lines: Sequence[tuple[float, str]],
    language: str,
    model,
) -> tuple[list[dict], list[int], list[tuple[float, float]], float | None, float]:
    """对齐核心数据流(VAD 路径,无文件 IO,便于回归测试):VAD 分段 -> 全局偏移
    估计 -> 窗口化行段配对 -> 逐行独立对齐 -> 行时间硬校验。

    lines 是 parse_lrc 的 (LRC时间, 文本) 对:LRC 时间只作粗锚点(估 d*、开行
    窗口),输出时间仍只来自段边界 + aligner unit 时间。unmatched 行(窗口内
    无段/对齐失败/越界/词时间塌缩)一律不输出。返回
    (output_lines, unmatched_line_indexes, vad_segments,
     first_adopted_segment_start, global_offset),
    first_adopted_segment_start = 首个成功输出行所配 VAD 段的起点(供质量门禁
    校验输出时间轴与音频时间轴一致;无输出行时为 None)。
    """
    energy, frame_rate = frame_energies(audio, sr)
    segments = voiced_segments_from_energy(energy, frame_rate)
    lrc_times = [time for time, _ in lines]
    line_texts = [text for _, text in lines]
    weights = [line_weight(text) for text in line_texts]
    offset = estimate_global_offset(lrc_times, weights, segments)
    mapping = map_lines_to_segments_windowed(lrc_times, weights, segments, offset)
    output_lines, unmatched_lines, first_segment_start = _align_lines_to_windows(
        audio, sr, line_texts, language, model, mapping
    )
    return output_lines, unmatched_lines, segments, first_segment_start, offset


def align_lines_asr(
    audio: "np.ndarray",
    sr: int,
    lines: Sequence[tuple[float, str]],
    language: str,
    model,
    asr_words: Sequence[AsrWord],
) -> tuple[list[dict], list[int], list[tuple[str, float, float] | None], float, float | None]:
    """对齐核心数据流(ASR 锚定路径):行 -> ASR 词序列模糊锚定 -> 逐行窗口对齐。

    行窗口 = 锚定 (start, end)(align_single_line 内再扩 ±0.3s),逐行对齐与
    校验和 VAD 路径共用 _align_lines_to_windows——质量门禁对两条路一视同仁。
    LRC 时间戳完全不参与(锚定只看文本);unmatched 行(无锚定/对齐失败/越界/
    塌缩)不输出。返回 (output_lines, unmatched_line_indexes, anchors,
    anchor_success_rate, first_adopted_anchor_start)。
    """
    anchors = anchor_lines_to_asr(lines, asr_words)
    matched = sum(1 for anchor in anchors if anchor is not None)
    rate = matched / len(lines) if lines else 0.0
    windows = [None if anchor is None else (anchor[1], anchor[2]) for anchor in anchors]
    output_lines, unmatched_lines, first_anchor_start = _align_lines_to_windows(
        audio, sr, [text for _, text in lines], language, model, windows
    )
    return output_lines, unmatched_lines, anchors, rate, first_anchor_start


# ---- Phase B: quality gate ----------------------------------------------------


def evaluate_quality(
    output_lines: Sequence[dict],
    total_lrc_lines: int,
    first_segment_start: float | None = None,
) -> tuple[list[str], dict]:
    """返回 (问题列表, 统计)。问题列表非空 = 质量门禁不通过。

    first_segment_start 传入「首个被采用的 VAD 段」起点时启用硬时间轴校验:
    输出首行 start 偏离它超过 FIRST_LINE_SEGMENT_MAX_DEVIATION_SECONDS 即拒绝
    ——输出时间轴必须来自音频,绝不允许复刻 LRC 录音室时间轴(MV 带前奏时
    两者相差可达十几秒,Justin Bieber - Baby 实测 LRC 首行 3.4s vs MV 人声
    首段 15.8s)。
    """
    problems: list[str] = []
    for previous, current in zip(output_lines, output_lines[1:]):
        if current["start"] <= previous["start"]:
            problems.append("line times not strictly increasing")
            break
    if output_lines and first_segment_start is not None:
        deviation = output_lines[0]["start"] - first_segment_start
        if abs(deviation) > FIRST_LINE_SEGMENT_MAX_DEVIATION_SECONDS:
            problems.append(
                f"first line start {output_lines[0]['start']:.2f}s deviates {deviation:+.1f}s"
                + f" from first adopted VAD segment {first_segment_start:.2f}s"
                + " (output timeline is not the audio's; LRC timeline leakage?)"
            )
    coverage = len(output_lines) / total_lrc_lines if total_lrc_lines else 0.0
    if coverage < MIN_LINE_COVERAGE:
        problems.append(f"matched line coverage {coverage:.0%} < {MIN_LINE_COVERAGE:.0%}")
    durations = [word["end"] - word["start"] for line in output_lines for word in line["words"]]
    median = statistics.median(durations) if durations else 0.0
    low, high = WORD_DURATION_RANGE
    if not durations or not (low <= median <= high):
        problems.append(f"median word duration {median:.3f}s outside [{low:.2f}, {high:.1f}]s")
    # 词时间塌缩率(逐行 >50% 塌缩的行已在 align_lines 丢弃;这里兜底检查
    # 剩余输出里塌缩词的总体占比,防止大量 30-50% 塌缩的行凑出一份坏时间轴)
    total_words = len(durations)
    collapsed = sum(1 for line in output_lines for word in line["words"] if word["end"] - word["start"] < WORD_COLLAPSE_SECONDS)
    collapsed_fraction = collapsed / total_words if total_words else 0.0
    if collapsed_fraction > FILE_MAX_COLLAPSED_WORD_FRACTION:
        problems.append(
            f"word timings collapsed: {collapsed}/{total_words} words <{WORD_COLLAPSE_SECONDS}s"
            + f" ({collapsed_fraction:.0%} > {FILE_MAX_COLLAPSED_WORD_FRACTION:.0%})"
        )
    stats = {
        "lineCount": len(output_lines),
        "totalLines": total_lrc_lines,
        "coverage": round(coverage, 3),
        "medianWordDuration": round(median, 3),
        "wordCount": total_words,
        "collapsedWordFraction": round(collapsed_fraction, 3),
    }
    return problems, stats


# ---- main flow (shared by CLI and media_sidecar) ------------------------------


def convert_audio(src: Path, dst: Path) -> None:
    """整文件转 16k mono wav(mkv/m4a/wav 统一入口,-vn 丢弃视频轨)。"""
    subprocess.run(
        [
            ffmpeg_cmd(), "-y", "-nostdin",
            "-i", str(src),
            "-vn",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            str(dst),
        ],
        check=True,
        capture_output=True,
    )


def load_audio_16k_mono(src: Path, tmp_dir: Path) -> tuple["np.ndarray", int]:
    import soundfile as sf

    wav = tmp_dir / "audio-16k-mono.wav"
    convert_audio(src, wav)
    data, sr = sf.read(str(wav), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    import numpy as np

    return np.ascontiguousarray(data, dtype=np.float32), int(sr)


def align_file(
    audio: Path,
    lyrics: Path,
    out: Path,
    language: str,
    model,
    log: Callable[[str], None] = lambda message: print(message, file=sys.stderr),
    transcribe: Callable[[Path, str], list[AsrWord]] | None = None,
    asr_env: Mapping[str, str] | None = None,
) -> dict:
    """对齐主流程:ASR 词级锚定(可用时优先)-> 逐行独立对齐 -> 质量门禁 -> 写文件。

    CLI 与 media_sidecar.cmd_align 共用;模型对象由调用方加载(sidecar 内复用
    缓存)。ASR 路径:KTV_ASR_BASE_URL 已配置且转写成功且锚定成功率
    >= ASR_MIN_ANCHOR_COVERAGE 时,行窗口来自 ASR 词锚定;否则(未配置/超时/
    HTTP 错误/成功率低)完整回退 VAD 路径,回退原因记 stderr。质量不达标时抛
    QualityGateError 且不写任何输出。

    transcribe/asr_env 只为可测性注入(单测里塞假转写结果);生产调用不传,
    走 transcribe_via_asr + 进程 env(align-handler/backfill 的子进程天然继承
    KTV_ASR_* 三键)。stats["anchor"] = "asr" | "vad" 注明锚定路径。
    """
    lines = parse_lrc(lyrics)
    if not lines:
        raise AlignmentSkipped("no timestamped lyrics; skip")
    if not audio.exists():
        raise AlignmentSkipped(f"audio not found: {audio}")

    # LRC 时间自此只作粗锚点:估全局偏移 d* + 为每行开配对窗口(见 align_lines
    # 不变式),输出行时间仍只能来自 VAD 段边界 / ASR 词时间 + aligner unit 时间。
    line_texts = [text for _, text in lines]
    resolved_language = resolve_language(language, "\n".join(line_texts))

    with tempfile.TemporaryDirectory(prefix="ktv-align-") as tmp_name:
        audio_data, sr = load_audio_16k_mono(audio, Path(tmp_name))

        anchor_mode = "vad"
        anchor_rate = 0.0
        output_lines: list[dict] | None = None
        unmatched_lines: list[int] = []
        first_segment_start: float | None = None
        segments: list[tuple[float, float]] = []
        asr_word_count = 0

        if asr_settings(asr_env)[0]:
            transcriber = transcribe or (
                lambda audio_path, lyric_text: transcribe_via_asr(audio_path, lyric_text, env=asr_env)
            )
            try:
                asr_words = transcriber(audio, "\n".join(line_texts))
            except Exception as reason:  # 网络/HTTP/ffmpeg/解析:按设计回退 VAD
                log(f"asr anchor unavailable ({type(reason).__name__}: {reason}); falling back to vad")
            else:
                if asr_words:
                    asr_word_count = len(asr_words)
                    output_lines, unmatched_lines, _anchors, anchor_rate, first_segment_start = (
                        align_lines_asr(audio_data, sr, lines, resolved_language, model, asr_words)
                    )
                    if anchor_rate >= ASR_MIN_ANCHOR_COVERAGE:
                        anchor_mode = "asr"
                    else:
                        log(
                            f"asr anchor success rate {anchor_rate:.0%} < {ASR_MIN_ANCHOR_COVERAGE:.0%};"
                            " falling back to vad"
                        )
                        output_lines = None
                else:
                    log("asr returned no word timestamps; falling back to vad")

        if anchor_mode == "vad":
            output_lines, unmatched_lines, segments, first_segment_start, offset = align_lines(
                audio_data, sr, lines, resolved_language, model
            )
        else:
            offset = 0.0

    problems, stats = evaluate_quality(output_lines or [], len(line_texts), first_segment_start)
    stats.update(
        language=resolved_language,
        unmatchedLines=len(unmatched_lines),
        segments=len(segments) if anchor_mode == "vad" else asr_word_count,
        offsetSeconds=offset,
        anchor=anchor_mode,
        anchorRate=round(anchor_rate, 3),
    )
    if problems:
        raise QualityGateError(
            "; ".join(problems)
            + f" (lines={stats['lineCount']}/{stats['totalLines']},"
            + f" unmatched={stats['unmatchedLines']}, segments={stats['segments']},"
            + f" offset={stats['offsetSeconds']:+.0f}s,"
            + f" anchor={stats['anchor']},"
            + f" language={stats['language']})"
        )

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"lines": output_lines}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(
        f"aligned {stats['lineCount']}/{stats['totalLines']} line(s)"
        + f" [anchor={stats['anchor']}, coverage={stats['coverage']:.0%},"
        + f" offset={stats['offsetSeconds']:+.0f}s,"
        + f" {stats['language']}, {stats['segments']} unit(s)] -> {out}"
    )
    return stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--out", required=True)
    # "auto":按 LRC 文本 CJK 占比自动判定(规范名语种段「其他」等未命中场景)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--model", default="Qwen/Qwen3-ForcedAligner-0.6B")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="bfloat16")
    args = parser.parse_args()

    import torch
    from qwen_asr import Qwen3ForcedAligner

    dtype = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}[args.dtype]
    model = Qwen3ForcedAligner.from_pretrained(
        args.model,
        dtype=dtype,
        device_map=args.device,
    )

    try:
        align_file(Path(args.audio), Path(args.lyrics), Path(args.out), args.language, model)
    except AlignmentSkipped as reason:
        print(reason, file=sys.stderr)
        return 3
    except QualityGateError as reason:
        print(f"alignment quality-gate failed: {reason}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
