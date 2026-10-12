/**
 * test/a-ready-plan-pr-merges-on-the-next-pass.test.ts — W1-T5901.
 *
 * THE DEFECT. A plan PR is never armed for auto-merge (W1-T5615), so once green and reviewed it
 * waits for a FULL sweep's direct merge. Every light pass disposed it `mergeable` and stood down
 * with `deferred to full sweep (light pass)`: measured 10-36 min of waiting with both gates green.
 *
 * THE FIX. `runSweepLightPass` admits `mergeable` for ONE plan-only filing PR per pass, and that PR
 * runs the full sweep's own `deps.arm` path. These tests wire `deps.arm` to the REAL `attemptArm`
 * over fake gh seams, and `actionable` to production's own `lightPassActionable`, so the
 * composition is proven end to end rather than paraphrased.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { attemptArm, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import type { PlanMergeSafetyReadings } from "../src/lib/plan-pr-merge-safety.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { lightPassActionable } from "../src/run-task.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t5901-")), "ledger.ndjson");
}

/** A green, reviewed, mergeable PR. `isPlanFiling` is the positive plan-only signal. */
function readyPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: true,
    ...over,
  };
}

interface Seams {
  mergeFacts?: { mergeable: string; mergeableState: string; behindBy: number };
  safety?: PlanMergeSafetyReadings;
  mergeQueue?: boolean;
}

function harness(seams: Seams = {}) {
  const merged: string[] = [];
  const armed: string[] = [];
  const updated: string[] = [];
  const said: string[] = [];
  const armDeps: ArmDeps = {
    armAuto: (url) => { armed.push(url); },
    mergeDirect: (url) => { merged.push(url); },
    isMerged: () => false,
    say: (line) => { said.push(line); },
    readPlanTouch: () => "touched",
    readMergeFacts: () => seams.mergeFacts ?? { mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 0 },
    updateBranch: (url) => { updated.push(url); return { ok: true }; },
    readPlanMergeSafety: () => seams.safety ?? { error: "no safety reading" },
    mergeQueue: () => seams.mergeQueue === true,
    enqueue: (url) => { armed.push(url); },
    headSha: () => "head",
    ledgerLines: () => [],
    disableAuto: () => {},
  };
  const deps: SweepDeps = {
    log: () => {},
    arm: (p) => attemptArm(p.prUrl, armDeps, p.headSha, p.isDraft),
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-T5901-1",
    now: () => NOW,
    // production's own light-pass gate, fixRungAllowed=false: only post-review is admitted.
    actionable: (d) => lightPassActionable(d, false),
  };
  return { deps, merged, armed, updated, said };
}

function disposed(deps: SweepDeps, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
}

test("a light pass direct-merges a green, reviewed, mergeable plan PR instead of deferring it", async () => {
  const h = harness();
  const plan = readyPr(9001);
  await runSweepLightPass([plan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merged, [plan.prUrl], "the light pass merged the plan PR itself");
  assert.deepEqual(h.armed, [], "a plan PR is never armed for auto-merge (W1-T5615)");
  const line = disposed(h.deps, 9001);
  assert.equal(line?.arm_outcome, "direct-merged");
  assert.equal(line?.acted, true);
  assert.notEqual(line?.stand_down_reason, "deferred to full sweep (light pass)");
});

test("the light-pass direct merge runs the W1-T5748 safety decision: a behind plan PR whose merged plan loads merges as-is", async () => {
  const h = harness({
    mergeFacts: { mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 2 },
    safety: { prPlanPaths: ["plan/tasks.d/W1-T9002-x.yaml"], mainPlanPaths: ["plan/tasks.d/W1-T1-y.yaml"], mergedTree: { state: "loads" } },
  });
  const plan = readyPr(9002);
  await runSweepLightPass([plan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merged, [plan.prUrl]);
  assert.deepEqual(h.updated, [], "a safe merged plan is not refreshed");
  assert.ok(h.said.some((s) => s.includes("automerge.plan_pr_merge_safe (W1-T5748)")), "the W1-T5748 decision ruled");
});

test("the light-pass direct merge updates a behind plan PR whose merged plan is not proven safe, and merges nothing", async () => {
  const h = harness({
    mergeFacts: { mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 2 },
    safety: { prPlanPaths: ["plan/tasks.d/a.yaml"], mainPlanPaths: ["plan/tasks.d/a.yaml"] },
  });
  const plan = readyPr(9003);
  await runSweepLightPass([plan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.updated, [plan.prUrl], "update-then-merge: the refresh is the first half");
  assert.deepEqual(h.merged, [], "a behind plan PR is not merged on the stale head");
});

test("a light pass merges at most one plan PR", async () => {
  const h = harness();
  const first = readyPr(9004);
  const second = readyPr(9005);
  await runSweepLightPass([first, second], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merged, [first.prUrl], "exactly one plan PR merged");
  assert.equal(disposed(h.deps, 9005)?.stand_down_reason, "deferred to full sweep (light pass)");
  assert.equal(disposed(h.deps, 9005)?.acted, false);
});

test("a light pass enqueues the plan PR when the base requires a merge queue, never merging around it", async () => {
  const h = harness({ mergeQueue: true });
  const plan = readyPr(9006);
  await runSweepLightPass([plan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, [plan.prUrl], "enqueued through the queue path");
  assert.deepEqual(h.merged, [], "the REST merge bypasses the queue, so it is never called");
});

test("a light pass leaves a code PR deferred as today", async () => {
  const h = harness();
  const code = readyPr(9007, { isPlanFiling: false });
  const unknown = readyPr(9008, { isPlanFiling: undefined });
  await runSweepLightPass([code, unknown], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merged, [], "no code PR is merged by a light pass");
  assert.deepEqual(h.armed, []);
  for (const n of [9007, 9008]) {
    const line = disposed(h.deps, n);
    assert.equal(line?.disposition, "mergeable");
    assert.equal(line?.acted, false);
    assert.equal(line?.stand_down_reason, "deferred to full sweep (light pass)");
  }
});

test("a code PR beside a ready plan PR stays deferred while the plan PR merges", async () => {
  const h = harness();
  const code = readyPr(9009, { isPlanFiling: false });
  const plan = readyPr(9010);
  await runSweepLightPass([code, plan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merged, [plan.prUrl]);
  assert.equal(disposed(h.deps, 9009)?.stand_down_reason, "deferred to full sweep (light pass)");
});
