// @ts-check
// Sidebar: the Open and Recent buffer lists. Reads the store, dispatches
// commands, owns its DOM region. All user-derived text goes through
// textContent.

import { titleOf } from "../model/docs.js";
import { run } from "../commands/registry.js";

/** @typedef {import("../storage/idb.js").BufferRecord} BufferRecord */

/** @param {ReturnType<import("../model/docs.js").createDocStore>} store */
export function mountSidebar(store) {
  const openList = /** @type {HTMLElement} */ (document.getElementById("open-list"));
  const recentList = /** @type {HTMLElement} */ (document.getElementById("recent-list"));

  const newButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  newButton.addEventListener("click", () => run("buffer.new"));

  const recentHeading = /** @type {HTMLElement} */ (document.getElementById("recent-heading"));

  // Closed buffers must not clutter the sidebar (user decision, 2026-09-01):
  // Recent is collapsed by default and only the heading with a count shows.
  const COLLAPSED_KEY = "vrtti.recentCollapsed";
  let recentCollapsed = localStorage.getItem(COLLAPSED_KEY) !== "0";
  recentHeading.addEventListener("click", () => {
    recentCollapsed = !recentCollapsed;
    localStorage.setItem(COLLAPSED_KEY, recentCollapsed ? "1" : "0");
    render();
  });

  /** @param {BufferRecord} record @param {{closable: boolean}} opts */
  function makeRow(record, { closable }) {
    const li = document.createElement("li");
    li.className = "buffer-row";
    if (record.id === store.activeId) li.classList.add("active");

    const title = document.createElement("span");
    title.className = "buffer-title";
    title.textContent = titleOf(record);
    li.appendChild(title);

    if (closable) {
      const close = document.createElement("button");
      close.className = "buffer-close";
      close.type = "button";
      close.textContent = "×";
      close.title = "Close (Alt+W)";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        run("buffer.close", record.id);
      });
      li.appendChild(close);
    }

    li.addEventListener("click", () => {
      if (record.closed) run("buffer.reopen", record.id);
      else run("buffer.activate", record.id);
    });
    return li;
  }

  function render() {
    openList.replaceChildren(
      ...store.openBuffers().map((b) => makeRow(b, { closable: true }))
    );

    const closed = store.closedBuffers();
    recentHeading.hidden = closed.length === 0;
    recentHeading.textContent =
      (recentCollapsed ? "▸" : "▾") + " Recent (" + closed.length + ")";
    recentList.hidden = recentCollapsed || closed.length === 0;
    recentList.replaceChildren(
      ...(recentList.hidden
        ? []
        : closed.map((b) => makeRow(b, { closable: false })))
    );
  }

  store.events.addEventListener("change", render);
  store.events.addEventListener("active", render);
  render();
}
