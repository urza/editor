# Proof of concept plan: vrtti-editor on CodeMirror 6

Goal: prove the four risky claims from the research in one small app.
1. CodeMirror 6 vendors and runs with no npm and no Node (prebuilt dist files + import map).
2. The Sublime Mariana look reproduces faithfully in CSS/CodeMirror theme.
3. Scratch buffers autosave to IndexedDB and survive reload; closing needs no prompt.
4. Markdown + code highlighting works.

Out of scope for the PoC: PWA manifest, service worker, emoji, spellcheck, encryption, sync, LLM, virtualized sidebar, drag-drop ordering, Open Directory. Do not build any of these.

Hard constraints: no npm, no Node, no bundler, anywhere. Plain JavaScript, native ES modules. Python is allowed for dev tooling (serving, verification scripts).

Reference files (read before implementing):
- `sublime-defaults.md` — exact colors and font facts. The CSS starter block near the end is the source of truth for hex values.
- `editor-core-research.md` — section 1 explains the vendoring route ("Route B") and the traps.

## Directory layout

```
poc/
  index.html          # import map + app shell
  app.css             # layout + Mariana chrome (sidebar, statusbar)
  js/
    main.js           # app wiring: buffers, sidebar, shortcuts
    editor.js         # CodeMirror setup: extensions, theme, highlight style
    store.js          # IndexedDB wrapper
  vendor/             # vendored CodeMirror packages, one dir per package
    @codemirror/state/index.js
    @codemirror/view/index.js
    ... etc
  VENDOR.md           # manifest: package -> pinned version -> size, plus the date
```

## Step 1: vendor CodeMirror

Route B from the research. For each package, download the prebuilt ESM from jsDelivr:

```
https://cdn.jsdelivr.net/npm/<package>@<version>/dist/index.js
```

Procedure:
1. Query `https://registry.npmjs.org/<package>/latest` for the current version of each starting package. Pin it. Record all pins in `VENDOR.md`.
2. Check the package's `package.json` (`exports` / `module` field) if `dist/index.js` is not the ESM entry; download whatever the real ESM entry is, save it as `vendor/<package>/index.js`.
3. Download the file, then grep it for bare import specifiers (`from "..."` / `import "..."`). Recursively download every dependency you find until closure. Expect roughly: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/autocomplete` (pulled in transitively by lang packages), `@codemirror/lang-markdown`, `@codemirror/lang-javascript`, `@codemirror/lang-html`, `@codemirror/lang-css`, `@lezer/common`, `@lezer/highlight`, `@lezer/lr`, `@lezer/markdown`, `@lezer/javascript`, `@lezer/html`, `@lezer/css`, `style-mod`, `w3c-keyname`, `crelt`.
4. Starting packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/lang-markdown`, `@codemirror/lang-javascript`.
5. Write the import map in `index.html` mapping every bare specifier to `./vendor/<package>/index.js`. One entry per package. No versions in specifiers.

Traps (verified in research, do not "simplify" into them):
- Do NOT use `cdn.jsdelivr.net/npm/codemirror/+esm` or any `/+esm` URL. It duplicates packages and breaks `instanceof`.
- Do NOT use `esm.sh?bundle=all`. It lacks the exports we need later.
- Do not vendor the `codemirror` meta package at all. We assemble our own extension list (step 2), so `basicSetup` is not needed.

Write a small python script `poc/tools/check_imports.py` that parses every vendored file plus `js/*.js` for import specifiers and verifies each resolves through the import map to an existing file. It must exit non-zero on any miss. Run it and fix misses before browser testing.

## Step 2: editor setup (`js/editor.js`)

Assemble extensions explicitly (this replaces `basicSetup`, so we can match Sublime defaults):

- `lineNumbers()`, `highlightActiveLineGutter()` — gutter highlight ON.
- Do NOT add `highlightActiveLine()` — Sublime does not highlight the current line body (verified default).
- `history()`, `drawSelection()`, `indentOnInput()`, `bracketMatching()`.
- `EditorView.lineWrapping` — this is a notes scratchpad, wrap long lines.
- `keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap])`.
- `markdown({ codeLanguages: ... })` from `@codemirror/lang-markdown`, wired so fenced ```js blocks highlight via `@codemirror/lang-javascript`. Use the `codeLanguages` option with a small resolver function; do not pull in `@codemirror/language-data` (it drags every language).
- `syntaxHighlighting(marianaHighlight)` and the `marianaTheme` below.
- An `updateListener` extension that calls a `onDocChanged` callback (used by main.js for autosave).

### Mariana theme (`EditorView.theme`, dark: true)

Use exact hex from `sublime-defaults.md`:

- editor background `#303841`, text `#D8DEE9`.
- caret `#F9AE58` (set `caret-color` and drawSelection's `cursor-color`), 1px wide.
- selection background `rgba(89, 102, 115, 0.7)`; also set `.cm-selectionBackground`.
- gutter: background `#303841`, color `#647382` (documented approximation), active line gutter color `#D8DEE9`.
- search match highlight `#FAC761` with text `#333333`; selection match none.
- `fontFamily: Consolas, Menlo, "DejaVu Sans Mono", "Cascadia Mono", monospace`, `fontSize: 14px`. Default line-height.

### Mariana highlight style (`HighlightStyle.define` with tags from `@lezer/highlight`)

| Tag | Color / style |
|---|---|
| `tags.comment` | `#A6ACB9` |
| `tags.string` | `#99C794` |
| `tags.number` | `#F9AE58` |
| `tags.keyword` | `#C695C6` |
| `tags.operator` | `#F97B58` |
| `tags.function(tags.variableName)` | `#6699CC` (call) |
| `tags.function(tags.definition(tags.variableName))` | `#5FB4B4` (definition) |
| `tags.definition(tags.propertyName)` | `#5FB4B4` |
| `tags.typeName`, `tags.className` | `#F9AE58` |
| `tags.bool`, `tags.null` | `#EC5F66`, italic |
| `tags.tagName` | `#EC5F66` |
| `tags.attributeName` | `#C695C6` |
| `tags.heading` | bold, NO color (Sublime colors only the `#` marks; acceptable PoC simplification: bold whole heading) |
| `tags.emphasis` | italic |
| `tags.strong` | bold |
| `tags.link`, `tags.url` | `#6699CC` |
| `tags.monospace` (inline code) | background `#3E4852` |
| `tags.quote` | `#99C794` |
| `tags.invalid` | color `#F7F7F7`, background `#EC5F66` |

Export from `editor.js`: `createEditorState(content, onDocChanged)` returning an `EditorState`, and `createView(parent)` returning an `EditorView`. One view, many states (buffer switching = `view.setState(state)`).

## Step 3: storage (`js/store.js`)

Raw IndexedDB, no wrapper library. Database `vrtti`, version 1, one object store `buffers` with `keyPath: "id"`.

Buffer record: `{ id, content, closed, createdAt, updatedAt }`. `id` = `crypto.randomUUID()`. Title is NOT stored; derive it in the UI from the first non-empty line (trimmed, max 40 chars), fallback `"untitled"`.

API (all promise-based): `openDb()`, `getAllBuffers()`, `putBuffer(record)`, `deleteBuffer(id)`. Call `navigator.storage.persist()` once at startup (fire and forget, log the result).

## Step 4: app wiring (`js/main.js`)

- Layout: left sidebar (fixed 220px), editor fills the rest, thin statusbar at the bottom showing the active buffer title and a save indicator ("saved" / "…").
- Startup: open DB, load all buffers. If none exist, create one empty buffer. Build one `EditorState` per OPEN buffer lazily (create the state on first activation, keep in a `Map<id, EditorState>`). Activate the last-active buffer (`localStorage` key `vrtti.activeBuffer`, fall back to first open buffer).
- Sidebar: section "Open" lists open buffers (title + close ×). Section "Recent" lists closed buffers (click to reopen). Active buffer row highlighted with sidebar colors from `sublime-defaults.md` section 2.8: sidebar background `#22262A`, labels `#CCCCCC`, selected row `#393F46`, headings `#E6E6E6`.
- Switching buffers: store the current view state back into the Map (`view.state`), then `view.setState` the target. This preserves per-buffer undo history within the session.
- Autosave: on `onDocChanged`, debounce 300 ms, then `putBuffer` with the current content. Show "…" while dirty, "saved" after the write commits.
- Closing (the key feature): NO prompt ever. Set `closed: true`, save, remove from Open, add to Recent, activate the next open buffer (create a fresh one if none left). Reopening flips `closed: false`.
- Shortcuts on `window` keydown: `Alt+N` new buffer, `Alt+W` close active buffer. Use `event.code` (`KeyN`, `KeyW`) so keyboard layouts do not break it. `preventDefault()` on both. (Ctrl+N/Ctrl+W belong to the browser; do not try to bind them.)

Keep the whole thing frameworkless: `document.createElement`, no innerHTML for user content (titles come from buffer text; use `textContent`).

## Step 5: serve and verify

Serve: `python3 -m http.server 8080 --bind 0.0.0.0` from `poc/`. Modules do not load from `file://`.

Verification, in order:
1. Run `tools/check_imports.py` — must pass.
2. Browser check. Try installing Playwright for Python (`pip install playwright && python -m playwright install chromium`). If the sandbox blocks the browser download, fall back to: `curl` the page and every mapped module URL through the running server (all must be 200), and say clearly in the report that runtime behavior is unverified.
3. If Playwright works, verify this checklist and capture a screenshot to `poc/screenshot.png`:
   - Page loads with zero console errors.
   - Type markdown with a ```js fence; heading renders bold, fence contents show at least 3 distinct token colors.
   - Editor background is `#303841` (assert via computed style).
   - Alt+N creates a second buffer; sidebar shows 2 entries.
   - Type text, reload the page: text and active buffer are restored.
   - Alt+W closes without any dialog; buffer appears under Recent; clicking it reopens with content intact.

## Report back

Return: pinned versions table (or point to VENDOR.md), total vendored size (raw bytes), verification results per checklist item (pass/fail/unverified + why), any deviation from this plan with one-line reasoning, and any console warnings seen. Do not paste file contents into the report.
