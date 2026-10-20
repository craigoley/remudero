import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSweepEffects, CHECK_REQUEUE_DEFERRAL_BACKSTOP, runSweep, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
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
    arm: () => {}, close: () => {}, postReview: async () => {},
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
  return { pass, rows, requeued, rounds, issues, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
