# Desktop wrapper: can a native shell give back Ctrl+N, Ctrl+S, Ctrl+W?

Status: analysis only, 2026-09-13. Nothing is decided and nothing is built.
Question from the user: the PWA cannot use the Sublime chords, so would a thin
wrapper in Rust or Go make this a real desktop app?

Short answer: yes, it is possible, and it is a small project. But one of the
three keys does not need a wrapper at all.

A framework comparison follows in `desktop-wrapper-tauri-vs-wails.md`.
That document ends with the decision: Tauri, for all three systems.

## Ctrl+S works in the browser today

Chrome, Edge and Firefox let a page cancel Ctrl+S with `preventDefault` on
keydown. Google Docs and VS Code for the web do this. The app never tries.
The handler in `app/js/ui/shortcuts.js` returns early on every Ctrl chord:

```js
// Ctrl/Meta chords stay with the browser; Alt is our modifier space
if (event.ctrlKey || event.metaKey) return;
```

One small change fixes it. Only Ctrl+N, Ctrl+W, Ctrl+T and their Shift
variants are reserved by Chrome. No page and no installed PWA can take those.

## What the wrapper is

Tauri (Rust) or Wails (Go) open a native window that holds the OS webview:

| Platform | Engine |
| --- | --- |
| Windows | WebView2 (Chromium) |
| macOS | WKWebView (Safari) |
| Linux | WebKitGTK |

The binary is a few megabytes. Both tools build without Node, so the "no npm"
rule in `motivation.txt` holds. The web code does not change. One new folder
holds the native shell.

## Why the shortcuts then work

A webview has no tabs and no browser window. Ctrl+N and Ctrl+W are not browser
commands inside it, so the keydown event reaches the page and `preventDefault`
works. The stronger way is to declare the chords as native menu accelerators.
The native side then sends an event to JS, and JS calls the existing command
registry. On macOS that is the only reliable way, because the system menu owns
Cmd+W.

## What it means in practice

- **Two shapes of one app.** The PWA stays for the phone and for any other
  computer. The desktop binary is an extra shape, not a replacement.
- **Where the files come from.** The window can point at the deployed URL on
  GitHub Pages. Updates then stay automatic and the service worker still works.
  Tauri restricts native calls from a remote origin, so that origin needs an
  allowlist entry. The other option bundles the files into the binary, which
  needs a rebuild per release.
- **Data does not carry over.** The webview has its own storage profile.
  IndexedDB from Chrome is not visible there. Server sync fills a fresh
  install, so this costs little.
- **Disk files are the real work item.** WebView2 supports the File System
  Access API, but stored handles do not survive a restart there. WKWebView and
  WebKitGTK do not have the API at all. So macOS and Linux need a native disk
  backend through the Tauri file system plugin. The feature switch in
  `app/js/model/capabilities.js` is the right place for that second backend.
  On Windows the Rust side can inject handles with
  `CreateWebFileSystemDirectoryHandle` and get persistence back.
- **Distribution is the ongoing cost.** Today a push to main deploys. A desktop
  app needs a build per OS, code signing (macOS notarization, or a SmartScreen
  warning on Windows) and an updater. This part stays with the project forever.
- **Rendering differences.** On macOS and Linux the engine is WebKit, not
  Chromium. CodeMirror is fine there. The WASM spellcheck and the age crypto
  need a test.

## Recommendation

Superseded on 2026-09-13. The user rejected shipping Ctrl+S on its own:
"either all of them or nothing". Half the muscle memory is worse than none,
because the hand still has to remember which chord belongs to which key.

So Ctrl+S is no longer a separate step. It ships with Ctrl+N and Ctrl+W, in
the wrapper, or it does not ship. The current plan is section 11 of
`desktop-wrapper-tauri-vs-wails.md`.

The fact above still holds and still matters: Ctrl+S is the one chord that
needs no native menu on any platform. That makes it the cheapest of the three
to wire up, not a reason to ship it first.

## The one alternative without a wrapper

The Keyboard Lock API delivers Ctrl+W and Ctrl+N to the page, but only while
the page is in fullscreen mode. That does not fit an editor you switch to and
from.

## Sources

- [File System Access API without security prompts (WebView2 feedback)](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3121)
- [Sending File System Access API handles from WebView2 code](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3706)
- [CreateWebFileSystemDirectoryHandle (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createwebfilesystemdirectoryhandle)
- [Can I WebView: File system access](https://caniwebview.com/features/web-feature-file-system-access/)
- [CoreWebView2Settings.AreBrowserAcceleratorKeysEnabled](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.arebrowseracceleratorkeysenabled)
