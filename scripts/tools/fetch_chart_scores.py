#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "runtime" / "chart-scores"
DEFAULT_NETEASE_BASE_URL = "http://127.0.0.1:4300"
DEFAULT_PLATFORMS = ["netease", "qq", "kugou", "kuwo", "migu"]
DEFAULT_TIMEOUT_MS = 8000
DEFAULT_DELAY_MS = 300
DEFAULT_CONCURRENCY = 10
DEFAULT_PER_SOURCE_POINTS = 10
DEFAULT_MAX_KUGOU_PAGES = 50
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class ChartSource:
    def __init__(
        self,
        platform: str,
        chart_id: str,
        chart_name: str,
        group_name: str = "",
        chart_url: str = "",
    ) -> None:
        self.platform = platform
        self.chart_id = chart_id
        self.chart_name = chart_name
        self.group_name = group_name
        self.chart_url = chart_url


class ChartRow:
    def __init__(
        self,
        platform: str,
        chart_id: str,
        chart_name: str,
        title: str,
        artist_name: str = "",
        rank: int | None = None,
    ) -> None:
        self.platform = platform
        self.chart_id = chart_id
        self.chart_name = chart_name
        self.title = title
        self.artist_name = artist_name
        self.rank = rank


class AggregatedSong:
    def __init__(
        self,
        title: str,
        artist_name: str,
        normalized_key: str,
        score: int,
        appearances: int,
        platforms: list[str],
        charts: list[str],
    ) -> None:
        self.title = title
        self.artist_name = artist_name
        self.normalized_key = normalized_key
        self.score = score
        self.appearances = appearances
        self.platforms = platforms
        self.charts = charts


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "collect":
        return run_collect(args)
    raise SystemExit(f"Unsupported command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect Chinese music platform chart songs and score chart appearances."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect = subparsers.add_parser("collect")
    collect.add_argument("--platforms", default=",".join(DEFAULT_PLATFORMS))
    collect.add_argument("--per-source-points", type=positive_int, default=DEFAULT_PER_SOURCE_POINTS)
    collect.add_argument("--output", default="")
    collect.add_argument("--request-timeout-ms", type=positive_int, default=DEFAULT_TIMEOUT_MS)
    collect.add_argument("--delay-ms", type=non_negative_int, default=DEFAULT_DELAY_MS)
    collect.add_argument("--concurrency", type=positive_int, default=DEFAULT_CONCURRENCY)
    collect.add_argument("--max-kugou-pages", type=positive_int, default=DEFAULT_MAX_KUGOU_PAGES)
    collect.add_argument(
        "--netease-base-url",
        default=os.environ.get("NETEASE_CLOUD_MUSIC_API_BASE_URL", DEFAULT_NETEASE_BASE_URL),
    )
    return parser.parse_args([arg for arg in argv if arg != "--"])


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return parsed


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return parsed


def run_collect(args: argparse.Namespace) -> int:
    requested_platforms = parse_platforms(args.platforms)
    output_dir = resolve_output_dir(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    all_rows: list[ChartRow] = []
    source_entries: list[dict[str, Any]] = []
    run_started_at = now_iso()

    for platform in requested_platforms:
        source_entries.extend(
            collect_platform(
                platform=platform,
                all_rows=all_rows,
                timeout_ms=args.request_timeout_ms,
                delay_ms=args.delay_ms,
                concurrency=args.concurrency,
                max_kugou_pages=args.max_kugou_pages,
                netease_base_url=args.netease_base_url,
            )
        )

    aggregated = aggregate_chart_rows(all_rows, args.per_source_points)
    write_run_outputs(
        output_dir=output_dir,
        requested_platforms=requested_platforms,
        started_at=run_started_at,
        per_source_points=args.per_source_points,
        source_entries=source_entries,
        rows=all_rows,
        aggregated=aggregated,
    )

    print(
        json.dumps(
            {
                "output": str(output_dir),
                "platforms": requested_platforms,
                "sources": len(source_entries),
                "rows": len(all_rows),
                "songs": len(aggregated),
            },
            ensure_ascii=False,
        )
    )
    return 0


def collect_platform(
    platform: str,
    all_rows: list[ChartRow],
    timeout_ms: int,
    delay_ms: int,
    concurrency: int,
    max_kugou_pages: int,
    netease_base_url: str,
) -> list[dict[str, Any]]:
    handlers = {
        "netease": lambda: collect_netease(timeout_ms, netease_base_url, concurrency),
        "qq": lambda: collect_qq(timeout_ms, concurrency),
        "kugou": lambda: collect_kugou(timeout_ms, max_kugou_pages, delay_ms, concurrency),
        "kuwo": lambda: collect_kuwo(timeout_ms, concurrency),
        "migu": lambda: collect_migu(timeout_ms, concurrency),
    }
    if platform not in handlers:
        raise SystemExit(f"Unsupported platform: {platform}")

    source_entries: list[dict[str, Any]] = []
    for source in handlers[platform]():
        source_entries.append(source["report"])
        all_rows.extend(source["rows"])
        if delay_ms:
            time.sleep(delay_ms / 1000)
    return source_entries


def collect_netease(timeout_ms: int, base_url: str, concurrency: int) -> list[dict[str, Any]]:
    try:
        sources = fetch_netease_sources(timeout_ms, base_url)
    except Exception as error:  # pragma: no cover - exercised by smoke
        return [{"rows": [], "report": build_platform_report("netease", "error", str(error))}]
    if not sources:
        return [{"rows": [], "report": build_platform_report("netease", "empty", "No chart sources found")}]
    return collect_chart_sources_in_parallel(
        sources,
        concurrency,
        lambda source: fetch_netease_source(source, timeout_ms, base_url),
    )


def collect_qq(timeout_ms: int, concurrency: int) -> list[dict[str, Any]]:
    try:
        index_html = http_get_text(
            "https://y.qq.com/n/ryqq_v2/toplist/4",
            timeout_ms=timeout_ms,
            headers={"Referer": "https://y.qq.com/"},
        )
        sources = parse_qq_chart_sources_from_html(index_html)
    except Exception as error:  # pragma: no cover - exercised by smoke
        return [{"rows": [], "report": build_platform_report("qq", "error", str(error))}]
    if not sources:
        return [{"rows": [], "report": build_platform_report("qq", "empty", "No chart sources found")}]
    return collect_chart_sources_in_parallel(
        sources,
        concurrency,
        lambda source: fetch_qq_source(source, timeout_ms),
    )


def collect_kugou(timeout_ms: int, max_kugou_pages: int, delay_ms: int, concurrency: int) -> list[dict[str, Any]]:
    try:
        index_html = http_get_text("https://www.kugou.com/yy/html/rank.html", timeout_ms=timeout_ms)
        sources = parse_kugou_chart_sources_from_html(index_html)
    except Exception as error:  # pragma: no cover - exercised by smoke
        return [{"rows": [], "report": build_platform_report("kugou", "error", str(error))}]
    if not sources:
        return [{"rows": [], "report": build_platform_report("kugou", "empty", "No chart sources found")}]
    return collect_chart_sources_in_parallel(
        sources,
        concurrency,
        lambda source: fetch_kugou_source(source, timeout_ms, max_kugou_pages, delay_ms),
    )


def collect_kuwo(timeout_ms: int, concurrency: int) -> list[dict[str, Any]]:
    try:
        index_html = http_get_text(
            "https://www.kuwo.cn/newh5/bang/index",
            timeout_ms=timeout_ms,
            headers={"Referer": "https://www.kuwo.cn/"},
        )
        sources = parse_kuwo_chart_sources_from_html(index_html)
    except Exception as error:  # pragma: no cover - exercised by smoke
        return [{"rows": [], "report": build_platform_report("kuwo", "error", str(error))}]
    if not sources:
        return [{"rows": [], "report": build_platform_report("kuwo", "empty", "No chart sources found")}]
    return collect_chart_sources_in_parallel(
        sources,
        concurrency,
        lambda source: fetch_kuwo_source(source, timeout_ms),
    )


def collect_migu(timeout_ms: int, concurrency: int) -> list[dict[str, Any]]:
    headers = build_migu_headers()
    try:
        payload = http_get_json(
            "https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0",
            timeout_ms=timeout_ms,
            headers=headers,
        )
        sources = parse_migu_chart_sources(payload)
    except Exception as error:  # pragma: no cover - exercised by smoke
        return [{"rows": [], "report": build_platform_report("migu", "error", str(error))}]
    if not sources:
        return [{"rows": [], "report": build_platform_report("migu", "empty", "No chart sources found")}]
    return collect_chart_sources_in_parallel(
        sources,
        concurrency,
        lambda source: fetch_migu_source(source, timeout_ms, headers),
    )


def collect_chart_sources_in_parallel(
    sources: list[ChartSource],
    concurrency: int,
    fetcher: Any,
) -> list[dict[str, Any]]:
    if not sources:
        return []
    results_by_order: dict[int, dict[str, Any]] = {}
    max_workers = max(1, min(concurrency, len(sources)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(fetcher, source): index
            for index, source in enumerate(sources)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            results_by_order[index] = future.result()
    return [results_by_order[index] for index in range(len(sources))]


def fetch_netease_source(source: ChartSource, timeout_ms: int, base_url: str) -> dict[str, Any]:
    try:
        rows = fetch_netease_chart_rows(source, timeout_ms, base_url)
        return {"rows": rows, "report": build_source_report(source, "ok", len(rows))}
    except Exception as error:  # pragma: no cover - exercised by smoke
        return {"rows": [], "report": build_source_report(source, "error", 0, str(error))}


def fetch_qq_source(source: ChartSource, timeout_ms: int) -> dict[str, Any]:
    try:
        payload = http_get_json(
            build_qq_chart_api_url(source.chart_id),
            timeout_ms=timeout_ms,
            headers={"Referer": "https://y.qq.com/"},
            allow_jsonp=True,
        )
        rows = parse_qq_chart_rows(source.chart_id, source.chart_name, payload)
        return {"rows": rows, "report": build_source_report(source, "ok", len(rows))}
    except Exception as error:  # pragma: no cover - exercised by smoke
        return {"rows": [], "report": build_source_report(source, "error", 0, str(error))}


def fetch_kugou_source(source: ChartSource, timeout_ms: int, max_kugou_pages: int, delay_ms: int) -> dict[str, Any]:
    collected_rows: list[ChartRow] = []
    error_message = ""
    try:
        for page in range(1, max_kugou_pages + 1):
            page_url = build_kugou_chart_page_url(source.chart_id, page)
            page_html = http_get_text(page_url, timeout_ms=timeout_ms)
            page_rows = parse_kugou_chart_rows(source.chart_id, source.chart_name, page_html)
            if not page_rows:
                break
            collected_rows.extend(page_rows)
            if delay_ms:
                time.sleep(delay_ms / 1000)
    except ValueError:
        pass
    except Exception as error:  # pragma: no cover - exercised by smoke
        error_message = str(error)
    if collected_rows:
        return {
            "rows": normalize_chart_ranks(collected_rows),
            "report": build_source_report(source, "ok", len(collected_rows), error_message),
        }
    status = "error" if error_message else "empty"
    return {"rows": [], "report": build_source_report(source, status, 0, error_message)}


def fetch_kuwo_source(source: ChartSource, timeout_ms: int) -> dict[str, Any]:
    try:
        page_html = http_get_text(
            f"https://www.kuwo.cn/newh5/bang/content?bid={urllib.parse.quote(source.chart_id)}",
            timeout_ms=timeout_ms,
            headers={"Referer": "https://www.kuwo.cn/newh5/bang/index"},
        )
        rows = parse_kuwo_chart_rows(source.chart_id, source.chart_name, page_html)
        return {"rows": rows, "report": build_source_report(source, "ok", len(rows))}
    except Exception as error:  # pragma: no cover - exercised by smoke
        return {"rows": [], "report": build_source_report(source, "error", 0, str(error))}


def fetch_migu_source(source: ChartSource, timeout_ms: int, headers: dict[str, str]) -> dict[str, Any]:
    try:
        page_payload = http_get_json(
            (
                "https://app.c.nf.migu.cn/pc/bmw/rank/rank-info/v1.0?"
                f"rankId={urllib.parse.quote(source.chart_id)}&rankType=&period="
            ),
            timeout_ms=timeout_ms,
            headers=headers,
        )
        rows = parse_migu_chart_rows(source.chart_id, source.chart_name, page_payload)
        return {"rows": rows, "report": build_source_report(source, "ok", len(rows))}
    except Exception as error:  # pragma: no cover - exercised by smoke
        return {"rows": [], "report": build_source_report(source, "error", 0, str(error))}


def fetch_netease_sources(timeout_ms: int, base_url: str) -> list[ChartSource]:
    payload = http_get_json(build_netease_url(base_url, "/toplist"), timeout_ms=timeout_ms)
    return parse_netease_chart_sources(payload)


def fetch_netease_chart_rows(source: ChartSource, timeout_ms: int, base_url: str) -> list[ChartRow]:
    primary_url = build_netease_url(base_url, f"/playlist/track/all?id={urllib.parse.quote(source.chart_id)}")
    fallback_url = build_netease_url(base_url, f"/playlist/detail?id={urllib.parse.quote(source.chart_id)}")
    last_error: Exception | None = None
    for url in (primary_url, fallback_url):
        try:
            payload = http_get_json(url, timeout_ms=timeout_ms)
            rows = parse_netease_chart_rows(source.chart_id, source.chart_name, payload)
            if rows:
                return rows
        except Exception as error:  # pragma: no cover - exercised by smoke
            last_error = error
    raise ValueError(str(last_error or "NetEase playlist rows not found"))


def parse_netease_chart_sources(data: Any) -> list[ChartSource]:
    items = data.get("list") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    sources: list[ChartSource] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        chart_id = stringify(item.get("id"))
        chart_name = clean_display_text(item.get("name"))
        if chart_id and chart_name:
            sources.append(ChartSource(platform="netease", chart_id=chart_id, chart_name=chart_name))
    return dedupe_sources(sources)


def parse_netease_chart_rows(chart_id: str, chart_name: str, data: Any) -> list[ChartRow]:
    songs: list[Any] = []
    if isinstance(data, dict):
        if isinstance(data.get("songs"), list):
            songs = data["songs"]
        elif isinstance(data.get("playlist"), dict) and isinstance(data["playlist"].get("tracks"), list):
            songs = data["playlist"]["tracks"]

    rows: list[ChartRow] = []
    for index, item in enumerate(songs, start=1):
        if not isinstance(item, dict):
            continue
        title = clean_display_text(stringify(item.get("name")))
        artist_name = ""
        artists = item.get("ar")
        if isinstance(artists, list):
            artist_name = join_display_artists([clean_display_text(stringify(artist.get("name"))) for artist in artists if isinstance(artist, dict)])
        if title:
            rows.append(
                ChartRow(
                    platform="netease",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    title=title,
                    artist_name=artist_name,
                    rank=index,
                )
            )
    return rows


def parse_qq_chart_sources_from_html(page_html: str) -> list[ChartSource]:
    payload = None
    try:
        payload = parse_embedded_json_object(page_html, "window.__INITIAL_DATA__")
    except json.JSONDecodeError:
        payload = None

    sources: list[ChartSource] = []
    if isinstance(payload, dict):
        top_nav_data = payload.get("topNavData")
        if isinstance(top_nav_data, list):
            for group in top_nav_data:
                if not isinstance(group, dict):
                    continue
                group_name = clean_display_text(stringify(group.get("groupName")))
                toplist = group.get("toplist")
                if not isinstance(toplist, list):
                    continue
                for item in toplist:
                    if not isinstance(item, dict):
                        continue
                    chart_id = stringify(item.get("topId"))
                    chart_name = clean_display_text(stringify(item.get("title")))
                    if chart_id and chart_name:
                        sources.append(
                            ChartSource(
                                platform="qq",
                                chart_id=chart_id,
                                chart_name=chart_name,
                                group_name=group_name,
                                chart_url=f"https://y.qq.com/n/ryqq/toplist/{chart_id}",
                            )
                        )
    if sources:
        return dedupe_sources(sources)
    return parse_qq_chart_sources_from_regex(page_html)


def parse_qq_chart_rows(chart_id: str, chart_name: str, data: Any) -> list[ChartRow]:
    song_list = data.get("songlist") if isinstance(data, dict) else None
    if not isinstance(song_list, list):
        return []
    rows: list[ChartRow] = []
    for index, item in enumerate(song_list, start=1):
        if not isinstance(item, dict):
            continue
        song = item.get("data") if isinstance(item.get("data"), dict) else item
        if not isinstance(song, dict):
            continue
        title = clean_display_text(stringify(song.get("songname") or song.get("songName") or song.get("title")))
        singer_list = song.get("singer")
        artists: list[str] = []
        if isinstance(singer_list, list):
            for singer in singer_list:
                if isinstance(singer, dict):
                    name = clean_display_text(stringify(singer.get("name")))
                    if name:
                        artists.append(name)
        if title:
            rows.append(
                ChartRow(
                    platform="qq",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    title=title,
                    artist_name=join_display_artists(artists),
                    rank=index,
                )
            )
    return rows


def parse_kugou_chart_sources_from_html(page_html: str) -> list[ChartSource]:
    pattern = re.compile(
        r'<a[^>]+href="https?://www\.kugou\.com/yy/rank/home/\d+-(\d+)\.html[^"]*"[^>]*?(?:title="([^"]*)")?[^>]*>(.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    sources: list[ChartSource] = []
    for match in pattern.finditer(page_html):
        chart_id = clean_display_text(match.group(1))
        title_attr = clean_display_text(html.unescape(strip_tags(match.group(2) or "")))
        inner_text = clean_display_text(html.unescape(strip_tags(match.group(3) or "")))
        chart_name = title_attr or inner_text
        if chart_id and chart_name:
            sources.append(
                ChartSource(
                    platform="kugou",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    chart_url=build_kugou_chart_page_url(chart_id, 1),
                )
            )
    return dedupe_sources(sources)


def parse_kugou_chart_rows(chart_id: str, chart_name: str, page_html: str) -> list[ChartRow]:
    block_pattern = re.compile(r"<li\b([^>]*)>(.*?)</li>", re.IGNORECASE | re.DOTALL)
    rank_pattern = re.compile(
        r'class="pc_temp_num"[^>]*>\s*(?:<strong>)?\s*(\d+)\s*(?:</strong>)?\s*</span>',
        re.IGNORECASE | re.DOTALL,
    )
    title_pattern = re.compile(r'class="pc_temp_songname"[^>]*title="([^"]+)"', re.IGNORECASE | re.DOTALL)
    li_title_pattern = re.compile(r'title="([^"]+)"', re.IGNORECASE | re.DOTALL)
    rows: list[ChartRow] = []
    for block_match in block_pattern.finditer(page_html):
        attrs = block_match.group(1) or ""
        block = block_match.group(2) or ""
        if "pc_temp_songname" not in block:
            continue
        rank_match = rank_pattern.search(block)
        if not rank_match:
            continue
        title_match = title_pattern.search(block)
        li_title_match = li_title_pattern.search(attrs)
        display = clean_display_text(html.unescape((title_match.group(1) if title_match else "") or (li_title_match.group(1) if li_title_match else "")))
        rank = int(rank_match.group(1))
        artist_name, title = split_artist_title(display)
        if title:
            rows.append(
                ChartRow(
                    platform="kugou",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    title=title,
                    artist_name=artist_name,
                    rank=rank,
                )
            )
    return rows


def parse_qq_chart_sources_from_regex(page_html: str) -> list[ChartSource]:
    group_pattern = re.compile(r'"groupName"\s*:\s*"([^"]+)"', re.IGNORECASE)
    source_pattern = re.compile(r'"topId"\s*:\s*(\d+).*?"title"\s*:\s*"([^"]+)"', re.IGNORECASE | re.DOTALL)

    group_positions = list(group_pattern.finditer(page_html))
    sources: list[ChartSource] = []

    for source_match in source_pattern.finditer(page_html):
        chart_id = clean_display_text(source_match.group(1))
        chart_name = clean_display_text(html.unescape(source_match.group(2)))
        group_name = ""
        for group_match in group_positions:
            if group_match.start() > source_match.start():
                break
            group_name = clean_display_text(html.unescape(group_match.group(1)))
        if chart_id and chart_name:
            sources.append(
                ChartSource(
                    platform="qq",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    group_name=group_name,
                    chart_url=f"https://y.qq.com/n/ryqq/toplist/{chart_id}",
                )
            )
    return dedupe_sources(sources)


def parse_kuwo_chart_sources_from_html(page_html: str) -> list[ChartSource]:
    pattern = re.compile(
        r'<li[^>]*class="chart_li[^"]*"[^>]*onclick="jumpPage\(\'/newh5/bang/content\?bid=(\d+)[^\']*\'\);?"[^>]*>.*?<h3>(.*?)</h3>',
        re.IGNORECASE | re.DOTALL,
    )
    sources: list[ChartSource] = []
    for match in pattern.finditer(page_html):
        chart_id = clean_display_text(match.group(1))
        chart_name = clean_display_text(html.unescape(strip_tags(match.group(2))))
        if chart_id and chart_name:
            sources.append(
                ChartSource(
                    platform="kuwo",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    chart_url=f"https://www.kuwo.cn/newh5/bang/content?bid={chart_id}",
                )
            )
    return dedupe_sources(sources)


def parse_kuwo_chart_rows(chart_id: str, chart_name: str, page_html: str) -> list[ChartRow]:
    block_pattern = re.compile(r'<li[^>]*class="singBox"[^>]*>(.*?)</li>', re.IGNORECASE | re.DOTALL)
    title_pattern = re.compile(r'<div[^>]*class="singTexUp2"[^>]*>\s*<p>(.*?)</p>', re.IGNORECASE | re.DOTALL)
    artist_pattern = re.compile(r'<p[^>]*class="singName"[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)
    rows: list[ChartRow] = []
    for index, block_match in enumerate(block_pattern.finditer(page_html), start=1):
        block = block_match.group(1)
        title_match = title_pattern.search(block)
        artist_match = artist_pattern.search(block)
        title = clean_display_text(html.unescape(strip_tags(title_match.group(1) if title_match else "")))
        artist_line = clean_display_text(html.unescape(strip_tags(artist_match.group(1) if artist_match else "")))
        artist_name = ""
        if artist_line and title:
            artist_name = parse_kuwo_artist_line(artist_line, title)
        elif artist_line:
            artist_name = artist_line
        if title:
            rows.append(
                ChartRow(
                    platform="kuwo",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    title=title,
                    artist_name=artist_name,
                    rank=index,
                )
            )
    return rows


def build_migu_headers() -> dict[str, str]:
    return {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": "https://music.migu.cn/v5/",
        "Origin": "https://music.migu.cn",
        "channel": "014000D",
        "subchannel": "014000D",
        "appId": "music",
        "platform": "H5",
        "deviceId": "home-ktv-chart-score",
        "ua": "Android_migu",
        "version": "6.8.8",
        "logId": str(int(time.time() * 1000)),
    }


def parse_migu_chart_sources(data: Any) -> list[ChartSource]:
    sources: list[ChartSource] = []
    for item in walk_dict_items(data):
        chart_id = stringify(item.get("rankId"))
        chart_name = clean_display_text(stringify(item.get("rankName")))
        if chart_id and chart_name:
            sources.append(ChartSource(platform="migu", chart_id=chart_id, chart_name=chart_name))
    return dedupe_sources(sources)


def parse_migu_chart_rows(chart_id: str, chart_name: str, data: Any) -> list[ChartRow]:
    rows: list[ChartRow] = []
    for item in walk_dict_items(data):
        title = clean_display_text(stringify(item.get("txt")))
        artist_name = clean_display_text(stringify(item.get("txt2")))
        if title:
            rows.append(
                ChartRow(
                    platform="migu",
                    chart_id=chart_id,
                    chart_name=chart_name,
                    title=title,
                    artist_name=artist_name,
                    rank=len(rows) + 1,
                )
            )
    return rows


def aggregate_chart_rows(rows: list[ChartRow], per_source_points: int) -> list[AggregatedSong]:
    chart_seen: set[tuple[str, str, str]] = set()
    grouped: dict[str, dict[str, Any]] = {}

    for row in rows:
        identity = build_song_identity(row.title, row.artist_name)
        if not identity:
            continue
        chart_key = (row.platform, row.chart_id, identity)
        if chart_key in chart_seen:
            continue
        chart_seen.add(chart_key)

        group = grouped.get(identity)
        if group is None:
            group = {
                "title": clean_display_text(row.title),
                "artist_name": clean_display_text(row.artist_name),
                "platforms": [],
                "charts": [],
                "appearances": 0,
            }
            grouped[identity] = group
        group["appearances"] += 1
        if row.platform not in group["platforms"]:
            group["platforms"].append(row.platform)
        chart_label = f"{row.platform}:{row.chart_id}:{row.chart_name}"
        group["charts"].append(chart_label)

    aggregated: list[AggregatedSong] = []
    for normalized_key, group in grouped.items():
        appearances = int(group["appearances"])
        aggregated.append(
            AggregatedSong(
                title=group["title"],
                artist_name=group["artist_name"],
                normalized_key=normalized_key,
                score=appearances * per_source_points,
                appearances=appearances,
                platforms=list(group["platforms"]),
                charts=list(group["charts"]),
            )
        )

    aggregated.sort(
        key=lambda item: (-item.score, -item.appearances, item.title or "", item.artist_name or "")
    )
    return aggregated


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
    text = text.strip()
    return text


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


def resolve_output_dir(output: str) -> Path:
    if output:
        return Path(output).resolve()
    timestamp = datetime.now().strftime("run-%Y%m%d-%H%M%S")
    return (DEFAULT_OUTPUT_ROOT / timestamp).resolve()


def write_run_outputs(
    output_dir: Path,
    requested_platforms: list[str],
    started_at: str,
    per_source_points: int,
    source_entries: list[dict[str, Any]],
    rows: list[ChartRow],
    aggregated: list[AggregatedSong],
) -> None:
    write_json(
        output_dir / "source-report.json",
        {
            "startedAt": started_at,
            "finishedAt": now_iso(),
            "platforms": requested_platforms,
            "perSourcePoints": per_source_points,
            "sources": source_entries,
        },
    )
    write_json(
        output_dir / "chart-rows.json",
        [
            {
                "platform": row.platform,
                "chartId": row.chart_id,
                "chartName": row.chart_name,
                "rank": row.rank,
                "title": row.title,
                "artistName": row.artist_name,
            }
            for row in rows
        ],
    )
    write_aggregated_csv(output_dir / "aggregated-songs.csv", aggregated)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_aggregated_csv(path: Path, rows: list[AggregatedSong]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["score", "appearances", "title", "artist_name", "platforms", "charts", "normalized_key"])
        for item in rows:
            writer.writerow(
                [
                    item.score,
                    item.appearances,
                    item.title,
                    item.artist_name,
                    ",".join(item.platforms),
                    " | ".join(item.charts),
                    item.normalized_key,
                ]
            )


def parse_platforms(value: str) -> list[str]:
    platforms = []
    for item in (value or "").split(","):
        platform = item.strip().lower()
        if platform and platform not in platforms:
            platforms.append(platform)
    return platforms or list(DEFAULT_PLATFORMS)


def build_source_report(source: ChartSource, status: str, row_count: int, error: str = "") -> dict[str, Any]:
    return {
        "platform": source.platform,
        "chartId": source.chart_id,
        "chartName": source.chart_name,
        "groupName": source.group_name,
        "chartUrl": source.chart_url,
        "status": status,
        "rowCount": row_count,
        "error": error,
    }


def build_platform_report(platform: str, status: str, error: str = "") -> dict[str, Any]:
    return {
        "platform": platform,
        "chartId": "",
        "chartName": "__discovery__",
        "groupName": "",
        "chartUrl": "",
        "status": status,
        "rowCount": 0,
        "error": error,
    }


def dedupe_sources(sources: list[ChartSource]) -> list[ChartSource]:
    seen: set[tuple[str, str]] = set()
    deduped: list[ChartSource] = []
    for source in sources:
        key = (source.platform, source.chart_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(source)
    return deduped


def normalize_chart_ranks(rows: list[ChartRow]) -> list[ChartRow]:
    normalized: list[ChartRow] = []
    for index, row in enumerate(rows, start=1):
        normalized.append(
            ChartRow(
                platform=row.platform,
                chart_id=row.chart_id,
                chart_name=row.chart_name,
                title=row.title,
                artist_name=row.artist_name,
                rank=index,
            )
        )
    return normalized


def split_artist_title(display: str) -> tuple[str, str]:
    text = clean_display_text(display)
    for separator in (" - ", " -", "- ", "-", " / ", "/"):
        if separator in text:
            left, right = text.split(separator, 1)
            artist_name = clean_display_text(left)
            title = clean_display_text(right)
            if title:
                return artist_name, title
    return "", text


def parse_kuwo_artist_line(line: str, title: str) -> str:
    text = clean_display_text(line)
    normalized_title = normalize_text(title)
    for separator in (" - ", "-", " / ", "/"):
        if separator in text:
            left, right = text.split(separator, 1)
            if normalize_text(right) == normalized_title:
                return clean_display_text(left)
    return text


def join_display_artists(artists: list[str]) -> str:
    cleaned = []
    for artist in artists:
        value = clean_display_text(artist)
        if value and value not in cleaned:
            cleaned.append(value)
    return "/".join(cleaned)


def clean_display_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", normalize_text(value or "")).strip()


def stringify(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def walk_dict_items(value: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            items.append(node)
            for nested in node.values():
                visit(nested)
        elif isinstance(node, list):
            for nested in node:
                visit(nested)

    visit(value)
    return items


def parse_embedded_json_object(page_html: str, marker: str) -> Any:
    marker_index = page_html.find(marker)
    if marker_index == -1:
        return None
    equals_index = page_html.find("=", marker_index)
    if equals_index == -1:
        return None
    object_text = extract_balanced_object(page_html, equals_index + 1)
    if not object_text:
        return None
    return json.loads(sanitize_javascript_object_text(object_text))


def extract_balanced_object(text: str, start_index: int) -> str:
    first_brace = text.find("{", start_index)
    if first_brace == -1:
        return ""

    depth = 0
    in_string = False
    quote = ""
    escaped = False

    for index in range(first_brace, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                in_string = False
            continue

        if character in ("'", '"'):
            in_string = True
            quote = character
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return text[first_brace : index + 1]
    return ""


def sanitize_javascript_object_text(value: str) -> str:
    sanitized = value
    sanitized = re.sub(r":\s*undefined\b", ": null", sanitized)
    sanitized = re.sub(r"\[\s*undefined\b", "[null", sanitized)
    sanitized = re.sub(r",\s*undefined\b", ", null", sanitized)
    return sanitized


def strip_tags(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", value or "")


def build_qq_chart_api_url(chart_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "format": "json",
            "topid": chart_id,
            "type": "top",
            "tpl": "3",
            "page": "detail",
            "song_begin": "0",
            "song_num": "200",
            "g_tk": "5381",
            "loginUin": "0",
            "hostUin": "0",
            "inCharset": "utf8",
            "outCharset": "utf-8",
            "notice": "0",
            "platform": "yqq.json",
            "needNewCode": "0",
        }
    )
    return f"https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?{query}"


def build_kugou_chart_page_url(chart_id: str, page: int) -> str:
    return f"https://www.kugou.com/yy/rank/home/{page}-{chart_id}.html?from=rank"


def build_netease_url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + path


def http_get_json(
    url: str,
    timeout_ms: int,
    headers: dict[str, str] | None = None,
    allow_jsonp: bool = False,
) -> Any:
    text = http_get_text(url, timeout_ms=timeout_ms, headers=headers)
    return json.loads(strip_jsonp(text) if allow_jsonp else text)


def http_get_text(url: str, timeout_ms: int, headers: dict[str, str] | None = None) -> str:
    request_headers = {"User-Agent": DEFAULT_USER_AGENT}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} for {url}: {detail[:300]}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Request failed for {url}: {error.reason}") from error


def strip_jsonp(value: str) -> str:
    text = value.strip()
    if text.startswith("{") or text.startswith("["):
        return text
    match = re.match(r"^[^(]+\((.*)\)\s*;?\s*$", text, re.DOTALL)
    if match:
        return match.group(1)
    return text


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


if __name__ == "__main__":
    raise SystemExit(main())
