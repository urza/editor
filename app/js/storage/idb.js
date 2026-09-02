// @ts-check
// Raw IndexedDB. No wrapper library.
// A title is derived, not stored: a scratch buffer takes it from the text on
// render, so editing the first line renames the buffer with no extra write
// path. A file-backed buffer takes it from `file.name`, the name of the file
// on disk, not a cached title. The one stored title is `title`, and it exists
// only when the user typed one in the sidebar rename box.
// Later phases bump DB_VERSION and add stores (sync, settings) plus record
// fields (sync, enc, group, order); see architecture.md §7.

/**
 * @typedef {Object} FileLink
 * @property {string} handleId  Key into the "handles" store.
 * @property {string} name      Disk file name, kept here so the sidebar renders without a handle.
 * @property {number} lastSyncAt  Epoch ms of the last successful disk read or write.
 * @property {string} [path]  Path inside the folder it was opened from, display only.
 */

/**
 * @typedef {Object} BufferRecord
 * @property {string} id
 * @property {string} content  Opaque to this layer: plaintext today, may be age ciphertext later.
 * @property {boolean} closed
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} [title]  User label from the sidebar rename (architecture.md
 *                            §7). Wins over every derived title; absent means
 *                            "derive it", which is the state of every record
 *                            nobody renamed. Optional, so no migration.
 * @property {'scratch' | 'file'} [kind]  Absent means scratch (every v1 record).
 * @property {FileLink} [file]  Present exactly when kind is 'file'.
 * @property {string} [lang]  Language mode id from js/editor/lang.js ("markdown",
 *                            "json", …). Absent means nothing has decided one yet,
 *                            so the editor detects it again on open.
 * @property {'auto' | 'user'} [langSource]  Who decided `lang`. A 'user' choice is
 *                            never overwritten by detection (architecture.md §9).
 */

/**
 * @typedef {Object} HandleRecord
 * @property {string} id
 * @property {'file' | 'directory'} kind  A file buffer's handle, or an opened folder.
 * @property {any} handle   FileSystemFileHandle or FileSystemDirectoryHandle;
 *                          structured-cloneable, so IndexedDB keeps it.
 * @property {string} name
 * @property {number} addedAt
 */

const DB_NAME = "vrtti";
const DB_VERSION = 2;
const STORE = "buffers";
const HANDLES = "handles";

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
      // Every version's stores are created here, each behind a "does it exist"
      // check. That makes the handler idempotent, so one code path upgrades a
      // v1 database and creates a fresh v2 one.
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(HANDLES)) {
          db.createObjectStore(HANDLES, { keyPath: "id" });
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

// Handles store (architecture.md §2). A FileSystemFileHandle survives here
// across restarts; the permission attached to it may not, which is why every
// disk access re-checks it (storage/fsa.js).

/** @param {HandleRecord} record */
export async function putHandle(record) {
  const db = await openDb();
  const tx = db.transaction(HANDLES, "readwrite");
  tx.objectStore(HANDLES).put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @param {string} id @returns {Promise<HandleRecord | undefined>} */
export async function getHandle(id) {
  const db = await openDb();
  return request(db.transaction(HANDLES, "readonly").objectStore(HANDLES).get(id));
}

/** @returns {Promise<HandleRecord[]>} */
export async function getAllHandles() {
  const db = await openDb();
  return request(db.transaction(HANDLES, "readonly").objectStore(HANDLES).getAll());
}

/** @param {string} id */
export async function deleteHandle(id) {
  const db = await openDb();
  const tx = db.transaction(HANDLES, "readwrite");
  tx.objectStore(HANDLES).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
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
