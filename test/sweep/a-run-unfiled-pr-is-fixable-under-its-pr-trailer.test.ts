import assert from "node:assert/strict";
import test from "node:test";

import { fixOwnershipIdFor, uncreditableHeadReason } from "#src/lib/sweep.js";

// #15232 (2026-10-29): an ad-hoc PR on `run-unfiled-1793203702000` carries `Remudero-Task: PR-15232`, so its synthetic
// task id is PR-15232. The fix lane read the run-shaped head as a claim on another task and refused it as
// `foreign_run_branch` on every pass (repeat_streak 69), while the judge kept answering "continue". Nothing
// repaired it and nothing escalated it. `uncreditableHeadReason` reads "unclassified" exactly when the head is
// acceptable, so it carries both verdicts here.
const HEAD = "run-unfiled-1793203702000";

test("#15232: a run-unfiled head is fixable for its synthetic PR, whether the sweep keys it PR-<n> or unfiled", () => {
  for (const prTaskId of ["PR-15232", "unfiled", undefined]) {
    const id = fixOwnershipIdFor(prTaskId, "PR-15232");
    assert.equal(uncreditableHeadReason(HEAD, id, true), "unclassified", String(prTaskId));
  }
});

test("#15232: a run branch that names a real task, or a plan task's foreign head, is still refused", () => {
  assert.equal(uncreditableHeadReason("run-W1-T123-1785600000000", "PR-15232", true), "foreign_run_branch");
  assert.equal(uncreditableHeadReason(HEAD, "W1-T123", false), "foreign_run_branch", "a plan task must amend its own run branch");
});
