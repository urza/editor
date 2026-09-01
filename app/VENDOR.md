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
| `@codemirror/lint` | 6.9.7 | `dist/index.js` | 36,579 |
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

**22 packages, 22 files, 1,493,036 raw bytes (1.42 MiB).**

`@codemirror/lint` was added on **2026-09-01** for the Harper spellcheck
(architecture.md §11), after the other 21. It was fetched by hand, at the same
URL shape `tools/vendor.py` uses, and not by re-running the script: a full run
re-pins every CodeMirror package to today's latest, which is a separate
decision from adding one package. Its dependencies (`@codemirror/state`,
`@codemirror/view` ≥ 6.42.0, `crelt`) were already in the tree and satisfy its
ranges, so the closure did not grow.

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

## Harper (spellcheck engine)

Vendored on **2026-09-01** for offline English spellcheck (architecture.md §11).

| Item | Value |
|---|---|
| Package | [`harper.js`](https://writewithharper.com) by Automattic |
| Version | **2.7.0** |
| License | Apache-2.0 |
| Source | `https://registry.npmjs.org/harper.js/-/harper.js-2.7.0.tgz` |
| Tarball SHA-256 | `834b36c30037c785dcc62cd7071fa5b7d454a38ccc0dbb1b20350cc7cd153e4f` |
| Taken from | `dist/` only, three files |
| Placed at | `vendor/harper/` |

| File | Upstream path | Bytes |
|---|---|---|
| `index.js` | `dist/index.js` | 152,404 |
| `BinaryModule-Aj1vLnwf.js` | `dist/BinaryModule-Aj1vLnwf.js` | 97,063 |
| `harper_wasm_slim_bg.wasm` | `dist/harper_wasm_slim_bg.wasm` | 15,634,488 |

**3 files, 15,883,955 bytes (15.15 MiB).** Byte-identical to the published
package; nothing was minified, renamed or rewritten.

- The hashed name `BinaryModule-Aj1vLnwf.js` is kept as published. `index.js`
  imports it by that exact name, and renaming it would mean editing a vendored
  file, which no other package here needs.
- `harper.js` is not vendored through `tools/vendor.py`: the entry it would
  pick, `dist/index.js`, is only one third of what the package needs.

### Why `harper.js` and not `harper-wasm`

`harper.js` 2.7.0 builds fine without a bundler. Its `dist/binary.js` resolves
the binary with `new URL("…", import.meta.url)`, and the public
`createBinaryModuleFromUrl(url, flavor)` takes any URL, so the vendored path
goes in explicitly and native ES modules are enough. `harper-wasm`, the
lower-level wasm-bindgen package, is still at 0.1.1 from the pre-Automattic
repository and is years behind the engine `harper.js` ships.

### Why the `slim` binary

The package ships two binaries, `harper_wasm_bg.wasm` (15.85 MB) and
`harper_wasm_slim_bg.wasm` (15.63 MB). Slim is Harper built without the typst
parser and the thesaurus; the JavaScript API is identical.

The deciding reason is the loader, not the 214 KB. For the `full` flavor,
`loadBinaryUncached` first initializes the slim glue **with the slim binary**
and only then loads the full one, inside a `try` that swallows the failure. A
`full` setup therefore either downloads and instantiates 31 MB, or relies on
the slim URL returning 404. The `slim` flavor loads exactly one binary once.

### Precached, unlike Twemoji

`tools/gen_sw.py` excludes `vendor/twemoji/` only, so the wasm is in
`sw-precache.js` and spellcheck works offline (verified: with the service
worker active and the network cut, linting still runs). This is the deliberate
opposite of the Twemoji decision: one 15 MB file the feature cannot work
without, against 4,000 small files most users never need.

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
- `js/editor/spellcheck.js` reaches Harper through a dynamic `import("harper.js")`,
  so the engine is fetched on the first lint and not at startup.
  `tools/check_imports.py` counts that specifier as used but does not resolve
  it, because vendored bundles carry Node-only branches such as `import("fs")`.
  The import map entry it points at is still checked for a missing file.

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
