import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { RunResult } from "../src/lib/run-result.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { wipeTestCommand } from "../src/run-task.js";
import {
  resolveWipeTestArmOrder,
  resolveWipeTestArmPermission,
  WIPE_TEST_PAIR_STEP,
} from "../src/lib/wipe-test.js";

/**
 * test/wipe-test-arm-isolation.test.ts — W1-T1256, THE ARMS ARE NOT INDEPENDENT.
 *
 * `wipeTestCommand` (src/run-task.ts) dispatches a wipe-test pair's two arms on consecutive
 * lines, arm A (learnings ON) always first. The real contamination channel is REMOTE, not
 * local (task record design notes (ii)/(iii)): if arm A's PR merges, `origin/main` moves and
 * `projectPlan`'s `isMerged` read — fresh on EVERY `runTask` call, from the ledger + GitHub +
 * `state/status.json` — reports arm B's own subject already merged, so arm B refuses at zero
 * cost (`task_already_merged`, W1-T319's guard) without ever running. No LOCAL reset/reclone
 * reaches this: the ref itself moved.
 *
 * OPERATOR RULING 2026-08-23 (design note (iv)): NEITHER ARM MAY ARM OR MERGE. The pair is
 * measured at the verdict, not at the merge. `resolveWipeTestArmPermission` (src/lib/wipe-
 * test.ts) is the pure policy this task adds; `run-task.ts`'s deferred arm-at-verdict call
 * site (right before it would call `armAutoMergeAtOpen`) consults it and skips the call
 * outright when it refuses. `resolveWipeTestArmOrder` is the accompanying (non-fix) guard:
 * arm A running first on every pair would make any residual leak systematic; alternating
 * converts it into scatter (design note (vii)).
 */

// ── criteria 1 & 2: THE FALSIFIER, BOTH DIRECTIONS (design note (viii)) ─────────────────
//
// A test cannot open a live GitHub connection, so `RemoteState` stands in for the ONE remote
// surface both arms of a real pair actually share: origin/main's ref + the ledger + GitHub's
// own view of arm A's PR, all read fresh by `projectPlan`'s `isMerged` on every call.
// `dispatchArm` reproduces the two decision points that decide whether arm B inherits arm A's
// artifact — (1) `resolveWipeTestArmPermission`, the PRODUCTION function this task adds, under
// test for real; (2) the W1-T319 already-merged guard, UNCHANGED by this task and reproduced
// here only so the test can show it firing (direction two) or not firing (direction one). This
// is the "pure function over injected state" split design note (ix) calls for: the boundary is
// the ONE bit that changes between the two directions below, and nothing else moves.

interface RemoteState {
  merged: boolean;
}

function dispatchArm(remote: RemoteState, noMerge: boolean): { verdict: string; armed: boolean } {
  // W1-T319 (pre-existing, unchanged by this task): a subject the remote projection already
  // reports merged refuses at zero cost, before this run does anything else.
  if (remote.merged) return { verdict: "task_already_merged", armed: false };

  // W1-T1256: THIS run's own arm/merge decision — the production function under test.
  const decision = resolveWipeTestArmPermission(noMerge);
  if (!decision.armed) return { verdict: "passed_unarmed", armed: false };

  // Conservative worst case (design note (iv), "a successful arm A destroys its own control"):
  // an armed PR is assumed to merge, exactly the scenario that flips the shared remote state.
  remote.merged = true;
  return { verdict: "merged", armed: true };
}

test("criterion 1 -- FALSIFIER direction one: WITH the no-merge boundary, arm A never arms/merges, so arm B does not inherit the already-merged verdict arm A produced", () => {
  const remote: RemoteState = { merged: false };

  const armA = dispatchArm(remote, true);
  assert.equal(armA.armed, false, "arm A must not arm under the boundary");
  assert.equal(armA.verdict, "passed_unarmed");

  const armB = dispatchArm(remote, true);
  assert.equal(remote.merged, false, "arm A's PR never merged -- the shared remote state was never flipped");
  assert.notEqual(
    armB.verdict,
    "task_already_merged",
    "arm B must still dispatch for the same subject -- no zero-cost refusal inherited from arm A",
  );
});

test("criterion 2 -- FALSIFIER direction two (the control): with the boundary REMOVED, arm B demonstrably DOES observe arm A's artifact and refuses at zero cost", () => {
  const remote: RemoteState = { merged: false };

  const armA = dispatchArm(remote, false);
  assert.equal(armA.armed, true, "with the boundary removed, arm A arms and (worst case) merges");
  assert.equal(remote.merged, true, "the shared remote state moved -- this reproduces origin/main moving in production");

  const armB = dispatchArm(remote, false);
  assert.equal(
    armB.verdict,
    "task_already_merged",
    "the control: without the boundary, arm B inherits arm A's merged artifact through the SAME remote read -- proving direction one is not vacuous",
  );
});

// ── criterion 3: the remote state a local reset cannot reach is NAMED, not silently assumed
// clean (design note (iii)/(vi)) -- the refusal reason must say WHAT the boundary closes and
// WHY a local reset/reclone could never have closed it. ──────────────────────────────────

test("criterion 3 -- resolveWipeTestArmPermission NAMES the remote channel a local reset cannot reach, rather than a generic refusal", () => {
  const decision = resolveWipeTestArmPermission(true);
  assert.equal(decision.armed, false);
  assert.match(decision.reason ?? "", /origin\/main/, "names the ref a merged arm A moves");
  assert.match(decision.reason ?? "", /remote/i, "names the channel as remote -- the thing no local reset reaches");
  assert.match(decision.reason ?? "", /merged/i, "names what the remote move flips for the other arm's read");
});

test("resolveWipeTestArmPermission: noMerge false (every non-wipe-test caller) permits arming, unchanged", () => {
  assert.deepEqual(resolveWipeTestArmPermission(false), { armed: true });
});

// ── criterion 4: arm order alternation (design note (vii)) -- NOT a fix, a guard: the
// learnings-on arm (A) must not always be the arm that dispatches first. ────────────────────

test("criterion 4 -- resolveWipeTestArmOrder alternates by pairIndex parity: arm A is not always first", () => {
  assert.deepEqual(resolveWipeTestArmOrder(0), ["A", "B"]);
  assert.deepEqual(resolveWipeTestArmOrder(1), ["B", "A"]);
  assert.deepEqual(resolveWipeTestArmOrder(2), ["A", "B"]);
  assert.deepEqual(resolveWipeTestArmOrder(3), ["B", "A"]);
});

// ── wiring: wipeTestCommand actually threads BOTH the boundary and the alternation into its
// two real dispatch calls -- the pure functions above are worthless if the CLI glue never
// consults them. Mirrors test/wipe-test.test.ts's own injection style (fakeRunTaskFn over an
// isolated tmp config root, no real spawn/network). ──────────────────────────────────────

function wipeTestFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-wipe-test-isolation-")) };
}

function realRunResult(over: Partial<RunResult>): RunResult {
  return { taskId: "W1-T86", runId: "R-ISO", merged: false, costUsd: 1, verdict: "merged", ...over };
}

test("wipeTestCommand: BOTH dispatched arms carry noMerge:true -- the ruling is unconditional, not opt-in per call", async () => {
  const config = wipeTestFixtureConfig();
  const seenNoMerge: Array<boolean | undefined> = [];
  const seenMask: Array<boolean | undefined> = [];
  const runTaskFn = (async (_taskId: string, opts: { maskLearnings?: boolean; noMerge?: boolean } = {}) => {
    seenNoMerge.push(opts.noMerge);
    seenMask.push(opts.maskLearnings);
    return opts.maskLearnings ? realRunResult({ runId: "R-B" }) : realRunResult({ runId: "R-A" });
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 0);
  assert.deepEqual(seenNoMerge, [true, true], "every dispatch call this task adds carries noMerge:true, both arms");
  assert.deepEqual(seenMask, [undefined, true], "arm A dispatches unmasked (omitted), arm B masked -- unchanged by the boundary");
});

test("wipeTestCommand: with ZERO prior pairs ledgered for this task, arm A (learnings ON) dispatches first", async () => {
  const config = wipeTestFixtureConfig();
  const dispatchOrder: Array<"A" | "B"> = [];
  const runTaskFn = (async (_taskId: string, opts: { maskLearnings?: boolean } = {}) => {
    dispatchOrder.push(opts.maskLearnings ? "B" : "A");
    return opts.maskLearnings ? realRunResult({ runId: "R-B" }) : realRunResult({ runId: "R-A" });
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 0);
  assert.deepEqual(dispatchOrder, ["A", "B"], "pairIndex 0 (no prior pairs) -- arm A dispatches first");
});

test("wipeTestCommand: with ONE prior pair already ledgered for this task, arm B (learnings MASKED) dispatches first", async () => {
  const config = wipeTestFixtureConfig();
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  // Seed one prior wipetest.pair line for the SAME task -- exactly what a completed earlier
  // invocation of `rmd wipe-test W1-T86` would have written via ledgerWipeTestPair.
  appendLedger(ledgerPath, { run_id: "WIPETEST-PRIOR", task_id: "W1-T86", step: WIPE_TEST_PAIR_STEP });
  assert.equal(
    readLedgerLines(ledgerPath).filter((l) => l.task_id === "W1-T86" && l.step === WIPE_TEST_PAIR_STEP).length,
    1,
    "seed sanity check",
  );

  const dispatchOrder: Array<"A" | "B"> = [];
  const runTaskFn = (async (_taskId: string, opts: { maskLearnings?: boolean } = {}) => {
    dispatchOrder.push(opts.maskLearnings ? "B" : "A");
    return opts.maskLearnings ? realRunResult({ runId: "R-B" }) : realRunResult({ runId: "R-A" });
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 0);
  assert.deepEqual(dispatchOrder, ["B", "A"], "pairIndex 1 (one prior pair) -- arm B dispatches first, arm A second");

  // The PAIR'S OWN semantics are unaffected by dispatch order: armA/armB in the ledgered
  // delta still mean learnings-on / learnings-masked, never "first-dispatched / second".
  const pairLine = readLedgerLines(ledgerPath).filter(
    (l) => l.step === WIPE_TEST_PAIR_STEP && l.task_id === "W1-T86" && l.run_id !== "WIPETEST-PRIOR",
  )[0];
  assert.ok(pairLine, "the new pair still ledgers exactly one wipetest.pair line");
  assert.equal(pairLine.arm_a_run_id, "R-A", "armA is still the learnings-on run, regardless of dispatch order");
  assert.equal(pairLine.arm_b_run_id, "R-B", "armB is still the learnings-masked run, regardless of dispatch order");
});
