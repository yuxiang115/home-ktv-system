#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HIGH_RISK_PREFIXES = ["apps/", "clients/", "packages/", "deploy/", "scripts/", "docs/"];
const HIGH_RISK_FILES = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]);
const RUNTIME_PATHS = ["runtime", "logs", "home-ktv-media", "songs-sample", ".worktrees", "worktrees"];

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function main(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const report = await buildHygieneReport(options, dependencies);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (options.failOnDirty && (report.summary.trackedDirty > 0 || report.summary.highRiskUntracked > 0)) {
    process.exitCode = 1;
  }
}

export async function buildHygieneReport(options = {}, dependencies = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const runGit = dependencies.runGit ?? ((args) => run("git", args, rootDir));
  const pathExists = dependencies.pathExists ?? ((filePath) => existsSync(path.join(rootDir, filePath)));

  const [status, branch] = await Promise.all([
    runGit(["status", "--porcelain=v1", "-uall"]),
    runGit(["status", "--short", "--branch"])
  ]);

  if (status.code !== 0) {
    throw new Error(status.stderr || "git status failed");
  }

  const entries = parsePorcelainStatus(status.stdout);
  const trackedDirty = entries.filter((entry) => entry.kind !== "untracked");
  const untracked = entries.filter((entry) => entry.kind === "untracked");
  const highRiskUntracked = untracked.filter((entry) => isHighRiskPath(entry.path));
  const runtimePaths = RUNTIME_PATHS.filter((name) => pathExists(name));

  return {
    branch: parseBranchSummary(branch.stdout),
    checkedAt: new Date().toISOString(),
    rootDir,
    summary: {
      highRiskUntracked: highRiskUntracked.length,
      runtimePaths: runtimePaths.length,
      trackedDirty: trackedDirty.length,
      untracked: untracked.length
    },
    trackedDirty,
    untrackedHighRisk: highRiskUntracked,
    runtimePaths
  };
}

export function parseArgs(argv) {
  const options = {
    failOnDirty: false,
    help: false,
    json: false,
    rootDir: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-dirty") {
      options.failOnDirty = true;
    } else if (arg === "--root") {
      options.rootDir = readOptionValue(argv, ++index, "--root");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function parsePorcelainStatus(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      return {
        code,
        kind: code === "??" ? "untracked" : "tracked",
        path: normalizeStatusPath(rawPath)
      };
    });
}

export function isHighRiskPath(filePath) {
  return HIGH_RISK_FILES.has(filePath) || HIGH_RISK_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function parseBranchSummary(stdout) {
  const firstLine = stdout.split(/\r?\n/u).find(Boolean) || "";
  return firstLine.replace(/^##\s*/u, "");
}

function normalizeStatusPath(filePath) {
  const renameSeparator = " -> ";
  return filePath.includes(renameSeparator) ? filePath.split(renameSeparator).at(-1) || filePath : filePath;
}

function printReport(report) {
  console.log("HomeKTV repo hygiene");
  console.log(`Root: ${report.rootDir}`);
  console.log(`Branch: ${report.branch || "(unknown)"}`);
  console.log(
    `Summary: tracked dirty ${report.summary.trackedDirty}, untracked ${report.summary.untracked}, high-risk untracked ${report.summary.highRiskUntracked}`
  );
  console.log("");

  if (report.trackedDirty.length > 0) {
    console.log("Tracked dirty files:");
    for (const entry of report.trackedDirty) {
      console.log(`  ${entry.code} ${entry.path}`);
    }
    console.log("");
  }

  if (report.untrackedHighRisk.length > 0) {
    console.log("High-risk untracked files:");
    for (const entry of report.untrackedHighRisk) {
      console.log(`  ${entry.path}`);
    }
    console.log("");
  }

  if (report.runtimePaths.length > 0) {
    console.log("Ignored/runtime paths present:");
    for (const filePath of report.runtimePaths) {
      console.log(`  ${filePath}/`);
    }
    console.log("");
  }

  if (report.summary.trackedDirty === 0 && report.summary.highRiskUntracked === 0) {
    console.log("No tracked dirty files or high-risk untracked files detected.");
  }
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/tools/repo-hygiene-check.mjs [options]",
      "",
      "Options:",
      "  --json             Print JSON report",
      "  --fail-on-dirty    Exit 1 when tracked or high-risk untracked files exist",
      "  --root <path>      Git repository root, default: current project",
      "  -h, --help         Show help"
    ].join("\n")
  );
}

function run(program, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stderr, stdout });
    });
  });
}

function readOptionValue(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
