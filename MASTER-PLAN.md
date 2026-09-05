# REMUDERO — Master Plan (v2.58 · synced 2026-09-02)
**FOCUS — EIGHT OF ELEVEN RUNS ENDED `blocked_ci` AND SEVEN OF THOSE EIGHT HAD ALREADY MERGED.**
11 runs declared; **57 merges in-window, hand-verified over REST — 20 on `run-W1-*`, 1 on `run-RETRO-*`,
36 hand-named of which FIVE change `src/` or `test/`**; ledger credits 3, union 10; $5.655/run over a
~6.1-hour window — **$20.733 per ledger-credited ship, $6.220 per union ship and $3.110 per
hand-verified run-lane merge: three prices from one window spanning 6.7×, every one of them divided by
ONE lane (DR-25).**
**(1) ★ THE MAST CENSUS IS 87.5% WRONG AND ITS ERROR RUNS IN ONE DIRECTION ONLY.** The failure
distribution reports `verification` × 8 — one row per `blocked_ci` verdict — and **SEVEN of those eight
tasks are in this cycle's own SHIPPED list, merged gate-side**: W1-T2613/#3651, T2617/#3661,
T2618/#3662, T2620/#3673, T2621/#3680, T2625/#3672, T2629/#3681. R43 found ONE verdict misattributed and
minted P67 on it; this cycle the census's error IS the census. **No new id — this is the standing
credit-artifact fold-line's largest single reading, and it routes to P47.** **DR-28 is written on it:**
a verdict class is not a failure class until you check which of its members merged.
**(2) THE n=1 CONTRAST ROW FLIPPED SIGN IN ONE CYCLE.** R43 published a `docs` row at **100% merge
rate** and called it a FALSE POSITIVE. R44's `docs` row is **1 run, 0 merged, 0%** — and its single
member **W1-T2625 MERGED, as #3672**. The same n=1 cell is now a **FALSE NEGATIVE**. Thirty-three cycles
have produced nine contrast rows, none past n=4, and the cell has now been wrong in **both directions**.
**(3) TASK G RETURNED FROM ZERO TO TEN, AND EVERY MEMBER IS NAMED.** Ten of the twenty in-window
`run-W1-*` merges are credited by nothing: **SIX carry malformed epochs** (T2703, T2717, T2713, T2709
second-quantised; **T2712 and T2692 carry SECOND-precision ids, a shape P64 never named**; and
**T2703's epoch falls ~6.4 h AFTER its own PR merged**), **TWO are straddlers** (T2610 landing from last
cycle's open residue, T2623 merging 10 minutes past the gather's newest row) and **TWO are DAEMON
fix-rung branches** (T2704, T2711). **A class that read zero one cycle refilled the next, which is
exactly what DR-18/DR-19 exist to protect.**
**(4) ★ THE SYMBOL THIS FILE CALLED DARK FOR SIXTEEN CYCLES WAS WIRED BY THE OTHER LANE.** SHIPS-UNWIRED
reads clean for the first time in this log, because **#3637 (`codex/wire-main-health-observation`)
shipped `src/lib/main-health-rung.ts`**, which calls `mainHealthFromRollup` at line 103 — one cycle after
that same lane FILED the task for it (#3626/W1-T2683, recorded by R43). **P66's thesis is now
demonstrated end to end, and this document's own DARK roster carried a false claim until this sync
deleted it.**
**(5) HALF THE POPULATION WAS RECONNED WITHOUT ITS OWN TASK RECORD.** Five of eleven runs — W1-T2613,
T2619, T2623, T2625, T2629 — report in their own harvest prose that recon had no task spec to scope
against; the other five report the opposite explicitly. **MINTED P68, entering at rank 3; the highest
prior id was P67.**
Next: **P47 → P67 → P68 → P65 → P66 → P64 → P63 → P62 → P57 → P60 → P61 → P56 → P58 → P59 → P40 → P43
→ P53 → P54 → P48 → P50 → P52 → P38 → P49 → P55 → P33**.

**Header discipline (v2.17).** Sync date + current focus, nothing else; the sections are the source of
truth. A retro that re-inflates this header has failed the HARNESS-COMPRESSION bar.

**Retro ledger (R1–R30 folded — the SHIPPED log's own section headers carry every id and date):**
R1–R9 seeded CALIBRATION + P1–P32, corrected the false-merged W1-T54b attribution (#80 → #91) and
closed P1–P11+P15+P21+P25+P27+P31 · R10–R15 logged the console/inbox, 94-task gate-integrity,
ratified-backlog, account/status-board, gate/claim-integrity and console-tabs/governor-wiring cycles,
RETIRED **P28** and **P41**, CLOSED **P12/P13/P14/P18/P19/P20/P23/P24/P34/P37**, mined
**P35/P38/P39/P40/P41/P42/P46/P47**, and recorded the first pre-committed effect test to PASS ·
R16–R18 logged the daemon-lane, board/verdict-integrity and GAP-FILL cycles, scored this plan's first
`HIT`, STRUCK the sibling-rejection metric P29 had been ranked on for eight cycles, and cleared the stale
assertions blocking the plan-state truth rung · **R19–R30 FOLDED TO ONE LINE BY R31** (2026-08-15 →
08-26; the write-tier/freshness, rate-limit/identity, review-state/install-root, pacer/credit-predicate,
arm-integrity/id-allocator/self-harness, containment-storm/attribution, fix-rung-park/sweep-stand-down,
credit-surface/ratchet-typing, ledger-intent/push-lease, probe-budget/containment-anchor,
fix-rung/latch-render/containment-evidence and proof-gate/credit-resolver/serve-idempotency cycles —
25/30/31/31/30/40/33/38/31/28/27/18 merges, 12/14/19/18/17/29/27/25/17/18/14/7 credited): they promoted
**P40 then P47 to rank 1** on FIRED falsifiers, opened the first non-clean plan-health sweep, fired the
`UNMEASURED` rule on the WHOLE `implement` row (**freezing W1-T5's mount table**), closed **P17 by
shipping** (`rmd receipt`, W1-T71/#2182) and **P50/TASK M(i) by shipping** (T1281/#2685), minted
**P49/P50/P51/P52/P53/P54** and **TASK K/L/M/N**, observed the **first straddlers**, **PARKED P51 on its
own falsifier at zero**, **STRUCK the word `foreign`** at 0-of-~65, scored the **first clean 4-of-4
sweep** (R28), recorded the **first inversion of the credited/uncredited spend split** (R29), caught the
promotion judge **reversing itself on an unchanged entry** and then **completing a round trip** (R29,
R30), found the gather **declaring 27 runs above a body that names 33** (R30), and wrote **DR-4**–**DR-14** (*read past your own gather* · *the defect is the JOIN* ·
*verify the DENOMINATOR* · *a run-start window cannot be reconciled with merge-time credit* · *count the
EVENT once and the labels never* · *a correction inside the scanned section is not a correction* ·
*register the band, never last cycle's point* · *a scope sized by a volatile measurement is sized on the
MAXIMUM observed* · *register off the gather's existing output, never off work that must ship first* ·
*a shipped FIELD is not a printed COLUMN* · *register at least one row that requires something to have
MOVED*) ·
**R31–R37 FOLDED IN** (…778937848 / …828128305 / …858337550 / …883095112 / …922605773 /
…011469299 / …096158805; 4-of-12, 8-of-15, 2-of-7, 5-of-9, 9-of-18, 10-of-17 and 10-of-15 credited —
the stand-down/prompt-fingerprint/replay-verb, divergence-detector/provenance-reader/repeat-escalation,
message-set-comparison/ledger-read-intent, credential-margin/shallow-checkout/console-write-grant,
CI-fast-lane/head-resolved-criteria/signal-accounting, strike-cap/proposal-lifecycle/liveness-sensor and
follow-up-router/at-head-criteria/per-spawn-worker-home cycles): they minted **P55–P61**, wrote
**DR-15–DR-21** (*quote the proposal's own sentence* · *prove the ARTIFACT, not the ATTRIBUTION* · *a
verbatim bar is not yet a correct bar — also name the task classes whose own deliverable already
satisfies it* · *a class that empties has not been solved until you check where its members went* ·
*before retiring a class on its zero, check whether a class still HELD would claim the same members* ·
*class identity is refuted by ONE disjoint member and never confirmed by an overlap* · *an exclusion
clause is a scoring convenience, never a finding*), caught the union **crediting a plan-only PR as a
task's implementation** and then **a merged PR with a ZERO-file changeset**, **executed P55's deletion
experiment and resolved P55 against itself**, found the rejection label **wrong on all thirteen of its
own rows**, **RETIRED TASK G by deletion and then UN-RETIRED it one cycle later** on #3237/W1-T2387 —
the only reversed retirement in this log — **FOLDED P51 into TASK L**, recorded **the first paid
ratification telemetry in twenty-four cycles**, and caught **this document's own lane minting a trailer
by quoting one** (#3262).
**R38–R41 FOLDED TO ONE PARAGRAPH BY R43** (…144172947 / …193081371 / …251442324 / …294290880; 8-of-17,
2-of-21, 8-of-39 and 0-of-9 credited — the duplicate-dispatch, CLI-verb-census, regenerable-artifact and
first-token-mint cycles). They minted **P62** (*the same task is dispatched five times and the only rung
that notices calls the duplicate's merge foreign*), **P63** (*a gate whose prescribed remedy lives in a
file the declared scope forbids is a DEADLOCK*), **P64** (*a second-quantised `run-<id>-<epochMs>` branch
is not a run*) and **P65** (*the run lane is no longer the whole shipping surface*); wrote **DR-22**–
**DR-25** (*state how many distinct TASKS a run denominator covers* · *a gate's REMEDY is part of the
gate* · *before counting a merge as uncredited, prove a RUN exists to credit it* · *a price is only as
wide as the lane its denominator can see*); recorded the log's **first window whose merge count exceeded
its declared run count**, its **lowest credit reading and first exit BELOW the band**, the **only cycle
in which the ledger wrote `merged` zero times**, the **first band re-cut (to 20–65%)** and the
**Architect lane's ten-cycle zero breaking at 15.2% on ONE of four `step` keys**; and closed **P48's
share-column site**.
**R42–R43 FOLDED TO ONE PARAGRAPH BY R44** (…324628827 / …350665543; 6-of-11 and 12-of-16 credited —
the served-model/capability-ladder and the operator-prior/routing-objective cycles; 50 then 38 in-window
merges, 29 then 23 hand-named, TWELVE changing `src/` or `test/` in each). They minted **P66** (*two
authoring lanes draw from ONE task board and the credit resolver's only reaction to a collision is to
refuse the winner as `stale/foreign`*) and **P67** (*a merge is credited at the instant it lands and
nothing ever re-reads the trunk — the cheapest, highest-merge-rate row in the calibration table red-lit
`main` for an hour and charged the repair to a lane with no ledger*); wrote **DR-26** (*a pre-committed
consequence survives its own HIT — re-register the clause, never retire it on the reading that spared
you*) and **DR-27** (*a merge rate measures the gate at one instant, never the work*); recorded the
credit band's **re-entry at 50%** and then its **first exit ABOVE itself at 100%**, the **RETURN of the
ledger's `merged` writer**, `stale/foreign`'s **first genuinely foreign member**, **P38's first outright
REVERSAL on unchanged evidence**, and **P54's rolling-window mechanism**; **RE-DERIVED TASK L and FOLDED
IT INTO TASK G**; and **MOVED THE MOUNT FREEZE'S RELEASE CONDITION off TASK L onto P65's classifier**.
**R44 (…374498685, this sync)** logs the **3-credited-of-11 cycle (W1-T2613–T2629)** — **57 in-window
merges, 36 hand-named, FIVE of those changing `src/` or `test/`** — and scores **3 hits / 2 misses /
1 boundary hit / 1 unverified**. It records the **largest verdict-mislabel reading in this log** (7 of 8
`verification` rows had already merged), the **n=1 contrast row flipping from false positive to FALSE
NEGATIVE in a single cycle**, **TASK G refilling from zero to TEN with every member's mechanism named**,
the **credit band's re-entry at 50% one cycle after R43 refused to re-cut it on a flattering 100%**, and
the **first clean SHIPS-UNWIRED scan in this log — earned by the un-instrumented lane wiring
`mainHealthFromRollup`**. It **mints P68** (*the recon rung is dispatched without the task record it
exists to scope: five of eleven runs say so in their own words*), gives **P64 a shape it never named**
(SECOND-precision run ids, one of them dated past its own merge), scores **P66's bar at TWO direct
members** one cycle after a fully-read zero, and writes **DR-28** (*a verdict class is not a failure
class until you check which of its members merged*).

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
- **Daemon dispatch lanes**: 2 — source: `sweep.dispatchLanes` via `loadPolicy(policyPath(root))` (src/lib/policy.ts, plan/policy.yaml)
- **Daily cost ceiling**: $500 (committed default, no state/ override) — source: `resolveDailyCostCeiling(root, policy)` (src/lib/policy.ts)
- **Recon turn cap**: 20 — source: `RECON_MAX_TURNS` (src/run-task.ts)
- **ci-gate REQUIRED checks**: 21 — ci, lint-plan, depcruise, containment-probe, coverage-ratchet, mutation-ratchet, jscpd-gate, claims, learnings-budget-ratchet, commitlint, api-client-drift, no-hand-rolled-fetch, scan-pr / osv-scan, License Review, leak-grep, assertion-discrimination, task-id-existence, acceptance-author-gate, unwired-gate, comment-load-ratchet, source-size — source: `REQUIRED` (.github/workflows/ci-gate.yml, job `ci-gate`)
<!-- CAPABILITY SNAPSHOT:END -->

★ **CURRENT R45 (RETRO-1788401594504, 2026-09-03): verification is the only mapped failure class, but it is not a task-defect census.** Of 10 runs, 5 ended `blocked_ci`; four — W1-T2622/#3712, W1-T2626/#3727, W1-T2630/#3716 and W1-T2633/#3724 — subsequently merged gate-side. The remaining two `blocked_containment` rows are host-side `containment/outside-cwd-denial` events whose probes never ran, so they are excluded from task defects. The one `incomplete` triage run also merged gate-side (#3762). **P47 owns the credit artifact; P63 owns the two reachable-remedy failures:** W1-T2630 needed `docs/docs-index.json` and W1-T2633 needed `scripts/source-size-baseline.json`, both outside declared scope. No new proposal is minted: the highest prior live id is P68, and these findings are already discriminated by existing golden proposals.

★ **CURRENT CALIBRATION:** the run-lane table is observed, not mount-rebasable: `implement` is 9 runs / 2 ledger merges / $4.051 average / $36.456 total, while `triage` is 1 / 0 / $0.000 / $0.000; both report zero turns. The class-routing cells are likewise unfit for a routing decision (`src` 22% ledger merge rate; `triage` 0%, each with 0% turn coverage). G-17 has no Architect-lane rows in its historical window, so it is evidence about the capability half of G-17 only, never a tier move. Replay and mutation-ratchet have no recorded positive-control run; their absences remain P48, not results. The two proposed learnings are ratified at `user-overall`: validate HTTP status/structure before consuming fetched bodies, and probe per-run environment isolation rather than relying on host state.

★ **WS-1 COMPLETE + L2 LIVE (2026-07-15) — FOLDED TO THREE LINES BY R23; the SHIPPED log carries every
PR and the claims have held for fifteen retro-cycles.** Self-hosting exit criterion MET (`rmd daemon`
drained SBX-T1/T2/T3 unattended → #6/#7/#8, then survived kill-9 + restart with **no duplicate task
run**, W1-T12d, operator-attested; the drill was bounded, so recovery is proven by no-duplicate + clean
idle, not by an active `reconstructOrphan`). §5's Tier-1 security stack runs on remudero itself (§5A's
"the harness eats first" is FACT there), and the daemon drains `remudero` and fires its own retro
(W1-T160/#853) — the operator-kick era is over.

★ **PRIOR CYCLE (RETRO-1788374498685, 2026-09-02): THE VERDICT COLUMN CALLED EIGHT RUNS `blocked_ci` AND
SEVEN OF THEM HAD ALREADY MERGED.**
11 runs declared over a **~6.1-hour** window (marker 2026-09-02T12:29:28.431Z = epoch
`1788352168431`; newest ledger row 2026-09-02T18:36:21.138Z), costing **$62.200** — **$5.655/run,
$20.733 per ledger-credited ship, $6.220 per union ship and $3.110 per hand-verified in-window
`run-W1-*` merge.** The verdict census closes exactly: `merged`×3 + `blocked_ci`×8 = 11, with no
`incomplete`, `no_pr` or `blocked_containment` row at all. The merge set was verified BY HAND over REST
(DR-4, DR-16, DR-20, DR-25): `pulls?state=closed&sort=updated&direction=desc&per_page=100` filtered at
the marker on `merged_at`, **every `run-*` head ref decoded and tested against the marker AND for
quantisation, and every NON-`run-*` merge's changed-file list read over `pulls/<n>/files`.**
**57 merges in-window: 20 on `run-W1-*`, 1 on `run-RETRO-*` (#3639), 0 on `run-APPROVE-*`, 36
hand-named** (16 `plan/*`, 15 `codex/*`, 2 `fix/*`, 2 `dependabot/*`, 1 `claude/*`).

★ **THE FIRST FINDING (NO MINT — DR-28, AND IT ROUTES TO P47): THE FAILURE CENSUS IS 87.5% WRONG, AND
ITS ERROR IS ONE-DIRECTIONAL.** The MAST distribution reports **`verification` × 8, +4 on the prior
cycle** — one row per `blocked_ci` verdict, and nothing else. **Seven of those eight tasks appear in this
cycle's own SHIPPED section as gate-side merges**: W1-T2613/#3651, T2617/#3661, T2618/#3662,
T2620/#3673, T2621/#3680, T2625/#3672, T2629/#3681. The eighth is W1-T2623, whose PR **#3692 merged at
18:46:25Z — ten minutes after the gather's newest ledger row**, so it is not a failure either; it is a
straddler. **The failure distribution therefore has NO confirmed member at all**, and the only
instrument that can say so is a REST read this rung performs by hand. R43 minted P67 on ONE
misattributed `verdict`; the same defect at n=7 does NOT earn a second id — **it is the standing
credit-artifact fold-line's largest single reading, and its owner is P47.** What it DOES earn is a
DECISION RULE, **DR-28: a verdict class is not a failure class until you check which of its members
merged.** The MAST census reads its input from the verdict column alone, so it will restate that
column's errors as a taxonomy for as long as the column is the only input.

★ **THE SECOND FINDING: THE n=1 CONTRAST ROW FLIPPED SIGN IN ONE CYCLE.** R43's `BY TASK CLASS` table
carried a `docs` row at **100% merge rate, $1.959, the cheapest and highest-scoring row in the table**,
and R43 called it a **FALSE POSITIVE** because its only member red-lit `main`. R44's `docs` row is
**1 run, 0 merged, 0% merge rate, $5.415** — and its only member, **W1-T2625, MERGED as #3672**. The
same one-member cell is now a **FALSE NEGATIVE**. **Thirty-three cycles have produced nine contrast
rows; none has reached n=5; and the cell has now been demonstrably wrong in BOTH directions in
consecutive cycles.** This is why the routing question W1-T167 exists to answer cannot be answered from
this table: **at n=1 the row does not measure the class, it measures whether the verdict writer fired.**
A `diagnose` row also appears for the first time in many cycles — **1 run, 0 merged, $5.415** — and it
is the SAME run as the `docs` row, so the two new rows of this cycle's tables are one event wearing two
labels (R24's turn, a third time).

★ **THE THIRD FINDING: TASK G REFILLED FROM ZERO TO TEN, AND FOR THE FIRST TIME EVERY MEMBER HAS A
NAMED MECHANISM.** Ten of the twenty in-window `run-W1-*` merges are credited by neither the ledger nor
the union. They partition completely, with no residue:
**(a) SIX carry a malformed epoch (P64, and it grows a shape P64 never named):** `run-W1-T2703-1788379200000`,
`run-W1-T2717-1788370400000`, `run-W1-T2713-1788369000000` and `run-W1-T2709-1788360600000` are
second-quantised exactly as P64 describes — **and `run-W1-T2712-1788358696` and `run-W1-T2692-1788360907`
carry TEN-DIGIT, SECOND-PRECISION ids**, a different allocator shape altogether. **★ AND ONE OF THEM IS
IMPOSSIBLE:** T2703's epoch `1788379200000` decodes to ~20:00Z while **its PR #3657 merged at 13:33:39Z**
— the run id is dated ~6.4 hours AFTER the merge it is supposed to have produced. P64's falsifier asked
for a real `runId` behind every quantised ref; **a future-dated ref is a stronger refutation than a
missing one.**
**(b) TWO are straddlers, one in each direction:** **#3629/W1-T2610** merged at 12:49:54Z — it is the
OPEN PR R43 named as in-flight residue, landing 20 minutes past this cycle's marker, so **R43's reading
that the residue was in flight rather than lost is CONFIRMED by its landing**; and **#3692/W1-T2623**
merged at 18:46:25Z, ten minutes past the gather's newest row, so this cycle exports one straddler in
turn.
**(c) TWO are DAEMON fix-rung branches** — #3663/`run-W1-T2704-…` and #3684/`run-W1-T2711-…` — run-shaped
head refs pushed by fix rungs whose ledger ids are `DAEMON-*`, so no run census will ever claim them.
**The whole population of TASK G is accounted for by name.** That is a first, and it settles what R42-2
could not: the class did not close, it emptied for one window. **DR-18 and DR-19 exist for exactly this,
and they were right to forbid the deletion.**

★ **THE FOURTH FINDING: THE SYMBOL THIS FILE CALLED DARK FOR SIXTEEN CYCLES WAS WIRED BY THE LANE THIS
FILE CANNOT SEE.** The SHIPS-UNWIRED scan reads **"No NET STATE claim names a symbol this scan finds
unreached"** — clean, for the first time in this log, after sixteen consecutive cycles of a
byte-identical `mainHealthFromRollup` line. The cause is in the merge census: **#3637
(`codex/wire-main-health-observation`) ships `src/lib/main-health-rung.ts`, `src/run-task.ts` and
`test/main-health-wiring.test.ts`**, and `src/lib/main-health-rung.ts:103` calls `mainHealthFromRollup`
directly. Verified in this worktree's own tree, not inferred. **One cycle earlier R43 recorded that same
lane FILING the task for this wiring (#3626/W1-T2683) before this rung could propose it.** File, then
ship, both from a lane with no ledger, both against a line in THIS document. **P66's thesis is now
demonstrated end to end across two cycles** — and the practical consequence lands on this rung: **the
DARK roster below carried a false claim until this sync deleted it.** P55(ii)'s byte-identical-evidence
clock stops at sixteen, **retired by external repair rather than by its own trigger**, which is recorded
rather than scored.

★ **THE FIFTH FINDING (P68, MINTED): HALF THE POPULATION WAS RECONNED WITHOUT ITS OWN TASK RECORD.**
Five of eleven runs say so in their own harvest prose, unprompted: W1-T2613 (*"recon didn't read task
specs, so scope is currently unconfirmed"*), W1-T2619 (*"this recon had no task spec to scope against"*),
W1-T2625 (*"this recon didn't inspect task content, only git/repo state, so scope is still unknown"*),
W1-T2629 (*"this recon wasn't given an explicit task description and this worktree exists to serve
one"*) and W1-T2623 (*"Locate the actual spec/title for W1-T2623 — likely in daemon task DB or
TaskGet/TaskList, not in this repo's tracked files"*). **The other five report the opposite explicitly** —
W1-T2618 (*"this recon confirmed the coupling is real and the target file doesn't exist yet"*), W1-T2617
(*"this recon confirms the target symbols and file locations are exactly where the task record says, so
the implement worker can proceed directly without a second discovery pass"*), W1-T2620, W1-T2621 and
W1-T2628 (*"W1-T2628 is accurately filed, unblocked, and ready to dispatch as-is"*). **The population
splits cleanly in half, and the split is legible only in prose no instrument here parses.** W1-T2623
names the mechanism: some task records live outside this repo's tracked files. **MINTED P68, entering at
rank 3; the highest prior id was P67.**

★ **SPEND — $62.200 OVER 11 RUNS, AND THE RESIDUE HAD ALREADY LANDED BY THE TIME THIS RUNG READ IT.**
The 10 union ships cost **$56.841**; the one run that bought no in-window-at-gather-close merge cost
**$5.359 — 8.6%** — and its PR **#3692 merged at 18:46:25Z**, which this rung's own REST read shows and
the gather cannot. **A third consecutive cycle whose residue is in flight rather than lost, and the
first in which the retro can prove it landed.** The series reads 86% → 64% → 52% → 47.6% → 14.7% →
59.9% → 93.1% → 64.7% → 100% → 7.7% → 15.0% → **8.6%**: still a **NOISE BAND, not a trajectory
(P43(ii))**. Peak run **$11.615** (W1-T2620), **8.6× under the $100 `budget_usd` tripwire**, verifiable
for the whole population a TWELFTH time; **P52's $0.001 storm fails to reproduce a THIRTEENTH** (floor
$2.894).

★ **THE CREDIT BAND RE-ENTERS AT 50%, ONE CYCLE AFTER R43 REFUSED TO RE-CUT IT ON A FLATTERING 100%.**
Union credit reads **10 of 20 in-window `run-W1-*` merges = 50%**; the ledger alone reads **3 of 20 =
15%**. On P64's clean denominator — the fourteen merges whose head refs are well-formed — it reads
**10 of 14 = 71%**. **The RAW 50% is the registered reading, and the choice is stated rather than
implied:** excluding the malformed-epoch class flatters the resolver on a defect that belongs to this
document's own reading, not to the population. The series is 39%, 33%, 53%, 29%, 56%, 50%, 59%, 66.7%,
47.1%, 9.5%, 20.5%, 0%, 50%, 100%, now **50%** — **inside the 20–65% band, one cycle after the only exit
above it in this log.** A band re-cut on the flattering cycle would have been re-cut for nothing; **R43
declined to, and the next reading vindicated the refusal within one window.** DR-25 still applies: 50%
credit over a lane that authored **20 of this window's 57 merges** is a statement about the RESOLVER.

★ **P65 FALLS TO ITS LOWEST READING AND DOES NOT REACH ZERO — SO THE MOUNT FREEZE'S RELEASE CONDITION
SURVIVES ITS FIRST REAL TEST.** Every hand-named merge's changed-file list was READ over
`pulls/<n>/files`, never inferred from the prefix: **FIVE change `src/` or `test/`** — **#3637**
(`main-health-rung.ts`, `run-task.ts`, a test — the wiring above), **#3640** (`worker-containment.ts`,
`worker-provider.ts`, `worker.ts`, `run-task.ts`, `daemon.test.ts`), **#3616**
(`mount-headroom-sweep.mjs` + a test), **#3677** and **#3683** (test-only `fix/*` merges). The other 31
are plan filings, docs and dependabot bumps. The series reads 8 → 12 → 12 → **5**: its first fall, and
still not zero. **R43 moved the freeze onto this class precisely because it had never read zero; the
first cycle to test that claim leaves it standing.**

★ **P66's BAR TAKES TWO DIRECT MEMBERS AFTER A FULLY-READ ZERO — R43-7 HIT.** **#3687
(`codex/file-W1-T2717-window-share-producer`, 17:30:39Z) files the task shard for W1-T2717 while
#3688 (`run-W1-T2717-…`) merges its implementation 45 minutes later at 18:15:38Z**; and **#3682
(`codex/plan-W1-T2711`, 17:06:22Z) precedes #3684 (`run-W1-T2711-…`, 18:03:15Z)** on the same id. Two
lanes, one `W1-T` id, one window, twice. Beside them the codex lane filed four more shards (#3694,
#3695, #3696, #3691) and the plan lane sixteen. **The contention P66 was minted on is no longer visible
only as a PR title; it is visible as a filing and a merge on the same identifier, in the same hour.**

★ **THE ARCHITECT LANE WRITES ITS FIRST ATTRIBUTED ROW EVER, AND P54's MECHANISM CONFIRMS A SECOND
TIME.** G-17 reports **1 row / $8.97 / 0.8%** of a **211-row / $1158.04-notional** corpus.
`inbox_draft` returns **0 → 1**, and that single row carries **`claude-opus-5×1`** — **the first
Architect-lane row in this log that carries a `model` key at all.** `retro.synthesized`,
`triage.synthesized` and `plan.synthesized` read zero for a **FOURTEENTH** consecutive cycle (**P53** —
nothing emits them). **R43-6 MISS** by its own tie-break: `inbox_draft` moved alone again, this time
upward. **P54's rolling-window mechanism is confirmed a second time and now shown to run in both
directions:** the corpus start advanced **2026-08-26T14:54:02.128Z → 2026-08-26T20:32:35.960Z
(+5.64 h)** across a **6.92-day** span while the row count held at **211** and the notional total ROSE
**$1130.90 → $1158.04** — rows aged OUT and IN across one window, which a `HISTORICAL` label cannot
express. `implement` carries `model` on **18 of 202** rows (**P53**, 91.1% absent) and **the attributed
count has now been FROZEN AT 18 FOR A THIRD CONSECUTIVE CYCLE** (15 → 17 → 18 → 18 → 18 → 18);
`review.reviewer` grows to **8 rows, `sonnet×8`**, still the only fully-attributed lane. Every `$` is
NOTIONAL / API-equivalent on a subscription install, never billed spend, and `assertArchitectAboveWorker`
keeps throwing on a same-or-lower-tier Architect regardless — **no mount row moves on this reading.**

★ **THE WEEKLY TURN IDENTITY HOLDS A THIRD TIME, ON A THIRD VALUE — TASK D IS NO LONGER A RETENTION
QUESTION.** The BY MODEL CLASS table reads **161 turns over 99 runs**, and **16.1 × 10 = 161 is this
window's ENTIRE implement turn mass.** The three readings are 224 = 224, 172 = 172, now 161 = 161, on
three different values. **DR-2 forbids banking an identity from one coincidence; three consecutive
exact matches on three different numbers is not one coincidence, and the honest statement is that the
column labelled `this week` renders THIS WINDOW.** That is a rendering defect in the table, and TASK D
owns it. The `haiku` row is **byte-identical to last cycle's — 2 runs / 0 turns / $3.324** — and
`unresolved` climbs a **FOURTH** consecutive cycle (11 → 1 → 2 → 3 → 4 → 5 → **6**).

★ **TURN COVERAGE LANDS EXACTLY ON THE FLOOR R43 SET.** `avg turns` **14 → 16.1**, coverage **21% →
20%** against R43-4's floor of **20%**. The tie-break is stated before the score, not after: **at the
floor is a HIT, below it is a MISS** — so **R43-4 HITS on the boundary, and the floor is NOT re-cut on
the cycle that grazes it**, by the same discipline that holds the credit band. `turns/merge` **17.889**
and `output tokens/merge` **11192.111** carry the gather's own **`⚠ 20% coverage — DO NOT USE`** stamp
and are printed unscored; the `docs` row carries **`0% coverage — DO NOT USE`** outright. **No identity
is banked** (DR-2).

★ **THE LEARNINGS PASS: 79 ENTRIES, `0 added`, A TWENTY-SECOND CYCLE — AND P38's SERIES REACHES FOUR
DISPOSITIONS ON ONE UNCHANGED ENTRY.** **R43-5 MISS**, the twelfth consecutive miss of a row inaction
guarantees. The judge PROMOTES `askuserquestion-auto-resolves-empty-headless` at **0.78** — the same
entry it promoted at **0.72** one cycle ago, on evidence no one touched — and DECLINES at **0.70**,
**0.85** and **0.88**, so **two of three declines again score ABOVE the promotion**. And
`body-fetch-guards-on-http-not-size` now reads its **FOURTH different score with a REVERSED disposition
inside it: promoted 0.78 (R41), promoted 0.87 (R42), declined 0.80 (R43), declined 0.85 (R44).** The
promotion is a PROPOSAL; only the count moves R44-5.

★ **RATIFICATION TELEMETRY IS BYTE-IDENTICAL A THIRD CONSECUTIVE TIME: 44 approved / 0 reframed / 100%.**
Three identical readings across ~19 hours makes "cumulative and unwindowed" the likelier of the two
explanations, but the table still does not say which, so it stays an AMBIGUITY and not a reading. The
`run-APPROVE-*` merge count reads **zero** for a second cycle.

★ **NO GUARD-FIRED BLOCK, SO TASK N's POPULATION IS EMPTY A THIRD CONSECUTIVE TIME** — recorded as an
absence with its mechanism, never as "no containment defects" (**P48**). **Mutation gate `N=0`
(twenty-seventh cycle) and replay *no run recorded* (twenty-second)** are both **P48** and neither is a
zero. **The Discrepancies section fires SEVEN gate-side additions and ZERO rejections for a second
consecutive cycle**, so P57(a), P60's picker, P61, P62's resolver arm and P66's resolver arm are all
UNEXERCISED rather than repaired; **P60's three-consecutive-UNRESOLVABLE clock is UNSCORABLE for a
FOURTH cycle.**

★ **PROCEDURAL-SUCCESS MINING TRACKS THE `merged` WRITER EXACTLY, A THIRD CONSECUTIVE CYCLE.** It
returns **`implement × [clean_single_strike, fully_executed_proof]` over 3 runs** — precisely the 3 the
ledger called `merged`, no more and no fewer. **It is not measuring shapes; it is measuring whether the
verdict got written**, and this cycle that is a sharper indictment than usual: **seven runs that shipped
a merge are invisible to it because the writer never fired.**

★ **THE PLAN-HEALTH SWEEP RETURNS W1-T49 ALONE FOR A TWENTY-FIRST CYCLE** — declared-scope, unfixed,
still the only OPEN task with no `files:` list. **A corrective task is PROPOSED, not filed.**

★ **PRIOR CYCLES — NOT SUMMARISED HERE.** The header's retro ledger folds R1–R43 with every arc, rank
change, mint and DR rule named, and the SHIPPED log's own section headers carry every id, PR and date.

**Inventory (verified 2026-09-02 BY HAND against GitHub over REST, NOT from the gather: 57 merges in
this window — **20 on `run-W1-*`**, of which **10 are credited by the W1-T51 union and 3 by the
ledger**; **1 on `run-RETRO-*`** (#3639); **0 on `run-APPROVE-*`**; and **36 hand-named** — 16 plan
filings, 15 codex filings/wirings, 2 `fix/*`, 2 dependabot and 1 claude, of which **FIVE change `src/`
or `test/`** (P65). **TEN `run-W1-*` merges are uncredited and every one has a named mechanism** — six
malformed epochs (P64), two straddlers, two DAEMON fix-rung branches. On top of R43's 38, R42's 50,
R41's 40, R40's 45, R39's 29, R38's 38, R37's 34, R36's 34, R35's 29, R34's 55, R33's 7, R32's 15,
R31's 12, R30's 18, R29's 27, R28's 28, R27's 31, R26's 38, R25's 33, R24's 40 and R19–R23's
25/31/31/30/30; merged PR numbering on `remudero` is now past #3698, 6 on `remudero-sandbox`.)**
WS-0 and WS-1 SHIPPED.
**R43's CAPABILITY PARAGRAPH IS FOLDED TO ITS DURABLE LINES, NOT RESTATED** — the standing disposition
every cycle since R28 has applied to its predecessor's. From R43: **the mount recommender can be
OVERRULED BY AN OPERATOR PRIOR** and its routing objective is keyed on billing mode and window share
rather than imputed dollars (T2576/#3596, T2577/#3597); **the recycle path refuses to clobber local
work** (T2588/#3598); **the daemon command policy is pinned by evidence regexes** (T2596/#3600); **a CI
shard that produced no summary is marked `NO-SUMMARY SHARD`** (T2597/#3601); **the console inbox can
DECLINE a proposal** (T2604/#3608); and **`checkCapCitations` guards frozen cap figures** (T2612/#3627).
**As of THIS cycle (R44)** — **a recon cannot propose a follow-up naming its own task**
(T2617/#3661); **`worktreeAdd` measures and records canonical-checkout drift** with `worktree.add` /
`worktree.stale_base` / `worktree.base_uncheckable` ledger fields (T2618/#3662, T2621/#3680); **the
sweep releases a PR the gate has stopped blocking rather than reading `behind` as the release
condition** (T2620/#3673); **`rmd reap-branches` splits named-task from credited-task branches**
(T2629/#3681); **`pruneStaleRuns` removes the `.base` record when it reaps a worktree** (T2628/#3697);
**`resolvePlanCriteriaAtHead` reports its divergence cause** (T2623/#3692); **the dispatcher declines a
dispatch-only prompt on word-list evidence** (T2613/#3651); **the follow-up router refuses
self-referential proposals** (T2614/#3659); and **a daemon-policy census records its own DECLINE verdict
rather than paper over a collapsed sibling pattern** (T2619/#3666).
**SIX of those eleven ships name their OWN missing wire in their own follow-up harvest** — T2617
(`pruneSelfReferentialFollowups` is not wired into `run-task.ts`'s live retro call site and has never
run against `state/inbox-proposals.json`), T2621 and T2629 (the new ledger fields reach no status-board
LATCHES/LIVENESS section), T2629 again (`reapBranchesCommand` never populates `namedTaskId`), T2628 (the
`rmd sweep` summary line now undercounts its own label), T2625 (its docs merge needed a
`docs/docs-index.json` regeneration its declared scope forbade — **P63, exercised**). The **golden-task
replay suite (T165/#2232) IS STILL DARK.** The SHIPPED log is the record (rule 13); no PR-by-PR
restatement lives here.
**mounts.yaml (W1-T5) is SHIPPED** — #42, on disk at `.remudero/mounts.yaml`, re-based to a flat-400
tripwire by #90, and routing model + effort by task RISK and CLASS since W1-T167/#606. The calibration
table below is the row that re-bases it — **and the WHOLE `implement` row still publishes `UNMEASURED`
with the mount table FROZEN.**
**★ THE FREEZE'S RELEASE CONDITION SURVIVES ITS FIRST REAL TEST AND IS NOT MOVED.** R32 cut it onto
TASK G; R33 re-cut it onto TASK L; R43 moved it onto **P65's CHANGED-FILES CLASSIFIER** on the argument
that P65's class *had never once read zero*. **This cycle tests that argument at its weakest reading:
P65 falls 12 → 5, its lowest, and does not reach zero.** The condition holds and **R44 does not touch
it** — moving a release condition on the cycle that stresses it is the same error as re-cutting a band
on the cycle that flatters it. The `implement` row stays **UNMEASURED** because its population is still
ONE AUTHORING LANE: this window that lane authored **20 of 57** in-window merges while a lane no
instrument here reads authored **five source merges beside it — one of which wired a symbol this
document had called dark for sixteen cycles.**
**A FREEZE IS NOT A REFUSAL TO PUBLISH:** the gather's raw rows are printed below unaltered, and the
mount keeps operating on the values it already holds — what is forbidden is re-BASING it.
**★ THE CONTRAST ROW SURVIVES A SECOND CYCLE AND FLIPS SIGN.** `BY TASK CLASS` carries TWO rows — `src`
(n=10) and `docs` (n=1) — and the `docs` row publishes **0 merged, 0% merge rate** while its single
member **W1-T2625 merged as #3672**. Last cycle the same cell was a 100% FALSE POSITIVE; this cycle it
is a 0% FALSE NEGATIVE. **Thirty-three cycles, nine contrast rows, none past n=4, and the cell has now
been wrong in both directions in consecutive windows.** A `diagnose` row appears in `BY TASK TYPE` for
the same single run, so the two new rows of this cycle's tables are **one event wearing two labels**.
The model axis stays **UNATTRIBUTED, not under-sampled** — G-17's implement lane carries `model` on
**18 of 202** rows (P53 — 91.1% absent), **frozen at 18 for a THIRD cycle**; `review.reviewer` grows to
**8 rows, all attributed**; and `inbox_draft` writes **the first Architect-lane row in this log that
carries a `model` key** (`claude-opus-5×1`), which is P54's rolling window admitting a row rather than
P53's writer appearing.
**Still PLANNED, not shipped** (the honest remainder): **P33's trailer quarantine list, FIFTY-SIX
`(pr, task)` pairs** (**+0 THIS CYCLE**; and for the first time in this log the Discrepancies section
fires **NO rejection at all** — its only two rows are gate-side ADDITIONS, W1-T2577/#3597 and
W1-T2604/#3608, both on runs the ledger had called `blocked_ci`. **A rejection counter reading zero is
P48's shape, not a fix**: P57(a)'s label, P62's sibling dispatch and P66's foreign branch are all
unexercised this cycle, none of them repaired);
**W2-T2's dry-run has not shipped**;
**the organs shipped DARK by their own admission** —
`learningDuplicateViolation` has no live intake gate (T420/#1610), `mutation.ratchet_verdict` is unwired
(D-10/W1-T393/#1521, lifetime N=0), the read-sensitivity axis has no consumer (T495/#1835),
**`OpenPrView.isDraft` has no real producer and `mergeState: "behind"` may have none either, which would
make T520+T528 unreachable in production**, the golden-corpus lint hook T423 sketches is deferred,
**the golden-task replay suite T165/#2232 has no `HarnessRunner` wired** so the Self-Harness leg reports
*no run recorded* by construction, the memory governor T1038/#2321 has no `DaemonDeps`/`DrainDeps` wire,
`judgeRepairStall` (T1209/#2511) has no production reader so `rmd doctor` prints `repair-stall: OK`
unconditionally, the credit-surface gate (T1214/#2520) still has no CI job step,
`scripts/state-citation-check.mjs` (T1263/#2657) is in neither `ci.yml` nor `ci-gate`'s REQUIRED roster,
`SweepDeps.readCiGateRollup`/`reaggregateCiGate` (T1275/#2672) have no wire in `buildSweepEffects`,
**`review.resolver_divergence` (T2315/#3049) is written and read by nothing but a console line**,
**`provenanceBracket` (T2305/#3040) has no call site that captures a genuine second reading**,
**`realRiskJudge`'s bounded retry and `runTriageWithRetry`
(T2212/#2730) are not wired into `run-task.ts`'s live dispatch**, **`buildSweepEffects`'s real
`dispatchFix` does not return the `dispatchStarted` signal T2231/#2801 consumes, so `spent` is
populated by test fakes only**, **`REVIEW_STATE_LABELS` has no badge for T2235/#2786's
`not-applicable`, so a terminal row renders blank**, **`NETWORK_KEYS`/`FILESYSTEM_KEYS` are missing
`strictAllowlist`/`disabled`** (T2216/#2765, over-strict by one level), and **a detached
`ratify.approve` handoff that outlives its own request is outside T2229/#2779's exit wait — named and
unsettled**; **T2238/#2794's `(numTurns, maxTurns)` pair is written by the probe and reaches NO guard
row in the retro's gather — 0 of 38 rows lifetime — and the guard population is EMPTY AGAIN this cycle,
one cycle after its first non-empty reading in seven, so the row cannot even fail** (**TASK N**);
**`StrikeAttempt.unmetClaims` (T1269/#3241) is populated by no ledger read — `deriveStrikeHistory` in
`run-task.ts` never fills it, so the new earlier-stop row is unit-tested and INERT in production**;
**`ReadinessContext.boardReferents` (T2451/#3255) defaults to "unreadable" because no production caller
performs the batched board read, so proposal retirement ships DARK by the task's own file fence**;
**`buildGather`'s own `shipped`/`mergedSince` rendering still iterates `runs` only, so T2288/#2946
widened the retro's TRIGGER without widening what the retro DISPLAYS**; `opts.boardReview`
(T2304/#2952) has no live board fetch, no daemon scheduling and no `boardReview` policy row; T2317's
negative-arm ratchet is frozen at 0 of 95 surfaces exercised; and **`OpenPrView.workflowRuns` is still
DECLARED WITH NO PRODUCER — `buildOpenPrViews` never populates it, so T2340's `stalledRunReason`
disposition row cannot match in production.
**ONE OPEN task still declares no `files:` scope** (W1-T49, a TWENTIETH cycle);
**86 dispatchable tasks declare no scope at all** (named by W1-T2481's own record and left);
**FOUR `blocked_ci` verdicts this cycle carry no fix-rung text in the gather at all, and at least ONE
of them (W1-T2604) is REST-attributable to a DIFFERENT task's merged regression** (P63 recorded
UNSCORED, never zero, which is TASK H's claim: the per-run verdict row does not exist — and P67 is why
it now matters twice);
**the `worker.state` sensor still covers ONE
of six spawn call sites**; **at least eight shards' `verify:` field contradicts their own `note:` prose
(P49)**; **`plan/tasks.yaml` and `plan/tasks.d/*.yaml` disagree about which tasks EXIST** (harvest,
asked a TWENTIETH cycle, and this cycle W1-T2606's own run asked it again about the very shard it was
dispatched from);
**A VERDICT CLASS IS NOT A FAILURE CLASS — the MAST census reported `verification` × 8 and SEVEN of the
eight had already merged gate-side** (**DR-28**, this cycle's rule; the eighth, W1-T2623, merged ten
minutes past the gather's newest row);
**TEN in-window `run-W1-*` merges are credited by nothing, and for the first time every one has a named
mechanism** — six malformed epochs including one dated ~6.4 h PAST its own merge (**P64**), two
straddlers (#3629/W1-T2610 landing, #3692/W1-T2623 leaving) and two DAEMON fix-rung branches
(**TASK G**, refilled from zero after one empty window);
**FIVE hand-named merges changed `src/` or `test/` and no instrument here can see any of them**
(**P65**, 12 → 5, its lowest and still not zero — every changed-file list read over `pulls/<n>/files`);
**two authoring lanes draw from ONE board and P66's bar now has TWO DIRECT MEMBERS** — #3687 files
W1-T2717's shard 45 minutes before #3688 merges its implementation, and #3682 precedes #3684 on
W1-T2711;
**HALF THIS CYCLE'S RUNS WERE RECONNED WITHOUT THE TASK RECORD THEY EXIST TO SCOPE, IN THEIR OWN WORDS**
(**P68**, this cycle's mint — five of eleven, and the other five say the opposite explicitly);
**THE SAME TASK IS STILL DISPATCHED MORE THAN ONCE** (**P62**, two self-reported members this cycle:
W1-T2704's harvest finds *"an equivalent fix pushed under a different session/commit before this round
started"* and W1-T2711's finds *"two independent fix commits … on the exact same `selectCodexModel`
defect within minutes of each other"*);
**A GATE WHOSE REMEDY THE DECLARED SCOPE FORBIDS IS STILL A DEADLOCK** (**P63**, exercised: W1-T2625's
docs merge needed `docs/docs-index.json` regenerated, its fix rung named the remedy three times and
refused it as *"outside this round's authority"*, and the PR merged gate-side anyway);
**the credit resolver PICKS one candidate PR per task instead of FILTERING every candidate** (P60 — its
kill-trigger clock is UNSCORABLE for a FOURTH cycle, since there were no rejections at all);
**the trailer scan is a SUBSTRING match, so a body that DESCRIBES a trailer mints one** (P61, no member
this cycle); **a body-only trailer on a hand-named branch is accepted by nothing** (P58, no new member);
**`incomplete` still maps to no MAST category** (P42 — unexercised again because the verdict MIX
collapsed to `merged` and `blocked_ci` only, an ABSENCE of the input and never a mapping, a TWENTY-FIRST
cycle); and the
follow-up chain the harvests name but the unwritten no-auto-filing doctrine, mis-cited as a §12
rule number, held back (~150 candidates, still headed
by R19's unresolved P0: `service.ts` drains the request body to bind a HIGH-tier nonce and four of five
HIGH-tier handlers hang re-reading it).
**★ R44's COMPRESSION, NAMED SO THE ACT IS INSTRUMENTED (R35's lesson): the DARK-roster claim
`mainHealthFromRollup (T2204/#2691) has no live gateway` IS DELETED as FALSE — `src/lib/main-health-rung.ts:103`
calls it, shipped by #3637 — and R42's and R43's retro-ledger paragraphs are FOLDED TO ONE, R43's
SHIPPED-log entry is FOLDED TO TWELVE LINES, R43's mining block is FOLDED TO ONE LINE, and R43's
Calibration `Reads` block is FOLDED TO ITS DURABLE CLAUSES.** The DARK-roster deletion is the
load-bearing one, and it is the first in this log performed against a claim this document made about
ITSELF and lost: the line survived sixteen consecutive SHIPS-UNWIRED scans that agreed with it, and it
was falsified by a merge from a lane this document cannot price. **A roster of self-declared dark organs
is only as honest as its newest reading of the tree**, and this rung read the tree.
The binding constraint is: **"the harness cannot tell itself whether what it BUILT is
running"** — R17 sharpened it to *whether what it MEASURED was measured*, R18 to *what it LOOKED AT*,
R19 to *the harness can write down what it failed to see and still not print it*, R20 to *the harness
can lose half its own window and every downstream instrument will still report PASS*, R21 to *the
harness can PRINT the merge it failed to credit, in the same document, and still not credit it*, R22 to
*the harness cannot count the runs it made*, R23 to *the harness cannot say which clock its own window
is cut on*, R24 to *one infrastructure event can enter three instruments under three different names*,
R25 to *the harness can print, inside the very sentence that refuses a merge, the exact branch name that
would have credited it*, R26 to *the harness can merge its own work from a run it never recorded*, R27
to *the constraint is not a law of nature*, R28 to *the constraint is not epistemic, it is a
publication schedule*, R29 to *a shipped WRITER is not a published COLUMN*, R30 to *the harness cannot
count the runs it made, AND IT SAYS SO IN ITS OWN DOCUMENT*, R31 to *the harness sees twice,
differently, and has no rule for which sighting counts*, R32 to *the harness can tell itself that it
BUILT something it did not build*, R33 to *the harness looks straight at a fact it has already written
down, in the same clause, and calls it by the name of a different fact — it has one label where it
needs three*, and
R34 to *a measured class going to zero cannot be told, from inside the measurement, from a population
that walked out of frame*, R35 to *the harness's own act of simplification — retiring an id, folding
prose, deleting what read zero — is UNINSTRUMENTED*, and
R36 to *the harness can ask the right question, find two answers, judge one correctly and stop — a
search that terminates successfully at the wrong candidate reads downstream as a clean negative*, and
R37 to *the harness's own PROSE enters the corpus its instruments read, so the document describing a
defect can commit it*.
**R38 added the twenty-third turn** — *the harness cannot tell that it is doing the same work twice*;
nine of twenty-seven runs were copies, no guard fired, and every per-run instrument counted each copy as
a fresh observation.
**R39 added the twenty-fourth turn** — *the harness can construct a state in which its own rules make
the work impossible to finish, and it will report that state as an ordinary failure*; the defect lives
in the CONJUNCTION of two correct rules, which no per-run, per-task or per-verdict column can see.
**R40 adds the twenty-fifth, and it is the inverse of every turn before it: the harness cannot tell
whether the work it is failing to credit was ever ITS OWN.** Ten of thirty-nine `run-W1-*` merges this
window carry a head ref shaped exactly like a run branch and an epoch no run allocator produces. Every
instrument here read them as runs — TASK G counted them, the credit band divided by them, the cheapest
per-merge price this log has ever published was computed over them — because **every one of those
instruments takes the BRANCH NAME as the evidence that a run existed.** For twenty-four cycles the
constraint has been about the harness failing to see its own work; **this is the first cycle in which it
failed to see work that was never its own, and could not tell the two apart, because the only join it
holds between a merge and a run is a string.** **The constraint is therefore: the harness identifies its
own work by a NAMING CONVENTION rather than by a key — so anything that can spell a branch name enters
its ledger's blind spot, and the harness's own uncredited-work class is exactly where they accumulate.**
**R41 adds the twenty-sixth, and it is the previous turn's mirror: the harness cannot see work that was
never routed through a run at all.** Twenty-two of forty in-window merges — a MAJORITY — carry head refs
no allocator produces, and eight of them change `src/` or `test/`, including a whole second worker
provider. R40's turn was that a branch name can lie about a run existing; **R41's is that the ABSENCE of
a run-shaped branch name is no longer evidence that no work shipped.** Every instrument in this file
answers the question *what did the run lane do*, and this is the first window in which that is a
minority of the question. **The constraint is therefore: the harness measures a LANE and reports it as a
FLEET — so the moment a second authoring path appears, every rate, price and coverage figure here
silently narrows to the lane that still fits the schema, and nothing in the gather says so.**
**R42 adds the twenty-seventh, and it is the first one about CONTENTION rather than sight: the harness
cannot tell that another agent is doing the task it just dispatched.** W1-T2568's run spent its whole
budget on a task whose shard had already been merged by `codex/github-event-wake-recovery`, and the one
rung that noticed — the credit resolver — noticed only to REFUSE the evidence as `stale/foreign`. R40's
turn was that a branch name can lie about a run existing; R41's was that the absence of one is not the
absence of work; **R42's is that the board itself has no owner column.** A task id is a string in a
YAML file that any lane may pick up, and **the harness's only reaction to two lanes converging on one
id is to reject the winner.** The constraint is therefore: **a task board with no claim primitive
cannot distinguish collaboration from collision, and will spend a full run to discover the difference
after the fact.**
**R43 adds the twenty-eighth, and it is the first one about TIME rather than sight or contention: the
harness reads its own work exactly once, at the instant it lands, and never looks again.**
W1-T2608/#3611 was correct when it merged and wrong sixty seconds later, and there is no instrument in
this file whose reading could ever change. The ledger's `merged` verdict is written at merge time; the
union credits at merge time; the calibration table's merge rate, the class table's 100%, the
procedural-success miner's `fully_executed_proof` commendation and the MAST census's `verification`
tally are all snapshots of one instant, and **the trunk that instant left behind is read by nobody.**
R40's turn was that a branch name can lie about a run existing; R41's that the absence of one is not the
absence of work; R42's that the board has no owner column; **R43's is that the LEDGER HAS NO SECOND
READING.** The constraint is therefore: **a harness that scores work at merge time cannot distinguish a
ship from a regression, and will publish its own worst merge as the cheapest and most successful row in
its table.** Its corollary is the one that stings: the repair was paid for by a lane with no ledger, so
**the cost of the defect was charged to the only population this document cannot price.**
KICK ORDER (mirrored as a comment atop plan/tasks.yaml).
**★ EFFECT PRE-REGISTRATIONS (P43(i) — stored here until it is stored as data; scored by R45).**
**Every row is a BAND or an INVARIANT, never last cycle's point (rule 10); no row is sized on the latest
reading when the series is volatile (rule 11); every row is built from a column R44's gather ALREADY
PRINTS or from a REST read whose command is written down (rule 13); every comparative row states its
TIE-BREAK; at least one row's HIT requires something to have MOVED (rule 14); rules 15 and 17 (quote the
proposal's bar verbatim, and name the classes whose own deliverable already satisfies it) apply to every
scoring row; rule 18, rule 20's corollary, DR-21 through DR-27 all stand — and NEW, DR-28: a verdict
class is not a FAILURE class until you check which of its members merged.**
**R44 registers NINE rows, one more than R43, because a mint's bar must be registered verbatim
(rule 15) and no standing row earned retirement — R43-8 was UNRESOLVABLE, and an unresolvable row is
re-registered, never dropped.**

| # | metric | prediction | condition |
|---|---|---|---|
| R44-1 | **★ P65's BAR, RE-REGISTERED VERBATIM (rule 27)** — *an in-window merge that changes `src/**` or `test/**` on a head ref that is neither `run-*`-shaped nor a plan-filing-only branch* (**this cycle: 5 of 57 — #3637, #3640, #3616, #3677, #3683**) | **the count is STATED — any value, including zero — AND each member's CHANGED-FILE LIST was read, not inferred from its branch prefix** | **SCORABLE OUT-OF-BAND** (rule 4): `pulls?state=closed&…&per_page=100`, filter `merged_at` > marker, then `gh api pulls/<n>/files` on every non-`run-*` merge. **TIE-BREAK:** a stated zero is a HIT only if the file lists were actually read; a zero inferred from prefixes alone is UNRESOLVABLE, because the prefix is a CONVENTION and the file list is the DEFINITION. **RULE-17 EXCLUSION, NAMED:** merges touching only `plan/tasks.d/*.yaml`, `plan/plan-index.json` or MASTER-PLAN.md are the plan lane's own deliverable and can never be members. **NOTE (rule 11):** 8 → 12 → 12 → 5 is NOT a trend and this row is not sized on it. **★ THIS ROW STILL CARRIES THE MOUNT FREEZE'S RELEASE CONDITION, and R44 did NOT move it on the cycle that stressed it.** |
| R44-2 | **THE SEAM, AND NOW ITS ACCOUNTING** — four counts: uncredited in-window `run-W1-*` merges; of those, how many decode to a run start BEFORE the marker; how many in-window RUNS end the window holding an OPEN PR; **and how many of the uncredited have a NAMED mechanism** (**this cycle: 10, 1 (#3629/T2610), 1 (#3692/T2623), and 10 of 10 named**) | **all FOUR counts stated, and the fourth must equal the first** | **SCORABLE OUT-OF-BAND** (rule 4), off the same REST sweep R44-1 requires plus `pulls?state=open`. **TIE-BREAK:** all arms reading zero is UNRESOLVABLE, never a HIT — an empty seam and an unlooked-at seam print the same. **★ PRE-COMMITTED CONSEQUENCE:** if R45 leaves even ONE uncredited merge without a named mechanism, this cycle's complete partition was a coincidence and TASK G is RE-SCOPED to the mechanism classes it actually contains rather than reported as one seam. |
| R44-3 | **★ THE NUMERATOR'S OWN WRITER — DOES THE LEDGER KEEP SAYING `merged`?** The `merged` column of R45's `BY TASK TYPE` table (**this cycle: 3 of 11, down from 12 of 16**) | **`merged` > 0, OR the gather NAMES the write path that failed to record it** | **SCORABLE FROM THE GATHER's own first table.** **TIE-BREAK:** a window with no merged task PR at all is UNRESOLVABLE — the row is about the WRITER, not about productivity. **★ PRE-COMMITTED CONSEQUENCE, CARRIED OVER UNCHANGED FROM R41-3, R42-3 AND R43-3 (DR-26), NOW ON ITS FOURTH RE-REGISTRATION:** if R45 reads `merged` = 0, the credit band stops being published as a rate and is replaced by the gate-side/ledger SPLIT. **The temptation to drop it is now stronger, not weaker: the writer fell 12 → 3 without reaching zero, which is exactly the shape a clause conditioned on zero cannot catch — and DR-26 forbids retiring it on that observation rather than on a reading.** |
| R44-4 | **★ RULE 14's ROW — TURN COVERAGE HOLDS OR CLIMBS.** Does `avg turns` in R45's `BY TASK TYPE` table read > 0 **and** does the gather's own coverage stamp read ≥ 20%? (**this cycle: 16.1 turns at exactly 20%**) | **> 0 turns AND coverage ≥ 20%** | **SCORABLE FROM THE GATHER's own two tables.** **THE FLOOR IS NOT MOVED:** R43-4 lowered it to 20% and this cycle landed exactly on it; re-cutting a floor on the cycle that grazes it is the same error as re-cutting a band on the cycle that flatters it. **TIE-BREAK, STATED BEFORE THE SCORE:** at the floor is a **HIT**; below 20% is a **MISS, not UNRESOLVABLE**. **FALSIFIER:** coverage jumps ≥ 90% → the column was never partially dark. |
| R44-5 | **★ THE LEARNINGS CORPUS WRITES SOMETHING** (re-registered UNCHANGED after TWELVE consecutive misses, R32-5 through R43-5). `LEARNINGS entries` in R45's gather (**this cycle: 79, `0 added`, a TWENTY-SECOND cycle**) | **a count > 79, from any writer** | **SCORABLE FROM THE GATHER's own header line.** **TIE-BREAK:** none needed; the row is written so inaction guarantees a MISS. **NOTE (rule 13):** a promotion PROPOSAL is not a write — only the count moves this row. |
| R44-6 | **★ THE ARCHITECT LANE — DOES ANY `step` KEY OTHER THAN `inbox_draft` WRITE A ROW?** Rows under `retro.synthesized`, `triage.synthesized` or `plan.synthesized` in R45's G-17 table (**this cycle: 0, 0, 0 — while `inbox_draft` alone moved 0 → 1**) | **≥ 1 row under ANY of the three** | **SCORABLE FROM THE GATHER's own G-17 table.** **★ THE ROW IS NARROWED, AND THE REASON IS STATED:** `inbox_draft` has now moved alone in BOTH directions across two cycles (21 → 0 → 1), which is P54's rolling window and not P53's missing writer; keeping it in the numerator lets a windowing artefact score a writer row. **TIE-BREAK:** all three appearing at once is a HIT **and** a falsifier for P53 — the keys were never missing and the corpus WINDOW is the whole defect. |
| R44-7 | **★ P66's BAR, QUOTED FROM P66's OWN ENTRY (rule 27)** — *an in-window merge on a NON-`run-*` head ref that names a `W1-T####` id — in its branch name, in a `plan/tasks.d/` file it changes, or in its trailer — for which the run lane ALSO merged a run in the same window* (**this cycle: 2 — #3687 names W1-T2717 in its branch and #3688 merges that run 45 minutes later; #3682 names W1-T2711 and #3684 merges that run 57 minutes later**) | **the count is STATED and each member's ID SOURCE is named (branch / changed shard / trailer)** | **SCORABLE OUT-OF-BAND** (rule 4). **TIE-BREAK:** a stated zero is a HIT only if both the changed-file lists AND the bodies of the non-`run-*` merges were read; a zero from branch names alone is UNRESOLVABLE. **RULE-17 EXCLUSION, NAMED:** a `plan/*` filing branch naming an id NO run lane touched in the window is the plan lane's own deliverable and can never be a member. **★ SECOND ARM, STILL RECORDED AND NOT SCORED:** count non-`run-*` merges whose title or body names another in-flight PR by number. |
| R44-8 | **★ P67's BAR, RE-REGISTERED AFTER AN UNRESOLVABLE (rule 27)** — *an in-window merge, from ANY lane, after which one or more REQUIRED checks were red on `main` itself until a LATER merge repaired them* (**this cycle: UNREAD. Two `fix/*` merges landed — #3677, #3683 — which is P67's founding shape, but `main`'s post-merge check state was not read, so no count is claimed**) | **the count is STATED and each member names its REPAIRING merge and its RED INTERVAL** | **SCORABLE OUT-OF-BAND** (rule 4): read `main`'s check state around each in-window merge, or read the repairing PR's own body where it states the measurement. **TIE-BREAK:** a stated zero is a HIT only if `main`'s post-merge check state was actually READ; a zero from "no repair PR was noticed" is UNRESOLVABLE. **★ THE ROW IS RE-REGISTERED RATHER THAN DROPPED, AND THE REASON IS STATED:** R43-8's UNRESOLVABLE was caused by this rung not performing the read, not by the world; a row that goes unresolvable through the author's own omission is the last row that may be retired. |
| R44-9 | **★ P68's BAR, REGISTERED VERBATIM AT MINT (rule 15)** — *a run whose recon reports, in its own follow-up harvest, that it had no task record to scope against; or, once the marker ships, a run whose ledger row carries `dispatch.task_record: absent`* (**this cycle: 5 of 11 — W1-T2613, T2619, T2623, T2625, T2629; and 5 of 11 report the opposite explicitly — T2617, T2618, T2620, T2621, T2628**) | **the count is STATED and each member is quoted, not paraphrased** | **SCORABLE FROM THE GATHER's own follow-up-harvest section.** **TIE-BREAK:** harvest prose is VOLUNTARY, so any count from prose alone is a **FLOOR on the class and never its size** — no rank and no scope may be sized on it (DR-11). **A zero from prose alone is UNRESOLVABLE, not a HIT.** **CONSEQUENCE:** a zero WITH the `dispatch.task_record` marker present folds P68 into P46; a zero WITHOUT it is P48's shape and is recorded. |
**R43's pre-registrations, SCORED:** four hits (one at the boundary), two misses and one unresolvable.
**R43-1 HIT:** P65 fell 12 → 5 but did not reach zero, so the mount-freeze condition remained; its
canonical bar and R44 evidence remain above.
**★★ R43-2 HIT — THE SEAM READS TEN, ONE BACKWARD STRADDLER, ONE FORWARD, AND A COMPLETE PARTITION.**
Uncredited in-window `run-W1-*` merges: **10**. Decoding to a run start before the marker: **1**
(#3629/W1-T2610 — the very PR R43 recorded as open in-flight residue). In-window runs ending with an
open PR: **1** (#3692/W1-T2623, which this rung's REST read then shows merging at 18:46:25Z, ten minutes
past the gather's newest row). **The pre-committed consequence — retire the seam class by deletion if
all arms read zero — does NOT fire.** And the class came back from zero in a single window, which is the
strongest vindication DR-18 and DR-19 have had: **an emptied class is not a closed one.**
**★★ R43-3 HIT — THE WRITER WROTE THREE.** `merged` reads 3 of 11 in the gather's own first table, a
third consecutive non-zero. **The pre-committed consequence does NOT fire — and is re-registered
UNCHANGED as R44-3, its FOURTH registration.** DR-26 is written for exactly this, and the temptation is
now sharper than it was at twelve: **the writer degraded by 75% without reaching the zero the clause is
conditioned on**, and noticing that is a reason to widen the clause next cycle, never to drop it now.
**★★ R43-4 HIT, ON THE DECLARED BOUNDARY — COVERAGE READS EXACTLY 20%.** `avg turns` reads 16.1 > 0 and
the gather's own stamp reads `⚠ 20% coverage`. R43-4's tie-break named a drop BELOW 20% a MISS; 20% is
not below 20%, so this is a HIT, and **the floor is NOT re-cut on the cycle that grazes it.** The two
facts beside it are the ones that matter: the `docs` class row publishes per-merge columns stamped
`0% coverage — DO NOT USE`, and the weekly table's **161 turns is arithmetically this window's
16.1 × 10 = 161** — the THIRD consecutive cycle, on a THIRD distinct value.
**★ R43-5 MISS — 79 entries, `0 added`, a TWENTY-SECOND cycle**, and the twelfth consecutive miss of
this row. Inaction guarantees a miss and inaction delivered — while the judge paid a seventeenth
judgement and gave `body-fetch-guards-on-http-not-size` its **fourth distinct score on unchanged
evidence**, with a reversal inside the series.
**★ R43-6 MISS — `inbox_draft` MOVED ALONE AGAIN, THIS TIME UPWARD.** It reads 0 → **1**, and the row it
wrote carries `claude-opus-5×1`, the first `model`-attributed Architect row in this log; the other three
`step` keys hold at zero for a FOURTEENTH cycle. The tie-break named `inbox_draft` moving alone in
EITHER direction a miss. **The falsifier (all three appearing at once) did not fire, so P53 keeps the
three silent keys — and P54 keeps `inbox_draft`, now confirmed in BOTH directions:** the corpus start
advanced 5.64 h while the row count HELD at 211 and the notional total ROSE $1130.90 → $1158.04, so rows
aged out AND in inside one window.
**★★ R43-7 HIT — P66's BAR TAKES TWO DIRECT MEMBERS AFTER A FULLY-READ ZERO.** #3687
(`codex/file-W1-T2717-window-share-producer`, merged 17:30:39Z) names W1-T2717 in its branch and
**#3688 (`run-W1-T2717-…`) merges that run's PR 45 minutes later**; #3682 (`codex/plan-W1-T2711`,
17:06:22Z) names W1-T2711 and **#3684 merges that run 57 minutes later.** Every non-`run-*` merge's
changed-file list was read, so the tie-break's precondition is met. **The class did not merely reappear
— it graduated from a PR TITLE to a filing-and-merge pair on the same identifier**, which is the shape
P66 was minted to name.
**★ R43-8 UNRESOLVABLE, BY THIS RUNG'S OWN OMISSION.** P67's bar asks for `main`'s REQUIRED check state
after each in-window merge. Two `fix/*` merges landed in this window — #3677
(`fix/wake-spin-guard-falsifier`) and #3683 (`fix/the-size-ratchet-test-must-not-write-the-real-baseline`)
— which is exactly P67's founding shape, and this rung **did not read the trunk's check state**, so it
can neither claim a member nor claim a zero. **An unread check is not a green one** (P48). The row is
re-registered as R44-8 with the omission named, because a row that goes unresolvable through the
author's own inaction is the last row that may be retired.
Running calibration: **n=143 · hit 71 · miss 50 · unresolvable 22.**
**★ THE DR RULES, FOLDED TO THEIR STATEMENTS BY R40 — every argument was made once, in the cycle that
minted it, and git holds it. Only the current reading travels.**
**(1–3, R16–R18)** *a pre-registration conditioned on undispatched work is a request, not a prediction*
(18/18 such rows UNRESOLVABLE, eighteen cycles, no exceptions) · *name the COVERAGE precondition of your
metric* (paid this cycle by the 14% stamp) · *name the INSTRUMENT that will emit the number.*
**(4)** *a retro that reads only its own gather cannot find a hole in its own gather* — eighteenth
cycle, and this cycle it found ten merges the gather cannot see at all. **(5)** *when the instrument
prints a fact in one section and omits it from another, the defect is the JOIN* — this cycle the join is
between a head ref and a runId, and it does not exist. **(6)** *verify the DENOMINATOR out-of-band* —
decisive again at four values: 28% on 29 declared runs, 20.5% on 39 hand-verified merges, 27.6% on the
29 that were actually runs, 38% on the union's 21. **(7)** *sweep the straddlers* — n = 3, 7, 4, 1, 1,
2, 3, 1, 4, 0, 3, 3, 2, 0, **6 — its largest ever.** **(8)** *count the event once and the labels
never.* **(9)** *a correction written inside the section the scanner reads is not a correction — delete
the id, do not annotate it.* **(10)** *register the BAND or the INVARIANT, never last cycle's point* —
15-of-17 lifetime. **(11)** *a scope sized by a volatile measurement is sized on the maximum ever
observed* — vindicated a third time: TASK L, held through a zero window, now reads 6. **(12)** *a
pre-registration scores iff its evidence is already printed.* **(13)** *a shipped FIELD is not a printed
COLUMN.* **(14)** *register at least one row whose HIT requires something to have MOVED* — R32-5 through
R39-5 MISS, eight cycles, and the repeat IS the reading. **(15)** *a row scoring a proposal's bar must
QUOTE that proposal's definition verbatim* — paid a seventh time. **(16)** *PROVE THE ARTIFACT, NOT THE
ATTRIBUTION.* **(17)** *a verbatim bar is not yet a correct bar — also NAME the task classes whose own
deliverable already satisfies it.* **(18)** *a class that empties has not been solved until you check
where its members went.* **(19)** *before retiring a class on its zero, check whether a class still held
would claim the same members* — NECESSARY, never sufficient.
**(28, R44's)** *a verdict class is not a FAILURE class until you check which of its members merged* —
paid at mint: 7 of 8 `verification` rows had shipped.
**★ Rules 20–23, FOLDED TO THEIR STATEMENTS BY R40 — each was argued at length once, in the cycle that
minted it, and git holds that argument:**
**(20, R36's)** *CLASS IDENTITY IS REFUTED BY ONE DISJOINT MEMBER AND NEVER CONFIRMED BY AN OVERLAP —
register the test on the member the other class cannot claim.* A full overlap is never evidence of
identity; it is only an absence of counter-evidence. Its corollary forbids banking any identity —
arithmetic or class-membership — whose two sides both read zero.
**(21, R37's)** *AN EXCLUSION CLAUSE IS A SCORING CONVENIENCE, NEVER A FINDING — before excluding a lane
from a row, state what that lane WRITES into the population the row reads.* An exclusion answers *may
this lane be JUDGED by this bar?*, never *does this lane CONTRIBUTE to the population the bar is
computed over?* Its corollary: a row about a producer must INCLUDE the producer, and must declare the
author-confound out loud when the author IS the producer.
**(22, R38's)** *COUNT THE RUNS PER TASK BEFORE AVERAGING OVER RUNS — a duplicate is a fresh denominator
to every per-run instrument and a numerator to none.* Paid again this cycle at three tasks / eight runs.
**(23, R39's)** *A GATE'S REMEDY IS PART OF THE GATE — count a block as a defect only after checking
whether its remedy was reachable.* A refusal is only a gate when the reader can ACT on it, and
followability (#3377) is not reachability. Scored this cycle at six members, two of them non-ratchet.

**(24, R40's — FOLDED TO ITS STATEMENT BY R43; the argument was made once, in the cycle that minted it,
and git holds it)** *BEFORE COUNTING A MERGE AS UNCREDITED, PROVE THERE IS A RUN TO CREDIT — A BRANCH
NAME IS A STRING, NOT A KEY.* An uncredited merge and an unrun merge are different objects with
different remedies, and until they are separated every fix aimed at the first is measured on a
population containing the second. Its corollary travels with DR-25: any row counting uncredited work
must state how many of its members have a run at all. **This cycle the class it governs is EMPTY** —
zero uncredited `run-W1-*` merges, zero quantised head refs — which is P48's shape, not a repair.

**★ Rule 28 (R44's): A VERDICT CLASS IS NOT A FAILURE CLASS — CHECK WHICH OF ITS MEMBERS MERGED BEFORE
YOU PUBLISH IT AS A TAXONOMY.** Rule 27 established that a merge rate measures the gate at one instant.
**This cycle establishes the complement: a FAILURE rate measures the WRITER, and the writer can be wrong
in the other direction.** The MAST census published `verification` × 8 — one row per `blocked_ci`
verdict — into a window where **seven of those eight tasks had already merged gate-side and the eighth
merged ten minutes past the gather's newest row.** Nothing in the census is a measurement of work; it is
a re-rendering of the verdict column with a taxonomy laid over it, and it inherits every one of that
column's errors while looking like an independent instrument. The practical test is cheap and it is the
same join the credit resolver already performs: **before publishing any partition of failures, resolve
each member against the merge set and print the count that survives.** Its corollary is the one that
generalises: **an instrument whose only input is another instrument's output must publish its input's
error rate beside its own result, or it is laundering.** This applies as written to the procedural-
success miner, which reads the same column and this cycle commended exactly the three runs the writer
happened to record while missing seven that shipped.

**★ Rule 27 (R43's): A MERGE RATE MEASURES THE GATE AT ONE INSTANT, NEVER THE WORK — RE-READ THE TRUNK
AFTER THE MERGE, OR THE CHEAPEST ROW IN YOUR TABLE WILL BE THE ONE THAT BROKE IT.** Every credit
instrument in this file fires at merge time and never again: the ledger's `merged` verdict, the union's
credit, the calibration row's merge rate, the class table's percentage, the procedural-success miner's
`fully_executed_proof` commendation. **A merge is therefore scored on the state of the world one
instant before its own consequences exist.** W1-T2608/#3611 was correct on the facts, merged clean,
took the cheapest cost and the only 100% class row in the table — and left `main` red for 62 minutes,
blocking two other PRs on a defect neither of them authored, until a lane with no ledger paid for the
repair. The rule's practical test is cheap and stated in R43-8: **for every merge in the window, read
`main`'s REQUIRED checks after it, and name the merge that repaired any red it caused.** Its corollary
is where the cost hides: **the repair is usually filed by whoever is blocked, not by whoever broke it,
so the accounting lands on the wrong lane even when both lanes are instrumented** — and here the
repairing lane is instrumented by nothing at all.

**★ Rule 26 (R42's): A PRE-COMMITTED CONSEQUENCE SURVIVES ITS OWN HIT — RE-REGISTER THE CLAUSE, NEVER
RETIRE IT ON THE READING THAT SPARED YOU.** R41-3 pre-committed that a second `merged`=0 cycle would
replace the credit band with a gate-side/ledger split. The ledger wrote `merged` six times, the clause
did not fire, and the tempting move — the one this rung is written to forbid — is to treat a HIT as
evidence the clause is no longer needed and quietly drop it. **A pre-registration that survives only
while it is untriggered is decoration.** The rule's corollary is symmetric with R40's and R39's, which
both concerned consequences that DID fire: **a clause fires against the author's convenience, and it
persists against the author's relief.** Its practical test: after every scored cycle, name each
pre-committed consequence and say whether it fired, did not fire, or was re-registered — never let one
disappear by not being mentioned.

**★ Rule 25 (R41's): A PRICE IS ONLY AS WIDE AS THE LANE ITS DENOMINATOR CAN SEE — NAME THE LANE
BESIDE EVERY PER-MERGE FIGURE.** Rule 24 established that a branch name is not a key. **This cycle
establishes the complement: the ABSENCE of a run-shaped branch name is not the absence of work.**
Twenty-two of forty in-window merges carry head refs no allocator produces, and EIGHT of them change
`src/` or `test/` — one of them adding a second worker provider to this fleet — so `$3.710/run`,
`$1.964 per merge` and a `0%` merge rate are statements about the `run-*` lane wearing the grammar of
statements about the fleet. **A rate whose denominator is drawn from ONE authoring path must say so in
the sentence that quotes it**, and a retro that cannot enumerate the paths may not publish a fleet
number at all. The cheap version of the remedy is already written down: classify merges by CHANGED
FILES, never by prefix.
## SHIPPED log

Shipped arcs, keyed by Remudero-Task (Standing rule 13: the proof is a MERGED PR, not prose).
Newest first. Cost/turns from the run ledger.

### RETRO-1788401594504 (2026-09-03) — merge-credit reconciliation and plan-health follow-through

- **W1-T2624** — worktree-base recon landed as [PR #3718](https://github.com/craigoley/remudero/pull/3718) · $5.071 · 0 turns.
- **W1-T2634** — plan-health whole-corpus linting landed as [PR #3746](https://github.com/craigoley/remudero/pull/3746) · $6.312 · 0 turns.

### RETRO-1788374498685 (2026-09-02) — eight `blocked_ci` verdicts, seven of them already merged: the dispatch-only decline, the self-referential follow-up refusal, the canonical-checkout drift measure, the DECLINE-verdict census, the gate-release condition, the worktree ledger fields, the reap-branches split, the base-record reap & the divergence cause: W1-T2613–T2629 (3 credited / 10 by union / 20 in-window `run-W1-*` merged)

★ 11 runs DECLARED in scope over a **~6.1-hour** window (marker 2026-09-02T12:29:28.431Z = epoch
`1788352168431`; newest ledger row 2026-09-02T18:36:21.138Z). Costs total **$62.200** — **$5.655/run,
$20.733 per ledger-credited ship, $6.220 per union ship and $3.110 per hand-verified in-window
`run-W1-*` merge (DR-25: all four divide by ONE lane).** The verdict census closes exactly:
3 `merged` + 8 `blocked_ci` = 11, with no `incomplete`, `no_pr` or `blocked_containment` row.
**★ THE WHOLE MERGE SET WAS VERIFIED BY HAND OVER REST (DR-4, DR-16, DR-20, DR-25):**
`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`
filtered at the marker on `merged_at`, **every `run-*` epoch decoded and quantisation-tested, and every
NON-`run-*` merge's changed-file list read over `pulls/<n>/files`.**
**57 merges in-window: 20 on `run-W1-*`, 1 on `run-RETRO-*` (#3639), 0 on `run-APPROVE-*`, 36
hand-named** (16 `plan/*`, 15 `codex/*`, 2 `fix/*`, 2 `dependabot/*`, 1 `claude/*`; FIVE of the 36
change `src/` or `test/`).

**LEDGER-CREDITED — THREE:**
- **W1-T2614** — the follow-up router refuses a self-referential proposal (a recon cannot propose its
  own task); the shared proposal-id predicate stays split across four private regex copies, by its own
  harvest → https://github.com/craigoley/remudero/pull/3659 · $5.234 · 0 turns
- **W1-T2619** — the daemon-policy census records its own `DECLINE` verdict rather than paper over a
  collapsed sibling pattern; the successor precision safeguard is deliberately UNFILED
  → https://github.com/craigoley/remudero/pull/3666 · $9.534 · 0 turns
- **W1-T2628** — `pruneStaleRuns` removes the `.base` record when it reaps a worktree; the `rmd sweep`
  summary line now undercounts its own label, named and left out of scope
  → https://github.com/craigoley/remudero/pull/3697 · $4.883 · 86 turns

**UNION-ONLY (gate-side additions on runs the ledger called `blocked_ci` — W1-T51's GitHub arm; SEVEN
this cycle, and every one of them is also a `verification` row in the MAST census, which is DR-28's
founding evidence):**
- **W1-T2613** — the dispatcher declines a dispatch-only prompt on word-list evidence; the
  `NAMES_REAL_WORK_MARKERS`/`DISPATCH_ONLY_MARKERS` lists are a narrow heuristic by its own admission
  → https://github.com/craigoley/remudero/pull/3651 · $2.894 · 0 turns
- **W1-T2617** — `routeFollowupsToRegistry` gains a self-referential refusal arm;
  `pruneSelfReferentialFollowups` is wired into NO live retro call site and has never run against
  `state/inbox-proposals.json`, so the measured 21-of-23 drift is unhealed
  → https://github.com/craigoley/remudero/pull/3661 · $3.139 · 0 turns
- **W1-T2618** — `worktreeAdd` measures canonical-checkout drift from the fetch it already performs
  → https://github.com/craigoley/remudero/pull/3662 · $3.123 · 0 turns
- **W1-T2620** — the sweep releases a PR the gate has stopped blocking, instead of reading
  `mergeState === "behind"` as the release condition
  → https://github.com/craigoley/remudero/pull/3673 · $11.615 · 0 turns
- **W1-T2621** — `worktree.add` / `worktree.stale_base` / `worktree.base_uncheckable` ledger fields;
  no status-board LATCHES/LIVENESS section reads them (W1-T279/W1-T280, out of scope)
  → https://github.com/craigoley/remudero/pull/3680 · $7.406 · 0 turns
- **W1-T2625** — the worktree-base provisioning audit. **★ P63's exercised case: its `ci` check needed
  `docs/docs-index.json` regenerated, a path outside its declared scope; the fix rung named the remedy
  three times and refused it as "outside this round's authority", and the PR merged gate-side anyway**
  → https://github.com/craigoley/remudero/pull/3672 · $5.415 · 0 turns
- **W1-T2629** — `rmd reap-branches` splits named-task from credited-task branches in `status.ts`;
  `reapBranchesCommand` never populates `namedTaskId`, so the split is INERT in the CLI
  → https://github.com/craigoley/remudero/pull/3681 · $3.598 · 0 turns

**CREDITED BY NOTHING — TEN, EVERY ONE WITH A NAMED MECHANISM (TASK G, refilled from zero):** six
malformed epochs (#3657/T2703 — **dated ~6.4 h AFTER its own merge** — #3688/T2717, #3685/T2713,
#3675/T2709 second-quantised; **#3671/T2712 and #3676/T2692 with TEN-DIGIT SECOND-PRECISION ids, a shape
P64 never named**), two straddlers (**#3629/W1-T2610**, the open PR R43 recorded as in-flight residue,
landing 20 minutes past this marker; **#3692/W1-T2623**, merging ten minutes past the gather's newest
row) and two DAEMON fix-rung branches (#3663/W1-T2704, #3684/W1-T2711).
**NOTHING WAS REJECTED FOR A SECOND CONSECUTIVE CYCLE, AND THAT IS NOT A REPAIR** — the Discrepancies
section's only rows are the seven gate-side additions above, so P57(a), P60's picker, P61, P62's
resolver arm and P66's resolver arm are UNEXERCISED rather than fixed (**P48**).

### RETRO-1788350665543 (2026-09-02) — the resolver credited the whole run lane and the cheapest ship red-lit `main`: the operator routing prior, the routing objective, the overwrite-safe recycle, the daemon-policy census, the no-summary shard, the recycle wait, the headroom retirement, the inbox decline, the fix-prompt scope, the operator-guide correction & the cap-citation guard: W1-T2576–T2612 (12 credited / 14 by union / 14 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R44

★ 16 runs / **$78.043** over a ~6.8-hour window (marker 2026-09-02T05:11:26.967Z); `merged`×12 +
`blocked_ci`×4 = 16. **38 merges in-window, hand-verified over REST: 14 `run-W1-*` (ALL union-credited,
TWELVE by the ledger), 1 `run-RETRO-*` (#3591), 23 hand-named of which TWELVE change `src/` or `test/`.**
LEDGER-CREDITED: **W1-T2576**/#3596 (operator prior dominates the learned mount estimate),
**T2587**/#3593, **T2588**/#3598 (recycle refuses to clobber local work), **T2596**/#3600,
**T2597**/#3601, **T2598**/#3603, **T2603**/#3605, **T2606**/#3607, **T2607**/#3612,
**T2608**/#3611 (**P67's founding case — it red-lit `main` for 62 minutes until #3622 repaired it**),
**T2611**/#3614, **T2612**/#3627. UNION-ONLY gate-side: **T2577**/#3597 (routing objective on billing
mode and window share), **T2604**/#3608 (console inbox DECLINE — its `blocked_ci` verdict is
REST-attributable to #3611's trunk red, not to its own diff).
**NOTHING WAS REJECTED and ZERO `run-W1-*` merges were uncredited**, so TASK G, TASK L and P64's class
read zero at once; the two runs that shipped nothing held OPEN PRs across the marker (#3619, #3629) —
**and R44's REST read shows #3629 landing 20 minutes past the next marker, confirming that reading.**
### RETRO-1788324628827 (2026-09-02) — the `merged` writer came back and the credit band re-entered: the served-model ledger row, the capability ladder, the matched-cell mount comparison, the mount-routing rung, the incident-timeline panel, the empty calibration bands, the knowledge bundle & the forwarded-TERM exit: W1-T2567–T2586 (6 credited / 9 by union / 19 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R43

★ 11 runs / **$57.416** ($5.220/run, $9.569 per ledger-credited ship, $6.379 per union ship, $3.022 per
hand-verified `run-W1-*` merge) over a ~7.9-hour window; census `merged`×6 + `blocked_ci`×3 +
`incomplete`×1 + `no_pr`×1 = 11 — **the writer's return after the only zero in this log.**
**50 merges in-window, hand-verified over REST: 19 `run-W1-*`, 1 `run-RETRO-*` (#3536), 1
`run-APPROVE-*` (#3566), 29 hand-named.** Ledger credits: **W1-T2572**/#3562 $7.137 (served model beside
the requested alias) · **W1-T2574**/#3585 $4.380 (matched-cell mount comparison) · **W1-T2575**/#3589
$6.539 (mount-routing rung) · **W1-T2578**/#3574 $5.210 (incident-timeline route) · **W1-T2580**/#3573
$7.934 (`rmd bundle`) · **W1-T2586**/#3584 $3.960 (TERM exit 0). Union-only, gate-side:
**W1-T2567**/#3553 $4.542 · **W1-T2573**/#3561 $8.085 · **W1-T2579**/#3569 $5.198 (bands shipped EMPTY).
**MINTED P66** on #3535, whose `codex/*` branch shipped W1-T2568's own shard and was refused as
`stale/foreign` — `stale/foreign`'s first genuinely foreign member in thirteen cycles. **P65 grew 8 →
12**; the credit band re-entered at **50%** (9 of 18) after three exits below; **TASK G = 10 (net 9
after one quantised ref, #3550), TASK L = 0 for the first time.** Wrote **DR-26**.

### RETRO-1788294290880 (2026-09-01) — the ledger credited nothing and a second provider shipped anyway: the first-token-mint await, the mid-flight turn count, the rotation-proof anomaly rows, the synthesis mount split, the mount-headroom sweep & the follow-up retirement: W1-T2554–T2568 (0 credited / 6 by union / 17 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R42

★ 9 runs / **$33.393** ($3.710/run, $5.566 per union ship, $1.964 per hand-verified merge, and **NO
per-ledger-credited-ship price at all**) over an ~11.4-hour window; census `blocked_ci`×5 +
`incomplete`×2 + `blocked_containment`×1 + `no_pr`×1 = 9, **`merged`×0 — the only zero in this log.**
**40 merges in-window, hand-verified over REST: 17 `run-W1-*`, 1 `run-RETRO-*` (#3480), 0
`run-APPROVE-*`, 22 hand-named.** All six credits were gate-side: **W1-T2554**/#3482 $3.355 (first
token mint awaited before the first board read) · **W1-T2557**/#3492 $7.427 (turn count visible
mid-flight) · **W1-T2558**/#3490 $6.204 (`cost.anomaly` survives rotation) · **W1-T2559**/#3500 $8.688
(synthesis lanes get their own mount) · **W1-T2560**/#3494 $5.044 (`mount-headroom-sweep`) ·
**W1-T2563**/#3497 $0.000 (follow-up retirement, unwired by its own file fence).
**MINTED P65 at rank 2** on eight hand-named merges changing `src/` or `test/` — #3498 (a capacity-aware
Codex provider), #3516, #3511 (trailered `W1-T2564`, credited by nothing), #3513, #3501, #3503, #3496,
#3485 — and wrote **DR-25**. **P64 held at two** (#3521, #3519); the eleven uncredited `run-W1-*` merges
split 8 TASK G (2 unrun, net 6) and 3 TASK L straddlers. **The band exited a third time at 0 of 15 and
was deliberately NOT re-cut** — R42 reads 50% on the same denominator and that re-entry is the reason.
### RETRO-1788251442324 (2026-09-01) — a run-shaped branch is not a run: the regenerable-artifact conflict admission, the declared-generator fix mode, the recycle-lock reclaim, the changed-files block, the task-scoped recon hash & the scrubbed push evidence: W1-T2506–T2556 (8 credited / 21 by union / 39 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R41

29 runs over a ~15.65-hour window (marker `1788194618833`), **$131.071 — $4.520/run, $16.384 per
ledger-credited ship, $3.361 per hand-verified merge**; census 8 `merged` + 10 `blocked_ci` +
7 `incomplete` + 2 `blocked` + 2 `no_pr` = 29; **45 merges in-window, 39 on `run-W1-*`**, hand-verified
over REST. LEDGER-CREDITED (8): W1-T2527/#3446 · W1-T2523/#3452 · W1-T2524/#3451 · W1-T2529/#3457 ·
W1-T2548/#3471 · W1-T2549/#3472 · W1-T2555/#3476 · W1-T2551/#3479. UNION-CREDITED, GATE-SIDE (13):
W1-T2508/#3428 · W1-T2510/#3437 · W1-T2512/#3455 · W1-T2513/#3448 · W1-T2518/#3429 · W1-T2519/#3419 ·
W1-T2521/#3440 · W1-T2522/#3459 · W1-T2525/#3449 · W1-T2528/#3465 · W1-T2530/#3458 · W1-T2550/#3475 ·
W1-T2556/#3478. **THE FINDING: eighteen `run-W1-*` merges credited by nothing, TEN of them on head-ref
epochs that are exact multiples of 1000 (#3414, #3416, #3417, #3418, #3420, #3421, #3422, #3423, #3435,
#3438 — one contiguous band, W1-T2533–T2546), a shape 0 of the 21 credited refs carry — MINTED P64.**
P63's bar scored at six with two non-ratchet members (R39-1 HIT); the credit band was RE-DERIVED to
20–65% on R39-3's second-exit trigger, the first band re-cut in this log.
### RETRO-1788193081371 (2026-08-31) — the gate whose own remedy was out of scope: the CLI-verb census fix, the proposal-registry shards, the operator-message checker, the band-meaning declaration, the red-check observable & the nightly ratchet that never ran: W1-T2479–T2517 (2 credited / 8 by union / 21 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R40

★ 23 runs over a ~12.14-hour window, **$126.160 — $5.485/run and $63.080 per ledger-credited ship, the
dearest ship-price this log had recorded.** 29 merges in-window (21 `run-W1-*`, 1 `run-RETRO-*`, 7
`plan-*`), hand-verified over REST; **93.1% of spend bought no ledger-credited ship, the largest residue
in the series.** **LEDGER-CREDITED (2):** W1-T2501/#3361 ($3.939, the entrypoint's baked path proved by
a test that reads the shipped entrypoint) · W1-T2514/#3404 ($4.748, the nightly mutation ratchet running
on exactly the nights it is needed). **UNION-CREDITED, GATE-SIDE (6):** W1-T2498/#3357 · W1-T2490/#3358
· W1-T2479/#3359 · W1-T2504/#3364 · W1-T2503/#3365 · W1-T2487/#3373.
**THE FINDING: seventeen `blocked_ci` verdicts, five of them stopped by a check whose own message names
the fix and whose fix lives in `scripts/source-size-baseline.json`, a file W1-T1227's declared-scope
rule forbade them to open** (W1-T2485/#3366, W1-T2490/#3358, W1-T2497/#3372, W1-T2503/#3365,
W1-T2504/#3364). **MINTED P63 at rank 2.** Thirteen in-window `run-W1-*` merges credited by nothing (11
TASK G / 2 TASK L), eight with their PR URL printed in the same gather — **P47's class at its then-
maximum.** R38-1 HIT (P62 scored at one), R38-2 HIT, R38-3 MISS (the band's first exit below, 9.5%).
### RETRO-1788144172947 / RETRO-1788096158805 (2026-08-30 → 08-31) — the task that was dispatched five times, then the retro that minted a trailer by quoting one: the retired-task blocker split, the tty layer, the gzip rotation archive & the windowed union, then the follow-up router, the at-head criteria wire & the per-spawn worker home: W1-T2442 + W1-T2455–T2495 (8 then 10 credited / 10 and 11 by union / 17 + 15 in-window `run-W1-*` merged) — ★ TWO ENTRIES FOLDED TO ONE BY R39

★ **R38 (…144172947):** 27 runs over a ~12.6-hour window, **$103.823 — $3.845/run, the cheapest
run-price recorded, and $12.978 per ledger-credited ship, then the dearest in nine cycles.** 38 merges
in-window hand-verified over REST: 17 on `run-W1-*` (10 union, 8 ledger), 1 on `run-RETRO-*` (#3309),
20 hand-named — 14 of them on one branch — exactly ONE carrying a trailer (#3328 → W1-T2509, body only,
**P58's first intake member in four cycles**). **★ ITS FINDING: NINE OF THE 27 RUNS WERE REPEATS OF
THREE TASKS** (W1-T2467 ×5, W1-T2475 ×5, W1-T2471 ×2); each loser's own resolver correctly refused the
PR its sibling merged, and nothing counted runs per task. **MINTED P62**, wrote **DR-22**, scored
**4 hits / 2 misses / 0 unresolvable** — the best ratio in this log.
**Shipped (rule 13 — the PRs are the record):** T2474/#3314 · T2481/#3326 · T2478/#3323 · T2475/#3329 ·
T2482/#3330 · T2484/#3343 · T2494/#3342 · T2495/#3347 · T2477/#3318 · T2467/#3327 — **the last four
DARK or INERT by their own admission.**

★ **R37 (…096158805):** 13 runs / 34 merges in-window, 15 on `run-W1-*`, ledger 10 ($48.923) / union 11.
**MINTED P61** (*the trailer scan is a substring match, so a body that DESCRIBES a trailer mints one*)
on its own predecessor's retro PR #3262, wrote **DR-21**, recorded the credit band's first exit in
eleven readings (66.7%), **a merged PR with a ZERO-file changeset** (#3261, P56's limit case), the
smallest uncredited residue ever ($8.404 / 14.7%), P46's first live population (n=3) and the turn
column's return at 39% coverage; scored 3 hits / 2 misses / 1 unresolvable.
**Shipped (rule 13):** W1-T2462/#3285 ($7.128) · W1-T2464/#3296 ($6.828) · W1-T2457/#3272 ($6.826) ·
W1-T2458/#3275 ($6.012) · W1-T2463/#3289 ($5.666) · W1-T2460/#3286 ($4.229) · W1-T2470/#3300 ($3.874) ·
W1-T2466/#3302 ($3.334) · W1-T2465/#3299 ($2.842) · W1-T2461/#3288 ($2.184) · W1-T2442/#3263 ($2.321,
gate-side) · T2453/#3257.
**Full prose of both entries DELETED; git holds it, and the proposals section carries each cycle's
mining block folded to its own line.**
### RETRO-1788011469299 (2026-08-29) — the retirement that was wrong on the merits: the fix rung's cumulative strike cap, board review's proposal lifecycle & the liveness sensor's third state: W1-T1269 + W1-T2387–T2453 (10 credited / 13 by union / 17 in-window `run-W1-*` merged) — ★ FOLDED TO TWELVE LINES BY R38

★ 14 runs over a ~22.1-hour window (marker `1787924208016`), **$91.082** ($6.506/run); 34 merges
in-window (17 `run-W1-*`, 1 `run-RETRO-*`, 2 `run-APPROVE-*`, 14 hand-named of which 5 carried code and
none carried a trailer); bracket $9.108 / $7.006 / $5.358; residue $43.394 (47.6%); turn column DARK
across all 14 runs.
- **LEDGER-CREDITED — 10, $47.688:** T2450/#3252 *$8.341* (launchd sensor reads `unknown`) ·
  T1269/#3241 *$6.752* (fix rung stops on an identical unmet-criteria repeat; **INERT** —
  `deriveStrikeHistory` fills no `unmetClaims`) · T2446/#3248 *$6.704* (dispatch claim reaches its
  evidence-release arm) · T2451/#3255 *$6.498* (board review retires a resolved referent; **DARK** — no
  production `boardReferents` reader) · T2453/#3257 *$5.047* (the escalation is named, not counted) ·
  T2447/#3247 *$2.543* + T2448/#3245 *$2.467* (the squash-merge setting the trailer surface rests on,
  asserted and documented) · T2444/#3236 *$2.411* (`sweep.fix.error` carries a `class`) · T2441/#3234
  *$3.805* (worker-home reap result surfaced at teardown) · T2449/#3249 *$3.120* (the self-sync refusal
  names its escape env).
- **UNION-RESCUED — 3, $38.745:** T2436/#3228 *$18.679* · T2440/#3227 *$12.537* · T2452/#3256 *$7.529*.
- **UNCREDITED `run-W1-*` — 4:** #3217/T2434, #3218/T2439, #3219/T2428 (straddlers) and **#3237/T2387
  (+6.03 h, INSIDE)** — the disjoint member that UN-RETIRED TASK G, lost to #3242's double body trailer.
- **HAND-NAMED CODE MERGES — 5, no trailer on either surface:** #3253 · #3246 · #3230 · #3229 · #3226.
  **The ratification lane merged for the first time:** #3254, #3251.

### RETRO-1787922605773 / RETRO-1787883095112 (2026-08-28) — the class that was retired one cycle before it refilled, then nine in / nine out: the CI fast lane, the head-resolved review criteria, the fix rung's signal accounting, the credential margin, the shallow-checkout doctor & the console write grant: W1-T1279 + W1-T2332–T2438 (9 then 5 credited / 15 then 12 by union / 18 + 9 in-window `run-W1-*` merged) — ★ TWO ENTRIES FOLDED TO ONE BY R37

★ **17 runs / ~10.2 h / $100.946 ($5.938/run), then 16 runs / ~6.3 h / $82.363 ($5.148/run).** 29 then
55 merges in-window, every one hand-verified over REST; the censuses closed exactly (9+4+3+1 = 17;
5+7+4 = 16). Cost brackets **$11.216 / $6.730 / $5.608** and **$16.473 / $9.151 / $6.864**; peaks
W1-T2403 $14.988 and W1-T2409 $7.611, both far under the $100 tripwire; residues 52% then 47%.
**The arcs, keyed by task → PR (Standing rule 13: the proof is the merged PR, and git holds the prose
this fold deletes):** W1-T2403/#3203 · T2402/#3202 · T2435/#3223 · T2438/#3221 · T2433/#3200 ·
T2432/#3198 · T2431/#3196 · T2371/#3195 · T2424/#3192 · T2430/#3205 · T2428/#3193 · T2437/#3222 ·
T2416/#3204 · T2383/#3199 · T2429/#3194 · T2339/#3167 · T2409/#3155 · T2407/#3154 · T2398/#3132 ·
T2419/#3182 · T2414/#3166 · T2332/#3133 · T2334/#3152 · T1279/#3142 · plus #3158/#3141/#3150 on the
same window's hand-named lane.
**What the two windows are kept in this log FOR:** the CI fast lane and the head-resolved review
criteria shipped here; **TASK G was retired by deletion on a fourth consecutive zero (R34) and its
class refilled one window later**, which is the observation R35's rule 19 and R36's DR-20 were both
written from; **the rejection label was found wrong on all thirteen of its own rows** (P57's mint
evidence); and the straddler class was first measured at n=3. Everything else these two entries said
is superseded by the Calibration section's folded trend line and by the proposal entries that carry
their evidence in place.

### RETRO-1787858337550 / RETRO-1787828128305 (2026-08-27) — the label that was wrong thirteen times, then the credit that was fabricated: the fix rung's message-set comparison & the ledger read intent, then the resolver-divergence detector, the provenance reader & the repeat-escalation rung: W1-T2299–W1-T2393 (2 credited / 3 by union / 7 in-window merged, then 8 / 14 / 15) — ★ TWO ENTRIES FOLDED TO ONE BY R36

★ **R32 (…858337550), FOLDED TO FOUR LINES:** 18 runs, ~7.9 h, **$81.853** ($4.547/run); **86% of the
window bought no ledger-credited ship, the highest reading in that series.** 2 credited —
**W1-T2328 → https://github.com/craigoley/remudero/pull/3123 · $7.743 · 82t** (the fix rung compares
annotation MESSAGE SETS before charging a strike) · **W1-T2393 →
https://github.com/craigoley/remudero/pull/3122 · $3.546 · 34t** (every ledger read in `src/lib/sweep.ts`
declares its intent). **Its durable finding — 4 merged, correctly trailered CODE PRs refused solely
because the head branch is not `run-*` (#3098, #3111, #3118, #3005) — is P57's arm (b) and is carried
in P57's own entry; the per-PR restatement is deleted.**

★ **R33 (…828128305) — the credit that was fabricated: the resolver-divergence detector, the provenance
reader & the repeat-escalation rung (W1-T2299–T2346, 8 credited / 14 by union / 15 in-window merged,
13 of them code), KEPT IN FULL:**
★ 24 runs DECLARED in scope over a **~13.2-hour** window (marker 2026-08-26T21:40:13.368Z = epoch
`1787780413368`; newest ledger row 2026-08-27T10:50:28.175Z). Costs total **$131.824** ($5.493/run).
**★ THE MERGE SET WAS VERIFIED BY HAND OVER REST AND THEN — FOR THE FIRST TIME IN THIS LOG — EVERY
CREDITED PR'S DIFF WAS READ TOO (DR-4 and DR-16):**
`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`
filtered at the marker on `merged_at` and `head.ref` prefix `run-W1-`, then `pulls/<n>/files` on every
credited candidate. **15 in-window `run-W1-*` merges; 13 carry `src/**`, `test/**` or `hooks/**`; TWO
are plan-only, and ONE OF THOSE TWO IS CREDITED AS A SHIP.** The census closes exactly: 8 `merged` +
8 `blocked_ci` + 3 `blocked_containment` + 3 `no_pr` + 2 `blocked` = 24.
**★ THE COST BRACKET IS THREE-VALUED AGAIN: $16.478** over the 8 the ledger credits, **$9.416** over
the 14 the union credits, **$8.788** over the 15 hand-verified in-window merges. Peak credited run
**W1-T2345 $9.618/0t**, 10.4× under the $100 tripwire; the 10 uncredited runs are bounded collectively
at **$48.592**, itself under the tripwire, so no run in this window can have tripped it. **No `$0.000`
credited run** for an eighth cycle. **THE RESIDUE: credited runs total $51.729 and the other 16 cost
$80.095 — 61% of the window bought no ledger-credited ship (54% → 63% → 66% → 61%, a fourth
consecutive majority); after the union it is $48.592, 37%.** **TURN COVERAGE 17%** — 355 turns over 4
of 24 runs, its best reading in six cycles, and **all 8 ledger-credited merges still print `0t`**; the
one ship carrying turns is the fabricated credit. **GUARD-FIRED BLOCKS: 3** — all
`containment/outside-cwd-denial` across THREE tasks, **ONE host storm, counted once (rule 8)**, **all
`observed: turns-exhausted` (monoculture restored after last cycle's 6+2)**, **2 of the 3 storm-hit
tasks merged in this same window anyway**, and **0 of the 3 carry T2238/#2794's `(numTurns, maxTurns)`
pair — 0 of 37 lifetime (TASK N)**. Mutation-gate lifetime **N=0, NO POSITIVE CONTROL** (fifteenth
cycle). Replay leg: **no run recorded** — T165/#2232's suite dark for a tenth cycle.

- **★ LEDGER-CREDITED — 8 tasks** → **$51.729**:
  - W1-T2345 *$9.618/0t* — the sweep escalates once when a verdict repeats 50× on an unchanged head, and resets on head move · https://github.com/craigoley/remudero/pull/3048
  - W1-T2346 *$9.172/0t* — the operator-gated default surfaces are censused for W1-T2347's opt-in · https://github.com/craigoley/remudero/pull/3046
  - W1-T2299 *$7.488/0t* — a body-edit re-offer loop gets a capped escalation row · https://github.com/craigoley/remudero/pull/3022
  - W1-T2315 *$7.267/0t* — the reviewer detects a trailer/Acceptance-block divergence and records `review.resolver_divergence` · https://github.com/craigoley/remudero/pull/3049
  - W1-T2314 *$5.801/0t* — a worktree may not run an install, pinned as a plan contract · https://github.com/craigoley/remudero/pull/3035
  - W1-T2303 *$5.313/0t* — `rmd serve` spawns with a real cwd and settings file · https://github.com/craigoley/remudero/pull/3034
  - W1-T2306 *$4.202/0t* — body repair stops double-charging the strike counter · https://github.com/craigoley/remudero/pull/3045
  - W1-T2312 *$2.868/0t* — the deny-floor becomes a hook with a test · https://github.com/craigoley/remudero/pull/3033
- **★ UNION-RESCUED (gate-side merges the ledger recorded `blocked_ci`) — 5 tasks** → **$26.401**,
  credited by W1-T51's ownership-asserted join and by nothing else:
  - W1-T2305 *$8.613/0t* — one shared rate-limit-provenance reader replaces three copies · https://github.com/craigoley/remudero/pull/3040
  - W1-T2344 *$6.383/0t* — the probe's turn allowance scales with its command count; the egress command reports its own outcome · https://github.com/craigoley/remudero/pull/3030
  - W1-T2333 *$3.934/0t* — the canonical checkout may not be shallowed · https://github.com/craigoley/remudero/pull/3015
  - W1-T2335 *$3.849/0t* — the board's blocker list names only dispatchable work · https://github.com/craigoley/remudero/pull/3038
  - W1-T2319 *$3.622/0t* — a token refresh names the aborting signal by identity, not by message text · https://github.com/craigoley/remudero/pull/3014
- **★★ FALSELY CREDITED — 1, AND IT IS THE CYCLE'S FINDING.** **W1-T2318 *$5.102/76t*** is recorded
  SHIPPED via https://github.com/craigoley/remudero/pull/3059 — **whose entire diff is
  `plan/tasks.d/W1-T2318-….yaml`** (`pulls/3059/files`, one file). The PR amends the plan to record
  that the task's real work merged in **#2972**, an untrailered hand-named branch no resolver can
  reach. **The task was dispatched THREE times** (runs …810730491, …814238514, …819701423) before this
  plan-only PR was opened and credited. **This line is kept in the SHIPPED log rather than deleted,
  labelled for what it is** — deleting it would hide the only instance of the defect P56 is minted on.
- **★ PRINTED-BUT-UNCREDITED — 1, AND FOR THE FIRST TIME IT IS NOT CODE**: **W1-T2313/#2971**, whose PR
  URL shares a harvest line with run id `DAEMON-1787778794650` while no credit section names either —
  diff `plan/tasks.yaml` only. **n=1 → 10 → 7 → 10 → 3 → 1 → 1.**
- **★ STRADDLERS — 1** (W1-T2313/#2971, **−6.58 h**; its cost lives in R31's population and is not
  restated here, rule 7). **ABSENT RUNS (P51's strict class — run START inside the window, named
  nowhere): 0** — every merge whose run began inside this window is credited by an instrument already
  on the page, a SECOND consecutive cycle.

### RETRO-1787778937848 (2026-08-26) — the residue that is all seam: the fix rung's stand-down, the prompt fingerprint & the replay verb: W1-T2293–W1-T2325 (4 credited / 9 by union / 12 in-window merged)

★ 18 runs DECLARED in scope over a **~7.6-hour** window (marker 2026-08-26T13:38:27.471Z = epoch
`1787751507471`; newest ledger row 2026-08-26T21:11:27.674Z). Costs total **$60.081** ($3.338/run).
**★ THE DECLARED POPULATION IS CONTRADICTED BY THE DOCUMENT AGAIN — AND THIS CYCLE THE GAP IS
DIAGNOSED RATHER THAN COUNTED.** `Runs in scope: 18` heads a body naming **23 distinct run ids**, and
the excess is exactly the **five `DAEMON-*` lane runs** the harvest prints and the verdict census
excludes (one of them, `DAEMON-1787749707742`, starting **30 minutes BEFORE the declared marker**).
The census closes exactly: 8 `blocked_containment` + 6 `blocked_ci` + 4 `merged` = 18; +5 DAEMON = 23.
**The two populations are not miscounted, they are UNLABELLED** — R30 found the arithmetic, R31 names
the mechanism, and TASK K's remedy is one label per population, not a re-count.
**★ THE THREE-WAY COST BRACKET COLLAPSED TO TWO: $15.020** over the 4 the ledger credits and
**$6.676** over the 9 the W1-T51 union credits — **because the union set and the in-population merge
set are the SAME NINE.** Peak CREDITED run **W1-T2317 $7.328/0t**; peak of the whole window
**W1-T2300 $10.205/107t**, 9.8× under the $100 tripwire and **the only run in the window carrying turn
data at all**; **no `$0.000` credited run** for a seventh cycle. **★ AND FOR THE FIRST TIME THE
TRIPWIRE'S 0-TRIPS CLAIM IS VERIFIABLE FOR THE WHOLE POPULATION** — the nine named runs are priced
individually and the other nine are BOUNDED collectively at **$1.281**, so no run can have approached
$100. **THE RESIDUE: credited runs total $20.430 and the other 14 cost $39.651 — 66% of the window
bought no ledger-credited ship (54% → 63% → 66%, a THIRD consecutive majority); after the union it is
$1.281, 2.1%.** **★ THE LEDGER CREDITS 4 OF 12 IN-WINDOW MERGES (33%) AND THE UNION CREDITS 9 (75%),
FIVE OF THEM GATE-SIDE RESCUES — a second consecutive five-rescue cycle** — verified BY HAND on
2026-08-26 over REST (`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`
filtered at the marker on `head.ref` prefix `run-W1-`, then `pulls/<n>/files` per uncredited candidate:
DR-4). **TURN COVERAGE 6%: 107 turns on ONE run, and that run is a union rescue, not a ledger
credit — ALL 4 credited merges print `0t`, a THIRD consecutive cycle.** **GUARD-FIRED BLOCKS: 8** —
all `containment/outside-cwd-denial` across FIVE tasks, **ONE host storm, counted once (rule 8)**, and
**3 of those 5 tasks merged in this same window anyway**; **0 of the 8 carry T2238/#2794's
`(numTurns, maxTurns)` pair — 0 of 34 lifetime (TASK N)**. **★ AND THE STORM BROKE ITS OWN STATE
MONOCULTURE: 6 `turns-exhausted` + 2 `probe-never-ran`**, ending 42 consecutive unanimous rows — see
the cross-foot finding in NET STATE, because the spend column says all eight look like the second
state. Mutation-gate lifetime **N=0, NO POSITIVE CONTROL** (fourteenth cycle). Replay leg: **no run
recorded** — T165/#2232's suite dark for a ninth cycle.

- **★ LEDGER-CREDITED — 4 tasks** → **$20.430**:
  - W1-T2317 *$7.328/0t* — negative-arm fixtures ratcheted for the recogniser surfaces (0 of 95 exercised, frozen as declared debt) · https://github.com/craigoley/remudero/pull/2987
  - W1-T2325 *$5.892/0t* — diff-coverage stops blocking pre-existing lines a diff merely RELOCATED · https://github.com/craigoley/remudero/pull/2990
  - W1-T2297 *$4.158/0t* — the prompt parts a worker actually received are fingerprinted · https://github.com/craigoley/remudero/pull/2996
  - W1-T2310 *$3.052/0t* — a deterministic ledger-read-count invariant lands beside the raised timing ceiling · https://github.com/craigoley/remudero/pull/2964
- **★ UNION-RESCUED (gate-side merges the ledger recorded `blocked_ci`) — 5 tasks** → **$38.370**,
  credited by W1-T51's ownership-asserted join and by nothing else:
  - W1-T2300 *$10.205/107t* — rollup start times populated and the stale-check arm wired · https://github.com/craigoley/remudero/pull/3001
  - W1-T2293 *$9.292/0t* — the fix rung stands down on an unread-body infrastructure fault, by disposition rather than by prose match · https://github.com/craigoley/remudero/pull/2979
  - W1-T2311 *$7.104/0t* — the daemon no longer boots on the operator's personal credential · https://github.com/craigoley/remudero/pull/2967
  - W1-T2296 *$6.912/0t* — `rmd replay` narrates a ledger window (landed at `src/lib/ledger-replay.ts` after its declared path collided with T165's shipped `replay.ts`) · https://github.com/craigoley/remudero/pull/2986
  - W1-T2316 *$4.857/0t* — the acceptance-repair trigger widened to the category that was escaping it · https://github.com/craigoley/remudero/pull/2977
- **★ PRINTED-BUT-UNCREDITED — 1 CODE merge**, the smallest this class has ever read: **W1-T2304/#2952**
  (the board-review rung), whose PR URL shares one harvest line with a run id — **and the run id printed
  is `DAEMON-1787749707742`, NOT the `run-W1-T2304-1787747358878` branch that merged, which is precisely
  why the join fails.** **n=1 → n=10 → n=7 → n=10 → n=3 → n=1.**
- **★ STRADDLERS — 3, AND THEY ARE THE ENTIRE RESIDUE**: W1-T2304/#2952 (−1.15 h) · W1-T2289/#2955
  (−1.16 h, the intake trigger reading its own backlog depth) · **W1-T2268/#2895 (−13.49 h, the CI-wait
  poll loops moved off GraphQL) — the deepest per-run straddler this log has ever stated**, against
  R25's 3.4 h and R27's 3.64 h (R26's seven were reported only as spanning 29.4 h, so no per-run
  comparison exists). All three are real `src/**`+`test/**` diffs; their costs live in R30's population
  and are NOT restated here (rule 7). **ABSENT RUNS (P51's strict class — run START inside the window,
  named nowhere): 0.** Every merge whose run began inside this window is credited by an instrument
  already on the page.

### RETRO-1787749880590 (2026-08-26) — the population that is not one population: the proof/engine gate, the credit resolver & serve idempotency: W1-T2244–W1-T2302 (7 credited / 12 by union / 18 in-window merged) — ★ FOLDED BY R32

★ 27 runs over a **~9.4-hour** window (marker 2026-08-26T03:42:19.068Z). **$122.247** ($4.528/run);
bracket **$17.464 / $10.187 / $8.150**. Peak credited **W1-T2286 $8.341/0t**; no `$0.000` credited run.
Credit **7 of 18 (39%), union 12 (67%) with FIVE gate-side rescues**, hand-verified over REST at the
marker (DR-4). Turns **7%, 177 on ~2 runs; all 7 credited merges `0t`**. Guard-fired blocks
**8**, all `containment/outside-cwd-denial`, all `turns-exhausted`, across SIX tasks — ONE host storm
counted once (rule 8), **4 of the 6 merging anyway**; 0 of 8 carried the `(numTurns, maxTurns)` pair.
Mutation **N=0**; replay **no run recorded**. **★ ITS OWN FINDING, PRESERVED IN ONE LINE:** `Runs in
scope: 27` headed a body naming **33 distinct run ids** — the first time this log caught its gather
stating its own population twice, differently, which is what re-scoped TASK K. **★ FOLDED TO ONE ENTRY
BY R32** (R13’s doctrine: ids and PRs preserved, per-task costs and descriptive prose deleted; git
holds them).

- **★ LEDGER-CREDITED — 7 tasks, $45.602:** T2286/#2913 · T2302/#2940 · T2283/#2930 · T2301/#2929 ·
  T2287/#2912 · T2274/#2910 · T2284/#2941.
- **★ UNION-RESCUED — 5 tasks, $26.452:** T2291/#2921 · T2294/#2924 · T2282/#2911 · T2281/#2909 ·
  T2275/#2923.
- **★ PRINTED-BUT-UNCREDITED — 3 CODE merges:** T2292/#2926 · T2295/#2931 · **T2288/#2946 (widened the
  retro’s TRIGGER without widening what it DISPLAYS — still true).**
- **★ STRADDLERS — 2:** T2272/#2905 · T2244/#2828. **★★ ABSENT RUN — 1, P51’s first un-park reading:**
  **T2298/#2942**, a well-formed run branch with a resolving trailer and a real diff, named in no
  section of its own gather. P51’s bar was two, so it stayed PARKED — and **R31-4’s zero returned it to
  PARKED-at-zero, where it remains.**
### RETRO-1787714349337 / RETRO-1787654213224 (2026-08-25 → 08-26) — the evidence under the verdict, the reaper's scope & the ledger's full corpus, then the probe's own budget, the containment anchors & the recon artifact: W1-T2211–W1-T2279 (14 credited then 18 / 27 + 28 in-window merged) — ★ TWO ENTRIES FOLDED TO ONE BY R31

★ 92 runs across both, all `implement`/`src`, over ~16.3 h then ~20.6 h (markers
2026-08-25T10:55:21.211Z and 2026-08-24T13:59:08.278Z). **$360.491** ($3.92/run); brackets
**$13.449 / $7.242** then **$9.567 / $6.378**. Peaks **W1-T2257 $12.083/0t** and **W1-T2213
$11.950/0t**; no `$0.000` credited run in either. Credit **14 of 27 (52%) with the union rescuing
NOTHING — the first such cycle in five** — then **18 of 28 (64%), union 20 (71%)**; both hand-verified
over REST at the marker (DR-4). **★ THE RESIDUE FIRST INVERTED HERE:** $87.114 credited
against $101.172 uncredited, 54% of the window buying no credited ship. Turns **4% on ~2 runs** then
**18% on ~8**. Guard-fired blocks **18** then **16** — all `containment/outside-cwd-denial`, all
`observed: turns-exhausted`, across ELEVEN tasks each: ONE host storm per cycle, counted once (rule 8),
with **9-of-11 then 10-of-11** of the storm-hit tasks merging anyway, which is why both fold-line
readings are **UNCOMPUTABLE without TASK H** rather than estimated (P48). Mutation **N=0** in both;
replay **no run recorded** (sixth and seventh dark cycles). **★ FOLDED TO ONE ENTRY BY R31** (R13's
doctrine: ids and PRs preserved, per-task costs and descriptive prose deleted; git holds them).

- **★ LEDGER-CREDITED — 32 tasks, $187.943.** *08-26 (14, $87.114):* T2257/#2869 · T2269/#2876 ·
  T2265/#2873 · T2278/#2894 · T2260/#2851 · T2261/#2862 · T2270/#2880 · T2264/#2874 · T2254/#2844 ·
  T2267/#2879 · T2273/#2885 · T2276/#2872 · T2251/#2839 · T2279/#2897. *08-25 (18, $100.829):*
  T2213/#2732 · T2211/#2729 · T2232/#2776 · T2222/#2763 · **T2231/#2801 (a dispatch reports whether it
  actually spent — its `dispatchStarted` signal is STILL populated by test fakes only)** · T2234/#2777 ·
  T2215/#2731 · **T2235/#2786 (the third review state — `REVIEW_STATE_LABELS` still has no badge for
  it)** · T2229/#2779 · T2228/#2782 · T2224/#2760 · T2217/#2734 · T2239/#2805 · T2225/#2771 ·
  T2223/#2766 · T2243/#2809 · T2237/#2799 · T2240/#2806.
- **★ UNION RESCUES (08-25 only) — 2, $10.925:** **T2212/#2730** (the risk judge tells unparseable from
  adverse under a bounded retry — **still not wired into `run-task.ts`'s live dispatch**) ·
  T2218/#2738.
- **★ PRINTED-BUT-UNCREDITED — 17 CODE PRs whose run id and merged PR URL share one line of their own
  gather's harvest while no credit section holds the pair.** *08-26 (n=10):* T2271/#2898 · T2266/#2875 ·
  T2262/#2861 · T2263/#2852 · T2258/#2848 · T2248/#2841 · T2249/#2838 · T2250/#2833 · T2247/#2830 ·
  T2246/#2820. *08-25 (n=7):* T2219/#2742 · T2220/#2748 · T2221/#2749 · **T2216/#2765 (the sandbox key
  set compared against the SDK's own `.d.ts` — `NETWORK_KEYS`/`FILESYSTEM_KEYS` remain over-strict by
  one level)** · T2226/#2773 · **T2238/#2794 (the probe records its `(numTurns, maxTurns)` pair — the
  field TASK N has now watched reach 0 of 34 guard rows)** · T2236/#2807. **NOT on P33's list: TASK G
  recovers every one from two printed lists.** *A sub-class R28-1's wording did not cover, recorded
  once and not re-argued:* **2 more (T2245/#2829, T2252/#2845) printed a run id with NO PR URL.**
- **★ STRADDLERS (2) AND ABSENT RUNS (0, twice).** T2241/#2808 and **T2205/#2714 (−1.52 h)** — depth
  series 3.4 → 29.4 → 3.6 → **1.5 h**, the spread DR-11 is written on. **P51 stayed PARKED
  across both.** **★ REJECTED TRAILERS: 1, A SIBLING NOT A FOREIGNER** — T2215's trailer named a merge
  from the same task's OTHER run; the rejection was correct and cost nothing. **0 foreign trailers over
  ~66 observations**, the count that made R25 strike the word.

### RETRO-1787578143187 / RETRO-1787502627029 (2026-08-23 → 08-24) — the credit surface, the ratchets' type discipline & the doctor's sweep-liveness arm, then the containment storm, the ledger's declared intent & the push lease: W1-T1207–W1-T2206 (25 credited then 17 / 31 + 31 in-window merged) — ★ TWO ENTRIES FOLDED TO ONE BY R30

★ 83 runs across both, all `implement`/`src`. **$377.312** ($4.55/run); brackets **$6.874** (a single
point — 13 of 38 merges had their cost in no window's total) then **$12.086 / $7.610**. Peaks
**W1-T1227 $15.623/0t** and **W1-T1282 $12.059/0t**; no `$0.000` credited run in either. Credit **14 of
31 (45%), union 25 (81%)** then **17 of 31 (55%), union the SAME 17 — the first cycle in this log's
history in which the union rescued NOTHING**, both hand-verified over REST at the marker (DR-4; the first was forced onto REST by a GraphQL bucket exhausted at 0 of 5000). Turns **0 of 31 runs**
then **2% on ONE run**. Guard-fired blocks **0** then **23** (22 `outside-cwd-denial` across TWELVE
tasks + 1 `isolation/inherited-functions`) — ONE host storm, counted once (rule 8). Mutation **N=0** in
both; replay **no run recorded** (fourth and fifth dark cycles). **★ FOLDED TO ONE ENTRY BY R30**
(R13's doctrine: ids and PRs preserved, per-task costs and descriptive prose deleted; git holds them).

- **★ LEDGER-CREDITED — 31 tasks, $172.966.** *08-23 (14, $68.591):* **T1235/#2576 (the exhausted
  GitHub bucket NAMED on a rate-limited auto-merge-arm refusal)** · T1219/#2564 · T1207/#2519 ·
  T1210/#2521 · T1236/#2572 · T1237/#2579 · T1000003/#2541 · T1240/#2585 · T1222/#2540 · T1232/#2568 ·
  T1234/#2575 · T1250/#2610 · T1233/#2571 · T1238/#2581. *08-24 (17, $104.375 — and the union added
  not one):* **T1281/#2685 (the containment guard NAMES the unproven state instead of discarding it —
  the merge that broke R27's "constraint is a law of nature" reading)** · T1282/#2697 · T1264/#2656 ·
  T1272/#2674 · T1252/#2637 · T1257/#2636 · T1274/#2675 · T1256/#2646 · T1267/#2665 · T2206/#2710 ·
  T1288/#2690 · T1262/#2650 · T1277/#2673 · T1266/#2659 · **T2204/#2691 (`mainHealthFromRollup` —
  STILL the one line the SHIPS-UNWIRED scan returns, three cycles on)** · T1271/#2667 · T1270/#2664.
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED (08-23 only) — 11 tasks, $69.237, the largest rescue
  set this log had recorded at the time.** T1227/#2569 (**`blocked`, not `blocked_ci`**) · T1223/#2549 ·
  T1225/#2573 · T1213/#2545 · T1208/#2522 · T1212/#2542 · T1224/#2553 · T1217/#2523 · T1216/#2546 ·
  T1239/#2583 · **T1214/#2520 (`credit-surface-gate` — shipped, and STILL with no CI job step).**
- **★ PRINTED-BUT-UNCREDITED — 11 CODE PRs whose run id and merged PR URL share one line of their own
  gather's harvest while no credit section holds the pair.** *08-23 (1):* T1248/#2599 — the exemplar
  that promoted DR-5 from curiosity to the largest credit-loss class on the page. *08-24
  (10, n=10):* T1259/#2639 · **T1263/#2657 (a state-citation gate script + baseline, STILL not wired
  into CI)** · T1268/#2668 · T1275/#2672 · T1286/#2677 · T1287/#2679 · T1278/#2684 · T1280/#2687 ·
  T2201/#2695 · T1284/#2702. **NOT on P33's list: TASK G recovers every one from two printed lists.**
- **★ STRADDLERS (11) AND ABSENT RUNS (5).** *08-23:* T1000002/#2376 (−29.38 h), T1098/#2403,
  T1104/#2434, T1109/#2431, T1128/#2478, T1132/#2494, T1134/#2499 — **the depth series 3.4 → 29.4 →
  3.6 h that DR-11 is written on.** *08-24:* T1253/#2605, **T1249/#2612 (the bounded
  promotion judge — the instrument that ended a six-cycle dark leg is itself credited to no cycle)**,
  T1251/#2611, T1265/#2626. **ABSENT RUNS (P51's ground truth, 08-23):** #2526, #2529, #2532, #2602,
  #2604 — run ids never printed, added to P33's quarantine list (+5 → 52). R27 then observed ZERO and
  **P51 was PARKED**; R30 records the class's FIRST return since (#2942). No costs stated (P48, rule 7).
- **UNCREDITED-RUN REMAINDER — 52 runs across both** (08-23: `blocked_ci`×15, `blocked`×1, **`failed`×1
  — a verdict class this file has never seen printed before or since, n=1, no exemplar**; 08-24:
  `blocked_containment`×22, `blocked_ci`×11, `blocked_isolation`×1, `blocked`×1). The 08-24 fold-line
  reading is **UNCOMPUTABLE without TASK H** — 18 of its 23 guard rows belong to tasks that merged
  anyway, which is ONE event, never 18 readings (rule 8); the 08-23 reading is **11 of 17 = 65%, a
  FLOOR**.

### RETRO-1787290856852 / RETRO-1787419805720 (2026-08-21 → 08-22) — the containment storm + attribution spine + review/proof lane, then the fix rung's park/rebase, the sweep's stand-down vocabulary & the doctor's repair arm: W1-T1016–T1209 (29 credited / 40 merged, then 27 / 33) — ★ TWO ENTRIES FOLDED TO ONE BY R30

★ 95 runs across both, all `implement`/`src`. **$506.935** ($5.34/run); brackets **$8.39 / $6.57 /
$6.08** then **$9.77 / $9.09 / $8.79** — the second cycle's three denominators differing because
**three of its 33 merges are STRADDLERS whose runs and costs are in NO window's total**, the first
time this log ever had a row for that class. Peaks **W1-T1044 $37.084/0t** (3.3× the next) then
**W1-T1082 $12.323/0t** — the lowest peak this log has recorded, with **no `$0.000` credited run** in
the second window after three of the first's nineteen rescues recorded one (**a `$0.000` cost on a run
that merged a PR is an UNRECORDED cost, never a free one** — P48). Credit **29 of 40 (73%)** then
**21 of 33 (64%), union 27 (82%) — both all-time highs**, hand-verified at the marker (DR-4).
Turns **3 of 29 (11%)** then **5 of 27 (19%)**, the dark rows a contiguous PREFIX in BOTH (boundaries
dark >6.11 h / lit <4.83 h, then dark >5.47 h / lit <2.52 h). Rejected trailers **22, all SIBLING,
ZERO foreign** then **5, all one task, ZERO foreign — and R24-2's pre-commitment fires: the word
`foreign` is STRUCK.** Guard-fired blocks **13** (all `outside-cwd-denial`, all `observed: unproven`,
all inside a **41-minute band on one host** — **the event that minted DR-8**) then **2**
(`isolation/inherited-functions`). Mutation **N=0** in both; replay **no run recorded** (second and
third dark cycles). **★ FOLDED TO ONE ENTRY BY R30** (R13's doctrine: ids and PRs preserved, per-task
costs and descriptive prose deleted; git holds them).

- **★ LEDGER-CREDITED — 31 tasks, $182.127.** *08-21 (10, $63.578):* T1069/#2336 · T1018/#2271 ·
  T1053/#2347 · T1077/#2358 · T1071/#2335 · T1052/#2340 · T1066/#2322 · T1068/#2330 · T1026/#2295 ·
  T1034/#2265. *08-22 (21, $118.549):* **T1082/#2367 (disk headroom escalated before ENOSPC can blind
  the ledger)** · T1205/#2500 · **T1202/#2515 (harness PR creation moved off GraphQL `--fill` onto
  REST — the transport every later cycle's hand-verification depends on)** · T1103/#2424 · T1100/#2415
  · T1089/#2397 · T1127/#2476 · T1079/#2392 · T1201/#2505 · T1116/#2453 · T1118/#2458 · T1113/#2442 ·
  T1086/#2369 · T1099/#2409 · T1131/#2477 · T1096/#2402 · **T1209/#2511 (`judgeRepairStall` — STILL
  with no production reader, so `rmd doctor` prints `repair-stall: OK` unconditionally)** ·
  T1111/#2437 · T1112/#2436 · T1105/#2422 · T1087/#2371.
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 25 tasks, $193.226.** *08-21 (19, $157.882 — the
  largest rescue this log has recorded):* T1044/#2331 · T1045/#2332 · T1067/#2323 · T1031/#2315 ·
  T1040/#2326 · **T1038/#2321 (the fail-open memory governor — shipped UNWIRED by design and still
  without a `DaemonDeps`/`DrainDeps` wire)** · T1049/#2274 · T1064/#2316 · T1019/#2273 · T1016/#2266 ·
  T1060/#2314 · T1021/#2284 · T1051/#2286 · T1050/#2334 · T1036/#2268 · T1065/#2320 · **T1024/#2294,
  T1054/#2289, T1061/#2292 at `$0.000/0t` each.** *08-22 (6, $35.344):* T1117/#2455 · T1088/#2395 ·
  T1206/#2506 · T1129/#2479 · T1101/#2419 · T1110/#2432.
- **★ RESIDUE — 10 PRs merged on their own run branch and credited by nothing, 3 straddlers, 4
  correctly-uncredited plan-only filings.** *08-21 (8):* **T1059/#2346 — a production caller for the
  learnings-promotion pass, merged in the same window whose gather reported that pass did not run** ·
  T1048/#2270 · T1047/#2311 · T1055/#2312 · T1056/#2319 · T1063/#2309 · T1076/#2356 · **T1085/#2357,
  whose trailer is in the COMMIT MESSAGE ONLY — TASK G(iv)'s origin.** *08-22 (2 PRs, ONE task):*
  T1095/#2411 and T1095/#2483 — the resolver took the LATEST PR carrying the task id rather than the
  PR whose head IS the run's branch, **and printed the refused branch name verbatim**; both on P33's
  list, and R26's R25-2 observed 0 of 2 and WITHDREW at n=1. **STRADDLERS (08-22):** T1062/#2354,
  T1074/#2361, T1078/#2363 (−3.38 h / −1.41 h / −0.70 h). **CORRECTLY UNCREDITED:** #2325, #2329,
  #2349, #2388 — plan-only filings on run branches, T1004/#2152's predicate working, **not a defect.**
  No costs stated for any residue set (P48, rule 7).
- **UNCREDITED-RUN REMAINDER — 39 runs across both.** *08-21:* 25 runs, **$21.756** — **THIRTEEN of
  them the containment storm**, which is why the remainder reads **$0.87/run against a $4.504 window
  average: not thrift, but the price of a run the guard killed before it could spend**, and reading it
  as efficiency is the relabelling DR-8 forbids. *08-22:* 14 runs, **$109.826 at $7.85/run
  against a $6.432 window average — the first cycle where the uncredited remainder cost MORE per run
  than the window**, the exact inverse of the line above.

### RETRO-1787193680272 / RETRO-1787106875391 (2026-08-19 → 08-20) — the pacer spine + credit predicate + diagnose lane, then arm integrity + the id allocator + the self-harness leg (18 credited / 31 merged, then 17 credited / 30 merged) — ★ TWO ENTRIES FOLDED TO ONE BY R28

★ 63 runs across both, all `implement`/`src`. **$360.029** ($5.71/run); brackets **$9.04 / $6.51 /
$5.25** and **$11.61 / $7.05 / $6.58**. Peaks **W1-T7B $10.593/144t** and **W1-T949 $14.890/0t**. Turns
28% then 47%, the dark rows a contiguous PREFIX in BOTH windows — the reading that killed R21's
gate-side-credit shape. 2 rejected trailers (both mislabelled) then 0; **0 guard-fired blocks in either
window**; mutation **N=0** in both; replay **no run recorded** — the suite shipped in the second window,
dark. **★ FOLDED TO ONE ENTRY BY R28** (R13's doctrine: ids and PRs preserved, per-task costs and
descriptive prose deleted; git holds them).

- **★ LEDGER-CREDITED — 20 tasks, $134.668.** *08-19:* **T7B/#2178 (`runDiagnoseThenRetry` wired into
  the implement dispatch, ending five cycles of zero `diagnose` runs)** · T978/#2117 · T984/#2127 ·
  T493/#2183 · T999/#2155 · T1007/#2157 · T991/#2146 · T976/#2115 · **T1004/#2152 (the plan-only
  merge-credit predicate that makes six of that window's uncredited merges CORRECT)** · T986/#2132.
  *08-20:* **T947/#2194 (the irreversibility signal routed into every auto-merge arm site)** ·
  T1011/#2236 · T1028/#2242 · T1033/#2260 · T1029/#2241 · T1035/#2263 · T1017/#2193 · T1013/#2262 ·
  T1030/#2254 · T1032/#2252.
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 15 tasks, $84.645, nearly all `blocked_ci`.**
  *08-19:* T943/#2051 · T945/#2055 · T939/#2052 · T972/#2113 · T977/#2116 · **T941/#2060, T944/#2049,
  T970/#2106 at `$0.000/0t` each — unrecorded costs, never free ones.** *08-20:* T949/#2196 ·
  T951/#2188 · T964/#2191 · T1010/#2190 · T948/#2187 · **T74/#2186 (next-unused proposal ids + a CI
  uniqueness gate — the discipline every later P-mint is checked by)** · T492/#2189.
- **★ MERGED ON THEIR OWN RUN BRANCH, CREDITED BY NOTHING — 18 CODE PRs, recovered by hand.**
  *08-19:* **T1008/#2163 + T1005/#2159 (together the producer and the budget wire that let T529's
  rate-limit floor FIRE, retiring a *Still PLANNED · DARK* entry carried for three cycles — R22's
  STING)** · T997/#2153 · T1009/#2160 · T1006/#2162 · T234/#2177 · T981/#2122. *08-20:* **T165/#2232
  (the golden-task replay suite, shipped MECHANISM-AND-SEAM ONLY with no `HarnessRunner` wired —
  R23's STING, still dark today)** · T188/#2234 · T1020/#2214 · T975/#2212 · **T1012/#2240 (the
  `Remudero-Task` trailer COMMITTED so squash-merge keeps it)** · T1039/#2255 · T963/#2204 ·
  T983/#2230 · T952/#2199 · T446/#2237 · T1027/#2211. **Thirteen of the eighteen had their PR url
  printed in their own gather's follow-up harvest** — R21-2 and R22-2 both predicted zero such rows,
  and this class is the ancestor of R27-1/R28-1. **No costs or turns are stated** (P48).
- **★ STRADDLERS (08-20) — 2 CODE PRs BELONGING TO NO CYCLE.** **T71/#2182 `rmd receipt <pr>`** —
  P17's ratified receipts task, left *uncredited* by six consecutive syncs — and **T499/#2181**, both
  from runs starting ~5 minutes before the marker. **TASK L exists to make this automatic.**
- **★ CORRECTLY UNCREDITED (08-19) — 6 plan-only filing PRs** (T968/#2099, T971/#2101, T974/#2104,
  T985/#2129, T988/#2134, T996/#2140). **NOT a credit defect and NOT on P33's list:** T1004/#2152
  shipped that same window to refuse merge credit to a plan-only filing PR — the first time part of the
  uncredited gap was the harness working as designed.
- **UNCREDITED-RUN REMAINDER — 28 runs, $140.716** across both windows (`blocked_ci`×14,
  `incomplete`×10, `blocked`×7, `pr_attribution_failed`×3, `no_pr`×1, less the fifteen the union
  rescued). **At least eleven of the 08-20 runs merged a PR**, so the label is suspect in both:
  TASK G would print the orphan merges, TASK H the per-run verdict row, TASK K whether the run set is
  complete, TASK L whether its boundary is sound.
### RETRO-1786966159317 / RETRO-1786867677764 (2026-08-16 → 08-17) — the rate-limit floor, the sweep transport & the identity seam, then the review three-state, the install root & the retro instrument's own repair: W1-T502–T533 + T901/T903 + T905–T936 (14 credited / 30 merged, then 19 / 31) — ★ TWO ENTRIES FOLDED TO ONE BY R33

★ 31 runs then 27, all `implement`/`src`. **$198.797** ($6.413/run) then **$182.927** ($6.775/run);
peak credited runs **W1-T504 $26.380** and **W1-T913 $16.345/195t**. Turns 4 of 14 lit (29%) then
**15 of 19 (79%) — the high-water mark of the whole series.** 1 then 0 guard-fired blocks; 1 then 2
rejected trailers (one MISLABELLED); mutation-gate **N=0** in both. **The 08-16 window is where this
log first carried ships the instrument never named** — 16 of 30 recovered by hand with
`gh pr list --state merged` at the marker.

- **★ LEDGER-CREDITED — 8 tasks, $75.707 then 9 tasks, $76.021.** 08-16: **T504/#1869 *$26.380*** ·
  T514/#1889 · T516/#1890 · T517/#1898 · **T523/#1917 *$14.757/149t*** · T526/#1926 ·
  **T529/#1933 — the `gh` pace FLOOR, shipped DARK** · **T531/#1929 the Cloudflare Access identity
  seam.** 08-17: **T925/#2011 *$12.384/145t*** · T911/#1983 · **T930/#2008 *$10.083/148t*** ·
  T914/#2010 · T920/#1998 · T915/#1985 · T923/#2000 · T929/#2006 · T936/#2026.
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 6 tasks, $15.115 then 10 tasks, $73.436.** 08-16:
  T502/#1856 · T503/#1863 · T505/#1864 · T506/#1879 · T508/#1878 · T510/#1881. 08-17:
  **T913/#1995 *$16.345/195t*, `remudero-review=pending` posted at DETECTION** · T905/#1948 ·
  T931/#2013 · T924/#2002 · T907/#1952 · T912/#1981 · T918/#1982 · T533/#1968 · T908/#1969 · T932/#2020.
- **★ MERGED, TRAILERED, AND NAMED NOWHERE IN THE GATHER — 16 then 12 PRs, recovered by hand; no costs
  or turns stated (P48).** 08-16: T507/#1886 · T509/#1870 · T511/#1887 · T512/#1872 ·
  **T513/#1888 — branch names the task, body carries NO trailer (a P33 shape)** · T515/#1882 ·
  T518/#1902 · T519/#1909 · T521/#1921 · T522/#1913 · **T525/#1927 the metered `gh` seam** · T527/#1919 ·
  T528/#1931 · T530/#1934 · T901/#1936 · T903/#1940. 08-17: **T534/#1967 — correctly trailered on its
  own run branch while the gather rejected #1977 for the same task** · T916/#1984 · T917/#1986 ·
  T921/#1992 · T529/#1951 + #1970 · T933/#2019 · **T934/#2024 the REQUIRED licence gate** · T935/#2027 ·
  T938/#2030 · T942/#2037 · T940/#2033. Round-number run ids explain a handful and never the rest.
- **UNCREDITED-RUN REMAINDER — 17 runs, $107.975 (792 of 1147 turns) then 8 runs, $33.470.** At least 7
  of the first group own one of the merges above, which is why R20's apparent 1-in-13 `blocked_*` ratio
  was an artifact. TASK G would print those sections; TASK H would let this one be counted, not named.

### RETRO-1786799102812 (2026-08-15) — write tiers, sweep integrity & the freshness family: W1-T404–T500 (25 tasks / 25 PRs) — ★ FOLDED TO THREE LINES BY R34

★ 46 runs, all `implement`/`src`. **$288.330** ($6.268/run, **$11.53 per shipped task**), peak
**W1-T456 $19.453**. **12 of 25 LEDGER-CREDITED (48%)**; **13 gate-side** (ten `blocked`/`blocked_ci`,
three `incomplete`). **TURNS: 1 of 25 shipped runs lit (4%), 173 total — column UNUSABLE, blacked
out** (R21's FIRST FINDING). 19 rejected trailers = 14 self-redispatch / 5 foreign-proper, hand-split.
**6 guard-fired containment blocks on one host**, all re-dispatched. Mutation-gate **N=0, NO POSITIVE
CONTROL**. **★ FOLDED TO FAMILY LINES BY R21, THEN TO THREE LINES BY R34** — ids, PRs and load-bearing
costs preserved; per-task prose and the per-bullet framing are gone (git holds them).

- **LEDGER-CREDITED — 12 tasks, $89.985**: W1-T450/#1695 · T454/#1740 · T457/#1771 · T458/#1772 ·
  **T473/#1781 *$17.682*, dearest credited** · T476/#1782 · T474/#1791 · T482/#1808 · T487/#1815 ·
  **T495/#1835 — the read-sensitivity axis, DARK on arrival** · T497/#1842 · T498/#1843.
- **GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 13 tasks, $101.058**: W1-T404/#1709 (the write-tier
  split) · T449/#1690 · T453/#1753 · **T456/#1766 *$19.453*, the window's peak run** · T461/#1773 ·
  T463/#1775 · T468/#1780 · T470/#1783 · T477/#1800 · T486/#1812 · T488/#1821 · T496/#1844 ·
  **T500/#1849 *$13.234/173t* — the ONLY run here with a lit turn column**.
- **MERGED ON `main`, CREDITED TO NO RUN — 2 PRs, NOT in the 25: W1-T481/#1797, W1-T490/#1825**,
  trailered and merged, visible only as rejected rows because every candidate run's head branch belongs
  to a run outside the window. R18-1's metric, and **the origin of TASK G — which R34 RETIRED after
  four consecutive empty readings** (see the TASK G tombstone). **UNCREDITED REMAINDER — 21 runs,
  $97.287** (`blocked_containment`×6 guard-fired, `incomplete`×4, `blocked_ci`×4, `no_pr`×4,
  `blocked`×2, `already_satisfied`×1), routed through the standing credit-artifact fold-line.

### RETRO-1786578394991 / RETRO-1786537819709 (2026-08-12) — the GAP-FILL window and the board/verdict-integrity & learning-loop cycle (12 + 27 PRs) — ★ TWO ENTRIES FOLDED TO ONE BY R29

★ **GAP-FILL (W1-T388–T410, 12 tasks / 12 PRs, 34 runs, $175.550, $14.63/shipped, turns 12/12 lit avg
99.706, peak W1-T406 $23.043/256t; 7 ledger-credited, and the 5 gate-side merges the W1-T51 union
rescued are exactly the 5 `blocked_*` runs).** Re-derived from an all-time marker BETWEEN two
already-logged cycles — **its dollars are not a trend point.** CREDITED: **W1-T393/#1521 (the
mutation-ratchet rung D-10, shipped with its `mutation.ratchet_verdict` call site UNWIRED — lifetime
N=0 begins here)** · T399/#1542 · T402/#1543 · T400/#1551 · T401/#1552 · T407/#1584 · T408/#1588.
UNION-RESCUED: T394/#1492 · T397/#1495 · T398/#1505 · **T406/#1559 (peak run)** · **T410/#1591, the
PLAN-STATE TRUTH RUNG itself, which fired BLOCKING on R18's own entry.** Uncredited remainder 22 runs /
$78.6, routed through the standing credit-artifact fold-line.

★ **BOARD/VERDICT-INTEGRITY & LEARNING LOOP (27 tasks / 27 PRs, $224.146, 0/64 `budget_usd` trips, peak
W1-T387 $15.477, 37 rejected trailers, turn column 46% dark — P40(i) RE-OPENED; first haiku row ever,
W1-T426/#1621 $0.295/62t).** **5 of 26 ledger-credited (19%)**, inside the metric's own range and
therefore UNATTRIBUTED (P43(ii)), not a collapse: T418/#1605, T416/#1607, T420/#1610, T422/#1612,
T424/#1614. Union-rescued 21: T364/#1417, T368/#1414, T371/#1425, T372/#1423, T373/#1424, T374/#1434,
T375/#1429, T376/#1430, T379/#1436, T380/#1437, T381/#1438, T382/#1453, T383/#1454, T387/#1442,
T409/#1597, T411/#1595, T413/#1602, T414/#1604, T415/#1606, T423/#1613, T426/#1621. ★ **PLUS ONE THE
UNION COULD NOT SEE, ADDED BY HAND: W1-T419/#1609** — merged on `main` with **no `Remudero-Task`
trailer at all** while #1617 on a foreign branch carried it: 27 tasks, not 26, and P47's completest
instance to date. The load-bearing ships: **T379/#1436 `rmd ledger-grep`, a union that FAILS LOUD when
no archive was read (P48(i) as a verb)** · **T409/#1597, the OFFLINE shipped/not-shipped contradiction
refusal that BLOCKED R18** · **T423/#1613, the golden-verdict fixture corpus** · **T419/#1609, the
citation loop — *the ship with no trailer*** · **T420/#1610, `learningDuplicateViolation` DARK by its
own admission** · **T415/#1606, `deriveStatus` DEFERS on a truncated board fetch** · **T383/#1454, the
drift-gated CAPABILITY SNAPSHOT generated into this very file** · **T413/#1602, P39's sanctioned no-op
exit** · T364/#1417, the cost-ceiling write control.

### RETRO-1785992364048 / RETRO-1785919636675 (2026-08-05 → 08-06) — the console tabs + governor wiring, then the daemon lanes + escalation quality (25 + 25 PRs) — ★ TWO ENTRIES FOLDED TO ONE BY R29

★ **CONSOLE TABS & GOVERNOR WIRING (25 tasks / 25 PRs, $391.379, 14 ledger-credited (56%) / 11
gate-side, peak W1-T336 $23.094/218t, 22 rejected trailers of which 12 FOREIGN across T314×6, T309×3,
T320×2, T324×1; four `diagnose` runs, none merged).** Governor wiring: T316/#1257, T317/#1259,
T321/#1277, T325/#1297, T329/#1306, T330/#1307, T331/#1310, T332/#1312, T333/#1321. Four-tab console:
T334/#1322, T335/#1323, **T336/#1324**, T315/#1325. Dispatch/plan integrity: T311/#1236, T318/#1263,
T319/#1270, T327/#1304. The gate's own false positives: T312/#1247, T313/#1249, T322/#1292, T328/#1305.
Preflight/flake/plan record: **★ T338/#1327 at $3.482/53t — the seventeen-rediscovery preflight
`maxBuffer` defect, the fix R15-1 pre-registered and R16 scored `HIT`** · T337/#1326 · T326/#1302 (the
cycle's only `docs`-class run) · T310/#1231.

★ **DAEMON LANES & ESCALATION QUALITY (25 tasks / 25 PRs, $223.251, 12 ledger-credited (48%) / 13
gate-side, turns lit 24 of 25 (2991), peak W1-T349 $27.118/151t, 10 rejected trailers of which 4 FOREIGN
all W1-T343 vs #1361).** Daemon lanes — **P19's parallel dispatch LIVE**: T339/#1329, T340/#1331,
T341/#1332, T342/#1340, **T343/#1363 (the task that cost 5 dispatches and 4 foreign rejections)**,
T344/#1365. Escalation quality: T345/#1368, T346/#1369, T347/#1371, T348/#1372, **T349/#1379
$27.118/151t**, T350/#1378, T354/#1385. The gate's own integrity: T351/#1380, T352/#1381, T353/#1389,
T359/#1399, **T362/#1404 — `base_unknown`, P48(i) in the affirmative**. Wiring dark organs + the plan
record: T356/#1393, T357/#1397, **T358/#1398 — `planHealthSweep` into the gather**, T361/#1403,
T363/#1410, T366/#1411, T367/#1412.

### RETRO-1785778396449 / RETRO-1785599040918 (2026-08-01 → 08-03) — accounts, dispatch integrity & the status board, then the gate/claim-integrity, credential & fix-rung cycle (16 of 25 then 10 of 25 ledger-credited; 47 tasks / 50 PRs) — ★ TWO ENTRIES FOLDED TO ONE BY R34

★ **R13 (…599040918): 16 of 25 CREDITED (64%)**, 9 gate-side (W1-T169/#987, T194/#990, T221/#978,
T265/#1022, T268/#1032, T272/#1044, T273/#1047, T279/#1062, T280/#1065); turns OMITTED not zeroed (3 of
25 nonzero, 294 of 321); costs **$153.196** of **$167.119**; 0/34 `budget_usd` trips, peak W1-T169
**$17.676**. ★ **R14 (…778396449): 10 of 25 CREDITED (40%)**, 15 gate-side (W1-T281/#1078, T286/#1106,
T288/#1192, T289/#1154, T290/#1156, T291/#1164, T293/#1169, T296/#1177, T297/#1179, T298/#1193,
T299/#1198, T301/#1202, T302/#1204, T304/#1209, T307/#1216); turns 19 of 25 nonzero (1466 of 1736);
costs **$161.095** of **$182.967**, the $21.872 remainder being 23 uncredited runs overwhelmingly
sibling re-dispatches (W1-T295 ×8, T288 ×6, T292 ×5); 0/48 trips, peak W1-T294 **$12.965**.
★ **ZERO no-op-close PRs — R13's pre-committed test on W1-T271/#1040 + T272/#1044 PASSED**, and
**R14's pre-committed effect test on that same pair PASSED**; neither P29(i) nor P39(i) closed with it.

- **R13's families** — THE ACCOUNT ARC 4 (W1-T265/#1022 · T266/#1024 · T267/#1026 · T268/#1032) →
  **$26.341** · **DISPATCH INTEGRITY 2, BOTH OPEN-PROPOSAL HALVES BUILT** (the lifetime dispatch cap no
  ledger step can reset, T271/#1040 = **P29(ii)** · the sanctioned `ALREADY_SATISFIED` exit, T272/#1044
  = **P39's dispatch-side half**) → **$12.136** · THE STATUS BOARD 4 (T279/#1062 · T280/#1065 ·
  T282/#1070 · T275/#1050) → **$36.278** · THE REVIEW GATE 4 (T274/#1048 · T273/#1047 · T277/#1052 ·
  T226/#983) → **$21.036** · OPERATOR & PLAN HYGIENE 7 (T169/#987 · T221/#978 · T276/#1049 ·
  T278/#1051 · T264/#1000 · T194/#990 · T284/#1073) → **$46.373** · **★ THE NO-OP REMAINDER — 1 task,
  4 PRs, $11.032, ZERO PRODUCT CODE** (T254 closed against work PR **#720**: #1007 → #1012 → #1015 →
  #1016), kept because it is the baseline R14's zero-reading is measured against; the honest count of
  tasks that changed product code is **21**.
- **R14's families** — REVIEW / CLAIM INTEGRITY 5 (W1-T304/#1209 · T305/#1213 · T307/#1216 ·
  T302/#1204 · T297/#1179) → **$43.236** · DISPATCH INTEGRITY 4 (T299/#1198 · T298/#1193 · T300/#1201 ·
  T296/#1177) → **$25.651** · THE CREDENTIAL FAMILY 3 (T292/#1174 · T293/#1169 · T289/#1154) →
  **$16.041** · CI PARITY 2 (T294/#1175 · T295/#1215, the task that cost **8 dispatches**) →
  **$15.728** · THE CLASS-C CONSOLE-PANEL BATCH 6 (T281/#1078 · T283/#1080 · T285/#1085 · T286/#1106 ·
  T287/#1150 · T288/#1192) → **$31.880** · STATUS BOARD + DIAGNOSIS 4 (T301/#1202 · T306/#1214 ·
  T290/#1156 · T291/#1164) → **$23.560**, plus **T303/#1208 $4.999/76t**, the second `diagnose`-typed
  run ever recorded.

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

### RETRO-1784512714705 / …556575522 / …626054083 (2026-07-19 → 07-21) — the knowledge holes, the W3 panel/console/intake lane and the console-instrument + ratification-inbox + governor cycle (28 + 21 + 23 merges) — ★ THREE ENTRIES FOLDED TO ONE BY R25

★ These three consecutive July cycles were already family-folded by R12/R14/R16; R25 folds their three
headers into one because the durable findings are three sentences and the ids/PRs/costs are all that
remained of the rest. **THE FINDINGS THAT SURVIVE:** (1) **28/28 of 07-19's merges were GATE-SIDE and
the run-verdict column was wrong every time** — the blackout that is still P30's ground truth, and
W1-T51/#97's union half is the sole reason those entries exist at all; (2) 07-20 posted **the first
non-zero credit column since R7 (13 of 21)**; (3) 07-21 recorded the **inversion that mined P35 (now
folded into P38): only 8 of 23 were ledger-credited and W1-T150/#358, the fix for exactly that, merged
FIRST.** Two live organs are named here and nowhere else: **W3-T8/#305's `panel-skill-run` POST route
is still unregistered** (a P38 instance now ten cycles old), and **T111/#373's approval telemetry has
read `0/0/0%` or a byte-identical constant every cycle since** (P40(ii)).

- **2026-07-19 (28 merges, ALL gate-side, $151.952):** the knowledge-hole family W1-T29–T40 →
  #216/#218/#220/#222/#224/#226/#228/#230/#232/#234/#236/#238 · $65.597 · 954t (W1-T29 took **×10
  redispatches before credit** — P29's exemplar; W1-T39/#236 the cycle's peak at $13.000/111t) · the
  fleet/quality remainder W1-T44/T46/T47/T48/T50 → #240/#245/#247/#249/#251 · $29.273 · 354t · the
  descriptionless trio W1-T132/T115/T108 → #282/#279/#274 · $21.179 · 159t · **W1-T1**, the task at the
  centre of the redispatch storm (~130 dispatches, ONE owned merge) → #255 · $1.985 · 32t · and the
  W2/W3 remainder W2-T3/#242, W3-T1a/#212, W1-T27/#204, W1-T97/T98/T102/T103 → #197/#199/#194/#196 ·
  $33.918 · 444t.
- **2026-07-20 (21 merges, 13 credited, $171.534):** the W3 panel + plan verbs W3-T5/#300 ($16.141/154t,
  the cycle's peak), W3-T8/#305 ($15.713/110t), W1-T45/#303, W3-T6/#302, W1-T43/#301, W1-T138/#345 ·
  the `rmd serve` console family W1-T139/T140/T141 → #334/#338/#346 · the intake lane
  W1-T41/T43/T55/T56/T57 → #291/#301/#310/#315/#314 · W3-T2 dashboard v0 → #294 · security/hygiene
  W1-T61/T66/T67/T131 → #320/#323/#324/#341 · triage/plumbing W1-T52/T53/T59 → #308/#309/#318 (**T52
  was the FIRST `diagnose`-typed run ever to reach calibration**).
- **2026-07-21 (23 merges, 8 credited, $247.388):** floor + verdict integrity W1-T185/#456, T178/#423,
  **T128/#414 — THE DEAD PROOF FLOOR, 101 of 126 runnable-dialect proofs that could never execute** ·
  the console/live-state family W1-T153/#376, T157/#405, T158/#410, T181/#411, T179/#431, T154/#388,
  T155/#365, T156/#398, T187/#445 · **the P25 ratification inbox end to end** W1-T110/#368, T111/#373,
  T192/#457 → ★ **P25 CLOSED** · credit + the plan-PR emitter W1-T150/#358, T136/#437, T119/#382 ·
  layered knowledge + the governor pair W1-T145/#360, T146/#371, T121/#385, T122/#386.
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

## Calibration (observed — current R45 first; prior-cycle evidence follows)

**RETRO-1788401594504 (2026-09-03) — observed task-type calibration.** This is the deterministic gather's table, retained as an observed routing input; zero turns means no usable turns/merge measurement, not zero effort.

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | 9 | 2 | $4.051 | 0 | $36.456 |
| triage | 1 | 0 | $0.000 | 0 | $0.000 |

**Prior-cycle calibration — through RETRO-1788374498685, 2026-09-02.**

The empirical baseline **mounts.yaml (W1-T5, shipped #42; risk/class routing since W1-T167/#606)** and
Flight-control burn-rate signals (§4B Layer 1, BUILT — W1-T20/#132) key off.

**★ THE WHOLE `implement` ROW STILL PUBLISHES `UNMEASURED` AND THE MOUNT TABLE STAYS FROZEN — AND THE
RELEASE CONDITION IS NOT MOVED THIS CYCLE.** R43 attached it to **P65's CHANGED-FILES CLASSIFIER** on
the argument that P65's class had never read zero. **This cycle tests that argument at its weakest:
P65 falls 12 → 5 and does not reach zero.** The condition holds and R44 leaves it alone — moving a
release condition on the cycle that stresses it is the same error as re-cutting a band on the cycle
that flatters it. The row is UNMEASURED because its population is ONE AUTHORING LANE: this window that
lane authored **20 of 57** in-window merges, while an un-instrumented lane authored **five source
merges** beside it — one of which (#3637) wired a symbol this document had called dark for sixteen
cycles.
**★ AND THE LEDGER'S `merged` COLUMN FELL TO THREE OF ELEVEN**, so the rates below are computed over a
column that fired for 3 of the 10 tasks that actually shipped. **Seven of the ten union ships were added
gate-side by the Discrepancies resolver on runs the ledger had called `blocked_ci` — and all seven are
also `verification` rows in the MAST census (DR-28).**

**★ CURRENT BASELINE — this cycle (RETRO-1788374498685, task range W1-T2613–T2629). This is the row
W1-T5's mount table WOULD key off. The first table is the GATHER'S OWN OUTPUT, printed exactly as
produced; the second is the row as this plan PUBLISHES it after the pre-committed rules fire:**

*As the gather produced it:*

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| diagnose | 1 | 0 | $5.415 | 0 | $5.415 |
| implement | 10 | 3 | $5.678 | 16.1 | $56.785 |

*As published (and NO mount may be re-based on it — the table is FROZEN until P65's classifier ships):*

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | **UNMEASURED** (10 of 11 declared runs; the other row, `diagnose` at n=1, is the SAME run as the `docs` class row — one event wearing two labels. The run lane authored only **20 of this window's 57 merges**, so the population is a LANE and not the fleet — **P65, DR-25**) | **UNMEASURED** (ledger **3** · union **10** · hand-verified **20** in-window `run-W1-*` merges · **TEN credited by nothing, every one with a named mechanism** — six malformed epochs, two straddlers, two DAEMON fix-rung branches) | **UNMEASURED** ($5.655 over 11; **$20.733 per ledger-credited ship, $6.220 per union ship and $3.110 per hand-verified run-lane merge — three prices from ONE window spanning 6.7×, and DR-25 forbids quoting any of them without naming the lane**) | **UNMEASURED — 20% COVERED** (16.1 over 10 runs; the gather stamps `turns/merge` and `output tokens/merge` **`⚠ 20% coverage — DO NOT USE`** on `src` and **`⚠ 0% coverage — DO NOT USE`** on `docs`) | **UNMEASURED** ($62.200 — of which **$5.359 / 8.6% bought no merge the gather can see, and this rung's own REST read shows that PR (#3692) MERGED ten minutes after the gather's newest row**, so the residue is not merely in flight, it had already landed; published under the same P43(ii) noise-band rule that forbade reading 7.7% as a fix) |

**BY TASK CLASS — the W1-T167 routing question (is the class-routed mount discount paying off?).
★ THE CONTRAST ROW SURVIVES A SECOND CYCLE AND FLIPS SIGN: LAST CYCLE'S 100% FALSE POSITIVE IS THIS
CYCLE'S 0% FALSE NEGATIVE, ON A CELL OF SIZE ONE WHOSE SINGLE MEMBER MERGED. Thirty-three cycles have
produced nine contrast rows and none has ever reached n=5:**

| task_class | runs | merged | merge rate | avg $ | avg turns | total $ | output tokens | merge source | turns/merge | output tokens/merge |
|---|---|---|---|---|---|---|---|---|---|---|
| src | 10 | 3 | **30%** ⚠ = 3 ÷ 10 on the LEDGER's numerator, while the union credits **9** of the same 10 = **90%**; against the 20 hand-verified in-window `run-W1-*` merges the union reads **50%** — three ratios, and the RAW 50% is the registered band reading | $5.678 | 16.1 ⚠ **20% covered — 2 of 10 runs carry a turn count** | $56.785 | 100729 ⚠ same coverage | shipped (n=9) | 17.889 ⚠ **STAMPED `20% coverage — DO NOT USE` BY THE GATHER ITSELF** — printed and left unscored; **no identity is banked** (DR-2) | 11192.111 ⚠ same shape, same stamp |
| docs | 1 | 0 | **0%** ⚠ **A FALSE NEGATIVE: the one member (W1-T2625) MERGED as #3672**, gate-side, after its fix rung named and refused an out-of-scope `docs/docs-index.json` regeneration (P63). The same cell published 100% last cycle and was a false positive then | $5.415 | 0 | $5.415 | 0 | shipped (n=1) | 0 ⚠ **`0% coverage — DO NOT USE`, the gather's own words** | 0 ⚠ same stamp |

**BY MODEL CLASS — weekly-limit burn (W1-T250/#898; P34 clause (d): burn is share of the weekly LIMIT,
never imputed dollars — the dollar column is context only). The `share` column sums to one for a fifth
consecutive cycle, so P48's share-column site STAYS CLOSED:**

| model | runs | turns this week | share of weekly burn | $ this week (context only) |
|---|---|---|---|---|
| sonnet ⚠ **G-17 reports `model` present on 18 of 202 implement rows and absent on 184** — this row names a model for a population that is 91.1% unattributed (**P53**), **and the attributed count has now been FROZEN AT 18 FOR THREE CONSECUTIVE CYCLES** (15 → 17 → 18 → 18 → 18 → 18) | 161 ⚠ **arithmetically identical to this window's own turn mass** (16.1 avg × 10 implement runs), the **THIRD consecutive cycle on a THIRD distinct value** — 224 = 224, 172 = 172, 161 = 161. DR-2 forbids banking ONE identity; three in a row on three different numbers is not one coincidence, and **this column renders THIS WINDOW, not a week** | 99 runs | 100.0% | $484.589 ⚠ ~7.8× this window's $62.200, so it is neither the window nor a running total |
| haiku ⚠ **BYTE-IDENTICAL to last cycle — 2 runs / 0 turns / $3.324** — after returning from a ten-cycle absence; a frozen row is a membership question (rule 18) and still not an answer | 2 | 0 | 0.0% | $3.324 |
| unresolved ⚠ **CLIMBED A FOURTH CONSECUTIVE CYCLE** (11 → 1 → 2 → 3 → 4 → 5 → **6**) — R38-4's HIT arm holds: these rows are a RECOMPUTED population, not a frozen rendering | 6 | 0 | 0.0% | $0.000 |

**★ THE ARCHITECT-LANE SHARE (G-17's capability half, W1-T2239) — 1 row / $8.97 / 0.8%** of a
**211-row / $1158.04-notional** corpus (was 0 / $0.00 / 0.0% of 211 / $1130.90). **`inbox_draft`
returns 0 → 1, and that single row carries `claude-opus-5×1` — the FIRST Architect-lane row in this log
that carries a `model` key at all.** `retro.synthesized`, `triage.synthesized` and `plan.synthesized`
read zero for a **FOURTEENTH** consecutive cycle (**P53** — no emission call site). **R43-6 MISS**:
`inbox_draft` moved alone again, this time upward. **★ P54's MECHANISM CONFIRMS A SECOND TIME AND NOW
RUNS BOTH WAYS:** the corpus start advanced **2026-08-26T14:54:02.128Z → 2026-08-26T20:32:35.960Z
(+5.64 h)** over a **6.92-day** span while the row count HELD at 211 and the notional total ROSE
**$1130.90 → $1158.04** — rows aged OUT and IN inside one window, which a `HISTORICAL` label cannot
express. `implement` carries 202 rows / $1141.05 (`sonnet×18`, unattributed×184); `review.reviewer`
grows to **8 rows, `sonnet×8`**, still the only fully-attributed lane. Every `$` there is NOTIONAL /
API-equivalent price on a subscription install, never billed spend. `assertArchitectAboveWorker` keeps
throwing on a same-or-lower-tier Architect regardless, and **no mount row moves on this reading.**

**Prior cycles (FOLDED — trend only; ledger-merged first, real ships in parentheses):** **R36–R43
FOLDED BY R44** (9–29 runs / 0–20 merged (6–24 ships), $3.710–$6.506/run, turn column 39% → 22% → 0% →
14% → 22% → 27% → 21% ⚠) · **R34–R35 FOLDED BY R36** (33 runs / 14 merged (27 ships), $5.148–$5.938/run,
26.4–45.9t ⚠) · **R32–R33 FOLDED BY R35** (42 runs / 10 merged (22 ships), $4.547–$5.493/run,
14.8–41.2t ⚠) · **R20–R31 FOLDED TO ONE LINE BY R33** (353 runs / 111 merged (311 ships),
$3.338–$6.775/run, 0–71.1t ⚠) · **R17–R19 FOLDED BY R26** (144 runs / 24 merged (64 ships),
$3.502–$6.268/run, 3.8–99.7t) · **R11–R16 FOLDED BY R25** (366 runs / 76 merged (216 ships),
$3.812–$8.327/run, 7.8–116.2t) · **R8–R10 FOLDED BY R24** (248 runs / 21 merged (72 ships),
$1.258–$10.650, 14.7–86.6t — R8 churn-poisoned by the W1-T1 spin loop and never to be re-based on) ·
**R1–R7 FOLDED BY R15** (91 runs / 47 merged, $1.838–$5.794/run, 21.4–72.2t — pre-fleet).
*(⚠ = turn column dark, sub-40% covered, or fully covered and arithmetically wrong; do not use.)*
**Derived all-time:** ~1348 runs, ~602 merged.

**Reads:**
- **★ THE READ R44 ADDS, AND IT IS ABOUT WHAT A VERDICT MEANS.** The MAST census reports
  `verification` × 8 — one row per `blocked_ci` verdict — and **seven of those eight tasks are in this
  cycle's SHIPPED list, merged gate-side**; the eighth merged ten minutes past the gather's newest row.
  **The failure distribution has no confirmed member.** R43's read was about WHEN the harness looks
  (P67, DR-27); R44's is about WHAT IT CALLS WHAT IT SAW: **a verdict class is not a failure class until
  you check which of its members merged** (**DR-28**). Both defects share a cause the calibration table
  cannot fix from inside itself — every column here is a projection of the verdict column, so a verdict
  column that is wrong 7 times in 8 makes this table wrong in the same places.
- **★ THE PRICE BRACKET WIDENS TO 6.7× BECAUSE THE `merged` WRITER STOPPED FIRING.** $62.200 over the 3
  the ledger credits is **$20.733**; over the 10 the union credits, **$6.220**; over the 20 hand-verified
  in-window `run-W1-*` merges, **$3.110**. Last cycle the same three figures collapsed to two within
  17%. **The spread is a property of the WRITER, not of the work** (**P47**, DR-25).
- **★ THE CREDIT BAND RE-ENTERS AT 50% AND THE REFUSAL TO RE-CUT IT IS VINDICATED IN ONE CYCLE.** 39%,
  33%, 53%, 29%, 56%, 50%, 59%, 66.7%, 47.1%, 9.5%, 20.5%, 0%, 50%, 100%, now **50%** (10 of 20 raw;
  10 of 14 = 71% on P64's clean denominator, which is NOT the registered reading because excluding the
  malformed-epoch class flatters the resolver on a defect of this document's own reading). **R43 held
  the band through its only exit above; the very next window came back inside it.**
- **★ THE RESIDUE HAD ALREADY LANDED.** $5.359 / **8.6%** bought no merge the gather can see — and the
  PR behind it (#3692/W1-T2623) merged at 18:46:25Z, ten minutes past the gather's newest row. The
  series 86% → 64% → 52% → 47.6% → 14.7% → 59.9% → 93.1% → 64.7% → 100% → 7.7% → 15.0% → **8.6%** spans
  92 points with no monotone trend: **a NOISE BAND, not a trajectory (P43(ii))**.
- **★ TURN COVERAGE LANDS EXACTLY ON R43-4's FLOOR AND THE WEEKLY IDENTITY HOLDS A THIRD TIME.**
  Coverage across twenty-six windows: 100% → 4% → 29% → 79% → 28% → 47% → 11% → 19% → 0% → 2% → 18% →
  4% → 7% → 6% → 17% → uncovered → uncovered → 39% → 22% → 0% → 14% → 22% → 27% → 21% → **20%**. The
  tie-break is stated before the score: **at the floor is a HIT, below it is a MISS — R43-4 HITS on the
  boundary and the floor is NOT re-cut.** **No identity may be banked** (DR-2) — but 16.1 × 10 = **161**
  is exactly the weekly row's `turns this week`, the THIRD consecutive cycle and the third distinct
  value. **TASK D is no longer a retention question; the column renders one window.**
- **★ MAST distribution (W1-T89/#710): verification 8 (+4), everything else 0, unmapped 0** — and the
  zero unmapped share is **an absence of input, not a mapping**: the verdict MIX collapsed to `merged`
  and `blocked_ci` only, so `incomplete` had no row to fail to map (a TWENTY-FIRST cycle; **P42's single
  cheapest entry is still the `incomplete` row of `plan/mast-mapping.yaml`**). **★ AND SEVEN OF THE
  EIGHT `verification` ROWS ARE NOT TASK DEFECTS AT ALL** — they are this cycle's gate-side merges
  (DR-28).
- **★ GUARD-FIRED BLOCKS: NONE, so TASK N's population is EMPTY A THIRD CONSECUTIVE TIME.** The row
  cannot fail this cycle, which is recorded rather than scored (**P48**); `proven`, the value P41's
  retirement bar is written in, is still emitted by no code path.
- **★ THE $100 `budget_usd` TRIPWIRE IS VERIFIABLE FOR THE WHOLE POPULATION A TWELFTH TIME.** Peak
  observed run **$11.615** (W1-T2620), 8.6× under. **★ AND P52's $0.001 STORM FAILS TO REPRODUCE A
  THIRTEENTH TIME** (floor $2.894).
- **A retro must not average over a spin loop** (R8's lesson); **nor over a window whose merge set it
  has not verified** (R20's inverse); **nor over a window whose own gather contradicts itself between
  sections** (R21's); **nor over a run set whose SIZE it has not verified** (R22's); **nor over a window
  whose BOUNDARY CLOCK is unstated** (R23's); **nor over a population a third of which is one
  infrastructure event wearing three labels** (R24's); **nor over a population that EXCLUDES three of
  its own window's ships** (R25's); **nor over a population MISSING THIRTEEN of its own merges**
  (R26's); **nor over a population 44% of which never reached a task** (R27's); **nor over a population
  PARTITIONED BY A KEY 99% OF IT DOES NOT CARRY** (R28's); **nor over a CORPUS THAT WAS SMALLER THIS
  CYCLE THAN LAST** (R29's); **nor over a population whose SIZE THE SAME DOCUMENT STATES TWICE,
  DIFFERENTLY** (R30's); **nor over a population whose SPEND AND TURN COLUMNS CONTRADICT EACH OTHER**
  (R31's); **nor over a population whose CREDITED SET CONTAINS A MERGE THAT IMPLEMENTED NOTHING**
  (R32's); **nor over a population whose REFUSALS ARE FILED UNDER A NAME NONE OF THEM ANSWERS TO**
  (R33's); **nor over a population that got smaller without anyone checking where the missing members
  went** (R34's); **nor over a population that contains work the harness's own rules made impossible to
  finish** (R39's); **nor over a population assembled from branch names, a quarter of which name no run
  at all** (R40's); **nor over a population drawn from ONE AUTHORING LANE while a second lane ships
  source into the same `main`** (R41's); **nor over a population whose members another agent may
  already be building** (R42's); **nor over a population read ONCE, at merge time, by instruments that
  never look at the trunk again** (R43's); **and R44 adds the one that indicts the verdict column
  itself: nor over a population whose FAILURE CLASS is seven-eighths composed of work that shipped.**
  **P29(iii)** (annotate credit-rejected runs before they reach the mount table) is still unbuilt — and
  for a second cycle there were no credit-rejected runs to annotate, which is P48's shape, not repair.
## Retro proposals (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)

**★ LIVE RANKING (the ONE place open proposals are ordered — and since R42 the ONLY one; the duplicate
`NEXT (L2)` ranking in NET STATE was DELETED, not folded).** `P47 > P67 > P68 > P65 > P66 > P64 > P63 >
P62 > P57 > P60 > P61 > P56 > P58 > P59 > P40 > P43 > P53 > P54 > P48 > P50 > P52 > P38 > P49 > P55 >
P33 > P42 > P46 > P39 > P45 > P44 > P26`

**★ R45 RETRO PROPOSALS — FAILURE MINING (PROPOSALS ONLY): no new proposal minted this cycle; highest prior was P68.** The four gate-side `blocked_ci` merges route to **P47**'s credit golden, rather than a second credit id. The actionable remedy-bound cases, W1-T2630 (`docs/docs-index.json`) and W1-T2633 (`scripts/source-size-baseline.json`), route to **P63**'s existing gate/scope golden: seed a required check whose prescribed remedy is outside `files:` and require a declared-scope widening or dedicated companion task before counting it as a task failure. The two containment denials are host signals, not proposal members.
*(**ONE MOVE. P68 is R44's mint and enters at rank 3**, directly beneath P67 and above P65. The
placement argument is about WHERE THE COST LANDS, not about size: **P65 and P66 concern work the
instruments cannot SEE; P67 concerns a fact the instruments saw and read too early; P68 concerns work
the harness PAYS FOR TWICE and can already read in its own harvest prose.** It sits BELOW P67 because
P67's error corrupts the calibration table that routes every mount, while P68's cost is bounded to recon
turns on the runs it hits — but it sits ABOVE P65 because it is the only entry in the top four whose
population is enumerable TODAY, from text the gather already prints. **P65, P66, P64, P63, P62, P57,
P60, P61, P56, P58 and P59 each shift one place with no change in their own standing.** **No rank is
argued from a level** — not from P68's five members, and not from P65's fall to five.)*
**P17 LEFT THE RANKING 2026-08-20 — W1-T71 SHIPPED (#2182)**. **P29 LEFT THE RANKING 2026-08-07** —
both clauses shipped in #349; the tombstone below keeps only the durable lessons. Every proposal has
exactly ONE canonical entry below, updated IN PLACE with each cycle's evidence — a retro that adds a
second entry restating a proposal it did not change has failed the HARNESS-COMPRESSION bar.
**P28 and P41 are RETIRED** (tombstones only, full prose deleted); **P29 is CLOSED — shipped, not
abandoned**; **P35 is FOLDED into P38**; **P51 stays FOLDED into TASK G** (tombstone only, moved there with TASK L 2026-09-02).
**★ R44 MINTS EXACTLY ONE PROPOSAL. MINTED P68; THE HIGHEST EXISTING HEADER WAS P67, SO THE NEXT UNUSED
ID WAS P68 AND IT IS NOW TAKEN.** The mapping is reported rather than assumed, because the discipline is
the same one `rmd next-task-id` applies to W1-T### ids, and the #125/#118 P21 collision is what it
exists to prevent. **Why P68 EARNED a mint where six other findings did not:** every existing entry in
this list is about what happens to work AFTER it is done — whether the merge was seen (P47, P56–P66),
whether the reading was taken at the right time (P67), whether the measurement's population is the right
one (P53, P54, P65). **P68 is the first entry about the INPUT to the work.** Half of this cycle's runs
reconned a task whose record they never received, and each of them spent turns rediscovering scope that
already existed in a file — while the other half report the record arriving intact and the recon
finishing in one pass. **A dispatch path that delivers the task record to five of eleven workers is not
a quality problem in the workers; it is a defect in the dispatcher, and it is legible only in prose no
instrument here parses.**
**The test each other finding failed, stated rather than asserted:** *seven of eight `verification` rows
had already merged* → **P47** plus the standing credit-artifact fold-line, and a DECISION RULE
(**DR-28**) rather than an id, because the cause is the verdict writer this list already tracks;
*the `docs` row flipping from a 100% false positive to a 0% false negative on a cell of size one* →
**P47** again, with the contrast-row bound restated in the Calibration section — an n=1 cell that is
wrong in both directions in consecutive cycles is not a new defect, it is the same writer seen twice;
*six malformed run-branch epochs, two of them SECOND-precision and one dated past its own merge* →
**P64**, whose bar this is, scored as R44-6 and given a shape it never named rather than a new id;
*two lanes filing and merging the same `W1-T` id 45 minutes apart* → **P66**, its own bar, scored as
R44-7 at TWO members after a fully-read zero; *two fix rungs racing on one defect within minutes* →
**P62**, two self-reported members; *a docs task blocked by a `docs/docs-index.json` regeneration its
declared scope forbade* → **P63**, exercised exactly as written; *the promotion judge scoring a fourth
different value on an unchanged entry* → **P38**; *the G-17 corpus holding at 211 rows while its start
advanced 5.6 h and its total ROSE* → **P54**, whose mechanism this confirms a second time and in both
directions.
**NO NEW TASK LETTER: the live letters are A–K and M–N, and the next unused is O.** P68's remedy is a
DISPATCH-PROMPT FIELD and a LEDGER MARKER, not a lane.
**NO RATIFICATION THIS CYCLE**, and no un-park.
**★ THE PRE-COMMITTED CONSEQUENCES: FOUR HIT, ONE OF THEM ON A DECLARED BOUNDARY, TWO MISSED, ONE WENT
UNRESOLVABLE BY THIS RUNG’S OWN OMISSION, AND THE ONE THAT DID NOT FIRE IS RE-REGISTERED FOR A FOURTH
TIME (DR-26). The rows are scored in full in §9’s pre-registration block; the dispositions are:**
**R43-1 — HIT:** P65's class fell 12 → **5** and did not reach zero, so the mount freeze's
release condition, moved onto it by R43, survives its first stress test and **is not moved again.**
**R43-2 — HIT, and it settles a question DR-18/DR-19 left open:** TASK G's population went
0 → **10**, and every member is accounted for by name. A class that empties for one window has not
closed, and the two rules that forbade deleting it were right within a single cycle.
**R43-3 (itself R42-3) — HIT; ITS CONSEQUENCE DID NOT FIRE AND IS RE-REGISTERED VERBATIM AS R44-3, A FOURTH TIME:** the clause
says a second consecutive `merged`=0 cycle replaces the credit band with a gate-side/ledger split. The
ledger wrote `merged` three times. **DR-26 is exactly why this is carried rather than dropped**, and the
temptation is now stronger, not weaker, because the writer is visibly degrading (12 → 3) without ever
reaching zero.
**R43-4 — HIT ON THE DECLARED BOUNDARY:** turn coverage reads **20%** against a floor of 20%. The
tie-break is stated before the score and not after: **at the floor is a HIT, below it is a MISS.** The
floor is **NOT re-cut on the cycle that grazes it.**
**R43-5 — MISS, the twelfth consecutive:** `0 added` at 79 entries for a twenty-second cycle.
**R43-6 — MISS:** `inbox_draft` moved alone again, 0 → 1, while the other three `step` keys
held at zero.
**R43-7 — HIT:** P66's bar takes TWO direct members (#3687/#3688 on W1-T2717, #3682/#3684 on
W1-T2711) one cycle after a fully-read zero.
**R43-8 — UNRESOLVABLE, by this rung’s own omission and named as such:** P67's practical test asks for
`main`'s REQUIRED check state after every in-window merge. Two `fix/*` merges landed in this window
(#3677 `fix/wake-spin-guard-falsifier`, #3683 `fix/the-size-ratchet-test-must-not-write-the-real-baseline`)
— the exact shape of P67's founding repair — but this rung did NOT read the trunk's check state after
each merge, so it cannot say whether either repaired a red it did not cause. **An unread check is not a
green one** (P48).
**★ PRE-REGISTERED FOR R45, AND SET OUT IN FULL IN §9 (each requires something to have MOVED — DR-14):**
**R44-9 (P68's own bar):** at least THREE of next cycle's runs must again self-report a missing task
record in their harvest prose, or a ledger marker must exist that counts them. If the class reads zero
AND no marker exists, the zero is P48's shape and is recorded, not scored; if it reads zero WITH a
marker, P68 folds into P46.
**R44-2 (TASK G's accounting):** every uncredited in-window `run-W1-*` merge must again be assigned a
NAMED mechanism. If even one is unaccounted, this cycle's complete partition was a coincidence and TASK
G is re-scoped rather than reported.
**R44-3:** the R42-3/R43-3 clause, verbatim, its FOURTH registration.
**R44-4:** turn coverage floor stays at **20%**; a reading below 20% is a MISS and the floor is not
lowered to meet it.
**R44-5:** an entry must be ADDED to LEARNINGS at any layer, or the row is a THIRTEENTH consecutive MISS.
**R44-1/R44-2 (P64's widened arm):** the malformed-epoch class must be read against the FULL REST merge census
again. A zero counts only if the census was actually read; a zero from a gather absence is P48.
**TASK D's terminal arm (recorded, not a numbered row):** a FOURTH consecutive equality between `turns this week` and the
window's own turn mass RETIRES the retention framing outright and the column is declared a rendering
defect in the BY MODEL CLASS table, with the fix filed as a task.
**★ THE STANDING CREDIT-ARTIFACT FOLD-LINE (one home, replacing six cycles of per-cycle
restatements).** In every retro from R8 on, the dominant "failure" verdict classes — `blocked`,
`blocked_ci`, `no_pr`, `incomplete`, `pr_attribution_failed` — have been predominantly WRITE-SIDE
CREDIT ARTIFACTS, not task defects: the work merged gate-side and the ledger did not record it.
R8 0-of-28 credited · R9 13/21 · R10 8/23 · R11 20/94 · R12 4/25 · R13 16/25 · R14 10/25 ·
R15 14/25 · R16 12/25 · R17 5/27 · R18 7/12 · R19 12/25 · R20 8/30 · R21 9/31 (19 by union) ·
R22 10/31 (18 by union) · R23 10/30 (17 by union) · R24 10/40 (29 by union) ·
R25 21/33 (27 by union) · R26 14/31 (25 by union) · R27 17/31 (17 by union) · R28 18/28 (20 by union) ·
R29 14/27 (14 by union) · R30 7/18 (12 by union) · R31 4/12 (9 by union) ·
R32 8/15 (14 by union, **one of them FALSE** — 13 of 13 on code merges) ·
R33 2/7 (3 by union) · R34 5/9 (12 by union) · R35 9/18 (15 by union) ·
**R36 10/17 (13 by union)** · **R37 10/15 (11 by union)** ·
**R38 8/17 (10 by union) — and the honest row is that the artifact's residue went from its SMALLEST
ever ($8.404, 14.7%) back to a MAJORITY ($62.147, 59.9%) in one cycle without any mechanism changing:
the two gate-side rescues failed and were caught exactly as before, and what moved was the
DENOMINATOR — nine of twenty-seven runs were repeats of three tasks (P62), and seven merges on run
branches were credited by nothing at all** *(R42 note: the two lines duplicated verbatim here since
R38 are DELETED — a paste artefact this document's own instruments read as corpus, R37's defect
committed by the prose describing it)* ·
**R39 2/21 (8 by union) — THE LOWEST READING IN THE SERIES BY A FACTOR OF THREE, and it is the first
one the fold-line's own claim does not cover: 17 of 23 runs ended `blocked_ci` and SIX of those merged
gate-side (the artifact, exactly as described), but FIVE were genuinely stuck on a remedy their declared
scope forbade (P63), which is not a write-side artifact at all.** ·
**R40 8/39 (21 by union) · R41 0/17 (6 by union) · R42 6/19 (9 by union) · R43 12/14 (14 by union) · R44 3/10 (10 by union) — and R44 is the series’ sharpest reading in twenty-three cycles: SEVEN of the ten real ships were added gate-side on runs the ledger called `blocked_ci`, and all seven are also rows in the MAST `verification` census, so the artifact this line has tracked since R8 now demonstrably manufactures a FAILURE TAXONOMY as well as losing credit (DR-28). R43 was the series’ first CEILING —
and R43 is the series' first CEILING: every merge the run lane made was credited, so the artifact this
line has tracked for twenty-two cycles has, in this one window, no members at all. That is P48's shape
and not the line's repair; the SAME window's four `blocked_ci` verdicts include one (W1-T2604) whose
blocking check was another task's merged regression (P67), which is a failure class this line was never
built to see.** Each row is the
GATHER's credit count against the window's REAL ship count. They are
therefore NEVER re-mined as classes — doing so manufactures many proposals from one root cause, the
accretion failure mode P8 named. They route to **P29/P30/P33/P39/P47/P57** and, for the reading defect,
**P38**. A future retro adds evidence to THIS line, never a new bullet. *(The series spans EIGHTEEN
cycles and ranges 0%–64% with no monotone trend — a NOISE BAND, not a trajectory. That is P43(ii), and
it is why R14 refused to call 40% a regression, R15 refused to call 56% a fix, R25 refused to call 64%
a victory, R26 refused to call 45% a regression, R27–R31 refused to read their band-HITs as movement in
either direction, R32 refused to call a twenty-point rise progress — **and R33 refuses by exactly the
same argument to call a twenty-four-point fall decay. A band cannot be evidence of health on the way up
and evidence of decay on the way down.**)*
  **★ MEASURED READINGS — FOLDED TO THREE LINES BY R44 (git holds the per-cycle arithmetic).**
  R18–R32 span **38%–83%** with R20 bounded and R27–R29 uncomputable; **R33 UNCOMPUTABLE on rule 6** — a
  numerator and a denominator drawn from two different populations do not make a percentage, so that
  cycle published no number rather than a flattering or a damning one. **All prior readings remain
  FLOORS**, and the instruments that would make the row exact are still TASK H, TASK K and P57’s label
  split (TASK L was folded into TASK G by R43 and is no longer one of them).
  **★ THE STANDING BOUND ON VIVID DEFECTS (2026-08-07, kept because the temptation recurs; R20's
  per-cycle restatement of it FOLDED IN by R24).** The uncreditable-branch defect W1-T390 files is RARE
  AND CLUSTERED, not ambient — 2 slug-form branches among 37 merged `run-*` over #1341–#1451 — so **no
  retro may cite it as this band's cause**: two PRs cannot account for fourteen cycles of spread, which
  is exactly the unattributed-cause error P43(ii) forbids. What earns that task is the FAILURE MODE
  (credit lost PERMANENTLY, no self-correcting path), not the frequency. **Every large lost-merge count
  since (R20's sixteen, R23's eleven, R24's eight) rides WELL-FORMED `run-<task>-<ts>` branches**, so
  none of them is W1-T390's slug-form defect wearing a bigger number; they are separate mechanisms
  sharing the same failure MODE, and citing any of them as evidence for W1-T390's FREQUENCY is the
  error this bound exists to forbid.
**RETRO-1788374498685 (R44, this cycle)** — mined from 11 runs DECLARED in scope / **57 merges
IN-WINDOW, hand-verified over REST: 20 on `run-W1-*` (TEN union-credited, THREE ledger-credited, TEN
credited by nothing and every one of those named), 1 on `run-RETRO-*` (#3639), 0 on `run-APPROVE-*`, 36
hand-named of which FIVE change `src/` or `test/`** (`merged`×3, `blocked_ci`×8; **NO guard-fired
block**).
**ONE new P-number: P68 is MINTED (the highest prior header was P67).**
**NO task letter minted; the live letters are A–K and M–N.** **STANDING: candidates are ratified by the
Architect via a tasks.yaml PR — this PR is plan-only and files none.**

- **★ THE HEADLINE — THE FAILURE CENSUS IS 87.5% WRONG, AND ITS ERROR RUNS ONE WAY.** The MAST
  distribution reports **`verification` × 8, +4 on the prior cycle** — one row per `blocked_ci` verdict.
  **Seven of those eight tasks are in this cycle's own SHIPPED list as gate-side merges**:
  W1-T2613/#3651, T2617/#3661, T2618/#3662, T2620/#3673, T2621/#3680, T2625/#3672, T2629/#3681. The
  eighth, W1-T2623, holds **#3692, which merged at 18:46:25Z — ten minutes after the gather's newest
  ledger row** — so it is a straddler, not a failure either. **The failure distribution has NO confirmed
  member.** No proposal is minted: **P47** owns the credit surface these instruments read from and the
  standing fold-line owns the series. What is minted is a rule. **DR-28: a verdict class is not a
  failure class until you check which of its members merged.** The MAST census's only input is the
  verdict column, so it will restate that column's errors as a taxonomy for as long as that is true —
  and this cycle it published a taxonomy of eight failures in a window that had none.

- **★ THE `blocked_ci` MINING FINALLY HAS A JOIN, AND IT DISSOLVES ITS OWN POPULATION — TASK H.** For
  three cycles the gather carried no per-run fix-rung text and the eight `blocked_ci` verdicts could not
  be mined. This cycle a different join answers the question: **seven of the eight appear in SHIPPED**,
  so the mining target was never the verdicts, it was the WRITER. **The one genuinely unresolved
  `blocked_ci` this cycle is W1-T2625's** — whose fix rung DID leave text, three times, naming
  `docs/docs-index.json` as the remedy and refusing it as *"outside this round's authority to do
  unilaterally"*. **That is P63, exercised verbatim**, and it merged gate-side anyway.

- **★ THE VERDICT CENSUS COLLAPSED TO TWO LABELS FOR A SECOND CONSECUTIVE CYCLE, WHICH IS AN ABSENCE OF
  INPUT AND NOT A REPAIR.** `merged`×3 + `blocked_ci`×8 = 11, with no `incomplete`, `no_pr` or
  `blocked_containment` row. **P42's `incomplete` mapping is therefore unexercised a TWENTY-FIRST
  cycle** — the cheapest unwritten line in `plan/mast-mapping.yaml` is still unwritten and still cannot
  be tested.

- **★ THE GUARD-FIRED BLOCK — NONE, SO TASK N's POPULATION IS EMPTY A THIRD CONSECUTIVE TIME.**
  Recorded with its mechanism, never as "no containment defects" (**P48**). Mutation gate `N=0`
  (twenty-seventh cycle) and replay *no run recorded* (twenty-second) are the same shape.

- **★ THE PLAN-HEALTH SWEEP RETURNS W1-T49 ALONE, A TWENTY-FIRST CYCLE.** Declared-scope, unfixed.
  **PROPOSED CORRECTIVE TASK (not filed):** give W1-T49 a `files:` list naming at least one
  repo-relative path, so it stops being fail-closed against every co-dispatched candidate at the
  dispatcher. Origin: `retro#plan-health`.

- **★ THE LEARNINGS-JUDGE MINING (P38) — A FOURTH SCORE ON ONE UNCHANGED ENTRY, WITH A REVERSAL INSIDE
  IT.** `body-fetch-guards-on-http-not-size` reads **promoted 0.78 (R41) → promoted 0.87 (R42) →
  declined 0.80 (R43) → declined 0.85 (R44)** on evidence nobody has touched. Meanwhile
  `askuserquestion-auto-resolves-empty-headless` is promoted at **0.78** after being promoted at
  **0.72** one cycle ago, and **two of three declines (0.85, 0.88) again score ABOVE the promotion.**
  **PROPOSED, NOT WRITTEN:** ratify `askuserquestion-auto-resolves-empty-headless` at `user-overall`
  by landing it in a reviewed PR. The three declines stay declined, each for its own stated reason.

- **★ THE CREDIT MINING HAS TEN MEMBERS AND A COMPLETE PARTITION.** Ten uncredited in-window
  `run-W1-*` merges: **six malformed epochs** (T2703, T2717, T2713, T2709 second-quantised; T2712 and
  T2692 with TEN-DIGIT SECOND-PRECISION ids; **T2703's dated ~6.4 h AFTER its own merge**), **two
  straddlers** (#3629/T2610 landing, #3692/T2623 leaving) and **two DAEMON fix-rung branches** (T2704,
  T2711). **P64 takes the first six and grows a shape it never named; TASK G takes the whole set and
  its accounting is complete for the first time.**

- **★ PROCEDURAL-SUCCESS MINING (P13) TRACKS THE WRITER EXACTLY, A THIRD CONSECUTIVE CYCLE.** The miner
  returns `implement × [clean_single_strike, fully_executed_proof]` over **3 runs — precisely the 3 the
  ledger called `merged`.** Its input is ledger-`merged` runs, so its output restates the verdict column
  rather than observing shapes — and this cycle that costs it seven members, because **seven runs that
  shipped a merge are invisible to it.** No proposal is minted: **P47** owns the cause and **P48** owns
  publishing the zero with its mechanism.

- **★ THE FOLLOW-UP HARVEST IS THE ONLY INSTRUMENT THAT SAW P68, AND IT SAW IT IN PROSE.** Five runs
  name a missing task record; five name an intact one; the split is invisible to every table in this
  document. Three further harvest items are **infrastructure, not task defects**, and are recorded here
  rather than mined: a `GH_TOKEN` returning *"Bad credentials"* on `gh api user` (an operator action), a
  `.gitmodules` *"Permission denied"* warning during `git fetch` in a provisioned worktree, and the
  canonical checkout reported **1850 commits behind `origin/main`** — which is the exact condition
  W1-T2618/W1-T2621 shipped the measurement for, arriving in the same window as its own evidence.

**RETRO-1788350665543 (R43) — MINING BLOCK FOLDED TO ONE LINE BY R44** (16 runs / 38 merges in-window,
14 on `run-W1-*`, ledger 12 / union 14): minted **P67** (*a merge is credited at the instant it lands
and nothing ever re-reads the trunk*) on #3611/#3622, wrote **DR-27**, held **P65** at twelve, recorded
the credit band's first exit ABOVE itself and the first fully-accounted residue in this log, RE-DERIVED
**TASK L** into **TASK G** on R42-2's pre-committed consequence, moved the mount freeze's release
condition onto **P65's classifier**, and gave **P54** its rolling-window mechanism. Every proposal it
touched carries the evidence in its own canonical entry.
**RETRO-1788324628827 (R42) — MINING BLOCK FOLDED TO ONE LINE BY R43** (11 runs / 50 merges in-window,
19 on `run-W1-*`, ledger 6 / union 9): minted **P66** (*two authoring lanes draw from one task board and
the credit resolver's only reaction to a collision is to refuse the winner*) on #3535, wrote **DR-26**,
grew **P65** from eight members to twelve, gave `stale/foreign` its first genuinely foreign row in
thirteen cycles, recorded the `merged` writer's return and the credit band's re-entry at 50%, and read
**TASK L empty for the first time.** Every proposal it touched carries the evidence in its own canonical
entry.

**RETRO-1788294290880 (R41) — MINING BLOCK FOLDED TO ONE LINE BY R42** (9 runs / 40 merges in-window,
17 on `run-W1-*`, ledger 0 / union 6): minted **P65** (*a second authoring lane ships source through
head refs no run-keyed instrument reads*) on eight hand-named source merges, wrote **DR-25**, gave
**P58** its second intake member (#3511) and **TASK N** its first non-empty population in seven cycles,
declined R40-3's re-narrowing on a third exit BELOW the band, and recorded the only `merged`=0 cycle in
this log. Every proposal it touched carries the evidence in its own canonical entry.

**RETRO-1788251442324 (R40) — MINING BLOCK FOLDED TO ONE LINE BY R41** (29 runs / 45 merges in-window,
39 on `run-W1-*`, ledger 8 / union 21): minted **P64** (*a second-quantised `run-<id>-<epochMs>` head
ref is not a run*) on ten uncredited merges in one contiguous id band, RE-DERIVED the credit band to
20–65% on R39-3's pre-committed second-exit trigger — the first band re-cut in this log, published with
its own defect named — scored **P63's bar at six with two non-ratchet members**, promoted **P57** on
100%-mislabelled rejections, closed **P48's share-column site**, and wrote **DR-24**.

**RETRO-1788193081371 (R39) — MINING BLOCK FOLDED TO ONE LINE BY R40** (23 runs / 29 merges in-window,
21 on `run-W1-*`, ledger 2 / union 8): minted **P63** (*a standing gate whose own prescribed remedy
lives in a file the declared scope forbids it to touch is a deadlock*) on 17 `blocked_ci` verdicts and
five fix rungs naming `scripts/source-size-baseline.json`; recorded the uncredited class at 13 with
eight of them printed WITH THEIR PR URL in the same gather (**P47**), TASK L's refill at 12.14 h
(R38-2 HIT), the credit band's first exit BELOW at 9.5% (R38-3 MISS), the turn column at 0% taking the
weekly `share` column with it (**P48**), and the G-17 corpus losing 18 rows while gaining $29.56
(**P54**). **Its per-cycle bullets are DELETED, not summarised again** — the standing disposition since
R24.
**RETRO-1788144172947 (R38) — MINING BLOCK FOLDED TO ONE LINE BY R39** (27 runs / 38 merges in-window,
17 on `run-W1-*`, ledger 8 / union 10): minted **P62** (*the same task is dispatched five times in one
window and the only rung that notices calls the duplicate's merge foreign*) on nine repeat runs of three
tasks, wrote **DR-22** (*state how many distinct TASKS a run denominator covers*), recorded TASK G's
first fully disjoint reading (7 of 7) beside TASK L's empty class, the credit band's return inside
25–65% (47.1%), P58's first intake member (#3328 → W1-T2509), the Architect lane's first non-zero row,
and scored 4 hits / 2 misses / 0 unresolvable — the best ratio in this log. Its evidence lives in
P62, P47, P58, P57 and TASK G/L in place; every id, PR and cost survives in the SHIPPED log's own
folded R38/R37 section.

**RETRO-1788096158805 (R37), RETRO-1788011469299 (R36), RETRO-1787922605773 (R35),
RETRO-1787883095112 (R34) AND RETRO-1787858337550 (R33) — FIVE MINING BLOCKS FOLDED TO ONE BY R39.**
Runs/merges/ledger-credit: 13/34/10 · 14/34/10 · 17/29/9 · 16/55/5 · 18/7/2. **Mints, in order: P61**
(*the trailer scan is a substring match, so a body that DESCRIBES a trailer mints one*, on #3262) ·
**P60** (*the ownership assert is a PICKER, not a FILTER*, on #3242/#3237 with #3251/#3255 as positive
control) · **P59** · **P58** · **P57**. **Rules written: DR-21, DR-20, DR-19, DR-18, DR-17.**
The durable readings, kept because later cycles still cite them: the credit band's **first exit in
eleven readings (66.7%)** and the smallest uncredited residue ever ($8.404 / 14.7%) · a merged PR with a
**ZERO-file changeset** (#3261) and a plan-only diff credited as an implementation (#3195), P56's two
limit cases · **TASK G RETIRED by deletion on a fourth consecutive zero (R34) and UN-RETIRED one cycle
later on #3237/W1-T2387 — the only reversed retirement in this log** · the rejection label found **wrong
on all thirteen of its own rows**, which re-cut the mount freeze's condition from TASK G onto TASK L ·
the first paid ratification telemetry in twenty-four cycles · **P51 folded into TASK L.**
**Every finding of all five was re-adjudicated on its own pre-registered test by a later cycle** (R33-1
through R37-6 are scored in the blocks above and in each proposal's canonical entry) **or is superseded
in place there** — and every id, PR and cost survives in the SHIPPED log's own section headers.

**RETRO-1787828128305 (R32), RETRO-1787778937848 (R31) AND RETRO-1787714349337 (R29) — MINING BLOCKS
FOLDED TO ONE LINE BY R34** (R32: 24 runs / 15 merged, ledger 8 / union 14 — minted **P56**, wrote
**DR-16**, caught the first FABRICATED credit · R31: 18 runs / 12 merged, ledger 4 / union 9 —
minted **P55**, wrote **DR-15**, scored the first clean five-row sweep and cross-footed eight
guard-blocked runs at $0.001 · R29: 47 runs / 27 merged, ledger 14 / union 14 — minted **P54** and
**TASK N**, wrote **DR-13**, recorded the first inversion of the credited/uncredited spend
split and the promotion judge's first reversal). **Every finding in all three either was re-adjudicated
on its own pre-registered test by a later cycle** (R32-3/-4 and R29-2/-3/-4/-5 HIT, R32-1/-2/-5 and
R29-1 MISSED, **P55 RESOLVED AGAINST ITSELF** by the deletion experiment R32 set up, the $0.001
cross-foot failed to reproduce three cycles running, P54 RATIFIED, and TASK G's zero fired R32's
re-cut trigger before R34 retired the task outright) **or is superseded in place by the block above** —
and every id, PR and cost they named survives in the SHIPPED log's own R29/R31/R32 section headers.

**RETRO-1787654213224 (R28), RETRO-1787502627029 (R26) AND RETRO-1787419805720 (R25) — MINING BLOCKS
FOLDED TO ONE LINE BY R29** (R28: 45 runs / 28 merged, ledger 18 / union 20 — minted **P53**, widened
**P52** with a `turns-exhausted` arm, scored the first clean 4-of-4 sweep, wrote **DR-12** ·
R26: 31 runs / 38 merged, ledger 14 / union 25 — minted **P51**, re-scoped **TASK L** on a 29-hour
straddler band, promoted **P43** to rank 3 · R25: 41 runs / 33 merged, ledger 21 / union 27 — minted
nothing, re-ranked P50 once, routed to **TASK L** and **TASK G(ii)**). **Every finding either was
re-adjudicated on its own pre-registered test by a later cycle (P51 PARKED at zero, TASK L's band
refused as a scope reduction under DR-11, G(ii)'s re-scope WITHDRAWN, rule 12 BOUNDED by rule
13's counterexample) or is superseded in place by the blocks above** — which is the whole content those
three blocks still carried; every id, PR and cost they named survives in the SHIPPED log's own R25/R26/
R28 section headers.

**RETRO-1787290856852 (R24) — HEADER AND FAILURE-MINING FOLDED TO TWO LINES BY R26** (54 runs / 40
merged task PRs, 29 named / 10 ledger credits / 22 rejected trailers, 0 foreign; **13 of its 44
non-merged verdicts were ONE 41-minute host outage** wearing three labels, which minted DR-8
and **P50**/**TASK M**; no proposal was minted off its distribution). Its canonical TASK entries follow
and are maintained IN PLACE, not per-cycle.

- **★ TASK M (P50 — SAY WHICH OF THE FOUR `observed` STATES FIRED, AND WRITE THE RE-ARM BAR IN THOSE
  WORDS; R24's mint). ★★ CLAUSE (i) CLOSED BY SHIPPING — W1-T1281/#2685, 2026-08-24 — AND R28 SCORED
  IT AS A REGRESSION TEST, WHICH HELD.** GROUND TRUTH AS FILED (read at
  `src/lib/containment.ts:505-557`): a failed containment preflight throws one of four
  `ContainmentError` shapes, and R24's gather printed 13 blocks that ALL read `observed: unproven` —
  the state that proves nothing, so the run was fail-closed on ambiguity exactly as Standing rule 11
  requires.
  **(i) SHIPPED AND NOW FOUR-TIMES OBSERVED.** #2685 made the guard name what it saw; R27's 23 rows
  split cleanly at that merge, and R28/R29/R30 read **16, 18 and 8 named states with zero `unproven`,
  all `turns-exhausted`** — **42 consecutive rows carrying ONE state.** That is a stable phenomenon
  rather than a moving one and belongs to P52's existing arm. **★ BUT IT NOW BEARS ON P50(iv):** if
  42 of 42 rows carry one value, the re-arm bar written in `observed: proven` may be unreachable by
  construction rather than merely mis-worded — which is why **R30-5** registers on whether the 43rd
  row differs, as DR-14's first change-requiring row.
  **(ii) STILL OPEN, AND NOW DEMONSTRABLY LOAD-BEARING:** the gather's recurrence-trend line reports
  `containment/outside-cwd-denial: 8x across 6 tasks` with **no state breakdown beside the count** —
  the per-row states are printed one section above and the trend line joins none of them, so *8
  `turns-exhausted` on one host* and *8 `proven_broken` on one host* are still opposite emergencies
  wearing one number. This is DR-5's shape (the defect is the JOIN) inside TASK M — **and
  TASK N is the same shape one step further out, where the number that would size the state lives on
  the probe row and reaches no line at all.**
  **(iii) STILL OPEN:** every kill/re-arm/retirement trigger in this file must be restated in emittable
  values, and **P41's bar becomes: `≥2 firings in one window whose `observed` is `proven_broken`, OR
  ≥10 firings of any state on a single host — the latter re-arms as an INFRASTRUCTURE question, not a
  security one`**. R27 would have fired that second arm at 22, R28 at 16, **R29 at 18 — three
  consecutive windows over the bar, and it has still never been wired.**
  **(iv) STILL OPEN:** a trigger whose satisfying value no instrument emits is itself a lint failure at
  mint time (see P50); `observed: proven` is still that value. GOLDEN (fixture-only): a seeded run
  whose probe writes outside cwd successfully ledgers `proven_broken` and re-arms; a seeded run whose
  probe neither writes nor denies ledgers `unproven` and does NOT; ten seeded blocks of any state on
  one host id raise the infrastructure arm exactly once, never ten times; **the recurrence-trend line
  prints the state histogram beside the count, never the count alone.**
- **★ TASK N (P52/P50 — JOIN THE PROBE'S OWN NUMBERS TO THE GUARD ROW THAT KILLED THE RUN; R29's mint,
  UNBUILT).**
  GROUND TRUTH: **W1-T2238/#2794 shipped a `(numTurns, maxTurns)` pair onto the containment
  probe's own ledger row on 2026-08-25.** R29's gather printed **18** guard-fired block lines and
  **R30's printed 8** — every one of the **26** for a run that started AFTER that merge, every one
  reading `containment/outside-cwd-denial — observed: turns-exhausted`, and **not one carrying a
  number.** The
  field is written and read by nobody: to the fleet's only feedback loop it is indistinguishable from a
  field that was never built. **WHY THIS IS NOT AN EXISTING TASK, stated as a test:** TASK M(ii) asks
  for the STATE HISTOGRAM beside the recurrence COUNT — a join between two lines of the gather that
  both already exist; **TASK N asks for a value that exists only on a DIFFERENT ledger step
  (`containment.probe`) to reach a line built from the `blocked_containment` VERDICT row** — a join
  across steps, not across sections, and neither one implies the other. TASK I owns the CI-side check
  name; P52 owns what to DO with a named state. **WHY IT IS WORTH A LETTER RATHER THAN A NOTE:**
  P52(i-b) proposes re-running an exhausted probe *at the cap T2201/#2695 derives* and escalating a
  second exhaustion as a SIZING question — **and that clause cannot be priced, tuned or falsified
  without the two numbers.** **42 guard blocks across three windows** have now been spent on a state
  whose magnitude is unmeasured. PROPOSE: **(i)** the retro's guard-block rung joins each
  `blocked_containment` verdict to its run's `containment.probe` row and prints
  `observed: <state> (turns <n>/<cap>)`, printing `turns unrecorded` — never a blank and never a zero
  (P48) — where no probe row exists; **(ii)** the same pair rides the recurrence-trend line as a range
  (`8x across 6 tasks, turns 19–20 of 20`), which is the histogram TASK M(ii) asks for in the one
  dimension that is now numeric; **(iii)** if the join is impossible because the probe row and the
  verdict row share no key, THAT is the finding and it is reported as such rather than worked around —
  a missing key is a schema defect, not a rendering one. GOLDEN (fixture-only): a seeded run with a
  probe row and a `turns-exhausted` verdict prints both numbers on the guard line; a seeded run whose
  probe row is absent prints `turns unrecorded` and never `0`; a seeded window of mixed states prints
  one range per state, never one range over all of them.
- **★ P53 (R28's mint — THE PARTITION KEY 99% OF THE POPULATION DOES NOT CARRY: A SHARE TABLE
  CUT ON A FIELD THAT IS NOT WRITTEN). RANK 12. ★★ R39: THE FROZEN SET MOVED — BY EXACTLY ONE, WHILE
  THE CORPUS FELL BY SEVEN.** G-17's implement lane reads `model` on **15 of 200**, after **14 of 207**,
  **14 of 205**, **14 of 200** and **14 of 205**. **Four consecutive byte-identical readings across a
  −5/+5/+2 swing, then a +1 against a −7:** the numerator is not tracking the corpus in either
  direction, which is the entry's claim and not its refutation. The unattributed share is **185 of 200
  = 92.5%**, so the share table below is still cut on a field 92.5% of its population does not carry —
  and the `review.reviewer` lane, 100% attributed at n=10 last cycle, reads **0 rows** this one.
  **★ R37: THE ATTRIBUTED SET WAS FROZEN THROUGH A SHRINK
  AND A GROWTH — **14 of 205**, after **14 of 200** and **14 of 205**: a corpus that shed five rows and
  then re-gained five while its attributed count stayed BYTE-IDENTICAL is neither a running total nor a
  rolling window, and no sampling story survives it. ★★ R34's READING — THE NUMERATOR IS FROZEN WHILE
  THE DENOMINATOR ROLLS, WHICH IS WORSE THAN FLAT:** the implement lane reads `model` on **13 of 206** rows
  and **13 is the same absolute count as last cycle's 13 of 209**, so no new run is being attributed at
  all; the ratio "94% → 94%" improved only because the corpus shed rows. `review.reviewer` is 3-of-3
  attributed, so the live producer is still live and the silent write site is still silent, and
  `BY MODEL CLASS` publishes `100.0%` over that corpus for a NINTH cycle. **A frozen numerator over a
  receding denominator will eventually read as progress with nothing having been written — which is
  exactly why P53's fix is a WRITE SITE and not a better ratio.** (R30's flat reading and R28's
  1-of-202 mint are folded into that sentence; the series 99.5% → 98% → 94% → 94% is the whole history.)
  GROUND TRUTH AS MINTED (R28's gather, readable only BECAUSE the G-17 table prints its own `model`
  attribution): across the measured 221-row corpus, the **implement lane was 210 rows with `model`
  present on TWO of them (`sonnet`×2) and ABSENT on 208 — 99% unattributed** — while the calibration
  section's
  **`BY MODEL CLASS — weekly-limit burn` table publishes ONE `sonnet` row carrying `100.0%` of weekly
  burn.** The two facts are printed in the same document, five sections apart, and the second is a
  partition of the population the first says is unlabelled. **THE FIELD HAS A LIVE PRODUCER:** the
  `review.reviewer` lane is **11 of 11 attributed**, so this is not a missing schema or an unavailable
  value — it is one write site that does not call what another write site calls. **WHY THIS IS NOT AN
  EXISTING PROPOSAL, stated as a test:** P40(ii) forbids printing an AVERAGE over a column that is
  empty for >10% of rows — a COVERAGE discipline on a numeric column, and its part (a) (class
  resolution) was CLOSED and falsified sixteen cycles ago; this is a LABELLED PARTITION over rows that
  lack the label, where the defect is not a noisy mean but a **false attribution** — the honest output
  is an `unattributed` row with its own share, not a coverage stamp. P42 owns *a verdict class owning
  a cycle*; P48 owns *a naked zero*; **none owns a denominator sliced by a key its rows do not hold.**
  **WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS:** `mounts.yaml` (W1-T5) routes model + effort by risk
  and class (W1-T167/#606), and the BY MODEL CLASS table is the ONLY instrument that could ever answer
  whether that routing paid off. Seventeen cycles have called that question **UNDER-SAMPLED**; the
  measurement above says the correct word is **UNATTRIBUTABLE**, which is a different defect with a
  different and much cheaper fix. PROPOSE: **(i)** the ledger's `verdict` write site records the
  resolved model id the same way `review.reviewer` already does — one field, one call site, no schema
  change; **(ii)** until (i) has covered a full window, every model-partitioned table prints an
  explicit **`unattributed`** row carrying its own row count and share, and **no named-model row may
  report a share larger than its own attributed mass**; **(iii)** the retro refuses to publish a
  `share of weekly burn` figure at all when attributed rows are under a stated threshold of the
  corpus, printing the attribution rate instead — P48's no-naked-zero rule applied to a partition
  rather than to a value. GOLDEN (fixture-only): a seeded ledger whose `verdict` rows carry no `model`
  key makes the BY MODEL CLASS table print an `unattributed` row and never folds those rows under a
  named model; a seeded ledger with mixed attribution prints both rows, and the named row's share
  equals its attributed mass over the whole corpus, never 100%; a seeded ledger below the attribution
  threshold prints the attribution rate in place of any share figure.
  **★ R33 — THE EVIDENCE MOVED A SECOND TIME AND STILL SAYS NOTHING, AND NOW THE CONTRAST IS INTERNAL.**
  G-17's implement lane reads **209 rows with `model` present on 13 and absent on 196** — 94%
  unattributed, after 98% last cycle and five cycles at 99.5%. **Thirteen attributed rows out of 209 is
  the same silent write site with a bigger rounding error.** ★ AND THE DECISIVE NEW READING IS A
  COMPARISON INSIDE ONE TABLE: the `triage` lane is **3 of 3 attributed** and `review.reviewer` is
  **6 of 6** — **the Architect and reviewer lanes are 100% attributed while the implement lane is 6%**,
  in the same corpus, in the same gather. **That is no longer a sampling story; it is a call-site
  story**, and it names where the fix goes.
- **★ P54 (R29's mint — THE CORPUS THAT RECEDES: A ROLLING WINDOW WEARING A `HISTORICAL` LABEL IS
  NOT THE SAME MEASUREMENT TWICE). ★★ RANK 13, RATIFIED BY R30 AND NOT RE-ARGUED SINCE. ★★ R39: THE
  SHAPE HOLDS A THIRD CYCLE AND THEN SPLITS — THE CORPUS RECEDED AND *SHRANK* WHILE GAINING MONEY.**
  218 rows / $1039.28 → **200 rows / $1068.84** (**−18 rows, +$29.56**) with the stated start advancing
  **2026-08-25T08:39:22.768Z → 2026-08-25T18:58:57.092Z**. **A population that loses eighteen rows and
  gains twenty-nine dollars is neither a rolling window nor an append-only ledger nor a running total**,
  and no prior reading of this entry predicts it. **★ AND IT TOOK A NAMED CASUALTY WITH IT:** the
  Architect lane's only row in this log — an `inbox.draft_synthesized` at $8.76, first recorded last
  cycle — is GONE, and the ~10.3 h the start advanced is the leading CANDIDATE explanation, **named as a
  candidate and not asserted** (rule 18). Registered as **R39-6**. **★ R37: THE
  SHAPE RESUMES AFTER ONE CYCLE OF ITS OPPOSITE** — 202 rows / $941.06 → **209 / $981.78** (+7, +$40.72)
  while the stated start ADVANCED 2026-08-24T22:02:57.112Z → 2026-08-24T23:24:54.291Z. **Receding and
  growing, then receding and shrinking, then receding and growing again, on a corpus whose membership
  rule is never stated — the two readings do not cancel; they establish that neither is derivable.**
  **★ R34's READING — THE SIMPLEST FORM THE DEMONSTRATION HAS EVER TAKEN: THE CORPUS LOST 9 ROWS WHILE
  GAINING $12.41** (218 / $879.29 → **209 / $891.70**), with the stated window start advancing
  **2026-08-23T22:18:34.026Z → 2026-08-24T05:09:52.559Z** for a **fifth consecutive cycle**. A fixed
  window cannot shrink. **AND THE ARCHITECT LANE HAS NOW ROLLED ALL THE WAY BACK TO ZERO** — 7 rows →
  3 → **0**, $37.16 → $7.33 → **$0.00** — so the capability half of G-17 has no corpus at all this
  cycle, having had one two cycles ago; that is the same statistic moving without the quantity moving,
  which is the argument P54 was minted to make and R30 ratified. **NOT CLOSED BY BEING PROVEN:** the
  fix — publishing the epoch and the retention bound beside the share, or making the corpus cumulative
  — is unbuilt. (R30's third reading and its 1-row/$0.77 demonstration are folded into this paragraph.)
  **★★ R36 — THE STRONGEST READING YET, AND IT IS THE MIRROR OF LAST CYCLE'S.** R35 read the corpus
  GAINING 7 rows and $139.96 while its start advanced ~8 h; **R36 reads it SHEDDING 14 rows and $90.60**
  (216 / $1031.66 → **202 / $941.06**) while its start advances **2026-08-24T13:05:08.961Z →
  2026-08-24T22:02:57.112Z**. Six cycles of receding-and-growing followed by one receding-and-shrinking
  is not a corpus with a stable definition. **★ AND THE COST IS CONCRETE THIS TIME: the 6 `inbox_draft`
  rows that made last cycle's 7.5% Architect share AGED OUT, so the share reads 0.0% over 0 rows** —
  the only non-zero Architect reading this log has ever printed turns out to have been a window
  artefact, proved by its own disappearance. **P54 needs no new argument; it needed exactly this.**
  GROUND TRUTH AS MINTED (two consecutive gathers, the only
  way this defect is visible at all): G-17's own header reported a measured total of **221 rows /
  $1063.78 notional** on 2026-08-25 and reports **207 rows / $922.40** on 2026-08-26, with its
  `review.reviewer` lane falling **11 → 4** — **across a window in which 47 further runs were
  recorded.** Its stated window start moved forward to **2026-08-21T15:43:25.544Z**, ~4.5 days back.
  **WHAT THAT MAKES THE TABLE:** not a lifetime record and not a current one, but a **rolling window
  labelled HISTORICAL**, in which the headline finding — *the Architect lanes are 0 rows / $0.00, 0.0%
  of the fleet's spend* — is **structurally guaranteed by any Architect lane that last ran more than
  ~4.5 days ago**, and therefore says nothing whatever about whether the Architect lanes have ever been
  measured. Eighteen cycles have leaned on that reading. **WHY THIS IS NOT AN EXISTING PROPOSAL, stated
  as a test:** P48 forbids publishing a naked zero without its limitation — and the limitation IS
  printed here (the bounds are right there in the header), yet the reading is still wrong, because the
  defect is not an unstated caveat but a **moving population**; P53 owns a partition cut on a key the
  rows lack, which is a defect in the SLICE, not in the CORPUS; P40(ii) owns coverage of a numeric
  column; P43(ii)/rule 10 govern PREDICTIONS registered off a single point, not TABLES read across
  cycles. **None of them forbids comparing two numbers computed over two different populations**, which
  is what every cross-cycle read of this table has done. **WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS:**
  P53's own evidence (the attribution rate) is computed on this corpus, so a proposal ranked 4 rests on
  a denominator that recedes; and G-17's capability half — the only standing argument about Architect
  tier — has been argued from it since R11. PROPOSE: **(i)** every cumulative or share table in the
  gather prints its **EPOCH** (start bound, row count) *inside the table*, not only in a header
  paragraph, so a reader cannot quote the share without the population; **(ii)** the word `HISTORICAL`
  is reserved for a corpus whose start bound is **pinned**, and a rolling window is labelled
  `LAST <N> DAYS` instead — a naming rule, not a mechanism; **(iii)** where a lifetime claim is
  actually wanted (the Architect-lane question), the rung reads the ARCHIVE union rather than whatever
  the live file still holds — the same fix T2257/#2869 shipped for `rmd receipt` this very cycle, which
  is the evidence that this is cheap and already precedented; **(iv)** no retro may compare a share
  across cycles unless both readings state the same epoch — stated as a reading rule so the next cycle
  is bound by it whether or not (i)–(iii) ship. GOLDEN (fixture-only): a seeded state root whose
  archives hold rows older than the live file makes the G-17 rung report the ARCHIVE-inclusive row
  count and an epoch that starts at the oldest archived row; a seeded corpus that shrinks between two
  runs makes the rung refuse to print a cross-cycle delta and print both epochs instead; a rolling-
  window corpus is never labelled `HISTORICAL`.
  **★ R33 — THE SHARPEST DEMONSTRATION THIS ENTRY HAS EVER HAD, AND IT NEEDS NO INTERPRETATION.**
  The corpus reads **218 rows / $879.29** (was 213 / $876.26) with its stated window start ADVANCING
  **2026-08-23T19:59:05Z → 2026-08-23T22:18:34.026Z** — a FOURTH consecutive cycle of the roll. **★★
  THE CORPUS GAINED 5 ROWS AND $3.03 WHILE THE ARCHITECT LANE LOST 4 ROWS AND $29.83** (7 / $37.16 /
  4.2% → 3 / $7.33 / 0.8%). **A component cannot fall by ten times what the whole gains inside a fixed
  window.** No inference about Architect spend may be drawn from the 4.2% → 0.8% fall, exactly as none
  was drawn from last cycle's 0.3% → 4.2% rise. **★ AND `retro.synthesized` READS `0 rows` FOR A
  THIRD CONSECUTIVE CYCLE IN A WINDOW WHERE A RETRO PR DEMONSTRABLY MERGED** — #3073, branch
  `run-RETRO-1787828128305`, merged 2026-08-27T11:46:34Z, verified over REST.
- **★ P52 (R27's mint — THE GUARD THAT BLOCKED ON ITS OWN NON-EXECUTION: A BLOCK WITH NO
  OBSERVATION IS A RETRY, NOT A VERDICT). ★★ WIDENED IN PLACE BY R28 WITH A THIRD ARM —
  `turns-exhausted` — AND DELIBERATELY **NOT** RE-WIDENED BY R29, WHICH OBSERVED THE SAME STATE AGAIN
  AT 18 OF 18. A proposal is not re-opened because its evidence recurred; the repeat is recorded here
  and the only NEW thing the storm produced — the missing turn-count join — is filed as TASK N.**
  GROUND TRUTH AS MINTED (R27, readable
  only BECAUSE T1281/#2685 shipped): of 23 guard-fired blocks, **11 carried a state that reports NO
  measurement at all** — `probe-never-ran` ×4, `write-never-attempted` ×7 — against 12 `unproven`,
  and W1-T1279 burned five consecutive dispatches while W1-T2201 burned four and shipped #2695 anyway.
  **★ R28's OBSERVATION — THE STATE CHANGED COMPLETELY IN ONE WINDOW: 16 of 16 blocks read
  `observed: turns-exhausted`, a state that appeared ZERO times across R27's 23.** Two consecutive
  windows, 39 blocks, **not one state in common** — which retires any reading of this storm as a
  standing host condition and replaces it with a moving one. **`turns-exhausted` is a THIRD kind of
  thing** and neither of the mint's two arms covers it: the probe was neither inconclusive (`unproven`)
  nor absent (`probe-never-ran`) — **it was still working when its own turn budget ended it**, which is
  an UNDER-BUDGETED MEASUREMENT, not a security observation. Failing closed on it converts a sizing
  error into a containment verdict, and 16 dispatches paid for it this cycle while **10 of the 11
  affected tasks merged in the same window anyway**. **WHY THIS IS STILL NOT AN EXISTING PROPOSAL:**
  P50/TASK M owns *which state fired and how the re-arm bar is worded* — its naming clause shipped and
  it is silent on what to DO with a named state; P30/TASK I owns *which CHECK blocked*, on the CI side;
  P44 owns *a tripwire that anchors rather than measures*. PROPOSE: **(i)** the containment preflight
  distinguishes *the probe ran and was inconclusive* (`unproven` — fail closed, as today) from *the
  probe did not run* (`probe-never-ran`, `write-never-attempted` — **RETRY the probe, bounded, before
  spending the dispatch**); **(i-b) ★ NEW — `turns-exhausted` RAISES THE BUDGET OR SHRINKS THE PROBE,
  IT DOES NOT FAIL THE RUN**: a probe that hits its cap is re-run once at the cap T2201/#2695 already
  derives, and a second exhaustion escalates as a PROBE-SIZING question naming the `(numTurns,
  maxTurns)` pair T2238/#2794 now records — never as a containment failure; **(ii)** a no-observation
  block that recurs on one host N times within a window raises TASK M(iii)'s INFRASTRUCTURE arm ONCE
  and **stops dispatching that host** rather than re-blocking task after task; **(iii)** the run that a
  no-observation block kills is re-queued rather than counted as an attempt, so a host defect never
  consumes a task's strike budget; **(iv)** the ledger row records the retry count beside the state, so
  the next retro can price the difference between *the guard worked* and *the guard never looked*.
  GOLDEN (fixture-only): a seeded `probe-never-ran` retries the probe and, on a successful second probe,
  dispatches normally with the retry recorded; a seeded `turns-exhausted` re-runs once at the derived
  cap and, on a second exhaustion, emits a sizing escalation carrying both turn numbers and **no
  containment verdict**; a seeded `unproven` never retries and fails closed exactly as today; N seeded
  no-observation blocks on one host id stop that host and raise exactly one infrastructure escalation;
  a task whose only blocks were no-observation blocks shows **zero** consumed strikes.
  **★★ R31 — THE FIRST PRICED READING, AND IT ARGUES THE MINT'S ORIGINAL ARM AGAINST ITS OWN THIRD
  ARM. NOT RE-WIDENED; EVIDENCE ADDED IN PLACE.** The storm's state monoculture broke at 42 rows:
  **6 `turns-exhausted` + 2 `probe-never-ran`** across 8 blocks on five tasks. **But cross-foot the
  gather and the two states cannot both be true:** the nine SHIPPED lines price $58.800 of a $60.081
  window, the `plan-lint` row takes $1.280 of the $1.281 remainder, and **the eight guard-blocked runs
  are left sharing $0.001.** A run does not exhaust a turn budget for a tenth of a cent; `probe-never-ran`
  is the only one of the two states consistent with that price. **So the likeliest reading is that all
  eight never ran and SIX are MIS-LABELLED** — which is clause (i)'s original arm, not clause (i-b)'s,
  and it means the third arm R28 widened this proposal on may be a labelling artifact rather than a
  distinct failure. **The disjunction is stated, not resolved:** if the SHIPPED lines' `$` are per-TASK
  sums rather than per-run costs, the subtraction is void and the defect is instead that **two `$`
  columns in one document are cut on different units with no label saying so.** Either way P52's
  clause (iv) — *record the retry count beside the state* — is the cheapest instrument that would
  settle it, and R31-5 registers the question on the spend column the gather already prints. **3 of the
  5 storm-hit tasks merged in this same window anyway** (T2293, T2296, T2297), a fifth consecutive
  cycle of the guard blocking work that then shipped.
  **★ R33 — THE SECOND CONSECUTIVE NON-REPRODUCTION, AND THE ENTRY DROPS ON IT.** $68.713 across 15
  non-shipping runs is **$4.581 each**, beside R32's $4.859 across 10. **R31's eight-runs-at-$0.001
  storm has now failed to reproduce twice**, so the mis-labelled-non-execution arm of P52's disjunction
  has NO priced evidence at any point in the series except the one cycle that produced it. **P52 drops
  in the ranking on its own evidence.** The second arm still stands and still cannot be settled from
  inside the gather: **no `$` column anywhere in this document states its unit**, and this cycle adds
  nothing to that either way. **★ AND THE GUARD ARM WAS UNTESTABLE THIS CYCLE:** zero guard-fired
  blocks, so there was no block to cross-foot at all — recorded as unexercised, never as clean.
- **★ P51 — FOLDED INTO TASK L 2026-08-28 BY R35; PROSE DELETED (git holds it), ITS ONE GENUINE
  READING AND ITS INSTRUMENT CARRIED ACROSS.** P51 was minted by R26 on five code PRs merged from
  canonical `run-W1-*` branches whose run ids appeared nowhere in that gather, and PARKED by its own
  falsifier in R27 after four empty cycles. **Its definition excludes straddlers by inspection — and
  every candidate it has ever attracted except W1-T2298/#2942 turned out on examination to BE a
  straddler, including all three of R35+s.** Two entries, one population, and the one that keeps reading
  zero is the one that defined its members away. **It is NOT retired on a zero** (DR-19
  forbids exactly that): it is merged into the entry that already owns the members. **WHAT SURVIVES IN
  TASK L:** the +5 on P33+s quarantine list (credit lost with no run row is unrecoverable by any join),
  the W1-T2298/#2942 reading, and P51+s proposed instrument — **the gather printing `ABSENT RUNS — n:`
  as a set difference over lists it already builds**, which is the same enumeration TASK L needs.
- **★ TASK L — RETIRED AS A SEPARATE LETTER 2026-09-02 BY R43 (tombstone only; the full 64-line entry
  is DELETED, and git holds it).** Its population read ZERO two cycles running while its own superset —
  uncredited in-window `run-W1-*` merges — emptied with it, so R42-2's pre-committed consequence fired.
  Under **DR-18** its members are accounted for (they went into the CREDITED population) and under
  **DR-19** no still-held class would claim them, but the seam is not closed — it changed SIGN, and two
  runs end this window holding OPEN PRs. **L is therefore FOLDED INTO TASK G**, generalised to both
  directions of the seam, **P51 folded along with it**, and **the mount freeze's release condition moves
  OFF L onto P65's changed-files classifier** — a class that has never read zero.
- **★ TASK K (P40 — COUNT THE RUNS BEFORE AVERAGING OVER THEM; proposed by R22, UNBUILT). ★★ R30
  EVIDENCE, IN PLACE: K'S CASE IS NO LONGER AN INFERENCE — THE DOCUMENT STATES ITS OWN POPULATION
  TWICE, DIFFERENTLY.** R22 proved the run set short by counting; R23 showed the verdict column could
  not close; R24 named three tasks with no run in scope; R25 found one; R26 found twelve merges with no
  scoped run and had to SPLIT them (7 straddlers, 5 absent runs) to stay honest; R27–R29 each found K's
  own population empty. **R30 finds it directly, and without leaving the page: `Runs in scope: 27`
  heads a gather whose harvest, guard rung and discrepancy list name 33 DISTINCT RUN IDS**, one of them
  (`DAEMON-1787714166975`) starting BEFORE the declared marker — so the two are not even cut on the
  same window. **Every reading in this file divides by 27.** Until now K had to be argued by
  pigeonhole from merges; it can now be argued by reading two numbers in one document, which is the
  cheapest evidence this proposal has ever had and the reason it is the most urgent of the three
  denominator instruments. **The rule that separates the classes, which is the part of K
  worth building:** *if the missing run's id predates the marker it is L's; if the gather prints the run
  id anywhere it is G's; if no ledger row exists for it in any cycle it is P51's; otherwise it is K's.*
  A retro reading only the in-window view mis-files all four as one "uncredited" mass, which is what
  every cycle before R25 did. GROUND TRUTH AS FILED (hand-verified, DR-4/DR-6): **31 distinct
  `run-W1-*` branches merged a PR in R22's window and every one of their run ids postdates that marker,
  while the gather reported `Runs in scope: 30`.** By pigeonhole at least one in-window run that merged
  a PR was absent from the population behind `avg $`, `avg turns` and `total $`. PROPOSE: **(i)** the
  gather derives, from GitHub, the set of `run-*` branches with a merged PR in the window and prints any
  whose run id it did not scope, as `RUNS NOT IN SCOPE THAT MERGED — n: <ids>`; **(ii)** when that list
  is non-empty the `runs` column is annotated `⚠ short by ≥n`, never silently averaged (**P48(ii)**);
  **(iii)** the check states its own reach — it can only see runs that MERGED something, so a scoped-out
  run that shipped nothing stays invisible and the line says so rather than implying completeness.
  **★★ R31 — K STOPS BEING AN ANOMALY AND BECOMES A ONE-LINE FIX.** `Runs in scope: 18` heads a body
  naming **23 distinct run ids**, and this cycle the excess is fully accounted: the census counts
  `W1-T*` implement runs (8 `blocked_containment` + 6 `blocked_ci` + 4 `merged` = 18, closing exactly)
  while the harvest additionally prints **five `DAEMON-*` lane runs** — one of them,
  `DAEMON-1787749707742`, starting 30 minutes BEFORE the marker. **The document is not miscounting; it
  is printing two populations under one heading with no label on either.** That collapses K's remedy
  from *verify the run set* to *name the lane and the clock beside each count* — clause (ii) above,
  which was already written. **K is now the cheapest of the three denominator instruments as well as
  the most urgent.**
  GOLDEN (fixture-only): a seeded window whose ledger holds 3 runs while GitHub shows 4 merged `run-*`
  branches prints `RUNS NOT IN SCOPE THAT MERGED — 1: run-X-…` and stamps the `runs` column; a window
  where the sets agree prints `none (0)`, never an empty section; a merged branch that is not
  `run-*`-shaped is ignored without comment.
- **R23's AND R24's per-cycle bullets are FOLDED (R24, extended by R27/R30)** — failure mining,
  procedural bullets and plan-health rosters superseded by later blocks; R24's *ten shapes offered,
  zero consumed* is now the standing P38 evidence line. **TASK K and TASK L survive above.**

**RETRO-1786867677764 (R20) — MINING HEADER FOLDED TO ONE LINE BY R32** (31 runs / 30 merged task
PRs of which the gather named 14 / 8 credits, 1 rejected trailer beside SIXTEEN merges lost without
any rejection at all; ZERO new numbers; proposed **TASK H**, **TASK I** and **BATCH J**, and promoted
R19’s unbuilt TASK G to the top of the dispatch order).

- **★ TASK H (P40/P42(i) — PRINT THE PER-RUN VERDICT ROW; THE GATHER CANNOT ADJUDICATE ITS OWN FAILURE
  MASS; proposed by R21, UNBUILT). ★ TASK E IS FOLDED IN HERE BY R25 AND ITS SEPARATE ENTRY IS DELETED
  — every later reference to "TASK E" resolves to this bullet.** E asked the gather to name the
  `incomplete` runs when that class held 17, then 11, of a window; **this cycle it holds ONE.** The
  population E was written against evaporated without E being built, which is *ask which side of the
  predicate moved* answered by the world rather than by a fix (BATCH J's lesson, second instance). What
  E contributed and H now carries: **(iv)** `plan/mast-mapping.yaml` gains rows for `incomplete` and
  `blocked` **derived from the ledger's own termination line rather than guessed**, and any class it
  cannot derive renders `unmapped(<class>)` naming the class, never folded into a silent remainder —
  which is the clause that survives at any n, because it is about REFUSING TO GUESS rather than about
  one class's size. GROUND TRUTH (mechanical, from R21's gather): the verdict block prints
  `{"blocked_ci":12, "incomplete":4, …}` — **counts with no run ids** — while the SHIPPED and
  discrepancy blocks print ids with no verdict context. The consequence was live this cycle: read
  from the gather alone, `blocked_ci` dominates at 39% with a 1-in-13 merged ratio, and **that
  reading is false** — at least 7 of the 17 supposedly non-merging runs own a merged PR (THE FIRST
  FINDING). A retro reading only this instrument would have mined eleven phantom defects. Every input
  exists: the ledger holds `(run_id, task, verdict, cost, turns)` and the resolver already maps task →
  merged PR. **WHY THIS IS NOT AN EXISTING NUMBER: TASK G emits merges no run owns; H is the inverse —
  runs that own no merge.** G and H are the two halves of one join, and R24 needed BOTH to tell its
  story.
  PROPOSE: **(i)** a `RUNS WITHOUT A MERGE` table — `run_id · task · verdict · turns · $ · sibling
  run credited for this task? (y/n) · task merged elsewhere in window? (PR|no)`; **(ii)** rows sorted
  verdict-major so a dominant class reads as a block; **(iii)** a one-line summary
  *"N of M non-merging runs belong to tasks that shipped anyway"* — the exact quantity the fold-line
  has been a proxy for since R8. GOLDEN (fixture-only): a window with two `blocked_ci` runs of the
  same task, one of which shipped via a sibling, renders both rows with `y/PR` and `n/no` and the
  summary `1 of 2`; a window with zero non-merging runs renders `none (0 of 0)`, never an empty table
  (**P48(ii)**); **the R20 window replayed renders 17 rows and a summary of at least `7 of 17`** — the
  assertion that would have prevented this cycle's phantom regression.
  **★ R27 EVIDENCE, IN PLACE (supersedes R26's) — H IS NO LONGER A CONVENIENCE, IT IS THE ONLY WAY
  THIS CYCLE'S FOLD-LINE READING EXISTS AT ALL.** R26 could derive its `11 of 17` by hand. **R27 could
  not, and published UNCOMPUTABLE instead** (see the fold-line): of 35 non-merging runs, the gather
  names the task for only the 23 guard-fired ones — and those 23 are ONE host storm, so counting the 18
  of them whose tasks shipped would be 18 readings of a single event (rule 8). **The other 12
  (`blocked_ci`×11, `blocked`×1) are not task-named anywhere in the gather**, so no denominator exists.
  **The requirement H must now satisfy is therefore stronger than "print the row": the row must carry
  the run id, the task, the verdict STRING, whether a sibling shipped, and whether the verdict was
  guard-fired** — because without that last flag a correct H would have published a spectacular and
  meaningless 78%. R26's addition (print the verdict string, not only its bucket) stands: `failed`×1 was
  unexemplified last cycle and `blocked`×1 is unexemplified this one.
  **TASK K** remains its companion: H enumerates the runs the gather scoped, K asks whether that
  enumeration is complete.

- **★ TASK I (P30 — NAME THE CHECK THAT BLOCKED, ONCE, AT BLOCK TIME; R21's mint, UNBUILT FOR FIFTEEN
  CYCLES — the "NEW THIS CYCLE" label it carried was stale by fourteen and is corrected here).**
  **★ R29's READING: `blocked_ci`×10 is 67% of this cycle's non-guard failure mass and still records
  the WORD with no check name anywhere.** GROUND TRUTH:
  `blocked_ci` is 39% of this window and the ledger records the WORD, never the failing check. Eleven
  runs are therefore opaque by construction: no distribution over `ci` / `coverage-ratchet` /
  `containment-probe` / `claims` / `commitlint` exists anywhere, so nobody can tell one flaky gate
  from eleven distinct defects. This cycle's own harvest names two candidate causes from the worker
  side — a HOME-dependent `emissions.test.ts` failure and a `live-write-guard` boundary that names
  the CALL not the DESTINATION — and neither can be confirmed or refuted against the ledger.
  **WHY THIS IS NOT TASK H:** H asks *which runs*, I asks *which check*; H is one join over existing
  data, I needs one field written at block time. **WHY IT IS P30's and not a new number:** it is the
  same edge-triggered-write defect — the information exists exactly once, at the moment of the block,
  and nothing durable records it. PROPOSE: **(i)** when a run ends `blocked_ci`, append
  `ci.blocking_check` with the failing check-run name(s) and conclusion from the rollup already read;
  **(ii)** the retro gather prints the distribution, `none (0 blocked_ci runs)` when empty;
  **(iii)** never guess — an unreadable rollup writes `unreadable`, reusing T521/#1921's vocabulary.
  GOLDEN (fixture-only): a seeded red rollup with two failed checks writes both names; an unreadable
  rollup writes `unreadable` and NOT an empty list; a green rollup with a non-CI block writes nothing.
  **★ R27 EVIDENCE, IN PLACE (supersedes R22's):** `blocked_ci` is **11 of 52 runs and 92% of the
  non-guard failure mass** — the most concentrated share this class has held — and it STILL records the
  word with no check name, for a THIRTEENTH consecutive cycle. **This cycle also supplies the cleanest
  argument yet for why I is cheap and load-bearing: the containment guard shipped exactly this field
  (T1281/#2685 named its `observed` state) and the very next gather could split 23 rows into three
  causes on a chronological boundary.** One field, written at block time, turned an opaque count into a
  diagnosis in one window. **`ci.blocking_check` is the same field, on the larger class.** R22's
  Playwright-image hypothesis is neither confirmed nor refuted and stays recorded as a hypothesis, not a
  cause (P43(ii)).

- **★ BATCH J (PLAN-HEALTH CORRECTIVE — ONE BATCH, NOT TEN SHARDS; R20's proposal, UNBUILT FOR A
  FIFTH CYCLE).** GROUND TRUTH, as corrected in place by R23 and unchanged since: **W3-T3 and W1-T49 are
  OPEN, dispatchable, and declare no `files:` scope**, and `overlappingPaths` is FAIL-CLOSED on an empty
  scope, so each overlaps every co-dispatched candidate and serialises the lane. **R20 charged this
  proposal at TEN ids; W1-T1030/#2254 then exempted dispatcher-unreachable (`verify: human`) tasks and
  eight of the ten left the sweep without being fixed** — they were never dispatchable, so the "silent
  tax on P19's parallelism" was overstated by eight tenths. **That correction is the durable lesson and
  is why this entry is short: a roster shrinking is not the same as a defect closing — ask which side of
  the predicate moved before crediting anything.** PROPOSE: one plan-only PR declaring at least one
  repo-relative path per task, plus **a lint-plan rung that REFUSES an OPEN task with an absent-or-empty
  `files:`** so the class cannot recur. **WHY ONE BATCH:** two shards for one mechanical defect is P8's
  accretion mode; the sweep proposes two corrective tasks each cycle and this plan declines both in
  favour of one edit. GOLDEN (fixture-only): a fixture task with `files: []` and one with the key absent
  both FAIL lint-plan with the scope reason; a task with one path PASSES; a `verify: human` task is
  exempt only if the frontier already excludes it (T375). **★ R27: byte-identical for a FIFTH cycle —
  five retros have now re-derived a two-line edit, which is more attention than the edit costs.**

**RETRO-1786799102812 (R19) — MINING HEADER FOLDED TO ONE LINE BY R32** (46 runs / 25 PRs / 12
credits, 19 rejected trailers of which 14 were the task’s OWN later run; ZERO new numbers; proposed
**TASK G** under P47, whose canonical entry follows). **Its durable lesson survives in the fold-line
above: 10 of 16 `blocked_*` runs demonstrably merged.**

- **★★ TASK G — UN-RETIRED 2026-08-29 BY R36. THE ONLY REVERSED RETIREMENT IN THIS LOG, AND IT IS
  REVERSED ON A PRE-COMMITTED READING RATHER THAN ON SECOND THOUGHTS.** Filed by R19 as *emit the
  orphans: a merged trailer no run owns must be PRINTED, not dropped*, and the top dispatchable item in
  this file for seven cycles on readings of 2, 16, 12 and 10 lost merges. **R34 retired it by DELETION
  on a fourth consecutive zero** (DR-9), having checked where its members went (rule 18) and
  found them on hand-named branches losing their trailer at the squash commit — the reading that became
  **P58**, which keeps G's surviving clause *(iv) the section must state which SURFACE it reads the
  trailer from*. **R35 then read the class at three (#3189, #3175, #3185), found all three were also
  TASK L's, and left G retired on the ground that the two letters name one population.**
  **★ THAT ARGUMENT IS REFUTED BY ONE MEMBER.** **#3237/W1-T2387** merged in-window from
  `run-W1-T2387-1787945900779` with a valid `Remudero-Task:` trailer in **both** the PR body and the
  squash commit, is credited by nothing, and **its run started +6.03 h AFTER the marker** — so TASK L's
  straddler definition cannot reach it and G's cannot be a relabelling of L's. **R35-2 registered this
  exact test and named its own consequence in advance**, so the restoration is executed, not argued.
  **WHAT G ASKS FOR, RESTATED IN ITS SMALLEST FORM:** *(i) every in-window merge carrying a
  `Remudero-Task:` trailer on either surface that no run in the declared set is credited with must be
  PRINTED by the gather, with its head branch, its run-start decode and the reason it was not credited*
  — which is the instrument that would have surfaced all four of this cycle's uncredited merges without
  a REST sweep, and the one that would have made #3237's disjointness visible at merge time.
  **CLAUSE (iv) STAYS WITH P58** and is not reclaimed. **HOW G DIFFERS FROM ITS NEIGHBOURS, since the
  accretion failure mode P8 named is the real risk here:** **TASK L** reconciles the WINDOW (straddlers);
  **P47** widens what the gather PRINTS about runs it already knows; **P60** fixes the RESOLVER's pick;
  **G prints the merge the resolver has no run for at all.** #3237 is in G's reach and outside L's, and
  the three straddlers are in both — which is exactly the overlap **DR-20** now forbids reading
  as identity. **PRE-COMMITTED, so this reversal is not free:** if **R36-2** reads zero disjoint members
  for **three consecutive cycles**, G is re-retired for cause — and under **P59**'s clause (iii) that
  re-retirement is itself registered as a scorable row, not performed silently.
  **★★★ R43 — TASK L IS FOLDED IN HERE, AND G BECOMES THE SEAM'S ONLY LETTER.** R42-2 pre-committed
  that a second consecutive EMPTY reading of TASK L would re-derive or retire it; this cycle **zero
  in-window `run-W1-*` merges are uncredited**, so TASK L, TASK G and P64's quantised class all read
  zero at once. Under **DR-18** the members are accounted for — they went into the CREDITED population,
  because the union credited 14 of 14 — and under **DR-19** no still-held class would claim them. **But
  the seam is not closed; it changed SIGN.** Two of this window's sixteen runs end it holding an OPEN PR
  (**#3619/W1-T2609**, **#3629/W1-T2610**), which is a run in flight across the marker in the FORWARD
  direction — invisible to L's backward-looking definition and to every in-window instrument. **L's
  durable clause therefore moves here intact, generalised to both directions, and L's separate 64-line
  entry is DELETED (git holds it):** *the gather computes, from GitHub, (a) merged `run-*` PRs in
  `[previous marker, this marker]` whose run id predates the window they merged in, (b) declared runs
  whose PR is still OPEN at this marker, and (c) merged `run-*` PRs no run in the declared set is
  credited with — printing them as `STRADDLERS-BACK — n:`, `STRADDLERS-FWD — n:` and `ABSENT RUNS — n:`,
  each `none (0)` when clean, never silently dropped; and it STATES which clock the window is cut on in
  one line.* **A straddler is credited to the cycle in which it MERGED — one rule, stated, never both.**
  P51 stays folded here with it. **THE MOUNT FREEZE DOES NOT COME WITH IT:** R33 attached the freeze's
  release condition to TASK L, and **R43 moves it to P65's changed-files classifier**, because a release
  condition must name a class that exists and this one has read zero twice. **RE-REGISTERED as R43-2 in
  all three arms, with its own pre-committed consequence:** three zeros and the seam letter is retired
  by deletion, with nothing inheriting the freeze.
- **R19's failure-mining and procedural-success bullets are FOLDED (R20) — both were per-cycle
  restatements of standing lines.** Failure mining: 10 of 16 `blocked_*` merged, 6 guard-fired
  containment events already filed as W1-T501/#1847, `incomplete`×7 to TASK E — all of it now lives in
  the fold-line above and in R20's own block. Procedural success: a 12-run
  `clean_single_strike × fully_executed_proof` shape against a LEARNINGS corpus reading 74 / `0
  added` — P38's ninth frozen cycle, superseded by the tenth recorded above.

**RETRO-1786578394991 (R18) — MINING HEADER FOLDED TO ONE LINE BY R32** (34 runs / 12 shipped / 7
credits, 17 rejected trailers split 10 self-redispatch / 7 foreign-proper; ZERO new numbers; proposed
**TASK F**, whose canonical entry follows).

- **★ TASK F (P47 — SPLIT THE REJECTION COUNTER BEFORE SHIPPING THE FIX). CLAUSE (i) IS NOT A PROPOSAL
  — R24-2's PRE-COMMITMENT FIRED AND THE WORD `foreign` IS STRUCK BY THIS PLAN'S AUTHORITY. ONLY
  CLAUSE (ii) REMAINS UNBUILT.** **Cumulative across every cycle that printed any rejection: 0 of ~72
  name a different task's branch** (R12's 25, R14's 23 ALL-SIBLING, R19's 17, R24's 22, R25's 5, R26's
  2, **R30's 5**). **★ R30 EVIDENCE, IN PLACE — CLAUSE (ii) GETS ITS FIRST TWO-SIDED EXHIBIT.** The
  gather prints **5 rejections, all naming a SIBLING run of the same task**, and the two tasks they
  fall on resolve OPPOSITE ways: **W1-T2275's** three sibling runs end with the merge credited (the
  union rescued #2923), while **W1-T2292's** two sibling rejections name a head branch,
  `run-W1-T2292-1787729473286`, whose own run **is printed in the harvest with #2926 beside it and is
  credited by nothing.** Same counter, same word, one *bookkeeping* and one *lost credit* — which is
  precisely the distinction clause (ii) exists to print, now observable in a single cycle instead of
  argued across two. GROUND TRUTH AS FILED:
  the gather emits ONE word — `stale/foreign` — for two unrelated mechanisms. A rejection naming
  `run-<SAME task>-<different ts>` is the ownership-assert working as P29's lesson (a) requires; one
  naming a stranger's branch is the actual P47 defect.
  **SEPARATE FROM TASK C** (C changes trailer emission and reading; F changes only what the gather
  PRINTS, has no runtime surface, and must land FIRST or C's effect is unmeasurable). PROPOSE:
  **(i)** the discrepancy resolver classes each rejection as `rejected.self_redispatch` (offending
  head branch matches `run-<same task>-*`) or `rejected.foreign` (anything else) and the gather prints
  **two labelled counters, never a sum**; **(ii)** a `self_redispatch` rejection additionally reports
  whether the task was credited by some other run, so the line distinguishes *lost credit* from
  *bookkeeping*. **(R19's and R22's per-cycle evidence blocks DELETED BY R25; R27's vacuous-zero note
  DELETED BY R30 as superseded by the live exhibit above. One durable detail is preserved:
  R19 saw ONE row of a genuinely different shape, `run-W1-T485-…` rejected against **W1-T464**, and the
  two-way rule classes it correctly without needing a third bucket.)** GOLDEN (fixture-only, no live
  dep): a seeded pair whose offending branch is `run-X-2` against run `run-X-1` renders
  `rejected.self_redispatch` and, when X is credited elsewhere, `credited_elsewhere: true`; **a seeded
  pair whose offending branch IS the run's own (`run-X-1` against run `run-X-1`) renders
  `rejected.own_pr` and is a BUG THE RESOLVER MUST NOT PRODUCE — the fixture exists to prove it cannot**
  (R25's addition, from THE SECOND FINDING); a seeded pair on `claude/whatever` renders
  `rejected.foreign`; a gather with both renders **two counters and no combined total**; and a run of
  ten self-redispatch rejections NEVER increments the foreign counter.

**RETRO-1786537819709 (R17) — MINING HEADER FOLDED TO ONE LINE BY R32** (64 runs / 27 PRs / 5
credits, 37 rejected trailers — 18 FOREIGN, 19 SIBLING; ZERO new numbers; proposed **TASKS C, D and
E**, whose canonical entries follow and are maintained IN PLACE). **STANDING FOR EVERY BLOCK BELOW:
candidates are ratified via a tasks.yaml PR. HISTORICAL: written under the unwritten no-auto-filing
doctrine, mis-cited as a §12 rule number; rule 27 now permits automatic filing.**

- **★ TASK C (P47 — TRAILER EMISSION AND TRAILER READING, BOTH ENDS). ★★ CLAUSE (a)'s EMISSION HALF
  IS CLOSED BY SHIPPING — T1012/#2240 committed the trailer rather than leaving it in the body —
  AND R30 CONFIRMS IT OUT-OF-BAND: all SIX merge commits it read by hand (#2942, #2946, #2931, #2926,
  #2905, #2828) carry `Remudero-Task:`, including the ABSENT RUN's.** That is the sharpest thing this
  cycle can say about the class: **the trailer is no longer the failure point, so every remaining
  uncredited merge is a READER or a RUN-ROW defect, not an emission one** — which narrows TASK G, TASK
  K and P51 and closes nothing else. **R17's W1-T419 exhibit and R20's sixteen-lost-merge hypothesis
  are DELETED as superseded by that shipping** (git holds them); the durable statement of the thesis
  survives: **P47 owns *nothing governs who may emit a `Remudero-Task` trailer*, and TASK C owns its
  symmetric half — nothing governs where it is READ from.**
  PROPOSE (what remains unbuilt): **(a-reading) `deriveStatus` reads the SQUASH COMMIT as well as the
  body, preferring the commit** — still open, and now the only half of (a) left; **(b) a PR carrying
  `Remudero-Task: X` on a branch that is not `run-X-*` is REFUSED at creation unless it carries an
  operator-set `Remudero-Adopt: X`, ledgered `trailer.refused_unowned_branch`** (P47(i) verbatim).
  GOLDEN (fixture-only): a merge whose body carries the trailer but whose squash message does not is
  CREDITED, and so is its mirror; a merge with the id in the TITLE only is reported
  **`trailer.absent`, never silently uncredited** (P48(ii) — the W1-T419 case, and T513/#1888's);
  a trailer on `feat/whatever` is REFUSED and the same trailer on `run-X-<ts>` ACCEPTED; the refused
  PR carrying `Remudero-Adopt: X` is accepted and credits X exactly once.
  **★ R21 EVIDENCE, IN PLACE — A THIRD CLAUSE, AND IT IS THE READING SIDE'S MISSING FALLBACK.**
  **(c) when every trailer candidate for task X is refused, the reader falls back to the MERGE SET and
  credits a merged PR whose head branch is `run-X-*`**, ledgering `trailer.credited_by_branch`.
  GROUND TRUTH: W1-T534 — #1977 refused (correctly, `retro/2026-08-16b`), #1967 merged on
  `run-W1-T534-1786886488695` with `Remudero-Task: W1-T534` in the body, credited by nothing. The
  branch is already the identity the ownership-assert uses to REFUSE; clause (c) is that same identity
  used to ACCEPT, and it costs one query the sweep already makes. GOLDEN: a fixture where the only
  trailer candidate is foreign AND a merged `run-X-*` PR exists credits X exactly once via
  `trailer.credited_by_branch`; the same fixture without the run-branch merge credits nothing and
  reports the refusal; a fixture with BOTH a valid trailer and a run-branch merge credits X once, not
  twice.

- **★ TASK D (P40(i) — TURN COVERAGE IS A DENOMINATOR, NOT AN AVERAGE; UNBUILT, and as of R19 the
  TOP-RANKED work in this file).** GROUND TRUTH (mechanical): R17's gather showed **12 of 26
  union-listed shipped runs reporting nonzero dollars and EXACTLY 0 turns** (W1-T364 $14.451/0t and
  T387 $15.477/0t the dearest), 4 more at $0.000/0t, and printed `avg turns 17.781` over all 64 runs
  regardless. A run that cost $14.451 did not take zero turns; **0 is UNRECORDED wearing a number's
  clothes.** *(Per-run enumeration DELETED by R19 — the pattern is the finding, not the twelve ids.)*
  **★ R19 — THE COST IS NO LONGER HYPOTHETICAL AND THE PATTERN IS NO LONGER A SUSPICION:** coverage
  read 46% → 100% → **4%** across three consecutive windows with nothing built, and **24 of 25 shipped
  runs this cycle report real dollars against 0 turns**, $288.330 total against 173 recorded turns.
  THE DEMONSTRATED COST: **R16-1 and R17-1 both died on this metric**, R18's falsifier FIRED on it, and
  **R15-1 — the only `HIT` this plan had before R18-4** — is known to rest on an instrument that can go
  dark silently. PROPOSE: **(i)** the calibration table prints TURN COVERAGE
  (runs with nonzero turns / runs, and separately runs with `cost > 0 ∧ turns = 0`) beside every turn
  figure; **(ii)** it **REFUSES to print an average** whose coverage is below a policy threshold,
  emitting `turns: UNMEASURED (12/26 shipped runs report $>0 with 0 turns)` instead of a number;
  **(iii)** a run with `cost = 0 ∧ turns = 0` is classed `unrecorded`, distinct from a genuine zero.
  This is P48(ii) — no naked zero — applied to the retro's OWN instrument, which is the fairest place
  to prove the proposal works. GOLDEN (fixture-only, no live dep): a seeded ledger where every run
  reports turns prints the average with `coverage 100%`; a seeded ledger where a third report 0 turns
  against nonzero cost prints UNMEASURED and NAMES the count, and a test asserts the numeric average
  is absent from the output; a seeded run at $0/0t renders `unrecorded`, not `0`.
  **★ R26 — D's PREMISE IS NOW OBSERVABLE IN ITS PUREST FORM, AND ITS SCOPE IS BACK TO WHERE R19 LEFT
  IT.** R25 shrank D to *state the retention bound and divide by it* on two clean boundary measurements.
  **R26 observes 0 turns AND 0 output tokens on 31 of 31 runs while $171.844 was spent** — no boundary,
  no prefix, no partial set: the columns are simply absent. **Retention cannot produce that**, so the
  shrink is withdrawn and D's real first question is the one it was originally written for: *is the turn
  column retention-limited or not written at all?* **Clause (ii) is now the load-bearing one** — the
  gather DID stamp `⚠ 0% coverage — DO NOT USE` on its derived per-merge columns and then published the
  same zero UNSTAMPED as `avg turns 0`, `turns this week 0` and `share of weekly burn 0.0%`, so the
  refusal D proposes exists in one place and not in the three that feed the mount table. **That is the
  cheapest possible demonstration that D is worth building, and it cost nothing to observe.**

**RETRO-1785992364048 (R16) — MINING HEADER FOLDED TO ONE LINE BY R32** (36 runs / 25 PRs /
12 credits, 10 rejected trailers; ZERO new numbers; proposed **TASK B**, whose canonical entry follows
and is maintained IN PLACE).

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

- **★ P47 (plan + golden; RANK 1 as of R20, HELD BY R21–R27 — promoted on R19-1's second MISS
  and sustained by R22-1's fifth) — TRAILER EMISSION AND
  CREDIT RESOLUTION ARE UNOWNED: THE HARNESS POISONS, AND NOW SILENTLY LOSES, ITS OWN TASKS.**
  **★★ R39 EVIDENCE, IN PLACE (supersedes R38's, which is folded to its last line below) — THE CLASS
  IS AT ITS MAXIMUM, THIRTEEN, AND EIGHT OF THE THIRTEEN ARE PRINTED WITH THEIR PR URL IN THE SAME
  GATHER THAT FAILS TO CREDIT THEM.** Uncredited IN-WINDOW `run-W1-*` merges: **13 of 21** — #3348/T2476,
  #3353/T2496, #3371/T2499, #3372/T2497, #3375/T2502, #3376/T2492, #3377/T2532, #3378/T2505,
  #3389/T2500, #3394/T2507, #3398/T2511, #3400/T2536, #3403/T2537. **The ledger credits 2, the union 8 —
  the lowest credit reading in this log (9.5%) and its first exit BELOW the band.** **★★ AND THE NEW
  PART, WHICH IS WHY THIS IS THE CLASS'S SHARPEST READING RATHER THAN MERELY ITS LARGEST:** #3353,
  #3371, #3372, #3375, #3376, #3378, #3389 and #3394 each appear **WITH THEIR PR URL, keyed to their own
  run id, in the gather's Follow-up harvest** — the credit resolver and the harvest read the same ledger
  rows, and one of them emits the (task, run-branch, PR) triple while the other emits nothing.
  **P47's remedy — print every run and every candidate — is precisely the join that is missing, and no
  REST read is needed to see it: both halves are already inside the document.** Split by run start:
  11 TASK G, 2 TASK L.
  **★ R38 EVIDENCE, FOLDED TO ONE LINE BY R39:** 7 of 17 uncredited (#3336, #3338, #3335, #3331, #3340,
  #3350, #3354), every one a TASK G member with zero straddlers beside them, ledger 8 / union 10 — and
  P47's printout was also what would have exposed that cycle's five-fold duplication (**P62**) without a
  hand-decoded epoch sweep.
  **★★ R34 EVIDENCE, IN PLACE (supersedes R27's) — THE RESIDUE READ ZERO FOR THE FIRST TIME, AND THAT
  IS NOT THE SAME AS THE DEFECT CLOSING.** Uncredited IN-WINDOW `run-W1-*` merges: **0 of 9.** The
  union credits **9 of 9**, the ledger 5, and **no run was in flight across the marker**, so TASK G's
  species and TASK L's species are both empty in one cycle for the first time. R27's reading (14 of 31,
  45%, splitting 10 printed-but-uncredited + 4 straddlers) is superseded, not deleted from history —
  the SHIPPED log's R27 header carries it. **THE SHARPEST READING IS AGAIN THE COMPARISON, AND IT GOES
  THE OTHER WAY THIS TIME.** The residue did not converge; **it changed namespace.** In the same window
  **8 code merges carrying valid task trailers landed on hand-named branches, 7 of them losing that
  trailer at the squash commit** — a population P47's clauses never described and the gather never
  prints. **TASK G WAS RETIRED ON THIS READING and P58 minted for where its members went — G is
  UN-RETIRED BY R36 on a member no held class can claim; see its own entry** (design
  rule 18). **P47 HOLDS RANK 1** because its instrument is what made this window checkable at all —
  **but its rank is now on notice: PRE-COMMITTED, if the uncredited `run-W1-*` count reads zero AGAIN
  next cycle, P47 is re-argued against P58 in a PR that says so out loud** (R34-2's tie-break).
  **★★ R36 — THE CLASS IS THE LARGEST IT HAS EVER READ, AND FOR THE FIRST TIME ITS MEMBERS ARE NOT ALL
  ONE KIND.** Uncredited in-window `run-W1-*` merges: **4 of 17** — #3217 (−2.34 h), #3218 (−1.79 h),
  #3219 (−1.79 h) and **#3237 (+6.03 h, INSIDE the window)**. The R34-2 notice above LAPSED last cycle
  (the count read 3, not zero) and lapses again. **P47 HOLDS RANK 1 on a refilled and now heterogeneous
  class**, and its instrument — the gather printing what it can SEE but does not credit — is the one
  thing that would have made #3237's disjointness visible without a REST sweep. **It is ALSO not
  sufficient on its own, which is why P60 enters directly beneath it:** printing #3237 would have
  exposed the loss; only a filter-not-picker resolver credits it.
  GROUND TRUTH (mechanical, R15's originating gather): of **22 rejected trailers, 12 were
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
  **★ EVIDENCE LOG (R16–R19 prose FOLDED BY R19 and again by R21; git holds every restatement).**
  **The rejection-count series is a NOISE BAND, not a trajectory: 0 → 12 → 4 → 18 → 17 → 19 → 1 → 2**,
  every reading taken with P47(i) UNBUILT, so no retro may call any move an improvement or a
  regression — and R20/R21 prove the counter can read LOW while credit loss runs high. Four durable
  refinements survive. **(a) CLAUSE (i) KEYS ON BRANCH OWNERSHIP ALONE** — every poisoning on record
  came from an actor with a plausible topical claim (R16's #1361 edited the very policy row its task
  was about), so "actors that plausibly own the topic" is not an exception, it is the population.
  **(b) CLAUSE (i) MUST MATCH THE PATTERN THE CREDIT PATH ENFORCES, not the one the plan states** —
  R17's slug-form `run-<task>-<slug>` branches pass a `run-X-*` glob and still lose credit. **(c) THE
  READER IS AS UNGOVERNED AS THE EMITTER** — #1609 carried the id in its TITLE only; TASK C's reading
  half is the only thing that credits it. **(d) EMISSION DISCIPLINE IS NOT SUFFICIENT, PROVEN THREE
  CYCLES RUNNING** — R19's W1-T481/#1797 and W1-T490/#1825, R20's sixteen, and R21's twelve all rode
  CORRECT `run-<task>-*` branches with correct trailers and were credited by nothing. **R21 sharpens
  the diagnosis to a named step**: for W1-T534 the resolver examined a foreign PR, refused it
  correctly, and never asked whether the run's own branch had merged — #1967 had. P47 therefore needs
  all three halves, and the reading/reporting halves now carry the evidence: TASK C governs who may
  emit AND adds the branch fallback (arm c), TASK F names the two rejection mechanisms (one of R21's
  two rows is mislabelled), and TASK G makes the orphan visible at all.
  **★★ R31 — RANK 1 HOLDS, BUT THE BINDING INSTRUMENT INSIDE P47 CHANGED FOR THE FIRST TIME.** The
  W1-T51 union credited **all nine** in-window merges whose run started inside the window, so
  **TASK G's in-window reach this cycle is ZERO** — the set difference it exists to print would print
  `none (0)`. The entire uncredited residue (**three merges, 25% of the window's ships**) is
  **TASK L's**: straddlers at −13.49 h, −1.16 h and −1.15 h. **P47 is NOT re-ranked and NOT re-scoped
  on this** — one cycle is not a series (rule 11), G's reach is measured only *inside* the window and
  says nothing about the emission/reading halves, and a proposal whose weight shifts between its own
  instruments has not changed its claim. What IS recorded is the ordering consequence: **if a second
  cycle reads G-at-zero with L holding the residue, the cheapest first build under P47 is L, not G** —
  registered as the standing question rather than acted on. **★ AND ONE SUB-DEFECT IS NEW:** the single
  printed-but-uncredited merge (W1-T2304/#2952) prints a `DAEMON-*` run id beside its PR URL rather
  than the `run-W1-T2304-…` branch that merged — **so even the harvest's own join key is the wrong
  key**, which is TASK C's emission half and TASK G's reading half meeting in one line.

- **★ P48 (plan + golden; NEW — session-mined `oper#outcome-proposal-2026-08-05`, NOT a retro mint,
  PENDING RATIFICATION: an agent may RECOMMEND a direction but may never RECORD one — the operator
  ratifies) — ZERO IS OVERLOADED: A BOUNDARY READ'S EMPTY ANSWER MUST SAY WHICH EMPTY IT IS, AND NO
  NAKED ZERO ENTERS A DECISION WITHOUT A POSITIVE CONTROL.** GROUND TRUTH (mechanical, from the
  2026-08-05 census in docs/research/research-laws-and-gaps-2026-08-05.md, re-derived at 0332dd0): **21
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
  the criterion), **each with its status re-verified at d767c16 and carried INLINE rather than corrected in
  a later paragraph**: (1) `parseAcceptanceBlock` (src/lib/review.ts) — **OPEN**, still returns a bare
  `AcceptanceCriterion[]`, truncation indistinguishable from a one-criterion body; (2) the proof
  resolver's zero-candidate path — **CONVERTED** by #1111 to
  `NameFilterResolution = resolved | absent | unresolvable`, clause (i)'s exact shape, its own comment
  drawing the line (*"Zero hits. Everything below decides whether that is EVIDENCE or IGNORANCE"*);
  (3) the ledger union — **SHIPPED** as `rmd ledger-grep` (W1-T379/#1436, src/lib/ledger-grep.ts), one
  verb that FAILS LOUDLY when no archive was read; (4) the sweep-survey truthiness gates — **OPEN,
  verified**: `if (actionable.length)` wraps the ONLY `log("daemon.clone_reap", …)` in run-task.ts, so
  a reaper that ran and found nothing and a reaper that never ran are identical in the ledger. The two
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
  boundary's caller test fails when `absent` is collapsed into `found: []`. PROPOSED RANK 4, argued
  not assigned: above P43 because these instances blinded production paths, not only retro readings;
  below P38, whose TASK A is the narrowest standing fix. *(R19: the live ranking line is the ONE place
  order is recorded; the stale `P29 > …` string once quoted here is DELETED.)*
  **★ R27 EVIDENCE, IN PLACE — THE `no naked zero` CLAUSE IS BEING HONOURED BY THE GATHER AND
  VIOLATED BY THE GATHER, IN THE SAME DOCUMENT.** Honoured: the replay leg prints *"NOT a confirmed 0%
  — the golden suite simply did not run"* (fifth cycle), the mutation gate prints *"NOT zero escapes —
  an unmeasured history, N=0"* (tenth cycle), the plan-health sweep reports 7 proposal-subject lines as
  **skipped-and-reported rather than dropped**, and the learnings judge now declines three promotions
  **under three distinct named reasons instead of one bucket** — that last one is clause (i)'s outcome
  type arriving in an instrument nobody filed a P48 tranche task for. Violated, in the same gather:
  **`share of weekly burn: 100.0%` is published UNSTAMPED over a denominator equal to its own numerator**,
  one table away from two columns the gather itself stamps `⚠ 2% coverage — DO NOT USE`, and **`avg turns
  3.212` is published unstamped off the SAME numerator those two stamped columns derive from.** One
  instrument, two standards, inside one table — which is the precise shape clause (ii) exists to forbid,
  and it has now appeared in three consecutive cycles wearing a different number each time (`0 turns`,
  `0.0%`, `100.0%`).
  **THE ENTRY WAS RE-FOUNDED WITHOUT THE CENSUS, AND THE CENSUS HAS SINCE BEEN RECOVERED** (loss
  established 2026-08-11, re-verified at d767c16; re-founded 2026-08-12 at `4c25957` by operator
  ruling — *re-found, do not restore the 21*; a session may not ratify, so the PROPOSAL still AWAITS
  RATIFICATION and what is settled is the METHOD, not the adoption). **THE RE-FOUNDING RULING STANDS
  AND IS NOT REOPENED HERE**; what changed is only the availability of the evidence. The report was
  recovered VERBATIM into the tree at `f7201d4d` (#2623) and now lives at
  `docs/research/research-laws-and-gaps-2026-08-05.md` — its Part 1, LAW 1, carries the census, and
  the six mechanism classes ARE enumerated there (line-oriented parses, substring/anchoring, demoted
  errors, optional-field gates, truthiness-on-count, representation drift under a fixed query). So
  this entry is no longer the only carrier, and the earlier claim that the file was unrecoverable and
  never committed on any ref described the `state/` path, not the content. What remains TRUE and is
  left standing: no selecting predicate was stated, and the 23-row denominator behind "21 of 23" is
  unexplained — it appears exactly once in the recovered report, unexplained there too. **The 21 is NOT
  reconstructed, membership no longer cites the census**, and two of the four tranche members were
  fixed while the proposal stayed unratified — its substance is being adopted while its old membership
  rule remains inoperable. What IS checkable is the re-derived faces below and the tranche list's own
  verified statuses. *(R19/R21: a stale list plus a paragraph saying so is two copies of one fact.)*
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
  **(2) ONE PREDICATE PER FACE — DEFINITIONS KEPT, POPULATION COUNTS DELETED 2026-08-19 (R22
  compression).** The counts were measured once at `4c25957`, a SHA now ~700 commits behind head, and
  this plan's own rule forbids quoting a stale measurement as a live one — the PREDICATES are the
  durable artifact, because anyone can re-run them.
  **FACE 1 — UNDERCOUNT-AS-ANSWER.** An EXPORTED function whose declared return type is a bare
  collection or count (`T[]`, `number`, `Map<…>`, `Set<…>`) with no discriminated outcome, AND whose
  result is consumed by a caller that branches on emptiness. **STATED LIMITATION:** the signature half
  is exact, the consumer half is a TEXT APPROXIMATION that misses a zero reached through an alias,
  destructure or helper — exactness needs a TypeScript-compiler-API call-graph pass, so this half
  UNDER-COUNTS and must never be quoted as a closed set.
  **FACE 2 — SELF-HIDING OBSERVABILITY.** `if (<expr>.length <cmp>)` across `src/**/*.ts` where the
  comparison separates empty from non-empty (bare `.length`, `> 0`, `!== 0`, `=== 0`, `>= 1`, `< 1` —
  NOT `> 1`, which is cardinality), and EVERY statement in the consequent is a logging call, so the
  zero case writes nothing.
  **FACE 3 — ABSENCE-AS-SUCCESS: RECORDED INSTANCES ONLY, BY NAME. There is no predicate, and that is
  the honest answer, not a gap left open** — the face is behavioural (a zero that WIDENS scope instead
  of narrowing) and "wider" is not visible in text. A member joins only with a behavioural fixture
  showing the widening. **Recorded members: none open.**
  **(3) THE CRITERION IS A UNION, NOT A SUBSTITUTE.** A boundary qualifies when it **MATCHES ANY
  STATED FACE PREDICATE and has no second channel at head** — and for a face with no predicate, when
  it is a **NAMED RECORDED INSTANCE carrying its evidence**. A face-2-only criterion was REFUSED on
  measurement: it would have admitted one of four members and expelled three.
  **(4) MEMBERSHIP: 3 open** — `parseAcceptanceBlock` (face 1) and the sweep-survey gate (face 2)
  QUALIFY; `ledgerRotationEntries` is RELOCATED (the verb `rmd ledger-grep` shipped and fails loud,
  W1-T379/#1436, but the function below it still returns a bare array);
  `resolveNameFilteredCandidates` is DISCHARGED, not a member.
  **(5) THE ENTRY'S OWN FIGURES COULD NOT BE REPRODUCED — AND THAT IS THE STRONGEST ARGUMENT THIS
  PROPOSAL HAS, BECAUSE IT IS P48's DEFECT ONE LEVEL DOWN, INSIDE P48's OWN SUPPORTING SWEEP.**
  #1587 recorded OUTPUTS and never the QUERY, and its numbers did not reconcile with themselves.
  Neither classifier could be preferred, because only one of them was written down. **Every predicate
  above is stated in full FOR THAT REASON, and that is precisely why deleting the counts costs
  nothing while deleting the queries would have cost everything.**
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

- **★★ P67 (credit + golden; R43's mint, rank PROPOSED at 2 directly under P47) — A MERGE IS SCORED AT
  THE INSTANT IT LANDS AND NOTHING EVER RE-READS THE TRUNK, SO THE HARNESS PUBLISHED ITS OWN WORST
  MERGE AS THE CHEAPEST AND MOST SUCCESSFUL ROW IN ITS TABLE.**
  **GROUND TRUTH, REST-VERIFIED (DR-16 — the ARTIFACT, not the attribution):** **W1-T2608/#3611**
  (`run-W1-T2608-1788342481891`) merged at **2026-09-02T09:57:40Z**. Its diff was *correct on the
  facts*: it replaced a false claim in `docs/operator-guide.md` — that Rule 21 never reads `files:` —
  with the accurate post-merge-field-drift behaviour. But `checkCorrectableAndGateNamed` pins **three**
  literal phrases from that guide, and the rewrite dropped the third (`no gate blocks it`), so
  **`test/declared-files-correction-exit.test.ts` failed on `main` itself**, and every open PR inherited
  the failure through `ci` and all four `ci-shard` jobs. **#3622**
  (`fix/guide-restores-the-phrase-its-contract-test-pins`, a `fix/*` branch with no run and no ledger
  row) restored the phrase at **11:00:10Z** — a **62-minute red trunk** — and its body carries the
  measurement on both sides of the introducing commit, same tree and same runner (`ffbb2bab^`
  *pass 1 / fail 0*; `ffbb2bab` *pass 0 / fail 1*), plus the sentence this entry is minted on:
  ***"#3608 and #3613 are both blocked by this and by nothing of their own."***
  **WHAT EVERY INSTRUMENT IN THIS FILE SAID ABOUT THAT RUN:** the ledger wrote `merged`; the W1-T51
  union credited it; the BY TASK CLASS table publishes it as the `docs` row at **100% merge rate and
  $1.959, the cheapest run in the window and the highest-scoring row in the table**; the
  procedural-success miner lists it among twelve `[clean_single_strike, fully_executed_proof]` runs.
  **Four independent instruments, one unanimous commendation, and the merge broke the trunk.**
  **THE SECOND-ORDER HARM, WHICH IS WHERE THE ACCOUNTING GOES WRONG:** **W1-T2604's run ended
  `blocked_ci`** and its PR #3608 merged gate-side only at 11:28:55Z, after the repair. The gather files
  that verdict under MAST `verification` as one of four failures **on the task's own record**, so this
  document currently attributes one task's regression to a different task's competence. And the repair
  itself was authored by a lane with no ledger row, so **the cost of the defect was charged to the only
  population this document cannot price** (P65, DR-25).
  **HOW P67 DIFFERS FROM ITS NEIGHBOURS, since the accretion failure mode P8 named is the real risk
  here:** **P56** is a credited merge that implemented NOTHING — #3611 implemented exactly what it
  claimed. **P63** is a gate whose remedy the declared scope forbade — nothing forbade this remedy; it
  simply was not looked for. **P65/P66** are about work the instruments cannot SEE — this merge was
  seen by all of them, correctly, and read backwards. **P47** owns what the gather PRINTS about credit;
  P67 owns WHEN the reading is taken. **The distinguishing member no neighbour can claim: a merge that
  is correct, credited, cheap, and harmful.**
  **PROPOSE (i)** the gather emits `TRUNK REDS — n: <breaking-pr, red-interval, repairing-pr,
  blocked-prs>` for the window, `none (0)` when clean — derived by reading `main`'s REQUIRED check state
  after each in-window merge, never from a repair PR's prose; **(ii)** a `blocked_ci` verdict whose
  blocking check was ALREADY red on `main` at the run's dispatch time is annotated **INHERITED** and
  excluded from that task's own failure count and from the MAST census's authored-defect tally;
  **(iii)** the calibration table's merge-rate column is renamed or footnoted as a **gate-passage rate**
  until (i) exists, because a rate that cannot distinguish a ship from a regression may not be published
  under the word `merged` without saying so.
  **GOLDEN (fixture-only):** a seeded window in which merge A leaves a REQUIRED check red and merge B
  repairs it prints A exactly once under `TRUNK REDS` with B named as its repair and the interval stated;
  a window in which every merge leaves `main` green prints `none (0)`, never an empty section; a run
  whose blocking check was already red at dispatch renders `INHERITED` and does not increment its task's
  failure count; and a red caused by an environment artefact rather than the merge's diff is excluded
  with the distinguishing evidence named.
  **FALSIFIER, PRE-COMMITTED:** if R44 and R45 both read `TRUNK REDS` at zero **with `main`'s check
  state actually read** — not merely with no repair PR noticed — P67 folds into **P48**'s
  unmeasured-absence family and its evidence is carried there. **A zero from "nobody filed a fix" is
  UNRESOLVABLE, since a red nobody repairs is precisely the invisible case.**

- **★★ P68 (dispatch + golden; R44's mint, rank PROPOSED at 3 directly under P67) — THE RECON RUNG IS
  DISPATCHED WITHOUT THE TASK RECORD IT EXISTS TO SCOPE, AND THE HARNESS PAYS TO REDISCOVER IT.**
  GROUND TRUTH (mechanical, this cycle's own follow-up harvest, quoted not paraphrased): **five of
  eleven runs report, unprompted, that recon had no task spec** — W1-T2613 (*"recon didn't read task
  specs, so scope is currently unconfirmed"*), W1-T2619 (*"this recon had no task spec to scope
  against"*), W1-T2625 (*"this recon didn't inspect task content, only git/repo state, so scope is still
  unknown"*), W1-T2629 (*"this recon wasn't given an explicit task description and this worktree exists
  to serve one"*) and W1-T2623 (*"Locate the actual spec/title for W1-T2623 — likely in daemon task DB
  or `TaskGet`/`TaskList`, not in this repo's tracked files"*). **The other five report the opposite,
  equally explicitly** — W1-T2617 (*"this recon confirms the target symbols and file locations are
  exactly where the task record says, so the implement worker can proceed directly without a second
  discovery pass"*), W1-T2618 (*"this recon confirmed the coupling is real and the target file doesn't
  exist yet, so the task is ready for implement dispatch"*), W1-T2628 (*"W1-T2628 is accurately filed,
  unblocked, and ready to dispatch as-is"*), plus W1-T2620 and W1-T2621, both of which re-derive line
  numbers **from the task file's own instruction to do so**. **The population splits in half, and the
  half that lacks a record spends its recon turns proposing follow-ups that ask for the record.**
  WHY IT IS NOT AN EXISTING ENTRY: **P46** is about task premises ROTTING between filing and dispatch —
  a record that exists and has gone stale. **This is a record that never arrives.** P47 and the whole
  credit family concern what happens to work after it is done. **P68 is the first entry in this list
  about the INPUT to the work**, and it is the only one whose population is enumerable today from text
  the gather already prints.
  WHY IT IS NOT A WORKER-QUALITY PROBLEM: the five recons that lacked a record **did the right thing** —
  they said so, in writing, and filed a follow-up asking for it. The defect is upstream of them.
  W1-T2623 names the likely mechanism: **some task records live outside this repo's tracked files**
  (a daemon task DB reachable only through `TaskGet`/`TaskList`), so a dispatcher that resolves the
  record from `plan/tasks.yaml` + `plan/tasks.d/` alone will silently deliver nothing for those ids and
  the worker will never be told a lookup failed.
  **PROPOSED GOLDEN TASK (not filed): the cheapest first rung is a MARKER, not a fix.** At dispatch,
  resolve the task record for the run's id; if the resolution returns nothing, **emit
  `dispatch.task_record: absent` on the run's ledger row** (and `present` otherwise), and state the
  absence in the recon prompt in one line so the worker does not have to discover it. Then the gather can
  print `RECON WITHOUT SPEC — n: <ids>` (`none (0)` when clean) and the NEXT retro can size this class
  from a column instead of from five paragraphs of harvest prose. **The remedy is deliberately NOT
  "make the dispatcher find the record"** — that is a second, larger decision about where task records
  live, and DR-9 forbids registering a bar against work that must ship first.
  **BAR / FALSIFIER (R44-9, pre-committed):** next cycle at least THREE runs must again self-report a
  missing task record, **or** the marker above must exist and count them. **A zero WITHOUT the marker is
  P48's shape — an unread population, recorded and not scored. A zero WITH the marker folds P68 into
  P46**, because a record that resolves is a record that can only rot. **The confound is named in
  advance:** harvest prose is voluntary, so this cycle's five is a FLOOR on the class and never its
  size — no rank and no scope may be sized on it (DR-11).

- **★★ P65 (credit + golden; R41's mint, rank PROPOSED at 2 directly under P47) — THE RUN LANE IS NO
  LONGER THE WHOLE SHIPPING SURFACE: EIGHT OF THIS WINDOW'S FORTY MERGES CHANGED `src/` OR `test/` FROM
  BRANCHES NO RUN ALLOCATOR NAMES, AND EVERY PRICE, RATE AND COVERAGE FIGURE IN THIS FILE DIVIDES BY
  THE OTHER LANE.** *(That sentence is the bar; a scoring row quoting it per DR-15 reads: an in-window
  merge that changes `src/**` or `test/**` on a head ref that is neither `run-*`-shaped nor a
  plan-filing-only branch.)*
  ★★ **R42 UPDATE — THE POPULATION GREW BY HALF AND THE BAR SCORED A SECOND TIME (R41-1 HIT).** This
  cycle: **12 of 50 in-window merges**, over 29 hand-named of which 16 are plan filings (rule-17
  excluded) and one (#3563) changes `stryker.conf.json` alone: **#3588** (`src/lib/inbox.ts`),
  **#3586** (`sweep.ts`, `run-task.ts`), **#3587** (three recycle suites), **#3583** (`review.ts`),
  **#3581** (`ci-gate-required.ts`), **#3559** (`deploy/recycle-container.sh`), **#3551**
  (`github-event-wake.ts`), **#3568** (`review.ts`, `sweep.ts`), **#3556**
  (`test/sweep-gateway-warm.test.ts`), **#3538** (`daemon.ts`), **#3530** (`sweep.ts`), **#3535**
  (five `src/lib` modules + four tests). Every file list was READ. **The falsifier did not fire**: only
  #3535 carries a trailer, and the union REJECTED it — which is P66's founding case, not P65's
  refutation. **8 → 12 in one window is NOT a trend and this entry is not sized on it (rule 11).**
  GROUND TRUTH (mechanical, from a REST sweep whose command is written down —
  `gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`,
  filtered on `merged_at` > the marker, then `gh api pulls/<n>/files` on every non-`run-*` merge) —
  R41's founding reading, kept because it is the evidence the bar was cut from:
  **40 in-window merges — 17 `run-W1-*`, 1 `run-RETRO-*`, 22 hand-named. Twelve of the 22 touch only
  `plan/tasks.d/*.yaml`, `plan/plan-index.json` or MASTER-PLAN.md and are the plan lane's own
  deliverable (rule 17). EIGHT of the remaining ten change `src/` or `test/`:** #3498
  `codex/dual-subscription-workers` (a capacity-aware **Codex** provider — `deploy/Dockerfile`,
  `deploy/codex-requirements.toml`, `docs/`, `README.md`), #3516 `codex/shard-required-ci`
  (`src/lib/ci-parity.ts`, `scripts/coverage-merge-ratchet.mjs`, `.github/workflows/ci.yml` + tests),
  #3511 `codex/provider-neutral-usage-refusal` (`src/lib/classify.ts`, `src/lib/worker.ts`,
  `src/lib/worker-provider.ts`, `src/run-task.ts` + tests), #3513
  `codex/provider-neutral-worker-liveness` (`src/lib/deployer.ts` + tests), #3501, #3503, #3496 and
  #3485. **Not one of the eight has a run, a verdict, a cost row, a turn count or a MAST category in
  the gather. Seven carry no `Remudero-Task` trailer at all**; the eighth (#3511) carries one in its
  body for `W1-T2564`, a task no section of this gather credits or counts.
  WHY IT IS NOT P64, P58 OR P47: **P47** asks the resolver to print every run and every candidate;
  **P64** says a `run-*` branch may have no run behind it; **P58** says a body-only trailer on a
  hand-named branch is read by nothing. All three argue about members of the `run-*` ref set, or about
  a trailer that would let a merge JOIN it. **P65 says the set is the wrong set.** Executed perfectly,
  every one of those three remedies still returns nothing for the seven untrailered source merges,
  because there is no run to print, no epoch to decode and no trailer to read — the work simply did not
  enter through the lane the instruments watch. **P58 takes #3511 as its second member; the other seven
  belong to no existing entry.**
  THE HARM, MEASURED: **$3.710/run, $5.566 per union ship and $1.964 per hand-verified merge are all
  computed over the 17 `run-W1-*` merges**, while 8 source merges landed beside them uncounted; the
  `BY TASK CLASS` merge rate divides a ledger numerator of ZERO by a lane that authored 42% of the
  window's merges; and the MAST distribution, the turn-coverage stamp and the procedural-success miner
  are all keyed to the same population. **A second worker PROVIDER was added to this fleet in this
  window (#3498) and the calibration table that decides which mounts ride cannot see that it exists.**
  REMEDY (PROPOSED, unbuilt): classify in-window merges by CHANGED FILES rather than head-ref prefix;
  publish `SOURCE MERGES WITH NO RUN — n: <prs>` (or `none (0)`, never an empty section); exclude
  plan-filing-only merges and say so; and **stamp every per-run and per-merge price with the lane its
  denominator covers** (DR-25). The prefix is a CONVENTION; the changed-file list is the DEFINITION —
  the same distinction P64 draws between a signature and a join.
  KILL TRIGGER: if a cycle's sweep finds every such merge already carrying a `Remudero-Task` trailer
  the union credits, the lane is visible after all, **P65 FOLDS INTO P58** and its evidence is carried
  there.

- **★★ P66 (contention + golden; R42's mint, rank PROPOSED at 3 directly under P65) — TWO AUTHORING
  LANES DRAW FROM ONE TASK BOARD WITH NO CLAIM PRIMITIVE, SO THE SAME `W1-T` ID IS WORKED TWICE AND
  THE HARNESS'S ONLY REACTION TO THE COLLISION IS TO REJECT THE WINNER'S EVIDENCE AS
  `stale/foreign`.** *(That sentence is the bar; a scoring row quoting it per DR-15 reads: an in-window
  merge on a NON-`run-*` head ref that names a `W1-T####` id — in its branch name, in a
  `plan/tasks.d/` file it changes, or in its trailer — for which the run lane ALSO dispatched a run in
  the same window.)*
  GROUND TRUTH (mechanical, this cycle): the run `run-W1-T2568-1788298883681` was dispatched, spent its
  budget, and ended with **no creditable PR**. Its GitHub trailer named **#3535**, head ref
  **`codex/github-event-wake-recovery`** — a merge that landed inside this same window carrying
  `src/lib/daemon.ts`, `src/lib/github-event-wake.ts`, `src/lib/policy.ts`, `src/lib/serve.ts`,
  `src/lib/service.ts`, `test/github-event-sweep-wake.test.ts` and three more tests, three `deploy/`
  scripts, `plan/policy.yaml` **and `plan/tasks.d/W1-T2568-github-events-wake-the-sweep.yaml`, that
  task's own shard.** The Discrepancies resolver rejected it because its head branch "is not this run's
  own branch". Two further hand-named merges name run-lane ids in their branch names —
  **#3537 `codex/w1-t2584-scope-correction`** and **#3590 `codex/unblock-w1-t2587`** — and are NOT
  members this cycle only because neither id had an in-window run.
  WHY IT IS NOT P65, P62, P57 OR P58: **P65** says the instruments cannot SEE the second lane's merges;
  fix it in full and you would now SEE #3535 — and still have two producers on one id. **P62** says the
  same task is dispatched repeatedly *within the run lane*; every one of its members is a sibling run,
  and #3535 is not a run at all. **P57(a)** says the `stale/foreign` LABEL is wrong; this cycle the
  label is finally RIGHT about #3535 and the outcome is still wrong, which is the cleanest possible
  demonstration that the defect is upstream of the label. **P58** says a body-only trailer on a
  hand-named branch is read by nothing; here the trailer WAS read, evaluated, and refused on a correct
  rule. **Every existing entry is about bookkeeping over one producer. P66 is about there being two.**
  THE HARM, MEASURED: **one full run's spend bought a rejection** — and the harm is asymmetric with
  every credit-family entry, whose worst case is a mis-computed row. Two more hand-named merges took
  run-lane ids without collision this cycle, so the population is small and REAL rather than
  hypothetical; the harvest independently records the other lane landing #3563, the exact
  instrument-only PR a blocked run's follow-up had asked for. **No rate below is adjusted for this**:
  W1-T2568 sits in the denominator of every per-run price as an ordinary failure.
  REMEDY (PROPOSED, unbuilt) — three rungs, cheapest first: **(i) DETECT** — the retro's merge sweep
  emits `BOARD COLLISIONS — n: <task, runId, foreign-pr>` (`none (0)` when clean), so the next cycle
  can size the population instead of finding one by hand; **(ii) CLAIM** — a task shard records the
  producer and the claim time, and the dispatcher refuses to dispatch a task whose claim is live and
  held by another producer, exactly as `overlappingPaths` already refuses a scope collision;
  **(iii) CREDIT** — a merge that changes a task's OWN `plan/tasks.d/<id>-*.yaml` shard is ownership
  evidence, and the resolver credits it to that task rather than rejecting it on branch shape. Rung (i)
  is a gather change and depends on P65's classifier; rungs (ii) and (iii) are independent of it.
  KILL TRIGGER: if a cycle's sweep shows every collision to be a run-lane worker pushing to a
  non-`run-*` branch — i.e. ONE producer wearing two branch conventions — **P66 is a branch-naming
  defect, FOLDS INTO P57(a)**, and its evidence is carried there.

- **★★ P64 (credit + golden; R40's mint, rank PROPOSED at 4, one place down as P66 enters; ★★ R41: ITS OWN BAR SCORED INDEPENDENTLY AND HELD AT TWO — #3521/W1-T2571 (`…1788289503000`) and #3519/W1-T2570 (`…1788289256000`) carry second-quantised head-ref epochs against **0 of the 6 credited refs**, and the gather's nine declared runs name neither task. The join was run against that declared-run census and NOT the full ledger — a reach STATED rather than implied, since this worktree holds no ledger — so the row is scored on its count arm with its limit named. **The class fell from ten members to two and the falsifier (a real runId behind every quantised ref) did not fire**, which is why the entry is scored on its bar and never on its population) — A
  `run-<id>-<epochMs>` BRANCH IS NOT EVIDENCE THAT A RUN EXISTED, AND TEN OF THIS WINDOW'S EIGHTEEN
  UNCREDITED MERGES HAVE NO RUN BEHIND THEM AT ALL.** *(That sentence is the bar; a scoring row quoting
  it per DR-15 reads: an in-window merge on a `run-<id>-<epochMs>` head ref whose decoded epoch is an
  exact multiple of 1000, or which matches no runId the ledger declares.)*
  ★★ **R42 UPDATE — THE BAR SCORED A THIRD TIME AND THE CLASS SHRANK AGAIN, 10 → 2 → 1 (R41-2 HIT).**
  This cycle exactly ONE of the ten uncredited in-window `run-W1-*` merges is second-quantised:
  **#3550, `run-W1-T2595-1788299887000`**, and the gather's declared-run census names no W1-T2595.
  **None of the 9 credited refs is quantised.** The falsifier (a quantised ref turning out to have a
  real runId) did not fire. **A class that has read 10, then 2, then 1 is NOT sized on its latest
  reading (rule 11)** — and DR-18 applies if it reaches zero: check where its members went before
  retiring it on that zero.
  GROUND TRUTH (mechanical, from a REST sweep whose command is written down —
  `gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`,
  filtered on `merged_at` > the marker, `head.ref` decoded, `epoch % 1000` tested): **39 in-window
  `run-W1-*` merges; 21 credited by the W1-T51 union; 18 credited by nothing; TEN of those 18 carry an
  epoch that is an exact multiple of 1000** — #3414/W1-T2543 (`…1788195710000`), #3416/W1-T2544
  (`…1788196780000`), #3417/W1-T2540, #3418/W1-T2539, #3420/W1-T2535, #3421/W1-T2533, #3422/W1-T2534,
  #3423/W1-T2541, #3435/W1-T2545, #3438/W1-T2546. **ZERO of the 21 credited refs carry that shape.** A
  millisecond runId lands on a whole second once in a thousand times; ten doing so together is not a
  sample. They form one contiguous id band, merged inside a three-hour stretch, beside the plan lane's
  own filings for that band (`plan-2544`, `plan-2542-correction`, `plan-2545-2551`), and **the gather's
  29 declared runs name none of them.**
  WHY IT IS NOT P47: P47 asks the resolver to PRINT every run and every candidate so that a join failure
  becomes visible. **That remedy, executed perfectly, credits none of these ten**, because the join has
  no left-hand side. An uncredited merge needs a better resolver; an unrun merge needs an answer to how
  work entered `main` without a run. **They are different objects and this file has been counting them
  as one class for twenty-four cycles.**
  THE HARM, MEASURED: TASK G counted all twelve of its members as runs started after the marker when
  **two** qualify; the credit band divided by 39, read 20.5%, and triggered a band re-derivation that
  reads **27.6% — inside the OLD band — once the ten are removed**; and **$3.361 per hand-verified
  merge, the cheapest price this log has ever published, is divided by a denominator 26% of which never
  ran.**
  REMEDY (PROPOSED, unbuilt): decode every in-window `run-*` head ref, join it to the run ledger's own
  runId set, and publish **three** classes where there are now two — `credited`, `uncredited` (a run
  exists and the resolver missed it) and `unrun` (no run exists). An `unrun` merge must be excluded from
  every per-run and per-merge price this file publishes and counted on its own line. **The
  epoch-quantisation test is a cheap SIGNATURE that finds the class today; the ledger join is the
  DEFINITION**, and it is the join the golden task must assert.
  KILL TRIGGER: if a cycle's ledger join finds a real runId behind every quantised ref, the shape is an
  allocator artefact, P64 FOLDS INTO P47 and its evidence is carried there.

- **★★ P63 (gates + golden; R39's mint, rank PROPOSED at 3, one place down as P64 enters; ★★ R40: ITS OWN BAR SCORED AND HIT AT SIX IN ITS FIRST SCORED CYCLE, AND THE CLASS OUTGREW ITS FOUNDING RATCHET — W1-T2516/#3409 (`account-usage.ts` 740 + `worker.ts` 3547), W1-T2517/#3410 (`daemon.ts` 3968→4059), W1-T2522/#3459 (`run-task.ts` → 33500), W1-T2528/#3465 (deliberately left) and W1-T2506/#3402 (*"0 lines of headroom"*) all name `scripts/source-size-baseline.json`, but **W1-T2510/#3437 names `test/worker-clock-bound.test.ts` and W1-T2531/#3463 names `test/fast-lane-classifier.test.ts`** — neither a ratchet ledger, both outside the declared `files:` list, both with the exact edit written out in the fix rung's own words. **The falsifier (zero → fold into P42) did not fire, and the widening is the reading: the deadlock is the declared-scope rule meeting ANY gate, not one ratchet's rollout artefact.** The population fell 17 → 10 `blocked_ci` while the BAR rose 5 → 6, which is why the entry is scored on the bar and not on the verdict class) — A STANDING GATE
  WHOSE OWN PRESCRIBED REMEDY LIVES IN A FILE THE TASK'S DECLARED SCOPE FORBIDS IT TO TOUCH IS NOT A
  GATE, IT IS A DEADLOCK — AND IT OWNED SEVENTY-FOUR PERCENT OF THIS WINDOW'S VERDICTS.** *(That
  sentence is the bar; a scoring row quoting it per DR-15 reads: a run ending `blocked_ci` where the
  blocking check names a SPECIFIC FILE as its own remedy AND that file is absent from the task's
  declared `files:` list, so the remedy is unreachable by the declared-scope rule the same harness
  enforces.)*
  GROUND TRUTH (mechanical, from the gather's own Follow-up harvest — every quotation is a fix rung's
  own words, no REST read required): **17 of this cycle's 23 runs ended `blocked_ci`, and FIVE distinct
  tasks' fix rungs named the SAME unreachable file**, `scripts/source-size-baseline.json`:
  **W1-T2490/#3358** (`src/lib/inbox.ts` 2467 → 2637) · **W1-T2497/#3372** (`src/lib/serve.ts`
  6023 → 6265) · **W1-T2503/#3365** (`src/lib/plan.ts` 655, `src/lib/task-linter.ts` 3138) ·
  **W1-T2504/#3364** (`src/lib/sweep.ts` 8569, `src/lib/open-prs-rest.ts` 1732) ·
  **W1-T2485/#3366** (`src/lib/measurement-cadence.ts` 1374, `src/run-task.ts` 32606).
  Each rung says the same thing unprompted: *"the only remaining fix … sits outside this task's
  declared 3-file scope"* · *"this round could not push it"* · *"a human or a differently-scoped task
  must make this one-line edit"* · *"as written, this PR cannot reach a green `ci` without one of those
  two moves, since both failing checks are standing gates with no in-scope remedy."*
  **THE SHAPE IS NOT UNIQUE TO ONE RATCHET.** W1-T2504 hit the identical wall on
  `src/lib/producer-completeness.ts` (a `KNOWN_UNWIRED` entry it was forbidden to add), and W1-T2498 on
  `test/catch-erasure-ratchet.test.ts`'s hand-edited baseline. **The class is "gate with an out-of-scope
  remedy", not "the size ratchet".**
  **RULE-17 EXCLUSION, NAMED RATHER THAN OMITTED (DR-17):** two shipped deliverables already satisfy
  the FOLLOWABILITY half and neither satisfies this bar. **#3377** (W1-T2526's follow-on) replaced
  *"record it by hand"* with the exact `"path": N` line to write — and it WORKED, #3365's worker read it
  and complied. **W1-T2538/#3407** addresses the SECOND gate the remedy then trips
  (`bodyContradictsDiff`, because writing the baseline line adds a file to the diff and falsifies the
  body's own file claim). **Neither makes the file REACHABLE.** P63 is about SCOPE, not wording: a
  perfectly followable instruction the worker is forbidden to execute is still a deadlock, and
  W1-T2538's own rationale concedes the point by routing the reader to *"a human or a task with wider
  scope."*
  WHY IT IS A MINT AND NOT AN ADDITION TO THE CREDIT FAMILY: the standing credit-artifact fold-line
  forbids re-mining `blocked_ci` as a class, and this is NOT that. The fold-line's claim is that the
  verdict is a WRITE-SIDE artifact and the work merged anyway. **P63's claim is the opposite and it is
  checkable: the work is genuinely blocked, by a refusal the worker cannot act on**, and the six
  gate-side rescues this cycle prove only that a HUMAN can act on it. A credit defect loses the record
  of work that happened; **this loses the work.**
  REMEDY (any one; all are bounded): exempt a named REMEDY-FILE SET (`scripts/source-size-baseline.json`
  and its siblings) from the declared-scope check · make the ratchet WRITE its own baseline bump under
  a `--record` flag the gate itself invokes · or have the plan gate widen `files:` automatically when a
  declared file's recorded ceiling has zero headroom. **The harvest already names the next victim before
  anyone hit it: `src/lib/panel-graph.ts` sits at 1625/1625.**
  FALSIFIER: a window in which NO `blocked_ci` run's fix rung names an out-of-scope remedy file → the
  deadlock was one ratchet's rollout artefact, and P63 folds into P42's unmapped-verdict class with its
  evidence carried there. KILL TRIGGER: three consecutive cycles at zero members.
  **SCORED BY R40 as R39-1.**
- **★★ P62 (dispatch + golden; R38's mint, rank PROPOSED at 3, one place down as P63 enters; ★★ R39: ITS OWN BAR SCORED AND HIT AT n=1 — W1-T2502 holds `run-W1-T2502-1788150623019` (04:30:23Z, the declared run) and `run-W1-T2502-1788170832472` (10:07:12Z), and **#3375 on the LATER branch is REST-verified as merged at 11:51:54Z** while the earlier run's resolver prints the refusal. Every clause of the bar is satisfied. **The population collapsed 9 → 1 and the falsifier (zero) did NOT fire, so P62 is not retired into P57(a)** — and the collapse is NOT a demotion argument: P43(ii) forbids re-ranking on one window's population, so P62 shifts one place only because P63 entered above it. **A class surviving a 9× collapse is exactly why DR-11 forbids sizing a scope on the maximum reading**) — THE SAME TASK IS
  DISPATCHED AGAIN WHILE ITS OWN RUN IS STILL IN FLIGHT, AND THE ONLY INSTRUMENT THAT NOTICES CALLS THE
  DUPLICATE'S MERGE FOREIGN.** *(That sentence is the bar; a scoring row quoting it per DR-15 reads: a
  declared run whose task already has an EARLIER run in the same window on a different
  `run-<taskId>-<epoch>` branch, where the later run's PR is the one that merges and the earlier run's
  credit resolver refuses it.)*
  GROUND TRUTH (mechanical, from the gather's own Discrepancies section, no REST read required):
  **nine of this cycle's twenty-seven declared runs are repeats of three tasks.** **W1-T2467 ran FIVE
  times** — `…-1788097850149`, `…-1788101292047`, `…-1788105197048`, `…-1788108218900`,
  `…-1788113060708` — and **W1-T2475 ran FIVE** — `…-1788098006597`, `…-1788101450236`,
  `…-1788105275672`, `…-1788108297657`, `…-1788113140124`; **W1-T2471 ran twice.** Every one of the
  nine losers is printed as: *"REJECTED — GitHub trailer names …/pull/3327 but its head branch
  (`run-W1-T2467-1788113060708`) is not this run's own branch (`run-W1-T2467-1788097850149`) —
  stale/foreign trailer, never credited."* **The rejection is CORRECT on its own terms and the run it
  refuses is a duplicate the harness itself spawned.**
  **THE WORKER-SIDE WITNESS, INDEPENDENTLY REPORTED IN THE SAME WINDOW'S HARVEST:** at the FIX rung the
  duplication reaches ONE branch rather than sibling branches — *"multiple `sweep-W1-T2491-*` worktrees
  (at least 5, per `git worktree list`) are simultaneously checked out to the same branch and raced
  concurrent commits/pushes onto it"*; *"another process wrote two commits to this same
  branch/worktree while this FIX-worker session was independently diagnosing and fixing the identical
  gap"*; *"an unrelated commit … timestamp ~2 minutes before mine … already containing an equivalent
  coverage fix."* **Two workers independently paid for the same fix and one of the two commits was
  orphaned.**
  **HARM — MEASURED WHERE MEASURABLE, IMPUTED NOWHERE IT IS NOT (P48).** 9 of 27 declared runs = **33%
  of the window's run count.** The gather prints a per-run cost for CREDITED runs only, so no dollar
  figure for the nine is measured; at the window's own $3.845/run mean it is **≈$34.6, an IMPUTATION,
  labelled as one and never carried into a table.** What IS measured is the arithmetic consequence:
  **$3.845/run, the cheapest run-price this log has recorded, sits in the same window as $12.978 per
  ledger-credited ship, the dearest in nine cycles** — one numerator over two denominators, and the
  gap is the duplication factor.
  **WHY THIS IS NOT AN EXISTING ENTRY.** **P57(a)** fixes what the refusal is CALLED (sibling vs
  foreign); rename all nine and the harness has still paid for nine runs. **P60** fixes which candidate
  a PICKER selects; a filter that accepts every candidate still leaves four losing runs per task.
  **P39** is dispatch re-offering work whose trailer ALREADY MERGED in an earlier window — a
  cross-window staleness; P62 is concurrent duplication INSIDE one window, where no merge exists yet to
  be seen. **P47** would PRINT the duplication (its per-run row makes five `run-W1-T2467-*` ids
  visible at a glance) and stop none of it.
  REMEDY (two clauses, both small, both against surfaces that already exist):
  **(a) A DISPATCH PRECONDITION** — refuse (or park) a `run-<taskId>-<epoch>` spawn when the same
  `taskId` already has a live claim or an open PR on a different `run-<taskId>-*` branch. The claim
  file and `OpenPrView` already carry both facts; this is a comparison, not a new sensor.
  **(b) ONE GATHER COLUMN** — print `runs per task` beside `runs`, so no per-run average can be read
  without its duplication factor, and so a five-times-dispatched task cannot enter a mount-table
  denominator five times unremarked.
  GOLDEN (fixture-only, no live dep): a fixture with two `run-W1-TX-*` claims open at once → dispatch
  refuses the second and names the first; and a gather fixture whose 5 runs cover 2 tasks → the
  rendered row reads `runs 5 · tasks 2 · runs/task 2.5`, and a row printing only `runs 5` FAILS.
  KILL TRIGGER: **two consecutive cycles in which the Discrepancies section prints ZERO sibling-run
  rejections AND no task holds more than one in-window `run-*` branch** → the duplication was a
  one-storm scheduler artefact and P62 retires with its evidence folded into P57(a).
  FALSIFIER, STATED NOW: if the nine repeats turn out to be *deliberate* re-dispatch after a failed
  attempt (a retry lane, not a duplicate lane), then P62 is wrong about the mechanism and right about
  the accounting — clause (b) survives, clause (a) is withdrawn. **The gather cannot currently tell
  those two stories apart, which is itself the reason clause (b) is the cheap half.**
- **★★ P61 (credit + golden; R37's mint, rank PROPOSED at 5, one place down as P63 enters; ★★ R39: ITS PRODUCING CONDITION RECURRED, AND AGAIN IN THIS DOCUMENT'S OWN LANES — #3390 (`plan-w1t2532`, merged in-window) carries the literal string `Remudero-Task: W1-T2532` inside a PROSE SENTENCE about two OTHER PRs' trailers (*"#3377 and #3388 both carry …"*), the exact backticked-sentence-about-trailers shape R37 minted this entry on with #3262. **It is harmless ONLY BY COINCIDENCE: the described trailer happens to name the PR's own subject task**, so nothing was poisoned and no rejection row names it — which is itself the unresolved half, since the gather prints no evidence of the scan having run on hand-named branches at all. SECOND MEMBER, both of them this file's own lanes, EXERCISED AND STILL UNFIXED; ★ R38: R37-1 read ZERO members over 38 in-window merges — unexercised, not fixed, the zero weak by its own declared author-confound) — THE TRAILER SCAN IS A
  SUBSTRING MATCH, SO A RETRO THAT DESCRIBES A TRAILER MINTS ONE: THE PLAN LANE MANUFACTURES THE
  RESIDUE P33 CANNOT CLEAN.** *(That sentence is the bar; R37-1 quotes its operative clause verbatim,
  per DR-15: a merged in-window PR whose body contains a `Remudero-Task:`-shaped line naming an id
  OTHER than the one its own final trailer block names, where that line sits in prose or inside
  backticks rather than in the final trailer block.)*
  GROUND TRUTH (mechanical, this cycle, read out-of-band over
  `pulls?state=closed&sort=updated&direction=desc&per_page=100`, then `pulls/<n>` for the body and
  `commits/<merge_commit_sha>` for the squash — DR-4, DR-16): **#3262, head ref
  `run-RETRO-1788011469299`, merged 2026-08-29T15:40:02Z (+1.4 h INSIDE this cycle's window).** Its
  final trailer block carries its own RETRO id, and the squash commit on `main` carries that id and
  nothing else. **Its body ALSO contains, at line 19, a backticked mid-sentence quotation naming
  `W1-T2387`** — written while narrating the very defect R36 had just minted P60 for. A body scan that
  greps the literal token returns TWO ids for a PR that claims one.
  **★ THE CONTROL, IN THE SAME WINDOW AND ONE NAMESPACE OVER, WHICH IS WHAT MAKES THIS MECHANICAL
  RATHER THAN SPECULATIVE:** **#3280 (`fix/rule-15-citation-collision`) — *"fix(retro): treat a quoted
  artifact as a quotation, not a rule citation"*** — merged 2026-08-30T01:35:01Z. The repo has already
  accepted this exact remedy shape for the RULE-CITATION namespace. **The TRAILER namespace, which
  decides CREDIT, still has none.** Two parsers, one defect, one of them fixed.
  **★ AND THE PLAN-FILING LANE ALREADY KNOWS:** four of this window's hand-named filings say in their
  own bodies that they carry no `Remudero-Task:` trailer *"deliberately"*, because a trailer naming a
  shard the PR ADDS would be false. **The convention is understood by the authors and unenforced by the
  parser** — which is exactly the gap between a discipline and a gate that §5 exists to close.
  DIAGNOSIS: the credit path treats a PR body as a bag of lines. Git trailer semantics are positional —
  a trailer is a `Key: value` line in the body's FINAL paragraph, with no intervening prose — and
  nothing in the resolver applies them. The retro lane is the highest-volume producer of prose ABOUT
  trailers in this repo, so it is the lane most likely to emit the defect, and its output is merged
  automatically.
  PROPOSE, four clauses, smallest first: **(i) POSITIONAL EXTRACTION** — a body trailer is recognised
  ONLY in the final trailer block (last paragraph, every line matching `^[A-Za-z-]+: `), never
  mid-prose, never inside backticks or a fenced block; everything else is a mention. **(ii) MULTI-ID
  REFUSAL IS NOT ENOUGH** — when the final block names one id and the prose names others, the resolver
  records `trailer.mention_ignored` with both ids rather than silently dropping them, so the corpus can
  be audited later (**P48(ii)**: never a bare zero). **(iii) THE AUTHOR-SIDE ARM, cheap and immediate**
  — the plan/retro lanes' own PR-body composition must never emit an unquoted trailer-shaped line for
  a foreign id; a lint over `run-RETRO-*`/plan-lane bodies is a five-line check and needs no resolver
  change. **(iv) FEED P33** — the pair `(#3262, W1-T2387)` becomes the FIRST machine-minted entry in
  P33's quarantine list, which proves that list needs a PRODUCER and not only a schema.
  GOLDEN (fixture-only, no live dep): a body whose prose quotes a foreign trailer and whose final block
  names its own id resolves to exactly ONE id; a body whose ONLY trailer-shaped line is a quoted
  foreign one resolves to NONE and emits `trailer.mention_ignored`; a body with a legitimate final
  trailer block still resolves exactly as it does today (no regression on the 55 pairs already lost).
  **KILL TRIGGER (pre-committed):** if **three consecutive cycles** produce no merged PR whose body
  quotes a foreign trailer outside its final block — R37-1 reading zero three times — the defect is a
  one-off of one author's prose style and **P61 is RETIRED with its prose deleted**, clause (iv)
  folded into P33. **AUTHOR-CONFOUND DECLARED IN ADVANCE (DR-21):** this file's author now knows the
  row, so a zero is weak evidence and is scored MISS rather than banked. **Registered as R37-1.**

- **★★ P60 (credit + golden; R36's mint, rank PROPOSED at 4, one place down as P63 enters; ★★ R39: its kill-trigger clock ADVANCES TO ONE — both of this cycle's rejections again carry a single candidate, so the PICKER is untested for a second consecutive cycle and the three-consecutive-UNRESOLVABLE trigger is one third of the way to firing; ★ R38: the clock RESET on nine sibling-run rejections, each with one candidate; ★★ R37: R36-1 read
  UNRESOLVABLE — no task in the window had two merged trailered candidates, so this is the FIRST of the
  three consecutive readings its own kill trigger requires, 1 of 3. The near-miss is P61's mint: the
  ONE task that acquired a second candidate did so through the retro lane R36-1's exclusion removes)
  — THE OWNERSHIP ASSERT
  IS A PICKER, NOT A FILTER: A CORRECT REJECTION ENDS THE SEARCH AND THE RIGHT PR IS NEVER LOOKED AT.**
  GROUND TRUTH (mechanical, this cycle, every row read out-of-band over
  `pulls?state=closed&sort=updated&direction=desc&per_page=100`, then `pulls/<n>` for the body,
  `pulls/<n>/files` for the diff and `commits/<merge_commit_sha>` for the squash message — DR-4 and DR-16): **W1-T2387 had TWO merged in-window PRs naming it.**
  **(1) #3242**, head branch `plan/file-commit-trailer-surface-squash-erases`, diff entirely under
  `plan/**`, **body carrying TWO `Remudero-Task:` trailers (`W1-T444` and `W1-T2387`)** and **squash
  commit carrying none**. **(2) #3237**, head branch **`run-W1-T2387-1787945900779` — the run's own
  branch** — carrying `Remudero-Task: W1-T2387` in the body **and** in the squash commit on `main`.
  **The gather evaluated #3242, applied the ownership assert, and refused it: *"GitHub trailer names
  https://github.com/craigoley/remudero/pull/3242 but its head branch … is not this run's own branch
  … stale/foreign trailer, never credited."* Every clause of that sentence is TRUE. #3237 appears in no
  section of the gather at all.**
  **★ THE POSITIVE CONTROL, IN THE SAME WINDOW, WHICH IS WHAT MAKES THIS MECHANICAL RATHER THAN
  ANECDOTAL:** **W1-T2451 also had two merged candidates** — **#3251**
  (`run-APPROVE-board-review-escalation-3039-…`, `MASTER-PLAN.md` + a plan shard, trailer in the
  **squash commit only**, none in the body) and **#3255** (its own run branch, code) — **and it was
  credited correctly.** The two tasks differ in exactly one respect: **the wrong candidate's trailer sat
  in the BODY for W1-T2387 and in the SQUASH COMMIT for W1-T2451.** A body-trailered PR enters the
  candidate set the resolver ranks; a squash-only one does not. **So the credit outcome turns on which
  SURFACE a foreign trailer happens to land on, and nothing about ownership at all.**
  **WHAT P60 PROPOSES — four clauses, smallest first.** **(i) OWNERSHIP IS A FILTER, NOT A SELECTOR:**
  enumerate EVERY in-window merged PR whose body or squash message names the task id, apply the
  own-branch assert to each, and credit the first that PASSES — never stop at the first that FAILS.
  **(ii) THE REJECTED SET IS PRINTED, NOT ABSORBED:** the Discrepancies section names how many
  candidates were considered and why each was refused, so *"1 rejected"* can never again be
  indistinguishable from *"1 rejected, 1 never examined."* **(iii) MULTI-TRAILER BODIES ARE A DECLARED
  CASE:** #3242 claims two task ids in one body; a resolver that reads the first match silently
  mis-attributes, so every trailer in a body is a separate candidate and a PR claiming ≥2 ids is
  reported as such. **(iv) THE OWN-BRANCH ASSERT IS RANKED BELOW THE SURFACE-AGNOSTIC READ:** candidates
  are gathered from BOTH surfaces before any is ranked, which is the clause the control case proves is
  missing.
  **WHY THIS IS NOT AN EXISTING ENTRY:** **P47** widens what the gather PRINTS about runs it already
  knows about and would have shown #3237 without crediting it; **P56** tests whether a CHANGESET can be
  an implementation and fires only after a candidate is chosen (and would, correctly, have refused
  #3237's plan-only diff had the resolver reached it — P56 and P60 are the two halves of one pipeline);
  **P57** splits the LABEL the refusal is filed under, and a perfect label still credits nothing;
  **P58** makes the trailer survive the merge button, and both of this cycle's trailers survived;
  **P33** lists what was already lost. **Every one of them assumes the resolver reached the right PR and
  then judged it wrong. Here it judged correctly and stopped.**
  GOLDEN (fixture-only, no live dep): a seeded task with two merged candidate PRs — one foreign-branch
  with a body trailer, one own-branch with trailers on both surfaces — credits the own-branch PR and
  prints the foreign one as a NAMED rejection; the same fixture with the foreign trailer moved to the
  squash commit produces the identical credit (the surface-independence assert); a body carrying two
  distinct task ids yields two candidates and a `multi-claim` flag; and a task whose only candidate
  fails the assert still reports `0 credited, 1 rejected, 0 unexamined`, never a bare zero (**P48(ii)**).
  **KILL TRIGGER (pre-committed):** if **three consecutive cycles** produce no task with more than one
  merged trailered candidate — i.e. R36-1 reads UNRESOLVABLE three times running — the picker has no
  population to be wrong about and **P60 is RETIRED with its prose deleted**, its clause (ii) folded
  into P47. **Registered as R36-1.**

- **★★ P59 (method + golden; R35's mint, rank PROPOSED at 8, one place down as P62 enters — its
  standing UNCHANGED; ★★ R36: ITS CLAUSE (ii) IS PAID BY HAND IN ITS FIRST CYCLE, TASK G HAVING BEEN
  UN-RETIRED FROM A REST SWEEP THE GATHER CANNOT PERFORM) — THE RETIREMENT WITH
  NO WATCHDOG: WHEN THIS FILE DELETES A CLASS, IT ALSO DELETES THE ONLY PLACE THAT CLASS WAS COUNTED.**
  GROUND TRUTH (mechanical, this cycle): **TASK G was RETIRED BY DELETION on 2026-08-28 by R34**, on a
  fourth consecutive zero, under DR-9 and DR-18 — the retirement was argued correctly, its
  members' destination was checked, and a destination was found. **One window later G's class has three
  members** (#3189/W1-T2347, #3175/W1-T2415, #3185/W1-T2408 — all `run-W1-*` code merges credited by
  nothing) **and the destination R34 named (P58's hand-named lane) has none.** **★ THE PART THAT MAKES
  THIS A PROPOSAL AND NOT A CORRECTION:** the only reason R35 could see any of this is that R34 also
  registered **R34-2**, a joint row that happened to re-read the same population for an unrelated
  purpose. **Had that row not existed, the three merges would have been invisible in exactly the way
  G's clause (i) was written to prevent** — the id was deleted, the prose was deleted, and nothing in
  the gather was left counting. Every other claim in this file is scored against a pre-registration;
  **the decision to STOP watching something is scored against nothing at all.** THE ASYMMETRY, STATED:
  adding an instrument requires evidence, a rank, a golden and a falsifier; removing one requires a
  zero. PROPOSE: **(i) A RETIREMENT LEAVES A MACHINE-READABLE PREDICATE BEHIND, NOT PROSE** — retiring
  an id registers its class predicate in the gather's own config (`retired-classes.yaml` or equivalent),
  and the gather emits `RETIRED CLASS <id> — n: <members>` for **K = 4 cycles** after the deletion,
  which is the same span the retirement itself was argued over. **(ii) A REFILLED CLASS AUTO-RETURNS**:
  if the predicate reads ≥1 during the watch window, the gather says so and the next retro must either
  re-open the id or state, in the PR, which HELD entry now owns those members — never silently. **(iii)
  THE RETIREMENT ITSELF IS PRE-REGISTERED**, exactly like a proposal's kill trigger: a retro that
  retires a class registers *"class <id> reads zero again next cycle"* as a scored row, so a retirement
  is a prediction that can MISS. **(iv) DISJOINTNESS IS CHECKED BEFORE, NOT AFTER** — the retirement PR
  must name the HELD classes whose definitions could claim the same members (DR-19), which is
  the one check that would have caught G against TASK L.
  **WHY THIS IS NOT AN EXISTING ENTRY:** P43 pre-registers EFFECTS of shipped work and its rows are
  about the world, not about this document's own edits; P47/TASK G/TASK L/P51 are the classes, not the
  meta-rule for deleting them; rule 9 says *delete the id, do not annotate it* and is RIGHT — P59 does
  not weaken it, it moves the surviving count out of prose (where rule 9 forbids it) and into the
  gather (where rule 9 has no jurisdiction). **This is also the standing answer to the compression bar:
  a retro must delete, and P59 is what makes deleting safe.**
  GOLDEN (fixture-only, no live dep): a seeded `retired-classes` entry whose predicate matches zero
  merges prints `RETIRED CLASS G — n: 0 (watch 2/4)`, never an empty section (**P48(ii)**); the same
  entry with one matching merge prints the member AND sets the auto-return flag; a class past its watch
  window disappears from the output entirely; and a retirement whose predicate overlaps a HELD class's
  predicate on any seeded member FAILS the fixture with both ids named.
  **KILL TRIGGER (pre-committed):** if **two consecutive retirements** are followed by four clean cycles
  each with the class still empty, the watchdog is pure overhead and **P59 is RETIRED with its prose
  deleted** — under its own clause (iii), which is the only honest way to retire a proposal about
  retirement. **Registered as R35-2** (the disjointness half, scorable this cycle with one sweep); the
  watch-window half is UNSCORABLE until (i) ships and is deliberately not registered, per DR-1.
- **★★ P58 (credit + golden; R34's mint, rank PROPOSED at 8, one place down as P65 enters; ★★ R41: ITS INTAKE ARM TAKES ITS SECOND MEMBER EVER, FROM A LANE THAT DID NOT EXIST WHEN IT WAS MINTED — #3511 (`codex/provider-neutral-usage-refusal`, merged 17:30:51Z) ships `src/lib/classify.ts` + `worker.ts` + `run-task.ts` + tests and carries `Remudero-Task: W1-T2564` in its BODY, naming a task no section of this cycle's gather credits, counts or even scopes. **R38-6's zero-reading conclusion — that #3328 was one reviewing lane's habit and not a standing intake gap — is REFUTED by a member from a different lane entirely**, and the arm returns to SCORED. The other seven source-shipping hand-named merges carry no trailer at all and belong to P65, not here; ★ R39: ITS INTAKE ARM RETURNS TO RECORDED-NOT-SCORED, ON ITS OWN PRE-COMMITTED FALSIFIER — all seven hand-named in-window merges are `plan-*` filings and `pulls/<n>` on each returns no `Remudero-Task:` trailer naming an uncredited task. **R38-6 MISS at zero**, and R38-6's falsifier said exactly what a zero would mean: **#3328 was one reviewing lane's habit, not a standing intake gap.** The arm keeps its one member and stops being scored; ★ R38: ITS INTAKE ARM TOOK ITS FIRST MEMBER IN FOUR CYCLES — #3328, on the hand-named branch `claude/remudero-codebase-review-jswd3f`, carries `Remudero-Task: W1-T2509` in its BODY's final block and NOT in its squash, ships `src/run-task.ts` + a test, and names a task no section of this cycle's gather credits or even mentions; registered as R38-6, recorded as a member and NOT scored as a fix — its
  standing UNCHANGED; ★★ R36: R35-1 HIT on the harm arm (#3242 → W1-T2387's refusal) while the INTAKE
  arm read ZERO a SECOND time over a denominator 2.5× larger — 5 hand-named code merges, NONE trailered
  on either surface, which is P33's un-entitled class rather than P58's. ★ ON NOTICE: a THIRD
  consecutive empty intake beside a non-empty code lane retires P58 FOR CAUSE, not on an empty lane;
  ranked on the paid harm alone) — R34's original framing follows, on the only
  credit-loss class that cost a measured run this cycle) — THE TRAILER THAT DIES
  AT THE MERGE BUTTON: THE ATTRIBUTION SURFACE THE FLEET WRITES TO IS NOT THE ONE `main` KEEPS.**
  GROUND TRUTH (this cycle, mechanical, every row read out-of-band over `pulls/<n>/files` for the diff,
  `pulls/<n>` for the body and **`commits/<merge_commit_sha>` for the message that actually landed** —
  DR-4 and DR-16): of the **42 hand-named-branch merges** in this window, **9 carry code**, **8
  of those 9 carry a valid `Remudero-Task:` trailer in the PR BODY**, and **7 of those 8 carry NO
  trailer in the squash commit on `main`**:
  **#3136 → W1-T2382** (`src/lib/sweep.ts`, `test/sweep.test.ts`) · **#3126 → W1-T2397**
  (`src/lib/daemon.ts`, `src/lib/drain.ts`, `src/run-task.ts`) · **#3127 → W1-T2399**
  (`src/lib/status.ts`, `src/lib/sweep.ts`) · **#3171 → W1-T2426** (`src/lib/sweep.ts`) · **#3170 →
  W1-T2415** (`src/lib/status-board.ts`) · **#3164 → W1-T2425** (`src/lib/ledger.ts`,
  `src/lib/status.ts`) · **#3168 → W1-T2423** (`src/lib/status.ts`).
  **The one exception is #3172 → W1-T2427, which COMMITTED its trailer** — exactly the shape
  **T1012/#2240** shipped and this file has claimed as durable ever since. **The mechanism works and one
  producer in nine uses it.** (#3186 touches `src/lib/review.ts` and carries no trailer anywhere, so it
  is outside this bar entirely.)
  **WHY THIS IS THE RECORD AND NOT THE JUDGEMENT.** Everything the resolver needs is present at scan
  time — the API serves the PR body for as long as the PR exists — so P57 can split its label and P56
  can check its changeset without noticing anything wrong. **The defect only appears when you ask
  `main` itself.** After the squash, seven of these eight merges are, in the repository's own permanent
  history, anonymous: no `Remudero-Task:` line, no run branch (the branch is deleted), nothing but a
  conventional-commit subject. **Every instrument in this file that reconstructs the past from git
  rather than from a live API is blind to them, permanently, and no amount of gather-widening recovers
  it.** This is the mechanism under **P39** (dispatch re-derives merged work because it cannot see its
  own merged trailers) and it is measured here at **7 in one six-hour window**.
  **THE COST IS MEASURED, NOT PROJECTED.** **W1-T2415's own worker PR #3175 is OPEN and titled `wip`**
  while **#3170 merged the identical acceptance file pair — `src/lib/status-board.ts` +
  `test/queue-head-names-a-circuit-broken-refusal.test.ts` — twenty minutes earlier**, and the gather's
  only trace of that merge is a refusal row. A full worker run, spent against work that had already
  landed, with the landing unattributable in history the moment it merged.
  **WHY THIS IS NOT AN EXISTING PROPOSAL — the strongest form of the test, stated rather than
  asserted.** P47 widens what the gather PRINTS; P57 splits the NAME a refusal is filed under; P56
  checks WHAT a merge changed; P33 quarantines pairs already lost. **All four operate on data the
  GitHub API is still serving.** None asks whether that data will exist in a month, and none of their
  remedies writes anything into the commit. **TASK G's clause (iv)** — *the section must state which
  SURFACE it reads the trailer from, because T1085/#2357 merged with its trailer in the commit message
  and nowhere in the PR body, and a body-only reader loses it* — is the one sentence in this file that
  saw the surface question, and it saw the mirror image of this cycle's failure. **TASK G is retired
  and clause (iv) is folded here**, which is the whole reason the retirement is not a loss.
  PROPOSE: **(i) A MERGE-TIME GATE.** `ci-gate` (or the merge step) REFUSES a merge whose PR body
  carries a `Remudero-Task:` trailer that its head commits do not, naming both surfaces in the refusal
  — the trailer is cheap to move and impossible to recover afterwards. **(ii) OR, IF THE GATE IS TOO
  BLUNT FOR THE HAND-NAMED LANE, A WRITE:** the merge step composes the squash message from the body's
  trailer block, so squashing PRESERVES rather than drops it. **(i) and (ii) are alternatives and the
  choice is deliberately left open** — this proposal is minted on the measurement, not on the remedy.
  **(iii) EVERY CREDIT-SIDE READER STATES WHICH SURFACE IT READ** (body, commits, or squash message),
  so a resolver that agrees with the API and disagrees with history says so out loud. **(iv) THE GATHER
  COUNTS THE BODY-ONLY POPULATION**, because a number that is 7 this cycle and unreported is exactly
  the shape TASK G was retired for.
  GOLDEN (fixture-only, no live dep): a seeded PR whose body carries `Remudero-Task: X` and whose
  commits do not is REFUSED by the gate with both surfaces named; the same PR with the trailer
  committed passes; a seeded merge whose squash message carries the trailer resolves to X when the PR
  body is unavailable (the history-only path), and the fixture FAILS if the resolver can only answer
  from the body; and a seeded window with zero body-only merges prints `none (N trailered hand-named
  merges, all committed)` with N, never an empty section (**P48(ii)**).
  **KILL TRIGGER (pre-committed, so this cannot become an eleven-cycle standing item):** if two
  consecutive cycles show **ZERO body-only trailered code merges**, the habit was one window's
  operator pattern rather than a lane's, and **P58 is RETIRED with its prose deleted** — the same bar
  P41 was retired on and P57 carries. **Registered as R34-1, with rule 17's exclusion named in advance
  (plan-only diffs and the retro/plan-sync lanes are OUT), and jointly as R34-2 under DR-18.**
  **★★★ R35 — THE KILL TRIGGER FIRED ITS FIRST HALF AND THE BAR IS RE-CUT INSTEAD, OUT LOUD.**
  **R34-1 MISSED: the class read ZERO.** But the reading is vacuous rather than refuting: **only 2
  hand-named branches merged code this window** (#3210 `.github/workflows/ci.yml`, #3220 `CLAUDE.md` +
  `scripts/` + `test/`) **and NEITHER carries a `Remudero-Task:` trailer on either surface**, so the
  denominator of *"trailered hand-named merges"* was ~0 and the trigger's own sentence — *every*
  trailered hand-named merge commits its trailer — was satisfied by there being none. **A zero over an
  empty denominator is a vacuous pass, not a refutation** (P48's doctrine, applied to a falsifier for
  the first time in this file). **★ AND THE HARM WAS PAID IN THIS WINDOW BY A MEMBER FROM A PRIOR ONE.**
  **#3083** (`fix/unverifiable-verification-is-reread`, merged 2026-08-27T13:54:49Z, `src/run-task.ts` +
  `test/run-task.test.ts`, **body trailer `W1-T2370`, squash commit carrying NONE**) is this class
  exactly. W1-T2370 therefore read as unshipped, was **re-dispatched into this cycle** (run
  `W1-T2370-1787884855316`), spent a full run, merged nothing, and had the trailer it did find **REFUSED
  as *"stale/foreign … never credited"*** — the complete chain P58 + P39 + P57(b) describe, in one
  cycle, over one PR. **THE BAR IS RE-CUT FROM INTAKE ONTO HARM (R35-1): a per-window member count can
  never falsify a class whose cost lands one or more windows after the member is created**, which is why
  R34-1 was a well-formed row asking the wrong quantity. **The two-consecutive-zero kill trigger stands
  but is now read on R35-1's harm count**, not on intake. **★ RANK 3, past P57**, on the ground that
  this is the only credit-loss class in this file that cost a measured run this cycle.
- **★★ P57 (credit + golden; R33's mint, rank PROPOSED at 8, one place down as P63 enters; ★★ R39: ARM (a) FALLS FROM NINE MEMBERS TO ONE — W1-T2502's sibling-run rejection is still filed under `stale/foreign`, a label it does not answer to, and the OTHER rejection this cycle (W1-T2480 → #3310 on `claude/remudero-codebase-review-jswd3f`) is a genuinely foreign branch, so for the first time the two shapes appear side by side under one label. **That is the split this entry asks for, printed in a single section**; ★ R38: ARM (a) WENT FROM ONE MEMBER TO NINE, all sibling runs; ★★ R37:
  ARM (a) TAKES ITS FIRST MEMBER IN THREE CYCLES AND THE LABEL'S FIFTH DISTINCT FACT** — the window's
  one rejection refuses #3288 because its head ref names a LATER RUN OF THE SAME TASK, filed under the
  same `stale/foreign` string; the task was credited anyway, by the sibling run's own ledger row, so
  the label was wrong AND harmless in the same cell — which is exactly why it keeps surviving. ★★ R36:
  ARM (b) TAKES A FOURTH DISTINCT FACT — the cycle's one rejection is a plan-filing branch carrying TWO
  valid trailers, one of which genuinely names the task, filed under the same `stale/foreign` label;
  arm (a) again produced no member. P57 now sits directly UNDER P60 because a perfect label still
  credits nothing when the search stopped at the rejection) — R33's framing follows; its (a) arm
  produced no member this cycle while P58's harm was measured) — ONE LABEL FOR THREE
  OPPOSITE FACTS: THE OWNERSHIP ASSERT IS RUN-SCOPED AND THE CREDIT QUESTION IS TASK-SCOPED.**
  ★★ **R42 UPDATE — THE LABEL IS FINALLY RIGHT ABOUT ONE OF ITS OWN ROWS, AND THAT IS WORSE FOR THE
  ENTRY, NOT BETTER.** Two rejections this cycle and they SPLIT: **W1-T2578's** names its own later
  sibling run (`…1788311124893` vs `…1788308827297`) — the shape this entry was minted on, wrong label,
  thirteen cycles running. **W1-T2568's names #3535 on `codex/github-event-wake-recovery`, a branch no
  run allocator produced — genuinely FOREIGN, the label's first correct member in its history.** So the
  standing claim *"wrong for 100% of its members"* is now FALSE and is replaced by the weaker, truer
  one: **a label that is right about half its rows carries no information about any single row**, which
  is the split this entry asks for, printed at last in one section. **The foreign row's CAUSE is P66,
  not P57** — the label did its job and the outcome was still a full run's spend refused.
  GROUND TRUTH (R41's cycle, mechanical, every row read out-of-band over `pulls/<n>`, `pulls/<n>/files`
  and `pulls/<n>/commits` — DR-4 and DR-16): the Discrepancies section emitted **one** verdict
  string — *"REJECTED — GitHub trailer names <PR> but its head branch (X) is not this run's own branch
  (Y) — stale/foreign trailer, never credited"* — **13 times across 7 tasks. Not one row is the class
  that string names.** The population is three classes:
  **(a) SIBLING RUN OF THE SAME TASK — 5 rows, 2 tasks** (W1-T2323 ×4, W1-T2379 ×1; the refusal message
  prints BOTH branch names and they differ only in the run timestamp, so the task id the credit question
  is asked about is present, verbatim, inside the sentence that refuses it).
  **(b) ENTITLED HAND-OPENED BRANCH — 8 rows, 4 tasks, ALL CODE** (#3098/W1-T2381, #3111/W1-T2375,
  #3118/W1-T2388, #3005/W1-T2326; each carries a valid `Remudero-Task:` trailer for the very task it was
  refused for, verified over REST — the fleet fixing its own filed tasks from outside the worker
  pipeline, and the assert refusing all of it). **(c) P33's CLASS — an un-entitled trailer the PR was
  never owed: ZERO rows.** The per-PR file lists live in the SHIPPED log's R33 section header (rule 13).
  **THE COST IS MEASURED, NOT PROJECTED.** W1-T2326 was dispatched **three times inside its window** onto
  work that merged the previous day, one of its own recons writing *"this dispatch should be
  aborted/closed rather than executed"*; two further worker attempts at already-landing work were CLOSED
  UNMERGED (#3109, #3116). **Full worker runs are being spent re-deriving merged, trailered code.**
  **★ R34 — THE FIRST SCORED READING, AND IT NARROWS CLAUSE (a) RATHER THAN CONFIRMING IT.** The
  sibling-run class fell **5 rows → 1**: `TRIAGE-fb-repair-stale-2955-1787860005514` refused for #3141,
  whose head branch is `…-1787863457229`. **But the sibling run is itself in-window, so four lines below
  in the same section the same PR is CREDITED** as a gate-side merge. **When both siblings are in scope
  the refusal is self-cancelling** — (a) is then a REPORTING defect, not a credit loss, and becomes a
  credit loss only when the sibling run falls outside the window (which is TASK L's boundary problem,
  not this one's). **The label split stands unchanged; the credit remedy in (ii) narrows to the
  out-of-window case.** Clause (b) is unchanged and read **8** this cycle (R33-4 HIT), where it met the
  further defect P58 was minted for: 7 of those 8 lose their trailer at the squash.
  **WHY THIS IS NOT AN EXISTING PROPOSAL — the strongest form of the test, stated rather than
  asserted.** Every credit entry here is about a JUDGEMENT the harness gets wrong: P47/P33/P39 about
  credit LOST, P56 about credit falsely GRANTED. **P57 is about a NAME.** The assert's verdict is
  CORRECT on all thirteen rows — that run genuinely did not open that PR — and its LABEL is wrong on
  all thirteen. TASK G prints orphans, and this cycle its class is empty; TASK L widens the window, and
  none of these four tasks is a straddler; P33 quarantines permanently-lost pairs, and **it gained zero
  members this cycle while the label bearing its name fired thirteen times**; P56 inspects a changeset,
  which says nothing about which task a branch belongs to. **No existing remedy reads the label,
  because every one of them treats the rejection as an already-classified event.**
  PROPOSE: **(i) SPLIT THE LABEL AT EMISSION into `sibling-run` (same task id, different run id),
  `unowned-branch-entitled` (head opened by no run, trailer correct for this task, changeset outside
  `plan/**`) and `unentitled-trailer` (P33's class)** — one name per fact, decided where the branch
  comparison already happens and both strings are already in hand. **(ii) THE RUN-SCOPED ASSERT IS NOT
  LOOSENED.** It stays exactly as written; the TASK-scoped credit question is answered by a SECOND
  predicate — *does a merged PR carry this task's trailer AND a changeset touching a file outside
  `plan/**`?* — **and that second predicate is P56's, which MUST gate this one.** This cycle proves the
  interlock rather than assuming it: **both class-(a) PRs (#3093, #3104) are plan-only**, so a
  task-scoped credit ungated by P56 would have manufactured two fabricated credits in the window
  immediately after P56 was minted. **(iii) THE GATHER COUNTS THE THREE CLASSES SEPARATELY**, so a
  cycle in which the label's own named class has zero members says so instead of publishing a 13.
  GOLDEN (fixture-only): a seeded discrepancy whose refused head is `run-<sameTask>-<otherTs>` emits
  `sibling-run` and never the word the current message uses; a seeded PR on a hand-named branch with a
  correct trailer and a `src/` file emits `unowned-branch-entitled` and is OFFERED to the task-scoped
  resolver; **the same PR with a `plan/`-only diff is offered and REFUSED by P56's predicate**, and the
  fixture fails if it is credited; a seeded PR whose trailer names a task its diff never touches emits
  `unentitled-trailer`; and a seeded gather with zero members of the third class PRINTS that zero
  rather than folding it into a total.
  **KILL TRIGGER (pre-committed, so this cannot become an eleven-cycle standing item):** if two
  consecutive cycles show **≥1 genuine `unentitled-trailer` row and ZERO rows of the other two
  classes**, the label was right all along, the population this entry was minted on was one window's
  re-dispatch storm, and **P57 is RETIRED and folded back into P33** with its prose deleted — the same
  bar P41 was retired on. **Registered as R33-1 (clause (a)) and R33-4 (clause (b)), both with rule
  17's exclusion named in advance.**
  **★★ R35 — ARM (a) READS ZERO AND ARM (b) TAKES THE CYCLE'S ONLY REJECTION, WHICH IS WHY THE RANK
  DROPS BUT THE ENTRY DOES NOT.** **No sibling-run refusal occurred at all this cycle.** The
  Discrepancies section emitted exactly ONE rejection: **W1-T2370's trailer, naming #3083, refused
  because that PR's head branch (`fix/unverifiable-verification-is-reread`) is not the run's own.** That
  is neither arm (a)'s sibling-run case nor P33's un-entitled case — **#3083 genuinely implements
  W1-T2370** (`src/run-task.ts` + `test/run-task.test.ts`, body trailer present) — so it is a **THIRD
  distinct fact under the one label `stale/foreign`**, which is precisely arm (b)'s claim and is its
  first member since minting. **The kill trigger is NOT approached** (it is written on arm (a) reading
  zero *twice*, and this is the first). **The rank drops 3 → 4** because a label defect that costs
  reporting accuracy ranks below a record defect that cost a measured run — see P58's R35 note, where
  the same rejection is the last link in the chain.

- **★★ P56 (credit + golden; R32's mint, rank PROPOSED at 6, one place down as P63 enters; ★★ R39: no zero-file or plan-only merge was credited as an implementation — the union's eight members all ship src + test, and the seven `plan-*` merges are the plan lane's own deliverable and correctly outside the credit population (DR-17). Three members stand, predicate unbuilt; ★ R38: same reading; ★★ R37:
  THIRD MEMBER, AND IT IS THE LIMIT CASE BENEATH THE BAR — #3261 merged on a correctly trailered
  `run-W1-T2441-*` branch with 5 commits and `changed_files: 0, additions: 0, deletions: 0`. The bar
  refuses a diff touching only `plan/**`; a diff touching NOTHING passes it, so the defect is in the
  predicate's SHAPE and not its threshold. The empty merge is counted in every merge denominator this
  file publishes; ★★ R36: THE NEAR-MISS IS INSTRUCTIVE — #3237's
  diff IS plan-only, so had the resolver reached it, P56's predicate is exactly what should have
  refused it. P56 and P60 are the two halves of ONE pipeline: P60 makes the resolver see every
  candidate, P56 decides which of them can be an implementation) — THE CREDIT
  RESOLVER'S FALSE POSITIVE: A MERGED PR ON A `run-<taskId>-*` BRANCH WHOSE DIFF TOUCHES ONLY
  `plan/**` (NO `src/**`, `test/**`, `scripts/**`, `hooks/**`) IS CREDITED AS THAT TASK'S
  IMPLEMENTATION.** *(That sentence is the bar; R32-4 quotes it verbatim, per DR-15.)*
  GROUND TRUTH AS MINTED (R32, hand-verified over REST): **W1-T2318 is recorded SHIPPED via
  https://github.com/craigoley/remudero/pull/3059, and `pulls/3059/files` returns exactly one path —
  `plan/tasks.d/W1-T2318-boot-enumerates-2400-closed-prs-to-list-five-open-branches.yaml`.** The PR
  does not implement the task. It *amends the plan to record that the task's real work merged in
  #2972*, a hand-named branch whose commits carry **no `Remudero-Task:` trailer at all**.
  **THE MECHANISM, EVERY LINK PRINTED IN ONE GATHER:** no trailer → `findMergedByTrailer` cannot see
  #2972 → the shard stays `status: queued, attempts: 0` → **the dispatcher sends W1-T2318 three times**
  (runs …810730491, …814238514, …819701423), each recon concluding ALREADY_SATISFIED → the third run
  opens a plan-only PR to say so → **`corroborateByBranch` credits that PR as the ship**, because its
  plan-only guard `isPlanOnlyFilingPr` (`src/lib/status.ts`) tests for a LEDGER `plan_only` MARKER and
  never inspects the changeset. **W1-T413 already built the diff-based test (`isPlanOnlyChangeset`) —
  it is wired only into the trailer path, not the branch-corroboration path**, which is why the fix is
  one predicate moved between two call sites rather than a new lane (hence **no new TASK letter**).
  **WHY THIS IS NOT AN EXISTING PROPOSAL — the strongest form of the test, stated rather than
  asserted.** P29, P30, P33, P39 and P47 are, without exception, about credit the harness FAILS to
  record; their remedies read MORE sources (TASK G), widen the WINDOW (TASK L) or quarantine pairs that
  can never be recovered (P33). **Not one of them would have caught #3059, because #3059 was found,
  resolved and credited exactly as designed.** P56 is the first entry in this document about a credit
  the harness records FALSELY, and the asymmetry is why it ranks at 2 rather than beside P33: **a lost
  credit re-dispatches the work and self-corrects; a granted credit RETIRES the work and does not.**
  **THE COST IS ALREADY MEASURED, NOT PROJECTED:** in this window alone, **five runs across three tasks
  (W1-T2318 ×3, W1-T2323, W1-T2324) — 21% of the population — were dispatched onto work that had
  already merged** (#2972, #2998/#3000, #2999), each burning a full recon budget to rediscover it.
  **★ AND THAT HALF IS NOT CLAIMED HERE — IT IS P46's, AND SAYING SO IS THE POINT.** P46 clause (i)
  already owns *a shard whose `status:` is stale against DERIVED state is a premise wrong at dispatch
  time*, widened by R16 on six such shards; **this cycle is its largest reading since, and it is added
  to P46 in place, not annexed.** P56 owns ONLY the second half — **the credit the resolver then GRANTS
  to the plan-only PR a worker opens when it discovers the rot** — which is a step no existing entry
  reaches, and which converts a recoverable waste into an unrecoverable plan claim.
  PROPOSE: **(i)** `corroborateByBranch` (and every other branch/head-ref corroboration rung) calls the
  diff-based `isPlanOnlyChangeset` before recording a ship — the guard exists, it is simply not on this
  path; **(ii)** a credit whose PR carries no file outside `plan/**`/`docs/**` is recorded as a
  **PLAN FILING**, never as an implementation, and the retro's SHIPPED log renders it in its own class;
  **(iii)** the filing flow that closes a task APPENDS the `Remudero-Task:` trailer to its commits, not
  only to the PR body (T1012/#2240 established the committed-trailer discipline; these branches predate
  or bypass it) — without this, the same task re-enters the queue after the false credit is corrected;
  **(iv)** a task whose recon concludes ALREADY_SATISFIED against a named merged PR emits a
  `dispatch.already_shipped` ledger row, so the retro can price this class instead of reconstructing it
  from harvest prose; **(v)** the retro's own SHIPPED log is generated with the changeset check applied
  (DR-16), so a fabricated credit can never enter the plan's record silently.
  GOLDEN (fixture-only): a seeded merged PR on `run-W1-T999-…` whose diff is one `plan/tasks.d/*.yaml`
  file is NOT credited as W1-T999's implementation and IS classified as a plan filing; the same PR with
  one `src/**` file added IS credited; a task whose acceptance is satisfied by a merged untrailered
  commit is reported as UNCREDITABLE rather than re-dispatched; and a recon returning ALREADY_SATISFIED
  writes exactly one `dispatch.already_shipped` row naming the PR it found.
  **KILL TRIGGER (pre-committed, so this cannot become a standing item):** if **R32-4 reads zero** —
  no credited merge in the next window is plan-only — **P56 is PARKED at a one-off exactly as P51 was**,
  on the reading that #3059 was a hand-opened accident rather than a resolver defect; two consecutive
  zeros RETIRE it with its prose deleted.

  **★ R33 — THE BAR WAS PAID AND THE PROPOSAL WAS NOT: EVIDENCE HOLDS AT n=1, AND THE RANK IS NOW
  STRUCTURAL.** R32-4 quoted this entry's sentence verbatim and HIT on **#3113**, a merged
  `run-<taskId>-*` PR whose entire diff is `plan/feedback/fb-repair-blocked-fixable-2955.yaml` and
  which the W1-T51 union records as that task's ship. **But `TRIAGE-fb-repair-blocked-fixable-2955` is
  a feedback-repair shard whose DELIVERABLE IS THAT FILE** — the merge did its work, so the row pays
  P56's letter and not its meaning. **This entry's evidence base therefore stays at n=1 (#3059)**, and
  the honest disposition is that a second genuine member has not yet been observed. **DR-17 is
  written from this**, and R33-1/R33-4 carry their exclusions in advance. **★ THE RANK IS UNCHANGED AND
  ITS JUSTIFICATION HAS CHANGED:** P56 now holds rank 2 because **P57's remedy is unsafe without it** —
  both of this cycle's sibling-run PRs (#3093, #3104) are plan-only, so task-scoped credit ungated by
  `isPlanOnlyChangeset` would have fabricated two credits in one window. **Build order is a ranking
  argument even when evidence weight is not.**
  **★★★ R35 — THE SECOND GENUINE MEMBER ARRIVES, AND P56 STOPS BEING STRUCTURAL: n=1 → n=2.**
  **#3195**, merged on **`run-W1-T2371-1787887882921`**, has an entire diff of one path —
  `plan/tasks.d/W1-T2371-the-risk-judge-cannot-pass-an-amendment.yaml` — and is recorded by the ledger's
  `Merged since marker`, by SHIPPED, and by the credit band as **W1-T2371's implementation**. **Rule
  17's exclusion is applied and does NOT save it:** unlike #3113, W1-T2371 is not a feedback-repair
  shard whose deliverable is that file — **it was dispatched `type: implement`**, and its own rationale
  (quoted in the harvest) concludes *"RECORD, DO NOT BUILD — FOR NOW"*. **Two other sections of the same
  gather agree the merge did not do the work:** degraded-success mining prints the run at
  **`proof_exec 0/5 executed, floor_degraded`**, and the harvest asks that the `type: implement` filing
  be flagged *"to whoever curates task generation."* **Only the credit resolver is convinced.** The
  KILL TRIGGER is now two readings away from irrelevance rather than one from firing; **the rank holds
  at 2 and its justification is finally EVIDENTIAL** — clause (i) alone (`isPlanOnlyChangeset` on the
  branch-corroboration path) would have refused this credit without knowing anything about the task.
- **★ P55 (measurement + golden; R31's mint — ★ CLAUSE (i) REFUTED BY R32's DELETION EXPERIMENT AND
  DELETED WITH IT; the entry survives on clause (ii) alone and DROPS to rank 13) — THE SELF-CONFIRMING
  SCAN.** AS MINTED: the SHIPS-UNWIRED rung returns one line for a fifth cycle and cites, as its
  evidence, this plan's own prose reporting the previous run of the same scan — so the retro re-seeds
  the corpus it reads. **R32 ran the only experiment DR-9 allows: it DELETED the retro-authored
  prose** and left `mainHealthFromRollup` named exactly once inside NET STATE, in *Still PLANNED*.
  **★ R33 — THE EXPERIMENT RESOLVED, AGAINST THE PROPOSAL.** The line **PERSISTED** against a corpus
  that no longer contained the retro's report of it. Per R32's own pre-committed reading, *the finding
  is about the SYMBOL, not the PROSE*: clause (i) (exclude retro-authored regions from the corpus) is
  **refuted and struck**, and the rung has been telling the truth about a genuinely unwired symbol
  (T2204/#2691) all along. **What survives is clause (ii), and this cycle sharpens why it is still
  needed:** the sentence the scan quotes as evidence is now the *Still PLANNED* line itself — the one
  place the symbol may legitimately be named — so the rung STILL cannot cite anything but prose.
  **★ R34 — CLAUSE (ii)'s BLUNTEST EVIDENCE YET: THE QUOTED "CAPABILITY SENTENCE" IS NOT A SENTENCE.**
  This cycle the rung quotes, verbatim, a **mid-word byte slice** of a NET STATE line, opening at
  `` `i.yml` `` (the tail of "…neither `ci.yml` nor `ci-gate`'s REQUIRED roster…"). The rung is not
  citing a claim; it is citing a window of characters that happens to contain the symbol. **A remedy
  that cites the SYMBOL's definition site is not a refinement of this behaviour, it is the first
  version of it that cites anything at all.** **KILL TRIGGER NOT FIRED:** the returned set is unchanged
  (one line, `mainHealthFromRollup`), a seventh cycle.
  PROPOSE (the whole proposal now): **the emitted line cites the SYMBOL's definition site and the
  absence of a caller, never the sentence that mentioned it**, so the evidence is code-side and cannot
  be authored by the reader. GOLDEN (fixture-only): a seeded plan asserting `S` with no caller in the
  seeded tree produces a line citing `S`'s definition site, not the asserting sentence; a seeded plan
  where `S` gains a caller produces no line even though the prior cycle's report of `S` is still
  present in the text. **KILL TRIGGER (unchanged, and now one reading closer):** two consecutive cycles
  in which the returned set CHANGES while the retro's prose about it is unchanged retires P55 outright.
  **Ground-truth prose, the P40/P48 comparison and clauses (iii)–(iv) are DELETED by R33** — a refuted
  mechanism does not get to keep its argument.
- **★ P49 (plan + golden; R23's mint, PROPOSED, pending ratification — rank lives in the ONE ranking line above) — A SAFETY FIELD
  WAS BULK-EDITED AND ITS OWN RATIONALE WAS NOT, SO THE PLAN NOW LIES TO THE DISPATCHER ABOUT WHAT MAY
  BE AUTO-DISPATCHED.** GROUND TRUTH (this cycle's harvest, eight named shards): PR **#2165** re-banded
  **fifteen** verification-shaped tasks to `verify: auto`; at least **eight** of them still carry a
  `note:` asserting the opposite in prose — *"`verify: human` IS SET UP FRONT … this shard can never be
  picked up by the drain"* — for **W1-T446, T947, T949, T951, T952, T964, T975, T983**. The field is
  what `isDispatchEligible` reads (`t.verify !== "auto"` in `src/lib/drain.ts`); the prose is what a
  worker, a reviewer and an Architect read. **TWO OF THE EIGHT WERE THEN DISPATCHED AND MERGED BY
  WORKERS INTO EXACTLY THE SCENARIO THEIR OWN NOTES FORBADE:** **W1-T947/#2194** edits the auto-merge
  ARM sites (a worker auto-merging a change to the rule that decides auto-merging — §4B's single
  worst failure mode, named there in those words) and **W1-T949/#2196** edits the id ALLOCATOR a worker
  uses to mint its own ids. Both runs' recon flagged the contradiction, escalated it as *"resolve
  before this is armed by anything other than a human"*, and **shipped anyway**, because nothing in the
  gate stack compares a shard's field to its own prose. **WHY THIS IS NOT AN EXISTING PROPOSAL:**
  **P46** is a premise wrong at FILING time and rotting against the WORLD; P49's shards were internally
  contradictory the moment #2165 landed, and the contradiction is against THEMSELVES, checkable with no
  external state. **P48** is a live reader answering wrongly; here every reader answers correctly — the
  DATA disagrees with itself. **P39** is dispatch ignoring merged trailers; this is dispatch obeying a
  field the plan's own text disclaims. **P33** is a foreign trailer poisoning a task; this is the
  plan poisoning itself. **THE CLASS, STATED ONCE:** any bulk edit to a gating field leaves the prose
  that justified the old value in place, and a plan that contradicts itself will always be resolved in
  favour of the machine-readable half — silently, and in the direction of MORE autonomy. PROPOSE:
  **(i)** a `lint-plan` check that FAILS when a task's `verify:`/`type:`/`risk:` field is contradicted
  by a `verify:`/`human`/`auto` claim in that same task's own `note:`/`rationale:` prose — one file,
  no cross-references, no GitHub; **(ii)** the check names BOTH sides in its message (field value, the
  quoted prose line, the line number) so the resolver is an Architect edit, not a guess; **(iii)** a
  bulk re-band PR is REQUIRED to update or delete the prose it invalidates, which this check enforces
  for free the moment it exists; **(iv)** the eight known shards are reconciled in one plan-only PR —
  NOT auto-filed here — not because a rule forbade it (rule 27 permits it), but because deciding
  whether T947/T949 should be `human` or `auto` is an
  operator ruling, not a lint fix. GOLDEN (fixture-only): a fixture task with `verify: auto` and a note
  containing *"verify: human"* FAILS with both sides quoted; the same task with the note deleted PASSES;
  a task with `verify: human` and a note saying *"human"* PASSES; a note that merely mentions another
  task's `verify:` value (a cross-reference, `W1-T123's verify: human`) does NOT fire — the check reads
  claims about ITSELF only, and that exemption is what keeps it from being disabled as noisy.
  KILL TRIGGER: if a full pass over `plan/tasks.d/*.yaml` finds these eight and nothing else, and no
  ninth appears within two cycles, P49 is a ONE-OFF CLEANUP and should be closed as such rather than
  ratified as a standing gate — **the proposal is about a RECURRING bulk-edit hazard, and one bulk edit
  is not yet a pattern.** **★ R24: CYCLE 1 OF 2 ELAPSED, NO NINTH SHARD OBSERVED** — but this cycle's
  harvest surfaced the ADJACENT defect (`plan/tasks.yaml` and `plan/tasks.d/*.yaml` disagreeing about
  which tasks EXIST, five runs flagging it independently), which is the same class one level up: **the
  plan disagreeing with itself in a way only the machine-readable half resolves.** P49's kill trigger
  is NOT satisfied by that — it asks about a ninth `verify:`-vs-prose shard specifically — and R24
  records the near-miss rather than quietly widening the trigger to save the proposal.

- **★ P50 (plan + golden; R24's mint, ★ PROMOTED BY R25 to rank PROPOSED at 5 — past P38, on a
  MECHANISM and not on a count) — A RETIREMENT
  BAR WRITTEN IN A VOCABULARY ITS OWN INSTRUMENT CANNOT EMIT IS UNFALSIFIABLE, AND THIS FILE IS FULL
  OF THEM.**
  **★ R27 EVIDENCE, IN PLACE (supersedes R25's) — CLAUSE (iv)'S WORKED EXAMPLE IS HALF-SHIPPED, AND
  THE HALF THAT SHIPPED PROVES THE CLASS RATHER THAN CLOSING IT.** R24 mined P50 from thirteen
  `containment/outside-cwd-denial` firings that could only ever emit `unproven`; R25 saw a DIFFERENT guard
  family (`isolation/inherited-functions`) emit the identical single value (R24-4 HIT), which is what
  promoted this entry — two independent checks, one vocabulary, one unsatisfiable bar. **R27: T1281/#2685
  shipped TASK M(i) and the vocabulary widened from 2 values to 4** — this cycle's 23 guard rows read 12
  `unproven`, 4 `probe-never-ran`, 7 `write-never-attempted`, split chronologically at that merge. **P41's bar
  is STILL unsatisfiable: none of the four values is `proven`**, so a guard family that fired 22 times in
  one window still cannot re-arm the proposal its own firings were supposed to test. **That is the
  cleanest statement of this class the file will ever get: the instrument was FIXED, the vocabulary
  QUADRUPLED, and the bar written in words the instrument never emitted is exactly as unfalsifiable as
  before.** Clause (iii)'s lint check — fail a NEW trigger phrased as `observed: <literal>` when that
  literal appears in no ledger step registry and no `src/**` string — is now MANDATORY rather than
  proposed, and it is cheap: it would have caught P41's bar at mint time and would catch the next one
  without any of this evidence.
  GROUND TRUTH (mechanical, verified by R24): **P41 was retired 2026-08-03 with the bar
  *"RE-ARM only on a recurrence, from fresh evidence"*, sharpened in NET STATE to *"two firings of a
  shell-isolation-family check, ≥1 `observed: proven`"*. This cycle delivered THIRTEEN firings** — and
  `src/lib/containment.ts:505-557` derives `observed` for the `outside-cwd-denial` check as exactly
  two possible values: the literal `"unproven"`, or the prose `"outside-cwd write succeeded (sandbox
  did not engage)"`. **The string `proven` is emitted by NO code path**, and the only proven-shaped
  value means the sandbox actually broke. **So the bar reads as "re-arm on recurrence" and behaves as
  "re-arm on a security incident" — a 6.5× stricter test than the words say, and no reader of this file
  could tell.** The failure is general, not local: a kill/re-arm/retirement trigger is a PREDICTION
  ABOUT AN INSTRUMENT'S OUTPUT, and this plan has never once checked that the instrument can produce
  the value the trigger names. **WHY THIS IS NOT AN EXISTING PROPOSAL:** **P43** is about the harness
  not being able to tell a fix from a fluke — it assumes the metric is measurable and asks whether the
  effect is real; P50 is the layer beneath, where the metric's stated value cannot occur at all. **P48**
  is about publishing a naked zero as if it were a measurement; P50's zero is not published, it is
  STRUCTURAL — the counter was never able to be non-zero. **P40/P42** are instruments mismeasuring the
  FLEET; P50 is the plan's own governance clauses being unfalsifiable. **THE CLASS, STATED ONCE:
  whenever this file retires, kills or re-arms anything on a condition, the condition must be written
  in values some named instrument DEMONSTRABLY emits — otherwise the retirement is permanent by
  accident and reads as reversible.** PROPOSE: **(i)** an inventory pass over every KILL TRIGGER,
  RE-ARM BAR and pre-committed consequence in this file, each annotated with the instrument and the
  exact emitted values that would satisfy it — a plan-only PR, no code; **(ii)** any trigger whose
  satisfying value no instrument emits is either REWRITTEN in emittable terms or struck, and the
  rewrite is recorded as a correction, never as a fresh mint; **(iii)** a `lint-plan` check that fails
  a NEW trigger phrased as `observed: <literal>` / `verdict: <literal>` when that literal appears in no
  ledger step registry and no `src/**` string — cheap, offline, and it would have caught this one at
  mint time; **(iv)** P41's own bar is restated by TASK M(iii) as the worked example. GOLDEN
  (fixture-only): a fixture trigger naming a value present in the step registry PASSES; one naming an
  absent literal FAILS with both the trigger text and the registry it searched quoted; a trigger phrased
  in prose with no `<field>: <literal>` shape is IGNORED, never guessed at — the check refuses to
  hallucinate a vocabulary it cannot see. KILL TRIGGER: if the inventory in (i) finds P41's bar and
  **nothing else** — every other trigger in this file already emittable — P50 is a ONE-OFF correction
  and closes with TASK M, because one unfalsifiable clause is a bug and not a class.

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
  **★ EVIDENCE LOG (R15/R16/R19/R21 updates FOLDED BY R21).** MAST `specification` has read 0 since
  R15 with P46 unratified, so the metric is **UNATTRIBUTED** and the rank holds on the shape, never on
  the count. **R16 WIDENED the entry without changing its remedy**: the rot is in the plan's own
  record too — six `tasks.d` shards read `status: queued` while their work was MERGED, reported
  independently by four runs — so clause (i)'s premise check must read a shard's `status:` against
  DERIVED state (cheap since W1-T367/#1412), because a task whose status field is stale is a premise
  wrong at dispatch time by definition. **R19 supplied the first CONTRARY reading** (W1-T500's recon
  found its shard accurate) and **R21 a second** (the plan-state truth rung passed on 33 lines with no
  contradiction) — recorded so no future retro claims a trend either way from quiet readings, which
  was R14's P33 mistake. Clause (iii)'s motive is unchanged and is the strongest part: every one of
  these was SEEN by a worker and none could be written down.
  **★ R32 — THE LARGEST STALE-`status:` READING SINCE R16, AND THE FIRST WITH A PRICE.** Three shards
  (**W1-T2318, W1-T2323, W1-T2324**) read `status: queued` while their work sat merged on `main`
  (#2972, #2998/#3000, #2999); **W1-T2318 was dispatched THREE separate times**, and the five runs
  together are **21% of a 24-run window**. The cause is upstream of the field: those merges carry **no
  `Remudero-Task:` trailer**, so the DERIVED state clause (i) wants to compare against cannot see them
  either — **premise-rot with no derivable ground truth to check the premise against**, which is the
  hardest form of this entry and the one its remedy must now address. The DOWNSTREAM consequence (the
  plan-only PR a worker opens on discovering the rot, then credited as the implementation) is **P56**,
  minted this cycle; P46 keeps the dispatch-side half and gains no new clause.
**RETRO-1785599040918 (R13, prior cycle)** — 34 runs / 22 tasks / 25 PRs / 16 credits (`blocked_ci`×7,
`failed`×5, `blocked`×3, `no_pr`×3, 6 rejected trailers). **NO NEW P-NUMBER** — P8's accretion rule.
One surviving TASK proposal under an existing id:

- **★ TASK A (P38 — the LEARNINGS write path; ITS PROBATION IS RESOLVED BY R30 AND IT RETURNS).**
  R22 observed the corpus move 74 → 79 with TASK A unbuilt and put the task on probation with a
  pre-committed disposition: *STRUCK if the count keeps climbing, RETURNS with its rank if it refreezes
  at 79.* **It refroze at 79 and has held there for EIGHT consecutive cycles with `0 added`, so the
  disposition resolves in the task's favour and R30 records it as RETURNED rather than re-arguing it.**
  *(Honest bound, stated not assumed: R30's judge PROPOSED one promotion, so the pipeline is not inert
  — what has never happened is a WRITE, which is exactly the path this task proposes.)* PROPOSE: the
  harvest's
  `[action] … LEARNINGS` items become a first-class DISTILL QUEUE input — the retro (or the sweep)
  converts each into a schema-valid P32 layer-(i) entry with provenance `[src: run#…]` and the citing
  PR, appended by the same gated write path any other knowledge edit uses (§Self-improvement's
  RSI-safety rule: it ships as a PR). GOLDEN (fixture-only, no live dep): a seeded harvest carrying one
  `LEARNINGS`-flagged action yields exactly one appended entry with provenance and last-cited date; a
  harvest with none appends nothing and still emits its rung line (P38(ii)); an entry duplicating an
  existing one is marked CONTESTED by W1-T88's detector rather than appended twice.
**RETRO-1785456064479 (R12, prior cycle)** — 54 runs / 25 tasks / 4 credits (`blocked_ci`×11,
`blocked`×10, `failed`×10, `blocked_containment`×6, `no_pr`×4, `incomplete`×4, `blocked_isolation`×3,
`pr_attribution_failed`×2, 25 rejected trailers — 20 SIBLING, 5 FOREIGN).

- **P41 — RETIRED 2026-08-03 by its own kill trigger; prose DELETED (git holds it).** One line
  survives: the per-run isolation probe (W1-T17/#99) is an adequate backstop alone, and nothing ever
  proved what changed on that host, so the disappearance is not a fix anyone may claim.
  **★ R24 — THIRTEEN GUARD-FIRED BLOCKS, AND IT STILL DOES NOT RE-ARM, FOR A REASON THAT IS ITSELF THE
  FINDING.** One host, 41 minutes, `containment/outside-cwd-denial` ×13, **every one `observed:
  unproven`** — the state that proves nothing about the sandbox either way. The re-arm bar as written
  (*two firings, ≥1 `observed: proven`*) demands a value **no code path emits** (`containment.ts:505-557`
  derives only `"unproven"` or a proven-BROKEN prose string), so it can be satisfied only by an actual
  sandbox breach. **RULING: STAYS RETIRED under the bar as written; the BAR is corrected under P50 and
  TASK M(iii), not the retirement reversed** — reversing on a clause just shown to be unsatisfiable
  would be scoring the instrument's silence as evidence (P48). The 13 firings are recorded as an
  INFRASTRUCTURE EVENT (DR-8), not as a P41 recurrence.
- **★ P42 (measurement; sibling of P40) — A VERDICT CLASS CAN OWN 42% OF A CYCLE AND THE GATHER
  CANNOT NAME ONE OF THEM.**
  **★★ R39: THE SMALLEST UNMAPPED SHARE THIS TABLE HAS PRINTED — AND NOTHING WAS MAPPED.** MAST maps
  `verification 18` (+12) and `infrastructure 0` (−1); only `incomplete`×3 is unmapped, **3 of 21 = 14%**
  against last cycle's 12 of 19 = 63%. **The improvement is entirely a change in the window's verdict
  MIX** — seventeen `blocked_ci` rows landing in an already-mapped class — **and `incomplete` still maps
  to nothing, a sixteenth cycle.** **Recorded and explicitly NOT scored as improving** (rule 6: a rate
  that moves because the denominator's composition moved is not a fix). ★ **AND THE ENTRY GAINS A
  SHARPER SIBLING THIS CYCLE:** `verification`×18 is now a category so large it hides P63's five
  deadlocked runs inside seventeen ordinary-looking blocks — **a mapped label can conceal as much as an
  unmapped one when the label is broader than the failure.**
  **★ R38: THE LARGEST UNMAPPED SHARE THIS TABLE HAD PRINTED — 12 OF 19 NON-MERGED RUNS.** MAST maps
  `verification 6` (+4) and `infrastructure 1`; `incomplete`×9, `blocked`×2 and
  `blocked_transient:success`×1 are NAMED as unmapped rather than guessed. **`incomplete` alone is 33%
  of the entire window and belongs to no category**, so the mapped failure mass describes 37% of the
  failures and the mount table's defect signal is computed over the rest.
  GROUND TRUTH: `failed` went from **6 of 147 (4%)** to **10 of 54 (19%)** — the
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
  **★ EVIDENCE LOG (R12–R15 FOLDED BY R15, R16–R26 BY R27).** `failed` ran 4% → 19% → 15% → **42%
  (R14, the majority class)** → 0% for five cycles → 1 (R26) → absent again (R27); dominance passed to
  `incomplete` (seven straight cycles), then to `blocked`, and this cycle to **`blocked_containment`×22**.
  Across every one of those readings the gather emitted a bare count with no run id, task or error line.
  **THE CLASS VANISHED AND P42 SURVIVES IT, RANK 11, NOT CLOSED**, because both live clauses outlived
  their original target and the durable ask is *name the runs behind ANY class the mapping cannot
  derive*, never *name the `failed` ones*. **(ii) — RATE, NOT COUNT — is what makes this cycle legible at
  all:** MAST prints `infrastructure 23 (+23)` and `verification 11 (−4)` as raw count deltas across
  denominators of 31 and 52, so the swing reads as deterioration when it is one host storm arriving in a
  bigger population. **★ AND R27 SUPPLIES THE ONE THING THE ENTRY HAS NEVER HAD: A WORKED COUNTER-CASE
  IN ITS OWN FAVOUR.** The containment class DID get per-row detail this cycle — task, run id and
  `observed:` state per block — and that detail alone let this retro split 23 rows into three causes on a
  chronological boundary and close TASK M(i). **That is clause (i) shipped for exactly one class**, and
  it is the evidence that per-run exemplars are cheap and decisive rather than nice-to-have.
- **HARVEST CANDIDATES — STANDING DISPOSITION, NOT A PER-CYCLE LIST.** Per-cycle harvest lists are the
  duplication HARNESS-COMPRESSION forbids: the harvest is LIVE (P26's trigger fired), reproducible
  from any gather, and what it argues for is already ranked — nearly every item since R12 has been
  **P38's** shape (a fact nothing can write down, or a wire with no consumer) or **P46's** (a task
  file already wrong when read). Two standing operational notes, kept because they belong to no task:
  **(1)** the primary checkout `~/Remudero/repos/remudero` drifts ~100 commits behind `origin/main`
  per cycle (85 → 155 → 278 → 371 …) — any tool reading that path instead of a worktree sees a stale
  tree. **(2)** in the worker sandbox `rmd preflight`/`rmd review` frequently cannot run at all —
  `loadConfig()` hard-fails on an empty synthetic-HOME config and tsx's loader EPERMs binding an IPC
  socket outside the writable allowlist. **A sanctioned command workers must run before pushing, and
  routinely cannot, produces exactly the "explain the red step away in the PR body" ritual.**
  *(R19: `checkCliFreshness` refusals are no longer silent — T486/#1812 ledgers them through an
  injected sink — so that third leg of the note is DELETED as shipped, not folded.)*

**DECISION-QUALITY REVIEW (2026-08-02, OUT-OF-CYCLE — not retro-mined).** Derived from reading the plan
against the decision-research literature (§5E carries the mapping and the vocabulary). Candidates for
the Architect to ratify via a tasks.yaml PR — **not auto-filed AT THE TIME OF WRITING** (the doctrine
mis-cited as a §12 rule number; rule 27 now permits it), deliberately NOT written
as tasks. Each names a root cause no open proposal covers; everything else the literature flags here
is already an instance of P38, P40(ii), P42 or W1-T271 and is folded there rather than given an id.

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
  **★ R27 (RANK 3, HELD — the promotion is not re-argued): THE FIRST CYCLE THAT TESTED DR-10
  CONFIRMED IT, AND BOUGHT RULE 11 ON THE SAME SCORING.** R25 hit four of four and R26 missed three of
  three, which promoted P43 to rank 3 and produced **rule 10** (*register the BAND or the INVARIANT,
  never last cycle's point*). **R26 then re-cut its own four rows accordingly — and R27 scored 1 hit, 3
  misses, with the HIT being the ONE row registered as a numeric BAND (R26-3, credit inside 25–65%,
  observed 55%).** The three that missed were an existence claim (R26-1, observed zero), an arithmetic
  invariant (R26-2, the column reset) and a directional threshold (R26-4, depth 3.6 h against >6 h).
  **Rule 10 is therefore confirmed by its own first application, at n=4, and the corollary is sharper
  than the rule: even an INVARIANT is a level in disguise when the underlying instrument can be re-cut
  between windows.** R26-4's miss bought **rule 11** (*a scope sized by a volatile measurement is sized
  on the MAXIMUM ever observed, never the latest reading — a falsifier that fires in the safe direction
  does not shrink the work*), which is clause (ii) applied to SCOPING rather than to attribution: a
  quiet reading is the single most likely thing to revert, so shrinking a scope on one is the same error
  as attributing a fix to one. **All four of R27's own rows (R27-1..R27-4) are registered as classes,
  invariants or bands, and R27-4 is the first row this file has ever registered as a REGRESSION TEST ON
  A SHIPPED CAPABILITY rather than as a request for one — which is what rule 1 has been asking for since
  R16.**
  **★ EVIDENCE LOG (R14–R20 per-cycle UPDATE stack FOLDED BY R21 — the DR rules and the running
  line ARE the durable content, and both live in NET STATE's scoring block; git holds the prose).**
  **The line: n=49 · hit 13 · miss 18 · unresolvable 18**, and the ELEVEN DR rules it has yielded
  (all stated in NET STATE's scoring block) were each bought by a specific scoring, not reasoned out in
  advance. What the stack established, once: **(a) CLAUSE (ii) IS THE LOAD-BEARING CLAUSE** —
  R14/R15/R19/R20/R21 each had 4–5 headline metrics move with nothing built to move them, and reporting
  them UNATTRIBUTED is the only reason this file has not retired live proposals on noise (R14 called P33
  "stable" on one quiet cycle; it returned at 4 new pairs). **(b) A MISS IS WORTH MORE THAN TEN
  UNRESOLVABLES** — R18-1's MISS bought TASK G, R19-1's bought P47's rank, R20-1's bought the coverage
  caveat, R21-1's bought the `UNMEASURED` merge column, R21-2's bought rule 5's ratification, R26's three
  bought rule 10, **and R26-4's bought rule 11 — a miss in the SAFE direction, which is the kind this
  file had never had to reason about before.** **(c) CLAUSE (ii) EXTENDS TO A METRIC'S RIGHT TO EXIST**
  — P29 was ranked for eight cycles on a dial its own fix was not wired to; before attributing OR
  refusing to attribute a move, state the causal path, and STRIKE a metric that has none. **R22 gave (c)
  its sharpest instance** (P38 held rank 3 for eleven cycles on a frozen LEARNINGS counter, and when the
  counter moved WITHOUT P38's fix, the causal path it had asserted was shown never to have existed);
  **R27 gives it a second: P51 was minted and ranked 4 on a class that read ZERO one window later, so a
  proposal's rank must survive its own falsifier or be parked.** Clause (i) — store the table as DATA
  beside each proposal — is still the entire remaining ask, and after 49 scored rows it is the difference
  between a calibration line and a paragraph a retro can quietly re-word.

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

- **★ P38 (plan + golden; RANK 9, HELD as of R30) —
  THE DEAD-CONSUMER CLASS: ORGANS MERGE, PASS THEIR GATE, AND CANNOT BE SHOWN TO RUN.**
  **★★ R40 EVIDENCE, IN PLACE — THE JUDGE'S OWN NUMBER NO LONGER ORDERS ITS OWN DECISION, AND FOR
  THE FIRST TIME THAT IS PROVABLE INSIDE A SINGLE TABLE.** This cycle's promotion block **DECLINES
  `browser-egress-needs-dedicated-profile` at 0.90** and **PROMOTES `body-fetch-guards-on-http-not-size`
  at 0.78** — no value of `c` separates the two classes. The same entry has now read **0.90 PROPOSED →
  0.87 DECLINED → 0.78 PROPOSED** across three judgements on an unchanged corpus (79 entries, `0 added`,
  an EIGHTEENTH cycle), and `bashrc-accident` rose 0.70 → 0.75 without changing either. **Thirteenth
  judgement, zero inputs moved, zero writes.** The confidence number is published beside a decision it
  does not determine, so either a threshold exists and is unpublished, or the `applicability` axis is
  doing the deciding and the number is decoration. **R40-6 registers exactly that separability test.**
  **★ R38 EVIDENCE, FOLDED — THE ELEVENTH JUDGEMENT CROSSED A THRESHOLD ON UNCHANGED EVIDENCE.**
  `body-fetch-guards-on-http-not-size` reads **0.85 → 0.90 and enters PROPOSED PROMOTION to
  `user-overall`**, over a corpus still frozen at **79 entries, `0 added`, a SIXTEENTH cycle**, with
  the other three arms declining at 0.87 / 0.72 / 0.80. **Nothing about the entry changed; the score
  did.** A promotion manufactured by score drift is the strongest form of clause (iv)'s claim yet, and
  it is recorded as a PROPOSAL — this plan-only PR writes no learning at any layer.
  **★★ CLAUSE (iv), R29's — HARDENED BY R30 FROM *UNSTABLE* TO *OSCILLATING*, AND REWRITTEN BY R33 TO
  *NOISE* AFTER TWO CHARACTERISATIONS DIED. ★ R34: THE NOISE READING SURVIVES ITS FIRST TEST.**
  `body-fetch-guards-on-http-not-size` has now been judged **seven times over a corpus frozen at 79,
  `0 added`**, for zero writes: **PROPOSED@0.85 → DECLINED@0.8 → PROPOSED@0.8 → DECLINED@0.82 →
  PROPOSED@0.7 → PROPOSED@0.78 → PROPOSED@0.70.** R31 called it drift and R32 refuted that; R32 called
  it period-2 and R33 refuted that; **R33 called it noise and this reading does not refute it** — three
  consecutive PROPOSED verdicts, non-monotone in confidence, on an unchanged input. **The clause is
  kept in the words that predicted the reading rather than described the last one.**
  **THAT DISTINCTION IS THE CLAUSE'S WHOLE PRICE:** a single reversal
  is consistent with a corrected mistake and would justify only clause (iv-a); a round trip is not, and
  it is what makes (iv-c) — *report the DISAGREEMENT, never the later verdict* — the load-bearing
  clause rather than a nicety. The anchor moved too, `browser-egress-needs-dedicated-profile` holding
  its verdict while sliding **0.88 → 0.88 → 0.85**, so the judge is not pinned on anything.
  **THE MECHANISM THAT MADE IT VISIBLE IS ALSO THE PROBLEM:**
  a promotion is only a proposal until a reviewed `learnings/` PR lands it, and no such PR has ever been
  filed — **so an unratified promotion is not a pending decision, it is a coin that gets re-flipped
  every cycle.** PROPOSE, inside this proposal rather than beside it: **(iv-a)** the pass records each
  entry's `(applicability, confidence)` verdict on the ledger so a reversal is detectable by machine
  rather than by a human diffing two retros; **(iv-b)** a proposed promotion carries an expiry — if it
  is not ratified within N cycles it is reported as LAPSED with its original verdict quoted, never
  silently re-judged; **(iv-c)** where two consecutive passes disagree on `applicability` for an
  unchanged entry, the pass reports the DISAGREEMENT as its output rather than the later verdict.
  GOLDEN (fixture-only): a seeded corpus judged twice with a forced verdict flip makes the pass emit a
  disagreement row naming both verdicts, and never emits the second verdict alone. **R29-5 SCORED: HIT
  — the flip recurred, in the returning direction.** *(Caveat kept honest: this gather sees corpus
  SIZE, not entry TEXT, so an edited entry cannot be ruled out — which is itself why (iv-a) is the
  first clause. Also recorded rather than folded away: TASK A's probation resolved in the same reading,
  since the corpus refreezing at 79 for eight cycles is the branch that RETURNS it.)*
  **★ R27 EVIDENCE, IN PLACE — THE HEADLINE ORGAN OF THIS PROPOSAL JUST CAME ALIVE, AND IT PROVES THE
  CLASS RATHER THAN CLOSING IT.** For six cycles the learnings-promotion pass was P38's exhibit: built,
  merged, gated green, and unable to be shown running. Its blocker narrowed from *"the pass did not
  run"* (missing BUILD) to *"no promotion judge was supplied"* (missing INPUT) to — this cycle —
  **W1-T1249/#2612 supplying a bounded judge, after which the gather printed a real verdict: ONE
  promotion PROPOSED and THREE DECLINED under three distinct named reasons.** **The lesson is the
  interval, not the ending: an organ can sit gated-green and unreached for six cycles, and the only
  thing that ever told this file which of the three states it was in was a human reading a gather
  message that happened to change wording.** That is clause (ii) — execution telemetry as a standing
  shape — argued better by six cycles of absence than by any prose. **AND THE CLASS DID NOT SHRINK:**
  the corpus is still frozen at **79, `0 added`, a FIFTH cycle** (nothing was written even though the
  judge ran, because ratifying a promotion needs a `learnings/` PR nobody has filed), the golden-task
  replay suite (T165/#2232) is dark for a FIFTH cycle with no `HarnessRunner` wired, `judgeRepairStall`
  (T1209/#2511) still has no production reader, and **R27 adds THREE fresh instances shipped dark in
  this very window: `mainHealthFromRollup` (T2204/#2691, no gateway, no dispatch-loop caller),
  `SweepDeps.readCiGateRollup`/`reaggregateCiGate` (T1275/#2672, no wire in `buildSweepEffects`), and
  `scripts/state-citation-check.mjs` (T1263/#2657, in neither `ci.yml` nor `ci-gate`'s REQUIRED
  roster)** — each named as unwired by its own PR's follow-up note, which is the honest version of this
  failure and is counted as such. **RANK:** P38 drops one place because **P52 has a live, measured
  population and P38's live meter (the corpus counter) has been retired since R25** as untesting — a
  metric that never changes state cannot score, by the mirror of R23-2's rule. The CLASS is untouched.
  **★ CLAUSE (i)'s LINT RUNG IS BUILT, RUNNING, AND PERMANENTLY AT `warn` — the check that exists to
  catch dark organs is itself half-dark.** `callSiteViolations` (`src/lib/task-linter.ts`) refuses a
  task that creates a new `src/**.ts` module without an acceptance criterion proving a CALL SITE
  (`grep: <symbol>( in <a file that is not the new module>`, the open paren required because a bare
  symbol name passes on a comment). It is wired into `lintTask` with two real `moduleExists` call
  sites, so it genuinely runs — **but `opts.callSite` defaults to `"warn"` and NOTHING IN THE TREE EVER
  PASSES IT**, so it has never blocked anything. **The remaining work is a RETROFIT AND A SEVERITY
  FLIP, NOT A BUILD**, and the cost is the backlog of filed tasks that would fail on the flip — an
  operator call, because it tightens a gate against work already accepted.
  DIAGNOSIS: **the gate proves a UNIT and never a WIRE.** Standing rule 14 already says "the call site
  is a deliverable" — it is INSTRUCTION, and §5's doctrine is that instructions shape behaviour while
  gates guarantee it. PROPOSE: **(i) A CALL-SITE LINT RUNG** — lint-plan REFUSES a task whose every
  acceptance proof is a unit test over a pure function; a task whose deliverable is a function/module
  MUST carry at least one criterion naming a LIVE call site on the dispatch/daemon path (grep-shaped,
  executable dialect). **(ii) EXECUTION TELEMETRY AS A STANDING SHAPE** — every reconciler / governor /
  distill rung appends one line naming rung, repo, candidates-considered, actions-taken, **even when
  zero**, so "did it run" is never again inferred from a downstream metric or from a message's wording.
  **(iii) THE EFFECT ASSERTION** — when a cycle credits a task whose stated purpose was to move a signal
  THIS gather measures, the NEXT retro asserts the signal moved and FLAGS it if not; a flagged organ is
  a plan-health item, not a silent success. GOLDEN (fixture-only, no live dep): a seeded task whose
  proofs are all pure-unit FAILS lint-plan and the same task with a call-site criterion PASSES; a seeded
  ledger in which a governor never emitted a rung line makes the effect assertion FLAG; a rung that ran
  with zero candidates still emits its line.
  **★ EVIDENCE LOG (R16–R22 prose FOLDED BY R19 and again BY R27; git holds the per-cycle
  restatements).** **(1) THE FROZEN CORPUS AND WHAT IT DID NOT PROVE.** LEARNINGS read 74 with zero
  added for nine cycles, moved to 79 in R22 **with TASK A unbuilt**, and has been frozen at 79 for five
  more. R11/R13's inference — *"this is a missing WRITE PATH and TASK A is the narrowest fix"* — was
  falsified by that move and is DELETED rather than re-argued. **The durable lesson: a counter frozen
  for eleven cycles was read as proof of a specific missing mechanism, when all it ever proved was that
  the number was not changing** (P43's counterfactual gap, operating on P38's own headline metric).
  **(2) THE MINER HANDS THE CORPUS CLEAN SHAPES AND THE CORPUS CANNOT TAKE THEM** — `implement ×
  clean_single_strike` over 4, 7, 12, 10, 14 and now **17 runs**, mechanically derived, needing no LLM
  judgment to record, each going nowhere. **(3) THE SHIPS-UNWIRED SCAN MEASURES THE WRONG POPULATION** —
  R15's *"reads clean"* evidence is WITHDRAWN: it read clean while organs shipped dark by their own PRs'
  admission, because its population is symbols a NET STATE claim NAMES, so an organ the plan has not yet
  boasted about is invisible to it. **This is the argument FOR clause (i):** a filing-time gate sees
  every task; a prose-keyed scan sees only the advertised ones. **(4) RECON IS RE-BOUGHT EVERY
  DISPATCH** — full ground truth on **TASK B**, which lives under P38 because it is the same missing
  organ. **(5) R15's RECEIPT, KEPT BECAUSE IT PRICES THE CLASS:** fourteen distinct tasks
  independently rediscovered ONE defect (`defaultPreflightSpawn`'s missing `spawnSync` `maxBuffer`)
  until W1-T338/#1327 fixed it for **$3.482 / 53 turns** — the cheapest implement run of that cycle.
  **The harness could not spend $3 to record a fact it paid fourteen workers to relearn**, because the
  only knowledge path it owns is a PR that changes code.
  **THE SIBLING DEFECT:** **P46(iii)** (recon cannot write a task-file correction) and **P47** (a repair
  actor's only honest provenance is a trailer that poisons the task) are the same missing organ from two
  more angles: **this harness can write code and nothing else.**
  THE GENERAL LESSON, and the reason this is P-numbered rather than three bug reports: **rule 13's "the
  proof is a merged PR" is exactly right about PROVENANCE and silent about EFFECT — and a harness that
  cannot see its own organs running will keep buying them twice.** **SUBSUMES P35** (same defect aimed
  at one consumer; what survives is: the credit backfill FIRES, verified by hand in #470 — 134
  evaluated, 70 `verdict.merged` corrections in-ledger — and the defect is that the retro's credit tally
  counts `step: "verdict"` lines only (retro.ts) and is structurally blind to those corrections
  (sweep.ts). Build it as P38(ii)'s first consumer).
  **★★ R33 — THE SERIES BROKE ITS OWN PERIOD, AND TWO SUCCESSIVE CHARACTERISATIONS ARE NOW DEAD.**
  `body-fetch-guards-on-http-not-size → user-overall` reads **PROPOSED@0.85 → DECLINED@0.8 →
  PROPOSED@0.8 → DECLINED@0.82 → PROPOSED@0.7 → PROPOSED@0.78**: **six judgements on ONE entry over a
  corpus frozen at 79 with `0 added` throughout, for ZERO writes** — and the alternation that held for
  five readings is gone. **R31 read this series as monotone drift and R32 falsified it; R32 read it as
  period-2 and R33 falsifies that.** The clause is rewritten: **the judge's verdict is NOISE on a frozen
  input, and its confidence number is noise too** (`bashrc-accident` went PROPOSED@0.75 →
  DECLINED@0.82 unchanged; the browser-egress anchor reads 0.85 after 0.88 after 0.88). **The
  meta-lesson is recorded rather than buried: two refuted characterisations in two cycles is itself the
  measurement** — a judge whose output can be fitted by drift, then by a period, then by neither, is
  not producing a signal, and no third pattern will be proposed for it. **★ AND THE PROCEDURAL MINER
  HAS NOW TRACKED THE LEDGER'S CREDITED SET EXACTLY FOR ELEVEN CYCLES** at every size from 2 to 8
  (this cycle: 2 runs, exactly the 2 credited merges) — **it is not sampling successes, it is
  re-printing the credit list**, which is a defect in the miner and not a scarcity of shapes.
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
  DEPENDENCY: SATISFIED — W1-T149/#349 (P29's other half) shipped 2026-07-20; this is now unblocked.
  **★ EVIDENCE LOG (R12–R15 prose FOLDED BY R19; git holds the per-cycle restatements).**
  **(1) THE CLASS IS PRICED AND ITS COUNT IS BURSTY, NOT TRENDING:** no-op-close PRs read 0 (R12) → 4
  (R13) → 0 (R14) and have stayed near zero since. R13's four — W1-T254's #1007/#1012/#1015/#1016,
  self-labelled *"second/fourth/fifth time"* — cost **$11.032, 6.6% of cycle spend, for zero product
  code**, and **all four were ledger-CREDITED as shipped tasks**, so the churn inflates the very
  success metric that should expose it. That is the durable price; the count is noise around it.
  **(2) THE ORGANS THAT MAKE THE CLOSE CHEAP EXIST AND DO NOT STOP THE DISPATCH:** W1-T272/#1044's
  sanctioned `ALREADY_SATISFIED` exit and #1040's breaker execute against this shape (R14's zero is
  partly them), but **the gate (i) is unbuilt, so the cure is behavioural rather than mechanical.**
  **(3) CLAUSE (iii)'s HOLE IS RE-CONFIRMED EVERY CYCLE ANYONE LOOKS:** shards reading
  `status: queued` after their PRs merged were flagged for W1-T279 (R13), T334/T335/T336 (R15) and six
  more in R16 — `deriveStatus` still ignores authored status, so "task retired" has no trusted input.
  **(4) THE RACE RUNS BOTH WAYS:** a fix-rung round dispatched against a branch whose PR had ALREADY
  merged (R15, W1-T326) — P39(i) refuses a TASK whose work merged, and the same staleness on the FIX
  rung is unguarded, filed as **P47(iii)** rather than a fourth clause here.
  **★ R19: 1 `already_satisfied` run of 46** — the sanctioned exit firing once, cheaply, which is this
  proposal's behavioural cure working and its mechanical one still absent.
- **★ P40 (measurement) — THE RETRO'S OWN INSTRUMENTS ARE HALF-DARK, AND THEY FEED THE MOUNT TABLE.**
  GROUND TRUTH AS FILED: **(a)** 58 of 147 runs recorded exactly 0 turns AND `task_class: unknown` — the
  same 58 — so the headline "8 turns/run" was a write-side blackout masquerading as a 10× efficiency
  gain; **(b)** W1-T167/#606 routes model + effort BY CLASS, so a run whose class never resolved rode a
  default mount and the routing discount this gather exists to measure was unmeasurable; **(c)** W1-T89's
  MAST map (#710) left 60 of 147 runs UNMAPPED, including `blocked`×47. PROPOSE: **(i)** find and close
  the write path that drops class and turns; **(ii)** the gather REFUSES to print an average over a
  column that is zero or near-zero for >10% of runs, printing COVERAGE instead — a silent 0 is worse
  than an absent number when the table re-bases a mount; **(iii)** add rows for the unmapped verdict
  classes to `plan/mast-mapping.yaml`, or record them as a deliberate `unmapped(reason)` class — never
  guessed, never silently absent. GOLDEN (fixture-only): a seeded ledger with a class-less run makes the
  gather print coverage rather than an average; every verdict class codes to a MAST category or an
  explicit `unmapped(reason)`.
  **★ EVIDENCE LOG (R12–R18 FOLDED BY R19, R19–R25 FOLDED BY R27; git holds the per-cycle
  restatements, which said the same thing with different numbers).**
  **Part (a) — CLOSED, original hypothesis FALSIFIED.** Class resolution has read 100% for fifteen
  cycles (52/52 this one) while turns went dark repeatedly: class and turns are NOT dropped by one write
  path.
  **Part (i) — RE-OPENED BY R17; the retention model is DEAD and part (ii)'s defect has replaced it.
  ★ THE COVERAGE SERIES IS NOT RESTATED HERE — it lives once, in §Calibration's *Reads*, where it is
  read every cycle** (R31 folds the duplicate: two copies of one series is the redundancy
  HARNESS-COMPRESSION forbids, and the copy that was here had gone four cycles stale). What survives is
  the ARGUMENT the series was quoted for: **a column that lights and darkens with nothing built is not
  an instrument, and its LEVEL was always noise.** R21's gate-side-credit hypothesis was REFUTED;
  R24/R25's measured boundaries supported a ~5–6 h retention story; **R26's 0-of-31 over 23.9 h broke
  it and R27 killed it — one run of 52 carrying every turn over a 20.5-hour window is what no retention
  bound produces, and R31 repeats the shape exactly (ONE run of 18 carrying all 107 turns).**
  **TASK D's honest scope is now: find out whether the column is retention-limited or simply not
  written for most runs, before dividing by anything.** The aggravating detail holds across every
  reading since: **the credited merges print `0t`** — whatever writes turns is not writing them for
  runs that ship.
  **Part (ii) — STRUCTURAL, UNPAID FOR AN ELEVENTH CYCLE, AND THE DIAGNOSIS HAS NOW BEEN WRONG TWICE IN
  OPPOSITE DIRECTIONS.** The same-total/different-denominator identity printed every cycle since R13
  (321/34-vs-131 · 1736/48-vs-37 · 5463/47-vs-84 · 2991/36-vs-120 · 1138/64-vs-22 · 2549/34-vs-24 ·
  173/46-vs-70 · 1147 = 31 × 37 · 888 over 11-of-27 labelled 100% · 1194 = 30 × 39.8 · 1164 ·
  475 = 54 × 8.796 · 533 = 41 × 13). **R26 declared the column a cumulative ACCUMULATOR on two exact
  identities** (`169 + 31 = 200`, `$924.563 + $171.844 = $1096.407`) and registered R26-2 to confirm it.
  **★ R27: THE COLUMN RESET (200 → 29 runs, $1096.407 → $80.341), SO IT IS NOT AN ACCUMULATOR EITHER —
  AND THE RE-CUT ROW DOES NOT CLOSE.** `turns this week` = **167 = 52 × 3.212**, the WINDOW's runs ×
  its avg turns, against a `runs` column of 29 and a `$` column holding 39% of the window's spend, with
  `share of weekly burn` printed **100.0%** over a denominator equal to its own numerator (the exact
  mirror of last cycle's `0.0%`). **The finding is no longer a mislabel with a one-line rename; it is a
  row assembled from three different queries**, and the fix is to name one population per row and cut
  all three columns on it. Registered as the INVARIANT **R27-2**. **R20-2's HIT stays RETIRED AS
  NOISE.** Its companion — the ratification counter, once `3 / 11 / 21%` byte-identical for eight
  readings — prints `0 / 0 / 0%, no ratify activity yet` for a **FIFTEENTH** cycle.
  **NEW SUB-CLAUSE, from R22: the denominator can be short as well as unstated.** See **TASK K**.
  **Part (iii) — UNBUILT, AND THE BEST READING EVER RECORDED, THREE CYCLES RUNNING.** Blind share:
  26% → 9% → 15% → 28% → 19% → 36% → 24% → 24% → 16% → 15% → 30% → 33% → 26% → 12% → 6% → **2%
  (`blocked`×1)**. **★ AND THE IMPROVEMENT IS A POPULATION CHANGE, NOT A MAPPING ONE, FOR THE THIRD
  CYCLE RUNNING** — this cycle's population is dominated by 23 guard-fired blocks that the map already
  codes as `infrastructure`, so a `+23` infrastructure swing beside a `−4` verification swing is one
  host storm arriving, not a mapping improvement. **The mapping is exactly as blind as it was, over a
  differently-shaped population.** **TASK E was FOLDED INTO TASK H by R25**; the surviving clause is the
  one about REFUSING TO GUESS — an underivable class renders `unmapped(<class>)` naming itself, never a
  silent remainder. That clause holds at any n, which is why it is the half worth keeping.
  **Part (iv) — THE SHIPS-UNWIRED SCAN'S POPULATION IS THE PLAN'S OWN PROSE.** The scan reads capability
  claims in NET STATE and checks whether the symbols they name are reached; it has now read **clean for
  EIGHT consecutive cycles**, including cycles that shipped organs dark **by their own PR's admission**
  (R16's four; R19's T495/#1835, whose commit subject literally says *shipped dark*; and **R27's three —
  `mainHealthFromRollup`, `readCiGateRollup`/`reaggregateCiGate`, `state-citation-check.mjs`**). R22
  closed the argument from the other side: T1008/#2163 and T1005/#2159 WIRED an organ this plan had
  listed as dark for three cycles, and because both merges went uncredited the scan had no reason to
  notice. **An instrument whose population is the set of things the plan has already boasted about
  cannot answer "what did we build that isn't running" — only "did we lie in NET STATE", a smaller
  question.** PROPOSE as part (iv): the population becomes **symbols introduced by the cycle's own
  merged diffs**; a merged export with no non-test caller is reported whether or not any section
  mentions it. GOLDEN: a seeded ledger whose telemetry counter has no events inside the retro window
  renders `no activity in window`, never a repeated prior total; and a seeded cycle merging one exported
  function with only test callers is REPORTED even when no NET STATE line names it, while the same
  function with a production call site is not.

**RETRO-1784556575522 (R9, prior cycle)** — 26 runs / 21 tasks / 13 credits (`blocked_ci`×8,
`blocked`×3, `incomplete`×1, `no_pr`×1, ONE rejected foreign trailer).

- **★ P33 (plan + golden) — A STALE FOREIGN TRAILER PERMANENTLY POISONS A TASK, AND
  SIBLING-CREDIT CANNOT FIX IT. ★★ R37: THE LIST GREW FOR THE FIRST TIME IN FIVE CYCLES — AND THE
  FIFTY-SIXTH PAIR WAS MINTED BY THIS FILE'S OWN LANE.** `(#3262, W1-T2387)` exists because R36's retro
  body QUOTED a trailer inside backticks and the scan reads literal text (**P61**, whose clause (iv)
  makes this the list's first machine-minted entry and proves the list needs a PRODUCER, not only a
  schema). P33's rank is unchanged: its remedy is still a list, and P61's is the mechanism.
  **★★ R36: THE LIST DID NOT GROW FOR A FOURTH CYCLE, AND ITS LIVE POPULATION IS NAMED AT LAST.** The 55 `(pr, task)` pairs stay permanently lost, but this cycle's
  hand-named lane merged **5 code PRs and NOT ONE carries a `Remudero-Task:` trailer on either surface**
  (#3253, #3246, #3230, #3229, #3226) — real work on `src/**` and `.github/**` that claims no task at
  all. **That is P33's un-entitled class read from the other side, and it is the largest such reading in
  this log.** P33 stays at the bottom of the credit cluster because its remedy is a LIST and the live
  defect needs a MECHANISM (**P60**). R23's original filing follows. GROUND TRUTH (this cycle, mechanical): run `W1-T64-1784542590738` was
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
  **THE FIRST SIXTEEN QUARANTINE PAIRS, none ever removed because nothing in this harness can remove
  one (R21's and R22's additions are listed with their cycles below):**
  W1-T64/#115 (`fix/w1t64-both-tests`, rejected 5×) · W1-T201/#993 (`plan/close-t201`) ·
  W1-T220/#641 · W1-T258/#766 · W1-T259/#768 · W1-T260/#773 · W1-T262/#777 (hand-authored `feat-*`) ·
  W1-T309/#1225 · W1-T314/#1293 (dispatched 6× against it) · W1-T320/#1274 · W1-T324/#1299 ·
  W1-T343/#1361 (`plan/dispatch-lanes-back-to-1`) · W1-T419/#1617 · **W1-T452/#1731** ·
  **W1-T464/#1804** · **W1-T450/#1763** (the three added by R19), plus the #80/W1-T54b residue
  clause (iii) retires. **THE FOUR THINGS THOSE CYCLES ESTABLISHED, kept because each is still
  load-bearing: (a)** the AUTHOR is now the harness itself — fix rung, splitter, and in #1361's case
  the plan-sync lane, *the same lane this retro's own PR rides*, which closes the argument for keying
  refusal on BRANCH OWNERSHIP alone rather than on any notion of a legitimate actor; **(b)** it is
  BILLED — W1-T314 ×6, W1-T343 ×4, W1-T369 ×4, W1-T201 ×3 — fusing P33's underivability to P39's
  repeated spend; **(c)** a list drained by hand cannot outpace a cause that refills it, so **P47(i)
  ships FIRST and P33 becomes clean-up of a bounded set**; **(d)** R14's "stable, no longer
  compounding" reading died in one cycle — **quiet is not fixed**, and P43(ii) applies to FALLS in
  defect counts exactly as to rises. GOLDEN: **all pairs derive cleanly and dispatch none of
  them, and a task poisoned mid-cycle HALTS on the first rejection rather than the sixth.**
  **★ R18/R19 PER-CYCLE PARAGRAPHS DELETED 2026-08-19 (R22 compression — they re-argued points (a)–(d)
  above with fresh ids, which is what this evidence log was folded to stop; the ids are preserved in
  the list, the retelling is gone). What they established and this entry keeps:** the growth is NOT
  monotone-slow (13 for one cycle, +3 the next, +1, +7), which is exactly why clause (ii)'s list must
  SHIP rather than be maintained by hand.
  **★ R21–R26 PER-CYCLE ADDITION PARAGRAPHS FOLDED BY R27 — the IDS and the ADMISSION RULES are the
  durable content; the retelling is DELETED.** **THE LIST STANDS AT FIFTY-TWO PAIRS**, built as: R21 +1
  (**T534/#1967** — the first pair where the resolver demonstrably HELD the task id while losing the
  merge) · R22 +7 (**T981/#2122 · T997/#2153 · T1005/#2159 · T1009/#2160 · T1006/#2162 · T1008/#2163 ·
  T234/#2177**) · R23 +13 (**#2199 · #2204 · #2211 · #2212 · #2214 · #2230 · #2232 · #2234 · #2237 ·
  #2240 · #2241**, plus straddlers **T71/#2182 · T499/#2181**) · R24 +8 (**T1047/#2311 · T1048/#2270 ·
  T1055/#2312 · T1056/#2319 · T1059/#2346 · T1063/#2309 · T1076/#2356 · T1085/#2357**) · R25 +2
  (**T1095/#2411 · T1095/#2483**) · R26 +5 (the ABSENT-RUN merges **#2526 · #2529 · #2532 · #2602 ·
  #2604**) · **R27 +0.**
  **THE THREE ADMISSION RULES THOSE CYCLES ESTABLISHED, each stated once and each still binding:**
  **(1) A PLAN-ONLY FILING PR IS NEVER A QUARANTINE PAIR** — its refusal is T1004/#2152 working as
  designed (declined 6 in R22, 3 in R24, 1 in R25). **(2) QUARANTINE IS FOR CREDIT LOST PERMANENTLY,
  NOT FOR CREDIT FILED IN THE WRONG WINDOW** — R23 admitted its two straddlers because nothing could
  recover them; **R25 reversed that once TASK L defined a mechanical recovery** and declined its three,
  R26 declined its seven, and R27 declines its four. R23's two pairs STAY on the list, because removing
  a recorded pair needs its own evidence and because they are the worked example L must reproduce.
  **(3) A PAIR THE PLAN HAS A NAMED MECHANISM TO RECOVER IS DECLINED** — R26 declined #2599 because
  TASK G reaches it, and **R27 declines all TEN of its printed-but-uncredited merges on the same rule**,
  which is why the largest lost-credit cycle in this file's history adds NOTHING to this list. A pair is
  admitted only when the loss has no named recovery: R26's five absent runs are the only class that has
  ever qualified in the affirmative. **★ R27 IS THEREFORE THE FIRST CYCLE SINCE R20 WITH A +0**, and
  that is a fact about the RECOVERY MECHANISMS being named, not about the harness having lost less —
  it lost 45% of its window's ships and expects TASK G and TASK L to get all of it back.
  **GOLDEN: all FIFTY-TWO derive cleanly; an ABSENT-RUN merge is admitted with `no_run_row` named as the
  loss reason and is never counted as a straddler or an orphan; a plan-only filing PR is NEVER a
  quarantine pair; a commit-only trailer is admitted with the surface that lost it named; a straddler is
  NOT admitted but is emitted on TASK L's line with its MERGE-time window recorded (DR-7); a
  printed-but-uncredited merge is NOT admitted but is emitted on TASK G's line; and a PR whose head ref
  IS the refused run's own branch is admitted with `own_pr` named as the loss reason, never as
  `foreign`.**

**RETRO-1784512714705 (R8, prior cycle)** — 195 runs / 28 gate-side merges / 0 credits
(`incomplete`×111, `no_pr`×42, `blocked_ci`×21, `pr_attribution_failed`×12, `blocked`×5,
`blocked_containment`×2, `blocked_isolation`×2).

  **★★ R33 — THE LIST GAINED ZERO PAIRS WHILE THE LABEL BEARING ITS NAME FIRED THIRTEEN TIMES, AND
  THAT ZERO IS EVIDENCE RATHER THAN SILENCE.** All 13 rejections were read out-of-band: **5 refuse a
  sibling run of the same task and 8 refuse a hand-opened branch carrying the CORRECT trailer over a
  `src/**` + `test/**` diff. NONE is an un-entitled trailer.** P33 is **not weakened** — its 55 pairs
  are still permanently lost and its diagnosis (the second reject is terminal-but-unrecognized) still
  stands — but **its live population this cycle is empty, and the population the message actually
  describes belongs to P57.** ★ NOTE WHAT THIS ENTRY'S OWN TEXT ALREADY ANTICIPATED: it defines its
  class on the ABSENCE of a sibling run (*"there is no sibling run whose branch matches
  `run-W1-T64-*`, so P29(i) will not credit it either"*). **This cycle five rejections have exactly
  that sibling and were refused anyway** — which is either P29(i)'s shipped sibling-credit failing to
  fire or firing invisibly, and the gather displays neither. **P33 holds its rank at the foot of the
  credit cluster and cedes the live rows to P57.**
- **★ CLOSED/RESOLVED TOMBSTONES — P29 · P30 · P31 · THE SPIN-LOOP STORM · R7's BLOCK — FOLDED TO ONE
  ENTRY BY R30, DURABLE CLAIMS ONLY (git holds the prose; the file's own doctrine says restating
  settled adjudications is the graveyard P8 warned about).** **P29 CLOSED 2026-08-07, both clauses
  shipped in #349** (sibling-run credit liveness via the `ownResult` stash in `src/lib/status.ts`; the
  per-task dispatch circuit breaker, ALSO credited to W1-T271/#1040 which knowingly added a second
  breaker because #349's streak resets on every `pr.opened`). Four durable claims survive: **(a) the
  ownership-assert is CORRECT and must not be loosened** — it stopped R5's false-credit inversion and
  still does, and R30's own union rescues depend on it; **(b) a fail-closed integrity guard needs a
  LIVENESS counterpart, or the system pays for its own correctness forever** (P39 is its dispatch-side
  half, still OPEN); **(c) THE STING, why W1-T390 and TASK G exist** — the same assert makes a
  `run-<taskId>-<slug>` branch permanently uncreditable, and the mirror image is a perfectly-formed
  `run-X-*` branch credited by nothing because its run fell outside the measured window (R19's
  #1797/#1825; **R30's #2942 is the same shape with the run absent entirely**); **(d) a run that
  opened no PR of its own is SUPPOSED to have a sibling's trailer rejected — the rejection count was
  never this mechanism's dial, and no retro may credit or debit #349 with one again.** The
  generalisation belongs to **P43**: *a proposal's headline number must be derivable FROM the mechanism
  it names.* **P30 RATIFIED 2026-07-20 → W1-T150, SHIPPED #358** (a level-triggered sweep rung
  appending `verdict.merged` for any owned-and-merged PR left uncredited). Two survivals: the
  ledger-vs-GitHub history each retro re-reads (R3 15/17 · R4 2/6 · R5 4/4 · R7 14/14 · R8 0/28 ·
  R9 13/21 · R10 8/23 · **R11 20/94**), and the question shipping did NOT close — **the metric still
  has not moved**, carried as P35 → folded into **P38**, P30's live descendant. **P31 RESOLVED,
  collapsed into P30**: R8's test (*19 of 21 `blocked_ci` merged anyway*) held through R19's 10-of-16
  and BROKE in R20 at 1 of 13 (8%), which is why it lives as a re-registered prediction rather than a
  settled collapse. **THE SPIN-LOOP STORM** (R8: `incomplete`×111 + `no_pr`×42 +
  `pr_attribution_failed`×12 of 195 runs) is kept as the ORIGIN of the fold-line doctrine — timestamps
  tracked the W1-T1/W1-T29 redispatch cadence, so it was ONE defect counted 165 times; mine only the
  residue that survives the fold, **and note R20's inversion: that rule guards against inflating a
  cause, and once it was the rule itself that had to be bounded rather than applied.** **P27 RESOLVED
  2026-07-18** — the `blocked_isolation`×5 volume was ONE cause (a Claude Code 2.1.214 auto-update
  adding a pkill wrapper the static allowlist predated; #184 named it, #185 absorbed it), the proposed
  host-hygiene fix was REFUTED by the name, and the guard fail-closed correctly on toolchain drift —
  **which is why guard volume is graded a HOST signal (P41), the grading R30's 8-row storm still
  uses.** **P23**→W1-T91/#719 · `blocked_review`→P15/W1-T65 (#122) · **P9**→W1-T75/#138, whose two
  lessons are kept because R8 turned on both: **a fix that repairs the mechanism but not the CORRUPT
  DATA IT ALREADY EMITTED is half a fix, and the plan is downstream of that data**; and
  **`correction.provenance` is a first-class ledger EVENT, not a note** — every consumer reads
  corrections, or the ledger's integrity is only as good as its least-aware reader.
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
  UNWINDOWED (P40(ii)) — **and as of R19 it prints `0 / 0 / 0%, no ratify activity yet`, the
  cumulative reading dropped rather than reconciled.** **P28** → RETIRED 2026-07-29 by that
  instrument (cumulative 4 approvals / 18
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
- **★ P17 — CLOSED 2026-08-20: SHIPPED, NOT ABANDONED. W1-T71/#2182** (`rmd receipt <pr>`, a
  deterministic ledger-truth run receipt; Sigstore + the WS-12 schema publish stay deferred to v2).
  It LEFT THE RANKING the same day, and the two durable lessons are why the tombstone is kept:
  **(a) P17 was ranked and re-ranked for five cycles on an external compliance premise nobody had
  checked** (W1-T392's defect: a task aimed at a world fact) — it never moved on the calendar again,
  and it shipped on the INTEROP merit alone. **(b) IT MERGED, AND THIS FILE WENT ON CALLING IT UNBUILT
  UNTIL AN AUTOMATED RUNG REFUSED** — a straddling run (R23's SECOND FINDING) meant no gather credited
  #2182, so the closure came from the plan-state truth rung's first BLOCKING firing rather than from
  any retro noticing. **A proposal can be closed by a machine reading the plan back to it, and this is
  the first one that was.**
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

1, 2, 4. **★ RESOLVED AND FOLDED (R20) — the ANTHROPIC_* precedence family.** `ANTHROPIC_API_KEY` in
   `~/.zshrc` takes precedence over the claude.ai login; stripping ANTHROPIC_* restores subscription
   OAuth; launchd + keychain OAuth PASSES and WS-1 shipped on it. **The durable claims, and all that
   is kept: env sanitization is a CONTROL-PLANE PRIMITIVE (§9), `billing_mode` is a decision the
   harness makes and never an accident it inherits** — shipped as `buildWorkerEnv()`, boot assertion
   W1-T12b/#62 — **and a daemon started from a DEV SHELL inherits the key**, which is why the dev
   path must be made as safe as the launchd path rather than trusted for being clean by accident.
   Residue: reboot-resilience is still unverified ⇒ WS-7 chaos drill (W1-T293/#1169 built the
   expiry-aware keychain half, failing CLOSED on a locked login keychain). Host-specific setup detail
   (line numbers, one operator's crontab, the interactive-session billing side finding) is DELETED —
   it described one host on one day.
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
5, 6, 7. **DELETED (2026-07-21 / R15) — setup-day residue: moving version numbers, one operator's
   paste-block rule, one host's workspace and deny-floor paths.** All enforced where they belong (CLI
   version pinned as config per WS-7, node via engines/.nvmrc, machine layout in the gitignored
   `local/` overlay and `~/.config/remudero/`). **A plan that restates a moving number or machine path
   teaches the reader to trust something that is wrong.** Ids retained so §14's citations stay stable.
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
    i, j. **FOLDED BY R27 — both records live in `FINDINGS.md` and §8A says retrieve, do not inject.**
       What is load-bearing and kept: claude-code#20946 did NOT reproduce on 2.1.209 (the deterministic
       floor held) and **the `dontAsk` fallback remains UNTESTED** (golden task); and the DECISION_REQUEST
       parser's near-miss on an inline `(RECOMMENDED)` marker is **the same defect class as W1-T62's false
       attribution — a parser taking the first plausible match instead of the anchored one, two instances,
       and P9's golden should cover the CLASS.**
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
12. **★ SELF-UPDATER RACE (run W1-T1C-1784038021919) — NARRATIVE FOLDED BY R27; `DIAGNOSIS.md` +
    `LEARNINGS.md` hold it (§8A: retrieve, do not inject).** A worker spawn landing in the background
    self-updater's npm unlink/relink window dies **ENOENT**, which the SDK misreports as *"native binary
    not found"*; fleet concurrency is a **thundering herd** that widens the window. Mitigations:
    `DISABLE_AUTOUPDATER=1` (confirm empirically — rule 7), ENOENT-class spawn retry, CLI version pinned
    as config (WS-7). **The first "guard caught it AFTER the burn" case, and the reason §4B Flight
    control exists.**
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

**Two on-disk surfaces, one merged view.** A task record lives on one of two surfaces, and this
section describes both because the gate enforces both. It is declared inline in the `tasks.yaml`
block above, OR it is its own shard at `plan/tasks.d/<id>-<kebab-slug>.yaml`, a file holding a
single-element YAML list in that same schema. A NEW task MUST be filed as its own shard.
NEVER append a new task to plan/tasks.yaml: one task per file is the convention every filing has
followed since PR #1060, because appending to one multi-thousand-line file makes every concurrent
filing collide at end-of-file (the conflict storm W1-T122 sharded the plan to prevent). The plan
gate enforces this at lint time and refuses a new task filed into the monolith. REWIRING an EXISTING
task edits wherever it already lives, monolith or shard — it does not move surfaces. `loadPlan`
reads both surfaces and merges them into one view; a task id declared on both surfaces, or on two
different shards, throws `duplicate task id`, so the two surfaces can never silently disagree
about which tasks exist.

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

## 4C. External scan (2026-09-02): OpenClaw 2.0 and Grok Bot — taken, refused, already held

Two agent products shipped their biggest releases in the same fortnight — OpenClaw 2.0 (v2026.8.1,
2026-08-31; its release coverage counts 933 contributors and 16,000 PRs) and xAI's Grok Bot (2026-08-11, reported to run on
Cursor's infrastructure) with Grok Build open-sourced under Apache-2.0 on
2026-08-07 — and the operator asked what to take. This block records what was read, what this
harness already holds, what it took as shards, and what it refused, so the next scan starts from
here rather than from a search box. [research: openclaw-2026.8.1, grok-bot-2026-08-11]

**SOURCES, BY REACHABILITY.** Primary and read: the OpenClaw v2026.8.1 release note and CHANGELOG
on GitHub; its docs `concepts/dreaming.md`, `concepts/memory-provenance.md`,
`concepts/standing-intents.md`, `concepts/usage-tracking.md`, `security/network-proxy.md`,
`security/THREAT-MODEL-ATLAS.md`, `automation/standing-orders.md`, `automation/tasks.md`; Grok
Build's open-source README (xai-org/grok-build). Mirrored, not primary: Grok Bot's announcement and
docs via the community reference RongleCat/awesome-grok-bot — x.ai and docs.x.ai were unreachable
from the filing session's egress proxy, as were InfoQ, InfoWorld and Composio. Every Grok Bot
mechanism cited below is therefore a mirror's quotation and is marked so in its shard.

**WHAT THIS HARNESS ALREADY HOLDS, AND THEY DO NOT.** Six contrasts, each a symbol here against a
published mechanism there:
- **Compaction doctrine (§8B) against "no compact / new session; full transcript is sent each
  turn"** — Grok Bot carries the whole thread every turn; the ledger here records every compaction
  and re-verifies proofs after one.
- **One worktree and one containment per worker against one cloud computer per account** — Grok
  Bot's "isolation is per user not per Bot": every bot on an account shares files, logins and
  browser sessions. `worktreeAdd` and the deny-floor give each run its own tree.
- **Executable acceptance proofs and ledger receipts against evidence as a user rule** — Grok
  Bot's guidance is "require evidence after every external action"; here `execWhitelistedProof`
  and `buildReceipt` are the evidence, and W1-T362 makes discrimination the bar.
- **Policy rows with `origin:` labels against OpenClaw's configuration history "with writer
  labels"** — parity, already shipped: every value in plan/policy.yaml names where it came from.
- **The retro's consolidation against Grounded Dreaming** — parity in shape (episodic to
  semantic, Architect-gated, nightly there and per twenty-five merges here); the delta is
  dreaming's taint gate, which this scan takes.
- **Verdict calibration, the adoption report and the verb census against a ten-scenario benchmark
  pack with no cadence** — OpenClaw's personal-agent benchmark runs on demand and compares nothing
  across versions; the measurement cadence here runs four times a day. Its consumer gap is
  W1-T2660, filed hours before this scan.

**TAKEN — NINE SHARDS, FILED 2026-09-02, EACH NAMING ITS SOURCE.**
- **W1-T2694 ratification pins** — OpenClaw's "grant an automation permission for an exact
  operation … require fresh approval when job/operation changes", as Law 5 with a signature: each
  gated rung's operation hash pinned in plan/ratifications.yaml, refusing to fire on drift. Inert
  while the file is absent.
- **W1-T2695 the authority table** — Grok Bot's Auto Review rules and OpenClaw's typed
  operation-scope summaries, DERIVED rather than hand-written: `rmd authority` from the policy
  schema and the gateway's write surface, with a ratchet over every new external write.
- **W1-T2696 the fleet can ask and cannot hear** — Grok Bot's return-on-approval loop closed with
  signed single-use option links in the escalation ping, consumed by the console's existing reply
  route; links, not a bot, per OpenClaw's channel-spoofing threat class.
- **W1-T2697 the operator teaches by doing** — Grok Bot's demonstrated routines inverted: an
  actor stamp on every ledger row, a miner over the operator's repeated verb sequences, proposals
  through the inbox. The board sweep run by hand all night is its origin.
- **W1-T2698 the credential-reach probe** — a probe inside the real spawn path listing what a
  worker can read, held as a shrink-only baseline per host class.
- **W1-T2699 secrets at the boundary** — OpenClaw's process-local sentinels injected only at the
  provider boundary: a sentinel bearer and loopback base URL for the model, a socket credential
  helper for git, a value-free ledger of destination and decision. Depends on the probe.
- **W1-T2700 the untrusted envelope** — OpenClaw's random-boundary external-content wrapping at
  every ingestion point, counted in the W1-T2297 prompt manifest and ratcheted; a floor whose wall
  is W1-T2699.
- **W1-T2701 learning provenance gates** — dreaming's taint gate at promotion and
  memory-provenance's forget-by-origin as a revert-recall transition to `contested`, never
  deletion.
- **W1-T2702 a bundle carries the routines** — Grok Bot templates ("identity, skills, and
  routines") applied to W1-T2580's bundle: ratified policy rows travel as proposals and import
  stages them for the receiving operator's inbox.

**REFUSED, WITH THE REASON.** Shared multi-user sessions with view/suggest/contribute roles: the
2026-08-18 ruling is one operator per VM, and the console inbox (W1-T2604) must learn to say no
before it learns a second voice. Desktop egress routing and Chrome-profile import: this harness
drives no browser. Screen-recorded skills: the ledger is the better recorder (W1-T2697). Widget
dashboards with per-widget action grants: the console is the surface and W1-T2660 is its next
panel; per-action grants are W1-T2695's table first. An xAI provider rung: the ruling defers
pay-as-you-go; a SuperGrok subscription lane would follow the Codex pattern (W1-T2572 to W1-T2577)
if the operator ever holds one, and no shard is filed on a plan nobody has. Standing intents
(event-conditioned reminders with fire budgets): noted; merge holds and typed escalation options
cover the first cases, and a shard waits for a measured need.

## 4D. Concept scan (2026-09-03): a compact dialect for the fleet — taken, refused, already held

The operator asked whether the acronym macros they use in interactive sessions (`tddr`, `grfp`)
could apply to this harness, and whether the daemon and its workers could share a compact
language that translates cleanly into the plain-language standard the fleet uses for people
(docs/operator-message-standard.md). This block records what was measured, what the fleet
already speaks, what was taken as shards, and what was refused, so the next scan starts here.
[research: compact-dialect-2026-09-03]

**WHAT THE FLEET ALREADY SPEAKS, MEASURED.** The daemon's language to a worker is one rendered
prompt of six named parts — doctrine, cited task claims, the recon relay, operator notes, up to
8,148 characters of glob-matched learnings, and the task body — plus a pointer at the shard on
disk and a typed output contract (`implementPromptParts`, `outputContractLines`). The worker's
language back is a marker grammar parsed by code, never by a model: `PR_URL:`, `DECISION_REQUEST`,
`QUESTION`, typed `## Follow-ups` lines, `ALREADY_SATISFIED:`, `SHIPS-UNWIRED:`, the
`Remudero-Task:` trailer. The proof dialect is the third machine language, executed by the
reviewer. Every human-readable file in the repository — CLAUDE.md, MASTER-PLAN.md, DECISIONS.md,
docs/ORIENTATION.md — reaches no dispatched worker: `spawnWorker` passes `settingSources: []`,
which the installed SDK documents as the option that must include `'project'` to load CLAUDE.md.
So the compact dialect the question asks for is the existing design; the scan found where it is
incomplete, and one place where the plan describes it wrongly.

**WHAT THE LITERATURE SAYS, AND HOW FAR IT REACHES.** Instruction-following falls with
instruction count and favours earlier instructions (IFScale, 2025; twenty models); Anthropic's
memory guidance targets under 200 lines per CLAUDE.md and says longer files reduce adherence —
this file's is 493. A rare acronym splits into two or three sub-tokens against about five for the
phrase it stands for, so shorthand saves nothing per use; the value is a long expansion behind a
short name, which Claude Code provides as a skill whose body is substituted verbatim. Agora
(2024) names the shape this harness has: natural language for rare exchanges, a negotiated
protocol document for the frequent one, routines that execute it. Model-invented shorthand
(Shogtongue, 2023; the FAIR negotiation bots, 2017) decoded unreliably and drifted, which is the
argument for every compact form here having a parser and a plain-language rendering owned by code.

**TAKEN — EIGHT SHARDS, FILED 2026-09-03, EACH NAMING ITS EVIDENCE.**
- **W1-T2759 the worker lane never paid the context tax** — corrects the claim, held in CLAUDE.md, the
  size ratchet's rationale and its test header, that the file is injected on every lane;
  registers the isolation option in plan/claims.yaml and pins the SDK's own sentence.
- **W1-T2760 the citation miner has no producer** — one typed report line, `LEARNINGS_USED:`, parsed
  against the injected set, so compression candidates rank by claimed use rather than injection.
- **W1-T2761 the headline index is built and no worker has seen it** — W1-T2508's switch-over, restated
  on the corrected premise: a policy-gated seventh prompt part in the stable prefix, the body a
  pointer away on disk, and a `rules` wipe-test factor so the first rule a worker sees is measured.
- **W1-T2762 the proof dialect is taught three times and tested once** — a dialect page rendered from the
  parser's own constants and drift-gated like docs/cli-reference.md, with the CLAUDE.md section's
  grammar statements checked against the live constants.
- **W1-T2763 the operator's shorthand is guessed by the model** — one tracked macro table, a generated
  user-invocable-only skill per row, drift-gated; seeded with `tddr` and `grfp`.
- **W1-T2764 the ledger's step names are the one vocabulary without a decoder** — a registry naming each
  step's meaning, writer and the outcomes that writer can return, a shrink-only ratchet over
  unregistered literals, a generated page; no literal renamed, per the 2026-08-15 ruling.
- **W1-T2765 the prompt manifest is written on every run and read by nothing** — a digest section
  summarising bytes per prompt part over its window and naming the part that grew.
- **W1-T2766 the fleet learns facts and never packages a procedure** — the skill-workshop lane from the
  2026-09-02 scan, amended to measure the loading path under isolation mode rather than assume it.

**REFUSED, WITH THE REASON.** A token counter: budgets here are bytes and characters by design
(`prompt.manifest`, both ratchets) and W1-T941 already derived the injection cap from measured
drop pressure. Perplexity-style compression of the injected learnings (LLMLingua): learnings are
instructions, not context, and citation evidence is the better selector once it measures use.
Model-invented shorthand between daemon and worker: every compact form here has a code parser or
it is prose, and a form only a model can decode is the Shogtongue failure. Shorthand as console
commands: the reply route's doctrine is "A REPLY IS AN INPUT, NEVER A COMMAND" (W1-T2496).
Renaming step names or verbs to friendlier words: query keys, ruled untouchable on 2026-08-15.
Chain-of-Draft style output limits on workers: output verbosity is not a measured problem here.
KV-cache sharing between lanes (DroidSpeak): needs shared serving the SDK boundary does not offer.
A token-oriented serialization (TOON) of the ledger rows the retro reads: noted, and waiting on a
measured input-token figure for the retro's gather, which the run ledger's `input_tokens` column
can answer — name the query, not a number.

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
- **SIZING (Standing rule 19):** count acceptance criteria; count distinct subsystems implied by `files:` / the
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
  cross-project knowledge, §Self-improvement). **SUPERSEDED AS THE COMMERCIAL SHAPE** by
  DECISIONS.md's 2026-08-18 bring-your-own-subscription ruling — per-customer VMs carrying the
  customer's own credential, not hosted multi-operator convenience. The list above is retained as the
  record of what it replaced, per standing rule 21. Commitment for community trust: **nothing open ever
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
cli|ui|issue, status: new|grilling|proposed|accepted|rejected|answered, proposal_pr, reply_to,
answered_by}`. Captured async by `rmd feedback` (W1-T40); never lost in a chat scrollback.

**`answered` IS THE SIXTH STATUS, AND IT IS THE ONLY EXIT FROM `grilling` THAT IS NOT A PROPOSAL**
(W1-T2278, PR #2894; ratified here from feedback#fb-1785974009303-125530). A grill parks an entry at
`grilling`; the operator's reply — `POST /v1/feedback` carrying `replyTo` — is captured as its own entry
carrying `reply_to: <question id>`, and the SAME handler advances the question to `answered` with
`answered_by: <reply id>`. The thread is therefore walkable from both ends, and NEEDS ME (which renders
only `grilling`/`proposed`) drops the question the moment it is answered, so the operator can tell an
answered question from an unanswered one. **`answered` is NOT `accepted`:** `accepted` means a proposal
PR merged — a decision about filed WORK — whereas `answered` means the operator supplied the information
asked of him, which is why reusing `accepted` here was refused and a new member added instead. The
transition is caused ONLY by an operator's own reply landing on that route — never a timer, never a
scheduler, never a lane acting on his behalf (W1-T2244 pins (ix)/(x)) — and `answered` is CLOSED for the
exchange: a second `replyTo` at the same entry is refused by the same not-parked-at-`grilling` check.

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

**Two providers, one router (W1-T2572-77, 2026-09-01).** Codex/OpenAI arriving as a second worker
provider breaks three assumptions this section still encodes. (a) `tiers:` is a Claude-only ladder and
`enforceTierInvariant` compares `m.tiers[mount.model]` against it, so a second vendor's models are not
merely unranked but UNCOMPARABLE — the Tier Invariant, a safety rule, cannot be evaluated across
providers at all. (b) The crossing itself is `codexTierForRequestedModel`, a substring match on the
Claude model name (`haiku`->economy, `opus`->frontier, else balanced) living in CODE, which contradicts
mounts.yaml's own "routing is a DATA edit" rule and DISCARDS `effort` entirely, so `sonnet/high` and
`sonnet/medium` are the same Codex request. (c) `run.start` logs the requested ALIAS and nothing logs
what actually served, which is survivable while one provider resolves aliases predictably and is not
once `selectCodexModel` picks from an account-visible list. The remedy is a provider-neutral CAPABILITY
ladder expressed as data, with each vendor's models mapping into it — the Tier Invariant then compares
capability RANK and stays enforceable, and a new model is a config edit.

**The flywheel's missing leg is VARIATION, not telemetry.** `run.start` already carries the full routing
key and W1-T2560's census already reports outcome-split cost per SETTLED task. But a static table means
every run of a (type x risk x class) cell rode the SAME mount, so no corpus however large supports a
counterfactual. Provider selection supplies the variation for free: `selectWorkerProvider` chooses on
WINDOW STATE, not on the task, so assignment is plausibly exogenous to difficulty — a natural experiment
WITHIN a cell. Across cells it is not (high risk rides higher mounts by policy), so a per-model aggregate
that does not match on (type, risk, class) measures difficulty and reports it as model. Recommendations
are PROPOSALS through the existing `classifyProposal`/`rmd approve` path, never live mutations, and
refuse below a declared minimum sample. NOTE the standing dependency: §9's pre-merge proof is the golden
suite, and the replay suite still has no `HarnessRunner` wired, so a routing proposal's evidence is
observational and the ratifying human is the gate until that changes.

**Fleet-scale learning is PARTIAL POOLING, and both naive forms are harmful** — a global average lets the
busiest repo govern every other, per-repo isolation throws the fleet's knowledge away at every
onboarding. A cell's estimate for a repo is the pooled estimate shrunk toward that repo's own evidence in
proportion to how much of it exists: at n=0 it inherits the fleet prior (cheap onboarding), and it
migrates to local behaviour as local runs accumulate. An operator prior declared in `principles.yaml`
DOMINATES a learned one rather than averaging with it.

**And the objective is WINDOW SHARE, not the notional dollar.** Optimising `cost_usd` optimises a number
this section already calls notional; the resource that runs out is the window, and with two subscriptions
there are two independent ones. #3486 is the measured case: lanes were cut 3 -> 2 on `daemon.headroom`
evidence (a five-hour window consumed in ~83 minutes) while no cost-shaped signal argued anything.
Dollars stay what §9 says they are — the runaway tripwire, and the right objective under
`billing_mode == api`, where they are real and windows are not the constraint.

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
  SUCCESS. Its cost is measured and small (~18–24s warm/diff-scoped since W1-T108), so cost is NOT the
  open question. **★ FOUR CYCLES OF PER-CYCLE RESTATEMENT FOLDED TO ONE CLAIM BY R23 (git holds the
  prose).** D-10 demands *mutants killed vs survived over the gate's LIFETIME, and whether it has EVER
  caught a real escape*. W1-T393/#1521 shipped the ratchet and the gather carries the lifetime line; it
  has read **`N=0 verdicts, NO POSITIVE CONTROL`** — in those words, never as "zero escapes" — for
  **SIX consecutive cycles**, because the `mutation.ratchet_verdict` emission call site inside
  `scripts/mutation-ratchet.mjs`/`ci.yml` was never wired. **The cleanest instance in this file of rule
  14's "the call site is a deliverable": the measurement is one emission away, and no judgement is
  possible until someone ships it — D-10's blocker is a task, not an opinion.** Disposition stands:
  the gate justifies itself with data or gets its scope cut into the nightly full-scope run (W1-T133),
  with the PR gate staying the fast diff-only check.

- **D-11 Instance topology — CELLS: one rmd instance per codebase; nothing mutable shared between
  cells — RATIFIED 2026-09-02 by the operator.** Promoted from the Banked queue's
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
  the operator's WS-2 deferral judgment). Per the P48 norm this WAS a recommendation until
  2026-09-02, when the operator ratified it in session; the arc is now dispatchable and W1-T433's
  pilot is no longer gated on this entry. **RATIFICATION RECORD:** ratified AS WRITTEN — cells,
  accounts at the relay only, the instance dialing OUT, the relay a transparent proxy over the
  §7A console contract — with NO amendment to the recommendation's text; everything above this
  record is preserved verbatim as the reasoning that was ratified, never rewritten after the
  fact. STILL OPEN, and NOT decided by this ratification: D-8's monetization shape, per-account
  resource accounting (which is not merely a pricing question — it is what stops one account's
  drain consuming another's ceiling), and which identity provider W1-T430's seam is pointed at.


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
26. **A `state/` OVERRIDE MAY ONLY MOVE A VALUE TOWARD *GREATER* EXPOSURE — THE COMMITTED ROW IS THE
   FLOOR.** OPERATOR RULING, recorded verbatim in substance from feedback `fb-1785950676514-c5cdcc`
   (2026-08-05, cli): *"A LANES OVERRIDE MUST NEVER LOWER … the committed row is the floor and an
   override may only RAISE it."* Recorded here, not built: no lanes override exists and none is filed
   (see below for why), so this is a CONDITION ON ONE IF IT IS EVER BUILT — and, per the ruling's own
   falsifier, on whatever generalisation of the override store lands first.
   THE ASYMMETRY THAT MAKES IT A RULE: a wiped `state/` silently reverts every override to its
   committed default, and that fails safe in ONE DIRECTION ONLY. If the committed row is the
   lower-exposure end, a wipe costs concurrency/spend the operator wanted anyway; if an override is
   the thing holding the value DOWN, the wipe silently restores the HIGHER exposure with no signal at
   all. So: to REDUCE exposure, edit the committed row (a reviewed plan-data PR) — a reduction must
   be durable, never state-resident. Stated by EXPOSURE, not by sign, because the safe direction is a
   property of the row; for `sweep.dispatchLanes` and `sweep.dailyCostCeilingUsd` exposure rises with
   the number, so for both of them "toward greater exposure" reads literally as "may only RAISE".
   THE RULING'S OWN NUMBER IS ALREADY STALE, AND THE STALENESS STRENGTHENS IT. At capture the
   committed `dispatchLanes` row was `value: 1` (min 1, max 4) and the author noted a wipe would
   therefore revert *down* — safe. Today (`plan/policy.yaml`) it is **`value: 3`**, min 1, max 4,
   beside a net-new `reviewLanes: 3`, and W1-T1049's own measurement says the host fits **about four
   concurrent workers of any kind** against a configured worst case of six. The plausible near-term
   operator move is therefore to run FEWER lanes — i.e. exactly the lowering override this rule
   forbids. That is not an accident of the rule; it is the rule working.
   WHAT TO DO INSTEAD, because the rule must leave the emergency reachable: `rmd pause` already halts
   new dispatch without a PR, a restart or a deploy — `runDaemon` checks it in the tick body and
   RE-CHECKS it immediately before admission (W1-T1065), in-flight work is never interrupted, and the
   marker survives the deploy's `pull --ff-only`. Then move the committed row and restart. The
   measurement the ruling carries: restart is **1.2s median** (148 kickstart-to-boot pairs, control
   794 boots) against a PR-to-merge median of **12.2m** / p90 **64.9m** — so an override saves the
   PR, not the restart, and its only unique saving is idle minutes during a flip-back, in a scenario
   with zero observed instances (`dispatch.concurrent_set` 0 rows, `drain.pause`/`daemon.paused` 0
   rows, control `run.start` 682). A LIVE RELOADER for lane width is separately refused: it would buy
   1.2 seconds against `src/lib/daemon.ts`'s explicit W1-T343 design — *"resolved ONCE, for this
   process's whole lifetime"* — and reintroduce the mid-run reconfiguration question that frozen
   design exists to avoid.
   FOR WHOEVER GENERALISES THE STORE — IT IS NOT PARAMETERISED, verified at this sha:
   `dailyCostCeilingOverridePath` returns the literal `state/DAILY_COST_CEILING_OVERRIDE`; both the
   writer and `resolveDailyCostCeiling` read `policy.bounds["sweep.dailyCostCeilingUsd"]` as a
   LITERAL key; and `validatePolicy` populates `bounds` for that ONE field only (its own comment says
   so). Generalising therefore means row key **plus** filename **plus** a `bounds` entry for the new
   row, **plus** row-specific semantics — for lanes: integers, not floats, and the floor-at-1-never-0
   that `laneDispatchBudget` and `runDaemon` both already apply (`Math.max(1, opts.laneCount ?? 1)`),
   so a bad override can never mean "dispatch nothing" silently. Roughly 4–6 files.
   OPEN, AND DELIBERATELY NOT DECIDED BY THIS RECORD: the SHIPPED ceiling store is the live instance
   of the same asymmetry. W1-T364/#1417 gave the console an arm-then-confirm write over
   `writeDailyCostCeilingOverride`, which validates BOUNDS ONLY — so a *lowering* ceiling override is
   writable today and its silent loss raises the ceiling by up to the committed $500. Refusing such a
   write in code would collide with the operator's other standing ruling (`fb-1785858048118-50fab8`:
   runtime config belongs in a store with a dashboard, not behind a PR), so this entry names the gap
   rather than closing it; the SIGNAL half is already queued as W1-T333 (render overridden-vs-default
   provenance, so a vanished override is visible). The next filing that touches the store owns the
   question. [operator feedback fb-1785950676514-c5cdcc; W1-T332/#1312, W1-T343/#1363, W1-T344,
   W1-T364/#1417, W1-T1049; recorded 2026-08-23]

27. **AUTOMATIC FILING IS PERMITTED — THE FLEET MAY FILE, BUILD, TEST AND MERGE ITS OWN WORK, and
   escalates to a human only when a judge decides one is genuinely needed.** [operator ruling,
   2026-08-29; W1-T2456]

   THIS RULE EXISTS BECAUSE ITS ABSENCE WAS READ AS A PROHIBITION. An unwritten doctrine — that only
   the Architect may author a task —
   was cited in this file as **"standing rule 15" at five places** and in
   `src/lib/retro.ts` as **"standing rule 16"**, and §12 carries no such rule under either number:
   15 is the acceptance-criteria goalpost rule and 16 is the mis-specified-task correction rule.

   MEASURED 2026-08-29: a scan of the whole of §12 for the doctrine's own vocabulary
   (`auto-fil|autofil|never file|architect authors`) returns **0**, with a firing control
   (`Architect` appears 5 times in the same span). A deleted prohibition leaves SILENCE, and that is what let
   the inferred doctrine take root — so the permission is stated here affirmatively rather than
   merely removed, and `test/rule-citations-match-their-rule.test.ts` now fails when a citation
   claims a doctrine its cited rule does not carry.

   WHAT DOES NOT CHANGE: **rule 15 itself stands.** `criterionFieldTampered` still refuses a worker
   editing the acceptance criteria its own judge reads, and under an LLM-as-judge design that is MORE
   load-bearing, not less. `rule15FilingViolation` is likewise untouched — it is a task-record SHAPE
   check and never had anything to do with who may file.

28. **A VERDICT CLASS IS NOT A FAILURE CLASS UNTIL YOU CHECK WHICH OF ITS MEMBERS MERGED.** A
   terminal run verdict records what the orchestrator observed at that instant; it is not material
   proof that the pull request ultimately failed. Any failure census or taxonomy must join each
   member to live merge state before classifying it, and an unreadable member remains unconfirmed
   rather than being counted as a failure. [RETRO-1788374498685; DR-28; P47; 2026-09-02]

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

**Craig's standing side-items (outside Remudero):** (1) the `~/.zshrc` API-key billing leak —
every interactive `claude` session on that host bills API rates instead of the Max subscription;
the fix is to scope the key to the LaunchAgent plists and crontab rather than exporting it from
`.zshrc`, and NOT to delete it (other local tools need it). *(FIELD FINDING 1/2/4 folded this detail
out of the findings list in R20; it is kept here because it is an ACTION, not ground truth.)*
(2) One-time employer IP/moonlighting policy glance; the public tree is already
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
- Cross-agent support (Codex exec) — opt-in connector implemented at the worker-spawn choke point;
  Claude remains the default, and dual-provider dispatch requires readable reserve headroom from
  the selected subscription.
- Tournament dispatch (two approaches, reviewer picks) for high-risk tasks — expensive, park until
  verdict calibration proves the reviewer.
- P19 rung 2 — Tree-sitter symbol-touch locks; unbanks only when a rung-1 file-overlap ESCAPE is
  observed in the ledger (W1-T172's `dispatch.concurrent_set` line is the trigger).
- board-review:escalation:#3039 (a board-review finding whose referent is an ephemeral PR; the instance was refused, the class it evidences was filed) — RATIFIED 2026-08-27 -> W1-T2451.
- board-review:escalation:#3043 (the escalation on #3043, grounded: 'fix strikes exhausted (3/2)' is a real overspend — the sweep gates cumulatively but dispatches a fresh full cap — and the candidate that reported it named neither the ask nor the issue it already held) — RATIFIED 2026-08-27 -> W1-T2452/W1-T2453.
- board-review:escalation:#3227 (the rung's per-PR findings outlive their referents: anchor-free proposals are never drift-checked, never re-drafted and never pruned, and the recursion bound that would keep the rung off its own children is unwired) — RATIFIED 2026-08-28 -> W1-T2464/W1-T2465.
- board-review:escalation:#3205 ("board-review: #3205 carries 1 unhandled escalation(s)") — RATIFIED 2026-08-28 -> W1-T2466/W1-T2467 — ratified at the CLASS the instance exposed, not the instance: the finding names no ask though the projection already carries its url/title/opened-at and run-task.ts:16819 discards all four, and `evidenceAnchors: []` (board-review.ts:383, the only one of four registry producers to mint it) leaves every board-state proposal with a vacuous drift clause, a permanently un-stale draft, and no expiry — measured 2026-08-28 at 16 board-review proposals drafted, 0 ratified, 0 readers in src/. Handling #3205 itself stays an operator action and is deliberately NOT filed (W1-T20d, class-not-instance); whether the escalation arm should mint proposals at all is recorded as an open route decision and left to the operator.
- board-review:escalation:#3194 (per-item board-review findings are minted with an empty anchor set, so the inbox drift predicate is structurally inert and 12 proposals have accumulated — one provably against a merged PR) — RATIFIED 2026-08-28 -> W1-T2470.
- P62 (the overlap advisory cannot report that it did not look — a rate-limited open-PR read renders as "no overlap", while the same command names that identical outage and refuses `--reserve` on it) — RATIFIED 2026-08-30 -> NEW-1.
- followup:DAEMON-1788016810368:2026-08-29T15:26:29.026Z:1 (a fix worker re-litigated a file its own branch already carried — the DECLARED SCOPE block threatens a whole-PR-unreviewable consequence neither guard imposes and never names the inherited paths the pre-strike gate already exempts, while the only documented `files:` correction procedure covers merged shards alone and states a Rule-21 fact W1-T2254 falsified) — RATIFIED 2026-08-30 -> NEW-1/NEW-2.
- followup:DAEMON-1788016810368:2026-08-29T15:50:53.273Z:0 (concurrent fix rounds for one task share the PR's own head-ref branch BY DESIGN — creditability pins it — and the rung's unconditional `checkout -B` force-resets that shared local ref, so a sibling round's commit is discarded and the resulting push lands zero refs and reports success; per-attempt uniqueness belongs to the worktree, which already has it, and the remedy is exclusion plus a push post-condition) — RATIFIED 2026-08-30 -> NEW-1/NEW-2.
- W1-T2457-1788020906446 (W1-T2457's remedy pricing froze a CLAUDE.md cap that has since moved 67536 -> 44000, inverting its own remedy ranking; W1-T2282 is stale the same way, and nothing stops the next frozen figure) — RATIFIED 2026-09-01 -> NEW-1/NEW-2.
- followup:W1-T2457-1788020906446:2026-08-29T16:31:22.354Z:1 (recon follow-up "W1-T2457 is ready to implement — hand off to the implement worker"; the dispatch it asked for was performed by the ordinary drain and its referent MERGED as #3272 before any ratification, so the entry itself is CONSUMED and not buildable — ratified instead as the routing arm that should have declined it, W1-T2482's still-queued twin proving the sink-side retirement in W1-T2563 does not cover it) — RATIFIED 2026-09-01 -> NEW-1.
- P65 (CLAUDE.md's decoding row documents `P-N` for retro proposals while all 736 live citations and all four live parsers use `P48`, so the documented form is invisible to both the next-unused mint scan and the uniqueness gate — a latent re-opening of the #125/#118 collision class; from the W1-T2457 follow-up harvest, run W1-T2457-1788020906446) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2457-1788020906446:2026-08-29T16:47:03.560Z:1 (three unquoted `DR-N` citations survive the namespace rename in plan/tasks.d/, and the guard enforcing that rename reads only MASTER-PLAN.md and CLAUDE.md) — RATIFIED 2026-09-01 -> NEW-1/NEW-2.
- followup:W1-T2458-1788035402626:2026-08-29T20:33:15.794Z:0 (the proposal's literal ask — implement W1-T2458 — is ALREADY SHIPPED as #3275 and no task is filed for it; what is ratified is the class the proposal itself evidences: `routeFollowupsToRegistry` admits a recon run's restatement of its OWN declaring task, 23 of 317 live registry proposals, 21 verified, 2 unverified, and W1-T2563's merged-signal retirement cannot reach the ones whose task is still queued) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2458-1788035402626:2026-08-29T20:33:15.794Z:1 (repos/remudero main ref — research half ALREADY DECIDED by MASTER-PLAN §3418's standing note: genuinely stale, ~100 commits/cycle, NOT pinned/unused; no re-research task filed, only the unowned consequence that the canonical checkout is every worktree's node_modules source) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2458-1788035402626:2026-08-29T20:43:52.284Z:0 (plan) — RATIFIED 2026-09-01 -> NEW-1.
- followup:PR-3278:base-caused-stand-down-has-no-release (a base fix merging at its source releases nothing: the sweep detects a base-caused red on evidence it already holds, stands down with no state and no strike, and nothing asks whether the cause has since landed on main — while the built redrive remedy stays reachable only through three hand-authored fix-class rows) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2460-1788054755234:2026-08-30T01:56:15.532Z:1 (research: why a fresh worktree's base `e9454618` sat 1553 commits behind `main`, and whether stale provisioning is systemic — ratified as a SENSOR plus a coverage census rather than a second archaeology dig, because the record does not say and a third instance would be equally blind) — RATIFIED 2026-09-01 -> NEW-1/NEW-2.
- followup:W1-T2462-1788054829616 (result-shape parity between `resolvePlanCriteriaForReview` and `resolvePlanCriteriaAtHead` — confirmed retrospectively, the swap having merged as #3285: parity holds for the four fields its doc enumerates and fails for `openTaskIds` and the read-identity assertion inside `source`) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2462-1788054829616 (trailer tie-break divergence — `TASK_TRAILER_RE.exec` first-wins vs `reviewTaskIdFromBody` last-wins) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2460-1788054755234 (worktree provisioning staleness — why a run's base sat 1553 commits behind `origin/main` while W1-T405's guard was live) — RATIFIED 2026-09-01 -> NEW-1/NEW-2.
- followup:W1-T2461-1788065869447:2026-08-30T05:00:54.119Z:0 (the branch/HEAD mismatch is BENIGN — a worktree is cut at origin/main and records that base, so before its first commit HEAD is main's tip and belongs to whatever merged last, here W1-T2463; the durable finding is that `readWorktreeBase` has zero production callers, so the record that answers the question is written, deleted and never read, and one of the three removal paths widows it) — RATIFIED 2026-09-01 -> NEW-1/NEW-2.
- followup:W1-T2463-1788065942887 (research: is `w1t1060-instrument-declare` abandoned residue worth pruning, or a stuck-task flag?) — RATIFIED 2026-09-01 -> NEW-1. ANSWERED IN THE FILING: superseded residue, NOT a stuck task — W1-T1060's three declared artifacts are all on main, so the work landed by another route (network unavailable at drafting, so `prState` and the 841-behind figure are UNVERIFIED and stated as such). Pruning as an ACT stays W1-T2445's (no deletion path exists anywhere in `src/`); adjudicating the rest of the residue stays W1-T2247's; the OPEN half of the same naming gap stays W1-T2429's. NEW-1 is the class fix only: give the reaper's residue a task-linkage rung, splitting `no_pr_ever` by the named task's state while changing no disposition. NO P-NUMBER MINTED — the next unused P is not derivable from this read-only context, and W1-T74 exists because a retro once guessed one and collided.
- followup:W1-T2463-1788065942887:2026-08-30T05:01:42.981Z:1 (research — does the stale local main ref, 1556 behind at measurement, confuse tooling or scripts that assume main is current, e.g. diff-against-main checks in CI gates) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2463-1788065942887:2026-08-30T05:01:42.981Z:2 (the errand is answered and is NOT ratified — W1-T2463's spec is plan/tasks.d/W1-T2463-*.yaml in the worker's own tree, never `.claude/` and never #3287 — but the mechanism whose silent failure makes that class of errand possible IS: `taskRecordContextLine` renders the empty string on an unresolvable record, and that bullet is the only transport carrying a task's design, rationale and acceptance criteria to a worker, while the output contract still demands every criterion be substantiated) — RATIFIED 2026-09-01 -> NEW-1.
- followup:W1-T2474 (recon is never told which task it is reconning — renderReconPrompt takes no task id, title or record path, so "confirmed repo state, not task content" is the prompt's specified output) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2474-1788101371246:2026-08-30T14:52:51.287Z:1 (the untracked home dotfiles are expected worker-home scaffolding — 15 `worker-home-<runId>.<uuid>` siblings of the checkout, none inside a work tree — but the placement is a property of a settable config field rather than of the code, and the two editor directories the report names are ignored nowhere) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2474-1788101371246:2026-08-30T15:18:58.002Z:0 (the retirement backfill W1-T2474 scoped out; re-grounded at this sha — the mechanism shipped, PR #3305 already marked 20 of 33, and the 13-record residue is wedged behind W1-T2481's vacuous declared-scope arm rather than unauthored, so the step splits into a WARN-only census the machine may run and a per-record operator ruling it may not) — RATIFIED 2026-08-31 -> NEW-1/NEW-2.
- followup:W1-T2474-1788101371246:2026-08-30T15:18:58.002Z:1 (`DispatchFilterReason` consumers are non-exhaustive — a `"retired"` task reads as `unmet-deps`) — RATIFIED 2026-08-31 -> NEW-1/NEW-2.
- followup:W1-T2477-1788105355034:2026-08-30T15:58:59.564Z:0 (sync `plan/tasks.d/W1-T2473-*.yaml` `status:` queued -> shipped) — RATIFIED-AS-REFRAMED 2026-08-31: the literal edit is REFUSED at source — `shipped` is not a `TASK_STATUSES` member so `loadPlan` would `PlanError` the whole merged plan, the field is decorative by the header's binding rule, and neither stated harm is reachable because dispatch eligibility and dependency satisfaction are GitHub-derived (W1-T367's recorded refutation, now recurring a fourth time); what survives is the producer-side refusal and the schema's own message -> NEW-1/NEW-2.
- followup:W1-T2477-1788105355034:2026-08-30T15:58:59.564Z:1 (research — monolith-vs-shard drift on W1-T2473/W1-T2477 per the §2 plan-format contract; drift CLEAN, contract does not cover the sharded surface) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2477-1788105355034:2026-08-30T16:08:17.502Z:0 (wire `buildMeasurementCadenceDaemonHooks` to bind real predicates into `MeasurementCadenceReportOpts.proofDebt` and make the outcome recoverable from `measurement_cadence.ran`) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2477-1788105355034:2026-08-30T16:08:17.502Z:2 (research: `plan/tasks.yaml` monolith vs `plan/tasks.d/` shards, drift on W1-T2473/W1-T2477 — resolved NEGATIVE for both named ids; the standing "harvest (a)" question, asked a FOURTEENTH cycle, gets a measured answer instead of a fifteenth ask) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2478-1788108376050 (asked to implement W1-T2478; verified already implemented at head — ci-parity.ts:856-990, package.json:61-64, test/fast-gate-admits-the-census-class.test.ts — so ratified at the one stated-but-unshipped surface instead: the ratified measurement placed six census suites in the population and five under the bound, four shipped, and neither the fifth nor the over-bound sixth is named in any artifact, leaving a refusal claimed in prose and evidenced nowhere) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2478-1788108376050:2026-08-30T16:49:17.177Z:1 (follow-up harvest [research] from W1-T2478 — the census population is a count with no names: four suites wired against a rationale counting six and measuring five under the bound, the fifth named nowhere, and eighteen `ls-files` walkers observable in test/) — RATIFIED 2026-08-31 -> NEW-1.
- followup:DAEMON-1788107419932:2026-08-30T16:56:33.630Z:1 (follow-up harvest [task]: sync a tasks.d shard's `status:` field to `shipped` — REFUSED AS WRITTEN: `shipped` is not in TASK_STATUSES and loadPlan already fail-closes on it; the stated re-dispatch mechanism is false (dispatch reads GitHub-derived merge state, and 248 of 359 shards carry a stale `status:` today); and the class is owned by P46(i)/P56/W1-T367/W1-T410. RE-SCOPED to the unowned producer-side residue — the follow-up router mints proposals with no grounding against the decided record, of which this proposal is the fourth recorded instance) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2478 (the `preflight` help re-types a table the code owns — 7 of FAST_GATE_STEPS's 13 scripts, the mechanism rule W1-T2478 replaced with a measured bound, and an accepted `--coverage` flag absent from the signature; docs/cli-reference.md is generated from that same stale registry entry, so cli-reference:check asserts doc==registry and never registry==code) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2478-1788108376050:2026-08-30T17:29:14.147Z:1 (the census denominator was never written down — W1-T2478's rationale counted six census suites and five under the two-second bound while head admits four; the fifth candidate `test/enforcement-data-carveout.test.ts` straddles the bound at ~2.1s and the sixth is unrecoverable from the surviving figures. Ship the QUERY and a recorded disposition per member, per P48's re-founding method — counts are not the durable artifact, predicates are) — RATIFIED 2026-08-31 -> NEW-1.
- followup:W1-T2481-1788113218856:2026-08-30T18:09:47.335Z:1 (W1-T2481's rationale cites its "13 failing" measurement to PR #3305 — a mutable pointer with no sha, no merge state and no date — so the number can be neither re-derived nor falsified; the figure is load-bearing on no shipped criterion, and the departure is from an anchoring convention the plan already keeps in 54 sha-anchored citations across 51 files) — RATIFIED 2026-08-31 -> NEW-1/NEW-2.
- followup:DAEMON-1788192519316:2026-08-31T16:38:07.971Z:0 (source-size baseline entries for account-usage.ts / worker.ts, harvested from W1-T2516) — RATIFIED 2026-09-01 -> NEW-1. LITERAL ASK WITHDRAWN AS STALE, measured on main: account-usage.ts is already recorded at exactly 740, and worker.ts measures 3684 lines against a 4000 bucket, so writing the requested 3547 would red the gate by 137 lines; ratified instead as the scope contradiction the follow-up's own second clause names — the gate prints a remedy naming scripts/source-size-baseline.json while the declared-files guard refuses that exact path.
- followup:DAEMON-1788192519316:2026-08-31T16:40:10.873Z:0 (record `src/lib/account-usage.ts: 740` and `src/lib/worker.ts: 3547` in scripts/source-size-baseline.json — the last blocker for `ci` on PR #3409) — RATIFIED 2026-09-01 -> NEW-1. The literal ask is ALREADY SATISFIED and is deliberately NOT filed: account-usage.ts measures 740 against a recorded 740, worker.ts measures 3684 against a recorded 4000, and the requested exact `3547` is stale against W1-T2539's 500-line bucketing (`ceilingFor(3547)` = 4000, which the tree already carries). NEW-1 carries the durable half the follow-up's own sentence exposes — a fix worker is forbidden by `renderFixPrompt`'s DECLARED SCOPE block from applying the edit `source-size-ratchet` printed, and stood down by `fixRungScopeStandDownReason` if it applies it anyway.
- followup:DAEMON-1788192519316:2026-08-31T16:40:10.873Z:1 (a stray staged revert of a merged fix sat uncommitted in a worker's worktree at round start; the fix rung snapshots its worktree every round but has no birth baseline to compare round 1 against, so a foreign write is captured, ignored, and then carried into the rung's own commit) — RATIFIED 2026-09-01 -> NEW-1.
- P63 (gates + golden; R39's mint, rank 2) — RATIFIED 2026-09-01 -> NEW-1/NEW-2. The REACHABILITY half, which #3377 and W1-T2538/#3407 explicitly did not close: NEW-1 declares each gate's own prescribed remedy file in `FAST_GATE_STEPS` and makes it reachable to the rung repairing THAT gate's failure (remedy (a); remedy (c) rejected on Standing rule 15 — a lane widening its own `files:` is a worker editing its own criteria; remedy (b) is W1-T2532, complementary and unduplicated), and NEW-2 gives the stand-down a named, escalatable, COUNTABLE class so P63's own zero-member falsifier and three-cycle kill trigger stop being unmeasurable prose. Filed from a sixth-member follow-up (`src/lib/daemon.ts`, #3410) whose LITERAL ask is moot and was deliberately not filed: W1-T2539's bucketing shipped, `ceilingFor(4059)` is 4500 and the baseline already records 4500 — 441 lines of headroom, and the reported 4059 was a raw count the gate never asks anyone to write; bucketing thinned the class to 19-of-300 commits (6.3%) without closing the deadlock it leaves behind.
- followup:W1-T2519-1788196324559 (QUIET_HOURS has no consumer — wire it as a DISPATCH-DEFERRAL governor arm, never `checkPause`, which would halt drainage too) — RATIFIED 2026-09-01 -> NEW-1.
