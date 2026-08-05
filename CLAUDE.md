# remudero — Claude rules

Always-on **workflow** rules that prevent repeated wasted cycles. Organized by the question you're
asking when you need one, because that — not the date you learned it — is how a rule gets found.

**Where knowledge actually lives:** `learnings/*.yaml` (the machine-readable, lifecycle-managed,
CI-budgeted store — `scripts/learnings-budget-ratchet.mjs` caps its injectable weight), `plan/` +
`MASTER-PLAN.md`, `DECISIONS.md`, `LEARNINGS.md`. CLAUDE.md holds only workflow rules; it does not
restate feature history.

**Maintaining this file:** it is injected in full into every session, so it is a context tax paid
per session — keep it compressed. Per MASTER-PLAN §8A, *compression is a deliverable, not just
accretion*: a retro that adds a rule must also fold, sharpen, or delete the ones it supersedes.
Cite **symbol names, not line numbers** — line numbers drift and every one this file used to carry
had gone stale. Each rule cites the PR that earned it; that citation is the pointer to the full
forensic detail, so the narrative does not need to live here.

## Before you push

- **Run the diff-coverage gate LOCALLY before pushing any PR that adds source lines.** It runs in
  seconds; `coverage-ratchet` blocked three consecutive PRs on first push, each costing a full
  amend + force-push + CI round-trip.
  `node --test --experimental-test-coverage --enable-source-maps --test-reporter=lcov --test-reporter-destination=/tmp/x.lcov --import tsx --import ./test/setup/tmp-hygiene.ts <touched test files>`
  then `node scripts/diff-coverage.mjs --lcov /tmp/x.lcov --diff <(git diff --cached origin/main -- <touched src files>)`.
  *(#768, #773, #777)*
- **A local lcov is not predictive in EITHER direction — calibrate it before trusting a local block
  or a local pass.** CI builds its lcov from the full suite and reaches paths a scoped run never
  does (one local run flagged 13 lines where CI flagged 3; it also cannot prove absence). Calibrate
  by running `scripts/diff-coverage.mjs` with your lcov against a recently-merged, CI-green commit
  (`git show <sha> -- src/… > /tmp/x.diff`). If that blocks too, your lcov under-reports and a
  local block means "investigate", not "stop". *(#981; #973/#975 both blocked locally yet merged green)*
- **Verify every PR-body claim about your own diff against `git diff --numstat`, and RE-VERIFY after
  each follow-up commit.** The `remudero-review` keyword floor matches the BODY and never opens the
  diff, so a body contradicting its own changeset still merges on a `success` status. #974 merged
  claiming "exactly one file: MASTER-PLAN.md" while carrying three, including `docs/ORIENTATION.md`
  — which sits outside `isInPlanScope` and cost the PR its `planOnly` carve-out. *(#974, #984)*

## Writing proofs and acceptance criteria

- **EVERY proof needs a dialect prefix — `unit test:` or `grep:`. A bare title is PROSE and never
  executes.** `rmd check-proof` refuses it in as many words: *"a proof with no dialect prefix at all
  is prose and never executes."* It does not fail loudly; it silently contributes nothing and the
  verdict lands CAPPED at `proof_exec: 0/N`, which will not arm auto-merge. #1194 posted 0/3 that
  way, and **#1189 MERGED at 2/4** — only its two `grep:` proofs ever ran, and nothing said so.
  Write `unit test: <exact-title substring>`: the prefix is required, and what follows it must be a
  bare title, NOT the `test/foo.test.ts::title` form — that form satisfies `rmd lint-plan` but the
  executor feeds the whole string to `--test-name-pattern` and matches zero tests. In a **plan
  shard**, use the pure-path form `unit test: test/foo.test.ts`: it lint-passes and executes the
  whole file. **Verify every proof through `rmd check-proof '<proof>'` before opening the PR** — it
  is the reviewer's own parser and executor, and prints the parse kind, the resolved candidates and
  the exit code. Require `candidates: 1 file(s)` and the REAL test name in the TAP output; a
  zero-match returns `candidates: absent`. *(#766, #773, #777, #1189, #1194)*
- **Require a verbatim `grep -rlF -- '<substring>' test/` hit — a passing scoped test run is NOT
  evidence the proof resolves.** `resolveNameFilteredCandidates` greps the SOURCE with a fixed
  string, so a title assembled from `" + "`-joined literals exists verbatim in no file: a proof
  spanning that concatenation seam resolves to ZERO candidates and is judged unexecutable even
  though the test exists and passes. *(impl-AG, caught pre-commit)*
- **Keep a `unit test:` body under 100 characters with at most ONE comma and no `"; "`, and never
  let a `grep:` PATTERN contain `" in "`.** `looksLikeScenarioNarrative` (`src/lib/task-linter.ts`)
  fails `proof-resolvability` at ≥2 commas, or `"; "` plus a comma, or >100 chars. A `grep:` proof
  splits on the LAST `" in "` before a path-like token, so `" in "` inside the pattern mis-splits.
  Forward references are legitimate — for an unimplemented task the named test does not exist yet;
  what must hold today is that the proof PARSES. Forward-referencing a PATH is safe;
  forward-referencing a SYMBOL NAME is a guess. *(#982, #984; #920 → #943 vs #921 as counter-example)*
- **Verify a `grep:` proof with the executor's REAL invocation — `grep -arn -- '<pattern>' <path>` —
  never with `grep -F`.** The executor passes the pattern with no `-F`, so it is a BASIC REGEX and a
  glob-looking pattern is silently wrong: `learnings/*.yaml` reads as *learnings, zero-or-more slashes,
  any char, yaml* and matches nothing. That is not a soft cap — `executed_fail` OVERRIDES keyword
  coverage and FAILS the PR. Also require the pattern to MISS the merge-base: one matching both head
  and base is downgraded to `executed_stale` (W1-T273) because it discriminates nothing. Run a control
  pattern that must NOT match, because `grep -r` with no file operand searches the cwd instead of stdin
  and will fake a match for every pattern you test. *(#1120 — a `-F`-verified proof failed the review)*
- **A plan-only PR is not automatically CAPPED — prefer certification over the W1-T205 carve-out.**
  `planOnly` (`src/lib/review.ts`) exempts a plan-only diff from the proof-execution FLOOR; it does
  not stop real proofs from executing. `grep: <pattern> in <path>` proofs with an EXPLICIT path do
  execute and can earn a full PASS — #877 posted "PASS — 4 criteria substantiated" on 4/4. A
  path-less `grep:` is refused outright by `parseDialectGrep`. *(#877)*
- **Do NOT rewrite proofs on `verify: human` tasks.** `isDispatchEligible` (`src/lib/drain.ts`)
  returns false at `t.verify !== "auto"` BEFORE the linter is consulted, so their dialect debt can
  never stall the queue. Forcing chaos drills, device recordings and live deploys into `unit test:`
  yields proofs that parse, match zero tests, and cap the review — the exact theatre the dialect
  gate exists to stop. Report them as needing a proof kind the dialect lacks. *(#984)*

## Coverage traps

- **In a NEW `.ts` file, sandwich type-only `interface`/`type` declarations BETWEEN covered
  functions — never at the file's head or tail.** `--experimental-test-coverage` stamps `DA:<line>,0`
  across a new file's leading AND trailing source-line records (a source-map preamble/epilogue
  artifact), and diff-coverage flags an interface's property lines sitting there as uncovered code.
  Middle types, bracketed by executed statements, get no `DA:0`. *(#777 — head and tail both failed)*
- **Put any coverage-load-bearing test in its OWN `test/*.test.ts` file — never append it to
  `test/run-task.test.ts`.** That file intermittently crashes at FILE level under
  `--experimental-test-coverage` (the W1-T240 registry tests), zeroing the coverage record for
  everything in it — so a diff-coverage-critical test can lose its own coverage nondeterministically
  and fail on a rerun unrelated to your change. *(#781)*
- **When every test injects a fake, the seam's DEFAULT implementation and each `catch` arm are
  unreachable — write one test that really shells out, and one per catch arm.** #978 shipped 182
  lines of tests that all supplied their own `PreflightSpawn`, so `defaultPreflightSpawn` never ran
  and 1 of 3 catch arms was exercised (9 uncovered lines). Fix shape: append the injectable
  parameter LAST so no positional caller shifts, cover the wiring with a recorder, and assert the
  real thing (status, stdout, stderr, piped stdin) — a leaf that threw on nonzero exit would turn
  every ordinary check failure into the catch arm's message and lose the tool's own output.
  *(#977, #978)*

## Plan and task hygiene

- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** The dominant merge path here is GATE-SIDE: the PR merges after the run
  already ended `blocked`/`blocked_ci`, so that task never writes a `merged` verdict and a
  ledger-only scan cannot see it. A ledger-built set gave 236 ids and offered long-merged work as
  runnable, naming W1-T227/W1-T192 as the frontier when both had merged weeks earlier (#527, #457).
  Trailers give 301; unioned with the ledger, 311.
  `gh api 'repos/craigoley/remudero/pulls?state=closed&per_page=100&page=N'`, filter
  `merged_at != null`, match `^Remudero-Task: (\S+)$`. *(#984)*
- **Before believing "task X is next", confirm the frontier with the repo's own selector —
  `runnableCandidates(plan, isMerged, n)` — not the task a brief or retro names**, and feed it the
  trailer-built merged set above. W1-T169 was rank 23 behind three unmet deps, not the head. A
  refused task is re-selected and re-refused every tick, silently, so **fix proofs in BULK**: five
  separate PRs rewrote them one at a time. *(#982, #984, #985, #906, #920, #942, #943)*
- **Compute a new task id from the max across BOTH `plan/tasks.yaml` AND every `plan/tasks.d/*.yaml`
  shard.** "Next number after the last one I saw" collides with tasks that landed concurrently or
  live in a shard you didn't read, and `rmd lint-plan` then blocks the push.
  `grep -rhoE '^\s*- id: W1-T[0-9]+' plan/tasks.yaml plan/tasks.d/ | grep -oE 'T[0-9]+'` → max+1.
  *(#770 — renumbered to W1-T257; #775 — to W1-T261; same collision twice in one session)*
- **`lint-plan` runs CHANGED-TASKS-ONLY in CI, so touching a task promotes its OWN pre-existing
  violations to blocking — including ones that are merely `warn` at dispatch.** `proof-resolvability`
  is demoted to `warn` at `preDispatchLint` but blocks in the changed-tasks gate. Once a task is in
  your diff, clear EVERY violation on it, not just the dispatch-blocking ones. *(#984)*

## CI and merging

- **A stale-red `ci-gate` used to need a NEW SHA when a same-sha rerun landed AFTER ci-gate's own
  read — W1-T261 (merged 2026-07-29, #885) fixed exactly this.** ci-gate now RE-READS inside a
  bounded grace window before concluding FAILURE, so a required check that flips FAILURE→SUCCESS on
  the SAME head sha self-clears with no fresh sha and no manual re-run. #873 went red while two
  checks subsequently passed on that very sha; #877 (a byte-identical tree pushed to a fresh sha)
  went fully green — that gap is now closed. A DIFFERENT defect in the same job — the WAIT CAP
  itself sized shorter than this repo's own required-check wall-clock, so ci-gate timed out on
  siblings that were still green-in-progress rather than on any failure — is fixed by W1-T312 in
  the same change that corrects this bullet (see the `WAIT_CAP_SECONDS` comment in
  `.github/workflows/ci-gate.yml`). *(#873/#877, W1-T261/#885, W1-T312)*
- **`gh pr create` is GraphQL and dies with "API rate limit already exceeded" when that budget is
  spent** (frequent on this account while REST/core stays healthy). Open PRs via REST:
  `gh api --method POST repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=main -F body=@<file>`.
  Check with `gh api rate_limit` (`.resources.graphql.remaining` vs `.resources.core.remaining`).
  `rmd review` and `gh pr view --json` are ALSO GraphQL, so a hand-opened PR can't be reviewed until
  GraphQL resets. *(#766)*

## Ledger and evidence discipline

- **The archives are GZIPPED, so `ledger.*.ndjson` matches ZERO files and answers from the live file
  alone — SILENTLY. Use `zgrep` over `ledger.*.ndjson.gz` PLUS the live file, and prove the archives
  were read.** Every rotation is `state/ledger.<ts>.ndjson.gz` (666 of them; `find` returns **zero**
  uncompressed rotations), so the long-standing `grep -h … state/ledger.*.ndjson state/ledger.ndjson`
  idiom is broken in the worst way: under `bash` the non-matching glob passes through literally,
  `grep` fails on it into `2>/dev/null`, and you get a live-file-only number that looks right. Under
  `zsh` it errors outright. Measured the same night, same pattern: `run.start` reads **223 live and
  696 over the union — a 3.1x undercount**; `dispatch.indeterminate` reads **0 live**. THE ONLY
  SANCTIONED FORM, which also streams and never materialises a union to a file:
  `zgrep -h '<pat>' state/ledger.*.ndjson.gz state/ledger.ndjson | sort -u`.
  **Run a POSITIVE CONTROL that proves an ARCHIVE matched, not merely that the count is non-zero** —
  a live-only answer is non-zero too, which is exactly why this went unnoticed.
  **Nothing in `src/` reads or writes `.gz`** (zero matches across `src/` and `scripts/`), and
  `readLedgerLines` (`status.ts`) opens exactly ONE path — no glob, no `readdir` — so no shipped
  code unions anything; the union is always yours to build.
  **And the archives are NOT cumulative snapshots.** `rotateLedger` keeps only
  `MAX_RETAINED_LINES_PER_STEP = 200` newest per step and archives the rest ("Newest-N survive;
  older ones archive"), so **63% of `run.start` history exists ONLY in older archives** — deleting
  any of them destroys unique data, and the newest archive does not subsume the others.
  Claims of the form "N occurrences", and especially "zero in the entire history", are unsupportable
  without the archives. *(recon-AE §0 — 212 live vs 912 union; re-derived 2026-08-05,
  `state/recon-state-retention.md`)*
- **A new ledger step that any DECISION reads must be added to `DECISION_RELEVANT_LEDGER_STEPS`
  (`src/lib/ledger.ts`) in the same PR.** `priorActionsFromLedger` enforces `ABSENT_REPUSH_CAP` by
  COUNTING `sweep.absent_repush` lines, so a rotation archiving them resets the count to zero and
  every rotation re-earns the PR another empty commit — the unbounded loop the cap exists to
  prevent. `test/ledger-rotation.test.ts` re-derives the expected set from every consumer's source;
  a scoped local run cannot catch this. *(#977 — the bound lives in the ledger, so the line IS the bound)*
- **A ledger line must carry the reason from the DECISION THAT PRODUCED ITS OUTCOME.**
  `automerge.armed` once logged `outcome: "ledger-refused"` beside `reason: "verdict is a full PASS"`
  — outcome from the gate that refused, reason from `decideAutoMergeArm` which had APPROVED, with
  the real reason going only to stdout. A self-contradictory line is worse than a terse one: it
  sends every later diagnosis toward a policy question instead of the real defect. *(#981)*
- **Treat a step NAME as a claim, not evidence — check what the function that wrote it can actually
  return.** `armAutoMerge` returns one of seven outcomes and never throws; five arm nothing, yet five
  Architect lanes logged `automerge.armed` unconditionally. Measured over the unioned ledger: 176
  rows, 135 blind, 17 provably false, 119 undecidable — the blind rows recorded no `head_sha`, so
  they can never be adjudicated. Any historical claim resting on that step name is unsound for rows
  written before #981. *(#981)*
- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** A control filtering on the
  absolute path counts the wrapper, returns 1, and reports a false pass, which would make every
  proof verification vacuous. Always run the control
  (`--test-name-pattern "no test title matches this xyzzy"`) and require a post-filter count of 0
  before believing any match count. *(#981 — the control caught the blind discriminator, not the proofs)*

## Investigation discipline

- **Before editing the config file you were TOLD to change, trace from source where the runtime
  value is actually read.** The named declarative source may be inert while a code-level default
  governs live behavior: the `.remudero/mounts.yaml` `architect:` row looked authoritative, but
  spawns resolved from `architectModel(config)`'s `?? "opus"` default, so a row-only edit would have
  shipped green and changed nothing observable. *(#781 — required wiring `architectModel(config, mounts)`)*
- **When a gate reads the ledger for a record the SAME function writes, check the WRITE ORDER before
  believing the gate's stated reason.** `armIfVerdictPermits` once ran before the `log("review.posted")`
  its own gate required, so it fail-closed to `ledger-refused` on every first pass with nothing
  retrying it — while a nearby comment asserted the line had "just" been written. Four consecutive
  PRs rewrote that path in three hours without fixing it; the ledger proved it, every refusal
  preceding its own `review.posted` by 0–1ms. (Now fixed — the call site must stay BELOW that log.)
  *(#968 → #973 → #975 → #981, diagnosed while merging #977/#978)*
- **`rmd drain --dry-run` is neither side-effect-free nor able to see your branch.** `drainCommand`
  resolves the LIVE ledger and appends to it before the dry-run branch is reached, and its W1-T60
  self-sync dispatches from **origin/main's** plan blob, never the working tree. Prove a dispatch
  change in-process with the choke point's own objects — `assertLintClean(task, preDispatchLint)`
  over `git show origin/main:<planfile>` versus yours. Only `proof-dialect` blocks at dispatch;
  `proof-resolvability` is demoted to `warn` there, so the blocking count is smaller than
  `lint-plan`'s. *(#982)*

## Operating this host

- **Never run an installing package manager (`npm ci` / `npm install`) anywhere on this host while
  the daemon is up — every worktree SHARES the canonical `node_modules`.** Worktrees symlink back to
  `~/Remudero/remudero/node_modules`: one mutable tree, no lock, shared by the live daemon and every
  concurrent worker. On 2026-07-29 an install inside a worktree emptied it under the running daemon
  and `bin/rmd` died at `node_modules/.bin/tsx: No such file or directory` on every KeepAlive
  relaunch until a restoring install put 401 packages back. Wire a worktree up with
  `ln -s ~/Remudero/remudero/node_modules <worktree>/node_modules`; note `.gitignore`'s
  `node_modules/` has a trailing slash so it does NOT match that symlink — add a local exclude
  before staging. *(the 2026-07-29 daemon outage)*
- **Never do interactive work inside `<config.root>/worktrees` — the fleet reaps it.**
  `reapStaleWorktrees` scans that directory on a cadence and `rm -rf`s entries it judges terminal,
  without running `git worktree prune`; its signature is every worktree gone while the admin records
  survive as `prunable`. One was destroyed twice in about eleven minutes mid-command. Cut worktrees
  elsewhere (e.g. `~/Remudero/<name>-work`) and commit more often than feels necessary. Recovery:
  the git admin dir and index live in the PARENT clone, so staged blobs survive —
  `GIT_INDEX_FILE=<clone>/.git/worktrees/<name>/index git ls-files -s -- <path>` then
  `git cat-file -p <sha>`. *(the 2026-07-31 impl-BH run — two wipes, full recovery)*
- **Keep the operator checkout (`~/Remudero/remudero`) on `main`; do branch work in a `git worktree`,
  never by checking out a feature branch on it.** The launchd daemon (`com.remudero.daemon`) loads
  its code from that checkout, so a branch checkout risks it serving branch code on restart.
  *(#768/#773)*
- **A deploy is only observable if the daemon records the sha it booted on.** `decideDeployTrigger`
  now deploys when EITHER the install is behind origin/main OR the running daemon is not on the
  install (`runningStale`), so fast-forwarding the checkout no longer consumes the trigger. Before
  that fix, an operator `git pull` left the supervisor reporting "up-to-date" while the daemon ran
  stale code indefinitely. An unrecorded running sha is treated as stale (fail-eager), costing one
  self-correcting restart. To force a deploy by hand: `git pull` then
  `launchctl kickstart -k gui/$UID/com.remudero.daemon`. *(#1054, superseding the #768/#773 rule that
  the supervisor never restarts for you)*

## Code traps

- **`src/lib/serve.ts`'s client JS lives inside a backtick template literal — never put a backtick
  inside a client-code comment** (e.g. `` `lastLiveAt` ``). It terminates the outer template and
  esbuild fails with `Expected ";" but found …`. Sanity-check by rendering the shell and parsing the
  client script (`new Function(<largest <script> block of renderShellHtml()>)`). serve.ts DOM
  behavior is covered by REAL Playwright/Chromium tests (`test/serve.*.test.ts`) — run them for any
  client change. *(#777)*
