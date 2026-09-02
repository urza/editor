// @ts-check
// Feature detection in one place, so platform limits stay explicit
// (architecture.md §2, §4). Modules gate on these flags instead of probing
// the platform themselves.

// Desktop Chrome/Edge only. Gates the future storage/fsa.js module.
export const hasFileSystemAccess = "showDirectoryPicker" in window;

// Dedicated module workers. Unlock runs scrypt in one, because scrypt is
// synchronous and would freeze the UI for ~650 ms on the main thread
// (architecture.md §5). js/crypto/unlock.js still falls back to the main thread
// where this is false, so the flag reports a lost property, not a lost feature.
export const hasWorkers = typeof Worker !== "undefined";

// Force a service worker update check, then reload when the new build takes
// over. sw.js uses skipWaiting + clients.claim, so a found update activates on
// its own; we only wait for the takeover (controllerchange), then reload so
// the page re-fetches from the new cache.
// onStatus receives short progress strings, then null when the caller should
// restore its normal display.
/** @param {(msg: string | null) => void} [onStatus] */
export async function checkForUpdate(onStatus = () => {}) {
  if (!("serviceWorker" in navigator)) return location.reload();
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return location.reload();

  onStatus("checking…");
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => location.reload(),
    { once: true }
  );

  try {
    await reg.update();
  } catch (err) {
    console.log("[vrtti] update check failed:", err);
    onStatus("check failed (offline?)");
    setTimeout(() => onStatus(null), 3000);
    return;
  }

  if (reg.installing || reg.waiting) {
    onStatus("updating…"); // the controllerchange listener reloads when done
    // Safety net so a stuck install does not show "updating…" forever.
    setTimeout(() => onStatus(null), 20000);
  } else {
    onStatus("up to date");
    setTimeout(() => onStatus(null), 3000);
  }
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
