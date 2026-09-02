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

**Maintaining this file:** it is injected in full into every session, so it is a context tax paid
per session — keep it compressed. Per MASTER-PLAN §8A, *compression is a deliverable, not just
accretion*: a retro that adds a rule must also fold, sharpen, or delete the ones it supersedes.
Cite **symbol names, not line numbers** — line numbers drift and every one this file used to carry
had gone stale. Each rule cites the PR that earned it; that citation is the pointer to the full
forensic detail, so the narrative does not need to live here.

## Before you push

- **Run the shipped local gate before your FIRST push, not every commit.**
  `rmd preflight --ci-parity` (W1-T294, `src/lib/ci-parity.ts`) shells CI's OWN commands, one
  entry per `.github/workflows/ci.yml` job -- its `ci` entry runs `npm run test:ci`, the SAME
  full-suite command the coverage-ratchet job runs, so a green run is the real signal, not a
  scoped approximation. Run the gate itself, never a proxy for what it does -- the next local
  check this repo adds inherits this rule too. *(W1-T294, W1-T338)*
- **A test run with no `# tests` summary is NOT A RESULT, and a summary over an UNVERIFIED FILE LIST
  is not one either — `node --test` given a ghost path returns a green count, silently. `ls` first.** A killed or timed-out run prints every assertion it reached and no totals, so its
  failure set is a SUBSET BY CONSTRUCTION and reads as "fewer failures on this side". One session
  recorded 3436 assertions with no summary and was about to diff it against a complete 5660-test run,
  which would have manufactured a four-file regression that does not exist. This COMPOUNDS the
  compare-both-sides discipline rather than being covered by it: comparing failure SETS instead of
  counts does not save you when one side is truncated, because the truncated set is a subset either
  way. Require `# tests`/`# pass`/`# fail` on BOTH sides before diffing, and normalise paths first
  when the sides ran in different trees. *(2026-08-09 — truncated by the session's own `pkill -f`,
  the self-match rule now in docs/operator-guide.md)*

## Writing proofs and acceptance criteria

- **THE BLOCK MUST PARSE BEFORE ANY PROOF IN IT CAN RUN — check GITHUB'S STORED BODY with
  `rmd check-acceptance`, never your local file.** `parseAcceptanceBlock` (`src/lib/review.ts`)
  resolves criteria ONLY from BULLETS — `ACCEPTANCE_BULLET_RE` accepts `-`, `*`, `1.`/`1)` — so a
  bare unbulleted `claim:` line matches NOTHING and the review lands *"FAIL — no acceptance criteria
  to judge (fail closed)"* on a PR whose checks are ALL GREEN. #1721 shipped 8 pairs and measured
  `criteria parsed: 0` against 22/22 green checks. Four more ways to reach zero: a header that is not
  a BARE line (`ACCEPTANCE_HEADER_RE` — `## Validation` is not one); PROSE between the heading and
  the first bullet (#1714's first draft); a blank line ANYWHERE after the bullets begin (tolerated
  only BEFORE the first one); and ANY indented line that is not a fresh `proof:`, which is why a
  claim WRAPPED onto a second line silently truncates everything below it.
  **TWO SHAPES PARSE — measured 2026-08-13:** the house form `renderAcceptanceBlock`
  (`src/lib/plan-pr-emitter.ts`) itself emits, `- <claim> | <proof>`; and `- claim: …` with an
  INDENTED `  proof: …` continuation. **ONLY THOSE TWO.** Any other separator — above all an EM
  DASH — reads as part of the CLAIM, so the bullet parses as one claim with NO proof and
  `acceptanceAuthorTimeCheck` (`src/lib/review.ts`) refuses `empty-proofs`, reddening
  `acceptance-author-gate`. IT IS SILENT: the body reads correctly to a human and `check-proof`
  never sees a proof to check; #2534/#2535/#2555 each shipped one. Convert every ` — proof: ` to
  ` | `. *(2026-08-23)*
  **"two-line `claim:`/`proof:` form" READS AS UNBULLETED AND
  THAT IS THE TRAP** — it is two lines, but the first is still a `-` bullet. The DIFFERENT hazard
  that phrase warns of is writing `| proof:`: the pipe already delimits, so the label doubles, the
  proof becomes `proof: grep: …`, and `check-proof` refuses it (`parse: REFUSED`, exit 2) — that
  capped #1598 at 0/3. After a pipe, write the BARE proof.
  **RUN BOTH VERBS — NEITHER CATCHES THE OTHER'S FAILURE:** that doubled-label body passes
  `check-acceptance` `OK`/exit 0; an unbulleted body fails it while every proof inside is valid.
  `gh api repos/<o>/<r>/pulls/<n> --jq .body > /tmp/b.md && RMD_SELF_SYNC_DONE=1 ./bin/rmd check-acceptance /tmp/b.md`
  **GUARD THE FETCH ON STRUCTURE, NEVER ON SIZE**: reject a non-200 or a missing/null `.body` before
  judging — a rate-limit payload reads as `DEFECTIVE: no Acceptance header`. A size floor cannot
  tell a short body from an error payload; the key can. *(2026-08-14)*
  **A BODY REPAIR IS A NEW REVIEW INPUT.** Review retries, refusals, pending posts and outcome
  dedup all key on the versioned digest of the PR head plus exact body. A body edit therefore
  re-earns review on the same commit; comments, labels and title churn do not. Unchanged input
  remains bounded by the configured cap/backoff. *(#1598, #1714, #1721; 2026-09-01 correction)*
- **EVERY proof needs a dialect prefix — `unit test:` or `grep:`. A bare title is PROSE and never
  executes.** `rmd check-proof` refuses it in as many words: *"a proof with no dialect prefix at all
  is prose and never executes."* It does not fail loudly; it silently contributes nothing and the
  verdict lands CAPPED at `proof_exec: 0/N`, which will not arm auto-merge. #1194 posted 0/3 that
  way, and **#1189 MERGED at 2/4** — only its two `grep:` proofs ever ran, and nothing said so.
  Write `unit test: <exact-title substring>`: the prefix is required, and what follows it must be a
  bare title, NOT the `test/foo.test.ts::title` form — that lint-passes but feeds the whole string
  to `--test-name-pattern`. In a **plan shard** use ONLY the pure-path form
  `unit test: test/foo.test.ts`: `judgeCriterion`'s `not_yet_built` carve-out needs `!nameFiltered`
  AND that path in the shard's `files:` (`shardDeclaredFilesInDiff`), so a TITLE silently grades
  `no-match` = TEST THEATRE. A plan-only PR hides it (W1-T205 runs 0 of N): it bites a filing
  declaring a `src/` file. `rmd check-proof '<proof>'` — the second of the two verbs the bullet
  above requires — is the reviewer's own parser AND executor (W1-T387: it judges the run through
  `execWhitelistedProof` itself, not a second hand-rolled exit-code check). Read its `verdict:`
  line, never the raw `exit:` — that same zero-match case exits 0 with `hits: 17` (MEASURED) while
  `verdict:` reads `no-match`; `--help` states the full mapping. *(#766, #773, #777, #1189, #1194)*
- **A `unit test:` title is matched as a LITERAL substring after escaping — the OPPOSITE of a
  `grep:` pattern, which is a BASIC REGEX.** `parseTestTarget` (`src/lib/review.ts`) compiles a
  bare title to `--test-name-pattern escapeRegExp(trimmed)`, so `.` `(` `)` `[` `]` and every other
  regex metacharacter match only THEMSELVES and never act as a wildcard, group, or class. A title
  where `.` stands in for punctuation you didn't want to type verbatim resolves to ZERO real tests
  and reads `not_executable` — silently, with no error, and the criterion quietly falls back to the
  keyword floor (W1-T245/#651: 4 of 5 proofs executed; the 5th used `.` for the parentheses in the
  test's own title and matched nothing). Copy the title's plain prose out verbatim and use no
  metacharacters; this dialect offers no way to opt into pattern semantics. *(W1-T112, W1-T488)*
- **Require a verbatim `grep -rlF -- '<substring>' test/` hit — a passing scoped test run is NOT
  evidence the proof resolves.** `resolveNameFilteredCandidates` greps the SOURCE with a fixed
  string, so a title assembled from `" + "`-joined literals exists verbatim in no file: a proof
  spanning that concatenation seam resolves to ZERO candidates and is judged unexecutable even
  though the test exists and passes. *(impl-AG, caught pre-commit)*
- **Verify a `grep:` proof with the executor's REAL invocation — `grep -arn -- '<pattern>' <path>` —
  never with `grep -F`.** The executor passes the pattern with no `-F`, so it is a BASIC REGEX and a
  glob-looking pattern is silently wrong: `learnings/*.yaml` reads as *learnings, zero-or-more slashes,
  any char, yaml* and matches nothing. That is not a soft cap — `executed_fail` OVERRIDES keyword
  coverage and FAILS the PR. Also require the pattern to MISS the merge-base: one matching both head
  and base is downgraded to `executed_stale` (W1-T273) because it discriminates nothing — **and
  W1-T362 extended `executed_stale` to `unit test:` proofs too, so DISCRIMINATION, not mere
  execution, is the bar for every dialect**: a proof reading 1/1 across head and base substantiates
  nothing. Run a control pattern that must NOT match: `grep -r` with no file operand searches the
  cwd, not stdin, and fakes a match for anything. *(#1120 — a `-F`-verified proof failed the review)*
- **A `grep:` proof must match text on ONE PHYSICAL LINE — a YAML block scalar wraps, and the
  pattern then reads 0 at head with no error.** Distinct from the acceptance-parser wrap hazard
  above: that one truncates a BLOCK, this one silently fails to match at all, so the criterion
  degrades on a body that looks right. Verify every proof at head AND base before pushing; the
  head-side zero is what catches it. *(#2645 — "GRANT A STRIKE BACK WHEN THE SIGNATURE CHANGES" read
  0, repointed to a phrase that did not wrap)*

## Coverage traps

- **In a NEW `.ts` file, sandwich type-only `interface`/`type` declarations BETWEEN covered
  functions — never at the file's head or tail.** `--experimental-test-coverage` stamps `DA:<line>,0`
  across a new file's leading AND trailing source-line records (a source-map preamble/epilogue
  artifact), and diff-coverage flags an interface's property lines sitting there as uncovered code.
  Middle types, bracketed by executed statements, get no `DA:0`. *(#777 — head and tail both failed)*
- **When every test injects a fake, the seam's DEFAULT implementation and each `catch` arm are
  unreachable — write one test that really shells out, and one per catch arm.** #978 shipped 182
  lines of tests that all supplied their own `PreflightSpawn`, so `defaultPreflightSpawn` never ran
  and 1 of 3 catch arms was exercised (9 uncovered lines). Fix shape: append the injectable
  parameter LAST so no positional caller shifts, cover the wiring with a recorder, and assert the
  real thing (status, stdout, stderr, piped stdin) — a leaf that threw on nonzero exit would turn
  every ordinary check failure into the catch arm's message and lose the tool's own output.
  *(#977, #978)*
- **Before trusting `diff-coverage: OK`, prove the lcov INSTRUMENTS the changed files —
  `grep -c '^SF:<path>$' <lcov>` must be non-zero for every source file in the diff.** A scoped run
  whose suites never import a changed file emits no records for it, so "every added source line lcov
  instruments is covered" is trivially true over an EMPTY SET. This is the vacuous-pass family, not
  a coverage result. *(#1399 — an `OK` with zero `SF:` records for either changed file while CI's
  coverage-ratchet failed on 10 uncovered lines)*
- **Build the lcov and the diff from the SAME tree — commit before measuring — AND NAME THE SHA in
  what you report.** An lcov from a dirty working tree measured against `git diff origin/main...HEAD`
  (which excludes uncommitted work) misaligns line numbers and reports untouched pre-existing code
  as newly uncovered. The quieter variant: reusable artefact paths (`/tmp/x.lcov`) survive while
  `origin/main` MOVES under you mid-session, so a re-run silently compares a stale lcov against a
  fresh diff — stamp the sha into the filename or the report line, and re-derive both sides after
  any pull. *(#1399 — two phantom "uncovered" lines that were the pre-existing `floorDegraded`
  branch; filename-reuse variant 2026-08-14)*
- **`diff-coverage` flags ADDED lines, so restructuring an untested region inherits its debt at the
  gate — measure MAIN's coverage of that region before assuming the PR caused it.** Rewriting a
  block converts a silent pre-existing gap into a blocking failure. *(#1399 — every line of the
  comment-assembly block scored 0 hits on origin/main; the PR only moved it)*
- **A deps object supplying SOME fakes leaves every other seam on its REAL default — so relaxing a
  guard can make a previously-dead default FIRE, in a file the diff never touched.** The MIRROR of
  the all-fakes bullet above. A test stubbing only `log` let the real `defaultReexec` fire, which
  replays `process.argv.slice(1)` — under `node --test` that IS the runner — killing six runners at
  `exit 143` with no failed step and no summary, which reads as preemption. Run every CALLER of a
  changed symbol (`git grep -l`), never the files the task declares; the scoped run was green.
  *(#2237, #2248)*
- **Verify a new falsifier by DELETING the fix and re-running — `# fail N` removed vs `# fail 0`
  restored is the evidence it is load-bearing.** A guard seeded with rows already carrying the field
  under test passed either way. *(#2250)*
- **ZERO A `DA:` VALUE INSIDE THE TARGET's OWN `SF:` BLOCK — a whole-file replace hits another
  file's identical line number and returns a FALSE `OK`.** Every brief here demands this falsifier;
  done naively it proves nothing while looking like it passed. lcov holds one `DA:<line>` PER FILE,
  so replacing `DA:5042,6` across the artefact edited a different record and `diff-coverage` still
  read `OK`. Slice `SF:<path>`→`end_of_record`, assert exactly ONE match in that slice, and require
  the `SF:` count and byte size unchanged. *(#3227)*

## Plan and task hygiene

- **Derive "which tasks are merged" from the `Remudero-Task:` trailer on merged PRs — never from
  ledger verdict lines.** The dominant merge path here is GATE-SIDE: the PR merges after the run
  already ended `blocked`/`blocked_ci`, so that task never writes a `merged` verdict and a
  ledger-only scan cannot see it. A ledger-built set gave 236 ids and offered long-merged work as
  runnable, naming W1-T227/W1-T192 as the frontier when both had merged weeks earlier (#527, #457).
  Trailers give 301; unioned with the ledger, 311.
- **AND A TRAILER-ONLY SET UNDER-CREDITS, because the BRANCH NAME is a second, independent credit
  path.** `findMergedByHeadBranch` (`status.ts`) matches `run-<taskId>-<digits>` on the STRUCTURED
  head ref and credits a merge with no trailer at all. MEASURED: **#1657 carries ZERO
  `Remudero-Task:` lines** (`grep -acE '^Remudero-Task:'` on its body = 0) and W1-T444 is credited
  anyway, purely by its `run-W1-T444-1786560477` head. So union the two, or you will re-dispatch a
  task that shipped.
- **THE TWO SCOPE-TIME CHECKS, AS COMMANDS — RUN BOTH BEFORE BUILDING A FILED TASK.** They answer
  DIFFERENT questions and neither substitutes for the other:
  `git ls-remote --heads origin 'run-<id>-*'`   # is someone working on it RIGHT NOW
  `gh api "repos/<owner>/<repo>/pulls?state=closed&per_page=100" --jq '[.[]|select(.merged_at!=null)|select(.body//""|test("(?m)^Remudero-Task:[ \t]*<id>[ \t]*$"))|.number]'`   # has it ALREADY SHIPPED
  Anchor the trailer test exactly (`^Remudero-Task:\s*<id>\s*$`, multiline) — GitHub's search is NOT
  exact-phrase, and unioning COMMIT SUBJECTS over-credits: `chore(plan): file W1-T411` names a
  task the filing never implemented. Add the head-ref query when the trailer scan reads zero.
- **Sweep the SUBJECT over open PR heads, not only `origin/main` — the id half already does.** A
  main-only subject scan cannot see an in-flight sibling shard, the one case it exists to catch:
  `git ls-remote --heads origin`, then read each head's tree — real files, no REST call. COUNT per
  head against main's own count; presence hits EVERY head, all carrying main's shards. **One
  prompt, one lane**, too: NO SWEEP SEES UNPUSHED WORK, so that half is the operator's discipline,
  never a check. *(2026-08-22: a re-sweep at 11:22:23Z missed a PR opened 11:14:46Z — two shards on
  one subject, #2471 duplicated; #2408/#2411 on 08-21.)*
- **NAME A SESSION BRANCH `run-<taskId>-<epochMs>` WHEN BUILDING A FILED TASK.** It is the only thing
  that makes session work visible to the fleet: `isDispatchEligible` (`drain.ts`) consults
  `opts.isOpenPr`, and `projectPlan` attributes an OPEN PR by `/^run-(.+)-\d+$/` against
  `headRefName` — NOT by the trailer — so a PR on `fix/…`, `docs/…`, `chore/…` or `claude/…` is
  invisible to dispatch however it is trailered. MEASURED 2026-08-12: 70 merges, 29 `run-*` heads and
  41 session-shaped — a MAJORITY invisible. The convention costs one branch name and does double duty:
  visible to dispatch while open, credited on merge even when the body forgets the trailer (#1657). *(#984; the branch-name credit path and both commands added 2026-08-12)*
- **Before believing "task X is next", confirm the frontier with the repo's own selector —
  `runnableCandidates(plan, isMerged, n)` — not the task a brief or retro names**, and feed it the
  trailer-built merged set above. W1-T169 was rank 23 behind three unmet deps, not the head. A
  refused task is re-selected and re-refused every tick, silently, so **fix proofs in BULK**: five
  separate PRs rewrote them one at a time. **NAME THE QUERY, NEVER ITS ANSWER — no count of this
  queue survives the hour it was taken in.** Confirming once and then quoting the number satisfies
  the sentence above and still ships a false claim: three briefs in one week carried a figure that
  had already moved, and one PR merged DURING the report that measured it. The selector costs a
  second; a number carried forward is a claim about the past. **And `lint-plan`'s `(N with a merged
  implementation, M with none)` is NOT a supply figure** — `classifyFailingMergeEvidence` splits the
  tasks that FAIL THE LINTER, and the comment above it in `run-task.ts` says the bare count is a
  technically-true aggregate that misleads. Read as supply it reported one task remaining while the
  selector offered 25. *(#982, #984, #985, #906, #920, #942, #943; the misreading and the staleness,
  2026-08-07)*
- **A contested reservation is never deleted and an unfiled one is never free — the
  LOSER of a race renumbers.** A reserved id with no shard anywhere is HELD, not abandoned; deleting
  the ref re-opens the race it settled, and reclaiming one is an operator decision. *(2026-08-18: two hosts
  minted `refs/rmd-id/W1-T967` 5.76s apart; the first read back its own nonce, then after the PR
  opened re-read the other's commit — it carried `+`. Only the message's pid+host+time named the
  winner; the ref has no identity field.)*
- **A `verify: auto` task can NEVER declare its own plan record in `files:`, so a ratified scope
  widening is recorded in the source comment and PR body, not the shard** — `rule15-filing` refuses
  it, and the reviewer's `scope_violation` is ADVISORY, naming "review-ratified widenings"
  legitimate. *(#2255)*
- **A shard's `status:` field is not a completion signal — it stays `queued` on tasks that
  shipped.** THREE THIS SESSION: W1-T1127 read `queued` on main while its build had merged as
  #2476 (both credit paths — trailer AND a `run-W1-T1127-<digits>` head); W1-T1065's
  admission-time re-check is in `daemon.ts` under its own name; W1-T1059's caller is wired in
  `run-task.ts`. Read alone it cost a full rebuild that was discarded. The credit projection above
  is the ONLY completion signal; `status:` is what the FILING wrote and nothing updates it on
  merge. Pair it with the `ls-remote` hazard already under "Investigation discipline": a deleted
  head and a stale `status:` agree on "not done" and are both wrong. *(#2476 — a whole build
  discarded on two signals that agreed)*
- **Decoding rule citations — where each family canonically lives.** "Rule N" / "Standing rule N"
  = MASTER-PLAN **§12** (1–25, plus 3B/8B); the linter enforces several by name — 15:
  `criterionFieldTampered` + `rule15FilingViolation`, 17: `provenanceViolation`, 18:
  `headlessFitnessViolations`, 19: `sizingViolation`, 21: `postMergeAmendmentViolations`, 25:
  `detectInstrumentEntanglement`/`INSTRUMENT_SURFACE` (`src/lib/review.ts` — and §12.25 says the
  code wins where they disagree). `rule15-*` tokens are artifacts NAMED AFTER §12 rule 15 (test
  files, recon slugs), not rules. "G-N" = operator directives indexed in MASTER-PLAN §14's "Grill
  RESOLVED" paragraph (G-17 = `enforceTierInvariant`, `src/lib/mounts.ts`). "P48" = retro
  proposals in MASTER-PLAN's retro ledger (also `P29a`, `P40(i)`, per retro.ts's own parser);
  retired ones are tombstones whose full text is git-archaeology only. "DR-N" = design rules
  (retro ledger); hyphen avoids the §12 clash.
  *(mapped 2026-08-14 — the numbers were tribal knowledge until this row)*

## CI and merging

- **Do NOT push a fresh sha to clear a stale-red `ci-gate` — it self-clears.** ci-gate RE-READS
  inside a bounded grace window before concluding FAILURE, so a required check flipping
  FAILURE→SUCCESS on the SAME head sha needs no new commit and no manual re-run (W1-T261); its wait
  cap is sized against this repo's real required-check wall-clock, so a green-in-progress sibling is
  waited out rather than timed out (W1-T312, `WAIT_CAP_SECONDS` in `.github/workflows/ci-gate.yml`).
  Both are FIXED; the citations are the detail. *(#873/#877, W1-T261/#885, W1-T312)*
- **NEVER BACKGROUND A POLLER OR ARM A CHECK-IN — do not loop on `gh pr view`, `gh run view` or any
  API call waiting for a state change. Report what you know and STOP.** A lane polled 80 times at a
  45-second cadence against an 8-13 minute CI cycle, exhausted the shared budget and locked the
  operator out of his own repo for ~90 minutes, while single calls 403'd and `/rate_limit` still read
  204 of 5000 used — the ceiling hit was the SECONDARY limit, which counts CADENCE, NOT VOLUME.
  A wait is the operator's to schedule, never yours. *(2026-08-20 — the ninety-minute lockout)*
- **`gh pr create` is GraphQL and dies with "API rate limit already exceeded" when that budget is
  spent** (frequent on this account while REST/core stays healthy). Open PRs via REST:
  `gh api --method POST repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=main -F body=@<file>`.
  Never read that budget from `gh api rate_limit` **on this host** — three calls in one second read
  10383, 0, 10383 (2026-08-26). Use `gh api user -i`; match login AND reset at both ends.
  `rmd review` and `gh pr view --json` are ALSO GraphQL, so a hand-opened PR can't be reviewed until
  GraphQL resets. *(#766)*
- **A CONFLICTING PR registers ZERO check runs. `total: 0` reads as "still queued" but means
  `mergeable_state: dirty` — check mergeability before waiting on CI.** *(#1399 — a full CI cycle
  spent waiting on checks that were never going to start)*
- **When two PRs append tests to the same file's TAIL, the conflict region can cut just before a
  SHARED closing `});`** — keeping both sides then leaves one block unclosed, and esbuild reports
  `Unexpected end of file` rather than naming the merge. Close the ours-side block explicitly.
  *(#1399 vs #1404 — resolved by emitting `});` where the `=======` marker was)*
- **A corrected PR title is observed by a RE-RUN, not only by a new sha — but `edited` still fires
  nothing.** `ci.yml`'s commitlint job reads the title LIVE (`gh pr view --json title --jq .title`),
  so re-running it picks up a title fixed after the fact. `on: pull_request` carries no `types:`, so
  the defaults `[opened, synchronize, reopened]` exclude `edited` and a retitle alone triggers no run.
  Cheapest path is retitle THEN push; backwards, re-run the job. Close/reopen fires `reopened` without
  touching another lane's branch. *(W1-T351; re-derived 2026-08-06)*
- **A merge to a BAKED path ships nothing until an operator triggers an image rebuild — know which
  half of your diff you are in before you call a merge "shipped."** On a container host the daemon
  runs from a **bind-mounted checkout** (`<state-root> -> .../Remudero`, the entrypoint `cd`s into
  it), while its own **entrypoint script and every apt-level binary come from the image**. A path
  read from the mount ships the instant it merges; a path baked into the image sits inert in a
  MERGED, GREEN-EVERYWHERE commit until `.github/workflows/acr-build.yml` (`workflow_dispatch`
  only, run by the operator from the Actions tab) is triggered and the new image is
  deployed. The failure mode is
  not a red check: docker still restarts the container, the daemon still logs `exited N`, and every
  diagnostic that reads the MOUNT still says the code is current — because it is; only the image is
  not. MEASURED 2026-08-14: the running image was 124 commits behind `origin/main`, including a
  Dockerfile fix and an entrypoint fix, neither showing as a failure off-host.

  | ships on merge (the mount) | needs an image rebuild (the image) |
  |---|---|
  | `src/`, `test/`, `plan/`, `scripts/`, `bin/` | `deploy/entrypoint.sh` — the EXECUTED entrypoint (`COPY … /usr/local/bin/rmd-entrypoint`) |
  | `deploy/*.sh` run BY THE OPERATOR from the checkout (`host-update.sh`, `verify-image.sh`) | `deploy/Dockerfile` itself — every apt binary (`jq`, `tini`, `bubblewrap`, `socat`), the node version, the `/app` snapshot |
  | `package.json` / the lockfile — via the mount and `ensureInstallFresh`, no rebuild needed | — |

  **`node_modules` resolves to the MOUNT, not the image** — `/app` carries its own that the
  entrypoint never falls back to, and the one the daemon loads is the same inode as the checkout's,
  so a dependency bump is a mount-side change. `scripts/fleet-heartbeat.sh` publishes
  `image_build_sha` (from `/etc/rmd-build-sha`) alongside the two checkout shas it already carried (`daemon_boot_head_sha`, `install_head_sha`) so this
  boundary is checkable from the beat without shelling into the host. *(W1-T496, 2026-08-14)*

## Ledger and evidence discipline

- **The rotations come in TWO FORMS and every glob that names only one answers SILENTLY WRONG. The
  union is three patterns, never two:**
  `zgrep -h '<pat>' state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson | sort -u`.
  `zgrep` reads plain input transparently (MEASURED: 223 hits on an uncompressed rotation), so the
  fix is always THE GLOB, never the tool. Never assume either half is empty.
- **THE CONTROL MUST PROVE EACH FORM WAS READ, and a raw cross-archive count CANNOT** — rotations
  duplicate heavily, so `run.start` reads **257,438 raw lines across the `.gz` alone but only 779
  distinct over the full union**: a control like that stays six figures while a whole form is
  missed, which is exactly how this survived. Control by FILE COUNT PER FORM (`ls` each pattern,
  require every non-empty form to be non-zero), or by a per-form match count.
- **And the archives are NOT cumulative snapshots.** `rotateLedger` keeps only
  `MAX_RETAINED_LINES_PER_STEP = 200` newest per step and archives the rest, so most history exists
  ONLY in older archives — deleting any destroys unique data and the newest subsumes nothing.
  Claims of the form "N occurrences", and especially "zero in the entire history", are unsupportable
  without every form. *(recon-AE §0 — the `.gz`-only idiom returned a silent **0** for a pattern with 3
  real hits, its control passing at 257k throughout)*
- **A ledger line must carry the reason from the DECISION THAT PRODUCED ITS OUTCOME.**
  `automerge.armed` once logged `outcome: "ledger-refused"` beside `reason: "verdict is a full PASS"`
  — outcome from the gate that refused, reason from `decideAutoMergeArm` which had APPROVED, with
  the real reason going only to stdout. A self-contradictory line is worse than a terse one: it
  sends every later diagnosis toward a policy question instead of the real defect. *(#981)*
- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** A control filtering on the
  absolute path counts the wrapper, returns 1, and reports a false pass, which would make every
  proof verification vacuous. Always run the control
  (`--test-name-pattern "no test title matches this xyzzy"`) and require a post-filter count of 0
  before believing any match count. *(#981 — the control caught the blind discriminator, not the proofs)*
- **A fixture shelling git PLUMBING fails on every CI runner and passes on every dev machine, so it
  reads as flaky when it is deterministic.** `commit-tree` refuses `Author identity unknown` unless
  an identity is set, and `actions/checkout` sets NEITHER repo nor global: the fault is ambient
  config the fixture inherited locally. Reproduce before believing "flaky" —
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` plus unsetting the repo's
  `user.email`/`user.name` reproduces CI exactly. Fix the FIXTURE (pass the identity env vars git
  honours), never the workflow, never a skip. *(#1971, after #1964's retry failed the same way)*

## Investigation discipline

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
- **A bound that fires on a HEALTHY condition is this repo's recurring defect — before tuning the
  number, check the population it is meant to separate has ever been observed.** Three instances:
  ci-gate's wait cap sized under the real check wall-clock, a deploy ceiling consumed by a dry-run
  that delivered nothing, and a check-wait bound where 21 of 21 booked PRs later merged.
  *(W1-T312, W1-T380/#1392, W1-T382/#1401)*
- **A ZERO IS NOT A MEASUREMENT UNTIL A POSITIVE CONTROL PROVES THE QUERY COULD SEE ITS CORPUS.
  RUN ONE ON EVERY SWEEP WHOSE ANSWER YOU INTEND TO ACT ON.**
  FOUR distinct instruments here answer WRONG rather than erroring; expect more — three were found by
  ACCIDENT in one week, by a falsifier that reddened nothing or a target visible in the file, never
  by reading the query. Enumerating hazards has lost that race twice; the control generalises — it
  tests the QUERY, not your memory of which tool is broken. A control costs one command: match something
  you can SEE, in the same corpus, with the same tool and flags. AND QUALIFY IT FOR THE SURFACE:
  an open PR's id reads zero on main, a merged id's deleted branch reads zero on heads, an unwritten
  id reads zero on `git log --grep`.
  **Two directions a control can be too weak: (c) — A CONTROL THAT PROVES THE CORPUS IS READABLE
  DOES NOT PROVE THE QUERY COVERS IT — and (a), where the control passes because you unwittingly ran
  a DIFFERENT engine than the sweep did.**
- **(a) A POSIX REGEX ENGINE HERE SILENTLY DROPS `\s`/`\b` INSTEAD OF ERRORING, AND TWO DIFFERENT
  TOOLS DO IT.** Both are GNU extensions; a POSIX engine matches something else and reports a clean
  zero. `awk` is mawk: over a file containing `  let b = 2;`, `/^[[:space:]]+(let|const)/` matches 1
  and `/^\s+(let|const)/` matches 0 — one session's declaration scan used the `\s` form, reported an
  EMPTY declaration list and a row of zeros, and called a refactor scope-safe on no evidence
  *(2026-08-09, twice)*. **`\b` IS A SEPARATE TRAP AND IT IS NOT AN ENGINE DIFFERENCE — `git grep -E`
  DOES honour it.** MEASURED at 6e7d131: `git grep -lE '\bdate' -- src/` returns **21** and
  `git grep -lE '\busr\b' -- src/` returns **4**, so a `\b` sweep that reads zero has NOT hit a
  broken engine. What actually fails is `\b` ADJACENT TO A NON-WORD CHARACTER, which asserts a
  boundary that is usually absent: `git grep -lE '/usr/bin/(date|security)' -- src/` returns **3**
  while `\b/usr/bin/(date|security)\b` returns **0**, because the leading `\b` sits before `/` and
  needs a word character to its left where the text has a space. **GNU `grep -E` SCORES THE IDENTICAL
  PAIR 1 AND 0**, so this is portable regex semantics, not a harness quirk. Anchor on the non-word
  character itself (`[[:space:]]/usr/bin/`), use `-w`, or
  drop the `\b`. Never `\s` under `awk`. *(2026-08-12)*
- **(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` (ignore-binary) INJECTED, so a file
  holding ONE NUL byte is skipped entirely — no output, exit 1, indistinguishable from real
  absence.** **The tool is still blind**, so any UNTRACKED file reads as absent, and **BARE `rg` IS BLIND TOO**
  (`rg -l` empty, `rg -la` fine) — "use grep -a or rg" is NOT the rule. `/usr/bin/grep` is
  unaffected, which is why it hid for months. Use `grep -ar`, `rg -la` or `git grep` for ANY sweep
  deciding a `files:` list, a violation count or a scope audit. Never carry a count; run
  `git ls-files -z | xargs -0 perl -0777 -ne 'print "$ARGV\n" if /\0/'`. `git grep --cached -I -l ''`
  is NOT a substitute — git sniffs only the first 8000 bytes. *(2026-08-11; folded 2026-08-16)*
- **(c) A GLOB THAT NAMES ONE FILE FORM ANSWERS FROM THE OTHER WITHOUT SAYING SO.** Under `bash` a
  non-matching glob passes through literally and `grep` fails it into `2>/dev/null`; under `zsh` it
  errors. THE GENERAL FORM: control on COVERAGE (did every form get opened?), not on READABILITY (did
  something match?). *(2026-08-12)*
- **(d) A QUERY CAN ANSWER THE WRONG QUESTION WITH A PERFECTLY GOOD ZERO, AND NO POSITIVE CONTROL
  SAVES YOU.** `git ls-remote --heads origin 'run-<id>-*'` reports live worker branches. GitHub
  DELETES the head on merge, so it returns 0 for every COMPLETED task — MEASURED:
  `run-W1-T444-1786560477` existed 19:01:20Z–19:25:15Z and the query reads 0 today, identical to a
  task nobody ever started. A session read that zero as "not done", rebuilt W1-T444, and discarded a
  full build when it found the work already merged as #1657. THIS IS THE CLAUSE THAT BREAKS THE
  PATTERN: (a) is the wrong engine and (c) is incomplete coverage, both of which a control catches —
  here the tool works, the corpus is right, and a control PASSES (an in-flight task really does
  return 1). The defect is that "is anyone working on this" was read as "has this been done". When a
  zero decides something, name the question the query actually answers, and find the OTHER query for
  the other question — both are under "Plan and task hygiene" above. *(2026-08-12)*
- **(e) A CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS IS THE RIGHT ONE
  — AND RE-RUNNING THE SAME WAY IS NOT A SECOND OPINION.** (a)-(d) are all ZEROS; THIS ONE IS A
  CONFIDENT NON-ZERO, which is why the section's own framing does not catch it. MEASURED 2026-08-13:
  `tsc` reported four `api-client` errors in a container; re-running on a CLEAN TREE got the IDENTICAL
  FOUR, read as pre-existing. **THAT CONTROLLED FOR THE TREE AND NOT FOR THE ENVIRONMENT** — a RELATIVE
  `node_modules` symlink resolved outside that container's mount set, and CI was green throughout.
  AN ENVIRONMENTAL DEFECT REPRODUCES EXACTLY, so agreement between two readings
  taken the same way is one measurement performed twice, and the confidence it buys is counterfeit.
  THE CHECK: when a result surprises you, RE-RUN IT SOMEWHERE ELSE before believing it — a second
  host, CI's own logs, or a differently-provisioned container. Vary the ENVIRONMENT, not just the
  input. CHEAPEST INSTANCE: `readlink -f <workspace-symlink>` prints EMPTY when the target sits
  outside the mount set, which would have settled it in seconds. *(2026-08-13)*
- **(f) THE TWO SIDES OF A COMPARISON MUST COUNT THE SAME UNITS — `ls` COUNTS A DIRECTORY AS ONE
  ENTRY.** A naive `git ls-tree` vs `ls` tally read 114 vs 111 on an equal tree, because the tree
  side listed files recursively while `ls` collapsed each directory to one row. And ls-tree
  pathspecs do not glob like the shell: `git ls-tree HEAD -- '*.md'` returns ZERO at a root that
  holds ten `.md` files — a query-shape zero the mismatch then "confirms". The check: filter BOTH
  sides to the same unit first — `diff <(git ls-tree --name-only HEAD | grep '\.md$' | sort)
  <(ls -1 *.md | sort)` — and demand a positive control on whichever side reads zero.
  AND WHEN TWO NUMBERS DISAGREE, SUSPECT THE CAPTURE BEFORE THE TOOL. A `lint-plan` violation count
  that disagreed with its own summary traced to workstream subtotals summing correctly (the control)
  and a retry reading 0 traced to `cmd 2>&1 > f`, which sends stderr to the TERMINAL while this verb
  puts violations on stderr and the summary on stdout. Use `> out 2> err`.
  *(2026-08-14, both directions; the capture half 2026-08-15)*
- **(g) A CHANGE THAT REMOVES AN ACCESS PATH MUST PROVE THE REPLACEMENT FIRST, FROM A NEW SESSION
  — AN EXISTING CONNECTION IS NOT EVIDENCE.** `PasswordAuthentication no` went live against a
  0-byte `authorized_keys`; two pre-change sessions survived only because sshd never
  re-authenticates an established connection, and no third could have opened by any method. Prove
  the replacement under `BatchMode=yes` (which fails rather than prompting) and keep the old path
  until it does. The recurring shape is CREDENTIAL AND ACCESS ROTATION, not ssh. *(2026-08-16)*
- **(h) A GATE RUN FROM A CHECKOUT that is BEHIND answers about a file and a threshold that both
  moved — run it against `origin/main`'s blobs and report the behind-count.** MEASURED: the
  operator checkout sat 465 commits behind, and `node scripts/claude-md-budget-ratchet.mjs` there
  printed `60965 bytes (cap 61046) OK` while `git show origin/main:CLAUDE.md` is 63798 against a
  cap of 65536 raised 2026-08-22 — BOTH operands stale, exit 0, no warning. The failure is
  invisible because the gate is honest about what it read and silent about which tree that was.
  `git rev-list --count HEAD..origin/main` costs nothing; print it beside any gate verdict taken
  outside a fresh worktree. *(2026-08-23, this retro's own first measurement)*
- **(i) A POSITIVE CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS COVERS THE
  WINDOW.** The (a)-(f) family above all catch a query that cannot read. This one reads perfectly and
  still answers about the wrong period: `"step":"risk_judge.decision"` read 87 rows across the union
  (gz 64 / plain 23 / live 0) — control fires — while `rate_limited_rest_merge` read 0 because the
  corpus's newest row is 2026-08-12 and the feature merged 2026-08-23. Before acting on a ledger
  zero, print the corpus's NEWEST ts beside the event's own date; a control says nothing about that
  gap. *(W1-T1280/#2651)*
- **(j) A CENSUS TEST NAMES NONE OF YOUR SYMBOLS, SO THE CALLER SWEEP ABOVE CANNOT FIND IT** — `git grep
  -l <symbol>` is blind to a suite that WALKS a population (`src/**`) and asserts its size. #2639
  added one seamed policy read and reddened `test/config-reader-seams.test.ts`, a file outside its
  `files:` that references nothing it touched. Also run any suite that enumerates a population your
  file joins, found by what it walks rather than by name. *(#2639, #2605)*
- **(k) A RULE 21 protocol run passing `{ baseTask }` ALONE reports THREE VACUOUS ZEROS — including the
  one you would report as real.** `postMergeAmendmentViolations` (`src/lib/review.ts`) returns `[]`
  on its first two lines at `!ctx.statusResolvable` and `!ctx.merged`, so the real row, the vacuity
  row and the trap row all read 0 FOR THE SAME REASON and the table looks correct. Pass
  `statusResolvable: true`, `merged: true` and `baseAcceptance`. THE BLOCKING CONTROL — a row you
  have deliberately made violate — IS THE ONLY THING SEPARATING A REAL ZERO FROM A DEAD CALL, and
  it must run in the SAME call shape as the rows you report. *(#3211 — three zeros reported, then
  withdrawn when the blocking control read 0 too)*

## Code traps

- **Read re-entrancy from `process.env`, not an injected `env` argument — a spawn writes a child's
  environment and cannot reach a parameter.** A caller passing `{}` saw no loop guard; `isCiEnv({})`
  is false for the same reason. *(#2248)*
- **A fixed date constant compared against rows stamped at REAL time is a time bomb; the signature
  is a red beginning at a clock boundary with no diff involved.** Compare the last green run's
  timestamp against the first red one before blaming a change. Stamp through the injected clock at
  the write seam; moving the constant only re-arms it. *(#2250)*
