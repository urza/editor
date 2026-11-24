// @ts-check
// Feature detection in one place, so platform limits stay explicit
// (architecture.md §2, §4). Modules gate on these flags instead of probing
// the platform themselves.

import { BUILD } from "../version.js";

// Desktop Chrome/Edge only. Gates the future storage/fsa.js module.
export const hasFileSystemAccess = "showDirectoryPicker" in window;

// Inside the desktop shell (src-tauri/). The shell sets the marker before any
// page script runs, so the flag is safe at import time like the others. The
// page talks to the shell through DOM events only (ui/desktop.js); the same
// build runs in a browser and in the shell.
export const isDesktop = Boolean(/** @type {any} */ (window).vrttiDesktop);

// Machine hostname reported by the desktop shell (src-tauri/src/lib.rs).
// Empty in a browser (browsers do not expose the OS hostname) and in older
// shell builds that predate this field.
export const desktopHostname =
  typeof /** @type {any} */ (window).vrttiDesktop?.hostname === "string"
    ? /** @type {any} */ (window).vrttiDesktop.hostname.trim()
    : "";

// "Can this device open files and folders at all?" Every gate about disk asks
// this one, because the shell reaches disk through Rust and needs no browser
// API (architecture.md §17). hasFileSystemAccess stays the narrower fact, and
// only storage/fsa.js still asks it: which backend a picker uses.
export const hasDisk = isDesktop || hasFileSystemAccess;

// Dedicated module workers. Unlock runs scrypt in one, because scrypt is
// synchronous and would freeze the UI for ~650 ms on the main thread
// (architecture.md §5). js/crypto/unlock.js still falls back to the main thread
// where this is false, so the flag reports a lost property, not a lost feature.
export const hasWorkers = typeof Worker !== "undefined";

// The update check compares this build with the live `js/version.js`, not
// with what the service worker says. The service worker's own check was the
// only test before, and on an iPhone it said "up to date" while the server
// had a newer build: reg.update() can resolve before the install starts, and
// WebKit may keep serving its old cache. The live build number is the truth.
const UPDATE_TRIES_KEY = "vrtti.updateTries";
// Reloads for one build before the app stops trying on its own; the button
// still works. Each one deletes the old caches, so a second one only fails
// while the CDN still serves old files (Pages: max-age=600).
const AUTO_TRIES = 2;

/** The build on the server. @returns {Promise<string>} */
async function liveCommit() {
  // "live" makes sw.js let the request through to the network: its fetch
  // handler matches the cache with ignoreSearch, so a plain cache buster
  // would still get the cached, old file.
  const res = await fetch("./js/version.js?live=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("version.js: " + res.status);
  const match = /"commit":\s*"([^"]+)"/.exec(await res.text());
  if (!match) throw new Error("version.js has no commit");
  return match[1];
}

/** @returns {{commit: string, count: number}} */
function readTries() {
  try {
    return JSON.parse(sessionStorage.getItem(UPDATE_TRIES_KEY) ?? "null") ?? { commit: "", count: 0 };
  } catch {
    return { commit: "", count: 0 };
  }
}

/** @param {{commit: string, count: number} | null} tries */
function writeTries(tries) {
  try {
    if (tries) sessionStorage.setItem(UPDATE_TRIES_KEY, JSON.stringify(tries));
    else sessionStorage.removeItem(UPDATE_TRIES_KEY);
  } catch {
    // Without sessionStorage the automatic check may reload one time more.
  }
}

/**
 * Wait until a new service worker is active, or redundant, or `ms` passed.
 * @param {ServiceWorkerRegistration} reg @param {number} ms
 */
function newWorkerSettled(reg, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    const timer = setTimeout(done, ms);
    /** @param {ServiceWorker | null} worker */
    const follow = (worker) => {
      if (!worker) return done();
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated" || worker.state === "redundant") done();
      });
    };
    if (reg.installing || reg.waiting) return follow(reg.installing ?? reg.waiting);
    reg.addEventListener("updatefound", () => follow(reg.installing), { once: true });
  });
}

/**
 * Load the build on the server, if it is not this one. onStatus receives
 * short progress strings, then null when the caller should restore its
 * normal display. Resolves true when the page is about to reload.
 *
 * Without the service worker taking the new build in 30 seconds, the old
 * caches go before the reload: the page then loads each file from the
 * network, and the service worker installs the new build at its next check.
 * @param {(msg: string | null) => void} [onStatus]
 * @param {{beforeReload?: () => Promise<void>, auto?: boolean}} [opts]
 *   beforeReload: save what waits in a debounce. auto: the check at start or
 *   on return, which stops after AUTO_TRIES reloads for one build.
 */
export async function checkForUpdate(onStatus = () => {}, opts = {}) {
  const clear = () => setTimeout(() => onStatus(null), 4000);
  onStatus("checking…");
  let live;
  try {
    live = await liveCommit();
  } catch (err) {
    console.log("[vrtti] update check failed:", err);
    onStatus("check failed (offline?)");
    clear();
    return false;
  }
  if (live === BUILD.commit) {
    writeTries(null);
    onStatus("up to date (" + live + ")");
    clear();
    return false;
  }
  const tries = readTries();
  const count = tries.commit === live ? tries.count : 0;
  if (opts.auto && count >= AUTO_TRIES) {
    console.log("[vrtti] the server has build", live, "but this device still loads", BUILD.commit);
    return false;
  }
  console.log("[vrtti] updating from build", BUILD.commit, "to", live);
  onStatus("updating to " + live + "…");
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  let took = false;
  if (reg) {
    const before = reg.active;
    try {
      await reg.update();
      await newWorkerSettled(reg, 30000);
      took = Boolean(reg.active && reg.active !== before);
    } catch (err) {
      console.log("[vrtti] service worker update failed:", err);
    }
  }
  if (!took && "caches" in window) {
    // Keep both the emoji cache and the content-addressed spellcheck cache so
    // a slow-network update fallback never discards 12 MB of dictionaries (C4).
    for (const name of await caches.keys()) {
      if (
        name.startsWith("vrtti-") &&
        name !== "vrtti-emoji" &&
        !name.startsWith("vrtti-spell-")
      ) {
        await caches.delete(name);
      }
    }
    console.log("[vrtti] the service worker kept its old build; its caches are gone");
  }
  writeTries({ commit: live, count: count + 1 });
  await opts.beforeReload?.();
  location.reload();
  return true;
}

export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    const granted = await navigator.storage.persist();
    console.log("[vrtti] persistent storage:", granted);
    return granted;
  } catch (err) {
    console.log("[vrtti] persistent storage unavailable:", err);
    return false;
  }
}

/**
 * Is the origin already under a persistent-storage grant? A browser without
 * the API (iOS Safari today) reports false: no grant is the honest answer,
 * and it is also the state the settings panel should show.
 * @returns {Promise<boolean>}
 */
export async function isPersisted() {
  if (!navigator.storage || !navigator.storage.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Rough usage and quota in bytes, or null where the API is missing. Both
 * numbers are deliberately fuzzy in every browser; they answer "am I near the
 * limit", nothing finer.
 * @returns {Promise<{usage: number, quota: number} | null>}
 */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
