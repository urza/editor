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
import { openMenu } from "./menu.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../model/folders.js").Entry} Entry */

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../model/folders.js").createFolderStore>} folders
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 */
export function mountSidebar(store, folders, sync) {
  const openList = /** @type {HTMLElement} */ (document.getElementById("open-list"));
  const recentList = /** @type {HTMLElement} */ (document.getElementById("recent-list"));
  const folderSections = /** @type {HTMLElement} */ (
    document.getElementById("folder-sections")
  );

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => {
    run("buffer.new");
    run("sidebar.autoclose");
  });

  // Pinned outside the scroller by app.css, so a long buffer list never hides
  // it (architecture.md §9). The panel itself is ui/settings.js.
  const settingsButton = /** @type {HTMLElement} */ (
    document.getElementById("sidebar-settings")
  );
  settingsButton.addEventListener("click", () => {
    // The drawer sits above the settings panel on a phone, so it must go
    // first, or the panel opens behind it.
    run("sidebar.autoclose");
    run("settings.toggle");
  });

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

  // ---- Rename (architecture.md §9) -----------------------------------------

  // The id being renamed, or null. render() stands down while it is set: a
  // redraw during a rename would delete the input the user is typing in, and
  // the lists redraw on every keystroke in the editor.
  /** @type {string | null} */
  let renamingId = null;

  /** @param {BufferRecord} record */
  function startRename(record) {
    // The row is looked up here, not held from the click: a redraw between
    // opening the menu and picking Rename would leave a detached element, and
    // the input would go into a row nobody can see.
    const li = document.querySelector('.buffer-row[data-id="' + record.id + '"]');
    const titleEl = li ? li.querySelector(".buffer-title") : null;
    if (renamingId || !(titleEl instanceof HTMLElement)) return;
    renamingId = record.id;

    const input = document.createElement("input");
    input.className = "buffer-rename";
    input.type = "text";
    input.value = titleOf(record);
    input.spellcheck = false;
    titleEl.replaceWith(input);
    input.focus();
    // Select the name without its extension: a rename almost never means to
    // change the file type.
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);

    let done = false;
    /** @param {boolean} commit */
    function finish(commit) {
      if (done) return;
      done = true;
      renamingId = null;
      const name = input.value;
      // Redraw first: the row must come back from the record whatever happens
      // next, including a rename the store refuses.
      render();
      if (commit) run("buffer.rename", { id: record.id, name });
    }

    input.addEventListener("keydown", (event) => {
      // The chord table listens on window, so Alt+W here would close the
      // buffer while its new name is still being typed.
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    // Committing on blur, like a file manager: clicking away is a decision,
    // not a cancel.
    input.addEventListener("blur", () => finish(true));
    // The row itself activates a buffer on click. Editing its name must not.
    input.addEventListener("click", (event) => event.stopPropagation());
  }

  /**
   * The row menu (architecture.md §9). Sync is a per-document server target
   * (§3); with no server configured the item is disabled and says where to set
   * one, rather than claiming to sync into nothing. Encrypt is live for scratch
   * buffers; a file-backed doc means renaming it to `.age` on disk, which is
   * a later unit (architecture.md §13.4).
   *
   * @param {BufferRecord} record
   * @returns {import("./menu.js").MenuItem[]}
   */
  function rowMenu(record) {
    /** @type {import("./menu.js").MenuItem[]} */
    const items = [];

    if (record.kind === "file" && record.file) {
      // No item at all where the browser cannot rename a file in place: an
      // entry that silently does nothing is worse than a missing one.
      if (store.canRenameFile(record)) {
        items.push({ label: "Rename file…", act: () => startRename(record) });
      }
    } else {
      items.push({ label: "Rename…", act: () => startRename(record) });
      if (record.title) {
        items.push({
          label: "Use first line",
          act: () => run("buffer.rename", { id: record.id, name: "" }),
        });
      }
    }

    items.push({ separator: true });
    items.push(
      sync?.isConfigured
        ? {
            label: "Sync",
            // One item, both directions, like Encrypt below.
            checked: Boolean(record.sync),
            act: () =>
              run(record.sync ? "doc.sync.off" : "doc.sync.on", record.id),
          }
        : {
            label: "Sync",
            checked: false,
            disabled: true,
            hint: "Set a server in settings",
          }
    );
    // History is the server's, so it only exists for a document the server
    // knows about.
    if (record.sync && sync?.isConfigured) {
      items.push({ label: "History…", act: () => run("doc.history", record.id) });
    }
    items.push(
      record.kind === "file"
        ? {
            label: "Encrypt",
            checked: Boolean(record.enc),
            disabled: true,
            hint: "Files: later",
          }
        : {
            label: "Encrypt",
            checked: Boolean(record.enc),
            // One item, both directions: the check mark says which way it goes.
            act: () => run(record.enc ? "doc.decrypt" : "doc.encrypt", record.id),
          }
    );
    items.push({ separator: true });
    items.push(
      record.closed
        ? { label: "Reopen", act: () => run("buffer.reopen", record.id) }
        : { label: "Close", act: () => run("buffer.close", record.id) }
    );
    return items;
  }

  /** @param {BufferRecord} record @param {{closable: boolean}} opts */
  function makeRow(record, { closable }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    // The rename box finds its row by this id, after the menu that asked for
    // it is already gone.
    li.dataset.id = record.id;
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

    // A synced row is marked the same way a file-backed one is: the mark says
    // "this text also lives somewhere else". A pending detach keeps the mark
    // until the tombstone is pushed, because until then it is still up there.
    if (record.sync) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "☁";
      mark.title = record.sync.tombstone
        ? "Detaching…"
        : record.sync.rev === 0
          ? "Attaching…"
          : "Synced";
      li.appendChild(mark);
    }

    // Encrypted rows are marked too, and keep their stored `title`: the first
    // line of an encrypted doc is ciphertext and can never name it (§5).
    if (record.enc) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "🔒";
      mark.title = "Encrypted";
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

    const more = document.createElement("button");
    more.className = "buffer-more";
    more.type = "button";
    more.textContent = "⋯";
    more.title = "More";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (event) => {
      // Without this the row would also activate the buffer behind the menu.
      event.stopPropagation();
      openMenu(more, rowMenu(record));
    });
    li.appendChild(more);

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
      // On a phone the sidebar is a drawer over the editor, so it has to get
      // out of the way of the document it just opened. A no-op on a PC.
      run("sidebar.autoclose");
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
        run("sidebar.autoclose");
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
    // A rename input lives inside one of these rows, and every keystroke in
    // the editor emits "change". Redrawing now would delete the box the user
    // is typing in; startRename() calls render() itself when it is done.
    if (renamingId) return;

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
