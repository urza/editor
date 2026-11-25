// Browser regression test: a sync request with no answer ends the round as
// an error, and the next round runs (architecture.md §30).
//
//   node --test tests/e2e/sync-no-answer.test.mjs
//
// What broke: request() in sync/client.js had no time limit. A server that
// took a request and never answered held the round for ever. syncNow() runs
// one round at a time, and its `running` flag clears in a `finally` that a
// promise that never settles does not reach. So the status stayed "syncing",
// and every later call only set `queued`: sync stopped until a reload.
//
// The test puts a proxy in front of the real Vrtti.Server. The proxy can
// hold each request open and never end it, so the real fetch and the real
// abort of the page run. With LIMITS.request shortened to 500 ms, the round
// must end as "no answer from the server". When the proxy passes requests
// again, the next round must reach the server and end as idle: that proves
// the `running` flag is free.
//
// Zero npm dependencies: plain Node + local Chromium via CDP + local dotnet.
// Skips cleanly when Chromium or dotnet is not installed on the host.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = path.join(ROOT, "app");
const SERVER_PROJ = path.join(ROOT, "server", "Vrtti.Server");
// Outside the source tree and built on every run (incremental), as in
// spellcheck-sync-e2e: a dll in bin/ from an older checkout would test the
// wrong server. A folder of its own, so two e2e files never build into the
// same folder at the same time.
const SERVER_BUILD = path.join(os.tmpdir(), "vrtti-sync-no-answer-e2e-build");

const START_TIMEOUT_MS = 10000;
// LIMITS.request in the page during the hold. Short, so no test waits for
// the real minute.
const SHORT_LIMIT_MS = 500;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".dic": "text/plain; charset=utf-8",
  ".aff": "text/plain; charset=utf-8",
};

function findChromium() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const pwCache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pwCache)) {
    for (const entry of fs.readdirSync(pwCache).sort().reverse()) {
      if (entry.startsWith("chromium-")) {
        candidates.push(path.join(pwCache, entry, "chrome-linux64", "chrome"));
        candidates.push(path.join(pwCache, entry, "chrome-linux", "chrome"));
      }
      if (entry.startsWith("chromium_headless_shell-")) {
        candidates.push(path.join(pwCache, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"));
      }
    }
  }
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

function hasDotnet() {
  try {
    execFileSync("dotnet", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

/** @param {http.Server} server */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

/** @param {http.Server} server */
async function closeHttp(server) {
  // Held requests keep their sockets open; server.close() alone would wait.
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

async function startStaticServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(APP_DIR, rel);
    if (!file.startsWith(APP_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  const origin = await listen(server);
  return { server, origin, url: origin + "/" };
}

function buildServer() {
  execFileSync("dotnet", ["build", SERVER_PROJ, "-c", "Debug", "--artifacts-path", SERVER_BUILD], { stdio: "pipe" });
  const dll = path.join(SERVER_BUILD, "bin", "Vrtti.Server", "debug", "Vrtti.Server.dll");
  if (!fs.existsSync(dll)) throw new Error("no server build at " + dll);
  return dll;
}

async function startSyncServer(dll, origin) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-sync-no-answer-e2e-"));
  const token = "sync-no-answer-e2e-token-1357";
  const proc = spawn("dotnet", [dll], {
    env: {
      ...process.env,
      VRTTI_TOKEN: token,
      VRTTI_DB: path.join(dataDir, "vrtti.db"),
      VRTTI_ORIGINS: origin,
      ASPNETCORE_URLS: url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (d) => (logs += String(d)));
  proc.stderr.on("data", (d) => (logs += String(d)));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + "/api/health");
      if (r.ok) {
        return {
          url,
          token,
          async close() {
            proc.kill("SIGTERM");
            await new Promise((res) => {
              proc.once("exit", res);
              setTimeout(res, 2000);
            });
            fs.rmSync(dataDir, { recursive: true, force: true });
          },
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill("SIGKILL");
  throw new Error("Vrtti.Server failed to start:\n" + logs);
}

/**
 * A proxy in front of the sync server. With `hold` set it reads each request
 * and never answers it, as a server that hangs. Else it passes everything
 * through, the CORS preflight too.
 * @param {string} target
 */
async function startHoldProxy(target) {
  const upstream = new URL(target);
  const proxy = {
    url: "",
    hold: false,
    // held: requests that got no answer. passed: requests that reached the
    // server, preflights not counted.
    stats: { held: 0, passed: 0 },
    close: () => closeHttp(server),
  };
  const server = http.createServer((req, res) => {
    if (proxy.hold) {
      proxy.stats.held++;
      req.resume();
      return;
    }
    if (req.method !== "OPTIONS") proxy.stats.passed++;
    const up = http.request(
      { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  proxy.url = await listen(server);
  return proxy;
}

class CdpClient {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP socket error: " + String(e))));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  /** @param {string} method @param {object} [params] */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** @param {string} expression */
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  /**
   * Polls `expression` until `done(value)` and returns the value, or returns
   * the last value at the deadline. It does not throw on a timeout, so the
   * caller's assert names what failed.
   * @param {string} expression @param {number} timeoutMs
   * @param {(value: any) => boolean} [done]
   */
  async poll(expression, timeoutMs, done = Boolean) {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
      value = await this.eval(expression).catch(() => undefined);
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    return value;
  }

  close() {
    this.ws.close();
  }
}

/** @param {string} chromePath */
async function launchBrowser(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-sync-no-answer-prof-"));
  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const port = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start:\n" + stderr)), 15000);
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}):\n${stderr}`));
    });
  });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("No page target found");

  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function close() {
    try {
      cdp.close();
    } catch {}
    proc.kill("SIGTERM");
    await new Promise((r) => {
      proc.once("exit", r);
      setTimeout(r, 2000);
    });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { cdp, close };
}

/**
 * Sets LIMITS.request on the page's own module instance. The old code has no
 * timelimit.js: the import fails there, and the test must then fail at its
 * check of the behaviour, not here. Returns whether the module was there.
 * @param {number} ms
 */
const setRequestLimit = (ms) => `(async () => {
  try {
    (await import("./js/model/timelimit.js")).LIMITS.request = ${ms};
    return true;
  } catch {
    return false;
  }
})()`;

// A sync round starts and the eval does not wait for it: on the old code
// the round never settles.
const SYNC_NOW = `void window.vrtti.sync.syncNow(); true`;
const STATUS = `(() => { const s = window.vrtti.sync.status; return { state: s.state, message: s.message ?? null }; })()`;

const chromePath = findChromium();
const dotnetReady = hasDotnet();

describe(
  "a sync request with no answer",
  { skip: (!chromePath && "no Chromium binary") || (!dotnetReady && "no dotnet SDK") },
  () => {
    let staticSrv;
    let syncSrv;
    let proxy;
    /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
    let browser;

    before(async () => {
      staticSrv = await startStaticServer();
      syncSrv = await startSyncServer(buildServer(), staticSrv.origin);
      proxy = await startHoldProxy(syncSrv.url);
      browser = await launchBrowser(/** @type {string} */ (chromePath));
      const { cdp } = browser;
      await cdp.send("Page.navigate", { url: staticSrv.url });
      assert.ok(await cdp.poll(`typeof window.vrtti === "object"`, START_TIMEOUT_MS), "the app did not start");
      // The device talks to the proxy, so every request of the client
      // passes the hold.
      await cdp.eval(`(async () => {
        await window.vrtti.keyring.setup({ deviceName: "Desktop", askPassphrase: false, firstDevice: true });
        await window.vrtti.sync.registerFirst(${JSON.stringify(proxy.url)}, ${JSON.stringify(syncSrv.token)});
        await window.vrtti.sync.syncNow();
      })()`);
      // A round that a registration or a timer started may still run.
      const status = await cdp.poll(STATUS, START_TIMEOUT_MS, (s) => s?.state === "idle");
      assert.equal(status?.state, "idle", "sync did not reach idle before the hold: " + JSON.stringify(status));
      assert.ok(proxy.stats.passed > 0, "no request of the setup reached the server through the proxy");
    });

    after(async () => {
      if (browser) await browser.close();
      if (proxy) await proxy.close();
      if (syncSrv) await syncSrv.close();
      if (staticSrv) await closeHttp(staticSrv.server);
    });

    test("the round ends as 'no answer from the server'", async (t) => {
      const { cdp } = browser;
      const hasModule = await cdp.eval(setRequestLimit(SHORT_LIMIT_MS));
      t.diagnostic("model/timelimit.js " + (hasModule ? "loaded" : "missing (old code)"));

      proxy.hold = true;
      const heldBefore = proxy.stats.held;
      await cdp.eval(SYNC_NOW);
      const status = await cdp.poll(STATUS, 5000, (s) => s?.state === "error");
      assert.ok(proxy.stats.held > heldBefore, "no request reached the proxy during the hold; the test proves nothing");
      assert.equal(status?.state, "error", "the round did not end within 5 s: " + JSON.stringify(status));
      assert.equal(status?.message, "no answer from the server");
    });

    // Runs on the page that the test above left: a round that waited with no
    // end before. A new round can only start when `running` is free.
    test("the next round reaches the server and ends as idle", async () => {
      const { cdp } = browser;
      proxy.hold = false;
      // The real limit again: a real answer of the server can take more
      // than 500 ms on a busy host.
      await cdp.eval(setRequestLimit(60000));
      const passedBefore = proxy.stats.passed;
      await cdp.eval(SYNC_NOW);
      const status = await cdp.poll(STATUS, START_TIMEOUT_MS, (s) => s?.state === "idle");
      assert.ok(proxy.stats.passed > passedBefore, "the next sync sent no request to the server (the round is still held)");
      assert.equal(status?.state, "idle", "the next round did not end as idle: " + JSON.stringify(status));
    });
  }
);
