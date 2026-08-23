# Recon: the guard complements — what each gate structurally cannot see — 2026-08-11

Run at origin/main `3b18d956a46e8fc6be05868146437a8e7cd6af58` (toplevel /home/user/remudero, branch
main; single `git -C` invocation; `--is-shallow-repository` = false). Report only; no code, no PRs,
no plan edits, no ids minted, no GitHub API spent. The Mac mini is DOWN — every ledger-dependent
claim below is marked UNMEASURED. Method per the brief: for each guard, construct the change that
SATISFIES it while defeating its purpose — the `criterionFieldTampered` template (its predicate was
`addedSatisfiedBy || removedField`, so APPENDING a claim+proof pair tripped neither disjunct, and a
PR was later reshaped to do exactly that — the complement was reachable and got reached).

## Q1+Q2 — the judgment surface and its complements

Sources for every row: src/lib/review.ts (judgeReview, judgeRubric, bodyContradictsDiff,
criterionFieldTampered, scanUnreachedExports, scopeGuardOutOfScopeFiles, INSTRUMENT_SURFACE,
preexistingProofHits, acceptanceBlockDiagnostics), src/lib/commit-message.ts (commitlintStep,
typecheckStep, checkCommitMessage, spawnFailureDetail), src/lib/task-linter.ts (changedTaskIds,
lintTask), src/lib/reachability.ts, src/lib/plan-architect.ts (isInPlanScope),
.github/workflows/ci.yml and ci-gate.yml.

| guard | asserts | cannot see | passing counterexample (the SHAPE) | status |
|---|---|---|---|---|
| keyword floor (judgeReview criterion matching) | the PR BODY discusses each criterion's keywords | the diff; whether discussed = done | body pastes criterion vocabulary; work absent | MEASURED — #974 merged contradicting its own changeset; #1189 merged at 2/4 |
| proof exec, `grep:` dialect | pattern matches head, misses merge-base (W1-T273) | WHERE the string landed — code, comment, or doc are identical to it | implement the STRING, not the behavior: the load-bearing text lands in a comment | MEASURED as mechanism — this session's own forward-grep convention exploits exactly this; benign use proves the reachable complement |
| proof exec, `unit test:` name-filtered | the named test passes in isolation under `--test-name-pattern` | side effects the test borrowed from siblings in full-file runs | a test green in its file, no-match/fail name-filtered | MEASURED — a session shipped one and caught it (brief-supplied); inverse polarity: it FAILS good work rather than passing bad, so it degrades verdicts, not main |
| base-run staleness downgrade (W1-T362/T273) | the proof discriminates head from base | whether the discriminating delta IS the claimed work | any new string/test that changes with the diff but proves an adjacent fact | ASSUMED — no measured instance; confirm = a merged PR whose proof passes while its claim's behavior is absent |
| bodyContradictsDiff | file-count/name claims in the body match numstat | every claim that is not about the changeset's file list — test totals, local runs, calibration numbers | fabricated validation section with correct file list | ASSUMED (accidental variant measured: truncated-run totals nearly reported, 2026-08-09 rule) |
| criterionFieldTampered (widened, #1542 + W1-T400) | no claim:/proof:/satisfied_by: line added or removed outside planOnly | fields the parser DROPS (see changedTaskIds row); prose edits to kept fields' content | reword a criterion's claim text without changing line count? — claim: lines are counted, content-edits of equal line count pass | ASSUMED; confirm = fixture diff editing claim text in place |
| planOnly carve-out (isInPlanScope) | plan-scope-only diffs may skip the proof-exec floor | that plan scope includes ENFORCEMENT DATA: `plan/claims.yaml` and `plan/policy.yaml` start with `plan/` | a "plan-only" PR weakens a claims.yaml assertion to a tautology; the claims gate then runs the tautology green forever | ASSUMED — DERIVED that the scope includes it (isInPlanScope is `MASTER-PLAN.md \|\| ORIENTATION \|\| plan/**`); no measured instance |
| scanUnreachedExports (ships-unwired floor) | a diff-added `export function` is referenced by some non-test file | reference ≠ call: the scan is regex over raw file text with NO comment stripping (DERIVED, src/lib/reachability.ts) | the new symbol's name appears in a src comment — reachable, never called | ASSUMED; cheap accidentally in this comment-dense codebase; confirm = fixture |
| call-site criterion (task-linter, warn) | new-module tasks carry `grep: symbol( in caller` | anything about tasks that DON'T carry it; the paren-grep matches a commented-out call | comment out the call after tests pass | ASSUMED; the criterion is also only a WARN at filing |
| scopeGuardOutOfScopeFiles | the run branch's diff stays inside task.files | eight of nine push paths: ONE call site guards it (DERIVED: 1 call vs 9 `gitPushRunBranch` occurrences in src/run-task.ts) | any worker push through the other eight sites carries undeclared files to review, where undeclared scope is ADVISORY (#1552) | MEASURED wiring; W1-T401 filed on the live path exactly for this |
| INSTRUMENT_SURFACE (+ W1-T402 alarm, #1543) | instrument-file edits entangled with src are flagged; a tree-derivation alarm now polices list membership | candidates the alarm's derivation heuristic cannot recognize as instruments | a NEW gate added in a shape the derivation doesn't classify (e.g. a check living inside an existing suite) | ASSUMED — the alarm closed the hand-enumeration gap the brief cites; its residual is its own heuristic |
| judgeRubric | advisory quality dimensions over diff+report | nothing binding — it cannot block by design (#1399) | n/a — advisory; complement is "ignored" | DERIVED |
| preflight commitlintStep / typecheckStep (+ spawnFailureDetail, #1553) | the child ran and exited 0; a never-started child now says SPAWN FAILURE | a child that runs and LIES (wrong config resolved, wrong cwd) — exit 0 is trusted | commitlint resolving a different config file passes vacuously | ASSUMED; the #1553 class (status:null) is now closed |
| emitter-checks (checkCommitMessage) | 3 of config-conventional's 10 error rules (W1-T416, filed) | the other 7 — body-max-line-length et al. pass the emitter and die at the commitlint JOB | worker self-certifies then reds CI | MEASURED — W1-T416's own filing evidence |
| changed-tasks lint gate (`lint-plan --base`) | changed tasks re-lint clean | edits to fields loadPlan DROPS — `design:` exists in src/lib/plan.ts only as a comment word, so changedTaskIds' JSON-compare is blind to it | a shard PR rewriting design/instructions re-lints ZERO tasks | MEASURED — #1544 recorded `0 task(s) checked` on a design-only edit (cited in #1549's body on main) |
| coverage-ratchet (floor) | aggregate line/branch % ≥ baseline | which lines; deleting tested code RAISES it | ship deletion + untested addition below floor delta | ASSUMED |
| diff-coverage | every ADDED src line instrumented by the lcov has hits | assertion quality (execute-without-assert); files with NO SF record pass vacuously; a file's coverage contribution can vanish (retry-outside-collector) | test theater: drive the lines, assert nothing | MEASURED adjacent — #1399 vacuous-OK; #1553's ten-line zeroing |
| mutation-ratchet | test-suite strength — for src/lib/classify.ts ONLY (DERIVED, ci.yml: "deliberately scoped to one pure-logic module") | assertion-weakening anywhere else in the tree | delete an assertion in any other suite; nothing red | ASSUMED as instance; the scope is measured |
| jscpd-gate | token-level duplication ≤ threshold | semantic duplication below token similarity | reimplement a module paraphrased | ASSUMED |
| claims gate (scripts/claims-check.mjs) | every plan/claims.yaml assertion exits 0 | whether the assertion still tests anything (see planOnly row) | tautologized assertion | ASSUMED — pairs with the planOnly complement |
| leak-grep | plaintext secret patterns absent | encodings/novel token formats | base64'd credential | ASSUMED |
| ci-gate aggregator | every REQUIRED check concluded success (re-reads on stale, W1-T261; wait cap sized, W1-T312) | checks that never REGISTER (conflicting PR = zero check runs, #1399); Semgrep/CodeQL/Dependency-Review are NOT in REQUIRED (DERIVED from the list) | a finding-bearing Semgrep run fails while ci-gate greens | DERIVED list; ASSUMED instance |
| lint-plan whole-plan failing-split | headline splits failing by merge evidence | (its classifier's own rule — stated with the figure by design) | subject-citation false-positives already corrected once (167→164) | MEASURED and self-documenting |

## Q3 — documented-to-agree pairs, quietly disagreeing: the pattern now has FIVE instances

1. `emitter-checks` vs the commitlint JOB — documented as unable to drift; implements 3/10 rules
   (MEASURED, W1-T416 filed).
2. `rmd check-proof` vs `execWhitelistedProof` — CLAUDE.md called one "the reviewer's own executor";
   they shared only a parser (MEASURED; CLOSED by W1-T387/#1442).
3. `deriveQueueHead` vs `isDispatchEligible` — the board passes TWO of the dispatcher's NINE
   optional callbacks, so the console cannot show what dispatch declines (brief-established;
   UNMEASURED here — the console is off-limits and the mini is down).
4. **The changed-tasks gate vs loadPlan's field set** — the gate's contract is "changed tasks
   re-lint"; `changedTaskIds` compares JSON of PARSED tasks, and the parser drops `design:` — so a
   class of edits the gate is documented to police is invisible to it (MEASURED, #1544's
   `0 task(s) checked`).
5. **The commit-status API vs the check-runs API** — two "what is CI saying" surfaces; this repo
   populates only check runs, so the statuses read is a permanent `total_count: 0` that reads as
   "nothing ran" beside green check runs (MEASURED this week on #1550 by this operator's own
   session — an observability disagreement, not a merge-safety one, but the same shape).

## Q4 — the ranked shortlist (accidental reachability × distance traveled before anything catches it)

1. **Dropped-field edits (`design:`) slip the changed-tasks gate** — accidental probability HIGH
   (any shard tidy-up), travel MAXIMUM: the next dispatched worker acts on instructions no gate
   re-linted, and nothing downstream reads the field again. MEASURED (#1544). The complement is not
   hypothetical; it is routine.
2. **Scope guard wired at one of nine push sites, with review's undeclared-scope check advisory** —
   accidental probability HIGH (W1-T401's own rationale documents live occurrences), travel: to
   main with only an advisory note in the PR comment. MEASURED wiring; W1-T401 queued.
3. **planOnly carve-out spans the enforcement data it exempts** — `plan/claims.yaml` and
   `plan/policy.yaml` are plan scope, so a plan-only PR can weaken the claims gate's own
   assertions or the fleet's policy values while skipping the proof floor; the claims job then
   certifies the weakened assertion forever. Accidental probability LOW-MEDIUM (a "tidy the
   claim" edit), travel MAXIMUM and self-concealing. ASSUMED — the one row here worth a fixture
   confirmation before anyone files anything.
4. **Body-authored evidence under the keyword floor** — validation claims that are not
   changeset-shaped (test totals, local-run results) are unverified by construction;
   bodyContradictsDiff audits only file-list claims. Accidental probability MEDIUM (the truncated
   -run near-miss is the honest variant), travel: merged. MEASURED family (#974/#1189).
5. **Comment-reachability in the ships-unwired floor** — a new export whose only "reference" is
   prose inside another file's comment reads as wired. Accidental probability MEDIUM in a codebase
   whose comments cite symbols constantly; travel: merged as dead code (the exact class the floor
   exists for). ASSUMED; one fixture would settle it.
6. **Mutation coverage scoped to one module** — assertion-weakening anywhere outside
   src/lib/classify.ts is invisible to every gate (diff-coverage sees added lines, not weakened
   asserts). Accidental probability MEDIUM ("fix the flake" by deleting the assert), travel:
   merged. Scope MEASURED, instance ASSUMED. W1-T423's golden suite will close this for the
   judges specifically, nothing closes it generally.

## The clean-bill question, answered honestly

The surface is NOT sound in the complement sense, but it is CONVERGING: of the six ranked gaps, two
are already filed as open work (W1-T401 for the push sites, W1-T416 for the emitter rules), one is
half-closed by a merged alarm (W1-T402), and the five-instance disagreement pattern has one closed
member (W1-T387). The three that nothing files or closes today are #1 (dropped-field edits), #3
(the carve-out spanning enforcement data), and #5/#6 (comment-reachability and mutation scope).
None of this is a manufactured finding: every MEASURED row cites its instance, and the ASSUMED rows
say what would confirm them.

## Plain language

For something bad to reach main unnoticed, it would most likely NOT be an attack — it would be a
routine edit that lands in one of the seams above. The easiest path today: someone rewrites the
instructions inside a task file — the part of the record the plan reader throws away — and the gate
that promises "changed tasks get re-checked" checks nothing, because as far as it can tell nothing
changed. The next worker then builds from the altered instructions. Second easiest: a worker's
branch touches files its task never declared, pushed through any of the eight unguarded doors, and
the reviewer's note about it is a suggestion, not a stop. Third, and the one that would hurt most
while looking most innocent: the rulebook's own self-checks live in the same folder as the plan, so
an edit dressed as paperwork could quietly blunt a self-check, and from then on that check would
keep reporting that everything is fine — because for the weakened version of itself, everything is.
Everything else on the list either fails loudly somewhere downstream or requires more coincidence
than this system's honest, verbose culture makes likely.
