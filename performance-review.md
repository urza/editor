# Performance Review (`vrtti`)

This review audits `urza/editor` at commit `0bafa3a`. It covers the client PWA (`app/`), the ASP.NET Core `.NET 10` SQLite sync server (`server/Vrtti.Server/`), and the Tauri desktop shell (`src-tauri/src/`). Each finding pairs exact source lines with live benchmark data. Benchmarks ran on desktop, 4x CPU-throttled mobile (`html.phone`), simulated 3G links, and a Release sync server with up to 10,000 notes and 100,000 revisions.

This branch changes no application code. It gives a measured baseline and phased plan for follow-up performance PRs.

## Executive Summary

The app feels fast today with tens of small notes on a desktop. At larger scale, six structural bottlenecks cause visible freezes, heavy RAM growth, or broken updates.

| Area | Measured Bottleneck | Impact on User |
|---|---|---|
| Large non-blank-line files (5 MB) | **423 to 979 ms per keystroke** (Desktop); **393 ms** on 1 MB (Phone 4x) | Editor freezes on every key in logs, CSVs, or single-paragraph dumps. |
| Sidebar redraw on every keystroke | **292 ms** to open Recent (2,500 rows); **167 to 344 ms per keystroke** while open | Typing drops 10 to 20 frames per key with a drawer open or 1,000 tabs. |
| Service Worker precache (174 files) | **23.05 MB** fetched on every deploy (**120.8 s** on Fast 3G) | Exceeds the 30 s update timeout, wipes the cache, and reloads uncached. |
| Main-thread WASM spellcheck | **2,385 ms** load freeze and **1,109 ms** lint freeze on 95 KB (Phone 4x) | First typing pause hangs the phone for over two seconds; disables at 100 KB. |
| Eager full-DB load and decryption | **76.5 MB** JS heap at 5,000 small notes; **1.4 s** decrypt burst for 500 x 16 KB notes (Phone 4x) | Boot time and RAM grow linearly with vault size, risking mobile tab kills. |
| Sync server revision scans | **98.6 ms** per `GET /api/spaces` at 100k revs; **91.4%** wasted bytes on `Titles only` | Server CPU grows linearly with edit history; clients fetch bodies they discard. |

## Benchmark Environment and Live Results

Browser benchmarks ran against `app/` over local HTTP in headless Chromium (`--headless=new`) via CDP. Mobile runs emulated a `390x844` coarse-pointer viewport (`html.phone` active) with `4x` CPU throttling. Server runs used a `Release` build of `Vrtti.Server` on `.NET 10.0.404` with local SQLite WAL databases. Desktop filesystem checks mirrored `disk.rs` calls on Linux ext4 (`/tmp`).

### 1. Cold Load and Service Worker Precache

| Metric | Value | Notes |
|---|---|---|
| Cold load HTTP requests (no SW) | **133 total** (121 initial app + 12 lazy spellcheck) | Unbundled ES modules across CodeMirror, Lezer, `@noble/*`, and `app/js/`. |
| Cold load transferred size (no SW) | **7,015.6 KB** | Includes first-pass lazy spellcheck assets. |
| Cold boot to active editor (localhost) | **540.9 ms** | Empty cache, zero network latency. |
| Cold boot to active editor (Fast 3G: 1.6 Mbps, 150 ms RTT) | **15,737.7 ms (15.7 s)** | Multi-hop ES module waterfall dominates boot time. |
| Full SW precache (`app/sw-precache.js`) | **174 files, 23.05 MB** | Re-fetched atomically on every cache version change. |
| Simulated full SW precache download | **483.3 s** (Slow 3G) / **120.8 s** (Fast 3G) / **19.3 s** (10 Mbps LTE) | `capabilities.js:147` times out at **30 s**. |

Breakdown of the 23.05 MB Service Worker precache (`app/sw-precache.js`):

| Asset Group | Files | Size (MB) | Share |
|---|---:|---:|---:|
| Harper WASM and JS (`harper_wasm_slim_bg.wasm` = 15.63 MB) | 3 | 15.15 | 65.7% |
| Hunspell WASM and Czech dictionary (`index.dic` = 3.65 MB) | 10 | 4.52 | 19.6% |
| CodeMirror and Lezer | 25 | 1.46 | 6.4% |
| App source (`js/`, `app.css`, `index.html`) | 58 | 0.99 | 4.3% |
| Crypto and `@noble/*` (includes unused curves and hashes) | 73 | 0.88 | 3.8% |
| Icons and other static assets | 5 | 0.04 | 0.2% |

### 2. Note Scale (Desktop vs Phone 4x CPU)

Spellcheck stayed off during scale runs to isolate model, storage, and UI cost. Typing latency measures keystroke insertion through two animation frames (`~33.3 ms` is the 60 Hz baseline with zero dropped frames).

| Scenario (4 KB notes; 2 KB for 10-note baseline) | Reload Boot | JS Heap | DOM Nodes | Typing Paint (p50 / p95) | Drawer Open | Typing w/ Drawer Open (p50 / p95) | Search Open Tabs |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 notes (Desktop) | 242.8 ms | 7.93 MB | 2,005 | 33.3 / 33.6 ms | n/a | n/a | 44.0 ms (10 files) |
| 10 notes (Phone 4x) | 559.9 ms | 8.28 MB | 2,007 | 33.3 / 34.0 ms | n/a | n/a | n/a |
| 1,000 notes, 100 open, 500 recent (Desktop) | 369.9 ms | 13.92 MB | 2,786 | 33.4 / 33.5 ms | 34.3 ms | 33.3 / 66.2 ms | 40.9 ms (100 files) |
| 1,000 notes, 100 open, 500 recent (Phone 4x) | 908.2 ms | 27.80 MB | 4,958 | 33.5 / 34.7 ms | n/a | n/a | n/a |
| 5,000 notes, 200 open, 2,500 recent, 1k stubs (Desktop) | 529.7 ms | 36.56 MB | 8,346 | 33.3 / 33.6 ms | **291.7 ms** | **166.6 / 344.2 ms** | 40.7 ms (200 files) |
| 5,000 notes, 200 open, 2,500 recent, 1k stubs (Phone 4x) | 912.6 ms | **76.49 MB** | 8,299 | 34.1 / **44.9 ms** | n/a | n/a | n/a |
| 1,000 open tabs (Desktop) | 373.7 ms | 18.47 MB | **23,716** | **49.8 / 66.8 ms** | n/a | n/a | 45.7 ms (1,000 files) |
| 500 encrypted notes x 4 KB (Desktop, `warmPreviews`) | 299.7 ms | 19.45 MB | 2,742 | +151.9 ms decrypt | n/a | n/a | n/a |
| 500 encrypted notes x 16 KB (Phone 4x, `warmPreviews`) | 712.2 ms | **44.85 MB** | 3,629 | **+1,404.2 ms** decrypt | 67.5 ms (400 rows) | n/a | n/a |

### 3. Big Files, Markdown Tables, and Crypto

| Workload | Platform | Open / Load | Single Edit (Dispatch / Frame) | Other Key Metrics |
|---|---|---:|---:|---|
| 100 KB note (no blank lines, default Markdown) | Desktop | 39.1 ms | 33.3 / 33.5 ms paint | IDB save 1.6 ms; `age.encrypt` 8.2 ms; `age.decrypt` 2.9 ms |
| 1 MB note (no blank lines, default Markdown) | Desktop | 105.0 ms | **114.1 / 191.7 ms** paint | IDB save **91.4 ms**; `age.encrypt` 14.8 ms; `age.decrypt` 11.3 ms |
| 1 MB note (no blank lines, default Markdown) | Phone 4x | n/a | **355.9 / 392.9 ms** | `age.encrypt` **64.5 ms**; `age.decrypt` **51.5 ms**; `countWords` **26.7 ms**; `Ctrl+A` 19.9 / 35.6 ms |
| 5 MB log/CSV (no blank lines, default Markdown) | Desktop | **502.8 to 520.2 ms** | **423 to 449 ms / 429 to 979 ms** | `Ctrl+A` **27.7 ms dispatch / 512.7 ms frame**; `countWords` 26.0 ms; `age.encrypt` **63.0 ms**; `age.decrypt` **52.4 ms**; `countRecipients` **12.7 ms** |
| 5 MB prose (blank lines every 5 lines, Markdown) | Desktop | 32.3 ms | 4.2 to 6.8 ms / 7.6 to 33.3 ms | Proves Lezer splits work across paragraphs. |
| 5 MB log/CSV (no blank lines, parser disabled) | Desktop | **18.7 ms** | **3.1 to 6.3 ms / 16.3 to 33.6 ms** | **28x faster open** and **~100x faster dispatch** than default Markdown. |
| 5.2 MB JSON (`sniff()`) | Desktop | n/a | n/a | Valid JSON **4.9 ms**; invalid/commented JSON **18.8 ms** (~75 ms Phone 4x). |
| 1,000-row x 6-col Markdown table (63.7 KB) | Desktop | n/a | 9.0 to 11.7 ms / 33.3 ms | Recomputes all 1,000 rows on every keystroke. |
| 1,000-row x 6-col Markdown table (63.7 KB) | Phone 4x | n/a | **41.3 to 51.6 ms / 64.4 to 114.8 ms** | Drops 4 to 7 frames per keystroke in a 64 KB note. |
| 3,000-row x 6-col Markdown table (196.5 KB) | Desktop | n/a | **21.6 to 39.1 ms / 33.1 to 51.8 ms** | Drops frames on Desktop per keystroke and scroll. |

### 4. Spellcheck (Harper + Hunspell WASM on Main Thread)

| Metric | Desktop | Phone (4x CPU) |
|---|---:|---:|
| Total engine load (Harper + Hunspell + Czech dict) | **675.4 ms** | **3,321.9 ms (3.3 s)** |
| Main-thread Long Tasks during load | **465 ms**, 123 ms | **2,385 ms**, **625 ms**, 80 ms, 56 ms |
| Harper lint (10 KB English prose, 93 lints) | 95.3 ms | **429.5 ms** |
| Harper lint (50 KB English prose, 459 lints) | 120.2 ms | **810.8 ms** |
| Harper lint (95 KB English prose, 872 lints) | **226.3 ms** | **1,109.0 ms (1.1 s)** |
| Hunspell `twinsNow` (20 Czech words without diacritics) | 20.4 ms | **129.6 ms** |

### 5. Sync Server (`Vrtti.Server`, Release `.NET 10` + SQLite)

Each dataset included one `big-doc-001` note with 50 to 200 historical revisions of 512 KB each. That adds up to 100 MB of history on one note.

| Server Operation | 1k docs / 5k revs (47.4 MB DB) | 5k docs / 50k revs (323.3 MB DB) | 10k docs / 100k revs (546.4 MB DB) |
|---|---:|---:|---:|
| `GET /api/spaces` (runs every sync round) | 13.5 ms avg (28.8 max) | 47.7 ms avg (54.1 max) | **98.6 ms avg (110.7 max)** |
| `GET /api/changes?since=0&limit=200` (page 1) | 152.4 ms (897 KB) | 57.7 ms | **94.3 ms** |
| Full pull 1 space (all pages) | 263.4 ms (2 pages, 1.96 MB) | 127.2 ms (9 pages, 7.81 MB) | **396.4 ms** (17 pages, **15.11 MB**) |
| Wasted bytes for `Titles only` space pull | **93.4%** (0.13 MB kept) | **91.7%** (0.65 MB kept) | **91.4%** (1.30 MB kept) |
| `GET /api/changes` caught-up poll | 1.1 ms | 1.3 ms | 2.0 ms |
| `POST /api/docs/{id}/revisions` (4 KB) | 8.5 ms | 4.0 ms | 10.3 ms avg (43.7 max) |
| `POST /api/docs/{id}/revisions` (1 MB) | 19.6 ms | 13.3 ms | 13.4 ms |
| `GET /api/docs/big-doc-001/revisions` (history list) | 43.8 ms (53 revs) | **69.8 ms** (203 revs) | **67.2 ms** (203 revs) |

### 6. Desktop Filesystem and IPC Patterns (`src-tauri/src/disk.rs`)

| Operation Pattern | Current (`disk.rs`) | Alternative | Speedup |
|---|---:|---:|---:|
| List 5,000-file directory (`stat` every entry vs `d_type`) | **18.38 ms** | **2.78 ms** | **6.61x** (larger on NTFS/macOS/SMB) |
| Atomic write 10 KB (`sync_all` fsync vs buffered rename) | **1.34 ms** | **0.31 ms** | **4.32x** |
| Atomic write 1 MB (`sync_all` vs buffered rename) | 1.66 ms | 0.69 ms | 2.41x |
| Atomic write 5 MB (`sync_all` vs buffered rename) | 5.44 ms | 3.72 ms | 1.46x |
| JSON stringify + parse IPC overhead (1 MB / 5 MB text) | **2.71 ms / 29.81 ms** | Raw bytes (`ipc::Response`) | Removes JSON escaping and copies |

---

## Client Findings (`app/`)

### Critical

#### C1. Per-keystroke `change` cascade rebuilds the entire sidebar and scans all buffers

**Where:** `app/js/editor/editor.js:321-327`, `app/js/model/docs.js:1562-1590`, `app/js/model/docs.js:1864`, `app/js/ui/sidebar.js:1543,1630-1770,1819`, `app/js/ui/statusbar.js:210`.

**What runs on every single keystroke:**
1. `editor.js:323` calls `update.state.doc.toString()`. That flattens CodeMirror 6's rope into a new full-document string. Typing 10 keys per second in a 5 MB note allocates 50 MB per second of garbage.
2. `docs.js:1583` compares `record.content === content` across the whole string and emits `"change"`.
3. `sidebar.js:1819` runs `render()` synchronously on `"change"`. It calls `openList.replaceChildren(...)`, destroying every open tab `<li>` (6 to 8 DOM nodes, an SVG, and 4 to 5 listeners).
4. Even with drawers closed, `sidebar.js:1635-1637` calls `recentBuffers()`, `collectSpaceSections()`, and `trashed()`. `collectSpaceSections()` filters and sorts `remotes()`, `closedBuffers()`, and `closedSpaceBuffers(space)` per space. With a drawer open (2,500 Recent notes), `drawerList.replaceChildren(...)` destroys and recreates 2,500 rows on every keystroke.
5. `docs.js:1864` calls `warmPreviews()` on every `"change"`. It copies and sorts `[...openBuffers(), ...closedBuffers()]` every time.
6. `statusbar.js:210` runs `renderState()` and formats `new Date(last).toLocaleTimeString()` on every keystroke.

**Measured impact:** At 5,000 notes with the Recent drawer open, Desktop typing stalls for **166.6 ms p50 / 344.2 ms p95 per keystroke**. At 1,000 open tabs with all drawers closed, DOM nodes reach **23,716** and typing drops to **49.8 ms p50 / 66.8 ms p95**.

**Recommended fix:**
- **Stop flattening the document on every keystroke.** Mark the buffer dirty in `docs.js` with a dirty flag or edit counter. Pull `view.state.doc.toString()` only inside `persistNow()` (300 ms debounce), on note switch, or when line 1 changes.
- **Split `"change"` into scoped events.** Emit `"content-dirty"` with `{ id, titleChanged, previewChanged }` on text edits. Update only the active sidebar row when its title, preview, or dirty dot changes. Keep full list renders for structural events (`open`, `close`, `rename`, `move`, `sync`, `trash`).
- **Use keyed DOM updates and list virtualization.** Patch existing `<li>` elements in place by `data-id` instead of calling `replaceChildren(...)`. Virtualize lists above ~100 rows so the DOM holds ~40 visible rows at any vault size. Add `content-visibility: auto; contain-intrinsic-size: auto 44px;` on list rows as an immediate first step.

---

#### C2. Default Markdown mode causes 423 to 979 ms keystroke freezes on large files without blank lines

**Where:** `app/js/editor/lang.js:48,81-96`, `app/js/editor/markdown.js`, `app/vendor/@lezer/markdown/index.js:1012`.

**Root cause:** `lang.js` defines nine language modes and zero plain-text modes. `DEFAULT_LANG` is `"markdown"`. Every `.txt`, `.log`, `.csv`, `.tsv`, `.sql`, unknown extension, and untitled scratch note runs `@lezer/markdown`.

A V8 CPU profile of one keystroke in a 5 MB log file (no blank lines) showed **93.8% of 428.9 ms** inside `@lezer/markdown`. `finishLeaf()` took `64.2%` self time and `parse()` took `18.4%`. Markdown treats consecutive non-blank lines as one `Paragraph` leaf block. CodeMirror budgets parse time between blocks, but `finishLeaf()` parses an entire leaf synchronously without yielding. One keystroke in a 5 MB log or CSV invalidates that leaf and triggers a full 5 MB inline re-parse on the main thread.

**Measured impact:**
- 5 MB log/CSV in default Markdown (Desktop): **520.2 ms** open, **423 to 449 ms** dispatch, **429 to 979 ms** to paint per keystroke.
- 1 MB log/CSV in default Markdown (Phone 4x): **355.9 ms** dispatch, **392.9 ms** to paint per keystroke.
- Exact same 5 MB log/CSV with parser disabled: **18.7 ms** open (**28x faster**), **3.1 to 6.3 ms** dispatch (**~100x faster**).

**Recommended fix:**
- **Add a `"plain"` language mode** (`MODES.plain = () => []`) to `lang.js`. Map `.log`, `.csv`, and `.tsv` to `"plain"`.
- **Add a large-file guard in `editor.js` and `lang.js`.** Switch to `"plain"` automatically above a threshold (for example, `> 512 KB` total or a single paragraph/line `> 64 KB`). Show a status bar notice with a manual override. Disable `EditorView.lineWrapping` on ultra-long single lines (`> 20 KB` per line) to avoid browser wrap reflows.

---

#### C3. Startup loads all note bodies into RAM and eagerly decrypts all encrypted notes

**Where:** `app/js/storage/idb.js:413-416`, `app/js/model/docs.js:1831-1865,4124`, `app/js/editor/editor.js:425`.

**Root cause:**
1. `store.load()` calls `getAllBuffers()`. It loads every `BufferRecord` (Open, Recent, closed synced, and Trash) with full `content` strings into RAM before the first paint.
2. Every secondary window or Space Window repeats `getAllBuffers()`. Each WebView process holds a full duplicate copy of the vault.
3. `warmPreviews()` (`docs.js:1831`) decrypts every encrypted note into the in-memory `plain` Map on boot and on every `"change"` or `"unlock"`. It runs on desktop even though `.row-preview` has `display: none`. RAM holds both armored ciphertext (`1.33x`) and plaintext (`1x`) at the same time (`2.33x` plus V8 string overhead).
4. `editor.js:425` caches every opened `EditorState` in the `states` Map (rope, syntax tree, and undo history). Entries stay in RAM until the user closes the tab.

**Measured impact:**
- 5,000 small 4 KB notes on Phone 4x use **76.49 MB** JS heap and **912.6 ms** boot time.
- 500 encrypted 16 KB notes (8 MB of text) on Phone 4x use **44.85 MB** JS heap. `warmPreviews()` burns **1,404.2 ms** of main-thread CPU right after boot.
- At 5,000 notes of 30 KB (or 50 notes of 5 MB), heap passes **350 to 600 MB**. That risks background tab kills on iOS Safari and Android WebView.

**Recommended fix:**
- **Split metadata from bodies in IndexedDB.** Put lightweight metadata (`id`, `title`, `firstLine`, `preview`, timestamps, `enc`, `sync`, `file`, `lang`, `size`) in a `meta` store. Put full `content` in a `bodies` store. Read only `meta` plus the active note body on startup, and load other bodies on demand.
- **Remove eager `warmPreviews()` decryption.** Store a short preview snippet with metadata. As an alternative, decrypt only the ~15 rows in the phone viewport with a 50-entry LRU cache. Skip preview work when `.row-preview` is hidden on desktop.
- **Cap `editor.js` `states` with an LRU limit.** Keep 15 to 25 recent `EditorState` instances in RAM. Evict older clean tabs while preserving cursor and scroll offsets.

---

#### C4. Monolithic 23.05 MB Service Worker precache breaks updates on mobile networks

**Where:** `app/sw.js:8,21-22,34`, `app/tools/gen_sw.py:103`, `app/js/model/capabilities.js:147`.

**Root cause:** `sw.js` precaches all 174 files in `app/sw-precache.js` inside one versioned cache (`vrtti-<hash>`) via `cache.addAll(...)`. A one-line edit in `app.css` invalidates that cache and forces every device to re-download **23.05 MB**:
- **19.67 MB (85.3%)** is spellcheck binaries (`harper_wasm_slim_bg.wasm` at 15.63 MB, `dictionary-cs/index.dic` at 3.65 MB, `hunspell.wasm` at 812 KB). Users who turn off spellcheck or never write Czech still download both on every deploy.
- **0.88 MB across 73 files** in `vendor/noble` includes unused algorithms (`post-quantum`, `bls12-381`, `bn254`, `ed448`, `secp256k1`, `argon2`, `blake3`) and `LICENSE` files.
- `capabilities.js:147` sets a **30-second timeout** in `checkForUpdate()`. On Fast 3G (1.6 Mbps), fetching 23.05 MB takes **120.8 seconds** (4x past the timeout). The timeout fires, deletes caches, and forces an uncached reload.

**Recommended fix:**
- **Split Service Worker caches into three tiers** (matching `EMOJI_CACHE` in `sw.js:15`):
  1. `vrtti-app-<hash>`: app shell, JS, CSS, and core CodeMirror (~2.5 MB raw, ~700 KB gzipped).
  2. `vrtti-spell-<asset-hash>`: Harper WASM, Hunspell WASM, and Czech dictionary, cached lazily on spellcheck enable. Key it by asset hash so app deploys never re-fetch 19.7 MB.
  3. `vrtti-emoji`: existing on-demand Twemoji cache.
- **Prune `vendor/noble` in `app/tools/vendor_age.py` and `gen_sw.py`.** Keep only modules that `age.js` and `keyring.js` import (X25519, Ed25519, ChaCha20-Poly1305, HKDF, SHA-256, scrypt). Drop unused curves, hashes, and `LICENSE` files from `sw-precache.js`.
- **Serve Brotli or gzip compression** on static hosting. WASM and `.dic` files shrink by 65% to 75%.

---

#### C5. Main-thread WASM spellcheck freezes typing and disables itself at 100 KB

**Where:** `app/js/editor/spellcheck.js:61,207,554-560`, `app/js/editor/hunspell.js`, `app/js/editor/textlang.js:105,143-145`, `app/js/editor/adddiacritics.js:123,141,205`.

**Root cause:** `spellcheck.js:207` creates Harper's `LocalLinter` on the main UI thread instead of inside a Web Worker. Compiling 15.6 MB of Harper WASM plus 4.5 MB of Hunspell and Czech dictionaries blocks the UI completely. Because linting also blocks the main thread, `spellcheck.js:61` turns spellcheck off above `MAX_DOC_CHARS = 100_000`.

Two extra hotspots sit inside the spellcheck path:
- `textlang.js:143-145` calls `score()` twice per paragraph (once to classify, once to merge).
- `adddiacritics.js:123-144,205` calls `text.split("")` (one string per character) and runs `O(P * W)` and `O(P^2)` loops over paragraph words.

**Measured impact:**
- Desktop: **675.4 ms** load (**465 ms** single freeze); **226.3 ms** lint freeze on 95 KB English prose.
- Phone 4x: **3,321.9 ms** load with a **2,385 ms (2.4-second) UI freeze**. Linting 95 KB prose freezes the UI for **1,109.0 ms (1.1 seconds)**. `twinsNow()` takes **129.6 ms** for 20 Czech words.

**Recommended fix:**
- **Move Harper and Hunspell into one dedicated module Worker.** The app already checks worker support and runs scrypt in `crypto/unlock.worker.js`. Send document version plus changed paragraphs via `postMessage`, and discard stale lint replies.
- **Lint incrementally by paragraph or viewport.** Off-thread linting removes the 2.4 s load freeze and 1.1 s lint freeze. It also lets you lift the 100 KB `MAX_DOC_CHARS` limit.
- **Cache `score()` per paragraph in `textlang.js`.** Replace `text.split("")` in `adddiacritics.js` with index-based slicing.

---

### High

#### H1. Cold start fires 121 unbundled ES module HTTP requests across a deep waterfall

**Where:** `app/index.html` (import map), `app/js/**`, `app/vendor/**`.

**Root cause:** Zero-build ES modules keep development simple. On a cold browser load (first install or cleared cache), the browser fetches **121 initial HTTP requests**. Those requests chain across 5 to 7 dependency hops (`index.html` -> `main.js` -> `editor.js` -> `@codemirror/*` -> `@lezer/*` -> `@noble/*`).

**Measured impact:** **540.9 ms** on localhost, rising to **15,737.7 ms (15.7 s)** on Fast 3G (150 ms RTT).

**Recommended fix:**
- **Generate `<link rel="modulepreload">` tags in `index.html`** with a small Python script (like `gen_sw.py`) so the browser fetches the whole module graph in one round trip.
- **Optionally pre-bundle vendored libraries only** (`@codemirror/*` and `@noble/*` into two files). That cuts ~70 vendor requests while keeping `app/js/` zero-build and directly editable.
- **Enable HTTP/2 or HTTP/3** and immutable cache headers on versioned vendor assets.

---

#### H2. Big-file synchronous hooks: selection word count, whole-file `sniff()`, paste scan, and Markdown table layout

**Where:** `app/js/ui/statusbar.js:98,109,124`, `app/js/editor/lang.js:281-302`, `app/js/editor/editor.js:348`, `app/js/editor/markdown.js:199-244`.

**Root causes and measured impacts:**
1. **Synchronous selection word count (`statusbar.js:109`):** Every selection change calls `countWords(state.sliceDoc(main.from, main.to))` synchronously. On a 5 MB file, `Ctrl+A` takes **27.7 ms** in `dispatch` (**26.0 ms** in `countWords`) and **512.7 ms** to paint. Dragging a selection across a 1 MB file on Phone 4x runs `countWords` (**26.7 ms**) on every pointer move. Opening a 5 MB file also runs `countWords(state.doc.toString())` synchronously in a microtask (`statusbar.js:98`).
2. **Whole-file `sniff()` (`lang.js:281-302`):** Runs synchronously on note open and paste. It trims the full string and runs `JSON.parse(text)` on multi-MB JSON (**4.9 ms** valid, **18.8 ms** invalid on 5.2 MB Desktop; ~75 ms Phone 4x). `looksJsonFamily()` and `codeShaped()` split the whole file with `text.split("\n")`, and `CSHARP_MARKS` tests 10 regexes across the full text.
3. **Whole-doc paste check (`editor.js:348`):** On every paste, `!/\S/.test(before.toString())` flattens the full pre-paste document just to check if it was blank.
4. **Whole-table Markdown alignment (`markdown.js:199-244`):** Whenever any line of a Markdown table is visible, `fillsOf()` walks every row and cell of the entire table. It tests `/\p{Extended_Pictographic}/u` on every character and creates `Decoration.widget` objects for every off-screen row too. It repeats this work on every keystroke and every scroll (`viewportChanged`).
   - Measured: A **1,000-row table (64 KB)** takes **41.3 to 51.6 ms dispatch / 64.4 to 114.8 ms frame** per keystroke on Phone 4x. A **3,000-row table (196 KB)** takes **21.6 to 39.1 ms dispatch / 51.8 ms frame** even on Desktop.

**Recommended fixes:**
- **Debounce selection word count (`statusbar.js`)** by 150 ms when `main.to - main.from > 20_000`. Show char and line counts immediately, and iterate `Text.iterLines()` instead of calling `doc.toString()`.
- **Slice before sniffing (`lang.js`):** Sample only the first `16 KB` for `looksJsonFamily()`, `codeShaped()`, and `CSHARP_MARKS`. Only call `JSON.parse()` when `text.length <= 256_000`.
- **Replace `!/\S/.test(before.toString())` (`editor.js:348`)** with an early-exit loop over `before.iterLines()`. It stops at the first non-whitespace character (`O(1)` on non-blank files).
- **Bound and cache Markdown table alignment (`markdown.js:199`):**
  1. Cache column widths per table node range when `docChanged` is false so scrolling skips width calculation.
  2. Create `Decoration.widget` objects only for rows inside `view.visibleRanges`.
  3. Skip auto-alignment (or measure only 200 rows around the viewport) on tables above 500 rows.
  4. Fast-path ASCII characters (`charCodeAt(i) < 128`) before running the Unicode emoji regex.

---

#### H3. Main-thread `age` encryption/decryption during 300 ms autosave and double-scrypt unlock

**Where:** `app/js/crypto/age.js:127`, `app/js/model/docs.js:1023`, `app/js/crypto/keyring.js:196-197,404-408`.

**Root causes:**
1. **Autosave blocks the UI thread (`docs.js:1023`):** Pure-JS ChaCha20-Poly1305 encryption plus base64 armor runs on the main thread inside `persistNow()` every 300 ms after typing stops. On a 1 MB encrypted note, encryption blocks the phone UI for **64.5 ms** on every pause. On a 5 MB encrypted note, it blocks Desktop for **63.0 ms** and Phone 4x for **~260 ms**.
2. **`countRecipients()` decodes the whole ciphertext (`age.js:127`):** To count header recipients (first few hundred bytes), it base64-decodes the entire multi-MB armored file. That takes **12.7 ms** on 5 MB Desktop (~50 ms Phone 4x).
3. **Sequential double scrypt (`keyring.js:196-197,404-408`):** Passphrase setup and unlock run `scrypt(logN=18)` twice in sequence (`wrappedIdentity`, then `wrappedSigning`). That doubles unlock time (~1.3 s desktop, ~4 to 5 s phone).

**Recommended fixes:**
- **Move `age.encrypt` and `age.decrypt` above ~32 KB to a persistent Crypto Web Worker.** Transfer `Uint8Array` buffers zero-copy using the pattern in `unlock.worker.js`.
- **Slice the header in `countRecipients(armored)` (`age.js:127`).** Decode only up to the `"---"` header footer (or first 64 KB). That cuts latency from `O(N)` to `< 0.1 ms`.
- **Wrap identity and signing keys under one scrypt-derived key** in keyring v2 (one age stanza holding `{ identity, signing }`). Until v2 ships, run both scrypt decrypts in parallel across two workers.

---

#### H4. Sync client: unbatched 200-item pulls, silent 20,000-row truncation, sequential loops, and `Titles only` waste

**Where:** `app/js/sync/client.js:90,1075,1098,1116,1292,1393`, `app/js/model/backup.js:62`.

**Root causes:**
1. **Unbatched pull storm (`sync/client.js:1098`):** `for (const change of body.changes) await store.applyRemote(change)` applies 200 changes one by one. Each call opens an IDB transaction, saves workspace state, emits `"change"` (full `sidebar.render()`), and invokes `warmPreviews()`. Syncing 2,000 notes triggers **2,000 IDB transactions, 2,000 sidebar rebuilds, and 2,000 `warmPreviews()` scans**.
2. **Silent truncation at 20,000 notes (`sync/client.js:90,1075,1393`):** `MAX_PAGES = 100` (20,000 items) caps `pullSpace()` and `allNotes()`. On spaces above 20,000 notes, `space.backup` silently drops notes past 20,000 without an error.
3. **Strict concurrency = 1:** `push()`, `rewrapStubs()`, `fetchSpaceStubs()`, `reencryptStale()`, and `backup.js:writeFiles()` run one request or file at a time. On 150 ms RTT mobile links, pushing 100 dirty notes takes **15+ seconds** instead of ~2.5 seconds at concurrency 6.
4. **Bandwidth waste on `Titles only` spaces (`sync/client.js` + `docs.js:applyStub`):** Pulling a `Titles only` space fetches full note bodies from `/api/changes` and throws `change.content` away. Measured waste is **91.4% to 93.4%** of downloaded bytes (15.11 MB fetched to keep 1.30 MB of titles).

**Recommended fixes:**
- **Add `store.applyRemoteBatch(changes)`.** Commit each 200-change page in one IDB `readwrite` transaction and emit one `"change"` event at the end.
- **Pass `?content=0` on `/api/changes` for `Titles only` spaces** (paired with server finding S3). That cuts bandwidth by over 90%.
- **Remove the fixed 100-page ceiling on `allNotes()`.** Loop while `body.hasMore` is true, and stop with an error if the cursor fails to advance.
- **Add a bounded concurrency pool (4 to 6 in-flight items)** for `push()`, `rewrapStubs()`, `reencryptStale()`, and `backup.js:writeFiles()`.

---

#### H5. Search in Files blocks the UI on plaintext tabs and walks dependency directories on disk

**Where:** `app/js/ui/search.js:39,42,189,293-321,344`.

**Root causes:**
1. **No frame yielding across plaintext tabs (`search.js:344`):** `scanTabs()` awaits `store.textOf(record.id)`. Plaintext tabs resolve in a microtask and never yield to paint or user input. Searching 1,000 tabs blocks typing in the search field until all tabs finish.
2. **Whole-file `split(/\r?\n/)` per note (`search.js:189`):** Allocates a line array for every searched note even when the note contains zero matches.
3. **Eager DOM creation for hidden matches (`search.js`):** Builds DOM nodes up front for rows hidden behind `... N more`. Live per-file appends trigger repeated style and layout work.
4. **Slow folder walk (`search.js:293`):** Reads disk files one by one (concurrency = 1). It skips dotfiles (`.git`) but does not skip `node_modules`, `target`, `dist`, `build`, `vendor`, `bin`, or `obj`. Opening a code folder walks tens of thousands of dependency files over IPC.

**Recommended fixes:**
- **Pre-check with `indexOf` (or regex `.test()`) before splitting lines.** Skip `split(/\r?\n/)` on non-matching notes. Compute line numbers only around actual match offsets.
- **Yield every ~12 ms** (`setTimeout(0)` or `scheduler.yield()`) in `scanTabs()` and `walk()`. Batch DOM inserts with `DocumentFragment` every ~50 ms, and create `... N more` rows on expand.
- **Skip `node_modules`, `target`, `dist`, `bin`, `obj`, and `vendor`** by default in `walk()`. Read folder files with concurrency 8, or use a native Rust `disk_search` command on desktop (see D5).

---

### Medium and Low

#### M1. Startup sequential housekeeping, per-row `originName()` recomputation, and multi-window full-body broadcasts

- **Sequential startup housekeeping (`docs.js:4294-4297`):** `store.start()` runs `stampMissingClosedAt`, `expireOldRecent`, `emptyOldTrash`, and `discardEmpty` sequentially before opening the first note. Each modified record opens its own IDB transaction. Defer expiration and trash cleanup until after the first paint, and batch deletes in one IDB transaction.
- **`originName()` recomputes the trust graph per row (`sidebar.js:700,760`, `sync/client.js:612-637`):** On every synced row, `sync.deviceName()` calls `knownSet()` -> `knownDevices()` and parses every device key. Cache a `Map<deviceId, name>` in `sync/client.js`, and rebuild it only when `introductions` or device records change.
- **Multi-window full-body `BroadcastChannel` sends (`docs.js:282`):** Every 300 ms autosave clones the entire `record` (including a 5 MB `content`) across `BroadcastChannel` to every Space Window. Send `{ id, updatedAt, rev, metaOnly: true }` above 64 KB, and let other windows read from IDB only if they display that note.

#### M2. Layout thrashing and minor hot-path friction

- **`showDropTarget()` (`sidebar.js:1129-1140`):** Calls `getBoundingClientRect()` on every row during every `pointermove` while dragging a tab. Cache row midpoints once on `pointerdown` and scroll.
- **`keyboardRows()` (`sidebar.js:737-741`):** Reads `row.offsetParent !== null` on every row on every Arrow key press. Query only open containers directly instead of testing `offsetParent`.
- **`zoom.js:35`:** Calls `JSON.parse(localStorage.getItem(KEY))` on every note switch and twice per Ctrl+wheel tick. Parse once at module load and keep the object in memory.
- **`firstLineTitle()` (`docs.js:123-131`):** Calls `(text || "").split("\n")` on the full note body. Slice the first 1,024 characters (or scan with `indexOf("\n")`), matching `preview.js`.

---

## Sync Server Findings (`server/Vrtti.Server/`)

### S1. Missing materialized current-head table causes `O(total_revisions)` scans on every sync

**Where:** `server/Vrtti.Server/SpaceLog.cs:86`, `server/Vrtti.Server/Revisions.cs`, `server/Vrtti.Server/Db.cs`.

**Root cause:** The schema has only an append-only `revisions` table and no `documents` table for current heads. `EXPLAIN QUERY PLAN` on the 10k-doc / 100k-revision database exposed two costly plans:

1. **`SpaceLog.Of()` (`GET /api/spaces`, called on every 60 s poll per device):**
   ```text
   SCAN m USING COVERING INDEX sqlite_autoindex_members_1
   CORRELATED SCALAR SUBQUERY (revisions_space)
   CORRELATED SCALAR SUBQUERY (revisions_doc)
   ```
   SQLite scans every historical revision ever written in each space and runs a correlated `MAX(r2.seq)` lookup per row.
   - Measured: **13.5 ms** at 5k revs -> **47.7 ms** at 50k revs -> **98.6 ms** at 100k revs. At 1,000,000 historical edits, one `GET /api/spaces` poll takes **~1 second of CPU**.

2. **`Revisions.Changes()` (`GET /api/changes`):**
   ```text
   SEARCH r USING INTEGER PRIMARY KEY (rowid>?)
   CORRELATED SCALAR SUBQUERY 2 (revisions_doc)
   CORRELATED SCALAR SUBQUERY 1 (revisions_prev_space)
   CORRELATED SCALAR SUBQUERY 1 (revisions_prev_space)
   USE TEMP B-TREE FOR ORDER BY
   ```
   It ignores `revisions_space(space, seq)` and scans every revision across all spaces with `seq > $since`. It runs three correlated scalar subqueries per row, then sorts in a temp B-tree before applying `LIMIT 201`.

**Recommended fix:**
- **Add a `documents` table** updated atomically inside the same transaction as `INSERT INTO revisions`:
  ```sql
  CREATE TABLE documents (
    doc_id     TEXT PRIMARY KEY,
    space      TEXT NOT NULL,
    prev_space TEXT,
    head_seq   INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    size       INTEGER NOT NULL
  );
  CREATE INDEX documents_space_seq ON documents(space, head_seq);
  CREATE INDEX documents_prev_space_seq ON documents(prev_space, head_seq) WHERE prev_space IS NOT NULL;
  ```
- Maintain per-space `live_count` and `latest_seq` in a `spaces` table, or count rows in `documents`. That cost scales with live docs instead of total edit history.
- Serve `GET /api/changes` from `documents` joined once to `revisions` on `head_seq`. Use `documents_space_seq` with zero correlated subqueries and zero temp B-tree sorts.

---

### S2. Missing index on `members(device_id)` forces full table scans on every request

**Where:** `server/Vrtti.Server/Db.cs:122`, `server/Vrtti.Server/SpaceLog.cs:58`.

**Root cause:** `members` has `PRIMARY KEY (space, device_id)` with no index on `device_id`. `SpaceLog.Readable()` queries `WHERE device_id = $device` on every sync request. `EXPLAIN QUERY PLAN` confirmed `SCAN members` (full table scan).

**Recommended fix:** Add `CREATE INDEX IF NOT EXISTS members_device ON members(device_id, space);` as a covering index for `Readable()`.

---

### S3. Unbounded `/api/changes` response size (OOM risk) and no metadata-only mode

**Where:** `server/Vrtti.Server/Revisions.cs`, `server/Vrtti.Server/Program.cs`.

**Root cause:**
1. `/api/changes` returns up to `limit = 200` full `content` strings in one JSON payload with no byte cap. Syncing 200 notes of 2 MB allocates **>400 MB** of strings and JSON buffers for one HTTP response. That risks server OOM and mobile client crashes.
2. There is no `content=0` (or `mode=stubs`) query flag. Clients pulling `Titles only` spaces download full bodies and discard them (**91.4% to 93.4% wasted bandwidth** measured).

**Recommended fix:**
- **Add a response byte budget** (for example, `maxBytes = 4 MB` default, always returning at least 1 doc) in `Revisions.Changes()`. Stop the page early and set `hasMore = true` once the budget fills.
- **Support `?content=0`** on `/api/changes`. Skip selecting `content` from SQLite and return only `docId`, `space`, `seq`, `rev`, `meta`, `deleted`, `updatedAt`, and `size`.

---

### S4. Unnecessary full-body reads, `LENGTH(content)` overflow scans, and unbounded history growth

**Where:** `server/Vrtti.Server/Program.cs:285,328,338,355`, `server/Vrtti.Server/Revisions.cs:88,126`.

**Root causes:**
1. **`Revisions.Current(conn, id)` reads full `content`** on `POST /revisions`, `GET /revisions`, `GET /revisions/{rev}`, and `DELETE /revisions`. Only the 409 conflict path needs `content`. The normal path needs only `rev`, `space`, and `deleted`.
2. **`Revisions.History()` computes `COALESCE(LENGTH(content), 0)` (`Revisions.cs:126`):** For rows larger than one 4 KB page, `LENGTH(content)` forces SQLite to walk every overflow page of every historical revision. Measured: **67.2 to 69.8 ms** to list 203 revisions of one 512 KB note (~100 MB of overflow pages read just to return 203 integers). At 1,000 revisions of a 2 MB note, opening History scans **2 GB of disk**.
3. **Unbounded append-only `revisions` table:** Every synced edit writes a full copy of the note forever. In our benchmark, 100k x 4 KB revisions grew the DB to **546.4 MB**. Editing a 2 MB encrypted note 500 times writes **1.3 GB** permanently.

**Recommended fixes:**
- **Add `Revisions.CurrentHead(conn, id)`** to select `seq`, `rev`, `space`, `deleted`, and `meta` without `content`. Fetch `content` only inside the 409 conflict branch.
- **Store `size INTEGER NOT NULL` on insert** in `revisions` (`Encoding.UTF8.GetByteCount(content)`). `Revisions.History()` then reads `size` from the main page with zero overflow I/O (`69.8 ms` -> `< 1 ms`).
- **Add a retention and compaction job.** Keep all revisions from the last 30 days, plus daily snapshots for older history. Always keep the head revision. Pair it with `auto_vacuum = INCREMENTAL` and periodic `PRAGMA incremental_vacuum`.

---

### S5. SQLite connection overhead, `synchronous = FULL`, and missing response compression

**Where:** `server/Vrtti.Server/Db.cs:30`, `server/Vrtti.Server/Program.cs:112`.

**Root causes:**
1. **Double connection open per HTTP request:** The auth middleware (`Program.cs:112`) opens a `SqliteConnection` and runs `PRAGMA busy_timeout = 5000;` (`Db.cs:30`). Then every endpoint handler opens a second connection and runs `PRAGMA busy_timeout = 5000;` again.
2. **Suboptimal WAL pragmas:** `Db.cs` enables WAL mode but leaves `PRAGMA synchronous = FULL`. That adds extra `fsync` calls per commit compared to `PRAGMA synchronous = NORMAL` (crash-safe in WAL mode). It also keeps SQLite's small default page cache (~2 MB) and file-backed temp tables.
3. **No HTTP response compression:** Unencrypted JSON payloads (change lists, spaces, devices, plaintext notes) ship uncompressed.

**Recommended fixes:**
- **Share one request-scoped `SqliteConnection`** across auth middleware and endpoint handlers (via `HttpContext.Items` or scoped DI). Set `Default Timeout=5` in the connection string instead of running `PRAGMA busy_timeout` on every request.
- **Set WAL performance pragmas on connection open:** `PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000; PRAGMA mmap_size = 268435456;`.
- **Enable ASP.NET Core `UseResponseCompression()`** (Brotli and Gzip) for JSON metadata and plaintext responses. Skip compression on already-encrypted age payloads if CPU cost matters.

---

## Desktop Shell Findings (`src-tauri/src/`)

### D1. Blocking `fs_err` filesystem I/O runs directly on Tokio async worker threads

**Where:** `src-tauri/src/disk.rs:798-975` (`disk_list`, `disk_stat`, `disk_read`, `disk_read_bytes`, `disk_write`, `disk_rename`, `disk_prune`).

**Root cause:** Every Tauri disk command is `pub async fn`, so Tauri runs it on Tokio's async worker pool. Inside each command, the code calls blocking `fs_err` and `std::fs` I/O (`read_dir`, `metadata`, `read_to_string`, `write_all`, `sync_all`, `canonicalize`) without `spawn_blocking`. Slow disks, antivirus scans, or stalled SMB shares starve Tokio worker threads and freeze unrelated IPC calls across all windows.

**Recommended fix:** Run all filesystem code inside `tauri::async_runtime::spawn_blocking(move || ...)`. As an alternative, make these Tauri commands synchronous `fn` so Tauri dispatches them to its blocking thread pool automatically.

---

### D2. Three sequential IPC calls plus `sync_all()` (`fsync`) on every 300 ms file autosave

**Where:** `app/js/model/docs.js:1325,1367,1372`, `app/js/storage/native.js:229`, `src-tauri/src/disk.rs:496,512`.

**Root cause:** Every 300 ms file autosave performs three IPC round trips:
1. `disk_stat` IPC checks for external changes before writing.
2. `disk_write` IPC writes a temp file, calls `handle.sync_all()` (`fsync`), renames it over the target, stats the target, and returns `Written { mtime }`.
3. **`native.js:229` drops the returned `mtime`.** `docs.js:1372` then fires a **third IPC call (`disk_stat`)** to read the exact `mtime` that `disk_write` already returned.

On local ext4, `sync_all()` makes 10 KB writes **4.3x slower** (**1.34 ms** vs **0.31 ms**). On spinning disks, cloud folders (OneDrive, iCloud, Dropbox), or SMB mounts, `sync_all()` every 300 ms causes 50 to 300 ms stalls and repeated uploads.

**Recommended fix:**
- **Return and use `mtime` from `native.writeText()`.** That removes the trailing `disk_stat` IPC call right away.
- **Pass `expectedMtime` into `disk_write`.** Check external modification inside Rust right before rename to cut 3 IPC calls down to 1.
- **Throttle `sync_all()` during continuous typing.** Keep atomic temp-write + rename on every autosave. Call `sync_all()` on Ctrl+S, window blur, or every 5 seconds. Atomic rename already prevents truncated files on app crash.

---

### D3. `disk_list` calls `fs::metadata()` on every directory entry

**Where:** `src-tauri/src/disk.rs:818`.

**Root cause:** `disk_list` calls `fs::metadata(entry.path())` on every item in a directory just to check whether it is a file or folder.

**Measured impact:** On a 5,000-file directory on Linux ext4, statting every entry takes **18.38 ms** vs **2.78 ms** using `d_type` (**6.61x slower**). On Windows NTFS, macOS APFS, and network shares, the penalty is often 10x to 30x.

**Recommended fix:** Call `entry.file_type()` first (zero extra syscalls on Linux, macOS, and Windows). Call `fs::metadata(entry.path())` only when `file_type.is_symlink()` is true.

---

### D4. `disk_read` and `disk_write` serialize multi-MB text as JSON strings

**Where:** `src-tauri/src/disk.rs:859-907`, `app/js/storage/native.js`.

**Root cause:** `disk_read_bytes` (`disk.rs:878`) uses `tauri::ipc::Response` for raw binary transfer. In contrast, `disk_read` returns `Result<String, DiskError>` and `disk_write` takes `content: String`. That forces full JSON escaping, UTF-8 copying, and `JSON.parse` across the IPC bridge.

**Measured impact:** JSON stringify + parse adds **2.71 ms** on 1 MB and **29.81 ms** on 5 MB of text. It also creates a ~3x temporary memory spike in the WebView.

**Recommended fix:** Return `tauri::ipc::Response` (raw UTF-8 bytes decoded with `TextDecoder`) from `disk_read`. Accept raw `tauri::ipc::Request` bytes in `disk_write`, matching `disk_read_bytes`.

---

### D5. No native Rust folder search or OS file watcher

**Where:** `app/js/ui/search.js:293-321`, `app/js/model/docs.js:3756,4331-4333`, `app/js/model/folders.js:401`.

**Root cause:**
1. Folder search walks directories from JavaScript. It sends **two sequential IPC calls (`disk_stat` + `disk_read`) per file** to copy every file <= 2 MB into the WebView for matching.
2. External edits rely on 30-second and focus polling (`checkExternalChanges()`). That stats every open file-backed tab and refreshes open folders repeatedly even when nothing changed.

**Recommended fix:**
- **Add a `disk_search` Tauri command in Rust.** Walk directories in `spawn_blocking` (skipping `.git`, `node_modules`, and `target`) and return only matching `(path, line, col, preview)` tuples. Searching 5,000 files drops from seconds of IPC overhead to 20 to 50 ms.
- **Add OS file watching via the `notify` crate** for open file roots and folder roots. Emit debounced Tauri events to the WebView and turn off the 30-second polling timer on desktop.

---

### D6. Startup `canonicalize()` hang, pinned 80 MB update bytes, 8 s sleep threads, and unbounded debug log

**Where:** `src-tauri/src/lib.rs:221,372`, `src-tauri/src/disk.rs:325`, `src-tauri/src/update.rs:75,305`, `src-tauri/src/debug.rs:76`.

**Issues:**
1. **Startup hang (`lib.rs:221` + `disk.rs:325`):** `Disk::load()` runs synchronous `fs::canonicalize()` on every saved root inside `setup()` before showing the main window. One offline NAS or VPN mount can hang startup for 15 to 60 seconds. Load saved roots lazily or canonicalize on a background thread with a timeout.
2. **Pinned ~80 MB RAM on deferred update (`update.rs:75,305`):** Clicking "Later" leaves `Pending { bytes: Vec<u8> }` in RAM (~50 to 80 MB) until app exit. Write the installer to a temp file on disk and store its `PathBuf` instead.
3. **8-second sleeping OS thread per navigation (`lib.rs:372`):** Every `on_page_load` spawns an OS thread that sleeps 8 seconds to flush pending commands. Replace it with `tauri::async_runtime::spawn` and `tokio::time::sleep`.
4. **Unbounded debug log (`debug.rs:76`):** `window.vrttiDesktop.log` appends entries forever during long desktop sessions. Cap it as a 500-entry ring buffer.

---

## Prioritized Action Plan

### Phase 0: Immediate High-Leverage Wins (Low Risk, Small Diffs)

1. **Large-file plain mode (`lang.js`, `editor.js`):** Add `"plain"` mode and an automatic large-file/long-paragraph guard. Fixes the 423 to 979 ms/keystroke freeze (**~100x faster**).
2. **Scoped edit events (`editor.js`, `docs.js`, `sidebar.js`, `statusbar.js`):** Stop calling `doc.toString()` on every keystroke and split `"change"` so typing updates only the active row.
3. **Markdown table cache (`markdown.js`):** Cache column widths across scrolls and build fill widgets only for visible rows. Fixes 64 to 115 ms Phone 4x table lag.
4. **Big-file micro-fixes (`statusbar.js`, `lang.js`, `age.js`, `docs.js`):** Debounce selection word count and slice inputs in `sniff()`, `countRecipients()`, and `firstLineTitle()`.
5. **Server quick wins (`Db.cs`, `Program.cs`, `Revisions.cs`):** Add `members(device_id, space)` index, add `CurrentHead()`, and store a `size` column on insert. Share one SQLite connection per request, enable `PRAGMA synchronous = NORMAL` plus cache/mmap pragmas, and turn on response compression.
6. **Desktop quick wins (`disk.rs`, `native.js`, `lib.rs`, `update.rs`, `debug.rs`):** Move `disk_*` I/O to `spawn_blocking`, use `entry.file_type()` in `disk_list`, and reuse `mtime` in `native.js`. Cap `vrttiDesktop.log`, spill pending updates to disk, and replace `std::thread::spawn` sleeps with `tokio::time::sleep`.

### Phase 1: Scale to 5,000+ Notes and Slow Phones/Networks

1. **Tiered Service Worker precache (`sw.js`, `gen_sw.py`, `vendor_age.py`):** Split app shell (~2.5 MB) from lazy content-hashed spellcheck binaries (19.7 MB) and prune unused `@noble/*` files. Fixes the 120.8 s Fast 3G update timeout.
2. **Virtualized sidebar and keyed DOM (`sidebar.js`):** Virtualize drawers and long lists to keep DOM size near ~2,200 nodes at 10,000+ notes. Drops Recent drawer open from 292 ms to <16 ms.
3. **Split IDB `meta`/`bodies` and lazy previews (`idb.js`, `docs.js`, `editor.js`):** Load metadata and the active note on boot. Remove eager `warmPreviews()`, and add an LRU cap on `EditorState`.
4. **Batched sync and `?content=0` stubs (`sync/client.js`, `Revisions.cs`):** Apply 200-item pages in one IDB transaction and drop `MAX_PAGES`. Add concurrency 4 to 6 on push/rewrap/backup, and fetch `?content=0` for `Titles only` spaces to save >91% bandwidth.
5. **Materialized `documents` table and byte cap (`Db.cs`, `SpaceLog.cs`, `Revisions.cs`):** Keep `GET /api/spaces` and `GET /api/changes` fast as edit history grows. Cap `/api/changes` at ~4 MB per page to prevent OOM spikes.

### Phase 2: Background Workers, Native Desktop I/O, and Long-Term History

1. **Off-thread spellcheck Worker (`spellcheck.js`, `hunspell.js`):** Move Harper and Hunspell WASM into a module Worker. Removes the 2.4 s Phone 4x load freeze, removes 1.1 s lint freezes, and lifts the 100 KB cap.
2. **Off-thread crypto Worker (`crypto/age.js`, `keyring.js`):** Run `age` crypto above 32 KB in a Worker to remove 65 to 260 ms autosave stutters. Unify scrypt wrapping in keyring v2 to halve unlock time.
3. **Faster Search and native desktop watch (`search.js`, `src-tauri/src/disk.rs`):** Yield during tab search, skip `node_modules`/`target`, and add Rust `disk_search` plus `notify` file watching.
4. **Binary IPC and lazy roots (`disk.rs`, `native.js`, `lib.rs`):** Switch `disk_read`/`disk_write` to raw bytes to remove 30 ms JSON overhead on 5 MB files. Canonicalize saved roots off the startup path.
5. **Server history compaction and cold-load preload (`Revisions.cs`, `index.html`):** Add revision retention plus incremental vacuum. Add `<link rel="modulepreload">` (or two vendor bundles) to drop Fast 3G cold start from 15.7 s toward <3 s.

### Target Performance Budgets (Post-Fix Verification)

| Metric | Target |
|---|---|
| Keystroke to paint (Desktop, 5,000 notes, drawer open, or 5 MB file) | **< 16 ms** (p95) |
| Keystroke to paint (Phone 4x, 5,000 notes or 1 MB file) | **< 33 ms** (p95) |
| Startup to editable note (Phone 4x, 5,000 notes, 500 encrypted) | **< 600 ms**, JS heap **< 25 MB** |
| Service Worker app-only deploy download (Fast 3G) | **< 10 s** (well under 30 s timeout) |
| Main-thread Long Tasks during spellcheck load or lint (Phone 4x) | **0 tasks > 50 ms** |
| `GET /api/spaces` and `GET /api/changes` at 10k docs / 100k revs | **< 10 ms** (p95) |
| `GET /api/docs/{id}/revisions` (200 x 512 KB revs) | **< 5 ms** |
