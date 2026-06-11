#!/usr/bin/env python3
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "generate_cover_thumbnails.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_cover_thumbnails", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GenerateCoverThumbnailsTest(unittest.TestCase):
    def test_generate_defaults_to_160px_and_20_workers(self):
        thumbs = load_module()

        args = thumbs.parse_args(["generate"])

        self.assertEqual(args.size, 160)
        self.assertEqual(args.concurrency, 20)
        self.assertEqual(args.quality, 82)

    def test_plans_only_missing_or_stale_thumbnails_by_default(self):
        thumbs = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            source_root = Path(temp_dir) / "covers" / "nas"
            output_root = source_root / "thumbs"
            source_root.mkdir(parents=True)
            output_root.mkdir()
            (source_root / "song-1.jpg").write_bytes(b"source")
            (output_root / "song-1.jpg").write_bytes(b"thumb")

            self.assertEqual(thumbs.plan_thumbnail_jobs(source_root, output_root, overwrite=False), [])
            self.assertEqual([job.song_id for job in thumbs.plan_thumbnail_jobs(source_root, output_root, overwrite=True)], ["song-1"])

    def test_generates_fixed_size_jpeg_thumbnail(self):
        try:
            from PIL import Image, ImageOps
        except ImportError:
            self.skipTest("Pillow is not installed")

        thumbs = load_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            source_root = Path(temp_dir) / "covers" / "nas"
            output_root = source_root / "thumbs"
            source_root.mkdir(parents=True)
            source_path = source_root / "song-1.jpg"
            output_path = output_root / "song-1.jpg"
            Image.new("RGB", (320, 180), (255, 0, 0)).save(source_path)

            result = thumbs.generate_one_thumbnail(
                Image=Image,
                ImageOps=ImageOps,
                job=thumbs.ThumbnailJob("song-1", source_path, output_path),
                size=160,
                quality=82,
                overwrite=False,
            )

            self.assertEqual(result["status"], "generated")
            with Image.open(output_path) as image:
                self.assertEqual(image.size, (160, 160))
                self.assertEqual(image.format, "JPEG")


if __name__ == "__main__":
    unittest.main()
