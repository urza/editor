// @ts-check
// Text size: two knobs, one for the document and one for the chrome.
//
//  - Editor: --editor-font-size, in px. The CodeMirror theme reads it
//    (editor/editor.js), so a change is a single style write. CodeMirror is
//    never reconfigured, and the text, the selection and the undo history all
//    survive the change untouched.
//  - Interface: --ui-scale, a plain multiplier. Every size in the chrome is
//    calc(Npx * var(--ui-scale)) in app.css, so one number turns all of them.
//
// Two knobs and not one, because the editor is content and the sidebar is
// chrome. A phone wants big document text next to a small sidebar. Browser
// zoom cannot do that: it scales both together.
//
// Device-local in localStorage, like the sidebar width (ui/resizer.js) and the
// sidebar state (ui/shell.js). A phone and a 27" monitor want different
// numbers, so these must not sync (architecture.md §9).

import { register } from "../commands/registry.js";

// Read by the inline boot script in index.html too, which replays them before
// the first paint. Change a key here and you must change it there.
const EDITOR_KEY = "vrtti.editorFontSize";
const UI_KEY = "vrtti.uiScale";

/** Editor size in px. The default matches the theme's own fallback. */
export const EDITOR = { min: 9, max: 32, step: 1, default: 14 };

/**
 * Interface scale in percent. Stepped in tens: the chrome is built out of
 * 11-15px type, where a 1% step would move nothing.
 */
export const UI = { min: 70, max: 200, step: 10, default: 100 };

/**
 * @param {number} value
 * @param {{min: number, max: number}} range
 */
function clamp(value, range) {
  if (!Number.isFinite(value)) return NaN;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * @param {string} key
 * @param {{min: number, max: number, default: number}} range
 */
function load(key, range) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return range.default; // private mode can throw on access
  }
  const value = Math.round(Number(raw));
  // Out of range, or not a number at all: take the default rather than clamp.
  // A clamped value is a size nobody chose, and nothing on screen says why.
  if (raw === null || !Number.isFinite(value)) return range.default;
  if (value < range.min || value > range.max) return range.default;
  return value;
}

/** @param {string} key @param {number} value */
function save(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Nothing to do: the size still applies for this session.
  }
}

let editorSize = EDITOR.default;
let uiPercent = UI.default;

function applyEditor() {
  document.documentElement.style.setProperty("--editor-font-size", editorSize + "px");
}

function applyUi() {
  // Written unrounded: the chrome multiplies it into px, and 0.7 of 11px is a
  // sub-pixel value the browser is better at rounding than this module is.
  document.documentElement.style.setProperty("--ui-scale", String(uiPercent / 100));
}

/** The editor font size in px. */
export function editorFontSize() {
  return editorSize;
}

/** The interface scale in percent. */
export function uiScale() {
  return uiPercent;
}

/**
 * Mount the two commands and apply the stored sizes.
 *
 * Applying here is a repair, not the first paint: the inline script in
 * index.html already put the stored values on :root, because a module is
 * deferred and would arrive one frame too late, after a visible flash at the
 * default size.
 */
export function mountTextSize() {
  editorSize = load(EDITOR_KEY, EDITOR);
  uiPercent = load(UI_KEY, UI);
  applyEditor();
  applyUi();

  register({
    id: "view.editorFontSize",
    title: "Editor text size",
    /** @param {number} value px */
    run: (value) => {
      const next = clamp(Number(value), EDITOR);
      if (!Number.isFinite(next) || next === editorSize) return editorSize;
      editorSize = next;
      applyEditor();
      save(EDITOR_KEY, next);
      return next;
    },
  });

  register({
    id: "view.uiScale",
    title: "Interface text size",
    /** @param {number} value percent */
    run: (value) => {
      const next = clamp(Number(value), UI);
      if (!Number.isFinite(next) || next === uiPercent) return uiPercent;
      uiPercent = next;
      applyUi();
      save(UI_KEY, next);
      return next;
    },
  });
}
