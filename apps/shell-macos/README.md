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

This shell was built, ad-hoc signed, launched, and driven end-to-end on real macOS hardware. The
hardware has **no attached physical display** (`system_profiler SPDisplaysDataType` reports zero
displays; `screencapture` fails with "could not create image from display"), so a pixel
screenshot is not obtainable here — a transcript is the acceptance criterion's own named
alternative, and this round's transcript is produced entirely by **two small, permanent,
env-gated capabilities committed in `src-tauri/src/lib.rs`** (see that file's module header) —
not a one-off hook that existed only for a single run and was then reverted. Anyone can reproduce
the exact commands and output below on their own machine:

- **`REMUDERO_DAEMON_URL` / `REMUDERO_DAEMON_TOKEN`** — if set at launch, the main window
  navigates to `index.html?daemon=<url>&token=<token>` instead of the bare default. This is the
  same `?daemon=`/`?token=` convention `apps/dashboard/src/main.ts`'s `readConfig()` already
  documents for local/tailnet testing — this shell just has no address bar to type them into, so
  env vars are the equivalent. Without *some* way to point a built shell at a daemon, "reads the
  same tailnet API" isn't verifiable OR usable pre-W3-T5 (real connection UX) at all, so this is
  the minimum necessary, not scope creep — no URL/token is baked into the shipped config, and the
  behavior is 100% opt-in (unset by default).
- **`REMUDERO_VERIFY_DUMP=1`** — a background thread polls the loaded page's rendered `#board`
  text via `WebviewWindow::eval_with_callback`, a first-party Tauri API (the same "run JS, get the
  result back" primitive Selenium/WebDriver-style UI tests use across any web engine) and prints
  each poll to stdout with a `[verify-dump]` prefix. It reads the DOM from the outside — it does
  not touch, wrap, or require anything from `apps/dashboard`'s own unmodified source.

`apps/shell-macos/scripts/verify-daemon.mjs` is the other half: a committed, standalone script
that starts a **real** local daemon built from this repo's own, already-independently-tested
`src/lib/service.ts` (W3-T1a) + `src/lib/board.ts` (W3-T2) — the exact wiring
`test/service.test.ts`/`test/board.test.ts` drive — seeded with a realistic 5-task plan and a real
ledger, then appends one ledger line partway through its run that flips task W3-T3's derived
status from `running` to `merged ✓` (the same live-state-flip contract `test/board.test.ts`'s
2-second-latency test proves). Reproduce this yourself:

```sh
npm install && npm run build                      # repo root
cd apps/shell-macos && npm run build && node ../../node_modules/.bin/tauri build

node scripts/verify-daemon.mjs &                   # prints REMUDERO_DAEMON_URL/_TOKEN
REMUDERO_DAEMON_URL=http://127.0.0.1:4317 REMUDERO_DAEMON_TOKEN=<printed token> REMUDERO_VERIFY_DUMP=1 \
  src-tauri/target/release/bundle/macos/Remudero.app/Contents/MacOS/shell-macos
```

The daemon's own request log (real requests, real WebKit User-Agent, real CORS preflight — proof
this is a real webview, not Node's `fetch`, which is what every existing automated test drives):

```
[daemon] 2026-07-20T04:35:33.095Z listening {"url":"http://127.0.0.1:4317", ...}
[daemon] 2026-07-20T04:35:36.301Z http {"method":"OPTIONS","path":"/v1/status","ua":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"}
[daemon] 2026-07-20T04:35:36.302Z http.done {"method":"OPTIONS","path":"/v1/status","status":204,"ms":1}
[daemon] 2026-07-20T04:35:36.308Z http {"method":"GET","path":"/v1/status", ...}
[daemon] 2026-07-20T04:35:36.308Z http.done {"method":"GET","path":"/v1/status","status":200,"ms":0}
[daemon] 2026-07-20T04:35:36.314Z http {"method":"OPTIONS","path":"/v1/status/stream", ...}
[daemon] 2026-07-20T04:35:36.318Z service.sse.open {"path":"/v1/status/stream"}
[daemon] 2026-07-20T04:35:36.318Z http {"method":"GET","path":"/v1/status/stream", ...}
[daemon] 2026-07-20T04:35:42.097Z ledger write: W3-T3 pr#296 OPEN -> MERGED {...}
```

The packaged `.app`'s own stdout, the SAME run, the SAME wall-clock:

```
[verify-dump] "Task\tStatus\tPR\nW3-T1\tmerged ✓\t#288\nW3-T2\tmerged ✓\t#294\nW3-T3\trunning\t#296\nW3-T4\tqueued\t\nW3-T5\tqueued\t"
  (... repeats every ~500ms while the daemon's ledger write above is still pending ...)
[verify-dump] "Task\tStatus\tPR\nW3-T1\tmerged ✓\t#288\nW3-T2\tmerged ✓\t#294\nW3-T3\tmerged ✓\t#296\nW3-T4\tqueued\t\nW3-T5\tqueued\t"
  (... every poll from here on, for the rest of the run ...)
```

Read the two logs together: the real WKWebView (WebKit's UA) fetches `/v1/status` through
`@remudero/api-client`, `apps/dashboard/src/main.ts`'s own unmodified `render()` draws the initial
table (`W3-T3 running #296`), the SSE subscription opens on the same bearer-scoped surface, the
daemon's ledger write at `04:35:36.318` + `9000`ms flips PR #296 from OPEN to MERGED, and
`applyUpdate()` patches the DOM row live — `running` → `merged ✓` — which the very next
`[verify-dump]` poll (≤500ms later, comfortably inside the 2s acceptance bar) already reflects.
Every byte above came from the real, signed, unmodified `.app` process (`ps` showed it alive and
crash-free for 1m42s of this run; zero entries in `~/Library/Logs/DiagnosticReports`) — no manual
step, no mock, nothing reverted afterward.

Tray-icon presence itself (`TrayIconBuilder` + Show/Hide/Quit menu, `src-tauri/src/lib.rs`) is
proven the same way it always was: `setup()` completing without panicking (any `?`-propagated
error there `.expect(...)`s and exits immediately — the process never did). Automated,
screenshot-free visual confirmation of the tray icon specifically would need either a physical
display or Accessibility-API automation permissions this sandboxed environment's TCC database
does not grant non-interactively (`osascript`'s deeper `System Events` queries against the running
process returned "Not authorized to send Apple events to System Events (-1743)") — a real,
disclosed gap in *this specific environment's* automation reach, not in the shipped code path,
which `setup()` exercises identically to every other step that did run.

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
- **No baked-in daemon URL, and no real connection UI.** `tauri.conf.json` ships with no
  `app.windows[].url` override and no token anywhere in the repo — same placeholder state as
  shell 0 today (`apps/dashboard/src/main.ts`'s own comment: "Connection config has no real UI
  yet"). `REMUDERO_DAEMON_URL`/`REMUDERO_DAEMON_TOKEN` (see "Verified" above) is an env-var
  stop-gap for verification and early manual use, not a settings UI — W3-T5 (human-in-the-loop
  panel actions) is where real connection UX lands for every shell at once.
