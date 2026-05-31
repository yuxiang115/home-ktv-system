#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_PROVIDERS = ["tencent", "kugou", "kuwo"]
DEFAULT_IMAGE_SIZE = 300
MAX_IMAGE_BYTES = 5 * 1024 * 1024
SAFE_SONG_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class SongActionDecision:
    def __init__(self, action, public_url=None, external_url=None, reason=""):
        self.action = action
        self.public_url = public_url
        self.external_url = external_url
        self.reason = reason


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    load_env_file(args.env_file)

    if args.command == "fetch":
        fetch_covers(args)
    elif args.command == "coverage":
        run_coverage(args)
    elif args.command == "status":
        print_status(args)
    else:
        raise SystemExit(f"Unknown command: {args.command}")


def parse_args(argv):
    argv = [arg for arg in argv if arg != "--"]
    parser = argparse.ArgumentParser(description="Fetch and locally cache HomeKTV song covers.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("fetch", "coverage", "status"):
        sub = subparsers.add_parser(command)
        add_common_args(sub)
        if command in ("fetch", "coverage"):
            limit_default = 0 if command == "fetch" else 100
            sub.add_argument("--limit", type=non_negative_int, default=limit_default, help="0 means all selected songs.")
            sub.add_argument("--providers", default=",".join(DEFAULT_PROVIDERS))
            sub.add_argument("--search-limit", type=positive_int, default=8)
            sub.add_argument("--request-timeout-ms", type=positive_int, default=8000)
            sub.add_argument("--delay-ms", type=non_negative_int, default=600)
            sub.add_argument("--concurrency", type=positive_int, default=1)
            sub.add_argument("--progress-every", type=positive_int, default=20)
        if command == "fetch":
            sub.add_argument("--retry-failed", action="store_true")
            sub.add_argument("--retry-not-found", action="store_true")
            sub.add_argument("--force", action="store_true")

    return parser.parse_args(argv)


def add_common_args(parser):
    parser.add_argument("--env-file", default=os.environ.get("KTV_ENV_FILE", "deploy/source/.env"))
    parser.add_argument("--database-url", default="")
    parser.add_argument("--postgres-container", default=os.environ.get("KTV_POSTGRES_CONTAINER", ""))
    parser.add_argument("--db-user", default=os.environ.get("PGUSER", "ktv"))
    parser.add_argument("--db-name", default=os.environ.get("PGDATABASE", "home_ktv"))
    parser.add_argument("--media-root", default="")
    parser.add_argument("--cover-root", default="")
    parser.add_argument("--public-base-url", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--state", default="")


def fetch_covers(args):
    media_root = resolve_media_root(args)
    cover_root = resolve_cover_root(args, media_root)
    output = resolve_output_path(args, media_root)
    state_path = resolve_state_path(args, output)
    public_base_url = resolve_public_base_url(args)
    ensure_parent(output)
    ensure_parent(state_path)

    songs = select_candidate_songs(args, random_order=False)
    history = read_history(output)
    stats = {
        "selected": len(songs),
        "found": 0,
        "repaired": 0,
        "skipped": 0,
        "notFound": 0,
        "failed": 0,
    }
    write_state(state_path, {**stats, "status": "running", "updatedAt": now_iso(), "output": str(output)})
    print(f"selected={len(songs)} concurrency={args.concurrency} coverRoot={cover_root} output={output}", flush=True)

    providers = read_provider_list(args.providers)
    worker = lambda song: process_fetch_song(args, song, history, cover_root, public_base_url, providers)
    for index, result in enumerate(iter_song_task_results(songs, worker, args.concurrency, args.delay_ms), start=1):
        stat_key = fetch_status_stat_key(result.get("status"))
        if stat_key:
            stats[stat_key] += 1
        append_jsonl(output, result)

        if index % args.progress_every == 0 or index == len(songs):
            remaining = len(songs) - index
            print(
                f"processed={index}/{len(songs)} remaining={remaining} "
                f"found={stats['found']} repaired={stats['repaired']} "
                f"notFound={stats['notFound']} failed={stats['failed']} skipped={stats['skipped']}",
                flush=True,
            )
            write_state(
                state_path,
                {
                    **stats,
                    "status": "running" if remaining else "completed",
                    "processed": index,
                    "pending": remaining,
                    "updatedAt": now_iso(),
                    "output": str(output),
                },
            )


def process_fetch_song(args, song, history, cover_root, public_base_url, providers):
    decision = decide_song_action(
        song,
        history,
        cover_root,
        public_base_url,
        args.retry_failed,
        args.retry_not_found,
        args.force,
    )
    row = {
        "songId": song["id"],
        "title": song["title"],
        "artistName": song["artistName"],
        "createdAt": now_iso(),
    }
    try:
        if decision.action == "skip":
            return {**row, "status": "skipped", "reason": decision.reason}
        if decision.action == "repair":
            update_cover_url(args, song["id"], decision.public_url)
            return {**row, "status": "repaired", "publicUrl": decision.public_url}

        cover = None
        if decision.external_url:
            cover = {
                "provider": "existing",
                "providerSongId": "",
                "imageUrl": decision.external_url,
                "confidence": 100,
            }
        if not cover:
            cover = find_cover(song, providers, args.search_limit, args.request_timeout_ms, DEFAULT_IMAGE_SIZE)
        if not cover:
            touch_cover_processed(args, song["id"])
            return {**row, "status": "not_found"}

        public_url = public_cover_url(public_base_url, song["id"])
        destination = cover_file_path(cover_root, song["id"])
        download_image(cover["imageUrl"], destination, args.request_timeout_ms)
        update_cover_url(args, song["id"], public_url)
        return {
            **row,
            "status": "found",
            "provider": cover["provider"],
            "providerSongId": cover.get("providerSongId") or "",
            "confidence": cover.get("confidence"),
            "externalImageUrl": cover["imageUrl"],
            "publicUrl": public_url,
            "coverPath": str(destination),
        }
    except Exception as error:
        try:
            touch_cover_processed(args, song["id"])
        except Exception as touch_error:
            detail = f"{str(error)[:350]}; touch failed: {str(touch_error)[:120]}"
            return {**row, "status": "failed", "error": detail}
        return {**row, "status": "failed", "error": str(error)[:500]}


def fetch_status_stat_key(status):
    return {
        "found": "found",
        "repaired": "repaired",
        "skipped": "skipped",
        "not_found": "notFound",
        "failed": "failed",
    }.get(clean(status))


def run_coverage(args):
    songs = select_candidate_songs(args, random_order=True)
    providers = read_provider_list(args.providers)
    stats = {"sample": len(songs), "found": 0, "notFound": 0, "failed": 0, "providerHits": {}}
    print(f"sample={len(songs)} concurrency={args.concurrency} providers={','.join(providers)}", flush=True)

    worker = lambda song: process_coverage_song(song, providers, args.search_limit, args.request_timeout_ms)
    for index, result in enumerate(iter_song_task_results(songs, worker, args.concurrency, args.delay_ms), start=1):
        if result["status"] == "found":
            stats["found"] += 1
            provider = result["provider"]
            stats["providerHits"][provider] = stats["providerHits"].get(provider, 0) + 1
        elif result["status"] == "not_found":
            stats["notFound"] += 1
        else:
            stats["failed"] += 1

        if index % args.progress_every == 0 or index == len(songs):
            print(json.dumps(stats, ensure_ascii=False, sort_keys=True), flush=True)

    hit_rate = 0 if stats["sample"] == 0 else round(stats["found"] / stats["sample"] * 100, 1)
    print(json.dumps({**stats, "hitRate": hit_rate}, ensure_ascii=False, sort_keys=True), flush=True)


def process_coverage_song(song, providers, search_limit, request_timeout_ms):
    try:
        cover = find_cover(song, providers, search_limit, request_timeout_ms, DEFAULT_IMAGE_SIZE)
        if cover:
            return {"status": "found", "provider": cover["provider"]}
        return {"status": "not_found"}
    except Exception as error:
        return {"status": "failed", "error": str(error)[:500]}


def iter_song_task_results(songs, worker, concurrency=1, delay_ms=0):
    concurrency = max(1, int(concurrency))
    delay_seconds = max(0, int(delay_ms)) / 1000
    if concurrency == 1:
        for index, song in enumerate(songs):
            yield worker(song)
            if delay_seconds and index < len(songs) - 1:
                time.sleep(delay_seconds)
        return

    song_iter = iter(songs)
    in_flight = set()
    submitted = 0

    def submit_next(executor):
        nonlocal submitted
        try:
            song = next(song_iter)
        except StopIteration:
            return False
        if delay_seconds and submitted > 0:
            time.sleep(delay_seconds)
        in_flight.add(executor.submit(worker, song))
        submitted += 1
        return True

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        while len(in_flight) < concurrency and submit_next(executor):
            pass
        while in_flight:
            done, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
            for future in done:
                yield future.result()
                submit_next(executor)


def run_song_tasks(songs, worker, concurrency=1, delay_ms=0):
    return list(iter_song_task_results(songs, worker, concurrency, delay_ms))


def print_status(args):
    media_root = resolve_media_root(args)
    output = resolve_output_path(args, media_root)
    state_path = resolve_state_path(args, output)
    history = read_history(output)
    summary = summarize_history(history)
    db_summary = query_cover_summary(args)
    print(json.dumps({"database": db_summary, "history": summary, "output": str(output)}, ensure_ascii=False, sort_keys=True))
    if state_path.exists():
        print(state_path.read_text(encoding="utf-8").strip())


def decide_song_action(
    song,
    history,
    cover_root,
    public_base_url,
    retry_failed=False,
    retry_not_found=False,
    force=False,
):
    song_id = song["id"]
    desired_url = public_cover_url(public_base_url, song_id)
    existing_url = clean(song.get("coverImageUrl"))
    local_path = cover_file_path(cover_root, song_id)

    if local_path.exists() and not force:
        if existing_url == desired_url:
            return SongActionDecision("skip", public_url=desired_url, reason="local-cover-ready")
        return SongActionDecision("repair", public_url=desired_url, reason="local-cover-db-url-mismatch")

    latest = history.get(song_id) or {}
    latest_status = latest.get("status")
    if not force:
        if latest_status == "failed" and not retry_failed:
            return SongActionDecision("skip", reason="previously-failed")
        if latest_status == "not_found" and not retry_not_found:
            return SongActionDecision("skip", reason="previously-not-found")

    external_url = existing_url if looks_like_external_image_url(existing_url, desired_url) else None
    return SongActionDecision("fetch", public_url=desired_url, external_url=external_url)


def cover_file_path(cover_root, song_id):
    safe_song_id = safe_file_song_id(song_id)
    return Path(cover_root) / "nas" / f"{safe_song_id}.jpg"


def public_cover_url(public_base_url, song_id):
    safe_song_id = safe_file_song_id(song_id)
    prefix = clean(public_base_url).rstrip("/")
    if not prefix:
        raise ValueError("PUBLIC_BASE_URL or --public-base-url is required for local cover URLs")
    return f"{prefix}/media/covers/nas/{urllib.parse.quote(safe_song_id)}.jpg"


def safe_file_song_id(song_id):
    value = clean(song_id)
    if not SAFE_SONG_ID.match(value):
        raise ValueError(f"Unsafe song id for cover path: {song_id}")
    return value


def looks_like_external_image_url(url, desired_url):
    return (url.startswith("http://") or url.startswith("https://")) and url != desired_url


def find_cover(song, providers, search_limit, timeout_ms, image_size):
    last_error = None
    for provider in providers:
        try:
            candidates = search_provider(provider, song, search_limit, timeout_ms)
            match = select_best_cover_candidate(song, candidates)
            if not match:
                continue
            image_url = resolve_provider_image_url(provider, match, image_size, timeout_ms)
            if not image_url:
                continue
            return {**match, "imageUrl": image_url}
        except Exception as error:
            last_error = error
            continue
    if last_error:
        raise last_error
    return None


def search_provider(provider, song, search_limit, timeout_ms):
    if provider == "tencent":
        return search_tencent(song, search_limit, timeout_ms)
    if provider == "kugou":
        return search_kugou(song, search_limit, timeout_ms)
    if provider == "kuwo":
        return search_kuwo(song, search_limit, timeout_ms)
    raise ValueError(f"Unsupported provider: {provider}")


def search_tencent(song, search_limit, timeout_ms):
    payload = fetch_json(
        "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
        {
            "format": "json",
            "p": 1,
            "n": search_limit,
            "w": f"{song['artistName']} {song['title']}",
            "aggr": 1,
            "lossless": 1,
            "cr": 1,
            "new_json": 1,
        },
        headers={"Referer": "http://y.qq.com"},
        timeout_ms=timeout_ms,
    )
    rows = (((payload or {}).get("data") or {}).get("song") or {}).get("list") or []
    candidates = []
    for row in rows:
        album = row.get("album") or {}
        singers = row.get("singer") or []
        candidates.append(
            {
                "provider": "tencent",
                "providerSongId": clean(row.get("mid")),
                "title": strip_html(clean(row.get("name"))),
                "artistNames": [clean(item.get("name")) for item in singers if clean(item.get("name"))],
                "albumName": strip_html(clean(album.get("title"))),
                "picId": clean(album.get("mid")),
            }
        )
    return candidates


def search_kugou(song, search_limit, timeout_ms):
    payload = fetch_json(
        "http://mobilecdn.kugou.com/api/v3/search/song",
        {
            "api_ver": 1,
            "area_code": 1,
            "correct": 1,
            "pagesize": search_limit,
            "plat": 2,
            "tag": 1,
            "sver": 5,
            "showtype": 10,
            "page": 1,
            "keyword": f"{song['artistName']} {song['title']}",
            "version": 8990,
        },
        headers={"User-Agent": "IPhone-8990-searchSong"},
        timeout_ms=timeout_ms,
    )
    rows = ((payload or {}).get("data") or {}).get("info") or []
    candidates = []
    for row in rows:
        file_name = clean(row.get("filename") or row.get("fileName"))
        title = clean(row.get("songName")) or parse_kugou_title(file_name)
        artists = []
        if isinstance(row.get("authors"), list):
            artists = [clean(item.get("author_name")) for item in row["authors"] if clean(item.get("author_name"))]
        if not artists:
            artists = parse_kugou_artists(file_name)
        candidates.append(
            {
                "provider": "kugou",
                "providerSongId": clean(row.get("hash")),
                "title": strip_html(title),
                "artistNames": artists,
                "albumName": strip_html(clean(row.get("album_name"))),
                "picId": clean(row.get("hash")),
            }
        )
    return candidates


def search_kuwo(song, search_limit, timeout_ms):
    payload = fetch_json(
        "http://www.kuwo.cn/api/www/search/searchMusicBykeyWord",
        {
            "key": f"{song['artistName']} {song['title']}",
            "pn": 1,
            "rn": search_limit,
            "httpsStatus": 1,
        },
        headers=kuwo_headers(),
        timeout_ms=timeout_ms,
    )
    rows = ((payload or {}).get("data") or {}).get("list") or []
    candidates = []
    for row in rows:
        rid = clean(row.get("rid"))
        candidates.append(
            {
                "provider": "kuwo",
                "providerSongId": rid,
                "title": strip_html(clean(row.get("name"))),
                "artistNames": [strip_html(name) for name in clean(row.get("artist")).split("&") if clean(name)],
                "albumName": strip_html(clean(row.get("album"))),
                "picId": rid,
            }
        )
    return candidates


def resolve_provider_image_url(provider, candidate, image_size, timeout_ms):
    pic_id = clean(candidate.get("picId"))
    if not pic_id:
        return ""
    if provider == "tencent":
        return f"https://y.gtimg.cn/music/photo_new/T002R{image_size}x{image_size}M000{pic_id}.jpg?max_age=2592000"
    if provider == "kugou":
        payload = fetch_json(
            "http://m.kugou.com/app/i/getSongInfo.php",
            {"cmd": "playInfo", "hash": pic_id, "from": "mkugou"},
            headers={"User-Agent": "IPhone-8990-searchSong"},
            timeout_ms=timeout_ms,
        )
        return clean((payload or {}).get("imgUrl")).replace("{size}", "400")
    if provider == "kuwo":
        payload = fetch_json(
            "http://www.kuwo.cn/api/www/music/musicInfo",
            {"mid": pic_id, "httpsStatus": 1},
            headers=kuwo_headers(),
            timeout_ms=timeout_ms,
        )
        data = (payload or {}).get("data") or {}
        return clean(data.get("pic") or data.get("albumpic"))
    return ""


def select_best_cover_candidate(song, candidates):
    scored = []
    for candidate in candidates:
        confidence = score_cover_candidate(song, candidate)
        if confidence >= 75:
            scored.append(({**candidate, "confidence": confidence}))
    scored.sort(key=lambda item: (-item["confidence"], item.get("title") or ""))
    return scored[0] if scored else None


def score_cover_candidate(song, candidate):
    title_score = score_title(song["title"], candidate.get("title") or "")
    if title_score == 0:
        return 0
    artist_score = score_artist(song["artistName"], candidate.get("artistNames") or [])
    if artist_score == 0:
        return 0
    variant_penalty = 18 if looks_like_variant(candidate) and not looks_like_variant(song) else 0
    missing_image_penalty = 0 if clean(candidate.get("picId") or candidate.get("imageUrl")) else 50
    return max(0, min(100, title_score + artist_score - variant_penalty - missing_image_penalty))


def score_title(target_title, candidate_title):
    target = normalize_title(target_title)
    candidate = normalize_title(candidate_title)
    if not target or not candidate:
        return 0
    if target == candidate:
        return 60
    if candidate.startswith(target) or target.startswith(candidate):
        return 46
    if target in candidate or candidate in target:
        return 38
    return 0


def score_artist(target_artist_name, candidate_artist_names):
    target_artists = split_artist_names(target_artist_name)
    candidates = []
    for value in candidate_artist_names:
        candidates.extend(split_artist_names(value))
    if not target_artists or not candidates:
        return 0
    for target in target_artists:
        if target in candidates:
            return 40
    for target in target_artists:
        if any(target in candidate or candidate in target for candidate in candidates):
            return 28
    return 0


def normalize_title(value):
    normalized = normalize_base(value)
    normalized = re.sub(r"[（(【[].*?[）)】\]]", "", normalized)
    normalized = re.sub(r"(完整版|正式版|原版|原唱版|高清版|ktv版)$", "", normalized, flags=re.IGNORECASE)
    return normalized


def normalize_artist(value):
    return re.sub(r"(原唱|歌手)$", "", normalize_base(value))


def normalize_base(value):
    return (
        html.unescape(clean(value))
        .lower()
        .replace("周杰伦.-", "周杰伦")
        .translate(str.maketrans("", "", "·.．-_/:：'\"“”‘’!?！？ \t\r\n"))
        .strip()
    )


def split_artist_names(value):
    return [normalize_artist(part) for part in re.split(r"[/／,，、&＆+＋|｜;；\s]+", clean(value)) if normalize_artist(part)]


def looks_like_variant(value):
    return re.search(r"(dj|live|remix|伴奏|纯音乐|翻唱|现场|演唱会|串烧|片段|抖音)", f"{value.get('title', '')} {value.get('albumName', '')}", re.I) is not None


def parse_kugou_title(file_name):
    parts = file_name.split(" - ", 1)
    return parts[1] if len(parts) == 2 else file_name


def parse_kugou_artists(file_name):
    parts = file_name.split(" - ", 1)
    return [part.strip() for part in parts[0].split("、") if part.strip()] if len(parts) == 2 else []


def download_image(url, destination, timeout_ms):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 HomeKTVCoverFetcher/0.1",
            "Accept": "image/jpeg,image/png,image/webp,image/gif,*/*;q=0.8",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
        data = response.read(MAX_IMAGE_BYTES + 1)
        content_type = response.headers.get("content-type", "")
    if len(data) > MAX_IMAGE_BYTES:
        raise RuntimeError("cover image is too large")
    if not is_supported_image(data, content_type):
        raise RuntimeError(f"downloaded cover is not a supported image: {content_type}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp_file:
        temp_file.write(data)
        temp_path = Path(temp_file.name)
    temp_path.replace(destination)


def is_supported_image(data, _content_type):
    return (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"RIFF") and data[8:12] == b"WEBP"
        or data.startswith(b"GIF87a")
        or data.startswith(b"GIF89a")
    )


def fetch_json(url, params, headers=None, timeout_ms=8000):
    query = urllib.parse.urlencode(params)
    separator = "&" if "?" in url else "?"
    request = urllib.request.Request(
        f"{url}{separator}{query}",
        headers={
            "User-Agent": "Mozilla/5.0 HomeKTVCoverFetcher/0.1",
            "Accept": "application/json,text/plain,*/*",
            **(headers or {}),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from error
    return json.loads(text)


def kuwo_headers():
    return {
        "Cookie": "kw_token=3E7JFQ7MRPL",
        "csrf": "3E7JFQ7MRPL",
        "Host": "www.kuwo.cn",
        "Referer": "http://www.kuwo.cn/",
    }


def select_candidate_songs(args, random_order=False):
    limit_sql = "" if args.limit == 0 else f"LIMIT {int(args.limit)}"
    order_sql = "ORDER BY random()" if random_order else "ORDER BY cover_updated_at ASC NULLS FIRST, updated_at DESC, id ASC"
    sql = f"""
SELECT json_build_object(
  'id', id,
  'title', title,
  'artistName', primary_artist_name,
  'coverImageUrl', cover_image_url
)::text
FROM ktv_songs
WHERE missing_at IS NULL
  AND trim(title) <> ''
  AND trim(primary_artist_name) <> ''
{order_sql}
{limit_sql}
""".strip()
    return [json.loads(line) for line in run_psql_lines(sql, args)]


def query_cover_summary(args):
    sql = """
SELECT json_build_object(
  'activeSongs', count(*),
  'withCoverUrl', count(*) FILTER (WHERE cover_image_url IS NOT NULL),
  'withoutCoverUrl', count(*) FILTER (WHERE cover_image_url IS NULL),
  'processed', count(*) FILTER (WHERE cover_updated_at IS NOT NULL)
)::text
FROM ktv_songs
WHERE missing_at IS NULL
""".strip()
    lines = run_psql_lines(sql, args)
    return json.loads(lines[0]) if lines else {}


def update_cover_url(args, song_id, cover_url):
    sql = f"""
UPDATE ktv_songs
SET cover_image_url = {sql_literal(cover_url)},
    cover_updated_at = now(),
    updated_at = now()
WHERE id = {sql_literal(song_id)}
""".strip()
    run_psql_script(sql, args)


def touch_cover_processed(args, song_id):
    sql = f"""
UPDATE ktv_songs
SET cover_updated_at = now(),
    updated_at = now()
WHERE id = {sql_literal(song_id)}
  AND cover_image_url IS NULL
""".strip()
    run_psql_script(sql, args)


def run_psql_lines(sql, args):
    result = run_psql(["-At", "-c", sql], args, capture=True)
    return [line for line in result.stdout.splitlines() if line.strip()]


def run_psql_script(sql, args):
    run_psql(["-v", "ON_ERROR_STOP=1", "-f", "-"], args, capture=False, input_text=sql)


def run_psql(psql_args, args, capture, input_text=None):
    command = build_psql_command(args) + psql_args
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(stderr or f"psql failed with code {result.returncode}")
    return result


def build_psql_command(args):
    container = clean(args.postgres_container) or detect_postgres_container()
    if container:
        return ["docker", "exec", "-i", container, "psql", "-U", args.db_user, "-d", args.db_name]
    if shutil.which("psql"):
        return ["psql", resolve_database_url(args)]
    raise RuntimeError("psql is not installed and no Postgres container was found; pass --postgres-container")


def detect_postgres_container():
    if shutil.which("docker") is None:
        return ""
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    names = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    for name in ("home-ktv-postgres-1", "home-ktv-postgres"):
        if name in names:
            return name
    for name in names:
        if "home-ktv" in name and "postgres" in name:
            return name
    return ""


def resolve_database_url(args):
    database_url = clean(args.database_url) or clean(os.environ.get("DATABASE_URL"))
    if not database_url:
        raise RuntimeError("DATABASE_URL or --database-url is required")
    return database_url


def resolve_media_root(args):
    value = clean(args.media_root) or clean(os.environ.get("MEDIA_ROOT")) or clean(os.environ.get("DOCKER_MEDIA_ROOT"))
    return resolve_path(value or str(ROOT_DIR / "runtime" / "media"))


def resolve_cover_root(args, media_root):
    value = clean(args.cover_root)
    return resolve_path(value) if value else Path(media_root) / "covers"


def resolve_output_path(args, media_root):
    if clean(args.output):
        return resolve_path(args.output)
    job_root = clean(os.environ.get("KTV_COVER_JOB_ROOT"))
    root = resolve_path(job_root) if job_root else Path(media_root) / "covers" / "_jobs"
    return root / "song-covers.jsonl"


def resolve_state_path(args, output):
    if clean(args.state):
        return resolve_path(args.state)
    return Path(f"{output}.state.json")


def resolve_public_base_url(args):
    return clean(args.public_base_url) or clean(os.environ.get("PUBLIC_BASE_URL"))


def read_history(path):
    history = {}
    path = Path(path)
    if not path.exists():
        return history
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        song_id = clean(row.get("songId"))
        if song_id:
            history[song_id] = row
    return history


def summarize_history(history):
    summary = {}
    for row in history.values():
        status = clean(row.get("status")) or "unknown"
        summary[status] = summary.get(status, 0) + 1
    return summary


def append_jsonl(path, row):
    ensure_parent(path)
    with Path(path).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def write_state(path, payload):
    ensure_parent(path)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def load_env_file(path):
    env_path = Path(path)
    if not env_path.exists() and str(path).endswith("deploy/source/.env"):
        env_path = ROOT_DIR / "deploy" / "docker" / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def ensure_parent(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def resolve_path(value):
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT_DIR / path


def read_provider_list(value):
    providers = [item.strip() for item in clean(value).split(",") if item.strip()]
    for provider in providers:
        if provider not in DEFAULT_PROVIDERS:
            raise ValueError(f"Unsupported provider: {provider}")
    return providers or list(DEFAULT_PROVIDERS)


def sql_literal(value):
    return "'" + clean(value).replace("'", "''") + "'"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clean(value):
    return "" if value is None else str(value).strip()


def strip_html(value):
    return re.sub(r"<[^>]+>", "", html.unescape(clean(value))).strip()


def positive_int(value):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def non_negative_int(value):
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


if __name__ == "__main__":
    main()
