#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_TOTAL = 31_544;

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export function main(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help || options.command === "help") {
    printUsage();
    return;
  }

  const run = dependencies.runCommand ?? runCommand;
  const readFile = dependencies.readFile ?? fs.readFileSync;
  const writeFile = dependencies.writeFile ?? fs.writeFileSync;
  const mkdir = dependencies.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const exists = dependencies.exists ?? fs.existsSync;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? ((line) => console.log(line));

  const envFileText = exists(options.envFile) ? String(readFile(options.envFile, "utf8")) : "";
  const rawEnv = parseEnvText(envFileText);
  const deployment = resolveDeploymentEnv(rawEnv, options.rootDir);

  if (options.command === "start" || options.command === "resume") {
    startJob({ deployment, exists, log, mkdir, now, options, readFile, run, writeFile });
  } else if (options.command === "status") {
    statusJob({ exists, log, options, readFile, run });
  } else if (options.command === "logs") {
    logsJob({ exists, options, readFile, run });
  } else if (options.command === "stop") {
    run("docker", ["stop", options.containerName], { allowFailure: true });
  } else if (options.command === "stats") {
    statsJob({ deployment, exists, log, options, readFile });
  } else if (options.command === "import-dry-run" || options.command === "import") {
    importResults({ deployment, exists, options, readFile, run });
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }
}

export function parseArgs(argv, env = process.env, now = new Date()) {
  const hasCommand = Boolean(argv[0] && !argv[0].startsWith("-"));
  const command = hasCommand ? argv[0] : "help";
  const startIndex = hasCommand ? 1 : 0;
  const rootDir = env.KTV_ROOT_DIR || ROOT_DIR;
  const timestamp = formatTimestamp(now);
  const options = {
    command,
    concurrency: 5,
    containerName: env.KTV_STYLE_TAG_JOB_CONTAINER || "home-ktv-style-tags-job",
    envFile: env.KTV_ENV_FILE || path.join(rootDir, "deploy", "docker", ".env"),
    follow: false,
    help: false,
    image: env.KTV_STYLE_TAG_JOB_IMAGE || "home-ktv-api:latest",
    input: "/data/home-ktv-media/tagging/full/songs.jsonl",
    jobRoot: env.KTV_STYLE_TAG_JOB_ROOT || "/opt/home-ktv-jobs/style-tagging",
    neteaseBaseUrl: env.NETEASE_API_BASE_URL || "http://ktv-netease-api:3000",
    network: env.KTV_DOCKER_NETWORK || "home-ktv_default",
    output: `/data/home-ktv-media/tagging/full/results-netease-full-concurrency5-${timestamp}.jsonl`,
    outputExplicit: false,
    progressEvery: 100,
    rootDir,
    source: "netease",
    tailLines: 80,
    total: DEFAULT_TOTAL
  };

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root-dir") {
      options.rootDir = readValue(argv, ++index, arg);
    } else if (arg === "--env-file") {
      options.envFile = readValue(argv, ++index, arg);
    } else if (arg === "--job-root") {
      options.jobRoot = readValue(argv, ++index, arg);
    } else if (arg === "--container-name") {
      options.containerName = readValue(argv, ++index, arg);
    } else if (arg === "--image") {
      options.image = readValue(argv, ++index, arg);
    } else if (arg === "--network") {
      options.network = readValue(argv, ++index, arg);
    } else if (arg === "--input") {
      options.input = readValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.output = readValue(argv, ++index, arg);
      options.outputExplicit = true;
    } else if (arg === "--source") {
      options.source = readValue(argv, ++index, arg);
    } else if (arg === "--base-url") {
      options.neteaseBaseUrl = readValue(argv, ++index, arg);
    } else if (arg === "--concurrency") {
      options.concurrency = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--progress-every") {
      options.progressEvery = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--tail") {
      options.tailLines = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else if (arg === "--follow" || arg === "-f") {
      options.follow = true;
    } else if (arg === "--total") {
      options.total = readPositiveInteger(readValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = stripQuotes(line.slice(equalsIndex + 1).trim());
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

export function resolveDeploymentEnv(rawEnv, rootDir) {
  const mediaRoot = rawEnv.DOCKER_MEDIA_ROOT || "/data/home-ktv-media";
  const composeDir = path.join(rootDir, "deploy", "docker");
  return {
    corsAllowedOrigins: rawEnv.CORS_ALLOWED_ORIGINS || "",
    controllerBaseUrl: rawEnv.CONTROLLER_BASE_URL || "",
    databaseUrl: rawEnv.DOCKER_DATABASE_URL || rawEnv.DATABASE_URL || "postgres://ktv:ktv@postgres:5432/home_ktv",
    llmApiBaseUrl: rawEnv.LLM_API_BASE_URL || "",
    llmApiKey: rawEnv.LLM_API_KEY || "",
    llmModel: rawEnv.LLM_MODEL || "",
    mediaHostPath: resolveHostPath(rawEnv.KTV_MEDIA_HOST_PATH || "../../runtime/media", composeDir),
    mediaPathMappings: rawEnv.DOCKER_MEDIA_PATH_MAPPINGS || rawEnv.MEDIA_PATH_MAPPINGS || "/mnt/nas/KTV歌曲=/nas/KTV歌曲",
    mediaRoot,
    nasHostPath: resolveHostPath(rawEnv.KTV_NAS_HOST_PATH || "../../runtime/nas/KTV歌曲", composeDir),
    neteaseApiBaseUrl: rawEnv.NETEASE_API_BASE_URL || "http://ktv-netease-api:3000",
    publicBaseUrl: rawEnv.PUBLIC_BASE_URL || ""
  };
}

export function buildDockerRunArgs(options, deployment, job) {
  const commandArgs = [
    "pnpm",
    "-F",
    "@home-ktv/api",
    "tag:ktv-styles:jsonl",
    "--",
    "--input",
    options.input,
    "--output",
    options.output,
    "--source",
    options.source,
    "--base-url",
    options.neteaseBaseUrl || deployment.neteaseApiBaseUrl,
    "--concurrency",
    String(options.concurrency),
    "--progress-every",
    String(options.progressEvery)
  ];
  const shell = `mkdir -p ${shellQuote(path.posix.dirname(job.logContainerPath))} && ${shellJoin(commandArgs)} > ${shellQuote(job.logContainerPath)} 2>&1`;
  return buildBaseDockerRunArgs(options, deployment, false).concat([options.image, "sh", "-lc", shell]);
}

export function buildImportRunArgs(options, deployment, dryRun) {
  const commandArgs = [
    "pnpm",
    "-F",
    "@home-ktv/api",
    "tag:ktv-styles:import",
    "--",
    "--input",
    options.output
  ];
  if (dryRun) {
    commandArgs.push("--dry-run");
  }
  return buildBaseDockerRunArgs(options, deployment, true).concat([options.image, "sh", "-lc", shellJoin(commandArgs)]);
}

export function containerPathToHostPath(containerPath, deployment) {
  const normalizedRoot = deployment.mediaRoot.replace(/\/+$/, "");
  if (containerPath === normalizedRoot) {
    return deployment.mediaHostPath;
  }
  if (containerPath.startsWith(`${normalizedRoot}/`)) {
    return path.join(deployment.mediaHostPath, containerPath.slice(normalizedRoot.length + 1));
  }
  throw new Error(`Path is not under MEDIA_ROOT: ${containerPath}`);
}

export function summarizeResultsText(text, totalExpected = DEFAULT_TOTAL) {
  const summary = {
    total: 0,
    tagged: 0,
    empty: 0,
    failed: 0,
    tagsTotal: 0,
    maxTags: 0
  };
  for (const line of text.trim().split(/\n/).filter(Boolean)) {
    const row = JSON.parse(line);
    summary.total += 1;
    summary[row.status] = (summary[row.status] || 0) + 1;
    const tagCount = Array.isArray(row.tags) ? row.tags.length : Number(row.tagCount || 0) || 0;
    summary.tagsTotal += tagCount;
    summary.maxTags = Math.max(summary.maxTags, tagCount);
  }
  summary.progressPct = percentage(summary.total, totalExpected);
  summary.averageTags = summary.total > 0 ? round(summary.tagsTotal / summary.total) : 0;
  summary.taggedPct = percentage(summary.tagged, summary.total);
  summary.emptyPct = percentage(summary.empty, summary.total);
  summary.failedPct = percentage(summary.failed, summary.total);
  return summary;
}

function startJob({ deployment, exists, log, mkdir, now, options, readFile, run, writeFile }) {
  mkdir(options.jobRoot);
  mkdir(path.join(options.jobRoot, "logs"));

  const existingState = readState(options, exists, readFile);
  if (options.command === "resume" && !options.outputExplicit) {
    if (!existingState?.output) {
      throw new Error("No previous output in state.json. Pass --output to resume.");
    }
    options.output = existingState.output;
  }

  ensureContainerCanStart(options, run);
  const logName = `style-tags-${formatTimestamp(now())}.log`;
  const job = {
    logContainerPath: `/job/logs/${logName}`,
    logHostPath: path.join(options.jobRoot, "logs", logName)
  };
  const state = {
    command: options.command,
    containerName: options.containerName,
    image: options.image,
    input: options.input,
    jobRoot: options.jobRoot,
    logHostPath: job.logHostPath,
    network: options.network,
    output: options.output,
    startedAt: now().toISOString()
  };
  writeFile(statePath(options), `${JSON.stringify(state, null, 2)}\n`);
  const result = run("docker", buildDockerRunArgs(options, deployment, job), { cwd: options.rootDir });
  if (result !== 0) {
    throw new Error(`docker run failed with exit code ${result}`);
  }
  log(`started ${options.containerName}`);
  log(`output=${options.output}`);
  log(`log=${job.logHostPath}`);
}

function statusJob({ exists, log, options, readFile, run }) {
  run("docker", ["ps", "-a", "--filter", `name=^/${options.containerName}$`, "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}"], {
    allowFailure: true
  });
  const state = readState(options, exists, readFile);
  if (state) {
    log(`state=${statePath(options)}`);
    log(`output=${state.output}`);
    log(`log=${state.logHostPath}`);
  } else {
    log(`state=${statePath(options)} missing`);
  }
}

function logsJob({ exists, options, readFile, run }) {
  const state = readState(options, exists, readFile);
  if (!state?.logHostPath) {
    throw new Error("No log path in state.json");
  }
  const args = ["-n", String(options.tailLines)];
  if (options.follow) {
    args.push("-f");
  }
  args.push(state.logHostPath);
  run("tail", args);
}

function statsJob({ deployment, exists, log, options, readFile }) {
  const state = readState(options, exists, readFile);
  const output = options.output || state?.output;
  if (!output) {
    throw new Error("No output path available. Pass --output or start a job first.");
  }
  const hostPath = containerPathToHostPath(output, deployment);
  const text = exists(hostPath) ? String(readFile(hostPath, "utf8")) : "";
  log(JSON.stringify(summarizeResultsText(text, options.total), null, 2));
}

function importResults({ deployment, exists, options, readFile, run }) {
  const state = readState(options, exists, readFile);
  if (!options.outputExplicit && state?.output) {
    options.output = state.output;
  }
  const result = run("docker", buildImportRunArgs(options, deployment, options.command === "import-dry-run"), {
    cwd: options.rootDir
  });
  if (result !== 0) {
    throw new Error(`import command failed with exit code ${result}`);
  }
}

function buildBaseDockerRunArgs(options, deployment, rm) {
  const args = ["run"];
  if (rm) {
    args.push("--rm");
  } else {
    args.push("-d");
  }
  args.push("--name", rm ? `${options.containerName}-import-${Date.now()}` : options.containerName);
  args.push("--network", options.network);
  args.push("-v", `${options.jobRoot}:/job`);
  args.push("-v", `${deployment.mediaHostPath}:${deployment.mediaRoot}`);
  if (deployment.nasHostPath) {
    args.push("-v", `${deployment.nasHostPath}:/nas/KTV歌曲:ro`);
  }
  addEnv(args, "DATABASE_URL", deployment.databaseUrl);
  addEnv(args, "MEDIA_ROOT", deployment.mediaRoot);
  addEnv(args, "MEDIA_PATH_MAPPINGS", deployment.mediaPathMappings);
  addEnv(args, "NETEASE_API_BASE_URL", deployment.neteaseApiBaseUrl);
  addEnv(args, "PUBLIC_BASE_URL", deployment.publicBaseUrl);
  addEnv(args, "CONTROLLER_BASE_URL", deployment.controllerBaseUrl);
  addEnv(args, "CORS_ALLOWED_ORIGINS", deployment.corsAllowedOrigins);
  addEnv(args, "LLM_API_BASE_URL", deployment.llmApiBaseUrl);
  addEnv(args, "LLM_API_KEY", deployment.llmApiKey);
  addEnv(args, "LLM_MODEL", deployment.llmModel);
  return args;
}

function ensureContainerCanStart(options, run) {
  const status = captureCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${options.containerName}$`,
    "--format",
    "{{.Names}}\t{{.State}}"
  ]);
  if (!status.trim()) {
    return;
  }
  if (status.includes("\trunning")) {
    throw new Error(`${options.containerName} is already running`);
  }
  const result = run("docker", ["rm", options.containerName], { allowFailure: true });
  if (result !== 0) {
    throw new Error(`Failed to remove stopped container ${options.containerName}`);
  }
}

function readState(options, exists, readFile) {
  const file = statePath(options);
  if (!exists(file)) {
    return null;
  }
  return JSON.parse(String(readFile(file, "utf8")));
}

function statePath(options) {
  return path.join(options.jobRoot, "state.json");
}

function parseStateLine(line) {
  return line.trim();
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function readPositiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveHostPath(value, rootDir) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function addEnv(args, key, value) {
  if (value !== undefined && value !== "") {
    args.push("-e", `${key}=${value}`);
  }
}

function shellJoin(args) {
  return args.map((arg) => shellQuote(String(arg))).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function percentage(value, total) {
  return total > 0 ? round((value / total) * 100) : 0;
}

function round(value) {
  return Number(value.toFixed(2));
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.status ?? 0;
}

function captureCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return parseStateLine(result.stdout);
}

function printUsage() {
  console.log(`Usage: node scripts/tools/style-tagging-job.mjs <command> [options]

Commands:
  start           Start an independent JSONL style tagging container
  resume          Continue the output file recorded in state.json
  status          Show job container status and state paths
  logs            Tail the host-side job log
  stop            Stop the job container
  stats           Summarize the staged JSONL output
  import-dry-run  Validate staged JSONL against PostgreSQL
  import          Import staged JSONL into PostgreSQL

Options:
  --job-root <path>        Default: /opt/home-ktv-jobs/style-tagging
  --container-name <name>  Default: home-ktv-style-tags-job
  --image <image>          Default: home-ktv-api:latest
  --network <name>         Default: home-ktv_default
  --input <path>           Container JSONL input path
  --output <path>          Container JSONL output path
  --concurrency <n>        Default: 5
  --progress-every <n>     Default: 100
  --base-url <url>         Default: http://ktv-netease-api:3000
  --tail <n>               Default: 80
  --follow, -f             Follow logs
`);
}
