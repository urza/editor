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
//
// Persistence: every mutation writes through to IndexedDB, content edits with
// a debounce. This is the first stage of the write pipeline (architecture.md
// §1); disk and sync stages attach behind it in later phases.

import {
  getAllBuffers,
  newBufferRecord,
  putBuffer,
} from "../storage/idb.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */

const ACTIVE_KEY = "vrtti.activeBuffer";
const SAVE_DELAY = 300;
const TITLE_MAX = 40;

/** @param {BufferRecord} record @returns {string} */
export function titleOf(record) {
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
      }, SAVE_DELAY)
    );
  }

  /** @param {string} id */
  function activate(id) {
    if (!buffers.has(id) || id === activeId) return;
    const previousId = activeId;
    activeId = id;
    localStorage.setItem(ACTIVE_KEY, id);
    emit("active", { id, previousId });
  }

  /** @param {string} id @param {string} content */
  function updateContent(id, content) {
    const record = buffers.get(id);
    if (!record) return;
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
  };
}
