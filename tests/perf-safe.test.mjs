// node --test tests/*.test.mjs
// Tests for safe-phase performance guards in lang.js and crypto/age.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");
const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
const mapMatch = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
const imports = mapMatch ? JSON.parse(mapMatch[1]).imports : {};

if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(imports, specifier)) {
        const target = new URL(imports[specifier], `file://${APP_DIR}/`).href;
        return nextResolve(target, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

const {
  JSON_PARSE_LIMIT,
  PLAIN_BLOCK_LIMIT,
  PLAIN_SIZE_LIMIT,
  docHasGiantNonBlankBlock,
  langForRecord,
  plainLang,
  extensionForLang,
  shouldAutoPlain,
  sniff,
} = await import("../app/js/editor/lang.js");
const { EditorState, Text } = await import("@codemirror/state");
const { ensureSyntaxTree } = await import("@codemirror/language");
const { decorate } = await import("../app/js/editor/markdown.js");
const { countWords, countWordsInDoc } = await import("../app/js/ui/statustext.js");
const { countRecipients, encrypt, generateIdentity } = await import("../app/js/crypto/age.js");

test("countWordsInDoc matches countWords on whole docs and partial selections", () => {
  const sample = "# Weekend in Prague\n\n- passport, 2 tickets\nčesko-anglický slovník, don't stop\n";
  const doc = Text.of(sample.split("\n"));
  assert.equal(countWordsInDoc(doc), countWords(sample));
  assert.equal(countWordsInDoc(doc, 2, 35), countWords(sample.slice(2, 35)));
  assert.equal(countWordsInDoc(doc, 5, 18), countWords(sample.slice(5, 18)));
  assert.equal(countWordsInDoc(Text.empty), 0);
});

test("langForRecord maps .log, .csv, and .tsv files to plain mode", () => {
  assert.equal(langForRecord({ kind: "file", file: { name: "server.log" } }), "plain");
  assert.equal(langForRecord({ kind: "file", file: { name: "export.csv" } }), "plain");
  assert.equal(langForRecord({ kind: "file", file: { name: "table.tsv" } }), "plain");
  assert.equal(langForRecord({ kind: "file", file: { name: "notes.md" } }), "markdown");

  const plainState = EditorState.create({ doc: "hello", extensions: [extensionForLang("plain")] });
  const mdState = EditorState.create({ doc: "hello", extensions: [extensionForLang("markdown")] });
  assert.equal(plainState.facet(plainLang), true);
  assert.equal(mdState.facet(plainLang), false);
});

test("sniff classifies languages from the opening window without whole-file scans", () => {
  assert.equal(sniff('{"ok": true, "items": [1, 2, 3]}'), "json");
  const bigJson = '{"rows":[' + '{"id":1,"name":"item"},'.repeat(20000) + '{"id":2}]}';
  assert.ok(bigJson.length > 256 * 1024);
  assert.equal(sniff(bigJson), "json");
  // Truncated prefix slice of a > 256 KB JSON paste (as in detectAfterPaste)
  // must still classify as "json", not fall back to "javascript".
  const pasteSlice = bigJson.slice(0, JSON_PARSE_LIMIT + 4096);
  assert.ok(pasteSlice.length < bigJson.length);
  assert.equal(sniff(pasteSlice, bigJson.length), "json");

  const jsoncWithTrailingComma = '{\n  "foo": "bar",\n  "items": [1, 2, 3],\n}\n';
  assert.equal(sniff(jsoncWithTrailingComma, jsoncWithTrailingComma.length), "javascript");
  assert.equal(sniff("# Heading\n\nParagraph text."), "markdown");
});

test("shouldAutoPlain keeps normal multi-MB Markdown and falls back on giant contiguous blocks", () => {
  const paragraph = "Short prose line in a normal paragraph.\n".repeat(12) + "\n";
  const bigProse = paragraph.repeat(Math.ceil((PLAIN_SIZE_LIMIT + 200000) / paragraph.length));
  assert.equal(shouldAutoPlain("markdown", bigProse), false);

  const giantLog = "2026-11-24T12:00:00Z INFO request ok\n".repeat(
    Math.ceil((PLAIN_BLOCK_LIMIT + 4096) / 37)
  );
  assert.equal(shouldAutoPlain("markdown", giantLog), true);
  assert.equal(docHasGiantNonBlankBlock(Text.of(giantLog.split("\n"))), true);

  const bigJs = "const x = 1;\n".repeat(Math.ceil((PLAIN_SIZE_LIMIT + 4096) / 13));
  assert.equal(shouldAutoPlain("javascript", bigJs), true);
  assert.equal(shouldAutoPlain("plain", giantLog), false);
});

test("countRecipients reads only the age header and matches exact recipient counts", async () => {
  const k1 = await generateIdentity();
  const k2 = await generateIdentity();

  const small = /** @type {string} */ (await encrypt("secret note", [k1.recipient, k2.recipient], { armored: true }));
  assert.equal(countRecipients(small), 2);

  const largePlain = "A".repeat(512 * 1024);
  const largeArmored = /** @type {string} */ (await encrypt(largePlain, [k1.recipient], { armored: true }));
  largeArmored.charCodeAt(0);
  const t0 = performance.now();
  let count = 0;
  for (let i = 0; i < 50; i++) count = countRecipients(largeArmored);
  const elapsed = performance.now() - t0;
  assert.equal(count, 1);
  assert.ok(elapsed < 100, `expected fast header parse across 50 calls, got ${elapsed.toFixed(2)} ms`);
});

test("firstLineTitle scans without splitting lines and finds titles past > 4 KB leading whitespace", async () => {
  globalThis.window ??= /** @type {any} */ ({});
  const { firstLineTitle } = await import("../app/js/model/docs.js");
  const big = "\n\n  # Shopping List for Friday  \n" + "item line\n".repeat(200000);
  big.charCodeAt(0); // materialize V8 ConsString before timing repeated calls
  const t0 = performance.now();
  let title = "";
  for (let i = 0; i < 100; i++) title = firstLineTitle(big);
  const elapsed = performance.now() - t0;
  assert.equal(title, "# Shopping List for Friday");
  assert.ok(elapsed < 100, `expected O(1) firstLineTitle across 100 calls, got ${elapsed.toFixed(2)} ms`);

  // Notes starting with > 4 KB of whitespace must still find their real title
  // so `isEmpty` / `discardEmpty` never delete them as blank notes.
  const deepLeadingBlank = " \n".repeat(3000) + "  Real note after 6 KB blank  \nbody";
  assert.equal(firstLineTitle(deepLeadingBlank), "Real note after 6 KB blank");
  assert.equal(firstLineTitle(" \t\n".repeat(2000)), "");
});

test("markdown table decorate emits column fillers for bare, leading-pipe, and quoted tables", () => {
  /** @param {string} docText */
  function fillerPositions(docText) {
    const state = EditorState.create({
      doc: docText,
      extensions: [extensionForLang("markdown")],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const decos = decorate({
      state,
      visibleRanges: [{ from: 0, to: state.doc.length }],
    });
    /** @type {number[]} */
    const positions = [];
    decos.between(0, state.doc.length, (from, to) => {
      if (from === to) positions.push(from);
    });
    return positions;
  }

  // Bare GFM table: row 1 cell 0 ("x ") and separator ("--") pad at their closing pipes (2, 8).
  const bare = "x | y\n--|--\n3333 | 4";
  const barePos = fillerPositions(bare);
  assert.deepEqual(barePos, [bare.indexOf("| y"), bare.indexOf("|--")]);

  // Leading-pipe GFM table: column 0 max is " cccccc " (8), column 1 max is " bbbb " (6).
  // Row 1 pads col 0 (at 4), row 2 pads both cols (at 17 and 21), row 3 pads col 1 (at 36).
  const piped = "| a | bbbb |\n|---|---|\n| cccccc | d |";
  assert.deepEqual(fillerPositions(piped), [4, 17, 21, 36]);

  // Blockquote-nested leading-pipe GFM table must traverse through Blockquote
  // and align columns identically.
  const quoted = "> | a | bbbb |\n> |---|---|\n> | cccccc | d |";
  assert.equal(fillerPositions(quoted).length, 4);

  // List-nested GFM table must traverse through BulletList / ListItem too.
  const listed = "- | a | bbbb |\n  |---|---|\n  | cccccc | d |";
  assert.equal(fillerPositions(listed).length, 4);
});

