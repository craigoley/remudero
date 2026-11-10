import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedLandingError, planReconcileLanding } from "#src/lib/feedback-landing.js";

/** What `gh pr create` throws on an oversized body: the command line, the body, then the cause. */
const REFUSAL = `pushed to plan-reconcile-landing-x but \`gh pr create\` failed: Command failed: gh pr create --body ${"- plan/tasks.d/W1-T1.yaml is reconciled\n".repeat(2_500)} --repo o/r pull request create failed: GraphQL: Body is too long (maximum is 65536 characters) (createPullRequest)`;

function refusedBy(error: string | undefined): Error {
  const landing = planReconcileLanding("/fixture", () => ({}), () => ({ landed: false, files: [], ...(error === undefined ? {} : { error }) }));
  try {
    landing.land([{ relPath: "plan/tasks.d/W1-T1.yaml", content: "x" }]);
  } catch (e) {
    return e as Error;
  }
  throw new Error("the landing was refused and did not throw");
}

test("W1-T11860 criterion 1: a refused landing throws at most 1,000 characters, keeping its start and its last 600", () => {
  assert.ok(REFUSAL.length > 90_000, "the fixture is the size of the real refusal");
  const thrown = refusedBy(REFUSAL);
  assert.ok(thrown.message.length <= 1_000, `message ${thrown.message.length}`);
  assert.ok(thrown.message.startsWith(REFUSAL.slice(0, 300)), "the start is kept");
  assert.ok(thrown.message.endsWith(REFUSAL.slice(-600)), "the last 600 characters are kept");
  assert.match(thrown.message, /GraphQL: Body is too long \(maximum is 65536 characters\)/, "so the cause survives");
  assert.match(thrown.message, /\[\d+ characters dropped\]/, "and it says how much it dropped");
});

test("W1-T11860 criterion 2: a short refusal is thrown unchanged and a silent one keeps the fallback sentence", () => {
  assert.equal(refusedBy("simulated landing refusal").message, "simulated landing refusal");
  assert.equal(refusedBy(undefined).message, "plan reconciliation landing did not produce a PR");
  assert.equal(boundedLandingError("x".repeat(1_000)), "x".repeat(1_000), "exactly the limit is kept whole");
});
