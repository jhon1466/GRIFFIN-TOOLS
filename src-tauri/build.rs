fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // The release workflow bakes its version in; the self-updater compares against it.
    println!("cargo:rerun-if-env-changed=GRIFFIN_BUILD_VERSION");
    tauri_build::build()
}
