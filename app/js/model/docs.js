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
//
// Persistence: every mutation writes through to IndexedDB, content edits with
// a debounce. This is the first stage of the write pipeline (architecture.md
// §1); the disk stage is a second debounce behind it, sync attaches later.
//
// Disk is the source of truth for a file-backed buffer, IndexedDB its journal:
// a denied permission or a vanished file costs the user nothing, because the
// text is already durable before the disk write is even attempted.

import {
  deleteHandle,
  getAllBuffers,
  getAllHandles,
  newBufferRecord,
  putBuffer,
  putHandle,
} from "../storage/idb.js";
import {
  ensurePermission,
  lastModified,
  permissionState,
  readFile,
  saveFilePicker,
  writeFile,
} from "../storage/fsa.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */

const ACTIVE_KEY = "vrtti.activeBuffer";
const SAVE_DELAY = 300;
// Second debounce, behind the IndexedDB one: a disk write is slower and more
// fragile, and nothing is lost by batching a few more keystrokes into it.
const DISK_DELAY = 1000;
// Slow poll for external edits. Window focus is the responsive trigger; this
// only covers a window that stays focused while another program writes.
const WATCH_INTERVAL = 30000;
const TITLE_MAX = 40;

/** @param {BufferRecord} record @returns {string} */
export function titleOf(record) {
  // A file-backed buffer is named by its file. Deriving the title from the
  // first line would rename someone's file every time they edit line 1.
  if (record.kind === "file" && record.file) return record.file.name;

  const lines = (record.content || "").split("\n");
  for (const line of lines) {
    const text = line.trim();
    if (text) return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) : text;
  }
  return "untitled";
}

export function createDocStore() {
  /** @type {Map<string, BufferRecord>} */
  const buffers = new Map();
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
  const events = new EventTarget();
  /** @type {string | null} */
  let activeId = null;

  /** @param {string} type @param {object} [detail] */
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function openBuffers() {
    return [...buffers.values()]
      .filter((b) => !b.closed)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function closedBuffers() {
    return [...buffers.values()]
      .filter((b) => b.closed)
      .sort((a, b) => b.updatedAt - a.updatedAt);
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

  /** @param {string} id @param {string} content */
  function updateContent(id, content) {
    const record = buffers.get(id);
    if (!record) return;
    // A replace (silent reload from disk) echoes straight back here through the
    // editor's update listener. Without this guard that echo would bump
    // updatedAt past lastSyncAt and make a just-synced buffer look dirty.
    if (record.content === content) return;
    record.content = content;
    record.updatedAt = Date.now();
    if (id === activeId) emit("save", { status: "…" });
    emit("change");
    persistSoon(id);
  }

  async function create() {
    const record = newBufferRecord();
    buffers.set(record.id, record);
    await putBuffer(record);
    activate(record.id);
    emit("change");
    return record;
  }

  // ---- Disk files (architecture.md §2) ------------------------------------

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
   */
  async function createFromFile(handle) {
    const existing = await bufferForHandle(handle);
    if (existing) {
      if (existing.closed) await reopen(existing.id);
      else activate(existing.id);
      return existing;
    }
    const { content } = await readFile(handle);
    const record = newBufferRecord();
    record.content = content;
    await linkFile(record, handle);
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
    const { content } = await readFile(handle);
    record.content = content;
    record.updatedAt = Date.now();
    record.file.lastSyncAt = record.updatedAt;
    await putBuffer({ ...record });
    emit("replace", { id, content });
    emit("change");
  }

  /**
   * The local text forks into a scratch buffer, the file buffer then takes the
   * disk version. Nothing is lost and nothing prompts.
   * @param {BufferRecord} record
   */
  async function forkConflict(record) {
    const fork = newBufferRecord();
    fork.content =
      "conflict copy of " +
      (record.file ? record.file.name : titleOf(record)) +
      " (" +
      new Date().toISOString() +
      ")\n\n" +
      record.content;
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
        const { content } = await readFile(handle);
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
    load,
    start,
    create,
    close,
    reopen,
    activate,
    updateContent,
    createFromFile,
    saveAs,
    replaceFromDisk,
    checkExternalChanges,
    needsReconnect,
    reconnect,
  };
}
