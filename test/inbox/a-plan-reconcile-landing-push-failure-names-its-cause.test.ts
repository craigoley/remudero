import assert from "node:assert/strict";
import { test } from "node:test";
import { pushFailure } from "#src/lib/feedback-landing.js";

/**
 * W1-T15032. Five cadence runs (2026-11-22 to 11-23) failed with only "nothing was re-derived: ops-status-source-moved":
 * the landing threw that message with a `cause` naming the paths that moved, and the failure text dropped the cause.
 */

const BRANCH = "plan-reconcile-landing-craigoley-remudero-ops-measurement-cadence-08879dd553d0";

test("W1-T15032 criterion 1: the failure text carries the cause chain", () => {
  const root = new Error("changed since the pin: plan/tasks.d/W1-T1-a.yaml");
  const middle = new Error("ops catalog read moved", { cause: root });
  const text = pushFailure(BRANCH, new Error("ops-status-source-moved", { cause: middle }));
  assert.equal(text, `${BRANCH} was not pushed, and no lease was lost, so nothing was re-derived: ` +
    "ops-status-source-moved: caused by ops catalog read moved: caused by changed since the pin: plan/tasks.d/W1-T1-a.yaml",
    "THE CLAIM: the message and every cause in its chain");
});

test("a failure with no cause, a non-Error cause and a cyclic chain each read in full and end", () => {
  assert.match(pushFailure(BRANCH, new Error("rejected")), /re-derived: rejected$/);
  assert.match(pushFailure(BRANCH, new Error("rejected", { cause: "a string reason" })), /re-derived: rejected: caused by a string reason$/);
  assert.match(pushFailure(BRANCH, "bare text"), /re-derived: bare text$/);
  const cyclic = new Error("loop") as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  assert.match(pushFailure(BRANCH, cyclic), /re-derived: loop$/);
});
