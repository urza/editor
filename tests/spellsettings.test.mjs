// node --test tests/*.test.mjs
// The spellcheck settings that all devices share (app/js/model/spellsettings.js):
// the rule switches, "My words", and the merge of two copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWord,
  changedCount,
  displayName,
  emptySettings,
  joinCopies,
  lintConfig,
  mergeSettings,
  parseWords,
  readSettings,
  removeWord,
  replaceWords,
  resetRules,
  setRule,
  wordKey,
  wordKeys,
  wordList,
} from "../app/js/model/spellsettings.js";
import { isRecentExpired, isSystemRecord, RECENT_KEEP } from "../app/js/model/lifecycle.js";

test("a switch stores only a state that differs from Harper's default", () => {
  let s = emptySettings();
  // LongSentences is on by default: off is a change.
  s = setRule(s, "LongSentences", false, true, 10);
  assert.deepEqual(s.rules.LongSentences, { on: false, at: 10 });
  assert.equal(changedCount(s), 1);
  // Back on: the entry stays (a merge needs its time), but it is no change.
  s = setRule(s, "LongSentences", true, true, 20);
  assert.deepEqual(s.rules.LongSentences, { on: null, at: 20 });
  assert.equal(changedCount(s), 0);
  // SpelledNumbers is off by default: on is a change.
  s = setRule(s, "SpelledNumbers", true, false, 30);
  assert.equal(changedCount(s), 1);
});

test("the map for Harper holds every changed rule and no other", () => {
  let s = emptySettings();
  s = setRule(s, "LongSentences", false, true, 1);
  s = setRule(s, "SpelledNumbers", true, false, 2);
  s = setRule(s, "RepeatedWords", false, true, 3);
  s = setRule(s, "RepeatedWords", true, true, 4);
  // setLintConfig replaces Harper's whole map, so this must be the complete
  // list each time. A rule back at its default is left out: Harper reads a
  // missing rule as "default".
  assert.deepEqual(lintConfig(s), { LongSentences: false, SpelledNumbers: true });
});

test("Reset to defaults clears the rules and keeps the words", () => {
  let s = emptySettings();
  s = setRule(s, "LongSentences", false, true, 1);
  s = addWord(s, "vrtti", 2);
  s = resetRules(s, 50);
  assert.equal(changedCount(s), 0);
  // The time moves, so the reset wins against the older "off" of a device
  // that was offline.
  assert.deepEqual(s.rules.LongSentences, { on: null, at: 50 });
  assert.deepEqual(wordList(s), ["vrtti"]);
});

test("a rule identifier shows with spaces", () => {
  assert.equal(displayName("LongSentences"), "Long Sentences");
  assert.equal(displayName("SpellCheck"), "Spell Check");
  assert.equal(displayName("ACoupleMore"), "A Couple More");
  assert.equal(displayName("AnAnother"), "An Another");
  assert.equal(displayName("NoOxfordComma"), "No Oxford Comma");
  assert.equal(displayName("Hedging"), "Hedging");
});

test("a word covers its forms with capital letters, and no other ending", () => {
  const s = addWord(emptySettings(), "vrtti", 1);
  const keys = wordKeys(s);
  assert.ok(keys.has(wordKey("vrtti")));
  assert.ok(keys.has(wordKey("Vrtti")));
  assert.ok(keys.has(wordKey("VRTTI")));
  assert.ok(!keys.has(wordKey("vrttis")));
});

test("the list keeps the form that was typed first", () => {
  let s = addWord(emptySettings(), "CodeMirror", 1);
  // The same word in another case is no second entry and no rename.
  assert.equal(addWord(s, "codemirror", 2), s);
  assert.deepEqual(wordList(s), ["CodeMirror"]);
  // Empty and multi-word input adds nothing.
  assert.equal(addWord(s, "   ", 3), s);
  assert.equal(addWord(s, "two words", 3), s);
});

test("the list is in the order of the alphabet, without regard to case", () => {
  let s = emptySettings();
  for (const w of ["vrtti", "Harper", "keyring", "CodeMirror", "d3mnjx"]) s = addWord(s, w, 1);
  assert.deepEqual(wordList(s), ["CodeMirror", "d3mnjx", "Harper", "keyring", "vrtti"]);
});

test("a word that every object inherits is a word like any other", () => {
  // The maps are plain objects, and "constructor" is in the vocabulary of a
  // programmer. A plain lookup found Object.prototype there and said "there
  // already"; a plain assignment under "__proto__" stored nothing.
  const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  let s = emptySettings();
  for (const w of names) s = addWord(s, w, 1);
  assert.deepEqual(wordList(s), ["__proto__", "constructor", "hasOwnProperty", "toString"]);
  for (const w of names) assert.ok(wordKeys(s).has(wordKey(w)));
  // Through the record and through a merge: the two places that build a map
  // key by key.
  const back = readSettings(JSON.stringify(s));
  assert.deepEqual(wordList(back), wordList(s));
  assert.deepEqual(wordList(mergeSettings(emptySettings(), back)), wordList(s));
  assert.deepEqual(wordList(mergeSettings(back, emptySettings())), wordList(s));
  // A word that was never added is not "there", so nothing is removed and
  // no entry is written for it.
  const none = emptySettings();
  assert.equal(removeWord(none, "constructor", 2), none);
  s = removeWord(s, "__proto__", 3);
  assert.deepEqual(wordList(s), ["constructor", "hasOwnProperty", "toString"]);
  // A rule name from another device goes the same way.
  const rules = readSettings(JSON.stringify({ v: 1, rules: JSON.parse('{"__proto__":{"on":false,"at":1}}'), words: {} }));
  assert.deepEqual(Object.keys(rules.rules), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(rules.rules), Object.prototype);
  assert.deepEqual(Object.keys(resetRules(rules, 5).rules), ["__proto__"]);
});

test("a removed word leaves the list and keeps an entry for the merge", () => {
  let s = addWord(emptySettings(), "vrtti", 1);
  s = removeWord(s, "Vrtti", 2);
  assert.deepEqual(wordList(s), []);
  assert.ok(!wordKeys(s).has("vrtti"));
  assert.deepEqual(s.words.vrtti, { word: "vrtti", at: 2, gone: true });
  // Added again later: back in the list.
  s = addWord(s, "vrtti", 3);
  assert.deepEqual(wordList(s), ["vrtti"]);
});

test("Edit as text splits at spaces, commas and line ends", () => {
  assert.deepEqual(parseWords("vrtti, Harper\nkeyring  Tauri,\n\n"), ["vrtti", "Harper", "keyring", "Tauri"]);
  assert.deepEqual(parseWords("  \n "), []);
});

test("Edit as text adds the new words and removes the missing ones", () => {
  let s = emptySettings();
  for (const w of ["vrtti", "Harper", "keyring"]) s = addWord(s, w, 1);
  s = replaceWords(s, parseWords("Harper\nTauri\nvrtti"), 9);
  assert.deepEqual(wordList(s), ["Harper", "Tauri", "vrtti"]);
  // A word that stays keeps its time: saving the text unchanged must not
  // make this device win every later merge.
  assert.equal(s.words.vrtti.at, 1);
  assert.equal(s.words.keyring.gone, true);
  assert.equal(s.words.keyring.at, 9);
});

test("a merge takes the newer entry for each rule and each word", () => {
  let phone = emptySettings();
  let desktop = emptySettings();
  phone = setRule(phone, "LongSentences", false, true, 10);
  desktop = setRule(desktop, "LongSentences", false, true, 5);
  desktop = setRule(desktop, "LongSentences", true, true, 20); // put back later
  phone = addWord(phone, "vrtti", 11);
  desktop = addWord(desktop, "Harper", 12);

  const merged = mergeSettings(phone, desktop);
  assert.deepEqual(merged.rules.LongSentences, { on: null, at: 20 });
  // Each device added a word while offline: both words survive.
  assert.deepEqual(wordList(merged), ["Harper", "vrtti"]);
});

test("a removed word stays removed against an older add", () => {
  const old = addWord(emptySettings(), "vrtti", 1);
  const removed = removeWord(old, "vrtti", 5);
  assert.deepEqual(wordList(mergeSettings(old, removed)), []);
  assert.deepEqual(wordList(mergeSettings(removed, old)), []);
  // A later add on the other device wins against the removal.
  const again = addWord(emptySettings(), "vrtti", 9);
  assert.deepEqual(wordList(mergeSettings(removed, again)), ["vrtti"]);
});

test("a merge gives the same text in both orders, and changes nothing twice", () => {
  let a = emptySettings();
  let b = emptySettings();
  a = setRule(a, "LongSentences", false, true, 7);
  a = addWord(a, "vrtti", 7);
  b = setRule(b, "LongSentences", true, true, 7); // the same time, another state
  b = addWord(b, "Vrtti", 7); // the same time, another form
  b = addWord(b, "Harper", 3);
  const ab = JSON.stringify(mergeSettings(a, b));
  const ba = JSON.stringify(mergeSettings(b, a));
  // The sync code compares this text to know if a copy has something new.
  assert.equal(ab, ba);
  const merged = mergeSettings(a, b);
  assert.equal(JSON.stringify(mergeSettings(merged, merged)), ab);
  assert.equal(JSON.stringify(mergeSettings(merged, a)), ab);
});

test("the settings survive the trip through the record, and bad entries are dropped", () => {
  let s = emptySettings();
  s = setRule(s, "LongSentences", false, true, 1);
  s = addWord(s, "vrtti", 2);
  s = removeWord(addWord(s, "old", 3), "old", 4);
  assert.deepEqual(readSettings(JSON.stringify(s)), s);
  assert.deepEqual(readSettings(undefined), emptySettings());
  assert.deepEqual(readSettings("not json"), emptySettings());
  const dirty = JSON.stringify({
    v: 1,
    rules: { Good: { on: false, at: 1 }, NoTime: { on: false }, BadState: { on: "yes", at: 1 } },
    words: { vrtti: { word: "vrtti", at: 1 }, x: { at: 1 }, y: null },
  });
  assert.deepEqual(readSettings(dirty), { v: 1, rules: { Good: { on: false, at: 1 } }, words: { vrtti: { word: "vrtti", at: 1 } } });
});

// ---- Two windows (joinCopies) ---------------------------------------------------

/** A copy of the settings record, as a window holds it. */
function copy(settings, updatedAt, sync) {
  return { id: "shared-settings", content: JSON.stringify(settings), updatedAt, ...(sync ? { sync } : {}) };
}

test("two windows: a switch made while the other window stored a push is kept", () => {
  const pushed = setRule(emptySettings(), "LongSentences", false, true, 10);
  const edited = addWord(pushed, "vrtti", 20);
  // The window that syncs stored the answer of its push: revision 6, clean.
  const leader = copy(pushed, 10, { rev: 6, dirty: false, readers: "age1new" });
  // This window changed a word in the same moment, still on revision 5.
  const mine = copy(edited, 20, { rev: 5, dirty: true, readers: "age1old" });

  // This window gets the copy of the leader: the word stays, the revision
  // moves, and the record is dirty because the server lacks the word.
  let joined = joinCopies(mine, leader);
  assert.deepEqual(wordList(readSettings(joined.content)), ["vrtti"]);
  assert.deepEqual(joined.sync, { rev: 6, dirty: true, readers: "age1new" });
  // The leader gets the copy of this window: the same settings, and the
  // revision does not go back to 5 (a push on 5 would be refused).
  joined = joinCopies(leader, mine);
  assert.deepEqual(wordList(readSettings(joined.content)), ["vrtti"]);
  assert.deepEqual(joined.sync, { rev: 6, dirty: true, readers: "age1new" });
  // A stamp that moved tells the push in flight that the text changed.
  assert.equal(joined.updatedAt, 20);
});

test("two windows: equal settings stay clean, whatever the order of their keys", () => {
  let a = emptySettings();
  a = addWord(a, "vrtti", 1);
  a = addWord(a, "Harper", 2);
  let b = emptySettings();
  b = addWord(b, "Harper", 2);
  b = addWord(b, "vrtti", 1);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  // The answer of a push reaches a window that holds the same settings: a
  // "dirty" here would make that window push them again when it syncs.
  const joined = joinCopies(copy(a, 2, { rev: 3, dirty: true }), copy(b, 2, { rev: 4, dirty: false }));
  assert.deepEqual(joined.sync, { rev: 4, dirty: false });
});

test("two windows: the fields of the newer revision win, and no sync stays no sync", () => {
  const s = addWord(emptySettings(), "vrtti", 1);
  // A revision that this window could not read was opened in the other one.
  const locked = { ...copy(emptySettings(), 1, { rev: 7, dirty: false }), unread: "-----BEGIN AGE ENCRYPTED FILE-----" };
  const opened = copy(s, 5, { rev: 7, dirty: false });
  assert.equal("unread" in joinCopies(locked, opened), false);
  // With no sync on the device, the entries still merge.
  const joined = joinCopies(copy(s, 1), copy(addWord(emptySettings(), "Harper", 2), 2));
  assert.deepEqual(wordList(readSettings(joined.content)), ["Harper", "vrtti"]);
  assert.equal("sync" in joined, false);
});

test("the settings record is no note: it never expires from Recent", () => {
  const old = Date.now() - RECENT_KEEP - 1000;
  const note = { kind: "scratch", closedAt: old, updatedAt: old };
  const settings = { kind: "shared-settings", closedAt: old, updatedAt: old };
  assert.equal(isRecentExpired(note), true);
  // Without this, a device with no sync would move its rules and words to
  // the Trash 30 days after the last change.
  assert.equal(isRecentExpired(settings), false);
  assert.equal(isSystemRecord(settings), true);
  assert.equal(isSystemRecord({ kind: "keyring" }), true);
  assert.equal(isSystemRecord(note), false);
  assert.equal(isSystemRecord(undefined), false);
});
