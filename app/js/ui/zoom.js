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
// Device-local in localStorage, like the text sizes (ui/textsize.js): a note
// keeps its zoom across a close, a reload and a restart. Never in the store
// and never synced: a phone and a 27" monitor want different factors for the
// same note (user decision, 2026-11-20).
//
// localStorage is the only copy, read on each use and changed one entry at a
// time. Two windows of the app share it, and a copy in memory here would
// write back a stale map over the other window's zooms.
//
// A deleted note's entry goes at the next start (prune() below), not at the
// delete: the store's "evict" fires for a close and a delete alike.

import { register } from "../commands/registry.js";

/** Percent of the Settings size. Stepped in tens, like browser zoom. */
export const ZOOM = { min: 50, max: 300, step: 10, default: 100 };

const KEY = "vrtti.noteZoom";

/** @returns {Map<string, number>} note id -> percent, valid entries only */
function load() {
  const zooms = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    for (const [id, value] of Object.entries(saved)) {
      // Skip what is out of range rather than clamp it: a clamped value is a
      // zoom nobody chose (same rule as ui/textsize.js).
      if (Number.isInteger(value) && value >= ZOOM.min && value <= ZOOM.max) {
        zooms.set(id, value);
      }
    }
  } catch {
    // Private mode can throw on access, and a damaged value fails to parse.
    // Every note then starts at 100 %.
  }
  return zooms;
}

/** @param {Map<string, number>} zooms */
function save(zooms) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(zooms)));
  } catch {
    // Nothing to do: the zoom still applies until the app closes.
  }
}

/**
 * @param {HTMLElement} host The editor host, which carries --note-zoom.
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @returns {{events: EventTarget, percent: () => number}} `change` fires
 *   whenever the factor on screen may have changed (a step, a note switch).
 */
export function mountZoom(host, store) {
  const events = new EventTarget();

  // Once at start, so the saved map cannot grow with every deleted note.
  // Safe only because main.js mounts this after store.load(), which reads
  // every record, closed, trashed and locked ones too: an entry the store
  // does not know belongs to a note that is gone for good.
  /** @type {Map<string, number> | null} */
  let cachedZooms = load();
  for (const id of cachedZooms.keys()) if (!store.get(id)) cachedZooms.delete(id);
  save(cachedZooms);

  // Drop the read cache when another window updates localStorage; set() below
  // still loads fresh before mutating so two windows never clobber each other.
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === KEY) {
      cachedZooms = null;
      apply();
    }
  });

  /** The open note's percent. Absent from the saved map means 100. */
  function percent() {
    if (!store.activeId) return ZOOM.default;
    if (!cachedZooms) cachedZooms = load();
    return cachedZooms.get(store.activeId) || ZOOM.default;
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
    const zooms = load();
    // At 100 the entry goes: only zoomed notes take space in the saved map.
    if (next === ZOOM.default) zooms.delete(id);
    else zooms.set(id, next);
    save(zooms);
    cachedZooms = zooms;
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
  // fired at boot for the restored note, which gets its saved factor here.
  // No "evict" listener: a closed note keeps its factor for when it opens
  // again, and "evict" cannot tell a close from a delete.
  store.events.addEventListener("active", apply);

  return { events, percent };
}
