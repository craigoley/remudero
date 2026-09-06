# dispatch-overlap.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/dispatch-overlap.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing else
changed. Headings name the symbol the text explained; the code keeps a one-line `// Why:`
pointer where the history mattered. Base revision: origin/main at
7ce3b525569bd7cfa98f5f858874e8667274d1dc; the line numbers below are that revision's.

## Module header

### Base lines 3-30 — PRE-DISPATCH OVERLAP CHECK (P19 rung

PRE-DISPATCH OVERLAP CHECK (P19 rung 1, W1-T171). A PURE predicate over a set of
candidate tasks the caller has ALREADY determined are otherwise concurrently
runnable (deps met, not blocked, not merged, not in-flight — see drain.ts's
`runnableCandidates`): partitions them so that no two tasks placed in the SAME
dispatch pass declare overlapping `files:`. NO LLM on this path — every decision
here is glob comparison and set arithmetic.

P19's original argument: DAG independence (`depends_on`) is an ARCHITECT CLAIM,
never verified — two tasks the DAG calls independent can still declare
overlapping `files:`, producing exactly the integration-surfacing semantic
conflicts hierarchical decomposition (#103) warns about. This check is a
REDUCTION of collision probability, never a guarantee: `files:` is advisory
metadata a worker can exceed, and merge-time serialization (server-side
auto-merge lands one PR at a time; a loser goes DIRTY into W1-T106's CONFLICTED
disposition) remains the real backstop. Documenting this as elimination rather
than reduction is the one honesty violation this module must never commit.

FAIL-CLOSED ON UNDECLARED SCOPE: a task with an absent or EMPTY `files:` list is
treated as overlapping EVERY other candidate — an undeclared scope cannot be
proven disjoint, and guessing it disjoint is the exact error mode this check
exists to prevent.

Rung 2 (Tree-sitter symbol-touch intersection for tasks whose globs are disjoint
but whose criteria name the same exported symbols) is deliberately BANKED —
W1-T172's `dispatch.concurrent_set` ledger line is what would make its evidence
(an observed rung-1 escape) answerable. Not built here.

## OverlapPartition

### Base lines 51-63 — One entry per candidate whose

One entry per candidate whose OBSERVED scope (see {@link ObservedScopeByTask})
reached a path its DECLARED `files:` never named — W1-T2237's finding that a
merged diff exceeded its declaration in 138 of 301 comparable cases, 47 of them
onto contested `src/` ground. Populated purely from the `observedByTask` input
below; a call site that passes none (every production call site today — see
that parameter's doc) always gets `overruns: []`. NEVER consulted by this
function's own dispatch/serialize decision above and NEVER written anywhere —
W1-T2237 §6/§13 scope this shard to REPORTING the drift a caller can act on
(a human amending a shard's `files:`, e.g.), not to auto-correcting it or
refusing on it.

## ObservedScope

### Base lines 66-72 — ONE candidate's REAL changed-file set

ONE candidate's REAL changed-file set, as of whenever the caller observed it —
e.g. `openPrFileScopes`'s (`src/run-task.ts`) read of an open PR's actual diff.
Deliberately NOT `Task["files"]`-shaped: an observed scope is a flat list of
concrete repo-relative paths a diff touched, never a glob, because nothing
declares wildcards over a diff — a diff either touched a path or it didn't.

## ObservedScopeByTask

### Base lines 77-93 — Per-task observed scope, keyed by

Per-task observed scope, keyed by task id — OPTIONAL input to
{@link partitionByFileOverlap}. A task absent from this map is scored on its
DECLARATION alone, exactly as before W1-T2237 added this parameter.

W1-T2286 THREADS THIS THROUGH ALL THREE PRODUCTION CALL SITES (drain.ts's
`packDisjointFirst`/`isDisjointFromEvery` and its own `runDrainLanes`, plus
daemon.ts's `runDaemon`) via each caller's existing `DrainDeps.observedByTask`
/ `DaemonDeps.observedByTask` optional dependency — but picks NO live
PRODUCER for it (see that task's rationale §4: the two candidate producers,
a ledger read and a git-derived diff, both need their own throughput
measurement first). Every caller that omits its `observedByTask` dependency
still gets {@link NO_OBSERVED_SCOPE} at the call site, so production dispatch
is UNCHANGED until a later task supplies a real producer — this shard is the
plumbing, not the arming.

## NO_OBSERVED_SCOPE

### Base lines 111-119 — The empty union — every candidate

The empty union — every candidate scored on its declaration alone. Exported (W1-T2286) so a
call site that has no `observedByTask` dependency wired can pass this EXPLICITLY rather than
omitting the argument and relying on {@link partitionByFileOverlap}'s own default parameter —
the difference between "this call site was never wired" (before) and "this call site is wired,
currently to nothing" (after), which is what makes the wiring itself something a caller can
later replace with a real producer without touching this module again.

## globsIntersect

### Base lines 122-133 — True iff glob `a` and glob

True iff glob `a` and glob `b` can describe the SAME repo-relative path — i.e.
their matched-path sets intersect. Supports the two wildcard forms this repo's
`files:` globs use (`*` and `**`); a literal-only glob (the common case — no
wildcard is in use anywhere in plan/tasks.yaml today) reduces to normalized
string equality. `*` and `**` are treated IDENTICALLY here (both "zero or more
of any character, including `/`") rather than distinguishing single-segment vs
multi-segment — a deliberate OVER-approximation: it can only ever make two globs
look MORE likely to intersect, never less, which is the same fail-closed bias
`partitionByFileOverlap` already applies to an undeclared `files:` list. `?` and
other glob metacharacters are not special-cased — they are matched as literal
characters, since none appear in this repo's `files:` entries.

## partitionByFileOverlap

### Base lines 242-269 — Partitions `candidates` — a set the

Partitions `candidates` — a set the caller has already established are
otherwise concurrently runnable — into one pass of pairwise-`files:`-disjoint
tasks plus a list of deferrals. DETERMINISTIC: candidates are placed in the
order given (the plan's own declaration order — see drain.ts's
`runnableCandidates`), each checked against every task ALREADY placed in
`dispatch` this pass; the FIRST-declared task in a colliding pair always wins
the slot and every LATER one defers, so the same candidate set yields the same
partition on every call — no randomness, no LLM, no I/O. A deferred task is
simply absent from `dispatch`; it remains eligible for the NEXT pass (once the
task(s) it collided with have left the in-flight set), which this function does
not model — the caller re-invokes it with a fresh candidate list next tick.

`observedByTask` (W1-T2237) is OPTIONAL and defaults to empty: when supplied,
the collision check above compares each pair's {@link effectiveScope} (declared
UNION observed) rather than the bare declaration, so a lane whose REAL diff
already reaches a path is serialized against another lane declaring or
touching that same path even if its OWN `files:` never named it. A candidate
missing from `observedByTask` is scored on its declaration alone, unchanged.
This can only ever ADD a deferral, never remove one the bare-declaration
comparison would have produced (union is a superset of the declared side
alone) — so it refuses no dispatch that is eligible today; it can only
SERIALIZE a pair one more pass finds independent anyway, which is this
module's existing, non-blocking backstop (module doc above), never a refusal.
`overruns` is computed from the SAME two inputs per candidate and is pure
reporting (see {@link ScopeOverrunReport}) — it does not feed back into
`dispatch`/`serialized` above.

## settledSetPayload

### Base lines 317-346 — The `dispatch.settled_set` ledger payload

The `dispatch.settled_set` ledger payload — the SETTLED COUNTERPART to
`dispatch.concurrent_set`.

WHY THIS EXISTS. `dispatch.concurrent_set` records the set of lanes a pass STARTED
(`{tasks, lane_count}`). Nothing records the set that CONCLUDED. At N >= 2 a lane that dies
mid-pass is therefore detectable only as a set-difference someone must think to compute — the
same shape as the blind sweep, where a missing `sweep.summary` took two undetected 22-minute
episodes to find by hand. With this row, "dispatched 2, concluded 1 fulfilled and 1 rejected" is
a LINE rather than an inference.

COUNTS AND OUTCOMES, NOT A BARE PULSE. `Promise.allSettled` yields `fulfilled` or `rejected` per
element, and that distinction is the whole signal: a pass that dispatched 2 and had one lane
reject is a different event from one that dispatched 1 and it fulfilled, and only the per-task
outcome separates them. Task ids are carried in the SAME positional order as `admitted`, which is
the order `allSettled` preserves, so each id is paired with its own settlement.

A PURE FORMATTER, for the reason {@link serializedLedgerPayload} above already states: the ledger
shape gets exactly one definition instead of being re-derived at each call site. That matters more
here than usual — there are TWO call sites, `runDrainLanes` (drain.ts) and `runDaemon`'s own lane
path (daemon.ts), because W1-T343 MIRRORED the lane machinery rather than reusing it. Two
hand-written payloads would drift, which is the duplicated-predicate defect this repo has paid for
twice.

CALLERS MUST EMIT THIS IMMEDIATELY AFTER `allSettled` RESOLVES, before classifying outcomes.
`Promise.allSettled` itself never rejects, so a row written there is guaranteed reachable once
dispatch happened; both call sites then run a classification loop with EARLY RETURNS (drain's
`if (failure) return summary("error", ...)`, the daemon's fatal-error path), so a row emitted
after that loop would be skipped in exactly the failure cases it exists to report.

## Rarity-weighted overlap warning

### Base lines 364-383 — Four concurrent PRs (#1927/#1930/#1931/#1933)

Four concurrent PRs (#1927/#1930/#1931/#1933) converged on
`src/lib/open-prs-rest.ts`, a path only 6 of 277 shards declare (2%). RAW
overlap — what `overlappingPaths` above computes — is useless as a
filing-time signal for this: `src/run-task.ts` alone is declared by 103 of
277 shards (37%), and 18% of all shard PAIRS share at least one path, so a
detector on bare intersection would flag roughly a fifth of the plan.
WEIGHTING the overlap by how rare the shared path is, and reporting only
the rare end, is precise across the 87% of paths named by three shards or
fewer, and silent at the handful of hubs (design (i)/(iv), the task shard's
own rationale (3)/(4)).

ADVISORY, NEVER BLOCKING (design iii). Everything below is a pure function
returning data for a human to read at the filing surface — it has no hook
into `partitionByFileOverlap` above, `isDispatchEligible` (drain.ts), or
any minting path, and adds none. Wiring this into dispatch would make it a
FIFTH fired-and-unread signal alongside `daemon.tree_dirty`,
`daemon.stale_code`, `CiFailure.outsidePrRange` and `dh-rate-limit` —
design (iv) is explicit that this must not become that.

## OverlapWarningPolicy

### Base lines 420-431 — A shared path counts as RARE

A shared path counts as RARE — worth an advisory warning — when the
fraction of the plan's shards declaring it is AT OR BELOW this ceiling.
Sized against the measured distribution (task rationale (3)/(4)): the 2%
instance (`src/lib/open-prs-rest.ts`, 6/277) must clear it, the 37% hub
(`src/run-task.ts`, 103/277) must not, and the 87% of all declared paths
named by <=3 shards (well under 1.1%) sit far inside the ceiling with
room to spare as the plan grows — the two-tailed sizing design (ii)
requires.

## rareOverlapWarnings

### Base lines 461-484 — The rarity-weighted companion to `overlappingPaths`

The rarity-weighted companion to `overlappingPaths` above. UNLIKE that
function, this is deliberately NOT fail-closed: a candidate or open PR
with an absent or empty `files:` produces NO warning, rather than the
synthetic overlap-everything bias `overlappingPaths` applies for the
pre-dispatch guard. That bias is right for a collision GUARD (which this
is not — design iii); reused here it would fire this advisory against
every open PR whenever a candidate's scope is merely undeclared, exactly
the noise design (iv) forbids.

For each `openPrs` entry sharing at least one path with `candidate`, finds
the RAREST shared path (lowest declaration count) and reports the pair iff
that path's declaration ratio is at or below
`policy.rareDeclarationRatioCeiling` — i.e. a pair is reported only when
their rarest shared ground is itself rare. A pair sharing ONLY a hub path
(e.g. `src/run-task.ts`) is silent: the falsifier design (v) requires in
both directions, and the one that IS the point of this predicate.

PURE, ADVISORY DATA ONLY (design iii): the return value is a list of
`{withPr, rarestPath, ...}` rows for a human to print at the filing
surface (design iv — where a filer already reads, not a new dashboard).
Nothing here inspects or influences `partitionByFileOverlap`'s dispatch
decision, mints no task, and refuses no dispatch.

## rareOverlapWarnings scoring trap

### Base lines 500-518 — SCORE ONLY PATHS THE COUNTS MAP

SCORE ONLY PATHS THE COUNTS MAP ACTUALLY KNOWS, AND THE `?? 0` THIS REPLACES IS WHY.
`intersectingEntries` reports the RAW strings from BOTH sides, while `globsIntersect`
matched them through normalization/glob semantics — so a shared entry can be a spelling
that no shard ever DECLARED, and `declarationCounts` (keyed on declared strings) has no
entry for it. Defaulting such a path to 0 scored it as MAXIMALLY RARE, which inverted the
one falsifier design (v) calls "the whole design": measured against a hub declared by
103 of 277 shards (37%), a candidate declaring `src/*.ts`, `src/**`, or `./src/run-task.ts`
matched it and warned at `count=0`, while the identical literal spelling stayed correctly
silent. Globs are not an exotic case here — matching them is the whole reason
`globsIntersect` exists.

Scoring the KNOWN entries fixes both directions at once, because a bridged pair always
carries the concrete declared side too: `{src/*.ts, src/run-task.ts}` scores 103 and stays
silent, `{src/lib/open-prs-rest.ts}` scores 6 and warns. When NOTHING shared is known, this
reports nothing — the right direction for a purely advisory signal (design iii), since a
warning naming a path no shard declares tells a filer nothing they could act on.
