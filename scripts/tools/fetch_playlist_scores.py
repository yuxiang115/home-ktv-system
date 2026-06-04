#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import os
import re
import subprocess
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
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "runtime" / "playlist-scores"
DEFAULT_NETEASE_BASE_URL = "http://127.0.0.1:4300"
DEFAULT_KEYWORD_PLATFORMS = ["netease", "kuwo"]
DEFAULT_DIRECT_PLATFORMS = ["netease", "qq", "kugou", "kuwo"]
DEFAULT_TIMEOUT_MS = 8000
DEFAULT_DELAY_MS = 300
DEFAULT_CONCURRENCY = 10
DEFAULT_PER_SOURCE_POINTS = 10
DEFAULT_SEARCH_LIMIT_PER_KEYWORD = 10
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
DEFAULT_KUGOU_MID = "239526275778893399526700786998289824956"
DEFAULT_KUWO_COOKIE = (
    "_ga=GA1.2.526731243.1718705002; _gid=GA1.2.1543973888.1718705002; "
    "Hm_lvt_cdb524f42f0ce19b169a8071123a4797=1718705002; "
    "h5Uuid=08d98230548b48f7a92b7bd084ba45-f7; "
    "Hm_lpvt_cdb524f42f0ce19b169a8071123a4797=1718713693; "
    "_ga_ETPBRPM9ML=GS1.2.1718713677.2.1.1718713693.44.0.0; "
    "Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=JXbannkz4r3pXFRW8YNjxzxmSkdxSPRX"
)
DEFAULT_KUWO_SIGN_SCRIPT = (
    ROOT_DIR / "runtime" / "third-party" / "research" / "musicapi" / "node" / "kuwo.js"
)


class PlaylistReference:
    def __init__(self, platform: str, playlist_id: str, original: str = "") -> None:
        self.platform = platform
        self.playlist_id = playlist_id
        self.original = original


class PlaylistSource:
    def __init__(
        self,
        platform: str,
        playlist_id: str,
        playlist_name: str = "",
        keyword: str = "",
        source_type: str = "direct",
        source_url: str = "",
    ) -> None:
        self.platform = platform
        self.playlist_id = playlist_id
        self.playlist_name = playlist_name
        self.keyword = keyword
        self.source_type = source_type
        self.source_url = source_url


class PlaylistRow:
    def __init__(
        self,
        platform: str,
        playlist_id: str,
        playlist_name: str,
        keyword: str,
        title: str,
        artist_name: str = "",
    ) -> None:
        self.platform = platform
        self.playlist_id = playlist_id
        self.playlist_name = playlist_name
        self.keyword = keyword
        self.title = title
        self.artist_name = artist_name


class AggregatedSong:
    def __init__(
        self,
        title: str,
        artist_name: str,
        normalized_key: str,
        score: int,
        appearances: int,
        platforms: list[str],
        playlists: list[str],
    ) -> None:
        self.title = title
        self.artist_name = artist_name
        self.normalized_key = normalized_key
        self.score = score
        self.appearances = appearances
        self.platforms = platforms
        self.playlists = playlists


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "collect":
        return run_collect(args)
    raise SystemExit(f"Unsupported command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect songs from playlist search and direct playlist sources, then score playlist appearances."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect = subparsers.add_parser("collect")
    collect.add_argument("--keywords", action="append", default=[])
    collect.add_argument("--keywords-file", default="")
    collect.add_argument("--playlist-urls", action="append", default=[])
    collect.add_argument("--playlist-urls-file", default="")
    collect.add_argument("--keyword-platforms", default=",".join(DEFAULT_KEYWORD_PLATFORMS))
    collect.add_argument("--direct-platforms", default=",".join(DEFAULT_DIRECT_PLATFORMS))
    collect.add_argument("--search-limit-per-keyword", type=positive_int, default=DEFAULT_SEARCH_LIMIT_PER_KEYWORD)
    collect.add_argument("--per-source-points", type=positive_int, default=DEFAULT_PER_SOURCE_POINTS)
    collect.add_argument("--output", default="")
    collect.add_argument("--request-timeout-ms", type=positive_int, default=DEFAULT_TIMEOUT_MS)
    collect.add_argument("--delay-ms", type=non_negative_int, default=DEFAULT_DELAY_MS)
    collect.add_argument("--concurrency", type=positive_int, default=DEFAULT_CONCURRENCY)
    collect.add_argument("--fetch-concurrency", type=positive_int, default=None)
    collect.add_argument(
        "--netease-base-url",
        default=os.environ.get("NETEASE_CLOUD_MUSIC_API_BASE_URL", DEFAULT_NETEASE_BASE_URL),
    )
    collect.add_argument("--kuwo-cookie", default=DEFAULT_KUWO_COOKIE)
    collect.add_argument("--kuwo-sign-script", default=str(DEFAULT_KUWO_SIGN_SCRIPT))
    collect.add_argument("--kugou-mid", default=DEFAULT_KUGOU_MID)
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
    fetch_concurrency = args.fetch_concurrency or args.concurrency
    keyword_platforms = parse_platforms(args.keyword_platforms) or list(DEFAULT_KEYWORD_PLATFORMS)
    direct_platforms = parse_platforms(args.direct_platforms) or list(DEFAULT_DIRECT_PLATFORMS)
    keywords = collect_keywords(args.keywords, args.keywords_file)
    direct_sources = collect_direct_sources(args.playlist_urls, args.playlist_urls_file, direct_platforms)

    if not keywords and not direct_sources:
        raise SystemExit("No input provided. Use --keywords/--keywords-file or --playlist-urls/--playlist-urls-file.")

    output_dir = resolve_output_dir(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    started_at = now_iso()

    source_entries: list[dict[str, Any]] = []
    playlist_rows: list[PlaylistRow] = []

    if keywords:
        for platform in keyword_platforms:
            for keyword in keywords:
                discovered = search_keyword_playlists(
                    platform=platform,
                    keyword=keyword,
                    limit=args.search_limit_per_keyword,
                    timeout_ms=args.request_timeout_ms,
                    netease_base_url=args.netease_base_url,
                    kuwo_cookie=args.kuwo_cookie,
                    kuwo_sign_script=args.kuwo_sign_script,
                )
                source_entries.extend(discovered["reports"])
                fetched_rows, reports = collect_playlist_sources_in_parallel(
                    sources=discovered["sources"],
                    fetcher=fetch_playlist_source,
                    fetch_concurrency=fetch_concurrency,
                    timeout_ms=args.request_timeout_ms,
                    netease_base_url=args.netease_base_url,
                    kuwo_cookie=args.kuwo_cookie,
                    kuwo_sign_script=args.kuwo_sign_script,
                    kugou_mid=args.kugou_mid,
                    delay_ms=args.delay_ms,
                )
                source_entries.extend(reports)
                playlist_rows.extend(fetched_rows)

    fetched_rows, reports = collect_playlist_sources_in_parallel(
        sources=direct_sources,
        fetcher=fetch_playlist_source,
        fetch_concurrency=fetch_concurrency,
        timeout_ms=args.request_timeout_ms,
        netease_base_url=args.netease_base_url,
        kuwo_cookie=args.kuwo_cookie,
        kuwo_sign_script=args.kuwo_sign_script,
        kugou_mid=args.kugou_mid,
        delay_ms=args.delay_ms,
    )
    source_entries.extend(reports)
    playlist_rows.extend(fetched_rows)

    aggregated = aggregate_playlist_rows(playlist_rows, per_source_points=args.per_source_points)
    write_run_outputs(
        output_dir=output_dir,
        started_at=started_at,
        keyword_platforms=keyword_platforms,
        direct_platforms=direct_platforms,
        keywords=keywords,
        per_source_points=args.per_source_points,
        source_entries=source_entries,
        rows=playlist_rows,
        aggregated=aggregated,
    )

    print(
        json.dumps(
            {
                "output": str(output_dir),
                "keywordPlatforms": keyword_platforms,
                "directPlatforms": direct_platforms,
                "keywords": len(keywords),
                "sources": len(source_entries),
                "rows": len(playlist_rows),
                "songs": len(aggregated),
            },
            ensure_ascii=False,
        )
    )
    return 0


def collect_playlist_sources_in_parallel(
    sources: list[PlaylistSource],
    fetcher: Any,
    fetch_concurrency: int,
    **fetch_kwargs: Any,
) -> tuple[list[PlaylistRow], list[dict[str, Any]]]:
    if not sources:
        return [], []
    rows: list[PlaylistRow] = []
    reports_by_order: dict[int, dict[str, Any]] = {}
    rows_by_order: dict[int, list[PlaylistRow]] = {}
    max_workers = max(1, min(fetch_concurrency, len(sources)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(fetcher, source=source, **fetch_kwargs): index
            for index, source in enumerate(sources)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            fetched_rows, report = future.result()
            rows_by_order[index] = fetched_rows
            reports_by_order[index] = report

    ordered_reports: list[dict[str, Any]] = []
    for index in range(len(sources)):
        ordered_reports.append(reports_by_order[index])
        rows.extend(rows_by_order.get(index, []))
    return rows, ordered_reports


def collect_keywords(values: list[str], keywords_file: str) -> list[str]:
    keywords: list[str] = []
    for value in flatten_cli_values(values):
        item = clean_display_text(value)
        if item and item not in keywords:
            keywords.append(item)
    if keywords_file:
        for value in read_non_empty_lines(Path(keywords_file)):
            if value not in keywords:
                keywords.append(value)
    return keywords


def collect_direct_sources(values: list[str], playlist_urls_file: str, direct_platforms: list[str]) -> list[PlaylistSource]:
    raw_values = flatten_cli_values(values)
    if playlist_urls_file:
        raw_values.extend(read_non_empty_lines(Path(playlist_urls_file)))
    sources: list[PlaylistSource] = []
    for value in raw_values:
        reference = parse_playlist_reference(value)
        if reference.platform not in direct_platforms:
            continue
        sources.append(
            PlaylistSource(
                platform=reference.platform,
                playlist_id=reference.playlist_id,
                playlist_name="",
                keyword="",
                source_type="direct",
                source_url=reference.original or value,
            )
        )
    return dedupe_playlist_sources(sources)


def flatten_cli_values(values: list[str]) -> list[str]:
    flattened: list[str] = []
    for value in values or []:
        for piece in re.split(r"[\n,]+", value):
            item = clean_display_text(piece)
            if item:
                flattened.append(item)
    return flattened


def read_non_empty_lines(path: Path) -> list[str]:
    lines: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        value = clean_display_text(raw_line)
        if value:
            lines.append(value)
    return lines


def parse_playlist_reference(value: str, default_platform: str = "") -> PlaylistReference:
    text = clean_display_text(value)
    if not text:
        raise ValueError("Empty playlist reference")

    prefixed = re.match(r"^(netease|qq|kugou|kuwo):([A-Za-z0-9_]+)$", text, flags=re.IGNORECASE)
    if prefixed:
        return PlaylistReference(prefixed.group(1).lower(), prefixed.group(2), text)

    if re.fullmatch(r"\d+", text) and default_platform:
        return PlaylistReference(default_platform.lower(), text, text)

    parsed = urllib.parse.urlparse(text)
    host = parsed.netloc.lower()
    path = parsed.path or ""
    fragment = parsed.fragment or ""
    query = urllib.parse.parse_qs(parsed.query)
    fragment_query = urllib.parse.parse_qs(fragment.split("?", 1)[1]) if "?" in fragment else {}

    if "music.163.com" in host:
        playlist_id = first_non_empty(query.get("id"), fragment_query.get("id"))
        if not playlist_id:
            match = re.search(r"/playlist(?:/|$)", path)
            if match:
                playlist_id = first_non_empty(query.get("id"))
        if playlist_id:
            return PlaylistReference("netease", playlist_id, text)

    if "y.qq.com" in host:
        match = re.search(r"/playlist/(\d+)", path)
        if match:
            return PlaylistReference("qq", match.group(1), text)
        playlist_id = first_non_empty(query.get("id"), query.get("disstid"))
        if playlist_id:
            return PlaylistReference("qq", playlist_id, text)

    if "kugou.com" in host:
        match = re.search(r"/songlist/(\d+)", path)
        if match:
            return PlaylistReference("kugou", match.group(1), text)
        match = re.search(r"/special/single/(\d+)\.html", path)
        if match:
            return PlaylistReference("kugou", match.group(1), text)
        playlist_id = first_non_empty(query.get("specialid"), query.get("id"))
        if playlist_id:
            return PlaylistReference("kugou", playlist_id, text)

    if "kuwo.cn" in host:
        match = re.search(r"/playlist_detail/(\d+)", path)
        if match:
            return PlaylistReference("kuwo", match.group(1), text)
        playlist_id = first_non_empty(query.get("pid"), query.get("id"))
        if playlist_id:
            return PlaylistReference("kuwo", playlist_id, text)

    raise ValueError(f"Unsupported playlist reference: {value}")


def search_keyword_playlists(
    platform: str,
    keyword: str,
    limit: int,
    timeout_ms: int,
    netease_base_url: str,
    kuwo_cookie: str,
    kuwo_sign_script: str,
) -> dict[str, Any]:
    if platform == "netease":
        try:
            payload = http_get_json(
                build_netease_url(
                    netease_base_url,
                    f"/cloudsearch?keywords={urllib.parse.quote(keyword)}&type=1000&limit={limit}",
                ),
                timeout_ms=timeout_ms,
            )
            sources = parse_netease_playlist_search_results(keyword, payload)[:limit]
            return {"sources": dedupe_playlist_sources(sources), "reports": []}
        except Exception as error:  # pragma: no cover - smoke
            return {"sources": [], "reports": [build_platform_report(platform, "keyword-search", keyword, str(error))]}

    if platform == "kuwo":
        try:
            auth = get_kuwo_auth(kuwo_cookie, kuwo_sign_script)
            query = urllib.parse.urlencode(
                {
                    "key": keyword,
                    "pn": "1",
                    "rn": str(limit),
                    "httpsStatus": "1",
                    "reqId": auth["reqId"],
                    "plat": "web_www",
                    "from": "",
                }
            )
            payload = http_get_json(
                f"https://bd.kuwo.cn/api/www/search/searchPlayListBykeyWord?{query}",
                timeout_ms=timeout_ms,
                headers=build_kuwo_headers(kuwo_cookie, auth["secret"], "https://bd.kuwo.cn/"),
            )
            sources = parse_kuwo_playlist_search_results(keyword, payload)[:limit]
            return {"sources": dedupe_playlist_sources(sources), "reports": []}
        except Exception as error:  # pragma: no cover - smoke
            return {"sources": [], "reports": [build_platform_report(platform, "keyword-search", keyword, str(error))]}

    return {"sources": [], "reports": [build_platform_report(platform, "keyword-search", keyword, "Unsupported keyword platform")]}


def fetch_playlist_source(
    source: PlaylistSource,
    timeout_ms: int,
    netease_base_url: str,
    kuwo_cookie: str,
    kuwo_sign_script: str,
    kugou_mid: str,
    delay_ms: int = 0,
) -> tuple[list[PlaylistRow], dict[str, Any]]:
    try:
        if delay_ms:
            time.sleep(delay_ms / 1000)
        if source.platform == "netease":
            rows, playlist_name = fetch_netease_playlist_rows(source, timeout_ms, netease_base_url)
        elif source.platform == "qq":
            rows, playlist_name = fetch_qq_playlist_rows(source, timeout_ms)
        elif source.platform == "kugou":
            rows, playlist_name = fetch_kugou_playlist_rows(source, timeout_ms, kugou_mid)
        elif source.platform == "kuwo":
            rows, playlist_name = fetch_kuwo_playlist_rows(source, timeout_ms, kuwo_cookie, kuwo_sign_script)
        else:
            raise ValueError(f"Unsupported platform: {source.platform}")
        if playlist_name:
            source.playlist_name = playlist_name
        return rows, build_source_report(source, "ok", len(rows))
    except Exception as error:  # pragma: no cover - smoke
        return [], build_source_report(source, "error", 0, str(error))


def fetch_netease_playlist_rows(
    source: PlaylistSource,
    timeout_ms: int,
    base_url: str,
) -> tuple[list[PlaylistRow], str]:
    primary_url = build_netease_url(base_url, f"/playlist/track/all?id={urllib.parse.quote(source.playlist_id)}")
    detail_url = build_netease_url(base_url, f"/playlist/detail?id={urllib.parse.quote(source.playlist_id)}")

    last_error: Exception | None = None
    for url in (primary_url, detail_url):
        try:
            payload = http_get_json(url, timeout_ms=timeout_ms)
            rows = parse_netease_playlist_tracks(source.playlist_id, source.playlist_name, source.keyword, payload)
            playlist_name = source.playlist_name or extract_netease_playlist_name(payload)
            rows = apply_playlist_name(rows, playlist_name)
            if rows:
                return rows, playlist_name
            if playlist_name:
                return rows, playlist_name
        except Exception as error:  # pragma: no cover - smoke
            last_error = error
    raise ValueError(str(last_error or "NetEase playlist rows not found"))


def fetch_qq_playlist_rows(source: PlaylistSource, timeout_ms: int) -> tuple[list[PlaylistRow], str]:
    last_error: Exception | None = None
    for url, allow_jsonp in (
        (build_qq_playlist_v8_api_url(source.playlist_id), False),
        (build_qq_playlist_api_url(source.playlist_id), True),
    ):
        try:
            payload = http_get_json(
                url,
                timeout_ms=timeout_ms,
                headers={"Referer": "https://y.qq.com/"},
                allow_jsonp=allow_jsonp,
            )
            rows = parse_qq_playlist_tracks(source.playlist_id, source.playlist_name, source.keyword, payload)
            playlist_name = extract_qq_playlist_name(payload) or source.playlist_name
            rows = apply_playlist_name(rows, playlist_name)
            if rows:
                return rows, playlist_name
            if playlist_name:
                return rows, playlist_name
        except Exception as error:  # pragma: no cover - smoke
            last_error = error
    raise ValueError(str(last_error or "QQ playlist rows not found"))


def fetch_kugou_playlist_rows(source: PlaylistSource, timeout_ms: int, kugou_mid: str) -> tuple[list[PlaylistRow], str]:
    url = build_kugou_playlist_api_url(source.playlist_id)
    signed_url = f"{url}&signature={sign_kugou_url(url)}"
    payload = http_get_json(
        signed_url,
        timeout_ms=timeout_ms,
        headers={
            "Host": "gatewayretry.kugou.com",
            "x-router": "pubsongscdn.kugou.com",
            "mid": kugou_mid,
            "dfid": "-",
            "clienttime": str(int(time.time())),
            "User-Agent": "Android9-AndroidPhone-11239-18-0-playlist-wifi",
        },
    )
    rows = parse_kugou_playlist_tracks(source.playlist_id, source.playlist_name, source.keyword, payload)
    playlist_name = extract_kugou_playlist_name(payload) or source.playlist_name
    return apply_playlist_name(rows, playlist_name), playlist_name


def fetch_kuwo_playlist_rows(
    source: PlaylistSource,
    timeout_ms: int,
    kuwo_cookie: str,
    kuwo_sign_script: str,
) -> tuple[list[PlaylistRow], str]:
    auth = get_kuwo_auth(kuwo_cookie, kuwo_sign_script)
    headers = build_kuwo_headers(
        kuwo_cookie,
        auth["secret"],
        f"https://bd.kuwo.cn/playlist_detail/{source.playlist_id}",
    )
    rows: list[PlaylistRow] = []
    playlist_name = source.playlist_name
    for page in range(1, 100):
        query = urllib.parse.urlencode(
            {
                "pid": source.playlist_id,
                "pn": str(page),
                "rn": "20",
                "httpsStatus": "1",
                "reqId": auth["reqId"],
                "plat": "web_www",
                "from": "",
            }
        )
        payload = http_get_json(
            f"https://bd.kuwo.cn/api/www/playlist/playListInfo?{query}",
            timeout_ms=timeout_ms,
            headers=headers,
        )
        page_rows = parse_kuwo_playlist_tracks(source.playlist_id, source.playlist_name, source.keyword, payload)
        if not playlist_name:
            playlist_name = extract_kuwo_playlist_name(payload)
        page_rows = apply_playlist_name(page_rows, playlist_name)
        if not page_rows:
            break
        rows.extend(page_rows)
        music_list = (((payload or {}).get("data") or {}).get("musicList") if isinstance(payload, dict) else None)
        if not isinstance(music_list, list) or len(music_list) < 20:
            break
    return rows, playlist_name or source.playlist_name


def parse_netease_playlist_search_results(keyword: str, data: Any) -> list[PlaylistSource]:
    playlists = (((data or {}).get("result") or {}).get("playlists") if isinstance(data, dict) else None)
    if not isinstance(playlists, list):
        return []
    sources: list[PlaylistSource] = []
    for item in playlists:
        if not isinstance(item, dict):
            continue
        playlist_id = stringify(item.get("id"))
        playlist_name = clean_display_text(stringify(item.get("name")))
        if playlist_id and playlist_name:
            sources.append(
                PlaylistSource(
                    platform="netease",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    source_type="keyword",
                    source_url=f"netease-search:{keyword}",
                )
            )
    return dedupe_playlist_sources(sources)


def parse_netease_playlist_tracks(
    playlist_id: str,
    playlist_name: str,
    keyword: str,
    data: Any,
) -> list[PlaylistRow]:
    songs: list[Any] = []
    if isinstance(data, dict):
        if isinstance(data.get("songs"), list):
            songs = data["songs"]
        elif isinstance(data.get("playlist"), dict) and isinstance(data["playlist"].get("tracks"), list):
            songs = data["playlist"]["tracks"]

    rows: list[PlaylistRow] = []
    for item in songs:
        if not isinstance(item, dict):
            continue
        title = clean_display_text(stringify(item.get("name")))
        artists = item.get("ar") if isinstance(item.get("ar"), list) else item.get("artists")
        artist_names: list[str] = []
        if isinstance(artists, list):
            for artist in artists:
                if isinstance(artist, dict):
                    name = clean_display_text(stringify(artist.get("name")))
                    if name:
                        artist_names.append(name)
        if title:
            rows.append(
                PlaylistRow(
                    platform="netease",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    title=title,
                    artist_name=join_display_artists(artist_names),
                )
            )
    return rows


def parse_kuwo_playlist_search_results(keyword: str, data: Any) -> list[PlaylistSource]:
    items = (((data or {}).get("data") or {}).get("list") if isinstance(data, dict) else None)
    if not isinstance(items, list):
        return []
    sources: list[PlaylistSource] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        playlist_id = stringify(item.get("id"))
        playlist_name = clean_display_text(stringify(item.get("name")))
        if playlist_id and playlist_name:
            sources.append(
                PlaylistSource(
                    platform="kuwo",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    source_type="keyword",
                    source_url=f"kuwo-search:{keyword}",
                )
            )
    return dedupe_playlist_sources(sources)


def parse_kuwo_playlist_tracks(
    playlist_id: str,
    playlist_name: str,
    keyword: str,
    data: Any,
) -> list[PlaylistRow]:
    items = (((data or {}).get("data") or {}).get("musicList") if isinstance(data, dict) else None)
    if not isinstance(items, list):
        return []
    rows: list[PlaylistRow] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = clean_display_text(stringify(item.get("name")))
        artist_name = clean_display_text(stringify(item.get("artist")))
        if title:
            rows.append(
                PlaylistRow(
                    platform="kuwo",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    title=title,
                    artist_name=artist_name,
                )
            )
    return rows


def parse_qq_playlist_tracks(
    playlist_id: str,
    playlist_name: str,
    keyword: str,
    data: Any,
) -> list[PlaylistRow]:
    cdlist = None
    if isinstance(data, dict):
        if isinstance(data.get("cdlist"), list):
            cdlist = data.get("cdlist")
        elif isinstance(data.get("data"), dict) and isinstance(data["data"].get("cdlist"), list):
            cdlist = data["data"].get("cdlist")
    if not isinstance(cdlist, list) or not cdlist:
        return []
    songlist = cdlist[0].get("songlist") if isinstance(cdlist[0], dict) else None
    if not isinstance(songlist, list):
        return []
    rows: list[PlaylistRow] = []
    for item in songlist:
        if not isinstance(item, dict):
            continue
        title = clean_display_text(stringify(item.get("songname") or item.get("title")))
        artists: list[str] = []
        for singer in item.get("singer") or []:
            if isinstance(singer, dict):
                name = clean_display_text(stringify(singer.get("name")))
                if name:
                    artists.append(name)
        if title:
            rows.append(
                PlaylistRow(
                    platform="qq",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    title=title,
                    artist_name=join_display_artists(artists),
                )
            )
    return rows


def parse_kugou_playlist_tracks(
    playlist_id: str,
    playlist_name: str,
    keyword: str,
    data: Any,
) -> list[PlaylistRow]:
    items = (((data or {}).get("data") or {}).get("info") if isinstance(data, dict) else None)
    if not isinstance(items, list):
        return []
    rows: list[PlaylistRow] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        display = clean_display_text(stringify(item.get("name")))
        artist_name, title = split_artist_title(display)
        if title:
            rows.append(
                PlaylistRow(
                    platform="kugou",
                    playlist_id=playlist_id,
                    playlist_name=playlist_name,
                    keyword=keyword,
                    title=title,
                    artist_name=artist_name,
                )
            )
    return rows


def extract_netease_playlist_name(data: Any) -> str:
    playlist = data.get("playlist") if isinstance(data, dict) else None
    if isinstance(playlist, dict):
        return clean_display_text(stringify(playlist.get("name")))
    return ""


def extract_qq_playlist_name(data: Any) -> str:
    cdlist = None
    if isinstance(data, dict):
        if isinstance(data.get("cdlist"), list):
            cdlist = data.get("cdlist")
        elif isinstance(data.get("data"), dict) and isinstance(data["data"].get("cdlist"), list):
            cdlist = data["data"].get("cdlist")
    if isinstance(cdlist, list) and cdlist and isinstance(cdlist[0], dict):
        return clean_display_text(stringify(cdlist[0].get("dissname") or cdlist[0].get("dirname")))
    return ""


def extract_kugou_playlist_name(data: Any) -> str:
    data_node = data.get("data") if isinstance(data, dict) else None
    if isinstance(data_node, dict):
        return clean_display_text(stringify(data_node.get("specialname") or data_node.get("name")))
    return ""


def extract_kuwo_playlist_name(data: Any) -> str:
    data_node = data.get("data") if isinstance(data, dict) else None
    if isinstance(data_node, dict):
        return clean_display_text(stringify(data_node.get("name")))
    return ""


def aggregate_playlist_rows(rows: list[PlaylistRow], per_source_points: int) -> list[AggregatedSong]:
    playlist_seen: set[tuple[str, str, str]] = set()
    grouped: dict[str, dict[str, Any]] = {}

    for row in rows:
        identity = build_song_identity(row.title, row.artist_name)
        if not identity:
            continue
        playlist_key = (row.platform, row.playlist_id, identity)
        if playlist_key in playlist_seen:
            continue
        playlist_seen.add(playlist_key)

        group = grouped.get(identity)
        if group is None:
            group = {
                "title": clean_display_text(row.title),
                "artist_name": clean_display_text(row.artist_name),
                "platforms": [],
                "playlists": [],
                "appearances": 0,
            }
            grouped[identity] = group
        group["appearances"] += 1
        if row.platform not in group["platforms"]:
            group["platforms"].append(row.platform)
        group["playlists"].append(f"{row.platform}:{row.playlist_id}:{clean_display_text(row.playlist_name)}")

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
                playlists=list(group["playlists"]),
            )
        )

    aggregated.sort(
        key=lambda item: (-item.score, -item.appearances, item.title or "", item.artist_name or "")
    )
    return aggregated


def apply_playlist_name(rows: list[PlaylistRow], playlist_name: str) -> list[PlaylistRow]:
    name = clean_display_text(playlist_name)
    if not name:
        return rows
    for row in rows:
        if not clean_display_text(row.playlist_name):
            row.playlist_name = name
    return rows


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


def resolve_output_dir(output: str) -> Path:
    if output:
        return Path(output).resolve()
    timestamp = datetime.now().strftime("run-%Y%m%d-%H%M%S")
    return (DEFAULT_OUTPUT_ROOT / timestamp).resolve()


def write_run_outputs(
    output_dir: Path,
    started_at: str,
    keyword_platforms: list[str],
    direct_platforms: list[str],
    keywords: list[str],
    per_source_points: int,
    source_entries: list[dict[str, Any]],
    rows: list[PlaylistRow],
    aggregated: list[AggregatedSong],
) -> None:
    write_json(
        output_dir / "source-report.json",
        {
            "startedAt": started_at,
            "finishedAt": now_iso(),
            "keywordPlatforms": keyword_platforms,
            "directPlatforms": direct_platforms,
            "keywords": keywords,
            "perSourcePoints": per_source_points,
            "sources": source_entries,
        },
    )
    write_json(
        output_dir / "playlist-rows.json",
        [
            {
                "platform": row.platform,
                "playlistId": row.playlist_id,
                "playlistName": row.playlist_name,
                "keyword": row.keyword,
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
        writer.writerow(["score", "appearances", "title", "artist_name", "platforms", "playlists", "normalized_key"])
        for item in rows:
            writer.writerow(
                [
                    item.score,
                    item.appearances,
                    item.title,
                    item.artist_name,
                    ",".join(item.platforms),
                    " | ".join(item.playlists),
                    item.normalized_key,
                ]
            )


def parse_platforms(value: str) -> list[str]:
    platforms = []
    for item in (value or "").split(","):
        platform = item.strip().lower()
        if platform and platform not in platforms:
            platforms.append(platform)
    return platforms


def dedupe_playlist_sources(sources: list[PlaylistSource]) -> list[PlaylistSource]:
    deduped: list[PlaylistSource] = []
    grouped: dict[tuple[str, str], PlaylistSource] = {}
    for source in sources:
        key = (source.platform, source.playlist_id)
        if key not in grouped:
            grouped[key] = source
            deduped.append(source)
            continue
        existing = grouped[key]
        if source.keyword:
            keywords = [item for item in split_keywords(existing.keyword) if item]
            for keyword in split_keywords(source.keyword):
                if keyword and keyword not in keywords:
                    keywords.append(keyword)
            existing.keyword = ",".join(keywords)
        if not existing.playlist_name and source.playlist_name:
            existing.playlist_name = source.playlist_name
        if not existing.source_url and source.source_url:
            existing.source_url = source.source_url
    return deduped


def split_keywords(value: str) -> list[str]:
    return [clean_display_text(item) for item in value.split(",") if clean_display_text(item)]


def build_source_report(source: PlaylistSource, status: str, row_count: int, error: str = "") -> dict[str, Any]:
    return {
        "platform": source.platform,
        "playlistId": source.playlist_id,
        "playlistName": source.playlist_name,
        "keyword": source.keyword,
        "sourceType": source.source_type,
        "sourceUrl": source.source_url,
        "status": status,
        "rowCount": row_count,
        "error": error,
    }


def build_platform_report(platform: str, source_type: str, keyword: str, error: str = "") -> dict[str, Any]:
    return {
        "platform": platform,
        "playlistId": "",
        "playlistName": "__discovery__",
        "keyword": keyword,
        "sourceType": source_type,
        "sourceUrl": "",
        "status": "error" if error else "empty",
        "rowCount": 0,
        "error": error,
    }


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


def first_non_empty(*values: list[str] | None) -> str:
    for collection in values:
        if isinstance(collection, list):
            for value in collection:
                item = clean_display_text(value)
                if item:
                    return item
    return ""


def build_netease_url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + path


def build_qq_playlist_api_url(playlist_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "type": "1",
            "json": "1",
            "utf8": "1",
            "onlysong": "0",
            "disstid": playlist_id,
            "format": "jsonp",
            "g_tk": "5381",
            "jsonpCallback": "playlistinfoCallback",
            "loginUin": "0",
            "hostUin": "0",
            "inCharset": "utf8",
            "outCharset": "utf-8",
            "platform": "yqq",
            "needNewCode": "0",
        }
    )
    return f"https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?{query}"


def build_qq_playlist_v8_api_url(playlist_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "id": playlist_id,
            "format": "json",
            "newsong": "1",
            "platform": "jqspaframe.json",
        }
    )
    return f"https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?{query}"


def build_kugou_playlist_api_url(playlist_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "specialid": playlist_id,
            "need_sort": "1",
            "module": "CloudMusic",
            "clientver": "11239",
            "pagesize": "300",
            "specalidpgc": playlist_id,
            "userid": "0",
            "page": "1",
            "type": "0",
            "area_code": "1",
            "appid": "1005",
        }
    )
    return f"http://gatewayretry.kugou.com/v2/get_other_list_file?{query}"


def sign_kugou_url(url: str) -> str:
    uri = url.split("?", 1)[1]
    ordered = "".join(sorted(uri.split("&")))
    digest = "OIlwieks28dk2k092lksi2UIkp" + ordered + "OIlwieks28dk2k092lksi2UIkp"
    return hashlib.md5(digest.encode("utf-8")).hexdigest()


def build_kuwo_headers(cookie: str, secret: str, referer: str) -> dict[str, str]:
    return {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": referer,
        "Cookie": cookie,
        "Secret": secret,
    }


def get_kuwo_auth(cookie: str, script_path: str) -> dict[str, str]:
    path = Path(script_path)
    if not path.exists():
        raise FileNotFoundError(f"Kuwo sign script not found: {path}")
    command = [
        "node",
        "-e",
        (
            "const fs=require('fs');"
            "const path=process.argv[1];"
            "const cookie=process.argv[2];"
            "eval(fs.readFileSync(path,'utf8'));"
            "console.log(JSON.stringify({reqId:getReqId(),secret:get_Secret(cookie)}));"
        ),
        str(path),
        cookie,
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout.strip() or "{}")
    req_id = clean_display_text(stringify(payload.get("reqId")))
    secret = clean_display_text(stringify(payload.get("secret")))
    if not req_id or not secret:
        raise ValueError("Failed to generate Kuwo auth")
    return {"reqId": req_id, "secret": secret}


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
