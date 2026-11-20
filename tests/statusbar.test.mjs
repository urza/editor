// node --test tests/*.test.mjs
// The texts of the status bar (.work/mixed-spellcheck/plan.md, step 8b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, positionText, readTime, stateSign } from "../app/js/ui/statustext.js";

test("countWords counts letters and digits, with inner hyphens and apostrophes", () => {
  assert.equal(countWords("# Weekend in Prague\n\n- passport, 2 tickets"), 6);
  assert.equal(countWords("česko-anglický slovník, don't stop"), 4);
  assert.equal(countWords("**  --  >  `"), 0);
  assert.equal(countWords(""), 0);
});

test("positionText without and with a selection", () => {
  assert.equal(positionText({ line: 12, column: 8, words: 214, selections: 1 }), "Line 12, Column 8 · 214 words");
  assert.equal(positionText({ line: 1, column: 1, words: 1, selections: 1 }), "Line 1, Column 1 · 1 word");
  assert.equal(
    positionText({ line: 3, column: 1, words: 214, selections: 1, selected: { lines: 3, chars: 42, words: 9 } }),
    "3 lines, 42 characters selected · 9 words"
  );
  assert.equal(
    positionText({ line: 3, column: 1, words: 214, selections: 1, selected: { lines: 1, chars: 5, words: 1 } }),
    "5 characters selected · 1 word"
  );
  assert.equal(positionText({ line: 3, column: 1, words: 214, selections: 3 }), "3 selections");
});

test("stateSign: each line of the rule in the plan", () => {
  const base = { save: "saved", syncs: true, waiting: false, client: /** @type {const} */ ("idle") };
  assert.equal(stateSign({ ...base, save: "locked" }).text, "locked");
  assert.equal(stateSign({ ...base, save: "disk write failed" }).problem, true);
  assert.equal(stateSign({ ...base, save: "…" }).text, "…");
  assert.equal(stateSign({ ...base, waiting: true }).text, "…");
  assert.equal(stateSign({ ...base, waiting: true, client: "syncing" }).text, "…");
  assert.deepEqual(
    [stateSign({ ...base, client: "offline" }).text, stateSign({ ...base, client: "offline" }).problem],
    ["saved · offline", true]
  );
  assert.equal(stateSign({ ...base, client: "error" }).text, "saved · sync error");
  assert.equal(stateSign(base).text, "✓");
  assert.match(stateSign(base).title, /server/);
});

test("stateSign without a server: a dirty record is not waiting for anything", () => {
  // Review finding 20: with the client off, "…" would stay for ever.
  const sign = stateSign({ save: "saved", syncs: true, waiting: true, client: "off" });
  assert.equal(sign.text, "✓");
  assert.doesNotMatch(sign.title, /server/);
  assert.equal(stateSign({ save: "saved", syncs: false, waiting: false, client: "idle" }).title, "Saved on this device.");
});

test("readTime: short notices keep 1.5 s, long ones get time to read, 10 s at most", () => {
  assert.equal(readTime("copied"), 1500);
  const long = "the model did not answer; 3 words changed, 1 word needs your choice (blue mark)";
  assert.ok(readTime(long) >= 5000, String(readTime(long)));
  assert.equal(readTime("x".repeat(1000)), 10000);
});
