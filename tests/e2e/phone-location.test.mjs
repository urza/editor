// Browser test for phone-mode remembered location, Settings return, locked
// notes on cold start, and Android Back (CloseWatcher) behavior.
//
//   node --test tests/e2e/phone-location.test.mjs
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

/** Locate a local Chromium/Chrome binary, or null when none is installed. */
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

/** Static file server rooted at app/, bound to an ephemeral loopback port. */
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
        const ext = path.extname(file);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
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

/** Minimal Chrome DevTools Protocol client over Node 22 built-in WebSocket. */
class CdpClient {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<(params: any) => void>>} */
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP socket error: " + String(e))));
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
   * Poll until `expression` evaluates truthy.
   * @param {string} expression @param {number} [timeoutMs]
   */
  async waitFor(expression, timeoutMs = 8000) {
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
 * Launch a fresh headless Chromium profile and attach CDP to its first page.
 * @param {string} chromePath
 */
async function launchBrowser(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-phone-test-"));
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

  // Track CloseWatcher instances so the test can assert exact Android Back
  // stack depth and fire real Back callbacks without relying on Escape.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
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
        // Capture whether #app already carried sidebar-open before deferred
        // ES modules ran (proves the inline replay script prevents a flash).
        document.addEventListener("DOMContentLoaded", () => {
          const app = document.getElementById("app");
          window.__earlySidebarOpen = Boolean(app && app.classList.contains("sidebar-open"));
          window.__earlyVrttiReady = Boolean(window.vrtti);
        });
      })();
    `,
  });

  async function setPhoneProfile() {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  }

  async function setNarrowDesktopProfile() {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 500,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  async function goto(url) {
    await cdp.send("Page.navigate", { url });
    await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
  }

  async function coldReload() {
    await cdp.send("Page.reload", { ignoreCache: true });
    // Wait until the old window is replaced and the fresh boot completes.
    await new Promise((r) => setTimeout(r, 80));
    await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
  }

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

  return { cdp, setPhoneProfile, setNarrowDesktopProfile, goto, coldReload, close };
}

const chromePath = findChromium();

describe("phone mode remembered location", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.setPhoneProfile();
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  test("fresh install starts on editor, reload on note stays on note, reload on list opens list with no flash and focuses active row", async () => {
    const { cdp } = browser;
    await browser.goto(srv.url);

    // Confirm real phone mode is active and fresh install opens on the editor.
    const initial = await cdp.eval(`({
      phone: document.documentElement.classList.contains("phone"),
      open: document.getElementById("app").classList.contains("sidebar-open"),
      sidebarDisplay: getComputedStyle(document.getElementById("sidebar")).display,
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(initial.phone, true, "expected html.phone in mobile emulation");
    assert.equal(initial.open, false);
    assert.equal(initial.sidebarDisplay, "none");
    assert.equal(initial.stored, null);
    assert.equal(initial.backCount, 0);

    // Create two notes and leave the second one active.
    const ids = await cdp.eval(`(async () => {
      const a = window.vrtti.activeId;
      window.vrtti.store.updateContent(a, "Note Alpha\\nfirst body");
      await window.vrtti.saveNow(a);
      const b = await window.vrtti.createBuffer();
      window.vrtti.store.updateContent(b.id, "Note Beta\\nsecond body");
      await window.vrtti.saveNow(b.id);
      return { a, b: b.id };
    })()`);

    // Cold reload while on Note Beta -> reopens on Note Beta, Back exits.
    await browser.coldReload();
    const afterNoteReload = await cdp.eval(`({
      activeId: window.vrtti.activeId,
      open: document.getElementById("app").classList.contains("sidebar-open"),
      earlyOpen: window.__earlySidebarOpen,
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(afterNoteReload.activeId, ids.b);
    assert.equal(afterNoteReload.open, false);
    assert.equal(afterNoteReload.earlyOpen, false);
    assert.equal(afterNoteReload.backCount, 0);

    // Open the notes list through the thumb menu.
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-list").click();
    })()`);
    const onList = await cdp.eval(`({
      open: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(onList.open, true);
    assert.equal(onList.stored, "1");
    assert.equal(onList.backCount, 1);

    // Cold reload while on the notes list -> opens directly on the notes list,
    // inline script set sidebar-open before modules ran (zero flash), active
    // row gets focus (editor does not), and Back exits (0 watchers).
    await browser.coldReload();
    const afterListReload = await cdp.eval(`({
      activeId: window.vrtti.activeId,
      open: document.getElementById("app").classList.contains("sidebar-open"),
      earlyOpen: window.__earlySidebarOpen,
      earlyVrttiReady: window.__earlyVrttiReady,
      sidebarDisplay: getComputedStyle(document.getElementById("sidebar")).display,
      activeTag: document.activeElement?.tagName,
      activeRowId: document.activeElement?.dataset?.id ?? null,
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(afterListReload.activeId, ids.b);
    assert.equal(afterListReload.open, true);
    assert.equal(afterListReload.earlyOpen, true, "inline replay script must set sidebar-open before first paint");
    assert.equal(afterListReload.sidebarDisplay, "flex");
    assert.equal(afterListReload.activeTag, "LI");
    assert.equal(afterListReload.activeRowId, ids.b);
    assert.equal(afterListReload.inEditor, false);
    assert.equal(afterListReload.backCount, 0, "cold start onto list must not arm Back");
  });

  test("Android Back undoes one switch in either direction and exits on second Back; Settings returns to list", async () => {
    const { cdp } = browser;
    // Currently cold-started on the notes list (0 Back watchers).
    // 1) List -> Settings -> Back -> still on List, stored location stays "1".
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-settings").click();
    })()`);
    const inSettings = await cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      settingsZ: Number(getComputedStyle(document.getElementById("settings-panel")).zIndex),
      sidebarZ: Number(getComputedStyle(document.getElementById("sidebar")).zIndex),
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(inSettings.settingsHidden, false);
    assert.ok(inSettings.settingsZ > inSettings.sidebarZ, "settings panel must sit above the note list");
    assert.equal(inSettings.listOpen, true);
    assert.equal(inSettings.stored, "1");
    assert.equal(inSettings.backCount, 1);

    // Close Settings via Back -> returns to the notes list, 0 watchers left.
    await cdp.eval("window.__triggerBack()");
    const afterSettings = await cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(afterSettings.settingsHidden, true);
    assert.equal(afterSettings.listOpen, true);
    assert.equal(afterSettings.stored, "1");
    assert.equal(afterSettings.backCount, 0);

    // 2) List -> tap a note -> first Back returns to List -> second Back exits.
    await cdp.eval(`document.querySelector("#open-list .buffer-row:not(.active)").click()`);
    const inNote = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(inNote.listOpen, false);
    assert.equal(inNote.stored, "0");
    assert.equal(inNote.backCount, 1);

    const firstBack = await cdp.eval("window.__triggerBack()");
    assert.equal(firstBack, true);
    const backOnList = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      activeTag: document.activeElement?.tagName,
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(backOnList.listOpen, true);
    assert.equal(backOnList.stored, "1");
    assert.equal(backOnList.activeTag, "LI");
    assert.equal(backOnList.inEditor, false);
    assert.equal(backOnList.backCount, 0);
    assert.equal(await cdp.eval("window.__triggerBack()"), false, "second Back must exit the app");

    // 3) List -> Thumb "+" (New note) -> closes list, stores "0", focuses editor, Back returns to list.
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-new").click();
    })()`);
    await cdp.waitFor('!document.getElementById("app").classList.contains("sidebar-open")');
    const afterThumbNew = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(afterThumbNew.listOpen, false);
    assert.equal(afterThumbNew.stored, "0");
    assert.equal(afterThumbNew.inEditor, true, "new note from thumb menu must focus editor for typing");
    assert.equal(afterThumbNew.backCount, 1);
    await cdp.eval("window.__triggerBack()");
    assert.equal(await cdp.eval('document.getElementById("app").classList.contains("sidebar-open")'), true);

    // 4) Cold start on a note -> Settings -> Back returns to note; then open List -> Back returns to note -> second Back exits.
    await cdp.eval(`document.querySelector("#open-list .buffer-row.active").click()`);
    await browser.coldReload();
    assert.equal(await cdp.eval("window.__backWatchers.length"), 0, "cold start onto note must exit on Back");
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-settings").click();
    })()`);
    assert.equal(await cdp.eval('document.getElementById("settings-panel").hidden'), false);
    await cdp.eval("window.__triggerBack()");
    const afterNoteSettings = await cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(afterNoteSettings.settingsHidden, true);
    assert.equal(afterNoteSettings.listOpen, false);
    assert.equal(afterNoteSettings.backCount, 0);

    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-list").click();
    })()`);
    assert.equal(await cdp.eval("window.__backWatchers.length"), 1);
    await cdp.eval("window.__triggerBack()");
    const backOnNote = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
      backCount: window.__backWatchers.length,
    })`);
    assert.equal(backOnNote.listOpen, false);
    assert.equal(backOnNote.stored, "0");
    assert.equal(backOnNote.inEditor, false, "returning to note via Back must not pull up keyboard");
    assert.equal(backOnNote.backCount, 0);
  });

  test("PIN-locked active note stays quiet on cold start onto list, and tapping that already-active row opens PIN dialog", async () => {
    const { cdp } = browser;
    // Store a PIN hash and mark the active note PIN-locked, then move to list.
    const lockedId = await cdp.eval(`(async () => {
      const salt = new Uint8Array(16).fill(7);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("1234"), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 200000 }, key, 256);
      const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await window.vrtti.settings.put("pin.hash", { salt: [...salt], hash });
      const id = window.vrtti.activeId;
      await window.vrtti.store.setPin(id, true);
      document.getElementById("new-fab").click();
      document.getElementById("thumb-list").click();
      return id;
    })()`);

    await browser.coldReload();
    // Wait briefly to confirm no delayed PIN prompt appears.
    await new Promise((r) => setTimeout(r, 250));
    const booted = await cdp.eval(`({
      activeId: window.vrtti.activeId,
      isPinLocked: window.vrtti.store.isPinLocked(window.vrtti.activeId),
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      dialogOpen: Boolean(document.querySelector("dialog[open]")),
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
      activeRowId: document.activeElement?.dataset?.id ?? null,
    })`);
    assert.equal(booted.activeId, lockedId);
    assert.equal(booted.isPinLocked, true);
    assert.equal(booted.listOpen, true);
    assert.equal(booted.dialogOpen, false, "cold start onto list must not pop up PIN dialog");
    assert.equal(booted.inEditor, false);
    assert.equal(booted.activeRowId, lockedId);

    // Tapping the already-active locked row must close the list first and open the PIN pad.
    await cdp.eval(`document.querySelector('#open-list .buffer-row[data-id="' + ${JSON.stringify(lockedId)} + '"]').click()`);
    await cdp.waitFor('Boolean(document.querySelector("dialog[open] .pin-input"))');
    const afterTap = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      hasPinInput: Boolean(document.querySelector("dialog[open] .pin-input")),
    })`);
    assert.equal(afterTap.listOpen, false);
    assert.equal(afterTap.stored, "0");
    assert.equal(afterTap.hasPinInput, true);

    // Cancel PIN pad and remove the PIN lock so the next test starts clean.
    await cdp.eval(`(async () => {
      document.querySelector('dialog[open] button[type="button"]').click();
      await window.vrtti.store.setPin(${JSON.stringify(lockedId)}, false);
    })()`);
  });

  test("keyring-locked active note stays quiet on list, and tapping that already-active row closes list and asks passphrase", async () => {
    const { cdp } = browser;
    // Set up a passphrase-protected keyring, encrypt the active note, go to list.
    const encId = await cdp.eval(`(async () => {
      await window.vrtti.keyring.setup({
        deviceName: "Phone",
        askPassphrase: true,
        passphrase: "secret-passphrase",
        firstDevice: true,
      });
      const id = window.vrtti.activeId;
      await window.vrtti.encrypt(id, "this-device");
      document.getElementById("new-fab").click();
      document.getElementById("thumb-list").click();
      return id;
    })()`);

    await browser.coldReload();
    // Right after boot (before main.js's 300ms device-wide passphrase timer),
    // editor.js must NOT have opened a premature Unlock dialog behind the list.
    const immediateDialog = await cdp.eval('Boolean(document.querySelector("dialog[open]"))');
    assert.equal(immediateDialog, false, "editor.js must skip askUnlock while phone list is open");

    // Dismiss main.js's intentional 300ms device-wide startup unlock prompt if it opens.
    await new Promise((r) => setTimeout(r, 450));
    await cdp.eval(`(() => {
      const cancel = document.querySelector('dialog[open] button[type="button"]');
      if (cancel) cancel.click();
    })()`);
    await new Promise((r) => setTimeout(r, 100));

    const booted = await cdp.eval(`({
      activeId: window.vrtti.activeId,
      unlocked: window.vrtti.keyring.isUnlocked,
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      dialogOpen: Boolean(document.querySelector("dialog[open]")),
    })`);
    assert.equal(booted.activeId, encId);
    assert.equal(booted.unlocked, false);
    assert.equal(booted.listOpen, true);
    assert.equal(booted.dialogOpen, false);

    // Tapping the already-active locked encrypted row closes list and opens passphrase dialog.
    await cdp.eval(`document.querySelector('#open-list .buffer-row[data-id="' + ${JSON.stringify(encId)} + '"]').click()`);
    await cdp.waitFor('Boolean(document.querySelector("dialog[open]"))');
    const afterTap = await cdp.eval(`({
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      stored: localStorage.getItem("vrtti.phoneListOpen"),
      dialogTitle: document.querySelector("dialog[open] .dialog-title")?.textContent ?? "",
    })`);
    assert.equal(afterTap.listOpen, false);
    assert.equal(afterTap.stored, "0");
    assert.equal(afterTap.dialogTitle, "Unlock");
  });

  test("narrow desktop window (non-phone) ignores vrtti.phoneListOpen and starts with drawer closed", async () => {
    const { cdp } = browser;
    await cdp.eval(`localStorage.setItem("vrtti.phoneListOpen", "1")`);
    await browser.setNarrowDesktopProfile();
    await browser.coldReload();
    const state = await cdp.eval(`({
      phone: document.documentElement.classList.contains("phone"),
      open: document.getElementById("app").classList.contains("sidebar-open"),
      earlyOpen: window.__earlySidebarOpen,
    })`);
    assert.equal(state.phone, false);
    assert.equal(state.open, false);
    assert.equal(state.earlyOpen, false);
  });
});
