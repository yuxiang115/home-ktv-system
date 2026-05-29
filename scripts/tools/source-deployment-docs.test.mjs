import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

test("source deployment help exposes one-command deploy and smoke checks", async () => {
  const result = await run("bash", ["deploy/source/ktv.sh", "help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /deploy\s+Pull, install, build, migrate, restart, doctor, and smoke test/u);
  assert.match(result.stdout, /smoke\s+Run public web deployment smoke checks/u);
});

test("deployment docs make source deployment the server default", async () => {
  const deployment = await readText("docs/deployment.md");
  const lxcRunbook = await readText("docs/runbooks/deploy-lxc-dev.md");

  assert.match(deployment, /服务器优先使用源码部署/u);
  assert.match(deployment, /Docker Compose.*稳定发布和备用/u);
  assert.match(lxcRunbook, /HomeKTV source deployment/u);
  assert.match(lxcRunbook, /bash deploy\/source\/ktv\.sh deploy/u);
});

test("source deployment preview commands pass ports to vite", async () => {
  const sourceScript = await readText("deploy/source/ktv-source.mjs");

  assert.doesNotMatch(sourceScript, /"preview",\s*"--",\s*"--host"/u);
  assert.match(sourceScript, /"preview",\s*"--host",\s*"0\.0\.0\.0",\s*"--port",\s*"5174"/u);
  assert.match(sourceScript, /"preview",\s*"--host",\s*"0\.0\.0\.0",\s*"--port",\s*"5176"/u);
  assert.match(sourceScript, /"preview",\s*"--host",\s*"0\.0\.0\.0",\s*"--port",\s*"5173"/u);
});

async function readText(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}
