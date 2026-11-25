// @ts-check
// The disk facade (architecture.md §2, §17). Two backends live behind it: the
// browser's File System Access API, wrapped thinly, and the desktop shell's
// native backend (storage/native.js). Only the pickers differ; after a pick
// both hand back a handle with the same twelve methods, so everything below
// the pickers is one code path. This module knows nothing about buffers or
// records: it only turns handles into text and text into files. model/docs.js
// owns the policy.
//
// Three rules hold this layer together:
//  - Every entry point is read off `window` at call time, never destructured at
//    import time. The tests stub window.showOpenFilePicker / showSaveFilePicker
//    with OPFS handles, and a stub installed after this module loads must still
//    win.
//  - Nothing is caught here. A denied permission, a deleted file, or a
//    cancelled picker is a decision for the caller, not a silent failure.
//    sameEntry() and queryState() are the two exceptions, and each says why
//    at its catch.
//  - The permission query has a time limit (queryState), and a handle that
//    gave no answer to it gets no read (refuseSilent). No other disk call has
//    a limit, on purpose: model/timelimit.js says why.

import { isDesktop } from "../model/capabilities.js";
import { LIMITS, isNoAnswer, withTimeLimit } from "../model/timelimit.js";
import { isNativeHandle, pickFile, pickFolder, pickSave } from "./native.js";

/** @typedef {any} FileHandle FileSystemFileHandle; no lib.dom types without a build step. */
/** @typedef {any} DirHandle FileSystemDirectoryHandle. */
/** @typedef {{ name: string, kind: 'file'|'directory', handle: any }} DirEntry */

// The three pickers test isDesktop before the browser API, never the other way
// round: WebView2 on Windows has both, and the shell must take the native path
// there too (architecture.md §17). It is the one place a backend is chosen; a
// handle carries its own backend from then on.

/**
 * @returns {Promise<FileHandle>} Rejects with AbortError when the user cancels.
 */
export async function openFilePicker() {
  if (isDesktop) return pickFile();
  const handles = await window.showOpenFilePicker({ multiple: false });
  return handles[0];
}

/**
 * @returns {Promise<DirHandle>} Rejects with AbortError when the user cancels.
 */
export async function openDirectoryPicker() {
  if (isDesktop) return pickFolder();
  // "readwrite" up front: the tree exists to open files for editing, and a
  // second prompt on the first save would be the worse moment to ask.
  return window.showDirectoryPicker({ mode: "readwrite" });
}

/**
 * When a handle last gave no answer to its permission query (queryState), in
 * epoch ms. A WeakMap, so an entry goes away with its handle object.
 */
const silentAt = new WeakMap();

/**
 * A read on a handle that gave no answer to its permission query is refused
 * with NotAllowedError, the way a browser refuses a read on a handle with no
 * grant. Without this the query has a limit and the read behind it has none:
 * the app starts, and then the tab of that file stays empty with no message,
 * because getFile() on the same handle gives no answer either, and the
 * external-change pass waits behind that read for ever (model/docs.js,
 * `watching`).
 *
 * The refusal goes through queryState(), and that is what keeps it safe.
 * adoptRemote() in model/docs.js takes a stat that failed to mean "the write
 * fails the same way" and then writes with no check of the file time. So a
 * stat may be refused only when the write right after it is refused too.
 * queryState() answers "silent" from its memo for LIMITS.silentFor, with no
 * new question, and ensurePermission() in front of that write gets the same
 * answer. LIMITS.silentFor after the last refusal the handle is asked again,
 * and a handle that answers is read as before.
 * @param {any} handle
 */
async function refuseSilent(handle) {
  // The usual case first and with no query: a handle that always answered.
  if (!silentAt.has(handle)) return;
  if ((await queryState(handle, "read")) === "silent") {
    // The refusal starts the memo again. A refusal that came from a memo near
    // its end would otherwise leave a gap: the write that follows could ask
    // the handle again, get an answer, and go out with no check.
    silentAt.set(handle, Date.now());
    throw new DOMException("no answer from the handle of " + handle.name, "NotAllowedError");
  }
}

/**
 * One directory level, in the order the sidebar draws it: directories first,
 * then files, each group A-Z. Sorting here keeps the tree renderer dumb.
 * @param {DirHandle} dirHandle @returns {Promise<DirEntry[]>}
 */
export async function listDirectory(dirHandle) {
  await refuseSilent(dirHandle);
  /** @type {DirEntry[]} */
  const entries = [];
  for await (const handle of dirHandle.values()) {
    entries.push({ name: handle.name, kind: handle.kind, handle });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    // localeCompare, not <: it sorts "Zebra" before "apple" the way a file
    // manager does, instead of by code point.
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/** @param {string} suggestedName @returns {Promise<FileHandle>} */
export async function saveFilePicker(suggestedName) {
  if (isDesktop) return pickSave(suggestedName);
  return window.showSaveFilePicker({ suggestedName });
}

/**
 * "Are these two handles the same file or folder?" A Windows shell can hold
 * both families at once until a reconnect migrates the old records
 * (architecture.md §17), and a native handle knows nothing about an FSA one,
 * so a mixed pair is false without a call.
 * @param {any} a @param {any} b @returns {Promise<boolean>}
 */
export async function sameEntry(a, b) {
  if (!a || !b) return false;
  if (isNativeHandle(a) !== isNativeHandle(b)) return false;
  try {
    return await a.isSameEntry(b);
  } catch {
    // The one place this layer swallows: isSameEntry throws for an entry that
    // has vanished, and "not the same file" is the answer both callers want.
    return false;
  }
}

/** @param {FileHandle} handle @returns {Promise<{content: string, lastModified: number}>} */
export async function readFile(handle) {
  await refuseSilent(handle);
  const file = await handle.getFile();
  return { content: await file.text(), lastModified: file.lastModified };
}

/**
 * The same file as bytes. `.age` files exist in two standard encodings, and
 * the binary one is not text: decoding it as UTF-8 first would mangle it
 * beyond repair, so the caller that may meet one reads it here instead
 * (model/docs.js, architecture.md §13.4).
 * @param {FileHandle} handle @returns {Promise<{bytes: Uint8Array, lastModified: number}>}
 */
export async function readFileBytes(handle) {
  await refuseSilent(handle);
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified };
}

/**
 * @param {FileHandle} handle @param {string} content
 * @param {{expectedMtime?: number}} [opts]
 * @returns {Promise<{mtime?: number} | undefined>}
 */
export async function writeFile(handle, content, opts) {
  if (isNativeHandle(handle) && typeof handle.writeAtomic === "function") {
    return handle.writeAtomic(content, opts?.expectedMtime);
  }
  const writable = await handle.createWritable();
  await writable.write(content);
  // The file on disk only changes on close(); an unclosed writable is a lost
  // write, so this must never be fire-and-forget.
  await writable.close();
  return undefined;
}

/**
 * A file in a picked folder, made when it is not there: the backup of a space
 * (architecture.md §27). Both backends take the same call; the native one
 * makes the file at its first write.
 * @param {DirHandle} dir @param {string} name @returns {Promise<FileHandle>}
 */
export function fileIn(dir, name) {
  return dir.getFileHandle(name, { create: true });
}

/** @param {FileHandle} handle @returns {Promise<number>} Epoch ms of the file on disk. */
export async function lastModified(handle) {
  await refuseSilent(handle);
  return (await handle.getFile()).lastModified;
}

/**
 * The permission query, with one more answer: "silent", when the handle gave
 * none in LIMITS.query. This is the call that stopped the app start on
 * 2026-11-25 (architecture.md §30): store.load() and folders.load() ask every
 * stored handle before the first mount.
 * @param {FileHandle} handle @param {'read'|'readwrite'} mode
 * @returns {Promise<'granted'|'denied'|'prompt'|'silent'>}
 */
async function queryState(handle, mode) {
  // OPFS handles (and any future browser without the permission extension)
  // expose no queryPermission. They need no grant, so they count as granted.
  if (typeof handle.queryPermission !== "function") return "granted";
  // Not asked again for LIMITS.silentFor. A stat that was just refused and
  // the write that follows it must get the same answer (refuseSilent says
  // why), and a save must not wait for the limit twice in a row.
  const at = silentAt.get(handle);
  if (at !== undefined && Date.now() - at < LIMITS.silentFor) return "silent";
  try {
    const state = await withTimeLimit(
      handle.queryPermission({ mode }),
      LIMITS.query,
      "permission of " + handle.name
    );
    silentAt.delete(handle);
    return state;
  } catch (err) {
    // Caught here, against the rule at the top: every caller wants a state,
    // and "no answer" is one. Any other failure still goes to the caller.
    if (!isNoAnswer(err)) throw err;
    silentAt.set(handle, Date.now());
    return "silent";
  }
}

/**
 * Permission without prompting. Used to mark rows that need a reconnect.
 * @param {FileHandle} handle @param {'read'|'readwrite'} [mode]
 * @returns {Promise<'granted'|'denied'|'prompt'>}
 */
export async function permissionState(handle, mode = "readwrite") {
  const state = await queryState(handle, mode);
  // No answer is no grant. "prompt" puts the reconnect mark on the row, the
  // same as a grant that the browser took back.
  return state === "silent" ? "prompt" : state;
}

/**
 * Permission, prompting if needed. requestPermission only resolves to
 * "granted" inside a user gesture, so callers outside one must treat false as
 * "ask the user to click something", not as a hard denial.
 * @param {FileHandle} handle @param {'read'|'readwrite'} [mode]
 * @returns {Promise<boolean>}
 */
export async function ensurePermission(handle, mode = "readwrite") {
  const state = await queryState(handle, mode);
  if (state === "granted") return true;
  // A handle that gave no answer to the query gets no request. A request has
  // no time limit, because it waits for the user. On such a handle it would
  // hold the save that asked (model/docs.js, writeBody) with the text in
  // memory only. `false` sends that save to its failure path, which keeps
  // the text in the database row and marks the row for a reconnect.
  if (state === "silent") return false;
  if (typeof handle.requestPermission !== "function") return false;
  return (await handle.requestPermission({ mode })) === "granted";
}
