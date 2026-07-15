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
`--repo` warns you, and the resulting unit's daemon will refuse to start (self-target guard)
rather than silently drain its own source repo.
