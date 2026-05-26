import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("status prints pairing-token mobile controller URL when API snapshot is available", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "home-ktv-dev-local-"));
  const server = createServer((request, response) => {
    if (request.url === "/rooms/living-room/snapshot") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pairing: {
            controllerUrl: "http://phone.local:5176/controller?room=living-room&token=pair-token"
          }
        })
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await runNodeScript(["scripts/dev/dev-local.mjs", "status"], {
      KTV_LOG_DIR: logDir,
      KTV_LAN_IP: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CONTROLLER_BASE_URL: "http://phone.local:5176",
      MEDIA_ROOT: path.join(logDir, "media")
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Mobile controller: http:\/\/phone\.local:5176\/controller\?room=living-room&token=pair-token/);
    assert.doesNotMatch(result.stdout, /Mobile controller: http:\/\/phone\.local:5176\/controller\?room=living-room\n/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(logDir, { recursive: true, force: true });
  }
});

test("help documents the media path mapping passed to the API service", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "home-ktv-dev-local-"));

  try {
    const result = await runNodeScript(["scripts/dev/dev-local.mjs", "help"], {
      KTV_LOG_DIR: logDir,
      KTV_LAN_IP: "127.0.0.1",
      MEDIA_ROOT: path.join(logDir, "media"),
      MEDIA_PATH_MAPPINGS: "/mnt/nas/KTV歌曲=/Volumes/nas/KTV歌曲"
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /MEDIA_PATH_MAPPINGS Path mappings for indexed media/);
    assert.match(result.stdout, /\/mnt\/nas\/KTV歌曲=\/Volumes\/nas\/KTV歌曲/);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

function runNodeScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: { ...process.env, ...env }
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
      resolve({ code, stdout, stderr });
    });
  });
}
