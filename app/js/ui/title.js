// @ts-check
// The window title: "<buffer> - vrtti", with the file's place inside its
// folder when it has one, so the taskbar button and the tab say what is on
// screen (the user asked for a title that fills the taskbar button). The
// browser tab takes document.title; the desktop shell has its own native
// title, set through the bridge.
//
// A secondary window ends in "vrtti session" instead. Closing it sends its
// tabs to Recent, while main comes back at every launch, and the two looked
// the same until the user closed the wrong one (architecture.md §14.5).

import { titleOf } from "../model/docs.js";
import { setWindowTitle } from "./desktop.js";

/**
 * @param {ReturnType<typeof import("../model/docs.js").createDocStore>} store
 * @param {{secondary?: boolean, space?: string}} [options]
 *   secondary: this window is not main. space: dedicated Space Window name (§28).
 */
export function mountTitle(store, { secondary = false, space = "" } = {}) {
  const app = space ? "vrtti" : secondary ? "vrtti session" : "vrtti";
  let last = "";

  function render() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    let text = space ? "(" + space + ") - " + app : app;
    if (record) {
      // A Space Window always marks its space name; elsewhere show the
      // folder-relative path when the file came from a folder (§2, §28).
      const place = space
        ? " (" + space + ")"
        : record.file?.path && record.file.path !== record.file.name
          ? " (" + record.file.path + ")"
          : "";
      text = titleOf(record) + place + " - " + app;
    }
    // Every keystroke emits "change"; only a changed title reaches the shell.
    if (text === last) return;
    last = text;
    document.title = text;
    setWindowTitle(text);
  }

  store.events.addEventListener("change", render);
  store.events.addEventListener("active", render);
  render();
}
