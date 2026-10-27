import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSweepEffects, CHECK_REQUEUE_DEFERRAL_BACKSTOP, runSweep, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { cancelledRequiredChecks, type RollupCheck } from "#src/lib/tick-read-worker.js";
import type { OpenIssue } from "#src/lib/escalate.js";

const SHARD = "ci-shard (8/8)";
const NOW = Date.parse("2026-10-20T11:00:00Z");

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 13096, prUrl: "https://github.com/craigoley/remudero/pull/13096",
    headSha: "2bc3952".padEnd(40, "0"), headRefName: "machine-judge-garden-1792500000000",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(), autoMergeArmed: false,
    isPlanFiling: true, planFilingSource: "github-files",
    redRequiredChecks: [SHARD, "ci", "ci-gate"],
    cancelledRequiredChecks: [{ name: SHARD, jobId: "117000000001", runAttempt: 1 }],
    ciFailures: [{ name: SHARD, conclusion: "CANCELLED", logTail: "The job has exceeded the maximum execution time of 35m0s" },
      { name: "ci", conclusion: "FAILURE", logTail: "Process completed with exit code 1." },
      { name: "ci-gate", conclusion: "FAILURE", logTail: "required checks failed" }],
    ...over,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-t10260-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const rows: Record<string, unknown>[] = [];
  const requeued: string[] = [];
  const rounds: number[] = [];
  const armed: number[] = [];
  const issues: string[] = [];
  const open: OpenIssue[] = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" },
    ledgerPath, runId: "W1-T10260-test", plan: { tasks: [], byId: new Map() }, log: () => {},
    issuesImpl: {
      listOpen: () => open,
      create: (title: string, body: string) => {
        const url = "https://github.com/craigoley/remudero/issues/14000";
        issues.push(title);
        open.push({ number: 14000, url, title, body });
        return url;
      },
    },
  } as unknown as Parameters<typeof buildSweepEffects>[0]);
  const deps: SweepDeps = {
    arm: pr => { armed.push(pr.prNumber); }, close: () => {}, postReview: async () => {},
    dispatchFix: () => assert.fail("cancellation must not dispatch a code worker"), escalate: () => {},
    requeueCheck: (_pr, check) => { requeued.push(check.name); return true; },
    escalateCancelledCheck: effects.escalateCancelledCheck,
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]", title: "chore(plan): file task" }),
    repairPlanPr: async () => ({ outcome: "refused", reason: "not a mechanical plan failure" }),
    dispatchPlanGateRound: async (pr) => { rounds.push(pr.prNumber); return { outcome: "pushed" }; },
    readLedger: () => [...rows, ...readLedgerLines(ledgerPath)],
    appendLine: (_path, row) => { rows.push(row); }, ledgerPath,
    runId: "W1-T10260-test", now: () => NOW,
  };
  const pass = async (pr = view(), over: Partial<SweepDeps> = {}) => {
    const peer = view({ prNumber: 6900, prUrl: "https://github.com/craigoley/remudero/pull/6900",
      headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false,
      checksState: "green", reviewState: "success", ciFailures: [], redRequiredChecks: [], cancelledRequiredChecks: [] });
    await runSweep([pr, peer], { ...deps, ...over });
    return rows.filter(row => row.step === "sweep.disposed" && row.pr_number === pr.prNumber).at(-1);
  };
  return { pass, rows, requeued, rounds, armed, issues, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T10260: a plan-only PR re-runs its cancelled shard instead of a plan round", async () => {
  const f = fixture();
  try {
    const disposed = await f.pass();
    assert.deepEqual(f.requeued, [SHARD]);
    assert.deepEqual(f.rounds, []);
    assert.deepEqual(f.issues, []);
    assert.equal(disposed?.blocker, "awaiting-ci");
    assert.equal(disposed?.disposition, "wait");
    assert.equal(f.rows.filter(row => row.step === "sweep.check_requeued").length, 1);
  } finally { f.cleanup(); }
});

test("W1-T10260: a twice-cancelled check on a plan-only PR escalates rather than re-running", async () => {
  for (const surfaceOnly of [false, true]) {
    const f = fixture();
    try {
      if (!surfaceOnly) await f.pass();
      const pr = view({ cancelledRequiredChecks: [{ name: SHARD, jobId: "117000000002", runAttempt: 2 }] });
      const disposed = await f.pass(pr);
      await f.pass(pr);
      assert.equal(f.requeued.length, surfaceOnly ? 0 : 1);
      assert.equal(f.issues.length, 1, "production escalation deduplicates successive passes");
      assert.match(f.issues[0]!, /cancelled twice/);
      assert.deepEqual(f.rounds, []);
      assert.equal(disposed?.blocker, "escalated");
    } finally { f.cleanup(); }
  }
});

test("W1-T10260: fresh running checks and deferred admission do not requeue or dispatch a plan round", async () => {
  for (const over of [
    { dryRun: true },
    { actionable: () => false },
    { liveCiRunForHead: () => true },
    { readCiGateRollup: () => [{ name: SHARD, status: "IN_PROGRESS", startedAt: new Date(NOW).toISOString() }] },
    { readCiGateRollup: () => [{ name: SHARD, conclusion: "SUCCESS", startedAt: new Date(NOW).toISOString() }] },
  ] satisfies Partial<SweepDeps>[]) {
    const f = fixture();
    try {
      const disposed = await f.pass(view(), over);
      assert.deepEqual(f.requeued, []);
      assert.deepEqual(f.rounds, []);
      if (!("dryRun" in over)) assert.equal(disposed?.blocker, "awaiting-ci");
    } finally { f.cleanup(); }
  }
});

test("W1-T10260: deterministic timeouts and unrelated reds still reach the plan round", async () => {
  for (const extra of [
    { name: SHARD, conclusion: "CANCELLED", logTail: "pure-test-pool: POOL DEFECT leaking file: test/leak.test.ts" },
    { name: "lint-plan", conclusion: "FAILURE", logTail: "plan is invalid" },
  ]) {
    const f = fixture();
    try {
      const pr = view();
      pr.ciFailures = [...pr.ciFailures!.filter(f => f.name !== extra.name), extra];
      pr.redRequiredChecks = [...pr.redRequiredChecks!, extra.name];
      await f.pass(pr);
      assert.equal(f.requeued.length, extra.name === SHARD ? 0 : 1);
      assert.deepEqual(f.rounds, [13096]);
      if (extra.name === SHARD) assert.equal(f.rows.find(r => r.step === "sweep.check_requeue.skipped")?.reason, "deterministic-timeout");
    } finally { f.cleanup(); }
  }
});

test("W1-T10260: a deferred cancelled job keeps the requeue backstop on the plan path", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < CHECK_REQUEUE_DEFERRAL_BACKSTOP; i++) f.rows.push({
      step: "sweep.check_requeue.deferred", head_sha: view().headSha, check_name: SHARD,
      outcome: "deferred", refusal: "already_running",
    });
    const disposed = await f.pass();
    await f.pass();
    assert.deepEqual(f.requeued, []);
    assert.deepEqual(f.rounds, []);
    assert.equal(f.issues.length, 1);
    assert.match(f.issues[0]!, /requeue refused/);
    assert.equal(disposed?.blocker, "escalated");
  } finally { f.cleanup(); }
});


const PRODUCER = "light-gates";
const PRODUCER_JOB = "119601912896";
const PRODUCER_RUN = "39710957377";
const PRODUCER_HEAD = "6f9313fb89989914f77dcd770b0cc490bb12a0e2";
function producerRollup(): RollupCheck[] {
  return [
    { name: PRODUCER, headSha: PRODUCER_HEAD, status: "COMPLETED", conclusion: "CANCELLED",
      detailsUrl: `https://github.com/craigoley/remudero/actions/runs/${PRODUCER_RUN}/job/${PRODUCER_JOB}`,
      startedAt: new Date(NOW - 900000).toISOString() },
    { name: "claims", checkRunId: 119606381286, headSha: PRODUCER_HEAD, status: "COMPLETED", conclusion: "FAILURE",
      externalId: `run:${PRODUCER_RUN}:1:job:${PRODUCER_JOB}`,
      outputSummary: "W1-T4399: reported by this job's claims step(s) (outcome(s): cancelled)",
      startedAt: new Date(NOW - 1000).toISOString() },
  ];
}
function producerView(rollup = producerRollup()) {
  return view({ headSha: PRODUCER_HEAD, redRequiredChecks: [PRODUCER, "claims", "ci-gate"],
    cancelledRequiredChecks: cancelledRequiredChecks(rollup, ["ci-gate"], PRODUCER_HEAD),
    ciFailures: [{ name: PRODUCER, jobId: PRODUCER_JOB, conclusion: "CANCELLED", logTail: "The job has exceeded the maximum execution time of15m0s" },
      { name: "claims", jobId: PRODUCER_JOB, conclusion: "FAILURE", logTail: "claims-check: OK -- all18 claim(s) hold.\nThe operation was canceled." },
      { name: "ci-gate", conclusion: "FAILURE", logTail: "required checks failed" }] });
}

test("producer-linked cancelled claims defer live work and retry one physical job instead of a plan round", async () => {
  for (const live of [true, false]) {
    const f = fixture();
    try {
      const pr = producerView();
      const disposed = await f.pass(pr, { liveCiRunForHead: () => live, readCiGateRollup: () => producerRollup() });
      assert.deepEqual(f.requeued, live ? [] : [PRODUCER]);
      assert.deepEqual(f.rounds, []);
      assert.equal(disposed?.blocker, "awaiting-ci");
      assert.equal(disposed?.disposition, "wait");
      if (live) assert.match(String(disposed?.reason), /still live/);
      assert.equal(pr.ciFailures?.find(failure => failure.name === "claims")?.conclusion, "FAILURE", "merge remains blocked");
      assert.equal(f.rows.filter(row => row.step === "sweep.check_requeued").length, live ? 0 : 1);
    } finally { f.cleanup(); }
  }
});

test("producer-linked cancellation retains head-attempt retry bounds and fresh unknown or superseding work holds", async () => {
  for (const mode of ["spent", "surface-spent", "unknown", "pending", "inconsistent-producer", "changed-job", "unknown-child", "admission", "dry"] as const) {
    const f = fixture();
    try {
      const rollup = producerRollup();
      if (mode === "surface-spent") rollup[1].externalId = `run:${PRODUCER_RUN}:2:job:${PRODUCER_JOB}`;
      const pr = producerView(rollup);
      if (mode === "spent") await f.pass(pr, { readCiGateRollup: () => rollup });
      const fresh = rollup.map(row => ({ ...row }));
      if (mode === "pending") fresh[0] = { ...fresh[0], conclusion: undefined, status: "IN_PROGRESS" };
      if (mode === "inconsistent-producer") fresh[0].status = "IN_PROGRESS";
      if (mode === "unknown-child") fresh[1].checkRunId = undefined;
      if (mode === "changed-job") fresh[0].detailsUrl = `https://github.com/craigoley/remudero/actions/runs/${PRODUCER_RUN}/job/999`;
      const disposed = await f.pass(pr, { readCiGateRollup: () => mode === "unknown" ? undefined : fresh,
        ...(mode === "admission" ? { actionable: () => false } : {}), ...(mode === "dry" ? { dryRun: true } : {}) });
      assert.deepEqual(f.rounds, []);
      assert.equal(f.requeued.length, mode === "spent" ? 1 : 0);
      assert.equal(f.armed.includes(pr.prNumber), false, "target cannot arm while its cancellation is unresolved");
      if (mode === "spent" || mode === "surface-spent") assert.equal(disposed?.blocker, "escalated");
      else if (mode !== "dry") assert.equal(disposed?.blocker, "awaiting-ci");
    } finally { f.cleanup(); }
  }
});

test("producer-linked cancellation cannot explain true constituent or unrelated failures", async () => {
  for (const kind of ["own-failure", "unrelated", "new-producer-failure", "new-child-failure"] as const) {
    const f = fixture();
    try {
      const rollup = producerRollup();
      if (kind === "own-failure") rollup[1].outputSummary = "W1-T4399: reported by this job's claims step(s) (outcome(s): failure)";
      const pr = producerView(rollup);
      if (kind === "unrelated") {
        pr.redRequiredChecks = [...pr.redRequiredChecks!, "lint-plan"];
        pr.ciFailures = [...pr.ciFailures!, { name: "lint-plan", conclusion: "FAILURE", logTail: "invalid plan" }];
      }
      const fresh = rollup.map(row => ({ ...row }));
      if (kind === "new-producer-failure") fresh[0].conclusion = "FAILURE";
      if (kind === "new-child-failure") fresh[1].checkRunId = 999;
      await f.pass(pr, { readCiGateRollup: () => kind === "unrelated" ? [...fresh, { name: "lint-plan", conclusion: "FAILURE" }] : fresh });
      assert.deepEqual(f.rounds, [pr.prNumber]);
      assert.equal(f.requeued.length, ["new-producer-failure", "new-child-failure"].includes(kind) ? 0 : 1);
    } finally { f.cleanup(); }
  }
});


test("several cancelled posted gates spend only their one physical producer retry", async () => {
  const f = fixture();
  try {
    const rollup = producerRollup();
    rollup.push({ ...rollup[1], name: "another-gate", checkRunId: 119606381287,
      outputSummary: "W1-T4399: reported by this job's another-gate step(s) (outcome(s): cancelled)" });
    const pr = producerView(rollup);
    pr.redRequiredChecks = [...pr.redRequiredChecks!, "another-gate"];
    pr.ciFailures = [...pr.ciFailures!, { name: "another-gate", jobId: PRODUCER_JOB, conclusion: "FAILURE", logTail: "The operation was canceled." }];
    assert.equal(pr.cancelledRequiredChecks?.length, 1);
    assert.equal(pr.cancelledRequiredChecks?.[0].explainedFailures?.length, 2);
    const disposed = await f.pass(pr, { readCiGateRollup: () => rollup });
    assert.deepEqual(f.requeued, [PRODUCER]);
    assert.equal(f.rows.filter(row => row.step === "sweep.check_requeued").length, 1);
    assert.deepEqual(f.rounds, []);
    assert.equal(disposed?.blocker, "awaiting-ci");
  } finally { f.cleanup(); }
});

test("cancelled producer confirmation preserves an independent same-name gate in either rollup order", async () => {
  for (const failed of [false, true]) for (const reverse of [false, true]) {
    const f = fixture();
    try {
      const original = producerRollup();
      const independent: RollupCheck & { workflowName: string } = { ...original[1], workflowName: "Independent workflow", checkRunId: 991,
        externalId: "run:39710957999:1:job:119601919999", conclusion: failed ? "FAILURE" : "SUCCESS" };
      const fresh = [...original, independent];
      if (reverse) fresh.reverse();
      const pr = producerView(original);
      await f.pass(pr, { readCiGateRollup: () => fresh });
      assert.deepEqual(f.requeued, [PRODUCER], "only the exact cancelled job is retried");
      assert.deepEqual(f.rounds, failed ? [pr.prNumber] : [], "an independent failure remains actionable");
      assert.equal(f.armed.includes(pr.prNumber), false, "an unresolved producer cannot arm");
    } finally { f.cleanup(); }
  }
});
