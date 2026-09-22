// @ts-check
// The window title: "<buffer> - vrtti", with the file's place inside its
// folder when it has one, so the taskbar button and the tab say what is on
// screen (the user asked for a title that fills the taskbar button). The
// browser tab takes document.title; the desktop shell has its own native
// title, set through the bridge.

import { titleOf } from "../model/docs.js";
import { setWindowTitle } from "./desktop.js";

/** @param {ReturnType<typeof import("../model/docs.js").createDocStore>} store */
export function mountTitle(store) {
  let last = "";

  function render() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    let text = "vrtti";
    if (record) {
      // The folder-relative path, when the file came from a folder; the
      // absolute path is not available to a page (architecture.md §2).
      const place = record.file?.path && record.file.path !== record.file.name
        ? " (" + record.file.path + ")"
        : "";
      text = titleOf(record) + place + " - vrtti";
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
