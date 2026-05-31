#!/usr/bin/env python3
import importlib.util
import json
import tempfile
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
