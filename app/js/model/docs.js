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
//   "available" { id }                          -> a file came back (reconnect): re-read it
//
// Persistence: every mutation writes through to IndexedDB, content edits with
// a debounce (architecture.md §1). That one stage writes the body to where it
// lives: the IndexedDB row for a scratch record, the file for a file-backed
// one, whose row is then an index without `content` (§23).
//
// One body per note (§23): a record with `file` keeps its body in the file and
// nowhere else. `record.content` in memory is the working copy this window
// holds (every scratch record, this window's file tabs once read, and a
// record whose file write failed: `file.unwritten`). Every reader of a body
// goes through body() or textOf(); a `record.content` read outside this file
// is a bug.
//
// Encryption sits between the editor and the record (architecture.md §5,
// §13.4): for a doc with `enc`, `record.content` is age ciphertext and the
// plaintext lives only in the `plain` map below, for as long as the keyring is
// unlocked. Everything under this file (IndexedDB, disk, sync) stays
// byte-agnostic, which is what keeps encryption orthogonal to storage.

import {
  deleteBuffer,
  deleteHandle,
  deleteRemote,
  getAllBuffers,
  getAllHandles,
  getHandle,
  getRemotes,
  newBufferRecord,
  putBuffer,
  putHandle,
  putRemote,
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
import { needsReencrypt } from "../crypto/spaces.js";
// The one import from editor/ in this layer. Detection is a rule about a
// record, not about a view, and it lives next to the mode table it names
// (editor/lang.js explains why the two stay together).
import { detectFromName, isLang } from "../editor/lang.js";
import { on, post } from "./channel.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../storage/idb.js").RemoteStub} RemoteStub */

/**
 * What a device does with a space (architecture.md §25, §27): 'tab' takes the
 * notes and opens them in main, 'list' keeps a title stub until a click,
 * undefined is a space this device is not a member of.
 * @typedef {'tab' | 'list' | undefined} SpaceMode
 */

/**
 * The store's view of the device's spaces. The sync client owns them (the
 * verified space logs and the settings); the store only asks, the same way it
 * asks `syncDefault`.
 * @typedef {Object} SpacesDep
 * @property {() => string | null} defaultSpace  null: the device is in no space.
 * @property {(space: string) => SpaceMode} modeOf
 * @property {(space: string) => string[]} recipients  The members' recipients,
 *   from the verified log; empty for a space this device does not know.
 * @property {(space: string) => number} logSeq  The log position applied.
 */

// Fixed id, not a UUID: every device must arrive at the same record so sync
// merges one keyring instead of forking one per device (architecture.md §13.3).
export const KEYRING_ID = "keyring";
// The space every note had before spaces existed, and a device's default
// until the user picks another (architecture.md §25). A change or a record
// without a space reads as this one, which keeps an old server whole.
export const DEFAULT_SPACE = "personal";
// The keyring record's reserved space. Every device receives it, whatever its
// settings say: a device that misses the device list cannot read what the
// others encrypt to it (§13.3). It is never in the modes map.
export const KEYRING_SPACE = "keyring";
const SAVE_DELAY = 300;
// Slow poll for external edits. Window focus is the responsive trigger; this
// only covers a window that stays focused while another program writes.
const WATCH_INTERVAL = 30000;
// How long a trashed record stays restorable (architecture.md §22).
const TRASH_KEEP = 30 * 24 * 60 * 60 * 1000;
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

/**
 * A file-backed body that cannot be read right now (architecture.md §23). The
 * editor shows it in the placeholder frame, search and push skip the record,
 * and nothing else happens: no empty document, no conflict copy. Read by its
 * `name` elsewhere, like LockedError, so the UI never imports this file for
 * an instanceof.
 */
export class UnavailableError extends Error {
  name = "UnavailableError";
  /**
   * @param {'permission' | 'missing' | 'error'} reason
   * @param {string} message @param {any} [cause] The disk error behind it.
   */
  constructor(reason, message, cause) {
    super(message);
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Whether the PIN-locked notes are open in this window right now
 * (architecture.md §27). ui/pin.js owns the state and sets it here, so the
 * pure title rule below can follow it without importing the UI.
 */
let pinOpen = false;
/** @param {boolean} open */
export function setPinOpen(open) {
  pinOpen = open;
}
/** Is this note behind the PIN right now? @param {BufferRecord} record */
export function isPinLocked(record) {
  return Boolean(record.pin) && !pinOpen;
}

/** @param {BufferRecord} record @returns {string} */
export function titleOf(record) {
  // A name the user typed wins over every derived one (architecture.md §7).
  if (record.title) return record.title;

  // A locked note shows no first line: that line can hold the secret (§27).
  if (isPinLocked(record)) return "Locked note";

  // A file-backed buffer is named by its file. Deriving the title from the
  // first line would rename someone's file every time they edit line 1.
  if (record.kind === "file" && record.file) return record.file.name;

  // An encrypted note: `content` is ciphertext, so its first line is a row of
  // base64. The device keeps the first line of the text it last read or
  // wrote (§27); without one (a courier device, §5, or a sealed title it
  // could not open yet) the row says what it is.
  if (record.enc) {
    if (record.firstLine !== undefined) return record.firstLine || "untitled";
    return "encrypted";
  }

  return firstLineTitle(record.content) || "untitled";
}

/**
 * @param {{keyring: import("../crypto/keyring.js").KeyRing,
 *          syncDefault?: () => boolean,
 *          spaces?: SpacesDep,
 *          workspaces: ReturnType<typeof import("./workspace.js").createWorkspaces>}} deps
 *   The keyring is a dependency, not an import: the codec resolves recipients
 *   and identities through it, and the store must follow its lock state
 *   (architecture.md §5). `syncDefault` answers "does a new document get a
 *   server target?" (§3, §13.6). A function, not a flag: the answer depends on
 *   a setting and on whether a server is configured at all, and both can change
 *   while the app runs. `workspaces` is this window's workspace and the
 *   others (architecture.md §14): "open" means a tab there, and the store
 *   writes its membership through it, never around it.
 *   `spaces` answers which space a new sync goes to and what this device does
 *   with a pulled space (§25); the default is a device with no setting yet.
 */
export function createDocStore({
  keyring,
  syncDefault = () => false,
  spaces = {
    defaultSpace: () => null,
    modeOf: () => undefined,
    recipients: () => [],
    logSeq: () => 0,
  },
  workspaces,
}) {
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
  // Buffers whose file could not be read for a re-wrap. Same reason.
  /** @type {Set<string>} */
  const readFailed = new Set();
  // Buffers whose save was skipped because the keyring locked mid-debounce.
  // Same "log once, not once per keystroke" reason as diskFailed.
  /** @type {Set<string>} */
  const encodeSkipped = new Set();
  /**
   * The From server stubs (architecture.md §25), by document id. Every window
   * loads them at start and follows the `remote` messages; the sync leader
   * writes them.
   * @type {Map<string, RemoteStub>}
   */
  const remotes = new Map();
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
    // The one place a file-backed body is kept out of the row and out of the
    // message (§23): its body is the file, and a second copy here is the
    // two-bodies bug §23 removed. A copy, never a delete on the argument:
    // some callers hand in the live record, whose `content` is the working
    // copy of an open tab. `unwritten` is the exception: the file write
    // failed, so the row is the only place the text survives a crash.
    const row =
      record.file && !record.file.unwritten ? withoutBody(record) : record;
    await putBuffer(row);
    post("buffer", { record: row });
    // A stub dies the moment a record with its id exists here (§25).
    // createFromChange removes it already; this catches every other door a
    // record can come in by, so the sidebar never lists a note twice.
    if (remotes.has(record.id)) await dropRemote(record.id);
  }

  // ---- From server stubs (architecture.md §25) -----------------------------

  /** @param {RemoteStub} stub */
  async function putStub(stub) {
    remotes.set(stub.id, stub);
    await putRemote(stub);
    post("remote", { stub });
    emit("change");
  }

  /** Remove one stub, if there is one. @param {string} id */
  async function dropRemote(id) {
    if (!remotes.has(id)) return;
    remotes.delete(id);
    await deleteRemote(id);
    post("remote-deleted", { id });
    emit("change");
  }

  /** Remove every stub of one space (it turned Not here). @param {string} space */
  async function forgetRemotes(space) {
    for (const stub of [...remotes.values()]) {
      if (stub.space === space) await dropRemote(stub.id);
    }
  }

  /** The stubs for the sidebar, newest first. @returns {RemoteStub[]} */
  function remoteList() {
    return [...remotes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  on("remote", ({ stub }) => {
    remotes.set(stub.id, stub);
    emit("change");
  });

  on("remote-deleted", ({ id }) => {
    if (remotes.delete(id)) emit("change");
  });

  /**
   * A pulled change for a document this device does not hold, in a `list`
   * space: keep its title, drop its text (§25). The text stays on the server
   * until a click fetches it (remote.open).
   * @param {Change} change @param {string} space
   */
  async function applyStub(change, space) {
    const existing = remotes.get(change.docId);
    // Same rule as the echo test of applyRemote: a cursor reset re-delivers
    // older rows, and they must not bring back an older title.
    if (existing && change.rev <= existing.rev) return;
    if (change.kind !== "text") return dropRemote(change.docId);
    const meta = change.meta || {};
    const sealed = meta.sealed ? await unseal(meta.sealed) : null;
    /** @type {RemoteStub} */
    const stub = {
      id: change.docId,
      space,
      // The title travels sealed (§27): the user's, else the first line the
      // pushing device took from the text. A note from before §27 is plain
      // text, and its own first line stands in.
      title: sealed ? sealed.title || sealed.line || "" : meta.enc ? "" : firstLineTitle(change.content ?? ""),
      rev: change.rev,
      updatedAt: change.clientTime || Date.now(),
    };
    if (meta.enc) {
      stub.enc = true;
      stub.spaceSeq = meta.enc.spaceSeq ?? 0;
    }
    // Locked: the title opens at the next unlock (unsealPending).
    if (meta.sealed && !sealed) stub.sealed = meta.sealed;
    await putStub(stub);
  }

  /** @param {BufferRecord} record @returns {BufferRecord} */
  function withoutBody(record) {
    const { content, ...index } = record;
    return index;
  }

  /** Is this one of this window's tabs? Only those hold a file body in memory. @param {string} id */
  function isMyTab(id) {
    return workspaces.current().tabs.includes(id);
  }

  /**
   * Forget the working copy of a record that left this window's tabs (§23): a
   * record in Recent has no body in memory in any window. An `unwritten` body
   * stays, because the file does not hold it yet.
   * @param {BufferRecord} record
   */
  function dropBody(record) {
    plain.delete(record.id);
    if (record.file && !record.file.unwritten) delete record.content;
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
      .filter(
        (b) => !open.has(b.id) && isDocument(b) && !b.trashedAt && b.sync?.tombstone !== "deleted"
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---- Trash (architecture.md §22) ---------------------------------------

  /** The trashed documents, newest first. */
  function trashed() {
    return [...buffers.values()]
      .filter((b) => isDocument(b) && b.trashedAt)
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  }

  /**
   * Keep a record instead of removing it: a `deleted` tombstone reached it.
   * `sync` goes with it, so the note is a local one from here on and the
   * same tombstone cannot reach it again after a restore. The caller takes
   * it out of the tabs and moves the editor on, as for a removal.
   * @param {BufferRecord} record
   */
  async function trash(record) {
    record.trashedAt = Date.now();
    delete record.sync;
    plain.delete(record.id);
    await persist({ ...record });
  }

  /**
   * Back into Recent, as a local document: a note encrypted for its space
   * turns back into plain text (architecture.md §27). @param {string} id
   */
  async function restore(id) {
    const record = buffers.get(id);
    if (!record || !record.trashedAt) return null;
    delete record.trashedAt;
    await toLocal(record);
    record.updatedAt = Date.now();
    await persist({ ...record });
    emit("change");
    return record;
  }

  /** Once at start: what has sat in the trash for thirty days goes for good. */
  async function emptyOldTrash() {
    const limit = Date.now() - TRASH_KEEP;
    for (const record of trashed()) {
      if ((record.trashedAt ?? 0) < limit) await forget(record.id);
    }
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
    // The keyring follows this through main.js (setContent), and its
    // "change" event is what runs the §20 re-wrap.
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
      record.content = await encodeFor(record, text);
      encodeSkipped.delete(record.id);
    }
    // After the codec, never in updateContent: a push must always read the
    // ciphertext that matches the revision it claims (architecture.md §13.4).
    // A keystroke is a real change, so a pending re-encryption is one no more.
    if (record.sync) {
      record.sync.dirty = true;
      delete record.sync.rewrap;
    }
    return true;
  }

  /**
   * Encrypt a text for a record, as its `enc` says, and keep what the record
   * learns from it (architecture.md §27): the log position a "space" note is
   * encrypted for, and the first line, which is the row's title while the
   * text is ciphertext. Throws for a "space" note whose members this device
   * does not know: a guess would lock the other members out.
   * @param {BufferRecord} record @param {string} text @returns {Promise<string>}
   */
  async function encodeFor(record, text) {
    if (!record.enc) return text;
    const space = record.sync?.space;
    const isSpace = record.enc.preset === "space";
    // Read together, before the await: a log pull during the encryption must
    // not stamp a position the recipients did not come from.
    const members = isSpace && space ? spaces.recipients(space) : undefined;
    const seq = isSpace && space ? spaces.logSeq(space) : undefined;
    const content = await codec.encode(text, record.enc, keyring, members);
    if (isSpace) record.enc = { ...record.enc, spaceSeq: seq };
    record.firstLine = firstLineTitle(text);
    return content;
  }

  /**
   * The plain text of an encrypted record, from memory or by a decode;
   * undefined when this device cannot read it.
   * @param {BufferRecord} record @param {string} [content] The encoded body.
   * @returns {Promise<string | undefined>}
   */
  async function plainOf(record, content = record.content) {
    const cached = plain.get(record.id);
    if (cached !== undefined) return cached;
    if (typeof content !== "string") return undefined;
    try {
      return await codec.decode(content, record.enc, keyring);
    } catch {
      return undefined;
    }
  }

  /**
   * A note that leaves sync is a local note (architecture.md §27): a scratch
   * note with the preset "space" turns back into plain text, a file keeps
   * its `.age` name and is encrypted for this device. Nothing is persisted
   * here; the caller does that. A note this device cannot read keeps its
   * ciphertext, with the preset of a local note.
   * @param {BufferRecord} record
   */
  async function toLocal(record) {
    if (!record.enc || record.enc.preset !== "space") return;
    if (record.file) {
      const text = await plainOf(record, await body(record.id).catch(() => undefined));
      record.enc = codec.newEncMeta("this-device");
      if (text === undefined) return;
      record.content = await encodeFor(record, text);
      plain.set(record.id, text);
      await writeFileNow(record);
      return;
    }
    const text = await plainOf(record);
    if (text === undefined) {
      record.enc = codec.newEncMeta("this-device");
      return;
    }
    delete record.enc;
    delete record.firstLine;
    record.content = text;
    plain.delete(record.id);
  }

  /**
   * Make a record a synced one, encrypted for its space (architecture.md
   * §27): the server never gets plain text, also not for an empty note. Sets
   * `sync` and `enc` and encrypts the body; the caller persists. A file must
   * already be an `.age` file (the command asks first, and encrypt() renames
   * it); its body is written back here.
   * @param {BufferRecord} record @param {string} space
   */
  async function sealForSpace(record, space) {
    const encoded = buffers.has(record.id) ? await body(record.id) : record.content ?? "";
    const text = record.enc ? await plainOf(record, encoded) : encoded;
    if (text === undefined) throw new Error("sync: this note cannot be read here");
    const before = { sync: record.sync, enc: record.enc };
    record.sync = { rev: record.sync?.rev ?? 0, dirty: true, space };
    record.enc = codec.newEncMeta("space");
    try {
      record.content = await encodeFor(record, text);
    } catch (err) {
      if (before.sync) record.sync = before.sync;
      else delete record.sync;
      if (before.enc) record.enc = before.enc;
      else delete record.enc;
      throw err;
    }
    plain.set(record.id, text);
    if (record.file) await writeFileNow(record);
  }

  /** @param {string} id */
  function persistSoon(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        void persistNow(id);
      }, SAVE_DELAY)
    );
  }

  /**
   * The one write stage (architecture.md §1, §23): encode, write the body to
   * where it lives, put the index row. For a file-backed record the body is
   * the file, and the row goes without `content` (persist strips it). Returns
   * false when nothing reached storage: the keyring locked, or the file write
   * failed (the row then holds the text as `file.unwritten`), or the file
   * changed on disk and won.
   * @param {string} id
   */
  async function persistNow(id) {
    const record = buffers.get(id);
    if (!record) return false;
    // A file body this window never read has nothing to write. Only a
    // Ctrl+S on a "File not available" placeholder gets here.
    if (record.file && typeof record.content !== "string") return false;
    if (!(await encodeForRecord(record))) {
      // Say so, or the indicator hangs at "…": nothing more happens for
      // this buffer until the keyring is unlocked again.
      if (id === activeId && !saveTimers.has(id)) emit("save", { status: "locked" });
      return false;
    }
    // writeBody reports its own status: the file write is the one that
    // matters for a file-backed doc, and a failure must not read "saved".
    const written = record.file ? await writeBody(record) : true;
    await persist({ ...record });
    // Only claim "saved" if no newer keystroke started another debounce.
    if (!record.file && id === activeId && !saveTimers.has(id)) {
      emit("save", { status: "saved" });
    }
    return written;
  }

  /**
   * Ctrl+S (desktop-wrapper-tauri-vs-wails.md §11): the debounce, now. An
   * autosaving editor has nothing else to save. A buffer without a disk file
   * lands in IndexedDB and reports "saved"; the caller decides whether that
   * case should open the file picker instead.
   * @param {string} id
   */
  async function saveNow(id) {
    if (!buffers.has(id)) return;
    dropTimers(id);
    await persistNow(id);
  }

  /**
   * Cancel the persist debounce of a buffer. For a caller that is about to
   * write the record and the file itself: a timer firing in between would put
   * the text the record held a moment ago back on disk.
   * @param {string} id
   */
  function dropTimers(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
  }

  /** @param {BufferRecord} [record] @returns {any} */
  function handleFor(record) {
    if (!record || record.kind !== "file" || !record.file) return null;
    return handles.get(record.file.handleId) || null;
  }

  /**
   * Set or clear the reconnect marker for one file, and only for a real
   * permission gap: the marker's click can grant a permission and nothing
   * else, so a write that failed for another reason must not raise it.
   * @param {BufferRecord} record
   * @param {any} [err] The failure that prompted the check, when there was one.
   */
  async function refreshPermissionFlag(record, err) {
    const handle = handleFor(record);
    if (!record.file || !handle) return;
    const handleId = record.file.handleId;
    // The disk error behind a failed read, which is what this rule reads.
    if (err instanceof UnavailableError) err = err.cause;
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

  /**
   * Read a file-backed body (architecture.md §23). Every failure becomes an
   * UnavailableError with a reason the editor can show, and the row gets its
   * reconnect marker where a click can help.
   * @param {BufferRecord} record
   * @returns {Promise<{content: string, mtime: number, enc?: import("../storage/idb.js").EncMeta}>}
   */
  async function readBody(record) {
    const handle = handleFor(record);
    const name = record.file ? record.file.name : record.id;
    if (!record.file || !handle) throw new UnavailableError("missing", "no handle for " + name);
    try {
      const { content, lastModified, enc } = await readFileForRecord(handle, record.file.name);
      return { content, mtime: lastModified, enc };
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        if (!needsPermission.has(record.file.handleId)) {
          needsPermission.add(record.file.handleId);
          emit("change");
        }
        throw new UnavailableError("permission", name + ": permission needed", err);
      }
      await refreshPermissionFlag(record, err);
      const missing = err && (err.name === "NotFoundError" || err.code === "notFound");
      throw new UnavailableError(missing ? "missing" : "error", name + ": " + err, err);
    }
  }

  /**
   * A body read from the file becomes this record's working copy. The file
   * decides whether the doc is encrypted (a `.age` file replaced by plain
   * text on disk stops being encrypted, and the other way round), but not the
   * preset: the file cannot say "this-device", so a record that already knows
   * its preset keeps it.
   * @param {BufferRecord} record
   * @param {{content: string, mtime: number, enc?: import("../storage/idb.js").EncMeta}} disk
   */
  function takeDisk(record, disk) {
    record.content = disk.content;
    if (!disk.enc) delete record.enc;
    else if (!record.enc) record.enc = disk.enc;
    // The old decoded text belongs to the old ciphertext.
    plain.delete(record.id);
    if (record.file) {
      record.file.mtime = disk.mtime;
      // The body is the file again; a text the file never took went to a
      // conflict copy before any caller got here.
      delete record.file.unwritten;
    }
  }

  /**
   * The pre-write check (architecture.md §23): stat the file before a write.
   * null means write: the stamp is the one this device last saw, or there is
   * nothing to compare against yet (`mtime` unknown after the v5 migration).
   * Otherwise the file holds text this device never saw, and the caller's own
   * rule decides what wins. Throws when the file cannot be reached.
   * @param {BufferRecord} record @param {any} handle
   * @param {number | undefined} [expected] The stamp of the caller's read.
   */
  async function movedOnDisk(record, handle, expected = record.file?.mtime) {
    const stat = await lastModified(handle);
    if (expected === undefined || stat === expected) return null;
    return readBody(record);
  }

  /**
   * Write a loaded file body, checked first (architecture.md §23). The
   * keystroke rule: when the file changed under us, the file wins. The local
   * text forks into a conflict copy, the buffer takes the file, and nothing
   * is written this round (§2). Returns true when the file holds the record's
   * text.
   * @param {BufferRecord} record @returns {Promise<boolean>}
   */
  async function writeBody(record) {
    const handle = handleFor(record);
    try {
      if (!record.file || !handle) {
        throw new UnavailableError("missing", "no handle for " + record.id);
      }
      const disk = await movedOnDisk(record, handle);
      if (disk && disk.content !== record.content) {
        await forkConflict(record);
        await replaceFromDisk(record.id, disk);
        return false;
      }
      if (disk) {
        // Same bytes: a touch. Nothing to write; the new stamp stops this
        // file from looking changed on every write after it.
        record.file.mtime = disk.mtime;
        wrote(record);
        return true;
      }
    } catch (err) {
      await failWrite(record, err);
      return false;
    }
    return writeFileNow(record);
  }

  /**
   * The write half of writeBody, with no check: the pull and the re-wrap run
   * their own check first, each with its own rule (§23). A failure leaves the
   * text held in the record as `unwritten`, so nothing is lost.
   * @param {BufferRecord} record @returns {Promise<boolean>}
   */
  async function writeFileNow(record) {
    const handle = handleFor(record);
    try {
      if (!record.file || !handle) {
        throw new UnavailableError("missing", "no handle for " + record.id);
      }
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
      await writeFile(handle, record.content ?? "");
      // One stat after the write, not a stamp from the write itself: the FSA
      // writable reports none. Another program writing between the two calls
      // would be taken for our own write; that window is milliseconds and is
      // accepted, as the poll's own window is (§23).
      record.file.mtime = await lastModified(handle);
      wrote(record);
      return true;
    } catch (err) {
      await failWrite(record, err);
      return false;
    }
  }

  /** The file holds the record's text: clear every failure mark. @param {BufferRecord} record */
  function wrote(record) {
    if (!record.file) return;
    const id = record.id;
    delete record.file.unwritten;
    needsPermission.delete(record.file.handleId);
    diskFailed.delete(id);
    // Clears a "disk write failed" left by an earlier attempt; without this
    // the failure would stay on screen until the next keystroke.
    if (id === activeId && !saveTimers.has(id)) emit("save", { status: "saved" });
    emit("change");
  }

  /**
   * A file write failed (a denied permission, a vanished file, a full disk).
   * The record keeps its text and is persisted with it (§23): `unwritten`
   * is what tells persist() to keep `content` in the row, and readers to take
   * it over the file, until the next write attempt lands.
   * @param {BufferRecord} record @param {any} err
   */
  async function failWrite(record, err) {
    if (!record.file) return;
    const id = record.id;
    record.file.unwritten = true;
    if (!diskFailed.has(id)) {
      // Once per buffer, not once per keystroke: a file that stays denied
      // would otherwise fill the console while the user keeps typing.
      diskFailed.add(id);
      console.log("[vrtti] disk write failed for", record.file.name, err);
    }
    if (id === activeId) emit("save", { status: "disk write failed" });
    await refreshPermissionFlag(record, err);
    // The row shows the reconnect marker for an unwritten record.
    emit("change");
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
   * The encoded body of a record (architecture.md §23): ciphertext for an
   * encrypted doc, the text for any other. `record.content` when this window
   * holds it (a scratch record, a loaded tab, an `unwritten` one), else the
   * file. A read for one of this window's tabs stays as its working copy; a
   * read for anything else (Recent, another window's tab) keeps nothing, so
   * no second body builds up in memory. Never persists: a read changes no
   * stored fact except the stamp, which the next write carries anyway.
   * Rejects with UnavailableError when the file cannot be read.
   * @param {string} id
   * @returns {Promise<{content: string, mtime?: number, enc?: import("../storage/idb.js").EncMeta}>}
   *   `mtime` is the stamp this body matches, for a caller that writes the
   *   file back or pushes it; `enc` is the file's say for a body read fresh.
   */
  async function bodyOf(id) {
    const record = buffers.get(id);
    if (!record) return { content: "" };
    if (typeof record.content === "string") {
      return { content: record.content, mtime: record.file?.mtime, enc: record.enc };
    }
    if (!record.file) return { content: "" };
    const disk = await readBody(record);
    // Re-tested after the await: a second read that raced this one must not
    // replace a copy the user has typed into since.
    if (isMyTab(id) && typeof record.content !== "string") {
      takeDisk(record, disk);
      // The record's `enc` after takeDisk, not the file's: the file can only
      // say "encrypted", and the preset the record knows stays (§23).
      return { ...disk, enc: record.enc };
    }
    return disk;
  }

  /** The encoded body, as a string. @param {string} id @returns {Promise<string>} */
  async function body(id) {
    return (await bodyOf(id)).content;
  }

  /**
   * The editor text of a buffer.
   *
   * A string for a loaded plaintext doc and for an encrypted one whose text
   * is already decoded; a Promise when a file read or a decode really has to
   * run. The split is deliberate: the loaded plaintext path is most switches,
   * and awaiting it would show an empty editor for a frame on each of them.
   *
   * The Promise rejects with LockedError when the keyring is locked or this
   * device is not a recipient, and with UnavailableError when the file cannot
   * be read. The caller decides what to do about it; the editor shows the
   * placeholder, and asks for the passphrase for the first.
   *
   * @param {string} id @returns {string | Promise<string>}
   */
  function textOf(id) {
    const record = buffers.get(id);
    if (!record) return "";
    // Behind the PIN (§27): no reader gets the text, the editor shows its
    // pad first. The name, as for the other locked case: search reads it.
    if (isPinLocked(record)) {
      const err = new Error("locked with a PIN");
      err.name = "LockedError";
      return Promise.reject(err);
    }
    if (typeof record.content !== "string") {
      return bodyOf(id).then(({ content, enc }) =>
        enc ? decodeText(id, content, enc) : content
      );
    }
    if (!record.enc) return record.content;
    const cached = plain.get(id);
    if (cached !== undefined) return cached;
    return decodeText(id, record.content, record.enc);
  }

  /**
   * The text of a buffer, but only if it is in memory right now. Never starts
   * a file read or a decode: the note list calls this for every row on every
   * redraw to draw a preview (ui/sidebar.js), and textOf() there would read
   * every file and ask for the passphrase of every locked note.
   *
   * Undefined for a locked encrypted note and for a file body this window has
   * not read. For an encrypted note the only source is the plaintext map, so
   * a lock takes the text away here too, and the record's ciphertext can
   * never come back as "text".
   *
   * @param {string} id @returns {string | undefined}
   */
  function loadedText(id) {
    const record = buffers.get(id);
    if (!record) return undefined;
    // A note behind the PIN shows no text in a preview (§27).
    if (isPinLocked(record)) return undefined;
    if (record.enc) return plain.get(id);
    return typeof record.content === "string" ? record.content : undefined;
  }

  /**
   * @param {string} id @param {string} content @param {import("../storage/idb.js").EncMeta} enc
   * @returns {Promise<string>}
   */
  function decodeText(id, content, enc) {
    return codec.decode(content, enc, keyring).then((text) => {
      // Not if the user locked while this decode ran: lockAll() already
      // cleared the map, and caching now would put plaintext back into it.
      // And only for the body the record holds: a Recent file read keeps
      // nothing in memory, its plaintext least of all (§23).
      if (keyring.isUnlocked && buffers.get(id)?.content === content) plain.set(id, text);
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
    // No working copy: a file body this window has not read. The editor only
    // ever edits a state built from a read, so this cannot happen; it guards
    // the next line from turning an unknown body into an edit.
    if (typeof record.content !== "string" && !record.enc) return;
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
      // the editor's update listener. Without this guard that echo would
      // start a persist and push a revision nobody typed.
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
   * updatedAt deliberately stays where it is: a label writes no text, and
   * updatedAt orders Recent by the last edit.
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
    // attaches it with baseRev null (architecture.md §13.6). Encrypted from
    // the start, also while empty (§27). No space, or a device with a
    // passphrase still locked: a local note, which the user can sync later.
    const space = syncDefault() && keyring.isUnlocked ? spaces.defaultSpace() : null;
    if (space) {
      await sealForSpace(record, space).catch((err) => {
        console.log("[vrtti] new note stays local:", err);
      });
    }
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
    if (keyringUnlocked === keyring.isUnlocked) {
      // Not a lock or an unlock: the keys or the recovery list changed.
      if (keyring.isUnlocked) void reencryptStale();
      return;
    }
    keyringUnlocked = keyring.isUnlocked;
    if (keyringUnlocked) {
      emit("unlock");
      // A change that arrived while locked could not re-wrap or unseal
      // anything; now it can.
      void unsealPending().then(reencryptStale);
    } else lockAll();
  });

  /**
   * Set by reencryptAll: every readable note counts as stale, because this
   * device has new keys and the old ones are going (architecture.md §27).
   */
  let rekeying = false;

  /**
   * Is this document encrypted for an older recipient set than it should be?
   * A "space" note follows the log position (§27): a lower `spaceSeq` than
   * this device applied means the members changed since. A higher one means
   * this device is behind, and it leaves the note alone, or it would add
   * back a device that was removed. Any other preset counts recipients, as
   * before: fewer means a recovery key arrived since.
   * @param {BufferRecord} record @param {string} content Its encoded body.
   */
  function needsMoreRecipients(record, content) {
    if (!record.enc || !keyring.isSetUp || !age.isArmored(content)) return false;
    if (rekeying) return true;
    if (record.enc.preset === "space") {
      const space = record.sync?.space;
      if (!space || !spaces.recipients(space).length) return false;
      return needsReencrypt(record.enc.spaceSeq, spaces.logSeq(space));
    }
    return age.countRecipients(content) < keyring.recipientsFor(record.enc.preset).length;
  }

  /**
   * After a change of the passphrase switch: encrypt every note this device
   * can read for its new key (architecture.md §27). The old identity still
   * decrypts meanwhile (keyring.previous).
   */
  async function reencryptAll() {
    rekeying = true;
    try {
      await reencryptStale();
    } finally {
      rekeying = false;
    }
  }

  /**
   * Re-wrap every readable encrypted document for the keyring as it is now
   * (architecture.md §20). A document saved before a device joined is a
   * locked row on that device until a device that can read it saves it
   * again; this is that save, without waiting for a keystroke. Runs on every
   * keyring change (a record write or pull, a confirmed device) and after an
   * unlock. Limited to what this window may
   * write (its tabs and Recent), and skips a courier document (the decode
   * throws), a document with a save already pending (that save re-wraps
   * with the current keyring anyway) and, above all, a document with more
   * recipients than this window knows.
   */
  async function reencryptStale() {
    if (!keyring.isUnlocked) return;
    const mine = new Set(workspaces.current().tabs);
    const open = workspaces.openSet();
    let changed = false;
    for (const record of [...buffers.values()]) {
      const id = record.id;
      if (!isDocument(record) || !record.enc || record.trashedAt) continue;
      if (open.has(id) && !mine.has(id)) continue;
      if (saveTimers.has(id)) continue;
      // The body, not record.content: a Recent file-backed doc has none in
      // memory (§23), and its file is exactly what a re-wrap rewrites.
      let read;
      try {
        read = await bodyOf(id);
      } catch (err) {
        if (!(err instanceof UnavailableError)) throw err;
        if (!readFailed.has(id)) {
          readFailed.add(id);
          console.log("[vrtti] re-encrypt skipped, file not readable:", id, err.reason);
        }
        continue;
      }
      readFailed.delete(id);
      if (!needsMoreRecipients(record, read.content)) continue;
      let text;
      try {
        // No save is pending (tested above), so a cached plaintext is the
        // text of exactly this body.
        text = plain.get(id) ?? (await codec.decode(read.content, record.enc, keyring));
      } catch {
        continue;
      }
      // The keyring may have locked while the decode ran (lockAll cleared
      // the map): stop, and the next unlock runs this again.
      if (!keyring.isUnlocked) return;
      let content;
      try {
        content = await encodeFor(record, text);
      } catch {
        // The space's members are not known here yet: the next log pull
        // runs this again.
        continue;
      }
      if (record.file) {
        // The re-wrap rewrites what it just read (§23): a stamp that moved
        // since is an edit this device never saw, and this round leaves the
        // file to it. The next keyring change or unlock tries again.
        const handle = handleFor(record);
        const stat = handle ? await lastModified(handle).catch(() => undefined) : undefined;
        if (stat === undefined || (read.mtime !== undefined && stat !== read.mtime)) continue;
        record.content = content;
        // A `.age` file on disk is wrapped the same way (§19).
        await writeFileNow(record);
      } else {
        record.content = content;
      }
      // A re-encryption is a change every member makes on its own, so a 409
      // on its push forks nothing (rewrap, see applyRemote). Text the user
      // typed and has not pushed yet keeps the push a real one.
      if (record.sync) {
        if (!record.sync.dirty) record.sync.rewrap = true;
        record.sync.dirty = true;
      }
      await persist({ ...record });
      // A Recent record keeps no body in memory (§23), unless the write
      // failed and the text is held as `unwritten`.
      if (!isMyTab(id)) dropBody(record);
      changed = true;
      console.log("[vrtti] re-encrypted for the current members:", id);
    }
    if (changed) emit("change");
  }

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
   * @param {string} id @param {'this-device'} [preset]  Synced notes are
   *   encrypted by setSync, never through here.
   * @returns {Promise<BufferRecord | null>}
   */
  async function encrypt(id, preset = "this-device") {
    const record = buffers.get(id);
    if (!record || record.enc) return null;
    // The command asks for setup and unlock before it gets here; a throw is
    // for a caller that skipped that, and must not be swallowed.
    if (!keyring.isUnlocked) throw new Error("encrypt: the keyring is locked");
    if (!canEncryptFile(record)) throw new Error("encrypt: this file cannot be renamed");

    // The body, not record.content: a doc in Recent holds none (§23).
    const read = await bodyOf(id);
    const text = read.content;
    // encodeFor reads the record's enc: it works on a copy, so a failure
    // leaves the record untouched.
    const probe = { ...record, enc: codec.newEncMeta(preset) };
    const content = await encodeFor(probe, text);

    const handle = handleFor(record);
    if (record.file && handle) {
      // The record already holds the latest text (updateContent), so a
      // pending debounce has nothing to add and would only race the writes.
      dropTimers(id);
      await refuseIfChanged(record, handle, read, "encrypt");
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
      record.file.mtime = await lastModified(handle);
    }

    plain.set(id, text);
    record.enc = probe.enc;
    record.firstLine = probe.firstLine;
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
    // A doc encrypted from its Recent row keeps no body in memory (§23).
    if (!isMyTab(id)) dropBody(record);
    emit("change");
    return record;
  }

  /**
   * The pre-write check of encrypt and decrypt (§19, §23): they rewrite the
   * file from the text they hold, so a file that changed under them wins, as
   * for a keystroke. A loaded tab forks its text and takes the file; either
   * way the command stops with a refusal, and nothing was written.
   * @param {BufferRecord} record @param {any} handle
   * @param {{content: string, mtime?: number}} read The body the command holds.
   * @param {string} label
   */
  async function refuseIfChanged(record, handle, read, label) {
    const disk = await movedOnDisk(record, handle, read.mtime);
    if (!disk || disk.content === read.content) return;
    console.log("[vrtti] " + label + ": changed on disk", record.file?.name);
    if (isMyTab(record.id) && typeof record.content === "string") {
      await forkConflict(record);
      await replaceFromDisk(record.id, disk);
    }
    throw new Error(label + ": the file changed on disk");
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
    const read = await bodyOf(id);
    const text = await textOf(id);

    const handle = handleFor(record);
    if (record.file && handle) {
      dropTimers(id);
      await refuseIfChanged(record, handle, read, "decrypt");
      if (!(await ensurePermission(handle, "readwrite"))) {
        throw new Error("decrypt: permission not granted");
      }
      await writeFile(handle, text);
      record.file.mtime = await lastModified(handle);
      // The rename is the lesser half: the file holds plaintext now whatever
      // it is called, and the record below must follow the file. A taken
      // name is logged, and the `.age` name stays until the user renames it.
      await moveFile(record, handle, decryptedName(record.file.name)).catch((err) => {
        console.log("[vrtti] decrypt: the file keeps its name", record.file?.name, err);
      });
    }

    delete record.enc;
    delete record.firstLine;
    record.content = text;
    plain.delete(id);
    if (record.sync) record.sync.dirty = true;
    await persist({ ...record });
    if (!isMyTab(id)) dropBody(record);
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
    // "this-device" until the record says more: a synced `.age` file keeps
    // the preset "space" of its record (takeDisk, §23).
    if (age.isArmored(text)) {
      return { content: text, lastModified, enc: { v: 1, preset: "this-device" } };
    }
    if (age.isAgeFile(bytes)) {
      return {
        content: age.armor.encode(bytes),
        lastModified,
        enc: { v: 1, preset: "this-device" },
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
    // No mtime here: it is the stamp of this device's last read or write of
    // the file (§23), and the caller's read or write that follows sets it.
    record.file = { handleId, name: handle.name };
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
      // The file never left the disk, so a trashed record for it is simply
      // the record again (architecture.md §22).
      if (existing.trashedAt) await restore(existing.id);
      // reopen() knows the three cases: a tab here, a tab in another window,
      // or Recent.
      await reopen(existing.id);
      return existing;
    }
    const { content, enc, lastModified: mtime } = await readFileForRecord(handle, handle.name);
    const record = newBufferRecord();
    // The working copy of the tab this opens; persist keeps it out of the row.
    record.content = content;
    if (enc) record.enc = enc;
    await linkFile(record, handle);
    if (record.file) record.file.mtime = mtime;
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
    const content = await body(id);
    const handle = await saveFilePicker(suggestedName(record));
    await writeFile(handle, content);
    await linkFile(record, handle);
    record.content = content;
    // The user can type any name into the picker. An encrypted buffer under a
    // plain name would open as a page of armor next time, so the suffix goes
    // back on where the handle allows it.
    if (record.enc && record.file && !/\.age$/i.test(handle.name) && canRenameFile(record)) {
      await moveFile(record, handle, encryptedName(handle.name));
    }
    // After the rename, so the stamp is the file as it now sits.
    if (record.file) record.file.mtime = await lastModified(handle);
    // The body is the file from here on: this row loses its `content` (§23).
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
   * An external edit is an edit (§23): it is marked for the next push, so it
   * reaches the other devices.
   * @param {string} id
   * @param {{content: string, mtime: number, enc?: import("../storage/idb.js").EncMeta}} [disk]
   *   A read the caller already made, so the file is not read twice.
   * @param {{edit?: boolean}} [options] edit: false for a file this device's
   *   own sync leader just wrote from a pull, which is no news to the server.
   */
  async function replaceFromDisk(id, disk, { edit = true } = {}) {
    const record = buffers.get(id);
    if (!record || !record.file || !handleFor(record)) return;
    takeDisk(record, disk ?? (await readBody(record)));
    record.updatedAt = Date.now();
    if (edit) markDirty(record);
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
   * @param {string} [text] The encoded text to fork, when it is not the one
   *   in memory: a pull forks the DISK text of a file that changed under it,
   *   and a Recent record holds no text in memory at all (§23).
   * @param {string} [plainText] The text itself, when the caller holds it:
   *   a note this device lost may be encrypted for members it is not one of
   *   any more, but its plaintext is still in memory (trashNote).
   */
  async function forkConflict(record, text = record.content ?? "", plainText) {
    const fork = newBufferRecord();
    // A copy is a local note (§27): a note encrypted for its space forks as
    // plain text when this device can read it.
    if (plainText === undefined && record.enc?.preset === "space") {
      plainText = await codec.decode(text, record.enc, keyring).catch(() => undefined);
    }
    if (plainText !== undefined) {
      fork.content =
        "conflict copy of " + titleOf(record) + " (" + new Date().toISOString() + ")\n\n" + plainText;
    } else if (record.enc) {
      // Ciphertext, copied byte for byte. The usual "conflict copy of …"
      // prefix would corrupt the age file and make the copy undecryptable, so
      // the note goes into the title, which is plaintext by design (§7).
      // Works without any key: a courier device forks conflicts too (§5).
      fork.content = text;
      fork.enc = record.enc.preset === "space" ? codec.newEncMeta("this-device") : { ...record.enc };
      fork.title = "conflict copy of " + titleOf(record);
    } else {
      fork.content =
        "conflict copy of " +
        (record.file ? record.file.name : titleOf(record)) +
        " (" +
        new Date().toISOString() +
        ")\n\n" +
        text;
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
   * @property {string} [space]  Absent from a server older than spaces (§25),
   *   which every reader takes as DEFAULT_SPACE.
   */

  /**
   * The metadata that travels with a revision. The server stores it in the
   * clear and refuses any other key (architecture.md §27), so everything that
   * says something about the note goes into `sealed`.
   * @typedef {Object} RecordMeta
   * @property {import("../storage/idb.js").EncMeta} [enc]
   * @property {'scratch' | 'keyring'} [kind]
   * @property {string} [sealed]  Armored age, for the same readers as the text: SealedMeta.
   */

  /**
   * What `meta.sealed` holds (architecture.md §27).
   * @typedef {Object} SealedMeta
   * @property {string} line  The first line of the text, the row's title.
   * @property {string} origin  The device id of the first revision.
   * @property {string} [title]  The user's title.
   * @property {string} [lang]
   * @property {'auto' | 'user'} [langSource]
   * @property {true} [pin]  Locked with a PIN.
   */

  /**
   * Attach or detach a server target (architecture.md §3 "What syncs").
   *
   * Detaching does not remove `sync`: the other devices have to be told, and
   * that is a push like any other. The record loses its `sync` only after that
   * push lands, in clearSync().
   *
   * @param {string} id @param {boolean} on
   * @param {string} [space] Where a new sync goes; the device's default
   *   space when absent (§25). An existing sync keeps its space: a move is
   *   move(), never a second "Sync to".
   */
  async function setSync(id, on, space) {
    const record = buffers.get(id);
    if (!record) return null;
    if (on) {
      // An already attached record is left alone: overwriting its rev with 0
      // would make the next push claim a revision the server passed long ago.
      if (!record.sync && record.kind === "keyring") {
        // The device directory is no note: it is plain JSON in its own space,
        // and the server lets it through as the one exception (§27).
        record.sync = { rev: 0, dirty: true, space: KEYRING_SPACE };
      } else if (!record.sync) {
        const target = space ?? spaces.defaultSpace();
        if (!target) throw new Error("sync: this device is in no space");
        // Each synced note is encrypted (§27). A file turns into an `.age`
        // file first; the command asked the user (§19).
        if (record.file && !record.enc) await encrypt(id, "this-device");
        await sealForSpace(record, target);
      }
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
    await toLocal(record);
    await persist({ ...record });
    if (!isMyTab(id)) dropBody(record);
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
   * The body of one push (architecture.md §13.5), and the file stamp that
   * body matches. A file-backed body is read here (§23), so this rejects with
   * UnavailableError when the file cannot be read; the client skips the
   * record, which stays dirty.
   *
   * `sentMtime` exists because the leader reads files, not the owner's
   * memory: it can push a file that is one debounce behind the owner's
   * text, and afterPush keeps the record dirty when the stamp has moved
   * since, so the rest goes with the next round.
   * @param {BufferRecord} record
   */
  async function pushPayload(record) {
    const tombstone = record.sync?.tombstone;
    /** @type {RecordMeta} */
    const meta = {};
    // A file-backed doc travels as a scratch doc, always: the disk link is per
    // device (architecture.md §3), and the other device has no such file. Do
    // not "fix" this by sending kind 'file'; it would arrive as a broken link.
    meta.kind = record.kind === "keyring" ? "keyring" : "scratch";
    if (record.enc !== undefined) meta.enc = record.enc;
    let sentMtime = record.file?.mtime;
    /** @type {string | null} */
    let content = null;
    if (!tombstone) {
      const read = await bodyOf(record.id);
      content = read.content;
      if (record.file) sentMtime = read.mtime;
      // Everything else about a note travels sealed, for the same readers
      // as its text (§27): the server holds no readable title.
      if (record.kind !== "keyring") {
        record.origin ??= await deviceId();
        meta.sealed = await sealMeta(record);
      }
    }
    const payload = {
      // null is "attach without a claim". rev 0 is not a revision the server
      // ever had, so claiming it would 409 for ever on the very first push.
      baseRev: record.sync && record.sync.rev !== 0 ? record.sync.rev : null,
      kind: tombstone ?? "text",
      content,
      meta,
      clientTime: record.updatedAt,
      space: spaceOf(record),
    };
    return { payload, sentMtime };
  }

  /**
   * The fields of a note that must stay secret, as one age blob for the
   * members of its space (architecture.md §27): the user's title, the first
   * line, the language, the PIN mark and the device that made the note.
   * @param {BufferRecord} record @returns {Promise<string>}
   */
  async function sealMeta(record) {
    /** @type {SealedMeta} */
    const fields = { line: record.firstLine ?? "", origin: record.origin ?? "" };
    if (record.title) fields.title = record.title;
    if (record.lang) fields.lang = record.lang;
    if (record.langSource) fields.langSource = record.langSource;
    if (record.pin) fields.pin = true;
    const space = record.sync?.space ?? "";
    return codec.encode(JSON.stringify(fields), codec.newEncMeta("space"), keyring, spaces.recipients(space));
  }

  /**
   * Open `meta.sealed`; null when this device cannot (locked, or not a
   * reader), or when it is not a sealed object.
   * @param {unknown} text @returns {Promise<SealedMeta | null>}
   */
  async function unseal(text) {
    if (typeof text !== "string" || !keyring.isUnlocked) return null;
    try {
      const value = JSON.parse(await codec.decode(text, codec.newEncMeta("space"), keyring));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * After an unlock: the sealed meta that arrived while this device was
   * locked opens now, for records and for stubs (§27).
   */
  async function unsealPending() {
    for (const record of [...buffers.values()]) {
      if (!record.sealed) continue;
      const fields = await unseal(record.sealed);
      if (!fields) continue;
      applyMeta(record, { enc: record.enc, sealed: record.sealed }, fields);
      await persist({ ...record });
    }
    for (const stub of [...remotes.values()]) {
      if (!stub.sealed) continue;
      const fields = await unseal(stub.sealed);
      if (!fields) continue;
      const next = { ...stub, title: fields.title || fields.line || "" };
      delete next.sealed;
      await putStub(next);
    }
    emit("change");
  }

  /**
   * The space a synced record pushes to. The fallback covers a record from
   * before the v6 backfill, which a window of an older build can still
   * write; it is the same rule the backfill applies.
   * @param {BufferRecord} record @returns {string}
   */
  function spaceOf(record) {
    return record.sync?.space ?? (record.kind === "keyring" ? KEYRING_SPACE : DEFAULT_SPACE);
  }

  /** Records waiting for a push, keyring first. @returns {BufferRecord[]} */
  function dirtyRecords() {
    return [...buffers.values()]
      // A synced note in plain text is one from before §27 that waits for
      // its encryption (sealSynced); the server would refuse it anyway. Its
      // tombstone may go: a tombstone carries no text.
      .filter((b) => b.sync?.dirty && (b.kind === "keyring" || b.enc || b.sync.tombstone))
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
   * @param {number} [sentMtime] The file stamp of the body that went out
   *   (pushPayload): a file written since is text the server does not have.
   */
  async function afterPush(id, rev, sentUpdatedAt, sentMtime) {
    const record = buffers.get(id);
    if (!record || !record.sync) return;
    // A file never read on this device since the v5 migration has no stamp;
    // the push just read it, and that read is this device's last one. Without
    // this the guard below would keep the record dirty for ever.
    if (record.file && record.file.mtime === undefined && typeof record.content !== "string") {
      record.file.mtime = sentMtime;
    }
    const stillDirty = () =>
      (sentUpdatedAt !== undefined && record.updatedAt !== sentUpdatedAt) ||
      Boolean(record.file && record.file.mtime !== sentMtime);
    const owner = workspaces.ownerOf(id);
    if (owner && owner !== workspaces.id && (await workspaces.liveSet()).has(owner)) {
      // The owner keeps the record's books (architecture.md §14.3). This
      // copy follows in memory only, so the next push loop already sees the
      // rev; the owner's own persist brings the stored record.
      record.sync.rev = rev;
      record.sync.dirty = stillDirty();
      post("pushed", { ws: owner, id, rev, sentUpdatedAt, sentMtime });
      return;
    }
    // A tombstone push is the last thing this record ever says to the server.
    // A discard (deleted) ends here in the removal; a detach in a local copy.
    if (record.sync.tombstone === "deleted") return forget(id);
    if (record.sync.tombstone) return clearSync(id);
    record.sync.rev = rev;
    record.sync.dirty = stillDirty();
    if (!record.sync.dirty) delete record.sync.rewrap;
    await persist({ ...record });
    emit("change");
  }

  /**
   * Copy the pulled metadata onto a record. Absent means absent: a title
   * cleared on the other device has to be cleared here, not kept.
   *
   * The fields come from the sealed meta (§27). A device that could not open
   * it (locked) keeps its own fields and the sealed text, and unsealPending
   * applies them at the next unlock.
   * @param {BufferRecord} record @param {RecordMeta} meta
   * @param {SealedMeta | null} sealed `meta.sealed`, opened.
   */
  function applyMeta(record, meta, sealed) {
    if (meta.enc !== undefined) record.enc = meta.enc;
    else delete record.enc;
    if (meta.sealed && !sealed) {
      record.sealed = meta.sealed;
      return;
    }
    delete record.sealed;
    const fields = sealed ?? {};
    if (typeof fields.title === "string" && fields.title) record.title = fields.title;
    else delete record.title;
    if (typeof fields.lang === "string") record.lang = fields.lang;
    else delete record.lang;
    if (fields.langSource === "auto" || fields.langSource === "user") record.langSource = fields.langSource;
    else delete record.langSource;
    if (fields.pin) record.pin = true;
    else delete record.pin;
    if (typeof fields.origin === "string" && fields.origin) record.origin = fields.origin;
    if (record.enc) record.firstLine = typeof fields.line === "string" ? fields.line : undefined;
    else delete record.firstLine;
    if (record.firstLine === undefined) delete record.firstLine;
    // `kind` is deliberately not copied: it is per device. A doc that is
    // file-backed here stays file-backed, and one that arrived as scratch
    // stays scratch even if the other device has it on disk.
  }

  /**
   * Take the incoming version as current. The pull's rule for a file (§3,
   * §23): the incoming version wins. A file that changed under this device
   * forks its disk text first, then the file takes the incoming at once.
   * @param {BufferRecord} record @param {Change} change
   * @param {string} [forked] The text applyRemote already forked, so the
   *   same text is not forked twice.
   */
  async function adoptRemote(record, change, forked) {
    const id = record.id;
    const incoming = change.content ?? "";
    // The pull replaces the text; a pending persist would write the old
    // working copy over it (applyRemote forked that copy already).
    dropTimers(id);
    const handle = handleFor(record);
    if (record.file && handle) {
      try {
        const disk = await movedOnDisk(record, handle);
        if (disk && disk.content !== incoming && disk.content !== forked) {
          await forkConflict(record, disk.content);
        }
      } catch {
        // Unreadable: there is no disk text this device can fork. The write
        // below fails the same way and holds the incoming as `unwritten`.
      }
    }
    record.content = incoming;
    applyMeta(record, change.meta || {}, await unseal(change.meta?.sealed));
    record.sync = {
      rev: change.rev,
      dirty: false,
      space: change.space ?? record.sync?.space ?? DEFAULT_SPACE,
    };
    record.updatedAt = Date.now();
    // The decoded text belongs to the ciphertext this just replaced.
    plain.delete(id);
    // At once, not through a debounce: the pull has landed when the file
    // holds it (§23). A failure keeps the pulled text as `unwritten`.
    if (record.file) await writeFileNow(record);
    await persist({ ...record });
    if (isMyTab(id)) await announceReplace(record);
    // A Recent record keeps no body in memory (§23), unless it is held.
    else dropBody(record);
    emit("change");
  }

  /**
   * The keyring record is the one record that merges instead of forking
   * (architecture.md §13.3): a fork would split the device list in two, and
   * each device would then encrypt to half of the devices.
   *
   * The merge only adds (§26): the server's copy is a list of claims, and
   * which of them this device believes is the keyring's question, asked on
   * the merged list. Nothing here may pick a winner between two entries.
   * @param {BufferRecord | undefined} record  The local keyring record;
   *   applyRemote only calls this for KEYRING_ID, so it is never another one.
   * @param {Change} change
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
    // Dirty exactly when the union added something the server does not have
    // (a device, an approval, a recovery key), so the other devices learn
    // about it. The remote goes through the same merge alone, so the two
    // strings differ only by what the local copy added (§21).
    next.sync = {
      rev: change.rev,
      dirty: JSON.stringify(merged) !== JSON.stringify(mergeKeyringContent(null, remote)),
      space: KEYRING_SPACE,
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

  on("pushed", ({ ws, id, rev, sentUpdatedAt, sentMtime }) => {
    if (ws === workspaces.id) void afterPush(id, rev, sentUpdatedAt, sentMtime);
  });

  /**
   * Which live window should apply a pulled change: the buffer's owner, or
   * main for a document nobody has yet. null means this one.
   * @param {string} id @param {BufferRecord | undefined} record @param {RecordMeta} meta
   */
  async function routeTarget(id, record, meta) {
    if (id === KEYRING_ID) return null;
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
    // An old server sends no space; every row it holds is from before spaces,
    // so it is `personal` (§25). Set on the change itself, so a routed copy,
    // adoptRemote and createFromChange all read the same value. This is the
    // one door for pulls, 409s and routed changes alike.
    change.space ??= DEFAULT_SPACE;
    const space = change.space;
    // The keyring is the one record under the one fixed id, and no row is
    // the keyring because it says so (architecture.md §26). A row with
    // `meta.kind` "keyring" under another id used to reach applyRemoteKeyring
    // with no local record beside it, so one such row replaced the whole
    // device list. No device writes one; it is dropped, not opened as a note.
    const isKeyring = id === KEYRING_ID;
    if (!isKeyring && meta.kind === "keyring") return;

    // An unknown document outside an Open as tab space never becomes a
    // record (§25). Decided here, before routing: the stubs belong to the
    // leader, which is the window running this, and no window owns the id.
    if (!record && !isKeyring) {
      const mode = spaces.modeOf(space);
      if (mode === "list") return applyStub(change, space);
      if (mode === undefined || change.kind !== "text") {
        // Not a space of this device (the note moved away, §27), or a
        // tombstone for an unknown id: nothing is stored. A stub with this
        // id is stale either way.
        return dropRemote(id);
      }
    }

    if (!options.local) {
      const target = await routeTarget(id, record, meta);
      if (target && (await deliverRemote(target, change))) return;
    }
    // The keyring is never a stub and never detached by space: every device
    // receives `keyring`, whatever its settings say.
    if (isKeyring) {
      return applyRemoteKeyring(record, change);
    }

    // The note moved to a space this device is not a member of (§27): the
    // device lost it, and its copy goes to the local trash. The server sends
    // such a row without content, so there is nothing to adopt anyway. It
    // reaches a known record as a pulled row (prev_space) and as the
    // `current` of a 409.
    if (record && spaces.modeOf(space) === undefined) {
      if (!record.sync) return;
      return trashNote(id);
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
      return trashNote(id);
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
      // A document that arrives from sync opens in the main workspace (§14).
      await createFromChange(change, MAIN_WORKSPACE);
      return;
    }

    /** @type {string | undefined} */
    let forked;
    if (record.sync) {
      // The incoming version wins and the local text forks. Nothing is lost
      // and nothing prompts (architecture.md §3). Dirty here is also a
      // keystroke still in its debounce, or a file write that failed: text
      // the push has not seen yet (§23).
      // A pending re-encryption (rewrap) is no text of the user's: the
      // incoming version is encrypted for the members too, by the device
      // that won the race.
      const dirty =
        (record.sync.dirty && !record.sync.rewrap) ||
        saveTimers.has(id) ||
        Boolean(record.file?.unwritten);
      if (dirty && !discarded && typeof record.content === "string") {
        forked = record.content;
        await forkConflict(record);
      } else if (dirty && !discarded && record.file) {
        // A Recent file the leader found changed (stampRecentFiles): the
        // edit is on disk only, and the stamp already moved, so the disk
        // check in adoptRemote cannot see it. Its text forks from the file.
        const local = await body(id).catch((err) => {
          if (!(err instanceof UnavailableError)) throw err;
          return undefined;
        });
        if (local !== undefined && local !== change.content) {
          forked = local;
          await forkConflict(record, local);
        }
      }
    } else {
      // Detached here, then edited on either side. Re-attaching must not drop
      // the local text; equal content needs no fork, which is what makes a
      // detach and re-attach round trip quietly.
      let local;
      try {
        local = await body(id);
      } catch (err) {
        // The file cannot be read: its text is still on disk, untouched by
        // this, and the write in adoptRemote fails the same way and holds
        // the incoming as `unwritten`. Adopt without a fork.
        if (!(err instanceof UnavailableError)) throw err;
      }
      if (local !== undefined && local !== change.content) {
        forked = local;
        await forkConflict(record, local);
      }
    }
    await adoptRemote(record, change, forked);
  }

  /**
   * A synced record from a server row this device has no record for: the
   * unknown-id branch of applyRemote, and remote.open's click on a From
   * server stub (§25), which passes its own window instead of main.
   * @param {Change} change @param {string} ws The workspace that gets the tab.
   * @returns {Promise<BufferRecord>}
   */
  async function createFromChange(change, ws) {
    const id = change.docId;
    // A pull can land between the click's fetch and this call; a second
    // record for one id would split the buffer's one writer in two.
    const existing = buffers.get(id);
    if (existing) return existing;
    /** @type {BufferRecord} */
    const created = {
      id,
      content: change.content ?? "",
      createdAt: Date.now(),
      // The other device's clock: it is what the row's age should show, and
      // this device never saw the document before now.
      updatedAt: change.clientTime || Date.now(),
      sync: { rev: change.rev, dirty: false, space: change.space ?? DEFAULT_SPACE },
    };
    applyMeta(created, change.meta || {}, await unseal(change.meta?.sealed));
    buffers.set(id, created);
    // persist() also removes the stub with this id (§25).
    await persist({ ...created });
    await workspaces.addTab(id, ws);
    emit("change");
    return created;
  }

  /**
   * This device lost a space (architecture.md §27): it removed itself, a
   * member removed it, or the server no longer gives it the space. Each note
   * of the space goes into the local trash, and the space's stubs go. The
   * leader runs this for every window; a record another window holds as a
   * tab reaches that window as a `buffer` message with `trashedAt`, and
   * adoptFromWindow closes the tab there.
   * @param {string} space
   */
  async function loseSpace(space) {
    for (const record of [...buffers.values()]) {
      // The keyring's space is received by every device, always.
      if (!record.sync || record.kind === "keyring" || spaceOf(record) !== space) continue;
      await trashNote(record.id);
    }
    await forgetRemotes(space);
    emit("change");
  }

  /**
   * The whole job of a note leaving this device for the trash (§22, §27): a
   * text not pushed yet survives as a local copy, the tab closes, another
   * note takes the screen, and the record goes to the trash, or away for good
   * when there is nothing in it. One door for a `deleted` tombstone, a move
   * to a space this device is not in, and the loss of a space.
   * @param {string} id
   */
  async function trashNote(id) {
    const record = buffers.get(id);
    if (!record) return;
    const discarded = record.sync?.tombstone === "deleted";
    const dirty = Boolean(record.sync?.dirty && !record.sync.rewrap) || saveTimers.has(id);
    // The text, not the ciphertext: a lost note may be encrypted for members
    // this device is not one of any more, but what it typed is in memory.
    const typed = record.enc ? plain.get(id) : undefined;
    dropTimers(id);
    // A file body not in memory needs no copy: it is the file, and the trash
    // never touches the file.
    if (dirty && !discarded && (typed !== undefined || typeof record.content === "string")) {
      await forkConflict(record, record.content ?? "", typed);
    }
    if (isEmpty(record) || discarded) {
      buffers.delete(id);
      plain.delete(id);
      await remove(id);
    } else {
      await trash(record);
    }
    await closeHere(id);
  }

  /**
   * Take a record that is gone or trashed out of this window: the tab, the
   * editor state, and the screen. @param {string} id
   */
  async function closeHere(id) {
    const record = buffers.get(id);
    if (record) dropBody(record);
    emit("evict", { id });
    if (workspaces.current().tabs.includes(id)) await workspaces.removeTab(id);
    if (id === activeId) {
      // Null first, so the next activate() parks nothing into a record that
      // no longer exists (same rule as close()).
      activeId = null;
      const next = openBuffers()[0];
      if (next) activate(next.id);
      else await create();
    }
    emit("change");
  }

  /**
   * "Move to <space>" (architecture.md §27): the note is encrypted for the
   * members of the new space and pushed with it. The server records the old
   * space, so its members learn that the note left. Only to a space of this
   * device: a move away from all of its own spaces is a loss, never a click.
   * @param {string} id @param {string} space @returns {Promise<boolean>}
   */
  async function move(id, space) {
    const record = buffers.get(id);
    if (!record || !record.sync || record.sync.tombstone || record.sync.space === space) return false;
    if (spaces.modeOf(space) === undefined) return false;
    const text = record.enc ? await plainOf(record, await body(id)) : await body(id);
    if (text === undefined) throw new Error("move: this note cannot be read here");
    const before = record.sync.space;
    record.sync.space = space;
    if (!record.enc) record.enc = codec.newEncMeta("space");
    try {
      record.content = await encodeFor(record, text);
    } catch (err) {
      record.sync.space = before;
      throw err;
    }
    plain.set(id, text);
    record.sync.dirty = true;
    delete record.sync.rewrap;
    if (record.file) await writeFileNow(record);
    await persist({ ...record });
    if (!isMyTab(id)) dropBody(record);
    emit("change");
    return true;
  }

  /**
   * The upgrade (architecture.md §27): each synced note from before is plain
   * text on this device and on the server. Once its space has members here,
   * it is encrypted for them, pushed, and its old revisions purged. A synced
   * file stops syncing instead: turning it into an `.age` file is the user's
   * call (§19), from its menu. Each window does its own tabs; the leader also
   * does Recent.
   * @param {{mineOnly?: boolean}} [opts]
   */
  async function sealSynced(opts = {}) {
    const mine = new Set(workspaces.current().tabs);
    const open = workspaces.openSet();
    let changed = false;
    for (const record of [...buffers.values()]) {
      if (!isDocument(record) || !record.sync || record.enc || record.trashedAt || record.sync.tombstone) continue;
      const id = record.id;
      if (open.has(id) ? !mine.has(id) : opts.mineOnly) continue;
      const space = record.sync.space;
      if (!space || !spaces.recipients(space).length) continue;
      if (record.file) {
        record.sync.tombstone = "detached";
        record.sync.dirty = true;
        record.sync.purge = true;
      } else {
        // Every device of the space runs this for its copy of the same old
        // note. Without unpushed text, the change is the encryption alone,
        // and the device that loses the race takes the winner's row without
        // a conflict copy (rewrap, see applyRemote).
        const wasDirty = record.sync.dirty;
        try {
          await sealForSpace(record, space);
        } catch (err) {
          console.log("[vrtti] upgrade: note not encrypted yet", id, err);
          continue;
        }
        record.sync.purge = true;
        if (!wasDirty) record.sync.rewrap = true;
      }
      await persist({ ...record });
      changed = true;
    }
    if (changed) emit("change");
    if (!opts.mineOnly) post("seal-synced", {});
  }
  on("seal-synced", () => void sealSynced({ mineOnly: true }));

  /**
   * A note this device holds as a title only, encrypted again for the
   * current members of its space (architecture.md §27): its text and its
   * sealed meta, for the sync client to push. null when this device cannot
   * read it or does not know the members.
   * @param {Change} change The note as the server has it.
   * @returns {Promise<{content: string, meta: RecordMeta} | null>}
   */
  async function rewrapChange(change) {
    const meta = change.meta || {};
    const space = change.space ?? "";
    const members = spaces.recipients(space);
    if (!meta.enc || typeof change.content !== "string" || !members.length) return null;
    try {
      /** @type {import("../storage/idb.js").EncMeta} */
      const enc = { v: 1, preset: "space", spaceSeq: spaces.logSeq(space) };
      const text = await codec.decode(change.content, meta.enc, keyring);
      /** @type {RecordMeta} */
      const out = { kind: meta.kind === "keyring" ? "keyring" : "scratch", enc };
      if (meta.sealed) {
        const fields = await codec.decode(meta.sealed, enc, keyring);
        out.sealed = await codec.encode(fields, enc, keyring, members);
      }
      return { content: await codec.encode(text, enc, keyring, members), meta: out };
    } catch {
      return null;
    }
  }

  /**
   * The text and the title of a note for "Back up to a folder" (§27). The
   * text this device holds wins over the server copy: it may hold edits the
   * server has not got yet. null for a note this device cannot read.
   * @param {Change} change The newest server row of the note.
   * @returns {Promise<{text: string, title: string} | null>}
   */
  async function readForBackup(change) {
    const record = buffers.get(change.docId);
    if (record && !record.trashedAt) {
      try {
        return { text: await textOf(record.id), title: titleOf(record) };
      } catch {
        // A file not readable here: the server copy below.
      }
    }
    const meta = change.meta || {};
    try {
      const text = meta.enc ? await codec.decode(change.content ?? "", meta.enc, keyring) : change.content ?? "";
      const sealed = await unseal(meta.sealed);
      return { text, title: sealed?.title || sealed?.line || firstLineTitle(text) };
    } catch {
      return null;
    }
  }

  /** A backup file as armored age for this device and the recovery key. @param {string} text */
  function encryptForBackup(text) {
    return codec.encode(text, codec.newEncMeta("this-device"), keyring);
  }

  /**
   * The PIN-locked notes close (ui/pin.js): the editor drops their states,
   * as for a lock of the keys, and shows the pad on the next open.
   */
  function pinLock() {
    setPinOpen(false);
    const ids = [...buffers.values()].filter((b) => b.pin).map((b) => b.id);
    emit("lock", { ids });
    emit("change");
  }

  /** The right PIN: every PIN-locked note opens in this window. */
  function pinUnlock() {
    setPinOpen(true);
    emit("unlock");
    emit("change");
  }

  /**
   * "Lock with PIN" and "Remove PIN lock" (architecture.md §27). The mark
   * travels sealed with a synced note; the PIN itself never leaves the
   * device (ui/pin.js).
   * @param {string} id @param {boolean} on
   */
  async function setPin(id, on) {
    const record = buffers.get(id);
    if (!record || Boolean(record.pin) === on) return false;
    if (on) record.pin = true;
    else delete record.pin;
    markDirty(record);
    await persist({ ...record });
    emit("change");
    return true;
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

  // Compare disk against this window's loaded file tabs: the file's own
  // stamp against `file.mtime`, the stamp of this device's last read or write
  // (§23). No hashing. FileSystemObserver replaces this poll when it is
  // stable.
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
      if (typeof record.content !== "string") {
        // A tab never read has no working copy to compare: its next
        // activation reads the file as it is. The active tab is the one
        // exception, because it may be showing "File not available": a
        // file that came back is read here, and the editor puts it up (§23).
        if (record.id !== activeId) continue;
        try {
          await bodyOf(record.id);
          emit("available", { id: record.id });
        } catch {
          // Still unavailable: the placeholder stays, the marker too.
        }
        continue;
      }
      // A persist is pending: its own pre-write check sees whatever is on
      // disk, with the keystroke rule, which is the right one for a tab
      // with unsaved text.
      if (saveTimers.has(record.id)) continue;
      try {
        if (record.file.unwritten) {
          // The retry of a failed write (§23), on focus and on the interval.
          await writeBody(record);
          await persist({ ...record });
          continue;
        }
        const disk = await movedOnDisk(record, handle);
        if (!disk) continue;
        // Two encryptions of the same text give different bytes, so this
        // shortcut simply never fires for a `.age` file. Correct, only slower:
        // a touched `.age` file takes the replace path instead.
        if (disk.content === record.content) {
          // Same bytes: a touch. Keep the new stamp, so this file stops
          // re-triggering on every poll.
          record.file.mtime = disk.mtime;
          await persist({ ...record });
          continue;
        }
        // Clean here (no persist pending, nothing unwritten): a silent
        // reload, no fork (§2).
        await replaceFromDisk(record.id, disk);
      } catch (err) {
        // Unreadable: permission dropped, or the file is gone. A poll must
        // never throw, and only the first case earns a reconnect marker.
        await refreshPermissionFlag(record, err);
      }
    }
  }

  /**
   * Does this buffer's file need a click: a permission grant, a re-pick, or
   * the retry of a write that failed (§23)?
   * @param {BufferRecord} record
   */
  function needsReconnect(record) {
    return Boolean(
      record.file && (needsPermission.has(record.file.handleId) || record.file.unwritten)
    );
  }

  /**
   * Runs from a click, which is the only context where requestPermission may
   * prompt. Reconnect never overwrites (§23): after a grant or a fresh pick
   * the file is the body and the record reads it. Only an `unwritten` record
   * writes its held text, through the pre-write check.
   * @param {string} id
   */
  async function reconnect(id) {
    const record = buffers.get(id);
    const handle = handleFor(record);
    if (!record || !record.file || !handle) return false;
    const handleId = record.file.handleId;
    if (isDesktop) {
      // A native write that failed for another reason than a missing file
      // (a full disk, a lock) needs a retry, not a picker: the file is there.
      if (record.file.unwritten && isNativeHandle(handle)) {
        const missing = await lastModified(handle).then(
          () => false,
          (err) => Boolean(err && err.name === "NotFoundError")
        );
        if (!missing) {
          const ok = await writeBody(record);
          await persist({ ...record });
          if (ok) emit("available", { id });
          return ok;
        }
      }
      // In the shell a reconnect is otherwise a fresh pick. Either the record
      // is from before the native backend and holds a WebView2 handle, which
      // cannot tell Rust which file it points at, or it is a native root whose
      // file moved or vanished (architecture.md §17, "Mixed handles"). The
      // picker runs from this click because a click is the only place a
      // picker may open. Same handle id, so the buffer keeps its link.
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
      needsPermission.delete(handleId);
      // The old file's stamp says nothing about the picked one.
      delete record.file.mtime;
      if (record.file.unwritten) {
        await writeBody(record);
        await persist({ ...record });
      } else if (typeof record.content === "string") {
        // The picked file is the body: never overwrite it with the tab.
        await replaceFromDisk(id);
      } else {
        // Nothing loaded: the next read takes the picked file. It may hold
        // other text than the lost one, so the server hears about it.
        markDirty(record);
        await persist({ ...record });
      }
    } else {
      if (!(await ensurePermission(handle, "readwrite"))) return false;
      needsPermission.delete(handleId);
      if (record.file.unwritten) {
        await writeBody(record);
        await persist({ ...record });
      } else if (typeof record.content === "string") {
        await checkExternalChanges();
      }
    }
    // The editor re-reads a tab that showed "File not available".
    emit("available", { id });
    emit("change");
    return true;
  }

  /**
   * Unlink file (§23): the inverse of Save to disk. The body becomes the
   * record's own `content`, the record a scratch one, and the handle row
   * goes. The file on disk is not touched. Also the way out of a lost file,
   * as long as its text is held (`unwritten`); a file that cannot be read
   * rejects with UnavailableError, and the command says so.
   * @param {string} id @returns {Promise<BufferRecord | null>}
   */
  async function unlinkFile(id) {
    const record = buffers.get(id);
    if (!record || !record.file) return null;
    const text = await body(id);
    const { handleId, name } = record.file;
    handles.delete(handleId);
    needsPermission.delete(handleId);
    await deleteHandle(handleId);
    // The row keeps the file's name as its label; the user can rename it.
    if (!record.title) {
      record.title = decryptedName(name);
      // The title is metadata that syncs (§5); a scratch doc has no file
      // name to show on the other devices.
      markDirty(record);
    }
    record.kind = "scratch";
    delete record.file;
    record.content = text;
    diskFailed.delete(id);
    await persist({ ...record });
    emit("change");
    return record;
  }

  /**
   * The sync leader's watch over Recent (§23): one stat per file-backed note
   * with a server target, before each push round. A changed stamp marks it
   * dirty, and the push then reads the file. Never reads a body here. A tab
   * of any window is skipped: its window's own poll watches it, and only
   * that window writes its record (§14).
   */
  async function stampRecentFiles() {
    for (const record of [...buffers.values()]) {
      if (!record.file || !record.sync || record.sync.tombstone || record.trashedAt) continue;
      if (workspaces.ownerOf(record.id) !== null) continue;
      const handle = handleFor(record);
      if (!handle) continue;
      let stat;
      try {
        stat = await lastModified(handle);
      } catch {
        continue;
      }
      if (stat === record.file.mtime) continue;
      // Unknown means "never read since the migration": nothing to compare,
      // so no edit to report, only a stamp to keep.
      if (record.file.mtime !== undefined) markDirty(record);
      record.file.mtime = stat;
      await persist({ ...record });
    }
  }

  /**
   * An empty scratch buffer never reaches Recent (user decision, 2026-09-24):
   * a Recent full of "untitled" rows with nothing in them is noise. Empty
   * means no text, no name of its own, not on disk and readable: a locked
   * doc's content is ciphertext, and a blank file is still a file.
   * @param {BufferRecord} record
   */
  function isEmpty(record) {
    if (!isDocument(record) || record.kind === "file" || record.title) return false;
    if (record.enc) {
      // A synced note is encrypted even while empty (§27), so its decoded
      // text decides. Without it in memory (after a restart) the first line
      // does: "" means no line with anything on it. Any other preset is a
      // note the user encrypted on purpose, and that is never empty.
      if (record.enc.preset !== "space") return false;
      const text = plain.get(record.id) ?? (record.firstLine === "" ? "" : undefined);
      return text !== undefined && text.trim() === "";
    }
    return (record.content ?? "").trim() === "";
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
    const record = buffers.get(id);
    buffers.delete(id);
    plain.delete(id);
    await remove(id);
    // Nothing else owns a file record's handle row (linkFile makes one per
    // record); left behind, it would sit in the store for ever.
    if (record?.file) {
      handles.delete(record.file.handleId);
      needsPermission.delete(record.file.handleId);
      await deleteHandle(record.file.handleId);
    }
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
    // The flush: a keystroke still in its debounce reaches its storage now,
    // because the working copy goes next (§23).
    const pending = saveTimers.has(id);
    dropTimers(id);
    if (pending) await persistNow(id);
    // In Recent, a file-backed record has no body in memory (§23).
    dropBody(record);
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

  /**
   * The sidebar drag (architecture.md §9): the Open list is this workspace's
   * tab order, so a move is a workspace write and a redraw, nothing on the
   * buffer record. `beforeId` null means last.
   * @param {string} id @param {string | null} beforeId
   */
  async function moveTab(id, beforeId) {
    await workspaces.moveTab(id, beforeId);
    emit("change");
  }

  async function load() {
    for (const record of await getAllBuffers()) buffers.set(record.id, record);
    for (const stub of await getRemotes()) remotes.set(stub.id, stub);
    // Handles come back from IndexedDB with their permission possibly back at
    // "prompt". Nothing prompts here: that needs a user gesture. Nothing is
    // read here either: a file body is read when its tab is shown (§23).
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
    const mine = isMyTab(id);
    if (mine && saveTimers.has(id)) return;
    const previous = buffers.get(id);
    // A file-backed record travels without its body (§23). This window's
    // working copy of its own tab stays; an undefined from the message must
    // not wipe it.
    const loaded =
      mine &&
      Boolean(record.file) &&
      typeof record.content !== "string" &&
      typeof previous?.content === "string";
    if (loaded) record.content = previous?.content;
    buffers.set(id, record);
    if (record.kind === "keyring") {
      plain.delete(id);
      emit("system", { id });
      emit("change");
      return;
    }
    // Trashed in another window (the leader lost the note, §27): the tab
    // here closes as for a removal.
    if (record.trashedAt && mine) {
      plain.delete(id);
      await closeHere(id);
      return;
    }
    if (loaded) {
      // Only a file write elsewhere moves the stamp of this window's tab:
      // the sync leader applied a pull itself (§14.3 fallback). The file is
      // the body, so the tab reads it; the leader already told the server.
      if (record.file?.mtime !== previous?.file?.mtime) {
        // The old stamp until the read lands: a read that fails leaves the
        // tab's text as it was, and the next poll must still see the change.
        if (previous?.file) record.file = { ...record.file, mtime: previous.file.mtime };
        await replaceFromDisk(id, undefined, { edit: false }).catch((err) =>
          console.log("[vrtti] re-read after another window's write failed", id, err)
        );
      }
      emit("change");
      return;
    }
    const contentChanged =
      !previous ||
      previous.content !== record.content ||
      Boolean(previous.enc) !== Boolean(record.enc);
    // The decoded text belongs to the old ciphertext.
    if (contentChanged) plain.delete(id);
    if (mine && contentChanged && typeof record.content === "string") {
      await announceReplace(record);
    }
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
    // A tab another window took (a dissolve, a lost double take) keeps no
    // body here any more (§23); its owner reads its own.
    for (const record of buffers.values()) {
      if (!tabs.includes(record.id) && !saveTimers.has(record.id)) dropBody(record);
    }
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
    await emptyOldTrash();
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
    trashed,
    restore,
    putSystemRecord,
    keyringRecord,
    load,
    start,
    create,
    close,
    reopen,
    moveTab,
    activate,
    textOf,
    loadedText,
    // The encoded body of any record, read from its file when this window
    // holds none (§23). The one door for a caller that needs the bytes.
    body,
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
    reencryptStale,
    reencryptAll,
    unsealPending,
    sealSynced,
    move,
    trash: trashNote,
    setPin,
    pinLock,
    pinUnlock,
    readForBackup,
    encryptForBackup,
    /** @param {string} id */
    isPinLocked(id) {
      const record = buffers.get(id);
      return Boolean(record && isPinLocked(record));
    },
    rewrapChange,
    // Exported for the sync client (architecture.md §13.6): a pull that meets
    // a dirty local record forks it before it adopts the incoming one.
    forkConflict,
    // The sync surface (architecture.md §13.6). The client owns the network
    // and the schedule; every one of these owns a rule about records.
    setSync,
    clearSync,
    clearPurge,
    applyRemote,
    // From server (architecture.md §25).
    remotes: remoteList,
    dropRemote,
    forgetRemotes,
    loseSpace,
    createFromChange,
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
    unlinkFile,
    // For the sync leader, before each push round (§23).
    stampRecentFiles,
    UnavailableError,
  };
}
