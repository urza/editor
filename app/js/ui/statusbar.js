// @ts-check
// Status bar: active buffer title, the save indicator, and the build stamp
// (commit + build time), so the user can tell which build the PWA is running.

import { titleOf } from "../model/docs.js";
import { hasFileSystemAccess } from "../model/capabilities.js";
import { run } from "../commands/registry.js";
import { events as spellEvents, isEnabled } from "../editor/spellcheck.js";
import { BUILD } from "../version.js";

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 */
export function mountStatusbar(store, sync) {
  const statusTitle = /** @type {HTMLElement} */ (document.getElementById("status-title"));
  const statusSave = /** @type {HTMLElement} */ (document.getElementById("status-save"));
  const statusBuild = /** @type {HTMLElement} */ (document.getElementById("status-build"));
  const statusUpdate = /** @type {HTMLElement} */ (document.getElementById("status-update"));
  const statusSpell = /** @type {HTMLElement} */ (document.getElementById("status-spell"));
  const statusSaveAs = /** @type {HTMLElement} */ (document.getElementById("status-saveas"));
  const statusSync = /** @type {HTMLElement} */ (document.getElementById("status-sync"));

  const builtAt = new Date(BUILD.builtAt);
  const stamp =
    BUILD.commit +
    " · " +
    builtAt.toLocaleString([], {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  statusBuild.textContent = stamp;
  statusBuild.title = "build " + BUILD.commit + ", " + BUILD.builtAt;

  statusUpdate.addEventListener("click", () => {
    // Update progress borrows the build span; null restores the stamp.
    run("app.update", (/** @type {string | null} */ msg) => {
      statusBuild.textContent = msg ?? stamp;
    });
  });

  /** @param {boolean} on */
  function renderSpell(on) {
    // The "off" class dims the label and strikes it through (app.css).
    statusSpell.classList.toggle("off", !on);
    statusSpell.title = on
      ? "Spellcheck on (click to turn off)"
      : "Spellcheck off (click to turn on)";
  }

  // The click only dispatches; the indicator repaints from the spellcheck
  // module's own event. That is what keeps this button honest when the
  // settings panel flips the same setting.
  statusSpell.addEventListener("click", () => run("spell.toggle"));
  spellEvents.addEventListener("change", () => renderSpell(isEnabled()));
  renderSpell(isEnabled());

  if (hasFileSystemAccess) {
    statusSaveAs.addEventListener("click", () => run("file.saveAs"));
  }

  // ---- Sync indicator (architecture.md §13.6) ------------------------------

  /** @type {Record<string, string>} */
  const SYNC_LABEL = {
    idle: "synced",
    syncing: "syncing…",
    error: "sync error",
    offline: "offline",
  };

  /** @param {import("../sync/client.js").SyncStatus} status */
  function renderSync(status) {
    // No server configured means no element: an indicator for a feature the
    // user never turned on is noise, and there is nothing it could report.
    statusSync.hidden = status.state === "off";
    if (statusSync.hidden) return;
    statusSync.textContent = SYNC_LABEL[status.state] ?? status.state;
    // "off" for the error and offline states, which dims and strikes the label
    // the same way the spellcheck indicator says "not working right now".
    statusSync.classList.toggle(
      "off",
      status.state === "error" || status.state === "offline"
    );
    const parts = [status.message ?? SYNC_LABEL[status.state] ?? status.state];
    if (status.lastSyncAt) {
      parts.push("last sync " + new Date(status.lastSyncAt).toLocaleTimeString());
    }
    parts.push("Click to sync now");
    statusSync.title = parts.join(" · ");
  }

  if (sync) {
    statusSync.addEventListener("click", () => run("sync.now"));
    sync.events.addEventListener("status", (event) => {
      renderSync(/** @type {CustomEvent} */ (event).detail);
    });
    renderSync(sync.status);
  }

  function renderTitle() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    statusTitle.textContent = record ? titleOf(record) : "";
    // The button offers a file to a buffer that has none. A file-backed buffer
    // is already written by the disk write-behind, so the button would only
    // invite a pointless second copy.
    statusSaveAs.hidden =
      !hasFileSystemAccess || !record || record.kind === "file";
  }

  store.events.addEventListener("change", renderTitle);
  store.events.addEventListener("active", renderTitle);
  store.events.addEventListener("save", (event) => {
    statusSave.textContent = /** @type {CustomEvent} */ (event).detail.status;
  });
  renderTitle();
}
