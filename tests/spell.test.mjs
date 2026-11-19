// node --test tests/*.test.mjs
// The mixed spellcheck and Czech without diacritics (.work/mixed-spellcheck/plan.md):
// the pure modules, with small fake dictionaries in place of Hunspell and Harper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnswer, MAX_VARIANTS, strip, twins } from "../app/js/editor/diacritics.js";
import { activeLangs, judge, mergeSuggestions, switchLang } from "../app/js/editor/mixed.js";

const CZECH = new Set([
  "tlačítko", "palcové", "palcově", "otevře", "menu", "list", "je", "vpravo", "dole",
  "ze", "že", "máte", "mate", "Tlačítko", "seznam",
]);
const ENGLISH = new Set(["menu", "new", "list", "settings", "the", "button", "opens", "mate"]);
const isCzech = (w) => CZECH.has(w);
const isEnglish = (w) => ENGLISH.has(w);
const ask = (langs) => ({
  czech: isCzech,
  english: isEnglish,
  twins: (w) => twins(w, isCzech),
});

test("strip maps the Czech letters only and keeps the length", () => {
  assert.equal(strip("Příliš žluťoučký kůň úpěl ďábelské ódy"), "Prilis zlutoucky kun upel dabelske ody");
  // Not a Czech letter: stays, so the check can see a model that adds it.
  assert.equal(strip("à`ü"), "à`ü");
  assert.equal(strip("tlačítko").length, "tlačítko".length);
});

test("twins finds every correct word with the same letters", () => {
  assert.deepEqual(twins("tlacitko", isCzech), ["tlačítko"]);
  assert.deepEqual(twins("palcove", isCzech).sort(), ["palcové", "palcově"]);
  assert.deepEqual(twins("Tlacitko", isCzech), ["Tlačítko"]);
  assert.deepEqual(twins("tlacitkp", isCzech), []);
  // The word itself is not its own twin.
  assert.deepEqual(twins("ze", isCzech), ["že"]);
});

test("twins skips variants that Czech never writes", () => {
  const tried = [];
  twins("dite", (w) => (tried.push(w), false));
  // ď before i, ť before e: never written, never tried.
  assert.ok(!tried.some((w) => w.includes("ď") || w.includes("ť")));
  tried.length = 0;
  twins("ukol", (w) => (tried.push(w), false));
  assert.ok(!tried.some((w) => w.startsWith("ů")), "ů is never the first letter");
  tried.length = 0;
  twins("hle", (w) => (tried.push(w), false));
  assert.ok(!tried.some((w) => w.includes("ě")), "ě never follows l");
});

test("twins gives up on a word with too many variants", () => {
  const long = "nejpravdepodobnejsimi";
  let calls = 0;
  assert.equal(twins(long, () => (calls++, false)), null);
  assert.equal(calls, 0);
  assert.ok(MAX_VARIANTS >= 512);
});

test("the example sentence of the user gets no red mark and blue marks with twins", () => {
  const langs = { cs: true, en: true };
  const verdicts = Object.fromEntries(
    "tlacitko palcove otevre menu new list settings".split(" ").map((w) => [w, judge(w, langs, ask(langs))])
  );
  assert.deepEqual(verdicts.tlacitko, { plain: ["tlačítko"] });
  assert.deepEqual(verdicts.otevre, { plain: ["otevře"] });
  assert.equal(verdicts.palcove.plain.length, 2);
  for (const w of ["menu", "new", "list", "settings"]) assert.equal(verdicts[w], "ok", w);
  assert.equal(judge("tlacitkp", langs, ask(langs)), "typo");
});

test("a language that is off does not accept its words", () => {
  const czechOnly = { cs: true, en: false };
  assert.equal(judge("settings", czechOnly, ask(czechOnly)), "typo");
  assert.equal(judge("seznam", czechOnly, ask(czechOnly)), "ok");
  const englishOnly = { cs: false, en: true };
  assert.equal(judge("seznam", englishOnly, ask(englishOnly)), "typo");
  // Without Czech there are no twins, so no blue mark either.
  assert.equal(judge("tlacitko", englishOnly, ask(englishOnly)), "typo");
});

test("an answer that is not known yet gives no mark", () => {
  const langs = { cs: true, en: true };
  assert.equal(judge("tlacitko", langs, { ...ask(langs), twins: () => null }), "pending");
  assert.equal(judge("xyzq", langs, { ...ask(langs), english: () => null }), "pending");
});

test("activeLangs and switchLang", () => {
  assert.deepEqual(activeLangs(undefined), { cs: true, en: true });
  assert.deepEqual(activeLangs([]), { cs: true, en: true });
  assert.deepEqual(activeLangs(["en"]), { cs: true, en: false });
  assert.deepEqual(switchLang(undefined, "en", false), ["en"]);
  assert.deepEqual(switchLang(["en"], "cs", false), ["cs", "en"]);
  assert.deepEqual(switchLang(["cs", "en"], "cs", true), ["en"]);
});

test("mergeSuggestions keeps the order, drops duplicates, caps at five", () => {
  assert.deepEqual(mergeSuggestions(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(mergeSuggestions(["1", "2", "3"], ["4", "5", "6"]), ["1", "2", "3", "4", "5"]);
});

test("checkAnswer accepts a model answer that only adds diacritics", () => {
  const r = checkAnswer("myslim, ze tlacitko otevre menu", "myslim, že tlačítko otevře menu\n", (w) =>
    ["že", "tlačítko", "otevře"].includes(w)
  );
  assert.equal(r?.text, "myslim, že tlačítko otevře menu");
  assert.equal(r?.changed, 3);
});

test("checkAnswer drops an answer that changes anything else", () => {
  const ok = () => true;
  assert.equal(checkAnswer("menu : new", "menu `:` new", ok), null, "an added sign");
  assert.equal(checkAnswer("ze dne", "že den", ok), null, "a changed letter");
  assert.equal(checkAnswer("že", "ze", ok), null, "a removed diacritic");
  assert.equal(checkAnswer("tlacitko", "tlačítko navíc", ok), null, "an added word");
});

test("checkAnswer keeps a word that the dictionary rejects", () => {
  const r = checkAnswer("tlacitko otevre", "tláčitko otevře", (w) => w === "otevře");
  assert.equal(r?.text, "tlacitko otevře");
  assert.equal(r?.changed, 1);
});

test("checkAnswer reads decomposed diacritics (NFD) as the same letters", () => {
  const nfd = "ze".replace("z", "ž");
  const r = checkAnswer("ze", nfd, (w) => w === "že");
  assert.equal(r?.text, "že");
});
