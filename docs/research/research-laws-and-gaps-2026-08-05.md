# Research: the laws this system has learned, and where its plan disagrees with its own evidence — 2026-08-05

Written at origin/main `88b6eb78efd6731b3ad1c0b49d739a3addc2f56f` (toplevel /home/user/remudero, branch
main; single `git -C` invocation). Read-only synthesis; no commits, branches, or PRs. Claims are marked
**DERIVED** (source, plan corpus, git history, GitHub, or this session's two operator-commissioned
audits), **ASSUMED** (from the brief), or **UNMEASURED** (operator-host ledger only — unreachable here;
any count needs the new idiom `find ~/Remudero/state -maxdepth 1 -name 'ledger*.ndjson*' -print0 |
xargs -0 zgrep -h '<pat>' 2>/dev/null | sort -u` with a positive control proving a `.gz` matched via
`zgrep -l`, because the 666 rotations are gzipped and non-cumulative with MAX_RETAINED_LINES_PER_STEP=200
— ~63% of `run.start` exists only in archives, ASSUMED per the brief). Evidence base: full corpus reads
by a seven-agent sweep at 88b6eb7 (139 shards, 133 feedback entries, DECISIONS.md, MASTER-PLAN, CLAUDE.md,
~1,400 commits, live lint-plan run), fused with this session's quality and decision-authority audits. The
~202 state/ agent reports are host-only: UNMEASURED, except where the corpus quotes them.

---

## Part 1 — The laws

Each stated so it predicts the next defect, then the evidence.

### LAW 1 — ZERO IS OVERLOADED. One law, three faces, six mechanisms, one missing channel.

**The law:** every boundary in this system speaks a vocabulary whose only word for trouble is the count
itself. "Empty because absent," "empty because my query was malformed," and "empty because the source
moved or died" are indistinguishable at 21 recorded boundaries — so any upstream failure that can be
demoted to an empty result WILL be, and the demotion is silent by construction.

**The census (DERIVED):** 21 confirmed instances at this sha across six mechanism classes —
line-oriented parses (`parseAcceptanceBlock` returning 1 criterion with an empty proof where 3 were
written — 22 of the 100 most recent PRs; the YAML-fold `grep:` wrap), substring/anchoring
(`resolveNameFilteredCandidates` judging a real passing test unexecutable on a concatenation seam;
case-mismatched patterns), demoted errors (`deriveStatus` rung (c) treating an exit-0 empty GitHub search
as authoritative not-merged — four phantom re-dispatches in one day; the reconciler consuming an empty
issue list for days while 79 issues sat open — `board_gateway.issue_fetch_ok` zero against 505 failures),
optional-field gates (`escalate()`'s dedup skipped whenever no PR reference parses — eight byte-identical
issues), truthiness-on-count (`if (actionable.length)` writing NO survey line on a total predicate
mismatch — 9.4 GB invisible for two days; the `length === 0` repair trigger missing the `length === 1`
defect it was built for), and representation drift under a fixed query (tonight's purest case: the
rotations became `.gz` and every `ledger.*.ndjson` glob kept answering from 2.8% of the data — three
figures retracted in one day). Two briefed instances could not be located in-tree (the `value: 1`
substring case; the exact 2.8% figure's report is host-only): UNVERIFIED as specific artifacts, the
mechanism classes confirmed by in-tree siblings.

**Three faces, one absence:** (A) *undercount-as-answer* — the shortfall reads as a legitimate result
(21 of 23 rows). (B) *self-hiding observability* — guards and ledger lines gated on `count > 0` mean the
zero case writes no record, so **the law protects its own instances from detection: every discovery in
the census was a human noticing a number was too small; not one was a gate.** (C) *absence-as-success*,
the inverse sign — a zero name-filter match runs the WHOLE suite (#1111); `node --test` emits `ok 1` on
zero matches (#981); `grep -r` with no file operand searches the cwd. Same missing channel, opposite
polarity.

**Prediction:** the next silent defect sits at a boundary where a query that can LEGITIMATELY return
empty (routine here: forward-referenced proofs, unmerged PRs, empty sweeps) meets a consumer with no
out-of-band failure signal; it will be triggered by an environment shift the query predates (a format
change, a quota, a rename — the gzip event's shape) rather than a code edit; it will undercount rather
than crash; and a human doing arithmetic will find it, not CI. **Every remedy that stuck has the same
shape:** a second channel (indeterminate/`readFailed`/throw-on-gateway-failure/`base_unknown`) plus a
positive control. The fix is not 21 patches; it is making the second channel the house idiom at
boundaries (Part 3, proposal 1).

### LAW 2 — THE LAST MILE IS NOBODY'S PR — refined: the proof's WORLD, not the claim's TENSE.

**The law:** a unit ships dark unless the SAME PR contains its production call site — and the mechanism
is now precisely understood. Rule 13's proof menu is disjunctive ("gh api output, a status object, a grep
of the call site, a passing test") **with no requirement that the chosen proof's execution environment
CONTAIN what the claim quantifies over.** Under `tdd: strict`, "a passing test" falls out of mandated
work at marginal cost zero — so it was chosen five out of five times in the sampled organ shipping
histories (W1-T21, W1-T22, W1-T117, W1-T20d, W1-T313), including two whose acceptance claims were
present-tense claims about the live system, correctly worded, and still discharged against injected
fakes. Rule 14's demanded act ("name the integration point") discharges into prose — a build-order note,
a module-doc confession of "follow-on integration work" (merged INSIDE the orphan itself), a doc comment
claiming a `--dry-run` caller that never existed — and per W1-T322's rationale, 18 such comments were
"every one born false in the merging commit... no test, type error, or ledger line ever contradicts the
comment."

**The rate (DERIVED, and the good news):** closures outran births ~3:1 since the 08-04 audit — NINE
organ-wirings merged in ~37 hours (#1277 queue governor, #1278 crash loop, #1321 ceiling display read,
#1363 daemon lanes, #1372 summarizer ×2, #1385 GRILL, #1393 orphan sweep, #1397 resolver — the last two
from this session's filings, wired within hours). Births in the window: 3 — the floor caught two at
review (#1312's ceiling writers), and one shipped THROUGH it unfiled: `resolveFeedbackExpansionMount`
(W1-T350/#1378, merged today) — a new organ born from this session's own interpreter arc. Surviving
organs: 8 fully unreached (flight-signals, flight-judge, planHealthSweep, judgeRubric, checkBinaryPin,
reconstructState, scoreRisk/planRiskGate, the ceiling writers) + 1 half-closed (ceiling: display read
wired, enforcement read still on the committed row) — every one with a filed disposition except
`scoreRisk/planRiskGate` and the newborn. **The caution: the closure engine is the AUDIT cadence
(one-off, session-driven), not the floor (advisory by contract — W1-T323's blocking flip is filed and
parked) and not the linter (its `callSiteViolations` check exists and demands a cross-file call-site
criterion on new-module tasks — at severity WARN).** The rate falls while audits run; nothing yet makes
it fall on its own.

### LAW 3 — THE DECOUPLED TRIGGER: a guard whose signal is not causally coupled to its event disarms
itself, preferentially during the incident it was built for.

**The law, refined from eleven instances (DERIVED):** five decoupling modes — (a) *consumed-without-
delivery*: the trigger entitlement is cleared by a path variant that skips the protected act (W1-T380's
dry-run deploy consuming the idle ceiling and restarting nothing, fixed #1392; pre-#1054's operator
`git pull` consuming the deploy trigger); (b) *frozen proxy*: the signal is a stand-in the protected
activity structurally never writes (W1-T378's reaper age-gating on a root-dir mtime that nested edits
never touch, fixed #1391); (c) *wrong failure signature*: the guard models absence while the real defect
emits degenerate presence (#1355's `length === 0` repair vs the `length === 1, proof: ""` defect — which
is Law 1 Face B feeding Law 3); (d) *self-erased evidence*: the dedup key or episode marker lives in
ledger lines the system's own housekeeping rotates, gzips, or writes AFTER the reader runs
(`armIfVerdictPermits` reading a line its own caller had not yet written — four PRs in three hours;
`ABSENT_REPUSH_CAP` reset by rotation; tonight's gzip event); (e) *success-gated observability*: the
diagnostic only emits when the mechanism found something, so total predicate failure is invisible
(`logCloneReapSurvey`). **Prediction:** such a mechanism passes its demo and its calm-weather operation —
where signal and event coincide — and fails exactly once it matters, with output that is invisible or
actively misleading (`would_kickstart: true`, a clean reap row); it is rediscovered forensically. Audit
question for any new guard: *who produces your trigger signal, and can the failure you guard against
silence it?*

### LAW 4 — CONVENTIONS BIND WHERE THEY ARE VERIFIABLE AT INVOCATION. (The falsifier/rule-14 paradox,
resolved.)

The falsifier convention out-caught six instruments because "revert and watch it fail" is run twice, by
the author, in one worktree, in minutes, and its output SELF-ADJUDICATES — vacuity is visible at that
moment. Rule-14 compliance is a SENTENCE about another PR: **you cannot revert a promise and watch
anything fail.** Same repo, same workers, same week — the prose that thrives demands an act checkable at
the moment of writing; the prose that rots demands a claim whose truth lives elsewhere or later. This
also explains Law 2's menu economics and predicts which future conventions will hold (the PR-body
Acceptance block: self-checked, held; the "follow-ups:" trailer: unconsumed for 21 days — W1-T368's
finding, DERIVED). Instruments inherit the same split: gates that check the diff in front of them hold;
gates that check a name for a thing elsewhere (step names vs what functions return — the `automerge.armed`
blind rows) rot.

### LAW 5 — RECORDS LAUNDER AUTHORITY UNLESS THE AUTHOR CLASS RIDES THE RECORD. (Named by this
session's audit; no plan document carries it as a law.)

Unmarked records read as ratified; origin tags carry commission, not intent; one GitHub identity signs
both human and machine acts. Now partially mechanized — and the mechanism has already fired: the
`ruling-verify` lint (W1-T353, merged) counts exactly ONE violation in today's lint run, and it is
**W1-T326 itself** — the incident that motivated the rule, caught retroactively. The merge/comment
identity layer remains open (the deferred separate-agent-account question). **Prediction:** any new
record channel added without a mandatory author-class mark will, within weeks, carry a machine conclusion
a later reader treats as an operator ruling — the feedback queue already did (five rulings in a draining
queue, re-record filed as W1-T355).

## Part 2 — Where the plan disagrees with its own evidence

### 2a. MASTER-PLAN's capability prose cannot stay true at this merge rate — measured, not argued.

The sharpest possible demonstration (DERIVED): this session corrected the daemon-lanes sentence on 08-05
morning. By evening it was false again — **the truth changed four times in one day** (dark → lanes wired
#1363 → `dispatchLanes: 2` #1365 → 3 #1383 → back to 2 #1394 after the N=3 watch found deploy-deferral
starvation). At 88b6eb7 the sentence still claims "dispatches ONE task at a time... lanes build dark,"
while the daemon runs two lanes live. Also standing: the `nextRunnable` declaration-ordered claim (false
since #1072, RE-CARRIED FORWARD by the R15 retro sync #1328 four days later — an agent-written sync
inheriting a stale claim, Law 1's cousin in prose); the recon-cap literal (now 20, doc says otherwise);
the "Dependabot PR is UNMERGEABLE today" claim (the dep-review lane is built and live). Ranked list in
the sweep. **The disagreement with evidence:** the plan's own §5E doctrine says never record a FAST answer
in a SLOW shape — but present-tense capability prose in a hand-maintained document IS a fast answer wearing
a slow shape, at 50–70 merges/day. Three truth-audit corrections in one week treated instances; nothing
treats the class (Part 3, proposal 3).

### 2b. The 176 open-failing number is a graveyard wearing a backlog's clothes.

Live run at 88b6eb7 (DERIVED): 375 open tasks checked — 176 failing records (174 unique ids), 554
warnings. Composition: **~77% (≈136) are ZOMBIES** — merged work whose decorative `status:` was never
flipped, invisible to trailer-rungs (the gate-side merge path writes no verdict); **~22% (≈39) are real,
still-dispatchable work with broken proofs**, all in the pre-shard monolith (61 dialect + 42 resolvability
violations — the costly kind: resolvability-only failures DISPATCH and burn a full run into a CAPPED
verdict); **one is the live governance catch** (W1-T326/ruling-verify). Era analysis: ZERO failures in the
W1-T246..T325 band — **the gates now prevent new debt entirely; the number can only fall.** The repo has
already measured and part-ruled this: W1-T370's controlled census, W1-T369's bulk rewrite of the 39
($80 budget), and a standing ruling that the 136 merged-task records drain by attrition — each taxing
whichever future PR touches its row. The evidence says attrition is the expensive option: five dispatches
died on files-list violations this week alone, and every touched zombie promotes its violations to
blocking. Retirement is filed; its priority is what disagrees with the evidence.

### 2c. The queue was never the constraint. Dispatch HEALTH was — and priorities converged late.

Day-by-day (DERIVED from git/GitHub; ledger figures corpus-quoted): 07-30, 36 merges — the arm gate
fail-closing on its own unwritten ledger line; 07-31, 42 — phantom re-dispatch storms (five same-day
W1-T254 no-op closures) plus a 7.6h zero-merge hole; 08-01, 51 — the deploy running stale code invisibly
(#1054); 08-02, 49 — a silently dead daemon, the week's biggest hole (~10h); 08-03, 70 — recon deaths
emptied the queue (11 of 18 recons killed by the turn cap: the ONE day the queue looked binding, and the
harness did it); 08-04, 54 — spend ($84.50/zero output forced the governor wirings); 08-05, 68 — quota
exhaustion plus a fleet that could not deploy its own fixes. The operator's own measured numbers govern:
~60% idle, ~17% of dispatches producing a merge. **Priority match: a real mismatch through 08-03 — the
fleet refined what a REVIEW may pass (five review-gate features in the window) while nothing bounded what
DISPATCH could spend, and ~a third of all merges were plan bookkeeping — converging genuinely on
08-04/05** (dispatch/deploy/governor merges rose 28 → 38; the parallelism chain landed; N=2 is live).
The plan's residual disagreement: review-side polish tasks still outnumber dispatch-health tasks in the
open queue (DERIVED from the by-check composition), while every hole in the table above was
dispatch-side.

## Part 3 — The industry question, answered honestly

**Already tried here, with outcomes (DERIVED):** multi-agent critic/debate — this repo has a reviewer
(mechanical on ~90% of runs by its own measurement), a risk judge (wired, plan-coherence-blind by
design), a specialist panel (W2-T1: merged #145, sits in the zombie pool), a flight judge (built, never
reached), and a GRILL lane (the one that worked); more debate agents would add spend to the two layers
already unreached. Vector memory over past runs — the ledger IS the memory and tonight proved the failure
mode is READING it (the gzip idiom), not storing it; embeddings would add a second store with the same
read problem and none of the ledger's auditability. Planner/executor separation — is the architecture
(plan/dispatch split, Architect vs worker). Self-consistency sampling — multiplies spend against a
ceiling that fired at $152.28 this week, to improve the maker layer when the measured defects are in the
CHECKING layer. None of these addresses a Part-1 law. Three things do:

**PROPOSAL 1 — the Outcome-typed boundary (Law 1), replacing per-instance whack-a-mole.** One house
type at read boundaries: every search/parse/list that can return empty returns
`{kind: found|absent|query_invalid|source_unreachable}` (the repo already built this locally four times:
`indeterminate`/`readFailed` in status, `base_unknown` in W1-T362's design, throw-on-gateway-failure in
the reconciler fix, `PolicyError` fallback provenance) — plus the CLAUDE.md rule that already exists
informally: **no zero enters a decision without a positive control.** Cost: one task per top boundary
(the census names the five hottest: proof resolution, GitHub reads, ledger reads, plan parses, sweep
predicates), each small. REPLACES: the 21-instance patch treadmill and its future — four instances landed
in the last 24h alone; three retractions today were this law's tax. This is the highest-leverage change
not already in motion.

**PROPOSAL 2 — scope containment for proofs (Laws 2+4), replacing the blocking-flip debate.** Amend rule
13 and the linter's `callSiteViolations` check with one sentence: *a proof's execution environment must
contain what its claim quantifies over* — a claim about the live system cannot be discharged by a test
that injects the binding it asserts. Mechanically: new-module tasks' call-site criterion becomes
`grep: <symbol>( in <consumer>` (already the check's own recommended form) at severity BLOCK, and
"a passing test" stops satisfying present-tense wiring claims. REPLACES: W1-T323's advisory-to-blocking
flip for the floor (subsumed — the floor stays advisory telemetry; the LINT stops the organ before it
ships), and the audit-cadence dependence of Law 2's closure rate. Cost: one linter change plus the rule
amendment; the falsifier is whether the next `resolveFeedbackExpansionMount`-shaped birth gets refused
at filing.

**PROPOSAL 3 — generated capability prose (Part 2a), replacing hand-truth-audits.** MASTER-PLAN's
present-tense NET STATE claims become either generated-from-source on the plan-index/ORIENTATION
precedent (the repo already generates both) or carry mandatory `as-of <sha>` stamps that the retro
refreshes mechanically. REPLACES: the truth-audit filing cadence (three corrections this week, one of
which was stale within hours) and the R15-class inheritance of dead claims by retro syncs. Cost: one
generator task plus a one-time NET STATE conversion; the falsifier is the lanes sentence — if it can be
wrong again after conversion, the generator failed.

## Closing — the single change

**Retiring work is the biggest win and it is already in motion** (W1-T369/W1-T370 filed, the ruling on
attrition stands; honesty forbids claiming in-motion work as this report's change — though this report's
evidence argues for PROMOTING the zombie retirement above attrition: five dispatches died on zombie-row
taxes this week). **The single change this report adds: Proposal 1, the Outcome-typed boundary with the
no-naked-zero control rule.** What it costs: roughly five small tasks and one CLAUDE.md sentence —
against a defect class with 21 recorded instances, four in the last day, that blinded three measurements
today and whose Face B means no gate will ever catch it from inside. What would falsify the reasoning:
if, after the five hottest boundaries carry the type, the next quarter's silent-undercount incidents do
NOT drop to near zero — or if the type degenerates into `kind` being set and never read (Law 2 eating
Proposal 1 — the falsifier's falsifier, which is exactly what Proposal 2 exists to prevent) — then the
law was mis-stated: the problem would be deeper than the channel, in the culture of consuming answers
without interrogating their provenance, and no type can fix that.

---

## Plain language

This system has figured out something most people building agent fleets have not: the hard part is not
making the machine act — it is making the machine's silences honest. Its worst bugs were never crashes;
they were quiet undercounts — a parser that found one item where three were written, a search that came
back empty because the files had been renamed, a guard that never fired because the thing it watched was
frozen by the very failure it guarded against. Every one was found by a person noticing a number felt
small, never by the safety net, because the safety nets were wired to speak only when they found
something. It has also learned that written promises rot in a specific place: a rule someone can check
the moment they write it gets followed; a promise about work that belongs to a future nobody gets
quietly broken, every time. And it has learned to make its own record say who decided — a machine that
writes in its owner's voice will eventually close a question its owner was still asking. What is it
still getting wrong? Its description of itself lags what it actually is — the manual changed four times
in a day and was wrong by nightfall — and its to-do list is three-quarters gravestones: finished work
never crossed off, taxing everyone who walks past. The next real improvement is not another clever
pattern from the literature; it is teaching every part of the machine to say "I found nothing, and here
is whether that means nothing was there, or I asked the wrong question, or I could not see" — because
almost every lie this machine ever told began as an empty answer mistaken for a true one.
