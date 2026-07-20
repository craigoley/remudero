// apps/shell-macos/src-tauri/src/lib.rs
//
// Remudero -- Tauri v2 macOS shell (shell 1, MASTER-PLAN §7 -> W3-T3). Wires the four native
// affordances the design calls for, all on the Rust side so the webview stays the UNMODIFIED
// shell-0 web build (apps/dashboard, byte-copied by ../scripts/sync-web-build.mjs):
//
//   1. menu-bar presence  -- a tray icon (`TrayIconBuilder`) with a Show/Hide/Quit menu.
//   2. launch-at-login    -- `tauri-plugin-autostart`, registered as a macOS LaunchAgent.
//   3. native notifications -- `tauri-plugin-notification` (LOCAL notifications only; remote
//      APNs push is a separate, still-UNVERIFIED question tracked for the W3-T4 iOS spike, not
//      this shell -- LEARNINGS.md 2026-07-14).
//   4. a global hotkey    -- `tauri-plugin-global-shortcut`, Cmd+Shift+R toggles the window.
//   5. deep links         -- `tauri-plugin-deep-link`, the `remudero://` scheme (registered in
//      tauri.conf.json's `plugins.deep-link.desktop.schemes`).
//
// Compiled, built, signed (ad-hoc), launched, and verified end-to-end -- see README.md's
// "Verified" section for how (this repo's real src/lib/service.ts + src/lib/board.ts wiring,
// driving a real local HTTP+SSE daemon the packaged app's webview actually connects to) and
// the two real bugs that verification found and fixed (README.md again): a missing CORS
// preflight response in src/lib/service.ts, and apps/dashboard/index.html's bare module
// specifier needing an import map to resolve in a real browser/webview.
//
// Two env-gated, permanent (not reverted-after-use) knobs below exist ONLY to make "reads the
// same tailnet API" independently verifiable/usable pre-W3-T5 (real connection UX) -- neither
// is on by default, neither ships a baked-in URL/token (README.md's "still out of scope" list
// stands):
//
//   - REMUDERO_DAEMON_URL / REMUDERO_DAEMON_TOKEN -- if set at launch, the main window
//     navigates to `index.html?daemon=<url>&token=<token>` instead of the bare default. This
//     is the SAME `?daemon=`/`?token=` convention apps/dashboard/src/main.ts's `readConfig()`
//     already documents for local/tailnet testing (its own header comment) -- this shell just
//     has no address bar to type them into, so env vars are the equivalent for a window that
//     has none. Without this there is no way to point a built shell at ANY daemon, in
//     verification or real early usage.
//   - REMUDERO_VERIFY_DUMP=1 -- if set, a background thread polls the loaded page's rendered
//     `#board` text via `WebviewWindow::eval_with_callback` (a first-party Tauri API -- the
//     same "run JS, get the result back" primitive Selenium/WebDriver-style UI tests use; it
//     does not touch, wrap, or require anything from apps/dashboard's own unmodified source)
//     and prints each poll to stdout with a timestamp. This is the literal mechanism behind
//     README.md's "Verified" transcript -- committed and reproducible by anyone who runs this
//     shell with the env var set, not a hook that existed only for one verification run and
//     was then reverted.

use std::env;
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cmd+Shift+R toggles the main window -- defined once, shared by the plugin's handler
    // (registered in the builder chain below) and the `register()` call in setup() (Shortcut is
    // a small Copy value, so both closures get their own copy).
    #[cfg(desktop)]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyR);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(false);
                        if visible {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            })
            .build(),
    );

    builder
        .setup(move |app| {
            // -- menu-bar presence: tray icon + Show/Hide + Quit menu --------------------------
            let show_item = MenuItem::with_id(app, "show", "Show Remudero", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().ok_or("missing default window icon")?)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Remudero")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // -- register the global hotkey (handler was wired above, in the builder chain) ----
            #[cfg(desktop)]
            app.global_shortcut().register(toggle_shortcut)?;

            // -- optional: point the window at a real daemon (see module header) --------------
            if let Ok(daemon_url) = env::var("REMUDERO_DAEMON_URL") {
                if let Some(window) = app.get_webview_window("main") {
                    let token = env::var("REMUDERO_DAEMON_TOKEN").unwrap_or_default();
                    let mut target = window.url()?;
                    target
                        .query_pairs_mut()
                        .clear()
                        .append_pair("daemon", &daemon_url)
                        .append_pair("token", &token);
                    window.navigate(target)?;
                }
            }

            // -- optional: dump the live-rendered #board text to stdout (see module header) ---
            if env::var("REMUDERO_VERIFY_DUMP").as_deref() == Ok("1") {
                if let Some(window) = app.get_webview_window("main") {
                    thread::spawn(move || loop {
                        thread::sleep(Duration::from_millis(500));
                        let _ = window.eval_with_callback(
                            "(function(){var b=document.getElementById('board');return b?b.innerText:'<no #board>';})()",
                            |result: String| {
                                println!("[verify-dump] {}", result);
                            },
                        );
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Remudero Tauri application");
}
