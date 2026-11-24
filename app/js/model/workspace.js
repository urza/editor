// @ts-check
// Workspaces: the multi-window model (architecture.md §14). Every window is a
// workspace with its own ordered tabs, active buffer and folders. The buffer
// pool stays global: a buffer in no workspace is in Recent. This module owns
// the `workspaces` store and this window's identity; model/docs.js and
// model/folders.js ask it who owns what and write their membership through it.
//
// Events on store.events:
//   "change"          { id, foreign? }  a workspace record was written or removed.
//   "dissolved"       { tabs }  this window dissolved a workspace; its tabs are
//                     in Recent now, and model/docs.js discards the empty ones
//   "folders-dropped" { ids }  a dissolve removed folder handles no workspace
//                     lists any more; model/folders.js forgets them
//             `foreign` marks a change the doc store did not ask for itself:
//             one from another window, a dissolve, a lost double take. The
//             doc store re-renders on those and keeps its active buffer
//             inside the tabs; its own tab writes it already follows up.
//
// Every window holds a Web Lock named ws:<id> for its lifetime. That is how
// the main window tells a closed tab from a reloaded one (unit 14.2), and
// how the shell learns which workspaces have no window (unit 14.4).

import {
  deleteHandle,
  deleteWorkspace,
  getAllWorkspaces,
  getWorkspace,
  MAIN_WORKSPACE,
  putWorkspace,
} from "../storage/idb.js";
import { on, post } from "./channel.js";

const LOCK_PREFIX = "ws:";
// A closed browser tab posts window-closed on pagehide, but so does a reload.
// Main waits this long, then dissolves only if nobody holds the tab's lock.
const CLOSE_GRACE = 5000;

/** @typedef {import("../storage/idb.js").WorkspaceRecord} WorkspaceRecord */

/**
 * Window identity is the URL (architecture.md §14): `?ws=<id>` names the
 * workspace, no parameter is the main one.
 * @param {string} [search]
 */
export function workspaceIdFromUrl(search = location.search) {
  return new URLSearchParams(search).get("ws") || MAIN_WORKSPACE;
}

/** @param {{id: string}} options The workspace this window is. */
export function createWorkspaces({ id }) {
  /** @type {Map<string, WorkspaceRecord>} */
  const records = new Map();
  const events = new EventTarget();
  // Set when another window dissolved this one (its window is closing). From
  // then on this window's own record is never written again: the dying
  // window used to hear the deletion, find itself with no tabs, create a
  // scratch buffer, and write the record back, so the workspace returned
  // at the next launch (the user's "second window keeps coming back").
  let dissolved = false;

  /** @param {string} type @param {object} [detail] */
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param {string} wsId @returns {WorkspaceRecord} */
  function newRecord(wsId) {
    const now = Date.now();
    return { id: wsId, tabs: [], activeId: null, folderIds: [], createdAt: now, updatedAt: now };
  }

  /** @param {WorkspaceRecord} record */
  async function save(record) {
    if (dissolved && record.id === id) return;
    record.updatedAt = Date.now();
    records.set(record.id, record);
    await putWorkspace(record);
    post("workspace", { record });
    emit("change", { id: record.id });
  }

  /** @param {string} [wsId] @returns {WorkspaceRecord} */
  function get(wsId = id) {
    let record = records.get(wsId);
    if (!record) {
      // A record can be missing only for a workspace this window has not seen
      // written yet (a sync target while main is not open, unit 14.3). It is
      // created on the spot rather than dropped, so no tab is ever lost.
      record = newRecord(wsId);
      records.set(wsId, record);
    }
    return record;
  }

  function current() {
    return get(id);
  }

  function all() {
    return [...records.values()];
  }

  /** Every buffer id that is open somewhere, across all workspaces. */
  function openSet() {
    const set = new Set();
    for (const record of records.values()) for (const tab of record.tabs) set.add(tab);
    return set;
  }

  /** @param {string} bufferId @returns {string | null} The workspace that holds the buffer open. */
  function ownerOf(bufferId) {
    for (const record of records.values()) {
      if (record.tabs.includes(bufferId)) return record.id;
    }
    return null;
  }

  /** @param {string} folderId Is the folder listed by any workspace? */
  function hasFolder(folderId) {
    return folderOwner(folderId) !== null;
  }

  /**
   * The workspace that lists a folder, a secondary one first: main is not
   * meant to list any in the shell (architecture.md §14.5), so a secondary
   * that does is the window to bring forward.
   * @param {string} folderId @returns {string | null}
   */
  function folderOwner(folderId) {
    let owner = null;
    for (const record of records.values()) {
      if (!record.folderIds.includes(folderId)) continue;
      if (record.id !== MAIN_WORKSPACE) return record.id;
      owner = record.id;
    }
    return owner;
  }

  /**
   * The secondary workspace that owns a dedicated Space Window for `space`,
   * or null when no window owns it (architecture.md §28).
   * @param {string} space @returns {string | null}
   */
  function spaceOwner(space) {
    for (const record of records.values()) {
      if (record.id !== MAIN_WORKSPACE && record.space === space) return record.id;
    }
    return null;
  }

  /** @param {string} bufferId @param {string} [wsId] */
  async function addTab(bufferId, wsId = id) {
    let record = get(wsId);
    if (wsId !== id) {
      // Another workspace's record: its own window may have written it since
      // this one loaded, so the stored copy is the truth, not the Map. Unit
      // 14.2 keeps the Map current over the channel; this read stays anyway,
      // because a message can still be in flight.
      record = (await getWorkspace(wsId)) ?? record;
      records.set(wsId, record);
    }
    if (record.tabs.includes(bufferId)) return;
    record.tabs.push(bufferId);
    await save(record);
  }

  /**
   * @param {readonly string[]} a
   * @param {readonly string[]} b
   */
  function sameStrings(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * @typedef {Object} PreparedWorkspaceTabs
   * @property {WorkspaceRecord} record
   * @property {string[]} addedIds
   * @property {boolean} hadLive
   */

  /**
   * Prepare an updated `WorkspaceRecord` with `bufferIds` appended, without
   * mutating in-memory `records` or `record.tabs` yet. `applyRemoteBatch`
   * persists `prepared.record` in `applySyncBatch` first and calls
   * `commitPreparedWorkspace` only after the IndexedDB transaction commits, so
   * an aborted sync page never leaves uncommitted tabs in memory.
   * @param {string[]} bufferIds
   * @param {string} [wsId]
   * @returns {Promise<PreparedWorkspaceTabs | null>}
   */
  async function prepareAddTabs(bufferIds, wsId = id) {
    if (bufferIds.length === 0 || (dissolved && wsId === id)) return null;
    const hadLive = records.has(wsId);
    let base = records.get(wsId) ?? newRecord(wsId);
    if (wsId !== id) {
      base = (await getWorkspace(wsId)) ?? base;
    }
    const existing = new Set(base.tabs);
    const nextTabs = [...base.tabs];
    /** @type {string[]} */
    const addedIds = [];
    for (const bufferId of bufferIds) {
      if (existing.has(bufferId)) continue;
      existing.add(bufferId);
      nextTabs.push(bufferId);
      addedIds.push(bufferId);
    }
    if (addedIds.length === 0) return null;
    return {
      record: {
        ...base,
        tabs: nextTabs,
        folderIds: [...base.folderIds],
        updatedAt: Date.now(),
      },
      addedIds,
      hadLive,
    };
  }

  /**
   * Merge `addedIds` into the live workspace record after `applySyncBatch`
   * commits. Never replace `live.tabs` or `live.folderIds` wholesale: a user
   * `addTab`, `removeTab`, `moveTab`, `setActive`, or folder edit during the
   * IndexedDB transaction already updated `live`, so when `live` diverges from
   * `prepared.record` we re-save the merged `live` record to IndexedDB.
   * @param {PreparedWorkspaceTabs} prepared
   */
  async function commitPreparedWorkspace(prepared) {
    const { record: snap, addedIds, hadLive } = prepared;
    if (dissolved && snap.id === id) return;
    const live = records.get(snap.id);
    if (!live) {
      if (hadLive && snap.id !== MAIN_WORKSPACE) {
        await deleteWorkspace(snap.id);
        return;
      }
      const stored = {
        ...snap,
        tabs: [...snap.tabs],
        folderIds: [...snap.folderIds],
      };
      records.set(stored.id, stored);
      post("workspace", { record: stored });
      emit("change", { id: stored.id });
      return;
    }

    const present = new Set(live.tabs);
    for (const bufferId of addedIds) {
      if (present.has(bufferId)) continue;
      present.add(bufferId);
      live.tabs.push(bufferId);
    }

    const diverged =
      !sameStrings(live.tabs, snap.tabs) ||
      !sameStrings(live.folderIds, snap.folderIds) ||
      live.activeId !== snap.activeId ||
      live.space !== snap.space ||
      Boolean(live.initSpace) !== Boolean(snap.initSpace);

    if (diverged) {
      await save(live);
      return;
    }

    live.updatedAt = snap.updatedAt;
    post("workspace", { record: live });
    emit("change", { id: live.id });
  }

  /** @param {string} bufferId */
  async function removeTab(bufferId) {
    const record = current();
    const index = record.tabs.indexOf(bufferId);
    if (index < 0) return;
    record.tabs.splice(index, 1);
    if (record.activeId === bufferId) record.activeId = null;
    await save(record);
  }

  /**
   * Remove multiple tabs from this workspace in one save. Used before handing
   * tabs off to a new Space Window so resolveDoubleTake sees no overlap (§28).
   * @param {string[]} bufferIds
   */
  async function removeTabs(bufferIds) {
    if (bufferIds.length === 0) return;
    const drop = new Set(bufferIds);
    const record = current();
    const next = record.tabs.filter((tab) => !drop.has(tab));
    if (next.length === record.tabs.length) return;
    record.tabs = next;
    if (record.activeId && drop.has(record.activeId)) record.activeId = null;
    await save(record);
  }

  /**
   * Reorder this workspace's tabs: put `bufferId` before `beforeId`, or last
   * when `beforeId` is null. The tabs array is the sidebar's order (§9 Manual
   * order), so a drag changes nothing but this list. By neighbour id, not by
   * index: the sidebar skips a tab whose record is gone, so its row indices
   * and the array indices can differ.
   *
   * @param {string} bufferId @param {string | null} beforeId
   */
  async function moveTab(bufferId, beforeId) {
    const record = current();
    const from = record.tabs.indexOf(bufferId);
    if (from < 0 || bufferId === beforeId) return;
    const to = beforeId === null ? record.tabs.length : record.tabs.indexOf(beforeId);
    if (to < 0) return;
    const next = record.tabs.filter((tab) => tab !== bufferId);
    next.splice(to - (from < to ? 1 : 0), 0, bufferId);
    if (next.every((tab, i) => tab === record.tabs[i])) return;
    record.tabs = next;
    await save(record);
  }

  /** @param {string | null} bufferId */
  async function setActive(bufferId) {
    const record = current();
    if (record.activeId === bufferId) return;
    record.activeId = bufferId;
    await save(record);
  }

  /** @param {string} folderId */
  async function addFolder(folderId) {
    const record = current();
    if (record.folderIds.includes(folderId)) return;
    record.folderIds.push(folderId);
    await save(record);
  }

  /** @param {string} folderId */
  async function removeFolder(folderId) {
    const record = current();
    const index = record.folderIds.indexOf(folderId);
    if (index < 0) return;
    record.folderIds.splice(index, 1);
    await save(record);
  }

  /**
   * A new workspace. Its window opens it (architecture.md §14.2). Empty,
   * unless the caller hands it folders, tabs, or a dedicated space (§14.5, §28).
   * Accepts a pre-generated `id` so `workspace.openSpace` can call `window.open`
   * synchronously inside the click gesture before the IndexedDB write resolves.
   * @param {{id?: string, folderIds?: string[], tabs?: string[], space?: string, initSpace?: boolean}} [fields]
   */
  async function create({ id: givenId, folderIds = [], tabs = [], space, initSpace = false } = {}) {
    /** @type {WorkspaceRecord} */
    const record = {
      ...newRecord(givenId ?? crypto.randomUUID()),
      folderIds: [...folderIds],
      tabs: [...tabs],
      activeId: tabs[0] ?? null,
    };
    if (space) record.space = space;
    if (initSpace) record.initSpace = true;
    await save(record);
    return record;
  }

  /**
   * One-time first-boot handoff for a dedicated Space Window (§28): clears
   * `initSpace` and records claimed tabs so later reloads keep the user's open
   * set instead of re-fetching closed stubs.
   * @param {string[]} initialTabs
   * @returns {Promise<boolean>}
   */
  async function finishSpaceInit(initialTabs) {
    const record = current();
    if (!record.initSpace) return false;
    delete record.initSpace;
    for (const tab of initialTabs) {
      if (!record.tabs.includes(tab)) record.tabs.push(tab);
    }
    if (!record.activeId && record.tabs.length > 0) record.activeId = record.tabs[0];
    await save(record);
    return true;
  }

  /**
   * Move this workspace's folders into a new workspace of their own and
   * return it, or null when there are none. Main runs this at every launch
   * in the shell (architecture.md §14.5): main never lists a folder there,
   * and a record from before that rule is the one way one gets in. The new
   * record is saved before this one is stripped, so a crash in between
   * lists the folder twice rather than nowhere.
   */
  async function moveFoldersOut() {
    const record = current();
    if (record.folderIds.length === 0) return null;
    const target = await create({ folderIds: record.folderIds });
    record.folderIds = [];
    await save(record);
    return target;
  }

  /**
   * Remove a workspace. Its tabs fall into Recent by definition, because
   * Recent is "open nowhere", so nothing is lost. Main is never dissolved.
   * @param {string} wsId
   * @param {{silent?: boolean}} [opts] silent: skip emitting "dissolved" (used
   *   when loseSpace is already trashing every note of the space, or rolling
   *   back an unopened popup).
   */
  async function dissolve(wsId, { silent = false } = {}) {
    const record = records.get(wsId);
    if (wsId === MAIN_WORKSPACE || !record) return;
    records.delete(wsId);
    // Mark dissolved here too when a window dissolves itself (loseSpace in a
    // Space Window leader), because BroadcastChannel never echoes back to its
    // sender and closeHere() checks isDissolved before creating a blank buffer.
    if (wsId === id) dissolved = true;
    await deleteWorkspace(wsId);
    post("workspace-deleted", { id: wsId, silent });
    // A folder listed by no other workspace has no way back into a sidebar;
    // its handle would only pile up in the store (the user's folder windows
    // come and go, architecture.md §14). Drop it, here and in the other
    // windows' folder stores. The tabs need nothing: Recent is "open
    // nowhere", so they are there already.
    const dropped = [];
    for (const folderId of record.folderIds) {
      if (hasFolder(folderId)) continue;
      await deleteHandle(folderId);
      post("handle", { kind: "removed", id: folderId });
      dropped.push(folderId);
    }
    if (dropped.length > 0) emit("folders-dropped", { ids: dropped });
    emit("change", { id: wsId, foreign: true });
    // After the change: the doc store first moves its active buffer off the
    // dropped tabs, then hears which tabs fell into Recent or a space drawer.
    if (!silent) emit("dissolved", { tabs: record.tabs, space: record.space });
  }

  // ---- Other windows (architecture.md §14.2) ------------------------------

  on("workspace", ({ record }) => {
    records.set(record.id, record);
    emit("change", { id: record.id, foreign: true });
    void resolveDoubleTake(record);
  });

  on("workspace-deleted", ({ id: wsId, silent }) => {
    const record = records.get(wsId);
    records.delete(wsId);
    if (wsId === id) dissolved = true;
    emit("change", { id: wsId, foreign: true });
    // If a closing secondary window dissolved itself before dying, main runs
    // the idempotent post-dissolve cleanup unless suppressed by `silent`.
    if (!silent && id === MAIN_WORKSPACE && record) {
      emit("dissolved", { tabs: record.tabs, space: record.space });
    }
  });

  on("focus", ({ ws }) => {
    // Best effort in a browser, which lets a tab focus itself only in some
    // cases. The shell does it for real (unit 14.4).
    if (ws === id) window.focus();
  });

  on("window-closed", ({ ws }) => {
    if (id !== MAIN_WORKSPACE || ws === MAIN_WORKSPACE) return;
    setTimeout(() => void dissolveIfGone(ws), CLOSE_GRACE);
  });

  /**
   * Two windows took the same Recent buffer at the same moment. Both run
   * this on the other's record and must reach the same answer, so the rule
   * uses nothing a clock or message order can skew (each window bumps its
   * own updatedAt twice while the other's message is in flight, and a
   * timestamp rule made both drop the tab): main keeps the tab, and between
   * two secondary workspaces the smaller id keeps it.
   * @param {WorkspaceRecord} incoming
   */
  async function resolveDoubleTake(incoming) {
    if (incoming.id === id) return;
    const mine = current();
    const shared = mine.tabs.filter((tab) => incoming.tabs.includes(tab));
    if (shared.length === 0) return;
    const keep =
      id === MAIN_WORKSPACE || (incoming.id !== MAIN_WORKSPACE && id < incoming.id);
    if (keep) return;
    for (const tab of shared) await removeTab(tab);
    // Told as foreign: the store then moves its active buffer off the
    // dropped tab, which it does not do for its own tab writes.
    emit("change", { id, foreign: true });
  }

  /** @param {string} ws */
  async function dissolveIfGone(ws) {
    if (!records.has(ws)) return;
    try {
      const state = await navigator.locks.query();
      if ((state.held ?? []).some((lock) => lock.name === LOCK_PREFIX + ws)) return;
    } catch {
      // No Web Locks: nothing can tell a close from a reload, so keep it.
      return;
    }
    await dissolve(ws);
  }

  /**
   * Hold this window's lock and, in a browser, announce the tab's end.
   * The shell decides closes itself (unit 14.4), so it skips the announce.
   * @param {{isDesktop: boolean}} options
   */
  function start({ isDesktop }) {
    if (navigator.locks) {
      navigator.locks
        .request(LOCK_PREFIX + id, () => new Promise(() => {}))
        .catch((err) => console.log("[vrtti] workspace lock", err));
    }
    if (!isDesktop && id !== MAIN_WORKSPACE) {
      window.addEventListener("pagehide", () => post("window-closed", { ws: id }));
    }
  }

  /** @type {{at: number, set: Set<string>} | null} */
  let liveCache = null;

  /**
   * The workspaces whose window is up right now, read from the Web Locks
   * every window holds (unit 14.3 routes pulled changes to them). Cached for
   * a second, because a pull page asks once per change.
   * @returns {Promise<Set<string>>}
   */
  async function liveSet() {
    const now = Date.now();
    if (liveCache && now - liveCache.at < 1000) return liveCache.set;
    const set = new Set([id]);
    try {
      const state = await navigator.locks.query();
      for (const lock of state.held ?? []) {
        if (lock.name?.startsWith(LOCK_PREFIX)) set.add(lock.name.slice(LOCK_PREFIX.length));
      }
    } catch {
      // No Web Locks: as far as this window knows, it is alone.
    }
    liveCache = { at: now, set };
    return set;
  }

  /**
   * A duplicated tab would be a second window of the same workspace, and
   * then two windows own the same tabs. The second one becomes a fresh
   * empty workspace instead, before anything else loads.
   * @returns {Promise<boolean>} true when this window is being redirected
   */
  async function redirectIfDuplicate() {
    if (!navigator.locks) return false;
    const state = await navigator.locks.query();
    const held = (state.held ?? []).some((lock) => lock.name === LOCK_PREFIX + id);
    if (!held) return false;
    const fresh = newRecord(crypto.randomUUID());
    await save(fresh);
    const url = new URL(location.href);
    url.search = "?ws=" + encodeURIComponent(fresh.id);
    location.replace(url.toString());
    return true;
  }

  async function load() {
    if (await redirectIfDuplicate()) return;
    for (const record of await getAllWorkspaces()) records.set(record.id, record);
    // A fresh database has no main record yet; a stale `?ws=` link names a
    // workspace nobody wrote. Both get an empty one, so the window opens.
    if (!records.has(MAIN_WORKSPACE)) await save(newRecord(MAIN_WORKSPACE));
    if (!records.has(id)) await save(newRecord(id));
  }

  return {
    id,
    events,
    /** True once another window dissolved this one; nothing here writes any more. */
    get isDissolved() {
      return dissolved;
    },
    current,
    all,
    openSet,
    ownerOf,
    hasFolder,
    folderOwner,
    spaceOwner,
    liveSet,
    addTab,
    prepareAddTabs,
    commitPreparedWorkspace,
    removeTab,
    removeTabs,
    moveTab,
    setActive,
    addFolder,
    removeFolder,
    create,
    finishSpaceInit,
    moveFoldersOut,
    dissolve,
    dissolveIfGone,
    load,
    start,
  };
}
