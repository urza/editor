# Tauri vs Wails for vrtti

Status: decided 2026-09-13. Tauri is the chosen framework. Nothing is built.
Follows `desktop-wrapper.md`, which asked whether a native shell can give back
Ctrl+N, Ctrl+S and Ctrl+W. This document compares the candidates against what
vrtti actually needs, and section 11 records the decision.

## The short version

Tauri and Wails wrap the same three webviews. Every webview risk in this
document applies to both, in equal measure. The framework choice does not
change the engine, so it does not change the hard parts.

The real fork in the road is not Rust against Go. It is this question: does the
desktop app have to run on macOS or Linux, or only on Windows?

Section 9 answers the follow-up question about .NET. Short form: Photino cannot
do the menus we need, Avalonia 12 can and is young, and Electron.NET needs npm.

- **Windows only.** The engine is WebView2, which is Chromium. Everything the
  app does today keeps working, disk access included. The wrapper is then a
  weekend project. Pick either framework. Wails is the smaller toolchain.
- **macOS or Linux too.** The engine is WebKit there. The File System Access
  API does not exist in it, so disk files need a native backend and a second
  code path in the storage layer. That is the bulk of the work, and it is
  identical under Tauri and under Wails. Pick Tauri, for the larger ecosystem
  and the finished plugins.

## 1. What vrtti needs from a wrapper

Derived from `architecture.md` and the current code.

| # | Requirement | Why |
| --- | --- | --- |
| 1 | Ctrl+N, Ctrl+W as app shortcuts | The whole reason for the wrapper |
| 2 | IndexedDB that never gets evicted | It is the source of truth for scratch buffers |
| 3 | WASM, main thread and workers | Harper and Hunspell spellcheck |
| 4 | WebCrypto with X25519 | age encryption, see architecture.md §5 |
| 5 | Web Workers | scrypt unlock runs off the main thread |
| 6 | `fetch` to the sync server | Section 3 of the architecture |
| 7 | Disk files and folders | Currently the File System Access API |
| 8 | No Node and no npm | Hard project rule, `motivation.txt` |
| 9 | Updates without friction | Today a push to main reaches every device |

Requirements 2 to 6 are engine questions, not framework questions.
Requirement 7 is the expensive one. Requirement 9 is the ongoing tax.

## 2. Both frameworks wrap the same engines

| Platform | Engine | Family |
| --- | --- | --- |
| Windows | WebView2 | Chromium |
| macOS | WKWebView | WebKit |
| Linux | WebKitGTK | WebKit |

This is the single most important fact in the comparison. A developer on
Hacker News put the cost plainly: you answer for three engines instead of one.
Another called WebKitGTK "really not a good foundation", "much slower than
other browsers", with "weird bugs".

Tauri documents the Linux trouble itself, on an official page called
[Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/).
The listed symptoms are a blank window, flicker on resize, and crashes on
resize with no error. The listed fix is one of four environment variables,
ending with "disables hardware acceleration entirely". NVIDIA hardware is the
usual trigger. Wails has no such page, but it runs on the same WebKitGTK and
inherits the same faults.

Open Tauri bug reports show the same engine biting in smaller ways. Font weight
is offset by 100 on WebKitGTK, so text looks bolder than in a browser. CSS
animations can blur the rest of the window. A `contenteditable` span can need a
right click before it accepts input. That last one should worry an editor.

## 3. Where the two differ

Numbers read from the GitHub API on 2026-09-13.

| | Tauri | Wails |
| --- | --- | --- |
| Backend language | Rust | Go |
| First commit | July 2019 | December 2018 |
| Stars | 111,037 | 36,228 |
| Open issues | 1,462 | 325 |
| Stable line | v2 | v2, with v3 in beta |
| Mobile targets | iOS and Android | none |
| Cross-compile | no, build per OS | Windows yes, others via Docker and Zig |
| Frontend toolchain | none needed | none needed, but templates assume npm |
| CLI without Node | `cargo install tauri-cli` | `go install` |

### Language and toolchain

Go installs as one archive and builds in seconds. Rust installs a larger
toolchain, and on Windows it also wants the Visual Studio build tools. Tauri
build times draw steady complaints: five minutes is a common report, ten
minutes when the binary itself recompiles. Wails builds average around twelve
seconds on Windows in the same comparisons.

For vrtti this matters less than it looks. The native side of this wrapper is
one file of about a hundred lines. It changes almost never. A slow first build
is a one-time cost, not a daily one.

### Maturity

Tauri v2 is stable and has been for two years. It ships native menus, multiple
windows, notifications, a single-instance lock, file associations, a window
state saver and an updater, all as maintained plugins.

Wails v2 is stable but single-window by design. Wails v3 adds the multi-window
API, a better build layout and real menus, and it reached beta on 2026-08-02.
The v3 release tracker still lists 38 open gates, 27 of them blocking. The
project says the desktop API is stable and that teams run v3 in production.

For an editor with several windows, v3 is the version you want, and v3 is not
finished. That is the clearest concrete advantage Tauri holds today.

### Security model

Tauri uses a capability system. The frontend can call only the commands you
list, per window and per origin. Wails binds Go methods and generates the
JavaScript side automatically, which is easier and coarser.

vrtti barely uses this. The wrapper needs two messages: "the user pressed
Ctrl+N" and "the user pressed Ctrl+W". A tight capability model is a small win
here, not a deciding one.

## 4. Requirement by requirement

### 4.1 The shortcuts (requirement 1)

Both frameworks solve this, the same way, with native menu accelerators.

- Tauri: `MenuItemBuilder::new("New").accelerator("CmdOrCtrl+N")`, then an
  `on_menu_event` handler that emits to the frontend.
- Wails: `menuItem.SetAccelerator("CmdOrCtrl+N")`, then an event to the
  frontend.

`CmdOrCtrl` maps to Cmd on macOS and Ctrl elsewhere, in both.

There is also a good chance plain `preventDefault` works, without any menu.
Microsoft's list of WebView2 browser accelerator keys is Ctrl+F, F3, Ctrl+P,
Ctrl+R, F5, Ctrl+Plus, Ctrl+Minus, Ctrl+Shift+C and F12. Ctrl+N and Ctrl+W are
not on it, and a WebView2 window has no tabs to close and no browser window to
open. The spike in section 8 should test this first, because it is free.

On macOS the menu route is not optional. The system menu owns Cmd+W and Cmd+N.
You must claim them in your own menu or the system keeps them.

**Verdict: a tie. Both do it, and neither is hard.**

### 4.2 Storage that survives (requirement 2)

This is the requirement that can lose user text, so it deserves care.

**Windows.** WebView2 keeps IndexedDB in the app data folder. It persists.

**macOS.** WKWebView turns on Intelligent Tracking Prevention by default since
Big Sur. That machinery deletes script-writable storage, IndexedDB included,
after a window of no user interaction. WebKit carries two windows in source, 30
days in the general case and 7 days for a domain that got link decoration from
a tracker. Two exemptions matter here. A domain granted persistent storage is
exempt, and an app-bound domain is exempt.

vrtti already calls `navigator.storage.persist()`, in
`app/js/model/capabilities.js`, and exposes it as a command in the settings
panel. That is the right mitigation and it is already written. Confirm that the
grant is actually given inside WKWebView, because the API can return false.

WKWebView also gives the host no control over the data directory on older
macOS. Apple added data store identifiers in macOS 14. Tauri and Wry track this
in a discussion and do not expose it yet.

**Linux.** WebKitGTK stores IndexedDB in a directory the host sets. Tauri sets
it. Tauri also shipped a bug once where the path changed between v1 and v2 and
users lost their databases. Pin the version and test an upgrade.

**Verdict: equal risk in both frameworks, and the risk is real on macOS.**
Bundling the assets instead of loading the remote URL reduces it, because
local content is treated as app-bound.

### 4.3 WASM, WebCrypto, workers (requirements 3 to 6)

Safari 17 and later has X25519 in WebCrypto, and the iPhone already proved that
path on 2026-09-09. macOS WKWebView shares that engine, so the crypto should
work. WebKitGTK is the same engine family and usually follows, later.

WASM runs in all three. Speed is the open question, not support. WebKitGTK is
the slowest of the three engines, and Hunspell plus Harper run on every lint
pass. Measure before you promise.

Service workers are the part to check early. WKWebView needs the domain
declared as app-bound before it will run a service worker, documented for iOS
14 and up. If the wrapper loads the deployed URL, offline mode on macOS may
simply not start. If the wrapper bundles the files, the service worker becomes
unnecessary, because the files are already local.

**Verdict: identical in both. Decide bundle against remote URL first.**

### 4.4 Disk files (requirement 7)

The expensive one.

| Engine | File System Access API | Handles survive restart |
| --- | --- | --- |
| WebView2 | yes | no, the page loses them |
| WKWebView | no | not applicable |
| WebKitGTK | no | not applicable |

Safari does not implement `showOpenFilePicker`, `showSaveFilePicker` or
`showDirectoryPicker` on any Apple platform. Both WebKit engines inherit that.

So on macOS and Linux the current disk module cannot run. The work is a second
backend behind the existing switch in `app/js/model/capabilities.js`. The
native side opens a picker, keeps a real path, reads and writes bytes, and the
JavaScript side talks to it instead of to a `FileSystemFileHandle`.

- Tauri: `tauri-plugin-dialog` and `tauri-plugin-fs`, both mature, plus a
  persisted-scope feature that restores access to a folder after a restart.
- Wails: dialog and file APIs in the framework, similar shape, smaller history.

Windows gets a third option. The Rust or Go side can hand the page a real
directory handle with `CreateWebFileSystemDirectoryHandle`, so the existing
code path keeps working and gains the persistence it lacks in the browser.
That trick is WebView2 only, so it helps a Windows-only build most.

**Verdict: Tauri wins on ready-made plugins.** The design work is the same
either way, and it is several days, not several hours.

### 4.5 No Node and no npm (requirement 8)

Both pass, with a small asterisk on Wails.

Tauri treats the frontend as a static folder. Point `frontendDist` at `app/`,
leave `beforeBuildCommand` empty, install the CLI with `cargo install
tauri-cli`. No Node enters the project.

Wails itself does not need npm. Its templates do, including the one called
vanilla, which pulls in Vite. You would skip the template and write the
`main.go` by hand. That is fine, and it is ten minutes of extra reading.

**Verdict: a tie, with Tauri slightly cleaner out of the box.**

### 4.6 Updates (requirement 9)

Today a push to main reaches every device through GitHub Pages and the service
worker. A desktop binary loses that, unless it loads the remote URL.

Two shapes, and the choice drives several answers above.

**Shape A, the window points at the deployed URL.**
Updates stay automatic. The binary almost never changes. Tauri supports this:
`frontendDist` accepts a remote URL, and capabilities can be granted to that
origin. Wails v3 supports it through the window `URL` option. The costs are the
macOS service worker question, the ITP exposure, and a blank window when the
network is down and the cache is cold.

**Shape B, the files are bundled in the binary.**
Offline is guaranteed and the service worker becomes dead weight. Every release
needs a build for each OS, and an updater. Tauri has `tauri-plugin-updater`,
which wants a signing key pair and a manifest, and GitHub Releases can host
both. Wails has its own update story, younger.

Signing is the part nobody enjoys. On Windows, a certificate that silences
SmartScreen starts around 400 dollars a year and now lives on a hardware token
or in Azure Key Vault. On macOS, notarization needs a paid Apple developer
account. Without either, the first run shows a warning on both systems.

**Verdict: Shape A first, for a private tool used by one person.** The warning
on first run is a one-time annoyance. It costs nothing and keeps the deploy
flow intact.

## 5. What developers say

Collected from Hacker News, GitHub discussions and write-ups.

**On system webviews, which is the shared risk.**
"System web views just aren't a great solution for a ui framework. Partly
because Linux doesn't have an official webview implementation, partly because
the web views across OS versions have differences." Another comment in the same
thread rates the OS webviews "from mediocre to absolute garbage", and a third
reports a Tauri Linux boot time over 20 seconds because of the webview. A
counter-argument recurs: "This is a lot of tradeoffs for saving 100 megs."

**On Tauri against Wails, on the Tauri repository itself.**
The Wails side gets credit for an easier language and a responsive maintainer.
A Tauri maintainer answers that most Tauri work needs no Rust at all. The
thread agrees Tauri was further along on menus, multiple windows and
notifications, which were still on the Wails roadmap at the time. That gap
narrowed with Wails v3, but v3 is in beta.

**On testing.** Teams with a Playwright suite hit an engine mismatch. Playwright
drives Chromium or its own WebKit build. Neither is WebKitGTK or WKWebView, so
a green suite does not prove the shipped app works. That applies directly to the
Playwright gate this project uses before every deploy.

**On Tauri build times.** Regular complaints: five minutes typical, ten minutes
when the binary recompiles, and a profiling result blaming the `tauri::command`
macro for about half the compile time. Users also name disk space as a reason
they avoid Rust.

**On the escape hatch.** Tauri is working on Verso, which embeds the Servo
engine, funded by an NLnet grant. As of July 2026 it lacked window decorations,
transparency and per-window menus. A bundled Chromium through CEF stays on the
table with no date. If that lands, the engine problem shrinks. Do not plan
around it yet.

## 6. Honest accounting of what this buys

The app already has working shortcuts on Alt. Ctrl+S needs no wrapper at all,
as `desktop-wrapper.md` explains. So the wrapper buys exactly two chords,
Ctrl+N and Ctrl+W, and it buys them at these prices:

- A second disk backend, if macOS or Linux is in scope.
- A test matrix that grows from one engine to two or three.
- A Playwright gate that no longer covers the shipped product on WebKit.
- Per-OS builds, signing decisions and an updater, forever.
- A storage eviction risk on macOS that the browser version does not have.

Against that, the wrapper also brings some real gifts that are easy to forget:

- A dock or taskbar icon that is a real application.
- File associations, so a double-clicked `.txt` opens in vrtti.
- A single-instance lock, so a second launch reuses the open window.
- Window position and size restored on launch.
- Persistent disk folder access on Windows, which the browser cannot keep.

## 7. Recommendation

1. **Fix Ctrl+S in the browser now.** No wrapper. One change in
   `app/js/ui/shortcuts.js`.
2. **Answer the OS question before writing any Rust or Go.** If both computers
   run Windows, the rest of this document gets much shorter.
3. **Spike Tauri, not Wails,** unless the answer to step 2 is Windows only and
   the Go toolchain appeals. Tauri's stable multi-window support, its finished
   file and dialog plugins, and its larger issue history are worth more here
   than Go's faster builds. Wails v3 is the better Wails and it is still beta.
4. **Start with Shape A**, the window pointed at the deployed URL. Keep the
   Pages deploy flow. Judge the engine before committing to a bundle.
5. **Decide the native disk backend only after the spike.** It is the one
   genuinely large piece of work, and it is framework-independent.

## 8. The spike, in order

Half a day of work. Stop at the first step that fails.

1. Empty Tauri app, `frontendDist` set to `https://urza.github.io/editor/`.
2. Press Ctrl+N and Ctrl+W with a bare `keydown` listener. Log what arrives.
   If both arrive and `preventDefault` holds, the menu work is optional.
3. Add menu items with `CmdOrCtrl+N` and `CmdOrCtrl+W` accelerators. Emit to
   the frontend and call the existing command registry.
4. Check the service worker registers. Kill the network and relaunch.
5. Check `navigator.storage.persist()` returns true.
6. Open a real file through the existing File System Access path. Windows
   should work. macOS and Linux should fail, and that failure is the measure of
   the remaining work.
7. Type in the editor for ten minutes. Watch for the WebKitGTK
   `contenteditable` and blur faults, on Linux only.

## 9. The .NET options

Added 2026-09-13, after the user asked. The server in `server/` is already
.NET, so one language across the whole project is a fair thing to want.

.NET has three candidates. Numbers read from the GitHub API on 2026-09-13.

| | Photino | Avalonia WebView | Electron.NET |
| --- | --- | --- | --- |
| Shape | thin webview host | full UI framework, webview control | Electron with .NET inside |
| Engine | the OS webview | the OS webview | bundled Chromium |
| Linux | yes | yes | yes |
| Stars | 1,336 | 130, inside Avalonia's 31,496 | 7,597 |
| Last push | 2026-03-26 | 2026-08-15 | 2026-09-10 |
| Needs Node | no | no | yes, Node 22 and npm |
| Native menu with accelerators | no | yes | yes |

### Photino

Closest in spirit to Tauri. A small native host, the OS webview, your web
files. It is the obvious first look and it fails on the one feature this whole
exercise is about.

Photino has no native menu bar. The request, `photino.Native` issue 43, has
been open since March 2021 and was last touched in December 2024. Without a
native menu there is no `Cmd+N` on macOS, because the macOS menu is the only
thing that can claim that chord. The project also advises anyone wanting
keyboard accelerators to open an issue and help build it.

The repository has not been pushed since 2026-03-26. That is the same day the
team announced a shift to AI-assisted maintenance, citing time constraints.
Linux reports include a black window on Mint, a glibc mismatch on Ubuntu 22.04,
a stale `libwebkit2gtk-4.0` dependency that blocks Flatpak, and a hang where a
started process never exits.

**Verdict: out.** It cannot do the one thing we need it for.

### Avalonia with the WebView control

The real .NET contender.

Avalonia is a mature cross-platform UI framework, 31,496 stars, used by
JetBrains, Unity and GitHub. Avalonia 12.0 shipped on 2026-04-07 and moved the
WebView control from the paid Accelerate tier into open source. It uses the
native renderer on each platform, with no bundled Chromium. Linux uses WPE
WebKit when present and WebKitGTK otherwise.

`NativeMenu` gives a real macOS menu bar, and menu items take gestures, so
`Cmd+N` and `Ctrl+N` both work. Avalonia adapts common hotkeys per platform.
There is two-way JavaScript interop.

The catch is age. `Avalonia.Controls.WebView` has 130 stars and 25 open issues,
and it became open source five months ago. Tauri has been doing this for six
years. You would be an early user of the exact component you depend on.

**Verdict: viable, and worth a look purely for the one-language argument.**

### Electron.NET

The only option here that solves the engine problem, because Chromium ships
inside. Your File System Access code would then run unchanged on all three
systems, and the Playwright gate would test the real engine again.

It needs Node 22 and npm in the build chain. That breaks the hard rule in
`motivation.txt`. It also carries Electron's size and an embedded ASP.NET Core
host. Recent versions can drop the ASP.NET part for a plain console host, which
suits us, since the files come from the web.

**Verdict: same trade as plain Electron.** Correctness bought with npm and
about 100 MB. Hold it in reserve for the case where WebKit fails the spike.

### What .NET does not change

Photino and Avalonia borrow the same three webviews as Tauri and Wails. So
every engine problem in sections 2, 4.2, 4.3 and 4.4 of this document applies
to them without change. The missing file picker API on macOS and Linux is still
the big job, and .NET does not shrink it. What .NET gives is a nicer language
for writing the native side, and the standard library for the file work.

## 10. Alternatives that were considered and dropped

**Electron.** The engine problem disappears, because Chromium ships inside. The
File System Access API then works on all three systems, unchanged. It breaks
the no-npm rule, adds about 100 MB per app, and still needs signing and an
updater. Reconsider only if the WebKit engines fail the spike badly.

**Keyboard Lock API.** Delivers Ctrl+N and Ctrl+W to the page, but only in
fullscreen. Wrong shape for an editor you switch away from.

**Chrome in app mode.** Still a browser window. Ctrl+N and Ctrl+W stay with
Chrome. No help.

**A minimal webview binding, such as webview_go.** Too small. No menus, no
accelerators, no updater. You would rebuild Wails, badly.

## 11. Decision

Agreed with the user on 2026-09-13.

**Target: Windows, Linux and macOS. All three.**

**Framework: Tauri.** The reasons, in the order that decided it:

1. It is mature. Six years, a stable v2 for two of them, 111,037 stars.
2. Multiple windows work today. The editor wants that.
3. The plugins already exist for the parts we will need: file dialogs, file
   system access with persisted scope, single instance, window state, file
   associations and an updater.
4. Rust and slow builds are a real cost, and the user accepts it, because the
   native side is small and Claude does the writing and the building.

**Rejected, and why:**

- **Wails (Go).** Faster builds and a smaller toolchain. The stable line, v2,
  is single-window. The multi-window line, v3, reached beta on 2026-08-02 and
  its tracker still lists 27 blocking issues. Reconsider if v3 goes stable and
  Tauri disappoints.
- **Photino (.NET).** No native menu bar, so no Cmd+N on macOS, which is the
  feature the wrapper exists for. The request has been open since March 2021.
  No push to the repository since 2026-03-26.
- **Avalonia (.NET).** The only serious .NET answer, and the only one with a
  one-language argument, since `server/` is already .NET. The WebView control
  went open source in April 2026 and has 130 stars. Too young to bet the disk
  layer on. Worth another look in a year.
- **Electron.NET.** The only option that bundles Chromium, so the current disk
  code would run unchanged everywhere. Needs Node 22 and npm, which
  `motivation.txt` forbids. Held in reserve if WebKit fails the spike.
- **.NET MAUI.** No Linux, and none planned. Microsoft lists Android, iOS, Mac
  Catalyst and Windows. The only Linux path is Avalonia's MAUI backend, a
  preview on a preview of .NET 11, which means depending on Avalonia anyway.
  MAUI has been in maintenance mode since .NET 8 and Microsoft laid off senior
  MAUI engineers in May 2025.

**What is still open**

- The remote URL against the bundled files, section 4.6. Start with the remote
  URL and keep the Pages deploy flow.
- The native disk backend for macOS and Linux, section 4.4. It is the large
  piece of work and it does not start until the spike passes.
- Signing. Unsigned means a warning on first launch on Windows and macOS. That
  is acceptable for a private tool.

**Next actions, in order**

1. Fix Ctrl+S in the browser. No wrapper, one change in
   `app/js/ui/shortcuts.js`. Independent of everything above.
2. Run the spike in section 8.
3. Only then plan the disk backend.

## Sources

Framework documentation and status:
- [Tauri Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)
- [Tauri configuration reference, frontendDist](https://v2.tauri.app/reference/config/)
- [Tauri frontend configuration](https://v2.tauri.app/start/frontend/)
- [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
- [Wails v3 Beta announcement](https://v3.wails.io/blog/wails-v3-beta/)
- [Wails v3 beta-to-GA release tracker](https://github.com/wailsapp/wails/issues/5844)
- [Wails v3 window options, remote URL](https://v3.wails.io/features/windows/options/)
- [Wails v3 menu reference](https://v3.wails.io/features/menus/reference/)
- [Wails v3 cross-platform building](https://v3.wails.io/guides/build/cross-platform/)
- [Wails file associations](https://wails.io/docs/next/guides/file-association/)
- [Wails Windows guide, WebView2 bootstrapper](https://wails.io/docs/guides/windows/)

Engine behaviour:
- [Microsoft, AreBrowserAcceleratorKeysEnabled](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.arebrowseracceleratorkeysenabled)
- [wry issue 569, WebView2 platform shortcuts](https://github.com/tauri-apps/wry/issues/569)
- [WebKit, App-Bound Domains](https://webkit.org/blog/10882/app-bound-domains/)
- [Capacitor, service workers in WKWebView need app-bound domains](https://github.com/ionic-team/capacitor/issues/4122)
- [wry discussion 1198, WKWebView data store identifiers](https://github.com/tauri-apps/wry/discussions/1198)
- [Tauri issue 11252, IndexedDB path changed in v2](https://github.com/tauri-apps/tauri/issues/11252)
- [Can I WebView, file system access](https://caniwebview.com/features/web-feature-file-system-access/)
- [MDN, storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [WebView2, CreateWebFileSystemDirectoryHandle](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createwebfilesystemdirectoryhandle)

Developer opinion:
- [Tauri discussion 3521, comparison with Wails](https://github.com/orgs/tauri-apps/discussions/3521)
- [Hacker News, system webviews as a UI foundation](https://news.ycombinator.com/item?id=47070409)
- [Hacker News, testing on multiple engines](https://news.ycombinator.com/item?id=41566033)
- [Tauri discussion 8524, WebKit instability, asking for Chromium](https://github.com/orgs/tauri-apps/discussions/8524)
- [Tauri issue 7021, WebKit2GTK 2.40 renders slowly](https://github.com/tauri-apps/tauri/issues/7021)
- [Tauri issue 14286, font weight offset on WebKitGTK](https://github.com/tauri-apps/tauri/issues/14286)
- [Tauri issue 7073, long compilation times](https://github.com/tauri-apps/tauri/issues/7073)
- [Playwright engine mismatch when testing Tauri](https://zudo-tauri-wisdom.takazudomodular.com/docs/frontend/playwright-engine-pitfall/)
- [NLnet, Servo webview for Tauri](https://nlnet.nl/project/Tauri-Servo/)

.NET options:
- [Photino](https://www.tryphotino.io/)
- [photino.Native issue 43, native menu support, open since 2021](https://github.com/tryphotino/photino.Native/issues/43)
- [photino.NET issue 258, black window on Linux](https://github.com/tryphotino/photino.NET/issues/258)
- [photino.Blazor issue 134, stale libwebkit2gtk dependency](https://github.com/tryphotino/photino.Blazor/issues/134)
- [Avalonia 12 release](https://avaloniaui.net/blog/avalonia-12)
- [The Avalonia WebView is going open source](https://avaloniaui.net/blog/the-avalonia-webview-is-going-open-source/)
- [Avalonia NativeMenu reference](https://docs.avaloniaui.net/docs/reference/controls/nativemenu)
- [Avalonia macOS platform guide](https://docs.avaloniaui.net/docs/platform-specific-guides/macos)
- [Electron.NET](https://github.com/ElectronNET/Electron.NET)
- [MAUI issue 11738, no Blazor Hybrid on Linux](https://github.com/dotnet/maui/issues/11738)
