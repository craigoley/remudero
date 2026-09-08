// @source-text-subject — this suite verifies the two production full-sweep composition sites.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GhPaceFloorStandDownError } from "../src/lib/github-transport.js";
import {
  DEFAULT_SWEEP_POLICY,
  drainDetachedSweepActions,
  runSweep,
  runSweepLightPass,
  withFullSweepRepairAdmission,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-09-08T18:00:00Z");
const RECENT = "2026-09-08T17:00:00Z";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t3202-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-T3202-FIXTURE",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    createdAt: RECENT,
    headSha: "head-1",
    autoMergeArmed: false,
    ...over,
  };
}

function blockedFixablePr(n: number): OpenPrView {
  return pr({
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-T${n}`,
    headSha: `fix-${n}`,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "repair it", proof: "unit test: repair", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
  });
}

function reviewPr(n: number): OpenPrView {
  return pr({
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-R${n}`,
    headSha: `review-${n}`,
    reviewState: "none",
    checksState: "green",
  });
}

function deps(path: string, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-W1-T3202",
    now: () => NOW,
    readActiveWorkerCount: () => 0,
    ...over,
  };
}

function policy(hostWorkerBudget = 4, reviewLanes = 2): SweepPolicy {
  return {
    ...DEFAULT_SWEEP_POLICY,
    reviewLanes,
    reviewLaneMin: 1,
    reviewLaneMax: Math.max(reviewLanes, 3),
    reviewCapacity: { ...DEFAULT_SWEEP_POLICY.reviewCapacity, hostWorkerBudget },
  };
}

function heldDispatch(): {
  dispatchFix: SweepDeps["dispatchFix"];
  calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  release: () => void;
} {
  const calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    calls,
    release,
    dispatchFix: (candidate, evidence) => {
      calls.push({ pr: candidate, evidence });
      return held;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a full sweep reviews a later green PR while its first repair is still pending", async () => {
  const path = ledgerPath();
  const held = heldDispatch();
  const reviewed: number[] = [];
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let resolved = false;
  const pass = runSweep(
    [blockedFixablePr(101), reviewPr(102)],
    withFullSweepRepairAdmission(deps(path, {
      dispatchFix: held.dispatchFix,
      postReview: (candidate) => { reviewed.push(candidate.prNumber); },
      log: (step, fields = {}) => { logged.push({ step, fields }); },
    })),
    policy(),
  ).then((summary) => { resolved = true; return summary; });

  await settle();
  assert.equal(held.calls.length, 1, "the repair starts");
  assert.deepEqual(reviewed, [102], "the later green PR reaches postReview before the repair settles");
  assert.equal(resolved, true, "the full pass no longer inherits the repair's CI wait");
  assert.ok(logged.some((row) =>
    row.step === "sweep.review_started" && row.fields.surface === "full" &&
      row.fields.review_began_while_repair_pending === true));

  held.release();
  await drainDetachedSweepActions();
  await pass;
});

test("full-sweep repairs share the host budget after one active-worker read and reserved reviews", async () => {
  const path = ledgerPath();
  let activeReads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started: number[] = [];
  const reviewed: number[] = [];
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const fullDeps = withFullSweepRepairAdmission(deps(path, {
    readActiveWorkerCount: () => { activeReads++; return 2; },
    dispatchFix: (candidate) => {
      started.push(candidate.prNumber);
      return candidate.prNumber === 201 ? held : undefined;
    },
    postReview: (candidate) => { reviewed.push(candidate.prNumber); },
    log: (step, fields = {}) => { logged.push({ step, fields }); },
  }));

  await runSweep(
    [blockedFixablePr(201), blockedFixablePr(202), blockedFixablePr(203), reviewPr(204)],
    fullDeps,
    policy(4, 1),
  );
  assert.equal(activeReads, 1, "activeWorkerCount is subtracted once for the whole snapshot");
  assert.deepEqual(started, [201], "two active workers plus one reserved review leave one fix slot");
  assert.deepEqual(reviewed, [204]);
  const refused = readLedgerLines(path).filter((row) =>
    row.step === "sweep.disposed" && [202, 203].includes(Number(row.pr_number)));
  assert.equal(refused.length, 2);
  assert.ok(refused.every((row) => row.acted === false && /host worker budget/.test(String(row.stand_down_reason))));
  assert.equal(
    readLedgerLines(path).some((row) => row.step === "fix.dispatch" && ["W1-T202", "W1-T203"].includes(String(row.task_id))),
    false,
    "capacity refusal creates no strike or durable fix outcome",
  );
  assert.ok(logged.some((row) =>
    row.step === "sweep.fix_capacity" && row.fields.surface === "full" && row.fields.review_reservations === 1));

  const recovered: number[] = [];
  await runSweep(
    [blockedFixablePr(202)],
    withFullSweepRepairAdmission(deps(path, { dispatchFix: (candidate) => { recovered.push(candidate.prNumber); } })),
    policy(4, 1),
  );
  assert.deepEqual(recovered, [202], "a refused repair is level-trigger eligible on the next pass");

  release();
  await drainDetachedSweepActions();
});

test("overlapping full and light passes cannot dispatch the same PR head twice", async () => {
  const path = ledgerPath();
  const held = heldDispatch();
  const fix = blockedFixablePr(301);
  try {
    await runSweep(
      [fix],
      withFullSweepRepairAdmission(deps(path, { dispatchFix: held.dispatchFix })),
      policy(),
    );
    await runSweepLightPass([fix], deps(path, { runId: "LIGHT-W1-T3202", dispatchFix: held.dispatchFix }), policy());
    assert.equal(held.calls.length, 1, "the process-lifetime PR/head claim spans both sweep surfaces");
  } finally {
    held.release();
    await drainDetachedSweepActions();
  }
});

test("the full-sweep wrapper preserves review throughput and provider-floor admission stop", async () => {
  const path = ledgerPath();
  const drained: number[] = [];
  await runSweep(
    [reviewPr(401), reviewPr(402), reviewPr(403)],
    withFullSweepRepairAdmission(deps(path, { postReview: (candidate) => { drained.push(candidate.prNumber); } })),
    policy(4, 2),
  );
  assert.deepEqual(drained, [401, 402, 403], "two lanes remain a pool that drains every eligible review");

  const floorPath = ledgerPath();
  const attempts: number[] = [];
  await runSweep(
    [reviewPr(411), reviewPr(412), reviewPr(413)],
    withFullSweepRepairAdmission(deps(floorPath, {
      postReview: (candidate) => {
        attempts.push(candidate.prNumber);
        throw new GhPaceFloorStandDownError({ resource: "core", remaining: 20, limit: 5000 });
      },
    })),
    policy(4, 1),
  );
  assert.deepEqual(attempts, [411], "provider headroom refusal stops later admissions from this snapshot");
});

test("both production full-sweep call sites install detached host-budgeted repair admission", () => {
  const runTask = readFileSync(join(process.cwd(), "src", "run-task.ts"), "utf8");
  assert.match(runTask, /export async function sweepCommand/, "positive control: the CLI composition is in the corpus");
  assert.match(runTask, /export function buildSweepHook/, "positive control: the daemon composition is in the corpus");
  const uses = runTask.match(/withFullSweepRepairAdmission\(/g) ?? [];
  assert.equal(uses.length, 2, "the CLI sweep and daemon sweep hook share the same production wrapper");
});
