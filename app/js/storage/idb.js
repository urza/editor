// @ts-check
// Raw IndexedDB. No wrapper library.
// A title is derived, not stored: a scratch buffer takes it from the text on
// render, so editing the first line renames the buffer with no extra write
// path. A file-backed buffer takes it from `file.name`, the name of the file
// on disk, not a cached title. The one stored title is `title`, and it exists
// only when the user typed one in the sidebar rename box (or, later, when a
// doc turns encrypted and needs a readable name).
// v3 added the "settings" store and the record fields the crypto and sync work
// reserved: kind 'keyring', sync, enc (architecture.md §7). `group` and
// `order` for manual sidebar ordering are still reserved and unused.
// v4 added the "workspaces" store and removed the buffer `closed` flag:
// membership in a workspace's `tabs` is the one truth for "open" (§14.1).
// v5 deleted `content` and `file.lastSyncAt` from every record with `file`:
// a file-backed note keeps its body in the file and nowhere else (§23).
// v6 added the "remote" store for From server stubs and `sync.space` on every
// synced record (§25).

/**
 * @typedef {Object} FileLink
 * @property {string} handleId  Key into the "handles" store.
 * @property {string} name      Disk file name, kept here so the sidebar renders without a handle.
 * @property {string} [path]  Path inside the folder it was opened from, display only.
 * @property {number} [mtime]  The file's modification time as the platform
 *                             reported it at this device's last successful read
 *                             or write (architecture.md §23). "Changed on disk"
 *                             is a stat that differs from it. Undefined until
 *                             the first read after the v5 migration, which
 *                             means "nothing to compare against": no fork.
 * @property {true} [unwritten]  The last file write failed, so the row holds
 *                             `content` next to the file until the next write
 *                             attempt lands and clears it (§23).
 */

/**
 * Encryption metadata. It carries the PRESET ID and never the resolved
 * recipient list: an age header deliberately hides who can decrypt a file, and
 * writing the list here would hand the server exactly that (architecture.md §5).
 * The keyring resolves the preset to recipients at encrypt time.
 *
 * @typedef {Object} EncMeta
 * @property {1} v
 * @property {'space' | 'this-device' | 'all-devices'} preset  'space': the
 *   members of the note's space (architecture.md §27), the preset of every
 *   synced note. 'this-device': this device, for a `.age` file on disk and a
 *   local note. 'all-devices' is from before §27; v7 rewrote it, and a stray
 *   one reads as 'this-device'.
 * @property {number} [spaceSeq]  'space' only: the log position of the member
 *   list the note is encrypted for. A device that applied a later position
 *   encrypts the note again.
 */

/**
 * Sync target state (architecture.md §7). Absent means the doc is local only.
 *
 * @typedef {Object} SyncState
 * @property {number} rev  Last server revision this record agreed with; 0 = never pushed.
 * @property {boolean} dirty  Local changes wait for a push.
 * @property {'deleted' | 'detached'} [tombstone]  A pending push of that kind.
 * @property {true} [purge]  Ask the push loop to delete older server revisions
 *                           after the next successful push (encrypt conversion, §5).
 * @property {string} [space]  The server space the doc lives in (architecture.md
 *                           §25, §27). A move changes it. Absent only before
 *                           the v6 backfill ran.
 * @property {true} [rewrap]  The only change waiting for a push is a new
 *                           encryption for the current members, which every
 *                           member makes on its own. A 409 on such a push
 *                           forks nothing (model/docs.js applyRemote).
 * @property {boolean} [priorDirty]  Whether `dirty` was true before a user
 *                           trash set `tombstone = "deleted"`, so an offline
 *                           Restore to space keeps unsent edits (§28).
 * @property {true} [forget]  Remove the record once a pending `detached`
 *                           tombstone lands (Remove from list on a synced file).
 */

/**
 * A From server entry (architecture.md §25, §28): a note of a `list` space that
 * this device has not fetched (or closed and demoted back to a stub). A stub,
 * not a record, so it is in no search and no trash, and it dies when a record
 * with its id appears.
 *
 * @typedef {Object} RemoteStub
 * @property {string} id  The document id, the same as the record's would be.
 * @property {string} space
 * @property {string} title  `meta.title`, else the first line of the text at
 *                           stub time; "" for an encrypted or PIN-locked note
 *                           without an explicit user title (§28).
 * @property {number} rev  The newest revision seen, so a re-delivered older
 *                           row does not overwrite a newer title.
 * @property {true} [enc]  The note is encrypted.
 * @property {true} [pin]  Locked with the device PIN: never stores first line.
 * @property {number} [spaceSeq]  `meta.enc.spaceSeq`, for the re-encryption of
 *                           a note this device holds as a title only (§27).
 * @property {string} [sealed]  `meta.sealed`, kept while the device is locked,
 *                           so the title can be read at the next unlock.
 * @property {number} updatedAt  The other device's clock, for the sort.
 */

/**
 * @typedef {Object} BufferRecord
 * @property {string} id
 * @property {string} [content]  The body, opaque to this layer (plaintext or
 *                            age ciphertext). Absent for a file-backed record,
 *                            whose body is the file (architecture.md §23);
 *                            present there only while `file.unwritten` holds a
 *                            body the file write did not take.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} [title]  User label from the sidebar rename (architecture.md
 *                            §7). Wins over every derived title; absent means
 *                            "derive it", which is the state of every record
 *                            nobody renamed. Optional, so no migration. It is
 *                            also the readable name of an encrypted doc whose
 *                            first line is ciphertext.
 * @property {'scratch' | 'file' | 'keyring'} [kind]  Absent means scratch (every v1
 *                            record). 'keyring' marks the one hidden record that
 *                            carries the device list (architecture.md §13.3);
 *                            the sidebar never shows it.
 * @property {FileLink} [file]  Present exactly when kind is 'file'.
 * @property {SyncState} [sync]  Present exactly when the doc has a server target.
 * @property {EncMeta} [enc]  Present exactly when `content` is age ciphertext.
 * @property {string} [lang]  Language mode id from js/editor/lang.js ("markdown",
 *                            "json", …). Absent means nothing has decided one yet,
 *                            so the editor detects it again on open.
 * @property {'auto' | 'user'} [langSource]  Who decided `lang`. A 'user' choice is
 *                            never overwritten by detection (architecture.md §9).
 * @property {string[]} [spellOff]  The spellcheck languages ("cs", "en") that are off
 *                            for this note. Absent or empty means both are on.
 * @property {number} [trashedAt]  Set when a note enters Trash (user trash,
 *                            a remote `deleted` tombstone, 30-day Recent expiry,
 *                            or losing a space; architecture.md §22, §28): out
 *                            of every live list, restorable for 30 days.
 * @property {number} [closedAt]  Timestamp when the note was closed; cleared on
 *                            reopen and restore, used by 30-day Recent expiry (§28).
 * @property {string} [originSpace]  Space name remembered when a synced note
 *                            enters Trash, enabling Restore to <space> (§28).
 * @property {string} [firstLine]  The first line of an encrypted note's text,
 *                            set by the device whenever it reads or writes the
 *                            text, so the row has a title while the text stays
 *                            ciphertext (architecture.md §27). Travels sealed.
 * @property {true} [pin]     Locked with this device's PIN (architecture.md §27).
 * @property {string} [origin]  The device id of the first revision. Travels sealed.
 * @property {string} [sealed]  `meta.sealed` of a pulled revision this device
 *                            could not open yet (locked); unsealed at unlock.
 */

/**
 * One row of the settings store. `value` is any structured-cloneable thing the
 * owning module defines; this layer never looks inside it.
 *
 * @typedef {Object} SettingRecord
 * @property {string} key
 * @property {any} value
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

/**
 * @typedef {Object} WorkspaceRecord  One window (architecture.md §14).
 * @property {string} id  "main" for the main workspace, a UUID otherwise.
 * @property {string[]} tabs  Open buffers in tab order. Membership here is
 *                            the one truth for "open"; a buffer in no
 *                            workspace is in Recent.
 * @property {string | null} activeId
 * @property {string[]} folderIds  Directory handle ids from the handles store.
 * @property {string} [space]  Space name owned by a dedicated Space Window (§28).
 * @property {true} [initSpace]  Set on creation; cleared once initial tab claim runs.
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// The only import in this file: a stored native handle comes back as plain
// data and has to become an adapter again before anyone calls a method on it
// (architecture.md §17). In a browser reviveHandle passes a real FSA handle
// through; in the shell it hands out a stand-in that never calls the WebView.
import { reviveHandle } from "./native.js";

const DB_NAME = "vrtti";
// v8 adds KEYS, nothing else: no record changes.
const DB_VERSION = 8;
const STORE = "buffers";
const HANDLES = "handles";
const SETTINGS = "settings";
const WORKSPACES = "workspaces";
const REMOTE = "remote";
// Settings that hold a CryptoKey (see getSetting). No key path, on purpose.
const KEYS = "keys";
export const MAIN_WORKSPACE = "main";
// Where v3 kept the active buffer. v4 moves it into the main workspace
// record; the migration reads the key once and deletes it.
const LEGACY_ACTIVE_KEY = "vrtti.activeBuffer";

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
      // check. That makes the handler idempotent, so one code path upgrades
      // any older database and creates a fresh one. v1 to v3 never rewrote a
      // record, because every field they added was optional. v4, v5 and v6
      // rewrite the buffers once each (drop `closed`; drop the second body of
      // a file record; give `sync` its space), and those steps need the old
      // version number: a fresh database (oldVersion 0) has nothing to migrate.
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(HANDLES)) {
          db.createObjectStore(HANDLES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SETTINGS)) {
          db.createObjectStore(SETTINGS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(WORKSPACES)) {
          db.createObjectStore(WORKSPACES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(REMOTE)) {
          db.createObjectStore(REMOTE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(KEYS)) {
          // No keyPath: the one thing that makes a CryptoKey storable in
          // WebKit (see getSetting). Do not "align" it with the others.
          db.createObjectStore(KEYS);
        }
        const tx = req.transaction;
        const old = event.oldVersion;
        // Each step runs from inside the previous one's callback, after it
        // queued its puts: two getAll() issued side by side would both read
        // the old rows, and the later put would bring back what the earlier
        // step removed (`closed`, a file record's second body).
        if (old > 0 && old < 4 && tx) {
          migrateToWorkspaces(tx, () =>
            migrateToOneBody(tx, () => migrateToSpaces(tx, () => migrateToSpacePreset(tx)))
          );
        } else if (old === 4 && tx) {
          migrateToOneBody(tx, () => migrateToSpaces(tx, () => migrateToSpacePreset(tx)));
        } else if (old === 5 && tx) {
          migrateToSpaces(tx, () => migrateToSpacePreset(tx));
        } else if (old === 6 && tx) {
          migrateToSpacePreset(tx);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another window opened a newer schema, which means a newer build
        // after a deploy. Close so its upgrade can proceed, drop the cached
        // promise so nothing hands out a closed connection, and let main.js
        // reload this window into that build (architecture.md §14.1).
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
          window.dispatchEvent(new Event("vrtti:db-versionchange"));
        };
        resolve(db);
      };
      // Older windows hold the old version open. They close on their own
      // versionchange event, so this resolves by itself; the log is for the
      // case where one of them is stuck.
      req.onblocked = () => {
        console.log("[vrtti] database upgrade waits for another window to close");
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

/**
 * v3 to v4: the main workspace takes over the `closed` flag and the
 * localStorage active-buffer key (architecture.md §14.1). Runs inside the
 * upgrade transaction, which stays open while these requests chain, so no
 * await is possible here: the callbacks nest instead.
 * @param {IDBTransaction} tx
 * @param {() => void} then  The next migration, started once the puts are queued.
 */
function migrateToWorkspaces(tx, then) {
  const buffers = tx.objectStore(STORE);
  buffers.getAll().onsuccess = (event) => {
    /** @type {any[]} */
    const all = /** @type {IDBRequest} */ (event.target).result;
    // Open buffers keep their old order, which was createdAt.
    const tabs = all
      .filter((record) => record.closed !== true && record.kind !== "keyring")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => record.id);
    for (const record of all) {
      if ("closed" in record) {
        delete record.closed;
        buffers.put(record);
      }
    }
    then();
    tx.objectStore(HANDLES).getAll().onsuccess = (event2) => {
      /** @type {any[]} */
      const handles = /** @type {IDBRequest} */ (event2.target).result;
      const folderIds = handles
        .filter((handle) => handle.kind === "directory")
        .sort((a, b) => a.addedAt - b.addedAt)
        .map((handle) => handle.id);
      let active = null;
      try {
        active = localStorage.getItem(LEGACY_ACTIVE_KEY);
        localStorage.removeItem(LEGACY_ACTIVE_KEY);
      } catch {
        // No localStorage (a blocked context): the first tab is active.
      }
      const now = Date.now();
      tx.objectStore(WORKSPACES).put({
        id: MAIN_WORKSPACE,
        tabs,
        activeId: active && tabs.includes(active) ? active : tabs[0] ?? null,
        folderIds,
        createdAt: now,
        updatedAt: now,
      });
    };
  };
}

/**
 * v4 to v5: a file-backed record loses its IndexedDB copy of the body and
 * `file.lastSyncAt` (architecture.md §23). The file was already the truth
 * (§1), and the focus poll would have replaced the copy at the next focus.
 * Same shape as migrateToWorkspaces: no await inside the upgrade transaction,
 * and running it twice changes nothing.
 * @param {IDBTransaction} tx
 * @param {() => void} [then]  The next migration, started once the puts are queued.
 */
function migrateToOneBody(tx, then) {
  const buffers = tx.objectStore(STORE);
  buffers.getAll().onsuccess = (event) => {
    /** @type {any[]} */
    const all = /** @type {IDBRequest} */ (event.target).result;
    for (const record of all) {
      if (!record.file) continue;
      delete record.content;
      delete record.file.lastSyncAt;
      buffers.put(record);
    }
    then?.();
  };
}

/**
 * v5 to v6: every synced record gets its space (architecture.md §25). Before
 * spaces every server row was one of two kinds, so the keyring record goes to
 * `keyring` and every other one to `personal`, which is where the server's
 * own migration puts the same rows. The strings are repeated here, not
 * imported from the model: this layer imports nothing it does not store.
 * @param {IDBTransaction} tx
 * @param {() => void} [then]  The next migration, started once the puts are queued.
 */
function migrateToSpaces(tx, then) {
  const buffers = tx.objectStore(STORE);
  buffers.getAll().onsuccess = (event) => {
    /** @type {any[]} */
    const all = /** @type {IDBRequest} */ (event.target).result;
    for (const record of all) {
      if (!record.sync || record.sync.space) continue;
      record.sync.space = record.kind === "keyring" ? "keyring" : "personal";
      buffers.put(record);
    }
    then?.();
  };
}

/**
 * v6 to v7: spaces as groups of devices (architecture.md §27). The preset
 * "all my devices" goes: a synced note is encrypted for the members of its
 * space ("space"), a local one for this device ("this-device"). The
 * ciphertext stays as it is; the spaceSeq of 0 makes the first device that
 * knows the members encrypt it again. A synced plain note keeps no `enc`
 * here: the upgrade encrypts it once the space has members (model/docs.js
 * sealSynced).
 * @param {IDBTransaction} tx
 */
function migrateToSpacePreset(tx) {
  const buffers = tx.objectStore(STORE);
  buffers.getAll().onsuccess = (event) => {
    /** @type {any[]} */
    const all = /** @type {IDBRequest} */ (event.target).result;
    for (const record of all) {
      if (!record.enc || record.enc.preset !== "all-devices") continue;
      record.enc =
        record.sync && record.kind !== "keyring"
          ? { v: 1, preset: "space", spaceSeq: 0 }
          : { v: 1, preset: "this-device" };
      buffers.put(record);
    }
  };
}

export async function getAllBuffers() {
  const db = await openDb();
  return request(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
}

/** @param {string} id @returns {Promise<BufferRecord | undefined>} */
export async function getBuffer(id) {
  const db = await openDb();
  return request(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
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

/**
 * Commit multiple buffer puts and deletes in one readwrite transaction so
 * startup housekeeping does not pay N separate IndexedDB fsyncs.
 * @param {{puts?: BufferRecord[], deletes?: string[]}} ops
 */
export async function putBuffersBatch({ puts = [], deletes = [] }) {
  if (puts.length === 0 && deletes.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const record of puts) store.put(record);
  for (const id of deletes) store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Commit an entire sync pull page's buffer, stub, and workspace mutations in
 * one atomic readwrite transaction instead of 200-400 separate transactions (H4).
 * @param {{
 *   putBuffers?: BufferRecord[],
 *   deleteBuffers?: string[],
 *   putRemotes?: RemoteStub[],
 *   deleteRemotes?: string[],
 *   putWorkspaces?: WorkspaceRecord[]
 * }} ops
 */
export async function applySyncBatch({
  putBuffers = [],
  deleteBuffers = [],
  putRemotes = [],
  deleteRemotes = [],
  putWorkspaces = [],
}) {
  /** @type {string[]} */
  const stores = [];
  if (putBuffers.length > 0 || deleteBuffers.length > 0) stores.push(STORE);
  if (putRemotes.length > 0 || deleteRemotes.length > 0) stores.push(REMOTE);
  if (putWorkspaces.length > 0) stores.push(WORKSPACES);
  if (stores.length === 0) return;

  const db = await openDb();
  const tx = db.transaction(stores, "readwrite");
  if (putBuffers.length > 0 || deleteBuffers.length > 0) {
    const bufStore = tx.objectStore(STORE);
    for (const r of putBuffers) bufStore.put(r);
    for (const id of deleteBuffers) bufStore.delete(id);
  }
  if (putRemotes.length > 0 || deleteRemotes.length > 0) {
    const remStore = tx.objectStore(REMOTE);
    for (const s of putRemotes) remStore.put(s);
    for (const id of deleteRemotes) remStore.delete(id);
  }
  if (putWorkspaces.length > 0) {
    const wsStore = tx.objectStore(WORKSPACES);
    for (const ws of putWorkspaces) wsStore.put(ws);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Remote store (architecture.md §25): the From server stubs. model/docs.js
// owns them; the sync leader writes them, every window reads them at start.

/** @returns {Promise<RemoteStub[]>} */
export async function getRemotes() {
  const db = await openDb();
  return request(db.transaction(REMOTE, "readonly").objectStore(REMOTE).getAll());
}

/** @param {RemoteStub} stub */
export async function putRemote(stub) {
  const db = await openDb();
  const tx = db.transaction(REMOTE, "readwrite");
  tx.objectStore(REMOTE).put(stub);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(stub);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @param {string} id */
export async function deleteRemote(id) {
  const db = await openDb();
  const tx = db.transaction(REMOTE, "readwrite");
  tx.objectStore(REMOTE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Workspaces store (architecture.md §14). model/workspace.js owns the records.

/** @returns {Promise<WorkspaceRecord[]>} */
export async function getAllWorkspaces() {
  const db = await openDb();
  return request(
    db.transaction(WORKSPACES, "readonly").objectStore(WORKSPACES).getAll()
  );
}

/** @param {string} id @returns {Promise<WorkspaceRecord | undefined>} */
export async function getWorkspace(id) {
  const db = await openDb();
  return request(
    db.transaction(WORKSPACES, "readonly").objectStore(WORKSPACES).get(id)
  );
}

/** @param {WorkspaceRecord} record */
export async function putWorkspace(record) {
  const db = await openDb();
  const tx = db.transaction(WORKSPACES, "readwrite");
  tx.objectStore(WORKSPACES).put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @param {string} id */
export async function deleteWorkspace(id) {
  const db = await openDb();
  const tx = db.transaction(WORKSPACES, "readwrite");
  tx.objectStore(WORKSPACES).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Handles store (architecture.md §2). A FileSystemFileHandle survives here
// across restarts; the permission attached to it may not, which is why every
// disk access re-checks it (storage/fsa.js).
//
// A native handle survives as its descriptor, because structured clone keeps
// data and drops the prototype: reviveHandle() on the way out is what makes it
// a working handle again (architecture.md §17). This is one of the two revive
// boundaries; the other is the "handle" channel message in model/folders.js.
// Every read of this store must pass through it: in the shell a real FSA
// handle that skipped it can stall whoever calls it (OldBrowserHandle).

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
  const record = await request(
    db.transaction(HANDLES, "readonly").objectStore(HANDLES).get(id)
  );
  if (record) record.handle = reviveHandle(record.handle);
  return record;
}

/** @returns {Promise<HandleRecord[]>} */
export async function getAllHandles() {
  const db = await openDb();
  const records = await request(
    db.transaction(HANDLES, "readonly").objectStore(HANDLES).getAll()
  );
  for (const record of records) record.handle = reviveHandle(record.handle);
  return records;
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

// Settings store (architecture.md §6). Small, durable, app-owned state that is
// not a document: the wrapped device keyring today, the sync server config and
// cursor later. One row per key, and the owning module defines the value shape.

//
// A setting whose value holds a CryptoKey lives in KEYS instead, a store
// with no key path: the key goes beside the value (put(value, key)). WebKit
// (iOS Safari) evaluates a key path on a copy of the record in which a
// CryptoKey cannot be read back, and refuses the put with "Evaluating the
// object store's key path did not yield a value". A store without a key
// path evaluates nothing. putSetting picks the store, and a write removes
// the key from the other one in the same transaction, so a key is in one
// store only and getSetting can look in both.

/**
 * Does this value hold a CryptoKey anywhere? Settings are small, plain data.
 * @param {unknown} value @param {number} [depth]
 */
function holdsCryptoKey(value, depth = 0) {
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return true;
  if (!value || typeof value !== "object" || depth > 4) return false;
  return Object.values(value).some((v) => holdsCryptoKey(v, depth + 1));
}

/** @param {string} key @returns {Promise<any>} */
export async function getSetting(key) {
  const db = await openDb();
  const tx = db.transaction([SETTINGS, KEYS], "readonly");
  const row = await request(tx.objectStore(SETTINGS).get(key));
  if (row) return row.value;
  return request(tx.objectStore(KEYS).get(key));
}

/** @param {string} key @param {any} value */
export async function putSetting(key, value) {
  const db = await openDb();
  const tx = db.transaction([SETTINGS, KEYS], "readwrite");
  if (holdsCryptoKey(value)) {
    tx.objectStore(KEYS).put(value, key);
    tx.objectStore(SETTINGS).delete(key);
  } else {
    tx.objectStore(SETTINGS).put({ key, value });
    tx.objectStore(KEYS).delete(key);
  }
  // Resolve on transaction completion, not on the put request, for the same
  // durability reason as putBuffer: only oncomplete means the write survives a
  // crash. The keyring is the first caller, and a wrapped identity that was
  // reported as saved but was not would lose every encrypted document.
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @param {string} key */
export async function deleteSetting(key) {
  const db = await openDb();
  const tx = db.transaction([SETTINGS, KEYS], "readwrite");
  tx.objectStore(SETTINGS).delete(key);
  tx.objectStore(KEYS).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @returns {BufferRecord} */
export function newBufferRecord() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    content: "",
    createdAt: now,
    updatedAt: now,
  };
}
