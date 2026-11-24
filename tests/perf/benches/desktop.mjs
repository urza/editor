// B9: Desktop disk and IPC benchmarks.
// Measures local filesystem patterns mirrored from src-tauri/src/disk.rs
// (5,000-file disk_list stat vs d_type, atomic fsync writes for 10 KB / 1 MB / 5 MB,
// JSON IPC roundtrip) plus real IPC calls per file save by instrumenting
// window.__TAURI__.core.invoke inside Chromium.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser, medianObjects, percentile, startStaticServer } from "../lib/env.mjs";

function measureFilesystemOnce(tmpDir) {
  const bigDir = path.join(tmpDir, "dir5000");
  if (!fs.existsSync(bigDir)) {
    fs.mkdirSync(bigDir);
    for (let i = 0; i < 5000; i++) {
      fs.writeFileSync(path.join(bigDir, `note-${String(i).padStart(5, "0")}.md`), "hello");
    }
  }

  let t0 = performance.now();
  const names = fs.readdirSync(bigDir);
  const withStat = [];
  for (const name of names) {
    const st = fs.statSync(path.join(bigDir, name));
    if (st.isFile()) withStat.push({ name, kind: "file" });
  }
  const listStatMs = +(performance.now() - t0).toFixed(2);

  t0 = performance.now();
  const dirents = fs.readdirSync(bigDir, { withFileTypes: true });
  const withDtype = [];
  for (const d of dirents) {
    if (d.isFile()) withDtype.push({ name: d.name, kind: "file" });
    else if (d.isDirectory()) withDtype.push({ name: d.name, kind: "directory" });
    else if (d.isSymbolicLink()) {
      const st = fs.statSync(path.join(bigDir, d.name));
      if (st.isFile() || st.isDirectory()) {
        withDtype.push({ name: d.name, kind: st.isDirectory() ? "directory" : "file" });
      }
    }
  }
  const listFileTypesMs = +(performance.now() - t0).toFixed(2);

  const sizes = [
    ["10KB", "a".repeat(10 * 1024)],
    ["1MB", "a".repeat(1024 * 1024)],
    ["5MB", "a".repeat(5 * 1024 * 1024)],
  ];
  const writes = {};
  for (const [label, text] of sizes) {
    const target = path.join(tmpDir, `write-${label}.md`);
    const buf = Buffer.from(text, "utf8");
    const tmp = path.join(tmpDir, `.tmp-${label}`);

    // Mirrors disk.rs write_then_rename() with sync_all() kept for crash durability.
    const s0 = performance.now();
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
    fs.statSync(target);
    const atomicFsyncMs = +(performance.now() - s0).toFixed(2);

    const j0 = performance.now();
    const encoded = JSON.stringify({ text });
    JSON.parse(encoded);
    const jsonIpcMs = +(performance.now() - j0).toFixed(2);

    writes[label] = { atomicFsyncMs, jsonIpcMs };
  }

  return {
    diskList5000StatMs: listStatMs,
    diskList5000FileTypesMs: listFileTypesMs,
    diskListSpeedupX: +(listStatMs / Math.max(0.01, listFileTypesMs)).toFixed(2),
    save10KBFsyncMs: writes["10KB"].atomicFsyncMs,
    save1MBFsyncMs: writes["1MB"].atomicFsyncMs,
    save5MBFsyncMs: writes["5MB"].atomicFsyncMs,
    jsonIpc1MBMs: writes["1MB"].jsonIpcMs,
    jsonIpc5MBMs: writes["5MB"].jsonIpcMs,
  };
}

/**
 * Count the exact IPC commands that docs.js + storage/native.js issue during a
 * single file-backed saveNow() by mocking window.__TAURI__.core.invoke.
 */
async function measureSaveIpcCalls(chromePath, onChromeVersion) {
  if (!chromePath) return { ipcCallsPerSave: null, ipcCommands: [] };
  const srv = await startStaticServer();
  const browser = await launchBrowser(chromePath, { width: 1280, height: 800 });
  onChromeVersion?.(browser.chromiumVersion);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          let mtime = 1764000000000;
          let content = "initial file text\\n";
          window.__ipcLog = [];
          window.__TAURI__ = {
            core: {
              invoke: async (cmd, args) => {
                window.__ipcLog.push(cmd);
                if (cmd === "disk_stat") return { size: content.length, mtime };
                if (cmd === "disk_read") return { text: content, mtime };
                if (cmd === "disk_write") {
                  content = args?.text ?? "";
                  mtime += 1000;
                  return { mtime };
                }
                if (cmd === "disk_list") return [];
                if (cmd === "disk_roots") return [];
                if (cmd === "shell_ready") return [];
                return null;
              },
            },
          };
        })();
      `,
    });
    await browser.goto(srv.url);
    return await browser.cdp.eval(`(async () => {
      const nativeMod = await import("./js/storage/native.js");
      const handle = nativeMod.reviveHandle({
        native: true,
        kind: "file",
        name: "bench.md",
        root: "root-1",
        rootPath: "/tmp/bench.md",
        path: "",
      });
      const rec = await window.vrtti.store.createFromFile(handle);
      await window.vrtti.activateBuffer(rec.id);
      window.vrtti.store.updateContent(rec.id, "initial file text\\nedited line\\n");
      window.__ipcLog.length = 0;
      await window.vrtti.saveNow(rec.id);
      return {
        ipcCallsPerSave: window.__ipcLog.length,
        ipcCommands: [...window.__ipcLog],
      };
    })()`);
  } finally {
    await browser.close();
    await srv.close();
  }
}

export async function runB9({ runs = 5, chromePath = null, onChromeVersion } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-perf-b9-"));
  const fsRuns = [];
  try {
    // Warm up once before timed runs so fixture creation is excluded.
    measureFilesystemOnce(tmpDir);
    for (let i = 0; i < runs; i++) {
      fsRuns.push(measureFilesystemOnce(tmpDir));
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  const fsSummary = medianObjects(fsRuns);
  const ipc = await measureSaveIpcCalls(chromePath, onChromeVersion);
  return {
    ...fsSummary,
    ipcCallsPerSave: ipc.ipcCallsPerSave,
    ipcCommands: ipc.ipcCommands,
    diskList5000StatP95Ms: percentile(
      fsRuns.map((r) => r.diskList5000StatMs),
      0.95
    ),
  };
}
