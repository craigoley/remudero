import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildFixProgressInput, judgeFixProgress, parseFixProgressVerdict, resolveFixProgress,
  reviewerProofFailures, type FixProgressHostedProofResult } from "#src/lib/fix-progress-judge.js";

const CLAIM = "the real owner cli completes";
const FILE = "test/fix-lane/real-owner.test.ts";
const PROOF = `unit test: ${FILE}`;
const OUTPUT = "not ok 1 - real owner cli\nError: timed out after 92000ms";
const HEAD = "current-head";
const criterion = { claim: CLAIM, proof: PROOF, met: false, reason: "review sandbox timeout",
  proof_exec: "executed_fail", proofFailureOutput: OUTPUT, reviewLoad: "load1=18, cores=4" };
const worker = { proof: PROOF, headSha: HEAD, result: "pass" as const, output: "# tests 1\n# pass 1\n# fail 0" };
const ci: FixProgressHostedProofResult = { headSha: HEAD, testFile: FILE, check: "test-fast-shard (2/8)",
  result: "pass", output: "real owner cli: passed" };

function facts() {
  const ledger: Record<string, unknown>[] = [
    { step: "fix.dispatch", task_id: "W1-T11133", pr_number: 15532, round_id: "r1",
      head_sha: "old-head", unmet_claims: [CLAIM], reviewer_proof_failures: reviewerProofFailures([criterion]) },
    { step: "fix.done", task_id: "W1-T11133", pr_number: 15532, round_id: "r1",
      fix_outcome: "FIXED", pushed_head_sha: HEAD, worker_proof_results: [worker] },
    { step: "review.posted", task_id: "W1-T11133", pr_number: 15532, head_sha: HEAD,
      decision_verdict: { criteria: [criterion] } },
  ];
  return { taskId: "W1-T11133", prNumber: 15532, headSha: HEAD, currentRed: [`review:${CLAIM}`],
    ledger, reviewFailures: [criterion], hostedProofResults: [ci] };
}

describe("test/fix-lane/a-review-only-failure-that-passes-off-host-is-a-harness-signal.test.ts", () => {
  test("persistent review failure plus both exact-head passes supplies the harness evidence", async () => {
    const input = buildFixProgressInput(facts());
    assert.equal(input.signals.reviewerOnlyFailurePersists, 1);
    assert.equal(input.signals.offHostPass, true);
    assert.deepEqual(input.rounds[0]!.workerProofResults, [worker]);
    assert.deepEqual(input.offHostPassEvidence, [{ claim: CLAIM, proof: PROOF,
      reviewerOutput: OUTPUT, reviewLoad: criterion.reviewLoad, worker, ci: [ci] }]);
    assert.match(input.harnessGuidance!, /harness/);
    const standIn = await judgeFixProgress(input);
    assert.equal(standIn.verdict, "escalate");
    if (standIn.verdict !== "escalate") assert.fail("a harness decision must stop dispatch");
    assert.equal(standIn.loop, "harness");
    for (const evidence of [PROOF, OUTPUT, worker.output, ci.check, ci.output, criterion.reviewLoad]) {
      assert.ok(standIn.reason.includes(evidence), `missing escalation evidence: ${evidence}`);
    }
  });

  test("a wired harness judgment follows the existing escalation route", async () => {
    const input = buildFixProgressInput(facts());
    let calls = 0;
    const result = await resolveFixProgress(input, [], { firstRound: true, judge: async seen => {
      calls++;
      assert.equal(seen.signals.offHostPass, true);
      return { verdict: "harness", reason: "fresh review sandbox needed" };
    } });
    assert.equal(calls, 1);
    assert.equal(result.decision.verdict, "escalate");
    assert.match(result.decision.reason, /fresh review sandbox needed/);
    assert.ok(result.decision.reason.includes(PROOF));
    assert.equal(result.receipt.step, "fix.progress_judged");
    assert.deepEqual(parseFixProgressVerdict('{"verdict":"harness","reason":"off-host proof passed"}'),
      { verdict: "escalate", loop: "harness", reason: "off-host proof passed" });
  });

  test("W1-T11133 criterion 2: reproduced or missing off-host results preserve ordinary judgments", async () => {
    for (const source of ["worker-fail", "ci-fail", "worker-missing", "ci-missing"] as const) {
      const f = facts();
      if (source === "worker-fail") f.ledger[1]!.worker_proof_results = [{ ...worker, result: "fail" }];
      if (source === "ci-fail") f.hostedProofResults = [{ ...ci, result: "fail" }];
      if (source === "worker-missing") delete f.ledger[1]!.worker_proof_results;
      if (source === "ci-missing") f.hostedProofResults = [];
      const input = buildFixProgressInput(f);
      assert.equal(input.signals.offHostPass, undefined, source);
      assert.equal(input.offHostPassEvidence, undefined, source);
      for (const decision of [
        { verdict: "continue" as const, reason: "a defect remains" },
        { verdict: "change-approach" as const, approach: "reproduce on worker", reason: "changed evidence" },
        { verdict: "escalate" as const, loop: "repeated patch", reason: "ordinary escalation" },
      ]) assert.deepEqual(await judgeFixProgress(input, async () => decision), decision);
      assert.equal((await judgeFixProgress(input)).verdict, "unavailable");
    }
    const old = facts();
    delete old.ledger[1]!.worker_proof_results;
    const legacy = buildFixProgressInput({ ...old, hostedProofResults: undefined });
    const noResults = buildFixProgressInput({ ...old, hostedProofResults: [] });
    assert.deepEqual(noResults.signals, legacy.signals);
    assert.deepEqual(Object.keys(legacy.signals).sort(), ["identicalDiffs", "identicalRedSets", "incompleteRounds",
      "noOpRounds", "oscillating", "refusedRounds", "reviewerOnlyFailurePersists"]);
  });

  test("stale, unrelated, superseded and malformed receipts cannot establish an off-host pass", () => {
    const changes: ((f: ReturnType<typeof facts>) => void)[] = [
      f => { f.ledger[1]!.worker_proof_results = [{ ...worker, headSha: "old-head" }]; },
      f => { f.ledger[1]!.worker_proof_results = [{ ...worker, proof: "unit test: unrelated" }]; },
      f => { f.hostedProofResults = [{ ...ci, headSha: "old-head" }]; },
      f => { f.hostedProofResults = [{ ...ci, testFile: "test/another.test.ts" }]; },
      f => { f.ledger[1]!.pushed_head_sha = "old-head"; },
      f => { f.ledger[1]!.fix_outcome = "NO_CHANGE"; },
      f => { f.ledger[1]!.subtype = "push_failed"; },
      f => { f.ledger[1]!.pr_number = 999; },
      f => { f.ledger[2]!.pr_number = 999; },
      f => { f.reviewFailures = [{ ...criterion, proofFailureOutput: "different assertion" }]; },
      f => { f.reviewFailures = [{ ...criterion, proof_exec: "executed_pass" }]; },
      f => { f.currentRed.push("test-fast-shard (2/8)"); },
      f => { f.reviewFailures = []; },
      f => { f.ledger[1]!.worker_proof_results = [null, {}, { ...worker, result: "unknown" }]; },
      f => { f.ledger[1]!.worker_proof_results = [worker, { ...worker, result: "fail" }]; },
      f => { f.hostedProofResults = [ci, { ...ci, result: "fail" }]; },
      f => { f.hostedProofResults = [{ ...ci, check: "" }]; },
      f => { f.ledger[0]!.reviewer_proof_failures = [{ claim: CLAIM, digest: "wrong-output" }]; },
      f => { f.ledger[0]!.reviewer_proof_failures = reviewerProofFailures([{ ...criterion, proof: "unit test: old proof" }]); },
      f => { f.ledger[2]!.decision_verdict = { criteria: [{ ...criterion, proof: "unit test: old proof" }] }; },
    ];
    for (const change of changes) {
      const f = facts();
      change(f);
      assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, change.toString());
    }
  });

  test("pending checks and later rounds cannot borrow an earlier pass", () => {
    const f = facts();
    assert.equal(buildFixProgressInput({ ...f, pendingChecks: [ci.check] }).signals.offHostPass, undefined);
    f.ledger.push(
      { ...f.ledger[0], round_id: "r2", head_sha: HEAD },
      { ...f.ledger[1], round_id: "r2", fix_outcome: "NO_CHANGE" },
      { ...f.ledger[2] },
    );
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined);
    delete f.ledger[4]!.pushed_head_sha;
    f.ledger[4]!.fix_outcome = "FIXED";
    f.ledger[4]!.worker_proof_results = [{ ...worker, result: "fail" }];
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, "an unpushed failure supersedes the old pass");
    f.ledger.splice(3);
    f.ledger.push({ ...f.ledger[0], round_id: "r2", head_sha: HEAD });
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, "an ongoing round has no new result yet");
  });

  test("a wired judge chooses its verdict from the signal without a forced harness override", async () => {
    const input = buildFixProgressInput(facts());
    for (const decision of [
      { verdict: "continue" as const, reason: "investigate additional evidence" },
      { verdict: "change-approach" as const, approach: "inspect another cause", reason: "new facts" },
    ]) assert.deepEqual(await judgeFixProgress(input, async () => decision), decision);
    const decision = await judgeFixProgress(input, async () =>
      parseFixProgressVerdict('{"verdict":"harness","reason":"review environment"}'));
    assert.equal(decision.verdict, "escalate");
    assert.ok(decision.reason.includes(worker.output));
  });

  test("a harness verdict without corroborating results holds rather than dispatches", async () => {
    const f = facts();
    f.hostedProofResults = [];
    const decision = await judgeFixProgress(buildFixProgressInput(f), async () => ({ verdict: "harness", reason: "guess" }));
    assert.equal(decision.verdict, "unavailable");
    assert.match(decision.reason, /off-host/);
  });
});
