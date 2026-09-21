//! The Debug menu. Everything here runs from the shell side, so it works even
//! when the page is an old build with no bridge, which is exactly the moment
//! the spike needs it: "which build am I on, and why does the update not come".

use tauri::menu::{Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const RELOAD: &str = "shell.reload";
const FORCE_UPDATE: &str = "shell.forceUpdate";
const DIAGNOSTICS: &str = "shell.diagnostics";
const DEVTOOLS: &str = "shell.devtools";

pub fn submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Debug")
        .text(RELOAD, "Reload page")
        .text(FORCE_UPDATE, "Force update (drop service worker and caches)")
        .separator()
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
        DIAGNOSTICS => eval(&window, DIAGNOSTICS_JS),
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

/// One dialog with the facts the spike asks for. Same-origin fetch, so the
/// Age header is readable and tells whether the CDN edge served a cached copy.
const DIAGNOSTICS_JS: &str = r#"(async () => {
  const lines = [];
  lines.push('shell: ' + JSON.stringify(window.vrttiDesktop));
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
    lines.push('storage persisted: ' + await navigator.storage.persisted());
  } catch (err) {
    lines.push('storage persisted: ' + err);
  }
  lines.push('bridge listener: ' + (window.vrtti ? 'page has test hook' : 'no test hook'));
  lines.push('user agent: ' + navigator.userAgent);
  const text = lines.join('\n');
  console.log('[vrtti shell diagnostics]\n' + text);
  alert(text);
})();"#;
