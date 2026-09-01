// @ts-check
// Bootstrap only: open storage, build the store, register commands, mount the
// UI, start. All behavior lives in the modules (architecture.md §6).
// Frameworkless on purpose.

import { deleteBuffer, openDb } from "./storage/idb.js";
import { checkForUpdate, requestPersistence } from "./model/capabilities.js";
import { createDocStore } from "./model/docs.js";
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

  const host = /** @type {HTMLElement} */ (document.getElementById("editor-host"));
  mountEditor(host, store);
  mountSidebar(store);
  mountStatusbar(store);
  mountShortcuts();
  mountResizer();

  await store.start();

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
