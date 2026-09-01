// @ts-check
// Status bar: active buffer title, the save indicator, and the build stamp
// (commit + build time), so the user can tell which build the PWA is running.

import { titleOf } from "../model/docs.js";
import { BUILD } from "../version.js";

/** @param {ReturnType<import("../model/docs.js").createDocStore>} store */
export function mountStatusbar(store) {
  const statusTitle = /** @type {HTMLElement} */ (document.getElementById("status-title"));
  const statusSave = /** @type {HTMLElement} */ (document.getElementById("status-save"));
  const statusBuild = /** @type {HTMLElement} */ (document.getElementById("status-build"));

  const builtAt = new Date(BUILD.builtAt);
  statusBuild.textContent =
    BUILD.commit +
    " · " +
    builtAt.toLocaleString([], {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  statusBuild.title = "build " + BUILD.commit + ", " + BUILD.builtAt;

  function renderTitle() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    statusTitle.textContent = record ? titleOf(record) : "";
  }

  store.events.addEventListener("change", renderTitle);
  store.events.addEventListener("active", renderTitle);
  store.events.addEventListener("save", (event) => {
    statusSave.textContent = /** @type {CustomEvent} */ (event).detail.status;
  });
  renderTitle();
}
