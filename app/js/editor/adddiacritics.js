// @ts-check
// "Add diacritics (local)" and "Add diacritics (vllm)"
// (.work/mixed-spellcheck/plan.md). Both work on the selection, or on the
// whole note when nothing is selected, and each ends in one undo step.
//
// The local command changes a word only when it would carry a blue mark
// (spellcheck.js) and has exactly one twin. The model command does the same,
// then asks the user's model, through the sync server, for the paragraphs
// that had a blue word, and keeps only the changes that pass checkAnswer.

import { checkAnswer } from "./diacritics.js";
import { englishNow, enginesForCommand, wordsIn } from "./spellcheck.js";
import * as hunspell from "./hunspell.js";
import { segments } from "./textlang.js";

// vLLM batches requests that arrive together on the GPU, so many paragraphs at
// once cost about as long as the slowest one. The cap only keeps a long note
// from opening hundreds of connections.
const PARALLEL = 16;

// "Let the model fix English-looking words in Czech paragraphs", a setting
// of this device (Settings > Editor). Harper takes some frequent Czech words
// without diacritics as English ("az", "tim", "mit", "ci"), so without this
// the model could never write "až", "tím", "mít", "či". It stays a switch
// because it is a risk: in a Czech paragraph the model can then also change
// a real English word such as "mate" (user decision, 2026-11-20). On by
// default, as the user chose.
const TRUST_KEY = "vrtti.diacritics.czechParagraphs";

/** @returns {boolean} */
export function modelFixesCzechParagraphs() {
  try {
    return localStorage.getItem(TRUST_KEY) !== "off";
  } catch {
    return true;
  }
}

/** @param {boolean} on */
export function setModelFixesCzechParagraphs(on) {
  try {
    localStorage.setItem(TRUST_KEY, on ? "on" : "off");
  } catch {
    // Private mode with storage denied: the default stays.
  }
}

/**
 * @typedef {{ ask: (text: string) => Promise<string> }} Model
 * @typedef {(text: string, sticky?: boolean) => void} Notice
 */

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {{ model: Model | null, notice: Notice, wholeNote?: boolean,
 *           stillHere: () => boolean }} opts
 *   `stillHere` tells whether the same note is still on screen when the model
 *   answers; the view itself can not, because a note switch keeps the view.
 */
export async function addDiacritics(view, { model, notice, wholeNote = false, stillHere }) {
  const start = view.state;
  const text = start.doc.toString();
  const sel = start.selection.main;
  const [from, to] = wholeNote || sel.empty ? [0, text.length] : [sel.from, sel.to];

  if (model) notice("asking the model…", true);
  const { harper, czech } = await enginesForCommand();
  if (!czech) {
    notice("the Czech dictionary did not load");
    return;
  }

  // Positions of word changes in the original text. Each change keeps the
  // length (a diacritic letter is one unit like its base letter), so no
  // position ever shifts and the local and model changes can be merged.
  /** @type {Map<number, string>} */
  const local = new Map();
  let ambiguous = 0;
  /** @type {Set<number>} start offsets of words that would carry a blue mark */
  const plain = new Set();
  /** @type {Set<string>} words Harper takes as English and Czech does not */
  const englishOnly = new Set();
  /** @type {Set<number>} start offsets of those words */
  const englishAt = new Set();
  const trustCzech = modelFixesCzechParagraphs();
  // The start of every prose word in the range. The model may change only
  // these: a paragraph also holds links and inline code, and a model that
  // writes "články" into a URL would break the link (code review, finding 1).
  const prose = wordsIn(text, from, to);
  const starts = new Set(prose.map((w) => w.from));

  let n = 0;
  for (const { word, from: at } of prose) {
    // A long note: let the page paint the notice now and then, since the
    // twin search for a word that the marks never saw has no budget here.
    if (++n % 200 === 0) await new Promise((resolve) => setTimeout(resolve));
    if (hunspell.isWord(word)) continue;
    if (harper && (await englishNow(harper, word))) {
      englishOnly.add(word);
      englishAt.add(at);
      continue;
    }
    const twins = hunspell.twinsNow(word);
    if (twins.length === 0) continue;
    plain.add(at);
    if (twins.length === 1) local.set(at, twins[0]);
    else ambiguous++;
  }

  if (!model) {
    if (apply(view, start, text, local)) notice(summary(local.size, ambiguous));
    else notice("the note changed, run the command again");
    return;
  }

  // The paragraphs with a blue word, as they read after the local step. With
  // the setting on, also a Czech paragraph whose only candidates are words
  // Harper takes as English ("az", "tim"): no blue mark, but the model may
  // still fix them there.
  const after = withChanges(text, local);
  /** @param {{from: number, to: number}} p @param {Set<number>} set */
  const holds = (p, set) => [...set].some((at) => at >= p.from && at < p.to);
  const czechTrusted = (/** @type {{lang: string}} */ p) => trustCzech && p.lang === "cs";
  const paras = segments(text).filter(
    (p) => !p.code && (holds(p, plain) || (czechTrusted(p) && holds(p, englishAt)))
  );
  let done = 0;
  let failed = 0;
  let dropped = 0;
  /** @type {Map<number, string>} */
  const final = new Map(local);
  // The note must not change while the model works, or the answer is thrown
  // away (see below), so the notice says so.
  const progress = () => notice(`asking the model… ${done} of ${paras.length}, please wait`, true);
  progress();

  await pool(paras, PARALLEL, async (p) => {
    const sent = after.slice(p.from, p.to);
    try {
      const checked = checkAnswer(sent, await model.ask(sent), (w) => hunspell.isWord(w));
      if (!checked) dropped++;
      else {
        for (const w of prose) {
          if (w.from < p.from || w.to > p.to) continue;
          const next = checked.text.slice(w.from - p.from, w.to - p.from);
          // Only prose words in the selection, and no English word: the
          // instruction says so, and this is where a model that ignores it
          // is stopped ("mate" must not become "máte"). In a Czech paragraph
          // the setting above can let the model through.
          if (next === w.word || !starts.has(w.from)) continue;
          if (englishOnly.has(w.word) && !czechTrusted(p)) continue;
          // Outside a Czech paragraph, only a word with a blue mark: a word
          // that is valid in both languages ("mate", Czech "you confuse")
          // passes the English guard, and in "The mate opens the list" the
          // model wrote "máte" (found in the end-to-end check, 2026-11-20).
          if (p.lang !== "cs" && !plain.has(w.from)) continue;
          final.set(w.from, next);
        }
      }
    } catch {
      failed++;
    }
    done++;
    progress();
  });

  if (!stillHere() || view.state.doc !== start.doc) {
    notice("the note changed, run the command again");
    return;
  }
  if (paras.length > 0 && failed === paras.length) {
    apply(view, start, text, local);
    notice("the model did not answer; " + summary(local.size, ambiguous));
    return;
  }
  apply(view, start, text, final);
  const changed = [...final].filter(([at, w]) => text.slice(at, at + w.length) !== w).length;
  let message = `${changed} ${changed === 1 ? "word" : "words"} changed`;
  const kept = dropped + failed;
  if (kept > 0) message += `, the model gave no usable answer for ${kept} ${kept === 1 ? "paragraph" : "paragraphs"}`;
  notice(message);
}

/**
 * Apply word changes as one transaction, if the text is still the one the
 * changes were made for. One dispatch is one undo step.
 * @param {import("@codemirror/view").EditorView} view
 * @param {import("@codemirror/state").EditorState} start
 * @param {string} text
 * @param {Map<number, string>} changes
 */
function apply(view, start, text, changes) {
  if (view.state.doc !== start.doc) return false;
  const list = [...changes]
    .filter(([at, w]) => text.slice(at, at + w.length) !== w)
    .sort((a, b) => a[0] - b[0])
    .map(([at, w]) => ({ from: at, to: at + w.length, insert: w }));
  if (list.length > 0) view.dispatch({ changes: list, userEvent: "input.diacritics" });
  return true;
}

/** @param {string} text @param {Map<number, string>} changes */
function withChanges(text, changes) {
  const chars = text.split("");
  for (const [at, w] of changes) for (let i = 0; i < w.length; i++) chars[at + i] = w[i];
  return chars.join("");
}

/** @param {number} changed @param {number} ambiguous */
function summary(changed, ambiguous) {
  let s = `${changed} ${changed === 1 ? "word" : "words"} changed`;
  if (ambiguous > 0) {
    s += `, ${ambiguous} ${ambiguous === 1 ? "word needs" : "words need"} your choice (blue mark)`;
  }
  return s;
}

/**
 * Run `work` on each item, at most `limit` at a time.
 * @template T
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<void>} work
 */
async function pool(items, limit, work) {
  let next = 0;
  const runner = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}
