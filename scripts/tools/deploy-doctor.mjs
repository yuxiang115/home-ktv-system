#!/usr/bin/env node
import { accessSync, existsSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEXED_NAS_ROOT = "/mnt/nas/KTV歌曲";
const NETWORK_RETRY_ATTEMPTS = 4;
const NETWORK_RETRY_DELAY_MS = 1000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504, 521, 522, 523, 524]);

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

  const report = await buildDoctorReport(options, dependencies);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.summary.fail > 0) {
    process.exitCode = 1;
  }
}

export async function buildDoctorReport(options, dependencies = {}) {
  const envFile = options.envFile || defaultEnvFile(options.mode);
  const env = loadEnvFile(envFile);
  const config = buildDeployConfig({
    env,
    envFile,
    mode: options.mode,
    rootDir: ROOT_DIR
  });
  const checks = [];

  checks.push(checkEnvFile(envFile));
  checks.push(...checkRequiredEnv(config));
  checks.push(...checkCors(config));
  checks.push(...checkMediaPaths(config, dependencies));

  if (options.serviceStatusCmd) {
    checks.push(await checkCommand("service status", options.serviceStatusCmd, dependencies));
  }

  if (!options.skipNetwork) {
    checks.push(...(await checkUrls(config, dependencies)));
  }

  return {
    checkedAt: new Date().toISOString(),
    mode: options.mode,
    envFile,
    config: publicConfig(config),
    summary: summarizeChecks(checks),
    checks
  };
}

export function parseArgs(argv) {
  const options = {
    envFile: "",
    help: false,
    json: false,
    mode: "docker",
    serviceStatusCmd: "",
    skipNetwork: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-network") {
      options.skipNetwork = true;
    } else if (arg === "--mode") {
      options.mode = readOptionValue(argv, ++index, "--mode");
    } else if (arg === "--env-file") {
      options.envFile = readOptionValue(argv, ++index, "--env-file");
    } else if (arg === "--service-status-cmd") {
      options.serviceStatusCmd = readOptionValue(argv, ++index, "--service-status-cmd");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.mode !== "docker" && options.mode !== "source") {
    throw new Error("--mode must be docker or source");
  }

  return options;
}

export function buildDeployConfig({ env, envFile, mode, rootDir = ROOT_DIR }) {
  const dockerBaseDir = path.join(rootDir, "deploy", "docker");
  const hostPathBaseDir = mode === "docker" ? dockerBaseDir : rootDir;
  const apiBaseUrl = clean(env.PUBLIC_BASE_URL) || "http://127.0.0.1:4000";
  const adminBaseUrl = clean(env.ADMIN_BASE_URL) || replaceUrlPort(apiBaseUrl, clean(env.ADMIN_PORT) || "5174");
  const controllerBaseUrl = clean(env.CONTROLLER_BASE_URL) || replaceUrlPort(apiBaseUrl, clean(env.CONTROLLER_PORT) || "5176");
  const tvWebBaseUrl = clean(env.TV_WEB_BASE_URL) || replaceUrlPort(apiBaseUrl, clean(env.TV_WEB_PORT) || "5173");
  const mediaRoot = resolveFromRoot(hostPathBaseDir, mode === "docker" ? clean(env.KTV_MEDIA_HOST_PATH) : clean(env.MEDIA_ROOT));
  const nasHostPath = resolveFromRoot(hostPathBaseDir, clean(env.KTV_NAS_HOST_PATH));
  const rawPathMappings = mode === "docker" ? clean(env.DOCKER_MEDIA_PATH_MAPPINGS) : clean(env.MEDIA_PATH_MAPPINGS);

  return {
    adminBaseUrl,
    apiBaseUrl,
    controllerBaseUrl,
    corsAllowedOrigins: clean(env.CORS_ALLOWED_ORIGINS),
    databaseUrl: mode === "docker" ? clean(env.DOCKER_DATABASE_URL) : clean(env.DATABASE_URL),
    env,
    envFile,
    mediaRoot,
    mode,
    nasHostPath,
    pathMappings: parsePathMappings(rawPathMappings),
    rawPathMappings,
    roomSlug: clean(env.TV_ROOM_SLUG) || "living-room",
    rootDir,
    tvWebBaseUrl
  };
}

export function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      continue;
    }
    values[match[1]] = unquote(match[2].trim());
  }

  return values;
}

export function checkRequiredEnv(config) {
  const required = [
    ["PUBLIC_BASE_URL", config.apiBaseUrl],
    ["CONTROLLER_BASE_URL", config.controllerBaseUrl],
    ["CORS_ALLOWED_ORIGINS", config.corsAllowedOrigins],
    [config.mode === "docker" ? "DOCKER_DATABASE_URL" : "DATABASE_URL", config.databaseUrl]
  ];

  if (config.mode === "docker") {
    required.push(["KTV_NAS_HOST_PATH", config.env.KTV_NAS_HOST_PATH], ["DOCKER_MEDIA_PATH_MAPPINGS", config.rawPathMappings]);
  } else {
    required.push(["MEDIA_ROOT", config.env.MEDIA_ROOT], ["MEDIA_PATH_MAPPINGS", config.rawPathMappings]);
  }

  return required.map(([name, value]) => {
    if (clean(value)) {
      return pass("env", name, "configured");
    }
    return fail("env", name, "missing required deployment value");
  });
}

export function checkCors(config) {
  const allowed = new Set(
    config.corsAllowedOrigins
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const expected = [config.adminBaseUrl, config.controllerBaseUrl, config.tvWebBaseUrl]
    .map((url) => safeOrigin(url))
    .filter(Boolean);

  return expected.map((origin) => {
    if (allowed.has(origin)) {
      return pass("cors", origin, "allowed");
    }
    return warn("cors", origin, "missing from CORS_ALLOWED_ORIGINS");
  });
}

export function checkMediaPaths(config, dependencies = {}) {
  const checks = [];
  const pathExists = dependencies.pathExists ?? existsSync;
  const canReadPath = dependencies.canReadPath ?? canRead;

  if (config.mode === "docker") {
    checks.push(checkPath("media", "KTV_NAS_HOST_PATH", config.nasHostPath, pathExists, canReadPath));
  } else {
    checks.push(checkPath("media", "MEDIA_ROOT", config.mediaRoot, pathExists, canReadPath));
  }

  if (config.pathMappings.some((mapping) => mapping.from === INDEXED_NAS_ROOT)) {
    checks.push(pass("media", "indexed NAS mapping", `${INDEXED_NAS_ROOT} is mapped`));
  } else {
    checks.push(warn("media", "indexed NAS mapping", `${INDEXED_NAS_ROOT} is not present in media path mappings`));
  }

  return checks;
}

export async function checkUrls(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const wait = dependencies.wait ?? sleep;
  const apiBase = config.apiBaseUrl.replace(/\/$/u, "");
  const targets = [
    ["api health", `${apiBase}/health`],
    ["admin", ensureTrailingSlash(config.adminBaseUrl)],
    ["controller", `${config.controllerBaseUrl.replace(/\/$/u, "")}/controller?room=${encodeURIComponent(config.roomSlug)}`],
    [
      "web tv",
      `${config.tvWebBaseUrl.replace(/\/$/u, "")}/?apiBaseUrl=${encodeURIComponent(config.apiBaseUrl)}&roomSlug=${encodeURIComponent(config.roomSlug)}&deviceName=Web%20TV`
    ]
  ];

  const checks = [];
  for (const [name, url] of targets) {
    checks.push(await probeUrl(name, url, fetchImpl, wait));
  }
  checks.push(
    await probeKtvIndexDiagnostics(
      `${apiBase}/admin/ktv-index/diagnostics?sampleSize=3&sampleTimeoutMs=100`,
      fetchImpl,
      wait
    )
  );
  return checks;
}

export async function checkCommand(name, command, dependencies = {}) {
  const runShellCommand = dependencies.runShellCommand ?? runCommand;
  try {
    const result = await runShellCommand(command);
    if (result.code === 0) {
      return pass("services", name, firstLine(result.stdout) || "command exited 0");
    }
    return warn("services", name, firstLine(result.stderr) || `command exited ${result.code}`);
  } catch (error) {
    return warn("services", name, error instanceof Error ? error.message : String(error));
  }
}

export function summarizeChecks(checks) {
  return {
    fail: checks.filter((check) => check.status === "FAIL").length,
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length
  };
}

export function parsePathMappings(rawValue) {
  return clean(rawValue)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0
        ? {
            from: entry.slice(0, separator),
            to: entry.slice(separator + 1)
          }
        : {
            from: entry,
            to: ""
          };
    });
}

function checkEnvFile(envFile) {
  return existsSync(envFile) ? pass("env", "env file", envFile) : fail("env", "env file", `${envFile} does not exist`);
}

function checkPath(category, name, filePath, pathExists, canReadPath) {
  if (!clean(filePath)) {
    return fail(category, name, "path is not configured");
  }
  if (!pathExists(filePath)) {
    const status = filePath.includes("runtime/nas") ? "WARN" : "FAIL";
    return makeCheck(status, category, name, `${filePath} does not exist`);
  }
  if (!canReadPath(filePath)) {
    return fail(category, name, `${filePath} is not readable`);
  }
  return pass(category, name, `${filePath} is readable`);
}

async function probeUrl(name, url, fetchImpl, wait) {
  const result = await fetchWithTransientRetry(url, fetchImpl, wait, { timeoutMs: 3000 });
  if (result.error) {
    return fail("network", name, `${url} ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  }

  const response = result.response;
  if (response) {
    if (response.status >= 200 && response.status < 400) {
      return pass("network", name, `${response.status} ${url}`);
    }
    return fail("network", name, `${response.status} ${url}`);
  }
  return fail("network", name, `${url} no response`);
}

async function probeKtvIndexDiagnostics(url, fetchImpl, wait) {
  try {
    const result = await fetchWithTransientRetry(url, fetchImpl, wait, { timeoutMs: 5000 });
    if (result.error) {
      return fail("network", "ktv index diagnostics", `${url} ${result.error instanceof Error ? result.error.message : String(result.error)}`);
    }

    const response = result.response;
    if (!response) {
      return fail("network", "ktv index diagnostics", `${url} no response`);
    }
    if (response.status < 200 || response.status >= 400) {
      return fail("network", "ktv index diagnostics", `${response.status} ${url}`);
    }

    const body = await readJsonResponse(response);
    if (!isRecord(body)) {
      return fail("network", "ktv index diagnostics", `invalid JSON ${url}`);
    }

    const latestRun = isRecord(body.latestRun) ? body.latestRun : null;
    return pass(
      "network",
      "ktv index diagnostics",
      [
        `active=${formatMetric(body.activeAssetCount)}`,
        `missing=${formatMetric(body.missingAssetCount)}`,
        `songs=${formatMetric(body.songCount)}`,
        `latest=${typeof latestRun?.status === "string" ? latestRun.status : "none"}`
      ].join(" ")
    );
  } catch (error) {
    return fail("network", "ktv index diagnostics", `${url} ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchWithTransientRetry(url, fetchImpl, wait, { timeoutMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, fetchImpl, timeoutMs);
      if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === NETWORK_RETRY_ATTEMPTS) {
        return { response, error: null };
      }
    } catch (error) {
      lastError = error;
      if (attempt === NETWORK_RETRY_ATTEMPTS) {
        return { response: null, error };
      }
    }

    await wait(NETWORK_RETRY_DELAY_MS);
  }

  return { response: null, error: lastError };
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function publicConfig(config) {
  return {
    adminBaseUrl: config.adminBaseUrl,
    apiBaseUrl: config.apiBaseUrl,
    controllerBaseUrl: config.controllerBaseUrl,
    mediaRoot: config.mediaRoot,
    nasHostPath: config.nasHostPath,
    roomSlug: config.roomSlug,
    tvWebBaseUrl: config.tvWebBaseUrl
  };
}

function printReport(report) {
  console.log(`HomeKTV deploy doctor (${report.mode})`);
  console.log(`Env: ${report.envFile}`);
  console.log(`Summary: PASS ${report.summary.pass}, WARN ${report.summary.warn}, FAIL ${report.summary.fail}`);
  console.log("");
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(4)} [${check.category}] ${check.name} - ${check.message}`);
  }
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/tools/deploy-doctor.mjs [options]",
      "",
      "Options:",
      "  --mode docker|source       Deployment mode, default: docker",
      "  --env-file <path>          Env file path",
      "  --skip-network             Skip HTTP probes",
      "  --service-status-cmd <cmd> Run service status command and include result",
      "  --json                     Print JSON report",
      "  -h, --help                 Show help"
    ].join("\n")
  );
}

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ROOT_DIR,
      shell: true
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

function pass(category, name, message) {
  return makeCheck("PASS", category, name, message);
}

function warn(category, name, message) {
  return makeCheck("WARN", category, name, message);
}

function fail(category, name, message) {
  return makeCheck("FAIL", category, name, message);
}

function makeCheck(status, category, name, message) {
  return {
    category,
    message,
    name,
    status
  };
}

function canRead(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultEnvFile(mode) {
  return path.join(ROOT_DIR, "deploy", mode === "docker" ? "docker" : "source", ".env");
}

function readOptionValue(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveFromRoot(rootDir, input) {
  const value = clean(input);
  if (!value) {
    return "";
  }
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function replaceUrlPort(url, port) {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function firstLine(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}

async function readJsonResponse(response) {
  if (typeof response.json === "function") {
    return response.json();
  }
  if (typeof response.text === "function") {
    return JSON.parse(await response.text());
  }
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function formatMetric(value) {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return "unknown";
}
