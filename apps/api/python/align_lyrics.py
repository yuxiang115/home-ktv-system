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

New pipeline:
  1. language: --language auto (spec name marker "其他" etc.) is resolved from
     the LRC text itself — CJK ratio >= 30% -> Chinese (Japanese/Korean by their
     own scripts), otherwise English. Resolved BEFORE the model is called: the
     aligner tokenizes by the language label, so "auto" never reaches it.
  2. VAD: 16k mono energy frames -> voiced segments (pure function, unit
     tested). Vocals stems make instrumental parts near-silent, so segments
     approximate sung phrases.
  3. line<->segment pairing: LRC line TEXT (timestamps are never used for any
     alignment decision) paired to segments greedily in order, matching
     text-share to duration-share within a tolerance; extra segments
     (intro/interlude/ad-lib) are skipped, surplus lines stay unmatched.
  4. per-line alignment: each line is aligned independently against its own
     segment (+/-0.3s margin) by the cached model, so one wrong segment can
     never poison the rest of the song.
  5. quality gate (before writing anything): line times strictly increasing,
     matched line coverage >= 80%, median word duration within 0.05~2s.
     Failure => no output file, one-line report on stderr, exit code 4
     (= alignment quality below bar; callers degrade best-effort to LRC).

Exit codes: 0 ok / 3 skipped (no lyrics / audio missing) / 4 quality gate / 1 error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Sequence

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

# ---- Phase B: line<->segment mapping -------------------------------------
# 行文本占比与段时长占比都归一化到 [0,1] 后做累计端点匹配;容差是歌曲全长
# 的比例(0.10 = 允许累计偏差 10%),过大易错配相邻段,过小易整行 unmatched。
MAP_TOLERANCE = 0.10

# ---- Phase B: per-line alignment -----------------------------------------
LINE_MARGIN_SECONDS = 0.3  # 切段时两侧余量,VAD 边界切掉半个字时兜底
MIN_CLIP_SECONDS = 0.2     # 短于该值的切片直接判 unmatched(模型对空切片不稳)

# ---- Phase B: quality gate ------------------------------------------------
MIN_LINE_COVERAGE = 0.8
WORD_DURATION_RANGE = (0.05, 2.0)


class AlignmentSkipped(RuntimeError):
    """输入不可用(无歌词/音频缺失),调用方应按 skip 处理而非失败。"""


class QualityGateError(RuntimeError):
    """对齐质量不达标:输出文件不写,CLI 以 exit 4 退出。"""


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


def _cumulative_shares(values: Sequence[float]) -> list[float]:
    total = sum(values)
    shares: list[float] = []
    accumulated = 0.0
    for value in values:
        accumulated += value
        shares.append(accumulated / total if total > 0 else 0.0)
    return shares


def map_lines_to_segments(
    line_weights: Sequence[float],
    segment_durations: Sequence[float],
    tolerance: float = MAP_TOLERANCE,
) -> list[int | None]:
    """(纯函数) 歌词行 -> 演唱段的顺序贪心配对。

    把行权重与段时长各自归一化成累计占比序列,每行取累计端点最接近自己的段
    (单调前移,已用段不复用):段多于行时,端点不像任何歌词行的段(前奏/
    间奏/ad-lib)自然被跳过;行多于段时多出的行标 None(unmatched,进 QA 报告)。
    """
    if not line_weights or not segment_durations:
        return [None] * len(line_weights)
    line_ends = _cumulative_shares(line_weights)
    segment_ends = _cumulative_shares(segment_durations)
    result: list[int | None] = []
    next_segment = 0
    for target in line_ends:
        index = next_segment
        if index >= len(segment_durations):
            result.append(None)
            continue
        while (
            index + 1 < len(segment_durations)
            and abs(segment_ends[index + 1] - target) < abs(segment_ends[index] - target)
        ):
            index += 1
        if abs(segment_ends[index] - target) <= tolerance:
            result.append(index)
            next_segment = index + 1
        else:
            result.append(None)
    return result


# ---- Phase B: per-line alignment --------------------------------------------


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


# ---- Phase B: quality gate ----------------------------------------------------


def evaluate_quality(output_lines: Sequence[dict], total_lrc_lines: int) -> tuple[list[str], dict]:
    """返回 (问题列表, 统计)。问题列表非空 = 质量门禁不通过。"""
    problems: list[str] = []
    for previous, current in zip(output_lines, output_lines[1:]):
        if current["start"] <= previous["start"]:
            problems.append("line times not strictly increasing")
            break
    coverage = len(output_lines) / total_lrc_lines if total_lrc_lines else 0.0
    if coverage < MIN_LINE_COVERAGE:
        problems.append(f"matched line coverage {coverage:.0%} < {MIN_LINE_COVERAGE:.0%}")
    durations = [word["end"] - word["start"] for line in output_lines for word in line["words"]]
    median = statistics.median(durations) if durations else 0.0
    low, high = WORD_DURATION_RANGE
    if not durations or not (low <= median <= high):
        problems.append(f"median word duration {median:.3f}s outside [{low:.2f}, {high:.1f}]s")
    stats = {
        "lineCount": len(output_lines),
        "totalLines": total_lrc_lines,
        "coverage": round(coverage, 3),
        "medianWordDuration": round(median, 3),
        "wordCount": len(durations),
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
) -> dict:
    """对齐主流程:VAD 分段 -> 行段映射 -> 逐行独立对齐 -> 质量门禁 -> 写文件。

    CLI 与 media_sidecar.cmd_align 共用;模型对象由调用方加载(sidecar 内复用
    缓存)。质量不达标时抛 QualityGateError 且不写任何输出。
    """
    lines = parse_lrc(lyrics)
    if not lines:
        raise AlignmentSkipped("no timestamped lyrics; skip")
    if not audio.exists():
        raise AlignmentSkipped(f"audio not found: {audio}")

    line_texts = [text for _, text in lines]
    resolved_language = resolve_language(language, "\n".join(line_texts))

    with tempfile.TemporaryDirectory(prefix="ktv-align-") as tmp_name:
        audio_data, sr = load_audio_16k_mono(audio, Path(tmp_name))
        energy, frame_rate = frame_energies(audio_data, sr)
        segments = voiced_segments_from_energy(energy, frame_rate)
        mapping = map_lines_to_segments(
            [line_weight(text) for text in line_texts],
            [end - start for start, end in segments],
        )

        output_lines: list[dict] = []
        unmatched_lines: list[int] = []
        for index, text in enumerate(line_texts):
            segment_index = mapping[index] if index < len(mapping) else None
            if segment_index is None:
                unmatched_lines.append(index)
                continue
            entry = align_single_line(model, audio_data, sr, text, resolved_language, segments[segment_index])
            if entry is None:
                unmatched_lines.append(index)
                continue
            output_lines.append(entry)

    problems, stats = evaluate_quality(output_lines, len(line_texts))
    stats.update(
        language=resolved_language,
        unmatchedLines=len(unmatched_lines),
        segments=len(segments),
    )
    if problems:
        raise QualityGateError(
            "; ".join(problems)
            + f" (lines={stats['lineCount']}/{stats['totalLines']},"
            + f" unmatched={stats['unmatchedLines']}, segments={stats['segments']},"
            + f" language={stats['language']})"
        )

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"lines": output_lines}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(
        f"aligned {stats['lineCount']}/{stats['totalLines']} line(s)"
        + f" [{stats['language']}, {stats['segments']} segment(s)] -> {out}"
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
