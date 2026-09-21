fn main() {
    // The page calls these two commands through the Tauri IPC (architecture.md
    // §14.4). Listing them here makes tauri-build generate the
    // allow-open-workspace and allow-focus-workspace permissions that
    // capabilities/default.json grants to the Pages origin.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["open_workspace", "focus_workspace"]),
        ),
    )
    .expect("failed to run tauri-build");
}
