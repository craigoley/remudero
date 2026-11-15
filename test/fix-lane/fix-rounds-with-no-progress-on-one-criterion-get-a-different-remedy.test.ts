import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFixProgressInput, nextStallRemedy, reviewerFailureDigest, sameCriterionStall, type StallRemedyRow } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type FixDispatchEvidence, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { loadDefaultPolicy } from "#src/lib/policy.js";
import type { RefusalCandidate } from "#src/lib/refusal-amendment.js";

// W1-T12710: 28 pull requests had 4 or more fix rounds against one unmet criterion, 150 rounds and 216 PR-hours,
// and every round asked for the same worker model. A change-approach verdict only added a line to the next prompt.

const TASK = "W1-T12710-FIXTURE";
const PR = 12710;
const PR_URL = `https://github.com/o/r/pull/${PR}`;
const CLAIM = "the next fix round is offered the preserved patch";
const KEY = `review:${CLAIM}`;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const CONTINUE = { verdict: "continue", reason: "the judge permits another round" } as const;

/** One completed round at `head-<i>` against `red`, pushed to `head-<i+1>` unless `landed` is false. */
function round(i: number, red: string, over: { landed?: boolean; outcome?: string; digests?: [string, string] } = {}): Record<string, unknown>[] {
  const review = red.startsWith("review:");
  const claim = red.slice("review:".length);
  return [
    { task_id: TASK, pr_number: PR, step: "fix.dispatch", round_id: `r${i}`, head_sha: `head-${i}`,
      diff_stat: { files: 1, insertions: i + 1, deletions: 0 },
      ...(review ? { unmet_claims: [claim] } : { ci_failures: [{ check: red }] }),
      ...(over.digests ? { reviewer_proof_failures: [{ claim, digest: reviewerFailureDigest(over.digests[0]) }] } : {}) },
    { task_id: TASK, pr_number: PR, step: "fix.done", round_id: `r${i}`, head_sha: `head-${i}`,
      ...(over.landed === false ? { subtype: "push_failed" } : { pushed_head_sha: `head-${i + 1}`, subtype: "success" }),
      fix_outcome: over.outcome ?? "FIXED" },
    ...(over.digests ? [{ task_id: TASK, step: "review.posted", pr_url: PR_URL, head_sha: `head-${i + 1}`,
      decision_verdict: { criteria: [{ claim, proof_exec: "executed_fail", proofFailureOutput: over.digests[1] }] } }] : []),
  ];
}

const review = (head: string) => ({ task_id: TASK, step: "review.posted", pr_url: PR_URL, head_sha: head,
  decision_verdict: { criteria: [{ claim: "the first criterion" }, { claim: CLAIM }] } });

function pr(head: string, red: "review" | "ci" = "review"): OpenPrView {
  return {
    prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: head, autoMergeArmed: false, priorStrikes: 1,
    lastActivityAt: new Date(NOW).toISOString(),
    ...(red === "review"
      ? { checksState: "green", reviewState: "failure", unmetCriteria: [{ claim: CLAIM, proof: "grep: preserved patch in src/x.ts",
        met: false, reason: "the patch is not offered", proof_exec: "executed_fail" }] }
      : { checksState: "red", reviewState: "pending", unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "not ok 1 - the patch" }] }),
  } as OpenPrView;
}

function world(rows: Record<string, unknown>[]) {
  const dispatched: FixDispatchEvidence[] = [], escalated: string[] = [], amendments: RefusalCandidate[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/stall-ledger", runId: "stall-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => CONTINUE, arm: () => {}, close: () => {},
    escalate: (_pr, reason) => { escalated.push(reason); },
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    draftRefusalAmendments: async (candidates) => {
      amendments.push(...candidates);
      return candidates.map(c => ({ taskId: c.taskId, sourceRunId: c.runId, classes: c.refusals.map(r => r.refusalClass),
        outcome: "drafted" as const, prUrl: "https://github.com/o/r/pull/99001" }));
    },
  };
  const remedies = () => rows.filter(r => r.step === "fix.stall_remedy");
  return { deps, dispatched, escalated, amendments, remedies };
}

const stallOf = (rows: Record<string, unknown>[], key: string, head: string) =>
  sameCriterionStall(buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: head, currentRed: [key], ledger: rows }).rounds, key);

test("W1-T12710 criterion 1: sameCriterionStall counts the rounds on one criterion that left the same failure or did not land", () => {
  const rows = [...round(0, "ci"), ...round(1, "ci", { landed: false }), ...round(2, "ci", { outcome: "NEEDS_SCOPE" })];
  assert.equal(stallOf(rows, "ci", "head-3"), 3, "two rounds left the same red and one did not land");
  assert.equal(stallOf(rows, "lint", "head-3"), 0, "no round was dispatched against lint");
  const incomplete = [...round(0, "ci"), { task_id: TASK, pr_number: PR, step: "fix.dispatch", round_id: "r1", head_sha: "head-1",
    ci_failures: [{ check: "ci" }] }];
  assert.equal(stallOf(incomplete, "ci", "head-1"), 1, "a round still running is not counted");
  const same = [...round(0, KEY, { digests: ["not ok 1 - offered", "not ok 1 - offered"] }), ...round(1, KEY, { digests: ["not ok 1 - offered", "not ok 1 - offered"] })];
  assert.equal(stallOf(same, KEY, "head-2"), 2, "each round left the failure digest it was dispatched against");
  const afterMove = [...round(0, KEY, { digests: ["not ok 1 - old", "not ok 1 - new"] }), ...round(1, KEY), ...round(2, KEY)];
  assert.equal(stallOf(afterMove, KEY, "head-3"), 2, "only the rounds after the one that moved it count");
});

test("W1-T12710 criterion 7: a round that moved the criterion resets its stall count", () => {
  const met = [...round(0, "ci"), ...round(1, "ci"), ...round(2, "ci"), { task_id: TASK, pr_number: PR, step: "fix.dispatch",
    round_id: "r3", head_sha: "head-3", ci_failures: [{ check: "lint" }] }];
  assert.equal(stallOf([...round(0, "ci"), ...round(1, "ci"), ...round(2, "ci")], "ci", "head-3"), 3);
  const input = buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: "head-3", currentRed: ["lint"], ledger: met });
  assert.equal(sameCriterionStall(input.rounds, "ci"), 0, "the third round met ci, so the count resets");
  const moved = [...round(0, KEY), ...round(1, KEY, { digests: ["not ok 1 - old", "not ok 1 - a new failure"] }), ...round(2, KEY)];
  assert.equal(stallOf(moved, KEY, "head-3"), 1, "a new failure digest resets the count; only the round after it counts");
});

test("W1-T12710 criterion 2: at fix.stallRounds the next action is the first remedy not tried, recorded in fix.stall_remedy", async () => {
  assert.equal(loadDefaultPolicy().values.fix.stallRounds, 3);
  assert.equal(DEFAULT_SWEEP_POLICY.fixStallRounds, 3);
  const two = world([...round(0, KEY), ...round(1, KEY), review("head-2")]);
  await runSweep([pr("head-2")], two.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(two.dispatched.length, 1);
  assert.equal(two.dispatched[0]!.stallRemedy, undefined, "below the stall count the round is unchanged");
  assert.equal(two.remedies().length, 0);

  const three = world([...round(0, KEY), ...round(1, KEY), ...round(2, KEY), review("head-3")]);
  await runSweep([pr("head-3")], three.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(three.dispatched.length, 1);
  assert.equal(three.dispatched[0]!.stallRemedy?.mount, "step_up");
  const row = three.remedies()[0]!;
  assert.deepEqual({ pr: row.pr_number, criterion: row.criterion, remedy: row.remedy, rounds: row.rounds, outcome: row.outcome },
    { pr: PR, criterion: KEY, remedy: "stronger-worker", rounds: 3, outcome: "taken" });

  const later = world([...round(0, KEY), ...round(1, KEY), ...round(2, KEY), review("head-3")]);
  await runSweep([pr("head-3")], later.deps, { ...DEFAULT_SWEEP_POLICY, fixStallRounds: 4 });
  assert.equal(later.dispatched[0]!.stallRemedy, undefined, "the policy value sets the trigger");

  const tried: StallRemedyRow[] = [{ remedy: "stronger-worker", outcome: "taken", rounds: 3, mount: "step_up" }];
  assert.deepEqual(nextStallRemedy([], { fixModelOrder: ["fix", "step_up"] }), { remedy: "stronger-worker", mount: "step_up", skipped: [] });
  assert.deepEqual(nextStallRemedy(tried, { fixModelOrder: ["fix", "step_up"] }), { remedy: "amend-criterion", skipped: [] });
  assert.deepEqual(nextStallRemedy([...tried, { remedy: "amend-criterion", outcome: "taken", rounds: 4 }], { fixModelOrder: ["fix", "step_up"] }),
    { remedy: "operator-input", skipped: [] });
});

test("W1-T12710 criterion 3: a stronger-worker round asks for the next mount and lists the approaches that did not work", async () => {
  const w = world([...round(0, "ci", { outcome: "FIXED" }), ...round(1, "ci", { outcome: "NEEDS_SCOPE" }), ...round(2, "ci", { landed: false })]);
  await runSweep([pr("head-3", "ci")], w.deps, DEFAULT_SWEEP_POLICY);
  const remedy = w.dispatched[0]!.stallRemedy!;
  assert.equal(remedy.criterion, "ci");
  assert.equal(remedy.mount, "step_up", "the next mount after fix in fix.modelOrder");
  assert.deepEqual(remedy.approaches, [
    'round r0 at head-0: diff {"files":1,"insertions":1,"deletions":0}; outcome FIXED',
    'round r1 at head-1: diff {"files":1,"insertions":2,"deletions":0}; outcome NEEDS_SCOPE',
    'round r2 at head-2: diff {"files":1,"insertions":3,"deletions":0}; outcome not landed',
  ]);

  // With no stronger mount in the policy, the rung is recorded as skipped and the next remedy is taken.
  const none = world([...round(0, KEY), ...round(1, KEY), ...round(2, KEY), review("head-3")]);
  await runSweep([pr("head-3")], none.deps, { ...DEFAULT_SWEEP_POLICY, fixModelOrder: ["fix"] });
  assert.deepEqual(none.remedies().map(r => [r.remedy, r.outcome]), [["stronger-worker", "skipped"], ["amend-criterion", "taken"]]);
  assert.equal(none.dispatched.length, 0);
});

test("W1-T12710 criterion 4: amend-criterion opens an acceptance amendment proposal through the amendment writer", async () => {
  const rows = [...round(0, KEY), ...round(1, KEY), ...round(2, KEY), review("head-3"),
    { run_id: "earlier", task_id: TASK, step: "fix.stall_remedy", pr_number: PR, criterion: KEY, remedy: "stronger-worker",
      outcome: "taken", rounds: 2, mount: "step_up" }];
  const w = world(rows);
  const summary = await runSweep([pr("head-3")], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.dispatched.length, 0, "no round runs while the amendment is proposed");
  assert.equal(w.amendments.length, 1);
  const candidate = w.amendments[0]!;
  assert.equal(candidate.taskId, TASK);
  assert.equal(candidate.refusals[0]!.criterion, 2, "the criterion's place in the task's acceptance list");
  assert.equal(candidate.refusals[0]!.refusalClass, "proof-unexecutable-at-head");
  assert.match(candidate.refusals[0]!.detail, /3 fix rounds left "the next fix round is offered the preserved patch" unmet/);
  assert.match(candidate.refusals[0]!.detail, /cannot be met as written at this head/);
  assert.match(candidate.refusals[0]!.detail, /round r2 at head-2: .*outcome FIXED/);
  const row = w.remedies().at(-1)!;
  assert.deepEqual([row.remedy, row.outcome, row.amendment_url], ["amend-criterion", "taken", "https://github.com/o/r/pull/99001"]);
  assert.match(summary.actions[0]!.reason, /an acceptance amendment proposal is open: https:\/\/github.com\/o\/r\/pull\/99001/);
});

test("W1-T12710 criterion 5: after the stall count no round runs with the same model and no new remedy", async () => {
  const rows = [...round(0, KEY), ...round(1, KEY), ...round(2, KEY), review("head-3")];
  const w = world(rows);
  await runSweep([pr("head-3")], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.dispatched.length, 1);
  assert.equal(w.dispatched[0]!.stallRemedy?.mount, "step_up");
  // The stronger round ran and did not move the criterion either.
  rows.push(...round(3, KEY), review("head-4"));
  for (let pass = 0; pass < 4; pass++) await runSweep([pr("head-4")], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.dispatched.length, 1, "no round after the stronger one without a new remedy");
  assert.deepEqual(w.remedies().map(r => r.remedy), ["stronger-worker", "amend-criterion", "operator-input"]);
});

test("W1-T12710 criterion 6: operator-input is chosen once per pull request and criterion, and escalates once", async () => {
  const rows = [...round(0, "ci"), ...round(1, "ci"), ...round(2, "ci"),
    { run_id: "earlier", task_id: TASK, step: "fix.stall_remedy", pr_number: PR, criterion: "ci", remedy: "stronger-worker",
      outcome: "taken", rounds: 2, mount: "step_up" }];
  const w = world(rows);
  for (let pass = 0; pass < 4; pass++) await runSweep([pr("head-3", "ci")], w.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(w.remedies().filter(r => r.run_id !== "earlier").map(r => [r.remedy, r.outcome]),
    [["amend-criterion", "skipped"], ["operator-input", "taken"]], "a CI check has no acceptance criterion to amend");
  assert.equal(w.escalated.filter(reason => /fix stall on ci/.test(reason)).length, 1, "one question");
  assert.match(w.escalated[0]!, /tried stronger-worker \(taken\), amend-criterion \(skipped\); the operator is asked once/);
  assert.equal(w.dispatched.length, 0);
  const answered = world([...rows]);
  await runSweep([{ ...pr("head-3", "ci"), pendingAnswer: { constraint: "drop the guarded path" } }], answered.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(answered.escalated.length, 0);
  assert.equal(answered.dispatched.length, 1, "the operator's answer is the next remedy");
});
