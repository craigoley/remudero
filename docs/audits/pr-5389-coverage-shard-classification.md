# PR #5389 coverage-shard (1/4) failure — flake or regression? (W1-T4347)

**Scope:** W1-T4347. Read-only forensic pass: one artifact, no source, script or test edited, no fix
shipped. The question: PR #5389's `coverage-shard (1/4)` and `coverage-ratchet` failed while
`coverage-shard (4/4)` and `mutation-ratchet` passed, against what the follow-up harvest called a
"single-file `stryker.conf.json` diff". Name the failing test, reproduce it twice, decide.

**Method:** PR #5389's head was fetched with `git fetch origin refs/pull/5389/head` (head
`000084ac9`, two commits over base `daf74eaa9`). Its first commit `45a2c740f` was materialised in a
scratch worktree. Shard 1/4's exact selection was regenerated with
`scripts/test-tier-manifest.mjs --select-all --shard 1/4 --base HEAD^1` (the command in that
commit's own `ci.yml`), and run twice under `node --test` with CI's `--import tsx --import
./test/setup/tmp-hygiene.ts`. The corpus was re-derived with `grep -rlF -- 'stryker.conf' test/`.

## Evidence that could not be pulled

The CI run logs were NOT retrieved. Every `gh pr view 5389` attempt in this session was refused by
`deny-floor.sh` (W1-T3275, 180 s read floor) because the host-wide `~/.cache/remudero/gh-last-read`
stamp is touched by other fleet sessions every second or two; the floor was not overridden
(`RMD_GH_COOLDOWN_S=0` is the operator's choice, not a worker's). So the **verbatim CI assertion
text, the PR's mergeability/merge state and the exact merge-ref sha CI tested are unverified**. The
failing test below is therefore named from a local reproduction of CI's own selection, corroborated
by the PR's second commit message, not read from the CI log. A re-read (`gh run view --log` for the
`coverage-shard (1/4)` job on head `45a2c740f`) would confirm the text; see Follow-ups in the report.

## The premise, corrected

- **The diff was not single-file in its final form, and its first commit was not the whole story.**
  PR #5389 is `45a2c740f` (`stryker.conf.json` only: +9/-3) followed by `000084ac9`
  (`scripts/mutation-relevant-paths.json` +1, `stryker.conf.json` (reverts the
  formatting churn, -8 lines net), and `test/mutation-trigger-covers-its-own-command.test.ts`, whose positive control it updates). The shards that
  failed ran on `45a2c740f`; the second commit's own message says why it exists: "Update the guard's
  positive control so coverage shard 1 no longer fails on drift."
- **The harvest's "shouldn't touch coverage shards at all" is wrong on the source.**
  `scripts/diff-class.mjs` `classify()` returns `SOURCE` for any path outside plan scope or
  `docs/`; `stryker.conf.json` is neither, so the full instrumented suite runs.
- The first commit's `stryker.conf.json` diff also reformatted three JSON arrays (`mutate`,
  `reporters`) onto multiple lines — churn unrelated to its purpose, reverted by the second commit.
- Drift in the filing's citations: `ci.yml` has since moved the coverage matrix to `/8` with a
  narrow-selection path (W1-T5705), and the cited line numbers no longer hold. At the PR's own
  commit the step is `ci.yml:809` with `--shard ${{ matrix.shard }}/4`, which is what was reproduced.

## FAILING TEST: test/mutation-trigger-covers-its-own-command.test.ts — "W1-T108/R-42: every test file stryker.conf.json's commandRunner.command runs is named in scripts/mutation-relevant-paths.json" and "W1-T108/R-42: positive control -- the real command really does name more than test/classify.test.ts"

Assertion text (local reproduction at `45a2c740f`, identical on both runs):

```
AssertionError [ERR_ASSERTION]: test file(s) the Stryker command runs but scripts/mutation-relevant-paths.json does not list: test/a-capped-pr-exhausts-repair-before-it-reaches-a-human.test.ts -- a PR weakening one of these alone would read `matched: false` and skip Stryker
  actual: [ 'test/a-capped-pr-exhausts-repair-before-it-reaches-a-human.test.ts' ], expected: []
AssertionError [ERR_ASSERTION]: control: the command's own test-file set must match what R-42 measured
  actual: [ 7 files incl. test/a-capped-pr-exhausts-repair-before-it-reaches-a-human.test.ts ], expected: [ the original 6 ]
```

Mechanism: commit `45a2c740f` appended `test/a-capped-pr-exhausts-repair-before-it-reaches-a-human.test.ts`
to `stryker.conf.json`'s `commandRunner.command` and touched neither
`scripts/mutation-relevant-paths.json` (the exact-`Set.has` list `evaluatePathFilter` reads) nor the
positive control, which hard-codes the six-file list in a `deepEqual`. The census test reads the LIVE
`stryker.conf.json`, so it fails wherever `test-tier-manifest.mjs` places it. That is shard 1/4:
the regenerated selection of 314 files contains `test/mutation-trigger-covers-its-own-command.test.ts`
at position 324 of the tokenised output, and shards 2, 3 and 4 do not. Shard 4/4 green is therefore
expected, not evidence of flakiness. Stryker's own run never executes this test (it is not one of
the seven command-runner files), which is why `mutation-ratchet` passed. `coverage-ratchet`
aggregates the shards' artifacts, so one red shard fails it too.

## CORPUS: 12 test files and 1 fixture reference `stryker.conf` (live `grep -rlF`, not the filing's count)

Classification against PR #5389's first commit (the diff that was red). "Result" is each file run at
`45a2c740f` in isolation.

| File | Class | Reads the live file? | Could #5389 move it? | Result at `45a2c740f` |
|---|---|---|---|---|
| test/mutation-trigger-covers-its-own-command.test.ts | CONTENT-SENSITIVE | yes, `commandRunner.command` | yes: command gained a test file | **2 of 4 FAIL** |
| test/mutation-ratchet.test.ts | CONTENT-SENSITIVE | yes, `mutate` and `commandRunner.command` (importer sweep) | command changed; the sweep only requires importers to be present | 37/37 pass |
| test/a-test-outside-strykers-command-is-invisible.test.ts | CONTENT-SENSITIVE | yes, `commandRunner.command` | command changed; derived, not hard-coded | 9/9 pass |
| test/instrument-isolation.test.ts | MEMBERSHIP-ONLY | no: asserts the path string is in `INSTRUMENT_SURFACE` | no | 17/17 pass |
| test/awareness-surface-ratchet.test.ts | MEMBERSHIP-ONLY | no: passes the path string to `checkDocsAwareness` | no | 11/11 pass |
| test/a-size-ledger-is-not-a-score-floor.test.ts | MEMBERSHIP-ONLY | no: path in an exempt-instrument set | no | 5/5 pass |
| test/mutation-report-validity.test.ts | MEMBERSHIP-ONLY (comment + fixture) | no | no | 14/14 pass |
| test/a-ci-skip-guard-can-fire-unconditionally.test.ts | MEMBERSHIP-ONLY (comment only) | no | no | 29/29 pass |
| test/classify.test.ts | MEMBERSHIP-ONLY (comment only) | no | no | 25/25 pass |
| test/three-retries-in-three-seconds-against-a-lockout.test.ts | MEMBERSHIP-ONLY (comment only) | no | no | not run alone; in shard 1/4 selection |
| test/temp-hygiene-suite.test.ts | MEMBERSHIP-ONLY (comment only) | no | no | not run alone |
| test/proof-exec-tmp-hygiene.test.ts | MEMBERSHIP-ONLY (comment only) | no | no | not run alone |
| test/fixtures/mutation-ratchet/relevant-paths-seeded.json | FIXTURE (data) | consumed by tests, not a reader | no | n/a |

Three of the thirteen are content-sensitive; only one of them hard-codes an expectation of the
command's exact membership. That one is the only test #5389's first commit could and did break.

## REPRODUCTION: failed on both runs of shard 1/4's exact selection; the isolated census test failed on both runs too

- Selection: `node scripts/test-tier-manifest.mjs --select-all --shard 1/4 --base HEAD^1` at
  `45a2c740f`, run twice, byte-identical output (314 files, `predicted_duration_ms=764738`).
- Isolated census test, two consecutive runs: both red, same two tests, same assertion text.
- Whole shard 1/4 selection, two consecutive runs (`# tests 3778`):
  - run 1: `# fail 24`; run 2: `# fail 22`.
  - Fails in **both** runs and attributable to the diff: tests 1954 and 1955, i.e. exactly the two
    census tests above.
  - The remaining failures are NOT attributable to #5389. This sandbox is not CI, so the dashboard density/drill, serve-orphan-teardown,
    `check-proof-executor-parity`, `ledger-rotation`/`coverage-session-blanking` idempotency,
    `runtime-adoption-is-reported-not-gated` and `test-with-retry` files fail here. Controlled by
    re-running those six files at the PR's fixed head `000084ac9`: **9 of 93 still fail there**
    (same families), whereas the census test passes 4/4 at `000084ac9` and on current `origin/main`.
    The dashboard density/drill tests also varied between the two shard runs (different subsets failed),
    which is the environmental, non-diff signature.
- Caveat: CI tests the merge ref (`HEAD^1` = base); the reproduction used the PR commit on its own
  base, `daf74eaa9`. The checked-in manifest could differ by newer-main drift, but the census test's
  placement in shard 1 was stable across both regenerations.

## VERDICT: GENUINE REGRESSION

`45a2c740f` broke `test/mutation-trigger-covers-its-own-command.test.ts` (both tests: the
"every command test file is named in scripts/mutation-relevant-paths.json" census and the "positive
control" deep-equal on the command's six-file set). The breaking line is the `commandRunner.command`
change in `stryker.conf.json` that appends `test/a-capped-pr-exhausts-repair-before-it-reaches-a-human.test.ts`
with no matching `scripts/mutation-relevant-paths.json` entry and no update to the control. It is
deterministic (red on every run), shard-specific by construction (the file lives in shard 1/4), and
not a flake; it is fixed by the PR's own second commit `000084ac9`. Not the W1-T2904 flake class.
Residual uncertainty: the CI log text was not read (see above); the claim rests on exact-selection
local reproduction plus the PR's own fix commit.

## SUCCESSOR FILING (not built here)

1. **A `stryker.conf.json` `commandRunner.command` edit is a three-file lockstep that nothing says.**
   `test/mutation-ratchet.test.ts`'s importer-sweep failure message tells the author to "add it to
   stryker.conf.json (an instrument-only PR ...)". Following that sends exactly the diff that went
   red: the census test (`test/mutation-trigger-covers-its-own-command.test.ts`) also needs
   `scripts/mutation-relevant-paths.json` extended and its hard-coded `deepEqual` control updated.
   Files: `test/mutation-ratchet.test.ts` (message), `test/mutation-trigger-covers-its-own-command.test.ts`
   (control). Mechanism: remediation message names one of three required edits. Fixture: a
   `commandRunner.command` plus one importer test absent from the relevant-paths list; assert the
   message names the relevant-paths file.
2. **The positive control pins an ordered literal list, so every legitimate command change reddens a
   shard.** The control's job is "the command must run more than classify.test.ts"; a `>= 2` floor
   with `test/classify.test.ts` present would hold that line without a third edit. Decide whether the
   exact list is deliberate R-42 evidence (then document the lockstep per item 1) or drift (then relax).
3. **Fast-lane question deliberately left open:** because three live tests read `stryker.conf.json`'s
   content, a future fast-lane skip of coverage shards for instrument-only diffs (W1-T3512's territory
   extended to `INSTRUMENT_SURFACE`) would be UNSAFE for `commandRunner.command` edits; any such
   filing must exempt them or pre-run the census test.
