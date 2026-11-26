import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CHECK_REQUEUE_STEP, runSweep, type CancelledRequiredCheck, type FixDispatchEvidence, type OpenPrView,
} from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { cancelledRequiredChecks, fetchCiFailures, type RollupCheck } from "#src/lib/tick-read-worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const HEAD = "6f9313fb89989914f77dcd770b0cc490bb12a0e2";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const RUN = 39710957377;
const JOB = 119601912896;
const PRODUCER = "light-gates";
const GATES = ["claims", "rule-checks", "leak-grep"];
const actionRoot = "https://github.com/craigoley/remudero/actions";

function producerRollup(conclusion: "FAILURE" | "CANCELLED", attempt: number, gates: string[],
  name = PRODUCER, run = RUN, job = JOB): RollupCheck[] {
  const completed = { headSha: HEAD, status: "COMPLETED", startedAt: new Date(NOW - 60_000).toISOString() };
  return [
    { ...completed, name, checkRunId: job, conclusion: "CANCELLED", detailsUrl: `${actionRoot}/runs/${run}/job/${job}` },
    ...gates.map((gate, index) => ({
      ...completed, name: gate, conclusion, checkRunId: job + index + 1, externalId: `run:${run}:${attempt}:job:${job}`,
      outputSummary: `W1-T4399: reported by this job's ${gate} step(s) (outcome(s): cancelled)`,
    })),
  ];
}

function cancelled(rollup: RollupCheck[]) {
  return cancelledRequiredChecks(rollup, ["ci-gate"], HEAD);
}

async function sweep(t: TestContext, checks: RollupCheck[], isPlanFiling: boolean,
  fresh = checks) {
  const rollup = [...checks, { name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE" }];
  const ledger = writeLedger([], { scope: t });
  const retries: CancelledRequiredCheck[] = [];
  const escalations: { name: string; reason: string }[] = [];
  const fixes: (FixDispatchEvidence | undefined)[] = [];
  let planRounds = 0;
  const pr: OpenPrView = {
    prNumber: 13501, prUrl: "https://github.com/craigoley/remudero/pull/13501", headSha: HEAD,
    headRefName: isPlanFiling ? "machine-judge-garden-1794839315750" : "run-unfiled-1794839315750",
    reviewState: "pending", checksState: "red", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(), autoMergeArmed: false, isPlanFiling,
    redRequiredChecks: rollup.map(check => check.name!), cancelledRequiredChecks: cancelled(rollup),
    ciFailures: fetchCiFailures("craigoley", "remudero", rollup, 60, {
      fetchAnnotations: () => [], fetchJobLog: () => "The operation was canceled.",
    }),
  };
  await runSweep([pr], {
    arm: () => assert.fail("red checks must hold merge"), close: () => {}, escalate: () => {}, postReview: () => {},
    dispatchFix: (_pr, evidence) => { fixes.push(evidence); },
    dispatchPlanGateRound: async () => { planRounds++; return { outcome: "pushed" }; },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]", title: "chore(plan): file task" }),
    repairPlanPr: async () => ({ outcome: "refused", reason: "not a mechanical plan failure" }),
    readCiGateRollup: () => [...fresh, rollup.at(-1)!],
    requeueCheck: (_pr, check) => { retries.push(check); return true; },
    escalateCancelledCheck: (_pr, check, reason) => { escalations.push({ name: check.name, reason }); },
    ledgerPath: ledger.path, now: () => NOW, runId: "W1-T13186-test",
  });
  const rows = readLedgerLines(ledger.path);
  return { pr, retries, escalations, fixes, planRounds, rows, disposed: rows.findLast(row => row.step === "sweep.disposed") };
}

test("W1-T13186 criterion 1 folds gates into one entry per physical producer and retains its attempt", () => {
  for (const gates of [GATES.slice(0, 1), GATES]) {
    const rollup = producerRollup("CANCELLED", 2, gates);
    assert.deepEqual(cancelled(rollup), [{ name: PRODUCER, jobId: String(JOB), runAttempt: 2,
      explainedFailures: rollup.slice(1).map(gate => ({ name: gate.name, checkRunId: gate.checkRunId })) }]);
  }
  const secondJob = JOB + 100;
  const rollup = [...producerRollup("CANCELLED", 1, ["claims"]), ...producerRollup("CANCELLED", 2, ["other-gate"],
    "other-producer", RUN + 1, secondJob)];
  assert.deepEqual(cancelled(rollup).map(({ name, jobId, runAttempt }) => ({ name, jobId, runAttempt })), [
    { name: PRODUCER, jobId: String(JOB), runAttempt: 1 },
    { name: "other-producer", jobId: String(secondJob), runAttempt: 2 },
  ]);
});

test("W1-T13186 criterion 2 escalates a spent producer once on plan and build pull requests", async t => {
  for (const isPlanFiling of [true, false]) for (const conclusion of ["FAILURE", "CANCELLED"] as const) {
    const result = await sweep(t, producerRollup(conclusion, 2, GATES), isPlanFiling);
    assert.deepEqual(result.retries, [], `${isPlanFiling ? "plan" : "build"} / ${conclusion}`);
    assert.deepEqual(result.escalations.map(issue => issue.name), [PRODUCER]);
    assert.match(result.escalations[0].reason, /already re-queued once on this head sha and cancelled again/);
    assert.equal(result.planRounds, 0);
    assert.equal(result.fixes.length, !isPlanFiling && conclusion === "FAILURE" ? 1 : 0);
  }
});

test("W1-T13186 criterion 3 requeues one build job without dispatching a fix or spending a strike", async t => {
  for (const producer of [PRODUCER, "ci-shard (1/2)"]) {
    const rollup = producerRollup("CANCELLED", 1, GATES, producer);
    if (producer !== PRODUCER) rollup.push({ name: "ci", status: "COMPLETED", conclusion: "FAILURE" });
    const result = await sweep(t, rollup, false);
    assert.equal(result.pr.ciFailures?.filter(failure => failure.conclusion === "CANCELLED").length, 4);
    assert.deepEqual(result.retries.map(check => [check.name, check.jobId]), [[producer, String(JOB)]]);
    assert.deepEqual(result.escalations, []);
    assert.deepEqual(result.fixes, []);
    assert.equal(result.rows.filter(row => row.step === CHECK_REQUEUE_STEP).length, 1);
    assert.equal(result.disposed?.acted, false);
  }
});

test("W1-T13186 criterion 4 preserves the legacy shape and keeps unverified posted gates actionable", async t => {
  const legacy = producerRollup("FAILURE", 1, GATES);
  const plan = await sweep(t, legacy, true);
  assert.deepEqual(plan.retries.map(check => check.name), [PRODUCER]);
  assert.equal(plan.planRounds, 0);
  const build = await sweep(t, legacy, false);
  assert.deepEqual(build.retries.map(check => check.name), [PRODUCER]);
  assert.equal(build.fixes.length, 1);

  for (const conclusion of ["FAILURE", "CANCELLED"] as const) {
    for (const bad of [
      { outputSummary: undefined },
      { outputSummary: "W1-T4399: reported by this job's claims step(s) (outcome(s): failure cancelled)" },
      { externalId: `run:${RUN + 1}:1:job:${JOB}` },
      { externalId: `run:${RUN}:1:job:${JOB + 100}` },
    ]) {
      const rollup = producerRollup(conclusion, 1, ["claims"]);
      Object.assign(rollup[1], bad);
      assert.deepEqual(cancelled(rollup), [{ name: PRODUCER, jobId: String(JOB) }]);
      const result = await sweep(t, rollup, false);
      assert.deepEqual(result.retries.map(check => check.name), [PRODUCER]);
      assert.ok(result.fixes[0]?.ciFailures?.some(failure => failure.name === "claims"));
    }
    const rollup = [...producerRollup(conclusion, 1, ["claims"]), { name: "lint-plan", conclusion: "FAILURE" }];
    const result = await sweep(t, rollup, false);
    assert.ok(result.fixes[0]?.ciFailures?.some(failure => failure.name === "lint-plan"));
  }
});

test("a newer posted gate cannot authorize the snapshot producer's retry", async t => {
  const rollup = producerRollup("CANCELLED", 1, ["claims"]);
  const [producer, alias] = rollup;
  for (const isPlanFiling of [true, false]) {
    const passed = await sweep(t, rollup, isPlanFiling, [producer, { ...alias, conclusion: "SUCCESS" }]);
    assert.deepEqual(passed.retries, []);
    assert.deepEqual(passed.fixes, []);
    assert.equal(passed.planRounds, 0);
    const failed = await sweep(t, rollup, isPlanFiling, [producer, { ...alias, checkRunId: alias.checkRunId! + 1,
      conclusion: "FAILURE", outputSummary: undefined }]);
    assert.deepEqual(failed.retries, []);
    assert.equal(failed.fixes.length + failed.planRounds, 1);
  }
});
