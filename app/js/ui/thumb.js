// @ts-check
// The round buttons of phone mode (architecture.md §9, Phone mode).
//
// In phone mode the floating button at the bottom right is the thumb button:
// a tap shows three round buttons on a quarter circle around it, all within
// reach of the thumb that tapped. New makes a note, the middle one changes
// between the note and the note list, Settings opens the settings panel.
//
// This file owns one thing, whether the round buttons are out. Everything
// they do is a command that already existed, in the order the sidebar's own
// buttons run them (ui/sidebar.js). Where the buttons sit, what they look
// like and which icon the middle one shows are app.css (`html.phone`).
//
// The click on the thumb button itself is not here: #new-fab has exactly one
// click handler, in ui/newbutton.js, which runs "thumb.toggle" in phone mode
// and "buffer.new" outside it. Two handlers on one button would do both.

import { register, run } from "../commands/registry.js";
import { onPhoneModeChange, phoneMode, watchBack } from "./shell.js";

export function mountThumb() {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const fab = /** @type {HTMLElement} */ (document.getElementById("new-fab"));
  const menu = /** @type {HTMLElement} */ (document.getElementById("thumb-menu"));
  const scrim = /** @type {HTMLElement} */ (document.getElementById("thumb-scrim"));
  const newButton = /** @type {HTMLElement} */ (document.getElementById("thumb-new"));
  const listButton = /** @type {HTMLElement} */ (document.getElementById("thumb-list"));
  const settingsButton = /** @type {HTMLElement} */ (document.getElementById("thumb-settings"));

  /**
   * Is the note list on screen? Read from the class ui/shell.js keeps on
   * #app, at the moment of the tap. The same class picks the middle button's
   * icon in app.css, so the icon and the action cannot disagree, and a row
   * tap that closes the list needs to tell nobody.
   */
  const listOpen = () => app.classList.contains("sidebar-open");

  let open = false;
  // Back puts the round buttons away (watchBack in ui/shell.js).
  let stopBack = () => {};

  /** @param {boolean} next */
  function set(next) {
    open = next;
    stopBack();
    stopBack = open ? watchBack(() => set(false)) : () => {};
    menu.hidden = !open;
    scrim.hidden = !open;
    // app.css draws the thumb button's sign from this: three lines, or a cross.
    fab.setAttribute("aria-expanded", String(open));
    if (!open) return;

    // A screen reader hears the icon the eye sees.
    const label = listOpen() ? "Back to the note" : "Note list";
    listButton.title = label;
    listButton.setAttribute("aria-label", label);

    // The thumb button stays above the on-screen keyboard (ui/newbutton.js),
    // so this tap often comes while the editor has the focus. The focus has
    // to go, or the keyboard stays up under the buttons; an iPhone keeps it
    // on the text when a button is tapped, and has no key to close it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== fab) focused.blur();
  }

  newButton.addEventListener("click", () => {
    set(false);
    // The path of the sidebar "+": settings close before the new note takes
    // the focus, the note list after. The user is about to type.
    run("settings.close");
    run("buffer.new");
    run("sidebar.autoclose");
  });

  listButton.addEventListener("click", () => {
    set(false);
    // "sidebar.focus", not "sidebar.show": it shows the list and then puts
    // the focus on the row of the open note, which scrolls that row into
    // view. A closed list is display: none in phone mode and cannot scroll
    // while it is closed (app.css), so this is the moment it must happen.
    if (listOpen()) {
      run("sidebar.autoclose");
      // The button that had the focus is gone with the round buttons, and
      // the list with its rows. Left alone the focus falls to <body>, and a
      // screen reader starts again from the top of the page. Not the editor:
      // a focus there brings the keyboard up over a note the user came back
      // to read.
      fab.focus();
    } else {
      run("sidebar.focus");
    }
  });

  settingsButton.addEventListener("click", () => {
    set(false);
    // The list first: it sits above the settings panel, and the panel would
    // open behind it.
    run("sidebar.autoclose");
    run("settings.toggle");
  });

  scrim.addEventListener("click", () => set(false));

  // When the mode itself changes (a phone turned on its side), two things
  // cannot be left to CSS: the name of #new-fab, which is two controls and
  // must say which one it is now, and round buttons that were out when the
  // mode went. CSS hides those, but they would be out again by themselves on
  // the turn back, with a cross on the button.
  /** @param {boolean} phone */
  function modeChanged(phone) {
    const label = phone ? "Menu" : "New buffer";
    fab.title = label;
    fab.setAttribute("aria-label", label);
    if (phone) return;
    if (open) set(false);
    // Outside phone mode the button expands nothing, and a screen reader
    // must not call a plain "New buffer" button "collapsed".
    fab.removeAttribute("aria-expanded");
  }
  onPhoneModeChange(modeChanged);
  modeChanged(phoneMode());

  register({
    id: "thumb.toggle",
    title: "Show or hide the round buttons",
    run: () => set(!open),
  });
}
