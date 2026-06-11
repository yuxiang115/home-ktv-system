#!/usr/bin/env python3
"""Check HomeKTV repository hygiene before commits."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
HIGH_RISK_PREFIXES = ("apps/", "clients/", "packages/", "deploy/", "scripts/", "docs/")
HIGH_RISK_FILES = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"}
RUNTIME_PATHS = ("runtime", "logs", "home-ktv-media", "songs-sample", ".codex", ".planning/reports", ".worktrees", "worktrees")


@dataclass(frozen=True)
class StatusEntry:
    code: str
    kind: str
    path: str


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_hygiene_report(args.root)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_report(report)

    summary = report["summary"]
    if args.fail_on_dirty and (summary["trackedDirty"] > 0 or summary["highRiskUntracked"] > 0):
        return 1
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print JSON report.")
    parser.add_argument("--fail-on-dirty", action="store_true", help="Exit 1 when tracked or high-risk untracked files exist.")
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="Git repository root.")
    raw_args = sys.argv[1:] if argv is None else argv
    forwarded_args = [arg for arg in raw_args if arg != "--"]
    return parser.parse_args(forwarded_args)


def build_hygiene_report(root_dir: Path | str = REPO_ROOT) -> dict:
    root = Path(root_dir).resolve()
    status = run_git(root, "status", "--porcelain=v1", "-uall")
    branch = run_git(root, "status", "--short", "--branch")
    entries = parse_porcelain_status(status.stdout)
    tracked_dirty = [entry for entry in entries if entry.kind != "untracked"]
    untracked = [entry for entry in entries if entry.kind == "untracked"]
    high_risk_untracked = [entry for entry in untracked if is_high_risk_path(entry.path)]
    runtime_paths = [name for name in RUNTIME_PATHS if (root / name).exists()]

    return {
        "branch": parse_branch_summary(branch.stdout),
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rootDir": str(root),
        "summary": {
            "highRiskUntracked": len(high_risk_untracked),
            "runtimePaths": len(runtime_paths),
            "trackedDirty": len(tracked_dirty),
            "untracked": len(untracked),
        },
        "trackedDirty": [asdict(entry) for entry in tracked_dirty],
        "untrackedHighRisk": [asdict(entry) for entry in high_risk_untracked],
        "runtimePaths": runtime_paths,
    }


def parse_porcelain_status(stdout: str) -> list[StatusEntry]:
    entries: list[StatusEntry] = []
    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        code = line[:2]
        raw_path = line[3:]
        entries.append(StatusEntry(code=code, kind="untracked" if code == "??" else "tracked", path=normalize_status_path(raw_path)))
    return entries


def is_high_risk_path(file_path: str) -> bool:
    return file_path in HIGH_RISK_FILES or file_path.startswith(HIGH_RISK_PREFIXES)


def parse_branch_summary(stdout: str) -> str:
    for line in stdout.splitlines():
        if line:
            return line.removeprefix("## ").strip()
    return ""


def normalize_status_path(file_path: str) -> str:
    return file_path.split(" -> ")[-1] if " -> " in file_path else file_path


def print_report(report: dict) -> None:
    print("HomeKTV repo hygiene")
    print(f"Root: {report['rootDir']}")
    print(f"Branch: {report['branch'] or '(unknown)'}")
    summary = report["summary"]
    print(
        "Summary: tracked dirty "
        f"{summary['trackedDirty']}, untracked {summary['untracked']}, high-risk untracked {summary['highRiskUntracked']}"
    )
    print()

    if report["trackedDirty"]:
        print("Tracked dirty files:")
        for entry in report["trackedDirty"]:
            print(f"  {entry['code']} {entry['path']}")
        print()

    if report["untrackedHighRisk"]:
        print("High-risk untracked files:")
        for entry in report["untrackedHighRisk"]:
            print(f"  {entry['path']}")
        print()

    if report["runtimePaths"]:
        print("Ignored/runtime paths present:")
        for file_path in report["runtimePaths"]:
            print(f"  {file_path}/")
        print()

    if summary["trackedDirty"] == 0 and summary["highRiskUntracked"] == 0:
        print("No tracked dirty files or high-risk untracked files detected.")


def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["git", *args], cwd=root, check=False, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git status failed")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
