// @ts-check
// Natural-language detection for spellcheck (architecture.md §11): is this
// text Czech or English? Pure functions, no editor, no store, so a Node
// script can exercise them as easily as the lint pass does.
//
// The unit is the paragraph, not the document. Notes mix languages all the
// time (a Czech shopping list under an English meeting summary), and a
// document-level verdict would underline one half of such a note as
// misspelled. A paragraph with no signal of its own inherits the document's
// verdict, so one-word headings and short lines follow their surroundings.

/** @typedef {"cs" | "en"} Lang */

/**
 * @typedef {Object} Segment
 * @property {number} from   Offset of the paragraph's first character.
 * @property {number} to     Offset just past its last character.
 * @property {Lang} lang     The paragraph's language after inheritance.
 * @property {boolean} code  Inside a fenced code block: never spellchecked.
 */

// A letter that exists in Czech and not in English is the strongest signal a
// word can carry, so it counts double. Slovak shares most of them, which is
// fine: no Slovak dictionary is vendored and Czech is the nearer of the two.
const CZECH_LETTERS = /[ěščřžýáíéúůďťňĚŠČŘŽÝÁÍÉÚŮĎŤŇ]/;

// Function words are the second signal: every real paragraph has them and no
// dictionary word list is needed to spot them. Czech is listed both with and
// without diacritics because a lot of Czech is typed without them, on phones
// especially, and the letter test above never sees those forms.
//
// A form that is a common word in BOTH languages is in neither list (a, i,
// to, on, do, no, my, me, by, at, ten, pro, co, s). It would count for the
// wrong side half the time, so it counts for nobody.
const CZECH_WORDS = new Set(
  (
    "je se na v ve z ze k u o od po za pro si ne ano ale jak tak kde kdy " +
    "co kdo proc proč protoze protože ktery který ktera která ktere které " +
    "kteri kteří jsem jsi jsme jste jsou byl byla bylo byli bude budu " +
    "budeme bych bys bychom mam mám mas máš ma má mame máme maji mají " +
    "nic neco něco nekdo někdo nikdo nikdy vzdy vždy kazdy každý vsechno " +
    "všechno vsechny všechny nebo taky take také jeste ještě uz už jen " +
    "jenom moc hodne hodně malo málo dnes zitra zítra vcera včera ted teď " +
    "pak potom tady tam sem chci chce chceme muzu můžu muze může musim " +
    "musím musi musí treba třeba napr např atd tento tato toto tenhle " +
    "tahle tohle toho tomu tim tím tou ta ti ty ja já ona ono oni vy " +
    "nas nás vas vás jim jich nam nám vam vám ho mu jeho jeji její jejich " +
    "muj můj moje tvuj tvůj tvoje nase naše vase vaše svuj svůj sve své " +
    "kdyz když az až aby nez než jestli pokud kdyby jako"
  ).split(" "),
);

const ENGLISH_WORDS = new Set(
  (
    "the and is are was were be been being of in that this it with for as " +
    "from or an you we they he she but which will can if would all there " +
    "their what so about has have had not more when who than also into its " +
    "your our does did should could then these those some any one only " +
    "just like get got make made use used new now how why where here very " +
    "much many most other such each because while after before between " +
    "through over under again still too well up out down off back him his " +
    "her them us am were was want need know think see look go going went " +
    "come came take took give gave say said tell told ask asked work " +
    "things thing something anything nothing everything someone anyone " +
    "everyone nobody never always often sometimes today tomorrow yesterday " +
    "yes okay ok please thanks thank"
  ).split(" "),
);

// The English list contains "i" only as an uppercase pronoun in real text,
// and lowercasing throws that away, which is why it is in neither list.

// The weakest signal, for Czech typed without diacritics and without function
// words ("koupit mleko a chleba"): a word that starts with a consonant
// cluster English words never start with. Clusters that begin an English
// word or a common abbreviation (tv, vs, ps, cv, chr, kn, hm) are left out.
const CZECH_ONSETS =
  /^(?:zv|vz|ml|hl|chl|chv|chc|zn|js|jd|kd|kt|vl|vr|dv|sv|zb|zp|zk|zt|vt|vd|hn|hv|pt|lh|lz|rz|ct|zh|zd|zl|zm|zr|dl|tl|vn|vk|kv|mn|dn)/;

/**
 * How Czech and how English a piece of text looks.
 * @param {string} text
 * @returns {{ cs: number, en: number }}
 */
export function score(text) {
  let cs = 0;
  let en = 0;
  const words = text.toLowerCase().match(/[\p{L}\p{M}]+/gu);
  if (!words) return { cs, en };
  for (const word of words) {
    if (CZECH_LETTERS.test(word)) cs += 2;
    else if (CZECH_WORDS.has(word) || CZECH_ONSETS.test(word)) cs += 1;
    else if (ENGLISH_WORDS.has(word)) en += 1;
  }
  return { cs, en };
}

/**
 * The language of a text on its own, or null when it gives no signal
 * (an empty string, a number, a single unknown word).
 * @param {string} text
 * @returns {Lang | null}
 */
export function detectLanguage(text) {
  const s = score(text);
  if (s.cs > s.en) return "cs";
  if (s.en > s.cs) return "en";
  return null;
}

// A fence line: three or more backticks or tildes, optionally indented up to
// three spaces, the CommonMark shape. The closing fence is any fence line, so
// an info string on the opening line does not matter.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split a document into paragraphs, each tagged with its language.
 *
 * Paragraphs are runs of non-blank lines. Fenced code blocks are their own
 * paragraphs with `code: true`, whatever blank lines they contain, so a
 * blank line inside a code block never ends the block. Each paragraph's own
 * verdict wins; a paragraph with none takes the document's, and a document
 * with none is English, which is what the editor assumed before Czech
 * existed.
 *
 * @param {string} text
 * @returns {Segment[]}
 */
export function segments(text) {
  /** @type {{ from: number, to: number, code: boolean, own: Lang | null }[]} */
  const paras = [];
  let docCs = 0;
  let docEn = 0;

  const lines = text.split("\n");
  let offset = 0;
  /** @type {{ from: number, code: boolean } | null} */
  let open = null;

  /** @param {number} to */
  function close(to) {
    if (!open) return;
    const own = open.code ? null : detectLanguage(text.slice(open.from, to));
    if (!open.code) {
      const s = score(text.slice(open.from, to));
      docCs += s.cs;
      docEn += s.en;
    }
    paras.push({ from: open.from, to, code: open.code, own });
    open = null;
  }

  for (const line of lines) {
    const end = offset + line.length;
    if (open && open.code) {
      // Inside a fence: only another fence line ends it.
      if (FENCE.test(line)) close(end);
    } else if (FENCE.test(line)) {
      close(offset > 0 ? offset - 1 : 0);
      open = { from: offset, code: true };
    } else if (line.trim() === "") {
      close(offset > 0 ? offset - 1 : 0);
    } else if (!open) {
      open = { from: offset, code: false };
    }
    offset = end + 1;
  }
  close(text.length);

  const docLang = docCs > docEn ? "cs" : "en";
  return paras.map((p) => ({
    from: p.from,
    to: p.to,
    code: p.code,
    lang: p.own ?? docLang,
  }));
}

/**
 * The languages present in the text, most frequent first, code blocks
 * ignored. An empty text reports nothing.
 * @param {Segment[]} segs
 * @returns {Lang[]}
 */
export function languagesOf(segs) {
  /** @type {Map<Lang, number>} */
  const chars = new Map();
  for (const s of segs) {
    if (s.code) continue;
    chars.set(s.lang, (chars.get(s.lang) ?? 0) + (s.to - s.from));
  }
  return [...chars.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
}
