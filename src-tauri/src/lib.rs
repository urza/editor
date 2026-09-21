//! The desktop shell: one native window around the deployed PWA, plus the
//! three Sublime chords a browser cannot give up (desktop-wrapper.md).
//! Nothing of the editor lives here. The page comes from GitHub Pages, so a
//! push to main still updates the desktop app (desktop-wrapper-tauri-vs-wails.md
//! §4.6, shape A).

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Where the page comes from.
const APP_URL: &str = "https://urza.github.io/editor/";

/// Menu id, label, accelerator. The ids are the page's command ids
/// (app/js/commands/registry.js). The menu handler forwards them verbatim and
/// never knows what a command does, so a new chord is one line here and one
/// command on the page side. `CmdOrCtrl` gives Cmd on macOS and Ctrl elsewhere.
const CHORDS: [(&str, &str, &str); 3] = [
    ("buffer.new", "New", "CmdOrCtrl+N"),
    ("buffer.save", "Save", "CmdOrCtrl+S"),
    ("buffer.close", "Close", "CmdOrCtrl+W"),
];

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // Predefined items (Quit, Copy, ...) act on their own.
            if CHORDS.iter().any(|(chord, _, _)| *chord == id) {
                forward_command(app, id);
            }
        })
        .setup(|app| {
            open_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the vrtti desktop shell");
}

/// The one window factory (desktop-wrapper-goose-patterns.md §2). Workspaces
/// (architecture.md §14) will add the `?ws=` parameter here and nowhere else.
fn open_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let url: tauri::Url = APP_URL.parse().expect("APP_URL is a valid URL");
    // Runs before any page script, so app/js/model/capabilities.js can read
    // it synchronously at import time. This marker is the page's only
    // knowledge of the shell; it never touches the Tauri IPC.
    let marker = format!(
        "window.vrttiDesktop = {{ platform: '{}', version: '{}' }};",
        std::env::consts::OS,
        env!("CARGO_PKG_VERSION")
    );
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("vrtti")
        .inner_size(1100.0, 760.0)
        .initialization_script(marker)
        // Spike diagnostics: Ctrl+Shift+I (Cmd+Option+I) opens the console.
        .devtools(true)
        .build()?;
    Ok(())
}

/// Hand a chord to the page as a DOM event. The page side is
/// app/js/ui/desktop.js. `id` comes from CHORDS only, so it is safe inside a
/// JS string literal.
fn forward_command<R: Runtime>(app: &AppHandle<R>, id: &str) {
    // The focused window gets the chord. With one window that is "main"; the
    // fallback covers the moment right after launch when nothing reports focus.
    let target = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    let Some(window) = target else { return };
    let js = format!(
        "window.dispatchEvent(new CustomEvent('vrtti:command', {{ detail: {{ id: '{id}' }} }}))"
    );
    if let Err(err) = window.eval(js) {
        eprintln!("[vrtti] could not forward {id}: {err}");
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
    menu.build()
}
