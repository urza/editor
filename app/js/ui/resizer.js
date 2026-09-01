// @ts-check
// Drag handle between sidebar and editor. Pure UI preference, so it talks to
// no store and no commands; the width persists in localStorage per device.

const WIDTH_KEY = "vrtti.sidebarWidth";
const MIN_WIDTH = 120;
const DEFAULT_WIDTH = 220;

export function mountResizer() {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const resizer = /** @type {HTMLElement} */ (document.getElementById("resizer"));

  /** @param {number} width */
  function apply(width) {
    app.style.setProperty("--sidebar-width", width + "px");
  }

  /** @param {number} width */
  function clamp(width) {
    // Keep the editor usable: the sidebar never takes more than 60% of the app.
    const max = Math.max(MIN_WIDTH, Math.floor(app.clientWidth * 0.6));
    return Math.min(max, Math.max(MIN_WIDTH, width));
  }

  function save() {
    const width = parseInt(app.style.getPropertyValue("--sidebar-width"), 10);
    if (width) localStorage.setItem(WIDTH_KEY, String(width));
  }

  const stored = Number(localStorage.getItem(WIDTH_KEY));
  if (stored) apply(clamp(stored));

  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    // Pointer capture retargets move/up to the handle, so the drag keeps
    // working while the pointer crosses the editor or leaves the window.
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");

    /** @param {PointerEvent} ev */
    const move = (ev) => {
      // clientX minus the app's left edge is the sidebar width directly.
      apply(clamp(Math.round(ev.clientX - app.getBoundingClientRect().left)));
    };
    const up = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      save();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });

  // Double-click restores the default width.
  resizer.addEventListener("dblclick", () => {
    apply(DEFAULT_WIDTH);
    save();
  });
}
