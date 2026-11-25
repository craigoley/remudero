import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import {
  cancelledRequiredChecks, fetchCiFailures, type CiFailureFetchOptions, type RollupCheck,
} from "#src/lib/tick-read-worker.js";

const NOW = Date.parse("2026-11-16T11:00:00Z");
const HEAD = "6f9313fb89989914f77dcd770b0cc490bb12a0e2";
const RUN = "39710957377";
const JOB = "119601912896";
const OTHER_JOB = "119601912999";
const PRODUCER = "light-gates";
const GATES = ["claims", "another-gate", "third-gate"];
const evidence: CiFailureFetchOptions = {
  fetchAnnotations: () => ["fixture annotation"],
  fetchJobLog: () => "fixture job log",
};

type Shape = "FAILURE" | "CANCELLED";

function producer(job = JOB, name = PRODUCER): RollupCheck {
  return { name, headSha: HEAD, status: "COMPLETED", conclusion: "CANCELLED",
    detailsUrl: `https://github.com/craigoley/remudero/actions/runs/${RUN}/job/${job}`,
    startedAt: new Date(NOW - 900_000).toISOString() };
}
function gate(name: string, shape: Shape, attempt = 1, job = JOB, id = 119606381286): RollupCheck {
  return { name, checkRunId: id, headSha: HEAD, status: "COMPLETED", conclusion: shape,
    externalId: `run:${RUN}:${attempt}:job:${job}`,
    outputSummary: `W1-T4399: reported by this job's ${name} step(s) (outcome(s): cancelled)`,
    startedAt: new Date(NOW - 1000).toISOString() };
}
function rollup(shape: Shape, gates: number, attempt = 1): RollupCheck[] {
  return [producer(), ...GATES.slice(0, gates).map((name, i) => gate(name, shape, attempt, JOB, 119606381286 + i)),
    { name: "ci-gate", headSha: HEAD, status: "COMPLETED", conclusion: "FAILURE" }];
}

function view(checks: RollupCheck[], over: Partial<OpenPrView> = {}): OpenPrView {
  const gates = checks.filter(c => c.name !== "ci-gate");
  return {
    prNumber: 13190, prUrl: "https://github.com/craigoley/remudero/pull/13190", headSha: HEAD,
    headRefName: "run-W1-T13186-1", taskId: "W1-T13186", reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(), autoMergeArmed: false,
    redRequiredChecks: [...gates.map(c => c.name!), "ci-gate"],
    cancelledRequiredChecks: cancelledRequiredChecks(checks, ["ci-gate"], HEAD),
    ciFailures: fetchCiFailures("craigoley", "remudero", checks, 60, evidence),
    ...over,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-t13186-"));
  const rows: Record<string, unknown>[] = [];
  const requeued: string[] = [];
  const fixes: number[] = [];
  const escalated: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {},
    dispatchFix: pr => { fixes.push(pr.prNumber); }, escalate: () => {},
    requeueCheck: (_pr, check) => { requeued.push(`${check.name}@${check.jobId}`); return true; },
    escalateCancelledCheck: async (_pr, check) => { escalated.push(check.name); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]", title: "chore(plan): file task" }),
    repairPlanPr: async () => ({ outcome: "refused", reason: "not a mechanical plan failure" }),
    dispatchPlanGateRound: async pr => { fixes.push(pr.prNumber); return { outcome: "pushed" }; },
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13186-test", now: () => NOW,
  };
  const pass = async (checks: RollupCheck[], plan: boolean) => {
    const pr = view(checks, plan ? { isPlanFiling: true, planFilingSource: "github-files", taskId: undefined,
      headRefName: "machine-judge-garden-1" } : {});
    await runSweep([pr], { ...deps, readCiGateRollup: () => checks });
    return rows.filter(row => row.step === "sweep.disposed").at(-1);
  };
  return { pass, rows, requeued, fixes, escalated, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T13186 criterion 1: a cancelled producer with gates reading CANCELLED is one check carrying the attempt", () => {
  for (const gates of [1, 3]) for (const attempt of [1, 2]) {
    const checks = rollup("CANCELLED", gates, attempt);
    const cancelled = cancelledRequiredChecks(checks, ["ci-gate"], HEAD);
    assert.equal(cancelled.length, 1, `${gates} gate(s) fold into one physical job`);
    assert.equal(cancelled[0]!.name, PRODUCER);
    assert.equal(cancelled[0]!.jobId, JOB);
    assert.equal(cancelled[0]!.runAttempt, attempt);
    assert.deepEqual(cancelled[0]!.explainedFailures?.map(a => a.name), GATES.slice(0, gates));
  }
  const two = [...rollup("CANCELLED", 1), producer(OTHER_JOB, "other-job"),
    gate("other-gate", "CANCELLED", 1, OTHER_JOB, 119609999999)];
  const both = cancelledRequiredChecks(two, ["ci-gate"], HEAD);
  assert.deepEqual(both.map(c => [c.name, c.jobId]), [[PRODUCER, JOB], ["other-job", OTHER_JOB]]);
});

test("W1-T13186 criterion 2: a producer past its one retry is escalated, not re-queued, whichever shape its gates carry", async () => {
  for (const shape of ["FAILURE", "CANCELLED"] as const) for (const plan of [true, false]) {
    const f = fixture();
    try {
      await f.pass(rollup(shape, 3, 2), plan);
      assert.deepEqual(f.requeued, [], `${shape} ${plan ? "plan" : "build"}: no re-queue at attempt 2`);
      assert.deepEqual(f.escalated, [PRODUCER], `${shape} ${plan ? "plan" : "build"}: one escalation`);
      if (shape === "CANCELLED") assert.deepEqual(f.fixes, [], "no fix round for the folded gates");
    } finally { f.cleanup(); }
  }
});

test("W1-T13186 criterion 3: a build PR whose reds are a cancelled producer and its CANCELLED gates re-queues once and dispatches no fix", async () => {
  for (const gates of [1, 3]) {
    const f = fixture();
    try {
      const disposed = await f.pass(rollup("CANCELLED", gates, 1), false);
      assert.deepEqual(f.requeued, [`${PRODUCER}@${JOB}`]);
      assert.deepEqual(f.fixes, []);
      assert.deepEqual(f.escalated, []);
      assert.equal(f.rows.filter(row => row.step === "sweep.check_requeued").length, 1);
      assert.equal(f.rows.filter(row => row.step === "fix.strike" || row.step === "sweep.fix_dispatched").length, 0);
      assert.match(String(disposed?.reason), /cancelled required check\(s\)/);
    } finally { f.cleanup(); }
  }
});

test("W1-T13186 criterion 3: the plan-filing arm re-queues the one job once whichever shape its gates read", async () => {
  for (const shape of ["FAILURE", "CANCELLED"] as const) for (const gates of [1, 3]) {
    const f = fixture();
    try {
      await f.pass(rollup(shape, gates, 1), true);
      assert.deepEqual(f.requeued, [`${PRODUCER}@${JOB}`], `${shape} x${gates}`);
      assert.deepEqual(f.fixes, []);
    } finally { f.cleanup(); }
  }
});

test("W1-T13186 criterion 4: the FAILURE shape reads as it did, and no unproven gate is read as a cancellation", async () => {
  const failure = cancelledRequiredChecks(rollup("FAILURE", 3, 1), ["ci-gate"], HEAD);
  assert.deepEqual(failure, [{ name: PRODUCER, jobId: JOB, runAttempt: 1,
    explainedFailures: GATES.map((name, i) => ({ name, checkRunId: 119606381286 + i })) }]);

  const refused: Array<(checks: RollupCheck[]) => void> = [
    checks => { checks[1]!.outputSummary = "W1-T4399: reported by this job's claims step(s) (outcome(s): failure)"; },
    checks => { checks[1]!.outputSummary = "something else"; },
    checks => { checks[1]!.externalId = `run:1:1:job:${JOB}`; },
    checks => { checks[1]!.externalId = `run:${RUN}:1:job:${OTHER_JOB}`; },
    checks => { checks[1]!.headSha = "a".repeat(40); },
    checks => { checks[1]!.checkRunId = 0; },
  ];
  for (const shape of ["FAILURE", "CANCELLED"] as const) for (const mutate of refused) {
    const checks = rollup(shape, 1, 1);
    mutate(checks);
    const cancelled = cancelledRequiredChecks(checks, ["ci-gate"], HEAD);
    assert.equal(cancelled.find(c => c.name === PRODUCER)?.explainedFailures, undefined, "no explanation granted");
    if (shape === "CANCELLED") assert.ok(cancelled.some(c => c.name === "claims"), "the unproven gate stays a check of its own");
  }
  const mixed = rollup("CANCELLED", 2, 1);
  mixed[2]!.externalId = `run:${RUN}:2:job:${JOB}`;
  assert.equal(cancelledRequiredChecks(mixed, ["ci-gate"], HEAD)[0]!.explainedFailures, undefined, "two attempts grant nothing");

  const f = fixture();
  try {
    const checks = rollup("CANCELLED", 1, 1);
    const broken = gate("another-gate", "FAILURE", 1, JOB, 119606381299);
    broken.outputSummary = "W1-T4399: reported by this job's another-gate step(s) (outcome(s): failure)";
    checks.splice(2, 0, broken);
    await f.pass(checks, false);
    assert.ok(f.requeued.includes(`${PRODUCER}@${JOB}`), "the producer is still re-queued");
    assert.equal(f.fixes.length, 1, "a constituent that truly failed still earns its fix round");
  } finally { f.cleanup(); }
});
