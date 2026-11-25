// @ts-check
// The texts of the status bar (.work/mixed-spellcheck/plan.md, "The status bar
// on a PC"). Pure, so Node tests can run them; ui/statusbar.js renders.

// A word for the count: letters and digits, with a hyphen or an apostrophe
// inside. Not the spellcheck's word rule: that one skips numbers and links,
// and a count must not follow spelling rules. Markdown signs do not count.
const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

/** @param {string} text */
export function countWords(text) {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}

/**
 * Count words across `[from, to]` of a CodeMirror `Text` rope line-by-line so
 * multi-megabyte documents and `Ctrl+A` selections never flatten `doc.toString()`.
 * Words never cross `\n`, so summing per-line counts matches `countWords` exactly.
 * @param {import("@codemirror/state").Text} doc
 * @param {number} [from]
 * @param {number} [to]
 */
export function countWordsInDoc(doc, from = 0, to = doc.length) {
  if (to <= from || doc.length === 0) return 0;
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  if (startLine.number === endLine.number) {
    return countWords(startLine.text.slice(from - startLine.from, to - startLine.from));
  }
  let total = countWords(startLine.text.slice(from - startLine.from));
  if (endLine.number > startLine.number + 1) {
    const iter = doc.iterLines(startLine.number + 1, endLine.number);
    while (!iter.next().done) total += countWords(iter.value);
  }
  total += countWords(endLine.text.slice(0, to - endLine.from));
  return total;
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The device name at the left of the status bar: the sync device name while
 * sync is active and has one, else the machine's hostname (from the desktop
 * shell's window.vrttiDesktop.hostname). Returns empty strings when neither
 * is available so ui/statusbar.js hides the slot.
 *
 * KeyRing.setup() stores "this device" when the user leaves the name blank
 * (crypto/keyring.js); a real machine hostname takes precedence over that
 * placeholder.
 *
 * @param {{ syncActive: boolean, syncName?: string | null, hostname?: string | null }} info
 * @returns {{ text: string, title: string }}
 */
export function deviceLabel({ syncActive, syncName, hostname }) {
  const synced = syncActive ? (syncName ?? "").trim() : "";
  const host = (hostname ?? "").trim();
  if (synced && synced !== "this device") {
    return { text: synced, title: "This device (sync): " + synced };
  }
  if (host) {
    return { text: host, title: "This device (hostname): " + host };
  }
  if (synced) {
    return { text: synced, title: "This device (sync): " + synced };
  }
  return { text: "", title: "" };
}

/**
 * Cursor position and word count.
 * @param {{ line: number, column: number, words: number,
 *           selections: number, selected?: { lines: number, chars: number, words: number } }} at
 *   `selections` counts the selection ranges; `selected` describes the main
 *   one when it is not empty.
 */
export function positionText(at) {
  if (at.selections > 1) return plural(at.selections, "selection", "selections");
  if (at.selected) {
    const { lines, chars, words } = at.selected;
    const size = lines > 1 ? `${lines} lines, ${plural(chars, "character", "characters")}` : plural(chars, "character", "characters");
    return `${size} selected · ${plural(words, "word", "words")}`;
  }
  return `Line ${at.line}, Column ${at.column} · ${plural(at.words, "word", "words")}`;
}

/**
 * The state sign: "✓" when all is complete, "…" while something waits, and
 * words for a problem.
 *
 * "synced" of the sync client is NOT used as proof: it is a state of the
 * client, set at startup before any round ran, and a round can end "idle"
 * with a note still dirty (sync/client.js). The note's own record says
 * whether the server has its last change.
 *
 * @param {{ save: string, syncs: boolean, waiting: boolean,
 *           client: "off" | "idle" | "syncing" | "error" | "offline",
 *           slow?: boolean }} s
 *   `save` is the store's save status ("saved", "…", "locked", "disk write
 *   failed"). `syncs`: the note has a server target. `waiting`: its record
 *   has a change the server does not have (dirty, or never pushed). `slow`:
 *   the save is open for longer than a healthy one takes (ui/statusbar.js).
 * @returns {{ text: string, problem: boolean, title: string }}
 */
export function stateSign({ save, syncs, waiting, client, slow }) {
  if (save === "locked" || save === "disk write failed") {
    return { text: save, problem: true, title: save === "locked" ? "The note is locked." : "The file could not be written." };
  }
  const server = syncs && client !== "off";
  if (save === "…") {
    // A save that waits on the disk or on IndexedDB with no answer shows
    // "…" for ever and reports no error (architecture.md §30). The text of
    // the note is then in memory only, so the sign must stop looking like
    // work in progress and must say what to do.
    return slow
      ? { text: "not saved yet", problem: true, title: "The last change is not saved yet. Keep this window open." }
      : { text: "…", problem: false, title: "Saving on this device." };
  }
  if (server && (client === "offline" || client === "error")) {
    const why = client === "offline" ? "offline" : "sync error";
    return { text: "saved · " + why, problem: true, title: "Saved on this device, not on the server (" + why + ")." };
  }
  if (server && waiting) return { text: "…", problem: false, title: "Saved on this device. Waiting for the server." };
  return {
    text: "✓",
    problem: false,
    title: server ? "Saved on this device and on the server." : "Saved on this device.",
  };
}

/**
 * How long a notice stays, in ms. A short one ("copied") keeps the old
 * 1.5 s; a long one gets reading time. "the model did not answer; 3 words
 * changed, 1 word needs your choice (blue mark)" was gone after 1.5 s,
 * before the user could read past its first words (phone test, 2026-11-20).
 * About 15 characters a second, the pace of a person who looks up from the
 * text, and at most 10 s, so a notice never hides the state for long.
 * @param {string} text
 */
export function readTime(text) {
  return Math.min(10000, Math.max(1500, 1000 + text.length * 65));
}
