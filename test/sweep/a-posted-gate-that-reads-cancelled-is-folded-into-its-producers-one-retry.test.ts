import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { CHECK_REQUEUE_STEP, runSweep, type FixDispatchEvidence, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { cancelledRequiredChecks, fetchCiFailures, type RollupCheck } from "#src/lib/tick-read-worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const HEAD = "6f9313fb89989914f77dcd770b0cc490bb12a0e2";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const RUN = 39710957377;
const JOB = 119601912896;
const PRODUCER = "light-gates";
const GATES = ["claims", "rule-checks", "leak-grep"];
const AGGREGATE = { name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE" };

function producerRollup(conclusion: "failure" | "cancelled", attempt: number, gates = GATES,
  name = PRODUCER, run = RUN, job = JOB): RollupCheck[] {
  const detailsUrl = `https://github.com/craigoley/remudero/actions/runs/${run}/job/${job}`;
  const completed = { headSha: HEAD, status: "COMPLETED", startedAt: new Date(NOW - 60_000).toISOString(), detailsUrl };
  return [
    { ...completed, checkRunId: job, name, conclusion: "CANCELLED" },
    ...gates.map((gate, index) => ({
      ...completed, checkRunId: job + index + 1, name: gate, conclusion: conclusion.toUpperCase(),
      externalId: `run:${run}:${attempt}:job:${job}`,
      outputSummary: `W1-T4399: reported by this job's ${gate} step(s) (outcome(s): cancelled)`,
    })),
  ];
}

function cancelled(rollup: RollupCheck[]) {
  return cancelledRequiredChecks(rollup, ["ci-gate"], HEAD);
}

async function sweep(t: TestContext, checks: RollupCheck[], isPlanFiling: boolean,
  fresh: RollupCheck[] | null = checks, readActionsStatusSummary?: SweepDeps["readActionsStatusSummary"]) {
  const rollup = [...checks, AGGREGATE];
  const ledger = writeLedger([], { scope: t });
  const retries: Array<string | undefined> = [];
  const escalations: Array<{ name: string; reason: string }> = [];
  const fixes: FixDispatchEvidence[] = [];
  let planRounds = 0;
  const pr: OpenPrView = {
    prNumber: 13501, prUrl: "https://github.com/craigoley/remudero/pull/13501", headSha: HEAD,
    headRefName: isPlanFiling ? "machine-judge-garden-1794839315750" : "run-unfiled-1794839315750",
    reviewState: "pending", checksState: "red", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(), autoMergeArmed: false, isPlanFiling,
    redRequiredChecks: ["ci-gate"], cancelledRequiredChecks: cancelled(rollup),
    ciFailures: fetchCiFailures("craigoley", "remudero", rollup, 60, {
      fetchAnnotations: () => [], fetchJobLog: () => "The operation was canceled.",
    }),
  };
  await runSweep([pr], {
    arm: () => assert.fail("red checks must hold merge"), close: () => {}, escalate: () => {}, postReview: () => {},
    dispatchFix: (_pr, evidence) => { assert.ok(evidence); fixes.push(evidence); },
    dispatchPlanGateRound: async () => { planRounds++; return { outcome: "pushed" }; },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]", title: "chore(plan): file task" }),
    repairPlanPr: async () => ({ outcome: "refused", reason: "not a mechanical plan failure" }),
    readCiGateRollup: () => fresh === null ? undefined : [...fresh, AGGREGATE],
    readActionsStatusSummary,
    requeueCheck: (_pr, check) => { retries.push(check.jobId); return true; },
    escalateCancelledCheck: (_pr, check, reason) => { escalations.push({ name: check.name, reason }); },
    ledgerPath: ledger.path, now: () => NOW, runId: "W1-T13186-test",
  });
  const rows = readLedgerLines(ledger.path);
  return { pr, retries, escalations, fixes, planRounds, rows, disposed: rows.findLast(row => row.step === "sweep.disposed") };
}

test("W1-T13186 criterion 1 folds one or several posted gates into each producer's entry", () => {
  for (const gates of [GATES.slice(0, 1), GATES]) {
    const rollup = producerRollup("cancelled", 2, gates);
    assert.deepEqual(cancelled(rollup), [{ name: PRODUCER, jobId: String(JOB), runAttempt: 2,
      explainedFailures: rollup.slice(1).map(gate => ({ name: gate.name, checkRunId: gate.checkRunId })) }]);
  }
  const rollup = [...producerRollup("cancelled", 1, ["claims"]),
    ...producerRollup("cancelled", 2, ["other-gate"], "other-producer", RUN + 1, JOB + 100)];
  assert.deepEqual(cancelled(rollup).map(({ name, jobId, runAttempt }) => ({ name, jobId, runAttempt })), [
    { name: PRODUCER, jobId: String(JOB), runAttempt: 1 },
    { name: "other-producer", jobId: String(JOB + 100), runAttempt: 2 },
  ]);
});

test("W1-T13186 criterion 2 escalates the spent producer once for either posted conclusion", async t => {
  for (const isPlanFiling of [true, false]) for (const conclusion of ["failure", "cancelled"] as const) {
    const result = await sweep(t, producerRollup(conclusion, 2), isPlanFiling);
    assert.deepEqual(result.retries, [], `${isPlanFiling ? "plan" : "build"} / ${conclusion}`);
    assert.deepEqual(result.escalations.map(issue => issue.name), [PRODUCER]);
    assert.match(result.escalations[0].reason, /already re-queued once on this head sha and cancelled again/);
    assert.equal(result.planRounds, 0);
    assert.equal(result.fixes.length, !isPlanFiling && conclusion === "failure" ? 1 : 0);
  }
});

test("W1-T13186 criterion 3 requeues one build job with neither a ci-log round nor a strike", async t => {
  const shard = "ci-shard (1/2)";
  const plain = producerRollup("cancelled", 1);
  const matrix = [...producerRollup("cancelled", 1, GATES, shard),
    { name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
  for (const [rollup, fresh] of [[plain, null], [matrix, matrix]] as const) {
    const result = await sweep(t, rollup, false, fresh);
    assert.equal(result.pr.ciFailures?.filter(failure => failure.conclusion === "CANCELLED").length, 4);
    assert.deepEqual(result.retries, [String(JOB)]);
    assert.deepEqual(result.escalations, []);
    assert.deepEqual(result.fixes, []);
    assert.equal(result.rows.filter(row => row.step === CHECK_REQUEUE_STEP).length, 1);
    assert.equal(result.disposed?.acted, false);
  }
});

test("W1-T13186 criterion 4 preserves legacy build handling and keeps unverified posts actionable", async t => {
  const legacy = producerRollup("failure", 1);
  const plan = await sweep(t, legacy, true);
  assert.deepEqual(plan.retries, [String(JOB)]);
  assert.equal(plan.planRounds, 0);
  for (const fresh of [legacy, null]) {
    const build = await sweep(t, legacy, false, fresh);
    assert.deepEqual(build.retries, [String(JOB)]);
    assert.deepEqual(build.fixes[0]?.ciFailures?.filter(failure => GATES.includes(failure.name)).map(failure => failure.name), GATES);
  }

  for (const conclusion of ["failure", "cancelled"] as const) {
    for (const bad of [
      { outputSummary: undefined },
      { outputSummary: "W1-T4399: reported by this job's claims step(s) (outcome(s): failure cancelled)" },
      { externalId: `run:${RUN + 1}:1:job:${JOB}` },
      { externalId: `run:${RUN}:1:job:${JOB + 100}` },
    ]) {
      const [producer, post] = producerRollup(conclusion, 1, ["claims"]);
      const rollup = [producer, { ...post, ...bad }];
      assert.deepEqual(cancelled(rollup), [{ name: PRODUCER, jobId: String(JOB) }]);
      const result = await sweep(t, rollup, false);
      assert.deepEqual(result.retries, [String(JOB)]);
      assert.ok(result.fixes[0]?.ciFailures?.some(failure => failure.name === "claims"));
    }
    const rollup = [...producerRollup(conclusion, 1, ["claims"]), { name: "lint-plan", conclusion: "FAILURE" }];
    const result = await sweep(t, rollup, false);
    assert.ok(result.fixes[0]?.ciFailures?.some(failure => failure.name === "lint-plan"));
  }
});

test("a fresh green or superseding posted gate cannot authorize the snapshot producer's retry", async t => {
  const rollup = producerRollup("cancelled", 1, ["claims"]);
  const [producer, post] = rollup;
  for (const isPlanFiling of [true, false]) {
    const passed = await sweep(t, rollup, isPlanFiling, [producer, { ...post, conclusion: "SUCCESS" }]);
    assert.deepEqual(passed.retries, []);
    assert.equal(passed.fixes.length + passed.planRounds, 0);
    const failed = await sweep(t, rollup, isPlanFiling, [producer, { ...post, checkRunId: JOB + 20,
      conclusion: "FAILURE", outputSummary: undefined }]);
    assert.deepEqual(failed.retries, []);
    assert.equal(failed.fixes.length + failed.planRounds, 1);
    const failedProducer = await sweep(t, rollup, isPlanFiling, [{ ...producer, conclusion: "FAILURE" }, post]);
    assert.deepEqual(failedProducer.retries, []);
    assert.equal(failedProducer.fixes.length + failedProducer.planRounds, 1);
  }
});

test("producer-linked CANCELLED posts still hold a build retry during an Actions incident", async t => {
  const rollup = producerRollup("cancelled", 1);
  const result = await sweep(t, rollup, false, rollup, async () => ({
    page: { id: "kctbh9vrtdwd" }, components: [{ name: "Actions", status: "major_outage" }], incidents: [],
  }));
  assert.deepEqual(result.retries, []);
  assert.deepEqual(result.fixes, []);
  assert.match(String(result.disposed?.stand_down_reason), /GitHub Actions major_outage/);
});
