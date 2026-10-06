import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIX_ROUTING_HALF_LIFE_MS,
  fixArmEvidence,
  fixRoutingDecisionFields,
  fixRoutingWeights,
} from "../src/lib/fix-routing-learner.js";

// W1-T6028: a fix round whose worker was ENDED BY A SIGNAL (orphan sweep, deploy, OOM) says nothing about
// whether its arm's rounds commit. W1-T5999 writes such a round as `subtype: "signal_terminated"`,
// `worker_exit: "signal"`, which the reward fell through to `accepted`; before it, the same round was
// `commit_refused` with `worker_subtype: "error_exit_null"` and scored `refused`. Neither may move an arm.

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function fixDone(subtype: string, extra: Record<string, unknown> = {}, ageMs = 0): Record<string, unknown> {
  return {
    ts: new Date(NOW - ageMs).toISOString(),
    task_id: "W1-T1",
    step: "fix.done",
    provider: "codex",
    selected_model: "gpt-6-sol",
    subtype,
    ...extra,
  };
}

/** The arm's own record without any signal-ended round: two accepted, one refused (a normal exit). */
const CONTROL = [
  fixDone("success", { pushed_head_sha: "aaa" }),
  fixDone("success", { pushed_head_sha: "bbb" }),
  fixDone("commit_refused", { worker_subtype: "success" }),
  { ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.done", provider: "claude", selected_model: "claude-opus-5-5", subtype: "success" },
];

/** W1-T5999's stand-down row: the worker left no work and was ended by a signal. */
const SIGNAL_TERMINATED = fixDone("signal_terminated", { worker_subtype: "error_exit_null", worker_exit: "signal" });

/** Pre-W1-T5999 rows: the harness tried to commit a signal-ended round that left nothing, and refused it. */
const LEGACY_REFUSED = fixDone("commit_refused", { worker_subtype: "error_exit_null", fix_outcome: "unstated" });
const LEGACY_UNPUSHED = fixDone("error_exit_null", {}, FIX_ROUTING_HALF_LIFE_MS);

function decisionFields(rows: Array<Record<string, unknown>>) {
  const weights = fixRoutingWeights(fixArmEvidence(rows, NOW), [{ provider: "codex", model: "gpt-6-sol" }], "0000000a");
  return fixRoutingDecisionFields({
    weights,
    probabilities: [{ provider: "codex", headroom: 1, learned: 1, final: 1 }],
    selected: { provider: "codex", model: "gpt-6-sol" },
  });
}

test("W1-T6028: a signal_terminated fix.done row adds to no arm and not to the pooled prior, and is counted", () => {
  const control = fixArmEvidence(CONTROL, NOW);
  const withSignal = fixArmEvidence([...CONTROL, SIGNAL_TERMINATED], NOW);
  assert.deepEqual(withSignal.arms, control.arms, "the codex arm's rounds and weights are untouched");
  assert.equal(withSignal.priorMean, control.priorMean, "the pooled prior is untouched");
  assert.equal(withSignal.signalExcluded, 1);
  assert.equal(withSignal.unattributedExcluded, 0, "a signal-ended round is not an unattributed one");
  assert.equal(control.signalExcluded, 0);

  const fields = decisionFields([...CONTROL, SIGNAL_TERMINATED]);
  assert.equal(fields.signal_excluded, 1, "fix.routing_decision names how many rounds were set aside");
  assert.equal(fields.unattributed_excluded, 0);
  assert.deepEqual(Object.keys(fields).slice(4, 6), ["unattributed_excluded", "signal_excluded"]);
});

test("W1-T6028: a pre-W1-T5999 error_exit_null row that produced no pushed head adds to no arm either", () => {
  const control = fixArmEvidence(CONTROL, NOW);
  const withLegacy = fixArmEvidence([...CONTROL, LEGACY_REFUSED, LEGACY_UNPUSHED], NOW);
  assert.deepEqual(withLegacy.arms, control.arms);
  assert.equal(withLegacy.priorMean, control.priorMean);
  assert.equal(withLegacy.signalExcluded, 2);
  assert.equal(decisionFields([...CONTROL, LEGACY_REFUSED, SIGNAL_TERMINATED]).signal_excluded, 2);
  // An unattributed signal-ended row stays an unattributed one: the attribution check comes first.
  const unattributed = fixArmEvidence([{ ...SIGNAL_TERMINATED, provider: undefined }], NOW);
  assert.deepEqual([unattributed.unattributedExcluded, unattributed.signalExcluded, unattributed.arms.length], [1, 0, 0]);
});

test("W1-T6028: a commit_refused row from a worker that exited normally still scores refused", () => {
  const evidence = fixArmEvidence([fixDone("commit_refused", { worker_subtype: "success" })], NOW);
  assert.equal(evidence.signalExcluded, 0);
  assert.deepEqual(
    evidence.arms.map((arm) => [arm.rounds, arm.acceptedWeight, arm.refusedWeight]),
    [[1, 0, 1]],
  );
});

test("W1-T6028: a signal-ended round that LEFT work and pushed it (W1-T6032) is scored like any pushed round", () => {
  // W1-T6032's fall-through row: the harness committed the leftover edits and pushed them, so the row carries
  // the worker's own `error_exit_null` subtype beside a pushed head and no `worker_exit`. It made a commit.
  const pushed = fixDone("error_exit_null", { pushed_head_sha: "a77eedf" });
  const accepted = fixArmEvidence([pushed], NOW);
  assert.equal(accepted.signalExcluded, 0);
  assert.deepEqual(accepted.arms.map((arm) => [arm.rounds, arm.acceptedWeight, arm.refusedWeight]), [[1, 1, 0]]);
  const red = fixArmEvidence([pushed, { ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.ci_not_green", sha: "a77eedf" }], NOW);
  assert.deepEqual(red.arms.map((arm) => [arm.acceptedWeight, arm.refusedWeight]), [[0.5, 0.5]]);
});
