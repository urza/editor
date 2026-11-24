// End-to-end check of the shared spellcheck settings (architecture.md §29):
// the rule switches and "My words" sync to every registered device through
// the reserved space "keyring", also to a device that shares no space with
// the writer, against the real Vrtti.Server and headless Chromium.
//
//   node --test tests/e2e/spellcheck-sync-e2e.test.mjs
//
// What it verifies, one test each:
//   1. A switch and a word made in the Spellcheck page of device A show in
//      the Spellcheck page of device B, which joined with no space.
//   2. The server holds only age files for "shared-settings": no rule name
//      and no word in any stored revision (HTTP and the SQLite file).
//   3. Offline changes on both devices merge entry by entry, no conflict copy.
//   4. A newer removal of a word wins and does not come back.
//   5. Settled settings cause no new revision in further sync rounds.
//   6. A third device that joins later can read the settings: the device
//      that answered the join encrypts them again, and that is the one
//      revision the join costs. The new device pushes nothing.
//   7. With no sync configured the page says so, and the settings survive a
//      reload.
//   8. An older server (emulated by a proxy that answers the settings push
//      with the old server's exact 400) gives no "sync failed", the page says
//      that the settings stay on the device, and an edit of a local note then
//      starts no sync round.
//   9. A wrong settings push (the current server's 400 for plain text) is a
//      sync error, not an "older server".
//  10. A locked device keeps the revision it cannot open, pushes nothing, and
//      merges the revision after the unlock.
//  11. A locked device that changes a word while it holds such a revision
//      pushes nothing until the unlock, and then one revision with its word
//      and the entries it could not read.
//  12. A joining device that changes a word before its join is answered
//      pushes nothing then, and its word reaches every device afterwards.
//
// Across the run, no revision may be a push-back: a device that only
// received the settings must not send them again (the list of readers rides
// inside the encrypted text, model/docs.js pushPayload). And no revision may
// drop an entry of the revision before it: an entry only ever gets newer.
//
// Zero npm dependencies: plain Node 22 + local Chromium via CDP + local dotnet.
// Skips cleanly when Chromium or dotnet is not installed on the host. The
// harness is a copy of tests/e2e/note-lifecycle-e2e.test.mjs, cut down to
// what these checks use, plus a capture of console errors per device.

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
// Outside the source tree, and built on every run: a dll left in bin/ by an
// older checkout would answer the settings push with the old server's 400,
// and every scenario here would test the wrong server.
const SERVER_BUILD = path.join(os.tmpdir(), "vrtti-spellcheck-sync-e2e-build");

const SETTINGS_ID = "shared-settings";
const AGE_HEADER = "-----BEGIN AGE ENCRYPTED FILE-----";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-spellsync-e2e-"));
  const dbPath = path.join(dataDir, "vrtti.db");
  const token = "e2e-server-token-1234";
  const proc = spawn("dotnet", [dll], {
    env: { ...process.env, VRTTI_TOKEN: token, VRTTI_DB: dbPath, VRTTI_ORIGINS: origin, ASPNETCORE_URLS: url },
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
          dbPath,
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
 * The settings push answered by a proxy, in front of a current server.
 *
 * mode "old": the answer of a server from before §29, byte for byte: 400
 * with {"error":"only the keyring document lives in keyring"}. The client
 * knows an older server by this sentence (sync/client.js,
 * OLD_SERVER_REFUSAL), so the emulation must send exactly it. Cheaper and
 * steadier than a build of the parent commit.
 * mode "wrong": the current server's 400 for a push that is wrong (plain
 * text). It must show as a sync error, not as "older server".
 * mode "pass": the push goes through to the current server.
 *
 * Everything else always passes through, the CORS preflight too.
 */
async function startSettingsProxy(target) {
  const upstream = new URL(target);
  const answers = {
    old: '{"error":"only the keyring document lives in keyring"}',
    wrong: '{"error":"content must be an armored age file"}',
  };
  const proxy = {
    url: "",
    mode: "old",
    // changes: GET /api/changes, at least one per sync round (one space:
    // keyring). settingsPosts: pushes of the settings that reached the proxy.
    stats: { settingsPosts: 0, changes: 0 },
    close: () => closeHttp(server),
  };
  const server = http.createServer((req, res) => {
    const p = req.url ?? "/";
    if (req.method === "GET" && new URL(p, "http://x").pathname === "/api/changes") proxy.stats.changes++;
    if (req.method === "POST" && p === `/api/docs/${SETTINGS_ID}/revisions`) {
      proxy.stats.settingsPosts++;
      const body = answers[proxy.mode];
      if (body) {
        // Drain the request first; the answer needs the CORS header of the
        // real server, or the browser hides the body from the client.
        req.resume();
        req.on("end", () => {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": req.headers.origin ?? "*",
            Vary: "Origin",
          });
          res.end(body);
        });
        return;
      }
    }
    const up = http.request(
      { host: upstream.hostname, port: upstream.port, path: p, method: req.method, headers: req.headers },
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
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP error: " + String(e))));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
        return;
      }
      const handlers = this.listeners.get(msg.method);
      if (handlers) for (const fn of handlers) fn(msg.params);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 20000) {
    let timer;
    // Cleared after the answer: a pending timer of a long eval (the 60 s of
    // the Harper catalog) would keep the test process alive that long after
    // the last test.
    const res = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CDP eval timed out (" + timeoutMs + "ms):\n" + expression.slice(0, 240))),
          timeoutMs
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  async waitFor(expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.eval(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Timed out waiting for: " + expression);
  }

  close() {
    this.ws.close();
  }
}

/**
 * Console errors, uncaught exceptions and failed sync rounds of all pages,
 * with the device name in front. Reported at the end; a test asserts on the
 * part that belongs to it.
 */
const problems = [];
/**
 * The browser's own lines for a failed request ("Failed to load resource:
 * 409"). Kept apart: a 409 of a push race, the 400 of an older server and a
 * request while offline are expected answers, and the app logs no error.
 */
const networkLines = [];

async function launchDevice(chromePath, label) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-spellsync-prof-"));
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
  const firstPage = targets.find((t) => t.type === "page");
  if (!firstPage?.webSocketDebuggerUrl) throw new Error("No page target");
  const cdp = new CdpClient(firstPage.webSocketDebuggerUrl);
  await cdp.ready;

  /** The "[vrtti] …" lines of this page, for the diagnostics of a failure. */
  const logs = [];
  const argText = (args) => (args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
  cdp.on("Runtime.exceptionThrown", (p) => {
    problems.push(`${label} exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const text = argText(p.args);
    if (text.startsWith("[vrtti]")) logs.push(text);
    if (p.type === "error" || p.type === "assert") problems.push(`${label} console.${p.type}: ${text}`);
    // A failed round only logs (sync/client.js, syncNow): the status bar is
    // the user's report. Collected here, so a test sees it too.
    else if (text.startsWith("[vrtti] sync failed")) problems.push(`${label} ${text}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry?.level !== "error") return;
    const line = `${label} ${p.entry.source}: ${p.entry.text} ${p.entry.url ?? ""}`.trim();
    (p.entry.source === "network" ? networkLines : problems).push(line);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const page = {
    label,
    cdp,
    logs,
    async goto(url) {
      await cdp.send("Page.navigate", { url });
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)", 20000);
    },
    async reload() {
      await cdp.send("Page.reload", { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 80));
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)", 20000);
    },
    async setOffline(offline) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline,
        latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1,
      });
    },
    async close() {
      try {
        cdp.close();
      } catch {}
      proc.kill("SIGTERM");
      await new Promise((r) => {
        proc.once("exit", r);
        setTimeout(r, 2000);
      });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
  return page;
}

/** One full sync round, started after any round in flight has ended. */
async function syncAndWait(cdp) {
  await cdp.eval(`(async () => {
    const waitIdle = async () => {
      const deadline = Date.now() + 15000;
      while (window.vrtti.sync.status.state === "syncing" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitIdle();
    await window.vrtti.sync.syncNow();
    await waitIdle();
    return window.vrtti.sync.status.state;
  })()`);
}

async function rounds(...devices) {
  for (const dev of devices) await syncAndWait(dev.cdp);
}

async function setupFirstDevice(cdp, { name, serverUrl, serverToken, space }) {
  await cdp.eval(`(async () => {
    await window.vrtti.keyring.setup({ deviceName: ${JSON.stringify(name)}, askPassphrase: false, firstDevice: true });
    await window.vrtti.sync.registerFirst(${JSON.stringify(serverUrl)}, ${JSON.stringify(serverToken)});
    ${space ? `await window.vrtti.sync.createSpace(${JSON.stringify(space)});` : ""}
    await window.vrtti.sync.syncNow();
  })()`);
}

/**
 * Join `dev` with a code from `member` that gives NO space: the new device
 * is registered on the server and known to the member, and it shares no
 * space with anyone. The settings must still reach it (§29).
 */
async function joinWithNoSpace(member, dev, { name, serverUrl, passphrase }) {
  const code = await member.cdp.eval(`window.vrtti.sync.invite([])`);
  await dev.cdp.eval(`(async () => {
    await window.vrtti.keyring.setup({
      deviceName: ${JSON.stringify(name)},
      askPassphrase: ${JSON.stringify(Boolean(passphrase))},
      passphrase: ${JSON.stringify(passphrase)},
      firstDevice: false,
    });
    await window.vrtti.sync.redeem(${JSON.stringify(serverUrl)}, ${JSON.stringify(code)}, {});
  })()`);
  // The member answers the join, the new device picks up the reply; the
  // second pair spreads the introductions.
  await rounds(member, dev, member, dev);
  const joined = await dev.cdp.eval(`({ joining: window.vrtti.sync.isJoining, spaces: window.vrtti.sync.mySpaces() })`);
  assert.equal(joined.joining, false, `${name} must finish the join`);
  assert.deepEqual(joined.spaces, [], `${name} must share no space`);
}

/** The settings of one device, in the shape the assertions compare. */
function settingsOf(cdp) {
  return cdp.eval(`(async () => {
    const s = await import("/js/model/spellsettings.js");
    const st = window.vrtti.store.sharedSettings();
    const rec = window.vrtti.store.get(${JSON.stringify(SETTINGS_ID)});
    return {
      words: s.wordList(st),
      config: s.lintConfig(st),
      sync: rec?.sync ? { rev: rec.sync.rev, dirty: rec.sync.dirty, space: rec.sync.space } : null,
      // The record keeps a revision it cannot open in \`unread\`; a settled
      // device has no such field at all.
      hasUnread: rec ? rec.unread !== undefined : false,
    };
  })()`);
}

/**
 * Change the settings through the store, as the Spellcheck page does
 * (ui/spellpage.js, write). `body` sees `s` (model/spellsettings.js), `st`
 * (the settings) and `now`, and assigns the new settings to `st`.
 */
function editSettings(cdp, body) {
  return cdp.eval(`(async () => {
    const s = await import("/js/model/spellsettings.js");
    let st = window.vrtti.store.sharedSettings();
    const now = Date.now();
    ${body};
    await window.vrtti.store.writeSharedSettings(st);
  })()`);
}

/** Harper's default for a rule, from the same catalog the page uses. */
async function ruleDefault(cdp, name) {
  return cdp.eval(
    `(async () => {
      const { ruleCatalog } = await import("/js/editor/spellcheck.js");
      const groups = await ruleCatalog();
      for (const g of groups ?? []) for (const r of g.rules) if (r.name === ${JSON.stringify(name)}) return r.byDefault;
      return null;
    })()`,
    60000
  );
}

/** Any note whose text or title says "conflict copy", and the sidebar text. */
function conflictCopies(cdp) {
  return cdp.eval(`(() => {
    const hits = [];
    for (const rec of window.vrtti.store.buffers.values()) {
      const text = [rec.name, typeof rec.content === "string" && !rec.enc ? rec.content : ""].join("\\n");
      if (/conflict copy/i.test(text)) hits.push(rec.id);
    }
    for (const stub of window.vrtti.remotes()) if (/conflict copy/i.test(stub.title ?? "")) hits.push(stub.id);
    if (/conflict copy/i.test(document.getElementById("sidebar")?.textContent ?? "")) hits.push("sidebar");
    return hits;
  })()`);
}

/** The device token of a page, for direct reads of the server. */
function deviceToken(cdp) {
  return cdp.eval(`(async () => (await (await import("/js/storage/idb.js")).getSetting("sync.config"))?.token ?? null)()`);
}

/** The server's current row of the settings, or null when it has none. */
async function serverSettings(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/docs/${SETTINGS_ID}`, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 404) return null;
  assert.equal(res.ok, true, `GET /api/docs/${SETTINGS_ID} answered ${res.status}`);
  return res.json();
}

/**
 * Every revision of the settings on the server, in order: who wrote it,
 * which of `devices` can open it, how many readers its list inside names,
 * and its settings (rules and words, without the list of readers). This is
 * how chatty the sync is, and whether a revision exists that another device
 * cannot read.
 * @param {{label: string, cdp: CdpClient}} via  A device whose token reads the revisions.
 * @param {{label: string, cdp: CdpClient}[]} devices
 */
async function revisionTable(serverUrl, via, devices) {
  const token = await deviceToken(via.cdp);
  const get = async (p) =>
    (await fetch(`${serverUrl}/api/docs/${SETTINGS_ID}${p}`, { headers: { Authorization: "Bearer " + token } })).json();
  const ids = {};
  for (const dev of devices) ids[await dev.cdp.eval(`window.vrtti.keyring.deviceId`)] = dev.label;
  const rows = [];
  for (const info of [...(await get("/revisions"))].sort((a, b) => a.rev - b.rev)) {
    const full = await get(`/revisions/${info.rev}`);
    const row = { rev: info.rev, author: ids[full.deviceId] ?? full.deviceId, canRead: "", readers: -1, settings: null };
    for (const dev of devices) {
      const opened = await dev.cdp.eval(`(async () => {
        try {
          const text = await window.vrtti.codec.decode(${JSON.stringify(full.content)}, { v: 1, preset: "space" }, window.vrtti.keyring);
          const { readers, ...settings } = JSON.parse(text);
          return { readers: Array.isArray(readers) ? readers.length : -1, settings: JSON.stringify(settings) };
        } catch { return null; }
      })()`);
      if (!opened) continue;
      row.canRead += dev.label;
      Object.assign(row, opened);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * No revision may drop an entry of the revision before it. A real change by
 * a user (a removal, a switch, a reset) keeps the entry with a newer `at`, so
 * an entry that is missing or older in the next revision is a lost change.
 */
function assertNoDrop(rows) {
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    if (cur.settings === null || prev.settings === null) continue;
    const a = JSON.parse(prev.settings);
    const b = JSON.parse(cur.settings);
    const lost = [
      ...Object.entries(a.rules ?? {}).filter(([k, e]) => (b.rules?.[k]?.at ?? -1) < e.at).map(([k]) => "rule " + k),
      ...Object.entries(a.words ?? {}).filter(([k, e]) => (b.words?.[k]?.at ?? -1) < e.at).map(([k]) => "word " + k),
    ];
    assert.deepEqual(lost, [], `rev ${cur.rev} by ${cur.author} drops entries of rev ${prev.rev}`);
  }
}

/** One line per revision, for t.diagnostic: "rev:author[can open]r<readers>e<entries>". */
function tableText(rows) {
  return rows
    .map((r) => {
      const st = r.settings ? JSON.parse(r.settings) : null;
      const entries = st ? Object.keys(st.rules ?? {}).length + Object.keys(st.words ?? {}).length : "?";
      return `${r.rev}:${r.author}[${r.canRead || "-"}]r${r.readers}e${entries}`;
    })
    .join(" ");
}

/**
 * No revision may be a push-back: the same settings as the revision before,
 * for no more readers. A revision with the same settings is right only when
 * it adds a reader (a new device, scenario 6).
 */
function assertNoPushBack(rows) {
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    if (cur.settings === null || prev.settings === null) continue;
    assert.ok(
      cur.settings !== prev.settings || cur.readers > prev.readers,
      `rev ${cur.rev} by ${cur.author} repeats rev ${prev.rev} for no new reader: ${tableText([prev, cur])}`
    );
  }
}

// ---- The Spellcheck page, driven through the DOM ----------------------------

async function openSpellPage(cdp) {
  await cdp.eval(`window.vrtti.run("settings.open")`);
  await cdp.eval(`(() => {
    const row = document.querySelector('#settings-panel .settings-row[data-key="spell-page"]');
    // Case-blind: the label follows the panel's style ("open", like "sync" and
    // "invite"), which is not what this test checks.
    const button = [...row.querySelectorAll("button")].find((b) => b.textContent.trim().toLowerCase() === "open");
    button.click();
    return true;
  })()`);
  await cdp.waitFor(`(() => {
    const page = document.querySelector("#settings-panel .spell-page");
    return Boolean(page && !page.closest("[hidden]"));
  })()`);
}

async function closeSettings(cdp) {
  await cdp.eval(`window.vrtti.run("settings.close")`);
}

function syncLine(cdp) {
  return cdp.eval(`document.querySelector("#settings-panel .spell-sync")?.textContent ?? null`);
}

/** Type into a field like a user: focus it, then real key input over CDP. */
async function typeInto(cdp, selector, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.select?.();
    return document.activeElement === el;
  })()`);
  await cdp.send("Input.insertText", { text });
}

async function pressEnter(cdp) {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

const RULE_SEARCH = '#settings-panel input.spell-search[type="search"]';
const WORD_FIELD = '#settings-panel input[placeholder="Filter or add a word"]';
const toggleOf = (rule) => `#settings-panel .settings-row[data-rule="${rule}"] .settings-toggle`;

/** Search one rule so its row shows, and wait until Harper's catalog is in. */
async function showRule(cdp, rule) {
  await typeInto(cdp, RULE_SEARCH, rule);
  // Harper (WASM) loads on the first visit of the page.
  await cdp.waitFor(`Boolean(document.querySelector(${JSON.stringify(toggleOf(rule))}))`, 60000);
}

function ruleToggle(cdp, rule) {
  return cdp.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(toggleOf(rule))});
    return t ? { text: t.textContent, pressed: t.getAttribute("aria-pressed") } : null;
  })()`);
}

function pageWords(cdp) {
  return cdp.eval(`[...document.querySelectorAll("#settings-panel .spell-word > span:first-child")].map((s) => s.textContent)`);
}

// -----------------------------------------------------------------------------

const chromePath = findChromium();
const dotnetReady = hasDotnet();

describe(
  "shared spellcheck settings sync E2E (architecture.md §29)",
  { skip: (!chromePath && "no Chromium binary") || (!dotnetReady && "no dotnet SDK") },
  () => {
    let dll;
    let staticSrv;
    let syncSrv;
    let devA;
    let devB;
    let devC;
    let devF;
    let tokenA;
    // Scenarios 8 and 9 share one device behind one proxy: 9 needs a device
    // whose settings push is still waiting.
    let oldSrv;
    let proxy;
    let devE;
    /** Server revision of "shared-settings" after each scenario. */
    const revs = {};
    const rev = async () => (await serverSettings(syncSrv.url, tokenA))?.rev ?? 0;
    const B_PASSPHRASE = "device-b-pass";
    /** The settings of each device, compared as one value. */
    const pick = (st) => ({ words: st.words, config: st.config });
    /** The revision table of the main server, read through A. */
    const table = () => revisionTable(syncSrv.url, devA, [devA, devB, devC, devF].filter(Boolean));
    /** New 409 answers to a settings push since `from` (an index into networkLines). */
    const conflictsSince = (from) =>
      networkLines.slice(from).filter((l) => l.includes("409") && l.includes(`/api/docs/${SETTINGS_ID}/`));

    before(async () => {
      dll = buildServer();
      staticSrv = await startStaticServer();
      syncSrv = await startSyncServer(dll, staticSrv.origin);
      [devA, devB] = await Promise.all([launchDevice(chromePath, "A"), launchDevice(chromePath, "B")]);
      await devA.goto(staticSrv.url);
      await setupFirstDevice(devA.cdp, { name: "Laptop", serverUrl: syncSrv.url, serverToken: syncSrv.token, space: "personal" });
      tokenA = await deviceToken(devA.cdp);
    });

    after(async () => {
      let fullTable = "";
      try {
        if (devA && syncSrv) fullTable = tableText(await table());
      } catch (err) {
        fullTable = "not read: " + err;
      }
      for (const dev of [devF, devE, devC, devB, devA]) if (dev) await dev.close();
      if (proxy) await proxy.close();
      if (oldSrv) await oldSrv.close();
      if (syncSrv) await syncSrv.close();
      if (staticSrv) await closeHttp(staticSrv.server);
      console.log("[spellcheck-sync-e2e] server rev of shared-settings after each scenario:", JSON.stringify(revs));
      console.log("[spellcheck-sync-e2e] revisions rev:author[can open]r<readers>e<entries>:", fullTable);
      console.log(
        "[spellcheck-sync-e2e] console errors and exceptions:" + (problems.length ? "\n  " + problems.join("\n  ") : " none")
      );
      console.log(
        "[spellcheck-sync-e2e] failed requests (browser network log):" +
          (networkLines.length ? "\n  " + networkLines.join("\n  ") : " none")
      );
    });

    test("1. A rule and a word set in A's Spellcheck page reach B, which shares no space (UI on both sides)", async (t) => {
      await devB.goto(staticSrv.url);
      // B asks for a passphrase at start, so scenario 10 can lock it.
      await joinWithNoSpace(devA, devB, { name: "Desktop", serverUrl: syncSrv.url, passphrase: B_PASSPHRASE });
      const known = await Promise.all(
        [devA, devB].map((d) => d.cdp.eval(`({ spaces: window.vrtti.sync.mySpaces(), readers: window.vrtti.sync.knownRecipients().length })`))
      );
      assert.deepEqual(known[0].spaces, ["personal"]);
      assert.deepEqual(known[1].spaces, [], "B shares no space with A");
      assert.equal(known[0].readers, 2, "A knows B (the grid of Settings > Devices)");
      assert.equal(known[1].readers, 2, "B knows A");
      assert.equal(await rev(), 0, "no settings on the server before the first change");

      // Device A, in the page: LongSentences off, and the word "vrtti". Both
      // changes fall into one debounce of the sync, so they make one push.
      await openSpellPage(devA.cdp);
      assert.equal(await syncLine(devA.cdp), "These settings sync to all your devices.");
      await showRule(devA.cdp, "LongSentences");
      const beforeA = await ruleToggle(devA.cdp, "LongSentences");
      assert.equal(beforeA.text, "on", "LongSentences is on by Harper's default");
      await devA.cdp.eval(`document.querySelector(${JSON.stringify(toggleOf("LongSentences"))}).click()`);
      await devA.cdp.waitFor(`document.querySelector(${JSON.stringify(toggleOf("LongSentences"))})?.textContent === "off"`);
      await typeInto(devA.cdp, WORD_FIELD, "vrtti");
      await pressEnter(devA.cdp);
      await devA.cdp.waitFor(
        `[...document.querySelectorAll("#settings-panel .spell-word")].some((w) => w.textContent.startsWith("vrtti"))`
      );
      const stateA = await settingsOf(devA.cdp);
      assert.deepEqual(stateA.words, ["vrtti"]);
      assert.deepEqual(stateA.config, { LongSentences: false });

      // Device B has its page open before the pull: the "shared-settings"
      // event of the pull must repaint it, with no reopening.
      await openSpellPage(devB.cdp);
      assert.equal(await syncLine(devB.cdp), "These settings sync to all your devices.");
      await showRule(devB.cdp, "LongSentences");
      assert.equal((await ruleToggle(devB.cdp, "LongSentences")).text, "on", "B starts at the default");

      await rounds(devA, devB);
      await devB.cdp.waitFor(`document.querySelector(${JSON.stringify(toggleOf("LongSentences"))})?.textContent === "off"`, 5000);
      const toggleB = await ruleToggle(devB.cdp, "LongSentences");
      assert.deepEqual(toggleB, { text: "off", pressed: "false" });
      assert.deepEqual(await pageWords(devB.cdp), ["vrtti"], "B's page lists the word");
      const stateB = await settingsOf(devB.cdp);
      assert.deepEqual(pick(stateB), pick(stateA));
      assert.equal(stateB.hasUnread, false, "B could decrypt the settings");
      assert.equal(stateB.sync.dirty, false, "B has nothing to push");

      // One more round on each: B must not push back what it received.
      await rounds(devA, devB);
      const rows = await table();
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows));
      assert.equal(await rev(), 1, "one change of A, one revision; B pushes nothing back");
      assert.deepEqual(rows.map((r) => r.author), ["A"]);
      assert.equal(rows[0].canRead, "AB");
      await closeSettings(devA.cdp);
      await closeSettings(devB.cdp);
      revs["1"] = await rev();
    });

    test("2. The server stores the settings only as age files: no rule name, no word", async () => {
      const row = await serverSettings(syncSrv.url, tokenA);
      assert.ok(row, "the server has the settings");
      assert.equal(row.space, "keyring");
      assert.ok(row.content.startsWith(AGE_HEADER), "the content is an armored age file");
      const wire = JSON.stringify(row);
      assert.equal(wire.includes("vrtti"), false, "no word in the stored row");
      assert.equal(wire.includes("LongSentences"), false, "no rule name in the stored row");

      // Every revision in the database, not only the current one.
      let sqlite;
      try {
        sqlite = await import("node:sqlite");
      } catch {}
      if (sqlite) {
        const db = new sqlite.DatabaseSync(syncSrv.dbPath, { readOnly: true });
        try {
          const rows = db.prepare("SELECT rev, kind, content, meta, space FROM revisions WHERE doc_id = ?").all(SETTINGS_ID);
          assert.ok(rows.length >= 1);
          for (const r of rows) {
            assert.equal(r.space, "keyring");
            assert.ok(String(r.content).startsWith(AGE_HEADER), `rev ${r.rev} is an age file`);
            const stored = String(r.content) + String(r.meta ?? "");
            assert.equal(/vrtti|LongSentences/.test(stored), false, `rev ${r.rev} holds no readable setting`);
          }
        } finally {
          db.close();
        }
      }
      revs["2"] = await rev();
    });

    test("3. Offline changes on two devices merge entry by entry, with no conflict copy", async (t) => {
      const start = await rev();
      assert.equal(await ruleDefault(devB.cdp, "RepeatedWords"), true, "RepeatedWords is on by Harper's default");
      // Both devices offline: each change waits, and the push after the
      // return meets the other device's revision (a pull or a 409).
      await Promise.all([devA.setOffline(true), devB.setOffline(true)]);
      let offline;
      try {
        await editSettings(devA.cdp, `st = s.addWord(st, "alpha", now)`);
        await editSettings(devB.cdp, `st = s.addWord(st, "beta", now); st = s.setRule(st, "RepeatedWords", false, true, now)`);
        // The store's change event starts a round after a debounce; it must
        // find the network gone and keep the record dirty.
        await new Promise((r) => setTimeout(r, 1500));
        offline = await Promise.all([devA, devB].map((d) => settingsOf(d.cdp)));
      } finally {
        // Back online also after a failure, or every later test fails too.
        await Promise.all([devA.setOffline(false), devB.setOffline(false)]);
      }
      assert.equal(offline[0].sync.dirty, true);
      assert.equal(offline[1].sync.dirty, true);

      const want = { words: ["alpha", "beta", "vrtti"], config: { LongSentences: false, RepeatedWords: false } };
      const deadline = Date.now() + 30000;
      let states;
      while (Date.now() < deadline) {
        await rounds(devA, devB, devA);
        states = await Promise.all([devA, devB].map((d) => settingsOf(d.cdp)));
        if (states.every((s) => JSON.stringify(pick(s)) === JSON.stringify(want))) break;
      }
      for (const [i, s] of states.entries()) {
        assert.deepEqual(pick(s), want, `device ${"AB"[i]} has both changes`);
      }
      assert.deepEqual(await conflictCopies(devA.cdp), [], "no conflict copy on A");
      assert.deepEqual(await conflictCopies(devB.cdp), [], "no conflict copy on B");
      await rounds(devA, devB);
      const rows = (await table()).filter((r) => r.rev > start);
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows));
      // The first device back pushes its own change; the second gets a 409
      // or pulls it, merges, and pushes the merge. The first then only pulls.
      assert.equal(rows.length, 2, "two changes made offline, two revisions");
      assert.notEqual(rows[0].author, rows[1].author, "one revision from each device");
      assertNoPushBack((await table()).filter((r) => r.rev >= start));
      // The second revision is the merge: it carries both devices' changes.
      const merged = JSON.parse(rows[1].settings);
      assert.deepEqual(Object.keys(merged.words).sort(), ["alpha", "beta", "vrtti"]);
      assert.equal(merged.rules.RepeatedWords?.on, false);
      revs["3"] = await rev();
    });

    test("4. A newer removal of a word wins, and the word does not come back", async () => {
      const start = await rev();
      await editSettings(devA.cdp, `st = s.removeWord(st, "alpha", now)`);
      await rounds(devA, devB);
      assert.deepEqual((await settingsOf(devB.cdp)).words, ["beta", "vrtti"], "B drops alpha");
      await rounds(devB, devA, devB, devA);
      for (const dev of [devA, devB]) {
        assert.deepEqual((await settingsOf(dev.cdp)).words, ["beta", "vrtti"], `alpha stays gone on ${dev.label}`);
      }
      assert.equal(await rev(), start + 1, "the removal is one revision of A");
      revs["4"] = await rev();
    });

    test("5. Settled settings: three more rounds on each device make no new revision", async () => {
      await rounds(devA, devB, devA);
      const settled = await rev();
      for (let i = 0; i < 3; i++) await rounds(devA, devB);
      assert.equal(await rev(), settled, "no ping-pong between A and B");
      const states = await Promise.all([devA, devB].map((d) => settingsOf(d.cdp)));
      assert.equal(states[0].sync.dirty, false);
      assert.equal(states[1].sync.dirty, false);
      revs["5"] = await rev();
    });

    test("6. A device that joins later reads the settings; the join costs one revision", async (t) => {
      const before = await rev();
      devC = await launchDevice(chromePath, "C");
      await devC.goto(staticSrv.url);
      await joinWithNoSpace(devA, devC, { name: "Phone", serverUrl: syncSrv.url });
      // The order the task names: C, then A (encrypts again for C), then C.
      await rounds(devC, devA, devC);
      // B learns about C from A's introduction; it must see that the newest
      // revision already names C, and push nothing.
      await rounds(devB, devA, devC, devB, devA, devC);
      const settled = await rev();
      await rounds(devA, devB, devC, devA, devB, devC);
      assert.equal(await rev(), settled, "no ping-pong with three devices");

      const rows = (await table()).filter((r) => r.rev > before);
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows));
      t.diagnostic(`shared-settings rev: before the join ${before}, settled ${settled} (+${settled - before} for the join of C)`);
      assert.equal(settled - before, 1, "the join of C costs exactly one revision");
      assert.equal(rows.filter((r) => r.author === "C").length, 0, "C pushes nothing while it holds an unread revision");
      assert.equal(rows[0].author, "A", "the device that answered the join encrypts again");
      assert.equal(rows[0].canRead, "ABC");
      assert.equal(rows[0].readers, 3);

      const states = await Promise.all([devA, devB, devC].map((d) => settingsOf(d.cdp)));
      for (const [i, st] of states.entries()) {
        assert.equal(st.hasUnread, false, `${"ABC"[i]} has no unread revision`);
        assert.equal(st.sync.rev, settled, `${"ABC"[i]} holds the newest revision`);
      }
      assert.deepEqual(pick(states[2]), pick(states[0]), "C has A's settings");
      assert.deepEqual(pick(states[1]), pick(states[0]), "B has A's settings");
      revs["6"] = settled;
      revs["6 join cost"] = settled - before;
    });

    test("7. No sync configured: the page says so, and a switch and a word survive a reload", async () => {
      const devD = await launchDevice(chromePath, "D (no sync)");
      try {
        await devD.goto(staticSrv.url);
        await openSpellPage(devD.cdp);
        assert.equal(await syncLine(devD.cdp), "These settings stay on this device.");
        await showRule(devD.cdp, "LongSentences");
        await devD.cdp.eval(`document.querySelector(${JSON.stringify(toggleOf("LongSentences"))}).click()`);
        await devD.cdp.waitFor(`document.querySelector(${JSON.stringify(toggleOf("LongSentences"))})?.textContent === "off"`);
        await typeInto(devD.cdp, WORD_FIELD, "lokalni");
        await pressEnter(devD.cdp);
        await devD.cdp.waitFor(`[...document.querySelectorAll("#settings-panel .spell-word")].some((w) => w.textContent.startsWith("lokalni"))`);

        await devD.reload();
        await openSpellPage(devD.cdp);
        assert.equal(await syncLine(devD.cdp), "These settings stay on this device.");
        await showRule(devD.cdp, "LongSentences");
        assert.deepEqual(await ruleToggle(devD.cdp, "LongSentences"), { text: "off", pressed: "false" });
        assert.deepEqual(await pageWords(devD.cdp), ["lokalni"]);
        const state = await settingsOf(devD.cdp);
        assert.equal(state.sync, null, "a device with no server attaches nothing");
      } finally {
        await devD.close();
      }
    });

    test("8. An older server: no 'sync failed', the page says the settings stay here, and no idle rounds", async (t) => {
      oldSrv = await startSyncServer(dll, staticSrv.origin);
      proxy = await startSettingsProxy(oldSrv.url);
      proxy.mode = "old";
      devE = await launchDevice(chromePath, "E");
      await devE.goto(staticSrv.url);
      await setupFirstDevice(devE.cdp, { name: "Old", serverUrl: proxy.url, serverToken: oldSrv.token });
      await editSettings(devE.cdp, `st = s.addWord(st, "vrtti", now)`);
      await syncAndWait(devE.cdp);
      const status = await devE.cdp.eval(`({ ...window.vrtti.sync.status, refused: window.vrtti.sync.settingsRefused })`);
      assert.equal(proxy.stats.settingsPosts, 1, "the client tried the push once");
      assert.notEqual(status.state, "error", "no sync error for an older server: " + (status.message ?? ""));
      assert.equal(status.refused, true);

      // The stop holds: more rounds send no further settings push.
      await editSettings(devE.cdp, `st = s.addWord(st, "beta", now)`);
      await syncAndWait(devE.cdp);
      await syncAndWait(devE.cdp);
      assert.equal(proxy.stats.settingsPosts, 1, "no push of the settings after the 400");
      assert.notEqual(await devE.cdp.eval(`window.vrtti.sync.status.state`), "error");
      assert.deepEqual(
        problems.filter((p) => p.startsWith("E ")),
        [],
        "no console error and no failed round on the device with the older server"
      );

      await openSpellPage(devE.cdp);
      assert.equal(await syncLine(devE.cdp), "The sync server is older than this app, so these settings stay on this device.");
      assert.deepEqual(await pageWords(devE.cdp), ["beta", "vrtti"], "the settings still work on the device");
      await closeSettings(devE.cdp);

      // The refused record stays dirty for the next start of the app, but it
      // must not count as work for the edit debounce (sync/client.js,
      // pushable): one edit of a local note starts no round. The window is
      // the 2 s debounce plus margin, far from the 60 s poll.
      const changesBefore = proxy.stats.changes;
      const synced = await devE.cdp.eval(`(async () => {
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "local only\\nnothing to sync");
        await window.vrtti.saveNow(b.id);
        return Boolean(window.vrtti.store.get(b.id)?.sync);
      })()`);
      assert.equal(synced, false, "the note is local");
      await new Promise((r) => setTimeout(r, 4000));
      const roundsByEdit = proxy.stats.changes - changesBefore;
      t.diagnostic(`GET /api/changes in 4 s after one edit of a local note: ${roundsByEdit}`);
      assert.equal(roundsByEdit, 0, "an edit of a local note starts no sync round");
    });

    test("9. A wrong settings push (400, plain text) is a sync error, not an older server", async () => {
      // A new start of the app forgets "refused"; the next push meets the
      // current server's answer to a push that is wrong.
      proxy.mode = "wrong";
      const postsBefore = proxy.stats.settingsPosts;
      await devE.reload();
      await syncAndWait(devE.cdp);
      const status = await devE.cdp.eval(`({ ...window.vrtti.sync.status, refused: window.vrtti.sync.settingsRefused })`);
      assert.ok(proxy.stats.settingsPosts > postsBefore, "the settings push reached the server");
      assert.equal(status.refused, false, "a wrong push is not an older server");
      assert.equal(status.state, "error", "the round reports an error");
      assert.match(status.message ?? "", /400/);
      await openSpellPage(devE.cdp);
      assert.equal(await syncLine(devE.cdp), "These settings sync to all your devices.");
      await closeSettings(devE.cdp);
      assert.ok(
        problems.some((p) => p.startsWith("E [vrtti] sync failed")),
        "the failed round is logged (expected here, listed in the report)"
      );

      // The same push, now accepted: the error goes away by itself.
      proxy.mode = "pass";
      await syncAndWait(devE.cdp);
      assert.equal(await devE.cdp.eval(`window.vrtti.sync.status.state`), "idle");
      const row = await serverSettings(oldSrv.url, await deviceToken(devE.cdp));
      assert.ok(row?.content.startsWith(AGE_HEADER), "the server holds the settings now");
    });

    test("10. A locked device keeps the revision unread, pushes nothing, and merges after the unlock", async (t) => {
      const start = await rev();
      await devB.cdp.eval(`window.vrtti.run("crypto.lock")`);
      assert.equal(await devB.cdp.eval(`window.vrtti.keyring.isUnlocked`), false, "B is locked");

      // A turns LongSentences back to Harper's default (on).
      await editSettings(devA.cdp, `st = s.setRule(st, "LongSentences", true, true, now)`);
      await rounds(devA);
      assert.equal(await rev(), start + 1);
      await rounds(devB, devB);
      const locked = await settingsOf(devB.cdp);
      assert.equal(locked.hasUnread, true, "B keeps the revision it cannot open");
      assert.equal(locked.sync.dirty, false, "B has nothing to push");
      assert.deepEqual(locked.config, { LongSentences: false, RepeatedWords: false }, "B's settings wait for the unlock");
      assert.equal(await rev(), start + 1, "the locked device pushes nothing");

      await devB.cdp.eval(`window.vrtti.keyring.unlock(${JSON.stringify(B_PASSPHRASE)})`);
      await rounds(devB);
      const open = await settingsOf(devB.cdp);
      assert.equal(open.hasUnread, false, "the unlock merges the kept revision");
      assert.deepEqual(open.config, { RepeatedWords: false }, "B has A's change");
      assert.deepEqual(pick(open), pick(await settingsOf(devA.cdp)));
      await rounds(devA, devB, devC, devA, devB);
      assert.equal(await rev(), start + 1, "the unlock makes no revision");
      const rows = await table();
      assertNoPushBack(rows);
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows.filter((r) => r.rev > start)));
      revs["10"] = await rev();
    });

    test("11. A locked device that changes a word pushes nothing until the unlock, then one revision with everything", async (t) => {
      const start = await rev();
      const net0 = networkLines.length;
      await devB.cdp.eval(`window.vrtti.run("crypto.lock")`);
      // A puts RepeatedWords back to Harper's default; B cannot open that revision.
      await editSettings(devA.cdp, `st = s.setRule(st, "RepeatedWords", true, true, now)`);
      await rounds(devA, devB);
      assert.equal(await rev(), start + 1);
      assert.equal((await settingsOf(devB.cdp)).hasUnread, true, "B keeps the revision it cannot open");

      // Locked, B adds a word: the page writes plain JSON, so it can. The
      // record stays dirty and is held back (sync/client.js, pushable).
      await editSettings(devB.cdp, `st = s.addWord(st, "gamma", now)`);
      await rounds(devB, devB, devA, devC, devB);
      const locked = await settingsOf(devB.cdp);
      assert.ok(locked.words.includes("gamma"), "B keeps its word locally");
      assert.equal(locked.sync.dirty, true, "B's word waits to be pushed");
      assert.equal(locked.hasUnread, true);
      assert.equal(await rev(), start + 1, "the locked device writes no revision");

      await devB.cdp.eval(`window.vrtti.keyring.unlock(${JSON.stringify(B_PASSPHRASE)})`);
      await rounds(devB, devA, devC, devB, devA, devC);
      const settled = await rev();
      await rounds(devA, devB, devC);
      assert.equal(await rev(), settled, "no ping-pong after the unlock");

      const all = await table();
      const rows = all.filter((r) => r.rev > start);
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows));
      assert.equal(settled, start + 2, "A's change, then one revision of B after the unlock; A needs no repair");
      assert.deepEqual(rows.map((r) => r.author), ["A", "B"]);
      const fromA = JSON.parse(rows[0].settings);
      const fromB = JSON.parse(rows[1].settings);
      assert.ok(fromB.words.gamma && !fromB.words.gamma.gone, "B's revision has B's word");
      assert.deepEqual(fromB.rules.RepeatedWords, fromA.rules.RepeatedWords, "B's revision has A's change it could not read");
      assert.deepEqual(conflictsSince(net0), [], "no 409 was needed");

      const want = { words: ["beta", "gamma", "vrtti"], config: {} };
      for (const dev of [devA, devB, devC]) {
        const st = await settingsOf(dev.cdp);
        assert.deepEqual(pick(st), want, `${dev.label} has A's switch and B's word`);
        assert.equal(st.hasUnread, false);
      }
      // The whole run: no revision drops an entry, none is a push-back.
      assertNoDrop(all);
      assertNoPushBack(all);
      revs["11"] = settled;
    });

    test("12. A joining device that changes a word before its join is answered pushes nothing, then its word reaches all", async (t) => {
      const start = await rev();
      const net0 = networkLines.length;
      devF = await launchDevice(chromePath, "F");
      await devF.goto(staticSrv.url);
      const code = await devA.cdp.eval(`window.vrtti.sync.invite([])`);
      await devF.cdp.eval(`(async () => {
        await window.vrtti.keyring.setup({ deviceName: "Tablet", askPassphrase: false, firstDevice: false });
        await window.vrtti.sync.redeem(${JSON.stringify(syncSrv.url)}, ${JSON.stringify(code)}, {});
      })()`);
      // redeem() starts F's first round. A has not answered: F knows no
      // other device, and every revision on the server is closed to it.
      await syncAndWait(devF.cdp);
      const early = await devF.cdp.eval(`({ joining: window.vrtti.sync.isJoining })`);
      assert.equal(early.joining, true, "A has not answered the join yet");
      assert.equal((await settingsOf(devF.cdp)).hasUnread, true, "F holds a revision it cannot open");

      await editSettings(devF.cdp, `st = s.addWord(st, "delta", now)`);
      await syncAndWait(devF.cdp);
      const waiting = await settingsOf(devF.cdp);
      assert.deepEqual(waiting.words, ["delta"], "F keeps its word locally");
      assert.equal(waiting.sync.dirty, true);
      assert.equal(await rev(), start, "F writes no revision before its join is answered");

      // A answers the join and encrypts again for F; F merges, then pushes
      // its word once; B and C pull it.
      await rounds(devA, devF, devA, devF, devB, devC, devA);
      assert.equal(await devF.cdp.eval(`window.vrtti.sync.isJoining`), false, "F finished its join");
      const settled = await rev();
      await rounds(devA, devB, devC, devF);
      assert.equal(await rev(), settled, "no ping-pong with four devices");

      const all = await table();
      const rows = all.filter((r) => r.rev > start);
      t.diagnostic("revisions rev:author[can open]r<readers>e<entries>: " + tableText(rows));
      assert.deepEqual(rows.map((r) => r.author), ["A", "F"], "A encrypts again for F, then F pushes its word");
      assert.equal(rows[1].canRead, "ABCF");
      assert.deepEqual(conflictsSince(net0), [], "no 409 was needed");
      const want = { words: ["beta", "delta", "gamma", "vrtti"], config: {} };
      for (const dev of [devA, devB, devC, devF]) {
        const st = await settingsOf(dev.cdp);
        assert.deepEqual(pick(st), want, `${dev.label} has F's word`);
        assert.equal(st.hasUnread, false);
      }
      assertNoDrop(all);
      assertNoPushBack(all);
      revs["12"] = settled;
    });
  }
);
