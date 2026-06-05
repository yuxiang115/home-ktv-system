#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_DIR = process.env.KTV_LOG_DIR?.trim() || path.join(ROOT_DIR, "logs", "dev");
const PID_DIR = path.join(LOG_DIR, "pids");
const ROOM_SLUG = process.env.TV_ROOM_SLUG?.trim() || "living-room";
const MEDIA_ROOT = process.env.MEDIA_ROOT?.trim() || path.join(ROOT_DIR, "home-ktv-media");
const MEDIA_PATH_MAPPINGS = process.env.MEDIA_PATH_MAPPINGS?.trim() || detectDefaultMediaPathMappings();
const LAN_IP = detectLanIp(process.env.KTV_LAN_IP?.trim());
const API_BASE_URL = process.env.PUBLIC_BASE_URL?.trim() || `http://${LAN_IP}:4000`;
const CONTROLLER_BASE_URL = process.env.CONTROLLER_BASE_URL?.trim() || `http://${LAN_IP}:5176`;
const CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS?.trim() ||
  [
    `http://localhost:5173`,
    `http://127.0.0.1:5173`,
    `http://${LAN_IP}:5173`,
    `http://localhost:5174`,
    `http://127.0.0.1:5174`,
    `http://${LAN_IP}:5174`,
    `http://localhost:5176`,
    `http://127.0.0.1:5176`,
    `http://${LAN_IP}:5176`
  ].join(",");

const SERVICES = {
  api: {
    args: ["-F", "@home-ktv/api", "dev"],
    command: "pnpm",
    port: 4000
  },
  admin: {
    args: ["-F", "@home-ktv/admin", "dev"],
    command: "pnpm",
    port: 5174
  },
  controller: {
    args: ["-F", "@home-ktv/controller", "dev"],
    command: "pnpm",
    port: 5176
  },
  "tv-web": {
    args: ["-F", "@home-ktv/tv-web", "dev"],
    command: "pnpm",
    port: 5173
  }
};

const SERVICE_ALIASES = {
  "mobile-controller": "controller",
  "tv-player": "tv-web"
};

const command = process.argv[2] || "status";
const commandArg = process.argv[3];

await main(command, commandArg);

async function main(currentCommand, currentArg) {
  switch (currentCommand) {
    case "start":
      ensureDirs();
      for (const service of serviceNames()) {
        await startService(service);
      }
      await printUrls();
      return;
    case "stop":
      ensureDirs();
      for (const service of serviceNames()) {
        await stopService(service);
      }
      return;
    case "restart":
      ensureDirs();
      for (const service of serviceNames()) {
        await stopService(service);
      }
      for (const service of serviceNames()) {
        await startService(service);
      }
      await printUrls();
      return;
    case "status":
      ensureDirs();
      for (const service of serviceNames()) {
        reportStatus(service);
      }
      await printUrls();
      return;
    case "tail":
      ensureDirs();
      await tailLogs(currentArg);
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
  return ["api", "admin", "tv-web", "controller"];
}

function serviceLogPath(service) {
  return path.join(LOG_DIR, `${service}.log`);
}

function servicePidPath(service) {
  return path.join(PID_DIR, `${service}.pid`);
}

function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(PID_DIR, { recursive: true });
  mkdirSync(MEDIA_ROOT, { recursive: true });
}

async function startService(service) {
  const pidPath = servicePidPath(service);
  const logPath = serviceLogPath(service);

  if (isRunningFromPidFile(pidPath)) {
    const pid = readPid(pidPath);
    console.log(`${pad(service)} already running (pid ${pid})`);
    return;
  }

  const logFd = openSync(logPath, "a");
  writeHeader(logPath, service);

  const env = {
    ...process.env,
    CORS_ALLOWED_ORIGINS,
    CONTROLLER_BASE_URL,
    HOST: "0.0.0.0",
    MEDIA_ROOT,
    MEDIA_PATH_MAPPINGS,
    PORT: String(SERVICES[service].port),
    PUBLIC_BASE_URL: API_BASE_URL,
    TV_ROOM_SLUG: ROOM_SLUG,
    VITE_API_BASE_URL: API_BASE_URL
  };

  if (service === "api") {
    env.CONTROLLER_BASE_URL = CONTROLLER_BASE_URL;
    env.PUBLIC_BASE_URL = API_BASE_URL;
  } else {
    delete env.DATABASE_URL;
    delete env.CONTROLLER_BASE_URL;
    delete env.CORS_ALLOWED_ORIGINS;
    delete env.HOST;
    delete env.MEDIA_ROOT;
    delete env.MEDIA_PATH_MAPPINGS;
    delete env.PORT;
    delete env.PUBLIC_BASE_URL;
    delete env.TV_ROOM_SLUG;
  }

  const child = spawn(SERVICES[service].command, SERVICES[service].args, {
    cwd: ROOT_DIR,
    detached: true,
    env,
    stdio: ["ignore", logFd, logFd]
  });

  closeSync(logFd);
  child.unref();
  writeFileSync(pidPath, String(child.pid));
  await sleep(500);

  if (isProcessRunning(child.pid)) {
    console.log(`${pad(service)} started (pid ${child.pid}, log ${logPath})`);
    return;
  }

  rmSync(pidPath, { force: true });
  console.error(`${pad(service)} failed to start; see ${logPath}`);
}

async function stopService(service) {
  const pidPath = servicePidPath(service);
  if (!exists(pidPath)) {
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

  for (let attempt = 0; attempt < 10; attempt += 1) {
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
  if (!exists(pidPath)) {
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

  const child = spawn("tail", ["-f", ...files], {
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

function normalizeServiceName(service) {
  return SERVICE_ALIASES[service] ?? service;
}

async function printUrls() {
  const tvLocal = `http://localhost:5173/?apiBaseUrl=${API_BASE_URL}&roomSlug=${ROOM_SLUG}&deviceName=Living%20Room%20TV`;
  const tvLan = `http://${LAN_IP}:5173/?apiBaseUrl=${API_BASE_URL}&roomSlug=${ROOM_SLUG}&deviceName=Living%20Room%20TV`;
  const mobileControllerUrl = await resolveMobileControllerUrl();

  console.log("");
  console.log("URLs:");
  console.log(`  API health:        ${API_BASE_URL}/health`);
  console.log(`  Admin:             http://${LAN_IP}:5174/`);
  console.log(`  Mobile controller: ${mobileControllerUrl}`);
  console.log(`  TV local:          ${tvLocal}`);
  console.log(`  TV LAN:            ${tvLan}`);
  console.log("");
  console.log("Logs:");
  console.log(`  ${LOG_DIR}`);
}

async function resolveMobileControllerUrl() {
  const fallbackUrl = `${CONTROLLER_BASE_URL}/controller`;
  const snapshotUrl = `${API_BASE_URL}/rooms/${encodeURIComponent(ROOM_SLUG)}/snapshot`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await fetchJsonWithTimeout(snapshotUrl, 800);
      const pairing = snapshot && typeof snapshot === "object" && "pairing" in snapshot ? snapshot.pairing : null;
      if (pairing && typeof pairing === "object") {
        const controllerUrl =
          "controllerUrl" in pairing && typeof pairing.controllerUrl === "string" ? pairing.controllerUrl : null;
        const qrPayload = "qrPayload" in pairing && typeof pairing.qrPayload === "string" ? pairing.qrPayload : null;
        return controllerUrl || qrPayload || fallbackUrl;
      }
    } catch {}

    if (attempt < 4) {
      await sleep(300);
    }
  }

  return fallbackUrl;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function printUsage(error = false) {
  const output = [
    "Usage: pnpm dev:local <command> [service]",
    "",
    "Commands:",
    "  start              Start api, admin, tv-web, and controller",
    "  stop               Stop services started by this script",
    "  restart            Stop then start all services",
    "  status             Show service status and local URLs",
    "  tail [service]     Tail all logs, or one service log",
    "",
    "Environment overrides:",
    `  KTV_LAN_IP         LAN IP used in URLs, default: auto-detected (${LAN_IP})`,
    `  MEDIA_ROOT         Media root, default: ${MEDIA_ROOT}`,
    `  MEDIA_PATH_MAPPINGS Path mappings for indexed media, default: ${MEDIA_PATH_MAPPINGS || "(none)"}`,
    `  TV_ROOM_SLUG       Room slug, default: ${ROOM_SLUG}`,
    `  KTV_LOG_DIR        Log directory, default: ${LOG_DIR}`
  ].join("\n");

  (error ? console.error : console.log)(output);
}

function writeHeader(logPath, service) {
  const timestamp = new Date().toISOString();
  const lines = [
    "",
    `[${timestamp}] starting ${service}`,
    `LAN_IP=${LAN_IP} API_BASE_URL=${API_BASE_URL} CONTROLLER_BASE_URL=${CONTROLLER_BASE_URL} ROOM_SLUG=${ROOM_SLUG} MEDIA_ROOT=${MEDIA_ROOT} MEDIA_PATH_MAPPINGS=${MEDIA_PATH_MAPPINGS}`
  ].join("\n");
  writeFileSync(logPath, `${lines}\n`, { flag: "a" });
}

function detectDefaultMediaPathMappings() {
  const sourceRoot = "/mnt/nas/KTV歌曲";
  const macMountRoot = "/Volumes/nas/KTV歌曲";
  return existsSync(macMountRoot) ? `${sourceRoot}=${macMountRoot}` : "";
}

function detectLanIp(override) {
  if (override) {
    return override;
  }

  const interfaces = os.networkInterfaces();
  const preferredOrder = ["en0", "en1"];
  for (const name of preferredOrder) {
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

function isRunningFromPidFile(pidPath) {
  if (!exists(pidPath)) {
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

function exists(filePath) {
  try {
    return readFileSync(filePath, "utf8") !== undefined;
  } catch {
    return false;
  }
}

function ensureFile(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!exists(filePath)) {
    writeFileSync(filePath, "");
  }
}

function pad(value) {
  return value.padEnd(18);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
