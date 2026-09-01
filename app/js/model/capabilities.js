// @ts-check
// Feature detection in one place, so platform limits stay explicit
// (architecture.md §2, §4). Modules gate on these flags instead of probing
// the platform themselves.

// Desktop Chrome/Edge only. Gates the future storage/fsa.js module.
export const hasFileSystemAccess = "showDirectoryPicker" in window;

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
