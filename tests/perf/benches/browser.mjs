// Browser performance benchmarks over local Chromium CDP (B1, B2, B3, B4, B5, B7).
// Zero npm dependencies: plain Node 22 + local Chromium + local Vrtti.Server (for B7).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasDotnet,
  hasPython3,
  launchBrowser,
  medianObjects,
  startStaticServer,
  startSyncServer,
} from "../lib/env.mjs";
import {
  makeCzechWords,
  makeEnglishProse,
  makeLogText,
  makeMarkdownTable,
  makeProseText,
  seedVaultInPage,
} from "../lib/fixtures.mjs";

const LONG_TASK_HOOK = `
  (() => {
    window.__perfLongTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__perfLongTasks.push({
              start: +e.startTime.toFixed(1),
              duration: +e.duration.toFixed(1),
            });
          }
        });
        obs.observe({ type: "longtask", buffered: true });
      } catch {}
    }
  })();
`;

/** Helper injected in eval: type N chars via CM6 dispatch and collect timings + dropped frames. */
function typeDispatchScript(count, posExpr = "0") {
  return `(async () => {
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const ltBefore = (window.__perfLongTasks ?? []).length;
    const dispatches = [];
    let droppedFrames = 0;

    for (let i = 0; i < ${count}; i++) {
      const pos = Math.min(${posExpr}, view.state.doc.length);
      const t0 = performance.now();
      view.dispatch({ changes: { from: pos, insert: "x" } });
      dispatches.push(performance.now() - t0);
      // Measure a single frame turn after the dispatch to detect dropped frames (>25 ms at 60 Hz).
      const f0 = performance.now();
      await new Promise((r) => requestAnimationFrame(r));
      const frameDelta = performance.now() - f0;
      if (frameDelta > 25) droppedFrames++;
    }
    const lt = (window.__perfLongTasks ?? []).slice(ltBefore);
    const sorted = [...dispatches].sort((a, b) => a - b);
    const p = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2);
    const longTasksTotalMs = +lt.reduce((s, e) => s + e.duration, 0).toFixed(1);
    return {
      dispatchP50Ms: p(0.5),
      dispatchP95Ms: p(0.95),
      longTasksCount: lt.length,
      longTasksTotalMs,
      droppedFrames,
    };
  })()`;
}

// ---------------------------------------------------------------------------
// B1: Big files (1 MB log, 5 MB log no blank lines, 5 MB prose with blank lines)
// ---------------------------------------------------------------------------
async function runB1Case(chromePath, srvUrl, { text, mobile = false, cpuThrottle = 1, runs = 5, onChromeVersion }) {
  const trialRuns = [];
  const browser = await launchBrowser(chromePath, {
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 800,
    mobile,
    cpuThrottle,
  });
  onChromeVersion?.(browser.chromiumVersion);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG_TASK_HOOK });
    await browser.goto(srvUrl);
    await browser.cdp.eval(`window.__b1Text = ${JSON.stringify(text)};`);

    for (let r = 0; r < runs; r++) {
      // Seed via store + evict so activateBuffer measures genuine fresh EditorState creation + open.
      const openMs = await browser.cdp.eval(`(async () => {
        const rec = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(rec.id, window.__b1Text);
        const dummy = await window.vrtti.createBuffer();
        window.vrtti.store.events.dispatchEvent(new CustomEvent("evict", { detail: { id: rec.id } }));
        window.__b1RecId = rec.id;
        window.__b1DummyId = dummy.id;
        const t0 = performance.now();
        await window.vrtti.activateBuffer(rec.id);
        await new Promise((res) => requestAnimationFrame(res));
        return +(performance.now() - t0).toFixed(1);
      })()`);

      const typing = await browser.cdp.eval(typeDispatchScript(50, "0"));
      await browser.cdp.eval(`(async () => {
        await window.vrtti.closeBuffer(window.__b1RecId);
        await window.vrtti.closeBuffer(window.__b1DummyId);
      })()`);

      trialRuns.push({ openMs, ...typing });
    }
  } finally {
    await browser.close();
  }
  return medianObjects(trialRuns);
}

export async function runB1({ runs = 5, phone = true, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  const srv = await startStaticServer();
  const log1MB = makeLogText(1024 * 1024);
  const log5MB = makeLogText(5 * 1024 * 1024);
  const prose5MB = makeProseText(5 * 1024 * 1024);
  try {
    const out = {
      desktop_1MB_log: await runB1Case(chromePath, srv.url, { text: log1MB, runs, onChromeVersion }),
      desktop_5MB_log: await runB1Case(chromePath, srv.url, { text: log5MB, runs, onChromeVersion }),
      desktop_5MB_prose: await runB1Case(chromePath, srv.url, { text: prose5MB, runs, onChromeVersion }),
    };
    if (phone) {
      out.phone4x_1MB_log = await runB1Case(chromePath, srv.url, {
        text: log1MB,
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
    }
    return out;
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// B2: 5,000-note vault (200 open, 2,500 Recent, 1k closed synced, 1k stubs, 300 trash)
// ---------------------------------------------------------------------------
async function runB2Platform(chromePath, srvUrl, { mobile = false, cpuThrottle = 1, runs = 5, onChromeVersion }) {
  const browser = await launchBrowser(chromePath, {
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 800,
    mobile,
    cpuThrottle: 1,
  });
  onChromeVersion?.(browser.chromiumVersion);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG_TASK_HOOK });
    await browser.goto(srvUrl);
    await seedVaultInPage(browser.cdp, {
      openCount: 200,
      recentCount: 2500,
      closedSyncedCount: 1000,
      stubCount: 1000,
      trashCount: 300,
      noteSizeBytes: 4096,
    });
    if (cpuThrottle > 1) await browser.setCpuThrottle(cpuThrottle);
    await browser.reload();

    const trialRuns = [];
    for (let r = 0; r < runs; r++) {
      const closed = await browser.cdp.eval(typeDispatchScript(50, "0"));

      let drawerOpenMs = 0;
      let withDrawer = null;
      let domNodes = 0;

      if (!mobile) {
        drawerOpenMs = await browser.cdp.eval(`(async () => {
          const t0 = performance.now();
          document.getElementById("bar-recent").click();
          await new Promise((res) => requestAnimationFrame(res));
          return +(performance.now() - t0).toFixed(1);
        })()`);
        domNodes = (await browser.heapAndNodes()).domNodes;
        withDrawer = await browser.cdp.eval(typeDispatchScript(50, "0"));
        await browser.cdp.eval(`document.getElementById("drawer-close").click();`);
      } else {
        // On phone layout, switch back to note list to open the full-screen Recent view.
        drawerOpenMs = await browser.cdp.eval(`(async () => {
          const back = document.getElementById("phone-back");
          if (back && back.offsetParent !== null) back.click();
          await new Promise((res) => requestAnimationFrame(res));
          const t0 = performance.now();
          document.getElementById("bar-recent").click();
          await new Promise((res) => requestAnimationFrame(res));
          return +(performance.now() - t0).toFixed(1);
        })()`);
        domNodes = (await browser.heapAndNodes()).domNodes;
        await browser.cdp.eval(`(async () => {
          document.getElementById("phone-view-back")?.click();
          await new Promise((res) => requestAnimationFrame(res));
          document.querySelector("#open-list li")?.click();
          await new Promise((res) => requestAnimationFrame(res));
        })()`);
      }

      trialRuns.push({
        dispatchClosedP50Ms: closed.dispatchP50Ms,
        dispatchClosedP95Ms: closed.dispatchP95Ms,
        drawerOpenMs,
        ...(withDrawer
          ? {
              dispatchDrawerP50Ms: withDrawer.dispatchP50Ms,
              dispatchDrawerP95Ms: withDrawer.dispatchP95Ms,
              drawerLongTasksTotalMs: withDrawer.longTasksTotalMs,
            }
          : {}),
        domNodes,
      });
    }
    return medianObjects(trialRuns);
  } finally {
    await browser.close();
  }
}

export async function runB2({ runs = 5, phone = true, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  const srv = await startStaticServer();
  try {
    const out = {
      desktop: await runB2Platform(chromePath, srv.url, { runs, onChromeVersion }),
    };
    if (phone) {
      out.phone4x = await runB2Platform(chromePath, srv.url, {
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
    }
    return out;
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// B3: Markdown tables (1,000 and 3,000 rows: 50-key type + scroll dropped frames)
// ---------------------------------------------------------------------------
async function runB3Case(chromePath, srvUrl, { rowCount, mobile = false, cpuThrottle = 1, runs = 5, onChromeVersion }) {
  const md = makeMarkdownTable(rowCount);
  const editPos = md.indexOf("Row 3");
  const browser = await launchBrowser(chromePath, {
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 800,
    mobile,
    cpuThrottle,
  });
  onChromeVersion?.(browser.chromiumVersion);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG_TASK_HOOK });
    await browser.goto(srvUrl);
    await browser.cdp.eval(`(async () => {
      const { EditorView } = await import("@codemirror/view");
      const rec = await window.vrtti.createBuffer();
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(md)} } });
      await window.vrtti.setSyntax("markdown");
      await new Promise((r) => requestAnimationFrame(r));
    })()`);

    const trialRuns = [];
    for (let r = 0; r < runs; r++) {
      const typing = await browser.cdp.eval(typeDispatchScript(50, String(editPos)));
      const scroll = await browser.cdp.eval(`(async () => {
        const scroller = document.querySelector(".cm-scroller");
        scroller.scrollTop = 0;
        await new Promise((res) => requestAnimationFrame(res));
        let dropped = 0;
        const steps = 25;
        let last = performance.now();
        for (let i = 1; i <= steps; i++) {
          scroller.scrollTop = i * 400;
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          if (now - last > 25) dropped++;
          last = now;
        }
        scroller.scrollTop = 0;
        await new Promise((res) => requestAnimationFrame(res));
        return { scrollDroppedFrames: dropped, scrollTotalFrames: steps };
      })()`);
      trialRuns.push({
        dispatchP50Ms: typing.dispatchP50Ms,
        dispatchP95Ms: typing.dispatchP95Ms,
        longTasksTotalMs: typing.longTasksTotalMs,
        ...scroll,
      });
    }
    return medianObjects(trialRuns);
  } finally {
    await browser.close();
  }
}

export async function runB3({ runs = 5, phone = true, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  const srv = await startStaticServer();
  try {
    const out = {
      desktop_1000_rows: await runB3Case(chromePath, srv.url, { rowCount: 1000, runs, onChromeVersion }),
      desktop_3000_rows: await runB3Case(chromePath, srv.url, { rowCount: 3000, runs, onChromeVersion }),
    };
    if (phone) {
      out.phone4x_1000_rows = await runB3Case(chromePath, srv.url, {
        rowCount: 1000,
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
    }
    return out;
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// B4: Cold start with 5,000 small notes and 500 encrypted 16 KB notes
// ---------------------------------------------------------------------------
async function runB4Case(chromePath, srvUrl, { vaultSpec, mobile = false, cpuThrottle = 1, runs = 5, onChromeVersion }) {
  const browser = await launchBrowser(chromePath, {
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 800,
    mobile,
    cpuThrottle: 1,
  });
  onChromeVersion?.(browser.chromiumVersion);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG_TASK_HOOK });
    await browser.goto(srvUrl);
    await seedVaultInPage(browser.cdp, vaultSpec);
    if (cpuThrottle > 1) await browser.setCpuThrottle(cpuThrottle);

    const trialRuns = [];
    for (let r = 0; r < runs; r++) {
      const editableMs = await browser.reload();
      // Wait out the first 5 seconds from navigation start to measure background decrypt / startup work.
      const lt5s = await browser.cdp.eval(`(async () => {
        const elapsed = performance.now();
        const rem = Math.max(0, 5000 - elapsed);
        if (rem > 0) await new Promise((res) => setTimeout(res, rem));
        const tasks = (window.__perfLongTasks ?? []).filter((t) => t.start <= 5000);
        let decoded = 0;
        for (const id of window.vrtti.buffers.keys()) {
          if (window.vrtti.store.loadedText(id) !== undefined) decoded++;
        }
        return {
          longTaskTotalFirst5sMs: +tasks.reduce((s, e) => s + e.duration, 0).toFixed(1),
          longTasksFirst5sCount: tasks.length,
          decodedCount: decoded,
        };
      })()`);
      const mem = await browser.heapAndNodes({ gc: true });
      trialRuns.push({
        editableMs,
        jsHeapAfterGcMB: mem.jsHeapMB,
        domNodes: mem.domNodes,
        ...lt5s,
      });
    }
    return medianObjects(trialRuns);
  } finally {
    await browser.close();
  }
}

export async function runB4({ runs = 5, phone = true, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  const srv = await startStaticServer();
  const vault5k = { openCount: 200, recentCount: 2500, closedSyncedCount: 1000, stubCount: 1000, trashCount: 300, noteSizeBytes: 4096 };
  const vault500Enc = { openCount: 100, recentCount: 400, noteSizeBytes: 16384, encrypted: true };
  try {
    const out = {
      desktop_5000_small: await runB4Case(chromePath, srv.url, { vaultSpec: vault5k, runs, onChromeVersion }),
      desktop_500_enc16KB: await runB4Case(chromePath, srv.url, { vaultSpec: vault500Enc, runs, onChromeVersion }),
    };
    if (phone) {
      out.phone4x_5000_small = await runB4Case(chromePath, srv.url, {
        vaultSpec: vault5k,
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
      out.phone4x_500_enc16KB = await runB4Case(chromePath, srv.url, {
        vaultSpec: vault500Enc,
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
    }
    return out;
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// B5: Spellcheck load + 10 / 50 / 95 KB English lint + 20 Czech words
// ---------------------------------------------------------------------------
async function runB5Platform(chromePath, srvUrl, { mobile = false, cpuThrottle = 1, runs = 5, onChromeVersion }) {
  const en10k = makeEnglishProse(10000);
  const en50k = makeEnglishProse(50000);
  const en95k = makeEnglishProse(95000);
  const csWords = makeCzechWords();

  const trialRuns = [];
  for (let r = 0; r < runs; r++) {
    // Fresh browser context per run so engine load measures cold WASM compile/init cleanly.
    const browser = await launchBrowser(chromePath, {
      width: mobile ? 390 : 1280,
      height: mobile ? 844 : 800,
      mobile,
      cpuThrottle,
      spellcheckOff: false,
    });
    onChromeVersion?.(browser.chromiumVersion);
    try {
      await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG_TASK_HOOK });
      await browser.goto(srvUrl);
      const res = await browser.cdp.eval(`(async () => {
        const spellMod = await import("./js/editor/spellcheck.js");
        const hunspell = await import("./js/editor/hunspell.js");

        const ltBefore = (window.__perfLongTasks ?? []).length;
        const tLoad = performance.now();
        const { harper } = await spellMod.enginesForCommand();
        const loadMs = +(performance.now() - tLoad).toFixed(1);
        await new Promise((res) => setTimeout(res, 50));
        const loadLt = (window.__perfLongTasks ?? []).slice(ltBefore);

        const lintText = async (txt) => {
          const t0 = performance.now();
          const lints = await harper.lint(txt);
          const ms = +(performance.now() - t0).toFixed(1);
          for (const l of lints) l.free();
          return ms;
        };

        const lint10kMs = await lintText(${JSON.stringify(en10k)});
        const lint50kMs = await lintText(${JSON.stringify(en50k)});
        const lint95kMs = await lintText(${JSON.stringify(en95k)});

        const tCs = performance.now();
        if (typeof spellMod.twinsForCommand === "function") {
          await spellMod.twinsForCommand(${JSON.stringify(csWords)});
        } else {
          for (const w of ${JSON.stringify(csWords)}) hunspell.twinsNow(w);
        }
        const twins20Ms = +(performance.now() - tCs).toFixed(1);

        return {
          loadMs,
          loadMaxLongTaskMs: loadLt.length ? Math.max(...loadLt.map((e) => e.duration)) : 0,
          loadLongTasksTotalMs: +loadLt.reduce((s, e) => s + e.duration, 0).toFixed(1),
          lint10kMs,
          lint50kMs,
          lint95kMs,
          twins20Ms,
        };
      })()`);
      trialRuns.push(res);
    } finally {
      await browser.close();
    }
  }
  return medianObjects(trialRuns);
}

export async function runB5({ runs = 5, phone = true, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  const srv = await startStaticServer();
  try {
    const out = {
      desktop: await runB5Platform(chromePath, srv.url, { runs, onChromeVersion }),
    };
    if (phone) {
      out.phone4x = await runB5Platform(chromePath, srv.url, {
        mobile: true,
        cpuThrottle: 4,
        runs,
        onChromeVersion,
      });
    }
    return out;
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// B7: Sync client pull of 2,000 notes (Open as tabs) and 2,000 Titles-only stubs
// ---------------------------------------------------------------------------
function cloneSpaceRevisionsInSqlite(dbPath, countPerSpace) {
  const script = `
import sqlite3, sys
db_path, count = sys.argv[1], int(sys.argv[2])
conn = sqlite3.connect(db_path)
conn.execute("PRAGMA journal_mode=WAL;")
conn.execute("PRAGMA synchronous=OFF;")

for space in ("personal", "infra"):
    sample = conn.execute(
        "SELECT kind, content, meta, device_id, client_time, server_time FROM revisions WHERE space = ? AND kind = 'text' LIMIT 1",
        (space,),
    ).fetchone()
    if not sample:
        raise RuntimeError(f"Missing sample revision for space {space}")
    kind, content, meta, dev, ctime, stime = sample
    rows = []
    for i in range(1, count):
        rows.append((f"{space}-doc-{i:05d}", 1, kind, content, meta, dev, ctime + i, stime + i, space, None))
    conn.executemany(
        "INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space, prev_space) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
conn.commit()
conn.close()
`;
  execFileSync("python3", ["-c", script, dbPath, String(countPerSpace)], { stdio: "pipe" });
}

export async function runB7({ runs = 5, chromePath, onChromeVersion }) {
  if (!chromePath) return { skipped: "Chromium not found" };
  if (!hasDotnet()) return { skipped: "dotnet not installed" };
  if (!hasPython3()) return { skipped: "python3 not installed" };

  const staticSrv = await startStaticServer();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-perf-b7-"));
  const dbPath = path.join(dbDir, "vrtti.db");
  let syncSrv = null;
  let browser = null;

  try {
    syncSrv = await startSyncServer({ dbPath, origins: staticSrv.origin });
    browser = await launchBrowser(chromePath, { width: 1280, height: 800 });
    onChromeVersion?.(browser.chromiumVersion);

    // Instrument IDBDatabase.prototype.transaction and hold the sync leader lock
    // when window.__gateSync is requested via sessionStorage so we can attach
    // listeners before sync.start() triggers its initial pull.
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          const origTx = IDBDatabase.prototype.transaction;
          window.__idbTxCount = 0;
          IDBDatabase.prototype.transaction = function (...args) {
            window.__idbTxCount++;
            return origTx.apply(this, args);
          };
          if (sessionStorage.getItem("__perfGateSync") === "1" && navigator.locks) {
            navigator.locks.request("vrtti:sync", () => new Promise((res) => {
              window.__releaseSyncLock = res;
            }));
          }
        })();
      `,
    });

    await browser.goto(staticSrv.url);

    // Register Device A, create "personal" (tab) and "infra" (list), push 1 real 4 KB note to each.
    await browser.cdp.eval(`(async () => {
      const waitIdle = async () => {
        const deadline = Date.now() + 15000;
        while (window.vrtti.sync.status.state === "syncing" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      const flushSync = async () => {
        await waitIdle();
        await window.vrtti.sync.syncNow();
        await waitIdle();
      };
      await window.vrtti.keyring.setup({ deviceName: "PerfSync", askPassphrase: false, firstDevice: true });
      await window.vrtti.sync.registerFirst(${JSON.stringify(syncSrv.url)}, ${JSON.stringify(syncSrv.token)});
      await window.vrtti.sync.createSpace("personal");
      await window.vrtti.sync.createSpace("infra");
      await window.vrtti.sync.setSpaceMode("personal", "tab");
      await window.vrtti.sync.setSpaceMode("infra", "list");
      await flushSync();

      const body = "Sync benchmark body line with realistic text content for 4KB note size.\\n".repeat(56);
      for (const sp of ["personal", "infra"]) {
        const rec = await window.vrtti.createBuffer();
        window.vrtti.store.updateContent(rec.id, "Seed " + sp + "\\n\\n" + body);
        await window.vrtti.saveNow(rec.id);
        await window.vrtti.run("doc.sync.on", { id: rec.id, space: sp });
        await flushSync();
      }
      const deadline = Date.now() + 15000;
      while (window.vrtti.dirtyRecords().length > 0 && Date.now() < deadline) {
        await flushSync();
      }
    })()`);

    // Duplicate the real encrypted revisions up to 2,000 per space in SQLite, then
    // restart Vrtti.Server on the same port so the client's stored server URL still matches.
    const samePort = syncSrv.port;
    await syncSrv.close();
    cloneSpaceRevisionsInSqlite(dbPath, 2000);
    syncSrv = await startSyncServer({ dbPath, port: samePort, origins: staticSrv.origin });

    // Track exact HTTP bytes on /api/changes via CDP Network events.
    const reqUrls = new Map();
    let changesBytes = 0;
    browser.cdp.on("Network.requestWillBeSent", (p) => {
      reqUrls.set(p.requestId, p.request.url);
    });
    browser.cdp.on("Network.loadingFinished", (p) => {
      const url = reqUrls.get(p.requestId) ?? "";
      if (url.includes("/api/changes")) changesBytes += p.encodedDataLength || 0;
    });

    const tabRuns = [];
    const titlesRuns = [];

    const runPullOnce = async (cursorsObj, expectExpr) => {
      await browser.cdp.eval(`(async () => {
        sessionStorage.setItem("__perfGateSync", "1");
        // Open without a version number so future DB_VERSION bumps do not break B7.
        const db = await new Promise((res, rej) => {
          const q = indexedDB.open("vrtti");
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        for (const st of ["buffers", "remote", "workspaces"]) {
          await new Promise((res, rej) => {
            const tx = db.transaction(st, "readwrite");
            tx.objectStore(st).clear();
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
          });
        }
        db.close();
        await window.vrtti.settings.put("sync.cursors", ${JSON.stringify(cursorsObj)});
      })()`);
      await browser.reload();

      changesBytes = 0;
      // Pass a 300 s CDP eval timeout (above the 240 s inner deadline) because
      // unfixed Open-as-tabs pulls are O(N^2) and exceed the default 120 s limit.
      const metrics = await browser.cdp.eval(
        `(async () => {
        let changeEvents = 0;
        const onChange = () => changeEvents++;
        window.vrtti.store.events.addEventListener("change", onChange);
        window.__idbTxCount = 0;
        const t0 = performance.now();
        window.__releaseSyncLock?.();
        const deadline = Date.now() + 240000;
        // Wait for sync.start() to enter syncing and finish pulling all 2,000 items.
        // Before H4/C1 fixes, Open-as-tabs pulls are O(N^2) in sidebar rebuilds and
        // can exceed 2 minutes for 2,000 tabs; record completed explicitly.
        let completed = false;
        while (Date.now() < deadline) {
          if ((${expectExpr}) && window.vrtti.sync.status.state !== "syncing") {
            completed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        const wallMs = +(performance.now() - t0).toFixed(1);
        window.vrtti.store.events.removeEventListener("change", onChange);
        return {
          wallMs,
          completed,
          idbTransactions: window.__idbTxCount,
          changeEvents,
          pulledBuffers: window.vrtti.buffers.size,
          pulledStubs: window.vrtti.remotes().length,
        };
      })()`,
        300000
      );
      return { ...metrics, bytesDownloaded: changesBytes };
    };

    for (let r = 0; r < runs; r++) {
      tabRuns.push(
        await runPullOnce(
          { personal: 0, infra: 999999999, keyring: 999999999 },
          "window.vrtti.buffers.size >= 2000"
        )
      );
      titlesRuns.push(
        await runPullOnce(
          { personal: 999999999, infra: 0, keyring: 999999999 },
          "window.vrtti.remotes().length >= 2000"
        )
      );
    }

    return {
      pull2kTabs: medianObjects(tabRuns),
      pull2kTitlesOnly: medianObjects(titlesRuns),
    };
  } finally {
    if (browser) await browser.close();
    if (syncSrv) await syncSrv.close();
    await staticSrv.close();
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch {}
  }
}
