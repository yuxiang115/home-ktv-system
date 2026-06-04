#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_DB_SSH_HOST = "dev"
DEFAULT_DB_CONTAINER = "home-ktv-postgres-1"
DEFAULT_DB_USER = "ktv"
DEFAULT_DB_NAME = "home_ktv"
DEFAULT_COVER_SSH_HOST = "dev"
DEFAULT_COVER_ROOT = "/opt/home-ktv-system/runtime/media/covers/nas"
DEFAULT_MEDIA_SSH_HOST = "pve"
DEFAULT_MEDIA_SOURCE_PREFIX = "/mnt/nas"
DEFAULT_MEDIA_TARGET_PREFIX = "/hdd-pool/nas"
SAFE_SONG_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
REMOTE_DELETE_FILES_SCRIPT = (
    "import json, os, sys\n"
    "paths = json.load(sys.stdin)\n"
    "deleted = []\n"
    "missing = []\n"
    "failed = []\n"
    "for raw_path in paths:\n"
    "    path = str(raw_path or '').strip()\n"
    "    if not path:\n"
    "        continue\n"
    "    try:\n"
    "        if os.path.exists(path):\n"
    "            if os.path.isdir(path):\n"
    "                failed.append({'path': path, 'error': 'is_directory'})\n"
    "            else:\n"
    "                os.remove(path)\n"
    "                deleted.append(path)\n"
    "        else:\n"
    "            missing.append(path)\n"
    "    except Exception as error:\n"
    "        failed.append({'path': path, 'error': str(error)[:300]})\n"
    "print(json.dumps({\n"
    "    'requested': len(paths),\n"
    "    'deleted': len(deleted),\n"
    "    'missing': len(missing),\n"
    "    'failed': len(failed),\n"
    "    'failedSamples': failed[:20],\n"
    "}, ensure_ascii=False))\n"
)


@dataclass(frozen=True)
class DeleteSongRow:
    id: str
    title: str
    primary_artist_name: str
    artist_names: str
    cover_image_url: str
    file_path: str
    size_bytes: int


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "plan":
        return run_plan(args)
    if args.command == "apply":
        return run_apply(args)
    raise SystemExit(f"Unsupported command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Delete uncovered songs from DB, cached covers, and NAS media files using a prepared CSV list."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("plan", "apply"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--input", required=True)
        sub.add_argument("--output", default="")
        sub.add_argument("--db-ssh-host", default=DEFAULT_DB_SSH_HOST)
        sub.add_argument("--db-container", default=DEFAULT_DB_CONTAINER)
        sub.add_argument("--db-user", default=DEFAULT_DB_USER)
        sub.add_argument("--db-name", default=DEFAULT_DB_NAME)
        sub.add_argument("--cover-ssh-host", default=DEFAULT_COVER_SSH_HOST)
        sub.add_argument("--cover-root", default=DEFAULT_COVER_ROOT)
        sub.add_argument("--media-ssh-host", default=DEFAULT_MEDIA_SSH_HOST)
        sub.add_argument("--media-source-prefix", default=DEFAULT_MEDIA_SOURCE_PREFIX)
        sub.add_argument("--media-target-prefix", default=DEFAULT_MEDIA_TARGET_PREFIX)
    return parser.parse_args([arg for arg in argv if arg != "--"])


def run_plan(args: argparse.Namespace) -> int:
    input_path = resolve_input_path(args.input)
    rows = load_delete_rows(input_path)
    report_path = resolve_report_path(input_path, args.output, "plan")
    report = {
        "generatedAt": now_iso(),
        "input": str(input_path),
        **build_plan_summary(rows),
    }
    write_json(report_path, report)
    print(json.dumps({"report": str(report_path), **report}, ensure_ascii=False))
    return 0


def run_apply(args: argparse.Namespace) -> int:
    input_path = resolve_input_path(args.input)
    rows = load_delete_rows(input_path)
    report_path = resolve_report_path(input_path, args.output, "apply")
    plan_summary = build_plan_summary(rows)

    db_result = delete_database_rows(rows, args)
    cover_paths = build_cover_paths(rows, args.cover_root)
    media_paths = build_media_paths(rows, args.media_source_prefix, args.media_target_prefix)
    cover_result = delete_remote_paths(args.cover_ssh_host, cover_paths)
    media_result = delete_remote_paths(args.media_ssh_host, media_paths)

    report = {
        "generatedAt": now_iso(),
        "input": str(input_path),
        "dbHost": args.db_ssh_host,
        "coverHost": args.cover_ssh_host,
        "mediaHost": args.media_ssh_host,
        **plan_summary,
        "database": db_result,
        "coverFiles": cover_result,
        "mediaFiles": media_result,
    }
    write_json(report_path, report)
    print(json.dumps({"report": str(report_path), **report}, ensure_ascii=False))
    return 0


def resolve_input_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Input CSV not found: {path}")
    return path


def resolve_report_path(input_path: Path, output: str, suffix: str) -> Path:
    if output:
        return Path(output).resolve()
    return input_path.with_name(f"{input_path.stem}.{suffix}.json")


def load_delete_rows(path: Path) -> list[DeleteSongRow]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: list[DeleteSongRow] = []
        for row in reader:
            song_id = clean_text(row.get("id") or "")
            if not song_id:
                continue
            rows.append(
                DeleteSongRow(
                    id=song_id,
                    title=clean_text(row.get("title") or ""),
                    primary_artist_name=clean_text(row.get("primary_artist_name") or ""),
                    artist_names=clean_text(row.get("artist_names") or ""),
                    cover_image_url=clean_text(row.get("cover_image_url") or ""),
                    file_path=clean_text(row.get("file_path") or ""),
                    size_bytes=parse_int(row.get("size_bytes") or "0"),
                )
            )
        return rows


def parse_int(value: str) -> int:
    text = clean_text(value)
    if not text:
        return 0
    return int(text)


def build_plan_summary(rows: list[DeleteSongRow]) -> dict[str, Any]:
    cover_count = sum(1 for row in rows if row.cover_image_url)
    media_count = sum(1 for row in rows if row.file_path)
    total_size_bytes = sum(max(row.size_bytes, 0) for row in rows)
    return {
        "songs": len(rows),
        "coverFilesRequested": cover_count,
        "mediaFilesRequested": media_count,
        "totalSizeBytes": total_size_bytes,
        "totalSizeGiB": round(total_size_bytes / (1024 ** 3), 3),
        "examples": [
            {
                "id": row.id,
                "title": row.title,
                "primaryArtistName": row.primary_artist_name,
                "hasCover": bool(row.cover_image_url),
                "filePath": row.file_path,
            }
            for row in rows[:10]
        ],
    }


def build_cover_paths(rows: list[DeleteSongRow], cover_root: str) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if not row.cover_image_url:
            continue
        path = cover_remote_path(cover_root, row.id)
        if path and path not in seen:
            seen.add(path)
            paths.append(path)
    return paths


def cover_remote_path(cover_root: str, song_id: str) -> str:
    safe_song_id = safe_file_song_id(song_id)
    return str(Path(cover_root) / f"{safe_song_id}.jpg")


def safe_file_song_id(song_id: str) -> str:
    value = clean_text(song_id)
    if not SAFE_SONG_ID.match(value):
        raise ValueError(f"Unsafe song id for cover path: {song_id}")
    return value


def build_media_paths(rows: list[DeleteSongRow], source_prefix: str, target_prefix: str) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for row in rows:
        translated = translate_media_path(row.file_path, source_prefix, target_prefix)
        if translated and translated not in seen:
            seen.add(translated)
            paths.append(translated)
    return paths


def translate_media_path(file_path: str, source_prefix: str, target_prefix: str) -> str:
    path = clean_text(file_path)
    source = clean_text(source_prefix).rstrip("/")
    target = clean_text(target_prefix).rstrip("/")
    if not path:
        return ""
    if source and path == source:
        return target
    if source and path.startswith(f"{source}/"):
        suffix = path[len(source) :]
        return f"{target}{suffix}"
    return path


def delete_database_rows(rows: list[DeleteSongRow], args: argparse.Namespace) -> dict[str, Any]:
    song_ids = dedupe_preserve_order(row.id for row in rows)
    if not song_ids:
        return {
            "songsRequested": 0,
            "songsExistingBefore": 0,
            "songsDeleted": 0,
            "queueEntriesExistingBefore": 0,
            "queueEntriesDeleted": 0,
        }
    sql = build_delete_sql(song_ids)
    command = [
        "ssh",
        args.db_ssh_host,
        "docker",
        "exec",
        "-i",
        args.db_container,
        "psql",
        "-U",
        args.db_user,
        "-d",
        args.db_name,
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "-",
    ]
    output = run_command(command, input_text=sql)
    return extract_last_json(output, "database delete result")


def build_delete_sql(song_ids: list[str]) -> str:
    copy_lines = "\n".join(song_ids)
    return f"""
BEGIN;
CREATE TEMP TABLE delete_song_ids (
  id text PRIMARY KEY
) ON COMMIT DROP;
COPY delete_song_ids (id) FROM STDIN;
{copy_lines}
\\.
WITH existing_queue AS (
  SELECT id
  FROM queue_entries
  WHERE nas_song_id IN (SELECT id FROM delete_song_ids)
),
existing_songs AS (
  SELECT id
  FROM ktv_songs
  WHERE id IN (SELECT id FROM delete_song_ids)
),
deleted_queue AS (
  DELETE FROM queue_entries AS queue
  USING delete_song_ids AS doomed
  WHERE queue.nas_song_id = doomed.id
  RETURNING queue.id
),
deleted_songs AS (
  DELETE FROM ktv_songs AS song
  USING delete_song_ids AS doomed
  WHERE song.id = doomed.id
  RETURNING song.id
)
SELECT json_build_object(
  'songsRequested', (SELECT count(*) FROM delete_song_ids),
  'songsExistingBefore', (SELECT count(*) FROM existing_songs),
  'songsDeleted', (SELECT count(*) FROM deleted_songs),
  'queueEntriesExistingBefore', (SELECT count(*) FROM existing_queue),
  'queueEntriesDeleted', (SELECT count(*) FROM deleted_queue)
)::text;
COMMIT;
""".lstrip()


def delete_remote_paths(host: str, paths: list[str]) -> dict[str, Any]:
    normalized = dedupe_preserve_order(clean_text(path) for path in paths if clean_text(path))
    if not normalized:
        return {"requested": 0, "deleted": 0, "missing": 0, "failed": 0, "failedSamples": []}
    remote_command = f"python3 -c {shlex.quote(REMOTE_DELETE_FILES_SCRIPT)}"
    command = ["ssh", host, remote_command]
    output = run_command(command, input_text=json.dumps(normalized, ensure_ascii=False))
    return extract_last_json(output, f"remote delete result for {host}")


def run_command(command: list[str], input_text: str = "") -> str:
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail or f"Command failed with code {result.returncode}: {' '.join(command)}")
    return result.stdout


def extract_last_json(output: str, context: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        text = clean_text(line)
        if not text or not text.startswith("{") or not text.endswith("}"):
            continue
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"Did not find JSON output for {context}")


def dedupe_preserve_order(values: Any) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        ordered.append(text)
    return ordered


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def clean_text(value: str) -> str:
    return str(value or "").strip()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


if __name__ == "__main__":
    raise SystemExit(main())
