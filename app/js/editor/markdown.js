// @ts-check
// Markdown that reads well as plain text (architecture.md §9, "Markdown
// marks and tables"). Two parts, both view-only: the document text is never
// touched.
//
//  1. Marks get a look of their own. The Lezer grammar gives every mark (`-`,
//     `1.`, `#`, `>`, `*`) the one tag `processingInstruction`, so a theme can
//     only paint them all alike. The marks below split them the way Sublime's
//     Markdown scopes do, and editor/editor.js colors each one.
//  2. Tables line up. The font is monospace, so a table is a grid as soon as
//     every pipe of a column lands on the same character column. A view
//     plugin measures each column and draws a filler widget before every
//     short cell's pipe: spaces in a cell, dashes in the delimiter row. The
//     file keeps the pipes exactly where the user typed them.
//
// Two mechanisms for the marks, not one, and the grammar is the reason. A
// mark whose kind is its own node name (QuoteMark, EmphasisMark) takes a new
// tag through styleTags: a context-free rule added later replaces the
// grammar's. A mark whose kind is its parent (ListMark under BulletList or
// OrderedList, HeaderMark under a level-one heading) cannot: the rule merge
// in @lezer/highlight puts the grammar's context-free rule before any deeper
// rule, and the lookup takes the first match. Those three get a mark
// decoration from the same tree walk that aligns the tables.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { styleTags, Tag, tags } from "@lezer/highlight";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

/** @typedef {import("@codemirror/view").DecorationSet} DecorationSet */

// Children of processingInstruction: a theme that styles only the parent still
// styles all of these, and one that styles a child wins for that child.
export const marks = {
  /** `>` of a blockquote. */
  quote: Tag.define(tags.processingInstruction),
  /** `*`, `_`, `~~` around emphasis. */
  emphasis: Tag.define(tags.processingInstruction),
  /** `|` in a table row, and the whole `|---|` delimiter row. */
  table: Tag.define(tags.processingInstruction),
  /** `[ ]` and `[x]` of a task item. */
  task: Tag.define(tags.processingInstruction),
};

const markStyles = styleTags({
  QuoteMark: marks.quote,
  "EmphasisMark StrikethroughMark": marks.emphasis,
  TableDelimiter: marks.table,
  TaskMarker: marks.task,
});

/**
 * Classes of the context-dependent marks (see the header). The theme in
 * editor/editor.js colors them.
 */
const MARK_CLASS = {
  /** `-`, `*`, `+` in front of a bullet item. */
  bullet: Decoration.mark({ class: "cm-md-bullet" }),
  /** `1.` or `1)` in front of a numbered item. */
  number: Decoration.mark({ class: "cm-md-number" }),
  /** The `#` run of a heading, or a setext underline. */
  heading: Decoration.mark({ class: "cm-md-heading" }),
  /** Same, for a level-one heading. Sublime gives that one its own red. */
  heading1: Decoration.mark({ class: "cm-md-heading1" }),
};

/**
 * @param {import("@lezer/common").SyntaxNodeRef} node A ListMark or HeaderMark.
 * @returns {Decoration | null}
 */
function markFor(node) {
  const parent = node.node.parent;
  if (!parent) return null;
  if (node.name === "HeaderMark") {
    const level1 = parent.name === "ATXHeading1" || parent.name === "SetextHeading1";
    return level1 ? MARK_CLASS.heading1 : MARK_CLASS.heading;
  }
  // ListMark sits in a ListItem, which sits in the list that names its kind.
  const list = parent.parent;
  if (!list) return null;
  return list.name === "OrderedList" ? MARK_CLASS.number : MARK_CLASS.bullet;
}

/**
 * One column's worth of filler before a pipe. Text, not CSS width: a dash
 * filler must look like more of the rule it extends, and `ch` would still
 * need the glyph for that. The text is view-only; a copy takes the document.
 */
class Fill extends WidgetType {
  /** @param {string} text */
  constructor(text) {
    super();
    this.text = text;
  }

  /** @param {Fill} other */
  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-table-fill";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Screen width of a cell in character cells. Code points, not UTF-16 units,
 * and a pictograph counts twice: Twemoji draws it as a square about two
 * monospace cells wide (editor/emoji.js).
 * @param {string} text
 */
function cellWidth(text) {
  let width = 0;
  for (const ch of text) width += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return width;
}

/**
 * The pipes of one table line, from the syntax tree for a cell row (where an
 * escaped `\|` is not a pipe) and by scanning for the delimiter row (one node
 * for the whole line, no children).
 * @param {import("@lezer/common").SyntaxNode} row
 * @param {string} text The row's text.
 * @param {number} from The row's start offset.
 * @returns {number[]} Absolute offsets of the pipes.
 */
function pipesOf(row, text, from) {
  const pipes = [];
  if (row.name === "TableDelimiter") {
    for (let i = 0; i < text.length; i++) if (text[i] === "|") pipes.push(from + i);
    return pipes;
  }
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") pipes.push(child.from);
  }
  return pipes;
}

/**
 * @typedef {Object} Segment
 * @property {number} column Column index, counted from the first cell.
 * @property {number} width Width of the text between the pipes.
 * @property {number} at Where the filler goes. In a cell, before the closing
 *   pipe. In the delimiter row, at the end of the dashes: before a trailing
 *   `:` so `:---:` keeps its shape, and before trailing spaces so the rule
 *   has no hole in it.
 * @property {boolean} rule True in the delimiter row: fill with dashes.
 */

/**
 * The fillable segments of one row: each stretch of text that ends in a pipe.
 * Text after the last pipe has nothing to align against, so it is not one.
 * A row that opens with a pipe has nothing before it; a row that does not
 * starts its first cell at the line start.
 * @param {import("@lezer/common").SyntaxNode} row
 * @param {import("@codemirror/state").Text} doc
 * @returns {Segment[]}
 */
function segmentsOf(row, doc) {
  const text = doc.sliceString(row.from, row.to);
  const pipes = pipesOf(row, text, row.from);
  const rule = row.name === "TableDelimiter";
  const segments = [];
  let start = row.from;
  let column = 0;
  for (const pipe of pipes) {
    const cell = doc.sliceString(start, pipe);
    // The pipe that opens the row closes no cell.
    if (!(start === row.from && !cell.trim())) {
      let at = pipe;
      if (rule) {
        const dashes = cell.trimEnd();
        at = start + dashes.length - (dashes.endsWith(":") ? 1 : 0);
      }
      segments.push({ column, width: cellWidth(cell), at, rule });
      column++;
    }
    start = pipe + 1;
  }
  return segments;
}

/**
 * Filler decorations for one table. The whole table is measured even when
 * only part of it is on screen: a column is as wide as its widest cell,
 * wherever that cell is.
 * @param {import("@lezer/common").SyntaxNode} table
 * @param {import("@codemirror/state").Text} doc
 * @returns {{ from: number, value: Decoration }[]} In document order.
 */
function fillsOf(table, doc) {
  /** @type {Segment[][]} */
  const rows = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    rows.push(segmentsOf(row, doc));
  }
  /** @type {number[]} */
  const widths = [];
  for (const row of rows) {
    for (const seg of row) widths[seg.column] = Math.max(widths[seg.column] || 0, seg.width);
  }
  const fills = [];
  for (const row of rows) {
    for (const seg of row) {
      const missing = widths[seg.column] - seg.width;
      if (missing <= 0) continue;
      const widget = new Fill((seg.rule ? "-" : " ").repeat(missing));
      fills.push({ from: seg.at, value: Decoration.widget({ widget, side: -1 }) });
    }
  }
  return fills;
}

/**
 * The mark classes and the table fillers for everything on screen.
 * @param {EditorView} view
 * @returns {DecorationSet}
 */
function decorate(view) {
  const doc = view.state.doc;
  /** @type {{ from: number, to: number, value: Decoration }[]} */
  const found = [];
  let lastTable = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Table") {
          if (node.from <= lastTable) return false; // seen from an earlier range
          lastTable = node.from;
          for (const fill of fillsOf(node.node, doc)) {
            found.push({ from: fill.from, to: fill.from, value: fill.value });
          }
          return false; // a table holds no list or heading
        }
        if (node.name !== "ListMark" && node.name !== "HeaderMark") return;
        const mark = markFor(node);
        if (mark) found.push({ from: node.from, to: node.to, value: mark });
      },
    });
  }
  // Already in document order, as the builder needs: ranges ascend, the walk
  // ascends, a table's fillers ascend and nothing else sits inside a table.
  const builder = new RangeSetBuilder();
  for (const item of found) builder.add(item.from, item.to, item.value);
  return builder.finish();
}

const markdownView = ViewPlugin.fromClass(
  class {
    /** @param {EditorView} view */
    constructor(view) {
      this.decorations = decorate(view);
    }

    /** @param {import("@codemirror/view").ViewUpdate} update */
    update(update) {
      // The tree grows in the background after a large paste, so a tree
      // change without a doc change still needs a pass.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (instance) => instance.decorations }
);

const fillTheme = EditorView.baseTheme({
  // pre, not pre-wrap: a filler of spaces must not be a place to wrap the
  // row, or the pipe it aligns ends up alone on the next visual line.
  ".cm-table-fill": { whiteSpace: "pre" },
});

/**
 * The Markdown mode: GitHub flavour (tables, task lists, strikethrough,
 * autolinks) on top of CommonMark, the mark tags above, and the view plugin.
 * @param {(info: string) => import("@codemirror/language").Language | null} codeLanguages
 * @returns {import("@codemirror/state").Extension}
 */
export function markdownMode(codeLanguages) {
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages,
      extensions: [{ props: [markStyles] }],
    }),
    markdownView,
    fillTheme,
  ];
}
