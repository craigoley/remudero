# Control surface — fleet commands & safe dispatch

The `rmd` CLI is the control surface for an **unattended daemon**, so it must be safe and
unsurprising on bad input. Two rules govern it.

## 1. Bad input never spawns

An **unknown command**, or an **unrecognized argument** to a command, prints usage and exits
**non-zero, spawning nothing**. The control surface never falls through to a drain on bad
input.

```
$ rmd bogus-cmd                     # exit 2, prints usage
$ rmd daemon install --dry-run      # exit 2: "unexpected argument 'install'" — does NOT drain
$ rmd drain --bogus-flag            # exit 2: "unexpected argument '--bogus-flag'"
```

Spawning commands (`rmd drain`, `rmd daemon`) validate their flags **before** touching
config, locks, or workers — so a malformed control command can never start an unintended run.
(Regression: `rmd daemon install --dry-run` once silently ran the daemon and merged a task
unattended, because the bogus `install` subcommand was ignored.)

## 2. STOP is one-shot; PAUSE is a persistent hold

`STOP` and `PAUSE` are genuinely different in **lifecycle**, not two names for a latch:

| | `rmd stop` | `rmd pause` |
|---|---|---|
| purpose | halt an accidental / runaway run **now** | deliberate maintenance hold |
| scope | the **currently running** drain/daemon | the fleet, across runs |
| lifecycle | **ONE-SHOT** — auto-consumed when the halted run terminates | **PERSISTENT** — survives across runs |
| cleared by | nothing (auto) — your next drain starts clean | **`rmd resume`** only |
| when idle | **no-op that warns** (writes no latch) | writes the hold |

- **`rmd stop`** halts the running drain within one tick and **auto-clears** as that run
  exits, so a subsequent `rmd drain` starts clean with **no `rmd resume` and no manual
  `rm`**. With nothing running, `rmd stop` is a **no-op that warns** — it never writes a
  persistent latch that would silently block your next drain. (Regression: STOP used to be a
  persistent latch that blocked every future drain until manually cleared.)
- **`rmd pause`** is drain-and-hold: any in-flight task still runs to full completion
  (verdict + merge), no new task spawns, and the hold **survives across runs** until you run
  **`rmd resume`**. This is the deliberate-maintenance case.
- **`rmd resume`** clears the pause (and any stop) — the one command that always means "go".

**Auto-consume timing (by design):** STOP is cleared on the halting run's **terminal**
verdict — in the same drain/daemon exit path (and signal handler) that releases the
single-instance lock — so the process STOP was meant to halt consumes it on the way out and
a concurrent/next drain sees a clean slate. (A `SIGKILL` is the one uncatchable exit — the
same limitation the lock itself has; the next drain reclaims a dead-pid lock and `rmd stop`
no-ops when idle.)

See `rmd --help` for the full command list.

## Which repo does the daemon drain? (repo targeting)

The daemon reads the **plan it schedules** and scopes its **status-derivation GitHub gateway**
from an **explicit** repo target — it never silently defaults an unattended run to the repo
that holds its own source.

- **`rmd daemon --repo <name>`** picks the repo to drain: the gateway is scoped to
  `<owner>/<name>` and the plan is read from a synced clone of that repo
  (`<root>/repos/<name>/plan/tasks.yaml`, fetched to the latest `origin/main`).
- **`rmd daemon --plan <path>`** overrides the plan source with an explicit file.
- **`rmd daemon --dry-run`** resolves the target, prints the repo/gateway/plan and the planned
  runnable sequence, logs a `daemon.target` ledger line, and **spawns nothing**.
- **Self-target guard:** a bare `rmd daemon` (which would drain the daemon's own source repo)
  is **refused** unless you pass **`--allow-self-target`** (deliberate self-hosting). This is
  why the launchd unit must bake in a repo — see below.

### Commissioning against remudero-sandbox (W1-T12d)

```
# preview — resolves the sandbox target + planned tasks, spawns nothing:
rmd daemon --repo remudero-sandbox --dry-run

# a bounded live drill (one task through the full gate on the sandbox):
rmd daemon --repo remudero-sandbox --max 1

# generate the launchd unit that drains the sandbox (baked-in --repo), then load it:
rmd daemon-plist --repo remudero-sandbox --write
launchctl load ~/Library/LaunchAgents/com.remudero.daemon.plist
```

`rmd daemon-plist` **bakes `--repo` into the unit's `ProgramArguments`**, so the launchd
daemon drains the intended repo — never an implicit default. A plist generated **without**
`--repo` (or with `--repo` pointed at this checkout's own repo) targets the daemon's OWN
source repo — the same "self" the runtime guard refuses to drain unattended. Generating
that unit now **refuses at generation** (W1-T109) unless you also pass
`--allow-self-target`, which bakes the same consent into the unit so it boots already
acknowledged, rather than silently emitting a unit whose daemon refuses to start and gets
KeepAlive-restarted forever.

## Which surface is `apps/dashboard`? (W1-T2902 ruling)

Two browser surfaces exist against this daemon, and they are **not** the same thing under a
different name:

- **The console shell** (`rmd serve`, `src/lib/serve.ts`'s `renderShellHtml`) is a single
  self-contained HTML page the daemon serves inline over its own bearer-authed routes — the
  day-to-day operator board this doc's control commands feed into.
- **`apps/dashboard`** is a *separate*, portable static page (`index.html` + a compiled
  `main.js`, no bundler by design) meant to be opened standalone or wrapped by a native shell
  (the Tauri macOS/iOS clients MASTER-PLAN §7 names) and pointed at *any* reachable daemon via
  `?daemon=<url>`.

As of W1-T2902's own recon it **could not load as shipped**: `index.html` referenced a
`./main.js` the repo's root `tsc` build never produced there (it emitted to the shared
`dist/apps/dashboard/src/`, not beside `index.html`), and `main.ts`'s one import — the bare
specifier `@remudero/api-client/client` — had no import map for a browser to resolve it
(unlike `tsx`/Node, a browser cannot read a `package.json` `exports` map on its own).

**Ruling: FIXED, not deleted.** `apps/dashboard` is not superseded by the console shell — it is
a different product for a different deployment shape (portable/native-wrapped vs. inline HTML
over the daemon's own HTTP server), and it already carries real, tested logic worth keeping:
`main.ts`'s `isAllowedDaemonUrl` allow-list closes a CSRF/credential-exfiltration gap CodeQL
flagged (alerts #32/#33/#52/#54) — deleting the file would have silently orphaned that tracked
finding. The fix:

- `apps/dashboard/tsconfig.json` — a package-local build (`npm run build` inside
  `apps/dashboard`) that emits `main.js` and its one dependency's compiled copy **under
  `apps/dashboard/build/`**, i.e. beside `index.html`, never into the monorepo's shared `dist/`.
- `apps/dashboard/index.html` — a `<script type="importmap">` resolving
  `@remudero/api-client/client` to that same build's compiled copy, and its module `<script>`
  pointed at the build's actual output path.
- `test/dashboard-loads.test.ts` — runs that build for real and drives a headless-Chromium
  navigation against the built output (never `file://`: a module script's import map is
  CORS-governed like any other module fetch), proving the page's module graph resolves and the
  live board actually renders.

**Named, not fixed here:** the real daemon (`src/lib/service.ts`) sends no
`Access-Control-Allow-Origin` header, so a `?daemon=` pointed at a genuinely different origin
than wherever this page is hosted from still fails its CORS preflight — the cross-origin
deployment story `main.ts`'s own header already named as deferred follow-on work ("wiring the
daemon to actually serve this directory ... over Tailscale"). That is a distinct concern from
"can the page load at all," which is what this ruling closes.

## The console is the primary control surface (W1-T2926)

The mission statement's rule is that every human interaction and all operator control goes
through **the console** (`rmd serve`) — the CLI above is the daemon's own operator/dev tool, not
the intended day-to-day surface. That rule had nothing measuring how far the real tree was from
it: audit recon-2026-09-05 §6, move 5 found 48 of the CLI's 65 `COMMANDS` verbs reachable only
from a shell against 49 console routes, including `deploy`, `sync`, `retro`, `triage`, `plan`,
`review`, `fix`, `sweep` and `onboard` — and this doc never mentioned the console at all.

`scripts/console-parity-ratchet.mjs` (wired into CI as the `console-parity` step of the
`comment-load-ratchet` job) closes that measurement gap: every `COMMANDS` verb must map to a
declared console route, or to a stated reason in the script's `CLI_ONLY` table
(`"operator-shell-only: ..."`, or a route it is superseded by) — a verb with neither fails the
build outright. The set of verbs currently cli-only is recorded in
[`scripts/console-parity-baseline.json`](../scripts/console-parity-baseline.json) — a ratchet
that may only **shrink**: a verb added to `CLI_ONLY` without also being recorded there fails the
same build. MEASURED 2026-09-10: 76 `COMMANDS` entries, 50 declared routes, 14 already
console-routed (`status`, `pause`, `resume`, `stop`, `merge-hold`, `feedback`, `trace`, `inbox`,
`approve`, `reframe`, `peek`, `replay`, `skill`, `drain`), 62 recorded cli-only. Routing any of
the remaining verbs — `deploy`, `sync`, `retro`, `triage`, `plan`, `review`, `fix` and `sweep`
among them — is deliberately **not** this ratchet's job; it is what makes each of those
fileable as its own measured shrink, one task, one route, one baseline edit.
