# `@remudero/desktop` — Tauri macOS shell (shell 1)

MASTER-PLAN §7 shell 1 / task W3-T3: wraps the **same web build** shell 0 ships (`apps/dashboard`)
in a native macOS shell — menu-bar presence, launch-at-login, native notifications, a global
hotkey, and deep links. This app **never forks the web code**; it adds native chrome around it.

## What "the same web build" means here, concretely

- `apps/dashboard/index.html` and `apps/dashboard/src/main.ts` (compiled by the repo's one
  existing build command, `tsc -p tsconfig.json`) are shell 0's web build.
- `scripts/build-desktop-web.mjs` copies those two files, **byte-for-byte, unmodified**, into
  `apps/desktop/dist` — the directory `src-tauri/tauri.conf.json`'s `frontendDist` points at.
  `npm run build:web` (in this package) runs it; `npm run verify:web` re-checks the copy against
  the current shell-0 source and fails loudly, naming any drifted file, if they've diverged. This
  is the proof for W3-T3's acceptance criterion "the web build is UNMODIFIED (same artifact,
  different shell)."
- `tauri.conf.json`'s `beforeBuildCommand`/`beforeDevCommand` run `npm run build:web`
  automatically, so a normal `tauri build`/`tauri dev` always re-syncs the bundle first.

## What's scaffolded here vs. what a local build still needs

The environment that authored this PR has **no Rust toolchain, no Tauri CLI native binary, and no
Apple Developer signing identity** — `cargo`/`rustc` are absent, and the sandbox's network
allowlist covers `registry.npmjs.org` but not `crates.io`, `static.crates.io`, or Apple's signing
services. None of that is available headlessly, and per MASTER-PLAN D-5's own precedent
("Repo creation is MANUAL — credentials never agent-handled"), a **signed local build is a manual
step for a human with Xcode + an Apple Developer account**, not something this PR can produce.

Concretely, this PR ships:

- `src-tauri/` — a real Tauri v2 project (`Cargo.toml`, `tauri.conf.json`, `capabilities/`,
  `src/main.rs`, placeholder icons) implementing the tray/autostart/notification/global-shortcut/
  deep-link wiring described above. **`main.rs` has not been run through `cargo check`** — it is
  reviewed-by-reading against the Tauri v2 / plugin APIs, not proven by a compiler in this
  environment. Distrust it until a real `cargo check` (or `npm run tauri dev`) has run against it.
- `scripts/build-desktop-web.mjs` + `test/desktop-web-bundle.test.ts` — the byte-identity build
  and its falsifier test suite, both **pure Node, no Rust needed**, and both verified to pass in
  this environment (`npm test`; also exercised directly against the real `apps/dashboard` — see
  the PR body for the pasted hashes).
- `icons/icon.png` / `icons/tray-icon.png` — minimal solid-color placeholder PNGs (valid image
  files, not decorative art). A real icon set (`.icns` for macOS bundling, a proper tray glyph)
  needs `npm run tauri icon <source.png>` run locally, which needs the Tauri CLI's native image
  pipeline — not available here either.

## Manual follow-up (local machine, once)

1. Install Rust (`rustup`) and Xcode command-line tools.
2. `cd apps/desktop && npm install` (installs `@tauri-apps/cli`; needs `registry.npmjs.org`,
   which this sandbox already reached fine).
3. `cargo check --manifest-path src-tauri/Cargo.toml` — the first real compiler pass over
   `main.rs`; fix whatever it flags before trusting the tray/shortcut/deep-link wiring.
4. `npm run tauri icon path/to/a/real/1024x1024.png` — replaces the placeholder PNGs with a
   proper icon set.
5. `npm run tauri dev` — runs `build:web` then launches the shell locally (unsigned, ad-hoc).
6. `npm run tauri build` with a configured Apple Developer signing identity for a signed,
   distributable build — the artifact W3-T3's acceptance criterion asks for a screenshot/
   transcript of.

## Scripts

| script | what it does |
| --- | --- |
| `npm run build:web` | compile shell 0 (`tsc -p tsconfig.json`) and copy its output into `dist/` |
| `npm run verify:web` | re-check `dist/` against current shell-0 sources; exits non-zero on drift |
| `npm run tauri -- <args>` | the Tauri CLI (`dev`, `build`, `icon`, …) once Rust is installed |
