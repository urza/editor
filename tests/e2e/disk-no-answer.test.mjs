// Browser regression test: a disk or file handle call that gives no answer.
//
//   node --test tests/e2e/disk-no-answer.test.mjs
//
// What broke (architecture.md §30): a promise that never settles runs no
// `catch` and no `finally`. In a browser the app start waited on
// queryPermission() for ever, a save on such a handle held the text in
// memory only with "…" on screen, and a disk write with no answer showed "…"
// for ever, also "✓" after a switch to another tab and back.
//
// The test drives the page in two modes:
//  - Shell mode: a fake desktop shell whose `disk_*` commands work on a disk
//    in page memory. A switch per command and path holds a call until the
//    test releases it.
//  - Browser mode: real OPFS handles through stubbed pickers, then FSA
//    prototype methods replaced by promises that never settle.
// The cases shorten LIMITS on the page's own module instance.
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
// A browser start with silent handles asks each stored handle for 3 s
// (LIMITS.query), and the test cannot shorten that before the start.
const SILENT_START_TIMEOUT_MS = 20000;

const DOTS = "…";
const CHECK = "✓";

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

// The fake shell. The page is in shell mode because vrttiDesktop exists
// before any page script runs. The disk is one file in page memory, with
// the commands that opening, showing and saving a file note call
// (storage/native.js; the real ones are in src-tauri/src/disk.rs). Keys use
// "|" because a "\n" here would have to survive two levels of string quoting.
const SHELL_DISK_BOOT = `
  window.vrttiDesktop = { platform: "linux", version: "26.11.3", hostname: "test-pc" };
  {
    const roots = { rNote: { kind: "file", name: "note.md", path: "/disk/note.md" } };
    const files = new Map();
    let clock = Date.now() - 60000;
    // A newer stamp at every write, also for two writes in the same ms.
    const put = (root, path, text) => {
      clock = Math.max(clock + 1, Date.now());
      files.set(root + "|" + path, { text, mtime: clock });
      return clock;
    };
    put("rNote", "", "note.md on disk");

    const entry = (root, path) => {
      const file = files.get(root + "|" + (path ?? ""));
      if (!file) throw { code: "notFound", message: "not found: " + path, path };
      return file;
    };
    const picks = [];
    const commands = {
      // null is what Rust answers for a cancelled dialog.
      disk_pick_file: () => {
        const id = picks.shift();
        return id ? { id, ...roots[id] } : null;
      },
      disk_stat: ({ root, path }) => {
        const file = entry(root, path);
        return { size: file.text.length, mtime: file.mtime };
      },
      disk_read: ({ root, path }) => ({ text: entry(root, path).text }),
      disk_read_bytes: ({ root, path }) => new TextEncoder().encode(entry(root, path).text).buffer,
      disk_write: ({ root, path, text, expectedMtime }) => {
        const file = files.get(root + "|" + path);
        // The real command checks the stamp before the rename (disk.rs, atomic_write).
        if (expectedMtime !== undefined && file && file.mtime !== expectedMtime) {
          throw { code: "conflict", message: "changed on disk", path };
        }
        return { mtime: put(root, path, text) };
      },
      // pruneRoots() reads a count.
      disk_prune: () => 0,
    };

    const log = [];
    const holds = new Set();
    const held = [];
    const keyOf = (cmd, root, path) => cmd + "|" + root + "|" + (path ?? "");
    window.__disk = {
      picks,
      text: (root, path = "") => files.get(root + "|" + path)?.text,
      /** Calls of this command for this root and path from now on stay pending. */
      hold: (cmd, root, path = "") => holds.add(keyOf(cmd, root, path)),
      /** Stop the hold, and answer every held call now, with the disk as it is now. */
      release(cmd, root, path = "") {
        const key = keyOf(cmd, root, path);
        holds.delete(key);
        const due = held.filter((h) => h.key === key);
        for (const h of due) held.splice(held.indexOf(h), 1);
        for (const h of due) h.settle();
        return due.length;
      },
      count: (cmd, root, path = "") =>
        log.filter((c) => c.cmd === cmd && c.root === root && (c.path ?? "") === path).length,
    };
    window.__TAURI__ = {
      core: {
        invoke(cmd, args = {}) {
          log.push({ cmd, root: args.root, path: args.path });
          const run = commands[cmd];
          // Window commands (page_ready, open_workspace, ...) answer nothing.
          if (!run) return Promise.resolve(null);
          // In a promise, so that a thrown disk error becomes a rejection.
          const answer = () => new Promise((resolve) => resolve(run(args)));
          const key = keyOf(cmd, args.root, args.path);
          if (!holds.has(key)) return answer();
          // The command runs at release, as a system call that returns late does.
          return new Promise((resolve, reject) => {
            held.push({ key, settle: () => answer().then(resolve, reject) });
          });
        },
      },
      window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
    };
  }
`;

// Replaces FSA prototype methods by calls that never settle, and counts the
// calls. The same source runs before a reload (browser start) and at run time
// (a save). It replaces the method where it lives, so every existing handle
// gets the new one too. window.__restoreHangs() puts the real methods back:
// new calls then work, and the calls already out stay pending.
const HANG_FN = `
  function installHangs(plan) {
    const calls = (window.__handleCalls ??= {});
    const real = (window.__realMethods ??= []);
    window.__restoreHangs = () => {
      for (const { target, name, own, value } of real.splice(0)) {
        if (own) target[name] = value;
        else delete target[name];
      }
    };
    const never = () => new Promise(() => {});
    // A listing is an async iterator; its first step never settles.
    const stuck = () => ({ next: never, [Symbol.asyncIterator]() { return this; } });
    for (const [protoName, names] of Object.entries(plan)) {
      const proto = window[protoName].prototype;
      for (const name of names) {
        let owner = proto;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
        const target = owner || proto;
        real.push({ target, name, own: Boolean(owner), value: target[name] });
        const result = ["values", "entries", "keys"].includes(name) ? stuck : never;
        calls[name] = 0;
        target[name] = function () {
          calls[name]++;
          return result();
        };
      }
    }
    // Last line on purpose: a Chromium without these classes throws above,
    // and the test must then fail instead of passing with no hooks in place.
    window.__hooksReady = true;
  }
`;

const ALL_SILENT = `
  ${HANG_FN}
  installHangs({
    FileSystemHandle: ["queryPermission", "requestPermission", "isSameEntry", "move"],
    FileSystemFileHandle: ["getFile", "createWritable"],
    FileSystemDirectoryHandle: ["getFileHandle", "getDirectoryHandle", "values", "entries", "keys"],
  });
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-disk-no-answer-"));
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

/**
 * Shorten one limit on the page's own module instance. The old code has no
 * such module: the import fails there, and the case must then fail at its
 * behaviour check, not here. So a failed import only returns false.
 * @param {CdpClient} cdp @param {string} name @param {number} ms
 */
function setLimit(cdp, name, ms) {
  return cdp.eval(`(async () => {
    try {
      const { LIMITS } = await import("./js/model/timelimit.js");
      LIMITS[${JSON.stringify(name)}] = ${ms};
      return true;
    } catch {
      return false;
    }
  })()`);
}

/**
 * Waits for start(). window.vrtti is the last thing start() sets; the URL in
 * the same check keeps the page that is still unloading from passing it.
 * @param {CdpClient} cdp @param {string} url @param {number} timeoutMs
 */
function started(cdp, url, timeoutMs) {
  return cdp.poll(`location.href === ${JSON.stringify(url)} && typeof window.vrtti === "object"`, timeoutMs);
}

/** Type like a user: focus the editor, then real text input over CDP. @param {CdpClient} cdp @param {string} text */
async function typeInEditor(cdp, text) {
  const focused = await cdp.eval(`(() => {
    const el = document.querySelector("#editor-host .cm-content");
    el.focus();
    return document.activeElement === el;
  })()`);
  assert.equal(focused, true, "the editor must take the focus");
  await cdp.send("Input.insertText", { text });
}

/** The text of the document on screen. */
const EDITOR_TEXT = `document.querySelector("#editor-host .cm-content")?.innerText ?? null`;

/**
 * One external-change pass, with a deadline inside the page: "settled" or
 * "pending".
 * @param {CdpClient} cdp @param {number} ms
 */
function raceExternalPass(cdp, ms) {
  return cdp.eval(`Promise.race([
    window.vrtti.checkExternalChanges().then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), ${ms})),
  ])`);
}

/**
 * A real mouse click over CDP, so the page gets a user gesture, as from a
 * user. It first checks that the element is the one under the pointer.
 * @param {CdpClient} cdp @param {string} selector
 */
async function click(cdp, selector) {
  const at = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: Boolean(hit && (hit === el || el.contains(hit))) };
  })()`);
  assert.ok(at?.hit, `the click must land on ${selector}: ${JSON.stringify(at)}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
}

/** What the status bar's state sign shows now. */
const SIGN = `(() => {
  const el = document.getElementById("status-state");
  return { text: el.textContent, problem: el.classList.contains("problem"), title: el.title };
})()`;

const chromePath = findChromium();

describe("shell: a disk write that gives no answer", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(/** @type {string} */ (chromePath));
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SHELL_DISK_BOOT });
    await browser.cdp.send("Page.navigate", { url: srv.url });
    assert.ok(await started(browser.cdp, srv.url, START_TIMEOUT_MS), "the shell did not start");
  });

  after(async () => {
    if (browser) await browser.close();
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  test("S3: a save with no answer says 'not saved yet', also after a tab switch", async (t) => {
    const { cdp } = browser;
    // The note of the first start: the tab to switch to and back from.
    const other = await cdp.eval("window.vrtti.activeId");
    const note = await cdp.eval(`(async () => {
      window.__disk.picks.push("rNote");
      return (await window.vrtti.run("file.open"))?.id;
    })()`);
    assert.ok(other && note, "the start must show a note, and file.open must make a file note");
    const shown = await cdp.poll(
      `window.vrtti.activeId === "${note}" && document.querySelector("#editor-host .cm-content")?.innerText`,
      START_TIMEOUT_MS,
      (v) => typeof v === "string" && v.includes("note.md on disk")
    );
    assert.match(String(shown), /note\.md on disk/, "the file note must be on screen with its text");

    t.diagnostic("LIMITS.slowSave shortened: " + (await setLimit(cdp, "slowSave", 600)));
    await cdp.eval(`(() => {
      window.__disk.hold("disk_write", "rNote");
      // Every sign the bar shows from now on, in order.
      const el = document.getElementById("status-state");
      window.__signs = [];
      new MutationObserver(() => window.__signs.push(el.textContent)).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    })()`);
    await typeInEditor(cdp, "typed while the disk is silent ");

    // The debounce ends and the write goes out, and stays out.
    assert.ok(
      await cdp.poll(`window.__disk.count("disk_write", "rNote") >= 1`, 3000),
      "the save must send disk_write"
    );
    const slow = await cdp.poll(SIGN, 3000, (s) => s?.text === "not saved yet");
    const signs = await cdp.eval("window.__signs");
    t.diagnostic("signs after typing: " + JSON.stringify(signs));
    assert.equal(signs[0], DOTS, "the first sign after typing must be the save in progress");
    assert.equal(slow.text, "not saved yet", "the sign must say 'not saved yet' within 3 s");
    assert.equal(slow.problem, true, "'not saved yet' must carry the class problem");
    assert.match(slow.title, /Keep this window open/, "the title must say what to do");

    // A switch away and back must not turn the open save into a check mark.
    const switched = await cdp.eval(`(async () => {
      const v = window.vrtti;
      await v.activateBuffer("${other}");
      const away = ${SIGN};
      await v.activateBuffer("${note}");
      return { away, back: ${SIGN} };
    })()`);
    t.diagnostic("signs at the switch: " + JSON.stringify(switched));
    assert.equal(switched.back.text, DOTS, "back on the file note, the sign must be the open save, not the check mark");
    const again = await cdp.poll(SIGN, 3000, (s) => s?.text === "not saved yet");
    assert.equal(again.text, "not saved yet", "back on the file note, the sign must say 'not saved yet' again");
    assert.equal(again.problem, true, "back on the file note, the sign must carry the class problem");

    // The disk answers. The sign leaves the problem state.
    assert.ok((await cdp.eval(`window.__disk.release("disk_write", "rNote")`)) >= 1, "a write was held");
    const done = await cdp.poll(SIGN, 3000, (s) => s?.text === CHECK && !s.problem);
    assert.equal(done.text, CHECK, "after the write lands, the sign must be the check mark");
    assert.equal(done.problem, false, "after the write lands, the sign must not be a problem");
    assert.match(
      String(await cdp.eval(`window.__disk.text("rNote")`)),
      /typed while the disk is silent/,
      "the disk must hold the typed text"
    );
  });
});

describe("browser: file handles that give no answer", { skip: !chromePath && "no Chromium binary found" }, () => {
  /** @type {{server: http.Server, url: string}} */
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  /** A fresh browser per case: each case needs its own IndexedDB and OPFS. */
  async function withBrowser(fn) {
    const browser = await launchBrowser(/** @type {string} */ (chromePath));
    try {
      await browser.cdp.send("Page.navigate", { url: srv.url });
      assert.ok(
        await browser.cdp.poll("Boolean(window.vrtti && window.vrtti.activeId)", START_TIMEOUT_MS),
        "browser mode did not start"
      );
      await fn(browser.cdp);
    } finally {
      await browser.close();
    }
  }

  test("B1: the start completes when every stored handle gives no answer", async (t) => {
    await withBrowser(async (cdp) => {
      // A note, a file and a folder, opened through the public commands with
      // healthy OPFS handles, so IndexedDB holds a file and a directory handle.
      const seeded = await cdp.eval(`(async () => {
        const v = window.vrtti;
        v.store.updateContent(v.activeId, "A note\\nwith some text");
        await v.saveNow(v.activeId);
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle("silent.txt", { create: true });
        const w = await file.createWritable();
        await w.write("silent.txt on disk\\n");
        await w.close();
        const dir = await root.getDirectoryHandle("silent-folder", { create: true });
        await dir.getFileHandle("inside.md", { create: true });
        window.showOpenFilePicker = async () => [file];
        window.showDirectoryPicker = async () => dir;
        const folder = await v.run("folder.open");
        const record = await v.run("file.open");
        // Awaited, so the start after the reload is on the file's tab, as in
        // the incident.
        await v.workspaces.setActive(record.id);
        return {
          fileId: record.id,
          folderId: folder?.id,
          rows: [...document.querySelectorAll("#open-list > li")].map((li) => li.dataset.id),
        };
      })()`);
      assert.ok(seeded.fileId && seeded.folderId, "file.open and folder.open must record a file and a folder");

      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: ALL_SILENT });
      const t0 = Date.now();
      await cdp.send("Page.reload", { ignoreCache: true });
      const up = await cdp.poll(
        `location.href === ${JSON.stringify(srv.url)} && window.__hooksReady === true && typeof window.vrtti === "object"`,
        SILENT_START_TIMEOUT_MS
      );
      const calls = await cdp.eval("window.__handleCalls").catch(() => null);
      assert.ok(up, `start() did not complete within ${SILENT_START_TIMEOUT_MS / 1000} s; calls: ${JSON.stringify(calls)}`);
      t.diagnostic(`start took about ${Date.now() - t0} ms`);

      const fileRow = `#open-list > li[data-id="${seeded.fileId}"]`;
      const folderHead = `#folder-sections [data-folder-id="${seeded.folderId}"] .buffer-warn`;
      const state = await cdp.poll(
        `(() => ({
          editor: Boolean(document.querySelector("#editor-host .cm-editor")),
          rows: [...document.querySelectorAll("#open-list > li")].map((li) => li.dataset.id),
          fileMark: Boolean(document.querySelector(${JSON.stringify(fileRow + " .buffer-warn")})),
          folderMark: Boolean(document.querySelector(${JSON.stringify(folderHead)})),
          watch: Boolean(document.getElementById("start-watch")),
          calls: window.__handleCalls,
        }))()`,
        START_TIMEOUT_MS,
        (s) => s?.editor && s.rows.length === seeded.rows.length && s.fileMark && s.folderMark && !s.watch
      );
      t.diagnostic("after the start: " + JSON.stringify(state));
      assert.equal(state.editor, true, "the editor must exist");
      assert.deepEqual([...state.rows].sort(), [...seeded.rows].sort(), "the list must show the note and the file");
      assert.equal(state.fileMark, true, "the file row must carry the reconnect mark (.buffer-warn)");
      assert.equal(state.folderMark, true, "the folder must carry the reconnect mark (.buffer-warn)");
      assert.equal(state.watch, false, "the start watch (#start-watch) must not show at the end");
      assert.equal(state.calls.requestPermission, 0, "the start must never call requestPermission");

      // The file's tab says why it is empty. Only the permission query has a
      // time limit; a read on a handle that gave no answer to it is refused
      // (storage/fsa.js, refuseSilent). Without that, getFile() on the same
      // handle waited for ever, the tab stayed an empty document, and the
      // external-change pass waited behind that read.
      const tab = await cdp.poll(EDITOR_TEXT, START_TIMEOUT_MS, (v) => /File not available/.test(v ?? ""));
      assert.match(String(tab), /File not available: silent\.txt \(permission needed\)/, "the file's tab must say why it is empty");
      const reads = await cdp.eval("window.__handleCalls");
      for (const name of ["getFile", "values", "entries", "keys"]) {
        assert.equal(reads[name], 0, `no ${name}() call may reach a silent handle`);
      }
      assert.equal(await raceExternalPass(cdp, 3000), "settled", "the external-change pass must settle within 3 s");

      // The memo (LIMITS.silentFor): a handle with no answer is not asked
      // again for a while, and each refused read starts the memo again. Each
      // pass reads the file's tab (on screen, no text yet), so a new query
      // also proves that the pass ran. The memo is set per step: the app's
      // own reads renew it at any time, so a real wait for it proves little.
      const queries = () => cdp.eval("window.__handleCalls.queryPermission");
      await setLimit(cdp, "query", 300);
      await setLimit(cdp, "silentFor", 0);
      const start = await queries();
      await raceExternalPass(cdp, 3000);
      const asked = await queries();
      assert.equal(asked, start + 1, "with no memo, a pass must ask the silent handle once");
      await setLimit(cdp, "silentFor", 60000);
      await raceExternalPass(cdp, 3000);
      assert.equal(await queries(), asked, "right after a query with no answer, a read must make no new query");
      // A short memo, then no read for longer than it: time is the subject.
      await setLimit(cdp, "silentFor", 200);
      await new Promise((r) => setTimeout(r, 500));
      await raceExternalPass(cdp, 3000);
      assert.equal(await queries(), asked + 1, "after the memo, the next read must ask the handle again");

      // Recovery: the handle answers again. Nothing reads the tab until the
      // user clicks its mark, which runs file.reconnect.
      await setLimit(cdp, "silentFor", 0);
      await cdp.eval("window.__restoreHangs()");
      assert.match(String(await cdp.eval(EDITOR_TEXT)), /File not available/, "nothing may read the tab before the click");
      await click(cdp, fileRow + " .buffer-warn");
      const back = await cdp.poll(EDITOR_TEXT, 5000, (v) => /silent\.txt on disk/.test(v ?? ""));
      assert.match(String(back), /silent\.txt on disk/, "after the click on the mark, the tab must show the file's text");
      assert.equal(await cdp.eval("window.__handleCalls.requestPermission"), 0, "the reconnect must need no requestPermission here");
    });
  });

  test("B2: a save on a handle that stops answering keeps the text in the row", async (t) => {
    await withBrowser(async (cdp) => {
      const id = await cdp.eval(`(async () => {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle("save.txt", { create: true });
        const w = await file.createWritable();
        await w.write("save.txt on disk\\n");
        await w.close();
        window.showOpenFilePicker = async () => [file];
        return (await window.vrtti.run("file.open"))?.id;
      })()`);
      assert.ok(id, "file.open must make a file note");
      const shown = await cdp.poll(
        `window.vrtti.activeId === "${id}" && document.querySelector("#editor-host .cm-content")?.innerText`,
        START_TIMEOUT_MS,
        (v) => typeof v === "string" && v.includes("save.txt on disk")
      );
      assert.match(String(shown), /save\.txt on disk/, "the file's text must be on screen");

      // The handle stops answering now, with no reload.
      await cdp.eval(`(() => {
        ${HANG_FN}
        installHangs({
          FileSystemHandle: ["queryPermission", "requestPermission"],
          FileSystemFileHandle: ["createWritable"],
        });
      })()`);
      // 1 s, so that a second query in the failure path would show as a
      // clear gap between the status and the row (below).
      t.diagnostic("LIMITS.query shortened: " + (await setLimit(cdp, "query", 1000)));
      await typeInEditor(cdp, "typed for a silent handle ");

      // In the page, so that the two times are close to exact.
      const seen = await cdp.eval(`(async () => {
        const idb = await import("./js/storage/idb.js");
        const el = document.getElementById("status-state");
        const t0 = performance.now();
        let statusAt = null;
        let row = null;
        while (performance.now() - t0 < 5000) {
          if (statusAt === null && el.textContent === "disk write failed") statusAt = performance.now();
          if (statusAt !== null) {
            const r = await idb.getBuffer("${id}");
            if (typeof r?.content === "string" && r.file?.unwritten === true) {
              row = { content: r.content, unwritten: r.file.unwritten, lagMs: Math.round(performance.now() - statusAt) };
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return { status: el.textContent, statusAt, row, calls: window.__handleCalls };
      })()`);
      t.diagnostic("seen: " + JSON.stringify(seen));
      assert.equal(seen.status, "disk write failed", "the save status must be 'disk write failed' within 5 s");
      assert.equal(seen.calls.requestPermission, 0, "the save must not call requestPermission");
      assert.ok(seen.row, "the row must hold the text and file.unwritten within 5 s");
      assert.match(String(seen.row.content), /typed for a silent handle/, "the row must hold the typed text");
      assert.equal(seen.row.unwritten, true, "the row must be marked file.unwritten");
      // failWrite() asks for the permission state once more before the row
      // is put. The memo answers that at once; a real query would wait 1 s.
      assert.ok(seen.row.lagMs < 500, `the row must follow the status at once, not after ${seen.row.lagMs} ms`);
    });
  });
});
