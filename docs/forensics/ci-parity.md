# ci-parity.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/ci-parity.ts` when its comments were compacted to the plain-language standard. Every
block below is the removed text verbatim, marker characters stripped and nothing else changed.
Headings name the symbol the text explained; the code keeps a one-line `// Why:` pointer where
the history mattered. Base revision: origin/main at 94ba42cfba8513ed739f8b153246d42ede4b1bd6; the line numbers
below are that revision's.

## Module header

### Base lines 8-50 — lib/ci-parity.ts — `rmd preflight --ci-parity`…

lib/ci-parity.ts — `rmd preflight --ci-parity` (W1-T294, MASTER-PLAN §5/§5C).

THE GAP THIS CLOSES. The shipped `rmd preflight` (W1-T221) runs three hand-route steps —
commitlint, `tsc --noEmit`, the emitter's header/body checks — none of which is any of the
other jobs .github/workflows/ci.yml actually gates a merge on. Everything a coverage,
plan-lint, claims, fitness or drift job would say is discoverable only after a push. This
module is a SECOND, ADDITIVE mode on the same verb (never a second command, never a change to
the default no-flag behaviour): `runCiParity` mirrors CI's own check set, one named step per
job, computed against the SAME merge-base and the SAME coverage flags the workflow uses.

THE STEP LIST IS DATA (`CI_PARITY_TABLE`, one entry per ci.yml job, keyed by job name so
`runCiParity`'s drift check can line them up against the real file). A job that is
deliberately not reproduced locally carries `mirrored: false` and a `reason` rather than being
omitted — an absent entry and a considered exclusion must never look the same. `runCiParity`
parses .github/workflows/ci.yml itself (the `yaml` package, same tool test/ci-gate-required-
format.test.ts already uses against ci-gate.yml) and fails a dedicated `ci-parity:drift` step
the moment a job exists in the workflow with neither a table entry nor a recorded exclusion —
a job added to ci.yml with no parity entry turns this red instead of silently under-covering.

MERGE-BASE PARITY. ci.yml's coverage/lint-plan/mutation-ratchet/containment-probe jobs diff
against `github.event.pull_request.base.sha` from a `fetch-depth: 0` checkout — effectively
the base branch's freshly-synced tip. A local checkout's `origin/main` can be stale, and a
stale base silently changes which lines a three-dot diff counts as added (the #585 fixture
this task was filed from). Every step below that needs a diff refreshes `origin/main` first
(`git fetch origin main`) and only then computes a three-dot range against it — never a
whatever-was-last-fetched ref. `refreshOriginMain`/`changedFilesListPath` memoize that refresh
and the changed-files listing PER (spawn, repoRoot) pair, so the several entries below that
both need it (coverage-ratchet + lint-plan; mutation-ratchet + containment-probe) share one
`git fetch`/`git diff` instead of each re-issuing it.

COST. Steps whose CI job is UNCONDITIONAL just run — they always execute in CI too. Steps
whose CI job is diff- or trigger-scoped (mutation-ratchet, containment-probe) call the SAME
predicate script CI's own trigger step calls, so a diff that cannot move that job's score
skips the expensive part locally for the identical reason CI would skip it — both are built
on {@link runTriggerScopedJob}, the ONE shared shape for "run a trigger, only run the
follow-up step(s) when it says REQUIRED."

EACH STEP REPORTS INDEPENDENTLY. `runStep` never lets one job's step throw out of the run —
an unavailable toolchain (a missing binary, a bad revision) is caught and reported as that
step's OWN named failure via {@link toolchainFailure}, exactly like the hand-route steps in
lib/commit-message.ts, so a check that could not run is never legible as a passing one.

## preflightSummaryPath

### Base lines 68-94 — Where a preflight run writes…

Where a preflight run writes its verdict so the RESULT SURVIVES THE CONTAINER THAT PRODUCED IT.

MEASURED, twice in one day: an operator ran `preflight --ci-parity` in a container, watched it
reach test 5,371 of ~5,600, and then LOST THE RESULT — the container was removed before its
summary was read. Eight minutes of measurement whose only artifact was a terminal buffer, and
`host-update.sh` correctly refused to reclaim disk while that container was alive, so the choice
was between keeping a result that could not be read and reclaiming the disk.

`<repoRoot>/coverage/` rather than the ledger or a new config key, and each of those is a
deliberate NO:
 - NOT THE LEDGER. `preflightCommand` is a hand-route verb with no log function wired into it,
   and the ledger exists for fleet DECISIONS. A preflight verdict decides nothing; it informs a
   human. (Rotation would not have been the obstacle, incidentally: `rotateLedger` keeps the 200
   NEWEST rows per step, and "what did my last run say" is a newest-row question. The
   `DECISION_RELEVANT_LEDGER_STEPS` requirement bites steps whose COUNT is load-bearing, which a
   verdict is not — so the retention argument does not force the set membership here, and adding
   it there would misrepresent what that set means.)
 - NOT `config.root`, tempting though it is as "the state volume". `loadConfig` CREATES its
   config file and calls `resolveClaudeBin()`, which throws where no claude binary exists — a
   preflight that is meant to run anywhere must not acquire that dependency.
 - `coverage/` IS ALREADY THE PERSISTENCE PATH ON THIS ROUTE. The coverage-ratchet step already
   writes `coverage/lcov.info` there, the directory is gitignored, and in a container the
   checkout itself lives under the mounted state volume (`TREE="$CONFIG_ROOT/remudero"` in
   deploy/entrypoint.sh), so a file written here outlives `docker rm` with no new mount, no new
   flag to remember, and no new config surface.

## buildPreflightSummary

### Base lines 122-129 — Build the durable summary. PURE…

Build the durable summary. PURE — no clock, no filesystem, no process state — so a test can
assert the shape without running an eight-minute suite, and so the caller stamps the one piece
of ambient data (the time) rather than this reaching for it.

WRITTEN IN BOTH DIRECTIONS BY CONSTRUCTION: nothing here is conditional on `ok`. A FAILING run's
summary is the one an operator most needs to survive, so there is no branch that could skip it.

## preflightFailureNotice

### Base lines 152-182 — The worker's OWN preflight verdict,…

The worker's OWN preflight verdict, read back out of the worktree it ran in — or `undefined`
when there is nothing worth saying.

WHY THE ORCHESTRATOR READS A FILE. A worker that runs `rmd preflight` and is refused prints the
failing step into ITS transcript and nowhere else. The orchestrator sees only the terminal
verdict — `no_pr`, `failed` — so the single most diagnostic fact about the run ("commitlint
rejected the header", "coverage-ratchet blocked 10 lines") never reaches the phase log or the
ledger, and an operator reconstructs it by hand. {@link preflightSummaryPath} already persists
exactly that verdict, written UNCONDITIONALLY on fail as well as pass, so surfacing it costs one
read.

READING IT IS SAFE BECAUSE THE WORKTREE OUTLIVES THE SPAWN. `runTask` calls `worktreeAdd` before
its try block and `worktreeRemove` only inside a verdict branch — `failOnWorkerError`,
`blocked_transient`, `already_satisfied`, `no_pr`, `merged`, and the `run.error` catch — every one
of which is BELOW the implement dispatch. The `finally` drops the run lock only. `spawnWorker`'s
own `finally` reaps its per-spawn HOME, never `args.cwd`. So at the moment the implement spawn
returns, the worktree is still on disk on every exit path.

AND THE FILE CANNOT BE STALE. `coverage/` is gitignored and the worktree is cut fresh from
`origin/main`, so a summary found there was written by THIS worker. Several preflight runs
overwrite one another, which is the wanted semantics: a worker that failed, fixed it and re-ran
leaves an `ok` summary and this stays silent.

SILENT IN THREE CASES, and all three are "nothing to report" rather than errors: the worker never
ran preflight (no file), the file is unreadable or not JSON, or the run PASSED. Only a failure
speaks, because a phase line on every dispatch is noise that gets filtered out and then missed.

`readFile` is injectable and appended LAST so no positional caller shifts; the default really
reads the filesystem.

## TMP_HYGIENE_IMPORT

### Base lines 272-279 — The suite's per-process temp-dir reaper…

 The suite's per-process temp-dir reaper (W1-T131) — REQUIRED on both direct `node --test`
spawns in this table (coverage-ratchet's full-glob run and containment-probe's scoped run),
neither of which routes through package.json's protected `test`/`test:ci` scripts. Without it
each local preflight leaked one OS-tmpdir dir per fixture in the loaded files — part of the
53,310-dir ENOSPC of 2026-08-03 (plan/feedback/fb-1785807201821-e4c9dc.yaml). ci.yml's own
coverage and containment jobs still omit it: harmless THERE (ephemeral runners), and mirroring
that omission locally is what leaked HERE. Relative, resolved from the spawn's `cwd: repoRoot`,
exactly like package.json's own scripts; must ride AFTER `--import tsx` (tsx parses the .ts).

## shellOut — the spawn-failure read

### Base lines 293-304 — A child that produced NO…

A child that produced NO exit status is not an ordinary failure, and rendering it as
`FAIL — <label>` with whatever (often empty) output came back is how a ci:test ENOBUFS once
read as a real red test with no visible cause.

DELEGATED to {@link spawnFailureDetail} rather than read here, and that is the point of this
change. The comment this replaced claimed the reading covered "a signal kill" — it did not:
the old code rendered `res.error ?? "…no exit status and no error message"`, and a signalled
child reports `status: null` with NO error, so every kill landed in that fallback unnamed. A
second, independent implementation of the same three-state logic is exactly what drifts
(measured in this repo: emitter-checks versus commitlint, documented as unable to drift and
already diverged), so this now calls the ONE implementation. It returns `undefined` precisely
when `status !== null`, which is the guard this block used to spell out.

## coverageScratchDir / testWithCoverageLeaf

### Base lines 412-422 — The full-suite-with-coverage leaf — ONE…

The full-suite-with-coverage leaf — ONE `node --test` run, instrumented, source-mapped,
`test/**` excluded from the ratio, lcov written to `lcovPath` — shared by BOTH callers that
need it: `--ci-parity`'s `coverage-ratchet` job entry above, and `--coverage`'s
{@link runPreflightCoverage} below (W1-T1074). Factored out so the ONE expensive invocation
both modes shell cannot drift between them the way a second hand-copied argv always does.

Routed through scripts/test-with-retry.mjs, exactly as ci.yml's own coverage-ratchet job is
(W1-T255) — a flaky test gets the SAME one-shot retry locally that CI gives it, instead of
failing a local run on a flake CI itself would have gone green on.

## HOST_CAUSED_SUITE_REDS banner

### Base lines 494-547 — ── host-caused suite reds (W1-T2234)…

── host-caused suite reds (W1-T2234) ──────────────────────────────────────────────────────

THE GAP THIS CLOSES. `ci:test` above shells the FULL `npm run test:ci` suite, and every
`runs-on:` in .github/workflows/ci.yml is `ubuntu-latest` (0 `macos` occurrences against a
control of 29 `ubuntu` ones), so a darwin machine's OWN quirks — a bash shipped at 3.2 with
no `declare -A`, an unprovisioned keychain, a BSD `date` without `-d`, no `/proc`, macOS's
own `__CF_USER_TEXT_ENCODING` env injection — have never once been seen by a required check.
Measured on darwin at `origin/main = 0c71906a`, unmodified: 26 of the suite's reds trace to
exactly those six causes, one of them (`declare -A CAPTURED=()`, deploy/recycle-container.sh
line 198, on a host whose `/bin/bash` is 3.2.57(1)-release) alone accounting for 17 — the
largest cluster by far, and shaped exactly like a catastrophic diff to a reader who does not
already know the host. A lane running `--ci-parity` on such a machine cannot tell which of
its reds are its own diff's and which are the machine's.

WHAT THIS DOES NOT DO (design v of the task record — read it before extending this table).
It does not fix `deploy/recycle-container.sh` (a real, one-line, bounded portability defect,
left for its own task), does not rewrite the two platform-fact assertions (`/proc/meminfo`,
the CoreFoundation env leak) that need a different KIND of assertion rather than a workaround,
does not diagnose the `recovery-drill` pair (carried here as UNDIAGNOSED, not guessed at), and
does not add a macOS CI runner (a real cost against `WAIT_CAP_SECONDS`, for a set that is
mostly fixable without one). And it never skips a test on any platform to get there — a
skipped test is a green that proves nothing, and a darwin skip here would suppress 26 of them.

NOT A REWRITE OF `lib/host-parity.ts`, and the overlap with it (two of its
`HOST_PARITY_BASELINE` entries name the SAME `fleet-heartbeat`/`worker-credential-preflight`
darwin divergences this registry does) is real and deliberately not merged. That module diffs
an ACTUAL captured TAP stream (`readTapFailures`) against declared test IDENTITIES, for the
mini-vs-ci review-judge comparison — it needs a caller who captured the run's text. This step
runs INSIDE `ci:test`'s own `stream: true` leaf, which by construction never has that text
(see above), so it predicts from host FACTS instead of diffing observed failures — a
different mechanism for a different input availability, not a second copy of the same one.
Their two darwin entries corroborate each other's counts rather than one copying the other.

SO THE SHAPE IS SEPARATION, NOT SUPPRESSION: `ci:test`'s own PASS/FAIL is untouched by any of
this — same command, same argv, same `stream: true` (this module cannot capture that child's
output without reintroducing the "container ran for an hour with zero output" defect
`stream` was added to fix, and doing so would need an async spawn rippling through every
entry in this table — out of scope, same as it was the last time this file said so). Instead,
`HOST_CAUSED_SUITE_REDS` is a registry of what THIS host is independently known to produce,
keyed by cheap, dependency-injected HOST FACTS (bash's major version, `process.platform`,
whether `/proc/meminfo` exists) rather than by re-parsing `ci:test`'s own swallowed text — so
the report is available EVERY run, not only the ones where a caller happens to have captured
output lying around. `ci:host-caused-suite-reds` runs alongside `ci:test`, always reports
`ok: true` (it is informational, never a verdict of its own — the day this table gates a
merge on a HOST FACT rather than on a test result is the day it stops testing the diff), and
NAMES every cluster this host is expected to produce. Anything else `ci:test` fails on is, by
construction, never matched here — an undeclared or new red is never absorbed into the
host-caused set, and `ci:test`'s own loud FAIL is exactly as loud, on exactly the same set of
reds, as it was before this table gained a step.

THE CORRECTED COUNT. 17 (bash) + 2 (keychain) + 2 (BSD date) + 2 (recovery-drill, undiagnosed)
+ 1 (procfs) + 1 (CoreFoundation) + 1 (the W1-T2205 e2e) = 26 — the task record's own
falsifier: an earlier carried figure of 16 for the bash cluster summed to 25, one short of the
run's `# fail 26`; the per-file recount that produces 17 is what closes the gap.

## HostFacts.nodeVersion / pinnedNodeVersion

### Base lines 560-570 — W1-T2770: THIS PROCESS's own Node…

W1-T2770: THIS PROCESS's own Node version string (`process.versions.node`), and the version
`.nvmrc` pins. Both carried, so `appliesTo` predicates can decide EXACTLY the "running
differs from pinned" question the merge-lcov cluster keys off — never a proxy like "not
exactly 22.22.3" that would rot the day `.nvmrc` moves.

`pinnedNodeVersion` is `undefined` when `.nvmrc` is absent or unreadable: a probe that
cannot tell must not guess "differs" and cannot guess "matches", and every predicate that
keys off this field must handle the absent case the same way — "does not apply, silently".
Same discipline as `bashMajorVersion`'s undefined case above.

## RUN CONTEXT banner

### Base lines 642-654 — ── RUN CONTEXT (W1-T2810) ───────────────────────────────────────────────────────────────────…

── RUN CONTEXT (W1-T2810) ───────────────────────────────────────────────────────────────────

{@link HostFacts} above answers WHICH MACHINE. This pair answers WHICH TREE and UNDER WHAT
LOAD — the two facts that make a gate verdict interpretable and that the verdict line did not
carry. Same shape as its sibling on purpose: a pure builder over raw inputs, an impure edge
that reads them through the one `PreflightSpawn` seam this module already uses, and a rendered
line a caller prints. Same `undefined`-never-a-guessed-value discipline too — see
`parseBashMajorVersion`'s own doc, which this deliberately copies rather than restates.

WHY THE VERDICT LINE AND NOT A SUBCOMMAND: a gate that will tell you its conditions IF YOU ASK
has the same defect, because nobody asks. Measured (CLAUDE.md hazard (h)): a ratchet run in a
checkout 465 commits behind printed `60965 bytes (cap 61046) OK`, exit 0, with BOTH the file it
measured and the cap it measured against already moved, and nothing in the output said so.

## LOADED_RUN_THRESHOLD

### Base lines 656-668 — PRIMARY CONTROL: core-normalised 1-minute loadavg…

PRIMARY CONTROL: core-normalised 1-minute loadavg at or above which a run is LABELLED loaded.
1.0 means runnable work equals the core count — the standard reading of a saturated machine.

PRIMARY rather than BACKSTOP because nothing else decides this: no second signal labels a run
loaded, and no wider gate catches a mislabelled one. It also GATES NOTHING — it changes a word
on a report, never a verdict — so the cost of it being slightly wrong is a reader who has to
read the two numbers printed beside it, which is why a round, conventional value is right here
and a measured one would be false precision.

DATA, deliberately, and exported: the same treatment {@link HOST_CAUSED_SUITE_REDS} and
`PROOF_PAYLOAD_SHAPES` get, so moving this line is a data edit rather than an engine edit.

## detectRunContext

### Base lines 793-807 — The impure edge. Reads git…

The impure edge. Reads git through the SAME injectable `PreflightSpawn` seam every other step in
this module uses (never a second spawn mechanism — `detectHostFacts`'s own rule), and the load
through injectable `loadavg`/`cpuCount` so a test drives the threshold without a busy machine.

NEVER FETCHES. A local gate must not acquire a network dependency: `preflightSummaryPath`'s doc
already refuses `config.root` on the grounds that a preflight "meant to run anywhere must not
acquire that dependency", and a fetch would add a hang path to the one command every session is
told to run before its first push. The fetch AGE is reported instead; the reader decides.

A NON-ZERO `status` IS THE UNKNOWN SIGNAL AND IS READ FROM THE SPAWN RESULT, never from a
pipeline. Measured while this was designed: `git rev-list --count HEAD..origin/main | head -2`
reports the PIPE's status, not git's, so the very invocation that had failed with 128 read as
success — which would render the unknown case as `behind=0`.

## `rmd preflight --fast` banner

### Base lines 1283-1356 — ── `rmd preflight --fast` (W1-T373)…

── `rmd preflight --fast` (W1-T373) — deterministic npm-script gates, nothing else ──────────

THE GAP THIS CLOSES. `--ci-parity`'s `ci` job entry shells `npm run test:ci`, the FULL
`test/**/*.test.ts` glob — so the only way to reach a two-second check like `claims`, or the
now-added `ci:cli-reference-check` above, is to run everything else too. `--ci-parity` cannot
be run habitually (test/mounts-wiring.test.ts alone has MEASURED $1.42 of real worker spend
per run of that suite); a mode that cannot be run habitually does not make its cheap checks
reachable. This is a THIRD, ADDITIVE mode on the same `preflight` verb (never a second verb,
following `--ci-parity`'s own precedent): it runs ONLY the curated list below.

THE CURATION CRITERION (design ii) — stated here because `FAST_GATE_STEPS` below IS its
enforcement, not a preference next to it. A step qualifies ONLY if it is deterministic, runs
in seconds, and has demonstrably blocked a PR (or is the identical shape as one that has).
Ordinarily it also needs no network. W1-T2734 is the explicit exception: its source-size signal
refreshes origin/main so the merge-base measurement cannot silently use a stale ref; it makes
no other network call, and inability to refresh is reported as a measurement failure.
`required-core` marks the two steps #1352 itself was blocked by; `same-class` marks the rest,
admitted because each is the identical shape (a deterministic npm-script gate CI runs
unconditionally) and costs well under half a second.

WHAT THIS MUST NOT BECOME (design iii): `npm test`. Growing this list to include a step whose
OWN command is the full `test/**/*.test.ts` glob (`npm run test:ci`, a bare `npm test`) is the
ONE mistake this mode exists to prevent — it would make the fast mode the expensive mode
wearing a cheaper name, and the habit it exists to create unaffordable. `runPreflightFast`
below never shells `npm run test:ci` (or any bare `npm test`) — it only ever invokes
`npm run --silent <script>` for a script named in `FAST_GATE_STEPS`, and every such script
runs AT MOST one named file, never a glob.

── W1-T2478: THE CENSUS CLASS, ADMITTED UNDER A MEASURED BOUND, NOT EXCLUDED BY MECHANISM ────

THE PROXY THIS REPLACES. Design (iii) used to read "never spawns `node --test`" — a MECHANISM
proxy for the real concern (cost), and wrong for exactly one class: a CENSUS SUITE (a pure
source scan over `src/**` plus a written baseline/exemption table — structurally identical to
`claims`/`jscpd`/`depcruise` above, which this mode already runs) differs from those only in
which test runner it happens to have been authored in. `test/bound-kind-declared.test.ts`
blocked #3304 on a single undeclared bound-shaped constant, with a clean fast run immediately
before it — the fast gate could not see the one suite built to catch exactly that shape.

THE BOUND IS THE PRIMARY CONTROL THAT REPLACES IT. `boundMs` below (present ONLY on the four
census entries this task adds) is a measured wall-clock ceiling: `runPreflightFast` times each
such step's OWN `npm run --silent <script>` invocation and refuses it — `BOUND EXCEEDED`, named,
never a bare non-zero exit — the moment it runs over `boundMs`, REGARDLESS of whether the
script itself would have exited zero. This is a PRIMARY CONTROL, not a backstop (W1-T1266's own
distinction): it decides admission on THIS ordinary run, before anything has failed, the same
way a speed limit governs every trip rather than only the one after a crash. It replaces the
mechanism proxy with the cost bound the proxy was always standing in for — a step is admitted
because it is CHEAP on THIS run, never because of which runner authored it, and refused by that
same measurement, never by a written exception naming it.

WHY ONLY THESE FOUR, STATED AS A PREDICATE SO THE LIST CANNOT DRIFT. A census entry qualifies
iff it (a) walks the tracked `src/` population via `git ls-files`, (b) asserts something about
EVERY file it walks, (c) carries a baseline/exemption table so only NEW violations bite, and
(d) measures comfortably under `boundMs` when run alone. `test/bound-kind-declared.test.ts`,
`test/catch-erasure-ratchet.test.ts`, `test/negative-reachability-ratchet.test.ts` and
`test/no-shallowing-of-the-canonical-checkout.test.ts` each satisfy all four and are wired
through their own `census:*` npm script (package.json) — one `node --test` invocation of that
ONE file, never the suite glob. A suite that fits shape (a)-(c) but fails (d) is not added here
and is not exempted either — it stays out until it is made cheaper or its own cost is argued
separately (out of scope for this task), refused by the same predicate a future entry would be.

`boundMs` is `undefined` on the seven pre-existing entries below — this task does not re-audit
them. Each already states its OWN admission basis in its own `reason` (an explicit measured
time for `same-class`, or a demonstrated PR block for `required-core`, e.g. `claims`, whose
assertions shell out per-claim and cost seconds, not the sub-second `boundMs` governs) and nothing
here changes how any of the seven runs or is judged.

W1-T2643 — THE PREDICATE ABOVE IS NOW ENFORCED, NOT JUST STATED. `CENSUS_POPULATION` below is
the enumerated set every test file the recognizer (`discoverSrcFilteredLsFilesCallers`, shared
with W1-T2523's `censusSuiteMembershipFor` — one recognizer, never a second) finds census-shaped
gets exactly one entry in, carrying a verdict: ADMITTED, REFUSED for cost (a re-measured number),
or REFUSED for failing (a)/(b)/(c) outright (named). The four `boundMs` entries below are no
longer hand-written here — they are `CENSUS_ADMITTED_MEMBERS`'s own projection, so a hand-added
census step with no population member, or an admitted population member missing its step, is
impossible rather than merely discouraged.

## FAST_GATE_CENSUS_BOUND_MS — the soft bound

### Base lines 1365-1390 — W1-T2545 — THE BOUND ABOVE…

W1-T2545 — THE BOUND ABOVE IS NOW THE *SOFT* ONE, AND THE REFUSAL IS RELATIVE.

WHY THE ABSOLUTE CEILING COULD NOT HOLD. A census entry qualifies for this gate precisely
BECAUSE it walks the tracked `src/` population and asserts over every file in it — so its cost
is a monotonic function of a corpus that only grows. A fixed millisecond ceiling against a
monotonically growing cost is a gate that ejects its own entries over time, and ejection is
silent in the direction that matters: `runPreflightFast` refused the step, so the fast gate
stopped running a census suite CI still enforces — restoring exactly the blindness W1-T2478
existed to close. MEASURED at origin/main 05dcb050, `rmd preflight --fast` on a clean tree:
`negative-reachability-census: BOUND EXCEEDED — took 2509ms`, own result "would have PASSed",
with the whole gate reporting FAIL. On GitHub runners the same entry measured 2268ms and
2250ms while main's own `ci` passed, so the distribution STRADDLED the ceiling: a coin flip
per run, decided by runner speed rather than by anything about the tree.

THAT LAST OBSERVATION IS THE FIX. A wall-clock number conflates two things — how much work the
suite does, and how fast the machine is — and only the first is a property of the repo. So the
refusal is now measured against the SAME RUN's own cheapest census entry: a slow machine slows
every entry together, leaving the ratio stable, while a suite genuinely doing far more work
than its siblings stands out on any machine. The bound is derived from the measured population
rather than written down, which is what keeps it from being outgrown.

THE SOFT BOUND STILL EARNS ITS KEEP: an entry over it is REPORTED, with its cost, so growth is
visible long before it is refused — the warning the absolute ceiling could only deliver by
failing the gate.

## CENSUS_POPULATION banner

### Base lines 1414-1460 — ── W1-T2643: THE CENSUS POPULATION…

── W1-T2643: THE CENSUS POPULATION IS AN ENUMERATED SET WITH A VERDICT, NEVER A COMMENT ───────

THE GAP THIS CLOSES. Before this task the four `boundMs` entries below were the ONLY artifact
recording census-class admission, and the one refusal anyone had actually made —
`test/enforcement-data-carveout.test.ts`, named in test/fast-gate-admits-the-census-class.test.ts's
own header as "measured ~2.1s alone... deliberately NOT added" — existed ONLY as prose in that
comment, never as a structured artifact a later reader (or a test) can check. A refusal stated
in prose and evidenced nowhere is indistinguishable from a suite nobody remembered.

`CENSUS_POPULATION` is that artifact. Every file `discoverSrcFilteredLsFilesCallers` (below —
the SAME recognizer W1-T2523 already shipped as part of `censusSuiteMembershipFor`, reused
rather than re-derived: "ONE CENSUS PREDICATE, NEVER TWO") finds — every `test/*.test.ts` file
mentioning `ls-files` whose own text also filters on `src/` — gets exactly one entry, carrying
a verdict:
  ADMITTED         — present in FAST_GATE_STEPS with boundMs, via the projection below (never
                      hand-added there directly)
  REFUSED, cost     — satisfies (a)-(c) but its own solo `node --test <file>` run measured over
                      FAST_GATE_CENSUS_BOUND_MS; the reason is the NUMBER, dated and reproducible
  REFUSED, predicate — does not actually satisfy the predicate; names WHICH of (a)/(b)/(c) fails
                      and why, so "considered and excluded" is never confused with "never looked at"

RE-MEASURED, NOT COPIED (design mandate — distrust the prompt over the installed version,
standing rule 7). Every `measuredMs` below was run at this task's own HEAD, 2026-09-04:
`node --test --import tsx --import ./test/setup/tmp-hygiene.ts <file>`, alone, three times, the
median kept. None of W1-T2478's filing-time numbers, nor this task's OWN filing rationale's
numbers, are reused — re-run the same command against the same file to re-derive or refute any
entry below.

ONLY ONE REFUSED-FOR-COST MEMBER WAS FOUND, AND THAT IS REPORTED RATHER THAN PADDED TO TWO.
This task's filing rationale — drafted from W1-T2478's PRE-implementation filing text, by its
own admission ("HONEST LIMITS OF THIS FILING") — describes a "sixth" suite at 6371ms distinct
from a "fifth" at ~2.1s. W1-T2478's own SHIPPED artifact (the test header above, and PR #3323's
own body) names only ONE excluded suite. This task's own re-application of the predicate against
every recognizer candidate in the CURRENT tree (24 at this task's own HEAD, 25 after W1-T2644
below adds its own proof file, which the recognizer's text-substring heuristic also
self-matches — see that task's own section) finds no second suite satisfying (a)-(c) — the
closest calls, `test/mkdtemp-callsite-check.test.ts` and
`test/state-citation-check.test.ts`, each delegate their real per-file walk to an external
script and assert only its aggregate "clean" exit from the `.test.ts` file itself, the same
shape `claims`/`jscpd` already have as ordinary `same-class` entries, never the census's own
in-file per-item loop. Re-measured here, `enforcement-data-carveout.test.ts` alone costs
3686-3769ms across three runs (this sandbox is slower than either prior measurement) —
consistent with ONE suite whose cost is a property of the tree AND the machine it runs on, not
with two distinct suites. The DRIFT GUARD below (`censusPopulationDrift`) is what makes this
claim checkable rather than asserted: if a real second census-shaped suite exists, or one is
added later, the recognizer surfaces it and it is UNKNOWN until this population is updated —
never silently absorbed into "no change needed".

## CENSUS_SUITE_ROSTER

### Base lines 1765-1774 — W1-T2644: THE ROSTER IS THE…

W1-T2644: THE ROSTER IS THE POPULATION, RE-EXPORTED UNDER THE NAME THIS TASK'S OWN ACCEPTANCE
CRITERION NAMES ("the roster is stated once, as data, beside the step table it governs" —
grep: CENSUS_SUITE_ROSTER). An alias, deliberately never a second array: W1-T2523's own
rationale already paid for the "two-derivations" defect once ("RE-DERIVE RATHER THAN TRUST THE
TWO"), and this task's own note says the same thing about itself — "whichever lands second
should READ the roster rather than growing a second derivation". `CENSUS_POPULATION` keeps its
name (existing callers — test/the-census-admission-set-is-derived-not-enumerated.test.ts,
shipped by W1-T2643 and out of this task's own file list — read it directly, by that name,
today); `CENSUS_SUITE_ROSTER` is the identical array under the label this task's acceptance
text specifies, so a reader who greps either name finds the SAME data, never two.

## CENSUS_DIR_WALK_STOPGAP

### Base lines 1814-1829 — THE LABEL, EXPORTED RATHER THAN…

THE LABEL, EXPORTED RATHER THAN LEFT IN A COMMENT — a comment can be deleted silently; a
referenced constant cannot (the test that asserts it would not compile). W1-T2809's own design
mandates that the second matcher ship EXPLICITLY LABELLED, "never silently, because A STOPGAP
THAT SHIPS UNLABELLED BECOMES PERMANENT".

WHY A SECOND MATCHER IS NOT THE FIX: matcher #2 is blind to idiom #3 (`fs.opendir`,
`fast-glob`, a helper wrapping any of them) in exactly the way matcher #1 was blind to #2, and
idiom #3 will be found the way this one was — by accident, after it costs someone a red PR.
THE SUCCESSOR IS THE SEAM, per W1-T2790's ratified ordering (self-declaring at one seam >
derived-and-committed > hand-written prediction): census suites all enumerate the tracked file
list, so a shared helper they call to do that enumeration IS the declaration, and it makes the
recognizer an EXACT IMPORT QUERY that RETIRES both matchers rather than adding #3 beside them.
Adopting it means editing the ~84 suites measured above, which is its own filing and its own
review, not a rider on this one.

## discoverSrcFilteredLsFilesCallers

### Base lines 1881-1891 — The `ls-files` PROJECTION of {@link…

 The `ls-files` PROJECTION of {@link discoverCensusCandidates} — the population
 {@link censusPopulationDrift} gates on, unchanged by W1-T2809's widening.

 WHY THE GATE IS NOT WIDENED WITH THE REPORT, MEASURED RATHER THAN ASSUMED: the drift guard's
 contract is that EVERY file it discovers carries a {@link CENSUS_POPULATION} entry. Feeding it
 the dir-walk idiom adds 83 files with no entry (measured at this head: 28 ls-files candidates,
 all 28 already entries; 84 dir-walk candidates, 83 of them new), so widening the GATE means
 hand-writing 83 verdict rows — its own filing, and one that must argue each row on its merits.
 The REPORT below has no such contract: `unknownCoverage` exists precisely to name a caller it
 cannot place, so it takes the widened set today and that is what makes the positive control in
 test/census-discovery-is-blind-to-a-second-idiom.test.ts pass.

## censusSuiteMembership banner

### Base lines 2013-2039 — ── W1-T2523: WHICH CENSUS SUITES…

── W1-T2523: WHICH CENSUS SUITES DOES A CHANGED PATH JOIN? A REPORT, NEVER A GATE ────────────

THE GAP. `git grep -l <symbol>` — the caller sweep this repo mandates before a PR — is BLIND
to a census suite by construction: it names none of a caller's symbols, only a population
(`git ls-files`, filtered to `src/`) and a property asserted over every member. A PR that adds
two constants and a regex to `src/lib/classify.ts` tripped BOTH `bound-kind-declared.test.ts`
and `negative-reachability-ratchet.test.ts` (2026-08-30) with a correctly-run sweep finding
neither — they surfaced only from a ~40-minute full-suite diff of both branches. This is the
missing QUERY: given a set of changed paths, name the known census suites those paths enter.

WHAT THIS MUST NOT BECOME (the task's own rationale, restated here so it cannot drift from the
code it governs): NOT a new gate. `censusSuiteMembership`/`censusSuiteMembershipFor` below
return data only — no `ok`, no verdict, nothing a caller could wire into a refusal — the same
posture `hostCausedSuiteRedsStep` already takes for informational output in this file. And it
must not claim completeness it cannot have: a suite that walks the tree in some way this
derivation does not recognise is named in `unknownCoverage` as UNKNOWN COVERAGE, never
silently dropped, or it rebuilds the very blind spot this task exists to close.

THE DERIVATION IS AN APPROXIMATION, STATED AS ONE (same posture W1-T2317's own text-proximity
ratchet takes about itself). `KNOWN_CENSUS_SUITES` below is now DERIVED from
`CENSUS_ADMITTED_MEMBERS` (W1-T2643) rather than hand-carrying its own copy of the same four
suites — the sequencing fence W1-T2643's own design records for this exact file: "whichever
lands second reads this population rather than growing a second enumeration". Beyond that
derived set, `censusSuiteMembershipFor` RE-DERIVES rather than trusts: it runs
`discoverSrcFilteredLsFilesCallers` (shared with `censusPopulationDrift` above — the SAME
recognizer, never a second copy of it), and anything that finds beyond the known suites is
named in `unknownCoverage` rather than swallowed.

## withoutNodeTestContext

### Base lines 2150-2167 — Runs `fn` with `NODE_TEST_CONTEXT` and…

Runs `fn` with `NODE_TEST_CONTEXT` and `NODE_OPTIONS` removed from `process.env` for the
duration of the call, then restores whatever was there before — the SAME isolation
`test/reapable-prefix.test.ts` and `test/route-scope-matrix.test.ts` already establish for a
spawned `node --test` CHILD, applied here to a spawned `node --test` GRANDCHILD (`npm run
--silent census:*` → the script's own `node --test`, package.json).

REQUIRED, MEASURED, NOT SPECULATIVE (W1-T2478): `node --test`'s own recursion guard reads
`NODE_TEST_CONTEXT` from its inherited environment — set (as it always is when THIS module's
own caller is itself running under `node --test`, e.g. this file's own test suite exercising
`runPreflightFast` for real), a nested `node --test` prints "run() is being called recursively
... skipping running files" and exits 0 HAVING ASSERTED NOTHING. `defaultPreflightSpawn`
(lib/commit-message.ts) calls `spawnSync` with no `env` override, so it inherits
`process.env` exactly as it stands at call time. Without this, a census step's `npm run
--silent census:*` would read as a clean PASS while running zero of the suite's own
assertions — the exact "clean fast run, no visibility" shape #3304 already demonstrated once,
reintroduced by this task's own mechanism if left unguarded.

## `rmd preflight --coverage` banner

### Base lines 2253-2304 — ── `rmd preflight --coverage` (W1-T1074)…

── `rmd preflight --coverage` (W1-T1074) — diff-coverage, at author-time, on its OWN base ────

THE GAP THIS CLOSES. `scripts/diff-coverage.mjs` is a correct gate that today runs ONLY in
CI's `coverage-ratchet` job — invisible to the author writing the code until a push, a CI
cycle and (on a reviewed PR) a spent review orphan have already gone by. `--ci-parity`'s own
`coverage-ratchet` entry mirrors it locally already, but only as one of fourteen jobs behind a
flag that is not habitual to run (rationale (6)); `--fast` cannot carry it at all, by design,
because a coverage lcov needs the full suite (design vi: `--fast` NEVER shells `npm test`).
This is therefore a FOURTH, ADDITIVE mode on the SAME `preflight` verb — never a new verb,
never a change to the default, `--ci-parity`, or `--fast` behaviour — dedicated to exactly
this one gate.

THE HONEST COST. Opt-in and slow BY CONSTRUCTION: it shells the full `test/**/*.test.ts` glob
with `--experimental-test-coverage`, the same multi-minute run `--ci-parity`'s coverage-ratchet
job pays (shared via {@link testWithCoverageLeaf} above so the one expensive invocation cannot
drift between the two callers). A mode whose cost surprises the caller is one they stop
running, so `preflightCommand`'s own doc states it in minutes-not-seconds terms.

THE RUNNER OWNS THE BASE (design ii), not the caller. `scripts/diff-coverage.mjs` itself takes
a `--diff` file/stdin and derives no base at all — CI supplies its own correctly, but a local
caller building that diff by hand can get it wrong in exactly the two ways rationale (9)
measured: a two-dot `--cached origin/main` diff that reads main's own commits as the caller's,
or a check run before committing that passes over an empty diff. `runPreflightCoverage` below
computes the SAME `origin/main...HEAD` three-dot range `--ci-parity` already uses
({@link refreshOriginMain}, {@link mergeBaseDiffText}) and REFUSES rather than reports when the
inputs cannot support a verdict:
  - an EMPTY diff (`origin/main...HEAD` touches nothing) — there is no "coverage of this diff"
    to assert at all;
  - a DIRTY tree in a diffed file — the lcov this run is about to produce and the diff it
    compares against must come from the SAME tree, and an uncommitted edit to a diffed file
    means they would not.
Both refusals are named steps of their own (`coverage-mode:diff-scope`,
`coverage-mode:tree-clean`) and SHORT-CIRCUIT the run — unlike `--ci-parity`'s many independent
per-job steps, this mode is one linear pipeline (refuse → run the suite → assert instrumentation
→ compare) where every later step's input depends on the one before it actually having produced
something trustworthy, so there is nothing honest left to report once an earlier stage refused.

INSTRUMENTATION MUST BE ASSERTED BEFORE A PASS (design iii). `diff-coverage.mjs` reports
`OK` the instant no ADDED line it INSTRUMENTED reads as uncovered — and that quantifier ranges
only over what the run's lcov actually saw (rationale (7)/(8)): a changed source file lcov
never instrumented at all (no `SF:` record for it — no test loaded it) makes the OK verdict
trivially, vacuously true over an empty set. `coverage-mode:instrumentation` below closes that
LOCALLY, without touching `scripts/diff-coverage.mjs` itself (design iv: that script is a pure
lcov-times-diff comparator and CI feeds it correctly; whether it should ALSO refuse this is a
separate, unscoped question) — for every changed file under `src/` that is not itself a test,
it requires an `SF:` record in this run's own lcov, and reports `UNPROVEN`, NAMING the files,
rather than letting the run fall through to `diff-coverage.mjs`'s own vacuous `OK`.

NO WEAKENING (design vi/vii): nothing here exempts an arm, lowers a threshold, or narrows what
`diff-coverage.mjs`/`coverage-ratchet` refuse — this mode's own `coverage-mode:diff-coverage`
step shells the REAL, unmodified script, over the SAME refreshed three-dot diff, and only ever
gets there once every earlier stage has already proven the inputs are trustworthy.
