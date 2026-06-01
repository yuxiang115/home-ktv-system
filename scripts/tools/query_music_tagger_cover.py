#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_PROVIDERS = ["cloud", "kugou"]
MAX_IMAGE_BYTES = 5 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 HomeKTV-MusicTagger-cover-probe/1.0"


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    result = query_cover(
        title=args.title,
        artist=args.artist,
        providers=read_provider_list(args.providers),
        limit=args.limit,
        timeout_ms=args.timeout_ms,
    )
    if args.download and result.get("best", {}).get("coverImageUrl"):
        download_image(result["best"]["coverImageUrl"], Path(args.download), args.timeout_ms)
        result["downloadedTo"] = str(Path(args.download))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result.get("best"):
        raise SystemExit(2)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Probe song cover URLs using API logic extracted from MusicTagger.")
    parser.add_argument("title", help="Song title.")
    parser.add_argument("artist", nargs="?", default="", help="Artist name.")
    parser.add_argument("--providers", default=",".join(DEFAULT_PROVIDERS), help="Provider order: cloud,kugou.")
    parser.add_argument("--limit", type=positive_int, default=8)
    parser.add_argument("--timeout-ms", type=positive_int, default=8000)
    parser.add_argument("--download", default="", help="Optional image output path. The script otherwise only prints URLs.")
    return parser.parse_args(argv)


def query_cover(title, artist="", providers=None, limit=8, timeout_ms=8000):
    providers = providers or list(DEFAULT_PROVIDERS)
    all_candidates = []
    provider_errors = {}
    for provider in providers:
        try:
            candidates = search_provider(provider, title, artist, limit, timeout_ms)
            all_candidates.extend(candidates)
        except Exception as error:
            provider_errors[provider] = str(error)[:300]

    best = select_best_candidate(title, artist, all_candidates)
    return {
        "query": {
            "title": clean(title),
            "artist": clean(artist),
            "providers": providers,
            "limit": limit,
        },
        "best": best,
        "candidates": all_candidates,
        "providerErrors": provider_errors,
    }


def search_provider(provider, title, artist, limit, timeout_ms):
    if provider == "cloud":
        return search_cloud(title, artist, limit, timeout_ms)
    if provider == "kugou":
        return search_kugou(title, artist, limit, timeout_ms)
    raise ValueError(f"Unsupported provider: {provider}")


def search_cloud(title, artist, limit, timeout_ms):
    keyword = sanitize_keyword(" ".join([item for item in [clean(artist), clean(title)] if item]))
    payload = fetch_json(
        "https://music.163.com/api/search/get/web",
        {
            "s": keyword,
            "type": "1",
            "offset": "0",
            "total": "true",
            "limit": str(limit),
        },
        method="POST",
        timeout_ms=timeout_ms,
    )
    result = payload.get("result") if isinstance(payload, dict) else None
    rows = result.get("songs") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        return []

    candidates = []
    for row in rows:
        song_id = clean(row.get("id"))
        detail = fetch_cloud_detail(song_id, timeout_ms) if song_id else {}
        album = detail.get("album") if isinstance(detail.get("album"), dict) else row.get("album") or {}
        artists = detail.get("artists") if isinstance(detail.get("artists"), list) else row.get("artists") or []
        candidates.append(
            {
                "provider": "cloud",
                "providerSongId": song_id,
                "title": clean(detail.get("name") or row.get("name")),
                "artistNames": [clean(item.get("name")) for item in artists if isinstance(item, dict) and clean(item.get("name"))],
                "albumName": clean(album.get("name")),
                "coverImageUrl": clean(album.get("picUrl")),
            }
        )
    return candidates


def fetch_cloud_detail(song_id, timeout_ms):
    payload = fetch_json(
        "http://music.163.com/api/song/detail/",
        {
            "id": str(song_id),
            "ids": f"[{song_id}]",
        },
        method="POST",
        timeout_ms=timeout_ms,
    )
    songs = payload.get("songs") if isinstance(payload, dict) else None
    return songs[0] if isinstance(songs, list) and songs else {}


def search_kugou(title, artist, limit, timeout_ms):
    keyword = sanitize_keyword(" ".join([item for item in [clean(artist), clean(title)] if item]))
    payload = fetch_json(
        "http://mobilecdn.kugou.com/api/v3/search/song",
        {
            "format": "json",
            "keyword": keyword,
            "page": "1",
            "pagesize": str(limit),
            "showtype": "1",
        },
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:7.0a1) Gecko/20110623 Firefox/7.0a1 Fennec/7.0a1"},
        timeout_ms=timeout_ms,
    )
    rows = ((payload or {}).get("data") or {}).get("info") or []
    candidates = []
    for row in rows:
        song_hash = clean(row.get("hash"))
        info = fetch_kugou_detail(song_hash, timeout_ms) if song_hash else {}
        title_value = clean(info.get("songName")) or clean(row.get("songname")) or parse_kugou_title(clean(row.get("filename")))
        artist_value = clean(info.get("author_name")) or clean(row.get("singername")) or parse_kugou_artist(clean(row.get("filename")))
        album_image = clean(info.get("album_img")).replace("/{size}/", "/")
        candidates.append(
            {
                "provider": "kugou",
                "providerSongId": song_hash,
                "title": title_value,
                "artistNames": split_raw_artist_names(artist_value),
                "albumName": clean(info.get("album_name") or row.get("album_name")),
                "coverImageUrl": album_image,
            }
        )
    return candidates


def fetch_kugou_detail(song_hash, timeout_ms):
    return fetch_json(
        "http://m.kugou.com/app/i/getSongInfo.php",
        {
            "cmd": "playInfo",
            "hash": song_hash,
        },
        timeout_ms=timeout_ms,
    )


def select_best_candidate(title, artist, candidates):
    scored = []
    for index, candidate in enumerate(candidates):
        confidence = score_candidate(title, artist, candidate)
        if confidence >= 70:
            scored.append({**candidate, "confidence": confidence, "_resultRank": index})
    scored.sort(key=lambda item: (-item["confidence"], item["_resultRank"]))
    for item in scored:
        item.pop("_resultRank", None)
    return scored[0] if scored else None


def score_candidate(title, artist, candidate):
    title_score = score_title(title, candidate.get("title"))
    if title_score == 0:
        return 0
    artist_score = score_artist(artist, candidate.get("artistNames") or [])
    if artist_score == 0:
        return 0
    variant_penalty = 18 if looks_like_variant(candidate) else 0
    image_bonus = 5 if candidate.get("coverImageUrl") else 0
    return min(100, max(0, title_score + artist_score + image_bonus - variant_penalty))


def score_title(target_title, candidate_title):
    target = normalize_title(target_title)
    candidate = normalize_title(candidate_title)
    if not target or not candidate:
        return 0
    if target == candidate:
        return 60
    if target in candidate or candidate in target:
        return 46
    return 0


def score_artist(target_artist_name, candidate_artist_names):
    targets = split_artist_names(target_artist_name)
    candidates = []
    for value in candidate_artist_names:
        candidates.extend(split_artist_names(value))
    if not targets or not candidates:
        return 0
    if any(target in candidates for target in targets):
        return 35
    if any(target in candidate or candidate in target for target in targets for candidate in candidates):
        return 25
    return 0


def fetch_json(url, params, method="GET", headers=None, timeout_ms=8000):
    query = urllib.parse.urlencode(params)
    full_url = f"{url}?{query}"
    data = b"" if method.upper() == "POST" else None
    request = urllib.request.Request(
        full_url,
        data=data,
        headers={
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": USER_AGENT,
            **(headers or {}),
        },
        method=method.upper(),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from error
    return json.loads(text)


def download_image(url, destination, timeout_ms):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "image/jpeg,image/png,image/webp,image/gif,*/*;q=0.8",
            "User-Agent": USER_AGENT,
        },
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


def is_supported_image(data, _content_type=""):
    return (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"RIFF") and data[8:12] == b"WEBP"
        or data.startswith(b"GIF87a")
        or data.startswith(b"GIF89a")
    )


def parse_kugou_title(file_name):
    parts = file_name.split(" - ", 1)
    return parts[1] if len(parts) == 2 else file_name


def parse_kugou_artist(file_name):
    parts = file_name.split(" - ", 1)
    return parts[0] if len(parts) == 2 else ""


def read_provider_list(value):
    providers = [item.strip() for item in clean(value).split(",") if item.strip()]
    for provider in providers:
        if provider not in DEFAULT_PROVIDERS:
            raise ValueError(f"Unsupported provider: {provider}")
    return providers or list(DEFAULT_PROVIDERS)


def sanitize_keyword(value):
    return re.sub(r"[!@#$%^&*/]+", "", clean(value))


def normalize_title(value):
    value = normalize_base(value)
    value = re.sub(r"[（(【[].*?[）)】\]]", "", value)
    value = re.sub(r"(dj|live|remix|伴奏|纯音乐|翻唱|现场|演唱会|片段)$", "", value, flags=re.I)
    return value


def normalize_artist(value):
    return re.sub(r"(原唱|歌手)$", "", normalize_base(value))


def normalize_base(value):
    return re.sub(r"[\s·・,，。.!！?？:：;；'\"“”‘’《》<>/\\|\-_]+", "", clean(value).lower())


def split_raw_artist_names(value):
    return [part.strip() for part in re.split(r"[/／,，、&＆+＋|｜;；]+", clean(value)) if part.strip()]


def split_artist_names(value):
    return [normalize_artist(part) for part in re.split(r"[/／,，、&＆+＋|｜;；\s]+", clean(value)) if normalize_artist(part)]


def looks_like_variant(value):
    return re.search(r"(dj|live|remix|伴奏|纯音乐|翻唱|现场|演唱会|串烧|片段|抖音)", f"{value.get('title', '')} {value.get('albumName', '')}", re.I) is not None


def clean(value):
    return "" if value is None else str(value).strip()


def positive_int(value):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


if __name__ == "__main__":
    main()
