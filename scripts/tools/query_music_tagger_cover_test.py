#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("query_music_tagger_cover.py")
SPEC = importlib.util.spec_from_file_location("query_music_tagger_cover", SCRIPT_PATH)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


class QueryMusicTaggerCoverTest(unittest.TestCase):
    def test_select_best_candidate_uses_title_artist_and_cover(self):
        candidates = [
            {
                "provider": "cloud",
                "providerSongId": "1",
                "title": "夜之光",
                "artistNames": ["其他歌手"],
                "albumName": "夜之光",
                "coverImageUrl": "http://example.com/other.jpg",
            },
            {
                "provider": "kugou",
                "providerSongId": "2",
                "title": "夜之光",
                "artistNames": ["花姐"],
                "albumName": "夜之光",
                "coverImageUrl": "http://example.com/hua.jpg",
            },
        ]

        best = module.select_best_candidate("夜之光", "花姐", candidates)

        self.assertEqual(best["providerSongId"], "2")
        self.assertEqual(best["confidence"], 100)

    def test_search_cloud_extracts_cover_from_detail(self):
        calls = []

        def fake_fetch_json(url, params, method="GET", headers=None, timeout_ms=8000):
            calls.append((url, params, method))
            if "search/get/web" in url:
                return {
                    "result": {
                        "songs": [
                            {
                                "id": 77469,
                                "name": "冲动的惩罚",
                                "artists": [{"name": "刀郎"}],
                            }
                        ]
                    }
                }
            return {
                "songs": [
                    {
                        "id": 77469,
                        "name": "冲动的惩罚",
                        "artists": [{"name": "刀郎"}],
                        "album": {
                            "name": "2002年的第一场雪",
                            "picUrl": "http://p1.music.126.net/example.jpg",
                        },
                    }
                ]
            }

        original_fetch_json = module.fetch_json
        module.fetch_json = fake_fetch_json
        try:
            candidates = module.search_cloud("冲动的惩罚", "刀郎", limit=3, timeout_ms=5000)
        finally:
            module.fetch_json = original_fetch_json

        self.assertEqual(calls[0][2], "POST")
        self.assertEqual(candidates[0]["provider"], "cloud")
        self.assertEqual(candidates[0]["providerSongId"], "77469")
        self.assertEqual(candidates[0]["coverImageUrl"], "http://p1.music.126.net/example.jpg")

    def test_search_kugou_extracts_hash_and_normalizes_cover_url(self):
        calls = []

        def fake_fetch_json(url, params, method="GET", headers=None, timeout_ms=8000):
            calls.append((url, params))
            if "search/song" in url:
                return {
                    "data": {
                        "info": [
                            {
                                "hash": "abc123",
                                "filename": "花姐 - 夜之光",
                                "singername": "花姐",
                                "songname": "夜之光",
                            }
                        ]
                    }
                }
            return {
                "songName": "夜之光",
                "author_name": "花姐",
                "album_name": "夜之光",
                "album_img": "http://imge.kugou.com/stdmusic/{size}/cover.jpg",
            }

        original_fetch_json = module.fetch_json
        module.fetch_json = fake_fetch_json
        try:
            candidates = module.search_kugou("夜之光", "花姐", limit=3, timeout_ms=5000)
        finally:
            module.fetch_json = original_fetch_json

        self.assertEqual(calls[1][1]["hash"], "abc123")
        self.assertEqual(candidates[0]["provider"], "kugou")
        self.assertEqual(candidates[0]["coverImageUrl"], "http://imge.kugou.com/stdmusic/cover.jpg")

    def test_is_supported_image_checks_magic_bytes(self):
        self.assertTrue(module.is_supported_image(b"\xff\xd8\xff\xe0fake"))
        self.assertFalse(module.is_supported_image(b"<html>not image</html>", "image/jpeg"))


if __name__ == "__main__":
    unittest.main()
