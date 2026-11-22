// @ts-check
// Sidebar visibility (architecture.md §9). Two layouts, one state:
//  - Wide: the sidebar is docked. Collapsed means zero width, editor full width.
//  - Narrow (<= 700px, the breakpoint the settings panel already uses): the
//    sidebar is a drawer over the editor, with a scrim behind it. A 220px
//    column on a 360px screen would leave no editor, so it must not push.
//
// Phone mode (the class `phone` on <html>, set by the inline script in
// index.html) is the narrow layout drawn another way: the drawer fills the
// screen as the note list, and the thumb button replaces both hamburgers
// (ui/thumb.js). The state and every command below are the same; only
// phone-location persistence (vrtti.phoneListOpen) and Android Back
// (watchBack) branch on phoneMode().
//
// The CSS defaults match the breakpoint default (open when wide, closed when
// narrow), and an inline script right after <div id="app"> in index.html
// replays `sidebar-open` in phone mode when vrtti.phoneListOpen is "1", so
// the first paint is already right and the mount below never causes a flash.

import { register, run } from "../commands/registry.js";

const NARROW = "(max-width: 700px)";
const OPEN_KEY = "vrtti.sidebarOpen";
const PHONE_LIST_KEY = "vrtti.phoneListOpen";

/** @param {string} key */
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode can throw on access
  }
}

/** @param {string} key @param {string} value */
function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice still applies for this session.
  }
}

/**
 * Is the phone layout on? Read from the class each time, never kept: the
 * class follows a media query (a phone turned on its side leaves the mode),
 * and a copy would go stale with no event to correct it. app.css does the
 * drawing from the same class, so ask this only where behaviour differs.
 */
export function phoneMode() {
  return document.documentElement.classList.contains("phone");
}

/**
 * Is the full-screen phone note list covering the editor right now? Read
 * from the DOM classes, like phoneMode() above, so callers never hold a
 * stale copy and need no reference to the mounted shell controller.
 */
export function phoneListOpen() {
  return phoneMode() && Boolean(document.getElementById("app")?.classList.contains("sidebar-open"));
}

/**
 * Call `fn` when the phone layout comes or goes. For the few things CSS
 * cannot redraw by itself; see the callers.
 *
 * An observer on the class, not a second copy of the media query and not the
 * viewport's resize event: the inline script in index.html is the only thing
 * that knows the rule, and a resize listener runs before that script has
 * changed the class, so it would read the mode that is just ending (seen in
 * the browser check, 2026-11-19). The class carries other words too
 * (`rows-long`), hence the comparison.
 *
 * @param {(phone: boolean) => void} fn
 */
export function onPhoneModeChange(fn) {
  let last = phoneMode();
  new MutationObserver(() => {
    const phone = phoneMode();
    if (phone === last) return;
    last = phone;
    fn(phone);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

/**
 * Let Back (the gesture or the button of Android) close a layer of the phone
 * layout instead of leaving the app. A layer is something that covers the
 * note: the note list, the round buttons, a row menu, the settings panel.
 * Each calls this when it opens, and calls the returned function when it
 * closes in any other way.
 *
 * CloseWatcher is the browser's own interface for exactly this: Back goes to
 * the newest watcher, so layers close in the reverse of the order they
 * opened, one per Back. No history entry is involved, which is the point:
 * with pushState, every path that closes a layer has to take its entry out
 * again, and one that forgets leaves a Back that does nothing.
 *
 * Does nothing outside phone mode, on purpose: a watcher also takes the
 * Escape key, and on a PC Escape already has an owner in every layer. Does
 * nothing in a browser without CloseWatcher either (Safari): an iPhone has
 * no Back, and elsewhere Back then leaves the app as it always did.
 *
 * The mode is read once, at the open. A layer that is open while the phone
 * turns keeps what it got until it closes; following the turn would need a
 * second mechanism for a case that costs one Back.
 *
 * @param {() => void} close Closes the layer. Runs on Back only.
 * @returns {() => void} Stop watching. Safe to call twice, and after a Back.
 */
export function watchBack(close) {
  const CloseWatcher = /** @type {any} */ (window).CloseWatcher;
  if (!CloseWatcher || !phoneMode()) return () => {};
  const watcher = new CloseWatcher();
  watcher.onclose = () => close();
  return () => watcher.destroy();
}

export function mountShell() {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
  const scrim = /** @type {HTMLElement} */ (document.getElementById("sidebar-scrim"));
  const toggles = [
    /** @type {HTMLElement} */ (document.getElementById("sidebar-toggle")),
    /** @type {HTMLElement} */ (document.getElementById("sidebar-open")),
  ];

  const narrow = () => window.matchMedia(NARROW).matches;

  // Wide screens remember their docked sidebar preference (OPEN_KEY). Phone
  // mode remembers whether the user left on the full-screen note list or on a
  // note (PHONE_LIST_KEY, defaulting to the editor on a fresh install). Narrow
  // desktop windows stay on the temporary drawer and always start closed so a
  // drawer never hides the text on launch.
  let open = phoneMode()
    ? readStored(PHONE_LIST_KEY) === "1"
    : narrow()
      ? false
      : readStored(OPEN_KEY) !== "0";

  function paint() {
    app.classList.toggle("sidebar-open", open);
    app.classList.toggle("sidebar-closed", !open);
    // A collapsed sidebar keeps its rows in the DOM. inert takes them out of
    // the tab order and off the accessibility tree, so Tab cannot land on a
    // button nobody can see.
    sidebar.inert = !open;
    for (const button of toggles) button.setAttribute("aria-expanded", String(open));
  }

  // One-step Android Back between the note list and the editor (watchBack
  // above). Never armed at cold start (Back exits the app) and never armed
  // when Back itself made the switch (a second Back exits the app). Every
  // path that opens or closes the list goes through set(), so this is the
  // one place.
  let stopBack = () => {};

  /** @param {boolean} next @param {{fromBack?: boolean}} [opts] */
  function set(next, { fromBack = false } = {}) {
    if (open === next) return;
    const previous = open;
    open = next;
    if (phoneMode()) writeStored(PHONE_LIST_KEY, open ? "1" : "0");
    else if (!narrow()) writeStored(OPEN_KEY, open ? "1" : "0");
    paint();
    stopBack();
    stopBack =
      !fromBack && phoneMode() ? watchBack(() => set(previous, { fromBack: true })) : () => {};
    if (fromBack && phoneMode()) {
      // Returning to the list scrolls the active row into view and moves focus
      // off the hidden editor; returning to the note moves focus to the thumb
      // button rather than the editor so the keyboard does not pop up.
      if (open) run("sidebar.focus");
      else document.getElementById("new-fab")?.focus();
    }
  }

  function toggle() {
    set(!open);
  }

  // Called before opening a document from the sidebar, search, or thumb menu.
  // On narrow screens the drawer or full-screen note list covers the editor,
  // so closing it first lets the editor see it is visible when the note
  // activates.
  function closeIfNarrow() {
    if (narrow()) set(false);
  }

  for (const button of toggles) button.addEventListener("click", toggle);
  scrim.addEventListener("click", () => set(false));

  window.addEventListener("keydown", (event) => {
    // Escape closes the drawer only. On a wide screen it belongs to the editor
    // and to the settings panel, which both have their own bindings.
    if (event.key !== "Escape" || !open || !narrow()) return;
    event.preventDefault();
    set(false);
  });

  register({
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    keys: "Alt+KeyB",
    run: () => toggle(),
  });
  // Search in files lives inside the sidebar (ui/search.js), so its chord has
  // to bring a collapsed sidebar or a closed drawer back before it can focus
  // the field: a hidden sidebar is inert, and focus() on it does nothing.
  register({
    id: "sidebar.show",
    title: "Show sidebar",
    run: () => set(true),
  });
  register({
    id: "sidebar.autoclose",
    title: "Close the sidebar drawer",
    run: () => closeIfNarrow(),
  });

  paint();
  return { toggle, closeIfNarrow, isOpen: () => open };
}
