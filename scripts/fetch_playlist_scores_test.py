#!/usr/bin/env python3
import importlib.util
import threading
import time
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "fetch_playlist_scores.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fetch_playlist_scores", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FetchPlaylistScoresTest(unittest.TestCase):
    def test_collect_defaults_cover_keyword_and_direct_modes(self):
        playlists = load_module()

        args = playlists.parse_args(["collect"])

        self.assertEqual(args.command, "collect")
        self.assertEqual(args.keyword_platforms, "netease,kuwo")
        self.assertEqual(args.direct_platforms, "netease,qq,kugou,kuwo")
        self.assertEqual(args.search_limit_per_keyword, 10)
        self.assertEqual(args.concurrency, 10)
        self.assertIsNone(args.fetch_concurrency)
        self.assertEqual(args.per_source_points, 10)

    def test_read_non_empty_lines_from_file(self):
        playlists = load_module()

        with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False) as handle:
            handle.write("周杰伦\n\n 林俊杰 \n")
            path = handle.name

        try:
            values = playlists.read_non_empty_lines(Path(path))
        finally:
            Path(path).unlink(missing_ok=True)

        self.assertEqual(values, ["周杰伦", "林俊杰"])

    def test_parse_netease_playlist_url(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference(
            "https://music.163.com/#/playlist?id=123456",
            default_platform="netease",
        )

        self.assertEqual(ref.platform, "netease")
        self.assertEqual(ref.playlist_id, "123456")

    def test_parse_qq_playlist_url(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference(
            "https://y.qq.com/n/ryqq/playlist/987654321",
            default_platform="qq",
        )

        self.assertEqual(ref.platform, "qq")
        self.assertEqual(ref.playlist_id, "987654321")

    def test_parse_kugou_playlist_url(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference(
            "https://www.kugou.com/songlist/777777/",
            default_platform="kugou",
        )

        self.assertEqual(ref.platform, "kugou")
        self.assertEqual(ref.playlist_id, "777777")

    def test_parse_kugou_special_single_playlist_url(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference(
            "https://www.kugou.com/yy/special/single/4184876.html",
            default_platform="kugou",
        )

        self.assertEqual(ref.platform, "kugou")
        self.assertEqual(ref.playlist_id, "4184876")

    def test_parse_kuwo_playlist_url(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference(
            "https://www.kuwo.cn/playlist_detail/2867496601",
            default_platform="kuwo",
        )

        self.assertEqual(ref.platform, "kuwo")
        self.assertEqual(ref.playlist_id, "2867496601")

    def test_parse_platform_prefixed_reference(self):
        playlists = load_module()

        ref = playlists.parse_playlist_reference("qq:12345")

        self.assertEqual(ref.platform, "qq")
        self.assertEqual(ref.playlist_id, "12345")

    def test_normalized_song_key_merges_common_noise(self):
        playlists = load_module()

        first = playlists.build_song_identity("夜曲 (Live版)", "周杰伦")
        second = playlists.build_song_identity(" 夜曲 ", "周杰伦 ")
        third = playlists.build_song_identity("夜曲（DJ版）", "周杰伦")

        self.assertEqual(first, second)
        self.assertEqual(second, third)

    def test_aggregate_rows_adds_10_per_distinct_playlist(self):
        playlists = load_module()

        rows = [
            playlists.PlaylistRow(
                platform="netease",
                playlist_id="1001",
                playlist_name="周杰伦热门",
                keyword="周杰伦",
                title="夜曲",
                artist_name="周杰伦",
            ),
            playlists.PlaylistRow(
                platform="netease",
                playlist_id="1001",
                playlist_name="周杰伦热门",
                keyword="周杰伦",
                title="夜曲 (Live版)",
                artist_name="周杰伦",
            ),
            playlists.PlaylistRow(
                platform="kuwo",
                playlist_id="2002",
                playlist_name="KTV必点",
                keyword="周杰伦",
                title="夜曲",
                artist_name="周杰伦",
            ),
            playlists.PlaylistRow(
                platform="qq",
                playlist_id="3003",
                playlist_name="华语金曲",
                keyword="",
                title="晴天",
                artist_name="周杰伦",
            ),
        ]

        aggregated = playlists.aggregate_playlist_rows(rows, per_source_points=10)

        self.assertEqual(len(aggregated), 2)
        top = aggregated[0]
        self.assertEqual(top.title, "夜曲")
        self.assertEqual(top.artist_name, "周杰伦")
        self.assertEqual(top.score, 20)
        self.assertEqual(top.appearances, 2)
        self.assertEqual(set(top.platforms), {"netease", "kuwo"})

    def test_apply_playlist_name_to_rows(self):
        playlists = load_module()

        rows = [
            playlists.PlaylistRow(
                platform="netease",
                playlist_id="1001",
                playlist_name="",
                keyword="周杰伦",
                title="夜曲",
                artist_name="周杰伦",
            )
        ]

        updated = playlists.apply_playlist_name(rows, "周杰伦热门")

        self.assertEqual(updated[0].playlist_name, "周杰伦热门")

    def test_collect_sources_in_parallel_honors_concurrency_limit(self):
        playlists = load_module()

        sources = [
            playlists.PlaylistSource(platform="netease", playlist_id=f"id-{index}", playlist_name="", keyword="KTV")
            for index in range(6)
        ]
        lock = threading.Lock()
        active = 0
        max_active = 0

        def fake_fetch(source, **kwargs):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with lock:
                active -= 1
            return (
                [
                    playlists.PlaylistRow(
                        platform=source.platform,
                        playlist_id=source.playlist_id,
                        playlist_name="测试歌单",
                        keyword=source.keyword,
                        title="夜曲",
                        artist_name="周杰伦",
                    )
                ],
                playlists.build_source_report(source, "ok", 1),
            )

        rows, reports = playlists.collect_playlist_sources_in_parallel(
            sources=sources,
            fetcher=fake_fetch,
            fetch_concurrency=3,
        )

        self.assertEqual(len(rows), 6)
        self.assertEqual(len(reports), 6)
        self.assertEqual(max_active, 3)

    def test_parse_netease_playlist_search_results(self):
        playlists = load_module()

        data = {
            "result": {
                "playlists": [
                    {"id": 1, "name": "周杰伦热门歌曲", "creator": {"nickname": "A"}},
                    {"id": 2, "name": "林俊杰KTV精选", "creator": {"nickname": "B"}},
                ]
            }
        }

        sources = playlists.parse_netease_playlist_search_results("周杰伦", data)

        self.assertEqual(
            [(source.platform, source.playlist_id, source.playlist_name, source.keyword) for source in sources],
            [("netease", "1", "周杰伦热门歌曲", "周杰伦"), ("netease", "2", "林俊杰KTV精选", "周杰伦")],
        )

    def test_parse_netease_playlist_tracks(self):
        playlists = load_module()

        data = {
            "songs": [
                {"name": "夜曲", "ar": [{"name": "周杰伦"}]},
                {"name": "江南", "ar": [{"name": "林俊杰"}]},
            ]
        }

        rows = playlists.parse_netease_playlist_tracks("1001", "周杰伦热门", "周杰伦", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_parse_kuwo_playlist_search_results(self):
        playlists = load_module()

        data = {
            "data": {
                "list": [
                    {"id": "2867496601", "name": "终于等到周杰伦"},
                    {"id": "2867496602", "name": "周董情歌精选"},
                ]
            }
        }

        sources = playlists.parse_kuwo_playlist_search_results("周杰伦", data)

        self.assertEqual(
            [(source.platform, source.playlist_id, source.playlist_name, source.keyword) for source in sources],
            [("kuwo", "2867496601", "终于等到周杰伦", "周杰伦"), ("kuwo", "2867496602", "周董情歌精选", "周杰伦")],
        )

    def test_parse_kuwo_playlist_tracks(self):
        playlists = load_module()

        data = {
            "data": {
                "musicList": [
                    {"name": "夜曲", "artist": "周杰伦"},
                    {"name": "搁浅", "artist": "周杰伦"},
                ]
            }
        }

        rows = playlists.parse_kuwo_playlist_tracks("2867496601", "周董情歌精选", "周杰伦", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("搁浅", "周杰伦")])

    def test_parse_qq_playlist_tracks(self):
        playlists = load_module()

        data = {
            "cdlist": [
                {
                    "songlist": [
                        {"songname": "夜曲", "singer": [{"name": "周杰伦"}]},
                        {"songname": "江南", "singer": [{"name": "林俊杰"}]},
                    ]
                }
            ]
        }

        rows = playlists.parse_qq_playlist_tracks("12345", "QQ华语金曲", "", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])

    def test_parse_qq_playlist_tracks_from_nested_data_cdlist(self):
        playlists = load_module()

        data = {
            "data": {
                "cdlist": [
                    {
                        "songlist": [
                            {"songname": "晴天", "singer": [{"name": "周杰伦"}]},
                            {"songname": "修炼爱情", "singer": [{"name": "林俊杰"}]},
                        ]
                    }
                ]
            }
        }

        rows = playlists.parse_qq_playlist_tracks("12345", "QQ华语金曲", "", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("晴天", "周杰伦"), ("修炼爱情", "林俊杰")])

    def test_parse_kugou_playlist_tracks(self):
        playlists = load_module()

        data = {
            "data": {
                "info": [
                    {"name": "周杰伦 - 夜曲", "hash": "abc"},
                    {"name": "林俊杰 - 江南", "hash": "def"},
                ]
            }
        }

        rows = playlists.parse_kugou_playlist_tracks("777777", "酷狗KTV精选", "", data)

        self.assertEqual([(row.title, row.artist_name) for row in rows], [("夜曲", "周杰伦"), ("江南", "林俊杰")])


if __name__ == "__main__":
    unittest.main()
