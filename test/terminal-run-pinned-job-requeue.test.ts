// test/terminal-run-pinned-job-requeue.test.ts — W1-T2947.
//
// LIVE 2026-09-06, PR #4226: CI run 34019507513 concluded success while its leak-grep job 101449352638
// stayed in_progress. W1-T2340 named the impossible state correctly, but the disposition opened #4227
// for a human; one POST to actions/jobs/101449352638/rerun (HTTP 201) finished attempt 2 in eight
// seconds. The sweep already owns that single-job requeue (W1-T1223); this routes the pinned job there
// first, bounded by the same head+check ledger row, and escalates naming the job on a second sighting.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_REQUEUE_DEFERRED_STEP,
  CHECK_REQUEUE_STEP,
  runSweep,
  stalledRunPinnedJob,
  stalledRunReason,
  type CancelledRequiredCheck,
  type CiFailure,
  type JobRequeueOutcome,
  type OpenPrView,
  type WorkflowRunObservation,
} from "./helpers/sweep-test.js";
import { fetchWorkflowRunObservations } from "../src/lib/open-prs-rest.js";
import { requeueActionsJobOutcome } from "./helpers/run-task-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-09-06T07:49:00Z");
const PR = 4226;
const HEAD = "91cd0678481ab442963cd7d5280bb9ecd3078164";
const JOB_NAME = "leak-grep";
const JOB_ID = "101449352638";

const pinnedRun = (job: Record<string, unknown> = { status: "in_progress", name: JOB_NAME, id: JOB_ID }): WorkflowRunObservation => ({
  conclusion: "success",
  jobs: [{ status: "completed", name: "ci-gate", id: "101449352000" }, job as { status?: string }],
});

function view(workflowRuns: readonly WorkflowRunObservation[] | undefined, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: "W1-T2340",
    reviewState: "none",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-06T07:40:00Z",
    headSha: HEAD,
    headRefName: "run-W1-T2340-1791200000000",
    autoMergeArmed: false,
    workflowRuns,
    ...over,
  };
}

const ledger = () => join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2947-`)), "ledger.ndjson");

interface Pass {
  requeued: Array<CancelledRequiredCheck | CiFailure>;
  escalations: string[];
  dispatched: number;
  rows: Array<Record<string, unknown>>;
  /** Ledger rows already on disk at the moment the requeue effect ran. */
  rowsWhenEffectRan: Array<Record<string, unknown>>;
  disposed: Record<string, unknown> | undefined;
}

async function pass(
  pr: OpenPrView,
  ledgerPath: string,
  answer: boolean | JobRequeueOutcome = true,
  over: Record<string, unknown> = {},
): Promise<Pass> {
  const out: Pass = { requeued: [], escalations: [], dispatched: 0, rows: [], rowsWhenEffectRan: [], disposed: undefined };
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
      out.rowsWhenEffectRan = readLedgerLines(ledgerPath).slice(before);
      return answer;
    },
    ledgerPath,
    runId: "SWEEP-W1-T2947",
    now: () => NOW,
    ...over,
  });
  out.rows = readLedgerLines(ledgerPath).slice(before);
  out.disposed = out.rows.filter((l) => l.step === "sweep.disposed").at(-1);
  return out;
}

// ── the REST producer ───────────────────────────────────────────────────────────────────────────

function fetcherFor(jobs: unknown): (args: string[]) => unknown {
  return (args) => {
    const path = args[1] ?? "";
    if (path.includes("head_sha=")) return { workflow_runs: [{ id: 34019507513, run_attempt: 1, conclusion: "success" }] };
    if (path.includes("/jobs")) return { jobs };
    throw new Error(`no stub for ${path}`);
  };
}

function observe(jobs: unknown): WorkflowRunObservation[] {
  const cache = new Map();
  const suspects = new Set<string>();
  const fetch = fetcherFor(jobs);
  fetchWorkflowRunObservations("craigoley", "remudero", HEAD, fetch, cache, suspects); // first sighting is a suspicion
  return fetchWorkflowRunObservations("craigoley", "remudero", HEAD, fetch, cache, suspects);
}

test("the REST producer preserves the exact pinned job name and job id from the concluded run's jobs response", () => {
  const obs = observe([
    { status: "completed", conclusion: "success", name: "ci-gate", id: 101449352000 },
    { status: "in_progress", conclusion: "success", name: JOB_NAME, id: 101449352638 },
  ]);
  assert.deepEqual(obs[0]!.jobs![1], { status: "in_progress", name: JOB_NAME, id: JOB_ID });
  assert.deepEqual(stalledRunPinnedJob(obs), { name: JOB_NAME, jobId: JOB_ID });
});

test("the REST producer carries no name or id key for a job that lacks a usable one", () => {
  const obs = observe([{ status: "in_progress", name: "", id: 0 }, { status: "queued", name: 7, id: "9" }]);
  assert.deepEqual(obs[0]!.jobs, [{ status: "in_progress" }, { status: "queued" }]);
  assert.equal(stalledRunPinnedJob(obs), undefined, "a job we cannot name authorizes no mutation");
});

// ── the sweep route ─────────────────────────────────────────────────────────────────────────────

test("a non-terminal job inside a terminal run is requeued through the existing single-job effect instead of opening an immediate clarification issue", async () => {
  const path = ledger();
  const first = await pass(view([pinnedRun()]), path);
  assert.deepEqual(first.requeued, [{ name: JOB_NAME, jobId: JOB_ID }]);
  assert.deepEqual(first.escalations, [], "no clarification issue on the first sighting");
  assert.equal(first.dispatched, 0);
  assert.match(String(first.disposed?.stand_down_reason ?? first.disposed?.reason), /re-queued/);
});

test("the requeue record is written before the effect and bounds the same head and check to one unattended attempt", async () => {
  const path = ledger();
  const first = await pass(view([pinnedRun()]), path);
  const before = first.rowsWhenEffectRan.find((r) => r.step === CHECK_REQUEUE_STEP);
  assert.ok(before, "the bounding row is already on disk when the POST effect runs");
  assert.equal(before.head_sha, HEAD);
  assert.equal(before.check_name, JOB_NAME);
  assert.equal(before.job_id, JOB_ID);
  assert.equal(before.worker_strike_avoided, true);
  // The very next observation of the same head reads that row back and spends nothing more.
  const second = await pass(view([pinnedRun()]), path);
  assert.deepEqual(second.requeued, []);
  assert.equal(second.rows.filter((r) => r.step === CHECK_REQUEUE_STEP).length, 0);
});

test("a second pinned observation on the same head escalates naming the job rather than requeueing again", async () => {
  const path = ledger();
  await pass(view([pinnedRun()]), path);
  const second = await pass(view([pinnedRun()]), path);
  assert.deepEqual(second.requeued, []);
  assert.equal(second.escalations.length, 1);
  assert.match(second.escalations[0]!, new RegExp(`pinned job "${JOB_NAME}" \\(id ${JOB_ID}\\)`));
  assert.match(second.escalations[0]!, /already sent its one bounded single-job requeue/);
  // A NEW head re-earns its own requeue.
  const moved = await pass(view([pinnedRun()], { headSha: "f".repeat(40) }), path);
  assert.equal(moved.requeued.length, 1);
});

test("a requeue whose API call failed escalates naming the job and is not retried", async () => {
  const path = ledger();
  const first = await pass(view([pinnedRun()]), path, false);
  assert.equal(first.requeued.length, 1);
  assert.equal(first.escalations.length, 1);
  assert.match(first.escalations[0]!, /single-job rerun of pinned job "leak-grep" \(id 101449352638\) failed/);
  const second = await pass(view([pinnedRun()]), path, false);
  assert.deepEqual(second.requeued, []);
});

test("a requeue GitHub deferred because its run is in flight escalates on the next observation, never loops", async () => {
  const path = ledger();
  const deferred: JobRequeueOutcome = { kind: "deferred", refusal: "already_running", error: "(HTTP 403)" };
  const first = await pass(view([pinnedRun()]), path, deferred);
  assert.deepEqual(first.escalations, []);
  assert.ok(first.rows.some((r) => r.step === CHECK_REQUEUE_DEFERRED_STEP));
  const second = await pass(view([pinnedRun()]), path, deferred);
  assert.deepEqual(second.requeued, []);
  assert.equal(second.escalations.length, 1);
  assert.match(second.escalations[0]!, /pinned job "leak-grep"/);
});

test("a run still in progress and a terminal run whose jobs are all terminal retain their existing dispositions and trigger no requeue", async () => {
  const inProgress = await pass(view([{ conclusion: undefined, jobs: [{ status: "in_progress", name: JOB_NAME, id: JOB_ID }] }]), ledger());
  assert.deepEqual(inProgress.requeued, []);
  assert.equal(stalledRunReason([{ jobs: [{ status: "in_progress", name: JOB_NAME, id: JOB_ID }] }]), undefined);
  const allTerminal = await pass(view([{ conclusion: "success", jobs: [{ status: "completed", name: JOB_NAME, id: JOB_ID }] }]), ledger());
  assert.deepEqual(allTerminal.requeued, []);
  assert.deepEqual(allTerminal.escalations, []);
  assert.doesNotMatch(String(allTerminal.disposed?.reason), /stalled, not pending/);
});

test("an unreadable jobs response or a pinned job without an id triggers no guessed mutation and retains the fail-closed escalation", async () => {
  const unreadable = await pass(view([{ conclusion: "success", jobs: undefined }]), ledger());
  assert.deepEqual(unreadable.requeued, []);
  assert.equal(stalledRunReason([{ conclusion: "success", jobs: undefined }]), undefined, "unreadable stays not-stalled, as before");

  for (const job of [{ status: "in_progress", name: JOB_NAME }, { status: "in_progress", id: JOB_ID }]) {
    const noIdentity = await pass(view([pinnedRun(job)]), ledger());
    assert.deepEqual(noIdentity.requeued, [], "no guessed mutation");
    assert.equal(noIdentity.escalations.length, 1, "the existing fail-closed escalation stands");
    assert.match(noIdentity.escalations[0]!, /stalled, not pending/);
  }
});

test("with no requeue effect wired the stalled run still escalates as before", async () => {
  const out: string[] = [];
  await runSweep([view([pinnedRun()])], {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (_pr, reason) => {
      out.push(reason);
    },
    ledgerPath: ledger(),
    runId: "SWEEP-W1-T2947",
    now: () => NOW,
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /stalled, not pending/);
});

test("the action targets actions/jobs/{job_id}/rerun through the existing dependency and never a workflow-run endpoint", async () => {
  const path = ledger();
  const first = await pass(view([pinnedRun()]), path);
  assert.deepEqual(first.requeued.map((c) => c.jobId), [JOB_ID], "the dependency receives the job id, never a run id");
  const calls: string[][] = [];
  const outcome = requeueActionsJobOutcome("craigoley", "remudero", first.requeued[0]!, () => {}, (args) => {
    calls.push(args);
    return "";
  });
  assert.equal(outcome.kind, "dispatched");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes(`repos/craigoley/remudero/actions/jobs/${JOB_ID}/rerun`), calls[0]!.join(" "));
  assert.ok(!calls.flat().some((a) => /actions\/runs\//.test(a)), "never a workflow-run endpoint");
});

test("the recovery spends no worker strike and adds no timer, polling loop, sleep, merge, or lifecycle action", async () => {
  const path = ledger();
  let timers = 0;
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  // @ts-expect-error — instrumenting for the duration of this one pass only
  global.setTimeout = (...args: unknown[]) => {
    timers++;
    // @ts-expect-error node's timer overloads do not matter for the wrapper
    return realTimeout(...args);
  };
  // @ts-expect-error — instrumenting for the duration of this one pass only
  global.setInterval = (...args: unknown[]) => {
    timers++;
    // @ts-expect-error node's timer overloads do not matter for the wrapper
    return realInterval(...args);
  };
  let armed = 0;
  let closed = 0;
  let first: Pass;
  try {
    first = await pass(view([pinnedRun()]), path, true, { arm: () => { armed++; }, close: () => { closed++; } });
  } finally {
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
  }
  assert.equal(first.dispatched, 0, "no fix worker is dispatched");
  assert.equal(armed + closed, 0, "no merge or lifecycle action");
  assert.equal(timers, 0, "no timer, sleep or polling loop");
  assert.ok(!first.rows.some((r) => String(r.step).startsWith("fix.")), "no strike row of any kind");
  assert.equal(first.disposed?.acted, false, "the recovery does not seed an escalation dedup");
});
