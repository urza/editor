// @ts-check
// The two homes of "new buffer" (architecture.md §9).
//
//  - #new-buffer, the big "+" at the top of the sidebar. On a phone the sidebar
//    is a drawer, so reaching it is two taps (open, then "+"). A per-device
//    setting hides it for people who do not want it there.
//  - #new-fab, a round "+" floating over the bottom-right corner of the
//    editor. app.css shows it under the drawer breakpoint only, where it is the
//    one-tap way to a new buffer. It hides while the on-screen keyboard is up:
//    an absolute element keeps its place in the layout viewport, which the
//    keyboard does not shrink, so the button would sit under the keys or, when
//    the browser scrolls the page to the caret, float over the text.
//
// The sidebar setting is device-local in localStorage, like the text sizes
// (ui/textsize.js): a phone and a PC want different answers, so it must not
// sync.

import { register, run } from "../commands/registry.js";

const SIDEBAR_KEY = "vrtti.sidebarNewButton";

/**
 * Layout px the visual viewport must lose before the gap counts as a keyboard.
 * A collapsing browser toolbar takes under 100px; the smallest phone keyboard
 * takes well over 200.
 */
const KEYBOARD_MIN_PX = 150;

let sidebarShown = true;

/** The "+ in the sidebar" setting. */
export function sidebarNewButtonShown() {
  return sidebarShown;
}

function loadSidebarShown() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "off";
  } catch {
    return true; // private mode can throw on access
  }
}

/** @param {boolean} on */
function saveSidebarShown(on) {
  try {
    localStorage.setItem(SIDEBAR_KEY, on ? "on" : "off");
  } catch {
    // Nothing to do: the choice still applies for this session.
  }
}

/**
 * True while an on-screen keyboard covers part of the page.
 *
 * The layout viewport (innerHeight) keeps its height when the keyboard comes
 * up; only the visual viewport shrinks. Multiplying by the pinch scale turns
 * the visual height back into layout px, so a zoomed-in page is not mistaken
 * for a keyboard.
 */
function keyboardOpen() {
  const vv = window.visualViewport;
  if (!vv) return false;
  return window.innerHeight - vv.height * vv.scale > KEYBOARD_MIN_PX;
}

export function mountNewButton() {
  const sidebarButton = /** @type {HTMLElement} */ (document.getElementById("new-buffer"));
  const fab = /** @type {HTMLElement} */ (document.getElementById("new-fab"));

  sidebarShown = loadSidebarShown();
  sidebarButton.hidden = !sidebarShown;

  register({
    id: "view.sidebarNewButton",
    title: "Toggle the new-buffer button in the sidebar",
    run: () => {
      sidebarShown = !sidebarShown;
      sidebarButton.hidden = !sidebarShown;
      saveSidebarShown(sidebarShown);
      return sidebarShown;
    },
  });

  // No sidebar.autoclose here, unlike the sidebar "+": the drawer's scrim
  // covers this button whenever the drawer is open, so a tap on it means the
  // drawer is already closed.
  fab.addEventListener("click", () => run("buffer.new"));

  // The keyboard state is not an event anywhere, so the viewport resize is the
  // signal. visualViewport is absent in old engines: then the button never
  // hides, which only costs a button under the keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const paint = () => {
      fab.hidden = keyboardOpen();
    };
    vv.addEventListener("resize", paint);
    paint();
  }
}
