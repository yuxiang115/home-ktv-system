import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDeployConfig,
  buildDoctorReport,
  checkCors,
  checkMediaPaths,
  loadEnvFile,
  parseArgs,
  parsePathMappings
} from "./deploy-doctor.mjs";

test("loadEnvFile parses comments and quoted values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "home-ktv-doctor-"));
  const envFile = path.join(dir, ".env");
  await writeFile(
    envFile,
    [
      "# comment",
      "PUBLIC_BASE_URL=http://127.0.0.1:4000",
      "CONTROLLER_BASE_URL='http://127.0.0.1:5176'",
      'CORS_ALLOWED_ORIGINS="http://127.0.0.1:5174,http://127.0.0.1:5176"'
    ].join("\n")
  );

  try {
    assert.deepEqual(loadEnvFile(envFile), {
      CONTROLLER_BASE_URL: "http://127.0.0.1:5176",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:5174,http://127.0.0.1:5176",
      PUBLIC_BASE_URL: "http://127.0.0.1:4000"
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("buildDeployConfig derives Admin, Controller, and Web TV URLs", () => {
  const config = buildDeployConfig({
    env: {
      CORS_ALLOWED_ORIGINS: "http://10.0.0.2:5174,http://10.0.0.2:5176,http://10.0.0.2:5173",
      DOCKER_DATABASE_URL: "postgres://ktv:ktv@postgres:5432/home_ktv",
      DOCKER_MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲",
      KTV_NAS_HOST_PATH: "/mnt/nas/KTV歌曲",
      PUBLIC_BASE_URL: "http://10.0.0.2:4000",
      TV_ROOM_SLUG: "living-room"
    },
    envFile: "/tmp/.env",
    mode: "docker",
    rootDir: "/repo"
  });

  assert.equal(config.adminBaseUrl, "http://10.0.0.2:5174");
  assert.equal(config.controllerBaseUrl, "http://10.0.0.2:5176");
  assert.equal(config.tvWebBaseUrl, "http://10.0.0.2:5173");
  assert.equal(config.roomSlug, "living-room");
});

test("checkCors warns when Web TV origin is missing", () => {
  const config = buildDeployConfig({
    env: {
      CONTROLLER_BASE_URL: "http://10.0.0.2:5176",
      CORS_ALLOWED_ORIGINS: "http://10.0.0.2:5174,http://10.0.0.2:5176",
      PUBLIC_BASE_URL: "http://10.0.0.2:4000",
      TV_WEB_PORT: "5173"
    },
    envFile: "/tmp/.env",
    mode: "docker",
    rootDir: "/repo"
  });

  assert.equal(checkCors(config).find((check) => check.name === "http://10.0.0.2:5173")?.status, "WARN");
});

test("checkMediaPaths verifies indexed NAS mapping and readable path", () => {
  const config = buildDeployConfig({
    env: {
      DOCKER_MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲",
      KTV_NAS_HOST_PATH: "/mnt/nas/KTV歌曲"
    },
    envFile: "/tmp/.env",
    mode: "docker",
    rootDir: "/repo"
  });

  const checks = checkMediaPaths(config, {
    canReadPath: () => true,
    pathExists: () => true
  });

  assert.equal(checks.find((check) => check.name === "KTV_NAS_HOST_PATH")?.status, "PASS");
  assert.equal(checks.find((check) => check.name === "indexed NAS mapping")?.status, "PASS");
});

test("buildDoctorReport returns FAIL when API health probe fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "home-ktv-doctor-"));
  const envFile = path.join(dir, ".env");
  await writeFile(
    envFile,
    [
      "PUBLIC_BASE_URL=http://127.0.0.1:4000",
      "CONTROLLER_BASE_URL=http://127.0.0.1:5176",
      "CORS_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://127.0.0.1:5176,http://127.0.0.1:5173",
      "DOCKER_DATABASE_URL=postgres://ktv:ktv@postgres:5432/home_ktv",
      "KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲",
      "DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲"
    ].join("\n")
  );

  try {
    const report = await buildDoctorReport(
      {
        envFile,
        json: false,
        mode: "docker",
        serviceStatusCmd: "",
        skipNetwork: false
      },
      {
        canReadPath: () => true,
        fetchImpl: async (url) => ({ status: String(url).includes("/health") ? 500 : 200 }),
        pathExists: () => true
      }
    );

    assert.equal(report.summary.fail, 1);
    assert.equal(report.checks.find((check) => check.name === "api health")?.status, "FAIL");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("parseArgs and parsePathMappings expose CLI and mapping primitives", () => {
  assert.deepEqual(parseArgs(["--", "--mode", "source", "--env-file", "server.env", "--skip-network", "--json"]), {
    envFile: "server.env",
    help: false,
    json: true,
    mode: "source",
    serviceStatusCmd: "",
    skipNetwork: true
  });
  assert.deepEqual(parsePathMappings("/mnt/nas/KTV歌曲=/nas/KTV歌曲,/media=/data"), [
    { from: "/mnt/nas/KTV歌曲", to: "/nas/KTV歌曲" },
    { from: "/media", to: "/data" }
  ]);
});
