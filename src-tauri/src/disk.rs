//! The native disk backend (architecture.md §17). Files and folders in the
//! desktop shell go through Rust, on all three systems: WebKit has no File
//! System Access API at all, and WebView2 forgets a stored handle's permission
//! at every restart (§15 spike log). One code path, real paths, no reconnect
//! click.
//!
//! The model: the user picks a folder or a file, Rust registers it as a *root*
//! under an id in `roots.json`, and every later command names that root id plus
//! a relative path. The page never sends a path it did not get from Rust, and
//! the root record *is* the grant, so a restart needs no click.
//!
//! The research behind the file handling is desktop-wrapper-goose-patterns.md
//! §3 (errors are data), §4 (confinement and the atomic write), §6 (config dir,
//! env override, temp plus rename), §8 (check the webview label on every
//! command) and §9 (Windows path traps).

use std::collections::HashMap;
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// Every fs call goes through fs-err, which puts the path into the io::Error
// message. std::fs says "No such file or directory" and names nothing, which
// is useless in a log from a user's machine (goose patterns §4).
use fs_err as fs;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// The on-disk format of `roots.json`. Bump only with a migration.
const ROOTS_VERSION: u32 = 1;

/// A root the page did not name in `disk_prune` survives this long anyway: a
/// picker open in another window registers its root before that window's page
/// knows the id, and a prune racing with it must not drop the fresh record.
const PRUNE_GRACE_MS: u64 = 60_000;

/// Serial number for temp file names, so two writes in the same process and the
/// same directory cannot collide. The pid alone only separates processes
/// (goose patterns §4, the `trust.rs` pattern).
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Errors are data (goose patterns §3)
// ---------------------------------------------------------------------------

/// A failed command answers with this object, never with a transport fault.
/// `code` is the machine-readable half and the page branches on it:
/// `storage/native.js` maps `notFound` to a `NotFoundError` DOMException and
/// `permission` to `NotAllowedError`, because `folders.js` and `search.js`
/// already branch on those DOMException names. Keep the strings in step with
/// that mapping.
///
/// A cancelled picker is not an error here: it is `Ok(None)`, and the adapter
/// turns that into the `AbortError` the page reads as "user cancelled".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskError {
    code: &'static str,
    message: String,
    path: Option<String>,
}

impl DiskError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
        }
    }

    fn at(code: &'static str, message: impl Into<String>, path: &Path) -> Self {
        Self {
            code,
            message: message.into(),
            path: Some(path.display().to_string()),
        }
    }

    fn unknown_root(id: &str) -> Self {
        Self::new("unknownRoot", format!("no root registered as {id}"))
    }

    fn outside_root(path: &Path) -> Self {
        Self::at("outsideRoot", "the path leaves its root", path)
    }

    fn not_found(path: &Path) -> Self {
        Self::at("notFound", "no such file or directory", path)
    }

    fn exists(path: &Path) -> Self {
        Self::at("exists", "a file with that name is already there", path)
    }

    /// `path` here is the file the call was about, which is not always the file
    /// the io error names (a temp file, for one), so both are kept.
    fn io(err: io::Error, path: &Path) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => "notFound",
            io::ErrorKind::PermissionDenied => "permission",
            io::ErrorKind::AlreadyExists => "exists",
            _ => "io",
        };
        Self::at(code, err.to_string(), path)
    }
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/// What the user picked. The page's `isSameEntry` is a field comparison on
/// these two, so a folder picked twice must come back as the same root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    File,
    Directory,
}

/// One registered root. `path` is what the picker returned and is what the
/// sidebar shows; `canonical` is the symlink-free form every confinement check
/// compares against. Both are stored, because a restart must not have to guess
/// which one it had.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    id: String,
    kind: RootKind,
    name: String,
    path: PathBuf,
    canonical: PathBuf,
    added_at: u64,
    /// The folder moved, the drive is gone, or the file was deleted outside the
    /// app. The record survives, so the page's workspace still names it, and
    /// every command on it answers `notFound` until the user picks it again.
    /// Recomputed at every load, so it is never read back from the file.
    #[serde(skip)]
    stale: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootsFile {
    version: u32,
    roots: Vec<Root>,
}

/// The store itself, free of Tauri, so the tests can drive it with a plain
/// path.
#[derive(Debug, Default)]
struct Roots {
    by_id: HashMap<String, Root>,
}

impl Roots {
    /// A missing or unreadable file is an empty store, never a failure: the
    /// shell must start even when the config dir is broken. The user then
    /// picks the folder again, which is one click, instead of a dead app.
    fn load_from(file: &Path) -> Roots {
        let mut roots = Roots::default();
        let text = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(err) => {
                if err.kind() != io::ErrorKind::NotFound {
                    eprintln!("[vrtti] could not read the roots file: {err}");
                }
                return roots;
            }
        };
        let parsed: RootsFile = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(err) => {
                eprintln!("[vrtti] the roots file does not parse, starting empty: {err}");
                return roots;
            }
        };
        if parsed.version != ROOTS_VERSION {
            eprintln!(
                "[vrtti] roots file version {} is not {ROOTS_VERSION}, starting empty",
                parsed.version
            );
            return roots;
        }
        for mut root in parsed.roots {
            // The stored canonical path is only a hint: a folder can move, and
            // a mount point can resolve elsewhere after a reboot. Recompute,
            // and mark the root stale when the path is gone.
            match canonical_for(root.kind, &root.path) {
                Ok(canonical) => {
                    root.canonical = canonical;
                    root.stale = false;
                }
                Err(_) => root.stale = true,
            }
            roots.by_id.insert(root.id.clone(), root);
        }
        roots
    }

    /// Temp file plus rename with a pid suffix (goose patterns §6). A fixed
    /// `.tmp` name lets two processes truncate each other's temp file.
    fn save_to(&self, file: &Path) -> io::Result<()> {
        let mut roots: Vec<Root> = self.by_id.values().cloned().collect();
        // Stable order, so the file does not churn between saves.
        roots.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        let json = serde_json::to_string_pretty(&RootsFile {
            version: ROOTS_VERSION,
            roots,
        })
        .map_err(io::Error::other)?;

        let dir = file.parent().unwrap_or_else(|| Path::new("."));
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "roots.json".to_string());
        let temp = dir.join(format!("{name}.tmp-{}", std::process::id()));

        let write = || -> io::Result<()> {
            let mut handle = fs::File::create(&temp)?;
            handle.write_all(json.as_bytes())?;
            // Rename alone orders the directory entry, not the data. Without
            // the flush a crash can leave the new name pointing at empty
            // blocks (goose patterns §4).
            handle.sync_all()?;
            drop(handle);
            fs::rename(&temp, file)
        };
        write().inspect_err(|_| {
            let _ = fs::remove_file(&temp);
        })
    }

    /// A folder picked twice is the same root, so the page's `isSameEntry`
    /// stays a field comparison and a second pick does not orphan the first
    /// record. Kind is part of the identity: the same path as a file root and
    /// as a folder root are two different things to the page.
    fn register(&mut self, kind: RootKind, path: PathBuf, canonical: PathBuf) -> Root {
        if let Some(existing) = self
            .by_id
            .values()
            .find(|root| root.kind == kind && root.canonical == canonical && !root.stale)
        {
            return existing.clone();
        }
        let name = display_name(&path);
        let root = Root {
            id: uuid::Uuid::new_v4().simple().to_string(),
            kind,
            name,
            path,
            canonical,
            added_at: now_ms(),
            stale: false,
        };
        self.by_id.insert(root.id.clone(), root.clone());
        root
    }

    fn get(&self, id: &str) -> Result<Root, DiskError> {
        self.by_id
            .get(id)
            .cloned()
            .ok_or_else(|| DiskError::unknown_root(id))
    }

    /// Drop every root the page no longer references. `now_ms` is a parameter
    /// so a test can age a root without sleeping.
    fn prune(&mut self, keep: &[String], now_ms: u64) -> usize {
        let before = self.by_id.len();
        self.by_id.retain(|id, root| {
            // A root younger than the grace window stays whatever the page
            // says: its window may not have heard about it yet.
            keep.iter().any(|kept| kept == id)
                || now_ms.saturating_sub(root.added_at) < PRUNE_GRACE_MS
        });
        before - self.by_id.len()
    }
}

/// The name the sidebar shows. A drive root ("C:\", "/") has no file name, so
/// fall back to the whole path rather than to an empty heading.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn ms_of(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

/// The canonical form a root is confined against.
///
/// A folder root canonicalizes whole. A file root canonicalizes its *parent*
/// and re-joins the name, for two reasons: `disk_pick_save` names a file that
/// does not exist yet (goose patterns §4, the `import_files.rs` note), and a
/// file the user picked through a symlink must keep pointing at the symlink,
/// not at its target.
fn canonical_for(kind: RootKind, path: &Path) -> io::Result<PathBuf> {
    match kind {
        RootKind::Directory => fs::canonicalize(path),
        RootKind::File => {
            let (parent, name) = split_parent(path)?;
            Ok(fs::canonicalize(parent)?.join(name))
        }
    }
}

fn split_parent(path: &Path) -> io::Result<(&Path, &std::ffi::OsStr)> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => Ok((parent, name)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} names no file in a directory", path.display()),
        )),
    }
}

// ---------------------------------------------------------------------------
// Path validation and confinement (goose patterns §4, architecture.md §17)
// ---------------------------------------------------------------------------

/// Validate a page-supplied relative path without touching the disk. "" is the
/// root itself. Everything else is segments split on '/'.
///
/// Rejected: an empty segment (so a leading '/' and a doubled '//' are out),
/// "." and "..", an interior NUL, and a backslash. The backslash is not a
/// separator here even on Windows: the page always speaks '/', so a backslash
/// in a segment is either an escape attempt or a name we cannot round-trip.
fn relative(path: &str) -> Result<PathBuf, DiskError> {
    let mut out = PathBuf::new();
    if path.is_empty() {
        return Ok(out);
    }
    for segment in path.split('/') {
        let bad = segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('\0')
            || segment.contains('\\');
        if bad {
            return Err(DiskError::new(
                "outsideRoot",
                format!("{path} is not a valid relative path"),
            ));
        }
        // PathBuf::push on Windows *replaces* the whole path when the segment
        // carries a drive prefix ("C:foo"), which would silently escape the
        // root. Demand exactly one normal component, which also re-rejects the
        // cases above on any platform.
        let mut parts = Path::new(segment).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(part)), None) if part.to_str() == Some(segment) => {}
            _ => {
                return Err(DiskError::new(
                    "outsideRoot",
                    format!("{path} is not a valid relative path"),
                ))
            }
        }
        out.push(segment);
    }
    Ok(out)
}

/// Join a relative path under a root and prove it stayed inside.
///
/// Medium weight by decision (architecture.md §17): the openat-with-O_NOFOLLOW
/// walk of goose's `supporting_files.rs` is for paths an attacker picks. Ours
/// come from a folder the user picked, so one canonicalize plus a prefix test
/// is the right trade. Canonical is compared to canonical, so Windows `\\?\`
/// verbatim prefixes match on both sides (goose patterns §9).
fn resolve(root: &Root, rel: &str, must_exist: bool) -> Result<PathBuf, DiskError> {
    if root.stale {
        return Err(DiskError::not_found(&root.path));
    }
    let rel_path = relative(rel)?;
    // Not `join`: joining an empty path appends a separator, and "note.md/" is
    // not the same thing to the OS as "note.md" (stat answers "Not a
    // directory"). "" means the root itself, so use the root path as it is.
    let target = if rel_path.as_os_str().is_empty() {
        root.path.clone()
    } else {
        root.path.join(&rel_path)
    };

    match root.kind {
        RootKind::File => {
            // A file root is exactly one file. Nothing lives "under" it.
            if !rel_path.as_os_str().is_empty() {
                return Err(DiskError::outside_root(&target));
            }
            // The file may not exist yet (disk_pick_save), so confine through
            // the parent, which must still be the directory we registered.
            let (parent, name) =
                split_parent(&target).map_err(|err| DiskError::io(err, &target))?;
            let canonical = fs::canonicalize(parent)
                .map_err(|err| DiskError::io(err, &target))?
                .join(name);
            if canonical != root.canonical {
                return Err(DiskError::outside_root(&target));
            }
        }
        RootKind::Directory => {
            // Canonicalize the target when the entry exists, so a symlink
            // pointing out of the root is caught here. When it does not exist
            // (a file disk_write is about to create), canonicalize the parent
            // instead, which also turns a missing parent into notFound.
            let anchor = if fs::symlink_metadata(&target).is_ok() {
                target.clone()
            } else {
                split_parent(&target)
                    .map_err(|err| DiskError::io(err, &target))?
                    .0
                    .to_path_buf()
            };
            let canonical = fs::canonicalize(&anchor).map_err(|err| DiskError::io(err, &target))?;
            if !canonical.starts_with(&root.canonical) {
                return Err(DiskError::outside_root(&target));
            }
        }
    }

    if must_exist {
        // metadata() follows symlinks, so a symlink whose target is gone reads
        // as notFound, which is what it is to the page.
        fs::metadata(&target).map_err(|err| DiskError::io(err, &target))?;
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// The atomic write (goose patterns §4)
// ---------------------------------------------------------------------------

/// Write `text` over `target` so a reader sees either the old file or the new
/// one, never a half-written one. Returns the new mtime in ms.
///
/// The temp file goes into the destination directory, so the rename stays on
/// one filesystem and cannot degrade into a copy.
fn atomic_write(target: &Path, text: &str) -> Result<f64, DiskError> {
    // Replace what the symlink points at, so the user's symlink survives the
    // save. `resolve` already proved the resolution stays inside the root.
    let target = match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            fs::canonicalize(target).map_err(|err| DiskError::io(err, target))?
        }
        _ => target.to_path_buf(),
    };

    let (dir, name) = split_parent(&target).map_err(|err| DiskError::io(err, &target))?;
    let temp = dir.join(format!(
        ".{}.tmp-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = write_then_rename(&temp, &target, text);
    if result.is_err() {
        // A failed write must not leave a dot-file behind in the user's folder.
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_then_rename(temp: &Path, target: &Path, text: &str) -> Result<f64, DiskError> {
    let mut handle = fs::File::create(temp).map_err(|err| DiskError::io(err, temp))?;
    handle
        .write_all(text.as_bytes())
        .map_err(|err| DiskError::io(err, temp))?;
    handle.sync_all().map_err(|err| DiskError::io(err, temp))?;
    drop(handle);

    #[cfg(unix)]
    {
        // A fresh temp file is 0644 minus the umask. Without this copy an
        // overwrite would quietly widen a 0600 file. Windows carries its ACL
        // through the rename, so it needs nothing here.
        if let Ok(meta) = std::fs::metadata(target) {
            let _ = fs::set_permissions(temp, meta.permissions());
        }
    }

    // Replaces an existing target on Unix and on Windows alike.
    fs::rename(temp, target).map_err(|err| DiskError::io(err, target))?;

    let meta = fs::metadata(target).map_err(|err| DiskError::io(err, target))?;
    Ok(meta.modified().map(ms_of).unwrap_or(0.0))
}

/// Rename one entry inside its own directory. `new_name` must be a single
/// valid segment, so a rename can never move a file somewhere else.
fn rename_in_place(dir: &Path, name: &str, new_name: &str) -> Result<(), DiskError> {
    // One segment, same rules as any relative path.
    let checked = relative(new_name)?;
    if checked.as_os_str().is_empty() || checked.components().count() != 1 {
        return Err(DiskError::new(
            "outsideRoot",
            format!("{new_name} is not a valid file name"),
        ));
    }
    if name == new_name {
        return Ok(());
    }
    let from = dir.join(name);
    let to = dir.join(new_name);
    // rename() would overwrite the other file without a word, so ask first.
    // A case-only rename on a case-insensitive filesystem lands here too; the
    // page offers no such rename today.
    if fs::symlink_metadata(&to).is_ok() {
        return Err(DiskError::exists(&to));
    }
    fs::rename(&from, &to).map_err(|err| DiskError::io(err, &from))
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// The disk backend's state: the roots, where they are written, and the test
/// hook. Lives in `app.manage()`.
pub struct Disk {
    roots: Mutex<Roots>,
    file: PathBuf,
    /// `VRTTI_TEST_PICK` makes every picker return this path with no dialog.
    /// Test-only, read once at startup (architecture.md §17), so a later
    /// environment change cannot surprise a running app.
    test_pick: Option<PathBuf>,
}

impl Disk {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Disk {
        let dir = config_dir(app);
        if let Err(err) = fs::create_dir_all(&dir) {
            eprintln!("[vrtti] could not create the config dir: {err}");
        }
        let file = dir.join("roots.json");
        let roots = Roots::load_from(&file);
        Disk {
            roots: Mutex::new(roots),
            file,
            test_pick: std::env::var_os("VRTTI_TEST_PICK").map(PathBuf::from),
        }
    }

    /// A poisoned lock is recovered, not propagated: the roots map holds no
    /// invariant a panic could have broken halfway, and a dead lock would kill
    /// every file operation for the rest of the session.
    fn lock(&self) -> std::sync::MutexGuard<'_, Roots> {
        self.roots.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn root(&self, id: &str) -> Result<Root, DiskError> {
        self.lock().get(id)
    }

    fn register(&self, kind: RootKind, path: PathBuf) -> Result<Root, DiskError> {
        let canonical = canonical_for(kind, &path).map_err(|err| DiskError::io(err, &path))?;
        let mut roots = self.lock();
        let root = roots.register(kind, path, canonical);
        // A failed save costs the root at the next restart, not now. Failing
        // the pick over it would be the worse trade.
        if let Err(err) = roots.save_to(&self.file) {
            eprintln!("[vrtti] could not save the roots file: {err}");
        }
        Ok(root)
    }
}

/// Where `roots.json` lives. `VRTTI_CONFIG_DIR` relocates it, which is what
/// makes the shell tests hermetic (goose patterns §6); it must be absolute,
/// because a relative one would follow the process's working directory.
fn config_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Some(raw) = std::env::var_os("VRTTI_CONFIG_DIR") {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            return path;
        }
        eprintln!(
            "[vrtti] VRTTI_CONFIG_DIR is not an absolute path, ignored: {}",
            path.display()
        );
    }
    // The dir is named by the bundle identifier io.github.urza.vrtti, which
    // never changes (architecture.md §15).
    app.path().app_config_dir().unwrap_or_else(|err| {
        eprintln!("[vrtti] no app config dir ({err}), falling back to the temp dir");
        std::env::temp_dir().join("io.github.urza.vrtti")
    })
}

// ---------------------------------------------------------------------------
// Provenance (goose patterns §8)
// ---------------------------------------------------------------------------

/// Every command checks which webview called it, on top of the capability's
/// origin rule. The labels are the ones lib.rs builds: "main" and "ws-<id>".
/// Tauri events and commands are open by default, so this is the second lock.
fn guard<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), DiskError> {
    let label = window.label();
    if label == "main" || label.starts_with("ws-") {
        return Ok(());
    }
    Err(DiskError::new(
        "permission",
        format!("the window {label} may not touch the disk"),
    ))
}

// ---------------------------------------------------------------------------
// The pickers
// ---------------------------------------------------------------------------

enum Picker {
    Folder,
    File,
    Save(String),
}

/// Open a native picker and wait for the answer.
///
/// The plugin's `blocking_*` variants are the documented shape for an async
/// command, but their macro is `sync_channel(0)` plus `rx.recv().unwrap()`,
/// and the callback path behind it swallows a failed `run_on_main_thread`
/// with `let _ =`. A picker the OS refused to open would then panic the
/// command instead of returning. The callback API plus our own channel gives
/// the same wait with "no answer" folded into the cancel case.
///
/// The plugin's own note (tauri-plugin-dialog desktop.rs): a `blocking_*`
/// picker must never run on the main thread, because the dialog itself is
/// created there through `run_on_main_thread` and would wait for a thread it
/// has blocked. Nothing here blocks a thread at all.
async fn pick<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    what: Picker,
) -> Option<PathBuf> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    // Modal to the window that asked, so the dialog cannot end up behind it.
    let builder = app.dialog().file().set_parent(window);
    match what {
        Picker::Folder => builder.pick_folder(move |picked| {
            // Capacity 1 and exactly one send, so a full channel is impossible;
            // a closed one means the command was dropped and the pick has
            // nowhere to go.
            let _ = tx.try_send(picked);
        }),
        Picker::File => builder.pick_file(move |picked| {
            let _ = tx.try_send(picked);
        }),
        Picker::Save(name) => builder.set_file_name(name).save_file(move |picked| {
            let _ = tx.try_send(picked);
        }),
    }
    // Outer None: the sender was dropped without an answer. Inner None: the
    // user cancelled. Both are "no pick".
    let picked = rx.recv().await.flatten()?;
    // FilePath is a path or a file:// URL (an Android content:// URI on
    // mobile), so never match on the variant. simplified() drops a Windows
    // `\\?\` prefix, which keeps the path we show the user readable; the
    // canonical form we confine against is computed separately.
    picked.simplified().into_path().ok()
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    kind: RootKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    size: u64,
    /// Milliseconds since the epoch, like `File.lastModified` on the page.
    mtime: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    mtime: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    path: String,
    name: String,
}

/// Pick a folder and register it as a root. `Ok(None)` is a cancelled picker.
///
/// Every command here is `async`, which is load-bearing for the same reason
/// `open_workspace` is (lib.rs): a synchronous command runs on the main thread,
/// and the picker needs that thread free to build its dialog.
#[tauri::command]
pub async fn disk_pick_folder<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    disk: State<'_, Disk>,
) -> Result<Option<Root>, DiskError> {
    guard(&window)?;
    if let Some(path) = disk.test_pick.clone() {
        return disk.register(RootKind::Directory, path).map(Some);
    }
    match pick(&app, &window, Picker::Folder).await {
        Some(path) => disk.register(RootKind::Directory, path).map(Some),
        None => Ok(None),
    }
}

/// Pick one existing file and register it as a file root.
#[tauri::command]
pub async fn disk_pick_file<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    disk: State<'_, Disk>,
) -> Result<Option<Root>, DiskError> {
    guard(&window)?;
    if let Some(path) = disk.test_pick.clone() {
        return disk.register(RootKind::File, path).map(Some);
    }
    match pick(&app, &window, Picker::File).await {
        Some(path) => disk.register(RootKind::File, path).map(Some),
        None => Ok(None),
    }
}

/// Ask where to save. The picked file usually does not exist yet, which is why
/// a file root canonicalizes through its parent.
#[tauri::command]
pub async fn disk_pick_save<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    disk: State<'_, Disk>,
    suggested_name: String,
) -> Result<Option<Root>, DiskError> {
    guard(&window)?;
    if let Some(path) = disk.test_pick.clone() {
        // A test hook pointing at a directory stands for "the user saved into
        // this folder under the suggested name"; one pointing at a file stands
        // for "the user picked this file".
        let target = match fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => path.join(&suggested_name),
            _ => path,
        };
        return disk.register(RootKind::File, target).map(Some);
    }
    match pick(&app, &window, Picker::Save(suggested_name)).await {
        Some(path) => disk.register(RootKind::File, path).map(Some),
        None => Ok(None),
    }
}

/// List one directory. Anything that is neither a file nor a directory, and
/// any name that is not valid UTF-8, is skipped: the page has no way to name
/// either.
#[tauri::command]
pub async fn disk_list<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
) -> Result<Vec<Entry>, DiskError> {
    guard(&window)?;
    let root = disk.root(&root)?;
    let dir = resolve(&root, &path, true)?;

    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| DiskError::io(err, &dir))? {
        let entry = entry.map_err(|err| DiskError::io(err, &dir))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // DirEntry::metadata() does *not* follow symlinks, so a symlinked
        // folder would list as neither file nor directory and vanish from the
        // tree. Stat the path instead. A broken symlink fails here and is
        // skipped, which is the right answer for a row the page cannot open.
        let Ok(meta) = fs::metadata(entry.path()) else {
            continue;
        };
        let kind = if meta.is_dir() {
            RootKind::Directory
        } else if meta.is_file() {
            RootKind::File
        } else {
            continue;
        };
        entries.push(Entry { name, kind });
    }
    // read_dir order is whatever the filesystem says and can differ between
    // two runs over the same folder. The page sorts for display; this only
    // keeps the wire answer stable, which is what a test can assert on.
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Size and mtime, which is what the page's mtime poll reads on focus.
#[tauri::command]
pub async fn disk_stat<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
) -> Result<Stat, DiskError> {
    guard(&window)?;
    let root = disk.root(&root)?;
    let target = resolve(&root, &path, true)?;
    let meta = fs::metadata(&target).map_err(|err| DiskError::io(err, &target))?;
    Ok(Stat {
        size: meta.len(),
        mtime: meta.modified().map(ms_of).unwrap_or(0.0),
    })
}

/// Read a file as text. Invalid UTF-8 becomes replacement characters, exactly
/// like the browser's `File.text()`, so the two backends cannot disagree about
/// what a broken file contains.
#[tauri::command]
pub async fn disk_read<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
) -> Result<Text, DiskError> {
    guard(&window)?;
    let root = disk.root(&root)?;
    let target = resolve(&root, &path, true)?;
    let bytes = fs::read(&target).map_err(|err| DiskError::io(err, &target))?;
    Ok(Text {
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Read a file as bytes, for the `.age` ciphertext the page decrypts itself.
/// `tauri::ipc::Response` sends the raw body, so the bytes cross once instead
/// of as a base64 JSON string.
#[tauri::command]
pub async fn disk_read_bytes<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
) -> Result<tauri::ipc::Response, DiskError> {
    guard(&window)?;
    let root = disk.root(&root)?;
    let target = resolve(&root, &path, true)?;
    let bytes = fs::read(&target).map_err(|err| DiskError::io(err, &target))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write a file, creating it when it is not there. The parent directory must
/// exist: this command saves a document, it does not build a tree.
#[tauri::command]
pub async fn disk_write<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
    text: String,
) -> Result<Written, DiskError> {
    guard(&window)?;
    let root = disk.root(&root)?;
    let target = resolve(&root, &path, false)?;
    let mtime = atomic_write(&target, &text)?;
    Ok(Written { mtime })
}

/// Rename an entry inside its own directory.
#[tauri::command]
pub async fn disk_rename<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    root: String,
    path: String,
    new_name: String,
) -> Result<Renamed, DiskError> {
    guard(&window)?;
    let root_id = root;
    let root = disk.root(&root_id)?;
    let target = resolve(&root, &path, true)?;
    let (dir, name) = split_parent(&target).map_err(|err| DiskError::io(err, &target))?;
    let name = name.to_string_lossy().into_owned();
    rename_in_place(dir, &name, &new_name)?;

    if root.kind == RootKind::File {
        // The renamed file *is* the root, so the record must follow it or
        // every later command on this root would answer notFound.
        let moved = dir.join(&new_name);
        let canonical =
            canonical_for(RootKind::File, &moved).map_err(|err| DiskError::io(err, &moved))?;
        let mut roots = disk.lock();
        if let Some(stored) = roots.by_id.get_mut(&root_id) {
            stored.path = moved;
            stored.canonical = canonical;
            stored.name = new_name.clone();
        }
        if let Err(err) = roots.save_to(&disk.file) {
            eprintln!("[vrtti] could not save the roots file: {err}");
        }
        // A file root's relative path is always "".
        return Ok(Renamed {
            path: String::new(),
            name: new_name,
        });
    }

    // The relative path with its last segment swapped. Built from the string
    // the page sent, so the separator stays '/' on every platform.
    let mut parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    parts.pop();
    parts.push(&new_name);
    Ok(Renamed {
        path: parts.join("/"),
        name: new_name.clone(),
    })
}

/// Drop the roots the page no longer references. The page calls this once at
/// boot with every root id its records still name.
#[tauri::command]
pub async fn disk_prune<R: Runtime>(
    window: WebviewWindow<R>,
    disk: State<'_, Disk>,
    keep: Vec<String>,
) -> Result<usize, DiskError> {
    guard(&window)?;
    let mut roots = disk.lock();
    let dropped = roots.prune(&keep, now_ms());
    if dropped > 0 {
        if let Err(err) = roots.save_to(&disk.file) {
            eprintln!("[vrtti] could not save the roots file: {err}");
        }
    }
    Ok(dropped)
}

// ---------------------------------------------------------------------------
// Tests
//
// Everything below drives the plain functions: no AppHandle, no Tauri runtime,
// no window. That is the reason the fs logic lives in free functions and the
// roots store takes a path instead of reading managed state.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_root(path: &Path) -> Root {
        Root {
            id: "test".into(),
            kind: RootKind::Directory,
            name: display_name(path),
            path: path.to_path_buf(),
            canonical: fs::canonicalize(path).expect("the temp dir canonicalizes"),
            added_at: now_ms(),
            stale: false,
        }
    }

    #[test]
    fn relative_accepts_and_rejects_by_table() {
        let ok: [(&str, &[&str]); 3] = [("", &[]), ("a", &["a"]), ("a/b", &["a", "b"])];
        for (input, want) in ok {
            let got = relative(input).unwrap_or_else(|err| panic!("{input} rejected: {err:?}"));
            let want: PathBuf = want.iter().collect();
            assert_eq!(got, want, "{input}");
        }
        for input in [
            "..", "a/..", "a//b", "./a", "a\\b", "\0", "a/\0b", "/a", ".",
        ] {
            let err = relative(input).expect_err(&format!("{input} must be rejected"));
            assert_eq!(err.code, "outsideRoot", "{input}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_out_of_the_root_is_refused() {
        use std::os::unix::fs::symlink;

        let inside = tempfile::tempdir().expect("temp dir");
        let outside = tempfile::tempdir().expect("temp dir");
        fs::write(outside.path().join("secret.txt"), "not yours").expect("write");
        fs::write(inside.path().join("mine.txt"), "yours").expect("write");
        symlink(outside.path(), inside.path().join("escape")).expect("symlink");
        symlink(inside.path().join("mine.txt"), inside.path().join("alias")).expect("symlink");

        let root = dir_root(inside.path());

        let err = resolve(&root, "escape", true).expect_err("a symlinked dir outside must fail");
        assert_eq!(err.code, "outsideRoot");
        let err =
            resolve(&root, "escape/secret.txt", true).expect_err("a file through it must fail");
        assert_eq!(err.code, "outsideRoot");

        // A symlink that stays inside the root is an ordinary file.
        let allowed = resolve(&root, "alias", true).expect("a symlink inside the root is fine");
        assert_eq!(allowed, inside.path().join("alias"));
    }

    #[test]
    fn atomic_write_creates_overwrites_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("note.md");

        let mtime = atomic_write(&target, "first").expect("create");
        assert!(mtime > 0.0);
        assert_eq!(fs::read_to_string(&target).expect("read"), "first");

        atomic_write(&target, "second").expect("overwrite");
        assert_eq!(fs::read_to_string(&target).expect("read"), "second");

        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn atomic_write_keeps_the_mode_of_an_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("private.md");
        fs::write(&target, "first").expect("write");
        fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        atomic_write(&target, "second").expect("overwrite");

        let mode = fs::metadata(&target).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the write widened the file");
    }

    #[test]
    #[cfg(unix)]
    fn atomic_write_replaces_the_target_of_a_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temp dir");
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "first").expect("write");
        symlink(&real, &link).expect("symlink");

        atomic_write(&link, "second").expect("write through the symlink");

        assert_eq!(fs::read_to_string(&real).expect("read"), "second");
        assert!(
            fs::symlink_metadata(&link)
                .expect("stat")
                .file_type()
                .is_symlink(),
            "the user's symlink did not survive"
        );
    }

    #[test]
    fn rename_refuses_a_taken_name_and_moves_a_free_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("a.md"), "a").expect("write");
        fs::write(dir.path().join("b.md"), "b").expect("write");

        let err = rename_in_place(dir.path(), "a.md", "b.md").expect_err("b.md is taken");
        assert_eq!(err.code, "exists");
        assert_eq!(
            fs::read_to_string(dir.path().join("b.md")).expect("read"),
            "b"
        );

        rename_in_place(dir.path(), "a.md", "c.md").expect("c.md is free");
        assert!(!dir.path().join("a.md").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("c.md")).expect("read"),
            "a"
        );

        let err = rename_in_place(dir.path(), "c.md", "../c.md").expect_err("not a file name");
        assert_eq!(err.code, "outsideRoot");
        let err = rename_in_place(dir.path(), "c.md", "sub/c.md").expect_err("not a file name");
        assert_eq!(err.code, "outsideRoot");
    }

    #[test]
    fn roots_round_trip_through_a_file() {
        let home = tempfile::tempdir().expect("temp dir");
        let folder = tempfile::tempdir().expect("temp dir");
        let file = folder.path().join("note.md");
        fs::write(&file, "hello").expect("write");

        let store_path = home.path().join("roots.json");
        let mut roots = Roots::default();
        let a = roots.register(
            RootKind::Directory,
            folder.path().to_path_buf(),
            canonical_for(RootKind::Directory, folder.path()).expect("canonical"),
        );
        let b = roots.register(
            RootKind::File,
            file.clone(),
            canonical_for(RootKind::File, &file).expect("canonical"),
        );
        // The same folder again is the same root, not a second one.
        let again = roots.register(
            RootKind::Directory,
            folder.path().to_path_buf(),
            canonical_for(RootKind::Directory, folder.path()).expect("canonical"),
        );
        assert_eq!(again.id, a.id);
        assert_eq!(roots.by_id.len(), 2);

        roots.save_to(&store_path).expect("save");

        let loaded = Roots::load_from(&store_path);
        assert_eq!(loaded.by_id.len(), 2);
        let loaded_a = loaded.get(&a.id).expect("the folder root came back");
        let loaded_b = loaded.get(&b.id).expect("the file root came back");
        assert_eq!(loaded_a.path, a.path);
        assert_eq!(loaded_a.canonical, a.canonical);
        assert_eq!(loaded_b.kind, RootKind::File);
        assert_eq!(loaded_b.name, "note.md");
        assert!(!loaded_a.stale && !loaded_b.stale);
    }

    #[test]
    fn a_root_whose_folder_is_gone_loads_stale_and_answers_not_found() {
        let home = tempfile::tempdir().expect("temp dir");
        let store_path = home.path().join("roots.json");
        let gone = tempfile::tempdir().expect("temp dir");
        let gone_path = gone.path().to_path_buf();

        let mut roots = Roots::default();
        let root = roots.register(
            RootKind::Directory,
            gone_path.clone(),
            canonical_for(RootKind::Directory, &gone_path).expect("canonical"),
        );
        roots.save_to(&store_path).expect("save");
        drop(gone);

        let loaded = Roots::load_from(&store_path);
        let stale = loaded
            .get(&root.id)
            .expect("the record survives the folder");
        assert!(stale.stale, "a missing folder must load stale");
        let err = resolve(&stale, "", true).expect_err("a stale root has nothing to give");
        assert_eq!(err.code, "notFound");
    }

    #[test]
    fn prune_keeps_the_young_and_the_named() {
        let folder = tempfile::tempdir().expect("temp dir");
        let mut roots = Roots::default();
        let canonical = canonical_for(RootKind::Directory, folder.path()).expect("canonical");
        let young = roots.register(RootKind::Directory, folder.path().to_path_buf(), canonical);

        // A second record for the same folder needs its own canonical path, or
        // register() would dedupe it into the first one.
        let other = tempfile::tempdir().expect("temp dir");
        let old_canonical = canonical_for(RootKind::Directory, other.path()).expect("canonical");
        let old = roots.register(
            RootKind::Directory,
            other.path().to_path_buf(),
            old_canonical,
        );
        roots.by_id.get_mut(&old.id).expect("the old root").added_at =
            now_ms() - PRUNE_GRACE_MS - 1;

        let dropped = roots.prune(&[], now_ms());
        assert_eq!(dropped, 1);
        assert!(roots.get(&young.id).is_ok(), "a fresh root must survive");
        assert!(roots.get(&old.id).is_err(), "an old unnamed root must go");
    }

    #[test]
    fn a_file_root_owns_nothing_under_it() {
        let folder = tempfile::tempdir().expect("temp dir");
        let file = folder.path().join("note.md");
        fs::write(&file, "hello").expect("write");
        fs::write(folder.path().join("other.md"), "other").expect("write");

        let root = Root {
            id: "test".into(),
            kind: RootKind::File,
            name: "note.md".into(),
            path: file.clone(),
            canonical: canonical_for(RootKind::File, &file).expect("canonical"),
            added_at: now_ms(),
            stale: false,
        };

        assert_eq!(resolve(&root, "", true).expect("the file itself"), file);
        for rel in ["other.md", "sub/other.md"] {
            let err = resolve(&root, rel, true).expect_err("a file root has no children");
            assert_eq!(err.code, "outsideRoot", "{rel}");
        }
    }
}
