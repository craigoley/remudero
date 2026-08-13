# REMUDERO — Master Plan (v2.32 · synced 2026-08-12)

**FOCUS — THE HARNESS SHIPPED TWELVE TASKS THIS LOG HAD NEVER HEARD OF, AND CALLS A TASK'S OWN
RE-DISPATCH "FOREIGN". 34 runs → 12 tasks / 12 merged PRs at $5.163/run** (per SHIPPED task
**$14.63**). *(An **ORGAN** is an exported capability that merged with no production call site —
built, tested, shipped, never called; **DARK** while it stays that way.)*
**(1) A GAP-FILL WINDOW, NOT A DELTA.** The gather re-derived from an all-time marker and surfaced
**W1-T388–T410 / PRs #1492–#1591** — twelve shipped tasks the SHIPPED log never recorded, between
two logged cycles. A retro window is itself state, and this one had none.
**(2) "FOREIGN" IS TWO MECHANISMS WEARING ONE LABEL.** Of **17 rejected trailers, 10 name the SAME
TASK's own later run branch** (`run-W1-T393-…880` rejected against `run-W1-T393-…195`); only 7 name a
stranger's branch. P47's foreign counter is unreadable until those are split — the P43 defect that
struck P29's dial, now found in P47's.
**(3) FIVE OF SEVEN `blocked_*` VERDICTS HAVE MERGED PRs** (T394/#1492, T397/#1495, T398/#1505,
T406/#1559, T410/#1591) — 71%, the sharpest write-side-credit-artifact ratio this plan has recorded.
**(4) THE TURN COLUMN IS LIT AGAIN: 12/12 shipped runs report nonzero turns, avg 99.706** — R17-1's
coverage figure, reported as that row demands, with TASK D **unbuilt**, so it is **UNATTRIBUTED**,
not a fix. LEARNINGS **74**, and `+74 since marker` is a marker artifact, not writes — **EIGHTH
frozen cycle**. **ZERO new P-numbers mined.**
Next: **P47 → P38 → P40 → P48 → P43 → P33**.

**Header discipline (v2.17).** Sync date + current focus, nothing else; the sections are the source of
truth. A retro that re-inflates this header has failed the HARNESS-COMPRESSION bar.

**Retro ledger (R1–R15 folded to one line — the SHIPPED log's own section headers carry the detail):**
R1–R9 seeded CALIBRATION + P1–P32, corrected the false-merged W1-T54b attribution (#80 → #91) and
closed P1–P11+P15+P21+P25+P27+P31 · R10–R15 logged the console/inbox, 94-task gate-integrity,
ratified-backlog, account/status-board, gate/claim-integrity and console-tabs/governor-wiring cycles,
RETIRED **P28** (22%, n=18) and **P41**, CLOSED
**P12/P13/P14/P18/P19/P20/P23/P24/P34/P37**, mined **P35/P38/P39/P40/P41/P42/P46/P47**, and recorded
the first pre-committed effect test to PASS ·
R16 (…992364048, 2026-08-06) logged the 25-task daemon-lane + escalation-quality cycle and scored
this plan's first `HIT` · R17 (…537819709, 2026-08-12) logged the 27-task board/verdict-integrity +
learning-loop cycle, scored R16's four pre-registrations 0/0/4 and STRUCK the sibling-rejection
metric P29 had been ranked on for eight cycles ·
**R18 (…578394991, this sync)** logs the **12-task GAP-FILL window (W1-T388–T410, PRs #1492–#1591)**
the log had never recorded, re-bases calibration on 34 runs, **SCORES R17's four pre-registrations
(0 HIT / 0 MISS / 4 UNRESOLVABLE)**, splits P47's "foreign" counter into two mechanisms, CLEARS the
stale `W1-T149`-unshipped assertions that BLOCKED the plan-state truth rung, and mines **ZERO** new
P-numbers. **Per-proposal RE-RANK stubs stay abolished** — each proposal has ONE canonical entry,
updated in place; the live ranking is the single line under §Retro proposals.

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

### CAPABILITY SNAPSHOT

Derived present-tense capability facts (lane count, cost ceiling, recon cap, ci-gate roster),
machine-owned below — regenerate with `npm run capability-snapshot` after touching a source;
`capability-snapshot:check` (REQUIRED CI check) gates staleness, the generate-cli-reference.mjs
mold (W1-T48) applied here (W1-T383). Intent, rationale and history stay hand-written outside
this block — a generator has no authority over WHY.

<!-- CAPABILITY SNAPSHOT:BEGIN -->
- **Daemon dispatch lanes**: 3 — source: `sweep.dispatchLanes` via `loadPolicy(policyPath(root))` (src/lib/policy.ts, plan/policy.yaml)
- **Daily cost ceiling**: $500 (committed default, no state/ override) — source: `resolveDailyCostCeiling(root, policy)` (src/lib/policy.ts)
- **Recon turn cap**: 20 — source: `RECON_MAX_TURNS` (src/run-task.ts)
- **ci-gate REQUIRED checks**: 13 — ci, lint-plan, depcruise, containment-probe, coverage-ratchet, mutation-ratchet, jscpd-gate, claims, learnings-budget-ratchet, commitlint, api-client-drift, no-hand-rolled-fetch, scan-pr / osv-scan — source: `REQUIRED` (.github/workflows/ci-gate.yml, job `ci-gate`)
<!-- CAPABILITY SNAPSHOT:END -->

★ **WS-1 COMPLETE + L2 LIVE (2026-07-15) — FOLDED, because the SHIPPED log carries every PR and the
claims have been true for fourteen retro-cycles.** The self-hosting exit criterion is MET: `rmd daemon`,
launchctl-loaded, drained SBX-T1/T2/T3 unattended → merged PRs #6/#7/#8, booting ANTHROPIC-clean, then
survived a kill-9 + KeepAlive restart recovering to correct GitHub-derived state with **no duplicate task
run** (W1-T12d, operator-attested). THE HONEST BOUND, kept: that drill was bounded (`--max 3`, post-drain
kill), so recovery is proven by no-duplicate + clean idle, not by an active `reconstructOrphan` — and the
claim being made is CAPABILITY, not an overnight-chaos result. §5's Tier-1 security stack (CodeQL/OSV/
Dependabot/leak-grep #76, the ci-gate aggregator #75, the dep-review lane #87/#91) runs on remudero itself,
so §5A's "the harness eats first" is FACT on the security tier. As of R11 the daemon also drains
`remudero` itself and fires its own retro (W1-T160/#853) — the operator-kick era is over.

★ **THIS CYCLE (RETRO-1786578394991, 2026-08-12): THE GAP-FILL WINDOW — 34 runs → 12 tasks / 12
merged PRs (W1-T388–T410, #1492–#1591) at $5.163/run.** Ids, PRs and costs are in the SHIPPED log and
are NOT restated here. The window is **BETWEEN two already-logged cycles and was never logged
itself**: the gather re-derived from an all-time marker and every one of its twelve ships was new to
this file. What landed in it: the **mutation-ratchet rung (D-10/W1-T393/#1521)** whose verdict
emission is still unwired, the **CI/gate and proof-integrity ladder** (T394/#1492, T397/#1495,
T398/#1505, T406/#1559 — the window's peak at $23.043/256t), the **offline shipped/not-shipped
contradiction refusal (T409/#1597)**, the **plan-state truth rung (T410/#1591)** that BLOCKS this
very retro, and the **T399–T402/T407/T408** run of ledger-credited fixes. **Zero `diagnose` runs,
third cycle.**

★ **THE WINDOW ITSELF IS THE FIRST FINDING.** Twelve merged PRs sat outside every retro's reach
because a retro's window is derived from a MARKER and no instrument reports what the marker excluded.
R17 read 64 runs ending at T426; this gather read 34 ending at T410; nothing anywhere reconciled the
two. Consequence, stated as a bound rather than a theory: **this cycle's dollars and turns are NOT
comparable to R17's** — they are a different, partly overlapping population, and the calibration
section labels them so. Fold-line for future retros: *a re-derived window is evidence about
COVERAGE, never a trend point.*

★ **THE SECOND FINDING: "FOREIGN" IS TWO MECHANISMS UNDER ONE LABEL, AND ONE OF THEM IS THE TASK
ITSELF.** Of this window's **17 rejected trailers, 10 name a branch of the form `run-<SAME task>-<a
different timestamp>`** — W1-T393, T399 ×2, T400 ×2, T407 ×2, T408, T409 ×2 — i.e. an earlier run
rejected because the merged PR belongs to a LATER dispatch of the same task. Only **7** name a
genuinely foreign branch (`claude/resolve-p27-findings-rnvu61` ×4 against T388/T395,
`claude/remudero-planning-clarify-142opb` ×2 against T401, `plan/close-t201` ×1). The gather prints
one word — *stale/foreign* — for both. The consequence is exact and it is P43's: **P47's headline
counter cannot be attributed to P47's mechanism**, because half of it moves when a task is
re-dispatched and half moves when a stranger writes a trailer, and no clause of P47 touches the
first. Note also what is NOT broken: every one of those ten tasks IS credited at task level (they are
in the SHIPPED log), so the rejections are the ownership-assert doing its job per P29's lesson (a) —
the defect is the NAME, not the refusal. TASK F below splits the counter; nothing re-ranks on it.

★ **THE THIRD FINDING: FIVE OF SEVEN `blocked_*` VERDICTS HAVE MERGED PRs.** W1-T394/#1492,
T397/#1495, T398/#1505, T406/#1559 and T410/#1591 all ended `blocked` or `blocked_ci` in the ledger
and are MERGED on `main`. That is **71% — the sharpest write-side credit-artifact ratio this plan has
recorded** (prior best: R8's 28 gate-side merges against 0 credits, a different shape). It is
evidence ON the standing fold-line under §Retro proposals, not a new number, and it is why this
cycle's `blocked_*` classes are NOT mined as failures: four of the five are proof that the RUN ended
before the MERGE did, which is P30's edge-triggered credit hole, still live.

★ **THE TURN COLUMN IS LIT IN THIS WINDOW — REPORTED, NOT CREDITED.** All **12 of 12** shipped runs
report nonzero turns (61–256, avg 99.706 over 34 runs). R17-1 required that R18 print the coverage
figure whether or not TASK D shipped; **TASK D did not ship**, so per P43(ii) the 100% coverage here
is **UNATTRIBUTED** — a property of which runs this marker selected, not of a fixed instrument.
**P40(i) stays OPEN and TASK D stays rank-3 work.** The falsifier is cheap and stated: if a future
window again reports dollars against 0 turns with TASK D unbuilt, coverage was never fixed.

★ **SPEND & THE INSTRUMENTS.** **$175.550 total, $5.163/run, $14.63 per SHIPPED task** over 34 runs —
and per the window bound above this is **NOT** a trend point against R17's $8.302. Ledger credit
**7 of 12 (58%)**, inside the ten-cycle noise band (0%–64%) and therefore **UNATTRIBUTED** (P43(ii)).
**17 rejected trailers, split 10 self-redispatch / 7 foreign-proper** (see THE SECOND FINDING); 22 of
34 runs bought no credit. MAST `verification` **19**, the sole mapped category; **UNMAPPED 8 of 34
(24%)** — `incomplete`×6, `blocked`×2 — with **P40(iii) still unbuilt**, so the fall from 36% is
UNATTRIBUTED in both directions. Ratification telemetry reads **0 / 0 / 0%** on this window against
`3 / 11 / 21%` cumulative — the same counter, two irreconcilable readings, which is **P40(ii)'s
windowing defect stated by the instrument itself for a SIXTH cycle**. Infrastructure events **none, a
SIXTH clean reading** — P41 stays retired. Plan-health sweep **CLEAN**; SHIPS-UNWIRED clean.
**Mutation-gate lifetime: N=0 verdicts, NO POSITIVE CONTROL** — the gather says so in those words
rather than printing "zero escapes" (**P48(ii) obeyed by an instrument before the proposal is
ratified**), and the rung's own task **W1-T393/#1521 shipped in this window** with the
`mutation.ratchet_verdict` emission call site still unwired. **PLAN-STATE TRUTH RUNG: BLOCKING on
entry** — the P29 tombstone's quoted history still carried a stale never-shipped assertion about the
task behind **#349**, which the merge resolver reports MERGED; those lines are DELETED by this retro,
which is the rung's designed outcome and the reason that tombstone is now twelve lines, not
fifty-four. **The rung also gates this retro's own prose**: `npm run claims` REFUSED an earlier draft
of this very paragraph for naming the id beside the word it forbids — the gate policing the
plan-syncer, which is §5A's "the harness eats first" arriving in the retro lane.

★ **PRIOR CYCLES (folded — the SHIPPED log's own section headers carry every id, date and detail).**
R17 (2026-08-12) landed the board/status arc, the verdict-and-proof-integrity spine and the learning
loop — 27 tasks; it STRUCK sibling-rejection count as P29's metric (the dial was never wired to the
mechanism; **W1-T149/#349 shipped 2026-07-20 and both clauses are live**, which is why no "unshipped"
assertion about it may appear in this file again), recorded the first haiku-routed merge, and mined
ZERO new numbers. R16 (2026-08-06) landed the daemon-lane arc (P19's parallel dispatch LIVE), escalation quality, the
gate's own integrity and five dark-organ wirings — 25 tasks; it scored this plan's first `HIT`
(R15-1, `implement` turns −34% off a single $3.482 fix) and mined ZERO new numbers. R15 (2026-08-05)
landed the four-tab console, the governor-wiring arc and the preflight fix — 25 tasks; mined P47,
priced P38. R14 (2026-08-03) landed the review/claim-integrity gate, dispatch integrity, the
credential family and CI parity — 25 tasks; first pre-committed effect test to PASS. R13 (2026-08-01)
landed the account family and the status board — 22 tasks. R12 (2026-07-30) drained the whole
ratified backlog: P19, P34, P37 — 25 tasks, three families CLOSED. R11 (2026-07-29) drained the
gate-integrity ladder, brownfield onboarding and the learning flywheel — 94 tasks. R10 made the
console a real instrument and closed the P25 ratification inbox. R9 ended the spin loop (195 runs →
26). R8 recorded 28 merges and **0** ledger credits — the LIVENESS inversion that mined P29/P30. R7
built flight control + the level-triggered PR reconciler. R6 gave the floor executable proofs (P15).
R5 unioned ledger∪GitHub at gather time (P11) and found the FIRST integrity inversion — **PR #80's
false `W1-T54b` trailer**, the residue P33 retires.

**Inventory (verified 2026-08-12: 12 tasks / 12 merged PRs in THIS window (W1-T388–T410) on top of
R17's 27, ~1420 merged PRs on `remudero`, 6 on `remudero-sandbox`).** WS-0 and WS-1 SHIPPED; WS-3's
control panel is a live four-tab instrument
(Decisions/Now/Plan/Feed) with a CLI projection (`rmd status`) and **operator WRITE controls behind
arm-then-confirm**, including the daily cost-ceiling override (T364/#1417) and a Plan tab that now
carries per-section filed/merged counts (T376) over a frontier that excludes `verify: human` tasks
(T375). The §5 gate stack polices its own integrity end to end and, **new this cycle**, refuses a
shipped/not-shipped task-id contradiction OFFLINE (T409/#1597 — the rung that blocked this retro),
judges lock holders by pid+host+start-time (T368) with a dead pid outranking recent activity (T381),
collapses check-proof onto the reviewer's own executor (T387), and is itself regression-locked by a
**golden-verdict fixture corpus** (T423/#1613) whose companion joins verdicts to post-merge reality
(T424/#1614). **From this window: the mutation-ratchet rung exists (D-10/W1-T393/#1521) with its
verdict emission unwired, and the plan-state truth rung (T410/#1591) now refuses a MASTER-PLAN
assertion that contradicts merge state — it fired BLOCKING on this very retro's entry.**
`deriveStatus` now DEFERS on a truncated board fetch instead of guessing (T415) and
resets a dispatch-breaker streak only on GitHub corroboration (T414). The daemon fires its own retro
(W1-T160/#853), dispatches multiple tasks at once (lane count: CAPABILITY SNAPSHOT above), observes
BOTH `gh` quota buckets and escalates exhaustion once (T372), and carries an explicit dispatch
PRIORITY field with comparator and lint (T422/#1612). The learning loop gained a repeat-incident rate
metric with escalation (T418), duplicate-closure detection at intake (T420) and a closed citation
loop (T419/#1609). The SHIPPED log is the record (rule 13); no PR-by-PR restatement lives here.

**mounts.yaml (W1-T5) is SHIPPED** — #42, on disk at `.remudero/mounts.yaml`, re-based to a flat-400
tripwire by #90, and routing model + effort by task RISK and CLASS since W1-T167/#606. The
calibration table below is the row that re-bases it. **★ THE CONTRAST ROW VANISHED AGAIN, EXACTLY AS
THE STANDING RULE PREDICTS.** R17 recorded the first `plan-lint`/haiku row ever (n=1, $0.295, merged
#1621); this window has **ONE class row, `src` n=34**, and one model row, `sonnet`. That is the
appear-and-vanish pattern for the eighth time (`docs` n=1 → 0, `diagnose` n=4 → 0, `plan-lint`
n=1 → 0), and it is why the rule holds unchanged: **do not re-base a mount on a row that appears and
vanishes at n≤4.** The live reading is still *under-sampled, not unmeasurable* — two more non-`src`
ships make it decidable.

**Still PLANNED, not shipped** (the honest remainder): **P33's trailer quarantine list, thirteen
`(pr, task)` pairs**; P17's receipts task — **W1-T71 is unbuilt**, and is **held on its INTEROP merit alone as of
2026-08-07; the Art. 50 clock that ranked it for five cycles is struck, because no cycle ever checked
whether the obligation reaches a US operator (see P17's entry)**; the remaining fleet tasks (W1-T25/
T28, W2-T2 dry-run); **the organs shipped DARK by their own admission** —
`learningDuplicateViolation` has no live intake gate (T420/#1610), the mutation-ratchet's
`mutation.ratchet_verdict` emission call site is unwired (D-10/W1-T393/#1521, lifetime N=0 — the task
SHIPPED in this window and the organ is still dark), and the golden-corpus lint hook T423 sketches is
deferred; and the follow-up chain the harvests name but rule 15 forbids auto-filing (~45 candidates,
headed by the squash-commit trailer gap from W1-T413 and the host-specific `--ci-parity` failures
re-diagnosed from scratch four separate times). **This window's harvest adds NOTHING to that chain —
it reports no unharvested follow-up at all**, which against 22 uncredited runs is itself a coverage
reading, not a clean bill.

**NEXT (L2) — kick order UNCHANGED by R18, and the reason is the standing rule itself: every number
that moved this window (credit 19% → 58%, unmapped 36% → 24%, turn coverage 46% → 100%, foreign 18 →
17) moved with its proposal UNBUILT and over a re-derived population, so all four are UNATTRIBUTED
and none of them may re-rank anything.** **(1) P47 — trailer emission is unowned; R18 adds that its
own counter conflates two mechanisms (10 of 17 rejections are the task's OWN later run), so clause
(i) must ship WITH the split in TASK F or its effect will be unreadable. (2) P38 — the LEARNINGS
WRITE PATH: 74 entries, zero added, EIGHTH cycle, and this window's miner again surfaced a clean
reusable shape (7 runs, `clean_single_strike` × `fully_executed_proof`) the corpus could not absorb.
(3) P40 — clause (i) is REPORTED-not-fixed (100% coverage here, TASK D unbuilt), clause (ii) is
unpaid for a SIXTH cycle (ratification telemetry reads 0/0/0% windowed against 3/11/21% cumulative),
clause (iii) still leaves 24% of runs unmapped. (4) P48 — no naked zero; the mutation gate's `N=0, NO
POSITIVE CONTROL` demonstrates clause (ii) in the affirmative for a second cycle. (5) P43 — R18 is
its third consecutive instance: a metric that cannot be attributed to the mechanism it names (P29's
dial, now P47's). (6) P33 — the quarantine list, thirteen pairs, none removable.** The binding
constraint is unchanged: **"the harness cannot tell itself whether what it BUILT is running"** — R17
sharpened it to *whether what it MEASURED was measured*, and R18 adds the third turn: **the harness
cannot tell itself WHAT IT LOOKED AT** — twelve merged tasks sat between two retro windows with no
instrument reporting the gap.
NOTE: `nextRunnable` (drain.ts:31 `plan.tasks.find`) is DECLARATION-ORDERED; this is the authoritative
KICK ORDER (mirrored as a comment atop plan/tasks.yaml).

**★ EFFECT PRE-REGISTRATIONS (P43(i) — stored here until it is stored as data; scored by R19).**

| # | metric | prediction | condition |
|---|---|---|---|
| R18-1 | WINDOW COVERAGE — merged PRs carrying a `Remudero-Task` id that fall in NO retro window (this cycle: **12**, discovered only by a marker reset) | **= 0, and the gather PRINTS the figure** | **ANTECEDENT ALREADY TRUE — scorable regardless of what ships**, because it asks only whether the next gather can NAME its own gap. If R19's gather cannot compute it, score MISS, not UNRESOLVABLE: an instrument that cannot report its coverage is the finding. |
| R18-2 | SELF-REDISPATCH vs FOREIGN-PROPER rejections, reported as two numbers (this cycle **10 / 7**, printed as one word) | **two labelled counters appear in the gather** | ONLY if TASK F ships. Otherwise R19 must derive the split BY HAND as R18 did and report it, so P47's counter is never again read as one mechanism. |
| R18-3 | LEARNINGS entries (now **74**, and `+74 since marker` is a MARKER ARTIFACT, not 74 writes) | **> 74 net new, measured against an explicit prior count** | ONLY if P38's TASK A ships. Otherwise the flag stands and R19 reports a NINTH frozen cycle. Re-registered from R15-3/R16-3/R17-3 for the fourth time; the added clause exists because this cycle's gather made a frozen corpus look like a full one. |
| R18-4 | `blocked_*` verdicts whose PR is MERGED (this cycle **5 of 7 = 71%**) | **stays ≥ 40%** | **ANTECEDENT ALREADY TRUE** — nothing is planned that would move it, so it is scorable, and it is the falsifier for THE THIRD FINDING: if it collapses with nothing built, `blocked_*` was never predominantly a credit artifact and the standing fold-line needs re-reading, not extending. |

**R17's pre-registrations, SCORED (P43(iii)'s calibration line — a 4-way UNRESOLVABLE, and the FIRST
one scored across a re-derived window).**
**R17-1 UNRESOLVABLE (antecedent false, figure REPORTED as the row demands)** — TASK D did not ship;
coverage on this window reads **12 of 12 (100%)** and the average (99.706) is printed. Per the row's
own instruction the figure is reported and the prediction is NOT scored HIT: coverage is a property
of which runs the marker selected, and P40(i) is unbuilt.
**R17-2 UNRESOLVABLE** — antecedent false (P47(i) unbuilt); observed **17 rejections**, but R18's
hand split shows only **7** are foreign-proper, so the series 0 → 12 → 4 → 18 → 17 was never
comparable across cycles. The metric is re-specified by R18-2 rather than re-registered.
**R17-3 UNRESOLVABLE** — antecedent false (TASK A unbuilt); LEARNINGS reads **74**, an EIGHTH frozen
cycle. **R17-4 UNRESOLVABLE** — the row assumed a SIBLING counter this gather does not emit; its 17
rejections are all labelled foreign, of which 10 are structurally sibling. Scored UNRESOLVABLE on
INSTRUMENT ABSENCE, a third distinct failure mode, and retired rather than re-registered.
Running calibration: **n=13 · hit 2 · miss 0 · unresolvable 11.** **The line yields its THIRD design
rule.** Rule 1 (R16's): *a pre-registration conditioned on work nobody has committed to dispatching is
a request, not a prediction* — 11/11 such rows have scored UNRESOLVABLE. Rule 2 (R17's): *a
pre-registration must name the COVERAGE precondition of its own metric.* **Rule 3 (new): a
pre-registration must name the INSTRUMENT that will emit its number, not just the number** — R17-4
died because no gather emits a sibling counter, and two of R18's four rows are deliberately
conditioned on nothing but the gather's own ability to print.

## SHIPPED log

Shipped arcs, keyed by Remudero-Task (Standing rule 13: the proof is a MERGED PR, not prose).
Newest first. Cost/turns from the run ledger.

### RETRO-1786578394991 (2026-08-12) — the GAP-FILL window: W1-T388–T410 (12 tasks / 12 PRs)

★ **THIS SECTION IS A GAP-FILL, NOT A DELTA.** Its window (34 runs, all `implement`/`src`) was
re-derived from an all-time marker and sits BETWEEN two already-logged cycles; **all twelve ships
below are new to this log.** Costs total **$175.550** ($5.163/run, **$14.63 per shipped task**),
turns **12 of 12 lit** (61–256, avg 99.706 over all 34 runs), peak **W1-T406 $23.043/256t**.
**7 of 12 LEDGER-CREDITED (58%)**; **5 gate-side, and every one of those five ended `blocked` or
`blocked_ci`** — the 71% ratio THE THIRD FINDING is about. **17 rejected trailers, 10 of them naming
the task's OWN later run branch** (see THE SECOND FINDING). No infrastructure events; no unharvested
follow-up reported; mutation-gate lifetime **N=0, NO POSITIVE CONTROL**.

- **★ LEDGER-CREDITED — 7 tasks** (W1-T393/#1521 *$7.091/103t*, **the mutation-ratchet rung D-10,
  shipped with its `mutation.ratchet_verdict` emission call site UNWIRED — lifetime N=0 begins here**
  · T399/#1542 *$7.199/138t* · T402/#1543 *$6.953/103t* · T400/#1551 *$4.759/95t* · T401/#1552
  *$3.183/61t*, the window's cheapest ship · T407/#1584 *$6.784/125t* · T408/#1588 *$8.894/138t*) →
  **$44.863**
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 5 tasks, ALL of them `blocked_*` in the ledger**
  (W1-T394/#1492 *$8.362/147t* `blocked_ci` · T397/#1495 *$5.340/84t* `blocked_ci` · T398/#1505
  *$6.233/109t* `blocked` · **T406/#1559 *$23.043/256t* `blocked_ci`, the window's peak run** ·
  **T410/#1591 *$9.083/118t* `blocked` — the PLAN-STATE TRUTH RUNG itself, which fired BLOCKING on
  this retro's own entry over a stale plan assertion about the task behind #349**) → **$52.061**
- **UNCREDITED REMAINDER — 22 runs, $78.6.** Not a failure population: `no_pr`×14, `incomplete`×6,
  `blocked`×2 across the same task ids above plus W1-T388, T395, T409 and one stray W1-T201
  re-dispatch. They route through the standing credit-artifact fold-line, never re-mined as classes.

### RETRO-1786537819709 (2026-08-12) — the board/verdict-integrity & learning-loop cycle (27 tasks / 27 PRs)

★ **5 of 26 LEDGER-CREDITED (19%)** — inside the metric's own nine-cycle range (0%–64%), therefore
**UNATTRIBUTED** (P43(ii)), not a collapse. The credited five: W1-T418/#1605, T416/#1607, T420/#1610,
T422/#1612, T424/#1614. The 21 gate-side merges the W1-T51 union rescued: W1-T364/#1417, T368/#1414,
T371/#1425, T372/#1423, T373/#1424, T374/#1434, T375/#1429, T376/#1430, T379/#1436, T380/#1437,
T381/#1438, T382/#1453, T383/#1454, T387/#1442, T409/#1597, T411/#1595, T413/#1602, T414/#1604,
T415/#1606, T423/#1613, T426/#1621. ★ **PLUS ONE THE UNION COULD NOT SEE, ADDED BY HAND:
W1-T419/#1609** — merged on `main` carrying **no `Remudero-Task` trailer at all**, while #1617 on a
foreign branch carried the trailer: 27 tasks, not 26, and P47's completest instance to date.
**$224.146 total; 0/64 `budget_usd` trips; peak W1-T387 $15.477; 37 rejected trailers; turn column
46% dark (P40(i) RE-OPENED); first haiku row ever (W1-T426/#1621, $0.295/62t).** *(★ R18 COMPRESSION:
the per-metric restatement is folded to this line — Calibration's prior-cycles row and NET STATE's
prior-cycles line carry the same figures, and three copies of one cycle's arithmetic is the accretion
this log exists to avoid.)*

- **★ THE BOARD & STATUS ARC — 9 tasks** (the console write control for the daily cost-ceiling
  override W1-T364/#1417 *$14.451* · tailnet identity for `Serve` scope, token as fallback T371/#1425
  · both `gh` quota buckets observed with a once-only exhaustion escalation T372/#1423 · a fast
  preflight mode for the deterministic npm-script gates T373/#1424 · policy-value invariants asserted
  instead of shipped figures T374/#1434 · the plan frontier excluding `verify: human` tasks T375/#1429
  · per-section filed/merged counts on the Plan tab T376/#1430 · check-wait stopping on STALLED
  PROGRESS rather than elapsed polls T382/#1453 · a GitHub-corroborated breaker-streak reset
  T414/#1604 · ★ a TRUNCATED board fetch exposed so `deriveStatus` DEFERS T415/#1606) → **$66.6**
- **★ VERDICT & PROOF INTEGRITY — 6 tasks, the cycle's spine** (`rmd ledger-grep`, a union that FAILS
  LOUD when no archive was read W1-T379/#1436 — **P48's clause (i) shipped as a verb** · check-proof
  collapsed onto the reviewer's own executor T387/#1442 *$15.477, peak run* · ★ an OFFLINE refusal of
  a shipped/not-shipped task-id contradiction T409/#1597 — **the rung that BLOCKED this retro until
  two stale plan-state assertions were struck** · the emitter/commitlint rule-and-range gaps closed
  T416/#1607 · ★ a GOLDEN-VERDICT fixture corpus over the deterministic reviewer T423/#1613 · review
  verdicts joined to post-merge reality T424/#1614) → **$52.3**
- **★ THE LEARNING LOOP — 5 tasks** (a repeat-incident rate metric with escalation W1-T418/#1605
  *$10.202/137t* · ★ the LEARNINGS citation loop closed so retention rides measured use T419/**#1609**
  — *the ship with no trailer* · duplicate-closure detection at knowledge intake T420/#1610, shipping
  `learningDuplicateViolation` **DARK by its own admission** · an explicit dispatch-priority field,
  comparator and WARN lint T422/#1612 · the learning-loop arc stamped as priority-field consumers
  T426/#1621, **the first haiku-routed merge in this log**) → **$30.4**
- **LOCKS, DISK & THE PLAN RECORD — 7 tasks** (a lock holder judged by pid+host+start-time, not pid
  alone W1-T368/#1414 · a dead pid in `run.lock` outranking recent activity T381/#1438 · T380/#1437
  linking to its already-merged fix #1392 · a one-shot disk-reclaim rung for three daemon-only sweeps
  T411/#1595 · the drift-gated CAPABILITY SNAPSHOT generated into this very file T383/#1454 · a no-op
  close of the W1-T413 re-dispatch T413/#1602 — **P39's sanctioned exit, one of 9 `already_satisfied`
  runs this cycle**) → **$32.0**

### RETRO-1785992364048 (2026-08-06) — the daemon lanes & the escalation-quality cycle (25 tasks / 25 PRs)

★ **12 of 25 LEDGER-CREDITED (48%)**, 13 gate-side; turns lit 24 of 25 (2991); $223.251 total, peak
W1-T349 $27.118/151t; 10 rejected trailers (4 FOREIGN, all W1-T343 vs #1361). **★ FOLDED TO FAMILY
LINES BY R17, PREAMBLE FOLDED BY R18** — the gate-side id list is DELETED because every id appears in
the bullets below; ids/PRs/costs preserved, per-arc prose gone.

- **★ THE DAEMON-LANE ARC, P19's parallel dispatch LIVE — 6 tasks** (W1-T339/#1329 · T340/#1331 ·
  T341/#1332 · T342/#1340 · **T343/#1363, the task that cost 5 dispatches and 4 foreign rejections** ·
  T344/#1365) → **$47.016**
- **★ ESCALATION QUALITY — 7 tasks** (W1-T345/#1368 · T346/#1369 · T347/#1371 · T348/#1372 ·
  **T349/#1379 *$27.118/151t*** · T350/#1378 · T354/#1385) → **$77.417**
- **THE GATE'S OWN INTEGRITY — 5 tasks** (W1-T351/#1380 · T352/#1381 · T353/#1389 · T359/#1399 ·
  **T362/#1404, `base_unknown` — P48(i) in the affirmative**) → **$19.616**
- **WIRING DARK ORGANS + THE PLAN RECORD — 7 tasks** (W1-T356/#1393 · T357/#1397 · **T358/#1398,
  `planHealthSweep` into the gather** · T361/#1403 · T363/#1410 · T366/#1411 · T367/#1412) → **$26.868**

### RETRO-1785919636675 (2026-08-05) — the console tabs, the governor wiring & the preflight fix (25 tasks / 25 PRs)

★ **14 of 25 LEDGER-CREDITED (56%)**, 11 gate-side; $391.379 total, peak W1-T336 $23.094/218t; 22
rejected trailers (12 FOREIGN across W1-T314 ×6, T309 ×3, T320 ×2, T324 ×1); four `diagnose` runs,
none merged. **★ FOLDED TO FAMILY LINES BY R16, PREAMBLE FOLDED BY R18** — the gate-side id list is
DELETED because every id appears in the bullets below; ids/PRs/costs preserved.

- **★ THE GOVERNOR-WIRING ARC — 9 tasks** (W1-T316/#1257 · T317/#1259 · T321/#1277 · T325/#1297 ·
  T331/#1310 · T332/#1312 · T333/#1321 · T330/#1307 · T329/#1306) → **$77.580**
- **★ THE FOUR-TAB CONSOLE — 4 tasks** (W1-T334/#1322 · T336/#1324 *$23.094/218t* · T335/#1323 ·
  T315/#1325) → **$63.847**
- **DISPATCH & PLAN INTEGRITY — 4 tasks** (W1-T319/#1270 · T318/#1263 · T327/#1304 · T311/#1236) →
  **$41.533**
- **THE GATE'S OWN FALSE POSITIVES — 4 tasks** (W1-T328/#1305 · T322/#1292 · T312/#1247 · T313/#1249)
  → **$39.282**
- **PREFLIGHT, FLAKE & THE PLAN RECORD — 4 tasks** (★ W1-T338/#1327 at **$3.482/53t** — the
  seventeen-rediscovery preflight `maxBuffer` defect, and the fix R15-1 pre-registered and R16 scored
  `HIT` · T337/#1326 · T326/#1302, the cycle's only `docs`-class run · T310/#1231) → **$20.082**

### RETRO-1785778396449 (2026-08-03) — the gate/claim integrity, credential & fix-rung cycle (25 tasks / 25 PRs)

★ **10 of 25 LEDGER-CREDITED (40%)**; 15 gate-side (W1-T281/#1078, T286/#1106, T288/#1192, T289/#1154,
T290/#1156, T291/#1164, T293/#1169, T296/#1177, T297/#1179, T298/#1193, T299/#1198, T301/#1202,
T302/#1204, T304/#1209, T307/#1216). Turns 19 of 25 nonzero (1466 of 1736). Costs sum to **$161.095**
of **$182.967**; the $21.872 remainder is 23 uncredited runs, overwhelmingly sibling re-dispatches
(W1-T295 ×8, T288 ×6, T292 ×5). 0/48 `budget_usd` trips; peak W1-T294 **$12.965**. ★ **ZERO no-op-close
PRs — R13's pre-committed test on W1-T271/#1040 + T272/#1044 PASSES.**
**★ FOLDED TO FAMILY LINES BY R15; preamble prose FOLDED BY R16** (ids/PRs/costs preserved).

- **★ THE REVIEW / CLAIM-INTEGRITY GATE — 5 tasks** (W1-T304/#1209 · T305/#1213 · T307/#1216 ·
  T302/#1204 · T297/#1179) → **$43.236**
- **★ DISPATCH INTEGRITY — 4 tasks** (W1-T299/#1198 · T298/#1193 · T300/#1201 · T296/#1177) → **$25.651**
- **THE CREDENTIAL FAMILY — 3 tasks** (W1-T292/#1174 · T293/#1169 · T289/#1154) → **$16.041**
- **CI PARITY — 2 tasks** (W1-T294/#1175 · T295/#1215, the task that cost **8 dispatches**) → **$15.728**
- **THE CLASS-C CONSOLE-PANEL BATCH — 6 tasks** (W1-T281/#1078 · T283/#1080 · T285/#1085 · T286/#1106 ·
  T287/#1150 · T288/#1192) → **$31.880**
- **STATUS BOARD + DIAGNOSIS — 4 tasks** (W1-T301/#1202 · T306/#1214 · T290/#1156 · T291/#1164) →
  **$23.560**, plus **T303/#1208 $4.999/76t**, the second `diagnose`-typed run ever recorded.

### RETRO-1785599040918 (2026-08-01) — accounts, dispatch integrity & the status board (22 tasks / 25 PRs)

★ **16 of 25 LEDGER-CREDITED (64%)**; 9 gate-side (W1-T169/#987, T194/#990, T221/#978, T265/#1022,
T268/#1032, T272/#1044, T273/#1047, T279/#1062, T280/#1065). Turns OMITTED, not zeroed — 3 of 25
nonzero (294 of 321). Costs sum to **$153.196** of **$167.119**. 0/34 `budget_usd` trips; peak
W1-T169 **$17.676**. **★ FOLDED TO FAMILY LINES BY R14** (ids/PRs/costs preserved, prose DELETED).

- **THE ACCOUNT ARC — 4 tasks** (W1-T265/#1022 · T266/#1024 · T267/#1026 · T268/#1032) → **$26.341**
- **★ DISPATCH INTEGRITY — 2 tasks, BOTH OPEN-PROPOSAL HALVES BUILT** (the lifetime dispatch cap no
  ledger step can reset W1-T271/#1040 = **P29(ii)** · the sanctioned `ALREADY_SATISFIED` exit
  T272/#1044 = **P39's dispatch-side half**) → **$12.136** · ★ **R14's pre-committed effect test on
  this pair PASSED.** Neither proposal is CLOSED: P29(i) and P39(i) are still unbuilt.
- **THE STATUS BOARD — 4 tasks** (W1-T279/#1062 · T280/#1065 · T282/#1070 · T275/#1050) → **$36.278**
- **THE REVIEW GATE — 4 tasks** (W1-T274/#1048 · T273/#1047 · T277/#1052 · T226/#983) → **$21.036**
- **OPERATOR & PLAN HYGIENE — 7 tasks** (W1-T169/#987 · T221/#978 · T276/#1049 · T278/#1051 ·
  T264/#1000 · T194/#990 · T284/#1073) → **$46.373**
- **★ THE NO-OP REMAINDER — 1 task, 4 PRs, $11.032, ZERO PRODUCT CODE** (W1-T254 closed against work
  PR **#720**: #1007 → #1012 → #1015 → #1016) · kept UNFOLDED because it is the baseline R14's
  zero-reading is measured against; the honest R13 count of tasks that changed product code is **21**.

### RETRO-1785456064479 (2026-07-30) — the ratified backlog drains: P19 + P34 + P37 (25 tasks shipped)

★ **4 of 25 LEDGER-CREDITED (16%)** — W1-T225/#935, T249/#907, T250/#898, T261/#885; 21 gate-side.
Turns OMITTED, not zeroed (3 of 25 nonzero, 339 of 419). Costs sum to **$244.319** of **$277.487**.
**★ FOLDED TO FAMILY LINES BY R13.** *(R14: the credit/turn/cost preamble every section repeated is
now ONE series on the standing fold-line under §Retro proposals — one fact, one home.)*

- **★ P19 — PARALLEL DISPATCH, ALL THREE RUNGS** (W1-T170/#888 · T171/#890 · T172/#896) → **$19.010**
  · ★ **P19 CLOSED**; rung 2 stays BANKED until a rung-1 escape appears in the ledger.
- **★ P34 — PRESENCE-AWARE AUTONOMY, ALL FOUR TASKS** (W1-T248/#903 · T249/#907 · **T250/#898, the
  per-model-class weekly-burn accounting the Calibration model table runs on** · T251/#899) →
  **$30.386** · ★ **P34 CLOSED**
- **★ P37 — THE TIER-1 POLICY FILE** (W1-T252/#901 · T253/#921) → **$25.801** · ★ **P37 CLOSED**
- **THE ESCALATION-INTEGRITY ARC — 4 tasks** (W1-T195/#969 · T196/#972, the cycle's cheapest credited
  run at $0.260/89t · T186/#931 · T198/#933) → **$39.256**
- **DECISIONS + WRITE-PATH HYGIENE** (W1-T191/#966) → **$23.119**
- **THE REMAINDER — 11 tasks** (W1-T168/#884 · T174/#917 · T175/#923 · T176/#926 · T180/#928 ·
  T202/#892 · T225/#935 · T236/#936 · T237/#938 · T238/#940 · T261/#885) → **$106.747** ·
  W1-T202/#892 at **$35.384** is still the second-costliest run ever recorded, behind R11's W1-T193 by
  $0.259; **no run since has come within $17 of either.**

### RETRO-1785341166059 (2026-07-29) — the gate-integrity ladder + onboarding + the flywheel (94 tasks shipped)

★ **20 of 94 LEDGER-CREDITED (21%)**; the 74 unmarked are gate-side merges the W1-T51 union rescued.
Turns OMITTED, not zeroed (58 of 147 runs at exactly 0). Costs sum to **$867.986** of **$979.601**.
**★ FOLDED TO FAMILY LINES BY R13** — every id and PR number preserved; descriptive clauses DELETED,
not summarized. This is the standing treatment every section above and below now carries.

- **THE GATE/REVIEW-INTEGRITY LADDER — 13 tasks** (W1-T203/#508 · T228/#525 · T230/#523 · T229/#528 ·
  T205/#562 · T231/#530 · T227/#527 · T232/#535 · T233/#537 · T219/#571 · T134/#826 · T135/#828 ·
  T161/#866) → **$67.218**
- **THE PROOF-DIALECT + PLAN-LINT ARC — 6 tasks** (W1-T246/#697 · T101/#735 · T118/#817 · T81/#677 ·
  T92/#723 · T58/#635) → **$68.406**
- **BROWNFIELD ONBOARDING (P24, all four phases)** (W1-T82/#683 → T83/#698 → T84/#702 → T85/#709) →
  **$43.563** · ★ **P24 CLOSED**
- **THE LEARNING FLYWHEEL + ITS MINERS — 8 tasks** (W1-T86/#631 P12 · T87/#687 P13 · T88/#689 P14 ·
  T89/#710 P18 · T90/#716 P20 · T91/#719 P23 · T73/#654 · T105/#744) → **$111.191** ·
  ★ **P12/P13/P14/P18/P20/P23 CLOSED — and see P38: this family merged and, three cycles on, the
  corpus it feeds is still at 74 entries**
- **THE SWEEP/RECONCILER FAMILY — 12 tasks** (W1-T254/**#720** — *the work PR R13's four no-op closes
  keep rediscovering* · T124/#821 · T125/#823 · T114/#806 · T106/#804 · T162/#870 · T148/#839 ·
  T104/#801 · T130/#628 · T116/#810 · T257/#800 · T99/#731) → **$80.425**
- **DAEMON DURABILITY + WORKER SPAWN — 11 tasks** (W1-T160/#853 — *the retro's own cadence trigger* ·
  T126/#824 · T197/#531 · T143/#837 · T151/#845 · T215/#590 · T113/#752 · T109/#749 · T117/#815 ·
  T255/#754 · T79/#662) → **$141.752**
- **LEDGER, INBOX + WRITE ATOMICITY — 12 tasks** (W1-T209/#583 · T244/#618 · T218/#593 · T206/#549 ·
  T207/#552 · T208/#555 · T240/#608 · T241/#612 · T242/#613 · T243/#619 · T245/#651 · T173/#660) →
  **$95.159**
- **THE CONSOLE + DIGEST ARC — 10 tasks** (W1-T159/#861 · T163/#647 · T184/#479 · T189/#574 ·
  T193/#602 · T200/#622 · T222/#625 · T223/#626 · T112/#491 · T144/#614) → **$176.278** · the cycle's
  costliest arc
- **CI, COMMIT + MOUNT HYGIENE — 11 tasks** (W1-T137/#842 · T129/#830 · T142/#835 · T133/#833 ·
  T123/#820 · T211/#587 · T107/#747 · T220/#641 · T212/#582 · T120/#819 · **T167/#606 — model/effort
  routed by task risk and class, the row the Calibration table exists to measure**) → **$58.619**
- **DOCS, OPERATOR SURFACE + THE THREE NO-OP CLOSES — 7 tasks** (W1-T213/#595 · T217/#598 · T210/#585
  · T127/#825 · T70/#640 · and the three PRs whose entire content is a no-op close of a stale
  re-dispatch — **W1-T7/#772, W1-T12a/#725, W1-T99/#731**) → **$25.375** · ★ **P39's ground truth,
  and R13 recorded FOUR more of exactly this shape**

### RETRO-1784626054083 (2026-07-21) — the console instrument + the ratification inbox + the governors (23 tasks shipped)

★ **Only 8 of 23 were LEDGER-CREDITED (30%) — and W1-T150, the fix for exactly this, merged FIRST
(#358).** That inversion was the cycle's finding and is mined as P35 (now folded into P38).
**★ FOLDED TO FAMILY LINES BY R14** — R13 set the doctrine (ids/PRs/costs preserved, descriptive prose
DELETED) and applied it to R11/R12; R14 applies it to the two sections R13 left half-folded.

- **FLOOR + VERDICT INTEGRITY — 4 tasks** (W1-T185/#456 · T178/#423 · **T128/#414, THE DEAD PROOF
  FLOOR — 101 of 126 runnable-dialect proofs could never execute, the ancestor of R14's T305/#1213** ·
  T177/#417) → $81.592
- **THE CONSOLE / LIVE-STATE FAMILY — 9 tasks** (W1-T153/#376 · T157/#405 · T158/#410 · T181/#411 ·
  T179/#431 · T154/#388 · T155/#365 · T156/#398 · T187/#445) → $82.579
- **THE P25 RATIFICATION INBOX, END TO END — 3 tasks** (W1-T110/#368 · **T111/#373, the approval
  telemetry whose counter has now read `3/11/21%` FIVE times byte-identically — P40(ii)** · T192/#457)
  → $42.847 · ★ **P25 CLOSED**
- **CREDIT + THE PLAN-PR EMITTER — 3 tasks** (P30's level-triggered credit backfill W1-T150/#358 —
  merged FIRST, and 15 gate-side merges followed it, see P35 · T136/#437 · T119/#382) → $22.980
- **LAYERED KNOWLEDGE + THE GOVERNOR PAIR — 4 tasks** (W1-T145/#360 · T146/#371 · T121/#385 ·
  T122/#386) → $17.390

### RETRO-1784556575522 (2026-07-20) — the W3 panel + the console + the intake lane (21 tasks shipped)

★ **13 of these were LEDGER-CREDITED** — the first non-zero credit column since R7. The rest are P30
residue: the PR merged, the run verdict never said so. **★ FOLDED TO FAMILY LINES BY R14.**

- **THE W3 PANEL + PLAN VERBS — 6 tasks** (W3-T5/#300 $16.141/154t, the cycle's most expensive run ·
  **W3-T8/#305 $15.713/110t, panel SKILL actions — the family whose `panel-skill-run` POST route is
  still unregistered, a P38 instance four cycles old** · W1-T45/#303 · W3-T6/#302 · W1-T43/#301 ·
  W1-T138/#345) → **$81.536**
- **THE `rmd serve` CONSOLE FAMILY — 3 tasks** (W1-T139/T140/T141 → #334/#338/#346) → $20.593 · 304t
- **THE INTAKE LANE — 5 tasks** (W1-T41/T43/T55/T56/T57 → #291/#301/#310/#315/#314) → $36.270 · 391t
- **W3-T2** — dashboard v0, read-only live board over the api-client → #294 · $7.361 · 96t
- **SECURITY + HYGIENE — 4 tasks** (W1-T61/T66/T67/T131 → #320/#323/#324/#341) → $13.994 · 152t
- **TRIAGE + PLUMBING — 3 tasks** (W1-T52/T53/T59 → #308/#309/#318 — **T52 was the FIRST
  `diagnose`-typed run ever to reach calibration; R14's T303/#1208 is the second**) → $11.780 · 153t

### RETRO-1784512714705 (2026-07-19) — the knowledge holes + the fleet remainder (28 merges)

★ **EVERY entry below is a GATE-SIDE merge** — W1-T51/#97's union half is the sole reason they are here.
Not one was ledgered `verdict=merged`: the run-verdict column was wrong 28/28. That blackout is P30.

- **W1-T132/T115/T108 — FOLDED (R12)**: three entries that carried an id, a PR number and a price and
  no description at all — a SHIPPED log line with no claim in it is a ledger row in the wrong file →
  craigoley/remudero#282/#279/#274 · $21.179 total · 159 turns · all gate-side
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
- **THE REMAINDER — 7 tasks, FOLDED to one line BY R16** (four entries whose per-task prose said only
  "the first W2/W3 task to land" or restated the task title, plus a fold R12 had already made):
  **W2-T3**/#242 · **W3-T1a**/#212 · **W1-T27**/#204 (`rmd project init`) · **W1-T97/T98/T102/T103**
  → #197/#199/#194/#196 · **$33.918 total** · 444 turns · all gate-side

### RETRO-1784383376396 (2026-07-18) — flight control + the PR-pipeline reconciler (14 merges)

**★ FOLDED TO FAMILY LINES BY R13** (ids/PRs/costs/turns preserved, per-task prose DELETED).

- **THE P22 FIX/CLARIFY FAMILY — 5 tasks** (W1-T76/#158 $9.701/148t, the blocked_review FIX RUNG that
  absorbed **P21** verbatim · T78/#168 $21.066/215t, the CLARIFICATION-QUESTION rung · T94/#166
  $5.470/53t · T95/#167 $4.503/70t · T93/#165 $2.599/30t)
- **FLIGHT CONTROL, ALL FOUR LAYERS — 4 tasks** (W1-T20/#132 $3.619/42t tripwires → T21/#141
  $6.829/77t the flight judge → T22/#142 $3.065/50t risk bands → W2-T1/#145 $3.317/31t the specialist
  panel) · **the Calibration section's burn-rate signals key off Layer 1**
- **THE REMAINDER — 5 tasks** (W1-T100/#173 $19.270/175t, blocked_ci → the ci-log fix path · T80/#159
  $4.319/72t, an OPEN PR means IN-FLIGHT · **T75/#138 $5.532/87t, operator corrections made SUPREME in
  `deriveStatus` + `rmd correct` — the writer P33's quarantine list extends** · T20d/#140 $3.879/61t,
  the retro plan-health sweep · T26/#176 $4.464/92t, the architecture-fitness tier)

### RETRO-1784213948025 / RETRO-1784206755808 (2026-07-16) — the deterministic floor, the gather union, the reviewer mount

**★ FOLDED TO FAMILY LINES BY R13** — these were the last sections still carrying full per-task prose,
i.e. the plan's OLDEST entries were its most verbose. Ids/PRs/costs/turns preserved, prose DELETED.

- W1-T65/#122 $7.123/94t — ★ **the deterministic FLOOR executes whitelisted proofs against the PR
  head**, so the gate is correct whether or not the LLM reviewer completes (ratifies **P15**; closes
  the FALSE-PASS/FALSE-BLOCK blind-floor hole) · W1-T63/#104 $6.938/101t (P10) · W1-T60/#105
  $6.013/98t · W1-T51/#97 $4.343/64t — ★ **the gather unions ledger∪GitHub** (**P11**), the mechanism
  every SHIPPED-log "gate-side merge" line above depends on · W1-T17/#99 $3.797/62t — the isolation
  preflight probe (FIELD FINDING 11b; the probe P41 wanted hoisted — P41 RETIRED by R14)

### RETRO-1784155126258 (2026-07-15) — the security tier + the dep lane + the first integrity fix

- W1-T62/#93 $4.107/75t — anchored PR_URL parse + run-ownership guard, **the ancestor of every
  ownership-assert rejection P29/P33 argue about** · W1-T54b/**#91** $2.951/18t · ★ **ATTRIBUTION
  CORRECTED — the ledger and that gather both name #80 (Dependabot's PR); that is FALSE, #91 is this
  run's output.** The residue is P33(iii)'s first quarantine entry · W1-T54/#87 (gate-side; the run
  ended blocked_review at $8.86/93t) · W1-T24b/#85 · W1-T23/#76 · W1-T24/#75 — all gate-side merges

### RETRO-1784133446353 (2026-07-15) — the 17 merges that CLOSED WS-1

- **THE WS-1 EXIT PROOF — 3 tasks drained by `rmd daemon` with no human in the loop**
  (SBX-T1/sandbox#6 $1.13/9t · SBX-T2/sandbox#7 $1.19/9t · SBX-T3/sandbox#8 $1.13/8t)
- **THE DAEMON + CLI CORE — 11 tasks** (W1-T12a/#61 $3.73/47t · T12b/#62 $3.58/58t · T12c/#63
  $3.21/53t · T11/#56 $3.78/62t · T9a/#53 $1.92/31t · T9b/#54 $2.83/45t · T9c/#55 $3.98/58t ·
  T14/#65 $2.18/41t · T15/#66 $1.81/22t — **§13's plan-sync flow, the one this very PR rides** ·
  T7/#48 $5.33/63t · T6/#47 $4.89/69t)
- **GATE-SIDE — 2 tasks** (W1-T5/#42, mounts.yaml v0 + Tier Invariant validation, unblocked by the
  rule-16 Architect fix #44 · T8/#49, escalations as GitHub issues + notifier + digest)
- **W1-T4** — HeadroomTracker v0 — /usage parser → craigoley/remudero#39 · $1.92 · 28 turns

### Earlier

- **THE REVIEWER + ESCALATION ORIGINS — 8 tasks, FOLDED BY R13** (W1-T1C/#11 $2.26/30t the reviewer
  worker + rubric · W1-T1D/#12 $1.28/21t its ENFORCEMENT wired into `run-task` — **rule 14's founding
  case, "the call site is a deliverable", which P38 is still arguing** · W1-T3 arc 5/5: #26 $2.99/37t,
  #27 $2.90/31t, #28 $2.64/42t, #29 $1.77/21t, #30 $3.73/31t, arc total $14.03/162t · W1-T3F/#35
  $2.31/21t, the rule-16 correction that made the reviewer verify REPO STATE · **W1-T19/#34 $4.05/49t
  — the Promptsmith LEARNINGS injection, i.e. the READ side of the compounding thesis whose WRITE side
  P38's TASK A is still trying to build**)
- **THE FIRST GREEN LOOP — 3 tasks** (WS-0 spike/#1 $0.86, 7/7 verdicts GREEN, ground truth in FIELD
  FINDING 10 · SB-HELLO/sandbox#2 $0.41 · CI-GREEN-PROBE/#5 $0.44)

## Calibration (observed — through RETRO-1786578394991, 2026-08-12)

The empirical baseline **mounts.yaml (W1-T5, shipped #42; risk/class routing since W1-T167/#606)** and
Flight-control burn-rate signals (§4B Layer 1, BUILT — W1-T20/#132) key off.

**★ CURRENT BASELINE — this cycle (RETRO-1786578394991, 34 runs). This is the row W1-T5's mount table
keys off. ★ READ IT AS A WINDOW, NOT A TREND POINT: this population was re-derived from an all-time
marker and OVERLAPS no prior baseline cleanly (task range W1-T388–T410). Turn coverage is stated
because R17-1 requires it: 12 of 12 shipped runs report nonzero turns (100%), with TASK D UNBUILT:**

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | 34 | 7 | $5.163 | 99.706 | $175.550 |

**BY TASK CLASS — the W1-T167 routing question (is the class-routed mount discount paying off?).
★ ONE ROW ONLY: last cycle's `plan-lint`/haiku contrast VANISHED at n=1, the eighth time a contrast
row has appeared and disappeared. The question stays UNDER-SAMPLED, never re-based:**

| task_class | runs | merged | merge rate | avg $ | avg turns | total $ |
|---|---|---|---|---|---|---|
| src | 34 | 7 | 21% | $5.163 | 99.706 | $175.550 |

**BY MODEL CLASS — weekly-limit burn (W1-T250/#898; P34 clause (d): burn is share of the weekly LIMIT,
never imputed dollars — the dollar column is context only). ★ BACK TO ONE ROW, and note the SECOND
denominator split below the table:**

| model | runs | turns this week | share of weekly burn | $ this week (context only) |
|---|---|---|---|---|
| sonnet | 24 | 2549 | 100.0% | $132.773 |

**Prior cycles (FOLDED — trend only):** R17 64 runs / 5 ledger-merged (27 real) / $3.502 / 17.8t
(turn column 46% dark — do not use) · R16 36 runs / 12 ledger-merged (25 real) / $6.201 / 83.1t ·
R15 47 / 14 (25 real) / $8.327 / 116.2t · R14 48 / 10 (25 real) / $3.812 / 36.2t · R13 34 / 16 (22
real) / $4.915 / 9.4t (turn column blacked out — do not use) · R12 54 / 4 (25 real) / $5.139 / 7.8t ·
R11 147 / 20 (94 real) / $6.664 / 8t (turn column blacked out — do not use) · R10 27 / 8 (23 real) /
$10.650 / 86.6t · R9 26 / 13 (21 real) / $7.682 / 81.4t · R8 195 / 0 (28 real) / $1.258 / 14.7t —
**churn-poisoned by the W1-T1 spin loop and never to be re-based on** · **R1–R7 FOLDED TO ONE LINE BY
R15** (91 runs / 47 merged, $1.838–$5.794/run, 21.4–72.2t — pre-fleet, trend only).
**Derived all-time:** ~769 runs, ~366 merged.

**Reads:**
- **★ THE PRICE PER SHIPPED TASK IS $14.63, AND IT MAY NOT BE COMPARED TO $8.302.** $175.550 / 12.
  The prior series (per SHIPPED task $15.66 → $8.930 → $8.302) was computed over marker-delimited
  cycles; this window was re-derived over a DIFFERENT population that no earlier retro measured, so a
  cycle-over-cycle read here would be comparing two samples, not two periods. **Recorded as a level,
  not a move** (P43(ii)). The standing rule is unchanged and is why the distinction matters: compare
  cost-per-SHIPPED-TASK, never merge rate and never cost-per-run — and only across comparable windows.
- **★ TURN COVERAGE 12/12 (100%) — REPORTED BECAUSE R17-1 DEMANDED IT, NOT BECAUSE IT WAS FIXED.**
  Every shipped run here reports real turns (61–256). TASK D (P40(i)) is UNBUILT, so this says the
  marker happened to select lit runs, not that a dark instrument was repaired. **P40(i) stays OPEN.**
  Read the two windows together and the shape is plain: R17 read 46% coverage and this window 100%
  over overlapping wall-clock — the coverage is a property of the SELECTION, which is the defect.
- **★ P40(ii) UNPAID FOR A SIXTH CYCLE, NOW VISIBLE IN TWO INSTRUMENTS AT ONCE.** The weekly model
  table reports **2549 turns over 24 runs** against this cycle's **34**; and ratification telemetry
  reads **0 approved / 0 reframed / 0%** on the window while the cumulative counter still reads
  **3 / 11 / 21%** (unchanged for an EIGHTH reading). Same counter, two irreconcilable denominators —
  the windowing has never shipped, and it is now the ONLY defect this plan has observed in five
  distinct shapes.
- **LEDGER CREDIT: 7 of 12 (58%).** Inside the metric's own ten-cycle range (0%–64%), so
  **UNATTRIBUTED** for the fifth consecutive cycle. The five gate-side merges are exactly the five
  `blocked_*` runs — this window's clearest single fact.
- **★ THE CLASS CONTRAST VANISHED AGAIN.** 34 of 34 classed (P40(a) closed, seventh cycle) and ALL of
  them `src`; last cycle's `plan-lint`/haiku row is gone at n=1. Eight cycles, four contrast rows,
  none surviving to n=5 — **the routing discount is under-sampled, and the standing no-re-base rule
  is doing its job rather than failing to answer.**
- **★ MAST distribution (W1-T89/#710): verification 19, the sole mapped category · 8 runs UNMAPPED
  (`incomplete`×6, `blocked`×2) = 24%.** Down from 36% with **P40(iii) still UNBUILT**, therefore
  **UNATTRIBUTED in both directions** — and `incomplete` is again the dominant unmapped class for a
  sixth consecutive cycle, which is what TASK E (below) exists for.
- **GUARD-FIRED BLOCKS: 0 FOR A SIXTH CONSECUTIVE CYCLE.** No infrastructure events. **P41 stays
  RETIRED and does not re-arm.**
- **The $100 `budget_usd` tripwire: 0/34 trips**, eighth cycle running. Peak run **$23.043**
  (W1-T406), 4.3× below the constant. P44's argument strengthens with every quiet cycle: a tripwire
  nothing has approached in eight cycles is not measuring runs.
- **A retro must not average over a spin loop** — R8's lesson, kept because it is cheap to keep and
  expensive to relearn. **17 credit-rejected runs entered this table unannotated**, and **10 of them
  are the same task's own earlier dispatches**, averaged into `avg $` as if they were independent
  samples of what delivery costs. **P29(iii)** (annotate credit-rejected runs before they reach the
  mount table) is still unbuilt and is now the cheapest correction available to the mount table.

## Retro proposals (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)

**★ LIVE RANKING (the ONE place open proposals are ordered).** `P47 > P38 > P40 > P48 > P43 > P33 >
P42 > P46 > P39 > P45 > P44 > P17 > P26` *(P48 rank PROPOSED by its session-mined entry below,
pending ratification)*. **P29 LEFT THE RANKING 2026-08-07** — both clauses shipped in #349; the
tombstone below keeps only the durable lessons. Every proposal has exactly ONE canonical entry below,
updated IN PLACE with each cycle's evidence — a retro that adds a second entry restating a proposal it
did not change has failed the HARNESS-COMPRESSION bar. **P28 and P41 are RETIRED** (tombstones only,
full prose deleted); **P29 is CLOSED — shipped, not abandoned**; **P35 is FOLDED into P38**.
**★ R18 MOVES NOTHING AND MINTS NOTHING.** Credit 19% → 58%, unmapped 36% → 24%, turn coverage 46% →
100% and rejections 18 → 17 all moved with their proposals UNBUILT **and over a re-derived
population**, so every one is UNATTRIBUTED twice over and the standing rule — *the plan does not
re-rank on unattributed moves* — binds harder than usual. **No new number:** the self-redispatch /
foreign-proper conflation is **P47's own counter** (with **P43**'s attribution question attached, for
the third consecutive cycle); the 5-of-7 `blocked_*`-with-merged-PRs ratio is the standing fold-line
below plus **P30**'s edge-triggered credit hole; the unlogged window is **P40(ii)**'s windowing defect
in its fifth shape; the frozen corpus swallowing a clean 7-run procedural shape is **P38**. R18 adds
EVIDENCE IN PLACE plus **ONE new TASK (F)**, under P47.

**★ THE STANDING CREDIT-ARTIFACT FOLD-LINE (one home, replacing five cycles of per-cycle
restatements).** In every retro from R8 on, the dominant "failure" verdict classes — `blocked`,
`blocked_ci`, `no_pr`, `incomplete`, `pr_attribution_failed` — have been predominantly WRITE-SIDE
CREDIT ARTIFACTS, not task defects: the work merged gate-side and the ledger did not record it.
R8 0-of-28 credited · R9 13/21 · R10 8/23 · R11 20/94 · R12 4/25 · R13 16/25 · R14 10/25 ·
R15 14/25 · R16 12/25 · R17 5/27 · **R18 7/12**. They are therefore NEVER re-mined as classes — doing
so manufactures many proposals from one root cause, the accretion failure mode P8 named. They route to
**P29/P30/P33/P39/P47** and, for the reading defect, **P38**. A future retro adds evidence to THIS
line, never a new bullet. *(The series now spans TEN cycles and ranges 0%–64% with no monotone trend
— read it as a NOISE BAND, not a trajectory. That is P43(ii), and it is why R14 refused to call 40% a
regression, R15 refused to call 56% a fix, and R16 refuses to call 48% anything at all.)*
  **★ R18 — THE DIRECT MEASUREMENT THIS LINE HAS ASSERTED FOR TEN CYCLES AND NEVER COMPUTED.** Every
  prior entry argued the claim from the credit RATIO. R18 computes it per-verdict instead: **of 7
  `blocked`/`blocked_ci` runs, 5 have MERGED PRs** — W1-T394/#1492, T397/#1495, T398/#1505,
  T406/#1559, T410/#1591 — i.e. **71% of this window's hard-failure verdicts are write-side credit
  artifacts, mechanically, not by inference.** That is the strongest form of evidence this line has
  ever carried and it is why `blocked_*` is again not mined as a class. Registered as R18-4 with its
  own falsifier, because a claim this load-bearing should be able to die.
  **★ 2026-08-07 — A BOUND ON THE NEW DEFECT, RECORDED SO IT IS NOT MIS-CITED AS THIS BAND'S CAUSE.**
  The uncreditable-branch defect W1-T390 files is **RARE AND CLUSTERED, not ambient**: over the 100
  most recent closed PRs (#1341–#1451) there are **37 merged `run-*` branches and exactly TWO are
  slug-form** — #1386 and #1391, merged 40 minutes apart on 2026-08-05, one actor in one session. It
  therefore **does NOT explain this band**, and no retro may cite it as such: two PRs cannot account
  for nine cycles of spread, and saying otherwise is precisely the unattributed-cause error P43(ii)
  exists to forbid. What earns that task is the FAILURE MODE, not the frequency — the credit is lost
  PERMANENTLY with no self-correcting path, and this single occurrence produced BOTH escalations open
  on 2026-08-07. The same discipline applies to the W1-T149 correction's own root: the SHIPPED log
  records `T145/#360`, `T146/#371`, `T148/#839`, `T150/#358` and `T151/#845`, with **T149 the only gap
  in that run** (T150 is P30, W1-T149's own sibling, merged a day later) — **ONE dropped entry, not a
  broken log.** Both bounds are stated because the standing temptation with a vivid defect is to
  promote it into an explanation for everything unexplained nearby.

**RETRO-1786578394991 (R18, this cycle)** — mined from 34 runs / 12 shipped tasks / 12 merged PRs / 7
ledger credits (`no_pr`×14, `incomplete`×6, `blocked_ci`×5, `blocked`×2, plus **17 rejected trailers
the gather labels FOREIGN, of which 10 are the task's OWN later run**). **ZERO new P-numbers are
mined.** The failure classes are NOT re-mined as classes — and this cycle that refusal is EARNED
rather than asserted, because 5 of the 7 `blocked_*` runs demonstrably merged (fold-line above).
**ONE new TASK is proposed (F), under P47.** **STANDING: candidates are ratified by the Architect via
a tasks.yaml PR — rule 15, never auto-filed.**

- **★ TASK F (P47 — SPLIT THE REJECTION COUNTER BEFORE SHIPPING THE FIX; NEW THIS CYCLE).** GROUND
  TRUTH (mechanical, from this gather's discrepancy list): **17 rejected trailers, and the gather
  emits ONE word — `stale/foreign` — for two unrelated mechanisms.** Ten name a branch
  `run-<SAME task>-<different ts>` (W1-T393, T399 ×2, T400 ×2, T407 ×2, T408, T409 ×2): an earlier
  run refused because the merged PR belongs to a LATER dispatch of the same task — the
  ownership-assert working exactly as P29's lesson (a) requires, and **all of those tasks are credited
  at task level anyway**. Seven name a genuinely foreign branch
  (`claude/resolve-p27-findings-rnvu61` ×4 against W1-T388/T395, `claude/remudero-planning-clarify-142opb`
  ×2 against T401, `plan/close-t201` ×1) — the actual P47 defect, and the only seven a P47(i) refusal
  gate would prevent. **WHY THIS IS NOT A NEW P-NUMBER:** it is P47's own metric, mis-specified in
  precisely the way R17 struck P29's — *a number that cannot be attributed to the mechanism it names*
  — and shipping P47(i) against the merged counter would produce an unreadable effect, because a fall
  could be entirely re-dispatch behaviour. **WHY IT IS SEPARATE FROM TASK C:** C changes trailer
  emission and reading; F changes only what the gather PRINTS, has no runtime surface, and must land
  FIRST or C's effect is unmeasurable. PROPOSE: **(i)** the discrepancy resolver classes each rejection
  as `rejected.self_redispatch` (offending head branch matches `run-<same task>-*`) or
  `rejected.foreign` (anything else) and the gather prints **two labelled counters, never a sum**;
  **(ii)** a `self_redispatch` rejection additionally reports whether the task was credited by some
  other run, so the line distinguishes *lost credit* from *bookkeeping*. GOLDEN (fixture-only, no live
  dep): a seeded pair whose offending branch is `run-X-2` against run `run-X-1` renders
  `rejected.self_redispatch` and, when X is credited elsewhere, `credited_elsewhere: true`; a seeded
  pair on `claude/whatever` renders `rejected.foreign`; a gather with both renders **two counters and
  no combined total**; and a run of ten self-redispatch rejections NEVER increments the foreign
  counter — the assertion that would have failed on this very window.

- **FAILURE MINING, `blocked`×2 + `blocked_ci`×5 — NO NEW PROPOSAL, AND THE REASON IS MECHANICAL.**
  Five of the seven merged (fold-line above). The residue is two runs, which is below any threshold
  this plan mines at, and both belong to tasks that shipped through a later dispatch. **`incomplete`×6
  and `no_pr`×14 route unchanged to TASK E and the fold-line.** What this window DOES add to TASK E:
  `incomplete` is the dominant unmapped class for a sixth consecutive cycle (×4, ×10, ×7, ×17, ×6) and
  the gather still names **not one run id** for it — the exemplar clause is the whole fix.

- **PROCEDURAL SUCCESS, MINED AND UNABSORBED FOR AN EIGHTH CYCLE (P38 evidence, no new task).** The
  miner surfaced a clean reusable shape — **`implement` × `clean_single_strike` × `fully_executed_proof`,
  7 runs (W1-T393, T399, T400, T401, T402, T407, T408)** — and LEARNINGS reads **74**, unchanged. This
  is P13's instrument working and P38's write path missing, for the eighth consecutive cycle, and it
  is now the single longest-running unbuilt finding in this file. Note the gather's own trap, recorded
  because it nearly became a false positive in this retro: it reports `74 now (74 added since marker)`,
  which reads as a full corpus and is a **MARKER ARTIFACT** — R18-3 re-registers the metric with an
  explicit prior count for exactly this reason.

**RETRO-1786537819709 (R17, prior cycle)** — mined from 64 runs / 27 shipped tasks / 27 merged PRs / 5
ledger credits (`incomplete`×17, `no_pr`×16, `blocked_ci`×15, `already_satisfied`×9, `blocked`×1,
`pr_attribution_failed`×1, **`failed`×0 for a third cycle**, plus **37 rejected trailers — 18 FOREIGN,
19 SIBLING**). **ZERO new P-numbers are mined** — see the ranking line above for why each finding
routed to an existing entry. **Three new TASKS are proposed (C, D, E), each under an existing
number.** The failure classes themselves are NOT re-mined as classes; they route through the standing
credit-artifact fold-line above. **STANDING FOR EVERY BLOCK BELOW: candidates are ratified by the
Architect via a tasks.yaml PR — rule 15, never auto-filed.**

- **★ TASK C (P47 — TRAILER EMISSION AND TRAILER READING, BOTH ENDS; NEW THIS CYCLE).** GROUND TRUTH
  (mechanical, from this gather plus `git log` on `main`): **W1-T419 shipped and the harness cannot
  see it.** Its work merged as **#1609** — *"feat(learnings): close the citation loop so retention
  rides measured use (W1-T419)"* — with the task id in the TITLE and **no `Remudero-Task` trailer in
  the squash commit at all**; simultaneously **#1617, on `feat/ratchet-names-compression-candidates`,
  carries `Remudero-Task: W1-T419`** and was rejected as foreign. One task, both failure directions
  at once: the WORK with no trailer, the TRAILER with no work. Independently, W1-T413's harvest names
  the reading half — ***"`deriveStatus`'s trailer search reads only the PR body, never the squash-merge
  commit message"***, while the emitter (`plan-pr-emitter.ts`) writes it into the body and this repo's
  merge flow sometimes edits the squash message separately. Cycle cost of the emission half: **17 runs
  across 5 tasks (W1-T369 ×4, T377 ×5, T378 ×5, T386 ×1, T412 ×2) shipped NOTHING**, every one
  rejected against a foreign trailer, and two of the five (T377/#1386, T378/#1391) are the slug-form
  `run-<task>-<slug>` branches W1-T390 already files as permanently uncreditable. **WHY THIS IS NOT A
  NEW P-NUMBER:** it is P47's thesis — *nothing governs who may emit a `Remudero-Task` trailer* — with
  a second, symmetric half now evidenced: nothing governs where it is READ from either, so the same
  task can be poisoned and dropped in one cycle. PROPOSE, and note it is deliberately SMALLER than
  P47's three clauses because clause (i) alone prevents this cycle's 17 wasted runs: **(a) the
  emitter writes the trailer into BOTH the PR body and the squash-merge commit message, and
  `deriveStatus` reads BOTH**, preferring the commit; **(b) a PR carrying `Remudero-Task: X` on a
  branch that is not `run-X-*` is REFUSED at creation unless it carries an operator-set
  `Remudero-Adopt: X`, ledgered `trailer.refused_unowned_branch`** (P47(i) verbatim, unchanged).
  GOLDEN (fixture-only, no live dep): a seeded merge whose body carries the trailer and whose squash
  message does not is CREDITED, and so is its mirror image; a seeded merge with the id in the TITLE
  only and no trailer anywhere is reported **`trailer.absent`, never silently uncredited** (P48(ii)
  applied to this reader — the W1-T419 case, which cost a hand-edit to this very log); a trailer on
  `feat/whatever` is REFUSED at creation and the same trailer on `run-X-<ts>` is ACCEPTED; the
  refused PR carrying `Remudero-Adopt: X` is accepted and credits X exactly once.

- **★ TASK D (P40(i) — TURN COVERAGE IS A DENOMINATOR, NOT AN AVERAGE; NEW THIS CYCLE, and the reason
  P40 rises to rank 3).** GROUND TRUTH (mechanical, from this gather): **12 of 26 union-listed shipped
  runs report nonzero dollars and EXACTLY 0 turns** — W1-T364 $14.451/0t, T387 $15.477/0t, T374
  $8.559/0t, T376 $8.799/0t, T372 $7.483/0t, T383 $6.884/0t, T409 $6.171/0t, T368 $5.119/0t, T373
  $4.539/0t, T379 $4.027/0t, T381 $3.658/0t, T380 $3.370/0t — and 4 more report $0.000/0t. The gather
  prints **`avg turns 17.781` over all 64 runs regardless**. A run that cost $14.451 did not take zero
  turns; **0 is UNRECORDED wearing a number's clothes.** THE DEMONSTRATED COST, which is what earns
  this a task rather than a note: **R16-1 was pre-registered against this exact metric and its
  nominal satisfaction (17.781 < 100) is worthless** — R17 must score it UNRESOLVABLE, and last
  cycle's `HIT` (R15-1), the only one this plan has ever recorded, is now known to rest on an
  instrument that can go dark silently. PROPOSE: **(i)** the calibration table prints TURN COVERAGE
  (runs with nonzero turns / runs, and separately runs with `cost > 0 ∧ turns = 0`) beside every turn
  figure; **(ii)** it **REFUSES to print an average** whose coverage is below a policy threshold,
  emitting `turns: UNMEASURED (12/26 shipped runs report $>0 with 0 turns)` instead of a number;
  **(iii)** a run with `cost = 0 ∧ turns = 0` is classed `unrecorded`, distinct from a genuine zero.
  This is P48(ii) — no naked zero — applied to the retro's OWN instrument, which is the fairest place
  to prove the proposal works. GOLDEN (fixture-only, no live dep): a seeded ledger where every run
  reports turns prints the average with `coverage 100%`; a seeded ledger where a third report 0 turns
  against nonzero cost prints UNMEASURED and NAMES the count, and a test asserts the numeric average
  is absent from the output; a seeded run at $0/0t renders `unrecorded`, not `0`.

- **★ TASK E (P42(i)/P40(iii) — NAME THE `incomplete` RUNS; NEW THIS CYCLE).** GROUND TRUTH: MAST
  UNMAPPED rose **19% → 36%** — **`incomplete` ×17 and `blocked` ×1 of 64 runs** — and `incomplete`
  has been the dominant unmapped class for five consecutive cycles (×4, ×10, ×7, ×17) while the
  mapping has never had a row for it and the gather has never named a single one of its run ids. This
  is P42(i) with the target moved: R12 filed it against `failed` (now zero for three cycles) and the
  blind population simply relocated. PROPOSE: **(i)** for any verdict class exceeding a policy share,
  the gather emits up to N exemplar runs with run id, task and the first termination line ALREADY in
  the ledger — deterministic extraction, no LLM, no new instrumentation; **(ii)** `plan/mast-mapping.yaml`
  gains rows for `incomplete` and `blocked` **derived from that termination line rather than guessed**,
  and a class it cannot derive is emitted as `unmapped(<class>)` naming the class, never folded into a
  silent remainder. GOLDEN (fixture-only, no live dep): a seeded ledger whose `incomplete` share
  crosses the threshold emits exactly N exemplars carrying run id, task and first error line; a class
  below threshold emits none; a seeded run whose termination line matches no mapping rule renders
  `unmapped(incomplete)` with the line quoted, and the same run with a matching rule renders its
  category.

**RETRO-1785992364048 (R16, prior cycle)** — 36 runs / 25 tasks / 25 PRs / 12 credits (`blocked_ci`×9,
`incomplete`×7, `no_pr`×7, `pr_attribution_failed`×1, 10 rejected trailers — 4 FOREIGN, 6 SIBLING).
Mined ZERO new numbers; proposed **TASK B**. *(★ R17 COMPRESSION — R16's plan-health corrective batch
is DELETED, not folded: NET STATE recorded it REFUSED on 2026-08-07 (all 19 proofs were on
`verify: human` tasks and were rewritten in the `demonstration:` dialect instead), and this cycle's
plan-health sweep reads CLEAN, so the bullet proposed work that will never be done against a finding
that no longer exists. R16's "everything else is evidence" bullet is likewise DELETED — the routing it
carried is restated for the CURRENT cycle in the ranking line above, and keeping one per retro is the
per-cycle restatement this section forbids.)*

- **★ TASK B (P38 — RECON CARRYOVER; proposed by R16, UNBUILT).** GROUND
  TRUTH (mechanical, from R16's gather): **six tasks consumed 16 runs to ship 6** — W1-T343 ×5, T342
  ×3, T349/T350/T353/T356 ×2 each — and the follow-up harvest proves the repetition is VERBATIM, not
  incremental. Three separate W1-T342 runs each independently filed *"read `test/cost-governor.test.ts`
  and `test/daemon-plan-freshness.test.ts` in full before implementing, to find existing
  harness/fixture patterns"*. Four separate W1-T343 runs each filed a `[task]` bullet amounting to
  *"implement W1-T343 per its task file — dependencies are all merged and unblocked, ready for the
  implement stage"*, and three of them ALSO re-derived the same `dispatchLanes: 2` vs *"ships dark at
  default 1"* policy conflict from scratch. W1-T353's two runs both filed *"implement the
  `ruling-verify` LintCheck per the design section — this recon only confirms scope."* THE DEFECT: §1
  specifies recon output as **TTL'd**, and nothing survives the run that produced it, so a task whose
  first N dispatches die before opening a PR pays the full read cost N+1 times. **WHY THIS IS NOT A
  NEW P-NUMBER:** it is P38's missing write path with the audience changed from the corpus to the next
  dispatch — the same organ P46(iii) wants for task-file corrections and P47 wants for provenance.
  **WHY IT IS A SEPARATE TASK FROM TASK A:** A appends to LEARNINGS (durable, cross-task, gated); B
  writes a per-task, TTL'd, dispatch-local artifact that never enters the knowledge corpus, so they
  share a motive and no code. PROPOSE: a recon run's OBSERVED/INFERRED/COULDN'T-VERIFY output persists
  as a task-scoped artifact keyed `(task_id, plan_sha, head_sha)`; the next dispatch of the SAME task
  loads it and is instructed to VERIFY-AND-EXTEND rather than re-derive; the artifact INVALIDATES
  automatically when `plan_sha` or the task's declared `files:` change, so a stale read can never
  outlive its premise (which is P46's failure mode, and the reason this must expire rather than
  accumulate). GOLDEN (fixture-only, no live dep): a seeded second dispatch of a task with a valid
  prior recon artifact receives it in-prompt and its ledger line reads `recon.reused`; the same
  dispatch after a `plan_sha` change receives NOTHING and reads `recon.invalidated(plan_sha)`; a first
  dispatch reads `recon.absent` — **never a silent empty, which is P48(ii) applied to this organ**;
  and a task whose artifact exists but whose declared `files:` moved is invalidated, not reused.
  MEASUREMENT: R16-4 pre-registers runs-per-shipped-task among multi-run tasks at **2.67 → < 2.0**,
  conditioned on this task shipping, and explicitly names the confound (lanes went live this cycle).
  **★ R17 UPDATE — THE PRICE WENT UP AND THE HARVEST GOT MORE LITERAL.** R16-4 scores UNRESOLVABLE
  (TASK B unbuilt) and the observed figure ROSE: **26 runs / 9 multi-run shipped tasks = 2.89**. The
  duplication is again verbatim and now visible in the harvest's own words — W1-T414 filed *"Implement
  W1-T414 per the shard's design (i)–(v) — this recon confirms all premises hold"* on one run and
  *"Implement W1-T414 per its design section (i)-(v) — this recon only confirmed premises"* on the
  next; **four separate runs each independently re-diagnosed the same sandbox defect** (the macOS
  Keychain / BSD-`date` failures that make `rmd preflight --ci-parity` unreachable from a worker box,
  filed by T418, T416, T420 and T423). That last one is the sharpest yet: it is not task knowledge at
  all, it is ENVIRONMENT knowledge, identical for every task on that host, re-bought four times in one
  cycle. It also names TASK B's cheapest possible first slice — a host-scoped artifact, not even a
  task-scoped one.

- **★ P47 (plan + golden; RANK 1) — TRAILER EMISSION IS UNOWNED: THE HARNESS POISONS ITS OWN
  TASKS.** GROUND TRUTH (mechanical, R15's originating gather): of **22 rejected trailers, 12 were
  FOREIGN** — against **zero** the cycle before, when R14 had recorded P33's list as "stable and no
  longer compounding". All 12 belonged to four tasks (W1-T309, T314, T320, T324) and **every offending
  branch was created by the harness itself** — the `fix-*` names are the fix-rung's own out-of-band
  repair branches, the `claude/*` names a higher-tier splitter's. *(★ R17 COMPRESSION: the per-pair
  enumeration is DELETED — P33's quarantine list is the one home for `(pr, task)` pairs and carries
  all four.)* W1-T324's harvest watched it happen in real time: *"the platform closed a
  green-except-remudero-review PR mid-fix and independently re-solved it via a two-PR split within ~15
  minutes, while I was still iterating on the same PR."* THE DEFECT, stated precisely: **nothing in
  this harness governs WHO MAY EMIT a
  `Remudero-Task` trailer, or on what branch.** A repair actor writes the trailer to be honest about
  provenance, and in doing so permanently destroys the task's derivability — `deriveStatus` will
  report it uncredited forever and `nextRunnable` will re-select it every drain, which is exactly what
  billed **six** W1-T314 dispatches. WHY THIS IS NOT AN EXISTING NUMBER: **P33** is the CREDIT-side
  consequence and its remedy (a quarantine list) is a manual clean-up that this cause refills faster
  than an operator can drain it — R14's list was six and static; one cycle later it is ten and growing.
  **P29(i)** cannot help: sibling credit requires a `run-<task>-*` branch and these have none.
  **P39** refuses dispatch AFTER a merged owned-branch trailer exists; these trailers are never owned.
  P47 is the claim that **the emission itself needs a rule, upstream of every credit mechanism the plan
  has built.** PROPOSE, three clauses. **(i) TRAILER EMISSION DISCIPLINE (rule 2, deterministic)** —
  any PR carrying `Remudero-Task: X` must ride a branch named `run-X-*`, or carry an explicit
  operator-set `Remudero-Adopt: X` marker that the credit path honours as an ownership transfer. The
  fix rung, the splitter and every future repair actor either branch correctly or adopt explicitly;
  a trailer on an unowned, unadopted branch is REFUSED at PR creation, ledgered
  `trailer.refused_unowned_branch`. This is the cheapest clause and it alone prevents all four of this
  cycle's poisonings. **(ii) POISONING IS AN ESCALATION, NOT A SILENT REDISPATCH** — when a task's only
  trailered merged PR is foreign-branched, the task HALTS on the FIRST rejection and raises ONE
  `needs-human` question (*"adopt #1293 for W1-T314, or quarantine the trailer?"*), instead of paying
  for five more dispatches to rediscover it. This is P33(i)'s terminal-rejection class, and P47 is why
  it must be built rather than kept as a list. **(iii) A LIVE-DISPATCH RACE CHECK** — a repair or split
  actor consults the claims/in-flight state before opening a competing PR for a task that has a running
  dispatch; W1-T324's worker and the splitter were editing the same PR simultaneously, and W1-T326's
  harvest records the mirror-image race (*a fix round dispatched against a branch whose PR had already
  merged*). GOLDEN (fixture-only, no live dep): a seeded PR carrying `Remudero-Task: X` on branch
  `fix-x-scope` is REFUSED at creation and the same PR on `run-X-<ts>` is ACCEPTED; the same unowned PR
  carrying `Remudero-Adopt: X` is accepted AND credits X exactly once; a seeded task whose only merged
  trailer is foreign HALTS on the first rejection with exactly one escalation and **zero** further
  dispatches (the W1-T314 ×6 regression lock); a repair actor opening a PR for a task with a live claim
  emits the race warning rather than the PR. DEPENDENCY: build (i) BEFORE P33's quarantine list — a
  list drained by hand against a cause that refills it is the half-fix P9 already taught this plan not
  to ship twice.
  **★ R16 UPDATE — THE COUNT FELL, THE AUTHOR SET WIDENED, AND THE WIDENING IS THE FINDING.** Foreign
  rejections read **4 of 10** (12 → 4) with P47(i) **unbuilt**, so per R15-2's own condition the fall
  is **UNATTRIBUTED** and P47 does not move. What DID change is decisive for how clause (i) must be
  written: **all four belong to ONE task (W1-T343) and all four name #1361 on branch
  `plan/dispatch-lanes-back-to-1`** — a **plan-only PR of exactly the shape this retro ships**, opened
  to walk `sweep.dispatchLanes` back to 1 so W1-T343 could land dark. R15 framed the class as *"the
  harness's own REPAIR and SPLIT machinery"*; that framing is now too narrow. The plan-sync lane is
  not repairing anything — it is legitimately editing the policy row the task is about, and the
  trailer follows the SUBJECT MATTER rather than the work. **Therefore clause (i) must key on BRANCH
  OWNERSHIP alone and must NOT carve an exception for "actors that plausibly own the topic"**, because
  every poisoning in two cycles has come from an actor with a plausible topical claim. Cost this
  cycle: W1-T343 took **5 dispatches** to ship #1363, and 4 of those were rejected against #1361.
  P33's list goes **10 → 11** with the pair `(#1361, W1-T343)`. Second-order note for clause (iii):
  W1-T343's own harvest asked an operator to *"merge #1361 before or alongside W1-T343's
  implementation"* — the race clause (iii) describes was **seen and written down by a worker**, and
  rule 15 correctly forbade it from acting.
  **★ R17 UPDATE — THE PROPOSAL WAS HALF-STATED, AND THE MISSING HALF COST A WHOLE SHIP.** Foreign
  rejections **4 → 18** (R17-2 registers the next reading; the series 0 → 12 → 4 → 18 with nothing
  built is a NOISE BAND, and no retro may call any of those moves an improvement or a regression).
  **17 runs across 5 tasks bought ZERO ships** — W1-T369 ×4 (`claude/w1t369-proof-debt-lock`),
  T377 ×5 (`run-W1-T377-open-pr-corroboration`), T378 ×5 (`run-W1-T378-reaper-activity-gate`),
  T386 ×1 (`claude/resolve-p27-findings-rnvu61`), T412 ×2 (`claude/remudero-planning-clarify-142opb`).
  Note what two of those five are: **slug-form `run-<task>-<slug>` branches**, i.e. the harness's OWN
  naming, which W1-T390 files as permanently uncreditable — so clause (i)'s `run-X-*` glob would ACCEPT
  them and the credit path still rejects them. **Clause (i) must therefore be written against the
  branch pattern the credit path actually enforces, not the one the plan says it enforces**, and TASK
  C makes that explicit. **THE MISSING HALF, and it is why P47 holds rank 1:** every clause here
  governs EMISSION, and W1-T419 proves the reader is equally ungoverned — **#1609 merged this task's
  work with the id in its TITLE and no trailer anywhere**, while **#1617 on a foreign branch carried
  the trailer**. An emission rule alone would not have credited W1-T419; only TASK C's reading half
  does. P33's list goes **11 → 13** with `(#1617, W1-T419)` and `(#1420, W1-T369)`.

- **★ P48 (plan + golden; NEW — session-mined `oper#outcome-proposal-2026-08-05`, NOT a retro mint,
  PENDING RATIFICATION: an agent may RECOMMEND a direction but may never RECORD one — the operator
  ratifies) — ZERO IS OVERLOADED: A BOUNDARY READ'S EMPTY ANSWER MUST SAY WHICH EMPTY IT IS, AND NO
  NAKED ZERO ENTERS A DECISION WITHOUT A POSITIVE CONTROL.** GROUND TRUTH (mechanical, from the
  2026-08-05 census in state/research-laws-and-gaps-2026-08-05.md, re-derived at 0332dd0): **21
  recorded instances** across six mechanism classes of one defect shape — a reader whose only
  vocabulary for trouble is the count itself, so "empty because absent", "empty because my query was
  malformed", and "empty because the source moved or died" are indistinguishable. Four instances
  landed in the last 24 hours; THREE measurements were retracted in one day when the gzip event made
  every `ledger.*.ndjson` glob silently answer from the live file (~2.8% of history). The class has
  three faces: undercount-as-answer (21 of 23 rows); **self-hiding observability** — guards and
  ledger lines gated on `count > 0` write NOTHING in the zero case, so every census discovery was a
  human doing arithmetic and NONE was a gate; and absence-as-success, the inverse sign (a zero
  name-filter match once ran the WHOLE suite, #1111). PREDICTION the proposal is judged against: the
  next instance is triggered by an environment shift a query predates — format change, quota, rename
  — not by a code edit. WHY THIS IS NOT AN EXISTING NUMBER: **P38** is the dead-CONSUMER class (an
  organ that merged and may not RUN); P48 is the live-READER class — a wired, running, calm-weather
  reader answering WRONGLY, which P38's liveness proofs would score healthy. **P46** is a premise
  wrong at FILING time; P48's readers were right when written and falsified later by the world.
  **P43** governs how RETRO metrics are read; P48's instances blinded PRODUCTION decisions
  (re-dispatches, review verdicts, dedup) as much as measurements. Every remedy that stuck in this
  repo already has P48's shape, built locally four times: `indeterminate`/`readFailed` (status),
  throw-on-gateway-failure (the reconciler fix), `base_unknown` (W1-T362's design), fallback
  provenance (`PolicyError`). PROPOSE, two clauses — **and (ii) is the load-bearing one: a type
  alone still permits a caller to collapse `absent` into `found: []`; the control requirement is
  what stops it. A ratification that ships only clause (i) satisfies the letter and fixes nothing.**
  **(i) THE OUTCOME TYPE** — a boundary read returns
  `found | absent | query_invalid | source_unreachable`, never a bare count or collection.
  **(ii) NO NAKED ZERO** — any zero or empty that feeds a decision (a guard, a dedup, a verdict, a
  published figure) must be accompanied by a positive control proving the reader CAN see: a control
  pattern that must match, a `zgrep -l` naming an archive, a seeded fixture the query must find.
  FIRST TRANCHE, scoped by a stated criterion — **a boundary qualifies when it has a RECORDED census
  instance AND no second channel at head** (everything else WAITS for an instance; this proposal
  REPLACES the per-instance patch treadmill and forbids further bespoke silent-zero filings outside
  the criterion): (1) `parseAcceptanceBlock` (src/lib/review.ts — still returns a bare
  `AcceptanceCriterion[]` at 0332dd0; truncation is indistinguishable from a one-criterion body);
  (2) the proof resolver's zero-candidate path (`resolveNameFilteredCandidates`, partially channeled
  by #1111's three-answer refusal); (3) the ledger union — **W1-T379 (open, filed 2026-08-05) is
  this tranche's member, not a duplicate**: one verb that FAILS LOUDLY when no archive was read;
  (4) the sweep-survey truthiness gates (the `if (actionable.length)` class — the clone-reap survey
  instance is census-recorded; its current gate state UNVERIFIED at 0332dd0). The two
  already-converted GitHub-read boundaries (reconciler, status) are the pattern's existence proof,
  not tranche members. **THE FALSIFIER THIS PROPOSAL MUST CARRY IS ITS OWN ADOPTION RISK — Law 2
  eats Proposal 1**: an Outcome type is precisely the shape that ships, tests green, and is never
  consumed — one new organ (`resolveFeedbackExpansionMount`) shipped through the advisory floor THE
  DAY THIS WAS WRITTEN. Therefore every tranche task MUST carry a call-site criterion in the
  linter's own demanded form (`grep: <symbol>( in <consumer path>` — `callSiteViolations`,
  src/lib/task-linter.ts) AND a falsifier proving a caller DISTINGUISHES the cases — a fixture where
  `absent` and `query_invalid` produce DIFFERENT downstream behavior — never merely that the type
  compiles. GOLDEN (fixture-only, no live dep): a seeded body whose Acceptance block truncates
  mid-claim yields `query_invalid`-class output a caller visibly refuses, while a genuine
  one-criterion body yields `found`; a seeded ledger read against a directory of gzipped-only
  archives either names an archive in its control or FAILS, never answers live-only; a converted
  boundary's caller test fails when `absent` is collapsed into `found: []`. PROPOSED RANK 4
  (`P29 > P47 > P38 > P48 > P43 > …`), argued not assigned: above P43 because these instances
  blinded production paths, not only retro readings; below P38, five-cycles-priced and whose TASK A
  is the narrowest standing fix — the next retro or the operator confirms or moves it.
  **THE CENSUS IS GONE, AND THE 21 CANNOT BE RE-DERIVED FROM THIS ENTRY — established 2026-08-11,
  re-verified at d767c16, recorded HERE because the evidence must not rest on a `state/` path
  (CLAUDE.md).**
  `state/research-laws-and-gaps-2026-08-05.md` is unrecoverable: no mounted state volume in a fresh
  container, **never committed on any ref** (`git log --all -- state/` returns 0 commits, and
  `rev-list --all --objects` 0 objects by that name), and no tracked copy, backup or `.gz`. This
  entry is now its only carrier, and it carries the CONCLUSION but not the METHOD — the six
  mechanism classes are never enumerated, no predicate that selects an instance is stated, and the
  23-row denominator behind "21 of 23" is unexplained. **So FIRST TRANCHE's own criterion is
  inoperable**: "a boundary qualifies when it has a RECORDED census instance" cannot be evaluated
  against a census nobody can read. Ratifying this as written would ratify an uncheckable number.
  WHAT IS STILL CHECKABLE — the four named tranche members, re-verified at d767c16, which is what
  this entry can support on its own text: (1) `parseAcceptanceBlock` STILL returns a bare
  `AcceptanceCriterion[]` — unchanged since 0332dd0, OPEN; (2) `resolveNameFilteredCandidates` is
  CONVERTED — it now returns `NameFilterResolution = resolved | absent | unresolvable`, clause (i)'s
  exact shape, its own comment drawing the line ("Zero hits. Everything below decides whether that
  is EVIDENCE or IGNORANCE"); (3) the ledger union SHIPPED — W1-T379 merged as `rmd ledger-grep`
  (#1436, `src/lib/ledger-grep.ts`), so "open, filed 2026-08-05" above is STALE; (4) the sweep-survey
  gate, recorded UNVERIFIED above, is VERIFIED STILL OPEN — `if (actionable.length)` wraps the ONLY
  `log("daemon.clone_reap", …)` in run-task.ts, so a reaper that ran and found nothing and a reaper
  that never ran are identical in the ledger. **★ RE-FOUNDED 2026-08-12 AT `4c25957` — OPERATOR-DIRECTED (the operator ruled: re-found, do not
  restore the 21; a session may not ratify, so the PROPOSAL still AWAITS RATIFICATION — what is
  settled is the METHOD, not the adoption).** The blocker was never the missing number: the entry
  states a CONCLUSION AND NO METHOD, and two of its four tranche members have since been fixed
  WITHOUT the proposal being ratified, so its substance is being adopted while its membership rule
  stays inoperable. Membership no longer cites the census. **The 21 is NOT reconstructed.**
  **(1) THE MECHANISM CLASSES — SIX ARE NAMEABLE FROM LIVE EVIDENCE, AND THAT IS NOT A RECOVERY.**
  The census's own six are unknowable; these are RE-DERIVED at `4c25957`, each grounded in a citation
  that exists at head, and **the fact that six can be named is a COINCIDENCE OF COUNT, not evidence
  of identity with the census's six** — no future reader may treat the two lists as the same.
  (a) GLOB MISS AFTER A FORMAT CHANGE — a filename pattern that stops matching when the form moves
  (`ledger.*.ndjson` seeing zero `.gz`; `ledgerRotationEntries`, src/lib/ledger-grep.ts, exists
  because two globs each read half the corpus). (b) REMOTE READ FAILURE RENDERED AS EMPTY — a
  gateway error scored as "nothing there" (`indeterminate`, src/lib/status.ts; the reconciler's
  throw-on-gateway-failure). (c) PARSE TRUNCATION INDISTINGUISHABLE FROM A SHORT INPUT
  (`parseAcceptanceBlock`, src/lib/review.ts). (d) A NAME FILTER RESOLVING TO ZERO CANDIDATES
  (`NameFilterResolution`, src/lib/review.ts). (e) A TRUTHINESS GUARD ON A COLLECTION, whose zero
  case writes nothing — face 2's whole population. (f) ABSENT RENDERED AS A NUMERIC ZERO in a
  computed metric (`base_unknown`'s affirmative shape; the retro's 0-turn rows against real dollars).
  **(2) ONE PREDICATE PER FACE, EACH WITH ITS OWN CONTROL, MEASURED AT `4c25957`.**
  **FACE 1 — UNDERCOUNT-AS-ANSWER.** *Query:* an EXPORTED function whose declared return type is a
  bare collection or count (`T[]`, `number`, `Map<…>`, `Set<…>`) with no discriminated outcome, AND
  whose result is consumed by a caller that branches on emptiness. **Population 36**, of 224
  bare-returning exports. **CONTROL 126** exported functions that DO return a discriminated outcome
  (a `kind`/`status`/`ok` tag or a `| undefined` refusal) — the repo holds both shapes, so the query
  separates rather than sweeps. **It independently finds `parseAcceptanceBlock`**, the member this
  entry names by hand. **STATED LIMITATION, because this is a CALL-GRAPH question and only half of
  it is text:** the SIGNATURE half is exact (a declared return type is text), the CONSUMER half is a
  TEXT APPROXIMATION — it matches a caller that reads `.length` or tests the binding for falsiness,
  and will miss a consumer that reaches the zero through an alias, a destructure or a helper. Making
  it exact needs a TypeScript-compiler-API pass over the call graph; until someone writes that, this
  half UNDER-COUNTS and must never be quoted as a closed set.
  **FACE 2 — SELF-HIDING OBSERVABILITY.** *Query:* `if (<expr>.length <cmp>)` across `src/**/*.ts`
  where the comparison separates empty from non-empty (bare `.length`, `> 0`, `!== 0`, `=== 0`,
  `>= 1`, `< 1` — NOT `> 1`, which is cardinality), and EVERY statement in the consequent is a
  logging call, so the zero case writes nothing. **Population 12** of 204 same-shaped guards over 116
  files; 8 are semantic rather than emptiness. **CONTROL 184** identical-shaped guards whose
  consequent carries a non-log effect. **It independently finds the clone-reap gate**
  (`if (actionable.length)` wrapping the only `log("daemon.clone_reap", …)` in run-task.ts).
  **FACE 3 — ABSENCE-AS-SUCCESS: RECORDED INSTANCES ONLY, BY NAME. There is no predicate, and that
  is the honest answer, not a gap left open.** The face is behavioural — a zero that WIDENS scope
  instead of narrowing (the recorded case: a zero name-filter match once ran the WHOLE suite, #1111)
  — and "wider" is not visible in text. Membership here is by NAME with evidence, and a member joins
  only with a behavioural fixture showing the widening. **Recorded members: none open.** The one
  recorded instance is CLOSED: `narrowNameFilteredArgs` (src/lib/review.ts) still returns the whole
  `baseArgs` with `TEST_GLOB` on zero candidates, but `execWhitelistedProof` decides `absent` BEFORE
  reaching it, so the widening is now the deliberate fail-open on `unresolvable` alone. (A text scan
  for "emptiness test whose consequent widens" was tried and returns exactly that one site — recorded
  as CORROBORATION that the face is real, never promoted to the criterion: one hit with no live
  positive validates nothing.)
  **(3) THE CRITERION IS A UNION, NOT A SUBSTITUTE.** A boundary qualifies when it **MATCHES ANY
  STATED FACE PREDICATE and has no second channel at head** — and for a face with no predicate, when
  it is a **NAMED RECORDED INSTANCE carrying its evidence**. Faces 1 and 2 are decidable by anyone
  who runs the query; face 3 is decidable by reading its member list. Membership regenerates where it
  can and is honestly closed where it cannot. **A face-2-only criterion was REFUSED on measurement**:
  it returns ZERO guard-shaped hits for `parseAcceptanceBlock`, `resolveNameFilteredCandidates` and
  the ledger union, so it would have admitted one of four members and expelled three, including the
  tranche's clearest live instance.
  **(4) THE FOUR NAMED MEMBERS, RE-VERIFIED — AND THE COUNT CHANGED, 4 → 3.**
  (1) `parseAcceptanceBlock` **QUALIFIES**, face 1 (measured, in the 36) — still a bare
  `AcceptanceCriterion[]`, unchanged since 0332dd0. (2) `resolveNameFilteredCandidates` is
  **DISCHARGED, not a member**: it returns `NameFilterResolution` and sits in face 1's CONTROL of 126
  — zero hits in the population. The entry's "open, filed 2026-08-05" was stale. (3) The ledger union
  is **RELOCATED, not closed**: the VERB shipped and fails loud (`rmd ledger-grep`, W1-T379/#1436),
  but `ledgerRotationEntries` (src/lib/ledger-grep.ts) still returns a bare `LedgerCorpusEntry[]` and
  IS in face 1's 36 — closed at the verb, open one level down. (4) The sweep-survey gate
  **QUALIFIES**, face 2 (measured, in the 12).
  **(5) THE ENTRY'S OWN FIGURES CANNOT BE REPRODUCED — AND THAT IS THE STRONGEST ARGUMENT THIS
  PROPOSAL HAS, BECAUSE IT IS P48's DEFECT ONE LEVEL DOWN, INSIDE P48's OWN SUPPORTING SWEEP.**
  #1587 recorded OUTPUTS (83 guards / 10 log-only / 62 control) and never the QUERY. Re-derived from
  that prose, face 2 gives **204 / 12 / 184**; and the recorded 83 does not reconcile with itself —
  12 + 62 + 2 leaves **9 rows unaccounted**. Neither classifier can be preferred, because only one of
  them was written down. Every predicate above is stated in full FOR THAT REASON.
  **AND A CORRECTION TO THIS ENTRY'S OWN READING.** `if (outOfScope.length > 0)` (the push-and-flag
  path, #1585) was recorded above as a tenth face-2 instance arriving by CODE EDIT, in tension with
  the PREDICTION. Under the stated predicate it is NOT a member — its consequent logs AND CONTINUES,
  so it lands in the CONTROL — and the prediction is untouched by it.
  **★ R17 UPDATE — THE PROPOSAL'S SHAPE NOW SHIPS IN BOTH DIRECTIONS, WHILE THE ENTRY ITSELF STAYS
  UNRATIFIABLE.** **(1) CLAUSE (ii) IN THE AFFIRMATIVE, FROM THE GATHER ITSELF.** The mutation-gate
  rung (D-10/W1-T393) reports **`NO POSITIVE CONTROL: 0 verdicts recorded`** and says, in its own
  words, *"this is NOT 'zero escapes' — it is an unmeasured history … N=0, a stated limitation, never
  an empty result."* That is clause (ii) obeyed by a deterministic instrument BEFORE the proposal is
  ratified — the strongest existence proof this entry has, and it cost nothing but a sentence.
  **(2) CLAUSE (i) IN THE NEGATIVE, FROM THE RETRO'S OWN TABLE.** 12 shipped runs report **0 turns**
  against real dollars and the gather averages them in anyway: one value, two populations (a run that
  took no turns, a run whose turns were never written), one wrong answer. **TASK D is P48 applied to
  the retro's own instrument**, and it is the cheapest tranche member yet identified because the
  reader, the writer and the consumer are all in this repo. **(3) A THIRD TRANCHE MEMBER SHIPPED
  ALREADY:** `rmd ledger-grep` (W1-T379/#1436) is the union verb that FAILS LOUD when no archive was
  read — tranche member (3), now CLOSED, and the entry's "open, filed 2026-08-05" text above was
  already stale before this cycle. **(4) NOTHING CHANGES ABOUT RATIFIABILITY:** the census is still
  unrecoverable, the six mechanism classes are still unenumerated, and the selecting predicate is
  still unwritten, so FIRST TRANCHE's own criterion remains inoperable. What R17 adds is that the
  proposal no longer NEEDS the census to justify its first two tasks — TASK D and W1-T379 are both
  argued entirely from evidence inside this document.

**RETRO-1785778396449 (R14, prior cycle)** — 48 runs / 25 tasks / 25 PRs / 10 credits (`failed`×20,
`blocked_ci`×9, `blocked`×7, `no_pr`×2, 23 rejected trailers — ALL SIBLING). Mined **P46**; its
pre-registration is SCORED in NET STATE (**UNRESOLVABLE**).

- **★ P46 (plan + golden) — TASK PREMISES ROT BETWEEN FILING AND DISPATCH, AND NOTHING
  RE-CHECKS THEM.** GROUND TRUTH (R14): **MAST `specification` tripled, 5 → 20 (+15)**, the dominant
  failure category, behind five concrete instances of ONE shape. **★ R15 UPDATE — THE METRIC WENT TO
  ZERO AND THE PROPOSAL IS NOT DISPROVEN.** `specification` reads **0 of 47** with P46 unratified and
  unbuilt, so per P43(ii) the collapse is **UNATTRIBUTED** and P46 is demoted on URGENCY (rank 4 → 8),
  never on evidence: this cycle's harvest still names the shape — **W1-T324's own declared `files:`
  omitted the `plan/tasks.d/*.yaml` shards its design required editing**, which would have tripped
  `scopeGuardOutOfScopeFiles`'s fallback-push refusal for any worker dispatched through the automated
  pipeline. Clause (i) catches that for the price of a path lookup. **(a) FALSE ABSENCE CLAIMS:** W1-T302 was filed (in
  #1191, 2026-08-03) on the rationale *"no commits-ahead guard exists in src"*; the guard **shipped in
  PR #115**, ~1000 PRs earlier. Recon caught it and the acceptance criterion had to be re-scoped
  mid-flight; two separate runs then asked for a plan-PR correction and **neither was ever filed**.
  **(b) WRONG `files:` POINTERS:** W1-T306 and W1-T301 both declare `src/lib/status.ts` when the real
  target is `src/lib/status-board.ts`; W1-T288 declared only `serve.ts` when the edit required
  `src/lib/panel-actions.ts` — flagged by that task's OWN round-1 recon and re-discovered, at cost, in
  rounds 2 and 3. **(c) DRIFTED ANCHORS:** W1-T293's rationale cites a call site at line 590; it is at
  673. Every one of these is deterministically checkable and none is checked. §5C already owns the
  seam (*"Task pre-flight: the plan gate"*) and today lints SHAPE, never PREMISE. This is NOT P38 (an
  organ that merged and may not run), NOT P39 (a task whose work already merged), and NOT P45 (a
  prediction about how the work will fail): P46 is the claim that **the task file was already wrong
  when the worker read it.** PROPOSE, three clauses. **(i) `files:` EXISTENCE AT LINT** — every path
  in a task's `files:` must resolve on `origin/main` at filing time; lint-plan REFUSES otherwise.
  Cheapest possible check, and it alone catches (b). **(ii) NEGATIVE-CLAIM RE-VERIFICATION AT
  DISPATCH, NOT FILING** — a rationale asserting an ABSENCE (*"no X exists"*, *"N is unshipped"*)
  carries it as an executable grep in the same whitelisted dialect the floor already runs; the claim
  is re-run against the DISPATCH-time head and, if it no longer holds, the dispatch is REFUSED with
  `dispatch.refused_stale_premise` naming the contradicting file or PR. Filing-time truth is not
  dispatch-time truth — that is the whole lesson of #115 vs #1191. **(iii) A RECON CORRECTION IS A
  WRITE, NOT A NOTE** — when recon discovers a wrong `files:` or a dead premise, the correction lands
  as a plan-PR edit to the task file through the same gated write path P38's TASK A asks for, instead
  of a harvest bullet that the next three rounds each re-discover by hand. W1-T288 and W1-T302 are the
  same defect as the frozen LEARNINGS corpus: **a harness that can only WRITE code keeps paying humans'
  worth of tokens to re-derive facts it already knew.** GOLDEN (fixture-only, no live dep): a seeded
  task whose `files:` names a nonexistent path FAILS lint-plan and the same task with a real path
  PASSES; a seeded task whose rationale asserts an absence a fixture repo contradicts is REFUSED at
  dispatch naming the contradicting path, and the same task against a repo where the absence holds
  dispatches normally; a seeded recon that corrects a `files:` entry emits exactly one plan-PR-shaped
  edit, and a run whose harvest names a correction it did not write FLAGS.
  **★ R16 UPDATE — THE ROT IS NOW IN THE PLAN'S OWN RECORD, NOT ONLY IN TASK FILES.** MAST
  `specification` reads **0 for a second cycle** with P46 still unratified, so the metric stays
  **UNATTRIBUTED** and the rank holds. But the harvest names the shape in a place R14 and R15 did not
  look — the plan index itself. **Six `tasks.d` shards read `status: queued` while their work is
  MERGED on `main`** (W1-T273, T326, T345, T346, T348, T356), reported independently by four different
  runs, one of which spelled out the consequence: *"the planner may re-dispatch already-done work."*
  And **`src/lib/deployer.ts:206` still documents `reconstructState`/`reconstructOrphan` as running
  "unconditionally on every daemon boot"** when no call site substantiates it and `daemon.ts` records
  it RETIRED (W1-T361/#1403) — flagged by two separate runs and still uncorrected, because it fell
  outside both diffs' declared scope. This WIDENS P46 without changing its remedy: clause (i)'s premise
  check must read a shard's `status:` against derived state, not only its `files:`/anchor claims,
  because **a task whose own status field is stale is a premise wrong at dispatch time by definition**
  — and W1-T367/#1412 shipped exactly the projection that makes that check cheap. It also supplies the
  missing motive for clause (iii): every one of these was SEEN by a worker and none could be written
  down, which is P38's organ from the third angle.
*(★ R15 COMPRESSION — R14's "everything else is evidence" bullet is DELETED; R15's equivalent bullet
above carries the same routing for the current cycle, and keeping one per retro is the per-cycle
restatement this section forbids. R14's pre-registration is not lost: it is SCORED in NET STATE.)*

**RETRO-1785599040918 (R13, prior cycle)** — 34 runs / 22 tasks / 25 PRs / 16 credits (`blocked_ci`×7,
`failed`×5, `blocked`×3, `no_pr`×3, 6 rejected trailers). **NO NEW P-NUMBER** — P8's accretion rule.
One surviving TASK proposal under an existing id:

- **★ TASK A (P38 — the LEARNINGS write path; STILL THE NARROWEST FIX, unbuilt through R15, and the
  cycle's single most expensive omission).** GROUND TRUTH is carried in full on P38's canonical entry
  (74 entries, 0 added for a FIFTH cycle; **seventeen harvest bullets across fourteen tasks naming ONE
  defect nothing could write down**) and is NOT restated here. PROPOSE: the harvest's
  `[action] … LEARNINGS` items become a first-class DISTILL QUEUE input — the retro (or the sweep)
  converts each into a schema-valid P32 layer-(i) entry with provenance `[src: run#…]` and the citing
  PR, appended by the same gated write path any other knowledge edit uses (§Self-improvement's
  RSI-safety rule: it ships as a PR). GOLDEN (fixture-only, no live dep): a seeded harvest carrying one
  `LEARNINGS`-flagged action yields exactly one appended entry with provenance and last-cited date; a
  harvest with none appends nothing and still emits its rung line (P38(ii)); an entry duplicating an
  existing one is marked CONTESTED by W1-T88's detector rather than appended twice.
*(★ R14 COMPRESSION — R13's TASK B/C/D/E stubs and its N-PR watch-item block are DELETED. Every one
restated a canonical entry it did not change, which is the per-proposal-stub disease R13 itself
abolished; TASK A survives because it is the only one carrying a spec its parent does not. Their
novel clauses are folded IN PLACE: **P33** keeps the six-pair list and the golden clause *"a seeded
quarantine file containing these pairs derives cleanly and dispatches none of them"*; **P39** keeps
*"a seeded task whose work PR is merged and whose plan status still reads `queued` is REFUSED before
dispatch, not exited after it"*; **P42** and **P40(ii)** carry D's and E's. The watch item's trigger
did not fire — 25 tasks / 25 PRs, strict 1:1 — and now rides one clause on P29.)*

**RETRO-1785456064479 (R12, prior cycle)** — 54 runs / 25 tasks / 4 credits (`blocked_ci`×11,
`blocked`×10, `failed`×10, `blocked_containment`×6, `no_pr`×4, `incomplete`×4, `blocked_isolation`×3,
`pr_attribution_failed`×2, 25 rejected trailers — 20 SIBLING, 5 FOREIGN).

- **P41 — RETIRED 2026-08-03 by its own kill trigger; prose DELETED (git holds it). R15: 0 guard-fired
  blocks for a THIRD cycle — stays retired, does not re-arm.** One line survives: the per-run isolation
  probe (W1-T17/#99) is an adequate backstop alone, and nothing ever proved what changed on that host,
  so the disappearance is not a fix anyone may claim. RE-ARM only on a recurrence, from fresh evidence.
- **★ P42 (measurement; sibling of P40) — A VERDICT CLASS CAN OWN 42% OF A CYCLE AND THE GATHER
  CANNOT NAME ONE OF THEM.** GROUND TRUTH: `failed` went from **6 of 147 (4%)** to **10 of 54 (19%)** — the
  largest single-class rate move in the gather, and now the third-largest verdict class overall. It is
  also the one class the plan has always treated as an HONEST defect (W1-T52's triage, #308) rather
  than a credit artifact, so a 4.5× rate increase is the most alarming number in this retro. And this
  retro can say **nothing further about it**, because the gather emits verdict COUNTS and, for the
  classes it considers interesting, per-run detail — but `failed` gets a count and nothing else. That
  is a retro that can see a fire and not the room. PROPOSE: **(i) VERDICT EXEMPLARS** — for any verdict
  class exceeding a policy threshold (share of runs, or a rate jump vs the prior cycle), the gather
  emits up to N exemplar runs with run id, task, and the first error/termination line already in the
  ledger — deterministic extraction, no LLM, no new instrumentation. **(ii) RATE, NOT COUNT** — the
  gather prints each class as a share of runs alongside the count, so a class that shrinks absolutely
  while growing proportionally (exactly this cycle's `specification` MAST row: 6→10 but 4%→19%) cannot
  read as an improvement. **(iii)** the same treatment for MAST rows, whose `trend vs prior cycle`
  column is currently a raw count delta across two different denominators — `verification −37` looks
  like a triumph and is a 37%→31% move. GOLDEN (fixture-only): a seeded ledger whose `failed` share
  crosses the threshold emits exactly N exemplars with their first error line; a class that grows in
  share while shrinking in count is rendered as a RISE.
  **★ EVIDENCE LOG (in place; R12/R13/R14 update prose FOLDED BY R15 to its arithmetic).** `failed`
  ran 4% (R11) → 19% (R12) → 15% (R13) → **42% (R14, the majority class)** → **0% (R15)**, and across
  all five the gather emitted a bare count with no run id, task or error line. **★ R15 — THE CLASS
  VANISHED AND P42 SURVIVES IT, DEMOTED TO RANK 6 BUT NOT CLOSED.** `failed` = **0 of 47** with P42
  unbuilt, so per P43(ii) it is **UNATTRIBUTED** and is recorded as pre-registration R15-4 precisely so
  a rebound cannot be re-mined as a NEW defect next cycle. Two clauses are more, not less, load-bearing
  after this reading. **(ii) is what makes a zero legible at all** — a class that goes 20 → 0 across
  denominators 48 and 47 is only interpretable as a RATE, and the same gather still prints MAST as raw
  count deltas (`specification −20`, `verification +9`) across those different denominators. **(i) has
  simply changed target**: the blind runs are now `incomplete`×10 and `blocked`×3, **13 of 47 (28%)**,
  the largest unmapped share in three cycles, and the gather names not one of them either. A proposal
  whose evidence relocates from one verdict class to another without shrinking has not been answered.
- **HARVEST CANDIDATES — STANDING DISPOSITION, NOT A PER-CYCLE LIST.** Per-cycle harvest lists are the
  duplication HARNESS-COMPRESSION forbids: the harvest is LIVE (P26's trigger fired), reproducible
  from any gather, and what it argues for is already ranked — every item R12–R15 produced was
  **P38's** shape (a fact nothing can write down, or a wire with no consumer) or **P46's** (a task
  file already wrong when read). Operational residue only, because it worsens and belongs to no task:
  the primary checkout `~/Remudero/repos/remudero` was 85 commits behind `origin/main` at R12, 155 at
  R13, 232–278 at R14 and **312–371 at R15** — any tool reading that path instead of a worktree sees
  a stale tree, and the drift is now compounding at ~100 commits a cycle. **★ R15 adds ONE standing
  worker-environment note, because five separate runs hit it and it is not any task's defect:** in the
  worker sandbox `rmd preflight`/`rmd review` frequently cannot run at all — `checkCliFreshness`
  refuses any ahead-of-origin feature branch outside `CI=1`, `loadConfig()` hard-fails on an empty
  synthetic-HOME config, and tsx's CLI loader EPERMs binding an IPC socket under `/tmp/claude-<pid>`
  (outside the writable allowlist). **A sanctioned command that workers must run before pushing, and
  routinely cannot, produces exactly the "explain the red step away in the PR body" ritual this cycle
  paid for seventeen times.**

**DECISION-QUALITY REVIEW (2026-08-02, OUT-OF-CYCLE — not retro-mined).** Derived from reading the plan
against the decision-research literature (§5E carries the mapping and the vocabulary). These are
candidates for the Architect to ratify via a tasks.yaml PR (rule 15) — **never auto-filed**, and
deliberately NOT written as tasks, because the ratification telemetry (21% approval) is the governance
that keeps this list from becoming the graveyard P8 warned about. Each names a root cause no open
proposal covers; everything else the literature flags in this plan is already an instance of P38, P40(ii),
P42 or W1-T271 and is folded there rather than given an id.

- **★ P43 (plan + golden) — THE COUNTERFACTUAL GAP: THE HARNESS CANNOT TELL A FIX FROM A FLUKE.**
  GROUND TRUTH, stated by R13 itself: ledger credit ran 30% → 21% → 16% → **64%**, and the retro records
  that **"nothing in the gather names a cause and no shipped task in R12 claimed to move it."** Every
  prior retro read that same metric as a REGRESSION. In the same document, the ratification counter has
  read `3 / 11 / 21%` **byte-identically for three consecutive cycles** across wildly different activity.
  So the plan holds, simultaneously, an unexplained 4× improvement and a provably frozen counter, and has
  no mechanism that distinguishes either from noise. This is NOT P38: P38 asks *did the merged organ
  execute?*; P43 asks *would the number have moved anyway?* — a live organ and a real effect are
  different claims, and R13's reversal is the case where the first was satisfied and the second was not.
  PROPOSE, three clauses. **(i) PRE-REGISTRATION** — a ratified proposal records a numeric EXPECTED
  EFFECT on a NAMED metric and the cycle it should be visible in, stored as data beside the proposal, not
  as prose. **(ii) REGRESSION CONTROL** — before attributing a move to a shipped task, the retro compares
  it against that metric's own prior variance and against the in-cycle runs the intervention could not
  have touched; a move inside prior variance is reported **UNATTRIBUTED**, never as an effect. An extreme
  reading is the single most likely thing to revert regardless of what shipped, which is exactly what the
  16% → 64% row demands be ruled out first. **(iii) SCORING** — each cycle scores the previous cycle's
  pre-registrations (hit / miss / unresolvable) and prints a running calibration line. The Architect's own
  forecasting accuracy becomes measured data, which is the only durable defense against the coherent
  causal story a retro is structurally motivated to write about the cycle it just lived through.
  GOLDEN (fixture-only, no live dep): a seeded metric series whose latest move lies INSIDE prior variance
  renders `UNATTRIBUTED` even when a task claiming it merged in-window; a move outside variance with a
  matching pre-registration renders `ATTRIBUTED` carrying the predicted-vs-observed pair; a cycle with
  zero pre-registrations prints the calibration line at `n=0` rather than omitting it (the P40(ii) rule —
  a number that cannot be distinguished from a stale number is printed with its coverage, or not printed).
  **★ R14 UPDATE — VALIDATED TWICE IN ONE CYCLE, ON THIS PLAN'S OWN TEXT.** (1) Ledger credit ran
  16% → 64% → 40%, all inside the metric's own range, so **both moves should have been UNATTRIBUTED**
  — clause (ii). (2) R13 DEMOTED P29 on a 20 → 3 collapse and the next cycle read 23: a real ranking
  decision made on one extreme reading, reversed within a cycle. The one claim R14 could defend
  without qualification was the one R13 wrote down in advance.
  **★ R15 UPDATE — THE FIRST PRE-REGISTRATION IS SCORED, AND THE CYCLE WOULD HAVE BEEN UNREADABLE
  WITHOUT THIS PROPOSAL.** (1) **CLAUSE (iii) IS NOW LIVE, n=1**: R14's prediction (*"if W1-T149 ships,
  sibling rejections below 10; if not, report the fall UNATTRIBUTED"*) scores **UNRESOLVABLE** — the
  antecedent was false — giving a running calibration line of **hit 0 / miss 0 / unresolvable 1** and
  its first design lesson: **a prediction conditioned on a task nobody has committed to dispatching
  cannot be scored**, so R15's own table conditions two of four predictions on things that already
  happened. (2) **CLAUSE (ii) CARRIED THE WHOLE RETRO.** Four headline metrics moved hard with nothing
  built to move them — `failed` 42% → 0%, MAST `specification` 20 → 0, foreign trailers 0 → 12,
  credit 40% → 56% — and each is reported UNATTRIBUTED rather than as a fix, a regression, or a new
  defect. Without clause (ii) this retro's most likely output was *"P42 and P46 are solved"*, which
  the evidence does not support and which would have retired two proposals on noise. (3) The cost of
  NOT having it is now also visible: R14 called P33 "stable, no longer compounding" on one quiet
  cycle, and it returned at 4 new pairs and 12 rejections. **P43 rises to rank 4**; clause (i) is
  still only asking that the table now sitting in NET STATE be stored as data beside each proposal.
  **★ R16 UPDATE — THE FIRST `HIT`, AND THE CALIBRATION LINE HAS ENOUGH POINTS TO YIELD A RULE.**
  **(1) `HIT`, n=5.** R15-1 predicted `implement` avg turns **< 90** if the preflight false-FAIL loop
  was the cause of the inflation, with the falsifier written out (*"if it does NOT fall, the ci-parity
  contract is NOT the cause"*); observed **83.083**, against 126.047. R15-4 also HIT. R15-2/R15-3
  scored UNRESOLVABLE on false antecedents. Running line: **n=5 · hit 2 · miss 0 · unresolvable 3.**
  **(2) THE LINE NOW YIELDS A DESIGN RULE, WHICH IS WHAT CLAUSE (iii) IS FOR.** All 3 unresolvables
  were conditioned on a task nobody had committed to dispatching; both hits were conditioned on
  something that had ALREADY shipped. **A pre-registration conditioned on future work is not a
  prediction, it is a request** — R17 must keep registering those anyway (R16-2, R16-3) so an unbuilt
  item cannot go unrecorded, but must count them separately from the scorable ones. **(3) THIS IS THE
  PROPOSAL'S OWN PROOF.** Without R15-1 written down in advance, R16's headline — a 34% turn cut and a
  43% cost-per-task fall — would have been reported UNATTRIBUTED under clause (ii), exactly like the
  five other metrics that moved this cycle, and the plan would not be able to say that a **$3.482 run
  bought it**. One cheap sentence written a cycle early converted the largest cost move in the log
  from noise into an attributed effect. **P43 holds rank 5** only because P29/P47/P38/P48 are
  unbuilt defects while P43 is now demonstrably working in its cheapest form (a markdown table);
  clause (i) — store it as data — is the remaining ask, and it is smaller than ever.
  **★ R17 UPDATE — A SECOND DESIGN RULE, AND THE FIRST TIME CLAUSE (ii) WAS APPLIED TO A METRIC'S
  RIGHT TO EXIST.** **(1) THE LINE READS n=9 · hit 2 · miss 0 · unresolvable 7.** All four R16 rows
  scored UNRESOLVABLE — three on false antecedents (rule 1, now 7/7) and **R16-1 on something new: its
  INSTRUMENT went dark.** 17.781 nominally satisfies *stays < 100* and means nothing, because 12 of 26
  shipped runs report real dollars against 0 turns. **RULE 2, added to this clause: a
  pre-registration must name the COVERAGE precondition of its own metric**, or a dark instrument
  silently satisfies it and the plan books a fake `HIT`. R17-1 is that rule made into a row.
  **(2) CLAUSE (ii) EXTENDED — FROM 'IS THE MOVE REAL' TO 'CAN THIS DIAL MOVE AT ALL'.** For eight
  cycles P29 was ranked on SIBLING-REJECTION COUNT. R17 establishes that number is orthogonal to
  #349's mechanism by construction: the ownership-assert must keep rejecting a run that opened no PR,
  and what the `ownResult` stash changed is that a task can be credited THROUGH a sibling's merged PR.
  So R13's demotion, R14's reversal and three UNRESOLVABLE scorings all argued over a dial the fix is
  not wired to. **The addition to clause (ii): before attributing (or refusing to attribute) a move,
  the retro must state the causal path from the shipped mechanism to the metric — a metric with no
  such path is STRUCK, not scored.** This is cheaper than regression control and catches a whole class
  variance testing cannot: a number that is stable, well-measured, and about something else.
  **P43 holds rank 5**; clause (i) — store it as data — is still the remaining ask.

- **★ P44 (plan + golden) — THE TRIPWIRE IS AN ANCHOR, NOT A MEASUREMENT.** GROUND TRUTH (mechanical,
  measured at `dcbe275`): **254 of 315 tasks carry `budget_usd: 100.00` exactly**, and the entire plan
  uses **13 distinct values, every one a round multiple**. Against that constant the observed figures are
  avg **$4.915**/run, this cycle's most expensive single run **$17.676**, R12's peak $35.384, and
  **0 / 34 trips**. The plan already concedes the failure in BOTH directions: W1-T3 died `blocked_budget`
  at **$3.57 against a GUESSED $4 cap** — a limit set NEAR the work acting as a work limit — while R8's
  W1-T1 spin loop churned **195 runs** and a global $100 cap never caught it. One constant cannot separate
  pathology from honest-but-expensive work across heterogeneous classes, because it carries no information
  from the ~574 runs of history that exist. §5C **already has the seam** — *"BUDGET SANITY (soft): flag a
  task whose turn-budget is below the observed mean for its class (ledger calibration)"* — but it reads
  ONE statistic, in ONE direction, on turns only. PROPOSE: derive the tripwire from the class's own
  observed distribution instead of a constant. Per `(task_class, risk)`, compute the cost/turn
  distribution over the **unioned** ledger (live ∪ rotations — the 212-vs-912 rule) and set the tripwire
  at a high percentile plus margin, under a **HARD FLOOR** that can never sit near honest work: W1-T3 is
  the error this must not reproduce. It then fires EARLIER than $100 on a class whose honest work is cheap
  — catching a spin loop against its own class's tail rather than letting it run to a global number — and
  LATER on a genuinely expensive class. **Explicitly NOT a cost-saving measure and NOT an allowance**;
  §9's tripwire doctrine is unchanged, only the constant's PROVENANCE.
  GOLDEN (fixture-only, no live dep): a seeded per-class distribution yields a tripwire above that class's
  observed max and below the global constant; a class with fewer than N observations **REFUSES to derive**
  and falls back to the constant, printing why — the law-of-small-numbers guard the `diagnose` row (n=1,
  *"still do not re-base a diagnose mount on it"*) already earned by hand; a seeded run inside its class's
  honest range never trips.

- **★ P45 (plan + golden) — NOTHING ASKS THE CHEAPEST QUESTION: ASSUME IT ALREADY FAILED.** GROUND TRUTH:
  §5C Layer B already interrogates a task before dispatch (*"is this genuinely ONE concern?"*), and the
  plan's history is full of failures predictable in KIND though not in detail — four malformed tasks
  reached workers and burned budget (W1-T6 / W1-T9 / W1-T12); `failed` is **5 of 34 runs (15%)**, a second
  cycle at ~4× R11's rate that the gather still cannot name a single run id for (P42); and five separate
  PRs rewrote proofs one task at a time before anyone framed it as one class. No rung asks the dispatching
  side to state, in advance, how this is most likely to go wrong. PROPOSE: a pre-dispatch rung recording
  as LEDGER DATA (a) the single most likely failure mode from a BOUNDED taxonomy, and (b) one falsifiable
  tripwire that would surface it early. Two consequences, both compounding: the worker's prompt carries
  the named risk, and the ledger gains a PREDICTION the verdict later confirms or refutes — which feeds
  P43(iii)'s calibration line and finally gives P42's unexplained `failed` class a prior to test against
  instead of a count. Cheapest item in this block: one bounded enum, one ledger line, no new organ.
  GOLDEN (fixture-only, no live dep): a seeded dispatch records exactly ONE premortem line carrying a
  taxonomy-valid mode and a tripwire; a verdict matching the predicted mode scores `HIT`, a different mode
  scores `MISS`, and a task that never dispatched scores neither; an empty or free-prose mode is REFUSED
  at the linter rather than written (the proof-shape rule, applied to predictions).

**RETRO-1785341166059 (R11, prior cycle)** — 147 runs / 94 tasks / 20 credits (`blocked`×47,
`blocked_ci`×25, `no_pr`×17, `incomplete`×12, `pr_attribution_failed`×12, `blocked_containment`×6,
`failed`×6, `blocked_isolation`×1, `blocked_transient`×1, 49 rejected trailers).

- **★ P38 (plan + golden; rank 2 as of 2026-08-07, PRICED BY R15) — THE DEAD-CONSUMER CLASS: ORGANS
  MERGE, PASS THEIR GATE, AND CANNOT BE SHOWN TO RUN.**
  **★ 2026-08-07 — CLAUSE (i)'s CALL-SITE LINT RUNG IS BUILT, RUNNING, AND PERMANENTLY AT `warn`; THE
  CHECK THAT EXISTS TO CATCH DARK ORGANS IS ITSELF HALF-DARK.** Established from source:
  `callSiteViolations` (`src/lib/task-linter.ts`) refuses a task that creates a new `src/**.ts` module
  without an acceptance criterion proving a CALL SITE — `grep: <symbol>( in <a file that is not the
  new module>`, the open paren required because a bare symbol name passes on a comment. It is wired
  into `lintTask`, and `run-task.ts` supplies its `moduleExists` predicate at TWO real call sites, so
  it genuinely runs. **But `opts.callSite` defaults to `"warn"` and NOTHING IN THE TREE EVER PASSES
  IT** — zero occurrences of `callSite:` outside the linter — so it has never once blocked anything,
  and `lintTask` returns ok on a warn by construction. Its own message reads *"Eleven modules have
  merged green and unreached; this is the check that would have"* caught them. So the plan listing
  *"then the call-site lint rung"* as FUTURE work is wrong in the same direction as the W1-T149
  record, and R16-2's antecedent — *"ONLY if P38(i)'s call-site lint rung ships"* — is arguably
  already satisfied while the prediction it guards (dark organs ≤ 1) cannot possibly be moved by a
  check that only warns. **THE REMAINING WORK IS THEREFORE A RETROFIT AND A SEVERITY FLIP, NOT A
  BUILD** — the default's own comment says *"see the report's retrofit count"*, i.e. the backlog of
  existing tasks that would fail on the flip is the actual cost, and that is an operator call because
  it tightens a gate against filed work. This is EVIDENCE IN PLACE, not a new number: it is P38's own
  headline — *the harness cannot tell itself whether what it BUILT is running* — observed for the
  third time in one session, on P38's own instrument.
  GROUND TRUTH, R11 (mechanical): LEARNINGS held at 74
  entries, ZERO added across 147 runs, while W1-T86/#631 (utility A/B), T87/#687 (procedural-success
  mining) and T88/#689 (contradiction detection) all merged INTO that corpus; the follow-up harvest
  stated THREE times that `checkCostGovernor`/`logCostGovernorDeferral` (T148/#839) and the T121 queue
  governor "ship as tested pure functions with no live call site", and that T151's
  `checkFreshness`/`runInstall` are "still unwired in production"; credit fell 30% → 21%.
  **★ EVIDENCE LOG (in place; R12/R13/R14 update prose FOLDED BY R15).** The assertion has now been
  run by hand FIVE times and FLAGGED all five: **LEARNINGS = 74, zero added**, across a further
  54 + 34 + 48 + 47 runs and 25 + 22 + 25 + 25 shipped tasks, with W1-T87's miner proposing reusable
  shapes every cycle and nothing writing them. R13 removed the last benign explanation — a worker
  NAMED the note it wanted written, in prose, in its own harvest (W1-T280/#1065) and the corpus did
  not move — so this is not a detection or judgement gap but a **missing WRITE PATH**; TASK A is the
  narrowest fix. R13 extended clause (iii) to IMPROVEMENTS too (an unexplained gain is as unowned as
  an unobserved organ). R14 scored clause (iii)'s first win by hand (the pre-committed no-op-close
  test PASSED) and its first counter-case in the same cycle (the shipped dispatch cap did not halt an
  8-dispatch task, and no line says whether it evaluated them — **clause (ii)**, and the reason it
  must ship with (iii)).
  **★ R15 UPDATE — THE PROPOSAL IS PRICED, AND CLAUSES (i)/(ii) BOTH SCORED.** **(1) THE PRICE.**
  Seventeen harvest bullets across **fourteen distinct tasks** (T313, T315–T321, T324–T326, T331–T336)
  independently rediscovered ONE defect — `defaultPreflightSpawn`'s missing `spawnSync` `maxBuffer`,
  false-FAILing `rmd preflight --ci-parity`'s `ci:test` for every worker on every branch — several
  re-deriving the file, symbol and byte figure from scratch, each PR body explaining the red step
  away, until **W1-T338/#1327 fixed it for $3.482 / 53 turns**, the cheapest implement run of the
  cycle. **The harness could not spend $3 to record a fact it paid fourteen workers to relearn**,
  because the only knowledge path it owns is a PR that changes code. That is TASK A's entire argument,
  with a receipt. **(2) CLAUSE (i)/(ii) SCORED POSITIVE.** This cycle shipped **nine** wiring tasks
  that are precisely what a call-site lint rung would have demanded up front (T316/T317/T321/T325 gave
  four tested-but-uncalled governors live call sites with ledgered deferrals; T331 unfroze the ceiling;
  T329 rendered the deferral posture), and the SHIPS-UNWIRED scan now reads **clean — no NET STATE
  claim names an unreached symbol.** So the defect class is real, is drainable, and cost nine tasks to
  drain by hand what clause (i) would refuse at filing time for free. **(3) THE SIBLING DEFECT WIDENS.**
  **P46(iii)** (recon cannot write a task-file correction) and now **P47** (a repair actor's only way
  to be honest about provenance is a trailer that poisons the task) are the same missing organ seen
  from two more angles: **this harness can write code and nothing else.**
  DIAGNOSIS: **the gate proves a UNIT and never a WIRE.** Standing rule 14 already says "the call site
  is a deliverable" — it is INSTRUCTION,
  and §5's own doctrine is that instructions shape behavior while gates guarantee it. PROPOSE: **(i) A
  CALL-SITE LINT RUNG** — lint-plan REFUSES a task whose every acceptance proof is a unit test over a
  pure function; a task whose deliverable is a function/module MUST carry at least one criterion naming
  a LIVE call site on the dispatch/daemon path (grep-shaped, executable dialect). **(ii) EXECUTION
  TELEMETRY AS A STANDING SHAPE** — every reconciler / governor / distill rung appends one line naming
  rung, repo, candidates-considered, actions-taken, **even when zero**, so "did it run" is never again
  inferred from a downstream metric (this is P35(ii) generalized past credit). **(iii) THE EFFECT
  ASSERTION** — when a cycle credits a task whose stated purpose was to move a signal THIS gather
  measures (learnings written, credit rate, governor deferrals, class coverage), the NEXT retro asserts
  the signal moved and FLAGS it if not; a flagged organ is a plan-health item, not a silent success.
  GOLDEN (fixture-only, no live dep): a seeded task whose proofs are all pure-unit FAILS lint-plan and
  the same task with a call-site criterion PASSES; a seeded ledger in which a governor never emitted a
  rung line makes the effect assertion FLAG; a rung that ran with zero candidates still emits its line.
  **★ R16 UPDATE — THE SCAN THAT SCORED CLAUSE (i) POSITIVE IS MEASURING THE WRONG POPULATION, AND
  THE WRITE PATH IS NOW PRICED A SECOND WAY.** **(1) R15's positive evidence is WITHDRAWN.** R15 cited
  *"SHIPS-UNWIRED now reads clean"* as proof the dead-consumer class was drainable. It read clean again
  this cycle — while **four organs shipped DARK BY THEIR OWN PR'S ADMISSION**: `askType` has no
  producer (T347/#1371 — *"fully unit-tested but dormant in production, since no real caller ever sets
  `askType`"*), `escalateWithJudge()` has no live caller (T349/#1379 — *"no real producer is wired…
  deliberately, per this task's scope"*), `expandFeedback` is unwired in `rmd serve` (T350/#1378), and
  the base-tree proof check *"degrades to `base_unknown`… rather than ever observing a genuine
  base-tree pass"* (T362/#1404). The scan missed all four because **its population is symbols a NET
  STATE capability claim NAMES** — an organ the plan has not yet boasted about is invisible to it. So
  the instrument does not measure the class; it measures the plan's own prose. **This does not weaken
  clause (i) — it is the argument FOR it**: a filing-time gate sees every task, a NET-STATE-keyed scan
  sees only the ones already advertised. It DOES mean R15's score must be read as unproven, and R16-2
  pre-registers the dark-organ count so R17 has a number rather than a scan. **(2) THE SECOND PRICE:
  RECON IS RE-BOUGHT EVERY DISPATCH.** Six tasks took 16 runs to ship 6, with verbatim-duplicate reads
  across dispatches — full ground truth and the fix are on **TASK B** above, and the reason it lives
  under P38 rather than a new number is that it is the SAME missing organ: this harness can write code
  and nothing else. **(3) LEARNINGS = 74, ZERO ADDED, SIXTH CONSECUTIVE CYCLE**, across a further 36
  runs, while W1-T87's miner again proposed reusable shapes (12 runs, 2 shapes) and nothing wrote them.
  R15-3 scores **UNRESOLVABLE** (TASK A did not ship) and is re-registered UNCHANGED as R16-3.
  **★ R17 UPDATE — SEVENTH FROZEN CYCLE, AND THIS TIME THE MINER HANDED THE CORPUS A CLEAN SHAPE
  AND THE CORPUS COULD NOT TAKE IT.** **(1) LEARNINGS = 74, ZERO ADDED, SEVENTH CONSECUTIVE CYCLE**,
  across a further 64 runs and 27 shipped tasks. R16-3 scores **UNRESOLVABLE** (TASK A did not ship)
  and is re-registered UNCHANGED as **R17-3**, the third identical registration. **(2) THE MOST
  POINTED INSTANCE YET IS A SUCCESS, NOT A FAILURE.** W1-T87's procedural miner surfaced
  **`implement × clean_single_strike` across FOUR runs (W1-T416, T420, T422, T424)** — a reusable
  shape, mechanically derived, already in the gather, needing no LLM judgment to record — and it went
  nowhere, because there is no write path. Six cycles of this argument have been about defects the
  harness kept re-paying for; this is the first cycle it demonstrably failed to bank a WIN. **(3) THE
  ENVIRONMENT-KNOWLEDGE INSTANCE, which is TASK B's cheapest slice**: four separate runs (T416, T418,
  T420, T423) each independently re-diagnosed that this box cannot provision a macOS Keychain item or
  GNU `date`, so `rmd preflight --ci-parity` can never reach a clean PASS here regardless of diff —
  one fact, host-scoped, invariant across every task, bought four times in one cycle. **(4) THE
  DARK-ORGAN COUNT IS STILL DERIVABLE and reads ≥ 2** (R16-2 asked): `learningDuplicateViolation`
  shipped with no live caller by T420/#1610's own admission, and the `mutation.ratchet_verdict`
  emitter is unwired at lifetime **N=0**. Clause (i)'s call-site lint rung did NOT ship and remains
  `callSiteViolations` at `warn`, so R16-2 scores **UNRESOLVABLE** on a false antecedent.
  THE GENERAL LESSON, and the reason this is P-numbered rather than three bug reports: **rule 13's
  "the proof is a merged PR" is exactly right about PROVENANCE and silent about EFFECT — and a harness
  that cannot see its own organs running will keep buying them twice.** **SUBSUMES P35** (the same
  defect aimed at one consumer; P35 has no separate entry — what survives of it is: the credit backfill
  FIRES, verified by hand in #470 (134 evaluated, 70 `verdict.merged` corrections in-ledger), and the
  defect is that the retro's credit tally counts `step: "verdict"` lines only (retro.ts) and is
  structurally blind to those corrections (sweep.ts). Build it as P38(ii)'s first consumer).
- **★ P39 (plan + golden) — DISPATCH IGNORES ITS OWN MERGED TRAILERS, SO THE HARNESS PAID TO
  REDISCOVER FINISHED WORK.** GROUND TRUTH (mechanical): **three of the 94 "shipped" tasks are PRs
  whose entire content is a no-op close** — `docs: close W1-T7 re-dispatch as already-satisfied`
  (#772), the same for W1-T12a (#725), and the W1-T99 stale-dispatch decision log (#731). **W1-T152 was
  dispatched FIVE times** (…975221 → …090997) after its work merged as #793; each run's recon
  independently rediscovered the collision BY HAND, and one wrote this gather's own candidate: *"Add a
  pre-dispatch gate that refuses to queue a task whose id already appears in a merged Remudero-Task
  trailer."* W1-T230 was dispatched 6×, W1-T7 4×, W1-T64 4×. The plan's authored `status:` field cannot
  catch it — a harvested run reports **248 of 254 statuses read `queued`**, and `deriveStatus`
  deliberately treats that field as untrusted. PROPOSE: **(i) A PRE-DISPATCH GATE** (rule 2,
  deterministic): `nextRunnable` refuses a task whose id already rides a MERGED `Remudero-Task` trailer
  on a branch that TASK owns, and ledgers `dispatch.refused_already_merged` naming the PR. **(ii) THE
  REFUSAL IS A CREDIT SIGNAL, NOT SILENCE** — it routes into the same correction path W1-T149 builds,
  so refusing and crediting are ONE rung; a gate that only refuses moves the churn from dispatch to
  refusal and fixes nothing. **(iii) A TRUSTED RETIREMENT SIGNAL** — W1-T162's harvest records that
  "task retired" has NO trusted input today because `deriveStatus` ignores the authored status; an
  `rmd retire` correction verb (sibling of `rmd correct`) closes that hole. GOLDEN (fixture-only): a
  seeded task with a merged owned-branch trailer is REFUSED at dispatch and CREDITED exactly once; a
  task whose only merged trailer is FOREIGN-branched is refused AND escalated, never credited (P33's
  boundary preserved); an uncredited task with no merged trailer dispatches normally.
  DEPENDENCY: SATISFIED — W1-T149/#349 (P29's other half) shipped 2026-07-20; this is now unblocked. **★ R12 UPDATE:** zero no-op-close PRs,
  but 20 SIBLING rejections across 13 tasks — the churn appeared to move from "pay a worker to discover
  the work was done" to "pay a worker to redo work a sibling already merged". The gate as specified
  catches BOTH, because both begin with a task id that already rides a merged owned-branch trailer.
  **★ R13 UPDATE — R12's "zero no-op closes" WAS A ONE-CYCLE DIP, AND THE CLASS IS NOW PRICED.**
  W1-T254 merged **FOUR** no-op closes in one cycle — #1007 (naming work PR **#720**), #1012 *"second
  time"*, #1015 *"fourth time"*, #1016 *"fifth time"* — **$11.032, 6.6% of cycle spend, for zero
  product code**, and all four were ledger-CREDITED as shipped tasks, so the churn now inflates the
  very success metric that should expose it. Two further confirmations: the plan's authored `status:`
  is still untrustworthy in the observed direction (**W1-T279 read `queued`/`attempts: 0` while its PR
  #1062 was merged**, per W1-T280's harvest), and **W1-T272/#1044 shipped a sanctioned
  `ALREADY_SATISFIED` exit — which makes the close CHEAP but does not stop the DISPATCH.** P39 rises
  to rank 3: its damage is repeated, priced, and now demonstrably not self-correcting.
  **★ R14 UPDATE — THE GROUND TRUTH READ ZERO, AND P39 DROPPED TO RANK 6 WITHOUT BEING CLOSED.**
  No-op-close PRs: **0 of 25**, against R13's four; R13's pre-committed test PASSED, so the organs
  that make the close cheap (#1044) and cap the re-dispatch (#1040) execute against THIS shape. The
  gate itself (i) is still unbuilt, so the cure is behavioural rather than mechanical.
  **★ R15 UPDATE — THE AUTHORED-STATUS HALF IS RE-CONFIRMED, AND THE RACE HAS A NEW DIRECTION.**
  W1-T334, T335 and T336 all still read `status: queued` on their shards **after their PRs merged**
  — flagged independently by two runs' harvests — so clause (iii)'s "task retired has no trusted
  input" is unchanged four cycles on. And the dispatch/merge race now runs the OTHER way: W1-T326's
  harvest records **a fix-rung round dispatched against a branch whose PR had ALREADY merged**, with
  the review citing a body/diff contradiction that does not reproduce. P39(i) refuses a TASK whose
  work merged; the same staleness on the FIX rung is unguarded, and R15 files that as **P47(iii)**
  rather than a fourth clause here.
- **★ P40 (measurement) — THE RETRO'S OWN INSTRUMENTS ARE HALF-DARK, AND THEY FEED THE MOUNT TABLE.**
  GROUND TRUTH: **(a)** 58 of 147 runs recorded exactly 0 turns AND `task_class: unknown` — the same
  58 — so the headline "8 turns/run" (against R10's 86.6) is a write-side blackout masquerading as a
  10× efficiency gain; **(b)** W1-T167 (#606) now routes model + effort BY CLASS, so a run whose class
  never resolved rode a default mount and the routing discount this gather exists to measure is
  unmeasurable; **(c)** W1-T89's MAST map (#710) codes 87 runs and leaves **60 UNMAPPED**, including
  `blocked`×47 — the single most common verdict class in the cycle. PROPOSE: **(i)** find and close
  the write path that drops class and turns TOGETHER — one cheap falsifiable hypothesis: the run-summary
  line is never written for runs ending outside the normal terminal path (53 runs shipped nothing this
  cycle, and the two counts are the same order); **(ii)** the gather REFUSES to print an average over a
  column that is zero for >10% of runs, printing COVERAGE instead — a silent 0 is worse than an absent
  number when the table re-bases a mount; **(iii)** add rows for `blocked`, `incomplete` and
  `blocked_transient:success` to `plan/mast-mapping.yaml`, or record them as a deliberate
  `unmapped(reason)` class — never guessed, but never silently absent either. GOLDEN (fixture-only): a
  seeded ledger with a class-less run makes the gather print coverage rather than an average; every
  verdict class in the fixture codes to a MAST category or an explicit `unmapped(reason)`.
  **★ EVIDENCE LOG (in place; R12/R13/R14 update prose FOLDED BY R15 to its state).** **Part (a)/(i)
  is CLOSED and its original hypothesis FALSIFIED** — class resolution went 89/147 → 54/54 → 34/34 →
  48/48 → **47/47**, while turns stayed dark for two of those cycles, so class and turns are NOT
  dropped by one write path; the turn column then lit in R14 with **nothing built and nothing in the
  gather naming a cause** (P43's shape; do not credit it). **Part (ii) is PROVEN, not suspected, and
  unpaid for a third cycle** — the cycle and weekly tables have reported the same turn total over
  different denominators every cycle since R13 (321/34 vs 321/131 · 1736/48 vs 1736/37). **Part (iii)
  is UNBUILT** and its blind share ran 26% → 9% → 15%. The golden gained one clause from R13's deleted
  TASK E stub: **a seeded ledger whose telemetry counter has no events inside the retro window renders
  `no activity in window`, never a repeated prior total.**
  **★ R15/R16 UPDATE (R15's prose FOLDED INTO R16's by R16 — the two cycles said the same thing about
  the same three parts, and only the numbers changed).** Part **(i)/(a) STAY CLOSED**: turns hold lit
  (24 of 25 shipped runs nonzero; 2825 then 2991) and class resolution is total (47/47, then 36/36).
  Part **(ii) IS STRUCTURAL, UNPAID FOR A FOURTH CYCLE** — the same-total/different-denominator split
  has now printed four times with four different totals (321/34-vs-131 · 1736/48-vs-37 ·
  5463/47-vs-84 · **2991/36-vs-120**), which is no longer a suspicious reading but a defect; and the
  ratification counter has printed `3 / 11 / 21%` **six times byte-identically**, across ~165 further
  runs, which is the same defect wearing a different hat. Part **(iii) IS UNBUILT** and its blind
  share ran **9% → 15% → 28% → 19%** — the last move is a FALL with nothing shipped, so it is
  UNATTRIBUTED like the rise before it, and the composition is what matters: the blind set is now
  **entirely `incomplete`** (×7), a verdict class the mapping has never had a row for.
  **★ R16 ADDS A FOURTH PART — (iv) THE SHIPS-UNWIRED SCAN'S POPULATION IS THE PLAN'S OWN PROSE.** The
  scan reads capability claims in NET STATE and checks whether the symbols they NAME are reached. It
  read **clean** this cycle, in a cycle that shipped **four organs dark by their own PR's admission**
  (P38's R16 update carries the four). An instrument whose population is the set of things the plan
  has already boasted about cannot answer "what did we build that isn't running" — it can only answer
  "did we lie in NET STATE", which is a smaller and much easier question. PROPOSE, as part (iv): the
  scan's population becomes **symbols introduced by the cycle's own merged diffs**, not claims in
  prose; a merged export with no non-test caller is reported, whether or not any section mentions it.
  **★ R17 UPDATE — PART (i) RE-OPENS AFTER FIVE CLOSED CYCLES, AND THIS IS WHY P40 RISES TO RANK 3.**
  Turns did NOT hold lit: **12 of 26 union-listed shipped runs report nonzero dollars and exactly 0
  turns** (W1-T364 $14.451/0t and T387 $15.477/0t among them), and 4 more report $0.000/0t, while the
  gather prints `avg turns 17.781` over all 64 runs anyway. R14's read — *the turn column lit with
  nothing built and nothing naming a cause* — now has its mirror image: **it went dark the same way.**
  A column that lights and darkens with nothing built is not an instrument, and part (ii) is exactly
  the clause that would have made this LOUD instead of silent. **THE PRICE IS ALREADY PAID AND IT IS
  NOT HYPOTHETICAL: R16-1 was pre-registered against this metric and must be scored UNRESOLVABLE**,
  and R15-1 — the only `HIT` this plan has ever recorded — is now known to have run on an instrument
  that can go dark without announcing it. **TASK D** (R17's block) is part (ii) written as a
  dispatchable task with a golden. Part **(ii) is UNPAID FOR A FIFTH CYCLE** — a fifth
  same-total/different-denominator print (**1138/64-vs-22**) and a **seventh** byte-identical
  `3 / 11 / 21%`. Part **(iii) IS UNBUILT** and its blind share ran 9% → 15% → 28% → 19% → **36%**,
  the worst reading in the series, still composed almost entirely of `incomplete` (×17 of 18) —
  **TASK E** is part (iii) plus P42(i) written against that class. Part **(iv)**: SHIPS-UNWIRED read
  clean again in a cycle that shipped at least two dark organs by PR self-admission, which is the
  second consecutive confirmation that its population is the wrong one.
  GOLDEN: a seeded cycle merging one exported function with only test callers is REPORTED even when no
  NET STATE line names it, and the same function gains a production call site and is not reported.

**RETRO-1784556575522 (R9, prior cycle)** — 26 runs / 21 tasks / 13 credits (`blocked_ci`×8,
`blocked`×3, `incomplete`×1, `no_pr`×1, ONE rejected foreign trailer).

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
  DEPENDENCY: SATISFIED — W1-T149/#349 shipped 2026-07-20, so P29(ii)'s breaker (the backstop that makes (i) safe) is live.
  **★ EVIDENCE LOG — FOLDED BY R18 TO THE LIST ITSELF PLUS WHAT THE PER-CYCLE PROSE ESTABLISHED**
  (six cycles of R10–R17 paragraphs re-arguing a list that only ever grows is the per-cycle
  restatement this section forbids; ids and branches are preserved, the retelling is DELETED).
  **THE THIRTEEN QUARANTINE PAIRS, none ever removed because nothing in this harness can remove one:**
  W1-T64/#115 (`fix/w1t64-both-tests`, rejected 5×) · W1-T201/#993 (`plan/close-t201`) ·
  W1-T220/#641 · W1-T258/#766 · W1-T259/#768 · W1-T260/#773 · W1-T262/#777 (hand-authored `feat-*`) ·
  W1-T309/#1225 · W1-T314/#1293 (dispatched 6× against it) · W1-T320/#1274 · W1-T324/#1299 ·
  W1-T343/#1361 (`plan/dispatch-lanes-back-to-1`) · W1-T419/#1617, plus the #80/W1-T54b residue
  clause (iii) retires. **THE FOUR THINGS THOSE CYCLES ESTABLISHED, kept because each is still
  load-bearing: (a)** the AUTHOR is now the harness itself — fix rung, splitter, and in #1361's case
  the plan-sync lane, *the same lane this retro's own PR rides*, which closes the argument for keying
  refusal on BRANCH OWNERSHIP alone rather than on any notion of a legitimate actor; **(b)** it is
  BILLED — W1-T314 ×6, W1-T343 ×4, W1-T369 ×4, W1-T201 ×3 — fusing P33's underivability to P39's
  repeated spend; **(c)** a list drained by hand cannot outpace a cause that refills it, so **P47(i)
  ships FIRST and P33 becomes clean-up of a bounded set**; **(d)** R14's "stable, no longer
  compounding" reading died in one cycle — **quiet is not fixed**, and P43(ii) applies to FALLS in
  defect counts exactly as to rises. GOLDEN: **all THIRTEEN pairs derive cleanly and dispatch none of
  them, and a task poisoned mid-cycle HALTS on the first rejection rather than the sixth.**
  **★ R18 — NO NEW PAIR, AND THAT IS A COVERAGE READING, NOT A REPRIEVE.** All 7 foreign-proper
  rejections this window are against pairs ALREADY listed (#1529/`claude/resolve-p27-findings-rnvu61`
  is the W1-T388/T395 shape, #1468 the T401 shape, #993 the T201 pair for the FOURTH cycle). The list
  holds at thirteen over a window that never reached the tasks R17 mined, so **nothing about the
  growth rate may be inferred** — and W1-T201/#993 being billed again, five cycles after it was first
  enumerated, is the whole argument for shipping the list rather than maintaining it.
- **P31 — RESOLVED; COLLAPSED INTO P30; prose DELETED per RATIFY-OR-KILL.** R8's decisive test (*"19 of
  the 21 blocked_ci merged anyway — if that holds, P31 collapses into P30"*) held in R9 (6 of 8) and has
  held every cycle since. No separate task; the duplicate adjudication in the R8 block below is deleted.

**RETRO-1784512714705 (R8, prior cycle)** — 195 runs / 28 gate-side merges / 0 credits
(`incomplete`×111, `no_pr`×42, `blocked_ci`×21, `pr_attribution_failed`×12, `blocked`×5,
`blocked_containment`×2, `blocked_isolation`×2).

- **★ P29 — CLOSED 2026-08-07: BOTH CLAUSES SHIPPED. Clause (i) sibling-run credit liveness AND
  clause (ii) the per-task dispatch circuit breaker merged TOGETHER in PR #349 on 2026-07-20**, head
  `run-W1-T149-1784553391268`, trailer `Remudero-Task: W1-T149`, 3/3 criteria — and the `ownResult`
  stash that IS clause (i) is live in `src/lib/status.ts` today. **THE ENTRY BELOW IS A TOMBSTONE**,
  and as of R18 it carries NO restatement of the false premise six retros reasoned from: the
  plan-state truth rung (T410/#1591) fired BLOCKING on those surviving lines and they are DELETED,
  not folded. What survives, because it is still true and still load-bearing: **(a) the ownership-assert is CORRECT and must not be loosened**
  — it stopped R5's false-credit inversion and still does; **(b) a fail-closed integrity guard needs
  a LIVENESS counterpart, or the system pays for its own correctness forever.** P39 is its
  dispatch-side half and stays OPEN. **★ THE STING, and it is the reason W1-T390 exists:** lesson (b)
  is now proven twice over, because the ownership-assert this proposal deliberately preserved is
  ALSO what makes a `run-<taskId>-<slug>` branch permanently uncreditable — clause (i) taught the
  assert to accept a SIBLING run, and nobody taught it to accept the task's OWN branch under a
  descriptive name. THE HISTORY, kept in one line because it is what earned the proposal: W1-T1 dispatched ~130 times over ~10 hours at ~$130 because its
  own merged PR #255 could not credit a SIBLING run of the same task; W1-T29 ×10; and this cycle 49
  credit rejections, ~39 of them the same shape.
  **★ EVIDENCE LOG AND THE PER-CYCLE REJECTION SERIES — DELETED BY R18** (R17 struck the metric; this
  retro deletes the thirty lines of prose that survived the striking, including the six per-cycle
  readings 49/25/3/23/10/6/19 that argued over it and the two paragraphs restating why they were
  wrong). The durable claim is one sentence: **a run that opened no PR of its own is SUPPOSED to have
  a sibling's trailer rejected**, so the count was never this mechanism's dial, and **no retro may
  credit or debit #349 with a rejection count again.** **R18 adds the generalisation, which is the
  part worth carrying:** the identical conflation is alive in **P47's** counter right now — 10 of 17
  "foreign" rejections are the task's own re-dispatch (TASK F) — so this is a recurring CLASS, not a
  P29 anecdote: *a proposal's headline number must be derivable FROM the mechanism it names.* That
  belongs to **P43**, and P43's entry is where a future retro adds to it.
  **THE TWO-BREAKER QUESTION, SETTLED: DELIBERATE HARDENING, NOT DUPLICATE SPEND.** Clause (ii) is
  also credited to W1-T271/#1040, which knowingly ADDED a second counter because #349's streak resets
  on every `pr.opened` and is therefore blind by construction to a loop that SUCCEEDS by merging a
  no-op PR each pass. Both are needed; only the ATTRIBUTION was ever wrong.
  **The one observation that outlives the deletion, because it belongs to another proposal:** R16's
  sibling-rejected runs each ALSO paid a duplicated recon — the credit hole and P38's recon re-buy are
  billed against the SAME runs. That evidence now belongs to **P38**.
- **★ P30 — RATIFIED 2026-07-20 -> W1-T150, which SHIPPED 2026-07-21 (#358: the `rmd sweep` reconciler
  gains a level-triggered rung appending a `verdict.merged` correction for any task whose owned PR merged
  but is uncredited). Full prose DELETED per RATIFY-OR-KILL — the task and its PR are the record.** TWO
  things survive it. (a) The HISTORY that made the argument, kept as one line because each retro re-reads
  it: ledger-vs-GitHub ran R3 15-vs-17, R4 2-vs-6, R5 4-vs-4 (P11 closed on the GATHER, not the write
  side), R7 14-vs-14, R8 0-vs-28, R9 13-vs-21, R10 8-vs-23, **R11 20-vs-94**. (b) The open question the
  shipping did NOT close: **the metric still has not moved** — carried as P35, now folded into P38, which
  is P30's live descendant.
- **`incomplete`×111 + `no_pr`×42 + `pr_attribution_failed`×12 — THE SPIN-LOOP STORM, folded into P29;
  kept because it is the origin of the fold-line doctrine.** These three classes are 165 of 195 runs and
  their timestamps track the W1-T1/W1-T29 redispatch cadence (~75–90s apart): not 165 failures, ONE
  defect counted 165 times. INVESTIGATE only the residue that survives after P29 lands.

**RETRO-1784383376396 (R7) — proposal block DELETED; every item reached a terminal status.** **P27**
RESOLVED 2026-07-18: the `blocked_isolation`×5 volume was ONE cause — a Claude Code 2.1.214 auto-update
adding a pkill wrapper the static allowlist predated (#184's probe named it, #185 absorbed it); the
proposed host-hygiene fix was REFUTED by the name, and the guard fail-closed correctly on toolchain
drift. The resolution has held every cycle since; the guard-block volume R11/R12 recorded was re-graded
as a HOST signal (P41), **and R13 recorded ZERO guard blocks of any class.** Cause-field P23→W1-T91
SHIPPED (#719). R7's blocked_ci caveat became P31, which collapsed into P30.

**RETRO-1784213948025 / RETRO-1784206755808 (prior cycles) — proposal blocks DELETED.** Both resolved
entirely into ratified tasks or NO-new-proposal bootstrap findings whose reasoning now lives in the task:
**P23**→W1-T91 (SHIPPED #719 — structured guard-cause on block verdicts) · the `blocked_review`×1 and ×3
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
- **★ CLOSED PROPOSALS, FOLDED TO ONE BLOCK BY R16 (P12 · P13 · P14 · P16 · P18 · P19 · P20 · P22 ·
  P24 · P25 · P28 · P32 · P34).** Every one is RATIFIED-and-SHIPPED (or RETIRED) with its design prose
  already deleted per RATIFY-OR-KILL, and each was still carrying two to five lines restating that
  status — the exact disease the P1–P8 block below was folded to cure. Ids, tasks and PRs are
  preserved; **only the surviving DOCTRINE is kept, one clause each**, because a doctrine that is not
  written here gets relitigated. **P12** → W1-T86/#631 (`rmd wipe-test`, learning-utility A/B): the
  harness HAS the instrument and wrote **zero** learnings for a sixth cycle → P38. **P13** →
  W1-T87/#687 (the retro mines SUCCESS): its output is in every gather since and has never been
  written down → P38. **P14** → W1-T88/#689: **supersession is never a silent recency-overwrite —
  contradiction marks a CONTESTED pair.** **P16** → W1-T69 (deriveStatus rung (c)): **the
  ownership-assert's correctness is NOT in question** — the missing sibling-credit counterpart is what
  spins (P29). **P18** → W1-T89/#710: the verdict→MAST map is **DATA applied at retro-read**, and the
  runs it leaves honestly UNMAPPED are P40(iii), never guessed. **P19** → W1-T170/#888, T171/#890,
  T172/#896; **CLOSED, and as of R16 actually RUNNING at 2 lanes** (T343/T344): rung 2 (Tree-sitter
  symbol-touch locks) stays BANKED until a rung-1 escape is OBSERVED via `dispatch.concurrent_set`,
  and the honesty bound is now live rather than theoretical — **`files:` is advisory metadata a worker
  can exceed; the overlap check reduces collision probability and is never a guarantee.** **P20** →
  W1-T90/#716: severity × path-class decides act-vs-escalate and **the lane never writes tasks.yaml.**
  **P22** → W1-T76/#158, T77/#168, T78/#165–#167: **LEVEL-TRIGGERED RECONCILIATION** [research:
  prow-tide-2017, level-triggered-reconciliation] — every sync RE-DERIVES disposition from OBSERVED
  state, so a missed edge never strands work and a second pass over unchanged state does nothing;
  **P30 is that argument applied to CREDIT**, which is still edge-triggered at run-end. **P24** →
  W1-T82/#683 → T83/#698 → T84/#702 → T85/#709: brownfield onboarding is where static-spec tools stop
  and an operational plan begins — **`rmd onboard` produces the BRAIN, `rmd project init` installs the
  BAR.** **P25** → W1-T110/#368, T111/#373, #457: W1-T111's telemetry was **P28's own graduation
  trigger**, and it has now printed `3 / 11 / 21%` **six times byte-identically** and is treated as
  UNWINDOWED (P40(ii)). **P28** → RETIRED 2026-07-29 by that instrument (cumulative 4 approvals / 18
  items ≈ 22%, reframes ~4:1; the adjudication stands because it was made on the CUMULATIVE figure);
  **re-openable ONLY above 60% over ≥30 items**, and the line it drew is doctrine regardless: **the
  machine never ratifies on its own judgment — it acts within a policy the operator ratified once.**
  **P32** → W1-T145/#360, T146/#371: layers (i) and (ii) are usable today; **layer (iii) has a schema
  and a gate but NO WIRE**, and the GLOBAL TRANSPORT stays banked to §6 packaging in Tier 3's
  stateless shape (opt-in POST up, pull of a hash-pinned artifact down, no persistent connection).
  **P34** → W1-T248/#903, T249/#907, T250/#898, T251/#899; **CLOSED**, with two decisions kept because
  both went AGAINST the original proposal and would otherwise be relitigated: **(a) dispatch is NOT
  presence-gated — the presence×risk matrix is DEAD**, replaced by a risk judge reusable independently
  of who is watching; **(b) burn is share of the WEEKLY LIMIT per model class, never imputed dollars**
  — the Calibration model table is that decision made mechanical. [research: hitl-supervision-scaling /
  approval-fatigue-2026]
- **P17 — RATIFIED 2026-07-16 -> W1-T71 (`rmd receipt <pr>`: a deterministic in-toto-style attestation
  assembled from ledger ground truth, plus the byte-equal drift golden; Sigstore + the WS-12 schema publish
  deferred to v2). Design prose DELETED per RATIFY-OR-KILL — the task is the record. STILL UNBUILT.** The
  claim it makes literal is WS-12's: the ledger proves our runs to US and nothing proves them to anyone
  else. **★ 2026-08-07 — THE COMPLIANCE CLOCK IS STRUCK FROM THIS ENTRY'S RATIONALE, AND THE REASON IS
  THE POINT.** The DATE was right: EU AI Act (Reg. (EU) 2024/1689) Art. 50's transparency obligations
  apply from **2026-08-02**, so five retros correctly read the calendar. **What no cycle ever wrote
  down is the APPLICABILITY CHAIN** — whether those obligations reach THIS operator, who is US-based
  and runs remudero privately. The chain has at least three unexamined links, and each could break it:
  (1) Art. 2 reaches a provider only when a system is placed on the EU market or its output is used in
  the Union — remudero is public under Apache-2.0, so the question is real, but "public repo" is not
  the same as "placed on the market"; (2) Art. 2(12)'s free-and-open-source exemption pointedly does
  NOT cover Art. 50 systems, so open-sourcing is not itself a defence and the plan never noted that
  either; (3) remudero orchestrates Claude rather than generating text itself, which makes this
  operator look like a DEPLOYER of an AI system rather than a PROVIDER of one — and Art. 50's
  machine-readable-marking duty in 50(2) falls on providers of generative systems. **NONE OF THIS IS A
  LEGAL OPINION AND THIS PLAN MAY NOT RECORD ONE.** The finding is narrower and is entirely inside the
  plan's own remit: **P17 has been ranked, and re-ranked, for five cycles on an external premise nobody
  ever checked.** That is W1-T392's defect with the audience changed from an internal fact to a world
  fact — an unexamined premise driving a ranking — and it is the second instance found in one day.
  **THE DISPOSITION.** W1-T71 keeps its real justification, which was always the stronger one and needs
  no deadline: the ledger proves our runs to US and nothing proves them to anyone else, and the
  in-toto/SLSA vocabulary is the interop play the commodity field cannot follow without this
  substrate. **P17 no longer moves on the calendar at all** — a future retro that reports it as
  "overdue" has re-imported the unchecked premise. If the operator ever wants the regulatory question
  ANSWERED rather than assumed, that is a lawyer's job and a `verify: human` task, not a retro line.
- **P26 — HELD; TRIGGER FIRED 2026-07-29 (W1-T105 shipped #744). GITHUB ISSUES AS A PROJECTION AND INTAKE
  SURFACE, NEVER THE PLAN BACKEND.** The backend swap stays REJECTED, and the reasons are recorded so it is
  not casually relitigated: issues are schemaless prose with no birth gate — no lint-plan at creation, no
  atomic multi-task ratification, no declaration order for the drain, no diff-scope enforcement of rule 15,
  no offline-deterministic linting. The field tolerates that because its agents carry no plan discipline;
  ours IS the plan discipline. What remains proposed over the yaml source of truth: **(a) an OUTBOUND,
  level-triggered, disposable MIRROR** (queued/blocked/escalated tasks → issues, closed on credit, NEVER
  read back as authority) and **(b) INBOUND INTAKE** — `candidate`-labelled issues flow through the now-
  shipped W1-T105 harvest into proposal candidates, rule 15 converting them to plan through the gate.
  GOLDEN (fixture-only): a hand-edited mirror issue body is OVERWRITTEN by the next sync (the authority
  test); a `candidate` issue yields exactly one cited proposal candidate and never a task. **TRIGGER
  FIRED 2026-07-29 and the harvest is LIVE — its output is this section's candidate list two cycles
  running.** Ranked low deliberately: the harvest WORKS, and what its output keeps arguing for is
  dispatch/credit integrity, not another surface.
**Closed proposals (P1–P8, P10, P11, P15, P21) — RETIRED FROM THIS LIST, ids preserved.** Per
RATIFY-OR-KILL each has a terminal status and the task is the record: **P1**→W1-T59 (filed,
deprioritized) · **P2**→retired, superseded by §9 · **P3**→W1-T58 · **P4**→W1-T24 (#75) ·
**P5, P6**→W1-T52 (open) · **P7**→rule 19's citation · **P8**→W1-T58 + the ratify-or-kill duty ·
**P10**→W1-T63 (#104) · **P11**→W1-T51 (#97) · **P15**→W1-T65 (#122) · **P21**→W1-T76 (#158,
absorbed by P22). A closed proposal's reasoning lives in its task or in the rule it amended.
*(R14: the per-id explanatory clauses are DELETED — this block was itself restating what it forbids.)*

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
   `$SSH_CONNECTION` is set). ⇒ daemon resolves the binary from **config, never PATH**; committed code
   carries no machine paths (path lives in `~/.config/remudero/config.json`, outside the tree).
   *(★ R16: HALF BUILT, HALF STILL BITING. **W1-T357/#1397 wired `resolveClaudeExecutable`/
   `claudeExecutableCache` through the real `daemonCommand` path**, so the daemon resolves from config
   as this finding requires. The OTHER half is unbuilt and was hit AGAIN this cycle: `loadConfig()`
   reads the config EAGERLY and `resolveClaudeBin()` shells `which claude` unconditionally, so a
   worker under a synthetic HOME with no `~/.config/remudero/config.json` cannot run `rmd review` at
   all — a fix-worker on PR-1396 had to **shim a fake `claude` executable onto PATH** to do purely
   deterministic work. Named across three cycles now (W1-T337/#1326, PR-1250, PR-1396). **Config
   should resolve LAZILY and degrade, not hard-fail, when the command needs no spawn.**)*
4. **★ RESOLVED — launchd + keychain OAuth: PASS**; WS-1 SHIPPED on it. Two survivors: a daemon started
   from a DEV SHELL inherits the key and would silently bill API, so **`buildWorkerEnv()` makes the dev
   path as safe as the launchd path** (do not delete env.ts on the launchd result — that process was
   clean by accident of context); and **reboot-resilience is still unverified ⇒ WS-7 chaos drill**.
   *(R14: W1-T293's expiry-aware keychain provisioning /#1169 now fails CLOSED on a locked login
   keychain, which is the first half of this finding's WS-7 residue actually built.)*
5, 6, 7. **DELETED (2026-07-21 / R15) — setup-day residue: moving version numbers, one operator's
   paste-block rule, one host's workspace and deny-floor paths.** All three are enforced where they
   belong (CLI version pinned as config per WS-7, node via engines/.nvmrc, machine layout in the
   gitignored `local/` overlay and `~/.config/remudero/`). **A plan that restates a moving number or a
   machine path teaches the reader to trust something that is wrong.** Ids retained so §14's and §5's
   citations stay stable.
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
9. **★ Scoped PAT still DEFERRED — workers carry ambient `gh` (cao825 repo-scope) reach.** Structural
   blocker: fine-grained PATs on an ORG-owned repo need an org-level opt-in that also governs the
   production fleet. Three durable points: containment rests on OS sandbox + deny-hook + worktree
   scoping (always the real boundary — the PAT was a blast-radius optimization); the compensating
   control is **secret scanning + push protection ON for both public repos**; scoped-PAT injection via
   `buildWorkerEnv()` is the open WS-1 hardening task §14 cites this finding for.
10. **★ SPIKE GROUND TRUTH (WS-0, all seven verdicts GREEN).** **Full record: `FINDINGS.md` in-repo**;
    this list is the LIVE RESIDUE + reference data only (sub-items b/c/d/e/h were deleted by R4 as
    stated-in-§9, shipped, or version-stale).
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
       accident, not construction; a populated `~/.bashrc` isolates nothing. Both remedies SHIPPED:
       **W1-T17/#99** (the fail-closed preflight probe) and **W1-T18/#100/#102 → W1-T170/#888** (the
       per-run isolated worker HOME). **STATUS: R12 saw the probe fire 3×; R13 and R14 saw ZERO, so
       P41 (hoist the probe to per-boot) is RETIRED and the per-run probe stands as adequate.** [PR #8]
    c. **The SDK yields the `type:"result"` envelope (`num_turns`, `total_cost_usd`, `subtype`) and THEN
       throws** from the iterator on an error subtype — read the envelope before the catch, or a failed
       run looks free in the ledger (failures are the runs that burn most). [PR #8]
    d. **`maxBudgetUsd` is checked BETWEEN turns**: a $0.01 budget produced $0.21 of real spend. It is a
       circuit breaker with up to one turn of overshoot, NOT a hard cap — budgets need headroom. [PR #8]
    e. Reaffirms 10a (settings fail SILENTLY under `-p`) and the `$loose`-schema catch (W1-T1): validating
       against the SDK schema alone PASSES a misplaced key — validate shape explicitly. [WS-0 / W1-T1]
12. **★ SELF-UPDATER RACE (run W1-T1C-1784038021919).** A worker spawn landing in the background
    self-updater's npm unlink/relink window dies **ENOENT**, which the SDK misreports as *"native binary
    not found"*; fleet concurrency is a **thundering herd** that widens the window. Mitigations:
    `DISABLE_AUTOUPDATER=1` (confirm empirically — rule 7), ENOENT-class spawn retry (safe: no
    turns/cost before the first message), CLI version pinned as config (WS-7). **The first "guard caught
    it AFTER the burn" case, and the reason §4B Flight control exists.** Full narrative, the two
    diagnostic corollaries and the falsifier live in `DIAGNOSIS.md` + `LEARNINGS.md` (§8A: retrieve, do
    not inject). *(R14 trimmed the restatement this entry's own last line already called deleted.)*

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

## 5E. Decision quality — the two-system model

**The harness makes thousands of judgments an hour under uncertainty, and its observed failure modes are,
almost one for one, the documented failure modes of fast judgment. This plan has been rediscovering them
one incident at a time, without names.** Naming them is not decoration: an unnamed bias is re-derived
every cycle at the cost of a PR, while a named one is greppable, is checkable in review, and can be
argued about before it burns a dispatch. This section is VOCABULARY plus a map of what already gates
each failure — it introduces no new machinery of its own (that is P43/P44/P45).

**The two systems, in this harness.** Every verdict here is produced by one of two layers.
**FAST** is the cheap deterministic layer — the keyword floor, the linter, a `grep`, an authored
`status:` field. It is always available, costs nothing, and is wrong in one specific direction: it
answers an EASIER question than the one asked and returns the answer as if it were the hard one.
**SLOW** is execution — running the proof, executing the grep against the head, unioning the ledger with
its rotations, reading the `Remudero-Task:` trailers off merged PRs. It is correct and expensive.

**The doctrine: the harness must always know which layer produced a verdict, and must never record a FAST
answer in a shape that reads like a SLOW one.** Read that way, the plan's existing verdict vocabulary
already IS a two-layer labelling discipline — `CAPPED`, `executed_pass` / `executed_fail`,
`executed_stale` (W1-T273), `not_executable`, `exec_error`, `automerge.arm_skipped` — and every one of
them exists because a FAST answer once passed for a SLOW one. The `automerge.armed` incident is the
counter-example that proves the rule: **176 rows, 135 blind, 17 provably false**, because a step NAME
asserted an outcome the writing function never checked.

| failure mode | where it bit, measured | what gates it today |
|---|---|---|
| **Substitution** — answering an easier question | the keyword floor answers *"does the body contain the words?"* for *"did the work happen?"* | **GATED**: `executed_pass`/`executed_fail` override the floor (W1-T51/#100); `executed_stale` closes the residue (W1-T273) |
| **What-you-see-is-all-there-is** | a `review.posted` count read **212** over the live ledger and **912** over the union with 658 archives — a ~4× undercount | **CONVENTION ONLY** (CLAUDE.md); the union is not enforced in code |
| **Law of small numbers** | the `diagnose` mount row at **n=1** (*"still do not re-base"*); the class table's single `src` row | **PROSE DISCIPLINE**, not a gate → P44's refuse-to-derive clause |
| **Denominator neglect** | R14: the SAME **1736** turns reported over **37** runs (weekly) and **48** (cycle) | **P40(ii)**, UNBUILT |
| **Anchoring** | **254 of 315** tasks at exactly `budget_usd: 100.00`; 13 distinct values, all round | **P44** |
| **Regression to the mean / illusion of cause** | ledger credit 16% → 64% → **40%**, no cause named for EITHER move; R13 demoted P29 on 20→3 and R14 read 23 | **P43** — nothing today |
| **Escalation of commitment** | four consecutive PRs rewrote the arm path in three hours without fixing it (#968→#973→#975→#981) | **PARTLY**: W1-T271/#1040's lifetime dispatch cap |
| **Planning fallacy / inside view** | per-task budgets guessed rather than drawn from ~574 recorded runs; W1-T3 died against a GUESSED $4 cap | **P44** |
| **Hindsight & narrative fallacy** | a retro writes one coherent causal story per cycle; CLAUDE.md was ordered by RECENCY until #1120 | **P43(i)** pre-registration |
| **Narrow framing** | the drain dispatches one task per tick; proofs were fixed one-at-a-time across five PRs | **PARTLY**: §5C's retro MINE duty (*"a CLASS-level fix, NOT another per-task patch"*) |

**Two standing consequences, both already half-present in this plan and worth stating once.** First,
**a number that keys a decision carries its denominator and its window, or it is not printed** — P40(ii)
generalized: `9.441` and a three-times-identical `21%` are the same defect wearing different clothes.
Second, **a causal claim names what would have happened otherwise.** "Metric moved and X shipped" is a
narrative; "metric moved beyond its own prior variance, and the runs X could not have touched did not
move" is a finding. R13 is the plan's own best evidence for the distinction: it reported the reversal
honestly and could not defend it, which is precisely the position P43 exists to end.

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

> **The human-feedback loop and the autonomy dial (oper#warp-podcast-2026-08-11, re-aimed at the
> console by oper#github-touchpoints-2026-08-12 — minimise human time in GitHub; the harness is
> the product).** Two practices adopted from Warp's published factory discipline, both rmd-native
> rather than imitative: the harness's five human-feedback capture surfaces (reframes, one-tap
> verdicts, rejection reasons, question answers, operator notes) gain a weekly SYNTHESIS that
> proposes one artifact diff per cycle THROUGH THE INBOX — ratified in-console, the plan PR
> opened and auto-merged by the harness as transport (W1-T436 — the intake pump beside
> W1-T418's efficacy meter); console-captured verdicts with steering notes become fix-rung
> evidence, wiring W1-T141's unused route and W1-T78's producer-less re-arm with no GitHub read
> (W1-T435); and autonomy becomes a MEASURED dial: the zero-touch merge rate and its cost, split
> by verdict class so the ratchet moves where proofs are strong first (W1-T437, beside
> W1-T424's correctness join). The operator turns every dial; the harness only reports it (P48).

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
bar. Inventory, the two honest deltas and the WS-7 residue are stated ONCE in NET STATE. The scoped
remainder is EMPTY; only §5C's linter CODE (W1-T20c) is still queued. *(R14: the paragraph explaining
which lists R12/R13 deleted here is itself deleted — a deletion does not need a standing memorial.)*

**WS-2 — Flow & quality**: reviewer worker + rubric; provenance linter hardened; **merge serialization
per repo** (Bors-style: never two auto-merges racing one main); **task heartbeats + stall detection**
(no ledger output in N min ⇒ classify hung, kill, transient-retry); stuck-PR shepherd
(absorbs/retires pr-pipeline.sh); rate-limit-aware dispatch governor; scope guard (diff/files budget);
first fleet-repo target (wild-trails backlog). Acceptance: two tasks run concurrently, one induced
conflict auto-resolves, one induced hang is detected and recycled; proof = ledger timeline.
*(The N-worktrees/isolated-HOMES design paragraph SHIPPED as P19 — W1-T170/#888, T171/#890,
T172/#896 — and was deleted here by R13.)*

★ PARALLELISM GRANULARITY (grounded — 2026 field consensus + arxiv, Architect 2026-07-16; **kept
because P19 CLOSED on it and rung 2 is banked against it**): parallelize INDEPENDENT TASKS (the DAG),
NEVER one task's implementation across sub-agents. Worktrees solve FILE collisions, not
DEPENDENCY/SEMANTIC ones — those surface only AT INTEGRATION — so what makes parallelism safe is
HIERARCHICAL TASK DECOMPOSITION (our `depends_on` DAG): independent nodes run concurrent, dependent
ones SEQUENCE. Intra-task sub-agents are acceptable ONLY for read-heavy recon (additive outputs),
never for splitting an implementation.

**WS-3 — Principles engine**: principles.yaml loader; TDD Guard integration + red→green REPORT
proof; coverage ratchet + jscpd + dependency-cruiser CI templates; auto-filed refactor tasks;
reviewer rubric wired to profile. Acceptance: a `tdd: strict` task is BLOCKED when implementation
precedes a failing test (planted violation), passes when honest; proof = hook denial + green run.

**WS-4 — OSS packaging**: rename executed (D-1); Apache-2.0; `npx remudero init`; adapters; permission
profiles with `standard` default; README + security disclosure + quickstart (<5 min to first looped
PR on a toy repo); CI templates published. **Setup Agent (Q3/G-16)**: an agentic onboarding session
that interviews the operator, **counsels public-vs-private without deciding it** (G-1 was Craig's
answer, never the shipped default), then executes setup via sub-agents — org-aware repo creation
through gh (explicitly setting allow_auto_merge, delete_branch_on_merge, secret scanning + push
protection: **fresh-repo defaults break agent pipelines, FIELD FINDING 8**), plan-repo scaffold, CI
templates, hooks/settings, first golden run; PAT minting stays MANUAL with guided deep-links.
**The website is its OWN workstream, WS-12** (D-5) and must not couple to the daemon's CI; its
quickstart is still the WS-4 acceptance bar.

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

- **D-1 Name — CLOSED 2026-07-14: Remudero (domains purchased)**. Alias `rmd`; binary `remudero` with
  `rmd` symlink. Only the REUSABLE method survives (saga deleted by R12, rationale deleted by R14 —
  a closed decision does not need its deletion justified twice): **container DNS screening across
  .dev/.io/.com/.sh, .com-NXDOMAIN demoted to a weak signal, finalists restricted to zero-footprint
  compounds** (0 GitHub repos, no registry packages, no web presence).
- **D-2 License — RESOLVED**: Apache-2.0 (patent grant; ships in PR #1). Veto window: before the
  spike PR merges.
- **D-3 Plan co-editing tech**: CRDT (Yjs) vs PR-proposals-only. Defer until v1 UI is lived-in (rec).
- **D-4 OSS default permission profile**: `standard` (rec). Craig's instance: `yolo`.
- **D-5 Repo shape — RESOLVED 2026-07-14: MONOREPO for everything that consumes the daemon API;
  separate repos for everything that does not.** **Repo shape follows CONTRACT COUPLING — nothing else
  decides it.** The monorepo `remudero` (npm workspaces) holds: the **daemon** · **CLI** · **MCP** ·
  **`packages/api-client`** (the generated contract, §7A) · **`apps/dashboard`** (web) ·
  **`apps/desktop`** (Tauri macOS shell) · **`apps/mobile`** (Tauri iOS shell). THE ARGUMENT, in one
  line: all consume the SAME daemon API contract, so a breaking change **fails CI across ALL consumers
  atomically, in one PR**; split repos make that drift silent until runtime. **SEPARATE, deliberately**
  (no contract coupling): **`remudero-site`** (WS-12) · **`remudero-commons`** (WS-11) ·
  **`remudero-pro`** (§6A — never mixed with core). See §7A and §7.
- **D-9 CLA vs DCO — RESOLVED: DCO**, one-way door closed knowingly (§6A). Reversal requires a CLA
  from day one; retrofitting is impossible. Revisit ONLY if the project's purpose changes materially.
- **D-8 Monetization**: open-core per §6 stance (rec); shape/pricing decided post-WS-6 traction,
  never earlier — premature paywalling kills the community the differentiation depends on.

- **D-10 Mutation gate — does it earn its scope? — OPEN, and now OPEN ON A DEFECT OF ITS OWN.** The
  `mutation-ratchet` required check mutation-tests ONLY `src/lib/classify.ts` (261 lines); the other
  ~15k lines of `src/**` have ZERO mutation coverage, and every sampled run since it went live concluded
  SUCCESS. Its cost is measured and small (~18–24s warm/diff-scoped since W1-T108; the 13-minute figure
  was the pre-W1-T108 tax and is gone), so cost is NOT the open question. **★ R16: THE OPEN QUESTION HAS
  BEEN UNANSWERABLE FOR SEVEN CYCLES, AND THAT IS THE FINDING.** This entry instructs *"THE RETRO MUST
  REPORT, WITH DATA: mutants killed vs survived over the gate's LIFETIME, and whether it has EVER caught
  a real escape"* — **and no gather has ever carried that column**, because the instruction was written
  as prose in a decision entry rather than built as a gather rung. A standing demand on an instrument
  that nobody wired is P38 in the plan's own §11: **the decision cannot resolve until someone ships the
  measurement, so D-10's real blocker is a task, not a judgement.** Until then the disposition stands:
  the gate justifies itself with data or gets its scope cut into the nightly full-scope run (W1-T133),
  with the PR gate staying the fast diff-only check.

- **D-11 Instance topology — CELLS: one rmd instance per codebase; nothing mutable shared between
  cells — OPEN, RECOMMENDED, awaiting operator ratification.** Promoted from the Banked queue's
  "Load/scale story: multiple products, one daemon vs. daemon-per-product" by the operator's
  architecture brief (oper#architecture-2026-08-11: same container or one per codebase, and
  remudero.com as the login-and-control surface). **THE RECOMMENDATION: daemon-per-product, where
  an instance (cell) = one codebase + its own config root** — own ledger, governor, budget, drain
  lock, inflight/KICK markers, worktree pool, clones, console port; on the mini, a cell is a
  sibling config root + launchd label set; on Linux/cloud, a cell is one container of the shipped
  worker image (`deploy/Dockerfile` + `verify-image.sh`, landed untasked via #1474/#1480 — this
  entry is their first plan anchor). **THE EVIDENCE IS THREE-WAY CONVERGENT**: (a) two measured
  outages from ONE shared mutable tree — 2026-07-29 and 2026-08-11, both the shared
  `node_modules` emptied through a worktree symlink (now refused in code, `SymlinkInstallRefusal`);
  (b) the code inventory — every task-id-keyed decision read on instance-global state is
  repo-blind (W1-T429), the clone keying is owner-less (W1-T403), the ceiling multiplies by N
  (W1-T408); (c) the 2025–2026 industry convergence: ephemeral single-tenant isolation units,
  with every documented incident class (cache poisoning, runner backdooring, socket escape) a
  shared-mutable-state failure. **THE 2026-07-21 TWO-DISPATCHER REJECTION IS ANSWERED, NOT
  OVERRIDDEN**: that rejection was two UN-governed dispatchers on ONE repo's plan; cells are one
  governed dispatcher per plan, sharing neither plan, ledger, nor locks — and the N=1 parallelism
  obstacles apply WITHIN a cell, unchanged. **remudero.com IS TIER 2 MADE CONCRETE, NOT A NEW
  INVENTION**: accounts exist at the relay only; the instance dials OUT (the GitHub-runner /
  Outposts / Coder shape — enrollment token, no inbound ports); the relay stays a transparent
  proxy over the §7A console contract, scope granted by the identity seam; portfolio-across-cells
  is the §6 Pro "multi-project portfolio views" candidate; core stays fully self-hosted per §6A.
  Knowledge does NOT fragment across cells: same-machine cells share the org-brain homes by
  explicit path (W1-T432); cross-machine/cross-user stays W1-T425's redacted hash-pinned
  transport (Tier 3). **THE ARC**: W1-T429 (repo-scoped keys) → W1-T430 (identity seam, the §6A
  before-any-Pro-code obligation) → W1-T431 (outbound relay client, loopback-tested) → W1-T432
  (shared knowledge homes) → W1-T433 (wild-trails cell pilot, gated on ratifying THIS entry and
  the operator's WS-2 deferral judgment). Per the P48 norm this is a recommendation — the
  operator ratifies; the pilot dispatches nothing until then.


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
8B. The loop never waits on a human unless the plan says so. Idle = groom.
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

23. **WRITE-SIDE ATOMICITY — every multi-process-visible write is atomic or locked.** The write-path sibling
   of cannot-observe ⇒ wait. This codebase has a rich, hard-won READ-side doctrine: a value that cannot be
   observed is marked indeterminate and deferred, never silently downgraded to absent or permitted
   (W1-T130/T179/T181/T197). It has no matching write-side doctrine, and the 2026-07-21 recon named the
   consequence precisely: *read-path integrity is doctrine, write-path atomicity is unowned*. The gap matters
   because the same invariant a read-side fix protects is REINTRODUCIBLE THROUGH A WRITE RACE UNDERNEATH IT —
   W1-T179's monotonic-under-darkness guarantee is defeated not by a flaw in its own logic but by a truncating
   `writeFileSync` on the file it reads.
   The rule: any file a second process can observe is written whole or not at all — temp-file-plus-rename, an
   append the kernel serializes, or an explicit lock. And a file that cannot be parsed is a DIFFERENT
   observation from a file that is absent. Collapsing those two is the write-side form of
   cannot-observe ⇒ permitted, and it is how a torn read becomes a zeroed circuit breaker or a pruned live
   worktree.
   Three fixtures from the 2026-07-21 recon, each verified at source. (i) `appendLedger` has no atomicity
   guarantee and its reader parses a torn line to `{}` — silently invisible to every consumer, on the file that
   backs the dispatch circuit breaker (R-8/R-16, W1-T206). (ii) `status.json` is written by four callers with a
   truncating write, so a reader arriving mid-write loses exactly the cached projection W1-T179 exists to
   preserve (R-17, W1-T207). (iii) `run.lock` collapses an unparseable read and an absent lock to the same
   `null` (R-18, W1-T208).
   One honest caveat, because the doctrine should not be justified by a fiction: `appendFileSync` opens
   `O_APPEND`, so concurrent appenders do NOT overwrite each other and the recon's suggested PIPE_BUF guarantee
   does not apply to a regular file. The exposure is a partial write and a silent torn-line read, not a lost
   append. Doctrine earns its keep by being true.
   Executable duties: W1-T206 (ledger), W1-T207 (status.json), W1-T208 (run.lock), W1-T209 (breaker-safe
   archival). [recon intake, 2026-07-21]

24. **SECRETS-AT-REST — a credential never lives in a log, a URL, or an argv.** The threat model this plan
   grew up with is a malicious worker escaping its sandbox, and it is well served: scoped PATs, containment
   probes, deny-floor hooks. What it did not cover is the mundane leak — the operator's own credential sitting
   in a world-readable file because a startup banner printed it. The 2026-07-21 recon put it exactly: the plan
   tracks scoped PATs and containment sandboxing but not *a token in a log, a token in a URL, no rotation path*.
   The rule has three parts. A secret is never printed to stdout or stderr by a long-running service, because
   that output is routinely redirected to a file that outlives the process. A secret never travels in a URL,
   because URLs are copied, screenshotted, bookmarked, proxied and restored by session-restore — a link is the
   worst possible place to put a capability. And ROTATION IS A DOCUMENTED PATH, not an implementation detail
   someone can reconstruct: an undocumented rotation path is operationally an absent one, which is why R-31
   was a real finding even though `rm` had always worked.
   The corollary that makes it actionable: exposure is judged by where a secret HAS BEEN, not by who was
   watching. A token that reached a log file, a terminal transcript, a screenshot or a chat window is
   compromised and must be ROTATED, not merely un-shared.
   Fixtures: R-5 — both bearer tokens printed to a 0644 `serve.log` with the WRITE token embedded in the
   console URL, so merely running the command leaked a fleet-control capability to disk (fixed #473, rotated
   the same day). R-31 — token generation is create-once/read-thereafter, making rotation a `rm` nobody had
   written down (documented #473). [recon intake, 2026-07-21]
25. **INSTRUMENT CHANGES RIDE ALONE — a diff may change what a gate MEASURES, or what the gate concludes
   about the product, never both in one PR.** RECORDED, NOT NEWLY DECIDED: this rule has been ENFORCED IN
   CODE since W1-T297 while §12 carried no text for it. W1-T297's own shard promised the prose ("ships with
   the MASTER-PLAN §12 amendment that states the RULE (Standing rule 25) this task makes executable"); the
   enforcement landed and the amendment did not, so for roughly two hundred PRs every citation pointed at a
   rule that did not exist here. THE PROSE THEREFORE FOLLOWED THE CODE, not the other way round, and a
   reader should weigh it accordingly: where this entry and `src/lib/review.ts` disagree, the code is what
   refuses PRs. MEASURED AT `c709493`, re-derived rather than carried forward: the exact phrase "Standing
   rule 25" appears at **12 sites across 6 files, 8 of them inside `src/`** (`src/lib/review.ts` ×6,
   `src/run-task.ts` ×2, plus two `test/` suites and two shards); case-insensitively, "rule 25" appears
   **38 times across 28 files**, because ~22 task shards now run an explicit "RULE 25 CHECKED BEFORE FILING"
   step. It is cited far more often than it was written. This entry grants the gate no new reach. THE MEASUREMENT-INSTRUMENT SURFACE is one exported constant,
   `INSTRUMENT_SURFACE` (`src/lib/review.ts`) — `.github/workflows/`, every `scripts/*-ratchet.mjs`,
   `scripts/diff-coverage.mjs`, every `scripts/*-baseline.json`, `scripts/mutation-relevant-paths.json`,
   `stryker.conf.json` — and BOTH consumers derive from it (`USER_VISIBLE_SURFACE_RE`'s instrument arm and
   `detectInstrumentEntanglement`) so the two can never drift into a second hand-maintained copy. THE
   PREDICATE IS ENTANGLEMENT, NOT INSTRUMENT-TOUCHING: refusal requires at least one instrument path AND at
   least one product path (`src/`, non-test) in the same diff. An instrument-only diff — optionally carrying
   its own `test/` falsifier and a `docs/` update — is the SANCTIONED shape, and so is a src-only, plan-only
   or docs-only diff. `isProductPath` is `path.startsWith("src/") && !isTestPath(path)`, so `test/` is
   deliberately NOT the product half — the design's own carve-out, because otherwise an instrument-only PR
   could never carry the fixture that proves it; `test/diff-coverage.test.ts` is the established home for
   exactly that, and a gate implemented in a test entangles with nothing. THE REFUSAL IS HARD AND CANNOT BE
   FORGIVEN LATER: `instrumentEntangled` is one of the terms in BOTH of `judgeReview`'s rollups — `state`
   and `floorState` — so it forces `state: "failure"`, and because `applyVerdictStability` (W1-T178)
   suppresses only an UNCHANGED-HEAD SEMANTIC downgrade (`floorState === "success"`), an entanglement
   failure can never be suppressed by verdict stability. It is a structural, diff-derived fact, and it
   preempts the ordinary unmet-criteria text rather than queueing behind it. WHAT A REFUSED WORKER IS TOLD
   (`src/run-task.ts`), because the rule should read the way the refusal reads. The escalation SUMMARY,
   verbatim: `blocked_review: instrument change entangled with src/ in one PR (Standing rule 25) — <pr
   url>`. Its DETAIL names the instrument path(s) and the `src/` path(s) found beside them, calls them "two
   independently falsifiable claims (\"the instrument is right\" and \"the code is right\") shipped as one
   green, self-graded by the very instrument version it also changed", and states the part that makes this
   different from an ordinary block: "No worker may legitimately resolve this by writing more code." The two
   OPTIONS it offers are the only sanctioned exits — **split**, "land the instrument change in its own PR,
   then rebase this one onto it — the sanctioned shape", or **revert**, "revert the instrument hunk on this
   branch, keeping only the `src/` change, then re-review". A rule that only refuses re-teaches nothing, so
   the refusal ships its own remedy.
   WHY IT IS A RULE AND NOT A STYLE NOTE: a diff that lowers a coverage floor
   while also changing the code that floor measures is self-certifying — the same PR moves the ruler and the
   thing being measured, and no reviewer is prompted to notice. Split it: the instrument change rides alone
   and is judged on its own evidence. [W1-T297; amendment reconstructed 2026-08-11 (#1596) from the
   enforcement it was always meant to accompany, and completed 2026-08-12 with the three enforcement facts
   that first pass omitted — the verbatim `blocked_review` refusal, the never-suppressible property, and the
   re-measured citation counts]

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

**NEXT: see NET STATE + SHIPPED log.** The kick order lives in NET STATE and NOWHERE ELSE.

**Craig's standing side-items (outside Remudero):** (1) the `~/.zshrc` API-key billing leak — **see
FIELD FINDING 2**. (2) One-time employer IP/moonlighting policy glance; the public tree is already
scrubbed to that standard.

**Grill RESOLVED (complete record — R14 folded the one-line-per-id list; every directive below is
enforced in the section named, which is the real record):** **G-1** public from day 1 (§6/§8) ·
**G-2** proto-runner; L1 COMPLETE, L2 active · **G-3** pace to Max limits, no dollar cap (§9) ·
**G-4/G-7/G-8/G-9/G-10/G-11** naming + domains, ALL MOOT — recorded ONCE in **D-1** · **G-5** tailnet
dashboard first, Expo later (§7) · **G-6** Issues + Discussions OFF until WS-4, CODEOWNERS from PR #1
(§6) · **G-12** Craig instance Max 20x; **tier is per-instance setup config, never a plan constant**,
auto-discovered on attach (§9) · **G-13** thinking_default: medium · **G-14** quiet-hours
optional/off, **Pause (drain-and-hold) in the control set** · **G-15** nothing Craig-specific in the
default path ⇒ **imessage-local reference adapter** (WS-1) · **G-16** first project = remudero itself;
onboarding = **Setup Agent** (WS-4) · **G-17** **Tier Invariant** — the main agent always rides a
higher-thinking mount than the coding agents; relative, config-validated, flywheel-constrained (§9).

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
- ~~Load/scale story: multiple products, one daemon vs. daemon-per-product~~ **PROMOTED to §11
  D-11 (cells: one instance per codebase)** — oper#architecture-2026-08-11.
- ClawApp inbox integration as a notifier adapter (Craig instance).
- Plugin/skill marketplace listing once stable.
- Cross-agent support (Codex exec) — explicitly parked; Claude-first keeps contracts tight.
- Tournament dispatch (two approaches, reviewer picks) for high-risk tasks — expensive, park until
  verdict calibration proves the reviewer.
- P19 rung 2 — Tree-sitter symbol-touch locks; unbanks only when a rung-1 file-overlap ESCAPE is
  observed in the ledger (W1-T172's `dispatch.concurrent_set` line is the trigger).
