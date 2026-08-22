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
| `rmd away [on\|off]` | Set/show operator presence (default `attended`). `away` batches `MANUAL`/`HARD_STOP` escalations into the since-you-last-checked recap for an async verdict instead of a real-time page; `attended` (or no argument to show current mode) delivers exactly as before. Never gates dispatch — presence keys delivery only. |
| `rmd review <pr-number> [--repo <name>]` | The escape hatch for a **hand-opened** PR (plan/doc edits, anything outside the runner): posts `remudero-review` via the same deterministic judge. `--repo` overrides the checkout's default owner/repo. |
| `rmd dep-review <pr-number> [--repo <name>]` | Deterministic Dependabot-PR review lane: minor/patch → arm auto-merge; major (or unparseable) → escalate; source outside manifests → refuse. |
| `rmd receipt <pr> [--repo <name>]` | Print a **deterministic in-toto-style run receipt** for `<pr>`'s task, assembled purely from ledger ground truth (`src/lib/receipt.ts`'s `buildReceipt`, W1-T71, ratifies P17). Resolves the task id from the PR body's `Remudero-Task:` trailer — the same extractor `rmd review` uses — refusing rather than guessing when none resolves. Every field with no ledger source for this run prints `null` with a named reason, never a fabricated value; Sigstore signing and the published schema doc are deferred v2 rungs. Read-only: writes no ledger line, posts nothing. |
| `rmd lint-plan [--plan <path>]` | Deterministic (no-LLM) linter over the whole plan — sizing, headless-fitness, proof-shape, provenance. Exits non-zero on any blocking violation. |
| `rmd proof-queue-audit [--plan <path>]` | Resolves every **open, unmerged** task's proof through the reviewer's own parser and resolver (`lib/review.ts`), against the real checkout, and names every proof that can never resolve — a `grep:`/`unit test:` prefix that fails to parse, a name-filtered `unit test:` title matching zero real tests (W1-T229's shape, W1-T1053), or a `grep:` proof whose path is absent — split by cause with the offending task ids. A forward-referencing whole-file `unit test: test/*.test.ts` path for a not-yet-written test is **never** reported. **It is a report, not a gate**: exits 0 unconditionally regardless of how many offenders it names; only a malformed invocation exits non-zero. Fails open (prints nothing audited, still exit 0) on a shallow checkout. |
| `rmd preflight [--from <ref>] [--to <ref>] [--ci-parity] [--fast]` | The hand route's commit gate (W1-T221): runs commitlint, `tsc --noEmit`, and `lib/commit-message.ts`'s own header/body checks as three independent steps — each names its own pass/fail — over the commit range not yet on `origin/main`. Run this before a hand-authored `git push`. `--ci-parity` (W1-T294) additively mirrors every `.github/workflows/ci.yml` job, including its full `test:ci` suite — too slow to run habitually. `--fast` (W1-T373) additively runs only the curated, seconds-fast, network-free deterministic npm-script gates (`cli-reference:check`, `claims`, `learnings-budget-ratchet`, `jscpd`, `depcruise`, `api-client:check`, `no-hand-rolled-fetch:check`) and never shells the test suite, so it is affordable to run before every push. |
| `rmd check-proof <proof>` | Run ONE acceptance proof through the **reviewer's own** parser and executor and print what it does: parse kind, resolved candidate file(s), the exact argv, exit code and hit count. A `grep:` pattern is a **basic regular expression** — `[`, `*`, `^`, `$` are metacharacters — so verifying with `grep -F` is a *different matcher* and reports a false green (PR #1071). Read-only: writes no cache, no ledger line, no state file. |
| `rmd check-acceptance <body-file>` | Read a PR body from a file and report what the **reviewer's own** `parseAcceptanceBlock` actually resolves from it, against what was written: header found, bullets written, criteria parsed, empty proofs. Exits non-zero when they disagree. A claim **wrapped onto a second line** silently truncates the block — any indented line that is not `proof:` ends it — and a `## Validation` heading is not an Acceptance header; both ship a body that says less than its author wrote. Run it before opening a PR over REST, which bypasses the orchestrator's house-block emitter. Read-only: writes no ledger line, no state file. |
| `rmd reap-branches` | **Dry run**: classifies every remote branch as deletable, guarded or held, prints a `sha\tname` manifest for the deletable set, and **deletes nothing**. Deletable = the head of a merged PR, the head of a closed-unmerged PR, or no PR at all with a tip already an ancestor of `origin/main` (so every commit is in main and dropping the ref loses nothing). Guarded = the branch name appears in `src/`, `scripts/`, `deploy/` or `.github/`, or it is listed in `DECLARED_BRANCH_GUARDS`; protection is evaluated **first** and wins, so a branch that is both merged and referenced by source is never offered. Exits non-zero when a grep-guarded branch is missing from the declared list (drift), and when `git ls-remote` returns nothing rather than reporting empty buckets over a corpus it could not read. Pushes nothing, writes no state file. |
| `rmd ledger-grep <pattern>` | The deduplicated union of every `state/ledger.*.ndjson.gz` archive and the live `state/ledger.ndjson`, matched against `<pattern>` — replaces the manual `grep -h '<pat>' state/ledger.*.ndjson state/ledger.ndjson \| sort -u` idiom, which glob-matches ZERO gzipped archives on this host and silently answers from the live file alone (a measured 3.1x undercount). Prints the pattern, state dir and archive count **before** any match, then exits non-zero, naming the globbed directory, when zero archive files were read — never falling back to a live-file-only count. Read-only: writes no ledger line, no state file, deletes/moves nothing. |
| `rmd rule-efficacy [--no-escalate]` | The corpus repeat-incident rate: for each rule in `lib/rule-efficacy.ts`'s signature table, the count of same-class ledger rows strictly **after** the rule's effective (citing) date, over the ledger union (`lib/ledger-grep.ts`) rather than the live file alone — verdict PREVENTING (0 since), REPEATING (n since, dates), or UNMEASURABLE (why), never silently omitted. Host-side only: the ledger lives on the daemon host. A rule at ≥2 post-rule recurrences drafts one promote-to-instrument proposal into the active-proposal registry via `updateProposalRegistry`, idempotent by rule id; `--no-escalate` runs the report only. |
| `rmd coverage-improve [--lcov <path>]` | Tier two of the absolute coverage gate (W1-T470): when this run's branch coverage (read from `--lcov`, default `coverage/lcov.info`) sits in the 85–90% pass-with-debt band, ranks the `src/` files owning the most uncovered branches (a **count**, never a percentage — computed fresh every run, `lib/coverage-improvement.ts`) and files **one** `plan/feedback/` entry naming them via `captureFeedback`, never a shard written straight into `plan/tasks.d/` (no such minter exists) and never one entry per file. Dedupes against the ledger union (`lib/ledger-grep.ts`, never the live file alone) keyed on the exact set of files currently owning the debt — an unchanged debt profile is skipped; a shifted one files again. ≥90% (healthy) and <85% (tier three, a separate remediation loop) are both no-ops here. Inert until wired into the coverage CI job's own step, a deliberately separate PR (Rule 25). |
| `rmd verdict-calibration` | The correctness join (W1-T424): joins every armed merge's ledgered review verdict (`lib/verdict-calibration.ts`'s `mineVerdictRows`, over the ledger union, never the live file alone) to post-merge git reality, and reports per verdict class (full PASS / keyword floor / degraded arm) the revert rate and follow-up-fix rate over a stated window, each denominator **named** (n of N armed merges) with an UNMEASURABLE arm for rows whose merge sha or verdict class could not be recovered — never a rate over a silently shrunken denominator. Below a minimum population floor a class prints its count and refuses the rate. The attribution window + overlap rule (`ATTRIBUTION_POLICY`) print alongside the figures, so the metric travels with its rule. Host-side only: the ledger lives on the daemon host. Read-only: files nothing, proposes nothing in v1. |
| `rmd autonomy-rate` | The **quantity** figure beside `verdict-calibration`'s correctness join (W1-T437): the zero-touch merge rate over every `Remudero-Task:`-trailer-bearing merge on the read git history (`lib/autonomy.ts`'s `zeroTouchMergeRate`, over the ledger union, never the live file alone). Each merge is classified zero-touch or human-touched, and every touch that fired is **named** on its own row — not auto-armed, fix-rung strikes, reframe, operator note, capped override, fix-rung human evidence — then split by verdict class (full PASS / keyword floor / degraded arm / unclassified) so the class split shows where the next ratchet notch is safe. Prints the current `decideAutoMergeArm` arming posture beside the measured rate and proposes no policy change. Zero archive files under the state dir reports the window UNMEASURED, naming the reason, never a rate from the live ledger alone. Host-side only: the ledger lives on the daemon host. Read-only: files nothing, proposes nothing. |
| `rmd next-task-id [--plan <path>] [--offline]` | Print the next free `W1-T<n>`, derived from the max across `plan/tasks.yaml`, **every** `plan/tasks.d/*.yaml` shard, and the ids **open plan PRs** have already minted — the three places an id can be taken. Prints its provenance; exits 1 when a source could not be read (the id is then a floor). `--offline` skips the open-PR read. |
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
| `rmd install-checkout [--write]` | Provision or refuse the daemon's dedicated install checkout (resolved from `config.installRoot`, default `<config.root>/daemon-install` — never the checkout the command was invoked from), the tree `rmd deploy-run` fast-forwards. Prints the current state + the migration sequence by default; `--write` actually acts: clones origin/main if absent, fast-forwards if healthy, and refuses (mutating nothing) if dirty, off-`main`/detached, diverged, or not a git checkout at all. |
| `rmd serve [--port <n>] [--host <addr>]` | The operator console front door — see [The console](#the-console-what-it-binds-and-rotating-its-tokens) below. |
| `rmd relay` | The Tier-2 relay **client**: dials OUT to the relay URL + enrollment token in `~/.config/remudero/config.json`'s `relay.url`/`relay.token` (never a flag, never committed) and holds a reconnecting tunnel that forwards the local `rmd serve` surface (REST + SSE) as a transparent byte proxy — the console's own identity seam decides every grant, so the relay adds no scope of its own. Never binds a port. Refuses (spawns nothing) when `relay.url`/`relay.token` is absent. Blocks until SIGINT/SIGTERM, same shape as `rmd serve`; `rmd serve` is a separate process and is unaffected whether or not this ever runs. |
| `rmd console-url [--port <n>] [--host <addr>] [--write]` | Print the console URL carrying the **read** token — one command instead of hand-extracting `state/service-tokens.json`. One URL per bound interface, resolving port/host exactly as `rmd serve` does. `--write` also prints the **write** token to paste into the console, and refuses unless stdout is a TTY (a redirected stdout becomes a file that outlives the process). See [The console](#the-console-what-it-binds-and-rotating-its-tokens). |
| `rmd serve-plist [--port <n>] [--host <addr>] [--write]` | Generate the `launchd` unit that runs the console as a background **service** (KeepAlive + ThrottleInterval 60, logs 0600 under `state/logs/`). Loading it is an operator action. |
| `rmd down [--port <n>] [--host <addr>]` | Graceful wind-down for restart/maintenance: unloads the daemon `launchd` service (waiting a bounded window for any in-flight task to reach a safe boundary, else reporting its run id + recoverability), stops `rmd serve` **by port** with a reap-wait (never an argv/pattern kill), and prints a wind-down summary (in-flight state, open-PR count, needs-human count, safe-to-restart). Idempotent — already down is a no-op honest report. |
| `rmd up [--port <n>] [--host <addr>] [--allow-off-main]` | Full resume: runs install-freshness first, refuses to resume an off-`main` checkout unless `--allow-off-main` is given, loads the daemon `launchd` service, confirms/starts the serve `launchd` service, and prints a resume report (daemon pid, the console URL with its read token, the in-flight/queued head, needs-human count). Idempotent — already up verifies and reports, never a double start. |
| `rmd sync [--dry-run]` | The sanctioned dedupe-then-pull recipe as one verb, for exactly the case `checkCliFreshness` refuses — behind `origin/main` AND dirty. Classifies every `git status --porcelain` path against the origin/main blob, so a working-tree copy identical to what is incoming is dropped rather than treated as a conflict. `--dry-run` reports the classification without touching the tree. |
| `rmd status [--json]` | "Is it running, and why is it stalled" from ONE read model. **Local** (no network): LIVENESS (daemon/serve/deploy-supervisor running/pid/boot-time, running HEAD vs `origin/main` with a STALE flag, crash-loop), LATCHES (every state marker — STOP/PAUSE/QUIET_HOURS/DEPLOY_FAILED/DEPLOY_AUTO/inflight locks/pending kicks/drain-now — with its age and stated consequence), LAST CYCLE (the newest `daemon.summary`). **Derived**: BLOCKERS BY CLASS (circuit-broken w/ its reset condition, `dispatch.indeterminate` w/ the gh-window note, blocked PRs by the reason `rmd sweep` already named), QUEUE HEAD (next dispatchables, a perpetually re-attempted task flagged with its observed per-cycle cost, and — W1-T450 — a STALL line when candidates are present but no `run.start` anywhere is newer than a bound derived from this host's own observed dispatch cadence, so eligible-but-not-dispatching stops rendering identically to eligible-and-about-to-dispatch; silent on an empty queue or an unreadable/absent `run.start`, and never a gate), INBOX (ready/not-ready counts, the head item's not-ready reason), HEADROOM (newest telemetry + enforcement on/off from the same switch the daemon reads) — these read a batched GitHub gateway and degrade to a stated unknown on an outage, never a gate on the local sections above. Each section ends with at most one next action. `--json` emits the exact same read model the text renders — the future console Now tab's intended data source. |
| `rmd doctor [--json]` | ONE **local, read-only** health check with a meaningful exit code — `0` OK / `1` any WARN / `2` any FAIL, with bad args exiting `64` so exit 2 always means a check failed and never a typo. **No network and no healthy daemon required**: every check reads the ledger, `state/`, `plan/`, `/proc` or `ps`, so it answers from a cold ssh session while `remudero-serve` is down and the API budget is exhausted — which is exactly when the console-side checks are unavailable. Checks: ledger freshness (newest `daemon.*` row vs two poll intervals), dispatch stall (eligible pool vs THIS host's own observed cadence), dispatch liveness (consecutive `daemon.alive` rows stuck in the sweep phase), pause honoured (a `PAUSE` held while dispatch continued), lock-vs-process divergence, lane-less workers, stale git `index.lock` (report only), disk headroom, and memory/swap from `/proc/meminfo` — never the cgroup limit, since an unlimited container reads `max` and would report unbounded headroom on a host that had already frozen. Every check prints its measured value beside its threshold, with one summary line first, short enough for a cron subject. **Read-only: `--fix` is refused by name**, because every repair path already has an owner and a second actor mutating state a live daemon depends on is the measured hazard. |
| `rmd sweep [--repo <name>] [--dry-run]` | Level-triggered PR-pipeline reconciler: re-derives every open PR's disposition and takes the one gated action (arm merge, fix, close, or escalate). The daemon runs this every poll. |
| `rmd fix <pr-number> [--repo <name>]` | Operator verb for the fix rung sweep uses — manual override to drive a stuck PR through the same fix path. |
| `rmd wipe-test <task-id> [--repo remudero-sandbox] [--allow-non-sandbox]` | The P12 learning-utility A/B harness: runs `<task-id>` twice — normal learnings injection vs masked — and ledgers the turn/cost/verdict/strike deltas. Sandbox-only by default; refuses any other `--repo` (including the primary repo) without `--allow-non-sandbox`. |
| `rmd ops [--dry-run]` | Alert intake: polls code-scanning/Dependabot/secret-scanning alerts, escalates every new critical/high exactly once, captures a feedback entry per open alert. |
| `rmd alert-fix [--repo <name>] [--dry-run]` | The alert-fix lane: a deterministic policy (`plan/alert-policy.yaml`) decides act-vs-escalate per open alert — act dispatches one ephemeral lane-owned fix run through the full gate; escalate opens a needs-human issue, sharing `rmd ops`'s own escalation-ledger dedup. |
| `rmd issues [--dry-run]` | Issues intake: polls open issues for every managed repo, captures a feedback entry per issue not already tracked. |
| `rmd feedback <text...> [--attach <path-or-url>]... [--origin cli\|ui\|issue]` | Durable-inbox async capture: writes a `plan/feedback/<id>.yaml` entry with `status: new`. |
| `rmd triage <feedback-id>` | The Architect intake worker: grounds a feedback entry against the plan/learnings/decisions, researches, and either closes it, grills an ambiguous one via a needs-human issue, or opens a plan-only PR. |
| `rmd plan --mode=create\|clarify\|expand [<brief>...]` | The unified Architect PLAN skill: scaffold new tasks, clarify/grill an existing one, or propose gap-filling tasks. Clear/grill touch nothing; a proposal opens a plan-only PR. |
| `rmd inbox [--dry-run]` | Ratification inbox: tiers pending plan proposals into READY / not-ready / deferred-with-trigger. |
| `rmd approve <P##>` | Ratifies a currently-READY proposal, shipping its cached draft into a plan PR gated by the normal checks. |
| `rmd reframe <P##> --feedback "<text>"` | Records feedback against a proposal and invalidates its cached draft so the next `rmd inbox` redrafts with that feedback in view. |
| `rmd skill list` | Lists the `.remudero/skills/<name>.yaml` skill registry. |
| `rmd learnings export <out>` / `rmd learnings import <file> --pin <hash>` | The §6 knowledge-commons transport: `export` collects only `share: public`-stamped, active project-layer entries into a hash-pinned bundle, refusing (naming the entry) if a candidate matches the leak-grep tripwire, or refusing outright if zero entries opted in; `import` checks the bundle's own hash against the operator-supplied `--pin` before writing it to the RMD-GLOBAL layer, deferring all further tamper enforcement to the existing hash-pinned-artifact guard. |
| `rmd emissions [--days <n>]` | Reports CLI verbs that exist in the COMMANDS registry but have emitted no ledger line in the window — the declared-but-never-run class, with a reasoned allowlist for verbs that are legitimately rare. |
| `rmd trace <id>` | Renders the provenance chain for a task or feedback id — feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha. |
| `rmd peek <runId> [--lines <n>] [--follow]` | **Read-only** tail of one run's output — the last `<n>` lines (default 50, never more than the 500-line ring ceiling) of its retained `state/runs/<runId>.tail`, printed with a LIVE/FINISHED verdict from the same in-flight-lock liveness check every other verb uses. Works identically on a **finished** run's retained tail, so the last transcript lines of a non-PR verdict are readable after the fact. An unknown run id or an absent tail prints a named reason and still exits 0 — never silent empty output. `--follow` re-polls and reprints on change, stopping on its own the moment the run is no longer live. No steering surface: no flag here writes to, signals, resumes or kills the run. The console reads the same tail through `GET /v1/peek`. |

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

**`rmd reap-branches` runs on no cadence — it is a manual verb, not a sweep
rung** (W1-T448). Wiring it into `rmd sweep`'s per-pass loop was costed and
rejected: one reap issues ~8 `gh api` requests and takes several seconds of
wall time (measured 2026-08-12T23:23Z: 8 pages, 6.4s real — the same order of
magnitude as W1-T447's original 7.38s figure), and the daemon polls the sweep
roughly every `DEFAULT_POLL_INTERVAL_MS` (60s, `src/lib/daemon.ts`) — so
per-pass wiring would add on the order of 480 REST requests/hour against the
5,000/hour budget (4,807/5,000 remaining at the same measurement) for a
report that only changes when a branch is created or merged; the branch
count moved by just 2 (49→51) across the roughly one-hour gap between this
measurement and W1-T447's. Run `rmd reap-branches` by hand, or from your own
cron, when you want a fresh read — one command still replaces a hand sweep of
GitHub, which was the point. These figures move hourly: re-measure before
revisiting this decision, never quote them forward.

## A normal day

1. **Check what's running, and why it's stalled.** `rmd status` answers both
   in one shot: local liveness (every active latch with its age and
   consequence, and the last cycle), plus the derived half — BLOCKERS BY
   CLASS (circuit-broken/`dispatch.indeterminate`/named-reason blocked PRs),
   QUEUE HEAD (next dispatchables, a perpetually re-attempted task flagged
   with its per-cycle cost, and a STALL line — W1-T450 — when eligible work
   sits with no dispatch newer than this host's own observed cadence bound,
   never on an empty queue or an unreadable `run.start`), INBOX (ready/not-ready
   counts), and HEADROOM
   (telemetry + enforcement on/off). The derived half reads GitHub through a
   batched gateway and degrades to a stated unknown on an outage — it never
   blocks the local sections.
2. **Let the daemon run.** If `rmd daemon` is loaded via `launchd`, new
   runnable work is picked up automatically — you mostly watch the ledger and
   digests, you don't kick off individual tasks by hand.
3. **Read the ledger, not the terminal.** Every step of every run appends one
   NDJSON line (`src/lib/ledger.ts`) keyed by `run_id`/`task_id`. This is the
   provenance record — prefer it over reconstructing history from logs. The
   ledger's location is deterministic, a pure function of `config.root`
   (`ledgerPathFor` in `src/run-task.ts`): **`<config.root>/state/ledger.ndjson`**
   — by default `~/Remudero/state/ledger.ndjson`, since `config.root` defaults
   to `os.homedir()/Remudero`, the *parent* of a repo checkout, not the
   checkout itself (W1-T143). `rmd daemon` ledgers this path (plus its
   launchd `StandardOutPath`/`StandardErrorPath` — `<config.root>/state/logs/
   daemon.out.log`/`daemon.err.log`) aloud in its own `daemon.paths` line at
   every boot, and prints the same line to stdout, so the path is never
   folklore. The daemon's console narration (stdout/stderr) is written via a
   synchronous `write(2)` (`writeSyncLine`), not `console.log` — under
   launchd, stdout/stderr are never a TTY, and a plain `console.log`'s queued,
   asynchronous write is why those out/err log files used to sit empty for
   the life of a live run; the ledger stays the authoritative, structured
   record either way.
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

**Run it as a service, not in a terminal.** A foreground `rmd serve` dies with the shell that
started it — every ctrl+C, closed tab or logout takes the board down, which matters most when
the console is the only reattach surface for a fleet you are away from. `rmd serve-plist`
generates the launchd unit that fixes that:

```sh
rmd serve-plist --write                                    # writes the unit + pre-creates 0600 logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.remudero.serve.plist
launchctl kickstart -k gui/$(id -u)/com.remudero.serve     # restart it (e.g. after a deploy)
```

The unit carries `KeepAlive` unconditionally — `rmd serve` exits 0 on a clean SIGTERM and the
console must come back from that too — rate-limited by `ThrottleInterval 60` so a
misconfiguration cannot become a relaunch storm. It binds what `serve.host`/`RMD_SERVE_HOST`
resolve to (put the pair in `~/.config/remudero/config.json` as `"serve": {"host":
"127.0.0.1,100.x.y.z", "port": 4317}` so the unit and a hand-run `rmd serve` agree), it embeds
**no token** (`service-tokens.json` is read at boot as always), and it references no daemon
label or path — so it installs and keeps running with the daemon deliberately stopped.

Its logs are `~/Remudero/state/logs/serve.out.log` / `serve.err.log`, forced to 0600 both at
install and at every boot, because the startup banner carries the read token and launchd would
otherwise create those files world-readable.

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

## Shipping a new CI gate: three PRs, in this order

A new gate — a workflow job plus the script it runs — cannot land as one PR, and merging the
pieces out of order reddens `main`. Four gates were built in a single day and the order was
rediscovered each time; one out-of-order merge left `main` red for seventy-two minutes.

**Phase 1 — the `INSTRUMENT_SURFACE` registration in `src/lib/review.ts`, alone.** Adding a gate
script makes `test/instrument-surface-completeness.test.ts` derive it as a candidate that must be
either declared in `INSTRUMENT_SURFACE` or excused in `INSTRUMENT_SURFACE_EXCLUSIONS` with a
written reason. This phase is green on a tree where the job does not yet exist, because
`INSTRUMENT_SURFACE` is a **regex list consulted during a diff walk, not an assertion that a path
exists** — so it can and should land first.

**Phase 2 — the workflow job, the script, the baseline and its test.** With phase 1 on `main` the
completeness alarm is already satisfied, so this phase clears that arm on merge.

**Phase 3 — the `CI_PARITY_TABLE` entry in `src/lib/ci-parity.ts`.** This one **cannot** land
before the job exists: the parity contract asserts both directions, and its own test says so —
*"the table cannot silently grow ahead of the workflow either."* Until phase 2 merges, an entry
here fails.

**The three cannot be combined, and that is the whole reason for the split.**
`detectInstrumentEntanglement` refuses any diff carrying both instrument surface (a workflow, a
`*-baseline.json`, a ratchet script) and a `src/` product path. That verdict forces the review
state to `failure` and is **not suppressible** — so a PR carrying the job *and* its registrations
cannot go green no matter how correct it is.

Between phase 2 merging and phase 3 merging, `main` is red on the parity assertions. That window
is real and expected; keep it short rather than trying to avoid it.

**The exception, and why it does not generalise.** Commit `74ab526` ("ride the CLAUDE.md ratchet as
a step, not a job") cuts this to two phases by adding the gate as a **step inside an existing job**
rather than a job of its own: `CI_PARITY_TABLE` keys on **job names**, so a step needs no entry and
phase 3 disappears. It did not transfer to `task-id-existence`, and the reason is worth knowing —
`test/instrument-surface-completeness.test.ts` harvests `package.json`'s scripts map as well as the
workflows, so a gate wired as an npm script is derived as a candidate wherever its invocation
sits. Workflow placement was simply irrelevant to that half.

## Where to run a verb, and why the wrong place answers confidently

Every item below is read-only or near enough, so the failure mode is not damage — it is a
**confident wrong answer**. The pattern is always the same: a tool answered about state it could
not see, in the same tone it uses when it can. Each was reproduced on `Craigs-Mac-mini` on
2026-08-22; where a claim did **not** reproduce here, that is said rather than repeated.

- **A gate piped through `head` gives you `head`'s exit code.** `(exit 1) | head -3` leaves `$?` at
  **0** while `${PIPESTATUS[0]}` is **1**. A `diff-coverage` calibration read `EXIT=0` while the
  tool itself exited 1 with lines named, because exemption output sat above the verdict and the
  pipe swallowed the status. Read `${PIPESTATUS[0]}`, or do not pipe.

- **`git checkout -- <path>` restores from the INDEX, not from `origin/main`.** Stage an edit, then
  overwrite the file, then `git checkout --` it: you get the **staged** copy back, not the
  committed one. A "revert this file and see what fails" experiment therefore passes vacuously
  whenever the index already holds the edited version. Use `git show origin/main:<path>` when you
  mean the merge base.

- **A clean working tree does not mean a clean index, and `commit --amend` ships the difference.**
  In a reused worktree `git diff` can report nothing while `git diff --cached` reports a staged
  change — the working tree matches the index, and only the index differs from `HEAD`. Amending
  there silently ships whatever someone else staged. Check `git diff --cached --stat` before every
  `commit --amend`.

- **`tsx` strips types without checking them, so a unit suite can read fully green while `tsc`
  fails.** A file declaring `const n: number = "definitely not a number"` **executes** under `tsx`
  and prints the string; `tsc` on the same file reports `TS2322: Type 'string' is not assignable to
  type 'number'`. A type-level defect is invisible to the whole test suite, and a file can be
  load-bearing with no test able to say so. `tsc --noEmit` is a separate gate for a reason — never
  read a green suite as a green typecheck.

- **A `gh` subcommand's existence is version-dependent; the REST form is not.** `gh pr
  update-branch` arrived in 2.53, so on an older CLI four invocations can error while reading as
  successful work. This machine is **2.92.0** and has the subcommand; a fleet host measured
  **2.45.0** and did not. Rather than tracking which host has which, prefer the version-independent
  form — `gh api --method PUT repos/{owner}/{repo}/pulls/{n}/update-branch` — and run `gh
  --version` before relying on any subcommand you have not used on that host.

- **`docker exec` defaults to `/app`, which is the baked image copy and is not a git work tree.**
  The Dockerfile sets `WORKDIR /app` and copies a snapshot there, so that directory's verb list is
  frozen at image build time and a verb that shipped hours ago is simply absent. **The live
  checkout is `/home/node/Remudero/remudero`; pass `-w`:**
  `docker exec -w /home/node/Remudero/remudero remudero-daemon ./bin/rmd <verb>`.

- **That checkout is deliberately detached, so it sits behind main between deploys.**
  `deploy/entrypoint.sh` runs `git -C "$TREE" checkout --detach "$TARGET"` on every boot, so
  `git rev-parse --abbrev-ref HEAD` there answers `HEAD` and the tree stays pinned at whatever sha
  it booted on. The verbs that gate on `syncPlanOrRefuse` refuse rather than act on a stale plan;
  the ones that do not will answer from the pinned tree without comment. **Fetching and
  re-detaching to unstick it moves the daemon's own work tree — check `state/inflight/` is empty
  first**, or you will move the ground under a running worker.

- **`gh api --jq '.body'` appends a trailing newline, so a byte-for-byte comparison against the
  source file is always off by one.** Measured on a real PR body: the jq capture is exactly the
  body plus one `\n`, and because the body already ends in a newline, stripping trailing newlines
  removes two characters rather than one. **And `wc -c` counts bytes while Python counts
  characters** — the same body measured 2,587 characters and 2,601 bytes, the gap made entirely of
  multi-byte punctuation. A body full of em-dashes reads as edited when it is identical. **Strip
  trailing newlines and compare characters.**

- **A rate-limited call returns a small JSON error payload with HTTP 403 — and it parses.** The
  captured shape is an object with exactly `message`, `documentation_url` and `status`, where
  `status` is the **string** `"403"`. It was read as content twice. **Guard structurally — assert
  the shape you expected (a list, or a known key), never a size.** A size threshold is a guess that
  happens to work until the error text changes.


## Crisis runbook: the procedures you need at 3am

The rest of this guide is about reading state. These four are the ones you need when you have
to *act* — restarting the supervised daemon, rotating tokens, standing up a new machine, and
knowing where the billing boundary sits. Until now these existed only as tribal knowledge in
session notes, unchecked, so they rotted; `test/runbook-coverage.test.ts` now fails the build if
any of the four goes missing or is reduced to a stub heading, and a later-added procedure is
appended to `src/lib/runbook-coverage.ts`'s named list, not discovered by hand.

### Restarting the supervised daemon

The daemon (`rmd daemon`, loaded via `~/Library/LaunchAgents/com.remudero.daemon.plist`, label
`com.remudero.daemon`) loads its code once at start and dispatches in-process. See
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

#### What a merged fix reaches before you restart — and what it does not

This is the single most misread thing about the running fleet, so read it before you merge a fix
and watch the next run to see whether it worked. **A merge does not take effect all at once. Three
things load code or data on three different schedules, and only one of them is frozen:**

| what | when it loads | so a fix merged mid-drain… |
|---|---|---|
| **The plan** | re-read from `origin/main` at **every dispatch** (`syncPlanFromOrigin`, `src/run-task.ts` — it fetches, then reads the blob, never your local checkout) | **is live immediately.** A merged plan or task edit governs the very next dispatch. |
| **The worker's tree** | a fresh `git worktree add … origin/main` per run (`worktreeAdd`, `src/lib/worker.ts`, which fetches first) | **is live immediately.** The worker builds and tests against your merged `src/`. |
| **The orchestrator itself** — the drain loop, the linter, and the acceptance judge (`judgeReview`, called in-process from `src/run-task.ts`) | **once, at process start.** The already-loaded module graph is unaffected by a later merge. | **is NOT live. It is frozen until the process restarts.** |

The consequence that catches people: merge a fix to the review gate, watch the next run, and you
will see a **mixed** result — the worker behaved differently (fresh tree, fresh plan) while the
judge that graded it did not. That is not a flaky gate and not a failed fix; it is a restart you
have not done yet. Judge behaviour is only observable **after** the restart below.

This asymmetry is deliberate and recorded, not an oversight: `src/lib/self-sync.ts` self-syncs the
CLI at **startup** and says so in its own header — in-process staleness in a long-running daemon is
explicitly out of its scope and belongs to the WS-2 self-updater. Until that ships, the restart is
the mechanism.

**The reap-wait, if the same host also runs `rmd serve`.** Killing a process does not instantly
free the port it held, so a kill-then-immediately-restart of `rmd serve` can still hit
`EADDRINUSE` even though `kill` already returned. Two things now absorb that race, and neither
requires you to time it by hand:

- Restart the console through launchd — `launchctl kickstart -k gui/$(id -u)/com.remudero.serve`
  — rather than by killing a PID. launchd owns the process group and reaps it before relaunching.
- `rmd serve` itself now WAITS OUT a held port (bounded: ~10s, `EADDRINUSE` only) instead of
  dying on the first miss, and says so in the log and the ledger (`serve.bind_retry`) while it
  waits. A port that never frees fails loudly with `serve.bind_failed` and a non-zero exit.

If you are restarting a hand-run `rmd serve` anyway, the port check is still the honest signal:
```sh
lsof -ti :4317        # empty output = the port is free, safe to `rmd serve` again
```

### Recycling the containerised daemon onto a fresh image

The section above restarts the **mini's** launchd-supervised daemon in-process. A **containerised**
daemon (Azure host, `docker run --name remudero-daemon ...` per `deploy/host-update.sh
--print-daemon-run`) needs a different procedure, because replacing a container is not restarting a
process: the old one is destroyed and a new one is created from a freshly pulled image, and the
seven steps that make that safe used to live only in chat. Skipping any one of them took the fleet
down twice in a single day, so `./deploy/recycle-container.sh` is the host-invoked script that runs
them in the load-bearing order, and **its refusals are the deliverable, not the happy path**:

- **No `GH_TOKEN` capturable → refuses before touching anything.** The token lives only in the
  running container's environment (never written to disk) and is unrecoverable once that container
  is gone; this is the very first check, ahead of even the pull.
- **Workers still in flight past a bounded wait → refuses, and removes the pause it set.** The
  script pauses the fleet *before* it starts waiting (so the wait can actually converge), and if the
  wait times out with workers still running it takes the pause back off on the way out — a refusal
  that left the fleet paused forever would be a second outage stacked on the first. This is the
  incident from 2026-08-18: a recycle run without pausing first found three workers mid-run, and
  killing them would have lost the work and stranded their `state/inflight/*.lock` files.
- **A failed `docker pull` → refuses. Never starts the cached image.** The other 2026-08-18
  incident: a pull rejected for `authentication required` was followed by a `docker run` anyway,
  which silently relaunched whatever was already cached under the tag — the operator believed he
  had shipped a new build and had not.
- **The started container's image id disagrees with the digest just pulled → reports a FAILED
  RECYCLE.** A container that started is not proof it started on the image this run obtained;
  `docker inspect --format '{{.Image}}'` against the id captured right after the pull is the one
  check that actually proves it, the same discipline `deploy/verify-image.sh` applies to its own
  probes.

**Every lock under `state/` that would block a boot is printed in full and never deleted or
judged.** `state/drain.lock` and `state/inflight/*.lock` are shown with their holder pid, host and
start time exactly as recorded, because a host-side script cannot safely decide whether a holder is
stale: `isHolderStale`'s container-aware rung (`src/lib/fs-race-safe.ts`, W1-T978) only ever answers
that question from *inside* a container, and the marker it keys on (`/.dockerenv`) is absent on the
host by construction. If a lock names a container that is already gone, the daemon reclaims it on
its own next boot — this script reads and reports, and leaves the decision there.

```sh
GH_TOKEN=<token> ./deploy/recycle-container.sh                 # recycle onto :latest
GH_TOKEN=<token> ./deploy/recycle-container.sh --tag <sha>      # a specific build instead
RMD_RECYCLE_WAIT_S=300 ./deploy/recycle-container.sh            # widen the bounded wait for workers
```

Two adjacent scripts are deliberately **not** re-implemented here, only reused: `deploy/host-update.sh`
owns reclaiming disk (`docker system`/`image`/`builder prune`) and is unrelated to *this* procedure —
run it separately when the host is tight on space — and `deploy/verify-image.sh` owns the full
toolchain probe. A successful recycle prints the command to run that probe next; the recycle itself
only proves the running container is on the image it just pulled, not that the image actually works.

Like its siblings, this is a plain bash-and-docker script, on purpose: it must keep working on a host
with no node, no `rmd` and no checkout, which rules out an `rmd` verb outright — every verb runs
`checkCliFreshness` first, which would fast-forward the very checkout the container being recycled
is bind-mounting.

### Attaching a data disk to the container host

The Azure host's OS disk is 30 GB and the image store fills it. Standard practice is a separate
data disk with the image store and the fleet's state bind-mounted onto it. The procedure below is
in the order that works; the first attempt failed on two of these steps and cost most of an
afternoon.

- **The image store is `/var/lib/containerd`, not `/var/lib/docker`, and the driver tells you
  which.** `docker info --format '{{.Driver}}'` reads `overlayfs` here, and `docker info` shows
  `driver-type: io.containerd.snapshotter.v1` — under the containerd snapshotter the layers live
  under `/var/lib/containerd`. Moving `data-root` in `/etc/daemon.json` therefore achieves almost
  nothing on this host: it relocates a directory the snapshotter is not using.
- **Verify with `mountpoint`, `du --one-file-system` and `df` agreeing, before you switch
  anything.** Plain `du` descends through mounts and double-counts, so a directory that is mostly
  other filesystems reads far larger than it is; that misreading is what sent the first attempt at
  `data-root`. `mountpoint -q <path>` answers whether a path is its own mount at all, and `df`
  gives the filesystem's real numbers. Treat a disagreement between the three as "stop and find
  out", never as "pick the biggest".
- **The VM is zonal, so the disk must be created in the same zone.** `az vm show … --query zones`
  reads `["1"]` here; a disk created without `--zone 1` is refused at attach. **A refused attach
  leaves a control-plane lock that rejects a delete of the new disk for several minutes** — wait
  it out rather than retrying into the error.
- **The device is NVMe and the data disk is one character from the OS disk.** `lsblk` shows
  `nvme0n1` (30G, holding `/`) and `nvme0n2` (128G, the data disk). Partition and format
  `nvme0n2`, never `nvme0n1`, and read the size column before you type either name.
- **Every fstab line needs `nofail`, and `findmnt --verify` before you trust a reboot.** Without
  it a disk that fails to attach leaves the host unbootable rather than merely degraded. Run
  `findmnt --verify` under `sudo`: unrooted it still runs but reports `[W] cannot detect on-disk
  filesystem type (Permission denied)` for every entry, which buries any real warning.
- **Stop the daemon container before bind-mounting over its state path.** Docker resolves a bind
  mount at container start, so mounting over a path a running container already holds leaves that
  container on the old inode — it keeps reading and writing the directory you just replaced, and
  nothing reports it.
- **A shell sitting below a moved path loses `getcwd()` entirely.** Every command in that shell
  then fails with an error that names the command rather than the cause. `cd ~` fixes it; a new
  shell also works. Do not debug the command.

The live layout, for comparison when you next do this:

```sh
docker info --format '{{.Driver}}'      # overlayfs; `docker info | grep driver-type` -> containerd
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT      # nvme0n1 = 30G OS, nvme0n2 = 128G data -> /mnt/rmd
mountpoint -q /var/lib/containerd       # the image store, bind-mounted onto the data disk
df -h / /mnt/rmd                        # the numbers that decide whether this was worth doing
findmnt --verify                        # run under sudo; unrooted warnings are noise, not findings
```

and the two bind mounts, as they read in `/etc/fstab`:

```
UUID=<data-disk-uuid> /mnt/rmd ext4 defaults,nofail 0 2
/mnt/rmd/containerd /var/lib/containerd none bind,nofail 0 0
/mnt/rmd/state2 /home/<user>/rmd-state2 none bind,nofail 0 0
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
   rmd serve-plist --write
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.remudero.serve.plist
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
(`PATH`/`HOME`/`TMPDIR`/`LANG`/`USER`) and **throws** if any `ANTHROPIC_*` key survives —
including one passed in explicitly — a leak fails loud at construction, never silently on an
invoice. The sole exception is the sanctioned overflow valve below, and only when it is
deliberately engaged. The same allowlist check applies to the daemon's own boot environment in
`src/lib/launchd.ts`.

**Where the boundary actually sits.** `launchd` never sources `~/.zshrc`, so a daemon loaded via
`launchctl load` is clean by construction. The risk case is a daemon started from a **dev
shell** for local testing: if that shell exports `ANTHROPIC_API_KEY` (common alongside other
CLI/SDK work), the daemon *process itself* carries the key — but with the valve OFF (the default)
every worker it spawns still gets a clean env via `buildWorkerEnv`, so the fleet stays on
subscription. Check before running a dev-shell daemon you intend to keep on subscription:
```sh
env | grep -i ^ANTHROPIC_    # nothing here ⇒ subscription guaranteed regardless of config
```

### Switching the fleet's Anthropic account (W1-T265)

Before this task, the ONLY way to move a host's fleet from one Anthropic subscription to
another was undocumented and unledgered: `claude /logout` + `/login` as the fleet user, then
moving `state/remudero-worker.keychain-db` aside by hand so the next boot re-provisioned it. It
worked because `ensureWorkerKeychain` (`src/lib/worker-home.ts`) gated provisioning on file
**existence alone** — never identity — so logging into a second subscription without also
clearing that file left every worker still spending the FIRST account while the console watched
the second, silently, with nothing anywhere comparing the two.

**As of this task, the manual file move is no longer necessary for a normal switch.** Every
worker spawn (`spawnWorker`, `src/lib/worker.ts`) now resolves the active Anthropic account
identity fresh — per spawn, never cached — from `~/.claude.json`'s `oauthAccount.accountUuid`
(falling back to `emailAddress`), and compares it against the identity the dedicated worker
keychain (`state/remudero-worker.keychain-db`) was last provisioned for, recorded in a plain-text
sidecar (`state/worker-keychain-account`, a NAME, never a credential). A mismatch — including a
store that predates this task and carries no recorded identity at all — re-provisions the
keychain from the (now-current) login item before the spawn proceeds, rather than silently
reusing the stale copy.

The procedure:

```sh
rmd down --reason "switching Anthropic account"   # graceful stop — never kill mid-task
claude /logout                                    # as the fleet user
claude /login                                      # into the NEW subscription
rmd up                                             # resume; the NEXT worker spawn re-provisions
```

`rmd down`/`rmd up` are the same verbs used for [restarting the supervised
daemon](#restarting-the-supervised-daemon) — winding the fleet down first avoids a mid-task kill
racing the credential swap. Nothing below `rmd up` requires touching
`state/remudero-worker.keychain-db` by hand; deleting it is still safe (it just forces the next
spawn's provisioning path regardless of identity) but is no longer the only lever.

**What this does NOT yet cover** (tracked as follow-on work, not part of this task): the
daemon's own boot-time keychain unlock (`daemon.worker_keychain`, logged from `src/run-task.ts`'s
`daemonBoot` call) still uses the pre-W1-T265, identity-unaware gate — it only warms the
keychain so it's unlocked before the first spawn, and every spawn re-checks identity on its own
regardless of what boot saw. So a switch is corrected by the next spawn even though the boot
ledger line itself does not yet name which account it provisioned for. Also out of scope: WHICH
account a given run should use in the first place — nothing in remudero selects an account; this
task only makes the one store that exists follow whichever account is actually logged in.

### Recovering from an expired worker credential copy (W1-T293)

Before this task, the copied OAuth token in `state/remudero-worker.keychain-db` had no expiry of
its own tracked anywhere: `ensureWorkerKeychain` gated re-provisioning on file existence (and, as
of W1-T265, account identity) only, so a SAME-account copy that simply went stale over time kept
reading as healthy and was reused forever. Recovery required a human: unlock the login keychain,
delete `state/remudero-worker.keychain-db` and `state/worker-keychain-password` by hand, and wait
for the next spawn to re-provision. Left unattended, the fleet spun on dead-credential spawns at
$0 until someone did that by hand.

**As of this task, the manual two-file deletion is no longer the recovery path.** Every spawn now
carries a third, cheap check alongside the identity gate: a small sidecar
(`state/worker-keychain-expiry`, a plain-text epoch-ms NUMBER — never a credential) records the
copied token's own `expiresAt` at the moment it was last provisioned, and a token at or within a
five-minute skew of that timestamp is treated as stale and re-provisioned from the live login item,
exactly like the absent/identity-mismatch paths already did. The reason is auditable on the
returned summary as `"credential-expired"`, distinct from `"absent"`/`"identity-changed"`/
`"skipped"`. A worker store whose sidecar is present but empty or unparseable — the shape a failed
in-process token refresh can leave behind — is treated the same as absent, never as healthy. If the
login keychain itself is locked when a recovery is attempted, the run fails closed with a named
reason (never spawns on the known-dead copy), and a login token that stays dead escalates once per
daemon boot rather than re-attempting the read on every spawn.

Manually deleting `state/remudero-worker.keychain-db` / `state/worker-keychain-password` is still a
safe escape hatch (it still forces the next spawn's provisioning path), but is no longer required
for an expired copy to heal — the next spawn does it automatically.

### Engaging the overflow valve: draining on API credits (W1-T258)

When the subscription window is exhausted and you want the fleet to keep draining on **metered
API credits**, engage the valve. It is **two-factor by design** — the key merely being present in
a shell can never bill the fleet on its own:

1. **Intent** — set `overflow: "api_key"` in `~/.config/remudero/config.json`. `validateConfig`
   refuses this unless it is paired with a `dailyCapUsd` (§9 conditional-cap guard: an uncapped
   API run is a rejected config, never a silent possibility). This is what the harness reads to
   decide whether the key may cross the boundary.
2. **Key** — export `ANTHROPIC_API_KEY` into the environment of the process that launches the
   fleet (`rmd drain`/`rmd daemon`). It travels **env → env only**: passed by value into each
   worker's env, never written to a file, never logged (only its NAME appears in a ledger line's
   `childEnvKeys`, as billing-boundary proof).

With both in place, each worker's ledger line records `billing_mode:"api"` (derived from the
worker's actual env, never guessed); the `daemon.boot` line reports `api` too. Absent *either*
factor, the run bills subscription exactly as before. The dollar figures (`budget_usd`, the
soft/hard caps) — notional under subscription — become **real money** in this mode, which is why
the `dailyCapUsd` pairing is mandatory.

**launchd plumbing note (the daemon's spawns need the key too).** A daemon supervised by
`launchd` does **not** inherit your shell — its environment is exactly the plist's
`EnvironmentVariables`, which `generateLaunchdPlist` builds as a closed `PATH`+`HOME` allowlist
and **refuses to emit any `ANTHROPIC_*` key into** (no secret is ever written to the plist file —
that would be a secret at rest in a world-readable `~/Library/LaunchAgents/*.plist`, contrary to
"the key arrives via environment only"). So for **overnight draining on credits** you have two
honest choices:

- **(Recommended, env-only)** Run the daemon *not* under `launchd` but from a persistent session
  (a `tmux`/`screen` window, or a wrapper) that has `ANTHROPIC_API_KEY` exported and
  `overflow:"api_key"` configured. The key stays in process memory, never on disk.
- **(Key-at-rest tradeoff)** Add `ANTHROPIC_API_KEY` to the launchd unit's `EnvironmentVariables`
  by hand after generating the plist. This keeps `launchd` KeepAlive supervision but writes the
  secret into the plist file — tighten its permissions (`chmod 600`) and know you have accepted a
  secret at rest. The generator will never do this for you.

A durable third path — a launchd wrapper that sources the key from a `600` file or the login
keychain and execs `rmd daemon` with it exported (KeepAlive supervision *and* no plist secret) —
is the intended follow-up; until it lands, prefer the env-only session above.
