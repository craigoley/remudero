# ci.yml forensics

The measured forensics, incident narratives and design arguments removed from
`.github/workflows/ci.yml` when its comments were compacted to the plain-language standard
(`docs/comment-standard.md`). Every block below is the removed text verbatim, marker
characters stripped and nothing else changed. Headings name the job or step the text
explained; the workflow keeps a one-line `# Why:` pointer where the history mattered.

Base revision: `origin/main` at c6baa842136dfd44502bed10d7d7ac7c8a92d0dd. The line numbers below are that
revision's; `.github/workflows/ci.yml` is byte-identical at 9391ac56, where the counts were
first measured.

## File header

### Base lines 1-13 — Remudero CI — the green-merge…

Remudero CI — the green-merge gate (W1-T1B).

This runs on every PR to remudero. Its GREEN result is what branch protection
requires before a PR may merge — including the runner's own self-modifying PRs
(T2+ edit run-task.ts; a broken one must not be able to merge and brick the loop).

⚠️ REQUIRED-CHECK NAME = THE JOB NAME BELOW, not this file's name. Branch
protection is armed with the OBSERVED check-run name (read from the API after
the first run), never a guessed string — a typo'd context deadlocks merges
forever. If you ever add CONDITIONAL jobs (e.g. path/`if:` filters), a SKIPPED
required check also deadlocks merge. The sharded jobs below therefore collapse through
always-runs aggregators named `ci` and `coverage-ratchet`; those stable names remain the only
required contexts while the individual matrix checks expose which shard failed.

## on: — the push trigger

### Base lines 18-25 — W1-T1033: nothing ran the suite…

W1-T1033: nothing ran the suite against `main` — `ci-gate` (a separate file, untouched here)
and every OTHER job below stayed `pull_request`-only for measured reasons (see this task's
rationale/design). The `ci` matrix and stable aggregator run fully on a push, so a broken
merge is observable without an unrelated PR failing first. The coverage matrix and its stable
aggregator also register on a push but shell-skip the PR-specific collection and comparison;
every other job remains PR-only. `ci-gate.yml` must NEVER gain this trigger: its
`SHA` env reads `github.event.pull_request.head.sha`, empty on a push, and its
`concurrency.group` collapses every push into one cancel-in-progress group — see that file.

## concurrency

### Base lines 32-41 — R-50: a force-push mid-run left…

R-50: a force-push mid-run left the superseded PR run competing for the same shared CI-minute
budget as its replacement — every job above pays for a cold `npm ci` and (on `ci`/
`coverage-ratchet`) a Playwright install, so an abandoned run is not free just because nothing
reads its result. Group by PR number so a PR's own runs cancel their predecessor
(`cancel-in-progress` true only on `pull_request`); group by `github.ref` on a push to `main`
(always `refs/heads/main` here — see `on.push.branches` above) so those runs share ONE FIFO
queue rather than a free-for-all, but `cancel-in-progress` stays false there: this is the ONLY
lane that runs the full suite against `main` and the coverage-ratchet aggregate the fleet
merges frequently against, and a fast merge cancelling a slower in-flight one would drop
coverage data for a commit that is already on `main`.

## ci — the HEAVY timeout band

### Base lines 57-63 — W1-T1009: HEAVY band. 35m/2100s sits…

W1-T1009: HEAVY band. 35m/2100s sits in the empty gap this repo's own data leaves between
the longest observed non-hung run (1637s, a legitimately FAILING `ci`) and the first
observed hang (2647s) -- and it MUST stay strictly below ci-gate.yml's own
WAIT_CAP_SECONDS (2400s): below the tail it kills honest work, at/above 2400 it changes
nothing because ci-gate times out first and the misattribution defect returns intact. If
WAIT_CAP_SECONDS is ever retuned (W1-T312), re-derive this value too -- do not raise it
past 2400 without moving that cap first.

## ci — fetch-depth on the checkout

### Base lines 68-73 — `origin/main` must RESOLVE on the…

`origin/main` must RESOLVE on the runner: test/recon-gaps-relayed.test.ts shells
`git show origin/main:src/run-task.ts` against the live checkout, and the default
shallow fetch leaves no such ref — `fatal: invalid object name`. It self-clears on
a re-run, so it reads as noise; it cost four CI cycles across #1658, #1659 and
#1677 in one day. Full depth is 1,227 commits / 26 MB here, and four sibling jobs
(coverage-ratchet, mutation-ratchet, lint-plan, api-client-drift) already use it.

## ci — Cache Playwright's Chromium download

### Base lines 86-93 — R-50: caches the DOWNLOADED BROWSER…

R-50: caches the DOWNLOADED BROWSER BINARY only -- keyed on runner OS plus the exact
playwright version pinned in package-lock.json (never a hash of the whole lockfile, which
would invalidate on any unrelated dependency bump). This has no apt/lock interaction
whatsoever (see the install step's own W1-T1027/W1-T1034 comment below: apt is off the
critical path entirely since --with-deps was dropped), so it carries none of that step's
hazards. `npx playwright install chromium` below is unchanged and stays a no-op on a warm
cache hit, a real download on a cold one -- ci.yml pays for this download 8 times/PR today
(4 shards each in `ci` and `coverage-ratchet`) with no reuse between them.

## ci — Install Playwright's Chromium

### Base lines 100-135 — NO `--with-deps`, AND THAT IS…

NO `--with-deps`, AND THAT IS THE WHOLE FIX: it is what invoked apt, and apt is what
failed. MEASURED ON A GREEN RUN: `--with-deps` reported `0 upgraded, 9 newly installed`
and every one of the nine was a FONT package (fonts-freefont-ttf, fonts-ipafont-gothic,
fonts-tlwg-loma-otf, fonts-unifont, fonts-wqy-zenhei, xfonts-cyrillic, xfonts-encodings,
xfonts-scalable, xfonts-utils). 26 packages read "already the newest version" -- every
Chromium shared library (libnss3, libgbm1, libatk*, libcairo2, libdrm2, libpango-1.0-0,
libx11-6, libcups2t64, libasound2t64) is ALREADY in the runner image, as are
fonts-liberation and fonts-noto-color-emoji. So `--with-deps` installed no browser
dependency here; it bought nine fonts and a dependency on apt.

AND THE SUITES DO NOT NEED THOSE FONTS. The console's own stack is
`system-ui, -apple-system, "Segoe UI", sans-serif` plus a mono variable -- no named
family among the nine -- and a scan for CJK/Cyrillic/Thai reads ZERO across all 24
browser-touching test files, src/lib/serve.ts and plan/tasks.yaml (positive control: 441
lines of serve.ts do carry non-ASCII, so the scan is live). test/serve.shell-ux.test.ts
is the falsifier: its axe scan and its 390px/1440px no-horizontal-overflow assertion are
the two a missing font could plausibly move, and they run on every CI pass.

W1-T1027 filed the cause; #2211 was the attempt this supersedes, and it did not work.
NO RETRY, NO WAIT, NO DPkg::Lock::Timeout HERE -- DELIBERATELY, MEASURED TWICE. #2211's
`wait_for_apt_lock` used `flock`, which cannot observe apt's `fcntl(F_SETLK)` lock and
returned in under a second while the lock was demonstrably held. Worse, `timeout 360`
orphaned a ROOT-owned apt-get (playwright runs it under sudo) that the runner user
cannot signal, so attempts 2 and 3 collided with the orphan attempt 1 created and burned
4.5 seconds: PID 2725 on PR #2207 at 13:53Z, PID 2702 on PR #2199 at 14:39Z, the same
PID across both retries in each case. A retry cannot outlive a lock holder it created
and cannot kill. Removing apt removes all of it.

W1-T1034 (#2223) is the task that MEASURED this failure mode from a raw job log: the
orphaned root apt-get, the flock wait that cannot see apt's fcntl lock, and the mirror
stall underneath both. Its filing draft led with baking the browser into a container
image; that recommendation was REVERSED before dispatch (shard amended 2026-08-19) to
lead instead with dropping `--with-deps` -- exactly what this step does. There is no apt
call left to move off the critical path, so the container stays priced as a fallback for
a future base image that stops carrying Chromium's shared libs, not adopted today, and
the retry/wait machinery #2211 tried is gone rather than made more patient.

## ci — Typecheck

### Base lines 138-146 — §5 TIER 2, quality gate…

§5 TIER 2, quality gate 4/4 (W1-T98): this step is TS-strict's actual enforcement --
tsconfig.json has `strict: true`, and a strict-mode violation anywhere in src/**/test/**
fails this step and blocks merge via ci-gate. That "0 violations" reads identically
whether strict is genuinely wired or silently inert (the neon-drift `_probe(x)` lesson)
is why it isn't taken on faith: test/strict-probe.test.ts drives the real `tsc` binary
against a permanently-broken, deliberately-excluded probe file
(scripts/strict-probe.ts, outside this step's `-p tsconfig.json` scope) and asserts
strict mode rejects it while strict-off accepts the same file unchanged -- that test
runs as part of `npm test` below and is the falsifier proof this step is ACTIVE.

## ci — Determine this diff's fast-lane class

### Base lines 154-170 — THE SAME STEP THE `coverage-ratchet`…

THE SAME STEP THE `coverage-ratchet` JOB ALREADY RUNS, and deliberately a SECOND copy
rather than a shared output: `needs:` would make `ci` wait on `coverage-ratchet`, turning
two parallel jobs into a chain and costing more wall-clock than the skip saves.

THE CLASS COMES FROM THE REAL PREDICATE, NEVER A BASH RESPELLING (Q2): scripts/
diff-class.mjs imports `isInPlanScope` straight from src/lib/plan-architect.ts. A fourth
spelling here would surface as a SILENTLY SKIPPED SUITE rather than a red check, which is
the one failure this whole lane must not have.

FAIL CLOSED, TWICE OVER: the script never throws (empty/unreadable/malformed all resolve
to SOURCE internally), and this step ALSO clamps stdout to the three known tokens and
defaults to SOURCE on anything else — so a `node`/`tsx` that cannot start at all still
leaves CLASS=SOURCE. On a push there is no PR base, so changed-files.txt is left empty
and the script's own empty-list rule resolves it to SOURCE; no push-vs-PR branch here.

NO PR-SCOPED TOKEN IN THIS JOB BODY (the invariant #3187 tripped): `BASE_SHA` is read
through `env:` and guarded by GITHUB_EVENT_NAME, exactly as coverage-ratchet does it.

## ci — Test

### Base lines 200-242 — W1-T255: routed through scripts/test-with-retry.mjs (npm…

W1-T255: routed through scripts/test-with-retry.mjs (npm run test:ci), NOT plain
`npm test` -- see that script's header comment for the full rationale. On a green run
this spawns `npm test`'s underlying command exactly once (zero behavior change); on a
red run it retries the WHOLE command exactly once and names the first attempt's
failing test on stdout (greppable: `FLAKE-RETRY: first attempt failed`) so a flake
leaves a record instead of erasing it on a manual re-run. `npm test` itself stays
retry-free -- Stryker's commandRunner re-runs it once per mutant (stryker.conf.json),
where a retry would blur the kill signal.

W1-T2428 (the `ci` half): on a PLAN_ONLY/DOCS_ONLY diff, run ONLY the suites such a diff
can actually fail — enumerated AT RUN TIME from the tree by scripts/diff-class.mjs, never
a frozen list (criterion 5), so a suite added in the same commit is picked up by the very
run that adds it.

FAIL CLOSED ON THE ENUMERATION TOO, not just on the class. The script prints NOTHING and
exits nonzero on any enumeration error, and its own doc says a caller reading zero lines
"must fail closed (run the FULL suite), never trust an empty list as 'no suites matter'".
That is exactly what the `|| SUITES=""` plus the empty-check below do: any failure, and
any empty result, falls through to the unmodified `npm run test:ci`.

AND THE SKIP NAMES ITSELF (criterion 7 / Q4): the class, the suite count and the total go
to the log AND to $GITHUB_STEP_SUMMARY. A 0-second green that says nothing is
indistinguishable from a real one, which is the defect this must not add.

W1-T2597: MEASURED on PR #3542 — `ci-shard (1/4)` exited 1 with 161 KB of log and NO
`# tests`/`# pass`/`# fail` trailing summary anywhere in it, while its three sibling
shards each ended with a complete summary. A killed/timed-out run prints only the
assertions it reached before dying and never reaches node's OWN trailing summary block
(written once, at the very end — the same discriminator src/lib/review.ts's
`hasFinalSummary` already keys on for a name-filtered proof run). CI reported that
identically to a shard whose summary named a genuine, complete failure set, so nothing
downstream could tell "failed" from "never reported". The block below distinguishes
them WITHOUT changing whether the job is red — a shard that dies mid-run is still a
failing check — it only makes the difference legible: `test-shard-output.log` is what
the summary line is grepped from, so this must run under `tee`, and `set +e`/
`PIPESTATUS` (never a bare `$?`) is required because this step's shell already runs
under GitHub Actions' own default `-eo pipefail` — piping through `tee` would otherwise
abort the script on the very line that captures the exit code, the same reason the
`coverage-ratchet` job's "Test with coverage" step above brackets its own test run in
`set +e`/`set -e`. A shard whose slice legitimately runs nothing still runs to
completion and prints a summary (`# tests 0`, exit 0, MEASURED locally against a real
`node --test --test-shard=` invocation over an empty slice) — so the check below is
gated on a NON-ZERO exit and never fires on an empty-but-honest shard.

## commitlint

### Base lines 306-320 — W1-T31 (MASTER-PLAN §6A), relocated by…

W1-T31 (MASTER-PLAN §6A), relocated by W1-T129 — Conventional Commits gate. This repo
SQUASH-MERGES every PR (`squash_merge_commit_title: COMMIT_OR_PR_TITLE`, and neither
`gh pr merge --squash` call site in src/run-task.ts / src/lib/worker.ts passes an explicit
`--subject`), so branch commits never reach main — only the PR TITLE (GitHub's squash
default for a multi-commit PR) becomes the commit that lands. Linting the base..head commit
range therefore failed PRs over commits that would never exist post-merge, while the
artifact that DOES persist went unchecked. This job now lints ONLY the PR title against
commitlint.config.mjs — the standard is RELOCATED, not dropped: a non-conventional title
still fails (test/commitlint-mode.test.ts is the falsifier proof), and a PR predating this
gate no longer needs its branch history rewritten just to satisfy it (the #234/#238 class).
Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) — same fail-closed shape as
`lint-plan`/`depcruise`/`claims` above: a path-filtered REQUIRED check that can go silently
absent is the synthwatch #102 deadlock class ci-gate.yml exists to avoid. See
test/commitlint-config.test.ts for the falsifier proof the config itself rejects/accepts the
right messages.

## commitlint — the LIGHT timeout band (the derivation the other jobs cited)

### Base lines 324-326 — W1-T1009: LIGHT band, prophylactic --…

W1-T1009: LIGHT band, prophylactic -- 13x this job class's observed max (46s over 440
sampled job-runs). No instance of this job hanging was observed; it is bounded because it
runs the same networked actions/setup-node + npm ci steps as the jobs that did hang.

## commitlint — the live title read

### Base lines 340-349 — W1-T351: github.event.pull_request.title is a SNAPSHOT…

W1-T351: github.event.pull_request.title is a SNAPSHOT taken at opened/synchronize/
reopened (this workflow has no `types:` override, so `edited` is excluded) -- a title
corrected after `opened` was invisible to the linter, and re-running the job replayed
the same stale payload; only a new push (synchronize) ever refreshed it. `gh pr view
--json title` queries the API at job time instead, so a corrected title is linted as it
stands with no push required. An EMPTY read (API/auth failure) is reported distinctly
from a non-conventional title, rather than reaching commitlint as a blank string and
surfacing as "subject may not be empty" + "type may not be empty" -- the signature that
cost three separate investigations before this was recognised as a stale-payload read
rather than a malformed title. See test/ci-title-lint.test.ts for the falsifier proof.

## leak-grep

### Base lines 362-364 — Plaintext-secret tripwire (MASTER-PLAN §5 TIER…

Plaintext-secret tripwire (MASTER-PLAN §5 TIER 1) — runs on every PR,
not required-context-critical yet (W1-T24 wires the aggregator), but
its own job status is what "on every PR" is proven by.

## coverage-ratchet

### Base lines 378-394 — §5 TIER 2, quality gate…

§5 TIER 2, quality gate 1/4 (W1-T25) — coverage never goes down. Runs UNCONDITIONALLY (no
path filter, no `if:`) so it always registers a check run, same fail-closed shape as `ci`/
`lint-plan` above — a conditionally-skipped required check deadlocks merge forever
(LEARNINGS: the #102-class skipped-check deadlock). scripts/coverage-ratchet.mjs compares
this run's lcov totals against the recorded floor in scripts/coverage-baseline.json and
exits non-zero on any coverage-lowering PR; that floor only ever ratchets UP (a deliberate,
reviewed bump when coverage genuinely improves), never down to make a red PR pass.

W1-T212 (recon R-12): that aggregate floor is diff-blind by design (proven in
test/coverage-ratchet.test.ts's PLAN-ONLY FALSIFIER) — new code with zero covering tests
merges freely as long as the codebase-wide aggregate stays above it, and the larger the
codebase grows, the less any single untested addition can move that aggregate. The
"Diff coverage" step below is a SEPARATE, diff-scoped check on the SAME job (so it shares
coverage-ratchet's unconditional, always-registers-a-check-run shape rather than adding a
new required context that could itself go silently absent): it reads the same lcov artifact
plus this PR's base...head diff and fails when the diff adds a source line lcov marks
instrumented-but-never-hit, even when the aggregate ratchet above stays green.

## coverage-ratchet — no `if:`, and the HEAVY band

### Base lines 401-426 — W1-T1033: deliberately NO job-level (or…

W1-T1033: deliberately NO job-level (or step-level) `if:` here — test/diff-coverage.test.ts
asserts this job body carries none at all (the pre-existing #729/skipped-check-deadlock
discipline: this job must always register a check run). So this job still REGISTERS on the
new push trigger, same as every PR — but its coverage-collection step opens with a plain
shell guard (`[ "$GITHUB_EVENT_NAME" = pull_request ] || { …; exit 0; }`, never a YAML
`if:`) that no-ops on anything but a pull_request event. The later staging step uploads a
skipped marker so every matrix child still produces a checkable artifact. Design (i): this job's
diff-coverage half reads `github.event.pull_request.base.sha`, EMPTY on a push (measured:
`git diff "" ...HEAD` exits 129), and even wired to the previous commit it would answer a
different question than "lines this PR added" — so a push run must skip the real work
rather than run it wrong, and must not spend the ~740s p50 (up to 1638s) of the coverage
collection step design (ii) prices at 211-422 CI-min/day for a comparison that means nothing
on a push.
W1-T1009: HEAVY band -- see the `ci` job's comment above for the full derivation of the
35m/2100s figure. This job shares `ci`'s HEAVY band, but W1-T2430's own measurement (4 of
55 recent runs cancelled, all four killed within a six-second band at the timeout) found
every one of THIS job's cancellations died on the `Test with coverage` step below, none on
`npx playwright install` -- PR #2150 was `ci`'s OWN hang, on that step, five minutes after
PR #2148's `ci` hang on the same step; this job sits in the same band for its own reason,
not by repeating `ci`'s. It is NO LONGER at the same number either. Unlike `ci` it runs the
whole suite under --experimental-test-coverage. This matrix now divides that collection
into four independent shards, but the historical 39m/2340s ceiling is retained until real
matrix runs establish a safe lower bound. THE CEILING IS THE INVARIANT: it must stay strictly
below ci-gate.yml's WAIT_CAP_SECONDS (2400s). At or above that cap ci-gate times out first
and the misattribution defect returns intact; if WAIT_CAP_SECONDS is ever retuned (W1-T312),
re-derive this value too.

## coverage-ratchet — Determine this diff's fast-lane class

### Base lines 439-454 — THE CLASS COMES FROM THE…

THE CLASS COMES FROM THE REAL PREDICATE, NEVER A FOURTH REIMPLEMENTATION.
scripts/diff-class.mjs imports isInPlanScope straight from src/lib/plan-architect.ts —
see that script's own header and plan/tasks.d/W1-T2428-*.yaml's rationale (Q1: two of
the repo's three existing scope predicates already disagree; a bash reimplementation
here would be a fourth). FAIL CLOSED, TWICE OVER: the script itself never throws (an
unreadable/empty/malformed input already resolves to SOURCE internally — see its own
module doc), and this step ALSO clamps whatever reaches stdout to the three known
tokens and defaults to SOURCE on anything else — so even a `node`/`tsx` invocation that
cannot start at all still leaves CLASS=SOURCE, never an empty or garbage value a later
step's bash `[ "$CLASS" = ... ]` could misread. On a push (no PR base to diff against)
changed-files.txt is deliberately left empty, which the script's own empty-list rule
already resolves to SOURCE — no separate push-vs-PR branch needed here.
STEP-LEVEL BASH, NEVER A YAML `if:` — this job must keep registering a check run
unconditionally (test/diff-coverage.test.ts asserts its body carries no `if:` at all,
the #729/skipped-check-deadlock discipline this task's rationale, Q4, cites); the class
this step computes is READ by bash guards in the steps below, not gated behind one.

## coverage-ratchet — Cache Playwright's Chromium download

### Base lines 477-478 — R-50: same cache as the…

R-50: same cache as the `ci` job's identical step above — see that step's comment for why
this is safe (no apt/lock interaction) and what it's keyed on.

## coverage-ratchet — Install Playwright's Chromium

### Base lines 485-489 — Same step as the `ci`…

Same step as the `ci` job's above, and the same reason: see that step's comment for the
measurement behind dropping `--with-deps`. Fixing one copy and not the other leaves the
second free to take the board down on its own -- it did, PR #2150 five minutes after PR
#2148. This `run:` line must stay byte-identical to the `ci` job's, which
test/workflow-playwright-install.test.ts asserts.

## coverage-ratchet — Test with coverage

### Base lines 492-520 — W1-T220 defect 1: this step…

W1-T220 defect 1: this step used to run with ONLY --test-reporter=lcov, whose destination
is a file, so a failing run's CI log carried zero test output -- just
"Process completed with exit code 1", naming no failing test and no coverage delta. Node's
test runner accepts multiple reporter/destination pairs, so a human-readable `spec` reporter
to stdout runs alongside the existing `lcov` pair; this leaves the lcov artifact the ratchet
step consumes byte-for-byte unchanged (same flag, same destination), it only adds a second,
human-legible reporter the CI log actually shows.

W1-T210 round 2: `--enable-source-maps` is REQUIRED here, not optional. Without it, Node's
`--experimental-test-coverage` reports DA:<line> positions against the tsx/esbuild-TRANSPILED
JS (comments and type-only lines stripped), not the original .ts file it names in `SF:` --
verified empirically: a source (e.g. `neutralizeFenceMarkers`) at true line 1120 was reported
at line 506 without this flag, and every line from that offset onward was wrong by a growing
amount (more JSDoc between two points ⇒ a bigger offset). `coverage-ratchet.mjs`'s aggregate
sum tolerates this (it never reads line numbers, only totals), but `diff-coverage.mjs`
(W1-T212) reads `git diff`'s ORIGINAL-file line numbers and looks them up directly in lcov's
DA: map -- with the offset bug, that lookup silently hits some UNRELATED older line's hit
count instead of the new line's, which blocked this exact PR's own new code with a false
"uncovered" verdict even though every added line the diff touched was fully exercised by a
passing, asserting test. `--enable-source-maps` makes Node translate V8 coverage positions
through tsx's inline source map back to the real .ts line before emitting DA: records, so the
two line-numbering schemes (git diff vs. lcov) finally agree.
W1-T255 IS NO LONGER IN FORCE HERE, AND THIS BLOCK SAID THE OPPOSITE UNTIL 2026-08-28.
It described this step as "routed through scripts/test-with-retry.mjs, same as the ci
job's Test step above", which the ruling below REVERSES: the retry is gone from this job
and stays in `ci`. A comment left asserting the retired wiring is worse than none — it is
the first thing a reader consults when the job misbehaves, and it would have sent them
looking for a second pass that no longer happens. The wrapper's rationale still applies
verbatim to the `ci` job; read it there.

## coverage-ratchet — step order

### Base lines 678-686 — ORDER IS LOAD-BEARING (2026-08-13): diff-coverage…

ORDER IS LOAD-BEARING (2026-08-13): diff-coverage runs BEFORE the aggregate ratchet.
No step in this job carries an `if:`, so a failing step skips every step after it —
MEASURED: in five of six recent failing CI runs the ratchet step concluded `failure` and
`Diff coverage` was `skipped`. While the aggregate floor was red, the PER-DIFF gate — the
only thing checking that a PR covers the lines it adds — DID NOT RUN AT ALL. Both gates
were down, not one. Putting the per-diff check first makes it independent of the
aggregate's verdict without an `if:` condition: a genuinely broken run still fails at the
Test step above and correctly skips both, which `if: always()` would NOT have preserved
(it would run diff-coverage against a missing lcov and report a confusing second error).

## coverage-ratchet — RMD_CI_REPORT scoping

### Base lines 699-704 — RMD_CI_REPORT is set per-STEP on…

RMD_CI_REPORT is set per-STEP on these two gate steps ONLY, never at job level: the coverage
collection step above runs the whole suite, and test/{diff-coverage,coverage-ratchet}.test.ts
spawn these same scripts over BLOCKING fixtures inheriting the job env — a job-wide flag would
publish those fixture failures as real check-run annotations. See the scripts' own
SELF-DESCRIBING FAILURES header for why the annotation (not `output.summary`, which no job can
write) is the channel a diagnosing reader can actually reach.

## mutation-ratchet

### Base lines 731-793 — §5 TIER 2, quality gate…

§5 TIER 2, quality gate 2/4 (W1-T96) — green tests that kill no mutants are theater; the
mutation score is the falsifier. Runs UNCONDITIONALLY (no path filter, no `if:`) so it
always registers a check run, same fail-closed shape as `ci`/`coverage-ratchet` above — a
conditionally-skipped required check deadlocks merge forever (LEARNINGS: the #102-class
skipped-check deadlock).

SCOPE: Stryker has no first-party test-runner plugin with per-mutant coverage-based test
filtering for Node's built-in `node --test` runner (only the generic command runner, which
reruns whatever command it is given per mutant). Mutating this project's full ~15k-line
src/** tree was measured at ~4 hours in that mode — that blows through ci-gate.yml's
15-minute required-check wait ceiling and would deadlock every PR. `stryker.conf.json`'s
`mutate` glob is therefore deliberately scoped to one pure-logic module (src/lib/classify.ts)
today. Widening scope later is a one-line glob change plus a baseline recapture in
scripts/mutation-baseline.json — no script or CI-wiring change.

LATENCY (W1-T108): even scoped to one module, a real `npx stryker run` was still costing
~13 minutes on every PR, including PRs that never touched src/lib/classify.ts and so could
not possibly move its mutation score.

LATENCY, ROUND 2 (W1-T133): W1-T108's diff-scope trigger (below) means the expensive path
now only runs on a PR that touches classify.ts's own relevant files — but this task's OWN
PR is exactly such a PR (it edits scripts/mutation-ratchet.mjs + scripts/mutation-
baseline.json), and it is also the FIRST PR since W1-T108 landed to actually exercise a real
`npx stryker run` all the way through (every prior "matched" run in the wild had failed
earlier, at the dry-run stage, on an unrelated broken fixture — see the run-task.ts fixture
fix earlier in this same task). That first real run MEASURED `stryker.conf.json`'s
`commandRunner.command` (`npm test`, the FULL test/**/*.test.ts glob — ~3,000 tests,
Playwright-backed) rerunning per mutant and BLEW WAY PAST ci-gate's 15-minute ceiling (it was
still running past the 55-minute mark). The full suite is not needed: only
test/classify.test.ts and test/block-reason.test.ts (the sole two files that import from
src/lib/classify.ts — verified by grep, and empirically by running Stryker scoped to exactly
these two files: SAME 108 valid mutants, SAME 70 killed / 12 timeout / 26 survived / 0
no-coverage split as the recorded baseline, in 54 seconds instead of 55+ minutes). Scoping
`commandRunner.command` to those two files (below) is the fix — it changes nothing about
WHAT is mutated (`mutate` stays exactly `["src/lib/classify.ts"]`, W1-T108's shape,
unchanged — proven in test/mutation-ratchet.test.ts) or what the ratchet compares, only HOW
FAST the PR gate can verify it, which is the entire point of "the PR gate stays the fast
diff-only classify.ts check" (this task's own title). Neither file needs a browser, so the
Playwright/Chromium install this job used to pay for a `npm test` dry run is gone too.

Two independent latency fixes together, same job:
 1. DIFF-SCOPED, the containment-probe shape (see that job's comment below): this job's
    check run still registers UNCONDITIONALLY (no path filter, no job `if:`) so it can
    never go silently absent and deadlock merge — but the `trigger` step below runs
    `scripts/mutation-ratchet.mjs --changed-files` (that script's OWN path-filter mode, so
    the "what counts as mutate-scope" list lives in exactly one place — see that script's
    usage comment) against this PR's changed files, and the expensive Stryker run + ratchet
    comparison only execute `if:` that diff can actually move src/lib/classify.ts's score
    (the file itself, its test, or the gate's own config/script/baseline). Every other PR
    still gets a green, near-instant check run — proven in test/mutation-ratchet.test.ts.
 2. Stryker's own INCREMENTAL MODE (`incremental`/`incrementalFile` in stryker.conf.json):
    when the run does happen, mutants whose covering code + tests are unchanged since the
    last run are reused from the incremental report instead of re-executed. The cache step
    below persists that report across runs via actions/cache (key includes the run id so
    every run saves a fresh entry; `restore-keys` falls back to the most recent one) — the
    underlying diff is a pure text comparison against the PREVIOUS report, so restoring a
    report captured on a different branch is still correct, just possibly less of a
    shortcut, never an incorrect one.

scripts/mutation-ratchet.mjs compares this run's Stryker JSON report against the recorded
floor in scripts/mutation-baseline.json and exits non-zero on any test-suite-weakening PR;
that floor only ever ratchets UP (a deliberate, reviewed bump when the mutation score
genuinely improves), never down to make a red PR pass.

## mutation-ratchet — the LIGHT timeout band

### Base lines 797-800 — W1-T1009: LIGHT band, prophylactic --…

W1-T1009: LIGHT band, prophylactic -- see the `commitlint` job's comment above for the
derivation. This job used to install Playwright too (W1-T133 removed that step because
neither file `commandRunner` now scopes to needs a browser), so it is not immune to the same
class of stall even though this task's measured hangs were on `ci`/`coverage-ratchet`.

## learnings-budget-ratchet

### Base lines 837-854 — §5 TIER 2 (W1-T38, MASTER-PLAN…

§5 TIER 2 (W1-T38, MASTER-PLAN §8A) — "compression is a deliverable" ENFORCED, not
aspirational, the same ratchet shape as coverage-ratchet/mutation-ratchet above except this
one is a CEILING: the total INJECTABLE weight of the ACTIVE learnings corpus (every
learnings/*.yaml shard, lifecycle: active entries only, rendered exactly as
src/lib/learnings.ts's selectLearnings would inject them) is compared against the recorded
cap in scripts/learnings-budget-baseline.json. Runs UNCONDITIONALLY (no path filter, no
`if:`) so it always registers a check run, same fail-closed shape as `ci`/`coverage-ratchet`/
`mutation-ratchet` above — a conditionally-skipped required check deadlocks merge forever
(LEARNINGS: the #102-class skipped-check deadlock).

SUPERSEDED/QUARANTINED entries contribute ZERO chars — src/lib/learnings.ts's
selectLearnings never injects them (W1-T33 supersession, W1-T34 quarantine), so only
INJECTABLE weight is capped, not raw corpus bytes; test/learnings-budget-ratchet.test.ts
proves that exclusion with a same-bytes-active-vs-superseded falsifier fixture.

scripts/learnings-budget-ratchet.mjs names the overage on a corpus-growing PR that pushes
past the cap; that cap only ever ratchets UP (a deliberate, reviewed bump when a compression
pass genuinely needs more room), never down to make a red PR pass.

## learnings-budget-ratchet — the CLAUDE.md size ratchet step

### Base lines 871-907 — W1-T503 (MASTER-PLAN §8A) — CLAUDE.md…

W1-T503 (MASTER-PLAN §8A) — CLAUDE.md is injected in full into every session on every
lane and was the fleet's largest per-session injectable with no budget at all, while the
learnings corpus above at a fifth its weight already had one. It rides HERE, as a step in
the sibling budget job, rather than as a job of its own, and that placement is load-bearing
rather than tidy: CI_PARITY_TABLE is asserted against ci.yml BY JOB NAME in both directions
(test/preflight-ci-parity.test.ts, via parseCiJobNames) and nothing asserts a job's STEP
list, so a new job would force a table entry in src/lib/ci-parity.ts — a product path —
beside this workflow, which is the Rule 25 pairing that held this change all day. A step
needs no entry and no src/ file.

ENFORCEMENT IS UNCHANGED BY THE PLACEMENT. A `run:` step carries no continue-on-error, so a
non-zero exit fails `learnings-budget-ratchet`, which ci-gate.yml already lists as REQUIRED.
The ratchet gains no new required check and loses no teeth.

DO NOT "COMPLETE" THIS by adding a matching runStep() to CI_PARITY_TABLE's entry: that edit
touches src/lib/ci-parity.ts and re-creates the exact pairing this placement avoids. The
cost of leaving it out is that `rmd preflight --ci-parity` does not mirror this step
locally — a fidelity gap, not a gate failure.

The cap is a size CEILING: CLAUDE.md's own charter says every addition should be paid for
by a fold ("compression is a deliverable, not just accretion"), so
scripts/claude-md-budget-baseline.json's capBytes was originally the measured size at
capture, with no room to grow into. THE OPERATOR RETIRED THAT ZERO-HEADROOM SHAPE ON
2026-08-22 and raised the cap to a round 64 KiB, after CLAUDE.md hit it with one byte of
room twice the same day and both lanes spent more effort folding prose than writing the
rule they came to write — see that baseline's bumpRationale. The gate is unchanged and
still fails closed; only the number moved. It only ever ratchets UP, by a reviewed bump
that says why growth is right — never down to make a red PR pass.
W1-T2831 — THE NET-BYTE ARM NEEDS A COMPARAND, AND WITHOUT THIS ENV IT WOULD NEVER HAVE ONE.
This job checks out at actions/checkout's DEFAULT fetch-depth of 1: a shallow clone with no
`origin/main` ref, so the script's preferred `git merge-base HEAD origin/main` cannot
resolve. Its documented fallback is BASE_SHA, which no step here was passing — so the §8A
arm would have skipped on every run and shipped a gate that never fires. Passing the event
payload's base sha is what the sibling jobs already do. Run-time resolution still WINS where
it is available (the script prefers merge-base and says which base it used), so deepening
this checkout later automatically upgrades the comparand without touching the script; and on
a push to main there is no pull_request payload, this is empty, and the arm correctly skips.

## jscpd-gate

### Base lines 914-927 — §5 TIER 2, quality gate…

§5 TIER 2, quality gate 3/4 (W1-T97) — a duplication CEILING: copy-pasted code rots
independently and silently. Runs UNCONDITIONALLY (no path filter, no `if:`) so it always
registers a check run, same fail-closed shape as `ci`/`coverage-ratchet`/`mutation-ratchet`
above — a conditionally-skipped required check deadlocks merge forever (LEARNINGS: the
#102-class skipped-check deadlock).

Unlike coverage/mutation, this needs no custom wrapper script: jscpd's own `--threshold`
flag natively exits non-zero when the duplicated-lines percentage across src/** exceeds the
ceiling recorded in .jscpd.json's "threshold" field (2%, with headroom over the 1.11%
measured baseline at capture time — .jscpd.json itself carries no comment field, since
jscpd's config parser rejects unknown keys; the rationale lives here and in
test/jscpd-gate.test.ts). See that test file's falsifier fixture for the proof this is
ACTIVE, not merely wired (a planted verbatim-copy-pasted-function fixture is REJECTED; a
no-shared-block fixture is ACCEPTED, both driving the real jscpd CLI as a subprocess).

## claims

### Base lines 946-959 — PLAN-CLAIMS gate (W1-T29, MASTER-PLAN §12A)…

PLAN-CLAIMS gate (W1-T29, MASTER-PLAN §12A) — the AWARENESS LAYER for prose. Plan prose is
unverifiable; a FALSIFIABLE claim with a command that must exit 0 is not. `plan/claims.yaml`
lists facts the plan asserts about the system, each paired with a shell assertion; this job
runs every one of them via `scripts/claims-check.mjs` and fails the moment any assertion
exits non-zero, printing the false claim's id/prose/plan_section so the log NAMES the lie
instead of leaving a bare exit code. Falsifier fixture proving this is ACTIVE (a planted
broken claim turns the CLI red and names it, a healthy claims file turns it green) lives in
test/claims-check.test.ts, driving the real CLI as a subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) — same reasoning as
`lint-plan`/`depcruise`/`jscpd-gate` above: a path-filtered REQUIRED check that can go
silently absent is the synthwatch #102 deadlock class ci-gate.yml exists to avoid, and a
claim about the system can be falsified by a change anywhere in the tree, not just under
plan/.

## assertion-discrimination

### Base lines 978-1001 — ASSERTION-DISCRIMINATION gate (W1-T1051). A test…

ASSERTION-DISCRIMINATION gate (W1-T1051). A test can assert that a literal string appears
in the RAW text of a repo file while the literal is satisfiable only by a COMMENT next to
the mechanism the test claims to pin -- the mechanism can go dead and the assertion still
passes, because the string is still written down somewhere. That is exactly how a CI wait
that should have blocked ~5 minutes on an apt lock instead returned in ~1 second and
shipped green: the test pinned the literal `flock`, which was present only because the
step's own comment named the tool it called. Mutation testing cannot see this class --
it mutates SOURCE, this defect lives in a TEST asserting against a non-source file, and
`test/**` is never a mutation target (see stryker.conf.json / mutation-nightly-scope.json).

scripts/assertion-discrimination-check.mjs strips comments from the target a variable-bound
readFileSync/readFile call statically resolves to (a real repo path, never a per-test
tmpdir) and re-evaluates the same literal against the stripped copy: present in raw text
but absent once stripped means the assertion is satisfiable by a comment alone. Findings
are checked against scripts/assertion-discrimination-baseline.json, whose every entry must
carry a written reason -- an entry without one is rejected at load time. Falsifier fixture
suite lives in test/assertion-discrimination-check.test.ts, driving the real CLI as a
subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:` beyond the PR-only gate
below) -- same reasoning as `claims`/`lint-plan`/`depcruise`/`jscpd-gate` above: a
path-filtered REQUIRED check that can go silently absent is the synthwatch #102 deadlock
class ci-gate.yml exists to avoid, and a dead-guard test can be introduced by a change
anywhere in the tree, not just under test/.

## lint-plan

### Base lines 1020-1037 — §5C Layer A (W1-T20c) —…

§5C Layer A (W1-T20c) — the CI half of the deterministic task linter. Runs
UNCONDITIONALLY on every PR (no path filter) so it always registers a check
run — a path-filtered REQUIRED check that can go silently absent is the
exact synthwatch #102 deadlock class ci-gate.yml exists to avoid. Cheap
(pure JS over plan/tasks.yaml, no network), so running it on every PR costs
nothing.

SCOPED to the PR's own edit (`--base <pr-base-sha>`): lints only task ids
that are NEW or CHANGED versus the PR base, not the whole historical queue
— re-grading everything already open is the retro's separate plan-health
sweep (W1-T20d), not every PR's gate. `fetch-depth: 0` so the base commit's
plan/tasks.yaml is resolvable via `git show`.

FAIL-CLOSED: any BLOCKING violation (sizing/headless-fitness/proof-shape/
proof-dialect/provenance) on an in-scope task fails this job, which
ci-gate's REQUIRED list waits on before it can pass — see ci-gate.yml.
proof-dialect (W1-T246, moratorium finding 9): a proof that cannot execute
(parseWhitelistedProof, reused verbatim from src/lib/review.ts) never lands.

## depcruise

### Base lines 1060-1072 — MASTER-PLAN §5 TIER 3 (W1-T26)…

MASTER-PLAN §5 TIER 3 (W1-T26) — the architecture fitness gate. The games'
purity gates ("src/game imports no Three.js") generalized into a
declarable layering rule: `src/lib` must not import the CLI entrypoint
(`src/run-task.ts`) or the scratch spike script (`src/spike.ts`) — see
`.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule and its falsifier
in `test/architecture-fitness.test.ts` (a planted violation proves the
rule is ACTIVE, not merely declared).

Runs UNCONDITIONALLY on every PR (no path filter) — same reasoning as
`lint-plan`/`leak-grep`: cheap static analysis, and a path-filtered
REQUIRED check that can go silently absent is the synthwatch #102
deadlock class ci-gate.yml exists to avoid. A violating import anywhere
under src/lib fails this job, which ci-gate's REQUIRED list waits on.

## depcruise — the cycle-count ratchet

### Base lines 1090-1096 — THE CYCLE-COUNT RATCHET. `no-circular` is…

THE CYCLE-COUNT RATCHET. `no-circular` is deliberately `warn` (see .dependency-cruiser.cjs's
own severity note): `error` would fail every PR touching any module in an existing ring, and
thirteen rings knot much of src/lib. So the cruise above REPORTS cycles and this step holds
their COUNT at or below scripts/cycle-baseline.json's ceiling -- net growth blocks, touching
a ring does not. #2798 cut the count from 24 to 13 with a config held outside the repo and
nothing held the result; this is what holds it. Runs in THIS job rather than a new one so it
adds no required context that could go silently absent (the #102 deadlock class).

## containment-probe

### Base lines 1101-1121 — MASTER-PLAN §5 TIER 1 (W1-T28):…

MASTER-PLAN §5 TIER 1 (W1-T28): "Containment probe as a REQUIRED check —
on any diff touching sandbox / deny-floor / env" (WS-0 FF10a: a settings
typo SILENTLY drops containment, so static validation alone is not
enough — the probe is the empirical guarantee, W1-T2/W1-T28).

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) — same
reasoning as `lint-plan`/`depcruise`: a path-filtered REQUIRED check that
can go silently absent is the synthwatch #102 deadlock class ci-gate.yml
exists to avoid (probe-path-filter.yml is the live fixture proving that
shape). What's SCOPED to this PR's changed paths is the job's internal
behavior, not its registration: `containment-diff-trigger.ts` reuses
`containmentTrigger()` (src/lib/specialist-panel.ts) — the SAME
deterministic predicate the Layer-4 containment specialist is routed by
— so the CI gate and the advisory panel never drift on what counts as
"touches sandbox/hooks/env/deny-floor".

When the diff matches, this job runs the deterministic
`test/containment.test.ts` suite (the fail-closed verdict logic — no
network, no secrets, no live worker spawn) as an explicit, dedicated
required assertion. When it doesn't match, the job still completes
successfully so it never blocks an unrelated PR.

## containment-probe — the harness import

### Base lines 1149-1155 — W1-T1250: `--import ./test/setup/tmp-hygiene.ts` is NOT…

W1-T1250: `--import ./test/setup/tmp-hygiene.ts` is NOT optional here, same reasoning as
W1-T1217's identical fix to coverage-ratchet above. `src/lib/ci-parity.ts`'s
`containment-probe:test` step already spells this invocation out WITH the harness import
(its own `TMP_HYGIENE_IMPORT` constant), so `rmd preflight --ci-parity` was running this
file WITH the harness while this required check ran it WITHOUT — a harness-dependent
assertion could pass locally and still fail here. Bringing this line into line with
ci-parity's mirror is the fix; ci-parity.ts itself is already correct and stays untouched.

## api-client-drift

### Base lines 1159-1171 — §7A packages/api-client GENERATOR + stale-client…

§7A packages/api-client GENERATOR + stale-client drift check (W3-T1b). "packages/api-client is
GENERATED from that surface [openapi/daemon.yaml]... drift between the committed client and
the surface is caught in CI." scripts/generate-api-client.mjs regenerates
packages/api-client/src/schema.d.ts from openapi/daemon.yaml; `--check` (npm run
api-client:check) fails the moment the committed file no longer matches a fresh regeneration
-- a hand-edited or forgotten-to-regenerate client goes RED here instead of silently drifting
from the daemon it's meant to describe. See test/api-client-drift-check.test.ts for the
falsifier proof this is ACTIVE (a planted stale/missing/unresolvable-$ref spec is REJECTED; a
freshly regenerated one is ACCEPTED), driving the real CLI as a subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) — same fail-closed shape as
`claims`/`jscpd-gate`/`lint-plan` above: a path-filtered REQUIRED check that can go silently
absent is the synthwatch #102 deadlock class ci-gate.yml exists to avoid.

## no-hand-rolled-fetch

### Base lines 1190-1202 — §7A "No client may hand-roll…

§7A "No client may hand-roll a `fetch` to the daemon -- a grep gate fails the build" (W3-T1c).
scripts/no-hand-rolled-fetch-check.mjs walks `apps` (the future dashboard/desktop/mobile
shells, MASTER-PLAN §7) and `packages` (excluding `packages/api-client` itself, the one
sanctioned place a future runtime HTTP layer for the generated client may live) and fails on
any direct `fetch(`/`axios(...)`/`new XMLHttpRequest` call -- every client must talk to the
daemon only via `@remudero/api-client`. See test/no-hand-rolled-fetch-check.test.ts for the
falsifier proof this is ACTIVE (a planted fetch/axios/XHR call in a fixture client directory
is REJECTED, a clean one is ACCEPTED, and packages/api-client is correctly excluded), driving
the real CLI as a subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) -- same fail-closed shape as
`claims`/`jscpd-gate`/`api-client-drift` above: a path-filtered REQUIRED check that can go
silently absent is the synthwatch #102 deadlock class ci-gate.yml exists to avoid.

## task-id-existence

### Base lines 1221-1239 — TASK-ID EXISTENCE gate (W1-T1048). #2251…

TASK-ID EXISTENCE gate (W1-T1048). #2251 cited an id as its OWN task id in shipped code
(two comments in deploy/recycle-container.sh, five references in
test/recycle-container.test.ts) that resolved to neither a reservation ref nor a plan
record -- the hand lane's only id source, `rmd next-task-id`, prints an id and reserves
NOTHING by design, so a later mint handed the same number out as free. Nothing noticed
until an open PR had to be renumbered. scripts/task-id-existence-check.mjs walks `src` and
`deploy` (never `test` -- excluded by construction, not exemption, since that tree's ids
are synthetic fixture data and not claims) and fails on any `W1-T<n>` that resolves to
NEITHER a `refs/rmd-id/*` reservation ref NOR a declared `- id:` plan record, against a
small written-reason baseline (scripts/task-id-existence-baseline.json) for the handful of
pre-allocator/pre-schema ids that were filed or retired before either surface existed. See
test/task-id-existence-check.test.ts for the falsifier proof this is ACTIVE (a planted
unreserved/undeclared id is REJECTED, a reservation-only id still resolves, a baseline entry
with no written reason is rejected, and the scan never reaches test/), driving the real CLI
as a subprocess (this script is a plain .mjs file outside tsconfig's `include`).

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:`) -- same fail-closed shape as
`claims`/`no-hand-rolled-fetch`/`jscpd-gate` above: a path-filtered REQUIRED check that can
go silently absent is the synthwatch #102 deadlock class ci-gate.yml exists to avoid.

## source-size

### Base lines 1264-1282 — SOURCE-SIZE ratchet — a per-file…

SOURCE-SIZE ratchet — a per-file LINE ceiling, the same shape as the `comment-load-ratchet`
and `learnings-budget-ratchet` jobs below/above and for the same reason: something grew
unnoticed. W1-T2488 built the ceiling; nothing ever ran it. Measured on a clean main at
6e31c5d2: `npm run source-size-ratchet` read BLOCKED on SEVEN files, up to +478 lines over
(review.ts 9,978 vs 9,500; run-task.ts 37,861 vs 37,500). A recorded ceiling that nothing
enforces is dead configuration that drifts, which is exactly what it had done.

This runs the ENFORCING `--baseline` mode. The `source-size-signal` script is a different
thing and stays as it is: it reports growth of changed files and never fails.

The gate refuses ONE thing: a baselined file whose line count grew past its ceiling. A
DECREASE is always accepted, and a PR that shrinks a file re-captures the ceiling downward in
the same diff (the coverage-ratchet convention) — which is what makes this usable as the
run-task.ts decomposition chain lands. See test/source-size-baseline-is-enforced.test.ts for
the falsifier proof it is ACTIVE, driving the real CLI as a subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:` beyond the PR-only trigger) —
the same fail-closed shape as the jobs around it: a path-filtered REQUIRED check that can go
silently absent is the #102 deadlock class ci-gate.yml exists to avoid.

## comment-load-ratchet

### Base lines 1301-1316 — COMMENT-LOAD ratchet — a CEILING…

COMMENT-LOAD ratchet — a CEILING on comment volume, the same shape as the
`learnings-budget-ratchet` and `jscpd-gate` jobs above and for the same reason: something grew
unnoticed. Measured on main at ea02cc83: 87,888 comment lines against 101,007 code lines
across src/, scripts/, deploy/, .github/workflows/, bin/ and hooks/ — 46.5%. Every agent
session that opens a file pays those lines in context on every run.

The gate refuses two things and judges nothing else: a file whose comment-line count grew past
scripts/comment-load-baseline.json, and a newly ADDED comment block over 40 lines. The written
standard is docs/comment-standard.md. See test/comment-load-ratchet.test.ts for the falsifier
proof this is ACTIVE (a planted grown file is REJECTED, a shrunk one ratchets down, a 41-line
added block is REJECTED and a 40-line one passes), driving the real CLI as a subprocess.

Runs UNCONDITIONALLY on every PR (no path filter, no job `if:` beyond the PR-only trigger) —
same fail-closed shape as `claims`/`jscpd-gate`/`task-id-existence` above: a path-filtered
REQUIRED check that can go silently absent is the synthwatch #102 deadlock class ci-gate.yml
exists to avoid.

## task-id-existence — fetch-depth on the checkout

### Base lines 1249-1252 — W1-T2324: the collision half compares…

W1-T2324: the collision half compares declared ids against `origin/main` AT CHECK TIME,
so that ref must exist. Without this the base read fails and the gate REFUSES (by
design -- an unreadable base read as an empty one is the false zero that produced every
id collision on 2026-08-26), which would redden every PR rather than none.

## comment-load-ratchet — fetch-depth on the checkout

### Base lines 1326-1328 — The added-block half diffs against…

The added-block half diffs against the merge base with `origin/main`, so that ref must
exist. Without this the base read fails and the gate REFUSES (by design — an unreadable
base read as an empty diff is a false zero), reddening every PR rather than none.
