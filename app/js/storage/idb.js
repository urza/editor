// Raw IndexedDB. No wrapper library.
// Buffer record: { id, content, closed, createdAt, updatedAt }.
// Title is deliberately NOT stored: it is derived from the text on render, so
// editing the first line renames the buffer with no extra write path.

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
