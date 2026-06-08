import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("run_style_tagging_llm_batch.py")
SPEC = importlib.util.spec_from_file_location("run_style_tagging_llm_batch", SCRIPT_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class RunStyleTaggingLlmBatchTest(unittest.TestCase):
    def test_batch_prompt_uses_short_ids_instead_of_song_ids(self):
        songs = [
            {"id": "real-song-uuid-1", "title": "七里香", "primary_artist_name": "周杰伦"},
            {"id": "real-song-uuid-2", "title": "海阔天空", "primary_artist_name": "Beyond"},
        ]

        prompt_songs, prompt = runner.build_batch_prompt_songs_and_prompt(songs)

        self.assertEqual([song["id"] for song in prompt_songs], ["1", "2"])
        self.assertIn('"id":"1"', prompt)
        self.assertIn('"id":"2"', prompt)
        self.assertNotIn("real-song-uuid-1", prompt)
        self.assertNotIn("real-song-uuid-2", prompt)

    def test_batch_response_rejects_unknown_ids(self):
        prompt_songs = [
            {"id": "1", "title": "七里香", "artistName": "周杰伦"},
            {"id": "2", "title": "海阔天空", "artistName": "Beyond"},
        ]

        with self.assertRaisesRegex(ValueError, "unexpected result id"):
            runner.parse_batch_response('{"results":[{"id":"1","tags":["华语"]},{"id":"3","tags":["粤语"]}]}', prompt_songs)

    def test_batch_response_filters_to_allowed_unique_tags(self):
        prompt_songs = [{"id": "1", "title": "七里香", "artistName": "周杰伦"}]

        result = runner.parse_batch_response('{"results":[{"id":"1","tags":["华语","流行","不存在","华语"]}]}', prompt_songs)

        self.assertEqual(result, {"1": ["流行"]})

    def test_batch_response_rejects_removed_tags(self):
        prompt_songs = [{"id": "1", "title": "七里香", "artistName": "周杰伦"}]

        result = runner.parse_batch_response('{"results":[{"id":"1","tags":["国语","华语流行","内地","流行"]}]}', prompt_songs)

        self.assertEqual(result, {"1": ["流行"]})

    def test_batch_response_removes_language_region_tags(self):
        prompt_songs = [{"id": "1", "title": "喜欢你", "artistName": "Beyond"}]

        result = runner.parse_batch_response(
            '{"results":[{"id":"1","tags":["粤语","港台","港乐","摇滚"]}]}',
            prompt_songs,
        )

        self.assertEqual(result, {"1": ["摇滚"]})

    def test_batch_response_splits_legacy_slash_tags(self):
        prompt_songs = [{"id": "1", "title": "朋友", "artistName": "周华健"}]

        result = runner.parse_batch_response(
            '{"results":[{"id":"1","tags":["友情/兄弟","红歌/革命歌曲","现场/演唱会","动漫/ACG"]}]}',
            prompt_songs,
            max_tags=6,
        )

        self.assertEqual(result, {"1": ["友情", "兄弟", "红歌", "革命歌曲", "现场", "演唱会"]})

    def test_taxonomy_has_no_language_region_or_slash_tags(self):
        self.assertNotIn("语种地区", [group["name"] for group in runner.KTV_STYLE_TAXONOMY])
        self.assertFalse([tag for tag in runner.ALLOWED_TAGS if "/" in tag])

    def test_sql_literal_escapes_single_quotes(self):
        self.assertEqual(runner.sql_literal("A'B"), "'A''B'")

    def test_candidate_sql_uses_inline_style_tags(self):
        sql = runner.candidate_sql(max_existing_tags=1, limit=30)

        self.assertIn("cardinality(s.style_tags)::integer AS tag_count", sql)
        self.assertIn("WHERE s.missing_at IS NULL", sql)
        self.assertNotIn("ktv_song_style_tags", sql)
        self.assertNotIn("ktv_song_assets", sql)
        self.assertNotIn("st.tag_id", sql)
        self.assertNotIn("ktv_song_tagging_status", sql)

    def test_import_sql_writes_inline_style_tags(self):
        sql = runner.build_import_sql(
            [
                {"songId": "song-1", "status": "tagged", "tags": ["流行", "KTV必点"]},
                {"songId": "song-2", "status": "empty", "tags": []},
            ]
        )

        self.assertIn("UPDATE ktv_songs", sql)
        self.assertIn("style_tags = ARRAY['流行', 'KTV必点']::text[]", sql)
        self.assertNotIn("ktv_style_tags", sql)
        self.assertNotIn("ktv_style_groups", sql)
        self.assertNotIn("ktv_song_style_tags", sql)
        self.assertNotIn("ktv_song_tagging_status", sql)
        self.assertNotIn("ktv_song_tagging_runs", sql)


if __name__ == "__main__":
    unittest.main()
