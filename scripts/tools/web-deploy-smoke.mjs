#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_ROOM_SLUG = "living-room";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const report = await runWebDeploySmokeCheck(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.summary.fail > 0) {
    process.exitCode = 1;
  }
}

export function parseArgs(argv) {
  const options = {
    apiBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000",
    controllerBaseUrl: process.env.CONTROLLER_BASE_URL?.trim() || "http://127.0.0.1:5176",
    help: false,
    json: false,
    roomSlug: process.env.TV_ROOM_SLUG?.trim() || DEFAULT_ROOM_SLUG,
    tvWebBaseUrl: process.env.TV_WEB_BASE_URL?.trim() || "http://127.0.0.1:5173"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--api-base-url":
        options.apiBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--controller-base-url":
        options.controllerBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--tv-web-base-url":
        options.tvWebBaseUrl = readOptionValue(argv, ++index, arg);
        break;
      case "--room":
      case "--room-slug":
        options.roomSlug = readOptionValue(argv, ++index, arg);
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export async function runWebDeploySmokeCheck(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is unavailable");
  }

  const config = normalizeOptions(options);
  const checks = [];
  const controllerOrigin = originFor(config.controllerBaseUrl);
  const tvOrigin = originFor(config.tvWebBaseUrl);
  const controllerDeviceId = `smoke-controller-${Date.now()}`;
  const tvDeviceId = `smoke-tv-${Date.now()}`;

  checks.push(await checkCors(fetchImpl, config, controllerOrigin, "cors controller"));
  checks.push(await checkCors(fetchImpl, config, tvOrigin, "cors tv"));
  checks.push(await probePage(fetchImpl, "tv web", tvUrl(config)));
  checks.push(await probePage(fetchImpl, "controller web", controllerUrl(config)));
  checks.push(await probeDefaultApiBase(fetchImpl, "tv default api base", `${config.tvWebBaseUrl}/`, config.apiBaseUrl));
  checks.push(await probeDefaultApiBase(fetchImpl, "controller default api base", controllerUrl(config), config.apiBaseUrl));

  const bootstrap = await postJson(fetchImpl, apiUrl(config, "/player/bootstrap"), {
    roomSlug: config.roomSlug,
    deviceId: tvDeviceId,
    deviceName: "Smoke TV",
    capabilities: { runtime: "web-deploy-smoke" }
  }, { origin: tvOrigin });

  if (!bootstrap.response.ok) {
    checks.push(fail("runtime", "tv bootstrap", `HTTP ${bootstrap.response.status}`));
  } else {
    const token = readPairingToken(bootstrap.body);
    checks.push(token ? pass("runtime", "tv bootstrap", "registered and returned pairing token") : fail("runtime", "tv bootstrap", "missing pairing token"));

    const heartbeat = await postJson(fetchImpl, apiUrl(config, "/player/heartbeat"), {
      roomSlug: config.roomSlug,
      deviceId: tvDeviceId,
      currentQueueEntryId: null,
      playbackPositionMs: 0,
      health: "ok"
    }, { origin: tvOrigin });
    checks.push(heartbeat.response.ok ? pass("runtime", "tv heartbeat", "accepted") : fail("runtime", "tv heartbeat", `HTTP ${heartbeat.response.status}`));

    if (token) {
      const auth = await authenticateSmokeController(fetchImpl, config, controllerOrigin);
      checks.push(
        auth.cookie
          ? pass("runtime", "controller auth", auth.message)
          : fail("runtime", "controller auth", auth.message)
      );

      const controlSession = await postJson(
        fetchImpl,
        apiUrl(config, `/rooms/${encodeURIComponent(config.roomSlug)}/control-sessions`),
        {
          pairingToken: token,
          deviceId: controllerDeviceId,
          deviceName: "Smoke Controller"
        },
        auth.cookie ? { origin: controllerOrigin, cookie: auth.cookie } : { origin: controllerOrigin }
      );
      const tvOnline = controlSession.body?.snapshot?.tvPresence?.online === true;
      checks.push(
        controlSession.response.ok && tvOnline
          ? pass("runtime", "controller sees tv online", "tvPresence.online=true")
          : fail("runtime", "controller sees tv online", controlSession.response.ok ? "tvPresence.online was not true" : `HTTP ${controlSession.response.status}`)
      );
    }
  }

  const discovery = await getJson(
    fetchImpl,
    apiUrl(config, `/rooms/${encodeURIComponent(config.roomSlug)}/songs/discovery?seed=smoke&limit=3`),
    { origin: controllerOrigin }
  );
  const recommendedCount = Array.isArray(discovery.body?.recommended) ? discovery.body.recommended.length : 0;
  checks.push(
    discovery.response.ok && recommendedCount > 0
      ? pass("catalog", "song discovery", `recommended=${recommendedCount}`)
      : fail("catalog", "song discovery", discovery.response.ok ? "recommended list is empty" : `HTTP ${discovery.response.status}`)
  );

  return {
    checkedAt: new Date().toISOString(),
    config,
    summary: summarize(checks),
    checks
  };
}

async function checkCors(fetchImpl, config, origin, name) {
  const result = await getJson(fetchImpl, apiUrl(config, "/health"), { origin });
  const allowOrigin = getHeader(result.response, "access-control-allow-origin");
  if (result.response.ok && allowOrigin === origin) {
    return pass("cors", name, `${origin} allowed`);
  }
  return fail("cors", name, `expected access-control-allow-origin=${origin}, got ${allowOrigin || "missing"}`);
}

async function authenticateSmokeController(fetchImpl, config, origin) {
  const credentials = {
    phone: "9000000000",
    password: "smoke-pass",
    displayName: "Smoke Tester"
  };
  const register = await postJson(
    fetchImpl,
    apiUrl(config, "/controller/auth/register"),
    credentials,
    { origin }
  );
  if (register.response.ok) {
    const cookie = cookieHeaderFromSetCookie(register.response);
    return cookie ? { cookie, message: "registered smoke controller user" } : { cookie: "", message: "register did not return auth cookie" };
  }
  if (register.response.status !== 409) {
    return { cookie: "", message: `register HTTP ${register.response.status}` };
  }

  const login = await postJson(
    fetchImpl,
    apiUrl(config, "/controller/auth/login"),
    {
      phone: credentials.phone,
      password: credentials.password
    },
    { origin }
  );
  if (!login.response.ok) {
    return { cookie: "", message: `login HTTP ${login.response.status}` };
  }
  const cookie = cookieHeaderFromSetCookie(login.response);
  return cookie ? { cookie, message: "logged in smoke controller user" } : { cookie: "", message: "login did not return auth cookie" };
}

async function probePage(fetchImpl, name, url) {
  try {
    const response = await fetchImpl(url, { headers: { accept: "text/html" } });
    if (response.ok) {
      return pass("web", name, `HTTP ${response.status}`);
    }
    return fail("web", name, `HTTP ${response.status}`);
  } catch (error) {
    return fail("web", name, error instanceof Error ? error.message : String(error));
  }
}

async function probeDefaultApiBase(fetchImpl, name, pageUrl, expectedApiBaseUrl) {
  try {
    const pageResponse = await fetchImpl(pageUrl, { headers: { accept: "text/html" } });
    if (!pageResponse.ok) {
      return fail("web", name, `page HTTP ${pageResponse.status}`);
    }

    const html = await readText(pageResponse);
    const scriptUrls = extractScriptUrls(html, pageUrl);
    if (scriptUrls.length === 0) {
      return fail("web", name, "no script assets found");
    }

    for (const scriptUrl of scriptUrls) {
      const scriptResponse = await fetchImpl(scriptUrl, { headers: { accept: "application/javascript,text/javascript,*/*" } });
      if (!scriptResponse.ok) {
        return fail("web", name, `script HTTP ${scriptResponse.status}: ${scriptUrl}`);
      }
      const scriptText = await readText(scriptResponse);
      if (scriptText.includes(expectedApiBaseUrl)) {
        return pass("web", name, `${expectedApiBaseUrl} embedded`);
      }
    }

    return fail("web", name, `${expectedApiBaseUrl} not found in ${scriptUrls.length} script asset(s)`);
  } catch (error) {
    return fail("web", name, error instanceof Error ? error.message : String(error));
  }
}

async function getJson(fetchImpl, url, headers = {}) {
  return requestJson(fetchImpl, url, { headers });
}

async function postJson(fetchImpl, url, body, headers = {}) {
  return requestJson(fetchImpl, url, {
    body: JSON.stringify(body),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST"
  });
}

async function requestJson(fetchImpl, url, init) {
  try {
    const response = await fetchImpl(url, init);
    const body = await readBody(response);
    return { response, body };
  } catch (error) {
    return {
      response: {
        headers: new Map(),
        ok: false,
        status: 0
      },
      body: { error: error instanceof Error ? error.message : String(error) }
    };
  }
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
}

async function readText(response) {
  if (typeof response.text === "function") {
    return await response.text();
  }
  return "";
}

function extractScriptUrls(html, pageUrl) {
  const urls = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
    urls.push(new URL(match[1], pageUrl).toString());
  }
  return urls;
}

function readPairingToken(body) {
  const token = body?.pairing?.token ?? body?.snapshot?.pairing?.token;
  return typeof token === "string" && token.trim() ? token : "";
}

function normalizeOptions(options) {
  return {
    apiBaseUrl: cleanBaseUrl(options.apiBaseUrl),
    controllerBaseUrl: cleanBaseUrl(options.controllerBaseUrl),
    roomSlug: options.roomSlug?.trim() || DEFAULT_ROOM_SLUG,
    tvWebBaseUrl: cleanBaseUrl(options.tvWebBaseUrl)
  };
}

function apiUrl(config, pathname) {
  return `${config.apiBaseUrl}${pathname}`;
}

function tvUrl(config) {
  return `${config.tvWebBaseUrl}/`;
}

function controllerUrl(config) {
  return `${config.controllerBaseUrl}/controller`;
}

function originFor(url) {
  return new URL(url).origin;
}

function cleanBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("base URL is required");
  }
  return trimmed.replace(/\/$/u, "");
}

function getHeader(response, name) {
  if (typeof response.headers?.get === "function") {
    return response.headers.get(name);
  }
  if (typeof response.headers?.get === "undefined" && typeof response.headers?.[Symbol.iterator] === "function") {
    const lowerName = name.toLowerCase();
    for (const [key, value] of response.headers) {
      if (String(key).toLowerCase() === lowerName) {
        return String(value);
      }
    }
  }
  return response.headers?.[name] ?? response.headers?.[name.toLowerCase()] ?? null;
}

function cookieHeaderFromSetCookie(response) {
  const setCookieHeaders =
    typeof response.headers?.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [getHeader(response, "set-cookie")].filter(Boolean);
  const cookiePairs = setCookieHeaders
    .map((header) => String(header).split(";")[0]?.trim())
    .filter(Boolean);
  return cookiePairs.join("; ");
}

function summarize(checks) {
  return checks.reduce(
    (summary, check) => {
      summary.total += 1;
      summary[check.status.toLowerCase()] += 1;
      return summary;
    },
    { total: 0, pass: 0, fail: 0 }
  );
}

function pass(category, name, message) {
  return { category, name, status: "PASS", message };
}

function fail(category, name, message) {
  return { category, name, status: "FAIL", message };
}

function printReport(report) {
  console.log(`Web deploy smoke check (${report.checkedAt})`);
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(4)} ${check.category.padEnd(8)} ${check.name} - ${check.message}`);
  }
  console.log(`Summary: ${report.summary.pass}/${report.summary.total} passed, ${report.summary.fail} failed`);
}

function readOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node scripts/tools/web-deploy-smoke.mjs \\
    --api-base-url http://127.0.0.1:4002 \\
    --controller-base-url http://127.0.0.1:4276 \\
    --tv-web-base-url http://127.0.0.1:4273 \\
    --room living-room

Options:
  --api-base-url <url>
  --controller-base-url <url>
  --tv-web-base-url <url>
  --room <slug>
  --json
`);
}
