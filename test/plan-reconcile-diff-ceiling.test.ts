import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_RECONCILE_REVIEW_FILE_CEILING, renderPlanReconcile } from "../src/run-task.js";

const skipped = {
  "not-credited-merged": 0,
  "status-not-queued": 0,
  retired: 0,
  "no-status-field": 0,
  "credit-unreadable": 0,
} as const;

test("W1-T3761: an over-ceiling reconcile does not prescribe one PR", () => {
  const summary = {
    rewritten: Array.from({ length: PLAN_RECONCILE_REVIEW_FILE_CEILING + 1 }, (_, i) => `W1-T${i + 1}`),
    skipped,
  };
  const rendered = renderPlanReconcile(summary, false);

  assert.match(rendered, /exceed GitHub's 300-file diff limit/);
  assert.match(rendered, /split the changes across multiple plan-only PRs/);
  assert.doesNotMatch(rendered, /land the diff as one plan-only PR/);
});

test("W1-T3761: an under-ceiling reconcile keeps today's instruction", () => {
  const summary = {
    rewritten: Array.from({ length: PLAN_RECONCILE_REVIEW_FILE_CEILING }, (_, i) => `W1-T${i + 1}`),
    skipped,
  };
  const rendered = renderPlanReconcile(summary, false);

  assert.match(rendered, /re-run with --write to apply, then land the diff as one plan-only PR/);
  assert.doesNotMatch(rendered, /exceed GitHub's 300-file diff limit/);
});
