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
  runFullStyleTagging(options, dependencies);
}

export function parseArgs(argv) {
  const options = {
    composeFile: path.join(ROOT_DIR, "deploy", "docker", "compose.yml"),
    envFile: path.join(ROOT_DIR, "deploy", "docker", ".env"),
    help: false,
    llmBatch: 30,
    llmProgressEvery: 5,
    maxLlmStalledBatches: 5,
    maxNeteaseStalledBatches: 5,
    neteaseBaseUrl: "http://ktv-netease-api:3000",
    neteaseBatch: 500,
    neteaseProgressEvery: 50,
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
    } else if (arg === "--netease-base-url") {
      options.neteaseBaseUrl = readValue(argv, ++index, arg);
    } else if (arg === "--netease-batch") {
      options.neteaseBatch = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--llm-batch") {
      options.llmBatch = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--sleep-ms") {
      options.sleepMs = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--max-netease-stalled-batches") {
      options.maxNeteaseStalledBatches = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--max-llm-stalled-batches") {
      options.maxLlmStalledBatches = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function buildTagStylesArgs(kind, options) {
  if (kind === "netease") {
    return [
      "deploy/docker/ktv.sh",
      "tag-styles",
      "--",
      "--source",
      "netease",
      "--base-url",
      options.neteaseBaseUrl,
      "--limit",
      String(options.neteaseBatch),
      "--apply",
      "--progress-every",
      String(options.neteaseProgressEvery)
    ];
  }

  return [
    "deploy/docker/ktv.sh",
    "tag-styles",
    "--",
    "--source",
    "llm",
    "--limit",
    String(options.llmBatch),
    "--apply",
    "--progress-every",
    String(options.llmProgressEvery)
  ];
}

export function neteaseMissingSql() {
  return `WITH active AS (
  SELECT s.id
  FROM ktv_songs s
  WHERE EXISTS (
    SELECT 1 FROM ktv_song_assets a
    WHERE a.song_id = s.id
      AND a.missing_at IS NULL
  )
)
SELECT count(*)
FROM active
LEFT JOIN ktv_song_tagging_status status
  ON status.song_id = active.id
 AND status.source = 'netease-playlist-v1'
WHERE status.song_id IS NULL;`;
}

export function neteaseRetryableSql() {
  return `SELECT count(*)
FROM ktv_song_tagging_status
WHERE source = 'netease-playlist-v1'
  AND status IN ('empty', 'failed');`;
}

export function llmLowCoverageSql() {
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
  HAVING count(DISTINCT st.tag_id) <= 1
)
SELECT count(*) FROM candidate;`;
}

export function runFullStyleTagging(options, dependencies = {}) {
  const run = dependencies.runCommand ?? runCommand;
  const queryScalar = dependencies.queryScalar ?? ((sql) => queryScalarWithPsql(options, sql, run));
  const sleep = dependencies.sleep ?? sleepSync;
  const log = dependencies.log ?? ((line) => console.log(line));

  logLine(log, "full style tagging started");
  run("docker", ["network", "connect", "home-ktv_default", "ktv-netease-api"], {
    allowFailure: true,
    cwd: options.rootDir
  });

  drainNetease({ log, options, queryScalar, run, sleep });
  drainLlm({ log, options, queryScalar, run, sleep });

  logLine(log, "full style tagging finished");
}

function drainNetease(context) {
  let stalled = 0;
  while (true) {
    const missingBefore = readCount(context.queryScalar, neteaseMissingSql());
    const retryable = readCount(context.queryScalar, neteaseRetryableSql());
    logLine(context.log, `netease remaining missing=${missingBefore} retryable=${retryable}`);

    if (missingBefore <= 0) {
      logLine(context.log, "netease primary phase complete");
      return;
    }

    const code = context.run("bash", buildTagStylesArgs("netease", context.options), {
      cwd: context.options.rootDir
    });
    const missingAfter = readCount(context.queryScalar, neteaseMissingSql());
    if (code !== 0) {
      logLine(context.log, `netease batch failed code=${code}; sleep before retry`);
      context.sleep(context.options.sleepMs);
      continue;
    }

    if (missingAfter >= missingBefore) {
      stalled += 1;
      logLine(context.log, `netease did not reduce missing count stalled=${stalled}/${context.options.maxNeteaseStalledBatches}`);
      if (stalled >= context.options.maxNeteaseStalledBatches) {
        throw new Error("Netease tagging stalled; check logs before continuing");
      }
    } else {
      stalled = 0;
    }
  }
}

function drainLlm(context) {
  let stalled = 0;
  while (true) {
    const lowBefore = readCount(context.queryScalar, llmLowCoverageSql());
    logLine(context.log, `llm remaining lowCoverage=${lowBefore}`);

    if (lowBefore <= 0) {
      logLine(context.log, "llm fallback phase complete");
      return;
    }

    const code = context.run("bash", buildTagStylesArgs("llm", context.options), {
      cwd: context.options.rootDir
    });
    const lowAfter = readCount(context.queryScalar, llmLowCoverageSql());
    if (code !== 0) {
      logLine(context.log, `llm batch failed code=${code}; sleep before retry`);
      context.sleep(context.options.sleepMs);
      continue;
    }

    if (lowAfter >= lowBefore) {
      stalled += 1;
      logLine(context.log, `llm did not reduce low coverage count stalled=${stalled}/${context.options.maxLlmStalledBatches}`);
      if (stalled >= context.options.maxLlmStalledBatches) {
        throw new Error("LLM fallback stalled; check logs before continuing");
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
  if (code !== 0 && !options.allowFailure && !options.capture) {
    return code;
  }
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

function printUsage() {
  console.log(`Usage:
  node scripts/tools/run-style-tagging-full.mjs

Options:
  --netease-batch <n>   Netease primary batch size. Default: 500.
  --llm-batch <n>       LLM fallback batch size. Default: 30.
  --netease-base-url <url>
                         NeteaseCloudMusicApi URL inside Docker. Default: http://ktv-netease-api:3000.
  --sleep-ms <n>        Delay after failed command. Default: 60000.
`);
}
