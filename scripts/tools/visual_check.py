#!/usr/bin/env python3
"""Capture HomeKTV visual smoke screenshots with Chrome headless."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_DIR = REPO_ROOT / "logs" / "visual"
DEFAULT_ADMIN_URL = "http://127.0.0.1:5174/"
DEFAULT_API_URL = "http://127.0.0.1:4000"
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEFAULT_ROOM_SLUG = "living-room"
DEFAULT_TV_URL = "http://127.0.0.1:5173/"
CHROME_CAPTURE_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class ScreenshotTarget:
    file_name: str
    size: str
    url_kind: str


TV_SCREENSHOTS = (
    ScreenshotTarget("tv-web-1920x1080.png", "1920,1080", "tv"),
    ScreenshotTarget("tv-web-1366x768.png", "1366,768", "tv"),
)

UI_SCREENSHOTS = (
    ScreenshotTarget("controller-390x844.png", "390,844", "mobile"),
    ScreenshotTarget("controller-375x667.png", "375,667", "mobile"),
    ScreenshotTarget("admin-1440x900.png", "1440,900", "admin"),
    ScreenshotTarget("admin-768x900.png", "768,900", "admin"),
)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "tv":
        return run_tv_visual_check(os.environ)
    if args.command == "ui":
        return run_ui_visual_check(os.environ)
    raise ValueError(f"unknown command: {args.command}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("tv", help="Capture Web TV screenshots.")
    subparsers.add_parser("ui", help="Capture Controller and Admin screenshots.")
    return parser.parse_args(argv)


def run_tv_visual_check(env: dict[str, str]) -> int:
    url = env.get("TV_VISUAL_URL", "").strip() or DEFAULT_TV_URL
    chrome_bin = env.get("CHROME_BIN", "").strip() or DEFAULT_CHROME
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    output_files = []
    for target in TV_SCREENSHOTS:
        output = LOG_DIR / target.file_name
        capture_screenshot(chrome_bin=chrome_bin, output_file=output, url=url, window_size=target.size)
        verify_screenshot(output)
        output_files.append(output)

    for output in output_files:
        print(output)
    return 0


def run_ui_visual_check(env: dict[str, str]) -> int:
    config = build_visual_config(env)
    mobile_url = resolve_mobile_visual_url(config)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    output_files = []
    for target in UI_SCREENSHOTS:
        output = LOG_DIR / target.file_name
        url = config["adminUrl"] if target.url_kind == "admin" else mobile_url
        capture_screenshot(chrome_bin=config["chromeBin"], output_file=output, url=url, window_size=target.size, isolated_profile=True)
        verify_screenshot(output)
        output_files.append(output)

    for output in output_files:
        print(output)
    return 0


def build_visual_config(env: dict[str, str]) -> dict[str, str | None]:
    return {
        "adminUrl": env.get("ADMIN_VISUAL_URL", "").strip() or DEFAULT_ADMIN_URL,
        "apiBaseUrl": env.get("API_VISUAL_URL", "").strip() or env.get("PUBLIC_BASE_URL", "").strip() or DEFAULT_API_URL,
        "chromeBin": env.get("CHROME_BIN", "").strip() or DEFAULT_CHROME,
        "mobileOverrideUrl": env.get("MOBILE_VISUAL_URL", "").strip() or None,
        "roomSlug": env.get("TV_ROOM_SLUG", "").strip() or DEFAULT_ROOM_SLUG,
    }


def resolve_mobile_visual_url(config: dict[str, str | None]) -> str:
    override = config["mobileOverrideUrl"]
    if override:
        return str(override)

    try:
        return refresh_pairing_controller_url(api_base_url=str(config["apiBaseUrl"]), room_slug=str(config["roomSlug"]))
    except Exception as exc:
        raise RuntimeError(
            "Unable to resolve paired Mobile visual URL. Check API_VISUAL_URL and ensure pnpm dev:local restart is running."
            f" Cause: {exc}"
        ) from exc


def refresh_pairing_controller_url(api_base_url: str, room_slug: str) -> str:
    path = f"/admin/rooms/{urllib.parse.quote(room_slug)}/pairing-token/refresh"
    request = urllib.request.Request(f"{api_base_url.rstrip('/')}{path}", method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {path} HTTP {exc.code}: {body}") from exc

    payload = json.loads(body)
    controller_url = payload.get("pairing", {}).get("controllerUrl")
    if not isinstance(controller_url, str) or "/controller?" not in controller_url or "token=" not in controller_url:
        raise RuntimeError(f"malformed pairing refresh response from POST {path}")
    return controller_url


def capture_screenshot(
    *,
    chrome_bin: str,
    output_file: Path,
    url: str,
    window_size: str,
    isolated_profile: bool = False,
) -> None:
    profile_dir = Path(tempfile.mkdtemp(prefix=".chrome-visual-check-", dir=LOG_DIR)) if isolated_profile else None
    command = [
        chrome_bin,
        "--headless=new",
        "--disable-gpu",
        "--disable-extensions",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        "--no-default-browser-check",
        f"--window-size={window_size}",
        f"--screenshot={output_file}",
        "--virtual-time-budget=3000",
        url,
    ]
    if profile_dir:
        command.insert(-3, f"--user-data-dir={profile_dir}")

    try:
        result = subprocess.run(command, check=False, text=True, capture_output=True, timeout=CHROME_CAPTURE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        if output_file.exists() and output_file.stat().st_size > 0:
            return
        raise RuntimeError(f"Chrome timed out after {CHROME_CAPTURE_TIMEOUT_SECONDS}s for {output_file}")
    finally:
        if profile_dir:
            shutil.rmtree(profile_dir, ignore_errors=True)

    if result.returncode != 0:
        raise RuntimeError(f"Chrome exited with code {result.returncode} for {output_file}: {result.stderr.strip()}")


def verify_screenshot(file_path: Path) -> None:
    if not file_path.is_file() or file_path.stat().st_size <= 0:
        raise RuntimeError(f"Screenshot missing or empty: {file_path}")


if __name__ == "__main__":
    raise SystemExit(main())
