fn main() {
    // Windows executable resources must be rebuilt when the icon assets change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
