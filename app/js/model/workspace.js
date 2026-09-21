// @ts-check
// Workspaces: the multi-window model (architecture.md §14). Every window is a
// workspace with its own ordered tabs, active buffer and folders. The buffer
// pool stays global: a buffer in no workspace is in Recent. This module owns
// the `workspaces` store and this window's identity; model/docs.js and
// model/folders.js ask it who owns what and write their membership through it.
//
// Events on store.events:
//   "change"  { id }  a workspace record was written or removed

import {
  deleteWorkspace,
  getAllWorkspaces,
  getWorkspace,
  MAIN_WORKSPACE,
  putWorkspace,
} from "../storage/idb.js";

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
    record.updatedAt = Date.now();
    records.set(record.id, record);
    await putWorkspace(record);
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
    for (const record of records.values()) {
      if (record.folderIds.includes(folderId)) return true;
    }
    return false;
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

  /** @param {string} bufferId */
  async function removeTab(bufferId) {
    const record = current();
    const index = record.tabs.indexOf(bufferId);
    if (index < 0) return;
    record.tabs.splice(index, 1);
    if (record.activeId === bufferId) record.activeId = null;
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

  /** A new, empty workspace. Its window opens it (architecture.md §14.2). */
  async function create() {
    const record = newRecord(crypto.randomUUID());
    await save(record);
    return record;
  }

  /**
   * Remove a workspace. Its tabs fall into Recent by definition, because
   * Recent is "open nowhere", so nothing is lost. Main is never dissolved.
   * @param {string} wsId
   */
  async function dissolve(wsId) {
    if (wsId === MAIN_WORKSPACE || !records.has(wsId)) return;
    records.delete(wsId);
    await deleteWorkspace(wsId);
    emit("change", { id: wsId });
  }

  async function load() {
    for (const record of await getAllWorkspaces()) records.set(record.id, record);
    // A fresh database has no main record yet; a stale `?ws=` link names a
    // workspace nobody wrote. Both get an empty one, so the window opens.
    if (!records.has(MAIN_WORKSPACE)) await save(newRecord(MAIN_WORKSPACE));
    if (!records.has(id)) await save(newRecord(id));
  }

  return {
    id,
    events,
    current,
    all,
    openSet,
    ownerOf,
    hasFolder,
    addTab,
    removeTab,
    setActive,
    addFolder,
    removeFolder,
    create,
    dissolve,
    load,
  };
}
