#!/usr/bin/env python
"""Resident media sidecar: demucs separation + Qwen3 forced alignment over stdin/stdout JSON-lines.

Protocol (one JSON object per line, UTF-8):
    request : {"id": 1, "cmd": "align"|"demucs"|"ping", "args": {...}}
    response: {"id": 1, "ok": true, "result": {...}} | {"id": 1, "ok": false, "error": "..."}

- stderr is log-only; stdout carries ONLY protocol lines (the real stdout fd is
  dup'ed at startup and sys.stdout is redirected to stderr so that chatty
  libraries loading models cannot corrupt the channel).
- Heavy models are loaded lazily on first use and cached in-process, keyed by
  (model, device[, dtype]) — the whole point of the sidecar is amortizing the
  multi-GB model load across songs.
- Each request is handled in its own try/except: one failure never kills the
  process.
- Exits after IDLE_TIMEOUT_SECONDS without any message, and on EOF / empty line.

cmd "align"   : same behavior as align_lyrics.py (LRC parse, ffmpeg chunking,
                Qwen3 alignment, JSON out) — core functions are imported from
                align_lyrics.py (same directory), so behavior stays in lockstep.
cmd "demucs"  : prefers the demucs python API (demucs.api.Separator, demucs>=4.1,
                initialized once and reused); falls back at runtime to a
                subprocess running the demucs module CLI (tree-killed by this
                process on timeout) when the API is unavailable. Output layout
                matches the CLI exactly: <outDir>/<model>/<track>/vocals.wav +
                no_vocals.wav (two-stems "vocals", other_method "add").
cmd "ping"    : health check, also used by the TS client as the startup probe.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

IDLE_TIMEOUT_SECONDS = 30 * 60
DEMUX_SUBPROCESS_TIMEOUT_SECONDS = 20 * 60

# Real stdout fd, kept for protocol writes only. Set in main() before any
# library that might print to stdout is imported.
_protocol_fd: int | None = None


def log(message: str) -> None:
    print(f"[media-sidecar] {message}", file=sys.stderr, flush=True)


def send_response(payload: dict) -> None:
    assert _protocol_fd is not None
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    data = line.encode("utf-8")
    remaining = 0
    while remaining < len(data):
        remaining += os.write(_protocol_fd, data[remaining:])


# ---- model caches -------------------------------------------------------

_ALIGN_MODELS: dict[tuple[str, str, str], object] = {}
_DEMUCS_SEPARATORS: dict[tuple[str, str], object] = {}
_demucs_api: object | None = None
_demucs_api_checked = False


def get_aligner(model: str, device: str, dtype_name: str):
    """Load (or fetch from cache) the Qwen3 forced aligner."""
    key = (model, device, dtype_name)
    cached = _ALIGN_MODELS.get(key)
    if cached is not None:
        return cached
    import torch
    from qwen_asr import Qwen3ForcedAligner

    dtype = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }[dtype_name]
    log(f"loading aligner model {model} on {device} ({dtype_name})")
    aligner = Qwen3ForcedAligner.from_pretrained(model, dtype=dtype, device_map=device)
    _ALIGN_MODELS[key] = aligner
    return aligner


def demucs_api_separator():
    """Return the demucs.api module if importable, else None (checked once)."""
    global _demucs_api, _demucs_api_checked
    if not _demucs_api_checked:
        _demucs_api_checked = True
        try:
            import demucs.api as api

            _demucs_api = api
        except Exception as error:  # pragma: no cover - depends on env
            log(f"demucs python API unavailable ({error}); will use subprocess fallback")
    return _demucs_api


def get_demucs_separator(api, model: str, device: str):
    key = (model, device)
    cached = _DEMUCS_SEPARATORS.get(key)
    if cached is not None:
        return cached
    log(f"loading demucs model {model} on {device}")
    separator = api.Separator(model=model, device=device, progress=False)
    _DEMUCS_SEPARATORS[key] = separator
    return separator


# ---- cmd handlers -------------------------------------------------------

def cmd_ping(args: dict) -> dict:
    return {
        "pong": True,
        "alignerModels": sorted({"|".join(k) for k in _ALIGN_MODELS}),
        "demucsModels": sorted({"|".join(k) for k in _DEMUCS_SEPARATORS}),
    }


def cmd_align(args: dict) -> dict:
    from align_lyrics import (
        CHUNK_LEAD_SECONDS,
        assign_units_to_lines,
        audio_duration,
        chunk_lines,
        cut_audio,
        join_text,
        parse_lrc,
    )

    audio_path = Path(args["audio"])
    lyrics_path = Path(args["lyrics"])
    out_path = Path(args["out"])
    language = args.get("language", "Chinese")
    model = args.get("model", "Qwen/Qwen3-ForcedAligner-0.6B")
    device = args.get("device", "cuda:0")
    dtype = args.get("dtype", "bfloat16")

    lines = parse_lrc(lyrics_path)
    if not lines:
        raise RuntimeError("no timestamped lyrics; skip")
    if not audio_path.exists():
        raise RuntimeError(f"audio not found: {audio_path}")

    aligner = get_aligner(model, device, dtype)

    try:
        duration = audio_duration(audio_path)
    except Exception:
        duration = lines[-1][0] + 30.0

    all_output: list[dict] = []
    chunks = chunk_lines(lines)
    with tempfile.TemporaryDirectory(prefix="ktv-sidecar-align-") as tmp:
        for chunk_index, chunk in enumerate(chunks):
            chunk_start = max(0.0, chunk[0][0] - CHUNK_LEAD_SECONDS)
            chunk_end = duration if chunk_index == len(chunks) - 1 else chunk[-1][0] + 8.0
            chunk_audio = Path(tmp) / f"chunk-{int(chunk_start)}.wav"
            try:
                cut_audio(audio_path, chunk_audio, chunk_start, chunk_end)
            except subprocess.CalledProcessError as error:
                log(f"ffmpeg cut failed: {error}")
                continue

            results = aligner.align(
                audio=str(chunk_audio),
                text=join_text(chunk, language),
                language=language,
            )
            units = [
                (unit.text, unit.start_time + chunk_start, unit.end_time + chunk_start)
                for unit in (results[0] if results else [])
            ]
            all_output.extend(assign_units_to_lines(units, [text for _, text in chunk]))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"lines": all_output}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(f"aligned {len(all_output)} line(s) -> {out_path}")
    return {"lines": len(all_output), "out": str(out_path)}


def _save_demucs_outputs(separator, sources: dict, track_stem: str, out_dir: Path) -> list[str]:
    """Persist stems with the exact layout/params of the demucs CLI (--two-stems vocals,
    other_method "add"): <out>/<model>/<track>/<stem>.wav, 16-bit wav, clip=rescale."""
    import torch

    from demucs.audio import save_audio

    written: list[str] = []
    common = {"samplerate": separator.samplerate, "bitrate": 320, "preset": 2,
              "clip": "rescale", "as_float": False, "bits_per_sample": 16}

    def write(wav, stem_name: str) -> None:
        stem_path = out_dir / track_stem / f"{stem_name}.wav"
        stem_path.parent.mkdir(parents=True, exist_ok=True)
        save_audio(wav, str(stem_path), **common)
        written.append(str(stem_path))

    vocals = sources.pop("vocals")
    write(vocals, "vocals")
    other = None
    for wav in sources.values():
        other = wav if other is None else other + wav
    if other is None:
        other = torch.zeros_like(vocals)
    write(other, "no_vocals")
    return written


def _kill_tree(process: subprocess.Popen) -> None:
    if os.name == "nt":
        if process.pid:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
        process.kill()
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except Exception:
            process.kill()


def _demucs_via_subprocess(args: dict) -> dict:
    """Fallback: run the demucs module CLI as a child of this sidecar (tree-killed
    on timeout). Mirrors the pre-sidecar behavior one level deeper in the tree."""
    bin_path = args.get("fallbackBin") or ""
    bin_args = [part for part in str(args.get("binArgs") or "").split() if part]
    if bin_path:
        command = [bin_path, *bin_args]
    else:
        command = [sys.executable, "-m", "demucs"]
    command += [
        "--two-stems", args.get("twoStems", "vocals"),
        "-n", args["model"],
        "-d", args["device"],
        "-o", args["outDir"],
        args["audio"],
    ]
    log(f"demucs subprocess: {' '.join(command)}")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        creationflags=creationflags,
        start_new_session=(os.name != "nt"),
    )
    try:
        output, _ = process.communicate(timeout=DEMUX_SUBPROCESS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        _kill_tree(process)
        raise RuntimeError(f"demucs subprocess timed out after {DEMUX_SUBPROCESS_TIMEOUT_SECONDS}s")
    if output and output.strip():
        tail = "\n".join(output.strip().splitlines()[-4:])
        log(f"demucs subprocess output tail:\n{tail}")
    if process.returncode != 0:
        raise RuntimeError(f"demucs subprocess failed with exit code {process.returncode}")

    track_stem = Path(args["audio"]).name.rsplit(".", 1)[0]
    out_dir = Path(args["outDir"]) / args["model"] / track_stem
    files = [str(path) for path in sorted(out_dir.glob("*.wav"))] if out_dir.exists() else []
    return {"files": files, "via": "subprocess"}


def cmd_demucs(args: dict) -> dict:
    audio_path = Path(args["audio"])
    if not audio_path.exists():
        raise RuntimeError(f"audio not found: {audio_path}")

    api = demucs_api_separator()
    if api is not None:
        separator = get_demucs_separator(api, args["model"], args["device"])
        track_stem = audio_path.name.rsplit(".", 1)[0]
        out_dir = Path(args["outDir"]) / args["model"]
        log(f"demucs api: {audio_path} -> {out_dir}")
        _origin, sources = separator.separate_audio_file(audio_path)
        files = _save_demucs_outputs(separator, dict(sources), track_stem, out_dir)
        return {"files": files, "via": "python-api"}

    return _demucs_via_subprocess(args)


HANDLERS = {
    "ping": cmd_ping,
    "align": cmd_align,
    "demucs": cmd_demucs,
}


def handle_request(request: dict) -> None:
    request_id = request.get("id")
    cmd = request.get("cmd")
    handler = HANDLERS.get(cmd)
    try:
        if handler is None:
            raise RuntimeError(f"unknown cmd: {cmd}")
        result = handler(request.get("args") or {})
        send_response({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        log(f"request {request_id} cmd={cmd} failed: {message}")
        send_response({"id": request_id, "ok": False, "error": message[:2000]})


class IdleExit:
    """Exits the process after IDLE_TIMEOUT_SECONDS without a stdin message."""

    def __init__(self) -> None:
        self._timer = threading.Timer(IDLE_TIMEOUT_SECONDS, self._expire)
        self._timer.daemon = True

    def _expire(self) -> None:
        log(f"idle for {IDLE_TIMEOUT_SECONDS}s, exiting")
        os._exit(0)

    def start(self) -> None:
        self._timer.start()

    def reset(self) -> None:
        self._timer.cancel()
        self._timer = threading.Timer(IDLE_TIMEOUT_SECONDS, self._expire)
        self._timer.daemon = True
        self._timer.start()

    def stop(self) -> None:
        self._timer.cancel()


def main() -> int:
    global _protocol_fd
    _protocol_fd = os.dup(1)
    # Libraries loaded later (torch / transformers / demucs) sometimes print to
    # stdout; move sys.stdout out of the way so the protocol channel stays clean.
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    idle = IdleExit()
    idle.start()
    log("ready (json-lines protocol on stdout)")
    try:
        for line in sys.stdin:
            idle.reset()
            stripped = line.strip()
            if not stripped:
                log("empty line -> exit")
                return 0
            try:
                request = json.loads(stripped)
            except json.JSONDecodeError as error:
                log(f"malformed request line: {error}")
                send_response({"id": None, "ok": False, "error": f"bad json: {error}"})
                continue
            if not isinstance(request, dict):
                send_response({"id": None, "ok": False, "error": "request must be a json object"})
                continue
            handle_request(request)
    except KeyboardInterrupt:
        pass
    finally:
        idle.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
