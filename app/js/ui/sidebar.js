// @ts-check
// Sidebar: the Open list, one section per opened folder, Recent and From server. Reads the
// stores, dispatches commands, owns its DOM region. All user-derived text goes
// through textContent.
//
// Two render paths on purpose: the buffer lists redraw on every doc "change"
// (one per keystroke), and a folder tree can hold hundreds of rows that have
// nothing to do with the text being typed.

import { titleOf } from "../model/docs.js";
import { previewOf, shortTime } from "../model/preview.js";
import { hasDisk } from "../model/capabilities.js";
import { isNativeHandle } from "../storage/native.js";
import { register, run } from "../commands/registry.js";
import { openMenu } from "./menu.js";
import { phoneMode } from "./shell.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../model/folders.js").Entry} Entry */
/** @typedef {import("../storage/idb.js").RemoteStub} RemoteStub */

// Longer rows in the phone note list (architecture.md §9, Phone mode): the
// time of the last change and two lines of preview, where a row has one line
// by default. Device-local in localStorage, like the "+" setting next to it
// (ui/newbutton.js): a phone and a small tablet want different answers. The
// state is a class on <html> and app.css does the rest, so a change redraws
// nothing; the inline script in index.html replays the class before the
// first paint and only reads the key this file writes.
const ROWS_KEY = "vrtti.listRows";
const ROWS_CLASS = "rows-long";

/** The "longer rows" setting. */
export function listRowsLong() {
  return document.documentElement.classList.contains(ROWS_CLASS);
}

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

  /**
   * Every gesture that opens a document goes through here, so the document
   * ends up visible: the settings panel covers the editor on a PC, and on a
   * phone the drawer covers both. Settings close before the open, not after:
   * closing hands focus back to where it was taken from (the Settings button,
   * say), which would undo the focus the editor takes on "active". The drawer
   * closes after; a no-op on a PC.
   * @param {() => unknown} act
   */
  function open(act) {
    run("settings.close");
    act();
    run("sidebar.autoclose");
  }

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => open(() => run("buffer.new")));

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
    // Through open() too: a file picked while settings are up must show.
    // A cancelled picker leaves settings closed, which is fine.
    openFile.addEventListener("click", () => open(() => run("file.open")));
    openFolder.addEventListener("click", () => run("folder.open"));
  }

  // A new window is a new workspace (architecture.md §14). Multi-window is a
  // desktop thing: on a phone the tab would open outside the installed app,
  // so the button hides under the drawer breakpoint.
  const newWindow = /** @type {HTMLElement} */ (document.getElementById("new-window"));
  newWindow.hidden = matchMedia("(max-width: 700px)").matches;
  newWindow.addEventListener("click", () => run("workspace.new"));

  register({
    id: "view.listRows",
    title: "Toggle longer rows in the note list",
    run: () => {
      const long = document.documentElement.classList.toggle(ROWS_CLASS);
      try {
        localStorage.setItem(ROWS_KEY, long ? "long" : "short");
      } catch {
        // Private mode: the choice still applies for this session.
      }
      return long;
    },
  });

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
   * one, rather than claiming to sync into nothing. Encrypt is for a file on
   * disk only (§19, §27): it renames the file to `.age`, so it is disabled
   * where the browser cannot rename a file. A synced note is encrypted anyway.
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

    // The whole text to the clipboard. On a phone this menu is the one place
    // for it: there is no keyboard for Ctrl+A, Ctrl+C.
    items.push({ label: "Copy text", act: () => run("doc.copy", record.id) });

    items.push({ separator: true });
    items.push(...syncItems(record));
    // History is the server's, so it only exists for a document the server
    // knows about.
    if (record.sync && sync?.isConfigured) {
      items.push({ label: "History…", act: () => run("doc.history", record.id) });
    }
    // Two labels, not one checked item: "Decrypt" says what the click does,
    // and a check mark did not. A synced note stays encrypted (§27), so it
    // gets neither; a local note gets Decrypt only, for an old encrypted one.
    if (!record.sync) {
      if (record.kind === "file" && record.file) {
        items.push(
          store.canEncryptFile(record)
            ? record.enc
              ? { label: "Decrypt", hint: "Stores the file readable again", act: () => run("doc.decrypt", record.id) }
              : { label: "Encrypt", hint: "For this device and the recovery key", act: () => run("doc.encrypt", record.id) }
            : {
                label: record.enc ? "Decrypt" : "Encrypt",
                disabled: true,
                hint: "Needs Chrome, Edge or the desktop app to rename the file",
              }
        );
      } else if (record.enc) {
        items.push({ label: "Decrypt", hint: "Stores the text readable again", act: () => run("doc.decrypt", record.id) });
      }
    }
    items.push(
      record.pin
        ? { label: "Remove PIN lock", act: () => run("doc.unpin", record.id) }
        : { label: "Lock with PIN", hint: "The note opens after this device's PIN", act: () => run("doc.pin", record.id) }
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
   * "Sync to <space>" for an unsynced note, the default space first (§25),
   * and for a synced one "Move to <space>" for each other space of this
   * device, then "Stop syncing" with its space in the hint (§27). The origin
   * device is the hint of a move: it is what tells a lent note from one of
   * the space's own. Flat items, since the menu has no submenus and two or
   * three spaces need none.
   *
   * @param {BufferRecord} record
   * @returns {import("./menu.js").MenuItem[]}
   */
  function syncItems(record) {
    if (!sync?.isConfigured) {
      return [{ label: "Sync", disabled: true, hint: "Set up sync in Settings › Sync first" }];
    }
    const mine = sync.mySpaces();
    if (record.sync) {
      const here = record.sync.space ?? "";
      const from = originName(record);
      return [
        ...mine
          .filter((name) => name !== here)
          .map((name) => ({
            label: "Move to " + name,
            hint: from ? "from " + from : undefined,
            act: () => run("doc.move", { id: record.id, space: name }),
          })),
        {
          label: "Stop syncing",
          hint: "in " + here + " · the text stays on every device",
          act: () => run("doc.sync.off", record.id),
        },
      ];
    }
    const target = sync.defaultSpace();
    if (!target) {
      return [{ label: "Sync", disabled: true, hint: "Make a space in Settings › Devices first" }];
    }
    return [target, ...mine.filter((name) => name !== target)].map((name) => ({
      label: "Sync to " + name,
      act: () => run("doc.sync.on", { id: record.id, space: name }),
    }));
  }

  /** The name of the device that made a synced note, or "". @param {BufferRecord} record */
  function originName(record) {
    if (!record.origin || !sync) return "";
    return sync.deviceName(record.origin) || "";
  }

  /**
   * The thin bar in the color of the note's space, at the left edge of the
   * row (§27). A local note has none.
   * @param {HTMLElement} li @param {string | undefined} space
   */
  function spaceBar(li, space) {
    const color = space && sync ? sync.colorOf(space) : "";
    if (!color) return;
    li.classList.add("has-space");
    // The bar is the row's ::before (app.css): the drag marks of a row are
    // its box-shadow, so the bar cannot be one too.
    li.style.setProperty("--space-color", color);
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
    // Hover on the row: the space and the device that made the note (§27),
    // and where the file sits, as far as the page can know it.
    /** @type {string[]} */
    const hover = [];
    if (record.sync?.space) {
      const from = originName(record);
      hover.push(record.sync.space + (from ? " · from " + from : ""));
      spaceBar(li, record.sync.space);
    }
    if (record.kind === "file" && record.file) hover.push("On disk: " + store.diskPath(record));
    if (hover.length) li.title = hover.join("\n");

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

    // The lock mark means the PIN lock (§27). A synced note is shown by its
    // colored bar, and every synced note is encrypted, so neither needs a
    // mark of its own.
    if (record.pin) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "🔒";
      mark.title = "Locked with the PIN";
      li.appendChild(mark);
    }

    const titleText = titleOf(record);
    const title = document.createElement("span");
    title.className = "buffer-title";
    title.textContent = titleText;
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

    // The time of the last change, for the longer rows of the phone note
    // list. Every row carries it and the preview below, in every layout, and
    // app.css shows them in phone mode only: the layout can change under a
    // drawn list (a phone turned on its side), and this way that needs no
    // redraw and no code that knows the mode.
    const time = document.createElement("span");
    time.className = "buffer-time";
    time.textContent = shortTime(record.updatedAt);
    li.appendChild(time);

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

    // The start of the text, the second line of a phone row. loadedText, not
    // textOf: this runs for every row on every keystroke, and textOf would
    // read every file and decrypt every note to draw a list. So a locked
    // note and an unread file have no preview, and neither has a note that
    // is only its title; those rows stay one line. Last in the row: app.css
    // wraps it onto a line of its own.
    const text = store.loadedText(record.id);
    const preview = text === undefined ? "" : previewOf(text, titleText);
    if (preview) {
      const span = document.createElement("span");
      span.className = "buffer-preview";
      span.textContent = preview;
      li.appendChild(span);
    }

    li.addEventListener("click", () => {
      // The pointer that dragged this row is released over it, and the
      // browser sends a click for that. Dropping a row is not opening it.
      if (dropped) return;
      open(() => run(closable ? "buffer.activate" : "buffer.reopen", record.id));
    });
    return li;
  }

  /**
   * A From server row (§25). Its own builder, not a mode of makeRow: a stub
   * is no record, and has no menu, no close and no drag. A click fetches the
   * note and opens it as a tab here.
   * @param {RemoteStub} stub
   */
  function makeStubRow(stub) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    keyboardRow(li);
    li.dataset.id = stub.id;
    li.title = stub.space + " · on the server. Click to open it here.";
    spaceBar(li, stub.space);

    const title = document.createElement("span");
    title.className = "buffer-title";
    // A title this device could not open yet (locked) is no first line.
    title.textContent = stub.title || (stub.enc ? "encrypted" : "untitled");
    li.appendChild(title);

    li.addEventListener("click", () => open(() => run("remote.open", stub.id)));
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

  // ---- Swipe to close (architecture.md §9, Phone mode) ---------------------

  // In the phone note list, a swipe to the left on a row of Open closes that
  // note: one move of the thumb where the row menu takes two taps. Touch
  // only, so it shares nothing with the drag above, which ignores touch. Its
  // own state and its own listeners, on the same list.
  //
  // The row stays where it is and its content moves: this code writes the
  // distance to one custom property, and app.css moves the row's children by
  // it and shows the word "close" behind them (a pseudo-element, so makeRow
  // has nothing to add). Moving the <li> itself would leave nothing to show
  // behind it.
  //
  // The rows carry touch-action: pan-y in phone mode (app.css). That is what
  // divides the gesture: an up or down move is the browser's scroll, and the
  // browser then cancels the pointer; a sideways move comes here.

  /** @type {{ li: HTMLElement, id: string, pointerId: number, startX: number, startY: number, width: number, active: boolean } | null} */
  let swipe = null;
  // Rows on their way out (swipeOut). They are no longer `swipe`, so the next
  // swipe can start while they leave, but render() must still not replace
  // them in the middle of their animation.
  let leaving = 0;
  // render() stood down for a swipe or a leaving row and has a redraw to
  // make up for.
  let redrawOwed = false;
  // On the row while its word "close" is bright. The class is also the
  // answer to "does a release close the note" (pointerup), so what the user
  // was shown and what happens cannot come apart.
  const ARMED = "swipe-armed";
  // The finger must go this far left before the row starts to follow it.
  const SWIPE_SLOP = 10;
  // The close point: this share of the row's width (user decision,
  // 2026-11-19). Half was the first plan, and is a long reach for one thumb.
  // Distance only, never speed: a quick flick must not close a note, because
  // a close has no undo other than opening the note again from Recent.
  const SWIPE_CLOSE = 1 / 3;
  // The close, in two steps: the content slides off to the left, then the
  // row folds away and the rows below move up. The first version removed the
  // row the moment the finger lifted, and on a real phone that was too fast
  // to follow (user report, 2026-11-19). Milliseconds.
  const SWIPE_OUT = 200;
  const SWIPE_FOLD = 200;

  openList.addEventListener("pointerdown", (event) => {
    if (swipe || event.pointerType !== "touch" || !event.isPrimary || !phoneMode()) return;
    const target = /** @type {HTMLElement} */ (event.target);
    // The rename box wants its touches for the text, and the ⚠ is a small
    // button with a job of its own. The ⋯ is not excluded: it fills the right
    // end of the row, which is where a thumb starts a swipe to the left, and
    // a finger that moved sends no click, so the menu stays shut.
    if (target.closest("input, .buffer-warn")) return;
    const li = target.closest(".buffer-row");
    if (!(li instanceof HTMLElement) || !li.dataset.id) return;
    swipe = {
      li,
      id: li.dataset.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: 0,
      active: false,
    };
  });

  openList.addEventListener("pointermove", (event) => {
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const dx = event.clientX - swipe.startX;
    if (!swipe.active) {
      // The list may redraw under a finger that has not moved yet (a sync):
      // the row this press began on is then gone, and so is the swipe.
      if (!swipe.li.isConnected) {
        swipe = null;
        return;
      }
      // To the left, and more to the left than up or down. Anything else is
      // a tap, a scroll, or a move to the right, which does nothing.
      if (dx > -SWIPE_SLOP || -dx < Math.abs(event.clientY - swipe.startY)) return;
      swipe.active = true;
      swipe.width = swipe.li.offsetWidth;
      swipe.li.classList.add("swiping");
    }
    // Never to the right of where it started.
    const moved = Math.min(0, dx);
    swipe.li.style.setProperty("--swipe", moved + "px");
    // The word "close" turns bright: lifting the finger now closes the note.
    swipe.li.classList.toggle(ARMED, -moved >= swipe.width * SWIPE_CLOSE);
  });

  openList.addEventListener("pointerup", (event) => {
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const { id, li } = swipe;
    // Read before endSwipe() takes the class off.
    const close = li.classList.contains(ARMED);
    if (close && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      swipeOut();
      return;
    }
    endSwipe();
    // Reduced motion: at once, with no slide out. The store's "change"
    // redraws the list without the row. The list stays open, so the next
    // note can go the same way.
    if (close) run("buffer.close", id);
  });

  // A release past the close point: the row leaves, then the note closes.
  function swipeOut() {
    if (!swipe) return;
    const { li, id, width } = swipe;
    // Free for the next swipe at once. The row keeps its classes: the bright
    // word "close" stays behind the content while it goes.
    swipe = null;
    leaving++;
    // A tap on a row that is on its way out must not open its note.
    li.style.pointerEvents = "none";
    // From where the finger left it. The animation outranks the transform
    // that app.css derives from --swipe, and `forwards` holds the last frame
    // until the redraw removes the row.
    const from = li.style.getPropertyValue("--swipe");
    for (const child of li.children) {
      child.animate(
        { transform: [`translateX(${from})`, `translateX(${-width}px)`] },
        { duration: SWIPE_OUT, easing: "ease-in", fill: "forwards" }
      );
    }
    // Height alone would stop at the padding and the min-height.
    li.animate(
      {
        height: [li.offsetHeight + "px", "0px"],
        minHeight: "0px",
        paddingTop: "0px",
        paddingBottom: "0px",
      },
      { delay: SWIPE_OUT, duration: SWIPE_FOLD, easing: "ease-in-out", fill: "forwards" }
    );
    // A timer, not the animations' `finished`: the close must come even if
    // the browser drops an animation (the list can go out of sight in the
    // middle, when the user opens another note). The two constants set both
    // the animations and this wait, so they cannot drift apart.
    setTimeout(async () => {
      try {
        await run("buffer.close", id);
      } finally {
        // Held until the store is done, not until the timer: the close
        // writes to storage first, and a redraw in that gap would draw the
        // row again at full height. The store's "change" came while the
        // list was held, so the redraw is owed now.
        leaving--;
        if (redrawOwed) render();
      }
    }, SWIPE_OUT + SWIPE_FOLD);
  }

  // The browser took the gesture for a scroll, or Android took it for Back
  // (a swipe that starts at the screen edge). Either way nothing closes.
  openList.addEventListener("pointercancel", (event) => {
    if (swipe && event.pointerId === swipe.pointerId) endSwipe();
  });

  function endSwipe() {
    if (!swipe) return;
    const { li, active } = swipe;
    swipe = null;
    if (!active) return;
    // Without the class, app.css moves the content back to its place.
    li.classList.remove("swiping", ARMED);
    li.style.removeProperty("--swipe");
    // The redraw that stood down during the swipe runs now. It replaces the
    // row, so in this one case the content jumps home instead of sliding;
    // a timer to wait for the slide would be a second clock to keep in step
    // with the CSS, for a sync that lands in the middle of a swipe.
    if (redrawOwed) render();
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
        const path = folderName + "/" + entry.path;
        open(() => run("folder.openFile", { handle: entry.handle, path }));
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

  /**
   * The row of the note on screen, scrolled into view. A new note lands at
   * the end of the Open list, below the fold once the list is longer than
   * the sidebar; a search hit or a chord can open a note anywhere in it.
   * "nearest" moves the list only as far as it must, so a row already on
   * screen holds the list still. The drawer and a collapsed sidebar keep
   * their layout (ui/shell.js), so the scroll lands even while hidden.
   */
  function revealActive() {
    const row = openList.querySelector("li.active");
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }

  /**
   * @param {{reveal?: boolean}} [opts] reveal: the active note changed, so
   *   its row must end up on screen. Off for every other redraw: a sync or a
   *   keystroke must not drag the list away from where the user scrolled it.
   */
  function render({ reveal = false } = {}) {
    // A rename input lives inside one of these rows, and every keystroke in
    // the editor emits "change". Redrawing now would delete the box the user
    // is typing in; startRename() calls render() itself when it is done. A
    // drag holds its rows the same way: a sync arriving mid-drag must not
    // swap the row under the pointer; endDrag() redraws.
    if (renamingId || drag) return;
    // A swipe holds its row for the same reason. Only once the row follows
    // the finger, not from the first touch: every tap and every scroll
    // begins as a press, and those must not hold a redraw back.
    // endSwipe() redraws if this happened. A row that leaves after a swipe
    // (swipeOut) holds the list as well, until its note closes.
    if (swipe?.active || leaving > 0) {
      redrawOwed = true;
      return;
    }
    redrawOwed = false;
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
    if (reveal) revealActive();
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

  store.events.addEventListener("change", () => render());
  store.events.addEventListener("active", () => render({ reveal: true }));
  // A lock takes the plaintext out of memory (model/docs.js lockAll), and a
  // preview drawn from it must leave the screen in the same moment. The store
  // sends no "change" for a lock, so without this the decrypted lines would
  // stay in the list until the next edit. The previews go by hand first,
  // because render() stands down during a rename or a drag, and "the list was
  // busy" is no reason to keep showing a locked note. All of them, not only
  // the encrypted ones: the redraw puts the others back.
  store.events.addEventListener("lock", () => {
    for (const el of sidebar.querySelectorAll(".buffer-preview")) el.remove();
    render();
  });
  // A new color or a new member list changes the bars and the menus (§27).
  sync?.events.addEventListener("spaces", () => render());
  folders.events.addEventListener("change", renderFolders);
  folders.events.addEventListener("listing", renderFolders);
  render();
  renderFolders();
}
