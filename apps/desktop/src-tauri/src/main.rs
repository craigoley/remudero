// apps/desktop/src-tauri/src/main.rs
//
// Remudero desktop -- Tauri macOS shell (shell 1, MASTER-PLAN §7 W3-T3).
//
// This binary adds NATIVE affordances around the unmodified shell-0 web build (apps/dashboard,
// bundled byte-identical into ../dist by scripts/build-desktop-web.mjs -- see that script's
// header and its `--check` drift gate for the "never forks the web code" proof this crate leans
// on). Nothing in this file talks to the daemon: the loaded page is the SAME @remudero/api-client
// consumer shell 0 already ships, over the same tailnet URL/token query-param convention
// (apps/dashboard/src/main.ts). This file's only job is native chrome:
//   - menu-bar (tray) presence: a tray icon with a Show/Hide + Quit menu, left-click toggles the
//     window (§7: "menu-bar presence").
//   - launch-at-login via tauri-plugin-autostart (§7: "launch-at-login").
//   - native notifications via tauri-plugin-notification, registered but UNWIRED to any daemon
//     event source yet -- MASTER-PLAN §7 is explicit that "push is an ADAPTER concern, not an APP
//     concern" (GitHub-mobile/ntfy/iMessage already carry escalations); wiring this plugin to a
//     live daemon event stream is explicit follow-on work, not this task's (§7 "editing
//     capability tiers" / W3-T5 territory once the daemon exposes a push-worthy event feed).
//   - a global hotkey (§7: "global hotkey") that toggles the main window from anywhere in macOS.
//   - deep links via tauri-plugin-deep-link, registered for the `remudero://` scheme (§7: "deep
//     links") -- a received URL shows and focuses the window; ROUTING that URL to a specific
//     panel view is deferred to the (unmodified) web app itself once it grows route handling --
//     out of scope here by the same "never fork the web code" rule.
//
// ⚠ This file has NOT been compiled in the environment that authored it -- no Rust toolchain is
// installed there (see apps/desktop/README.md's "what's scaffolded vs. what a local build still
// needs"). Treat the Tauri/plugin API usage below as reviewed-by-reading, not proven-by-`cargo
// check`; a local `cargo check` (or `npm run tauri dev`) is the first thing to run against this
// file, same distrust-the-prompt discipline this repo applies to any unverified claim.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const MAIN_WINDOW: &str = "main";
/// Cmd+Shift+R: an arbitrary-but-documented default; MASTER-PLAN §7 names "a global hotkey" as a
/// shell-1 affordance without pinning a chord -- this is the placeholder until a real one is
/// picked (e.g. via settings), not a claim of user testing.
const TOGGLE_SHORTCUT_MODIFIERS: Modifiers = Modifiers::SUPER.union(Modifiers::SHIFT);
const TOGGLE_SHORTCUT_CODE: Code = Code::KeyR;

/// Show (unminimize, unhide, focus) the main window, or log-and-noop if it has gone away.
fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        eprintln!("remudero-desktop: no \"{MAIN_WINDOW}\" window to show");
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Toggle the main window's visibility -- the shared behavior behind a tray left-click and the
/// global hotkey (§7: menu-bar presence + a global hotkey are the same "bring the panel forward"
/// action from two different triggers).
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        eprintln!("remudero-desktop: no \"{MAIN_WINDOW}\" window to toggle");
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => show_main_window(app),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Menu-bar (tray) presence ─────────────────────────────────────────────────
            let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide Remudero", true, None::<&str>)?;
            let quit = PredefinedMenuItem::quit(app, Some("Quit Remudero"))?;
            let tray_menu = Menu::with_items(app, &[&show_hide, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().ok_or("missing tray icon")?)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id() == "show_hide" {
                        toggle_main_window(app);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // ── Global hotkey: toggle the window from anywhere in macOS ─────────────────────
            let toggle_shortcut = Shortcut::new(Some(TOGGLE_SHORTCUT_MODIFIERS), TOGGLE_SHORTCUT_CODE);
            {
                let handle = handle.clone();
                app.global_shortcut().on_shortcut(toggle_shortcut, move |_app, shortcut, event| {
                    if *shortcut == toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_main_window(&handle);
                    }
                })?;
            }

            // ── Deep links: a received `remudero://…` URL brings the window forward ─────────
            // Routing the URL to a specific view is the (unmodified) web app's own concern once
            // it grows route handling -- see this file's header.
            {
                let handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    eprintln!("remudero-desktop: deep link received: {:?}", event.urls());
                    show_main_window(&handle);
                });
            }

            Ok(())
        })
        // Closing the window hides it instead of quitting -- standard menu-bar-app posture
        // (the app keeps running in the tray; Quit is an explicit tray-menu action, see above).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Remudero desktop shell")
        .run(|_app_handle, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                // Never exit on the last window closing -- the menu-bar app's lifetime is the
                // tray icon's, not any one window's.
                api.prevent_exit();
            }
        });
}
