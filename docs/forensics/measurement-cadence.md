# measurement-cadence.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/measurement-cadence.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing else
changed. Headings name the symbol or section the text explained; the code keeps a one-line `Why:`
pointer where the history mattered. Base revision: origin/main at 79c73053373cc2f74eed423dd17b228502d0e305;
the line numbers below are that revision's.

## Module header

### Base lines 20-50 — lib/measurement-cadence.ts — W1-T1259: gives…

lib/measurement-cadence.ts — W1-T1259: gives `rule-efficacy`, `verdict-calibration` and
`autonomy-rate` a CADENCE. All three are merged, HOST-SIDE ONLY (their own headers: "the
ledger lives on the daemon host; nothing in CI can read it"), and reachable only through
`src/run-task.ts`'s CLI dispatch — so an operator who never types the command never sees
whether the system is getting better. This module is the PURE decision + report-assembly
half, mirroring `lib/auto-triage.ts`'s own split: the daemon's poll loop (`lib/daemon.ts`)
consults `decideMeasurementCadence` through an injected hook, never this module directly, and
the CLI wiring (`src/run-task.ts`'s `daemonCommand`) is the one PRODUCER that turns the hook
from a type into a live call — see that wiring's own comment for why this split matters (PR
#1066 shipped a consumer with no producer and the feature was inert on every production boot).

THE SAFE MODE IS THE ONLY MODE THIS CADENCE RUNS BY DEFAULT (design (ii)). `verdict-calibration`
and `autonomy-rate` are pure readers (no write symbol at all); `rule-efficacy` writes exactly
once, in `escalateRepeatingRules` below, and that write is gated on `policy.escalate` — shipped
OFF, a separate opt-in flag, exactly like `autoTriage.enabled`. The default cadence therefore
always runs the report-only form ("rule-efficacy --no-escalate" in the CLI's own words) plus
the two readers: zero writes, so it can be turned on without an operator decision about
proposals.

LAW 5, PINNED. Nothing in this module files a task or mints an id. `escalateRepeatingRules`
(lib/rule-efficacy.ts) only ever drafts a PROPOSAL into the inbox's ACTIVE-proposal registry
via `updateProposalRegistry` (the W1-T240 single writer) — the inbox's own tiering and an
operator's ratification own the proposal's fate from there. This module adds no second write
path and no filing step.

P48, ON A TIMER. Every result below carries `status: "measured" | "refused"` rather than a
bare rate — a rate over nothing measured must refuse to print, never read as a false-healthy
0%, and that discipline matters MORE on a cadence nobody is watching in real time than it does
under an operator's own eyes.

## recordMeasurementCadenceFire

### Base lines 103-116 — W1: THE DIRECTORY IS CREATED, NOT ASSUMED…

W1: THE DIRECTORY IS CREATED, NOT ASSUMED — and the failure mode this closes is the expensive
one. A bare write into an absent `state/` throws ENOENT BEFORE the marker lands, and an absent
marker correctly resolves to NO PRIOR FIRE, so the cadence check reads `fire: true` on every
tick forever and each fire pays for a whole re-read. MEASURED on a root without `state/`:
three consecutive ticks, all `fire: true`, no marker on disk, every run throwing.

FOUR OF THE SEVEN `last-*.json` WRITERS ALREADY DO THIS (`last-seen.ts`, `digest.ts`,
`feedback-docket.ts`'s `writeFeedbackDocketMarker`, `retro.ts`) — one of them,
`recordDigestCadenceFire`, mkdirs and then delegates HERE, which is a caller working around
this very gap. This makes the writer carry the guarantee instead of its callers.

IT CHANGES NOTHING ELSE. Same path, same contents, same rolling-window argument, and the
read side is untouched: a marker that EXISTS and cannot be parsed still fails closed, while an
ABSENT marker still means no prior fire. That distinction is the point and survives.

## The adoption report

### Base lines 217-243 — the adoption report: a fourth verb…

"Is this system getting better" (the three verbs above) and "did anything anyone shipped ever
get ADOPTED" are different questions — a mechanism can be perfectly correct and still never be
called, read, invoked, or given a subject. This verb answers the second question, on the SAME
cadence and through the SAME producer as the three above (design (i)): no new policy block, no
second marker, no new interval, and — per this module's own Law 5 pin — no write of its own.

FOUR SHAPES, THREE DISCOVERABLE AND ONE DECLARED (design (iv)). A symbol with no caller, a plan
field with no writer, and a script with no invoker can each be found by a SCAN that enumerates
its own candidates from source — nobody has to say in advance which export, which field, which
script to look at. A runtime gate with no subject cannot: "is `credential_expired` ever true"
is a hand-written predicate over ledger data, and no generic query yields it. So shapes 1-3 are
live scans below; shape 4 is a DECLARED LIST (`ADOPTION_SHAPE4_PREDICATES`), and the list's own
size and last-edit date travel with every report it produces — a list nobody extends is a list
that reports the same instances forever while a new one goes unseen, and this is how that
staleness stays VISIBLE instead of silent (design (iv)'s own named risk).

EVERY FINDING CARRIES ITS MECHANISM'S SHIP DATE (design (v)): a count read thirty-one hours
after the thing it counts shipped is a BACKLOG, not a failure, and is meaningless without the
date beside it to tell the two apart.

ADVISORY ONLY, LIKE THE SCAN IT SITS BESIDE (`reachability.ts`, W1-T322): nothing below can
fail a check, block a merge, or file a task — an adoption count is a number for an operator to
read, never a verdict this module renders. NOT IN SCOPE (design (vi)): widening
`reachability.ts` itself past its own diff scope, or proposing that any unadopted mechanism be
deleted — the finding is that nobody knows the gap exists, never that the gap is waste.

## buildAdoptionCorpus

### Base lines 358-362 — Read every candidate file ONCE…

Read every candidate file ONCE — `src/`, `scripts/`, `bin/`, `test/`, the same reference
surface `reachability.ts` scans — so a symbol/script reachability check is a regex test over
an already-loaded string, never a repeat disk read per candidate (measured on this repo:
~1,100 files / ~20MB read once in well under a second; the O(candidates * files) cost that
follows is then pure in-memory regex — ~2s for the full `src/lib` population on this host).

## scanUnadoptedFields

### Base lines 457-463 — SHAPE 2 — field with no writer…

SHAPE 2 — field with no writer. Enumerates every OPTIONAL field (`name?:`) declared on
`src/lib/plan.ts`'s `Task` interface — the one schema plan/ data is written against — and
reports every one with ZERO raw `<field>:` key hits across `plan/`'s own corpus, the same
measure this task's own rationale used (`retirement:` — 0 raw key hits, control `^\s*status:`
matching 703 files). A REQUIRED field can never appear here: every parsed task carries it, so
its hit count is never zero — this scan needs no separate required/optional split to stay
quiet on them.

## scanUnadoptedScripts

### Base lines 509-513 — SHAPE 3 — script with no invoker…

SHAPE 3 — script with no invoker. Enumerates every `scripts/**` file and reports every one
with zero references across the three surfaces a script can be reached from: a `.github/
workflows/*` step, `package.json`, or a `src/**` spawn — the same three surfaces this task's
own rationale swept (0 workflows, 0 package.json, 0 src/, for both named scripts; control:
`diff-coverage` matches 1 workflow).

## The verb census

### Base lines 643-666 — THE VERB CENSUS: a sixth verb…

`lib/emissions.ts` (`rmd emissions`) already answers "which CLI verb has written NO ledger
line" — W1-T2479 fixed its own corpus (a four-space-only pattern silently dropped three
one-line `COMMANDS` entries, 60 of 63 scanned with nothing reporting the gap) and gave it a
CONTROL so a future corpus regression fails loud instead of quietly shrinking. What it never
had was a CLOCK: an operator who never types `rmd emissions` never sees the report at all.
This section is that clock, joining the SAME spine the five verbs above already ride (no new
policy block, no second marker, no new interval) rather than adding one of its own.

A REPORT, NEVER A MINTER, AND THAT IS DELIBERATE. A verb this instrument names silent has
THREE remedies — wire it to a step, delete it, or allowlist it — and only a human can tell
which. `mintAdoptionProposals`'s own precedent (a symbol with no caller has exactly ONE
mechanical remedy) does not transfer here, so nothing below ever calls a minter or the
proposal registry; the outcome is read, never filed.

THE ALLOWLIST IS REUSED, NEVER RE-DECLARED. `lib/emissions.ts`'s own `EMISSIONS_ALLOWLIST`
already carries the judgement calls this task would otherwise have to re-litigate — a verb it
excuses reads as excused here too, by construction, never as a second silent count.

UNMEASURABLE IS NAMED, NEVER FOLDED INTO SILENT. Only verbs `attributeVerbs` can attach a
ledger prefix to are measurable by this instrument at all; the rest (`run-task` itself is the
standing example — see `attributeVerbs`'s own doc) are a SEPARATE denominator, so a bare "N
verbs silent" is never read against the wrong population.

## VerbCensusReaddir

### Base lines 688-698 — The one `readdirSync` walkVerbCensusSources calls…

The one `readdirSync` {@link walkVerbCensusSources} calls, injectable so its unreadable-subtree
arm is reachable from a test. That arm cannot be driven through the real filesystem here: the
entry must be a DIRECTORY for the walk to recurse into it (so the ENOTDIR trick
test/inflight-sweep-rung.test.ts uses does not apply), `chmod` is inert for uid 0, and a path
long enough to throw ENAMETOOLONG cannot afterwards be removed by `rmSync` -- a test that
litters the runner is worse than the gap it closes. Injection is the same shape
`LedgerGrepFsDeps` (lib/ledger-grep.ts) already uses for exactly this reason.

Optional and LAST on both signatures, so every existing caller is byte-identical.

## ADOPTION_MINT_CEILING

### Base lines 871-878 — THE CEILING (Q3) — a PRIMARY CONTROL…

THE CEILING (Q3) — a PRIMARY CONTROL, never a backstop (W1-T1266's distinction, and this is
the arm that decides it): on any fire whose mintable finding set exceeds it, THIS is what stops
the mint loop, and nothing upstream would have. It is sized for the healthy case by design, so
it fires on a perfectly ordinary tick — which is exactly why it must not be read as a
fires-only-when-something-else-broke bound. At most this many NEW proposals are minted per
fire, so a backlog of hundreds of findings never floods the inbox in one tick — at the shipped
cadence bound of `maxPerDay: 4` that is at most twelve mints a day before the inbox's own
tiering sees any of them.

## The adoption report's proposal mint

### Base lines 855-864 — W1-T2473: the adoption report's own PROPOSAL MINT…

W1-T2473: the adoption report's own PROPOSAL MINT — the fourth verb's findings were
computed every fire and read by nothing (this task's own title). Q2 of this task's rationale
establishes AdoptionFinding as the FIRST family that can carry a real, git-greppable
EvidenceAnchor WITHOUT INVENTION: `mechanism` becomes `pattern`, `definedIn` becomes `path`.

SHAPES 1-3 ONLY. Shape 4 (`gate-no-subject`) is DECLARED, not scanned (design (iv) above): its
`definedIn` is a human-readable description ("state ledger `containment.probe` rows"), never a
real repo-relative path — handing that to `git grep -- <path>` (via {@link gitGrepAnchorTrue})
would be a bad pathspec (a throw) rather than the git-greppable fact Q2 requires, so shape-4
findings are never mintable here.

## proof-queue-audit's offenders

### Base lines 972-983 — W1-T2477: proof-queue-audit's offenders…

W1-T2477: proof-queue-audit's offenders — A SECOND PRODUCER INTO THE SAME MINTER, NEVER A
SECOND RUNG (this task's own title). proofQueueAudit (lib/proof-queue-audit.ts) already resolves
every open task's proof against the real checkout and names every one that can never resolve —
SEVENTY-NINE, across TWENTY-ONE tasks, measured at this task's own filing — but it is reachable
only through `src/run-task.ts`'s CLI dispatch (SURFACE 1: zero importers outside it), so it runs
only when a human types it. An offender row ALREADY carries everything an EvidenceAnchor needs
with NO INVENTION: `proof` (verbatim, git-greppable) becomes `pattern`; the offending task's own
`plan/tasks.d/<id>-<slug>.yaml` (or monolith) record — the SAME file `lib/plan.ts`'s own
`taskRecordPath` resolves — becomes `path`. Wiring this to a fresh LOG line would reproduce the
exact defect W1-T2473 was filed against (a signal computed on a schedule and read by nothing),
so it goes through `updateProposalRegistry` — the SAME single writer {@link mintAdoptionProposals}
already uses — or it does not run at all.

## buildMeasurementCadenceRow

### Base lines 1413-1436 — Builds the measurement_cadence.ran log row…

Builds the `measurement_cadence.ran` log row FROM `result`'s own keys, so a member added to
{@link MeasurementCadenceRunResult} is named on the row without anyone editing this function or
the daemon call site (W1-T2502 — the row was previously four hand-typed keys that silently
dropped every member added after them; `adoptionReport`, and independently `proofDebtReport` /
`proofDebtMint`, reached zero occurrences in `daemon.ts` this way).

`Object.keys(result)` — never a fixed list of every field the TYPE declares — is what makes an
ABSENT optional member distinguishable from one PRESENT and `undefined`: {@link
runMeasurementCadenceReport} itself never omits a key (every field above is set, even to
`undefined`, via the object literal's shorthand), but three of the eight fields are optional on
the TYPE ONLY so a hand-built test double simulating `DaemonDeps.runMeasurementCadence` from
before a field existed still type-checks with that key genuinely absent (see
`test/measurement-cadence.test.ts`'s own `runDaemon` fixtures, which return as few as three
keys). `Object.keys` skips a truly-absent key entirely — so the row omits it too — while a key
explicitly set to `undefined` still shows up as an own property and lands on the row with that
value. A fixed enumeration of "every field the type could carry" cannot tell these apart; this
can, because it never invents a key `result` doesn't actually have.

Never throws: a malformed or hostile `result` (e.g. a key whose getter throws) still returns a
row — a synthetic `row_build_failed` entry naming the error — rather than propagating, because
by the time this runs the cadence has already executed; a logging-shape failure must never read
as a cadence failure (`measurement_cadence.run_failed`) it never had.

## The catch-erasure blind spot

### Base lines 1446-1452 — NOT erased: the failure IS the return shape here…

NOT erased: the failure IS the return shape here — `row_build_failed` carries the message
into the ledger row, so a row that could not be derived is distinguishable from one that
derived to nothing. The catch-erasure detector's DISTINCTION_KEY_RE looks for `\bfailed:`
and cannot see it behind the underscore in `row_build_failed`, so the reason is stated here
rather than renaming a shipped ledger key to satisfy a regex. Deliberately does not rethrow:
this row is telemetry about a cadence run, and failing to build it must never take the run
itself down.

## The one reader

### Base lines 1457-1466 — W1-T2660: THE ONE READER…

The producer above has run on a policy-driven cadence since 2026-09-02 (`plan/policy.yaml`'s
`measurementCadence` row) and written `measurement_cadence.ran` rows the whole time; nothing
in `src/lib/serve.ts`, `src/lib/board.ts`, `src/lib/status-board.ts` or `src/lib/digest.ts`
ever read one back until this reader existed — "correct code that nothing calls, warned about
each time" (this task's own rationale (2)). `latestMeasurementRows` closes that: it is the
ONLY function in this module that reads the row it writes, and it inverts
{@link buildMeasurementCadenceRow} key-for-key rather than re-describing that row's shape by
hand, so the two can never drift apart silently.
