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
import { run } from "../commands/registry.js";
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

    // drawSelection() paints the selection as its own layer and hides the
    // native ::selection with !important, so only .cm-selectionBackground
    // matters here. The focused selector must spell out this full child path:
    // CodeMirror's base dark theme uses exactly that path, and any shorter
    // selector loses to it on specificity, which left the built-in #233 teal
    // visible instead of Mariana's selection (user report, 2026-09-02).
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      { backgroundColor: SELECTION },

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

const LOCKED_TEXT = "Locked. Unlock to read this document.";
const FOREIGN_TEXT = "Encrypted for another device. This device has no key for it.";

/**
 * What an encrypted document shows while its text is out of reach: locked, or
 * still decoding (architecture.md §5).
 *
 * It carries no update listener and no history on purpose. This state is not
 * the document, so nothing typed into it may ever reach the store, and nothing
 * here may ever be parked in the state cache.
 */
export function createLockedState(text = LOCKED_TEXT) {
  return EditorState.create({
    doc: text,
    extensions: [
      // Styled as a notice, not as a document: app.css dims .cm-locked.
      EditorView.editorAttributes.of({ class: "cm-locked" }),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      syntaxHighlighting(marianaHighlight),
      marianaTheme,
    ],
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

  // The buffer whose state is on screen as the locked placeholder, or null.
  // Tracked because a placeholder must never be treated as a document: it is
  // not parked into `states` and it is what the unlock event looks for.
  /** @type {string | null} */
  let placeholderId = null;
  // The buffer a decode is running for, or null. It stops the two retry paths
  // after an unlock (this module's own, and the store's "unlock" event) from
  // starting a second decode of the same document.
  /** @type {string | null} */
  let decodingId = null;
  // Bumped on every lock. A decode that was already in flight when the user
  // locked must not cache the plaintext state it is about to resolve with.
  let generation = 0;
  // One unlock prompt per activation. Without it a cancelled prompt could be
  // re-opened by the next event, which is a dialog loop.
  let asking = false;

  /** @param {string} id @param {string} text */
  function realState(id, text) {
    const record = store.get(id);
    // Detection at open lives here, not in the store: the record keeps a
    // language only once something decided one (a paste, a file name, the
    // user). Sniffing an old record on open costs one JSON.parse and writes
    // nothing, so loading a hundred buffers stays read-only.
    //
    // The copy with the decoded text is for encrypted docs: sniffing
    // record.content would sniff ciphertext and always land on the default.
    const forLang = record && record.enc ? { ...record, content: text } : record;
    return createEditorState(
      text,
      langForRecord(forLang),
      (content) => store.updateContent(id, content),
      (content) => detectAfterPaste(id, content)
    );
  }

  /**
   * Ask for the passphrase, once, and put the document up when it arrives.
   * A cancelled prompt leaves the placeholder standing; the user gets another
   * prompt the next time they open the document, and never a loop.
   * @param {string} id
   */
  function askUnlock(id) {
    if (asking) return;
    asking = true;
    Promise.resolve(run("crypto.unlock"))
      .catch(() => false)
      .then((ok) => {
        asking = false;
        // The store's "unlock" event usually got here first; reactivate()
        // then finds the decode already running and does nothing.
        if (ok && id === store.activeId) reactivate(id);
      });
  }

  /** @param {string} id Put a buffer on screen, placeholder or document. */
  function reactivate(id) {
    if (decodingId === id) return;
    view.setState(stateFor(id));
  }

  function stateFor(id) {
    const cached = states.get(id);
    if (cached) {
      placeholderId = null;
      return cached;
    }
    const text = store.textOf(id);
    if (typeof text === "string") {
      const state = realState(id, text);
      states.set(id, state);
      placeholderId = null;
      return state;
    }

    // Encrypted and not decoded yet. The placeholder goes up now and the real
    // state swaps in when the decode lands, so the switch never blocks.
    placeholderId = id;
    decodingId = id;
    const gen = generation;
    text.then(
      (decoded) => {
        if (decodingId === id) decodingId = null;
        if (gen !== generation) return; // locked while this decode ran
        const state = realState(id, decoded);
        states.set(id, state);
        // Only if the user is still looking at this document: they may have
        // switched away while the decode ran.
        if (id !== store.activeId || placeholderId !== id) return;
        placeholderId = null;
        view.setState(state);
        view.focus();
      },
      (err) => {
        if (decodingId === id) decodingId = null;
        if (!err || err.name !== "LockedError") {
          console.log("[vrtti] decode failed", id, err);
          return;
        }
        // LockedError with the keyring already unlocked is the courier case
        // (§5): this device holds the ciphertext for another device and no
        // passphrase can open it. Asking would resolve true at once and
        // re-run this decode forever, freezing the tab. Say so and stop.
        if (store.isUnlocked) {
          if (id === store.activeId && placeholderId === id) {
            view.setState(createLockedState(FOREIGN_TEXT));
          }
          return;
        }
        askUnlock(id);
      }
    );
    return createLockedState();
  }

  store.events.addEventListener("active", (event) => {
    const { id, previousId } = /** @type {CustomEvent} */ (event).detail;
    if (previousId === id) {
      // The buffer on screen was clicked again. A document has nothing to do;
      // a locked placeholder gets its unlock prompt back after a cancel.
      if (placeholderId === id) reactivate(id);
      return;
    }
    // Park the live state before swapping, so undo history survives the
    // switch. Never the placeholder though: parking it would cache "Locked."
    // as the document's text and show it even after an unlock.
    if (previousId && previousId !== placeholderId) states.set(previousId, view.state);
    view.setState(stateFor(id));
    view.focus();
  });

  // The keyring locked (architecture.md §5). Every decoded state goes, which
  // takes its undo history with it, and the document on screen becomes the
  // placeholder. Deliberately without stateFor(): a decode attempt here would
  // fail and open an unlock prompt the moment the user asked to lock.
  store.events.addEventListener("lock", (event) => {
    const { ids } = /** @type {CustomEvent} */ (event).detail;
    for (const id of ids) states.delete(id);
    // Before the early return below: a decode of some other document may be in
    // flight, and it must not cache its plaintext state now either.
    generation++;
    decodingId = null;
    const active = store.activeId;
    if (!active || !ids.includes(active)) return;
    placeholderId = active;
    view.setState(createLockedState());
  });

  // The identity is back. Only a document that is showing the placeholder has
  // anything to do; every other state is still valid.
  store.events.addEventListener("unlock", () => {
    const active = store.activeId;
    if (active && placeholderId === active) reactivate(active);
  });

  store.events.addEventListener("evict", (event) => {
    const { id } = /** @type {CustomEvent} */ (event).detail;
    states.delete(id);
    // A closed buffer's placeholder is gone with it; leaving the id here would
    // make the next "active" skip parking a state that is a real document.
    if (placeholderId === id) placeholderId = null;
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
