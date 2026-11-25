// End-to-end browser verification for the reorganized Settings panel across
// local-only, synced-empty, synced multi-space/multi-device desktop, and phone
// layouts against the real Vrtti.Server and headless Chromium.
//
//   node --test tests/e2e/settings-layout.test.mjs
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-settings-e2e-"));
  const dbPath = path.join(dataDir, "vrtti.db");
  const token = "settings-e2e-token-5678";

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-settings-prof-"));
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

const chromePath = findChromium();
const dotnetReady = hasDotnet();

describe(
  "reorganized Settings layout E2E",
  { skip: (!chromePath && "no Chromium binary") || (!dotnetReady && "no dotnet SDK") },
  () => {
    let staticSrv;
    let syncSrv;
    let devA;
    let devB;

    before(async () => {
      staticSrv = await startStaticServer();
      syncSrv = await startSyncServer(staticSrv.origin);
      devA = await launchDevice(chromePath, { width: 1280, height: 820, mobile: false });
      devB = await launchDevice(chromePath, { width: 1280, height: 820, mobile: false });
    });

    after(async () => {
      if (devB) await devB.close();
      if (devA) await devA.close();
      if (syncSrv) await syncSrv.close();
      if (staticSrv) {
        staticSrv.server.closeAllConnections?.();
        await new Promise((r) => staticSrv.server.close(r));
      }
    });

    test("1. Local-only state hides Spaces and Devices, shows clean rail dividers and App credits", async () => {
      const { cdp } = devA;
      await devA.goto(staticSrv.url);

      const info = await cdp.eval(`(async () => {
        await window.vrtti.run("settings.open");
        await new Promise((r) => setTimeout(r, 40));
        const panel = document.getElementById("settings-panel");
        const visibleSections = [...panel.querySelectorAll(".settings-section")]
          .filter((s) => !s.hidden)
          .map((s) => s.querySelector("h3").textContent);
        const visibleRail = [...panel.querySelectorAll(".settings-rail-item")]
          .filter((b) => !b.hidden)
          .map((b) => b.firstChild.textContent.trim());
        const visibleGaps = [...panel.querySelectorAll(".settings-rail-gap")].filter((g) => !g.hidden).length;
        const syncKeys = [...panel.querySelectorAll('[data-section="sync"] .settings-row')]
          .filter((r) => !r.hidden)
          .map((r) => r.dataset.key);
        const secKeys = [...panel.querySelectorAll('[data-section="security"] .settings-row')]
          .filter((r) => !r.hidden)
          .map((r) => r.dataset.key);
        const appText = panel.querySelector('[data-section="app"]').textContent;
        return { visibleSections, visibleRail, visibleGaps, syncKeys, secKeys, hasTwemoji: /Twemoji/.test(appText) };
      })()`);

      assert.deepEqual(info.visibleSections, ["Appearance", "Editor", "Sync", "Security", "Storage", "App"]);
      assert.deepEqual(info.visibleRail, ["Appearance", "Editor", "Sync", "Security", "Storage", "App"]);
      assert.equal(info.visibleGaps, 2, "must draw exactly two group dividers (Editor|Sync and Security|Storage)");
      assert.deepEqual(info.syncKeys, ["sync-url", "sync-connect"]);
      assert.deepEqual(info.secKeys, ["device-setup"]);
      assert.equal(info.hasTwemoji, true, "CC-BY 4.0 Twemoji attribution must stay visible in App");
    });

    test("2. Synced with 0 spaces shows Spaces empty state, single-row New notes select, and collapsed Keys", async () => {
      const { cdp } = devA;
      await cdp.eval(`(async () => {
        await window.vrtti.keyring.setup({
          deviceName: "Laptop",
          askPassphrase: false,
          firstDevice: true,
        });
        await window.vrtti.sync.registerFirst(${JSON.stringify(syncSrv.url)}, ${JSON.stringify(syncSrv.token)});
        await window.vrtti.sync.syncNow();
      })()`);

      const info = await cdp.eval(`(async () => {
        await new Promise((r) => setTimeout(r, 60));
        const panel = document.getElementById("settings-panel");
        const visibleSections = [...panel.querySelectorAll(".settings-section")]
          .filter((s) => !s.hidden)
          .map((s) => s.querySelector("h3").textContent);
        const spacesEmpty = panel.querySelector('[data-key="sync-spaces"] .settings-list-empty')?.textContent ?? "";
        const hasNewSpaceBtn = Boolean(panel.querySelector('[data-section="spaces"] [data-key="space-create"]'));
        const newNotesRow = panel.querySelector('[data-key="sync-new-notes"]');
        const newNotesListChildren = newNotesRow.querySelectorAll(".settings-list-row").length;
        const newNotesSelect = newNotesRow.querySelector("select.settings-select");
        const deviceNoSpaces = !panel.querySelector('[data-key="device-no-spaces"]').hidden;
        const keysDetails = panel.querySelector('[data-key="security-keys"] details');
        const keyBlocks = [...keysDetails.querySelectorAll(".settings-key-box")].map((b) => b.dataset.key);
        return {
          visibleSections,
          spacesEmpty,
          hasNewSpaceBtn,
          newNotesListChildren,
          newNotesVal: newNotesSelect?.value ?? null,
          deviceNoSpaces,
          keysOpen: keysDetails.open,
          keyBlocks,
        };
      })()`);

      assert.deepEqual(info.visibleSections, [
        "Appearance",
        "Editor",
        "Sync",
        "Spaces",
        "Devices",
        "Security",
        "Storage",
        "App",
      ]);
      assert.match(info.spacesEmpty, /No spaces yet/);
      assert.equal(info.hasNewSpaceBtn, true);
      assert.equal(info.newNotesListChildren, 0, "New notes must be a single select row, not a nested list");
      assert.equal(info.newNotesVal, "");
      assert.equal(info.deviceNoSpaces, true);
      assert.equal(info.keysOpen, false, "Security keys disclosure must start collapsed");
      assert.deepEqual(info.keyBlocks, ["device-key", "recovery-key"]);
    });

    test("3. Synced multi-space and multi-device layout unifies Spaces, focuses Sync/Devices, and preserves open Keys", async () => {
      const { cdp: cdpA } = devA;
      const { cdp: cdpB } = devB;
      await devB.goto(staticSrv.url);

      // Create two spaces on Laptop and join Phone as a second device.
      await cdpA.eval(`(async () => {
        await window.vrtti.sync.createSpace("personal");
        await window.vrtti.sync.createSpace("work");
        await window.vrtti.sync.setSpaceMode("personal", "tab");
        await window.vrtti.sync.setSpaceMode("work", "list");
        await window.vrtti.sync.setNewNotes("personal");
        await window.vrtti.sync.syncNow();
      })()`);

      const code = await cdpA.eval(`window.vrtti.sync.invite(["personal", "work"])`);
      await cdpB.eval(`(async () => {
        await window.vrtti.keyring.setup({ deviceName: "Phone", askPassphrase: false, firstDevice: false });
        await window.vrtti.sync.redeem(${JSON.stringify(syncSrv.url)}, ${JSON.stringify(code)}, { personal: "tab", work: "list" });
      })()`);
      await cdpA.eval(`window.vrtti.sync.syncNow()`);
      await cdpB.eval(`window.vrtti.sync.syncNow()`);
      await cdpA.eval(`window.vrtti.sync.syncNow()`);

      const state = await cdpA.eval(`(async () => {
        await new Promise((r) => setTimeout(r, 80));
        const panel = document.getElementById("settings-panel");

        // Sync section must only contain server, status (+ inline sync/test), and danger disconnect.
        const syncKeys = [...panel.querySelectorAll('[data-section="sync"] .settings-row')]
          .filter((r) => !r.hidden)
          .map((r) => r.dataset.key);
        const hasInlineSyncNow = Boolean(panel.querySelector('[data-key="sync-status"] [data-key="sync-run"]'));
        const hasInlineTest = Boolean(panel.querySelector('[data-key="sync-status"] [data-key="sync-test"]'));
        const disconnectDanger = panel
          .querySelector('[data-key="sync-disconnect"] button')
          .classList.contains("settings-button-danger");

        // Spaces section: single list (no separate backup list).
        const spaceRows = [...panel.querySelectorAll('[data-key="sync-spaces"] .settings-list-row')];
        const spaceNames = spaceRows.map((r) => r.dataset.key);
        const hasBackupRow = Boolean(panel.querySelector('[data-key="sync-backup"]'));

        // Click personal color swatch in Spaces and confirm Devices grid column updates to match.
        const personalSwatch = panel.querySelector('[data-key="space-personal"] .settings-swatch-button .space-swatch');
        const beforeColor = personalSwatch.style.getPropertyValue("--space-color");
        panel.querySelector('[data-key="space-personal"] .settings-swatch-button').click();
        await new Promise((r) => setTimeout(r, 120));
        const afterSpaceColor = panel
          .querySelector('[data-key="space-personal"] .settings-swatch-button .space-swatch')
          .style.getPropertyValue("--space-color");
        const gridPersonalColor = [...panel.querySelectorAll('[data-key="device-grid"] .settings-grid-head')]
          .find((b) => b.textContent.includes("personal"))
          .querySelector(".space-swatch")
          .style.getPropertyValue("--space-color");

        // Devices grid rows & "this device" tag.
        const gridDevices = [...panel.querySelectorAll('[data-key="device-grid"] tbody th')].map((th) => ({
          text: th.textContent.trim(),
          hasMeTag: Boolean(th.querySelector(".settings-me-tag")),
        }));

        // Expand Security › Keys and verify a live sync repaint does not collapse it.
        const keysDetails = panel.querySelector('[data-key="security-keys"] details');
        keysDetails.open = true;
        await window.vrtti.sync.syncNow();
        await new Promise((r) => setTimeout(r, 60));
        const keysStillOpen = keysDetails.open;
        const deviceKeyText = panel.querySelector('[data-key="device-key"] .settings-key-code').textContent;

        return {
          syncKeys,
          hasInlineSyncNow,
          hasInlineTest,
          disconnectDanger,
          spaceNames,
          hasBackupRow,
          beforeColor,
          afterSpaceColor,
          gridPersonalColor,
          gridDevices,
          keysStillOpen,
          deviceKeyStartsAge: deviceKeyText.startsWith("age1"),
        };
      })()`);

      assert.deepEqual(state.syncKeys, ["sync-url", "sync-status", "sync-disconnect"]);
      assert.equal(state.hasInlineSyncNow, true);
      assert.equal(state.hasInlineTest, true);
      assert.equal(state.disconnectDanger, true);
      assert.deepEqual(state.spaceNames, ["space-personal", "space-work"]);
      assert.equal(state.hasBackupRow, false, "duplicate Back up to a folder list must be removed");
      assert.notEqual(state.afterSpaceColor, state.beforeColor, "clicking space swatch must cycle its color");
      assert.equal(state.gridPersonalColor, state.afterSpaceColor, "Devices grid color must match Spaces swatch");
      assert.equal(state.gridDevices.length, 2);
      assert.equal(state.gridDevices[0].hasMeTag, true);
      assert.equal(state.keysStillOpen, true, "live sync repaint must not collapse open Keys disclosure");
      assert.equal(state.deviceKeyStartsAge, true);
    });

    test("4. Phone layout folds rail into sticky jump strip, keeps sticky grid column, and shows phone rows", async () => {
      const { cdp } = devA;
      await devA.setMetrics({ w: 390, h: 844, mob: true });
      // Wait for matchMedia("(max-width: 700px) and (pointer: coarse)") to apply html.phone.
      await cdp.waitFor('document.documentElement.classList.contains("phone")');

      const phone = await cdp.eval(`(async () => {
        await window.vrtti.run("settings.open");
        await new Promise((r) => setTimeout(r, 60));
        const panel = document.getElementById("settings-panel");
        const railDisplay = getComputedStyle(panel.querySelector(".settings-rail")).display;
        const jumpDisplay = getComputedStyle(panel.querySelector(".settings-jump")).display;
        const jumpLabels = [...panel.querySelectorAll(".settings-jump-pill")]
          .filter((b) => !b.hidden)
          .map((b) => b.textContent);

        // Tap Devices jump pill and confirm scroll + active pill update.
        const devicesPill = [...panel.querySelectorAll(".settings-jump-pill")].find(
          (b) => b.textContent === "Devices"
        );
        devicesPill.click();
        await new Promise((r) => setTimeout(r, 80));
        const scrolledTop = panel.scrollTop;
        const devicesCurrent = devicesPill.getAttribute("aria-current");
        const gridThPos = getComputedStyle(panel.querySelector('[data-key="device-grid"] tbody th')).position;
        const listRowsDisplay = getComputedStyle(panel.querySelector('[data-key="list-rows"]')).display;
        const sidebarNewDisplay = getComputedStyle(panel.querySelector('[data-key="sidebar-new"]')).display;

        // Verify every visible hint stays within 2 lines on a phone screen,
        // and that the (i) info button toggles extra details without overflow
        // or collapsing on live sync repaints.
        const longHints = [];
        for (const hint of panel.querySelectorAll(".settings-hint")) {
          if (hint.closest("[hidden], details:not([open])")) continue;
          const r = hint.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const lh = parseFloat(getComputedStyle(hint).lineHeight) || 18;
          const lines = Math.round(r.height / lh);
          if (lines > 2) {
            longHints.push({
              key: hint.closest("[data-key]")?.dataset.key ?? "",
              lines,
              text: hint.textContent,
            });
          }
        }
        const spellRow = panel.querySelector('[data-key="spellcheck"]');
        const infoBtn = spellRow.querySelector(".settings-info-btn");
        const moreEl = spellRow.querySelector(".settings-more");
        const moreInitiallyHidden = moreEl.hidden;
        infoBtn.click();
        const moreOpenAfterClick = !moreEl.hidden && infoBtn.getAttribute("aria-expanded") === "true";
        await window.vrtti.sync.syncNow();
        await new Promise((r) => setTimeout(r, 60));
        const moreStillOpenAfterSync = !moreEl.hidden;
        infoBtn.click();
        const moreClosedAfterSecondClick = moreEl.hidden && infoBtn.getAttribute("aria-expanded") === "false";

        // Verify zero horizontal overflow on the panel itself (including with
        // a long sync status string, open Keys, and an open (i) disclosure).
        infoBtn.click();
        const statusVal = panel.querySelector('[data-key="sync-status"] .settings-value');
        statusVal.textContent = "synced · last sync 11:28:15 PM · test: connected";
        panel.querySelector('[data-key="security-keys"] details').open = true;
        const pr = panel.getBoundingClientRect();
        const offenders = [];
        for (const el of panel.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const scroller = el.closest(".settings-jump, .settings-grid-wrap");
          if (scroller && scroller !== el) continue;
          if (r.right > pr.right + 0.5 || r.left < pr.left - 0.5) {
            offenders.push(el.className || el.tagName);
          }
        }
        return {
          railDisplay,
          jumpDisplay,
          jumpLabels,
          scrolledTop,
          devicesCurrent,
          gridThPos,
          listRowsDisplay,
          sidebarNewDisplay,
          longHints,
          moreInitiallyHidden,
          moreOpenAfterClick,
          moreStillOpenAfterSync,
          moreClosedAfterSecondClick,
          panelCW: panel.clientWidth,
          panelSW: panel.scrollWidth,
          offenders,
        };
      })()`);

      assert.equal(phone.railDisplay, "none");
      assert.equal(phone.jumpDisplay, "flex");
      assert.deepEqual(phone.jumpLabels, [
        "Appearance",
        "Editor",
        "Sync",
        "Spaces",
        "Devices",
        "Security",
        "Storage",
        "App",
      ]);
      assert.ok(phone.scrolledTop > 0, "tapping Devices jump pill must scroll the panel");
      assert.equal(phone.devicesCurrent, "true");
      assert.equal(phone.gridThPos, "sticky");
      assert.equal(phone.listRowsDisplay, "flex");
      assert.equal(phone.sidebarNewDisplay, "none");
      assert.deepEqual(phone.longHints, [], "every visible hint on a phone must fit in at most 2 lines");
      assert.equal(phone.moreInitiallyHidden, true);
      assert.equal(phone.moreOpenAfterClick, true);
      assert.equal(phone.moreStillOpenAfterSync, true);
      assert.equal(phone.moreClosedAfterSecondClick, true);
      assert.equal(phone.panelSW, phone.panelCW, "phone settings panel must not scroll horizontally");
      assert.deepEqual(phone.offenders, [], "no non-scroller element may extend outside the phone settings panel");
    });
  },
);
