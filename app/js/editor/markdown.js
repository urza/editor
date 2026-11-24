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

const NON_ASCII = /[^\x20-\x7e]/;
const PICTO = /\p{Extended_Pictographic}/u;
const ROW_CACHE_LIMIT = 20000;
/** @type {Map<string, Decoration>} */
const fillDecorations = new Map();

/**
 * Reuse `Decoration.widget` instances per filler string so scrolling or typing
 * inside a thousand-row table allocates no new widgets on unchanged gaps.
 * @param {boolean} rule @param {number} missing
 */
function fillDecoration(rule, missing) {
  const key = (rule ? "-" : " ") + missing;
  let dec = fillDecorations.get(key);
  if (!dec) {
    const widget = new Fill((rule ? "-" : " ").repeat(missing));
    dec = Decoration.widget({ widget, side: -1 });
    if (fillDecorations.size < 512) fillDecorations.set(key, dec);
  }
  return dec;
}

/**
 * Screen width of a cell in character cells. Code points, not UTF-16 units,
 * and a pictograph counts twice: Twemoji draws it as a square about two
 * monospace cells wide (editor/emoji.js).
 * @param {string} text
 */
function cellWidth(text) {
  // Fast-path printable ASCII cells without per-character Unicode regex checks.
  if (!NON_ASCII.test(text)) return text.length;
  let width = 0;
  for (const ch of text) width += PICTO.test(ch) ? 2 : 1;
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

// Above 1,000 document lines, measure only the header/delimiter rows plus a
// buffer around the visible viewport so typing in large tables stays O(viewport).
const VIEWPORT_TABLE_LINE_LIMIT = 1000;
const VIEWPORT_TABLE_BUFFER_LINES = 40;

/**
 * True when `node` is a direct row (`TableHeader`, `TableRow`, or the separator
 * `TableDelimiter`) of the `Table` starting at `tableFrom`. In `@lezer/markdown`
 * every cell-separating `|` pipe inside a row is also named `TableDelimiter`
 * (with `TableHeader` / `TableRow` as parent), so checking `parent.from === tableFrom`
 * distinguishes the separator row from a pipe token.
 * @param {import("@lezer/common").SyntaxNodeRef} node
 * @param {number} tableFrom
 */
function isTableRow(node, tableFrom) {
  if (node.name !== "TableHeader" && node.name !== "TableRow" && node.name !== "TableDelimiter") {
    return false;
  }
  const parent = node.node.parent;
  return Boolean(parent && parent.name === "Table" && parent.from === tableFrom);
}

/**
 * Measure lines `[startLine, endLine]` of `table` into `widths`.
 * @param {import("@lezer/common").SyntaxNode} table
 * @param {import("@lezer/common").Tree} tree
 * @param {import("@codemirror/state").Text} doc
 * @param {number} startLine
 * @param {number} endLine
 * @param {Map<string, number[]>} lineWidths
 * @param {number[]} widths
 */
function measureLineSpan(table, tree, doc, startLine, endLine, lineWidths, widths) {
  if (startLine > endLine) return;
  // CodeMirror's `doc.iterLines(from, to)` uses an exclusive `to` line number.
  const iter = doc.iterLines(startLine, endLine + 1);
  let lineNo = startLine;
  let firstMiss = Infinity;
  let lastMiss = -1;
  while (!iter.next().done) {
    const cached = lineWidths.get(iter.value);
    if (cached) {
      for (let c = 0; c < cached.length; c++) {
        if (cached[c] > (widths[c] || 0)) widths[c] = cached[c];
      }
    } else {
      if (lineNo < firstMiss) firstMiss = lineNo;
      lastMiss = lineNo;
    }
    lineNo++;
  }
  if (lastMiss < firstMiss) return;

  const spanFrom = Math.max(table.from, doc.line(firstMiss).from);
  const spanTo = Math.min(table.to, doc.line(lastMiss).to);
  if (spanTo < spanFrom) return;
  tree.iterate({
    from: spanFrom,
    to: spanTo,
    enter: (n) => {
      if (n.to <= table.from || n.from >= table.to) return false;
      // Descend through Document, Blockquote, ListItem, and Table ancestors so
      // tables nested inside quotes or lists reach their row nodes.
      if (!isTableRow(n, table.from)) return;
      const rowLine = doc.lineAt(n.from);
      if (rowLine.number >= startLine && rowLine.number <= endLine) {
        let segWidths = lineWidths.get(rowLine.text);
        if (!segWidths) {
          segWidths = segmentsOf(n.node, doc).map((s) => s.width);
          if (lineWidths.size >= ROW_CACHE_LIMIT) lineWidths.clear();
          lineWidths.set(rowLine.text, segWidths);
        }
        for (let c = 0; c < segWidths.length; c++) {
          if (segWidths[c] > (widths[c] || 0)) widths[c] = segWidths[c];
        }
      }
      return false;
    },
  });
}

/**
 * Measure the column widths of a table. Documents up to 1,000 lines measure the
 * whole table once per `Tree` node; larger documents scope measurement to the
 * header/delimiter plus `visibleRanges` (+/- 40 lines).
 * @param {import("@lezer/common").SyntaxNode} table
 * @param {import("@lezer/common").Tree} tree
 * @param {import("@codemirror/state").Text} doc
 * @param {number} rangeFrom
 * @param {number} rangeTo
 * @param {WeakMap<object, number[]>} treeWidths
 * @param {Map<string, number[]>} lineWidths
 * @returns {number[]}
 */
function tableWidths(table, tree, doc, rangeFrom, rangeTo, treeWidths, lineWidths) {
  const firstLine = doc.lineAt(table.from).number;
  const lastLine = doc.lineAt(table.to).number;

  if (doc.lines <= VIEWPORT_TABLE_LINE_LIMIT) {
    if (table.tree) {
      const cached = treeWidths.get(table.tree);
      if (cached) return cached;
    }
    /** @type {number[]} */
    const widths = [];
    measureLineSpan(table, tree, doc, firstLine, lastLine, lineWidths, widths);
    if (table.tree) treeWidths.set(table.tree, widths);
    return widths;
  }

  /** @type {number[]} */
  const widths = [];
  const headEnd = Math.min(lastLine, firstLine + 1);
  measureLineSpan(table, tree, doc, firstLine, headEnd, lineWidths, widths);
  const visStart = Math.max(
    headEnd + 1,
    doc.lineAt(Math.max(table.from, rangeFrom)).number - VIEWPORT_TABLE_BUFFER_LINES
  );
  const visEnd = Math.min(
    lastLine,
    doc.lineAt(Math.min(table.to, rangeTo)).number + VIEWPORT_TABLE_BUFFER_LINES
  );
  measureLineSpan(table, tree, doc, visStart, visEnd, lineWidths, widths);
  return widths;
}

/**
 * Emit filler decorations only for table rows intersecting `[rangeFrom, rangeTo]`
 * via `tree.iterate` so off-screen chunks are skipped in O(log N).
 * @param {import("@lezer/common").SyntaxNode} table
 * @param {import("@lezer/common").Tree} tree
 * @param {import("@codemirror/state").Text} doc
 * @param {number[]} widths
 * @param {number} rangeFrom
 * @param {number} rangeTo
 * @param {number} minPos
 * @param {{ from: number, to: number, value: Decoration }[]} out
 * @returns {number} Updated `minPos`.
 */
function appendVisibleFills(table, tree, doc, widths, rangeFrom, rangeTo, minPos, out) {
  const clipFrom = Math.max(table.from, rangeFrom);
  const clipTo = Math.min(table.to, rangeTo);
  if (clipTo < clipFrom) return minPos;
  tree.iterate({
    from: clipFrom,
    to: clipTo,
    enter: (n) => {
      if (n.to <= table.from || n.from >= table.to) return false;
      // Return undefined on Document / Blockquote / ListItem / Table so Lezer
      // descends into ancestors; returning false at Document aborts traversal.
      if (!isTableRow(n, table.from)) return;
      if (n.to < clipFrom || n.to <= minPos) return false;
      for (const seg of segmentsOf(n.node, doc)) {
        if (seg.at < minPos) continue;
        const missing = (widths[seg.column] || 0) - seg.width;
        if (missing <= 0) continue;
        out.push({ from: seg.at, to: seg.at, value: fillDecoration(seg.rule, missing) });
        minPos = seg.at;
      }
      return false;
    },
  });
  return minPos;
}

/**
 * The mark classes and the table fillers for everything on screen.
 * @param {{ state: import("@codemirror/state").EditorState, visibleRanges: readonly { from: number, to: number }[] }} view
 * @param {WeakMap<object, number[]>} [treeWidths]
 * @param {Map<string, number[]>} [lineWidths]
 * @returns {DecorationSet}
 */
export function decorate(view, treeWidths = new WeakMap(), lineWidths = new Map()) {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  /** @type {{ from: number, to: number, value: Decoration }[]} */
  const found = [];
  let minPos = -1;
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Table") {
          const syn = node.node;
          const widths = tableWidths(syn, tree, doc, from, to, treeWidths, lineWidths);
          minPos = appendVisibleFills(syn, tree, doc, widths, from, to, minPos, found);
          return false; // a table holds no list or heading
        }
        if (node.name !== "ListMark" && node.name !== "HeaderMark") return;
        if (node.from < minPos) return;
        const mark = markFor(node);
        if (mark) {
          found.push({ from: node.from, to: node.to, value: mark });
          minPos = node.to;
        }
      },
    });
  }
  const builder = new RangeSetBuilder();
  for (const item of found) builder.add(item.from, item.to, item.value);
  return builder.finish();
}

const markdownView = ViewPlugin.fromClass(
  class {
    /** @param {EditorView} view */
    constructor(view) {
      /** @type {WeakMap<object, number[]>} */
      this.treeWidths = new WeakMap();
      /** @type {Map<string, number[]>} */
      this.lineWidths = new Map();
      this.decorations = decorate(view, this.treeWidths, this.lineWidths);
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
        this.decorations = decorate(update.view, this.treeWidths, this.lineWidths);
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
