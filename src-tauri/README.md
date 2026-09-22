# vrtti desktop shell

A Tauri window around the deployed PWA at https://urza.github.io/editor/.
It exists for three chords a browser reserves: Ctrl+N, Ctrl+S, Ctrl+W
(desktop-wrapper.md, desktop-wrapper-tauri-vs-wails.md §11).

- The page is loaded from GitHub Pages. A push to main updates the desktop
  app too. The binary changes only when this folder changes.
- No Node and no npm. The Tauri CLI is a cargo binary.
- `src/lib.rs` holds the whole shell: one window factory, one menu, one
  forwarder that hands menu ids to the page as `vrtti:command` DOM events.
  The page side is `app/js/ui/desktop.js`.
- Every window is a workspace (architecture.md §14). Label `main` loads the
  plain URL; label `ws-<id>` loads `?ws=<id>`. The page opens and focuses
  windows through two Tauri commands, `open_workspace` and
  `focus_workspace`, whose permissions build.rs generates and
  `capabilities/default.json` grants to the Pages origin. Closing a
  secondary window runs `workspace.dissolve` in a surviving window; the
  last window closing is a quit and keeps every workspace, and main's page
  reopens them at the next launch.
- `src/debug.rs` is the Debug menu: reload, force update (drops the service
  worker and its caches, reloads past the CDN edge), "Copy spike report to
  clipboard", a diagnostics dialog, and the inspector. A recorder injected
  with the marker logs every chord delivery since launch; the report carries
  that log plus the build, service worker, cache and storage facts. It runs
  from the shell side, so it works on any page build. The clipboard write is
  the one Tauri IPC the page origin may call (`capabilities/default.json`).
  Spike tooling; remove it with the devtools feature when done.
- Window creation must never run on the main thread's event handlers or in
  a synchronous command: on Windows that deadlocks (tauri documents it on
  the window builders, and the first 14.4 build froze that way). The two
  page commands are async; other opens go through `open_or_focus`, which
  spawns on the async runtime.
- Three plugins: single instance (a second launch focuses main and exits),
  window state (bounds per label, saved on every close and exit request),
  clipboard (the spike report). The ready handshake queues a forwarded
  command per window until the page calls `page_ready`, with an eight
  second fallback for an older page that never does.
- The folder is named `src-tauri` because the Tauri CLI looks for that name.
- The identifier `io.github.urza.vrtti` names the app's data directory on
  every OS. Never change it: a change orphans every install.

## Build

Linux needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
`libayatana-appindicator3-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`.

```
cargo install tauri-cli --version '^2' --locked
cd src-tauri
cargo tauri build            # bundles in target/release/bundle/
cargo build --release        # the bare executable only
```

CI does this for Windows, Linux and macOS on every push to main that touches
this folder (`.github/workflows/desktop.yml`) and uploads the files to the
`desktop-latest` prerelease. The builds are unsigned: Windows and macOS warn
on first launch.
