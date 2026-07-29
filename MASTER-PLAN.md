# REMUDERO — Master Plan (v2.25 · synced 2026-07-29)

**FOCUS — THE BIGGEST CYCLE EVER, AND THE WRITE SIDE WENT DARK. 147 runs → 94 shipped tasks** (the
gate-integrity ladder, brownfield onboarding, the entire learning flywheel, the console arc) at
**$6.664/run — the first cost DROP in four cycles.** And, in the same gather: **20 of 94 tasks were
ledger-credited (21%, down from 30%); ZERO LEARNINGS entries were written across 147 runs; 58 of 147
runs recorded `task_class: unknown` AND exactly 0 turns; and W1-T148's cost governor, W1-T121's queue
governor and W1-T151's freshness hook all shipped as tested pure functions with NO LIVE CALL SITE.**
Four organs merged, none of them observable to be running. That is ONE finding, not four — P35's
*shipping is not fixing* generalized past credit to every organ, mined as **P38 (the dead-consumer
class)**. Next, in order: **P38 (prove the merged organs execute) → W1-T149 (P29 sibling credit — 49
credit rejections, W1-T230 re-dispatched 6×, unbuilt for a FOURTH cycle) → the pre-dispatch
merged-trailer gate (P39 — three of the 94 "shipped" tasks are no-op PRs closing a stale re-dispatch)
→ P33's trailer quarantine (W1-T64 rejected 4× more against the same foreign #115) → P40 (the
gather's own class/turn/MAST columns are half-dark)**.

**Header discipline (v2.17).** This header carries the **sync date + current focus and nothing else**.
The sections are the source of truth; read them. A retro that re-inflates this header has failed the
HARNESS-COMPRESSION bar (§Self-improvement).

**Retro ledger:** R1–R9 seeded CALIBRATION + P1–P32, corrected the false-merged W1-T54b attribution
(#80 → #91), and closed P1–P11+P15+P21+P25+P27+P31. The per-retro id roll-call is DELETED — the SHIPPED
log's section headers already carry every id and date, and maintaining the same list twice is the
duplication HARNESS-COMPRESSION forbids · R10 (…626054083, 2026-07-21) logged the 23-task
console/inbox/governor cycle and mined P35; its own "the credit backfill landed inert" claim was
CORRECTED by hand-verification in #470 — the backfill FIRES (134 evaluated, 70 `verdict.merged`
corrections in-ledger), and the defect was the retro tally reading raw `verdict` lines only ·
**R11 (…341166059, this sync)** logs the **94-task gate-integrity + onboarding + flywheel cycle**,
re-bases calibration on 147 runs, RETIRES P28 on its own instrument (21% approval, n=18) and
P12/P13/P14/P18/P20/P23/P24 on merged tasks, and mines **P38/P39/P40**.

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

★ **THIS CYCLE (RETRO-1785341166059, 2026-07-29): the gate-integrity ladder, brownfield onboarding
and the WHOLE learning flywheel drained — 147 runs → 94 shipped tasks, the biggest cycle by count and
the first with a FALLING per-run cost ($10.650 → $6.664).** What drained (detail in the SHIPPED log):

- **The gate/review-integrity ladder** — the arm decision, the status channel, the mechanical proof
  floor and the linter that keeps proofs executable (W1-T203/T227/T228/T229/T230/T231/T232/T233/T219/
  T205/T134/T135/T161 + T246/T101/T118/T81/T92/T58).
- **Every ratified-but-unbuilt family from the last three retros, ALL of it** — brownfield onboarding
  W1-T82–T85 (P24), the learning flywheel W1-T86/T87/T88 (P12/P13/P14), MAST coding W1-T89 (P18 — this
  gather's failure-by-category table is its first output), the alert-fix lane W1-T90 (P20), the
  isolation cause-field W1-T91 (P23), degraded-success mining W1-T73, and the follow-up harvest
  W1-T105 (whose first live output is this gather's proposal-candidate list).
- **Daemon durability + the operator surface** — the retro's own cadence trigger (W1-T160), morning
  digest + recap (W1-T112/T144/T163), self-restart (W1-T126), install freshness (W1-T151), process-tree
  containment (W1-T117), log/ledger rotation and write atomicity (W1-T209/T218/T244/T206/T207/T240/
  T241/T242), console GLANCE/detail/summary (W1-T159/T222/T223), and **risk/class mount routing
  (W1-T167)** — the first change to the mount table's shape since #90.

★ **THE FINDING: FOUR ORGANS MERGED AND NOT ONE CAN BE SHOWN TO RUN.** (a) **LEARNINGS held at 74
entries — ZERO added** across 147 runs and 94 shipped tasks, while W1-T86 (#631 utility A/B), W1-T87
(#687 success mining) and W1-T88 (#689 contradiction detection) all merged INTO that corpus; the
gather's own miner proposed two reusable shapes and nothing wrote them. (b) The runs' own follow-up
harvest states three separate times that `checkCostGovernor`/`logCostGovernorDeferral` (W1-T148/#839)
and the W1-T121 queue governor "ship as tested pure functions with no live call site", and that
W1-T151's `checkFreshness`/`runInstall` are "still unwired in production". (c) **58 of 147 runs
recorded `task_class: unknown` and exactly 0 turns**, so the routing W1-T167 just built cannot be
calibrated on 40% of the fleet. (d) Ledger credit fell again, 30% → 21%. Each is small alone; together
they are one class — **an organ can merge, pass its gate, and never be wired to the loop it was built
for.** That is P35 generalized, mined as **P38**. Standing rule 14 already says the call site is a
deliverable; nothing ENFORCES it, and §5's own doctrine is that instructions shape and gates guarantee.

★ **P29 IS NOW THE MOST EXPENSIVE UNBUILT RATIFICATION IN THE PLAN — FOURTH CYCLE.** 49 credit
rejections this cycle; ~39 are the SIBLING case W1-T149 was ratified to credit (W1-T230 rejected 6×,
W1-T152 5×, W1-T7 4×, and W1-T137/T151/T159/T189/T209/T212 repeatedly). **Three of the 94 "shipped"
tasks are PRs whose entire content is a no-op close of a stale re-dispatch** — W1-T7/#772,
W1-T12a/#725, W1-T99/#731 — i.e. the harness paid an implement worker to discover the work was
already done. The remaining ~10 rejections are P33's FOREIGN class (W1-T64 ×4 against the same #115;
W1-T220 against #641's hand-authored branch), which sibling credit cannot reach.

★ **CONTAINMENT IS NO LONGER QUIET.** `containment/outside-cwd-denial` fired 6× across W1-T209,
W1-T212 and W1-T230 after three cycles at zero. W1-T91's new structured guard-cause field (#719) is
what makes this legible and it names the shape: **a HOST signal, not a task defect** — the 7 guard
events are excluded from every task's defect count by construction. The Calibration line that
restated "zero for a third cycle" is DELETED rather than restated a fourth time; it is no longer true.

★ **PRIOR CYCLES (folded — the SHIPPED log carries the detail).** R10 (2026-07-21): the console became
a real instrument (W1-T153–T158, T179, T181, T187), the P25 ratification inbox CLOSED
(W1-T110/T111/T192), the governor pair landed (W1-T121/T122) and the floor gained verdict integrity
(W1-T128/T185) — 23 shipped from 27 runs, and the credit metric FELL after its own fix merged (P35).
R9 (2026-07-20): the spin loop ENDED (195 runs → 26); the W3 control panel, the `rmd serve` console
and the alert/issue intake lane drained. R8 (2026-07-19): 28 merges, **0 ledger credits** — the SECOND
INTEGRITY INVERSION, in the LIVENESS direction: W1-T1 re-dispatched ~130 times over ~10 hours at ~$130
because its own merged PR could not credit a SIBLING run (P29/P30). R7 (2026-07-18): flight control's
four layers + the level-triggered PR-pipeline reconciler family + blocked_ci → ci-log fix routing.
R6: the deterministic FLOOR began executing each criterion's whitelisted proof against the PR head,
so the LLM reviewer is purely additive (P15 CLOSED). R5: the gather unions ledger∪GitHub-derived
trailered merges (P11 CLOSED), the reviewer/fix/diagnose phases became mount-governed (P10 CLOSED),
and the FIRST INTEGRITY INVERSION was found — **PR #80 still carries a false `W1-T54b` trailer**, the
residue P33's quarantine list is ratified to retire.

**Inventory (verified 2026-07-29: 94 tasks shipped this cycle, ~870 merged PRs on `remudero`, 6 on
`remudero-sandbox`).** WS-0 and WS-1 SHIPPED; WS-3's control panel is a live instrument; the §5 gate
stack now polices its own integrity end to end, and the daemon — not an operator kick — fires the
retro (W1-T160/#853). The SHIPPED log is the record (rule 13 — the proof is a merged PR); no PR-by-PR
restatement lives here.

**mounts.yaml (W1-T5) is SHIPPED** — #42, on disk at `.remudero/mounts.yaml`, re-based to a flat-400
tripwire by #90, and as of **W1-T167/#606 it routes model + effort by task RISK and CLASS instead of
one flat mount.** The calibration table below is the row that re-bases it — and see P40: the class
column reads `unknown` on 40% of runs, so the routing discount cannot yet be measured.

**Still PLANNED, not shipped** (the honest remainder): **W1-T149 — P29 sibling credit, ratified three
cycles ago and still unbuilt**; P19's parallel-dispatch family (W1-T170/T171/T172 — prerequisites
merged); P17's receipts task (W1-T71); P34's presence/headroom family (W1-T248–T251) and P37's TIER-1
policy file (W1-T252/T253), both ratified 2026-07-23; the remaining fleet tasks (W1-T25/T28, W2-T2
dry-run). The onboarding (W1-T82–T85), flywheel (W1-T86/T87/T88), MAST (W1-T89), alert-lane (W1-T90)
and isolation-cause (W1-T91) families ALL DRAINED this cycle and are struck from this list.

**NEXT (L2) — kick order, graded against R11's data:** **(1) P38 — prove the merged organs EXECUTE:
wire the two governors and the freshness hook to their call sites, and show ONE learning written on
`remudero`; (2) W1-T149 (P29) — 39 sibling rejections and three no-op re-dispatch PRs this cycle;
(3) the pre-dispatch merged-trailer gate (P39) — refuse to dispatch a task whose id already rides a
merged trailer; (4) P33's trailer quarantine — W1-T64 rejected 4× more against #115; (5) P40 — the
class/turn/MAST blackout, because it silently disarms W1-T167's routing and the mount table itself;
(6) W1-T170/T171/T172 parallel dispatch.** The binding constraint has MOVED for the first time in
four cycles: it is no longer *"the harness cannot reliably tell itself what it already finished"* —
the W1-T51 union does that, and this gather rescued 74 gate-side merges — it is now **"the harness
cannot tell itself whether what it BUILT is running."**
NOTE: `nextRunnable` (drain.ts:31 `plan.tasks.find`) is DECLARATION-ORDERED; this is the authoritative
KICK ORDER (mirrored as a comment atop plan/tasks.yaml).

## SHIPPED log

Shipped arcs, keyed by Remudero-Task (Standing rule 13: the proof is a MERGED PR, not prose).
Newest first. Cost/turns from the run ledger.

### RETRO-1785341166059 (2026-07-29) — the gate-integrity ladder + onboarding + the flywheel (94 tasks shipped)

★ **Only 20 of 94 were LEDGER-CREDITED (21%, DOWN from R10's 30%).** The 74 unmarked below are
gate-side merges the W1-T51 union rescued — P30/P29 residue, mined as P39. **Turns are OMITTED from
this section, not zeroed:** 58 of 147 runs recorded exactly 0 turns (P40), so a per-task turn column
would be fiction. Costs are the crediting run's own ledger cost and sum to **$867.986** of the cycle's
**$979.601** — the ~$112 remainder is the 53 runs that produced no credited PR, chiefly the sibling
re-dispatches P29 leaves uncredited.

- **THE GATE/REVIEW-INTEGRITY LADDER — 13 tasks, FOLDED** (poster-identity gate on the
  `remudero-review` channel W1-T203/#508 · status-channel clobber guard T228/#525 · the arm decision
  derives from the orchestrator's OWN ledger, not the status channel, T230/#523 · a CAPPED verdict
  never arms regardless of tdd tier T229/#528 · plan-only PRs carved out of the capped floor T205/#562
  · the fresh reviewer stops being told to post its own status T231/#530 · name-filtered proof runs
  narrow to candidate files T227/#527 · materialization drops the needless branch checkout T232/#535
  and names its teardown reason T233/#537 · fail-open holes in the mechanical floor closed T219/#571 ·
  EVERY Acceptance claim parsed, not just the first, T134/#826 · transient gh 5xx retry on the status
  POST T135/#828 · a prose zero-match proof is `not_executable`, never a false `executed_fail`,
  T161/#866) → **$67.218**
- **THE PROOF-DIALECT + PLAN-LINT ARC — 6 tasks, FOLDED** (a proof that cannot execute is BLOCKED at
  lint time W1-T246/#697 · proof-resolvability lint T101/#735 · headless-fitness scoped by
  spawn-ownership T118/#817 and made negation/self-reference aware T81/#677 · data/config files
  discounted from subsystem sizing T92/#723 · the rule-15 blocked-review GOLDEN minted T58/#635)
  → **$68.406**
- **BROWNFIELD ONBOARDING (P24, all four phases) — FOLDED** (deterministic repo inventory W1-T82/#683
  → recon + plan-artifact mining T83/#698 → the planning session T84/#702 → synthesis to ONE
  ratifiable draft PR T85/#709) → **$43.563** · ★ **P24 CLOSED**
- **THE LEARNING FLYWHEEL + ITS MINERS — 8 tasks, FOLDED** (`rmd wipe-test`, the P12 learning-utility
  A/B harness, W1-T86/#631 · procedural-success mining from merged runs T87/#687 (P13) ·
  contradiction detection marking contested pairs T88/#689 (P14) · MAST-coded verdicts via a
  deterministic taxonomy map T89/#710 (P18) · the policy-gated alert-fix lane T90/#716 (P20) ·
  structured guard-cause + infra classification on block verdicts T91/#719 (P23) · degraded-success
  telemetry mining T73/#654 · the worker-declared follow-up harvest T105/#744) → **$111.191** ·
  ★ **P12/P13/P14/P18/P20/P23 CLOSED — and see P38: this family merged and the corpus did not grow**
- **THE SWEEP/RECONCILER FAMILY — 12 tasks, FOLDED** (reliable post-review sweep, light-sweep ticker
  W1-T254/#720 · post-fix re-verification T124/#821 · arm at PR-open, not after review, T125/#823 ·
  a WAIT disposition for in-window pending checks T114/#806 · a CONFLICTED disposition + merge-conflict
  fix mode T106/#804 · escalations whose PR closed unmerged are closed T162/#870 · the daily COST
  GOVERNOR T148/#839 · one open needs-human per (task, PR) T104/#801 · a correction is unconditionally
  supreme with zero gh calls T130/#628 · a verified-merged pr-field credit outranks an open-PR row
  T116/#810 · a merged proposal_pr reconciles to accepted T257/#800 · label provisioning + isolated
  sweep-action throws T99/#731) → **$80.425**
- **DAEMON DURABILITY + WORKER SPAWN — 11 tasks, FOLDED** (the retro fires on a merges/days trigger,
  integrity-gated, W1-T160/#853 — **the retro now has a cadence and this cycle is its first output** ·
  self-restart when origin/main advances past the boot sha T126/#824 · pause idles in-process instead
  of exiting into a KeepAlive storm T197/#531 · daemon logs flushed synchronously, ledger path named
  aloud T143/#837 · install-freshness runs npm install on a lock change T151/#845 · relaunch-loop
  detection from boot-rate T215/#590 · claude resolved at spawn with infra-failure degradation
  T113/#752 · `--allow-self-target` consent baked into self-target units T109/#749 · a run's process
  tree contained and orphans swept T117/#815 · one bounded evidence-preserving test retry T255/#754 ·
  auto ff-pull of rmd's own checkout at CLI entry T79/#662) → **$141.752**
- **LEDGER, INBOX + WRITE ATOMICITY — 12 tasks, FOLDED** (ledger rotation by size, breaker-safe,
  W1-T209/#583 · bounded rotation retention T244/#618 · newsyslog policy that EXCLUDES the ledger
  T218/#593 · a torn ledger line is dropped LOUD, never faked as `{}`, T206/#549 · atomic status.json
  cache write T207/#552 · a corrupt run.lock distinguished from an absent one T208/#555 · all four
  inbox-proposals writers serialized through one lock T240/#608 · the draft rung's drafts/attempts
  pair made atomic T241/#612 · the last-retro marker written atomically T242/#613 · captured feedback
  lands on origin/main automatically T243/#619 · tasks.d shards materialized in syncPlanFromOrigin
  T245/#651 · markdown fences stripped from Architect drafts T173/#660) → **$95.159**
- **THE CONSOLE + DIGEST ARC — 10 tasks, FOLDED** (GLANCE strip, daemon-health widget, tab badge
  W1-T159/#861 · marker-aware since-you-last-checked recap T163/#647 · RECENT sourced from the ledger
  with GitHub decorating, never gating, T184/#479 · status-poll timeouts + stale one-truth routed into
  the lifecycle T189/#574 · proposal cards wired to the write-token API T193/#602 · skeleton lifecycle
  proven T200/#622 · inline task detail T222/#625 · live one-line summaries on collapsed sections
  T223/#626 · `rmd digest-plist`, the daily morning-pulse LaunchAgent, T112/#491 · escalations and
  drain rundowns pushed with console links T144/#614) → **$176.278** · the cycle's costliest arc
- **CI, COMMIT + MOUNT HYGIENE — 11 tasks, FOLDED** (a real local commit-msg hook so worker commits
  are linted before push W1-T137/#842 · the PR TITLE is linted instead of every branch commit
  T129/#830 · a branch push whose diff touches UNDECLARED files is refused T142/#835 · nightly
  full-scope mutation run owns the global score while the PR gate stays diff-only T133/#833 ·
  check-runs deduped by name, latest attempt only, T123/#820 · the hard-failing osv-scan required in
  ci-gate T211/#587 · one REQUIRED entry per line to avoid tier-gate collisions T107/#747 ·
  out-of-repo temp-dir records excluded from the coverage ratchet T220/#641 · per-diff coverage gate
  T212/#582 · repoRoot resolved from cwd with gate read-identity proven T120/#819 · **model/effort
  routed by task risk and class, not a flat mount, T167/#606**) → **$58.619**
- **DOCS, OPERATOR SURFACE + THE THREE NO-OP CLOSES — 7 tasks, FOLDED** (four hand-written docs/code
  contradictions corrected + the claims gate extended W1-T213/#595 · the operator crisis runbook
  T217/#598 · the ci-log fix worker restricted to a least-privilege toolset T210/#585 · a fix-rung
  strike counts only once a worker actually RAN T127/#825 · and the three PRs whose entire content is
  a no-op close of a stale re-dispatch — **W1-T7/#772, W1-T12a/#725, W1-T99/#731** — plus the
  line-anchored trailer extraction in `rmd review` T70/#640) → **$25.375** · ★ **the three no-op
  closes are P39's ground truth: the harness paid implement workers to discover the work was done**

### RETRO-1784626054083 (2026-07-21) — the console instrument + the ratification inbox + the governors (23 tasks shipped)

★ **Only 8 of 23 were LEDGER-CREDITED (30%) — and W1-T150, the fix for exactly this, merged FIRST
(#358).** That inversion was the cycle's finding and is mined as P35. **FOLDED to family lines this
retro** — the per-task prose said nothing the family line and the PR do not, and R11 restating 23
entries verbatim is the duplication HARNESS-COMPRESSION forbids.

- **FLOOR + VERDICT INTEGRITY — FOLDED** (a zero-executed-proof verdict renders CAPPED/DEGRADED and
  cannot arm auto-merge on tdd:strict W1-T185/#456 — the cycle's costliest run · verdict stability
  across re-review of an unchanged head T178/#423 · THE DEAD PROOF FLOOR, 101 of 126 runnable-dialect
  proofs could never execute, T128/#414 · terminal state re-read FRESH at every spending site
  T177/#417) → $81.592
- **THE CONSOLE / LIVE-STATE FAMILY — FOLDED** (design-system shell overhaul T153/#376 · fuzzy find +
  facets + cmd+K + URL state T157/#405 · task-detail + journey view over `rmd trace` T158/#410 · the
  ENOBUFS board outage, >1 MiB PR JSON read as merged 0/N, T181/#411 · monotonic-under-darkness +
  liveness bound T179/#431 · first-paint pre-warm T154/#388 · the full status taxonomy in the
  projection T155/#365 · live SSE rows that never lie about liveness T156/#398 · the O(tasks × ledger)
  reprojection outage answering in 35–58s against a <2s budget T187/#445) → $82.579
- **THE P25 RATIFICATION INBOX, END TO END — FOLDED** (`rmd inbox`'s deterministic readiness core
  T110/#368 · `rmd approve`/`rmd reframe` + approval telemetry T111/#373 · the draft rung moved
  daemon-side T192/#457) → $42.847 · ★ **P25 CLOSED**
- **CREDIT + THE PLAN-PR EMITTER — FOLDED** (P30's level-triggered credit backfill T150/#358 — merged
  FIRST, and 15 gate-side merges followed it, see P35 · one gate-compliant emitter for every machine
  plan-PR writer T136/#437 · throttled-vs-absent GitHub reads DEFER, never conclude, T119/#382)
  → $22.980
- **LAYERED KNOWLEDGE + THE GOVERNOR PAIR — FOLDED** (P32's one entry schema + layer homes T145/#360
  · promotion = scrub THEN judge, per-layer budget ratchet, T146/#371 · the queue governor's WIP limit
  on dispatch only T121/#385 · plan sharding under `plan/tasks.d/` T122/#386) → $17.390

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

## Calibration (observed — through RETRO-1785341166059, 2026-07-29)

The empirical baseline **mounts.yaml (W1-T5, shipped #42; risk/class routing since W1-T167/#606)** and
Flight-control burn-rate signals (§4B Layer 1, BUILT — W1-T20/#132) key off.

**★ CURRENT BASELINE — this cycle (RETRO-1785341166059, 147 runs, entirely `implement`-typed). This is
the row W1-T5's mount table keys off:**

| task_type | runs | merged | avg $ | avg turns | total $ |
|---|---|---|---|---|---|
| implement | 147 | 20 | $6.664 | 8 | $979.601 |

**BY TASK CLASS — the W1-T167 routing question (is the class-routed mount discount paying off?):**

| task_class | runs | merged | merge rate | avg $ | avg turns | total $ |
|---|---|---|---|---|---|---|
| src | 89 | 4 | 5% | $6.571 | 13.2 | $584.861 |
| unknown | 58 | 16 | 28% | $6.806 | 0 | $394.740 |

**Prior cycles (FOLDED — trend only):** R10 27 runs / 8 ledger-merged (23 real) / $10.650 / 86.6t ·
R9 26 / 13 (21 real) / $7.682 / 81.4t (plus the only `diagnose` row ever recorded, n=1 — **still do not
re-base a diagnose mount on it**) · R8 195 / 0 (28 real) / $1.258 / 14.7t — **churn-poisoned by the
W1-T1 spin loop and never to be re-based on** · R7 29 / 14 / $5.794 / 72.2t · R6 2 / 1 / $4.673 / 64t ·
R5 9 / 4 / $3.613 / 56.9t · R4 10 / 2 (6 real) / $3.290 / 54.5t · R3 22 / 15 / $3.218 / 45.2t ·
R1+R2 19 / 11 / $1.838 / 21.4t. **Derived all-time:** ~486 runs, ~217 merged.

**Reads:**
- **★ THE `avg turns` CELL IS NOT A MEASUREMENT — DO NOT RE-BASE ANY TURN-KEYED THRESHOLD ON IT.**
  58 of 147 runs recorded exactly **0** turns, and the SAME 58 recorded `task_class: unknown`; the
  `src` class shows 13.2 turns over 89 runs, so the loss is structural, not uniform. A headline of 8
  turns/run against R10's 86.6 is a write-side blackout being read as a 10× efficiency gain. Mined as
  **P40**; the honest per-run turn figure for the runs that reported one is ~13.
- **COST FELL, and this is real: $10.650 → $6.664 per run, the first drop in four cycles** ($5.794 →
  $7.682 → $10.650 → $6.664). R10's named cost-trend re-check is hereby **ANSWERED and DELETED** — the
  third distinct driver did not appear; the composition shifted back toward small, well-specified gate
  and reconciler tasks (median task under $7) and the two-cycle rise did not become a trend.
- **Cost per SHIPPED task is $10.42** ($979.601 / 94), down from R10's $12.50. This is the number to
  compare cycle-over-cycle; it does not benefit from a clean cycle's smaller denominator the way merge
  rate does.
- **Merge rate 94/147 (64%)** against R10's 85% — LOWER, and honestly so: R10's denominator was 27
  hand-kicked runs, this one is 147 daemon-drained runs including every sibling re-dispatch P29 leaves
  uncredited. The 53 runs that shipped nothing cost ~$112 total (11% of spend).
- **★ LEDGER CREDIT REGRESSED AGAIN: 30% → 20/94 (21%).** The `merged` column above reads **20**, not
  94, for exactly this reason, and every consumer keyed on `verdict` — deriveStatus (dispatch!), this
  table, `rmd trace`, the P25 readiness predicate — saw a false negative on 74 shipped tasks. P35 named
  the reading defect (the tally counts `step: "verdict"` lines and is blind to the `verdict.merged`
  corrections the backfill writes); it is still unbuilt and is now the narrow instance of **P38**.
- **★ THE CLASS TABLE CANNOT YET ANSWER ITS OWN QUESTION.** `unknown` is 40% of runs and shows a
  higher merge rate (28% vs 5%) at nearly identical cost ($6.81 vs $6.57) — that is NOT evidence the
  routing discount works. `merged` here is the ledger-credit column, so it measures which class the
  credit path happens to see, and `unknown` skews toward the plan/docs runs the union credits. **Until
  P40 closes the class blackout, W1-T167's routing is unmeasured, not validated.**
- **MAST distribution (W1-T89/#710, its first live output): verification 54 · infrastructure 7 ·
  specification 6 — and 60 runs UNMAPPED** (`blocked`×47, `incomplete`×12, `blocked_transient:success`
  ×1). The taxonomy has no row for the single most common verdict class in the cycle. Named, never
  guessed — which is the mapping behaving correctly — but a taxonomy blind to 41% of its corpus cannot
  support the WS-12 publish rung it was built for. Folded into **P40**.
- **Guard-fired blocks: 7, ALL excluded from task defect counts** (W1-T91/#719's structured
  guard-cause field, its first live output). `containment/outside-cwd-denial` fired **6× across
  W1-T209/T212/T230 — a HOST signal, not a task signal**, and the first non-zero containment count in
  four cycles. R10's "zero for a third cycle, delete next retro" line is deleted as scheduled; it was
  also falsified.
- **The $100 `budget_usd` tripwire: 0/147 trips.** Most expensive single run: W1-T193 at $35.643,
  narrowly past R10's W1-T185 ($34.059). The per-TASK circuit breaker (P29(ii)) remains unbuilt, and
  this cycle shows why it matters at the CHEAP end too: W1-T230's six dispatches cost more in
  aggregate than any single run.
- **A retro must not average over a spin loop** — R8's lesson, kept because it is cheap to keep and
  expensive to relearn. **P29(iii)** (annotate credit-rejected runs before they reach the mount table)
  is still unbuilt, and this cycle had **49** credit-rejected runs to filter, not one.

**Ratification telemetry (W1-T111/#373, second reading): approved 3 · reframed 11 · approval rate 21%.**
Cumulative across both readings: **4 approved / 18 items ≈ 22%.** Adjudicated in P28 below — the
instrument's second independent reading agrees with its first, and it argues against the proposal that
asked for it.

## Retro proposals (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)

**RETRO-1785341166059 (this cycle)** — mined from 147 runs / 94 shipped tasks / 20 ledger credits
(`blocked`×47, `blocked_ci`×25, `no_pr`×17, `incomplete`×12, `pr_attribution_failed`×12,
`blocked_containment`×6, `failed`×6, `blocked_isolation`×1, `blocked_transient`×1, plus **49 rejected
trailers**). Candidates for the Architect to ratify via a tasks.yaml PR (rule 15) — never auto-filed.

- **★ P38 (plan + golden; THE TOP ITEM) — THE DEAD-CONSUMER CLASS: FOUR ORGANS MERGED THIS CYCLE AND
  NOT ONE CAN BE SHOWN TO RUN.** GROUND TRUTH (mechanical, this gather): **(a)** LEARNINGS held at
  **74 entries — ZERO added** across 147 runs and 94 shipped tasks, while W1-T86 (#631 utility A/B),
  W1-T87 (#687 procedural-success mining) and W1-T88 (#689 contradiction detection) all merged INTO
  that corpus; the gather's own miner proposed two reusable shapes (`implement × clean_single_strike`
  ×10 runs, `× fully_executed_proof` ×3) and nothing wrote them. **(b)** The runs' own follow-up
  harvest (W1-T105/#744) states THREE separate times that `checkCostGovernor`/`logCostGovernorDeferral`
  (W1-T148/#839) and the W1-T121 queue governor "ship as tested pure functions with no live call site,
  so neither throttles a running daemon yet", and that W1-T151's `DaemonDeps.checkFreshness`/`runInstall`
  are "still unwired in production". **(c)** W1-T126's in-process daemon self-restart is flagged as
  possibly redundant with the already-wired out-of-process `lib/deployer.ts`. **(d)** Ledger credit fell
  30% → 21% with P35's reading defect diagnosed and unbuilt. DIAGNOSIS: **the gate proves a UNIT and
  never a WIRE.** Standing rule 14 already says "the call site is a deliverable" — it is INSTRUCTION,
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
  THE GENERAL LESSON, and the reason this is P-numbered rather than three bug reports: **rule 13's
  "the proof is a merged PR" is exactly right about PROVENANCE and silent about EFFECT — and a harness
  that cannot see its own organs running will keep buying them twice.** SUBSUMES P35, which is the
  same defect aimed at one consumer.
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
  DEPENDENCY: sequence WITH W1-T149 — this is P29's other half.
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
- **P28 — RETIRED, KILLED BY ITS OWN INSTRUMENT AT n=18. Design prose DELETED (git holds it).** P28
  asked for graduated auto-ratification, and named W1-T111's approval telemetry as its own graduation
  trigger. Two independent readings a cycle apart: R10 approved 1 / reframed 3 (25%); R11 approved 3 /
  reframed 11 (21%); cumulative **4 of 18 ≈ 22%**. P28's rule widens an envelope for a class approved
  at ≥N% over ≥M items and treats a reframe as NARROWING — reframes outnumber approvals ~4:1 across
  both readings. Holding a proposal whose trigger has now fired TWICE NEGATIVE is the graveyard P8
  named. BANKED, re-openable only if the cumulative rate crosses 60% over ≥30 items. **THE DURABLE
  LESSON KEPT: gating on evidence paid for the second time — the instrument (W1-T111) outlived the
  proposal that commissioned it, and the honest outcome of a trigger is sometimes `no`.**
- **P35 — RE-RANKED, FOLDED INTO P38; the twenty-line diagnosis block is DELETED.** What survives:
  the backfill FIRES (#470's hand-verification — 134 evaluated, 70 `verdict.merged` corrections
  in-ledger); the defect is that the retro's credit tally counts `step: "verdict"` lines only
  (retro.ts) and is structurally blind to the corrections (sweep.ts). Still unbuilt, and this cycle's
  21% credit column is the same blindness restated. Build it as P38(ii)'s first consumer.
- **P29 — RE-RANKED TO #2; FOURTH CYCLE UNBUILT; design prose DELETED (W1-T149 IS the record).**
  Evidence ESCALATED, not repeated: **49 credit rejections this cycle**, ~39 of them the sibling case
  W1-T149 was ratified to credit — W1-T230 ×6, W1-T152 ×5, W1-T7 ×4, plus W1-T137/T151/T159/T189/
  T209/T212 repeatedly — and three no-op-close PRs (P39's ground truth). The general lesson stands
  verbatim: **a fail-closed integrity guard needs a liveness counterpart, or the system pays for its
  own correctness forever.** An unbuilt ratification surviving FOUR retros is the plan-health flag
  §Self-improvement names, and it is now the plan's single largest carried cost.
- **P33 — RE-CONFIRMED WITH NEW INSTANCES, RE-RANKED TO #4.** W1-T64 was rejected **4 more times**
  against the same long-merged foreign #115 (`fix/w1t64-both-tests`), and W1-T220 was rejected against
  #641's hand-authored `fix-coverage-ratchet-tempdir-pollution`. Both are the TERMINAL class sibling
  credit cannot reach: no run of the task owns the branch, so P29(i) will never credit them and
  `nextRunnable` re-selects them forever. The quarantine list also subsumes the #80/W1-T54b residue.
  Design unchanged; see the R9 block below.
- **P26 — TRIGGER FIRED (W1-T105 shipped #744) and the harvest is LIVE in this gather** — its first
  output is the ~100-item proposal-candidate list this retro mined. RE-RANKED BELOW P38/P39: the
  harvest works, and what it argues for is dispatch integrity BEFORE an issues mirror. Inbound half (b)
  is now buildable; outbound mirror (a) unchanged.
- **`blocked`×47 + `blocked_ci`×25 + `no_pr`×17 + `incomplete`×12 + `pr_attribution_failed`×12 — NO new
  proposal; 74 of 94 shipped tasks merged GATE-SIDE ⇒ P29/P30/P35/P39.** Fourth consecutive cycle in
  which the dominant "failure" classes are predominantly write-side credit artifacts. Re-mining them as
  classes would manufacture proposals from one root cause — the accretion failure mode P8 named. Note
  for P40: `blocked`×47 is also the largest UNMAPPED MAST class.
- **`blocked_containment`×6 — NO new proposal, and R10's "zero for a third cycle" line is DELETED as
  FALSIFIED.** All six are `containment/outside-cwd-denial` across W1-T209/T212/T230, which W1-T91's
  new guard-cause field (#719) classifies as a HOST signal and excludes from task defect counts. The
  guard fail-closed correctly each time. RE-CHECK NEXT RETRO: if the same check fires on a SECOND host,
  it is a task signal after all and earns its own proposal.
- **`failed`×6 + `blocked_isolation`×1 — NO new proposal; the honest remainder W1-T52's shipped triage
  (#308) owns.** One isolation trip at background rate is the designed fail-close (P27 resolved).
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
- **P31 — RESOLVED; COLLAPSED INTO P30; prose DELETED per RATIFY-OR-KILL.** R8's decisive test (*"19 of
  the 21 blocked_ci merged anyway — if that holds, P31 collapses into P30"*) held in R9 (6 of 8) and has
  held every cycle since. No separate task; the duplicate adjudication in the R8 block below is deleted.
- **`blocked`×3 + `incomplete`×1 + `no_pr`×1 — NO new proposal;** 2 of 3 merged gate-side ⇒ P30, and the
  remainder is W1-T52's shipped triage (#308). The R9 cost-rise re-check is DELETED — R10 answered it and
  R11 closed it (cost FELL to $6.664); keeping both readings is the duplication HARNESS-COMPRESSION forbids.

**RETRO-1784512714705 (prior cycle)** — mined from 195 runs / 28 gate-side merges / 0 ledger credits
(`incomplete`×111, `no_pr`×42, `blocked_ci`×21, `pr_attribution_failed`×12, `blocked`×5,
`blocked_containment`×2, `blocked_isolation`×2). Candidates for the Architect to ratify via a tasks.yaml PR
(rule 15) — never auto-filed.

- **★ P29 — RATIFIED 2026-07-20 -> W1-T149 (sibling-run credit liveness + a per-task dispatch circuit
  breaker; the ownership-assert PRESERVED). Design prose DELETED per RATIFY-OR-KILL — the task is the
  record, and it has been the record for four retros without being built.** THE HISTORY, kept in one
  line because every retro re-reads it: W1-T1 dispatched ~130 times over ~10 hours at ~$130 because its
  own merged PR #255 could not credit a SIBLING run of the same task; W1-T29 ×10; and this cycle 49
  credit rejections, ~39 of them the same shape. TWO durable lessons: **(a) the ownership-assert is
  CORRECT and must not be loosened** — it stopped R5's false-credit inversion and still does; **(b) a
  fail-closed integrity guard needs a LIVENESS counterpart, or the system pays for its own correctness
  forever.** The live re-grade is in the R11 block above; P39 is its dispatch-side half.
- **★ P30 — RATIFIED 2026-07-20 -> W1-T150, which SHIPPED 2026-07-21 (#358: the `rmd sweep` reconciler
  gains a level-triggered rung appending a `verdict.merged` correction for any task whose owned PR merged
  but is uncredited). Full prose DELETED per RATIFY-OR-KILL — the task and its PR are the record.** TWO
  things survive it. (a) The HISTORY that made the argument, kept as one line because each retro re-reads
  it: ledger-vs-GitHub ran R3 15-vs-17, R4 2-vs-6, R5 4-vs-4 (P11 closed on the GATHER, not the write
  side), R7 14-vs-14, R8 0-vs-28, R9 13-vs-21, R10 8-vs-23, **R11 20-vs-94**. (b) The open question the
  shipping did NOT close: **the metric still has not moved** — carried as P35, now folded into P38, which
  is P30's live descendant.
- **`incomplete`×111 + `no_pr`×42 + `pr_attribution_failed`×12 — NO new proposal; STORM RESIDUE, folded
  into P29.** These three classes account for 165 of 195 runs and their timestamps track the W1-T1/W1-T29
  redispatch cadence (~75–90s apart). They are not 165 independent failures; they are one defect counted
  165 times. Re-mining them as classes would manufacture proposals out of a single root cause — the
  accretion failure mode P8 named. INVESTIGATE only the residue that survives after P29 lands.
- **`blocked_containment`×2 + `blocked_isolation`×2 — NO new proposal; P27's resolution HELD.** Down from
  R7's ×5/×1 after #185 absorbed the Claude Code 2.1.214 pkill-wrapper drift. The cause-field ratified as
  W1-T91 SHIPPED 2026-07-29 (#719) and now classifies these events structurally — see the R11 block.
- **`blocked`×5 — NO new proposal; owned by W1-T52 (SHIPPED #308).** 4 of the 5 merged gate-side ⇒ P30
  again; the near-identical fold-line that sat in the R5 block below is DELETED as the duplicate it became.

**RETRO-1784383376396 (R7) — proposal block DELETED; every item reached a terminal status.** **P27**
RESOLVED 2026-07-18: the `blocked_isolation`×5 volume was ONE cause — a Claude Code 2.1.214 auto-update
adding a pkill wrapper the static allowlist predated (named by #184's probe, absorbed by #185); the
proposed host-hygiene fix was REFUTED by the name, and the guard fail-closed correctly on toolchain drift.
The resolution held through R8/R9/R10; **R11 recorded 6 containment trips on one host and 1 isolation trip
— re-graded there as a HOST signal, not a re-opening of P27.** Cause-field P23→W1-T91 SHIPPED (#719).
R7's remaining classes resolved NO-new-proposal; its blocked_ci caveat became P31, which collapsed into P30.

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
- **P12 — RATIFIED 2026-07-17 -> W1-T86, SHIPPED 2026-07-29 (#631 `rmd wipe-test`, the learning-utility
  A/B harness: injected learnings must be shown to help, or be pruned). Prose DELETED per RATIFY-OR-KILL.**
  ONE consequence kept because it is live: the harness now HAS the instrument and wrote **zero** learnings
  this cycle — see P38.
- **P13 — RATIFIED 2026-07-17 -> W1-T87, SHIPPED 2026-07-29 (#687 the retro mines SUCCESS: a clean
  single-strike merge becomes a procedural-memory candidate). Prose DELETED per RATIFY-OR-KILL.** Its first
  output is in this gather (`implement × clean_single_strike` ×10 runs) and was never written down — P38.
- **P14 — RATIFIED 2026-07-17 -> W1-T88, SHIPPED 2026-07-29 (#689 consolidation detects CONTRADICTION and
  marks contested pairs; supersession is never silent recency-overwrite). Prose DELETED per RATIFY-OR-KILL.**
- **P16 — RATIFIED 2026-07-16 -> W1-T69** (deriveStatus rung (c): anchored-trailer verify +
  ownership-assert + correction-awareness). Prose DELETED per RATIFY-OR-KILL. NOTE for P29: W1-T69 is the
  guard whose correctness is NOT in question — it is the missing sibling-credit counterpart that spins.
- **P17 — RATIFIED 2026-07-16 -> W1-T71 (`rmd receipt <pr>`: a deterministic in-toto-style attestation
  assembled from ledger ground truth, plus the byte-equal drift golden; Sigstore + the WS-12 schema publish
  deferred to v2). Design prose DELETED per RATIFY-OR-KILL — the task is the record. STILL UNBUILT.** The
  claim it makes literal is WS-12's: the ledger proves our runs to US and nothing proves them to anyone
  else, and the EU AI Act Art. 50 machine-readable-disclosure date (2026-08) is now one month out.
- **P18 — RATIFIED 2026-07-17 -> W1-T89, SHIPPED 2026-07-29 (#710: a deterministic verdict→MAST mapping
  held as DATA, applied at retro-read). Prose DELETED per RATIFY-OR-KILL.** Its first live output is this
  cycle's failure-by-category table — verification 54 / infrastructure 7 / specification 6 — and the 60
  runs it leaves honestly UNMAPPED are mined as P40. The WS-12 publish rung still ratifies with the site.
- P19 (plan -> WS-2 addendum) — RATIFIED 2026-07-20 -> W1-T170/W1-T171/W1-T172 (per-run isolated worker HOMES · the deterministic file-overlap pre-dispatch check, rung 1 · N parallel dispatch lanes bounded by the queue-governor WIP limit, N=2). TRIGGER FIRED: both prerequisites built — W1-T121 (#385, queue governor) and W1-T122 (#386, plan sharding). Rung 2 (Tree-sitter symbol-touch locks) stays BANKED until a rung-1 escape is observed in the ledger; W1-T172's `dispatch.concurrent_set` line is what makes that trigger answerable. HONESTY BOUND CARRIED: files: is advisory metadata a worker can exceed — the check reduces collision probability and is never a guarantee.
- **P20 — RATIFIED 2026-07-17 -> W1-T90, SHIPPED 2026-07-29 (#716: the policy-gated alert-fix lane —
  severity × path-class decides act-vs-escalate, the lane owns its run shape and never writes tasks.yaml).
  Prose DELETED per RATIFY-OR-KILL — the dep-lane precedent it extended is itself already the record.**
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
- **★ P24 — RATIFIED 2026-07-17 -> W1-T82/T83/T84/T85, and ALL FOUR SHIPPED 2026-07-29** (#683
  deterministic repo inventory → #698 recon + plan-artifact mining → #702 the planning session → #709
  synthesis to ONE ratifiable draft PR). **The nine-paragraph flow design is DELETED per RATIFY-OR-KILL —
  the four merged tasks are the record.** ONE positioning line kept because §6/WS-4 still reads it:
  brownfield onboarding is where the field's static-spec tools stop and an operational plan begins, and
  `rmd onboard` now produces the BRAIN while `rmd project init` installs the BAR.
- **P25 — RATIFIED 2026-07-18 -> W1-T110/W1-T111, and the WHOLE FAMILY HAS SINCE SHIPPED (#368 the rule-2
  readiness predicate + Architect-drafted candidates, #373 `rmd approve`/`rmd reframe` with approval-rate
  telemetry, #457 the draft rung moved daemon-side). P25 is CLOSED; full prose DELETED per RATIFY-OR-KILL
  — the tasks are the record.** ONE consequence kept because it is live: **W1-T111's telemetry is the
  instrument P28 named as its own graduation trigger**, and its first reading (1 approved / 3 reframed) is
  adjudicated in the R10 block above.
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
  test); a `candidate` issue yields exactly one cited proposal candidate and never a task. RE-RANKED below
  P38/P39 in the R11 block — the harvest works, and what its output argues for is dispatch integrity first.
- **P28 — RETIRED 2026-07-29, killed by its own instrument. Full design prose DELETED (git holds it).**
  P28 asked for graduated auto-ratification inside an operator-ratified policy envelope, and named
  W1-T111's approval telemetry as its own graduation trigger. The trigger fired TWICE, both readings
  negative: 25% approval at n=4 (R10), 21% at n=14 (R11), cumulative **4 approvals / 18 items ≈ 22%** with
  reframes outnumbering approvals ~4:1. Its own rule treats a reframe as NARROWING, so the data argues
  against the proposal. BANKED; re-openable only above 60% over ≥30 items. The rule-15 line it drew
  survives independently and is already doctrine: **the machine never ratifies on its own judgment — it
  acts within a policy the operator ratified once** (the dep-lane / alert-lane precedent, W1-T54 + W1-T90).
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
- P34 (presence-aware autonomy — envelope ratified per round-3: dispatch NOT presence-gated [presence×risk matrix dead]; a lightweight risk judge on the dispatch path [reusable for P28]; budget is subscription HEADROOM not dollars, 5% operator reserve / HEADROOM_LIMIT_PCT=95; model-efficiency per-class weekly-limit burn accounting; away-mode escalation delivery via the W1-T163 recap) — RATIFIED 2026-07-23 -> W1-T248 W1-T249 W1-T250 W1-T251.
- P37 (TIER-1 policy file — operating constants become schema-bounded, lint-gated plan data; proof timeout 60000 lifted / 30000 rejected; launchd ThrottleInterval net-new) — RATIFIED 2026-07-23 -> W1-T252, W1-T253.
