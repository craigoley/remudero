import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checksStateFromRollup, type RollupCheckEntry } from "#src/lib/sweep.js";

const run = (name: string, conclusion: string, completedAt = "2026-11-09T10:00:00Z"): RollupCheckEntry =>
  ({ name, status: "COMPLETED", conclusion, completedAt }) as RollupCheckEntry;
const pendingRun = (name: string): RollupCheckEntry =>
  ({ name, status: "IN_PROGRESS", conclusion: "" }) as RollupCheckEntry;
const status = (context: string, state: string): RollupCheckEntry => ({ context, state }) as RollupCheckEntry;

const REVIEW = "remudero-review";
const greenRollup = [run("ci-gate", "SUCCESS"), run("quality", "SUCCESS"), status(REVIEW, "FAILURE")];

test("W1-T11865 criterion 1: a review-only required set reads green when every non-review check passes", () => {
  assert.equal(checksStateFromRollup(greenRollup, [REVIEW]), "green");
});

test("W1-T11865 criterion 1: a review-only required set reads red on one failing non-review check", () => {
  const rollup = [run("ci-gate", "SUCCESS"), run("quality", "FAILURE"), status(REVIEW, "SUCCESS")];
  assert.equal(checksStateFromRollup(rollup, [REVIEW]), "red");
});

test("W1-T11865 criterion 1: a review-only required set reads pending on one pending non-review check", () => {
  const rollup = [run("ci-gate", "SUCCESS"), pendingRun("quality"), status(REVIEW, "SUCCESS")];
  assert.equal(checksStateFromRollup(rollup, [REVIEW]), "pending");
});

test("W1-T11865 criterion 1: a rollup holding only the review reads none", () => {
  assert.equal(checksStateFromRollup([status(REVIEW, "SUCCESS")], [REVIEW]), "none");
});

test("W1-T11865 criterion 2: a mixed set with the other context absent reads pending", () => {
  assert.equal(checksStateFromRollup([run("quality", "SUCCESS"), status(REVIEW, "SUCCESS")], [REVIEW, "ci-gate"]), "pending");
});

test("W1-T11865 criterion 2: a mixed set with the other context green reads green", () => {
  assert.equal(checksStateFromRollup(greenRollup, [REVIEW, "ci-gate"]), "green");
});

test("W1-T11865 criterion 2: unreadable protection judges every reported non-review check", () => {
  assert.equal(checksStateFromRollup(greenRollup, undefined), "green");
  const red = [run("ci-gate", "SUCCESS"), run("quality", "FAILURE")];
  assert.equal(checksStateFromRollup(red, undefined), "red");
});

test("W1-T11865 criterion 2: a named required context that has not registered reads pending", () => {
  assert.equal(checksStateFromRollup([run("quality", "SUCCESS")], ["ci-gate"]), "pending");
});

test("W1-T11865 criterion 3: a red or pending review never changes the state in any required set", () => {
  for (const required of [[REVIEW], [REVIEW, "ci-gate"], ["ci-gate"], undefined]) {
    const base = [run("ci-gate", "SUCCESS"), run("quality", "SUCCESS")];
    const expected = checksStateFromRollup(base, required);
    for (const s of ["FAILURE", "PENDING", "SUCCESS", "ERROR"]) {
      assert.equal(checksStateFromRollup([...base, status(REVIEW, s)], required), expected, `${s} ${String(required)}`);
    }
  }
});

test("W1-T11865 criterion 3: a re-run rollup with newer completion times reads the same state", () => {
  const rerun = [
    run("ci-gate", "SUCCESS", "2026-11-09T12:00:00Z"),
    run("quality", "SUCCESS", "2026-11-09T12:01:00Z"),
    status(REVIEW, "FAILURE"),
  ];
  assert.equal(checksStateFromRollup(rerun, [REVIEW]), checksStateFromRollup(greenRollup, [REVIEW]));
  assert.equal(checksStateFromRollup(rerun, [REVIEW]), "green");
});

test("W1-T11865 criterion 4: a wreckterra-shaped head reads green for the retry guard and the tick read worker", () => {
  const required = [REVIEW];
  // review.ts readChecksGreenReviewedAtHead: checksStateFromRollup(rollup, required.contexts) === "green"
  assert.equal(checksStateFromRollup(greenRollup, required) === "green", true);
  // tick-read-worker.ts: checksState: checksStateFromRollup(pr.statusCheckRollup, requiredContexts)
  // (no exported wrapper; the identical call is made here).
  assert.equal(checksStateFromRollup(greenRollup, required), "green");
});
