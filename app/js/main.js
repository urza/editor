// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

import {
  deleteBuffer,
  getAllHandles,
  getSetting,
  openDb,
  putSetting,
} from "./storage/idb.js";
import { openFilePicker } from "./storage/fsa.js";
import { isNativeHandle, pruneRoots } from "./storage/native.js";
import {
  checkForUpdate,
  hasDisk,
  isDesktop,
  requestPersistence,
} from "./model/capabilities.js";
import { createDocStore, firstLineTitle, KEYRING_ID } from "./model/docs.js";
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
} from "./crypto/keyring.js";
import * as codec from "./model/codec.js";
import { mountEditor } from "./editor/editor.js";
import { detectedLanguages, isEnabled, setEnabled } from "./editor/spellcheck.js";
import { detectLanguage, segments } from "./editor/textlang.js";
import { askPassphrase, askText, choose, showBusy, showSecret } from "./ui/dialog.js";
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
    workspaces,
  });
  await store.load();

  sync = createSyncClient({ store, keyring });
  // Before store.start(): the first buffer of a fresh install is created there,
  // and whether it syncs depends on the setting this reads.
  await sync.load();

  // Peers are read after store.load(), because the keyring resolves "all
  // devices" against the hidden keyring record the store just read (§13.3).
  /** Point the keyring at the hidden record: it resolves trust from it (§21). */
  function refreshPeers() {
    keyring.setContent(readKeyringContent(store.keyringRecord()));
  }
  refreshPeers();
  // The record also changes when a pull merges another device into it, so the
  // peers follow the record itself and not the one command that writes it.
  store.events.addEventListener("system", refreshPeers);

  /**
   * Write a new keyring content into the hidden record (architecture.md
   * §13.3, §21). Dirty when synced, so the other devices learn of it.
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
   * After an unlock: the record learns this device's signing key and its
   * self-approved recovery keys, once (architecture.md §21). A device from
   * before the unit gets its key in the same unlock.
   */
  async function ensureOwnEntry() {
    if (!keyring.isUnlocked) return;
    const next = keyring.selfUpdate();
    if (next) await writeKeyring(next);
  }

  // Dialogs a cancelled answer must not repeat in this session; the Settings
  // device list keeps a button for each.
  /** @type {Set<string>} */
  const dismissedJoins = new Set();
  /** @type {Set<string>} */
  const dismissedApprovers = new Set();
  let offering = false;

  /**
   * The two questions of §21, asked where they can be answered: this window
   * has focus, the keyring is unlocked, and no other dialog is open. One
   * question at a time; the record write after each answer runs this again.
   */
  async function offerApprovals() {
    if (offering || !keyring.isUnlocked || !document.hasFocus()) return;
    if (document.querySelector("dialog[open]")) return;
    offering = true;
    try {
      const approver = keyring.pendingApprovers().find((d) => !dismissedApprovers.has(d.id));
      if (approver) {
        if (!(await run("crypto.confirm", approver.id))) dismissedApprovers.add(approver.id);
        return;
      }
      const join = keyring.pendingJoins().find((d) => !dismissedJoins.has(d.id));
      if (join) {
        if (!(await run("crypto.approve", join.id))) dismissedJoins.add(join.id);
      }
    } finally {
      offering = false;
    }
  }
  store.events.addEventListener("system", () => void offerApprovals());
  keyring.addEventListener("change", () => {
    if (!keyring.isUnlocked) return;
    void ensureOwnEntry().then(offerApprovals);
  });
  window.addEventListener("focus", () => void offerApprovals());

  // Built on every platform: without a disk backend no directory handle can be
  // stored, so the store loads nothing and the sidebar draws no section. Only
  // its entry points are gated, below.
  const folders = createFolderStore({ workspaces });
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

  // Encryption (architecture.md §5, §13.2). No keyboard shortcuts: setup runs
  // once in a lifetime and unlock is dispatched by whatever needs a key.
  /**
   * One sync run, awaited through the status: the leader resolves its own
   * run, a mirror window hears the leader's status over the channel
   * (architecture.md §14.3). Resolves with the final state, or "timeout".
   * @returns {Promise<string>}
   */
  function syncOnce() {
    return new Promise((resolve) => {
      /** @param {Event} event */
      const done = (event) => {
        const state = /** @type {CustomEvent} */ (event).detail?.state;
        if (state === "syncing") return;
        finish(state ?? "unknown");
      };
      /** @param {string} state */
      const finish = (state) => {
        sync.events.removeEventListener("status", done);
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => finish("timeout"), 15000);
      sync.events.addEventListener("status", done);
      void sync.syncNow();
    });
  }

  register({
    id: "crypto.setup",
    title: "Set up encryption",
    run: async () => {
      if (keyring.isSetUp) return false;
      // The join-order guard (architecture.md §20). A device that sets up
      // before it has pulled the keyring mints a second recovery key, and
      // the merge keeps both for ever. So with a server configured and no
      // keyring record here, one sync runs first; the record then arrives or
      // the server has none. Only an unreachable server leaves it open, and
      // then the user decides.
      if (sync.isConfigured && !store.keyringRecord()) {
        const busy = showBusy("Looking for a keyring on the server…");
        let state = "";
        try {
          state = await syncOnce();
        } finally {
          busy.close();
        }
        if (!store.keyringRecord() && state !== "idle") {
          const answer = await choose({
            title: "The server could not be reached",
            options: [
              {
                id: "later",
                label: "Set up later",
                hint: "If another device already uses encryption, set up after a sync so this device joins that keyring.",
              },
              {
                id: "anyway",
                label: "Set up anyway",
                hint: "Creates a new keyring and a second recovery key. The keyrings merge later, and both recovery keys stay valid.",
              },
            ],
          });
          if (answer !== "anyway") return false;
        }
      }
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
          joining: Boolean(existing),
        }));
        const now = Date.now();
        /** @type {import("./storage/idb.js").BufferRecord} */
        const record = {
          id: KEYRING_ID,
          kind: "keyring",
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
  // The two sides of a join (architecture.md §21). Both take a device id from
  // the record; offerApprovals() dispatches them, and the Settings device
  // list has a button for each.
  register({
    id: "crypto.approve",
    title: "Approve a device",
    run: async (id) => {
      if (!keyring.isUnlocked && !(await run("crypto.unlock"))) return false;
      const device = keyring.content?.devices.find((d) => d.id === id);
      if (!device) return false;
      let message = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = await askText({
          title: "“" + device.name + "” wants to join",
          label: "Pairing code",
          hint:
            (message ? message + " " : "") +
            "Type the six digits shown under Settings › Security on that device. A code that does not match means the entry did not come from your device.",
          placeholder: "000 000",
        });
        if (code === null) return false;
        const next = keyring.approve(id, code);
        if (next) {
          await writeKeyring(next);
          return true;
        }
        message = "The code does not match.";
      }
      return false;
    },
  });
  register({
    id: "crypto.confirm",
    title: "Confirm an approving device",
    run: async (id) => {
      const device = keyring.content?.devices.find((d) => d.id === id);
      if (!device || !device.signKey) return false;
      const answer = await choose({
        title: "Approved by “" + device.name + "”",
        options: [
          {
            id: "yes",
            label: "Yes, that is my device",
            hint:
              "Its fingerprint is " + keyring.fingerprint(device.signKey) +
              ". The same fingerprint stands under Settings › Security on that device.",
          },
          {
            id: "no",
            label: "No",
            hint: "This device keeps trusting only itself. Ask again from the device list in Settings.",
          },
        ],
      });
      if (answer !== "yes") return false;
      await keyring.confirm(id);
      return true;
    },
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
      // stay readable and can change it before it leaves the device. A file
      // is prefilled with its name instead: the name is plaintext on disk
      // already, and it is what the other devices see, because a file-backed
      // doc syncs as a scratch doc (§13.5).
      const record = store.get(target);
      const label = await askText({
        title: "Name for the encrypted document",
        label: "Plaintext name",
        value:
          record?.title ||
          (record?.file ? record.file.name : firstLineTitle(record?.content)),
        hint: "Shown in the sidebar and stored unencrypted, also on the sync server. Leave it empty for no name.",
        allowEmpty: true,
      });
      if (label === null) return false;
      try {
        await store.encrypt(target, /** @type {any} */ (preset), label);
      } catch (err) {
        // A file that cannot be renamed to `.age` (a taken name, a lost
        // permission) stays as it was; the record was not touched.
        console.log("[vrtti] encrypt failed", err);
        return false;
      }
      await refreshFolders(record);
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
      const record = store.get(target);
      try {
        await store.decrypt(target);
      } catch (err) {
        console.log("[vrtti] decrypt failed", err);
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
  // Kept, unlike before: search in files reveals a hit through this controller
  // (architecture.md §16).
  const editor = mountEditor(host, store);

  // Mounted before its command, because the command dispatches into the
  // controller the mount returns. The sidebar button below dispatches the id.
  const settings = mountSettings({ keyring, sync });
  register({
    id: "settings.toggle",
    title: "Settings",
    run: () => settings.toggle(),
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
  mountSidebar(store, folders, sync);
  mountStatusbar(store, sync);
  mountTitle(store);
  mountShortcuts();
  mountDesktop({
    workspaces,
    isBlankBuffer: (id) => {
      const record = store.get(id);
      return !record || (record.kind !== "file" && !record.enc && !record.content.trim());
    },
  });
  mountResizer();

  await store.start();
  folders.start();
  workspaces.start({ isDesktop });
  // After the store is up and listening to the keyring: an answer flips the
  // locked placeholders to text.
  keyring.askUnlock();
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
    encrypt: (id, preset) => store.encrypt(id, preset),
    decrypt: (id) => store.decrypt(id),
    forkConflict: (id) => store.forkConflict(store.get(id)),
    // Sync surface for the checks (architecture.md §13.6). The app itself
    // reaches all of this through commands and the settings panel.
    sync,
    applyRemote: (change) => store.applyRemote(change),
    dirtyRecords: () => store.dirtyRecords(),
    settings: { get: getSetting, put: putSetting },
    // Spellcheck surface for the checks (architecture.md §11): the language
    // the last pass found, and the detector itself for table-driven cases.
    spell: { languages: detectedLanguages, detect: detectLanguage, segments },
  };
}

start().catch((err) => console.error("[vrtti] startup failed", err));
