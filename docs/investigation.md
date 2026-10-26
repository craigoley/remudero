# Duplicate-key shard bypass of lint-plan

Root cause identified: independently valid plan edits merged into duplicate YAML keys after their checks ran.

Investigation for W1-T9378, verified on 2026-10-26 against checkout
`550128607f3bd5c860e0dcaa25c06ac3e84b8605`. The task record declares this document
and asks for the root cause; it does not authorize a linter or merge-policy change. Its
rationale cites PR #8886 and the `every-shard-on-main-is-lintable` ratchet, without any
file:line citations. The ratchet still exists in this checkout. Before this change,
`docs/investigation.md` was absent both locally and from GitHub's main branch, so the
task's grep proof could not already pass.

## Historical evidence

The malformed shard was `plan/tasks.d/w1-t5431-selector-shadow-miss.yaml`.
GitHub's PR API reports both contributing PRs as merged, with the same base commit
`a92ce44653eb9201ba6a1003c03c6e09a18a61bd`:

| PR | Edit to W1-T5431 | Merge time on 2026-10-03 (UTC) | Merge commit |
| --- | --- | --- | --- |
| [#8872](https://github.com/craigoley/remudero/pull/8872) | Gardener adds `priority: 4` after `risk: low` | 09:13:36 | `48dc661681aa5b052101b90068621de775f6b1af` |
| [#8871](https://github.com/craigoley/remudero/pull/8871) | Judge changes `verify: human` to `auto`, adds `priority: 2.5` before `risk: low`, and adds a ruling | 09:14:04 | `231b7673bc3caf103e1118edf51eb9a03eaf0a3a` |

The additions occupy different textual positions. Git accepted their combination even
though both additions belong to the same YAML mapping. The
[stored shard at the second merge](https://github.com/craigoley/remudero/blob/231b7673bc3caf103e1118edf51eb9a03eaf0a3a/plan/tasks.d/w1-t5431-selector-shadow-miss.yaml)
contains `priority: 2.5` at line 7 and `priority: 4` at line 9.

Both PRs have successful CI runs associated with their checked heads:

| PR | Checked head | CI run | Observed steps in `commitlint` |
| --- | --- | --- | --- |
| #8871 | `ea03a18ddc440a4084167a09f72283d0a4762760` | [37111228576](https://github.com/craigoley/remudero/actions/runs/37111228576) | `rule-checks population` and `lint-plan` both success |
| #8872 | `d292a389f780b927eeece5cabaa8c789be83e23c` | [37111445927](https://github.com/craigoley/remudero/actions/runs/37111445927) | `rule-checks population` and `lint-plan` both success |

These are job/step API results, rather than an inference from a green aggregate.
The historical workflow runs the real lint as a step of `commitlint`; the separately
named `lint-plan` job is permanently skipped. That placeholder is not evidence that
the actual lint was skipped. See the
[workflow at the common base](https://github.com/craigoley/remudero/blob/a92ce44653eb9201ba6a1003c03c6e09a18a61bd/.github/workflows/ci.yml),
whose lint step invokes `npm run --silent lint-plan -- --base HEAD^1`.

[PR #8877](https://github.com/craigoley/remudero/pull/8877) reports the resulting
`PlanError: Map keys must be unique` and daemon crash loop. It removes the gardener's
priority and comment, preserving the judge's priority and ruling. GitHub records its
repair merge as `f267479ffc28a406e983753d55f993537f7e0df0` at 14:50:41 UTC.
The incident therefore predates its repair; the duplicate's absence today does not
disprove the original report.

[PR #8886](https://github.com/craigoley/remudero/pull/8886) is an analytics cash-accounting
change. Its diff does not introduce this shard defect. The task's citation is a
follow-up context link; the shard blobs, contributing PRs and repair above establish
the cause independently.

## Why the ratchet did not prevent the merge

The [historical parser](https://github.com/craigoley/remudero/blob/a92ce44653eb9201ba6a1003c03c6e09a18a61bd/src/lib/plan.ts)
already calls `parseYaml(text)` in `parseTasksFromYaml` and wraps parsing errors in
`PlanError`. The installed `yaml` parser rejects duplicate mapping keys by default.
Replaying the historical bad blob through both `yaml.parse` with no options and the
current repository parser raises `Map keys must be unique`. Removing either priority
line makes the YAML parse, a positive control for the duplicate-key diagnosis.

The [historical ratchet](https://github.com/craigoley/remudero/blob/a92ce44653eb9201ba6a1003c03c6e09a18a61bd/test/every-shard-on-main-is-lintable.test.ts)
calls `loadPlan` before calculating lint violations or consulting its debt baseline.
A duplicate key in the tree it examines would throw at that load. It is not excused
by the lint-debt baseline, and an unchanged shard is not omitted from this scan.
The current `lintPlanCommand` likewise loads the checkout's whole plan before
deriving the changed-task lint scope.

The failure was the validity of the combined landing tree after main advanced.
Each branch supplied only one priority key when checked. Successful checks of those
earlier trees did not establish that their later composition would parse. The actual
second merge blob proves the composition was invalid; the repair PR and current
merge-preflight comments identify the behind-branch landing race. This conclusion
does not require claiming that CI always checks only the branch head: even a PR's
synthetic merge ref is evidence for its then-current base, not for a later base.

Duplicate YAML keys within one mapping also differ from duplicate task IDs across
shards. The former fail during YAML parsing; `loadPlan` separately rejects colliding
task IDs while combining records. A new key detector alone would not fix this race:
it must examine the combined tree that is about to land.

## Current controls and reproduction

The checkout's existing tests pass for both clean plan data and the unhealthy arm:

- `test/no-plan-shard-carries-a-duplicate-key.test.ts` parses the current shard
  population with `uniqueKeys: true` and reports no malformed shards.
- `test/every-plan-shard-parses-with-unique-keys.test.ts` tests the current plan and
  fixtures containing duplicate priority, risk and files keys. Its scanner carries
  the failing path and parser diagnostic.
- `test/a-behind-plan-pr-merges-when-its-merged-plan-is-safe.test.ts` includes
  `the real reader merges the PR head into main with git and loads the merged plan`.
  It reproduces the competing-priority shape and observes a quarantined merged plan.
  Its decision test requires an unsafe overlapping plan PR to refresh rather than merge.

Run these existing suites in one invocation:

```sh
node --test --test-reporter=tap --import tsx --import ./test/setup/tmp-hygiene.ts \
  test/no-plan-shard-carries-a-duplicate-key.test.ts \
  test/every-plan-shard-parses-with-unique-keys.test.ts \
  test/a-behind-plan-pr-merges-when-its-merged-plan-is-safe.test.ts
```

The investigation run passed all 15 tests with zero failures. Current production
controls are `readPlanMergeSafetySteps` and `decidePlanPrMergeSafety` in
`src/lib/plan-pr-merge-safety.ts`, wired through `src/lib/arm-auto-merge.ts`.
They inspect the merged plan for behind plan PRs, and unsafe or unreadable results
refresh or escalate. The plan-touching arm path also avoids enabling auto-merge,
whose later execution could otherwise outlive the checked base. These are existing
controls, not changes made by this investigation; their tests do not constitute an
audit of every historical or live merge route.

Acceptance proof for this document:

```sh
grep -arn -- 'Root cause identified' docs/investigation.md
```
