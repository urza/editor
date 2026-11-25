// node --test tests/*.test.mjs
// Tests for update fast-paths, SW settlement timeouts, and gzipped Czech dict.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "app");

// Stub minimal browser globals before importing capabilities.js.
const store = new Map();
const fakeWindow = { caches: null };
Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  configurable: true,
  writable: true,
});

const { BUILD } = await import("../app/js/version.js");
const { checkForUpdate, newWorkerSettled } = await import("../app/js/model/capabilities.js");

class FakeWorker extends EventTarget {
  /** @param {string} state */
  constructor(state) {
    super();
    this.state = state;
  }
  /** @param {string} next */
  setState(next) {
    this.state = next;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  /** @param {{ active?: FakeWorker | null, installing?: FakeWorker | null, waiting?: FakeWorker | null, onUpdate?: (reg: FakeRegistration) => Promise<void> | void }} [init] */
  constructor(init = {}) {
    super();
    this.active = init.active ?? null;
    this.installing = init.installing ?? null;
    this.waiting = init.waiting ?? null;
    this.updateCalls = 0;
    this._onUpdate = init.onUpdate ?? (() => {});
  }
  async update() {
    this.updateCalls++;
    await this._onUpdate(this);
  }
}

/**
 * Install per-test browser mocks for fetch, caches, navigator.serviceWorker,
 * and location.reload.
 * @param {{
 *   liveCommit: string,
 *   cachedCommit?: string | null,
 *   cacheKeys?: string[],
 *   reg?: FakeRegistration,
 * }} cfg
 */
function setupEnv(cfg) {
  store.clear();
  const deleted = [];
  let reloaded = 0;
  let currentCached = cfg.cachedCommit ?? null;

  const cachesApi = {
    async match() {
      if (!currentCached) return undefined;
      return new Response(`export const BUILD = { "commit": "${currentCached}" };`);
    },
    async keys() {
      return [...(cfg.cacheKeys ?? ["vrtti-old", "vrtti-spell-abc", "vrtti-emoji"])];
    },
    async delete(name) {
      deleted.push(name);
      return true;
    },
  };
  fakeWindow.caches = cachesApi;
  Object.defineProperty(globalThis, "caches", { value: cachesApi, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        async getRegistration() {
          return cfg.reg;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: {
      reload() {
        reloaded++;
      },
    },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = async () =>
    new Response(`export const BUILD = { "commit": "${cfg.liveCommit}" };`, { status: 200 });

  return {
    deleted,
    get reloaded() {
      return reloaded;
    },
    /** @param {string | null} commit */
    setCachedCommit(commit) {
      currentCached = commit;
    },
  };
}

test("checkForUpdate reloads immediately without deleting caches when background SW already cached live build", async () => {
  const newWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: newWorker });
  const env = setupEnv({
    liveCommit: "newbeef",
    cachedCommit: "newbeef",
    cacheKeys: ["vrtti-new", "vrtti-spell-111", "vrtti-emoji"],
    reg,
  });

  let flushed = false;
  const t0 = performance.now();
  const ok = await checkForUpdate(() => {}, {
    beforeReload: async () => {
      flushed = true;
    },
    installWaitMs: 5000,
    findWaitMs: 500,
  });
  const elapsed = performance.now() - t0;

  assert.equal(ok, true);
  assert.equal(flushed, true);
  assert.equal(env.reloaded, 1);
  assert.equal(reg.updateCalls, 0, "should skip reg.update() when active cache already holds live");
  assert.deepEqual(env.deleted, [], "must not delete freshly cached build");
  assert.ok(elapsed < 100, `expected immediate reload, took ${elapsed.toFixed(1)} ms`);
});

test("checkForUpdate finishes immediately when new worker activates during reg.update()", async () => {
  const oldWorker = new FakeWorker("activated");
  const nextWorker = new FakeWorker("installing");
  const reg = new FakeRegistration({
    active: oldWorker,
    onUpdate(r) {
      nextWorker.state = "activated";
      r.active = nextWorker;
      r.installing = null;
    },
  });
  const env = setupEnv({
    liveCommit: "deadc0d",
    cachedCommit: BUILD.commit,
    reg,
  });

  const t0 = performance.now();
  const ok = await checkForUpdate(() => {}, { installWaitMs: 5000, findWaitMs: 500 });
  const elapsed = performance.now() - t0;

  assert.equal(ok, true);
  assert.equal(env.reloaded, 1);
  assert.equal(reg.updateCalls, 1);
  assert.deepEqual(env.deleted, []);
  assert.ok(elapsed < 100, `expected immediate exit, took ${elapsed.toFixed(1)} ms`);
});

test("checkForUpdate falls back after short findWaitMs when reg.update() finds no new worker (stale CDN sw.js)", async () => {
  const oldWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: oldWorker });
  const env = setupEnv({
    liveCommit: "cafebabe",
    cachedCommit: BUILD.commit,
    cacheKeys: ["vrtti-old123", "vrtti-spell-keep", "vrtti-emoji"],
    reg,
  });

  const t0 = performance.now();
  const ok = await checkForUpdate(() => {}, { installWaitMs: 5000, findWaitMs: 40 });
  const elapsed = performance.now() - t0;

  assert.equal(ok, true);
  assert.equal(env.reloaded, 1);
  assert.deepEqual(env.deleted, ["vrtti-old123"], "keeps vrtti-spell-* and vrtti-emoji");
  assert.ok(elapsed < 500, `must use findWaitMs, not installWaitMs; took ${elapsed.toFixed(1)} ms`);
});

test("newWorkerSettled extends timeout to installMs when late updatefound fires (WebKit path)", async () => {
  const oldWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: oldWorker });

  setTimeout(() => {
    const incoming = new FakeWorker("installing");
    reg.installing = incoming;
    reg.dispatchEvent(new Event("updatefound"));
    setTimeout(() => {
      reg.installing = null;
      reg.active = incoming;
      incoming.setState("activated");
    }, 80);
  }, 15);

  const t0 = performance.now();
  await newWorkerSettled(/** @type {any} */ (reg), /** @type {any} */ (oldWorker), 2000, 40);
  const elapsed = performance.now() - t0;

  assert.notEqual(reg.active, oldWorker, "waited past findMs for the installing worker to activate");
  assert.ok(elapsed >= 80 && elapsed < 1000, `unexpected settle duration: ${elapsed.toFixed(1)} ms`);
});

test("newWorkerSettled resolves immediately if worker is already activated or reg.active changed", async () => {
  const oldWorker = new FakeWorker("activated");
  const alreadyActive = new FakeWorker("activated");

  const regChanged = new FakeRegistration({ active: alreadyActive });
  const t0 = performance.now();
  await newWorkerSettled(/** @type {any} */ (regChanged), /** @type {any} */ (oldWorker), 5000, 5000);
  assert.ok(performance.now() - t0 < 50);

  const regDoneWaiting = new FakeRegistration({ active: oldWorker, waiting: alreadyActive });
  const t1 = performance.now();
  await newWorkerSettled(/** @type {any} */ (regDoneWaiting), /** @type {any} */ (oldWorker), 5000, 5000);
  assert.ok(performance.now() - t1 < 50);
});

test("Czech dictionary uses .txt suffix so GitHub Pages serves it with gzip", () => {
  const dicTxt = path.join(APP_DIR, "vendor/dictionary-cs/index.dic.txt");
  const oldDic = path.join(APP_DIR, "vendor/dictionary-cs/index.dic");
  assert.equal(fs.existsSync(dicTxt), true, "index.dic.txt must exist");
  assert.equal(fs.existsSync(oldDic), false, "uncompressed index.dic must be removed");

  const precache = fs.readFileSync(path.join(APP_DIR, "sw-precache.js"), "utf8");
  assert.ok(precache.includes("./vendor/dictionary-cs/index.dic.txt"));
  assert.ok(!precache.includes('"./vendor/dictionary-cs/index.dic"'));
});
