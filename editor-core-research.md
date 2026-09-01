# Embeddable Web Editor Cores, September 2026

Research report (Opus agent, 2026-09-01). Vendoring claims were verified by fetching real URLs and measuring bytes, not by trusting docs.

## Headline answer

**Nothing beats CodeMirror 6 for this project.** No candidate matches it on the combination of viewport virtualisation, a real decoration API, and mobile support. Its only weakness is vendoring, and a verified no-npm recipe solves it.

**The strongest alternative is Ace.** It wins on vendoring ergonomics alone. Pick it only if the inline SVG emoji requirement is dropped.

---

## 1. CodeMirror 6 (baseline)

**What it is.** A modular code editor core by Marijn Haverbeke. Flat string document, numeric positions, viewport rendering.

**Maintenance: excellent, but the trail moved.** `@codemirror/view` 6.43.10 published 2026-08-31. The GitHub repos were **archived on 2026-04-15** and are read-only. Development moved to a self-hosted Forgejo at [code.haverbeke.berlin](https://code.haverbeke.berlin/codemirror/view); newest commit 2026-09-01. Anyone checking GitHub alone would wrongly call this abandoned. ProseMirror moved the same way.

**License.** MIT.

### No-npm vendoring: the real story

The official bundling docs predate import maps. Import maps now sit at **94.92% global support**, including iOS Safari 16.4+ ([caniuse](https://caniuse.com/import-maps)).

**What does NOT work (tested).** `https://cdn.jsdelivr.net/npm/codemirror@6.0.2/+esm` is a 1.5 KB re-export shim. Its full graph is 25 modules, 1.67 MB, and it pulls `@codemirror/view` at SEVEN different versions plus `@codemirror/state` at two. That reproduces the documented `instanceof` failure exactly.

**What half-works.** `https://esm.sh/codemirror@6.0.2?bundle=all` produces one self-contained file (369 KB raw / 119 KB gzip, zero external imports). But it exports only `EditorView`, `basicSetup`, `minimalSetup`. No `Decoration`, no `WidgetType`, no `EditorState`. That kills the Twemoji requirement. Also, esm.sh's server-side `/build` API is dead (returns 403, deprecated).

**What works. Two routes, both verified.**

*Route A, minified via esm.sh `?external=`.* The `?external=` flag makes esm.sh emit bare specifiers that an import map resolves to one shared instance. Measured sizes: core set (state, view, language, commands, search, autocomplete, lezer, helpers) 403 KB raw / ~135 KB gzip; plus 7 language packages 707 KB raw / ~253 KB gzip. Roughly 27 files plus one import map.

*Route B, the cleanest.* Every CodeMirror package ships a prebuilt ESM `dist/index.js` with only bare imports. Verified: `@codemirror/view@6.43.10/dist/index.js` is 491 KB unminified and imports exactly `@codemirror/state`, `crelt`, `style-mod`, `w3c-keyname`. Download the files once with curl, write an import map, done. No bundler, guaranteed single instances, readable source.

### Feature fit (verified in shipped source)

- **Large files.** The [official demo](https://codemirror.net/examples/million/) loads a few million lines. A few MB is trivial.
- **Buffers.** `EditorView.setState(newState)` exists. Hold hundreds of `EditorState` objects with no DOM, swap one view. Exactly the requirement.
- **Twemoji.** `Decoration.replace`, `Decoration.widget`, `Decoration.mark`, `WidgetType` all present. The [official decoration example](https://codemirror.net/examples/decoration/) is literally this use case: `MatchDecorator` + `Decoration.replace({widget})`, viewport-limited, with `EditorView.atomicRanges` so the caret skips the widget.
- **Spellcheck.** `Decoration.mark` over ranges, styled with a wavy underline.
- **Mobile.** Actively fixed. iOS and Android fixes landed in 6.43.9 (2026-08-16) and 6.38.5 (2025-10-07).
- **Typography.** Uses browser text layout. Proportional fonts, ligatures and bidi work. Official RTL example plus `bidiIsolates` extension exist.

**Runtime.** No framework, no workers, no AMD.

**Verdict.** The only candidate that satisfies every hard requirement. The vendoring objection does not survive testing.

---

## 2. Monaco Editor

VS Code's editor, extracted. v0.56.0 (2026-07-20), MIT, active.

**No-npm vendoring: actively deteriorating.** The AMD/CDN path is officially deprecated (0.53.0 changelog). In 0.52.2 `editor.main.js` was a self-contained 3.7 MB file. In 0.56.0 it is a 2.7 KB AMD shim pointing at content-hashed chunks (`editor-KLE6jdfb.js`). The whole `/min/vs` tree is 121 files, 14.97 MB; a minimal set is ~5.3 MB. Every upgrade rewrites the hashed filenames.

**Two disqualifiers.** Mobile: the README FAQ says supported in mobile browsers? "No." Inline emoji: `InjectedTextOptions` is text only; a maintainer-confirmed discussion (#3787) says no inline image rendering.

**Typography caveat.** Monaco caches character widths at init. A webfont that loads later misaligns the caret; no remeasure API (issue #392). Needs same-origin worker files.

**Verdict.** Powerful, but no mobile, deprecated no-bundler path, hash-churning filenames, 5 to 15 MB.

---

## 3. Ace Editor

The Cloud9 editor. `ace-builds` 1.44.0 (2026-05-11), BSD-3-Clause, active. (The GitHub Releases page is stale at 2022; use tags or npm.)

**No-npm vendoring: the best of any full editor.** `ace-builds` is a repository of prebuilt browser files with stable, unhashed names. A realistic set from `src-min-noconflict/`: `ace.js` (475 KB) + markdown, javascript, python modes + theme + searchbox = **590 KB in six flat files**. Plain script tags, no import map, no build step.

**Feature fit.** Handles large documents well. Workers are optional (`setUseWorker(false)` removes the offline problem). Mobile genuinely supported (dedicated `touch_handler.js`, sustained IME work). Squiggles work via a `"text"` marker class.

**The gaps.** Inline emoji: the marker layer paints absolutely-positioned overlay divs rebuilt via `innerHTML` (issue #3135); only a CSS background-image workaround exists. Typography: Ace requires monospace fonts; proportional fonts misplace the cursor (issue #476). Buffers: Ace creates one worker per session and does not terminate them (issue #2707); disable workers for hundreds of buffers.

**Verdict.** The easiest to vendor by hand. The right answer only if inline SVG emoji and proportional fonts are traded away.

---

## 4. Tiny overlay and contenteditable editors

Shared fatal property: every member re-tokenizes the whole document on each keystroke, and none has viewport rendering.

- **prism-code-editor** (v5.3.0, 2026-07-26, MIT, active). Best in this family. Verified esm.sh build: 4,668 bytes minified, zero external imports. Has `addOverlay()` for squiggles. Its own README states the ceiling: past ~1000 LOC it slows down on most hardware. Disqualified by the file-size requirement.
- **code-input** (v2.8.3, 2026-07-03, MIT). A `<code-input>` custom element, 22 KB + 5.5 KB CSS. Same size ceiling; viewport highlighting is only a proposal (issue #190).
- **CodeJar** (v4.3.0, MIT, last commit 2025-10-14). 17 KB single ESM file, zero imports. Best decoration story in the family (real contenteditable, an inline `<img>` just works). But a reported ~5 second freeze deleting 400 lines, and contenteditable on Android is the worst case. Perfect decorations, disqualifying performance.
- **OverType** (v2.4.0, active, MIT, ~117 KB). Markdown-only textarea-over-preview. Wrong scope for multi-language.
- **Dead:** CodeFlask (last release 2019), highlight-within-textarea (2022, jQuery). Skip.

---

## 5. Rich-text cores: all four are the wrong tool

They store a tree of typed nodes; this project stores a string. Every feature then needs a string-offset to tree-position mapper.

| Core | Latest | Date | Verdict |
|---|---|---|---|
| ProseMirror | 1.42.3 | 2026-08-25 | Only defensible one, still wrong |
| Lexical | 0.49.0 | 2026-07-30 | Disqualified on memory |
| Quill | 2.0.3 | 2024-11-30 | Stagnant and lossy |
| Trix | 2.1.19 | 2026-05-09 | A comment box |

- **ProseMirror**: best decorations of the four, but its own guide says you'll want a bundler, and it has no virtualisation. Telling detail: ProseMirror's own official example embeds CodeMirror for code blocks.
- **Lexical**: a published stress test recorded 3.9 GB memory and a crash at ~23 minutes (history plugin stores every state uncompressed). Issue #5683 reports Safari slowdown at ~400 characters. Vendoring trap: the default `dist/Lexical.mjs` references `process.env.NODE_ENV`; you must import `Lexical.prod.mjs`.
- **Quill**: easy to vendor (209 KB UMD), but Delta normalizes whitespace (tabs and trailing spaces unsafe), no release since 2024, no commits since July 2025.
- **Trix**: trivial to vendor, no highlighting, no decoration API.
- Tiptap inherits ProseMirror's problems and multiplies packages. Slate is React in practice. Editor.js is a block editor.

---

## 6. Newer options (2023-2026)

- **Arborium**: Rust tree-sitter to WASM, real parsing. Vendorable IIFE/ESM from jsDelivr, ~70 grammars. But grammars lazy-load from a CDN at runtime (offline PWA must self-host all), and each grammar embeds a full copy of the tree-sitter runtime. Demo weighs ~3 MB.
- **MicroLighter**: ~2 KB highlighter by Dave Rupert using the CSS Custom Highlight API, no spans. First release 2026-08-14, three weeks old. Promising technique, far too new to build on.
- **Shiki-based (Shikitor, ShikiCode)**: Shiki's web bundle is 3.8 MB minified and ~7x slower per highlight than Prism. Fine for a static preview pane, never for the live buffer.
- **Canvas/WebGL editors**: a dead end. No real maintained library exists. David Bushell's ["Fine, I'll build my own text editor!"](https://dbushell.com/2026/09/01/text-editor/) (2026-09-01) built and abandoned the canvas route ("entirely inaccessible"), found contenteditable unpredictable in Chromium, and landed on a textarea.
- **WASM/Rust editors**: nothing browser-embeddable and production-ready (Zed, Helix, Lapce are not embeddable).

---

## 7. Two browser primitives that changed the field

- **EditContext API**: purpose-built replacement for contenteditable; VS Code adopted it. Chromium only (Chrome 121+). No Firefox, no Safari, so no iOS. Not usable yet.
- **CSS Custom Highlight API**: style arbitrary Ranges without DOM spans. Baseline since June 2025. Allowed properties include color, background-color, text-decoration. `background-image` is ignored, and it does not work inside a textarea. Squiggles yes, Twemoji no. (Firefox may still lack text-decoration on highlights; verify.)

---

## 8. The DIY option: textarea plus highlighted overlay

Buildable, with well-documented limits, in severity order:

1. Per-keystroke full re-highlight is the hard ceiling. No DIY approach does viewport rendering. Practical range: a few hundred to ~2000 lines smooth, 5000 uncomfortable, multi-MB out.
2. Even a bare textarea degrades near ~2 MB (Mozilla bug 532998). Slowdown tracks line count.
3. Font metrics are a permanent tax: the `<pre>` and `<textarea>` must agree to the pixel on every metric, or the caret drifts from the glyphs.
4. Wrapping is the fragile case. One shifted wrap point desyncs every line below. The canonical CSS-Tricks article was updated in 2025 to avoid wrapping entirely. A markdown scratchpad wants wrapping, so this is the biggest correctness risk.
5. Undo breaks if you ever assign `.value`; mutate via `setRangeText()`.
6. Tab handling is hand-rolled, with a known naive-version selection bug.
7. Browser Ctrl+F double-matches across the hidden textarea and the visible layer.
8. Turn native `spellcheck` off; it causes input latency spikes.
9. Emoji already break monospace alignment at the font level (VS Code closed this as out of scope, issue #100730).

**Verdict.** A reasonable weekend project, a poor foundation for multi-MB buffers with inline emoji.

---

## 9. Supporting pieces (verified)

**Twemoji.** The `jdecked/twemoji` fork is alive (pushed 2026-06-01, MIT code, CC-BY 4.0 graphics). 4,009 SVG files, 9.65 MB total, ~450 bytes each. The npm package no longer ships assets; vendor from the GitHub path, e.g. `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/1f600.svg`. Subset to the emoji actually used; attribution required. Also: emoji are grapheme clusters (`"🍋‍🟩".length === 5`); segment with `Intl.Segmenter`, never string indices.

**Harper.** `harper.js` 2.7.0 (2026-07-28, Apache-2.0, active, documented CDN path). The payload is the problem: `harper_wasm_bg.wasm` is 15.5 MB raw, 7.7 MB over the wire with brotli. No official CodeMirror integration. Alternatives: `hunspell-wasm` ~811 KB (copyleft, weak maintenance), `nspell` pure JS.

---

## 10. Ranked shortlist

1. **CodeMirror 6.** Satisfies every hard requirement without a workaround: million-line demo for large files, `setState` for hundreds of buffers, an official decoration example that is literally the Twemoji use case, `Decoration.mark` for squiggles, browser text layout for typography, active mobile fixes. Vendoring: pin packages in an import map, use the prebuilt `dist/index.js` files (or esm.sh `?external=`); ~707 KB raw / ~253 KB gzip for core plus seven languages. Budget half a day for the import map, once.
2. **Ace.** Wins vendoring outright: six stable unhashed files, 590 KB, script tags. Genuinely maintained, real touch support, per-buffer `EditSession`. Costs: no clean inline SVG emoji, monospace fonts required.
3. **prism-code-editor.** Best-engineered small editor, cleanest no-npm story (4.7 KB core), mobile-sane (real textarea). Honest documented ceiling at ~1000 lines. Use only if real workloads turn out to be small snippets.

## Does anything beat CodeMirror 6 under the no-npm constraint?

**No.** The constraint disqualifies ProseMirror, Lexical and Monaco's supported path. It does not disqualify CodeMirror 6, because import maps are at ~95% support and every CodeMirror package ships browser-ready ESM. The doc line that says otherwise predates import maps.

**Two traps in current advice:** do not use `cdn.jsdelivr.net/npm/codemirror/+esm` (loads seven copies of `@codemirror/view` and breaks), and do not use esm.sh's `/build` API (deprecated, returns 403).

---

## Appendix: Monaco vs Ace deep-dive (follow-up report)

A second research pass compared Monaco and Ace in detail. Scope note: this pass covered only these two editors, so its "Ace is the right fit" verdict reads as "Ace beats Monaco". It does not overturn the overall CodeMirror 6 ranking. New facts not in the main survey:

### Monaco extras

- Exact vendoring table (v0.56.0, AMD path): `loader.js` 39 KB, `editor.main.css` 342 KB, the main editor chunk `editor-KLE6jdfb.js` **2.28 MB**, `toggleHighContrast-*.js` 1.21 MB, editor worker assets ~530 KB, ~110 language chunks ~0.5-0.7 MB. Skippable language services: `ts.worker` **6.71 MB**, `css.worker` 1 MB, `html.worker` 697 KB, `json.worker` 395 KB. Minimal set ~5.3-5.5 MB; full `/min/vs` mirror ~14-15 MB.
- Workers must be same-origin (`new Worker(url)` restriction). For an offline PWA with vendored files this is satisfied, but the service worker must cache the worker files or the editor degrades. The 0.56 AMD entry hard-codes hashed worker paths, so the vendored directory layout must be preserved exactly.
- The esm.sh shim for Monaco pulls Node polyfills (`/node/process.mjs`, `/node/buffer.mjs`). A community prebundled ESM exists: `monaco-esm` (MIT), unverified size.
- Large-file thresholds from VS Code's TextModel source: 20 MB / 300K lines before tokenization shuts off; 20,000 chars per line max tokenization; rendering stops after 10,000 chars per line.
- The realistic emoji hack: one CSS class per distinct emoji codepoint via `inlineClassName`, hide the glyph, paint the SVG as background, `inlineClassNameAffectsLetterSpacing: true`. Workable but unsupported.
- Spellcheck fit is best-in-class: `setModelMarkers` gives native squiggles with severity, hover text and overview-ruler ticks.
- Ligatures misalign Monaco's indent guides (issue #836), one more typography friction on top of the cached-width problem.

### Ace extras

- Use the **`src-min-noconflict`** build flavor, so Ace does not define a global `require`. Ace injects its own CSS from JS; no stylesheet file needed. Minimal set measured at ~582 KB (core + markdown + javascript modes + theme + searchbox); 4-6 more modes stays under ~800 KB.
- Workers exist only for some modes (javascript, json, css, html, xml, php, yaml). Markdown and plain text need none. `session.setUseWorker(false)` removes the worker, offline, and per-session-leak concerns at once.
- `ace/ext/spellcheck` is a trap. It only wires the native context menu and draws **no underline**. Squiggles need a `"text"` marker with a wavy-underline CSS class, plus `session.setAnnotations()` for gutter icons.
- Mobile nuance: no "not supported" statement anywhere, a dedicated `touch_handler.js`, and sustained IME work in the changelog. Historical Android IME complaints exist and closed without fixes. Works and is maintained, not guaranteed flawless.
- Large files: the homepage claims ~4 million lines. Community reports describe hangs near ~2 MB during initial load (indicative, not documented). Test the worst-case file.
- For emoji, a custom highlighter token class plus CSS background-image beats a custom `MarkerRenderer`, because token spans survive Ace's `innerHTML` marker-layer rebuilds.
- Buffers: `ace.createEditSession()` + `editor.setSession()` preserves undo history, scroll position and selection per session.
- Caution: the `ace-builds` GitHub Releases page is stale (shows v1.5.0 from 2022). Use the tags page or the CDN.
- Ace's RTL selection is broken (Wikimedia bug T141395), one more typography limit next to the monospace requirement.

## Appendix: rich-text cores deep-dive (follow-up report)

A second research pass examined the rich-text cores in depth. Same verdict (all four are the wrong tool). New facts worth keeping:

- **ProseMirror whitespace**: solvable via `code: true` + `whitespace: "pre"` on the node spec, but only inside that node. Paste is a separate hazard; `parseFromClipboard` drops leading whitespace without a `data-pm-slice` attribute.
- **Lexical plugin fan-out**: `@lexical/code` 0.49.0 is a 1.1 KB shim depending on four more packages; every plugin follows the pattern. A no-npm setup means a hand-maintained import map over a dozen `*.prod.mjs` files. Also issue #7422: ~1 second latency per character insert in big documents.
- **Quill**: last commits July 2025, 578 open issues. The Delta whitespace mangling is issue #2459.
- **Tiptap**: v3.30.5 patched a Markdown-attribute CPU exhaustion issue. Tiptap is now the default way people consume ProseMirror, but it multiplies the package count.
- **Slate**: alive (Android IME and Korean composition fixes in 2026), but React in practice, still 0.x, 628 open issues.
- **Editor.js**: trivially vendorable UMD, but a block editor with no continuous text model.
- **A prebuilt CodeMirror repo exists**: [paul-norman/codemirror6-prebuilt](https://github.com/paul-norman/codemirror6-prebuilt) (MIT) ships single-file per-language browser bundles. Maintenance recency unverified; check the commit log before relying on it.
- **Conflict note**: this pass recommended esm.sh's server-side `build()` API, citing a 2023-era blog post. The main survey tested that API directly and it returns `403 deprecated`. The direct test wins; do not plan around `build()`.

## Appendix: tiny editors and highlighters deep-dive (follow-up report)

A third research pass covered the overlay/contenteditable family and standalone highlighters in depth. Same verdict (the family caps out near 1000-2000 lines). New facts worth keeping:

### Library details

- **prism-code-editor**: do not vendor the raw npm package (2.9 MB, all languages). Vendor the minified esm.sh modules (`/setups`, per-language files) and rewrite relative specifiers to local paths. A StackBlitz bundle builder exists as a no-local-Node alternative (WebContainers). The `cursorPosition` extension gives offset-to-pixel mapping for overlays.
- **CodeJar** now uses `contenteditable="plaintext-only"` (94.76% support, including Firefox 136+ and iOS Safari), which preserves native undo. Its inline-emoji win is structural: the visible text IS the DOM, so an inline `<img>` is simply correct, with caret, selection and wrapping flowing around it.
- **code-input** issue #115 documented 1-2 second freezes and dropped characters on mid-range Android; closed via fixes, but treat mobile as "test yourself".
- A pragmatic hybrid exists for this family: highlight up to ~1000-2000 lines, and fall back to a plain unhighlighted textarea above the threshold.
- Buffer switching in this family costs one full re-tokenize of the incoming buffer, so switch latency scales with document size.

### Standalone highlighters

- **Prism v1 is frozen.** Latest 1.30.0 (2025-03-10) accepts security PRs only; v2 is in progress and unreleased. Fastest option (0.5-0.7 ms per highlight, ~12 KB compressed with a grammar).
- **highlight.js** is the safest maintenance bet (11.12.0, 2026-08-12, BSD-3). Vendor from the `highlightjs/cdn-release` repo: `highlight.min.js` with common languages is 124.5 KB. Its auto-language-detection suits scratch buffers that have no filename.
- **Shiki** can skip its WASM entirely via `createJavaScriptRegexEngine()` (needs the ES2024 RegExp `v` flag for full coverage). Still ~7x slower than Prism and 280 KB+ compressed minimum. Preview pane only.
- **web-tree-sitter** is vendorable from GitHub releases (JS + WASM + per-language grammar WASMs), but returns a parse tree, not highlighting. You would write the highlight-query renderer yourself. Weeks of work; not recommended.
- **Lezer** outside CodeMirror is not practical; if you pull in Lezer, use CodeMirror 6 directly.

### Textarea-overlay mechanics (additions to section 8)

- Never assign `textarea.value`; it destroys native undo. Mutate via `setRangeText()` or `document.execCommand('insertText')` (deprecated but with no alternative, per w3c/editing #160).
- A `<pre>` collapses a trailing newline. Append a space when the buffer ends in `\n`, or the last line misaligns.
- Sync `scrollTop` AND `scrollLeft`, on both `onscroll` and `oninput`.
- Set `resize: none` and identical `tab-size` on both elements; disable ligatures (`font-variant-ligatures: none`) unless shaping parity is tested.
- Emoji substitution in an overlay is width-clamped: measure the platform glyph with canvas `measureText` and clamp the replacement span to that width (code-input's `special-chars` plugin demonstrates the pattern). Expect distortion for square Twemoji, and inconsistent widths for ZWJ sequences and flags.
- Native browser spellcheck cannot be fed a WASM dictionary, cannot be read back, and flags code everywhere. Disable it and draw your own squiggles (layout-neutral, safe in every design).
- RTL/bidi alignment between textarea and overlay is an untested risk in every library in this family.

## Appendix: newer options, browser APIs, spellcheck and Twemoji (follow-up report)

A fourth research pass covered everything outside the big three and the rich-text cores. Scope note: its "use prism-code-editor" bottom line excludes CodeMirror by definition of its scope. It does not overturn the overall ranking. New facts:

### Browser APIs (decision-relevant)

- **EditContext does not work on `<textarea>`.** Adopting it means abandoning the textarea entirely; this was a documented blocker in VS Code's own exploration. Chromium only; a polyfill exists but is a 4-star experiment.
- **CSS Custom Highlight also does not work on `<textarea>`**; it needs contenteditable or plain DOM text. Firefox cannot apply `text-decoration` or `text-shadow` to highlights, so a native wavy squiggle via this API fails in Firefox (background-image fallback needed). Safari has a bug where highlights vanish under `user-select: none`. None of this affects CodeMirror, which draws squiggles with ordinary CSS on decoration spans.
- **VirtualKeyboard API** is Chromium only; it does not help on iOS Safari, where the keyboard problems actually live.
- The mobile tension triangle, stated plainly: textarea gives the best mobile behavior, but Custom Highlight cannot touch it; contenteditable enables Custom Highlight but is the worst mobile substrate (see contenteditable.realerror.com, a catalogue of 312 documented contenteditable failure cases; `inputmode` is ignored on contenteditable in iOS Safari; iOS does not auto-scroll the contenteditable caret above the keyboard). CodeMirror sidesteps the triangle with its own input handling.

### Spellcheck payloads (measured)

- **harper.js 2.7.0** has an officially documented no-npm CDN path (`binaryInlined.js` + `WorkerLinter`, which runs the WASM off the main thread). Cost: `binaryInlined.js` is ~20.1 MB; the split wasm route is ~15.1 MB + 152 KB. The "slim" wasm saves only ~0.2 MB. Compressed size over the wire ~7.7 MB (from the main survey). There is no official CodeMirror integration; the glue is ours to write.
- **hunspell-wasm** is ~811 KB but tri-licensed copyleft (LGPL/GPL/MPL) with a 4-star maintenance signal. **nspell** (pure JS, MIT) vendors trivially. There is no good middle option.

### Twemoji trap

- The maintained fork is at **v17.0.3** (Unicode 17.0 / Emoji 17.0, June 2026). The **`@twemoji/svg` npm package is stuck at 15.0.0**, two majors behind. Vendor SVGs from the GitHub release or `cdn.jsdelivr.net/gh/jdecked/twemoji@<tag>/assets/svg/`, never from that npm package. (SVG counts reported as ~3,988-4,009 across passes; measure after cloning.)

### Other findings

- **OverType** constraints confirmed: monospace font required, one fixed font size, images unsupported. Its mobile story is "perfect native" because it is a real textarea.
- **Shikitor** treats CDN/no-npm use as first-class (rare), but has a bus factor of one and inherits Shiki's payload. **ShikiCode** publishes as 0.0.0 on npm and is stale; skip.
- **Caret ("lexius")** is the only EditContext-first editor found: ~32 KB, fast, Chromium-only, 1 star. Proof of concept only.
- **Cherry Markdown** (Tencent) and **Vditor** are real framework-free markdown editors with CDN builds, flagged as unexplored; Cherry is believed to embed CodeMirror 5 (unverified).
- The 2026 comparison literature publishes no rigorous multi-MB editor benchmark. All published large-file claims are unmeasured; the million-line CodeMirror demo and VS Code's TextModel thresholds are the only primary evidence found.
