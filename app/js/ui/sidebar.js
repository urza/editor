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
import { hasDisk } from "../model/capabilities.js";
import { daysLeft, RECENT_KEEP, spaceBadge, TRASH_KEEP } from "../model/lifecycle.js";
import { isNativeHandle } from "../storage/native.js";
import { register, run } from "../commands/registry.js";
import { editorEvents } from "../editor/editor.js";
import { openMenu } from "./menu.js";
import { onPhoneModeChange, phoneMode, watchBack } from "./shell.js";

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
   * closing settings hands focus back to where it was taken from (the
   * Settings button, say), and closing the phone note list first lets the
   * editor see it is visible so it takes focus and prompts for PIN/unlock
   * when needed. `sidebar.autoclose` is a no-op on a PC.
   * @param {() => unknown} act
   */
  function open(act) {
    // Drop any phone subview watcher before closing the note list so Back
    // does not stay armed on an invisible subview.
    setPhoneView(null, { redraw: false });
    run("settings.close");
    run("sidebar.autoclose");
    act();
  }

  // If the phone note list closes via the thumb button or Escape while a
  // subview is active, return the list to Open and disarm its Back watcher.
  new MutationObserver(() => {
    if (phoneView && !app.classList.contains("sidebar-open")) {
      setPhoneView(null);
    }
  }).observe(app, { attributes: true, attributeFilter: ["class"] });

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => open(() => run("buffer.new")));

  // Pinned inside #bottom-bar (desktop only; phone uses the thumb menu).
  barSettings.addEventListener("click", () => {
    // The drawer sits above the settings panel on narrow desktop, so close it first.
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

  // Typing in the editor exits Delete mode immediately; cursor clicks alone do not.
  editorEvents.addEventListener("update", (event) => {
    if (deleteMode && /** @type {CustomEvent} */ (event).detail?.docChanged) {
      setDeleteMode(false);
    }
  });

  // Escape exits Delete mode unless a dialog, menu, settings, search, or rename owns it.
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
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);

    let done = false;
    /** @param {boolean} commit */
    function finish(commit) {
      if (done) return;
      done = true;
      renamingId = null;
      const name = input.value;
      render();
      if (commit) run("buffer.rename", { id: record.id, name });
    }

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
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
   * @param {BufferRecord} record @param {{closable: boolean}} opts
   * @returns {import("./menu.js").MenuItem[]}
   */
  function rowMenu(record, { closable }) {
    /** @type {import("./menu.js").MenuItem[]} */
    const items = [];

    if (record.kind === "file" && record.file) {
      if (store.canRenameFile(record)) {
        items.push({ label: "Rename file…", act: () => renameAfterPin(record) });
      }
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

    items.push({ label: "Copy text", act: () => run("doc.copy", record.id) });

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
    if (record.sync && sync?.isConfigured) {
      items.push({ label: "History…", act: () => run("doc.history", record.id) });
    }
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
    items.push(
      closable
        ? { label: "Close", act: () => run("buffer.close", record.id) }
        : { label: "Reopen", act: () => open(() => run("buffer.reopen", record.id)) }
    );

    // Explicit delete / remove action (§28). Files on disk are never deleted;
    // unwritten file text blocks removal until reconnected or unlinked.
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
      return [{ label: "Sync", disabled: true, hint: "Make a space in Settings › Devices first" }];
    }
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
    li.style.setProperty("--space-color", color);
  }

  /**
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

  // ---- Row builders --------------------------------------------------------

  /** @param {BufferRecord} record @param {{closable: boolean, showRecentAge?: boolean}} opts */
  function makeRow(record, { closable, showRecentAge = false }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    keyboardRow(li);
    li.dataset.id = record.id;
    if (closable && record.id === store.activeId) li.classList.add("active");

    /** @type {string[]} */
    const hover = [];
    if (record.sync?.space) {
      const from = originName(record);
      hover.push(record.sync.space + (from ? " · from " + from : ""));
      spaceBar(li, record.sync.space);
    }
    if (record.kind === "file" && record.file) hover.push("On disk: " + store.diskPath(record));
    if (hover.length) li.title = hover.join("\n");

    if (record.kind === "file" && record.file) {
      const mark = document.createElement("span");
      mark.className = "buffer-mark";
      mark.textContent = "⛁";
      mark.title = "On disk: " + store.diskPath(record);
      li.appendChild(mark);
    }

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
      warn.title = record.file?.unwritten
        ? "The last write to this file failed. Click to try again."
        : "This file needs permission again. Click to reconnect.";
      warn.addEventListener("click", (event) => {
        event.stopPropagation();
        run("file.reconnect", record.id);
      });
      li.appendChild(warn);
    }

    if (showRecentAge && !record.file?.unwritten) {
      const left = daysLeft(record.closedAt ?? record.updatedAt, RECENT_KEEP);
      if (left <= 7) {
        const age = document.createElement("span");
        age.className = "buffer-age soon";
        age.textContent = left + "d";
        age.title = left + "d left in Recent";
        li.appendChild(age);
      }
    }

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

    const text = store.loadedText(record.id);
    const preview = text === undefined ? "" : previewOf(text, titleText);
    if (preview) {
      const span = document.createElement("span");
      span.className = "buffer-preview";
      span.textContent = preview;
      li.appendChild(span);
    }

    li.addEventListener("click", () => {
      if (dropped) return;
      open(() => run(closable ? "buffer.activate" : "buffer.reopen", record.id));
    });
    return li;
  }

  /**
   * Unopened Titles-only stub row (§25, §28). PIN-locked stubs without an
   * explicit user title show 🔒 and "Locked note" (never a first line).
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
    title.textContent = stub.title || (stub.pin ? "Locked note" : stub.enc ? "encrypted" : "untitled");
    li.appendChild(title);

    // Phone Mode B marks unopened server stubs with a quiet "server" tag.
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
    li.title =
      (originSpace ? originSpace + " · " : "") +
      left +
      "d left in Trash";

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

    li.addEventListener("click", () => {
      openMenu(more.offsetParent ? more : li, trashMenu(record));
    });
    return li;
  }

  // ---- Reorder by drag (architecture.md §9, Manual order) -----------------

  /** @type {{ li: HTMLElement, id: string, startY: number, moved: boolean, beforeId: string | null | undefined } | null} */
  let drag = null;
  let dropped = false;
  const DRAG_SLOP = 4;

  openList.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0 || event.pointerType === "touch") return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest("button, input")) return;
    const li = target.closest(".buffer-row");
    if (!(li instanceof HTMLElement) || !li.dataset.id || !li.parentElement) return;
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
    dropped = true;
    setTimeout(() => (dropped = false), 0);
    event.preventDefault();
    if (beforeId !== undefined) run("buffer.move", { id, before: beforeId });
  });
  openList.addEventListener("pointercancel", endDrag);

  /** @param {number} y */
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
    if (moved) render();
  }

  // ---- Swipe to close (architecture.md §9, Phone mode) ---------------------
  // Strictly Close only on Open rows; never moves notes to Trash (§28).

  /** @type {{ li: HTMLElement, id: string, pointerId: number, startX: number, startY: number, width: number, active: boolean } | null} */
  let swipe = null;
  let leaving = 0;
  let redrawOwed = false;
  const ARMED = "swipe-armed";
  const SWIPE_SLOP = 10;
  const SWIPE_CLOSE = 1 / 3;
  const SWIPE_OUT = 200;
  const SWIPE_FOLD = 200;

  openList.addEventListener("pointerdown", (event) => {
    if (swipe || event.pointerType !== "touch" || !event.isPrimary || !phoneMode()) return;
    const target = /** @type {HTMLElement} */ (event.target);
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
      if (!swipe.li.isConnected) {
        swipe = null;
        return;
      }
      if (dx > -SWIPE_SLOP || -dx < Math.abs(event.clientY - swipe.startY)) return;
      swipe.active = true;
      swipe.width = swipe.li.offsetWidth;
      swipe.li.classList.add("swiping");
    }
    const moved = Math.min(0, dx);
    swipe.li.style.setProperty("--swipe", moved + "px");
    swipe.li.classList.toggle(ARMED, -moved >= swipe.width * SWIPE_CLOSE);
  });

  openList.addEventListener("pointerup", (event) => {
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const { id, li } = swipe;
    const close = li.classList.contains(ARMED);
    if (close && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      swipeOut();
      return;
    }
    endSwipe();
    if (close) run("buffer.close", id);
  });

  function swipeOut() {
    if (!swipe) return;
    const { li, id, width } = swipe;
    swipe = null;
    leaving++;
    li.style.pointerEvents = "none";
    const from = li.style.getPropertyValue("--swipe");
    for (const child of li.children) {
      child.animate(
        { transform: [`translateX(${from})`, `translateX(${-width}px)`] },
        { duration: SWIPE_OUT, easing: "ease-in", fill: "forwards" }
      );
    }
    li.animate(
      {
        height: [li.offsetHeight + "px", "0px"],
        minHeight: "0px",
        paddingTop: "0px",
        paddingBottom: "0px",
      },
      { delay: SWIPE_OUT, duration: SWIPE_FOLD, easing: "ease-in-out", fill: "forwards" }
    );
    setTimeout(async () => {
      try {
        await run("buffer.close", id);
      } finally {
        leaving--;
        if (redrawOwed) render();
      }
    }, SWIPE_OUT + SWIPE_FOLD);
  }

  openList.addEventListener("pointercancel", (event) => {
    if (swipe && event.pointerId === swipe.pointerId) endSwipe();
  });

  function endSwipe() {
    if (!swipe) return;
    const { li, active } = swipe;
    swipe = null;
    if (!active) return;
    li.classList.remove("swiping", ARMED);
    li.style.removeProperty("--swipe");
    if (redrawOwed) render();
  }

  // ---- Folder sections (architecture.md §2, §9) ----------------------------

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
    li.style.paddingLeft = `calc(${10 + depth * 14}px * var(--ui-scale))`;
    li.dataset.path = entry.path;

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    twisty.textContent = isDir ? (expanded.has(key) ? "▾" : "▸") : "";
    li.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    li.appendChild(name);

    li.addEventListener("click", () => {
      if (!isDir) {
        const folderName = folders.folders.get(folderId)?.name ?? "";
        const path = folderName + "/" + entry.path;
        open(() => run("folder.openFile", { handle: entry.handle, path }));
        return;
      }
      if (expanded.has(key)) expanded.delete(key);
      else {
        expanded.add(key);
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
    if (!stale) addLevel(folder.id, "", 0, rows);
    tree.replaceChildren(...rows);
    section.appendChild(tree);
    return section;
  }

  function renderFolders() {
    if (!hasDisk) return;
    folderSections.replaceChildren(...folders.openFolders().map(folderSection));
  }

  // ---- Focus & scroll helpers ----------------------------------------------

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

  function revealActive() {
    const row = openList.querySelector("li.active");
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }

  /** @param {BufferRecord[]} open */
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

  /** @param {{reveal?: boolean}} [opts] */
  function render({ reveal = false } = {}) {
    if (renamingId || drag) return;
    if (swipe?.active || leaving > 0) {
      redrawOwed = true;
      return;
    }
    redrawOwed = false;
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
  }

  // Keyboard travel between rows.
  sidebar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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

  register({
    id: "sidebar.focus",
    title: "Focus sidebar",
    keys: "Ctrl+Digit0",
    run: () => {
      run("sidebar.show");
      const active = openList.querySelector("li.active");
      const target = active instanceof HTMLElement ? active : keyboardRows()[0] ?? newButton;
      target.focus();
    },
  });

  store.events.addEventListener("change", () => render());
  store.events.addEventListener("active", () => render({ reveal: true }));
  onPhoneModeChange((phone) => {
    setPhoneView(null, { redraw: false });
    if (phone) setDeleteMode(false);
    else openDrawer = null;
    render();
  });
  store.events.addEventListener("lock", () => {
    for (const el of sidebar.querySelectorAll(".buffer-preview")) el.remove();
    render();
  });
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
