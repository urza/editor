// @ts-check
// Feature detection in one place, so platform limits stay explicit
// (architecture.md §2, §4). Modules gate on these flags instead of probing
// the platform themselves.

// Desktop Chrome/Edge only. Gates the future storage/fsa.js module.
export const hasFileSystemAccess = "showDirectoryPicker" in window;

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
