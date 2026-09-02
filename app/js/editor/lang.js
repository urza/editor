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
};

/**
 * A file-backed buffer takes its language from its name, never from its text:
 * an empty .js file is still JavaScript, and a .md file that opens with `{`
 * is still Markdown.
 * @param {string} [name] File name, with or without a path in front of it.
 * @returns {string} A language id; DEFAULT_LANG for an unknown extension.
 */
export function detectFromName(name) {
  const text = name || "";
  const dot = text.lastIndexOf(".");
  if (dot < 1) return DEFAULT_LANG; // no extension, or a dotfile like ".env"
  return BY_EXTENSION[text.slice(dot + 1).toLowerCase()] || DEFAULT_LANG;
}

// Enough characters to hold the longest prefix tested below.
const SNIFF_PREFIX = 16;

/**
 * Content sniffing for scratch buffers. Deliberately conservative: two shapes
 * that cannot be mistaken for prose, and Markdown for everything else. A wrong
 * guess is worse than no guess, because it recolors text the user is reading.
 *
 * JSON.parse is the whole JSON test. A "looks like JSON" heuristic would claim
 * `{ some note in braces }`; the parser will not.
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
      // Not JSON, or not JSON yet. Fall through: half-typed JSON stays
      // Markdown until it parses, which is the conservative direction.
    }
  }

  const head = text.slice(0, SNIFF_PREFIX).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "html";

  return DEFAULT_LANG;
}

/**
 * The language of one buffer record, in priority order: a stored choice, then
 * the file name, then the text. Absent `lang` means "never detected", so an
 * old record and a fresh scratch buffer both take the sniffing path.
 * @param {import("../storage/idb.js").BufferRecord} [record]
 * @returns {string} A language id.
 */
export function langForRecord(record) {
  if (!record) return DEFAULT_LANG;
  if (record.lang) return record.lang;
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
