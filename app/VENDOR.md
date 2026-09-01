# Vendored dependencies

Vendored on **2026-09-01**. Route B from `editor-core-research.md` section 1:
prebuilt ESM files fetched with `curl` from `cdn.jsdelivr.net`, one file per
package, resolved by the import map in `index.html`.

Versions were pinned from `https://registry.npmjs.org/<package>/latest` on the
date above. Files are byte-identical to the published packages; nothing is
minified, rewritten or bundled.

Re-fetch with `python3 tools/vendor.py`. Verify with `python3 tools/check_imports.py`.

## What was NOT used (traps from the research)

- No `cdn.jsdelivr.net/npm/.../+esm` URLs. They duplicate packages at several
  versions and break `instanceof` across package boundaries.
- No `esm.sh?bundle=all`. It exports only `EditorView`/`basicSetup` and drops
  `Decoration`, `WidgetType` and `EditorState`.
- The `codemirror` meta package is not vendored at all. The extension list in
  `js/editor.js` replaces `basicSetup`.

## Pinned packages

Each file is saved as `vendor/<package>/index.js`, whatever its upstream name.

| Package | Version | Upstream ESM entry | Bytes |
|---|---|---|---|
| `@codemirror/autocomplete` | 6.20.3 | `dist/index.js` | 90,042 |
| `@codemirror/commands` | 6.11.0 | `dist/index.js` | 84,656 |
| `@codemirror/lang-css` | 6.3.1 | `dist/index.js` | 15,969 |
| `@codemirror/lang-html` | 6.4.12 | `dist/index.js` | 26,142 |
| `@codemirror/lang-javascript` | 6.2.5 | `dist/index.js` | 20,788 |
| `@codemirror/lang-markdown` | 6.5.2 | `dist/index.js` | 21,741 |
| `@codemirror/language` | 6.12.4 | `dist/index.js` | 102,129 |
| `@codemirror/search` | 6.7.2 | `dist/index.js` | 48,927 |
| `@codemirror/state` | 6.7.2 | `dist/index.js` | 147,001 |
| `@codemirror/view` | 6.43.10 | `dist/index.js` | 491,099 |
| `@lezer/common` | 1.5.2 | `dist/index.js` | 83,319 |
| `@lezer/css` | 1.3.6 | `dist/index.js` | 19,697 |
| `@lezer/highlight` | 1.2.3 | `dist/index.js` | 29,915 |
| `@lezer/html` | 1.3.13 | `dist/index.js` | 20,875 |
| `@lezer/javascript` | 1.5.4 | `dist/index.js` | 80,756 |
| `@lezer/lr` | 1.4.10 | `dist/index.js` | 71,678 |
| `@lezer/markdown` | 1.7.2 | `dist/index.js` | 86,937 |
| `@marijn/find-cluster-break` | 1.0.4 | `src/index.js` | 4,270 |
| `crelt` | 1.0.7 | `index.js` | 951 |
| `style-mod` | 4.1.3 | `src/style-mod.js` | 6,935 |
| `w3c-keyname` | 2.2.8 | `index.js` | 2,630 |

**21 packages, 21 files, 1,456,457 raw bytes (1.39 MiB).**

## Twemoji SVG assets

Vendored on **2026-09-01** for the editor's color emoji (architecture.md §10).

| Item | Value |
|---|---|
| Project | [jdecked/twemoji](https://github.com/jdecked/twemoji) (the maintained fork of Twitter's Twemoji) |
| Version | **v17.0.3** |
| Source | `https://github.com/jdecked/twemoji/archive/refs/tags/v17.0.3.tar.gz` |
| Tarball SHA-256 | `a0855654b633045ae2337537e77f1bb4361162f7fcd910e613eaab1d6d9c5fca` |
| Taken from | `assets/svg/` only |
| Placed at | `vendor/twemoji/svg/<codepoints>.svg` |
| Files | **4,009 SVG, 10,121,593 bytes (9.65 MiB)** |

Files are byte-identical to the release; nothing was minified or rewritten.
Only the SVG directory was extracted. The PNG set, the JS library and the
repository tooling are not vendored.

### Attribution (required by CC-BY 4.0)

> Graphics from [Twemoji](https://github.com/jdecked/twemoji).
> Copyright 2022–present Jason Sofonia & Justine De Caires.
> Copyright 2014–2021 Twitter, Inc and other contributors.
> Licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The graphics are CC-BY 4.0; the upstream code is MIT. No graphic was modified.

### Why the GitHub tarball and not npm

- `@twemoji/api` is the fork's own npm package, but it ships the JS library
  only (11 files). It has no assets.
- `@twemoji/svg` on npm carries SVGs, but it is a third-party re-publish
  (`boywithkeyboard/twemoji_svg`), it stops at 15.0.0, and its files are
  re-optimized. The fork's own tagged release is the source of truth.

### Not precached

`tools/gen_sw.py` skips `vendor/twemoji/`, so the precache list stays at ~40
URLs. `sw.js` caches each SVG on first use, in a cache named `vrtti-emoji`
that survives the activate cleanup. See architecture.md §10.

## Notes on the closure

- Start set: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
  `@codemirror/commands`, `@codemirror/search`, `@codemirror/lang-markdown`,
  `@codemirror/lang-javascript`.
- `@codemirror/autocomplete`, `@codemirror/lang-html`, `@codemirror/lang-css`,
  `@lezer/*`, `crelt`, `style-mod` and `w3c-keyname` arrive transitively.
- `@marijn/find-cluster-break` is a dependency of `@codemirror/state` 6.7.2 that
  the plan's expected list did not name. It is required; the graph does not
  close without it.
- Four packages do not publish `dist/index.js`. Their real ESM entry (from the
  `exports`/`module` field of their `package.json`) is in the table above:
  `crelt` and `w3c-keyname` ship a root `index.js`, `style-mod` ships
  `src/style-mod.js`, `@marijn/find-cluster-break` ships `src/index.js`.
- No vendored file contains a `sourceMappingURL` comment, so the browser makes
  no follow-up requests for missing maps.

## Deviations from `poc-plan.md`

Recorded here because this is the only durable document in the PoC.

1. **Four packages do not publish `dist/index.js`.** Their declared ESM entry was
   downloaded instead (see the table). Step 1.2 of the plan allows this.
2. **`@marijn/find-cluster-break` joined the closure.** It is a hard dependency of
   `@codemirror/state` 6.7.2 and the plan's expected package list predates it.
3. **`tools/vendor.py` exists.** The plan names only `tools/check_imports.py`.
   The fetcher drives `curl` and makes the vendoring reproducible.
4. **Fenced code resolves js, jsx, ts, tsx, html and css**, not js alone.
   `@codemirror/lang-html` and `@codemirror/lang-css` arrive transitively with
   `@codemirror/lang-markdown`, so the extra fences cost zero bytes.
5. **`.cm-cursorLayer { animation: none }`.** Sublime's `caret_style` default is
   `"solid"`, so the caret must not blink. The plan's theme list omits this.
6. **Bracket match and search panel colors.** Mariana sets
   `brackets_options: underline`, so matching brackets are underlined instead of
   boxed. The search panel is painted in the Default Dark UI colors, because the
   `searchKeymap` opens a panel that would otherwise render light.
7. **`window.vrtti` test hook** in `js/main.js`, for the Playwright checks only.
