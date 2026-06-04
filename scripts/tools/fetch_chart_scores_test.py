#!/usr/bin/env python3
import importlib.util
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "tools" / "fetch_chart_scores.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fetch_chart_scores", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FetchChartScoresTest(unittest.TestCase):
    def test_collect_defaults_include_all_platforms_and_10_points(self):
        charts = load_module()

        args = charts.parse_args(["collect"])

        self.assertEqual(args.command, "collect")
        self.assertEqual(args.platforms, "netease,qq,kugou,kuwo,migu")
        self.assertEqual(args.per_source_points, 10)
        self.assertEqual(args.concurrency, 10)
        self.assertEqual(args.max_kugou_pages, 50)

    def test_normalized_song_key_merges_common_noise(self):
        charts = load_module()

        first = charts.build_song_identity("夜曲 (Live版)", "周杰伦")
        second = charts.build_song_identity(" 夜曲 ", "周杰伦 ")
        third = charts.build_song_identity("夜曲（DJ版）", "周杰伦")

        self.assertEqual(first, second)
        self.assertEqual(second, third)

    def test_aggregate_rows_adds_10_per_distinct_chart_and_dedupes_within_chart(self):
        charts = load_module()

        rows = [
            charts.ChartRow(platform="qq", chart_id="qq-hot", chart_name="QQ热歌榜", title="夜曲", artist_name="周杰伦"),
            charts.ChartRow(platform="qq", chart_id="qq-hot", chart_name="QQ热歌榜", title="夜曲 (Live)", artist_name="周杰伦"),
            charts.ChartRow(platform="kugou", chart_id="kg-top", chart_name="酷狗TOP500", title="夜曲", artist_name="周杰伦"),
            charts.ChartRow(platform="kuwo", chart_id="kw-hot", chart_name="酷我热歌榜", title="夜曲", artist_name="周杰伦"),
            charts.ChartRow(platform="migu", chart_id="mg-hot", chart_name="咪咕热歌榜", title="晴天", artist_name="周杰伦"),
        ]

        aggregated = charts.aggregate_chart_rows(rows, per_source_points=10)

        self.assertEqual(len(aggregated), 2)
        top = aggregated[0]
        self.assertEqual(top.title, "夜曲")
        self.assertEqual(top.artist_name, "周杰伦")
        self.assertEqual(top.score, 30)
        self.assertEqual(top.appearances, 3)
        self.assertEqual(set(top.platforms), {"qq", "kugou", "kuwo"})

    def test_parse_netease_toplist_response(self):
        charts = load_module()

        data = {
            "list": [
                {"id": 3778678, "name": "热歌榜", "tracks": [{"first": "周杰伦", "second": "夜曲"}]},
                {"id": 19723756, "name": "飙升榜", "tracks": [{"first": "林俊杰", "second": "江南"}]},
            ]
        }

        sources = charts.parse_netease_chart_sources(data)

        self.assertEqual(
            [(source.chart_id, source.chart_name) for source in sources],
            [("3778678", "热歌榜"), ("19723756", "飙升榜")],
        )

    def test_parse_qq_chart_sources_from_initial_data_html(self):
        charts = load_module()

        html = """
        <script>
        window.__INITIAL_DATA__ = {
          "topNavData": [
            {"groupName": "巅峰榜", "toplist": [
              {"topId": 62, "title": "飙升榜"},
              {"topId": 26, "title": "热歌榜"}
            ]},
            {"groupName": "特色榜", "toplist": [
              {"topId": 36, "title": "K歌金曲榜"}
            ]}
          ]
        }
        </script>
        """

        sources = charts.parse_qq_chart_sources_from_html(html)

        self.assertEqual(
            [(source.chart_id, source.chart_name, source.group_name) for source in sources],
            [("62", "飙升榜", "巅峰榜"), ("26", "热歌榜", "巅峰榜"), ("36", "K歌金曲榜", "特色榜")],
        )

    def test_parse_qq_chart_rows_from_json(self):
        charts = load_module()

        data = {
            "songlist": [
                {"data": {"songname": "夜曲", "singer": [{"name": "周杰伦"}]}},
                {"data": {"songname": "江南", "singer": [{"name": "林俊杰"}]}},
            ]
        }

        rows = charts.parse_qq_chart_rows("26", "热歌榜", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_parse_kugou_chart_sources_from_html(self):
        charts = load_module()

        html = """
        <ul>
          <li><a title="酷狗飙升榜" href="https://www.kugou.com/yy/rank/home/1-6666.html?from=rank">酷狗飙升榜</a></li>
          <li><a title="酷狗TOP500" href="https://www.kugou.com/yy/rank/home/1-8888.html?from=rank">酷狗TOP500</a></li>
        </ul>
        """

        sources = charts.parse_kugou_chart_sources_from_html(html)

        self.assertEqual(
            [(source.chart_id, source.chart_name) for source in sources],
            [("6666", "酷狗飙升榜"), ("8888", "酷狗TOP500")],
        )

    def test_parse_kugou_chart_rows_from_html(self):
        charts = load_module()

        html = """
        <ul class="pc_temp_songlist">
          <li><span class="pc_temp_num">1</span><span class="pc_temp_songname" title="周杰伦 - 夜曲"></span></li>
          <li><span class="pc_temp_num">2</span><span class="pc_temp_songname" title="林俊杰 - 江南"></span></li>
        </ul>
        """

        rows = charts.parse_kugou_chart_rows("6666", "酷狗飙升榜", html)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_parse_kuwo_chart_sources_from_html(self):
        charts = load_module()

        html = """
        <ul class="chartbang">
          <li class="chart_li" onclick="jumpPage('/newh5/bang/content?bid=93&pic=foo');"><h3>酷我飙升榜</h3></li>
          <li class="chart_li" onclick="jumpPage('/newh5/bang/content?bid=16&pic=bar');"><h3>酷我热歌榜</h3></li>
        </ul>
        """

        sources = charts.parse_kuwo_chart_sources_from_html(html)

        self.assertEqual(
            [(source.chart_id, source.chart_name) for source in sources],
            [("93", "酷我飙升榜"), ("16", "酷我热歌榜")],
        )

    def test_parse_kuwo_chart_rows_from_html(self):
        charts = load_module()

        html = """
        <li class="singBox">
          <div class="singTexUp2"><p>夜曲</p></div>
          <p class="singName">周杰伦-夜曲</p>
        </li>
        <li class="singBox">
          <div class="singTexUp2"><p>江南</p></div>
          <p class="singName">林俊杰-江南</p>
        </li>
        """

        rows = charts.parse_kuwo_chart_rows("93", "酷我飙升榜", html)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_build_migu_headers(self):
        charts = load_module()

        headers = charts.build_migu_headers()

        self.assertEqual(headers["channel"], "014000D")
        self.assertEqual(headers["appId"], "music")
        self.assertEqual(headers["platform"], "H5")
        self.assertIn("logId", headers)

    def test_parse_migu_chart_sources_from_json(self):
        charts = load_module()

        data = {
            "data": {
                "contents": [
                    {
                        "contents": [
                            {"rankId": "27186466", "rankName": "咪咕新歌榜"},
                            {"rankId": "27553319", "rankName": "咪咕热歌榜"},
                        ]
                    }
                ]
            }
        }

        sources = charts.parse_migu_chart_sources(data)

        self.assertEqual(
            [(source.chart_id, source.chart_name) for source in sources],
            [("27186466", "咪咕新歌榜"), ("27553319", "咪咕热歌榜")],
        )

    def test_parse_migu_chart_rows_from_json(self):
        charts = load_module()

        data = {
            "data": {
                "contents": [
                    {"txt": "夜曲", "txt2": "周杰伦"},
                    {"txt": "江南", "txt2": "林俊杰"},
                ]
            }
        }

        rows = charts.parse_migu_chart_rows("27186466", "咪咕新歌榜", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_collect_chart_sources_in_parallel_honors_concurrency_limit(self):
        charts = load_module()

        sources = [
            charts.ChartSource(platform="qq", chart_id=f"id-{index}", chart_name=f"榜单-{index}")
            for index in range(6)
        ]
        lock = threading.Lock()
        active = 0
        max_active = 0

        def fake_fetch(source):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with lock:
                active -= 1
            return {"rows": [], "report": charts.build_source_report(source, "ok", 0)}

        results = charts.collect_chart_sources_in_parallel(sources, 3, fake_fetch)

        self.assertEqual(len(results), 6)
        self.assertEqual(max_active, 3)


if __name__ == "__main__":
    unittest.main()
