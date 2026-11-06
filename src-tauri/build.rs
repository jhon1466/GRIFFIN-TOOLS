fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // The release workflow bakes its version in; the self-updater compares against it.
    println!("cargo:rerun-if-env-changed=GRIFFIN_BUILD_VERSION");
    println!("cargo:rerun-if-changed=app.manifest");
    // Release builds always run as administrator (griffin_launcher.exe requires it to open the
    // game). Debug builds skip it so `cargo test` and `tauri dev` work without elevation.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        windows = windows.app_manifest(include_str!("app.manifest"));
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri build script");
}
