// CodeMirror 6 setup: explicit extension list, Mariana theme, Mariana
// highlight style. We assemble the extensions by hand instead of using
// `basicSetup` so the defaults can match Sublime Text 4 exactly.

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { twemoji } from "./emoji.js";
import { spellcheck } from "./spellcheck.js";
import {
  extensionForLang,
  langCompartment,
  langForRecord,
  pasteDominates,
  sniff,
} from "./lang.js";

// Mariana palette (sublime-defaults.md part 2.3).
const BACKGROUND = "#303841";
const FOREGROUND = "#D8DEE9";
const CARET = "#F9AE58";
const SELECTION = "rgba(89, 102, 115, 0.7)";
const GUTTER_FG = "#647382"; // approximation: Mariana defines no gutter colors
const FIND_HIGHLIGHT = "#FAC761";
const FIND_HIGHLIGHT_FG = "#333333";

export const marianaTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: BACKGROUND,
      color: FOREGROUND,
      fontFamily:
        'Consolas, Menlo, "DejaVu Sans Mono", "Cascadia Mono", monospace',
      fontSize: "14px",
      height: "100%",
    },
    ".cm-content": {
      caretColor: CARET,
      // Sublime's line_padding_top/bottom are 0, so no extra leading here.
      padding: "0",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.4",
    },
    // drawSelection() paints the caret as a border on .cm-cursor.
    // caret_extra_width is 1 in Sublime, hence 1px.
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: CARET,
      borderLeftWidth: "1px",
    },
    "&.cm-focused .cm-cursor": { borderLeftColor: CARET },
    // Sublime's caret_style default is "solid", not blinking.
    ".cm-cursorLayer": { animation: "none" },

    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: SELECTION },
    ".cm-selectionBackground": { backgroundColor: SELECTION },

    ".cm-gutters": {
      backgroundColor: BACKGROUND,
      color: GUTTER_FG,
      border: "none",
      // Sublime's `margin` default is 4px between gutter and text.
      paddingRight: "4px",
    },
    // highlight_gutter is true in Sublime while highlight_line is false, so the
    // active row is marked in the gutter only, by brightening the number.
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: FOREGROUND,
    },

    ".cm-searchMatch": {
      backgroundColor: FIND_HIGHLIGHT,
      color: FIND_HIGHLIGHT_FG,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: FIND_HIGHLIGHT,
      color: FIND_HIGHLIGHT_FG,
    },
    // No .cm-selectionMatch rule and no highlightSelectionMatches() extension:
    // Mariana has no selection-match color, so the feature stays off.

    ".cm-panels": { backgroundColor: "#2E3238", color: "#D9D9D9" },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "#22262A",
      color: "#D9D9D9",
      border: "1px solid #647382",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      // brackets_options in Mariana is `underline`, not a background fill.
      backgroundColor: "transparent",
      color: CARET,
      textDecoration: "underline",
    },
  },
  { dark: true }
);

export const marianaHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "#A6ACB9" },
  { tag: tags.string, color: "#99C794" },
  { tag: tags.number, color: "#F9AE58" },
  { tag: tags.keyword, color: "#C695C6" },
  { tag: tags.operator, color: "#F97B58" },
  { tag: tags.function(tags.variableName), color: "#6699CC" },
  { tag: tags.function(tags.definition(tags.variableName)), color: "#5FB4B4" },
  { tag: tags.definition(tags.propertyName), color: "#5FB4B4" },
  { tag: [tags.typeName, tags.className], color: "#F9AE58" },
  { tag: [tags.bool, tags.null], color: "#EC5F66", fontStyle: "italic" },
  { tag: tags.tagName, color: "#EC5F66" },
  { tag: tags.attributeName, color: "#C695C6" },
  // Sublime colors only the leading `#` marks and leaves heading text plain.
  // Bolding the whole heading is the documented PoC simplification.
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "#6699CC" },
  { tag: tags.monospace, backgroundColor: "#3E4852" },
  { tag: tags.quote, color: "#99C794" },
  { tag: tags.invalid, color: "#F7F7F7", backgroundColor: "#EC5F66" },
]);

/**
 * @param {string} lang Language id for the whole document (editor/lang.js).
 * @param {(content: string) => void} [onDocChanged]
 * @param {(content: string) => void} [onDominantPaste] Called after a paste
 *   large enough to redefine what the buffer is. See pasteDominates.
 */
function baseExtensions(lang, onDocChanged, onDominantPaste) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    // highlightActiveLine() is deliberately absent: Sublime's `highlight_line`
    // default is false, so the current line body carries no background.
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    // The document language, in a compartment so "set syntax" and a paste can
    // swap it with one dispatch instead of rebuilding the state and losing the
    // undo history (architecture.md §9).
    langCompartment.of(extensionForLang(lang)),
    // Color emoji as vendored SVGs. A view decoration only: the document text
    // keeps the original characters (architecture.md §10).
    twemoji(),
    // Harper spellcheck (architecture.md §11). The wasm engine loads on the
    // first lint pass, so this costs nothing until the user types.
    spellcheck(),
    syntaxHighlighting(marianaHighlight),
    marianaTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onDocChanged) {
        onDocChanged(update.state.doc.toString());
      }
    }),
    // Language re-detection after a paste, and only after a paste: sniffing on
    // every keystroke would recolor a note the moment its first line happens
    // to parse as JSON (architecture.md §9).
    EditorView.updateListener.of((update) => {
      if (!onDominantPaste || !update.docChanged) return;
      let inserted = 0;
      let pasted = false;
      for (const transaction of update.transactions) {
        // The user event CodeMirror's own paste handler annotates. Programmatic
        // dispatches carry no such annotation, so a reload from disk or an
        // applied spelling fix can never trigger detection.
        if (!transaction.isUserEvent("input.paste")) continue;
        pasted = true;
        transaction.changes.iterChanges((_fa, _ta, _fb, _tb, text) => {
          inserted += text.length;
        });
      }
      if (!pasted) return;
      const before = update.startState.doc;
      const blankBefore = before.length === 0 || !/\S/.test(before.toString());
      if (!pasteDominates(inserted, update.state.doc.length, blankBefore)) return;
      onDominantPaste(update.state.doc.toString());
    }),
  ];
}

/**
 * @param {string} content
 * @param {string} lang Language id (editor/lang.js).
 * @param {(content: string) => void} [onDocChanged]
 * @param {(content: string) => void} [onDominantPaste]
 */
export function createEditorState(content, lang, onDocChanged, onDominantPaste) {
  return EditorState.create({
    doc: content || "",
    extensions: baseExtensions(lang, onDocChanged, onDominantPaste),
  });
}

// Editor controller. One view, many states: buffer switching is
// view.setState(state), which keeps per-buffer undo history alive without a
// second DOM tree. States are built lazily on first activation.
// The controller only listens to store events; its one write back into the
// store is updateContent, the editor's legitimate output.
export function mountEditor(host, store) {
  const view = new EditorView({ parent: host });
  const states = new Map(); // id -> EditorState

  /**
   * A paste that redefines the buffer re-runs detection. The id is captured
   * per state, not read from store.activeId: one state belongs to exactly one
   * buffer for its whole life, so the capture cannot go stale, while
   * store.activeId is momentarily the *next* buffer during a switch.
   * @param {string} id @param {string} content
   */
  function detectAfterPaste(id, content) {
    const record = store.get(id);
    // A file-backed buffer is named by its extension and stays that way.
    // Pasting JSON into a .js file does not make the file JSON.
    if (!record || record.kind === "file") return;
    // "auto" here: the store drops it when the user has set the syntax by hand.
    store.setLang(id, sniff(content), "auto");
  }

  function stateFor(id) {
    let state = states.get(id);
    if (!state) {
      const record = store.get(id);
      // Detection at open lives here, not in the store: the record keeps a
      // language only once something decided one (a paste, a file name, the
      // user). Sniffing an old record on open costs one JSON.parse and writes
      // nothing, so loading a hundred buffers stays read-only.
      state = createEditorState(
        record ? record.content : "",
        langForRecord(record),
        (content) => store.updateContent(id, content),
        (content) => detectAfterPaste(id, content)
      );
      states.set(id, state);
    }
    return state;
  }

  store.events.addEventListener("active", (event) => {
    const { id, previousId } = /** @type {CustomEvent} */ (event).detail;
    // Park the live state before swapping, so undo history survives the switch.
    if (previousId) states.set(previousId, view.state);
    view.setState(stateFor(id));
    view.focus();
  });

  store.events.addEventListener("evict", (event) => {
    states.delete(/** @type {CustomEvent} */ (event).detail.id);
  });

  // The buffer's language changed (a paste, or the syntax command). The mode
  // swaps through the compartment, so the text, the selection and the undo
  // history all survive it.
  store.events.addEventListener("lang", (event) => {
    const { id, lang } = /** @type {CustomEvent} */ (event).detail;
    const effects = langCompartment.reconfigure(extensionForLang(lang));
    if (id === store.activeId) {
      view.dispatch({ effects });
      return;
    }
    // A parked buffer gets the same reconfiguration applied to its cached
    // state. Without this it would keep the old mode until it is evicted,
    // because stateFor only builds a state once.
    const state = states.get(id);
    if (state) states.set(id, state.update({ effects }).state);
  });

  // A file changed on disk and the store took the new text. The document is
  // replaced with one dispatched change instead of a fresh state, so the undo
  // history survives and the reload itself is undoable.
  store.events.addEventListener("replace", (event) => {
    const { id, content } = /** @type {CustomEvent} */ (event).detail;
    const live = id === store.activeId;
    // No cached state means the buffer was never opened here; its next
    // activation builds from the record, which already holds the new text.
    const base = live ? view.state : states.get(id);
    if (!base) return;
    const transaction = base.update({
      changes: { from: 0, to: base.doc.length, insert: content },
      // Own undo step. Without this the reload merges into whatever the user
      // typed in the last half second, and one Ctrl+Z would undo both.
      annotations: isolateHistory.of("full"),
    });
    if (live) view.dispatch(transaction);
    else states.set(id, transaction.state);
  });

  return { view, states };
}
