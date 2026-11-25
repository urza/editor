// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

// First, before any other module runs: the log keeps what the app says,
// for "Copy the log" on a phone (model/log.js). Hoisted with the imports
// below, and that is fine: the modules only log from start() on.
import { installLog, logText } from "./model/log.js";
installLog();
import { BUILD } from "./version.js";

import {
  deleteBuffer,
  getAllHandles,
  getSetting,
  MAIN_WORKSPACE,
  openDb,
  putSetting,
} from "./storage/idb.js";
import { openFilePicker } from "./storage/fsa.js";
import { handleFromRoot, isNativeHandle, pruneRoots } from "./storage/native.js";
import {
  checkForUpdate,
  hasDisk,
  isDesktop,
  requestPersistence,
} from "./model/capabilities.js";
import { createDocStore, KEYRING_ID, titleOf } from "./model/docs.js";
import { createFolderStore } from "./model/folders.js";
import { on, post } from "./model/channel.js";
import { deviceId } from "./model/device.js";
import { createWorkspaces, workspaceIdFromUrl } from "./model/workspace.js";
import { register, run } from "./commands/registry.js";
import { createSyncClient } from "./sync/client.js";
import * as age from "./crypto/age.js";
import {
  KeyRing,
  keyringContentFor,
  mergeKeyringContent,
  readKeyringContent,
  storedKeysProblem,
  supportsStoredKeys,
} from "./crypto/keyring.js";
import { decodeInvite, encodeInvite, normalizeCode, PALETTE } from "./crypto/spaces.js";
import * as codec from "./model/codec.js";
import { mountEditor } from "./editor/editor.js";
import { mountTransforms } from "./editor/transform.js";
import { isEnabled, setEnabled, setQuickActions, setShared } from "./editor/spellcheck.js";
import { addWord, displayName, setRule } from "./model/spellsettings.js";
import { activeLangs, switchLang } from "./editor/mixed.js";
import { addDiacritics } from "./editor/adddiacritics.js";
import { detectLanguage, segments } from "./editor/textlang.js";
import {
  askConnect,
  askInvite,
  askPassphrase,
  askText,
  choose,
  showBusy,
  showInvite,
  showNote,
  showProgress,
  showSecret,
} from "./ui/dialog.js";
import { mountSearch } from "./ui/search.js";
import { mountSettings, newNotesGuidance } from "./ui/settings.js";
import { mountSidebar } from "./ui/sidebar.js";
import { mountStatusbar } from "./ui/statusbar.js";
import { mountTitle } from "./ui/title.js";
import { mountShortcuts } from "./ui/shortcuts.js";
import { closeWorkspaceWindow, mountDesktop, openWorkspaceWindow } from "./ui/desktop.js";
import { mountResizer } from "./ui/resizer.js";
import { mountShell, phoneMode } from "./ui/shell.js";
import { mountTextSize } from "./ui/textsize.js";
import { mountZoom } from "./ui/zoom.js";
import { mountWordWrap } from "./ui/wordwrap.js";
import { mountNewButton } from "./ui/newbutton.js";
import { mountThumb } from "./ui/thumb.js";
import { showHistory } from "./ui/history.js";
import { mountPin } from "./ui/pin.js";
import { fileNames, writeFiles } from "./model/backup.js";
import { openDirectoryPicker } from "./storage/fsa.js";

/** Wrong passphrases the unlock prompt tolerates before it gives up. */
const UNLOCK_ATTEMPTS = 3;
// The "New notes" dialog of buffer.new showed once (§27).
const NEW_NOTES_NOTICE_KEY = "notice.newNotes";

/**
 * A first guess at the device name, so the user usually just presses Enter.
 * `(pointer: coarse)` is the same test the sync default uses for "is this a
 * phone" (architecture.md §13.6).
 */
function defaultDeviceName() {
  return window.matchMedia("(pointer: coarse)").matches ? "Phone" : "Desktop";
}

async function start() {
  // First: it registers the two size commands and repairs what the inline
  // boot script in index.html put on :root. Nothing here waits on storage,
  // so it must not sit behind the openDb await below.
  mountTextSize();

  requestPersistence();
  await openDb();

  // Which window this is (architecture.md §14): `?ws=<id>` names a workspace,
  // no parameter is the main one. Before the stores, which scope by it.
  const workspaces = createWorkspaces({ id: workspaceIdFromUrl() });
  await workspaces.load();
  // Another window upgraded the schema, so it runs a newer build than this
  // one. The connection is already closed; the reload picks the build up.
  window.addEventListener("vrtti:db-versionchange", () => location.reload());

  // Before the store: the store takes the keyring as a dependency, because the
  // codec stage of its write pipeline encrypts and decrypts through it, and it
  // follows the keyring's lock state (architecture.md §5, §13.4).
  const keyring = new KeyRing();
  await keyring.load();

  // Declared here and assigned below: the store asks the sync client whether a
  // new document gets a server target, and the client needs the store. Only
  // store.create() calls that function, long after both objects exist.
  /** @type {ReturnType<typeof createSyncClient> | undefined} */
  let sync;
  const store = createDocStore({
    keyring,
    syncDefault: () => Boolean(sync && sync.syncDefaultOn()),
    // Same late binding as syncDefault (§25, §27). Only store.create() and a
    // pull ask, both long after the client exists.
    spaces: {
      defaultSpace: () => (sync ? sync.defaultSpace() : null),
      modeOf: (space) => (sync ? sync.modeOf(space) : undefined),
      recipients: (space) => (sync ? sync.recipients(space) : []),
      knownRecipients: () => (sync ? sync.knownRecipients() : []),
      logSeq: (space) => (sync ? sync.logSeq(space) : 0),
    },
    workspaces,
  });
  await store.load();

  sync = createSyncClient({ store, keyring });
  // Before store.start(): the first buffer of a fresh install is created there,
  // and whether it syncs depends on the setting this reads.
  await sync.load();

  // The keyring record lists the device entries, for names (§13.3, §27).
  function refreshPeers() {
    keyring.setContent(readKeyringContent(store.keyringRecord()));
  }
  refreshPeers();
  store.events.addEventListener("system", refreshPeers);

  // A window that does not run the schedule learns of a new member list
  // through the settings message (the logs row); its own tabs are its to
  // encrypt again (§27). The leader does it inside each sync round.
  sync.events.addEventListener("spaces", () => {
    if (!sync.isRunning) void store.reencryptStale();
  });

  /**
   * Write a new keyring content into the hidden record (architecture.md
   * §13.3). Dirty when synced, so the other devices learn of it.
   * @param {import("./crypto/keyring.js").KeyringContent} content
   */
  async function writeKeyring(content) {
    const previous = store.keyringRecord();
    const now = Date.now();
    /** @type {import("./storage/idb.js").BufferRecord} */
    const record = {
      id: KEYRING_ID,
      kind: "keyring",
      createdAt: now,
      ...previous,
      content: JSON.stringify(content),
      updatedAt: now,
    };
    if (record.sync) record.sync = { ...record.sync, dirty: true };
    await store.putSystemRecord(record);
  }

  /**
   * The record lists this device's entry, so the others can show its name
   * (§27). Only adds: a union never removes anyone else's entry.
   */
  async function ensureOwnEntry() {
    if (!keyring.ownEntry()) return;
    const current = readKeyringContent(store.keyringRecord());
    const next = mergeKeyringContent(keyringContentFor(keyring), current);
    if (JSON.stringify(next) !== JSON.stringify(mergeKeyringContent(null, current))) await writeKeyring(next);
  }
  keyring.addEventListener("change", () => void ensureOwnEntry());
  store.events.addEventListener("system", () => void ensureOwnEntry());

  // Built on every platform: without a disk backend no directory handle can be
  // stored, so the store loads nothing and the sidebar draws no section. Only
  // its entry points are gated, below.
  // openWindow: a folder asked for in main gets a window of its own in the
  // shell (architecture.md §14.5); the model must not import the ui.
  const folders = createFolderStore({ workspaces, openWindow: openWorkspaceWindow });
  await folders.load();

  // A root in Rust is a standing grant, and a folder this page closed (or a
  // file it dropped) would leave one behind forever. Once at boot, after both
  // stores have read the handle store, the page names the roots it still
  // references and Rust drops the rest (architecture.md §17).
  if (isDesktop) {
    getAllHandles()
      .then((records) => {
        const roots = records.map((r) => r.handle).filter(isNativeHandle);
        return pruneRoots([...new Set(roots.map((handle) => handle.root))]);
      })
      .catch((err) => console.log("[vrtti] root prune failed", err));
  }

  /**
   * The "New notes" guidance as a dialog, once (§27): on a device with no
   * disk whose new notes are Local only. A dialog and not `#notice`, which
   * shows on phones only and takes no taps. Only from buffer.new, never for
   * the first note store.start() makes at the first start.
   */
  async function newNotesNotice() {
    const text = newNotesGuidance(sync);
    if (!text || (await getSetting(NEW_NOTES_NOTICE_KEY))) return;
    // Stored first: the dialog never shows again, also when the app closes
    // on it. A user who chose to sync by hand is not asked twice.
    await putSetting(NEW_NOTES_NOTICE_KEY, true);
    const answer = await choose({
      title: "New notes",
      text,
      cancel: false,
      options: [
        { id: "settings", label: "Open Settings" },
        { id: "ok", label: "OK" },
      ],
    });
    if (answer === "settings") await run("settings.open");
  }

  /**
   * One of this device's spaces, picked in a dialog, for a sync with no
   * space given while "New notes" is Local only. Null: cancelled or no space.
   * @param {string} title @returns {Promise<string | null>}
   */
  async function pickSpace(title) {
    const spaces = sync.mySpaces();
    if (!spaces.length) return null;
    return choose({ title, options: spaces.map((space) => ({ id: space, label: space })) });
  }

  // Declared here and assigned when the sidebar mounts below. Commands run
  // long after startup, so the controller is always present when they execute.
  /** @type {ReturnType<typeof mountSidebar> | undefined} */
  let sidebar;

  register({
    id: "buffer.new",
    title: "New buffer",
    keys: "Alt+KeyN",
    run: async () => {
      const record = await store.create();
      sidebar?.unhideFor(record);
      // Not awaited: the caller gets its note while the dialog is open.
      if (!workspaces.current().space) {
        void newNotesNotice().catch((err) => console.log("[vrtti] new notes notice failed", err));
      }
      return record;
    },
  });
  register({
    id: "buffer.close",
    title: "Close buffer",
    keys: "Alt+KeyW",
    // No arg means the active buffer (the shortcut path). While desktop
    // Delete mode is active, Ctrl+W / Alt+W trashes instead of closing (§28).
    run: (id) => {
      const target = id ?? store.activeId;
      if (!target) return;
      if (id === undefined && sidebar?.isDeleteMode()) return run("doc.trash", target);
      return store.close(target);
    },
  });
  // Ctrl+S in the desktop shell (desktop-wrapper-tauri-vs-wails.md §11). The
  // editor autosaves, so this is Sublime's Ctrl+S mapped onto the two
  // debounces: flush now, or pick a file when there is none to flush to.
  // Alt chords stay out on purpose: the user wants the Ctrl set complete or
  // absent, and in a browser Ctrl+S is not ours to take.
  register({
    id: "buffer.save",
    title: "Save",
    run: (id) => {
      const target = id ?? store.activeId;
      if (!target) return;
      const record = store.get(target);
      if (record?.kind === "file" || !hasDisk) return store.saveNow(target);
      return run("file.saveAs", target);
    },
  });
  register({
    id: "buffer.activate",
    title: "Go to buffer",
    run: (id) => store.activate(id),
  });
  register({
    id: "buffer.reopen",
    title: "Reopen buffer",
    run: (id) => {
      const record = store.get(id);
      if (record) sidebar?.unhideFor(record);
      return store.reopen(id);
    },
  });
  // The sidebar drag (architecture.md §9). `before` null puts the buffer last.
  register({
    id: "buffer.move",
    title: "Move buffer",
    run: ({ id, before }) => store.moveTab(id, before),
  });

  // Windows (architecture.md §14, §28): a workspace is one window's context.
  // The browser opens a tab for it; the shell opens a native window (unit 14.4).
  // The command ids say workspace, the labels say window (§14, Naming).
  register({
    id: "workspace.new",
    title: "New window",
    keys: "Alt+Shift+KeyN",
    run: async () => {
      const workspace = await workspaces.create();
      openWorkspaceWindow(workspace.id);
      return workspace;
    },
  });
  register({
    id: "workspace.openSpace",
    title: "Open space in new window",
    run: async (space) => {
      if (!space || !sync.isMine(space)) return null;
      const existing = workspaces.spaceOwner(space);
      if (existing) {
        const live = await workspaces.liveSet();
        if (live.has(existing)) {
          if (existing !== workspaces.id) post("focus", { ws: existing });
          return existing;
        }
        await workspaces.dissolve(existing, { silent: true });
      }
      // Open the window synchronously inside the click gesture (before any
      // await when no stale record existed) so browser popup blockers do not
      // refuse `window.open`, and keep this window's tabs untouched until the
      // new Space Window boots and claims them (§28).
      const wsId = crypto.randomUUID();
      const creating = workspaces.create({ id: wsId, space, initSpace: true });
      const opening = openWorkspaceWindow(wsId);
      const [workspace, opened] = await Promise.all([creating, opening]);
      if (!opened) {
        await workspaces.dissolve(wsId, { silent: true });
        statusbar.notice("could not open window");
        return null;
      }
      setTimeout(() => void workspaces.dissolveIfGone(wsId), 5000);
      return workspace;
    },
  });
  register({
    id: "workspace.close",
    title: "Close window",
    // The shell closes any window (Ctrl+Shift+W reaches it as a keydown on
    // Windows); a browser closes only a tab it opened itself.
    run: () => closeWorkspaceWindow(workspaces.id),
  });
  register({
    id: "workspace.dissolve",
    title: "Dissolve workspace",
    run: (id) => workspaces.dissolve(id),
  });
  register({
    id: "buffer.rename",
    title: "Rename buffer",
    // Two renames behind one id: a scratch buffer gets a stored label, a
    // file-backed one gets a new name on disk. The caller says what it wants
    // renamed, never how; the record decides which path that is.
    // An empty name clears a label and puts the first line back in charge.
    run: async ({ id, name = "" } = {}) => {
      const target = id ?? store.activeId;
      const record = target ? store.get(target) : undefined;
      if (!record || !target) return false;
      if (record.kind !== "file") return store.setTitle(target, name);
      try {
        if (!(await store.renameFile(target, name))) return false;
      } catch (err) {
        // A taken name is the common case here, and the row keeps the old one.
        console.log("[vrtti] rename failed", name, err);
        return false;
      }
      await refreshFolders(record);
      return true;
    },
  });
  register({
    id: "spell.toggle",
    title: "Toggle spellcheck",
    // Returns the new state, so a caller can render the indicator without
    // reaching into the editor module itself.
    run: () => {
      setEnabled(!isEnabled());
      return isEnabled();
    },
  });
  register({
    id: "spell.lang",
    title: "Switch a spellcheck language of the note",
    // The argument is "cs" or "en". With the spellcheck off on this device,
    // a click turns it on and makes sure the clicked language is on: the
    // user clicked to see that language, whatever the note had stored.
    run: async (/** @type {"cs" | "en"} */ lang) => {
      const id = store.activeId;
      const record = id ? store.get(id) : undefined;
      if (!id || !record) return;
      const on = !isEnabled() || !activeLangs(record.spellOff)[lang];
      setEnabled(true);
      await store.setSpellOff(id, switchLang(record.spellOff, lang, on));
    },
  });
  // A command from the menu of a note gets its id and works on the whole
  // note, which it opens first: the store has no safe way to change the text
  // of a note that is not on screen (a parked editor state would write the
  // old text back). The key shortcut passes no id and works on the selection.
  /** @param {string | undefined} id @param {boolean} withModel */
  async function runDiacritics(id, withModel) {
    // Asked again here: the answer from startup is "no" when the device was
    // offline then (code review, UX finding 4).
    if (withModel && !sync?.hasModel && !(await sync?.probeModel())) {
      statusbar.notice(sync?.isConfigured ? "the sync server has no model" : "no sync server is set");
      return;
    }
    const target = id ?? store.activeId;
    if (!target) return;
    if (target !== store.activeId) await store.activate(target);
    const view = editor.view;
    // A locked note, or one still being read, shows a read-only placeholder.
    if (store.activeId !== target || view.state.readOnly) {
      statusbar.notice("the note is not open for editing");
      return;
    }
    // For the server log only: which device, and which run of the command
    // (one run sends many paragraphs at once). The keyring name is the one
    // the user picked; a device without encryption has none, and setup
    // without a name stores "this device" (keyring.js), so the start of
    // its id stands in (the same id is in the history of each note).
    const name = keyring.deviceName;
    const caller = {
      device: name && name !== "this device" ? name : "device " + (await deviceId()).slice(0, 8),
      run: crypto.randomUUID().slice(0, 4),
    };
    await addDiacritics(view, {
      model:
        withModel && sync
          ? { ask: (text, part) => /** @type {any} */ (sync).addDiacritics(text, { ...caller, part }) }
          : null,
      notice: statusbar.notice,
      wholeNote: id !== undefined,
      stillHere: () => store.activeId === target,
    });
  }
  register({
    id: "diacritics.local",
    title: "Add diacritics (local)",
    run: (id) => runDiacritics(id, false),
  });
  register({
    id: "diacritics.model",
    title: "Add diacritics (vllm)",
    run: (id) => runDiacritics(id, true),
  });
  register({
    id: "syntax.set",
    title: "Set syntax",
    // The argument is a language id; editor/lang.js exports LANGUAGES, the
    // list a future picker (command palette or settings row) would offer.
    // There is no UI for it yet, so nothing but a test dispatches this today.
    // Marked "user", which is what stops later pastes from re-detecting.
    run: (lang) => {
      const target = store.activeId;
      if (target) return store.setLang(target, lang, "user");
    },
  });
  register({
    id: "storage.persist",
    title: "Request persistent storage",
    // Also called once at startup. The command exists so the settings panel
    // asks through the registry like every other UI (architecture.md §9).
    run: () => requestPersistence(),
  });
  register({
    id: "app.update",
    title: "Check for update",
    // Settings passes its row repaint. The shell's Help > Check for updates…
    // sends this command with no argument (src-tauri/src/update.rs), and the
    // shell's dialog speaks only for the shell, so the page's result goes to
    // the status bar. Sticky, until the check's own null 3 s after the
    // result: the shell's dialog opens at about the same time, and a 1.5 s
    // notice would end behind it unread.
    run: (onStatus) =>
      checkForUpdate(
        typeof onStatus === "function"
          ? onStatus
          : (/** @type {string | null} */ msg) =>
              msg ? statusbar.notice("page: " + msg, true) : statusbar.endNotice(),
        { beforeReload: () => store.flushAll() }
      ),
  });

  // The app's log (model/log.js), with a Copy button: on a phone this is
  // the one way to see what went wrong.
  register({
    id: "app.log",
    title: "Show the log",
    run: () =>
      showSecret({
        title: "Log",
        text: logText() || "(empty)",
        note: "The last lines the app wrote: steps, ids and errors, no text of a note. Build " + BUILD.commit + ".",
        confirm: "Close",
      }),
  });

  // The same check on its own: a few seconds after the start, and when the
  // app comes back to the front, at most every five minutes. An installed
  // app on a phone is opened from the background for days and never asks;
  // without this it ran an old build until someone pressed the button.
  // Quiet unless it updates: the reload says the rest.
  let lastUpdateCheck = 0;
  const autoUpdate = () => {
    if (Date.now() - lastUpdateCheck < 5 * 60 * 1000) return;
    lastUpdateCheck = Date.now();
    void checkForUpdate(
      (msg) => {
        if (msg?.startsWith("updating")) statusbar.notice(msg, true);
      },
      { beforeReload: () => store.flushAll(), auto: true }
    );
  };

  // Devices and keys (architecture.md §5, §27). No keyboard shortcuts: setup
  // runs once in a lifetime and unlock is dispatched by whatever needs a key.

  /**
   * One sentence for a step that failed. fetch reports a server it could not
   * reach as a TypeError, with a text that differs per browser ("Failed to
   * fetch"); the sync status says "no answer from the server" for the same
   * thing (client.js syncNow).
   * @param {unknown} err
   */
  const why = (err) =>
    err instanceof TypeError ? "no answer from the server" : String(/** @type {any} */ (err)?.message ?? err);

  /** "a", "a and b", "a, b and c". @param {string[]} words */
  const listed = (words) =>
    words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  /** @param {string[]} spaces */
  const quoted = (spaces) => listed(spaces.map((space) => "“" + space + "”"));

  /**
   * What the inviting device says when the new device is in: in the invite
   * dialog, and in the status bar when that dialog is closed.
   * @param {string} name @param {string[]} spaces
   */
  const joinedText = (name, spaces) =>
    (name || "The new device") +
    " joined. " +
    (spaces.length ? "It gets " + quoted(spaces) + "." : "It is in no space yet. Tick it in “Space access”.");

  /** What the new device says when its join ended. @param {string[]} spaces */
  const joinDoneText = (spaces) =>
    spaces.length
      ? "This device is in " + quoted(spaces) + ". The notes arrive now."
      : "This device is on the server and in no space yet. A device that is in a space ticks this one in Settings › Devices.";

  // What another device did to this one (client.js announce()). The person
  // did nothing here at that moment, so nothing else on the screen says it.
  sync.events.addEventListener("notice", (event) => {
    /** @type {import("./sync/client.js").SyncNotice} */
    const notice = /** @type {CustomEvent} */ (event).detail;
    const text =
      notice.kind === "joined"
        ? joinedText(notice.name, notice.spaces)
        : notice.kind === "join-done"
          ? joinDoneText(notice.spaces)
          : notice.kind === "added"
            ? (notice.by || "Another device") + " added this device to “" + notice.space + "”. Its notes show as titles."
            : "This device is out of “" + notice.space + "”. Its notes are in the trash here.";
    statusbar.notice(text);
  });

  /**
   * Sync for a device that has no server: one dialog for what the other
   * device gave, an invite to paste or a code to type, with the first device
   * of a server as its own option (§27). `setup` is the way in from Settings
   * › Security, where the first device can also stay without a server.
   * A join that the server refuses comes back to the dialog with the reason
   * and with what was typed.
   * @param {{setup?: boolean}} [opts]
   * @returns {Promise<boolean>} false when the user walks away.
   */
  async function connectDevice({ setup = false } = {}) {
    /** @param {string} text */
    const isInvite = (text) => text.includes("vrtti-invite:");
    let message = "";
    let text = "";
    let url = sync.config.url;
    for (;;) {
      const answer = await askConnect({
        title: setup ? "Set up this device" : "Sync with a server",
        label: "Invite or code",
        placeholder: "vrtti-invite:… or K7MQ2-XWD4P",
        hint:
          "On a device of yours that syncs, use “invite a device” in Settings › Devices. " +
          "Paste its invite here, or type its code.",
        message,
        value: text,
        url,
        first: setup
          ? { label: "This is my first device", hint: "It gets a name, keys and a recovery key. A server is optional." }
          : {
              label: "This is the first device of a server",
              hint: "Type the server URL and the VRTTI_TOKEN of the server. Your other devices then join with an invite.",
            },
        // A code does not say where the server is; an invite does.
        isCode: (typed) => typed.trim() !== "" && !isInvite(typed),
        check: (typed, server) => {
          if (!typed) return "Paste an invite or type a code.";
          if (isInvite(typed)) return decodeInvite(typed) ? "" : "That invite is not complete. Copy it again.";
          if (!normalizeCode(typed)) return "That is not an invite and not a code. A code has ten letters and digits.";
          return /^https?:\/\/\S+$/.test(server) ? "" : "Type the server URL. The other device shows it next to the code.";
        },
      });
      if (!answer) return false;
      if (answer.kind === "first") return setup ? setUpFirstDevice() : connectFirstDevice();
      const invite = decodeInvite(answer.text) ?? { url: answer.url, code: normalizeCode(answer.text), name: "", spaces: {} };
      const result = await joinWith(invite, isInvite(answer.text));
      if (typeof result === "boolean") return result;
      ({ text, url } = answer);
      message = result;
    }
  }

  /**
   * The first device of a server: keys when it has none, then the server URL
   * and the server token (§27).
   * @returns {Promise<boolean>}
   */
  async function connectFirstDevice() {
    if (!keyring.isSetUp && !(await setUpDevice({ firstDevice: true }))) return false;
    const url = await askText({
      title: "Server",
      label: "Server URL",
      value: sync.config.url,
      placeholder: "https://sync.example.com",
    });
    if (url === null) return false;
    const token = await askPassphrase({ title: "Server token", label: "VRTTI_TOKEN" });
    if (token === null) return false;
    const busy = showBusy("Registering this device…");
    try {
      await sync.registerFirst(url, token);
    } catch (err) {
      busy.close();
      await showNote({ title: "Not registered", text: why(err) + "." });
      return false;
    }
    busy.close();
    await takeOverOldSpaces();
    return true;
  }

  /**
   * The first device from Settings › Security: its keys, and a server only
   * when the person wants one now. Keys alone are enough to encrypt a file.
   * @returns {Promise<boolean>}
   */
  async function setUpFirstDevice() {
    if (!(await setUpDevice({ firstDevice: true }))) return false;
    const server = await choose({
      title: "Sync",
      options: [
        { id: "now", label: "Connect a server now", hint: "The server URL and the VRTTI_TOKEN." },
        { id: "later", label: "Later", hint: "Settings › Sync has it. Your notes stay on this device until then." },
      ],
    });
    if (server === "now") await connectFirstDevice();
    return true;
  }

  /**
   * The first device after the upgrade takes over the spaces from before
   * §27, which have notes and no member yet. Explicit: a dev machine that
   * updated first must not take `personal` (§27). With nothing to take over
   * and no space yet, the device makes `personal`.
   */
  async function takeOverOldSpaces() {
    const old = await sync.listUnclaimed().catch(() => []);
    if (old.length) {
      const answer = await choose({
        title: "Take over the spaces " + old.join(", ") + "?",
        options: [
          {
            id: "yes",
            label: "Take them over",
            hint:
              "This device becomes their first member. It encrypts their notes and removes the readable old versions from the server. " +
              "Synced files stop syncing; turn sync on again from their menu.",
          },
          { id: "no", label: "Not now", hint: "Only a device that typed the server token can take them over later." },
        ],
      });
      if (answer === "yes") {
        for (const space of old) {
          await sync.createSpace(space, { claim: true }).catch((err) => {
            console.log("[vrtti] claim failed", space, err);
            statusbar.notice("could not take over " + space);
          });
        }
      }
    }
    if (!sync.mySpaces().length) {
      await sync.createSpace("personal").catch((err) => console.log("[vrtti] first space failed", err));
    }
  }

  /**
   * Keys for this device: its name, the passphrase choice, the keys, and for
   * a first device the recovery key, shown once. Shared by the setup command,
   * the connect flow and the invite, which already knows the name.
   * @param {{firstDevice: boolean, deviceName?: string}} opts
   * @returns {Promise<boolean>} false when the user walks away.
   */
  async function setUpDevice(opts) {
    let deviceName = opts.deviceName;
    if (deviceName === undefined) {
      const typed = await askText({
        title: "Set up this device",
        label: "Device name",
        value: defaultDeviceName(),
        hint: "Your other devices show this name. It cannot change later.",
      });
      if (typed === null) return false;
      deviceName = typed;
    }
    const canStore = await supportsStoredKeys();
    const mode = canStore
      ? await choose({
          title: "Passphrase",
          options: [
            {
              id: "none",
              label: "No passphrase",
              hint: "This device keeps its key and opens your notes at once. The key cannot be copied off the device.",
            },
            {
              id: "ask",
              label: "Ask for a passphrase at start",
              hint: "For a device that can get stolen. Each start asks for it.",
            },
          ],
        })
      : "ask";
    if (!mode) return false;
    /** @type {string | undefined} */
    let passphrase;
    if (mode === "ask") {
      const typed = await askPassphrase({
        title: "Choose a passphrase",
        confirm: true,
        hint:
          (canStore ? "" : "This browser cannot keep a key without one. ") +
          "There is no reset. If you forget it, this device cannot read your notes again.",
      });
      if (typed === null) return false;
      passphrase = typed;
    }
    const busy = showBusy("Generating keys…");
    /** @type {string | null} */
    let recoveryIdentity;
    try {
      ({ recoveryIdentity } = await keyring.setup({
        deviceName,
        askPassphrase: mode === "ask",
        passphrase,
        firstDevice: opts.firstDevice,
      }));
    } finally {
      busy.close();
    }
    if (recoveryIdentity) {
      await showSecret({
        title: "Recovery key",
        text: recoveryIdentity,
        note:
          "Shown once, never stored. Keep it on paper or in a password " +
          "manager. If you lose every device, this key still opens your " +
          "synced notes with the age command line tool.",
      });
    }
    return true;
  }

  /**
   * The new device's half of a join (§27): check the name, the modes and
   * "New notes", get keys if needed, use the code, and wait for the member.
   * An invite brings the server, the code and the spaces; a typed code
   * brings the first two, and its spaces arrive with the member's answer.
   * @param {import("./crypto/spaces.js").Invite} invite
   * @param {boolean} pasted  false: the person typed a code.
   * @returns {Promise<boolean | string>} true: joined. false: the person
   *   walked away. A string: the server refused, and why.
   */
  async function joinWith(invite, pasted) {
    const spaces = Object.entries(invite.spaces).map(([id, mode]) => ({ id, mode }));
    const answer = await askInvite({
      title: "Join",
      confirm: "Join",
      facts: [{ label: "Server", value: invite.url }],
      name: keyring.isSetUp
        ? null
        : {
            label: "Name of this device",
            value: invite.name || defaultDeviceName(),
            hint: "Your other devices show this name. It cannot change later.",
          },
      spaces,
      hint: spaces.length
        ? "Titles only lists the notes of a space in its drawer. Open as tabs opens every note."
        : pasted
          ? "The invite gives no space. Your other device adds this one to spaces in Settings › Devices."
          : "A code does not say which spaces this device gets. Their notes show as titles at first.",
      newNotes: { hint: "Where the notes that you make on this device go. Local only keeps them on this device." },
    });
    if (!answer) return false;
    // The keys before the code: the join sends this device's public keys.
    if (!keyring.isSetUp && !(await setUpDevice({ firstDevice: false, deviceName: answer.name || defaultDeviceName() }))) {
      return false;
    }
    const busy = showBusy("Joining…");
    try {
      await sync.redeem(invite.url, invite.code, answer.spaces, { from: invite.from, newNotes: answer.newNotes });
    } catch (err) {
      const status = /** @type {any} */ (err)?.status;
      if (status === 403) return "Wrong code. Read it again on the other device.";
      // The server URL too: another vrtti server gives the same answer.
      if (status === 404) {
        return "The server does not know this code. A code works once, for ten minutes. Check the server URL, or make a new invite.";
      }
      const text = why(err);
      return text.charAt(0).toUpperCase() + text.slice(1) + ".";
    } finally {
      busy.close();
    }
    await waitForJoin(invite.from ?? "");
    return true;
  }

  /**
   * The wait of the new device for the member that made its invite, as a
   * dialog that says each state (§27). The member must sync once, unlocked,
   * and that can be seconds or days: closing the dialog does not end the
   * wait, and the status bar says when the join ended.
   * @param {string} from  The name of that member, "" when a code was typed.
   */
  async function waitForJoin(from) {
    const other = from || "your other device";
    const startedAt = Date.now();
    let polls = 0;
    await showProgress({
      title: "Joining",
      every: 1500,
      poll: async () => {
        // The window that runs the schedule asks the server by itself while
        // a join waits (client.js JOIN_POLL). This asks too, every 3 seconds:
        // in another window the first request can come before that window
        // read the new server.
        if (polls++ % 2 === 0) void sync.syncNow();
        const state = await sync.joinState();
        const onServer = { ok: true, text: "This device is on the server." };
        if (state.state === "waiting") {
          return {
            lines: [onServer, { ok: false, text: "Waiting for " + other + " to let it in." }],
            hint: state.locked
              ? "Unlock this device to end the join."
              : Date.now() - startedAt > 30 * 1000
                ? "No answer yet. Open vrtti on " + other + " and unlock it. This device waits, also after you close this."
                : "Keep vrtti open and unlocked on " + other + ".",
          };
        }
        const spaces = state.state === "joined" ? state.spaces : [];
        const member = (state.state === "joined" && state.member) || other;
        const newNotes = state.state === "joined" ? state.newNotes : null;
        return {
          title: "Joined",
          done: true,
          lines: [onServer, { ok: true, text: member.charAt(0).toUpperCase() + member.slice(1) + " let it in." }],
          result: joinDoneText(spaces),
          hint: !spaces.length
            ? ""
            : newNotes
              ? "New notes of this device go to “" + newNotes + "”."
              : "New notes stay on this device. Settings › Spaces changes that.",
        };
      },
    });
  }

  register({
    id: "device.setup",
    title: "Set up this device",
    // One dialog for both ways in (Settings › Sync and Settings › Security).
    // Without keys the first device can also stay without a server.
    run: () => connectDevice({ setup: !keyring.isSetUp }),
  });
  register({
    id: "device.connect",
    title: "Sync with a server",
    run: () => connectDevice(),
  });
  register({
    id: "device.invite",
    title: "Invite a device",
    run: async () => {
      // A device in no space can invite too: the new device joins the
      // server, and the grid in Settings › Devices adds it to spaces later.
      const spaces = sync.mySpaces();
      // Titles only by default: an invite with every space as tabs would open
      // every note on the new device at its first sync.
      const answer = await askInvite({
        title: "Invite a device",
        confirm: "Make invite",
        name: {
          label: "Name of the new device",
          value: "",
          placeholder: "Phone",
          hint: "The new device starts with this name. It can change the name before it joins, and not later.",
        },
        tickable: true,
        spaces: spaces.map((id) => ({ id, mode: "list", checked: true })),
        hint:
          (spaces.length
            ? "The new device gets the spaces you tick. Titles only lists their notes in the drawer of the space; " +
              "Open as tabs opens every note. The new device can change the modes. "
            : "") + "With no space ticked, the device joins the server only. Add it to spaces later in “Space access”.",
      });
      if (!answer) return false;
      const busy = showBusy("Making an invite…");
      let code;
      try {
        code = await sync.invite(Object.keys(answer.spaces));
      } catch (err) {
        // Before the note: the busy panel has no way out of its own.
        busy.close();
        await showNote({ title: "No invite", text: why(err) + "." });
        return false;
      } finally {
        busy.close();
      }
      const made = code;
      const url = sync.config.url;
      await showInvite({
        title: answer.name ? "Invite for " + answer.name : "Invite",
        text: encodeInvite({
          url,
          code: normalizeCode(made),
          name: answer.name,
          spaces: answer.spaces,
          // The new device says "Waiting for <this name>".
          from: keyring.deviceName ?? "",
        }),
        note:
          "Paste it on the new device: Settings › Sync, “connect”. " +
          "Each person who has this text can join your spaces, so send it only to yourself.",
        typed: {
          label: "To type it by hand on the new device:",
          facts: [
            { label: "Server", value: url },
            { label: "Code", value: made, code: true },
          ],
        },
        // The server's lifetime of a code (DeviceApi.cs, JoinLifetime); this
        // device cannot ask it.
        expiresAt: Date.now() + 10 * 60 * 1000,
        // A sync round is what answers the join. The stored invite tells how
        // it ended, also when the leader is another window.
        check: async () => {
          await sync.syncNow();
          const state = await sync.inviteState(made);
          // The name is the one the new device chose, which can differ from
          // the name typed above.
          if (state.state === "joined") return { done: true, ok: true, text: joinedText(state.name, state.spaces) };
          if (state.state === "used") return { text: "The new device used the invite. Unlock this device to let it in." };
          if (state.state === "gone") return { done: true, text: "This invite is not valid now. Make a new one." };
          return {};
        },
      });
      void sync.syncNow();
      return true;
    },
  });
  register({
    id: "space.create",
    title: "New space",
    run: async () => {
      const name = await askText({
        title: "New space",
        label: "Name",
        hint: "Letters, digits, - and _, up to 32. This device is its first member.",
      });
      if (name === null) return false;
      try {
        await sync.createSpace(name.trim());
        return true;
      } catch (err) {
        await showNote({ title: "No new space", text: why(err) + "." });
        return false;
      }
    },
  });
  /** @param {string} title @param {() => Promise<unknown>} work */
  async function spaceChange(title, work) {
    try {
      await work();
      return true;
    } catch (err) {
      await showNote({ title, text: why(err) + "." });
      return false;
    }
  }
  register({
    id: "space.add",
    title: "Add a device to a space",
    run: ({ space, key }) => spaceChange("Not added", () => sync.addDevice(space, key)),
  });
  register({
    id: "space.remove",
    title: "Remove a device from a space",
    run: async ({ space, key, name, me }) => {
      const answer = await choose({
        title: me ? "Leave “" + space + "”?" : "Remove “" + name + "” from “" + space + "”?",
        options: [
          {
            id: "yes",
            label: me ? "Leave" : "Remove",
            hint: me
              ? "The notes of this space go to the trash on this device."
              : "That device gets no more notes of this space. What it has already stays there.",
          },
        ],
      });
      if (answer !== "yes") return false;
      return spaceChange("Not removed", () => sync.removeDevice(space, key));
    },
  });
  register({
    id: "space.color",
    title: "Change the color of a space",
    run: (space) => {
      const current = sync.colorOf(space);
      const next = PALETTE[(PALETTE.indexOf(current) + 1) % PALETTE.length];
      return spaceChange("Color not changed", () => sync.setColor(space, next));
    },
  });
  register({
    id: "device.passphraseSwitch",
    title: "Ask for a passphrase at start",
    run: async () => {
      if (!keyring.isSetUp || !keyring.isUnlocked) return false;
      const to = !keyring.askPassphrase;
      // Readable keys back under a passphrase: the same keys, wrapped. Same
      // device, nothing to encrypt again (keyring.protectReadable).
      if (to && keyring.hasReadableKeys) {
        const typed = await askPassphrase({ title: "Choose a passphrase", confirm: true });
        if (typed === null) return false;
        const busy = showBusy("Protecting the key…");
        try {
          await keyring.protectReadable(typed);
          return true;
        } finally {
          busy.close();
        }
      }
      const problem = to ? null : await storedKeysProblem();
      if (problem) {
        // A browser that cannot keep a protected key (an iPhone): the user
        // may keep the same key readable instead (keyring.storeReadable).
        const choice = await choose({
          title: "Store the key readable?",
          options: [
            {
              id: "readable",
              label: "Store it readable",
              hint:
                "This browser cannot keep a protected key (" + problem + "). " +
                "This device keeps its key in its storage, readable, and the passphrase is gone. " +
                "The phone's own encryption protects the storage while it is locked. " +
                "Any code that runs on " + location.origin + " can read the key, and a backup of the device holds it.",
            },
          ],
        });
        if (choice !== "readable") return false;
        let message = "Type your passphrase one last time.";
        for (let attempt = 0; attempt < UNLOCK_ATTEMPTS; attempt++) {
          const typed = await askPassphrase({ title: "Passphrase", message });
          if (typed === null) return false;
          const busy = showBusy("Storing the key…");
          try {
            await keyring.storeReadable(typed);
            return true;
          } catch (err) {
            console.log("[vrtti] readable keys failed", err);
            if (/** @type {any} */ (err)?.name !== "WrongPassphraseError") {
              busy.close();
              await showNote({ title: "Not changed", text: String(/** @type {any} */ (err)?.message ?? err) });
              return false;
            }
            message = "Wrong passphrase. Try again.";
          } finally {
            busy.close();
          }
        }
        return false;
      }
      const answer = await choose({
        title: to ? "Ask for a passphrase at start?" : "Stop asking for a passphrase?",
        options: [
          {
            id: "yes",
            label: "Change",
            hint:
              "This device gets new keys and becomes a new device in your spaces. " +
              "It encrypts its notes again; keep it open until the sync is done.",
          },
        ],
      });
      if (answer !== "yes") return false;
      /** @type {string | undefined} */
      let passphrase;
      if (to) {
        const typed = await askPassphrase({ title: "Choose a passphrase", confirm: true });
        if (typed === null) return false;
        passphrase = typed;
      }
      const busy = showBusy("New keys for this device…");
      try {
        await sync.changePassphraseSwitch({ askPassphrase: to, passphrase });
        return true;
      } catch (err) {
        console.log("[vrtti] passphrase switch failed", err);
        busy.close();
        // The change goes on from where it stopped at the next try.
        await showNote({ title: "Not changed", text: String(/** @type {any} */ (err)?.message ?? err) });
        return false;
      } finally {
        busy.close();
      }
    },
  });
  register({
    id: "crypto.unlock",
    title: "Unlock",
    // Resolves true when the identity is in memory afterwards, so a caller that
    // hit a locked document can simply retry its own work.
    run: async () => {
      if (!keyring.isSetUp) return false;
      if (keyring.isUnlocked) return true;
      // The one-time question of the upgrade (§27): a device from before
      // asks its old passphrase once, and without the switch never again.
      const upgrade = keyring.needsUpgrade;
      let message = upgrade ? "vrtti changed how devices keep their keys. Type your passphrase one more time." : "";
      for (let attempt = 0; attempt < UNLOCK_ATTEMPTS; attempt++) {
        const passphrase = await askPassphrase({ title: "Unlock", message });
        if (passphrase === null) return false;
        const busy = showBusy("Unlocking…");
        try {
          await keyring.unlock(passphrase);
          return true;
        } catch (err) {
          console.log("[vrtti] unlock failed", err);
          // typage reports a wrong passphrase and a corrupt blob with the same
          // error, and the user can only act on the first, so say that. Any
          // other error is not about the passphrase: say what it is, or the
          // user types a right passphrase again and again.
          if (/** @type {any} */ (err)?.name !== "WrongPassphraseError") {
            busy.close();
            await showNote({
              title: "Unlock failed",
              text: "The passphrase was right, but this browser refused a later step: " + String(/** @type {any} */ (err)?.message ?? err),
            });
            return false;
          }
          message = "Wrong passphrase. Try again.";
        } finally {
          busy.close();
        }
      }
      statusbar.notice("still locked");
      return false;
    },
  });
  register({
    id: "crypto.lock",
    title: "Lock",
    run: () => keyring.lock(),
  });

  // A file on disk turns into an `.age` file for this device and the
  // recovery key (architecture.md §19). A synced note is encrypted anyway
  // (§27), so the row menu offers this for files only.
  register({
    id: "doc.encrypt",
    title: "Encrypt file",
    // No arg means the active buffer, like buffer.close.
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      if (!keyring.isSetUp && !(await run("device.setup"))) return false;
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const record = store.get(target);
      try {
        await store.encrypt(target, "this-device");
      } catch (err) {
        // A file that cannot be renamed to `.age` (a taken name, a lost
        // permission) stays as it was; the record was not touched.
        console.log("[vrtti] encrypt failed", err);
        statusbar.notice("encrypt failed");
        return false;
      }
      await refreshFolders(record);
      return true;
    },
  });
  register({
    id: "doc.decrypt",
    title: "Decrypt note",
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      // Decrypting needs the key as much as reading does: the plaintext comes
      // out of the ciphertext, and nothing else holds it.
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const record = store.get(target);
      // A synced note stays encrypted (§27); the row menu never offers this.
      if (record?.sync) return false;
      try {
        await store.decrypt(target);
      } catch (err) {
        console.log("[vrtti] decrypt failed", err);
        statusbar.notice("decrypt failed");
        return false;
      }
      await refreshFolders(record);
      return true;
    },
  });

  /**
   * An open folder section still lists a file's old name after a rename on
   * disk. Re-listing costs one directory read per open folder, and only a
   * file-backed doc pays it.
   * @param {import("./storage/idb.js").BufferRecord | undefined} record
   */
  async function refreshFolders(record) {
    if (record?.kind !== "file") return;
    for (const folderId of [...folders.folders.keys()]) await folders.refresh(folderId);
  }

  // Sync (architecture.md §3, §13.6, §27). Registered on every platform: sync
  // is a server target, and every platform can hold one. The client stays
  // inert until a device token exists, so each of these is a no-op until then.
  register({
    id: "sync.disconnect",
    title: "Stop syncing this device",
    run: async () => {
      const answer = await choose({
        title: "Stop syncing this device?",
        options: [
          {
            id: "yes",
            label: "Stop",
            hint: "This device forgets its server. Your notes stay here. To sync again it joins with a code.",
          },
        ],
      });
      if (answer !== "yes") return false;
      await sync.disconnect();
      return true;
    },
  });
  register({
    id: "doc.sync.on",
    title: "Sync this note",
    // No arg means the active buffer, like buffer.close. `{ id, space }` is
    // the row menu's "Sync to" (§25); a bare id goes to the New notes space.
    run: async (arg) => {
      const { id, space } = typeof arg === "object" && arg ? arg : { id: arg, space: undefined };
      const target = id ?? store.activeId;
      if (!target) return false;
      if (space !== undefined && sync.modeOf(space) === undefined) return false;
      if (!sync.isConfigured) {
        // A log, not a dialog: the row menu already carries the hint that says
        // where a server is set, and this path is only reachable around it.
        console.log("[vrtti] sync: no server configured");
        return false;
      }
      // A bare id goes to the New notes space; with Local only, the user picks.
      const into = space ?? sync.defaultSpace() ?? (await pickSpace("Sync to which space?"));
      if (!into) return false;
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const record = store.get(target);
      // A synced note is encrypted (§27), and a file holds what the device
      // writes: it turns into an `.age` file, which deserves one question.
      if (record?.file && !record.enc) {
        const answer = await choose({
          title: "Sync “" + titleOf(record) + "”?",
          options: [
            {
              id: "yes",
              label: "Encrypt and sync",
              hint: "The file becomes " + record.file.name + ".age, readable with your devices' keys and the age tool.",
            },
          ],
        });
        if (answer !== "yes") return false;
      }
      try {
        await store.setSync(target, true, into);
        sidebar?.unhideFor(store.get(target));
      } catch (err) {
        console.log("[vrtti] sync on failed", err);
        statusbar.notice("sync failed");
        return false;
      }
      return true;
    },
  });
  register({
    id: "doc.sync.off",
    title: "Stop syncing this note",
    // The record keeps its text and pushes a `detached` tombstone, so the
    // other devices keep their copies too (architecture.md §3).
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      await store.setSync(target, false);
      sidebar?.unhideFor(store.get(target));
      return true;
    },
  });
  register({
    id: "doc.move",
    title: "Move to a space",
    run: async ({ id, space }) => {
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      try {
        const ok = await store.move(id, space);
        if (ok) sidebar?.unhideFor(store.get(id));
        return ok;
      } catch (err) {
        console.log("[vrtti] move failed", err);
        statusbar.notice("move failed");
        return false;
      }
    },
  });
  // Explicit Trash, Restore, Delete permanently, and unopened stub trash (§28).
  register({
    id: "doc.trash",
    title: "Move note to trash",
    run: async (id) => {
      const target = id ?? store.activeId;
      const record = target ? store.get(target) : undefined;
      if (!record || !target) return false;
      if (record.kind === "file" && record.file?.unwritten) {
        statusbar.notice("Unsaved text is not on disk; reconnect or Unlink file first");
        return false;
      }
      if (store.isPinLocked(target) && !(await pin.allow("Moving a locked note needs the PIN"))) {
        return false;
      }
      const isFile = record.kind === "file";
      const ok = await store.trashBuffer(target);
      if (!ok) return false;
      statusbar.notice(isFile ? "removed from list" : "moved to trash");
      return true;
    },
  });
  register({
    id: "doc.restore",
    title: "Restore note from trash",
    run: async (arg) => {
      const { id, toSpace = false } =
        typeof arg === "object" && arg ? arg : { id: arg, toSpace: false };
      if (!id) return false;
      const record = store.get(id);
      if (!record || !record.trashedAt) return false;
      // Decrypting `space` ciphertext or re-sealing for a space needs the
      // keyring unlocked; a `this-device` local note restored locally stays
      // encrypted as-is and needs no unlock.
      const needsKey = Boolean(record.enc?.preset === "space" || (toSpace && !record.sync));
      if (needsKey && keyring.isSetUp && !keyring.isUnlocked && !(await run("crypto.unlock"))) {
        return false;
      }
      try {
        const restored = await store.restore(id, { toSpace });
        if (!restored) return false;
        if (restored.sync?.space) sidebar?.unhideFor(restored);
        statusbar.notice(
          restored.sync?.space ? "restored to " + restored.sync.space : "restored to Recent"
        );
        return restored;
      } catch (err) {
        console.log("[vrtti] restore failed", err);
        statusbar.notice("restore failed");
        return false;
      }
    },
  });
  register({
    id: "doc.deleteForever",
    title: "Delete note permanently",
    run: async (id) => {
      if (!id) return false;
      if (store.isPinLocked(id) && !(await pin.allow("Deleting a locked note needs the PIN"))) {
        return false;
      }
      const ok = await store.deleteForever(id);
      if (ok) statusbar.notice("deleted permanently");
      return ok;
    },
  });
  register({
    id: "remote.trash",
    title: "Move server note to trash",
    run: async (id) => {
      if (!id || !sync.isConfigured) return false;
      const stub = store.remotes().find((s) => s.id === id);
      if (!stub) return false;
      if (stub.pin && !pin.isOpen && !(await pin.allow("Moving a locked note needs the PIN"))) {
        return false;
      }
      if (keyring.isSetUp && !keyring.isUnlocked && !(await run("crypto.unlock"))) {
        return false;
      }
      const result = await store.trashRemoteStub(id, (docId) => sync.fetchDoc(docId));
      if (!result.ok) {
        if (result.reason === "offline") {
          statusbar.notice("offline: cannot trash unopened server note");
        }
        return false;
      }
      statusbar.notice(result.alreadyGone ? "already removed on server" : "moved to trash");
      return true;
    },
  });
  register({
    id: "sync.now",
    title: "Sync now",
    run: () => sync.syncNow(),
  });
  register({
    id: "sync.all",
    title: "Sync every open note",
    // The bulk switch of architecture.md §3: it only sets the per-document
    // flag, one document at a time. There is no second kind of sync target.
    // With "New notes" Local only, the user picks the space in a dialog.
    run: async () => {
      if (!sync.isConfigured) return false;
      const space = sync.defaultSpace() ?? (await pickSpace("Sync every open note to"));
      if (!space) return false;
      for (const record of store.openBuffers()) {
        if (!record.sync && !record.file) await store.setSync(record.id, true, space).catch(() => {});
      }
      return true;
    },
  });
  // Spaces (architecture.md §25).
  register({
    id: "remote.open",
    title: "Open a note from the server",
    // A click on a From server stub: fetch the note now, open it in THIS
    // window (not main, where a pulled note goes), and sync it from then on.
    run: async (id) => {
      if (!id || !sync.isConfigured) return false;
      let change;
      try {
        change = await sync.fetchDoc(id);
      } catch (err) {
        // Gone from the server: the title is all that was left of it.
        if (/** @type {any} */ (err)?.status === 404) await store.dropRemote(id);
        else {
          console.log("[vrtti] fetching a server note failed", id, err);
          statusbar.notice("could not fetch the note");
        }
        return false;
      }
      // Deleted or detached since the stub was written: same as gone.
      if (change.kind !== "text") {
        await store.dropRemote(id);
        return false;
      }
      // A pull can bring the record in while the fetch is in flight, and
      // then it may be a tab of another window: reopen goes there instead.
      if (store.get(id)) {
        await run("buffer.reopen", id);
        return true;
      }
      await store.createFromChange(change, workspaces.id);
      sidebar?.unhideFor(store.get(id));
      await run("buffer.activate", id);
      return true;
    },
  });
  register({
    id: "sync.spaceMode",
    title: "Set what this device does with a space",
    run: ({ space, mode }) => sync.setSpaceMode(space, mode),
  });
  register({
    id: "sync.newNotes",
    title: "Set where new notes go",
    // A space name, or null for Local only (§27). Only the user runs this.
    run: (space) => sync.setNewNotes(space ?? null),
  });
  register({
    id: "doc.history",
    title: "Note history…",
    run: async (id) => {
      const target = id ?? store.activeId;
      const record = target ? store.get(target) : undefined;
      if (!record || !sync.isConfigured) return false;
      // Old versions hold the same text the PIN keeps off the screen (§27).
      if (record.pin && !(await pin.allow("History needs the PIN"))) return false;
      await showHistory({ record, client: sync, store });
      return true;
    },
  });

  // The PIN lock (architecture.md §27). `pin` is mounted further down in
  // start(), next to the status bar it reports through; every run() comes
  // after that.
  register({
    id: "pin.unlock",
    title: "Open the locked notes",
    run: () => pin.unlock(),
  });
  register({
    id: "doc.pin",
    title: "Lock with PIN",
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      return pin.lockNote(target);
    },
  });
  register({
    id: "doc.unpin",
    title: "Remove PIN lock",
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      return pin.unlockNote(target);
    },
  });

  // "Back up to a folder" (architecture.md §27): each note of a space as a
  // file in a picked folder. Only where a folder can be picked (hasDisk).
  register({
    id: "space.backup",
    title: "Back up a space to a folder",
    run: async (space) => {
      if (!hasDisk || !sync.isConfigured) return false;
      if ((await getSetting("pin.hash")) && !(await pin.allow("The backup needs the PIN"))) return false;
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const kind = await choose({
        title: "Back up “" + space + "”",
        options: [
          { id: "plain", label: "Plain text", hint: "One .md file for each note, readable by any program." },
          { id: "age", label: ".age files", hint: "Encrypted for this device and the recovery key. The age tool opens them." },
        ],
      });
      if (!kind) return false;
      let dir;
      try {
        dir = await openDirectoryPicker();
      } catch (err) {
        if (/** @type {any} */ (err)?.name !== "AbortError") console.log("[vrtti] backup folder", err);
        return false;
      }
      const busy = showBusy("Backing up " + space + "…");
      try {
        const notes = [];
        /** @type {{docId: string}[]} */
        const rows = await sync.allNotes(space);
        // A note made here and not pushed yet has no server row.
        const onServer = new Set(rows.map((row) => row.docId));
        for (const id of store.idsInSpace(space)) if (!onServer.has(id)) rows.push({ docId: id });
        for (const row of rows) {
          const read = await store.readForBackup(row);
          if (read) notes.push({ id: row.docId, ...read });
        }
        const names = fileNames(notes, kind === "age" ? ".md.age" : ".md");
        const files = [];
        for (const note of notes) {
          const content = kind === "age" ? await store.encryptForBackup(note.text) : note.text;
          files.push({ name: /** @type {string} */ (names.get(note.id)), content });
        }
        const count = await writeFiles(dir, files);
        statusbar.notice(count === 1 ? "1 note backed up" : count + " notes backed up");
        return true;
      } catch (err) {
        console.log("[vrtti] backup failed", err);
        statusbar.notice("backup failed");
        return false;
      } finally {
        busy.close();
      }
    },
  });
  register({
    id: "doc.copy",
    title: "Copy text",
    // The whole document to the system clipboard. On a phone, a finger
    // select-all over a long note is the slow part; one menu tap replaces it.
    // The text comes from the store, not the editor: the row menu may target
    // a buffer that is not the active one.
    run: async (id) => {
      const target = id ?? store.activeId;
      const record = target ? store.get(target) : undefined;
      if (!record || !target) return false;
      // An encrypted body needs the key, as reading it does.
      if (record.enc && !keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      if (record.pin && !(await pin.allow("Copy needs the PIN"))) return false;
      // `statusbar` is declared further down in start(); every run() comes
      // after the mount, so the reference is never ahead of it.
      try {
        // Still inside the click's activation window: a loaded plaintext doc
        // resolves at once, and a decode or file read takes well under the
        // seconds browsers grant before a clipboard write needs a new tap.
        await navigator.clipboard.writeText(await store.textOf(target));
      } catch (err) {
        console.log("[vrtti] copy failed", err);
        statusbar.notice("copy failed");
        return false;
      }
      statusbar.notice("copied");
      return true;
    },
  });

  // Desktop disk files (architecture.md §2, §17). Registered only where some
  // backend can reach disk, so a Firefox or iOS build has no command that
  // could ever run.
  if (hasDisk) {
    register({
      id: "file.open",
      title: "Open file…",
      run: async () => {
        try {
          return await store.createFromFile(await openFilePicker());
        } catch (err) {
          // A dismissed picker is a decision, not a failure.
          if (err && err.name === "AbortError") return;
          console.log("[vrtti] open file failed", err);
        }
      },
    });
    register({
      id: "file.saveAs",
      title: "Save to disk…",
      // No arg means the active buffer, like buffer.close.
      run: async (id) => {
        const target = id ?? store.activeId;
        if (!target) return;
        try {
          return await store.saveAs(target);
        } catch (err) {
          if (err && err.name === "AbortError") return;
          console.log("[vrtti] save to disk failed", err);
        }
      },
    });
    register({
      id: "file.reconnect",
      title: "Reconnect file",
      run: (id) => store.reconnect(id),
    });
    register({
      id: "file.unlink",
      title: "Unlink file",
      // The note becomes an internal one with the file's text; the file on
      // disk stays as it is (architecture.md §23).
      run: async (id) => {
        const target = id ?? store.activeId;
        if (!target) return false;
        try {
          return Boolean(await store.unlinkFile(target));
        } catch (err) {
          // A file that cannot be read has no text to keep: refuse, and the
          // record stays linked with its marker.
          console.log("[vrtti] unlink refused", err);
          return false;
        }
      },
    });
    register({
      id: "folder.open",
      title: "Open folder…",
      run: async () => {
        try {
          return await folders.openFolder();
        } catch (err) {
          // A dismissed picker is a decision, not a failure.
          if (err && err.name === "AbortError") return;
          console.log("[vrtti] open folder failed", err);
        }
      },
    });
    register({
      id: "folder.close",
      title: "Close folder",
      run: (id) => folders.closeFolder(id),
    });
    register({
      id: "folder.reconnect",
      title: "Reconnect folder",
      run: (id) => folders.reconnect(id),
    });
    register({
      id: "disk.open",
      title: "Open from the shell",
      // The shell's own open (architecture.md §24): a file dropped on the
      // window, an "Open with", a launch argument. Rust registered the root
      // already and sends it as the arg; the page opens it exactly like a
      // picker result. Only the shell raises the command, so in a browser
      // it is registered and idle.
      run: async (root) => {
        const handle = handleFromRoot(root);
        if (!handle) {
          console.log("[vrtti] disk.open without a root", root);
          return;
        }
        try {
          if (handle.kind === "directory") return await folders.addFolder(handle);
          return await store.createFromFile(handle);
        } catch (err) {
          console.log("[vrtti] open from the shell failed", handle.rootPath, err);
        }
      },
    });
    register({
      id: "folder.openFile",
      title: "Open file from folder",
      // The path travels with the handle so the buffer can show where it came
      // from; the doc store keeps the bare file name as the title.
      // The default keeps an argument-less dispatch (a future palette) out of
      // a TypeError; createFromFile then rejects inside the catch below.
      run: async ({ handle, path } = {}) => {
        try {
          return await store.createFromFile(handle, { path });
        } catch (err) {
          console.log("[vrtti] open from folder failed", path, err);
        }
      },
    });
  }

  const host = /** @type {HTMLElement} */ (document.getElementById("editor-host"));
  // Kept, unlike before: search in files reveals a hit through this controller
  // (architecture.md §16).
  const editor = mountEditor(host, store);
  // View > Word Wrap in the desktop shell. Applied from this device's stored
  // value now, before the first buffer goes up.
  mountWordWrap(editor);
  // Edit > Line, Convert Case, Sort Lines in the desktop shell: the ids of
  // editor/transform.js, run on this view.
  mountTransforms(editor);
  // Ctrl+wheel over the editor. Needs the host for the wheel and the CSS
  // variable, and nothing from the editor controller. Must stay after
  // store.load(): at mount it drops the saved zoom of every note the store
  // does not know, and before the load that is every note.
  const zoom = mountZoom(host, store);
  // Sublime's Ctrl+1 (focus group 1), the partner of Ctrl+0 in ui/sidebar.js.
  // In a browser tab Ctrl+1 is "first tab" and may never arrive; it is for
  // the installed app and the desktop shell. Escape in the sidebar does the
  // same without the chord.
  register({
    id: "editor.focus",
    title: "Focus editor",
    keys: "Ctrl+Digit1",
    run: () => {
      run("sidebar.autoclose");
      editor.view.focus();
    },
  });

  // Mounted before its command, because the command dispatches into the
  // controller the mount returns. The sidebar button below dispatches the id.
  const settings = mountSettings({ keyring, sync, store });
  register({
    id: "settings.toggle",
    title: "Settings",
    run: () => settings.toggle(),
  });
  // The panel covers the editor, so whatever opens a document from the
  // sidebar (a row, a search hit, the "+") closes it first, or the document
  // opens behind it.
  register({
    id: "settings.open",
    title: "Open settings",
    run: () => settings.open(),
  });
  register({
    id: "settings.close",
    title: "Close settings",
    run: () => settings.close(),
  });

  const search = mountSearch({ store, folders, workspaces, editor });
  register({
    id: "search.inFiles",
    title: "Find in files…",
    // The one Ctrl chord the page takes (ui/shortcuts.js). In the shell it can
    // arrive twice, as a menu event and as a keydown, so open() is idempotent
    // and never a toggle (architecture.md §16).
    keys: "Ctrl+Shift+KeyF",
    run: () => search.open(),
  });

  // Before the sidebar: its rows dispatch sidebar.autoclose, and before
  // mountShortcuts, which snapshots the chord table once.
  const shell = mountShell();
  mountNewButton();
  mountThumb();
  sidebar = mountSidebar(store, folders, sync, workspaces);
  const statusbar = mountStatusbar(store, sync, zoom, editor.view, keyring);
  const pin = mountPin({ store, notice: (text) => statusbar.notice(text) });
  // The quick buttons of a mark (editor/spellcheck.js, withQuick). Each one
  // writes the shared settings record; the "shared-settings" event then
  // repaints the marks in every note. There is no Undo button: the notice
  // says what happened, and Settings > Spellcheck is the way back.
  setQuickActions({
    addWord: (word) => {
      void store.writeSharedSettings(addWord(store.sharedSettings(), word, Date.now()));
      statusbar.notice(`“${word}” is in My words`);
    },
    ruleOff: (rule) => {
      const settings = store.sharedSettings();
      // A mark exists, so the rule is on. It is on by default unless the
      // user turned it on, and that is the one case with an entry `on: true`.
      const byDefault = settings.rules[rule]?.on !== true;
      void store.writeSharedSettings(setRule(settings, rule, false, byDefault, Date.now()));
      statusbar.notice(`“${displayName(rule)}” is off`);
    },
  });
  // After the status bar exists: autoUpdate reports through it.
  setTimeout(autoUpdate, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") autoUpdate();
  });
  mountTitle(store, {
    secondary: workspaces.id !== MAIN_WORKSPACE,
    space: workspaces.current().space,
  });
  mountShortcuts();
  mountDesktop({
    workspaces,
    folders,
    isBlankBuffer: (id) => {
      const record = store.get(id);
      if (!record) return true;
      if (record.kind === "file") return false;
      // A synced note is encrypted from its first moment, also when empty
      // (§27), so its text is the decoded one; when not decoded into memory yet
      // (desktop skips background preview warming), `firstLine === ""` without a
      // user title or PIN lock marks an empty space note, matching `isEmpty()`.
      const text = store.loadedText(id);
      if (text !== undefined) return !text.trim();
      return Boolean(
        record.enc?.preset === "space" &&
          !record.title &&
          !store.isPinLocked(id) &&
          record.firstLine === ""
      );
    },
  });
  mountResizer();

  // Losing membership in a Space Window's space closes that window (§28).
  store.events.addEventListener("space-window-close", () => {
    closeWorkspaceWindow(workspaces.id);
  });
  on("close-window", ({ ws }) => {
    if (ws === workspaces.id) closeWorkspaceWindow(workspaces.id);
  });

  // On a Space Window's very first boot (`initSpace: true`), claim open tabs
  // of that space from surviving windows and clear `initSpace` before
  // `store.start()` picks an active buffer. Remaining server stubs fetch in the
  // background AFTER `store.start()` so startup never blocks on network calls
  // and reloads never reopen tabs the user closed (§28).
  const ownSpace = workspaces.current().space;
  let initialSpaceBoot = false;
  if (ownSpace && workspaces.current().initSpace) {
    const claimed = await store.claimSpaceTabs(ownSpace);
    initialSpaceBoot = await workspaces.finishSpaceInit(claimed);
  }
  const hadTabsBeforeStart = workspaces.current().tabs.length > 0;

  await store.start();

  // The spellcheck settings that all devices share live in a hidden record
  // (model/docs.js, SETTINGS_ID). The editor module gets them here, now and
  // after each change: one made in this window, in another window, or on
  // another device (a pull).
  setShared(store.sharedSettings());
  store.events.addEventListener("shared-settings", () => setShared(store.sharedSettings()));
  // A locked device keeps a revision of the settings it could not read
  // (model/docs.js, applyRemoteSettings). The unlock is the moment to merge
  // it; a sync round does the same, but it can be a minute away.
  keyring.addEventListener("change", () => {
    if (keyring.isUnlocked) void store.refreshSharedSettings();
  });

  if (ownSpace && initialSpaceBoot && sync.isConfigured) {
    const initialBlankId = hadTabsBeforeStart ? null : store.activeId;
    void store
      .fetchSpaceStubs(ownSpace, (id) => sync.fetchDoc(id), { initialBlankId })
      .then((fetched) => {
        if (fetched.failed > 0) {
          statusbar.notice(
            fetched.failed === 1
              ? "offline: 1 note could not be fetched"
              : "offline: " + fetched.failed + " notes could not be fetched"
          );
        }
      });
  }
  // When phone mode starts back on the note list, focus the active row the
  // same way the thumb menu's list button does (scrolls it into view and
  // keeps focus off the editor underneath).
  if (phoneMode() && shell.isOpen()) run("sidebar.focus");
  folders.start();
  workspaces.start({ isDesktop });
  // After the store is up and listening to the keyring: an answer flips the
  // locked placeholders to text.
  keyring.askUnlock();
  // The switch "Ask for a passphrase at start" (§27), and the one-time
  // question of a device from before: asked now, not at the first note. A
  // window that another one unlocks meanwhile skips the prompt.
  if (keyring.isSetUp && !keyring.isUnlocked) {
    setTimeout(() => {
      if (!keyring.isUnlocked && !document.querySelector("dialog[open]")) void run("crypto.unlock");
    }, 300);
  }
  // The upgrade (§27): a device that still holds the server token of the
  // time before asks, once per start, whether it is the first device or
  // joins with a code. In the main window only, and after the unlock above.
  let upgradeOffered = false;
  const offerUpgrade = () => {
    if (upgradeOffered || !sync.needsUpgrade || workspaces.id !== MAIN_WORKSPACE) return;
    if (document.querySelector("dialog[open]") || (keyring.isSetUp && !keyring.isUnlocked)) return;
    upgradeOffered = true;
    void run(keyring.isSetUp ? "device.connect" : "device.setup");
  };
  setTimeout(offerUpgrade, 800);
  keyring.addEventListener("change", () => setTimeout(offerUpgrade, 300));
  // Last: its first run pulls, and a pull emits "replace" and "active" into UI
  // that has to be mounted already. One client per origin (architecture.md
  // §14.3, the lock ships with §14.2): the window that holds the lock runs
  // the schedule, the others keep their config loaded and wait. The lock
  // releases when its window closes, and the next request in line starts.
  if (navigator.locks) {
    navigator.locks
      .request("vrtti:sync", () => {
        sync.start();
        return new Promise(() => {});
      })
      .catch((err) => console.log("[vrtti] sync lock", err));
  } else {
    sync.start();
  }

  // Exposed for the Playwright checks; the UI itself never calls these.
  // @ts-ignore - deliberate global test hook
  window.vrtti = {
    buffers: store.buffers,
    workspaces,
    get activeId() {
      return store.activeId;
    },
    createBuffer: () => run("buffer.new"),
    closeBuffer: (id) => run("buffer.close", id),
    activateBuffer: (id) => run("buffer.activate", id),
    setSyntax: (lang) => run("syntax.set", lang),
    renameBuffer: (id, name) => run("buffer.rename", { id, name }),
    toggleSidebar: () => run("sidebar.toggle"),
    deleteBuffer,
    // Crypto surface for the checks. The UI reaches all of this through
    // commands and the settings panel; nothing here is an app code path.
    keyring,
    codec,
    age,
    keyringRecord: () => store.keyringRecord(),
    textOf: (id) => store.textOf(id),
    // One body per note (architecture.md §23).
    body: (id) => store.body(id),
    unlinkFile: (id) => store.unlinkFile(id),
    stampRecentFiles: () => store.stampRecentFiles(),
    checkExternalChanges: () => store.checkExternalChanges(),
    saveNow: (id) => store.saveNow(id),
    reopen: (id) => store.reopen(id),
    encrypt: (id, preset) => store.encrypt(id, preset),
    decrypt: (id) => store.decrypt(id),
    forkConflict: (id) => store.forkConflict(store.get(id)),
    // Sync surface for the checks (architecture.md §13.6). The app itself
    // reaches all of this through commands and the settings panel.
    sync,
    // The store itself, for the space checks (§27): typing, moves, the trash.
    store,
    applyRemote: (change) => store.applyRemote(change),
    // From server stubs (architecture.md §25).
    remotes: () => store.remotes(),
    createFromChange: (change, ws) => store.createFromChange(change, ws ?? workspaces.id),
    // Any command by id, for the checks that drive one with no UI yet.
    run,
    dirtyRecords: () => store.dirtyRecords(),
    trashed: () => store.trashed(),
    restore: (id, opts) => store.restore(id, opts),
    trashBuffer: (id) => store.trashBuffer(id),
    deleteForever: (id) => store.deleteForever(id),
    expireOldRecent: (now) => store.expireOldRecent(now),
    emptyOldTrash: (now) => store.emptyOldTrash(now),
    sidebar,
    settings: { get: getSetting, put: putSetting },
    // Spellcheck surface for the checks (architecture.md §11): the language
    // the last pass found, and the detector itself for table-driven cases.
    spell: { detect: detectLanguage, segments },
  };
}

start().catch((err) => console.error("[vrtti] startup failed", err));
