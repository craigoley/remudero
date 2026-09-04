/**
 * test/a-growing-task-cannot-record-its-own-ceiling.test.ts — W1-T2650.
 *
 * THE DEFECT. `scripts/source-size-ratchet.mjs` prints the exact remedy for a breach it caused —
 * `edit scripts/source-size-baseline.json and set: "<path>": <bucket>,` — and says doing so in the
 * SAME PR that caused the growth is the ordinary, safe outcome. But `scripts/source-size-
 * baseline.json` is in no task's declared `files:`, and BOTH scope checks treat that as a refusal:
 *   - `scopeGuardOutOfScopeFiles` (src/run-task.ts) flags the push, and `fixRungScopeStandDownReason`
 *     (the SAME function, via `outOfDeclaredScopeFiles`) stands the fix rung down rather than
 *     dispatch the very edit the ratchet just demanded.
 *   - `scopeViolationFiles` (src/lib/review.ts, reached through `judgeReview`'s `unwiredAdvisories`)
 *     flags the same path at review time.
 * A task that legitimately grows a source file had no declared-scope path to record its own
 * ceiling; its only outs were a scope amendment or a deferred follow-up — and a deferred baseline
 * number has a shelf life measured in hours (this task's own rationale, the W1-T2516 follow-up
 * that went stale in under a day while a sibling task concurrently rewrote the same entries).
 *
 * THE FIX. `SCOPE_EXEMPT_GENERATED_ARTIFACTS` (src/lib/review.ts) is ONE enumerated,
 * hand-written set — `scripts/source-size-baseline.json` today, nothing else — that BOTH
 * `scopeGuardOutOfScopeFiles` and `scopeViolationFiles` subtract before deciding what is
 * out-of-scope. Same set, same result on both sides: a PR admitted by one is never refused by the
 * other. Every path outside the set is refused exactly as before, and an empty/absent declared
 * scope still refuses every non-empty diff — this is an enumerated admission, not a pattern and
 * not a relaxation of either guard's fail-closed direction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixRungScopeStandDownReason,
  outOfDeclaredScopeFiles,
  scopeGuardOutOfScopeFiles,
} from "../src/run-task.js";
import { judgeReview, SCOPE_EXEMPT_GENERATED_ARTIFACTS } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

const EXEMPT_PATH = "scripts/source-size-baseline.json";

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

function diffFor(files: readonly string[]): string {
  return files
    .map(
      (f) => `diff --git a/${f} b/${f}
+++ b/${f}
@@
+touched`,
    )
    .join("\n");
}

// ── ACCEPTANCE #1 — the growing task records its own ceiling ──────────────────────────────────

test("acceptance 1: scopeGuardOutOfScopeFiles admits the size baseline alongside a task's own declared files", () => {
  const declared = ["src/lib/worker.ts", "test/worker.test.ts"];
  const diff = [...declared, EXEMPT_PATH];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), []);
});

test("acceptance 1: fixRungScopeStandDownReason no longer stands the rung down over the size baseline", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, EXEMPT_PATH];
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared), undefined);
});

test("acceptance 1: the reviewer's scope_violation advisory never fires on the size baseline alongside declared files", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = diffFor([...declared, EXEMPT_PATH]);
  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declared });
  assert.equal(v.state, "success");
  const advisory = v.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation");
  assert.equal(advisory, undefined, "no scope_violation advisory should name the exempt baseline path");
});

// ── ACCEPTANCE #2 — THE FALSIFIER: the guard never widens beyond the enumerated set ────────────

test("acceptance 2 (falsifier): a non-exempt out-of-scope path is still refused exactly as today", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, "src/lib/rogue.ts", EXEMPT_PATH];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), ["src/lib/rogue.ts"]);
});

test("acceptance 2 (falsifier): a non-exempt path still stands the fix rung down, distinct from the exempt one", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, "src/lib/rogue.ts", EXEMPT_PATH];
  const got = fixRungScopeStandDownReason(current, baseline, declared);
  assert.ok(got, "a genuinely out-of-scope new path must still stand the rung down");
  assert.deepEqual(got?.newOutOfScopePaths, ["src/lib/rogue.ts"]);
});

test("acceptance 2 (falsifier): the reviewer still flags a non-exempt path even beside the exempt one", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = diffFor([...declared, "src/lib/rogue.ts", EXEMPT_PATH]);
  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declared });
  const advisory = v.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation");
  assert.ok(advisory, "the non-exempt path must still be flagged");
  assert.deepEqual(advisory?.symbols, ["src/lib/rogue.ts"]);
});

test("acceptance 2 (falsifier): an empty/absent declared scope still refuses every non-empty diff, exempt path included", () => {
  assert.deepEqual(scopeGuardOutOfScopeFiles([EXEMPT_PATH], undefined), [EXEMPT_PATH]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([EXEMPT_PATH], []), [EXEMPT_PATH]);
});

// ── ACCEPTANCE #3 — SAME SET, BOTH SIDES ────────────────────────────────────────────────────────

test("acceptance 3: scopeGuardOutOfScopeFiles and outOfDeclaredScopeFiles agree with the reviewer on the exempt set membership", () => {
  assert.ok(SCOPE_EXEMPT_GENERATED_ARTIFACTS.has(EXEMPT_PATH));

  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, EXEMPT_PATH];
  // The push/fix-rung guard (run-task.ts) and the non-plan-only branch of outOfDeclaredScopeFiles
  // (which fixRungScopeStandDownReason itself calls) both resolve to the same empty result — one
  // enumerated set, consulted identically on both sides of the invariant this task restores.
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), []);
  assert.deepEqual(outOfDeclaredScopeFiles(diff, declared), []);
});

test("acceptance 3: a PR admitted by the push/fix-rung guard is never refused by the reviewer for the same diff", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, EXEMPT_PATH];

  const pushAdmits = scopeGuardOutOfScopeFiles(diff, declared).length === 0;
  assert.ok(pushAdmits, "push/fix-rung guard must admit this diff");

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: diffFor(diff),
    report: SIMPLE_REPORT,
    taskDeclaredFiles: declared,
  });
  const reviewerRefuses = (v.unwiredAdvisories ?? []).some((a) => a.reasonCode === "scope_violation");
  assert.equal(reviewerRefuses, false, "reviewer must not flag scope_violation for the same diff the push guard admitted");
});
