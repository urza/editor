// @ts-check
// Offline English spellcheck (architecture.md §11). Harper runs as a vendored
// WebAssembly module and its findings become CodeMirror diagnostics: a dotted
// underline, a hover tooltip, and one-click fixes.
//
// Nothing here touches the document by itself. The only writes are the
// dispatches a user makes by clicking a suggestion button.

import { EditorView, ViewPlugin } from "@codemirror/view";
import { forceLinting, linter } from "@codemirror/lint";

// Resolved against the document, which is index.html, not against this
// module: Harper fetches the binary with a plain fetch(), which resolves
// relative URLs against the page. "./vendor/..." is therefore correct and
// "../../vendor/..." would be wrong.
const WASM_URL = "./vendor/harper/harper_wasm_slim_bg.wasm";

// The "slim" build is Harper without the typst parser and the thesaurus, and
// it is the flavor its own loader handles cleanly: asking for "full" makes
// harper.js fetch and instantiate the slim binary *first*, so a full setup
// costs two 15 MB downloads unless the slim one 404s. One binary, one fetch.
const WASM_FLAVOR = "slim";

const STORAGE_KEY = "vrtti.spellcheck";

// Sublime shows spelling errors while you type but not on every keystroke.
// 600 ms is long enough that a fast typist never triggers a pass mid-word.
const LINT_DELAY = 600;

// Harper is fast (measured: 10,400 characters in 80 ms in Chromium) but it
// runs on the main thread, and each pass copies the whole document to wasm.
// At 100,000 characters a pass costs the better part of a second, which is a
// visible freeze. Long documents get no spellcheck rather than a stutter.
// A worker (harper.js also ships WorkerLinter) is the way to lift this cap.
const MAX_DOC_CHARS = 100000;

// Harper offers up to a dozen spellings for a badly mangled word. The tooltip
// is a row of buttons, so past a handful it stops being a quick fix.
const MAX_ACTIONS = 5;

// Harper's lint_kind() strings are: Agreement, BoundaryError, Capitalization,
// Eggcorn, Enhancement, Formatting, Grammar, Malapropism, Miscellaneous,
// Nonstandard, Punctuation, Readability, Redundancy, Regionalism, Repetition,
// Spelling, Style, Typo, Usage, WordChoice, WordOrder.
// Only a word that is not a word gets the red "warning" underline. Everything
// else is an opinion about grammar or style and gets the quieter "info" one.
const WARNING_KINDS = new Set(["Spelling", "Typo"]);

// SuggestionKind from harper.js, compared numerically so the enum is not
// needed before the module loads. The third value, Replace = 0, is the common
// case and needs no constant: it is what toAction falls through to.
const REMOVE = 1;
const INSERT_AFTER = 2;

/** @type {Set<EditorView>} */
const views = new Set();

/** @type {Promise<any> | null} */
let loading = null;
/** @type {any} */
let engine = null;
let engineBroken = false;

let enabled = readEnabled();

// The lint plugin only re-runs when the document changes. Neither the toggle
// nor the engine finishing its load changes text, so both bump this counter,
// and `needsRefresh` then reports the last pass as stale. See relintAll.
let generation = 0;
let lintedGeneration = 0;

/**
 * Re-run the lint pass on every open editor, now.
 *
 * Three steps, all required. forceLinting() only runs a pass that is already
 * *pending*, and the lint plugin marks one pending on a document change alone.
 * Bumping the counter makes needsRefresh report the last pass as stale, the
 * empty transaction is what makes the plugin ask needsRefresh at all, and the
 * force then runs the scheduled pass immediately instead of after the delay.
 */
function relintAll() {
  generation++;
  for (const view of views) {
    view.dispatch({});
    forceLinting(view);
  }
}

function readEnabled() {
  try {
    // Default on: absent means "never toggled", not "off".
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** @returns {boolean} */
export function isEnabled() {
  return enabled;
}

/**
 * Turn spellcheck on or off and repaint the open editors at once.
 * @param {boolean} on
 */
export function setEnabled(on) {
  if (on === enabled) return;
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode with storage denied: the toggle still works this session.
  }
  relintAll();
}

/**
 * Load the Harper engine once, in the background. Returns null until the wasm
 * is ready, so the first lint passes cost nothing and app startup pays nothing.
 * @returns {any}
 */
function engineOrLoad() {
  if (engine || engineBroken) return engine;
  if (!loading) {
    // Bare specifier, resolved by the import map like every other dependency.
    loading = import("harper.js")
      .then(async (harper) => {
        const binary = harper.createBinaryModuleFromUrl(WASM_URL, WASM_FLAVOR);
        const local = new harper.LocalLinter({ binary });
        await local.setup();
        engine = local;
        // The pass that started this load returned []. Nothing else will ask
        // for a new one until the user types, so ask on its behalf.
        relintAll();
      })
      .catch((err) => {
        // One report, then stay quiet: retrying would re-fetch 15 MB on every
        // keystroke. The editor keeps working without spellcheck.
        engineBroken = true;
        console.error("[vrtti] Harper failed to load", err);
      });
  }
  return null;
}

/**
 * One Harper suggestion becomes one diagnostic action button.
 * @param {any} suggestion
 * @returns {import("@codemirror/lint").Action}
 */
function toAction(suggestion) {
  const kind = suggestion.kind();
  const text = suggestion.get_replacement_text();
  const name = kind === REMOVE ? "Remove" : text;
  return {
    name,
    // from/to are the diagnostic's *current* positions: @codemirror/lint maps
    // them through every edit made since the pass ran, so a stale suggestion
    // still lands on the right word.
    apply: (view, from, to) => {
      const change =
        kind === INSERT_AFTER
          ? { from: to, to, insert: text }
          : { from, to, insert: kind === REMOVE ? "" : text };
      view.dispatch({ changes: change, userEvent: "input.complete" });
    },
  };
}

/**
 * One Harper lint becomes one CodeMirror diagnostic.
 *
 * Offsets are UTF-16 code-unit indices, the same units CodeMirror counts, so
 * no conversion happens here. That is verified, not assumed: linting
 * "😀😀 speling errr" in Chromium returns span [5, 12] for "speling", and
 * text.slice(5, 12) === "speling". Code-point offsets would have been [3, 10]
 * and the underline would sit two characters to the left of the word. The
 * Playwright case that locks this down types exactly that string and asserts
 * the underlined text.
 *
 * The wasm objects are freed as we go. They are Rust allocations that a
 * FinalizationRegistry would eventually reclaim, but a pass over a long
 * document makes hundreds of them every 600 ms, so waiting for GC lets wasm
 * memory drift upward. Everything needed is copied out first.
 *
 * @param {any} lint
 * @returns {import("@codemirror/lint").Diagnostic}
 */
function toDiagnostic(lint) {
  const span = lint.span();
  const from = span.start;
  const to = span.end;
  span.free();

  const suggestions = lint.suggestions();
  const actions = [];
  for (let i = 0; i < suggestions.length; i++) {
    if (i < MAX_ACTIONS) actions.push(toAction(suggestions[i]));
    suggestions[i].free();
  }

  const diagnostic = {
    from,
    to,
    severity: WARNING_KINDS.has(lint.lint_kind()) ? "warning" : "info",
    message: lint.message(),
    // Rendered small under the message, e.g. "Spelling", "Word Choice".
    source: lint.lint_kind_pretty(),
    actions,
  };
  lint.free();
  return /** @type {import("@codemirror/lint").Diagnostic} */ (diagnostic);
}

/**
 * The lint source. Runs on the main thread; see MAX_DOC_CHARS.
 * @param {EditorView} view
 * @returns {Promise<readonly import("@codemirror/lint").Diagnostic[]>}
 */
async function harperSource(view) {
  lintedGeneration = generation;
  if (!enabled) return [];
  if (view.state.doc.length > MAX_DOC_CHARS) return [];

  const local = engineOrLoad();
  if (!local) return [];

  // No `language` option: Harper defaults to Markdown, which is what the
  // editor's own language mode assumes, and it keeps code fences out.
  const lints = await local.lint(view.state.doc.toString());
  return lints.map(toDiagnostic);
}

// The view set drives forceLinting from setEnabled and from the engine load,
// neither of which is triggered by the editor itself.
const trackViews = ViewPlugin.define((view) => {
  views.add(view);
  return { destroy: () => views.delete(view) };
});

// Mariana (sublime-defaults.md part 2.3), same palette as marianaTheme in
// editor.js. Dotted rather than CodeMirror's default squiggle, and set through
// text-decoration, which is why .cm-lintRange loses the base theme's
// background-image: the two would otherwise draw one line each.
const SPELLING = "#EC5F66"; // Mariana red
const HINT = "#6699CC"; // Mariana blue
const PANEL_BG = "#2E3238";
const PANEL_FG = "#D9D9D9";
const BORDER = "#647382";

const spellcheckTheme = EditorView.theme({
  ".cm-lintRange": {
    backgroundImage: "none",
    paddingBottom: "0",
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "0.18em",
  },
  ".cm-lintRange-warning": { textDecorationColor: SPELLING },
  ".cm-lintRange-info": { textDecorationColor: HINT },
  ".cm-lintRange-active": { backgroundColor: "rgba(236, 95, 102, 0.18)" },

  // The hover tooltip. CodeMirror renders it inside the editor's own DOM, so
  // the theme reaches it; without these rules it falls back to the light
  // default and glares against Mariana.
  ".cm-tooltip": {
    backgroundColor: PANEL_BG,
    color: PANEL_FG,
    border: "1px solid " + BORDER,
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: BORDER,
    borderBottomColor: BORDER,
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: PANEL_BG,
    borderBottomColor: PANEL_BG,
  },
  ".cm-tooltip-lint": { maxWidth: "32em" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid " + SPELLING },
  ".cm-diagnostic-info": { borderLeft: "3px solid " + HINT },
  ".cm-diagnosticAction": {
    backgroundColor: "#22262A",
    color: PANEL_FG,
    border: "1px solid " + BORDER,
    borderRadius: "2px",
  },
  ".cm-diagnosticAction:hover": { backgroundColor: "#393F46" },
});

/**
 * The spellcheck extension. No lint gutter on purpose: underlines and hover
 * tooltips only, so the gutter keeps showing line numbers alone.
 * @returns {import("@codemirror/state").Extension}
 */
export function spellcheck() {
  return [
    linter(harperSource, {
      delay: LINT_DELAY,
      needsRefresh: () => generation !== lintedGeneration,
    }),
    trackViews,
    spellcheckTheme,
  ];
}
