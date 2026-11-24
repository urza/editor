// @ts-check
// The rule of the mixed spellcheck (.work/mixed-spellcheck/plan.md): a word
// gets a mark only when each active language rejects it. Pure, so Node tests
// can run it; spellcheck.js passes the engines in as functions.

/** @typedef {"cs" | "en"} SpellLang */
/** @typedef {{ cs: boolean, en: boolean }} Langs */

/**
 * The verdict for one word.
 * - "ok": no mark.
 * - "pending": an answer is not known yet (the twin search waits for idle
 *   time). No mark this pass; the idle fill repaints.
 * - {plain}: Czech without diacritics, a blue mark with the twins.
 * - "typo": a red mark.
 * @typedef {"ok" | "pending" | "typo" | { plain: string[] }} Verdict
 */

/**
 * @param {string} word
 * @param {Langs} langs  The active languages of the note.
 * @param {{ czech: (w: string) => boolean,
 *           english: (w: string) => boolean | null,
 *           twins: (w: string) => string[] | null,
 *           mine?: (w: string) => boolean }} ask
 *   `english` returns null while its answer is not known yet. `mine` says
 *   whether the word is in the user's own list ("My words").
 * @param {boolean} [markPlain]  False when the device switch "Mark Czech
 *   without diacritics" is off.
 * @returns {Verdict}
 */
export function judge(word, langs, ask, markPlain = true) {
  // First, and whatever languages are on: the user declared this word
  // correct. This is the one place both checkers pass through, which is why
  // the list lives here and not in Harper's own dictionary: Harper is never
  // asked in a note with English off, and its list covers one rule only.
  if (ask.mine?.(word)) return "ok";
  if (langs.cs && ask.czech(word)) return "ok";
  let unknown = false;
  if (langs.en) {
    const english = ask.english(word);
    if (english) return "ok";
    unknown = english === null;
  }
  // Without the English answer a word may still be English, so no blue mark
  // either: it would flash and go away when the answer comes.
  if (unknown) return "pending";
  if (langs.cs) {
    const twins = ask.twins(word);
    if (twins === null) return "pending";
    // With the switch off the word is accepted, not left to fall through to
    // "typo": a switch that hides blue marks must not paint the same words
    // red. The twin search still runs, because it is what tells such a word
    // from a real typo.
    if (twins.length > 0) return markPlain ? { plain: twins } : "ok";
  }
  return "typo";
}

/**
 * The active languages from the field of a note. The field lists the
 * languages that are off; absent or empty means both are on.
 * @param {readonly string[] | undefined} spellOff
 * @returns {Langs}
 */
export function activeLangs(spellOff) {
  return { cs: !spellOff?.includes("cs"), en: !spellOff?.includes("en") };
}

/**
 * The list of languages that are off, after one language was switched.
 * Sorted, so two devices that reach the same state store the same value.
 * @param {readonly string[] | undefined} spellOff
 * @param {SpellLang} lang
 * @param {boolean} on
 * @returns {SpellLang[]}
 */
export function switchLang(spellOff, lang, on) {
  const off = new Set(/** @type {SpellLang[]} */ (spellOff ?? []).filter((l) => l === "cs" || l === "en"));
  if (on) off.delete(lang);
  else off.add(lang);
  return [...off].sort();
}

/**
 * Suggestions from two checkers in one list: the first list first, no
 * duplicates, at most `max`.
 * @param {readonly string[]} first
 * @param {readonly string[]} second
 * @param {number} [max]
 */
export function mergeSuggestions(first, second, max = 5) {
  return [...new Set([...first, ...second])].slice(0, max);
}
