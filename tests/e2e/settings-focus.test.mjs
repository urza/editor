// Browser test for Settings focus handling on desktop and phone.
//
//   node --test tests/e2e/settings-focus.test.mjs
//
// Verifies with real pointer clicks and real Space/Enter key events (via CDP
// Input.dispatchMouseEvent / Input.dispatchKeyEvent) that closing Settings
// never leaves #bar-settings focused as a Space/Enter trap, clicking the
// already-active note returns focus to the editor, Search focus is preserved
// when closing Settings by Escape, and phone mode still keeps the keyboard and
// note list undisturbed.

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

  /** @param {string} expression @param {number} [timeoutMs] */
  async waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.eval(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Timed out waiting for: " + expression);
  }

  /**
   * Dispatch a real mouse click at the center of `selector` so the browser runs
   * its real mousedown focus rules (unlike synthetic element.click()).
   * @param {string} selector
   */
  async click(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    assert.ok(box && box.w > 0 && box.h > 0, `element not visible for click: ${selector}`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * Dispatch a real key press (keydown + keyup), reproducing native button
   * activation on Space/Enter and capture Escape listeners.
   * @param {"Space" | "Enter" | "Escape"} name
   */
  async pressKey(name) {
    const map = {
      Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    };
    const spec = map[name];
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      ...(spec.text ? { text: spec.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    });
  }

  close() {
    this.ws.close();
  }
}

/** @param {string} chromePath */
async function launchBrowser(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-settings-focus-"));
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

  async function setDesktop(width = 1100, height = 760) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  async function setPhone() {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }

  async function goto(url) {
    await cdp.send("Page.navigate", { url });
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

  return { cdp, setDesktop, setPhone, goto, close };
}

const chromePath = findChromium();

describe("settings focus handling", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.setDesktop();
    await browser.goto(srv.url);
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  async function readFocusState() {
    return browser.cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      activeId: document.activeElement?.id || null,
      activeTag: document.activeElement?.tagName || null,
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
    })`);
  }

  async function assertSpaceAndEnterStayOutOfSettings(label) {
    await browser.cdp.pressKey("Space");
    assert.equal(
      await browser.cdp.eval('document.getElementById("settings-panel").hidden'),
      true,
      `${label}: Space must not re-open Settings`
    );
    await browser.cdp.pressKey("Enter");
    assert.equal(
      await browser.cdp.eval('document.getElementById("settings-panel").hidden'),
      true,
      `${label}: Enter must not re-open Settings`
    );
  }

  test("desktop: closing Settings via ×, Escape, #bar-settings toggle, and clicking the active note all return focus to editor", async () => {
    const { cdp } = browser;

    // 1) Open via real mouse click on #bar-settings, close via ×.
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.click("#settings-close");
    const afterX = await readFocusState();
    assert.equal(afterX.settingsHidden, true);
    assert.notEqual(afterX.activeId, "bar-settings");
    assert.equal(afterX.inEditor, true, "closing Settings via × must focus the editor");
    await assertSpaceAndEnterStayOutOfSettings("after ×");

    // 2) Open via real mouse click on #bar-settings, close via Escape.
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.pressKey("Escape");
    const afterEsc = await readFocusState();
    assert.equal(afterEsc.settingsHidden, true);
    assert.notEqual(afterEsc.activeId, "bar-settings");
    assert.equal(afterEsc.inEditor, true, "closing Settings via Escape must focus the editor");
    await assertSpaceAndEnterStayOutOfSettings("after Escape");

    // 3) Open via real mouse click on #bar-settings, close by clicking #bar-settings again.
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.click("#bar-settings");
    const afterToggle = await readFocusState();
    assert.equal(afterToggle.settingsHidden, true);
    assert.notEqual(afterToggle.activeId, "bar-settings");
    assert.equal(afterToggle.inEditor, true, "toggling Settings closed via #bar-settings must focus the editor");
    await assertSpaceAndEnterStayOutOfSettings("after #bar-settings toggle");

    // 4) Open via real mouse click on #bar-settings, close by clicking the already-active note row.
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.click("#open-list .buffer-row.active");
    const afterActiveRow = await readFocusState();
    assert.equal(afterActiveRow.settingsHidden, true);
    assert.notEqual(afterActiveRow.activeId, "bar-settings");
    assert.equal(afterActiveRow.inEditor, true, "clicking the active note while Settings is open must focus the editor");
    await assertSpaceAndEnterStayOutOfSettings("after clicking active note");

    // 5) Clicking the already-active note row when Settings is closed also returns focus to editor.
    await cdp.click("#open-list .buffer-row.active");
    const afterDirectActiveRow = await readFocusState();
    assert.equal(afterDirectActiveRow.inEditor, true, "clicking the active note row must focus the editor");
  });

  test("desktop: clicking a search file heading for the active note closes Settings and focuses editor", async () => {
    const { cdp } = browser;
    await cdp.eval(`(async () => {
      await window.vrtti.store.updateContent(window.vrtti.activeId, "focus-probe-needle\\nsecond line");
    })()`);

    // Open Settings, then open Search and click the file heading for the already-active note.
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.click("#search-open");
    assert.equal(await cdp.eval('document.activeElement?.id'), "search-query");
    await cdp.eval(`(() => {
      const q = document.getElementById("search-query");
      q.value = "focus-probe-needle";
      q.form.requestSubmit();
    })()`);
    await cdp.waitFor('Boolean(document.querySelector("#search-results .search-file"))');
    await cdp.click("#search-results .search-file");
    await cdp.waitFor('document.getElementById("settings-panel").hidden');
    const afterHeading = await readFocusState();
    assert.notEqual(afterHeading.activeId, "bar-settings");
    assert.equal(afterHeading.inEditor, true, "clicking active note search heading must focus editor");
    await assertSpaceAndEnterStayOutOfSettings("after search heading");
    // Close Search so the sidebar returns to its normal layout.
    await cdp.click("#search-close");
  });

  test("narrow desktop: closing Settings via × and via drawer #bar-settings toggle returns focus to editor", async () => {
    const { cdp } = browser;
    await browser.setDesktop(550, 760);
    await browser.goto(srv.url);
    const waitDrawerSettled = () =>
      cdp.waitFor(`(() => {
        const s = document.getElementById("sidebar");
        const b = document.getElementById("bar-settings");
        const r = b.getBoundingClientRect();
        return getComputedStyle(s).transform === "none" && r.left >= 0 && r.width > 0;
      })()`);

    await cdp.click("#sidebar-open");
    await waitDrawerSettled();
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.click("#settings-close");
    const afterClose = await readFocusState();
    assert.equal(afterClose.settingsHidden, true);
    assert.notEqual(afterClose.activeId, "bar-settings");
    assert.equal(afterClose.inEditor, true, "closing Settings on narrow desktop must focus editor");
    await assertSpaceAndEnterStayOutOfSettings("narrow desktop ×");

    // Re-open Settings, open the drawer via sidebar.show, and click #bar-settings again to toggle closed.
    await cdp.click("#sidebar-open");
    await waitDrawerSettled();
    await cdp.click("#bar-settings");
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.eval('window.vrtti.run("sidebar.show")');
    await waitDrawerSettled();
    await cdp.click("#bar-settings");
    const afterDrawerToggle = await readFocusState();
    assert.equal(afterDrawerToggle.settingsHidden, true);
    assert.notEqual(afterDrawerToggle.activeId, "bar-settings");
    assert.equal(afterDrawerToggle.inEditor, true, "toggling Settings closed from narrow drawer must focus editor");
    await assertSpaceAndEnterStayOutOfSettings("narrow desktop toggle");
  });

  test("phone mode: closing Settings never steals focus to editor or closes the note list", async () => {
    const { cdp } = browser;
    await browser.setPhone();
    await browser.goto(srv.url);

    // 1) From note -> Settings -> close via × stays on note without focusing editor (no keyboard popup).
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-settings").click();
    })()`);
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.eval('document.getElementById("settings-close").click()');
    const afterPhoneNote = await cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
    })`);
    assert.equal(afterPhoneNote.settingsHidden, true);
    assert.equal(afterPhoneNote.listOpen, false);
    assert.equal(afterPhoneNote.inEditor, false, "closing Settings on a phone note must not pop up the keyboard");

    // 2) From note list -> Settings -> close via × stays on note list without focusing editor.
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-list").click();
    })()`);
    assert.equal(await cdp.eval('document.getElementById("app").classList.contains("sidebar-open")'), true);
    await cdp.eval(`(() => {
      document.getElementById("new-fab").click();
      document.getElementById("thumb-settings").click();
    })()`);
    assert.equal((await readFocusState()).settingsHidden, false);
    await cdp.eval('document.getElementById("settings-close").click()');
    const afterPhoneList = await cdp.eval(`({
      settingsHidden: document.getElementById("settings-panel").hidden,
      listOpen: document.getElementById("app").classList.contains("sidebar-open"),
      inEditor: Boolean(document.activeElement?.closest(".cm-editor")),
    })`);
    assert.equal(afterPhoneList.settingsHidden, true);
    assert.equal(afterPhoneList.listOpen, true, "closing Settings in phone mode must keep the note list open");
    assert.equal(afterPhoneList.inEditor, false, "closing Settings in phone mode must not focus the hidden editor");
  });
});
