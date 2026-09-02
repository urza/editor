// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

import { deleteBuffer, getSetting, openDb, putSetting } from "./storage/idb.js";
import { openFilePicker } from "./storage/fsa.js";
import {
  checkForUpdate,
  hasFileSystemAccess,
  requestPersistence,
} from "./model/capabilities.js";
import { createDocStore, firstLineTitle, KEYRING_ID } from "./model/docs.js";
import { createFolderStore } from "./model/folders.js";
import { register, run } from "./commands/registry.js";
import { createSyncClient } from "./sync/client.js";
import * as age from "./crypto/age.js";
import {
  KeyRing,
  keyringContentFor,
  mergeKeyringContent,
  readKeyringContent,
} from "./crypto/keyring.js";
import * as codec from "./model/codec.js";
import { mountEditor } from "./editor/editor.js";
import { isEnabled, setEnabled } from "./editor/spellcheck.js";
import { askPassphrase, askText, choose, showBusy, showSecret } from "./ui/dialog.js";
import { mountSettings } from "./ui/settings.js";
import { mountSidebar } from "./ui/sidebar.js";
import { mountStatusbar } from "./ui/statusbar.js";
import { mountShortcuts } from "./ui/shortcuts.js";
import { mountResizer } from "./ui/resizer.js";
import { mountShell } from "./ui/shell.js";
import { showHistory } from "./ui/history.js";

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
  requestPersistence();
  await openDb();

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
  });
  await store.load();

  sync = createSyncClient({ store, keyring });
  // Before store.start(): the first buffer of a fresh install is created there,
  // and whether it syncs depends on the setting this reads.
  await sync.load();

  // Peers are read after store.load(), because the keyring resolves "all
  // devices" against the hidden keyring record the store just read (§13.3).
  /** Point the keyring at the device list in the hidden record. */
  function refreshPeers() {
    const content = readKeyringContent(store.keyringRecord());
    // Peers are the OTHER devices; this one is already in every recipient set.
    keyring.setPeers(
      (content ? content.devices : []).filter((d) => d.id !== keyring.deviceId)
    );
  }
  refreshPeers();
  // The record also changes when a pull merges another device into it, so the
  // peers follow the record itself and not the one command that writes it.
  store.events.addEventListener("system", refreshPeers);

  // Built on every platform: without the File System Access API no directory
  // handle can be stored, so the store loads nothing and the sidebar draws no
  // section. Only its entry points are gated, below.
  const folders = createFolderStore();
  await folders.load();

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
      // An open folder section still lists the old name. Re-listing costs one
      // directory read per open folder, and only a real rename pays it.
      for (const folderId of [...folders.folders.keys()]) await folders.refresh(folderId);
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

  // Encryption (architecture.md §5, §13.2). No keyboard shortcuts: setup runs
  // once in a lifetime and unlock is dispatched by whatever needs a key.
  register({
    id: "crypto.setup",
    title: "Set up encryption",
    run: async () => {
      if (keyring.isSetUp) return false;
      const deviceName = await askText({
        title: "Set up encryption",
        label: "Device name",
        value: defaultDeviceName(),
        hint: "Shown in the keyring so you can tell your devices apart.",
      });
      if (deviceName === null) return false;
      const passphrase = await askPassphrase({
        title: "Choose a passphrase",
        confirm: true,
      });
      if (passphrase === null) return false;

      const busy = showBusy("Generating keys…");
      /** @type {string | null} */
      let recoveryIdentity;
      try {
        // A keyring record already here came from the server: this device is
        // joining a keyring that exists. It adopts the recovery recipients and
        // mints no second paper key, so setup() returns null and the recovery
        // dialog below is skipped (architecture.md §13.2, §13.3).
        const previous = store.keyringRecord();
        const existing = readKeyringContent(previous);
        ({ recoveryIdentity } = await keyring.setup(passphrase, {
          deviceName,
          existingRecovery: existing ? existing.recovery : undefined,
        }));
        const now = Date.now();
        /** @type {import("./storage/idb.js").BufferRecord} */
        const record = {
          id: KEYRING_ID,
          kind: "keyring",
          closed: false,
          createdAt: now,
          ...previous,
          // Union, never replace: the pulled list already names the other
          // devices, and dropping them would leave them out of every future
          // "all my devices" recipient set (architecture.md §13.3).
          content: JSON.stringify(
            mergeKeyringContent(existing, keyringContentFor(keyring))
          ),
          updatedAt: now,
        };
        // The other devices have to learn about this one. Harmless with no
        // server configured: the flag simply waits for one.
        if (record.sync) record.sync = { ...record.sync, dirty: true };
        // Emits "system", which refreshes the peers.
        await store.putSystemRecord(record);
      } finally {
        busy.close();
      }

      if (recoveryIdentity) {
        await showSecret({
          title: "Recovery key",
          text: recoveryIdentity,
          note:
            "Write this down and keep it offline. It is shown once and never " +
            "stored. It restores every document, on any device, with the age " +
            "command line tool alone.",
        });
      }
      return true;
    },
  });
  register({
    id: "crypto.unlock",
    title: "Unlock encryption",
    // Resolves true when the identity is in memory afterwards, so a caller that
    // hit a locked document can simply retry its own work.
    run: async () => {
      if (!keyring.isSetUp) return false;
      if (keyring.isUnlocked) return true;
      let message = "";
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
      return false;
    },
  });
  register({
    id: "crypto.lock",
    title: "Lock encryption",
    run: () => keyring.lock(),
  });

  // Per-document encryption (architecture.md §13.4). The commands own the
  // prompts; the store owns the records and refuses to work while locked.
  register({
    id: "doc.encrypt",
    title: "Encrypt document",
    // No arg means the active buffer, like buffer.close.
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      // The first encryption is also the moment encryption gets set up. Both
      // steps return false when the user walks away from their dialog.
      if (!keyring.isSetUp && !(await run("crypto.setup"))) return false;
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const preset = await choose({
        title: "Encrypt to",
        options: [
          {
            id: "all-devices",
            label: "All my devices",
            hint: "Every device in the keyring, plus the recovery key.",
          },
          {
            id: "this-device",
            label: "This device only",
            hint: "Plus the recovery key.",
          },
        ],
      });
      if (!preset) return false;
      // The label is plaintext everywhere, server included (architecture.md
      // §5). Prefilled with the first line, so the user sees exactly what will
      // stay readable and can change it before it leaves the device.
      const record = store.get(target);
      const label = await askText({
        title: "Name for the encrypted document",
        label: "Plaintext name",
        value: record?.title || firstLineTitle(record?.content),
        hint: "Shown in the sidebar and stored unencrypted, also on the sync server. Leave it empty for no name.",
        allowEmpty: true,
      });
      if (label === null) return false;
      await store.encrypt(target, /** @type {any} */ (preset), label);
      return true;
    },
  });
  register({
    id: "doc.decrypt",
    title: "Decrypt document",
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      // Decrypting needs the key as much as reading does: the plaintext comes
      // out of the ciphertext, and nothing else holds it.
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      await store.decrypt(target);
      return true;
    },
  });

  // Sync (architecture.md §3, §13.6). Registered on every platform: sync is a
  // server target, and every platform can hold one. The client stays inert
  // until a URL and a token exist, so each of these is a no-op until then.
  register({
    id: "sync.configure",
    title: "Set the sync server",
    // The settings rows dispatch this instead of calling the client, so the
    // panel keeps its rule: an item never writes state itself.
    run: (next) => sync.configure(next ?? {}),
  });
  register({
    id: "doc.sync.on",
    title: "Sync this document",
    // No arg means the active buffer, like buffer.close.
    run: async (id) => {
      const target = id ?? store.activeId;
      if (!target) return false;
      if (!sync.isConfigured) {
        // A log, not a dialog: the row menu already carries the hint that says
        // where a server is set, and this path is only reachable around it.
        console.log("[vrtti] sync: no server configured");
        return false;
      }
      await store.setSync(target, true);
      return true;
    },
  });
  register({
    id: "doc.sync.off",
    title: "Stop syncing this document",
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
    id: "sync.now",
    title: "Sync now",
    run: () => sync.syncNow(),
  });
  register({
    id: "sync.all",
    title: "Sync all current documents",
    // The bulk switch of architecture.md §3: it only sets the per-document
    // flag, one document at a time. There is no second kind of sync target.
    run: async () => {
      if (!sync.isConfigured) return false;
      for (const record of store.openBuffers()) {
        if (!record.sync) await store.setSync(record.id, true);
      }
      return true;
    },
  });
  register({
    id: "sync.defaultToggle",
    title: "New documents sync by default",
    // Stores an explicit boolean, which is what takes this device off the
    // platform default for good (architecture.md §13.6).
    run: () => sync.toggleSyncDefault(),
  });
  register({
    id: "doc.history",
    title: "Document history…",
    run: async (id) => {
      const target = id ?? store.activeId;
      const record = target ? store.get(target) : undefined;
      if (!record || !sync.isConfigured) return false;
      await showHistory({ record, client: sync, store });
      return true;
    },
  });

  // Desktop disk files (architecture.md §2). Registered only where the API
  // exists, so a Firefox or iOS build has no command that could ever run.
  if (hasFileSystemAccess) {
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
  mountEditor(host, store);

  // Mounted before its command, because the command dispatches into the
  // controller the mount returns. The sidebar button below dispatches the id.
  const settings = mountSettings({ keyring, sync });
  register({
    id: "settings.toggle",
    title: "Settings",
    run: () => settings.toggle(),
  });

  // Before the sidebar: its rows dispatch sidebar.autoclose, and before
  // mountShortcuts, which snapshots the chord table once.
  mountShell();
  mountSidebar(store, folders, sync);
  mountStatusbar(store, sync);
  mountShortcuts();
  mountResizer();

  await store.start();
  folders.start();
  // Last: its first run pulls, and a pull emits "replace" and "active" into UI
  // that has to be mounted already.
  sync.start();

  // Exposed for the Playwright checks; the UI itself never calls these.
  // @ts-ignore - deliberate global test hook
  window.vrtti = {
    buffers: store.buffers,
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
    encrypt: (id, preset) => store.encrypt(id, preset),
    decrypt: (id) => store.decrypt(id),
    forkConflict: (id) => store.forkConflict(store.get(id)),
    // Sync surface for the checks (architecture.md §13.6). The app itself
    // reaches all of this through commands and the settings panel.
    sync,
    applyRemote: (change) => store.applyRemote(change),
    dirtyRecords: () => store.dirtyRecords(),
    settings: { get: getSetting, put: putSetting },
  };
}

start().catch((err) => console.error("[vrtti] startup failed", err));
