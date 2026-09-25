// @ts-check
// Language modes and the rules that pick one (architecture.md §9,
// "Language auto-detection"). Paste JSON, see JSON colors.
//
// Everything here is a pure function plus one table, with two exceptions: the
// Compartment below, and the CodeMirror extensions the table builds. Detection
// never touches the store and never touches a view, so both the editor and the
// document store can call it.
//
// Why one module and not two: `model/docs.js` needs `detectFromName` for a
// file it just opened, and the editor needs the same table to build the
// extension. Splitting the rules from the modes would put the same language
// ids in two files, where they could drift apart.

import { Compartment } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import {
  javascript,
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript";
import { html, htmlLanguage } from "@codemirror/lang-html";
import { css, cssLanguage } from "@codemirror/lang-css";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { csharp } from "@codemirror/legacy-modes/mode/clike";

// C# has no Lezer grammar, so it runs on CodeMirror's legacy stream
// tokenizer: keywords, types, strings, numbers and comments, which is what a
// pasted snippet needs. One instance for the app, like the Lezer languages
// above: a StreamLanguage is one small object, and the fence table and the
// whole-document mode share it.
//
// The legacy mode reports `true`, `false` and `null` as "atom", a tag the
// Mariana style does not color. The mapping lives here and not in the style:
// CSS value names and Markdown task markers are atoms too, and a style rule
// would paint those red as well.
const csharpLanguage = StreamLanguage.define({
  ...csharp,
  tokenTable: { atom: tags.bool },
});

// The app's default. Markdown is the right fallback for unknown text: it
// colors links, headings and fenced code, and leaves plain prose plain.
export const DEFAULT_LANG = "markdown";

// Fenced-code resolver for the Markdown mode. A plain function keeps
// @codemirror/language-data out: that package would drag in every language
// CodeMirror ships.
/** @type {Record<string, import("@codemirror/language").Language>} */
const FENCE_LANGUAGES = {
  js: javascriptLanguage,
  javascript: javascriptLanguage,
  mjs: javascriptLanguage,
  node: javascriptLanguage,
  jsx: jsxLanguage,
  ts: typescriptLanguage,
  typescript: typescriptLanguage,
  tsx: tsxLanguage,
  html: htmlLanguage,
  css: cssLanguage,
  json: jsonLanguage,
  cs: csharpLanguage,
  csharp: csharpLanguage,
  "c#": csharpLanguage,
};

/** @param {string} info The word after the opening fence, e.g. "json". */
function resolveFenceLanguage(info) {
  return FENCE_LANGUAGES[info.toLowerCase()] || null;
}

/**
 * Language id -> whole-document mode. Built lazily, one call per state, because
 * a LanguageSupport holds a parser configuration and is not free.
 * @type {Record<string, () => import("@codemirror/state").Extension>}
 */
const MODES = {
  markdown: () => markdown({ codeLanguages: resolveFenceLanguage }),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  // No JSX in a plain .ts file: `<T>value` there is a type assertion, and the
  // JSX dialect would parse it as an unclosed tag.
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  html: () => html(),
  css: () => css(),
  json: () => json(),
  csharp: () => csharpLanguage,
};

/** Language ids a picker (command palette, settings row) may offer. */
export const LANGUAGES = Object.keys(MODES);

/** @param {string} [id] @returns {boolean} Is this a language id we can set? */
export function isLang(id) {
  return typeof id === "string" && Object.hasOwn(MODES, id);
}

/**
 * The one compartment that holds the document language. One instance for the
 * whole app is correct: a Compartment is only a key, and every EditorState
 * keeps its own content under it.
 */
export const langCompartment = new Compartment();

/**
 * @param {string} [id]
 * @returns {import("@codemirror/state").Extension} The mode, Markdown if the id
 *   is unknown (a record written by a newer build, or a typo in a command arg).
 */
export function extensionForLang(id) {
  return (isLang(id) ? MODES[/** @type {string} */ (id)] : MODES[DEFAULT_LANG])();
}

// File extension -> language id. Lower case, no leading dot.
// `txt` is here on purpose rather than falling through: it is a known
// extension with a known answer, and the answer happens to be the default.
/** @type {Record<string, string>} */
const BY_EXTENSION = {
  md: "markdown",
  markdown: "markdown",
  txt: "markdown",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  cs: "csharp",
};

/**
 * A file-backed buffer takes its language from its name, never from its text:
 * an empty .js file is still JavaScript, and a .md file that opens with `{`
 * is still Markdown.
 * @param {string} [name] File name, with or without a path in front of it.
 * @returns {string} A language id; DEFAULT_LANG for an unknown extension.
 */
export function detectFromName(name) {
  // `.age` is an envelope, not a language: `notes.md.age` is Markdown once it
  // is open (architecture.md §13.4). Stripped here rather than at the one call
  // site, because langForRecord() below re-derives the language from
  // `file.name` on every activation and would otherwise disagree with the
  // record the store wrote.
  const text = (name || "").replace(/\.age$/i, "");
  const dot = text.lastIndexOf(".");
  if (dot < 1) return DEFAULT_LANG; // no extension, or a dotfile like ".env"
  return BY_EXTENSION[text.slice(dot + 1).toLowerCase()] || DEFAULT_LANG;
}

// Enough characters to hold the longest prefix tested below.
const SNIFF_PREFIX = 16;

// A structural line of a JSON-family document: a quoted key, a bracket, or a
// comment. The prose a user quotes braces around matches almost none of these.
const JSON_ROW = /^\s*(?:"(?:[^"\\]|\\.)*"\s*:|[{}[\]]|\/\/|\/\*|\*)/;
// Or a line that ends the way object/array rows end.
const JSON_ROW_END = /[,{}[\]]\s*$/;
// Look at this many lines at most; a document declares its shape early.
const SHAPE_LINES = 40;
// How many lines must look structural. High on purpose: recoloring prose the
// user is reading is the failure mode this whole module avoids.
const SHAPE_SHARE = 0.8;

// A quoted key. Required somewhere in the text before the shape test may run:
// a brace or bracket at line start also opens a checkbox note ("[ ] buy milk")
// or a thought in braces, and those must never leave Markdown. Prose almost
// never contains `"word":`, JSON-family text almost always does.
const QUOTED_KEY = /"(?:[^"\\]|\\.)*"\s*:/;

/**
 * JSON-family shape without a successful parse: JSONC comments, trailing
 * commas, an invisible non-breaking space, or a plain typo. Real pasted
 * "JSON" is very often exactly this.
 * @param {string} text Trimmed, starts with { or [.
 * @returns {boolean}
 */
function looksJsonFamily(text) {
  if (!QUOTED_KEY.test(text)) return false;
  const lines = text
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, SHAPE_LINES);
  if (!lines.length) return false;
  const hits = lines.filter(
    (line) => JSON_ROW.test(line) || JSON_ROW_END.test(line.trimEnd())
  ).length;
  return hits / lines.length >= SHAPE_SHARE;
}

// A line end that prose does not have: a statement ends with `;`, a block
// opens or closes with a brace, an argument list breaks after `(` or `,`, a
// lambda body follows `=>`, a `case` label ends with `:`. Prose ends with a
// period or a word. Hard-wrapped prose ends the odd line with a comma, and
// SHAPE_SHARE absorbs that.
const CODE_ROW_END = /(?:[;{}(),\]:]|=>)\s*$/;
// Or the whole line is a comment.
const CODE_COMMENT_ROW = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Does the text end its lines the way code does? This is the guard that keeps
 * a note *about* code in Markdown: prose fails it on nearly every line, so
 * the language marks below can be plain words.
 * @param {string} text Trimmed.
 * @returns {boolean}
 */
function codeShaped(text) {
  const lines = text.split("\n").filter((line) => line.trim());
  if (!lines.length) return false;
  const hits = lines.filter(
    (line) => CODE_ROW_END.test(line) || CODE_COMMENT_ROW.test(line)
  ).length;
  return hits / lines.length >= SHAPE_SHARE;
}

// Spellings only C# uses. Java writes `import` and `String`, TypeScript puts
// the type after the name, PHP writes `foreach ($x as $y)`, JavaScript has no
// `foreach` at all. Each mark is one line of a real snippet, so a method body
// pasted without its class still hits two of them.
const CSHARP_MARKS = [
  /^\s*using\s+(?:static\s+)?[A-Z]\w*(?:\.\w+)*\s*;/m, // using System.Threading;
  /^\s*namespace\s+[A-Z]\w*(?:\.\w+)*\s*[{;]?\s*$/m, // namespace App.Models;
  /\b(?:public|private|protected|internal)\s+(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:class|struct|record|interface|enum)\s+[A-Z]\w*/,
  /\b(?:async\s+)?(?:Task|ValueTask)(?:<[^>\n]*>)?\s+[A-Z]\w*(?:<[^>\n]*>)?\s*\(/, // async Task RunAsync<T>(
  /\bforeach\s*\(.*?\sin\s/, // foreach (var item in items)
  /\bCancellationToken\b/,
  /\{\s*get;\s*(?:(?:set|init);\s*)?\}/, // { get; set; }
  /\bConsole\.Write(?:Line)?\(/,
  /\$@?"[^"\n]*\{/, // $"Hello {name}"
  /\b(?:string|object|decimal)\??\s+[A-Za-z_]\w*\s*[=;,)]/, // string name =
];
// Two marks, not one: a lone `CancellationToken` is also a VS Code extension
// in TypeScript, and a lone `namespace` line is TypeScript too.
const CSHARP_MARKS_NEEDED = 2;

// A Markdown note is never C#, whatever its code lines say. A fence means the
// code is a quoted block inside prose, and the Markdown mode already colors
// it through FENCE_LANGUAGES. `#if` and `#region` have no space after the
// hash, so they are not headings.
const MARKDOWN_ROW = /^(?:```|~~~|#{1,6}\s)/m;

/**
 * @param {string} text Trimmed.
 * @returns {boolean} Is this a C# source file or a snippet of one?
 */
function looksCSharp(text) {
  if (MARKDOWN_ROW.test(text)) return false;
  if (!codeShaped(text)) return false;
  const hits = CSHARP_MARKS.filter((mark) => mark.test(text)).length;
  return hits >= CSHARP_MARKS_NEEDED;
}

/**
 * Content sniffing for scratch buffers. Deliberately conservative: shapes
 * that cannot be mistaken for prose, and Markdown for everything else. A wrong
 * guess is worse than no guess, because it recolors text the user is reading.
 *
 * Strict JSON gets the JSON mode. JSON-family text that fails the parse
 * (comments, trailing commas, a typo) gets the JavaScript mode instead:
 * lezer-javascript knows comments and recovers around errors, while the JSON
 * mode would paint every comment as invalid, and Markdown turns indented rows
 * into gray code blocks that read as a ghost selection (user report,
 * 2026-09-02).
 *
 * C# is the one language recognized by its words rather than its first
 * character (user report, 2026-09-25: a pasted method stayed Markdown). The
 * words alone would flip a note about C#, so the code-shape test above gates
 * them.
 *
 * @param {string} [content]
 * @returns {string} A language id.
 */
export function sniff(content) {
  const text = (content || "").trim();
  if (!text) return DEFAULT_LANG;

  const first = text[0];
  if (first === "{" || first === "[") {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      if (looksJsonFamily(text)) return "javascript";
      // A brace around prose. Fall through to Markdown.
    }
  }

  const head = text.slice(0, SNIFF_PREFIX).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "html";

  if (looksCSharp(text)) return "csharp";

  return DEFAULT_LANG;
}

/**
 * The language of one buffer record. A user choice is pinned. Everything else
 * re-derives at open: a file from its name, a scratch buffer from its text.
 * A stored "auto" lang is only a cache for the live session, so improved
 * detection rules reach old buffers on their next open instead of being
 * frozen by a guess a previous build wrote.
 * @param {import("../storage/idb.js").BufferRecord} [record]
 * @returns {string} A language id.
 */
export function langForRecord(record) {
  if (!record) return DEFAULT_LANG;
  if (record.lang && record.langSource === "user") return record.lang;
  if (record.file) return detectFromName(record.file.name);
  return sniff(record.content);
}

// How much of the document a paste must be before it may change the mode.
// Not 1.0, so pasting over a note that keeps one leftover line still counts;
// low enough that quoting a JSON snippet into a real note never flips it.
const PASTE_SHARE = 0.8;

/**
 * May this paste re-detect the language? The rule protects the common case:
 * a small paste into an existing note must never recolor the note.
 * @param {number} inserted   Characters the paste added.
 * @param {number} lengthAfter Document length once the paste landed.
 * @param {boolean} blankBefore Was the document empty or whitespace before it?
 * @returns {boolean}
 */
export function pasteDominates(inserted, lengthAfter, blankBefore) {
  if (blankBefore) return true;
  return lengthAfter > 0 && inserted / lengthAfter >= PASTE_SHARE;
}
