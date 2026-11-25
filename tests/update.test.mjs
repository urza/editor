// node --test tests/*.test.mjs
// Tests for update fast-paths, SW settlement timeouts, and gzipped Czech dict.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

/** @param {string} body */
function fakeResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return body;
    },
  };
}

/** Flush queued microtasks so promise chains advance under mocked timers. */
async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Install per-test browser mocks for fetch, caches, navigator.serviceWorker,
 * and location.reload.
 * @param {{
 *   liveCommit: string,
 *   cachedCommit?: string | null,
 *   cacheKeys?: string[],
 *   swScript?: string,
 *   reg?: FakeRegistration,
 * }} cfg
 */
function setupEnv(cfg) {
  store.clear();
  const deleted = [];
  const fetchedUrls = [];
  let reloaded = 0;
  let currentCached = cfg.cachedCommit ?? null;

  const cachesApi = {
    async match() {
      if (!currentCached) return undefined;
      return fakeResponse(`export const BUILD = { "commit": "${currentCached}" };`);
    },
    async keys() {
      return [...(cfg.cacheKeys ?? ["vrtti-aaaa1111", "vrtti-spell-bbbb2222", "vrtti-emoji"])];
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
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    if (u.includes("sw.js")) {
      return fakeResponse(
        cfg.swScript ?? 'importScripts("./sw-precache.js?v=cccc3333-bbbb2222");'
      );
    }
    return fakeResponse(`export const BUILD = { "commit": "${cfg.liveCommit}" };`);
  };

  return {
    deleted,
    fetchedUrls,
    get reloaded() {
      return reloaded;
    },
    /** @param {string | null} commit */
    setCachedCommit(commit) {
      currentCached = commit;
    },
  };
}

test("checkForUpdate reloads immediately without deleting caches when background SW already cached live build", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const newWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: newWorker });
  const env = setupEnv({
    liveCommit: "newbeef",
    cachedCommit: "newbeef",
    cacheKeys: ["vrtti-new", "vrtti-spell-111", "vrtti-emoji"],
    reg,
  });

  let flushed = false;
  // Without advancing timers, any pending wait timer would hang this await.
  const ok = await checkForUpdate(() => {}, {
    beforeReload: async () => {
      flushed = true;
    },
    installWaitMs: 30000,
  });

  assert.equal(ok, true);
  assert.equal(flushed, true);
  assert.equal(env.reloaded, 1);
  assert.equal(reg.updateCalls, 0, "should skip reg.update() when active cache already holds live");
  assert.deepEqual(env.deleted, [], "must not delete freshly cached build");
});

test("checkForUpdate finishes immediately when new worker activates during reg.update()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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

  const ok = await checkForUpdate(() => {}, { installWaitMs: 30000 });

  assert.equal(ok, true);
  assert.equal(env.reloaded, 1);
  assert.equal(reg.updateCalls, 1);
  assert.deepEqual(env.deleted, []);
});

test("checkForUpdate skips 30 s wait when CDN still serves old sw.js", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: oldWorker });
  const env = setupEnv({
    liveCommit: "cafebabe",
    cachedCommit: BUILD.commit,
    cacheKeys: ["vrtti-aaaa1111", "vrtti-spell-bbbb2222", "vrtti-emoji"],
    swScript: 'importScripts("./sw-precache.js?v=aaaa1111-bbbb2222");',
    reg,
  });

  // Resolves without ticking the 30 s timer because sw.js matches existing caches.
  const ok = await checkForUpdate(() => {}, { installWaitMs: 30000 });

  assert.equal(ok, true);
  assert.equal(env.reloaded, 1);
  assert.deepEqual(env.deleted, ["vrtti-aaaa1111"], "keeps vrtti-spell-* and vrtti-emoji");
});

test("checkForUpdate keeps full 30 s window when newer sw.js is live (WebKit 3G delayed updatefound)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldWorker = new FakeWorker("activated");
  const reg = new FakeRegistration({ active: oldWorker });
  const env = setupEnv({
    liveCommit: "feed123",
    cachedCommit: BUILD.commit,
    cacheKeys: ["vrtti-aaaa1111", "vrtti-spell-bbbb2222", "vrtti-emoji"],
    swScript: 'importScripts("./sw-precache.js?v=dddd4444-bbbb2222");',
    reg,
  });

  let done = false;
  const promise = checkForUpdate(() => {}, { installWaitMs: 30000 }).then((r) => {
    done = true;
    return r;
  });

  await flushMicrotasks();
  assert.equal(reg.updateCalls, 1, "reg.update() must have run before timer tick");
  // Simulate slow 3G on iOS Safari: updatefound arrives after 2 s (past 1 s).
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.equal(done, false, "must still be waiting for late updatefound on WebKit");

  const incoming = new FakeWorker("installing");
  reg.installing = incoming;
  reg.dispatchEvent(new Event("updatefound"));

  t.mock.timers.tick(3000);
  reg.installing = null;
  reg.active = incoming;
  incoming.setState("activated");

  const ok = await promise;
  assert.equal(ok, true);
  assert.equal(env.reloaded, 1);
  assert.deepEqual(env.deleted, [], "must not delete caches when late worker activates");
});

test("checkForUpdate keeps caches and skips reload if worker is still installing at 30 s timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldWorker = new FakeWorker("activated");
  const slowWorker = new FakeWorker("installing");
  const reg = new FakeRegistration({
    active: oldWorker,
    onUpdate(r) {
      r.installing = slowWorker;
    },
  });
  const env = setupEnv({
    liveCommit: "510w001",
    cachedCommit: BUILD.commit,
    cacheKeys: ["vrtti-aaaa1111", "vrtti-newinstalling", "vrtti-spell-bbbb2222", "vrtti-emoji"],
    reg,
  });

  const statuses = [];
  const promise = checkForUpdate((s) => statuses.push(s), { installWaitMs: 30000 });
  await flushMicrotasks();
  assert.equal(reg.updateCalls, 1, "reg.update() must have run before timer tick");
  t.mock.timers.tick(30000);
  const ok = await promise;

  assert.equal(ok, false);
  assert.equal(env.reloaded, 0, "must not reload into old build while new worker installs");
  assert.deepEqual(env.deleted, [], "must not orphan in-progress precache");
  assert.ok(statuses.includes("still updating in background"));
});

test("newWorkerSettled defaults before to reg.active and resolves immediately when worker is already activated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldWorker = new FakeWorker("activated");
  const alreadyActive = new FakeWorker("activated");

  // Defaulting `before` to reg.active must NOT immediately resolve when active did not change.
  const regSame = new FakeRegistration({ active: oldWorker });
  let sameDone = false;
  const samePromise = newWorkerSettled(/** @type {any} */ (regSame), undefined, 30000).then(() => {
    sameDone = true;
  });
  await flushMicrotasks();
  assert.equal(sameDone, false, "must wait when before is omitted and reg.active is unchanged");
  t.mock.timers.tick(30000);
  await samePromise;
  assert.equal(sameDone, true);

  // Already changed reg.active or already-activated waiting worker resolves with zero ticks.
  const regChanged = new FakeRegistration({ active: alreadyActive });
  await newWorkerSettled(/** @type {any} */ (regChanged), /** @type {any} */ (oldWorker), 30000);

  const regDoneWaiting = new FakeRegistration({ active: oldWorker, waiting: alreadyActive });
  await newWorkerSettled(/** @type {any} */ (regDoneWaiting), /** @type {any} */ (oldWorker), 30000);
});

test("Czech dictionary uses .txt suffix and sw.js aliases legacy index.dic requests to index.dic.txt", async () => {
  const dicTxt = path.join(APP_DIR, "vendor/dictionary-cs/index.dic.txt");
  const oldDic = path.join(APP_DIR, "vendor/dictionary-cs/index.dic");
  assert.equal(fs.existsSync(dicTxt), true, "index.dic.txt must exist");
  assert.equal(fs.existsSync(oldDic), false, "uncompressed index.dic must be removed");

  const precache = fs.readFileSync(path.join(APP_DIR, "sw-precache.js"), "utf8");
  assert.ok(precache.includes("./vendor/dictionary-cs/index.dic.txt"));
  assert.ok(!precache.includes('"./vendor/dictionary-cs/index.dic"'));

  // Run sw.js fetch handler in a minimal VM to verify old tabs asking for
  // /vendor/dictionary-cs/index.dic receive the cached index.dic.txt response.
  const swSource = fs.readFileSync(path.join(APP_DIR, "sw.js"), "utf8");
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  const dicResponse = new Response("1\nahoj\n", { status: 200 });
  const sandbox = {
    self: null,
    URL,
    location: { origin: "https://urza.github.io" },
    importScripts() {
      sandbox.self.__PRECACHE = { version: "v1", spellVersion: "s1", app: [], spell: [] };
    },
    caches: {
      async match(req) {
        if (req === "./vendor/dictionary-cs/index.dic.txt") return dicResponse;
        return undefined;
      },
    },
    fetch() {
      throw new Error("should serve alias from cache without network");
    },
  };
  sandbox.self = sandbox;
  sandbox.addEventListener = (type, fn) => listeners.set(type, fn);
  vm.runInNewContext(swSource, sandbox);

  const onFetch = listeners.get("fetch");
  assert.equal(typeof onFetch, "function");
  /** @type {Promise<Response> | null} */
  let responded = null;
  onFetch({
    request: { method: "GET", url: "https://urza.github.io/editor/vendor/dictionary-cs/index.dic" },
    respondWith(p) {
      responded = p;
    },
  });
  assert.ok(responded, "fetch handler must intercept legacy index.dic request");
  const res = await responded;
  assert.equal(res, dicResponse);
});
