// @ts-check
// The spellcheck settings that all devices share: which Harper rules the user
// changed, and the user's own words ("My words"). Pure functions on plain
// data, with no DOM and no storage, so Node tests can run them
// (tests/spellsettings.test.mjs). The data lives in one hidden record
// (model/docs.js, SETTINGS_ID) and syncs to each device of the user.
//
// Each entry carries the time of its last change. Two devices change their
// copies while they are offline, and mergeSettings() then takes the newer
// entry for each rule and each word. That is also why nothing is ever deleted
// here: a removed word keeps its entry with `gone`, and a rule that is back
// at Harper's default keeps its entry with `on: null`. Without the entry, the
// older copy of another device would bring the word or the switch back.

/**
 * `on: null` means "Harper's default", whatever that is in the Harper
 * version of the device that reads it.
 * @typedef {{ on: boolean | null, at: number }} RuleEntry
 */
/** @typedef {{ word: string, at: number, gone?: true }} WordEntry */
/**
 * `words` is keyed by wordKey(), so one word has one entry however it is
 * capitalized.
 * @typedef {{ v: 1, rules: Record<string, RuleEntry>, words: Record<string, WordEntry> }} SpellSettings
 */

/** @returns {SpellSettings} */
export function emptySettings() {
  return { v: 1, rules: {}, words: {} };
}

// The two maps are keyed by text from outside: a word the user typed, a name
// in a revision of another device. On a plain object such a key can collide
// with what every object inherits, so each lookup and each assignment by a
// variable key goes through the two functions below. ("{ ...map, [key]: x }"
// is safe as it is: a spread and a computed key make own properties.)

/**
 * The entry under `key`, own entries only. A plain `map[key]` also finds
 * `Object.prototype`: for the words "constructor" and "__proto__" it gave a
 * function and an object, the word counted as "there already", and "My
 * words" could not take it.
 * @template T
 * @param {Record<string, T>} map @param {string} key @returns {T | undefined}
 */
function entryOf(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * Store an entry as an own property. A plain `map[key] = entry` with the key
 * "__proto__" would change the prototype of the map and store nothing.
 * @template T
 * @param {Record<string, T>} map @param {string} key @param {T} entry
 */
function setEntry(map, key, entry) {
  Object.defineProperty(map, key, { value: entry, enumerable: true, writable: true, configurable: true });
}

/**
 * The settings from the content of the record. Tolerant on purpose: the
 * content can come from another device, and one bad entry must not cost the
 * user the rest of the list.
 * @param {string | undefined | null} content
 * @returns {SpellSettings}
 */
export function readSettings(content) {
  const out = emptySettings();
  /** @type {any} */
  let value = null;
  try {
    value = content ? JSON.parse(content) : null;
  } catch {
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [name, entry] of Object.entries(value.rules ?? {})) {
    if (!entry || typeof entry.at !== "number") continue;
    if (entry.on !== null && typeof entry.on !== "boolean") continue;
    setEntry(out.rules, name, { on: entry.on, at: entry.at });
  }
  for (const entry of Object.values(value.words ?? {})) {
    if (!entry || typeof entry.word !== "string" || typeof entry.at !== "number") continue;
    const key = wordKey(entry.word);
    if (!key) continue;
    setEntry(out.words, key, entry.gone ? { word: entry.word, at: entry.at, gone: true } : { word: entry.word, at: entry.at });
  }
  return out;
}

// ---- Rules ---------------------------------------------------------------------

/**
 * Switch one rule. A state equal to Harper's default is stored as null, so
 * "N changed" counts only the rules that differ from the default, and a rule
 * the user put back follows a later change of the default in Harper.
 * @param {SpellSettings} settings
 * @param {string} name     Harper's identifier, e.g. "LongSentences".
 * @param {boolean} on
 * @param {boolean} byDefault  Harper's default for this rule.
 * @param {number} now
 * @returns {SpellSettings}
 */
export function setRule(settings, name, on, byDefault, now) {
  return { ...settings, rules: { ...settings.rules, [name]: { on: on === byDefault ? null : on, at: now } } };
}

/**
 * "Reset to defaults": every changed rule goes back to null. The words stay.
 * @param {SpellSettings} settings @param {number} now @returns {SpellSettings}
 */
export function resetRules(settings, now) {
  /** @type {Record<string, RuleEntry>} */
  const rules = {};
  for (const [name, entry] of Object.entries(settings.rules)) {
    setEntry(rules, name, entry.on === null ? entry : { on: null, at: now });
  }
  return { ...settings, rules };
}

/**
 * The rules that differ from the default, as the map Harper's setLintConfig
 * takes. Harper replaces its whole map on each call and reads a missing rule
 * as "default", so this is always the complete list.
 * @param {SpellSettings} settings @returns {Record<string, boolean>}
 */
export function lintConfig(settings) {
  /** @type {Record<string, boolean>} */
  const config = {};
  for (const [name, entry] of Object.entries(settings.rules)) {
    if (entry.on !== null) config[name] = entry.on;
  }
  return config;
}

/** @param {SpellSettings} settings @returns {number} */
export function changedCount(settings) {
  return Object.keys(lintConfig(settings)).length;
}

/**
 * Harper names a rule with an identifier and gives no display name. The
 * name on screen is the identifier with spaces, so vrtti keeps no list of
 * its own that a Harper update could leave behind.
 * @param {string} name @returns {string}
 */
export function displayName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

// ---- My words ------------------------------------------------------------------

/**
 * The identity of a word: small letters, so "vrtti" also covers "Vrtti" at
 * the start of a sentence and "VRTTI". Normalized, so a word typed with a
 * combining accent on one device equals the precomposed one from another.
 * @param {string} word @returns {string}
 */
export function wordKey(word) {
  return word.normalize("NFC").trim().toLowerCase();
}

/**
 * @param {SpellSettings} settings @param {string} word @param {number} now
 * @returns {SpellSettings} The same object when the word is empty or there already.
 */
export function addWord(settings, word, now) {
  const key = wordKey(word);
  const have = entryOf(settings.words, key);
  if (!key || /\s/.test(key) || (have && !have.gone)) return settings;
  return { ...settings, words: { ...settings.words, [key]: { word: word.normalize("NFC").trim(), at: now } } };
}

/**
 * @param {SpellSettings} settings @param {string} word @param {number} now
 * @returns {SpellSettings} The same object when the word is not in the list.
 */
export function removeWord(settings, word, now) {
  const key = wordKey(word);
  const have = entryOf(settings.words, key);
  if (!have || have.gone) return settings;
  return { ...settings, words: { ...settings.words, [key]: { word: have.word, at: now, gone: true } } };
}

/**
 * The words on screen, in the order of the alphabet without regard to case.
 * @param {SpellSettings} settings @returns {string[]}
 */
export function wordList(settings) {
  return Object.values(settings.words)
    .filter((entry) => !entry.gone)
    .map((entry) => entry.word)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b));
}

/**
 * The keys of the words, for the check of a mark.
 * @param {SpellSettings} settings @returns {Set<string>}
 */
export function wordKeys(settings) {
  return new Set(Object.entries(settings.words).filter(([, entry]) => !entry.gone).map(([key]) => key));
}

/**
 * The words of a pasted text ("Edit as text"). Spaces, commas and line ends
 * all separate, so a list copied from a sentence or a spreadsheet works too.
 * @param {string} text @returns {string[]}
 */
export function parseWords(text) {
  return text.split(/[\s,]+/u).filter(Boolean);
}

/**
 * Make the list equal to `list` ("Edit as text", Save): add what is new and
 * remove what is missing. A word that stays keeps its entry and its time.
 * @param {SpellSettings} settings @param {readonly string[]} list @param {number} now
 * @returns {SpellSettings}
 */
export function replaceWords(settings, list, now) {
  const wanted = new Set(list.map(wordKey));
  let next = settings;
  for (const word of list) next = addWord(next, word, now);
  for (const [key, entry] of Object.entries(next.words)) {
    if (!entry.gone && !wanted.has(key)) next = removeWord(next, entry.word, now);
  }
  return next;
}

// ---- Merge ---------------------------------------------------------------------

/**
 * The newer of two entries. With equal times the JSON text decides, so both
 * devices pick the same one whatever order they merge in.
 * @template {{ at: number }} T
 * @param {T | undefined} a @param {T | undefined} b @returns {T}
 */
function newer(a, b) {
  if (!a) return /** @type {T} */ (b);
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/**
 * Two copies of the settings in one: for each rule and each word, the entry
 * with the later change. The times come from the clocks of the devices, so a
 * device with a wrong clock can win by mistake (accepted, plan "Sync").
 * The keys of the result are sorted, so equal settings give equal JSON; the
 * sync code compares the text to know if a copy has something new.
 * @param {SpellSettings} a @param {SpellSettings} b @returns {SpellSettings}
 */
export function mergeSettings(a, b) {
  const out = emptySettings();
  for (const name of [...new Set([...Object.keys(a.rules), ...Object.keys(b.rules)])].sort()) {
    setEntry(out.rules, name, newer(entryOf(a.rules, name), entryOf(b.rules, name)));
  }
  for (const key of [...new Set([...Object.keys(a.words), ...Object.keys(b.words)])].sort()) {
    setEntry(out.words, key, newer(entryOf(a.words, key), entryOf(b.words, key)));
  }
  return out;
}

/**
 * The part of the settings record that joinCopies() reads (the BufferRecord
 * of storage/idb.js has more).
 * @typedef {{ content?: string, updatedAt: number, sync?: { rev: number, dirty: boolean } }} SettingsCopy
 */

/**
 * The copies of the settings record of two windows in one.
 *
 * The record has no owner window. Each window writes it (a switch on the
 * Spellcheck page, a quick button on a mark), and the window that syncs
 * writes it after a push and a pull. Each write reaches the other windows as
 * a whole record. "The copy that came last wins", the rule for the keyring
 * record, would lose here: a rule switched in one window in the moment when
 * another window stored the answer of a push went back to its old state, on
 * screen and then on the server.
 *
 * So the entries merge as they do between devices. All other fields come
 * from the copy that knows the newer revision of the server (`theirs` when
 * both know the same one), and the result is dirty when it holds an entry
 * that this copy lacks.
 * @template {SettingsCopy} R
 * @param {R} mine    The copy of this window.
 * @param {R} theirs  The copy that another window sent.
 * @returns {R}
 */
export function joinCopies(mine, theirs) {
  const base = (mine.sync?.rev ?? 0) > (theirs.sync?.rev ?? 0) ? mine : theirs;
  const text = JSON.stringify(mergeSettings(readSettings(mine.content), readSettings(theirs.content)));
  const joined = { ...base, content: text, updatedAt: Math.max(mine.updatedAt, theirs.updatedAt) };
  // Compared after the same merge alone: a write stores the keys in the order
  // of the changes, a merge sorts them, and the order is no difference.
  const baseText = JSON.stringify(mergeSettings(emptySettings(), readSettings(base.content)));
  if (base.sync) joined.sync = { ...base.sync, dirty: base.sync.dirty || text !== baseText };
  return joined;
}
