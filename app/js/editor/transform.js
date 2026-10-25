// @ts-check
// Text transforms: the Edit menu of the desktop shell (src-tauri/src/lib.rs,
// EDIT_*) and the Sublime chords in editor.js reach the same commands. Each
// one is a CodeMirror command, like those in @codemirror/commands: it reads
// view.state, dispatches one transaction and says whether it applied. The
// line moves (Move Line Up, Duplicate Line, ...) come from that package and
// are only given ids here.

import { EditorSelection } from "@codemirror/state";
import { copyLineDown, deleteLine, moveLineDown, moveLineUp } from "@codemirror/commands";
import { register } from "../commands/registry.js";

/** @typedef {import("@codemirror/view").Command} Command */
/** @typedef {import("@codemirror/view").EditorView} EditorView */

/**
 * A word for Title Case: letters or digits, with marks and an apostrophe
 * inside, so "don't" is one word and "well-known" is two, as in Sublime. A
 * word that starts with a digit ("2nd") has no letter to raise.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu;

/** @param {string} text */
export function toTitleCase(text) {
  return text
    .toLowerCase()
    .replace(WORD, (word) => word.replace(/^\p{L}/u, (first) => first.toUpperCase()));
}

/** @param {string} text */
export function toSwappedCase(text) {
  // Array.from walks code points, so a character outside the BMP is not cut
  // into two surrogates before the case mapping sees it.
  return Array.from(text, (char) => {
    const upper = char.toUpperCase();
    return upper === char ? char.toLowerCase() : upper;
  }).join("");
}

/**
 * Convert the case of every selection. A bare cursor converts the word it
 * is in, as in Sublime, and stays a cursor; a selection stays selected and
 * keeps its direction, whatever the new text's length ("ß" uppercases to
 * "SS"). Applied when any range had text to convert, even text already in
 * that case: the chord did its job, and nothing else should get the key.
 * @param {(text: string) => string} convert
 * @returns {Command}
 */
function convertCase(convert) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    let applied = false;
    const spec = state.changeByRange((range) => {
      let { from, to } = range;
      if (range.empty) {
        const word = state.wordAt(from);
        if (!word) return { range };
        ({ from, to } = word);
      }
      applied = true;
      const text = state.sliceDoc(from, to);
      const insert = convert(text);
      if (insert === text) return { range };
      const end = from + insert.length;
      const next = range.empty
        ? EditorSelection.cursor(Math.min(range.head, end))
        : EditorSelection.range(range.head < range.anchor ? end : from, range.head < range.anchor ? from : end);
      return { changes: { from, to, insert }, range: next };
    });
    if (!spec.changes.empty) {
      view.dispatch(state.update(spec, { userEvent: "input", scrollIntoView: true }));
    }
    return applied;
  };
}

export const upperCase = convertCase((text) => text.toUpperCase());
export const lowerCase = convertCase((text) => text.toLowerCase());
export const titleCase = convertCase(toTitleCase);
export const swapCase = convertCase(toSwappedCase);

/** @param {string} text The width of the indentation at the start. */
const indentWidth = (text) => text.length - text.trimStart().length;

/**
 * Join each selected line with the line below it: one space between them,
 * the lower line's indentation gone, a blank line in between gone. A bare
 * cursor joins its line with the next one (Sublime's Ctrl+J).
 * @type {Command}
 */
export const joinLines = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  // The lines that take the line below them, once each: two cursors on one
  // line are one join, and overlapping changes would throw.
  /** @type {Set<number>} */
  const joins = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (last === first) last++;
    for (let n = first; n < last && n < state.doc.lines; n++) joins.add(n);
  }
  // Each join replaces the gap from the upper line's trailing space to the
  // lower line's first word. Whether a space goes in depends on text being
  // on both sides, and "both sides" spans a run of joins: in "a", "", "b"
  // the blank middle line vanishes and "a b" still gets its one space.
  const changes = [];
  let textOnTheLeft = false;
  for (const n of [...joins].sort((a, b) => a - b)) {
    const line = state.doc.line(n);
    const below = state.doc.line(n + 1);
    if (!joins.has(n - 1)) textOnTheLeft = line.text.trim() !== "";
    // A line of only spaces has its "trailing" space start after its
    // "leading" space ends; the max keeps this gap behind the previous one.
    const trail = Math.max(line.text.trimEnd().length, indentWidth(line.text));
    const belowText = below.text.trim();
    changes.push({
      from: line.from + trail,
      to: below.from + indentWidth(below.text),
      insert: textOnTheLeft && belowText ? " " : "",
    });
    if (belowText) textOnTheLeft = true;
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "delete.join", scrollIntoView: true });
  return true;
};

/**
 * Sort the selected lines, case ignored and numbers read as numbers ("item
 * 2" before "item 10"); equal lines keep their order. Without a selection
 * the whole document sorts, as in Sublime. A selection that ends at the
 * start of a line leaves that line out, like CodeMirror's own line commands.
 * @type {Command}
 */
export const sortLines = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  /** @type {{first: number, last: number}[]} line number spans, merged */
  const blocks = [];
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (!ranges.length) {
    blocks.push({ first: 1, last: state.doc.lines });
  } else {
    for (const range of ranges) {
      const first = state.doc.lineAt(range.from).number;
      const end = state.doc.lineAt(range.to);
      const last = end.from === range.to ? end.number - 1 : end.number;
      // Ranges come sorted. Two on the same line merge, since one line
      // cannot be in two changes; two blocks that merely touch stay apart
      // and sort on their own.
      const previous = blocks[blocks.length - 1];
      if (previous && first <= previous.last) previous.last = Math.max(previous.last, last);
      else blocks.push({ first, last });
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const changes = [];
  for (const { first, last } of blocks) {
    if (last <= first) continue;
    const lines = [];
    for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text);
    const sorted = [...lines].sort(collator.compare);
    if (sorted.every((text, i) => text === lines[i])) continue;
    changes.push({
      from: state.doc.line(first).from,
      to: state.doc.line(last).to,
      insert: sorted.join(state.lineBreak),
    });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "move.sort", scrollIntoView: true });
  return true;
};

/**
 * Give the transforms their command ids, for the shell's Edit menu. Each
 * runs on the live view and focuses it: a menu click lands with the focus
 * on the menu, and the editor is where the result shows.
 * @param {{view: EditorView}} editor The editor controller.
 */
export function mountTransforms(editor) {
  /** @type {[string, string, Command][]} */
  const table = [
    ["edit.moveLineUp", "Move line up", moveLineUp],
    ["edit.moveLineDown", "Move line down", moveLineDown],
    ["edit.duplicateLine", "Duplicate line", copyLineDown],
    ["edit.deleteLine", "Delete line", deleteLine],
    ["edit.joinLines", "Join lines", joinLines],
    ["edit.sortLines", "Sort lines", sortLines],
    ["edit.upperCase", "Upper case", upperCase],
    ["edit.lowerCase", "Lower case", lowerCase],
    ["edit.titleCase", "Title case", titleCase],
    ["edit.swapCase", "Swap case", swapCase],
  ];
  for (const [id, title, command] of table) {
    register({
      id,
      title,
      run: () => {
        editor.view.focus();
        return command(editor.view);
      },
    });
  }
}
