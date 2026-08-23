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
- **Verify every PR-body claim about your own diff against `git diff --numstat`, and RE-VERIFY after
  each follow-up commit.** `bodyContradictsDiff` (`src/lib/review.ts`, W1-T274) OPENS THE DIFF and
  FAILS the PR — MEASURED 2026-08-12: #1685 refused with *"body contradicts its own diff: claimed
  'exactly one file'"*, over the same three files #974 carried. #974 merged (PRE-W1-T274) claiming
  *"exactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md"* while carrying `MASTER-PLAN.md` + `docs/ORIENTATION.md` + `plan/plan-index.json`
  — and what was load-bearing is that THE BODY NAMED THE VERY FILE THE DIFF TOUCHED. The detector's own
  doc says it in terms: *"NOT because of plan scope"* — **#974 KEPT its `planOnly` carve-out.**
  **NEVER ASSERT SCOPE MEMBERSHIP FROM MEMORY; RUN THE PREDICATE** —
  `isInPlanScope("docs/ORIENTATION.md")` returns **TRUE** (run, not read), and any claim about it goes
  stale the moment `plan-architect.ts` moves. This bullet asserted the opposite until 2026-08-12, and a
  session repairing a false body claim FOLLOWED IT AND WROTE A FRESH ONE — the same defect the bullet
  exists to prevent, caused by the bullet. **The detector also has a SHORTHAND arm**: scope-shorthand
  phrases (the plan-only/data-only family) fire when ANCHORED — as a label with a colon, a copular
  claim ("this PR is …-only"), or attributive before a changeset noun — while bare mentions, quoted
  regions and file paths stay silent (`shorthandIsAboutChangeset`, W1-T413). If the diff carries any
  file outside the claimed scope, the anchored phrase fails the PR — so do not write the shorthand
  in a body unless the predicate agrees, and do not fear it in quotes. *(#974, #984, #1685)*
- **A test run with no `# tests` summary line is NOT A RESULT — check for the summary, never the
  failure count.** A killed or timed-out run prints every assertion it reached and no totals, so its
  failure set is a SUBSET BY CONSTRUCTION and reads as "fewer failures on this side". One session
  recorded 3436 assertions with no summary and was about to diff it against a complete 5660-test run,
  which would have manufactured a four-file regression that does not exist. This COMPOUNDS the
  compare-both-sides discipline rather than being covered by it: comparing failure SETS instead of
  counts does not save you when one side is truncated, because the truncated set is a subset either
  way. Require `# tests`/`# pass`/`# fail` on BOTH sides before diffing, and normalise paths first
  when the sides ran in different trees. *(2026-08-09 — truncated by the session's own `pkill -f`,
  the self-match rule under "Operating this host")*

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
  INDENTED `  proof: …` continuation. **"two-line `claim:`/`proof:` form" READS AS UNBULLETED AND
  THAT IS THE TRAP** — it is two lines, but the first is still a `-` bullet. The DIFFERENT hazard
  that phrase warns of is writing `| proof:`: the pipe already delimits, so the label doubles, the
  proof becomes `proof: grep: …`, and `check-proof` refuses it (`parse: REFUSED`, exit 2) — that
  capped #1598 at 0/3. After a pipe, write the BARE proof.
  **RUN BOTH VERBS — NEITHER CATCHES THE OTHER'S FAILURE:** that doubled-label body passes
  `check-acceptance` `OK`/exit 0; an unbulleted body fails it while every proof inside is valid.
  `gh api repos/<o>/<r>/pulls/<n> --jq .body > /tmp/b.md && RMD_SELF_SYNC_DONE=1 ./bin/rmd check-acceptance /tmp/b.md`
  **GUARD THE FETCH ON STRUCTURE, NEVER ON SIZE**: reject on a non-200 HTTP code or a missing/null
  `.body` key before judging the file — a 537-byte rate-limit payload landed in `/tmp/b.md` and
  read as `DEFECTIVE: no Acceptance header`, failing a body that was fine. A size floor cannot tell
  a short body from an error payload; the key can. *(2026-08-14)*
  **AND REPAIRING THE BODY CLEARS NOTHING ON ITS OWN.** The sweep's post-review row fires only at
  `pr.checksState === "green" && pr.reviewState === "none"` (`src/lib/sweep.ts`), so once a verdict
  is posted that sha is never re-reviewed — the designed path for a stale verdict is A NEW HEAD. A
  session that fixes the block and pushes nothing has fixed nothing. *(#1598, #1714, #1721)*
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
  and base is downgraded to `executed_stale` (W1-T273) because it discriminates nothing — **and
  W1-T362 extended `executed_stale` to `unit test:` proofs too, so DISCRIMINATION, not mere
  execution, is the bar for every dialect**: a proof reading 1/1 across head and base substantiates
  nothing. Run a control pattern that must NOT match: `grep -r` with no file operand searches the
  cwd, not stdin, and fakes a match for anything. *(#1120 — a `-F`-verified proof failed the review)*
- **A plan-only PR is not automatically CAPPED — prefer certification over the W1-T205 carve-out.**
  `planOnly` (`src/lib/review.ts`) exempts a plan-only diff from the proof-execution FLOOR; it does
  not stop real proofs from executing. `grep: <pattern> in <path>` proofs with an EXPLICIT path do
  execute and can earn a full PASS — #877 posted "PASS — 4 criteria substantiated" on 4/4. A
  path-less `grep:` is refused outright by `parseDialectGrep`. *(#877)*
- **Do NOT rewrite proofs on `verify: human` tasks.** `isDispatchEligible` (`src/lib/drain.ts`)
  returns false at `t.verify !== "auto"` BEFORE the linter is consulted, so their dialect debt can
  never stall the queue. Forcing chaos drills, device recordings and live deploys into `unit test:`
  yields proofs that parse, match zero tests, and cap the review — the exact theatre the dialect
  gate exists to stop. Report them as needing a proof kind the dialect lacks. **And before treating
  a `verify: human` shard's questions as LIVE, check whether a `verify: auto` sibling already
  merged their substance** — measured twice in two days: the queue held open operator questions
  whose answers had shipped under a different id. The check: grep the shard's load-bearing symbols
  across merged trailers/subjects before escalating its questions. *(#984; siblings 2026-08-13/14)*

## Coverage traps

- **In a NEW `.ts` file, sandwich type-only `interface`/`type` declarations BETWEEN covered
  functions — never at the file's head or tail.** `--experimental-test-coverage` stamps `DA:<line>,0`
  across a new file's leading AND trailing source-line records (a source-map preamble/epilogue
  artifact), and diff-coverage flags an interface's property lines sitting there as uncovered code.
  Middle types, bracketed by executed statements, get no `DA:0`. *(#777 — head and tail both failed)*
- **Put any coverage-load-bearing test in its OWN `test/*.test.ts` file — never append it to
  `test/run-task.test.ts`.** That file intermittently crashes at FILE level under
  `--experimental-test-coverage` (the W1-T240 registry tests) — and the crash zeroes the ENTIRE
  lcov, so `diff-coverage` reads the 0-byte file as `OK` VACUOUSLY; only the `SF:` count check
  (the vacuous-pass bullet below) catches it. *(#781)*
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
- **Compute a new task id from the max across BOTH `plan/tasks.yaml` AND every `plan/tasks.d/*.yaml`
  shard.** "Next number after the last one I saw" collides with tasks that landed concurrently or
  live in a shard you didn't read, and `rmd lint-plan` then blocks the push.
  `grep -rhoE '^\s*- id: W1-T[0-9]+' plan/tasks.yaml plan/tasks.d/ | grep -oE 'T[0-9]+'` → max+1.
  **MINTING-ONLY — truncates letter-suffixed ids; duplicate detection compares whole ids:
  `sort | uniq -d` on `- id:` lines.**
  *(#770/#775 renumbered to W1-T257/W1-T261 — same collision twice)*
- **A `warn` NEVER REACHES `lint-plan`'s EXIT CODE — this bullet claimed the changed-tasks pass
  promotes one, and a session acted on that twice.** `lintPlanCommand` (`src/run-task.ts`) increments
  `failing` only inside `if (blocking.length)`, then `return failing > 0 ? 1 : 0`. `proof-resolvability`
  is demoted at `preDispatchLint` and stays advisory in CI. **AND `lint-plan`
  EXITING 2 WITH `cannot resolve --base <ref>` MEANS YOUR BASE SHA IS POISONED, NOT YOUR DIFF** —
  the message is `run-task.ts`'s own, returned as 2 rather than 1. CI passes
  `BASE_SHA: ${{ github.event.pull_request.base.sha }}`, an EVENT-PAYLOAD SNAPSHOT, so **A RE-RUN
  REPLAYS THE SAME POISONED SHA** and clears nothing; the remedy is merging current main into the
  branch. Same snapshot class W1-T351/#1380 fixed for commitlint. *(#984; the base-sha half
  2026-08-14)*
- **`rmd next-task-id` reads the LOCAL checkout — `git pull` first or it returns an id you filed
  minutes ago.** It DOES account for open PRs once current. **NO LOCK COVERS THE TRIAGE RUNG, WHICH
  MINTS UNATTENDED WHILE YOU TYPE**: `state/triage.lock` is triage-against-triage only and
  `state/task-id-reservations` is LOCAL, so neither sees another host's unpushed filing. TWICE a
  double-mint made `loadPlan` REFUSE `origin/main`, taking every plan-reading verb with it — W1-T488
  (#1816/#1817; repair #1820 merged only behind a temporary `enforce_admins` toggle) and
  W1-T533+W1-T534, repaired by RENUMBERING the loser to W1-T911/W1-T912 (#1964). Sweep
  `refs/rmd-id/*` alongside shards and open PRs — only that sees a RESERVED-BUT-UNFILED id (531/532
  were) — then re-sweep on a fresh fetch immediately before pushing. *(#1388: returned W1-T379 right
  after #1388 filed it, true max 380)*
- **Hand-mint with the PLAIN refspec — `git push origin <orphan-sha>:refs/rmd-id/<id>` — never `+`
  and never `--force-with-lease`: `+` SILENTLY DEFEATS THE LEASE, so a push that looks gated has no
  gate at all.** The CAS is a property of the PAYLOAD, not the namespace: an orphan `commit-tree`
  over the empty tree with no `-p` gives every writer a unique sha, so a second push is structurally
  a non-fast-forward — the form `gitRemoteRefReserver.attempt` (`src/lib/task-id-reservation.ts`)
  already uses, and this rule only stops hand-mints diverging from it. `reserveTaskIdRemote` has ONE
  call site, the triage mint, so a hand-filed shard bypasses it entirely (W1-T509 does NOT close the
  double-mint above; the second collision happened with it live). MEASURED on the real remote, one
  probe ref: plain onto an ABSENT ref → rc=0 `* [new reference]`; plain onto an EXISTING ref holding
  an unrelated orphan → **rc=1 `! [rejected] (non-fast-forward)`**; `+` → rc=0 `(forced update)`; a
  deliberately WRONG `--force-with-lease` combined with `+` → rc=0, the lease ignored outright;
  CONTROL, that identical lease WITHOUT `+` → `! [rejected] (stale info)`. W1-T509's header never
  tested `+`, and `+` is the case that clobbers. Read the EXIT CODE into a variable — non-zero means
  the id is TAKEN; renumber, never re-push.
- **A contested reservation is never deleted and an unfiled one is never free — the
  LOSER of a race renumbers.** A reserved id with no shard anywhere is HELD, not abandoned; deleting
  the ref re-opens the race it settled, and reclaiming one is an operator decision. *(2026-08-18: two hosts
  minted `refs/rmd-id/W1-T967` 5.76s apart; the first read back its own nonce, then after the PR
  opened re-read the other's commit — it carried `+`. Only the message's pid+host+time named the
  winner; the ref has no identity field.)*
- **A shard whose `files:` spans two concerns fails Rule 19 sizing at `risk:medium` — set
  `risk:high` UP FRONT and record in the note that the band is Rule 19's SPAN, not blast radius.**
  Decomposing a predicate from its own falsifier is not a real decomposition. **And NEVER file an
  empty `files:` list**: `overlappingPaths` (`src/lib/dispatch-overlap.ts`) fail-closes — one empty
  side returns the OTHER side's entire list — so an undeclared task overlaps every candidate, and
  placed first it serializes the whole dispatch pool behind it (measured: one empty-`files:` task at
  the queue head held admissions to 1 lane where 11 disjoint tasks waited; W1-T476 files the
  ordering fix, but the authoring rule stands regardless). *(#1400 shipped it, pushing open-failing 176→177;
  #1401 pre-empted it and stayed at 176; #1779)*
- **Decoding rule citations — where each family canonically lives.** "Rule N" / "Standing rule N"
  = MASTER-PLAN **§12** (1–25, plus 3B/8B); the linter enforces several by name — 15:
  `criterionFieldTampered` + `rule15FilingViolation`, 17: `provenanceViolation`, 18:
  `headlessFitnessViolations`, 19: `sizingViolation`, 21: `postMergeAmendmentViolations`, 25:
  `detectInstrumentEntanglement`/`INSTRUMENT_SURFACE` (`src/lib/review.ts` — and §12.25 says the
  code wins where they disagree). `rule15-*` tokens are artifacts NAMED AFTER §12 rule 15 (test
  files, recon slugs), not rules. "G-N" = operator directives indexed in MASTER-PLAN §14's "Grill
  RESOLVED" paragraph (G-17 = `enforceTierInvariant`, `src/lib/mounts.ts`). "P-N" = retro
  proposals in MASTER-PLAN's Retro-proposals ledger; retired ones are tombstones whose full text
  is git-archaeology only. *(mapped 2026-08-14 — the numbers were tribal knowledge until this row)*

## CI and merging

- **Do NOT push a fresh sha to clear a stale-red `ci-gate` — it self-clears.** ci-gate RE-READS
  inside a bounded grace window before concluding FAILURE, so a required check flipping
  FAILURE→SUCCESS on the SAME head sha needs no new commit and no manual re-run (W1-T261); its wait
  cap is sized against this repo's real required-check wall-clock, so a green-in-progress sibling is
  waited out rather than timed out (W1-T312, `WAIT_CAP_SECONDS` in `.github/workflows/ci-gate.yml`).
  Both defects are FIXED; the citations are the forensic detail. *(#873/#877, W1-T261/#885, W1-T312)*
- **NEVER BACKGROUND A POLLER OR ARM A CHECK-IN — do not loop on `gh pr view`, `gh run view` or any
  API call waiting for a state change. Report what you know and STOP.** A lane polled 80 times at a
  45-second cadence against an 8-13 minute CI cycle, exhausted the shared budget and locked the
  operator out of his own repo for ~90 minutes, while single calls 403'd and `/rate_limit` still read
  204 of 5000 used — the ceiling hit was the SECONDARY limit, which counts CADENCE, NOT VOLUME.
  A wait is the operator's to schedule, never yours. *(2026-08-20 — the ninety-minute lockout)*
- **`gh pr create` is GraphQL and dies with "API rate limit already exceeded" when that budget is
  spent** (frequent on this account while REST/core stays healthy). Open PRs via REST:
  `gh api --method POST repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=main -F body=@<file>`.
  Check with `gh api rate_limit` (`.resources.graphql.remaining` vs `.resources.core.remaining`).
  `rmd review` and `gh pr view --json` are ALSO GraphQL, so a hand-opened PR can't be reviewed until
  GraphQL resets. *(#766)*
- **A CONFLICTING PR registers ZERO check runs. `total: 0` reads as "still queued" but means
  `mergeable_state: dirty` — check mergeability before waiting on CI.** *(#1399 — a full CI cycle
  spent waiting on checks that were never going to start)*
- **`remudero-review` is a COMMIT STATUS, not a check-run — `/check-runs` is structurally blind to
  it.** `postReviewStatus` (`src/lib/review.ts`) POSTs `repos/…/statuses/{sha}` with context
  `REVIEW_CONTEXT`; `rollupFromRest` (`src/lib/open-prs-rest.ts`) says it in terms: reading only
  `/check-runs` "would drop `remudero-review` entirely and make every reviewed PR look unreviewed."
  Two analyses were misled by that read. The endpoints that DO see it: GraphQL's
  `statusCheckRollup` (a union of CheckRun AND StatusContext nodes) and the combined-status
  endpoint `repos/…/commits/{sha}/status` — use one of those, never `/check-runs` alone, when
  asking "is this PR reviewed". *(measured twice, 2026-08-13/14)*
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

## Ledger and evidence discipline

- **The rotations come in TWO FORMS and every glob that names only one answers SILENTLY WRONG. The
  union is three patterns, never two:**
  `zgrep -h '<pat>' state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson | sort -u`.
  `zgrep` reads plain input transparently (MEASURED: 223 hits on an uncompressed rotation), so the
  fix is always THE GLOB, never the tool. MEASURED POPULATION at 2026-08-12: **666 `.gz`, 3 plain,
  1 live** — and the `.gz` half STOPS at `2026-08-05T10-56-55Z`. `datedArchivePath`
  (`src/lib/ledger.ts`) returns `<base>.<stamp>.ndjson` and **nothing in the repo runs `gzip`**, so
  PLAIN IS WHAT THE CODE WRITES and the `.gz` corpus is out-of-band compression that has not run
  since. Expect the plain half to grow; never assume either half is empty.
- **Both one-sided globs are live defects, in OPPOSITE directions**: the sanctioned-until-now
  `.gz`-only form hid **34,861 rows (8.3% of the corpus), every row rotated out since
  2026-08-05T10:56:55Z** — mostly `board_gateway.*` and `sweep.*`; and `ledger.*.ndjson` alone
  misses all 666 `.gz`. **`src/` HAD the same bug both ways; W1-T444/#1657 (commit 70d52c2) fixed
  it**: `ledgerRotationEntries` (`src/lib/ledger-grep.ts`) is now THE ONE definition of the corpus
  (both forms), `resolveLedgerUnion` reads both and refuses on partial coverage, and
  `ledgerCorpusFiles` (`run-task.ts`) delegates to it — so **`rmd ledger-grep` IS the sanctioned
  in-process reader**; the three-pattern zgrep stays the out-of-process shell idiom. The check:
  `grep -c ledgerRotationEntries src/lib/ledger-grep.ts src/run-task.ts` — non-zero in both, or
  this bullet has gone stale again.
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
- **Treat a step NAME as a claim, not evidence — check what the function that wrote it can actually
  return.** `armAutoMerge` returns one of seven outcomes and never throws; five arm nothing, yet five
  Architect lanes logged `automerge.armed` unconditionally. Measured over the unioned ledger: 176
  rows; 135 blind, 17 provably false, 119 undecidable — OVERLAPPING categories, not a partition
  (they sum past 176) — the blind rows recorded no `head_sha`, so
  they can never be adjudicated. Any claim resting on that step name is unsound for rows
  before #981. **AND THE LANES ARE NOT EQUALLY GATED — THE OBVIOUS READING IS BACKWARDS, SO
  READ BOTH ARMS BEFORE ARGUING FROM ONE:** `grep -n 'return attemptArm' src/run-task.ts` prints
  them side by side. `triageCommand` arms only AFTER `waitForCiGreen` returns green, and
  `armAutoMerge` then reads `priorReviewVerdictFromLedger` and gates on `decideArmFromLedgerVerdict`
  — TWO gates; it never branches on `reviewCommand`'s exit code, so the `(review success)` in its
  console line is REPORTED, not consulted. `armAutoMergeAtOpen` is `return attemptArm(prUrl,
  deps);` — NO verdict gate and NO ci gate — and the implement lane calls it at PR-OPEN, before any
  review. **So IMPLEMENTATION PRs, which change source, self-merge earlier and with fewer checks
  than triage PRs, which only add plan text.** Operator ruling on W1-T489: DOCUMENTED, not changed.
  The unattended rate is real now that W1-T469 fires the rung on `partition.serialized.length > 0`
  rather than idleness, bounded by `autoTriage.maxPerDay`/`minIntervalMinutes` (`plan/policy.yaml`).
  Cost per run is a QUERY, not a number to carry (name-the-query rule above): re-derive it
  over the ledger union rather than quoting `src/lib/auto-triage.ts`'s figure. *(#981; the lane-asymmetry half W1-T489, 2026-08-14)*
- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** A control filtering on the
  absolute path counts the wrapper, returns 1, and reports a false pass, which would make every
  proof verification vacuous. Always run the control
  (`--test-name-pattern "no test title matches this xyzzy"`) and require a post-filter count of 0
  before believing any match count. *(#981 — the control caught the blind discriminator, not the proofs)*
- **A report written to `state/` is SCRATCH, not a record — land the finding in a TRACKED artifact
  in the same session, and never let a tracked artifact rest its evidence on a `state/` path.**
  `.gitignore`'s `state/` entry is correct and load-bearing (W1-T256: runtime exhaust the daemon
  writes into its own tree every run; un-ignored it reads as dirt in `git status --porcelain`, which
  pre-W1-T255 crash-looped the daemon on restart) and that directory also holds
  `state/service-tokens.json`. So this is a PLACEMENT defect, not a gitignore one — do not propose
  un-ignoring it. On the mini a report there is merely local; **in a cloud container it is
  destruction**, because nothing syncs it and the container is reclaimed. MEASURED at d968c50: **29
  distinct `state/*.md` paths cited across 43 tracked files — and all 29 absent from a fresh
  checkout**, so every one is a pointer no worker can follow; a session re-derived a whole finding
  from scratch after `state/recon-retro-test-github-calls.md` turned out not to exist. The durable
  homes: the PR body, the shard's own `rationale`/`note`, and `plan/feedback/` — tracked AND landed
  by `landFeedback` (`src/lib/feedback-landing.ts`), which rebuilds from origin/main and pushes, so
  it survives the container by construction. **Nothing in this repo tells a session where to write a
  report**; the convention lives only in the operator's briefs, which is why the rule lives here. THE
  COMPLIANT SHAPE is this file's own ledger-union bullet: it CARRIES its figures with their dates and
  a re-run query (`MAX_RETAINED_LINES_PER_STEP = 200` is symbol-anchored — the check IS the name),
  and any `state/` path is a supplementary pointer, never the evidence. *(established 2026-08-11)*
- **A fixture shelling git PLUMBING fails on every CI runner and passes on every dev machine, so it
  reads as flaky when it is deterministic.** `commit-tree` refuses `Author identity unknown` unless
  an identity is set, and `actions/checkout` sets NEITHER repo nor global: the fault is ambient
  config the fixture inherited locally. Reproduce before believing "flaky" —
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` plus unsetting the repo's
  `user.email`/`user.name` reproduces CI exactly. Fix the FIXTURE (pass the identity env vars git
  honours), never the workflow, never a skip. *(#1971, after #1964's retry failed the same way)*

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
  needs a word character to its left where the text has a space. **GNU `/usr/bin/grep -E` SCORES THE
  IDENTICAL PAIR 1 AND 0** on `run /usr/bin/date now`, so this reproduces everywhere and is portable
  regex semantics, not a harness quirk — and `/usr/bin/grep -E '\busr'` on that same line returns 1,
  the same as git's. Anchor on the non-word character itself (`[[:space:]]/usr/bin/`), use `-w`, or
  drop the `\b`. Never `\s` under `awk`. *(2026-08-12)*
- **(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` (ignore-binary) INJECTED, so a file
  holding ONE NUL byte is skipped entirely — no output, exit 1, indistinguishable from real
  absence.** A GATE NOW HOLDS THE TRACKED POPULATION AT ZERO (W1-T438/#1664; `test/no-raw-nul.test.ts`
  walks `git ls-files` and fails naming path@offset), so this is no longer a flag-every-session
  hazard for tracked sources. **WHAT SURVIVES: the tool is still blind**, so any UNTRACKED or
  newly-added file the gate has not seen reads as absent, and **BARE `rg` IS BLIND THE SAME WAY**
  (`rg -l` empty, `rg -la` fine) — "use grep -a or rg" is NOT the rule. `/usr/bin/grep` is
  unaffected, which is why it hid for months. Use `grep -ar`, `rg -la` or `git grep` for ANY sweep
  deciding a `files:` list, a violation count or a scope audit. Never carry a count; run
  `git ls-files -z | xargs -0 perl -0777 -ne 'print "$ARGV\n" if /\0/'`. `git grep --cached -I -l ''`
  is NOT a substitute — git sniffs only the first 8000 bytes. *(2026-08-11; folded 2026-08-16)*

- **(c) A GLOB THAT NAMES ONE FILE FORM ANSWERS FROM THE OTHER WITHOUT SAYING SO.** The ledger
  union's `.gz`-only glob returned **0 hits for a pattern with 3 real hits** while its positive
  control read 257k lines — because the control proved the `.gz` half readable and said nothing
  about the plain half it never globbed. Under `bash` a non-matching glob passes through literally
  and `grep` fails it into `2>/dev/null`; under `zsh` it errors. Full population, the corrected
  three-pattern idiom and the per-form control are under "Ledger and evidence discipline" above.
  THE GENERAL FORM: control on COVERAGE (did every form get opened?), not on READABILITY (did
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
  `tsc` reported four `api-client` errors inside a session's ad-hoc container; stashing and re-running
  on a CLEAN TREE got the IDENTICAL FOUR, reported as pre-existing. **THAT CONTROLLED FOR THE TREE AND
  NOT FOR THE ENVIRONMENT.** The cause was never in the repo:
  `node_modules/@remudero/api-client -> ../../packages/api-client` is a RELATIVE link, and that
  container mounted `node_modules` and `.git` but never `packages/`, so the link resolved to nothing.
  Mounting `packages/` and `apps/` alone made `tsc` exit 0; CI ran the same check as a required step,
  green, the whole time. AN ENVIRONMENTAL DEFECT REPRODUCES EXACTLY, so agreement between two readings
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

- **(g) A CHECK THAT IS ABSENT IS NOT A CHECK THAT PASSED — A ROLLUP SHOWS NEITHER.** Asking whether
  a red was base-caused or in-diff, a sweep read `success` for a required check on three sibling PRs
  and concluded the fault was in the diff. Those heads PREDATED the check's introduction, so it had
  never run on them: absence, not agreement. `baseCausedCheckName` (`src/lib/sweep.ts`) needs the
  check failing on EVERY open PR, so one older head silently refutes a real base outage. Restrict
  the comparison to heads built after the check first appeared. *(2026-08-16, #1919)*
- **(h) A CHANGE THAT REMOVES AN ACCESS PATH MUST PROVE THE REPLACEMENT FIRST, FROM A NEW SESSION
  — AN EXISTING CONNECTION IS NOT EVIDENCE.** `PasswordAuthentication no` went live against a
  0-byte `authorized_keys`; two pre-change sessions survived only because sshd never
  re-authenticates an established connection, and no third could have opened by any method. Prove
  the replacement under `BatchMode=yes` (which fails rather than prompting) and keep the old path
  until it does. The recurring shape is CREDENTIAL AND ACCESS ROTATION, not ssh. *(2026-08-16)*

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
  deploys when EITHER the install is behind origin/main OR the running daemon is not on the install
  (`runningStale`), so fast-forwarding the checkout does not consume the trigger. An unrecorded
  running sha is treated as stale (fail-eager), costing one self-correcting restart. To force a
  deploy by hand: `git pull` then `launchctl kickstart -k gui/$UID/com.remudero.daemon`. *(#1054)*
- **A fix you merge mid-drain reaches the PLAN and the WORKERS immediately and the JUDGE not at all
  — so "I merged it and the next run still did the wrong thing" is a RESTART, not a failed fix.**
  Three clocks, not one: `syncPlanFromOrigin` re-reads the plan blob from origin/main at every
  dispatch, `worktreeAdd` cuts each worker a fresh worktree off origin/main, but `judgeReview` (and
  the linter, and the drain loop) run in the orchestrator's own module graph, loaded once at process
  start. The trap is the MIXED result this produces — the worker visibly behaves differently while
  the judge that grades it does not — which reads as a flaky gate. NEVER validate a review/linter/
  drain change by watching the next live run; prove it in-process against the choke point's own
  objects, and treat judge behaviour as unobservable until a restart. `src/lib/self-sync.ts` says so
  itself: it covers process STARTUP only and hands in-process staleness to the WS-2 self-updater.
  *(re-derived 2026-08-11; operator table: docs/operator-guide.md's "What a merged
  fix reaches before you restart")*
- **A suite failing WIDE with ONE repeated message is an environment fault — read the message
  before the diff. THE DISCRIMINATOR IS THE RATIO, NOT A VERSION NUMBER.** `Cannot find package
  'tsx'` means the shared `node_modules` is empty (the bullet above), and the fleet then looks
  alive but cannot restart *(2026-08-06 — 52 supervisor failures)*. A repeated
  `browserType.launch` means the installed Playwright build is not the pinned one — 96 of 97
  failures, one message; no real regression does that. Run
  `node -p "require('playwright-core/browsers.json').browsers.find(b=>b.name==='chromium').revision"`
  against `ls ~/Library/Caches/ms-playwright`. FIX THE ENVIRONMENT — alias the build where the
  runner looks; **never edit the pin**. Container-scoped: the mini already carries the expected
  revision. *(2026-08-15)*
- **Run EVERY `rmd` verb as `RMD_SELF_SYNC_DONE=1 ./bin/rmd <verb>` — there are no read-only verbs.**
  `checkCliFreshness` (`src/lib/self-sync.ts`) runs `git(["merge", "--ff-only", "origin/main"])` on a
  checkout that is CLEAN and BEHIND, before the verb's own work. So `status`, `lint-plan` and
  `check-proof` — the three every brief calls pure readers — all FAST-FORWARD THE CHECKOUT as a side
  effect. Under a live worker that silently takes a pull the deploy owns, on a tree someone else is
  mid-task in. `SELF_SYNC_GUARD_ENV` is the documented escape and is the only safe form for an agent
  that is not deliberately syncing. *(established 2026-08-06; contradicts every brief written before it)*
- **NEVER match on command TEXT to kill a process — `pkill -f` and `pgrep -f` SELF-MATCH.** The
  pattern you are searching for appears in the command line of the shell running the search, so that
  shell is inside its own match set and dies mid-command; the harness reports exit 144 and every
  later step in the same invocation is silently skipped. One session hit this TWICE IN ONE EVENING,
  the second time while cleaning up after the first, and another killed its shell with
  `pkill -f "main-pristine"` days earlier. "Use a more careful pattern" is too weak a rule — it asks
  for care where a DIFFERENT MECHANISM is available: use the harness's own task id and its stop
  mechanism, or a pid captured at spawn (`child.pid`, a pidfile). Do not grep the process table to
  find something to kill. When you must reach a whole tree, spawn it `detached` and use
  `killProcessGroup` (`src/lib/worker-containment.ts`), which is pid-based and ESRCH-tolerant.
  *(2026-08-09 ×2; the `main-pristine` kill days earlier)*
- **PREFER `git checkout -- <path>` WITH A SAVED COPY OVER EVERY `git stash` FORM — the stash is A
  SHARED UNNAMED LIFO STACK on a checkout several sessions touch, and `git stash pop` with no
  argument takes `stash@{0}` whoever pushed it.** Same shape as the shared `node_modules` bullet
  above: one mutable resource, no lock, several writers. MEASURED 2026-08-13 — the stack held ONE
  entry dated 2026-07-23 on base `7c406b6` (#648), three weeks older than any live session, and a
  session's `git stash -u` + `pop` restored its payload into that session's tree. It noticed and
  removed them, but **`git status` after a `pop` shows another session's files INDISTINGUISHABLE
  FROM YOUR OWN WORK** — nothing marks provenance, and `git log` authorship does not either (every
  entry here is `cao825`). THE CHECK IS ONE COMMAND: `git stash list` before and after any stash
  operation. **AND INSPECT WITH `^3`, because the obvious command UNDERSTATES the payload** —
  `git stash show --stat stash@{0}` printed NOTHING for that entry, since all 9 files were UNTRACKED
  and untracked payload hangs off the third parent: `git show --stat 'stash@{0}^3'` is what shows it.
  **`git stash push <path>` WORKS and is still the wrong verb**: the new entry lands at `stash@{0}` and DEMOTES the older one, so a
  concurrent bare `pop` takes yours. `git checkout -- <path>` is scoped to the path, cannot reach
  another session's work, and cannot silently no-op. *(2026-08-13 — the eight-file pop)*

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

## Code traps

- **`src/lib/serve.ts`'s client JS lives inside a backtick template literal — never put a backtick
  inside a client-code comment** (e.g. `` `lastLiveAt` ``). It terminates the outer template and
  esbuild fails with `Expected ";" but found …`. Sanity-check by rendering the shell and parsing the
  client script (`new Function(<largest <script> block of renderShellHtml()>)`). serve.ts DOM
  behavior is covered by REAL Playwright/Chromium tests (`test/serve.*.test.ts`) — run them for any
  client change. *(#777)*

## Lessons from 2026-08-19

- **A deps object supplying SOME fakes leaves every other seam on its REAL default — so relaxing a
  guard can make a previously-dead default FIRE, in a file the diff never touched.** The MIRROR of
  the all-fakes bullet above. A test stubbing only `log` let the real `defaultReexec` fire, which
  replays `process.argv.slice(1)` — under `node --test` that IS the runner — killing six runners at
  `exit 143` with no failed step and no summary, which reads as preemption. Run every CALLER of a
  changed symbol (`git grep -l`), never the files the task declares; the scoped run was green.
  *(#2237, #2248)*
- **Read re-entrancy from `process.env`, not an injected `env` argument — a spawn writes a child's
  environment and cannot reach a parameter.** A caller passing `{}` saw no loop guard; `isCiEnv({})`
  is false for the same reason. *(#2248)*
- **A fixed date constant compared against rows stamped at REAL time is a time bomb; the signature
  is a red beginning at a clock boundary with no diff involved.** Compare the last green run's
  timestamp against the first red one before blaming a change. Stamp through the injected clock at
  the write seam; moving the constant only re-arms it. *(#2250)*
- **Verify a new falsifier by DELETING the fix and re-running — `# fail N` removed vs `# fail 0`
  restored is the evidence it is load-bearing.** A guard seeded with rows already carrying the field
  under test passed either way. *(#2250)*
- **A `verify: auto` task can NEVER declare its own plan record in `files:`, so a ratified scope
  widening is recorded in the source comment and PR body, not the shard** — `rule15-filing` refuses
  it, and the reviewer's `scope_violation` is ADVISORY, naming "review-ratified widenings"
  legitimate. *(#2255)*
