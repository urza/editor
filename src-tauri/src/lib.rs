//! The desktop shell: native windows around the deployed PWA, plus the
//! Sublime chords a browser cannot give up (desktop-wrapper.md). Nothing of
//! the editor lives here. The page comes from GitHub Pages, so a push to main
//! still updates the desktop app (desktop-wrapper-tauri-vs-wails.md §4.6,
//! shape A). Every window is a workspace (architecture.md §14): the main one
//! has the label "main" and the plain URL, the others "ws-<id>" and `?ws=<id>`.

mod debug;
mod disk;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Where the page comes from.
const APP_URL: &str = "https://urza.github.io/editor/";

/// The main workspace id (architecture.md §14): its window has no `?ws=`.
const MAIN: &str = "main";

/// Menu id, label, accelerator. The ids are the page's command ids
/// (app/js/commands/registry.js). The menu handler forwards them verbatim and
/// never knows what a command does, so a new chord is one line here and one
/// command on the page side. `CmdOrCtrl` gives Cmd on macOS and Ctrl elsewhere.
const CHORDS: [(&str, &str, &str); 5] = [
    ("buffer.new", "New", "CmdOrCtrl+N"),
    ("workspace.new", "New Window", "CmdOrCtrl+Shift+N"),
    ("buffer.save", "Save", "CmdOrCtrl+S"),
    ("buffer.close", "Close", "CmdOrCtrl+W"),
    ("search.inFiles", "Find in Files…", "CmdOrCtrl+Shift+F"),
];

/// Shell-side menu item: closes the focused window natively, which the page
/// cannot do for a window it did not open. Goes through CloseRequested, so
/// the workspace dissolves like on any other close.
const CLOSE_WINDOW: &str = "shell.closeWindow";

/// The ready handshake (desktop-wrapper-goose-patterns.md §1). A command for
/// a window whose page has no listener yet waits here; the page calls
/// `page_ready` once its bridge listens, and the queue drains. A page load
/// starting again (reload, Force update) takes the window back to not ready.
#[derive(Default)]
struct Shell {
    ready: HashSet<String>,
    pending: HashMap<String, Vec<(String, Option<String>)>>,
}

/// A page that never calls `page_ready` is an older build of the page: the
/// service worker or the CDN edge can serve one for a while after a deploy.
/// The shell must not go deaf on it, so this long after a page load finishes
/// the window counts as ready anyway. The new page calls in well before.
const READY_FALLBACK: Duration = Duration::from_secs(8);

pub fn run() {
    let app = tauri::Builder::default()
        // First, as its docs require. A second launch on Windows or Linux
        // hands its arguments to this instance and exits; two processes on
        // one WebView2 profile would not even open (goose patterns §2).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_or_focus(app.clone(), MAIN);
        }))
        // Every window remembers its own bounds, by label (goose patterns §2:
        // the plugin saves and restores the same bounds flavour, which is
        // the trap goose fell into with a hand-written keeper).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // The three file pickers of the native disk backend (architecture.md
        // §17). Only src/disk.rs calls it: the capability grants the page no
        // dialog permission, so a page script cannot open a picker by itself.
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(Shell::default()))
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            focus_workspace,
            close_workspace,
            page_ready,
            disk::disk_pick_folder,
            disk::disk_pick_file,
            disk::disk_pick_save,
            disk::disk_list,
            disk::disk_stat,
            disk::disk_read,
            disk::disk_read_bytes,
            disk::disk_write,
            disk::disk_rename,
            disk::disk_prune
        ])
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if CHORDS.iter().any(|(chord, _, _)| *chord == id) {
                if let Some(window) = debug::target_window(app) {
                    forward_command(&window, id, None);
                }
            } else if id == CLOSE_WINDOW {
                // Only a window that really has focus, never a guessed one
                // (goose patterns §2): a guess could close main at launch.
                if let Some(window) = app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    let _ = window.close();
                }
            } else {
                // Predefined items (Quit, Copy, ...) act on their own.
                debug::handle(app, id);
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } => {
                // The plugin saves on RunEvent::Exit only, and the last window
                // closing on Linux exited without that event in the harness.
                // Save here, while the closing window still has its bounds.
                let _ = window.app_handle().save_window_state(StateFlags::all());
                on_close_requested(window.app_handle(), window.label());
            }
            WindowEvent::Destroyed => forget_window(window.app_handle(), window.label()),
            _ => {}
        })
        .setup(|app| {
            // The roots load before the first window, so a page that asks for
            // its folder at boot finds the record already there.
            app.manage(disk::Disk::load(app.handle()));
            open_workspace_window(app.handle(), MAIN)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the vrtti desktop shell");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = &event {
            let _ = app.save_window_state(StateFlags::all());
        }
        // macOS keeps running with no window and comes back from the dock
        // (goose patterns §2). Closing the last window there is not a quit;
        // Cmd+Q is, and it arrives with an exit code.
        #[cfg(target_os = "macos")]
        match event {
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => open_or_focus(app.clone(), MAIN),
            _ => {}
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, &event);
    });
}

/// Open a workspace window from an event handler. Window creation in a
/// handler deadlocks on Windows (tauri's note on `WebviewWindowBuilder`),
/// so the work moves to the async runtime, from where the builder hops to
/// the main thread by itself. Focus alone is safe anywhere.
fn open_or_focus<R: Runtime>(app: AppHandle<R>, ws: &'static str) {
    if let Some(window) = app.get_webview_window(&label_for(ws)) {
        let _ = window.set_focus();
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = open_workspace_window(&app, ws) {
            eprintln!("[vrtti] could not open {ws}: {err}");
        }
    });
}

/// A workspace id is "main" or a UUID. Anything else is refused before it
/// reaches a URL, a window label, or a JS string literal.
fn valid_workspace_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn label_for(ws: &str) -> String {
    if ws == MAIN {
        MAIN.to_string()
    } else {
        format!("ws-{ws}")
    }
}

fn workspace_of(label: &str) -> &str {
    label.strip_prefix("ws-").unwrap_or(label)
}

/// The one window factory (desktop-wrapper-goose-patterns.md §2). A window
/// that already exists for the workspace comes forward instead.
fn open_workspace_window<R: Runtime>(app: &AppHandle<R>, ws: &str) -> tauri::Result<()> {
    if !valid_workspace_id(ws) {
        return Ok(());
    }
    let label = label_for(ws);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
        return Ok(());
    }
    let mut url: tauri::Url = APP_URL.parse().expect("APP_URL is a valid URL");
    if ws != MAIN {
        url.set_query(Some(&format!("ws={ws}")));
    }
    // Runs before any page script, so app/js/model/capabilities.js can read
    // it synchronously at import time. The marker is the page's knowledge of
    // the shell; the two commands in the capability are its way back.
    let marker = format!(
        "window.vrttiDesktop = {{ platform: '{}', version: '{}' }};\n{}",
        std::env::consts::OS,
        env!("CARGO_PKG_VERSION"),
        debug::RECORDER_JS
    );
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("vrtti")
        .inner_size(1100.0, 760.0)
        .initialization_script(marker)
        // A new page load means a page without listeners until it says so,
        // or until the fallback decides it is an old page that never will.
        .on_page_load(|window, payload| match payload.event() {
            PageLoadEvent::Started => mark_not_ready(window.app_handle(), window.label()),
            PageLoadEvent::Finished => {
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(READY_FALLBACK);
                    if is_ready(window.app_handle(), window.label()) {
                        return;
                    }
                    eprintln!("[vrtti] no page_ready from {}: an older page, draining", window.label());
                    for (id, arg) in take_pending(window.app_handle(), window.label()) {
                        eval_command(&window, &id, arg.as_deref());
                    }
                });
            }
        })
        // Spike diagnostics: Ctrl+Shift+I (Cmd+Option+I) opens the console.
        .devtools(true)
        .build()?;
    Ok(())
}

/// Closing a secondary window dissolves its workspace, and a surviving
/// window's page does that (architecture.md §14.4), main first. The last
/// window closing is a quit, and a quit keeps every workspace, so nothing
/// happens then. Main itself is never dissolved.
fn on_close_requested<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let ws = workspace_of(label);
    if ws == MAIN {
        return;
    }
    let survivor = app
        .get_webview_window(MAIN)
        .or_else(|| app.webview_windows().into_iter().find(|(l, _)| l != label).map(|(_, w)| w));
    if let Some(window) = survivor {
        forward_command(&window, "workspace.dissolve", Some(ws));
    }
}

/// Hand a command to a page as a DOM event, or queue it until the page is
/// ready. The page side is app/js/ui/desktop.js. `id` comes from CHORDS or
/// this file, `arg` is a validated workspace id, so both are safe inside a
/// JS string literal.
fn forward_command<R: Runtime>(window: &WebviewWindow<R>, id: &str, arg: Option<&str>) {
    if let Some(arg) = arg {
        if !valid_workspace_id(arg) {
            return;
        }
    }
    if queue_unless_ready(window.app_handle(), window.label(), id, arg) {
        return;
    }
    eval_command(window, id, arg);
}

// The three lock helpers are statement-only on purpose: a guard used in a
// block's tail expression outlives the block's locals in edition 2021, and
// the borrow checker refuses it.

/// True when the command was queued because the page is not ready yet.
fn queue_unless_ready<R: Runtime>(app: &AppHandle<R>, label: &str, id: &str, arg: Option<&str>) -> bool {
    let state = app.state::<Mutex<Shell>>();
    // A poisoned lock still holds a usable set; nothing here panics halfway.
    let mut shell = state.lock().unwrap_or_else(|err| err.into_inner());
    if shell.ready.contains(label) {
        return false;
    }
    let queue = shell.pending.entry(label.to_string()).or_default();
    queue.push((id.to_string(), arg.map(String::from)));
    true
}

fn is_ready<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let state = app.state::<Mutex<Shell>>();
    let shell = state.lock().unwrap_or_else(|err| err.into_inner());
    let ready = shell.ready.contains(label);
    ready
}

fn mark_not_ready<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<Mutex<Shell>>();
    let mut shell = state.lock().unwrap_or_else(|err| err.into_inner());
    shell.ready.remove(label);
}

fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<Mutex<Shell>>();
    let mut shell = state.lock().unwrap_or_else(|err| err.into_inner());
    shell.ready.remove(label);
    shell.pending.remove(label);
}

/// Mark the page ready and return what waited for it.
fn take_pending<R: Runtime>(app: &AppHandle<R>, label: &str) -> Vec<(String, Option<String>)> {
    let state = app.state::<Mutex<Shell>>();
    let mut shell = state.lock().unwrap_or_else(|err| err.into_inner());
    shell.ready.insert(label.to_string());
    let queued = shell.pending.remove(label).unwrap_or_default();
    queued
}

fn eval_command<R: Runtime>(window: &WebviewWindow<R>, id: &str, arg: Option<&str>) {
    let detail = match arg {
        Some(arg) => format!("{{ id: '{id}', arg: '{arg}' }}"),
        None => format!("{{ id: '{id}' }}"),
    };
    let js = format!("window.dispatchEvent(new CustomEvent('vrtti:command', {{ detail: {detail} }}))");
    if let Err(err) = window.eval(js) {
        eprintln!("[vrtti] could not forward {id}: {err}");
    }
}

/// The page asks to close a window: Ctrl+Shift+W arrives as a keydown on
/// Windows, where menu accelerators do not fire while the webview has focus
/// (architecture.md §15), so the native Close Window item alone was dead
/// there. close() goes through CloseRequested, so the workspace dissolves
/// like on any other close.
#[tauri::command]
async fn close_workspace<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    if !valid_workspace_id(&id) {
        return Err("invalid workspace id".into());
    }
    match app.get_webview_window(&label_for(&id)) {
        Some(window) => window.close().map_err(|err| err.to_string()),
        None => Err("no window for that workspace".into()),
    }
}

/// The page's bridge listens now: drain what waited for this window.
#[tauri::command]
fn page_ready<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let queued = take_pending(window.app_handle(), window.label());
    for (id, arg) in queued {
        eval_command(&window, &id, arg.as_deref());
    }
    Ok(())
}

/// The page asks for a window: `workspace.new` made the record, this opens
/// it. Also how main reopens every workspace at launch.
///
/// `async` is load-bearing: a synchronous command runs on the main thread,
/// and on Windows the window builder deadlocks there (tauri's own note on
/// `WebviewWindowBuilder::new`). The first build froze both windows exactly
/// like that. An async command runs on the runtime's thread and the builder
/// hops to the main thread by itself.
#[tauri::command]
async fn open_workspace<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    open_workspace_window(&app, &id).map_err(|err| err.to_string())
}

/// A buffer is open in another window: that window comes forward. Async for
/// the same reason as `open_workspace`, although set_focus alone is safe.
#[tauri::command]
async fn focus_workspace<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    if !valid_workspace_id(&id) {
        return Err("invalid workspace id".into());
    }
    match app.get_webview_window(&label_for(&id)) {
        Some(window) => window.set_focus().map_err(|err| err.to_string()),
        None => Err("no window for that workspace".into()),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut file = SubmenuBuilder::new(app, "File");
    for (id, label, accelerator) in CHORDS {
        let item = MenuItemBuilder::with_id(id, label)
            .accelerator(accelerator)
            .build(app)?;
        file = file.item(&item);
    }
    let close_window = MenuItemBuilder::with_id(CLOSE_WINDOW, "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    file = file.separator().item(&close_window);
    // macOS quits from the application menu; Windows and Linux expect File > Quit.
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    let file = file.build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        // The first submenu is the application menu on macOS.
        let app_menu = SubmenuBuilder::new(app, "vrtti")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu = menu.item(&file);
    #[cfg(target_os = "macos")]
    {
        // Without these items WKWebView has no Cmd+C/V/X/A at all: on macOS
        // the edit chords are menu key equivalents, not browser defaults.
        // Windows and Linux get them from the webview itself, and a menu copy
        // there would fight CodeMirror for the keys.
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        menu = menu.item(&edit);
    }
    // Spike tooling (src/debug.rs). Stays until the shell is past the spike.
    menu = menu.item(&debug::submenu(app)?);
    menu.build()
}
