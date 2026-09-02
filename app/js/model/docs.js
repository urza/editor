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
  deleteHandle,
  getAllBuffers,
  getAllHandles,
  getHandle,
  newBufferRecord,
  putBuffer,
  putHandle,
} from "../storage/idb.js";
import {
  ensurePermission,
  lastModified,
  permissionState,
  readFile,
  readFileBytes,
  saveFilePicker,
  writeFile,
} from "../storage/fsa.js";
import * as codec from "./codec.js";
import * as age from "../crypto/age.js";
// The one import from editor/ in this layer. Detection is a rule about a
// record, not about a view, and it lives next to the mode table it names
// (editor/lang.js explains why the two stay together).
import { detectFromName, isLang } from "../editor/lang.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */

const ACTIVE_KEY = "vrtti.activeBuffer";
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
function firstLineTitle(text) {
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
 * @param {{keyring: import("../crypto/keyring.js").KeyRing}} deps The keyring is
 *   a dependency, not an import: the codec resolves recipients and identities
 *   through it, and the store must follow its lock state (architecture.md §5).
 */
export function createDocStore({ keyring }) {
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

  function openBuffers() {
    return [...buffers.values()]
      .filter((b) => !b.closed && isDocument(b))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function closedBuffers() {
    return [...buffers.values()]
      .filter((b) => b.closed && isDocument(b))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Write a record the user never opens: the keyring today. It goes into the
   * Map and into IndexedDB like any other, but nothing activates it and no
   * debounce owns it, because no editor is ever attached to it.
   * @param {BufferRecord} record
   */
  async function putSystemRecord(record) {
    buffers.set(record.id, record);
    await putBuffer({ ...record });
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
        const record = buffers.get(id);
        if (!record) return;
        if (!(await encodeForRecord(record))) {
          // Say so, or the indicator hangs at "…": nothing more happens for
          // this buffer until the keyring is unlocked again.
          if (id === activeId && !saveTimers.has(id)) emit("save", { status: "locked" });
          return;
        }
        await putBuffer({ ...record });
        // Only claim "saved" if no newer keystroke started another debounce.
        if (id === activeId && !saveTimers.has(id)) {
          emit("save", { status: "saved" });
        }
        // Disk is stage two: it starts only once the text is durable.
        diskSoon(id);
      }, SAVE_DELAY)
    );
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
  async function refreshPermissionFlag(record) {
    const handle = handleFor(record);
    if (!record.file || !handle) return;
    const handleId = record.file.handleId;
    const granted =
      (await permissionState(handle, "readwrite").catch(() => "granted")) ===
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
      await putBuffer({ ...record });
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
      await refreshPermissionFlag(record);
    }
  }

  /** @param {string} id */
  function activate(id) {
    if (!buffers.has(id) || id === activeId) return;
    const previousId = activeId;
    activeId = id;
    localStorage.setItem(ACTIVE_KEY, id);
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
    await putBuffer({ ...record });
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
    await putBuffer({ ...record });
    emit("change");
    return true;
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

    const previous = record.file.name;
    await handle.move(next);
    record.file.name = next;
    // path is display only, and its last segment is the file name.
    if (record.file.path) {
      record.file.path = record.file.path.slice(0, -previous.length) + next;
    }
    // The handle record carries the name for the stores that never load a
    // buffer; keep it in step, and keep addedAt as it was.
    const stored = await getHandle(record.file.handleId);
    if (stored) await putHandle({ ...stored, name: next });
    await putBuffer({ ...record });
    // A new extension is a new language. "auto", so a syntax the user picked
    // by hand survives the rename.
    await setLang(id, detectFromName(next), "auto");
    emit("change");
    return true;
  }

  async function create() {
    const record = newBufferRecord();
    buffers.set(record.id, record);
    await putBuffer(record);
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
   * Turn a plaintext doc into an encrypted one.
   *
   * Scratch docs only this round: encrypting a file-backed doc means renaming
   * it to `.age` on disk, which is a later unit (architecture.md §13.4).
   *
   * @param {string} id @param {'all-devices' | 'this-device'} preset
   * @returns {Promise<BufferRecord | null>}
   */
  async function encrypt(id, preset) {
    const record = buffers.get(id);
    if (!record || record.enc) return null;
    // The command asks for setup and unlock before it gets here; a throw is
    // for a caller that skipped that, and must not be swallowed.
    if (!keyring.isUnlocked) throw new Error("encrypt: the keyring is locked");
    if (record.kind === "file") throw new Error("encrypt: files come in a later unit");

    const text = record.content;
    // The last moment the first line is readable. Without a title the row
    // would read "encrypted" forever, because nothing else can name it.
    if (!record.title) {
      const derived = firstLineTitle(text);
      if (derived) record.title = derived;
    }
    plain.set(id, text);
    record.enc = codec.newEncMeta(preset);
    // Immediately, not through persistSoon: the plaintext must not sit in
    // IndexedDB for another 300 ms once the user asked for this.
    record.content = await codec.encode(text, record.enc, keyring);
    if (record.sync) {
      // The server still holds the plaintext history of this doc, and old
      // plaintext revisions defeat the whole conversion (architecture.md §5).
      record.sync.purge = true;
      record.sync.dirty = true;
    }
    await putBuffer({ ...record });
    emit("change");
    return record;
  }

  /** @param {string} id @returns {Promise<BufferRecord | null>} */
  async function decrypt(id) {
    const record = buffers.get(id);
    if (!record || !record.enc) return null;
    if (!keyring.isUnlocked) throw new Error("decrypt: the keyring is locked");
    const text = await textOf(id);
    delete record.enc;
    record.content = text;
    plain.delete(id);
    // A title that encrypt() derived from the first line, and that the user
    // never changed, goes too: the row follows the text again, as it did
    // before. A title the user typed differs from the derived one and stays.
    if (record.title && record.title === firstLineTitle(text)) delete record.title;
    if (record.sync) record.sync.dirty = true;
    await putBuffer({ ...record });
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
      if (known && (await known.isSameEntry(handle))) return record;
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
      if (existing.closed) await reopen(existing.id);
      else activate(existing.id);
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
    await putBuffer({ ...record });
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
    return (base || "untitled") + ".md";
  }

  /** @param {string} id Write a buffer to a picked file, then keep it linked. */
  async function saveAs(id) {
    const record = buffers.get(id);
    if (!record) return null;
    const handle = await saveFilePicker(suggestedName(record));
    await writeFile(handle, record.content);
    await linkFile(record, handle);
    await putBuffer({ ...record });
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
    await putBuffer({ ...record });

    if (record.enc) {
      // "replace" carries editor text, so the new ciphertext has to be decoded
      // before it can be announced. Locked, or not addressed to this device:
      // the editor drops its state and shows the placeholder instead.
      try {
        emit("replace", { id, content: await textOf(id) });
      } catch (err) {
        emit("lock", { ids: [id] });
      }
    } else {
      emit("replace", { id, content });
    }
    emit("change");
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
    await putBuffer(fork);
    // Not activated on purpose: an edit made in another program must never
    // move the caret out of what the user is typing in.
    emit("change");
    return fork;
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
        await refreshPermissionFlag(record);
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
    if (!(await ensurePermission(handle, "readwrite"))) return false;
    needsPermission.delete(record.file.handleId);
    await writeToDisk(id);
    await checkExternalChanges();
    return true;
  }

  // The point of the whole app: closing never asks anything.
  /** @param {string} id */
  async function close(id) {
    const record = buffers.get(id);
    if (!record || record.closed) return;
    record.closed = true;
    record.updatedAt = Date.now();
    emit("evict", { id });
    await putBuffer({ ...record });

    if (id === activeId) {
      // Null first: the next activate() must see no previousId, or the editor
      // would park its live state back into the buffer we just evicted.
      activeId = null;
      const next = openBuffers()[0];
      if (next) activate(next.id);
      else await create();
    }
    emit("change");
  }

  /** @param {string} id */
  async function reopen(id) {
    const record = buffers.get(id);
    if (!record || !record.closed) return;
    record.closed = false;
    record.updatedAt = Date.now();
    await putBuffer({ ...record });
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

  // Separate from load(): UI modules mount between the two, so they are
  // subscribed before the first "active" event fires.
  async function start() {
    let first = openBuffers()[0];
    if (!first) {
      first = newBufferRecord();
      buffers.set(first.id, first);
      await putBuffer(first);
    }

    const stored = localStorage.getItem(ACTIVE_KEY);
    const storedRecord = stored ? buffers.get(stored) : undefined;
    const target = storedRecord && !storedRecord.closed ? storedRecord.id : first.id;

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
    updateContent,
    encrypt,
    decrypt,
    lockAll,
    // Exported for the sync client (architecture.md §13.6): a pull that meets
    // a dirty local record forks it before it adopts the incoming one.
    forkConflict,
    setLang,
    setTitle,
    canRenameFile,
    renameFile,
    createFromFile,
    saveAs,
    replaceFromDisk,
    checkExternalChanges,
    needsReconnect,
    reconnect,
  };
}
