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
`main.js` + `@remudero/api-client`'s compiled `client.js` (`dist/apps/dashboard/src/main.js` and
`dist/packages/api-client/src/client.js`, both produced by the repo root's plain `tsc` build — no
bundler, the W3-T2 decision) into `web-dist/` — a straight file copy, no transform. Reproduce the
hash check yourself:

```sh
npm install   # repo root
npm run build # repo root: tsc -p tsconfig.json
cd apps/shell-macos && npm run build:web
shasum -a 256 web-dist/index.html ../dashboard/index.html
shasum -a 256 web-dist/main.js ../../dist/apps/dashboard/src/main.js
shasum -a 256 web-dist/api-client.js ../../dist/packages/api-client/src/client.js
```

Every pair is byte-identical.

## Verified — a signed local build, launched, showing live fleet state via the api-client

This shell was built, ad-hoc signed, launched, and driven end-to-end on real macOS hardware (a
Rust toolchain was installed via `rustup` for this verification pass — `cargo`/`rustc` are not
present by default in the sandboxed worker environment this repo's tasks otherwise run in). The
hardware has **no attached physical display** (`system_profiler SPDisplaysDataType` reports zero
displays; `screencapture` fails with "could not create image from display"), so a pixel
screenshot is not obtainable here — what follows is a **transcript**, the acceptance criterion's
named alternative: a real local HTTP+SSE daemon built from this repo's own
`src/lib/service.ts` + `src/lib/board.ts` (the exact code `test/board.test.ts` exercises, with a
realistic 5-task plan, a real ledger, and a fake-but-live GitHub gateway), with the packaged
`.app`'s own stdout/network activity logged against it. Two real bugs surfaced and were fixed as
part of getting this transcript (below); everything here is the POST-fix run.

```
[...] --> OPTIONS /v1/status ua="Mozilla/5.0 (Macintosh...) AppleWebKit/605.1.15 ..." auth-scope=none
[...] <-- OPTIONS /v1/status status=204 (0ms)
[...] --> GET /v1/status ua="Mozilla/5.0 (Macintosh...) AppleWebKit/605.1.15 ..." auth-scope=read
[...] <-- GET /v1/status status=200 (0ms)
[...] --> OPTIONS /v1/status/stream ... auth-scope=none
[...] <-- OPTIONS /v1/status/stream status=204 (0ms)
[...] --> GET /v1/status/stream ... auth-scope=read
[board-render] "Task  Status  PR\nW3-T1 merged ✓ #288\nW3-T2 merged ✓ #294\nW3-T3 running #296\nW3-T4 queued\nW3-T5 queued"
[...] flipped W3-T3 pr#296 OPEN -> MERGED (ledger write)
[...] SSE frame pushed -> event: status | data: {"taskId":"W3-T3",...,"status":"merged","merged":true,...}
[board-render] "Task  Status  PR\nW3-T1 merged ✓ #288\nW3-T2 merged ✓ #294\nW3-T3 merged ✓ #296\nW3-T4 queued\nW3-T5 queued"
```

Read top to bottom: the webview's real fetch (WebKit's UA, real CORS preflight) opens the app,
`@remudero/api-client`'s `getStatus()` renders the initial board (`apps/dashboard/src/main.ts`'s
own `render()`, unmodified — this is *its* table markup, not a mock of it), the SSE subscription
opens on the same authenticated surface, a ledger write flips W3-T3's PR from OPEN to MERGED, and
`applyUpdate()` patches the ONE changed row live — `running` → `merged ✓` — within about a second,
with zero involvement from anything but the real `@remudero/api-client` + the unmodified
`apps/dashboard` code, running inside the actual packaged `.app`. (The DOM text was extracted via
a temporary `WebviewWindow::eval()` polling hook in `src/lib.rs`, reporting to the verification
daemon over plain HTTP — necessary only because there is no display to screenshot; it was
reverted before this commit, see the diff.)

The build itself:

```
$ codesign --verify --deep --strict --verbose=2 Remudero.app
Remudero.app: valid on disk
Remudero.app: satisfies its Designated Requirement

$ codesign -dvvv Remudero.app
Identifier=com.remudero.desktop
Format=app bundle with Mach-O thin (arm64)
Signature=adhoc
Runtime Version=26.5.0
Sealed Resources version=2 rules=13 files=1
```

`tauri.conf.json`'s `bundle.macOS.signingIdentity: "-"` is what makes this a *complete* ad-hoc
signature (bundle + resources sealed, hardened runtime) rather than the executable-only signature
`tauri build` produces with no identity configured at all — the same class of local, unnotarized,
Gatekeeper-exempt-because-it's-not-quarantined signature Xcode itself produces for a local Debug
build. `spctl --assess` and Gatekeeper only reject this for something *downloaded* (quarantine
flag set); a build run directly on the machine that produced it launches fine, which is what
"a signed local build launches" — the acceptance claim's own words — actually asks for.

### Two real bugs this verification found and fixed

1. **`src/lib/service.ts` never answered a CORS preflight.** Any browser/webview client sending
   the `authorization` header (i.e. every real client this bearer-scoped surface has) triggers an
   unauthenticated `OPTIONS` preflight before the browser will send the real request. This surface
   had no OPTIONS handling, so the preflight got the ordinary 404-unknown-path treatment, the
   browser aborted before ever sending the GET, and the client saw an opaque `TypeError: Load
   failed` — invisible to every existing test because Node's own `fetch` (what the whole suite
   drives) does not enforce CORS at all. This is not shell-1-specific: it would have blocked shell
   0 in a real browser exactly the same way, the moment anyone actually opened it there. Fixed by
   answering `OPTIONS` with `Access-Control-Allow-*` headers (set on every response via
   `res.setHeader`, so it also covers 401/403/404/500 — a browser needs the header to read an
   error body too) — `wildcard` origin is safe here specifically because auth is an explicit
   bearer header, never an ambient credential a wildcard origin could get attached. Two new tests
   in `test/service.test.ts` drive the preflight and the header-on-every-response behavior
   directly over real HTTP, the same discipline as every other assertion in that file.
2. **`apps/dashboard/main.ts`'s compiled output keeps a bare module specifier
   (`@remudero/api-client/client`) that only Node's resolver understands** — a real browser's
   native ES module loader has no such resolution and throws immediately, so the page never
   rendered past "Loading…" in ANY real browser, ever, until a real WebKit webview (this shell)
   actually loaded it. Fixed with an import map in `apps/dashboard/index.html` (not a bundler —
   the W3-T2 no-bundler decision stands) pointing the bare specifier at a sibling `api-client.js`;
   `scripts/sync-web-build.mjs` now copies that file (`client.js` has zero runtime imports of its
   own, so nothing further is needed) alongside `main.js`. Shell 0's own eventual static-serving
   wiring needs the same sibling-copy step — noted in `index.html`'s own comment.

Both fixes are in this same PR (see the diff) — the review floor asked for every unmet acceptance
criterion resolved together, and the CORS gap in particular is a shared-surface bug, not a
shell-1-only one.

## Still explicitly out of scope

- **Placeholder icons.** `src-tauri/icons/` are `create-tauri-app`'s stock template icons (MIT
  template output), not Remudero branding.
- **DMG packaging.** `bundle.targets` is `["app"]` only — `bundle_dmg.sh` failed in this
  environment (unrelated to the app itself; a disk-image-creation issue, not a code-signing or
  launch one) and a DMG isn't needed for this task's acceptance bar. Re-adding `"dmg"` is a
  one-line follow-on once someone wants a distributable installer.
- **No baked-in daemon URL.** The shipped `tauri.conf.json` has no `app.windows[].url` override —
  same placeholder state as shell 0 today (`apps/dashboard/src/main.ts`'s own comment: "Connection
  config has no real UI yet"). The verification above used a temporary `url` override pointed at
  a local test daemon; W3-T5 (human-in-the-loop panel actions) is where real connection UX lands
  for every shell at once.
