// @ts-check
// Offline spellcheck (architecture.md §11): English through Harper, Czech
// through Hunspell, both vendored WebAssembly modules. Findings become
// CodeMirror diagnostics: a dotted underline, a hover tooltip, and one-click
// fixes.
//
// One rule decides a mark (mixed.js): a word gets one only when each active
// language rejects it, so a note can mix Czech and English freely. Which
// languages are active is a setting of each note (`spellOff` in the record,
// read through the `noteSpellOff` facet).
//
// Who sees which text is still decided per paragraph by textlang.js, for
// speed and not for the verdict:
//  - Paragraphs the detection calls English go to Harper as text, as before.
//    Harper's spelling findings then go through the rule (Hunspell may know
//    the word), and its grammar hints stay as they are.
//  - All other paragraphs are tokenized here. Each word is asked of Hunspell,
//    and of Harper one word at a time (isLikelyEnglish). Harper never gets a
//    Czech paragraph as text: on Czech it marks nearly every word and builds
//    suggestions for each, which took 1.7 s for 2,000 words in one block
//    (.work/mixed-spellcheck/experiment/results.md).
// A word that both reject and that has twins (diacritics.js) is Czech
// without diacritics: a blue mark whose fixes are the twins.
//
// Nothing here touches the document by itself. The only writes are the
// dispatches a user makes by clicking a suggestion button.

import { EditorView, ViewPlugin, keymap, showTooltip, tooltips } from "@codemirror/view";
import { Facet, StateEffect, StateField } from "@codemirror/state";
import { language } from "@codemirror/language";
import { forEachDiagnostic, forceLinting, linter } from "@codemirror/lint";
import { openMenu } from "../ui/menu.js";
import * as hunspell from "./hunspell.js";
import { activeLangs, judge, mergeSuggestions } from "./mixed.js";
import { WORD } from "./diacritics.js";
import { segments } from "./textlang.js";

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

// The source of a blue mark for Czech without diacritics, shown small under
// the message in the hover tooltip.
const PLAIN_SOURCE = "Czech without diacritics";

// Harper parses its input as Markdown and has no mode for anything else, so a
// JSON or JavaScript buffer would get every identifier underlined as a
// misspelling. Those buffers get no diagnostics at all (architecture.md §9).
//
// The mode is read from the state's own `language` facet instead of a getter
// the editor module sets. The facet already travels with each EditorState, so
// a parked buffer and the live one are both right with no wiring, no shared
// mutable variable, and no way for the two to disagree. `@codemirror/language`
// is already in the tree, so this costs no new dependency.
// A state with no language extension at all still gets spellcheck: plain text
// is exactly what Harper is for.
const MARKDOWN = "markdown";

/** @param {EditorView} view */
function isProse(view) {
  const mode = view.state.facet(language);
  return !mode || mode.name === MARKDOWN;
}

/**
 * The languages a note switched off, read when a pass runs. A function and
 * not a value: the editor builds a state once per note, and the field
 * changes later (a click, a sync). The function reads the record by the id
 * captured for the state, never by store.activeId, which names the next note
 * during a switch (editor.js, detectAfterPaste).
 * @type {Facet<() => readonly string[] | undefined, (() => readonly string[] | undefined) | null>}
 */
export const noteSpellOff = Facet.define({ combine: (values) => values[0] ?? null });

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

// Whether this module already asked hunspell.js to load. One request is
// enough: the load promise is shared, and its completion repaints once.
let czechRequested = false;

// Fires "change" on every flip of `enabled`. The state lives in this module,
// so the notification does too: the statusbar and the settings panel both
// render from it, and neither has to know which one flipped it.
export const events = new EventTarget();

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
 *
 * Exported for a change of a note's languages: that changes no text either.
 */
export function relintAll() {
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
  events.dispatchEvent(new Event("change"));
  relintAll();
}

/**
 * Load the Harper engine once, in the background. Returns null until the wasm
 * is ready, so the first lint passes cost nothing and app startup pays nothing.
 * @returns {any}
 */
function harperOrLoad() {
  if (engine || engineBroken) return engine;
  loadHarper();
  return null;
}

/** @returns {Promise<any>} The engine, or null when it failed to load. */
function loadHarper() {
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
        return engine;
      })
      .catch((err) => {
        // One report, then stay quiet: retrying would re-fetch 15 MB on every
        // keystroke. The editor keeps working without spellcheck.
        engineBroken = true;
        console.error("[vrtti] Harper failed to load", err);
        return null;
      });
  }
  return loading;
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
      // The caret lands after the fix, where typing continues; left to the
      // mapping it would sit before the word, as the old range collapsed.
      view.dispatch({
        changes: change,
        selection: { anchor: change.from + change.insert.length },
        userEvent: "input.complete",
      });
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
 * Blank out the given ranges with spaces, one per character, so the result
 * has the same length and the same line breaks as the input. Harper then
 * lints the English paragraphs in place and every span it reports is already
 * a document offset.
 * @param {string} text
 * @param {readonly { from: number, to: number }[]} ranges
 */
function blank(text, ranges) {
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.from) + text.slice(r.from, r.to).replace(/[^\n]/g, " ");
    at = r.to;
  }
  return out + text.slice(at);
}

/**
 * @param {{ from: number, to: number }} d
 * @param {readonly { from: number, to: number }[]} ranges
 */
function overlaps(d, ranges) {
  return ranges.some((r) => d.from < r.to && d.to > r.from);
}

// A word for the word pass (WORD, from diacritics.js, so the marks and the
// diacritics commands see the same words): letters, with inner hyphens and
// apostrophes kept so "česko-anglický" and "don't" are one token each.
// Hunspell splits at hyphens itself (the default BREAK rule).

// Inside a paragraph, the parts that are not prose: inline code, URLs, email
// addresses, link destinations and HTML tags. Harper's Markdown parser skips
// these on its own; the word pass blanks them before tokenizing. Each match
// is replaced one space per character so offsets stay put.
const NOT_PROSE = [
  /`[^`\n]*`/g,
  /https?:\/\/\S+|www\.\S+/g,
  /\S+@\S+\.\S+/g,
  /\]\([^)\n]*\)/g,
  /<[^>\n]+>/g,
];

/** @param {string} text */
function proseOnly(text) {
  for (const re of NOT_PROSE) text = text.replace(re, (m) => " ".repeat(m.length));
  return text;
}

/**
 * Words the word pass leaves alone: acronyms (all caps, "USB"), tokens glued
 * to digits ("5km" yields "km"), and anything outside the Latin script.
 * @param {string} word
 * @param {string} before  The character before the word, "" at a boundary.
 * @param {string} after   The character after it.
 */
function skipWord(word, before, after) {
  if (word.length > 1 && word === word.toUpperCase()) return true;
  if (/\d/.test(before) || /\d/.test(after)) return true;
  return !/^[\p{Script=Latin}\p{M}'’-]+$/u.test(word);
}

/**
 * The prose words of the given paragraphs, with document offsets.
 * @param {string} text
 * @param {readonly { from: number, to: number }[]} ranges
 * @returns {{ word: string, from: number, to: number }[]}
 */
function proseWords(text, ranges) {
  const out = [];
  for (const r of ranges) {
    const para = proseOnly(text.slice(r.from, r.to));
    for (const m of para.matchAll(WORD)) {
      const word = m[0];
      const start = /** @type {number} */ (m.index);
      if (skipWord(word, para[start - 1] ?? "", para[start + word.length] ?? "")) continue;
      out.push({ word, from: r.from + start, to: r.from + start + word.length });
    }
  }
  return out;
}

/**
 * The prose words of a part of a text: the paragraphs that are not code,
 * cut to [from, to). For the diacritics commands, which must see the same
 * words as the marks.
 * @param {string} text
 * @param {number} from
 * @param {number} to
 */
export function wordsIn(text, from, to) {
  const ranges = segments(text).filter((s) => !s.code);
  return proseWords(text, ranges).filter((w) => w.from >= from && w.to <= to);
}

/**
 * A replacement action: the whole range becomes the suggestion. Same
 * positional contract as toAction.
 * @param {string} text
 * @returns {import("@codemirror/lint").Action}
 */
function replaceWith(text) {
  return {
    name: text,
    apply: (view, from, to) =>
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.complete",
      }),
  };
}

// ---- English one word at a time --------------------------------------------
//
// Harper's isLikelyEnglish on a single word answers "is this an English word"
// in about 0.04 ms, without the suggestions a lint builds (measured, results
// file above). It agrees with the lint for 98 % of the words; it accepts
// British spellings, which the lint marks.

// Bounded like the Hunspell cache, for the same reason.
const ENGLISH_LIMIT = 20000;
/** @type {Map<string, boolean>} */
const englishCache = new Map();
/** @type {Map<string, string[]>} */
const englishSuggestions = new Map();

/** @type {Set<string>} words whose English answer missed the budget */
const englishPending = new Set();
let englishFilling = false;

/**
 * Whether Harper takes the word as English: true or false from the cache,
 * or null when the answer is not known yet and the budget is spent. A null
 * word is queued for fillEnglish, the same pattern as hunspell.fillIdle.
 * @param {any} harper
 * @param {string} word
 * @param {{ deadline: number }} budget
 * @returns {Promise<boolean | null>}
 */
async function englishWord(harper, word, budget) {
  const cached = englishCache.get(word);
  if (cached !== undefined) return cached;
  if (performance.now() > budget.deadline) {
    englishPending.add(word);
    return null;
  }
  return askEnglish(harper, word);
}

/**
 * Answer the queued words in idle time, a budget's worth per slice, then
 * re-run the pass once. Not a timed retry of the whole pass: a pass that
 * spends its budget before a late word reaches that word after the deadline
 * every time, so retries alone never answer it (code review, finding 1).
 * @param {any} harper
 */
function fillEnglish(harper) {
  if (englishFilling || englishPending.size === 0) return;
  englishFilling = true;
  const slice = async () => {
    const stop = hunspell.newBudget().deadline;
    for (const word of englishPending) {
      if (performance.now() > stop) break;
      englishPending.delete(word);
      await askEnglish(harper, word);
    }
    if (englishPending.size > 0) later(slice);
    else {
      englishFilling = false;
      relintAll();
    }
  };
  later(slice);
}

/** @param {() => void} fn */
function later(fn) {
  // requestIdleCallback is missing in Safari; a short timeout is close enough
  // because each slice is already capped.
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn());
  else setTimeout(fn, 50);
}

/** @param {any} harper @param {string} word */
async function askEnglish(harper, word) {
  if (englishCache.size >= ENGLISH_LIMIT) englishCache.clear();
  const ok = Boolean(await harper.isLikelyEnglish(word));
  englishCache.set(word, ok);
  return ok;
}

/**
 * Harper's suggestions for one word, from a lint of the word alone. Only for
 * words that end up red, so a pass makes few of these.
 * @param {any} harper
 * @param {string} word
 * @param {{ deadline: number }} budget
 * @returns {Promise<string[]>}
 */
async function englishFixes(harper, word, budget) {
  const cached = englishSuggestions.get(word);
  if (cached) return cached;
  if (performance.now() > budget.deadline) return [];
  if (englishSuggestions.size >= ENGLISH_LIMIT) englishSuggestions.clear();
  const list = [];
  for (const lint of await harper.lint(word)) {
    if (WARNING_KINDS.has(lint.lint_kind())) {
      for (const s of lint.suggestions()) {
        if (s.kind() !== REMOVE && list.length < MAX_ACTIONS) list.push(s.get_replacement_text());
        s.free();
      }
    }
    lint.free();
  }
  englishSuggestions.set(word, list);
  return list;
}

// ---- The marks ---------------------------------------------------------------

/**
 * The blue mark of a word without diacritics.
 * @param {number} from @param {number} to @param {string[]} twins
 * @returns {import("@codemirror/lint").Diagnostic}
 */
function plainMark(from, to, twins) {
  return {
    from,
    to,
    severity: "info",
    message: twins.length === 1 ? "Czech without diacritics." : "Czech without diacritics: more than one word fits.",
    source: PLAIN_SOURCE,
    actions: twins.slice(0, MAX_ACTIONS).map(replaceWith),
  };
}

/**
 * @param {number} from @param {number} to @param {string} word @param {string[]} fixes
 * @returns {import("@codemirror/lint").Diagnostic}
 */
function typoMark(from, to, word, fixes) {
  return {
    from,
    to,
    severity: "warning",
    message: "“" + word + "” is not a known word.",
    source: "Spelling",
    actions: fixes.map(replaceWith),
  };
}

/**
 * The lint source. Runs on the main thread; see MAX_DOC_CHARS.
 * @param {EditorView} view
 * @returns {Promise<readonly import("@codemirror/lint").Diagnostic[]>}
 */
async function spellSource(view) {
  lintedGeneration = generation;
  if (!enabled || !isProse(view) || view.state.doc.length > MAX_DOC_CHARS) return [];

  const langs = activeLangs(view.state.facet(noteSpellOff)?.());
  // A checker that failed to load counts as off: the other one then checks
  // every word (plan, "A checker that is not ready").
  if (hunspell.isBroken()) langs.cs = false;
  if (engineBroken) langs.en = false;
  if (!langs.cs && !langs.en) return [];

  // Marks only when each active checker is loaded. With one of them still
  // loading, every word the other rejects would flash red for a moment. The
  // end of each load re-runs the pass.
  let waiting = false;
  if (langs.cs && !hunspell.isReady()) {
    waiting = true;
    if (!czechRequested) {
      czechRequested = true;
      hunspell.load().then(relintAll, () => relintAll());
    }
  }
  /** @type {any} */
  const harper = langs.en ? harperOrLoad() : null;
  if (langs.en && !harper) waiting = true;
  if (waiting) return [];

  const text = view.state.doc.toString();
  const prose = segments(text).filter((s) => !s.code);
  // With English off there is no Harper at all, so every paragraph takes the
  // word pass.
  const englishParas = langs.en ? prose.filter((s) => s.lang === "en") : [];
  const wordParas = langs.en ? prose.filter((s) => s.lang !== "en") : prose;
  // The words that wait for an answer get no mark this pass. They are queued
  // for the idle fills (hunspell.fillIdle, fillEnglish), which re-run the
  // pass once when they are done.
  /** @type {{ deadline: number }} */
  let budget = hunspell.newBudget();

  const ask = {
    czech: (/** @type {string} */ w) => hunspell.isWord(w),
    twins: (/** @type {string} */ w) => hunspell.twinsOf(w, budget),
  };

  /** @type {import("@codemirror/lint").Diagnostic[]} */
  const out = [];

  if (englishParas.length > 0) {
    // No `language` option: Harper defaults to Markdown, which is what the
    // editor's own language mode assumes, and it keeps code fences out.
    const lints = await harper.lint(blank(text, wordParas));
    for (const lint of lints) {
      // toDiagnostic frees the wasm objects either way. A lint that leaks
      // into a blanked range is whitespace noise, never a finding.
      const d = toDiagnostic(lint);
      if (overlaps(d, wordParas)) continue;
      const word = text.slice(d.from, d.to);
      // A grammar hint stays as it is. So does a spelling finding on
      // something our word rule does not cover ("USB", "5km"): in an English
      // paragraph Harper is the judge of those.
      if (d.severity !== "warning" || !/^[\p{L}\p{M}'’-]+$/u.test(word)) {
        out.push(d);
        continue;
      }
      const verdict = judge(word, langs, { ...ask, english: () => false });
      if (verdict === "typo") {
        const czech = langs.cs ? hunspell.suggest(word, budget) ?? [] : [];
        const names = (d.actions ?? []).map((a) => a.name);
        // Harper's own actions first: they also carry inserts and removals.
        const extra = czech.filter((c) => !names.includes(c)).map(replaceWith);
        out.push({ ...d, actions: [...(d.actions ?? []), ...extra].slice(0, MAX_ACTIONS) });
      } else if (verdict !== "ok" && verdict !== "pending") out.push(plainMark(d.from, d.to, verdict.plain));
    }
  }

  if (wordParas.length > 0) {
    // A budget of its own: the Harper lint above can take longer than one
    // budget, and the word pass would then start with none left.
    budget = hunspell.newBudget();
    /** @type {Map<string, boolean | null>} */
    const english = new Map();
    for (const { word, from, to } of proseWords(text, wordParas)) {
      if (langs.en && !english.has(word) && !(langs.cs && hunspell.isWord(word))) {
        english.set(word, await englishWord(harper, word, budget));
      }
      const verdict = judge(word, langs, { ...ask, english: (w) => english.get(w) ?? null });
      if (verdict === "ok" || verdict === "pending") continue;
      if (verdict === "typo") {
        const czech = langs.cs ? hunspell.suggest(word, budget) ?? [] : [];
        const eng = langs.en ? await englishFixes(harper, word, budget) : [];
        out.push(typoMark(from, to, word, mergeSuggestions(czech, eng)));
      } else out.push(plainMark(from, to, verdict.plain));
    }
  }

  hunspell.fillIdle(relintAll);
  if (harper) fillEnglish(harper);
  return out;
}

/**
 * The engines for a command the user started: both loaded, or null for one
 * that failed. Unlike a lint pass, a command may wait for a load.
 * @returns {Promise<{ harper: any, czech: boolean }>}
 */
export async function enginesForCommand() {
  const [harper, czech] = await Promise.all([
    loadHarper(),
    hunspell.load().then(
      () => true,
      () => false
    ),
  ]);
  return { harper, czech };
}

/**
 * Whether Harper takes a word as English, for a command: no budget.
 * @param {any} harper @param {string} word
 */
export function englishNow(harper, word) {
  const cached = englishCache.get(word);
  return cached !== undefined ? Promise.resolve(cached) : askEnglish(harper, word);
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

  // The phone box: one row of fixes, each a 44 px touch target.
  ".cm-tooltip.cm-spell-box": {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    padding: "6px",
    borderLeft: "3px solid " + HINT,
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
  },
  ".cm-spell-box-message": { flexBasis: "100%", fontSize: "0.9em", opacity: "0.8" },
  ".cm-spell-box button": {
    minHeight: "44px",
    padding: "0 14px",
    font: "inherit",
    backgroundColor: "#22262A",
    color: PANEL_FG,
    border: "1px solid " + BORDER,
    borderRadius: "4px",
  },
});

/**
 * Visual Studio's Ctrl+. (user request, 2026-10-17): the suggestions for the
 * word under the caret as a menu (ui/menu.js), so a misspelling is fixed
 * without the mouse. Arrows pick, Enter applies, Escape goes back to the
 * text. The hover tooltip stays for the pointer. With no diagnostic under
 * the caret the key is left alone.
 * @type {import("@codemirror/view").Command}
 */
function fixAtCursor(view) {
  const head = view.state.selection.main.head;
  /** @type {{d: import("@codemirror/lint").Diagnostic, from: number, to: number}[]} */
  const hits = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    // The caret at either edge of the word counts: that is where it stands
    // right after the word was typed.
    if (from <= head && head <= to) hits.push({ d, from, to });
  });
  const hit = hits[0];
  if (!hit) return false;
  const { d, from, to } = hit;
  // from/to are the diagnostic's current positions, as the lint package
  // maps them (see toAction). A menu without a fix still has one item, so
  // Enter or Escape dismisses it like any other.
  const items = d.actions?.length
    ? d.actions.map((action) => ({ label: action.name, act: () => action.apply(view, from, to) }))
    : [{ label: "No suggestions" }];
  const at = view.coordsAtPos(from);
  if (!at) return false;
  // The editor's content is the anchor: that is where the focus returns.
  openMenu(view.contentDOM, items, { at });
  return true;
}

// ---- The phone box -----------------------------------------------------------
//
// A phone has no hover and no Ctrl+. (fixAtCursor), so a tap on a marked word
// shows its fixes in a box below the word. It is a CodeMirror tooltip and not
// a ui/menu.js menu on purpose: the menu takes the focus, and on a phone the
// keyboard then closes. The box opens on the tap only, not whenever the
// cursor sits in a marked word: that rule would open it under every
// unfinished word, 600 ms after each pause in typing (plan, "The phone").

/** @typedef {{ from: number, to: number, message: string, actions: readonly import("@codemirror/lint").Action[] }} Box */

/** @type {import("@codemirror/state").StateEffectType<Box | null>} */
const setBox = StateEffect.define();

const boxField = StateField.define({
  create: () => /** @type {Box | null} */ (null),
  update(box, tr) {
    for (const effect of tr.effects) if (effect.is(setBox)) return effect.value;
    if (!box) return null;
    // The next key press closes it: a typed character, or a cursor that left
    // the word. The fixes belong to the word as it was tapped.
    if (tr.docChanged) return null;
    const head = tr.state.selection.main.head;
    return head < box.from || head > box.to ? null : box;
  },
  provide: (field) =>
    showTooltip.from(field, (box) =>
      box
        ? {
            pos: box.from,
            above: false,
            create: (view) => ({ dom: boxDom(view, box) }),
          }
        : null
    ),
});

/** @param {EditorView} view @param {Box} box */
function boxDom(view, box) {
  const dom = document.createElement("div");
  dom.className = "cm-spell-box";
  // The message tells a typo from Czech without diacritics; on a phone the
  // color of a dotted line is the only other sign.
  const message = document.createElement("div");
  message.className = "cm-spell-box-message";
  message.textContent = box.actions.length ? box.message : box.message + " No suggestions.";
  dom.appendChild(message);
  for (const action of box.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.name;
    // No focus change: the editor keeps it, so the phone keyboard stays up.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      view.dispatch({ effects: setBox.of(null) });
      action.apply(view, box.from, box.to);
    });
    dom.appendChild(button);
  }
  return dom;
}

const phoneBox = [
  boxField,
  EditorView.domEventHandlers({
    click(event, view) {
      // Phone mode only: a PC keeps hover and Ctrl+. (ui/shell.js sets the
      // class; read here so a mode change needs no reconfiguration).
      if (!document.documentElement.classList.contains("phone")) return false;
      // The place of the tap, not the selection: on a touch screen the
      // selection follows the tap later, through the DOM selection, so at
      // this moment it can still be where it was before.
      const head = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (head === null) return false;
      /** @type {Box | null} */
      let found = null;
      forEachDiagnostic(view.state, (d, from, to) => {
        // Every mark, also one without fixes: the box then says so, as
        // Ctrl+. does on a PC, and a tap never looks broken.
        if (!found && from <= head && head <= to) {
          found = { from, to, message: d.message, actions: d.actions ?? [] };
        }
      });
      view.dispatch({ effects: setBox.of(found) });
      return false;
    },
  }),
  // Place the box again when the visible part of the page changes while it
  // is open: the keyboard opens, or the browser pans to the cursor after the
  // tap. CodeMirror places a tooltip again on a window resize only, and the
  // keyboard changes only the visual viewport, so without this the box stayed
  // under the word, behind the keyboard (phone test, 2026-11-20). A new box
  // object is a new tooltip, which CodeMirror measures and places from scratch.
  ViewPlugin.define((view) => {
    const vv = window.visualViewport;
    let pending = 0;
    const replace = () => {
      if (pending) return;
      // One placement per frame: the viewport sends many events while the
      // keyboard slides in.
      pending = requestAnimationFrame(() => {
        pending = 0;
        const box = view.state.field(boxField, false);
        if (box) view.dispatch({ effects: setBox.of({ ...box }) });
      });
    };
    vv?.addEventListener("resize", replace);
    vv?.addEventListener("scroll", replace);
    return {
      destroy() {
        cancelAnimationFrame(pending);
        vv?.removeEventListener("resize", replace);
        vv?.removeEventListener("scroll", replace);
      },
    };
  }),
  // The free space for every tooltip is the visible part of the page. The
  // default is the window, and on iOS and current Android the keyboard
  // shrinks only the visual viewport: a box under a word near the bottom
  // would open behind the keyboard.
  tooltips({
    tooltipSpace: (view) => {
      const root = view.dom.ownerDocument.documentElement.getBoundingClientRect();
      const vv = window.visualViewport;
      if (!vv) return root;
      // The visible part in the frame of getBoundingClientRect, which
      // CodeMirror uses for the word. vv.offsetTop is right only where client
      // coordinates start at the layout viewport; CodeMirror's own windowRect
      // assumes they start at the visible top. Where they do, offsetTop moved
      // the space down by the pan to a line near the keyboard, and the box
      // opened below the word, behind the keyboard (phone test, 2026-11-20).
      // pageTop is a page coordinate, and root.top is page y 0 in client
      // coordinates, so their sum is right in both frames.
      const top = vv.pageTop + root.top;
      const left = vv.pageLeft + root.left;
      return { top, left, bottom: top + vv.height, right: left + vv.width };
    },
  }),
];

/**
 * The spellcheck extension. No lint gutter on purpose: underlines and hover
 * tooltips only, so the gutter keeps showing line numbers alone.
 * @returns {import("@codemirror/state").Extension}
 */
export function spellcheck() {
  return [
    keymap.of([{ key: "Mod-.", run: fixAtCursor }]),
    linter(spellSource, {
      delay: LINT_DELAY,
      // The second test catches a mode switch. A compartment reconfigure
      // changes no text, so without it the underlines from the old mode would
      // stay on screen until the user typed again.
      needsRefresh: (update) =>
        generation !== lintedGeneration ||
        update.startState.facet(language) !== update.state.facet(language),
    }),
    trackViews,
    phoneBox,
    spellcheckTheme,
  ];
}
