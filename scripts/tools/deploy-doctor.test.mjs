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

test("buildDeployConfig resolves docker host paths relative to the compose directory", () => {
  const config = buildDeployConfig({
    env: {
      DOCKER_MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲",
      KTV_MEDIA_HOST_PATH: "../../runtime/media",
      KTV_NAS_HOST_PATH: "../../runtime/nas/KTV歌曲"
    },
    envFile: "/repo/deploy/docker/.env",
    mode: "docker",
    rootDir: "/repo"
  });

  assert.equal(config.mediaRoot, "/repo/runtime/media");
  assert.equal(config.nasHostPath, "/repo/runtime/nas/KTV歌曲");
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

test("buildDoctorReport retries transient public network failures", async () => {
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

  const attemptsByUrl = new Map();

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
        fetchImpl: async (url) => {
          const key = String(url);
          const attempts = (attemptsByUrl.get(key) ?? 0) + 1;
          attemptsByUrl.set(key, attempts);

          return {
            status: attempts === 1 && key.includes("127.0.0.1:4000") ? 502 : 200,
            async json() {
              return {
                activeAssetCount: 34385,
                latestRun: { status: "completed" },
                missingAssetCount: 0,
                songCount: 31893
              };
            }
          };
        },
        pathExists: () => true,
        wait: async () => {}
      }
    );

    assert.equal(report.summary.fail, 0);
    assert.equal(attemptsByUrl.get("http://127.0.0.1:4000/health"), 2);
    assert.equal(attemptsByUrl.get("http://127.0.0.1:4000/admin/ktv-index/diagnostics?sampleSize=3&sampleTimeoutMs=100"), 2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
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
        fetchImpl: async (url) => ({
          status: String(url).includes("/health") ? 500 : 200,
          async json() {
            return {
              activeAssetCount: 34385,
              audioTrackDistribution: [
                { audioTrackCount: 1, count: 12 },
                { audioTrackCount: 2, count: 260 }
              ],
              latestRun: { status: "completed" },
              missingAssetCount: 0,
              probeFailedCount: 2,
              probePendingCount: 100,
              probeCoveragePercent: 81.43,
              technicalStatusCounts: [
                { technicalStatus: "failed", count: 2 },
                { technicalStatus: "pending", count: 100 },
                { technicalStatus: "probed", count: 280 }
              ],
              songCount: 31893
            };
          }
        }),
        pathExists: () => true
      }
    );

    assert.equal(report.summary.fail, 1);
    assert.equal(report.checks.find((check) => check.name === "api health")?.status, "FAIL");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("buildDoctorReport includes raw KTV index diagnostics metrics", async () => {
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
        fetchImpl: async (url) => ({
          status: 200,
          async json() {
            assert.equal(String(url).includes("/admin/ktv-index/diagnostics"), true);
            return {
              activeAssetCount: 34385,
              audioTrackDistribution: [
                { audioTrackCount: 1, count: 12 },
                { audioTrackCount: 2, count: 260 }
              ],
              latestRun: { status: "completed" },
              missingAssetCount: 0,
              probeFailedCount: 2,
              probePendingCount: 100,
              probeCoveragePercent: 81.43,
              technicalStatusCounts: [
                { technicalStatus: "failed", count: 2 },
                { technicalStatus: "pending", count: 100 },
                { technicalStatus: "probed", count: 280 }
              ],
              songCount: 31893
            };
          }
        }),
        pathExists: () => true
      }
    );

    const check = report.checks.find((item) => item.name === "ktv index diagnostics");
    assert.equal(check?.status, "PASS");
    assert.match(check?.message ?? "", /active=34385/u);
    assert.match(check?.message ?? "", /probed=280/u);
    assert.match(check?.message ?? "", /pending=100/u);
    assert.match(check?.message ?? "", /failed=2/u);
    assert.match(check?.message ?? "", /coverage=81\.43%/u);
    assert.match(check?.message ?? "", /tracks:1=12/u);
    assert.match(check?.message ?? "", /latest=completed/u);
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
