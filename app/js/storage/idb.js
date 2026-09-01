// @ts-check
// Raw IndexedDB. No wrapper library.
// Title is deliberately NOT stored: it is derived from the text on render, so
// editing the first line renames the buffer with no extra write path.
// Later phases bump DB_VERSION and add stores (handles, sync, settings) plus
// record fields (kind, file, sync, enc, group, order); see architecture.md §7.

/**
 * @typedef {Object} BufferRecord
 * @property {string} id
 * @property {string} content  Opaque to this layer: plaintext today, may be age ciphertext later.
 * @property {boolean} closed
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const DB_NAME = "vrtti";
const DB_VERSION = 1;
const STORE = "buffers";

let dbPromise = null;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function getAllBuffers() {
  const db = await openDb();
  return request(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
}

export async function putBuffer(record) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  // Resolve on transaction completion, not on the put request: only oncomplete
  // means the write is durable, and the status bar promises exactly that.
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteBuffer(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @returns {BufferRecord} */
export function newBufferRecord() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    content: "",
    closed: false,
    createdAt: now,
    updatedAt: now,
  };
}
