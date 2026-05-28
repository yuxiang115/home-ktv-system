import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDockerRunArgs,
  containerPathToHostPath,
  parseArgs,
  parseEnvText,
  resolveDeploymentEnv,
  summarizeResultsText
} from "./style-tagging-job.mjs";

test("parseArgs defaults to an external job root and safe JSONL tagging defaults", () => {
  const options = parseArgs(["start"], {}, new Date("2026-05-28T12:00:00.000Z"));

  assert.equal(options.command, "start");
  assert.equal(options.jobRoot, "/opt/home-ktv-jobs/style-tagging");
  assert.equal(options.containerName, "home-ktv-style-tags-job");
  assert.equal(options.image, "home-ktv-api:latest");
  assert.equal(options.network, "home-ktv_default");
  assert.equal(options.input, "/data/home-ktv-media/tagging/full/songs.jsonl");
  assert.equal(options.output, "/data/home-ktv-media/tagging/full/results-netease-full-concurrency5-20260528-120000.jsonl");
  assert.equal(options.concurrency, 5);
  assert.equal(options.progressEvery, 100);
  assert.equal(options.neteaseBaseUrl, "http://ktv-netease-api:3000");
});

test("parseArgs accepts help as a command", () => {
  const options = parseArgs(["help"]);

  assert.equal(options.command, "help");
  assert.equal(options.help, false);
});

test("parseEnvText handles comments, quotes, and blank values", () => {
  const env = parseEnvText(`
    # comment
    KTV_MEDIA_HOST_PATH=/srv/media
    DOCKER_MEDIA_ROOT="/data/media"
    NETEASE_API_BASE_URL=
    POSTGRES_PASSWORD='ktv secret'
  `);

  assert.deepEqual(env, {
    KTV_MEDIA_HOST_PATH: "/srv/media",
    DOCKER_MEDIA_ROOT: "/data/media",
    NETEASE_API_BASE_URL: "",
    POSTGRES_PASSWORD: "ktv secret"
  });
});

test("resolveDeploymentEnv applies docker deployment defaults", () => {
  const env = resolveDeploymentEnv(
    {
      KTV_MEDIA_HOST_PATH: "/srv/home-ktv-media",
      KTV_NAS_HOST_PATH: "/mnt/nas/KTV歌曲",
      DOCKER_DATABASE_URL: "postgres://ktv:ktv@postgres:5432/home_ktv",
      DOCKER_MEDIA_ROOT: "/data/home-ktv-media",
      DOCKER_MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/nas/KTV歌曲"
    },
    "/opt/home-ktv-system"
  );

  assert.equal(env.mediaHostPath, "/srv/home-ktv-media");
  assert.equal(env.mediaRoot, "/data/home-ktv-media");
  assert.equal(env.nasHostPath, "/mnt/nas/KTV歌曲");
  assert.equal(env.databaseUrl, "postgres://ktv:ktv@postgres:5432/home_ktv");
  assert.equal(env.mediaPathMappings, "/mnt/nas/KTV歌曲=/nas/KTV歌曲");
  assert.equal(env.neteaseApiBaseUrl, "http://ktv-netease-api:3000");
});

test("resolveDeploymentEnv resolves relative docker volume paths from deploy/docker", () => {
  const env = resolveDeploymentEnv(
    {
      KTV_MEDIA_HOST_PATH: "../../runtime/media",
      KTV_NAS_HOST_PATH: "../../runtime/nas/KTV歌曲"
    },
    "/opt/home-ktv-system"
  );

  assert.equal(env.mediaHostPath, "/opt/home-ktv-system/runtime/media");
  assert.equal(env.nasHostPath, "/opt/home-ktv-system/runtime/nas/KTV歌曲");
});

test("buildDockerRunArgs starts a standalone job container with mounted state and media", () => {
  const options = parseArgs(
    [
      "start",
      "--job-root",
      "/opt/jobs/style-tagging",
      "--output",
      "/data/home-ktv-media/tagging/full/results.jsonl"
    ],
    {},
    new Date("2026-05-28T12:00:00.000Z")
  );
  const deployment = resolveDeploymentEnv(
    {
      KTV_MEDIA_HOST_PATH: "/srv/home-ktv-media",
      KTV_NAS_HOST_PATH: "/mnt/nas/KTV歌曲",
      DOCKER_DATABASE_URL: "postgres://ktv:ktv@postgres:5432/home_ktv",
      LLM_API_KEY: "secret"
    },
    "/opt/home-ktv-system"
  );

  const args = buildDockerRunArgs(options, deployment, {
    logContainerPath: "/job/logs/style-tags.log"
  });

  assert.equal(args[0], "run");
  assert.ok(args.includes("-d"));
  assert.ok(args.includes("--name"));
  assert.ok(args.includes("home-ktv-style-tags-job"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("home-ktv_default"));
  assert.ok(args.includes("/opt/jobs/style-tagging:/job"));
  assert.ok(args.includes("/srv/home-ktv-media:/data/home-ktv-media"));
  assert.ok(args.includes("/mnt/nas/KTV歌曲:/nas/KTV歌曲:ro"));
  assert.ok(args.includes("home-ktv-api:latest"));

  const shell = args.at(-1);
  assert.match(shell, /tag:ktv-styles:jsonl/);
  assert.match(shell, /--concurrency 5/);
  assert.match(shell, /--base-url http:\/\/ktv-netease-api:3000/);
  assert.match(shell, /results\.jsonl/);
  assert.match(shell, /\/job\/logs\/style-tags\.log/);
});

test("containerPathToHostPath maps media container paths to host paths", () => {
  const deployment = resolveDeploymentEnv(
    {
      KTV_MEDIA_HOST_PATH: "/srv/home-ktv-media",
      DOCKER_MEDIA_ROOT: "/data/home-ktv-media"
    },
    "/opt/home-ktv-system"
  );

  assert.equal(
    containerPathToHostPath("/data/home-ktv-media/tagging/full/results.jsonl", deployment),
    "/srv/home-ktv-media/tagging/full/results.jsonl"
  );
});

test("summarizeResultsText counts JSONL statuses and tag counts", () => {
  const summary = summarizeResultsText(
    [
      JSON.stringify({ status: "tagged", tags: ["国语", "流行"] }),
      JSON.stringify({ status: "empty", tags: [] }),
      JSON.stringify({ status: "failed", errorMessage: "Netease API HTTP 401" })
    ].join("\n"),
    10
  );

  assert.deepEqual(summary, {
    total: 3,
    tagged: 1,
    empty: 1,
    failed: 1,
    tagsTotal: 2,
    maxTags: 2,
    progressPct: 30,
    averageTags: 0.67,
    taggedPct: 33.33,
    emptyPct: 33.33,
    failedPct: 33.33
  });
});
