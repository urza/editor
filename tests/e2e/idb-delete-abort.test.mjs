// Browser regression test: a database delete whose transaction aborts must
// end with an error (architecture.md §30, "Database deletes").
//
//   node --test tests/e2e/idb-delete-abort.test.mjs
//
// What broke: deleteBuffer, deleteWorkspace and deleteHandle in
// storage/idb.js had onerror and oncomplete, and no onabort. A transaction
// can abort with no request error (a full disk at commit). Then neither
// handler ran, and the caller waited with no end.
//
// The test makes that abort in a real Chromium: IDBObjectStore.delete gets a
// success listener that aborts the transaction. At that point the request is
// done, so the abort fires no request error and only the abort event of the
// transaction. (An abort while the request is pending fires a request error,
// and the old code handled that, so it would prove nothing.) Each delete
// races a 2 s timer and must reject. One guard case with no abort checks
// that each delete still resolves.
//
// Plain Node + local Chromium via Chrome DevTools Protocol (no npm packages).
// Skips cleanly when no Chromium binary is available on the host.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = path.join(ROOT, "app");

const START_TIMEOUT_MS = 10000;
// A delete takes a few ms. 2 s is far past that, and short enough that a
// wait with no end fails fast.
const WAIT_MS = 2000;
// A key that no app code deletes, so the abort hits only the test's calls.
const KEY = "x";

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
   * the last value at the deadline. An eval during a navigation can throw
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-idb-delete-abort-"));
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
 * Runs `idb[name](KEY)` in the page against a 2 s timer. With `abort`, the
 * transaction aborts after the delete request succeeds. Returns how the call
 * ended ("resolved", "rejected" or "waited") and how many aborts the wrap
 * made, so a wrap that never fired cannot pass for a fix.
 * @param {string} name @param {boolean} abort
 */
const deleteCall = (name, abort) => `(async () => {
  const idb = await import("./js/storage/idb.js");
  const original = IDBObjectStore.prototype.delete;
  let aborts = 0;
  if (${abort}) {
    IDBObjectStore.prototype.delete = function (key, ...rest) {
      const request = original.call(this, key, ...rest);
      if (key === ${JSON.stringify(KEY)}) {
        request.addEventListener("success", () => {
          aborts++;
          request.transaction.abort();
        });
      }
      return request;
    };
  }
  try {
    const ended = await Promise.race([
      idb[${JSON.stringify(name)}](${JSON.stringify(KEY)}).then(() => "resolved", () => "rejected"),
      new Promise((r) => setTimeout(() => r("waited"), ${WAIT_MS})),
    ]);
    return { ended, aborts };
  } finally {
    IDBObjectStore.prototype.delete = original;
  }
})()`;

const DELETES = ["deleteBuffer", "deleteWorkspace", "deleteHandle"];

const chromePath = findChromium();

describe("database deletes whose transaction aborts", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.cdp.send("Page.navigate", { url: srv.url });
    // The app's own module instance and an open database, as in use.
    const started = await browser.cdp.poll(`typeof window.vrtti === "object"`, START_TIMEOUT_MS);
    assert.ok(started, "the app did not start (window.vrtti is undefined)");
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  // Passes on the old code too: it shows that the wrap below, and not the
  // calls, makes the difference.
  test("guard: with no abort, each delete resolves", async () => {
    for (const name of DELETES) {
      const { ended } = await browser.cdp.eval(deleteCall(name, false));
      assert.equal(ended, "resolved", `${name}("${KEY}") must resolve when nothing aborts`);
    }
  });

  for (const name of DELETES) {
    test(`${name} rejects when its transaction aborts with no request error`, async () => {
      const { ended, aborts } = await browser.cdp.eval(deleteCall(name, true));
      assert.equal(aborts, 1, `the wrap did not abort the transaction of ${name}`);
      assert.equal(ended, "rejected", `${name}("${KEY}") must reject after an abort, not wait (it ${ended})`);
    });
  }
});
