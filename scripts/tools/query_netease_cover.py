#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:4300"


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    result = query_cover(
        title=args.title,
        artist=args.artist,
        base_url=args.base_url,
        limit=args.limit,
        timeout_ms=args.timeout_ms,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result.get("best"):
        raise SystemExit(2)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Query NeteaseCloudMusicApi for a song cover URL.")
    parser.add_argument("title", help="Song title.")
    parser.add_argument("artist", nargs="?", default="", help="Artist name.")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("NETEASE_CLOUD_MUSIC_API_BASE_URL", DEFAULT_BASE_URL),
        help=f"NeteaseCloudMusicApi base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument("--limit", type=positive_int, default=8)
    parser.add_argument("--timeout-ms", type=positive_int, default=8000)
    return parser.parse_args(argv)


def query_cover(title, artist="", base_url=DEFAULT_BASE_URL, limit=8, timeout_ms=8000):
    keywords = " ".join([item for item in [clean(artist), clean(title)] if item])
    search_payload = fetch_json(
        build_url(
            base_url,
            "/cloudsearch",
            {
                "keywords": keywords,
                "type": "1",
                "limit": str(limit),
            },
        ),
        timeout_ms=timeout_ms,
    )
    candidates = parse_cloudsearch_candidates(search_payload)
    best = select_best_candidate(title, artist, candidates)
    if best and not best.get("coverImageUrl"):
        detail = fetch_song_detail(base_url, best["providerSongId"], timeout_ms)
        if detail.get("coverImageUrl"):
            best = {**best, "coverImageUrl": detail["coverImageUrl"], "detail": detail}

    return {
        "query": {
            "title": clean(title),
            "artist": clean(artist),
            "keywords": keywords,
            "baseUrl": trim_trailing_slash(base_url),
            "limit": limit,
        },
        "best": best,
        "candidates": candidates,
    }


def fetch_song_detail(base_url, song_id, timeout_ms):
    payload = fetch_json(
        build_url(base_url, "/song/detail", {"ids": str(song_id)}),
        timeout_ms=timeout_ms,
    )
    songs = payload.get("songs") if isinstance(payload, dict) else None
    if not isinstance(songs, list) or not songs:
        return {}
    return parse_song_row(songs[0])


def parse_cloudsearch_candidates(payload):
    result = payload.get("result") if isinstance(payload, dict) else None
    rows = result.get("songs") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        return []
    return [parse_song_row(row) for row in rows if isinstance(row, dict)]


def parse_song_row(row):
    album = row.get("al") if isinstance(row.get("al"), dict) else {}
    artists = row.get("ar") if isinstance(row.get("ar"), list) else []
    return {
        "provider": "netease",
        "providerSongId": str(row.get("id") or ""),
        "title": clean(row.get("name")),
        "artistNames": [clean(artist.get("name")) for artist in artists if isinstance(artist, dict) and clean(artist.get("name"))],
        "albumName": clean(album.get("name")),
        "coverImageUrl": clean(album.get("picUrl")),
    }


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
    target_title = normalize_title(title)
    candidate_title = normalize_title(candidate.get("title"))
    if not target_title or not candidate_title:
        return 0

    if target_title == candidate_title:
        score = 70
    elif target_title in candidate_title or candidate_title in target_title:
        score = 55
    else:
        return 0

    target_artist = normalize_name(artist)
    candidate_artists = [normalize_name(value) for value in candidate.get("artistNames", [])]
    if not target_artist:
        score += 15
    elif target_artist in candidate_artists:
        score += 30
    elif any(target_artist in value or value in target_artist for value in candidate_artists if value):
        score += 22

    if candidate.get("coverImageUrl"):
        score += 5
    return min(score, 100)


def fetch_json(url, timeout_ms=8000):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "HomeKTV-cover-probe/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def build_url(base_url, path, query):
    return f"{trim_trailing_slash(base_url)}{path}?{urllib.parse.urlencode(query)}"


def normalize_title(value):
    value = normalize_name(value)
    value = re.sub(r"(dj|live|remix|伴奏|纯音乐|翻唱|现场|演唱会|片段)$", "", value, flags=re.I)
    return value


def normalize_name(value):
    value = clean(value).lower()
    value = re.sub(r"[（(].*?[）)]", "", value)
    return re.sub(r"[\s·・,，。.!！?？:：;；'\"“”‘’《》<>/\\|\-_]+", "", value)


def trim_trailing_slash(value):
    return clean(value).rstrip("/")


def clean(value):
    return "" if value is None else str(value).strip()


def positive_int(value):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


if __name__ == "__main__":
    main()
