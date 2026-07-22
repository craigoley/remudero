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
| `rmd deploy [--reason <text>]` | Operator trigger for the deploy supervisor (human-gated): requests a fast-forward + daemon restart at the next idle gap, health-checked with rollback on failure. |
| `rmd deploy-run [--dry-run]` | One deploy-supervisor cycle (what the `launchd` unit runs on its interval): no-op unless a deploy is triggered AND the daemon is idle. |
| `rmd deploy-plist [--interval <s>] [--write]` | Generate the deploy-supervisor `launchd` unit (default every 120s). Loading it is an operator action. |
| `rmd serve [--port <n>] [--host <addr>]` | The operator console front door — see [The console](#the-console-what-it-binds-and-rotating-its-tokens) below. |
| `rmd sweep [--repo <name>] [--dry-run]` | Level-triggered PR-pipeline reconciler: re-derives every open PR's disposition and takes the one gated action (arm merge, fix, close, or escalate). The daemon runs this every poll. |
| `rmd fix <pr-number> [--repo <name>]` | Operator verb for the fix rung sweep uses — manual override to drive a stuck PR through the same fix path. |
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
