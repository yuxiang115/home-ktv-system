#!/usr/bin/env python
"""Char/word-level karaoke timing via Qwen3-ForcedAligner.

Input : vocals wav + line-level LRC
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
    for raw in path.read_text(encoding="utf-8").splitlines():
        stamps = LRC_TS.findall(raw)
        if not stamps:
            continue
        text = LRC_TS.sub("", raw).strip()
        if not text:
            continue
        for minutes, seconds in stamps:
            lines.append((int(minutes) * 60 + float(seconds.replace(":", ".")), text))
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


def join_text(lines: list[tuple[float, str]], language: str) -> str:
    # 中日文无空格分隔;其他语言按空格 join
    separator = "" if language in ("Chinese", "Cantonese", "Japanese") else " "
    return separator.join(text for _, text in lines)


def assign_units_to_lines(
    units: list[tuple[str, float, float]], line_texts: list[str]
) -> list[dict]:
    """Walk aligner units sequentially, consuming each line's char budget."""
    output: list[dict] = []
    unit_index = 0
    for text in line_texts:
        need = sum(1 for char in text if not char.isspace())
        words: list[dict] = []
        while need > 0 and unit_index < len(units):
            unit_text, start, end = units[unit_index]
            words.append({"text": unit_text, "start": round(start, 3), "end": round(end, 3)})
            need -= max(1, sum(1 for char in unit_text if not char.isspace()))
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
            all_output.extend(assign_units_to_lines(units, [text for _, text in chunk]))

    Path(args.out).write_text(
        json.dumps({"lines": all_output}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"aligned {len(all_output)} line(s) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
