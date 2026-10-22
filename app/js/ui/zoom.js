// @ts-check
// Note zoom: Ctrl+wheel over the editor scales the open note's text, and only
// that note's. The Settings size (ui/textsize.js) stays the base for every
// note; this is a factor on top of it, so a bigger base keeps a zoomed note's
// ratio.
//
// The factor is --note-zoom on #editor-host, a plain multiplier the CodeMirror
// theme folds into its font size (editor/editor.js). One style write per
// switch, and CodeMirror is never reconfigured, so the text, the selection and
// the undo history survive a zoom the same way they survive the Settings size.
//
// In memory only, like the editor's scroll snapshots: a factor lives as long
// as its note is open, and a reload starts every note at 100 %. Nothing in
// localStorage, nothing in the store, nothing that syncs. A zoom is a glance
// at one note on one screen, not a setting.

import { register } from "../commands/registry.js";

/** Percent of the Settings size. Stepped in tens, like browser zoom. */
export const ZOOM = { min: 50, max: 300, step: 10, default: 100 };

/**
 * @param {HTMLElement} host The editor host, which carries --note-zoom.
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @returns {{events: EventTarget, percent: () => number}} `change` fires
 *   whenever the factor on screen may have changed (a step, a note switch).
 */
export function mountZoom(host, store) {
  /** @type {Map<string, number>} note id -> percent; absent means 100 */
  const zooms = new Map();
  const events = new EventTarget();

  /** The open note's percent. */
  function percent() {
    return (store.activeId && zooms.get(store.activeId)) || ZOOM.default;
  }

  /** Put the open note's factor on the host. */
  function apply() {
    const value = percent();
    // Removed at 100, not written as "1": a note at the default leaves no
    // trace of this module in the DOM, and the theme's own fallback is 1.
    if (value === ZOOM.default) host.style.removeProperty("--note-zoom");
    else host.style.setProperty("--note-zoom", String(value / 100));
    events.dispatchEvent(new Event("change"));
  }

  /** @param {number} value percent, clamped to ZOOM */
  function set(value) {
    const id = store.activeId;
    if (!id) return;
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, value));
    if (next === ZOOM.default) zooms.delete(id);
    else zooms.set(id, next);
    apply();
  }

  register({ id: "view.zoomIn", title: "Zoom note in", run: () => set(percent() + ZOOM.step) });
  register({ id: "view.zoomOut", title: "Zoom note out", run: () => set(percent() - ZOOM.step) });
  register({ id: "view.zoomReset", title: "Reset note zoom", run: () => set(ZOOM.default) });

  // Ctrl+wheel. Not passive: preventDefault is what stops the browser, and
  // the desktop webview, from zooming the whole page instead. Cmd stands in
  // for Ctrl where a Mac puts the same chord (ui/shortcuts.js). Only over the
  // editor itself: the settings overlay and the "+" sit inside the host too,
  // and a wheel over them must not zoom the note they cover.
  host.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!(event.target instanceof Element) || !event.target.closest(".cm-editor")) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      // One step per event, by direction only. A trackpad pinch arrives as a
      // run of these with small deltas, so it zooms fast; tune that after a
      // real-device run, not before.
      set(percent() + (event.deltaY < 0 ? ZOOM.step : -ZOOM.step));
    },
    { passive: false }
  );

  // The note on screen changed, so its own factor goes on the host. Also
  // fired at boot for the restored note, when every factor is still 100.
  store.events.addEventListener("active", apply);
  // A closed note takes its factor with it. apply() too, and not only when
  // the closed note was the open one: it is cheap, and it keeps this module
  // free of any guess about the order of the store's "evict" and "active".
  store.events.addEventListener("evict", (event) => {
    zooms.delete(/** @type {CustomEvent} */ (event).detail.id);
    apply();
  });

  return { events, percent };
}
