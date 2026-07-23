# Operator guide

This is the day-to-day view: what you actually type, what to watch, and what
to do when something needs a human. For the *why* behind these pieces, see
[architecture.md](architecture.md); for what happens inside one task, see
[task-lifecycle.md](task-lifecycle.md).

Remudero is built to run **unattended** (Standing rule 8: the loop never waits
on you unless the plan says so), so most of this guide is about reading state,
not driving it turn by turn.

## The commands (`rmd`, `bin/rmd`)

All logic lives in TypeScript; `bin/rmd` is a thin `exec` wrapper into
`src/run-task.ts`.

| Command | What it does |
|---|---|
| `rmd run-task <task-id>` | Run one `plan/tasks.yaml` entry end to end (see [task-lifecycle.md](task-lifecycle.md)). |
| `rmd drain [--until <id>] [--max <n>] [--repo <name>] [--dry-run]` | Bounded loop over `run-task`: next runnable task, run, repeat — **stops on the first block**. `--repo` scopes the merged-status gateway to `<owner>/<name>` (defaults to this checkout's own repo); the plan itself always reads from this checkout. |
| `rmd daemon --repo <name> [--max <n>] [--poll-ms <n>]` | Persistent scheduler loop — the same machinery as `drain`, but self-pacing and STOP/PAUSE/headroom-aware, so it keeps running across new plan merges. `--repo` picks the repo to drain (refuses to drain its own source repo unattended without `--allow-self-target`). |
| `rmd daemon-plist --repo <name> [--poll-ms <n>] [--write]` | Generate the `launchd` unit that execs `rmd daemon --repo <name>`. Loading it live is a separate, operator-run step. |
| `rmd stop [--reason <text>]` | **One-shot** hard kill: the currently running drain/daemon halts within one tick; auto-clears once that run ends. A no-op-that-warns when nothing is running. |
| `rmd pause [--reason <text>]` | **Persistent** hold: no new spawns, but an in-flight task always finishes (verdict + merge). Cleared only by `resume`. |
| `rmd resume` | Clears both `stop` and `pause`. |
| `rmd review <pr-number> [--repo <name>]` | The escape hatch for a **hand-opened** PR (plan/doc edits, anything outside the runner): posts `remudero-review` via the same deterministic judge. `--repo` overrides the checkout's default owner/repo. |
| `rmd dep-review <pr-number> [--repo <name>]` | Deterministic Dependabot-PR review lane: minor/patch → arm auto-merge; major (or unparseable) → escalate; source outside manifests → refuse. |
| `rmd lint-plan [--plan <path>]` | Deterministic (no-LLM) linter over the whole plan — sizing, headless-fitness, proof-shape, provenance. Exits non-zero on any blocking violation. |
| `rmd retro [--dry-run]` | Sync the plan from the ledger (the Architect retro's deterministic gather half). `--dry-run` prints the gather + calibration table only. |
| `rmd correct <task-id> --pr <n> [--reason <text>]` | Sanctioned operator correction: records the task's TRUE merged PR when derived status disagrees, supreme over every other status rung. |
| `rmd escalate --class <BLOCKED\|MANUAL\|HARD_STOP> --task <id> --summary <s> [--detail <d>] [--recommendation <r>] [--option "label\|detail"]...` | Open a needs-human GitHub issue. `MANUAL`/`HARD_STOP` also fire a real-time iMessage ping; `BLOCKED` collapses into the digest. |
| `rmd notify <message>` | Real-time iMessage ping via `osascript` (no BlueBubbles dependency). |
| `rmd digest [--since <iso>] [--dry-run]` | Roll up the ledger since `<iso>` (default 24h ago) into one digest ping. |
| `rmd digest-plist [--hour <h>] [--write]` | Generate the `launchd` unit for the daily `rmd digest` pulse (default 8am local). Loading it is an operator action. |
| `rmd init [--tier <pro\|max5x\|max20x>] [--yes]` | Headless-safe first-run tier wizard. `--tier` wins outright; confident evidence writes with no prompt; a prompt fires **only** with a real TTY; a TTY-absent run never blocks (Standing rule 18). |
| `rmd project init <repo> [--profile ts-node\|ts-web\|python\|dotnet] --coverage-pct <n> --branches-pct <n> --mutation-pct <n> --dup-pct <n>` | Fleet-inheritance onboarding: generates the target repo's whole gate stack with the given numbers as ratchet floors. Prints next steps; does not push/PR/arm protection itself. |
| `rmd onboard <target-dir> --phase inventory [--owner <o> --repo <r>]` | Phase 1 of the `rmd onboard` family (brownfield repo onboarding): a deterministic, no-LLM inventory of a target checkout — languages, build/CI systems, docs presence, branch-protection state, issue/milestone counts, test-signal presence. Read-only against the target + `gh api`; writes only `<target-dir>/plan/onboarding/inventory.json`. Phases 2-4 (recon, planning session, synthesis) are future work, not yet built. |
| `rmd deploy [--reason <text>]` | Operator trigger for the deploy supervisor (human-gated): requests a fast-forward + daemon restart at the next idle gap, health-checked with rollback on failure. |
| `rmd deploy-run [--dry-run]` | One deploy-supervisor cycle (what the `launchd` unit runs on its interval): no-op unless a deploy is triggered AND the daemon is idle. |
| `rmd deploy-plist [--interval <s>] [--write]` | Generate the deploy-supervisor `launchd` unit (default every 120s). Loading it is an operator action. |
| `rmd serve [--port <n>] [--host <addr>]` | The operator console front door — see [The console](#the-console-what-it-binds-and-rotating-its-tokens) below. |
| `rmd sweep [--repo <name>] [--dry-run]` | Level-triggered PR-pipeline reconciler: re-derives every open PR's disposition and takes the one gated action (arm merge, fix, close, or escalate). The daemon runs this every poll. |
| `rmd fix <pr-number> [--repo <name>]` | Operator verb for the fix rung sweep uses — manual override to drive a stuck PR through the same fix path. |
| `rmd wipe-test <task-id> [--repo remudero-sandbox] [--allow-non-sandbox]` | The P12 learning-utility A/B harness: runs `<task-id>` twice — normal learnings injection vs masked — and ledgers the turn/cost/verdict/strike deltas. Sandbox-only by default; refuses any other `--repo` (including the primary repo) without `--allow-non-sandbox`. |
| `rmd ops [--dry-run]` | Alert intake: polls code-scanning/Dependabot/secret-scanning alerts, escalates every new critical/high exactly once, captures a feedback entry per open alert. |
| `rmd issues [--dry-run]` | Issues intake: polls open issues for every managed repo, captures a feedback entry per issue not already tracked. |
| `rmd feedback <text...> [--attach <path-or-url>]... [--origin cli\|ui\|issue]` | Durable-inbox async capture: writes a `plan/feedback/<id>.yaml` entry with `status: new`. |
| `rmd triage <feedback-id>` | The Architect intake worker: grounds a feedback entry against the plan/learnings/decisions, researches, and either closes it, grills an ambiguous one via a needs-human issue, or opens a plan-only PR. |
| `rmd plan --mode=create\|clarify\|expand [<brief>...]` | The unified Architect PLAN skill: scaffold new tasks, clarify/grill an existing one, or propose gap-filling tasks. Clear/grill touch nothing; a proposal opens a plan-only PR. |
| `rmd inbox [--dry-run]` | Ratification inbox: tiers pending plan proposals into READY / not-ready / deferred-with-trigger. |
| `rmd approve <P##>` | Ratifies a currently-READY proposal, shipping its cached draft into a plan PR gated by the normal checks. |
| `rmd reframe <P##> --feedback "<text>"` | Records feedback against a proposal and invalidates its cached draft so the next `rmd inbox` redrafts with that feedback in view. |
| `rmd skill list` | Lists the `.remudero/skills/<name>.yaml` skill registry. |
| `rmd trace <id>` | Renders the provenance chain for a task or feedback id — feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha. |

An **unknown command or unrecognized flag never spawns anything** — it prints
usage and exits non-zero (see [control-surface.md](control-surface.md)). This
table is Tier B (hand-maintained, may lag, and is checked for verb coverage by
`plan/claims.yaml`'s docs claims); the authoritative, generated reference is
the CLI itself — run `rmd --help` for the full command list or `rmd <cmd>
--help` for one command, both produced from the single `COMMANDS` registry in
`src/run-task.ts` (W1-T47) so they can't drift from what's actually
dispatched. The full generated reference, with every flag, lives at
[cli-reference.md](cli-reference.md).

`--repo <name>` (or `<owner>/<name>`) appears across several commands
(`drain`, `daemon`, `daemon-plist`, `review`, `dep-review`, `sweep`, `fix`) to
scope that command at a repo other than this checkout's own — the plan and
code are still always read from the local checkout; only the gateway/target
repo changes.

## A normal day

1. **Check what's queued.** Read `plan/tasks.yaml` (or a future `rmd status`)
   for tasks in `queued`/`recon` with satisfied dependencies.
2. **Let the daemon run.** If `rmd daemon` is loaded via `launchd`, new
   runnable work is picked up automatically — you mostly watch the ledger and
   digests, you don't kick off individual tasks by hand.
3. **Read the ledger, not the terminal.** Every step of every run appends one
   NDJSON line (`src/lib/ledger.ts`) keyed by `run_id`/`task_id`. This is the
   provenance record — prefer it over reconstructing history from logs.
4. **Watch for escalations.** A `BLOCKED` verdict lands in the digest; `MANUAL`
   or `HARD_STOP` page you in real time via iMessage. Escalations are opened as
   labeled GitHub issues (`rmd escalate`) with a summary, detail, and — where
   there's a real choice to make — explicit options.
5. **Respond, don't drive.** The loop is designed so you intervene only when
   asked (Standing rule 8): a `DECISION_REQUEST` needing a call, a
   `blocked_review`/`blocked_illformed` verdict naming a real gap, or an
   escalation issue. Idle time on your end is fine — the fleet keeps grooming.

## Pausing vs. stopping

Use **`rmd pause`** for planned maintenance (you want in-flight work to land
cleanly and new work to wait) and **`rmd stop`** to kill a run you believe is
misbehaving *right now*. Because `stop` is one-shot, you never need to
remember to clear it before your next `drain`/`daemon` invocation; `pause`
requires an explicit `rmd resume`. See [control-surface.md](control-surface.md)
for the full contract and the regressions each rule fixes.

## Reviewing a merged (or blocked) task

- A `verdict=merged` `RunResult` means CI, the deterministic review gate
  (`remudero-review`), and `ci-gate` all went green and GitHub merged the PR.
- A `blocked_*` verdict (`blocked_ci`, `blocked_review`, `blocked_budget`,
  `blocked_containment`, `blocked_isolation`, `blocked_illformed`, …) names
  *which* gate stopped it — the reviewer's rubric failures and unmet criteria
  are in the PR's review comments and the ledger's `review.posted` line, never
  only in a worker's own narrative.
- If a status disagrees with GitHub reality (rare, e.g. a merge landed under a
  different PR number than the runner recorded), `rmd correct` is the
  sanctioned fix — never hand-edit `plan/tasks.yaml`'s status outside that
  path.

## Changing the plan

Plan edits (`MASTER-PLAN.md`, `plan/tasks.yaml`) go through the **same PR gate
as code** — see [plan-sync.md](plan-sync.md). A plan-only PR needs an
`Acceptance:` block in its body (claim + observable proof) before `rmd review
<pr-number>` can post the required status; there is no separate "plan admin"
bypass.

## Onboarding a new project

`rmd project init <repo> ...` seeds a target repo with the same gate stack
Remudero holds itself to (MASTER-PLAN §5A: the fleet bar is inherited, not
optional) — workflows, configs, `SECURITY.md`, principles, and the
branch-protection payload, with your measured baseline numbers written in as
ratchet floors so the new repo never onboards at zero. It prints the file list
and the manual steps (arming branch protection is a human, admin-run act, same
reasoning as the branch-protection flip described in
[review-gate.md](review-gate.md)'s "CI-gate aggregator" section).

`rmd onboard <target-dir> --phase inventory` is a separate, EARLIER primitive —
the front door for turning an EXISTING (brownfield) repo into a stewarded plan.
Phase 1 (the only phase built today) is a deterministic, no-LLM inventory of
the target checkout: languages, build/CI systems, docs presence (README,
CONTRIBUTING, AGENTS.md, CLAUDE.md, ADRs, ROADMAP, TODO), branch-protection
state, issue/milestone counts, and test-signal presence, via policy-as-data
detector tables (a new detector is a data row, never a code branch). It reads
the target checkout plus `gh api`, and writes ONLY
`<target-dir>/plan/onboarding/inventory.json`; a GitHub fact it could not
resolve (auth/network failure) is recorded as the literal `"unknown"`, never
guessed. Phases 2-4 (recon over the target, the interactive planning session,
and synthesis into a draft PR against the target repo) are separate future
work, not yet built.

## The console: what it binds, and rotating its tokens

`rmd serve` is the operator console's front door. Two things about it are security-relevant
and were previously either wrong or undocumented.

**It binds the interfaces you name, and only those.** `--host` defaults to `127.0.0.1`, also reads
`RMD_SERVE_HOST`, accepts a comma-separated list, and *refuses* wildcards such as `0.0.0.0`
anywhere in that list. Remote access is expressed by naming the interface you mean, not by opening
all of them. This fleet is reached from the operator's phone over Tailscale, so bind loopback
*and* the tailnet address — loopback alone cuts off the phone, and the tailnet address alone
silently breaks every local curl, script and desktop bookmark:

```
RMD_SERVE_HOST=127.0.0.1,100.x.y.z rmd serve
```

That keeps the console on an authenticated, encrypted overlay rather than on every network the
machine happens to join. Previously `serve` bound *every* interface while printing
"listening on http://localhost:4317" — the log said the opposite of what was true.

**The banner prints the read token only.** There are two bearer tokens: the read token grants a
view-only board, the write token additionally arms fleet-control and question/approve actions.
The startup banner prints the console URL carrying the **read** token, and never prints the write
token, because `serve`'s stdout is commonly redirected to a log file that outlives the process.
Read the write token from the tokens file when you need to arm a write action.

**Rotating the tokens.** Token generation is create-once/read-thereafter, so rotation is a delete:

```
lsof -ti :4317 | xargs kill
rm ~/Remudero/state/service-tokens.json
RMD_SERVE_HOST=127.0.0.1,100.x.y.z rmd serve   # mints a fresh 0600 pair, prints the new console URL
```

Your console bookmark changes every time you rotate, because the token is in the URL.

Rotate whenever a token has been exposed. Treat *exposed* broadly: a token that reached a log
file, a terminal transcript, a screenshot, or a chat window is compromised and must be rotated
rather than merely un-shared.

## Crisis runbook: the procedures you need at 3am

The rest of this guide is about reading state. These four are the ones you need when you have
to *act* — restarting the supervised daemon, rotating tokens, standing up a new machine, and
knowing where the billing boundary sits. Until now these existed only as tribal knowledge in
session notes, unchecked, so they rotted; `test/runbook-coverage.test.ts` now fails the build if
any of the four goes missing or is reduced to a stub heading, and a later-added procedure is
appended to `src/lib/runbook-coverage.ts`'s named list, not discovered by hand.

### Restarting the supervised daemon

The daemon (`rmd daemon`, loaded via `~/Library/LaunchAgents/com.remudero.daemon.plist`, label
`com.remudero.daemon`) loads its code once at start and dispatches in-process — a merged fix on
`origin/main` does **nothing** until the process actually restarts. See
[deploy-supervisor.md](deploy-supervisor.md) for the full mechanism; two ways to trigger it:

- **Let the supervisor do it (preferred).** `rmd deploy --reason "<why>"` marks a deploy
  request; the supervisor (a separate launchd job) fast-forwards the checkout and restarts at
  the next **verified idle gap** (no worker running, `state/inflight/` empty, no worktree
  lock — re-checked in the same breath as the restart to close the poll race), then
  health-checks the new boot and rolls back on a crash loop. No manual kill, no race.
- **Force it by hand (crisis-only — this skips the idle gate).**
  ```sh
  rmd stop --reason "manual restart"                          # halt any in-flight drain/daemon tick
  launchctl kickstart -k gui/$(id -u)/com.remudero.daemon      # hard-kill + relaunch from the plist
  ```
  This is the SAME primitive the deploy supervisor uses, run without the idle check — confirm
  `state/inflight/` is actually empty first, because a mid-task kill SIGKILLs the worker (the
  #559/#581 orphan class the automated path exists to avoid). Confirm the restart landed by
  tailing `state/logs/daemon.out`/`daemon.err` for a fresh `daemon.boot` line.

**The reap-wait, if the same host also runs `rmd serve`.** Killing a process does not instantly
free the port it held — the OS can hold it in `TIME_WAIT` briefly — so a kill-then-immediately-
restart of `rmd serve` can still hit `EADDRINUSE` even though `kill` already returned. Poll for
the port to actually clear before rebinding, rather than racing a fixed sleep against the OS's
own cleanup:
```sh
lsof -ti :4317        # empty output = the port is free, safe to `rmd serve` again
```

### Rotating the service tokens

Covered in full just above (["The console: what it binds, and rotating its
tokens"](#the-console-what-it-binds-and-rotating-its-tokens)): token generation is
create-once/read-thereafter, so rotation is kill the bound process, delete
`~/Remudero/state/service-tokens.json`, and restart `rmd serve` to mint a fresh 0600 pair. Your
console bookmark changes every time, because the token lives in the URL. Rotate whenever a token
has been exposed — a log file, a terminal transcript, a screenshot, a chat window — treated
broadly rather than narrowly.

### First-run setup on a new machine

Prerequisites, established elsewhere in this repo but not previously collected in one place:

- The `claude` CLI installed and logged in via **subscription OAuth** (`claude login`) — never
  via `ANTHROPIC_API_KEY` (see "The billing boundary" below). `which claude` must resolve the
  real on-disk binary, not a shell function or alias (FIELD FINDING 2/3).
- The `gh` CLI installed and authenticated (`gh auth login`) with a token scoped to this repo
  (Standing rule 6: workers carry scoped PATs only, never a blanket personal token).
- `git` and a Node/npm matching this repo's toolchain on `PATH`.

Then, in order:

1. Clone the repo and run `npm install`.
2. Run any `rmd` command once (`rmd --help` is enough). `loadConfig()`
   (`src/lib/config.ts`) exclusive-creates `~/.config/remudero/config.json` on first touch,
   resolving the real `claude` binary via `which` and defaulting `root` to `~/Remudero` — it
   never overwrites a config that already exists, so this step is safe to repeat.
3. `rmd init [--tier <pro|max5x|max20x>]` — the headless-safe first-run tier wizard. An explicit
   `--tier` wins outright; otherwise it detects your tier from usage evidence and falls back to
   the safe `pro` default rather than blocking when no TTY is present (Standing rule 18).
4. Commission the unattended units. Each `<cmd>-plist --write` only writes the plist file;
   `launchctl load` is a deliberate, separate operator action, never automatic:
   ```sh
   rmd daemon-plist --repo <target-repo> --write
   launchctl load ~/Library/LaunchAgents/com.remudero.daemon.plist
   rmd deploy-plist --write
   launchctl load ~/Library/LaunchAgents/com.remudero.supervisor.plist
   rmd digest-plist --write
   launchctl load ~/Library/LaunchAgents/com.remudero.digest.plist
   ```
5. Verify before trusting the loaded units: `rmd daemon --repo <target-repo> --dry-run` resolves
   the target and prints the planned sequence, spawning nothing — confirm it names the repo you
   expect.

### The billing boundary: where ANTHROPIC_* stops

This fleet runs on Claude **subscription** OAuth, never `ANTHROPIC_API_KEY` billing, and the
boundary is enforced in code, not by convention (`src/lib/env.ts`, FIELD FINDING 1, MASTER-PLAN
§9). `ANTHROPIC_API_KEY` exported from an operator's login shell **takes precedence** over the
OAuth login — any process that inherits it silently bills metered API rates instead of the
subscription. `buildWorkerEnv` constructs every worker's environment from an explicit allowlist
(`PATH`/`HOME`/`TMPDIR`/`LANG`/`USER`) and **throws** if any `ANTHROPIC_*` key survives,
including one passed in explicitly — a leak fails loud at construction, never silently on an
invoice. The same check applies to the daemon's own boot environment in `src/lib/launchd.ts`.

**Where the boundary actually sits.** `launchd` never sources `~/.zshrc`, so a daemon loaded via
`launchctl load` is clean by construction. The risk case is a daemon started from a **dev
shell** for local testing: if that shell exports `ANTHROPIC_API_KEY` (common alongside other
CLI/SDK work), the daemon *process itself* is contaminated even though every worker it spawns
still gets a clean env via `buildWorkerEnv`. Check before running a dev-shell daemon:
```sh
env | grep -i ^ANTHROPIC_    # must print nothing before you `rmd daemon`/`rmd drain` from a shell
```
**Why the dollar figures are tripwires, not charges.** Every budget number in this system
(`budget_usd`, the $25 soft-budget warning, the $100 default hard cap) is **notional** under
subscription billing, which strips `ANTHROPIC_*` — there is no metered invoice for these runs to
accumulate against. They exist to catch a runaway loop, not to track spend. The one path where a
dollar figure becomes real money is the deliberate overflow valve (`overflow: "api_key"` in
`~/.config/remudero/config.json`), and `validateConfig` refuses to accept that setting without a
paired `dailyCapUsd` — an uncapped API-billed run is a rejected config, never a silent
possibility.
