// @ts-check
// Status bar (.work/mixed-spellcheck/plan.md, "The status bar on a PC"): the
// cursor position and word count at the left; at the right the note zoom,
// the spellcheck languages of the note, and one state sign for "saved and
// synced". Phone mode hides the bar; its notices then show in #notice above
// the thumb button.
//
// The name of the note, the build stamp and the update button were here
// before. The first line of a note already shows its name, and Settings shows
// the build and has the update check (user decision, 2026-11-19). The "save
// to disk" button went too: Ctrl+S, the palette and File > Save As… in the
// shell offer the same (user decision, 2026-11-20).

import { run } from "../commands/registry.js";
import { events as spellEvents, isEnabled } from "../editor/spellcheck.js";
import { editorEvents } from "../editor/editor.js";
import { activeLangs } from "../editor/mixed.js";
import { countWords, positionText, stateSign } from "./statustext.js";
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

// A word count reads the whole note. Typing changes the note on every key, so
// the count waits for a pause; the position updates at once.
const COUNT_DELAY = 250;

/**
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @param {ReturnType<import("../sync/client.js").createSyncClient>} [sync]
 * @param {ReturnType<import("./zoom.js").mountZoom>} zoom
 * @param {import("@codemirror/view").EditorView} view
 */
export function mountStatusbar(store, sync, zoom, view) {
  const statusPos = /** @type {HTMLElement} */ (document.getElementById("status-pos"));
  const statusState = /** @type {HTMLElement} */ (document.getElementById("status-state"));
  const statusLang = {
    cs: /** @type {HTMLElement} */ (document.getElementById("status-cs")),
    en: /** @type {HTMLElement} */ (document.getElementById("status-en")),
  };
  const statusZoom = /** @type {HTMLElement} */ (document.getElementById("status-zoom"));
  // Phone mode hides the status bar, so a notice goes here too (app.css
  // shows it in phone mode only).
  const phoneNotice = /** @type {HTMLElement} */ (document.getElementById("notice"));

  // ---- Position and words ---------------------------------------------------

  /** @type {import("@codemirror/state").Text | null} */
  let countedDoc = null;
  let words = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let countTimer;

  function renderPos() {
    const state = view.state;
    // The locked placeholder is not a document: no position to report.
    if (state.readOnly) {
      statusPos.textContent = "";
      return;
    }
    if (countedDoc !== state.doc && countTimer === undefined) {
      // The first count of a note is at once, so a note never opens with a
      // wrong number; later counts wait for a pause in typing.
      if (countedDoc === null) {
        countedDoc = state.doc;
        words = countWords(state.doc.toString());
      } else countTimer = setTimeout(count, COUNT_DELAY);
    }
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    /** @type {{ lines: number, chars: number, words: number } | undefined} */
    let selected;
    if (!main.empty) {
      selected = {
        lines: state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number + 1,
        chars: main.to - main.from,
        words: countWords(state.sliceDoc(main.from, main.to)),
      };
    }
    statusPos.textContent = positionText({
      line: line.number,
      column: main.head - line.from + 1,
      words,
      selections: state.selection.ranges.length,
      selected,
    });
  }

  function count() {
    countTimer = undefined;
    countedDoc = view.state.doc;
    words = countWords(countedDoc.toString());
    renderPos();
  }

  editorEvents.addEventListener("update", renderPos);
  // A note switch is view.setState, which runs no update listener.
  store.events.addEventListener("active", () => {
    clearTimeout(countTimer);
    countTimer = undefined;
    countedDoc = null;
    // After the editor's own "active" handler put the new state up.
    queueMicrotask(renderPos);
  });
  // A lock (keys or PIN, §27) puts the placeholder up with setState too, and
  // an unlock the text: neither runs an update listener.
  for (const type of ["lock", "unlock"]) {
    store.events.addEventListener(type, () => queueMicrotask(renderPos));
  }

  // ---- Spellcheck languages -------------------------------------------------

  const LANG_NAME = { cs: "Czech", en: "English" };

  // One button per language, for the open note. With the spellcheck off on
  // this device both show off, and a click turns it back on (spell.lang).
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

  // ---- The state sign ---------------------------------------------------------

  let saveStatus = "saved";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let noticeTimer;

  function renderState() {
    if (noticeTimer !== undefined) return;
    const record = store.activeId ? store.get(store.activeId) : undefined;
    const sign = stateSign({
      save: saveStatus,
      syncs: Boolean(record?.sync && !record.sync.tombstone),
      waiting: Boolean(record?.sync && (record.sync.dirty || record.sync.rev === 0)),
      client: /** @type {any} */ (sync?.status.state ?? "off"),
    });
    statusState.textContent = sign.text;
    statusState.classList.toggle("problem", sign.problem);
    const lines = [sign.title];
    // The disk path of a file note was the tooltip of the note name, which
    // is gone from the bar.
    if (record?.kind === "file" && record.file) lines.push("On disk: " + store.diskPath(record));
    if (sync?.isConfigured) {
      const last = sync.status.lastSyncAt;
      if (last) lines.push("Last sync " + new Date(last).toLocaleTimeString() + ".");
      lines.push("Click to sync now.");
    }
    statusState.title = lines.join("\n");
    // The sign alone ("✓", "…") says nothing to a screen reader.
    statusState.setAttribute("aria-label", lines.join(" "));
  }

  statusState.addEventListener("click", () => {
    if (sync?.isConfigured) run("sync.now");
  });
  store.events.addEventListener("save", (event) => {
    saveStatus = /** @type {CustomEvent} */ (event).detail.status;
    renderState();
  });
  // "change" covers a push or a pull that changed the record's sync state.
  store.events.addEventListener("change", renderState);
  store.events.addEventListener("active", renderState);
  sync?.events.addEventListener("status", renderState);

  /**
   * A short message in the place of the state sign. It goes away after
   * 1.5 s, or, when sticky, stays until the next notice: a model can take
   * many seconds, and a 1.5 s "asking the model…" followed by a quiet bar
   * looks like a command that did nothing. endNotice ends a sticky one.
   * @param {string} text @param {boolean} [sticky]
   */
  function notice(text, sticky = false) {
    clearTimeout(noticeTimer);
    statusState.textContent = text;
    statusState.classList.remove("problem");
    statusState.classList.add("notice");
    phoneNotice.textContent = text;
    phoneNotice.hidden = false;
    // A sticky notice still holds a timer handle, so renderState leaves it
    // alone until it ends.
    noticeTimer = setTimeout(endNotice, sticky ? 2 ** 31 - 1 : 1500);
  }

  function endNotice() {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    statusState.classList.remove("notice");
    phoneNotice.hidden = true;
    renderState();
  }

  // ---- Zoom -----------------------------------------------------------------

  function renderZoom() {
    const value = zoom.percent();
    // Always shown, 100 % too (user decision, 2026-11-20): the label is where
    // the zoom of the open note is read, and a zoom now outlives a restart.
    statusZoom.hidden = !store.activeId;
    statusZoom.textContent = value + "%";
    statusZoom.title =
      value === ZOOM.default
        ? "Note zoom 100% (Ctrl+wheel over the note to zoom)"
        : "Note zoom " + value + "% (click to reset)";
  }

  statusZoom.addEventListener("click", () => run("view.zoomReset"));
  zoom.events.addEventListener("change", renderZoom);

  renderPos();
  renderSpell();
  renderState();
  renderZoom();
  return { notice, endNotice };
}
