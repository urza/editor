// @ts-check
// The desktop shell (src-tauri/) around the deployed page. The shell sets
// window.vrttiDesktop before any page script and delivers its menu chords as
// "vrtti:command" DOM events, so this module is the page's whole knowledge of
// the shell and nothing here imports Tauri (desktop-wrapper-goose-patterns.md
// §3: the page depends on a small contract, never on the transport).

import { run } from "../commands/registry.js";
import { isDesktop } from "../model/capabilities.js";

// The keydown fallback for the same three chords the native menu carries
// (src-tauri/src/lib.rs, CHORDS). Physical key codes, like ui/shortcuts.js.
const CHORDS = {
  KeyN: "buffer.new",
  KeyS: "buffer.save",
  KeyW: "buffer.close",
};

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
    console.log("[vrtti desktop] new window for", id, "waits for unit 14.4");
    return;
  }
  const url = new URL(location.href);
  url.search = "?ws=" + encodeURIComponent(id);
  window.open(url.toString(), "vrtti-ws-" + id);
}

export function mountDesktop() {
  if (!isDesktop) return;

  /** @type {Map<string, number>} */
  const lastRun = new Map();

  /** @param {string} id @param {string} source */
  function dispatch(id, source) {
    const now = performance.now();
    const duplicate = now - (lastRun.get(id) ?? -Infinity) < DUPLICATE_MS;
    // Spike step 2 and 3 (desktop-wrapper-tauri-vs-wails.md §8): the console
    // shows which path delivered each chord on each platform.
    console.log(`[vrtti desktop] ${id} via ${source}${duplicate ? " (duplicate, dropped)" : ""}`);
    if (duplicate) return;
    lastRun.set(id, now);
    run(id);
  }

  window.addEventListener("vrtti:command", (event) => {
    const id = /** @type {CustomEvent<{ id: string }>} */ (event).detail?.id;
    if (id) dispatch(id, "menu");
  });

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const id = CHORDS[/** @type {keyof typeof CHORDS} */ (event.code)];
    if (!id) return;
    // Also stops the webview's own handling, such as WebView2's "save page as"
    // dialog on Ctrl+S.
    event.preventDefault();
    dispatch(id, "keydown");
  });
}
