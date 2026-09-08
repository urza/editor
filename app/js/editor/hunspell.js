// @ts-check
// Czech spellcheck engine (architecture.md §11): Hunspell as a vendored
// WebAssembly module plus the Czech dictionary from `dictionary-cs`. This
// module knows words, not documents: it answers "is this a word" and "what
// did the user mean", and spellcheck.js turns the answers into diagnostics.
//
// Everything runs on the main thread, like Harper. Measured in Node: the
// dictionary loads in about 120 ms, a spelling test costs microseconds, and
// a suggestion costs 5 to 55 ms. The suggestion cost is the one that matters,
// so suggestions are cached per word and computed under a time budget.

// Resolved against this module, not the page: these are plain fetches made
// here, so `import.meta.url` is the stable anchor. The wasm binary itself
// needs no URL: the vendored glue finds `hunspell.wasm` next to itself.
const AFF_URL = new URL("../../vendor/dictionary-cs/index.aff", import.meta.url);
const DIC_URL = new URL("../../vendor/dictionary-cs/index.dic", import.meta.url);

// One lint pass may meet hundreds of unknown words (a fresh paste), and 55 ms
// each would freeze the editor for seconds. Past this budget the remaining
// words get their underline now and their suggestions on the next pass,
// which the caller schedules through `onIdle`.
const SUGGEST_BUDGET_MS = 60;

// Hunspell returns up to fifteen candidates; the tooltip shows a row of
// buttons, the same cap Harper's suggestions get.
const MAX_SUGGESTIONS = 5;

// Bounded so a long session over many documents cannot grow it forever. A
// wipe costs a few recomputed suggestions, nothing visible.
const CACHE_LIMIT = 4000;

/** @type {Promise<void> | null} */
let loading = null;
/** @type {any} */
let engine = null;
let engineBroken = false;

/** @type {Map<string, string[]>} */
const suggestionCache = new Map();

/**
 * The words that missed the suggestion budget in the last `suggest` calls.
 * `fillIdle` works through them off the lint pass.
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
  return engine.testSpelling(word);
}

/**
 * Suggestions for a misspelled word, from the cache when present. Returns
 * null when the word is not cached and the budget for this pass is spent;
 * the word is then queued for `fillIdle`.
 * @param {string} word
 * @param {{ deadline: number }} budget  `performance.now()` value to stop at.
 * @returns {string[] | null}
 */
export function suggest(word, budget) {
  const cached = suggestionCache.get(word);
  if (cached) return cached;
  if (performance.now() > budget.deadline) {
    pending.add(word);
    return null;
  }
  return compute(word);
}

/** @param {string} word */
function compute(word) {
  if (suggestionCache.size >= CACHE_LIMIT) suggestionCache.clear();
  const list = engine.getSpellingSuggestions(word).slice(0, MAX_SUGGESTIONS);
  suggestionCache.set(word, list);
  pending.delete(word);
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
    for (const word of pending) {
      if (performance.now() > stop) break;
      compute(word);
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
