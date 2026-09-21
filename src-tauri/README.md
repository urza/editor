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
- `src/debug.rs` is the Debug menu: reload, force update (drops the service
  worker and its caches, reloads past the CDN edge), "Copy spike report to
  clipboard", a diagnostics dialog, and the inspector. A recorder injected
  with the marker logs every chord delivery since launch; the report carries
  that log plus the build, service worker, cache and storage facts. It runs
  from the shell side, so it works on any page build. The clipboard write is
  the one Tauri IPC the page origin may call (`capabilities/default.json`).
  Spike tooling; remove it with the devtools feature when done.
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
