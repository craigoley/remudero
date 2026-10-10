// test/a-job-requeue-refused-while-its-run-is-running-is-retried-not-dropped.test.ts — W1-T5920.
//
// LIVE 2026-10-05, a GitHub Actions outage: 203 `sweep.check_requeue.error` rows read "The workflow
// run containing this job is already running (HTTP 403)" or "Only jobs from the current attempt can
// be re-run (HTTP 403)". Each had its `sweep.check_requeued` row written BEFORE the POST, so the
// refusal spent the head's one bounded requeue and nothing retried. The fix rung's FLAKE rerun hit
// the same 403, recorded `flake_claim: refuted`, and the "fix already dispatched for this head"
// dedup then held #9396/#9382/#9415 until an operator merged main by hand.
//
// A refusal because the run is in flight is DEFERRED: it spends nothing, is retried once the run
// concludes (the current attempt's job id), and CHECK_REQUEUE_DEFERRAL_BACKSTOP deferrals escalate
// once. A FLAKE round whose requeue was deferred records `requeue_deferred` and holds no dedup.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  CHECK_REQUEUE_DEFERRED_STEP,
  CHECK_REQUEUE_STEP,
  checkRequeueDeferralsFromLedger,
  deferredRequeueTarget,
  fixRungStalledWithoutNewHead,
  jobRequeueOutcome,
  jobRerunRefusal,
  requeuedCheckKeysFromLedger,
  runSweep,
  type CancelledRequiredCheck,
  type CiFailure,
  type JobRequeueOutcome,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import {
  buildSweepEffects,
  requeueActionsJob,
  requeueActionsJobAsync,
  requeueActionsJobOutcome,
  runFixRung,
} from "./helpers/run-task-test.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const NOW = Date.parse("2026-10-05T21:50:00Z");
const PR = 9388;
const TASK = "W1-T5901";
const HEAD = "2e2dbad7aa";
const NEW_HEAD = "f00dfacecc";
const GATE = "squash-trailer-gate";
const RUNNING = "gh: The workflow run containing this job is already running (HTTP 403)";
const STALE_ATTEMPT = "gh: Only jobs from the current attempt can be re-run (HTTP 403)";
const ALREADY_RUNNING: JobRequeueOutcome = { kind: "deferred", refusal: "already_running", error: RUNNING };
const NOT_CURRENT: JobRequeueOutcome = { kind: "deferred", refusal: "not_current_attempt", error: STALE_ATTEMPT };
const DEDUPED = /fix already dispatched for this head/;
const INFRA_TAIL = [
  "Artifact upload completed successfully!",
  "Finalizing artifact upload",
  "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
].join("\n");

function ledger(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5920-`)), "ledger.ndjson");
}

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: TASK,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T21:47:40Z",
    headSha: HEAD,
    headRefName: "run-W1-T5901-1791200000000",
    autoMergeArmed: false,
    ...over,
  };
}

const cancelledView = (head = HEAD) =>
  view({
    headSha: head,
    ciFailures: [{ name: GATE, logTail: "" }],
    cancelledRequiredChecks: [{ name: GATE, jobId: "111989995761" }],
  });

type Pass = {
  requeued: Array<CancelledRequiredCheck | CiFailure>;
  cancelledEscalations: string[];
  infraEscalations: string[];
  escalations: string[];
  dispatched: number;
  row: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
};

/** One sweep pass over `pr`; `answer` is what GitHub says to each job rerun POST. */
async function pass(
  pr: OpenPrView,
  ledgerPath: string,
  answer: (check: CancelledRequiredCheck | CiFailure) => boolean | JobRequeueOutcome,
  over: Partial<SweepDeps> = {},
): Promise<Pass> {
  const out: Pass = { requeued: [], cancelledEscalations: [], infraEscalations: [], escalations: [], dispatched: 0, row: {}, rows: [] };
  const before = readLedgerLines(ledgerPath).length;
  await runSweep([pr], {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {
      out.dispatched++;
    },
    escalate: (_pr, reason) => {
      out.escalations.push(reason);
    },
    requeueCheck: (_pr, check) => {
      out.requeued.push(check);
      return answer(check);
    },
    escalateCancelledCheck: (_pr, _check, reason) => {
      out.cancelledEscalations.push(reason);
    },
    escalateInfrastructureCheck: (_pr, _check, reason) => {
      out.infraEscalations.push(reason);
    },
    ledgerPath,
    runId: "SWEEP-W1-T5920",
    now: () => NOW,
    ...over,
  });
  out.rows = readLedgerLines(ledgerPath).slice(before);
  const disposed = out.rows.filter((l) => l.step === "sweep.disposed");
  out.row = disposed[disposed.length - 1] ?? {};
  return out;
}

/** W1-T5953: a deferred requeue is retried only by a pass that can see its run. */
const seen: Partial<SweepDeps> = { readCiGateRollup: () => [] };

const rollup = (jobId: string, siblingStatus: "IN_PROGRESS" | "COMPLETED"): RollupCheckEntry[] => [
  {
    name: GATE,
    status: "COMPLETED",
    conclusion: "CANCELLED",
    startedAt: "2026-10-05T21:47:41Z",
    detailsUrl: `https://github.com/craigoley/remudero/actions/runs/900/job/${jobId}`,
  },
  {
    name: "acceptance-author-gate",
    status: siblingStatus,
    ...(siblingStatus === "COMPLETED" ? { conclusion: "SUCCESS" } : {}),
    startedAt: "2026-10-05T21:47:42Z",
    detailsUrl: "https://github.com/craigoley/remudero/actions/runs/900/job/333",
  },
];

test("a 403 already-running refusal is recorded deferred, spends nothing, and is retried at the current attempt once its run concludes", async () => {
  const path = ledger();
  const first = await pass(cancelledView(), path, () => ALREADY_RUNNING);
  assert.equal(first.requeued.length, 1);
  const deferred = first.rows.find((l) => l.step === CHECK_REQUEUE_DEFERRED_STEP);
  assert.ok(deferred, "the refusal is its own ledger row");
  assert.equal(deferred.head_sha, HEAD);
  assert.equal(deferred.check_name, GATE);
  assert.equal(deferred.job_id, "111989995761");
  assert.equal(deferred.refusal, "already_running");
  assert.ok(!requeuedCheckKeysFromLedger(readLedgerLines(path)).has(`${HEAD}@${GATE}`), "the bounded requeue is not spent");
  assert.deepEqual(first.cancelledEscalations, [], "a deferral is not a second cancellation");
  assert.equal(first.dispatched, 0);
  assert.equal(first.row.acted, false);
  assert.match(String(first.row.stand_down_reason), /deferred/);

  // While another job of the same run is still in flight, nothing is POSTed and nothing is counted.
  const waiting = await pass(cancelledView(), path, () => true, { readCiGateRollup: () => rollup("222", "IN_PROGRESS") });
  assert.equal(waiting.requeued.length, 0);
  assert.equal(waiting.row.acted, false);
  assert.match(String(waiting.row.stand_down_reason), /in flight/);
  assert.equal(checkRequeueDeferralsFromLedger(readLedgerLines(path)).get(`${HEAD}@${GATE}`)?.count, 1);

  // The run concluded and the check is still cancelled: requeue it, re-resolving the job id.
  const retried = await pass(cancelledView(), path, () => true, { readCiGateRollup: () => rollup("222", "COMPLETED") });
  assert.equal(retried.requeued.length, 1);
  assert.equal(retried.requeued[0].jobId, "222", "the CURRENT attempt's job, never the stale snapshot's");
  assert.ok(requeuedCheckKeysFromLedger(readLedgerLines(path)).has(`${HEAD}@${GATE}`), "an accepted requeue is spent");

  // An accepted requeue keeps W1-T1223's single-retry bound: a second cancellation escalates.
  const again = await pass(cancelledView(), path, () => true, { readCiGateRollup: () => rollup("444", "COMPLETED") });
  assert.equal(again.requeued.length, 0);
  assert.equal(again.cancelledEscalations.length, 1);
  assert.match(again.cancelledEscalations[0], /already re-queued once/);
});

test("a not-current-attempt refusal of an infrastructure retry is deferred and retried, not escalated as a failed call", async () => {
  const path = ledger();
  const infra = view({ ciFailures: [{ name: "ci-shard (2/4)", conclusion: "FAILURE", jobId: "34249290033", logTail: INFRA_TAIL }] });
  const first = await pass(infra, path, () => NOT_CURRENT);
  assert.equal(first.requeued.length, 1);
  assert.deepEqual(first.infraEscalations, []);
  assert.equal(first.rows.find((l) => l.step === "sweep.ci_infrastructure_requeue")?.outcome, "deferred");
  assert.equal(first.rows.find((l) => l.step === CHECK_REQUEUE_DEFERRED_STEP)?.refusal, "not_current_attempt");
  assert.equal(first.dispatched, 0);

  const second = await pass(infra, path, () => true, seen);
  assert.equal(second.requeued.length, 1, "the deferred retry is taken on the next pass");
  assert.deepEqual(second.infraEscalations, []);
  const third = await pass(infra, path, () => true);
  assert.equal(third.requeued.length, 0, "the accepted retry spent the one bounded requeue");
  assert.equal(third.infraEscalations.length, 1);

  // A refusal that is neither class stays a failed call, spent and escalated as before.
  const failedPath = ledger();
  const failed = await pass(infra, failedPath, () => false);
  assert.equal(failed.infraEscalations.length, 1);
  assert.ok(requeuedCheckKeysFromLedger(readLedgerLines(failedPath)).has(`${HEAD}@ci-shard (2/4)`));
});

/** `n` deferred attempts for `check` at `head`: each bounding row followed by its deferral. */
function deferrals(n: number, head = HEAD, check = GATE, refusal = "already_running"): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => [
    { step: CHECK_REQUEUE_STEP, task_id: TASK, pr_number: PR, head_sha: head, check_name: check },
    { step: CHECK_REQUEUE_DEFERRED_STEP, task_id: TASK, pr_number: PR, head_sha: head, check_name: check,
      job_id: String(100 + i), refusal, outcome: "deferred" },
  ]).flat();
}

const seeded = (rows: Array<Record<string, unknown>>) => ({ readLedger: (p: string) => [...rows, ...readLedgerLines(p)] } as Partial<SweepDeps>);

test("CHECK_REQUEUE_DEFERRAL_BACKSTOP deferrals escalate exactly once, naming the refusal", async () => {
  assert.ok(Number.isInteger(CHECK_REQUEUE_DEFERRAL_BACKSTOP) && CHECK_REQUEUE_DEFERRAL_BACKSTOP >= 2);
  const below = await pass(cancelledView(), ledger(), () => true, { ...seeded(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP - 1)), ...seen });
  assert.equal(below.requeued.length, 1, "below the bound the deferred requeue is retried");
  assert.deepEqual(below.cancelledEscalations, []);

  const path = ledger();
  const at = await pass(cancelledView(), path, () => true, seeded(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP)));
  assert.equal(at.requeued.length, 0, "at the bound no further POST");
  assert.equal(at.cancelledEscalations.length, 1);
  assert.match(at.cancelledEscalations[0], /already_running/);
  assert.ok(at.cancelledEscalations[0].includes(String(CHECK_REQUEUE_DEFERRAL_BACKSTOP)));
  assert.equal(at.dispatched, 0);
  assert.equal(at.row.acted, false);
  const after = await pass(cancelledView(), path, () => true, seeded(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP)));
  assert.deepEqual(after.cancelledEscalations, [], "escalated once per (head, check)");
  assert.equal(after.requeued.length, 0);
  assert.equal(after.dispatched, 0);

  const infra = view({ ciFailures: [{ name: "ci-shard (2/4)", conclusion: "FAILURE", jobId: "1", logTail: INFRA_TAIL }] });
  const infraAt = await pass(infra, ledger(), () => true, seeded(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP, HEAD, "ci-shard (2/4)", "not_current_attempt")));
  assert.equal(infraAt.requeued.length, 0);
  assert.equal(infraAt.infraEscalations.length, 1);
  assert.match(infraAt.infraEscalations[0], /not_current_attempt/);
});

test("a new head resets the deferral count", async () => {
  const fresh = await pass(cancelledView(NEW_HEAD), ledger(), () => true, seeded(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP)));
  assert.equal(fresh.requeued.length, 1);
  assert.deepEqual(fresh.cancelledEscalations, []);
  assert.equal(checkRequeueDeferralsFromLedger(deferrals(2)).get(`${NEW_HEAD}@${GATE}`), undefined);
});

test("only an accepted requeue is spent: a deferral voids its own bounding row", () => {
  const key = `${HEAD}@${GATE}`;
  const attempt = { step: CHECK_REQUEUE_STEP, head_sha: HEAD, check_name: GATE };
  assert.ok(requeuedCheckKeysFromLedger([attempt]).has(key), "an accepted (or crashed-mid-call) attempt is spent");
  assert.ok(!requeuedCheckKeysFromLedger(deferrals(1)).has(key), "a refused-while-running attempt is not");
  assert.ok(requeuedCheckKeysFromLedger([...deferrals(2), attempt]).has(key), "an accepted retry after deferrals is spent");
  const escalated = { step: CHECK_REQUEUE_DEFERRED_STEP, head_sha: HEAD, check_name: GATE, refusal: "already_running", outcome: "escalated" };
  assert.deepEqual(checkRequeueDeferralsFromLedger([...deferrals(2), escalated]).get(key), { count: 2, escalated: true, refusal: "already_running" });
  assert.equal(checkRequeueDeferralsFromLedger([{ step: CHECK_REQUEUE_DEFERRED_STEP, head_sha: HEAD }]).size, 0);
});

test("the refusal classifier names the two in-flight 403s and nothing else", () => {
  assert.equal(jobRerunRefusal(RUNNING), "already_running");
  assert.equal(jobRerunRefusal(STALE_ATTEMPT), "not_current_attempt");
  assert.equal(jobRerunRefusal("gh: Resource not accessible by integration (HTTP 403)"), undefined);
  assert.equal(jobRerunRefusal("The workflow run containing this job is already running (HTTP 500)"), undefined);
  assert.deepEqual(jobRequeueOutcome(true), { kind: "dispatched" });
  assert.deepEqual(jobRequeueOutcome(undefined), { kind: "dispatched" });
  assert.deepEqual(jobRequeueOutcome(false), { kind: "failed" });
  assert.deepEqual(jobRequeueOutcome(ALREADY_RUNNING), ALREADY_RUNNING);
  assert.equal(deferredRequeueTarget(undefined, GATE), undefined, "no rollup proves nothing (W1-T5953)");
  assert.deepEqual(deferredRequeueTarget(rollup("222", "IN_PROGRESS"), GATE), { jobId: "222", runInFlight: true });
  assert.deepEqual(deferredRequeueTarget(rollup("222", "COMPLETED"), GATE), { jobId: "222", runInFlight: false });
  assert.deepEqual(deferredRequeueTarget([{ name: GATE, conclusion: "CANCELLED", jobId: "9" }, { name: "x", status: "QUEUED" }], GATE),
    { jobId: "9", runInFlight: false }, "no run identity: nothing proves the run is in flight");
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(CHECK_REQUEUE_DEFERRED_STEP));
});

// ── the fix rung's FLAKE rerun ──────────────────────────────────────────────────────────────────

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];

function flakeRound(requeueCheck: Run["deps"]["requeueCheck"], green = false) {
  const repo = gitRepo({ kind: "t5920-flake" });
  const rows: Row[] = [];
  let waits = 0;
  const review = {
    state: "failure", criteria: [], testTheater: false, summary: "red", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure",
  } as Run["initialReview"];
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text: "REPORT\nFIX_OUTCOME: FLAKE", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
  const run: Run = {
    taskId: TASK, runId: "flake-run", task: { id: TASK, title: "flake", files: ["src/fix.ts"] },
    prUrl: `https://github.com/acme/remudero/pull/${PR}`, branch: "run-W1-T5901-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "ci", logTail: "not ok 3 - flaky", jobId: "123" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => worker,
      waitForCiGreen: async () => { waits++; return green ? "green" : "red"; },
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: TASK, ...extra }), say: () => {}, account: (r) => r,
      requeueCheck,
    },
  };
  return { run, rows, waits: () => waits };
}

test("a FLAKE round whose requeue was refused while running records requeue_deferred and is read as stalled", async () => {
  const f = flakeRound(() => ALREADY_RUNNING);
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.waits(), 0, "nothing was requeued, so there is no CI verdict to wait for");
  const done = f.rows.find((r) => r.step === "fix.done");
  assert.equal(done?.flake_claim, "requeue_deferred");
  const deferred = f.rows.find((r) => r.step === CHECK_REQUEUE_DEFERRED_STEP);
  assert.equal(deferred?.refusal, "already_running");
  assert.equal(deferred?.head_sha, HEAD);
  assert.equal(deferred?.job_id, "123");
  assert.ok(!requeuedCheckKeysFromLedger(f.rows).has(`${HEAD}@ci`), "the refused rerun did not spend the key");
  assert.equal(fixRungStalledWithoutNewHead(f.rows, TASK), true, "a deferred FLAKE holds no dedup");

  // A later round can still take the requeue: the key was never spent.
  const calls: string[] = [];
  f.run.deps.requeueCheck = (failure) => { calls.push(String(failure.jobId)); return true; };
  await runFixRung(f.run);
  assert.deepEqual(calls, ["123"]);
  assert.equal(f.rows.filter((r) => r.step === "fix.done").at(-1)?.flake_claim, "refuted");
  assert.equal(fixRungStalledWithoutNewHead(f.rows, TASK), false, "an accepted requeue keeps today's accounting");
});

test("a FLAKE round with an accepted requeue keeps confirmed/refuted accounting", async () => {
  for (const green of [true, false]) {
    const f = flakeRound(() => true, green);
    const result = await runFixRung(f.run);
    assert.equal(result.strikes, green ? 0 : 1);
    assert.equal(f.rows.find((r) => r.step === "fix.done")?.flake_claim, green ? "confirmed" : "refuted");
    assert.equal(f.rows.some((r) => r.step === CHECK_REQUEUE_DEFERRED_STEP), false);
    assert.equal(fixRungStalledWithoutNewHead(f.rows, TASK), false);
  }
  const thrown = flakeRound(() => { throw new Error("queue offline"); });
  await runFixRung(thrown.run);
  assert.match(String(thrown.rows.find((r) => r.step === "fix.flake_requeue_failed")?.reason), /queue offline/);
  assert.equal(thrown.rows.find((r) => r.step === "fix.done")?.flake_claim, "refuted");
});

test("the FLAKE rerun's real gh seam classifies a 403 already-running refusal under a fix-lane step", async () => {
  const shim = ghShim([{ when: "actions/jobs/123/rerun", stderr: RUNNING, exit: 1 }], { kind: "t5920-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    const f = flakeRound(undefined);
    await runFixRung(f.run);
    assert.ok(shim.calls().some((c) => c.includes("-X POST repos/acme/remudero/actions/jobs/123/rerun")), shim.calls().join("\n"));
    assert.equal(f.rows.find((r) => r.step === "fix.done")?.flake_claim, "requeue_deferred");
    assert.match(String(f.rows.find((r) => r.step === "fix.flake_requeue.error")?.error), /already running/);
    assert.equal(f.rows.some((r) => r.step === "main.health.ci_requeue.error"), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("requeueActionsJobOutcome names each arm, and the main-health wrappers keep their boolean", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void logs.push({ step, extra });
  const throwing = (message: string) => () => { throw new Error(message); };
  assert.deepEqual(requeueActionsJobOutcome("o", "r", { name: "ci", jobId: "1" }, log, throwing(RUNNING)), ALREADY_RUNNING);
  assert.deepEqual(requeueActionsJobOutcome("o", "r", { name: "ci", jobId: "1" }, log, throwing(STALE_ATTEMPT)), NOT_CURRENT);
  assert.deepEqual(requeueActionsJobOutcome("o", "r", { name: "ci", jobId: "1" }, log, throwing("boom")), { kind: "failed", error: "boom" });
  assert.deepEqual(requeueActionsJobOutcome("o", "r", { name: "ci" }, log, () => ""), { kind: "failed", error: "no resolvable Actions job id" });
  assert.deepEqual(requeueActionsJobOutcome("o", "r", { name: "ci", jobId: "1" }, log, () => ""), { kind: "dispatched" });
  assert.deepEqual(logs.map((l) => l.step), ["fix.flake_requeue.error", "fix.flake_requeue.error", "fix.flake_requeue.error"]);
  logs.length = 0;
  assert.equal(requeueActionsJob("o", "r", { name: "ci", jobId: "1" }, log, throwing(RUNNING)), false);
  assert.equal(requeueActionsJob("o", "r", { name: "ci", jobId: "1" }, log, () => ""), true);
  assert.equal(await requeueActionsJobAsync("o", "r", { name: "ci", jobId: "1" }, log, throwing(RUNNING)), false);
  assert.equal(await requeueActionsJobAsync("o", "r", { name: "ci", jobId: "1" }, log, () => ""), true);
  assert.deepEqual(logs.map((l) => l.step), ["main.health.ci_requeue.error", "main.health.ci_requeue.error"]);
});

test("the sweep's requeueCheck effect returns a deferred outcome for an in-flight 403 and false for any other refusal", async () => {
  const logged: string[] = [];
  const effects = (error: string) => buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5920-root-`)) } as never,
    ledgerPath: ledger(),
    runId: "SWEEP-T5920",
    plan: { tasks: [] } as never,
    log: (step) => void logged.push(step),
    policy: undefined,
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: undefined,
    stallNotice: undefined,
    armImpl: undefined,
    armSessionPrsOverride: undefined,
    updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined,
    ghRunImpl: () => {
      throw new Error(error);
    },
  });
  const pr = view();
  assert.deepEqual(await effects(RUNNING).requeueCheck?.(pr, { name: GATE, jobId: "1" }), ALREADY_RUNNING);
  assert.deepEqual(await effects(STALE_ATTEMPT).requeueCheck?.(pr, { name: GATE, jobId: "1" }), NOT_CURRENT);
  assert.equal(await effects("gh: Not Found (HTTP 404)").requeueCheck?.(pr, { name: GATE, jobId: "1" }), false);
  assert.deepEqual(logged, ["sweep.check_requeue.error", "sweep.check_requeue.error", "sweep.check_requeue.error"]);
});

// ── the sweep's dispatch dedup after a FLAKE round ──────────────────────────────────────────────

const flakeFailure: CiFailure = { name: "ci", logTail: "not ok 3 - flaky\n# fail 1", jobId: "555" };
const flakeView = (head = HEAD) => view({ headSha: head, ciFailures: [flakeFailure] });

function flakeHistory(claim: string, head = HEAD): Array<Record<string, unknown>> {
  return [
    { step: "fix.dispatch", task_id: TASK, head_sha: head },
    { step: "sweep.disposed", acted: true, pr_number: PR, head_sha: head, disposition: "blocked-fixable" },
    { step: CHECK_REQUEUE_STEP, task_id: TASK, head_sha: head, check_name: "ci", job_id: "555" },
    ...(claim === "requeue_deferred"
      ? [{ step: CHECK_REQUEUE_DEFERRED_STEP, task_id: TASK, head_sha: head, check_name: "ci", job_id: "555", refusal: "already_running", outcome: "deferred" }]
      : []),
    { step: "fix.done", task_id: TASK, head_sha: head, fix_outcome: "FLAKE", flake_claim: claim },
  ];
}

test("a FLAKE outcome whose requeue never landed does not hold the head under fix already dispatched", async () => {
  const next = await pass(flakeView(), ledger(), () => true, { ...seeded(flakeHistory("requeue_deferred")), ...seen });
  assert.doesNotMatch(String(next.row.stand_down_reason), DEDUPED);
  assert.deepEqual(next.requeued.map((c) => c.jobId), ["555"], "the deferred requeue is taken before another strike");
  assert.equal(next.dispatched, 0);
  assert.equal(next.row.acted, false);
  assert.match(String(next.row.stand_down_reason), /deferred requeue/);

  // Accepted requeues keep the dedup: confirmed or refuted, the head stays held.
  for (const claim of ["refuted", "confirmed"]) {
    const held = await pass(flakeView(), ledger(), () => true, seeded(flakeHistory(claim)));
    assert.match(String(held.row.stand_down_reason), DEDUPED, claim);
    assert.equal(held.requeued.length, 0);
    assert.equal(held.dispatched, 0);
  }
});

test("a FLAKE check's deferrals at the bound escalate once, and a new head starts from zero", async () => {
  const history = [...flakeHistory("requeue_deferred"), ...deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP - 1, HEAD, "ci")];
  const path = ledger();
  const at = await pass(flakeView(), path, () => true, seeded(history));
  assert.equal(at.requeued.length, 0);
  assert.equal(at.escalations.length, 1);
  assert.match(at.escalations[0], /already_running/);
  assert.equal(at.dispatched, 0);
  const after = await pass(flakeView(), path, () => true, seeded(history));
  assert.deepEqual(after.escalations, []);
  assert.equal(after.requeued.length, 0);

  const moved = await pass(flakeView(NEW_HEAD), ledger(), () => true, seeded(history));
  assert.equal(moved.requeued.length, 0, "no deferral at the new head: an ordinary red");
  assert.equal(moved.dispatched, 1);
});
