import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, FIX_DISPATCH_FAILED_BACKSTOP, PLAN_REPAIR_DISPATCH_STEP,
  runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { incidentEventFromLedgerRow } from "#src/lib/sre-lane.js";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
type Row = Record<string, unknown>;
let fixtureId = 0;

function pr(prNumber = 10783, overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: "a".repeat(40), headRefName: `run-W1-T${prNumber}-1`, reviewState: "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(1),
    autoMergeArmed: false, ...overrides,
  };
}

function history(view: OpenPrView, count: number, reason: (i: number) => string): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: ago(150 - i), step: "sweep.disposed", pr_number: view.prNumber, task_id: view.taskId,
    head_sha: view.headSha, blocker: "awaiting-review", blocker_since: ago(150),
    disposition: "post-review", acted: false, reason: reason(i),
  }));
}

function fixture(historyRows: Row[] = [], overrides: Partial<SweepDeps> = {}) {
  const rows = [...historyRows];
  const escalations: Array<{ pr: number; reason: string; cause?: string }> = [];
  const deps: SweepDeps = {
    ledgerPath: `/dev/null/w1-t8267-${fixtureId++}.ndjson`, runId: "W1-T8267-test", now: () => NOW,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: () => {}, actionable: () => false,
    escalate: (view, reason, question) => { escalations.push({ pr: view.prNumber, reason, cause: question.cause }); },
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, ...overrides,
  };
  return { deps, escalations, rows: (step: string) => rows.filter(row => row.step === step) };
}

test("W1-T8267: a stalled stage names the reason it kept repeating", async () => {
  const view = pr();
  const reason = "remudero-review owner proven dead — re-running";
  const f = fixture([
    ...history(view, 100, () => "old stage reason").map(row => ({ ...row, ts: ago(200), blocker_since: ago(200) })),
    ...history(pr(10848), 100, () => "another PR's reason"),
    ...history(view, 85, () => reason),
    ...history(view, 3, () => "a minority reason"),
  ]);
  await runSweep([view], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, `repeat: "${reason}" x85`);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.escalations[0].cause, "stage-stall");
  assert.match(f.escalations[0].reason, /owner proven dead — re-running" x85/);
  await runSweep([view], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("incident.event").length, 1);
  assert.equal(f.escalations.length, 1);
});

test("W1-T8267: an ownerless blocker is stalled at once", async () => {
  const view = pr(10842, { isPlanFiling: true, checksState: "red", reviewState: "pending",
    ciFailures: [{ name: "lint-plan", conclusion: "FAILURE", logTail: "plan proof cannot run" }] });
  const f = fixture();
  await runSweep([view], f.deps);
  const disposed = f.rows("sweep.disposed").find(row => row.pr_number === view.prNumber);
  assert.equal(disposed?.blocker, "plan-proof-unrunnable");
  assert.equal(disposed.blocker_owner, "NONE");
  assert.equal(disposed.stage_stuck, true);
  assert.equal(f.rows("pr.stuck").length, 1);
  const stalled = f.rows("pr.stuck")[0];
  assert.equal(stalled.blocker_age_ms, 0);
  assert.equal(stalled.owner, "none");
  assert.equal(stalled.diagnosis, "unknown signature");
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0].reason, /owner: none/);
  assert.equal(f.rows("incident.event").length, 1);
  await runSweep([view], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("incident.event").length, 1);
});

test("W1-T8267: one signature across PRs is one incident fingerprint", async () => {
  const first = pr();
  const second = pr(10848);
  const reason = (view: OpenPrView, i: number) =>
    `remudero-review owner proven dead — re-running #${view.prNumber} at ${i % 2 ? "abc1234" : "def5678"} ` +
    `after ${i % 2 ? "2 minutes" : "30s"} (attempt ${i + 1})`;
  const f = fixture([...history(first, 5, i => reason(first, i)), ...history(second, 3, i => reason(second, i))]);
  await runSweep([first, second], f.deps);
  assert.equal(f.rows("pr.stuck").length, 2);
  const events = f.rows("incident.event");
  assert.equal(events.length, 2);
  const signature = "remudero-review owner proven dead — re-running #<pr> at <sha> after <duration> (attempt <n>)";
  const name = `pr-stage-stall:awaiting-review:${signature}`;
  const fingerprint = createHash("sha256").update(`flow\u0000${name}`, "utf8").digest("hex");
  assert.deepEqual(events.map(event => event.name), [name, name]);
  assert.deepEqual(events.map(event => event.fingerprint), [fingerprint, fingerprint]);
  assert.deepEqual(events.map(event => event.subject), ["pr=10783", "pr=10848"]);
  for (const event of events) {
    assert.equal(event.kind, "flow");
    assert.equal(event.task_id, "INCIDENT");
    assert.ok(incidentEventFromLedgerRow(event, "test"));
    assert.ok(String(event.message).startsWith(`${event.subject} `));
  }
  assert.match(String(f.rows("pr.stuck")[0].diagnosis), /x5$/);
  assert.match(String(f.rows("pr.stuck")[1].diagnosis), /x3$/);
});

test("W1-T8267: a single disposition reason keeps the unknown-signature fallback", async () => {
  const view = pr();
  const f = fixture(history(view, 1, () => "one isolated reason"));
  await runSweep([view], f.deps);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "unknown signature");
  assert.equal(f.rows("incident.event")[0].name, "pr-stage-stall:awaiting-review:unknown signature");
});

test("W1-T8267: an owned stage keeps its backstop and previews write nothing", async () => {
  const view = pr();
  const young = fixture(history(view, 2, () => "repeated but young").map(row => ({
    ...row, ts: ago(2), blocker_since: ago(2),
  })));
  await runSweep([view], young.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(young.rows("pr.stuck").length, 0);
  assert.equal(young.rows("incident.event").length, 0);
  const preview = fixture([], { dryRun: true });
  await runSweep([pr(10842, { isPlanFiling: true, checksState: "red" })], preview.deps);
  assert.equal(preview.rows("pr.stuck").length, 0);
  assert.equal(preview.rows("incident.event").length, 0);
  assert.equal(preview.escalations.length, 0);
});

test("W1-T8267: an ownerless stage reuses an escalation made by its disposition", async () => {
  const view = pr(10842, { isPlanFiling: true, checksState: "red", reviewState: "pending",
    ciFailures: [{ name: "lint-plan", conclusion: "FAILURE", logTail: "plan proof cannot run" }] });
  const f = fixture([], { actionable: () => true });
  await runSweep([view], f.deps);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].owner, "none");
  assert.equal(f.rows("incident.event").length, 1);
  await runSweep([view], f.deps);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.rows("incident.event").length, 1);
});

test("W1-T8267: a PR closed by its disposition has no stalled stage", async () => {
  const view = pr(10842, { taskMergedBy: 10848 });
  let closed = 0;
  const f = fixture([], { actionable: () => true, close: () => { closed++; } });
  await runSweep([view], f.deps);
  assert.equal(closed, 1);
  assert.equal(f.rows("pr.stuck").length, 0);
  assert.equal(f.rows("incident.event").length, 0);
  assert.equal(f.escalations.length, 0);
});

test("W1-T8267: an ownerless stage preserves a repair judge's wait and recovery", async () => {
  const view = pr(7243, { reviewState: "success", priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const proof = { claim: "a repair discriminates", proof: "unit test: a repair discriminates",
    met: true, reason: "keyword floor", proof_exec: "not_executable" };
  let recovered = false;
  let repairs = 0;
  const f = fixture([
    { task_id: view.taskId, step: "review.posted", pr_url: view.prUrl, head_sha: view.headSha,
      state: "success", capped: true, plan_only: false,
      decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [proof] } },
    ...Array.from({ length: 2 }, () => ({ task_id: view.taskId, step: PLAN_REPAIR_DISPATCH_STEP,
      pr_number: view.prNumber, outcome: "dispatched" })),
  ], {
    actionable: () => true,
    fixProgressJudge: async () => recovered ? { verdict: "continue", reason: "new proof evidence" } : undefined,
    dispatchPlanOnlyRepair: () => { repairs++; return true; },
  });
  const held = await runSweep([view], f.deps);
  assert.equal(held.actions[0].disposition, "wait");
  assert.equal(repairs, 0);
  assert.equal(f.escalations.length, 0);
  assert.equal(f.rows("pr.stuck")[0].owner, "none");
  assert.equal(f.rows("incident.event").length, 1);
  recovered = true;
  await runSweep([view], f.deps);
  assert.equal(repairs, 1);
  assert.equal(f.escalations.length, 0);
});

test("W1-T8267: a dispatch backstop owns its escalation while the ownerless stage records an incident", async () => {
  const view = pr(7243, { checksState: "red", reviewState: "pending",
    ciFailures: [{ name: "ci", logTail: "test failed" }] });
  const f = fixture(Array.from({ length: FIX_DISPATCH_FAILED_BACKSTOP }, () => ({
    task_id: view.taskId, step: "sweep.fix.dispatch_failed", pr_number: view.prNumber,
    head_sha: view.headSha, error: "worker launch failed",
  })), { actionable: () => true });
  await runSweep([view], f.deps);
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0].reason, /FIX_DISPATCH_FAILED_BACKSTOP/);
  assert.equal(f.rows("pr.stuck")[0].owner, "none");
  assert.equal(f.rows("incident.event").length, 1);
  await runSweep([view], f.deps);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.rows("pr.stuck").length, 1);
});

test("W1-T8267: an unreadable stage history preserves a completed review and names the read failure", async () => {
  let reviewed = false;
  const observations: Row[] = [];
  const f = fixture([], {
    actionable: () => true,
    postReview: () => { reviewed = true; },
    reviewerCodeStaleThisPass: () => ({ oldSha: "old", newSha: "new" }),
    log: (step, fields) => { observations.push({ step, ...fields }); },
    readLedger: () => {
      if (reviewed) throw new Error("stage history unavailable");
      return [];
    },
  });
  const result = await runSweep([pr()], f.deps);
  assert.equal(result.actions[0].acted, true);
  assert.equal(result.actions[0].actionError, undefined);
  assert.equal(f.escalations.length, 0);
  assert.equal(f.rows("pr.stuck")[0].stage_history_error, "Error: stage history unavailable");
  assert.match(String(f.rows("pr.stuck")[0].diagnosis), /stage history unavailable/);
  assert.equal(f.rows("incident.event").length, 1);
  assert.deepEqual(observations.find(row => row.step === "sweep.stuck_history_unavailable"), {
    step: "sweep.stuck_history_unavailable", pr_number: 10783, reason: "Error: stage history unavailable",
  });
});
