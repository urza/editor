// @ts-check
// Sidebar visibility (architecture.md §9). Two layouts, one state:
//  - Wide: the sidebar is docked. Collapsed means zero width, editor full width.
//  - Narrow (<= 700px, the breakpoint the settings panel already uses): the
//    sidebar is a drawer over the editor, with a scrim behind it. A 220px
//    column on a 360px screen would leave no editor, so it must not push.
//
// The CSS defaults match the breakpoint default (open when wide, closed when
// narrow) with no class present, so the first paint is already right and the
// mount below never causes a flash.

import { register } from "../commands/registry.js";

const NARROW = "(max-width: 700px)";
const OPEN_KEY = "vrtti.sidebarOpen";

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
  register({
    id: "sidebar.autoclose",
    title: "Close the sidebar drawer",
    run: () => closeIfNarrow(),
  });

  paint();
  return { toggle, closeIfNarrow, isOpen: () => open };
}
