// @ts-check
// "Add diacritics (local)" and "Add diacritics (vllm)"
// (.work/mixed-spellcheck/plan.md). Both work on the selection, or on the
// whole note when nothing is selected, and each ends in one undo step.
//
// The local command changes a word only when it would carry a blue mark
// (spellcheck.js) and has exactly one twin. The model command does the same,
// then asks the user's model, through the sync server, for the paragraphs
// that had a blue word, and keeps only the changes that pass checkAnswer.

import { checkAnswer, WORD } from "./diacritics.js";
import { englishNow, enginesForCommand, wordsIn } from "./spellcheck.js";
import * as hunspell from "./hunspell.js";
import { segments } from "./textlang.js";

// vLLM batches requests that arrive together on the GPU, so many paragraphs at
// once cost about as long as the slowest one. The cap only keeps a long note
// from opening hundreds of connections.
const PARALLEL = 16;

/**
 * @typedef {{ ask: (text: string) => Promise<string> }} Model
 * @typedef {(text: string | null, sticky?: boolean) => void} Notice
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

  for (const { word, from: at } of wordsIn(text, from, to)) {
    if (hunspell.isWord(word)) continue;
    if (harper && (await englishNow(harper, word))) {
      englishOnly.add(word);
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

  // The paragraphs with a blue word, as they read after the local step.
  const after = withChanges(text, local);
  const paras = segments(text).filter(
    (p) => !p.code && [...plain].some((at) => at >= p.from && at < p.to)
  );
  let done = 0;
  let failed = 0;
  let dropped = 0;
  /** @type {Map<number, string>} */
  const final = new Map(local);
  notice(`asking the model… 0 of ${paras.length}`, true);

  await pool(paras, PARALLEL, async (p) => {
    const sent = after.slice(p.from, p.to);
    try {
      const checked = checkAnswer(sent, await model.ask(sent), (w) => hunspell.isWord(w));
      if (!checked) dropped++;
      else {
        for (const m of sent.matchAll(WORD)) {
          const at = p.from + /** @type {number} */ (m.index);
          const next = checked.text.slice(m.index, m.index + m[0].length);
          // Only inside the selection, and never an English word: the
          // instruction says so, and this is where a model that ignores it
          // is stopped ("mate" must not become "máte").
          if (next === m[0] || at < from || at + next.length > to) continue;
          if (englishOnly.has(text.slice(at, at + next.length))) continue;
          final.set(at, next);
        }
      }
    } catch {
      failed++;
    }
    done++;
    notice(`asking the model… ${done} of ${paras.length}`, true);
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
  if (dropped + failed > 0) message += `, ${dropped + failed} ${dropped + failed === 1 ? "paragraph" : "paragraphs"} dropped`;
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
    s += `, ${ambiguous} ${ambiguous === 1 ? "word has" : "words have"} more than one twin`;
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
