#!/usr/bin/env python3

from __future__ import annotations

import unittest

from repo_hygiene_check import is_high_risk_path, normalize_status_path, parse_args, parse_branch_summary, parse_porcelain_status


class RepoHygieneCheckTest(unittest.TestCase):
    def test_parse_porcelain_status_splits_tracked_and_untracked(self) -> None:
        entries = parse_porcelain_status(" M README.md\n?? scripts/new_tool.py\nR  old.py -> new.py\n")

        self.assertEqual(entries[0].code, " M")
        self.assertEqual(entries[0].kind, "tracked")
        self.assertEqual(entries[0].path, "README.md")
        self.assertEqual(entries[1].kind, "untracked")
        self.assertEqual(entries[1].path, "scripts/new_tool.py")
        self.assertEqual(entries[2].path, "new.py")

    def test_high_risk_paths_match_source_and_config_files(self) -> None:
        self.assertTrue(is_high_risk_path("apps/api/src/index.ts"))
        self.assertTrue(is_high_risk_path("scripts/repo_hygiene_check.py"))
        self.assertTrue(is_high_risk_path("package.json"))
        self.assertFalse(is_high_risk_path("runtime/output.json"))
        self.assertFalse(is_high_risk_path("logs/dev.log"))

    def test_parse_branch_summary_strips_git_prefix(self) -> None:
        self.assertEqual(parse_branch_summary("## main...origin/main [ahead 1]\n"), "main...origin/main [ahead 1]")
        self.assertEqual(parse_branch_summary(""), "")

    def test_normalize_status_path_uses_rename_target(self) -> None:
        self.assertEqual(normalize_status_path("old.py -> new.py"), "new.py")

    def test_parse_args_ignores_pnpm_forwarded_separator(self) -> None:
        args = parse_args(["--", "--fail-on-dirty"])

        self.assertTrue(args.fail_on_dirty)


if __name__ == "__main__":
    unittest.main()
