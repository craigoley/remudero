# test/ restructure — coupling inventory (2026-10-16)

Read-only research at origin/main `a323d87ed` (extracted with `git archive`, no checkout touched).
Population: 3,640 flat `test/*.test.ts` + 3 already nested (`test/helpers/git-repo.test.ts`,
`test/helpers/fake-github.test.ts`, `test/fixtures/golden-verdicts/dead-proof/checkout/test/existing.test.ts`
— the last one is matched by `test/**/*.test.ts` today, probably by accident).

Legend: **LOUD** = a move makes something red/throw. **SILENT** = keeps passing while it checks less or nothing.

## Headline answers

1. **No gate re-executes MERGED tasks' proofs at head.** Every proof executor that blocks anything
   (rmd review / `judgeCriterion`, `check-proof --base`, `proof-discrimination-gate`, `proof-resolve-precheck`,
   `acceptance-author-gate` credited-test-path) evaluates only the ONE task the PR credits (run-<id> branch or
   `Remudero-Task:` trailer). Historical proofs that name moved paths go stale but nothing turns red.
   The memory note *a-refactor-can-falsify-its-own-plan-proof* applies only to the PR's OWN task (and to
   OPEN tasks built after the move, see 1b).
2. **No path-alias / rename map / `moved_to` exists.** The nearest thing is proof-queue-audit's report-only
   `relocated` bucket (`src/lib/proof-queue-audit.ts:17,65-67`): a `grep:` symbol found at another path
   *the task itself declares*. A moved file is not declared, so it does not help.
3. **Rewriting historical proofs is legal but noisy.** The proof and `files:` edits must go in a plan-only PR
   (Rule 15, `criterionFieldTampered`, `scripts/rule15-precheck.mjs`), so they cannot share a PR with the move.
   On merged tasks the edits produce only WARNs: `post-merge-proof-changed`, `post-merge-field-drift`
   (`src/lib/task-linter.ts:2328,2477`). `criterionKey` is the claim text (`:2028`), so `post-merge-amendment`
   (the BLOCK) does not fire when only the proof changes. Expect about 8k warn rows plus the
   `creditedAmendmentVisibility` "amended since credit" report (`src/run-task.ts:29140`).
4. **The real breakage is mechanical, and mostly loud.** Inside the test files: about 3,300 `../src` imports,
   about 1,150 `./helpers` imports, and about 1,190 files that compute the repo root from their own location.
   About 20 SILENT walkers and selectors are listed in section B.

---

## A. Plan shards (item 1)

| Fact | Count |
|---|---|
| Shards in `plan/tasks.d/*.yaml` | 3,947 (+ ~269 tasks in `plan/tasks.yaml`; 4,216 tasks total) |
| Tasks citing a `test/…test.ts` path (proof or `files:`) | 3,473 |
| Proofs that mention a test path | 9,748 of 14,397 |
| — whole-file `unit test: test/x.test.ts` | 5,478 merged/done · 375 open · 419 retired |
| — `grep: … in test/x.test.ts` | 2,434 merged/done · 794 open · 174 retired |
| — title-only `unit test: <title>` (path-free, **robust**: resolver `grep -rl … test` recurses, `src/lib/review.ts:2766-2770`) | 1,984 merged · 125 open · 332 retired |
| `files:` entries naming a test file | 4,673 |
| Distinct test paths cited | 3,272 (474 already absent at head today, which shows nothing re-checks them) |
| Existing flat tests cited by ≥1 shard / never cited | 2,796 / **844** (the 844 can move with zero plan coupling) |
| OPEN tasks (not merged/done/blocked, no retirement) citing an EXISTING test file | **147 tasks / 202 files** (57 tasks/190 whole-file proofs, 55 tasks/112 grep proofs, 115 tasks via `files:`) |

The status field lags (memory: *plan-status-lags-the-merged-pr*), so treat "open" as an upper bound.

### 1a. Consumers that DO look at merged/credited tasks' proofs at head (all non-gating)
- `src/lib/synthetic-tasks.ts:mineSyntheticTasks` (lines ~95-130) re-grades golden-corpus merged tasks' unit proofs
  against TODAY's main. A moved path becomes `reject("proof on main was …")`. **SILENT** shrink of the synthetic pilot.
  The golden corpus (`src/lib/golden-corpus.ts`) takes proof text from ledger `review.posted` rows and replays at
  the historical `baseSha`, so it is fine if proofs are NOT rewritten and broken if they are (new paths do not exist
  at the old base). `spec.files` comes from the current shard. **This is the one real trade-off against rewriting
  historical proofs.**
- `rmd proof-queue-audit --credited` (`src/run-task.ts:creditedProofVisibility` ~29111) reports
  `credited-test-path-absent` / `grep-path-absent` for every moved path. Report-only (exit 0).
- `src/lib/measurement-cadence.ts:2569` proof-debt producer → `mintProofDebtProposals` (`:1386`). The population is
  OPEN unmerged tasks only (`defaultProofDebtCadenceInput`, `src/run-task.ts:~32286`). A whole-file forward
  reference is not reported, but a `grep: … in test/<moved>` on an open task becomes `grep-path-absent`, which
  **mints proof-debt proposals** (≤55 tasks/112 rows). A fleet-visible side effect.
- `backlog-gardener.ts:ownProofsHoldOnMain`, `plan-gardener.ts:195`, `scripts/satisfied-task-census.mjs` (queued only):
  a moved path makes a proof fail, so these simply do not auto-retire. SILENT and benign.

### 1b. Loud gates hit by OPEN tasks built after the move (the a-refactor-falsifies-its-proof class)
- `scripts/acceptance-author-gate.mjs:599` uses `creditedTestPathViolations` (`src/lib/task-linter.ts:1426`).
  **BLOCK**, required check: every `files:` test path and every path-form proof of the credited task must exist at
  the PR head. A pre-move task that names `test/x.test.ts` after x moved is refused. Rule 15 forbids the worker
  from fixing it, so it needs an operator amendment. Exposure: ~147 open tasks.
- rmd review: a whole-file or grep proof on a moved path grades `executed_fail`/`exec_error`, which means FAIL and
  fix rounds. `proof-resolve-precheck.mjs` predicts it pre-push.
- `files:` scope: advisory only (`scopeViolationFiles`, `src/lib/review.ts:4866`; the push-side
  `scopeGuardOutOfScopeFiles` is commented out, `src/run-task.ts:382`). `dispatch-overlap.ts:overlappingPaths` (`:142`)
  matches exact paths, so a task declaring the old path and one declaring the new path are **not serialized**.
  SILENT (the class in memory note *parallel-agents-on-one-file-break-main*).
- Origin dedup keys for open tasks: `flake-incident:${file}` (16 tasks), `selector-shadow-miss:${file}` (89),
  `expiring-fixture:${file}` (2). The gardeners file duplicates under the new path. SILENT.

### 1c. Lint checks keyed on test paths
- `proofBaseDiscriminationViolations` (`task-linter.ts:1520`): a whole-file proof on a path that exists at base
  grades `executed_stale` (the existing "dominant idiom" problem, 5,365 grandfathered in
  `scripts/proof-discrimination-baseline.json`, keyed by **task id**, not path, so the move does not affect it).
- `newShardRuleSuiteViolations` (`task-linter.ts:1829`) and `listRuleSuites` (`src/lib/ci-parity.ts:2902`) match
  `RULE_SUITE_NAME_RE=/(census|ratchet|baseline)/i` (unanchored) against the path after `test/`.
  **Do not name a folder census/ratchet/baseline**: every file in it would become a rule suite and go LOUD on
  `unasked` parity.
- `moduleIdFromPath` (`task-linter.ts:163`) is basename-based and robust.

## B. SILENT couplings in code (rank: the ones that hide coverage first)

| # | file:symbol | key | effect of a move |
|---|---|---|---|
| 1 | `scripts/test-tier-manifest.json` (3,450 FULL keys; 472 ≥5 s; **93 pinned 5000 = flakers**) via `test-tier-manifest.mjs:195` `manifest.files[f] ?? 0` | exact path | Leaving old keys fails `--check` with ghost rows (LOUD, `:983`). **Deleting** rows instead of rewriting sends slow tests and flakers to the fast tier and the shared-process pool (`pure-test-pool.mjs:104`). Shard weights fall to the median (`:164`); `coveragePrecheck` (`run-task.ts:19247`) and `preflight-author.mjs:393` misprice. `mergeDurations` never prunes. **Re-key, preserving values.** |
| 2 | `scripts/diff-class.mjs` `planReadingSuiteFiles`:292, `planOnlySuiteFiles`:312, `censusSuiteFiles`:547 | `readdirSync(test)` + `isFile()` | Nested suites are never selected for PLAN_ONLY/DOCS/TEST_ONLY fast lanes, `affected-suites.ts` `pathReaders` (`:726`), or the author lane. A partial move narrows silently; a full move falls back to the full suite. **Fix before the first move.** |
| 3 | `src/lib/affected-suites.ts:413-544,647,728,741,770` (19 census + 15 edge paths) | `input.files.has("test/…")` | Suite dropped from merge-group selection (live), daemon `coveragePrecheck`, `rmd preflight`. PR CI is shadow-only (`ci.yml:60`). |
| 4 | `scripts/fixture-copy-census.mjs:listFixtureCopyFiles`:69 + `census-precheck.mjs:106` `FIXTURE_SCOPE_RE=/^test\/[^/]+\.test\.ts$/`, `:184/191` | flat readdir / flat regex | Moved files leave the census. The ratchet is `live <= baseline`, so the shrink passes. |
| 5 | `scripts/clock-sweep.mjs:101` (readdir), `:123` flat regex, `:208,262,303-344` `test/${suite}.test.ts`; `clock-sweep-baseline.json` (11 stems), `SPAWN_REACHING` (6 stems) | flat / stem | Zero candidates, `ok`. If someone makes the walk recursive, stems become `dir/stem` and the `mounts-wiring` exclusion (a real $1.42 model spend) **stops matching**. |
| 6 | `src/run-task.ts:6809` `addedTestFilesAtHead` | `/^test\/[^/]+\.test\.ts$/` | Body repair reads "diff adds no test file" (`:6435,:12871`). |
| 7 | 13 census-shaped tests that read only the top level of test/ (18 sites): `architecture-fitness`, `host-capability-fixtures`, `no-test-aims-a-write-at-procfs`, `the-mutant-loader-resolves-every-relative-import`, `the-suite-is-green-on-a-developer-host`, `mutation-ratchet`, `orphan-sweep-names-the-third-party`, `git-fixture-gc-hygiene`, … | `readdirSync(TEST_DIR)` with TEST_DIR from `import.meta.url` | Population shrinks. Once the census file itself moves, it scans only its own subfolder. |
| 8 | `.github/workflows/mutation-nightly.yml:66` `find test -maxdepth 1` | flat | Partial move narrows silently; full move fails as "NIGHTLY BLOCKED" (loud). `scripts/mutation-relevant-paths.json` (7 exact paths, `mutation-ratchet.mjs:56`) stops triggering. |
| 9 | Workflow `paths:` triggers: `clock-sweep.yml:31-33`, `recovery-drill.yml:34` | exact | Workflow stops firing on edits. |
| 10 | `scripts/test-tier-coverage-manifest.json` (2,400 keys; 2 ghosts already) | exact | Never ghost-checked; falls back to the median; `--record-evidence --ewma` self-prunes. |
| 11 | Ledger `test.flake_retry.file` and test-gardener history (`test-gardener.ts:163,292`) | exact path | Flake history resets, so the RETIER_THRESHOLD=3 count restarts. |
| 12 | `scripts/affected-reach-baseline.json` (933 importers) | exact | Only 3 counts ratcheted; the list goes stale. |
| 13 | `scripts/census-precheck.mjs` `PRECHECK_TRIGGERED_SUITES` triggers like `changed.includes("test/no-test-drives-…")` | exact | Editing the moved suite no longer re-asks it pre-push (CI still runs it). |
| 14 | `src/lib/plan.ts:452` `SCOUT_TEST_FILE`, `:499` `affected-suites-selects-*` | flat regex | Shape recogniser misclassifies nested paths. |
| 15 | 9 `learnings/*.yaml` `files:` scopes naming tests | exact | The learning stops being injected. |
| 16 | `ci.yml:287` `find -maxdepth 1`, `ci.yml:475` `ls test/*.test.ts` | flat | Cosmetic count. **Note:** `:475` runs under `-eo pipefail`, so it fails the step once ZERO flat tests remain. |
| 17 | `src/lib/ci-parity.ts:2427` `censusJobSlug` | path → slug | A nested path puts `/` into the job slug. |

## C. LOUD couplings (red, but each needs an edit in the move PR)

- **Inside the test files** (agent census; my spot check: 3,273 files with `from '../src/`, 1,149 with `./helpers/`):
  - 3,612 of 3,640 files carry some location-relative path. Only 28 are location-free.
  - ~3,300 files with static `../src|scripts|packages|bin|package.json` imports.
  - 1,159 files with `./helpers|setup|fixtures|lib` imports.
  - 175 files with dynamic `import("../…")`. 0 relative `mock.module`.
  - ~1,193 files computing the repo root from their own location (`new URL("..", import.meta.url)`,
    `resolve(here, "..")`). Mostly ENOENT (loud). **Silent** where the result is only a spawn `cwd` or sits
    behind `existsSync`.
  - 51 files reach `./fixtures` at runtime.
  - Sibling imports that break if a pair is split: `./browser-absence.js` (4 files),
    `./every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js` (4),
    `./env-var-registry.test.js` (1).
  - ~42 sites in 35 files read another test by `test/<name>` path.
  - 667 quoted refs to real `test/<name>.test.ts` in 286 files: loud when read, silent when used as a selector key.
  - Most-referenced targets: `daemon` 12, `run-task` 10, `sweep` 8, `the-affected-suite-reach-ratchet` 8.
  - typecheck covers `test/**/*.ts` (tsconfig `include`), so import breaks fail `tsc` too.
- `src/lib/ci-parity.ts` `CENSUS_POPULATION` (60 `testFile:` literals): `censusPopulationDrift` (`:3103`) reports
  stale and unknown entries.
- `scripts/census-precheck.mjs` `PRECHECK_PARITY` / `PRECHECK_TRIGGERED_SUITES` / `PRECHECK_PATH_TRIGGERED_SUITES` /
  `PRECHECK_EXTRA_CI_CENSUSES` (~41 distinct paths): `precheckParityVerdict` (`:952`) reports unasked and stale.
- `scripts/census-precheck-parity-baseline.json` (84 rows): rewriting the rows reads as `grown` against the merge
  base (`test/every-ci-census-is-asked-before-the-push.test.ts:111`). **The move PR needs a rename-aware exception
  or a two-step change.**
- `scripts/expiring-fixture-census.mjs` `RECORDED_POPULATION_BY_FILE` (42 exact paths): `refusePopulationDrop`
  (`:534`) fires. The enumeration itself (`git ls-files test/*.test.ts`, `:749`) is recursive.
- `scripts/source-text-assertion-baseline.json` (213), `scripts/assertion-discrimination-baseline.json` (13),
  `hooks/mkdtemp-allowlist.txt` (850 rows / 278 files): a moved file gets allowance 0 and goes red until the keys
  are rewritten.
- `scripts/comment-load-baseline.json`: per-path ceilings, re-key in the same PR.
- `package.json` (28 named test files, `census:*` / `test:*`), `stryker.conf.json` (7), workflow `run:` lines
  (`ci.yml:1177`, `clock-sweep.yml:85,88`, `recovery-drill.yml:66`): `node --test` on a missing file.
- `scripts/lib/native-author-runtime.mjs:27-29`: the profile is bound to the corpus and manifest hash, so it needs
  recalibration.
- 1 learning `assertion: test -f test/no-plan-shard-carries-a-duplicate-key.test.ts`.

## D. Already fine (recursive)
- `package.json` `test` / `test:ci` (`"test/**/*.test.ts"`), `src/lib/test-run.ts:77`, tsconfig, coverage excludes
  (`test/**`).
- Every `git ls-files` / `git grep` with a `test/*.test.ts` pathspec passed via execFile, because git's `*` crosses
  `/` (verified with a probe repo). Callers: `gate-gardener.ts:214`, `expiring-fixture-census.mjs:749`,
  `ci-parity.ts:2888,3042`, `source-text-readers.ts:229`, `read-map-corpus.mjs`.
- `listRuleSuites` (`git ls-files -- test`).
- The review resolvers: `TEST_GLOB="test/**/*.test.ts"` (`review.ts:998`), `grepFilesContaining -rl … test`,
  `SUITE_ROOTS` prefix `test/`, admitted-new-test regex `^test\/.*` (`review.ts:4856`), `inbox.ts:3919`.
- `affected-suites.ts:96` `SUITE` regex and the import graph (it follows rewritten imports).
- `test-duration-reporter.mjs` (full relative path), `ci-shard-admission.mjs`, actions/cache keys.
- `house-layout-census` (src literals only, no constraint on where tests live).
- Every helper in test/helpers|setup|lib computes the root from its own location, so helpers are unaffected while
  they stay put.

## E. The move PR itself
- **Rename detection collapses above ~1,000 edited moves.** Probe (git 2.54): 1,100 moved+edited files were
  detected as R. 3,700 gave "exhaustive rename detection was skipped", so **every file showed as A**.
  `flake-screen.mjs:46` (`--diff-filter=A`) would then screen thousands of files on shard 1. `check-proof.ts:129`,
  `run-task.ts:6806` and `worker-branch-shape.mjs:339` all key on A as well.
  Exact (unedited) renames are always detected.
  **Batch edited moves at ≤ ~900 files per PR**, or make the moves content-free (e.g. a `package.json` `imports`
  alias such as `#src/*`, so specifiers do not change with depth).
- Proof and `files:` rewrites cannot share the PR (Rule 15), so there is a window between the two merges.
  Recommendation: do **not** rewrite merged/retired proofs (nothing re-checks them, and the golden-corpus replay
  wants historical text). Rewrite only the ~147 open tasks citing existing files, in a plan-only PR merged right
  after each move batch. Or move the 844 never-cited files first.

## F. Naming and placement today (item 6)
- Drafting rule: `src/lib/inbox.ts:1723`, "A new file is either test/<task-title-slug>.test.ts or declared in design
  on its own CREATES: <path> line". Enforced as a BLOCK in `draftMissingPathViolations` (`inbox.ts:2144-2150`):
  only exact `test/${slug}.test.ts` is exempt, so a nested new path without `CREATES:` gets `draft-path-missing`.
- Flat-path generators: `hot-file-gardener.ts:245`, `ci-friction-gardener.ts:1219`, `flow-gardener.ts:483`,
  `flow-remedy-gardener.ts:392`, `scout-gardener.ts:207` (`test/scout-…`), `selector-shadow-gardener.ts:1207`
  (`test/affected-suites-selects-…`), constant `plan.ts:482` `SELECTOR_SHADOW_MISS_TEST_PATH`.
- Proof dialect docs/examples: `proof-grammar.ts:28`, `review.ts:1462,9834`, `ci-escalation-judge.ts:184`,
  `docs/proof-dialect.md:23,74`. `prompt-render.ts:635` says "Files under test/ may be added or edited although
  undeclared".
- Shard `files:` convention: 1,356 flat test entries vs 4 nested (helpers/fixtures only).
- CLAUDE.md / AGENTS.md / CONTRIBUTING.md say nothing about where tests live; they only use recursive `grep … test/`.
- Without a placement rule, every gardener keeps minting flat files, so the layout drifts back.
