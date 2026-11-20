// @ts-check
// Czech without diacritics (.work/mixed-spellcheck/plan.md). Pure functions,
// no DOM and no engine: the caller passes Hunspell's `isWord`, so Node tests
// can run this module with a fake dictionary.
//
// A "twin" of a word is a correct Czech word that gives the same letters
// once the diacritics are stripped: "tlačítko" is the twin of "tlacitko".

// Letters with inner hyphens and apostrophes: the word rule of the spellcheck,
// so a "word" means the same thing in the marks and in the commands.
export const WORD = /[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*/gu;

// The Czech letters with a diacritic, grouped by their base letter. This is
// the whole alphabet on purpose, not \p{Diacritic}: a Unicode-wide strip would
// also remove signs such as "`", and the model-answer check below would then
// let a model add Markdown that nobody sees (plan review, finding 18).
const GROUPS = ["aá", "cč", "dď", "eéě", "ií", "nň", "oó", "rř", "sš", "tť", "uúů", "yý", "zž"];

/** @type {Map<string, string>} accented letter -> base letter */
const BASE = new Map();
/** @type {Map<string, string[]>} base letter -> its accented letters */
const ACCENTED = new Map();
for (const group of GROUPS) {
  for (const g of [group, group.toUpperCase()]) {
    const [base, ...accented] = [...g];
    ACCENTED.set(base, accented);
    for (const a of accented) BASE.set(a, base);
  }
}

/**
 * The text with each Czech diacritic letter replaced by its base letter. The
 * length stays the same: every letter in the map is one UTF-16 unit in NFC.
 * @param {string} text
 */
export function strip(text) {
  let out = "";
  for (const ch of text) out += BASE.get(ch) ?? ch;
  return out;
}

// A long word with many vowels has thousands of diacritic variants, and each
// costs one Hunspell test (10 to 50 µs). Past this count the search gives up
// and the word keeps a red mark, as before this feature. Measured on Czech
// Wikipedia text (.work/mixed-spellcheck/experiment/results.md): 1,024 finds
// the original for 98 % of the words with the slowest word at 20 ms; 4,096
// finds 99.8 % but one word can take 115 ms, a visible stop of the editor.
export const MAX_VARIANTS = 1024;

// Czech spelling rules that remove variants nobody writes, so the search
// tests fewer words. They cut the tests by a third (same results file).
const SOFT = /^[dtnDTN]$/; // ď ť ň are written d t n before e, i, í, ě
const BEFORE_SOFT = /^[eiíěEIÍĚ]$/;
const E_CARON_AFTER = /^[bpvfmdtnBPVFMDTN]$/; // ě follows only these

/**
 * The letters each position of a stripped word can take.
 * @param {string[]} base
 * @returns {string[][]}
 */
function choices(base) {
  return base.map((ch, i) => {
    const accented = ACCENTED.get(ch);
    if (!accented) return [ch];
    if (SOFT.test(ch) && BEFORE_SOFT.test(base[i + 1] ?? "")) return [ch];
    return [ch, ...accented].filter((c) => {
      if (c === "ě" || c === "Ě") return E_CARON_AFTER.test(base[i - 1] ?? "");
      if (c === "ů" || c === "Ů") return i > 0;
      return true;
    });
  });
}

/**
 * The twins of a word: every correct word (by `isWord`) that strips to the
 * same letters, except the word itself. Returns null when the word has more
 * than MAX_VARIANTS variants, so the caller can tell "none" from "not tried".
 * @param {string} word
 * @param {(w: string) => boolean} isWord
 * @returns {string[] | null}
 */
export function twins(word, isWord) {
  const base = [...strip(word)];
  const options = choices(base);
  let count = 1;
  for (const o of options) {
    count *= o.length;
    if (count > MAX_VARIANTS) return null;
  }
  /** @type {string[]} */
  const out = [];
  const pick = new Array(base.length).fill("");
  const walk = (/** @type {number} */ i) => {
    if (i === base.length) {
      const candidate = pick.join("");
      if (candidate !== word && isWord(candidate)) out.push(candidate);
      return;
    }
    for (const ch of options[i]) {
      pick[i] = ch;
      walk(i + 1);
    }
  };
  walk(0);
  return out;
}

/**
 * Check a model's answer for one paragraph and return the text to use, or
 * null to drop the whole answer. The model may only add diacritics:
 *  - the answer (in NFC) has the same length as what was sent,
 *  - each changed character goes from a base letter to one of its accented
 *    letters, never the other way and never to anything else,
 *  - each changed word is a correct word; a word that is not keeps the
 *    letters that were sent.
 * The first two rules drop the paragraph, because a model that changes other
 * characters is not doing this job and its word boundaries cannot be trusted.
 * @param {string} sent
 * @param {string} answer
 * @param {(w: string) => boolean} isWord
 * @returns {{ text: string, changed: number } | null}
 */
export function checkAnswer(sent, answer, isWord) {
  // Models often add a final newline or trailing spaces; that is not a change
  // to the text, and dropping the paragraph for it would waste the answer.
  const got = answer.normalize("NFC").replace(/\s+$/, "") + sent.slice(sent.replace(/\s+$/, "").length);
  if (got.length !== sent.length) return null;
  for (let i = 0; i < sent.length; i++) {
    if (got[i] === sent[i]) continue;
    if (!ACCENTED.get(sent[i])?.includes(got[i])) return null;
  }
  let changed = 0;
  const text = sent.replace(WORD, (word, at) => {
    const next = got.slice(at, at + word.length);
    if (next === word || !isWord(next)) return word;
    changed++;
    return next;
  });
  return { text, changed };
}
