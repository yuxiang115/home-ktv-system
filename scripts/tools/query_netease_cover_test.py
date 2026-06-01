#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("query_netease_cover.py")
SPEC = importlib.util.spec_from_file_location("query_netease_cover", SCRIPT_PATH)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


class QueryNeteaseCoverTest(unittest.TestCase):
    def test_parse_cloudsearch_candidates_extracts_cover(self):
        payload = {
            "result": {
                "songs": [
                    {
                        "id": 77469,
                        "name": "冲动的惩罚",
                        "ar": [{"name": "刀郎"}],
                        "al": {
                            "name": "披着羊皮的狼",
                            "picUrl": "http://p1.music.126.net/example.jpg",
                        },
                    }
                ]
            }
        }

        candidates = module.parse_cloudsearch_candidates(payload)

        self.assertEqual(candidates[0]["provider"], "netease")
        self.assertEqual(candidates[0]["providerSongId"], "77469")
        self.assertEqual(candidates[0]["artistNames"], ["刀郎"])
        self.assertEqual(candidates[0]["coverImageUrl"], "http://p1.music.126.net/example.jpg")

    def test_select_best_candidate_prefers_title_and_artist_match(self):
        candidates = [
            {
                "providerSongId": "1",
                "title": "冲动的惩罚",
                "artistNames": ["其他歌手"],
                "albumName": "",
                "coverImageUrl": "http://example.com/other.jpg",
            },
            {
                "providerSongId": "2",
                "title": "冲动的惩罚",
                "artistNames": ["刀郎"],
                "albumName": "",
                "coverImageUrl": "http://example.com/dao.jpg",
            },
        ]

        best = module.select_best_candidate("冲动的惩罚", "刀郎", candidates)

        self.assertEqual(best["providerSongId"], "2")
        self.assertEqual(best["confidence"], 100)

    def test_build_url_encodes_chinese_query(self):
        url = module.build_url("http://127.0.0.1:4300/", "/cloudsearch", {"keywords": "刀郎 冲动的惩罚"})

        self.assertEqual(url, "http://127.0.0.1:4300/cloudsearch?keywords=%E5%88%80%E9%83%8E+%E5%86%B2%E5%8A%A8%E7%9A%84%E6%83%A9%E7%BD%9A")


if __name__ == "__main__":
    unittest.main()
