// @ts-check
// Czech spellcheck engine (architecture.md §11): Hunspell as a vendored
// WebAssembly module plus the Czech dictionary from `dictionary-cs`. This
// module knows words, not documents: it answers "is this a word" and "what
// did the user mean", and spellcheck.js turns the answers into diagnostics.
//
// Everything runs on the main thread, like Harper. Measured in Node: the
// dictionary loads in about 120 ms, a spelling test costs microseconds, and
// a suggestion costs 5 to 55 ms. The suggestion cost is the one that matters,
// so suggestions are cached per word and computed under a time budget. The
// twin search (Czech without diacritics) is the same kind of cost.

import { twins } from "./diacritics.js";

// Resolved against this module, not the page: these are plain fetches made
// here, so `import.meta.url` is the stable anchor. The wasm binary itself
// needs no URL: the vendored glue finds `hunspell.wasm` next to itself.
const AFF_URL = new URL("../../vendor/dictionary-cs/index.aff", import.meta.url);
// Keep the .txt suffix: GitHub Pages serves .dic as text/x-c without gzip
// (3.65 MB uncompressed), while .txt serves as text/plain (~0.85 MB gzipped).
const DIC_URL = new URL("../../vendor/dictionary-cs/index.dic.txt", import.meta.url);

// One lint pass may meet hundreds of unknown words (a fresh paste), and 55 ms
// each would freeze the editor for seconds. Past this budget the remaining
// words get their underline now and their suggestions on the next pass,
// which the caller schedules through `onIdle`.
const SUGGEST_BUDGET_MS = 60;

// Hunspell returns up to fifteen candidates; the tooltip shows a row of
// buttons, the same cap Harper's suggestions get.
const MAX_SUGGESTIONS = 5;

// Bounded so a long session over many documents cannot grow it forever. A
// wipe costs a few recomputed answers, nothing visible. The twins share the
// cache, and a note at the spellcheck limit (100,000 characters) without
// diacritics has about 4,000 distinct words that need them
// (.work/mixed-spellcheck/experiment/results.md), so the limit sits well
// above that: a lower one would empty the cache on every pass of such a note
// and redo seconds of search after each pause in typing.
const CACHE_LIMIT = 20000;

/** @type {Promise<void> | null} */
let loading = null;
/** @type {any} */
let engine = null;
let engineBroken = false;

// One cache for two answers about a word: its suggestions ("s" + word) and
// its twins ("t" + word, see diacritics.js). Both cost milliseconds, both are
// asked on every lint pass, and both use the budget and the idle fill below.
/** @type {Map<string, string[]>} */
const cache = new Map();

/**
 * The keys that missed the budget in the last calls. `fillIdle` works
 * through them off the lint pass.
 * @type {Set<string>}
 */
const pending = new Set();
let idleScheduled = false;

/** @returns {boolean} */
export function isReady() {
  return engine !== null;
}

/**
 * Load the engine and the dictionary once, in the background. Resolves when
 * the engine is usable; rejects once and then never retries, because a retry
 * on every lint pass would re-fetch four megabytes per keystroke.
 * @returns {Promise<void>}
 */
export function load() {
  if (!loading) {
    loading = (async () => {
      // Bare specifier, resolved by the import map like harper.js.
      const mod = await import("hunspell-wasm");
      const [aff, dic] = await Promise.all([
        fetch(AFF_URL).then(text),
        fetch(DIC_URL).then(text),
      ]);
      engine = await mod.createHunspellFromStrings(aff, dic);
    })().catch((err) => {
      engineBroken = true;
      console.error("[vrtti] Hunspell (Czech) failed to load", err);
      throw err;
    });
  }
  return loading;
}

/** @param {Response} res */
function text(res) {
  if (!res.ok) throw new Error(res.status + " " + res.url);
  return res.text();
}

/** @returns {boolean} */
export function isBroken() {
  return engineBroken;
}

/**
 * True when the word is in the dictionary (case rules included: "Praha" is
 * a word, "praha" is not, "Slovo" is, because Hunspell accepts a capitalized
 * lowercase entry at a sentence start).
 * @param {string} word
 * @returns {boolean}
 */
export function isWord(word) {
  // Cached: every pass asks each word of the note again, and on a long note
  // the uncached tests alone cost 0.2 to 1 s per pass (code review, finding 2).
  let known = words.get(word);
  if (known === undefined) {
    if (words.size >= CACHE_LIMIT) words.clear();
    known = Boolean(engine.testSpelling(word));
    words.set(word, known);
  }
  return known;
}

/** @type {Map<string, boolean>} */
const words = new Map();

/**
 * Suggestions for a misspelled word, from the cache when present. Returns
 * null when the word is not cached and the budget for this pass is spent;
 * the word is then queued for `fillIdle`.
 * @param {string} word
 * @param {{ deadline: number }} budget  `performance.now()` value to stop at.
 * @returns {string[] | null}
 */
export function suggest(word, budget) {
  return answer("s" + word, budget);
}

/**
 * The twins of a word (diacritics.js), from the cache when present. Same
 * contract as `suggest`: null means "not known yet, queued for fillIdle". An
 * empty list means none, or a word too long to search.
 * @param {string} word
 * @param {{ deadline: number }} budget
 * @returns {string[] | null}
 */
export function twinsOf(word, budget) {
  return answer("t" + word, budget);
}

/**
 * The twins now, without a budget: for a command the user started, which
 * may take its time.
 * @param {string} word
 * @returns {string[]}
 */
export function twinsNow(word) {
  if (!engine) return [];
  return cache.get("t" + word) ?? compute("t" + word);
}

/** @param {string} key @param {{ deadline: number }} budget */
function answer(key, budget) {
  const cached = cache.get(key);
  if (cached) return cached;
  if (performance.now() > budget.deadline) {
    pending.add(key);
    return null;
  }
  return compute(key);
}

/** @param {string} key */
function compute(key) {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const word = key.slice(1);
  const list =
    key[0] === "s"
      ? engine.getSpellingSuggestions(word).slice(0, MAX_SUGGESTIONS)
      : twins(word, (w) => engine.testSpelling(w)) ?? [];
  cache.set(key, list);
  // No `pending.delete(key)` here, on purpose. A part of a pass that ran out
  // of budget queues the word and shows no mark for it; a later part of the
  // same pass can have budget for the same word and lands here. If that took
  // the word out of the queue, fillIdle would find nothing to do and would
  // never call back, and the first mark would stay away until the next edit.
  // Only fillIdle empties the queue.
  return list;
}

/** A fresh budget for one lint pass. */
export function newBudget() {
  return { deadline: performance.now() + SUGGEST_BUDGET_MS };
}

/**
 * Compute the suggestions that missed the budget, in idle time, a budget's
 * worth per slice, then call back so the caller can repaint. Idempotent: one
 * idle chain runs at a time, and it stops when nothing is pending.
 * @param {() => void} done  Called once after every pending word is cached.
 */
export function fillIdle(done) {
  if (idleScheduled || pending.size === 0) return;
  idleScheduled = true;
  const slice = () => {
    const stop = performance.now() + SUGGEST_BUDGET_MS;
    for (const key of pending) {
      if (performance.now() > stop) break;
      // Often cached by now (see compute); the caller's repaint is still owed.
      if (!cache.has(key)) compute(key);
      pending.delete(key);
    }
    if (pending.size > 0) {
      later(slice);
    } else {
      idleScheduled = false;
      done();
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
