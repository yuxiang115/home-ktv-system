import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, runWebDeploySmokeCheck } from "./web-deploy-smoke.mjs";

test("runWebDeploySmokeCheck verifies CORS, TV presence, page reachability, and discovery", async () => {
  const calls = [];
  const report = await runWebDeploySmokeCheck(
    {
      apiBaseUrl: "http://127.0.0.1:4002",
      controllerBaseUrl: "http://127.0.0.1:4276",
      roomSlug: "living-room",
      tvWebBaseUrl: "http://127.0.0.1:4273"
    },
    {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const pathname = new URL(String(url)).pathname;
        const origin = init.headers?.origin ?? init.headers?.Origin;
        if (pathname === "/health") {
          return jsonResponse({ status: "ok" }, { "access-control-allow-origin": origin ?? "" });
        }
        if (String(url) === "http://127.0.0.1:4273/") {
          return textResponse('<html><script type="module" src="/assets/tv.js"></script></html>');
        }
        if (String(url) === "http://127.0.0.1:4273/assets/tv.js") {
          return textResponse('const apiBaseUrl = "http://127.0.0.1:4002";');
        }
        if (String(url) === "http://127.0.0.1:4276/controller?room=living-room") {
          return textResponse('<html><script type="module" src="/assets/controller.js"></script></html>');
        }
        if (String(url) === "http://127.0.0.1:4276/") {
          return textResponse('<html><script type="module" src="/assets/controller.js"></script></html>');
        }
        if (String(url) === "http://127.0.0.1:4276/assets/controller.js") {
          return textResponse('const apiBaseUrl = "http://127.0.0.1:4002";');
        }
        if (pathname === "/player/bootstrap") {
          return jsonResponse({
            status: "registered",
            pairing: { token: "pair-token" },
            snapshot: { pairing: { token: "pair-token" } }
          }, { "access-control-allow-origin": origin ?? "" });
        }
        if (pathname === "/player/heartbeat") {
          return jsonResponse({ status: "ok" }, { "access-control-allow-origin": origin ?? "" });
        }
        if (pathname === "/rooms/living-room/control-sessions") {
          return jsonResponse({
            snapshot: {
              tvPresence: { online: true, deviceName: "Smoke TV", lastSeenAt: "2026-05-28T00:00:00.000Z" }
            }
          }, { "access-control-allow-origin": origin ?? "" });
        }
        if (pathname === "/rooms/living-room/songs/discovery") {
          return jsonResponse({
            recommended: [{ songId: "song-1", title: "想你的夜", artistName: "关喆" }]
          }, { "access-control-allow-origin": origin ?? "" });
        }
        return textResponse("not found", 404);
      }
    }
  );

  assert.equal(report.summary.fail, 0);
  assert.equal(report.checks.every((check) => check.status === "PASS"), true);
  assert.equal(report.checks.some((check) => check.name === "tv default api base"), true);
  assert.equal(report.checks.some((check) => check.name === "controller default api base"), true);
  assert.equal(calls.some((call) => call.url.includes("/player/bootstrap")), true);
  assert.equal(calls.some((call) => call.url.includes("/control-sessions")), true);
});

test("runWebDeploySmokeCheck fails when CORS is missing for TV origin", async () => {
  const report = await runWebDeploySmokeCheck(
    {
      apiBaseUrl: "http://127.0.0.1:4002",
      controllerBaseUrl: "http://127.0.0.1:4276",
      roomSlug: "living-room",
      tvWebBaseUrl: "http://127.0.0.1:4273"
    },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/health")) {
          return jsonResponse({ status: "ok" });
        }
        return textResponse("<html></html>");
      }
    }
  );

  assert.equal(report.summary.fail > 0, true);
  assert.equal(report.checks.find((check) => check.name === "cors tv")?.status, "FAIL");
});

test("parseArgs reads local preview URLs", () => {
  assert.deepEqual(
    parseArgs([
      "--api-base-url",
      "http://127.0.0.1:4002",
      "--controller-base-url",
      "http://127.0.0.1:4276",
      "--tv-web-base-url",
      "http://127.0.0.1:4273",
      "--room",
      "living-room",
      "--json"
    ]),
    {
      apiBaseUrl: "http://127.0.0.1:4002",
      controllerBaseUrl: "http://127.0.0.1:4276",
      help: false,
      json: true,
      roomSlug: "living-room",
      tvWebBaseUrl: "http://127.0.0.1:4273"
    }
  );
});

test("parseArgs ignores pnpm forwarded argument separator", () => {
  assert.equal(
    parseArgs(["--", "--api-base-url", "http://127.0.0.1:4002"]).apiBaseUrl,
    "http://127.0.0.1:4002"
  );
});

function jsonResponse(body, headers = {}, status = 200) {
  return {
    headers: new Map(Object.entries(headers)),
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

function textResponse(body, status = 200) {
  return {
    headers: new Map(),
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  };
}
