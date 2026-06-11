#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_ROOT = ROOT_DIR / "runtime" / "media" / "covers" / "nas"
DEFAULT_OUTPUT_ROOT = DEFAULT_SOURCE_ROOT / "thumbs"


@dataclass(frozen=True)
class ThumbnailJob:
    song_id: str
    source_path: Path
    output_path: Path


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "generate":
        generate_thumbnails(args)
        return
    raise SystemExit(f"Unknown command: {args.command}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    argv = [arg for arg in argv if arg != "--"]
    parser = argparse.ArgumentParser(description="Generate fixed-size HomeKTV NAS cover thumbnails.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate = subparsers.add_parser("generate")
    generate.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT))
    generate.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    generate.add_argument("--size", type=positive_int, default=160)
    generate.add_argument("--quality", type=bounded_jpeg_quality, default=82)
    generate.add_argument("--concurrency", type=positive_int, default=20)
    generate.add_argument("--progress-every", type=positive_int, default=500)
    generate.add_argument("--overwrite", action="store_true")
    generate.add_argument("--limit", type=non_negative_int, default=0, help="0 means all covers.")
    return parser.parse_args(argv)


def positive_int(raw: str) -> int:
    value = int(raw)
    if value < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return value


def non_negative_int(raw: str) -> int:
    value = int(raw)
    if value < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return value


def bounded_jpeg_quality(raw: str) -> int:
    value = int(raw)
    if value < 1 or value > 95:
        raise argparse.ArgumentTypeError("must be between 1 and 95")
    return value


def generate_thumbnails(args: argparse.Namespace) -> None:
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise SystemExit("Pillow is required: python3 -m pip install --user pillow") from exc

    source_root = Path(args.source_root).resolve()
    output_root = Path(args.output_root).resolve()
    jobs = plan_thumbnail_jobs(source_root, output_root, overwrite=args.overwrite, limit=args.limit)
    output_root.mkdir(parents=True, exist_ok=True)

    stats = {"selected": len(jobs), "generated": 0, "skipped": 0, "failed": 0}
    print(
        f"selected={len(jobs)} sourceRoot={source_root} outputRoot={output_root} "
        f"size={args.size} quality={args.quality} concurrency={args.concurrency}",
        flush=True,
    )

    def worker(job: ThumbnailJob) -> dict[str, object]:
        return generate_one_thumbnail(
            Image=Image,
            ImageOps=ImageOps,
            job=job,
            size=args.size,
            quality=args.quality,
            overwrite=args.overwrite,
        )

    for index, result in enumerate(iter_task_results(jobs, worker, args.concurrency), start=1):
        status = str(result.get("status"))
        if status == "generated":
            stats["generated"] += 1
        elif status == "skipped":
            stats["skipped"] += 1
        else:
            stats["failed"] += 1

        if index % args.progress_every == 0 or index == len(jobs):
            print(
                f"processed={index}/{len(jobs)} generated={stats['generated']} "
                f"skipped={stats['skipped']} failed={stats['failed']}",
                flush=True,
            )

    print(json.dumps({**stats, "finishedAt": now_iso()}, ensure_ascii=False), flush=True)


def plan_thumbnail_jobs(source_root: Path, output_root: Path, overwrite: bool, limit: int = 0) -> list[ThumbnailJob]:
    source_paths = sorted(path for path in source_root.glob("*.jpg") if path.is_file())
    jobs = [
        ThumbnailJob(song_id=source_path.stem, source_path=source_path, output_path=output_root / source_path.name)
        for source_path in source_paths
        if should_process(source_path, output_root / source_path.name, overwrite)
    ]
    return jobs[:limit] if limit > 0 else jobs


def should_process(source_path: Path, output_path: Path, overwrite: bool) -> bool:
    if overwrite:
        return True
    if not output_path.exists():
        return True
    return output_path.stat().st_mtime < source_path.stat().st_mtime


def generate_one_thumbnail(*, Image, ImageOps, job: ThumbnailJob, size: int, quality: int, overwrite: bool) -> dict[str, object]:
    if not should_process(job.source_path, job.output_path, overwrite):
        return {"songId": job.song_id, "status": "skipped"}

    temp_path = job.output_path.with_suffix(f"{job.output_path.suffix}.tmp-{os.getpid()}")
    try:
        with Image.open(job.source_path) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((size, size))
            canvas = Image.new("RGB", (size, size), (18, 20, 24))
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGB")
            if image.mode == "RGBA":
                background = Image.new("RGB", image.size, (18, 20, 24))
                background.paste(image, mask=image.getchannel("A"))
                image = background
            x = (size - image.width) // 2
            y = (size - image.height) // 2
            canvas.paste(image, (x, y))
            job.output_path.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(temp_path, format="JPEG", quality=quality, optimize=True, progressive=True)
        temp_path.replace(job.output_path)
        return {"songId": job.song_id, "status": "generated", "bytes": job.output_path.stat().st_size}
    except Exception as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return {"songId": job.song_id, "status": "failed", "error": str(exc)}


def iter_task_results(jobs, worker, concurrency):
    pending = iter(jobs)
    futures = set()
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        for _ in range(concurrency):
            try:
                futures.add(executor.submit(worker, next(pending)))
            except StopIteration:
                break

        while futures:
            done, futures = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                yield future.result()
                try:
                    futures.add(executor.submit(worker, next(pending)))
                except StopIteration:
                    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    main()
