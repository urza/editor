// Browser test for three spellcheck fixes: a mark that waited for its budget,
// the lint hover tooltip next to the phone box, and the phone box over
// Settings.
//
//   node --test tests/e2e/spellcheck-marks.test.mjs
//
// Plain Node + local Chromium via Chrome DevTools Protocol (no npm packages).
// Skips cleanly when no Chromium binary is available on the host. The
// spellcheck engines (Harper wasm, Hunspell) load lazily in a web worker, so
// the first marks of each browser can take up to 30 s.
//
// What it verifies:
//  1. A word that one paragraph puts off (out of budget) gets its mark when a
//     later paragraph of the same pass computes the same word: the idle fill
//     still announces a new pass (spellcheck.worker.js, computeCzech and
//     scheduleIdleFill).
//  2. Phone mode: a real tap on a marked word opens the phone box and no lint
//     hover tooltip of the PC opens next to it, so the box stays right under
//     the word (app.css, html.phone .cm-tooltip-hover:has(.cm-tooltip-lint)).
//  3. Phone mode: the box closes when the editor loses the focus (Settings
//     opens from the round buttons), a fix button in the box still works,
//     and a tap on another marked word moves the box (spellcheck.js, phoneBox).
//
// Why the server patches one line of the worker for test 1: the bug needs a
// paragraph whose budget (SUGGEST_BUDGET_MS, 60 ms) runs out before it asks
// for a word. On a fast machine the English pass of a short paragraph stays
// within the budget, and the bug does not show. The server serves
// spellcheck.worker.js with an 80 ms wait at the start of each English
// paragraph, so that paragraph always puts its words off. Every other file is
// served unchanged. The patch must match exactly once: if a refactoring of the
// worker removes the line, the test fails loudly instead of passing without
// the slow paragraph.

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

// Test 1 only (see the header). The path is relative to app/, the same form
// as the request paths the server gets.
const WORKER_REL = "js/editor/spellcheck.worker.js";
const SLOW_ENGLISH_FROM = "if (useEnglishPass) {";
const SLOW_ENGLISH_TO = "if (useEnglishPass) { await new Promise((r) => setTimeout(r, 80));";

/** The worker source with the slow English pass, or an error that says why not. */
function slowEnglishWorker() {
  const src = fs.readFileSync(path.join(APP_DIR, WORKER_REL), "utf8");
  const count = src.split(SLOW_ENGLISH_FROM).length - 1;
  if (count !== 1) {
    throw new Error(
      `spellcheck-marks test 1: expected exactly one "${SLOW_ENGLISH_FROM}" in app/${WORKER_REL}, ` +
        `found ${count}. The test slows the English pass at that line; update the patch to the new code.`
    );
  }
  return src.replace(SLOW_ENGLISH_FROM, SLOW_ENGLISH_TO);
}

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

/**
 * Static file server rooted at app/, bound to an ephemeral loopback port.
 * `replace` maps a path relative to app/ to the text served in its place;
 * `hits` counts the requests for each replaced path.
 * @param {Record<string, string>} [replace]
 */
function startServer(replace = {}) {
  /** @type {Record<string, number>} */
  const hits = {};
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
      const ext = path.extname(file);
      if (Object.hasOwn(replace, rel)) {
        hits[rel] = (hits[rel] ?? 0) + 1;
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(replace[rel]);
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      resolve({ server, url: `http://127.0.0.1:${addr.port}/`, hits });
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

  /** @param {string} method @param {(params: any) => void} fn */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    /** @type {Set<(params: any) => void>} */ (this.listeners.get(method)).add(fn);
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
   * @param {string} expression @param {number} [timeoutMs] @param {string} [what]
   */
  async waitFor(expression, timeoutMs = 8000, what = expression) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.eval(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
  }

  /**
   * A real finger tap: touchstart and touchend at one point. With touch
   * emulation on, Chromium turns it into a gesture tap and sends the same
   * compatibility mouse events (mousemove, mousedown, mouseup, click) as a
   * phone, which is what opened the lint hover tooltip in bug 2.
   * @param {number} x @param {number} y
   */
  async tap(x, y) {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /**
   * Tap the center of the first element that matches `selector`, once it is
   * on screen and at rest. The round buttons slide out (0.12 s) and a new
   * CodeMirror tooltip sits at top -10000 until it is placed, so a rect read
   * too early sends the finger to the wrong place.
   * @param {string} selector
   */
  async tapSelector(selector) {
    const box = await this.waitFor(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const a = el.getBoundingClientRect();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = el.getBoundingClientRect();
      const still = a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
      const onScreen = b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight;
      return still && onScreen ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    })()`, 8000, `${selector} on screen and at rest`);
    await this.tap(box.x, box.y);
  }

  /** Type text at the cursor, as the keyboard's text input does. @param {string} text */
  async insertText(text) {
    await this.send("Input.insertText", { text });
  }

  async pressEnter() {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  close() {
    this.ws.close();
  }
}

/**
 * Launch a fresh headless Chromium profile and attach CDP to its first page.
 * Page exceptions and console errors are collected in `errors`.
 * @param {string} chromePath
 */
async function launchBrowser(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-spellmarks-"));
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

  /** @type {string[]} */
  const errors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails;
    errors.push("exception: " + (d.exception?.description || d.text));
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error" && p.type !== "assert") return;
    const args = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type);
    errors.push(`console.${p.type}: ` + args.join(" "));
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") errors.push(`log (${p.entry.source}): ${p.entry.text} ${p.entry.url ?? ""}`.trim());
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  async function setDesktopProfile() {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

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

  return { cdp, errors, setDesktopProfile, setPhoneProfile, goto, close };
}

// ---- Page helpers -------------------------------------------------------------

// The lines of the editor, one string per line, as the user sees them.
const DOC_LINES = `[...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent)`;

/** An expression: every mark in the editor, with its word, line and color. */
const MARKS = `(() => {
  const lines = [...document.querySelectorAll(".cm-content .cm-line")];
  return [...document.querySelectorAll(".cm-content .cm-lintRange")].map((s) => ({
    text: s.textContent,
    line: lines.indexOf(s.closest(".cm-line")),
    kind: s.classList.contains("cm-lintRange-info") ? "info"
      : s.classList.contains("cm-lintRange-warning") ? "warning" : "other",
  }));
})()`;

/**
 * An expression: true when `word` on line `line` has a mark of `kind`
 * ("info" is blue, "warning" is red).
 * @param {string} word @param {number} line @param {"info" | "warning"} kind
 */
function hasMark(word, line, kind) {
  return `${MARKS}.some((m) => m.text === ${JSON.stringify(word)} && m.line === ${line} && m.kind === ${JSON.stringify(kind)})`;
}

/**
 * An expression: the client rect of the mark on `word` in line `line`, or null.
 * @param {string} word @param {number} line
 */
function markRect(word, line) {
  return `(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")];
    const span = [...document.querySelectorAll(".cm-content .cm-lintRange")].find(
      (s) => s.textContent === ${JSON.stringify(word)} && lines.indexOf(s.closest(".cm-line")) === ${line}
    );
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

// An expression: the phone boxes in the document, with their client rects.
const BOXES = `[...document.querySelectorAll(".cm-spell-box")].map((b) => {
  const r = b.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
    buttons: [...b.querySelectorAll("button")].map((x) => x.textContent) };
})`;

// An expression: true when exactly one phone box is on screen. CodeMirror
// parks a tooltip at top -10000 until it measures and places it.
const BOX_ON_SCREEN = `(() => { const b = ${BOXES}; return b.length === 1 && b[0].height > 0 && b[0].top >= 0; })()`;

/**
 * A new note with `lines` typed into it: text through Input.insertText, line
 * breaks through the Enter key, all in one burst so one lint pass sees the
 * whole text.
 * @param {CdpClient} cdp @param {string[]} lines
 */
async function typeNote(cdp, lines) {
  const id = await cdp.eval(`(async () => (await window.vrtti.createBuffer()).id)()`);
  await cdp.waitFor(
    `window.vrtti.activeId === ${JSON.stringify(id)} && ${DOC_LINES}.join("\\n") === ""`,
    8000,
    "an empty new note"
  );
  await cdp.eval(`document.querySelector(".cm-content").focus()`);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await cdp.pressEnter();
    if (lines[i]) await cdp.insertText(lines[i]);
  }
  assert.deepEqual(await cdp.eval(DOC_LINES), lines, "the typed note");
}

/** @param {string[]} errors @param {string} label */
function printErrors(errors, label) {
  if (errors.length === 0) console.log(`[${label}] no page exceptions or console errors`);
  else console.log(`[${label}] page exceptions and console errors:\n  ` + errors.join("\n  "));
}

const chromePath = findChromium();

// ---- Bug 1 --------------------------------------------------------------------

describe("spellcheck: a word put off by one paragraph still gets its mark", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string, hits: Record<string, number>}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer({ [WORKER_REL]: slowEnglishWorker() });
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.setDesktopProfile();
    await browser.goto(srv.url);
  });

  after(async () => {
    if (browser) {
      printErrors(browser.errors, "bug 1");
      await browser.close();
    }
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  test("bug 1: 'dekuji' gets its blue mark in the English paragraph and in the Czech paragraph, without more input", async (t) => {
    const { cdp } = browser;
    // P1 is English and holds "dekuji" in the middle. P2 is Czech and starts
    // with "dekuji", so P2 computes the word while its own budget is fresh,
    // in the same pass in which the slow P1 put it off.
    const P1 = "Thanks, or as we say dekuji, for the quick answer to my question.";
    const P2 = "dekuji moc za rychlou odpověď, všechno funguje v pořádku.";
    await typeNote(cdp, [P1, "", P2]);

    // The scenario needs P1 in the English pass (where the server slows it)
    // and P2 in the word pass. textlang.js is pure, so a second copy of it
    // gives the same verdict as the worker's.
    const langs = await cdp.eval(`(async () => {
      const { segments } = await import("./js/editor/textlang.js");
      return segments(${JSON.stringify(P1 + "\n\n" + P2)}).filter((s) => !s.code).map((s) => s.lang);
    })()`);
    assert.deepEqual(langs, ["en", "cs"], "P1 must be English and P2 Czech");

    // The first marks wait for both engines to load.
    await cdp.waitFor(hasMark("dekuji", 2, "info"), 60000, "a blue mark on 'dekuji' in the Czech paragraph");
    assert.ok((srv.hits[WORKER_REL] ?? 0) > 0, "the browser must load the slowed worker");

    // No more input from here. The old code never ran the pass that gives P1
    // its mark, so a fixed wait proves the mark does not come.
    const deadline = Date.now() + 8000;
    let found = false;
    while (!found && Date.now() < deadline) {
      found = await cdp.eval(hasMark("dekuji", 0, "info"));
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    t.diagnostic("marks: " + JSON.stringify(await cdp.eval(MARKS)));
    assert.ok(found, "'dekuji' in the English paragraph has no blue mark 8 s after the Czech one got its mark");
  });
});

// ---- Bugs 2 and 3: the phone box ------------------------------------------------

describe("phone box of a marked word", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  const TYPO_LINE = "I opened the file in vrtti and it looked fine.";

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.setPhoneProfile();
    await browser.goto(srv.url);
    assert.equal(
      await browser.cdp.eval(`document.documentElement.classList.contains("phone")`),
      true,
      "expected html.phone in mobile emulation"
    );
  });

  after(async () => {
    if (browser) {
      printErrors(browser.errors, "phone box");
      await browser.close();
    }
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  /**
   * Type `lines` in a new note, wait for a red mark on `word` in `line`, and
   * tap it. Returns the rect of the word.
   * @param {string[]} lines @param {string} word @param {number} line
   */
  async function tapMarkedWord(lines, word, line) {
    const { cdp } = browser;
    if (lines.length) await typeNote(cdp, lines);
    await cdp.waitFor(hasMark(word, line, "warning"), 60000, `a red mark on '${word}' in line ${line}`);
    const rect = await cdp.eval(markRect(word, line));
    await cdp.tap(rect.x, rect.y);
    return rect;
  }

  test("bug 2: a tap on a marked word opens the phone box, no lint hover tooltip, box right under the word", async (t) => {
    const { cdp } = browser;
    await tapMarkedWord([TYPO_LINE], "vrtti", 0);
    await cdp.waitFor(BOX_ON_SCREEN, 8000, "the phone box on screen");

    // The hover tooltip came about 300 ms after the tap (CodeMirror's
    // hoverTime). 1 s proves that it does not come.
    await new Promise((r) => setTimeout(r, 1000));
    const state = await cdp.eval(`(() => {
      const hovers = [...document.querySelectorAll(".cm-tooltip-hover")]
        .filter((h) => h.querySelector(".cm-tooltip-lint"))
        .map((h) => {
          const r = h.getBoundingClientRect();
          return { display: getComputedStyle(h).display, width: r.width, height: r.height };
        });
      return { hovers, boxes: ${BOXES}, word: ${markRect("vrtti", 0)} };
    })()`);
    const visibleHovers = state.hovers.filter((h) => h.display !== "none" && h.width > 0 && h.height > 0);
    assert.equal(state.boxes.length, 1, "exactly one phone box");
    const gap = state.boxes[0].top - state.word.bottom;
    t.diagnostic(`box top - word bottom = ${gap.toFixed(1)} px; lint hover tooltips: ${JSON.stringify(state.hovers)}`);

    assert.equal(visibleHovers.length, 0, "a lint hover tooltip is visible next to the phone box");
    assert.ok(gap > -2 && gap < 20, `the phone box must sit right under the word, but its top is ${gap.toFixed(1)} px below it`);
  });

  test("bug 3a: the phone box closes when Settings opens from the round buttons", async () => {
    const { cdp } = browser;
    await tapMarkedWord([TYPO_LINE], "vrtti", 0);
    await cdp.waitFor(BOX_ON_SCREEN, 8000, "the phone box on screen");
    try {
      // As a phone user opens Settings: the round thumb button, then its gear.
      await cdp.tapSelector("#new-fab");
      await cdp.waitFor(
        `(() => { const b = document.getElementById("thumb-settings"); const r = b.getBoundingClientRect();
          return !document.getElementById("thumb-menu").hidden && r.width > 0 && r.height > 0; })()`,
        8000,
        "the round buttons"
      );
      await cdp.tapSelector("#thumb-settings");
      await cdp.waitFor(
        `(() => { const p = document.getElementById("settings-panel"); const r = p.getBoundingClientRect();
          return !p.hidden && getComputedStyle(p).display !== "none" && r.width > 0 && r.height > 0; })()`,
        8000,
        "the Settings panel on screen"
      );
      const boxes = await cdp.eval(`document.querySelectorAll(".cm-spell-box").length`);
      assert.equal(boxes, 0, "the phone box stays in the document over the Settings panel");
    } finally {
      // Back to the note for the next test, whatever the result.
      await cdp.eval(`(() => { if (!document.getElementById("settings-panel").hidden) document.getElementById("settings-close").click(); })()`);
      await cdp.waitFor(`document.getElementById("settings-panel").hidden`, 8000, "Settings closed");
    }
  });

  test("bug 3b: a tap on a fix in the phone box changes the word and closes the box", async () => {
    const { cdp } = browser;
    await tapMarkedWord([TYPO_LINE], "vrtti", 0);
    await cdp.waitFor(BOX_ON_SCREEN, 8000, "the phone box on screen");
    const fix = await cdp.eval(`document.querySelector(".cm-spell-box button")?.textContent ?? null`);
    assert.ok(fix, "the phone box must offer a fix for 'vrtti'");
    await cdp.tapSelector(".cm-spell-box button");
    await cdp.waitFor(
      `${DOC_LINES}[0] === ${JSON.stringify(TYPO_LINE.replace("vrtti", fix))}`,
      8000,
      `'vrtti' replaced by '${fix}'`
    );
    await cdp.waitFor(`document.querySelectorAll(".cm-spell-box").length === 0`, 8000, "the phone box closed");
  });

  test("bug 3c: a tap on another marked word moves the open box to that word", async () => {
    const { cdp } = browser;
    // Two marked words on lines far apart. The lower one first: its box opens
    // below it and cannot cover the upper word, which the second tap needs.
    const lines = [TYPO_LINE, "", "Then I saved the qwrtz notes and went home."];
    await typeNote(cdp, lines);
    await cdp.waitFor(hasMark("vrtti", 0, "warning"), 60000, "a red mark on 'vrtti'");
    const lower = await tapMarkedWord([], "qwrtz", 2);
    await cdp.waitFor(BOX_ON_SCREEN, 8000, "the phone box under 'qwrtz'");
    const first = (await cdp.eval(BOXES))[0];
    assert.ok(Math.abs(first.top - lower.bottom) < 40, `the box must open under 'qwrtz' (box top ${first.top}, word bottom ${lower.bottom})`);

    const upper = await tapMarkedWord([], "vrtti", 0);
    await cdp.waitFor(
      `(() => { const b = ${BOXES}; return b.length === 1 && Math.abs(b[0].top - ${upper.bottom}) < 40; })()`,
      8000,
      "the phone box under 'vrtti'"
    );
    assert.equal(await cdp.eval(`document.querySelectorAll(".cm-spell-box").length`), 1, "exactly one phone box");
  });
});
