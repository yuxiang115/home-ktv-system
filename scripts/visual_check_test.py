#!/usr/bin/env python3

from __future__ import annotations

import unittest
from unittest.mock import patch

import visual_check


class VisualCheckTest(unittest.TestCase):
    def test_build_visual_config_reads_env_defaults_and_overrides(self) -> None:
        config = visual_check.build_visual_config(
            {
                "ADMIN_VISUAL_URL": "http://admin.local/",
                "API_VISUAL_URL": "http://api.local",
                "CHROME_BIN": "/tmp/chrome",
                "MOBILE_VISUAL_URL": "http://controller.local/controller?token=x",
                "TV_ROOM_SLUG": "room-a",
            }
        )

        self.assertEqual(config["adminUrl"], "http://admin.local/")
        self.assertEqual(config["apiBaseUrl"], "http://api.local")
        self.assertEqual(config["chromeBin"], "/tmp/chrome")
        self.assertEqual(config["mobileOverrideUrl"], "http://controller.local/controller?token=x")
        self.assertEqual(config["roomSlug"], "room-a")

    def test_resolve_mobile_visual_url_uses_override(self) -> None:
        self.assertEqual(
            visual_check.resolve_mobile_visual_url(
                {
                    "adminUrl": "http://admin.local/",
                    "apiBaseUrl": "http://api.local",
                    "chromeBin": "/tmp/chrome",
                    "mobileOverrideUrl": "http://controller.local/controller?token=x",
                    "roomSlug": "room-a",
                }
            ),
            "http://controller.local/controller?token=x",
        )

    def test_parse_args_requires_ui_or_tv_command(self) -> None:
        self.assertEqual(visual_check.parse_args(["ui"]).command, "ui")
        self.assertEqual(visual_check.parse_args(["tv"]).command, "tv")

    @patch("visual_check.capture_screenshot")
    @patch("visual_check.verify_screenshot")
    def test_tv_check_captures_two_viewports(self, verify_screenshot, capture_screenshot) -> None:
        result = visual_check.run_tv_visual_check({"TV_VISUAL_URL": "http://tv.local/", "CHROME_BIN": "/tmp/chrome"})

        self.assertEqual(result, 0)
        self.assertEqual(capture_screenshot.call_count, 2)
        self.assertEqual(verify_screenshot.call_count, 2)
        self.assertEqual(capture_screenshot.call_args_list[0].kwargs["url"], "http://tv.local/")


if __name__ == "__main__":
    unittest.main()
