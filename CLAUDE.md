# remudero — Claude rules

Always-on **workflow** rules by the question you're asking; knowledge lives in `learnings/*.yaml`,
`plan/`, `MASTER-PLAN.md`, `DECISIONS.md`, `LEARNINGS.md`. Nothing here is a gate; a rule needing one
gets a filed task.

**THIS FILE IS AN INDEX, AND THE ARROW IS AN INSTRUCTION TO YOU.** **The headline is the whole rule:
obey it unopened.** Its `→ doctrine/<section>/<rule>.md` body is the evidence.

**Upkeep (§8A):** workers never load it (`settingSources: []`). Rule: headline + pointer here, body (a 2–4 word slug),
`npm run agents-md`. A fold keeps the instruction in the headline; a frozen W1-T3323 row leaves only
VERBATIM in the body of the live rule carrying its instruction, its id (and a moved body's old path)
aliased in `doctrine/merged-rules.json`. Cite symbols, not line numbers, and the earning PR.

## Before you push

- **Before your FIRST push (not every commit), run `node --import tsx scripts/preflight-author.mjs` on the
  committed tree; required hosted checks still gate merge.** → doctrine/before-you-push/preflight-before-first-push.md
- **A test run with no `# tests` summary is NOT A RESULT, and a summary over an UNVERIFIED FILE LIST
  is not one either — `node --test` given a ghost path returns a green count, silently. `ls` first.** → doctrine/before-you-push/no-summary-no-result.md

## Writing proofs and acceptance criteria

- **THE BLOCK MUST PARSE BEFORE ANY PROOF IN IT CAN RUN — check GITHUB'S STORED BODY with
  `rmd check-acceptance`, never your local file.** → doctrine/writing-proofs-and-acceptance-criteria/check-the-stored-body.md
- **EVERY proof needs a dialect prefix — `unit test:` or `grep:`. A bare title is PROSE and never
  executes.** → doctrine/writing-proofs-and-acceptance-criteria/dialect-prefix.md
- **A `unit test:` title is matched as a LITERAL substring after escaping — the OPPOSITE of a
  `grep:` pattern, which is a BASIC REGEX.** → doctrine/writing-proofs-and-acceptance-criteria/title-is-literal.md
- **Require a verbatim `grep -rlF -- '<substring>' test/` hit — a passing scoped test run is NOT
  evidence the proof resolves.** → doctrine/writing-proofs-and-acceptance-criteria/require-a-verbatim-hit.md
- **Verify a `grep:` proof with the executor's REAL invocation — `grep -arn -- '<pattern>' <path>` —
  never with `grep -F`.** → doctrine/writing-proofs-and-acceptance-criteria/executor-invocation.md
- **A `grep:` proof must match text on ONE PHYSICAL LINE — a YAML block scalar wraps, and the
  pattern then reads 0 at head with no error.** → doctrine/writing-proofs-and-acceptance-criteria/one-physical-line.md

## Coverage traps

- **A new `.ts` file's `DA:<line>,0` on a doc comment or `interface` body is EXEMPT — never reorder
  a file to dodge it.** → doctrine/coverage-traps/type-only-lines-exempt.md
- **When every test injects a fake, the seam's DEFAULT implementation and each `catch` arm are
  unreachable — write one test that really shells out, and one per catch arm.** → doctrine/coverage-traps/cover-the-real-default.md
- **Before trusting `diff-coverage: OK`, prove the lcov INSTRUMENTS the changed files —
  `grep -c '^SF:<path>$' <lcov>` must be non-zero for every source file in the diff.** → doctrine/coverage-traps/lcov-instruments-the-diff.md
- **Build the lcov and the diff from the SAME tree — commit before measuring — AND NAME THE SHA in
  what you report.** → doctrine/coverage-traps/same-tree-name-the-sha.md
- **`diff-coverage` flags ADDED lines, so restructuring an untested region inherits its debt at the
  gate — measure MAIN's coverage of that region before assuming the PR caused it.** → doctrine/coverage-traps/added-lines-inherit-debt.md
- **A deps object supplying SOME fakes leaves every other seam on its REAL default — so relaxing a
  guard can make a previously-dead default FIRE, in a file the diff never touched.** → doctrine/coverage-traps/partial-fakes-fire-defaults.md
- **Verify a new falsifier by DELETING the fix and re-running — `# fail N` removed vs `# fail 0`
  restored is the evidence it is load-bearing.** → doctrine/coverage-traps/delete-the-fix.md
- **ZERO A `DA:` VALUE INSIDE THE TARGET's OWN `SF:` BLOCK — a whole-file replace hits another
  file's identical line number and returns a FALSE `OK`.** → doctrine/coverage-traps/zero-inside-own-sf-block.md

## Plan and task hygiene

- **Every builder, reviewer and worker must clean up its own disposable workspace artifacts before
  finishing; preserve active/shared paths, unpublished work and durable evidence, and leave
  worktree retirement to the harness.** → doctrine/plan-and-task-hygiene/finish-owned-work.md
- **Derive "which tasks are merged" from merged PRs' `Remudero-Task:` trailer UNIONED with their
  `run-<taskId>-*` branch, and a PR's merge state from the API — never ledger verdict lines, a
  shard's `status:` or main's log.** → doctrine/plan-and-task-hygiene/derive-merged-tasks.md
- **Before building a filed task, check `git ls-remote origin 'refs/rmd-dispatch/<id>' 'refs/heads/run-<id>-*'`
  (claimed or in flight?) and merged PRs for an exact `^Remudero-Task: <id>$` trailer (shipped?), never commit subjects.** → doctrine/plan-and-task-hygiene/run-both-scope-checks.md
- **Before filing, sweep the task's SUBJECT over every open PR head's tree (`git ls-remote --heads
  origin`), not only `origin/main`, counting per head against main.** → doctrine/plan-and-task-hygiene/sweep-open-pr-heads.md
- **NAME A SESSION BRANCH `run-<taskId>-<epochMs>` WHEN BUILDING A FILED TASK.** → doctrine/plan-and-task-hygiene/name-the-session-branch.md
- **A new test goes in the `test/<folder>/` that `rmd test-place` computes from its imports — never directly
  under `test/`.** → doctrine/plan-and-task-hygiene/new-tests-go-in-their-computed-folder.md
- **Before believing "task X is next", confirm the frontier with the repo's own selector —
  `runnableCandidates(plan, isMerged, n)` — not the task a brief or retro names** → doctrine/plan-and-task-hygiene/confirm-the-frontier.md
- **A contested reservation is never deleted and an unfiled one is never free — the
  LOSER of a race renumbers.** → doctrine/plan-and-task-hygiene/loser-renumbers.md
- **File a plan task from the OPERATOR CHECKOUT — a session that cannot reserve mints on hope.** → doctrine/plan-and-task-hygiene/file-from-the-operator-checkout.md
- **`rule15-filing` refuses a plan record in `files:` only when an OUT-OF-PLAN path rides along —
  the record ALONE passes at `verify: auto`.** → doctrine/plan-and-task-hygiene/rule15-plan-record.md
- **Decode citations: "Rule N" = MASTER-PLAN §12; "G-N" = §14 "Grill RESOLVED"; "P48"/"DR-N" =
  its retro ledger; `rule15-*` names an artifact, not a rule.** → doctrine/plan-and-task-hygiene/decode-rule-citations.md
- **Take the cheap candidate beside a costly one, and name what the costly one now waits for.** → doctrine/plan-and-task-hygiene/take-the-cheap-candidate.md
- **Never fan out update-branch after a main fix: protection is non-strict, and each refresh re-runs
  ~16 min of CI and voids the review.** → doctrine/plan-and-task-hygiene/never-fan-out-update-branch.md
- **Leave a red fleet PR to the fix lane while a round is due or in flight — hand pushes out-race it
  and hide its defects.** → doctrine/plan-and-task-hygiene/leave-red-prs-to-the-fix-lane.md

## CI and merging

- **Space `gh` reads 180 s apart, never poll — `deny-floor.sh` refuses a closer read; GitHub's
  SECONDARY limit 403s on RATE while `rate_limit` reads full; `gh pr create` may die, git push won't.** → doctrine/ci-and-merging/gh-read-cadence.md
- **A CONFLICTING PR registers ZERO check runs. `total: 0` reads as "still queued" but means
  `mergeable_state: dirty` — check mergeability before waiting on CI.** → doctrine/ci-and-merging/conflicting-pr-zero-checks.md
- **Two PRs appending tests to one file's TAIL can conflict before a SHARED closing `});` — close
  the ours-side block yourself; esbuild says only `Unexpected end of file`.** → doctrine/ci-and-merging/close-the-ours-side-block.md
- **A RETITLE ALONE re-runs the title lint — `pr-title-lint.yml` fires on `edited`; push no sha to
  clear a title red, nor a stale-red `ci-gate` (it self-clears).** → doctrine/ci-and-merging/edit-relints-the-title.md
- **Never add an advisory ignore, scanner exclusion or gate loosening without the operator's explicit
  yes; read ALL comments on another session's PR before pushing to it.** → doctrine/ci-and-merging/no-unapproved-waivers.md
- **A BAKED-path merge (`deploy/Dockerfile`, `deploy/entrypoint.sh`) ships itself by auto ACR build +
  recycle, not at merge — confirm with `docker inspect` before calling it shipped.** → doctrine/ci-and-merging/a-baked-path-merge-ships-itself.md
- **PRs green on their own bases can cross a ceiling together: a `# fail 0` main red is a ratchet
  collision, and main records it (#10724).** → doctrine/ci-and-merging/ratchet-collision.md
- **Compare a base-red PR's failing check to main's FULL check census, not ci-gate's aggregates, or
  every shard red is held.** → doctrine/ci-and-merging/base-red-full-census.md

## Ledger and evidence discipline

- **Grep the ledger with `rmd ledger-grep <pat>`; by hand, `zgrep` THREE globs —
  `state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson` — with a file count PER
  FORM as the control, and never delete an archive: each holds history no other file has.** → doctrine/ledger-and-evidence-discipline/read-the-ledger-union.md
- **A ledger line must carry the reason from the DECISION THAT PRODUCED ITS OUTCOME.** → doctrine/ledger-and-evidence-discipline/reason-from-the-decision.md
- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** → doctrine/ledger-and-evidence-discipline/exclude-the-relative-path.md
- **Before calling a git fixture flaky, rerun it with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`
  — CI has no git identity; set one IN THE FIXTURE, never skip it.** → doctrine/ledger-and-evidence-discipline/git-fixture-identity.md

## Investigation discipline

- **When a gate reads the ledger for a record the SAME function writes, check the WRITE ORDER before
  believing the gate's stated reason.** → doctrine/investigation-discipline/check-the-write-order.md
- **Prove a dispatch change in-process with `assertLintClean`, never `rmd drain --dry-run` — it writes
  the LIVE ledger and reads origin/main's plan, not your branch.** → doctrine/investigation-discipline/drain-dry-run-writes.md
- **A bound that fires on a HEALTHY condition is this repo's recurring defect — before tuning the
  number, check the population it is meant to separate has ever been observed.** → doctrine/investigation-discipline/healthy-condition-bound.md
- **A ZERO IS NOT A MEASUREMENT until a positive control proves the query saw its corpus — run one on
  every sweep you will act on. A control proves only that: name the question the query really
  answers, check the corpus's newest ts covers the window, and re-run a surprise in another ENVIRONMENT.** → doctrine/investigation-discipline/a-zero-needs-a-positive-control.md
- **(a) A POSIX REGEX ENGINE HERE SILENTLY DROPS `\s`/`\b` INSTEAD OF ERRORING, AND TWO DIFFERENT
  TOOLS DO IT.** → doctrine/investigation-discipline/posix-drops-escapes.md
- **(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` (ignore-binary) INJECTED, so a file
  holding ONE NUL byte is skipped entirely — no output, exit 1, indistinguishable from real
  absence.** → doctrine/investigation-discipline/ugrep-skips-binary.md
- **Control a multi-form glob on COVERAGE (was every form opened?), not on a match — a glob naming
  one form answers from the other silently.** → doctrine/investigation-discipline/control-on-coverage.md
- **(f) THE TWO SIDES OF A COMPARISON MUST COUNT THE SAME UNITS — `ls` COUNTS A DIRECTORY AS ONE
  ENTRY.** → doctrine/investigation-discipline/count-the-same-units.md
- **(g) A CHANGE THAT REMOVES AN ACCESS PATH MUST PROVE THE REPLACEMENT FIRST, FROM A NEW SESSION
  — AN EXISTING CONNECTION IS NOT EVIDENCE.** → doctrine/investigation-discipline/prove-the-replacement-first.md
- **(h) A GATE RUN FROM A CHECKOUT that is BEHIND answers about a file and a threshold that both
  moved — run it against `origin/main`'s blobs and report the behind-count.** → doctrine/investigation-discipline/gate-against-origin-main.md
- **Beside the `git grep -l <symbol>` caller sweep, run the census suites your diff joins
  (`rmd census-membership`) — they WALK a population and name none of your symbols.** → doctrine/investigation-discipline/run-the-census-suites.md
- **A `catch` returning a success-shaped literal is a CLAIM: name what it collapses, and where remedies
  differ, return a third value the caller sees.** → doctrine/investigation-discipline/catch-is-a-claim.md
- **A clock-shifted run failing ENOENT on its own fixture is the boot temp sweep, not a time bomb —
  use a private TMPDIR.** → doctrine/investigation-discipline/clock-shift-enoent.md
- **Judge main from its newest commit with genuine evidence — its head alone reads undetermined
  forever under steady merges, and a push run CANCELLED while pending is not red.** → doctrine/investigation-discipline/main-genuine-evidence.md
- **recurrence is a class signal, not a root-cause diagnosis; preserve the per-PR disposition and file a bounded observation proposal before class-wide repair.** → doctrine/investigation-discipline/recurrence-is-a-class-signal.md
- **Replay a projected effect on the ledger before building for it; audit a shipped mechanism's
  first live rows for contradictions.** → doctrine/investigation-discipline/replay-then-audit.md

## Code traps

- **Read re-entrancy from `process.env`, not an injected `env` argument — a spawn writes a child's
  environment and cannot reach a parameter.** → doctrine/code-traps/reentrancy-from-process-env.md
- **A fixed date constant compared against rows stamped at REAL time is a time bomb; the signature
  is a red beginning at a clock boundary with no diff involved.** → doctrine/code-traps/fixed-date-time-bomb.md
