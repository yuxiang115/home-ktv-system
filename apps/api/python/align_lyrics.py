#!/usr/bin/env python
"""Char/word-level karaoke timing via Qwen3-ForcedAligner.

Input : audio (vocals wav preferred; any ffmpeg-readable media like the downloaded
        mkv also works — ffmpeg converts to 16k mono, slightly lower quality but
        correct timing) + line-level LRC
Output: JSON {"lines":[{"start","end","text","words":[{"text","start","end"}]}]} (seconds)

Qwen3-ForcedAligner aligns at most ~5 minutes per call, so long songs are cut
into <=240s chunks at LRC line boundaries (ffmpeg) and timestamps are offset
back. Exit codes: 0 ok / 3 skipped (no lyrics) / 1 error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

LRC_TS = re.compile(r"\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]")
# 增强版(A2)行内逐字时间戳 <mm:ss.xx>:不参与对齐文本(否则污染字符预算),剥离
LRC_WORD_TS = re.compile(r"<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>")
# offset 元数据(毫秒):正值 => 歌词提前(时间轴前移),即 time -= offset/1000
LRC_OFFSET = re.compile(r"\[offset:([+-]?\d+(?:\.\d+)?)\]", re.IGNORECASE)
CHUNK_SECONDS = 240.0
CHUNK_LEAD_SECONDS = 1.0


def ffmpeg_cmd() -> str:
    return os.environ.get("FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg"


def ffprobe_cmd() -> str:
    # 跟随 FFMPEG_BIN 同目录的 ffprobe,否则裸命令
    ffmpeg = os.environ.get("FFMPEG_BIN", "").strip()
    if ffmpeg:
        sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
        if sibling.exists():
            return str(sibling)
    return "ffprobe"


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


def audio_duration(path: Path) -> float:
    result = subprocess.run(
        [ffprobe_cmd(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


def cut_audio(src: Path, dst: Path, start: float, end: float) -> None:
    subprocess.run(
        [
            ffmpeg_cmd(), "-y", "-nostdin",
            "-ss", f"{max(0.0, start):.3f}",
            "-to", f"{end:.3f}",
            "-i", str(src),
            # 源可能是含视频轨的 mkv(下载产物/库内文件直接对齐):-vn 丢弃视频流,
            # 只取最佳音频流转 16k mono(wav 容器本身也不含视频,显式声明更稳)
            "-vn",
            "-ac", "1", "-ar", "16000",
            str(dst),
        ],
        check=True,
        capture_output=True,
    )


def chunk_lines(lines: list[tuple[float, str]]) -> list[list[tuple[float, str]]]:
    """Split LRC lines into chunks whose time span stays under CHUNK_SECONDS."""
    chunks: list[list[tuple[float, str]]] = []
    current: list[tuple[float, str]] = []
    chunk_start = lines[0][0] if lines else 0.0
    for line in lines:
        if current and line[0] - chunk_start > CHUNK_SECONDS:
            chunks.append(current)
            current = []
            chunk_start = line[0]
        current.append(line)
    if current:
        chunks.append(current)
    return chunks


def is_space_separated(language: str) -> bool:
    # 中日文无空格分隔;其他语言(英/韩等)按空格分词,与 join_text 的分隔规则保持一致
    return language not in ("Chinese", "Cantonese", "Japanese")


def join_text(lines: list[tuple[float, str]], language: str) -> str:
    separator = "" if not is_space_separated(language) else " "
    return separator.join(text for _, text in lines)


def count_words(text: str) -> int:
    # 空白分词语言的"词数":按任意空白切分;全空白按 0 计(与字符预算的空行行为一致)
    return len(text.split())


def _looks_cjk(text: str) -> bool:
    # 未显式传 space_separated 的调用方(如 media_sidecar 的 cmd_align,按位置传参、
    # 不能跟着改签名)靠文本侧推断:非空白字符中汉字/假名过半 => CJK 字符预算语言。
    # 韩文不算 CJK(谚文用空格分词,与 join_text 的规则一致)。
    chars = [char for char in text if not char.isspace()]
    if not chars:
        return False
    cjk = sum(
        1
        for char in chars
        if "\u3040" <= char <= "\u30ff"
        or "\u3400" <= char <= "\u4dbf"
        or "\u4e00" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
    )
    return cjk * 2 >= len(chars)


def assign_units_to_lines(
    units: list[tuple[str, float, float]], line_texts: list[str], space_separated: bool | None = None
) -> list[dict]:
    """Walk aligner units sequentially, consuming each line's budget.

    CJK: budget = non-whitespace character count (units are characters).
    Space-separated languages: budget = word count (units are words). Counting
    characters drifts when unit boundaries do not land exactly on word
    boundaries (punctuation, merged tokens), pushing later words onto the
    wrong line; the word count can only be off by whole units, never by a
    fraction, so lines stay aligned to the aligner's own tokenization.

    space_separated=None (default) infers the mode from the line texts so that
    callers that do not know the language still get the right budget.
    """
    if space_separated is None:
        space_separated = not _looks_cjk("".join(line_texts))
    output: list[dict] = []
    unit_index = 0
    for text in line_texts:
        need = count_words(text) if space_separated else sum(1 for char in text if not char.isspace())
        words: list[dict] = []
        while need > 0 and unit_index < len(units):
            unit_text, start, end = units[unit_index]
            words.append({"text": unit_text, "start": round(start, 3), "end": round(end, 3)})
            consumed = count_words(unit_text) if space_separated else sum(
                1 for char in unit_text if not char.isspace()
            )
            need -= max(1, consumed)
            unit_index += 1
        if words:
            output.append(
                {
                    "start": words[0]["start"],
                    "end": words[-1]["end"],
                    "text": text,
                    "words": words,
                }
            )
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--model", default="Qwen/Qwen3-ForcedAligner-0.6B")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="bfloat16")
    args = parser.parse_args()

    lines = parse_lrc(Path(args.lyrics))
    if not lines:
        print("no timestamped lyrics; skip", file=sys.stderr)
        return 3
    audio_path = Path(args.audio)
    if not audio_path.exists():
        print(f"audio not found: {audio_path}", file=sys.stderr)
        return 3

    import torch
    from qwen_asr import Qwen3ForcedAligner

    dtype = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}[args.dtype]
    model = Qwen3ForcedAligner.from_pretrained(
        args.model,
        dtype=dtype,
        device_map=args.device,
    )

    try:
        duration = audio_duration(audio_path)
    except Exception:
        duration = lines[-1][0] + 30.0

    all_output: list[dict] = []
    chunks = chunk_lines(lines)
    with tempfile.TemporaryDirectory(prefix="ktv-align-") as tmp:
        for chunk_index, chunk in enumerate(chunks):
            chunk_start = max(0.0, chunk[0][0] - CHUNK_LEAD_SECONDS)
            chunk_end = duration if chunk_index == len(chunks) - 1 else chunk[-1][0] + 8.0
            chunk_audio = Path(tmp) / f"chunk-{int(chunk_start)}.wav"
            try:
                cut_audio(audio_path, chunk_audio, chunk_start, chunk_end)
            except subprocess.CalledProcessError as error:
                print(f"ffmpeg cut failed: {error}", file=sys.stderr)
                continue

            results = model.align(
                audio=str(chunk_audio),
                text=join_text(chunk, args.language),
                language=args.language,
            )
            units = [
                (unit.text, unit.start_time + chunk_start, unit.end_time + chunk_start)
                for unit in (results[0] if results else [])
            ]
            all_output.extend(
                assign_units_to_lines(
                    units, [text for _, text in chunk], is_space_separated(args.language)
                )
            )

    Path(args.out).write_text(
        json.dumps({"lines": all_output}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"aligned {len(all_output)} line(s) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
