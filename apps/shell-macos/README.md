# `@remudero/shell-macos` — Tauri macOS shell (shell 1, W3-T3)

MASTER-PLAN §7: "ONE web app, three shells." This is shell 1 — a Tauri v2 macOS wrapper around
the **unmodified** shell-0 web build (`apps/dashboard`, W3-T2). It adds native affordances; it
never forks the web code.

## What this adds over shell 0

| Affordance | How |
| --- | --- |
| Menu-bar presence | A tray icon + Show/Hide/Quit menu, built with `tauri::tray::TrayIconBuilder` (`src-tauri/src/lib.rs`) |
| Launch-at-login | `tauri-plugin-autostart`, registered as a macOS `LaunchAgent` |
| Native notifications | `tauri-plugin-notification` — **local** notifications only (remote APNs push is a separate, still-UNVERIFIED question the W3-T4 iOS spike owns, not this shell — LEARNINGS.md 2026-07-14) |
| Global hotkey | `tauri-plugin-global-shortcut`; Cmd+Shift+R toggles the window |
| Deep links | `tauri-plugin-deep-link`, the `remudero://` scheme (`src-tauri/tauri.conf.json`'s `plugins.deep-link`) |

It reads the same tailnet api-client surface as shell 0 (MASTER-PLAN §7A) — no daemon code lives
in this app; the webview is exactly `apps/dashboard`'s output.

## The web build is unmodified — proof

`npm run build:web` (wired as `tauri.conf.json`'s `beforeDevCommand`/`beforeBuildCommand`) runs
`scripts/sync-web-build.mjs`, which copies `apps/dashboard/index.html` and its **compiled**
`main.js` (`dist/apps/dashboard/src/main.js`, produced by the repo root's plain `tsc` build — no
bundler, the W3-T2 decision) into `web-dist/` — a straight file copy, no transform. Reproduce the
hash check yourself:

```sh
npm install   # repo root
npm run build # repo root: tsc -p tsconfig.json -> dist/apps/dashboard/src/main.js
cd apps/shell-macos && npm run build:web
shasum -a 256 web-dist/index.html ../dashboard/index.html
shasum -a 256 web-dist/main.js ../../dist/apps/dashboard/src/main.js
```

Hashes captured for this PR (both pairs byte-identical):

```
e67ed36d5289eabc442f15509c21721419281e901fa6ba96e29b61d9a7b427c6  web-dist/index.html
e67ed36d5289eabc442f15509c21721419281e901fa6ba96e29b61d9a7b427c6  apps/dashboard/index.html

535b8729857c8e6c077e76e15ce77714d16878213190a8879978ea9a609c1d90  web-dist/main.js
535b8729857c8e6c077e76e15ce77714d16878213190a8879978ea9a609c1d90  dist/apps/dashboard/src/main.js
```

## What could not be verified in this worker (explicit follow-on work)

This task's PR was authored by a **headless, non-interactive worker with no GUI, no Rust
toolchain, and no network access to crates.io** (its sandbox allowlists `registry.npmjs.org` for
npm packages, but not `crates.io`/`static.rust-lang.org` for Rust — see the sandbox network
policy). Concretely, that means:

- **`src-tauri/src/lib.rs`, `Cargo.toml`, `tauri.conf.json`, and `capabilities/default.json` have
  never been compiled.** They are a best-effort implementation of the documented Tauri v2 tray +
  plugin patterns, not a proven one. `cargo`/`rustc` are absent from this environment (`which
  cargo rustc` finds nothing), so `cargo build`/`npm run tauri build` could not be run here.
- **No signed local build exists**, and no screenshot/transcript of the running menu-bar app can
  be produced here — there is no display and no code-signing identity available to this worker.
- The **placeholder icons** in `src-tauri/icons/` are `create-tauri-app`'s stock template icons
  (copied as-is via `npx create-tauri-app`, MIT-licensed template output), not Remudero branding.

**Follow-on, on a real macOS dev machine with Xcode + Rust installed** (mirrors the W3-T2
dashboard v0 precedent of shipping a narrow, explicitly-scoped slice and naming what's deferred):

```sh
rustup target add x86_64-apple-darwin aarch64-apple-darwin   # if not already present
cd apps/shell-macos
npm install
npm run build   # -> npm run build:web && tauri build
```

Then complete W3-T3's first acceptance claim: run the signed local build, confirm it lives in the
menu bar and shows live fleet state via the api-client, and attach a screenshot/transcript.
Replace the placeholder icons with real Remudero branding at the same time.
