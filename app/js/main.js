// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

import { deleteBuffer, openDb } from "./storage/idb.js";
import { openFilePicker } from "./storage/fsa.js";
import {
  checkForUpdate,
  hasFileSystemAccess,
  requestPersistence,
} from "./model/capabilities.js";
import { createDocStore } from "./model/docs.js";
import { createFolderStore } from "./model/folders.js";
import { register, run } from "./commands/registry.js";
import { mountEditor } from "./editor/editor.js";
import { isEnabled, setEnabled } from "./editor/spellcheck.js";
import { mountSidebar } from "./ui/sidebar.js";
import { mountStatusbar } from "./ui/statusbar.js";
import { mountShortcuts } from "./ui/shortcuts.js";
import { mountResizer } from "./ui/resizer.js";

async function start() {
  requestPersistence();
  await openDb();

  const store = createDocStore();
  await store.load();

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
    id: "app.update",
    title: "Check for update",
    run: (onStatus) => checkForUpdate(onStatus),
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
  mountSidebar(store, folders);
  mountStatusbar(store);
  mountShortcuts();
  mountResizer();

  await store.start();
  folders.start();

  // Exposed for the Playwright checks; the UI itself never calls these.
  // @ts-ignore - deliberate global test hook
  window.vrtti = {
    buffers: store.buffers,
    createBuffer: () => run("buffer.new"),
    closeBuffer: (id) => run("buffer.close", id),
    deleteBuffer,
  };
}

start().catch((err) => console.error("[vrtti] startup failed", err));
