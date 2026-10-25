// @ts-check
// Multiple cursors, Sublime's way. CodeMirror keeps every range of a
// selection only while `allowMultipleSelections` is on; without the facet
// a second Ctrl+D jumped to the next match instead of adding it, and a
// Ctrl+click moved the one caret. The facet, the two mouse gestures and
// the two commands Sublime has and CodeMirror lacks live here. The keys
// are in editor.js with the other Sublime chords.

import { EditorSelection, EditorState } from "@codemirror/state";
import { crosshairCursor, rectangularSelection } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";

/** @typedef {import("@codemirror/view").Command} Command */

/**
 * Column selection, Sublime's two gestures in one filter: the middle button
 * (Windows, Linux) and Alt with the left button (macOS, and CodeMirror's
 * own default). Shift+right drag, Sublime's third, is out: the right button
 * opens the context menu on its way down. The middle button has a known
 * cost on Linux, where the webview may also paste the primary selection on
 * the release; a report decides whether the button stays.
 * @param {MouseEvent} event
 */
const columnGesture = (event) => event.button === 1 || (event.altKey && event.button === 0);

/**
 * The facet and the mouse. Ctrl+click (Cmd on a Mac) adds a caret with no
 * code of ours: the view's mouse handler checks the facet and the modifier
 * on every click. Alt held turns the pointer into a crosshair, the hint
 * that a drag now selects a column.
 */
export function multipleCursors() {
  return [
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection({ eventFilter: columnGesture }),
    crosshairCursor(),
  ];
}

/**
 * Sublime's Alt+F3: select every occurrence of the selected text. A bare
 * cursor takes the word it is in and then matches whole words only, as
 * Sublime does, so "in" does not also pick the middle of "find". With
 * several ranges the main one gives the text, which is what Alt+F3 after
 * two Ctrl+D does. The 1000 cap is CodeMirror's own, from its
 * selectSelectionMatches: a selection of ten thousand ranges freezes the
 * view, and nobody edits that many places at once.
 * @type {Command}
 */
export const selectAllOccurrences = ({ state, dispatch }) => {
  let { from, to } = state.selection.main;
  const wholeWord = from === to;
  if (wholeWord) {
    const word = state.wordAt(from);
    if (!word) return false;
    ({ from, to } = word);
  }
  const text = state.sliceDoc(from, to);
  const ranges = [];
  let main = 0;
  for (const cursor = new SearchCursor(state.doc, text); !cursor.next().done; ) {
    const match = cursor.value;
    if (wholeWord) {
      const word = state.wordAt(match.from);
      if (!word || word.from !== match.from || word.to !== match.to) continue;
    }
    if (ranges.length >= 1000) return false;
    if (match.from === from) main = ranges.length;
    ranges.push(EditorSelection.range(match.from, match.to));
  }
  dispatch(
    state.update({
      selection: EditorSelection.create(ranges, main),
      userEvent: "select.search.matches",
    })
  );
  return true;
};

/**
 * Sublime's Ctrl+Shift+L: one selection per line of a selection that spans
 * several. Each piece runs from where the selection enters the line to
 * where it leaves it, a blank line in the middle keeps a bare cursor. A
 * selection that ends at the start of a line leaves that line out, like
 * the line commands here and in CodeMirror: Shift+Down over two lines
 * means two lines, not two and a caret under them. Ranges on one line
 * stay as they are, and when none spans two lines the key is not taken.
 * @type {Command}
 */
export const splitSelectionIntoLines = ({ state, dispatch }) => {
  const ranges = [];
  let main = 0;
  let split = false;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const end = state.doc.lineAt(range.to);
    const last = end.from === range.to && end.number > first.number ? end.number - 1 : end.number;
    if (first.number === last) {
      if (range === state.selection.main) main = ranges.length;
      ranges.push(range);
      continue;
    }
    split = true;
    // The piece that holds the old head stays main, so the view does not
    // scroll off to the first line of a long selection. A head on the line
    // left out belongs to the piece above it.
    const headLine = Math.min(state.doc.lineAt(range.head).number, last);
    for (let n = first.number; n <= last; n++) {
      const line = state.doc.line(n);
      if (range === state.selection.main && n === headLine) main = ranges.length;
      ranges.push(EditorSelection.range(Math.max(line.from, range.from), Math.min(line.to, range.to)));
    }
  }
  if (!split) return false;
  dispatch(state.update({ selection: EditorSelection.create(ranges, main), userEvent: "select" }));
  return true;
};
