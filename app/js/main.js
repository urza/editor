// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

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
import { createWorkspaces, workspaceIdFromUrl } from "./model/workspace.js";
import { register, run } from "./commands/registry.js";
import { createSyncClient } from "./sync/client.js";
import * as age from "./crypto/age.js";
import {
  KeyRing,
  keyringContentFor,
  mergeKeyringContent,
  readKeyringContent,
  supportsStoredKeys,
} from "./crypto/keyring.js";
import { PALETTE } from "./crypto/spaces.js";
import * as codec from "./model/codec.js";
import { mountEditor } from "./editor/editor.js";
import { mountTransforms } from "./editor/transform.js";
import { detectedLanguages, isEnabled, setEnabled } from "./editor/spellcheck.js";
import { detectLanguage, segments } from "./editor/textlang.js";
import {
  askPassphrase,
  askText,
  choose,
  chooseMany,
  showBusy,
  showCode,
  showNote,
  showSecret,
} from "./ui/dialog.js";
import { mountSearch } from "./ui/search.js";
import { mountSettings } from "./ui/settings.js";
import { mountSidebar } from "./ui/sidebar.js";
import { mountStatusbar } from "./ui/statusbar.js";
import { mountTitle } from "./ui/title.js";
import { mountShortcuts } from "./ui/shortcuts.js";
import { closeWorkspaceWindow, mountDesktop, openWorkspaceWindow } from "./ui/desktop.js";
import { mountResizer } from "./ui/resizer.js";
import { mountShell } from "./ui/shell.js";
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

  register({
    id: "buffer.new",
    title: "New buffer",
    keys: "Alt+KeyN",
    run: () => store.create(),
  });
  register({
    id: "buffer.close",
    title: "Close buffer",
    keys: "Alt+KeyW",
    // No arg means the active buffer (the shortcut path).
    run: (id) => {
      const target = id ?? store.activeId;
      if (target) return store.close(target);
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
    run: (id) => store.reopen(id),
  });
  // The sidebar drag (architecture.md §9). `before` null puts the buffer last.
  register({
    id: "buffer.move",
    title: "Move buffer",
    run: ({ id, before }) => store.moveTab(id, before),
  });

  // Windows (architecture.md §14): a workspace is one window's context. The
  // browser opens a tab for it; the shell opens a native window (unit 14.4).
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
    run: (onStatus) => checkForUpdate(onStatus),
  });

  // Devices and keys (architecture.md §5, §27). No keyboard shortcuts: setup
  // runs once in a lifetime and unlock is dispatched by whatever needs a key.

  /**
   * The server token or the join code, as the first device or a new one
   * (§27). Returns false when the user walks away.
   * @returns {Promise<boolean>}
   */
  async function connectDevice() {
    const how = await choose({
      title: "Sync with a server",
      options: [
        {
          id: "join",
          label: "Join with a code",
          hint: "Another device of yours already syncs. In Settings › Devices there, use “Add a device”, then type the server URL and the code here.",
        },
        {
          id: "first",
          label: "First device on this server",
          hint: "Type the server URL and the VRTTI_TOKEN of the server. Your other devices then join with a code.",
        },
      ],
    });
    if (!how) return false;
    const url = await askText({
      title: "Server",
      label: "Server URL",
      value: sync.config.url,
      placeholder: "https://sync.example.com",
    });
    if (url === null) return false;
    if (how === "join") return run("device.join", url);
    const token = await askPassphrase({ title: "Server token", label: "VRTTI_TOKEN" });
    if (token === null) return false;
    const busy = showBusy("Registering this device…");
    try {
      await sync.registerFirst(url, token);
    } catch (err) {
      busy.close();
      await showNote({ title: "Not registered", text: String(/** @type {any} */ (err)?.message ?? err) });
      return false;
    }
    busy.close();
    await takeOverOldSpaces();
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

  register({
    id: "device.setup",
    title: "Set up this device",
    run: async () => {
      if (keyring.isSetUp) return connectDevice();
      const deviceName = await askText({
        title: "Set up this device",
        label: "Device name",
        value: defaultDeviceName(),
        hint: "Your other devices show this name. It cannot change later.",
      });
      if (deviceName === null) return false;
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
      const first = await choose({
        title: "Other devices",
        options: [
          { id: "first", label: "This is my first device", hint: "It makes your recovery key." },
          { id: "join", label: "Another device of mine syncs already", hint: "This device joins it with a code." },
        ],
      });
      if (!first) return false;
      const busy = showBusy("Generating keys…");
      /** @type {string | null} */
      let recoveryIdentity;
      try {
        ({ recoveryIdentity } = await keyring.setup({
          deviceName,
          askPassphrase: mode === "ask",
          passphrase,
          firstDevice: first === "first",
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
      if (first === "join") {
        const url = await askText({ title: "Server", label: "Server URL", placeholder: "https://sync.example.com" });
        if (url === null) return true;
        await run("device.join", url);
        return true;
      }
      const server = await choose({
        title: "Sync",
        options: [
          { id: "now", label: "Connect a server now", hint: "The server URL and the VRTTI_TOKEN." },
          { id: "later", label: "Later", hint: "Settings › Sync has it. Your notes stay on this device until then." },
        ],
      });
      if (server === "now") await connectDevice();
      return true;
    },
  });
  register({
    id: "device.join",
    title: "Join with a code",
    run: async (url) => {
      if (!keyring.isSetUp) return run("device.setup");
      let message = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = await askText({
          title: "Join with a code",
          label: "Code",
          placeholder: "K7MQ2-XWD4P",
          hint:
            (message ? message + " " : "") +
            "In Settings › Devices on a device of yours, use “Add a device” and tick the spaces this device gets. The code works once, for ten minutes.",
        });
        if (code === null) return false;
        const busy = showBusy("Joining…");
        try {
          await sync.redeem(url ?? sync.config.url, code);
          busy.close();
          await showNote({
            title: "Waiting for your other device",
            text: "This device joined the server. Your other device adds it to the spaces at its next sync; keep it open or open it now.",
          });
          return true;
        } catch (err) {
          busy.close();
          message = String(/** @type {any} */ (err)?.message ?? err) + ".";
          if (/** @type {any} */ (err)?.status !== 403) {
            await showNote({ title: "Not joined", text: message });
            return false;
          }
        }
      }
      return false;
    },
  });
  register({
    id: "device.connect",
    title: "Sync with a server",
    run: () => connectDevice(),
  });
  register({
    id: "device.invite",
    title: "Add a device",
    run: async () => {
      const spaces = sync.mySpaces();
      if (!spaces.length) return false;
      const picked = await chooseMany({
        title: "Add a device",
        hint: "The new device gets the spaces you tick. You can change this later in the grid.",
        options: spaces.map((space) => ({ id: space, label: space, checked: false })),
      });
      if (!picked || !picked.length) return false;
      const busy = showBusy("Making a code…");
      let code;
      try {
        code = await sync.invite(picked);
      } catch (err) {
        busy.close();
        await showNote({ title: "No code", text: String(/** @type {any} */ (err)?.message ?? err) });
        return false;
      } finally {
        busy.close();
      }
      await showCode({
        title: "Code for the new device",
        code,
        note:
          "On the new device, choose “Join with a code” and type the server URL " +
          sync.config.url + " and this code. It works once, for ten minutes. " +
          "Keep this device open: it adds the new device at its next sync.",
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
        await showNote({ title: "No new space", text: String(/** @type {any} */ (err)?.message ?? err) });
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
      await showNote({ title, text: String(/** @type {any} */ (err)?.message ?? err) });
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
      if (!to && !(await supportsStoredKeys())) {
        await showNote({ title: "Not possible here", text: "This browser cannot keep a key without a passphrase." });
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
        statusbar.notice("change failed");
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
          // typage reports a wrong passphrase and a corrupt blob with the same
          // error, and the user can only act on the first, so say that.
          message = "Wrong passphrase. Try again.";
          console.log("[vrtti] unlock failed", err);
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
    // the row menu's "Sync to" (§25); a bare id goes to the default space.
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
        await store.setSync(target, true, space);
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
      return true;
    },
  });
  register({
    id: "doc.move",
    title: "Move to a space",
    run: async ({ id, space }) => {
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      try {
        return await store.move(id, space);
      } catch (err) {
        console.log("[vrtti] move failed", err);
        statusbar.notice("move failed");
        return false;
      }
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
    run: async () => {
      if (!sync.isConfigured || !sync.defaultSpace()) return false;
      for (const record of store.openBuffers()) {
        if (!record.sync && !record.file) await store.setSync(record.id, true).catch(() => {});
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
    id: "sync.defaultSpace",
    title: "Set where new notes sync to",
    run: (name) => sync.setDefaultSpace(name),
  });
  register({
    id: "sync.defaultToggle",
    title: "Sync new notes",
    // Stores an explicit boolean, which is what takes this device off the
    // platform default for good (architecture.md §13.6).
    run: () => sync.toggleSyncDefault(),
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
        for (const change of await sync.allNotes(space)) {
          const read = await store.readForBackup(change);
          if (read) notes.push({ id: change.docId, ...read });
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
  // variable, and nothing from the editor controller.
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
  mountShell();
  mountNewButton();
  mountThumb();
  mountSidebar(store, folders, sync);
  const statusbar = mountStatusbar(store, sync, zoom);
  const pin = mountPin({ store, notice: (text) => statusbar.notice(text) });
  mountTitle(store, { secondary: workspaces.id !== MAIN_WORKSPACE });
  mountShortcuts();
  mountDesktop({
    workspaces,
    folders,
    isBlankBuffer: (id) => {
      const record = store.get(id);
      return !record || (record.kind !== "file" && !record.enc && !(record.content ?? "").trim());
    },
  });
  mountResizer();

  await store.start();
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
    restore: (id) => store.restore(id),
    settings: { get: getSetting, put: putSetting },
    // Spellcheck surface for the checks (architecture.md §11): the language
    // the last pass found, and the detector itself for table-driven cases.
    spell: { languages: detectedLanguages, detect: detectLanguage, segments },
  };
}

start().catch((err) => console.error("[vrtti] startup failed", err));
