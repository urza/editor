// Browser test for the spellcheck settings: the Spellcheck page inside
// Settings, "My words", the quick buttons on a mark, the switch "Mark Czech
// without diacritics", and the shared settings across windows and reloads.
//
//   node --test tests/e2e/spellcheck-settings.test.mjs
//
// Plain Node + local Chromium via the Chrome DevTools Protocol (no npm
// packages). Skips cleanly when no Chromium binary is available on the host.
//
// Verifies with real input events (Input.dispatchMouseEvent /
// dispatchKeyEvent / dispatchTouchEvent / insertText) that:
//  - the row "Spellcheck rules and words" opens the page, Back and Escape
//    return to the rows, a second Escape closes the panel;
//  - the rule search finds a rule, a rule switch removes and brings back the
//    marks of that rule, "N changed" filters, "Reset to defaults" resets;
//  - the row shows "N rule(s) changed. N word(s).";
//  - "My words" adds, refuses a word in other capitals, removes, and edits
//    the list as text (Save and Cancel);
//  - the quick buttons ("Add to my words", Turn off "<rule>") work from the
//    Ctrl+. menu, from the hover tooltip, and from the phone box;
//  - the device switch "Mark Czech without diacritics" hides the blue mark
//    and leaves real typos red;
//  - a change in one tab shows in another tab without a reload, and after a
//    reload;
//  - the focus stays on the page when its control goes away: the × of a word,
//    "Reset to defaults", "N changed", a switch in the "changed" filter; Tab
//    from there stays on the page, and the panel does not scroll;
//  - a copy of the settings from another window merges with the copy of this
//    window, and loses nothing of it;
//  - a rule switched off and on again before the worker answers is on;
//  - on a phone, the strip of section buttons hides while the page is open,
//    and the headings of the page stick under the head;
//  - "My words" takes "constructor" and "__proto__", also after a reload.
//
// The English checker is Harper, a 15 MB wasm that loads on the first pass,
// so the first marks can take many seconds. Every wait polls with a deadline.
//
// Script errors and console errors of every page are collected
// (Runtime.exceptionThrown, Runtime.consoleAPICalled, Log.entryAdded) and
// printed at the end of each block, so a run shows them even when every
// assertion passes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
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

// The note every block types. Line indices of the CodeMirror lines below:
// the blank lines between the paragraphs are lines 1 and 3.
const EN_LINE = 0;
const LONG_LINE = 2;
const CS_LINE = 4;
const PARAGRAPHS = [
  // "vrtti" is no English word: a red mark from Harper.
  "I opened the file in vrtti and it looked fine.",
  // 51 words in one sentence: a blue mark of the Harper rule LongSentences.
  "This sentence is very long because it goes on and on and on with many words that add nothing to the point " +
    "and the writer does not stop to put a period anywhere so the reader gets tired and loses the thread long " +
    "before the end of it arrives at last.",
  // Czech: "vrtti" red from the app's own word pass, "dekuji" blue (it
  // becomes "děkuji" with diacritics).
  "Dnes jsem otevřel soubor ve vrtti a všechno bylo v pořádku, moc dekuji za rychlou odpověď.",
];
const LONG_START = "This sentence is very long";

// Harper loads lazily and the marks follow 600 ms after typing stops.
const FIRST_MARKS_MS = 30000;
const MARKS_MS = 10000;

/** Every script error and console error, from every page, with its label. */
const problems = [];

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

const KEYS = {
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Period: { key: ".", code: "Period", windowsVirtualKeyCode: 190, text: "." },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
};
const CTRL = 2;

class CdpClient {
  /** @param {string} wsUrl @param {string} label  Names the page in the problem list. */
  constructor(wsUrl, label) {
    this.ws = new WebSocket(wsUrl);
    this.label = label;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP socket error: " + String(e))));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id) {
        this.onEvent(msg);
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  /**
   * Collect what the page reports as broken. An uncaught exception in a
   * click handler fails no assertion by itself, so the list is the only
   * place it shows.
   * @param {any} msg
   */
  onEvent(msg) {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      problems.push(`[${this.label}] exception: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params.type)) {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
      problems.push(`[${this.label}] console.${msg.params.type}: ${text}`);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      problems.push(`[${this.label}] log: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
    }
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

  /** @param {string} expression @param {number} [timeoutMs] @param {string} [what] */
  async waitFor(expression, timeoutMs = 8000, what = expression) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.eval(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timed out waiting for: " + what);
  }

  /**
   * The center of an element, scrolled into view.
   * @param {string} elementExpr  JS that evaluates to an element or null.
   */
  async centerOf(elementExpr) {
    return this.eval(`(() => {
      const el = ${elementExpr};
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
  }

  /**
   * A real mouse click at the center of the element, so the browser runs its
   * real mousedown focus rules (unlike a synthetic element.click()).
   * @param {string} elementExpr  JS that evaluates to an element or null.
   * @param {string} [what]
   */
  async clickEl(elementExpr, what = elementExpr) {
    const box = await this.centerOf(elementExpr);
    assert.ok(box && box.w > 0 && box.h > 0, `element not visible for click: ${what}`);
    await this.clickAt(box.x, box.y);
  }

  /** @param {string} selector */
  click(selector) {
    return this.clickEl(`document.querySelector(${JSON.stringify(selector)})`, selector);
  }

  /** @param {number} x @param {number} y */
  async clickAt(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** @param {number} x @param {number} y */
  hover(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  /**
   * A real touch tap: the browser turns it into the pointer events and the
   * click a finger makes.
   * @param {number} x @param {number} y
   */
  async tapAt(x, y) {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /** @param {string} elementExpr @param {string} [what] */
  async tapEl(elementExpr, what = elementExpr) {
    const box = await this.centerOf(elementExpr);
    assert.ok(box && box.w > 0 && box.h > 0, `element not visible for tap: ${what}`);
    await this.tapAt(box.x, box.y);
  }

  /**
   * A real key press (keydown + keyup).
   * @param {keyof typeof KEYS} name @param {number} [modifiers]
   */
  async pressKey(name, modifiers = 0) {
    const spec = KEYS[name];
    // With Ctrl held the key produces no text: Ctrl+. is a shortcut, not a dot.
    const text = modifiers === 0 && spec.text ? { text: spec.text } : {};
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: text.text ? "keyDown" : "rawKeyDown", ...base, ...text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** @param {string} text */
  type(text) {
    return this.send("Input.insertText", { text });
  }

  close() {
    this.ws.close();
  }
}

/** @param {string} chromePath @param {string} label */
async function launchBrowser(chromePath, label) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-spellcheck-"));
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
  const browserCdp = new CdpClient(version.webSocketDebuggerUrl, label + "/browser");
  await browserCdp.ready;
  /** @type {Set<CdpClient>} */
  const clients = new Set([browserCdp]);

  /** @param {string} wsUrl @param {string} tabLabel */
  async function attach(wsUrl, tabLabel) {
    const cdp = new CdpClient(wsUrl, tabLabel);
    await cdp.ready;
    clients.add(cdp);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    async function setDesktop(width = 1100, height = 760) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }

    async function setPhone() {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }

    /** @param {string} url */
    async function goto(url) {
      await cdp.send("Page.navigate", { url });
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)", 15000);
    }

    async function reload() {
      await cdp.send("Page.reload", { ignoreCache: true });
      // Wait until the old window is replaced and the fresh boot completes.
      await new Promise((r) => setTimeout(r, 80));
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)", 15000);
    }

    return { cdp, setDesktop, setPhone, goto, reload };
  }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const first = targets.find((t) => t.type === "page");
  if (!first?.webSocketDebuggerUrl) throw new Error("No page target found");
  const page = await attach(first.webSocketDebuggerUrl, label);

  /** A second tab of the same profile: same IndexedDB, same origin. @param {string} tabLabel */
  async function openTab(tabLabel) {
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((t) => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error("Created target has no WS url");
    return attach(target.webSocketDebuggerUrl, tabLabel);
  }

  async function close() {
    for (const c of clients) {
      try {
        c.close();
      } catch {}
    }
    proc.kill("SIGTERM");
    await new Promise((r) => {
      proc.once("exit", r);
      setTimeout(r, 2000);
    });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { page, openTab, close };
}

// ---- Page helpers ----------------------------------------------------------------

/** JS for the element of the first button in `scope` whose text is `text`. */
function buttonByText(text, scope = "#settings-panel") {
  return `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(
    (b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.closest("[hidden]") && b.offsetParent !== null
  ) ?? null`;
}

/**
 * Every mark in the editor: color, marked text, and the CodeMirror line.
 * @param {CdpClient} cdp
 * @returns {Promise<{ color: string, text: string, line: number }[]>}
 */
function marks(cdp) {
  return cdp.eval(`(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")];
    return [...document.querySelectorAll(".cm-content .cm-lintRange")].map((el) => ({
      color: el.classList.contains("cm-lintRange-warning") ? "red" : el.classList.contains("cm-lintRange-info") ? "blue" : "other",
      text: el.textContent,
      line: lines.indexOf(el.closest(".cm-line")),
    }));
  })()`);
}

/** @param {{ color: string, text: string, line: number }[]} list */
const has = (list, color, line, text) => list.some((m) => m.color === color && m.line === line && m.text.startsWith(text));
/** Any mark on the word, whatever its color. */
const onWord = (list, line, text) => list.some((m) => m.line === line && m.text === text);

/**
 * Poll the marks until `ok` holds. The message on a timeout lists the marks
 * as they were, which tells a slow engine from a wrong mark.
 * @param {CdpClient} cdp
 * @param {(list: { color: string, text: string, line: number }[]) => boolean} ok
 * @param {string} what
 * @param {number} [timeoutMs]
 */
async function waitMarks(cdp, ok, what, timeoutMs = MARKS_MS) {
  const deadline = Date.now() + timeoutMs;
  let list = [];
  while (Date.now() < deadline) {
    list = await marks(cdp);
    if (ok(list)) return list;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for marks: ${what}\nmarks now: ${JSON.stringify(list)}`);
}

/** The marks of the typed note with every setting at its default. */
const baseline = (/** @type {any[]} */ list) =>
  has(list, "red", EN_LINE, "vrtti") &&
  has(list, "blue", LONG_LINE, LONG_START) &&
  has(list, "red", CS_LINE, "vrtti") &&
  has(list, "blue", CS_LINE, "dekuji");

/**
 * Wait for the first marks of the typed note.
 *
 * Sometimes the first pass with Harper loaded leaves "vrtti" in the English
 * paragraph without its red mark, and no later pass comes until the next
 * edit. This is a race in the app that predates the settings feature.
 * Harper's first lint can take longer than the 60 ms budget of the pass, so
 * the twin search for "vrtti" is queued and the paragraph is left without
 * that mark. The Czech paragraph of the same pass then computes the same
 * word, which removes it from the queue, and the idle fill finds nothing to
 * do and never asks for a new pass (spellcheck.worker.js: answerCzech,
 * computeCzech, scheduleIdleFill; hunspell.js has the same shape for the
 * main-thread fallback). It showed in about one run of six before the
 * checkers moved into a worker, and in none of the first runs after. The
 * tests below are about the settings, not about this race, so a missing
 * English mark gets one real edit (Space, Backspace at the caret, which sits
 * at the end of the note) and a line in the output instead of a failure of
 * every test.
 * @param {CdpClient} cdp @param {string} label
 */
async function waitFirstMarks(cdp, label) {
  const deadline = Date.now() + FIRST_MARKS_MS;
  let missingSince = 0;
  let nudged = false;
  let list = [];
  while (Date.now() < deadline) {
    list = await marks(cdp);
    if (baseline(list)) return;
    const restThere = has(list, "blue", LONG_LINE, LONG_START) && has(list, "red", CS_LINE, "vrtti") && has(list, "blue", CS_LINE, "dekuji");
    if (restThere && !onWord(list, EN_LINE, "vrtti")) {
      missingSince ||= Date.now();
      if (!nudged && Date.now() - missingSince > 3000) {
        console.log(`[${label}] the first pass left "vrtti" of the English paragraph unmarked; one edit to run a new pass`);
        await cdp.pressKey("Space");
        await cdp.pressKey("Backspace");
        nudged = true;
      }
    } else missingSince = 0;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for the first marks\nmarks now: ${JSON.stringify(list)}`);
}

/**
 * The center of `needle` inside CodeMirror line `line`, from a DOM Range, so
 * a click or a tap lands on that word and not on the start of the line.
 * @param {CdpClient} cdp @param {number} line @param {string} needle
 */
async function wordAt(cdp, line, needle) {
  const box = await cdp.eval(`(() => {
    const line = document.querySelectorAll(".cm-content .cm-line")[${line}];
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(needle)});
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + ${needle.length});
      const r = range.getClientRects()[0];
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }
    return null;
  })()`);
  assert.ok(box, `word "${needle}" not found in line ${line}`);
  return box;
}

/**
 * Type the three paragraphs into a new note, as a user does: a click into
 * the text, then the words, and Enter twice between paragraphs.
 * @param {CdpClient} cdp @param {{ phone?: boolean }} [opts]
 */
async function typeNote(cdp, { phone = false } = {}) {
  await cdp.eval('window.vrtti.run("buffer.new")');
  await cdp.waitFor('document.querySelector(".cm-content")?.textContent === ""');
  if (phone) await cdp.tapEl('document.querySelector(".cm-content")', ".cm-content");
  else await cdp.click(".cm-content");
  await cdp.waitFor('Boolean(document.activeElement?.closest(".cm-editor"))');
  for (let i = 0; i < PARAGRAPHS.length; i++) {
    if (i > 0) {
      await cdp.pressKey("Enter");
      await cdp.pressKey("Enter");
    }
    await cdp.type(PARAGRAPHS[i]);
  }
  await cdp.waitFor(
    `[...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\\n") === ${JSON.stringify(
      PARAGRAPHS.join("\n\n")
    )}`,
    5000,
    "the typed note"
  );
}

/**
 * Put the shared settings back to empty: no rule changed, no word. A setup
 * step that keeps the tests independent, written through the store like the
 * page does, so the "shared-settings" event repaints everything.
 * @param {CdpClient} cdp
 */
function resetShared(cdp) {
  return cdp.eval("window.vrtti.store.writeSharedSettings({ v: 1, rules: {}, words: {} })");
}

/** @param {CdpClient} cdp */
async function closeSettings(cdp) {
  if (await cdp.eval('document.getElementById("settings-panel").hidden')) return;
  await cdp.click("#settings-close");
  await cdp.waitFor('document.getElementById("settings-panel").hidden');
}

/** @param {CdpClient} cdp */
async function openSettings(cdp) {
  if (!(await cdp.eval('document.getElementById("settings-panel").hidden'))) return;
  await cdp.click("#bar-settings");
  await cdp.waitFor('!document.getElementById("settings-panel").hidden');
}

const TITLE = 'document.querySelector("#settings-panel .settings-title")?.textContent';
const RULE_COUNT = 'document.querySelector("#settings-panel .spell-bar .spell-count")?.textContent ?? ""';

/**
 * Settings, then the row "Spellcheck rules and words", then wait until the
 * rules came from Harper (the count line).
 * @param {CdpClient} cdp
 */
async function openSpellPage(cdp) {
  await openSettings(cdp);
  if ((await cdp.eval(TITLE)) !== "Spellcheck") {
    await cdp.click('.settings-row[data-key="spell-page"] .settings-button');
    await cdp.waitFor(`${TITLE} === "Spellcheck"`);
  }
  await cdp.waitFor(`/^\\d+ rules/.test(${RULE_COUNT})`, FIRST_MARKS_MS, "the rule count line");
}

const RULE_SEARCH = 'document.querySelector("#settings-panel input.spell-search[type=search]")';

/**
 * A click into the rule search. The heading "Rules" sticks under the head,
 * and the field comes right below the heading. When the panel is scrolled,
 * a scroll to the nearest edge puts the field under the heading, and the
 * click lands on the heading. So the field goes to the middle first.
 * @param {CdpClient} cdp
 */
async function clickRuleSearch(cdp) {
  await cdp.eval(`${RULE_SEARCH}.scrollIntoView({ block: "center" })`);
  await cdp.clickEl(RULE_SEARCH, "the rule search");
  await cdp.waitFor(`document.activeElement === ${RULE_SEARCH}`, 3000, "the focus in the rule search");
}

/** @param {CdpClient} cdp @param {string} text */
async function searchRules(cdp, text) {
  await clickRuleSearch(cdp);
  await cdp.type(text);
}

/** Empty the rule search with Backspace, as a user does. @param {CdpClient} cdp */
async function clearRuleSearch(cdp) {
  const length = await cdp.eval(`${RULE_SEARCH}.value.length`);
  await clickRuleSearch(cdp);
  for (let i = 0; i < length; i++) await cdp.pressKey("Backspace");
  await cdp.waitFor(`${RULE_SEARCH}.value === ""`, 3000, "an empty rule search");
}

const LONG_TOGGLE = '#settings-panel .settings-row[data-rule="LongSentences"] .settings-toggle';

/** Find LongSentences with the search and switch it. @param {CdpClient} cdp */
async function switchLongSentences(cdp) {
  await searchRules(cdp, "sentence");
  await cdp.waitFor(`Boolean(document.querySelector(${JSON.stringify(LONG_TOGGLE)}))`);
  const before = await cdp.eval(`document.querySelector(${JSON.stringify(LONG_TOGGLE)}).getAttribute("aria-pressed")`);
  await cdp.click(LONG_TOGGLE);
  const want = before === "true" ? "false" : "true";
  // The click writes the record; the "shared-settings" event repaints the row.
  await cdp.waitFor(
    `document.querySelector(${JSON.stringify(LONG_TOGGLE)})?.getAttribute("aria-pressed") === "${want}"`,
    5000,
    `LongSentences aria-pressed=${want}`
  );
  await clearRuleSearch(cdp);
}

const WORD_FIELD = '#settings-panel input[placeholder="Filter or add a word"]';
const WORDS = '[...document.querySelectorAll("#settings-panel .spell-word > span:first-child")].map((s) => s.textContent)';

/** Type a word into "Filter or add a word" and press Enter. @param {CdpClient} cdp @param {string} word */
async function addWordOnPage(cdp, word) {
  await cdp.click(WORD_FIELD);
  await cdp.type(word);
  await cdp.pressKey("Enter");
  await cdp.waitFor(`${WORDS}.includes(${JSON.stringify(word)})`, 5000, `"${word}" in My words`);
}

/**
 * The open menu (ui/menu.js) as a list: separators and item labels in order.
 * @param {CdpClient} cdp
 */
function menuEntries(cdp) {
  return cdp.eval(`(() => {
    const menu = document.querySelector("div.menu");
    if (!menu) return null;
    return [...menu.querySelectorAll(".menu-item, .menu-sep")].map((el) =>
      el.classList.contains("menu-sep") ? "---" : (el.querySelector(".menu-label") ?? el).textContent.trim()
    );
  })()`);
}

/** @param {string} label */
const menuItem = (label) =>
  `[...document.querySelectorAll("div.menu .menu-item")].find((b) => (b.querySelector(".menu-label") ?? b).textContent.trim() === ${JSON.stringify(
    label
  )}) ?? null`;

/**
 * The focused element as one short string, so that a failed assertion shows
 * where the focus went: "body", "editor", "section:<heading>" for a section
 * of the Spellcheck page, else "<tag>:<aria-label or text>".
 */
const FOCUSED = `(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return "body";
  if (a.closest(".cm-content")) return "editor";
  if (a.matches(".spell-page .settings-section")) return "section:" + a.querySelector(":scope > h3").textContent;
  return a.tagName.toLowerCase() + ":" + (a.getAttribute("aria-label") || a.textContent.trim());
})()`;
const IN_PANEL = 'Boolean(document.activeElement?.closest("#settings-panel"))';
const SCROLL_TOP = 'document.getElementById("settings-panel").scrollTop';

/**
 * Put the focus on a control, then press a key, as a keyboard user does
 * after some Tab steps. el.focus() stands in for those steps.
 * @param {CdpClient} cdp @param {string} elementExpr @param {keyof typeof KEYS} key @param {string} what
 */
async function pressOn(cdp, elementExpr, key, what) {
  const focused = await cdp.eval(`(() => {
    const el = ${elementExpr};
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  assert.ok(focused, `cannot focus: ${what}`);
  await cdp.pressKey(key);
}

/**
 * JS for the section of the Spellcheck page under the heading `heading`. In
 * parentheses, so that a ".x" after it applies to the section.
 */
const sectionOf = (/** @type {string} */ heading) =>
  `([...document.querySelectorAll("#settings-panel .spell-page .settings-section")].find(
    (s) => s.querySelector(":scope > h3")?.textContent === ${JSON.stringify(heading)}
  ) ?? null)`;

const WORD_COUNT = `${sectionOf("My words")}?.querySelector(".spell-bar .spell-count")?.textContent ?? ""`;

/**
 * Open groups of rules until the part "Rules" is at least `screens` times
 * as tall as the panel, so that the panel scrolls inside that part.
 * @param {CdpClient} cdp @param {number} screens @param {{ phone?: boolean }} [opts]
 */
async function makeRulesTall(cdp, screens, { phone = false } = {}) {
  const tallEnough = `(() => {
    const panel = document.getElementById("settings-panel");
    return ${sectionOf("Rules")}.getBoundingClientRect().height > ${screens} * panel.clientHeight;
  })()`;
  for (let i = 0; i < 15 && !(await cdp.eval(tallEnough)); i++) {
    const head = `document.querySelectorAll("#settings-panel .spell-group")[${i}]`;
    if (phone) await cdp.tapEl(head, `group ${i}`);
    else await cdp.clickEl(head, `group ${i}`);
    await cdp.waitFor(`${head}.getAttribute("aria-expanded") === "true"`, 3000, `group ${i} open`);
  }
  assert.ok(await cdp.eval(tallEnough), `the part "Rules" is not ${screens} screens tall`);
}

/**
 * Post a copy of the settings record as another window does (model/docs.js,
 * postBuffer; model/channel.js for the message). A second BroadcastChannel
 * object stands in for that window: the channel delivers to every other
 * object of the same name, also in the same page. A third object tells when
 * the message arrived. The channel queues the deliveries in the order in
 * which the objects were made, so the app's object, made at the start, gets
 * the message first, and its handler takes the copy without an await.
 * @param {CdpClient} cdp @param {object} record
 */
function postFromOtherWindow(cdp, record) {
  return cdp.eval(`new Promise((resolve) => {
    const sender = new BroadcastChannel("vrtti");
    const probe = new BroadcastChannel("vrtti");
    probe.onmessage = () => {
      probe.close();
      sender.close();
      setTimeout(resolve, 50);
    };
    sender.postMessage({ type: "buffer", payload: { record: ${JSON.stringify(record)} }, from: "test-other-window" });
  })`);
}

/**
 * Wait until the marks stop changing: the same marks for `quietMs`, with the
 * red mark of "vrtti" in the English paragraph among them. A pass that is
 * out of date answers with no marks at all (spellSource, `res.stale`), so an
 * empty list in the middle is no end state. The red mark has nothing to do
 * with the rule under test, so it is in the end state on the old and the new
 * code.
 * @param {CdpClient} cdp @param {number} [quietMs]
 */
async function settledMarks(cdp, quietMs = 1500) {
  const deadline = Date.now() + MARKS_MS;
  let last = "";
  let since = Date.now();
  let list = [];
  while (Date.now() < deadline) {
    list = await marks(cdp);
    const now = JSON.stringify(list);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (has(list, "red", EN_LINE, "vrtti") && Date.now() - since >= quietMs) {
      return list;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`The marks did not settle\nmarks now: ${last}`);
}

function printProblems(label) {
  const mine = problems.filter((p) => p.startsWith(`[${label}`));
  if (mine.length) console.log(`Page problems (${label}):\n  ` + mine.join("\n  "));
  else console.log(`Page problems (${label}): none`);
}

const chromePath = findChromium();

// ---- Desktop ---------------------------------------------------------------------

describe("spellcheck settings on a PC", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;
  /** @type {CdpClient} */
  let cdp;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath), "pc");
    cdp = browser.page.cdp;
    await browser.page.setDesktop();
    await browser.page.goto(srv.url);
    await typeNote(cdp);
    await waitFirstMarks(cdp, "pc");
  });

  after(async () => {
    printProblems("pc");
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  // Each test starts from the default settings and the default marks, with
  // Settings closed, so one failure does not spill into the next test.
  beforeEach(async () => {
    if (!cdp) return;
    await closeSettings(cdp);
    await resetShared(cdp);
    await waitMarks(cdp, baseline, "the default marks");
  });

  test("1. the row opens the page; Back and Escape return to Settings; a second Escape closes the panel", async () => {
    await openSettings(cdp);
    const row = '.settings-row[data-key="spell-page"]';
    await cdp.click(`${row} .settings-button`);
    await cdp.waitFor(`${TITLE} === "Spellcheck"`);
    assert.equal(await cdp.eval('document.getElementById("settings-back").hidden'), false, "← Settings must show");
    assert.equal(await cdp.eval('document.getElementById("settings-back").textContent'), "← Settings");
    await cdp.waitFor(`/^\\d+ rules/.test(${RULE_COUNT})`, FIRST_MARKS_MS, "the rule count line");
    assert.match(await cdp.eval(RULE_COUNT), /^823 rules/);
    assert.equal(await cdp.eval('document.querySelectorAll("#settings-panel .spell-group").length'), 15);
    // No group is open, so no rule row exists yet.
    assert.equal(await cdp.eval('document.querySelectorAll("#settings-panel [data-rule]").length'), 0);

    // ← Settings: back to the rows, the row that opened the page visible.
    await cdp.click("#settings-back");
    await cdp.waitFor(`${TITLE} === "Settings"`);
    const rowVisible = `(() => { const r = document.querySelector('#settings-panel ${row}'); return Boolean(r && r.offsetParent !== null); })()`;
    assert.equal(await cdp.eval(rowVisible), true, "the spell-page row is visible again");
    assert.equal(await cdp.eval('document.getElementById("settings-back").hidden'), true);

    // Escape: one step at a time.
    await cdp.click(`${row} .settings-button`);
    await cdp.waitFor(`${TITLE} === "Spellcheck"`);
    await cdp.pressKey("Escape");
    await cdp.waitFor(`${TITLE} === "Settings"`, 3000, "first Escape returns to Settings");
    assert.equal(await cdp.eval('document.getElementById("settings-panel").hidden'), false, "first Escape keeps the panel open");
    assert.equal(await cdp.eval(rowVisible), true);
    await cdp.pressKey("Escape");
    await cdp.waitFor('document.getElementById("settings-panel").hidden', 3000, "second Escape closes the panel");
  });

  test("2. the search finds LongSentences; an empty search hides the rule rows again", async () => {
    await openSpellPage(cdp);
    await searchRules(cdp, "sentence");
    const row = '#settings-panel .settings-row[data-rule="LongSentences"]';
    await cdp.waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`, 3000, "the LongSentences row");
    const label = await cdp.eval(`document.querySelector(${JSON.stringify(row)} + " .settings-label > div").firstChild.textContent`);
    assert.equal(label, "Long Sentences");
    await clearRuleSearch(cdp);
    await cdp.waitFor('document.querySelectorAll("#settings-panel [data-rule]").length === 0', 3000, "no rule rows");
    assert.equal(await cdp.eval('document.querySelectorAll("#settings-panel .spell-group").length'), 15);
  });

  test("3. a rule switch removes its mark; '1 changed' filters; Reset to defaults brings the mark back", async () => {
    await openSpellPage(cdp);
    await switchLongSentences(cdp);
    await waitMarks(cdp, (l) => !has(l, "blue", LONG_LINE, LONG_START), "the long-sentence mark gone");
    const now = await marks(cdp);
    assert.ok(has(now, "red", EN_LINE, "vrtti") && has(now, "red", CS_LINE, "vrtti"), "the red marks stay: " + JSON.stringify(now));

    assert.equal(await cdp.eval('document.querySelector("#settings-panel .spell-changed-filter")?.textContent'), "1 changed");
    await cdp.click("#settings-panel .spell-changed-filter");
    await cdp.waitFor('document.querySelector("#settings-panel .spell-changed-filter")?.getAttribute("aria-pressed") === "true"');
    const shown = await cdp.eval('[...document.querySelectorAll("#settings-panel [data-rule]")].map((r) => r.dataset.rule)');
    assert.deepEqual(shown, ["LongSentences"], "the filter shows only the changed rule");

    await cdp.clickEl(buttonByText("Reset to defaults"), "Reset to defaults");
    await cdp.waitFor('!document.querySelector("#settings-panel .spell-changed-filter")', 5000, "'N changed' gone");
    await waitMarks(cdp, (l) => has(l, "blue", LONG_LINE, LONG_START), "the long-sentence mark back");
  });

  test("4. the row summary reads '1 rule changed. 1 word.'", async () => {
    await openSpellPage(cdp);
    await switchLongSentences(cdp);
    await addWordOnPage(cdp, "vrtti");
    await cdp.click("#settings-back");
    await cdp.waitFor(`${TITLE} === "Settings"`);
    assert.equal(
      await cdp.eval('document.querySelector(\'.settings-row[data-key="spell-page"] .settings-value\')?.textContent'),
      "1 rule changed. 1 word."
    );
  });

  test("5. My words: add, same word in capitals, remove, Edit as text with Save and Cancel", async () => {
    await openSpellPage(cdp);
    await cdp.click(WORD_FIELD);
    await cdp.type("vrtti");
    // The button shows while the typed word is not in the list.
    await cdp.waitFor(`Boolean(${buttonByText("Add “vrtti”")})`, 3000, "the button Add “vrtti”");
    await cdp.pressKey("Enter");
    await cdp.waitFor(`${WORDS}.includes("vrtti")`, 5000, '"vrtti" in the list');
    await waitMarks(
      cdp,
      (l) => !onWord(l, EN_LINE, "vrtti") && !onWord(l, CS_LINE, "vrtti"),
      "both red marks of vrtti gone"
    );

    // "Vrtti" is the same word: no Add button.
    await cdp.click(WORD_FIELD);
    await cdp.type("Vrtti");
    await cdp.waitFor(`document.querySelector(${JSON.stringify(WORD_FIELD)}).value === "Vrtti"`);
    const addShown = await cdp.eval(`(() => {
      const b = document.querySelector(${JSON.stringify(WORD_FIELD)}).parentElement.querySelector("button");
      return !b.hidden && b.offsetParent !== null ? b.textContent : null;
    })()`);
    assert.equal(addShown, null, "no Add button for a word in the list in other capitals");
    for (let i = 0; i < 5; i++) await cdp.pressKey("Backspace");

    // × brings both marks back.
    await cdp.click('#settings-panel button[aria-label="Remove vrtti"]');
    await cdp.waitFor(`!${WORDS}.includes("vrtti")`, 5000, '"vrtti" out of the list');
    await waitMarks(cdp, (l) => has(l, "red", EN_LINE, "vrtti") && has(l, "red", CS_LINE, "vrtti"), "both red marks back");

    // Edit as text, Save.
    await cdp.clickEl(buttonByText("Edit as text"), "Edit as text");
    await cdp.waitFor('(() => { const t = document.querySelector("#settings-panel textarea.spell-text"); return t && !t.hidden; })()');
    await cdp.click("#settings-panel textarea.spell-text");
    await cdp.type("vrtti, Harper\nkeyring");
    await cdp.clickEl(buttonByText("Save"), "Save");
    await cdp.waitFor(`${WORDS}.length === 3`, 5000, "three words");
    assert.deepEqual(await cdp.eval(WORDS), ["Harper", "keyring", "vrtti"]);

    // Edit as text, Cancel: nothing changes.
    await cdp.clickEl(buttonByText("Edit as text"), "Edit as text");
    await cdp.click("#settings-panel textarea.spell-text");
    await cdp.type("\nextra");
    await cdp.clickEl(buttonByText("Cancel"), "Cancel");
    await cdp.waitFor('document.querySelector("#settings-panel textarea.spell-text").hidden');
    assert.deepEqual(await cdp.eval(WORDS), ["Harper", "keyring", "vrtti"]);
  });

  test("6. Ctrl+. menu: 'Add to my words' on vrtti, 'Turn off \"Long Sentences\"' in the long sentence", async () => {
    // Caret inside "vrtti" of the English paragraph.
    const v = await wordAt(cdp, EN_LINE, "vrtti");
    await cdp.clickAt(v.x, v.y);
    await cdp.pressKey("Period", CTRL);
    await cdp.waitFor('Boolean(document.querySelector("div.menu"))', 3000, "the Ctrl+. menu");
    const entries = await menuEntries(cdp);
    assert.equal(entries.at(-1), "Add to my words", "the quick entry is last: " + JSON.stringify(entries));
    const fixes = entries.slice(0, -1).filter((e) => e !== "---");
    if (fixes.length > 0) assert.equal(entries.at(-2), "---", "a separator above the quick entry: " + JSON.stringify(entries));
    for (const fix of fixes) assert.ok(!/my words|Turn off/.test(fix), "fixes only above the line: " + fix);
    await cdp.clickEl(menuItem("Add to my words"), "Add to my words");
    await waitMarks(cdp, (l) => !onWord(l, EN_LINE, "vrtti") && !onWord(l, CS_LINE, "vrtti"), "vrtti marks gone");
    await cdp.waitFor('document.getElementById("status-state").textContent === "“vrtti” is in My words"', 3000, "the notice");

    // Caret inside the long sentence, on a word with no other mark.
    const b = await wordAt(cdp, LONG_LINE, "because");
    await cdp.clickAt(b.x, b.y);
    await cdp.pressKey("Period", CTRL);
    await cdp.waitFor('Boolean(document.querySelector("div.menu"))', 3000, "the Ctrl+. menu");
    assert.deepEqual(await menuEntries(cdp), ['Turn off "Long Sentences"']);
    await cdp.clickEl(menuItem('Turn off "Long Sentences"'), "Turn off");
    await waitMarks(cdp, (l) => !has(l, "blue", LONG_LINE, LONG_START), "the long-sentence mark gone");
    await cdp.waitFor('document.getElementById("status-state").textContent === "“Long Sentences” is off"', 3000, "the notice");

    await openSpellPage(cdp);
    assert.equal(await cdp.eval('document.querySelector("#settings-panel .spell-changed-filter")?.textContent'), "1 changed");
  });

  test("7. hover tooltip: a quick button on vrtti and on the long sentence", async () => {
    const quick = 'document.querySelector(".cm-tooltip-lint button.cm-diagnosticAction.cm-quick")?.textContent';
    const v = await wordAt(cdp, EN_LINE, "vrtti");
    await cdp.hover(v.x, v.y);
    await cdp.waitFor(`${quick} === "Add to my words"`, 5000, "hover quick button on vrtti");

    // Off the text first, so the next hover opens a fresh tooltip.
    await cdp.hover(5, 740);
    await cdp.waitFor('!document.querySelector(".cm-tooltip-lint")', 5000, "the tooltip closes");
    const b = await wordAt(cdp, LONG_LINE, "because");
    await cdp.hover(b.x, b.y);
    await cdp.waitFor(`${quick} === 'Turn off "Long Sentences"'`, 5000, "hover quick button on the long sentence");
    assert.match(
      await cdp.eval('document.querySelector(".cm-tooltip-lint")?.textContent ?? ""'),
      /This sentence is 51 words long\./
    );
    await cdp.hover(5, 740);
  });

  test("9. the switch 'Mark Czech without diacritics' hides the blue mark only", async () => {
    const toggle = '.settings-row[data-key="spell-plain"] .settings-toggle';
    await openSettings(cdp);
    assert.equal(await cdp.eval(`document.querySelector('${toggle}').getAttribute("aria-pressed")`), "true");
    try {
      await cdp.click(toggle);
      await cdp.waitFor(`document.querySelector('${toggle}').getAttribute("aria-pressed") === "false"`);
      await waitMarks(cdp, (l) => !onWord(l, CS_LINE, "dekuji"), "no mark on dekuji");
      const now = await marks(cdp);
      assert.ok(has(now, "red", CS_LINE, "vrtti"), "vrtti in the Czech paragraph stays red: " + JSON.stringify(now));
      assert.ok(has(now, "red", EN_LINE, "vrtti"), "vrtti in the English paragraph stays red");
    } finally {
      // A setting of this device, kept in localStorage: put it back for the
      // tests that follow, also when an assertion above failed.
      await openSettings(cdp);
      if ((await cdp.eval(`document.querySelector('${toggle}').getAttribute("aria-pressed")`)) === "false") {
        await cdp.click(toggle);
      }
    }
    await cdp.waitFor(`document.querySelector('${toggle}').getAttribute("aria-pressed") === "true"`);
    await waitMarks(cdp, (l) => has(l, "blue", CS_LINE, "dekuji"), "the blue mark on dekuji back");
  });

  // Tests 12 to 15: a click or a key on a control that the repaint removes
  // or disables. Focus on <body> is the defect: from there, Tab goes to the
  // editor behind the panel, and the next keys change a note that the user
  // cannot see.

  test("12. focus: × of a word goes to the × of a neighbour; × of the only word to 'My words'; Tab goes to the word field", async () => {
    await openSpellPage(cdp);
    await addWordOnPage(cdp, "Harper");
    await addWordOnPage(cdp, "keyring");

    // By keyboard: Enter on the × of "Harper". The × of "keyring" takes its place.
    await pressOn(cdp, 'document.querySelector(\'#settings-panel button[aria-label="Remove Harper"]\')', "Enter", "× of Harper");
    await cdp.waitFor(`!${WORDS}.includes("Harper")`, 5000, '"Harper" out of the list');
    assert.equal(await cdp.eval(FOCUSED), "button:Remove keyring", "the focus goes to the × of the neighbour word");

    // By mouse: the × of the only word. Some content stays below the panel's
    // view, so the shorter list cannot move the scroll position by itself.
    await cdp.eval(`(() => {
      const panel = document.getElementById("settings-panel");
      panel.scrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight - 100);
    })()`);
    const box = await cdp.centerOf('document.querySelector(\'#settings-panel button[aria-label="Remove keyring"]\')');
    assert.ok(box && box.w > 0, "the × of keyring is visible");
    const scrollBefore = await cdp.eval(SCROLL_TOP);
    await cdp.clickAt(box.x, box.y);
    await cdp.waitFor(`${WORDS}.length === 0`, 5000, "an empty list");
    const afterRemove = await cdp.eval(FOCUSED);
    const scrollAfter = await cdp.eval(SCROLL_TOP);
    await cdp.pressKey("Tab");
    const afterTab = await cdp.eval(FOCUSED);
    assert.notEqual(afterTab, "editor", `Tab after the × of the only word went into the editor (focus after the ×: ${afterRemove})`);
    assert.equal(afterRemove, "section:My words", `the focus after the × of the only word (then Tab went to ${afterTab})`);
    assert.equal(scrollAfter, scrollBefore, "the panel does not scroll when the section takes the focus");
    assert.equal(afterTab, "input:Filter or add a word", "Tab from the section goes to the word field");
  });

  test("13. focus: 'Reset to defaults' leaves the focus on 'Rules', with no scroll; Tab goes to the rule search", async () => {
    await openSpellPage(cdp);
    await switchLongSentences(cdp);
    await makeRulesTall(cdp, 2);
    // The top of the part "Rules" goes up under the head, and the button
    // stays in view under the sticky heading. A focus that scrolls the
    // section into view would move the panel back down from here.
    await cdp.eval(`(() => {
      const panel = document.getElementById("settings-panel");
      const head = panel.querySelector(".settings-head").getBoundingClientRect();
      const h3 = ${sectionOf("Rules")}.querySelector(":scope > h3").getBoundingClientRect();
      const reset = (${buttonByText("Reset to defaults")}).getBoundingClientRect();
      panel.scrollTop += reset.top - (head.bottom + h3.height + 12);
    })()`);
    assert.ok(
      await cdp.eval(`${sectionOf("Rules")}.getBoundingClientRect().top < document.querySelector("#settings-panel .settings-head").getBoundingClientRect().bottom`),
      "the top of 'Rules' is above the view"
    );
    const reset = await cdp.eval(`(() => { const r = (${buttonByText("Reset to defaults")}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const scrollBefore = await cdp.eval(SCROLL_TOP);
    await cdp.clickAt(reset.x, reset.y);
    await cdp.waitFor('!document.querySelector("#settings-panel .spell-changed-filter")', 5000, "'N changed' gone");
    const afterReset = await cdp.eval(FOCUSED);
    const scrollAfter = await cdp.eval(SCROLL_TOP);
    await cdp.pressKey("Tab");
    const afterTab = await cdp.eval(FOCUSED);
    assert.notEqual(afterTab, "editor", `Tab after 'Reset to defaults' went into the editor (focus after the reset: ${afterReset})`);
    assert.equal(afterReset, "section:Rules", `the focus after 'Reset to defaults' (then Tab went to ${afterTab})`);
    assert.equal(scrollAfter, scrollBefore, "the panel does not scroll when the section takes the focus");
    assert.equal(afterTab, "input:Search the rules", "Tab from the section goes to the rule search");
  });

  test("14. focus: 'N changed' keeps the focus after a click and after Enter", async () => {
    await openSpellPage(cdp);
    await switchLongSentences(cdp);
    const FILTER = '#settings-panel .spell-changed-filter';
    const onFilter = `document.activeElement === document.querySelector(${JSON.stringify(FILTER)})`;

    await cdp.click(FILTER);
    await cdp.waitFor(`document.querySelector(${JSON.stringify(FILTER)})?.getAttribute("aria-pressed") === "true"`);
    assert.equal(await cdp.eval(onFilter), true, `the new 'N changed' has the focus after a click, not ${await cdp.eval(FOCUSED)}`);

    // The focus is on the button already: Enter goes to it.
    await cdp.pressKey("Enter");
    await cdp.waitFor(`document.querySelector(${JSON.stringify(FILTER)})?.getAttribute("aria-pressed") === "false"`);
    assert.equal(await cdp.eval(onFilter), true, `the new 'N changed' has the focus after Enter, not ${await cdp.eval(FOCUSED)}`);
  });

  test("15. focus: a switch that leaves the 'changed' filter gives the focus to the next switch, then stays in 'Rules'", async () => {
    // Two rules off, written through the store like resetShared. The second
    // rule finds nothing in the note, so its switch changes no mark.
    await cdp.eval(`window.vrtti.store.writeSharedSettings({ v: 1, words: {}, rules: {
      LongSentences: { on: false, at: Date.now() },
      RepeatedWords: { on: false, at: Date.now() },
    } })`);
    await openSpellPage(cdp);
    await cdp.click("#settings-panel .spell-changed-filter");
    const shownRules = '[...document.querySelectorAll("#settings-panel [data-rule]")].map((r) => r.dataset.rule)';
    await cdp.waitFor(`${shownRules}.length === 2`, 3000, "the two changed rules");
    const [first, second] = await cdp.eval(shownRules);
    assert.deepEqual([first, second].sort(), ["LongSentences", "RepeatedWords"]);
    const toggleOf = (/** @type {string} */ rule) =>
      `document.querySelector('#settings-panel .settings-row[data-rule="${rule}"] .settings-toggle')`;
    const label = (/** @type {string} */ rule) => cdp.eval(`${toggleOf(rule)}.getAttribute("aria-label")`);
    const secondLabel = await label(second);

    // Space on the first switch: its rule goes back to its default, and its
    // row leaves the list. The switch of the other rule takes its place.
    await pressOn(cdp, toggleOf(first), "Space", `switch of ${first}`);
    await cdp.waitFor(`${shownRules}.join() === ${JSON.stringify(second)}`, 5000, `only ${second} in the filter`);
    assert.equal(await cdp.eval(FOCUSED), `button:${secondLabel}`, "the focus goes to the switch that took the place");

    // The last changed rule: the filter ends, and the list shows the groups.
    await cdp.pressKey("Space");
    await cdp.waitFor('!document.querySelector("#settings-panel .spell-changed-filter")', 5000, "'N changed' gone");
    const afterLast = await cdp.eval(FOCUSED);
    const inRules = await cdp.eval(`${sectionOf("Rules")}.contains(document.activeElement)`);
    await cdp.pressKey("Tab");
    const afterTab = await cdp.eval(FOCUSED);
    assert.notEqual(afterTab, "editor", `Tab after the last switch went into the editor (focus after the switch: ${afterLast})`);
    assert.ok(inRules, `the focus stays in 'Rules' after the last switch, not ${afterLast}`);
    assert.equal(await cdp.eval(IN_PANEL), true, `Tab stays in the panel, not ${afterTab}`);
  });

  test("16. a copy of the settings from another window merges: an older copy loses no word, a copy with another word adds it", async () => {
    await openSpellPage(cdp);
    const older = Date.now() - 60000;
    await addWordOnPage(cdp, "vrtti");

    // The record as another window had it before the add: no word in it.
    await postFromOtherWindow(cdp, {
      id: "shared-settings",
      kind: "shared-settings",
      content: JSON.stringify({ v: 1, rules: {}, words: {} }),
      createdAt: older,
      updatedAt: older,
    });
    assert.deepEqual(await cdp.eval(WORDS), ["vrtti"], "the word of this window stays after an older copy came");

    // A copy with a word of its own: both words show.
    const now = Date.now();
    await postFromOtherWindow(cdp, {
      id: "shared-settings",
      kind: "shared-settings",
      content: JSON.stringify({ v: 1, rules: {}, words: { harper: { word: "Harper", at: now } } }),
      createdAt: older,
      updatedAt: now,
    });
    await cdp.waitFor(`${WORDS}.includes("Harper")`, 3000, '"Harper" from the other window');
    assert.deepEqual(await cdp.eval(WORDS), ["Harper", "vrtti"], "both words show");
    assert.equal(await cdp.eval(WORD_COUNT), "2 words");
  });

  test("17. a rule switched off and on again before the worker answers stays on", async () => {
    // beforeEach waited for the blue mark of the long sentence, so the worker
    // has Harper and the current settings. Two calls with no await between
    // them: the second pass starts while the settings of the first are on
    // their way to the worker. The module URL is the one main.js imports, so
    // this is the same module instance as the app's.
    await cdp.eval(`(async () => {
      const m = await import("/js/editor/spellcheck.js");
      m.setShared({ v: 1, rules: { LongSentences: { on: false, at: 1 } }, words: {} });
      m.setShared({ v: 1, rules: {}, words: {} });
    })()`);
    const list = await settledMarks(cdp);
    assert.ok(has(list, "blue", LONG_LINE, LONG_START), "the rule is on, so the long sentence has its blue mark: " + JSON.stringify(list));
  });
});

// ---- Phone -----------------------------------------------------------------------

describe("spellcheck quick buttons on a phone", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath), "phone");
    await browser.page.setPhone();
    await browser.page.goto(srv.url);
  });

  after(async () => {
    printProblems("phone");
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  test("8. a tap on a mark opens the box; its last button is the quick one", async () => {
    const { cdp } = browser.page;
    assert.equal(await cdp.eval('document.documentElement.classList.contains("phone")'), true, "html.phone");
    await typeNote(cdp, { phone: true });
    await waitFirstMarks(cdp, "phone");

    const boxButtons = '[...document.querySelectorAll(".cm-spell-box button")].map((b) => b.textContent)';
    // CodeMirror first puts a new tooltip at top -10000px and moves it under
    // the word in its next measure cycle. A tap before that hits nothing.
    const boxPlaced = `(() => {
      const box = document.querySelector(".cm-spell-box");
      const r = box?.getBoundingClientRect();
      return Boolean(r && r.top >= 0 && r.bottom <= innerHeight);
    })()`;
    const v = await wordAt(cdp, EN_LINE, "vrtti");
    await cdp.tapAt(v.x, v.y);
    await cdp.waitFor(boxPlaced, 3000, "the phone box on vrtti");
    const buttons = await cdp.eval(boxButtons);
    assert.equal(buttons.at(-1), "Add to my words", "the quick button is last: " + JSON.stringify(buttons));

    await cdp.tapEl(
      '[...document.querySelectorAll(".cm-spell-box button")].find((b) => b.textContent === "Add to my words")',
      "Add to my words"
    );
    await waitMarks(cdp, (l) => !onWord(l, EN_LINE, "vrtti") && !onWord(l, CS_LINE, "vrtti"), "vrtti marks gone");
    await cdp.waitFor(
      '(() => { const n = document.getElementById("notice"); return !n.hidden && n.textContent === "“vrtti” is in My words"; })()',
      3000,
      "#notice shows the notice"
    );

    // The blue mark of a Czech word without diacritics: "Add to my words",
    // and no "Turn off" (it is the app's own mark, not a Harper rule).
    const d = await wordAt(cdp, CS_LINE, "dekuji");
    await cdp.tapAt(d.x, d.y);
    await cdp.waitFor(
      `${boxPlaced} && document.querySelector(".cm-spell-box-message")?.textContent.startsWith("Czech without diacritics")`,
      3000,
      "the phone box on dekuji"
    );
    const dekuji = await cdp.eval(boxButtons);
    assert.equal(dekuji.at(-1), "Add to my words", JSON.stringify(dekuji));
    assert.ok(!dekuji.some((t) => t.startsWith("Turn off")), "no Turn off: " + JSON.stringify(dekuji));
  });

  /**
   * The strip of section buttons, as "visible" or "hidden". Hidden means no
   * layout box: its buttons would scroll rows that the page hides.
   */
  const STRIP = `(() => {
    const nav = document.querySelector("#settings-panel nav.settings-jump");
    if (!nav) return "missing";
    const r = nav.getBoundingClientRect();
    return getComputedStyle(nav).display !== "none" && r.width > 0 && r.height > 0 ? "visible" : "hidden";
  })()`;

  /**
   * Settings, then the Spellcheck page, with taps. The phone layout hides
   * #bar-settings, so the command opens the panel.
   * @param {CdpClient} cdp
   */
  async function openSpellPageByTap(cdp) {
    if (await cdp.eval('document.getElementById("settings-panel").hidden')) {
      await cdp.eval('window.vrtti.run("settings.open")');
      await cdp.waitFor('!document.getElementById("settings-panel").hidden');
    }
    if ((await cdp.eval(TITLE)) !== "Spellcheck") {
      await cdp.tapEl(
        'document.querySelector(\'#settings-panel .settings-row[data-key="spell-page"] .settings-button\')',
        "the row Spellcheck rules and words"
      );
      await cdp.waitFor(`${TITLE} === "Spellcheck"`);
    }
    await cdp.waitFor(`/^\\d+ rules/.test(${RULE_COUNT})`, FIRST_MARKS_MS, "the rule count line");
  }

  test("18. phone: the strip of section buttons shows on the rows, hides on the Spellcheck page, and shows after '← Settings'", async () => {
    const { cdp } = browser.page;
    await cdp.eval('window.vrtti.run("settings.open")');
    await cdp.waitFor('!document.getElementById("settings-panel").hidden');
    await cdp.waitFor(`${TITLE} === "Settings"`);
    assert.equal(await cdp.eval(STRIP), "visible", "the strip shows on the rows of Settings");

    await openSpellPageByTap(cdp);
    assert.equal(await cdp.eval(STRIP), "hidden", "the strip hides while the Spellcheck page is open");

    await cdp.tapEl('document.getElementById("settings-back")', "← Settings");
    await cdp.waitFor(`${TITLE} === "Settings"`);
    assert.equal(await cdp.eval(STRIP), "visible", "the strip shows again on the rows");
  });

  test("19. phone: the heading 'Rules' sticks under the head while its part scrolls", async () => {
    const { cdp } = browser.page;
    await openSpellPageByTap(cdp);
    const h3 = `${sectionOf("Rules")}.querySelector(":scope > h3")`;
    // "auto" means the rule "top: calc(... var(--settings-jump-h))" is void.
    const top = await cdp.eval(`getComputedStyle(${h3}).top`);
    assert.notEqual(top, "auto", "the sticky heading has a top");
    assert.match(top, /^-?[\d.]+px$/, "the top is a length");

    await makeRulesTall(cdp, 2, { phone: true });
    // The scroll position is set, not dragged: the test is about where the
    // layout puts the heading, not about touch scrolling.
    const at = await cdp.eval(`(() => {
      const panel = document.getElementById("settings-panel");
      const section = ${sectionOf("Rules")};
      panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top + 400;
      const head = panel.querySelector(".settings-head").getBoundingClientRect();
      const s = section.getBoundingClientRect();
      const h = ${h3}.getBoundingClientRect();
      return { headBottom: head.bottom, sectionTop: s.top, sectionBottom: s.bottom, h3Top: h.top, h3Bottom: h.bottom };
    })()`);
    assert.ok(at.sectionTop < at.headBottom && at.sectionBottom > at.h3Bottom, "the part 'Rules' is in view and its top above: " + JSON.stringify(at));
    assert.ok(Math.abs(at.h3Top - at.headBottom) <= 1, "'Rules' sits right under the head: " + JSON.stringify(at));
  });
});

// ---- Two tabs and a reload -------------------------------------------------------

describe("spellcheck settings across tabs and reloads", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>["page"]} */
  let tabA;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>["page"]} */
  let tabB;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath), "tabs");
    tabA = browser.page;
    await tabA.setDesktop();
    await tabA.goto(srv.url);
    await typeNote(tabA.cdp);
    tabB = await browser.openTab("tabs/B");
    await tabB.setDesktop();
    await tabB.goto(srv.url);
  });

  after(async () => {
    printProblems("tabs");
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  test("10. a rule and a word changed in tab A show in tab B without a reload", async () => {
    // B shows the page first, so the change must reach a page already open.
    await openSpellPage(tabB.cdp);
    assert.equal(await tabB.cdp.eval('Boolean(document.querySelector("#settings-panel .spell-changed-filter"))'), false);

    await openSpellPage(tabA.cdp);
    await switchLongSentences(tabA.cdp);
    await tabB.cdp.waitFor(
      'document.querySelector("#settings-panel .spell-changed-filter")?.textContent === "1 changed"',
      5000,
      "'1 changed' in tab B"
    );

    await addWordOnPage(tabA.cdp, "vrtti");
    await tabB.cdp.waitFor(`${WORDS}.includes("vrtti")`, 5000, '"vrtti" listed in tab B');
  });

  test("11. after a reload the rule is still off and the word still in the list", async () => {
    const { cdp } = tabA;
    await tabA.reload();
    // The note of tab A comes back with the window. Its marks show that the
    // engine got the settings at the start, not only the page: the blue mark
    // of "dekuji" proves a full pass ran (both checkers loaded).
    await cdp.waitFor('document.querySelector(".cm-content")?.textContent.includes("dekuji")', 5000, "the note after the reload");
    await waitMarks(cdp, (l) => has(l, "blue", CS_LINE, "dekuji"), "marks after the reload", FIRST_MARKS_MS);
    const now = await marks(cdp);
    assert.ok(!has(now, "blue", LONG_LINE, LONG_START), "no long-sentence mark after the reload: " + JSON.stringify(now));
    assert.ok(!onWord(now, EN_LINE, "vrtti") && !onWord(now, CS_LINE, "vrtti"), "no mark on a word of My words after the reload");
    await openSpellPage(cdp);
    assert.equal(await cdp.eval('document.querySelector("#settings-panel .spell-changed-filter")?.textContent'), "1 changed");
    assert.ok((await cdp.eval(WORDS)).includes("vrtti"), "vrtti still in My words");
    await searchRules(cdp, "sentence");
    await cdp.waitFor(`Boolean(document.querySelector(${JSON.stringify(LONG_TOGGLE)}))`);
    assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(LONG_TOGGLE)}).getAttribute("aria-pressed")`), "false");
  });

  test("20. My words takes 'constructor' and '__proto__', keeps them after a reload, and × removes one", async () => {
    // Every object has the properties "constructor" and "__proto__". The
    // list must treat them as words like any other.
    const { cdp } = tabA;
    await resetShared(cdp);
    await openSpellPage(cdp);
    await cdp.waitFor(`${WORDS}.length === 0`, 5000, "an empty list");
    for (const word of ["constructor", "__proto__"]) {
      await cdp.click(WORD_FIELD);
      await cdp.type(word);
      await cdp.waitFor(`Boolean(${buttonByText(`Add “${word}”`)})`, 3000, `the button Add “${word}”`);
      await cdp.clickEl(buttonByText(`Add “${word}”`), `Add “${word}”`);
      await cdp.waitFor(`${WORDS}.includes(${JSON.stringify(word)})`, 5000, `"${word}" in My words`);
    }
    assert.deepEqual((await cdp.eval(WORDS)).sort(), ["__proto__", "constructor"]);
    assert.equal(await cdp.eval(WORD_COUNT), "2 words");

    await tabA.reload();
    await openSpellPage(cdp);
    await cdp.waitFor(`${WORDS}.length === 2`, 5000, "two words after the reload");
    assert.deepEqual((await cdp.eval(WORDS)).sort(), ["__proto__", "constructor"]);
    assert.equal(await cdp.eval(WORD_COUNT), "2 words");

    await cdp.click('#settings-panel button[aria-label="Remove constructor"]');
    await cdp.waitFor(`!${WORDS}.includes("constructor")`, 5000, '"constructor" out of the list');
    assert.deepEqual(await cdp.eval(WORDS), ["__proto__"]);
    assert.equal(await cdp.eval(WORD_COUNT), "1 word");
  });
});
