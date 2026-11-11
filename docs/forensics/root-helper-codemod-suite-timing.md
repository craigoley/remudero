# Root-helper codemod rule suite: measured timing (W1-T12080)

Measured 2026-11-10 on one Azure host (8 cores, load average 25-37 throughout, MemAvailable 14-16 GB), inside a
worker sandbox. Nothing under src/, test/, scripts/, .github/ or plan/ was edited. Each row was run once and none
was retried.

## Heads

- Control: `c9837b884c0f705123459cf6f5eca1bd6bea649e`, which is unchanged origin/main. It was measured in the
  run's own worktree, not a detached scratch worktree, because that worktree sits exactly on origin/main and already
  has dependencies linked.
- Candidate: `27f044d50ba0dedee510681c371750de62cf4535`. It is the head named by the preflight receipt in
  docs/forensics/a-declared-test-directory-and-the-fix-rung-scope-check.md, where `rule-checks` failed with
  ERR_SWC_NATIVE_CACHE after 761 s. The sources searched were those three forensics reports, which name the 631 s,
  761 s and 869 s `rule-checks` runs. The other two cited heads were not searched further: `18df476fa…` is a strike
  note and `5f94c7b9…` is not in the local object store. The ledger and CI logs were not searched.
- Merge base of candidate and main: `27f044d50…` itself, so the candidate is an ancestor of main.

## Nested codemod executions and tracked population

In test/every-test-finds-the-repo-root-through-one-helper.test.ts, at both heads, re-derived from the source:

- 3 spawns of `node scripts/test-repo-root-codemod.mjs` (`execFileSync(process.execPath, …)`), each with
  `timeout: 120_000`: argv `[]`, `[]`, `["--bogus"]`.
- 4 in-process full-tree parses through `analyzeSource`: `sourcesAtBase()` and `currentSources()` in each of the
  two W1-T9863 tests (3 and 4).

| head | tracked `*.test.ts` (suite filter) | `testFiles(REPO_ROOT)` | untracked under test/ | flagged |
|------|------|------|------|------|
| control c9837b884 | 4497 | 4497 | 0 | no |
| candidate 27f044d50 | 3938 | not measured (SWC missing) | 0 | no |

## Control run on unchanged main

Direct nested argv, run with GNU `/usr/bin/time` absent, so bash `time` was used (wall, user and sys including
children), under a 120 s `timeout`:

| argv | wall s | user s | sys s | exit | timeout fired | load before -> after |
|------|------|------|------|------|------|------|
| `[]` | 60.79 | 30.46 | 2.67 | 0 | no | 28.70 -> 24.54 |
| `[]` | 72.41 | 30.37 | 3.58 | 0 | no | 24.54 -> 29.52 |
| `--bogus` | 0.045 | 0.022 | 0.018 | 1 (usage error, as the test expects) | no | 29.52 -> 29.52 |

Max RSS was not captured (no GNU time). The two dry-runs used about 50% of one core (CPU/wall 0.5): the host was
CPU-contended, so wall time is inflated about 2x over CPU time. `--bogus` exits before parsing anything.

Suite file through `node --import tsx scripts/test-run.mjs --test … <file>` (the `npm test` entry):

- Test-slot wait and hold: not measurable. The runner reported `slot_unavailable` (`/tmp/rmd-test-slots: ENOENT:
  no such file or directory, mkdir '/tmp/rmd-test-slots'`) and ran unslotted at `--test-concurrency=1`. There is no
  `test_slot.acquired` row and no `heldMs`.
- Total: wall 344.5 s, user 131.8 s, sys 9.2 s (CPU/wall 0.41), exit 0, `# tests 7`, `# pass 7`, `# fail 0`.
- Load before 34.13 32.92 27.10, after 27.72 29.33 27.37. nproc 8.
- A first attempt died when its shell was backgrounded and produced no result. It is not a row.
- Per-test duration_ms: test 1 2273; test 2 8; test 3 18964; test 4 181529; test 5 2; test 6 7;
  test 7 (the CLI, three spawns) 136899.

Test 4 (`the own-folder root count never rises above the merge base`) is the largest cost at 53% of the file.
Test 7 is the next at 40%. Test 3 is 6%. The two dry-runs alone account for 133 s of test 7's 137 s.

## Candidate run

Candidate head 27f044d50 was checked out into a scratch worktree. It has no `node_modules`, and installing or
linking them was out of bounds for this task. `node scripts/test-repo-root-codemod.mjs` died at once with
`Error: Cannot find module '@swc/core'`. Neither the nested argv nor the suite file could reach the code under
test, so no wall, CPU, slot or timeout figure exists for it. The ERR_SWC_NATIVE_CACHE failure the receipt reports
was therefore neither reproduced nor refuted.

## Outcome classification: NOT_RUN, time-bound or source failure

Mapping rule: every row gets exactly one of the three classes, chosen by the first test that matches. (1) NOT_RUN if
the run never reached the code under test. (2) Otherwise time-bound if a timer or the cap stopped it. (3) Otherwise
the run finished inside its bound, so it is a source-failure-class row, and the exit code and assertions decide the
verdict. A completed run whose exit code and assertions held is classed source failure with verdict "none observed".
That label means the source-failure test was applied and found clear. It does not mean a failure happened. No row is
left without a class, and none is inferred to have passed: each verdict below rests on an observed exit code.

| row | class | verdict and evidence |
|-----|-------|------|
| Control, nested `[]` (first) | source failure (none observed) | Reached the code, finished in 60.79 s inside the 120 s timeout, exit 0. Not NOT_RUN, not time-bound. |
| Control, nested `[]` (second) | source failure (none observed) | Reached the code, finished in 72.41 s inside the 120 s timeout, exit 0. Not NOT_RUN, not time-bound. |
| Control, nested `--bogus` | source failure (none observed) | Reached the code, finished in 0.045 s, exit 1, which is the usage error the test asserts. Nothing failed. |
| Control, suite file | source failure (none observed) | Reached the code, finished in 344.5 s with no timer firing, exit 0, `# pass 7`, `# fail 0`. Control has no assertion failure, so there is nothing to call inherited. |
| Control, test-slot wait and hold | NOT_RUN | Reason verbatim: `/tmp/rmd-test-slots: ENOENT: no such file or directory, mkdir '/tmp/rmd-test-slots'` (`slot_unavailable`). This covers only the slot figures; the suite row above still ran, unslotted. |
| Candidate, nested `[]` x2 and `--bogus` | NOT_RUN | Reason verbatim: `Error: Cannot find module '@swc/core'` (no node_modules in the scratch worktree). |
| Candidate, suite file | NOT_RUN | Same reason: `Cannot find module '@swc/core'`. |

## Reading against the falsifier

On the control each dry-run finished well inside its 120 s timeout and the suite ran 344 s unslotted at a host load
of about 3.5x core count. The suite is therefore CPU-heavy but not broken at current main. A 631-869 s `rule-checks`
wall is not explained by this file alone: the suite is about 40-55% of that under load, and the rest belongs to
other suites, host load or slot wait. The candidate head could not be measured, so the receipt's SWC failure remains
unexplained here. The control and candidate rows are not compared.
