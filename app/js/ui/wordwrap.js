// @ts-check
// Word wrap: on, a long line folds at the editor's edge; off, it runs on and
// the editor scrolls sideways. One switch for the whole window, in the View
// menu of the desktop shell (src-tauri/src/lib.rs). The page has no control
// for it: the switch is for a wide screen, and a phone keeps wrap.
//
// The page owns the setting and the shell's check mark follows it: the page
// reports the value at boot and after every change (ui/desktop.js), so the
// mark never guesses, and a stale mark heals on the next click.
//
// Device-local in localStorage, like the text size (ui/textsize.js): a
// preference about this screen, so it must not sync (architecture.md §9).

import { register } from "../commands/registry.js";
import { reportWordWrap } from "./desktop.js";

const KEY = "vrtti.wordWrap";

/**
 * On unless this device turned it off. Anything but "off" is on: the default,
 * a missing key, and a value no build ever wrote.
 */
function load() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true; // private mode can throw on access
  }
}

/** @param {boolean} on */
function save(on) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Nothing to do: the setting still applies for this session.
  }
}

/**
 * Apply the stored setting and register the command.
 * @param {{setWordWrap: (on: boolean) => void}} editor The editor controller.
 */
export function mountWordWrap(editor) {
  let on = load();
  editor.setWordWrap(on);
  reportWordWrap(on);

  register({
    id: "view.wordWrap",
    title: "Word wrap",
    /** @param {boolean} [value] The new state; without one the command toggles. */
    run: (value) => {
      const next = typeof value === "boolean" ? value : !on;
      if (next !== on) {
        on = next;
        editor.setWordWrap(on);
        save(on);
      }
      // Reported even when nothing changed. The click that brought the value
      // already flipped the menu's mark, and the mark must end where the page
      // is, whichever way the two disagreed.
      reportWordWrap(on);
      return on;
    },
  });
}
