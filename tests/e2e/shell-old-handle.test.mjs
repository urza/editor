// Browser regression test: the desktop shell starts with old browser handles
// in IndexedDB.
//
//   node --test tests/e2e/shell-old-handle.test.mjs
//
// The incident (shell 26.11.3, WebView2 158, 2026-11-25): IndexedDB held one
// browser FileSystemFileHandle from before the native backend. At start,
// store.load() awaited queryPermission() on it, and in WebView2 that promise
// (and getFile() too) never settled. The app stayed blank, with every note
// intact in IndexedDB.
//
// The test opens a file and a folder in browser mode (OPFS handles through
// stubbed pickers), then reloads as the shell, where every method of a real
// browser handle returns a promise that never settles. The shell must never
// call one (storage/native.js, OldBrowserHandle).
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

// Long enough for a slow CI start, short enough that a hang fails the test
// instead of the runner.
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

// What the shell injects before any page script (src-tauri/src/lib.rs,
// desktop_marker_js), plus the WebView2 behaviour of the incident. Only the
// FSA prototypes change: native handles (storage/native.js) are plain
// classes and never reach these.
const SHELL_BOOT = `
  window.vrttiDesktop = { platform: "windows", version: "26.11.3", hostname: "test-pc" };
  window.__shellIpc = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        window.__shellIpc.push(cmd);
        // pruneRoots() reads a count; every other boot command returns nothing.
        return cmd === "disk_prune" ? 0 : null;
      },
    },
    window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
  };
  const calls = {};
  window.__oldHandleCalls = calls;
  const never = () => new Promise(() => {});
  /** Replace the method where it lives (or on the base prototype when this build lacks it). */
  function hang(proto, name, result = never) {
    let owner = proto;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    calls[name] = 0;
    (owner || proto)[name] = function () {
      calls[name]++;
      return result();
    };
  }
  for (const name of ["queryPermission", "requestPermission", "isSameEntry", "move"]) {
    hang(FileSystemHandle.prototype, name);
  }
  for (const name of ["getFile", "createWritable"]) hang(FileSystemFileHandle.prototype, name);
  for (const name of ["getFileHandle", "getDirectoryHandle"]) hang(FileSystemDirectoryHandle.prototype, name);
  // A listing is an async iterator; its first step never settles.
  const stuck = () => ({ next: never, [Symbol.asyncIterator]() { return this; } });
  for (const name of ["values", "entries", "keys"]) hang(FileSystemDirectoryHandle.prototype, name, stuck);
  // Last line on purpose: a Chromium without these classes throws above, and
  // the test must then fail instead of passing with no hooks in place.
  window.__hooksReady = true;
`;

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-shell-old-handle-"));
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
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });

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

const chromePath = findChromium();

describe("desktop shell with old browser handles", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  /** Every call that reached a real browser handle in this document. */
  async function oldHandleCalls() {
    const calls = (await browser.cdp.eval("window.__oldHandleCalls").catch(() => null)) ?? {};
    const total = Object.values(calls).reduce((sum, n) => sum + n, 0);
    return { total, calls };
  }

  /**
   * Waits for start() in the shell. window.vrtti is the last thing start()
   * sets; vrttiDesktop and the URL in the same check keep the page that is
   * still unloading from passing it.
   * @param {string} url
   */
  async function assertShellStarts(url) {
    const started = await browser.cdp.poll(
      `Boolean(window.vrttiDesktop) && location.href === ${JSON.stringify(url)} && typeof window.vrtti === "object"`,
      START_TIMEOUT_MS
    );
    const { calls } = await oldHandleCalls();
    assert.ok(
      started,
      `start() did not complete within ${START_TIMEOUT_MS / 1000} s in the shell ` +
        `(window.vrtti is undefined); calls on the old handles: ${JSON.stringify(calls)}`
    );
    assert.equal(await browser.cdp.eval("window.__hooksReady"), true, "the WebView2 hooks did not install");
  }

  test("the shell starts, lists every note, and marks the old file and folder for a reconnect", async (t) => {
    const { cdp } = browser;

    // 1) Browser mode: three notes with text, one file and one folder opened
    // through the public "Open file" and "Open folder" commands. The stubbed
    // pickers hand back OPFS handles, so the records are the ones a real
    // install from before the native backend holds: a file and a directory
    // record in `handles`, a file-backed note in the tabs, a folder in main.
    await cdp.send("Page.navigate", { url: srv.url });
    assert.ok(
      await cdp.poll("Boolean(window.vrtti && window.vrtti.activeId)", START_TIMEOUT_MS),
      "browser mode did not start"
    );
    const seeded = await cdp.eval(`(async () => {
      const v = window.vrtti;
      const notes = [];
      for (const [i, text] of ["First note", "Second note", "Third note"].entries()) {
        if (i > 0) await v.createBuffer();
        v.store.updateContent(v.activeId, text + "\\nwith some text");
        await v.saveNow(v.activeId);
        notes.push(v.activeId);
      }
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle("old.txt", { create: true });
      const w = await file.createWritable();
      await w.write("old.txt from before the native backend\\n");
      await w.close();
      const dir = await root.getDirectoryHandle("old-folder", { create: true });
      await dir.getFileHandle("inside.md", { create: true });
      window.showOpenFilePicker = async () => [file];
      window.showDirectoryPicker = async () => dir;
      const folder = await v.run("folder.open");
      const record = await v.run("file.open");
      // activate() saves the active tab without an await; this one is awaited
      // so the shell starts with the old file's note on screen.
      await v.workspaces.setActive(record.id);
      const idb = await import("./js/storage/idb.js");
      return {
        notes,
        fileId: record.id,
        handleId: record.file?.handleId,
        folderId: folder?.id,
        storedHandles: (await idb.getAllHandles()).map((h) => h.kind).sort(),
        rows: [...document.querySelectorAll("#open-list > li")].map((li) => li.dataset.id),
      };
    })()`);
    assert.ok(seeded.handleId, "file.open did not make a file-backed note");
    assert.ok(seeded.folderId, "folder.open did not record a folder");
    assert.deepEqual(seeded.storedHandles, ["directory", "file"], "the handles store must hold the old file and folder");
    assert.equal(seeded.rows.length, 4, "browser mode must list three notes and the file");

    // 2) Reload as the shell, with the WebView2 behaviour of the incident.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SHELL_BOOT });
    await cdp.send("Page.reload", { ignoreCache: true });
    await assertShellStarts(srv.url);

    // 3) Main is whole: editor, every row, Settings, and the old file's row
    // marked. The old file's tab is on screen and shows why it is empty.
    const fileRow = `#open-list > li[data-id="${seeded.fileId}"]`;
    const state = await cdp.poll(
      `(() => ({
        editor: Boolean(document.querySelector("#editor-host .cm-editor")),
        rows: [...document.querySelectorAll("#open-list > li")].map((li) => li.dataset.id),
        settingsChildren: document.getElementById("settings-panel").childElementCount,
        needsReconnect: window.vrtti.store.needsReconnect(window.vrtti.store.get(${JSON.stringify(seeded.fileId)})),
        marker: Boolean(document.querySelector(${JSON.stringify(fileRow + " .buffer-warn")})),
        activeId: window.vrtti.activeId,
        editorText: document.querySelector("#editor-host .cm-content")?.innerText ?? "",
      }))()`,
      START_TIMEOUT_MS,
      (s) => s?.editor && s.rows.length === seeded.rows.length && s.settingsChildren > 0 && s.marker && /not available/.test(s.editorText)
    );
    t.diagnostic("old file's tab shows: " + JSON.stringify(state.editorText));
    assert.equal(state.editor, true, "the editor must exist (#editor-host .cm-editor)");
    assert.deepEqual([...state.rows].sort(), [...seeded.rows].sort(), "the note list must show every seeded note and the file");
    assert.ok(state.settingsChildren > 0, "Settings must be built (#settings-panel has children)");
    assert.equal(state.needsReconnect, true, "the old file's note must need a reconnect");
    assert.equal(state.marker, true, "the old file's row must carry the reconnect marker (.buffer-warn)");
    assert.equal(state.activeId, seeded.fileId, "the shell must start on the old file's tab");
    assert.match(state.editorText, /File not available: old\.txt/, "the old file's tab must say the file is not available");

    // 4) The app stays usable: a switch to an ordinary note shows its text.
    const second = seeded.notes[1];
    await cdp.eval(`window.vrtti.activateBuffer(${JSON.stringify(second)})`);
    const shown = await cdp.poll(
      `window.vrtti.activeId === ${JSON.stringify(second)} && document.querySelector("#editor-host .cm-content")?.innerText`,
      START_TIMEOUT_MS,
      (text) => typeof text === "string" && text.includes("Second note")
    );
    assert.match(String(shown), /Second note\s+with some text/, "a switch to an ordinary note must show its text");

    // The folder: main never lists one in the shell (architecture.md §14.5),
    // so the boot moves it to a workspace of its own and asks for its window.
    const wsId = await cdp.poll(
      `window.vrtti.workspaces.all().find((w) => w.folderIds.includes(${JSON.stringify(seeded.folderId)}))?.id`,
      START_TIMEOUT_MS
    );
    assert.ok(wsId, "the shell must move the old folder to a workspace of its own");
    const mainCalls = await oldHandleCalls();
    assert.equal(mainCalls.total, 0, "main: no call may reach a real browser handle: " + JSON.stringify(mainCalls.calls));

    // 5) That folder's window starts too, and marks the folder for a reconnect.
    const wsUrl = srv.url + "?ws=" + encodeURIComponent(wsId);
    await cdp.send("Page.navigate", { url: wsUrl });
    await assertShellStarts(wsUrl);
    const folderMarker = `#folder-sections [data-folder-id="${seeded.folderId}"] .buffer-warn`;
    assert.ok(
      await cdp.poll(`Boolean(document.querySelector(${JSON.stringify(folderMarker)}))`, START_TIMEOUT_MS),
      "the old folder must carry the reconnect marker in its window"
    );
    const folderCalls = await oldHandleCalls();
    assert.equal(folderCalls.total, 0, "folder window: no call may reach a real browser handle: " + JSON.stringify(folderCalls.calls));
  });
});
