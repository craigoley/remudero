# REMUDERO — Master Plan (v2.41 · synced 2026-08-24)

**FOCUS — THE LOST CREDIT IS NOT ABSENCE; IT IS A JOIN THE GATHER COULD DO ON ITS OWN PAGE.
52 runs, 31 merged `run-W1-*` PRs in-window (hand-verified over REST), ledger credits 17, union 17**;
$3.951/run over a ~20.5-hour window. *(An **ORGAN** is an exported capability that merged with no
production call site — built, tested, shipped, never called; **DARK** while it stays that way.)*
**(1) TEN OF THE FOURTEEN UNCREDITED IN-WINDOW MERGES HAVE THEIR RUN ID AND THEIR MERGED PR URL PRINTED
TOGETHER, ON ONE HARVEST LINE, IN THIS GATHER.** Last cycle that was n=1 (#2599); this cycle it is the
DOMINANT credit-loss class at n=10. **Design rule 5 at scale — TASK G is a set difference over two
lists already printed.**
**(2) THE ABSENT RUN IS ZERO AND R26-1's FALSIFIER FIRED: P51 IS OVER-PRICED BY ITS OWN TEST.** Every
uncredited in-window merge is either harvest-printed (10) or a straddler (4). **P51 → rank 10, PARKED.**
**(3) R26-2 MISSED IN THE OTHER DIRECTION — THE `this week` COLUMN RESET (200 → 29 runs, $1096.407 →
$80.341), SO IT IS NOT AN ACCUMULATOR EITHER.** What replaces that finding is worse:
`turns this week` = **167 = 52 × 3.212**, the WINDOW's runs × its avg turns, while the same row's `runs`
column reads **29** and its `$` column **$80.341 of $205.468**. **Three columns, three populations, one
row.**
**(4) THE TURN COLUMN IS BACK, AND IT IS ONE RUN.** Coverage **2%**; `avg turns 3.212` is one run's 167
turns divided by 52. The gather stamps `DO NOT USE` on the derived column and publishes the same
numerator UNSTAMPED as an average — P48's exact shape, one table over.
**(5) A CAPABILITY SHIPPED THIS CYCLE AND WAS OBSERVED WORKING INSIDE THE SAME GATHER.** #2685 merged at
run-clock `…545177`; **all 12 guard rows before it read `observed: unproven`, all 11 after it read a
NAMED state** (`probe-never-ran` 4, `write-never-attempted` 7). **TASK M(i) CLOSES BY SHIPPING.**
**(6) AND THE NEW NAMES INDICT THE GUARD: 11 OF 23 BLOCKS OBSERVED NOTHING AT ALL** — a block whose
probe never ran is a retry the fleet paid for, not a verdict. **ONE new proposal (P52; highest prior was
P51). NO new task letter.**
Next: **P47 → P40 → P43 → P48 → P50 → P52 → P38 → P49 → P33 → P51**.

**Header discipline (v2.17).** Sync date + current focus, nothing else; the sections are the source of
truth. A retro that re-inflates this header has failed the HARNESS-COMPRESSION bar.

**Retro ledger (R1–R26 folded — the SHIPPED log's own section headers carry every id and date):**
R1–R9 seeded CALIBRATION + P1–P32, corrected the false-merged W1-T54b attribution (#80 → #91) and
closed P1–P11+P15+P21+P25+P27+P31 · R10–R15 logged the console/inbox, 94-task gate-integrity,
ratified-backlog, account/status-board, gate/claim-integrity and console-tabs/governor-wiring cycles,
RETIRED **P28** and **P41**, CLOSED **P12/P13/P14/P18/P19/P20/P23/P24/P34/P37**, mined
**P35/P38/P39/P40/P41/P42/P46/P47**, and recorded the first pre-committed effect test to PASS ·
R16–R18 logged the daemon-lane, board/verdict-integrity and GAP-FILL cycles, scored this plan's first
`HIT`, STRUCK the sibling-rejection metric P29 had been ranked on for eight cycles, and cleared the stale
assertions blocking the plan-state truth rung · **R19–R26 FOLDED TO ONE LINE BY R27** (2026-08-15 →
08-23; the write-tier/freshness, rate-limit/identity, review-state/install-root, pacer/credit-predicate,
arm-integrity/id-allocator/self-harness, containment-storm/attribution, fix-rung-park/sweep-stand-down
and credit-surface/ratchet-typing cycles — 25/30/31/31/30/40/33/38 merges, 12/14/19/18/17/29/27/25
credited): they promoted **P40 then P47 to rank 1** on FIRED falsifiers, opened the first non-clean
plan-health sweep, fired the `UNMEASURED` rule on the WHOLE `implement` row (**freezing W1-T5's mount
table**), closed **P17 by shipping** (`rmd receipt`, W1-T71/#2182), minted **P49/P50/P51** and **TASK
K/L/M**, observed the **first straddlers**, **STRUCK the word `foreign`** at 0-of-~65, and wrote design
rules **4**–**10** (*read past your own gather* · *the defect is the JOIN* · *verify the DENOMINATOR* ·
*a run-start window cannot be reconciled with merge-time credit* · *count the EVENT once and the labels
never* · *a correction inside the scanned section is not a correction* · *register the band, never last
cycle's point*) ·
**R27 (…578143187, this sync)** logs the **17-credited-of-31 containment-storm, ledger-intent and
push-lease cycle (W1-T1252–W1-T2206)**, **scores 1 hit / 3 misses**, finds the **absent-run class EMPTY
and parks P51 by its own falsifier**, replaces the accumulator finding with **three populations in one
weekly row**, **closes TASK M(i) BY SHIPPING** on a before/after boundary visible inside one gather,
mints **P52 (THE GUARD THAT BLOCKED ON ITS OWN NON-EXECUTION)**, and writes **design rule 11** (*a scope
sized by a volatile measurement is sized on the MAXIMUM observed, never the latest reading*).
**Per-proposal RE-RANK stubs stay abolished** — each proposal has ONE canonical entry,
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
- **ci-gate REQUIRED checks**: 14 — ci, lint-plan, depcruise, containment-probe, coverage-ratchet, mutation-ratchet, jscpd-gate, claims, learnings-budget-ratchet, commitlint, api-client-drift, no-hand-rolled-fetch, scan-pr / osv-scan, License Review — source: `REQUIRED` (.github/workflows/ci-gate.yml, job `ci-gate`)
<!-- CAPABILITY SNAPSHOT:END -->

★ **WS-1 COMPLETE + L2 LIVE (2026-07-15) — FOLDED TO THREE LINES BY R23; the SHIPPED log carries every
PR and the claims have held for fifteen retro-cycles.** Self-hosting exit criterion MET (`rmd daemon`
drained SBX-T1/T2/T3 unattended → #6/#7/#8, then survived kill-9 + restart with **no duplicate task
run**, W1-T12d, operator-attested; the drill was bounded, so recovery is proven by no-duplicate + clean
idle, not by an active `reconstructOrphan`). §5's Tier-1 security stack runs on remudero itself (§5A's
"the harness eats first" is FACT there), and the daemon drains `remudero` and fires its own retro
(W1-T160/#853) — the operator-kick era is over.

★ **THIS CYCLE (RETRO-1787578143187, 2026-08-24): THE CONTAINMENT STORM, THE LEDGER'S DECLARED INTENT
AND THE PUSH LEASE — 52 runs in scope → 31 merged `run-W1-*` PRs IN-WINDOW (hand-verified over REST);
the ledger credits 17 and the W1-T51 union credits the SAME 17, the first cycle in this log's history in
which the union rescues NOTHING.** Ids, PRs and costs live in the SHIPPED log and are not restated here.
What landed, credited and uncredited alike: **the ledger's readers must now DECLARE their intent**
(T1262/#2650 gives `readLedgerLines` a live-vs-union intent and refuses an undeclared read; T1286/#2677
surfaces the `ledger.*` names its enumerator cannot classify); **the fix rung stopped spending strikes
on non-evidence** (T1280/#2687 reads an unsettled REST merge state as unsettled rather than as a
conflict, T1284/#2702 stands the rung down on an unchanged worktree, T1282/#2697 aligns the rung's
dispatch check with the worker's own `ciFailures` evidence source, T1278/#2684 re-reads ci-check and
merge state before spending a strike); **the guard, probe and push leaves got their names and their
leases** (T1281/#2685 NAMES which of the four `observed` states fired — see THE SECOND FINDING,
T1288/#2690 puts `--force-with-lease` plus a post-push ref verification on the empty-commit push,
T1271/#2667 derives a probe's step count from its own prompt instead of pinning the word `THREE`,
T2201/#2695 derives the probe's turn allowance from the configured cap); **dispatch, proposal and
citation integrity** (T1268/#2668 claims a dispatch on a ref BEFORE any artifact exists, T1270/#2664
tells a faulted proposal registry from an absent one, T1267/#2665 captures a per-entry citation baseline
and refuses a stamp that would overwrite it, T1263/#2657 ships a state-citation checker — **checker-only,
no CI job wires it**, T1264/#2656 counts the changeset claims a body-vs-diff read actually recognised,
T1266/#2659 declares a bound's KIND against a baseline); **the sweep's and the daemon's health arc**
(T1275/#2672 re-drives a stale ci-gate verdict, T1272/#2674 gives the sweep a retrigger interval,
T2204/#2691 reads `main`'s OWN rollup as a health signal, T1274/#2675 gives the daemon an unconditional
per-iteration liveness row, T1259/#2639 gives the measurement verbs a cadence); and the **plan/record
spine** (T1287/#2679 gives a retired task a machine-read `retirement:` reason instead of a title-prefix
convention nothing reads, T1257/#2636 decorates a feedback entry `discharged`/`undecidable` off the
existing entry→task→PR walk, T2206/#2710 puts a re-entry guard on the feedback filing preview leg,
T1252/#2637 and T1256/#2646 build the wipe-test harness's sandbox arm, T1277/#2673 the sweep/proof lane
remainder).

★ **THE FIRST FINDING: THE CREDIT LOSS IS A JOIN, NOT AN ABSENCE — AND THE GATHER PRINTS BOTH HALVES OF
IT, ON ONE LINE, TEN TIMES.** **PROVENANCE (design rule 4):**
`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"` — page 1
covers the whole window (its oldest `updated_at` is 2026-08-23T14:01:02Z, BEFORE the marker, and page 2
holds nothing merged after it) — filtered at the marker **2026-08-23T16:53:30.413Z = epoch
`1787504010413`**, then `pulls/<n>/files` per candidate, 2026-08-24. **31 merged in-window `run-W1-*`
PRs, ALL 31 real code.** The set closes EXACTLY: **17 credited + 10 printed-but-uncredited + 4
straddlers = 31, with ZERO absent runs.** The ten — **#2639, #2657, #2668, #2672, #2677, #2679, #2684,
#2687, #2695, #2702** — each carry their run id AND their merged PR URL **together, on ONE line, in this
gather's own follow-up-harvest section**, while no credit section names either. Last cycle this class was
n=1 (#2599), treated as a curiosity beside P51's five; **this cycle it is 32% of the window's merge set
and the largest single credit-loss class this file has recorded.** TASK G's instrument is a set
difference over two lists the gather already builds and already prints.

★ **THE SECOND FINDING: A CAPABILITY SHIPPED THIS CYCLE AND THE SAME GATHER SHOWS IT WORKING — TASK M(i)
CLOSES BY SHIPPING.** **W1-T1281/#2685** (merged 2026-08-24T04:12:34Z, run-clock ≈ `1787545177`) made the
containment guard NAME which `observed` state fired instead of always writing the literal `unproven`.
The gather's 23 guard rows split at that instant with **no overlap in either direction**: the last
`unproven` row is run `…1787543141777`, **34 minutes BEFORE** the merge; the first named row is
`…1787547955020`, **46 minutes after**. **12 rows `unproven` before · 4 `probe-never-ran` + 7
`write-never-attempted` after.** This is the first time this file has closed a proposal clause on a
before/after boundary visible **inside one window's own gather** — for once the harness CAN tell whether
what it built is running, which is the exact inverse of the binding constraint. **TASK M(ii)–(iv)
STAND:** the recurrence-trend line still prints `22x across 12 tasks` with **no state breakdown beside
the count**, which is clause (ii) verbatim, and P41's retirement bar is still written in a value
(`observed: proven`) no code path emits.

★ **THE THIRD FINDING: THE `this week` ROW IS CUT ON THREE POPULATIONS AT ONCE, AND ONE OF THEM IS THIS
WINDOW.** R26 proved the column a cumulative accumulator by two exact identities and registered
**R26-2** to confirm it. **It missed in the opposite direction — the column RESET:** 200 → 29 runs,
$1096.407 → $80.341. And the row does not agree with itself either: **`turns this week` = 167 =
52 × 3.212**, this WINDOW's run count times its avg turns (`29 × 3.212 = 93`, not 167), while
`$ this week` reads **$80.341 of the window's $205.468 (39%)** and `share of weekly burn` reads
**100.0%** over a denominator equal to its own numerator — **the exact mirror of last cycle's `0.0%`,
published unstamped both times.** P40(ii) is therefore neither R26's proven mislabel nor R25's
coincidence: it is **a row assembled from three different queries**, and no figure in it may be read as
weekly, cumulative OR windowed until one of them is named.

★ **SPEND & THE INSTRUMENTS — THE BRACKET IS BACK, AND THE TURN COLUMN IS ONE RUN.** **$205.468 total,
$3.951/run** over 52 runs and a **~20.5-hour** window (marker 2026-08-23T16:53:30.413Z). **Cost per
shipped task is a BRACKET again after a cycle as a single point: $12.086** over the 17 the ledger
credits, **$7.610** over the 27 in-window merges whose runs belong to this population (31 minus the 4
straddlers, whose costs live in R26's population and are NOT restated into this one — P48, rule 7).
Ledger-credited runs total **$104.375**; the **$101.093 spent by the other 35 runs** is the honest
residue, and **23 of those 35 are guard-fired blocks**, which makes this cycle's residue an
infrastructure bill rather than a task one. **Peak CREDITED run W1-T1282 $12.059**, 8.3× under the $100
tripwire — and the 35 uncredited runs' individual costs are printed NOWHERE, so **the tripwire's
0-trips claim is unverifiable for two-thirds of the population this cycle** and is recorded as such
rather than asserted. **No `$0.000` credited run — a THIRD clean cycle.** **★ TURN COVERAGE IS 2% — NOT
0% AND NOT WHOLE:** the gather stamps `⚠ 2% coverage — DO NOT USE` on `turns/merge` and
`output tokens/merge`, then publishes `avg turns 3.212` and `output tokens 78996` UNSTAMPED off the SAME
numerator — **167 turns from ONE run divided across 52** — which is TASK D's thesis (*coverage is a
denominator, not an average*) exhibited inside a single table. **All 17 credited merges print `0 turns`**,
so the entire turn mass sits on runs that shipped nothing. MAST **infrastructure 23 (+23)** ·
**verification 11 (−4)**; **UNMAPPED 1 of 52 (2%) — the best reading ever recorded** (`blocked`×1, named,
never guessed). **Guard-fired blocks: 23 — 22 `containment/outside-cwd-denial` across TWELVE tasks plus
one `isolation/inherited-functions`** — which the gather itself calls **a HOST signal, not a task
signal**, and which design rule 8 counts as ONE event no matter how many instruments relabel it.
Mutation-gate lifetime **N=0, NO POSITIVE CONTROL** — TENTH cycle in those words (P48(ii)). **Replay
pass-rate: NO RUN RECORDED — explicitly NOT a 0%** (P48); T165/#2232's suite is dark for a FIFTH cycle.
**PLAN-STATE TRUTH RUNG: CLEAN for a second cycle** — 1 asserted-unbuilt id resolved and still unmerged,
34 lines examined, 7 proposal-subject lines reported-not-dropped. **SHIPS-UNWIRED: CLEAN** — no NET STATE
claim names a symbol the scan finds unreached. Degraded-success mining **empty**. Ratification telemetry
**0 / 0 / 0% — FIFTEENTH cycle unpaid**. **PLAN-HEALTH: 2 ids, BYTE-IDENTICAL for a FIFTH cycle**
(W3-T3, W1-T49) — **BATCH J has now cost five cycles of retro attention on a two-line edit.**

★ **THE LEARNINGS PASS: THE PROMOTION JUDGE IS LIVE, AND ITS FIRST VERDICT IS ON THIS PAGE.** For two
cycles this section read *"no promotion judge was supplied to this retro"*; **W1-T1249/#2612 shipped
the bounded judge itself — and it is one of this cycle's four UNCREDITED STRADDLERS, so the instrument
that ended a six-cycle dark leg is credited to no cycle at all.** This gather carries a real judge
verdict for the first time: **ONE promotion PROPOSED**
(`bashrc-accident → user-overall`, confidence 0.8, on the ground that *verify isolation per run via
probe, never assume security from passive configuration* is architecture-independent) **and THREE
DECLINED, each under its own named reason** (project-specific ×2; low-confidence ×1 at 0.68) — *"each
arm is a different decision, not one bucket"*, which is P48's discipline arriving in an INSTRUMENT rather
than in prose. **A dark instrument this file complained about for six cycles is lit.** The promotion is
NOT ratified here: it lands at its named layer in a reviewed PR touching `learnings/`, which a plan-only
retro may not write. LEARNINGS held at **79, `0 added`** — a FIFTH cycle. The procedural miner offered
one shape (`implement × [clean_single_strike, fully_executed_proof]`, **17 runs — every merged run in the
cycle**) into a corpus that added zero.

★ **THE HARVEST: THE AUTH FLOOR HARDENED FROM A NEAR-MISS INTO A DEAD START.** **(a)**
`plan/tasks.yaml` vs `plan/tasks.d/*.yaml` — asked independently a **FOURTH** consecutive cycle
(W1-T1257, W1-T1286, W1-T2204, W1-T2201) and still nobody has ruled which is the source. **(b)**
`gh pr edit --body` still fails repo-wide on the Projects-classic GraphQL deprecation; a fix worker lost
a round to it again (W1-T1280) and the workaround is unchanged (`gh api -X PATCH …/pulls/<n> -f body=…`).
**(c)** the stale local `main` ref is now reported **~989–1112 commits behind** (up from ~896–971) by
five runs — a **FIFTH** cycle of monotone growth with no ruling on whether the reference clone is pinned.
**(d)** character-device dotfiles (`.bashrc`, `.gitconfig`, `.mcp.json`) at every worktree root — a
FOURTH cycle. **(e)** ~100+ unreaped `run-W1-*`/`chore/file-*` branches, no reaper evident. **(f) THE
AUTH FLOOR IS NO LONGER A NEAR-MISS:** a FIX worker's `GH_TOKEN` was **already expired at first use**
(JWT `exp` ~20 min in the past) and never refreshed across ~11 minutes of polling — last cycle two runs
finished and could not push; this cycle a worker started dead. **(g) NEW:** the GitHub **GraphQL bucket
hit 0/5000 fleet-wide** mid-cycle with a ~50-minute reset — the same fact R26 hit from the retro side,
now hit from the worker side. Rule 15 forbids auto-filing; (a)–(g) are RECORDED, not filed.

★ **PRIOR CYCLES — DELETED HERE 2026-08-24, NOT SUMMARISED AGAIN.** The header's retro ledger already
folds R1–R26 with every arc, rank change, mint and design rule named, and the SHIPPED log's own section
headers carry every id, PR and date. **Two copies of one history is the duplication HARNESS-COMPRESSION
forbids**, and this file has now carried them side by side for four cycles. What is NOT in the ledger
and is kept here because it is a LIVE remainder rather than history: **T528's `behind` action remains
unshipped and is still listed under *Still PLANNED*.**

**Inventory (verified 2026-08-24 BY HAND against GitHub over REST, NOT from the gather: 31 merged task
PRs on `run-W1-*` branches merged in THIS window, ALL code — 17 credited by the ledger AND by the union,
10 printed-but-uncredited, 4 straddlers belonging to no cycle; on top of R26's 38, R25's 33, R24's 40,
R23's 30, R22's 31, R21's 31, R20's 30, R19's 25 and R18's 12; merged PR numbering on
`remudero` is now past #2714, 6 on `remudero-sandbox`).** WS-0 and WS-1
SHIPPED; WS-3's control panel is a live four-tab instrument (Decisions/Now/Plan/Feed) with a CLI
projection (`rmd status`) and **operator WRITE controls behind arm-then-confirm**, including the daily
cost-ceiling override (T364/#1417) and a Plan tab carrying per-section filed/merged counts (T376) over
a frontier that excludes `verify: human` tasks (T375). The service's write surface is **TIERED AND
ENFORCED** — low/middle/high consequence (T404/#1709), enforcement ON (T500/#1849), bearer token
LOW, read-sensitivity axis present but **DARK** (T495/#1835) — and as of this cycle it has an
**identity seam**: a Cloudflare Access JWT provider with cached/off-path JWKS and a never-throw grant
body (T531/#1929), live only once an operator stands up the Access application (ordering hazard
recorded in its design). The §5 gate stack polices its own integrity end to end — it refuses a
shipped/not-shipped task-id contradiction OFFLINE (T409/#1597), refuses a filing proof that
forward-references a future test (T456/#1766), advises when an implementation diff resolves no task
(T458/#1772), warns when a unit-test proof title matches zero or many tests (T488/#1821), wires
name-resolution into the `--base` pass (T497/#1842), judges lock holders by pid+host+start-time
(T368/T381) with a live-vs-unverifiable-foreign-host split (T461/#1773), names WHY a toolchain
candidate was refused (T901/#1936), and is regression-locked by a golden-verdict fixture corpus
(T423/#1613, T424/#1614). **`rmd sweep` is concurrency-correct and now transport-correct**:
post-review has its own budget and a real mutex (T473/#1781), check-run attempts are deduped
(T457/#1771), a fleet PR's task id resolves from its run branch (T453/#1753) and — new this cycle —
from a REST head-branch search when the trailer route misses (T523/#1917); an unreadable rollup can
no longer collapse to "no checks" (T521/#1921); review attempts dedup instead of re-firing under
rate-limit exhaustion (T526/#1926); armed-and-behind PRs get an oldest-head-first `update-branch`
(T528/#1931 — **see the organ caveat above: its `behind` producer may never fire in production**);
and the CI wait no longer blocks the daemon's event loop (T463/#1775). Every `gh` call now runs
through **one metered seam** (T525/#1927) with a pace **floor** behind it (T529/#1933, **DARK — no
live reading reaches the pacer**). The daemon fires its own retro (W1-T160/#853), dispatches multiple
tasks at once (lane count: CAPABILITY SNAPSHOT above), paces its REST burst (T468/#1780), accepts
ISO-8601 quota resets (T482/#1808), no longer spends its crash-loop budget on a freshness exit
(T490/#1825, T498/#1843), lands stranded feedback on boot and poll (T530/#1934), and resumes a
stranded ratification branch instead of duplicating it (T903/#1940), reads **PAUSE before the
freshness check** so a paused fleet stops exiting on staleness (T936/#2026), and **runs from a
dedicated install checkout** — `resolveInstallRoot()` reads it from config rather than cwd
(T924/#2002) and every generated launchd unit bakes that checkout's `bin/rmd` (T925/#2011).
**Review state is three-valued end to end**: `remudero-review=pending` is posted at DETECTION, before
any judgement (T913/#1995), and the console renders it as its own badge that never reads green while
a review is outstanding (T914/#2010). **The dependency lane has a licence gate** — `License Review`
is a REQUIRED ci-gate check (T934/#2024). Analytics (T477/#1800) and per-host heartbeat/build-sha
publication (T496/#1844) are live. The harness emits its own receipts (`rmd receipt <pr>`,
**W1-T71/#2182**); the auto-merge arm path refuses to read a PARTIAL proof pass as a full one and will
not arm before the run commits to a verdict (T1020/#2214, T975/#2212); every id a filing mints is
reserved (T949/#2196) over a bounded range (T1039/#2255); the `Remudero-Task` trailer survives
squash-merge because it is COMMITTED, not only in the body (T1012/#2240 — **and see THE THIRD FINDING:
a body-only credit reader then loses it**); and the CI suite runs on a push to `main` (T1033/#2260).
**As of this cycle the fleet authenticates as the installed GitHub App** with an in-process JWT and a
refresh loop (T1024/#2294) that abandons a hung token exchange rather than dying silently
(T1068/#2330); **an unreadable PR head ref falls back to REST before a merge is called foreign**
(T1026/#2295); **the daemon detects GitHub-side security-posture drift** (T1040/#2326) **and image
drift against the baked paths' own history** (T1021/#2284); **the sweep tick, the fix-rung spawn and
any stalled dispatch worker are all bounded by wall clock** (T1044/#2331, T1045/#2332); **the review
lane has its own concurrency budget** (T1049/#2274) and **a fail-open memory governor predicate exists,
unwired by design** (T1038/#2321).
**As of the PRIOR cycle the fix rung can PARK and REBASE rather than retry** (T1095/#2411, #2483 —
**capability 3, originating the prerequisite PR itself, is still unbuilt**), the sweep **NAMES every
stand-down it takes** (T1116/#2453, T1110/#2432, T1127/#2476, T1103/#2424), an arm error is
**classified transient-vs-permanent** (T1079/#2392, T1117/#2455), and harness PR creation runs on REST
(T1202/#2515).
**As of the PRIOR cycle (R26) the harness has a CREDIT SURFACE GATE** — `scripts/credit-surface-gate.mjs`
refuses a PR that would merge uncredited (T1214/#2520, **still checker-only: no CI job step wires it, so
it blocks nothing today**); a closed-unmerged PR's run branch no longer blocks its task's dispatch
forever (T1207/#2519, **`daemon.ts`'s own `hasPushedRunBranch` closure is the same defect, still
latent**); the fix rung is told its declared scope and stands down on scope creep (T1227/#2569) with its
spawn bound split off the sweep-tick bound (T1219/#2564); a cancelled required check is re-queued
(T1223/#2549), a reopened PR's review re-arms (T1213/#2545), a red PR is updated past its frozen gate
copy (T1212/#2542) and a fix-rung gate with no owning dispatch row is cleared (T1210/#2521); `rmd
doctor` gained a sweep-liveness arm over the retained `sweep.pass`/`sweep.summary` heartbeat (T1236/#2572,
T1237/#2579, T1238/#2581), `rmd status` marks an open-PR-only in-flight row `process-unevidenced`
(T1240/#2585) and renders an operator merge hold as its own needs-me row (T1000003/#2541); the ratchets
refuse a non-number `capBytes` instead of disarming (T1233/#2571 — **four sibling guard-and-skip sites
remain: `learnings-budget-ratchet.mjs:142`, `coverage-ratchet.mjs:78`/`:86`, `mutation-ratchet.mjs:619`**)
and derive `measuredBytes` at check time (T1234/#2575); the plan/proof lint rung tells an honestly-empty
not-shipped region from a broken one (T1232/#2568 — **`planStateTruthRung` in `src/lib/retro.ts` has the
identical conflation, still unfixed**), warns at FILING time on an unmatchable grep proof (T1225/#2573)
and classifies WHY a zero-hit proof read zero (T1224/#2553); the auto-merge arm NAMES the exhausted
GitHub bucket (T1235/#2576); `--slurp` and `gh pr update-branch` are gone for REST (T1208/#2522); a
satisfied deploy skip consumes its request (T1239/#2583); a cross-host PAUSE hold lives on
`refs/rmd-pause/hold` (T1216/#2546 — **`doctor`'s `pause-honoured` arm is still local-only**); fixture
git auto-gc is off (T1217/#2523) and `remudero-serve` is published and address-bound (T1222/#2540).
**As of THIS cycle (R27) THE CONTAINMENT GUARD SAYS WHAT IT SAW** — `observed` is one of four NAMED
states rather than the literal `unproven` (T1281/#2685, **proven live inside this cycle's own gather: 12
`unproven` rows before the merge, 11 NAMED rows after**) — and **the empty-commit push carries a lease**:
`--force-with-lease` plus a post-push ref-value verification, because a lease against a ref already
holding the pushed sha exits 0 without ever checking it (T1288/#2690). **Every ledger read declares its
intent** live-vs-union and an undeclared read is refused (T1262/#2650 — **the ~50 external callers are
NOT reclassified; the gate covers `src/lib/status.ts` only**), and the rotation enumerator surfaces the
`ledger.*` names it could not classify (T1286/#2677). **The fix rung stopped spending strikes on
non-evidence**: an unsettled REST merge state is no longer read as a conflict (T1280/#2687), the rung
stands down on an unchanged worktree (T1284/#2702), its dispatch check is aligned with the worker's own
`ciFailures` evidence source (T1282/#2697), and ci-check + merge state are re-read before a strike is
spent (T1278/#2684). **Dispatch claims a ref BEFORE any artifact exists** (T1268/#2668); a faulted
proposal registry is told from an absent one (T1270/#2664 — **no caller surfaces the distinction yet**);
a citation stamp that would overwrite a per-entry baseline is refused (T1267/#2665);
`scripts/state-citation-check.mjs` exists (T1263/#2657 — **not wired into `ci.yml` nor `ci-gate`'s
REQUIRED roster**); a bound's KIND is declared against a baseline (T1266/#2659); and the body-vs-diff
read counts the changeset claims it actually recognised (T1264/#2656). **The sweep re-drives a stale
ci-gate verdict** (T1275/#2672 — **`readCiGateRollup`/`reaggregateCiGate` have no production wire in
`buildSweepEffects`**), has a retrigger interval (T1272/#2674) and a reader for `main`'s OWN rollup
health (T2204/#2691 — **`mainHealthFromRollup` has no live gateway and no dispatch-loop caller**); the
daemon emits an unconditional per-iteration liveness row that `doctor`/`daemon-health` key on
(T1274/#2675) and the measurement verbs have a cadence (T1259/#2639). **A retired task carries a
machine-read `retirement:` reason** instead of a title-prefix convention nothing reads (T1287/#2679 —
**the known retired records are not yet backfilled, and `postMergeAmendmentViolations` guards
`acceptance` but not `status`/`retirement`**); a feedback entry is decorated `discharged`/`undecidable`
off the existing entry→task→PR walk (T1257/#2636); the feedback filing preview leg has a re-entry guard
(T2206/#2710 — **the fail-open filing POST does not**); and the probe's turn allowance is derived from
the configured cap rather than assumed (T2201/#2695). The **golden-task replay suite (T165/#2232) IS
STILL DARK** — no `HarnessRunner` wired — and **`judgeRepairStall` (T1209/#2511) still has no production
reader**. The SHIPPED log is the record (rule 13); no PR-by-PR restatement lives here.

**mounts.yaml (W1-T5) is SHIPPED** — #42, on disk at `.remudero/mounts.yaml`, re-based to a flat-400
tripwire by #90, and routing model + effort by task RISK and CLASS since W1-T167/#606. The
calibration table below is the row that re-bases it — **and the WHOLE `implement` row still publishes
`UNMEASURED` with the mount table FROZEN at its current values until TASK G ships**, the pre-committed
sixth-strike consequence of R23-1, carried into a THIRD cycle. **THE FREEZE IS NOW VINDICATED RATHER
THAN MERELY HELD:** last cycle it survived a sharp improvement (ledger credit 25% → 64%) on the
argument that *the improvement is a fact about the LEDGER and the freeze is a bar on the AUDIT*; this
cycle **credit fell back to 45% in-window / 37% on R25's own denominator, firing R25-3's falsifier**, so
a mount re-based on 64% would now be carrying a number the very next window contradicted.
**A FREEZE IS NOT A REFUSAL TO PUBLISH:** the gather's raw row is printed below unaltered, and the
mount keeps operating on the values it already holds — what is forbidden is re-BASING it.
**★ THE TURN COLUMN IS NOT A FLOOR THIS CYCLE — IT IS ABSENT** (0 turns and 0 output tokens on 31 of 31
runs); it may not be used as a floor, an average or a zero.
**★ THE CONTRAST ROW IS ABSENT FOR A SIXTEENTH CYCLE:** **ONE class row, `src` n=31**, one model row,
`sonnet` over a 200-run accumulator against a 31-run window. The rule holds unchanged: **do not re-base
a mount on a row that appears and vanishes at n≤4** — still *under-sampled, not unmeasurable*.

**Still PLANNED, not shipped** (the honest remainder): **P33's trailer quarantine list, FIFTY-TWO
`(pr, task)` pairs** (**+0 this cycle** — the ten printed-but-uncredited merges are NOT added, because
their credit is recoverable by TASK G from two lists the gather already prints, and the four straddlers
are recoverable by TASK L; nothing this cycle lost credit permanently, the first such window since R23);
**W2-T2's dry-run has not shipped**; **the organs shipped DARK by their own admission** —
`learningDuplicateViolation` has no live intake gate (T420/#1610), `mutation.ratchet_verdict` is unwired
(D-10/W1-T393/#1521, lifetime N=0), the read-sensitivity axis has no consumer (T495/#1835),
**`OpenPrView.isDraft` has no real producer and `mergeState: "behind"` may have none either, which would
make T520+T528 unreachable in production**, the golden-corpus lint hook T423 sketches is deferred,
**the golden-task replay suite T165/#2232 has no `HarnessRunner` wired** so the Self-Harness leg reports
*no run recorded* by construction, the memory governor T1038/#2321 has no `DaemonDeps`/`DrainDeps` wire,
`judgeRepairStall` (T1209/#2511) has no production reader so `rmd doctor` prints `repair-stall: OK`
unconditionally, the credit-surface gate (T1214/#2520) still has no CI job step, and **NEW this cycle:
`mainHealthFromRollup` (T2204/#2691) has no live gateway, `SweepDeps.readCiGateRollup`/`reaggregateCiGate`
(T1275/#2672) have no wire in `buildSweepEffects`, and `scripts/state-citation-check.mjs` (T1263/#2657)
is in neither `ci.yml` nor `ci-gate`'s REQUIRED roster** — three checkers built this cycle that gate
nothing today; **TWO OPEN tasks still declare no `files:` scope** (W3-T3, W1-T49 — byte-identical for a
FIFTH cycle); **the `worker.state` sensor still covers ONE of six spawn call sites**; **at least eight
shards' `verify:` field contradicts their own `note:` prose (P49)**; **`plan/tasks.yaml` and
`plan/tasks.d/*.yaml` disagree about which tasks EXIST** (harvest (a), asked a FOURTH cycle); and the
follow-up chain the harvests name but rule 15 forbids auto-filing (~70 candidates, still headed by
R19's unresolved P0: `service.ts` drains the request body to bind a HIGH-tier nonce and four of five
HIGH-tier handlers hang re-reading it).

**NEXT (L2) — ONE MINT, ONE PARK, ONE CLOSE-BY-SHIPPING; NO RE-RANK ARGUED FROM A LEVEL.** Headline
numbers moved BOTH ways this cycle (ledger credit 45% → 55%, lost code credit 19% → 45%, straddler depth
29.4 h → 3.6 h, turn coverage 0% → 2%) while the proposals stayed UNBUILT — and **P43(ii) forbids
reading any of it as a trend.** What is NOT noise is that the credit residue changed SHAPE: it stopped
being absence and became a JOIN, and **the gather prints both halves of that join on one line, ten
times.**
**(1) P47 — HOLDS RANK 1, AND ITS CHEAPEST INSTRUMENT JUST GOT ITS BEST EVIDENCE.** Fourteen of 31
in-window ships are credited by nothing, **ten of them printed run-id-and-PR-URL together in the
harvest** (n=1 last cycle → n=10). TASK G is a set difference over two lists already on the page. TASK L
keeps its four straddlers at a 3.6-hour maximum — **and design rule 11 forbids shrinking it back to a
bounded lookback on that reading.**
**(2) P40 — clause (ii) is neither the accumulator R26 proved nor the coincidence R25 suspected.** The
`this week` column RESET (200 → 29 runs), and the row's three columns are cut on three populations:
`turns this week` = 52 × 3.212 (the WINDOW), `runs` = 29, `$` = $80.341 of $205.468. Clause (i) is
alive again at **2% turn coverage — one run's 167 turns divided across 52**, which is TASK D's thesis
exhibited whole.
**(3) P43 (rank 3, HELD — not re-argued) — 1 hit, 3 misses, and the ONE hit is the row registered as a
BAND.** R26-3 (credit inside 25–65%) HIT at 55%; the three point/invariant rows all missed. **Design
rule 10 is confirmed by its own first application**, and **design rule 11** is written off R26-4's miss.
**(4) P50 → TASK M(i) CLOSES BY SHIPPING (T1281/#2685), the first proposal clause this file has closed
on evidence from the window that built it.** (ii)–(iv) stand: the recurrence line still prints `22x`
with no state breakdown, and P41's bar is still written in a value no code path emits.
**(5) P52 (NEW, rank PROPOSED at 6) — 11 of 23 guard blocks OBSERVED NOTHING** (`probe-never-ran` 4,
`write-never-attempted` 7), each of which consumed a full dispatch. A guard that blocks on its own
non-execution is a retry, not a verdict.
**(6) P51 → PARKED at rank 10.** R26-1's falsifier fired: zero absent runs. The mint stands as a
recorded mechanism, not a ranked one.
**(7) P48** — mutation-gate `N=0, NO POSITIVE CONTROL` (tenth cycle), replay *no run recorded* (fifth),
and a NEW form: **`share of weekly burn` printed `100.0%` unstamped over a denominator equal to its own
numerator, one table away from the columns the gather itself stamps `DO NOT USE`.** **(8) P38** — corpus
frozen at 79 for a fifth cycle, but **the promotion judge is LIVE and returned its first verdict**.
**(9) P49** — unchanged and unbuilt. **(10) P33** — the quarantine list holds at **FIFTY-TWO**; nothing
this cycle lost credit permanently.
The binding constraint is: **"the harness cannot tell itself whether what it BUILT is
running"** — R17 sharpened it to *whether what it MEASURED was measured*, R18 to *what it LOOKED AT*,
R19 to *the harness can write down what it failed to see and still not print it*, R20 to *the harness
can lose half its own window and every downstream instrument will still report PASS*, R21 to *the
harness can PRINT the merge it failed to credit, in the same document, and still not credit it*, R22 to
*the harness cannot count the runs it made*, R23 to *the harness cannot say which clock its own window
is cut on*, R24 to *one infrastructure event can enter three instruments under three different names*,
R25 to *the harness can print, inside the very sentence that refuses a merge, the exact branch name that
would have credited it*, R26 to *the harness can merge its own work from a run it never recorded*, and
**R27 adds the twelfth turn — and it is the first one that cuts the other way: for ONE capability, in
ONE window, the harness DID tell itself. #2685 shipped and eleven guard rows changed their words inside
the same gather that reported the merge. The constraint is not a law of nature; it is unbuilt
instrumentation, and this cycle priced exactly how much of it a single shipped field buys.**
NOTE: `nextRunnable` (drain.ts:31 `plan.tasks.find`) is DECLARATION-ORDERED; this is the authoritative
KICK ORDER (mirrored as a comment atop plan/tasks.yaml).

**★ EFFECT PRE-REGISTRATIONS (P43(i) — stored here until it is stored as data; scored by R28).**
**Every row is a BAND or an INVARIANT, never last cycle's point (rule 10), and no row is sized on the
latest reading when the series is volatile (rule 11).**

| # | metric | prediction | condition |
|---|---|---|---|
| R27-1 | **THE PRINTED-BUT-UNCREDITED CLASS** — merged in-window `run-W1-*` PRs whose run id AND merged PR URL appear TOGETHER on one line of R28's own gather while no credit section names either (**this cycle: 10 of 31 = 32%; last cycle: 1 of 31**) | **≥1 again, and this class is LARGER than the straddler class and the absent-run class combined** | **SCORABLE WITH NOTHING BUILT** — the credit sections and the harvest are both on the page; the join is a grep. **FALSIFIERS:** zero (the class was an artifact of this cycle's harvest verbosity, and TASK G is cheaper than P47 claims), or straddlers+absent-runs exceeding it (the residue moved back to a class TASK G cannot reach, and P47's ranking argument must be re-cut). |
| R27-2 | **THE THREE-POPULATION WEEKLY ROW** — in R28's `BY MODEL CLASS` table, do `runs`, `turns this week` and `$ this week` all reconcile to ONE population (either the window or a stated cumulative epoch)? (**this cycle: NO — 29 runs, 167 turns = 52 × 3.212, $80.341 of $205.468**) | **NO again — at least one of the three columns is cut on a population the other two are not** | **SCORABLE WITH NOTHING BUILT** — three numbers from that table, two from the calibration table, two multiplications. Registered as an INVARIANT (does the row close?), not as a level, because the level is what R26-2 got wrong. **FALSIFIER:** all three columns reconciling to one population, which would mean the row was fixed or re-cut and P40(ii) can be closed on a one-line rename. |
| R27-3 | **LEDGER CREDIT BAND (re-registered, HIT once)** — ledger-credited tasks ÷ hand-verified merged in-window `run-W1-*` PRs (**this cycle 17/31 = 55%; the six before it 45%, 64%, 25%, 33%, 32%, 29%**) | **the reading lands INSIDE 25–65% again — the series is a NOISE BAND, not a trend** | **SCORABLE ONLY WITH THE OUT-OF-BAND MERGE COUNT** (rule 4; name the denominator before quoting the ratio, rule 6). **FALSIFIER:** a reading outside 25–65% in EITHER direction — above means something mechanical changed and the mount freeze becomes arguable; below means the join is degrading and TASK G's target is growing. Two HITs makes the band the settled reading and R23-1's freeze condition re-statable in band terms. |
| R27-4 | **THE NAMED GUARD STATE HOLDS AND THE `unproven` MAJORITY DOES NOT RETURN** — among R28's guard-fired block rows, the share carrying a state OTHER than `unproven` (**this cycle: 11 of 23 = 48%, all of them after #2685 merged; before it, 0 of 12**) | **≥1 named state again, AND `unproven` is not a majority of the rows dated after #2685's merge** | **SCORABLE WITH NOTHING BUILT** — the gather already prints `observed:` per row. This is TASK M(i) registered as a REGRESSION TEST on a shipped capability rather than as a request for one, which is the shape rule 1 has been asking for since R16. **FALSIFIERS:** zero guard blocks (UNRESOLVABLE, never a HIT — P48), or `unproven` back in the majority post-merge, which would mean the producer is not reached on every fleet spawn path and T1281's field is DARK where it matters. |

**R26's pre-registrations, SCORED (P43(iii)'s calibration line — ★ ONE HIT, THREE MISSES; and the ONE
HIT is the only row that was registered as a BAND, which is rule 10 confirmed by its own first
application).**
**★ R26-1 MISS — the falsifier fired at ZERO, and P51 is over-priced by its own test.** Predicted ≥1
absent-run merge again; observed **0**. Every one of the 31 in-window merges resolves: 17 credited, 10
printed-in-the-harvest, 4 straddlers. The row pre-committed that a zero means *"the five were a one-off
of a re-dispatch storm, and P51 is over-priced"* — **so P51 is PARKED at rank 10, not deleted**, and its
population is folded into TASK G's, which is where the evidence actually went. Re-registered inverted as
**R27-1**, on the class that DID grow.
**★ R26-2 MISS — and it missed in the opposite direction from the one the falsifier imagined.** Predicted
both accumulator identities holding exactly; observed the column RESET (200 → 29 runs, $1096.407 →
$80.341). The falsifier's pre-committed meaning was *"the column is genuinely re-cut per window"* — but
the re-cut does not close either: `turns this week` equals the WINDOW's `52 × 3.212`, not the row's own
29 runs. **The finding is upgraded from mislabel to incoherence** and re-registered as **R27-2**, as a
does-the-row-close INVARIANT.
**★ R26-3 HIT — 17 of 31 = 55%, inside the registered 25–65% band.** The row was R25-3 re-registered as
a band precisely because R25 had predicted a level and missed. **The single row this file registered the
way rule 10 prescribes is the single row that hit**, and it hit on a reading (55%) that would have missed
R25's point-prediction (≥50%… narrowly) and missed R26's own prior reading (45%) by ten points. Kept as
**R27-3** without re-argument.
**★ R26-4 MISS — the falsifier fired in the SAFE direction, and that is exactly when a scope must not
shrink.** Predicted a maximum straddler depth >6 h; observed **3.64 h over four straddlers** (#2605
−3.64 h, #2612 −2.82 h, #2611 −2.81 h, #2626 −0.26 h, against marker epoch `1787504010413`). The row
pre-committed that a sub-6 h maximum *"would restore R25's bounded-lookback reading and shrink TASK L
back to a cheap sweep."* **This retro declines to shrink it, and writes the reason as a rule rather than
as an exception:** the depth series now reads **3.4 → 29.4 → 3.6 h**, which is not a boundary that moved
but a quantity that varies by a factor of eight. **A lookback sized at 6 h would have missed four of
last cycle's seven straddlers.** Not re-registered as a depth prediction — the depth is a scoping input,
not a mechanism claim, and rule 11 now says how to use it.
Running calibration: **n=49 · hit 13 · miss 18 · unresolvable 18.** The design rules:
**Rules 1–3 (R16–R18), FOLDED — still standing, no longer re-argued each cycle:** *a pre-registration
conditioned on undispatched work is a request, not a prediction* (**18/18 such rows UNRESOLVABLE, nine
cycles, no exceptions**, with R21-4's corollary that a standing request can be answered by the world
while the plan waits) · *name the COVERAGE precondition of your metric* (**paid again: turn coverage 2%,
and the average built on it is one run**) · *name the INSTRUMENT that will emit the number.*
**Rule 4 (R20's): A RETRO THAT READS ONLY ITS OWN GATHER CANNOT FIND A HOLE IN ITS OWN GATHER** —
verify the window's MERGE SET out-of-band before publishing and RECORD THE COMMAND; standing doctrine
for a seventh cycle, and this cycle it paid **FOURTEEN** times (10 printed-but-uncredited + 4
straddlers), none of which any in-gather reading produces. **Rule 5 (R21's): WHEN THE INSTRUMENT PRINTS
A FACT IN ONE SECTION AND OMITS IT FROM ANOTHER, THE DEFECT IS THE JOIN, NOT THE OBSERVATION** — **this
is the cycle rule 5 stopped being a curiosity: n=1 (#2599) last cycle, n=10 now, and it is the largest
credit-loss class on the page.** **Rule 6 (R22's): VERIFY THE DENOMINATOR OUT-OF-BAND, NOT JUST THE
NUMERATOR** — it decided a scoring again: 55% is a HIT on the hand-verified denominator (31) and would
read 100% on the gather's own (17 of 17), which is the same instrument answering two questions.
**Rule 7 (R23's): A WINDOW CUT ON RUN START CANNOT BE RECONCILED WITH CREDIT OBSERVED AT MERGE TIME —
SAY WHICH CLOCK THE BOUNDARY USES, AND SWEEP THE STRADDLERS** — n=3 (R25), n=7 (R26), **n=4 (R27)**.
**Rule 8 (R24's): WHEN ONE INFRASTRUCTURE EVENT IS RELABELLED BY THREE INSTRUMENTS, COUNT THE EVENT ONCE
AND THE LABELS NEVER** — **vacuous last cycle, load-bearing this one:** 22 `outside-cwd-denial` rows
across twelve tasks are ONE host storm, and this retro refuses to read the 18-of-23 gate-side rescue
inside it as 18 readings of the credit-artifact fold-line. **Rule 9 (R25's): A CORRECTION WRITTEN INSIDE
THE SECTION THE SCANNER READS IS NOT A CORRECTION — DELETE THE ID, DO NOT ANNOTATE IT** — held a second
time: the plan-state truth rung reports NO CONTRADICTION again.
**Rule 10 (R26's): A PREDICTION REGISTERED OFF A SINGLE CYCLE'S READING TESTS THE READING, NOT THE
MECHANISM — REGISTER THE BAND OR THE INVARIANT, NEVER LAST CYCLE'S POINT** — **confirmed by its own
first application: of R26's four rows, the one registered as a BAND is the one that HIT, and all three
point/identity rows missed.**
**★ Rule 11 (R27's): A SCOPE SIZED BY A VOLATILE MEASUREMENT IS SIZED ON THE MAXIMUM EVER OBSERVED,
NEVER ON THE LATEST READING — A FALSIFIER THAT FIRES IN THE SAFE DIRECTION DOES NOT SHRINK THE WORK.**
R26-4 predicted straddler depth >6 h and missed at 3.6 h, and its pre-committed consequence was to
shrink TASK L back to a bounded lookback. **This retro declines.** The series reads 3.4 → 29.4 → 3.6 h;
a lookback cut at 6 h on this cycle's reading would have missed FOUR of last cycle's seven straddlers,
and a scope that is re-cut downward every time the world is briefly kind is a scope that fails exactly
when it is needed. Rule 10 says how to REGISTER a volatile quantity; **rule 11 says how to SPEND one.**

## SHIPPED log

Shipped arcs, keyed by Remudero-Task (Standing rule 13: the proof is a MERGED PR, not prose).
Newest first. Cost/turns from the run ledger.

### RETRO-1787578143187 (2026-08-24) — the containment storm, the ledger's declared intent & the push lease: W1-T1252–W1-T2206 (17 credited / 31 in-window merged)

★ 52 runs in scope, all `implement`/`src`, over a **~20.5-hour** window (marker
2026-08-23T16:53:30.413Z = epoch `1787504010413`). Costs total **$205.468** ($3.951/run). **Cost per
shipped task is a BRACKET again after a cycle as a single point: $12.086** over the 17 the ledger
credits, **$7.610** over the 27 in-window merges whose runs belong to this population. Peak CREDITED run
**W1-T1282 $12.059/0t**; **no `$0.000` credited run** for a third cycle; **the 35 uncredited runs' costs
are printed nowhere**, so the $100 tripwire's 0-trips claim covers a third of the population and is
recorded, not asserted. **★ THE LEDGER CREDITS 17 OF 31 IN-WINDOW MERGES (55%) AND THE W1-T51 UNION
CREDITS THE SAME 17 — the first cycle in this log's history in which the union rescues NOTHING** —
verified BY HAND on 2026-08-24 over REST (`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`,
page 1 covering the whole window, filtered at the marker, then `pulls/<n>/files` per candidate — design
rule 4). **TURN COVERAGE 2%: 167 turns on ONE run, and all 17 credited merges print `0t`.**
**GUARD-FIRED BLOCKS: 23** (22 `containment/outside-cwd-denial` across TWELVE tasks + 1
`isolation/inherited-functions`) — **ONE host storm, counted once (rule 8)**. Mutation-gate lifetime
**N=0, NO POSITIVE CONTROL**. Replay leg: **no run recorded** — T165/#2232's suite dark for a fifth
cycle.

- **★ LEDGER-CREDITED — 17 tasks, and the union adds not one** → **$104.375**:
  - W1-T1282 *$12.059/0t* — the fix rung stood down on zero enumerable CI failures · https://github.com/craigoley/remudero/pull/2697
  - W1-T1264 *$11.904/0t* — the review reports changeset-claim RECOGNITION, not just contradiction · https://github.com/craigoley/remudero/pull/2656
  - W1-T1272 *$10.239/0t* — the daemon reaches the full sweep before returning stale, and retriggers it · https://github.com/craigoley/remudero/pull/2674
  - W1-T1252 *$8.359/0t* — wipe-test never ledgers a pair neither arm measured · https://github.com/craigoley/remudero/pull/2637
  - W1-T1257 *$7.340/0t* — `discharged`/`undecidable` decoration derived for the feedback inbox · https://github.com/craigoley/remudero/pull/2636
  - W1-T1274 *$7.213/0t* — an unconditional per-iteration `daemon.tick` liveness row · https://github.com/craigoley/remudero/pull/2675
  - W1-T1256 *$6.739/0t* — wipe-test's no-merge boundary and arm-order alternation · https://github.com/craigoley/remudero/pull/2646
  - W1-T1267 *$5.531/0t* — a per-entry baseline check BEFORE the citation stamp write · https://github.com/craigoley/remudero/pull/2665
  - W1-T2206 *$5.153/0t* — pending/re-entry-guard/armed states rendered for feedback submit · https://github.com/craigoley/remudero/pull/2710
  - W1-T1288 *$4.999/0t* — a lane's push LEASED on the head it believed it was building on · https://github.com/craigoley/remudero/pull/2690
  - W1-T1262 *$4.941/0t* — a declared intent required on every `readLedgerLines` call · https://github.com/craigoley/remudero/pull/2650
  - W1-T1277 *$4.254/0t* — the ratchets refuse a malformed threshold instead of silently disarming · https://github.com/craigoley/remudero/pull/2673
  - **W1-T1281 *$3.759/0t* — the containment guard NAMES the unproven state instead of discarding it (THE SECOND FINDING)** · https://github.com/craigoley/remudero/pull/2685
  - W1-T1266 *$3.521/0t* — undeclared bound-shaped constants gated against a baseline · https://github.com/craigoley/remudero/pull/2659
  - W1-T2204 *$3.474/0t* — `main`'s own check rollup read as a health observation · https://github.com/craigoley/remudero/pull/2691
  - W1-T1271 *$2.643/0t* — the probe prompt's step narration asserted against its listed steps · https://github.com/craigoley/remudero/pull/2667
  - W1-T1270 *$2.247/0t* — WHY the proposal registry read back empty is discriminated · https://github.com/craigoley/remudero/pull/2664
- **★ PRINTED-BUT-UNCREDITED — 10 CODE PRs WHOSE RUN ID AND MERGED PR URL SHARE ONE LINE OF THIS
  CYCLE'S OWN HARVEST WHILE NO CREDIT SECTION NAMES EITHER (THE FIRST FINDING; design rule 5 at n=10,
  after n=1 last cycle).** W1-T1259/#2639 (rule-efficacy/verdict-calibration/autonomy-rate given a
  cadence) · W1-T1263/#2657 (a state-citation gate script + baseline, **not wired into CI**) ·
  W1-T1268/#2668 (a pre-artifact cross-host dispatch claim before any run spends) · W1-T1275/#2672
  (the ci-gate rollup bounded to recompute after a sibling flips green) · W1-T1286/#2677 (`ledger.*`
  files the enumerator cannot classify are NAMED) · W1-T1287/#2679 (a retirement-reason sibling field
  for blocked tasks) · W1-T1278/#2684 (ci-check and merge state re-read before a fix strike is spent) ·
  W1-T1280/#2687 (merge facts re-read before a REST 405 is treated as final) · W1-T2201/#2695 (the
  probe's turn cap derived from its command count) · W1-T1284/#2702 (the fix rung stood down on an
  unchanged worktree). Each is a real `src/**`/`scripts/**`+`test/**` diff on a well-formed run branch
  whose run id THIS gather prints. **Their costs are in the $205.468 total and in no credited row** —
  the money is counted, the work is not. **NOT added to P33's quarantine list: TASK G recovers every one
  of them from two lists already on the page.**
- **★ STRADDLERS — 4 CODE PRs THAT BELONG TO NO CYCLE, MAXIMUM DEPTH 3.64 h (R26-4's FALSIFIER FIRED,
  IN THE SAFE DIRECTION — see design rule 11).** **W1-T1253/#2605** (a sandbox-subject generator for
  wipe-test pairs, **−3.64 h** pre-marker) · **W1-T1249/#2612** (**a bounded promotion judge, so the
  learnings pass finally runs — −2.82 h**) · **W1-T1251/#2611** (the designed absence reported apart
  from a real refusal, **−2.81 h**) · **W1-T1265/#2626** (network containment PROVEN per run by an
  egress arm, **−0.26 h**). **No costs or turns are stated** — the numbers live in R26's population and
  this retro will not restate them into its own (P48, rule 7). **★ THE STING: #2612 is the PR that lit
  the promotion judge whose first verdict this cycle's gather prints — the instrument that ended a
  six-cycle dark leg is itself credited to no cycle.**
- **Non-merged verdicts: 35** (`blocked_containment`×22, `blocked_ci`×11, `blocked_isolation`×1,
  `blocked`×1). **23 of the 35 are guard-fired blocks — ONE host storm (rule 8), never 23 readings** —
  and 18 of those 23 rows belong to tasks that merged in this same window anyway, which this retro
  therefore **refuses to enter in the credit-artifact fold-line as an 18-of-23 reading**. The remaining
  12 (`blocked_ci`×11 + `blocked`×1) are **not task-named by the gather at all**, so the fold-line's
  reading is **UNCOMPUTABLE this cycle without TASK H** — stated, not estimated (P48).

### RETRO-1787502627029 (2026-08-23) — the credit surface, the ratchets' type discipline & the doctor's sweep-liveness arm: W1-T1207–T1250 (25 credited / 31 in-window merged)

★ 31 runs in scope, all `implement`/`src`, over a **~23.9-hour** window (marker
2026-08-22T17:55:18.498Z). Costs total **$171.844** ($5.543/run). **Cost per shipped task is a SINGLE
POINT this cycle, $6.874 over the 25 the union credits — and it is the only computable one**, because
**13 of the 38 merged `run-W1-*` PRs have their cost in NO window's total**: 7 straddlers (runs outside
this population) and 6 merges whose runs this gather never names. Peak credited run **W1-T1227
$15.623/0t** (a `blocked` verdict whose PR merged gate-side); **no `$0.000` credited run** for a second
cycle. **★ THE LEDGER CREDITS 14 OF 31 IN-WINDOW MERGES (45%) AND THE UNION 25 (81%)** — verified BY
HAND on 2026-08-23 over REST (`gh api "repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100"`,
pages 1–3, filtered at the marker, then `pulls/<n>/files` per candidate) because **the GraphQL bucket
was exhausted at 0 of 5000** (design rule 4). **TURNS AND OUTPUT TOKENS: ZERO ON 31 OF 31 RUNS** — the
column is not a floor, it is absent. **2 rejected trailers, both same-task siblings, 0 foreign.**
**ZERO guard-fired blocks.** Mutation-gate lifetime **N=0, NO POSITIVE CONTROL**. Replay leg: **no run
recorded** — T165/#2232's suite dark for a fourth cycle.

- **★ LEDGER-CREDITED — 14 tasks** (**W1-T1235/#2576 *$12.698/0t* — the exhausted GitHub bucket NAMED
  on a rate-limited auto-merge-arm refusal** · T1219/#2564 *$12.085/0t* the fix-rung spawn bound split
  off the sweep-tick bound · T1207/#2519 *$6.552/0t* a closed-unmerged PR's run branch stopped from
  blocking its task's dispatch forever · T1210/#2521 *$5.354/0t* a fix-rung gate whose owning dispatch
  left no row now cleared · T1236/#2572 *$4.514/0t* `rmd doctor`'s sweep-liveness arm on the per-pass
  heartbeat · T1237/#2579 *$4.490/0t* `sweep.pass`/`sweep.summary` retained so that arm can read them ·
  T1000003/#2541 *$3.902/0t* an operator merge hold rendered as its own needs-me row · T1240/#2585
  *$3.674/0t* an open-PR-only in-flight row marked `process-unevidenced` · T1222/#2540 *$3.257/0t* the
  `remudero-serve` container published and address-bound · T1232/#2568 *$2.987/0t* the plan-state claims
  rung stopped refusing an honestly empty not-shipped region · T1234/#2575 *$2.882/0t* `measuredBytes`
  no longer stored, derived at check time · T1250/#2610 *$2.224/0t* containment-probe's test runner
  given its fixture-harness import · T1233/#2571 *$2.213/0t* a non-number `capBytes` REFUSED instead of
  silently disarming the size gate · T1238/#2581 *$1.759/0t* the `sweep.pass` producer note corrected to
  name its reader) → **$68.591**
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 11 tasks, the largest rescue set this log has
  recorded** (T1227/#2569 *$15.623/0t* the fix worker told its declared scope and stood down on scope
  creep — **`blocked`, not `blocked_ci`** · T1223/#2549 *$11.418/0t* a cancelled required check re-queued
  instead of dispatching the fix rung · T1225/#2573 *$7.421/0t* the task linter warning at FILING time
  on an unmatchable grep proof · T1213/#2545 *$5.257/0t* a reopened PR's review re-armed after a stale
  closed-lifecycle refusal · T1208/#2522 *$5.194/0t* `--slurp` and `gh pr update-branch` dropped for
  REST · T1212/#2542 *$5.026/0t* a red PR updated past its own frozen gate copy · T1224/#2553
  *$4.466/0t* a zero-hit grep proof CLASSIFIED by cause · T1217/#2523 *$4.424/0t* git auto-gc disabled
  in fixtures, closing the push-clone race · T1216/#2546 *$4.011/0t* a shared cross-host PAUSE hold on
  `refs/rmd-pause/hold` · T1239/#2583 *$3.404/0t* a satisfied up-to-date deploy skip consuming its
  request · T1214/#2520 *$2.993/0t* `credit-surface-gate` refusing a PR that would merge uncredited)
  → **$69.237**
- **★ STRADDLERS (7) AND ABSENT RUNS (5) — FOLDED BY R27; the ids and depths stay, the prose
  goes.** Straddlers: T1000002/#2376 (−29.38 h), T1098/#2403 (−25.24 h), T1104/#2434 (−20.65 h),
  T1109/#2431 (−20.64 h), T1128/#2478 (−4.57 h), T1132/#2494 (−2.30 h), T1134/#2499 (−1.61 h) — all
  CODE, all belonging to no cycle, **and the depth series they anchor (3.4 → 29.4 → 3.6 h) is what
  design rule 11 is written on.** Absent runs (P51's ground truth): #2526, #2529, #2532, #2602, #2604,
  run ids never printed by R26's gather, added to P33's quarantine list (+5 → 52). **R26-1 predicted the
  absent-run class would recur and R27 observed ZERO of it, so P51 is PARKED** — this bullet is now a
  record of a mechanism observed once, not of a standing class. No costs or turns are stated for either
  set (P48, rule 7).
- **★ #2599 — MERGED ON ITS OWN RUN BRANCH WITH THE JOIN PRINTED IN THE SAME DOCUMENT.** W1-T1248, run
  `run-W1-T1248-1787487541703`, run id and PR URL on one harvest line, no credit section holding the
  pair. **R27 found TEN more of exactly this shape**, which is what promoted rule 5 from curiosity to
  the largest credit-loss class on the page.
- **Non-merged verdicts: 17** (`blocked_ci`×15, `blocked`×1, `failed`×1) — **11 of the 17 belong to
  tasks the union rescued gate-side (65%, a FLOOR)**, which is the standing credit-artifact fold-line's
  reading for this cycle. **`failed` is a verdict class this file has never seen printed** (n=1, unmapped,
  no exemplar — TASK H).

### RETRO-1787419805720 (2026-08-22) — the fix rung's park/rebase, the sweep's stand-down vocabulary & the doctor's repair arm: W1-T1079–T1209 (27 credited / 33 merged)

★ 41 runs in scope, all `implement`/`src`, over a **35.48-hour** window (marker
2026-08-21T06:01:21.759Z → gather 2026-08-22T17:30:05.720Z). Costs total **$263.719** ($6.432/run).
**Cost per shipped task is a THREE-POINT BRACKET — $9.77 over the 27 the union credits, $9.09 over the
29 IN-WINDOW CODE ships, $8.79 over all 30 in-window ships** — and none is comparable to R24's
$8.39/$6.57/$6.08 (P43(ii)): three of this window's 33 merges are STRADDLERS whose runs and costs are
in NO window's total, so the denominators differ again, this time for a reason nobody has had to state
before. Peak credited run **W1-T1082 $12.323/0t** — **the lowest peak this log has recorded** and 3.0×
below R24's, with **no `$0.000` credited run at all** (the first clean reading on that sub-clause in
three cycles).
**★ THE LEDGER CREDITS 21 OF 33 (64%) AND THE UNION 27 (82%) — BOTH ALL-TIME HIGHS, the ledger figure
by a factor of two and a half.** Verified BY HAND on 2026-08-22 with `gh pr list --state merged --limit
300 --json number,mergedAt,headRefName,title` filtered at the marker, then `gh pr view <n> --json
files,body` per residue candidate (design rule 4). **TURNS: 5 of the 27 lit (19%, up from 11%); the
dark twenty-two are the twenty-two EARLIEST-STARTING runs — a contiguous PREFIX for a SIXTH cycle —
with the boundary at dark >5.47 h, lit <2.52 h.** **5 rejected trailers, ALL naming the same task,
ZERO foreign — and R24-2's pre-commitment fires: the word `foreign` is STRUCK.** **2 guard-fired
blocks**, both `isolation/inherited-functions`, both `observed: unproven`, both one host. Mutation-gate
lifetime **N=0, NO POSITIVE CONTROL**. Replay leg: **no run recorded** — T165/#2232's suite dark for a
third cycle.

- **★ LEDGER-CREDITED — 21 tasks** (**W1-T1082/#2367 *$12.323/0t* — disk headroom escalated before
  ENOSPC can blind the ledger** · T1205/#2500 *$12.701/131t* the status board's queue head bound to the
  dispatcher's own `hasPushedRunBranch` · T1202/#2515 *$12.661/149t* harness PR creation moved off
  GraphQL `--fill` onto REST · T1103/#2424 *$9.343/0t* `needs-human` issues the system can never retire
  no longer opened · T1100/#2415 *$8.351/0t* a substituted PR-body report told from the real one ·
  T1089/#2397 *$7.575/0t* triage's commit routed through the shared plan-proposal committer ·
  T1127/#2476 *$7.438/0t* a pre-dispatch throw stopped from seeding the fix rung's dedup gate ·
  T1079/#2392 *$7.319/0t* the arm error recorded and classified rather than assumed transient ·
  T1201/#2505 *$5.906/77t* `ageDays` clamped to a PR's own lifetime · T1116/#2453 *$5.680/0t* the
  `alreadyDone` stand-down named on `mergeable` and `wait` · T1118/#2458 *$4.667/0t* the reachability
  examined count carried on `review.posted` · T1113/#2442 *$3.015/0t* the max-id recipe warned
  minting-only · T1086/#2369 *$2.846/0t* `daemon.clone_reap` emitted unconditionally with a roots tally
  · T1099/#2409 *$2.859/0t* dispatch-liveness made to answer whether the fleet dispatches ·
  T1131/#2477 *$2.693/0t* the ci-gate fail arm restricted to the required-check list · T1096/#2402
  *$2.572/0t* the git-config triple forwarded only as a consistent unit · T1209/#2511 *$2.501/29t*
  `judgeRepairStall` added to watch the repair rung · T1111/#2437 *$2.313/0t* `--delete-branch` dropped
  from the auto-merge arm leg · T1112/#2436 *$2.043/0t* the spawn's error text put on the row that
  terminates the run · T1105/#2422 *$1.995/0t* the two throw messages a mutant can empty ·
  T1087/#2371 *$1.748/0t*) → **$118.549**
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 6 tasks** (T1117/#2455 *$9.618/0t* a base-branch race
  classified retryable, ending the unknown-arm retry loop · T1088/#2395 *$5.562/0t* the filing grammar
  taught it has no absence proof · T1206/#2506 *$5.158/57t* an alarm when an effect-reaching candidate
  has no exclusion reason · T1129/#2479 *$4.308/0t* upstream-tracking config writes dropped from
  worktree branch creation · T1101/#2419 *$3.358/0t* `issuesSeen` and drop reasons rendered in the
  reconcile summary · T1110/#2432 *$7.340/0t* the blocked-fixable/conflicted dedup stand-down named and
  re-armed) → **$35.344**
- **★ THE FOUR RESIDUE BULLETS — FOLDED BY R27; ids, verdicts and totals kept, prose deleted.**
  **STRADDLERS (3, the first this log ever had a row for):** T1062/#2354, T1074/#2361, T1078/#2363 —
  runs starting 3.38 h / 1.41 h / 0.70 h before the marker, merging 5–10 h after R24's gather closed;
  no costs stated (P48, rule 7). **MERGED ON THEIR OWN RUN BRANCH, CREDITED BY NOTHING (2 PRs, ONE
  TASK):** T1095/#2411 and T1095/#2483 — the resolver took the LATEST PR carrying the task id rather
  than the PR whose head IS the run's branch, and printed the refused branch name verbatim; both on
  P33's list. **(R26 registered R25-2 on that mechanism, observed 0 of 2, and WITHDREW it as n=1.)**
  **CORRECTLY UNCREDITED (1):** #2388, a plan-only filing on a run branch — T1004/#2152's predicate
  working, not a defect. **UNCREDITED-RUN REMAINDER — 14 runs, $109.826** ($263.719 less the $153.893
  credited), at **$7.85/run against a $6.432 window average — the first cycle where the uncredited
  remainder cost MORE per run than the window**, the inverse of R24's guard-killed $0.87.

### RETRO-1787290856852 (2026-08-21) — the containment storm, the attribution spine & the review/proof lane: W1-T1016–T1085 (29 credited / 40 merged)

★ 54 runs, all `implement`/`src`, over a **26.66-hour** window. **$243.216** ($4.504/run); bracket
**$8.39 / $6.57 / $6.08** over 29 credited / 37 CODE ships / all 40. Peak **W1-T1044 $37.084/0t**,
3.3× the next. **★ FOLDED TO FAMILY LINES BY R25** (R13's doctrine: ids, PRs and costs preserved,
descriptive prose deleted — the NET STATE fold above carries this cycle's findings).
**THE CYCLE'S RECORD IN FOUR NUMBERS:** union coverage **29 of 40 (73%)**, the highest then recorded ·
**13 guard-fired blocks**, all `containment/outside-cwd-denial`, all `observed: unproven`, all inside a
**41-minute band on one host** — the event that minted design rule 8 · **22 rejected trailers, 21
naming a SIBLING run of the same task and the 22nd a hand-filed branch of that same task, ZERO
foreign** · **turns 3 of 29 (11%)**, the dark twenty-six a contiguous PREFIX, boundary dark >6.11 h /
lit <4.83 h.

- **★ LEDGER-CREDITED — 10 tasks, $63.578** (W1-T1069/#2336 *$11.397/0t*, the peak of this group, one
  declared runtime env list shared by `recycle-container.sh` and `host-update.sh` · T1018/#2271
  *$9.699/0t* · T1053/#2347 *$9.547/119t* · T1077/#2358 *$7.350/90t* · T1071/#2335 *$6.307/0t* ·
  T1052/#2340 *$5.285/59t* · T1066/#2322 *$4.022/0t* · T1068/#2330 *$3.868/0t* · T1026/#2295
  *$3.480/0t* · T1034/#2265 *$2.623/0t*)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 19 tasks, $157.882, the largest rescue this log has
  recorded** (T1044/#2331 *$37.084/0t* · T1045/#2332 *$18.673/0t* · T1067/#2323 *$16.024/0t* ·
  T1031/#2315 *$12.459/0t* · T1040/#2326 *$10.331/0t* · T1038/#2321 *$8.952/0t* · T1049/#2274
  *$8.638/0t* · T1064/#2316 *$6.389/0t* · T1019/#2273 *$5.939/0t* · T1016/#2266 *$5.689/0t* ·
  T1060/#2314 *$5.269/0t* · T1021/#2284 *$5.252/0t* · T1051/#2286 *$5.036/0t* · T1050/#2334
  *$4.788/0t* · T1036/#2268 *$4.336/0t* · T1065/#2320 *$3.023/0t* · **T1024/#2294, T1054/#2289,
  T1061/#2292 *$0.000/0t* each**).
  **★ A `$0.000` COST ON A RUN THAT MERGED A PR IS AN UNRECORDED COST, NEVER A FREE ONE** (P48). Three
  of these nineteen record it; the work was done and the ledger did not price it.
- **★ THE THREE RESIDUE BULLETS — FOLDED BY R27; ids and totals kept, prose deleted.** **MERGED ON
  THEIR OWN RUN BRANCH, CREDITED BY NOTHING (8 CODE PRs, recovered by hand):** T1059/#2346 — **a
  production caller for the learnings-promotion pass, merged in the same window whose gather reported
  that pass did not run** — plus T1048/#2270, T1047/#2311, T1055/#2312, T1056/#2319, T1063/#2309,
  T1076/#2356, T1085/#2357; five carry a rejection row naming a SIBLING run, three have no rejection
  row at all, and **T1085/#2357 carries its trailer ONLY in the commit message** (TASK G(iv)'s origin).
  No costs stated (P48). **CORRECTLY UNCREDITED (3):** #2325, #2329, #2349 — plan-only filings on run
  branches, T1004/#2152's predicate working. **UNCREDITED-RUN REMAINDER — 25 runs, $21.756**
  (`blocked_ci`×15, `blocked_containment`×13, `incomplete`×11, `blocked`×3,
  `pr_attribution_failed`×2, less the nineteen rescued). **THIRTEEN of the 25 are the containment
  storm**, which is why the remainder reads **$0.87 per run against a $4.504 window average — not
  thrift, but the price of a run the guard killed before it could spend**, and reading it as efficiency
  is the relabelling design rule 8 forbids.

### RETRO-1787193680272 (2026-08-20) — arm integrity, the id allocator & the self-harness leg: W1-T74–T1039 + T165/T188/T446/T492 (17 credited / 30 merged)

★ 33 runs, all `implement`/`src`. **$197.333** ($5.980/run); bracket **$11.61 / $7.05 / $6.58** over
17 credited / 28 in-window ships / 30 with the straddlers. Peak **W1-T949 $14.890/0t**. **Turns 8 of 17
(47%), the dark nine a contiguous PREFIX.** 0 rejected trailers, 0 guard-fired blocks, mutation N=0,
replay **no run recorded** — the suite shipped here, dark. **★ FOLDED TO FAMILY LINES BY R25** (R13's
doctrine: ids, PRs and costs preserved, descriptive prose deleted).

- **★ LEDGER-CREDITED — 10 tasks, $65.325** (W1-T947/#2194 *$12.608/0t*, the irreversibility signal
  routed into every auto-merge arm site · T1011/#2236 *$9.074/107t* · T1028/#2242 *$8.764/108t* ·
  T1033/#2260 *$7.959/112t* · T1029/#2241 *$7.235/94t* · T1035/#2263 *$5.461/68t* · T1017/#2193
  *$4.882/0t* · T1013/#2262 *$4.282/59t* · T1030/#2254 *$2.870/57t* · T1032/#2252 *$2.190/25t*)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 7 tasks, $51.054, every one `blocked_ci`**
  (T949/#2196 *$14.890/0t* · T951/#2188 *$13.308/0t* · T964/#2191 *$6.786/0t* · T1010/#2190
  *$6.459/0t* · T948/#2187 *$3.579/0t* · **T74/#2186 *$3.261/0t* next-unused proposal ids + a CI
  uniqueness gate, the discipline every later P-mint is checked by** · T492/#2189 *$2.771/0t*)
- **★ MERGED ON THEIR OWN RUN BRANCH, CREDITED BY NOTHING — 11 CODE PRs, recovered by hand.**
  **T165/#2232 — the golden-task replay suite, the Self-Harness leg this plan had cited for eight
  cycles, shipped MECHANISM-AND-SEAM ONLY with no `HarnessRunner` wired (R23's STING)** · T188/#2234 ·
  T1020/#2214 · T975/#2212 · **T1012/#2240 the `Remudero-Task` trailer COMMITTED so squash-merge keeps
  it** · T1039/#2255 · T963/#2204 · T983/#2230 · T952/#2199 · T446/#2237 · T1027/#2211.
  **Nine of the eleven have their PR url printed in that gather's own follow-up harvest** — R22-2
  predicted zero such rows. **No costs or turns are stated** (P48).
- **★ STRADDLERS — 2 CODE PRs BELONGING TO NO CYCLE (R23's SECOND FINDING, and the class R25 confirmed
  at n=3).** **T71/#2182 `rmd receipt <pr>`** — P17's ratified receipts task, left *uncredited* by
  six consecutive syncs — and **T499/#2181**, both merged from runs starting ~5 minutes BEFORE the
  marker. **TASK L exists to make this automatic.**
- **UNCREDITED-RUN REMAINDER — 16 runs, $80.954**, verdicts `blocked_ci`×9, `incomplete`×6, `blocked`×5,
  `pr_attribution_failed`×2, `no_pr`×1 less the seven the union rescued. **At least eleven of these runs
  merged a PR**, so this bullet's own label is suspect: TASK H would print the per-run verdict row that
  decides it, TASK K whether the run set is complete, TASK L whether its boundary is sound.
### RETRO-1787106875391 (2026-08-19) — the pacer spine, the credit predicate & the diagnose lane: W1-T939–T1009 + T7B/T234/T493 (18 credited / 31 merged)

★ 30 runs in scope (**a set R22's SECOND FINDING shows is short — 31 in-window runs merged a PR**), all
`implement`/`src`. **$162.696** ($5.423/run); bracket **$9.04 / $6.51 / $5.25** over 18 credited / 25
CODE ships / all 31. Peak **W1-T7B $10.593/144t**. **Turns 5 of 18 (28%), the dark thirteen a
contiguous PREFIX — and five of them are LEDGER credits, which refutes R21's gate-side-credit shape.**
**2 rejected trailers, BOTH MISLABELLED.** 0 guard-fired blocks, mutation **N=0**. **★ FOLDED TO FAMILY
LINES BY R25** (R13's doctrine: ids, PRs and costs preserved, descriptive prose deleted).

- **★ LEDGER-CREDITED — 10 tasks, $69.343** (**W1-T7B/#2178 *$10.593/144t*, `runDiagnoseThenRetry`
  wired into the implement dispatch, ending five cycles of zero `diagnose` runs** · T978/#2117
  *$10.247/0t* · T984/#2127 *$9.875/0t* · T493/#2183 *$7.808/102t* · T999/#2155 *$7.652/102t* ·
  T1007/#2157 *$7.519/82t* · T991/#2146 *$5.663/0t* · T976/#2115 *$4.150/0t* · **T1004/#2152
  *$3.960/55t*, the plan-only merge-credit predicate that makes six of this window's uncredited merges
  CORRECT** · T986/#2132 *$1.876/0t*)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 8 tasks, $33.591** (T943/#2051 *$12.082/0t* ·
  T945/#2055 *$9.447/0t* · T939/#2052 *$4.227/0t* · T972/#2113 *$4.100/0t* · T977/#2116 *$3.735/0t* ·
  **T941/#2060, T944/#2049, T970/#2106 *$0.000/0t* each** — unrecorded costs, never free ones)
- **★ MERGED ON THEIR OWN RUN BRANCH, CREDITED BY NOTHING — 7 CODE PRs, recovered by hand.**
  **T1008/#2163 + T1005/#2159 — together the producer and the budget wire that let T529's rate-limit
  floor FIRE, retiring a *Still PLANNED · DARK* entry this file had carried for three cycles; both
  uncredited, so the plan would have kept calling a shipped organ dark (R22's STING)** · T997/#2153 ·
  T1009/#2160 · T1006/#2162 · T234/#2177 · T981/#2122. **Four of the seven have their PR url printed in
  that gather's own follow-up harvest** — R21-2 predicted zero such rows. **No costs or turns are
  stated** (P48).
- **★ CORRECTLY UNCREDITED — 6 plan-only filing PRs** (T968/#2099, T971/#2101, T974/#2104, T985/#2129,
  T988/#2134, T996/#2140). **NOT a credit defect and NOT added to P33's list**: T1004/#2152 shipped this
  window precisely to refuse merge credit to a plan-only filing PR — the first time in this log's record
  that part of the uncredited gap is the harness working as designed.
- **UNCREDITED-RUN REMAINDER — 12 runs, $59.762**, `blocked_ci`×5, `incomplete`×4, `blocked`×2,
  `pr_attribution_failed`×1, carrying most of the window's 1194 turns. TASK G would have printed the
  third bullet; TASK H would let this one be counted rather than named; **TASK K would explain why 30
  runs cannot account for 31 merges.**
### RETRO-1786966159317 (2026-08-17) — the review three-state, the install root & the retro instrument's own repair: W1-T533 + T905–T936 (19 credited / 31 merged)

★ 27 runs, all `implement`/`src`. **$182.927** ($6.775/run); bracket **$9.63 / $5.90** over 19 credited
/ 31 real ships. Peak **W1-T913 $16.345/195t**. **Turns 15 of 19 (79%) — the high-water mark of the
series; the four dark ones are the window's four earliest-merging ships.** **2 rejected trailers, one
MISLABELLED.** 0 guard-fired blocks, mutation **N=0**. **★ FOLDED TO FAMILY LINES BY R25** (R13's
doctrine: ids, PRs and costs preserved, descriptive prose deleted).

- **★ LEDGER-CREDITED — 9 tasks, $76.021** (**W1-T925/#2011 *$12.384/145t*, launchd units baking the
  install checkout's `bin/rmd`** · T911/#1983 *$11.508/62t* · **T930/#2008 *$10.083/148t*, the
  output-token and turns-per-merge columns this file's calibration table still leans on** ·
  T914/#2010 *$8.654/107t* · T920/#1998 *$8.579/112t* · T915/#1985 *$8.068/96t* · T923/#2000
  *$7.519/98t* · T929/#2006 *$6.395/92t* · **T936/#2026 *$2.831/47t*, PAUSE read before the freshness
  check — the window's cheapest ship**)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 10 tasks, $73.436** (**W1-T913/#1995 *$16.345/195t*,
  `remudero-review=pending` posted at DETECTION — the cycle's spine and its peak run** · T905/#1948
  *$14.796/0t* · T931/#2013 *$11.492/152t* · T924/#2002 *$8.764/89t* · T907/#1952 *$7.862/0t* ·
  T912/#1981 *$5.725/85t* · T918/#1982 *$3.792/54t* · T533/#1968 *$2.389/0t* · T908/#1969 *$2.000/0t* ·
  T932/#2020 *$0.271/68t*)
- **★ MERGED ON THEIR OWN RUN BRANCH, CREDITED BY NOTHING — 12 PRs, recovered by hand.** **T534/#1967 —
  correctly trailered on `run-W1-T534-1786886488695` while the gather rejected #1977 for the same task;
  the sharpest instance in this log** · T916/#1984 · T917/#1986 · T921/#1992 · T529/#1951 + T529/#1970 ·
  **T933/#2019, T934/#2024 the REQUIRED licence gate, T935/#2027, T938/#2030, T942/#2037 — all five with
  their PR url printed in that gather's own harvest** · T940/#2033. **No costs or turns are stated**
  (P48). Two (T916, T917) ride round-number run ids — the W1-T390/P33 shape, which explains neither the
  other ten nor T534's.
- **UNCREDITED-RUN REMAINDER — 8 runs, $33.470**, `blocked_ci`×5, `blocked`×2, `incomplete`×1, carrying
  the balance of the window's ~1919 turns. TASK G would have printed the section above; TASK H would let
  this one be counted rather than named.
### RETRO-1786867677764 (2026-08-16) — the rate-limit floor, the sweep transport & the identity seam: W1-T502–T531 + T901/T903 (30 tasks / 30 PRs)

★ 31 runs, all `implement`/`src`. **$198.797** ($6.413/run; per shipped task **$6.63, a FLOOR** and
not comparable to any other cycle's figure). Peak credited run **W1-T504 $26.380**. **The gather
credited 14 of these 30; the other 16 were recovered BY HAND** with `gh pr list --state merged` at the
marker plus `gh pr view` per PR — the first section in this log to carry ships the instrument never
named. **TURNS: 4 of 14 credited lit (29%), dark set exactly the PRs merged before #1917.** Window
total 1147 turns. **1 rejected trailer (bookkeeping)**, **1 guard-fired isolation block** (W1-T519).
Mutation-gate lifetime **N=0, NO POSITIVE CONTROL**.
**★ FOLDED TO FAMILY LINES BY R21** — ids, PRs and load-bearing costs preserved; per-task prose gone.

- **★ LEDGER-CREDITED — 8 tasks, $75.707** (**W1-T504/#1869 *$26.380*, dearest credited** ·
  T514/#1889 · T516/#1890 · T517/#1898 · **T523/#1917 *$14.757/149t* — REST head-branch credit
  resolution, first lit turn column in the window** · T526/#1926 review dedup · **T529/#1933 — the
  `gh` pace FLOOR, shipped DARK** · T531/#1929 the Cloudflare Access JWT identity seam)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 6 tasks, $15.115** (W1-T502/#1856 · T503/#1863 ·
  T505/#1864 · T506/#1879 · T508/#1878 · T510/#1881)
- **★ MERGED, TRAILERED, AND NAMED NOWHERE IN THE GATHER — 16 tasks, recovered by hand.** T507/#1886 ·
  T509/#1870 · T511/#1887 · T512/#1872 · **T513/#1888 — branch names the task, body carries NO trailer
  (a P33 shape)** · T515/#1882 · T518/#1902 · T519/#1909 · T521/#1921 · T522/#1913 · T525/#1927 the
  metered `gh` seam · T527/#1919 · T528/#1931 · T530/#1934 · T901/#1936 · T903/#1940. **No costs or
  turns stated** — the ledger did not credit them and this retro will not impute what it cannot read
  (P48). Three (T509, T512, T515) ride round-number run ids; that explains neither the other thirteen
  nor R21's twelve.
- **UNCREDITED-RUN REMAINDER — 17 runs, $107.975**, carrying **792 of the window's 1147 turns**
  (`blocked_ci`×11, `incomplete`×2, `no_pr`×2, `blocked`×1, `blocked_isolation`×1 guard-fired). **At
  least 7 own one of the merges listed above**, which is why R20's apparent 1-in-13 `blocked_*` ratio
  was an artifact rather than a fold-line reading.

### RETRO-1786799102812 (2026-08-15) — write tiers, sweep integrity & the freshness family: W1-T404–T500 (25 tasks / 25 PRs)

★ 46 runs, all `implement`/`src`. Costs total **$288.330** ($6.268/run, **$11.53 per shipped task**),
peak **W1-T456 $19.453**. **12 of 25 LEDGER-CREDITED (48%)**; **13 gate-side**, of which ten ended
`blocked`/`blocked_ci` and three `incomplete`. **TURNS: 1 of 25 shipped runs lit (4%), 173 turns
total, avg 3.761 — the column is UNUSABLE and blacked out** (R21's FIRST FINDING). 19 rejected
trailers = **14 self-redispatch / 5 foreign-proper**, hand-split. **6 guard-fired containment blocks
on one host**, all re-dispatched successfully. Mutation-gate lifetime **N=0, NO POSITIVE CONTROL**.

**★ FOLDED TO FAMILY LINES BY R21** — ids, PRs and the load-bearing costs preserved; per-task prose
gone (git holds it).

- **★ LEDGER-CREDITED — 12 tasks, $89.985** (W1-T450/#1695 · T454/#1740 · T457/#1771 · T458/#1772 ·
  **T473/#1781 *$17.682*, dearest credited** · T476/#1782 · T474/#1791 · T482/#1808 · T487/#1815 ·
  **T495/#1835 — the read-sensitivity axis, DARK on arrival** · T497/#1842 · T498/#1843)
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 13 tasks, $101.058** (W1-T404/#1709 the write-tier
  split · T449/#1690 · T453/#1753 · **T456/#1766 *$19.453*, the window's peak run** · T461/#1773 ·
  T463/#1775 · T468/#1780 · T470/#1783 · T477/#1800 · T486/#1812 · T488/#1821 · T496/#1844 ·
  **T500/#1849 *$13.234/173t* — the ONLY run in this window with a lit turn column**)
- **★ MERGED ON `main`, CREDITED TO NO RUN — 2 PRs, NOT counted in the 25 above: W1-T481/#1797 and
  W1-T490/#1825**, trailered and merged, appearing in that gather only as rejected rows because every
  candidate run's head branch belongs to a run outside the window. R18-1's metric; TASK G's ground
  truth, and the ancestor of R21's twelve.
- **UNCREDITED REMAINDER — 21 runs, $97.287** (`blocked_containment`×6 guard-fired, `incomplete`×4,
  `blocked_ci`×4, `no_pr`×4, `blocked`×2, `already_satisfied`×1) — routed through the standing
  credit-artifact fold-line, never re-mined as classes.

### RETRO-1786578394991 (2026-08-12) — the GAP-FILL window: W1-T388–T410 (12 tasks / 12 PRs)

★ A GAP-FILL, NOT A DELTA: this window (34 runs) was re-derived from an all-time marker, sits BETWEEN
two already-logged cycles, and its dollars are not a trend point. **$175.550** ($5.163/run,
$14.63/shipped task), turns 12/12 lit (avg 99.706), peak W1-T406 $23.043/256t. **7 of 12
LEDGER-CREDITED**; the 5 gate-side merges are exactly the 5 `blocked_*` runs.

- **★ LEDGER-CREDITED — 7 tasks** (**W1-T393/#1521 *$7.091/103t*, the mutation-ratchet rung D-10,
  shipped with its `mutation.ratchet_verdict` emission call site UNWIRED — lifetime N=0 begins here**
  · T399/#1542 · T402/#1543 · T400/#1551 · T401/#1552 *$3.183*, the window's cheapest ship ·
  T407/#1584 · T408/#1588) → **$44.863**
- **★ GATE-SIDE MERGES THE W1-T51 UNION RESCUED — 5 tasks, ALL of them `blocked_*` in the ledger**
  (W1-T394/#1492 · T397/#1495 · T398/#1505 · **T406/#1559 *$23.043/256t*, the window's peak run** ·
  **T410/#1591, the PLAN-STATE TRUTH RUNG itself, which fired BLOCKING on R18's own entry**)
  → **$52.061**
- **UNCREDITED REMAINDER — 22 runs, $78.6** (`no_pr`×14, `incomplete`×6, `blocked`×2). Routed through
  the standing credit-artifact fold-line, never re-mined as classes.

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
46% dark (P40(i) RE-OPENED); first haiku row ever (W1-T426/#1621, $0.295/62t).**
**★ FOLDED TO FAMILY LINES BY R19** — ids/PRs preserved, per-arc prose gone.

- **★ THE BOARD & STATUS ARC — 9 tasks** (W1-T364/#1417 *$14.451*, the cost-ceiling write control ·
  T371/#1425 · T372/#1423 · T373/#1424 · T374/#1434 · T375/#1429 · T376/#1430 · T382/#1453 ·
  T414/#1604 · **T415/#1606, `deriveStatus` DEFERS on a truncated board fetch**) → **$66.6**
- **★ VERDICT & PROOF INTEGRITY — 6 tasks, the cycle's spine** (**W1-T379/#1436 `rmd ledger-grep`, a
  union that FAILS LOUD when no archive was read — P48(i) shipped as a verb** · T387/#1442 *$15.477,
  peak run* · **T409/#1597, the OFFLINE shipped/not-shipped contradiction refusal that BLOCKED R18** ·
  T416/#1607 · **T423/#1613, the golden-verdict fixture corpus** · T424/#1614) → **$52.3**
- **★ THE LEARNING LOOP — 5 tasks** (W1-T418/#1605 *$10.202/137t* · **T419/#1609, the citation loop —
  *the ship with no trailer*** · **T420/#1610, `learningDuplicateViolation` DARK by its own
  admission** · T422/#1612 · **T426/#1621, the first haiku-routed merge in this log**) → **$30.4**
- **LOCKS, DISK & THE PLAN RECORD — 7 tasks** (W1-T368/#1414 · T381/#1438 · T380/#1437 · T411/#1595 ·
  **T383/#1454, the drift-gated CAPABILITY SNAPSHOT generated into this very file** · **T413/#1602,
  P39's sanctioned no-op exit**) → **$32.0**

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

## Calibration (observed — through RETRO-1787578143187, 2026-08-24)

The empirical baseline **mounts.yaml (W1-T5, shipped #42; risk/class routing since W1-T167/#606)** and
Flight-control burn-rate signals (§4B Layer 1, BUILT — W1-T20/#132) key off.

**★ THE WHOLE `implement` ROW STILL PUBLISHES `UNMEASURED` AND THE MOUNT TABLE STAYS FROZEN** (R23-1's
sixth-strike consequence, now in its FOURTH cycle, because **TASK G has not shipped** and the freeze was
written against that condition and no other). **★ AND THIS CYCLE THE FREEZE IS TESTED FROM THE OTHER
SIDE.** Credit rose 45% → **55%**, the second-best reading in the series, and it landed inside the band
R26-3 registered — a HIT. **A HIT ON A BAND IS NOT A LICENCE TO RE-BASE:** the band's whole content is
that the series has no trend, so a reading inside it says the instrument is behaving, not that the audit
gap closed. **What actually decides the freeze is unchanged and is now measured precisely: 14 of 31
in-window ships are credited by nothing, and TEN of those fourteen are printed run-id-and-PR-URL in this
gather's own harvest.** The gather's raw row is printed below, unaltered, as the record of what the
instrument saw.

**★ CURRENT BASELINE — this cycle (RETRO-1787578143187, task range W1-T1252–W1-T2206). This is the row
W1-T5's mount table WOULD key off. The first table is the GATHER'S OWN OUTPUT, printed exactly as
produced; the second is the row as this plan PUBLISHES it after the pre-committed rules fire:**

*As the gather produced it:*

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | 52 | 17 | $3.951 | 3.212 | $205.468 |

*As published (and NO mount may be re-based on it — the table is FROZEN until TASK G ships):*

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | **UNMEASURED** (gather 52 · 23 of them guard-fired blocks on ONE host, i.e. one infrastructure event, not 23 task attempts) | **UNMEASURED** (ledger 17 · union 17 · hand-verified **31** in-window merges) | **UNMEASURED** ($3.951 over a population 44% of which never reached a task) | **UNMEASURED — 2% COVERAGE, ONE RUN** (167 turns on a single run divided across 52; all 17 credited merges print `0t`) | **UNMEASURED** ($205.468, of which $101.093 bought no credited ship) |

**BY TASK CLASS — the W1-T167 routing question (is the class-routed mount discount paying off?).
★ ONE ROW ONLY for a SEVENTEENTH cycle; the question stays UNDER-SAMPLED, never re-based. The T930/#2008
columns keep earning their keep — the gather stamps `⚠ 2% coverage — DO NOT USE` on its own per-merge
derivations and then publishes the SAME numerator unstamped one column to the left:**

| task_class | runs | merged | merge rate | avg $ | avg turns | total $ | output tokens | merge source | turns/merge | output tokens/merge |
|---|---|---|---|---|---|---|---|---|---|---|
| src | 52 | 17 | 33% ⚠ 55% against the 31 hand-verified in-window merges | $3.951 | 3.212 ⚠ 2% coverage — the SAME number the two right-hand columns are stamped on | $205.468 | 78996 ⚠ same 2% | shipped (n=17) | 9.824 ⚠ 2% coverage — DO NOT USE | 4646.824 ⚠ 2% coverage — DO NOT USE |

**BY MODEL CLASS — weekly-limit burn (W1-T250/#898; P34 clause (d): burn is share of the weekly LIMIT,
never imputed dollars — the dollar column is context only). ★ THE ROW IS CUT ON THREE POPULATIONS AT
ONCE. R26 proved it a cumulative accumulator (`169 + 31 = 200`, `$924.563 + $171.844 = $1096.407`) and
registered R26-2 to confirm it; the column then RESET, and does not close against the window either:**

| model | runs | turns this week | share of weekly burn | $ this week (context only) |
|---|---|---|---|---|
| sonnet | 29 ⚠ NOT the window (52) and NOT last cycle's accumulator (200) — a third population | 167 ⚠ **= 52 × 3.212 exactly**, i.e. the WINDOW's runs × its avg turns; `29 × 3.212 = 93`, which this is not | 100.0% ⚠ published UNSTAMPED over a denominator equal to its own numerator — the exact mirror of last cycle's `0.0%` | $80.341 ⚠ 39% of the window's $205.468, reconciling with neither the window nor the accumulator |

**Prior cycles (FOLDED — trend only; ledger-merged first, real ships in parentheses):** R26 31 / 14
(31) / $5.543 / 0t ⚠ · R25 41 / 21 (33) / $6.432 / 13t ⚠ · R24 54 / 10 (40) / $4.504 / 8.8t ⚠ ·
**R20–R23 FOLDED TO ONE LINE BY R27** (121 runs / 37 merged (122 ships), $5.423–$6.775/run, 35.3–71.1t
⚠ — the arm-integrity, pacer, board/status and write-tier arcs) · **R17–R19 FOLDED BY R26** (144 runs /
24 merged (64 ships), $3.502–$6.268/run, 3.8–99.7t) · **R11–R16 FOLDED BY R25** (366 runs / 76 merged
(216 ships), $3.812–$8.327/run, 7.8–116.2t) · **R8–R10 FOLDED BY R24** (248 runs / 21 merged (72
ships), $1.258–$10.650, 14.7–86.6t — R8 churn-poisoned by the W1-T1 spin loop and never to be re-based
on) · **R1–R7 FOLDED BY R15** (91 runs / 47 merged, $1.838–$5.794/run, 21.4–72.2t — pre-fleet).
*(⚠ = turn column dark or sub-5% covered, do not use.)* **Derived all-time:** ~978 runs, ~458 merged.

**Reads:**
- **★ COST PER SHIPPED TASK IS A BRACKET AGAIN, AND THE BRACKET IS THE HONEST OBJECT.** $205.468 over
  the 17 the ledger credits is **$12.086**; over the 27 in-window merges whose runs belong to this
  population it is **$7.610**. The four straddlers are excluded from BOTH, because their costs live in
  R26's total and restating them here would double-count (rule 7). **None of it may be compared to the
  series ($15.66 → $8.930 → $8.302 → $14.63 → $11.53 → $6.63 → $9.63/$5.90 → $9.04/$6.51/$5.25 →
  $11.61/$7.05/$6.58 → $8.39/$6.57/$6.08 → $9.77/$9.09/$8.79 → $6.874)** — no two of those denominators
  mean the same thing, which is why the bracket is published as a bracket whenever it can be.
- **★ THE TURN COLUMN IS BACK AT 2% COVERAGE, WHICH IS WORSE THAN 0% FOR EXACTLY ONE REASON: IT IS
  NON-ZERO, SO IT LOOKS USABLE.** Readings across eleven windows: 46% → 100% → 4% → 29% → 79% → 28% →
  47% → 11% → 19% → 0% → **2%**. The gather computes `avg turns 3.212` by dividing **167 turns from one
  run** across all 52, and stamps the derived per-merge columns `DO NOT USE` while leaving that average
  unstamped. **All 17 credited merges print `0t`**, so the entire turn mass belongs to runs that shipped
  nothing — which means the number cannot even be read as "what a shipping run costs in turns."
  **TASK D's question — *state the retention bound and divide by it* — is unanswered for a second
  consecutive cycle**, now for the opposite reason: not absence, but a denominator nobody named.
- **★ P40(ii): NEITHER A MISLABEL NOR A COINCIDENCE — AN INCOHERENCE.** R26 proved the `this week`
  column cumulative by two exact identities. It then RESET (200 → 29 runs; $1096.407 → $80.341), so
  R26-2 missed — and the re-cut row still does not close: `turns this week` = **52 × 3.212 = 167**, the
  WINDOW's runs × its avg turns, against a `runs` column of 29 and a `$` column holding 39% of the
  window's spend. **Three columns, three populations.** Re-registered as **R27-2** as a
  does-the-row-close INVARIANT. FIFTEENTH cycle unpaid on ratification telemetry (0 / 0 / 0%).
- **★ THE ROW PRINTS `UNMEASURED` AND THE HIT DOES NOT UNFREEZE IT.** 17 ledger credits, 17 in the
  union, **31** hand-verified in-window merges = **55%**, inside R26-3's registered 25–65% band. The
  freeze is conditioned on TASK G, not on a threshold, and **a band-HIT is evidence the series is
  noise — which is an argument for the freeze, not against it.** Re-registered unchanged as **R27-3**.
- **★ THE CLASS CONTRAST IS ABSENT FOR A SEVENTEENTH CYCLE.** 52 of 52 classed (P40(a) closed,
  sixteenth cycle), ALL `src`. Seventeen cycles, four contrast rows, none surviving to n=5 —
  **UNDER-SAMPLED, and the no-re-base rule is doing its job rather than failing to answer.**
- **★ MAST distribution (W1-T89/#710): infrastructure 23 (+23) · verification 11 (−4) · 1 run UNMAPPED
  (`blocked`×1) = 2% of 52, the best reading ever recorded.** The infrastructure column did not
  deteriorate by 23 events — **it recorded ONE host storm 23 times**, which is design rule 8's whole
  point, and the correct reading of a `+23` swing beside a `−4` is a POPULATION change, not a mapping
  change. **`blocked`×1 remains the only unmapped class**, named rather than guessed.
- **★ GUARD-FIRED BLOCKS: 23, AND FOR THE FIRST TIME THEY SAY WHAT THEY SAW.** 12 `unproven`,
  4 `probe-never-ran`, 7 `write-never-attempted` — and the split is CHRONOLOGICAL around #2685's merge,
  not random (THE SECOND FINDING). **P41's retirement bar is still written in a value no code path
  emits** (`observed: proven`), which is P50(iv) unchanged; **but 11 of 23 blocks now say the probe
  produced NO observation at all**, which is P52's ground truth and a different question entirely.
- **The $100 `budget_usd` tripwire: 0/17 CREDITED runs trip it**, peak $12.059 — **and the other 35
  runs' costs are printed nowhere**, so this is a claim about a third of the population, stated as such
  rather than as a clean seventeenth cycle.
- **A retro must not average over a spin loop** (R8's lesson); **nor over a window whose merge set it
  has not verified** (R20's inverse); **nor over a window whose own gather contradicts itself between
  sections** (R21's); **nor over a run set whose SIZE it has not verified** (R22's); **nor over a window
  whose BOUNDARY CLOCK is unstated** (R23's); **nor over a population a third of which is one
  infrastructure event wearing three labels** (R24's); **nor over a population that EXCLUDES three of
  its own window's ships** (R25's); **nor over a population MISSING THIRTEEN of its own merges**
  (R26's); **and R27 adds the one that costs the most money: nor over a population 44% of which never
  reached a task at all — 23 of 52 runs were guard-fired blocks on one host, and $101.093 of $205.468
  bought no credited ship.** **P29(iii)** (annotate credit-rejected runs before they reach the mount
  table) is still unbuilt and is still the cheapest correction available here.

## Retro proposals (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)

**★ LIVE RANKING (the ONE place open proposals are ordered).** `P47 > P40 > P43 > P48 > P50 > P52 >
P38 > P49 > P33 > P51 > P42 > P46 > P39 > P45 > P44 > P26` *(P52's rank and P51's PARK are PROPOSED by
their entries below, pending ratification)*. **P17 LEFT THE RANKING 2026-08-20 — W1-T71 SHIPPED
(#2182)**. **P29 LEFT THE RANKING 2026-08-07** — both clauses shipped in #349; the tombstone below keeps
only the durable lessons. Every proposal has exactly ONE canonical entry below, updated IN PLACE with
each cycle's evidence — a retro that adds a second entry restating a proposal it did not change has
failed the HARNESS-COMPRESSION bar. **P28 and P41 are RETIRED** (tombstones only, full prose deleted);
**P29 is CLOSED — shipped, not abandoned**; **P35 is FOLDED into P38**.
**★ R27 MINTS ONE, PARKS ONE, AND CLOSES A CLAUSE BY SHIPPING.** **ONE NEW PROPOSAL: P52 (THE GUARD
THAT BLOCKED ON ITS OWN NON-EXECUTION)** — the highest existing header was **P51**, so the next unused
id is **P52** and that is what is taken. **The test for whether it needed its own id, stated rather than
asserted:** P50/TASK M owns *which state fired and in what words the re-arm bar is written* — a NAMING
proposal, and its clause (i) just shipped; P30/TASK I owns *which CHECK blocked*, on the CI side, not
the guard side; P44 owns *a tripwire that anchors instead of measuring*. **None of them owns what the
harness should DO when the guard's own observation is missing** — `probe-never-ran` and
`write-never-attempted` are not verdicts about the sandbox, they are reports that no measurement
happened, and they consumed 11 full dispatches this cycle. That is a distinct mechanism and takes a
distinct id. **NO NEW TASK LETTER** — A–M stand, the next unused is N; P52's instrument is a re-arm rule
on TASK M's own row rather than a fourteenth letter, because minting a letter per proposal is P8's
accretion failure mode. **THE PARK: P51 ↓ to rank 10** on R26-1's own falsifier (zero absent runs), and
**NO PROMOTION IS ARGUED FROM A LEVEL THIS CYCLE** — the numbers that moved (credit 45→55%, straddler
depth 29.4→3.6 h) are inside registered bands and P43(ii) forbids reading them as movement.
Everything else lands as EVIDENCE IN PLACE: **ten printed-but-uncredited merges promote design rule 5
from curiosity to the largest credit-loss class and give TASK G its best ground truth**; **TASK M(i)
CLOSES BY SHIPPING (T1281/#2685) with a before/after boundary inside one gather**; **the weekly row's
three populations upgrade P40(ii) from mislabel to incoherence**; **R26-4's safe-direction miss is
refused as a scope reduction and written up as design rule 11**; and the byte-identical two-id
plan-health remainder is **BATCH J**, unmoved for a FIFTH cycle.

**★ THE STANDING CREDIT-ARTIFACT FOLD-LINE (one home, replacing five cycles of per-cycle
restatements).** In every retro from R8 on, the dominant "failure" verdict classes — `blocked`,
`blocked_ci`, `no_pr`, `incomplete`, `pr_attribution_failed` — have been predominantly WRITE-SIDE
CREDIT ARTIFACTS, not task defects: the work merged gate-side and the ledger did not record it.
R8 0-of-28 credited · R9 13/21 · R10 8/23 · R11 20/94 · R12 4/25 · R13 16/25 · R14 10/25 ·
R15 14/25 · R16 12/25 · R17 5/27 · R18 7/12 · R19 12/25 · R20 8/30 · R21 9/31 (19 by union) ·
R22 10/31 (18 by union) · R23 10/30 (17 by union) · R24 10/40 (29 by union) ·
R25 21/33 (27 by union) · R26 14/31 (25 by union) · **R27 17/31 (17 by union — the union
rescued NOTHING for the first time, because every uncredited merge this cycle is recoverable by a JOIN
the ledger cannot do rather than by a second source)** — each row is the GATHER's credit count against
the window's REAL ship count. They are therefore NEVER re-mined as classes — doing so manufactures many
proposals from one root cause, the accretion failure mode P8 named. They route to
**P29/P30/P33/P39/P47** and, for the reading defect, **P38**. A future retro adds evidence to THIS line,
never a new bullet. *(The series spans FOURTEEN cycles and ranges 0%–64% with no monotone trend — a
NOISE BAND, not a trajectory. That is P43(ii), and it is why R14 refused to call 40% a regression, R15
refused to call 56% a fix, R25 refused to call 64% a victory, R26 refused to call 45% a regression —
**and R27, whose 55% HIT the band R26 registered, refuses to call the HIT an improvement.**)*
  **★ MEASURED READINGS: R18 5 of 7 = 71% · R19 10 of 16 = 63% (HIT) · R20 UNMEASURED (bounded to
  23%–62%) · R21 8 of 15 = 53% · R22 8 of 20 = 40% · R24 19 of 44 = 43% (61% excluding its containment
  storm) · R25 10 of 20 = 50% · R26 11 of 17 = 65% · R27 UNCOMPUTABLE**, all FLOORS. **★ R27 DECLINES
  TO PUBLISH A READING, AND THE REASON IS RULE 8.** 23 of this cycle's 35 non-merged verdicts are ONE
  host storm; 18 of those 23 rows belong to tasks that merged in the same window, which would read as a
  spectacular 78% — **and would be 18 readings of a single event.** The other 12 (`blocked_ci`×11,
  `blocked`×1) are not task-named by the gather at all, so no honest denominator exists. **The line stays
  CONFIRMED at ≥43% on prior cycles and takes no reading from this one** (P48: an uncomputable value is
  stated, never estimated). The instruments that would make it exact remain TASK G (print the orphan
  merges), TASK H (print the per-run verdict row) and TASK K (verify the denominator).
  **★ THE STANDING BOUND ON VIVID DEFECTS (2026-08-07, kept because the temptation recurs; R20's
  per-cycle restatement of it FOLDED IN by R24).** The uncreditable-branch defect W1-T390 files is RARE
  AND CLUSTERED, not ambient — 2 slug-form branches among 37 merged `run-*` over #1341–#1451 — so **no
  retro may cite it as this band's cause**: two PRs cannot account for twelve cycles of spread, which is
  exactly the unattributed-cause error P43(ii) forbids. What earns that task is the FAILURE MODE (credit
  lost PERMANENTLY, no self-correcting path), not the frequency. **Every large lost-merge count since
  (R20's sixteen, R23's eleven, R24's eight) rides WELL-FORMED `run-<task>-<ts>` branches**, so none of
  them is W1-T390's slug-form defect wearing a bigger number; they are separate mechanisms sharing the
  same failure MODE, and citing any of them as evidence for W1-T390's FREQUENCY is the error this bound
  exists to forbid.

**RETRO-1787578143187 (R27, this cycle)** — mined from 52 runs in scope / **31 merged `run-W1-*` PRs
IN-WINDOW, ALL code, hand-verified over REST — 17 credited by the ledger AND the union, 10
printed-but-uncredited, 4 straddlers** (`blocked_containment`×22, `blocked_ci`×11,
`blocked_isolation`×1, `blocked`×1; **23 of those 35 are guard-fired blocks on ONE host**).
**ONE new P-number: P52 — the highest existing header was P51 and the next unused id is P52, taken.**
**ZERO new task letters — A–M stand and the next unused is N.** **STANDING: candidates are ratified by
the Architect via a tasks.yaml PR — rule 15, never auto-filed.**

- **FAILURE MINING — 44% OF THE CYCLE'S RUNS NEVER REACHED A TASK, AND THE CLASSES ARE STILL NOT
  RE-MINED AS CLASSES** (fold-line above). 23 guard-fired blocks — **22 `containment/outside-cwd-denial`
  across TWELVE tasks plus 1 `isolation/inherited-functions`** — which the gather itself labels **a HOST
  signal, not a task signal**, and which design rule 8 counts ONCE. What can still be said, and only
  this: **`blocked_ci`×11 is 92% of the non-guard mass and still records the WORD with no check name
  anywhere** (**TASK I**, unchanged in kind for thirteen cycles); the storm cost **$101.093 of the
  window's $205.468 across 35 uncredited runs**, none of whose individual costs the gather prints; and
  **W1-T1279 burned FIVE consecutive dispatches and W1-T2201 FOUR** without either task's block ever
  producing an observation. **One proposal IS minted off this distribution, and only one** — see P52.
- **★ THE PRINTED-BUT-UNCREDITED CLASS, ROUTED TO TASK G (P47) — NOT MINTED.** Ten CODE ships (#2639,
  #2657, #2668, #2672, #2677, #2679, #2684, #2687, #2695, #2702) carry their run id and their merged PR
  URL **on one line of this gather's own harvest** while no credit section names either. **The evidence
  is promoted, not the id** (P8's accretion rule): this is design rule 5's exact shape, TASK G's exact
  instrument, and it went from n=1 to n=10 in one window. Registered as **R27-1**, on the class rather
  than on the count.
- **★ THE ABSENT-RUN CLASS IS EMPTY, AND P51 IS PARKED BY ITS OWN FALSIFIER.** R26 minted P51 on five
  merges whose runs its gather never named and registered **R26-1** to earn it. **Observed ZERO this
  cycle**: all 31 in-window merges resolve to a credited row, a harvest line, or a straddler. The
  falsifier's pre-committed meaning — *"the five were a one-off of a re-dispatch storm, and P51 is
  over-priced"* — is honoured: **P51 drops to rank 10 and is PARKED, not deleted.** This is the second
  time this file has retired one of its own findings on a pre-committed test, and the first time it has
  done so to a proposal it minted the cycle before.
- **★ TASK M(i) CLOSES BY SHIPPING — THE FIRST CLAUSE THIS FILE HAS CLOSED ON EVIDENCE FROM THE WINDOW
  THAT BUILT IT.** T1281/#2685 made the guard NAME its `observed` state; the gather's 23 rows split
  cleanly at that merge (12 `unproven` before, 4 `probe-never-ran` + 7 `write-never-attempted` after,
  no overlap either way). **(ii)–(iv) stand** — the recurrence-trend line still prints `22x` with no
  state breakdown beside the count, and P41's bar is still written in `observed: proven`, a value no
  code path emits.
- **PLAN-HEALTH CORRECTIVES — PROPOSED, NOT FILED (rule 15), AND UNCHANGED FOR A FIFTH CYCLE.** The
  sweep again returns exactly two ids, byte-identical to R23's through R26's: **W3-T3** and **W1-T49**,
  both OPEN, both declaring no `files:` scope, both therefore fail-closed against every co-dispatched
  candidate at `overlappingPaths`. The sweep proposes two corrective tasks (*fix W3-T3 —
  declared-scope*, *fix W1-T49 — declared-scope*, origin `retro#plan-health`); this plan continues to
  decline them as two shards and to carry them as **BATCH J**. **★ FIVE cycles of the most expensive
  attention in this system have now been spent re-deriving a two-line edit.**
- **PROCEDURAL-SUCCESS MINING (P13) — one shape from SEVENTEEN runs (`implement ×
  [clean_single_strike, fully_executed_proof]` — literally every merged run in the cycle) into a corpus
  that added ZERO, for a FIFTH consecutive cycle.** Routed to **P38** as evidence in place. **★ BUT THE
  PROMOTION PASS ITSELF RAN, FOR THE FIRST TIME:** W1-T1249/#2612 supplied the bounded judge, and the
  gather now prints ONE promotion PROPOSED (`bashrc-accident → user-overall`, 0.8) and THREE DECLINED
  under three distinct named reasons. **The instrument is lit; the corpus is still frozen at 79.** The
  promotion is a proposal, ratified only by landing it at its named layer in a reviewed `learnings/` PR
  — which a plan-only retro may not write. Recorded, not filed.

**RETRO-1787502627029 (R26) — MINING BLOCK FOLDED TO THREE LINES BY R27** (31 runs / 38 merged task PRs,
ledger 14 / union 25; `blocked_ci`×15, `blocked`×1, `failed`×1, 2 rejected trailers, 0 foreign). It
minted **P51** on five absent-run merges, re-scoped **TASK L** to an open reconciliation on a 29-hour
straddler band, withdrew R25's resolver miss-target re-scope, and promoted **P43** to rank 3.
**R27 re-adjudicated two of those on R26's own pre-registered tests: P51's class came back EMPTY and is
PARKED, and TASK L's band came back at 3.6 h — which R27 refuses to shrink L on (design rule 11).**
Its per-cycle failure/plan-health/procedural bullets are superseded by R27's block above.

**RETRO-1787419805720 (R25) — MINING BLOCK FOLDED TO THREE LINES BY R26** (41 runs / 33 merged task
PRs, ledger 21 / union 27; `blocked_ci`×11, `blocked`×4, `blocked_isolation`×2, `no_pr`×2,
`incomplete`×1, 5 rejected trailers, 0 foreign). It minted nothing, re-ranked P50 once, and routed its
two findings to **TASK L** and **TASK G(ii)** — **both of which R26 re-adjudicated on R25's own
pre-registered tests: L's evidence is superseded in place (n=7, 29 h) and G(ii)'s re-scope is
WITHDRAWN.** Its per-cycle failure/plan-health/procedural bullets are superseded by R26's block above.

**RETRO-1787290856852 (R24) — HEADER AND FAILURE-MINING FOLDED TO TWO LINES BY R26** (54 runs / 40
merged task PRs, 29 named / 10 ledger credits / 22 rejected trailers, 0 foreign; **13 of its 44
non-merged verdicts were ONE 41-minute host outage** wearing three labels, which minted design rule 8
and **P50**/**TASK M**; no proposal was minted off its distribution). Its canonical TASK entries follow
and are maintained IN PLACE, not per-cycle.

- **★ TASK M (P50 — SAY WHICH OF THE FOUR `observed` STATES FIRED, AND WRITE THE RE-ARM BAR IN THOSE
  WORDS; R24's mint). ★★ CLAUSE (i) IS CLOSED BY SHIPPING — W1-T1281/#2685, 2026-08-24.** GROUND TRUTH
  AS FILED (read at `src/lib/containment.ts:505-557`): a failed containment preflight throws one of four
  `ContainmentError` shapes, and R24's gather printed 13 blocks that ALL read
  `observed: unproven` — the state that proves nothing, because the outside write did not land and no OS
  denial was seen, so the run was fail-closed on ambiguity exactly as Standing rule 11 requires.
  **(i) NAME THE STATE — SHIPPED AND OBSERVED WORKING.** #2685 made the guard name what it saw; R27's
  gather splits 23 rows cleanly at that merge: **12 `unproven` before it, 4 `probe-never-ran` + 7
  `write-never-attempted` after, with no overlap in either direction.** This is the first proposal clause
  in this file closed on evidence from the same window that built it.
  **(ii) STILL OPEN:** the gather's recurrence-trend line reports `containment/outside-cwd-denial: 22x
  across 12 tasks` with **no state breakdown beside the count** — *22 `unproven` on one host* and *22
  `proven_broken` on one host* remain opposite emergencies wearing one number.
  **(iii) STILL OPEN:** every kill/re-arm/retirement trigger in this file must be restated in emittable
  values, and **P41's bar becomes: `≥2 firings in one window whose `observed` is `proven_broken`, OR ≥10
  firings of any state on a single host — the latter re-arms as an INFRASTRUCTURE question, not a
  security one`**. R27 would have fired that second arm at 22. **(iv) STILL OPEN:** a trigger whose
  satisfying value no instrument emits is itself a lint failure at mint time (see P50); `observed:
  proven` is still that value. GOLDEN (fixture-only): a seeded run whose probe writes outside cwd
  successfully ledgers `proven_broken` and re-arms; a seeded run whose probe neither writes nor denies
  ledgers `unproven` and does NOT; ten seeded blocks of any state on one host id raise the
  infrastructure arm exactly once, never ten times. **Registered as R27-4 as a REGRESSION TEST on the
  shipped half, which is the shape rule 1 has been asking for since R16.**
- **★ P52 (NEW THIS CYCLE — THE GUARD THAT BLOCKED ON ITS OWN NON-EXECUTION: A BLOCK WITH NO OBSERVATION
  IS A RETRY, NOT A VERDICT). PROPOSED RANK 6.** GROUND TRUTH (this cycle's gather, readable only
  BECAUSE T1281/#2685 shipped): of 23 guard-fired blocks, **11 carry a state that reports NO measurement
  at all** — `probe-never-ran` ×4 and `write-never-attempted` ×7 — against 12 `unproven`, which at least
  means *a probe ran and was inconclusive*. **Each of the 11 consumed a full dispatch**, and two tasks
  burned consecutive runs on nothing: **W1-T1279 five times** (`…543095634` unproven, then
  `…547955020` probe-never-ran, then `…558482273`/`…561517358`/`…564121957` write-never-attempted) and
  **W1-T2201 four times** (`…547998969` probe-never-ran, then three write-never-attempted) — **and
  W1-T2201 shipped #2695 anyway**, so the fleet paid four blocked dispatches for a task that was
  perfectly capable of merging. Total unrecovered spend across all 35 uncredited runs: **$101.093 of
  $205.468**. **WHY THIS IS NOT AN EXISTING PROPOSAL, stated as a test:** P50/TASK M owns *which state
  fired and how the re-arm bar is worded* — a naming proposal whose naming clause just shipped, and
  which is silent on what to DO with a named state; P30/TASK I owns *which CHECK blocked*, on the CI
  side; P44 owns *a tripwire that anchors rather than measures*. **None owns the fail-closed policy for
  a guard whose own observation is missing.** Standing rule 11 correctly says an unproven sandbox must
  fail closed — **but `probe-never-ran` is not an unproven sandbox, it is an unrun probe**, and treating
  a missing measurement as a security verdict is how a host defect becomes a task defect in every
  downstream instrument. PROPOSE: **(i)** the containment preflight distinguishes *the probe ran and was
  inconclusive* (`unproven` — fail closed, as today) from *the probe did not run* (`probe-never-ran`,
  `write-never-attempted` — **RETRY the probe, bounded, before spending the dispatch**); **(ii)** a
  no-observation block that recurs on one host N times within a window raises TASK M(iii)'s
  INFRASTRUCTURE arm ONCE and **stops dispatching that host** rather than re-blocking task after task;
  **(iii)** the run that a no-observation block kills is re-queued rather than counted as an attempt, so
  a host defect never consumes a task's strike budget; **(iv)** the ledger row records the retry count
  beside the state, so the next retro can price the difference between *the guard worked* and *the guard
  never looked*. GOLDEN (fixture-only): a seeded `probe-never-ran` retries the probe and, on a
  successful second probe, dispatches normally with the retry recorded; a seeded `unproven` never
  retries and fails closed exactly as today; N seeded no-observation blocks on one host id stop that
  host and raise exactly one infrastructure escalation; a task whose only blocks were no-observation
  blocks shows **zero** consumed strikes.
- **★ P51 (R26's mint — THE ABSENT RUN: A MERGE ON A WELL-FORMED RUN BRANCH WHOSE RUN THE LEDGER HAS NO
  ROW FOR). ★★ PARKED AT RANK 10 BY ITS OWN FALSIFIER, 2026-08-24 — kept, not deleted, because a
  mechanism observed once is a record and only a ranking is a claim.** GROUND TRUTH AS MINTED
  (hand-verified over REST, 2026-08-23): five CODE PRs merged on canonical `run-W1-<task>-<ts>` branches
  — **#2526, #2529, #2532, #2602, #2604** — with in-window run-start timestamps and **not one of those
  run ids anywhere in R26's gather**. R26 registered **R26-1** (*≥1 again, and not confined to
  `…000`-suffixed ids*) precisely to earn the mint. **R27 observed ZERO: all 31 in-window merges resolve
  to a credited row, a harvest line or a straddler.** The falsifier's pre-committed meaning was *"the
  five were a one-off of a re-dispatch storm, and P51 is over-priced"*, and this entry honours it rather
  than re-arguing it. **WHAT SURVIVES:** the +5 already added to P33's quarantine list stands (credit
  lost with no run row is unrecoverable by any join, whatever its frequency), and P51's proposed
  instrument — **the gather printing `ABSENT RUNS — n:` as a set difference over lists it already
  builds** — is folded into **TASK G**, which needs the same enumeration for the ten
  printed-but-uncredited merges and which R27-1 now tracks. **WHAT WOULD UN-PARK IT:** any future cycle
  observing ≥1 merged run-branch PR whose run id appears in NO section of that cycle's gather; if that
  happens twice, the class is real and P51 returns on its own evidence rather than on R26's.
- **★ TASK L (P47 — SWEEP THE STRADDLERS: A RUN IN FLIGHT ACROSS THE MARKER BELONGS TO NO CYCLE;
  proposed by R23, UNBUILT). ★★ R27 EVIDENCE, IN PLACE: THE STRADDLER IS REAL IN EVERY CYCLE THAT HAS
  LOOKED, THE DEPTH VARIES BY A FACTOR OF EIGHT, AND L IS SIZED ON THE MAXIMUM — NOT THE LATEST.**
  R23 filed L on a hand-derived pair; R24 looked and found none (*"a quiet seam is not a checked one"*);
  R25 found **3** inside 3.4 h and called L a bounded lookback; R26 found **7** across **29.4 h** and
  called it an open reconciliation; **R27 finds 4 within 3.64 h** — **W1-T1253/#2605 (−3.64 h),
  W1-T1249/#2612 (−2.82 h), W1-T1251/#2611 (−2.81 h), W1-T1265/#2626 (−0.26 h)**, against marker epoch
  `1787504010413`, all CODE, **13% of the window's merge set.** R26-4's falsifier therefore fired in the
  SAFE direction, and **this entry declines the pre-committed shrink** on the ground now written as
  **design rule 11**: a 6-hour lookback fitted to this reading would have missed FOUR of last cycle's
  seven. **L stays an OPEN RECONCILIATION over the merge set**, and clause (i) may not be implemented
  with a constant. **★ THE STING THAT MAKES L WORTH ITS RANK: #2612 — the PR that supplied the bounded
  promotion judge, ending a six-cycle dark instrument — IS ONE OF THIS CYCLE'S STRADDLERS**, credited to
  no cycle by any instrument, exactly as W1-T71/#2182 (P17's ratified receipts task, still uncredited in
  six syncs after it had merged) was the filing evidence. **WHY THIS IS NOT AN EXISTING NUMBER:** TASK G
  emits merges no RUN owns, TASK H emits runs that own no MERGE, TASK K asks whether the run set is
  COMPLETE — all three operate INSIDE one window; L is the only one that looks ACROSS the seam, and no
  amount of in-window verification can see a straddler. PROPOSE: **(i)** the gather computes, from
  GitHub, merged `run-*` PRs in `[previous marker, this marker]` whose run id predates the window they
  merged in, and prints them as `STRADDLERS — n: <task/pr>` rather than dropping them; **(ii)** the
  gather STATES which clock the window is cut on in one line (`window: run-start [t0,t1)` vs
  `merge-time`); **(iii)** a straddler is credited to the cycle in which it MERGED — one rule, stated,
  never both. GOLDEN (fixture-only): a seeded pair of windows where run R starts before t0 and merges
  after it prints R exactly once, in the later window, never in both; a run starting and merging inside
  one window produces no straddler line; a window with no straddlers prints `none (0)`, never an empty
  section.
- **★ TASK K (P40 — COUNT THE RUNS BEFORE AVERAGING OVER THEM; proposed by R22, UNBUILT). ★★ R27
  EVIDENCE, IN PLACE: K's POPULATION IS EMPTY FOR A SECOND CYCLE, AND K's VALUE IS NOW ENTIRELY THE
  DISCRIMINATOR.** R22 proved the run set short by counting; R23 showed the verdict column could not
  close; R24 named three tasks with no run in scope; R25 found one; R26 found twelve merges with no
  scoped run and had to SPLIT them (7 straddlers, 5 absent runs) to stay honest. **R27's fourteen
  uncredited merges split cleanly too — 10 printed-but-uncredited (TASK G) and 4 straddlers (TASK L) —
  and K's own population, *a run that ran in-window and the gather under-counted*, is EMPTY again.**
  That is a real reading, not a null one. **The rule that separates the classes, which is the part of K
  worth building:** *if the missing run's id predates the marker it is L's; if the gather prints the run
  id anywhere it is G's; if no ledger row exists for it in any cycle it is P51's; otherwise it is K's.*
  A retro reading only the in-window view mis-files all four as one "uncredited" mass, which is what
  every cycle before R25 did. GROUND TRUTH AS FILED (hand-verified, design rules 4/6): **31 distinct
  `run-W1-*` branches merged a PR in R22's window and every one of their run ids postdates that marker,
  while the gather reported `Runs in scope: 30`.** By pigeonhole at least one in-window run that merged
  a PR was absent from the population behind `avg $`, `avg turns` and `total $`. PROPOSE: **(i)** the
  gather derives, from GitHub, the set of `run-*` branches with a merged PR in the window and prints any
  whose run id it did not scope, as `RUNS NOT IN SCOPE THAT MERGED — n: <ids>`; **(ii)** when that list
  is non-empty the `runs` column is annotated `⚠ short by ≥n`, never silently averaged (**P48(ii)**);
  **(iii)** the check states its own reach — it can only see runs that MERGED something, so a scoped-out
  run that shipped nothing stays invisible and the line says so rather than implying completeness.
  GOLDEN (fixture-only): a seeded window whose ledger holds 3 runs while GitHub shows 4 merged `run-*`
  branches prints `RUNS NOT IN SCOPE THAT MERGED — 1: run-X-…` and stamps the `runs` column; a window
  where the sets agree prints `none (0)`, never an empty section; a merged branch that is not
  `run-*`-shaped is ignored without comment.
- **R23's AND R24's per-cycle bullets are FOLDED (R24, extended by R27)** — their failure mining,
  procedural-success bullets and plan-health roster notes are superseded by this cycle's block. R24's
  procedural bullet is DELETED rather than kept: its content (*ten shapes offered, zero consumed*) is
  now the standing P38 evidence line, and **its "dead with a caller" finding is SUPERSEDED BY SHIPPING**
  — W1-T1249/#2612 supplied the missing judge and the pass ran this cycle. **TASK L and TASK K survive
  as live proposals and are retained above with their filing evidence intact.**

**RETRO-1786867677764 (R20, prior cycle)** — mined from 31 runs / **30 merged task PRs, of which
the gather names 14** / 8 ledger credits (`blocked_ci`×12, `incomplete`×4,
`pr_attribution_failed`×3, `no_pr`×2, `blocked`×1, `blocked_isolation`×1, plus **exactly 1 rejected
trailer, which is bookkeeping — while SIXTEEN merges were lost without producing a rejection at all**).
**ZERO new P-numbers.** **THREE items proposed: TASK H (P40), TASK I (P30) and BATCH J
(plan-health) — and R19's TASK G, unbuilt, promoted to the top of the dispatch order.**

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

- **★ TASK I (P30 — NAME THE CHECK THAT BLOCKED, ONCE, AT BLOCK TIME; NEW THIS CYCLE).** GROUND TRUTH:
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

**RETRO-1786799102812 (R19, prior cycle)** — mined from 46 runs / 25 shipped tasks / 25 merged PRs / 12
ledger credits (`blocked_ci`×12, `incomplete`×7, `blocked_containment`×6, `blocked`×4, `no_pr`×4,
`already_satisfied`×1, plus **19 rejected trailers the gather labels FOREIGN, of which 14 are the
task's OWN later run and 3 of those cost the task its credit outright**). **ZERO new P-numbers are
mined.** The failure classes are NOT re-mined as classes: 10 of 16 `blocked_*` runs demonstrably
merged, and the refusal is now PRE-REGISTERED-confirmed rather than argued (fold-line above).
**ONE new TASK is proposed (G), under P47.** **STANDING: candidates are ratified by the Architect via
a tasks.yaml PR — rule 15, never auto-filed.**

- **★ TASK G (P47 — EMIT THE ORPHANS: A MERGED TRAILER NO RUN OWNS MUST BE PRINTED, NOT DROPPED;
  proposed by R19, UNBUILT, and the top dispatchable item in this file for a SEVENTH cycle).
  **★★ R27: G HAS ITS BEST GROUND TRUTH EVER, AND IT IS NOT A RESOLVER BUG — IT IS AN UNATTEMPTED
  JOIN, TEN TIMES OVER.** R25's proposed clause (v) was WITHDRAWN by R26 on its own falsifier (0 of 2)
  and G stands as filed. **What earns G rank 1 now is arithmetic:** of 31 hand-verified in-window merges,
  **TEN carry their run id AND their merged PR URL on ONE line of the gather's own follow-up-harvest
  section while no credit section names either** — #2639, #2657, #2668, #2672, #2677, #2679, #2684,
  #2687, #2695, #2702 — after **n=1 (#2599) last cycle**. **There is no resolver rule to fix: the join
  is not wrong, it is not attempted.** G's clause (i) catches all ten, and the instrument is a set
  difference over two lists the gather already builds, already prints, and already holds in memory at
  the same moment. **P51's proposed enumeration is folded in here** (see P51, PARKED): the same pass
  that prints uncredited merges also states which side is missing — *no ledger row* versus *run row
  present, credit not joined* — so the two populations never merge into one undifferentiated count.
  Registered as **R27-1**.
  **R24's clause (iv) STANDS UNCHANGED** — the section must state which surface it reads
  the trailer from, because T1085/#2357 merged with its trailer in the COMMIT MESSAGE and nowhere in
  the PR BODY (T1012/#2240's shape), and a body-only reader loses it. R23-1 and R23-2 remain RETIRED
  into standing defect notes under this task. GROUND TRUTH AS
  FILED (mechanical, from R19's gather's own discrepancy list): **W1-T481/#1797
  and W1-T490/#1825 are merged on `main` with task trailers, and every candidate run for each is
  REJECTED** — the head branches (`run-W1-T481-1786712474000`, `run-W1-T490-1786724693000`) belong to
  runs outside the window, so the ownership-assert refuses all of them and **no line anywhere credits
  the merge**. The gather computes every input to the answer and prints only the refusals. Contrast
  the eleven benign cases (T404, T453, T456, T477, T496, T497, T498): identical rejection text, but a
  sibling run IS credited, so nothing is lost. **WHY THIS IS NOT A NEW P-NUMBER:** it is P47's counter
  again (with **P33**'s permanence attached — an uncredited merge never self-corrects) and it is the
  buildable residue of R18-1. **WHY IT IS SEPARATE FROM TASK F:** F re-labels rejections; **G adds an
  output that does not exist today**, and it would have changed this retro's own SHIPPED log.
  PROPOSE: **(i)** after resolution, the gather emits an
  **`UNCREDITED MERGES`** section listing every merged PR bearing a `Remudero-Task` trailer for which
  no run in the window was credited — id, PR, head branch, and the reason each candidate was refused;
  **(ii)** the section prints **`none (N merged trailers, all credited)` with N**, never an empty
  heading and never silence (**P48(ii)**); **(iii)** the count is stated in the same breath as
  `Merged since marker`, so a retro cannot record a SHIPPED log without seeing what it omitted.
  GOLDEN (fixture-only, no live dep): a seeded merged PR whose trailer names task X while its head
  branch belongs to an out-of-window run of X renders one `UNCREDITED MERGES` row naming X, the PR and
  the refusal reason; the same fixture WITH a credited sibling run renders **zero** rows and the
  `none (N …)` line; a fixture with no trailered merges renders `none (0 …)`, not an empty section;
  and **the R19 window itself, replayed, renders exactly two rows (W1-T481, W1-T490)** — the assertion
  that would have failed on this very gather.
  **★ R20 EVIDENCE, ADDED IN PLACE — TASK G IS NOW THE TOP DISPATCHABLE ITEM IN THIS FILE.** R19
  argued this task on **two** lost merges. R20 measured **SIXTEEN in a single window** (roster and
  `gh` provenance in R20's NET STATE FIRST FINDING), fifteen of them carrying well-formed trailers on
  their own run branches — so the defect is not the exotic out-of-window-owner case R19 described but
  something broad enough to drop **53% of a window's ships**. Two amendments to the spec follow from
  the measurement, and neither was derivable a cycle ago: **(iv)** the section must be computed from
  the MERGE SET (every in-window merged PR on a `run-*` branch), not from the rejected-candidate list
  — this cycle's sixteen produced no rejection rows at all, so a resolver-refusal-driven design would
  have printed nothing; **(v)** the golden gains the R20 window replayed, asserting **16 rows**, and
  T513/#1888 (branch names the task, body carries no trailer) must appear as its own labelled shape
  rather than being dropped for lacking a trailer.
  **★ R21 EVIDENCE, ADDED IN PLACE — THE CHEAPEST ARM OF THIS TASK IS A JOIN OVER STRINGS THE GATHER
  ALREADY PRINTS.** R21 measured **12 uncredited merges of 31**, and **five of them (#2019, #2024,
  #2027, #2030, #2037) had their PR url printed in the gather's OWN follow-up harvest** while being
  absent from SHIPPED. No GitHub query would have been required to catch those five — only a join.
  Two further amendments, both derived from measurement rather than argument: **(vi)** the section
  must reconcile **every PR url the gather emits anywhere in its own text** (harvest, discrepancies,
  merged-since-marker) against the SHIPPED union, and report any url present in one and absent from
  the other — this is arm (iv)'s cheap half and it is buildable without touching the resolver;
  **(vii)** when every trailer candidate for task X is REJECTED, the section must still ask whether a
  merged PR exists on `run-X-*` — **W1-T534/#1967 is the exact case: the resolver rejected #1977
  correctly and never looked at the run's own branch, where a correctly-trailered merge sat.**
  GOLDEN gains: the **R21 window replayed renders 12 rows**, five of them flagged
  `printed_in_harvest: true`, and the W1-T534 row names both #1977 (rejected) and #1967 (the merge).

- **R19's failure-mining and procedural-success bullets are FOLDED (R20) — both were per-cycle
  restatements of standing lines.** Failure mining: 10 of 16 `blocked_*` merged, 6 guard-fired
  containment events already filed as W1-T501/#1847, `incomplete`×7 to TASK E — all of it now lives in
  the fold-line above and in R20's own block. Procedural success: a 12-run
  `clean_single_strike × fully_executed_proof` shape against a LEARNINGS corpus reading 74 / `0
  added` — P38's ninth frozen cycle, superseded by the tenth recorded above.

**RETRO-1786578394991 (R18, prior cycle)** — 34 runs / 12 shipped / 7 credits, 17 rejected trailers
(10 self-redispatch / 7 foreign-proper, split by hand). ZERO new P-numbers; ONE new task (F).

- **★ TASK F (P47 — SPLIT THE REJECTION COUNTER BEFORE SHIPPING THE FIX). CLAUSE (i) IS NOT A PROPOSAL
  — R24-2's PRE-COMMITMENT FIRED AND THE WORD `foreign` IS STRUCK BY THIS PLAN'S AUTHORITY. ONLY
  CLAUSE (ii) REMAINS UNBUILT.** **Cumulative across every cycle that printed any rejection: 0 of ~67
  name a different task's branch** (R12's 25, R14's 23 ALL-SIBLING, R19's 17, R24's 22, R25's 5, R26's
  2). **★ R27 EVIDENCE, IN PLACE:** **this gather prints NO rejected-trailer section at all** — zero
  rejections to class, in a cycle with 31 merges and 14 uncredited ones, which is itself the reading:
  **the uncredited merges this cycle were not REJECTED, they were never OFFERED to the resolver.** A
  counter that only fires on rejection cannot see an unattempted join (THE FIRST FINDING), so F's
  clause (ii) is unchanged in value and unchanged in evidence, and the cumulative zero-foreign invariant
  (0 of ~67) holds by vacuity rather than by observation this cycle — stated, not scored (P48).
  Clause (ii) — *does some other run credit this task?* — remains the whole remaining value and is
  the difference between *the fleet re-ran a task* and *a merge was lost forever*. GROUND TRUTH AS FILED:
  the gather emits ONE word — `stale/foreign` — for two unrelated mechanisms. A rejection naming
  `run-<SAME task>-<different ts>` is the ownership-assert working as P29's lesson (a) requires; one
  naming a stranger's branch is the actual P47 defect and the only kind a P47(i) refusal gate would
  prevent. Shipping P47(i) against the merged counter produces an unreadable effect, because a fall
  could be entirely re-dispatch behaviour — the same mis-specification R17 struck P29's dial for.
  **SEPARATE FROM TASK C** (C changes trailer emission and reading; F changes only what the gather
  PRINTS, has no runtime surface, and must land FIRST or C's effect is unmeasurable). PROPOSE:
  **(i)** the discrepancy resolver classes each rejection as `rejected.self_redispatch` (offending
  head branch matches `run-<same task>-*`) or `rejected.foreign` (anything else) and the gather prints
  **two labelled counters, never a sum**; **(ii)** a `self_redispatch` rejection additionally reports
  whether the task was credited by some other run, so the line distinguishes *lost credit* from
  *bookkeeping*. **(R19's and R22's per-cycle evidence blocks DELETED BY R25 — superseded by the ~65-row
  cumulative count above, which subsumes both; the one durable detail from them is preserved here:
  R19 saw ONE row of a genuinely different shape, `run-W1-T485-…` rejected against **W1-T464**, and the
  two-way rule classes it correctly without needing a third bucket.)** GOLDEN (fixture-only, no live
  dep): a seeded pair whose offending branch is `run-X-2` against run `run-X-1` renders
  `rejected.self_redispatch` and, when X is credited elsewhere, `credited_elsewhere: true`; **a seeded
  pair whose offending branch IS the run's own (`run-X-1` against run `run-X-1`) renders
  `rejected.own_pr` and is a BUG THE RESOLVER MUST NOT PRODUCE — the fixture exists to prove it cannot**
  (R25's addition, from THE SECOND FINDING); a seeded pair on `claude/whatever` renders
  `rejected.foreign`; a gather with both renders **two counters and no combined total**; and a run of
  ten self-redispatch rejections NEVER increments the foreign counter.

**RETRO-1786537819709 (R17, prior cycle)** — mined from 64 runs / 27 shipped tasks / 27 merged PRs / 5
ledger credits (`incomplete`×17, `no_pr`×16, `blocked_ci`×15, `already_satisfied`×9, `blocked`×1,
`pr_attribution_failed`×1, **`failed`×0 for a third cycle**, plus **37 rejected trailers — 18 FOREIGN,
19 SIBLING**). **ZERO new P-numbers are mined** — see the ranking line above for why each finding
routed to an existing entry. **Three new TASKS are proposed (C, D, E), each under an existing
number.** The failure classes themselves are NOT re-mined as classes; they route through the standing
credit-artifact fold-line above. **STANDING FOR EVERY BLOCK BELOW: candidates are ratified by the
Architect via a tasks.yaml PR — rule 15, never auto-filed.**

- **★ TASK C (P47 — TRAILER EMISSION AND TRAILER READING, BOTH ENDS; UNBUILT, and R20 makes it the
  leading HYPOTHESIS for the sixteen lost merges).** GROUND TRUTH (mechanical, R17's gather plus
  `git log`): **W1-T419 shipped and the harness could not see it** — its work merged as #1609 with
  the task id in the TITLE and **no `Remudero-Task` trailer in the squash commit at all**, while
  #1617 on a `feat/*` branch carried `Remudero-Task: W1-T419` and was rejected as foreign. One task,
  both failure directions at once: the WORK with no trailer, the TRAILER with no work. W1-T413's
  harvest named the reading half: ***"`deriveStatus`'s trailer search reads only the PR body, never
  the squash commit message"*** — while the emitter writes it into the body and the merge flow
  sometimes rewrites the squash message separately. Emission-half cost that cycle: **17 runs across 5
  tasks shipped NOTHING**, every one rejected against a foreign trailer. **WHY THIS IS NOT A NEW
  P-NUMBER:** it is P47's thesis — *nothing governs who may emit a `Remudero-Task` trailer* — plus
  its symmetric half: nothing governs where it is READ from, so one task can be poisoned and dropped
  in a single cycle. **★ R20 EVIDENCE, IN PLACE:** the sixteen uncredited merges all carry the
  trailer in the PR BODY and rode `run-<task>-*` branches, and T513/#1888 carries none at all — so
  the reading half is the first place to look, and TASK C ships alongside TASK G rather than after it.
  PROPOSE (deliberately smaller than P47's three clauses, because clause (i) alone prevents the
  17 wasted runs): **(a) the emitter writes the trailer into BOTH the PR body and the squash-merge
  commit message, and `deriveStatus` reads BOTH**, preferring the commit; **(b) a PR carrying
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

**RETRO-1785992364048 (R16, prior cycle)** — 36 runs / 25 tasks / 25 PRs / 12 credits (`blocked_ci`×9,
`incomplete`×7, `no_pr`×7, `pr_attribution_failed`×1, 10 rejected trailers — 4 FOREIGN, 6 SIBLING).
Mined ZERO new numbers; proposed **TASK B**.

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
  **★★ R27 EVIDENCE, IN PLACE (supersedes R26's) — THE RESIDUE MORE THAN DOUBLED AS A SHARE, AND IT ALL
  COLLAPSED INTO THE ONE SPECIES G ALREADY REACHES.** Uncredited IN-WINDOW merges went **6 of 31 (19%)
  → 14 of 31 (45%)**, every one CODE. But the composition INVERTED: **ten are printed-but-uncredited
  (TASK G) and four are straddlers (TASK L); the absent-run species R26 minted P51 for is EMPTY.**
  **THE SHARPEST READING IS THE COMPARISON.** R26 concluded the residue was fragmenting into more
  mechanisms than P47 could hold and minted a new id for the newest one; one window later the residue
  is bigger and **entirely inside two existing clauses**, with the new id's class at zero. **P47 is
  still not converging — but it is no longer diversifying either, and the difference matters for what
  gets built:** the whole 45% is recoverable by ONE enumeration (G's clause (i), widened by L's clause
  (i)), which is the cheapest total-coverage moment this proposal has ever had. **TASK G is the top
  dispatchable item in this file for an EIGHTH cycle**, and this is the cycle where its evidence stopped
  being anecdotes and became a closed arithmetic identity: 17 + 10 + 4 = 31.
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

- **★ P49 (plan + golden; R23's mint, rank PROPOSED at 7 after P50, pending ratification) — A SAFETY FIELD
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
  NOT auto-filed here (rule 15), because deciding whether T947/T949 should be `human` or `auto` is an
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
**RETRO-1785599040918 (R13, prior cycle)** — 34 runs / 22 tasks / 25 PRs / 16 credits (`blocked_ci`×7,
`failed`×5, `blocked`×3, `no_pr`×3, 6 rejected trailers). **NO NEW P-NUMBER** — P8's accretion rule.
One surviving TASK proposal under an existing id:

- **★ TASK A (P38 — the LEARNINGS write path; ITS PREMISE WAS REFUTED 2026-08-19 AND IT IS NOW ON
  PROBATION, NOT ON THE CRITICAL PATH).** For eleven cycles this task was argued as "the narrowest
  fix" for a frozen corpus. **R22 observed the corpus move 74 → 79 with TASK A unbuilt**, so the write
  path it proposes was never what was holding entries back. **DISPOSITION: R22-4 predicts the count
  keeps climbing; if it does, this task is STRUCK rather than re-registered a ninth time, and if it
  refreezes at 79 the task returns with its rank.** The design below is retained unchanged so a
  ratifier has something to act on the moment the prediction resolves. PROPOSE: the harvest's
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
  INFRASTRUCTURE EVENT (design rule 8), not as a P41 recurrence.
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
the Architect to ratify via a tasks.yaml PR (rule 15) — **never auto-filed**, deliberately NOT written
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
  **★ R27 (RANK 3, HELD — the promotion is not re-argued): THE FIRST CYCLE THAT TESTED DESIGN RULE 10
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
  **★ EVIDENCE LOG (R14–R20 per-cycle UPDATE stack FOLDED BY R21 — the design rules and the running
  line ARE the durable content, and both live in NET STATE's scoring block; git holds the prose).**
  **The line: n=49 · hit 13 · miss 18 · unresolvable 18**, and the ELEVEN design rules it has yielded
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

- **★ P38 (plan + golden; RANK 7 as of R27 — down from 6, and NOT on a defect in the proposal) — THE
  DEAD-CONSUMER CLASS: ORGANS MERGE, PASS THEIR GATE, AND CANNOT BE SHOWN TO RUN.**
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
  **Part (i) — RE-OPENED BY R17; the retention model is now DEAD and part (ii)'s defect has replaced
  it.** Coverage across eleven windows: 46% → 100% → 4% → 29% → 79% → 28% → 47% → 11% → 19% → 0% →
  **2%**, with **nothing built at any point** — a column that lights and darkens on its own is not an
  instrument, and the LEVEL was always noise. R21's gate-side-credit hypothesis was REFUTED; R24/R25's
  measured boundaries (dark >6.11 h / lit <4.83 h; dark >5.47 h / lit <2.52 h) supported a ~5–6 h
  retention story; **R26's 0-of-31 over 23.9 h broke it without replacing it; and R27 kills it outright
  — 2% coverage means ONE run of 52 carries turn data (167 turns) over a 20.5-hour window, which no
  retention bound produces.** **TASK D's honest scope is now: find out whether the column is
  retention-limited or simply not written for most runs, before dividing by anything.** Note the
  aggravating detail: **all 17 credited merges print `0t`**, so whatever writes turns is not writing
  them for runs that ship.
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
  NOT admitted but is emitted on TASK L's line with its MERGE-time window recorded (design rule 7); a
  printed-but-uncredited merge is NOT admitted but is emitted on TASK G's line; and a PR whose head ref
  IS the refused run's own branch is admitted with `own_pr` named as the loss reason, never as
  `foreign`.**

**RETRO-1784512714705 (R8, prior cycle)** — 195 runs / 28 gate-side merges / 0 credits
(`incomplete`×111, `no_pr`×42, `blocked_ci`×21, `pr_attribution_failed`×12, `blocked`×5,
`blocked_containment`×2, `blocked_isolation`×2).

- **★ P29 — CLOSED 2026-08-07: BOTH CLAUSES SHIPPED IN PR #349 (2026-07-20)** — clause (i)
  sibling-run credit liveness (the `ownResult` stash live in `src/lib/status.ts`) and clause (ii) the
  per-task dispatch circuit breaker, head `run-W1-T149-1784553391268`, 3/3 criteria; clause (ii) is
  ALSO credited to W1-T271/#1040, which knowingly added a second breaker because #349's streak resets
  on every `pr.opened`. **TOMBSTONE — four durable claims, everything else DELETED (git holds it).**
  **(a) the ownership-assert is CORRECT and must not be loosened** — it stopped R5's false-credit
  inversion and still does; **(b) a fail-closed integrity guard needs a LIVENESS counterpart, or the
  system pays for its own correctness forever** (P39 is its dispatch-side half, still OPEN);
  **(c) THE STING, why W1-T390 and TASK G exist** — the preserved assert is also what makes a
  `run-<taskId>-<slug>` branch permanently uncreditable, and R19 showed the mirror image: #1797/#1825
  ride perfectly-formed `run-X-*` branches and are credited by nothing because the owning run fell
  outside the measured window; **(d) a run that opened no PR of its own is SUPPOSED to have a
  sibling's trailer rejected, so the rejection count was never this mechanism's dial — no retro may
  credit or debit #349 with one again.** The generalisation belongs to **P43**: *a proposal's headline
  number must be derivable FROM the mechanism it names* — and R20 is its live case, since the
  fold-line's 8% reading cannot be adjudicated without the per-run row TASK H proposes.
- **★ P30 — RATIFIED 2026-07-20 → W1-T150, SHIPPED 2026-07-21 (#358: `rmd sweep` gains a
  level-triggered rung appending a `verdict.merged` correction for any owned-and-merged PR left
  uncredited). Prose DELETED per RATIFY-OR-KILL.** Two survivals: the ledger-vs-GitHub history each
  retro re-reads (R3 15/17 · R4 2/6 · R5 4/4 · R7 14/14 · R8 0/28 · R9 13/21 · R10 8/23 · **R11
  20/94**), and the question shipping did NOT close — **the metric still has not moved** (carried as
  P35, folded into P38, P30's live descendant).
- **P31 — RESOLVED; COLLAPSED INTO P30.** R8's test (*"19 of 21 `blocked_ci` merged anyway"*) held
  every cycle through R19's 10-of-16 — **and BROKE in R20 at 1 of 13 (8%)**, which is why R20-1
  re-registers it as a live prediction rather than a settled collapse. No separate task.
- **THE SPIN-LOOP STORM (R8: `incomplete`×111 + `no_pr`×42 + `pr_attribution_failed`×12 of 195 runs) —
  folded into P29, kept as the ORIGIN of the fold-line doctrine:** timestamps tracked the W1-T1/W1-T29
  redispatch cadence, so it was not 165 failures but ONE defect counted 165 times. Mine only the
  residue that survives the fold — **and note R20's inversion: that rule protects against inflating a
  cause, and this cycle it is the rule itself that had to be bounded rather than applied.**
- **R7 / R1784213948025 / R1784206755808 / R1784155126258 — proposal blocks DELETED, terminal statuses
  and doctrine only.** **P27** RESOLVED 2026-07-18: the `blocked_isolation`×5 volume was ONE cause, a
  Claude Code 2.1.214 auto-update adding a pkill wrapper the static allowlist predated (#184 named it,
  #185 absorbed it) — the proposed host-hygiene fix was REFUTED by the name and the guard fail-closed
  correctly on toolchain drift; that resolution is why guard volume is graded a HOST signal (P41).
  **P23**→W1-T91/#719 (structured guard-cause on block verdicts) · `blocked_review` lines→P15/W1-T65
  (#122). **P9**→W1-T75/#138 (operator corrections SUPREME in deriveStatus, `rmd correct` writer),
  two lessons kept because R8 turned on both: **(a) a fix that repairs the mechanism but not the
  CORRUPT DATA IT ALREADY EMITTED is half a fix, and the plan is downstream of that data;
  (b) `correction.provenance` is a first-class ledger EVENT, not a note** — every consumer reads
  corrections, or the ledger's integrity is only as good as its least-aware reader. Restating settled
  adjudications is the graveyard P8 warned about.
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
- Cross-agent support (Codex exec) — explicitly parked; Claude-first keeps contracts tight.
- Tournament dispatch (two approaches, reviewer picks) for high-risk tasks — expensive, park until
  verdict calibration proves the reviewer.
- P19 rung 2 — Tree-sitter symbol-touch locks; unbanks only when a rung-1 file-overlap ESCAPE is
  observed in the ledger (W1-T172's `dispatch.concurrent_set` line is the trigger).
