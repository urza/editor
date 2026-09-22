//! The desktop shell: native windows around the deployed PWA, plus the
//! Sublime chords a browser cannot give up (desktop-wrapper.md). Nothing of
//! the editor lives here. The page comes from GitHub Pages, so a push to main
//! still updates the desktop app (desktop-wrapper-tauri-vs-wails.md §4.6,
//! shape A). Every window is a workspace (architecture.md §14): the main one
//! has the label "main" and the plain URL, the others "ws-<id>" and `?ws=<id>`.

mod debug;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Where the page comes from.
const APP_URL: &str = "https://urza.github.io/editor/";

/// The main workspace id (architecture.md §14): its window has no `?ws=`.
const MAIN: &str = "main";

/// Menu id, label, accelerator. The ids are the page's command ids
/// (app/js/commands/registry.js). The menu handler forwards them verbatim and
/// never knows what a command does, so a new chord is one line here and one
/// command on the page side. `CmdOrCtrl` gives Cmd on macOS and Ctrl elsewhere.
const CHORDS: [(&str, &str, &str); 4] = [
    ("buffer.new", "New", "CmdOrCtrl+N"),
    ("workspace.new", "New Window", "CmdOrCtrl+Shift+N"),
    ("buffer.save", "Save", "CmdOrCtrl+S"),
    ("buffer.close", "Close", "CmdOrCtrl+W"),
];

/// Shell-side menu item: closes the focused window natively, which the page
/// cannot do for a window it did not open. Goes through CloseRequested, so
/// the workspace dissolves like on any other close.
const CLOSE_WINDOW: &str = "shell.closeWindow";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![open_workspace, focus_workspace])
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if CHORDS.iter().any(|(chord, _, _)| *chord == id) {
                if let Some(window) = debug::target_window(app) {
                    forward_command(&window, id, None);
                }
            } else if id == CLOSE_WINDOW {
                if let Some(window) = debug::target_window(app) {
                    let _ = window.close();
                }
            } else {
                // Predefined items (Quit, Copy, ...) act on their own.
                debug::handle(app, id);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                on_close_requested(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            open_workspace_window(app.handle(), MAIN)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the vrtti desktop shell");
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

/// Hand a command to a page as a DOM event. The page side is
/// app/js/ui/desktop.js. `id` comes from CHORDS or this file, `arg` is a
/// validated workspace id, so both are safe inside a JS string literal.
fn forward_command<R: Runtime>(window: &WebviewWindow<R>, id: &str, arg: Option<&str>) {
    let detail = match arg {
        Some(arg) if valid_workspace_id(arg) => format!("{{ id: '{id}', arg: '{arg}' }}"),
        Some(_) => return,
        None => format!("{{ id: '{id}' }}"),
    };
    let js = format!("window.dispatchEvent(new CustomEvent('vrtti:command', {{ detail: {detail} }}))");
    if let Err(err) = window.eval(js) {
        eprintln!("[vrtti] could not forward {id}: {err}");
    }
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
