// @ts-check
// Sidebar: the Open list, one section per opened folder, and Recent. Reads the
// stores, dispatches commands, owns its DOM region. All user-derived text goes
// through textContent.
//
// Two render paths on purpose: the buffer lists redraw on every doc "change"
// (one per keystroke), and a folder tree can hold hundreds of rows that have
// nothing to do with the text being typed.

import { titleOf } from "../model/docs.js";
import { hasFileSystemAccess } from "../model/capabilities.js";
import { run } from "../commands/registry.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../model/folders.js").Entry} Entry */

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../model/folders.js").createFolderStore>} folders
 */
export function mountSidebar(store, folders) {
  const openList = /** @type {HTMLElement} */ (document.getElementById("open-list"));
  const recentList = /** @type {HTMLElement} */ (document.getElementById("recent-list"));
  const folderSections = /** @type {HTMLElement} */ (
    document.getElementById("folder-sections")
  );

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => run("buffer.new"));

  // The disk row stays hidden markup where the API is missing, so the commands
  // it dispatches (registered only on the same condition) always exist.
  if (hasFileSystemAccess) {
    const openActions = /** @type {HTMLElement} */ (document.getElementById("open-actions"));
    const openFile = /** @type {HTMLElement} */ (document.getElementById("open-file"));
    const openFolder = /** @type {HTMLElement} */ (document.getElementById("open-folder"));
    openActions.hidden = false;
    openFile.addEventListener("click", () => run("file.open"));
    openFolder.addEventListener("click", () => run("folder.open"));
  }

  const recentHeading = /** @type {HTMLElement} */ (document.getElementById("recent-heading"));

  // Closed buffers must not clutter the sidebar (user decision, 2026-09-01):
  // Recent is collapsed by default and only the heading with a count shows.
  const COLLAPSED_KEY = "vrtti.recentCollapsed";
  let recentCollapsed = localStorage.getItem(COLLAPSED_KEY) !== "0";
  recentHeading.addEventListener("click", () => {
    recentCollapsed = !recentCollapsed;
    localStorage.setItem(COLLAPSED_KEY, recentCollapsed ? "1" : "0");
    render();
  });

  /** @param {BufferRecord} record @param {{closable: boolean}} opts */
  function makeRow(record, { closable }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    if (record.id === store.activeId) li.classList.add("active");

    // A file-backed row is marked, never labelled: the file name is already
    // the title, so the marker only has to say "this one is on disk". The
    // tooltip prefers the folder path, which is what tells two notes.md apart.
    if (record.kind === "file" && record.file) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "⛁";
      mark.title = "On disk: " + (record.file.path || record.file.name);
      li.appendChild(mark);
    }

    const title = document.createElement("span");
    title.className = "buffer-title";
    title.textContent = titleOf(record);
    li.appendChild(title);

    if (store.needsReconnect(record)) {
      const warn = document.createElement("button");
      warn.className = "buffer-warn";
      warn.type = "button";
      warn.textContent = "⚠";
      warn.title = "This file needs permission again. Click to reconnect.";
      warn.addEventListener("click", (event) => {
        // The click itself is the user gesture requestPermission needs; a
        // background retry can never get the grant.
        event.stopPropagation();
        run("file.reconnect", record.id);
      });
      li.appendChild(warn);
    }

    if (closable) {
      const close = document.createElement("button");
      close.className = "buffer-close";
      close.type = "button";
      close.textContent = "×";
      close.title = "Close (Alt+W)";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        run("buffer.close", record.id);
      });
      li.appendChild(close);
    }

    li.addEventListener("click", () => {
      if (record.closed) run("buffer.reopen", record.id);
      else run("buffer.activate", record.id);
    });
    return li;
  }

  // ---- Folder sections (architecture.md §2, §9) ----------------------------

  // Which directory levels are open on screen, keyed folder id + path. UI
  // state on purpose: the store caches what it listed, the sidebar decides
  // what is visible. Not persisted; a reload starts with top levels only.
  /** @type {Set<string>} */
  const expanded = new Set();

  /** @param {string} folderId @param {string} path */
  function levelKey(folderId, path) {
    return folderId + "/" + path;
  }

  /** @param {string} folderId @param {Entry} entry @param {number} depth */
  function treeRow(folderId, entry, depth) {
    const isDir = entry.kind === "directory";
    const key = levelKey(folderId, entry.path);

    const li = document.createElement("li");
    li.className = "tree-row " + (isDir ? "dir" : "file");
    // Inline indent: the depth is unbounded, so no fixed set of classes can
    // cover it. 10px is the padding every other sidebar row uses.
    li.style.paddingLeft = 10 + depth * 14 + "px";
    li.dataset.path = entry.path;

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    // Files keep the empty span: it holds the column, so names line up with
    // the directory names above them.
    twisty.textContent = isDir ? (expanded.has(key) ? "▾" : "▸") : "";
    li.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    li.appendChild(name);

    li.addEventListener("click", () => {
      if (!isDir) {
        // Every file row opens, including binary-looking ones. Sublime lists
        // and opens everything; guessing which files "count" would be wrong
        // more often than useful.
        run("folder.openFile", { handle: entry.handle, path: entry.path });
        return;
      }
      if (expanded.has(key)) expanded.delete(key);
      else {
        expanded.add(key);
        // Loads on first expand and emits "listing", which re-renders with the
        // children in place. A cached level returns without touching disk.
        folders.entries(folderId, entry.path);
      }
      renderFolders();
    });
    return li;
  }

  /** @param {string} folderId @param {string} path @param {number} depth @param {HTMLElement[]} out */
  function addLevel(folderId, path, depth, out) {
    const level = folders.cached(folderId, path);
    if (!level) {
      // Never listed yet (a fresh section, or a reload). The load emits
      // "listing", which brings us back here with the entries in hand.
      folders.entries(folderId, path);
      return;
    }
    for (const entry of level) {
      out.push(treeRow(folderId, entry, depth));
      if (entry.kind === "directory" && expanded.has(levelKey(folderId, entry.path))) {
        addLevel(folderId, entry.path, depth + 1, out);
      }
    }
  }

  /** @param {{id: string, name: string}} folder */
  function folderSection(folder) {
    const section = document.createElement("section");
    section.className = "folder-section";
    section.dataset.folderId = folder.id;

    const head = document.createElement("div");
    head.className = "folder-head";
    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = folder.name;
    name.title = folder.name;
    head.appendChild(name);

    const stale = folders.needsReconnect(folder.id);
    if (stale) {
      const warn = document.createElement("button");
      warn.className = "buffer-warn";
      warn.type = "button";
      warn.textContent = "⚠";
      warn.title = "This folder needs permission again. Click to reconnect.";
      // The click itself is the user gesture requestPermission needs.
      warn.addEventListener("click", () => run("folder.reconnect", folder.id));
      head.appendChild(warn);
    }

    const close = document.createElement("button");
    close.className = "folder-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close folder";
    close.addEventListener("click", () => run("folder.close", folder.id));
    head.appendChild(close);
    section.appendChild(head);

    const tree = document.createElement("ul");
    tree.className = "folder-tree";
    /** @type {HTMLElement[]} */
    const rows = [];
    // Nothing can be listed without a grant, so the section shows its heading
    // and the reconnect marker alone until the user clicks it.
    if (!stale) addLevel(folder.id, "", 0, rows);
    tree.replaceChildren(...rows);
    section.appendChild(tree);
    return section;
  }

  function renderFolders() {
    // Without the File System Access API the folder commands are not
    // registered, so a section's buttons would dispatch into nothing. There is
    // also nothing to draw: such a build can hold no directory handle.
    if (!hasFileSystemAccess) return;
    folderSections.replaceChildren(...folders.openFolders().map(folderSection));
  }

  function render() {
    openList.replaceChildren(
      ...store.openBuffers().map((b) => makeRow(b, { closable: true }))
    );

    const closed = store.closedBuffers();
    recentHeading.hidden = closed.length === 0;
    recentHeading.textContent =
      (recentCollapsed ? "▸" : "▾") + " Recent (" + closed.length + ")";
    recentList.hidden = recentCollapsed || closed.length === 0;
    recentList.replaceChildren(
      ...(recentList.hidden
        ? []
        : closed.map((b) => makeRow(b, { closable: false })))
    );
  }

  store.events.addEventListener("change", render);
  store.events.addEventListener("active", render);
  folders.events.addEventListener("change", renderFolders);
  folders.events.addEventListener("listing", renderFolders);
  render();
  renderFolders();
}
