//! The Debug menu. Everything here runs from the shell side, so it works even
//! when the page is an old build with no bridge, which is exactly the moment
//! the spike needs it: "which build am I on, and why does the update not come".

use tauri::menu::{Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const RELOAD: &str = "shell.reload";
const FORCE_UPDATE: &str = "shell.forceUpdate";
const DIAGNOSTICS: &str = "shell.diagnostics";
const REPORT: &str = "shell.report";
const DEVTOOLS: &str = "shell.devtools";

pub fn submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Debug")
        .text(RELOAD, "Reload page")
        .text(FORCE_UPDATE, "Force update (drop service worker and caches)")
        .separator()
        .text(REPORT, "Copy spike report to clipboard")
        .text(DIAGNOSTICS, "Diagnostics…")
        .text(DEVTOOLS, "Open inspector")
        .build()
}

/// Returns true when `id` was one of ours.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let Some(window) = target_window(app) else {
        return false;
    };
    match id {
        RELOAD => eval(&window, "location.reload()"),
        FORCE_UPDATE => eval(&window, FORCE_UPDATE_JS),
        DIAGNOSTICS => eval(&window, &report_js(SHOW_TAIL)),
        REPORT => eval(&window, &report_js(COPY_TAIL)),
        DEVTOOLS => window.open_devtools(),
        _ => return false,
    }
    true
}

/// The focused window, else "main": the moment right after launch reports no
/// focus on some platforms.
pub fn target_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

fn eval<R: Runtime>(window: &WebviewWindow<R>, js: &str) {
    if let Err(err) = window.eval(js) {
        eprintln!("[vrtti] eval failed: {err}");
    }
}

/// Unregister the service worker, delete its caches, and navigate again with a
/// query string. The query makes the CDN edge fetch index.html from the origin
/// instead of serving a copy cached before the deploy; the module files still
/// go through the edge, so a very fresh deploy can need a second run.
const FORCE_UPDATE_JS: &str = r#"(async () => {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch (err) {
    console.log('[vrtti shell] force update:', err);
  }
  location.replace(location.pathname + '?fresh=' + Date.now());
})();"#;

/// Injected with the marker before any page script (lib.rs), on every page
/// load. Records every chord delivery since launch, so the report can say
/// which path carried each chord on this platform, plus page errors.
pub const RECORDER_JS: &str = r#"(() => {
  const log = (window.vrttiDesktop.log = []);
  const stamp = () => new Date().toISOString().slice(11, 23);
  window.addEventListener('vrtti:command', (e) => {
    log.push(stamp() + ' menu event ' + (e.detail && e.detail.id));
  });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !['KeyN', 'KeyS', 'KeyW'].includes(e.code)) return;
    // Read after every listener ran: defaultPrevented then says whether the
    // page's bridge (app/js/ui/desktop.js) took the key.
    setTimeout(() => log.push(stamp() + ' keydown ' + e.code
      + (e.defaultPrevented ? ' (page handled it)' : ' (page did not handle it)')), 0);
  });
  window.addEventListener('error', (e) => log.push(stamp() + ' page error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) =>
    log.push(stamp() + ' unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
})();"#;

/// The facts the spike asks for, as text. Same-origin fetch, so the Age
/// header is readable and tells whether the CDN edge served a cached copy.
const REPORT_BODY: &str = r#"
  const lines = [];
  const d = window.vrttiDesktop || {};
  lines.push('vrtti spike report ' + new Date().toISOString());
  lines.push('shell: ' + JSON.stringify({ platform: d.platform, version: d.version }));
  lines.push('page build: ' + (document.getElementById('status-build')?.textContent || '?'));
  lines.push('url: ' + location.href);
  try {
    const r = await fetch('./js/version.js', { cache: 'no-store' });
    const m = (await r.text()).match(/"commit":\s*"([^"]+)"/);
    lines.push('server build: ' + (m ? m[1] : '?') + ' (http ' + r.status + ', edge age ' + (r.headers.get('age') ?? '-') + 's)');
  } catch (err) {
    lines.push('server build: fetch failed, ' + err);
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    lines.push('service worker: ' + (reg
      ? [reg.active && 'active', reg.waiting && 'waiting', reg.installing && 'installing'].filter(Boolean).join(', ') || 'registered, no worker'
      : 'not registered'));
    lines.push('controller: ' + (navigator.serviceWorker.controller ? 'yes' : 'no'));
  } catch (err) {
    lines.push('service worker: ' + err);
  }
  try {
    lines.push('caches: ' + ((await caches.keys()).join(', ') || 'none'));
  } catch (err) {
    lines.push('caches: ' + err);
  }
  try {
    lines.push('storage persist(): ' + await navigator.storage.persist() + ', persisted(): ' + await navigator.storage.persisted());
  } catch (err) {
    lines.push('storage persist: ' + err);
  }
  lines.push('file system access: ' + ('showDirectoryPicker' in window) + ', save picker: ' + ('showSaveFilePicker' in window));
  lines.push('online: ' + navigator.onLine);
  lines.push('user agent: ' + navigator.userAgent);
  lines.push('');
  const log = d.log || [];
  lines.push('chord deliveries since launch (' + log.length + '):');
  for (const l of log) lines.push('  ' + l);
  const text = lines.join('\n');
  console.log('[vrtti shell report]\n' + text);
"#;

/// Diagnostics…: show the report.
const SHOW_TAIL: &str = "alert(text);";

/// Copy spike report: clipboard via the Tauri plugin (the page origin holds
/// clipboard-manager:allow-write-text), then the browser clipboard, then a
/// dialog with the text as the last resort.
const COPY_TAIL: &str = r#"
  let copied = false;
  try {
    const t = window.__TAURI__;
    if (t && t.clipboardManager) { await t.clipboardManager.writeText(text); copied = true; }
    else if (t && t.core) { await t.core.invoke('plugin:clipboard-manager|write_text', { data: text }); copied = true; }
    else lines.push('clipboard: window.__TAURI__ missing');
  } catch (err) {
    lines.push('clipboard plugin failed: ' + err);
  }
  if (!copied) {
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch (err) { lines.push('navigator.clipboard failed: ' + err); }
  }
  alert(copied
    ? 'Spike report copied to the clipboard (' + lines.length + ' lines). Paste it to Claude.'
    : 'Could not copy. The report:\n\n' + lines.join('\n'));
"#;

fn report_js(tail: &str) -> String {
    format!("(async () => {{\n{REPORT_BODY}\n{tail}\n}})();")
}
