// Browser regression test: the start watch in index.html (architecture.md §30).
//
//   node --test tests/e2e/start-watch.test.mjs
//
// What broke (2026-11-25): the app start awaited a call that gave no answer.
// The window stayed empty, with no message and no error. An empty app looks
// like lost notes, and the next step of a user is an uninstall that does
// delete the notes. Also the update check never ran, so the app could not
// load a repaired build.
//
// The test stalls the start in a real Chromium: indexedDB.open, the first
// await of store.start(), returns a request whose events never fire. Then it
// checks the message that the inline script in index.html shows, its two
// buttons, a slow start that ends the message by itself, and a start that
// fails at once.
//
// Plain Node + local Chromium via Chrome DevTools Protocol (no npm packages).
// Skips cleanly when no Chromium binary is available on the host.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = path.join(ROOT, "app");

// START_LIMIT in index.html is 10 s. The test allows 3 s more for a slow CI
// page load before it calls the message missing.
const MESSAGE_BY_MS = 13000;
const START_TIMEOUT_MS = 10000;

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

// The start waits with no end: no event of the open request ever fires,
// as for the WebView2 call of the incident.
const STALL = `IDBFactory.prototype.open = function () { return {}; };`;

// A slow start: each open waits until the test calls __releaseOpen(), then
// runs for real. openDb() (storage/idb.js) sets its handlers on the object
// it gets and reads result, transaction and error from it, so the stand-in
// forwards those to the real request.
const HOLD = `
  const realOpen = IDBFactory.prototype.open;
  const held = [];
  let released = false;
  window.__releaseOpen = () => {
    released = true;
    for (const run of held.splice(0)) run();
  };
  IDBFactory.prototype.open = function (...args) {
    if (released) return realOpen.apply(this, args);
    const factory = this;
    let real = null;
    const stand = {
      get result() { return real?.result; },
      get transaction() { return real?.transaction; },
      get error() { return real?.error; },
      get readyState() { return real ? real.readyState : "pending"; },
    };
    held.push(() => {
      real = realOpen.apply(factory, args);
      for (const type of ["upgradeneeded", "success", "error", "blocked"]) {
        real.addEventListener(type, (event) => stand["on" + type]?.call(stand, event));
      }
    });
    return stand;
  };
`;

// A start that fails: start() rejects, and main.js calls vrttiBoot.failed().
const FAIL = `IDBFactory.prototype.open = function () {
  throw new DOMException("e2e: indexedDB.open throws", "UnknownError");
};`;

// The message, or null. textContent: no layout is needed for the check.
const WATCH = `(() => {
  const el = document.getElementById("start-watch");
  return el ? { role: el.getAttribute("role"), text: el.textContent } : null;
})()`;

/** @param {string} label */
const clickButton = (label) => `(() => {
  const button = [...document.querySelectorAll("#start-watch button")].find((b) => b.textContent === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`;

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
  candidates.push(
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  );
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

function startServer() {
  return new Promise((resolve, reject) => {
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
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

class CdpClient {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {((msg: any) => void)[]} */
    this.listeners = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP socket error: " + String(e))));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id) {
        for (const fn of this.listeners) fn(msg);
        return;
      }
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
   * caller's assert names what failed. An eval during a navigation can throw
   * (the context is gone); that counts as "not yet".
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-start-watch-"));
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

const sleepUntil = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));

const chromePath = findChromium();

describe("the start watch", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;
  /** Console lines of the page, as text. */
  const lines = [];
  /** The script of the current test, removed after it. */
  let scriptId = null;
  let loads = 0;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    browser.cdp.listeners.push((msg) => {
      if (msg.method !== "Runtime.consoleAPICalled") return;
      lines.push(msg.params.args.map((a) => (typeof a.value === "string" ? a.value : a.description ?? "")).join(" "));
    });
  });

  // The hook of one test must not reach the documents of the next one.
  afterEach(async () => {
    if (scriptId) await browser.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
    scriptId = null;
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  /**
   * Loads the app with `hook` run before any page script. Each load marks
   * its documents with a token, so a poll never reads the page of the test
   * before. Returns the token check and the time of the navigation.
   * @param {string} query @param {string} [hook]
   */
  async function load(query, hook = "") {
    const token = String(++loads);
    lines.length = 0;
    const source = `window.__loadToken = ${JSON.stringify(token)};\n${hook}`;
    scriptId = (await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source })).identifier;
    const t0 = Date.now();
    await browser.cdp.send("Page.navigate", { url: srv.url + query });
    return { t0, mine: `window.__loadToken === ${JSON.stringify(token)}` };
  }

  /** The message of this load, or the last value at `deadline`. */
  async function waitForWatch(mine, deadline) {
    return browser.cdp.poll(`${mine} && ${WATCH}`, deadline - Date.now(), (w) => Boolean(w?.text));
  }

  /** Waits for a console line that starts with `prefix`. */
  async function waitForLine(prefix, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (lines.some((l) => l.startsWith(prefix))) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /**
   * After a click on "Load the newest build": the URL of the next document,
   * or undefined. __clicked marks the old document, so a URL change by
   * history.replaceState would not count as a navigation.
   */
  async function waitForReload(timeoutMs) {
    return browser.cdp.poll(`!window.__clicked && document.readyState !== "loading" && location.href`, timeoutMs);
  }

  // Passes on the old code too, on purpose: it guards against a false alarm
  // on a healthy start.
  test("a normal start shows no message, also after the time limit", async () => {
    const { cdp } = browser;
    const { t0, mine } = await load("");
    const started = await cdp.poll(`${mine} && typeof window.vrtti === "object"`, START_TIMEOUT_MS);
    assert.ok(started, "the app did not start (window.vrtti is undefined)");
    assert.equal(await cdp.eval(WATCH), null, "a started app must show no start watch");
    // Time is the subject here: past START_LIMIT the timer must be cleared.
    await sleepUntil(t0 + 11000);
    assert.equal(await cdp.eval(`${mine} && ${WATCH}`), null, "the message came after a normal start (timer not cleared)");
  });

  test("a start that waits with no end shows the message after 10 s", async () => {
    const { cdp } = browser;
    const { t0, mine } = await load("", STALL);
    // Time is the subject: the message must not come early.
    await sleepUntil(t0 + 5000);
    assert.equal(await cdp.eval(mine), true, "the stalled page did not load");
    assert.equal(await cdp.eval(WATCH), null, "the message came before START_LIMIT");
    assert.equal(await cdp.eval(`typeof window.vrtti`), "undefined", "the start did not stall; the test proves nothing");

    const watch = await waitForWatch(mine, t0 + MESSAGE_BY_MS);
    assert.ok(watch?.text, `no #start-watch ${MESSAGE_BY_MS / 1000} s after the navigation`);
    assert.equal(watch.role, "alert", "#start-watch must have role=alert");
    assert.match(watch.text, /vrtti did not start/);
    assert.match(watch.text, /Your notes are on this device/);
    assert.match(watch.text, /Do not uninstall/);
    assert.ok(
      await waitForLine("[vrtti] start watch: no start after 10 s", 2000),
      "no console line '[vrtti] start watch: no start after 10 s'; lines: " + JSON.stringify(lines.filter((l) => l.startsWith("[vrtti]")))
    );
  });

  test("'Close this message' removes the message", async () => {
    const { cdp } = browser;
    const { t0, mine } = await load("", STALL);
    assert.ok((await waitForWatch(mine, t0 + MESSAGE_BY_MS))?.text, "no #start-watch to close");
    assert.equal(await cdp.eval(clickButton("Close this message")), true, "no button 'Close this message'");
    const gone = await cdp.poll(`${mine} && ${WATCH} === null`, 2000);
    assert.equal(gone, true, "#start-watch is still there after 'Close this message'");
  });

  test("'Load the newest build' deletes the caches and reloads with fresh= and the same ws=", async () => {
    const { cdp } = browser;
    const { t0, mine } = await load("?ws=abc", STALL);
    assert.ok((await waitForWatch(mine, t0 + MESSAGE_BY_MS))?.text, "no #start-watch with the repair button");
    const before = await cdp.eval(`caches.open("probe").then(() => caches.keys())`);
    assert.ok(before.includes("probe"), "the probe cache was not created");

    assert.equal(await cdp.eval(`window.__clicked = true; ${clickButton("Load the newest build")}`), true, "no button 'Load the newest build'");
    const href = await waitForReload(10000);
    assert.ok(href, "the page did not navigate after 'Load the newest build'");
    const url = new URL(href);
    assert.match(url.searchParams.get("fresh") ?? "", /^\d+$/, "the new URL must carry fresh=<ms>: " + href);
    assert.equal(url.searchParams.get("ws"), "abc", "the new URL must keep ws=abc: " + href);
    const keys = await cdp.eval(`caches.keys()`);
    assert.ok(!keys.includes("probe"), "the caches were not deleted: " + JSON.stringify(keys));
  });

  test("the repair reloads also when caches.keys() gives no answer", async (t) => {
    const { cdp } = browser;
    const { t0, mine } = await load("?ws=abc", STALL);
    assert.ok((await waitForWatch(mine, t0 + MESSAGE_BY_MS))?.text, "no #start-watch with the repair button");
    await cdp.eval(`caches.keys = () => new Promise(() => {}); true`);

    const clickedAt = Date.now();
    assert.equal(await cdp.eval(`window.__clicked = true; ${clickButton("Load the newest build")}`), true, "no button 'Load the newest build'");
    const href = await waitForReload(10000);
    const took = Date.now() - clickedAt;
    t.diagnostic(`navigation ${took} ms after the click`);
    assert.ok(href, "the page did not navigate within 10 s, with caches.keys() giving no answer");
    assert.ok(took <= 8000, `the navigation came ${took} ms after the click (limit 8000)`);
    assert.match(new URL(href).searchParams.get("fresh") ?? "", /^\d+$/, "the new URL must carry fresh=<ms>: " + href);
  });

  test("a slow start removes its own message when it completes", async () => {
    const { cdp } = browser;
    const { t0, mine } = await load("", HOLD);
    assert.ok((await waitForWatch(mine, t0 + MESSAGE_BY_MS))?.text, "no #start-watch while the start waits");

    await cdp.eval(`window.__releaseOpen()`);
    const state = await cdp.poll(
      `${mine} && ({ vrtti: typeof window.vrtti === "object", watch: Boolean(document.getElementById("start-watch")) })`,
      START_TIMEOUT_MS,
      (s) => s?.vrtti && !s.watch
    );
    assert.equal(state?.vrtti, true, "the app did not start after the hold ended");
    assert.equal(state?.watch, false, "#start-watch stayed after the start completed");
  });

  test("a start that fails shows the message at once", async () => {
    const { t0, mine } = await load("", FAIL);
    const watch = await waitForWatch(mine, t0 + 3000);
    assert.ok(watch?.text, "no #start-watch within 3 s of a start that failed");
    assert.match(watch.text, /vrtti did not start/);
    assert.ok(
      await waitForLine("[vrtti] start watch: the start failed", 2000),
      "no console line '[vrtti] start watch: the start failed'; lines: " + JSON.stringify(lines.filter((l) => l.startsWith("[vrtti]")))
    );
  });
});
