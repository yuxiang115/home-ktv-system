#!/usr/bin/env node
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_DIR = path.join(ROOT_DIR, "deploy", "source");
const ENV_FILE = process.env.KTV_ENV_FILE?.trim() || path.join(SOURCE_DIR, ".env");
const EXAMPLE_ENV = path.join(ROOT_DIR, "deploy", "env", "server.env.example");
const RUNTIME_DIR = resolveFromRoot(process.env.KTV_RUNTIME_DIR?.trim() || "runtime");
const LOG_DIR = path.join(RUNTIME_DIR, "logs");
const PID_DIR = path.join(RUNTIME_DIR, "pids");
const DOCKER_COMPOSE_FILE = path.join(ROOT_DIR, "deploy", "docker", "compose.yml");
const DOCKER_ENV_FILE = path.join(ROOT_DIR, "deploy", "docker", ".env");
const LEGACY_DOCKER_APP_SERVICES = ["api", "admin", "controller", "tv-web"];

const SERVICES = {
  api: {
    args: ["apps/api/dist/server.js"],
    command: "node",
    healthFile: "apps/api/dist/server.js",
    port: 4000
  },
  admin: {
    args: ["-F", "@home-ktv/admin", "preview", "--host", "0.0.0.0", "--port", "5174"],
    command: "pnpm",
    healthFile: "apps/admin/dist/index.html",
    port: 5174
  },
  controller: {
    args: ["-F", "@home-ktv/controller", "preview", "--host", "0.0.0.0", "--port", "5176"],
    command: "pnpm",
    healthFile: "apps/controller/dist/index.html",
    port: 5176
  },
  "tv-web": {
    args: ["-F", "@home-ktv/tv-web", "preview", "--host", "0.0.0.0", "--port", "5173"],
    command: "pnpm",
    healthFile: "apps/tv-web/dist/index.html",
    port: 5173
  }
};

const SERVICE_ALIASES = {
  "mobile-controller": "controller",
  "tv-player": "tv-web"
};

const command = process.argv[2] || "help";
const commandArg = process.argv[3];
const commandArgs = process.argv.slice(3);

main(command, commandArg, commandArgs).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(currentCommand, currentArg, currentArgs) {
  switch (currentCommand) {
    case "setup":
      ensureEnvFile();
      ensureDirs();
      printNextSteps();
      return;
    case "deploy":
      requireEnvFile();
      ensureDirs();
      await runForeground("git", ["pull", "--ff-only"]);
      await installDependencies();
      await buildApps();
      await stopLegacyDockerAppContainers();
      for (const service of serviceNames()) {
        await stopService(service);
      }
      await runMigration();
      for (const service of serviceNames()) {
        await startService(service);
      }
      printUrls();
      await runDoctor();
      await runSmoke();
      return;
    case "pull":
      await runForeground("git", ["pull", "--ff-only"]);
      return;
    case "build":
      requireEnvFile();
      ensureDirs();
      await buildApps();
      return;
    case "migrate":
      requireEnvFile();
      ensureDirs();
      await runMigration();
      return;
    case "start":
      requireEnvFile();
      ensureDirs();
      await stopLegacyDockerAppContainers();
      await runMigration();
      for (const service of serviceNames()) {
        await startService(service);
      }
      printUrls();
      return;
    case "restart":
      requireEnvFile();
      ensureDirs();
      await stopLegacyDockerAppContainers();
      for (const service of serviceNames()) {
        await stopService(service);
      }
      await runMigration();
      for (const service of serviceNames()) {
        await startService(service);
      }
      printUrls();
      return;
    case "stop":
      ensureDirs();
      for (const service of serviceNames()) {
        await stopService(service);
      }
      return;
    case "status":
      ensureDirs();
      for (const service of serviceNames()) {
        reportStatus(service);
      }
      printUrls();
      return;
    case "logs":
      ensureDirs();
      await tailLogs(currentArg);
      return;
    case "doctor":
      requireEnvFile();
      ensureDirs();
      await runDoctor();
      return;
    case "smoke":
      requireEnvFile();
      ensureDirs();
      await runSmoke();
      return;
    case "probe-index":
      requireEnvFile();
      ensureDirs();
      await runForeground("pnpm", ["-F", "@home-ktv/api", "probe:ktv-index", "--", ...stripArgumentSeparator(currentArgs)], buildRuntimeConfig().env);
      return;
    case "fetch-covers":
      requireEnvFile();
      ensureDirs();
      await runForeground("pnpm", ["-F", "@home-ktv/api", "covers:songs", "--", ...stripArgumentSeparator(currentArgs)], buildRuntimeConfig().env);
      return;
    case "cover-coverage":
      requireEnvFile();
      ensureDirs();
      await runForeground("pnpm", ["-F", "@home-ktv/api", "covers:coverage", "--", ...stripArgumentSeparator(currentArgs)], buildRuntimeConfig().env);
      return;
    case "cover-status":
      requireEnvFile();
      ensureDirs();
      await runForeground("pnpm", ["-F", "@home-ktv/api", "covers:status", "--", ...stripArgumentSeparator(currentArgs)], buildRuntimeConfig().env);
      return;
    case "cover-thumbnails":
      requireEnvFile();
      ensureDirs();
      await runForeground("pnpm", ["covers:thumbnails", "--", ...stripArgumentSeparator(currentArgs)], buildRuntimeConfig().env);
      return;
    case "help":
    case "-h":
    case "--help":
      printUsage();
      return;
    default:
      printUsage(true);
      process.exitCode = 2;
  }
}

function serviceNames() {
  return ["api", "admin", "controller", "tv-web"];
}

function ensureEnvFile() {
  mkdirSync(SOURCE_DIR, { recursive: true });
  if (existsSync(ENV_FILE)) {
    console.log(`${ENV_FILE} already exists`);
    return;
  }

  copyFileSync(EXAMPLE_ENV, ENV_FILE);
  console.log(`Created ${ENV_FILE}`);
  console.log("Edit PUBLIC_BASE_URL, CONTROLLER_BASE_URL, DATABASE_URL, MEDIA_ROOT, and MEDIA_PATH_MAPPINGS for your server.");
}

function requireEnvFile() {
  if (existsSync(ENV_FILE)) {
    return;
  }

  console.error(`Missing ${ENV_FILE}. Run setup first.`);
  process.exit(1);
}

function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(PID_DIR, { recursive: true });
  mkdirSync(buildRuntimeConfig().mediaRoot, { recursive: true });
}

async function installDependencies() {
  await runForeground("pnpm", ["install", "--frozen-lockfile"]);
}

async function buildApps() {
  const config = buildRuntimeConfig();
  await runForeground("pnpm", ["build"], {
    ...config.env,
    VITE_API_BASE_URL: config.apiBaseUrl
  });
}

async function runMigration() {
  await runForeground("pnpm", ["db:migrate"], buildRuntimeConfig().env);
}

async function stopLegacyDockerAppContainers() {
  if (process.env.KTV_SKIP_LEGACY_DOCKER_STOP === "1" || !existsSync(DOCKER_COMPOSE_FILE)) {
    return;
  }

  const args = ["compose"];
  if (existsSync(DOCKER_ENV_FILE)) {
    args.push("--env-file", DOCKER_ENV_FILE);
  }
  args.push("-f", DOCKER_COMPOSE_FILE, "stop", ...LEGACY_DOCKER_APP_SERVICES);

  const result = await runForegroundSoft("docker", args);
  if (result.ok) {
    console.log("legacy Docker app containers stopped; PostgreSQL container is left running");
    return;
  }

  console.warn(`legacy Docker app stop skipped: ${result.message}`);
}

async function startService(service) {
  const pidPath = servicePidPath(service);
  const logPath = serviceLogPath(service);

  if (isRunningFromPidFile(pidPath)) {
    const pid = readPid(pidPath);
    console.log(`${pad(service)} already running (pid ${pid})`);
    return;
  }

  assertBuildOutput(service);
  writeHeader(logPath, service);
  const logFd = openSync(logPath, "a");
  const config = buildRuntimeConfig();
  const child = spawn(SERVICES[service].command, SERVICES[service].args, {
    cwd: ROOT_DIR,
    detached: true,
    env: serviceEnv(service, config),
    stdio: ["ignore", logFd, logFd]
  });

  closeSync(logFd);
  child.unref();
  writeFileSync(pidPath, String(child.pid));
  await sleep(700);

  if (isProcessRunning(child.pid)) {
    console.log(`${pad(service)} started (pid ${child.pid}, log ${logPath})`);
    return;
  }

  rmSync(pidPath, { force: true });
  console.error(`${pad(service)} failed to start; see ${logPath}`);
}

async function stopService(service) {
  const pidPath = servicePidPath(service);
  if (!existsSync(pidPath)) {
    console.log(`${pad(service)} stopped`);
    return;
  }

  const pid = readPid(pidPath);
  if (!isProcessRunning(pid)) {
    rmSync(pidPath, { force: true });
    console.log(`${pad(service)} stopped (removed stale pid)`);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!isProcessRunning(pid)) {
      rmSync(pidPath, { force: true });
      console.log(`${pad(service)} stopped`);
      return;
    }
    await sleep(200);
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(pidPath, { force: true });
  console.log(`${pad(service)} killed after timeout`);
}

function reportStatus(service) {
  const pidPath = servicePidPath(service);
  if (!existsSync(pidPath)) {
    console.log(`${pad(service)} stopped`);
    return;
  }

  const pid = readPid(pidPath);
  if (isProcessRunning(pid)) {
    console.log(`${pad(service)} running (pid ${pid})`);
    return;
  }

  console.log(`${pad(service)} stopped (stale pid ${pid})`);
}

async function tailLogs(service) {
  const targets = service ? [normalizeServiceName(service)] : serviceNames();
  for (const name of targets) {
    if (!SERVICES[name]) {
      console.error(`Unknown service: ${name}`);
      process.exitCode = 2;
      return;
    }
  }

  const files = targets.map((name) => serviceLogPath(name));
  for (const file of files) {
    ensureFile(file);
  }

  await new Promise((resolve) => {
    const child = spawn("tail", ["-f", ...files], {
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function runForeground(program, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${program} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function runForegroundSoft(program, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });

    child.on("error", (error) => {
      resolve({ message: error instanceof Error ? error.message : String(error), ok: false });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ message: "", ok: true });
        return;
      }
      resolve({ message: `${program} ${args.join(" ")} failed with exit code ${code}`, ok: false });
    });
  });
}

function buildRuntimeConfig() {
  const fileEnv = loadEnvFile(ENV_FILE);
  const rawEnv = {
    ...fileEnv,
    ...process.env
  };

  const apiBaseUrl = clean(rawEnv.PUBLIC_BASE_URL) || "http://127.0.0.1:4000";
  const adminBaseUrl = clean(rawEnv.ADMIN_BASE_URL) || replaceUrlPort(apiBaseUrl, 5174);
  const controllerBaseUrl = clean(rawEnv.CONTROLLER_BASE_URL) || replaceUrlPort(apiBaseUrl, 5176);
  const tvWebBaseUrl = clean(rawEnv.TV_WEB_BASE_URL) || replaceUrlPort(apiBaseUrl, 5173);
  const mediaRoot = resolveFromRoot(clean(rawEnv.MEDIA_ROOT) || "runtime/media");
  const roomSlug = clean(rawEnv.TV_ROOM_SLUG) || "living-room";
  const corsAllowedOrigins = clean(rawEnv.CORS_ALLOWED_ORIGINS) || [adminBaseUrl, controllerBaseUrl, tvWebBaseUrl].join(",");

  const env = {
    ...rawEnv,
    CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
    CONTROLLER_BASE_URL: controllerBaseUrl,
    DATABASE_URL: clean(rawEnv.DATABASE_URL) || "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
    HOST: "0.0.0.0",
    MEDIA_PATH_MAPPINGS: clean(rawEnv.MEDIA_PATH_MAPPINGS) || "",
    MEDIA_ROOT: mediaRoot,
    NODE_ENV: "production",
    PORT: "4000",
    PUBLIC_BASE_URL: apiBaseUrl,
    TV_ROOM_SLUG: roomSlug,
    VITE_API_BASE_URL: apiBaseUrl
  };

  return {
    adminBaseUrl,
    apiBaseUrl,
    controllerBaseUrl,
    env,
    mediaRoot,
    roomSlug,
    tvWebBaseUrl
  };
}

function serviceEnv(service, config) {
  const env = {
    ...config.env
  };

  if (service !== "api") {
    delete env.CORS_ALLOWED_ORIGINS;
    delete env.DATABASE_URL;
    delete env.MEDIA_PATH_MAPPINGS;
    delete env.MEDIA_ROOT;
    delete env.PORT;
    delete env.TV_ROOM_SLUG;
  }

  return env;
}

function loadEnvFile(filePath) {
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

function printUrls() {
  const config = buildRuntimeConfig();
  console.log("");
  console.log("URLs:");
  console.log(`  API health:  ${config.apiBaseUrl}/health`);
  console.log(`  Admin:       ${config.adminBaseUrl}/`);
  console.log(`  Controller:  ${config.controllerBaseUrl}/controller?room=${encodeURIComponent(config.roomSlug)}`);
  console.log(
    `  Web TV:      ${config.tvWebBaseUrl}/?apiBaseUrl=${encodeURIComponent(config.apiBaseUrl)}&roomSlug=${encodeURIComponent(config.roomSlug)}&deviceName=Web%20TV`
  );
  console.log("");
  console.log("Logs:");
  console.log(`  ${LOG_DIR}`);
}

function printNextSteps() {
  console.log("");
  console.log("Setup finished. Common commands:");
  console.log("  bash deploy/source/ktv.sh deploy");
  console.log("  bash deploy/source/ktv.sh start");
  console.log("  bash deploy/source/ktv.sh status");
  console.log("  bash deploy/source/ktv.sh logs");
}

function printUsage(error = false) {
  const output = [
    "Usage: bash deploy/source/ktv.sh <command> [service]",
    "",
    "Commands:",
    "  setup       Create env file and runtime directories",
    "  deploy      Pull, install, build, migrate, restart, doctor, and smoke test",
    "  pull        git pull --ff-only",
    "  build       Build API, Admin, Controller, and Web TV from source",
    "  migrate     Run database migrations",
    "  start       Run migrations and start API/Admin/Controller/Web TV",
    "  restart     Stop, migrate, and start API/Admin/Controller/Web TV",
    "  status      Show service status and URLs",
    "  logs [svc]  Follow logs for all services or one service",
    "  doctor      Run deployment self-checks",
    "  smoke       Run public web deployment smoke checks",
    "  probe-index Probe indexed KTV media technical metadata",
    "  fetch-covers Batch fetch and cache song cover images",
    "  cover-coverage Test cover lookup coverage without writing database rows",
    "  cover-status Show cover cache progress and database coverage",
    "  cover-thumbnails Generate fixed-size local cover thumbnails",
    "  stop        Stop services",
    "  help        Show this help",
    "",
    "Services:",
    "  api, admin, controller, tv-web",
    "",
    "Environment:",
    `  KTV_ENV_FILE     Env file, default: ${ENV_FILE}`,
    `  KTV_RUNTIME_DIR  Runtime directory, default: ${RUNTIME_DIR}`
  ].join("\n");

  (error ? console.error : console.log)(output);
}

async function runDoctor() {
  await runForeground("node", [
    "scripts/tools/deploy-doctor.mjs",
    "--mode",
    "source",
    "--env-file",
    ENV_FILE,
    "--service-status-cmd",
    sourceStatusCommand()
  ]);
}

async function runSmoke() {
  await runForeground("node", ["scripts/tools/web-deploy-smoke.mjs"], buildRuntimeConfig().env);
}

function writeHeader(logPath, service) {
  const config = buildRuntimeConfig();
  const timestamp = new Date().toISOString();
  const lines = [
    "",
    `[${timestamp}] starting ${service}`,
    `PUBLIC_BASE_URL=${config.apiBaseUrl} CONTROLLER_BASE_URL=${config.controllerBaseUrl} MEDIA_ROOT=${config.mediaRoot} TV_ROOM_SLUG=${config.roomSlug}`
  ].join("\n");
  writeFileSync(logPath, `${lines}\n`, { flag: "a" });
}

function assertBuildOutput(service) {
  const filePath = path.join(ROOT_DIR, SERVICES[service].healthFile);
  if (existsSync(filePath)) {
    return;
  }

  console.error(`Missing build output for ${service}: ${filePath}`);
  console.error("Run: bash deploy/source/ktv.sh deploy");
  process.exit(1);
}

function normalizeServiceName(service) {
  return SERVICE_ALIASES[service] ?? service;
}

function serviceLogPath(service) {
  return path.join(LOG_DIR, `${service}.log`);
}

function servicePidPath(service) {
  return path.join(PID_DIR, `${service}.pid`);
}

function isRunningFromPidFile(pidPath) {
  if (!existsSync(pidPath)) {
    return false;
  }
  return isProcessRunning(readPid(pidPath));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath) {
  return Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
}

function ensureFile(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "");
  }
}

function resolveFromRoot(input) {
  return path.isAbsolute(input) ? input : path.resolve(ROOT_DIR, input);
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

function replaceUrlPort(url, port) {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return `http://${detectLanIp()}:${port}`;
  }
}

function stripArgumentSeparator(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

function sourceStatusCommand() {
  return [
    envAssignment("KTV_ENV_FILE", ENV_FILE),
    envAssignment("KTV_RUNTIME_DIR", RUNTIME_DIR),
    "bash deploy/source/ktv.sh status"
  ].join(" ");
}

function envAssignment(name, value) {
  return `${name}=${shellQuote(value)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of ["en0", "en1", "eth0"]) {
    const found = firstExternalIpv4(interfaces[name]);
    if (found) {
      return found;
    }
  }

  for (const [name, infos] of Object.entries(interfaces)) {
    if (/^(lo|utun|awdl|bridge|docker|vmnet|vboxnet)/u.test(name)) {
      continue;
    }
    const found = firstExternalIpv4(infos);
    if (found) {
      return found;
    }
  }

  return "127.0.0.1";
}

function firstExternalIpv4(entries) {
  if (!entries) {
    return null;
  }

  for (const entry of entries) {
    if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
      return entry.address;
    }
  }

  return null;
}

function pad(value) {
  return value.padEnd(12);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
