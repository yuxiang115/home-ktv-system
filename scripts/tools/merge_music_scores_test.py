#!/usr/bin/env python3
import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "tools" / "merge_music_scores.py"


def load_module():
    spec = importlib.util.spec_from_file_location("merge_music_scores", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class MergeMusicScoresTest(unittest.TestCase):
    def test_merge_defaults(self):
        merged = load_module()

        args = merged.parse_args(["merge"])

        self.assertEqual(args.command, "merge")
        self.assertEqual(args.hot_input, "")
        self.assertEqual(args.chart_input, "")
        self.assertEqual(args.playlist_input, "")
        self.assertEqual(args.output, "")

    def test_resolve_input_csv_from_directory(self):
        merged = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hot_dir = root / "hot"
            hot_dir.mkdir()
            (hot_dir / "ranked-songs.csv").write_text("rank,title,artist,score\n", encoding="utf-8")

            chart_dir = root / "chart"
            chart_dir.mkdir()
            (chart_dir / "aggregated-songs.csv").write_text("score,title,artist_name\n", encoding="utf-8")

            self.assertEqual(
                merged.resolve_input_csv_path(str(hot_dir), "hot"),
                (hot_dir / "ranked-songs.csv").resolve(),
            )
            self.assertEqual(
                merged.resolve_input_csv_path(str(chart_dir), "chart"),
                (chart_dir / "aggregated-songs.csv").resolve(),
            )

    def test_normalized_song_key_merges_common_noise(self):
        merged = load_module()

        first = merged.build_song_identity("夜曲 (Live版)", "周杰伦")
        second = merged.build_song_identity(" 夜曲 ", "周杰伦 ")
        third = merged.build_song_identity("夜曲（DJ版）", "周杰伦")

        self.assertEqual(first, second)
        self.assertEqual(second, third)

    def test_merge_rows_sums_three_source_scores(self):
        merged = load_module()

        hot_rows = [{"title": "夜曲", "artist_name": "周杰伦", "score": 80}]
        chart_rows = [{"title": "夜曲 (Live版)", "artist_name": "周杰伦", "score": 30}]
        playlist_rows = [
            {"title": "夜曲", "artist_name": "周杰伦", "score": 20},
            {"title": "晴天", "artist_name": "周杰伦", "score": 10},
        ]

        songs = merged.merge_score_rows(hot_rows=hot_rows, chart_rows=chart_rows, playlist_rows=playlist_rows)

        self.assertEqual(len(songs), 2)
        top = songs[0]
        self.assertEqual(top.title, "夜曲")
        self.assertEqual(top.artist_name, "周杰伦")
        self.assertEqual(top.hot_score, 80)
        self.assertEqual(top.chart_score, 30)
        self.assertEqual(top.playlist_score, 20)
        self.assertEqual(top.score, 130)

    def test_duplicate_rows_inside_single_source_accumulate_component_score(self):
        merged = load_module()

        songs = merged.merge_score_rows(
            hot_rows=[],
            chart_rows=[
                {"title": "夜曲", "artist_name": "周杰伦", "score": 10},
                {"title": "夜曲 (Live)", "artist_name": "周杰伦", "score": 20},
            ],
            playlist_rows=[],
        )

        self.assertEqual(len(songs), 1)
        self.assertEqual(songs[0].chart_score, 30)
        self.assertEqual(songs[0].score, 30)

    def test_run_merge_writes_csv_and_report(self):
        merged = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            hot_csv = root / "ranked-songs.csv"
            chart_csv = root / "chart.csv"
            playlist_csv = root / "playlist.csv"
            output_dir = root / "out"

            hot_csv.write_text("rank,title,artist,score\n1,夜曲,周杰伦,80\n", encoding="utf-8")
            chart_csv.write_text("score,appearances,title,artist_name\n30,3,夜曲,周杰伦\n", encoding="utf-8")
            playlist_csv.write_text("score,appearances,title,artist_name\n20,2,晴天,周杰伦\n", encoding="utf-8")

            args = merged.parse_args(
                [
                    "merge",
                    "--hot-input",
                    str(hot_csv),
                    "--chart-input",
                    str(chart_csv),
                    "--playlist-input",
                    str(playlist_csv),
                    "--output",
                    str(output_dir),
                ]
            )

            exit_code = merged.run_merge(args)

            self.assertEqual(exit_code, 0)
            merged_csv = output_dir / "merged-songs.csv"
            report_json = output_dir / "merge-report.json"
            self.assertTrue(merged_csv.exists())
            self.assertTrue(report_json.exists())

            with merged_csv.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["title"], "夜曲")
            self.assertIn("artist_name", rows[0])
            self.assertIn("score", rows[0])

            report = json.loads(report_json.read_text(encoding="utf-8"))
            self.assertEqual(report["mergedSongs"], 2)
            self.assertEqual(report["inputs"]["hot"]["rows"], 1)


if __name__ == "__main__":
    unittest.main()
