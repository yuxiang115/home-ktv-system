import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts/tools/android_app_icon_pipeline.py"
class AndroidAppIconPipelineTest(unittest.TestCase):
    def test_exports_launcher_icons_and_tv_banner(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_res = Path(temp_dir)
            source = output_res / "generated-sheet.png"
            create_generated_sheet(source)
            archive = output_res / "archive/source.png"
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--source",
                    str(source),
                    "--candidate",
                    "1",
                    "--output-res",
                    str(output_res),
                    "--archive",
                    str(archive),
                    "--webp-quality",
                    "78",
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )

            expected = [
                output_res / "mipmap-mdpi/ic_launcher.webp",
                output_res / "mipmap-hdpi/ic_launcher.webp",
                output_res / "mipmap-xhdpi/ic_launcher.webp",
                output_res / "mipmap-xxhdpi/ic_launcher.webp",
                output_res / "mipmap-xxxhdpi/ic_launcher.webp",
                output_res / "drawable/app_icon_your_company.png",
                archive,
            ]
            for path in expected:
                self.assertTrue(path.exists(), f"{path} should exist")
                self.assertGreater(path.stat().st_size, 0)

            self.assert_image_size(output_res / "mipmap-mdpi/ic_launcher.webp", (48, 48))
            self.assert_image_size(output_res / "mipmap-xxxhdpi/ic_launcher.webp", (192, 192))
            self.assert_image_size(output_res / "drawable/app_icon_your_company.png", (432, 243))
            self.assert_image_size(archive, (1024, 1024))
            self.assert_transparent_corners(output_res / "mipmap-xxxhdpi/ic_launcher.webp")
            self.assert_transparent_corners(output_res / "drawable/app_icon_your_company.png")
            self.assert_transparent_corners(archive)

    def assert_image_size(self, path: Path, expected_size: tuple[int, int]) -> None:
        with Image.open(path) as image:
            self.assertEqual(image.size, expected_size)

    def assert_transparent_corners(self, path: Path) -> None:
        with Image.open(path) as image:
            rgba = image.convert("RGBA")
            corners = [
                rgba.getpixel((0, 0))[3],
                rgba.getpixel((rgba.width - 1, 0))[3],
                rgba.getpixel((0, rgba.height - 1))[3],
                rgba.getpixel((rgba.width - 1, rgba.height - 1))[3],
            ]
            self.assertEqual(corners, [0, 0, 0, 0])


def create_generated_sheet(path: Path) -> None:
    width = 1774
    height = 887
    sheet = Image.new("RGB", (width, height), (248, 250, 252))
    draw = ImageDraw.Draw(sheet)
    cell_width = width / 4
    icon_top = height * 0.24
    icon_bottom = height * 0.73
    icon_side = min(cell_width * 0.88, icon_bottom - icon_top)

    colors = [
        ((84, 176, 255), (255, 231, 110)),
        ((255, 120, 120), (255, 212, 92)),
        ((108, 226, 204), (255, 255, 255)),
        ((170, 128, 255), (255, 142, 204)),
    ]
    for index, (background, accent) in enumerate(colors):
        left = cell_width * index + (cell_width - icon_side) / 2
        top = icon_top + ((icon_bottom - icon_top) - icon_side) / 2
        box = (round(left), round(top), round(left + icon_side), round(top + icon_side))
        draw.rounded_rectangle(box, radius=round(icon_side * 0.22), fill=background)
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        r = round(icon_side * 0.22)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=accent)
        draw.rectangle((cx - 18, cy - 90, cx + 18, cy + 70), fill=(255, 255, 255))
        draw.text((round(cell_width * index + cell_width / 2), round(height * 0.82)), str(index + 1), fill=(15, 23, 42))

    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, "PNG")


if __name__ == "__main__":
    unittest.main()
