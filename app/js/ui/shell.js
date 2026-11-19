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
// (ui/thumb.js). The state and every command below are the same, which is
// why nothing in this file asks which of the two is on screen.
//
// The CSS defaults match the breakpoint default (open when wide, closed when
// narrow) with no class present, so the first paint is already right and the
// mount below never causes a flash.

import { register } from "../commands/registry.js";

const NARROW = "(max-width: 700px)";
const OPEN_KEY = "vrtti.sidebarOpen";

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

export function mountShell() {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
  const scrim = /** @type {HTMLElement} */ (document.getElementById("sidebar-scrim"));
  const toggles = [
    /** @type {HTMLElement} */ (document.getElementById("sidebar-toggle")),
    /** @type {HTMLElement} */ (document.getElementById("sidebar-open")),
  ];

  const narrow = () => window.matchMedia(NARROW).matches;

  // The stored preference is a desktop one. A phone always starts on the
  // editor: restoring an open drawer would hide the text the app is for.
  let open = narrow() ? false : localStorage.getItem(OPEN_KEY) !== "0";

  function paint() {
    app.classList.toggle("sidebar-open", open);
    app.classList.toggle("sidebar-closed", !open);
    // A collapsed sidebar keeps its rows in the DOM. inert takes them out of
    // the tab order and off the accessibility tree, so Tab cannot land on a
    // button nobody can see.
    sidebar.inert = !open;
    for (const button of toggles) button.setAttribute("aria-expanded", String(open));
  }

  /** @param {boolean} next */
  function set(next) {
    if (open === next) return;
    open = next;
    if (!narrow()) localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    paint();
  }

  function toggle() {
    set(!open);
  }

  // Called by the sidebar after a row opens a document. On a phone the drawer
  // covers the editor, so leaving it open would hide the file just opened.
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
