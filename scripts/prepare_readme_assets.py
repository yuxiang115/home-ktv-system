#!/usr/bin/env python3
"""Prepare optimized README banner and screenshot assets."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from android_app_icon_pipeline import save_webp_optimized


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ICON = REPO_ROOT / "docs/assets/app-icons/home-ktv-app-icon-source.png"
DEFAULT_SCREENSHOT_SOURCE = Path("/Users/shaolongfei/Downloads/截图")
DEFAULT_PROJECT_SCREENSHOT_SOURCE = Path("/Users/shaolongfei/Downloads/项目截图")
DEFAULT_README_ASSETS = REPO_ROOT / "docs/assets/readme"
DEFAULT_SCREENSHOT_OUTPUT = REPO_ROOT / "docs/assets/screenshots"

SCREENSHOTS = {
    "Android-TV端.jpg": ("android-tv.webp", 1280),
    "控制端-首页.jpg": ("controller-home.webp", 720),
    "控制端-操控页.jpg": ("controller-remote.webp", 720),
    "控制端-我的.jpg": ("controller-profile.webp", 720),
}

PROJECT_SCREENSHOTS = {
    "web端TV.jpg": ("web-tv.webp", 1280),
    "后台-首页.jpg": ("admin-dashboard.webp", 960),
    "后台-房间状态.jpg": ("admin-room-status.webp", 1280),
    "后台-搜索预览.jpg": ("admin-search-preview.webp", 1280),
    "数据库.jpg": ("database-browser.webp", 1280),
}


def main() -> int:
    args = parse_args()
    icon = args.icon.expanduser().resolve()
    screenshot_source = args.screenshot_source.expanduser().resolve()
    project_screenshot_source = args.project_screenshot_source.expanduser().resolve()
    readme_assets = args.readme_assets.expanduser().resolve()
    screenshot_output = args.screenshot_output.expanduser().resolve()

    if not icon.exists():
        raise FileNotFoundError(f"app icon not found: {icon}")
    generated = [make_banner(icon, readme_assets / "home-ktv-banner.webp", args.webp_quality)]
    generated.extend(
        optimize_screenshots(
            source_dir=screenshot_source,
            output_dir=screenshot_output,
            screenshots=SCREENSHOTS,
            quality=args.webp_quality,
            source_label="core screenshots",
        )
    )
    generated.extend(
        optimize_screenshots(
            source_dir=project_screenshot_source,
            output_dir=screenshot_output,
            screenshots=PROJECT_SCREENSHOTS,
            quality=args.webp_quality,
            source_label="project screenshots",
        )
    )

    for path in generated:
        print(f"{display_path(path)} {format_size(path.stat().st_size)}")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--icon", type=Path, default=DEFAULT_ICON, help="Project app icon.")
    parser.add_argument(
        "--screenshot-source",
        type=Path,
        default=DEFAULT_SCREENSHOT_SOURCE,
        help="Directory containing source screenshots.",
    )
    parser.add_argument(
        "--project-screenshot-source",
        type=Path,
        default=DEFAULT_PROJECT_SCREENSHOT_SOURCE,
        help="Directory containing Admin, Web TV, and database screenshots.",
    )
    parser.add_argument("--readme-assets", type=Path, default=DEFAULT_README_ASSETS, help="README asset output directory.")
    parser.add_argument(
        "--screenshot-output",
        type=Path,
        default=DEFAULT_SCREENSHOT_OUTPUT,
        help="Optimized screenshot output directory.",
    )
    parser.add_argument("--webp-quality", type=int, default=82, help="cwebp/Pillow quality for README WebP assets.")
    return parser.parse_args()


def make_banner(icon_path: Path, output_path: Path, quality: int) -> Path:
    width, height = 1600, 560
    icon = Image.open(icon_path).convert("RGBA")
    icon = square_crop(icon).resize((260, 260), Image.Resampling.LANCZOS)

    background = make_gradient((width, height))
    draw = ImageDraw.Draw(background)

    add_soft_panel(background, (86, 76, width - 86, height - 76), radius=44)
    add_blurred_icon_glow(background, icon, (128, 150))

    icon_shadow = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    ImageDraw.Draw(icon_shadow).rounded_rectangle((0, 0, 259, 259), radius=58, fill=(0, 0, 0, 72))
    icon_shadow = icon_shadow.filter(ImageFilter.GaussianBlur(18))
    background.alpha_composite(icon_shadow, (124, 164))
    background.alpha_composite(icon, (128, 150))

    title_font = font(94, bold=True)
    subtitle_font = font(36)
    meta_font = font(24, bold=True)

    draw.text((450, 150), "HomeKTV System", font=title_font, fill=(255, 255, 255, 255))
    draw.text(
        (456, 260),
        "Self-hosted karaoke for Android TV, mobile song requests,",
        font=subtitle_font,
        fill=(226, 238, 255, 235),
    )
    draw.text(
        (456, 308),
        "NAS libraries, and admin operations.",
        font=subtitle_font,
        fill=(226, 238, 255, 220),
    )

    badges = ["Android TV", "Mobile Controller", "NAS Music Library", "Docker / Source Deploy"]
    x = 456
    y = 386
    for label in badges:
        label_width = round(draw.textlength(label, font=meta_font))
        badge = (x, y, x + label_width + 28, y + 48)
        badge_layer = Image.new("RGBA", background.size, (0, 0, 0, 0))
        badge_draw = ImageDraw.Draw(badge_layer)
        badge_draw.rounded_rectangle(
            badge,
            radius=16,
            fill=(255, 255, 255, 34),
            outline=(255, 255, 255, 74),
            width=1,
        )
        badge_draw.text((x + 14, y + 10), label, font=meta_font, fill=(255, 255, 255, 232))
        background.alpha_composite(badge_layer)
        x = badge[2] + 12

    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_webp_optimized(background, output_path, quality)
    return output_path


def optimize_screenshots(
    source_dir: Path,
    output_dir: Path,
    screenshots: dict[str, tuple[str, int]],
    quality: int,
    source_label: str,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    generated: list[Path] = []
    for source_name, (target_name, max_width) in screenshots.items():
        source = source_dir / source_name
        target = output_dir / target_name
        if not source.exists() and target.exists():
            print(f"skip {source_label}: {display_path(target)} already exists; missing source {source}", file=sys.stderr)
            continue
        if not source.exists():
            raise FileNotFoundError(f"{source_label} screenshot not found: {source}")
        with Image.open(source) as image:
            processed = resize_for_readme(image.convert("RGB"), max_width)
            save_webp_optimized(processed, target, quality)
            generated.append(target)
    return generated


def resize_for_readme(image: Image.Image, max_width: int) -> Image.Image:
    if image.width <= max_width:
        return image.copy()
    scale = max_width / image.width
    size = (max_width, round(image.height * scale))
    return image.resize(size, Image.Resampling.LANCZOS)


def square_crop(image: Image.Image) -> Image.Image:
    side = min(image.width, image.height)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    return image.crop((left, top, left + side, top + side))


def make_gradient(size: tuple[int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            nx = x / max(1, width - 1)
            ny = y / max(1, height - 1)
            r = round(20 + 18 * nx + 18 * (1 - ny))
            g = round(45 + 78 * nx + 26 * ny)
            b = round(72 + 75 * (1 - nx) + 44 * ny)
            pixels[x, y] = (r, g, b, 255)
    draw = ImageDraw.Draw(image)
    draw.ellipse((-220, -190, 560, 590), fill=(44, 160, 142, 92))
    draw.ellipse((1040, -230, 1800, 520), fill=(241, 163, 66, 82))
    draw.ellipse((900, 310, 1760, 860), fill=(92, 132, 255, 70))
    return image.filter(ImageFilter.GaussianBlur(0.15))


def add_soft_panel(image: Image.Image, box: tuple[int, int, int, int], radius: int) -> None:
    panel = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(panel)
    shadow_box = (box[0] + 6, box[1] + 12, box[2] + 6, box[3] + 12)
    draw.rounded_rectangle(shadow_box, radius=radius, fill=(0, 0, 0, 72))
    panel = panel.filter(ImageFilter.GaussianBlur(18))
    image.alpha_composite(panel)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(box, radius=radius, fill=(9, 18, 32, 112), outline=(255, 255, 255, 46), width=2)


def add_blurred_icon_glow(image: Image.Image, icon: Image.Image, position: tuple[int, int]) -> None:
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    large_icon = icon.resize((360, 360), Image.Resampling.LANCZOS)
    large_icon.putalpha(86)
    glow.alpha_composite(large_icon, (position[0] - 50, position[1] - 50))
    glow = glow.filter(ImageFilter.GaussianBlur(34))
    image.alpha_composite(glow)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def format_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size / 1024 / 1024:.1f} MiB"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
