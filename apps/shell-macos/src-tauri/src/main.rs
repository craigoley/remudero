// Prevents an additional console window on Windows in release builds -- harmless on macOS,
// which this shell targets, but this is the standard Tauri boilerplate; leaving it out is a
// footgun if the crate is ever built on another OS. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shell_macos_lib::run()
}
