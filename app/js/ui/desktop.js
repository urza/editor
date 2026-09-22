// @ts-check
// The desktop shell (src-tauri/) around the deployed page. The shell sets
// window.vrttiDesktop before any page script and delivers its menu chords as
// "vrtti:command" DOM events, so this module is the page's whole knowledge of
// the shell and nothing here imports Tauri (desktop-wrapper-goose-patterns.md
// §3: the page depends on a small contract, never on the transport).

import { run } from "../commands/registry.js";
import { isDesktop } from "../model/capabilities.js";
import { on } from "../model/channel.js";
import { MAIN_WORKSPACE } from "../storage/idb.js";

// The keydown fallback for the chords the native menu carries
// (src-tauri/src/lib.rs, CHORDS). Physical key codes, like ui/shortcuts.js.
// On Windows this fallback is the path that works: the menu accelerator does
// not fire while the webview has focus (architecture.md §15, spike log).
const CHORDS = {
  KeyN: "buffer.new",
  KeyS: "buffer.save",
  KeyW: "buffer.close",
};
const SHIFT_CHORDS = {
  KeyN: "workspace.new",
  KeyW: "workspace.close",
};

/**
 * The shell's IPC. Only two commands exist for the page
 * (src-tauri/capabilities/default.json), both about windows (§14.4).
 * @param {string} command @param {object} args
 */
function invoke(command, args) {
  const core = /** @type {any} */ (window).__TAURI__?.core;
  if (!core) return Promise.reject(new Error("no shell IPC"));
  return core.invoke(command, args);
}

// A chord can reach the page twice on some platforms: once as the native
// menu accelerator and once as the raw keydown, a few milliseconds apart.
// The first delivery runs the command, a repeat inside this window is dropped.
const DUPLICATE_MS = 50;

/**
 * Open the window for a workspace (architecture.md §14.2). In a browser it
 * is a named window.open, which must run inside the user's gesture; the
 * shell opens a native window instead (unit 14.4).
 * @param {string} id
 */
export function openWorkspaceWindow(id) {
  if (isDesktop) {
    invoke("open_workspace", { id }).catch((err) =>
      console.log("[vrtti desktop] open window failed", err)
    );
    return;
  }
  const url = new URL(location.href);
  url.search = "?ws=" + encodeURIComponent(id);
  window.open(url.toString(), "vrtti-ws-" + id);
}

/**
 * @param {{workspaces: ReturnType<typeof import("../model/workspace.js").createWorkspaces>}} deps
 */
/**
 * Close a workspace's window through the shell (§14.4). A browser can close
 * only a tab it opened itself.
 * @param {string} id
 */
export function closeWorkspaceWindow(id) {
  if (!isDesktop) {
    window.close();
    return;
  }
  invoke("close_workspace", { id }).catch((err) =>
    console.log("[vrtti desktop] close window failed", err)
  );
}

export function mountDesktop({ workspaces }) {
  if (!isDesktop) return;

  /** @type {Map<string, number>} */
  const lastRun = new Map();

  /** @param {string} id @param {string} source @param {any} [arg] */
  function dispatch(id, source, arg) {
    const now = performance.now();
    const duplicate = now - (lastRun.get(id) ?? -Infinity) < DUPLICATE_MS;
    // Spike step 2 and 3 (desktop-wrapper-tauri-vs-wails.md §8): the console
    // shows which path delivered each chord on each platform.
    console.log(`[vrtti desktop] ${id} via ${source}${duplicate ? " (duplicate, dropped)" : ""}`);
    if (duplicate) return;
    lastRun.set(id, now);
    run(id, arg);
  }

  // Menu chords, and the shell's own requests: a closing window's
  // workspace.dissolve arrives here with the workspace id as `arg`.
  window.addEventListener("vrtti:command", (event) => {
    const detail = /** @type {CustomEvent<{ id: string, arg?: any }>} */ (event).detail;
    if (detail?.id) dispatch(detail.id, "menu", detail.arg);
  });

  // The ready handshake (desktop-wrapper-goose-patterns.md §1): the shell
  // queues a chord or a dissolve for this window until this call, so a key
  // pressed during the boot is not lost.
  invoke("page_ready", {}).catch((err) => console.log("[vrtti desktop] ready failed", err));

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const table = event.shiftKey ? SHIFT_CHORDS : CHORDS;
    const id = table[/** @type {keyof typeof table} */ (event.code)];
    if (!id) return;
    // Also stops the webview's own handling, such as WebView2's "save page as"
    // dialog on Ctrl+S.
    event.preventDefault();
    dispatch(id, "keydown");
  });

  // A buffer open in this window was asked for elsewhere: this window comes
  // forward (§14.2 posts focus, §14.4 answers it natively).
  on("focus", ({ ws }) => {
    if (ws !== workspaces.id) return;
    invoke("focus_workspace", { id: ws }).catch((err) =>
      console.log("[vrtti desktop] focus failed", err)
    );
  });

  // Launch: the shell opens only main, and main asks for a window for every
  // workspace whose lock nobody holds (§14.4). A reload of main while the
  // others are up finds their locks held and asks for nothing. An empty
  // workspace (no tabs, no folders) is what a window that never booted
  // leaves behind, a crash or a kill; it has nothing to bring back and is
  // dissolved instead, or every such launch would add a blank window.
  if (workspaces.id === MAIN_WORKSPACE) {
    workspaces
      .liveSet()
      .then((live) => {
        for (const record of workspaces.all()) {
          if (record.id === MAIN_WORKSPACE || live.has(record.id)) continue;
          if (record.tabs.length === 0 && record.folderIds.length === 0) {
            void workspaces.dissolve(record.id);
            continue;
          }
          openWorkspaceWindow(record.id);
        }
      })
      .catch((err) => console.log("[vrtti desktop] reopen failed", err));
  }
}
