#!/usr/bin/env python3
import csv
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "tools" / "delete_uncovered_songs.py"


def load_module():
    spec = importlib.util.spec_from_file_location("delete_uncovered_songs", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DeleteUncoveredSongsTest(unittest.TestCase):
    def test_parse_defaults_for_apply(self):
        deleter = load_module()

        args = deleter.parse_args(["apply", "--input", "delete.csv"])

        self.assertEqual(args.command, "apply")
        self.assertEqual(args.db_ssh_host, "dev")
        self.assertEqual(args.db_container, "home-ktv-postgres-1")
        self.assertEqual(args.cover_ssh_host, "dev")
        self.assertEqual(args.media_ssh_host, "pve")
        self.assertEqual(args.media_source_prefix, "/mnt/nas")
        self.assertEqual(args.media_target_prefix, "/hdd-pool/nas")

    def test_load_rows_and_plan_summary(self):
        deleter = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "delete.csv"
            with csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(
                    ["id", "title", "primary_artist_name", "artist_names", "cover_image_url", "file_path", "size_bytes"]
                )
                writer.writerow(
                    [
                        "song-1",
                        "夜曲",
                        "周杰伦",
                        "周杰伦",
                        "https://ktv.example.com/media/covers/nas/song-1.jpg",
                        "/mnt/nas/KTV歌曲/周杰伦-夜曲.mkv",
                        "1024",
                    ]
                )
                writer.writerow(["song-2", "晴天", "周杰伦", "周杰伦", "", "", "2048"])

            rows = deleter.load_delete_rows(csv_path)
            summary = deleter.build_plan_summary(rows)

            self.assertEqual(len(rows), 2)
            self.assertEqual(summary["songs"], 2)
            self.assertEqual(summary["coverFilesRequested"], 1)
            self.assertEqual(summary["mediaFilesRequested"], 1)
            self.assertEqual(summary["totalSizeBytes"], 3072)

    def test_translate_media_path_to_pve_root(self):
        deleter = load_module()

        translated = deleter.translate_media_path(
            "/mnt/nas/KTV歌曲/流行/周杰伦-夜曲.mkv",
            "/mnt/nas",
            "/hdd-pool/nas",
        )

        self.assertEqual(translated, "/hdd-pool/nas/KTV歌曲/流行/周杰伦-夜曲.mkv")

    def test_cover_remote_path_uses_safe_song_id(self):
        deleter = load_module()

        cover_path = deleter.cover_remote_path("/opt/home-ktv-system/runtime/media/covers/nas", "song-123")

        self.assertEqual(cover_path, "/opt/home-ktv-system/runtime/media/covers/nas/song-123.jpg")

    def test_build_delete_sql_uses_temp_table_and_copy(self):
        deleter = load_module()

        sql = deleter.build_delete_sql(["song-1", "song-2"])

        self.assertIn("CREATE TEMP TABLE delete_song_ids", sql)
        self.assertIn("COPY delete_song_ids (id) FROM STDIN;", sql)
        self.assertIn("song-1\nsong-2", sql)
        self.assertIn("DELETE FROM queue_entries", sql)
        self.assertIn("DELETE FROM ktv_songs", sql)

    def test_run_plan_writes_json_report(self):
        deleter = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "delete.csv"
            csv_path.write_text(
                "id,title,primary_artist_name,artist_names,cover_image_url,file_path,size_bytes\n"
                "song-1,夜曲,周杰伦,周杰伦,,/mnt/nas/KTV歌曲/周杰伦-夜曲.mkv,1024\n",
                encoding="utf-8",
            )
            report_path = Path(temp_dir) / "plan.json"
            args = deleter.parse_args(["plan", "--input", str(csv_path), "--output", str(report_path)])

            exit_code = deleter.run_plan(args)

            self.assertEqual(exit_code, 0)
            self.assertTrue(report_path.exists())
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["songs"], 1)
            self.assertEqual(report["mediaFilesRequested"], 1)


if __name__ == "__main__":
    unittest.main()
