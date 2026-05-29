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

        self.assertEqual(result, {"1": ["华语", "流行"]})

    def test_sql_literal_escapes_single_quotes(self):
        self.assertEqual(runner.sql_literal("A'B"), "'A''B'")


if __name__ == "__main__":
    unittest.main()
