#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export function main(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  runBatchLlmStyleTagging(options, dependencies);
}

export function parseArgs(argv) {
  const options = {
    composeFile: path.join(ROOT_DIR, "deploy", "docker", "compose.yml"),
    envFile: path.join(ROOT_DIR, "deploy", "docker", ".env"),
    help: false,
    llmBatch: 30,
    llmMaxExistingTags: 0,
    maxStalledBatches: 5,
    progressEvery: 5,
    rootDir: ROOT_DIR,
    sleepMs: 60_000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--env-file") {
      options.envFile = readValue(argv, ++index, arg);
    } else if (arg === "--compose-file") {
      options.composeFile = readValue(argv, ++index, arg);
    } else if (arg === "--llm-batch") {
      options.llmBatch = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--llm-max-existing-tags") {
      options.llmMaxExistingTags = readNonNegativeInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--progress-every") {
      options.progressEvery = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--sleep-ms") {
      options.sleepMs = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--max-stalled-batches") {
      options.maxStalledBatches = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function buildBatchTagStylesArgs(options) {
  return [
    "deploy/docker/ktv.sh",
    "tag-styles",
    "--",
    "--source",
    "llm",
    "--limit",
    String(options.llmBatch),
    "--apply",
    "--max-existing-tags",
    String(options.llmMaxExistingTags),
    "--batch",
    "--progress-every",
    String(options.progressEvery)
  ];
}

export function llmLowCoverageSql(options = parseArgs([])) {
  return `WITH candidate AS (
  SELECT s.id,
         count(DISTINCT st.tag_id)::integer AS tag_count
  FROM ktv_songs s
  JOIN ktv_song_assets a ON a.song_id = s.id AND a.missing_at IS NULL
  JOIN ktv_song_tagging_status base_status
    ON base_status.song_id = s.id
   AND base_status.source = 'netease-playlist-v1'
  LEFT JOIN ktv_song_style_tags st ON st.song_id = s.id
  LEFT JOIN ktv_song_tagging_status llm_status
    ON llm_status.song_id = s.id
   AND llm_status.source = 'llm-style-v1'
  WHERE llm_status.status IS DISTINCT FROM 'tagged'
  GROUP BY s.id
  HAVING count(DISTINCT st.tag_id) <= ${options.llmMaxExistingTags}
)
SELECT count(*) FROM candidate;`;
}

export function runBatchLlmStyleTagging(options, dependencies = {}) {
  const run = dependencies.runCommand ?? runCommand;
  const queryScalar = dependencies.queryScalar ?? ((sql) => queryScalarWithPsql(options, sql, run));
  const sleep = dependencies.sleep ?? sleepSync;
  const log = dependencies.log ?? ((line) => console.log(line));
  let stalled = 0;

  logLine(log, "batch LLM style tagging started");
  while (true) {
    const before = readCount(queryScalar, llmLowCoverageSql(options));
    logLine(log, `llm remaining lowCoverage=${before} maxExistingTags=${options.llmMaxExistingTags}`);
    if (before <= 0) {
      logLine(log, "batch LLM style tagging complete");
      return;
    }

    const code = run("bash", buildBatchTagStylesArgs(options), {
      cwd: options.rootDir
    });
    if (code !== 0) {
      logLine(log, `batch failed code=${code}; retry same batch after sleep`);
      sleep(options.sleepMs);
      continue;
    }

    const after = readCount(queryScalar, llmLowCoverageSql(options));
    if (after >= before) {
      stalled += 1;
      logLine(log, `batch did not reduce low coverage count stalled=${stalled}/${options.maxStalledBatches}`);
      if (stalled >= options.maxStalledBatches) {
        throw new Error("Batch LLM tagging stalled; check logs before continuing");
      }
    } else {
      stalled = 0;
    }
  }
}

function queryScalarWithPsql(options, sql, run) {
  const result = run(
    "docker",
    [
      "compose",
      "--env-file",
      options.envFile,
      "-f",
      options.composeFile,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "ktv",
      "-d",
      "home_ktv",
      "-At",
      "-c",
      sql
    ],
    { capture: true, cwd: options.rootDir }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || `psql failed with code ${result.code}`);
  }
  return result.stdout.trim();
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT_DIR,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  const code = result.status ?? 1;
  if (options.capture) {
    return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  return code;
}

function readCount(queryScalar, sql) {
  const value = Number.parseInt(queryScalar(sql), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid count query result for SQL: ${sql}`);
  }
  return value;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function logLine(log, message) {
  log(`[${new Date().toISOString()}] ${message}`);
}

function readValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function readPositiveInteger(raw, optionName) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInteger(raw, optionName) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node scripts/tools/run-style-tagging-llm-batch.mjs

Options:
  --llm-batch <n>              Songs per LLM request. Default: 30.
  --llm-max-existing-tags <n>  Process songs with this many tags or fewer. Default: 0.
  --progress-every <n>         Inner progress cadence. Default: 5.
  --sleep-ms <n>               Delay after failed batch. Default: 60000.
  --max-stalled-batches <n>    Stop after this many successful no-progress batches. Default: 5.
`);
}
