// @ts-check
// Folder store: the opened folders and their lazily listed contents
// (architecture.md §2, §9). Same shape as model/docs.js on purpose: a factory,
// an in-memory Map, an EventTarget, and every mutation in one place.
//
// Events on store.events:
//   "change"   folders opened, closed, or a permission changed -> re-render
//   "listing"  { folderId }  a level was loaded, or re-listed with new content
//
// A folder owns no buffers. Clicking a file in the tree hands its handle to
// model/docs.js, which then owns that file alone. Closing a folder therefore
// leaves the buffers it started open.
//
// Nothing is listed until it is on screen: a folder section lists its top
// level, a subdirectory lists on its first expand. Levels once listed stay
// cached for the session, and a refresh re-lists exactly those.

import { deleteHandle, getAllHandles, putHandle } from "../storage/idb.js";
import {
  ensurePermission,
  listDirectory,
  openDirectoryPicker,
  permissionState,
  sameEntry,
} from "../storage/fsa.js";
import { isNativeHandle, pickFolder, reviveHandle } from "../storage/native.js";
import { isDesktop } from "./capabilities.js";
import { on, post } from "./channel.js";

/** @typedef {import("../storage/idb.js").HandleRecord} FolderRecord */
/**
 * @typedef {Object} Entry
 * @property {string} name
 * @property {'file'|'directory'} kind
 * @property {any} handle
 * @property {string} path  Slash path inside the folder, e.g. "sub/notes.md".
 */

// A cache key joins a folder id and a path. NUL is the one byte no file system
// allows in a name, so no path can ever forge another key.
const SEP = "\u0000";
// Do not re-list on every focus event: alt-tabbing twice must not cost two
// passes over every open level.
const FOCUS_GAP = 2000;

/**
 * @param {{workspaces: ReturnType<typeof import("./workspace.js").createWorkspaces>}} deps
 *   A folder lives in exactly one workspace (architecture.md §14). The
 *   handle store stays global; the workspace record says which handles this
 *   window shows.
 */
export function createFolderStore({ workspaces }) {
  /** @type {Map<string, FolderRecord>} */
  const folders = new Map();
  // Folder ids whose handle is not "granted" right now. A stored handle loses
  // its grant on restart unless the PWA holds "allow on every visit".
  /** @type {Set<string>} */
  const needsPermission = new Set();
  /** @type {Map<string, Entry[]>} */
  const listings = new Map();
  // Levels with a list in flight. A render can ask for the same level twice
  // before the first answer arrives; one listing is enough.
  /** @type {Set<string>} */
  const loading = new Set();
  const events = new EventTarget();

  /** @param {string} type @param {object} [detail] */
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param {string} folderId @param {string} path */
  function key(folderId, path) {
    return folderId + SEP + path;
  }

  // This workspace's folders, in the order they were added to it.
  function openFolders() {
    /** @type {FolderRecord[]} */
    const open = [];
    for (const id of workspaces.current().folderIds) {
      const folder = folders.get(id);
      if (folder) open.push(folder);
    }
    return open;
  }

  /**
   * Walk from the folder root to one level. Resolved through the live API, not
   * through the cache: a refresh must see a directory that was replaced on
   * disk, not the handle we listed it with an hour ago.
   * @param {FolderRecord} folder @param {string} path
   */
  async function dirHandleFor(folder, path) {
    let handle = folder.handle;
    if (path) {
      for (const segment of path.split("/")) {
        handle = await handle.getDirectoryHandle(segment);
      }
    }
    return handle;
  }

  /** @param {Entry[]} entries What a level looks like, for change detection. */
  function signature(entries) {
    return entries.map((e) => e.kind + ":" + e.name).join("\n");
  }

  /**
   * Set or clear the reconnect marker for one folder, and only for a real
   * permission gap: the marker's click can grant a permission and nothing else.
   * @param {FolderRecord} folder
   */
  /**
   * @param {FolderRecord} folder
   * @param {any} [err] The failure that prompted the check, when there was one.
   */
  async function refreshPermissionFlag(folder, err) {
    // A native handle is always granted (the root record is the grant). Its
    // one failure is a root whose folder moved or vanished, which Rust answers
    // with notFound; that gets the same reconnect marker, and the click
    // re-picks the folder (architecture.md §17).
    const granted = isNativeHandle(folder.handle)
      ? !(err && err.name === "NotFoundError")
      : (await permissionState(folder.handle, "readwrite").catch(() => "granted")) ===
        "granted";
    if (granted === !needsPermission.has(folder.id)) return; // already right
    if (granted) needsPermission.delete(folder.id);
    else needsPermission.add(folder.id);
    emit("change");
  }

  /**
   * The cached contents of one level, or undefined when it was never listed.
   * Render paths use this; it never touches the disk, so a render stays sync.
   * @param {string} folderId @param {string} [path] @returns {Entry[] | undefined}
   */
  function cached(folderId, path = "") {
    return listings.get(key(folderId, path));
  }

  /**
   * List one level and cache it. Returns the cache when there is one, so a
   * second expand of the same directory costs nothing.
   * @param {string} folderId @param {string} [path] @param {{force?: boolean}} [opts]
   * @returns {Promise<Entry[]>}
   */
  async function entries(folderId, path = "", opts = {}) {
    const folder = folders.get(folderId);
    // A folder without a grant cannot be listed at all: values() would throw.
    // The section shows its reconnect marker instead.
    if (!folder || needsPermission.has(folderId)) return [];
    const cacheKey = key(folderId, path);
    const before = listings.get(cacheKey);
    if (!opts.force && before) return before;
    if (loading.has(cacheKey)) return before || [];
    loading.add(cacheKey);
    try {
      const dir = await dirHandleFor(folder, path);
      const level = (await listDirectory(dir)).map((entry) => ({
        ...entry,
        path: path ? path + "/" + entry.name : entry.name,
      }));
      listings.set(cacheKey, level);
      // Silence on an unchanged level: a focus refresh must not rebuild the
      // tree DOM under the user's pointer for nothing.
      if (!before || signature(before) !== signature(level)) {
        emit("listing", { folderId });
      }
      return level;
    } catch (err) {
      // The directory is gone, or the grant lapsed. Drop the level, so the
      // tree shows the parent without children instead of stale rows.
      listings.delete(cacheKey);
      await refreshPermissionFlag(folder, err);
      if (before) emit("listing", { folderId });
      return [];
    } finally {
      loading.delete(cacheKey);
    }
  }

  /**
   * Re-list every level this folder has on screen. The top level is always one
   * of them, even after a reconnect that found nothing cached.
   * @param {string} folderId
   */
  async function refresh(folderId) {
    if (!folders.has(folderId) || needsPermission.has(folderId)) return;
    const prefix = folderId + SEP;
    const paths = new Set([""]);
    for (const cacheKey of listings.keys()) {
      if (cacheKey.startsWith(prefix)) paths.add(cacheKey.slice(prefix.length));
    }
    // Shallow levels first, so a parent that lost a subdirectory drops the
    // child level before we bother re-listing it.
    for (const path of [...paths].sort((a, b) => a.length - b.length)) {
      if (path && !listings.has(prefix + path)) continue;
      await entries(folderId, path, { force: true });
    }
  }

  /** Open a folder from the picker. An already open folder is refreshed, not duplicated. */
  async function openFolder() {
    return addFolder(await openDirectoryPicker());
  }

  /**
   * List a folder in this workspace by its handle: a picker result, or a
   * root the shell registered from a drop or a launch argument (architecture.md
   * §24). A folder already known, maybe to another workspace, is listed here
   * too instead of recorded twice.
   * @param {any} handle
   */
  async function addFolder(handle) {
    for (const folder of folders.values()) {
      // isSameEntry, never a name match: two paths can both end in "notes".
      if (await sameEntry(folder.handle, handle)) {
        // Known handle, maybe from another workspace: this one lists it too.
        await workspaces.addFolder(folder.id);
        emit("change");
        await refresh(folder.id);
        return folder;
      }
    }
    /** @type {FolderRecord} */
    const record = {
      id: crypto.randomUUID(),
      kind: "directory",
      handle,
      name: handle.name,
      addedAt: Date.now(),
    };
    await putHandle(record);
    folders.set(record.id, record);
    post("handle", { kind: "added", record });
    await workspaces.addFolder(record.id);
    emit("change");
    await entries(record.id, "");
    return record;
  }

  /** @param {string} id Close a folder. Buffers opened from it keep their own handles. */
  async function closeFolder(id) {
    if (!folders.has(id)) return;
    await workspaces.removeFolder(id);
    // The handle outlives this workspace while another one still lists it.
    if (!workspaces.hasFolder(id)) {
      folders.delete(id);
      needsPermission.delete(id);
      const prefix = id + SEP;
      for (const cacheKey of [...listings.keys()]) {
        if (cacheKey.startsWith(prefix)) listings.delete(cacheKey);
      }
      await deleteHandle(id);
      post("handle", { kind: "removed", id });
    }
    emit("change");
  }

  /** @param {string} id Forget a handle that left the store. */
  function forget(id) {
    if (!folders.delete(id)) return false;
    needsPermission.delete(id);
    const prefix = id + SEP;
    for (const cacheKey of [...listings.keys()]) {
      if (cacheKey.startsWith(prefix)) listings.delete(cacheKey);
    }
    return true;
  }

  // A dissolve in this window dropped handles nobody lists (workspace.js).
  workspaces.events.addEventListener("folders-dropped", (event) => {
    const ids = /** @type {CustomEvent<{ ids: string[] }>} */ (event).detail.ids;
    let changed = false;
    for (const id of ids) changed = forget(id) || changed;
    if (changed) emit("change");
  });

  // ---- Other windows (architecture.md §14.2) ------------------------------
  // The handle store is global; a handle opened or closed elsewhere shows up
  // here so that this window can list the same folder without a reload.
  on("handle", (message) => {
    if (message.kind === "added") {
      /** @type {FolderRecord} */
      const record = message.record;
      // The clone that crossed the channel is a descriptor again (§17); this
      // is the second revive boundary, next to the one in storage/idb.js.
      record.handle = reviveHandle(record.handle);
      folders.set(record.id, record);
      // A cloned handle carries the grant of its origin window, but check:
      // "prompt" here would list nothing and show the reconnect marker.
      permissionState(record.handle)
        .then((state) => {
          if (state !== "granted") needsPermission.add(record.id);
          emit("change");
        })
        .catch(() => emit("change"));
      return;
    }
    forget(message.id);
    emit("change");
  });

  /** @param {string} id Does this folder need a permission grant? */
  function needsReconnect(id) {
    return needsPermission.has(id);
  }

  /**
   * Runs from a click, the only context where requestPermission may prompt.
   * @param {string} id
   */
  async function reconnect(id) {
    const folder = folders.get(id);
    if (!folder) return false;
    if (isDesktop) {
      // In the shell a reconnect is always a fresh pick. Either the record is
      // from before the native backend and holds a WebView2 handle, which
      // cannot tell Rust which directory it points at, or it is a native root
      // whose folder moved or vanished (architecture.md §17, "Mixed handles").
      // The picker runs from this click because a click is the only place a
      // picker may open. Same record id, so the workspace and its buffers
      // stay attached.
      try {
        const handle = await pickFolder();
        folder.handle = handle;
        folder.name = handle.name;
        await putHandle(folder);
      } catch (err) {
        if (err && /** @type {any} */ (err).name === "AbortError") return false;
        throw err;
      }
    } else if (!(await ensurePermission(folder.handle, "readwrite"))) {
      return false;
    }
    needsPermission.delete(id);
    emit("change");
    await refresh(id);
    return true;
  }

  // External changes to the listing: another program adds or removes a file
  // while we show its directory. Same trigger as model/docs.js, the user coming
  // back to the window, but folders need their own pass: docs.js walks open
  // buffers, and a folder level has no buffer behind it.
  let refreshing = false;
  let lastRefreshAt = 0;
  /** @type {number} */
  let refreshTimer = 0;

  async function refreshAll() {
    // Alt-tabbing fires focus again while a pass is still awaiting disk IO.
    if (refreshing) return;
    refreshing = true;
    try {
      for (const id of [...folders.keys()]) await refresh(id);
    } finally {
      refreshing = false;
      lastRefreshAt = Date.now();
    }
  }

  function refreshSoon() {
    if (refreshTimer) return; // a pass is already queued; it will see everything
    const wait = Math.max(0, lastRefreshAt + FOCUS_GAP - Date.now());
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refreshAll();
    }, wait);
  }

  async function load() {
    for (const stored of await getAllHandles()) {
      if (stored.kind !== "directory") continue;
      folders.set(stored.id, stored);
      // Nothing prompts here: that needs a user gesture. The section renders
      // with a reconnect marker and lists nothing until the click arrives.
      if ((await permissionState(stored.handle)) !== "granted") {
        needsPermission.add(stored.id);
      }
    }
  }

  // Separate from load(), like the doc store: the sidebar mounts between the
  // two, so it is subscribed before anything refreshes.
  function start() {
    window.addEventListener("focus", refreshSoon);
  }

  return {
    events,
    folders,
    openFolders,
    cached,
    entries,
    refresh,
    load,
    start,
    openFolder,
    addFolder,
    closeFolder,
    needsReconnect,
    reconnect,
  };
}
