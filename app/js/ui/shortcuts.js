// @ts-check
// Binds the physical-key chords declared on registered commands to window
// keydown. Mount after all commands are registered; the chord table is a
// snapshot.

import { all, run } from "../commands/registry.js";

export function mountShortcuts() {
  /** @type {Map<string, string>} */
  const byChord = new Map();
  for (const command of all()) {
    if (command.keys) byChord.set(command.keys, command.id);
  }

  // event.code, not event.key: Alt+N on a non-US layout can produce a
  // different character, but the physical key code stays KeyN.
  window.addEventListener("keydown", (event) => {
    // Alt is our modifier space, because the browser owns most of the Ctrl set
    // (Sublime's Ctrl+N/Ctrl+W are not interceptable in a browser). A command
    // may still declare a "Ctrl+" chord for one the browser leaves alone, and
    // only a declared one is taken: the lookup below runs first and every
    // other Ctrl keydown falls through untouched, as it always did.
    // Ctrl+Shift+F (search.inFiles) is unbound in Chrome, Edge and Firefox.
    // Meta stands in for Ctrl, which is where a Mac puts the same chord.
    const chord =
      (event.ctrlKey || event.metaKey ? "Ctrl+" : "") +
      (event.altKey ? "Alt+" : "") +
      (event.shiftKey ? "Shift+" : "") +
      event.code;
    const id = byChord.get(chord);
    if (!id) return;
    event.preventDefault();
    run(id);
  });
}
