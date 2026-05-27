import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHygieneReport, isHighRiskPath, parseArgs, parsePorcelainStatus } from "./repo-hygiene-check.mjs";

test("parsePorcelainStatus separates tracked and untracked entries", () => {
  assert.deepEqual(parsePorcelainStatus(" M apps/api/src/server.ts\n?? docs/new.md\nR  old.ts -> scripts/new.ts\n"), [
    { code: " M", kind: "tracked", path: "apps/api/src/server.ts" },
    { code: "??", kind: "untracked", path: "docs/new.md" },
    { code: "R ", kind: "tracked", path: "scripts/new.ts" }
  ]);
});

test("isHighRiskPath detects source and manifest files", () => {
  assert.equal(isHighRiskPath("apps/api/src/server.ts"), true);
  assert.equal(isHighRiskPath("docs/runbooks/deploy.md"), true);
  assert.equal(isHighRiskPath("package.json"), true);
  assert.equal(isHighRiskPath(".planning/reports/a.md"), false);
  assert.equal(isHighRiskPath("logs/dev/api.log"), false);
});

test("buildHygieneReport reports dirty tracked and high-risk untracked files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "home-ktv-hygiene-"));

  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    await mkdir(path.join(dir, "apps", "api"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "initial\n");
    await writeFile(path.join(dir, "apps", "api", "server.ts"), "tracked\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "init"]);
    await writeFile(path.join(dir, "apps", "api", "server.ts"), "changed\n");
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "new.md"), "new\n");
    await mkdir(path.join(dir, "logs"), { recursive: true });

    const report = await buildHygieneReport({ rootDir: dir });

    assert.equal(report.summary.trackedDirty, 1);
    assert.equal(report.summary.highRiskUntracked, 1);
    assert.equal(report.trackedDirty[0]?.path, "apps/api/server.ts");
    assert.equal(report.untrackedHighRisk[0]?.path, "docs/new.md");
    assert.deepEqual(report.runtimePaths, ["logs"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("parseArgs supports json and fail-on-dirty", () => {
  assert.deepEqual(parseArgs(["--", "--json", "--fail-on-dirty", "--root", "/repo"]), {
    failOnDirty: true,
    help: false,
    json: true,
    rootDir: "/repo"
  });
});

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `git ${args.join(" ")} failed`));
      }
    });
  });
}
