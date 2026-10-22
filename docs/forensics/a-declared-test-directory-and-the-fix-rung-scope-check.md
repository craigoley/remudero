# A declared test directory and the fix rung's scope check

The fix rung refuses a newly added child of `test/` even though its caller explicitly
adds that directory to the comparison list and its commit helper permits test edits.
The code defect is confirmed; the fleet recurrence count is not measured in this session.

This W1-T10333 investigation reads source at
`27f044d50ba0dedee510681c371750de62cf4535` on 2026-10-22. The session branch and local
`origin/main` both pointed to that SHA before edits. The task record cites symbols rather
than file:line coordinates; all its cited scope symbols still exist. The apparent second
`scopeGuardOutOfScopeFiles` definition in `src/run-task.ts` is inside a compatibility
comment. The executable implementation is in `src/lib/prompt-render.ts`.

Before editing, all three acceptance grep invocations failed because this document was
absent. A GitHub contents read also returned 404 for this path on `main`, while the same
API successfully returned the task record. The merged-PR search for W1-T10333 returned
the task-filing PR #13400, whose body explicitly says it carries no task trailer; it is
not evidence that this investigation already shipped.

## Where the entry came from

**READ, current source:** W1-T10070's task shard declares exactly these three paths:

```text
src/lib/proof-amendment.ts
src/run-task.ts
test/a-build-that-needs-scope-before-its-pr-gets-it.test.ts
```

`runFixRung` in `src/run-task.ts` computes:

```ts
const admitFixTests = !(opts.task.files?.length && opts.task.files.every(isInPlanScope));
```

Its pre-strike call to `fixRungScopeStandDownReason` passes:

```ts
admitFixTests && opts.task.files ? [...opts.task.files, "test/"] : opts.task.files
```

Thus `test/` is minted by the fix rung for this comparison, without mutating the task
record. W1-T10070's declarations are non-plan paths, so that branch appends the fourth
entry. `fixRungScopeStandDownReason` prints the received `declaredFiles`, whereas reachable
gate-remedy paths are added separately to `effectiveDeclaredFiles`. A remedy widening is
therefore not needed to explain the printed `test/`.

**READ, introduction:** [PR #9066's merge commit](https://github.com/craigoley/remudero/commit/20b2507a35e2cd8b34668c4c5033dbd99e04441c),
`20b2507a35e2cd8b34668c4c5033dbd99e04441c`, dated 2026-10-04T13:03:21Z, introduces both
the appended entry and `admitFixTests`. Its `renderFixPrompt` change grants non-plan tasks
permission to add or edit undeclared files under `test/`. The same commit passes test
admission to the harness commit helper. This is the W1-T5532 policy change, not a directory
declaration newly added to W1-T10070's shard.

**OBSERVED, independent incident artifact:** a GitHub issue read found
[#13143](https://github.com/craigoley/remudero/issues/13143), created
2026-10-20T14:48:54Z. Its body names W1-T10070, daemon run `DAEMON-1792491911672`,
head `18df476fa2c69fde8ef6c03e4f8d7db6a3f46d79`, strike 2 and the refused path
`test/a-build-that-imports-a-left-out-file-asks-for-scope.test.ts`. Its printed declared
list is the three paths above followed by `test/`. The recommendation is `revert`.
The API reports the issue closed at 2026-10-21T04:34:46Z; that state does not establish
whether the code defect was repaired.

**REPORTED, ledger row; not independently reread:** W1-T10333's rationale records
`2026-10-20T14:48:54.897Z`, step `fix.stood_down`, site `rung.scope`, strike 2,
task W1-T10070, `scope_kind: files`, and `out_of_scope_paths` containing the same test
path. Current `runFixRung` emits these fields after the scope escalation. The issue
corroborates the refusal and the source explains its list, but neither supplies the
original ledger bytes or proves the daemon's complete deployed source revision.

The requested counting window starts at 2026-10-14T00:00:00Z. No ledger corpus was opened:
this session's permission profile denies `/home/node/Remudero/state`, and no permitted
ledger export is provided. Consequently the corpus's newest timestamp, coverage of that
window, and the required positive control locating the 14:48:54.897Z row are **unverified**.
The filing PR reports a different reader's corpus (67 rotations from October 18 plus the
live file, newest row October 21 at 10:31Z); that is attributed historical evidence, not
this session's measurement and not proof of coverage back to October 14.

## Which reading is right

**CONFIRM the code defect:** the same received list admits the incident path in the
commit surface and flight signal but refuses it in the fix guard. The appended entry
implements an explicit test-edit permission, so this particular refusal contradicts the
fix rung's own policy. This does not mean that every scope consumer accepts directories.

The predicate census used searches for `task.files`, `taskDeclaredFiles`, `declaredFiles`,
`declaredPaths`, `declared.has`, `pathIsUnderDeclaredSurface`, and their callers throughout
`src/`, then read the implementations. The following comparisons have distinct jobs:

| Symbol and source | Reading of a trailing-slash entry |
| --- | --- |
| `scopeGuardOutOfScopeFiles`, `src/lib/prompt-render.ts` | Exact `declared.has(f)`. `test/` does not admit its child. Separately exempts registered artifacts, companion ledgers and eligible additive registrations. An absent declaration refuses every nonempty diff. |
| `outOfDeclaredScopeFiles`, same file | Delegates to that exact predicate in the files regime; to `outOfPlanScopeFiles` in the plan regime. An absent declaration returns no offenders. |
| `fixScopeRegime` / `isPlanFilingBaseline`, same file | Select plan scope for wholly plan-scoped declarations or a nonempty wholly plan-scoped baseline. A `test/` declaration does not make a task plan-scoped. |
| `fixRungScopeStandDownReason`, `src/run-task.ts` | Applies the selected reading to current and baseline lists and subtracts inherited offenders. Only newly out-of-scope paths stand down. Reachable remedies widen only the effective files comparison. |
| `pathIsUnderDeclaredSurface`, same file | Removes a final slash and accepts equality or `d + '/'` prefix. `test/` admits the incident child, but not `test-other/escape.ts`. Also accepts a directory without its final slash. |
| `commitWorkerEdits`, same file | Uses `pathIsUnderDeclaredSurface`; additionally admits files beneath `test/` when `options.admitTests` is true, with a `..` segment check. `runFixRung` supplies `admitFixTests` to this option. |
| `missingCommitLinePrompt`, same file | Uses `pathIsUnderDeclaredSurface` to filter the untracked paths shown to the resumed writer. |
| `inScope` / `scopeDriftPredicate`, `src/lib/flight-signals.ts` | Equality or a slash-delimited prefix, adding the slash if absent. `test/` admits the child. Empty declarations do not trip scope drift. |
| `scopeViolationFiles` / `reviewScopeContext`, `src/lib/review.ts` | Exact membership, with artifact exemptions; the advisory caller can additionally exempt admitted new proof tests. A directory child can be reported as widening. This advisory alone does not refuse the review. |
| `inverseScopeUntouchedFiles` / `diffEmptyAgainstScope`, same file | Exact declared-to-touched membership. Touching a child does not count as touching literal `test/`. These answer completion/empty-diff questions, not write permission. |
| `unresolvedTaskScopeOverlaps`, same file | Exact intersections with other tasks' declarations, only when this PR has no resolved task. Does not expand directories. |
| `proofScopeViolations`, `src/lib/task-linter.ts` | Exact membership of a proof's named path; a proof naming a child is outside literal `test/`. Can block an absent proof target for an auto-verified task. |
| `trailerScopeMismatch`, `src/run-task.ts` | Exact intersection of changed and declared paths; a child alone does not corroborate a directory entry. Advisory only. |
| `runFixRung` scope-amendment recovery | `declaredFiles.includes(path)` requires each recovered path literally in the refreshed contract. A directory prefix is insufficient. |
| `uncreditedBuildWarning`, `src/lib/status.ts` | Equality or directory-prefix overlap; `test/` covers a child when corroborating another task's build. |
| `openSiblingBuild` / `isDeclaredPlanDelivery`, same file | Exact membership; no directory expansion. The latter applies only to plan declarations. |
| `globsIntersect` / `overlappingPaths` / `overrunFiles` / `rareOverlapWarnings`, `src/lib/dispatch-overlap.ts` | Literal normalized equality unless a wildcard occurs. `test/` does not intersect a child; `test/**` does. Dispatch collision checks are not the commit helper's directory predicate. |
| `declaredFilesAbsentFromChange`, `src/lib/risk-judge.ts` | Exact declared-to-touched membership, skipped for absent or truncated change views. A child does not discharge literal `test/`. |
| `isInPlanScope` / `outOfPlanScopeFiles`, `src/lib/plan-scope.ts` | Separate fixed plan namespace, independent of task directory entries; the incident test is outside it. |

Other consumers select tasks, validate the presence or shape of declarations, retrieve
knowledge, or check individual required paths; they do not grant directory write access.
In particular, `declaredScopeViolation` checks whether scope exists, and
`requiredCompanions` checks imports from left-out files rather than interpreting a declared
directory. A universal directory-semantics rewrite would therefore reach much further
than the incident's fix-rung contradiction.

**Runtime replay at the source SHA above:** four temporary in-process `node:test` checks
passed against the actual exports, without editing source or dispatching workers:

1. With the three original paths as baseline and the incident test added to the current
   diff, passing those declarations plus `test/` returns `scopeKind: files` and exactly
   the incident test in `newOutOfScopePaths`. The direct guard returns that path too.
2. `pathIsUnderDeclaredSurface` returns true for the same list/path, and
   `scopeDriftPredicate` returns `tripped: false` for a snapshot touching it.
3. Explicitly declaring the test, or including it in the inherited baseline, suppresses
   stand-down. `test-other/escape.ts` remains outside the directory surface and an unrelated
   source path remains an offender.
4. Plan scope still rejects a test; `globsIntersect('test/', path)` is false while
   `globsIntersect('test/**', path)` is true.

For a minimal independent replay from the checkout:

```sh
node --import tsx --input-type=module - --repo-root "$PWD" <<'JS'
import assert from 'node:assert/strict';
import { fixRungScopeStandDownReason, pathIsUnderDeclaredSurface } from '#src/run-task.js';
import { scopeDriftPredicate } from '#src/lib/flight-signals.js';
const baseline = [
  'src/lib/proof-amendment.ts', 'src/run-task.ts',
  'test/a-build-that-needs-scope-before-its-pr-gets-it.test.ts',
];
const path = 'test/a-build-that-imports-a-left-out-file-asks-for-scope.test.ts';
const declared = [...baseline, 'test/'];
const refusal = fixRungScopeStandDownReason([...baseline, path], baseline, declared);
assert.deepEqual(refusal?.newOutOfScopePaths, [path]);
assert.equal(refusal?.scopeKind, 'files');
assert.equal(pathIsUnderDeclaredSurface(path, declared), true);
assert.equal(pathIsUnderDeclaredSurface('test-other/escape.ts', declared), false);
assert.equal(fixRungScopeStandDownReason([...baseline, path], baseline, [...baseline, path]), undefined);
assert.equal(fixRungScopeStandDownReason([...baseline, path], [...baseline, path], declared), undefined);
const unrelated = 'src/lib/outside-declared-scope.ts';
assert.deepEqual(
  fixRungScopeStandDownReason([...baseline, unrelated], baseline, declared)?.newOutOfScopePaths,
  [unrelated],
);
const plan = ['plan/tasks.d/example.yaml'];
assert.equal(fixRungScopeStandDownReason([...plan, path], plan, plan)?.scopeKind, 'plan');
const snapshot = {
  turn: 1, toolCalls: [], cumulativeDiffLines: 1, filesTouched: [path],
  errorSignatures: [], cumulativeCostUsd: 0, elapsedMs: 0,
};
assert.equal(scopeDriftPredicate([snapshot], {
  burnRateBaselineUsdPerTurn: 1, declaredFiles: declared,
}).tripped, false);
console.log('incident predicate disagreement reproduced');
JS
```

This is an incident-shaped predicate replay, not a reconstruction of every live input:
the ledger did not supply the full baseline or current diff to this session.

**Count since October 14: UNKNOWN, not zero.** One incident is independently corroborated
by issue #13143; one is not a measured fleet count. To measure the requested population,
an authorized reader must open the union of gz rotations, plain rotations and the live
ledger, report file counts per form and the newest timestamp, and find the exact
14:48:54.897Z row as a positive control. Select `fix.stood_down` rows at `rung.scope` since
2026-10-14T00:00:00Z; parse their printed declared lists and count rows where any
trailing-slash declaration prefixes any `out_of_scope_paths` member. Report the deduplication
key and unreadable/malformed rows. Count rows, not paths, PRs or repeated issue comments.
If the retained corpus starts after October 14, label the result a partial-window count.

## Remedy proposal

Preserve the W1-T5532 permission and use one shared directory-aware membership predicate
for the files-regime guard and commit helper. Preserve artifact, companion-ledger,
registration, reachable-remedy and inherited-baseline handling, and the separate plan
regime. Extracting `pathIsUnderDeclaredSurface` to a leaf module would avoid importing the
CLI into `prompt-render.ts`. Review advisory, inverse-completion and dispatch-glob
semantics require their own policy decisions; this diagnosis does not authorize changing
all of them merely because they read declarations.

The alternative is removing the minted directory entry and withdrawing the test-edit
permission consistently from the prompt and commit helper. Removing only the entry would
retain the false refusal while concealing the contradictory grant; making only the prompt
stricter would leave the existing commit permission. The introduction commit supports
preserving that permission as the smaller policy change.

The proposed implement task's falsifier should use W1-T10070's three declarations, the
appended `test/`, and the incident test from the replay above. Before that fix, the newly
added child stands down; after it, it must not. Also drive the next `runFixRung` strike
after an admitted test edit so the caller's minted entry and baseline subtraction are
exercised together. Controls must still refuse an unrelated `src/` path and a sibling
`test-other/` path, keep plan-only repairs plan-scoped, and tolerate inherited offenders.
Delete the fix and rerun to prove the new regression test fails, then restore it and
require a passing summary.

No implement task was filed here: this task declares only this forensic document, and
filing must occur from an operator checkout. The separate filing and the missing ledger
measurement remain explicit handoffs in the worker report. This change makes no scope,
stand-down or escalation behavior changes. The required heading grep proofs establish
document structure; they do not turn the missing ledger evidence into a satisfied claim.

## Validation on retry

On 2026-10-22, the documented replay was rerun successfully with explicit controls for a
sibling directory, an explicitly declared test, an inherited offender, an unrelated source
file and plan scope. `npm run --silent typecheck` passed, as did the typecheck step in
`bin/rmd preflight --fast`; the harness-reported typecheck failure did not recur. No compiler
diagnostic from that earlier failure was supplied, so its cause remains unknown.

The full fast preflight exited 1 after 761 seconds: 26 steps passed and two failed,
`rule-checks` and `no-shallowing-census`. The failing suites were
`test/every-test-finds-the-repo-root-through-one-helper.test.ts` and
`test/no-shallowing-of-the-canonical-checkout.test.ts`. Both failed while loading SWC's
native addon with `ERR_SWC_NATIVE_CACHE`: the loader rejected the sandbox cache's parent
permissions. Selecting a private custom cache reproduced that error. This is a validation
limit, not a passing preflight or evidence against the scope-predicate replay.

The preflight receipt names head `27f044d50ba0dedee510681c371750de62cf4535`, comparison base
`1bfbbfb32d3484dba2ef5ccaba634c387ac427dc`, and a behind-count of 4. The heading proofs,
docs-index check, comment-load signal and source-size ratchet passed. No TypeScript source,
gate or baseline was changed to obtain those results.
