# wipe-test.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/wipe-test.ts` when its comments were compacted to the plain-language standard. Every
block below is the removed text verbatim, marker characters stripped and nothing else changed.
Headings name the symbol the text explained; the code keeps a one-line `Why:` pointer where the
history mattered. Base revision: origin/main at 8945bb7c60b463feb457974d77554882feb8391b; the
line numbers below are that revision's.

## Module header

### Base lines 12-89 — `rmd wipe-test` — the learning-utility…

`rmd wipe-test` — the learning-utility A/B harness (ratifies P12, MASTER-PLAN
§Self-improvement, W1-T86).

W1-T19 injects task-matched LEARNINGS into every implement prompt (learnings.ts),
but nothing measures whether that injection changes an outcome — the claim "memory
helps" was unfalsifiable. The WIPE TEST [research: self-evolving-agents-2026] is the
falsifier this module implements: run the SAME task twice —
  ARM A (unmasked): normal injection, exactly what `runTaskBody` (run-task.ts) does
    today — {@link loadLayeredLearningsForTaskFiles} → {@link selectLearnings} →
    {@link renderMatchedLearnings}.
  ARM B (masked): injection returns "" — the STORE ITSELF IS NEVER TOUCHED (masking,
    not deletion). {@link computeMatchedLearningsForArm} enforces this at the type
    level: arm "B" returns before any of `deps`' three functions are ever called, so
    a test spying on those deps can prove zero reads reached the corpus.
— and report the deltas (turns/cost/verdict/strikes/proof_exec) between the two runs.

PAIRING DISCIPLINE (the design's own words): a single pair is an anecdote. Only the
AGGREGATE over many seeded pairs ({@link aggregateWipeTestPairs}) is treated as
signal; each pair is ledgered ({@link ledgerWipeTestPair}, step `"wipetest.pair"`)
so the aggregate can be recomputed from the ledger at any time, not just from
whatever pairs happen to be in memory in one process.

SANDBOX-ONLY BY DEFAULT: {@link resolveWipeTestTarget} refuses to target anything
but the sandbox unless the operator explicitly opts out — a wipe-test run burns
real budget running a task TWICE, and must never silently land on the primary repo.

This module is the HARNESS. Running the experiment (scheduling real pairs against
the sandbox, reading the aggregate) is an operator action (Rule 18) — see `rmd
wipe-test`'s CLI wiring in run-task.ts.

SUBJECT SUPPLY (W1-T1253): "many seeded pairs" needs SUBJECTS to seed pairs with, and
a hand-written list (the sandbox's original three tasks) runs out — worse, once its
work has already merged, re-running it is not a subject at all, just a repeat.
{@link generateSandboxTask} is that supply: given the shard filenames
(`learnings/index.json`'s keys) a subject should select and an ever-incrementing `seq`,
it builds a FRESH `files:` list from the real project-layer corpus, never from a fixed
roster. A subject is defined by the shards its `files:` select, not by its prose
(injection is task-matched — {@link loadLayeredLearningsForTaskFiles} delegates to
`learnings.ts`'s `candidateShardFiles`), and that mapping is many-to-many (one path can
select two shards at once), so {@link generateSandboxTask} always reports the shards a
subject REALLY selects by re-running the same lookup injection itself uses, never by
reasoning about which path was picked.
NEVER LEDGER A PAIR NEITHER ARM MEASURED (W1-T1252). Every sandbox subject can end up
already-merged, in which case `runTask`'s own W1-T319 guard refuses BOTH arms at zero
cost (`task_already_merged`) — a pair of two refusals, not a comparison. Two guards
exist because neither alone sees every cause (design note (iii)):
  (i) A PRE-FLIGHT, before either arm spawns — {@link resolveWipeTestPreflight}, PURE,
      consulted by `wipeTestCommand` once it knows whether the projection already
      reports the subject merged. Refuses up front, naming the reason; neither arm is
      dispatched and no `wipetest.pair` line is written.
  (ii) A LEDGER-TIME BACKSTOP for every OTHER zero-work cause (`blocked_transient`, a
       linter refusal, a spawn that never happened) — {@link ledgerWipeTestPair} itself
       refuses to write a pair whose two arms both report zero turns AND zero cost.
`--rerun` passthrough is deliberately NOT built here (design note (iv)): it would have
to reach both arms atomically or it manufactures a result, and this task is scoped to
refusing non-measurements, not to un-blocking the harness.

A FACTOR NAMES *WHAT* AN ARM VARIES (W1-T2512). `WipeTestArm` ("A"|"B") is only a POSITION;
until this task, exactly one thing was ever hard-coded behind position B —
{@link computeMatchedLearningsForArm}'s masked injection. `WipeTestFactor` names that
choice explicitly ({@link WIPE_TEST_FACTORS}: `"learnings"` | `"recon"`) so a second
factor — RECON, the single most expensive per-dispatch cost this harness can reach (a
whole worker spawn, `RECON_MAX_TURNS`-capped, routed through `routes.recon`) — has a seam
at every site the learnings factor already lives: {@link wipeTestFactorMasksLearnings} /
{@link wipeTestFactorMasksRecon} are the pure decision `run-task.ts`'s arm dispatch consults
(generalising the old `arm === "B" ? { maskLearnings: true } : {}` one-liner into two
independent per-factor checks), {@link WipeTestPair}/{@link WipeTestDelta} carry `factor` so
a ledgered pair says WHICH factor it varied, and {@link aggregateWipeTestPairs} REFUSES to
average pairs across factors — an aggregate is only ever signal for ONE factor at a time.
`factor` is OPTIONAL on {@link WipeTestPair} and read via {@link wipeTestPairFactor}
(default `"learnings"`) so every pair ledgered before this task — and every hand-seeded
fixture in the existing test suite — still means exactly what it meant: the only factor
that existed then. THE RECON FACTOR MASKS, NEVER DELETES, same discipline as learnings: arm
B of a recon-factor pair skips the recon spawn entirely (see `run-task.ts`'s `opts.maskRecon`)
and never reads or writes the recon artifact store (`loadReconArtifact`/`writeReconArtifact`
both sit inside the branch `maskRecon` skips outright) — masking the WORK, not the STORE.

## WipeTestFactor

### Base lines 95-102 — WHICH FACTOR a wipe-test pair…

WHICH FACTOR a wipe-test pair varies (W1-T2512) — the thing arm B masks. `"learnings"` is
the original (and, before this task, ONLY) factor: {@link computeMatchedLearningsForArm}
masks task-matched learnings injection. `"recon"` is the new one this task adds: masks the
recon worker spawn (`run-task.ts`'s `opts.maskRecon`) — the largest per-dispatch cost this
harness can now ask about, per this task's own filing (a whole worker spawn vs. text in a
prompt).

## WIPE_TEST_FACTORS

### Base lines 105-107 — Every factor `rmd wipe-test --factor`…

Every factor `rmd wipe-test --factor <name>` accepts — the ONE place the roster lives, so
{@link resolveWipeTestFactor}'s validation and any future listing (`rmd --help`) read the
same set rather than two hand-copies drifting apart.

## wipeTestFactorMasksLearnings

### Base lines 110-114 — Does arm `arm` of…

Does arm `arm` of a `factor`-factor pair mask LEARNINGS injection? Pure — the single
decision point `run-task.ts`'s arm dispatch consults in place of the old hard-coded
`arm === "B" ? { maskLearnings: true } : {}`. True only for `factor: "learnings"`, arm
`"B"` — a recon-factor pair's arm B never touches learnings, and vice versa: EXACTLY ONE
factor is masked per pair, never both, never neither (on arm B).

## wipeTestFactorMasksRecon

### Base lines 119-121 — Does arm `arm` of…

Does arm `arm` of a `factor`-factor pair mask RECON (skip the spawn entirely)? Pure
sibling of {@link wipeTestFactorMasksLearnings} — same shape, opposite factor. True only
for `factor: "recon"`, arm `"B"`.

## computeMatchedLearningsForArm

### Base lines 160-166 — Compute the matched-learnings text…

Compute the matched-learnings text (and its bookkeeping) for ONE arm of a wipe-test
pair. Arm "B" returns {@link MASKED_RESULT} WITHOUT calling any of `deps` — the store
(`learnings/*.yaml`, the user-overall home, the global artifact) is never opened, let
alone written; only the injected TEXT is forced empty. Arm "A" runs the exact chain
`runTaskBody` uses for a normal (non-wipe-test) run.

## WipeTestRunResult

### Base lines 185-190 — One arm's outcome —…

One arm's outcome — the fields the design calls out ("reports deltas: num_turns,
notional cost, verdict, strike count, proof_exec"). {@link RunResult} itself
carries only verdict/costUsd (see run-result.ts's own doc for why the others live
only on the ledger); this is the richer shape a wipe-test pair needs, built either
by hand (fixtures, tests) or derived from a real run via
{@link deriveWipeTestRunResult}.

## WipeTestPair.factor

### Base lines 204-207 — W1-T2512: WHICH factor this…

W1-T2512: WHICH factor this pair varied. OPTIONAL — every pair ledgered, or hand-seeded
in a test fixture, before this task never named a factor because only one existed; that
silence still means "learnings" (see {@link wipeTestPairFactor}), never a new unknown
default. Set explicitly by `wipeTestCommand`'s `--factor` resolution on every NEW pair.

## armDidNoWork

### Base lines 267-269 — Did this one arm…

Did this one arm do any measurable work at all? Zero turns AND zero cost means no
worker ever ran — whatever the verdict says caused it (`task_already_merged`,
`blocked_transient`, a linter refusal, a spawn that never happened).

## isWipeTestNullPair

### Base lines 274-278 — THE LEDGER-TIME BACKSTOP (design…

THE LEDGER-TIME BACKSTOP (design note (ii)): a pair is a non-measurement, whatever
produced it, when NEITHER arm did any work — the pre-flight ({@link
resolveWipeTestPreflight}) catches the one cause it can see (merged-by-id) BEFORE
either arm spawns; this catches every other cause, AFTER both arms have already
returned, so it must run regardless of which guard the pre-flight itself missed.

## ledgerWipeTestPair

### Base lines 283-292 — Compute + LEDGER one…

Compute + LEDGER one pair's deltas (one `wipetest.pair` NDJSON line), returning the
same delta the ledger line carries. Pairing discipline (the design's own words):
this is ONE data point — an anecdote — never itself a verdict on whether learnings
help; only {@link aggregateWipeTestPairs} over many ledgered pairs is signal.

NEVER WRITES A NULL PAIR (W1-T1252 design note (ii)): when {@link isWipeTestNullPair}
holds — both arms report zero turns and zero cost — this returns the (still pure,
still computed) delta for the caller's own reporting, but performs NO ledger I/O at
all: the ledger is left byte-for-byte as it was. An aggregate that averaged in
fabricated zeroes would be worse than an aggregate with fewer points (rationale (5)).

### Base lines 300-303 — W1-T2512: named explicitly so…

W1-T2512: named explicitly so a reader of the ledger — not just of the in-memory pair —
knows WHICH factor this row varied. A row written before this task carries no `factor`
key at all; `wipeTestPairFactor`'s "absent means learnings" default is what makes such a
row still aggregate correctly (see `aggregateWipeTestPairs`'s own doc).

## WipeTestAggregate

### Base lines 321-327 — The aggregate over N…

The aggregate over N pairs — THE publishable learning-utility number (the design's
own framing: "the WS-12 receipts thesis applied to memory"). A single pair is an
anecdote; this is signal.

W1-T2512: which factor EVERY pair in this aggregate varied — `null` only for the
zero-pair empty aggregate, where no factor was observed at all. Never a mix: see
{@link aggregateWipeTestPairs}'s own doc for the refusal that makes this guarantee hold.

## aggregateWipeTestPairs

### Base lines 347-362 — Aggregate many seeded pairs…

Aggregate many seeded pairs into ONE report — mirrors retro.ts's
`aggregateByType`/`aggregateByClass` shape (map → reduce → round). Zero pairs is a
well-defined, non-throwing empty aggregate, never a NaN.

NEVER MIXES TWO FACTORS INTO ONE REPORT (W1-T2512): every pair's factor is read via
{@link wipeTestPairFactor} (so a pre-this-task pair with no `factor` field reads as
`"learnings"`, unchanged); if the pairs passed in name MORE THAN ONE distinct factor, this
throws rather than silently averaging a learnings delta together with a recon delta — two
numbers that answer different questions have no shared unit. THE AGGREGATE CAN STILL BE
TAKEN PER FACTOR: filter `pairs` to one factor before calling (e.g. `pairs.filter((p) =>
wipeTestPairFactor(p) === "recon")`), the same way a caller already filters by `taskId`
today. Reading pairs back off the ledger and grouping by `step === WIPE_TEST_PAIR_STEP`
carries this straight through: a ledger row's own `factor` cell (or its absence) is what
`wipeTestPairFactor` reads.

## SandboxSubject

### Base lines 390-403 — One synthetic wipe-test subject…

One synthetic wipe-test subject for the SANDBOX target: a `files:` list a generated task
record would carry, plus the shard filenames those files ACTUALLY select.

`id`: Ever-distinct id — see {@link generateSandboxTask}'s `seq` param; never drawn from a
fixed roster, so it never runs out the way the sandbox's original three tasks did.

`files`: The `files:` a task record built from this subject would carry.

`selectedShards`: The shard filenames `files` ACTUALLY select, per {@link candidateShardFiles} run
against the real `index` — design (ii): the mapping is many-to-many (one path can
select two shards at once), so this is always the real lookup's output, never a
count of the paths that were picked.

## isolatingPathsByShard

### Base lines 411-415 — One literal path per…

One literal path per shard in `index` that selects THAT shard and no other — found by
actually RUNNING {@link candidateShardFiles} over every literal glob the corpus carries
(design ii: never reason about paths, always ask the real lookup), so it stays correct
as the corpus grows or its many-to-many overlaps shift. A shard with no isolating
literal path in the current corpus is simply absent from the returned map.

## generateSandboxTask

### Base lines 443-460 — Generate ONE fresh sandbox…

Generate ONE fresh sandbox subject that selects EXACTLY `shards` (design i/ii/iii): a new
`files:` list synthesized from the real project-layer corpus (`index`, i.e. a loaded
`learnings/index.json`), never a hand-written subject list that runs out. PURE — no I/O
beyond the already-loaded `index` — so `seq` (an ever-incrementing counter) is the
caller's job; nothing here reads a clock or randomness, so it stays unit-testable against
hand-seeded fixtures exactly like this module's other pure functions.

Prefers a SINGLE literal path that reaches `shards` exactly in one hop (the corpus's
many-to-many globs make this possible — e.g. one path for both `ci.yaml` and
`failures.yaml`); falls back to the union of one per-shard ISOLATING path (a path
selecting that shard and no other), which the real project-layer corpus provides for
every shard today (architecture/ci/failures/platform/testing each have at least one).

Throws (never silently returns a wrong subject) if `shards` is empty, names a shard
`index` does not carry, or some requested shard has neither an exact multi-shard path
nor an isolating one in the current corpus.

## resolveWipeTestArmPermission

### Base lines 497-518 — OPERATOR RULING 2026-08-23 (W1-T1256,…

OPERATOR RULING 2026-08-23 (W1-T1256, design note (iv)): NEITHER WIPE-TEST ARM MAY ARM OR
MERGE ITS OWN PR. The chain this closes: arm A succeeds -> arm A's PR merges -> `origin/main`
moves -> `projectPlan` reports the subject merged -> arm B's own already-merged read
(`runTask`'s W1-T319 guard) refuses arm B at zero cost. A SUCCESSFUL ARM A DESTROYS ITS OWN
CONTROL, and no LOCAL reset reaches this: arm A's pushed run branch and open PR are REMOTE
objects, `task_already_merged` reads them through `projectPlan`/the ledger, and
`worktreeAdd(…, "origin/main")` means a merged arm A moves the very ref arm B's worktree is
cut from — a fresh clone or `reset --hard origin/main` both clone/reset TO the contaminated
state (design note (iii)). The ruling instead measures the pair AT THE VERDICT: every
quantity `wipetest.pair` records — turns, cost, verdict, strikes, proof_exec — is already
determined before any merge, so refusing to arm loses no signal.

PURE (design note (ix), DECISIONS SPLIT FROM I/O): the ONE bit `run-task.ts`'s deferred
arm-at-verdict call site already knows — its own `opts.noMerge` — decides. `run-task.ts`
never re-derives this decision or duplicates its wording; it calls this function immediately
before it would otherwise call `armAutoMergeAtOpen` and skips that call outright when this
refuses. That split is what lets the falsifier (test/wipe-test-arm-isolation.test.ts) drive
both directions without a network: boundary present → arm B still dispatches and never
observes a merged verdict; boundary REMOVED (the test's own control, `noMerge: false`) →
arm B demonstrably refuses, reproducing the exact contamination this task fixes.

## resolveWipeTestArmOrder

### Base lines 537-550 — NOT A FIX (design…

NOT A FIX (design note (vii) says so explicitly, and it survives the no-merge-boundary
ruling) — a GUARD against a residual or unknown leak the boundary above does not name. Arm A
(learnings ON) dispatching first on every pair, unconditionally, would make any such leak
SYSTEMATIC and one-directional; alternating converts a fixed bias into random error — still
not clean, but strictly better than a fixed order, and it makes a leak visible as scatter
instead of drift.

PURE: `pairIndex` is the caller's own count of pairs already ledgered for this task (parity,
not identity, decides which arm dispatches first) — this never reads the ledger itself, so a
test drives both orders without I/O. The returned tuple is DISPATCH order only; it never
changes which arm is semantically "A" (learnings-on) vs "B" (masked) — `wipeTestCommand`
still assembles the pair's `armA`/`armB` fields by arm identity, not by call order.

## WIPE_TEST_SANDBOX_DEFAULT

### Base lines 557-560 — The default (and, without…

The default (and, without an explicit override, ONLY) repo `rmd wipe-test` targets.
A wipe-test run dispatches a real task TWICE — real budget, real PRs — so it must
never silently land on the primary repo (same fail-loud-control-surface doctrine as
`resolveDaemonTarget`, run-task.ts).

## resolveWipeTestFactor

### Base lines 600-610 — Resolve WHICH FACTOR `rmd`…

Resolve WHICH FACTOR `rmd wipe-test --factor <name>` varies (W1-T2512) — PURE, same shape
as {@link resolveWipeTestTarget} right above (a `--flag` lookup over the raw argv tail,
defaulted, validated, refused loud on junk — the fail-loud-control-surface doctrine this
module's other CLI-facing resolvers already keep). Omitted `--factor` defaults to
`"learnings"` — the ONLY factor that existed before this task — so every existing
`wipeTestCommand` invocation with no `--factor` behaves BYTE-IDENTICALLY to before. An
unrecognized value is refused (never silently coerced to the default): the same command
that fell through to an unattended drain on an unknown subcommand must not fall through to
measuring the wrong factor on an unknown `--factor`.

## resolveWipeTestPreflight

### Base lines 634-646 — PRE-FLIGHT for `rmd wipe-test`…

PRE-FLIGHT for `rmd wipe-test` (design note (i)): when the projection already reports
`taskId` merged, refuse BEFORE either arm is dispatched, naming the reason — instead of
paying for two arms that `runTask`'s own W1-T319 guard would refuse anyway at zero cost,
and instead of ledgering the resulting non-measurement as a `wipetest.pair` line.

PURE (no I/O): takes the already-derived {@link WipeTestMergedState} rather than deriving
it itself, so this refusal — and its exact wording — is unit-testable without a live
GitHub read or a real plan on disk. `--rerun` passthrough is deliberately NOT built here
(design note (iv)): there is no override to consult, so a merged subject is refused
unconditionally until the CLI wires one (which must reach BOTH arms atomically, or not
at all).

## deriveWipeTestRunResult

### Base lines 662-673 — Best-effort derivation of a…

Best-effort derivation of a {@link WipeTestRunResult} from a real {@link RunResult}
plus the ledger — turns {@link RunResult}'s verdict/costUsd (all it carries) into the
richer shape {@link computeWipeTestDelta} needs. `numTurns` is exact (summed over
THIS run's own `run_id`, same `DONE_STEPS` retro.ts's `gatherRuns` sums); `strikes`
and `proofExec` are task-scoped best-effort reads (fix/review are separate rungs that
ledger under their OWN run ids, not this one) — good enough for the CLI's live report,
NOT itself a new decision-relevant ledger reader. Not exercised by this task's
REQUIRED unit tests (those work off hand-seeded fixtures, per the design's own
acceptance wording) — this is the thin glue "running the experiment is
operator-scheduled" (the task's own note) anticipates.
