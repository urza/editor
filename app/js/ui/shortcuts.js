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
    // Ctrl/Meta chords stay with the browser; Alt is our modifier space
    // (Sublime's Ctrl+N/Ctrl+W are not interceptable in a browser).
    if (event.ctrlKey || event.metaKey) return;
    const chord = (event.altKey ? "Alt+" : "") + event.code;
    const id = byChord.get(chord);
    if (!id) return;
    event.preventDefault();
    run(id);
  });
}
