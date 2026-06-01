#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "tools" / "fetch_song_covers.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fetch_song_covers", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FetchSongCoversTest(unittest.TestCase):
    def test_builds_stable_local_path_and_public_url(self):
        covers = load_module()

        self.assertEqual(
            covers.cover_file_path(Path("/data/home-ktv-media/covers"), "song-123"),
            Path("/data/home-ktv-media/covers/nas/song-123.jpg"),
        )
        self.assertEqual(
            covers.public_cover_url("https://ktv.example.com/", "song-123"),
            "https://ktv.example.com/media/covers/nas/song-123.jpg",
        )

    def test_public_url_requires_public_base_url(self):
        covers = load_module()

        with self.assertRaisesRegex(ValueError, "PUBLIC_BASE_URL"):
            covers.public_cover_url("", "song-123")

    def test_coverage_defaults_to_a_bounded_sample(self):
        covers = load_module()

        self.assertEqual(covers.parse_args(["fetch"]).limit, 0)
        self.assertEqual(covers.parse_args(["coverage"]).limit, 100)
        self.assertIn("netease", covers.parse_args(["coverage"]).providers.split(","))

    def test_fetch_and_coverage_accept_concurrency(self):
        covers = load_module()

        self.assertEqual(covers.parse_args(["fetch", "--concurrency", "4"]).concurrency, 4)
        self.assertEqual(covers.parse_args(["coverage", "--concurrency", "3"]).concurrency, 3)

    def test_runs_song_tasks_concurrently(self):
        covers = load_module()
        active = 0
        max_active = 0
        lock = threading.Lock()

        def worker(song):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return {"songId": song["id"]}

        results = covers.run_song_tasks([{"id": str(index)} for index in range(6)], worker, concurrency=3)

        self.assertEqual({result["songId"] for result in results}, {"0", "1", "2", "3", "4", "5"})
        self.assertGreater(max_active, 1)

    def test_accepts_pnpm_argument_separator(self):
        covers = load_module()

        self.assertEqual(covers.parse_args(["coverage", "--", "--limit", "5"]).limit, 5)

    def test_image_validation_uses_bytes_not_only_content_type(self):
        covers = load_module()

        self.assertTrue(covers.is_supported_image(b"\xff\xd8\xff\xe0fake-jpeg", ""))
        self.assertFalse(covers.is_supported_image(b"<html>not an image</html>", "image/jpeg"))

    def test_repairs_database_when_local_file_already_exists(self):
        covers = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            cover_root = Path(temp_dir) / "covers"
            cover_path = covers.cover_file_path(cover_root, "song-1")
            cover_path.parent.mkdir(parents=True)
            cover_path.write_bytes(b"\xff\xd8\xff\xe0fake-jpeg")

            decision = covers.decide_song_action(
                {
                    "id": "song-1",
                    "coverImageUrl": None,
                    "title": "晴天",
                    "artistName": "周杰伦",
                },
                history={},
                cover_root=cover_root,
                public_base_url="https://ktv.example.com",
                retry_failed=False,
                retry_not_found=False,
                force=False,
            )

        self.assertEqual(decision.action, "repair")
        self.assertEqual(decision.public_url, "https://ktv.example.com/media/covers/nas/song-1.jpg")

    def test_skips_previous_failures_until_retry_is_requested(self):
        covers = load_module()
        song = {
            "id": "song-2",
            "coverImageUrl": None,
            "title": "夜曲",
            "artistName": "周杰伦",
        }

        skipped = covers.decide_song_action(
            song,
            history={"song-2": {"status": "failed"}},
            cover_root=Path("/tmp/covers"),
            public_base_url="https://ktv.example.com",
            retry_failed=False,
            retry_not_found=False,
            force=False,
        )
        retried = covers.decide_song_action(
            song,
            history={"song-2": {"status": "failed"}},
            cover_root=Path("/tmp/covers"),
            public_base_url="https://ktv.example.com",
            retry_failed=True,
            retry_not_found=False,
            force=False,
        )

        self.assertEqual(skipped.action, "skip")
        self.assertEqual(retried.action, "fetch")

    def test_cover_matching_penalizes_unwanted_variants(self):
        covers = load_module()
        match = covers.select_best_cover_candidate(
            {"title": "晴天", "artistName": "周杰伦"},
            [
                {
                    "provider": "tencent",
                    "providerSongId": "dj",
                    "title": "晴天 DJ版",
                    "artistNames": ["周杰伦"],
                    "albumName": "DJ Remix",
                    "imageUrl": "https://example.com/dj.jpg",
                },
                {
                    "provider": "tencent",
                    "providerSongId": "original",
                    "title": "晴天",
                    "artistNames": ["周杰伦"],
                    "albumName": "叶惠美",
                    "imageUrl": "https://example.com/original.jpg",
                },
            ],
        )

        self.assertIsNotNone(match)
        self.assertEqual(match["providerSongId"], "original")

    def test_search_netease_extracts_album_cover(self):
        covers = load_module()
        calls = []

        def fake_fetch_json(url, params, headers=None, timeout_ms=8000):
            calls.append((url, params, headers, timeout_ms))
            return {
                "result": {
                    "songs": [
                        {
                            "id": 77469,
                            "name": "冲动的惩罚",
                            "ar": [{"name": "刀郎"}],
                            "al": {
                                "name": "2002年的第一场雪",
                                "picUrl": "http://p1.music.126.net/example.jpg",
                            },
                        }
                    ]
                }
            }

        original_fetch_json = covers.fetch_json
        covers.fetch_json = fake_fetch_json
        try:
            candidates = covers.search_netease(
                {"title": "冲动的惩罚", "artistName": "刀郎"},
                search_limit=3,
                timeout_ms=5000,
                base_url="http://127.0.0.1:4300/",
            )
        finally:
            covers.fetch_json = original_fetch_json

        self.assertEqual(calls[0][0], "http://127.0.0.1:4300/cloudsearch")
        self.assertEqual(calls[0][1]["keywords"], "刀郎 冲动的惩罚")
        self.assertEqual(candidates[0]["provider"], "netease")
        self.assertEqual(candidates[0]["providerSongId"], "77469")
        self.assertEqual(candidates[0]["imageUrl"], "http://p1.music.126.net/example.jpg")

    def test_find_cover_ignores_failed_provider_when_another_provider_completed(self):
        covers = load_module()

        def fake_search_provider(provider, song, search_limit, timeout_ms, netease_base_url):
            if provider == "netease":
                raise RuntimeError("netease unavailable")
            return []

        original_search_provider = covers.search_provider
        covers.search_provider = fake_search_provider
        try:
            match = covers.find_cover(
                {"title": "晴天", "artistName": "周杰伦"},
                ["netease", "tencent"],
                search_limit=3,
                timeout_ms=5000,
                image_size=300,
                netease_base_url="http://127.0.0.1:4300",
            )
        finally:
            covers.search_provider = original_search_provider

        self.assertIsNone(match)

    def test_reads_latest_history_row_per_song(self):
        covers = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            history_path = Path(temp_dir) / "covers.jsonl"
            history_path.write_text(
                "\n".join(
                    [
                        json.dumps({"songId": "song-1", "status": "failed"}),
                        json.dumps({"songId": "song-1", "status": "found"}),
                        json.dumps({"songId": "song-2", "status": "not_found"}),
                    ]
                ),
                encoding="utf-8",
            )

            history = covers.read_history(history_path)

        self.assertEqual(history["song-1"]["status"], "found")
        self.assertEqual(history["song-2"]["status"], "not_found")


if __name__ == "__main__":
    unittest.main()
