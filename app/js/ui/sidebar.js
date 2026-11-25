// @ts-check
// Sidebar: the Open list, folder trees, the desktop View space filter and
// zero-shift Delete mode, the bottom icon bar with its single shared drawer,
// and phone Mode B full-screen subviews (architecture.md §9, §28). Reads the
// stores, dispatches commands, owns its DOM region. All user-derived text goes
// through textContent.
//
// Two render paths on purpose: the buffer lists redraw on every doc "change"
// (one per keystroke), and a folder tree can hold hundreds of rows that have
// nothing to do with the text being typed.

import { titleOf } from "../model/docs.js";
import { previewOf, shortTime } from "../model/preview.js";
import { hasDisk, isDesktop } from "../model/capabilities.js";
import { daysLeft, RECENT_KEEP, spaceBadge, TRASH_KEEP } from "../model/lifecycle.js";
import { isNativeHandle } from "../storage/native.js";
import { register, run } from "../commands/registry.js";
import { editorEvents } from "../editor/editor.js";
import { openMenu } from "./menu.js";
import { onPhoneModeChange, phoneListOpen, phoneMode, watchBack } from "./shell.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */
/** @typedef {import("../model/folders.js").Entry} Entry */
/** @typedef {import("../storage/idb.js").RemoteStub} RemoteStub */

const SVG_NS = "http://www.w3.org/2000/svg";

// Longer rows in the phone note list (architecture.md §9, Phone mode): two
// lines of preview, where a row has one line by default. Device-local in
// localStorage, like the "+" setting next to it (ui/newbutton.js): a phone and
// a small tablet want different answers. The state is a class on <html> and
// app.css does the rest, so a change redraws nothing; the inline script in
// index.html replays the class before the first paint and only reads the key
// this file writes.
const ROWS_KEY = "vrtti.listRows";
const ROWS_CLASS = "rows-long";

/** The "longer rows" setting. */
export function listRowsLong() {
  return document.documentElement.classList.contains(ROWS_CLASS);
}

/** @param {string} d */
function makeIcon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "action-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

function makeTrashIcon() {
  return makeIcon("M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5");
}

function makeRestoreIcon() {
  return makeIcon("M5 5L2 8l3 3M2.5 8h7a3 3 0 0 1 0 6H7");
}

/**
 * @typedef {{ kind: "recent" } | { kind: "trash" } | { kind: "space", space: string }} DrawerTarget
 */

/**
 * @param {DrawerTarget | null} a @param {DrawerTarget | null} b
 */
function sameTarget(a, b) {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind !== "space" || a.space === /** @type {{kind: "space", space: string}} */ (b).space;
}

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../model/folders.js").createFolderStore>} folders
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 * @param {ReturnType<import("../model/workspace.js").createWorkspaces>} [workspaces]
 */
export function mountSidebar(store, folders, sync, workspaces) {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
  const sidebarScroll = /** @type {HTMLElement} */ (document.getElementById("sidebar-scroll"));
  const spaceBanner = /** @type {HTMLElement} */ (document.getElementById("space-banner"));
  const spaceBannerName = /** @type {HTMLElement} */ (document.getElementById("space-banner-name"));
  const openList = /** @type {HTMLElement} */ (document.getElementById("open-list"));
  const openFilterPill = /** @type {HTMLElement} */ (document.getElementById("open-filter-pill"));
  const deletePill = /** @type {HTMLElement} */ (document.getElementById("delete-pill"));
  const openEmpty = /** @type {HTMLElement} */ (document.getElementById("open-empty"));
  const clearFilterBtn = /** @type {HTMLElement} */ (document.getElementById("clear-filter-btn"));
  const folderSections = /** @type {HTMLElement} */ (document.getElementById("folder-sections"));

  const actView = /** @type {HTMLElement} */ (document.getElementById("act-view"));
  const actDel = /** @type {HTMLElement} */ (document.getElementById("act-del"));

  const phoneViewEl = /** @type {HTMLElement} */ (document.getElementById("phone-view"));
  const phoneViewDot = /** @type {HTMLElement} */ (document.getElementById("phone-view-dot"));
  const phoneViewTitle = /** @type {HTMLElement} */ (document.getElementById("phone-view-title"));
  const phoneViewBack = /** @type {HTMLElement} */ (document.getElementById("phone-view-back"));
  const phoneViewList = /** @type {HTMLElement} */ (document.getElementById("phone-view-list"));

  const bottomDrawer = /** @type {HTMLElement} */ (document.getElementById("bottom-drawer"));
  const drawerDot = /** @type {HTMLElement} */ (document.getElementById("drawer-dot"));
  const drawerTitle = /** @type {HTMLElement} */ (document.getElementById("drawer-title"));
  const drawerSub = /** @type {HTMLElement} */ (document.getElementById("drawer-sub"));
  const drawerOpenWin = /** @type {HTMLElement} */ (document.getElementById("drawer-open-win"));
  const drawerClose = /** @type {HTMLElement} */ (document.getElementById("drawer-close"));
  const drawerList = /** @type {HTMLElement} */ (document.getElementById("drawer-list"));

  const bottomBar = /** @type {HTMLElement} */ (document.getElementById("bottom-bar"));
  const barRecent = /** @type {HTMLElement} */ (document.getElementById("bar-recent"));
  const barRecentCount = /** @type {HTMLElement} */ (document.getElementById("bar-recent-count"));
  const barSepLeft = /** @type {HTMLElement} */ (document.getElementById("bar-sep-left"));
  const barSpaces = /** @type {HTMLElement} */ (document.getElementById("bar-spaces"));
  const barSepRight = /** @type {HTMLElement} */ (document.getElementById("bar-sep-right"));
  const barTrash = /** @type {HTMLElement} */ (document.getElementById("bar-trash"));
  const barTrashCount = /** @type {HTMLElement} */ (document.getElementById("bar-trash-count"));
  const barSettings = /** @type {HTMLElement} */ (document.getElementById("bar-settings"));

  const ownSpace = () => workspaces?.current().space;

  // ---- Per-window UI state (never persisted) -------------------------------

  // Closed drawers, Delete mode, and the View filter start clear in every
  // window and nothing stores them (architecture.md §9, §28).
  /** Space keys hidden by the desktop View filter ("local" or space name). @type {Set<string>} */
  const hiddenSpaces = new Set();
  let deleteMode = false;
  /** Desktop shared drawer selection; starts closed in every window. @type {DrawerTarget | null} */
  let openDrawer = null;
  /** Phone Mode B full-screen subview; null shows Open. @type {DrawerTarget | null} */
  let phoneView = null;
  let stopPhoneBack = () => {};

  /** @param {DrawerTarget | null} next @param {{redraw?: boolean}} [opts] */
  function setPhoneView(next, { redraw = true } = {}) {
    if (sameTarget(phoneView, next)) return;
    phoneView = next;
    stopPhoneBack();
    stopPhoneBack = phoneView && phoneMode() ? watchBack(() => setPhoneView(null)) : () => {};
    if (redraw) {
      render();
      if (phoneView) sidebarScroll.scrollTop = 0;
    }
  }

  /**
   * Every gesture that opens a document goes through here, so the document
   * ends up visible: the settings panel covers the editor on a PC, and on a
   * phone the drawer covers both. Both close before the open, not after:
   * closing settings first keeps its focus handover ahead of the new note's
   * activation, and closing the phone note list first lets the editor see it
   * is visible so it takes focus and prompts for PIN/unlock when needed.
   * `sidebar.autoclose` is a no-op on a PC.
   * @param {() => unknown} act
   */
  function open(act) {
    // Disarm any phone subview Back watcher before closing the note list so
    // CloseWatcher stack order never keeps an invisible subview layer armed.
    setPhoneView(null, { redraw: false });
    run("settings.close");
    run("sidebar.autoclose");
    act();
  }

  // If the phone note list closes via the thumb button or Escape while a
  // subview is active, return the list to Open and disarm its Back watcher;
  // when the phone note list opens, warm previews for the visible rows.
  new MutationObserver(() => {
    if (phoneView && !app.classList.contains("sidebar-open")) {
      setPhoneView(null);
    } else if (phoneListOpen()) {
      scheduleVisiblePreviews();
    }
  }).observe(app, { attributes: true, attributeFilter: ["class"] });

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => open(() => run("buffer.new")));

  // Pinned outside the scroller inside #bottom-bar by app.css, so a long
  // buffer list never hides it (architecture.md §9, §28). Desktop only; phone
  // reaches Settings through the round thumb menu.
  barSettings.addEventListener("click", () => {
    // Drop focus from the toggle button first: clicking a <button> focuses it
    // before click runs, so toggling Settings closed would otherwise leave
    // #bar-settings focused and let a later Space or Enter re-open Settings.
    barSettings.blur();
    // On a narrow desktop window the drawer sits above the settings panel, so
    // it must close first or the panel opens behind it.
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

  // ---- Desktop View space filter (§28) -------------------------------------

  /** @param {BufferRecord} record */
  function filterKey(record) {
    return record.sync?.space || "local";
  }

  /** @param {BufferRecord} record */
  function matchesFilter(record) {
    if (phoneMode() || ownSpace() || hiddenSpaces.size === 0) return true;
    return !hiddenSpaces.has(filterKey(record));
  }

  // Tell the doc store which tabs are visible so closing/trashing the active
  // tab while filtered activates the next visible tab when one exists (§28).
  store.setVisibleFilter(matchesFilter);

  /** @param {BufferRecord | null | undefined} record */
  function unhideFor(record) {
    if (!record) return;
    if (hiddenSpaces.delete(filterKey(record))) render();
  }

  /** @returns {import("./menu.js").MenuItem[]} */
  function buildViewItems() {
    const allOpen = store.openBuffers();
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const b of allOpen) {
      const key = filterKey(b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    /** @type {string[]} */
    const spaces = [];
    for (const s of sync?.mySpaces() ?? []) if (!spaces.includes(s)) spaces.push(s);
    for (const b of allOpen) {
      const s = b.sync?.space;
      if (s && !spaces.includes(s)) spaces.push(s);
    }
    const allKeys = ["local", ...spaces];
    /** @type {import("./menu.js").MenuItem[]} */
    const items = [
      {
        header: "Show in Open",
        headerAction: {
          label: "Show all",
          act: () => {
            hiddenSpaces.clear();
            render();
          },
        },
      },
      {
        label: "Local & files",
        swatch: "local",
        checked: !hiddenSpaces.has("local"),
        count: counts.get("local") ?? 0,
        act: () => {
          if (hiddenSpaces.has("local")) hiddenSpaces.delete("local");
          else hiddenSpaces.add("local");
          render();
        },
        action: {
          label: "only",
          title: "Show only Local & files",
          act: () => {
            hiddenSpaces.clear();
            for (const k of allKeys) if (k !== "local") hiddenSpaces.add(k);
            render();
          },
        },
      },
    ];
    for (const space of spaces) {
      items.push({
        label: space,
        swatch: sync?.colorOf(space) || "#6699CC",
        checked: !hiddenSpaces.has(space),
        count: counts.get(space) ?? 0,
        act: () => {
          if (hiddenSpaces.has(space)) hiddenSpaces.delete(space);
          else hiddenSpaces.add(space);
          render();
        },
        action: {
          label: "only",
          title: "Show only " + space,
          act: () => {
            hiddenSpaces.clear();
            for (const k of allKeys) if (k !== space) hiddenSpaces.add(k);
            render();
          },
        },
      });
    }
    return items;
  }

  actView.addEventListener("click", () => {
    if (phoneMode() || ownSpace()) return;
    openMenu(actView, buildViewItems, { stayOpen: true });
  });
  clearFilterBtn.addEventListener("click", () => {
    hiddenSpaces.clear();
    render();
  });

  // ---- Desktop zero-shift Delete mode & Shift+click × (§28) ----------------

  /** @param {boolean} next */
  function setDeleteMode(next) {
    if (phoneMode()) next = false;
    if (deleteMode === next) return;
    deleteMode = next;
    sidebar.classList.toggle("delete-mode", deleteMode);
    actDel.classList.toggle("active-danger", deleteMode);
    actDel.setAttribute("aria-pressed", String(deleteMode));
    deletePill.hidden = !deleteMode;
    render();
  }

  actDel.addEventListener("click", () => setDeleteMode(!deleteMode));
  deletePill.addEventListener("click", () => setDeleteMode(false));

  // Typing in the editor exits Delete mode immediately; cursor clicks and
  // selection changes (`docChanged === false`) must not, so clicking a note to
  // check its text before deleting stays in Delete mode.
  editorEvents.addEventListener("update", (event) => {
    if (deleteMode && /** @type {CustomEvent} */ (event).detail?.docChanged) {
      setDeleteMode(false);
    }
  });

  // Escape exits Delete mode unless a dialog, menu, settings overlay, search
  // field, or inline rename already owns Escape on screen.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Shift") document.body.classList.add("shift-held");
    if (event.key !== "Escape" || !deleteMode || event.defaultPrevented) return;
    if (renamingId || sidebar.classList.contains("searching")) return;
    if (document.querySelector("dialog[open], .menu")) return;
    const settingsPanel = document.getElementById("settings-panel");
    if (settingsPanel && !settingsPanel.hidden) return;
    event.preventDefault();
    setDeleteMode(false);
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Shift") document.body.classList.remove("shift-held");
  });
  window.addEventListener("blur", () => document.body.classList.remove("shift-held"));

  // ---- Bottom bar, shared drawer, and phone subview controls (§28) ---------

  /** @param {DrawerTarget} target */
  function toggleSection(target) {
    if (phoneMode()) {
      setPhoneView(sameTarget(phoneView, target) ? null : target);
      return;
    }
    openDrawer = sameTarget(openDrawer, target) ? null : target;
    render();
  }

  barRecent.addEventListener("click", () => toggleSection({ kind: "recent" }));
  barTrash.addEventListener("click", () => toggleSection({ kind: "trash" }));
  drawerClose.addEventListener("click", () => {
    openDrawer = null;
    render();
  });
  drawerOpenWin.addEventListener("click", () => {
    if (openDrawer?.kind === "space") run("workspace.openSpace", openDrawer.space);
  });
  phoneViewBack.addEventListener("click", () => setPhoneView(null));

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
    const li = document.querySelector(`.buffer-row[data-id="${CSS.escape(record.id)}"]`);
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
      // The chord table listens on window, so Alt+W here would close (or in
      // Delete mode trash) the buffer while its new name is still being typed.
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
   * Behind the PIN the row says "Locked note" (§27): the rename box would
   * start with that, and a blur would save it as the title. So the PIN first.
   * @param {BufferRecord} record
   */
  async function renameAfterPin(record) {
    if (store.isPinLocked(record.id) && !(await run("pin.unlock"))) return;
    startRename(store.get(record.id) ?? record);
  }

  // ---- Menus ---------------------------------------------------------------

  /**
   * The row menu (architecture.md §9, §28). Sync is a per-document server
   * target (§3); with no server configured the item is disabled and says where
   * to set one, rather than claiming to sync into nothing. Encrypt is for a
   * file on disk only (§19, §27): it renames the file to `.age`, so it is
   * disabled where the browser cannot rename a file. A synced note is
   * encrypted anyway.
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
        items.push({ label: "Rename file…", act: () => renameAfterPin(record) });
      }
      // The inverse of Save to disk (architecture.md §23), and the way out of
      // a file that is gone for good.
      items.push({
        label: "Unlink file",
        hint: "The note stays in vrtti, the file stays on disk",
        act: () => run("file.unlink", record.id),
      });
    } else {
      items.push({ label: "Rename…", act: () => renameAfterPin(record) });
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

    // Czech without diacritics (.work/mixed-spellcheck/plan.md). On a phone
    // this menu is the one place for the commands; from here they work on
    // the whole note. "(vllm)" only when the sync server has a model: the
    // labels say where the text goes, as the user asked.
    items.push({ separator: true });
    items.push({
      label: "Add diacritics (local)",
      act: () => run("diacritics.local", record.id),
    });
    if (sync?.hasModel) {
      items.push({
        label: "Add diacritics (vllm)",
        hint: "Sends the paragraphs to the model of your sync server",
        act: () => run("diacritics.model", record.id),
      });
    }

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
    // A row is either a tab of this window (closable) or closed in a drawer;
    // the record itself does not say which (architecture.md §14).
    items.push(
      closable
        ? { label: "Close", act: () => run("buffer.close", record.id) }
        : { label: "Reopen", act: () => open(() => run("buffer.reopen", record.id)) }
    );

    // Explicit delete / remove action (§28). Files on disk are never deleted;
    // when `file.unwritten` is true, IndexedDB holds the only copy of unsaved
    // text, so removal stays disabled until reconnected or unlinked.
    if (record.kind === "file" && record.file) {
      items.push(
        record.file.unwritten
          ? {
              label: "Remove from list",
              danger: true,
              disabled: true,
              hint: "Unsaved text is not on disk; reconnect or Unlink file first",
            }
          : {
              label: "Remove from list",
              danger: true,
              hint: "File stays on disk",
              act: () => run("doc.trash", record.id),
            }
      );
    } else {
      items.push({
        label: "Move to trash",
        danger: true,
        hint: record.sync?.space
          ? "Deletes in " + record.sync.space + " · 30-day Trash on this device"
          : "Keeps in Trash for 30 days",
        act: () => run("doc.trash", record.id),
      });
    }
    return items;
  }

  /** @param {RemoteStub} stub @returns {import("./menu.js").MenuItem[]} */
  function stubMenu(stub) {
    return [
      { label: "Open", act: () => open(() => run("remote.open", stub.id)) },
      { separator: true },
      {
        label: "Move to trash",
        danger: true,
        hint: "Deletes in " + stub.space + " · 30-day Trash on this device",
        act: () => run("remote.trash", stub.id),
      },
    ];
  }

  /** @param {BufferRecord} record @returns {import("./menu.js").MenuItem[]} */
  function trashMenu(record) {
    /** @type {import("./menu.js").MenuItem[]} */
    const items = [];
    const space = record.originSpace;
    const canRestoreSpace = Boolean(space && sync?.isMine(space));
    if (canRestoreSpace && space) {
      items.push({
        label: "Restore to " + space,
        swatch: sync?.colorOf(space) || undefined,
        hint: "Opens in " + space + " and syncs to its devices",
        act: () => open(() => run("doc.restore", { id: record.id, toSpace: true })),
      });
      items.push({
        label: "Restore as local",
        hint: "Moves to Recent on this device only",
        act: () => run("doc.restore", { id: record.id, toSpace: false }),
      });
    } else {
      items.push({
        label: "Restore",
        hint: "Moves to Recent on this device",
        act: () => run("doc.restore", { id: record.id, toSpace: false }),
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Delete permanently",
      danger: true,
      hint: "Cannot be undone",
      act: () => run("doc.deleteForever", record.id),
    });
    return items;
  }

  /**
   * "Sync to <space>" for an unsynced note, the New notes space first (§27),
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
            swatch: sync.colorOf(name) || undefined,
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
    if (!mine.length) {
      return [{ label: "Sync", disabled: true, hint: "Make a space in Settings › Spaces first" }];
    }
    // The New notes space first; with Local only, no space is first (§27).
    const first = sync.defaultSpace();
    return [...(first ? [first] : []), ...mine.filter((name) => name !== first)].map((name) => ({
      label: "Sync to " + name,
      swatch: sync.colorOf(name) || undefined,
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
   * row's ⋯, ×, trash, or restore button bubbles here too, and must not also
   * open the row.
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

  // ---- Phone-only visible preview warming & row builders (C3) ---------------

  /**
   * Observe encrypted rows in the phone note list and decode previews only for
   * rows intersecting `#sidebar-scroll` while the phone list is actually open.
   * Desktop never shows `.buffer-preview` or `.buffer-time`, and `onPhoneModeChange`
   * calls `render()` whenever the layout switches.
   */
  const previewObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (!phoneListOpen()) return;
            /** @type {string[]} */
            const visibleIds = [];
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const id = /** @type {HTMLElement} */ (entry.target).dataset.id;
              if (id) visibleIds.push(id);
            }
            if (visibleIds.length > 0) void store.warmPreviewsFor(visibleIds);
          },
          { root: sidebarScroll, rootMargin: "120px 0px" }
        )
      : null;

  function scheduleVisiblePreviews() {
    if (!phoneListOpen()) return;
    requestAnimationFrame(() => {
      if (!phoneListOpen()) return;
      const box = sidebarScroll.getBoundingClientRect();
      if (box.height <= 0) return;
      const list = phoneView ? phoneViewList : openList;
      /** @type {string[]} */
      const ids = [];
      for (const el of list.children) {
        if (!(el instanceof HTMLElement)) continue;
        const id = el.dataset.id;
        if (!id || el.querySelector(".buffer-preview")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom >= box.top - 120 && rect.top <= box.bottom + 120) ids.push(id);
      }
      if (ids.length > 0) void store.warmPreviewsFor(ids);
    });
  }

  /** @param {HTMLElement} li @param {BufferRecord} record @param {string} titleText */
  function syncPhoneRowPreview(li, record, titleText) {
    const head = store.loadedPreviewHead(record.id);
    const preview = head === undefined ? "" : previewOf(head, titleText);
    const existing = li.querySelector(".buffer-preview");
    if (preview) {
      if (existing) {
        if (existing.textContent !== preview) existing.textContent = preview;
      } else {
        const span = document.createElement("span");
        span.className = "buffer-preview";
        span.textContent = preview;
        li.appendChild(span);
      }
      previewObserver?.unobserve(li);
    } else {
      existing?.remove();
      if (record.enc && head === undefined && !store.isPinLocked(record.id)) {
        previewObserver?.observe(li);
      }
    }
  }

  /** @param {BufferRecord} record @param {{closable: boolean, showRecentAge?: boolean}} opts */
  function makeRow(record, { closable, showRecentAge = false }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    keyboardRow(li);
    // The rename box finds its row by this id, after the menu that asked for
    // it is already gone.
    li.dataset.id = record.id;
    if (closable && record.id === store.activeId) li.classList.add("active");

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
      // The shell has its own words for the first cause: a reconnect there is
      // a fresh pick, never a grant (architecture.md §17). "Needs permission"
      // sent a user to look for a permission that does not exist.
      warn.title = record.file?.unwritten
        ? "The last write to this file failed. Click to try again."
        : isDesktop
          ? "vrtti cannot reach this file. Click to pick it again."
          : "This file needs permission again. Click to reconnect.";
      warn.addEventListener("click", (event) => {
        // The click itself is the user gesture requestPermission needs; a
        // background retry can never get the grant.
        event.stopPropagation();
        run("file.reconnect", record.id);
      });
      li.appendChild(warn);
    }

    if (showRecentAge && !record.file?.unwritten && record.closedAt !== undefined) {
      const left = daysLeft(record.closedAt, RECENT_KEEP);
      if (left <= 7) {
        const age = document.createElement("span");
        age.className = "buffer-age soon";
        age.textContent = left + "d";
        age.title = left + "d left in Recent";
        li.appendChild(age);
      }
    }

    // Only build `.buffer-time` and `.buffer-preview` in phone mode: desktop CSS
    // hides both (`display: none`), and `onPhoneModeChange` calls `render()`
    // whenever a window enters or leaves `html.phone`.
    const isPhone = phoneMode();
    if (isPhone) {
      const time = document.createElement("span");
      time.className = "buffer-time";
      time.textContent = shortTime(record.updatedAt);
      li.appendChild(time);
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
      if (deleteMode) {
        const trashBtn = document.createElement("button");
        trashBtn.className = "buffer-trash";
        trashBtn.type = "button";
        trashBtn.appendChild(makeTrashIcon());
        trashBtn.title =
          record.kind === "file"
            ? record.file?.unwritten
              ? "Unsaved text is not on disk; reconnect or Unlink file first"
              : "Remove from list (file stays on disk)"
            : "Move to trash (Alt+W)";
        trashBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          run("doc.trash", record.id);
        });
        li.appendChild(trashBtn);
      } else {
        const close = document.createElement("button");
        close.className = "buffer-close";
        close.type = "button";
        close.textContent = "×";
        close.title =
          record.kind === "file"
            ? "Close (Alt+W · Shift+click to remove from list)"
            : "Close (Alt+W · Shift+click to move to trash)";
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          run(event.shiftKey ? "doc.trash" : "buffer.close", record.id);
        });
        li.appendChild(close);
      }
    } else {
      // Closed rows in Recent / space drawers have no ×, so a hover trash
      // button gives desktop 1-click cleanup (§28). Hidden in phone mode.
      const trashBtn = document.createElement("button");
      trashBtn.className = "buffer-trash";
      trashBtn.type = "button";
      trashBtn.appendChild(makeTrashIcon());
      trashBtn.title =
        record.kind === "file"
          ? record.file?.unwritten
            ? "Unsaved text is not on disk; reconnect or Unlink file first"
            : "Remove from list (file stays on disk)"
          : "Move to trash";
      trashBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        run("doc.trash", record.id);
      });
      li.appendChild(trashBtn);
    }

    if (isPhone) {
      syncPhoneRowPreview(li, record, titleText);
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
   * Unopened Titles-only stub row (§25, §28). Its own builder, not a mode of
   * makeRow: a stub has no BufferRecord in IndexedDB. PIN-locked stubs without
   * an explicit user title show 🔒 and "Locked note" (never a first line).
   * @param {RemoteStub} stub
   */
  function makeStubRow(stub) {
    const li = document.createElement("li");
    li.className = "buffer-row stub-row";
    keyboardRow(li);
    li.dataset.id = stub.id;
    li.title = stub.space + " · on the server. Click to open it here.";
    spaceBar(li, stub.space);

    if (stub.pin) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "🔒";
      mark.title = "Locked with the PIN";
      li.appendChild(mark);
    }

    const title = document.createElement("span");
    title.className = "buffer-title";
    // A title this device could not open yet (locked) or a PIN-locked stub
    // without an explicit user title never shows a first line (§27, §28).
    title.textContent = stub.title || (stub.pin ? "Locked note" : stub.enc ? "encrypted" : "untitled");
    li.appendChild(title);

    // Phone Mode B marks unopened server stubs with a quiet "server" tag;
    // app.css hides `.buffer-tag` outside `html.phone`.
    const tag = document.createElement("span");
    tag.className = "buffer-tag";
    tag.textContent = "server";
    li.appendChild(tag);

    const more = document.createElement("button");
    more.className = "buffer-more";
    more.type = "button";
    more.textContent = "⋯";
    more.title = "More";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(more, stubMenu(stub));
    });
    li.appendChild(more);

    const trashBtn = document.createElement("button");
    trashBtn.className = "buffer-trash";
    trashBtn.type = "button";
    trashBtn.appendChild(makeTrashIcon());
    trashBtn.title = "Move to trash";
    trashBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      run("remote.trash", stub.id);
    });
    li.appendChild(trashBtn);

    li.addEventListener("click", () => open(() => run("remote.open", stub.id)));
    return li;
  }

  /**
   * Trashed note row (§28). No read-only editor preview: clicking the row
   * opens its restore/delete menu; desktop hover also offers a 1-click ↩ button.
   * @param {BufferRecord} record
   */
  function makeTrashRow(record) {
    const li = document.createElement("li");
    li.className = "buffer-row trash-row";
    keyboardRow(li);
    li.dataset.id = record.id;

    const originSpace = record.originSpace;
    const canRestoreSpace = Boolean(originSpace && sync?.isMine(originSpace));
    if (originSpace) spaceBar(li, originSpace);

    const left = daysLeft(record.trashedAt ?? record.updatedAt, TRASH_KEEP);
    li.title = (originSpace ? originSpace + " · " : "") + left + "d left in Trash";

    if (record.pin) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "🔒";
      mark.title = "Locked with the PIN";
      li.appendChild(mark);
    }

    const title = document.createElement("span");
    title.className = "buffer-title";
    title.textContent = titleOf(record);
    li.appendChild(title);

    const age = document.createElement("span");
    age.className = left <= 5 ? "buffer-age soon" : "buffer-age";
    age.textContent = left + "d";
    li.appendChild(age);

    const time = document.createElement("span");
    time.className = left <= 5 ? "buffer-time soon" : "buffer-time";
    time.textContent = left + "d left";
    li.appendChild(time);

    const more = document.createElement("button");
    more.className = "buffer-more";
    more.type = "button";
    more.textContent = "⋯";
    more.title = "More";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(more, trashMenu(record));
    });
    li.appendChild(more);

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "buffer-restore";
    restoreBtn.type = "button";
    restoreBtn.appendChild(makeRestoreIcon());
    restoreBtn.title = canRestoreSpace && originSpace ? "Restore to " + originSpace : "Restore";
    restoreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (canRestoreSpace) open(() => run("doc.restore", { id: record.id, toSpace: true }));
      else run("doc.restore", { id: record.id, toSpace: false });
    });
    li.appendChild(restoreBtn);

    // Anchor to `more` when visible on screen, else to `li` (keyboard Enter on
    // an unhovered desktop row hides `more` via `display: none`).
    li.addEventListener("click", () => {
      openMenu(more.offsetParent ? more : li, trashMenu(record));
    });
    return li;
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
  /** @type {{ li: HTMLElement, id: string, startY: number, moved: boolean, beforeId: string | null | undefined, rows?: HTMLElement[], mids?: number[], from?: number } | null} */
  let drag = null;
  // True from the drop until the click that follows it has been swallowed.
  let dropped = false;
  // A press turns into a drag after this many pixels: a click wobbles less.
  const DRAG_SLOP = 4;

  openList.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0 || event.pointerType === "touch") return;
    const target = /** @type {HTMLElement} */ (event.target);
    // A press on ⋯, ×, the trash button, or the rename box is theirs, not a drag.
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
      // Snapshot row midpoints once at drag start so pointermove never forces
      // synchronous layout across hundreds of open rows (M2).
      const rows = /** @type {HTMLElement[]} */ ([...openList.children]);
      drag.rows = rows;
      drag.from = rows.indexOf(drag.li);
      drag.scrollTop = sidebarScroll.scrollTop;
      drag.mids = rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
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
    if (!drag || !drag.rows || !drag.mids || drag.from === undefined) return;
    const { rows, mids, from } = drag;
    // Offset by any `#sidebar-scroll` delta since drag start so wheel-scrolling
    // during a drag maps `y` to the current row positions without reflowing DOM.
    const adjustedY = y + (sidebarScroll.scrollTop - (drag.scrollTop ?? 0));
    for (const row of rows) row.classList.remove("drop-before", "drop-after");
    let index = rows.length;
    for (let i = 0; i < mids.length; i++) {
      if (adjustedY < mids[i]) {
        index = i;
        break;
      }
    }
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
  // note (strictly Close only, never Move to trash; §28): one move of the
  // thumb where the row menu takes two taps. Touch only, so it shares nothing
  // with the drag above, which ignores touch.
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
  // Distance only, never speed: a quick flick must not close a note.
  const SWIPE_CLOSE = 1 / 3;
  // The close, in two steps: the content slides off to the left, then the
  // row folds away and the rows below move up. Milliseconds.
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
      // The shell picks the folder again and grants nothing (see the file
      // marker above for the reason of the two texts).
      warn.title = isDesktop
        ? "vrtti cannot reach this folder. Click to pick it again."
        : "This folder needs permission again. Click to reconnect.";
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

  // ---- Focus & scroll helpers ----------------------------------------------

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
   * The order of the Open list. On a PC it is the tab order, which the user
   * sets by drag. In phone mode it is the time of the last change, oldest at
   * the top and newest at the bottom, as in a chat with yourself (user
   * decision, 2026-11-19): the newest note sits next to the thumb button.
   * The phone has no drag (it ignores touch), so it loses no order the user
   * made there, and the tab order stays untouched for the PC.
   *
   * The time is updatedAt: an edit, a sync that brings a change, and a
   * reopen from Recent move a note to the bottom; a switch between notes
   * does not. sort is stable, so notes with the same time keep the tab order.
   *
   * @param {BufferRecord[]} open
   */
  function openOrder(open) {
    if (!phoneMode()) return open;
    return [...open].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  }

  /**
   * Collect all non-empty space sections (closed local copies + server stubs).
   * Empty spaces hide from the bottom bar (§28).
   */
  function collectSpaceSections() {
    const allStubs = store.remotes();
    /** @type {string[]} */
    const names = [];
    for (const s of sync?.mySpaces() ?? []) if (!names.includes(s)) names.push(s);
    for (const stub of allStubs) if (!names.includes(stub.space)) names.push(stub.space);
    for (const b of store.closedBuffers()) {
      const s = b.sync?.space;
      if (s && !names.includes(s)) names.push(s);
    }

    /** @type {{ space: string, closed: BufferRecord[], stubs: RemoteStub[], count: number }[]} */
    const sections = [];
    for (const space of names) {
      const closed = store.closedSpaceBuffers(space);
      const stubs = allStubs.filter((s) => s.space === space);
      const count = closed.length + stubs.length;
      if (count > 0) sections.push({ space, closed, stubs, count });
    }
    return sections;
  }

  /**
   * Build combined rows for one space drawer or phone space view, newest first.
   * @param {{ closed: BufferRecord[], stubs: RemoteStub[] }} sec
   */
  function spaceSectionRows(sec) {
    /** @type {({ kind: "buf", updatedAt: number, record: BufferRecord } | { kind: "stub", updatedAt: number, stub: RemoteStub })[]} */
    const entries = [
      ...sec.closed.map((record) => ({ kind: /** @type {"buf"} */ ("buf"), updatedAt: record.updatedAt || 0, record })),
      ...sec.stubs.map((stub) => ({ kind: /** @type {"stub"} */ ("stub"), updatedAt: stub.updatedAt || 0, stub })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
    return entries.map((e) =>
      e.kind === "buf" ? makeRow(e.record, { closable: false }) : makeStubRow(e.stub)
    );
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
    previewObserver?.disconnect();
    const focused = focusedRow();
    const isPhone = phoneMode();
    const wsSpace = ownSpace();

    // Space Window banner and button adaptation (§28).
    if (wsSpace && !isPhone) {
      spaceBanner.hidden = false;
      spaceBannerName.textContent = wsSpace;
      const color = sync?.colorOf(wsSpace) || "";
      if (color) spaceBanner.style.setProperty("--space-win-color", color);
      else spaceBanner.style.removeProperty("--space-win-color");
      actView.hidden = true;
      newButton.title = "New note in " + wsSpace + " (Alt+N)";
    } else {
      spaceBanner.hidden = true;
      actView.hidden = false;
      newButton.title = "New buffer (Alt+N)";
    }

    // Open list + desktop View space filter.
    const allOpen = store.openBuffers();
    const filtered = !isPhone && !wsSpace && hiddenSpaces.size > 0;
    const visibleOpen = filtered ? allOpen.filter(matchesFilter) : allOpen;
    actView.classList.toggle("active-accent", filtered);
    openFilterPill.hidden = !filtered;
    if (filtered) openFilterPill.textContent = "(" + visibleOpen.length + "/" + allOpen.length + ")";
    openEmpty.hidden = !(filtered && allOpen.length > 0 && visibleOpen.length === 0);

    openList.replaceChildren(
      ...openOrder(visibleOpen).map((b) => makeRow(b, { closable: true }))
    );

    // Bottom bar sections: Recent (local only), non-empty spaces, Trash.
    const recent = store.recentBuffers();
    const spaceSections = collectSpaceSections();
    const trashed = store.trashed();

    // Auto-close active drawer or phone subview if its section emptied.
    if (
      (openDrawer?.kind === "recent" && recent.length === 0) ||
      (openDrawer?.kind === "trash" && trashed.length === 0) ||
      (openDrawer?.kind === "space" && !spaceSections.some((s) => s.space === openDrawer?.space))
    ) {
      openDrawer = null;
    }
    if (
      (phoneView?.kind === "recent" && recent.length === 0) ||
      (phoneView?.kind === "trash" && trashed.length === 0) ||
      (phoneView?.kind === "space" && !spaceSections.some((s) => s.space === phoneView?.space))
    ) {
      setPhoneView(null, { redraw: false });
    }

    const activeSection = isPhone ? phoneView : openDrawer;

    // Bottom icon bar.
    barRecent.hidden = recent.length === 0;
    barRecent.title = "Recent (" + recent.length + ")";
    barRecent.style.setProperty("--btn-accent", "var(--st-caret)");
    barRecent.classList.toggle("active", activeSection?.kind === "recent");
    barRecentCount.textContent = String(recent.length);

    barTrash.hidden = trashed.length === 0;
    barTrash.title = "Deleted notes (" + trashed.length + ")";
    barTrash.style.setProperty("--btn-accent", "var(--st-danger)");
    barTrash.classList.toggle("active", activeSection?.kind === "trash");
    barTrashCount.textContent = String(trashed.length);

    barSpaces.replaceChildren(
      ...spaceSections.map((sec) => {
        const btn = document.createElement("button");
        btn.className = "bar-btn";
        btn.type = "button";
        btn.dataset.space = sec.space;
        const color = sync?.colorOf(sec.space) || "var(--st-caret)";
        btn.style.setProperty("--btn-accent", color);
        btn.title = sec.space + " (" + sec.count + ")";
        btn.setAttribute("aria-label", sec.space + " (" + sec.count + ")");
        if (activeSection?.kind === "space" && activeSection.space === sec.space) {
          btn.classList.add("active");
        }
        const badge = document.createElement("span");
        badge.className = "space-badge";
        badge.textContent = spaceBadge(sec.space);
        const count = document.createElement("span");
        count.className = "bar-count";
        count.textContent = String(sec.count);
        btn.append(badge, count);
        btn.addEventListener("click", () => toggleSection({ kind: "space", space: sec.space }));
        return btn;
      })
    );

    const hasLeft = recent.length > 0 || spaceSections.length > 0;
    const hasRight = isPhone ? trashed.length > 0 : true;
    barSepLeft.hidden = !(recent.length > 0 && spaceSections.length > 0);
    barSepRight.hidden = !(hasLeft && hasRight);
    bottomBar.classList.toggle(
      "phone-empty",
      isPhone && recent.length === 0 && spaceSections.length === 0 && trashed.length === 0
    );

    // Desktop shared expandable drawer.
    if (!isPhone && openDrawer) {
      bottomDrawer.hidden = false;
      if (openDrawer.kind === "recent") {
        bottomDrawer.style.setProperty("--drawer-accent", "var(--st-caret)");
        drawerDot.hidden = true;
        drawerTitle.textContent = "Recent (" + recent.length + ")";
        drawerSub.hidden = false;
        drawerSub.textContent = "30d";
        drawerOpenWin.hidden = true;
        drawerList.replaceChildren(
          ...recent.map((b) => makeRow(b, { closable: false, showRecentAge: true }))
        );
      } else if (openDrawer.kind === "trash") {
        bottomDrawer.style.setProperty("--drawer-accent", "var(--st-danger)");
        drawerDot.hidden = true;
        drawerTitle.textContent = "Deleted notes (" + trashed.length + ")";
        drawerSub.hidden = false;
        drawerSub.textContent = "30d";
        drawerOpenWin.hidden = true;
        drawerList.replaceChildren(...trashed.map(makeTrashRow));
      } else {
        const sec = spaceSections.find((s) => s.space === openDrawer?.space);
        if (sec) {
          const color = sync?.colorOf(sec.space) || "var(--st-caret)";
          bottomDrawer.style.setProperty("--drawer-accent", color);
          drawerDot.hidden = false;
          drawerTitle.textContent = sec.space + " (" + sec.count + ")";
          drawerSub.hidden = true;
          drawerOpenWin.hidden = false;
          drawerOpenWin.title = "Open " + sec.space + " in new window";
          drawerList.replaceChildren(...spaceSectionRows(sec));
        }
      }
    } else {
      bottomDrawer.hidden = true;
      drawerList.replaceChildren();
    }

    // Phone Mode B full-screen subview inside #sidebar-scroll.
    const showPhoneView = Boolean(isPhone && phoneView);
    sidebar.classList.toggle("phone-subview", showPhoneView);
    phoneViewEl.hidden = !showPhoneView;
    if (showPhoneView && phoneView) {
      if (phoneView.kind === "recent") {
        phoneViewDot.hidden = true;
        phoneViewTitle.textContent = "Recent (" + recent.length + ")";
        phoneViewList.replaceChildren(
          ...recent.map((b) => makeRow(b, { closable: false }))
        );
      } else if (phoneView.kind === "trash") {
        phoneViewDot.hidden = true;
        phoneViewTitle.textContent = "Deleted notes (" + trashed.length + ")";
        phoneViewList.replaceChildren(...trashed.map(makeTrashRow));
      } else {
        const sec = spaceSections.find((s) => s.space === phoneView?.space);
        if (sec) {
          const color = sync?.colorOf(sec.space) || "var(--st-caret)";
          phoneViewDot.hidden = false;
          phoneViewDot.style.setProperty("--drawer-accent", color);
          phoneViewTitle.textContent = sec.space + " (" + sec.count + ")";
          phoneViewList.replaceChildren(...spaceSectionRows(sec));
        }
      }
    } else {
      phoneViewList.replaceChildren();
    }

    refocusRow(focused);
    if (reveal) revealActive();
    if (isPhone && phoneListOpen()) scheduleVisiblePreviews();
  }

  /**
   * Patch only the edited buffer's row in `openList` on `"buffer-edit"` so
   * keystrokes never rebuild hundreds of open and drawer rows (C1).
   * @param {string | undefined} id
   */
  function patchEditedRow(id) {
    if (!id || renamingId || drag) return;
    if (swipe?.active || leaving > 0) {
      redrawOwed = true;
      return;
    }
    const record = store.get(id);
    if (!record) return;
    const li = openList.querySelector(`li.buffer-row[data-id="${CSS.escape(id)}"]`);
    if (!(li instanceof HTMLElement)) return;
    const titleText = titleOf(record);
    const titleEl = li.querySelector(".buffer-title");
    if (titleEl && titleEl.textContent !== titleText) titleEl.textContent = titleText;
    if (phoneMode()) {
      const timeEl = li.querySelector(".buffer-time");
      const nextTime = shortTime(record.updatedAt);
      if (timeEl && timeEl.textContent !== nextTime) timeEl.textContent = nextTime;
      syncPhoneRowPreview(li, record, titleText);
      // Phone mode sorts Open oldest -> newest by `updatedAt`, so an edit moves
      // the row to the bottom without rebuilding the rest of the list.
      if (openList.lastElementChild !== li) openList.appendChild(li);
    }
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
      if (deleteMode) {
        event.preventDefault();
        setDeleteMode(false);
        return;
      }
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
  store.events.addEventListener("buffer-edit", (event) => {
    patchEditedRow(/** @type {CustomEvent} */ (event).detail?.id);
  });
  store.events.addEventListener("previews", (event) => {
    if (!phoneMode()) return;
    const ids = /** @type {CustomEvent} */ (event).detail?.ids ?? [];
    for (const id of ids) {
      const record = store.get(id);
      if (!record) continue;
      const titleText = titleOf(record);
      for (const li of sidebar.querySelectorAll(`li.buffer-row[data-id="${CSS.escape(id)}"]`)) {
        if (li instanceof HTMLElement) syncPhoneRowPreview(li, record, titleText);
      }
    }
  });
  store.events.addEventListener("unlock", () => {
    if (phoneListOpen()) scheduleVisiblePreviews();
  });
  store.events.addEventListener("active", () => render({ reveal: true }));
  // The order of Open depends on the mode (openOrder), and a phone turned on
  // its side can leave it with no store event to redraw the list.
  onPhoneModeChange((phone) => {
    setPhoneView(null, { redraw: false });
    if (phone) setDeleteMode(false);
    else openDrawer = null;
    render();
  });
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

  return {
    isDeleteMode: () => deleteMode,
    exitDeleteMode: () => setDeleteMode(false),
    unhideFor,
  };
}
