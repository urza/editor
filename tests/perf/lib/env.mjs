// Shared runtime, CDP Chromium, static server, Vrtti.Server, and statistics
// helpers for tests/perf/. Zero npm dependencies: plain Node 22 + local tools.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const APP_DIR = path.join(ROOT, "app");
export const SERVER_PROJ = path.join(ROOT, "server", "Vrtti.Server");

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

export function findChromium() {
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

export function hasDotnet() {
  try {
    execFileSync("dotnet", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hasPython3() {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function gitCommit() {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function collectEnvInfo(chromiumVersion = null) {
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    commit: gitCommit(),
    node: process.version,
    chromium: chromiumVersion,
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpu: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemGB: +(os.totalmem() / 1073741824).toFixed(1),
  };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected address"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export function startStaticServer() {
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
        close() {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

export class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error("CDP error: " + String(e))));
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

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  off(method, fn) {
    this.listeners.get(method)?.delete(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 120000) {
    const res = await Promise.race([
      this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("CDP eval timed out: " + expression.slice(0, 120))), timeoutMs)
      ),
    ]);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  async waitFor(expression, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await this.eval(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Timed out waiting for: " + expression);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function launchBrowser(
  chromePath,
  { width = 1280, height = 800, mobile = false, cpuThrottle = 1, spellcheckOff = true } = {}
) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-perf-prof-"));
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

  const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("No page target");

  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: mobile ? 3 : 1,
    mobile,
  });
  await cdp.send(
    "Emulation.setTouchEmulationEnabled",
    mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
  );
  if (mobile) {
    // Coarse pointer triggers html.phone layout so mobile CSS and code paths run.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "pointer", value: "coarse" }],
    });
  }
  if (cpuThrottle > 1) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  }
  if (spellcheckOff) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("vrtti.spellcheck", "off");`,
    });
  }

  return {
    cdp,
    chromiumVersion: versionInfo.Browser ?? "unknown",
    async setCpuThrottle(rate) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    },
    async heapAndNodes({ gc = false } = {}) {
      if (gc) {
        await cdp.send("HeapProfiler.collectGarbage");
        await new Promise((r) => setTimeout(r, 30));
      }
      const { metrics } = await cdp.send("Performance.getMetrics");
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      return {
        jsHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
        domNodes: m.Nodes,
      };
    },
    async goto(url) {
      const t0 = performance.now();
      await cdp.send("Page.navigate", { url });
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
      await cdp.eval(`new Promise(r => requestAnimationFrame(r))`);
      return +(performance.now() - t0).toFixed(1);
    },
    async reload() {
      const t0 = performance.now();
      await cdp.send("Page.reload", { ignoreCache: false });
      await new Promise((r) => setTimeout(r, 30));
      await cdp.waitFor("Boolean(window.vrtti && window.vrtti.activeId)");
      await cdp.eval(`new Promise(r => requestAnimationFrame(r))`);
      return +(performance.now() - t0).toFixed(1);
    },
    async close() {
      cdp.close();
      proc.kill("SIGTERM");
      await new Promise((r) => {
        proc.once("exit", r);
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
          r();
        }, 1500);
      });
      // Retry rmSync because Chromium may still flush profile files briefly after exit.
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
      } catch {}
    },
  };
}

// Shared Release build of Vrtti.Server in os.tmpdir() so B7 and B8 compile once per run.
let cachedBuild = null;

export function ensureServerBuild() {
  if (cachedBuild && fs.existsSync(cachedBuild.dllPath)) return cachedBuild;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-perf-srvbuild-"));
  const binDir = path.join(baseDir, "bin");
  const objDir = path.join(baseDir, "obj") + path.sep;
  execFileSync(
    "dotnet",
    ["build", SERVER_PROJ, "-c", "Release", "-o", binDir, `/p:IntermediateOutputPath=${objDir}`],
    { stdio: "pipe" }
  );
  cachedBuild = { baseDir, dllPath: path.join(binDir, "Vrtti.Server.dll") };
  return cachedBuild;
}

export function cleanupServerBuild() {
  if (!cachedBuild) return;
  try {
    fs.rmSync(cachedBuild.baseDir, { recursive: true, force: true });
  } catch {}
  cachedBuild = null;
}

export async function startSyncServer({ dbPath, port = null, token = "perf-bench-token", origins = "http://127.0.0.1" }) {
  const { dllPath } = ensureServerBuild();
  const listenPort = port ?? (await freePort());
  const url = `http://127.0.0.1:${listenPort}`;
  const proc = spawn("dotnet", [dllPath], {
    env: {
      ...process.env,
      VRTTI_TOKEN: token,
      VRTTI_DB: dbPath,
      VRTTI_ORIGINS: origins,
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
          port: listenPort,
          token,
          async close() {
            proc.kill("SIGTERM");
            await new Promise((res) => {
              proc.once("exit", res);
              setTimeout(() => {
                try {
                  proc.kill("SIGKILL");
                } catch {}
                res();
              }, 2000);
            });
          },
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  proc.kill("SIGKILL");
  throw new Error("Vrtti.Server failed to start:\n" + logs);
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return +sorted[idx].toFixed(2);
}

export function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return +val.toFixed(2);
}

/**
 * Given N run objects with identical numeric keys, returns an object holding
 * the median of every numeric metric across the runs (non-numeric fields come
 * from the first run).
 */
export function medianObjects(runs) {
  if (!runs.length) return {};
  const keys = Object.keys(runs[0]);
  const out = {};
  for (const key of keys) {
    const vals = runs.map((r) => r[key]);
    if (vals.every((v) => typeof v === "number" && Number.isFinite(v))) {
      out[key] = median(vals);
    } else if (vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      out[key] = medianObjects(vals);
    } else {
      out[key] = vals[0];
    }
  }
  return out;
}
