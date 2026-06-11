#!/usr/bin/env python3
"""Generate optimized Android TV app icons from a generated candidate sheet.

The script crops one candidate icon from the generated grid, rebuilds real
transparent rounded corners, exports Android launcher WebP sizes, and writes the
TV banner PNG. It uses Pillow for image work and optional external optimizers:
cwebp for lossy WebP, pngquant/oxipng for TinyPNG-like PNG compression.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATED_CANDIDATE_SHEET = Path(
    "/Users/shaolongfei/.codex/generated_images/"
    "019e8b70-9013-75b0-a643-ee3cf806dbfc/"
    "ig_037a29a492bd068e016a2a4c34383c8194bb854dc687cc821a.png"
)
DEFAULT_OUTPUT_RES = REPO_ROOT / "clients/android-tv/app/src/main/res"
DEFAULT_ARCHIVE = REPO_ROOT / "docs/assets/app-icons/home-ktv-app-icon-source.png"
DEFAULT_SOURCE = DEFAULT_ARCHIVE if DEFAULT_ARCHIVE.exists() else GENERATED_CANDIDATE_SHEET


@dataclass(frozen=True)
class LauncherTarget:
    directory: str
    size: int


LAUNCHER_TARGETS = (
    LauncherTarget("mipmap-mdpi", 48),
    LauncherTarget("mipmap-hdpi", 72),
    LauncherTarget("mipmap-xhdpi", 96),
    LauncherTarget("mipmap-xxhdpi", 144),
    LauncherTarget("mipmap-xxxhdpi", 192),
)


def main() -> int:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output_res = args.output_res.expanduser().resolve()
    archive = None if args.no_archive else args.archive.expanduser().resolve()

    if not source.exists():
        raise FileNotFoundError(f"source image not found: {source}")

    candidate_icon = load_candidate_icon(source, args.candidate)
    app_icon = rounded_icon(candidate_icon, args.source_size, args.corner_ratio)

    generated: list[Path] = []
    if archive:
        archive.parent.mkdir(parents=True, exist_ok=True)
        save_png_optimized(app_icon, archive, args.png_colors)
        generated.append(archive)

    for target in LAUNCHER_TARGETS:
        output_dir = output_res / target.directory
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "ic_launcher.webp"
        resized = app_icon.resize((target.size, target.size), Image.Resampling.LANCZOS)
        save_webp_optimized(resized, output_path, args.webp_quality)
        generated.append(output_path)

    banner_dir = output_res / "drawable"
    banner_dir.mkdir(parents=True, exist_ok=True)
    banner_path = banner_dir / "app_icon_your_company.png"
    banner = make_tv_banner(app_icon, (432, 243))
    save_png_optimized(banner, banner_path, args.png_colors)
    generated.append(banner_path)

    for file_path in generated:
        print(f"{display_path(file_path)} {format_size(file_path.stat().st_size)}")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Generated icon candidate sheet.")
    parser.add_argument("--candidate", type=int, default=1, choices=range(1, 5), help="Candidate number in the 4-icon grid.")
    parser.add_argument("--output-res", type=Path, default=DEFAULT_OUTPUT_RES, help="Android res directory to write into.")
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE, help="Compressed source icon archive path.")
    parser.add_argument("--no-archive", action="store_true", help="Do not write the archived source icon.")
    parser.add_argument("--source-size", type=int, default=1024, help="Archived square icon size.")
    parser.add_argument("--corner-ratio", type=float, default=0.22, help="Rounded corner radius relative to icon width.")
    parser.add_argument("--webp-quality", type=int, default=78, help="cwebp quality for launcher icons.")
    parser.add_argument("--png-colors", type=int, default=192, help="Palette colors for PNG optimization fallback.")
    return parser.parse_args()


def load_candidate_icon(source: Path, candidate: int) -> Image.Image:
    with Image.open(source) as image:
        if image.width == image.height:
            return image.convert("RGBA")
        return crop_candidate_icon(image, candidate)


def crop_candidate_icon(image: Image.Image, candidate: int) -> Image.Image:
    image = image.convert("RGBA")
    width, height = image.size
    cell_width = width / 4

    # The generated sheet has a transparent-looking checkerboard baked into RGB.
    # Crop the visual icon only and exclude the label numbers underneath.
    icon_top = height * 0.24
    icon_bottom = height * 0.73
    icon_side = min(cell_width * 0.88, icon_bottom - icon_top)
    left = cell_width * (candidate - 1) + (cell_width - icon_side) / 2
    top = icon_top + ((icon_bottom - icon_top) - icon_side) / 2

    box = (
        round(left),
        round(top),
        round(left + icon_side),
        round(top + icon_side),
    )
    return image.crop(box)


def rounded_icon(image: Image.Image, size: int, corner_ratio: float) -> Image.Image:
    canvas = image.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    radius = max(1, round(size * corner_ratio))
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.4))
    canvas.putalpha(mask)
    return canvas


def make_tv_banner(icon: Image.Image, size: tuple[int, int]) -> Image.Image:
    width, height = size
    background = cover_resize(icon, size).filter(ImageFilter.GaussianBlur(9))
    overlay = Image.new("RGBA", size, (255, 255, 255, 46))
    banner = Image.alpha_composite(background, overlay)

    logo_size = round(height * 0.76)
    logo = icon.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    x = round(width * 0.075)
    y = (height - logo_size) // 2
    banner.alpha_composite(logo, (x, y))

    radius = round(height * 0.12)
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=255)
    banner.putalpha(mask)
    return banner


def cover_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_width, target_height = size
    source = image.convert("RGBA")
    source_width, source_height = source.size
    scale = max(target_width / source_width, target_height / source_height)
    resized = source.resize((round(source_width * scale), round(source_height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - target_width) // 2
    top = (resized.height - target_height) // 2
    return resized.crop((left, top, left + target_width, top + target_height))


def save_webp_optimized(image: Image.Image, output_path: Path, quality: int) -> None:
    cwebp = shutil.which("cwebp")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if cwebp:
        temp_png = output_path.with_suffix(".tmp.png")
        image.save(temp_png, "PNG", optimize=True)
        subprocess.run(
            [cwebp, "-quiet", "-q", str(quality), "-m", "6", "-alpha_q", "100", str(temp_png), "-o", str(output_path)],
            check=True,
        )
        temp_png.unlink(missing_ok=True)
        return

    image.save(output_path, "WEBP", quality=quality, method=6, lossless=False)


def save_png_optimized(image: Image.Image, output_path: Path, colors: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, "PNG", optimize=True, compress_level=9)

    pngquant = shutil.which("pngquant")
    if pngquant:
        quantized = output_path.with_suffix(".pngquant.png")
        result = subprocess.run(
            [pngquant, "--force", "--quality", "75-92", "--speed", "1", "--output", str(quantized), str(output_path)],
            check=False,
        )
        if result.returncode == 0 and quantized.exists() and quantized.stat().st_size < output_path.stat().st_size:
            quantized.replace(output_path)
        else:
            quantized.unlink(missing_ok=True)
    elif colors > 0:
        quantized_image = image.convert("RGBA").quantize(colors=colors, method=Image.Quantize.MEDIANCUT).convert("RGBA")
        quantized_image.save(output_path, "PNG", optimize=True, compress_level=9)

    oxipng = shutil.which("oxipng")
    if oxipng:
        subprocess.run([oxipng, "-q", "-o", "4", "--strip", "safe", str(output_path)], check=False)


def format_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    return f"{size / 1024:.1f} KiB"


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
