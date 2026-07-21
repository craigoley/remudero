# REMUDERO — Master Plan (v2.24 · synced 2026-07-21)

**FOCUS — HIGHEST YIELD EVER (27 runs → 23 shipped tasks, 85%). THE R10 CREDIT CLAIM WAS FALSE AND IS
CORRECTED HERE (operator hand-verification, 2026-07-21, PR #469's review comment).** R10 reported that
W1-T150's backfill "landed inert" because ledger credit went 13/26 → 8/27, and set P35 to verify it fires.
**It fires.** Observed live: `sweep.credit_backfill.summary {"total": 134, "corrected": 1}` at 08:59:06, and
the ledger holds **70 `verdict.merged` correction lines**. Three of R10's sixteen "discrepancies" were
reproduced by hand — W1-T154, W1-T157, W1-T181 — and **every one already carries its correction** (PRs #388,
#405, #411). THE REAL DEFECT IS IN THE RETRO'S OWN READING: the backfill writes `step: "verdict.merged"`
(sweep.ts:1218, a correction, because the ledger is append-only and must never be rewritten), while the
gather counts `verdictLine?.verdict` (retro.ts:112) — `step: "verdict"` lines ONLY. The tally is structurally
blind to the corrections, so it measures a number W1-T150 does not and should not move. This is the rule-22
class committed by the organ built to catch it: a CLAIM (the raw verdict line) read as EVIDENCE (effective
credit), with the gap blamed on the fix rather than on the reading. **P35 is REFRAMED accordingly — not
"does the backfill fire" (it does) but "the retro's credit tally must consult corrections."** What DRAINED: the **console/live-state family** (W1-T153–T158, T179, T181,
T187 — the board is fast, honest, and searchable), the **P25 ratification inbox** (W1-T110/T111/T192), the
**P32 layered-knowledge first tasks** (W1-T145/T146), the **governor pair** (W1-T121/T122), and the
**floor-integrity family** (W1-T128/T185). Next, in order: **P35 (REFRAMED — teach the retro tally to read
`verdict.merged` corrections; the backfill itself is verified working) → W1-T149
(P29 sibling credit — re-confirmed live by W1-T156 this cycle) → the stale-trailer quarantine (P33) →
learning-utility + success-mining flywheel (W1-T86/T87/T88) → brownfield onboarding (W1-T82–T85)**.

**Header discipline (v2.17).** This header carries the **sync date + current focus and nothing else**.
The sections are the source of truth; read them. A retro that re-inflates this header has failed the
HARNESS-COMPRESSION bar (§Self-improvement).

**Retro ledger:** R1–R8 seeded CALIBRATION + P1–P32, logged every cycle in the SHIPPED log (WS-1 close →
security/dep-lane → gather-union/reviewer-mount → the proof-executing floor → flight control/PR-pipeline →
the 28-merge knowledge/fleet cycle), corrected the false-merged W1-T54b attribution (#80 → #91), and closed
P1–P11+P15+P21+P27. The per-retro id roll-call is DELETED — the SHIPPED log's section headers already carry
every id and date, and maintaining the same list twice is the duplication HARNESS-COMPRESSION forbids ·
R9 (…556575522) logged the 21-task W3-panel/intake/console cycle and confirmed P31's collapse into P30 ·
**R10 (…626054083, this sync)** logs the **23-task console/live-state + inbox + governor cycle**, re-bases
calibration on 27 runs, CLOSES P25 and P32's first rung on shipped tasks, and mines the **built-but-inert
fix** (P35) plus the **25% approval rate that NARROWS P28's envelope** rather than widening it.

> **Remudero** — the wrangler in charge of the remuda: the hand who manages the worker herd and
> decides which mounts ride today. The orchestrator's own job title. CLI alias `rmd`.
> Domains purchased 2026-07-14. Naming saga + method: D-1.
> **Built in the open from day 1** (G-1) — instance specifics live in a gitignored `local/` overlay.
> **Fleet lives under one root** (§4A): workers are OS-sandboxed to their worktrees; the control
> panel (§7) is one daemon API with desktop + mobile as stateless projections.

## Mission

A plan-stewarding orchestration harness on top of Claude Code. A durable main agent runs the
plan → recon → prompt → implement → review → merge → plan-sync loop against headless Claude Code
workers in git worktrees, escalating to the human like a senior engineer would: rarely, batched,
with options and a recommendation. Open source; runs on a Claude Code subscription; GitHub-native.

**Differentiators vs. the field** (session managers like Claude Squad/Nimbalyst (Crystal's successor — Crystal deprecated 2026-02)/Vibe Kanban/Emdash [research: field-survey-2026-07-16, crystal-deprecated-2026-02];
autonomous-PR tools like Composio AO; control-plane tools like MartinLoop (budget stops, verifier gates, inspectable run receipts) and ivy-tendril (plan lifecycle + verification gates) [research: field-survey-2026-07-16]; native Agent Teams):

1. **Plan stewardship** — MASTER-PLAN.md + tasks.yaml in git is the product; the harness keeps it true.
2. **Provenance gate** — no claim enters a worker prompt without a cited source. Mechanized, not disciplined.
3. **Principles engine** — TDD/DRY/SOLID enforced as deterministic gates + reviewer rubric, not prompt vibes.
4. **Deterministic control plane** — scheduling, trust, budgets, and strikes are code; LLMs never own the loop.
5. **Escalation as GitHub issues** — decisions get provenance, threading, and an audit trail for free.
6. **Durable by design** — native Agent Teams is interactive/ephemeral with documented coordination gaps
   (leads stopping early, task-status lag); Remudero is a daemon that survives restarts and works for days.

COMMODITY BOUNDARY (2026-07-16): parallel-worktree session management is now table stakes — dozens of OSS tools plus Claude Code's NATIVE managed worktrees, workflow primitives, and agent teams [research: cc-native-worktrees-2026, cc-workflows-2026]. The moat is items 1–6 plus the receipts thesis (WS-12), never the concurrency mechanism.

## NET STATE

★ **WS-1 COMPLETE (2026-07-15): the daemon runs itself.** The self-hosting exit criterion is MET —
`rmd daemon`, launchctl-loaded against **remudero-sandbox**, drained **SBX-T1/T2/T3 unattended → merged
PRs #6/#7/#8**, booting ANTHROPIC-clean (`env_clean=true`, `billing_mode=subscription`), then survived a
**kill-9 + launchd KeepAlive restart** recovering to correct GitHub-derived state with **no duplicate task
run** (W1-T12d, verify:human, operator-attested — evidence in the task's `satisfied_by`). The spine and its
PR links are in the SHIPPED log. **Three honest deltas, stated once and owed to WS-7's chaos drills:** the
drill was bounded (`--max 3`, not overnight); no digest send was captured; the kill landed post-drain, so
recovery is proven by no-duplicate + clean idle, not an active `reconstructOrphan`. The self-hosting
CAPABILITY is proven regardless. (§5C's task-pre-flight PLAN is #58; the linter CODE — W1-T20c — is still
QUEUED, and this plan does not claim the mechanism exists.)

★ **L2 IS LIVE (2026-07-15): the harness drained its own SECURITY TIER.** §5's Tier-1 stack now runs on
remudero itself — CodeQL/OSV/Dependabot/leak-grep (W1-T23/#76), the **ci-gate aggregator** as the single
required context (W1-T24/#75, live-proven by the W1-T24b probes #82/#85), and the **dep-review lane**
(W1-T54/#87) with its live proof against the real parked Dependabot PRs (W1-T54b/#91). §5A's "the harness
eats first" is now FACT on the security tier, not intention.

★ **THIS CYCLE (RETRO-1784626054083, 2026-07-21): the console became a real instrument, the ratification
inbox became a loop, and A MERGED FIX FAILED TO MOVE ITS OWN METRIC — 27 runs → 23 shipped tasks (85%),
the best yield yet.** What drained:

- **The console/live-state family** — W1-T153/#376 (design-system overhaul) → W1-T154/#388 (first-paint
  pre-warm) → W1-T155/#365 (full status taxonomy in the projection) → W1-T156/#398 (live in-flight rows +
  freshness/connection honesty) → W1-T157/#405 (fuzzy find + facets + cmd+K + URL state) → W1-T158/#410
  (task-detail + journey view over `rmd trace`), plus the two LIVE OUTAGES it exposed: W1-T181/#411
  (ENOBUFS on >1 MiB PR JSON — the board silently read merged 0/N) and W1-T187/#445 (O(tasks × ledger)
  reprojection answering in 35–58s against a <2s budget). W1-T179/#431 closed T155's darkness follow-up.
- **The P25 ratification inbox, end to end** — W1-T110/#368 (deterministic readiness + drafted candidates),
  W1-T111/#373 (`rmd approve`/`rmd reframe` + approval telemetry), W1-T192/#457 (the draft rung moved
  daemon-side so a fired trigger redrafts on poll, not on a CLI pull). **P25 is CLOSED.**
- **The governor pair** — W1-T121/#385 (queue governor: WIP limit on dispatch only) and W1-T122/#386 (plan
  sharding under `plan/tasks.d/`, so concurrent filings are conflict-free by construction). These are
  P19's named prerequisites; W1-T170/T171/T172 are now unblocked.
- **Floor integrity** — W1-T128/#414 (the DEAD PROOF FLOOR: 101 of 126 runnable-dialect proofs could never
  execute) and W1-T185/#456 (a verdict with ZERO executed proofs renders CAPPED/DEGRADED and cannot arm
  auto-merge on tdd:strict work). W1-T178/#423 added verdict stability on unchanged input; W1-T177/#417
  made every spending site re-read terminal state fresh.
- **P32's first rung + credit machinery** — W1-T145/#360 + W1-T146/#371 (layer schema/homes, then
  scrub-then-judge promotion), W1-T119/#382 (throttled-vs-absent GitHub reads defer, never conclude),
  W1-T136/#437 (every machine plan-PR emitter emits a gate-mergeable PR), W1-T150/#358 (P30's backfill).

★ **THE FINDING: W1-T150 SHIPPED AND CREDITING GOT WORSE.** P30's level-triggered credit backfill merged as
**#358 — the LOWEST PR number in this cycle**, i.e. early. Of the 22 tasks that shipped after it, **15 were
still gate-side merges the union had to rescue**, and ledger credit fell 13/26 (50%) → **8/27 (30%)**. A
built, merged, ratified fix did not move the metric it was built to move. Either the backfill rung is not
running in the operator-kicked path (the daemon drains the SANDBOX; `rmd sweep` may simply never fire on
`remudero`), or it runs and does not match. **This is not a request for more credit machinery — it is a
request for a live proof that the machinery we already merged executes.** Mined as **P35**, top of queue.
Consumers still reading a false-negative `verdict` are unchanged: deriveStatus (dispatch!), calibration,
`rmd trace`, the P25 readiness predicate.

★ **P29 RE-CONFIRMED LIVE, by a NEW instance.** Run `W1-T156-1784574954974` was credit-REJECTED because its
trailer names #398, whose head branch is `run-W1-T156-1784579460422` — **a LATER SIBLING RUN OF THE SAME
TASK**. That is precisely the case P29(i)'s task-owned-branch rule credits and today's this-run's-branch
rule cannot. W1-T149 remains UNBUILT through a second full cycle. (The distinct W1-T64/#115 stale-FOREIGN
trailer that P33 covers did not recur this cycle — P33 stays open on its original evidence, unre-mined.)

★ **PRIOR CYCLES (folded — the SHIPPED log carries the detail).** R9 (2026-07-20): the spin loop ENDED
(195 runs → 26) and the W3 control panel (W3-T2/T5/T6/T8), the `rmd serve` console (W1-T139/T140/T141) and
the alert/issue intake lane (W1-T41/T43/T55/T56/T57) all drained — 21 shipped tasks, 13 ledger-credited,
the first non-zero credit column since R7 and the first `diagnose`-typed run ever to reach calibration.
R8 (2026-07-19): the biggest cycle by
count — 28 merges draining the knowledge holes (W1-T29–T40) and the fleet/quality remainder (W1-T44–T50) —
and the **SECOND INTEGRITY INVERSION**, in the LIVENESS direction: 0/195 runs ledgered a merge (P30) while
W1-T1 was re-dispatched ~130 times over ~10 hours because its own merged PR (#255) could not credit a
SIBLING run (P29), at a cost of ~$130 in pure churn. That is the mirror of R5's false OVER-claim, and both
say the same thing: **credit is a gate concern, not bookkeeping.** R7 (2026-07-18): flight control's four
layers (W1-T20/#132 → T21/#141 → T22/#142 → W2-T1/#145) and the level-triggered PR-pipeline reconciler
family (W1-T76/#158, T78/#168, T80/#159, T93/T94/T95 → #165–#167), plus blocked_ci → ci-log fix path
(W1-T100/#173), deriveStatus corrections-supreme (W1-T75/#138), and the architecture fitness tier
(W1-T26/#176). R6: the deterministic FLOOR became
state-aware, executing each criterion's whitelisted proof against the PR head, so the LLM reviewer is
purely additive (W1-T65/#122; **P15 CLOSED**). R5: three self-hosting holes closed — the gather unions
ledger∪GitHub-derived trailered merges (W1-T51/#97; **P11 CLOSED**), the reviewer/fix/diagnose phases are
mount-governed with `reviewer_outcome` surfaced (W1-T63/#104; **P10 CLOSED**), and the runner self-syncs
from origin/main before dispatch (W1-T60/#105), with isolation preflight failing closed (W1-T17/#99). R5
also found **the FIRST INTEGRITY INVERSION** — run `W1-T54b-1784151420811` ledgered `verdict=merged`
against **#80, Dependabot's PR** (real output #91); W1-T62/#93 fixed the parser but the corrupt trailer it
already emitted SURVIVES on #80. Mechanism + un-stamp residue: **P9 → W1-T75 (SHIPPED #138)**.

**Inventory (verified 2026-07-21: 23 tasks shipped this cycle, ~240 merged PRs on `remudero`, 6 on
`remudero-sandbox`).** WS-0 spike SHIPPED (7/7 verdicts GREEN, PR #1). WS-1 then ate its ENTIRE backlog
through its own proto-runner — the gate, the escalation arc, LEARNINGS injection, the resource primitives,
the daemon spine, and the operator surface — and **WS-3's control panel is now a real instrument**, not
just a shell: searchable, honest about its own liveness, and answering inside its latency budget. The
SHIPPED log is the record (rule 13 — the proof is a merged PR); no PR-by-PR restatement lives here.

**mounts.yaml v0 (W1-T5) is SHIPPED** — #42, Tier-Invariant validation, on disk at `.remudero/mounts.yaml`,
re-based to a flat-400 tripwire by #90. The calibration table below exists to re-base that shipped mount
table, not to unblock it.

**Still PLANNED, not shipped** (the honest remainder): **W1-T149 — P29 sibling credit, ratified two cycles
ago and still unbuilt**; the ratified-but-unbuilt flywheel/onboarding families (W1-T82–T85 onboard, W1-T86
wipe-test, W1-T87 success-mining, W1-T88 consolidation, W1-T89 MAST publish, W1-T90 alert-fix lane, W1-T91
isolation golden); P19's now-UNBLOCKED parallel-dispatch family (W1-T170/T171/T172 — W1-T121/T122 shipped);
remaining fleet tasks (W1-T25/T28, W2-T2 dry-run). The P25 inbox (W1-T110/T111/T192), the P32 first rung
(W1-T145/T146), W1-T150 and the console family all DRAINED this cycle and are struck from this list.

**NEXT (L2) — kick order, re-graded against R10's data and CORRECTED by hand-verification:** **(1) P35
(REFRAMED) — the backfill is PROVEN firing (134 evaluated, 70 corrections in-ledger); the real work is teaching
the retro tally to consult `verdict.merged` corrections instead of raw `verdict` lines —
fires on `remudero`, because 15 of 22 post-#358 merges say it does not; (2) W1-T149 (P29) — re-confirmed
live by W1-T156 and unbuilt for two cycles; (3) the stale-trailer quarantine (P33); (4) learning-utility +
success-mining flywheel (W1-T86/T87/T88); (5) brownfield onboarding (W1-T82–T85); (6) W1-T170/T171/T172
now that their prerequisites merged.** The binding constraint is UNCHANGED for a third cycle — the harness
still cannot reliably tell itself what it already finished — but the DIAGNOSIS has moved: this is no longer
"the fix is unbuilt", it is **"the fix is merged and appears inert"**, which is a strictly cheaper and more
falsifiable question. R10's block mix (blocked_ci×9, blocked×7, incomplete×3 — 15 of these 19 merged
gate-side) is mined in Retro proposals.
NOTE: `nextRunnable` (drain.ts:31 `plan.tasks.find`) is DECLARATION-ORDERED, but the daemon currently
drains the SANDBOX; the remudero queue is operator-kicked, so this is the authoritative KICK ORDER
(mirrored as a comment atop plan/tasks.yaml).

## SHIPPED log

Shipped arcs, keyed by Remudero-Task (Standing rule 13: the proof is a MERGED PR, not prose).
Newest first. Cost/turns from the run ledger.

### RETRO-1784626054083 (2026-07-21) — the console instrument + the ratification inbox + the governors (23 tasks shipped)

★ **Only 8 of 23 were LEDGER-CREDITED (30%, DOWN from R9's 50%) — and W1-T150, the fix for exactly this,
merged FIRST (#358).** The 15 marked `(gate-side)` are P30 residue that arrived AFTER its own fix shipped.
That inversion is the cycle's finding and is mined as P35. Cost/turns from the run ledger.

- **W1-T185** — FLOOR VERDICT INTEGRITY: a verdict with ZERO executed proofs renders CAPPED/DEGRADED and
  cannot arm auto-merge on tdd:strict work; `rmd review` from the operator checkout executes at the PR head
  or marks itself keyword-only → craigoley/remudero#456 · $34.059 · 118 turns · the cycle's most expensive run
- **W1-T177** — TERMINAL-STATE CHECK AT EVERY SPENDING SITE: before any action that spends money or acts on
  a PR, the PR's terminal state is re-read FRESH, never from snapshot → craigoley/remudero#417 · $23.801 ·
  160 turns · (gate-side; run ended blocked)
- **W1-T192** — the DRAFT RUNG runs daemon-side: a fired trigger or a reframe-invalidated draft redrafts on
  the next poll; `rmd inbox` demoted to viewer → craigoley/remudero#457 · $23.810 · 108 turns
- **W1-T178** — VERDICT STABILITY ON UNCHANGED INPUT: a re-review of an unchanged head that PASSED is never
  downgraded by semantic-lane noise; a legitimate downgrade must cite what changed →
  craigoley/remudero#423 · $18.132 · 127 turns · (gate-side; run ended blocked)
- **W1-T153** — console shell UX overhaul: operator-priority sections + a real design system (dark,
  phone-first) replacing the flat file-order table → craigoley/remudero#376 · $12.573 · 152 turns ·
  (gate-side; blocked_ci)
- **W1-T157** — the FIND layer: client-side fuzzy search + faceted filters with live counts + sortable
  columns + cmd+K + URL-persisted shareable view state → craigoley/remudero#405 · $12.308 · 34 turns ·
  (gate-side; blocked_ci)
- **W1-T158** — the DETAIL + JOURNEY layer: row-click task card (criteria, dep chain, run history with
  cost/verdict) + a journey view rendering `rmd trace`'s chain → craigoley/remudero#410 · $11.999 · 145
  turns · (gate-side; blocked_ci)
- **W1-T181** — LIVE OUTAGE FIX: the batched board gateway had silently returned `[]` on every read since
  the repo's PR JSON crossed 1 MiB (`execFileSync` without `maxBuffer` → ENOBUFS → empty catch), so the
  whole board read merged 0/N → craigoley/remudero#411 · $11.607 · 23 turns · (gate-side; blocked)
- **W1-T179** — the W1-T155 darkness follow-up: monotonic-under-darkness (a gateway-fetch failure never
  regresses a credited task to queued; marked `github_unobservable`) + the in-flight liveness bound. Both
  criteria were amended onto W1-T155 AFTER it merged, so nothing could ever have dispatched them →
  craigoley/remudero#431 · $11.545 · 114 turns · (gate-side; blocked)
- **W1-T136** — every machine plan-PR emitter (retro, approve, future inbox writes) shares ONE
  gate-compliant emitter: plan-index regen, commitlint-clean header AND body, judgeable Acceptance block →
  craigoley/remudero#437 · $11.201 · 51 turns · (gate-side; blocked_ci)
- **W1-T110** — `rmd inbox`: the ratification inbox's deterministic core — Architect-drafted candidates + a
  rule-2 readiness predicate; deferred-with-trigger is never recommended (ratifies P25 i) →
  craigoley/remudero#368 · $10.209 · 116 turns · (gate-side; blocked_ci)
- **W1-T145** — layered knowledge: ONE entry schema valid at every layer + the layer homes (project /
  user-overall / rmd-global) — P32's first task → craigoley/remudero#360 · $8.845 · 71 turns ·
  (gate-side; blocked)
- **W1-T111** — `rmd approve` / `rmd reframe`: one bit ratifies through the gate, feedback redrafts through
  the ledger, approve-rate is telemetry (ratifies P25 ii–iv) → craigoley/remudero#373 · $8.828 · 114 turns
- **W1-T150** — P30's level-triggered credit backfill: the sweep appends a `verdict.merged` correction for
  any task whose owned PR merged but is uncredited → craigoley/remudero#358 · $8.764 · 80 turns ·
  ★ **merged first, and 15 gate-side merges followed it — see P35**
- **W1-T154** — console first-paint: pre-warm the batched gateway at boot + skeleton/last-snapshot cache;
  <2s first-paint-to-data at 183-task scale → craigoley/remudero#388 · $7.755 · 106 turns · (gate-side;
  blocked_ci)
- **W1-T155** — live-state DATA: the board projection exposes the FULL status taxonomy (in-flight+phase,
  blocked, needs-human, armed-awaiting-merge) + startedAt/elapsed, joined from ledger run state →
  craigoley/remudero#365 · $7.647 · 116 turns
- **W1-T156** — live-state UI + TRUST: in-flight rows animate with live elapsed + phase, SSE flips
  transition in place, and the console never lies about its own liveness → craigoley/remudero#398 ·
  $6.907 · 88 turns · (gate-side; blocked_ci) · ★ **its earlier sibling run was credit-REJECTED against
  this same PR — the live P29(i) instance**
- **W1-T128** — THE DEAD PROOF FLOOR: 101 of 126 runnable-dialect proofs (80%) could never execute →
  craigoley/remudero#414 · $5.600 · 81 turns
- **W1-T146** — layered knowledge: promotion = scrub (leak-grep + PII) THEN judge (applicability eval);
  per-layer budget ratchet — P32's second task → craigoley/remudero#371 · $3.132 · 46 turns · (gate-side;
  blocked_ci)
- **W1-T119** — GitHub reads distinguish THROTTLED from ABSENT: an exhausted or errored read DEFERS, never
  concludes not-merged (the false `source=none` that mis-filed W1-T116) → craigoley/remudero#382 · $3.015 ·
  55 turns · (gate-side; blocked_ci)
- **W1-T121** — QUEUE GOVERNOR: a WIP limit on DISPATCH only — flow control throttles intake, never
  drainage → craigoley/remudero#385 · $2.976 · 51 turns
- **W1-T122** — PLAN SHARDING (`plan/tasks.d/`): concurrent filings are conflict-free BY CONSTRUCTION →
  craigoley/remudero#386 · $2.437 · 36 turns
- **W1-T187** — LIVE OPERATOR OUTAGE FIX: `projectPlan` re-read and re-parsed the WHOLE ledger once PER
  TASK (O(tasks × ledger)); a 250ms SSE poll drove that recompute and the console answered in 35–58 SECONDS
  against a <2s budget → craigoley/remudero#445 · $0.238 · 30 turns · (gate-side; run ended incomplete)

### RETRO-1784556575522 (2026-07-20) — the W3 panel + the console + the intake lane (21 tasks shipped)

★ **13 of these were LEDGER-CREDITED** — the first non-zero credit column since R7, and the reason this
cycle reads as 21 shipped from only 26 runs. The 8 marked `(gate-side)` are the P30 residue: the PR merged,
the run verdict never said so. Cost/turns from the run ledger.

- **W3-T5** — human-in-the-loop panel actions: answer/approve/Pause-Resume-STOP/quiet-hours →
  craigoley/remudero#300 · $16.141 · 154 turns · the cycle's most expensive run
- **W3-T8** — panel skill actions: each registry skill is a panel button wired to the registry →
  craigoley/remudero#305 · $15.713 · 110 turns · (gate-side; run ended blocked)
- **W1-T45** — plan/refine/expand unified into `rmd plan --mode=create|clarify|expand` (ONE code path) →
  craigoley/remudero#303 · $14.006 · 79 turns · (gate-side; run ended blocked)
- **W3-T6** — panel: plan→task→PR graph + INTERACTIVE plan adjustment →
  craigoley/remudero#302 · $12.618 · 106 turns
- **W1-T43** — `rmd trace <id>`: the provenance chain feedback → proposal → task → run → PR → sha →
  craigoley/remudero#301 · $12.086 · 92 turns
- **W1-T138** — the fix rung stops mis-routing CI-check-only blocks to reviewer-unmet mode (the W1-T94
  ci-log follow-up) → craigoley/remudero#345 · $10.972 · 124 turns · (gate-side; run ended blocked_ci)
- **W1-T139/T140/T141 — the `rmd serve` console family, FOLDED to one line** (the PWA-installable
  authenticated live board → drain preview + curation panel driving dispatch → post-drain rundown with a
  one-tap operator verdict written to the ledger as `operator_feedback`) →
  craigoley/remudero#334/#338/#346 · $20.593 total · 304 turns
- **W1-T41/T43/T55/T56/T57 — the INTAKE LANE, FOLDED to one line** (`rmd triage` the Architect intake
  worker · `rmd trace` the provenance chain · alert intake v0/v1 for §5D lane 2, alerts becoming
  `origin: alert#<id>` artifacts · issues intake on managed repos) →
  craigoley/remudero#291/#301/#310/#315/#314 · $36.270 total · 391 turns
- **W3-T2** — dashboard v0 (shell 0): read-only live board over the api-client →
  craigoley/remudero#294 · $7.361 · 96 turns
- **W1-T61/T66/T67/T131 — security + hygiene, FOLDED to one line** (SECURITY.md + private disclosure ·
  least-privilege workflow permissions + pinned deps · exclusive-create for first-run config writes, both
  CodeQL `js/file-system-race` HIGHs · the per-fixture temp-dir leak) →
  craigoley/remudero#320/#323/#324/#341 · $13.994 total · 152 turns
- **W1-T52/T53/T59 — triage + plumbing, FOLDED to one line** (the P5+P6 terminal-cause pass — **the FIRST
  `diagnose`-typed run ever to reach calibration** · `rmd drain --repo` · the P1 spiral golden, which fired
  correctly) → craigoley/remudero#308/#309/#318 · $11.780 total · 153 turns

### RETRO-1784512714705 (2026-07-19) — the knowledge holes + the fleet remainder (28 merges)

★ **EVERY entry below is a GATE-SIDE merge** — the union half of W1-T51/#97 is the sole reason they are
here. Not one was ledgered `verdict=merged`; the run-verdict column records what the RUN believed, and it
was wrong 28/28. That blackout is P30, and it is why cost/turns below are the honest per-task price while
the calibration table's headline averages are not.

- **W1-T132** — → craigoley/remudero#282 · $0.229 · 39 turns · (run ended incomplete)
- **W1-T115** — → craigoley/remudero#279 · $12.004 · 60 turns · (run ended blocked)
- **W1-T108** — → craigoley/remudero#274 · $8.946 · 60 turns · (run ended blocked)
- **W1-T1** — the task at the center of the redispatch storm (P29): ~130 dispatches, ONE owned merge →
  craigoley/remudero#255 · $1.985 · 32 turns · (run ended pr_attribution_failed)
- **W1-T44/T46/T47/T48/T50 — the fleet/quality remainder, FOLDED to one line** (five near-identical
  entries; the ids and PR numbers are contiguous and the per-task prose said nothing the family line does
  not) → craigoley/remudero#240/#245/#247/#249/#251 · $29.273 total · 354 turns · all blocked_ci, all
  gate-side
- **W1-T29–T40 — the knowledge-hole family, FOLDED to one line** (twelve entries that differed only in id,
  PR number, and price) → craigoley/remudero#216/#218/#220/#222/#224/#226/#228/#230/#232/#234/#236/#238 ·
  $65.597 total · 954 turns · all blocked_ci, all gate-side. W1-T29 opened the family and took **×10
  redispatches before credit** (P29); W1-T39/#236 was the cycle's most expensive run at $13.000/111t.
- **W2-T3** — the first W2 task to land → craigoley/remudero#242 · $12.452 · 118 turns · (run ended blocked)
- **W3-T1a** — the first W3 task to land → craigoley/remudero#212 · $0.231 · 53 turns · (incomplete)
- **W1-T27** — `rmd project init` → craigoley/remudero#204 · $5.380 · 39 turns · (run ended blocked_ci)
- **W1-T97/T98/T102/T103 — FOLDED** → craigoley/remudero#197/#199/#194/#196 · $15.855 total · 234 turns

### RETRO-1784383376396 (2026-07-18) — flight control + the PR-pipeline reconciler (14 merges)

- **W1-T26** — architecture fitness tier: dependency-cruiser layering rule enforced in CI + ADR discipline
  → craigoley/remudero#176 · $4.464 · 92 turns
- **W1-T100** — blocked_ci routes to the ci-log fix path: fix FIRST, ask after exhaustion (the #170 fix;
  interim `rmd fix` bridge claim FALSIFIED live #175 — the fix path is the real bridge) →
  craigoley/remudero#173 · $19.270 · 175 turns
- **W1-T78** — the CLARIFICATION-QUESTION rung: an ambiguous block yields a specific, decidable operator
  question, never silence (ratifies P22's new rung) → craigoley/remudero#168 · $21.066 · 215 turns
- **W1-T95** — `rmd fix <pr>`: the operator verb for the fix rung → craigoley/remudero#167 · $4.503 · 70 turns
- **W1-T94** — fix-rung failure-mode taxonomy: MODE derives from block evidence (per-mode inputs) →
  craigoley/remudero#166 · $5.470 · 53 turns
- **W1-T93** — sweep dispositions incorporate CI state: CI-red is never mergeable, escalate is the
  catch-all (closes the #161 hole) → craigoley/remudero#165 · $2.599 · 30 turns
- **W1-T80** — dispatch dedup: an OPEN PR means IN-FLIGHT, never runnable (the #143/#145 race) →
  craigoley/remudero#159 · $4.319 · 72 turns
- **W1-T76** — the blocked_review FIX RUNG: ONE bounded worker, the FULL unmet-criteria set at once, the
  SAME branch (absorbs P21's anti-ping-pong invariant + golden verbatim) → craigoley/remudero#158 · $9.701 · 148 turns
- **W2-T1** — specialist panel (Layer 4): consult, don't committee → craigoley/remudero#145 · $3.317 · 31 turns
- **W1-T22** — flight control Layer 3: risk scoring — deterministic diff-risk bands that make auto-choose
  SAFE → craigoley/remudero#142 · $3.065 · 50 turns
- **W1-T21** — flight control Layer 2: the flight judge — advisory LLM-as-judge on process, deterministic
  controller acts → craigoley/remudero#141 · $6.829 · 77 turns
- **W1-T20d** — the retro plan-health sweep: re-grade the open queue + mine overrun patterns →
  craigoley/remudero#140 · $3.879 · 61 turns
- **W1-T75** — deriveStatus hoists operator corrections above rung (a) + an `rmd correct` writer (ratifies
  P9 — the crediting fix that was blocked by the crediting bug) → craigoley/remudero#138 · $5.532 · 87 turns
- **W1-T20** — flight control Layer 1: deterministic per-turn tripwire signals → craigoley/remudero#132 · $3.619 · 42 turns

### RETRO-1784213948025 (2026-07-16) — the deterministic floor executes proofs

- **W1-T65** — the deterministic FLOOR executes whitelisted proofs against the PR head: each criterion's
  named test/grep runs against repo state (case-normalized), so the gate is correct whether or not the LLM
  reviewer completes and the reviewer is purely additive (ratifies P15; closes the FALSE-PASS/FALSE-BLOCK
  blind-floor hole) → craigoley/remudero#122 · $7.123 · 94 turns

### RETRO-1784206755808 (2026-07-16) — the gather union + the reviewer mount + git self-sync

- **W1-T63** — reviewer/fix/diagnose phases are mount-governed + `reviewer_outcome` surfaced (the reviewer
  stops walling `error_max_turns`; a floor-only merge becomes legible, not silent; closes P10/P10-a) →
  craigoley/remudero#104 · $6.938 · 101 turns
- **W1-T60** — runner self-syncs git state: fetch origin + dispatch from origin/main, never the operator's
  local checkout → craigoley/remudero#105 · $6.013 · 98 turns
- **W1-T51** — retro-gather completeness: cross-check ledger-merged vs GitHub-merged trailered PRs so
  gate-side merges stop being invisible (closes the R3/R4 recurring reconciliation gap; P11) →
  craigoley/remudero#97 · $4.343 · 64 turns
- **W1-T17** — isolation preflight probe: fail closed before any task work begins (FIELD FINDING 11b — a
  populated rc isolates nothing) → craigoley/remudero#99 · $3.797 · 62 turns

### RETRO-1784155126258 (2026-07-15) — the security tier + the dep lane + the first integrity fix

- **W1-T62** — PR-attribution integrity: anchored PR_URL parse + run-ownership guard (the fix for the
  false-merged class below) → craigoley/remudero#93 · $4.107 · 75 turns
- **W1-T54b** — dependency-lane LIVE proofs against the real parked Dependabot PRs →
  **craigoley/remudero#91** · $2.951 · 18 turns
  · ★ **ATTRIBUTION CORRECTED — the ledger, and this retro's gather, both name #80 (Dependabot's PR).
  That is FALSE.** #91 is this run's actual output. Cited per W1-T62's standing instruction; mechanism
  and residue in NET STATE + P9.
- **W1-T54** — dep-review lane: minor/patch arms auto-merge, MAJOR escalates (§5D lane 1; where major
  exclusion lives in CODE, not Dependabot ignore-rules) → craigoley/remudero#87 · gate-side merge
  (run ended blocked_review at $8.86/93 turns — the cycle's most expensive run)
- **W1-T24b** — ci-gate live proofs: a path-filtered ABSENT sub-job does not deadlock merge (#82); the
  flip-then-prove ordering corrected in `docs/review-gate.md` → craigoley/remudero#85 · gate-side merge
- **W1-T23** — §5 Tier-1 security stack on remudero: CodeQL (explicit workflow), OSV, Dependabot,
  leak-grep → craigoley/remudero#76 · gate-side merge (run ended blocked_review)
- **W1-T24** — ci-gate aggregator workflow — ONE always-runs required context; sub-jobs skip freely →
  craigoley/remudero#75 · gate-side merge (run ended blocked_review)

### RETRO-1784133446353 (2026-07-15) — the 17 merges that CLOSED WS-1

- **W1-T5** — mounts.yaml v0 + Tier Invariant validation → craigoley/remudero#42 · gate-side merge
  (run ended blocked_review; merged after a rule-16 Architect fix — #44 unblocked it)
- **W1-T8** — escalations as GitHub issues + imessage-local notifier + daily digest → craigoley/remudero#49
  · gate-side merge (run ended blocked_review; PR fixed with payload tests + merged)
- **SBX-T3** — unattended-drain drill, task 3/3 → craigoley/remudero-sandbox#8 · $1.13 · 8 turns
- **SBX-T2** — unattended-drain drill, task 2/3 → craigoley/remudero-sandbox#7 · $1.19 · 9 turns
- **SBX-T1** — unattended-drain drill, task 1/3 (the three SBX tasks ARE the WS-1 exit proof: drained
  by `rmd daemon` with no human in the loop) → craigoley/remudero-sandbox#6 · $1.13 · 9 turns
- **W1-T15** — plan-sync is an in-repo PR flow — never scp again (§13) →
  craigoley/remudero#66 · $1.81 · 22 turns
- **W1-T14** — `rmd` is a real installable CLI (package.json bin, publishable, no secrets in the
  tarball) → craigoley/remudero#65 · $2.18 · 41 turns
- **W1-T12c** — daemon crash-recovery logic (reconstruct state from git + GitHub + ledger, headless) →
  craigoley/remudero#63 · $3.21 · 53 turns
- **W1-T12b** — launchd unit generation + ANTHROPIC-clean boot assertion (headless) →
  craigoley/remudero#62 · $3.58 · 58 turns
- **W1-T12a** — daemon core: scheduler loop (DAG select → dispatch; honors Pause/Resume/STOP +
  headroom + locks) → craigoley/remudero#61 · $3.73 · 47 turns
- **W1-T11** — fleet control set: STOP / Pause (drain-and-hold) / Resume →
  craigoley/remudero#56 · $3.78 · 62 turns
- **W1-T9c** — `rmd init` wizard, no-TTY safe (--tier/--yes flags + TTY-absent default; the rule-18
  redesign) → craigoley/remudero#55 · $3.98 · 58 turns
- **W1-T9b** — tier detection, pure (/usage + ~/.claude.json keys → tier + evidence) →
  craigoley/remudero#54 · $2.83 · 45 turns
- **W1-T9a** — config loader + validation (schema + overflow/daily-cap rejection) →
  craigoley/remudero#53 · $1.92 · 31 turns
- **W1-T7** — transient-vs-strike classifier + diagnose-then-retry →
  craigoley/remudero#48 · $5.33 · 63 turns
- **W1-T6** — NDJSON ledger + context telemetry + brain-plane calls →
  craigoley/remudero#47 · $4.89 · 69 turns
- **W1-T4** — HeadroomTracker v0 — /usage parser → craigoley/remudero#39 · $1.92 · 28 turns

### Earlier

- **W1-T3F** — reviewer verifies acceptance criteria against REPO STATE, not diff+report alone (rule
  16 correction of the mis-specified W1-T3) → craigoley/remudero#35 · $2.31 · 21 turns
- **W1-T19** — Promptsmith injects LEARNINGS into worker prompts — the READ side of the compounding
  thesis (recon/reviewer/diagnose knowledge feeds forward) → craigoley/remudero#34 · $4.05 · 49 turns
- **W1-T3 arc (5/5, FOLDED)** — escalation issues + notifier + daily digest, decomposed by concern
  under rule 16; every criterion survived verbatim → craigoley/remudero#26 (T3, $2.99/37t), #27 (T3B,
  $2.90/31t), #28 (T3C, $2.64/42t), #29 (T3D, $1.77/21t), #30 (T3E, $3.73/31t) · arc total $14.03/162t
- **W1-T1D** — reviewer ENFORCEMENT wired into `run-task` (the merge gate, rule 3B; the call site is a
  deliverable, rule 14) → craigoley/remudero#12 · $1.28 · 21 turns
- **W1-T1C** — reviewer worker + rubric (fresh-context acceptance verdict) →
  craigoley/remudero#11 · $2.26 · 30 turns
- **CI-GREEN-PROBE** — CI-gate aggregator green-path probe → craigoley/remudero#5 · $0.44 · 0 turns
- **SB-HELLO** — proto-runner sandbox smoke task → craigoley/remudero-sandbox#2 · $0.41 · 0 turns
- **WS-0 spike** — 7/7 verdicts GREEN, loop closed unattended; ground truth in FIELD FINDING 10 →
  craigoley/remudero#1 · $0.86

## Calibration (observed — through RETRO-1784626054083, 2026-07-21)

The empirical baseline **mounts.yaml (W1-T5, shipped #42)** and Flight-control burn-rate signals (§4B
Layer 1, BUILT — W1-T20/#132) key off.

**★ CURRENT BASELINE — this cycle (RETRO-1784626054083, 27 runs). This is the row W1-T5's mount table
keys off. It is CLEAN (no spin loop) and entirely `implement`-typed:**

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | 27 | 8 | $10.650 | 86.63 | $287.544 |

**Prior cycles (FOLDED — trend only):** R9 26 runs / 13 ledger-merged (21 real) / $7.682 / 81.4t (plus the
only `diagnose` row ever recorded, n=1 — **still do not re-base a diagnose mount on it**) · R8 195 / 0
(28 real) / $1.258 / 14.7t — **churn-poisoned by the W1-T1 spin loop and never to be re-based on** ·
R7 29 / 14 / $5.794 / 72.2t · R6 2 / 1 / $4.673 / 64t · R5 9 / 4 / $3.613 / 56.9t · R4 10 / 2 (6 real) /
$3.290 / 54.5t · R3 22 / 15 / $3.218 / 45.2t · R1+R2 19 / 11 / $1.838 / 21.4t.
**Derived all-time:** ~339 runs, ~123 merged.

**Reads:**
- **Cost per run rose again — $7.682 → $10.650 — and this time it is NOT purely composition.** R9's rise
  was UI-shaped work; R10's top of the distribution is DEBUGGING work on a live system: W1-T185 $34.1,
  W1-T192 $23.8, W1-T177 $23.8, W1-T178 $18.1. Those four are 35% of the cycle's spend and all four are
  correctness-of-the-harness tasks, not features. **Re-base the mount table on $10.650, but read the
  driver as a WARNING**: two consecutive cycles of rising per-run cost is now a trend, not a blip, and the
  next retro must decide whether the harness's own defect surface is what we are paying for.
- **Cost per SHIPPED task is $12.50** ($287.544 / 23) — up from R9's ~$9.1. This is the number to compare
  cycle-over-cycle; it does not benefit from a clean cycle's smaller denominator the way merge rate does.
- **Merge rate 23/27 (85%) — a new high**, against R9's 81% and R7's 48%. Genuinely good, and genuinely
  less interesting than the credit number below.
- **★ LEDGER CREDIT REGRESSED: 13/26 (50%) → 8/27 (30%), with W1-T150 merged early in the window.** The
  headline `merged` column above reads **8**, not 23, for exactly this reason. Every consumer keyed on
  `verdict` — deriveStatus (dispatch!), this very table, `rmd trace`, the P25 readiness predicate — saw a
  false negative on 15 shipped tasks. **The calibration table's own `merged` column is now the loudest
  P30 symptom in the plan**, and P35 exists to find out why the merged fix did not fix it.
- **Block mix: `blocked_ci`×9, `blocked`×7, `incomplete`×3 — 15 of these 19 merged gate-side.** Third
  consecutive cycle in which the dominant "failure" classes are predominantly P30 write-side artifacts.
  P31's collapse into P30 (settled R9) holds; no class here is a real failure mode of its own.
- **Zero `blocked_isolation` and zero `blocked_containment` trips** — third consecutive quiet cycle. P27's
  toolchain-drift resolution is CONFIRMED HELD and this line will be deleted next retro rather than
  restated a fourth time; the cause-field task (W1-T91) remains queued and unaffected.
- **The $100 `budget_usd` tripwire: 0/27 trips.** But W1-T185 at $34.059 is the most expensive single run
  ever recorded — a third of the cap in one task. The tripwire is correct and the per-TASK circuit breaker
  (P29(ii)) is still unbuilt; nothing halted or needed to, but the headroom is thinner than it has been.
- **A retro must not average over a spin loop** — R8's lesson, kept because it is cheap to keep and
  expensive to relearn. **P29(iii)** (annotate credit-rejected runs before they reach the mount table) is
  still unbuilt; this cycle had exactly one credit-rejected run (W1-T156's sibling) to filter.

**Ratification telemetry (W1-T111/#373, the FIRST cycle this instrument has ever existed):**
**approved 1 · reframed 3 · approval rate 25%.** Read in P28's terms below — this is a NARROWING signal.

## Retro proposals (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)

**RETRO-1784626054083 (this cycle)** — mined from 27 runs / 23 shipped tasks / 8 ledger credits
(`blocked_ci`×9, `blocked`×7, `incomplete`×3, plus ONE rejected sibling trailer). Candidates for the
Architect to ratify via a tasks.yaml PR (rule 15) — never auto-filed.

- **★ P35 (measurement + golden; THE TOP ITEM) — A RATIFIED, BUILT, MERGED FIX DID NOT MOVE ITS OWN
  METRIC, AND NOTHING IN THE HARNESS NOTICED.** GROUND TRUTH (this cycle, mechanical): W1-T150 — P30's
  level-triggered credit backfill — merged as **#358, the lowest PR number in this cycle**. Of the 22
  tasks that shipped after it, **15 were gate-side merges the gather union had to rescue**, and ledger
  credit rate FELL 50% → 30%. DIAGNOSIS, stated as competing hypotheses so the task is decidable rather
  than exploratory: **(a) the rung never runs** — `rmd sweep` is daemon-driven and the daemon drains the
  SANDBOX, while the `remudero` queue is operator-kicked, so the backfill may have no scheduler on the
  repo that needs it; **(b) the rung runs and does not match** — its ownership rule reuses P29(i), which
  is UNBUILT (W1-T149), so a sibling-run PR still fails the assert; **(c) it runs, matches, and writes
  after the gather's read window.** These are cheaply distinguishable from the ledger. PROPOSE: **(i) a
  LIVE PROOF, not a fixture** — a task whose PR merged gate-side is shown, in the ledger, gaining exactly
  one `verdict.merged` correction on `remudero` (the fixture golden already passed and told us nothing);
  **(ii) EXECUTION TELEMETRY for reconciler rungs** — every sweep rung appends a line naming rung, repo,
  candidates-considered, corrections-written, even when zero, so "did it run" is never again an inference
  from a downstream metric; **(iii) A RETRO-LEVEL EFFICACY CHECK** — when a retro credits a task whose
  stated purpose was to move a metric this gather measures, the NEXT retro asserts the metric moved and
  flags it if not. THE GENERAL LESSON, which is the reason this is P-numbered rather than a bug report:
  **shipping is not fixing. The plan's own SHIPPED log is evidence of MERGE, not of EFFECT, and rule 13
  ("the proof is a merged PR") is exactly right about provenance and silent about efficacy.** DEPENDENCY:
  (i) may be blocked by W1-T149 under hypothesis (b) — sequence P35's diagnosis FIRST, since it is cheap
  and it tells us whether W1-T149 is the actual blocker.
- **★ P28 — TRIGGER FIRED, AND THE EVIDENCE SAYS *DO NOT WIDEN*.** P28's stated trigger was
  *"ratifies after W1-T110/W1-T111 ship AND the first approval-rate telemetry exists."* Both conditions
  are now MET (#368, #373). The first telemetry: **approved 1, reframed 3 — a 25% approval rate.** P28's
  own graduation rule reads on this directly: it widens the envelope for a class approved at ≥N% over ≥M
  items, and treats a reframe as a NARROWING signal. Three reframes against one approval, on n=4, is not
  an envelope-widening dataset; it is the opposite, and it is also too small to act on in either
  direction. RESOLUTION PROPOSED: **P28 stays HELD, with its trigger recorded as FIRED and its first
  reading recorded as NEGATIVE.** The instrument works — that is the win from W1-T111 — and the honest
  next step is to keep gathering rather than to ratify auto-ratification on n=4. RE-CHECK NEXT RETRO with
  the cumulative rate. NOTE the shape: this is the first time a HELD proposal's own trigger fired and the
  data argued against the proposal. That is the mechanism working exactly as designed, and it is worth one
  sentence in §Self-improvement's ledger of times gating-on-evidence paid.
- **P29 — RE-CONFIRMED, NOT RE-MINED; W1-T149 IS STILL UNBUILT AFTER TWO CYCLES.** New live instance this
  cycle: run `W1-T156-1784574954974` was credit-REJECTED because #398's head branch is
  `run-W1-T156-1784579460422` — **a later sibling run of the same task**, which is precisely the case
  P29(i)'s task-owned-branch rule credits. The cost was bounded this time (one redispatch, not 130),
  because the sibling merged quickly. An unbuilt ratification surviving a THIRD retro is the plan-health
  flag §Self-improvement names, and it may also be P35's hypothesis (b).
- **The COST TREND — NO proposal yet, but a NAMED RE-CHECK.** $5.794 → $7.682 → $10.650 over three cycles.
  R9's explanation (UI-shaped composition) does not cover R10, whose expensive tail is harness-debugging
  work (W1-T185/T192/T177/T178 = 35% of spend). Two data points make a line, three make a trend, but the
  DRIVERS differ, so mining now would fit a curve to two different causes. RE-CHECK NEXT RETRO: if per-run
  cost holds ≥$10 with a THIRD distinct driver, the finding is about task sizing (§5C lint-plan) and not
  about composition at all.
- **`blocked_ci`×9 + `blocked`×7 + `incomplete`×3 — NO new proposal; 15 of 19 merged gate-side ⇒ P30/P35.**
  Third consecutive cycle where the block classes are dominated by write-side credit artifacts. W1-T52's
  shipped triage (#308) owns the genuine remainder. Re-mining these as classes would manufacture proposals
  from one root cause — the accretion failure mode P8 named.
- **`blocked_isolation` / `blocked_containment` — ZERO for a third cycle; the two-cycle confirmation is
  now a three-cycle one and the Calibration line saying so is scheduled for deletion next retro.** No
  proposal. P27 resolved; W1-T91 remains the queued cause-field task.

**RETRO-1784556575522 (R9, prior cycle)** — mined from 26 runs / 21 shipped tasks / 13 ledger credits
(`blocked_ci`×8, `blocked`×3, `incomplete`×1, `no_pr`×1, plus ONE rejected foreign trailer). Candidates for
the Architect to ratify via a tasks.yaml PR (rule 15) — never auto-filed.

- **★ P33 (plan + golden; THE NEW ITEM) — A STALE FOREIGN TRAILER PERMANENTLY POISONS A TASK, AND
  SIBLING-CREDIT CANNOT FIX IT.** GROUND TRUTH (this cycle, mechanical): run `W1-T64-1784542590738` was
  REJECTED at credit time — *"GitHub trailer names #115 but its head branch (`fix/w1t64-both-tests`) is not
  this run's own branch (`run-W1-T64-1784542590738`)"*. The assert is CORRECT and must not be loosened.
  But note what this is NOT: there is **no sibling run** whose branch matches `run-W1-T64-*`, so **P29(i)
  will not credit it either**. #115 is a long-merged, hand-authored PR carrying a `Remudero-Task: W1-T64`
  trailer it was never entitled to — the same residue class as P9's #80, which still carries a false
  `W1-T54b` trailer. The consequence is worse than a one-off: `deriveStatus` will report W1-T64 uncredited
  FOREVER, `nextRunnable` will re-select it every drain, and the ONLY thing that will ever stop it is
  P29(ii)'s per-task circuit breaker — which halts the loop but never RESOLVES the task. DIAGNOSIS: the
  ownership-assert produces exactly three outcomes today (credit / reject-and-retry / reject-and-retry), and
  the second reject is terminal-but-unrecognized. PROPOSE: **(i) A TERMINAL-REJECTION CLASS** — when a
  task's ONLY trailered PR is merged AND its head branch matches no run of that task, the rejection is
  recorded as `credit.unresolvable` (not a transient failure), the task is HALTED, and ONE `needs-human`
  escalation names the offending PR and asks the single decidable question: *"is #115 this task's work —
  credit it by operator correction, or is the trailer stale — quarantine it?"* **(ii) A TRAILER QUARANTINE
  LIST** (policy-as-data, rule 2) — an operator-ratified list of `(pr, task)` pairs whose trailers are
  DISAVOWED; the credit path ignores them entirely, so a corrupt trailer on an immutable merged PR stops
  poisoning derivation without anyone rewriting git history. This is P9's own unfinished half stated as
  mechanism: *a fix that repairs the mechanism but not the corrupt data it already emitted is half a fix.*
  **(iii)** the quarantine list SUBSUMES the #80/W1-T54b residue NET STATE has carried as a footnote for
  four retros — file both entries at ratification and delete the footnote. GOLDEN (fixture-only, no live
  dep): a seeded task whose only trailered merged PR is foreign-branched HALTS with exactly one escalation
  and zero further dispatches; the same task with that pair QUARANTINED derives cleanly and dispatches
  normally; a quarantined pair NEVER suppresses credit for a legitimately-owned PR on the same task.
  DEPENDENCY: ratify AFTER or WITH W1-T149 — P29(ii)'s breaker is the backstop that makes (i) safe.
- **★ P31 — RESOLVED IN R9; COLLAPSED INTO P30; PROSE DELETED per RATIFY-OR-KILL.** R8 raised
  `blocked_ci`×21 as investigate-first and named the decisive test: *"19 of the 21 merged anyway — if that
  holds, P31 COLLAPSES INTO P30 and must not be built separately."* It held. This cycle: `blocked_ci`×8,
  **6 of 8 merged gate-side** (W1-T52/T55/T56/T59/T61/T138). Two consecutive cycles agree that blocked_ci
  is predominantly a run-verdict artifact — the run ended at ci-red, CI later went green, nothing revisited
  — which is P30's write-side gap, not a CI-failure class. **No separate task. W1-T150 is the fix.** The
  ~12 lines of investigation scaffolding P31 carried are deleted; gating on evidence worked, and the
  evidence arrived, so the scaffolding has no further job.
- **`blocked`×3 + `incomplete`×1 + `no_pr`×1 — NO new proposal.** 2 of the 3 `blocked` runs merged
  gate-side (W1-T45/#303, W3-T8/#305) ⇒ P30 again. The remaining three are the generic remainder the OPEN
  W1-T52 triage already owns — and W1-T52 SHIPPED this cycle (#308), so the next retro reads its output
  rather than re-mining the classes. Manufacturing proposals from a root cause that already has a task is
  the accretion failure mode P8 named.
- **The R9 cost-rise re-check line is DELETED — R10 answered it** (the average did NOT return to the old
  band; the live item is the three-cycle trend in the R10 block above, and keeping both is the duplication
  HARNESS-COMPRESSION forbids).

**RETRO-1784512714705 (prior cycle)** — mined from 195 runs / 28 gate-side merges / 0 ledger credits
(`incomplete`×111, `no_pr`×42, `blocked_ci`×21, `pr_attribution_failed`×12, `blocked`×5,
`blocked_containment`×2, `blocked_isolation`×2). Candidates for the Architect to ratify via a tasks.yaml PR
(rule 15) — never auto-filed.

- **★ P29 (plan + golden; THE TOP ITEM) — RATIFIED 2026-07-20 -> W1-T149 (sibling-run credit liveness + per-task dispatch circuit breaker; ownership-assert preserved). THE INTEGRITY GUARD HAS NO LIVENESS COUNTERPART, SO AN OWNED
  MERGE CAN SPIN THE QUEUE FOREVER. ~130 runs / ~$130 / ~10 hours on ONE task.** GROUND TRUTH (this
  cycle, mechanical): W1-T1 was dispatched ~130 times (run ids …445260109 → …483071029). Its PR **#255
  MERGED** at run …460723173. Every OTHER run was rejected at credit time — *"GitHub trailer names #255
  but its head branch ("run-W1-T1-1784460723173") is not this run's own branch"* — **and dispatch continued
  for five hours AFTER the merge.** Same shape: W1-T29 ×10, W1-T27/T47/T98/T1 ×1 each. DIAGNOSIS, stated
  precisely so it is not mistaken for an attribution bug: **the ownership-assert is CORRECT and must not be
  loosened.** P9/W1-T51/W1-T69 built it to stop the R5 false-credit inversion, and it stopped exactly what
  it was built to stop. The hole is that **no rung credits a task when a SIBLING RUN OF THE SAME TASK
  merged the work** — so `deriveStatus` reports W1-T1 un-credited, `nextRunnable` re-selects it, and
  W1-T80's dedup (an OPEN PR ⇒ in-flight) cannot fire because #255 is **MERGED**, not open. Every guard
  behaved as designed; the composition spins. PROPOSE: **(i) SIBLING CREDIT, ownership-preserving** — a
  task is CREDITED when a merged PR carries its `Remudero-Task` trailer AND that PR's head branch matches
  `run-<taskid>-*` for ANY run of that task, with the crediting run named in the ledger line. The assert
  moves from *"this run's branch"* to *"a branch this TASK owns"* — strictly narrower than trusting the
  trailer (a foreign PR still fails), strictly wider than today (a sibling still credits). **(ii) A
  PER-TASK DISPATCH CIRCUIT BREAKER (rule 2, policy-as-data)** — N dispatches of the same task with no NEW
  owned PR ⇒ HALT the task, escalate ONE `needs-human` naming the loop, dispatch nothing further. §9's
  tripwire is per-WORKER and saw nothing; this is its per-TASK dual, and it is the backstop that makes (i)
  safe to get wrong. **(iii) CHURN-AWARE CALIBRATION** — the retro gather annotates runs rejected at credit
  time so a spin loop cannot silently deflate the mount table (this cycle's $1.258/14.7t headline). GOLDEN
  (fixture-only, no live dep): a seeded task with a merged sibling-run PR is CREDITED exactly once and
  dispatches NOTHING further; a seeded task with a merged FOREIGN-branch PR carrying its trailer is NOT
  credited and DOES escalate; a seeded task at N+1 dispatches with no owned PR halts with exactly one
  escalation and zero further dispatches. NOTE the shape for the record: **this is the R5 inversion's
  mirror.** R5 was a false OVER-claim (credit for work not done); R8 is a systematic UNDER-claim the daemon
  then ACTS on — and acting on it is what made it expensive. The general lesson: **a fail-closed integrity
  guard needs a liveness counterpart, or the system pays for its own correctness forever.**
- **★ P30 — RATIFIED 2026-07-20 -> W1-T150, which SHIPPED 2026-07-21 (#358: the `rmd sweep` reconciler
  gains a level-triggered rung appending a `verdict.merged` correction for any task whose owned PR merged
  but is uncredited). Full prose DELETED per RATIFY-OR-KILL — the task and its PR are the record.** TWO
  things survive it. (a) The HISTORY that made the argument, kept as one line because each retro re-reads
  it: ledger-vs-GitHub ran R3 15-vs-17, R4 2-vs-6, R5 4-vs-4 (P11 closed on the GATHER, not the write
  side), R7 14-vs-14, R8 0-vs-28, R9 13-vs-21, **R10 8-vs-23**. (b) The open question the shipping did NOT
  close: **the metric did not move after #358 merged** — carried forward as P35 in the R10 block above,
  which is now P30's live descendant.
- **P31 — RESOLVED 2026-07-20; see the R9 block above. Prose DELETED per RATIFY-OR-KILL.**
- **`incomplete`×111 + `no_pr`×42 + `pr_attribution_failed`×12 — NO new proposal; STORM RESIDUE, folded
  into P29.** These three classes account for 165 of 195 runs and their timestamps track the W1-T1/W1-T29
  redispatch cadence (~75–90s apart). They are not 165 independent failures; they are one defect counted
  165 times. Re-mining them as classes would manufacture proposals out of a single root cause — the
  accretion failure mode P8 named. INVESTIGATE only the residue that survives after P29 lands.
- **`blocked_containment`×2 + `blocked_isolation`×2 — NO new proposal; P27's resolution HELD.** Down from
  R7's ×5/×1 after #185 absorbed the Claude Code 2.1.214 pkill-wrapper drift. Two trips is the designed
  fail-close at background rate. The cause-field remains ratified as W1-T91 (queued); nothing new here.
- **`blocked`×5 — NO new proposal; owned by W1-T52, which SHIPPED this cycle (#308).** 4 of the 5 merged
  gate-side (W1-T102, W1-T108, W1-T115, W2-T3) ⇒ mostly P30 again. R9 note: W1-T52's triage output is now
  a READABLE artifact, so the next retro reads it instead of re-mining this class — and the near-identical
  `no_pr`×2/`failed`×1/`incomplete`×1 fold-line that sat in the R5 block below is DELETED as the duplicate
  it became the moment both pointed at one shipped task.

**RETRO-1784383376396 (R7) — proposal block DELETED this cycle; every item reached a terminal status.**
**P27** RESOLVED 2026-07-18 (the `blocked_isolation`×5 volume was ONE cause — a Claude Code 2.1.214
auto-update adding a pkill wrapper the static allowlist predated, named by #184's probe and absorbed by
#185; the proposed host-hygiene fix was REFUTED by the name, the guard fail-closed correctly on toolchain
drift). **R8 and now R9 both confirm the resolution held** — this cycle recorded ZERO isolation and ZERO
containment trips, so the two-cycle confirmation is complete and needs no third restatement. Cause-field
remains ratified as P23→W1-T91. R7's remaining classes resolved NO-new-proposal at the time; its blocked_ci
caveat became P31, which RESOLVED into P30 this cycle. Nothing here is live.

**RETRO-1784213948025 / RETRO-1784206755808 (prior cycles) — proposal blocks DELETED.** Both resolved
entirely into ratified tasks or NO-new-proposal bootstrap findings whose reasoning now lives in the task:
**P23**→W1-T91 (queued; investigation confirmed guard-fired-correctly) · the `blocked_review`×1 and ×3
lines→P15/W1-T65 (SHIPPED #122). Restating settled adjudications is the graveyard P8 warned about.

**RETRO-1784155126258** — mined from the 8 non-merges of 10 runs (`blocked_review`×4,
`no_pr`×2, `failed`×1, `incomplete`×1). Candidate golden/plan tasks for the Architect to ratify via a
tasks.yaml PR — never auto-filed, never worker-edited (rule 15).

- **P9 — RATIFIED 2026-07-16 -> W1-T75 (SHIPPED #138: operator corrections are SUPREME in deriveStatus,
  hoisted above rung (a), with an `rmd correct` writer). Prose DELETED per RATIFY-OR-KILL; the residue is
  recorded once in NET STATE (PR #80 still carries a false `Remudero-Task: W1-T54b` trailer).** TWO durable
  lessons kept, both load-bearing for R8: (a) **a fix that repairs the mechanism but not the CORRUPT DATA IT
  ALREADY EMITTED is half a fix — and the plan is downstream of that data**; (b) **`correction.provenance`
  is a first-class ledger EVENT, not a note — every consumer reads corrections, or the append-only ledger's
  integrity is only as good as its least-aware reader.** P30 is (b) unfinished: the merge EVENT itself has
  no correction path, so 28 true merges never reached the consumers that gate dispatch.
- *(learning-system completeness review — Architect + research 2026-07-15)* ★ P12 (plan + measurement) — RATIFIED 2026-07-17 -> W1-T86 (the wipe-test learning-utility A/B harness — injected learnings must be shown to help, or pruned). ORIGINAL: WE INJECT LEARNINGS BUT NEVER MEASURE WHETHER THEY HELP: the learning system has no effectiveness signal, so it cannot be shown to compound. W1-T19 injects matched learnings; W1-T34 (proposed) prunes STALE ones; W1-T38 (proposed) caps SIZE. NONE tracks UTILITY — whether an injected learning is load-bearing. The 2026 memory literature names the metric: the WIPE TEST [research: self-evolving-agents-2026] — what performance survives if external memory is deleted; a memory-centric system (Remudero, deliberately — no weight updates) must PROVE its gains, or 'better notes' is unfalsifiable. Measured directly as RELIABILITY (success rate over repeats) + EFFICIENCY (turns/cost) [research: procedural-memory-reliability]. For Remudero: (i) ledger, per injected learning, whether the run it fed MERGED clean vs needed fix/diagnose — a learning accrues a utility signal; (ii) periodically run a task-CLASS with learnings SUPPRESSED (a Wipe-Test golden on the sandbox) and compare merge-rate/turns to the injected baseline; (iii) feed utility INTO W1-T34 quarantine + W1-T38 budget — prune LOW-utility as hard as STALE, so the corpus is pruned by VALUE, not only truth and size. This is the metric the whole Self-improvement section exists to make true and currently asserts without evidence.
- *(learning-system completeness review — Architect + research 2026-07-15)* ★ P13 (plan) — RATIFIED 2026-07-17 -> W1-T87 (Retro mines SUCCESS — procedural learnings from merged runs, the missing half of the flywheel). ORIGINAL: THE FLYWHEEL MINES FAILURE, NOT SUCCESS: half the compounding loop is missing. Self-improvement's flywheel reads the ledger for FAILURE patterns (repeated transients, prompts that needed fixes, gates that never fire, reviewer misses). The 2026 frontier distills BOTH: successful trajectories -> reusable procedures, failed -> corrective lessons [research: reasoningbank, expel, agentic-workflow-memory, trajectory-informed-memory]. Remudero captures a clean single-shot merge NOWHERE — the prompt shape that produced W1-T3F at 21 turns, or a 4-turn recon, is never distilled into procedural memory (the Sec 5B skill registry / a template diff). Propose: extend the flywheel + retro to mine SUCCESSFUL runs — a run that merged clean, fast, first-try is a POSITIVE signal whose reusable shape becomes a procedural-memory proposal (skill-registry entry or template diff), gated behind the golden suite like any knowledge change (RSI-safety unchanged). 'Compounding engineering' completed: codify what WORKS, not only patch what breaks.
- *(learning-system completeness review — Architect + research 2026-07-15)* P14 (plan -> extends W1-T33) — RATIFIED 2026-07-17 -> W1-T88 (consolidation contradiction detection — contested pairs surface for resolution, never silent recency-overwrite). ORIGINAL: CONSOLIDATION HAS NO CONTRADICTION DETECTION; supersession is recency-overwrite. W1-T33 (proposed) adds a lifecycle (active|superseded) and filters superseded entries, but marking-superseded is MANUAL and nothing DETECTS when a newly-distilled learning CONTRADICTS an existing one. The 2026 consolidation literature makes conflict detection explicit — multi-pass consolidation with conflict resolution [research: trace2skill, scientific-agent-consolidation] — and names naive recency-overwrite's failure: it breaks when knowledge is REFINED, not replaced. Propose (fold into W1-T33's ratification): the DISTILL/retro consolidation pass, before adding a learning, checks it against existing entries on the same subsystem/files for CONTRADICTION and forces an explicit supersede-or-reconcile decision — a contradiction may never SILENTLY coexist with the entry it contradicts (both would inject; a worker would receive mutually-exclusive guidance).
- **P16 — RATIFIED 2026-07-16 -> W1-T69** (deriveStatus rung (c): anchored-trailer verify +
  ownership-assert + correction-awareness). Prose DELETED per RATIFY-OR-KILL. NOTE for P29: W1-T69 is the
  guard whose correctness is NOT in question — it is the missing sibling-credit counterpart that spins.
- ★ P17 (plan -> design + build) — RATIFIED 2026-07-16 -> W1-T71 (rmd receipt <pr>: deterministic in-toto-style attestation from ledger ground truth + the byte-equal drift golden; Sigstore + WS-12 schema publish deferred to v2). THE LEDGER PROVES OUR RUNS TO US; NOTHING PROVES THEM TO ANYONE ELSE. Remudero already writes every field a provenance attestation needs — append-only ledger, ownership-asserted Remudero-Task trailers (W1-T62), correction.provenance lineage (P9) — but emits no standardized artifact a THIRD PARTY can verify. The 2026 context makes this the open lane: EU AI Act Art. 50 machine-readable-disclosure enforcement begins 2026-08 and SOC2/vendor due-diligence now asks about AI-authored code [research: eu-ai-act-art50-2026]; SLSA's source track + in-toto attestations are the established supply-chain vocabulary [research: slsa-source-track, in-toto]; NIST's agent-identity concept work names the requirements — tamper-proof logs, binding to human intent, non-repudiation [research: nist-agent-identity-2026]; and the VS Code co-author-trailer backlash (reverted 2026-05) set the design bar: provenance must be EXPLICIT and VERIFIABLE, never a silent default [research: vscode-coauthor-backlash-2026]. Nearest competitor ships "inspectable run receipts" (MartinLoop) — inspectable, not standardized, not verifiable [research: field-survey-2026-07-16]. Propose: (i) `rmd receipt <pr>` — a DETERMINISTIC generator assembling an in-toto-style attestation predicate from ledger ground truth: task id, run id, head branch, prompt-template hash, injected learning ids, mount (model/effort), num_turns, notional cost, reviewer_outcome, gate contexts at merge, correction lineage; (ii) posted as a PR comment + committed artifact on every merged agent PR; (iii) the predicate SCHEMA published as a Tier-A generated doc (WS-12) — the interop play: a format others can adopt; (iv) Sigstore keyless signing is the v2 rung, DEFERRED until the format proves out (rule: never ship the crypto before the content is right); (v) GOLDEN: a receipt regenerated from the ledger byte-equals the posted artifact (the W1-T49 drift-gate discipline applied to receipts). This makes WS-12's "nobody else ships the receipts" claim LITERAL and machine-verifiable — the differentiator the commodity field cannot follow without our ledger/trailer/correction substrate.
- ★ P18 (plan + measurement) — RATIFIED 2026-07-17 (core) -> W1-T89 — the WS-12 publish rung ratifies with the site. ORIGINAL: OUR FAILURE CLASSES ARE PRIVATE VOCABULARY; THE FIELD PUBLISHED A TAXONOMY AND NOBODY'S LIVE SYSTEM IS CODED TO IT. MAST (NeurIPS 2025; 1,600+ annotated traces across 7 frameworks, kappa 0.88) names 14 failure modes in 3 categories — specification (~42%), inter-agent misalignment (~37%), verification (~21%) [research: mast-neurips2025]; the companion finding quantifies our §4 bet: uncoordinated MAS amplify errors up to 17x while centralized-with-validation-bottleneck architectures contain amplification to ~4.4x [research: mas-error-amplification-2026]. Remudero's ledger is ALREADY a MAST-annotatable trace corpus — verdict classes map cleanly (blocked_illformed -> specification; the W1-T62/#80 attribution inversion + dead-reviewer floor-only pass -> verification; the rider-shedding class -> specification/decomposition). Propose: (i) a DETERMINISTIC verdict->MAST mapping held as DATA (a YAML table, rule 2 — never LLM-classified), applied at retro-read so historical ledger lines code retroactively; (ii) `rmd retro` reports each cycle's failure distribution BY MAST CATEGORY — class-level mining (W1-T20d) gains the field's shared vocabulary, and a category trending wrong is a plan-health signal; (iii) WS-12 publishes ledger-derived reliability numbers as a GENERATED site artifact — merge rate, cost/turns per merged PR, failure mix by MAST category, and the P12 wipe-test deltas on the same surface — extending "LEARNINGS.md as a public artifact" from narrative to NUMBERS. Positioning: the first orchestrator whose live operational failure data is coded to the published research taxonomy and shipped in the open. GOLDEN: a seeded ledger fixture of known verdicts produces the expected category distribution (the mapping is tested, not vibes).
- P19 (plan -> WS-2 addendum) — RATIFIED 2026-07-20 -> W1-T170/W1-T171/W1-T172 (per-run isolated worker HOMES · the deterministic file-overlap pre-dispatch check, rung 1 · N parallel dispatch lanes bounded by the queue-governor WIP limit, N=2). TRIGGER FIRED: both prerequisites built — W1-T121 (#385, queue governor) and W1-T122 (#386, plan sharding). Rung 2 (Tree-sitter symbol-touch locks) stays BANKED until a rung-1 escape is observed in the ledger; W1-T172's `dispatch.concurrent_set` line is what makes that trigger answerable. HONESTY BOUND CARRIED: files: is advisory metadata a worker can exceed — the check reduces collision probability and is never a guarantee.
- P20 (plan -> §5D lane-2 ACT rung) — RATIFIED 2026-07-17 -> W1-T90 (the alert-fix lane — policy-gated autofix rung for §5D lane 2, applying the shipped dep-lane precedent to scanners). ORIGINAL: THE ALERT LOOP REVIEWS AND TRIAGES BUT NEVER FIXES WITHOUT A HUMAN PER ALERT. §5D lane 2 (W1-T55 surface -> W1-T56 triage) ends at "rmd triage PROPOSES a corrective task"; every proposal then waits on Architect ratification (rule 15), so "scanner findings get fixed on the regular" keeps a human in the seat for EVERY alert, including trivial ones. GROUND TRUTH (2026-07-16, operator-reported): the §5 scanners have been live since #76 and open code-scanning findings sit unfixed on the repo — the operating loop is specified (§5D) but unbuilt (W1-T41/T55/T56 all queued), and even built it would not CLOSE most alerts unattended. PRECEDENT: the dep lane (W1-T54, SHIPPED) already established the pattern this proposal extends — a DETERMINISTIC policy decides act-vs-escalate (minors auto-merge, majors escalate) with no per-item plan task and no per-item ratification. Propose the same split for lane 2: an ALERT-FIX LANE where policy-as-data over (severity x path-class x tool) decides — severity<=medium AND path outside a gate/containment-critical set (the policy file names it; review/gate/containment/ledger paths are IN it) -> DISPATCH one ephemeral lane-owned fix run through the FULL [ci, remudero-review] gate with origin: alert#<id> provenance and the standard trailer/ownership discipline; critical/high OR gate-cutting path -> escalate needs-human (exactly W1-T55's rung). RULE-15 RESOLUTION, explicit: the lane NEVER writes tasks.yaml — like dep-review it owns its run shape; the plan stays human-authored. Rule 2 holds: act-vs-escalate is a deterministic predicate, never an LLM call. GOLDEN (fixture-only): a seeded medium alert on a non-critical path dispatches exactly ONE lane run; a seeded critical, and a seeded medium touching src/lib/review.ts, each escalate and dispatch NOTHING; a re-poll of the same alerts dispatches no duplicate. OOTB: the lane + its policy file ship in the WS-4 scaffold so a fresh install fixes its own scanner findings from day one — "the harness eats first" (§5A) extended to the harness's own security debt.
- **P21 — SHIPPED & RETIRED this cycle (RETRO-1784383376396).** Superseded-by-P22 and absorbed into
  W1-T76 (the blocked_review fix rung), which MERGED #158 with P21's anti-ping-pong invariant + golden
  verbatim. Full prose DELETED per RATIFY-OR-KILL (the task is the record now; restating a shipped proposal
  is the graveyard P8 warned about). Id preserved; see the closed-proposals line.
- **P22 — RATIFIED 2026-07-16 -> W1-T76/W1-T77/W1-T78; the WHOLE FAMILY HAS SINCE SHIPPED (#158 fix rung,
  #168 clarification rung, #165/#166/#167 sweep dispositions + taxonomy + `rmd fix`). Full prose DELETED per
  RATIFY-OR-KILL — the tasks are the record. ONE durable doctrine kept, because R8 shows it generalizes:
  **LEVEL-TRIGGERED RECONCILIATION** [research: prow-tide-2017, level-triggered-reconciliation] — every sync
  RE-DERIVES disposition from OBSERVED state, so a missed edge never strands work, and a second pass over
  unchanged state does nothing (IDEMPOTENCE). P22 applied it to open PRs; **P30 applies the identical
  argument to CREDIT**, which is still edge-triggered at run-end and was wrong 28/28 this cycle.
- ★ P24 (plan -> new flow family; operator-requested by name) — RATIFIED 2026-07-17 -> W1-T82/W1-T83/W1-T84/W1-T85 (the four-phase `rmd onboard` family: deterministic inventory · recon+plan-artifact mining · the planning session · synthesis to ONE ratifiable draft PR). ORIGINAL: BROWNFIELD ONBOARDING: `rmd onboard` TURNS AN EXISTING REPO INTO A STEWARDED PLAN THROUGH RECON + A PLANNING SESSION WITH THE HUMAN. The 2026 SDD field's named weakness is exactly this seam: spec tools are strongest greenfield, and the field's own brownfield guidance is an agent-interview constitution exercise done BY HAND [research: sdd-brownfield-gap-2026, sdd-constitution-interview-2026]; every major tool (Spec Kit 93k+ stars, Kiro, Claude Code SDD skills, Cursor Plan Mode + AGENTS.md) outputs STATIC spec markdown a human then shepherds — the field's own differentiation axis is static documents vs OPERATIONAL INFRASTRUCTURE [research: sdd-field-survey-2026]. Remudero's plan is already operational (daemon-drained, gate-bound, ledgered, receipted); onboarding is where that difference becomes the front door. PROPOSE the flow, composing EXISTING machinery end-to-end:
  (1) DETERMINISTIC INVENTORY (rule 2, no LLM): languages, build/test/CI systems, protection state, docs presence (README/CONTRIBUTING/AGENTS.md/CLAUDE.md/ADRs/ROADMAP/TODO), issue/milestone counts, coverage/test signals — policy-as-data detectors emitting an inventory artifact.
  (2) RECON UNDERSTANDING: read-only workers (containment-preflighted; REUSE the W2-T1 specialist spawn machinery — security/testing/design/containment lenses pointed at the WHOLE repo instead of a diff) produce an architecture-and-conventions map and MINE existing plan artifacts (ROADMAP, TODOs, open issues, ADR intents) into CANDIDATE goals, each carrying provenance to the file/issue it came from (origin: onboard#).
  (3) FINDINGS + QUESTIONS: a findings doc + a QUESTION set per the §2 contract — the gaps the scan could not resolve plus goal elicitation (what done looks like, priorities, risk appetite, no-touch zones, which criteria are verify:human) — NEVER generic "any thoughts?" prompts; every question names its decision (the W1-T78 clarification-rung discipline, pointed at day zero).
  (4) THE PLANNING SESSION: interactive answer loop (v1: CLI; the banked rmd chat/grill intake upgrades it later — this flow is that primitive's FIRST consumer). Every answer is LEDGERED (onboard.answered) — the drafted plan's decisions carry provenance to the human's own words.
  (5) SYNTHESIS: an Architect worker drafts the target repo's MASTER-PLAN.md (mission, conventions AS FOUND — the constitution the field says to write by hand, productized), tasks.yaml seeded CHANGE-LEVEL from the ratified goals (progressive adoption, never a big-bang respec [research: sdd-brownfield-gap-2026]), and optionally AGENTS.md (the field's cross-tool convention — emit it so OTHER agents respect the same constitution). HARD GATE: every generated task must pass `rmd lint-plan` (§5C applies to machine-drafted plans at birth — sizing/headless-fitness/proof-shape; a generator that cannot pass its own linter does not ship a plan).
  (6) RATIFICATION: the entire output lands as ONE draft PR to the TARGET repo; the human's review + merge IS the ratification (rule 15 — the machine never self-ratifies a plan; answers absent -> synthesis REFUSES rather than guessing goals). Then `rmd project init` (W1-T27) installs the gates and the daemon drains — onboard produces the BRAIN, project-init installs the BAR, the loop runs.
  GOLDEN (fixture-only): a seeded fixture repo (code + ROADMAP.md + issue fixtures) -> inventory matches expected JSON; every candidate task cites its mined source; generated tasks pass lint-plan; the flow writes NOTHING to the target outside the single draft-PR branch; an unanswered question set makes synthesis refuse.
  POSITIONING: the trust gap is the market (84% adoption, 33% trust [research: so-survey-2025-trust]) — competitors generate specs; Remudero generates a plan that a gated autonomous system then EXECUTES with receipts. Ratification shape: a task family (inventory -> recon+mining -> session -> synthesis+draft-PR), likely a new workstream or §5A extension; home decided at ratification.
- **P25 — RATIFIED 2026-07-18 -> W1-T110/W1-T111, and the WHOLE FAMILY HAS SINCE SHIPPED (#368 the rule-2
  readiness predicate + Architect-drafted candidates, #373 `rmd approve`/`rmd reframe` with approval-rate
  telemetry, #457 the draft rung moved daemon-side). P25 is CLOSED; full prose DELETED per RATIFY-OR-KILL
  — the tasks are the record.** ONE consequence kept because it is live: **W1-T111's telemetry is the
  instrument P28 named as its own graduation trigger**, and its first reading (1 approved / 3 reframed) is
  adjudicated in the R10 block above.
- P26 (plan -> §5D/§7 surface; operator-asked, research-grounded) — HELD 2026-07-20 (TRIGGER: ratify once W1-T105 ships — the follow-up harvest this two-way surface's inbound intake (b) depends on). GITHUB ISSUES AS A PROJECTION AND INTAKE SURFACE, NEVER THE PLAN BACKEND. The operator's question: should the plan someday live in GitHub Issues instead of tasks.yaml? The 2026 field says issues-as-agent-queue is the dominant pattern — GitHub's coding agent turns an assigned issue into an autonomous PR, assignable from web, Projects, Mobile, and CLI [research: copilot-coding-agent-2026]. DECISION RECORDED, with reasons, so it is not casually relitigated: the backend swap is REJECTED. Issues are schemaless prose with no birth gate — no lint-plan on creation, no atomic multi-task ratification (a stamp + N tasks is ONE commit in tasks.yaml, four unrelated mutations as issues), no declaration order for the drain, no diff-scope enforcement of rule 15, no offline-deterministic linting, weak edit history. The field tolerates this because its agents carry no plan discipline; Remudero's provable-trust moat IS the plan discipline. What issues ARE good for, PROPOSE as a two-way surface over the yaml source of truth:
  (a) OUTBOUND MIRROR: queued/blocked/escalated tasks optionally project to issues (title=id+title, body=rendered spec, labels=status/risk, closed on credit) — LEVEL-TRIGGERED sync from the plan+ledger, the mirror is disposable and rebuildable from scratch, and NEVER read back as authority; gives mobile visibility, comments, Projects boards, notifications for free. Escalations (W1-T8) already live here; this extends the pattern to the queue itself.
  (b) INBOUND INTAKE: W1-T57 (filed) already turns managed-repo issues into ledgered feedback artifacts; extend: issues labeled `candidate` flow through the W1-T105 follow-up harvest into PROPOSAL CANDIDATES for ratification — humans and outside collaborators file work in the interface they know, rule 15 converts it to plan through the gate.
  (c) COMPOSITIONS, named not built: the P25 ratification inbox could ride issue comments/reactions as its one-bit approve transport; a mirrored issue is assignable to third-party agents (the Copilot pattern) if ever wanted — optionality the mirror creates for free.
  GOLDEN (fixture-only): a seeded plan projects N issues with correct labels; a task credited in the ledger closes its mirror issue on the next sync; a hand-edited mirror issue body is OVERWRITTEN by the next sync (authority test — the mirror never wins); a `candidate` issue yields exactly one cited proposal candidate and never a task. Ratification shape: one mirror task + one intake-extension task, after W1-T57 and W1-T105 build.
- P28 (plan -> §7 evolution of P25; operator-requested) — HELD 2026-07-20 (TRIGGER: ratify after W1-T110/W1-T111 ship AND the first approval-rate telemetry exists — the same condition the TRIGGER line at the end of this block already states; restated here for the holds pass). GRADUATED AUTO-RATIFICATION: THE MACHINE RATIFIES WITHIN A HUMAN-RATIFIED POLICY ENVELOPE, AND THE ENVELOPE WIDENS ON EVIDENCE. The operator's requirement, near-verbatim: an auto-ratify process that takes the next priority items, researches to confirm, and kicks back questions ONLY on items that need human input. THE RULE-15 LINE, drawn explicitly: the machine NEVER ratifies on its own judgment — it ratifies within a POLICY the operator ratified once (the dep-lane/alert-lane precedent: W1-T54 merges and W1-T90 fixes per-item with no per-item human, because the human approved the policy; same doctrine, aimed at the plan layer). PROPOSE:
  (a) THE ENVELOPE (policy-as-data, rule 2, itself ratified through a plan PR): auto-ratifiable proposal classes defined by deterministic predicates — e.g. single-task, risk<=medium, evidence anchors grep-true, drafted set lint-plan-clean, deps merged, budget within bound, origin in an allowlisted class (linter-precision follow-ups, incident-machinery filings) — every threshold a data row.
  (b) THE FLOW: the P25 inbox (W1-T110/T111) computes READY as today; READY items INSIDE the envelope auto-ratify — the plan PR opens WITHOUT the bit, carrying the draft + stamp + an auto-ratified-by-policy provenance line, and STILL rides the full gate (ci + lint-plan + review; audit and revert first-class — autonomy of initiation, never of merge). READY items OUTSIDE the envelope surface exactly as P25 ships today: the bit, or a SPECIFIC question where the draft rung found ambiguity (the W1-T78 question discipline pointed at ratification).
  (c) GRADUATION BY EVIDENCE: W1-T111's ledgered approval-rate telemetry is the instrument — a proposal class the operator has approved at >=N% over >=M items is a WIDENING CANDIDATE the retro surfaces (a proposed envelope-row addition, itself ratified by the operator); a reframe inside the envelope is a NARROWING signal surfaced the same way. The envelope earns width, never assumes it [research: hitl-approval-fatigue-2026 — policy-level enforcement is what scales past reviewer attention; approval rates near 100% mean the bit is ceremony for that class].
  (d) THE BRAKE: rmd pause-autoratify (one verb, no argument) suspends the envelope entirely, everything falls back to the bit; every auto-ratification is a ledger line naming the policy row that admitted it.
  GOLDEN (fixture-only): a seeded READY set {inside-envelope, outside-envelope, envelope-but-reframed-history} -> exactly one auto-opened plan PR with policy provenance, one bit-request, one question; the telemetry fixture at 95%/20-items surfaces a widening candidate as a PROPOSAL, never a silent envelope edit; pause-autoratify makes the inside-envelope item fall back to the bit.
  TRIGGER: ratifies after W1-T110/W1-T111 ship AND the first approval-rate telemetry exists — auto-approve before the approve data would be the dead-consumer class. Until then the inbox IS the process, and its telemetry is this proposal's evidence being gathered.
- **★ P32 — LAYERED KNOWLEDGE (three layers, bottom-up promotion, global as a hash-pinned artifact).
  RATIFIED 2026-07-20 -> W1-T145/W1-T146, and BOTH SHIPPED 2026-07-21 (#360 the ONE entry schema valid at
  every layer + the project / user-overall / rmd-global homes; #371 promotion = SCRUB (leak-grep + PII)
  THEN JUDGE (applicability eval), with the per-layer budget ratchet). The design prose is DELETED per
  RATIFY-OR-KILL — the two merged tasks are the record.** WHAT REMAINS OPEN, stated once: the **GLOBAL
  TRANSPORT** is still banked to §6 packaging and inherits Tier 3's stateless shape (DECISIONS.md
  distribution-architecture: opt-in POST up, pull of a hash-pinned artifact down, no persistent
  connection). Layers (i) and (ii) are usable today; layer (iii) has a schema and a gate but no wire.
- **★ P34 (plan -> §7/§9; operator-requested; captured 2026-07-21) — PRESENCE-AWARE AUTONOMY: THE AUTONOMY ENVELOPE SCALES WITH OPERATOR PRESENCE.** An operator-presence signal — console activity (recent board views / actions) OR an explicit `away` mode — scales the unattended autonomy envelope: when the operator is PRESENT (or has pre-cleared), the fleet dispatches as today; when AWAY/unobserved, ONLY risk:low/medium tasks dispatch, and every risk:high dispatch WAITS for presence or explicit pre-clearance. RATIONALE: trust budgets scale with SUPERVISION — the same WAIT-not-spend doctrine as the governor family (W1-T121 queue governor, W1-T148 cost governor, and W1-T130's cannot-observe-means-wait polarity); this is the SUPERVISION dual — gating risk by who is watching, rather than by cost or WIP. PROPOSE the presence signal (a console-activity heuristic + explicit away mode, thresholds as policy-data) and the envelope map (presence-state × risk -> dispatch | wait). NOT FILED AS A TASK: the envelope itself — what risk may dispatch unobserved — is an OPERATOR decision (the P28 envelope doctrine: the machine acts within a policy the operator ratified once, never on its own judgment about how far to trust itself unwatched). Ratification sets the envelope rows; the mechanism (presence detection + the dispatch gate) files behind it. [research: hitl-supervision-scaling / approval-fatigue-2026 — autonomy scaled to observed supervision is the trust-budget pattern.]

**Closed proposals (P1–P8, P10, P11, P15, P21) — RETIRED FROM THIS LIST, ids preserved.** Per RATIFY-OR-KILL
every one now has a terminal status, so the adjudication prose they carried is DELETED rather than
maintained twice (the tasks are the record now): **P1**→W1-T59 (filed, deprioritized) · **P2**→retired as
superseded by §9 (it proposed the tripwire-as-work-limit bug) · **P3**→W1-T58 · **P4**→folded into W1-T24
(SHIPPED #75) · **P5, P6**→W1-T52 (open) · **P7**→ratified into rule 19's citation · **P8**→W1-T58 + the
ratify-or-kill duty (§Self-improvement) · **P10**→W1-T63 (SHIPPED #104 — reviewer/fix/diagnose
mount-governed + `reviewer_outcome`) · **P11**→W1-T51 (SHIPPED #97 — the gather unions ledger∪GitHub, so
the recurring reconciliation gap is now closed mechanically) · **P15**→W1-T65 (SHIPPED #122 — the
deterministic floor executes whitelisted proofs against the PR head; the blind-floor FALSE-PASS/FALSE-BLOCK
hole is closed and the reviewer is now purely additive) · **P21**→W1-T76 (SHIPPED #158 — the blocked_review
fix rung; superseded-by-P22 and absorbed verbatim, so its full prose is DELETED from the proposals list this
cycle). A closed proposal's reasoning lives in its task or
in the rule it amended; restating it here is what turns this list into the graveyard P8 warned about.

## FIELD FINDINGS (from the mini, 2026-07-14 — ground truth, not docs)

1. **★ RESOLVED (2026-07-14) — `ANTHROPIC_API_KEY` in `~/.zshrc` takes precedence over the claude.ai
   login, and stripping ANTHROPIC_* restores subscription OAuth (verdict 1 GREEN).** The setup detail
   (duplicate export on lines 20/21; `launchctl setenv` checked-0) is DELETED — it described one host
   on one day and the DURABLE conclusion is the only live part: **env sanitization is a control-plane
   primitive** (§9), and `billing_mode` is a decision the harness makes, never an accident it inherits.
   SHIPPED as `buildWorkerEnv()`; the boot assertion is W1-T12b/#62.
2. **★ SIDE FINDING (Craig's money, outside Remudero's scope)**: because the key is exported from
   the login shell, **every interactive `claude` session on the mini has been billing API rates
   instead of the Max 20x subscription.** Fix (separate task, do NOT delete the key — ClawApp/
   OpenClaw Python + Haiku need it): scope it to the LaunchAgent plists' EnvironmentVariables and
   crontab entries rather than exporting it from `.zshrc`.
3. **`claude` is a shell FUNCTION** (wraps the binary with `security unlock-keychain` when
   `$SSH_CONNECTION` is set). Real binary: `~/.npm-global/bin/claude` → `claude.exe` (same
   `.npm-global/bin` as the openclaw CLI). ⇒ daemon resolves the binary from **config, never PATH**;
   committed code carries no machine paths (path lives in `~/.config/remudero/config.json`, outside
   the tree).
4. **★ RESOLVED — launchd + keychain OAuth: PASS**; WS-1's LaunchAgent architecture stands, and WS-1
   SHIPPED on it. Two things survive the resolution: a daemon started from a DEV SHELL inherits the key
   and would silently bill API, so **`buildWorkerEnv()` is what makes the dev path as safe as the launchd
   path** (do not delete env.ts on the strength of the launchd result — that process was clean by accident
   of context); and **reboot-resilience (auto-login → session → unlocked keychain) is still unverified ⇒
   WS-7 chaos drill**, not an assumption.
5. **Version observations DELETED as stale** — the pinning DECISIONS are the durable part and they live
   where they are enforced: CLI version pinned as config (WS-7), node via engines/.nvmrc. The 2026-07-14
   snapshot (Claude Code 2.1.209 / node 22.22.3 / gh 2.92.0) has already been overtaken twice — #185
   version-annotated the 2.1.214 pkill drift — and a plan that restates a moving version number teaches
   the reader to trust a number that is wrong.
6, 7. **DELETED (2026-07-21) — setup-day residue, superseded and instance-specific.** Item 6 was a
   paste-block formatting rule for one operator's zsh on one morning; item 7 was this host's workspace and
   deny-floor paths, which are exactly the "instance specifics" the header requires to live in the
   gitignored `local/` overlay and `~/.config/remudero/`, not in the public plan. Both are enforced in
   code and config today; restating a machine layout in the plan teaches the reader to trust a path that
   moves. Ids retained so the numbering that §14 and §5 cite stays stable.
8. **★ GitHub topology + fresh-repo defaults (generalizable — Setup Agent requirement)**:
   `craigoley` is an **Organization**, not a user; the agent account (cao825) is a member with
   `permissions.admin: true` on org repos it creates ⇒ no collaborator grant, no invitation flow.
   The Setup Agent (WS-4) must handle **org-vs-user namespaces** and verify access by reading
   `repos/{owner}/{repo}.permissions`, never by assuming an invite is needed. **Fresh repos ship
   with `allow_auto_merge: false` and secret scanning DISABLED** — an agent pipeline that arms
   `gh pr merge --auto` will silently fail to arm on a default repo. Scaffold MUST explicitly set:
   `allow_auto_merge: true`, `delete_branch_on_merge: true`, and (public repos)
   **secret_scanning + secret_scanning_push_protection: enabled** — push protection is a hard
   backstop under the leak-grep for repos where autonomous agents commit. Also note: cloning is
   **HTTPS-only** on this account (no SSH key); never rewrite a remote to `git@github.com`.
9. **★ Scoped PAT still DEFERRED — workers carry ambient `gh` (cao825 repo-scope) reach, not sandbox-only
   reach.** The blocker is structural: fine-grained PATs on an ORG-owned repo need an org-level opt-in
   that also governs the production fleet, so it is not a unblock-in-passing. Three durable points, the
   WS-0-era narrative around them DELETED: containment rests on OS sandbox + deny-hook + worktree scoping
   — always the real boundary, the PAT was only a blast-radius optimization; the compensating control is
   **secret scanning + push protection ON for both public repos**, which rejects a committed credential
   outright and covers a failure mode PAT-scoping never addressed; scoped-PAT injection via
   `buildWorkerEnv()` remains the open WS-1 hardening task (the one live item §14 cites this finding for).
10. **★ SPIKE GROUND TRUTH (WS-0, all seven verdicts GREEN).** **Full record: `FINDINGS.md` in-repo**;
    this list is the LIVE RESIDUE + reference data only. _R4 deleted b/c/d/e/h: `total_cost_usd`-is-
    notional and `/usage`-is-the-window-source are stated in full in §9; `USER`-for-OAuth and
    `~/.claude.json` tier keys SHIPPED (W1-T9b + env allowlist); SDK-0.3.209's settings/sandbox conflict
    is version-stale (we ship 0.3.210 as of #80)._
    a. **Worker settings FAIL SILENTLY.** `-p` ignores a settings file that fails schema validation —
       a typo does not error, it **drops containment**. The installed schema nests `allowedDomains`
       under `network` (the original prompt put it at the sandbox root ⇒ would have been dropped).
       ⇒ validate-before-spawn guard + a probe as the empirical backstop. **Still the canonical citation
       for §5's containment-probe requirement and rule 11 — keep.**
    f. **Linked-worktree `.git` is OUTSIDE the sandbox write scope** ⇒ `git push -u` is OS-denied on
       the config write (push itself succeeds). **Push without `-u`** — still binding on every runner and
       every retro.
    g. Real knob names (the mounts.yaml vocabulary — W1-T5 shipped on these): `--max-budget-usd`/
       `maxBudgetUsd` (breach ⇒ `error_max_budget_usd`) · `--effort low|medium|high|xhigh|max` ·
       `thinking:{adaptive|enabled+budgetTokens|disabled}` · `maxTurns` · `autoCompactThreshold` ·
       `pathToClaudeCodeExecutable` · `env` (**replaces** the child env entirely — the billing boundary's
       enforcement point).
    i. claude-code#20946 (hook-block-in-bypass async race) **did NOT reproduce on 2.1.209** — the
       deterministic floor held. The `dontAsk` fallback is implemented but **UNTESTED** (golden task).
    j. Near-miss disclosed by the worker: the DECISION_REQUEST parser captured `")"` from an inline
       `(RECOMMENDED)` marker and was right only by luck ⇒ **auto-choose parser golden task**. ★ R4 note:
       this is the SAME defect class as W1-T62's false attribution — a parser taking the first plausible
       match instead of the anchored one. **Two instances now; P9's golden should cover the class.**
11. **★ UNATTENDED-RUNS HARDENING (PR #8, W1-T1C dead-run post-mortem — see LEARNINGS.md).** Full list
    lives in `LEARNINGS.md` at repo root (WS-8 knowledge pipeline); the load-bearing ones:
    a. **Claude Code's Bash-tool snapshot sources `$HOME/.zshrc` via `os.homedir()` — `ZDOTDIR` is
       IGNORED.** Shell isolation must set `CLAUDE_CODE_SHELL` (the rc filename follows the shell),
       never ZDOTDIR alone. Disassembled the installed binary to establish this (Standing rule 7). [PR #8]
    b. **The current `/bin/bash` isolation works ONLY because `~/.bashrc` is absent on this host** — an
       accident, not construction; a populated `~/.bashrc` isolates nothing ⇒ **W1-T17 preflight probe
       (fail-closed) + W1-T18 general mechanism (OSS blocker).** [PR #8]
    c. **The SDK yields the `type:"result"` envelope (`num_turns`, `total_cost_usd`, `subtype`) and THEN
       throws** from the iterator on an error subtype — read the envelope before the catch, or a failed
       run looks free in the ledger (failures are the runs that burn most). [PR #8]
    d. **`maxBudgetUsd` is checked BETWEEN turns**: a $0.01 budget produced $0.21 of real spend. It is a
       circuit breaker with up to one turn of overshoot, NOT a hard cap — budgets need headroom. [PR #8]
    e. Reaffirms 10a (settings fail SILENTLY under `-p`) and the `$loose`-schema catch (W1-T1): validating
       against the SDK schema alone PASSES a misplaced key — validate shape explicitly. [WS-0 / W1-T1]
12. **★ SELF-UPDATER RACE (run W1-T1C-1784038021919).** Claude Code's **background self-updater**
    `npm install`s the CLI into the global prefix mid-session; a worker spawn landing in npm's
    unlink/relink window dies **ENOENT**, which the SDK misreports as *"native binary not found"*. Every
    live `claude` runs its own updater ⇒ fleet concurrency is a **thundering herd** that widens the
    window. Mitigation: workers set `DISABLE_AUTOUPDATER=1` (confirm empirically — rule 7; reports say it
    is sometimes not honored), the runner **retries ENOENT-class spawn failures** (safe: no turns/cost
    before the first message), and long-term the CLI version is pinned config (WS-7). **This is the first
    "guard caught it AFTER the burn, not while it went wrong" case that motivates §4B Flight control.**
    **Full narrative, the two diagnostic corollaries (the message is diagnostic; evidence by BIRTHTIME
    `stat -f %SB`, never existence) and the exact falsifier live in `DIAGNOSIS.md` + `LEARNINGS.md` — the
    full restatement that sat here is DELETED (this plan's own §8A: retrieve, do not inject).**

---

## Bootstrap ladder — Remudero builds Remudero

The dogfooding requirement, made structural. Each rung uses the previous rung to build the next:

- **L0 — DONE**: the human loop — Craig + external Claude produce prompts; Claude Code executes them.
  Built: the WS-0 spike.
- **L1 — DONE (2026-07-15)**: **proto-runner** — `run-task.ts`, one tasks.yaml entry in, recon →
  provenance-linted prompt → implement → PR → verdict out, kicked manually. It executed WS-1's entire
  own task list, one kick per task. Dogfooding started before the daemon existed, as designed.
- **L2 (★ ACTIVE — WS-1 complete)**: the daemon loops unattended; WS-2+ backlogs execute through it.
  The plan repo's tasks.yaml is the first plan Remudero stewards. Proven by the SBX-T1/T2/T3 drain.
- **L3**: the flywheel (below) files improvement tasks on Remudero from Remudero's own ledger —
  the harness maintains itself, human approves plan-increment PRs.

Rule: no rung is built by hand if the rung below can build it.

---

## 1. Architecture — four planes

**Control plane** — deterministic TypeScript daemon (launchd/systemd-supervised). Owns: task DAG
scheduler, worktree lifecycle + GC, worker process supervision, PR watching + stuck-PR shepherd,
attempt/strike accounting, budget metering, escalation queue, notifier dispatch, **worker
environment construction** (explicit allowlist; ANTHROPIC_* stripped — §9) and **claude-binary
path resolution from config** (never PATH-dependent — FIELD FINDING 2), and the fleet control set: **Pause** (drain-and-hold: no new worker spawns; in-flight tasks run to FULL
completion — through verdict and merge — so state stays clean; watchers and shepherd keep
running), **Resume**, and **Stop** (hard kill: `STOP` file checked every tick + UI button).
`rmd pause|resume|stop` mirrors the panel. Zero LLM decisions. Crash recovery: all durable state
derives from git + GitHub; local queue/locks are rebuildable cache.

**Brain plane** — model calls at phase boundaries only. Two roles, one service, model-routed:
- **Architect** (Opus-class, extended thinking + web search): grill-me intake, plan authorship/revision,
  narrative plan syncs at workstream boundaries, escalation drafting, next-increment drafting when idle.
- **Promptsmith/Reviewer** (Sonnet-class, per-loop): renders task+recon into worker prompts
  (house format, provenance-linted), verdicts worker REPORTs and PR diffs against acceptance proofs,
  resolves DECISION_REQUESTs (auto-choose).

**Worker plane** — Agent SDK sessions (`query({ cwd: worktree, ... })`), typed by phase:
- **recon**: read-only tools; output contract = OBSERVED / INFERRED / COULDN'T-VERIFY sections; TTL'd.
- **implement**: full tools per permission profile; branch from latest origin/main; one concern; opens PR;
  ends with structured REPORT (changed / proven / inferred / open questions / PR_URL).
- **fix**: resume original session (round 1) → fresh session with distilled context (round 2).
- **diagnose**: evidence-only worker dispatched after two strikes; per-step telemetry; no patches.
- **reviewer**: fresh context, read-only + gh; adversarial audit vs. acceptance proofs + principles rubric.
Workers get **no MCP config** (MCP auto-approves under bypass — surface stays zero).

**Interface plane** — the **control panel**: one daemon API (REST + SSE, tailnet, bearer-scoped),
with every client a **stateless projection** of it — the web dashboard (desktop: served on the Mac,
opened in any browser; Tauri menu-bar wrapper banked), the Expo mobile app (G-5), and **remudero-mcp**
(so any Claude — claude.ai via custom connector, Claude Code sessions, the Architect — reads and
proposes against the same plan). Desktop↔mobile "sync" is free by construction: no state lives in
clients; state lives in git + the ledger; clients subscribe via SSE and reconcile optimistic updates.
Notifier adapters, reference-first per Q2/G-15 (nothing Craig-specific in the default path):
**imessage-local** — the daemon lives ON a Mac, so it sends iMessage-to-self natively via
osascript/Messages.app, zero extra infrastructure for the Mac+iPhone operator (one-time Automation
TCC grant; verify-under-launchd is a WS-1 check) → **github-issues** (universal, mobile-push free)
→ ntfy / Slack / Discord / email / webhook. BlueBubbles becomes a Craig-legacy optional overlay,
not a dependency. M2's Expo app brings true APNs push later.

## 2. Plan format & contracts

**Per product**: the design repo holds `MASTER-PLAN.md` (human narrative, this document's format)
and machine state:

```yaml
# plan/tasks.yaml (schema v1)
- id: F1-3
  title: Escalation issues + iMessage digest
  repo: remudero                # target repo
  depends_on: [F1-1, F1-2]    # may cross repos → ordered bundles
  type: implement             # recon|implement|diagnose|review|manual
  verify: auto                # auto|human  (human ⇒ draft PR + MANUAL escalation, never auto-merge)
  principles: {tdd: strict, dup_budget: default, fitness: default}   # overrides per task
  acceptance:
    - claim: "escalation lands as a labeled GitHub issue"
      proof: "issue URL + label visible via gh issue view"
    - claim: "daily digest sends"
      proof: "notifier ledger line + received message screenshot ref"
  status: queued              # queued|recon|prompted|running|review|fixing|diagnosing|blocked|merged|done
  attempts: 0                 # strikes: deterministic failures only
  session_id: null
  pr: null
  budget_usd: 3.00
```

**Plan-repo write discipline — status is DERIVED, not written (CORRECTED by W1-T1).** `tasks.yaml`
is a pure DECLARATION: human/Architect-authored, comment-rich, edited only via PR. The machine NEVER
rewrites it (YAML round-trip destroys comments; status commits spam a public repo's history; and a
machine writer racing a human editor is a conflict class we can simply not have). **Task status is
DERIVED from GitHub** — merged iff a PR naming the task id is merged; blocked iff an escalation issue
is open; running iff a worker lock exists — with a cached projection in `state/`. GitHub is
authoritative, so crash recovery needs no local state at all. The control plane still appends to
questions.ndjson / DECISIONS.md / the ledger (append-only, no round-trip hazard), debounced to
≤1 commit/min. Humans and the Architect edit narrative (MASTER-PLAN prose, LEARNINGS,
templates) via PRs. Field ownership is documented per file; a conflict between a machine commit and
a human edit resolves human-wins-on-narrative, machine-wins-on-status.

**Worker output contracts** (parsed from result JSON; malformed ⇒ one reformat retry ⇒ strike):
- `RECON REPORT` — OBSERVED (command + output), INFERRED, COULDN'T-VERIFY. Prompts may cite only OBSERVED.
- `REPORT` — changed / proven (proof pasted) / inferred / open questions / PR_URL.
- `DECISION_REQUEST` — options[], exactly one RECOMMENDED, reversibility note. Resolved machine-side.
- `QUESTION` — **non-blocking**: {question, current_assumption (the worker proceeds on this),
  impact_if_wrong: low|med, task}. Logged to the ledger + `plan/questions.ndjson`; surfaced as a
  batch-answerable backlog in the control panel and counted in the daily digest. Answers feed the
  Architect → plan/LEARNINGS updates; an answer contradicting a shipped assumption auto-files a
  corrective task. **Rule**: high-impact + hard-to-reverse is never a QUESTION — that's an
  escalation. Everything else: assume, log, keep moving.

**Provenance gate**: every CONTEXT claim in a rendered prompt carries `[src: recon#… | plan#… |
PR#/commit | URL]`. Deterministic linter blocks dispatch of uncited prompts. Recon TTL: prompts
never render from stale recon. Rule: **PROVENANCE OR IT DOESN'T GO IN A PROMPT.**

## 3. The loop (per task)

queued → **recon** → **prompt** (provenance-linted) → **running** (implement worker) → PR open →
**review** (reviewer verdict + CI) → merge (existing trusted-author auto-merge, base==main) →
**plan-sync** (status flip by control plane; narrative sync by Architect at workstream boundaries)
→ next task. Failure paths: red CI/changes-requested → **fixing** (resume, round 1; fresh, round 2)
→ two strikes → **diagnosing** (evidence worker) → one evidence-armed retry → **blocked** (escalate).

## 3A. Campaigns (cross-repo improvement cycles)

Injectable, reusable improvement sweeps — "recon and implement across all repos for X" as a
first-class object, not a hand-written batch of prompts. A campaign is a parameterized template in
`plan/campaigns/<name>.yaml`: repo selector, recon prompt template, implement prompt template,
**acceptance formula as a measurable delta against ledger/CI baselines** (coverage +N%, dup-budget
−N%, complexity ceiling −N, zero new deps with known CVEs), per-repo budget, priority.
The Architect instantiates it into ordinary tasks.yaml entries (per-repo recon → per-repo
implement), so campaigns inherit every existing guard — provenance gate, principles, two-strikes,
merge serialization — for free, and close with a campaign retro.

**v1 catalog**: tech-debt sweep · coverage-raise (ratchet bump) · dup-shrink / design-refactor pass
· dependency shepherding · doc-sync · security audit sweep · **platform-bump** (Claude Code/SDK
version — WS-7's release watcher feeds it). **Triggers**: standing (idle-groom now
drains low-priority campaign tasks before drafting new plan increments), scheduled (weekly
tech-debt hour in quiet-hours), and **retro-filed** (a retro finding that spans repos becomes a
campaign proposal on the plan-PR path). The principles engine (§5) is the fuel gauge: ratchets and
budgets provide the baselines campaigns move.

**REFACTOR — a first-class campaign type with TEETH (promoted; the operator correctly flagged it as
under-built).** "tech-debt sweep" was a vibe; it is now a real gated campaign whose acceptance FORMULA is a
MEASURABLE DELTA on the Tier-2/3 gates (§5): **mutation score UP · cyclomatic complexity DOWN · duplication
(jscpd) DOWN · ZERO new CVEs · every in-scope dependency-cruiser fitness violation RESOLVED.** A refactor PR
that does not move those numbers in the right direction is **CI-red** — refactor is proven by the gates, not
asserted. This is also the `refactor` skill (§5B); the campaign is how it runs fleet-wide (W2-T3).

## 4. Autonomy doctrine

**The loop never waits on a human unless the plan says `verify: human`.**

- **Auto-choose**: DECISION_REQUESTs resolve to the RECOMMENDED option (Promptsmith may override with
  stated reasoning); logged to `DECISIONS.md` with rationale + rollback pointer (usually "revert PR#N").
  Sound because the PR boundary makes nearly everything reversible.
- **Hard-stop list** (deterministic, tiny): destructive ops against live data stores; spend beyond cap;
  force-push; secret handling; anything not PR-shaped. Only these pause for the human.
- **Permissions**: workers run bypassPermissions (Craig's instance). Floor = PreToolUse deny-hook
  (<1s, exit 2): protected paths + `git push --force` + `gh auth` mutation. Documented to block even
  under bypass; **known counter-report** (claude-code#20946, macOS async race) ⇒ Phase-0 planted-probe
  test is the falsifier. Fallback if probe fails: `dontAsk` + allowlist (identical zero-stall).
  **Zero ask rules in worker settings** (ask rules still prompt under bypass ⇒ hung headless worker).
  Verify in Phase 0: git commit/push via Bash doesn't trip protected-path prompts (.git/ etc.).
- **Loop hardening**: transient-vs-strike classification (SynthWatch pattern — network/gh-5xx/CI-flake
  retries with backoff, no strike); stuck-PR shepherd (auto-rebase, auto-fix from failing logs,
  auto-resolve conflicts via resumed session); timeouts resolve to action; **idle = groom** (promote
  banked items, shepherd dependabot, triage flakes, draft next plan increment as a plan-repo PR).
- **Interrupts collapse to a daily digest**; real-time pings only for MANUAL + hard-stop.
- **Escalation taxonomy** (GitHub issues, `needs-human` label, options + recommendation in body):
  BLOCKED (post-diagnose), MANUAL (secrets, repo creation, deploys, eyeball/playtest gates),
  HARD-STOP, PLAN (approval PRs for new plans/increments). DECISION and DIRECTION classes are
  absorbed by auto-choose and idle-groom respectively. **ASYNC-QUESTION** is deliberately NOT an
  escalation: it never blocks (see QUESTION contract, §2). The MANUAL queue doubles as **the
  human's to-do list** — rendered in the control panel with check-off (= closing the issue), so the
  agent's asks of Craig are as visible and workable as Craig's asks of the agent.

## 4A. Workspace containment (fleet-wide)

**Everything lives under one root** (`~/Remudero`, configurable `REMUDERO_ROOT`); the main agent
works inside it and cannot leave; workers get subfolders (worktrees) within it.

Layout: `$ROOT/projects/<product>/{repos,worktrees/<task-id>}` · `$ROOT/state` (ledger, queues) ·
`$ROOT/logs` · `$ROOT/tmp`.

**Workers — OS-enforced (Claude Code native sandbox; macOS Seatbelt, nothing to install)**: default
write scope is the working directory + session $TMPDIR, enforced by the OS on every Bash command
and all child processes — a worker with cwd = its worktree is confined by the kernel, not by trust.
Worker settings ship: `sandbox: { enabled: true, failIfUnavailable: true` (never silently
unsandboxed)`, filesystem: { denyRead: [~/.ssh/**, ~/.aws/**, ~/.config/remudero/**] },
allowedDomains: [github.com, api.github.com, codeload.github.com, registry.npmjs.org` + per-repo
profile additions`], excludedCommands: ["gh *"] }` — gh is documented to fail TLS verification
under Seatbelt, so it runs outside the sandbox (still inside bypass + deny-hook, carrying only the
scoped PAT). Spike verifies whether plain `git push` over HTTPS works through the sandbox proxy;
record which path won. **Both layers for secrets**: sandbox denyRead governs Bash/`cat` but does
NOT stop the Read tool — permission `deny: Read(...)` rules cover the same paths. Zero ask rules
stays load-bearing: content-scoped ask rules (e.g. `Bash(git push *)`) still prompt even for
sandboxed commands. The sandbox auto-denies writes to its own settings files.

**Defense-in-depth stack, named**: bypassPermissions (gate 1 off, per directive) → OS sandbox
(gate 2 ON: what a command can touch) → PreToolUse deny-hook (deterministic tripwire) → scoped PAT
(blast-radius cap). The earlier "bypass is for isolated environments" tension resolves the
documented way: bypass + sandbox is the pairing.

**Main agent (daemon)**: plain node process, no LLM tools — containment is a code-level path guard
(every filesystem op derives from $ROOT; ops outside throw; unit-tested + a golden task). If the
Architect ever grows local tools (in-harness grill-me recon), those run as sandboxed workers too.

**Spike verdict 7 (containment probe)**: a sandboxed bypass worker (i) writes inside its worktree;
(ii) is OS-DENIED writing to a sibling path outside cwd (proof: error text + file absent);
(iii) completes a push with ZERO prompts under pre-configured allowedDomains; (iv) the
FORBIDDEN_PROBE hook-block still fires through the sandbox. Fallback if sandbox can't run
prompt-free headless: containment via hook-only, recorded honestly in FINDINGS as the weaker floor.

## 4B. Flight control (in-flight supervision, risk-graded gates, on-demand review)

**Why.** Today's only guards are terminal cliffs — budget, turns, strikes. They catch a worker
*after* it burns its budget, not *while* it goes wrong (FIELD FINDING 12 is the first such case: the
spawn race was caught by a cliff, post-burn). Flight control adds in-flight supervision, risk-graded
human gates, and on-demand specialist review — **without** putting an LLM in the merge decision. The
governing split: **supervision is deterministic; judgment is advisory. An LLM may recommend a halt;
only code may enforce one** (Standing rule 12).

**LAYER 1 — deterministic flight signals (no LLM).** Streamed per turn from the worker's stream-json,
computed by the control plane as pure **predicates** — they FIRE, they never JUDGE:
- **burn rate** vs. the task-type baseline (spend/turn against the mount's expectation);
- **diff-growth per turn** (a diff ballooning turn-over-turn);
- **repeated tool-call hashes** (the same call issued again and again);
- **error-signature loops** — count only occurrence **N ≥ 3** of a fingerprinted error (the
  analyze-diagnostics discipline: one failure is noise, three is a loop);
- **scope drift** — files touched vs. the task's declared files;
- **stall timeout** — no progress within a wall-clock bound.
These are cheap, deterministic tripwires. A trip does not decide anything; it *invokes Layer 2*.

**LAYER 2 — the FLIGHT JUDGE (LLM-as-judge on PROCESS, not artifact).** Invoked **ONLY** on a Layer-1
tripwire (never resident per turn). **FRESH context.** It sees: the goal, the acceptance criteria,
and the last N turns' **tool calls AND results** — **never the worker's reasoning** (the maker sees
its own trail; the verifier sees only behavior + rubric, so it cannot be talked into agreement by the
maker's narrative). It returns:
`{ state: productive | converging | spiraling | blocked | off_track, evidence[],
recommendation: continue | nudge | halt_and_diagnose | escalate, confidence }`.
It **ADVISES**; a **deterministic controller ACTS** on the advice:
- `spiraling` + high confidence → **halt + dispatch a DIAGNOSE worker** (never a third blind patch,
  Standing rule 5);
- `off_track` → **halt + escalate**;
- `converging` → **raise the tripped threshold ONCE, log it, continue** (slow ≠ stuck).
The judge **rides a HIGHER tier than the worker** (G-17 Tier Invariant). It is **capped at K
invocations per run; the Kth must DECIDE, not defer** (no infinite advisory loop). The judge **NEVER
edits code and NEVER merges.**

**LAYER 3 — RISK SCORING (this is what makes auto-choose SAFE — not a retraction of it).**
Deterministic, computed from the diff + task metadata:
- **blast_radius** — does it touch hooks / settings / env / CI / branch protection / credentials /
  new dependencies / network egress?
- **reversibility** — how cleanly does `revert PR#N` undo it?
- **novelty** — first-of-kind change vs. well-trodden path;
- **confidence** — reviewer score, strike count, flight-judge state.
Bands and their gates:
- **low → auto-choose, unchanged** — the overwhelming default (§4 autonomy stands);
- **medium → reviewer PASS required** — the gate already enforces this (Standing rule 3B);
- **high → the DECISION_REQUEST becomes a TIMEBOXED QUESTION** with the assumption stated; **unanswered
  at timeout ⇒ take the recommendation and flag it LOUDLY in the digest** (still no stall — §4);
- **critical → HARD STOP + escalate, never auto-chosen.** The existing hard-stop list (§4) is the
  FLOOR, not the ceiling.

**LAYER 4 — the SPECIALIST PANEL: consult, don't committee.** Triggered **BY risk + diff signals**,
never resident on every task (cost + slop). Each specialist gets **fresh context, read-only tools, a
scoped rubric**; posts **PR review comments** and contributes to the reviewer's verdict:
- **security** ← auth / credentials / egress / new deps / hooks / settings;
- **testing** ← `tdd: strict`, or a negative coverage/mutation delta, or new code paths without tests;
- **design** ← the diff crosses layer boundaries (fitness rules) or adds an abstraction;
- **containment** ← ANY diff touching sandbox / settings / deny-floor / env (WS-0 proved a typo there
  silently drops containment — FIELD FINDING 10a).
Specialists **ADVISE**; the **GitHub-enforced gate DECIDES** (Standing rule 3B).

**FORBIDDEN.** No standing committee (panels are triggered, not resident). **No LLM in the merge
decision** — the merge gate is a GitHub-enforced contract, always. No judge-of-the-judge recursion
(the K-cap terminates advice). Judges and specialists **never edit code.**

**Build order.** Layer 1 = **W1-T20**, Layer 2 = **W1-T21**, Layer 3 = **W1-T22** (T20→T21→T22, all
after the enforced gate W1-T1D); Layer 4 = **W2-T1** (after the reviewer W1-T1D + risk scoring W1-T22).

## 5. Principles engine

Remudero's CI today is typecheck + tests. That is the FLOOR, not the bar. The operator's fleet
(SynthWatch, neon-drift, rogue-descent, wild-trails, OleyArcade, ClawApp) paid — sometimes in outages —
for a gate stack Remudero must both MEET on itself and INHERIT-by-default onto every project it builds
(§5A). A harness that ships untested, unscanned code at scale is a liability generator; the anti-slop
thesis of §Mission is only real if the gates are real. Structure: **three ENFORCEMENT layers (how)** over
**a three-TIER gate stack (what)**.

### Enforcement layers (strongest first — instructions shape behavior; gates guarantee it)

1. **Deterministic gates** (hooks + CI) — the load-bearing layer. Trust/pass-fail is a DETERMINISTIC
   predicate, never an LLM decision (Standing rule 2). TDD Guard-style PreToolUse enforcement (blocks
   implementation edits without a failing test) where the stack supports it; `tdd: strict` REPORTs paste
   **red→green proof**. Everything in the tier stack below is enforced here or by the reviewer.
2. **Reviewer rubric** (judgment — advises; the GitHub-enforced gate decides, Standing rule 3B). Rubric
   items, each a checked question: **one concern per PR**; **all callers audited** (partial-fix drift —
   a change that fixes one call site and orphans the rest); **test theater** (assertions that assert
   nothing / snapshots-of-nothing / tests that kill no mutants); **refactor-phase honesty** (a "refactor"
   that changes behavior); coupling/cohesion; **docs awareness** (§12A — a diff changing user-visible
   behavior — CLI surface, config, gate, verdicts — must update `docs/` or state why not in the REPORT,
   W1-T30); **no worker-authored `satisfied_by`** (a diff that ADDS a
   `satisfied_by` line to `plan/tasks.yaml` FAILS unless the PR is plan-only and human-authored —
   `satisfied_by` is Architect-only; a worker adding it to its own blocking criterion is editing the
   criteria to match the diff, Standing rule 15). TDD Guard's own author documented that mechanical
   test-first alone still yielded tight coupling + duplication — which is why layer 2 exists.
3. **Prompt layer**: Promptsmith injects the repo's principles profile into every prompt; weakest,
   never load-bearing.

### The gate stack — three tiers

**TIER 1 — SECURITY (must-have, day one).**
- **CodeQL** via an EXPLICIT workflow — GitHub's *default setup* must be **DISABLED**, or the two
  conflict and both go unreliable (fleet lesson). [LEARNINGS]
- **Dependency scanning (Dependabot)** — **MAJOR bumps are EXCLUDED from auto-merge at the dep-review LANE
  (W1-T54), NOT via Dependabot ignore-rules.** ★ FLEET FINDING (rule-7 verify, this sweep): the installed
  fleet dependabot configs are **IGNORE-FREE** — synthwatch `.github/dependabot.yml` carries only
  minor+patch GROUPING (`update-types: [minor, patch]`, to collapse PRs), NO `ignore:` block; neon-drift's
  documents "NO ignore list" deliberately. And the fleet's auto-merge does **no semver check**: synthwatch
  `claude-review.yml` `automerge` fires for any trusted author incl `dependabot[bot]` (majors would
  auto-merge today); neon-drift SKIPS dependabot entirely. So the earlier "Dependabot ignore-rules for
  semver-major" was ASPIRATIONAL, not installed. Remudero's real mechanism: ignore-free Dependabot +
  minor/patch grouping, with the semver level parsed at the dep-review lane — minor/patch auto-merge,
  majors escalate to a human (the 28-minute-outage lesson enforced in CODE, not config).
- **OSV / vulnerability scan** on the dependency tree (catches advisories Dependabot hasn't cut a bump
  for yet).
- **Secret scanning + PUSH PROTECTION** — already live on `remudero` (FIELD FINDING 8); required on
  every provisioned repo.
- **SECURITY.md** with a private-disclosure path (advisories, not public issues).
- **Least-privilege `GITHUB_TOKEN`** — every workflow declares minimal `permissions:` (default read-all
  is a standing over-grant).
- **Pinned action SHAs, never tags** — `uses: org/action@<40-char-sha>`; a moved tag is a supply-chain
  vector.
- **No plaintext secrets in any tree** — a leak-grep runs **in CI on every PR**, not just once in the
  spike; push protection is the backstop, the grep is the tripwire.
- **★ AGENT-SPECIFIC (we ship an agent harness, so the diff itself is attack surface):**
  - **Prompt-injection surface review** — REQUIRED on any diff touching worker **prompts, hooks,
    settings, or egress** (a poisoned prompt/hook is a code-exec path).
  - **Containment probe as a REQUIRED check** — on any diff touching **sandbox / deny-floor / env** (WS-0
    FF10a proved a single typo there SILENTLY drops containment; static validation is not enough — the
    probe is the empirical guarantee, W1-T2 / W1-T28).

**TIER 2 — QUALITY & TESTING.**
- **Coverage ratchet** — never down; ratchets up. A coverage-lowering PR is CI-red. Baseline captured at
  onboarding so the ratchet has a floor.
- **Mutation-testing baseline** — Stryker for TS (SynthWatch pattern). **Green tests that kill no mutants
  are theater;** the mutation score is the falsifier that coverage % cannot provide. Baseline recorded,
  ratcheted like coverage.
- **Duplication budget** — jscpd threshold; breach ⇒ CI-red + auto-filed refactor task (idle-groom).
- **Complexity budgets** — eslint `complexity` + `max-lines`/`max-lines-per-function`, advisory-then-
  required per profile.
- **TypeScript strict — VERIFIED ACTIVE, not assumed.** A planted probe (the neon-drift `_probe(x)`
  lesson) must FAIL the gate: *"0 violations" from a fresh strict gate is suspicious until falsified.*

**TIER 3 — ARCHITECTURE / MAINTAINABILITY.**
- **Fitness functions via dependency-cruiser** — the games' purity gates generalized into declarable
  layering rules: "src/game imports no Three.js" → for remudero, **"src/lib imports nothing from
  spike/CLI"** (`src/lib` must not import `src/spike.ts` or `src/run-task.ts`). A violating import is
  CI-red.
- **ADR discipline** for IRREVERSIBLE calls (a short Architecture Decision Record accompanies a
  one-way-door change; reversible PR-shaped changes stay in `DECISIONS.md`/auto-choose).
- **One-concern-per-PR** — socially enforced today; made a reviewer-rubric item (layer 2) so it is
  checked, not hoped.

### CI mechanics (fleet-hardened — these are RULES, learned in production)

- **The required-check context is the JOB NAME, not the workflow file name.** Protection keys on the job.
- **A conditionally-SKIPPED required check DEADLOCKS merge forever** (a `paths:`-filtered or `if:`-gated
  job that doesn't run is "expected, pending" = never green). ⇒ **use ONE always-runs CI-GATE AGGREGATOR
  job** that `needs:` every sub-job and succeeds only if all did; make THAT the single required context
  (W1-T24). Sub-jobs may skip freely; the aggregator always reports.
- **`GITHUB_TOKEN` suppresses downstream workflow triggers** — a workflow's push/PR events won't fire
  another workflow when authored by the default token; use an app/PAT where a chained trigger is needed.
- **Arm `--auto` under protection; never immediate-merge** — an immediate merge RACES the checks
  (Standing rule 3B: GitHub decides on green, the runner only arms + observes).
- **Trust is a deterministic predicate, never an LLM decision** (Standing rule 2) — the reviewer/judge
  ADVISE; only the aggregator + protection ENFORCE.

### Per-repo profile — `.remudero/principles.yaml`

Declares the tier config for a repo: `tdd`, `coverage_ratchet`, `mutation_baseline`, `dup_threshold`,
`complexity`, `fitness_rules[]`, `security_profile`. OSS users tune; Promptsmith reads; CI enforces;
reviewer audits; plan tasks may override per task. Profiles by project type (`ts-node` / `ts-web` /
`python` / `dotnet`) ship sane defaults — the operator tunes but NEVER starts from zero (§5A).

**REMUDERO RUNS THE STRICTEST PROFILE ON ITSELF** — `tdd: strict`, ratchet on, mutation baseline,
fitness rules, the full security tier. The harness eats first: every gate is proven GREEN (and proven to
FAIL a planted violation) on Remudero's own codebase before it is inflicted on anyone else's.

## 5A. The fleet bar is inherited, not optional

Meeting the bar on `remudero` is necessary but not the point. The point is that **every project Remudero
orchestrates INHERITS the bar automatically** — provisioned at onboarding, not asked to adopt it. A
harness that builds code at fleet scale without installing the gates is a liability generator; opt-in
quality is quality that silently doesn't happen.

**`rmd project init <repo>`** (W1-T27) is the onboarding primitive. Given a target repo it scaffolds, in
one PR against that repo:
- the **workflows** (CodeQL explicit, OSV, leak-grep, coverage/mutation/jscpd/complexity, the CI-gate
  **aggregator** job) — SHA-pinned, least-privilege;
- the **configs** (`dependabot.yml` with majors excluded, dependency-cruiser rules, eslint/tsconfig
  strict, `.remudero/principles.yaml` for the chosen profile);
- **`SECURITY.md`** + private disclosure;
- **branch protection** wired to require the single aggregator context (+ secret-scanning/push-protection
  on);
- **ratchet BASELINES captured at onboarding** (coverage %, mutation score, dup %, complexity) so every
  ratchet has a real floor from day one — a repo never onboards "at zero."

**Profiles** (`ts-node`, `ts-web`, `python`, `dotnet`) carry the sane defaults; the operator tunes
`.remudero/principles.yaml`, never authors the stack from scratch. **A campaign (§3A) raises the bar
fleet-wide** when a gate improves: the improved gate becomes a per-repo task, instantiated across the
selector, each with its own baseline capture and green-PR proof.

The invariant: **Remudero runs the strictest profile on itself, and no project it touches runs less than
its profile's floor.** The harness never ships a gate it hasn't already eaten.

## 5B. The Architect-worker primitive & the skill registry

**OBSERVATION (the unification):** Setup, Plan, Refine, Expand, Feedback/triage, Refactor, Design Review,
Retro, and the Reviewer are ALL THE SAME PRIMITIVE — a **higher-tier (G-17) worker** that **GROUNDS** (grep
the plan / learnings / ledger / DECISIONS for what is already decided) → **RESEARCHES** (server-side
WebSearch) → **GRILLS** (AskUserQuestion / a `needs-human` issue, §4/§7B) or **PRODUCES** (a PR gated by
`ci + remudero-review`). They differ ONLY in a declarative PROFILE. So they are not nine features to build
nine times; they are ONE primitive plus a registry of configs.

**The skill registry** — `.remudero/skills/<name>.yaml`:
`{ tools[], permission_profile, output_contract, grounding_sources[], gate, tier }`. **Adding a skill is a
CONFIG ENTRY, not new code** (W1-T44). Each skill maps 1:1 to a future UI action (§7 shell, W3-T8) — the
panel button IS the registry entry.

**The registry (v1):**
- **setup** → the Setup Agent (WS-4 / G-16), unchanged — folded in as a skill.
- **plan** → ★ **ONE skill, THREE MODES**: `create | clarify | expand`. **Refine = clarify; Expand =
  expand.** The operator's "Refine is maybe a duplicate of Plan" is CORRECT — do NOT build three skills
  that triplicate ground→research→grill→propose and drift apart. `rmd plan --mode=create|clarify|expand`
  (W1-T45).
- **feedback / triage** → §7B, folded in.
- **retro** → the existing retro Architect (`rmd retro`), folded in.
- **review** → the DETERMINISTIC-gated reviewer (the judge is code — Standing rule 2/§7A; the LLM layer is
  advisory only), folded in.
- **refactor** → PROMOTED to a first-class skill + campaign with teeth (§3A, W2-T3).
- **design-review** → NEW, with its own hardened browser profile (§7C, W3-T7).

**TOOL BOUNDARY stays PER-PROFILE, never global:** the web tools (WebSearch/WebFetch) and browser egress
are granted PER SKILL (§7B, §7C) — an implement worker's profile grants none of them. A skill can PROPOSE
anything and MERGE nothing; every output is contained by the same PR + review gate as any worker.

## 5C. Task pre-flight: the plan gate

**Task quality is a GATED, LEARNED property — caught BEFORE dispatch by a deterministic linter, refined by
the Architect, and continuously re-graded by the retro. The runner is the LAST line of defense, not the
first.** Four malformed tasks reached workers and burned budget before a human noticed the pattern (W1-T6,
W1-T9, and W1-T12 — which violated Rules 18 and 19 three times over). Every one was catchable *before*
dispatch. Reactive diagnosis after an 81-turn / $10 burn is the anti-pattern this project exists to kill;
task quality moves UPSTREAM of the runner and the plan LEARNS from overruns automatically.

**LAYER A — the DETERMINISTIC task linter (no LLM), run at TWO points, FAIL-CLOSED:** (i) a CI check on any
PR that edits `plan/tasks.yaml`; (ii) a PRE-DISPATCH guard in `rmd run-task` / `rmd drain` — a task that
fails the linter is NEVER dispatched (`verdict=blocked_illformed`), so a broken task can never reach a
worker again. It checks, all from rules we already wrote:
- **SIZING (Rule 19):** count acceptance criteria; count distinct subsystems implied by `files:` / the
  criteria. ≥2 concerns or ≥2 subsystems while `risk < high` ⇒ FLAG (raise to high or decompose).
- **HEADLESS-FITNESS (Rule 18):** grep each criterion against a forbidden live-context LEXICON —
  `overnight` · `reboot` · `launchctl` · "loads at boot" · `killed` · "operator confirms" · "user selects"
  · manual-eyeball — on a `type:implement` (auto-verify) task ⇒ FLAG (move to `verify:human` or redesign the
  criterion for headless verification). The lexicon is DATA, so it grows.
- **PROOF-SHAPE:** every criterion has an OBSERVABLE proof (not "works" / "correct" / a vibe) ⇒ else FLAG.
- **PROVENANCE (Rules 16/17):** `origin:` + `risk:` present ⇒ else FLAG.
- **BUDGET SANITY (soft):** flag a task whose `risk→mount` turn-budget is below the observed mean for its
  class (ledger calibration) — a WARNING, not a block.

**LAYER B — Architect review (LLM), only for what the linter CAN'T judge.** Invoked on NEW tasks a plan PR
adds, it grounds (grep `learnings/`) and asks the judgment questions the linter can't — "is this
genuinely ONE concern?", "is any criterion secretly a task-inside-a-task?", "does a learning already warn
about this?". ADVISORY: it annotates the task with a risk/rationale; it does NOT block (the linter blocks).
Reuses the §5B Architect-worker primitive. **Most catches are DETERMINISTIC** — criteria count, subsystem
count, forbidden verbs, proof-shape need no LLM; reserve Layer B for genuine ambiguity. Cheap checks first.

**The retro's PLAN-HEALTH duties (the "learn as we go" half).** `rmd retro`, every run, must:
- **RE-GRADE** every OPEN task against every standing rule — the forward-only gap that let W1-T12 slip
  (Standing rule 20). Emit a plan-health report; auto-file a corrective task per violation.
- **MINE** `max_turns` / `blocked_*` verdicts for PATTERNS: if a CLASS of task overruns (cross-cutting
  implement tasks — W1-T6, W1-T9, W1-T12 all did), propose a CLASS-level fix (adjust the mount, or a new
  auto-risk rule like "touches ≥3 files ⇒ `risk:high`"), NOT another per-task patch.
- **RUN the Layer-A linter across the WHOLE open queue** and surface every current violation.

Layer A = W1-T20c (linter + fail-closed guard); the retro plan-health sweep = W1-T20d.

## 5D. Fleet operations — the ongoing-response loop

**Provisioning the gate stack (§5/§5A) is ONE-TIME; OPERATING it is CONTINUOUS.** Setting up CodeQL/OSV/
Semgrep/Scorecard/Dependabot on a repo is done once; the alerts and dependency PRs they generate arrive
forever and, until now, nothing responded to them. The harness owns **three intake lanes**, all
PR/issue-shaped, all gated by the same [ci, remudero-review] gate as any task:

1. **Dependency PRs** (W1-T54) — a Dependabot PR is UNMERGEABLE today (nothing posts remudero-review on a
   non-task PR: fail-closed but frozen). A deterministic dep-review lane posts remudero-review + arms
   auto-merge for minor/patch, and ESCALATES majors (needs-human, no auto-merge). This is where MAJOR
   exclusion lives — in code, not Dependabot ignore-rules (§5 FLEET FINDING).
2. **Scanner alerts** (W1-T55 surface → W1-T56 triage) — code-scanning / Dependabot / secret-scanning
   alerts for the managed repo set land in the daily digest (counts + ages); new critical/high escalate.
3. **Repo ISSUES on MANAGED repos** (W1-T57) — open issues become feedback artifacts on a schedule,
   deduped, triaged; the digest carries an issues-reviewed count so "reviewed regularly" is a LEDGERED
   fact, not an intention.

**Alerts and issues are MACHINE-ORIGIN FEEDBACK** — they flow through the **§7B feedback inbox**
(`origin: alert#<id>` / `origin: issue#<n>`) and are triaged by `rmd triage` (W1-T41) into corrective
tasks, NOT a parallel loop. One inbox, one triage discipline, whatever the source.

**★ G-6 (operator standing decision):** remudero's OWN public issues stay **OFF** until WS-4. Flipping that
is the operator's call, not the harness's; W1-T57 covers issues on repos the harness MANAGES, not
remudero's own public tracker.

## 6. Open-source packaging

- **License**: Apache-2.0 (patent grant, enterprise-friendly). D-2.
- **Distribution**: npm — `npx remudero init` scaffolds `.remudero/` (config, principles.yaml, deny-floor
  hook, worker settings with zero ask rules) via a **first-run wizard**: tier auto-detect→confirm
  (§9 ladder), thinking posture, metering regime, quiet hours, permission profile, notifier, + optional fleet CI templates (claude-review + trusted-
  author auto-merge with base==main gate, ci-gate aggregator). Daemon: `remudero up` (launchd/systemd
  units generated). macOS + Linux; Windows via WSL note.
- **Config abstraction**: adapters for notify (ntfy/slack/discord/email/webhook/imessage), VCS
  (GitHub first; interface leaves room), model routing. No hardcoded accounts, ports, or paths.
- **Permission profiles**: `standard` (dontAsk + curated allowlist + deny-floor) — **OSS default**;
  `yolo` (bypassPermissions + deny-floor) — opt-in, documented with the honest tradeoffs. Craig's
  instance runs yolo. Shipping yolo as default would be indefensible for strangers' machines. D-4.
- **Auth stance**: works on Claude Code subscription OAuth today (programmatic usage draws from
  subscription limits; the separate Agent SDK credit pool was paused 2026-06-15 — re-verify at each
  release); API-key path documented for heavy/steady-state users. MeterGuard reads total_cost_usd
  per run regardless of billing mode.
- **Build-in-the-open hygiene (G-1)**: public from day 1 ⇒ LICENSE + README stub + .gitignore land
  in PR #1; instance specifics (accounts, hosts, protected-path lists, notifier config) live only in
  the gitignored `local/` overlay; committed docs and FINDINGS redact hostnames/IPs; secrets never
  enter the tree (PAT lives outside the repo); a leak-grep is part of spike acceptance.
- **Security disclosure**: honest README section — unattended agents + Bash = prompt-injection surface
  via deps/web; scoped fine-grained PAT per product (never account-wide login in workers); deny-floor
  is a tripwire, not a sandbox; pointer to OS sandboxing for the paranoid.
- **Positioning under platform risk**: if Anthropic ships native plan-stewardship, this project's
  provenance/verdicting/principles layer is deliberately user-land glue over Claude Code primitives —
  it rides platform improvements rather than competing with them; building in the open makes pivots
  legible rather than fatal.
- **Open-core stance (D-8)**: everything required to run the full loop locally — daemon, CLI,
  containment, principles engine, single-project control panel, MCP, retros/knowledge system, the
  public commons — is **Apache-2.0 forever**. Pro candidates (post-traction, not before WS-6):
  hosted relay/sync for mobile push without self-managed tailnet, multi-project portfolio views,
  team/multi-operator seats, hosted question inbox, **hosted org-brain sync** (private
  cross-project knowledge, §Self-improvement). Commitment for community trust: **nothing open ever
  moves behind the paywall**; Pro lives in a separate repo so DCO contributions to core never need
  relicensing.
- **Public support posture (G-6 RESOLVED)**: README carries a pre-alpha banner ("APIs and files
  change without notice; issues/PRs may not receive responses"); **Issues and Discussions OFF until
  WS-4**, then open with templates + DCO sign-off; CODEOWNERS from PR #1.
- **Dogfooding**: from WS-1 on, Remudero builds Remudero — this repo runs its own harness.
- **Out of scope v1**: non-GitHub forges, Windows-native, multi-tenant server, non-Claude agents.

## 6A. Open-source governance & the commercial boundary

Not legal advice; a qualified attorney reviews this before any money changes hands. Sourced from
open-core practice (OCV, TermsFeed, FINOS) 2026-07-14.

**Contribution model: DCO, not CLA — and the door is closed deliberately.** Open core does NOT
require a CLA: contributions to the core stay under Apache-2.0 and are never relicensed; only the
proprietary components need consolidated ownership. DCO is the low-friction, community-aligned norm
(GitLab moved CLA→DCO in 2017 under community pressure). **One-way door, accepted knowingly**: a DCO
likely cannot support a later relicense (its grant is tied to the license in effect at contribution
time), so the BSL/SSPL escape hatch Elastic/Redis/MongoDB used is CLOSED to us. That is the point —
each of those relicensings cost enormous trust, and D-8 already forbids paywalling anything open.
**We publish the never-relicense commitment as a CONTRACT (README + GOVERNANCE.md), not an internal
note.** Reversing this requires a CLA from day one; retrofitting is effectively impossible.

**No crippled core (named anti-pattern).** Best practice explicitly warns against withholding
essential features from the open version to manufacture paid dependency. **The open core must deliver
complete, uncompromised utility for its scope**: the full loop — daemon, CLI, containment, principles
engine, retros/knowledge, campaigns, single-project control panel, MCP, public commons — is free
forever. Pro may only ever be *hosted convenience* (relay/sync, portfolio views, team seats, org-brain
sync), never a capability amputated from core.

**Extension seam (ENGINEERING REQUIREMENT, WS-4 — currently missing).** Open-core designs need
abstraction layers so proprietary modules load/unload without destabilizing or forking the core.
Remudero's adapter boundaries — notifier, VCS, storage, auth/identity, model routing — become
**first-class plugin interfaces with a stable contract BEFORE any Pro code exists.** Pro must attach,
never fork. If Pro ever needs a core change, that change lands in core, open.

**Trademark is the control lever, not the license.** Apache-2.0 gives the code away; the NAME stays
ours and is the only real protection (cf. the WordPress/WP Engine dispute). Ship `TRADEMARK.md`
(what "Remudero" may/may not be used for); file the wordmark when there's traction. Domains already held.

**Governance: BDFL.** GOVERNANCE.md states it plainly — the roadmap is the maintainer's, PRs welcome,
CODEOWNERS enforces review. Prevents fork drama and sets honest expectations.

**Required doc set (WS-4)**: LICENSE (Apache-2.0) ✓ · NOTICE · CONTRIBUTING.md (DCO sign-off, one
concern per PR, proofs-as-acceptance) · CODE_OF_CONDUCT.md · **SECURITY.md — non-negotiable here**:
threat model (unattended agents + Bash + bypass; prompt-injection via deps/web/repo content), the
containment stack, and a private disclosure process · GOVERNANCE.md · TRADEMARK.md · CHANGELOG.md
(keep-a-changelog + semver) · issue/PR templates · third-party license inventory.

**Published promises (README, testable, not marketing):** no telemetry, ever — knowledge reaches the
commons ONLY via human-gated PRs · nothing open ever moves behind the paywall · operators run on
their own subscription per Anthropic's terms (one operator, one account, one machine; the harness is
a tool for your seat, not a seat-multiplier).

## 7A. The API contract is the product boundary

**This is the crux, and it is logically PRIOR to every client below.** Three clients (dashboard,
desktop, mobile) plus MCP all talk to one daemon; a daemon with no COMPILE-TIME contract lets them drift,
and three-clients-drifting-from-a-daemon is runtime breakage no gate catches. So the contract comes first.

- The daemon exposes **ONE tailnet service surface** — REST + SSE, single port, **bearer-scoped**
  (read vs. write). No client gets a private backdoor.
- **`packages/api-client` is GENERATED from that surface** and is the ONLY way any client talks to the
  daemon. **Generator choice: OpenAPI → typed client** (over hand-written TS types) — justification: the
  daemon is the single source of truth, OpenAPI is language-agnostic (a future non-TS client or an
  external integrator generates the same client), and the spec doubles as public API docs on the site
  (WS-12); TS-types-only would re-encode the surface by hand, the exact drift this section exists to kill.
- **Rules (each a CI-enforced or ADR-gated invariant):**
  - **No client may hand-roll a `fetch`** to the daemon — a grep gate fails the build (W3-T1).
  - **A breaking contract change must fail CI in EVERY consumer in the SAME PR** — this is the whole
    reason the clients live in one repo (D-5). Drift cannot ship.
  - **The contract is semver'd; a breaking change requires an ADR** (§5 Tier 3 discipline).
  - **MCP tools are a PROJECTION of the same contract, never a parallel API** — `plan.read`,
    `escalations.answer`, etc. call the api-client, not a second surface.
- **Rationale:** the plan already calls clients "stateless projections" (§7). This is what makes that
  true IN CODE rather than in prose — the projection is generated, versioned, and gated, so a client
  cannot silently diverge from the daemon it renders.

## 7. The control panel — ONE web app, three shells

**Every client here is a PROJECTION of the API contract (§7A) — no client talks to the daemon any other
way.** The panel is the operator's cockpit: see the plan; work the **human to-do list** (MANUAL queue
with check-off); answer the **question backlog** in batches (QUESTION contract, §2 — answers flow to the
Architect, corrective tasks auto-file when a shipped assumption was wrong); submit **feedback** the
Architect triages into plan edits/tasks; watch **fleet status** (per-worker state, current task, live
stream tails); **Pause/Resume** (drain-and-hold) and **STOP**; quiet-hours toggle; cost meter. Question
store: `plan/questions.ndjson` (durable, diffable), surfaced in clients + the daily digest count.

**ONE web app, three shells.** The panel is data-dense web (DAG, diffs, live stream tails, cost charts).
It is built ONCE as a web app; the **same web build is the SAME artifact in every shell**, wrapped three
ways:

- **SHELL 0 — browser (WS-5a → W3-T2).** The web app served by the daemon over Tailscale. Works on Mac
  AND phone **today**, zero new tooling. This is mobile posture **M0**.
- **SHELL 1 — Tauri macOS (W3-T3).** Wraps the same web build in a native shell: menu-bar presence,
  launch-at-login, native notifications, global hotkey, deep links. A **small delta** over shell 0 (the
  banked macOS one-liner, made real). Tauri binaries are **3–5 MB vs Electron ~150 MB** [research].
- **SHELL 2 — Tauri iOS (W3-T4, TIMEBOXED spike).** The same codebase again, rendered in **WKWebView**;
  App Store distribution; biometric unlock; deep links.

**Why not React Native / Expo for the panel:** the panel is web-native (DAG, diffs, live tails, charts)
and RNW fights all of it. **Expo is the DOCUMENTED FALLBACK for iOS** — Tauri's maintainers explicitly
say mobile is NOT a first-class citizen [research], so if the W3-T4 spike proves too rough, the operator's
deep Expo expertise makes the pivot cheap. **Trigger condition (a real fallback, not a footnote):** the
spike cannot get the web build running prompt-free on a device, OR App Store review rejects the WKWebView
shell ⇒ pivot the **iOS shell only** to Expo; shells 0 and 1 are unaffected.

**Push is an ADAPTER concern, not an APP concern.** Escalations already push via **GitHub-mobile (free,
today)**, ntfy, or iMessage (§8/WS-1). The app is for **ACTING** — answer, approve, STOP, watch — not for
alerting. This **decouples the app from the UNVERIFIED Tauri-APNs-remote-push question** [research]
entirely: no shell needs remote push to ship. **M1** (free at WS-1, before any shell exists): escalations
are GitHub issues ⇒ the GitHub mobile app already pushes them and accepts replies ⇒ remote
loop-continuation ships with the daemon MVP.

**Editing capability tiers** (orthogonal to the shells; whatever tier ships, all three shells inherit it):
- **read-only live board (WS-5a → W3-T2):** MASTER-PLAN render, task DAG with live states, worker stream
  tails (stream-json), DECISIONS feed, escalations inbox, question backlog, cost meter. Transport: daemon
  file-watch + SSE. Git stays the sole writer.
- **human-in-the-loop actions (W3-T5):** answer questions, approve MANUAL items, Pause/Resume/STOP,
  quiet-hours toggle — writes go through the api-client's write scope, ledgered with the panel's bearer.
- **in-UI plan editing (WS-5b):** single-writer, debounced plan-sync commits by the daemon; agents
  propose edits as plan-repo PRs rendered inline for one-click apply.
- **multi-writer (WS-6):** CRDT (Yjs) over the plan doc, checkpointed to git by the daemon (git remains
  truth). D-3 decides if it is worth it after living with in-UI editing.

**remudero-mcp (WS-6):** tools `plan.read`, `plan.propose_patch`, `task.add/update`, `runs.status`,
`escalations.list/answer` — a **projection of the same contract (§7A)**, never a parallel API. Exposed
over tailnet HTTPS → claude.ai custom connector; bearer token, read vs. write scopes.

## 7B. Feedback intake: the Architect's front door

Today the harness has **no front door**: every piece of operator feedback goes chat with an external
Architect → research → synthesis → a hand-pasted prompt → a plan PR. This is the last fully-manual loop.

**FEEDBACK IS AN ARTIFACT, NOT A COMMAND.** `plan/feedback/` is a durable, diffable inbox — one entry per
item: `{id, ts, raw text, attachments[] (multimodal — screenshots, terminal dumps, links), origin:
cli|ui|issue, status: new|grilling|proposed|accepted|rejected, proposal_pr}`. Captured async by
`rmd feedback` (W1-T40); never lost in a chat scrollback.

**THE INTAKE LOOP (`rmd triage`, W1-T41)** — an ARCHITECT worker, **HIGHER TIER than implement (G-17)**:
1. **GROUND** — grep the plan, learnings, ledger, and DECISIONS for what is ALREADY decided. Re-deciding a
   settled question is a failure mode, not a feature.
2. **RESEARCH** — server-side WebSearch for platform facts. This is what makes a proposal *grounded*
   rather than merely plausible.
3. **GRILL OR PROPOSE** —
   - **AMBIGUOUS ⇒ GRILL** (W1-T42). Interactive: `AskUserQuestion` at the terminal. Async: a `needs-human`
     GitHub issue with options + a recommendation — **reuse the existing escalation machinery (§4), do not
     invent a second one**. The grill is where the VALUE is; a triage that never asks anything is guessing.
   - **CLEAR ⇒ PROPOSE.** A plan-only PR naming which §sections change, which tasks are added/rewired, the
     rationale, and the **provenance back to the feedback id** (`origin: feedback#<id>`). Gated by
     `ci + remudero-review` like everything else.

**TOOL BOUNDARY (load-bearing):** the **Architect gets WebSearch/WebFetch; IMPLEMENT WORKERS NEVER DO** —
fetched content is a prompt-injection surface, and `claude-code-action` disables these by default for
exactly this reason [research]. WebSearch is server-side (Anthropic's), so the Architect researches
WITHOUT opening the sandbox's `allowedDomains`. The Architect's output is contained by the **same PR +
review gate** as any worker: it can **PROPOSE anything and MERGE nothing**.

**TRACEABILITY (`rmd trace`, W1-T43):** feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha,
renderable both ways (forward from a feedback id, reverse from a task id), off the `origin:`/`plan_refs`
metadata (Standing rule 17). **HONEST LIMIT, stated:** v1 triage is WEAKER than a research-heavy chat with
an external Architect. The measurable calibration metric is **what fraction of proposal PRs are accepted
UNCHANGED** — track it; strategy, contested calls, and deep research stay a human/chat path until that
number earns trust.

## 7C. Design Review (the visual/UX skill)

The one genuinely-MISSING capability: an **Architect-tier skill that validates and improves UI/UX**. It is
the ONLY skill permitted browser egress, and it runs under HARD CONSTRAINTS (from research, non-negotiable):

- **Dedicated sandbox profile.** Runs under its OWN sandbox whose `allowedDomains` EXPLICITLY allowlists the
  browser/target domains it needs; every NORMAL worker keeps the locked list (github.com / npm only).
  Browser egress is a per-skill grant, never global (§5B). Playwright needs a real browser with network
  egress, so this profile — and only this profile — widens the allowlist [research].
- **Accessibility-tree first; screenshots on demand.** Uses Playwright MCP **ACCESSIBILITY-TREE snapshots**
  (2–5 KB structured YAML) for structure/assertions — **10–100× cheaper** than screenshots (500 KB–2 MB
  images) [research]. SCREENSHOTS only for artifacts a HUMAN must eyeball, and gated (they blow up token
  usage — request "only when necessary"). MCP is the SANDBOXED-client path; the Playwright CLI's compact
  YAML snapshots would be cheaper still but REQUIRE shell access, so MCP is chosen.
- **`browser_run_code_unsafe` is HARD-DENIED.** It runs arbitrary JS in the Playwright server —
  **RCE-equivalent, "only for trusted MCP clients,"** and a bypass-mode worker is not that [research].
- **Capabilities:** run Playwright E2E / visual flows, capture screenshots as PR artifacts, audit against
  WCAG/a11y + responsive breakpoints, research reference designs (WebSearch), and act as an expert UI/UX
  reviewer proposing concrete diffs. **Output:** a design-review report + screenshots ON THE PR; it
  PROPOSES, the gate DECIDES.
- **Human-eye verdicts route to `verify: human`** — the games' draft → playtest → ready flow: anything that
  needs a human to LOOK is not auto-verifiable. (W3-T7.)

## 8. Security posture (consolidated)

Worker credential = fine-grained PAT scoped to the product's repos, via GH_TOKEN env only. No MCP in
workers. Deny-floor hook always installed (removable, on the owner's head): the repo ships a
**generic floor** (force-push to default branch, `gh auth` mutation, probe path) and appends the
operator's concrete protected-path list from gitignored `local/deny.local` at runtime — instance
specifics never live in the public tree. Hooks <1s. Craig overlay (`local/INSTANCE.md`, untracked):
agent accounts, mini paths, protected list, notifier wiring; other resident automation stays fully
out of Remudero's process tree, plain `claude` CLI auth only. **Per-project secrets (WS-2/3
forward design)**: products under management will need runtime secrets (test API keys, service
tokens) — these live per-project in `local/secrets/<project>.env`, globally denyRead'd, injected by
the control plane ONLY into that project's workers, never cross-project. **Terms note (README)**:
operators run the harness on their own subscription per Anthropic's terms — one operator, one
account, one machine; the harness is a tool for your seat, not a seat-multiplier.

## 8A. Knowledge architecture & context economy

W1-T19 shipped the READ side of the compounding loop, which makes the knowledge ARCHITECTURE
load-bearing. The governing principle [research, Anthropic "Effective context engineering"]: **find the
smallest set of high-signal tokens that maximize the likelihood of the desired outcome** — context is a
precious, finite resource, not a place to dump everything we know. Knowledge is a MEMORY HIERARCHY, not a
file:

- **TIER 0 — ALWAYS-ON, STABLE PREFIX.** The Promptsmith preamble + invariant rules (distrust-the-prompt,
  autonomy clause, the deny-floor facts). **Line-capped (~150)** and it must change RARELY — every edit
  busts the prompt cache for every worker rendered after it (see the ordering rule).
- **TIER 1 — MATCHED INJECTION (deterministic, just-in-time).** Learnings matched by `subsystem:`/`files:`
  tags (`src/lib/learnings.ts`), under the knowledge budget. VOLATILE (the corpus grows every retro) ⇒ it
  goes **LAST** in the prompt, never early.
- **TIER 2 — RETRIEVED, NOT INJECTED.** The plan is ~900 lines and growing; it is **NOT shipped to
  workers**. Inject a **PLAN INDEX** (section headings + one-line summaries + where to grep). Workers have
  grep/glob — this is Claude Code's OWN hybrid model (CLAUDE.md up front + glob/grep for retrieval), which
  "bypasses the issues of stale indexing" [research]. W1-T37 builds it.
- **TIER 3 — RUN-LOCAL, NEVER PERSISTED.** Recon output, transcripts — externalized to the ledger/scratch,
  never promoted into Tier 0/1.

**ORDERING RULE (cache-aware): STABLE FIRST, VOLATILE LAST.** Caches key on EXACT PREFIX BYTES — any edit
early in the context invalidates the cache for everything after it, and cache reads price at ~1/10th of
fresh input [research]. So the stable prefix (Tier 0) leads and the volatile matched-learnings (Tier 1)
trail. This is now **MEASURABLE, not a matter of opinion**: the result envelope already carries
`cache_read_input_tokens` + `cache_creation_input_tokens` (WS-0) — ledger them, and **near-zero cache
reads on the second worker of a run means the ordering is wrong** (W1-T35).

★ THE MEMORY MODEL, NAMED (2026 taxonomy alignment). The Sec 8A tiers ARE the field-standard four memory types [research: coala, agent-memory-survey-2026], which clarifies where each lives and where the gaps are: EPISODIC = the NDJSON ledger + transcript archive (what happened, when, with what verdict); SEMANTIC = LEARNINGS (what is generally true); PROCEDURAL = prompt templates + the Sec 5B skill registry + campaigns (how to do X); WORKING = the run-local Tier-3 context (never persisted). The load-bearing loop the field calls CONSOLIDATION (episodic->semantic — 'without it agents recall but do not LEARN') is Remudero's RETRO, which already enforces the field's key discipline: the WRITE PATH goes THROUGH consolidation, never direct semantic writes from the worker loop (learnings are Architect-gated, rule 15). The gaps this taxonomy exposes are now proposals: measure whether semantic memory helps (P12, the Wipe Test), distill procedural memory from SUCCESS not only failure (P13), detect contradiction on consolidation (P14).

## 8B. Compaction doctrine

Compaction is a **SAFETY NET, never a strategy** — one-concern sessions should END before it matters
(§8A, §9). But it WILL fire (observed mean 19.8 turns, tasks at 36+), and today we do not even MEASURE
it, so a silently-degraded worker is indistinguishable from a good one. Compaction's sharp failure mode
[research]: **a summary that drops a critical fact is worse than no summary, because later steps trust it
and cannot recover what was lost** — a compacted message is removed from the window and recoverable ONLY
if it was STORED. Therefore, tuned for RECALL first, then precision:

- **DETECT + LEDGER every compaction event.** A run that compacted is flagged **QUALITY-SUSPECT** and its
  acceptance proofs are re-verified by the reviewer against REPO STATE (W1-T3F made that possible) — not
  trusted from a possibly-lossy REPORT (W1-T36).
- **ANCHORED SUMMARIZATION.** The task goal, acceptance criteria, and hard constraints are re-injected
  **VERBATIM** after any compaction — never handed to a summarizer, never paraphrased.
- **WRITE-BEFORE-COMPACT.** Workers externalize durable findings to a worktree scratch file **AS THEY
  GO**, not only in the final REPORT — a fact discovered at turn 5 must survive a compaction at turn 30.

## 9. Resource doctrine — mounts, windows & context

**Mounts — model selection is the remudero's core act.** `.remudero/mounts.yaml` is a
DETERMINISTIC policy table (no per-call LLM judgment): keyed by (task_type × risk × operator
thinking level) → {model, effort/thinking budget, max_turns, context_budget}. Operator params
(`subscription`, `thinking_default`, `metering: shared_pool|programmatic_credit|api_key` —
regime-proof; the June-15 walkback proved metering volatility — quiet-hours, permission profile,
notifier) are
**per-instance config, gathered by the first-run setup** — `rmd init` wizard v0, dashboard
Settings pane later — never plan constants. **Tier auto-discovery ladder (detect → confirm, never
silent)**: (1) parse headless `/status`–`/usage` output if machine-readable; (2) local account
metadata the CLI exposes, if any (spike-probed, not assumed); (3) **passive inference by the
HeadroomTracker** — observed limit magnitudes and the presence of dual weekly caps distinguish
tiers over time; (4) wizard asks, pre-filled with the best guess. Whatever is detected, the wizard
shows it for confirmation. Craig instance: `max20x`, `thinking_default: medium` (G-12/G-13).
Defaults encode the official guidance: **Sonnet default for execution; Opus on the bookends**
(Architect planning, DIAGNOSE workers, high-risk reviews); **Haiku for mechanical/high-volume**
(classification, doc-sync, campaign chores). Model-aware strike ladder: routine retries do NOT
auto-upgrade; **diagnose steps UP** — intelligence is spent where evidence-gathering pays.
Per-repo priors live in principles.yaml (a gnarly C# repo can default Sonnet-high-thinking; a docs
repo, Haiku).

**The Tier Invariant (G-17, Craig directive)**: the main agent ALWAYS rides a higher-thinking
mount than the coding agents — it reasons through the plan and orchestrates, so
`architect.tier > max(worker.tier)` and `architect.effort ≥ thinking_default` (floor: high for
plan authorship). This is a **config-validation rule, deterministically enforced**: a mounts.yaml
that violates it is rejected at load, and flywheel-proposed downgrades may lower workers freely but
can NEVER lower the Architect to or below the worker ceiling. The invariant is RELATIVE, not
absolute — an economy install may run Haiku workers under a Sonnet Architect and still comply; the
model-tier ordering table is config-maintained since the lineup shifts.

**Routing is knowledge — golden-calibrated.** mounts.yaml changes ship as PRs behind the golden
suite like every other knowledge change. The flywheel proposes DOWNGRADES when a cheaper mount
passes a task-type's goldens above threshold, and UPGRADES when strike-rate correlates with mount —
the harness learns which horse each job actually needs, with pre-merge proof it still clears the
jumps.

**Cost semantics (CORRECTED by WS-0)**: on subscription, `total_cost_usd` is NOTIONAL — it is the
API-equivalent price, not billed spend. It is therefore used for exactly two things: the
runaway-anomaly tripwire, and metering when `billing_mode == api`. **Subscription window tracking
parses `/usage`** (confirmed machine-readable headless).

**A per-task dollar cap is a BUG DETECTOR, not a budget.** `budget_usd` (and the per-spawn
`maxBudgetUsd` it feeds) exists to catch a worker in a LOOP, not to ration honest work. Setting it near
a task's expected cost converts a tripwire into a WORK LIMIT and destroys honest work — **observed twice:
`maxTurns` (18 vs. ~36 needed, PR #8) and `budget_usd` (W1-T3 killed `blocked_budget` at $3.57/36 turns
against a GUESSED $4 cap while still working)**. Same bug, one field over. So: caps sit an ORDER OF
MAGNITUDE above any observed cost (default $100), a SOFT threshold (default $25, config-tunable) only
LEDGERS A WARNING and continues — anomalies VISIBLE without being FATAL — and `blocked_budget` now means
"this worker is almost certainly looping," which is what a tripwire should mean. Window pressure (the
real limit) is the HeadroomTracker's job (W1-T4), never a per-task dollar cap. Do not lower these caps to
"save money": on subscription the dollars are notional, so you would kill good work and save nothing.
`max_turns` is now re-based to the SAME tripwire semantics as `budget_usd` — a flat 400 in EVERY ROW of
`.remudero/mounts.yaml`, an order of magnitude above the calibration mean (~45–55 turns; honest merges at
58–69) after run `W1-T54b-1784149952116` walled at 81/80 mid-live-campaign — and this is P7-consistent:
nothing is raised to mask over-scoping, because task SIZING is enforced pre-dispatch by the W1-T20c linter
(the sizer is the linter), not by a low turn cap. **★ HONEST LIMIT (R4/P10, closed by W1-T63) — "flat 400"
governs MOUNT-GOVERNED phases only, and that is NOT every worker.** MOUNT-GOVERNED phases resolve
`{model, effort, max_turns, context_budget}` from `.remudero/mounts.yaml` via `resolveMount(task_type, risk)`
— never a hardcoded literal: `implement` (`run-task.ts` initial + DECISION_REQUEST-resume spawns) and, as of
W1-T63, `reviewer` (the fresh advisory reviewer `runReview()` spawns for the review gate on ANY task's PR)
and the `fix`/`diagnose` routes (`diagnose` also serves a plan task whose own type is `diagnose`; `fix` is
reserved for classify.ts's `runDiagnoseThenRetry`, W1-T7 — designed but not yet wired to a live spawn, so it
has nothing to key off TODAY, but the row exists so wiring it can never reintroduce an undeclared literal).
DELIBERATELY-BOUNDED phases are a literal outside mounts.yaml's reach BY DESIGN, and each is NAMED in its own
comment: recon's `maxTurns: 8` (`run-task.ts:958` — read-only + tightly scoped) and the containment probe's
`maxTurns: 6` (`containment.ts:122` — a once-per-run preflight, not task work). Before W1-T63 the fresh
reviewer spawn was a THIRD, UNDECLARED kind — a hardcoded 12-turn cap with no model/effort override at all —
and mounts.yaml had no `reviewer` row to key off even if it had asked; three of R4's ten runs walled
`error_max_turns` on it, so `remudero-review` silently fell to its mechanical floor on every substantive code
PR (P10-a). `review.posted` now also carries `reviewer_outcome` (the reviewer's terminal subtype, or
`not_attempted`/`spawn_error`), surfaced in the ledger and the console summary, so a floor-only PASS is
LEGIBLE and never byte-identical to a review the reviewer actually completed. The retro command's Architect
spawn (`run-task.ts:1564`, `maxTurns: 40`) is a SEPARATE bookend case — it rides the Architect mount
directly (`model: arch`), not a worker route — and is out of this paragraph's scope.

**Windows — the HeadroomTracker (rung 1 CONFIRMED).** Models both clocks: the 5-hour rolling window and the weekly
caps (including Max's dual weekly limits — all-models and Sonnet-only — with separate resets).
PRIMARY: parse `claude -p "/usage"` — session % + dual weekly windows + reset timestamps, all
machine-readable (WS-0 proven). Parse the weekly label as data (it names a MODEL; the lineup shifts).
Secondary: passive limit-hit parsing; `~/.claude.json` keys for tier inference (rung 2).
`/status` is unavailable headless — do not build on it. Scheduler behaviors it drives: **quiet-hours is now an OPTIONAL wizard toggle, default OFF**
(Craig, Q1/G-14: he expects to work mostly THROUGH the fleet, so interactive contention is managed
live via the control panel's Pause, not a schedule); **throttle → cheap-groom** (approaching a cap,
the fleet does NOT idle — it drains Haiku-class chores: doc-sync, triage, campaign recon);
**burst-at-reset** (queue depth + imminent window reset ⇒ heavy work scheduled to the reset);
weekly-aware pacing (Opus-hungry campaigns early in a weekly window get budgeted so Friday isn't
starved). Runaway tripwire, per-task attempt caps, and the OSS daily-cap default all stand.

**Env sanitization — the billing boundary (FIELD FINDING 1).** Worker environments are
**constructed, never inherited**: the control plane builds each child env from an explicit
allowlist (PATH, HOME, TMPDIR, GH_TOKEN, project vars) and **strips all ANTHROPIC_\* variables** so
Claude Code falls back to the operator's subscription OAuth. The API key is injected ONLY when the
overflow valve is deliberately engaged. `billing_mode` is therefore a decision the harness makes
and records, never an accident it inherits — and the daemon asserts at startup that its own env is
clean (a `launchctl setenv` key would otherwise leak in). **Conditional cap guard**: `no dollar
cap` (G-3) is VALID ONLY while `billing_mode == subscription`; any run in `api` mode is hard-capped
by the daily cap regardless of operator settings. Config validation rejects
`overflow: api_key` + `daily_cap: none`.

**Overflow valve** (operator opt-in): `overflow: none|api_key` — when subscription windows are
exhausted and priority ≥ threshold tasks are queued, those runs route via ANTHROPIC_API_KEY at
metered rates while cheap work waits for reset. Every ledger line carries `billing_mode`.

**Context doctrine — architecture first, compaction as safety net.** The harness's primary context
strategy is structural: fresh, scoped, one-concern sessions with all durable state external in
git + ledger — sessions should END before compaction matters; auto-compaction (with CLAUDE.md
re-read) is the net, not the plan. Promptsmith style rules, enforced in templates: reference bare
paths, never @-injection (which pulls the whole file + its CLAUDE.md tree); batch related
instructions into one turn; recon-before-implement stands in for plan-mode. **Context telemetry**:
per-turn token usage from stream-json lands in the ledger → a **context-budget ratchet** per task
template (breach files an improvement task; the 200K 2×-billing cliff is a hard ceiling). Exact
resource knobs on the installed version — effort levels, thinking toggles/budgets, max_turns,
auto-compact settings — are spike step-5 probe targets (v4.1), recorded as ground truth in
FINDINGS, never assumed from docs-of-the-week. NDJSON ledger meters everything regardless of
billing mode: spawn/end, model, effort, tokens, total_cost_usd, billing_mode, verdicts, decisions —
**including brain-plane calls** (Architect/Promptsmith invocations log purpose, model, tokens,
cost as first-class ledger citizens; the orchestrator's own spend is never invisible).
Craig instance (G-3): no daily dollar cap — pace to Max limits via the tracker.

## Self-improvement: flywheel, retros, knowledge & the commons

The mechanism behind L3, the answer to "verdicting is where this succeeds or dies," and — per
Craig's directive — the thing that makes every project on this harness self-improving, with a path
to a shared brain across all of them:

- **Flywheel analyzer** (nightly, Haiku/Sonnet): reads the run ledger + task transcripts, mines for
  patterns — repeated transient causes, prompts that needed fix rounds, gates that never fire,
  reviewer misses (merged PRs later reverted/re-fixed) — and files evidence-cited improvement tasks
  into Remudero's own tasks.yaml. Same shape as the ClawApp SRE flywheel (analyze-diagnostics →
  suggestions inbox), pointed at the harness itself. Suppression rules from day one (stale-error
  maps, fingerprint reuse guards — the analyze-diagnostics lessons apply verbatim).
- **LEARNINGS.md per target repo**: diagnose workers and reviewers append durable lessons in place
  ("App Insights pinned 2.22.0 — 3.1.2 crashed startup"-class facts). The Promptsmith injects
  matching entries into prompts as first-class provenance sources (`[src: learnings#…]`). This is
  "the repo remembers its outages in place," made machine-readable.
- **Transcript archive + predecessor query**: every worker session transcript is archived per task;
  fix/diagnose workers may read their predecessors' transcripts before acting (Gas Town's "seance"
  pattern, done as plain files — no daemon mysticism required).
- **Golden-task eval suite**: a set of canned tasks on the sandbox repo with known-good outcomes
  (including planted violations: TDD skip, scope creep, test theater, provenance-free prompt).
  CI runs the proto-runner/daemon against them on every Remudero PR; measures loop completion,
  verdict accuracy (planted violations caught?), cost per task. Regressions in the harness's
  judgment become red CI, not vibes. This is mutation-testing discipline applied to the orchestrator.
- **Verdict calibration**: reviewer verdicts log confidence + rubric scores; a periodic job compares
  them against post-merge reality (revert rate, follow-up-fix rate within N days) and files tuning
  tasks when calibration drifts.

**Retro ceremony (scheduled, not just reactive)**: at every workstream close + a weekly patrol,
the Architect runs a structured retro over the ledger, transcripts, DECISIONS, questions/answers,
and verdict-calibration data. Outputs are always artifacts, never vibes: LEARNINGS.md updates,
**CLAUDE.md / agents-file / prompt-template diffs as PRs**, principles-profile tuning proposals,
new golden tasks minted from real failures, and campaign proposals (§3A) when a finding spans
repos. Retros must also DELETE — compression is a deliverable, not just accretion.

**RATIFY-OR-KILL (standing duty, from P8):** every retro RE-GRADES every open proposal to exactly one of
**ratified** (minted as a tasks.yaml task — cite the id) | **re-ranked** (still open, priority restated
against new data) | **retired** (superseded/deleted, with the reason). The status is written INTO the
proposals section, so the list can never become a graveyard. **An unranked proposal that survives TWO
retros is itself a plan-health flag** (a W1-T20d input) — an unratified proposal is not neutral backlog,
it decays, and the failure it predicted recurs (P3→P8: `blocked_review` fired again a full retro after
P3 proposed a guard for it).

**HARNESS-COMPRESSION (a required retro item):** *"Which guards are now unnecessary? Which prompts are
over-prescriptive?"* Harnesses encode assumptions about what Claude cannot do on its own, and **those
assumptions go stale as models improve** [research] — a guard that was load-bearing at one model version
can become dead weight (or an active constraint) at the next. So a retro that only ADDS guards is failing
the same bar as a retro that only ADDS docs: it must also question and retire the harness's own scaffolding,
not just the plan's prose. Retire behind the golden suite (a removed guard that regresses a planted-violation
catch goes red before it merges), same RSI-safety rule as any other self-modification.

**Knowledge system (the RSI-safety rule)**: knowledge and prompt changes ARE CODE. Every CLAUDE.md,
agents-file, prompt-template, and principles edit ships as a PR, git-versioned (rollback = revert),
and **gated behind the golden-task suite** — a prompt change that regresses a planted-violation
catch or loop completion goes red before it can poison the fleet. This is the piece most
self-improving setups skip: without versioning + pre-merge signal, a bad self-modification has no
recovery path and no alarm. Budgets enforce "short and alive": CLAUDE.md line cap (default ~150,
gated), LEARNINGS entries carry provenance + last-cited date and get compressed/pruned on retro
(the analyze-diagnostics pruning discipline, applied to knowledge). Injection stays
provenance-clean: `[src: learnings#… | claude-md#… | commons#…]`.

**The Commons (universal brain — WS-11)**: a layered knowledge hierarchy the Promptsmith reads
nearest-first: **project** (LEARNINGS.md, CLAUDE.md) → **org brain** (operator's private
cross-project store) → **commons** (public remudero-commons repo shipped with the harness).
A DISTILL pass classifies retro learnings: project-private stays put; **universal candidates**
(tech facts, platform gotchas, pattern fixes — "App Insights 3.1.2 crashes isolated workers"-class)
are proposed upward as **skill-shaped packages** via human-gated PRs — never telemetry, never
auto-upload; the operator reviews every outbound distillation. Contribution to the public commons
is the community mechanism; **hosted org-brain sync** joins the Pro candidate list (§6/D-8).

Prior-art note: this is "compounding engineering" made governable — the ecosystem pattern (codify
decisions into CLAUDE.md/AGENTS.md so each unit of work makes the next easier; skills as
cross-project procedural memory) plus the two pieces the ecosystem's own literature says are
usually missing: versioned rollback and pre-merge evaluation of self-modifications. External-ledger
task tracking for long-running agents remains the documented direction (Anthropic Nov-2025;
Beads 23k★). Remudero's bet is unchanged and now closed-loop: **small worker counts, hard verdicts,
plan-first — and a harness that provably gets better at its own job.**

---

## 10. Workstreams

**WS-0 — Spike — ✅ SHIPPED & MERGED** (PR #1; see SHIPPED log). Ground truth in FIELD FINDING 10;
`src/lib/` kept spike-free ⇒ WS-1 lifted it directly.

**WS-1 — Proto-runner → daemon — ✅ SHIPPED & COMPLETE 2026-07-15.** G-2 held: WS-1 built itself THROUGH
the proto-runner, daemonization last. Acceptance MET far past the "≥6 tasks merged via `rmd run-task`"
bar. **Full inventory, the two honest deltas (bounded drill, no digest capture), and the residue that
belongs to WS-7 are stated ONCE in NET STATE — not restated here** (they were duplicated near-verbatim in
both places for two retros). **The "remainder scoped here and NOT shipped" list is DELETED — it is now
EMPTY:** flight control (W1-T20–T22) shipped R7, the retro plan-health sweep (W1-T20d) shipped #140, the
knowledge holes (W1-T33–T40) drained R8, and mounts.yaml v0 (W1-T5) shipped #42. Only §5C's linter CODE
(W1-T20c) is still queued, and NET STATE already says so.

**WS-2 — Flow & quality**: reviewer worker + rubric; provenance linter hardened; N-concurrent
worktrees with per-repo caps + **N per-worker isolated HOMES** — the singleton <root>/worker-home (W1-T18/#100/#102) does NOT survive concurrency; every concurrent worker needs its own worker-home-<runId> with its own empty rc + its own login.keychain-db / .claude / .config/gh symlinks. A shared home races on rc materialization and the keychain grant. VALIDATE at build: N workers symlinked to the one real login.keychain-db — securityd gates per-item by code identity, but confirm concurrent authentication does not serialize on keychain lock contention. + **merge serialization per repo** (Bors-style: never two auto-merges
racing one main); **task heartbeats + stall detection** (no ledger output in N min ⇒ classify hung,
kill, transient-retry); stuck-PR shepherd (absorbs/retires pr-pipeline.sh); rate-limit-aware
dispatch governor; scope guard (diff/files budget); first fleet-repo target (wild-trails backlog).
Acceptance: two tasks run concurrently, one induced conflict auto-resolves, one induced hang is
detected and recycled; proof = ledger timeline.

★ PARALLELISM GRANULARITY (grounded — 2026 field consensus + arxiv, Architect 2026-07-16): parallelize INDEPENDENT TASKS (the DAG), NEVER one task's implementation across sub-agents. Git-worktree-per-task isolation is the industry+research standard, but the hard lesson is that worktrees solve FILE collisions, not DEPENDENCY/SEMANTIC conflicts — agents editing related files under incompatible assumptions produce errors that only surface AT INTEGRATION. What makes parallelism safe is HIERARCHICAL TASK DECOMPOSITION (our depends_on DAG), not the concurrency mechanism: independent DAG nodes run concurrent; dependent ones SEQUENCE. A 2026 result (Glite ARF) mirrors this — 12 task-worktrees parallel on one 48GB Mac, zero merge conflicts reaching main, parallelism at TASK granularity NOT agent-granularity-inside-one-problem. This VINDICATES the 'small worker counts, hard verdicts, plan-first' bet and sets its shape: fan out cheap Sonnet workers across independent tasks (mounts already routes implement→sonnet), bounded by the rate-limit-aware governor + headroom, merge-serialized per repo. Intra-task sub-agents are acceptable ONLY for read-heavy recon (additive outputs), never for splitting an implementation. PREREQUISITE: the concurrent drainer depends on the block-reasoner (W1-T46) — until 'one blocked task doesn't stall the independent others' exists, drain-v1 stop-on-block makes concurrency pointless.

**WS-3 — Principles engine**: principles.yaml loader; TDD Guard integration + red→green REPORT
proof; coverage ratchet + jscpd + dependency-cruiser CI templates; auto-filed refactor tasks;
reviewer rubric wired to profile. Acceptance: a `tdd: strict` task is BLOCKED when implementation
precedes a failing test (planted violation), passes when honest; proof = hook denial + green run.

**WS-4 — OSS packaging**: rename executed (D-1); Apache-2.0; `npx remudero init`; adapters; permission
profiles with `standard` default; README + security disclosure + quickstart (<5 min to first looped
PR on a toy repo); CI templates published. **Setup Agent (Q3/G-16)**: the wizard's WS-4 evolution —
an agentic onboarding session that interviews the new operator, **walks through public-vs-private
repo pros and cons** (G-1 was Craig's answer, never the shipped default — the Setup Agent counsels
and the operator chooses), then EXECUTES as much setup as possible via sub-agents: repo creation
through gh (**org-aware; explicitly sets allow_auto_merge, delete_branch_on_merge, and secret
scanning + push protection — fresh-repo defaults break agent pipelines, FIELD FINDING 8**),
plan-repo scaffold, CI templates, hooks/settings install, root layout, first golden run; PAT minting stays MANUAL with guided deep-links (credentials are never agent-handled).
**The project website is now its OWN workstream, WS-12** (repo `remudero-site` — separate cadence and
audience, D-5): it must not couple to the daemon's CI. Its quickstart is still the WS-4 acceptance bar
(clean machine → first auto-merged PR).

**WS-5 — UI**: v0 live board (SSE); v1 in-UI editing + agent proposals as PRs. Port audited (18793
taken on Craig's mini). Acceptance v0: watching a live run shows state flips within 2s of ledger
writes; proof = timestamp diff.

**WS-6 — Collaboration**: remudero-mcp server + scoped tokens; claude.ai custom-connector runbook;
CRDT co-editing spike (D-3 gate). Acceptance: an external Claude session reads the plan and files a
proposal PR through the connector; proof = PR authored via MCP path.

**WS-7 — Hardening**: chaos drills (kill worker mid-run, daemon restart mid-loop, network flap,
**reboot-resilience: does the LaunchAgent load and OAuth still authenticate after a cold boot with
no console login? — FIELD FINDING 4 residual**);
explicit supervision chain (launchd restarts daemon → daemon supervises workers via heartbeats →
freshness sentinel watches the daemon — who-watches-whom is documented, no unwatched layer);
worktree/disk GC watchdog; restart-recovery test is a required CI job; **nightly $ROOT/state
backup** (ledger + calibration data are irreplaceable history; git+GitHub already cover the rest)
with a **documented + drilled restore** (fresh machine → clone + rmd init + restore = fleet back);
**Claude Code CLI version is pinned config, not ambient** — a release watcher files platform-bump
tasks, and version bumps ship behind the golden suite like any other change (the platform itself is
a gated dependency; every knob we probed varies by version). Acceptance: daemon killed mid-task
recovers to correct state from git+GitHub alone; restore drill executed once from backup.

**WS-8 — Flywheel, retros & evals**: golden-task suite in CI from the proto-runner era onward.
**★ GOLDENS SPLIT BY EXECUTION SURFACE (rule-20 sweep):** CI-RUN goldens are FIXTURE-only (no LLM, no
subscription OAuth — GitHub Actions has none, and a self-hosted runner on a PUBLIC repo is a security
anti-pattern); anything needing a REAL worker/daemon run is a DAEMON-RUN LIVE golden, executed by the
self-hosting daemon on a SCHEDULE (its own Max-subscription host) which posts a commit STATUS via `gh`
back to the PR/commit. The CI job never spawns a worker; the daemon is the only thing that holds the
billing boundary. This split governs every golden below.
(The suite grows with each workstream, and with every real failure minted into a golden); nightly flywheel
analyzer + suppression rules; **retro ceremony** (workstream-close + weekly patrol) producing
LEARNINGS updates AND agents-file/prompt-template PRs; **knowledge budgets gate** (CLAUDE.md line
cap ~150 default, LEARNINGS provenance + last-cited pruning); **prompt/knowledge-changes-behind-
goldens** enforced in CI; LEARNINGS.md pipeline + Promptsmith injection; transcript archive +
predecessor query; verdict-calibration job **+ mount-routing calibration** (golden-backed
downgrade/upgrade proposals for mounts.yaml, filed as retro PRs); DISTILL classifier stub. Acceptance: planted TDD-skip
golden caught in CI; seeded ledger pattern → exactly one evidence-cited improvement task (no dupes
on rerun); ★ a deliberately-degraded prompt-template PR goes RED on the golden suite before merge;
one retro produces a net-negative diff somewhere (compression proven); proofs = CI runs + diffs.

**WS-9 — Mobile**: RESHAPED — mobile is now **shell 2 of the one-web-app control panel** (§7), delivered
as the Tauri iOS spike **W3-T4** over the generated api-client (§7A), NOT a separate client. Baseline
regardless of shell: responsive dashboard verified on phone over tailnet (M0, shell 0); **push is an
adapter concern, not an app concern** (GitHub-mobile today; no shell needs remote push to ship);
remote STOP + escalation-answer + quiet-hours toggle land as W3-T5. Expo is the documented iOS fallback
with a named trigger (§7). Acceptance: from a phone off the home network (tailnet up), answer one
escalation and STOP one running loop; proof = ledger entries originating from the client's bearer token.

**WS-10 — Campaigns**: campaign spec loader + Architect instantiation; v1 catalog (§3A); baseline
capture from ledger/CI; standing/scheduled/retro-filed triggers wired to idle-groom + quiet-hours.
Acceptance: a coverage-raise campaign across remudero + remudero-sandbox lands per-repo PRs whose
merged deltas meet the formula; proof = baseline-vs-after ledger lines + merged PRs.

**WS-11 — The Commons (universal brain)**: knowledge-hierarchy loader (project → org → commons,
nearest wins, provenance-tagged injection); DISTILL flow with human-gated outbound PRs to the
public remudero-commons repo; skills-shaped packaging. Acceptance: a universal learning distilled
from remudero's own retros lands in commons via a reviewed PR and is cited by a worker prompt in a
second project; proof = provenance chain across two ledgers.

**WS-12 — Website** (repo `remudero-site`, SEPARATE from core — D-5): **Astro Starlight on Vercel**
(fleet pattern). It **PUBLISHES the repo's CANONICAL docs, never a second copy** (§12A "one source, three
surfaces"): the **GENERATED CLI reference** (Tier A, from the command registry — W1-T48) · the
**GENERATED API reference** (from the §7A OpenAPI surface) · the **rendered Tier-B guides** (concept,
architecture, operator, troubleshooting, security/limitations) · **LEARNINGS.md as a public artifact**
(nobody else ships the receipts — the differentiator) · landing (the anti-slop thesis) · **<5-min
quickstart** · CONTRIBUTING / GOVERNANCE / TRADEMARK. **Nothing on the site is authored twice** — a
hand-edit to a generated page is rejected by the drift gate (W1-T49). Repo creation is MANUAL (credentials
never agent-handled); post-L2 the site's content maintenance becomes a **harness-run task** (the site is
dogfood too — W12-T1). Acceptance: the site builds and deploys, and its quickstart takes a clean machine to
a first auto-merged PR; proof = deploy URL + the quickstart transcript.

**Client workstream (W3 — the API contract + the three shells)**: `packages/api-client` is generated from
the daemon surface (§7A) and **BLOCKS every client** (W3-T1); the dashboard (shell 0, W3-T2), Tauri macOS
(shell 1, W3-T3), Tauri iOS spike (shell 2, W3-T4), and human-in-the-loop panel actions (W3-T5) all
consume ONLY the api-client. Nothing client-side starts before the contract lands.

Dependencies: WS-0 → WS-1 → {WS-2, WS-3} → WS-4 → WS-5 → WS-6; WS-7 threads from WS-1 onward;
WS-8 seeds at WS-0 (goldens), retro ceremony activates at WS-1, completes after WS-2; **W3 (clients)
gate on W3-T1 (the api-client contract) → W3-T2 → {W3-T3 → W3-T4, W3-T5}**; WS-9 M1 lands free with
WS-1, M0 with WS-5a/W3-T2, mobile shell = W3-T4; WS-10 after {WS-2, WS-8 baselines}; WS-11 after WS-4 +
a second project on the harness; **WS-12 (site) is independent — separate repo, separate cadence**.

## 11. Open decisions

- **D-1 Name — CLOSED 2026-07-14: Remudero (domains purchased)**. The remudero is the wrangler in
  charge of the remuda — the orchestrator's own job title, and a recovery of the remuda concept one
  level up. Alias `rmd`; binary `remudero` with `rmd` symlink. Full saga: drover (registries +
  cloud-shuttle same-space) → foreman (npm + Red Hat) → millwright/gaffer (npm + GafferHQ) →
  overlander (domains) → remuda (domains) → millrace (FATAL: 65★ governed-agentic-loops runtime) →
  nightmuster (registrar-verified .com, superseded on pick) → **Remudero**. Method that closed it:
  container DNS screening across .dev/.io/.com/.sh, retro-validated against both registrar failures,
  with .com-NXDOMAIN demoted to weak signal and finalists restricted to zero-footprint compounds
  (0 GitHub repos, no packages on any registry, no web presence). Evidence trail: git history of
  this line. G-10 bar for the record: .dev+.io(+.sh) suffices, .com nice-to-have — moot; purchased.
- **D-2 License — RESOLVED**: Apache-2.0 (patent grant; ships in PR #1). Veto window: before the
  spike PR merges.
- **D-3 Plan co-editing tech**: CRDT (Yjs) vs PR-proposals-only. Defer until v1 UI is lived-in (rec).
- **D-4 OSS default permission profile**: `standard` (rec). Craig's instance: `yolo`.
- **D-5 Repo shape — RESOLVED 2026-07-14: MONOREPO for everything that consumes the daemon API;
  separate repos for everything that does not.** **Repo shape follows CONTRACT COUPLING — nothing else
  decides it.** The monorepo `remudero` (npm workspaces) holds: the **daemon** · **CLI** · **MCP** ·
  **`packages/api-client`** (the generated contract, §7A) · **`apps/dashboard`** (web) ·
  **`apps/desktop`** (Tauri macOS shell) · **`apps/mobile`** (Tauri iOS shell). THE ARGUMENT: every one
  of these consumes the SAME daemon API contract; in a monorepo a breaking API change **fails CI across
  ALL consumers atomically, in one PR**, so drift cannot ship. Split repos make that drift SILENT —
  discoverable only at runtime, which is exactly the failure three clients-of-a-daemon must never have.
  **SEPARATE repos, deliberately** (different cadence/audience, no contract coupling): **`remudero-site`**
  (docs/marketing, WS-12 — a docs typo must not run mutation testing, and a daemon change must not
  redeploy the site) · **`remudero-commons`** (WS-11) · **`remudero-pro`** (§6A — never mixed with core,
  ever). See §7A (the contract) and §7 (one web app, three shells).
- **D-9 CLA vs DCO — RESOLVED: DCO**, one-way door closed knowingly (§6A). Reversal requires a CLA
  from day one; retrofitting is impossible. Revisit ONLY if the project's purpose changes materially.
- **D-8 Monetization**: open-core per §6 stance (rec); shape/pricing decided post-WS-6 traction,
  never earlier — premature paywalling kills the community the differentiation depends on.

- **D-10 Mutation gate — does it earn its scope? — OPEN, pending lifetime data (economics audit 2026-07-20, measured).**
  The `mutation-ratchet` required check mutation-tests ONLY `src/lib/classify.ts` (261 lines); the other
  ~15k lines of `src/**` have ZERO mutation coverage, and every sampled run since it went live concluded
  SUCCESS. THE RETRO MUST REPORT, WITH DATA: mutants killed vs survived over the gate's LIFETIME, and
  whether it has EVER caught a real escape (blocked a genuine test-weakening PR). If it never has, the gate
  justifies itself with data or gets its scope cut — folded into the nightly full-scope run (W1-T133) that
  owns the global score while the PR gate stays the fast diff-only check. Measured, not assumed: the PR
  gate's warm/diff-scoped cost is ~18-24s (W1-T108's diff-scope skip + Stryker incremental + restore-keys,
  cross-branch-safe — #279's collapse+force-push paid 24s, refuting any per-branch cold-start); the
  13-minute figure was the pre-W1-T108 every-PR tax and is gone.


## 12. Standing rules

1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.
3. One concern per PR. Branch from latest origin/main. Isolated worktrees.
3B. **The merge gate is a GitHub-enforced CONTRACT (required status checks), never a runner-side
   decision that can be raced.** `ci` (typecheck+tests) AND `remudero-review` (acceptance verdict by a
   fresh-context reviewer) must both be green; GitHub does the merging. The runner ARMS auto-merge and
   observes — its exit verdict is advisory telemetry, incapable of diverging from reality. Corollary:
   auto-merge is safe to leave armed, because the contract, not the runner, decides.
4. Acceptance criteria are proofs, not vibes. Green checks ≠ evidence (the full-shop-flow lesson).
5. Never a third blind patch: two strikes → diagnose → one evidence-armed retry → escalate.
6. Zero ask rules in worker settings. Hooks <1s. Workers carry scoped PATs only. No MCP in workers.
7. **DISTRUST THE PROMPT OVER THE INSTALLED VERSION.** Empirically the highest-value line in the
   template: WS-0 caught `allowedDomains` nesting; W1-T1 caught that the SDK's own schema is `$loose`
   and silently strips unknown keys — a guard built as specified would have PASSED the typo it exists
   to catch. Every Promptsmith-rendered prompt injects this rule. Read the installed schema; never
   trust a prompt's spelling, including this document's.
8. OpenClaw stays out. The mini's protected paths are inviolate (deny-floor).
8. The loop never waits on a human unless the plan says so. Idle = groom.
9. OSS defaults must be defensible on a stranger's machine; yolo is a documented opt-in.
10. This document is truth. Every session syncs it before acting and after shipping.
11. **Isolation and containment are PROVEN PER RUN by probe, never assumed from configuration.** A
   setting that "should" isolate (ZDOTDIR, a sandbox block, a stripped env) is a hypothesis until a
   preflight probe confirms it on THIS machine, THIS run — config that happens to work by accident of
   the host (PR #8: isolation held only because `~/.bashrc` was absent) must fail closed the moment the
   accident ends. See FIELD FINDING 11, W1-T17.
12. **Supervision is deterministic; judgment is advisory. An LLM may RECOMMEND a halt; only code may
   ENFORCE one.** The flight judge and specialist panels (§4B) return verdicts a deterministic
   controller acts on; no LLM sits in the merge decision, and none edits code. See §4B, W1-T20/21/22,
   W2-T1.
13. **A doc that DESCRIBES a mechanism is never proof the mechanism EXISTS.** Acceptance proofs must be
   OBSERVABLE SYSTEM STATE — `gh api` output, a status object, a grep of the call site, a passing test —
   never a file that talks about it. PR #12 shipped `docs/review-gate.md`, passed CI, reported
   `verdict=merged`, and did none of its job (protection unchanged, no status ever posted). [PR #12/#13]
14. **Splitting a task can ORPHAN its call site — when you split, name the integration point explicitly
   as one side's deliverable.** T1C built the reviewer and T1D was to enforce it, but NEITHER owned
   `run-task.ts` CALLING it; the reviewer was fully-tested dead code for two PRs. The wiring is a
   deliverable, not a seam. [PR #12/#13]
15. **When a worker is blocked by an acceptance gate, it may ADD the missing work or ESCALATE. It may
   NEVER edit the acceptance criteria to match its diff.** Workers have write access to `plan/tasks.yaml`,
   so this prohibition is stated in every rendered prompt, not assumed. The gate names the gap; the fix
   is to close the gap, not to move the goalposts. [session doctrine]
16. **The Architect may correct a mis-specified task via a plan PR; a worker may never. The test of
   honesty is that NO criterion is dropped or weakened — only REDISTRIBUTED.** A task whose criteria span
   multiple subsystems collides with one-concern-per-PR and is undeliverable; the Architect decomposes it
   by CONCERN (every criterion survives verbatim in some child task), and the `satisfied_by` field
   (Architect-only, plan-only PRs — rule 15) marks a criterion an earlier merge already satisfied. Splits
   observed: T1C, T1D, W1-T3. [PR #22, W1-T3] 
17. **PROVENANCE FOR THE PLAN, NOT JUST FOR PROMPTS.** Every task must cite WHY it exists (`origin:`
   feedback#/retro#/architect/human + `plan_refs:` the sections it implements). A task with no origin is
   an ORPHAN and cannot be trusted to reflect anyone's intent. `origin:`/`plan_refs:` are Architect-only,
   plan-only fields (same rule as `satisfied_by`, rule 15): a worker adding an origin to justify its own
   diff is editing the plan to match the work. `rmd trace` (W1-T43) makes the chain feedback → task → run
   → PR renderable both ways. [§7B]
18. **EVERY ACCEPTANCE CRITERION MUST BE SATISFIABLE BY A NON-INTERACTIVE WORKER.** A criterion that
   requires live operator input ("operator confirms", "user selects", "prompt the human") is STRUCTURALLY
   UNFIT for the headless runner — there is no TTY and no operator, so the worker cannot satisfy or test
   it and will burn its whole budget trying (W1-T9 spent its last ~15 turns on readline-repro scripts
   conjuring an operator that isn't there, then died error_max_turns). Interactive behavior is designed
   for no-TTY and tested via INJECTED INPUT / FLAGS / TTY-ABSENT DEFAULTS, never a live human in the loop:
   a prompt is an interactive-only affordance layered on top of a fully non-interactive path. This is a
   new error CLASS, distinct from over-scoping (rule 19) and looping. [DIAGNOSIS.md diag/w1t9-max-turns, W1-T9]
19. **SIZING IS A PLAN-LAYER CONCERN, NOT A BUDGET KNOB.** A task spanning ≥2 independent acceptance
   concerns, or shipping ≥2 new subsystems, must be `risk: high` or DECOMPOSED at plan time — never left
   `risk: medium` and rescued with a bigger turn budget. Two cross-cutting tasks (W1-T6, W1-T9) overran
   the medium/80 mount; the medium budget is correctly calibrated for genuine single-concern work
   (observed mean now 45.2 turns — RETRO-1784133446353, 22 runs; honest single-concern merges ran 58–69
   turns: #47, #48, #55, #56, #62 — still under the medium/80 ceiling; P7 ratified), so raising it would
   MASK over-scoping and reward it (and W1-T9 was the THIRD max_turns event — a third budget bump was
   refused). The retro fix lives in task SIZING (rule 16 decomposition), not in `.remudero/mounts.yaml`.
   [DIAGNOSIS.md diag/w1t9-max-turns, W1-T6, W1-T9; P7 RETRO-1784133446353]
20. **A NEW SIZING/FITNESS RULE MUST RETROACTIVELY RE-GRADE THE OPEN QUEUE — RULES ARE NOT FORWARD-ONLY.**
   When a rule like 18 or 19 is added, every ALREADY-AUTHORED open task must be re-checked against it, not
   only new authoring. W1-T12 pre-existed rules 18 and 19 and violated BOTH (three concerns at `risk:medium`;
   three live-context criteria — overnight drain, launchctl-load, live-kill) yet still reached a worker and
   burned 81 turns / $10.27 — the FOURTH max_turns event — because the rules were enforced forward-only.
   `rmd retro` re-grades every open task against every standing rule and files a corrective task for each
   violation (the executable duty is W1-T20d). A rule the queue is never swept against protects only the
   tasks written after it. [DIAGNOSIS.md diag/w1t12-max-turns, W1-T12]
21. **AMENDING AN ALREADY-MERGED TASK DOES NOT RE-QUEUE IT AND SPAWNS NOTHING — THE AMENDER OWNS FILING THE
   FOLLOW-UP.** A criterion added to a task that has already merged is unreachable by every rung: `deriveStatus`
   treats MERGED as terminal, the drain's first filter is `if (isMerged(t.id)) continue`, the retro's
   `planHealthSweep` skips merged/done as "already shipped", the linter is status-blind, and `rmd correct`
   re-points credit but cannot un-credit. So the criterion sits in the plan looking authoritative while nothing
   can ever dispatch, review or prove it. This is not a gap to be closed by making merge reversible — it is the
   correct behaviour of a derived-status system, and the duty sits with the author of the amendment: amend for
   the record if the task's spec was genuinely incomplete, and in the SAME PR file a follow-up task carrying the
   new criteria VERBATIM (rule 16 — nothing dropped or weakened, only redistributed). This was already the
   consistent convention (W1-T161, W1-T97, the W1-T65 pair, the W1-T76 follow-up) and it still failed, because
   convention is not a gate: PR #374 amended W1-T155 at 17:35:20Z, 1h45m after PR #365 credited it merged at
   15:50:08Z, adding the monotonic-under-darkness and liveness-bound criteria — and passed every check clean.
   Both orphaned. One of them WAS the fix for the regression-to-queued-on-read-failure bug, which therefore
   survived wearing a "merged ✓" badge while the console shipped a render-layer honesty banner over a data layer
   that still lied. Found by hand, by nothing else. The executable duty is W1-T180 (a §5C lint check that fails a
   bare post-merge amendment and passes one accompanied by its follow-up); the rehoming of what this already
   orphaned is W1-T179. [W1-T155/PR #374 vs PR #365, 2026-07-20]
22. **THE CONSOLE MUST DISTINGUISH CLAIMED STATE FROM EVIDENCED STATE — THE W1-T128 DOCTRINE, APPLIED TO
   PIXELS.** A CLAIM is what a remote or a judge ASSERTS: merged-per-GitHub, review-passed. EVIDENCE is what the
   fleet can SHOW: a ledger receipt of the merge, proofs that actually executed. They are not the same fact, and
   the console must never render them as one. Every surface owes the reader which it is showing, and a surface
   that cannot obtain evidence SAYS SO rather than silently downgrading to the claim — or worse, to nothing.
   Three fixtures from 2026-07-20 make the cost concrete. (i) The board rendered `merged 0/160` with every task
   queued, because a failed GitHub read returned an empty set and cannot-read was presented as nothing-exists
   (W1-T181). (ii) RECENT rendered "no recent outcomes yet" across a week containing ~100 merges, because the
   section was GitHub-sourced while the LOCAL ledger held every one of them (W1-T184). (iii) `remudero-review`
   posted "PASS — 5 criteria substantiated, no test theater" at `proof_exec: 0/5`, directly beneath its own
   FLOOR DEGRADED banner, over a diff satisfying one criterion in five with zero tests on a `tdd: strict` task —
   a CLAIM of substantiation rendered as though it were EVIDENCE of it.
   The rule follows from where authority actually sits: the ledger is LOCAL, append-only and complete — the
   fleet's own receipt of what it did. GitHub is a REMOTE, rate-limited, occasionally-unreachable claim about the
   same events. A console that inverts that dependency lets a remote outage empty a local truth.
   Executable duties: W1-T183 (density/IA — anomaly visible at the list layer), W1-T184 (ledger-first rendering
   — GitHub decorates, never gates), W1-T179 (last-good status under darkness), W1-T182 (NEEDS ME joins live
   escalation state, not ledger history). [console design pass, 2026-07-20]

- Lives at repo root. Header carries sync date + focus, his-house style.
- Humans and agents edit via commits/PRs; the Architect does narrative syncs at workstream
  boundaries; the control plane flips task statuses only.
- Sections are append-biased: shipped arcs move to a SHIPPED log (added at first ship); lessons land
  in Standing rules or the relevant section in place — the repo remembers its outages where they happened.
- External Claude (design partner) contributions arrive as chat-produced patches until WS-6, then
  through remudero-mcp.

## 12A. Documentation as a gated artifact, in tiers

Docs are scattered (W1-T30 skeleton, W1-T39 ORIENTATION, WS-12 website) with no coherence and no anti-rot
GUARANTEE. As the CLI grows (`feedback`, `triage`, `trace`, `drain`, `skill`, `plan --mode`, `retro`),
`rmd --help` and the docs DRIFT from reality unless drift is a CI FAILURE. Docs-as-code fails because "it
assumes humans notice when docs fall behind" [research]; the fix is an AWARENESS LAYER that ties a change
to the docs it falsified. Split by AUTOMATABILITY:

**TIER A — GENERATED; drift = CI-RED** (the automatable layer — structured-in → structured-out):
- **`rmd --help` and every subcommand's help are GENERATED from a single command registry** (one source of
  truth), never hand-maintained (W1-T47). A CI check asserts every command has help + examples; a command
  with **no registry entry FAILS CI**.
- **The CLI reference doc is GENERATED from that same registry** (W1-T48) — so `rmd --help`, the GitHub
  `/docs`, and the website CLI page CANNOT disagree; they share a source.
- **The API reference (§7A `packages/api-client`) is GENERATED from the OpenAPI surface.**
- **CHANGELOG is generated from Conventional Commits** (W1-T31).

**TIER B — HUMAN/ARCHITECT-AUTHORED; gated by the reviewer** (the non-automatable layer — needs context
absent from the codebase):
- Concept guides, architecture (§ links), the operator guide, troubleshooting, the security/limitations
  page. Maintained by `rmd retro` + the docs rubric; the §5-layer-2 reviewer rubric already flags a
  behavior-changing diff with no doc update (W1-T30) — EXTEND it to require the RIGHT tier (a command
  change ⇒ Tier A regen; a concept change ⇒ a Tier-B edit or an explicit waiver).

**THE AWARENESS LAYER (the anti-rot mechanism):** a diff touching a COMMAND or the API surface must
**regenerate Tier A — CI enforces BYTE-EQUALITY** (regenerate in CI and diff; stale generated docs = RED,
naming the drifted command, W1-T48) — and must update or explicitly WAIVE Tier B. This is W1-T29
plan-claims applied to docs: **docs are not evidence unless CI proves they match the code.**

**ONE SOURCE, THREE SURFACES:** registry → (`rmd --help` | GitHub `/docs` | website CLI page). Never three
hand-copies (W1-T49). The website (WS-12) RENDERS the repo's canonical docs; nothing there is authored
twice. `docs/ORIENTATION.md` (W1-T39, retro-maintained) and the `docs/` skeleton (W1-T30) are the Tier-B
spine this coheres — one doc set, not scattered tasks.

## 13. Plan-sync: the in-repo PR flow (never scp again)

`MASTER-PLAN.md` and `plan/tasks.yaml` were once copied into the tree
out-of-band (scp), arriving DIRTY with no provenance. Fixed: plan edits land
**exactly like code** — branch, edit, open a PR, gate on the same `ci` +
`remudero-review` checks as any other change. No file ever arrives by
scp/rsync/manual copy again. Full flow, including the `Acceptance:` block a
plan-only PR needs to unblock `remudero-review`: [docs/plan-sync.md](docs/plan-sync.md)
(W1-T15).

## 14. Immediate queue

**SETUP COMPLETE (2026-07-14)** — the full inventory (repos, org settings, workspace, auth, deny-floor)
is SUPERSEDED by NET STATE and deleted here rather than maintained twice. Still-live residue only:
scoped sandbox PAT deferred → WS-1 hardening (FIELD FINDING 9).

**NEXT: see NET STATE + SHIPPED log** (WS-0 and WS-1 both SHIPPED; the daemon runs itself; L2 active, and
as of R9 WS-3's control panel has a live shell). The kick order lives in NET STATE and NOWHERE ELSE — the
stale "starting with the §5C linter" pointer that sat here is deleted rather than re-synced every retro.

**Craig's standing side-items (outside Remudero):** (1) the `~/.zshrc` API-key billing leak — **see
FIELD FINDING 2**, which states it in full; the restatement that lived here is deleted (one fact, one
home). (2) One-time employer IP/moonlighting policy glance given the director role; the public tree is
already scrubbed to that standard.

**Grill RESOLVED (complete record):**
- **G-1** → public from day 1 (hygiene woven into §6/§8; spike acceptance includes leak-grep).
- **G-2** → proto-runner; **L1 COMPLETE — L2 now active** (WS-1 shipped; daemonization landed last, as
  planned).
- **G-3** → pace to Max limits, no dollar cap (§9: limit-aware backpressure, quiet-hours throttle,
  per-worker runaway tripwire retained as anomaly detection).
- **G-4/G-7/G-8/G-9/G-10/G-11 (naming + domains) → ALL MOOT, FOLDED.** Remudero chosen, domains
  purchased 2026-07-14; the bar (≥2 TLDs), the no-auto-advance protocol, and the full registrar saga
  are recorded ONCE in **D-1**. Six near-duplicate grill lines restating a closed decision deleted here.
- **G-5** → tailnet dashboard first; Expo standalone later (§7 mobile ladder).
- **G-6** → Issues + Discussions OFF until WS-4; pre-alpha banner; CODEOWNERS from PR #1 (§6).
- **G-12** → Craig instance = Max 20x; **directive**: tier is per-instance setup config, never a
  plan constant, with auto-discovery on attach (§9 detect→confirm ladder; wizard + Settings pane).
- **G-13** → thinking_default: medium.
- **G-14 (pre-build)** → same Max 20x pool; Craig expects to work mostly THROUGH the fleet ⇒
  quiet-hours optional/off; **Pause (drain-and-hold) added to the control set** — his directive.
- **G-15 (pre-build)** → BlueBubbles acceptable but nothing may be Craig-specific in the default
  path ⇒ **imessage-local reference adapter** (native osascript on the host Mac) built at WS-1.
- **G-16 (pre-build)** → first project = remudero itself (confirmed); new-instance onboarding =
  **Setup Agent** with public/private counsel + sub-agent-executed setup (WS-4).
- **G-17 (pre-build)** → **Tier Invariant**: the main agent always rides a higher-thinking mount
  than the coding agents; relative ordering, config-validated, flywheel-constrained (§9).

## Banked queue

- Grill-me protocol as in-harness interactive intake (`rmd chat`) — post-WS-4.
- Agent Teams as an optional worker sub-mode for parallel exploration inside one task.
- **Beads import/export adapter** — tasks.yaml stays the schema-tight native substrate; Beads (23k★,
  git-backed agent issue ledger) is the interop target if demand appears.
- ~~Formula/molecule-style reusable task templates~~ **PROMOTED to core as §3A Campaigns** (Craig
  directive, 2026-07-14).
- Wasteland-style federation of the commons across operators (portable, reviewed knowledge
  exchange between installs) — post-WS-11 if the commons gets traction.
- Remote/cloud workers beyond the mini (hyperscaler or Claude Code cloud sandboxes).
- Load/scale story: multiple products, one daemon vs. daemon-per-product.
- ClawApp inbox integration as a notifier adapter (Craig instance).
- Plugin/skill marketplace listing once stable.
- Cross-agent support (Codex exec) — explicitly parked; Claude-first keeps contracts tight.
- Tournament dispatch (two approaches, reviewer picks) for high-risk tasks — expensive, park until
  verdict calibration proves the reviewer.
