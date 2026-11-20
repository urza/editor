// The file names of "Back up to a folder" (architecture.md §27), as tests.
//
//   node --test tests/*.test.mjs
//
// model/backup.js imports the disk facade, which reads `window` only when a
// picker runs; an empty window object is enough to import it in Node.

import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.window = /** @type {any} */ ({});
const { baseName, fileNames } = await import("../app/js/model/backup.js");

test("the characters Windows forbids become _", () => {
  assert.equal(baseName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(baseName("tab\there"), "tab_here");
  assert.equal(baseName("Meeting: notes"), "Meeting_ notes");
  assert.equal(baseName("ends with dots.."), "ends with dots__");
  assert.equal(baseName(""), "untitled");
  assert.equal(baseName("CON"), "CON_");
});

test("two titles that differ only in case get two names", () => {
  const names = fileNames(
    [
      { id: "aaaaaaaa-1", title: "Plan" },
      { id: "bbbbbbbb-2", title: "plan" },
      { id: "cccccccc-3", title: "Other" },
    ],
    ".md"
  );
  assert.equal(names.get("aaaaaaaa-1"), "Plan.md");
  assert.equal(names.get("bbbbbbbb-2"), "plan (bbbbbbbb).md");
  assert.equal(names.get("cccccccc-3"), "Other.md");
});

test("a second run gives the same names", () => {
  const notes = [
    { id: "x1", title: "A" },
    { id: "x2", title: "a" },
  ];
  assert.deepEqual([...fileNames(notes, ".md.age")], [...fileNames(notes, ".md.age")]);
  assert.equal(fileNames(notes, ".md.age").get("x1"), "A.md.age");
});
