#!/usr/bin/env python3
import importlib.util
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "fetch_hot_song_candidates.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fetch_hot_song_candidates", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FetchHotSongCandidatesTest(unittest.TestCase):
    def test_collect_defaults_include_python_parallel_entry(self):
        hot = load_module()

        args = hot.parse_args(["collect"])

        self.assertEqual(args.command, "collect")
        self.assertEqual(args.concurrency, 10)
        self.assertEqual(args.timeout_ms, 10000)
        self.assertTrue(str(args.manifest).endswith("packages/hot-songs/config/sources.example.json"))

    def test_select_sources_filters_disabled_and_requested(self):
        hot = load_module()

        manifest = {
            "sources": [
                {"id": "qq-hot", "enabled": True},
                {"id": "kg-top", "enabled": False},
                {"id": "kw-rank"},
            ]
        }

        selected_all = hot.select_sources(manifest, [])
        selected_one = hot.select_sources(manifest, ["kw-rank"])

        self.assertEqual([item["id"] for item in selected_all], ["qq-hot", "kw-rank"])
        self.assertEqual([item["id"] for item in selected_one], ["kw-rank"])

    def test_merge_partial_outputs_builds_source_report_shape(self):
        hot = load_module()

        rows_payload, report_payload = hot.merge_partial_outputs(
            [
                {
                    "rows": [{"sourceId": "qq-hot", "rawTitle": "夜曲"}],
                    "statuses": [{"sourceId": "qq-hot", "status": "succeeded", "usable": True}],
                },
                {
                    "rows": [],
                    "statuses": [{"sourceId": "kg-top", "status": "failed", "usable": False}],
                },
            ]
        )

        self.assertEqual(rows_payload["schemaVersion"], "hot-songs.source-rows.v1")
        self.assertEqual(len(rows_payload["rows"]), 1)
        self.assertEqual(report_payload["schemaVersion"], "hot-songs.source-report.v1")
        self.assertEqual(report_payload["usableSourceCount"], 1)
        self.assertEqual(report_payload["statusCounts"]["succeeded"], 1)
        self.assertEqual(report_payload["statusCounts"]["failed"], 1)
        self.assertTrue(str(rows_payload["generatedAt"]).endswith("Z"))
        self.assertTrue(str(report_payload["generatedAt"]).endswith("Z"))

    def test_collect_sources_in_parallel_honors_concurrency_limit(self):
        hot = load_module()

        sources = [{"id": f"source-{index}"} for index in range(6)]
        lock = threading.Lock()
        active = 0
        max_active = 0

        def fake_collect_one_source(**kwargs):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with lock:
                active -= 1
            return {"sourceId": kwargs["source"]["id"], "rows": [], "statuses": []}

        original = hot.collect_one_source
        hot.collect_one_source = fake_collect_one_source
        try:
            results = hot.collect_sources_in_parallel(
                sources=sources,
                manifest_path=Path("/tmp/manifest.json"),
                partial_dir=Path("/tmp/partials"),
                concurrency=3,
                timeout_ms=1000,
                fixture=False,
            )
        finally:
            hot.collect_one_source = original

        self.assertEqual(len(results), 6)
        self.assertEqual(max_active, 3)


if __name__ == "__main__":
    unittest.main()
