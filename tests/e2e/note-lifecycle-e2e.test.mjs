// End-to-end browser verification for note lifecycle, desktop sidebar redesign,
// phone Mode B, offline trash/restore state machine, PIN stub privacy, and
// Space Windows against the real Vrtti.Server and headless Chromium.
//
//   node --test tests/e2e/note-lifecycle-e2e.test.mjs
//
// Zero npm dependencies: plain Node 22 + local Chromium via CDP + local dotnet.
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

function startStaticServer() {
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
        const ext = path.extname(file);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      resolve({
        server,
        origin: `http://127.0.0.1:${addr.port}`,
        url: `http://127.0.0.1:${addr.port}/`,
      });
    });
  });
}

async function startSyncServer(origin) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-sync-e2e-"));
  const dbPath = path.join(dataDir, "vrtti.db");
  const token = "e2e-server-token-1234";

  const dll = path.join(SERVER_PROJ, "bin", "Debug", "net10.0", "Vrtti.Server.dll");
  if (!fs.existsSync(dll)) {
    execFileSync("dotnet", ["build", SERVER_PROJ, "-c", "Debug"], { stdio: "pipe" });
  }
  const proc = spawn("dotnet", [dll], {
    env: {
      ...process.env,
      VRTTI_TOKEN: token,
      VRTTI_DB: dbPath,
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

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 20000) {
    const res = await Promise.race([
      this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("CDP eval timed out (" + timeoutMs + "ms):\n" + expression.slice(0, 240))),
          timeoutMs
        )
      ),
    ]);
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

const BACK_HOOK = `
  (() => {
    const Native = window.CloseWatcher;
    const live = [];
    window.__backWatchers = live;
    window.__triggerBack = () => {
      const top = live.pop();
      if (!top) return false;
      top.onclose?.();
      top._native?.destroy?.();
      return true;
    };
    window.CloseWatcher = class TestCloseWatcher {
      constructor() {
        this.onclose = null;
        this._native = Native ? new Native() : null;
        live.push(this);
      }
      destroy() {
        const i = live.indexOf(this);
        if (i >= 0) live.splice(i, 1);
        this._native?.destroy?.();
      }
    };
  })();
`;

async function launchDevice(chromePath, { width = 1280, height = 800, mobile = false } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-e2e-prof-"));
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

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserCdp = new CdpClient(version.webSocketDebuggerUrl);
  await browserCdp.ready;

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const firstPage = targets.find((t) => t.type === "page");
  if (!firstPage?.webSocketDebuggerUrl) throw new Error("No page target");

  const openClients = new Set();

  async function attachPage(wsUrl, targetId, opts = { width, height, mobile }) {
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;
    openClients.add(cdp);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.mobile ? 3 : 1,
      mobile: opts.mobile,
    });
    await cdp.send(
      "Emulation.setTouchEmulationEnabled",
      opts.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    );
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: BACK_HOOK });
    return {
      cdp,
      targetId,
      async goto(url) {
        await cdp.send("Page.navigate", { url });
        await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
      },
      async reload() {
        await cdp.send("Page.reload", { ignoreCache: true });
        await new Promise((r) => setTimeout(r, 80));
        await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
      },
      async setOffline(offline) {
        await cdp.send("Network.emulateNetworkConditions", {
          offline,
          latency: 0,
          downloadThroughput: offline ? 0 : -1,
          uploadThroughput: offline ? 0 : -1,
        });
      },
      async closeTab() {
        openClients.delete(cdp);
        try {
          cdp.close();
        } catch {}
        await browserCdp.send("Target.closeTarget", { targetId });
      },
    };
  }

  let page;
  try {
    page = await attachPage(firstPage.webSocketDebuggerUrl, firstPage.id);
  } catch (err) {
    for (const c of openClients) {
      try {
        c.close();
      } catch {}
    }
    try {
      browserCdp.close();
    } catch {}
    proc.kill("SIGTERM");
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }

  async function openTab(url) {
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((t) => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error("Created target has no WS url");
    const tab = await attachPage(target.webSocketDebuggerUrl, targetId);
    await tab.goto(url);
    return tab;
  }

  async function close() {
    for (const c of openClients) {
      try {
        c.close();
      } catch {}
    }
    try {
      browserCdp.close();
    } catch {}
    proc.kill("SIGTERM");
    await new Promise((r) => {
      proc.once("exit", r);
      setTimeout(r, 2000);
    });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { page, openTab, close };
}

async function syncAndWait(cdp) {
  await cdp.eval(`(async () => {
    const waitIdle = async () => {
      const deadline = Date.now() + 8000;
      while (window.vrtti.sync.status.state === "syncing" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitIdle();
    await window.vrtti.sync.syncNow();
    await waitIdle();
  })()`);
}

async function setupFirstDevice(cdp, { name, serverUrl, serverToken }) {
  return cdp.eval(`(async () => {
    await window.vrtti.keyring.setup({
      deviceName: ${JSON.stringify(name)},
      askPassphrase: false,
      firstDevice: true,
    });
    await window.vrtti.sync.registerFirst(${JSON.stringify(serverUrl)}, ${JSON.stringify(serverToken)});
    await window.vrtti.sync.createSpace("personal");
    await window.vrtti.sync.createSpace("infra");
    await window.vrtti.sync.setSpaceMode("personal", "tab");
    await window.vrtti.sync.setSpaceMode("infra", "list");
    await window.vrtti.sync.setNewNotes("personal");
    await window.vrtti.sync.syncNow();
    return {
      spaces: window.vrtti.sync.mySpaces(),
      pubKey: window.vrtti.keyring.ownKey,
    };
  })()`);
}

async function joinSecondDevice(cdpA, cdpB, { name, serverUrl, spaces = { personal: "tab", infra: "list" }, askPassphrase = false, passphrase }) {
  const code = await cdpA.eval(`window.vrtti.sync.invite(${JSON.stringify(Object.keys(spaces))})`);
  await cdpB.eval(`(async () => {
    await window.vrtti.keyring.setup({
      deviceName: ${JSON.stringify(name)},
      askPassphrase: ${JSON.stringify(askPassphrase)},
      passphrase: ${JSON.stringify(passphrase)},
      firstDevice: false,
    });
    await window.vrtti.sync.redeem(${JSON.stringify(serverUrl)}, ${JSON.stringify(code)}, ${JSON.stringify(spaces)});
  })()`);
  // Device A answers the join and adds Device B to the spaces; Device B picks up the reply.
  await cdpA.eval(`window.vrtti.sync.syncNow()`);
  await cdpB.eval(`window.vrtti.sync.syncNow()`);
  await cdpA.eval(`window.vrtti.sync.syncNow()`);
  await cdpB.eval(`window.vrtti.sync.syncNow()`);
  const mySpaces = await cdpB.eval(`window.vrtti.sync.mySpaces()`);
  assert.deepEqual(new Set(mySpaces), new Set(Object.keys(spaces)), "Device B must join spaces");
}

const chromePath = findChromium();
const dotnetReady = hasDotnet();

describe(
  "note lifecycle, sidebar redesign, phone Mode B, and Space Windows E2E",
  { skip: (!chromePath && "no Chromium binary") || (!dotnetReady && "no dotnet SDK") },
  () => {
    let staticSrv;
    let syncSrv;
    let devA;
    let devB;
    let phoneDev;

    before(async () => {
      staticSrv = await startStaticServer();
      syncSrv = await startSyncServer(staticSrv.origin);
      devA = await launchDevice(chromePath, { width: 1280, height: 800, mobile: false });
      devB = await launchDevice(chromePath, { width: 1280, height: 800, mobile: false });
      phoneDev = await launchDevice(chromePath, { width: 390, height: 844, mobile: true });
    });

    after(async () => {
      if (phoneDev) await phoneDev.close();
      if (devB) await devB.close();
      if (devA) await devA.close();
      if (syncSrv) await syncSrv.close();
      if (staticSrv) {
        staticSrv.server.closeAllConnections?.();
        await new Promise((r) => staticSrv.server.close(r));
      }
    });

    test("1. Local lifecycle, 30d Recent expiry, Trash purge, Settings cleanup, and file.unwritten protection", async () => {
      const { cdp } = devA.page;
      await devA.page.goto(staticSrv.url);

      // Settings › Storage must NOT contain Deleted notes.
      const settingsInfo = await cdp.eval(`(async () => {
        await window.vrtti.run("settings.open");
        const panel = document.getElementById("settings-panel");
        const text = panel.textContent || "";
        const hasTrashRow = Boolean(panel.querySelector('[data-key="trash"]'));
        await window.vrtti.run("settings.close");
        return { hasTrashRow, hasDeletedWord: /Deleted notes/i.test(text) };
      })()`);
      assert.equal(settingsInfo.hasTrashRow, false);
      assert.equal(settingsInfo.hasDeletedWord, false);

      // Create a local scratch note, save, close -> enters Recent with closedAt.
      const localId = await cdp.eval(`(async () => {
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Old clipboard dump\\nbody line");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.closeBuffer(b.id);
        return b.id;
      })()`);

      const afterClose = await cdp.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(localId)});
        return {
          closedAt: rec?.closedAt ?? null,
          inRecent: window.vrtti.store.recentBuffers().some((r) => r.id === ${JSON.stringify(localId)}),
          barRecentHidden: document.getElementById("bar-recent").hidden,
          barTrashHidden: document.getElementById("bar-trash").hidden,
        };
      })()`);
      assert.ok(typeof afterClose.closedAt === "number" && afterClose.closedAt > 0);
      assert.equal(afterClose.inRecent, true);
      assert.equal(afterClose.barRecentHidden, false);
      assert.equal(afterClose.barTrashHidden, true);

      // 31-day-old Recent note moves into 30d Trash on startup (NOT deleted directly).
      const DAY = 24 * 60 * 60 * 1000;
      const afterExpire = await cdp.eval(`(async () => {
        const rec = window.vrtti.store.get(${JSON.stringify(localId)});
        rec.closedAt = Date.now() - 31 * ${DAY};
        await window.vrtti.store.putSystemRecord(rec);
        await window.vrtti.expireOldRecent(Date.now());
        await window.vrtti.emptyOldTrash(Date.now());
        const updated = window.vrtti.store.get(${JSON.stringify(localId)});
        return {
          trashedAt: updated?.trashedAt ?? null,
          closedAt: updated?.closedAt ?? null,
          inRecent: window.vrtti.store.recentBuffers().some((r) => r.id === ${JSON.stringify(localId)}),
          inTrash: window.vrtti.trashed().some((r) => r.id === ${JSON.stringify(localId)}),
          barRecentHidden: document.getElementById("bar-recent").hidden,
          barTrashHidden: document.getElementById("bar-trash").hidden,
        };
      })()`);
      assert.ok(afterExpire.trashedAt > 0, "expired Recent note must move into 30d Trash");
      assert.equal(afterExpire.closedAt, null);
      assert.equal(afterExpire.inRecent, false);
      assert.equal(afterExpire.inTrash, true);
      assert.equal(afterExpire.barRecentHidden, true);
      assert.equal(afterExpire.barTrashHidden, false);

      // 31-day-old Trash note purges permanently.
      const afterPurge = await cdp.eval(`(async () => {
        const rec = window.vrtti.store.get(${JSON.stringify(localId)});
        rec.trashedAt = Date.now() - 31 * ${DAY};
        await window.vrtti.store.putSystemRecord(rec);
        await window.vrtti.emptyOldTrash(Date.now());
        return {
          exists: Boolean(window.vrtti.store.get(${JSON.stringify(localId)})),
          barTrashHidden: document.getElementById("bar-trash").hidden,
        };
      })()`);
      assert.equal(afterPurge.exists, false);
      assert.equal(afterPurge.barTrashHidden, true);

      // Upgrade safety (Review #11): a closed local note from before §28 has no
      // `closedAt` and a 60d-old `updatedAt`. Reloading must stamp `closedAt = now`
      // and keep it in Recent instead of dumping archived notes into Trash.
      const legacyId = await cdp.eval(`(async () => {
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Pre-upgrade archived note\\nbody");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.closeBuffer(b.id);
        const rec = window.vrtti.store.get(b.id);
        delete rec.closedAt;
        rec.createdAt = Date.now() - 60 * ${DAY};
        rec.updatedAt = Date.now() - 60 * ${DAY};
        await window.vrtti.store.putSystemRecord(rec);
        return b.id;
      })()`);
      await devA.page.reload();
      const afterUpgradeReload = await cdp.eval(`(async () => {
        const rec = window.vrtti.store.get(${JSON.stringify(legacyId)});
        const res = {
          inRecent: window.vrtti.store.recentBuffers().some((r) => r.id === ${JSON.stringify(legacyId)}),
          trashedAt: rec?.trashedAt ?? null,
          freshClosedAt: typeof rec?.closedAt === "number" && Date.now() - rec.closedAt < 60_000,
        };
        await window.vrtti.run("doc.trash", ${JSON.stringify(legacyId)});
        await window.vrtti.run("doc.deleteForever", ${JSON.stringify(legacyId)});
        return res;
      })()`);
      assert.equal(afterUpgradeReload.inRecent, true, "pre-upgrade Recent note must stay in Recent on first launch");
      assert.equal(afterUpgradeReload.trashedAt, null);
      assert.equal(afterUpgradeReload.freshClosedAt, true, "startup must stamp a fresh closedAt window");

      // File-backed notes via OPFS: unwritten protection vs clean removal without touching disk.
      const fileResult = await cdp.eval(`(async () => {
        const root = await navigator.storage.getDirectory();
        const fhUnwritten = await root.getFileHandle("unwritten.md", { create: true });
        {
          const w = await fhUnwritten.createWritable();
          await w.write("original disk text");
          await w.close();
        }
        const recU = await window.vrtti.store.createFromFile(fhUnwritten);
        // Simulate a failed write holding unsaved text only in IDB.
        recU.file.unwritten = true;
        recU.content = "UNSAVED TEXT ONLY IN IDB";
        recU.closedAt = Date.now() - 35 * ${DAY};
        await window.vrtti.store.putSystemRecord(recU);

        // Close it and run expireOldRecent: must NOT expire!
        await window.vrtti.closeBuffer(recU.id);
        recU.closedAt = Date.now() - 35 * ${DAY};
        await window.vrtti.store.putSystemRecord(recU);
        await window.vrtti.expireOldRecent(Date.now());
        const survivedExpiry = Boolean(window.vrtti.store.get(recU.id));

        // Reopen and verify rowMenu disables Remove from list with exact hint.
        await window.vrtti.reopen(recU.id);
        const rowU = document.querySelector('#open-list .buffer-row[data-id="' + recU.id + '"]');
        rowU.querySelector(".buffer-more").click();
        const removeBtn = [...document.querySelectorAll(".menu .menu-item")].find((b) =>
          b.textContent.includes("Remove from list")
        );
        const menuDisabled = Boolean(removeBtn?.disabled);
        const menuHint = removeBtn?.querySelector(".menu-hint")?.textContent ?? "";
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

        // Shift+click × and Delete mode click must refuse and show the notice.
        rowU.querySelector(".buffer-close").dispatchEvent(
          new MouseEvent("click", { bubbles: true, shiftKey: true })
        );
        await new Promise((r) => setTimeout(r, 30));
        const noticeAfterShift = document.getElementById("status-state").textContent;
        const survivedShift = Boolean(window.vrtti.store.get(recU.id));

        document.getElementById("act-del").click();
        const trashIconBtn = document.querySelector('#open-list .buffer-row[data-id="' + recU.id + '"] .buffer-trash');
        trashIconBtn.click();
        await new Promise((r) => setTimeout(r, 30));
        const survivedDelMode = Boolean(window.vrtti.store.get(recU.id));
        document.getElementById("act-del").click(); // exit delete mode

        // Clean file-backed note: Remove from list forgets IDB record without touching disk.
        const fhClean = await root.getFileHandle("clean.md", { create: true });
        {
          const w = await fhClean.createWritable();
          await w.write("stay on disk forever");
          await w.close();
        }
        const recC = await window.vrtti.store.createFromFile(fhClean);
        const removedClean = await window.vrtti.run("doc.trash", recC.id);
        const cleanGoneFromStore = !window.vrtti.store.get(recC.id);
        const diskTextAfterRemove = await (await fhClean.getFile()).text();

        // Clean closed file older than 30d expires from Recent without touching disk.
        const fhOld = await root.getFileHandle("old-clean.md", { create: true });
        {
          const w = await fhOld.createWritable();
          await w.write("old file stays on disk");
          await w.close();
        }
        const recO = await window.vrtti.store.createFromFile(fhOld);
        await window.vrtti.closeBuffer(recO.id);
        recO.closedAt = Date.now() - 35 * ${DAY};
        await window.vrtti.store.putSystemRecord(recO);
        await window.vrtti.expireOldRecent(Date.now());
        const oldGoneFromStore = !window.vrtti.store.get(recO.id);
        const oldDiskText = await (await fhOld.getFile()).text();

        // Clean up unwritten test record by clearing flag and removing.
        delete recU.file.unwritten;
        await window.vrtti.run("doc.trash", recU.id);

        return {
          survivedExpiry,
          menuDisabled,
          menuHint,
          noticeAfterShift,
          survivedShift,
          survivedDelMode,
          removedClean,
          cleanGoneFromStore,
          diskTextAfterRemove,
          oldGoneFromStore,
          oldDiskText,
        };
      })()`);

      assert.equal(fileResult.survivedExpiry, true);
      assert.equal(fileResult.menuDisabled, true);
      assert.equal(fileResult.menuHint, "Unsaved text is not on disk; reconnect or Unlink file first");
      assert.equal(fileResult.noticeAfterShift, "Unsaved text is not on disk; reconnect or Unlink file first");
      assert.equal(fileResult.survivedShift, true);
      assert.equal(fileResult.survivedDelMode, true);
      assert.equal(fileResult.removedClean, true);
      assert.equal(fileResult.cleanGoneFromStore, true);
      assert.equal(fileResult.diskTextAfterRemove, "stay on disk forever");
      assert.equal(fileResult.oldGoneFromStore, true);
      assert.equal(fileResult.oldDiskText, "old file stays on disk");
    });

    test("2. Desktop UI: 0px Delete mode shift, Esc & typing exit, Alt+W/Shift+click trash, View filter, shared drawer", async () => {
      const { cdp } = devA.page;
      await setupFirstDevice(cdp, {
        name: "Laptop",
        serverUrl: syncSrv.url,
        serverToken: syncSrv.token,
      });

      // Create tabs across local, personal, and infra.
      const setup = await cdp.eval(`(async () => {
        await window.vrtti.sync.setNewNotes(null);
        const loc1 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(loc1.id, "Local Note 1\\nbody");
        await window.vrtti.saveNow(loc1.id);

        const loc2 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(loc2.id, "Local Note 2\\nbody");
        await window.vrtti.saveNow(loc2.id);

        await window.vrtti.sync.setNewNotes("personal");
        const per1 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(per1.id, "Personal Note 1\\nbody");
        await window.vrtti.saveNow(per1.id);

        const per2 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(per2.id, "Personal Note 2\\nbody");
        await window.vrtti.saveNow(per2.id);

        await window.vrtti.sync.syncNow();
        return { loc1: loc1.id, loc2: loc2.id, per1: per1.id, per2: per2.id };
      })()`);

      // Zero-shift Delete mode check.
      const shiftCheck = await cdp.eval(`(() => {
        const measure = () => ({
          actionsTop: document.getElementById("open-actions").getBoundingClientRect().top,
          headingTop: document.getElementById("open-heading-row").getBoundingClientRect().top,
          listTop: document.getElementById("open-list").getBoundingClientRect().top,
          firstRowTop: document.querySelector("#open-list .buffer-row").getBoundingClientRect().top,
        });
        const before = measure();
        document.getElementById("act-del").click();
        const after = measure();
        const hasClass = document.getElementById("sidebar").classList.contains("delete-mode");
        const pillVisible = !document.getElementById("delete-pill").hidden;
        const trashBtnCount = document.querySelectorAll("#open-list .buffer-trash").length;
        const closeBtnCount = document.querySelectorAll("#open-list .buffer-close").length;
        return { before, after, hasClass, pillVisible, trashBtnCount, closeBtnCount };
      })()`);

      assert.equal(shiftCheck.hasClass, true);
      assert.equal(shiftCheck.pillVisible, true);
      assert.ok(shiftCheck.trashBtnCount > 0);
      assert.equal(shiftCheck.closeBtnCount, 0);
      assert.equal(shiftCheck.after.actionsTop, shiftCheck.before.actionsTop, "0px shift on #open-actions");
      assert.equal(shiftCheck.after.headingTop, shiftCheck.before.headingTop, "0px shift on #open-heading-row");
      assert.equal(shiftCheck.after.listTop, shiftCheck.before.listTop, "0px shift on #open-list");
      assert.equal(shiftCheck.after.firstRowTop, shiftCheck.before.firstRowTop, "0px shift on first row");

      // Escape exits Delete mode; typing in editor exits Delete mode; Alt+W in Delete mode trashes.
      const delInteractions = await cdp.eval(`(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        const afterEsc = window.vrtti.sidebar.isDeleteMode();

        // Re-enter Delete mode and type in editor -> docChanged exits Delete mode.
        document.getElementById("act-del").click();
        const beforeType = window.vrtti.sidebar.isDeleteMode();
        const cmContent = document.querySelector(".cm-content");
        cmContent.focus();
        // Insert a character via CodeMirror's DOM/input path.
        document.execCommand("insertText", false, "!");
        await new Promise((r) => setTimeout(r, 40));
        const afterType = window.vrtti.sidebar.isDeleteMode();

        // Re-enter Delete mode and run bare buffer.close (Alt+W / Ctrl+W path) -> trashes active tab.
        await window.vrtti.activateBuffer(${JSON.stringify(setup.loc2)});
        document.getElementById("act-del").click();
        await window.vrtti.run("buffer.close");
        const loc2Trashed = Boolean(window.vrtti.store.get(${JSON.stringify(setup.loc2)})?.trashedAt);
        document.getElementById("delete-pill").click(); // exit via pill
        const afterPill = window.vrtti.sidebar.isDeleteMode();

        // Shift+click × trashes a row without entering Delete mode.
        const per2Close = document.querySelector('#open-list .buffer-row[data-id="' + ${JSON.stringify(setup.per2)} + '"] .buffer-close');
        per2Close.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        await new Promise((r) => setTimeout(r, 40));
        const per2Trashed = Boolean(window.vrtti.store.get(${JSON.stringify(setup.per2)})?.trashedAt);
        await window.vrtti.sync.syncNow();

        return { afterEsc, beforeType, afterType, loc2Trashed, afterPill, per2Trashed };
      })()`);

      assert.equal(delInteractions.afterEsc, false);
      assert.equal(delInteractions.beforeType, true);
      assert.equal(delInteractions.afterType, false);
      assert.equal(delInteractions.loc2Trashed, true);
      assert.equal(delInteractions.afterPill, false);
      assert.equal(delInteractions.per2Trashed, true);

      // View space filter: stay-open toggle, only, auto-unhide on buffer.new, next-visible-tab, Show all.
      const viewCheck = await cdp.eval(`(async () => {
        document.getElementById("act-view").click();
        const menuOpen1 = Boolean(document.querySelector(".menu"));
        // Toggle personal off -> menu stays open.
        const personalToggle = [...document.querySelectorAll(".menu .filter-toggle")].find((b) =>
          b.textContent.includes("personal")
        );
        personalToggle.click();
        const menuStayedOpen = Boolean(document.querySelector(".menu"));
        const viewLit = document.getElementById("act-view").classList.contains("active-accent");
        const pillText = document.getElementById("open-filter-pill").textContent;
        const per1Hidden = !document.querySelector('#open-list .buffer-row[data-id="' + ${JSON.stringify(setup.per1)} + '"]');

        // Click "only" on Local & files.
        const localRow = [...document.querySelectorAll(".menu .filter-row")].find((r) =>
          r.textContent.includes("Local & files")
        );
        localRow.querySelector(".filter-only").click();
        const onlyLocalRows = [...document.querySelectorAll("#open-list .buffer-row")].every(
          (r) => !window.vrtti.store.get(r.dataset.id)?.sync
        );

        // Creating a new note in hidden space (personal) auto-unhides personal!
        const created = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(created.id, "Auto-unhidden personal note");
        await window.vrtti.saveNow(created.id);
        const createdVisible = Boolean(
          document.querySelector('#open-list .buffer-row[data-id="' + created.id + '"]')
        );

        // Close menu, re-open, verify keyboard focus survives stayOpen re-render
        // and ArrowDown/ArrowUp reach "only" and "Show all" (Review #14), then Show all.
        document.getElementById("act-view").click();
        if (!document.querySelector(".menu")) document.getElementById("act-view").click();
        const firstToggle = document.querySelector(".menu .filter-toggle");
        firstToggle.focus();
        firstToggle.click();
        const focusKeptAfterToggle =
          document.activeElement?.classList.contains("filter-toggle") ?? false;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        const arrowReachedOnly =
          document.activeElement?.classList.contains("filter-only") ?? false;
        document.querySelector(".menu .filter-toggle").focus();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
        const arrowReachedShowAll =
          Boolean(document.activeElement?.closest(".menu-head")) ||
          document.activeElement?.classList.contains("filter-only") ||
          false;
        document.querySelector(".menu .menu-head button").click();
        const pillHiddenAfterAll = document.getElementById("open-filter-pill").hidden;
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

        // Spelling-style menu anchored to editor text (cm-content, no aria-haspopup,
        // Review #12): second openMenu replaces instead of toggling closed, and
        // pointerdown inside cm-content closes the menu.
        const { openMenu } = await import("/js/ui/menu.js");
        const cmContent = document.querySelector(".cm-content");
        const rect = cmContent.getBoundingClientRect();
        const at = { left: rect.left + 20, top: rect.top + 20, bottom: rect.top + 40 };
        openMenu(cmContent, [{ label: "First suggestion", act() {} }], { at });
        openMenu(cmContent, [{ label: "Second suggestion", act() {} }], { at });
        const spellReplacedLabel = document.querySelector(".menu .menu-label")?.textContent ?? "";
        cmContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        const spellClosedOnEditorClick = !document.querySelector(".menu");

        // Cleanup created note.
        await window.vrtti.run("doc.trash", created.id);
        await window.vrtti.sync.syncNow();
        return {
          menuOpen1,
          menuStayedOpen,
          viewLit,
          pillText,
          per1Hidden,
          onlyLocalRows,
          createdVisible,
          focusKeptAfterToggle,
          arrowReachedOnly,
          arrowReachedShowAll,
          pillHiddenAfterAll,
          spellReplacedLabel,
          spellClosedOnEditorClick,
        };
      })()`);

      assert.equal(viewCheck.menuOpen1, true);
      assert.equal(viewCheck.menuStayedOpen, true);
      assert.equal(viewCheck.viewLit, true);
      assert.match(viewCheck.pillText, /^\(\d+\/\d+\)$/);
      assert.equal(viewCheck.per1Hidden, true);
      assert.equal(viewCheck.onlyLocalRows, true);
      assert.equal(viewCheck.createdVisible, true);
      assert.equal(viewCheck.focusKeptAfterToggle, true, "stayOpen toggle must preserve keyboard focus");
      assert.equal(viewCheck.arrowReachedOnly, true, "ArrowDown must reach secondary `only` button");
      assert.equal(viewCheck.arrowReachedShowAll, true);
      assert.equal(viewCheck.pillHiddenAfterAll, true);
      assert.equal(viewCheck.spellReplacedLabel, "Second suggestion", "second openMenu on cm-content must replace");
      assert.equal(viewCheck.spellClosedOnEditorClick, true, "clicking editor text must close menu anchored to cm-content");

      // Shared bottom drawer: single drawer open at a time, Trash click opens menu (no editor preview).
      const drawerCheck = await cdp.eval(`(async () => {
        await window.vrtti.closeBuffer(${JSON.stringify(setup.loc1)});
        const activeBefore = window.vrtti.activeId;
        document.getElementById("bar-recent").click();
        const recentTitle = document.getElementById("drawer-title").textContent;
        document.getElementById("bar-trash").click();
        const trashTitle = document.getElementById("drawer-title").textContent;
        // Clicking a Trash row opens its menu and does NOT change activeId.
        const trashRow = document.querySelector("#drawer-list .trash-row");
        trashRow.click();
        const menuOpen = Boolean(document.querySelector(".menu"));
        const activeAfter = window.vrtti.activeId;
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        document.getElementById("drawer-close").click();
        const closedHidden = document.getElementById("bottom-drawer").hidden;
        return { recentTitle, trashTitle, menuOpen, activeUnchanged: activeBefore === activeAfter, closedHidden };
      })()`);
      assert.match(drawerCheck.recentTitle, /^Recent \(1\)$/);
      assert.match(drawerCheck.trashTitle, /^Deleted notes \(\d+\)$/);
      assert.equal(drawerCheck.menuOpen, true);
      assert.equal(drawerCheck.activeUnchanged, true);
      assert.equal(drawerCheck.closedHidden, true);
    });

    test("3. Space lifecycle (Titles only demotion + dirty defer) & PIN privacy in demoteToStub, applyStub, unsealPending", async () => {
      const cdpA = devA.page.cdp;
      const cdpB = devB.page.cdp;
      await devB.page.goto(staticSrv.url);
      await joinSecondDevice(cdpA, cdpB, {
        name: "Secondary",
        serverUrl: syncSrv.url,
        spaces: { personal: "tab", infra: "list" },
        askPassphrase: true,
        passphrase: "device-b-pass",
      });

      // Clean Titles only note demotes to RemoteStub on close.
      const infraId = await cdpA.eval(`(async () => {
        await window.vrtti.sync.setNewNotes("infra");
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Infra Runbook\\nRestart nginx");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.sync.syncNow();
        await window.vrtti.closeBuffer(b.id);
        return b.id;
      })()`);

      const afterCleanClose = await cdpA.eval(`({
        hasRecord: Boolean(window.vrtti.store.get(${JSON.stringify(infraId)})),
        stub: window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(infraId)}) ?? null,
        badgeText: document.querySelector('#bar-spaces [data-space="infra"] .space-badge')?.textContent ?? null,
      })`);
      assert.equal(afterCleanClose.hasRecord, false, "clean Titles only note must drop local body on close");
      assert.equal(afterCleanClose.stub?.title, "Infra Runbook");
      assert.equal(afterCleanClose.badgeText, "I");

      // Dirty Titles only note stays cached locally until afterPush lands, then demotes!
      await cdpA.eval(`window.vrtti.run("remote.open", ${JSON.stringify(infraId)})`);
      await devA.page.setOffline(true);
      const whileDirtyClosed = await cdpA.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(infraId)}, "Infra Runbook\\nRestart nginx v2");
        await window.vrtti.saveNow(${JSON.stringify(infraId)});
        await window.vrtti.closeBuffer(${JSON.stringify(infraId)});
        return {
          hasRecord: Boolean(window.vrtti.store.get(${JSON.stringify(infraId)})),
          inClosedSpace: window.vrtti.store.closedSpaceBuffers("infra").some((r) => r.id === ${JSON.stringify(infraId)}),
          hasStub: window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(infraId)}),
        };
      })()`);
      assert.equal(whileDirtyClosed.hasRecord, true, "dirty Titles only note must stay cached locally");
      assert.equal(whileDirtyClosed.inClosedSpace, true);
      assert.equal(whileDirtyClosed.hasStub, false);

      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      const afterPushDemote = await cdpA.eval(`({
        hasRecord: Boolean(window.vrtti.store.get(${JSON.stringify(infraId)})),
        stub: window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(infraId)}) ?? null,
      })`);
      assert.equal(afterPushDemote.hasRecord, false, "afterPush must demote clean closed Titles only note");
      assert.equal(afterPushDemote.stub?.title, "Infra Runbook");

      // PIN privacy in demoteToStub (while PIN is UNLOCKED!), applyStub, and unsealPending!
      const pinNotes = await cdpA.eval(`(async () => {
        const salt = new Uint8Array(16).fill(3);
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("1234"), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 200000 }, key, 256);
        const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
        await window.vrtti.settings.put("pin.hash", { salt: [...salt], hash });
        // Unlock PIN so titleOf(record) WOULD return the first line if misused!
        window.vrtti.store.pinUnlock();

        const untitled = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(untitled.id, "SUPER SECRET PIN FIRST LINE\\nbody");
        await window.vrtti.saveNow(untitled.id);
        await window.vrtti.store.setPin(untitled.id, true);

        const titled = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(titled.id, "SECRET BODY LINE\\nbody");
        await window.vrtti.renameBuffer(titled.id, "Public Label");
        await window.vrtti.saveNow(titled.id);
        await window.vrtti.store.setPin(titled.id, true);

        await window.vrtti.sync.syncNow();
        // Close BOTH while PIN is STILL unlocked!
        await window.vrtti.closeBuffer(untitled.id);
        await window.vrtti.closeBuffer(titled.id);
        // Re-lock PIN and inspect drawer DOM + stubs.
        window.vrtti.store.pinLock();
        document.querySelector('#bar-spaces [data-space="infra"]').click();
        const stubU = window.vrtti.remotes().find((s) => s.id === untitled.id);
        const stubT = window.vrtti.remotes().find((s) => s.id === titled.id);
        const domText = document.getElementById("drawer-list").textContent;
        document.getElementById("drawer-close").click();
        return { untitledId: untitled.id, titledId: titled.id, stubU, stubT, domText };
      })()`);

      assert.equal(pinNotes.stubU?.pin, true);
      assert.equal(pinNotes.stubU?.title, "", "demoteToStub must NEVER leak PIN first line");
      assert.equal(pinNotes.stubT?.pin, true);
      assert.equal(pinNotes.stubT?.title, "Public Label");
      assert.equal(pinNotes.domText.includes("SUPER SECRET"), false);
      assert.equal(pinNotes.domText.includes("Locked note"), true);

      // Device B pulls while unlocked (applyStub): must NOT leak PIN first line.
      await cdpB.eval(`window.vrtti.sync.syncNow()`);
      const bUnlocked = await cdpB.eval(`({
        stubU: window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(pinNotes.untitledId)}),
        stubT: window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(pinNotes.titledId)}),
      })`);
      assert.equal(bUnlocked.stubU?.pin, true);
      assert.equal(bUnlocked.stubU?.title, "", "applyStub must NEVER leak PIN first line");
      assert.equal(bUnlocked.stubT?.title, "Public Label");

      // Device B locks keyring, A pushes another untitled PIN note, B pulls while locked then unlocks (unsealPending).
      await cdpB.eval(`window.vrtti.run("crypto.lock")`);
      const pinLockedId = await cdpA.eval(`(async () => {
        window.vrtti.store.pinUnlock();
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "UNSEAL SECRET LINE\\nmore");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.store.setPin(b.id, true);
        await window.vrtti.sync.syncNow();
        await window.vrtti.closeBuffer(b.id);
        window.vrtti.store.pinLock();
        return b.id;
      })()`);
      await cdpB.eval(`window.vrtti.sync.syncNow()`);
      const bWhileLocked = await cdpB.eval(`window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(pinLockedId)})`);
      assert.ok(bWhileLocked?.sealed, "stub must wait for unseal while locked");
      await cdpB.eval(`(async () => {
        await window.vrtti.keyring.unlock("device-b-pass");
        await new Promise((r) => setTimeout(r, 150));
      })()`);
      const bAfterUnseal = await cdpB.eval(`window.vrtti.remotes().find((s) => s.id === ${JSON.stringify(pinLockedId)})`);
      assert.equal(bAfterUnseal?.pin, true);
      assert.equal(bAfterUnseal?.title, "", "unsealPending must NEVER leak PIN first line");
      assert.equal(bAfterUnseal?.sealed, undefined);

      // Reset New notes back to personal for subsequent tests.
      await cdpA.eval(`window.vrtti.sync.setNewNotes("personal")`);
    });

    test("4. Synced Move to trash, offline conflicts, Restore to <space> (fresh docId, no 409), Restore as local, stub trash", async () => {
      const cdpA = devA.page.cdp;
      const cdpB = devB.page.cdp;

      // Helper to create a synced personal note on A and sync to B.
      async function makeSynced(text, space = "personal") {
        const id = await cdpA.eval(`(async () => {
          await window.vrtti.sync.setNewNotes(${JSON.stringify(space)});
          const b = await window.vrtti.createBuffer();
          window.vrtti.store.updateContent(b.id, ${JSON.stringify(text)});
          await window.vrtti.saveNow(b.id);
          await window.vrtti.sync.syncNow();
          return b.id;
        })()`);
        await cdpB.eval(`window.vrtti.sync.syncNow()`);
        return id;
      }

      // 4a. Online synced trash: A & B (tab) both keep 30d Trash; Titles only stub on B drops cleanly without Trash.
      const n1 = await makeSynced("Note N1 for online trash", "personal");
      const infraStubId = await makeSynced("Note InfraStub for remote drop", "infra");
      await cdpA.eval(`window.vrtti.sync.setNewNotes("personal")`);

      await cdpA.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(n1)});
        await window.vrtti.run("doc.trash", ${JSON.stringify(infraStubId)});
        await window.vrtti.sync.syncNow();
      })()`);
      await cdpB.eval(`window.vrtti.sync.syncNow()`);

      const check4a = await cdpB.eval(`({
        n1Trashed: Boolean(window.vrtti.store.get(${JSON.stringify(n1)})?.trashedAt),
        n1Origin: window.vrtti.store.get(${JSON.stringify(n1)})?.originSpace ?? null,
        infraStubStillPresent: window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(infraStubId)}),
        infraInTrash: window.vrtti.trashed().some((r) => r.id === ${JSON.stringify(infraStubId)}),
      })`);
      assert.equal(check4a.n1Trashed, true);
      assert.equal(check4a.n1Origin, "personal");
      assert.equal(check4a.infraStubStillPresent, false);
      assert.equal(check4a.infraInTrash, false, "unopened Titles only stub drops without local Trash");

      // 4b. Settled trash + Restore to <space> -> fresh docId, pushes cleanly (no 409 loop!), arrives on B.
      const restoredN1 = await cdpA.eval(`(async () => {
        const res = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(n1)}, toSpace: true });
        await window.vrtti.sync.syncNow();
        return {
          newId: res?.id ?? null,
          oldGone: !window.vrtti.store.get(${JSON.stringify(n1)}),
          rev: window.vrtti.store.get(res.id)?.sync?.rev ?? 0,
          dirty: window.vrtti.store.get(res.id)?.sync?.dirty ?? true,
          space: window.vrtti.store.get(res.id)?.sync?.space ?? null,
        };
      })()`);
      assert.ok(restoredN1.newId && restoredN1.newId !== n1, "settled Restore to <space> must mint fresh docId");
      assert.equal(restoredN1.oldGone, true);
      assert.equal(restoredN1.rev, 1);
      assert.equal(restoredN1.dirty, false, "must push cleanly without 409 loop");
      assert.equal(restoredN1.space, "personal");
      await cdpB.eval(`window.vrtti.sync.syncNow()`);
      const bGotRestored = await cdpB.eval(`window.vrtti.textOf(${JSON.stringify(restoredN1.newId)})`);
      assert.equal(bGotRestored, "Note N1 for online trash");

      // 4c. Offline trash on A + remote delete on B -> A keeps its 30d Trash copy (no conflict fork).
      const n2 = await makeSynced("Note N2 concurrent delete", "personal");
      await devA.page.setOffline(true);
      await cdpA.eval(`window.vrtti.run("doc.trash", ${JSON.stringify(n2)})`);
      await cdpB.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(n2)});
        await window.vrtti.sync.syncNow();
      })()`);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      const check4c = await cdpA.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(n2)});
        const conflicts = [...window.vrtti.buffers.values()].filter((b) =>
          (b.content || "").includes("conflict copy")
        );
        return { trashedAt: Boolean(rec?.trashedAt), sync: rec?.sync ?? null, originSpace: rec?.originSpace, conflicts: conflicts.length };
      })()`);
      assert.equal(check4c.trashedAt, true);
      assert.equal(check4c.sync, null);
      assert.equal(check4c.originSpace, "personal");
      assert.equal(check4c.conflicts, 0);

      // 4d. Settled trash + Restore as local + later Sync to <space> -> fresh docId, pushes cleanly (no 409!).
      const resLocal = await cdpA.eval(`(async () => {
        const res = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(n2)}, toSpace: false });
        const inRecent = window.vrtti.store.recentBuffers().some((r) => r.id === res.id);
        await window.vrtti.reopen(res.id);
        await window.vrtti.run("doc.sync.on", { id: res.id, space: "personal" });
        await window.vrtti.sync.syncNow();
        const rec = window.vrtti.store.get(res.id);
        return { newId: res.id, inRecent, rev: rec?.sync?.rev ?? 0, dirty: rec?.sync?.dirty ?? true };
      })()`);
      assert.ok(resLocal.newId && resLocal.newId !== n2);
      assert.equal(resLocal.inRecent, true);
      assert.equal(resLocal.rev, 1);
      assert.equal(resLocal.dirty, false);

      // 4e. Offline edit + offline trash + offline Restore to <space> -> preserves priorDirty and pushes edit!
      const n3 = await makeSynced("Note N3 before offline edit", "personal");
      await devA.page.setOffline(true);
      const afterOfflineUndo = await cdpA.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(n3)}, "Note N3 edited offline and restored");
        await window.vrtti.saveNow(${JSON.stringify(n3)});
        await window.vrtti.run("doc.trash", ${JSON.stringify(n3)});
        const whileTrashed = window.vrtti.store.get(${JSON.stringify(n3)})?.sync;
        const restored = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(n3)}, toSpace: true });
        return {
          priorDirty: whileTrashed?.priorDirty,
          sameId: restored?.id === ${JSON.stringify(n3)},
          dirtyAfter: restored?.sync?.dirty,
          tombstoneAfter: restored?.sync?.tombstone ?? null,
        };
      })()`);
      assert.equal(afterOfflineUndo.priorDirty, true);
      assert.equal(afterOfflineUndo.sameId, true);
      assert.equal(afterOfflineUndo.dirtyAfter, true);
      assert.equal(afterOfflineUndo.tombstoneAfter, null);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      const bTextN3 = await cdpB.eval(`window.vrtti.textOf(${JSON.stringify(n3)})`);
      assert.equal(bTextN3, "Note N3 edited offline and restored");

      // 4f. Offline trash on A + newer remote edit on B -> B wins, clears trashedAt on A, live in space.
      const n4 = await makeSynced("Note N4 initial", "personal");
      await devA.page.setOffline(true);
      await cdpA.eval(`window.vrtti.run("doc.trash", ${JSON.stringify(n4)})`);
      await cdpB.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(n4)}, "Note N4 edited by B wins");
        await window.vrtti.saveNow(${JSON.stringify(n4)});
        await window.vrtti.sync.syncNow();
      })()`);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      const check4f = await cdpA.eval(`(async () => {
        const rec = window.vrtti.store.get(${JSON.stringify(n4)});
        const text = await window.vrtti.textOf(${JSON.stringify(n4)});
        return {
          trashedAt: rec?.trashedAt ?? null,
          originSpace: rec?.originSpace ?? null,
          tombstone: rec?.sync?.tombstone ?? null,
          isOpen: window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(n4)}),
          text,
        };
      })()`);
      assert.equal(check4f.trashedAt, null);
      assert.equal(check4f.originSpace, null);
      assert.equal(check4f.tombstone, null);
      assert.equal(check4f.isOpen, true);
      assert.equal(check4f.text, "Note N4 edited by B wins");

      // 4g. Offline trash + Restore as local -> fresh local copy in Recent, original tombstone still pushes to server!
      const n5 = await makeSynced("Note N5 offline restore local", "personal");
      await devA.page.setOffline(true);
      const localCopy5 = await cdpA.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(n5)});
        const copy = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(n5)}, toSpace: false });
        return {
          copyId: copy?.id ?? null,
          oldInTrash: window.vrtti.trashed().some((r) => r.id === ${JSON.stringify(n5)}),
          oldDirtyTombstone: window.vrtti.dirtyRecords().some((r) => r.id === ${JSON.stringify(n5)} && r.sync?.tombstone === "deleted"),
        };
      })()`);
      assert.ok(localCopy5.copyId && localCopy5.copyId !== n5);
      assert.equal(localCopy5.oldInTrash, false);
      assert.equal(localCopy5.oldDirtyTombstone, true);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      const check4g = await cdpA.eval(`({
        oldForgotten: !window.vrtti.store.get(${JSON.stringify(n5)}),
        localCopyKept: Boolean(window.vrtti.store.get(${JSON.stringify(localCopy5.copyId)})),
      })`);
      const bTrashedN5 = await cdpB.eval(`Boolean(window.vrtti.store.get(${JSON.stringify(n5)})?.trashedAt)`);
      assert.equal(check4g.oldForgotten, true);
      assert.equal(check4g.localCopyKept, true);
      assert.equal(bTrashedN5, true);

      // 4h. Offline trash + Delete permanently -> vanishes from Trash immediately, tombstone still pushes & forgets!
      const n6 = await makeSynced("Note N6 offline delete forever", "personal");
      await devA.page.setOffline(true);
      const perm6 = await cdpA.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(n6)});
        await window.vrtti.run("doc.deleteForever", ${JSON.stringify(n6)});
        return {
          inTrash: window.vrtti.trashed().some((r) => r.id === ${JSON.stringify(n6)}),
          stillPendingPush: window.vrtti.dirtyRecords().some((r) => r.id === ${JSON.stringify(n6)} && r.sync?.tombstone === "deleted"),
        };
      })()`);
      assert.equal(perm6.inTrash, false);
      assert.equal(perm6.stillPendingPush, true);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      assert.equal(await cdpA.eval(`!window.vrtti.store.get(${JSON.stringify(n6)})`), true);
      assert.equal(await cdpB.eval(`Boolean(window.vrtti.store.get(${JSON.stringify(n6)})?.trashedAt)`), true);

      // 4i. Unopened Titles only stub trash: offline refuses; online fetches & keeps local Trash copy + deletes on B.
      const n7 = await cdpB.eval(`(async () => {
        await window.vrtti.sync.setNewNotes("infra");
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Stub N7 created on B\\nbody");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.sync.syncNow();
        await window.vrtti.sync.setNewNotes("personal");
        return b.id;
      })()`);
      await syncAndWait(cdpA);
      assert.equal(
        await cdpA.eval(`window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(n7)})`),
        true,
        "A must have N7 as an unopened stub"
      );

      await devA.page.setOffline(true);
      const offlineStubTrash = await cdpA.eval(`(async () => {
        const ok = await window.vrtti.run("remote.trash", ${JSON.stringify(n7)});
        return {
          ok,
          notice: document.getElementById("status-state").textContent,
          stubKept: window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(n7)}),
        };
      })()`);
      assert.equal(offlineStubTrash.ok, false);
      assert.match(offlineStubTrash.notice, /offline/i);
      assert.equal(offlineStubTrash.stubKept, true);

      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      const onlineStubTrash = await cdpA.eval(`(async () => {
        const ok = await window.vrtti.run("remote.trash", ${JSON.stringify(n7)});
        return { ok };
      })()`);
      await syncAndWait(cdpA);
      const onlineStubState = await cdpA.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(n7)});
        return {
          stubGone: !window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(n7)}),
          inTrash: Boolean(rec?.trashedAt),
          originSpace: rec?.originSpace ?? null,
        };
      })()`);
      assert.equal(onlineStubTrash.ok, true);
      assert.equal(onlineStubState.stubGone, true);
      assert.equal(onlineStubState.inTrash, true);
      assert.equal(onlineStubState.originSpace, "infra");
      await syncAndWait(cdpB);
      assert.equal(await cdpB.eval(`Boolean(window.vrtti.store.get(${JSON.stringify(n7)})?.trashedAt)`), true);

      // 4j. In-flight text push returning after doc.trash must NOT settle deleted tombstone early (Review #1).
      const nRace = await makeSynced("Note Race initial", "personal");
      await devA.page.setOffline(true);
      const raceState = await cdpA.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(nRace)}, "Note Race edited before trash");
        await window.vrtti.saveNow(${JSON.stringify(nRace)});
        const sentUpdatedAt = window.vrtti.store.get(${JSON.stringify(nRace)}).updatedAt;
        // User trashes while the "text" push is still in flight:
        await window.vrtti.run("doc.trash", ${JSON.stringify(nRace)});
        // Now the in-flight "text" push returns rev 1 (matching current server rev so next push succeeds):
        await window.vrtti.store.afterPush(${JSON.stringify(nRace)}, 1, sentUpdatedAt, undefined, "text");
        const rec = window.vrtti.store.get(${JSON.stringify(nRace)});
        return {
          tombstone: rec?.sync?.tombstone ?? null,
          dirty: rec?.sync?.dirty ?? false,
        };
      })()`);
      assert.equal(raceState.tombstone, "deleted", "in-flight text afterPush must keep deleted tombstone");
      assert.equal(raceState.dirty, true);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      assert.equal(await cdpB.eval(`Boolean(window.vrtti.store.get(${JSON.stringify(nRace)})?.trashedAt)`), true);

      // 4k. emptyOldTrash on >30d offline tombstone hides local Trash but preserves pending push (Review #2).
      const DAY = 24 * 60 * 60 * 1000;
      const nOldTomb = await makeSynced("Note OldTomb offline >30d", "personal");
      await devA.page.setOffline(true);
      const oldTombCheck = await cdpA.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(nOldTomb)});
        const rec = window.vrtti.store.get(${JSON.stringify(nOldTomb)});
        rec.trashedAt = Date.now() - 31 * ${DAY};
        await window.vrtti.store.putSystemRecord(rec);
        await window.vrtti.emptyOldTrash(Date.now());
        return {
          inTrash: window.vrtti.trashed().some((r) => r.id === ${JSON.stringify(nOldTomb)}),
          stillDirtyDelete: window.vrtti.dirtyRecords().some(
            (r) => r.id === ${JSON.stringify(nOldTomb)} && r.sync?.tombstone === "deleted"
          ),
        };
      })()`);
      assert.equal(oldTombCheck.inTrash, false, "expired local Trash body must vanish at 30d");
      assert.equal(oldTombCheck.stillDirtyDelete, true, "unpushed deleted tombstone must survive emptyOldTrash");
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      assert.equal(await cdpA.eval(`!window.vrtti.store.get(${JSON.stringify(nOldTomb)})`), true);
      assert.equal(await cdpB.eval(`Boolean(window.vrtti.store.get(${JSON.stringify(nOldTomb)})?.trashedAt)`), true);

      // 4l. Settled trashed `.age` synced file Restore to <space> keeps file handle & disk text (Review #3).
      const syncedFileId = await cdpA.eval(`(async () => {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle("synced-restore.md.age", { create: true });
        const armored = await window.vrtti.codec.encode(
          "Synced file body across trash and restore",
          window.vrtti.codec.newEncMeta("this-device"),
          window.vrtti.keyring
        );
        {
          const w = await fh.createWritable();
          await w.write(armored);
          await w.close();
        }
        const rec = await window.vrtti.store.createFromFile(fh);
        await window.vrtti.store.setSync(rec.id, true, "personal");
        await window.vrtti.sync.syncNow();
        return rec.id;
      })()`);
      await syncAndWait(cdpB);
      // Device B trashes the note so Device A's `.age` file-backed record enters settled local Trash!
      await cdpB.eval(`(async () => {
        await window.vrtti.run("doc.trash", ${JSON.stringify(syncedFileId)});
        await window.vrtti.sync.syncNow();
      })()`);
      await syncAndWait(cdpA);
      const restoredFile = await cdpA.eval(`(async () => {
        // First simulate a failed sealForSpace (e.g. failed seal/write before forget):
        // the trashed record must NOT lose record.file in memory so retry works without reload!
        window.vrtti.keyring.recipientsFor = () => {
          throw new Error("simulated write/seal failure");
        };
        let threwOnFail = false;
        try {
          await window.vrtti.restore(${JSON.stringify(syncedFileId)}, { toSpace: true });
        } catch {
          threwOnFail = true;
        } finally {
          delete window.vrtti.keyring.recipientsFor;
        }
        const fileKeptAfterFailure = Boolean(
          window.vrtti.store.get(${JSON.stringify(syncedFileId)})?.file?.handleId
        );

        const res = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(syncedFileId)}, toSpace: true });
        await window.vrtti.sync.syncNow();
        const rec = window.vrtti.store.get(res.id);
        const text = await window.vrtti.textOf(res.id);
        return {
          threwOnFail,
          fileKeptAfterFailure,
          newId: res?.id ?? null,
          kind: rec?.kind ?? null,
          hasFile: Boolean(rec?.file?.handleId),
          space: rec?.sync?.space ?? null,
          rev: rec?.sync?.rev ?? 0,
          text,
        };
      })()`);
      assert.equal(restoredFile.threwOnFail, true);
      assert.equal(restoredFile.fileKeptAfterFailure, true, "failed sealForSpace must keep record.file in memory");
      assert.ok(restoredFile.newId && restoredFile.newId !== syncedFileId);
      assert.equal(restoredFile.kind, "file");
      assert.equal(restoredFile.hasFile, true);
      assert.equal(restoredFile.space, "personal");
      assert.equal(restoredFile.rev, 1);
      assert.equal(restoredFile.text, "Synced file body across trash and restore");
      await syncAndWait(cdpB);
      assert.equal(
        await cdpB.eval(`window.vrtti.textOf(${JSON.stringify(restoredFile.newId)})`),
        "Synced file body across trash and restore"
      );

      // 4m. Restore as local on a `this-device` encrypted note keeps ciphertext encrypted at rest (Review #4).
      const localEncCheck = await cdpA.eval(`(async () => {
        await window.vrtti.sync.setNewNotes(null);
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Local device-encrypted secret");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.encrypt(b.id, "this-device");
        await window.vrtti.run("doc.trash", b.id);
        const restored = await window.vrtti.run("doc.restore", { id: b.id, toSpace: false });
        const raw = window.vrtti.store.get(restored.id);
        const decoded = await window.vrtti.textOf(restored.id);
        await window.vrtti.sync.setNewNotes("personal");
        return {
          preset: raw?.enc?.preset ?? null,
          armoredAtRest: (raw?.content ?? "").startsWith("-----BEGIN AGE ENCRYPTED FILE-----"),
          decoded,
        };
      })()`);
      assert.equal(localEncCheck.preset, "this-device");
      assert.equal(localEncCheck.armoredAtRest, true, "this-device ciphertext must stay encrypted on Restore as local");
      assert.equal(localEncCheck.decoded, "Local device-encrypted secret");

      // 4n. Offline edit + offline trash + newer remote edit forks conflict copy for unsent edit (Review #5).
      const nReviveFork = await makeSynced("ReviveFork v1", "personal");
      await devA.page.setOffline(true);
      await cdpA.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(nReviveFork)}, "ReviveFork offline unsent edit on A");
        await window.vrtti.saveNow(${JSON.stringify(nReviveFork)});
        await window.vrtti.run("doc.trash", ${JSON.stringify(nReviveFork)});
      })()`);
      await cdpB.eval(`(async () => {
        window.vrtti.store.updateContent(${JSON.stringify(nReviveFork)}, "ReviveFork remote winning edit on B");
        await window.vrtti.saveNow(${JSON.stringify(nReviveFork)});
        await window.vrtti.sync.syncNow();
      })()`);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      const reviveForkCheck = await cdpA.eval(`(async () => {
        const winnerText = await window.vrtti.textOf(${JSON.stringify(nReviveFork)});
        let foundFork = false;
        for (const b of window.vrtti.buffers.values()) {
          if (b.id === ${JSON.stringify(nReviveFork)}) continue;
          const t = await Promise.resolve(window.vrtti.textOf(b.id)).catch(() => "");
          if (String(t).includes("ReviveFork offline unsent edit on A")) foundFork = true;
        }
        return { winnerText, foundFork };
      })()`);
      assert.equal(reviveForkCheck.winnerText, "ReviveFork remote winning edit on B");
      assert.equal(reviveForkCheck.foundFork, true, "offline edit before trash must fork on remote revive");

      // 4o. Offline Stop syncing + Move to trash keeps `detached` (never deletes on Device B, Review #6)
      // and detaching a closed synced note resets stale `closedAt` (Review #11b).
      const nDetachTrash = await makeSynced("Note DetachThenTrash stays on B", "personal");
      const nClosedDetach = await makeSynced("Note ClosedDetach resets closedAt", "personal");
      await cdpA.eval(`(async () => {
        await window.vrtti.closeBuffer(${JSON.stringify(nClosedDetach)});
        const rec = window.vrtti.store.get(${JSON.stringify(nClosedDetach)});
        rec.closedAt = Date.now() - 45 * ${DAY};
        await window.vrtti.store.putSystemRecord(rec);
        await window.vrtti.run("doc.sync.off", ${JSON.stringify(nClosedDetach)});
        await window.vrtti.sync.syncNow();
      })()`);
      const closedDetachFresh = await cdpA.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(nClosedDetach)});
        return typeof rec?.closedAt === "number" && Date.now() - rec.closedAt < 60_000;
      })()`);
      assert.equal(closedDetachFresh, true, "detaching a closed synced note must reset closedAt to now");

      await devA.page.setOffline(true);
      const detachTrashOffline = await cdpA.eval(`(async () => {
        await window.vrtti.run("doc.sync.off", ${JSON.stringify(nDetachTrash)});
        await window.vrtti.run("doc.trash", ${JSON.stringify(nDetachTrash)});
        const rec = window.vrtti.store.get(${JSON.stringify(nDetachTrash)});
        return {
          tombstone: rec?.sync?.tombstone ?? null,
          originSpace: rec?.originSpace ?? null,
        };
      })()`);
      assert.equal(detachTrashOffline.tombstone, "detached");
      assert.equal(detachTrashOffline.originSpace, null);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);
      await syncAndWait(cdpB);
      const aDetachedInLocalTrash = await cdpA.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(nDetachTrash)});
        return Boolean(rec && rec.trashedAt && !rec.sync && !rec.originSpace);
      })()`);
      const bKeptDetached = await cdpB.eval(`(() => {
        const rec = window.vrtti.store.get(${JSON.stringify(nDetachTrash)});
        return Boolean(rec && !rec.trashedAt && !rec.sync);
      })()`);
      assert.equal(aDetachedInLocalTrash, true, "A settles into local Trash with no originSpace");
      assert.equal(bKeptDetached, true, "trashing after Stop syncing must NEVER delete note on other devices");

      // 4p. `sync.purge` survives offline trash + offline Restore to <space> (Review #7).
      const nPurge = await makeSynced("Note Purge flag survival", "personal");
      await devA.page.setOffline(true);
      const purgeCheck = await cdpA.eval(`(async () => {
        const rec = window.vrtti.store.get(${JSON.stringify(nPurge)});
        rec.sync.purge = true;
        await window.vrtti.store.putSystemRecord(rec);
        await window.vrtti.run("doc.trash", ${JSON.stringify(nPurge)});
        const whileTrashedPurge = window.vrtti.store.get(${JSON.stringify(nPurge)})?.sync?.purge ?? false;
        const restored = await window.vrtti.run("doc.restore", { id: ${JSON.stringify(nPurge)}, toSpace: true });
        return {
          whileTrashedPurge,
          afterRestorePurge: restored?.sync?.purge ?? false,
          afterRestoreDirty: restored?.sync?.dirty ?? false,
        };
      })()`);
      assert.equal(purgeCheck.whileTrashedPurge, true);
      assert.equal(purgeCheck.afterRestorePurge, true);
      assert.equal(purgeCheck.afterRestoreDirty, true);
      await devA.page.setOffline(false);
      await syncAndWait(cdpA);

      // 4q. `applyRemoteBatch` mid-page failure rollback and `commitPreparedWorkspace`
      // preserving concurrent `addTab` / `removeTab` / `moveTab` / `addFolder` edits.
      const batchAndConcurrentCheck = await cdpA.eval(`(async () => {
        const { applySyncBatch, getWorkspace } = await import("/js/storage/idb.js");
        const ws = window.vrtti.workspaces;
        const store = window.vrtti.store;

        // Part 1: mid-page fetchDoc rejection leaves zero uncommitted rows/tabs.
        const row1 = {
          seq: 99001,
          docId: "batch-fail-row-1",
          rev: 1,
          kind: "text",
          space: "personal",
          content: "Row 1 staged text",
          meta: { title: "Row 1" },
          clientTime: Date.now(),
        };
        const row2Missing = {
          seq: 99002,
          docId: "batch-fail-row-2",
          rev: 1,
          kind: "text",
          space: "personal",
          content: null,
          meta: { title: "Row 2" },
          clientTime: Date.now(),
        };
        let failedAsExpected = false;
        try {
          await store.applyRemoteBatch([row1, row2Missing], {
            fetchDoc: async () => {
              throw new Error("simulated network drop");
            },
          });
        } catch {
          failedAsExpected = true;
        }
        const leakedInMem = Boolean(store.get("batch-fail-row-1"));
        const leakedInTabs = ws.current().tabs.includes("batch-fail-row-1");
        const idbAfterFail = await getWorkspace("main");
        const leakedInIdb = Boolean(idbAfterFail?.tabs?.includes("batch-fail-row-1"));

        // Retry with working fetchDoc: both rows commit cleanly.
        await store.applyRemoteBatch([row1, row2Missing], {
          fetchDoc: async (id) => ({ ...row2Missing, docId: id, content: "Row 2 fetched text" }),
        });
        const retryCommittedBoth =
          Boolean(store.get("batch-fail-row-1")) &&
          Boolean(store.get("batch-fail-row-2")) &&
          ws.current().tabs.includes("batch-fail-row-1") &&
          ws.current().tabs.includes("batch-fail-row-2");

        // Part 2: concurrent tab/folder mutations during applySyncBatch survive commitPreparedWorkspace.
        const tClose = await window.vrtti.createBuffer();
        const tStay = await window.vrtti.createBuffer();
        const prep = await ws.prepareAddTabs(["sync-prep-1", "sync-prep-2"]);

        // User creates/adds a tab, closes tClose, reorders before tStay, and adds a folder
        // while applySyncBatch writes the older prepared snapshot to IndexedDB.
        await ws.addTab("user-added-during-tx");
        await ws.removeTab(tClose.id);
        await ws.moveTab("user-added-during-tx", tStay.id);
        await ws.addFolder("folder-added-during-tx");
        await applySyncBatch({ putWorkspaces: [prep.record] });

        await ws.commitPreparedWorkspace(prep);
        const liveTabs = [...ws.current().tabs];
        const liveFolderIds = [...ws.current().folderIds];
        const savedWs = await getWorkspace("main");

        // Clean up synthetic IDs before next test.
        await ws.removeTabs([
          "batch-fail-row-1",
          "batch-fail-row-2",
          "user-added-during-tx",
          "sync-prep-1",
          "sync-prep-2",
          tStay.id,
        ]);
        await ws.removeFolder("folder-added-during-tx");
        store.buffers.delete("batch-fail-row-1");
        store.buffers.delete("batch-fail-row-2");

        return {
          failedAsExpected,
          leakedInMem,
          leakedInTabs,
          leakedInIdb,
          retryCommittedBoth,
          liveHasUserTab: liveTabs.includes("user-added-during-tx"),
          liveClosedGone: !liveTabs.includes(tClose.id),
          liveOrderKept: liveTabs.indexOf("user-added-during-tx") < liveTabs.indexOf(tStay.id),
          liveHasSyncedTabs:
            liveTabs.includes("sync-prep-1") && liveTabs.includes("sync-prep-2"),
          liveHasFolder: liveFolderIds.includes("folder-added-during-tx"),
          idbTabsMatchLive: JSON.stringify(savedWs?.tabs) === JSON.stringify(liveTabs),
          idbFoldersMatchLive: JSON.stringify(savedWs?.folderIds) === JSON.stringify(liveFolderIds),
        };
      })()`);
      assert.equal(batchAndConcurrentCheck.failedAsExpected, true);
      assert.equal(batchAndConcurrentCheck.leakedInMem, false);
      assert.equal(batchAndConcurrentCheck.leakedInTabs, false);
      assert.equal(batchAndConcurrentCheck.leakedInIdb, false);
      assert.equal(batchAndConcurrentCheck.retryCommittedBoth, true);
      assert.equal(batchAndConcurrentCheck.liveHasUserTab, true);
      assert.equal(batchAndConcurrentCheck.liveClosedGone, true);
      assert.equal(batchAndConcurrentCheck.liveOrderKept, true);
      assert.equal(batchAndConcurrentCheck.liveHasSyncedTabs, true);
      assert.equal(batchAndConcurrentCheck.liveHasFolder, true);
      assert.equal(batchAndConcurrentCheck.idbTabsMatchLive, true);
      assert.equal(batchAndConcurrentCheck.idbFoldersMatchLive, true);
    });

    test("5. Phone Mode B: 44px bottom bar, full-screen subview, server stubs, Android Back, swipe-left close only, Trash menu", async () => {
      const cdpA = devA.page.cdp;
      const cdpP = phoneDev.page.cdp;
      await phoneDev.page.goto(staticSrv.url);
      await joinSecondDevice(cdpA, cdpP, {
        name: "Phone",
        serverUrl: syncSrv.url,
        spaces: { personal: "tab", infra: "list" },
      });

      // Ensure phone has a Recent note, a Trash note (from personal), and an infra server stub.
      const prep = await cdpP.eval(`(async () => {
        // Local note closed into Recent.
        await window.vrtti.sync.setNewNotes(null);
        const r = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(r.id, "Phone Recent\\nsecond line");
        await window.vrtti.saveNow(r.id);
        await window.vrtti.closeBuffer(r.id);

        // Personal note trashed into Trash.
        await window.vrtti.sync.setNewNotes("personal");
        const t = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(t.id, "Phone Trashed\\nbody");
        await window.vrtti.saveNow(t.id);
        await window.vrtti.sync.syncNow();
        await window.vrtti.run("doc.trash", t.id);
        await window.vrtti.sync.syncNow();

        // Open the full-screen phone note list via thumb menu.
        document.getElementById("new-fab").click();
        document.getElementById("thumb-list").click();
        return { recentId: r.id, trashedId: t.id };
      })()`);

      const phoneChrome = await cdpP.eval(`(() => {
        const hiddenIds = ["act-view", "act-del", "bar-settings", "drawer-open-win", "bottom-drawer"];
        const hiddenOk = hiddenIds.every((id) => getComputedStyle(document.getElementById(id)).display === "none");
        const infraBtn = document.querySelector('#bar-spaces [data-space="infra"]');
        const rect = infraBtn?.getBoundingClientRect();
        const barRect = document.getElementById("bottom-bar").getBoundingClientRect();
        const searchRect = document.getElementById("search-open").getBoundingClientRect();
        return {
          phone: document.documentElement.classList.contains("phone"),
          hiddenOk,
          infraWidth: rect?.width ?? 0,
          infraHeight: rect?.height ?? 0,
          barAboveSearch: barRect.bottom <= searchRect.top + 2,
          backCount: window.__backWatchers.length,
        };
      })()`);
      assert.equal(phoneChrome.phone, true);
      assert.equal(phoneChrome.hiddenOk, true);
      assert.ok(phoneChrome.infraWidth >= 44 && phoneChrome.infraHeight >= 44, "44px touch targets");
      assert.equal(phoneChrome.barAboveSearch, true, "bottom bar must sit above search/thumb strip");
      assert.equal(phoneChrome.backCount, 1);

      // Tap infra badge -> full-screen switch, server stub row with "server" tag, Back returns to Open first!
      const infraView = await cdpP.eval(`(() => {
        document.querySelector('#bar-spaces [data-space="infra"]').click();
        const subview = document.getElementById("sidebar").classList.contains("phone-subview");
        const title = document.getElementById("phone-view-title").textContent;
        const stubRow = document.querySelector("#phone-view-list .stub-row");
        const tag = stubRow?.querySelector(".buffer-tag")?.textContent ?? "";
        const backCount = window.__backWatchers.length;
        return { subview, title, hasStub: Boolean(stubRow), tag, backCount };
      })()`);
      assert.equal(infraView.subview, true);
      assert.match(infraView.title, /^infra \(\d+\)$/);
      assert.equal(infraView.hasStub, true);
      assert.equal(infraView.tag, "server");
      assert.equal(infraView.backCount, 2, "subview must push its own watchBack over list");

      // First Android Back returns to Open (list stays open!). Second Back closes list.
      const backStep1 = await cdpP.eval(`(() => {
        window.__triggerBack();
        return {
          subview: document.getElementById("sidebar").classList.contains("phone-subview"),
          listOpen: document.getElementById("app").classList.contains("sidebar-open"),
          backCount: window.__backWatchers.length,
        };
      })()`);
      assert.equal(backStep1.subview, false);
      assert.equal(backStep1.listOpen, true);
      assert.equal(backStep1.backCount, 1);

      // Trash view: tapping row opens menu with Restore to personal, Restore as local, Delete permanently.
      const trashMenuCheck = await cdpP.eval(`(() => {
        document.getElementById("bar-trash").click();
        const row = document.querySelector('#phone-view-list .trash-row[data-id="' + ${JSON.stringify(prep.trashedId)} + '"]');
        row.click();
        const labels = [...document.querySelectorAll(".menu .menu-label")].map((el) => el.textContent.trim());
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        document.getElementById("phone-view-back").click();
        return { labels, backToOpen: !document.getElementById("sidebar").classList.contains("phone-subview") };
      })()`);
      assert.ok(trashMenuCheck.labels.includes("Restore to personal"));
      assert.ok(trashMenuCheck.labels.includes("Restore as local"));
      assert.ok(trashMenuCheck.labels.includes("Delete permanently"));
      assert.equal(trashMenuCheck.backToOpen, true);

      // Swipe-left on an Open row closes it (NEVER trashes it!).
      const swipeCheck = await cdpP.eval(`(async () => {
        const openRow = document.querySelector("#open-list .buffer-row");
        const id = openRow.dataset.id;
        const rect = openRow.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        openRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: rect.right - 20, clientY: y }));
        openRow.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: rect.left + 10, clientY: y }));
        openRow.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: rect.left + 10, clientY: y }));
        await new Promise((r) => setTimeout(r, 550));
        const rec = window.vrtti.store.get(id);
        return {
          closedFromOpen: !window.vrtti.store.openBuffers().some((b) => b.id === id),
          notTrashed: !rec?.trashedAt,
        };
      })()`);
      assert.equal(swipeCheck.closedFromOpen, true);
      assert.equal(swipeCheck.notTrashed, true);
    });

    test("6. Dedicated Space Window (?ws=): zero double-take loss, stub fetch, Ctrl+Shift+F, +, single-window focus, live routing, dissolve, loseSpace", async () => {
      const cdpA = devA.page.cdp;
      const cdpB = devB.page.cdp;

      // Prepare infra on A: 1 open tab in Main + 2 unopened server stubs; New notes = personal.
      const prep = await cdpA.eval(`(async () => {
        await window.vrtti.sync.setNewNotes("infra");
        const t1 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(t1.id, "Infra Open In Main\\nsearchable-zebra-token one");
        await window.vrtti.saveNow(t1.id);

        const s1 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(s1.id, "Infra Stub Alpha\\nsearchable-zebra-token two");
        await window.vrtti.saveNow(s1.id);

        const s2 = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(s2.id, "Infra Stub Beta\\nsearchable-zebra-token three");
        await window.vrtti.saveNow(s2.id);

        await window.vrtti.sync.syncNow();
        // Close s1 and s2 so they demote to server stubs; leave t1 OPEN in Main!
        await window.vrtti.closeBuffer(s1.id);
        await window.vrtti.closeBuffer(s2.id);
        await window.vrtti.sync.setNewNotes("personal");

        // Open infra drawer in Main and check header has Open-in-new-window button and NO "titles only" label.
        document.querySelector('#bar-spaces [data-space="infra"]').click();
        const openWinBtnHidden = document.getElementById("drawer-open-win").hidden;
        const subHidden = document.getElementById("drawer-sub").hidden;
        const headerText = document.getElementById("drawer-head").textContent;
        document.getElementById("drawer-close").click();

        // First verify blocked popup rollback (Review #10): when window.open returns null,
        // workspace is dissolved immediately and Main keeps t1 untouched!
        const origOpen = window.open;
        window.open = () => null;
        const blockedRes = await window.vrtti.run("workspace.openSpace", "infra");
        const blockedNotice = document.getElementById("status-state").textContent;
        const ownerAfterBlocked = window.vrtti.workspaces.spaceOwner("infra");
        const mainKeptT1OnBlock = window.vrtti.store.openBuffers().some((b) => b.id === t1.id);

        // Now allow window.open so our test attaches CDP directly to the new tab URL.
        let openedUrl = null;
        window.open = (url) => { openedUrl = url; return {}; };
        const ws = await window.vrtti.run("workspace.openSpace", "infra");
        window.open = origOpen;

        return {
          t1: t1.id,
          s1: s1.id,
          s2: s2.id,
          wsId: ws.id,
          openedUrl,
          openWinBtnHidden,
          subHidden,
          headerText,
          blockedRes,
          blockedNotice,
          ownerAfterBlocked,
          mainKeptT1OnBlock,
        };
      })()`);

      assert.equal(prep.openWinBtnHidden, false);
      assert.equal(prep.subHidden, true);
      assert.equal(/titles only/i.test(prep.headerText), false);
      assert.equal(prep.blockedRes, null, "blocked popup must return null");
      assert.match(prep.blockedNotice, /could not open window/i);
      assert.equal(prep.ownerAfterBlocked, null, "blocked popup must roll back workspace record");
      assert.equal(prep.mainKeptT1OnBlock, true, "blocked popup must leave Main's open tabs untouched");
      assert.match(prep.openedUrl, /\?ws=/);

      // Open the real Space Window tab in Device A's browser profile!
      const spaceTab = await devA.openTab(prep.openedUrl);
      const cdpS = spaceTab.cdp;

      // Wait for non-blocking post-start fetchSpaceStubs to populate S1 & S2, and
      // verify Main handed off T1 without double-take loss.
      await cdpS.waitFor(`(() => {
        const ids = window.vrtti.store.openBuffers().map((b) => b.id);
        return ${JSON.stringify([prep.t1, prep.s1, prep.s2])}.every((id) => ids.includes(id));
      })()`);

      const mainReleasedT1 = await cdpA.eval(
        `!window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.t1)})`
      );
      assert.equal(mainReleasedT1, true, "Main must release infra tabs when Space Window claims them");

      // Space Window must hold T1, S1, S2, show banner, hide #act-view, format title.
      const wsBoot = await cdpS.eval(`({
        space: window.vrtti.workspaces.current().space,
        initSpaceCleared: !window.vrtti.workspaces.current().initSpace,
        openIds: window.vrtti.store.openBuffers().map((b) => b.id),
        bannerHidden: document.getElementById("space-banner").hidden,
        bannerName: document.getElementById("space-banner-name").textContent,
        actViewHidden: document.getElementById("act-view").hidden,
        title: document.title,
      })`);
      assert.equal(wsBoot.space, "infra");
      assert.equal(wsBoot.initSpaceCleared, true, "initSpace must clear after initial boot");
      assert.ok(wsBoot.openIds.includes(prep.t1), "T1 moved from Main without double-take loss");
      assert.ok(wsBoot.openIds.includes(prep.s1), "S1 fetched on boot");
      assert.ok(wsBoot.openIds.includes(prep.s2), "S2 fetched on boot");
      assert.equal(wsBoot.bannerHidden, false);
      assert.equal(wsBoot.bannerName, "infra");
      assert.equal(wsBoot.actViewHidden, true);
      assert.match(wsBoot.title, /\(infra\) - vrtti$/);

      // Reloading a Space Window after closing a tab must NOT re-open closed stubs (Review #9)!
      await cdpS.eval(`window.vrtti.closeBuffer(${JSON.stringify(prep.s2)})`);
      await spaceTab.reload();
      await new Promise((r) => setTimeout(r, 250));
      const afterSpaceReload = await cdpS.eval(`({
        s2Reopened: window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.s2)}),
        t1Kept: window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.t1)}),
        s1Kept: window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.s1)}),
      })`);
      assert.equal(afterSpaceReload.s2Reopened, false, "Space Window reload must NOT re-fetch closed stubs");
      assert.equal(afterSpaceReload.t1Kept, true);
      assert.equal(afterSpaceReload.s1Kept, true);
      // Re-open S2 so all 3 zebra-token notes are open for the search check below.
      await cdpS.eval(`window.vrtti.run("remote.open", ${JSON.stringify(prep.s2)})`);

      // Search in files (Ctrl+Shift+F) finds hits across all 3 infra notes in the Space Window!
      const searchHits = await cdpS.eval(`(async () => {
        await window.vrtti.run("search.inFiles");
        const input = document.getElementById("search-query");
        input.value = "searchable-zebra-token";
        document.getElementById("search-form").dispatchEvent(new Event("submit", { cancelable: true }));
        await new Promise((r) => setTimeout(r, 250));
        const files = [...document.querySelectorAll("#search-results .search-file")].map((el) => el.textContent);
        document.getElementById("search-close").click();
        return files;
      })()`);
      assert.equal(searchHits.length, 3, "search in Space Window must hit all 3 infra notes");

      // "+" / buffer.new inside Space Window creates note in `infra` even though New notes is `personal`!
      const createdInSpace = await cdpS.eval(`(async () => {
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Created inside infra window\\nbody");
        await window.vrtti.saveNow(b.id);
        return { id: b.id, space: b.sync?.space ?? null };
      })()`);
      assert.equal(createdInSpace.space, "infra");
      await cdpA.eval(`window.vrtti.sync.syncNow()`);

      // Calling workspace.openSpace("infra") again from Main focuses existing Space Window (no duplicate).
      const duplicateCheck = await cdpA.eval(`(async () => {
        const countBefore = window.vrtti.workspaces.all().length;
        const result = await window.vrtti.run("workspace.openSpace", "infra");
        const countAfter = window.vrtti.workspaces.all().length;
        return { countBefore, countAfter, returnedExistingId: result === ${JSON.stringify(prep.wsId)} };
      })()`);
      assert.equal(duplicateCheck.countAfter, duplicateCheck.countBefore);
      assert.equal(duplicateCheck.returnedExistingId, true);

      // Incoming remote note for `infra` from Device B routes straight into the live Space Window!
      const remoteInfraId = await cdpB.eval(`(async () => {
        await window.vrtti.sync.setNewNotes("infra");
        const b = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(b.id, "Remote infra note for live window\\nhello");
        await window.vrtti.saveNow(b.id);
        await window.vrtti.sync.syncNow();
        await window.vrtti.sync.setNewNotes("personal");
        return b.id;
      })()`);
      await cdpA.eval(`window.vrtti.sync.syncNow()`);
      await cdpS.waitFor(`window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(remoteInfraId)})`);
      const routedCheck = await cdpA.eval(`({
        inMainOpen: window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(remoteInfraId)}),
        isStub: window.vrtti.remotes().some((s) => s.id === ${JSON.stringify(remoteInfraId)}),
      })`);
      assert.equal(routedCheck.inMainOpen, false, "must route to live Space Window, not Main");
      assert.equal(routedCheck.isStub, false, "must open in live Space Window, not become a stub");

      // Dissolve & close Space Window -> notes demote back to stubs in Main's infra drawer; Main's Open stays clean!
      await syncAndWait(cdpA);
      await spaceTab.closeTab();
      await cdpA.eval(`window.vrtti.workspaces.dissolve(${JSON.stringify(prep.wsId)})`);
      await cdpA.waitFor(`(() => {
        const ids = window.vrtti.remotes().filter((s) => s.space === "infra").map((s) => s.id);
        return ${JSON.stringify([prep.t1, prep.s1, prep.s2])}.every((id) => ids.includes(id))
          && ids.includes(${JSON.stringify(createdInSpace.id)})
          && ids.includes(${JSON.stringify(remoteInfraId)});
      })()`);

      const afterDissolve = await cdpA.eval(`({
        mainInfraOpen: window.vrtti.store.openBuffers().filter((b) => b.sync?.space === "infra").length,
        stubs: window.vrtti.remotes().filter((s) => s.space === "infra").map((s) => s.id),
      })`);
      assert.equal(afterDissolve.mainInfraOpen, 0, "Main Open list must stay completely clean");
      assert.ok(afterDissolve.stubs.includes(prep.t1));
      assert.ok(afterDissolve.stubs.includes(prep.s1));
      assert.ok(afterDissolve.stubs.includes(prep.s2));
      assert.ok(afterDissolve.stubs.includes(createdInSpace.id));
      assert.ok(afterDissolve.stubs.includes(remoteInfraId));

      // Reopen Space Window while Main is slower than 300 ms answering claim-space-tabs
      // (a slow 450 ms pending disk flush in Main), verifying T1 STILL lands open in the
      // Space Window instead of falling into the closed space drawer; then verify loseSpace!
      await cdpA.eval(`window.vrtti.run("remote.open", ${JSON.stringify(prep.t1)})`);
      const ws2 = await cdpA.eval(`(async () => {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle("slow-main-flush.md", { create: true });
        const slowRec = await window.vrtti.store.createFromFile(fh);
        const origCreateWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
          await new Promise((r) => setTimeout(r, 450));
          return origCreateWritable.apply(this, args);
        };
        window.__restoreCreateWritable = async () => {
          FileSystemFileHandle.prototype.createWritable = origCreateWritable;
          await window.vrtti.run("doc.trash", slowRec.id);
        };
        // Queue an unsaved edit in saveTimers so Main's flushAll() awaits the 450 ms write!
        window.vrtti.store.updateContent(slowRec.id, "slow flush body");

        const origOpen = window.open;
        let url = null;
        window.open = (u) => { url = u; return {}; };
        const w = await window.vrtti.run("workspace.openSpace", "infra");
        window.open = origOpen;
        return { id: w.id, url };
      })()`);
      const spaceTab2 = await devA.openTab(ws2.url);
      await spaceTab2.cdp.waitFor(
        `window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.t1)})`
      );
      await cdpA.eval(`window.__restoreCreateWritable()`);
      const mainDroppedLateT1 = await cdpA.eval(
        `!window.vrtti.store.openBuffers().some((b) => b.id === ${JSON.stringify(prep.t1)})`
      );
      assert.equal(mainDroppedLateT1, true, "slow (>300ms) Main claim must still transfer T1 cleanly");
      await spaceTab2.cdp.eval(`window.vrtti.store.loseSpace("infra")`);
      await new Promise((r) => setTimeout(r, 150));
      const afterLose = await cdpA.eval(`({
        owner: window.vrtti.workspaces.spaceOwner("infra"),
        t1Trashed: Boolean(window.vrtti.store.get(${JSON.stringify(prep.t1)})?.trashedAt),
        infraStubsLeft: window.vrtti.remotes().filter((s) => s.space === "infra").length,
      })`);
      assert.equal(afterLose.owner, null, "loseSpace in Space Window must dissolve workspace without reviving it");
      assert.equal(afterLose.t1Trashed, true, "loseSpace must finish trashing notes before closing Space Window");
      assert.equal(afterLose.infraStubsLeft, 0);
      try {
        await spaceTab2.closeTab();
      } catch {}
    });
  }
);
