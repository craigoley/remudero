# remudero — Claude rules

Always-on **workflow** rules that prevent repeated wasted cycles. Organized by the question you're
asking when you need one, because that — not the date you learned it — is how a rule gets found.

**Where knowledge actually lives:** `learnings/*.yaml` (the machine-readable, lifecycle-managed,
CI-budgeted store — `scripts/learnings-budget-ratchet.mjs` caps its injectable weight), `plan/` +
`MASTER-PLAN.md`, `DECISIONS.md`, `LEARNINGS.md`. CLAUDE.md holds only workflow rules; it does not
restate feature history.

**Nothing in this file is a gate.** Every rule here is UNENFORCED prose: a convention that binds
only because you read it. The gates are elsewhere and refuse you by name — `coverage-ratchet` and
`diff-coverage` on coverage, `proof-dialect` at dispatch and `lint-plan`'s changed-tasks pass on
proofs, `judgeReview`'s rubric on the PR, `SymlinkInstallRefusal` on a worktree install. That split
is the point: a rule stated ONLY here can be violated silently and repeatedly, which is why several
of these bullets exist at all. When a rule below turns out to matter, the fix is to make something
refuse it — file the task; do not sharpen the wording and call it closed. Rules that name their own
enforcing gate say so inline.

**THIS FILE IS AN INDEX, AND THE ARROW IS AN INSTRUCTION TO YOU.** Every rule is a bolded
HEADLINE followed by `→ doctrine/<section>/<rule>.md`. **The headline is the whole rule — obey it
without opening anything.** The file it points at holds the EVIDENCE: the measurement, the PR, the
session that earned it. Open that file when you are about to apply the rule precisely, when you
doubt it, or when you are about to do the thing it forbids — `cat` the path, it is plain markdown
holding the same bullet unabridged. A headline whose pointer does not resolve is a BUG, not a rule
you may skip; `test/the-doctrine-index-points-at-every-body.test.ts` fails on a dangling one.

**Maintaining this file:** INTERACTIVE sessions here load the index and pay that tax per
session; a DISPATCHED WORKER never sees it — `spawnWorker` passes `settingSources: []`, the SDK's
isolation mode, which needs `'project'` to load CLAUDE.md (only Codex reads it). Keep it
compressed for the lane that pays. A NEW RULE IS TWO EDITS: the headline bullet with its pointer
here, and the body file it names. Per §8A, *compression is a deliverable*: a retro adding a rule
folds or deletes what it supersedes — and folding now means shortening the HEADLINE, because that
is the half every session pays for. Cite **symbol names, not line numbers** — every one this file
carried had gone stale. Each rule cites the PR that earned it.

## Before you push

- **Run the shipped local gate before your FIRST push, not every commit.** → doctrine/before-you-push/run-the-shipped-local-gate-before-your-first-push-not.md
- **A test run with no `# tests` summary is NOT A RESULT, and a summary over an UNVERIFIED FILE LIST
  is not one either — `node --test` given a ghost path returns a green count, silently. `ls` first.** → doctrine/before-you-push/a-test-run-with-no-summary-is-not-a-result-and-a-summary.md

## Writing proofs and acceptance criteria

- **THE BLOCK MUST PARSE BEFORE ANY PROOF IN IT CAN RUN — check GITHUB'S STORED BODY with
  `rmd check-acceptance`, never your local file.** → doctrine/writing-proofs-and-acceptance-criteria/the-block-must-parse-before-any-proof-in-it-can-run-check.md
- **EVERY proof needs a dialect prefix — `unit test:` or `grep:`. A bare title is PROSE and never
  executes.** → doctrine/writing-proofs-and-acceptance-criteria/every-proof-needs-a-dialect-prefix-or-a-bare-title-is.md
- **A `unit test:` title is matched as a LITERAL substring after escaping — the OPPOSITE of a
  `grep:` pattern, which is a BASIC REGEX.** → doctrine/writing-proofs-and-acceptance-criteria/a-title-is-matched-as-a-literal-substring-after-escaping.md
- **Require a verbatim `grep -rlF -- '<substring>' test/` hit — a passing scoped test run is NOT
  evidence the proof resolves.** → doctrine/writing-proofs-and-acceptance-criteria/require-a-verbatim-hit-a-passing-scoped-test-run-is-not.md
- **Verify a `grep:` proof with the executor's REAL invocation — `grep -arn -- '<pattern>' <path>` —
  never with `grep -F`.** → doctrine/writing-proofs-and-acceptance-criteria/verify-a-proof-with-the-executor-s-real-invocation-never.md
- **A `grep:` proof must match text on ONE PHYSICAL LINE — a YAML block scalar wraps, and the
  pattern then reads 0 at head with no error.** → doctrine/writing-proofs-and-acceptance-criteria/a-proof-must-match-text-on-one-physical-line-a-yaml-block.md

## Coverage traps

- **A new `.ts` file's `DA:<line>,0` on a doc comment or `interface` body is EXEMPT — never reorder
  a file to dodge it.** → doctrine/coverage-traps/in-a-new-file-sandwich-type-only-declarations-between.md
- **When every test injects a fake, the seam's DEFAULT implementation and each `catch` arm are
  unreachable — write one test that really shells out, and one per catch arm.** → doctrine/coverage-traps/when-every-test-injects-a-fake-the-seam-s-default.md
- **Before trusting `diff-coverage: OK`, prove the lcov INSTRUMENTS the changed files —
  `grep -c '^SF:<path>$' <lcov>` must be non-zero for every source file in the diff.** → doctrine/coverage-traps/before-trusting-prove-the-lcov-instruments-the-changed.md
- **Build the lcov and the diff from the SAME tree — commit before measuring — AND NAME THE SHA in
  what you report.** → doctrine/coverage-traps/build-the-lcov-and-the-diff-from-the-same-tree-commit.md
- **`diff-coverage` flags ADDED lines, so restructuring an untested region inherits its debt at the
  gate — measure MAIN's coverage of that region before assuming the PR caused it.** → doctrine/coverage-traps/flags-added-lines-so-restructuring-an-untested-region.md
- **A deps object supplying SOME fakes leaves every other seam on its REAL default — so relaxing a
  guard can make a previously-dead default FIRE, in a file the diff never touched.** → doctrine/coverage-traps/a-deps-object-supplying-some-fakes-leaves-every-other-seam.md
- **Verify a new falsifier by DELETING the fix and re-running — `# fail N` removed vs `# fail 0`
  restored is the evidence it is load-bearing.** → doctrine/coverage-traps/verify-a-new-falsifier-by-deleting-the-fix-and-re-running.md
- **ZERO A `DA:` VALUE INSIDE THE TARGET's OWN `SF:` BLOCK — a whole-file replace hits another
  file's identical line number and returns a FALSE `OK`.** → doctrine/coverage-traps/zero-a-value-inside-the-target-s-own-block-a-whole-file.md

## Plan and task hygiene

- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** → doctrine/plan-and-task-hygiene/derive-which-tasks-are-merged-from-the-trailer-on-merged.md
- **AND A TRAILER-ONLY SET UNDER-CREDITS, because the BRANCH NAME is a second, independent credit
  path.** → doctrine/plan-and-task-hygiene/and-a-trailer-only-set-under-credits-because-the-branch.md
- **THE TWO SCOPE-TIME CHECKS, AS COMMANDS — RUN BOTH BEFORE BUILDING A FILED TASK.** → doctrine/plan-and-task-hygiene/the-two-scope-time-checks-as-commands-run-both-before.md
- **Sweep the SUBJECT over open PR heads, not only `origin/main` — the id half already does.** → doctrine/plan-and-task-hygiene/sweep-the-subject-over-open-pr-heads-not-only-the-id-half.md
- **NAME A SESSION BRANCH `run-<taskId>-<epochMs>` WHEN BUILDING A FILED TASK.** → doctrine/plan-and-task-hygiene/name-a-session-branch-when-building-a-filed-task.md
- **Before believing "task X is next", confirm the frontier with the repo's own selector —
  `runnableCandidates(plan, isMerged, n)` — not the task a brief or retro names** → doctrine/plan-and-task-hygiene/before-believing-task-x-is-next-confirm-the-frontier-with.md
- **A contested reservation is never deleted and an unfiled one is never free — the
  LOSER of a race renumbers.** → doctrine/plan-and-task-hygiene/a-contested-reservation-is-never-deleted-and-an-unfiled.md
- **`rule15-filing` refuses a plan record in `files:` only when an OUT-OF-PLAN path rides along —
  the record ALONE passes at `verify: auto`.** → doctrine/plan-and-task-hygiene/refuses-a-plan-record-in-only-when-an-out-of-plan-path.md
- **A shard's `status:` field is not a completion signal — it stays `queued` on tasks that
  shipped.** → doctrine/plan-and-task-hygiene/a-shard-s-field-is-not-a-completion-signal-it-stays-on.md
- **Decoding rule citations — where each family canonically lives.** → doctrine/plan-and-task-hygiene/decoding-rule-citations-where-each-family-canonically.md

## CI and merging

- **Do NOT push a fresh sha to clear a stale-red `ci-gate` — it self-clears.** → doctrine/ci-and-merging/do-not-push-a-fresh-sha-to-clear-a-stale-red-it-self.md
- **CADENCE IS THE BUDGET, NOT INTENT — a sparse check-in is fine, a poll is not. NOW ENFORCED:** → doctrine/ci-and-merging/cadence-is-the-budget-not-intent-a-sparse-check-in-is-fine.md
- **`gh pr create` may die on API quota; git push is unaffected.** → doctrine/ci-and-merging/may-die-on-api-quota-git-push-is-unaffected.md
- **A CONFLICTING PR registers ZERO check runs. `total: 0` reads as "still queued" but means
  `mergeable_state: dirty` — check mergeability before waiting on CI.** → doctrine/ci-and-merging/a-conflicting-pr-registers-zero-check-runs-reads-as-still.md
- **When two PRs append tests to the same file's TAIL, the conflict region can cut just before a
  SHARED closing `});`** → doctrine/ci-and-merging/when-two-prs-append-tests-to-the-same-file-s-tail-the.md
- **A corrected PR title is observed by a RE-RUN, not only by a new sha — but `edited` still fires
  nothing.** → doctrine/ci-and-merging/a-corrected-pr-title-is-observed-by-a-re-run-not-only-by-a.md
- **A merge to a BAKED path ships nothing until an operator triggers an image rebuild — know which
  half of your diff you are in before you call a merge "shipped."** → doctrine/ci-and-merging/a-merge-to-a-baked-path-ships-nothing-until-an-operator.md

## Ledger and evidence discipline

- **The rotations come in TWO FORMS and every glob that names only one answers SILENTLY WRONG. The
  union is three patterns, never two:** → doctrine/ledger-and-evidence-discipline/the-rotations-come-in-two-forms-and-every-glob-that-names.md
- **THE CONTROL MUST PROVE EACH FORM WAS READ, and a raw cross-archive count CANNOT** → doctrine/ledger-and-evidence-discipline/the-control-must-prove-each-form-was-read-and-a-raw-cross.md
- **And the archives are NOT cumulative snapshots.** → doctrine/ledger-and-evidence-discipline/and-the-archives-are-not-cumulative-snapshots.md
- **A ledger line must carry the reason from the DECISION THAT PRODUCED ITS OUTCOME.** → doctrine/ledger-and-evidence-discipline/a-ledger-line-must-carry-the-reason-from-the-decision-that.md
- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** → doctrine/ledger-and-evidence-discipline/on-a-zero-match-still-emits-exclude-the-wrapper-by-the.md
- **A fixture shelling git PLUMBING fails on every CI runner and passes on every dev machine, so it
  reads as flaky when it is deterministic.** → doctrine/ledger-and-evidence-discipline/a-fixture-shelling-git-plumbing-fails-on-every-ci-runner.md

## Investigation discipline

- **When a gate reads the ledger for a record the SAME function writes, check the WRITE ORDER before
  believing the gate's stated reason.** → doctrine/investigation-discipline/when-a-gate-reads-the-ledger-for-a-record-the-same.md
- **`rmd drain --dry-run` is neither side-effect-free nor able to see your branch.** → doctrine/investigation-discipline/is-neither-side-effect-free-nor-able-to-see-your-branch.md
- **A bound that fires on a HEALTHY condition is this repo's recurring defect — before tuning the
  number, check the population it is meant to separate has ever been observed.** → doctrine/investigation-discipline/a-bound-that-fires-on-a-healthy-condition-is-this-repo-s.md
- **A ZERO IS NOT A MEASUREMENT UNTIL A POSITIVE CONTROL PROVES THE QUERY COULD SEE ITS CORPUS.
  RUN ONE ON EVERY SWEEP WHOSE ANSWER YOU INTEND TO ACT ON.** → doctrine/investigation-discipline/a-zero-is-not-a-measurement-until-a-positive-control.md
- **(a) A POSIX REGEX ENGINE HERE SILENTLY DROPS `\s`/`\b` INSTEAD OF ERRORING, AND TWO DIFFERENT
  TOOLS DO IT.** → doctrine/investigation-discipline/a-a-posix-regex-engine-here-silently-drops-instead-of.md
- **(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` (ignore-binary) INJECTED, so a file
  holding ONE NUL byte is skipped entirely — no output, exit 1, indistinguishable from real
  absence.** → doctrine/investigation-discipline/b-the-in-this-harness-is-a-ugrep-wrapper-with-ignore.md
- **(c) A GLOB THAT NAMES ONE FILE FORM ANSWERS FROM THE OTHER WITHOUT SAYING SO.** → doctrine/investigation-discipline/c-a-glob-that-names-one-file-form-answers-from-the-other.md
- **(d) A QUERY CAN ANSWER THE WRONG QUESTION WITH A PERFECTLY GOOD ZERO, AND NO POSITIVE CONTROL
  SAVES YOU.** → doctrine/investigation-discipline/d-a-query-can-answer-the-wrong-question-with-a-perfectly.md
- **(e) A CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS IS THE RIGHT ONE
  — AND RE-RUNNING THE SAME WAY IS NOT A SECOND OPINION.** → doctrine/investigation-discipline/e-a-control-proves-the-query-can-see-its-corpus-it-does.md
- **(f) THE TWO SIDES OF A COMPARISON MUST COUNT THE SAME UNITS — `ls` COUNTS A DIRECTORY AS ONE
  ENTRY.** → doctrine/investigation-discipline/f-the-two-sides-of-a-comparison-must-count-the-same-units.md
- **(g) A CHANGE THAT REMOVES AN ACCESS PATH MUST PROVE THE REPLACEMENT FIRST, FROM A NEW SESSION
  — AN EXISTING CONNECTION IS NOT EVIDENCE.** → doctrine/investigation-discipline/g-a-change-that-removes-an-access-path-must-prove-the.md
- **(h) A GATE RUN FROM A CHECKOUT that is BEHIND answers about a file and a threshold that both
  moved — run it against `origin/main`'s blobs and report the behind-count.** → doctrine/investigation-discipline/h-a-gate-run-from-a-checkout-that-is-behind-answers-about.md
- **(i) A POSITIVE CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS COVERS THE
  WINDOW.** → doctrine/investigation-discipline/i-a-positive-control-proves-the-query-can-see-its-corpus.md
- **(j) A CENSUS TEST NAMES NONE OF YOUR SYMBOLS, SO THE CALLER SWEEP ABOVE CANNOT FIND IT** → doctrine/investigation-discipline/j-a-census-test-names-none-of-your-symbols-so-the-caller.md
- **(k) A RULE 21 protocol run passing `{ baseTask }` ALONE reports THREE INDISTINGUISHABLE ZEROS.** → doctrine/investigation-discipline/k-a-rule-21-protocol-run-passing-alone-reports-three.md

## Code traps

- **Read re-entrancy from `process.env`, not an injected `env` argument — a spawn writes a child's
  environment and cannot reach a parameter.** → doctrine/code-traps/read-re-entrancy-from-not-an-injected-argument-a-spawn.md
- **A fixed date constant compared against rows stamped at REAL time is a time bomb; the signature
  is a red beginning at a clock boundary with no diff involved.** → doctrine/code-traps/a-fixed-date-constant-compared-against-rows-stamped-at.md
