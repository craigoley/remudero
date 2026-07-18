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
| `rmd drain [--until <id>] [--max <n>] [--dry-run]` | Bounded loop over `run-task`: next runnable task, run, repeat — **stops on the first block**. |
| `rmd daemon [--max <n>] [--poll-ms <n>]` | Persistent scheduler loop — the same machinery as `drain`, but self-pacing and STOP/PAUSE/headroom-aware, so it keeps running across new plan merges. |
| `rmd daemon-plist [--poll-ms <n>] [--write]` | Generate the `launchd` unit that execs `rmd daemon`. Loading it live is a separate, operator-run step. |
| `rmd stop [--reason <text>]` | **One-shot** hard kill: the currently running drain/daemon halts within one tick; auto-clears once that run ends. A no-op-that-warns when nothing is running. |
| `rmd pause [--reason <text>]` | **Persistent** hold: no new spawns, but an in-flight task always finishes (verdict + merge). Cleared only by `resume`. |
| `rmd resume` | Clears both `stop` and `pause`. |
| `rmd review <pr-number>` | The escape hatch for a **hand-opened** PR (plan/doc edits, anything outside the runner): posts `remudero-review` via the same deterministic judge. |
| `rmd lint-plan [--plan <path>]` | Deterministic (no-LLM) linter over the whole plan — sizing, headless-fitness, proof-shape, provenance. Exits non-zero on any blocking violation. |
| `rmd retro [--dry-run]` | Sync the plan from the ledger (the Architect retro's deterministic gather half). `--dry-run` prints the gather + calibration table only. |
| `rmd correct <task-id> --pr <n> [--reason <text>]` | Sanctioned operator correction: records the task's TRUE merged PR when derived status disagrees, supreme over every other status rung. |
| `rmd escalate --class <BLOCKED\|MANUAL\|HARD_STOP> --task <id> --summary <s> [--detail <d>] [--recommendation <r>] [--option "label\|detail"]...` | Open a needs-human GitHub issue. `MANUAL`/`HARD_STOP` also fire a real-time iMessage ping; `BLOCKED` collapses into the digest. |
| `rmd notify <message>` | Real-time iMessage ping via `osascript` (no BlueBubbles dependency). |
| `rmd digest [--since <iso>] [--dry-run]` | Roll up the ledger since `<iso>` (default 24h ago) into one digest ping. |
| `rmd init [--tier <pro\|max5x\|max20x>] [--yes]` | Headless-safe first-run tier wizard. `--tier` wins outright; confident evidence writes with no prompt; a prompt fires **only** with a real TTY; a TTY-absent run never blocks (Standing rule 18). |
| `rmd project init <repo> [--profile ts-node\|ts-web\|python\|dotnet] --coverage-pct <n> --branches-pct <n> --mutation-pct <n> --dup-pct <n>` | Fleet-inheritance onboarding: generates the target repo's whole gate stack with the given numbers as ratchet floors. Prints next steps; does not push/PR/arm protection itself. |

An **unknown command or unrecognized flag never spawns anything** — it prints
usage and exits non-zero (see [control-surface.md](control-surface.md)). If a
command you expect isn't listed here, check `bin/rmd`'s own header comment —
this table is kept in sync with it by hand today (Tier B doc, §12A) until the
generated CLI reference (Tier A) exists.

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
