fn main() {
    // Every command the page may call through the Tauri IPC. tauri-build turns
    // each name into an allow-<name-with-dashes> permission that
    // capabilities/default.json grants to the Pages origin; a command missing
    // from this list gets no permission at all and can never be granted.
    // The window commands are architecture.md §14.4, the disk_* ones §17.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_workspace",
            "focus_workspace",
            "close_workspace",
            "page_ready",
            "disk_pick_folder",
            "disk_pick_file",
            "disk_pick_save",
            "disk_list",
            "disk_stat",
            "disk_read",
            "disk_read_bytes",
            "disk_write",
            "disk_rename",
            "disk_prune",
        ]),
    ))
    .expect("failed to run tauri-build");
}
