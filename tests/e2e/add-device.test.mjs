// End-to-end check of one story: add a new device to a server, and to a space,
// as a person does it. The steps click the real buttons of Settings and of the
// dialogs on two or three browser profiles (the old device and the new ones),
// against the real Vrtti.Server.
//
//   node --test tests/e2e/add-device.test.mjs
//
// It covers the invite dialog of the old device, the one dialog "Sync with a
// server" of the new device (a pasted invite and a typed code), the "Join"
// dialog with "New notes", the wait and its end on both devices, the texts in
// Settings while a join waits, and a space that a member adds later.
//
// Zero npm dependencies: plain Node + local Chromium via CDP + local dotnet.
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
    "/usr/bin/google-chrome-stable",
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-add-device-e2e-"));
  const dbPath = path.join(dataDir, "vrtti.db");
  const token = "add-device-e2e-token-2468";

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
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP error: " + String(e))));
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

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 15000) {
    const res = await Promise.race([
      this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("CDP eval timed out:\n" + expression.slice(0, 200))), timeoutMs),
      ),
    ]);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

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

async function launchDevice(chromePath, { width = 1280, height = 820, mobile = false } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-add-device-prof-"));
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
    { stdio: ["ignore", "pipe", "pipe"] },
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
  if (!page?.webSocketDebuggerUrl) throw new Error("No page target");

  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function setMetrics({ w, h, mob }) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: mob ? 3 : 1,
      mobile: mob,
    });
    await cdp.send(
      "Emulation.setTouchEmulationEnabled",
      mob ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    );
  }
  await setMetrics({ w: width, h: height, mob: mobile });

  return {
    cdp,
    setMetrics,
    async goto(url) {
      await cdp.send("Page.navigate", { url });
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
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
}

// ---- Helpers that click, as a person does ----------------------------------

/** The open dialog: its title, its texts, its fields and its buttons. */
const DIALOG = `(() => {
  const d = document.querySelector("dialog.vrtti-dialog[open]");
  if (!d) return null;
  const shown = (el) => !el.hidden && !el.closest("[hidden]");
  return {
    title: d.querySelector(".dialog-title")?.textContent ?? "",
    text: [...d.querySelectorAll("p, pre, .dialog-option span")].filter(shown).map((el) => el.textContent).join("\\n"),
    fields: [...d.querySelectorAll(".dialog-field")].filter(shown).map((f) => ({
      label: f.querySelector("span").textContent,
      value: f.querySelector("input").value,
    })),
    buttons: [...d.querySelectorAll("button")].map((b) => b.textContent),
  };
})()`;

/** @param {CdpClient} cdp @param {string} title */
async function waitDialog(cdp, title) {
  const expr = `(() => { const d = ${DIALOG}; return d && d.title === ${JSON.stringify(title)} ? d : null; })()`;
  try {
    return await cdp.waitFor(expr, 20000);
  } catch (err) {
    throw new Error(`no dialog "${title}"; the open dialog is ` + JSON.stringify(await cdp.eval(DIALOG)), { cause: err });
  }
}

/** Click the button of the open dialog whose text starts with `label`. */
async function clickInDialog(cdp, label) {
  const ok = await cdp.eval(`(() => {
    const d = document.querySelector("dialog.vrtti-dialog[open]");
    const b = [...(d?.querySelectorAll("button") ?? [])].find((el) => el.textContent.startsWith(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  assert.ok(ok, `the open dialog has no button "${label}": ` + JSON.stringify(await cdp.eval(DIALOG)));
}

/** Type into the field of the open dialog that has this label. */
async function typeInDialog(cdp, label, value) {
  const ok = await cdp.eval(`(() => {
    const d = document.querySelector("dialog.vrtti-dialog[open]");
    const f = [...(d?.querySelectorAll(".dialog-field") ?? [])].find((el) => el.querySelector("span").textContent === ${JSON.stringify(label)});
    if (!f) return false;
    const input = f.querySelector("input");
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert.ok(ok, `the open dialog has no field "${label}"`);
}

/** Open Settings and click the button with this data-key. */
async function clickSetting(cdp, key) {
  await cdp.eval(`window.vrtti.run("settings.open")`);
  await cdp.waitFor(`Boolean(document.querySelector('#settings-panel:not([hidden]) [data-key="${key}"]'))`);
  await cdp.eval(`(() => {
    const el = document.querySelector('#settings-panel [data-key="${key}"]');
    // .settings-button, not the first button: a row with a "more" text has
    // the "i" info button first, and that only shows the text.
    (el.matches("button") ? el : el.querySelector(".settings-button")).click();
  })()`);
}

/** The first device of the server, with two spaces. */
async function firstDevice(dev, staticUrl, sync, name) {
  await dev.goto(staticUrl);
  await dev.cdp.eval(`(async () => {
    await window.vrtti.keyring.setup({ deviceName: ${JSON.stringify(name)}, askPassphrase: false, firstDevice: true });
    await window.vrtti.sync.registerFirst(${JSON.stringify(sync.url)}, ${JSON.stringify(sync.token)});
    await window.vrtti.sync.createSpace("personal");
    await window.vrtti.sync.createSpace("work");
    await window.vrtti.sync.syncNow();
  })()`);
}

const chromePath = findChromium();
const dotnetReady = hasDotnet();

describe(
  "add a new device, through the buttons",
  { skip: (!chromePath && "no Chromium binary") || (!dotnetReady && "no dotnet SDK") },
  () => {
    let staticSrv;
    let syncSrv;
    let desktop;
    let phone;
    let laptop;

    before(async () => {
      staticSrv = await startStaticServer();
      syncSrv = await startSyncServer(staticSrv.origin);
      desktop = await launchDevice(chromePath);
      phone = await launchDevice(chromePath);
      laptop = await launchDevice(chromePath);
      await firstDevice(desktop, staticSrv.url, syncSrv, "Desktop");
    });

    after(async () => {
      for (const dev of [laptop, phone, desktop]) if (dev) await dev.close();
      if (syncSrv) await syncSrv.close();
      if (staticSrv) {
        staticSrv.server.closeAllConnections?.();
        await new Promise((r) => staticSrv.server.close(r));
      }
    });

    test("1. An invite made with the button joins a new device with one paste, and both devices say the result", async () => {
      const a = desktop.cdp;
      const b = phone.cdp;

      // The old device: Settings › Devices, "invite a device".
      await clickSetting(a, "device-invite");
      const ask = await waitDialog(a, "Invite a device");
      assert.deepEqual(ask.fields.map((f) => f.label), ["Name of the new device"]);
      await typeInDialog(a, "Name of the new device", "Phone");
      await clickInDialog(a, "Make invite");
      const shown = await waitDialog(a, "Invite for Phone");
      const invite = await a.eval(`document.querySelector("dialog[open] .dialog-secret").textContent`);
      assert.match(invite, /^vrtti-invite:[A-Za-z0-9_-]+$/);
      // The same invite for typing: the server and the code, each on a line of its own.
      const facts = await a.eval(`[...document.querySelectorAll("dialog[open] .dialog-fact")].map((p) => p.textContent)`);
      assert.equal(facts[0], "Server" + syncSrv.url);
      assert.match(facts[1], /^Code[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      assert.match(shown.text, /Paste it on the new device: Settings › Sync, “connect”\./);
      assert.match(shown.text, /Waiting for the new device\. Keep vrtti open on this device\. Works once, for \d+:\d\d more\./);
      assert.ok(shown.buttons.includes("Copy") && shown.buttons.includes("Done"));

      // The new device: Settings › Sync, "connect", one field.
      await phone.goto(staticSrv.url);
      await clickSetting(b, "sync-connect");
      const connect = await waitDialog(b, "Sync with a server");
      // No server field for an invite: the invite holds the server.
      assert.deepEqual(connect.fields.map((f) => f.label), ["Invite or code"]);
      assert.ok(connect.buttons.some((t) => t.startsWith("This is the first device of a server")));
      await typeInDialog(b, "Invite or code", '"' + invite + '"');
      assert.deepEqual((await b.eval(DIALOG)).fields.map((f) => f.label), ["Invite or code"]);
      await clickInDialog(b, "Next");

      // One dialog with each decision of the new device.
      const join = await waitDialog(b, "Join");
      assert.deepEqual(join.fields, [{ label: "Name of this device", value: "Phone" }]);
      assert.match(join.text, new RegExp("Server: " + syncSrv.url.replace(/[.]/g, "\\.")));
      const selects = await b.eval(`[...document.querySelectorAll("dialog[open] .dialog-space")].map((row) => ({
        name: row.querySelector("span").textContent,
        value: row.querySelector("select").value,
        options: [...row.querySelectorAll("option")].map((o) => o.textContent),
      }))`);
      assert.deepEqual(selects, [
        { name: "personal", value: "list", options: ["Titles only", "Open as tabs"] },
        { name: "work", value: "list", options: ["Titles only", "Open as tabs"] },
        // "New notes" starts with Local only, whatever the old device uses.
        { name: "New notes", value: "", options: ["Local only", "personal", "work"] },
      ]);
      await b.eval(`(() => {
        const rows = [...document.querySelectorAll("dialog[open] .dialog-space")];
        rows[2].querySelector("select").value = "personal";
      })()`);
      await clickInDialog(b, "Join");
      await waitDialog(b, "Passphrase");
      await clickInDialog(b, "No passphrase");

      // The wait is one dialog that ends with the result. The invite dialog
      // of the old device is open, so the old device answers in seconds.
      const done = await waitDialog(b, "Joined");
      assert.match(done.text, /This device is on the server\./);
      assert.match(done.text, /Desktop let it in\./);
      assert.match(done.text, /This device is in “personal” and “work”\. The notes arrive now\./);
      assert.match(done.text, /New notes of this device go to “personal”\./);
      assert.deepEqual(done.buttons, ["OK"]);
      await clickInDialog(b, "OK");

      // The old device says it in the invite dialog, with the name of the new device.
      await a.waitFor(
        `document.querySelector("dialog[open] .dialog-live")?.textContent === "Phone joined. It gets “personal” and “work”."`,
        20000,
      );
      assert.ok(await a.eval(`document.querySelector("dialog[open] .dialog-live").classList.contains("dialog-ok")`));
      await clickInDialog(a, "Done");

      // What the join set on the new device.
      await b.waitFor(`window.vrtti.sync.mySpaces().length === 2`, 20000);
      const state = await b.eval(`({
        spaces: window.vrtti.sync.mySpaces().sort(),
        modes: [window.vrtti.sync.modeOf("personal"), window.vrtti.sync.modeOf("work")],
        newNotes: window.vrtti.sync.defaultSpace(),
        joining: window.vrtti.sync.isJoining,
      })`);
      assert.deepEqual(state, { spaces: ["personal", "work"], modes: ["list", "list"], newNotes: "personal", joining: false });
    });

    test("2. A typed code asks for the server, a wrong code keeps the dialog, and the wait shows in Settings", async () => {
      const a = desktop.cdp;
      const c = laptop.cdp;
      const code = await a.eval(`window.vrtti.sync.invite(["personal"])`);

      await laptop.goto(staticSrv.url);
      // The way in from Settings › Security opens the same dialog.
      await clickSetting(c, "device-setup");
      const setup = await waitDialog(c, "Set up this device");
      assert.deepEqual(setup.fields.map((f) => f.label), ["Invite or code"]);
      assert.ok(setup.buttons.some((t) => t.startsWith("This is my first device")));

      // A code does not say where the server is: the field shows.
      await typeInDialog(c, "Invite or code", "ZZZZZ-ZZZZZ");
      assert.deepEqual((await c.eval(DIALOG)).fields.map((f) => f.label), ["Invite or code", "Server URL"]);
      await clickInDialog(c, "Next");
      assert.match((await waitDialog(c, "Set up this device")).text, /Type the server URL\./);
      await typeInDialog(c, "Invite or code", "not a code");
      await clickInDialog(c, "Next");
      assert.match((await c.eval(DIALOG)).text, /That is not an invite and not a code\./);

      // A code that the server does not know: the dialog comes back with
      // the reason and with what was typed.
      await typeInDialog(c, "Invite or code", "ZZZZZ-ZZZZZ");
      await typeInDialog(c, "Server URL", syncSrv.url);
      await clickInDialog(c, "Next");
      const join = await waitDialog(c, "Join");
      assert.deepEqual(join.fields, [{ label: "Name of this device", value: "Desktop" }]);
      assert.match(join.text, /A code does not say which spaces this device gets\./);
      await typeInDialog(c, "Name of this device", "Laptop");
      await clickInDialog(c, "Join");
      await waitDialog(c, "Passphrase");
      await clickInDialog(c, "No passphrase");
      const again = await waitDialog(c, "Set up this device");
      assert.match(again.text, /The server does not know this code\./);
      assert.deepEqual(again.fields, [
        { label: "Invite or code", value: "ZZZZZ-ZZZZZ" },
        { label: "Server URL", value: syncSrv.url },
      ]);

      // The real code. The device has its keys now, so no name field.
      await typeInDialog(c, "Invite or code", code.toLowerCase());
      await clickInDialog(c, "Next");
      assert.deepEqual((await waitDialog(c, "Join")).fields, []);
      await clickInDialog(c, "Join");

      // The old device has no dialog open and did not sync yet: the new
      // device waits, and says so in the dialog and in Settings.
      const waiting = await waitDialog(c, "Joining");
      assert.match(waiting.text, /This device is on the server\./);
      assert.match(waiting.text, /Waiting for your other device to let it in\./);
      assert.deepEqual(waiting.buttons, ["Close"]);
      const rows = await c.eval(`(() => {
        const panel = document.getElementById("settings-panel");
        const shown = (key) => { const el = panel.querySelector('[data-key="' + key + '"]'); return Boolean(el && !el.hidden); };
        return {
          empty: panel.querySelector('[data-key="sync-spaces"] .settings-list-empty')?.textContent ?? "",
          joining: shown("device-joining"),
          noSpaces: shown("device-no-spaces"),
        };
      })()`);
      assert.match(rows.empty, /^This device waits for your other device to let it in\./);
      assert.deepEqual([rows.joining, rows.noSpaces], [true, false]);

      // The old device syncs: its status bar says who joined.
      await a.eval(`window.vrtti.sync.syncNow()`);
      await a.waitFor(`document.getElementById("status-state").textContent === "Laptop joined. It gets “personal”."`, 20000);
      const done = await waitDialog(c, "Joined");
      assert.match(done.text, /Desktop let it in\./);
      assert.match(done.text, /This device is in “personal”\. The notes arrive now\./);
      assert.match(done.text, /New notes stay on this device\. Settings › Spaces changes that\./);
      await clickInDialog(c, "OK");

      // A join with a code lists the notes as titles, as an invite does.
      await c.waitFor(`window.vrtti.sync.mySpaces().length === 1`, 20000);
      assert.equal(await c.eval(`window.vrtti.sync.modeOf("personal")`), "list");
      assert.equal(await c.eval(`window.vrtti.sync.defaultSpace()`), null);
    });

    test("3. A tick in Space access says what it does, and the other device says who added it", async () => {
      const a = desktop.cdp;
      const b = phone.cdp;
      await a.eval(`(async () => {
        await window.vrtti.sync.createSpace("recipes");
        await window.vrtti.sync.syncNow();
      })()`);
      await a.eval(`window.vrtti.run("settings.open")`);
      const cell = `[...document.querySelectorAll("#settings-panel .settings-grid-cell")].find((el) => el.getAttribute("aria-label") === "Add Phone to recipes")`;
      await a.waitFor(`Boolean(${cell})`, 20000);
      await a.eval(`${cell}.click()`);
      await a.waitFor(
        `document.querySelector("#settings-panel .settings-grid-note")?.textContent === "Phone gets “recipes” at its next sync."`,
      );

      await b.eval(`window.vrtti.sync.syncNow()`);
      await b.waitFor(
        `document.getElementById("status-state").textContent === "Desktop added this device to “recipes”. Its notes show as titles."`,
        20000,
      );
      assert.equal(await b.eval(`window.vrtti.sync.modeOf("recipes")`), "list");

      // Away again: the other device says that too.
      await a.eval(`${cell.replace("Add Phone to", "Remove Phone from")}.click()`);
      await waitDialog(a, "Remove “Phone” from “recipes”?");
      await clickInDialog(a, "Remove");
      await a.waitFor(
        `document.querySelector("#settings-panel .settings-grid-note")?.textContent === "Phone gets no more notes of “recipes”."`,
      );
      await b.eval(`window.vrtti.sync.syncNow()`);
      await b.waitFor(
        `document.getElementById("status-state").textContent === "This device is out of “recipes”. Its notes are in the trash here."`,
        20000,
      );
    });

    test("4. A device that stopped syncing comes back with one click, with no join", async () => {
      const c = laptop.cdp;
      const before = await c.eval(`({ spaces: window.vrtti.sync.mySpaces(), url: window.vrtti.sync.config.url })`);
      assert.deepEqual(before, { spaces: ["personal"], url: syncSrv.url });

      await clickSetting(c, "sync-disconnect");
      const stop = await waitDialog(c, "Stop syncing this device?");
      assert.match(stop.text, /“connect” in Settings › Sync starts it again\./);
      await clickInDialog(c, "Stop");
      await c.waitFor(`!window.vrtti.sync.isConfigured`);

      // The same dialog as for a new device, with one more option. A new
      // join would fail here: the server knows this device.
      await clickSetting(c, "sync-connect");
      const connect = await waitDialog(c, "Sync with a server");
      assert.ok(connect.buttons.includes("Sync again with " + syncSrv.url + "This device synced with this server before. It needs no invite."));
      await clickInDialog(c, "Sync again with");
      await c.waitFor(`window.vrtti.sync.isConfigured && !document.querySelector("dialog[open]")`);

      // The old token works, and the device is in its space as before.
      const result = await c.eval(`(async () => {
        const test = await window.vrtti.sync.testConnection();
        return { ok: test.ok, spaces: window.vrtti.sync.mySpaces(), stopped: await window.vrtti.sync.stoppedServer() };
      })()`);
      assert.deepEqual(result, { ok: true, spaces: ["personal"], stopped: "" });
      // The option is only for a device that stopped.
      await c.eval(`window.vrtti.run("settings.close")`);
      await phone.cdp.eval(`window.vrtti.sync.stoppedServer()`).then((url) => assert.equal(url, ""));
    });
  },
);
