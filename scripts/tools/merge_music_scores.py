#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "runtime" / "merged-music-scores"


class MergedSong:
    def __init__(
        self,
        title: str,
        artist_name: str,
        normalized_key: str,
        hot_score: float,
        chart_score: float,
        playlist_score: float,
    ) -> None:
        self.title = title
        self.artist_name = artist_name
        self.normalized_key = normalized_key
        self.hot_score = hot_score
        self.chart_score = chart_score
        self.playlist_score = playlist_score
        self.score = hot_score + chart_score + playlist_score


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "merge":
        return run_merge(args)
    raise SystemExit(f"Unsupported command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge hot-song, chart-score, and playlist-score outputs into one deduplicated song table."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    merge = subparsers.add_parser("merge")
    merge.add_argument("--hot-input", default="")
    merge.add_argument("--chart-input", default="")
    merge.add_argument("--playlist-input", default="")
    merge.add_argument("--output", default="")
    return parser.parse_args([arg for arg in argv if arg != "--"])


def run_merge(args: argparse.Namespace) -> int:
    inputs = {
        "hot": args.hot_input,
        "chart": args.chart_input,
        "playlist": args.playlist_input,
    }
    if not any(value for value in inputs.values()):
        raise SystemExit("At least one of --hot-input, --chart-input, --playlist-input is required")

    hot_rows, hot_path = load_input_rows(args.hot_input, "hot")
    chart_rows, chart_path = load_input_rows(args.chart_input, "chart")
    playlist_rows, playlist_path = load_input_rows(args.playlist_input, "playlist")

    merged_songs = merge_score_rows(
        hot_rows=hot_rows,
        chart_rows=chart_rows,
        playlist_rows=playlist_rows,
    )

    output_dir = resolve_output_dir(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    write_merged_csv(output_dir / "merged-songs.csv", merged_songs)
    write_json(
        output_dir / "merge-report.json",
        {
            "generatedAt": now_iso(),
            "inputs": {
                "hot": {"path": str(hot_path) if hot_path else "", "rows": len(hot_rows)},
                "chart": {"path": str(chart_path) if chart_path else "", "rows": len(chart_rows)},
                "playlist": {"path": str(playlist_path) if playlist_path else "", "rows": len(playlist_rows)},
            },
            "mergedSongs": len(merged_songs),
        },
    )

    print(
        json.dumps(
            {
                "output": str(output_dir),
                "songs": len(merged_songs),
                "mergedCsv": str(output_dir / "merged-songs.csv"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def load_input_rows(value: str, source_kind: str) -> tuple[list[dict[str, Any]], Path | None]:
    if not value:
        return [], None
    csv_path = resolve_input_csv_path(value, source_kind)
    return read_score_csv(csv_path), csv_path


def resolve_input_csv_path(value: str, source_kind: str) -> Path:
    path = Path(value).resolve()
    if path.is_file():
        return path
    if not path.is_dir():
        raise FileNotFoundError(f"Input path not found: {path}")
    if source_kind == "hot":
        return path / "ranked-songs.csv"
    if source_kind in ("chart", "playlist"):
        return path / "aggregated-songs.csv"
    raise ValueError(f"Unsupported source kind: {source_kind}")


def read_score_csv(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"CSV not found: {path}")
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return []
        title_key = "title" if "title" in reader.fieldnames else ""
        artist_key = "artist_name" if "artist_name" in reader.fieldnames else ("artist" if "artist" in reader.fieldnames else "")
        score_key = "score" if "score" in reader.fieldnames else ""
        if not title_key or not artist_key or not score_key:
            raise ValueError(f"Unsupported CSV header in {path}")
        rows: list[dict[str, Any]] = []
        for row in reader:
            title = clean_display_text(row.get(title_key) or "")
            artist_name = clean_display_text(row.get(artist_key) or "")
            score = parse_score(row.get(score_key) or "0")
            if title:
                rows.append({"title": title, "artist_name": artist_name, "score": score})
        return rows


def parse_score(value: str) -> float:
    text = clean_display_text(value)
    if not text:
        return 0.0
    return float(text)


def merge_score_rows(
    hot_rows: list[dict[str, Any]],
    chart_rows: list[dict[str, Any]],
    playlist_rows: list[dict[str, Any]],
) -> list[MergedSong]:
    grouped: dict[str, dict[str, Any]] = {}
    merge_component_rows(grouped, hot_rows, "hot_score")
    merge_component_rows(grouped, chart_rows, "chart_score")
    merge_component_rows(grouped, playlist_rows, "playlist_score")

    songs: list[MergedSong] = []
    for normalized_key, group in grouped.items():
        songs.append(
            MergedSong(
                title=group["title"],
                artist_name=group["artist_name"],
                normalized_key=normalized_key,
                hot_score=float(group["hot_score"]),
                chart_score=float(group["chart_score"]),
                playlist_score=float(group["playlist_score"]),
            )
        )
    songs.sort(
        key=lambda item: (
            -item.score,
            -item.hot_score,
            -item.chart_score,
            -item.playlist_score,
            item.title or "",
            item.artist_name or "",
        )
    )
    return songs


def merge_component_rows(
    grouped: dict[str, dict[str, Any]],
    rows: list[dict[str, Any]],
    component_key: str,
) -> None:
    for row in rows:
        title = clean_display_text(stringify(row.get("title")))
        artist_name = clean_display_text(stringify(row.get("artist_name")))
        identity = build_song_identity(title, artist_name)
        if not identity:
            continue
        score = float(row.get("score") or 0)
        group = grouped.get(identity)
        if group is None:
            group = {
                "title": title,
                "artist_name": artist_name,
                "hot_score": 0.0,
                "chart_score": 0.0,
                "playlist_score": 0.0,
            }
            grouped[identity] = group
        if not group["title"] and title:
            group["title"] = title
        if not group["artist_name"] and artist_name:
            group["artist_name"] = artist_name
        group[component_key] += score


def write_merged_csv(path: Path, rows: list[MergedSong]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["title", "artist_name", "score", "hot_score", "chart_score", "playlist_score", "normalized_key"]
        )
        for row in rows:
            writer.writerow(
                [
                    row.title,
                    row.artist_name,
                    format_score(row.score),
                    format_score(row.hot_score),
                    format_score(row.chart_score),
                    format_score(row.playlist_score),
                    row.normalized_key,
                ]
            )


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_output_dir(output: str) -> Path:
    if output:
        return Path(output).resolve()
    timestamp = datetime.now().strftime("run-%Y%m%d-%H%M%S")
    return (DEFAULT_OUTPUT_ROOT / timestamp).resolve()


def build_song_identity(title: str, artist_name: str) -> str:
    normalized_title = normalize_title(title)
    normalized_artists = normalize_artist_name(artist_name)
    if not normalized_title:
        return ""
    return f"{normalized_title}|{normalized_artists}"


def normalize_title(value: str) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    text = text.replace("（", "(").replace("）", ")")
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"【[^】]*】", " ", text)
    text = re.sub(r"\([^)]*\)", lambda match: " " if is_noise_version_text(match.group(0)) else match.group(0), text)
    text = re.sub(r"(?:^|\s)(live版?|dj版?|remix版?|伴奏版?|纯音乐版?|现场版)(?:$|\s)", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"(?:^|\s)(live|dj|remix|伴奏|纯音乐|现场)(?:$|\s)", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", "", text)
    return text.lower()


def normalize_artist_name(value: str) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    text = re.sub(r"\b(feat|ft)\.?\b", "/", text, flags=re.IGNORECASE)
    raw_parts = re.split(r"[、/&,，;；|+]+|\s+x\s+|\s+and\s+", text, flags=re.IGNORECASE)
    parts = []
    for raw_part in raw_parts:
        part = re.sub(r"\s+", "", raw_part).lower()
        if part and part not in parts:
            parts.append(part)
    parts.sort()
    return "/".join(parts)


def normalize_text(value: str) -> str:
    text = html.unescape(value or "")
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\u3000", " ")
    return text.strip()


def is_noise_version_text(value: str) -> bool:
    text = normalize_text(value)
    if not text:
        return True
    inner = text.strip("()[]{}（）【】 ")
    if not inner:
        return True
    compact = re.sub(r"\s+", "", inner).lower()
    noise_terms = (
        "live",
        "live版",
        "dj",
        "dj版",
        "remix",
        "伴奏",
        "现场",
        "纯音乐",
        "instrumental",
        "demo",
        "版",
    )
    return any(term in compact for term in noise_terms)


def clean_display_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", normalize_text(value or "")).strip()


def stringify(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def format_score(score: float) -> str:
    if abs(score - round(score)) < 1e-9:
        return str(int(round(score)))
    return f"{score:.3f}".rstrip("0").rstrip(".")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


if __name__ == "__main__":
    raise SystemExit(main())
