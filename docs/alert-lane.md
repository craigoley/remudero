# Alert-fix lane (W1-T90, ratifies P20)

§5D lane 2 (W1-T55 surface → W1-T56 triage, both **SHIPPED** — `src/lib/ops.ts`)
polls code-scanning/Dependabot/secret-scanning alerts, escalates every new
critical/high one, and captures **every** open alert as a `plan/feedback/`
entry (`origin: alert#<source>-<id>`) for `rmd triage` to ground. That loop
ends at "triage proposes a corrective task" — every alert then waits on a
human, including trivial ones.

The [dependency-PR review lane](dep-review.md) (W1-T54, **SHIPPED**) is the
**precedent** this lane mirrors exactly: a deterministic policy (no LLM call,
ever — rule 2) decides act-vs-escalate with **no per-item `plan/tasks.yaml`
write** (rule 15) and no per-item human ratification. `rmd alert-fix`
(`src/lib/alert-lane.ts` + `src/run-task.ts`'s `alertFixCommand`) is the same
split, applied to scanner alerts.

## The policy: `plan/alert-policy.yaml`

Policy **as data** — `(severity × path) → act | escalate`:

```yaml
act_severities: [medium, low]
critical_paths:
  review: ["src/lib/review.ts"]
  gate: ["src/lib/gate*.ts"]
  containment: ["src/lib/containment*.ts"]
  ledger: ["src/lib/ledger.ts"]
  status: ["src/lib/status.ts"]
```

`review`/`gate`/`containment`/`ledger`/`status` are the five
gate/containment-critical categories P20's own text names explicitly. The
`review` category **must** include `src/lib/review.ts` verbatim — the GOLDEN
fixture path P20 cites, and this repo's own task-acceptance judge, whose
critical-path status this lane's decision proves against directly. `*` is the
only supported wildcard (matched against the whole path).

Editing this file alone — no code change — changes what the lane does:
moving a path in/out of `critical_paths`, or widening/narrowing
`act_severities`, flips a fixture's disposition (`src/lib/alert-lane.ts`'s
`validateAlertPolicy`/`loadAlertPolicy` load and validate it; `decideAlertDisposition`
never hardcodes a path or a threshold).

## The two-way decision

`decideAlertDisposition(alert, policy)` (`src/lib/alert-lane.ts`) is a pure
function, no LLM ever, fail-closed throughout:

- **`act`** — severity is `medium`/`low` (a known, policy-listed
  act-severity) **and** the alert's path (when known) is outside the
  critical-path set.
- **`escalate`** — severity is `critical`/`high`, or **unknown** (fail-closed
  — the same "unknown bump level → escalate" convention `dep-review.ts`'s
  `overallSemverLevel` documents), or the path **is** inside the
  critical-path set, regardless of severity.

`AlertLaneAlert` extends `ops.ts`'s `RawAlert` with an **optional** `path`.
None of `ops.ts`'s three normalizers extract a path from the GitHub API today
— a real, separate gap, out of scope for W1-T90 (files: `src/lib/alert-lane.ts`,
`src/run-task.ts`, `plan/alert-policy.yaml` only; `src/lib/ops.ts` is
untouched). Until a future task closes that gap, every alert this lane sees
has `path: undefined`, which counts as **outside** the critical set — only
severity can force escalate when the path is unknown.

## The orchestrator: `runAlertLane`

For each **open** alert, in order:

1. Decide the disposition, and ledger it (`alert-lane.decided` — P20's own
   design note: "every act/escalate decision is a ledger line").
2. **`escalate`** — skip if `escalation.issue_opened` already names this
   alert's taskId (`ops.ts`'s `priorEscalatedAlertIds`, read off the SAME
   ledger); otherwise call `deps.escalate(alert)`.
3. **`act`** — skip if an `alert-lane.dispatched` line already names this
   alert's taskId (the W1-T80 discipline, lane-side); otherwise call
   `deps.dispatch(alert)`, then ledger exactly one `alert-lane.dispatched`
   line carrying the alert's taskId/origin.

**One shared escalation-ledger namespace.** The real `deps.escalate` wiring
(`run-task.ts`'s `alertFixCommand`) opens the issue via the SAME
`escalate()` (`lib/escalate.ts`) + `buildAlertEscalation` (`ops.ts`, reused
verbatim — class `MANUAL`, options `fix`/`dismiss`, recommendation `fix`)
`rmd ops`'s own critical/high poll already uses, keyed by the SAME
`alertTaskId`. An alert `rmd ops` already escalated is never escalated again
here, and vice versa — the two lanes cannot double-escalate the same alert.

## The call site: `rmd alert-fix`

`rmd alert-fix [--repo <name>] [--dry-run]` (`src/run-task.ts`): fetches
every open alert via the SAME `ghAlertGateway()` `rmd ops` uses, loads
`plan/alert-policy.yaml`, and runs `runAlertLane`. An `act` disposition
spawns an ephemeral, lane-owned fix-run worker (`dispatchAlertFixRun`) on a
fresh `alert-fix-<origin>-<epochMs>` branch off `origin/main` — a minimal
analog of the sweep fix-rung's worktree/settings-file mechanics, scoped down
because this is a **brand-new** run, never a fix on an existing task's
branch. The worker fixes the one named alert and opens its own PR (through
the full `[ci, remudero-review]` gate) carrying `origin: alert#<id>`
provenance and the standard `Remudero-Task:`/`Acceptance:` trailer
discipline every other worker-opened PR in this repo carries; this command
only spawns it and tears the worktree down after. `--dry-run` previews every
open alert's disposition and dispatches/escalates nothing.

The lane never writes `plan/tasks.yaml` anywhere — like dep-review, it owns
its run shape entirely outside the human-authored plan (rule 15).
