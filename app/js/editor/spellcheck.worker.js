// @ts-check
// Dedicated Web Worker for offline English (Harper WASM) and Czech (Hunspell
// WASM) spellcheck and local diacritics analysis (architecture.md §11, C5).
//
// Why a custom module worker instead of Harper's built-in WorkerLinter:
//  1. WorkerLinter instantiates `Serializer(binary)` on the main thread, which
//     calls `binary.setup()` and still compiles the 15.6 MB WASM on the UI
//     thread, and spawns a `blob:` worker that breaks relative asset URLs.
//  2. Hosting both Harper and Hunspell in one same-origin worker keeps WASM
//     compilation, 4.3 MB `.dic` parsing, paragraph linting, and Czech twin
//     searches completely off the main thread while sharing one copy of each
//     engine.
//
// Relative imports only: dedicated module workers ignore `<script type="importmap">`
// in `index.html`.

import * as harperMod from "../../vendor/harper/index.js";
import { createHunspellFromStrings } from "../../vendor/hunspell/dist/Hunspell.js";
import { WORD, twins } from "./diacritics.js";
import { judge, mergeSuggestions } from "./mixed.js";
import { segments } from "./textlang.js";
import { buildCatalog } from "./spellrules.js";
import { wordKey } from "../model/spellsettings.js";

const HARPER_WASM_URL = new URL(
  "../../vendor/harper/harper_wasm_slim_bg.wasm",
  import.meta.url
).href;
const AFF_URL = new URL("../../vendor/dictionary-cs/index.aff", import.meta.url).href;
// Keep the .txt suffix: GitHub Pages serves .dic as text/x-c without gzip
// (3.65 MB uncompressed), while .txt serves as text/plain (~0.85 MB gzipped).
const DIC_URL = new URL("../../vendor/dictionary-cs/index.dic.txt", import.meta.url).href;

const MAX_ACTIONS = 5;
const SUGGEST_BUDGET_MS = 60;
const WORD_CACHE_LIMIT = 20000;
const PARA_CACHE_LIMIT = 2000;
const REMOVE = 1;
const WARNING_KINDS = new Set(["Spelling", "Typo"]);
const PLAIN_SOURCE = "Czech without diacritics";

const NOT_PROSE = [
  /`[^`\n]*`/g,
  /https?:\/\/\S+|www\.\S+/g,
  /\S+@\S+\.\S+/g,
  /\]\([^)\n]*\)/g,
  /<[^>\n]+>/g,
];

/** @type {Promise<any> | null} */
let harperLoading = null;
/** @type {any} */
let harperEngine = null;
let harperBroken = false;

/** @type {Promise<any> | null} */
let hunspellLoading = null;
/** @type {any} */
let hunspellEngine = null;
let hunspellBroken = false;

/** @type {Map<string, boolean>} */
const czechWords = new Map();
/** @type {Map<string, string[]>} */
const czechCache = new Map();
/** @type {Set<string>} */
const czechPending = new Set();

/** @type {Map<string, boolean>} */
const englishCache = new Map();
/** @type {Map<string, string[]>} */
const englishSuggestions = new Map();
/** @type {Set<string>} */
const englishPending = new Set();
/** @type {Set<string>} */
const englishFixPending = new Set();

/**
 * Cached diagnostics per paragraph (`langMask + "\0" + paraText`), storing
 * paragraph-relative `[relFrom, relTo]` spans so editing one paragraph in a
 * multi-hundred-KB note re-lints only the edited paragraph.
 * @type {Map<string, SerializedDiag[]>}
 */
const paraCache = new Map();

let idleScheduled = false;
let latestLintReqId = 0;

/**
 * The spellcheck settings that all devices share, as the main thread sent
 * them (op "config"; editor/spellcheck.js, sendWorkerConfig). `rules` is the
 * complete map of the Harper rules the user changed: setLintConfig replaces
 * Harper's whole map on each call, and a missing rule runs at its default.
 * `words` holds the keys of "My words" (wordKey). `plain` is the device
 * switch "Mark Czech without diacritics"; it travels here with the shared
 * settings because the word rule (mixed.js, judge) runs in this worker.
 * @type {{ rules: Record<string, boolean>, words: Set<string>, plain: boolean }}
 */
let config = { rules: {}, words: new Set(), plain: true };

/**
 * Whether the user's own list has this word, in any capitalization.
 * @param {string} word
 */
function isMine(word) {
  return config.words.size > 0 && config.words.has(wordKey(word));
}

/**
 * @typedef {{ kind: number, text: string, name: string }} SerializedAction
 * @typedef {{ from: number, to: number, severity: "warning" | "info", message: string, source: string, actions: SerializedAction[], rule?: string }} SerializedDiag
 *   `rule` is the Harper rule that made the mark ("LongSentences"), for the
 *   button "Turn off" of the main thread. The app's own marks have none.
 */

/** @param {Response} res */
function readText(res) {
  if (!res.ok) throw new Error(res.status + " " + res.url);
  return res.text();
}

function loadHarper() {
  if (!harperLoading) {
    harperLoading = (async () => {
      const binary = harperMod.createBinaryModuleFromUrl(HARPER_WASM_URL, "slim");
      const local = new harperMod.LocalLinter({ binary });
      await local.setup();
      // Before the first pass: a rule the user turned off must not flash its
      // marks once at each start.
      await local.setLintConfig(config.rules);
      harperEngine = local;
      return local;
    })().catch((err) => {
      harperBroken = true;
      console.error("[vrtti] Harper worker failed to load", err);
      return null;
    });
  }
  return harperLoading;
}

function loadHunspell() {
  if (!hunspellLoading) {
    hunspellLoading = (async () => {
      const [aff, dic] = await Promise.all([
        fetch(AFF_URL).then(readText),
        fetch(DIC_URL).then(readText),
      ]);
      hunspellEngine = await createHunspellFromStrings(aff, dic);
      return hunspellEngine;
    })().catch((err) => {
      hunspellBroken = true;
      console.error("[vrtti] Hunspell worker failed to load", err);
      return null;
    });
  }
  return hunspellLoading;
}

/** @param {string} word */
function isCzechWord(word) {
  let known = czechWords.get(word);
  if (known === undefined) {
    if (czechWords.size >= WORD_CACHE_LIMIT) czechWords.clear();
    known = Boolean(hunspellEngine.testSpelling(word));
    czechWords.set(word, known);
  }
  return known;
}

/** @param {string} key */
function computeCzech(key) {
  if (czechCache.size >= WORD_CACHE_LIMIT) czechCache.clear();
  const word = key.slice(1);
  const list =
    key[0] === "s"
      ? hunspellEngine.getSpellingSuggestions(word).slice(0, MAX_ACTIONS)
      : twins(word, (w) => hunspellEngine.testSpelling(w)) ?? [];
  czechCache.set(key, list);
  // No `czechPending.delete(key)` here, on purpose. A paragraph that ran out
  // of budget queues the word and shows no mark for it. A later paragraph of
  // the same pass can have budget for the same word and lands here. If that
  // took the word out of the queue, the idle fill would find nothing to do,
  // would announce no new pass, and the first paragraph would stay without
  // its mark until the next edit. Only the idle fill empties the queue
  // (scheduleIdleFill), so a word that was put off always leads to a new pass.
  return list;
}

/**
 * @param {string} key
 * @param {{ deadline: number }} budget
 * @param {{ incomplete: boolean }} [deferred]
 */
function answerCzech(key, budget, deferred) {
  const cached = czechCache.get(key);
  if (cached) return cached;
  if (performance.now() > budget.deadline) {
    czechPending.add(key);
    if (deferred) deferred.incomplete = true;
    return null;
  }
  return computeCzech(key);
}

/** @param {string} word */
async function askEnglish(word) {
  if (englishCache.size >= WORD_CACHE_LIMIT) englishCache.clear();
  const ok = Boolean(await harperEngine.isLikelyEnglish(word));
  englishCache.set(word, ok);
  return ok;
}

/**
 * @param {string} word
 * @param {{ deadline: number }} budget
 * @param {{ incomplete: boolean }} [deferred]
 */
async function englishWord(word, budget, deferred) {
  const cached = englishCache.get(word);
  if (cached !== undefined) return cached;
  if (performance.now() > budget.deadline) {
    englishPending.add(word);
    if (deferred) deferred.incomplete = true;
    return null;
  }
  return askEnglish(word);
}

/** @param {string} word */
async function computeEnglishFixes(word) {
  if (englishSuggestions.size >= WORD_CACHE_LIMIT) englishSuggestions.clear();
  /** @type {string[]} */
  const list = [];
  for (const lint of await harperEngine.lint(word)) {
    if (WARNING_KINDS.has(lint.lint_kind())) {
      for (const s of lint.suggestions()) {
        if (s.kind() !== REMOVE && list.length < MAX_ACTIONS) {
          list.push(s.get_replacement_text());
        }
        s.free();
      }
    }
    lint.free();
  }
  englishSuggestions.set(word, list);
  // No `englishFixPending.delete(word)` here: see computeCzech.
  return list;
}

/**
 * @param {string} word
 * @param {{ deadline: number }} budget
 * @param {{ incomplete: boolean }} [deferred]
 */
async function englishFixes(word, budget, deferred) {
  const cached = englishSuggestions.get(word);
  if (cached) return cached;
  if (performance.now() > budget.deadline) {
    englishFixPending.add(word);
    if (deferred) deferred.incomplete = true;
    return [];
  }
  return computeEnglishFixes(word);
}

function hasPendingIdleWork() {
  return czechPending.size > 0 || englishPending.size > 0 || englishFixPending.size > 0;
}

function scheduleIdleFill() {
  if (idleScheduled || !hasPendingIdleWork()) return;
  idleScheduled = true;
  const slice = async () => {
    const stop = performance.now() + SUGGEST_BUDGET_MS;
    if (hunspellEngine) {
      for (const key of czechPending) {
        if (performance.now() > stop) break;
        // Often cached by now: a later paragraph of the pass that queued the
        // word had budget for it. It still counts as work done here, because
        // the paragraph that queued it is waiting for the new pass below.
        if (!czechCache.has(key)) computeCzech(key);
        czechPending.delete(key);
      }
    } else {
      czechPending.clear();
    }
    if (harperEngine) {
      for (const word of englishPending) {
        if (performance.now() > stop) break;
        englishPending.delete(word);
        if (!englishCache.has(word)) await askEnglish(word);
      }
      for (const word of englishFixPending) {
        if (performance.now() > stop) break;
        englishFixPending.delete(word);
        if (!englishSuggestions.has(word)) await computeEnglishFixes(word);
      }
    } else {
      englishPending.clear();
      englishFixPending.clear();
    }
    if (hasPendingIdleWork()) {
      setTimeout(slice, 10);
    } else {
      idleScheduled = false;
      paraCache.clear();
      self.postMessage({ event: "idle-filled" });
    }
  };
  setTimeout(slice, 10);
}

/** @param {string} text */
function proseOnly(text) {
  for (const re of NOT_PROSE) text = text.replace(re, (m) => " ".repeat(m.length));
  return text;
}

/** @param {string} word @param {string} before @param {string} after */
function skipWord(word, before, after) {
  if (word.length > 1 && word === word.toUpperCase()) return true;
  if (/\d/.test(before) || /\d/.test(after)) return true;
  return !/^[\p{Script=Latin}\p{M}'’-]+$/u.test(word);
}

/** @param {string} paraText */
function proseWordsInPara(paraText) {
  /** @type {{ word: string, from: number, to: number }[]} */
  const out = [];
  const clean = proseOnly(paraText);
  for (const m of clean.matchAll(WORD)) {
    const word = m[0];
    const start = /** @type {number} */ (m.index);
    if (skipWord(word, clean[start - 1] ?? "", clean[start + word.length] ?? "")) continue;
    out.push({ word, from: start, to: start + word.length });
  }
  return out;
}

/** @param {string} text @returns {SerializedAction} */
function replaceAction(text) {
  return { kind: 0, text, name: text };
}

/** @param {any} suggestion @returns {SerializedAction} */
function serializeSuggestion(suggestion) {
  const kind = suggestion.kind();
  const text = suggestion.get_replacement_text();
  return { kind, text, name: kind === REMOVE ? "Remove" : text };
}

/**
 * @param {any} lint
 * @param {string} rule  The Harper rule that made the lint.
 * @returns {SerializedDiag}
 */
function serializeHarperLint(lint, rule) {
  const span = lint.span();
  const from = span.start;
  const to = span.end;
  span.free();

  const suggestions = lint.suggestions();
  /** @type {SerializedAction[]} */
  const actions = [];
  for (let i = 0; i < suggestions.length; i++) {
    if (i < MAX_ACTIONS) actions.push(serializeSuggestion(suggestions[i]));
    suggestions[i].free();
  }

  /** @type {SerializedDiag} */
  const d = {
    from,
    to,
    severity: WARNING_KINDS.has(lint.lint_kind()) ? "warning" : "info",
    message: lint.message(),
    source: lint.lint_kind_pretty(),
    actions,
    // A kind ("Readability") is shared by many rules, so the rule cannot be
    // guessed from it.
    rule,
  };
  lint.free();
  return d;
}

/** @param {number} from @param {number} to @param {string[]} twinList @returns {SerializedDiag} */
function plainDiag(from, to, twinList) {
  return {
    from,
    to,
    severity: "info",
    message:
      twinList.length === 1
        ? "Czech without diacritics."
        : "Czech without diacritics: more than one word fits.",
    source: PLAIN_SOURCE,
    actions: twinList.slice(0, MAX_ACTIONS).map(replaceAction),
  };
}

/** @param {number} from @param {number} to @param {string} word @param {string[]} fixes @returns {SerializedDiag} */
function typoDiag(from, to, word, fixes) {
  return {
    from,
    to,
    severity: "warning",
    message: "“" + word + "” is not a known word.",
    source: "Spelling",
    actions: fixes.map(replaceAction),
  };
}

/**
 * Lint a document by paragraph, reusing cached paragraph results for unchanged
 * paragraphs and aborting early if `reqId` was superseded by newer typing.
 * @param {string} text
 * @param {{ cs: boolean, en: boolean }} requestedLangs
 * @param {number} reqId
 */
async function lintDocument(text, requestedLangs, reqId) {
  const langs = {
    cs: Boolean(requestedLangs.cs && !hunspellBroken),
    en: Boolean(requestedLangs.en && !harperBroken),
  };
  if (!langs.cs && !langs.en) return { diagnostics: [] };

  let waiting = false;
  if (langs.cs && !hunspellEngine) {
    waiting = true;
    void loadHunspell().then(() => self.postMessage({ event: "engine-ready" }));
  }
  if (langs.en && !harperEngine) {
    waiting = true;
    void loadHarper().then(() => self.postMessage({ event: "engine-ready" }));
  }
  if (waiting) return { diagnostics: [] };

  const prose = segments(text).filter((s) => !s.code);
  const langMask = (langs.cs ? "cs" : "") + "+" + (langs.en ? "en" : "");
  /** @type {SerializedDiag[]} */
  const out = [];
  let budget = { deadline: performance.now() + SUGGEST_BUDGET_MS };

  /** @type {{ incomplete: boolean }} */
  let deferred = { incomplete: false };
  const ask = {
    mine: isMine,
    czech: (/** @type {string} */ w) => isCzechWord(w),
    twins: (/** @type {string} */ w) => answerCzech("t" + w, budget, deferred),
  };

  for (const seg of prose) {
    if (reqId !== latestLintReqId) return { stale: true, diagnostics: [] };
    const paraText = text.slice(seg.from, seg.to);
    const useEnglishPass = langs.en && seg.lang === "en";
    const cacheKey = langMask + ":" + (useEnglishPass ? "en" : "w") + "\0" + paraText;
    const cached = paraCache.get(cacheKey);
    if (cached) {
      for (const d of cached) {
        out.push({ ...d, from: seg.from + d.from, to: seg.from + d.to });
      }
      continue;
    }

    deferred = { incomplete: false };
    /** @type {SerializedDiag[]} */
    const relDiags = [];

    if (useEnglishPass) {
      // organizedLints and not lint: it gives the same lints by rule, and a
      // lint alone does not say which rule made it.
      const byRule = await harperEngine.organizedLints(paraText);
      const lints = Object.entries(byRule).flatMap(([rule, list]) =>
        /** @type {any[]} */ (list).map((raw) => ({ raw, rule }))
      );
      for (const { raw, rule } of lints) {
        const d = serializeHarperLint(raw, rule);
        const word = paraText.slice(d.from, d.to);
        // My words: no red mark on a word of the list, whichever Harper rule
        // made the mark and also for a token the word rule below does not
        // cover ("v2ray"). After "Add to my words" the mark must be gone,
        // and a filter by rule would leave the marks of every rule but
        // SpellCheck.
        if (d.severity === "warning" && isMine(word)) continue;
        if (d.severity !== "warning" || !/^[\p{L}\p{M}'’-]+$/u.test(word)) {
          relDiags.push(d);
          continue;
        }
        const verdict = judge(word, langs, { ...ask, english: () => false }, config.plain);
        if (verdict === "typo") {
          const czech = langs.cs ? answerCzech("s" + word, budget, deferred) ?? [] : [];
          const names = d.actions.map((a) => a.name);
          const extra = czech.filter((c) => !names.includes(c)).map(replaceAction);
          relDiags.push({ ...d, actions: [...d.actions, ...extra].slice(0, MAX_ACTIONS) });
        } else if (verdict === "pending") {
          deferred.incomplete = true;
        } else if (verdict !== "ok") {
          relDiags.push(plainDiag(d.from, d.to, verdict.plain));
        }
      }
    } else {
      if (performance.now() > budget.deadline) {
        budget = { deadline: performance.now() + 15 };
      }
      /** @type {Map<string, boolean | null>} */
      const english = new Map();
      for (const { word, from, to } of proseWordsInPara(paraText)) {
        if (langs.en && !english.has(word) && !isMine(word) && !(langs.cs && isCzechWord(word))) {
          english.set(word, await englishWord(word, budget, deferred));
        }
        const verdict = judge(word, langs, { ...ask, english: (w) => english.get(w) ?? null }, config.plain);
        if (verdict === "ok") continue;
        if (verdict === "pending") {
          deferred.incomplete = true;
          continue;
        }
        if (verdict === "typo") {
          const czech = langs.cs ? answerCzech("s" + word, budget, deferred) ?? [] : [];
          const eng = langs.en ? await englishFixes(word, budget, deferred) : [];
          relDiags.push(typoDiag(from, to, word, mergeSuggestions(czech, eng)));
        } else {
          relDiags.push(plainDiag(from, to, verdict.plain));
        }
      }
    }

    // Cache only complete paragraph results: any budget deferral (including
    // `englishFixes` or words already queued by an earlier paragraph) must
    // re-lint once `scheduleIdleFill` finishes.
    if (!deferred.incomplete) {
      if (paraCache.size >= PARA_CACHE_LIMIT) paraCache.clear();
      paraCache.set(cacheKey, relDiags);
    }
    for (const d of relDiags) {
      out.push({ ...d, from: seg.from + d.from, to: seg.from + d.to });
    }
  }

  scheduleIdleFill();
  return { diagnostics: out };
}

/** @param {string} text @param {any} [options] */
async function rawHarperLint(text, options) {
  const engine = await loadHarper();
  if (!engine) return [];
  const lints = await engine.lint(text, options);
  const out = [];
  for (const lint of lints) {
    const span = lint.span();
    const start = span.start;
    const end = span.end;
    span.free();
    const suggestions = [];
    for (const s of lint.suggestions()) {
      suggestions.push({ kind: s.kind(), text: s.get_replacement_text() });
      s.free();
    }
    out.push({
      start,
      end,
      kind: lint.lint_kind(),
      kindPretty: lint.lint_kind_pretty(),
      message: lint.message(),
      suggestions,
    });
    lint.free();
  }
  return out;
}

/** @param {{ word: string, from: number, to: number }[]} prose */
async function analyzeDiacritics(prose) {
  const [harper, czech] = await Promise.all([loadHarper(), loadHunspell()]);
  if (!czech) return { czechLoaded: false };
  /** @type {[number, string][]} */
  const localEntries = [];
  let ambiguous = 0;
  /** @type {number[]} */
  const plainOffsets = [];
  /** @type {string[]} */
  const englishOnlyWords = [];
  /** @type {number[]} */
  const englishAtOffsets = [];

  for (const { word, from: at } of prose) {
    if (isCzechWord(word)) continue;
    if (harper && (englishCache.get(word) ?? (await askEnglish(word)))) {
      englishOnlyWords.push(word);
      englishAtOffsets.push(at);
      continue;
    }
    const twinList = czechCache.get("t" + word) ?? computeCzech("t" + word);
    if (twinList.length === 0) continue;
    plainOffsets.push(at);
    if (twinList.length === 1) localEntries.push([at, twinList[0]]);
    else ambiguous++;
  }
  return {
    czechLoaded: true,
    localEntries,
    ambiguous,
    plainOffsets,
    englishOnlyWords,
    englishAtOffsets,
  };
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  const { id, op } = msg;
  if (op === "lint" && typeof msg.reqId === "number") {
    latestLintReqId = Math.max(latestLintReqId, msg.reqId);
  }

  try {
    let result;
    if (op === "init") {
      const [h, c] = await Promise.all([
        msg.en === false ? null : loadHarper(),
        msg.cs === false ? null : loadHunspell(),
      ]);
      result = {
        enReady: Boolean(h),
        enBroken: harperBroken,
        csReady: Boolean(c),
        csBroken: hunspellBroken,
      };
    } else if (op === "lint") {
      if (msg.reqId < latestLintReqId) {
        result = { stale: true, diagnostics: [] };
      } else {
        result = await lintDocument(msg.text, msg.langs, msg.reqId);
      }
    } else if (op === "config") {
      const rulesChanged = JSON.stringify(msg.rules ?? {}) !== JSON.stringify(config.rules);
      config = { rules: msg.rules ?? {}, words: new Set(msg.words ?? []), plain: msg.plain !== false };
      if (harperEngine) await harperEngine.setLintConfig(config.rules);
      // Every cached paragraph was linted with the old settings. No pass is
      // in the middle of a paragraph here: a pass waits for Harper alone, and
      // those waits end before the next message is read.
      paraCache.clear();
      // The fixes of a word come from a Harper lint of that word alone
      // (computeEnglishFixes), so they follow the rules: with SpellCheck off
      // the list is empty, and it must not stay empty when the rule is back.
      if (rulesChanged) englishSuggestions.clear();
      result = true;
    } else if (op === "catalog") {
      const h = await loadHarper();
      result = h ? await buildCatalog(h) : null;
    } else if (op === "harperLint") {
      result = await rawHarperLint(msg.text, msg.options);
    } else if (op === "isLikelyEnglish") {
      const h = await loadHarper();
      result = h ? (englishCache.get(msg.word) ?? (await askEnglish(msg.word))) : false;
    } else if (op === "twinsBatch") {
      const c = await loadHunspell();
      result = c
        ? (msg.words ?? []).map((/** @type {string} */ w) => czechCache.get("t" + w) ?? computeCzech("t" + w))
        : [];
    } else if (op === "analyzeDiacritics") {
      result = await analyzeDiacritics(msg.prose ?? []);
    } else if (op === "checkCzechWords") {
      const c = await loadHunspell();
      result = c
        ? (msg.words ?? []).filter((/** @type {string} */ w) => isCzechWord(w))
        : [];
    } else {
      throw new Error("spellcheck.worker: unknown op " + op);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: String(err instanceof Error ? err.message : err),
    });
  }
});
