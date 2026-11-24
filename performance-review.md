# Performance Review (`vrtti`)

This review audits `urza/editor` at commit `0bafa3a`. It covers the client PWA (`app/`), the ASP.NET Core `.NET 10` SQLite sync server (`server/Vrtti.Server/`), and the Tauri desktop shell (`src-tauri/src/`). A reproducible benchmark suite lives in `tests/perf/` (`B1` to `B9` plus `compare.mjs`).

This branch changes no application code. It delivers the audit, the `tests/perf/` harness, and a prioritized plan split into safe immediate fixes and later design discussions.

## Executive Summary

The app feels fast today with tens of small notes on a desktop. At larger scale, six bottlenecks cause visible freezes, heavy RAM growth, or broken updates.

| Area | Measured Bottleneck | Impact on User |
|---|---|---|
| Large non-blank-line files (5 MB) | **423 to 449 ms dispatch** (Desktop); **356 ms** on 1 MB (Phone 4x) | Editor freezes on every key in logs, CSVs, or single-paragraph dumps. |
| Sidebar redraw on every keystroke | **292 ms** to open Recent (2,500 rows); **167 to 344 ms** frame lag while open | Typing drops frames with a drawer open or 1,000 open tabs. |
| Service Worker precache (174 files) | **13.2 MB** on the wire (**12.1 MB / 92%** spellcheck; ~66 s on Fast 3G) | Exceeds the 30 s update timeout, wipes the cache, and reloads uncached. |
| Main-thread WASM spellcheck | **2,385 ms** load freeze and **1,109 ms** lint freeze on 95 KB (Phone 4x) | First typing pause hangs the phone over two seconds; shuts off at 100 KB. |
| Eager full-DB load and decryption | **76.5 MB** JS heap at 5,000 small notes; **1.4 s** decrypt burst for 500 x 16 KB notes (Phone 4x) | Boot time and RAM grow linearly with vault size, risking mobile tab kills. |
| Sync server revision scans | **98.6 ms** per `GET /api/spaces` at 100k revs; **91.4%** wasted bytes on `Titles only` | Server CPU grows linearly with edit history; clients fetch bodies they discard. |

## Reproducible Harness (`tests/perf/`) and Baseline Results

The `tests/perf/` suite uses plain Node 22, local Chromium over CDP, and local `dotnet` with zero npm packages. Seeded fixture generators build all vaults, files, and SQLite databases inside `os.tmpdir()`. Mobile runs emulate a `390x844` coarse-pointer viewport (`html.phone`) with `4x` CPU throttling. Spellcheck stays off except in `B5`.

Run the full suite and compare two runs:

```sh
node tests/perf/run.mjs --out tests/perf/results/before.json
node tests/perf/compare.mjs tests/perf/results/before.json tests/perf/results/after.json
```

### 1. Cold Load and Service Worker Precache (`B6`)

Live measurement against `urza.github.io/editor` (with HTTP/2 and gzip active) showed a full update transfers **13.2 MB** on the wire from 23.05 MB raw. Spellcheck accounts for **12.1 MB (92%)** of wire bytes. GitHub Pages gzips Harper WASM (15.63 MB raw -> 8.0 MB wire), but serves `dictionary-cs/index.dic` (3.65 MB) uncompressed as `text/x-c`.

| Metric | Value | Notes |
|---|---|---|
| Cold load HTTP requests (no SW) | **133 total** (121 initial app + 12 lazy spellcheck) | Unbundled ES modules across CodeMirror, Lezer, `@noble/*`, and `app/js/`. |
| Cold boot to active editor (localhost / Fast 3G) | **540.9 ms** / **15.7 s** | Multi-hop ES module waterfall dominates cold boot latency. |
| Full SW precache (`app/sw-precache.js`, 174 files) | **23.05 MB raw** / **13.2 MB wire** | Re-fetched atomically on every cache version change. |
| Spellcheck share of wire update | **12.1 MB (92%)** | Harper WASM (8.0 MB wire) + Hunspell + uncompressed Czech `.dic` (3.65 MB). |
| App-only wire size (excluding spellcheck) | **~1.1 MB** | Transfers in ~5.5 s on Fast 3G once split from spellcheck. |
| Full update time at Fast 3G (1.6 Mbps) | **~66 s** (wire) / **120.8 s** (raw) | Exceeds `capabilities.js:147`'s **30 s** update timeout. |

### 2. Note Scale and Startup (`B2`, `B4`)

| Scenario (4 KB notes; 2 KB for 10-note baseline) | Reload Boot | JS Heap | DOM Nodes | Typing Paint / Lag (p50 / p95) | Drawer Open | Typing w/ Drawer Open (p50 / p95) |
|---|---:|---:|---:|---:|---:|---:|
| 10 notes (Desktop) | 242.8 ms | 7.93 MB | 2,005 | 33.3 / 33.6 ms (0 dropped) | n/a | n/a |
| 1,000 notes, 100 open, 500 recent (Desktop) | 369.9 ms | 13.92 MB | 2,786 | 33.4 / 33.5 ms (0 dropped) | 34.3 ms | 33.3 / 66.2 ms |
| 5,000 notes, 200 open, 2,500 recent, 1k stubs (Desktop) | 529.7 ms | 36.56 MB | 8,346 | 33.3 / 33.6 ms (0 dropped) | **291.7 ms** | **166.6 / 344.2 ms** |
| 5,000 notes, 200 open, 2,500 recent, 1k stubs (Phone 4x) | 912.6 ms | **76.49 MB** | 8,299 | 34.1 / **44.9 ms** | n/a | n/a |
| 1,000 open tabs (Desktop) | 373.7 ms | 18.47 MB | **23,716** | **49.8 / 66.8 ms** | n/a | n/a |
| 500 encrypted notes x 16 KB (Phone 4x, `warmPreviews`) | 712.2 ms | **44.85 MB** | 3,629 | **+1,404.2 ms** decrypt burst | 67.5 ms (400 rows) | n/a |

Note on measurement: two-frame `requestAnimationFrame` waits have a 33.3 ms floor at 60 Hz. The `tests/perf/` suite uses CodeMirror `dispatch` duration, `PerformanceObserver` Long Tasks (> 50 ms), and dropped frame counts (> 25 ms delta) as its primary metrics.

### 3. Big Files, Markdown Tables, and Crypto (`B1`, `B3`)

| Workload | Platform | Open / Load | Single Edit (Dispatch / Frame) | Other Key Metrics |
|---|---|---:|---:|---|
| 100 KB note (no blank lines, default Markdown) | Desktop | 39.1 ms | 33.3 / 33.5 ms paint | IDB save 1.6 ms; `age.encrypt` 8.2 ms; `age.decrypt` 2.9 ms |
| 1 MB note (no blank lines, default Markdown) | Desktop | 105.0 ms | **114.1 / 191.7 ms** paint | IDB save **91.4 ms**; `age.encrypt` 14.8 ms; `age.decrypt` 11.3 ms |
| 1 MB note (no blank lines, default Markdown) | Phone 4x | n/a | **355.9 / 392.9 ms** | `age.encrypt` **64.5 ms**; `age.decrypt` **51.5 ms**; `countWords` **26.7 ms** |
| 5 MB log/CSV (no blank lines, default Markdown) | Desktop | **502.8 to 520.2 ms** | **423 to 449 ms / 429 to 979 ms** | `Ctrl+A` **27.7 ms dispatch / 512.7 ms frame**; `countRecipients` **12.7 ms** |
| 5 MB prose (blank lines every 5 lines, Markdown) | Desktop | 32.3 ms | 4.2 to 6.8 ms / 7.6 to 33.3 ms | Proves Lezer splits work across paragraphs. |
| 5 MB log/CSV (no blank lines, parser disabled) | Desktop | **18.7 ms** | **3.1 to 6.3 ms / 16.3 to 33.6 ms** | **28x faster open** and **~100x faster dispatch** than default Markdown. |
| 5.2 MB JSON (`sniff()`) | Desktop | n/a | n/a | Valid JSON **4.9 ms**; invalid/commented JSON **18.8 ms** (~75 ms Phone 4x). |
| 1,000-row x 6-col Markdown table (63.7 KB) | Desktop | n/a | 9.0 to 11.7 ms / 33.3 ms | Recomputes all 1,000 rows on every keystroke. |
| 1,000-row x 6-col Markdown table (63.7 KB) | Phone 4x | n/a | **41.3 to 51.6 ms / 64.4 to 114.8 ms** | Drops 4 to 7 frames per keystroke in a 64 KB note. |
| 3,000-row x 6-col Markdown table (196.5 KB) | Desktop | n/a | **21.6 to 39.1 ms / 33.1 to 51.8 ms** | Drops frames on Desktop per keystroke and scroll. |

### 4. Spellcheck (`B5`, Main-Thread WASM)

| Metric | Desktop | Phone (4x CPU) |
|---|---:|---:|
| Total engine load (Harper + Hunspell + Czech dict) | **675.4 ms** | **3,321.9 ms (3.3 s)** |
| Main-thread Long Tasks during load | **465 ms**, 123 ms | **2,385 ms**, **625 ms**, 80 ms, 56 ms |
| Harper lint (10 KB / 50 KB / 95 KB English prose) | 95.3 / 120.2 / **226.3 ms** | 429.5 / 810.8 / **1,109.0 ms** |
| Hunspell `twinsNow` (20 Czech words without diacritics) | 20.4 ms | **129.6 ms** |

### 5. Sync Server (`B8`, Release `.NET 10` + SQLite)

Each dataset included one `big-doc-001` note with 50 to 200 historical revisions of 512 KB each (up to 100 MB on one note).

| Server Operation | 1k docs / 5k revs (47.4 MB DB) | 5k docs / 50k revs (323.3 MB DB) | 10k docs / 100k revs (546.4 MB DB) |
|---|---:|---:|---:|
| `GET /api/spaces` (runs every sync round) | 13.5 ms avg (28.8 max) | 47.7 ms avg (54.1 max) | **98.6 ms avg (110.7 max)** |
| `GET /api/changes?since=0&limit=200` (page 1) | 152.4 ms (897 KB) | 57.7 ms | **94.3 ms** |
| Full pull 1 space (all pages) | 263.4 ms (2 pages, 1.96 MB) | 127.2 ms (9 pages, 7.81 MB) | **396.4 ms** (17 pages, **15.11 MB**) |
| Wasted bytes for `Titles only` space pull | **93.4%** (0.13 MB kept) | **91.7%** (0.65 MB kept) | **91.4%** (1.30 MB kept) |
| `POST /api/docs/{id}/revisions` (4 KB / 1 MB) | 8.5 ms / 19.6 ms | 4.0 ms / 13.3 ms | 10.3 ms / 13.4 ms |
| `GET /api/docs/big-doc-001/revisions` (history list) | 43.8 ms (53 revs) | **69.8 ms** (203 revs) | **67.2 ms** (203 revs) |

### 6. Desktop Filesystem and IPC Patterns (`B9`, `src-tauri/src/disk.rs`)

| Operation Pattern | Current (`disk.rs`) | Safe Fix | Result |
|---|---:|---:|---|
| List 5,000-file directory (`fs::metadata` vs `d_type`) | **18.38 ms** | **2.78 ms** | **6.61x faster** (larger on NTFS/macOS/SMB) |
| File save IPC round trips (`docs.js` + `native.js`) | **3 IPC calls** (`stat`, `write`, `stat`) | **1 IPC call** (`expectedMtime` + return `mtime`) | Keeps `sync_all()` crash safety (~1.3 ms on 10 KB) |
| JSON stringify + parse IPC overhead (1 MB / 5 MB text) | **2.71 ms / 29.81 ms** | Raw bytes (`ipc::Response`) | Removes JSON escaping and copies |

---

## Client Findings (`app/`)

### Critical

#### C1. Per-keystroke `change` cascade rebuilds the entire sidebar and scans all buffers

**Where:** `app/js/editor/editor.js:321-327`, `app/js/model/docs.js:1562-1590,1864`, `app/js/ui/sidebar.js:1543,1630-1770,1819`, `app/js/ui/statusbar.js:210`.

**What runs on every single keystroke:**
1. `editor.js:323` calls `update.state.doc.toString()`, flattening CodeMirror 6's rope into a new full-document string (50 MB/s churn while typing in a 5 MB note).
2. `docs.js:1583` compares `record.content === content` across the whole string and emits `"change"`.
3. `sidebar.js:1819` runs `render()` synchronously on `"change"`, calling `openList.replaceChildren(...)` to destroy every open tab `<li>`.
4. Even with drawers closed, `sidebar.js:1635-1637` calls `recentBuffers()`, `collectSpaceSections()`, and `trashed()`. With a drawer open (2,500 Recent notes), `drawerList.replaceChildren(...)` destroys and rebuilds 2,500 rows on every keystroke.
5. `docs.js:1864` calls `warmPreviews()` on every `"change"`, copying and sorting all open and closed buffers.
6. `statusbar.js:210` runs `renderState()` and formats `new Date(last).toLocaleTimeString()` on every keystroke.

**Measured impact:** At 5,000 notes with the Recent drawer open, Desktop typing stalls for **166.6 ms p50 / 344.2 ms p95**. At 1,000 open tabs with all drawers closed, DOM nodes reach **23,716** and typing drops to **49.8 ms p50 / 66.8 ms p95**.

**Safe fix now:** Stop flattening `doc.toString()` on every keystroke; read the text at save time (`persistNow`), on switch, or when line 1 changes. Split `"change"` so typing patches only the active row while structural actions (`open`, `close`, `rename`, `move`, `sync`, `trash`) run full renders.

**Later (when vaults demand it):** Add list virtualization for drawers and long open-tab lists so DOM nodes stay near ~2,200 at 10,000+ notes.

---

#### C2. Default Markdown mode causes 423 to 979 ms keystroke freezes on large files without blank lines

**Where:** `app/js/editor/lang.js:48,81-96`, `app/js/editor/markdown.js`, `app/vendor/@lezer/markdown/index.js:1012`.

**Root cause:** `lang.js` defines nine language modes and no plain-text mode. `DEFAULT_LANG` is `"markdown"`. A V8 CPU profile on a 5 MB log file (no blank lines) placed **93.8% of 428.9 ms** inside `@lezer/markdown` (`64.2%` in `finishLeaf()`). Markdown treats consecutive non-blank lines as one giant `Paragraph` leaf, and `finishLeaf()` parses the whole leaf synchronously without yielding.

**Measured impact:** A 5 MB log in default Markdown opens in **520.2 ms** and dispatches in **423 to 449 ms** (Desktop). A 1 MB log takes **355.9 ms** on Phone 4x. With the parser disabled, the same 5 MB log opens in **18.7 ms (28x faster)** and dispatches in **3.1 to 6.3 ms (~100x faster)**.

**Safe fix now:** Add `"plain"` mode (`MODES.plain = () => []`) to `lang.js` and map `.log`, `.csv`, and `.tsv` to it (keeping `.txt` on Markdown as `lang.js` intends). Switch to `"plain"` automatically above a size limit (for example, `> 512 KB` or a single paragraph `> 64 KB`), with a status bar notice and a manual override.

---

#### C3. Startup loads all note bodies into RAM and eagerly decrypts all encrypted notes

**Where:** `app/js/storage/idb.js:413-416`, `app/js/model/docs.js:1831-1865,4124`, `app/js/editor/editor.js:425`.

**Root cause:** `store.load()` calls `getAllBuffers()`, pulling every note body (Open, Recent, closed synced, Trash) into RAM before first paint. `warmPreviews()` then decrypts every encrypted note into `plain` on boot, `"change"`, and `"unlock"`. It runs on desktop even though `.row-preview` has `display: none`. `editor.js:425` keeps every opened `EditorState` in RAM until tab close.

**Measured impact:** 5,000 small 4 KB notes on Phone 4x consume **76.49 MB** JS heap and **912.6 ms** boot. 500 encrypted 16 KB notes on Phone 4x consume **44.85 MB** heap and burn **1,404.2 ms** of main-thread CPU after boot.

**Security constraint:** Decrypted text must stay in memory only so `lockAll` clears it and the start passphrase protects note text on disk. **Do not store plaintext previews in IndexedDB.**

**Safe fix now:** Skip `warmPreviews()` on desktop where `.row-preview` is hidden. On phones, decrypt only visible rows into an in-memory cache that `lockAll` clears (after confirming no other caller assumes `plain` is pre-populated).

**Later discussion:** Splitting IndexedDB into `meta` and `bodies` stores needs a data migration. Adding an LRU cap on `editor.js` `states` drops undo history on evicted tabs.

---

#### C4. Monolithic Service Worker precache forces 12.1 MB of spellcheck downloads on every app deploy

**Where:** `app/sw.js:8,21-22,34`, `app/tools/gen_sw.py:103`, `app/js/model/capabilities.js:147`.

**Root cause:** `sw.js` precaches all 174 files in one versioned cache (`vrtti-<hash>`). Live checks on `urza.github.io/editor` (HTTP/2 + gzip) show **13.2 MB** on the wire (23.05 MB raw). Spellcheck is **12.1 MB (92%)** of that total. Harper WASM compresses to 8.0 MB on the wire, while `dictionary-cs/index.dic` (3.65 MB) serves uncompressed as `text/x-c`. At 1.6 Mbps (Fast 3G), 13.2 MB takes **~66 s**, passing `capabilities.js:147`'s **30 s** update timeout.

**Safe fix now:** Move Harper, Hunspell, and the Czech dictionary into a separate cache (`vrtti-spell-<asset-hash>`) that stays precached at install (preserving full offline spellcheck). Update `sw.js`'s `activate` handler and `checkForUpdate()`'s failure path so app updates keep that spellcheck cache intact. An app-only deploy then transfers **~1.1 MB** (~5.5 s on Fast 3G).

**Later discussion:** Lazy spellcheck download on first enable changes offline behavior. Pruning `vendor/noble` touches the vendored crypto library for a small wire gain.

---

#### C5. Main-thread WASM spellcheck freezes typing and disables itself at 100 KB

**Where:** `app/js/editor/spellcheck.js:61,207,554-560`, `app/js/editor/hunspell.js`, `app/js/editor/textlang.js:105,143-145`, `app/js/editor/adddiacritics.js:123,141,205`.

**Root cause:** `spellcheck.js:207` runs Harper's `LocalLinter` and Hunspell on the UI thread, forcing a hard `MAX_DOC_CHARS = 100_000` cutoff. `textlang.js:143-145` calls `score()` twice per paragraph, and `adddiacritics.js:205` allocates per-character strings via `text.split("")`.

**Measured impact:** Phone 4x hits a **2,385 ms** load freeze (3.3 s total) and a **1,109.0 ms** lint freeze on 95 KB prose. Desktop hits **465 ms** and **226.3 ms**.

**Safe fix now:** Move Harper (already named `WorkerLinter` in `spellcheck.js:60`) and then Hunspell into a dedicated module Worker on the same origin. Lint incrementally by paragraph or viewport, drop stale replies, cache `score()` per paragraph, and replace `text.split("")` with index slicing.

---

### High

#### H1. Cold start fires 121 unbundled ES module HTTP requests

**Where:** `app/index.html`, `app/js/**`, `app/vendor/**`.

**Measured impact:** 5 to 7 waterfall hops take **540.9 ms** on localhost and **15.7 s** on Fast 3G (HTTP/2 is already active on GitHub Pages).

**Safe fix now:** Generate `<link rel="modulepreload">` tags in `index.html` with a small Python script like `gen_sw.py`. That preserves the zero-build setup.

**Later discussion:** Pre-bundling vendor libraries changes the zero-build workflow.

---

#### H2. Big-file synchronous hooks: selection word count, whole-file `sniff()`, paste scan, and Markdown tables

**Where:** `app/js/ui/statusbar.js:98,109,124`, `app/js/editor/lang.js:281-302`, `app/js/editor/editor.js:348`, `app/js/editor/markdown.js:199-244`.

**Measured impacts:**
- Selection `countWords()` (`statusbar.js:109`): 5 MB `Ctrl+A` takes **27.7 ms dispatch / 512.7 ms frame**; 1 MB Phone 4x takes **26.7 ms** per pointer move.
- Whole-file `sniff()` (`lang.js:281`): 5.2 MB JSON takes **4.9 ms** valid / **18.8 ms** invalid on Desktop (~75 ms Phone 4x).
- Paste blank check (`editor.js:348`): `!/\S/.test(before.toString())` flattens the full pre-paste doc.
- Whole-table Markdown alignment (`markdown.js:199`): a 1,000-row table takes **41.3 to 51.6 ms dispatch** (**114.8 ms** frame) on Phone 4x. A 3,000-row table takes **21.6 to 39.1 ms** on Desktop.

**Safe fixes now:** Debounce selection word count above 20k chars and iterate `Text.iterLines()`. Slice the first 16 KB in `sniff()` and skip `JSON.parse()` above 256 KB. Stop the paste blank check at the first non-whitespace character via `before.iterLines()`. Cache table column widths across scrolls, build `Decoration.widget` only for `view.visibleRanges`, and fast-path ASCII before the emoji regex.

---

#### H3. `countRecipients()` full-file decode and main-thread `age` crypto

**Where:** `app/js/crypto/age.js:127`, `app/js/model/docs.js:1023`, `app/js/crypto/keyring.js:196-197,404-408`.

**Measured impacts:** `countRecipients()` decodes the full 6.9 MB armored file (**12.7 ms** Desktop) just to inspect the header. `age.encrypt` takes **64.5 ms** on 1 MB Phone 4x (**63.0 ms** on 5 MB Desktop). Passphrase unlock already runs scrypt in `unlock.worker.js`, so the UI stays responsive even though two serial runs take ~4 to 5 s on phones.

**Safe fix now:** Slice up to the `"---"` header footer (or first 64 KB) inside `countRecipients()`, cutting 5 MB scans to `< 0.1 ms`.

**Later discussion (and explicit rejection):** Running two `scrypt(logN=18, r=8)` instances in parallel requires **512 MiB** (256 MiB each) and risks OOM kills on phones. **Do not parallelize scrypt.** Moving `age` crypto to a worker moves the device key to the worker. Switching to one scrypt wrap changes the keyring format. Both need separate security review.

---

#### H4. Sync client: unbatched 200-item pulls, silent 20,000-note truncation, and `Titles only` waste

**Where:** `app/js/sync/client.js:90,1075,1098,1116,1393`, `app/js/model/backup.js:62`.

**Root causes (verified in `B7` against real `Vrtti.Server`):**
1. `MAX_PAGES = 100` (20,000 rows) caps `pullSpace()` and `allNotes()`. Backups of spaces above 20,000 notes silently drop notes with no error.
2. `pullSpace()` loops `for (const change of body.changes) await store.applyRemote(change)`. In `B7`, pulling 2,000 `Open as tabs` notes took **114.4 s**. It fired **4,014 IDB transactions** and **4,000 `"change"` events**, triggering `O(N^2)` sidebar rebuilds.
3. In `B7`, pulling 2,000 `Titles only` notes took **1,956.9 ms** with **2,013 IDB transactions** and **2,000 `"change"` events**. It downloaded **13.84 MB** of bodies that `applyStub()` discarded (**91.4% to 93.4%** waste).

**Safe fixes now:** Remove the 100-page ceiling (loop while `body.more` is true, stopping with an error if `next` does not advance). Add `store.applyRemoteBatch(changes)` to commit one 200-item page in a single IDB transaction with one `"change"` event. Pass `?content=0` for `Titles only` spaces (paired with S3).

**Later discussion:** Parallel push, rewrap, and backup requests change request ordering; measure first.

---

#### H5. Search in Files blocks input on plaintext tabs and allocates per-line arrays

**Where:** `app/js/ui/search.js:189,293-321,344`.

**Root causes:** `scanTabs()` awaits `store.textOf()`, which resolves in a microtask for plaintext tabs and starves painting and input. Every note runs `text.split(/\r?\n/)` even with zero hits, and hidden `... N more` rows allocate DOM nodes up front.

**Safe fixes now:** Pre-check with `indexOf` (or regex `.test()`) before splitting lines. Yield every ~12 ms, batch DOM appends via `DocumentFragment`, and build hidden rows on expand.

**Later discussion:** Adding a default skip list (`node_modules`, `target`, `dist`, `vendor`) changes search results and should be discussed as a product choice.

---

### Medium and Low (`M1`, `M2`)

Done when touching nearby code:
- Defer startup housekeeping (`docs.js:4294-4297`) past first paint and batch deletes into one IDB transaction.
- Cache `Map<deviceId, name>` in `sync/client.js:612-637` so `originName()` stops walking the trust graph per row.
- Omit large bodies from `BroadcastChannel` notices (`docs.js:282`) above 64 KB so other windows read IDB only when open.
- Cache drag midpoints (`sidebar.js:1129`) and query open containers directly (`sidebar.js:737`). Cache zoom settings in RAM (`zoom.js:35`) and slice 1 KB in `firstLineTitle()` (`docs.js:124`).

---

## Sync Server Findings (`server/Vrtti.Server/`)

### S1. Missing materialized current-head table (Later, when history size demands it)

**Where:** `server/Vrtti.Server/SpaceLog.cs:86`, `server/Vrtti.Server/Revisions.cs`.

`EXPLAIN QUERY PLAN` confirmed `GET /api/spaces` scans every historical revision with correlated `MAX(r2.seq)` lookups. Latency rises from 13.5 ms (5k revs) to 47.7 ms (50k) and **98.6 ms** (100k). `GET /api/changes` scans `rowid > $since` across all spaces with 3 correlated subqueries and a temp B-tree sort. Adding a materialized `documents` head table removes both scans when real deployments reach tens of thousands of revisions.

### S2. Missing index on `members(device_id)` (Safe now)

**Where:** `server/Vrtti.Server/Db.cs:122`, `server/Vrtti.Server/SpaceLog.cs:58`.

`EXPLAIN QUERY PLAN` confirmed full table `SCAN members` in `Readable()` on every sync request. Add one line: `CREATE INDEX IF NOT EXISTS members_device ON members(device_id, space);`.

### S3. Unbounded `/api/changes` payload and missing `?content=0` mode (Safe now)

**Where:** `server/Vrtti.Server/Revisions.cs`, `server/Vrtti.Server/Program.cs`.

Up to 200 full note bodies return in one JSON response (200 x 2 MB = 400 MB OOM risk). `Titles only` spaces waste **91.4% to 93.4%** of downloaded bytes. End each `/api/changes` page at ~4 MB (minimum one change). Add `?content=0` so `Titles only` spaces skip reading `content` (`meta.sealed` already carries the title).

### S4. Full-body reads in `Current()` and `LENGTH(content)` overflow scans (Safe now; pruning later)

**Where:** `server/Vrtti.Server/Program.cs:285,328,338,355`, `server/Vrtti.Server/Revisions.cs:88,126`.

`Revisions.Current()` reads multi-MB `content` on every `POST`, `GET /revisions`, and `DELETE` even though only the 409 conflict path uses it. `Revisions.History()` runs `COALESCE(LENGTH(content), 0)`, walking ~100 MB of SQLite overflow pages (**69.8 ms** for 203 x 512 KB revs).

**Safe fix now:** Add `Revisions.CurrentHead()` without `content`. Store a `size INTEGER` column on insert and backfill existing rows (the server already sees ciphertext sizes).

**Later discussion:** Revision retention and compaction change what History shows.

### S5. SQLite connection sharing (Safe now) vs durability and compression

**Where:** `server/Vrtti.Server/Db.cs:30`, `server/Vrtti.Server/Program.cs:112`.

**Safe fix now:** Share one scoped `SqliteConnection` between auth middleware and handlers. Set `Default Timeout=5` in the connection string to skip per-request `PRAGMA busy_timeout`.

**Recommended against:** Keep `PRAGMA synchronous = FULL`. In WAL mode, `NORMAL` can roll back a committed push after a power cut. The client already cleared `dirty`, so that edit silently disappears. A 4 KB push takes only 4 to 10 ms today.

**Later discussion:** HTTP response compression brings small gains because the server stores incompressible age ciphertext.

---

## Desktop Shell Findings (`src-tauri/src/`)

### D1. Blocking `fs_err` calls on Tokio async workers (Safe now)

**Where:** `src-tauri/src/disk.rs:798-975`.

Every `pub async fn disk_*` command runs blocking `fs_err` I/O directly on Tokio's async worker threads, stalling unrelated IPC on slow disks or SMB mounts. In Tauri, plain non-`async` commands run on the main thread (not a blocking pool), so wrap all filesystem work in `tauri::async_runtime::spawn_blocking`.

### D2. Three IPC calls per file save (Safe now; keep `sync_all()`)

**Where:** `app/js/model/docs.js:1325,1367,1372`, `app/js/storage/native.js:229`, `src-tauri/src/disk.rs:496,512`.

`native.js:229` discards the `mtime` returned by `disk_write`, causing `docs.js:1372` to fire a third `disk_stat` IPC call. Return and reuse `mtime` from `native.writeText()`, and pass `expectedMtime` into `disk_write` to check external modifications before rename in a single IPC call.

**Recommended against:** **Keep `handle.sync_all()` on every save.** `SAVE_DELAY` (300 ms) is a debounce that fires once when typing pauses, not a continuous loop. `sync_all()` costs ~1 ms on ext4 and prevents empty or stale files after a power cut.

### D3. `disk_list` calls `fs::metadata()` per entry (Safe now)

**Where:** `src-tauri/src/disk.rs:818`.

Statting every entry in a 5,000-file folder takes **18.38 ms** on ext4 vs **2.78 ms** using `d_type` (**6.61x slower**; worse on NTFS/macOS/SMB). Call `entry.file_type()` first and call `fs::metadata()` only when `file_type.is_symlink()` is true.

### D4. JSON string IPC on `disk_read` and `disk_write` (Small follow-up)

**Where:** `src-tauri/src/disk.rs:859-907`.

JSON escaping and parsing add **29.81 ms** on 5 MB text files. Match `disk_read_bytes` by using `tauri::ipc::Response` and `tauri::ipc::Request` raw UTF-8 bytes when touching this layer.

### D5. Native Rust search and OS file watcher (Later, when real folders need it)

JavaScript folder search currently sends 2 IPC calls per file, and file sync polls every 30 seconds. Add a Rust `disk_search` command and `notify` file watcher later when real folder sizes demand them.

### D6. Startup `canonicalize()`, 8 s sleep threads, debug log, and deferred updates

**Where:** `src-tauri/src/lib.rs:221,372`, `src-tauri/src/disk.rs:325`, `src-tauri/src/update.rs:75,305`, `src-tauri/src/debug.rs:76`.

**Safe fixes now:** Canonicalize saved roots off the startup path so offline SMB mounts cannot hang boot. Replace 8 s `std::thread::spawn` sleeps with `tokio::time::sleep`, and cap `window.vrttiDesktop.log` at 500 entries.

**Later discussion:** Writing a deferred update installer to a temp file requires verifying its signature/hash again from disk before install.

---

## Prioritized Plan

### Step 0: Benchmarks First (`tests/perf/`)

Commit the `tests/perf/` harness (`B1` to `B9` plus `compare.mjs`) in this PR so every performance fix reports verified before/after numbers from the same suite.

### Step 1: Safe Now (Preserves Encryption, Plaintext Rules, Keys, and Durability)

| # | Finding | Safe Change |
|---|---|---|
| 1 | C2 | Add `"plain"` mode for `.log`/`.csv`/`.tsv` (keep `.txt` on Markdown) and auto-switch above a size limit with a status bar notice and manual override. |
| 2 | H4 (part) | Remove the 100-page `MAX_PAGES` data-loss cap (loop while `more` with cursor advance guard) and apply each 200-change page in one IDB transaction with one `"change"` event. |
| 3 | C4 (part) | Split Harper, Hunspell, and the Czech dictionary into their own precached hash tier (`vrtti-spell-<hash>`) and preserve it in `activate` and `checkForUpdate()`. App deploys drop to ~1.1 MB. |
| 4 | S2 | Add `CREATE INDEX members_device ON members(device_id, space)`. |
| 5 | S4 (part) | Add `Revisions.CurrentHead()` without `content`, store a `size` column on insert, and backfill existing rows. |
| 6 | S3 | Cap `/api/changes` pages at ~4 MB (min 1 doc) and add `?content=0` for `Titles only` spaces. |
| 7 | D1, D2 (part), D3, D6 (part) | Wrap `disk_*` in `spawn_blocking`, use `entry.file_type()`, reuse `mtime` + check `expectedMtime` in Rust (keep `sync_all()`), canonicalize roots off startup, use `tokio::time::sleep`, and cap `vrttiDesktop.log`. |
| 8 | C1 (part) | Stop `doc.toString()` per keystroke and emit a scoped edit event that patches only the active sidebar row. |
| 9 | H2 | Debounce selection word count, slice 16 KB in `sniff()`, early-exit paste blank check, cache table widths, and decorate only visible table rows. |
| 10 | H3 (part) | Slice only the age header in `countRecipients()`. |
| 11 | H5 (part) | Pre-check before `split()`, yield every ~12 ms, and build hidden result rows on expand. |
| 12 | C3 (part) | Skip `warmPreviews()` on desktop; decrypt only visible rows on phone (after verifying cache readers). |
| 13 | H1 (part) | Generate `<link rel="modulepreload">` tags in `index.html` with a build script. |
| 14 | C5 | Move Harper (then Hunspell) into a module Worker; cache `score()` and remove `split("")`. |
| 15 | S5 (part), M1, M2, D4 | Share one scoped `SqliteConnection` per request; apply small UI and binary-IPC cleanups when touching those files. |

### Step 2: Later Discussion (Changes Security, Durability, Offline, or Product Behavior)

- **Recommended against:** C3 plaintext IndexedDB previews; H3 parallel scrypt (512 MiB OOM risk); S5 `PRAGMA synchronous = NORMAL` (silent sync loss on power cut); D2 throttling `sync_all()`.
- **Needs design review (data & crypto):** C3 IDB `meta`/`bodies` migration and `EditorState` LRU. H3 crypto worker and v2 single-scrypt keyring. S4 revision pruning (changes History).
- **Needs design review (offline & UX):** C4 lazy spellcheck download and `vendor/noble` prune. H4 parallel push/rewrap ordering and H5 folder skip list. H1 vendor bundling, D6 disk update check, and S5 response compression.
- **When real scale requires them:** S1 materialized `documents` head table, C1 list virtualization, and D5 native Rust search plus `notify` file watcher.

### Target Performance Budgets

| Metric | Target Budget |
|---|---|
| Keystroke CM6 dispatch (Desktop · 5 MB log or 5,000 notes drawer open) | **< 8 ms (p95)**, **0 Long Tasks > 50 ms**, **0 dropped frames** |
| Keystroke CM6 dispatch (Phone 4x · 1 MB log or 1,000-row table) | **< 16 ms (p95)**, **0 Long Tasks > 50 ms** |
| Service Worker app-only deploy on Fast 3G (1.6 Mbps) | **~1.1 MB wire (< 10 s)**, well under 30 s timeout |
| Main-thread Long Tasks during spellcheck load or 95 KB lint (Phone 4x) | **0 tasks > 50 ms** |
| `GET /api/docs/{id}/revisions` (203 x 512 KB revs) | **< 5 ms (p95)** |
| Desktop file save IPC count (`B9`) | **1 IPC call per save** (keeping `sync_all()`; `disk_list` needs a Rust bench in `src-tauri`) |
