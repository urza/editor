//! Shell auto-update (architecture.md §18). A push to main replaces the
//! files on the desktop-latest release; this module is how an installed
//! shell learns about it. Rust only: the page has no updater permission and
//! never sees a check (desktop-wrapper-goose-patterns.md §7: one flag, one
//! env kill switch, quiet failures).
//!
//! The endpoint is one manifest per platform key,
//! `latest-{{target}}-{{arch}}.json`, each in the plugin's single-platform
//! format. Not one merged file: the plugin reads one `version` per manifest,
//! so a merged file would send a shell whose platform failed to build after
//! its own old file at every check, and ask again every six hours.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::debug;

const CHECK: &str = "shell.checkUpdates";
const ABOUT: &str = "shell.about";

/// Boot is not slowed: the first check waits this long after launch.
const FIRST_CHECK: Duration = Duration::from_secs(10);
const PERIOD: Duration = Duration::from_secs(6 * 60 * 60);

/// Covers the manifest request and the download alike (the plugin puts one
/// timeout on both requests). Long, because the AppImage is 80 MB; a stalled
/// check only keeps the busy flag for this long.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The env hooks, read once at startup (desktop-wrapper-goose-patterns.md
/// §6). A test of the real shell serves its own signed manifest with the
/// last two.
pub struct Hooks {
    /// `VRTTI_NO_UPDATE` set to anything: no automatic check. Help > Check
    /// for updates… still works.
    pub automatic: bool,
    /// `VRTTI_UPDATE_URL`: replaces the endpoint from tauri.conf.json.
    pub url: Option<String>,
    /// `VRTTI_UPDATE_PUBKEY`: replaces the public key from tauri.conf.json.
    pub pubkey: Option<String>,
}

impl Hooks {
    pub fn from_env() -> Self {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        Hooks {
            automatic: set("VRTTI_NO_UPDATE").is_none(),
            url: set("VRTTI_UPDATE_URL"),
            pubkey: set("VRTTI_UPDATE_PUBKEY"),
        }
    }
}

/// A download the user answered "Later" to. The next check offers it again
/// without a second download, as long as the release still says that
/// version; a newer release drops it.
struct Pending {
    version: String,
    bytes: Vec<u8>,
}

pub struct State {
    hooks: Hooks,
    pending: Mutex<Option<Pending>>,
    /// One check at a time. A click on the menu item during the automatic
    /// check or its download is logged and dropped, never a second dialog.
    busy: AtomicBool,
}

/// Registers the state and starts the check loop, unless the kill switch is
/// set or this copy cannot replace itself.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let hooks = Hooks::from_env();
    let automatic = hooks.automatic;
    app.manage(State {
        hooks,
        pending: Mutex::new(None),
        busy: AtomicBool::new(false),
    });
    if !automatic {
        eprintln!("[vrtti update] VRTTI_NO_UPDATE is set: no automatic check");
        return;
    }
    if let Some(reason) = not_updatable() {
        eprintln!("[vrtti update] no automatic check: {reason}");
        return;
    }
    let app = app.clone();
    // A plain thread: the check blocks on the network and on the dialog,
    // and a six-hour sleep needs no runtime.
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            check(&app, false);
            std::thread::sleep(PERIOD);
        }
    });
}

pub fn submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Help")
        .text(CHECK, "Check for updates…")
        .separator()
        .text(ABOUT, "About vrtti")
        .build()
}

/// Returns true when `id` was one of ours. Both items leave the main thread
/// at once: a dialog waited for on the main thread freezes the app
/// (tauri-plugin-dialog's note on `blocking_show`).
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let app = app.clone();
    match id {
        CHECK => {
            std::thread::spawn(move || check(&app, true));
        }
        ABOUT => {
            std::thread::spawn(move || about(&app));
        }
        _ => return false,
    }
    true
}

/// Why this copy cannot replace itself, or None when it can. The automatic
/// check stays off for such a copy; the menu item explains.
fn not_updatable() -> Option<&'static str> {
    #[cfg(windows)]
    {
        // The NSIS installer writes uninstall.exe next to the app
        // (tauri-bundler's installer.nsi). A bare vrtti.exe in a folder has
        // none: the updater would install a second copy elsewhere and this
        // one would ask again at every check.
        let installed = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(installed_beside))
            .unwrap_or(false);
        if !installed {
            return Some(
                "This copy is not installed, so it cannot update itself. \
                 Install vrtti-setup.exe once and run vrtti from the Start menu.",
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        // The plugin replaces the file named by APPIMAGE. Run as the bare
        // binary or from the deb, it would write the AppImage over the
        // executable instead.
        if std::env::var_os("APPIMAGE").is_none() {
            return Some(
                "This copy is not the AppImage, so it cannot update itself. \
                 The AppImage replaces itself; the deb and the bare binary do not.",
            );
        }
    }
    None
}

/// True when `dir` holds the NSIS uninstaller, which only an installed copy has.
#[cfg_attr(not(windows), allow(dead_code))]
fn installed_beside(dir: &std::path::Path) -> bool {
    dir.join("uninstall.exe").exists()
}

fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let state = app.state::<State>();
    if state.busy.swap(true, Ordering::SeqCst) {
        eprintln!("[vrtti update] a check is already running");
        return;
    }
    run_check(app, &state, manual);
    state.busy.store(false, Ordering::SeqCst);
}

/// One check. Every failure is one log line and no dialog, because an editor
/// must never nag about the network; only the menu item, which the user
/// clicked, may hear the reason or "up to date".
fn run_check<R: Runtime>(app: &AppHandle<R>, state: &State, manual: bool) {
    let current = app.package_info().version.to_string();
    if manual {
        if let Some(reason) = not_updatable() {
            say(app, "Check for updates", reason);
            return;
        }
    }
    let checked = updater(app, &state.hooks)
        .and_then(|updater| tauri::async_runtime::block_on(updater.check()).map_err(|err| err.to_string()));
    let update = match checked {
        Ok(Some(update)) => update,
        Ok(None) => {
            eprintln!("[vrtti update] {current} is up to date");
            if manual {
                say(app, "Check for updates", &format!("vrtti {current} is up to date."));
            }
            return;
        }
        Err(err) => {
            eprintln!("[vrtti update] check failed: {err}");
            if manual {
                say(app, "Check for updates", &format!("Could not check for updates.\n{err}"));
            }
            return;
        }
    };
    eprintln!("[vrtti update] {} is available, running {current}", update.version);
    let bytes = match take_pending(state, &update.version) {
        Some(bytes) => bytes,
        // The signature is verified inside download(); a bad one is an Err.
        None => match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("[vrtti update] download of {} failed: {err}", update.version);
                if manual {
                    say(app, "Check for updates", &format!("Could not download vrtti {}.\n{err}", update.version));
                }
                return;
            }
        },
    };
    offer(app, state, update, bytes);
}

/// The plugin's updater with the env hooks applied.
fn updater<R: Runtime>(app: &AppHandle<R>, hooks: &Hooks) -> Result<Updater, String> {
    let mut builder = app.updater_builder().timeout(TIMEOUT);
    if let Some(url) = &hooks.url {
        let url = tauri::Url::parse(url).map_err(|err| format!("VRTTI_UPDATE_URL: {err}"))?;
        builder = builder.endpoints(vec![url]).map_err(|err| err.to_string())?;
    }
    if let Some(pubkey) = &hooks.pubkey {
        builder = builder.pubkey(pubkey.clone());
    }
    builder.build().map_err(|err| err.to_string())
}

fn take_pending(state: &State, version: &str) -> Option<Vec<u8>> {
    let mut pending = state.pending.lock().unwrap_or_else(|err| err.into_inner());
    match pending.take() {
        Some(kept) if kept.version == version => Some(kept.bytes),
        _ => None,
    }
}

/// The downloaded update is ready: ask, then install and relaunch, or keep
/// the bytes for the next check.
fn offer<R: Runtime>(app: &AppHandle<R>, state: &State, update: Update, bytes: Vec<u8>) {
    let restart = ask(
        app,
        "Update ready",
        &format!("vrtti {} is ready. Restart now?", update.version),
        "Restart now",
        "Later",
    );
    if !restart {
        eprintln!("[vrtti update] later: {} stays downloaded", update.version);
        let mut pending = state.pending.lock().unwrap_or_else(|err| err.into_inner());
        *pending = Some(Pending {
            version: update.version,
            bytes,
        });
        return;
    }
    // Window bounds first: on Windows install() hands over to the installer
    // and exits this process itself, before any RunEvent.
    let _ = app.save_window_state(StateFlags::all());
    if let Err(err) = update.install(&bytes) {
        eprintln!("[vrtti update] install of {} failed: {err}", update.version);
        say(app, "Update failed", &format!("Could not install vrtti {}.\n{err}", update.version));
        return;
    }
    // Linux and macOS: the file is replaced, the running process is the old
    // one until it relaunches. Never reached on Windows.
    app.restart();
}

fn about<R: Runtime>(app: &AppHandle<R>) {
    let info = app.package_info();
    let mut text = format!(
        "vrtti {}\n{} {}",
        info.version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    // The page reports its build with page_ready (app/js/ui/desktop.js); an
    // older page reports none and the line is absent.
    let build = debug::target_window(app).and_then(|window| crate::page_build(app, window.label()));
    if let Some(build) = build {
        text.push_str(&format!("\npage build {build}"));
    }
    say(app, "About vrtti", &text);
}

/// A dialog modal to the focused window, so it cannot end up behind it.
fn dialog<R: Runtime>(app: &AppHandle<R>, title: &str, text: &str) -> MessageDialogBuilder<R> {
    let mut builder = app.dialog().message(text).title(title).kind(MessageDialogKind::Info);
    if let Some(window) = debug::target_window(app) {
        builder = builder.parent(&window);
    }
    builder
}

fn say<R: Runtime>(app: &AppHandle<R>, title: &str, text: &str) {
    ask_buttons(dialog(app, title, text));
}

/// True for the first button. Same shape as the pickers in disk.rs: the
/// callback API plus our own channel, so a dialog the OS never opened
/// answers "no" instead of panicking inside the plugin's blocking variant.
fn ask<R: Runtime>(app: &AppHandle<R>, title: &str, text: &str, yes: &str, no: &str) -> bool {
    ask_buttons(
        dialog(app, title, text).buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into())),
    )
}

fn ask_buttons<R: Runtime>(builder: MessageDialogBuilder<R>) -> bool {
    let (tx, rx) = mpsc::channel();
    builder.show(move |answer| {
        let _ = tx.send(answer);
    });
    rx.recv().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooks(vars: &[(&str, &str)]) -> Hooks {
        Hooks::from_vars(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn hooks_default_to_automatic_and_the_config() {
        let h = hooks(&[]);
        assert!(h.automatic);
        assert_eq!(h.url, None);
        assert_eq!(h.pubkey, None);
    }

    #[test]
    fn any_value_of_no_update_disables_the_automatic_check() {
        assert!(!hooks(&[("VRTTI_NO_UPDATE", "1")]).automatic);
        assert!(!hooks(&[("VRTTI_NO_UPDATE", "yes")]).automatic);
        // Empty is unset: a `VRTTI_NO_UPDATE=` in a launcher means nothing.
        assert!(hooks(&[("VRTTI_NO_UPDATE", "")]).automatic);
        assert!(hooks(&[("VRTTI_NO_UPDATE", "  ")]).automatic);
    }

    #[test]
    fn url_and_pubkey_override_the_config() {
        let h = hooks(&[
            ("VRTTI_UPDATE_URL", "http://127.0.0.1:8000/latest.json"),
            ("VRTTI_UPDATE_PUBKEY", "dW50cnVzdGVk"),
        ]);
        assert_eq!(h.url.as_deref(), Some("http://127.0.0.1:8000/latest.json"));
        assert_eq!(h.pubkey.as_deref(), Some("dW50cnVzdGVk"));
    }

    #[test]
    fn installed_means_the_uninstaller_sits_beside_the_exe() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!installed_beside(dir.path()));
        std::fs::write(dir.path().join("uninstall.exe"), b"").unwrap();
        assert!(installed_beside(dir.path()));
    }
}
