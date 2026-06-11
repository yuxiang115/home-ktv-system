#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "runtime" / "hot-song-candidates"
DEFAULT_MANIFEST_PATH = ROOT_DIR / "packages" / "hot-songs" / "config" / "sources.example.json"
DEFAULT_CONCURRENCY = 10
DEFAULT_TIMEOUT_MS = 10000


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "collect":
        return run_collect(args)
    raise SystemExit(f"Unsupported command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect hot-song candidate sources in parallel via the existing hot-songs pipeline."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect = subparsers.add_parser("collect")
    collect.add_argument("--manifest", default=str(DEFAULT_MANIFEST_PATH))
    collect.add_argument("--output", default="")
    collect.add_argument("--concurrency", type=positive_int, default=DEFAULT_CONCURRENCY)
    collect.add_argument("--timeout-ms", type=positive_int, default=DEFAULT_TIMEOUT_MS)
    collect.add_argument("--source", action="append", default=[])
    collect.add_argument("--fixture", action="store_true")
    collect.add_argument("--aliases", default="")
    return parser.parse_args([arg for arg in argv if arg != "--"])


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return parsed


def run_collect(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    manifest = read_json(manifest_path)
    selected_sources = select_sources(manifest, flatten_cli_values(args.source))
    if not selected_sources:
        raise SystemExit("No enabled hot-song sources selected")

    output_dir = resolve_output_dir(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    partial_dir = output_dir / "partials"
    partial_dir.mkdir(parents=True, exist_ok=True)

    partial_results = collect_sources_in_parallel(
        sources=selected_sources,
        manifest_path=manifest_path,
        partial_dir=partial_dir,
        concurrency=args.concurrency,
        timeout_ms=args.timeout_ms,
        fixture=args.fixture,
    )
    rows_payload, report_payload = merge_partial_outputs(partial_results)

    source_rows_path = output_dir / "source-rows.json"
    source_report_path = output_dir / "source-report.json"
    write_json(source_rows_path, rows_payload)
    write_json(source_report_path, report_payload)

    normalize_dir = output_dir / "normalized"
    run_node_command(
        [
            "pnpm",
            "hot-songs:normalize",
            "--",
            "--source-rows",
            str(source_rows_path),
            "--source-report",
            str(source_report_path),
            "--out",
            str(normalize_dir),
        ]
    )

    fuse_dir = output_dir / "fused"
    fuse_command = [
        "pnpm",
        "hot-songs:fuse",
        "--",
        "--manifest",
        str(manifest_path),
        "--candidate-snapshot",
        str(normalize_dir / "candidate-snapshot.json"),
        "--out",
        str(fuse_dir),
    ]
    if args.aliases:
        fuse_command.extend(["--aliases", str(Path(args.aliases).resolve())])
    run_node_command(fuse_command)

    copy_fused_artifacts(fuse_dir, output_dir)
    print(
        json.dumps(
            {
                "output": str(output_dir),
                "sources": len(selected_sources),
                "rows": len(rows_payload["rows"]),
                "usableSourceCount": report_payload.get("usableSourceCount", 0),
                "rankedSongsCsv": str(output_dir / "ranked-songs.csv"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def flatten_cli_values(values: list[str]) -> list[str]:
    flattened: list[str] = []
    for value in values or []:
        for item in (value or "").split(","):
            cleaned = item.strip()
            if cleaned and cleaned not in flattened:
                flattened.append(cleaned)
    return flattened


def select_sources(manifest: dict[str, Any], source_ids: list[str]) -> list[dict[str, Any]]:
    requested = set(source_ids)
    selected: list[dict[str, Any]] = []
    for source in manifest.get("sources") or []:
        if not isinstance(source, dict):
            continue
        if source.get("enabled") is False:
            continue
        source_id = str(source.get("id") or "").strip()
        if not source_id:
            continue
        if requested and source_id not in requested:
            continue
        selected.append(source)
    return selected


def collect_sources_in_parallel(
    sources: list[dict[str, Any]],
    manifest_path: Path,
    partial_dir: Path,
    concurrency: int,
    timeout_ms: int,
    fixture: bool,
) -> list[dict[str, Any]]:
    results_by_order: dict[int, dict[str, Any]] = {}
    max_workers = max(1, min(concurrency, len(sources)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(
                collect_one_source,
                source=source,
                manifest_path=manifest_path,
                partial_dir=partial_dir,
                timeout_ms=timeout_ms,
                fixture=fixture,
            ): index
            for index, source in enumerate(sources)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            results_by_order[index] = future.result()
    return [results_by_order[index] for index in range(len(sources))]


def collect_one_source(
    source: dict[str, Any],
    manifest_path: Path,
    partial_dir: Path,
    timeout_ms: int,
    fixture: bool,
) -> dict[str, Any]:
    source_id = str(source.get("id") or "").strip()
    source_out = partial_dir / source_id
    source_out.mkdir(parents=True, exist_ok=True)
    command = [
        "pnpm",
        "hot-songs:sources",
        "--",
        "--manifest",
        str(manifest_path),
        "--out",
        str(source_out),
        "--timeout-ms",
        str(timeout_ms),
        "--source",
        source_id,
    ]
    if fixture:
        command.append("--fixture")
    completed = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    source_rows = read_json(source_out / "source-rows.json")
    source_report = read_json(source_out / "source-report.json")
    return {
        "sourceId": source_id,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "rows": source_rows.get("rows", []),
        "statuses": source_report.get("sources", []),
        "generatedAt": source_report.get("generatedAt") or source_rows.get("generatedAt"),
    }


def merge_partial_outputs(partials: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    generated_at = now_iso()
    rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []
    for partial in partials:
        for row in partial.get("rows", []):
            if isinstance(row, dict):
                rows.append(row)
        for status in partial.get("statuses", []):
            if isinstance(status, dict):
                statuses.append(status)
    usable_source_count = sum(1 for status in statuses if status.get("usable") is True)
    status_counts: dict[str, int] = {}
    for status in statuses:
        name = str(status.get("status") or "unknown")
        status_counts[name] = status_counts.get(name, 0) + 1
    return (
        {
            "schemaVersion": "hot-songs.source-rows.v1",
            "generatedAt": generated_at,
            "rows": rows,
        },
        {
            "schemaVersion": "hot-songs.source-report.v1",
            "generatedAt": generated_at,
            "totalRows": len(rows),
            "usableSourceCount": usable_source_count,
            "statusCounts": status_counts,
            "sources": statuses,
        },
    )


def copy_fused_artifacts(fuse_dir: Path, output_dir: Path) -> None:
    for filename in ("ranked-songs.csv", "ranked-songs.audit.json", "near-duplicates.csv"):
        source_path = fuse_dir / filename
        if source_path.exists():
            shutil.copy2(source_path, output_dir / filename)


def run_node_command(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        raise RuntimeError(message)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_output_dir(output: str) -> Path:
    if output:
        return Path(output).resolve()
    timestamp = datetime.now().strftime("run-%Y%m%d-%H%M%S")
    return (DEFAULT_OUTPUT_ROOT / timestamp).resolve()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
