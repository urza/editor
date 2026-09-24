// @ts-check
// Document store: the in-memory Map of buffer records and every mutation on
// them. UI never mutates records directly; it dispatches commands, commands
// call methods here, and the store emits events (architecture.md §6).
//
// Events on store.events:
//   "change"  records or their content changed -> sidebar and statusbar re-render
//   "active"  { id, previousId }               -> editor swaps states, UI re-renders
//   "evict"   { id }                           -> editor drops its cached state
//   "save"    { status }                       -> statusbar save indicator
//   "replace" { id, content }                  -> editor replaces a document wholesale
//   "lang"    { id, lang }                     -> editor swaps the language mode
//   "lock"    { ids }                          -> editor drops those states, shows the placeholder
//   "unlock"                                   -> editor re-activates a placeholder
//   "system"  { id }                            -> the hidden keyring record was written
//
// Persistence: every mutation writes through to IndexedDB, content edits with
// a debounce. This is the first stage of the write pipeline (architecture.md
// §1); the disk stage is a second debounce behind it, sync attaches later.
//
// Disk is the source of truth for a file-backed buffer, IndexedDB its journal:
// a denied permission or a vanished file costs the user nothing, because the
// text is already durable before the disk write is even attempted.
//
// Encryption sits between the editor and the record (architecture.md §5,
// §13.4): for a doc with `enc`, `record.content` is age ciphertext and the
// plaintext lives only in the `plain` map below, for as long as the keyring is
// unlocked. Everything under this file (IndexedDB, disk, sync) stays
// byte-agnostic, which is what keeps encryption orthogonal to storage.

import {
  deleteBuffer,
  deleteHandle,
  getAllBuffers,
  getAllHandles,
  getHandle,
  newBufferRecord,
  putBuffer,
  putHandle,
  MAIN_WORKSPACE,
} from "../storage/idb.js";
import {
  ensurePermission,
  lastModified,
  permissionState,
  readFile,
  readFileBytes,
  sameEntry,
  saveFilePicker,
  writeFile,
} from "../storage/fsa.js";
import { isNativeHandle, pickFile } from "../storage/native.js";
import { isDesktop } from "./capabilities.js";
import * as codec from "./codec.js";
import { deviceId } from "./device.js";
import * as age from "../crypto/age.js";
// The keyring record's merge rule lives with the keyring, not here: it is a
// fact about device lists (architecture.md §13.3). This file only knows which
// record it applies to.
import { mergeKeyringContent, readKeyringContent } from "../crypto/keyring.js";
// The one import from editor/ in this layer. Detection is a rule about a
// record, not about a view, and it lives next to the mode table it names
// (editor/lang.js explains why the two stay together).
import { detectFromName, isLang } from "../editor/lang.js";
import { on, post } from "./channel.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */

// Fixed id, not a UUID: every device must arrive at the same record so sync
// merges one keyring instead of forking one per device (architecture.md §13.3).
export const KEYRING_ID = "keyring";
const SAVE_DELAY = 300;
// Second debounce, behind the IndexedDB one: a disk write is slower and more
// fragile, and nothing is lost by batching a few more keystrokes into it.
const DISK_DELAY = 1000;
// Slow poll for external edits. Window focus is the responsive trigger; this
// only covers a window that stays focused while another program writes.
const WATCH_INTERVAL = 30000;
const TITLE_MAX = 40;

/**
 * The first non-blank line of a text, truncated to a row's width. The derived
 * half of titleOf(), split out because encrypt() needs the same rule: it
 * stores that line as the doc's `title` while the plaintext is still readable.
 * @param {string} [text] @returns {string}
 */
export function firstLineTitle(text) {
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) : trimmed;
    }
  }
  return "";
}

/** @param {BufferRecord} record @returns {string} */
export function titleOf(record) {
  // A name the user typed wins over every derived one (architecture.md §7).
  // It is also the label an encrypted doc keeps when its text is unreadable.
  if (record.title) return record.title;

  // A file-backed buffer is named by its file. Deriving the title from the
  // first line would rename someone's file every time they edit line 1.
  if (record.kind === "file" && record.file) return record.file.name;

  // Untitled and encrypted: `content` is ciphertext, so its first line is a
  // row of base64. A doc encrypted in this app is given a title first, so this
  // is the courier case (§5) and a `.age` file with no name of its own.
  if (record.enc) return "encrypted";

  return firstLineTitle(record.content) || "untitled";
}

/**
 * @param {{keyring: import("../crypto/keyring.js").KeyRing,
 *          syncDefault?: () => boolean,
 *          workspaces: ReturnType<typeof import("./workspace.js").createWorkspaces>}} deps
 *   The keyring is a dependency, not an import: the codec resolves recipients
 *   and identities through it, and the store must follow its lock state
 *   (architecture.md §5). `syncDefault` answers "does a new document get a
 *   server target?" (§3, §13.6). A function, not a flag: the answer depends on
 *   a setting and on whether a server is configured at all, and both can change
 *   while the app runs. `workspaces` is this window's workspace and the
 *   others (architecture.md §14): "open" means a tab there, and the store
 *   writes its membership through it, never around it.
 */
export function createDocStore({ keyring, syncDefault = () => false, workspaces }) {
  /** @type {Map<string, BufferRecord>} */
  const buffers = new Map();
  /**
   * Plaintext of the encrypted docs that are readable right now. The record
   * holds ciphertext; this map holds what the editor shows and what the next
   * persist step encrypts. Cleared on lock, and never written anywhere: the
   * whole point is that plaintext lives in memory only (architecture.md §5).
   * @type {Map<string, string>}
   */
  const plain = new Map();
  /** @type {Map<string, number>} */
  const saveTimers = new Map();
  /** @type {Map<string, number>} */
  const diskTimers = new Map();
  // Live handles, keyed by handleId. IndexedDB holds the durable copy; this is
  // the one the app actually calls, loaded once at start.
  /** @type {Map<string, any>} */
  const handles = new Map();
  // handleIds whose permission is not "granted" right now. A stored handle
  // loses its grant on restart unless the PWA holds "allow on every visit".
  /** @type {Set<string>} */
  const needsPermission = new Set();
  // Buffers whose last disk write failed. Purely to log once per buffer
  // instead of once per keystroke.
  /** @type {Set<string>} */
  const diskFailed = new Set();
  // Buffers whose save was skipped because the keyring locked mid-debounce.
  // Same "log once, not once per keystroke" reason as diskFailed.
  /** @type {Set<string>} */
  const encodeSkipped = new Set();
  const events = new EventTarget();
  /** @type {string | null} */
  let activeId = null;

  /** @param {string} type @param {object} [detail] */
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * IndexedDB, then the other windows (architecture.md §14.2). Every buffer
   * write in this module goes through here, so no window ever needs to
   * re-read the store to learn what another one wrote.
   * @param {BufferRecord} record
   */
  async function persist(record) {
    await putBuffer(record);
    post("buffer", { record });
  }

  /** @param {string} id */
  async function remove(id) {
    await deleteBuffer(id);
    post("buffer-deleted", { id });
  }

  // The keyring record (architecture.md §13.3) is a buffer record so that it
  // persists and syncs on the existing path, but it is not a document: it holds
  // the device list, it has no text a user would ever edit, and it must never
  // appear in the sidebar, in Recent, or in search. These two functions are the
  // only way the UI reaches records, so filtering here hides it everywhere.
  // Do not drop this filter to "simplify"; the sidebar would grow a row of raw
  // JSON and closing it would corrupt the keyring.
  /** @param {BufferRecord} record */
  function isDocument(record) {
    return record.kind !== "keyring";
  }

  // This window's tabs, in tab order (architecture.md §14). A tab whose
  // record is gone (deleted elsewhere) is skipped, never shown as a hole.
  function openBuffers() {
    /** @type {BufferRecord[]} */
    const open = [];
    for (const id of workspaces.current().tabs) {
      const record = buffers.get(id);
      if (record && isDocument(record)) open.push(record);
    }
    return open;
  }

  // Recent is global: every document open in no workspace at all. A record
  // waiting for its `deleted` tombstone to be pushed (discard) is already
  // gone as far as the user is concerned.
  function closedBuffers() {
    const open = workspaces.openSet();
    return [...buffers.values()]
      .filter((b) => !open.has(b.id) && isDocument(b) && b.sync?.tombstone !== "deleted")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Mark a record for the next push. A no-op for a local-only record, which is
   * why every writer can call it without asking whether sync is on.
   *
   * Content edits do NOT go through here: they are marked after the codec, in
   * encodeForRecord, so a push always reads the ciphertext that matches the
   * revision it claims (architecture.md §13.4). This is for the metadata
   * writers, whose value is already in the record when they call it.
   * @param {BufferRecord} record
   */
  function markDirty(record) {
    if (record.sync) record.sync.dirty = true;
  }

  /**
   * Write a record the user never opens: the keyring today. It goes into the
   * Map and into IndexedDB like any other, but nothing activates it and no
   * debounce owns it, because no editor is ever attached to it.
   * @param {BufferRecord} record
   */
  async function putSystemRecord(record) {
    buffers.set(record.id, record);
    await persist({ ...record });
    // The keyring resolves "all my devices" against this record, so whoever
    // holds the keyring has to re-read it whenever it is written, here or by a
    // pull. One event for both paths (architecture.md §13.3).
    if (record.kind === "keyring") emit("system", { id: record.id });
    emit("change");
    return record;
  }

  /** The hidden keyring record, or undefined before setup. */
  function keyringRecord() {
    return buffers.get(KEYRING_ID);
  }

  /**
   * The codec stage of the write pipeline (architecture.md §1). It runs here,
   * inside the debounce, and not per keystroke: age is fast, but encrypting
   * every character would still be work nobody asked for.
   *
   * Returns false when the save must be skipped. That happens when the keyring
   * locked between the keystroke and this step: writing then is impossible,
   * and the text is still in the editor state until the lock event drops it.
   * @param {BufferRecord} record @returns {Promise<boolean>}
   */
  async function encodeForRecord(record) {
    if (record.enc) {
      const text = plain.get(record.id);
      if (text === undefined || !keyring.isUnlocked) {
        if (!encodeSkipped.has(record.id)) {
          encodeSkipped.add(record.id);
          console.log("[vrtti] save skipped, locked while typing:", record.id);
        }
        return false;
      }
      record.content = await codec.encode(text, record.enc, keyring);
      encodeSkipped.delete(record.id);
    }
    // After the codec, never in updateContent: a push must always read the
    // ciphertext that matches the revision it claims (architecture.md §13.4).
    if (record.sync) record.sync.dirty = true;
    return true;
  }

  /** @param {string} id */
  function persistSoon(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(
      id,
      setTimeout(async () => {
        saveTimers.delete(id);
        // Disk is stage two: it starts only once the text is durable.
        if (await persistNow(id)) diskSoon(id);
      }, SAVE_DELAY)
    );
  }

  /**
   * Stage one of the write pipeline (architecture.md §1): encode and put the
   * record. Returns false when the keyring is locked and nothing was written.
   * @param {string} id
   */
  async function persistNow(id) {
    const record = buffers.get(id);
    if (!record) return false;
    if (!(await encodeForRecord(record))) {
      // Say so, or the indicator hangs at "…": nothing more happens for
      // this buffer until the keyring is unlocked again.
      if (id === activeId && !saveTimers.has(id)) emit("save", { status: "locked" });
      return false;
    }
    await persist({ ...record });
    // Only claim "saved" if no newer keystroke started another debounce.
    if (id === activeId && !saveTimers.has(id)) {
      emit("save", { status: "saved" });
    }
    return true;
  }

  /**
   * Ctrl+S (desktop-wrapper-tauri-vs-wails.md §11): both debounces, now. An
   * autosaving editor has nothing else to save. A buffer without a disk file
   * lands in IndexedDB and reports "saved"; the caller decides whether that
   * case should open the file picker instead.
   * @param {string} id
   */
  async function saveNow(id) {
    if (!buffers.has(id)) return;
    dropTimers(id);
    if (await persistNow(id)) await writeToDisk(id);
  }

  /**
   * Cancel both debounces of a buffer. For a caller that is about to write
   * the record and the file itself: a timer firing in between would put the
   * text the record held a moment ago back on disk.
   * @param {string} id
   */
  function dropTimers(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    clearTimeout(diskTimers.get(id));
    diskTimers.delete(id);
  }

  /** @param {BufferRecord} [record] @returns {any} */
  function handleFor(record) {
    if (!record || record.kind !== "file" || !record.file) return null;
    return handles.get(record.file.handleId) || null;
  }

  /** @param {string} id */
  function diskSoon(id) {
    if (!handleFor(buffers.get(id))) return;
    clearTimeout(diskTimers.get(id));
    diskTimers.set(
      id,
      setTimeout(() => {
        diskTimers.delete(id);
        writeToDisk(id);
      }, DISK_DELAY)
    );
  }

  /**
   * Set or clear the reconnect marker for one file, and only for a real
   * permission gap: the marker's click can grant a permission and nothing
   * else, so a write that failed for another reason must not raise it.
   * @param {BufferRecord} record
   */
  /**
   * @param {BufferRecord} record
   * @param {any} [err] The failure that prompted the check, when there was one.
   */
  async function refreshPermissionFlag(record, err) {
    const handle = handleFor(record);
    if (!record.file || !handle) return;
    const handleId = record.file.handleId;
    // A native handle is always granted (the root record is the grant). Its
    // one failure is a file that moved or vanished, which Rust answers with
    // notFound; that gets the same reconnect marker, and the click re-picks
    // the file (architecture.md §17).
    const granted = isNativeHandle(handle)
      ? !(err && err.name === "NotFoundError")
      : (await permissionState(handle, "readwrite").catch(() => "granted")) ===
        "granted";
    if (granted === !needsPermission.has(handleId)) return; // already right
    if (granted) needsPermission.delete(handleId);
    else needsPermission.add(handleId);
    emit("change");
  }

  /** @param {string} id */
  async function writeToDisk(id) {
    const record = buffers.get(id);
    const handle = handleFor(record);
    if (!record || !record.file || !handle) return;
    try {
      // A handle restored from IndexedDB can be back in the "prompt" state.
      // Asking here works when a gesture is still in flight; when it is not,
      // the row's reconnect marker gives the user a click that does work.
      if (!(await ensurePermission(handle, "readwrite"))) {
        throw new Error("permission not granted");
      }
      // record.content, always: this layer is byte-agnostic and an encrypted
      // record already holds age ciphertext. A `.age` file opened as binary
      // therefore comes back armored, which is still standard age and still
      // opens with the CLI (architecture.md §13.4).
      await writeFile(handle, record.content);
      record.file.lastSyncAt = Date.now();
      needsPermission.delete(record.file.handleId);
      diskFailed.delete(id);
      // Persist lastSyncAt, or a reload would see the buffer as dirty against
      // its own file and fork a conflict copy out of nothing.
      await persist({ ...record });
      // Clears a "disk write failed" left by an earlier attempt; without this
      // the failure would stay on screen until the next keystroke.
      if (id === activeId && !saveTimers.has(id)) emit("save", { status: "saved" });
      emit("change");
    } catch (err) {
      if (!diskFailed.has(id)) {
        // Once per buffer, not once per keystroke: a file that stays denied
        // would otherwise fill the console while the user keeps typing.
        diskFailed.add(id);
        console.log("[vrtti] disk write failed for", record.file.name, err);
      }
      if (id === activeId) emit("save", { status: "disk write failed" });
      await refreshPermissionFlag(record, err);
    }
  }

  /** @param {string} id */
  function activate(id) {
    if (!buffers.has(id)) return;
    if (id === activeId) {
      // Re-activating the buffer on screen is a no-op for a document, but it
      // is how a locked row asks for the unlock prompt again after a cancel.
      // previousId === id tells the editor "same buffer", so it parks nothing.
      emit("active", { id, previousId: id });
      return;
    }
    const previousId = activeId;
    activeId = id;
    // Persisted on the workspace record, so each window remembers its own.
    workspaces.setActive(id).catch((err) => console.log("[vrtti] active not saved", err));
    emit("active", { id, previousId });
    // The indicator belongs to the buffer on screen. Switching away from a
    // buffer that was still mid-debounce used to leave its "…" behind, because
    // the debounce only reports for the buffer that is active when it lands.
    emit("save", { status: saveTimers.has(id) ? "…" : "saved" });
  }

  /**
   * The editor text of a buffer.
   *
   * A string for a plaintext doc and for an encrypted one whose text is
   * already decoded; a Promise only when a decode really has to run. The split
   * is deliberate: the plaintext path is every doc in the app, and awaiting it
   * would show an empty editor for a frame on every buffer switch.
   *
   * The Promise rejects with LockedError when the keyring is locked or this
   * device is not a recipient. The caller decides what to do about it; the
   * editor shows the locked placeholder and asks for the passphrase.
   *
   * @param {string} id @returns {string | Promise<string>}
   */
  function textOf(id) {
    const record = buffers.get(id);
    if (!record) return "";
    if (!record.enc) return record.content;
    const cached = plain.get(id);
    if (cached !== undefined) return cached;
    return codec.decode(record.content, record.enc, keyring).then((text) => {
      // Not if the user locked while this decode ran: lockAll() already
      // cleared the map, and caching now would put plaintext back into it.
      if (keyring.isUnlocked) plain.set(id, text);
      return text;
    });
  }

  /**
   * Decode ciphertext that is not (yet) a record: an old revision the history
   * dialog fetched (architecture.md §13.6). It goes through this rather than
   * through codec.decode directly, so the keyring stays a dependency of the
   * store and not of a UI module.
   * @param {string} content @param {import("../storage/idb.js").EncMeta} enc
   * @returns {Promise<string>}
   */
  function decodeContent(content, enc) {
    return codec.decode(content, enc, keyring);
  }

  /** @param {string} id @param {string} content */
  function updateContent(id, content) {
    const record = buffers.get(id);
    if (!record) return;
    // For an encrypted doc the comparison is against the plaintext map, never
    // against record.content: the record holds ciphertext, which differs from
    // the text on every save anyway (age wraps a fresh file key each time).
    if (record.enc) {
      // No plaintext in memory means the doc is locked, and the state on
      // screen is the read-only placeholder. Nothing arriving from there is
      // this document's text, so it must never become its content.
      if (!plain.has(id)) return;
      if (plain.get(id) === content) return;
      plain.set(id, content);
    } else {
      // A replace (silent reload from disk) echoes straight back here through
      // the editor's update listener. Without this guard that echo would bump
      // updatedAt past lastSyncAt and make a just-synced buffer look dirty.
      if (record.content === content) return;
      record.content = content;
    }
    record.updatedAt = Date.now();
    if (id === activeId) emit("save", { status: "…" });
    emit("change");
    persistSoon(id);
  }

  /**
   * Record the buffer's language mode (architecture.md §9). The only writer of
   * `lang` and `langSource`.
   *
   * `langSource` is the whole conflict rule: a hand-picked syntax outranks
   * every later automatic guess, and nothing else needs to remember that. The
   * editor asks nothing before it sniffs; it just reports what it saw here.
   *
   * @param {string} id
   * @param {string} lang Language id from editor/lang.js.
   * @param {'auto' | 'user'} source Who decided.
   */
  async function setLang(id, lang, source) {
    const record = buffers.get(id);
    if (!record || !isLang(lang)) return;
    if (source === "auto" && record.langSource === "user") return;
    if (record.lang === lang && record.langSource === source) return;
    record.lang = lang;
    record.langSource = source;
    // Only a hand-picked syntax travels: an "auto" guess is re-derived from the
    // text on every device anyway, and pushing it would make every paste a
    // revision.
    if (source === "user") markDirty(record);
    await persist({ ...record });
    emit("lang", { id, lang });
  }

  /**
   * Set or clear the user label of a buffer (architecture.md §7, §9). An empty
   * name clears it, which puts a scratch buffer back on its first line.
   *
   * updatedAt deliberately stays where it is: it is the dirty-vs-disk test
   * against file.lastSyncAt, and a label writes no text. Bumping it would make
   * a just-saved buffer look edited and fork a conflict copy out of nothing.
   *
   * @param {string} id @param {string} title @returns {Promise<boolean>}
   */
  async function setTitle(id, title) {
    const record = buffers.get(id);
    if (!record) return false;
    const next = title.trim();
    if ((record.title || "") === next) return false;
    if (next) record.title = next;
    else delete record.title;
    // The title is plaintext metadata on the wire (architecture.md §5), so a
    // rename is a push of its own; nothing else would ever carry it.
    markDirty(record);
    await persist({ ...record });
    emit("change");
    return true;
  }

  /**
   * Where this buffer's file sits, for a hover. The native backend knows the
   * absolute path; the browser API only ever told the page the folder-relative
   * one (architecture.md §17).
   * @param {BufferRecord | undefined} record @returns {string}
   */
  function diskPath(record) {
    if (!record || !record.file) return "";
    const handle = handleFor(record);
    if (isNativeHandle(handle)) return handle.fullPath;
    return record.file.path || record.file.name;
  }

  /**
   * Can this buffer's file be renamed where it sits? FileSystemFileHandle.move
   * is Chromium only. Nothing else can rename a picked file, so the UI asks
   * here before it offers a rename that could not work.
   * @param {BufferRecord} record
   */
  function canRenameFile(record) {
    const handle = handleFor(record);
    return Boolean(handle && typeof handle.move === "function");
  }

  /**
   * Rename the file on disk, then follow it in the record. Rejects from
   * handle.move() reach the caller: a taken name is worth reporting, and this
   * only ever runs from a click.
   * @param {string} id @param {string} name @returns {Promise<boolean>}
   */
  async function renameFile(id, name) {
    const record = buffers.get(id);
    const handle = handleFor(record);
    if (!record || !record.file || !handle || !canRenameFile(record)) return false;
    const next = name.trim();
    if (!next || next === record.file.name) return false;
    // move() with a separator in the name would move the file to another
    // directory. A rename box must never do that.
    if (/[\\/]/.test(next)) return false;
    if (!(await ensurePermission(handle, "readwrite"))) return false;

    await moveFile(record, handle, next);
    await persist({ ...record });
    // A new extension is a new language. "auto", so a syntax the user picked
    // by hand survives the rename.
    await setLang(id, detectFromName(next), "auto");
    emit("change");
    return true;
  }

  /**
   * Rename the file on disk and follow it in the record and the handle store.
   * The record is not persisted here: the callers change more than the name
   * in one go and write it once. Rejects from handle.move() reach the caller.
   * @param {BufferRecord} record @param {any} handle @param {string} next
   */
  async function moveFile(record, handle, next) {
    if (!record.file) return;
    const previous = record.file.name;
    await handle.move(next);
    record.file.name = next;
    // path is display only, and its last segment is the file name.
    if (record.file.path) {
      record.file.path = record.file.path.slice(0, -previous.length) + next;
    }
    // The handle record carries the name for the stores that never load a
    // buffer; keep it in step, and keep addedAt as it was. The live handle
    // goes back with it, not the stored copy: a native handle carries its own
    // path and move() just changed it, so the copy in IndexedDB is one rename
    // behind. An FSA handle follows its file by itself and does not care.
    const stored = await getHandle(record.file.handleId);
    if (stored) await putHandle({ ...stored, handle, name: next });
  }

  async function create() {
    const record = newBufferRecord();
    // rev 0 means "never pushed", and dirty gets it into the first push, which
    // attaches it with baseRev null (architecture.md §13.6).
    if (syncDefault()) record.sync = { rev: 0, dirty: true };
    buffers.set(record.id, record);
    await persist(record);
    await workspaces.addTab(record.id);
    activate(record.id);
    emit("change");
    return record;
  }

  // ---- Encryption (architecture.md §5, §13.4) ------------------------------

  /**
   * Forget every decoded text. Runs when the keyring locks, and it is the
   * whole of "locking": the records keep their ciphertext, so nothing is lost
   * and nothing else has to change.
   */
  function lockAll() {
    plain.clear();
    const ids = [...buffers.values()].filter((b) => b.enc).map((b) => b.id);
    // The editor drops the cached states of these docs, which drops their undo
    // history too. Accepted and necessary: an undo buffer is plaintext.
    emit("lock", { ids });
  }

  // The store follows the keyring rather than the other way round: crypto.lock
  // is a keyring command and knows nothing about documents.
  let keyringUnlocked = keyring.isUnlocked;
  keyring.addEventListener("change", () => {
    if (keyringUnlocked === keyring.isUnlocked) return;
    keyringUnlocked = keyring.isUnlocked;
    if (keyringUnlocked) emit("unlock");
    else lockAll();
  });

  /**
   * Can this file change between plaintext and `.age` on disk? Both
   * directions rename the file (architecture.md §19), so a handle that cannot
   * move gets neither; the row menu says so instead of offering half of it.
   * @param {BufferRecord} record
   */
  function canEncryptFile(record) {
    return record.kind !== "file" || canRenameFile(record);
  }

  /**
   * The name a file takes when its content turns into age ciphertext, and
   * the name it takes back (architecture.md §19). `.age` is appended, never
   * substituted: `notes.md.age` still says what is inside, and lang.js strips
   * the envelope when it looks for the language.
   * @param {string} name
   */
  function encryptedName(name) {
    return name + ".age";
  }

  /** @param {string} name */
  function decryptedName(name) {
    const plain = name.replace(/\.age$/i, "");
    // A file called just ".age" keeps its name: an empty one is no name.
    return plain || name;
  }

  /**
   * Turn a plaintext doc into an encrypted one.
   *
   * A file-backed doc changes on disk too: the file is renamed to `.age`
   * first and the ciphertext written second, so the disk never holds age
   * bytes under a plain name (readFileForRecord would take them for text).
   * A failed write renames back, best effort, and the error reaches the
   * caller with the record untouched (architecture.md §19).
   *
   * @param {string} id @param {'all-devices' | 'this-device'} preset
   * @param {string} [label] The plaintext name to store; "" clears the title,
   *   undefined leaves it as it is.
   * @returns {Promise<BufferRecord | null>}
   */
  async function encrypt(id, preset, label) {
    const record = buffers.get(id);
    if (!record || record.enc) return null;
    // The command asks for setup and unlock before it gets here; a throw is
    // for a caller that skipped that, and must not be swallowed.
    if (!keyring.isUnlocked) throw new Error("encrypt: the keyring is locked");
    if (!canEncryptFile(record)) throw new Error("encrypt: this file cannot be renamed");

    const text = record.content;
    const enc = codec.newEncMeta(preset);
    const content = await codec.encode(text, enc, keyring);

    const handle = handleFor(record);
    if (record.file && handle) {
      // The record already holds the latest text (updateContent), so a
      // pending debounce has nothing to add and would only race the writes.
      dropTimers(id);
      if (!(await ensurePermission(handle, "readwrite"))) {
        throw new Error("encrypt: permission not granted");
      }
      const previous = record.file.name;
      await moveFile(record, handle, encryptedName(previous));
      try {
        await writeFile(handle, content);
      } catch (err) {
        await moveFile(record, handle, previous).catch(() => {});
        // Whatever the file is called now, the record says the same.
        await persist({ ...record });
        throw err;
      }
      record.file.lastSyncAt = Date.now();
    }

    // The label is the one plaintext the server ever sees for this doc (§5),
    // so it is never derived here behind the user's back: the command asks,
    // prefilled with the first line, and the user decides what stays readable.
    // No label at all leaves the row saying "encrypted".
    if (label !== undefined) {
      if (label) record.title = label;
      else delete record.title;
    }
    plain.set(id, text);
    record.enc = enc;
    // Immediately, not through persistSoon: the plaintext must not sit in
    // IndexedDB for another 300 ms once the user asked for this.
    record.content = content;
    if (record.sync) {
      // The server still holds the plaintext history of this doc, and old
      // plaintext revisions defeat the whole conversion (architecture.md §5).
      record.sync.purge = true;
      record.sync.dirty = true;
    }
    await persist({ ...record });
    emit("change");
    return record;
  }

  /**
   * The way back. On disk the order is the mirror of encrypt(): the plaintext
   * is written first and the `.age` suffix dropped second, so a failed rename
   * leaves a plain file under an `.age` name, which the reader takes for what
   * it is (architecture.md §19).
   * @param {string} id @returns {Promise<BufferRecord | null>}
   */
  async function decrypt(id) {
    const record = buffers.get(id);
    if (!record || !record.enc) return null;
    if (!keyring.isUnlocked) throw new Error("decrypt: the keyring is locked");
    if (!canEncryptFile(record)) throw new Error("decrypt: this file cannot be renamed");
    const text = await textOf(id);

    const handle = handleFor(record);
    if (record.file && handle) {
      dropTimers(id);
      if (!(await ensurePermission(handle, "readwrite"))) {
        throw new Error("decrypt: permission not granted");
      }
      await writeFile(handle, text);
      record.file.lastSyncAt = Date.now();
      // The rename is the lesser half: the file holds plaintext now whatever
      // it is called, and the record below must follow the file. A taken
      // name is logged, and the `.age` name stays until the user renames it.
      await moveFile(record, handle, decryptedName(record.file.name)).catch((err) => {
        console.log("[vrtti] decrypt: the file keeps its name", record.file?.name, err);
      });
    }

    delete record.enc;
    record.content = text;
    plain.delete(id);
    // The label stays: the user chose it at encrypt time, and "Use first line"
    // in the row menu clears it whenever they want the row to follow the text.
    if (record.sync) record.sync.dirty = true;
    await persist({ ...record });
    emit("change");
    return record;
  }

  // ---- Disk files (architecture.md §2) ------------------------------------

  /**
   * Read a disk file the way a record wants it (architecture.md §13.4).
   *
   * A `.age` file is standard age ciphertext in one of two encodings. Armored
   * text goes into the record as it is; a binary file is armored here, because
   * a record's content is a string all the way down (IndexedDB, sync, the
   * editor). Both encodings are age, and the age CLI reads either, so nothing
   * is lost by picking one. A `.age` file that is neither is just a file with
   * a confusing name, and stays plaintext.
   *
   * Every read of a file into a record goes through this, not readFile: the
   * one that forgets it would open a note full of base64.
   *
   * @param {any} handle @param {string} name
   * @returns {Promise<{content: string, lastModified: number, enc?: import("../storage/idb.js").EncMeta}>}
   */
  async function readFileForRecord(handle, name) {
    if (!/\.age$/i.test(name)) return readFile(handle);
    const { bytes, lastModified } = await readFileBytes(handle);
    // Lossy for binary input, and that is fine: it is only read to test for
    // the armor header, which is ASCII.
    const text = new TextDecoder().decode(bytes);
    if (age.isArmored(text)) {
      return { content: text, lastModified, enc: { v: 1, preset: "all-devices" } };
    }
    if (age.isAgeFile(bytes)) {
      return {
        content: age.armor.encode(bytes),
        lastModified,
        enc: { v: 1, preset: "all-devices" },
      };
    }
    return { content: text, lastModified };
  }

  /** @param {any} handle @returns {Promise<BufferRecord | null>} */
  async function bufferForHandle(handle) {
    for (const record of buffers.values()) {
      const known = handleFor(record);
      // isSameEntry, never a name match: two folders can hold two different
      // files called notes.md.
      if (await sameEntry(known, handle)) return record;
    }
    return null;
  }

  /**
   * Point a record at a disk file: store the handle, convert the record.
   * @param {BufferRecord} record @param {any} handle
   */
  async function linkFile(record, handle) {
    // Re-targeting a file buffer (Save to disk on an already saved buffer):
    // nothing else owns the old handle, so it goes with the link.
    if (record.file) {
      handles.delete(record.file.handleId);
      needsPermission.delete(record.file.handleId);
      await deleteHandle(record.file.handleId);
    }
    const handleId = crypto.randomUUID();
    await putHandle({
      id: handleId,
      kind: "file",
      handle,
      name: handle.name,
      addedAt: Date.now(),
    });
    handles.set(handleId, handle);
    record.kind = "file";
    // lastSyncAt is wall clock, not the file's mtime: it is compared against
    // updatedAt (also wall clock) to decide dirty, and an old mtime would make
    // a file that was just opened look edited.
    record.file = { handleId, name: handle.name, lastSyncAt: Date.now() };
  }

  /**
   * Open a disk file as a buffer. A file that is already open is activated
   * instead of opened twice.
   * @param {any} handle
   * @param {{path?: string}} [options] path is where the file sits inside the
   *   folder it was opened from ("sub/notes.md"). Display only, and absent for
   *   picker-opened files. It must never replace file.name: the name is what
   *   titles the buffer and what the save picker suggests.
   */
  async function createFromFile(handle, options = {}) {
    const existing = await bufferForHandle(handle);
    if (existing) {
      // reopen() knows the three cases: a tab here, a tab in another window,
      // or Recent.
      await reopen(existing.id);
      return existing;
    }
    const { content, enc } = await readFileForRecord(handle, handle.name);
    const record = newBufferRecord();
    record.content = content;
    if (enc) record.enc = enc;
    await linkFile(record, handle);
    // Set here rather than through setLang: the record is not in `buffers`
    // yet, and nothing is listening for it. The first putBuffer below carries
    // the language, so no extra write happens.
    record.lang = detectFromName(handle.name);
    record.langSource = "auto";
    // record.file exists here (linkFile just set it); the check is for ts-check.
    if (options.path && record.file) record.file.path = options.path;
    buffers.set(record.id, record);
    await persist({ ...record });
    await workspaces.addTab(record.id);
    activate(record.id);
    emit("change");
    return record;
  }

  /** @param {BufferRecord} record @returns {string} */
  function suggestedName(record) {
    if (record.file) return record.file.name;
    // Characters no common file system accepts; the picker still lets the user
    // rename, this is only the proposal.
    const base = titleOf(record).replace(/[\\/:*?"<>|]+/g, "-").trim();
    const name = (base || "untitled") + ".md";
    // An encrypted buffer is written as ciphertext, and only an `.age` name
    // is read back as such (architecture.md §19).
    return record.enc ? encryptedName(name) : name;
  }

  /** @param {string} id Write a buffer to a picked file, then keep it linked. */
  async function saveAs(id) {
    const record = buffers.get(id);
    if (!record) return null;
    const handle = await saveFilePicker(suggestedName(record));
    await writeFile(handle, record.content);
    await linkFile(record, handle);
    // The user can type any name into the picker. An encrypted buffer under a
    // plain name would open as a page of armor next time, so the suffix goes
    // back on where the handle allows it.
    if (record.enc && record.file && !/\.age$/i.test(handle.name) && canRenameFile(record)) {
      await moveFile(record, handle, encryptedName(handle.name));
    }
    await persist({ ...record });
    // The buffer now has a file name, and a file name decides the language.
    // "auto", so a syntax the user picked by hand survives the save.
    await setLang(id, detectFromName(handle.name), "auto");
    if (id === activeId) emit("save", { status: "saved" });
    emit("change");
    return record;
  }

  /**
   * Disk wins. The record takes the file's text and the editor swaps it in as
   * one change, so undo history survives (architecture.md §2 replace path).
   * @param {string} id
   */
  async function replaceFromDisk(id) {
    const record = buffers.get(id);
    const handle = handleFor(record);
    if (!record || !record.file || !handle) return;
    const { content, enc } = await readFileForRecord(handle, record.file.name);
    record.content = content;
    // The file decides: a `.age` file that was replaced by plain text on disk
    // stops being encrypted, and the other way round.
    if (enc) record.enc = enc;
    else delete record.enc;
    // The old decoded text belongs to the old ciphertext.
    plain.delete(id);
    record.updatedAt = Date.now();
    record.file.lastSyncAt = record.updatedAt;
    await persist({ ...record });
    await announceReplace(record);
    emit("change");
  }

  /**
   * Tell the editor that a record's text was replaced under it, by the disk
   * poll or by a pull. Shared by both, because the rule is the same and it is
   * easy to get wrong: "replace" carries EDITOR text, so new ciphertext has to
   * be decoded first, and a record this device cannot read has to become a
   * locked placeholder instead of an empty document.
   * @param {BufferRecord} record
   */
  async function announceReplace(record) {
    if (!record.enc) {
      emit("replace", { id: record.id, content: record.content });
      return;
    }
    try {
      emit("replace", { id: record.id, content: await textOf(record.id) });
    } catch (err) {
      emit("lock", { ids: [record.id] });
    }
  }

  /**
   * The local text forks into a scratch buffer, the file buffer then takes the
   * disk version. Nothing is lost and nothing prompts.
   * @param {BufferRecord} record
   */
  async function forkConflict(record) {
    const fork = newBufferRecord();
    if (record.enc) {
      // Ciphertext, copied byte for byte. The usual "conflict copy of …"
      // prefix would corrupt the age file and make the copy undecryptable, so
      // the note goes into the title, which is plaintext by design (§7).
      // Works without any key: a courier device forks conflicts too (§5).
      fork.content = record.content;
      fork.enc = { ...record.enc };
      fork.title = "conflict copy of " + titleOf(record);
    } else {
      fork.content =
        "conflict copy of " +
        (record.file ? record.file.name : titleOf(record)) +
        " (" +
        new Date().toISOString() +
        ")\n\n" +
        record.content;
    }
    buffers.set(fork.id, fork);
    await persist(fork);
    // Open next to the original, so the user sees the copy exists.
    await workspaces.addTab(fork.id);
    // Not activated on purpose: an edit made in another program must never
    // move the caret out of what the user is typing in.
    emit("change");
    return fork;
  }

  // ---- Sync (architecture.md §3, §13.6) ------------------------------------
  //
  // The store owns the whole conflict policy; the sync client only moves rows
  // over the wire and calls in here. That split is what makes the rules
  // testable without a server, and what keeps "when do we fork?" in one file.

  /**
   * One revision row as the server returns it (architecture.md §7, §13.5).
   * @typedef {Object} Change
   * @property {string} docId
   * @property {number} rev
   * @property {number} seq
   * @property {'text' | 'deleted' | 'detached'} kind
   * @property {string | null} [content]
   * @property {RecordMeta | null} [meta]
   * @property {string} deviceId
   * @property {number} clientTime
   * @property {number} serverTime
   */

  /**
   * The metadata that travels with a revision. Small on purpose: the server
   * reads none of it, but it stores all of it in the clear (architecture.md §5),
   * so nothing goes in here that the content itself protects.
   * @typedef {Object} RecordMeta
   * @property {string} [title]
   * @property {string} [lang]
   * @property {'auto' | 'user'} [langSource]
   * @property {import("../storage/idb.js").EncMeta} [enc]
   * @property {'scratch' | 'keyring'} [kind]
   */

  /**
   * Attach or detach a server target (architecture.md §3 "What syncs").
   *
   * Detaching does not remove `sync`: the other devices have to be told, and
   * that is a push like any other. The record loses its `sync` only after that
   * push lands, in clearSync().
   *
   * @param {string} id @param {boolean} on
   */
  async function setSync(id, on) {
    const record = buffers.get(id);
    if (!record) return null;
    if (on) {
      // An already attached record is left alone: overwriting its rev with 0
      // would make the next push claim a revision the server passed long ago.
      if (!record.sync) record.sync = { rev: 0, dirty: true };
      else if (record.sync.tombstone) {
        // Turned off and on again before the tombstone was pushed. The last
        // click wins, so the pending detach is dropped instead of being sent
        // and then undone by a second attach.
        delete record.sync.tombstone;
        record.sync.dirty = true;
      }
    } else {
      if (!record.sync) return null;
      record.sync.tombstone = "detached";
      record.sync.dirty = true;
    }
    await persist({ ...record });
    emit("change");
    return record;
  }

  /** The tombstone push landed: this record is a local one again. @param {string} id */
  async function clearSync(id) {
    const record = buffers.get(id);
    if (!record || !record.sync) return;
    delete record.sync;
    await persist({ ...record });
    emit("change");
  }

  /** The purge call landed; the old plaintext revisions are gone. @param {string} id */
  async function clearPurge(id) {
    const record = buffers.get(id);
    if (!record || !record.sync) return;
    delete record.sync.purge;
    await persist({ ...record });
  }

  /**
   * The body of one push (architecture.md §13.5).
   * @param {BufferRecord} record
   */
  async function pushPayload(record) {
    const tombstone = record.sync?.tombstone;
    /** @type {RecordMeta} */
    const meta = {};
    if (record.title !== undefined) meta.title = record.title;
    if (record.lang !== undefined) meta.lang = record.lang;
    if (record.langSource !== undefined) meta.langSource = record.langSource;
    if (record.enc !== undefined) meta.enc = record.enc;
    // A file-backed doc travels as a scratch doc, always: the disk link is per
    // device (architecture.md §3), and the other device has no such file. Do
    // not "fix" this by sending kind 'file'; it would arrive as a broken link.
    meta.kind = record.kind === "keyring" ? "keyring" : "scratch";
    return {
      // null is "attach without a claim". rev 0 is not a revision the server
      // ever had, so claiming it would 409 for ever on the very first push.
      baseRev: record.sync && record.sync.rev !== 0 ? record.sync.rev : null,
      kind: tombstone ?? "text",
      content: tombstone ? null : record.content,
      meta,
      deviceId: await deviceId(),
      clientTime: record.updatedAt,
    };
  }

  /** Records waiting for a push, keyring first. @returns {BufferRecord[]} */
  function dirtyRecords() {
    return [...buffers.values()]
      .filter((b) => b.sync?.dirty)
      // The keyring goes first: a document encrypted to a device the other end
      // has never heard of is unreadable there, and the device list is what
      // teaches it about that device (architecture.md §13.3).
      .sort((a, b) => Number(b.kind === "keyring") - Number(a.kind === "keyring"));
  }

  /**
   * A push of this record was accepted as `rev`.
   *
   * @param {string} id @param {number} rev
   * @param {number} [sentUpdatedAt] The record's updatedAt as it went out. The
   *   user can type while the request is in flight, and then the server holds
   *   an old text; comparing it here is what keeps that record dirty.
   */
  async function afterPush(id, rev, sentUpdatedAt) {
    const record = buffers.get(id);
    if (!record || !record.sync) return;
    const owner = workspaces.ownerOf(id);
    if (owner && owner !== workspaces.id && (await workspaces.liveSet()).has(owner)) {
      // The owner keeps the record's books (architecture.md §14.3). This
      // copy follows in memory only, so the next push loop already sees the
      // rev; the owner's own persist brings the stored record.
      record.sync.rev = rev;
      record.sync.dirty =
        sentUpdatedAt !== undefined && record.updatedAt !== sentUpdatedAt;
      post("pushed", { ws: owner, id, rev, sentUpdatedAt });
      return;
    }
    // A tombstone push is the last thing this record ever says to the server.
    // A discard (deleted) ends here in the removal; a detach in a local copy.
    if (record.sync.tombstone === "deleted") return forget(id);
    if (record.sync.tombstone) return clearSync(id);
    record.sync.rev = rev;
    record.sync.dirty =
      sentUpdatedAt !== undefined && record.updatedAt !== sentUpdatedAt;
    await persist({ ...record });
    emit("change");
  }

  /**
   * Copy the pulled metadata onto a record. Absent means absent: a title
   * cleared on the other device has to be cleared here, not kept.
   * @param {BufferRecord} record @param {RecordMeta} meta
   */
  function applyMeta(record, meta) {
    if (meta.title !== undefined) record.title = meta.title;
    else delete record.title;
    if (meta.lang !== undefined) record.lang = meta.lang;
    else delete record.lang;
    if (meta.langSource !== undefined) record.langSource = meta.langSource;
    else delete record.langSource;
    if (meta.enc !== undefined) record.enc = meta.enc;
    else delete record.enc;
    // `kind` is deliberately not copied: it is per device. A doc that is
    // file-backed here stays file-backed, and one that arrived as scratch
    // stays scratch even if the other device has it on disk.
  }

  /**
   * Take the incoming version as current.
   * @param {BufferRecord} record @param {Change} change
   */
  async function adoptRemote(record, change) {
    record.content = change.content ?? "";
    applyMeta(record, change.meta || {});
    record.sync = { rev: change.rev, dirty: false };
    record.updatedAt = Date.now();
    // The decoded text belongs to the ciphertext this just replaced.
    plain.delete(record.id);
    await persist({ ...record });
    await announceReplace(record);
    emit("change");
    // A file-backed record mirrors the pull to its own file, the same
    // write-behind a keystroke would take. A no-op for every other record.
    diskSoon(record.id);
  }

  /**
   * The keyring record is the one record that merges instead of forking
   * (architecture.md §13.3): a fork would split the device list in two, and
   * each device would then encrypt to half of the devices.
   * @param {BufferRecord | undefined} record @param {Change} change
   */
  async function applyRemoteKeyring(record, change) {
    const remote = readKeyringContent({ content: change.content ?? "" });
    const merged = mergeKeyringContent(readKeyringContent(record), remote);
    const now = Date.now();
    const next = record ?? {
      id: KEYRING_ID,
      kind: /** @type {'keyring'} */ ("keyring"),
      content: "",
      createdAt: now,
      updatedAt: now,
    };
    next.content = JSON.stringify(merged);
    next.updatedAt = now;
    // Dirty exactly when the union added something the server does not have,
    // so the other devices learn about this one. Comparing the lengths is
    // enough: the merge only ever appends to the incoming list.
    next.sync = {
      rev: change.rev,
      dirty:
        merged.devices.length !== (remote?.devices.length ?? 0) ||
        merged.recovery.length !== (remote?.recovery.length ?? 0),
    };
    await putSystemRecord(next);
  }

  // ---- Routing between windows (architecture.md §14.3) --------------------
  // The sync leader pulls for every window, but a buffer has one writer: its
  // owner. A change for a buffer another live window holds travels to it as
  // remote-change; the owner applies it with its own in-memory text (so the
  // fork-on-dirty rule sees real keystrokes) and answers remote-applied. No
  // answer within ROUTE_TIMEOUT means a frozen or vanished window, and the
  // leader applies the change itself; the owner then takes it as an external
  // replace when it wakes (adoptFromWindow).
  const ROUTE_TIMEOUT = 2000;
  /** @type {Map<string, () => void>} */
  const acks = new Map();

  on("remote-applied", ({ docId, rev }) => {
    acks.get(docId + "@" + rev)?.();
  });

  on("remote-change", ({ ws, change }) => {
    if (ws !== workspaces.id) return;
    applyRemote(change, { local: true })
      .catch((err) => console.log("[vrtti] routed change failed", err))
      .finally(() => post("remote-applied", { docId: change.docId, rev: change.rev }));
  });

  on("pushed", ({ ws, id, rev, sentUpdatedAt }) => {
    if (ws === workspaces.id) void afterPush(id, rev, sentUpdatedAt);
  });

  /**
   * Which live window should apply a pulled change: the buffer's owner, or
   * main for a document nobody has yet. null means this one.
   * @param {string} id @param {BufferRecord | undefined} record @param {RecordMeta} meta
   */
  async function routeTarget(id, record, meta) {
    if (id === KEYRING_ID || meta.kind === "keyring" || record?.kind === "keyring") return null;
    const owner = workspaces.ownerOf(id);
    const target = owner ?? (record ? null : MAIN_WORKSPACE);
    if (!target || target === workspaces.id) return null;
    return (await workspaces.liveSet()).has(target) ? target : null;
  }

  /**
   * @param {string} target @param {Change} change
   * @returns {Promise<boolean>} true when the target applied it
   */
  function deliverRemote(target, change) {
    return new Promise((resolve) => {
      const key = change.docId + "@" + change.rev;
      const timer = setTimeout(() => {
        acks.delete(key);
        resolve(false);
      }, ROUTE_TIMEOUT);
      acks.set(key, () => {
        clearTimeout(timer);
        acks.delete(key);
        resolve(true);
      });
      post("remote-change", { ws: target, change });
    });
  }

  /**
   * Apply one pulled change (architecture.md §13.6). The sync client feeds
   * these in seq order and decides nothing itself.
   * @param {Change} change
   * @param {{local?: boolean}} [options] local: apply here whatever the
   *   ownership says (the receiving end of remote-change).
   */
  async function applyRemote(change, options = {}) {
    if (!change || !change.docId) return;
    const id = change.docId;
    const record = buffers.get(id);
    // Our own echo, or a row already applied. rev is per document and only
    // grows, so this one test covers both.
    if (record && record.sync && change.rev <= record.sync.rev) return;

    const meta = change.meta || {};
    if (!options.local) {
      const target = await routeTarget(id, record, meta);
      if (target && (await deliverRemote(target, change))) return;
    }
    if (id === KEYRING_ID || meta.kind === "keyring" || record?.kind === "keyring") {
      return applyRemoteKeyring(record, change);
    }

    // A tombstone never applies to a record that was just attached by hand
    // (rev 0 = never pushed). The user's "Sync" click happened after that row
    // was written, so the row is either this device's own detach echoing back
    // or another device's delete from before the click. Applying it would make
    // the click silently undo itself, and the push right behind this pull puts
    // a text revision on top of the tombstone anyway.
    const freshAttach = Boolean(record && record.sync && record.sync.rev === 0);
    if ((change.kind === "deleted" || change.kind === "detached") && freshAttach) {
      return;
    }
    // Discarded here as empty, the tombstone not pushed yet (discard). Its
    // dirty flag carries no text worth a fork: a delete from elsewhere just
    // applies, and a newer text below means the document is not empty any
    // more, so it comes back as that text (adoptRemote replaces `sync`, and
    // the tombstone with it).
    const discarded = Boolean(record && record.sync?.tombstone === "deleted");

    if (change.kind === "deleted") {
      // A record without `sync` is a local document, whatever the server
      // thinks: a copy kept after a detach must survive a later delete
      // elsewhere. Same rule as the detached branch below.
      if (!record || !record.sync) return;
      // Deleted elsewhere while this device still held unpushed text. The text
      // survives as a local copy; the record itself goes.
      if (record.sync?.dirty && !discarded) await forkConflict(record);
      buffers.delete(id);
      plain.delete(id);
      await remove(id);
      await workspaces.removeTab(id);
      emit("evict", { id });
      if (id === activeId) {
        // Null first, so the next activate() parks nothing into a record that
        // no longer exists (same rule as close()).
        activeId = null;
        const next = openBuffers()[0];
        if (next) activate(next.id);
        else await create();
      }
      emit("change");
      return;
    }

    if (change.kind === "detached") {
      if (!record || !record.sync) return;
      // "Stop syncing" is not "delete" (architecture.md §3): the text stays,
      // as a local document.
      delete record.sync;
      await persist({ ...record });
      emit("change");
      return;
    }

    if (!record) {
      /** @type {BufferRecord} */
      const created = {
        id,
        content: change.content ?? "",
        createdAt: Date.now(),
        // The other device's clock: it is what the row's age should show, and
        // this device never saw the document before now.
        updatedAt: change.clientTime || Date.now(),
        sync: { rev: change.rev, dirty: false },
      };
      applyMeta(created, meta);
      buffers.set(id, created);
      await persist({ ...created });
      // A document that arrives from sync opens in the main workspace (§14).
      await workspaces.addTab(id, MAIN_WORKSPACE);
      emit("change");
      return;
    }

    if (record.sync) {
      // The incoming version wins and the local text forks. Nothing is lost
      // and nothing prompts (architecture.md §3).
      if (record.sync.dirty && !discarded) await forkConflict(record);
    } else if (record.content !== change.content) {
      // Detached here, then edited on either side. Re-attaching must not drop
      // the local text; equal content needs no fork, which is what makes a
      // detach and re-attach round trip quietly.
      await forkConflict(record);
    }
    await adoptRemote(record, change);
  }

  /**
   * A scratch buffer built from text the user did not type: the history
   * dialog's "open as copy" (architecture.md §13.6).
   *
   * Deliberately without `sync`, like a conflict copy: an old revision opened
   * as a copy must never push itself back over the current one.
   *
   * @param {{content: string, title?: string, lang?: string,
   *          langSource?: 'auto' | 'user',
   *          enc?: import("../storage/idb.js").EncMeta}} fields
   */
  async function createFrom(fields) {
    const record = newBufferRecord();
    record.content = fields.content;
    if (fields.title) record.title = fields.title;
    if (fields.lang) record.lang = fields.lang;
    if (fields.langSource) record.langSource = fields.langSource;
    if (fields.enc) record.enc = fields.enc;
    buffers.set(record.id, record);
    await persist({ ...record });
    await workspaces.addTab(record.id);
    activate(record.id);
    emit("change");
    return record;
  }

  // Compare disk against every open file buffer. Timestamps only, no hashing.
  // FileSystemObserver replaces this poll when it is stable.
  let watching = false;
  async function checkExternalChanges() {
    // Alt-tabbing fires focus again while a pass is still awaiting disk IO.
    // Two overlapping passes would see the same change and fork it twice.
    if (watching) return;
    watching = true;
    try {
      await comparePass();
    } finally {
      watching = false;
    }
  }

  async function comparePass() {
    for (const record of openBuffers()) {
      const handle = handleFor(record);
      if (!handle || !record.file) continue;
      // Our own write is still queued; it is about to set the file's mtime, so
      // there is nothing external to find yet.
      if (diskTimers.has(record.id)) continue;
      try {
        if ((await lastModified(handle)) <= record.file.lastSyncAt) continue;
        const { content } = await readFileForRecord(handle, record.file.name);
        // Two encryptions of the same text give different bytes, so this
        // shortcut simply never fires for a `.age` file. Correct, only slower:
        // a touched `.age` file takes the replace path instead.
        if (content === record.content) {
          // Same bytes: a touch, or a clock that runs ahead of ours. Move the
          // stamp so this file stops re-triggering on every poll.
          record.file.lastSyncAt = Date.now();
          continue;
        }
        // Dirty means the buffer holds edits the file never saw.
        if (record.updatedAt > record.file.lastSyncAt) await forkConflict(record);
        await replaceFromDisk(record.id);
      } catch (err) {
        // Unreadable: permission dropped, or the file is gone. A poll must
        // never throw, and only the first case earns a reconnect marker.
        await refreshPermissionFlag(record, err);
      }
    }
  }

  /** @param {BufferRecord} record Does this buffer's file need a permission grant? */
  function needsReconnect(record) {
    return Boolean(record.file && needsPermission.has(record.file.handleId));
  }

  /**
   * Runs from a click, which is the only context where requestPermission may
   * prompt. On success the pending text goes to disk immediately.
   * @param {string} id
   */
  async function reconnect(id) {
    const record = buffers.get(id);
    const handle = handleFor(record);
    if (!record || !record.file || !handle) return false;
    const handleId = record.file.handleId;
    if (isDesktop) {
      // In the shell a reconnect is always a fresh pick. Either the record is
      // from before the native backend and holds a WebView2 handle, which
      // cannot tell Rust which file it points at, or it is a native root whose
      // file moved or vanished (architecture.md §17, "Mixed handles"). The
      // picker runs from this click because a click is the only place a
      // picker may open. Same handle id, so the buffer keeps its link and its
      // text.
      let picked;
      try {
        picked = await pickFile();
      } catch (err) {
        if (err && /** @type {any} */ (err).name === "AbortError") return false;
        throw err;
      }
      handles.set(handleId, picked);
      const stored = await getHandle(handleId);
      await putHandle({
        id: handleId,
        kind: "file",
        handle: picked,
        name: picked.name,
        addedAt: stored ? stored.addedAt : Date.now(),
      });
      record.file.name = picked.name;
      await persist({ ...record });
    } else if (!(await ensurePermission(handle, "readwrite"))) {
      return false;
    }
    needsPermission.delete(handleId);
    await writeToDisk(id);
    await checkExternalChanges();
    return true;
  }

  /**
   * An empty scratch buffer never reaches Recent (user decision, 2026-09-24):
   * a Recent full of "untitled" rows with nothing in them is noise. Empty
   * means no text, no name of its own, not on disk and readable: a locked
   * doc's content is ciphertext, and a blank file is still a file.
   * @param {BufferRecord} record
   */
  function isEmpty(record) {
    return (
      isDocument(record) &&
      record.kind !== "file" &&
      !record.enc &&
      !record.title &&
      record.content.trim() === ""
    );
  }

  /**
   * Drop a record for good. One the server holds (pushed at least once) goes
   * as a `deleted` tombstone, so the other devices drop their copy too
   * (architecture.md §3); afterPush turns the landed push into the removal,
   * and closedBuffers() hides the record until then. Anything else is
   * removed on the spot. Callers take the record out of the tabs themselves.
   * @param {BufferRecord} record
   */
  async function discard(record) {
    if (record.sync && record.sync.rev > 0) {
      record.sync.tombstone = "deleted";
      record.sync.dirty = true;
      record.updatedAt = Date.now();
      await persist({ ...record });
      emit("change");
      return;
    }
    await forget(record.id);
  }

  /** The record is gone: from memory, IndexedDB and the other windows. @param {string} id */
  async function forget(id) {
    buffers.delete(id);
    plain.delete(id);
    await remove(id);
    emit("change");
  }

  /**
   * Discard the empty documents among these ids that are open nowhere. Runs
   * once at start over everything closed (the rows that piled up before the
   * rule existed, and the tabs of windows quit mid-way), and over a dissolved
   * workspace's tabs, which is how a folder window's untouched first buffer
   * would otherwise land in Recent. Only ids handed in are looked at: a sweep
   * over every closed record on each workspace change could hit a buffer
   * another window has persisted but not tabbed yet.
   * @param {string[]} ids
   */
  async function discardEmpty(ids) {
    const open = workspaces.openSet();
    for (const id of ids) {
      const record = buffers.get(id);
      if (!record || open.has(id) || record.sync?.tombstone === "deleted") continue;
      if (isEmpty(record)) await discard(record);
    }
  }

  // The point of the whole app: closing never asks anything. Close means
  // "leave this workspace": the buffer goes to Recent, and the tab beside it
  // takes the screen (architecture.md §14). An empty buffer goes nowhere.
  /** @param {string} id */
  async function close(id) {
    const record = buffers.get(id);
    const index = workspaces.current().tabs.indexOf(id);
    if (!record || index < 0) return;
    emit("evict", { id });
    if (isEmpty(record)) {
      await discard(record);
    } else {
      record.updatedAt = Date.now();
      await persist({ ...record });
    }
    await workspaces.removeTab(id);

    if (id === activeId) {
      // Null first: the next activate() must see no previousId, or the editor
      // would park its live state back into the buffer we just evicted.
      activeId = null;
      const open = openBuffers();
      const next = open[Math.min(index, open.length - 1)];
      if (next) activate(next.id);
      else await create();
    }
    emit("change");
  }

  /**
   * Bring a buffer into this workspace. Three cases: already a tab here
   * (activate), a tab in another window (that window should come forward,
   * unit 14.2), or Recent (take it).
   * @param {string} id
   */
  async function reopen(id) {
    const record = buffers.get(id);
    if (!record) return;
    const owner = workspaces.ownerOf(id);
    if (owner === workspaces.id) return activate(id);
    if (owner !== null) {
      // Open in another window: that window comes forward, this one stays.
      post("focus", { ws: owner });
      return;
    }
    record.updatedAt = Date.now();
    await persist({ ...record });
    await workspaces.addTab(id);
    activate(id);
    emit("change");
  }

  async function load() {
    for (const record of await getAllBuffers()) buffers.set(record.id, record);
    // Handles come back from IndexedDB with their permission possibly back at
    // "prompt". Nothing prompts here: that needs a user gesture, and a file
    // buffer opens from its IndexedDB copy either way.
    for (const stored of await getAllHandles()) {
      // The store also holds directory handles for opened folders
      // (model/folders.js owns those). A directory handle here would be a file
      // handle that cannot read.
      if (stored.kind === "directory") continue;
      handles.set(stored.id, stored.handle);
      if ((await permissionState(stored.handle)) !== "granted") {
        needsPermission.add(stored.id);
      }
    }
  }

  // ---- Other windows (architecture.md §14.2) ------------------------------

  // A record written in another window. Two rules. A buffer in this window's
  // tabs has one writer, this window, so an incoming copy of it is an
  // external replace (until unit 14.3 routes the sync leader's applies to the
  // owner, this is how they land), and keystrokes still waiting in a debounce
  // here win over it. Any other record is simply the newer copy.
  on("buffer", ({ record }) => {
    void adoptFromWindow(record);
  });

  on("buffer-deleted", ({ id }) => {
    void evictFromWindow(id);
  });

  /** @param {BufferRecord} record */
  async function adoptFromWindow(record) {
    const id = record.id;
    const mine = workspaces.current().tabs.includes(id);
    if (mine && (saveTimers.has(id) || diskTimers.has(id))) return;
    const previous = buffers.get(id);
    buffers.set(id, record);
    const contentChanged =
      !previous ||
      previous.content !== record.content ||
      Boolean(previous.enc) !== Boolean(record.enc);
    // The decoded text belongs to the old ciphertext.
    if (contentChanged) plain.delete(id);
    if (record.kind === "keyring") {
      emit("system", { id });
      emit("change");
      return;
    }
    if (mine && contentChanged) await announceReplace(record);
    emit("change");
  }

  /** @param {string} id */
  async function evictFromWindow(id) {
    if (!buffers.has(id)) return;
    buffers.delete(id);
    plain.delete(id);
    emit("evict", { id });
    if (workspaces.current().tabs.includes(id)) await workspaces.removeTab(id);
    if (id === activeId) {
      activeId = null;
      const next = openBuffers()[0];
      if (next) activate(next.id);
      else await create();
    }
    emit("change");
  }

  // A workspace change this store did not ask for: another window wrote a
  // record, a workspace dissolved into Recent, a double take was lost. The
  // active buffer has to stay inside the tabs, and the UI has to redraw. Own
  // tab writes are skipped: close() moves the active buffer to the neighbour
  // itself, and this would pre-empt it with the first tab.
  workspaces.events.addEventListener("change", (event) => {
    if (!(/** @type {CustomEvent} */ (event).detail?.foreign)) return;
    // This window is being closed and its workspace is gone: creating a
    // buffer now would write the workspace back (see workspace.js).
    if (workspaces.isDissolved) return;
    const tabs = workspaces.current().tabs;
    if (activeId && !tabs.includes(activeId)) {
      activeId = null;
      const next = openBuffers()[0];
      if (next) activate(next.id);
      else void create();
    }
    emit("change");
  });

  // A workspace this window dissolved (its window is gone): its tabs are in
  // Recent now, and the empty ones do not belong there.
  workspaces.events.addEventListener("dissolved", (event) => {
    const tabs = /** @type {CustomEvent} */ (event).detail?.tabs ?? [];
    void discardEmpty(tabs);
  });

  // Separate from load(): UI modules mount between the two, so they are
  // subscribed before the first "active" event fires.
  async function start() {
    await discardEmpty(closedBuffers().map((b) => b.id));
    let first = openBuffers()[0];
    if (!first) {
      first = newBufferRecord();
      buffers.set(first.id, first);
      await persist(first);
      await workspaces.addTab(first.id);
    }

    const stored = workspaces.current().activeId;
    const target =
      stored && buffers.has(stored) && workspaces.current().tabs.includes(stored)
        ? stored
        : first.id;

    activate(target);
    emit("save", { status: "saved" });
    emit("change");

    // External change detection. Focus is the trigger that matters: the user
    // comes back from the program that wrote the file. The interval only
    // covers a window that never lost focus. Both are no-ops with no file
    // buffers open, so no platform check is needed here.
    window.addEventListener("focus", () => checkExternalChanges());
    setInterval(checkExternalChanges, WATCH_INTERVAL);
    checkExternalChanges();
  }

  return {
    events,
    buffers,
    get activeId() {
      return activeId;
    },
    /** @param {string} id */
    get(id) {
      return buffers.get(id);
    },
    openBuffers,
    closedBuffers,
    putSystemRecord,
    keyringRecord,
    load,
    start,
    create,
    close,
    reopen,
    activate,
    textOf,
    decodeContent,
    updateContent,
    // For the editor's locked placeholder: a LockedError while the keyring is
    // unlocked means this device is not a recipient, and no prompt can help.
    get isUnlocked() {
      return keyring.isUnlocked;
    },
    encrypt,
    decrypt,
    lockAll,
    // Exported for the sync client (architecture.md §13.6): a pull that meets
    // a dirty local record forks it before it adopts the incoming one.
    forkConflict,
    // The sync surface (architecture.md §13.6). The client owns the network
    // and the schedule; every one of these owns a rule about records.
    setSync,
    clearSync,
    clearPurge,
    applyRemote,
    pushPayload,
    dirtyRecords,
    afterPush,
    createFrom,
    setLang,
    setTitle,
    canRenameFile,
    canEncryptFile,
    renameFile,
    diskPath,
    createFromFile,
    saveAs,
    saveNow,
    replaceFromDisk,
    checkExternalChanges,
    needsReconnect,
    reconnect,
  };
}
