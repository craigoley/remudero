import assert from "node:assert/strict";
import test from "node:test";

import { fixHeadAcceptable, fixOwnershipIdFor, uncreditableHeadReason } from "#src/lib/sweep.js";

// #15232 (2026-10-29): an ad-hoc PR on `run-unfiled-1793203702000` carries `Remudero-Task: PR-15232`, so its synthetic
// task id is PR-15232. The fix lane read the run-shaped head as a claim on another task and refused it as
// `foreign_run_branch` on every pass (repeat_streak 69), while the judge kept answering "continue". Nothing
// repaired it and nothing escalated it.
const HEAD = "run-unfiled-1793203702000";

test("#15232: a run-unfiled head is fixable for its synthetic PR, whether the sweep keys it PR-<n> or unfiled", () => {
  for (const prTaskId of ["PR-15232", "unfiled", undefined]) {
    const id = fixOwnershipIdFor(prTaskId, "PR-15232");
    assert.equal(fixHeadAcceptable(HEAD, id, true), true, String(prTaskId));
    assert.notEqual(uncreditableHeadReason(HEAD, id, true), "foreign_run_branch", String(prTaskId));
  }
});

test("#15232: a run branch that names a real task, or a plan task's foreign head, is still refused", () => {
  assert.equal(fixHeadAcceptable("run-W1-T123-1785600000000", "PR-15232", true), false);
  assert.equal(uncreditableHeadReason("run-W1-T123-1785600000000", "PR-15232", true), "foreign_run_branch");
  assert.equal(fixHeadAcceptable(HEAD, "W1-T123", false), false, "a plan task must amend its own run branch");
});
