# Performance Benchmarks (`tests/perf/`)

This suite measures vrtti across the browser client, the `.NET 10` SQLite sync server, Service Worker update size, and desktop filesystem paths. It uses plain Node 22, local Chromium over CDP, and local `dotnet` with zero npm packages.

## Scenarios

| ID | Scope | What It Measures |
|---|---|---|
| `B1` | Big files (Desktop + Phone 4x) | Open time, 50-key dispatch p50/p95, Long Tasks, and dropped frames on 1 MB log, 5 MB log (no blank lines), and 5 MB prose. |
| `B2` | 5,000-note vault (Desktop + Phone 4x) | 50-key dispatch p50/p95 with drawers closed and with Recent (2,500 rows) open, Recent drawer open time, and DOM node count. |
| `B3` | Markdown tables (Desktop + Phone 4x) | 50-key dispatch p50/p95 and scroll dropped frames on 1,000-row and 3,000-row tables. |
| `B4` | Startup & RAM (Desktop + Phone 4x) | Time to editable note, JS heap after GC, and total Long Task time in the first 5 s (5,000 small notes; 500 encrypted 16 KB notes). |
| `B5` | Spellcheck (Desktop + Phone 4x) | Harper + Hunspell load Long Tasks, lint times on 10 / 50 / 95 KB prose, and 20 Czech words. |
| `B6` | Update size (no browser) | Raw and GitHub-Pages wire bytes of `app/sw-precache.js`, app-only deploy size, and Fast 3G transfer seconds. |
| `B7` | Sync client (real server + CDP) | Pulling 2,000 `Open as tabs` notes and 2,000 `Titles only` notes: wall time, IDB transactions, `"change"` events, and HTTP bytes. |
| `B8` | Sync server (`Release` `.NET 10`) | Seeded 1k/5k, 5k/50k, and 10k/100k SQLite DBs: `GET /api/spaces`, `/api/changes`, full pull, history list, 4 KB and 1 MB pushes. |
| `B9` | Desktop disk & IPC | Real IPC calls per file save in `docs.js` + `native.js`, plus Node host reference timings mirroring `disk.rs` patterns. |

## Usage

Run all benchmarks (5 runs per scenario, writing one JSON report):

```sh
node tests/perf/run.mjs --out tests/perf/results/before.json
```

Run a subset while working on one PR:

```sh
node tests/perf/run.mjs --only B1,B6 --runs 5 --out tests/perf/results/after.json
```

Compare two JSON runs:

```sh
node tests/perf/compare.mjs tests/perf/results/before.json tests/perf/results/after.json
```

All fixtures generate deterministically at run time inside `os.tmpdir()`. Local JSON outputs under `tests/perf/results/` stay untracked by `.gitignore`. Before fixing `H4` and `C1`, `B7` (`pull2kTabs`) runs in `O(N^2)` and takes over two minutes per run. Use `--only B7 --runs 1` when profiling the unfixed baseline.
