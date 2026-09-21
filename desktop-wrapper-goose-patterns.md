# Goose patterns for the vrtti desktop wrapper

Status: research notes, 2026-09-21. Source: [goose](https://github.com/aaif-goose/goose),
commit `e629eea`, version 1.51.0. Goose is the AAIF (formerly Block) AI agent,
a large Rust workspace with a desktop app. Three exploration agents read the
code. This document keeps only what transfers to our Tauri wrapper.

The goose desktop shell is Electron, not Rust. The Rust lives in the backend
crates. The shell ships the Rust CLI as a sidecar binary and talks to it over
local HTTPS. So the inspiration splits in two. The shell gives us window, menu
and lifecycle patterns. The crates give us proven library choices and three
hardened file-system implementations. The Electron API details do not
transfer. The shapes do.

File paths below are relative to the goose repo root.

## 1. Shortcuts and menus (our requirement 1)

This is the part we planned in `desktop-wrapper.md`, and goose confirms the
shape works at scale.

**One accelerator table, platform neutral.** All shortcuts live in one data
table in `ui/desktop/src/utils/settings.ts:63`. Every entry uses the
`CommandOrControl+X` token. There is no `darwin ? 'Cmd+N' : 'Ctrl+N'` branch
anywhere. Tauri parses `CmdOrCtrl` the same way, so the pattern ports
verbatim. Platform branches exist only for true mac-only items, such as
`Command+E` with `visible: darwin`.

**Menu items are dumb.** Every click handler is three lines: get the focused
window, send one named event to it (`main.ts:2591`). The page owns the
semantics. Events have plain names: `find-command`, `toggle-navigation`,
`set-view`. In Tauri this is `emit_to(window_label, event, payload)`, and the
page side calls our existing command registry. Exceptions are deliberate:
window-creating items re-enter the main process's own handler, so menu and
page requests share one code path. Purely native items (always-on-top, open
directory) never touch the page.

**A `null` accelerator removes the menu item.** The build skips the whole
item, so an unbound command does not leave a dead menu entry.

**The ready handshake.** The page sends one `react-ready` event when its
listeners exist (`App.tsx:433`). The main process keeps a per-window set of
ready windows and a per-window queue of pending events (`main.ts:1892`). A
menu event for a cold window waits in the queue. We will hit the same race on
every fresh window. Copy this directly.

**Two gotchas goose documents itself:**

- The menu is built once at startup. A changed accelerator takes effect after
  a restart, and their settings UI says so. Live rebinding requires a full
  menu rebuild and re-set. Decide early which we want.
- OS-global hotkeys are a separate mechanism from menu accelerators, with
  separate register and unregister calls. Goose keeps only two hotkeys
  global. Keep that separation.

## 2. Windows and lifecycle

**One window factory.** Every path that opens a window (menu, dock, tray,
deep link, file open, second launch) funnels into one function with an
options struct (`ui/desktop/src/main.ts:1035`). There is no second
construction site. Copy this rule.

**Per-window config at construction, not fetched later.** Goose injects a
JSON blob into each window at creation and the page reads it synchronously
at first paint. No IPC round-trip, no race. The Tauri equivalent is
`WindowBuilder::initialization_script`.

**Window identity is the URL.** The initial view is chosen by setting the URL
hash before load. The page router does the rest. Cheapest possible
multi-window model, and it fits our remote-URL setup.

**One `closed` handler does all cleanup**, keyed by a window id captured
before registration (`main.ts:1483`). Registry entry, pending queues, ready
flag, resources, all released in one place.

**Window state persistence has a trap.** Goose saves outer bounds but
restores content size, so the window grows by the frame height on every
launch on framed platforms (their issue #9363). Tauri has no built-in state
keeper. When we write ours, persist and restore the same bounds flavor.

**Single instance is platform-conditional.** The lock is taken only on
Windows and Linux. macOS delivers second launches as `open-url` and
`open-file` events instead of a second process (`main.ts:433`).

**Close semantics per platform.** On macOS, `activate` recreates a window
when none exist. `window-all-closed` quits everywhere except macOS. Renderer
close requests close only the sender's window, never a guessed one.

**Goose has no unsaved-changes quit guard.** Nothing to borrow there. An
editor needs one, so that part is ours to design.

## 3. The contract between page and Rust

Goose defines its whole UI-to-backend API once, in Rust, and this discipline
is the transferable core.

**Naming.** Methods follow `_goose/unstable/<area>/<resource>/<verb>`, for
example `_goose/unstable/config/prompts/save`. The `unstable` segment marks
the no-compatibility-promise zone. Our Tauri commands are few, but the same
scheme scales down: `doc_open`, `doc_save`, `doc_list`, with one stability
rule stated once.

**Case mapping by rule, not by hand.** Every payload struct carries
`#[serde(rename_all = "camelCase")]`. Rust stays snake_case, JS stays
camelCase, and no field is mapped manually.

**Errors are data, not transport failures.** In `crates/goose/src/acp/fs.rs:93`
a failed read returns a successful response that carries an error payload.
Only protocol faults return a real error. For Tauri commands the same split
is `Result<FsResult, TransportError>`, where `FsResult` carries per-file
errors the page renders. Machine-readable discriminants go in a `data` field,
never in the message text, and a comment pins each string to its Rust
definition.

**Validate responses at the boundary.** Every generated goose client method
runs the response through a Zod schema. A stale binary then fails with a
clear parse error instead of an `undefined` deep in the UI. Cheap insurance.

**Keep the contract package free of the transport.** Their client README
states it: the typed client does not start or own the backend process.
For us this means the PWA depends on a small interface plus a mock, never on
Tauri itself. The switch in `app/js/model/capabilities.js` picks the
implementation. The PWA keeps running in a plain browser.

**Codegen exists but is overkill for us.** Goose chains schemars, a JSON
schema, and `@hey-api/openapi-ts` with Zod output, plus a CI check that
regenerates and fails on drift. With under ten commands we hand-write the
types. The drift-check idea is still good if we ever generate anything.

**Bulk bytes do not go through the RPC layer.** Text crosses as UTF-8 JSON
strings with optional line and limit windowing. Real binary data goes as
base64 with an explicit MIME type, or over a plain HTTP route with a body
limit. No custom chunking anywhere.

## 4. The disk backend (requirement 7, the expensive one)

Goose contains three separately hardened file implementations. Read these
before we write a line of the macOS and Linux backend.

**`crates/goose/src/providers/private_file.rs`, the atomic private write.**
Resolve symlinks first, max one hop, so we replace the target and keep the
user's symlink. Create a temp file in the destination directory, so the
rename stays on one filesystem. Set permissions 0600 on the handle before
writing. Write, `sync_all()`, then persist over the target. The Windows half
is a full reimplementation: owner-only ACL via an SDDL string, `MoveFileExW`
with `REPLACE_EXISTING | WRITE_THROUGH`, a helper for `\\?\` verbatim paths
and the 248-character legacy limit, and rejection of interior NULs. Tests
assert the inode changes and the symlink survives. This is the single best
file in the repo for us.

**`crates/goose-roaming/src/trust.rs`, the document-save pattern.** Write to
`<path>.json.tmp-<pid>`, then rename. The pid suffix stops two processes from
truncating each other's temp file. For read-modify-write it adds an exclusive
lock on a sidecar `.lock` file, never on the data file. Its comment explains
why: rename alone prevents torn reads but not lost updates. The lock releases
on the error path too.

**`crates/goose/src/skills/supporting_files.rs`, confined access for
untrusted paths.** Validate path components without touching the disk: reject
`..`, root, and prefixes, drop `.`. Then walk down one component at a time
with `openat` and `O_NOFOLLOW`, so no symlink can be swapped in mid-walk.
The directory-open flag differs per platform: `O_PATH` on Linux, `O_SEARCH`
on Apple and BSD, `O_RDONLY` elsewhere. It checks `nlink == 1` against
hardlink tricks and caps file size from metadata before any read. This
weight is only for paths an attacker could pick. Our own saved-documents dir
needs less; a user-picked folder may need more.

**`ui/desktop/src/desktopFileAccess.ts`, the same thinking in the shell.**
Bind a window to one canonical directory recorded as `(dev, ino)`. Re-verify
that identity on every operation. `lstat` before open, `O_NOFOLLOW` on open,
re-stat the opened handle and compare against the pre-open `lstat`. It also
checks request provenance: registered window, main frame, URL equal to the
expected app URL. The Tauri analog checks the webview label and origin
before any fs command runs. The naive handlers at `main.ts:2357` are the
early version of the same code, with tilde expansion and no checks. Build
toward `desktopFileAccess.ts`, not toward those.

**Other backend notes:**

- To validate a file that does not exist yet, canonicalize the parent first,
  then compare (`crates/goose/src/hints/import_files.rs:234`).
- Goose has no file-watching crate at all. Its only watcher is an mtime poll
  that advances its watermark only after a successful parse, so a transient
  read failure retries (`crates/goose-roaming/src/node.rs:324`). That loop
  is a fine start for the one open document. For directory trees we must
  evaluate `notify` ourselves; goose gives no verdict.
- Tree listing and ignore rules use the `ignore` crate with
  `require_git(false)`, so rules apply outside a git repo too.
- `fs-err` wraps `std::fs` so every error carries the path. One import line,
  call sites unchanged. Adopt it.

## 5. Rust workspace hygiene and the crate shortlist

Practices from the root `Cargo.toml` and CI that fit even a two-crate
workspace:

- One `[workspace.dependencies]` table. Almost every entry sets
  `default-features = false` and lists features explicitly. Members write
  `{ workspace = true }` and add only extra features.
- Never `tokio` with `features = ["full"]`. Their small crates take three or
  four features. Our backend needs roughly `rt-multi-thread, macros, sync,
  fs, io-util, time`. Tauri brings its own runtime; the discipline still
  applies where we add features.
- Lints at workspace level, crates opt in with `[lints] workspace = true`.
  CI runs `cargo clippy --workspace --all-targets -- -D warnings` plus
  `cargo fmt --check`.
- `[profile.dev.package."*"] debug = false`. Dependencies lose debug info,
  first-party code keeps it, `target/` shrinks and links faster.
- `rust-version` in the manifest is the compatibility promise. The pinned
  toolchain in `rust-toolchain.toml` is newer. Two levels, on purpose.
- `cargo-deny` runs advisories only, daily, instead of the full check.
- Justfile: `just --list` as the default recipe, one `check-everything`
  recipe, and per-platform recipe bodies via `[unix]` and `[windows]`
  attributes on duplicate names.

Error handling split, applied consistently: `anyhow` for application code,
`thiserror` only for the few enums a caller must match on. The low fs layer
returns plain `io::Result`, so callers branch on `kind()`, and `NotFound`
can mean "not created yet" instead of a failure.

The crates goose relies on, with versions from its workspace table:

| Crate | Version | Use |
| --- | --- | --- |
| anyhow | 1.0.102 | application errors |
| thiserror | 2.0.18 | boundary error enums |
| tokio | 1.48 | async runtime, narrow features |
| serde / serde_json | 1.0.228 / 1.0.145 | all serialization |
| serde_path_to_error | 0.1.8 | config errors with field paths |
| tracing + subscriber + appender | 0.1.43 / 0.3.22 / 0.2.1 | logging |
| etcetera | 0.11 | platform config/data/state dirs |
| dirs | 7 | `home_dir()` only |
| tempfile | 3.10.1 | atomic write staging |
| fs-err | 3.1 | fs errors that name the path |
| fs2 | 0.4 | cross-process file locks |
| ignore | 0.4.12 | tree walking, gitignore rules |
| keyring | 3.6.3 | secrets, per-OS backend features |
| notify | none | goose does not watch files; our own call |

One warning from their code: Windows FFI in goose is legacy `winapi`. For
new code use the `windows` or `windows-sys` crates instead.

## 6. Config, paths, and logging

- `etcetera::choose_app_strategy` with a domain, an author, and an app name
  resolves the config, data, and state dirs. Goose still passes the author
  "Block" with a comment: a change would orphan every existing install. Pick
  our identifiers once, before the first release, and never change them.
- An env var can relocate all app dirs under one root, validated to be an
  absolute path. This makes tests hermetic. Add the equivalent on day one.
- Their config is YAML, and `serde_yaml` is unmaintained upstream. For the
  wrapper prefer TOML or JSON and avoid the question. Use
  `serde_path_to_error`, so a bad config reports the failing field, not a
  line number.
- Config writes use the temp-plus-rename pattern from section 4. Use the
  pid-suffixed temp name from `trust.rs`, not a fixed `.tmp`.
- Secrets: `keyring` with per-OS backend features, plus a documented file
  fallback at 0600 when the keyring fails or is disabled. Headless Linux has
  no Secret Service, so the fallback is not optional. A dedicated error
  variant tells the caller to warn the user.
- Logging: one builder function returns the whole subscriber. If `RUST_LOG`
  is set, it wins outright. Otherwise the floor is WARN with a few per-crate
  directives, so third-party noise stays out. One log file per run under
  `state_dir/logs/<component>/<date>/`, and a startup reaper deletes date
  dirs older than 14 days, wrapped in `let _ =` so it never blocks boot.
- Startup diagnostics: every backend start attempt writes a small JSON trace
  file, flushed on each event, newest 20 kept. Every failure message ends
  with the path to that file. This is how a packaged-app failure on a user
  machine stays debuggable. Worth copying whenever the wrapper grows a
  moving part.

## 7. Later work: deep links, open-with, updates

Not in the spike, recorded for when we want "Open with vrtti".

- Three delivery paths exist for a custom URL scheme: macOS `open-url`,
  a second-instance command line on Windows and Linux, and the cold-start
  argv. Goose unifies all three into one handler and routes on the URL
  hostname.
- A flag set by the URL handlers stops the normal startup path from opening
  a second window. Simple and essential.
- Links queue per window until the page is ready, and a two-second dedup
  absorbs the OS delivering the same URL twice.
- File open: stat the path, take the dirname when it is a file, record it,
  open a window on it. Declared via `CFBundleDocumentTypes` on macOS and
  `MimeType` lines in the `.desktop` files on Linux.
- Outbound links from the page are denied by default. A curated safe-scheme
  list opens directly; anything else gets a confirm dialog. `file:`,
  `javascript:` and `data:` are always blocked.
- Updates barely apply to us. The window points at the deployed Pages URL,
  so the web app updates itself. The wrapper binary changes rarely, and the
  Tauri updater plugin covers the mechanics. The transferable goose ideas
  are small: one feature flag, an env kill switch, and update progress
  broadcast to all windows on one channel.

## 8. What does not transfer, and one anti-pattern

- The whole sidecar apparatus: ephemeral port choice, a per-run secret
  passed by env var and never argv, constant-time secret comparison, and a
  TLS certificate fingerprint pinned via a stdout handshake. Tauri commands
  run in-process, so none of this exists for us. If we ever split out a
  helper process, this is the reference design.
- Electron mechanics: fuses, the preload bridge, per-response CSP injection.
- The anti-pattern: goose's preload exposes a generic, unallowlisted event
  passthrough. Any channel name works, and page JS can synthesize fake
  inbound events. Their own hardened file code checks provenance instead.
  Tauri events are similarly open by default. Keep a fixed list of event
  names and check the webview label on every command.

## 9. Cross-platform traps their code documents

- Windows long paths: the `\\?\` prefix rules and the 248-character legacy
  threshold. The most likely place a naive Rust backend breaks.
- Windows symlinks and junctions need `FILE_FLAG_OPEN_REPARSE_POINT` plus an
  explicit attribute check. There is no `O_NOFOLLOW`.
- The Unix directory-open flag is not portable: `O_PATH` on Linux,
  `O_SEARCH` on Apple and BSD.
- A GUI app on macOS does not inherit the login-shell PATH. Goose resolves
  it once and merges it into child envs. Only relevant if we ever spawn
  tools.
- Tests that set `HOME` or `USERPROFILE` race each other. Goose serializes
  them with `env-lock` and `serial_test`. We need the same the moment we
  test path resolution.

## 10. How this meets the plan

The spike in `desktop-wrapper-tauri-vs-wails.md` section 8 stays the first
step, unchanged. This document adds to what comes after it:

1. Spike step 3 (menus): build the accelerator table and the ready handshake
   from section 1 straight away. They are small and prevent the cold-window
   race.
2. When spike step 6 fails on macOS and Linux, as expected: design the disk
   backend from section 4, define the contract from section 3, and put the
   mock behind `capabilities.js` so the browser build stays whole.
3. Start the Rust crate with the hygiene and the shortlist from section 5.
