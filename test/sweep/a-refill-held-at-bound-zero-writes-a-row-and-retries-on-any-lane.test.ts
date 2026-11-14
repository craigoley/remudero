import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, inFlightReviewCount, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// Observed 2026-11-13 on the Azure ledger: a light pass left eight CI-green PRs in its tail, the host cut the
// width so the bound read 0, and the refill wrote nothing and waited 15 minutes for a lane of its own pass.

const NOW = Date.now();
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}
async function quiet(): Promise<void> {
  for (let i = 0; i < 20; i++) await settle();
}
function pr(n: number, extra: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 60_000 * n).toISOString(),
    createdAt: new Date(NOW - 60_000 * (20 - n)).toISOString(),
    ...extra,
  };
}
const fourLanes = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 4, reviewLaneMin: 1, reviewLaneMax: 4 };

function harness() {
  const holds = new Map<number, ReturnType<typeof gate>>();
  const hold = (n: number) => { if (!holds.has(n)) holds.set(n, gate()); return holds.get(n)!; };
  const started: number[] = [];
  const rows: Record<string, unknown>[] = [];
  const depths: number[] = [];
  let width = 2;
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "bound-zero-test", now: () => NOW,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0,
    selectAdaptiveReviewWidth: ({ queueDepth }) => { depths.push(queueDepth); return width; },
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await hold(p.prNumber).promise;
    },
  };
  const finish = async () => {
    for (let n = 1; n <= 9; n++) hold(n).resolve();
    await drainInFlightReviews({ boundMs: 1000 });
    await quiet();
  };
  const boundZero = () => rows.filter((r) => r.step === "sweep.review_refill.bound_zero");
  return { deps, hold, started, rows, depths, boundZero, setWidth: (w: number) => { width = w; }, finish };
}

test("W1-T12535 criterion 1: a refill held at bound 0 writes one bound_zero row per held spell", async () => {
  const h = harness();
  try {
    h.setWidth(3);
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, fourLanes);
    await eventually(() => h.started.length === 3, "three reviews did not start");
    h.setWidth(1);
    h.hold(1).resolve();
    await eventually(() => h.boundZero().length === 1, "a refill held at bound 0 wrote no row");
    const [row] = h.boundZero();
    assert.equal(row?.bound, 0);
    assert.equal(row?.width, 1);
    assert.equal(row?.in_flight, 2);
    assert.equal(row?.active_workers, 0);
    assert.equal(row?.tail_length, 1);
    h.hold(2).resolve();
    await quiet();
    assert.equal(h.boundZero().length, 1, "a second decline in the same held spell writes no second row");
    assert.equal(h.started.includes(4), false);
    h.setWidth(2);
    h.hold(3).resolve();
    await eventually(() => h.started.includes(4), "the restored bound did not refill");
    assert.equal(h.boundZero().length, 1);
  } finally {
    await h.finish();
  }
  assert.equal(inFlightReviewCount(), 0);
});

test("W1-T12535 criterion 2: a tail held at bound 0 retries consecutive releases from another pass", async () => {
  const h = harness();
  try {
    h.setWidth(2);
    await runSweepLightPass([pr(1), pr(2), pr(4)], h.deps, fourLanes);
    await eventually(() => h.started.length === 2, "pass A did not admit two reviews");
    h.setWidth(4);
    await runSweepLightPass([pr(5), pr(7)], h.deps, fourLanes);
    await eventually(() => h.started.includes(5) && h.started.includes(7), "pass B did not admit its reviews");
    h.setWidth(2);
    h.hold(1).resolve();
    await eventually(() => h.boundZero().length === 1, "pass A's refill was not held at bound 0");
    assert.equal(h.started.includes(4), false);
    // Pass A's remaining review stays held through both external releases.
    const selectionsBeforeRelease = h.depths.length;
    h.hold(5).resolve();
    await eventually(() => h.depths.length > selectionsBeforeRelease, "the first external release did not retry");
    await quiet();
    assert.equal(h.started.includes(4), false, "the first retry must still respect bound 0");
    assert.equal(inFlightReviewCount(), 2);
    assert.equal(h.boundZero().length, 1, "consecutive holds write only one row");
    h.hold(7).resolve();
    await eventually(() => h.started.includes(4), "a lane another pass freed did not retry the held tail");
    assert.deepEqual(h.rows.filter((r) => r.step === "sweep.review_refilled").map((r) => r.pr_number), [4]);
  } finally {
    await h.finish();
  }
});

test("W1-T12535 criterion 3: a retried refill admits only above bound 0, skips a held head and stops when refills close", async () => {
  const h = harness();
  try {
    h.setWidth(2);
    await runSweepLightPass([pr(1), pr(2), pr(4), pr(6)], h.deps, fourLanes);
    await eventually(() => h.started.length === 2, "pass A did not admit two reviews");
    h.setWidth(4);
    await runSweepLightPass([pr(4)], h.deps, fourLanes);
    await runSweepLightPass([pr(5)], h.deps, fourLanes);
    await eventually(() => h.started.includes(4) && h.started.includes(5), "passes B and C did not admit");
    h.setWidth(2);
    h.hold(1).resolve();
    await eventually(() => h.boundZero().length === 1, "pass A's refill was not held at bound 0");
    // Pass C's lane frees, but 2 and 4 still fill a width of 1: the retry must still read bound 0.
    h.setWidth(1);
    h.hold(5).resolve();
    await quiet();
    assert.equal(h.started.includes(6), false, "a retry admits nothing while the bound is 0");
    h.setWidth(3);
    h.hold(2).resolve();
    await eventually(() => h.started.includes(6), "the retry did not admit once the bound rose");
    assert.equal(h.started.filter((n) => n === 4).length, 1, "a head another pass holds is never admitted twice");
  } finally {
    await h.finish();
  }
  const closed = harness();
  try {
    closed.setWidth(2);
    await runSweepLightPass([pr(7), pr(8), pr(9)], closed.deps, fourLanes);
    await eventually(() => closed.started.length === 2, "two reviews did not start");
    closed.setWidth(1);
    closed.hold(7).resolve();
    await eventually(() => closed.boundZero().length === 1, "the refill was not held at bound 0");
    const drained = drainInFlightReviews({ boundMs: 1000 });
    closed.setWidth(4);
    closed.hold(8).resolve();
    assert.equal(await drained, 0);
    await quiet();
    assert.equal(closed.started.includes(9), false, "a held tail is not retried after refills close");
  } finally {
    await closed.finish();
  }
});

test("W1-T12535 criterion 4: a one-PR pass reports the snapshot's eligible queue depth and admits only its own PR", async () => {
  const h = harness();
  try {
    h.setWidth(4);
    const snapshot = [pr(1), pr(2), pr(3), pr(4, { checksState: "red" })];
    await runSweepLightPass([pr(1)], { ...h.deps, snapshotOpenPrs: snapshot }, fourLanes);
    await eventually(() => h.started.length === 1, "the pass did not admit its own PR");
    assert.equal(h.depths[0], 3, "queue depth counts every eligible spawning candidate of the snapshot");
    assert.deepEqual(h.started, [1], "admission selects only from the pass's own PRs");
    h.hold(1).resolve();
    await quiet();
    h.depths.length = 0;
    await runSweepLightPass([pr(2)], h.deps, fourLanes);
    await eventually(() => h.started.includes(2), "the second pass did not admit its PR");
    assert.equal(h.depths[0], 1, "with no snapshot the depth counts the pass's own PRs");
  } finally {
    await h.finish();
  }
});
