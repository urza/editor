// @ts-check
// File System Access API, wrapped thinly (architecture.md §2). This module
// knows nothing about buffers or records: it only turns handles into text and
// text into files. model/docs.js owns the policy.
//
// Two rules hold this layer together:
//  - Every entry point is read off `window` at call time, never destructured at
//    import time. The tests stub window.showOpenFilePicker / showSaveFilePicker
//    with OPFS handles, and a stub installed after this module loads must still
//    win.
//  - Nothing is caught here. A denied permission, a deleted file, or a
//    cancelled picker is a decision for the caller, not a silent failure.

/** @typedef {any} FileHandle FileSystemFileHandle; no lib.dom types without a build step. */

/**
 * @returns {Promise<FileHandle>} Rejects with AbortError when the user cancels.
 */
export async function openFilePicker() {
  const handles = await window.showOpenFilePicker({ multiple: false });
  return handles[0];
}

/** @param {string} suggestedName @returns {Promise<FileHandle>} */
export async function saveFilePicker(suggestedName) {
  return window.showSaveFilePicker({ suggestedName });
}

/** @param {FileHandle} handle @returns {Promise<{content: string, lastModified: number}>} */
export async function readFile(handle) {
  const file = await handle.getFile();
  return { content: await file.text(), lastModified: file.lastModified };
}

/** @param {FileHandle} handle @param {string} content */
export async function writeFile(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  // The file on disk only changes on close(); an unclosed writable is a lost
  // write, so this must never be fire-and-forget.
  await writable.close();
}

/** @param {FileHandle} handle @returns {Promise<number>} Epoch ms of the file on disk. */
export async function lastModified(handle) {
  return (await handle.getFile()).lastModified;
}

/**
 * Permission without prompting. Used to mark rows that need a reconnect.
 * @param {FileHandle} handle @param {'read'|'readwrite'} [mode]
 * @returns {Promise<'granted'|'denied'|'prompt'>}
 */
export async function permissionState(handle, mode = "readwrite") {
  // OPFS handles (and any future browser without the permission extension)
  // expose no queryPermission. They need no grant, so they count as granted.
  if (typeof handle.queryPermission !== "function") return "granted";
  return handle.queryPermission({ mode });
}

/**
 * Permission, prompting if needed. requestPermission only resolves to
 * "granted" inside a user gesture, so callers outside one must treat false as
 * "ask the user to click something", not as a hard denial.
 * @param {FileHandle} handle @param {'read'|'readwrite'} [mode]
 * @returns {Promise<boolean>}
 */
export async function ensurePermission(handle, mode = "readwrite") {
  if ((await permissionState(handle, mode)) === "granted") return true;
  if (typeof handle.requestPermission !== "function") return false;
  return (await handle.requestPermission({ mode })) === "granted";
}
