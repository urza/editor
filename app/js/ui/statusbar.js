// @ts-check
// Status bar: active buffer title, the save indicator, and the build stamp
// (commit + build time), so the user can tell which build the PWA is running.

import { titleOf } from "../model/docs.js";
import { hasDisk } from "../model/capabilities.js";
import { run } from "../commands/registry.js";
import { events as spellEvents, isEnabled } from "../editor/spellcheck.js";
import { activeLangs } from "../editor/mixed.js";
import { BUILD } from "../version.js";
import { ZOOM } from "./zoom.js";

/**
 * The sync states as the user reads them. The Settings rail and status row
 * read the same table, so the two places never disagree.
 * @type {Record<string, string>}
 */
export const SYNC_LABEL = {
  off: "off",
  idle: "synced",
  syncing: "syncing…",
  error: "sync error",
  offline: "offline",
};

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 * @param {ReturnType<import("./zoom.js").mountZoom>} zoom
 */
export function mountStatusbar(store, sync, zoom) {
  const statusTitle = /** @type {HTMLElement} */ (document.getElementById("status-title"));
  const statusSave = /** @type {HTMLElement} */ (document.getElementById("status-save"));
  const statusBuild = /** @type {HTMLElement} */ (document.getElementById("status-build"));
  const statusUpdate = /** @type {HTMLElement} */ (document.getElementById("status-update"));
  const statusLang = {
    cs: /** @type {HTMLElement} */ (document.getElementById("status-cs")),
    en: /** @type {HTMLElement} */ (document.getElementById("status-en")),
  };
  const statusSaveAs = /** @type {HTMLElement} */ (document.getElementById("status-saveas"));
  const statusSync = /** @type {HTMLElement} */ (document.getElementById("status-sync"));
  const statusZoom = /** @type {HTMLElement} */ (document.getElementById("status-zoom"));
  // Phone mode hides the status bar, so a notice goes here too (app.css
  // shows it in phone mode only).
  const phoneNotice = /** @type {HTMLElement} */ (document.getElementById("notice"));

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

  const LANG_NAME = { cs: "Czech", en: "English" };

  // One button per language, for the open note. The "off" class dims the
  // label and strikes it through (app.css). With the spellcheck off on this
  // device both show off, and a click turns it back on (spell.lang).
  function renderSpell() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    const langs = activeLangs(record?.spellOff);
    for (const lang of /** @type {const} */ (["cs", "en"])) {
      const on = isEnabled() && langs[lang];
      const button = statusLang[lang];
      button.classList.toggle("off", !on);
      button.setAttribute("aria-pressed", String(on));
      button.title =
        LANG_NAME[lang] + " spellcheck in this note: " + (on ? "on (click to turn off)" : "off (click to turn on)");
    }
  }

  // The click only dispatches; the buttons repaint from the events. That is
  // what keeps them honest when Settings, another window or a sync changes
  // the same state.
  statusLang.cs.addEventListener("click", () => run("spell.lang", "cs"));
  statusLang.en.addEventListener("click", () => run("spell.lang", "en"));
  spellEvents.addEventListener("change", renderSpell);
  store.events.addEventListener("spell", renderSpell);
  store.events.addEventListener("active", renderSpell);
  renderSpell();

  if (hasDisk) {
    statusSaveAs.addEventListener("click", () => run("file.saveAs"));
  }

  // ---- Sync indicator (architecture.md §13.6) ------------------------------

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

  // ---- Note zoom indicator (ui/zoom.js) ------------------------------------

  function renderZoom() {
    const value = zoom.percent();
    // Hidden at 100: a label that reads "100%" on every note is noise. Shown,
    // it answers "why is this note bigger?" and offers the way back.
    statusZoom.hidden = value === ZOOM.default;
    statusZoom.textContent = value + "%";
    statusZoom.title = "Note zoom " + value + "% (click to reset)";
  }

  statusZoom.addEventListener("click", () => run("view.zoomReset"));
  zoom.events.addEventListener("change", renderZoom);
  renderZoom();

  function renderTitle() {
    const record = store.activeId ? store.get(store.activeId) : undefined;
    statusTitle.textContent = record ? titleOf(record) : "";
    statusTitle.title =
      record?.kind === "file" && record.file ? "On disk: " + store.diskPath(record) : "";
    // The button offers a file to a buffer that has none. A file-backed buffer
    // is already written by the disk write-behind, so the button would only
    // invite a pointless second copy.
    statusSaveAs.hidden = !hasDisk || !record || record.kind === "file";
  }

  store.events.addEventListener("change", renderTitle);
  store.events.addEventListener("active", renderTitle);

  // The save slot doubles as the notice slot: "copied" sits where "saved" was
  // for a moment, then the save status comes back. One span, no toast layer.
  // A save event during a notice only updates what comes back, so the notice
  // is never cut short by the keystroke debounce.
  let saveStatus = statusSave.textContent ?? "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let noticeTimer;
  store.events.addEventListener("save", (event) => {
    saveStatus = /** @type {CustomEvent} */ (event).detail.status;
    if (noticeTimer === undefined) statusSave.textContent = saveStatus;
  });
  /**
   * A short message where the save status is. It goes away after 1.5 s, or,
   * when sticky, stays until the next notice: a model can take many seconds,
   * and a 1.5 s "asking the model…" followed by a quiet bar looks like a
   * command that did nothing. A null text ends a sticky notice.
   * @param {string | null} text @param {boolean} [sticky]
   */
  function notice(text, sticky = false) {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    const end = () => {
      noticeTimer = undefined;
      statusSave.textContent = saveStatus;
      phoneNotice.hidden = true;
    };
    if (text === null) {
      end();
      return;
    }
    statusSave.textContent = text;
    phoneNotice.textContent = text;
    phoneNotice.hidden = false;
    // A sticky notice still holds the slot with a timer handle, so a save
    // event does not overwrite it (see the "save" listener above).
    noticeTimer = setTimeout(end, sticky ? 2 ** 31 - 1 : 1500);
  }

  renderTitle();
  return { notice };
}
