// @ts-check
// Sidebar: the Open list, one section per opened folder, Recent and From server. Reads the
// stores, dispatches commands, owns its DOM region. All user-derived text goes
// through textContent.
//
// Two render paths on purpose: the buffer lists redraw on every doc "change"
// (one per keystroke), and a folder tree can hold hundreds of rows that have
// nothing to do with the text being typed.

import { titleOf, DEFAULT_SPACE, KEYRING_SPACE } from "../model/docs.js";
import { hasDisk } from "../model/capabilities.js";
import { isNativeHandle } from "../storage/native.js";
import { register, run } from "../commands/registry.js";
import { openMenu } from "./menu.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../model/folders.js").Entry} Entry */
/** @typedef {import("../storage/idb.js").RemoteStub} RemoteStub */

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../model/folders.js").createFolderStore>} folders
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 */
export function mountSidebar(store, folders, sync) {
  const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
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

  // The disk buttons stay hidden markup where no backend can reach disk, so
  // the commands they dispatch (registered only on the same condition) always
  // exist.
  if (hasDisk) {
    const openFile = /** @type {HTMLElement} */ (document.getElementById("open-file"));
    const openFolder = /** @type {HTMLElement} */ (document.getElementById("open-folder"));
    openFile.hidden = false;
    openFolder.hidden = false;
    openFile.addEventListener("click", () => run("file.open"));
    openFolder.addEventListener("click", () => run("folder.open"));
  }

  // A new window is a new workspace (architecture.md §14). Multi-window is a
  // desktop thing: on a phone the tab would open outside the installed app,
  // so the button hides under the drawer breakpoint.
  const newWindow = /** @type {HTMLElement} */ (document.getElementById("new-window"));
  newWindow.hidden = matchMedia("(max-width: 700px)").matches;
  newWindow.addEventListener("click", () => run("workspace.new"));

  const recentBlock = /** @type {HTMLElement} */ (document.getElementById("recent"));
  const recentHeading = /** @type {HTMLElement} */ (document.getElementById("recent-heading"));

  // Closed buffers must not clutter the sidebar (user decision, 2026-09-01):
  // Recent is collapsed and only the heading with a count shows. A click opens
  // it for this window's lifetime and nothing remembers that (2026-09-24):
  // every window starts with it closed, whatever the last one did.
  let recentCollapsed = true;
  recentHeading.addEventListener("click", () => {
    recentCollapsed = !recentCollapsed;
    render();
  });

  const fromserverBlock = /** @type {HTMLElement} */ (document.getElementById("fromserver"));
  const fromserverHeading = /** @type {HTMLElement} */ (
    document.getElementById("fromserver-heading")
  );
  const fromserverList = /** @type {HTMLElement} */ (document.getElementById("fromserver-list"));

  // The same rule as Recent (architecture.md §25): closed in every new
  // window, open for this window's lifetime after a click, never stored.
  let fromserverCollapsed = true;
  fromserverHeading.addEventListener("click", () => {
    fromserverCollapsed = !fromserverCollapsed;
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
   * one, rather than claiming to sync into nothing. Encrypt on a file-backed
   * doc renames it to `.age` on disk (architecture.md §19), so it is disabled
   * where the browser cannot rename a file.
   *
   * @param {BufferRecord} record @param {{closable: boolean}} opts
   * @returns {import("./menu.js").MenuItem[]}
   */
  function rowMenu(record, { closable }) {
    /** @type {import("./menu.js").MenuItem[]} */
    const items = [];

    if (record.kind === "file" && record.file) {
      // No item at all where the browser cannot rename a file in place: an
      // entry that silently does nothing is worse than a missing one.
      if (store.canRenameFile(record)) {
        items.push({ label: "Rename file…", act: () => startRename(record) });
      }
      // The inverse of Save to disk (architecture.md §23), and the way out of
      // a file that is gone for good.
      items.push({
        label: "Unlink file",
        hint: "The note stays in vrtti, the file stays on disk",
        act: () => run("file.unlink", record.id),
      });
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
    items.push(...syncItems(record));
    // History is the server's, so it only exists for a document the server
    // knows about.
    if (record.sync && sync?.isConfigured) {
      items.push({ label: "History…", act: () => run("doc.history", record.id) });
    }
    items.push(
      store.canEncryptFile(record)
        ? {
            label: "Encrypt",
            checked: Boolean(record.enc),
            // One item, both directions: the check mark says which way it goes.
            act: () => run(record.enc ? "doc.decrypt" : "doc.encrypt", record.id),
          }
        : {
            label: "Encrypt",
            checked: Boolean(record.enc),
            disabled: true,
            hint: "This browser cannot rename files",
          }
    );
    items.push({ separator: true });
    // A row is either a tab of this window (closable) or in Recent; the
    // record itself no longer says which (architecture.md §14).
    items.push(
      closable
        ? { label: "Close", act: () => run("buffer.close", record.id) }
        : { label: "Reopen", act: () => run("buffer.reopen", record.id) }
    );
    return items;
  }

  /**
   * The Sync item, and the "Sync to" items of an unsynced note (§25). The
   * hint names the space: where a synced note lives, or where "Sync" will
   * put this one. A synced note gets no "Sync to": a move between spaces is
   * Stop sync, then attach again, because the old space would never hear of
   * a direct move. Flat items, since the menu has no submenus and two or
   * three spaces need none.
   *
   * @param {BufferRecord} record
   * @returns {import("./menu.js").MenuItem[]}
   */
  function syncItems(record) {
    if (!sync?.isConfigured) {
      return [{ label: "Sync", checked: false, disabled: true, hint: "Set a server in settings" }];
    }
    if (record.sync) {
      return [
        {
          label: "Sync",
          // One item, both directions, like Encrypt below. A record from
          // before spaces may lack the field, and every reader takes that as
          // DEFAULT_SPACE, as the migration does.
          checked: true,
          hint: record.sync.space ?? DEFAULT_SPACE,
          act: () => run("doc.sync.off", record.id),
        },
      ];
    }
    const target = sync.defaultSpace();
    const others = sync
      .receivedSpaces()
      .filter((name) => name !== KEYRING_SPACE && name !== target)
      .sort();
    return [
      { label: "Sync", checked: false, hint: "to " + target, act: () => run("doc.sync.on", record.id) },
      ...others.map((name) => ({
        label: "Sync to " + name,
        act: () => run("doc.sync.on", { id: record.id, space: name }),
      })),
    ];
  }

  /**
   * A row is an <li>, so the keyboard has to be given it by hand: a tab stop,
   * and Enter or Space as the click. The target check matters: Enter on the
   * row's ⋯ or × button bubbles here too, and must not also open the row.
   * @param {HTMLElement} li
   */
  function keyboardRow(li) {
    li.tabIndex = 0;
    li.addEventListener("keydown", (event) => {
      if (event.target !== li) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      li.click();
    });
  }

  /** The rows the keyboard can land on, in sidebar order, hidden lists left out. */
  function keyboardRows() {
    return Array.from(sidebar.querySelectorAll("li[tabindex='0']")).filter(
      (li) => li instanceof HTMLElement && li.offsetParent !== null
    );
  }

  /** @param {BufferRecord} record @param {{closable: boolean}} opts */
  function makeRow(record, { closable }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    keyboardRow(li);
    // The rename box finds its row by this id, after the menu that asked for
    // it is already gone.
    li.dataset.id = record.id;
    if (record.id === store.activeId) li.classList.add("active");
    // Hover on the row: where the file sits, as far as the page can know it.
    if (record.kind === "file" && record.file) {
      li.title = "On disk: " + store.diskPath(record);
    }

    // A file-backed row is marked, never labelled: the file name is already
    // the title, so the marker only has to say "this one is on disk". The
    // tooltip prefers the folder path, which is what tells two notes.md apart.
    if (record.kind === "file" && record.file) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "⛁";
      mark.title = "On disk: " + store.diskPath(record);
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
      // Two causes share the marker and the click (architecture.md §23): a
      // lost permission or file, and a write that failed and holds the text.
      warn.title = record.file?.unwritten
        ? "The last write to this file failed. Click to try again."
        : "This file needs permission again. Click to reconnect.";
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
      openMenu(more, rowMenu(record, { closable }));
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
      // The pointer that dragged this row is released over it, and the
      // browser sends a click for that. Dropping a row is not opening it.
      if (dropped) return;
      if (closable) run("buffer.activate", record.id);
      else run("buffer.reopen", record.id);
      // On a phone the sidebar is a drawer over the editor, so it has to get
      // out of the way of the document it just opened. A no-op on a PC.
      run("sidebar.autoclose");
    });
    return li;
  }

  /**
   * A From server row (§25). Its own builder, not a mode of makeRow: a stub
   * is no record, and has no menu, no close and no drag. The ☁ says where
   * the text is; a click fetches it and opens it as a tab here.
   * @param {RemoteStub} stub
   */
  function makeStubRow(stub) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    keyboardRow(li);
    li.dataset.id = stub.id;

    const cloud = document.createElement("span");
    cloud.className = "buffer-mark";
    cloud.textContent = "☁";
    cloud.title = "On the server";
    li.appendChild(cloud);

    if (stub.enc) {
      const lock = document.createElement("span");
      lock.className = "buffer-mark";
      lock.textContent = "🔒";
      lock.title = "Encrypted";
      li.appendChild(lock);
    }

    const title = document.createElement("span");
    title.className = "buffer-title";
    // An encrypted stub has no readable first line to fall back on (§5).
    title.textContent = stub.title || (stub.enc ? "encrypted" : "untitled");
    li.appendChild(title);

    li.addEventListener("click", () => {
      run("remote.open", stub.id);
      run("sidebar.autoclose");
    });
    return li;
  }

  /**
   * The From server rows, newest first. With stubs from two or more spaces,
   * a heading names each space over its group; the groups follow their
   * newest stub, so the newest note is still on top. One space needs no
   * heading: the block's own heading already says what the rows are.
   * @param {RemoteStub[]} stubs newest first, as store.remotes() gives them
   * @returns {HTMLElement[]}
   */
  function stubRows(stubs) {
    /** @type {Map<string, RemoteStub[]>} */
    const groups = new Map();
    // Insertion order is the order of each space's newest stub.
    for (const stub of stubs) {
      const group = groups.get(stub.space);
      if (group) group.push(stub);
      else groups.set(stub.space, [stub]);
    }
    if (groups.size < 2) return stubs.map(makeStubRow);
    /** @type {HTMLElement[]} */
    const rows = [];
    for (const [space, group] of groups) {
      const heading = document.createElement("li");
      heading.className = "buffer-subheading";
      heading.textContent = space;
      rows.push(heading, ...group.map(makeStubRow));
    }
    return rows;
  }

  // ---- Reorder by drag (architecture.md §9, Manual order) -----------------

  // Pointer events, not the HTML5 drag and drop API: the desktop shell takes
  // the native drag events for file drops (src-tauri, §24), and on Windows
  // that leaves an in-page HTML5 drag with no dragover and no drop. Pointer
  // events belong to the page alone, in every webview.
  //
  // Mouse and pen only. A finger on a row is how the list scrolls, so a
  // touch drag would need touch-action: none on every row, and the list
  // could not scroll any more. The row menu stays the phone's way around.

  // The press that may become a drag, then the drag. Null between gestures.
  /** @type {{ li: HTMLElement, id: string, startY: number, moved: boolean, beforeId: string | null | undefined } | null} */
  let drag = null;
  // True from the drop until the click that follows it has been swallowed.
  let dropped = false;
  // A press turns into a drag after this many pixels: a click wobbles less.
  const DRAG_SLOP = 4;

  openList.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0 || event.pointerType === "touch") return;
    const target = /** @type {HTMLElement} */ (event.target);
    // A press on the ⋯, the × or the rename box is theirs, not a drag.
    if (target.closest("button, input")) return;
    const li = target.closest(".buffer-row");
    if (!(li instanceof HTMLElement) || !li.dataset.id || !li.parentElement) return;
    // No preventDefault here: it would keep the focus where it is, and a
    // rename box commits on blur, so a press on another row must still take
    // the focus away from it. Titles are user-select: none (app.css) instead,
    // so a slow press does not start selecting them across the list.
    drag = { li, id: li.dataset.id, startY: event.clientY, moved: false, beforeId: undefined };
    li.setPointerCapture(event.pointerId);
  });

  openList.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_SLOP) return;
      drag.moved = true;
      drag.li.classList.add("dragging");
      openList.classList.add("reordering");
    }
    showDropTarget(event.clientY);
  });

  openList.addEventListener("pointerup", (event) => {
    if (!drag) return;
    const { id, moved, beforeId } = drag;
    endDrag();
    if (!moved) return;
    // The click comes right after this event, in the same task; the flag
    // outlives it by one tick and no more, so a lost click cannot leave it
    // set for the next real one.
    dropped = true;
    setTimeout(() => (dropped = false), 0);
    event.preventDefault();
    if (beforeId !== undefined) run("buffer.move", { id, before: beforeId });
  });
  openList.addEventListener("pointercancel", endDrag);

  /**
   * The insertion point for the pointer's height: before the first row whose
   * middle is below the pointer, else last. The mark goes on that row's top
   * edge, or the last row's bottom edge. A drop beside the row itself (just
   * above or just below it) is no move, and shows no mark.
   * @param {number} y
   */
  function showDropTarget(y) {
    if (!drag) return;
    const rows = /** @type {HTMLElement[]} */ ([...openList.children]);
    for (const row of rows) row.classList.remove("drop-before", "drop-after");
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    const from = rows.indexOf(drag.li);
    if (index === from || index === from + 1) {
      drag.beforeId = undefined;
      return;
    }
    if (index < rows.length) {
      rows[index].classList.add("drop-before");
      drag.beforeId = rows[index].dataset.id ?? null;
    } else {
      rows[rows.length - 1].classList.add("drop-after");
      drag.beforeId = null;
    }
  }

  function endDrag() {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    openList.classList.remove("reordering");
    for (const row of openList.children) {
      row.classList.remove("dragging", "drop-before", "drop-after");
    }
    // Only after a real drag: the redraw that stood down runs now, and the
    // move's own "change" (if any) draws the new order right after. A plain
    // press must keep its row, or the click that follows the release has no
    // element to land on and never fires, and the row does not activate.
    if (moved) render();
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
    keyboardRow(li);
    // Inline indent: the depth is unbounded, so no fixed set of classes can
    // cover it. 10px is the padding every other sidebar row uses. The calc
    // keeps the step proportional to the interface text size (ui/textsize.js),
    // or a deep tree at 200% would indent by a third of a character.
    li.style.paddingLeft = `calc(${10 + depth * 14}px * var(--ui-scale))`;
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
        // The folder's name leads the path, so "docs/sub/notes.md" says
        // which folder a file came from; the absolute path is not available
        // to a page (architecture.md §2).
        const folderName = folders.folders.get(folderId)?.name ?? "";
        run("folder.openFile", { handle: entry.handle, path: folderName + "/" + entry.path });
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
    // The browser hands the page a folder's name and nothing of its place on
    // disk; the native backend knows the real path (architecture.md §17).
    const handle = folders.folders.get(folder.id)?.handle;
    name.title = isNativeHandle(handle)
      ? folder.name + "\n" + handle.fullPath
      : folder.name + "\n(the full path is not available to the page)";
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
    // Without a disk backend the folder commands are not registered, so a
    // section's buttons would dispatch into nothing. There is also nothing to
    // draw: such a build can hold no directory handle.
    if (!hasDisk) return;
    folderSections.replaceChildren(...folders.openFolders().map(folderSection));
  }

  /**
   * Which row the keyboard is on, so a redraw can put the focus back. Every
   * replaceChildren below destroys the focused row, and a sync or another
   * window can redraw while the user is arrowing through the list. A row is
   * found again by its id in the same list; a row that vanished (closed,
   * fetched) leaves the focus where the browser drops it.
   */
  function focusedRow() {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !sidebar.contains(el)) return null;
    const list = el.parentElement;
    const id = el.dataset.id;
    return list && id ? { list, id } : null;
  }

  /** @param {{list: HTMLElement, id: string} | null} row */
  function refocusRow(row) {
    if (!row) return;
    const li = row.list.querySelector(`li[data-id="${CSS.escape(row.id)}"]`);
    if (li instanceof HTMLElement) li.focus();
  }

  function render() {
    // A rename input lives inside one of these rows, and every keystroke in
    // the editor emits "change". Redrawing now would delete the box the user
    // is typing in; startRename() calls render() itself when it is done. A
    // drag holds its rows the same way: a sync arriving mid-drag must not
    // swap the row under the pointer; endDrag() redraws.
    if (renamingId || drag) return;
    const focused = focusedRow();

    openList.replaceChildren(
      ...store.openBuffers().map((b) => makeRow(b, { closable: true }))
    );

    const closed = store.closedBuffers();
    recentBlock.hidden = closed.length === 0;
    recentHeading.textContent =
      (recentCollapsed ? "▸" : "▾") + " Recent (" + closed.length + ")";
    recentList.hidden = recentCollapsed;
    recentList.replaceChildren(
      ...(recentCollapsed ? [] : closed.map((b) => makeRow(b, { closable: false })))
    );

    // The store emits "change" when a stub comes or goes, in any window
    // (§25), so this block follows the same event as the lists above.
    const stubs = store.remotes();
    fromserverBlock.hidden = stubs.length === 0;
    fromserverHeading.textContent =
      (fromserverCollapsed ? "▸" : "▾") + " From server (" + stubs.length + ")";
    fromserverList.hidden = fromserverCollapsed;
    fromserverList.replaceChildren(...(fromserverCollapsed ? [] : stubRows(stubs)));
    refocusRow(focused);
  }

  // Keyboard travel between rows. Tab already walks everything in the
  // sidebar top to bottom (the buttons, then every row); Up and Down skip
  // the buttons and move row to row, and Escape goes back to the text.
  sidebar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // A menu's Escape has already closed the menu and put the focus back
      // on the ⋯ (ui/menu.js). The search view and a rename box stop the
      // event before it gets here, so theirs are not seen at all.
      if (event.defaultPrevented) return;
      event.preventDefault();
      run("editor.focus");
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = keyboardRows();
    const at = rows.indexOf(/** @type {HTMLElement} */ (event.target));
    if (at < 0) return;
    event.preventDefault();
    const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
  });

  // Sublime's Ctrl+0: the keyboard's way out of the editor, which keeps Tab
  // for itself (editor/editor.js). Lands on the open document's row, the
  // place the user is, or on the first row, or on "+" when there is none.
  register({
    id: "sidebar.focus",
    title: "Focus sidebar",
    keys: "Ctrl+Digit0",
    run: () => {
      // A collapsed sidebar is inert, and focus() on it does nothing.
      run("sidebar.show");
      const active = openList.querySelector("li.active");
      const target = active instanceof HTMLElement ? active : keyboardRows()[0] ?? newButton;
      target.focus();
    },
  });

  store.events.addEventListener("change", render);
  store.events.addEventListener("active", render);
  folders.events.addEventListener("change", renderFolders);
  folders.events.addEventListener("listing", renderFolders);
  render();
  renderFolders();
}
