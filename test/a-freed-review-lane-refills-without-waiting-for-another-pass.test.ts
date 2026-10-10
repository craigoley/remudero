import assert from "node:assert/strict";
import { test } from "node:test";
import { GhPaceFloorStandDownError } from "../src/lib/open-prs-rest.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, inFlightReviewCount, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

// Measured 2026-10-10 on the core daemon: light passes ran 5-12 min apart and a review took a median
// 2.2 min, so a lane a pass freed sat empty until the next pass while armed, green PRs waited on an
// absent remudero-review. These tests run ONE light pass and never a second one.

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
function pr(n: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 60_000 * n).toISOString(),
    createdAt: new Date(NOW - 60_000 * (10 - n)).toISOString(),
  };
}
const twoLanes = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2, reviewLaneMin: 1, reviewLaneMax: 2 };

function harness(extra: Partial<SweepDeps> = {}) {
  const holds = new Map<number, ReturnType<typeof gate>>();
  const hold = (n: number) => { if (!holds.has(n)) holds.set(n, gate()); return holds.get(n)!; };
  const started: number[] = [];
  const rows: Record<string, unknown>[] = [];
  let active = 0;
  let peak = 0;
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "refill-test", now: () => NOW,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      peak = Math.max(peak, ++active);
      await hold(p.prNumber).promise;
      active--;
    },
    ...extra,
  };
  const finish = async () => {
    for (let n = 1; n <= 6; n++) hold(n).resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  };
  return { deps, hold, started, rows, peak: () => peak, finish };
}

test("a freed light-pass review lane admits the next deferred PR without another pass", async () => {
  const h = harness();
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    assert.deepEqual([...h.started].sort(), [1, 2]);
    h.hold(1).resolve();
    await eventually(() => h.started.includes(3), "the freed lane stayed empty until another pass");
    assert.equal(h.started.includes(4), false, "one freed lane admits one deferred PR");
    h.hold(2).resolve();
    await eventually(() => h.started.includes(4), "the second freed lane stayed empty");
    assert.equal(h.peak(), 2, "a refill never exceeds the review width");
    const refilled = h.rows.filter((r) => r.step === "sweep.review_refilled").map((r) => r.pr_number);
    assert.deepEqual(refilled, [3, 4]);
  } finally {
    await h.finish();
  }
  assert.equal(inFlightReviewCount(), 0);
});

test("a refill re-reads the adaptive width, so a host that shrank it admits nothing", async () => {
  let width = 2;
  const h = harness({ selectAdaptiveReviewWidth: () => width });
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    width = 1;
    h.hold(1).resolve();
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(h.started.includes(3), false, "the shrunken width (1, one still in flight) must hold the tail");
    width = 2;
    h.hold(2).resolve();
    await eventually(() => h.started.includes(3), "the restored width did not refill");
  } finally {
    await h.finish();
  }
});

test("a refill skips a deferred PR whose live head moved and admits the next one", async () => {
  const h = harness({ readLiveHeadSha: (p) => (p.prNumber === 3 ? "moved-head" : p.headSha) });
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    await eventually(() => h.started.includes(4), "the next live PR was not refilled");
    assert.equal(h.started.includes(3), false, "a dead head must never be reviewed");
    const skipped = h.rows.find((r) => r.step === "sweep.review_refill.skipped");
    assert.equal(skipped?.pr_number, 3);
    assert.match(String(skipped?.reason), /head moved to moved-he/);
  } finally {
    await h.finish();
  }
});

test("a refill skips a deferred PR the live read finds merged", async () => {
  const h = harness({
    readLiveStateAtAct: (p) => (p.prNumber === 3
      ? { ok: true, state: "MERGED", headSha: p.headSha }
      : { ok: true, state: "OPEN", headSha: p.headSha }),
  });
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    await eventually(() => h.started.includes(4), "the next open PR was not refilled");
    assert.equal(h.started.includes(3), false);
    const skipped = h.rows.find((r) => r.step === "sweep.review_refill.skipped");
    assert.match(String(skipped?.reason), /state is MERGED/);
  } finally {
    await h.finish();
  }
});

test("a refill whose live read throws leaves that PR to the next pass and names why", async () => {
  const h = harness({
    readLiveHeadSha: (p) => {
      if (p.prNumber === 3) throw new Error("gh 502");
      return p.headSha;
    },
  });
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    await eventually(() => h.started.includes(4), "the next PR was not refilled");
    assert.equal(h.started.includes(3), false);
    const skipped = h.rows.find((r) => r.step === "sweep.review_refill.skipped");
    assert.match(String(skipped?.reason), /live head unreadable \(gh 502\)/);
  } finally {
    await h.finish();
  }
});

test("a drain closes refills: a lane freed during an exit admits nothing", async () => {
  const h = harness();
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    const drained = drainInFlightReviews({ boundMs: 1000 });
    h.hold(1).resolve();
    h.hold(2).resolve();
    assert.equal(await drained, 0);
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(h.started.includes(3), false, "a drain is an exit, never a refill point");
  } finally {
    await h.finish();
  }
});

test("a refilled PR whose review already landed stands down and hands its lane to the next", async () => {
  // PR 3's verdict lands (through another pass) after this pass deferred it. runSweep's own
  // action-time guard stands the refill down without reviewing, and that lane must pass to PR 4.
  const h = harness();
  const delivered = { step: "review.posted", task_id: "W1-T3", pr_url: pr(3).prUrl, head_sha: pr(3).headSha, state: "success" };
  let deliveredVisible = false;
  h.deps.readLedger = () => (deliveredVisible ? [delivered] : []);
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    deliveredVisible = true;
    h.hold(1).resolve();
    await eventually(() => h.started.includes(4), "the stood-down refill kept its lane");
    assert.equal(h.started.includes(3), false, "a delivered head is never reviewed twice");
    assert.deepEqual(h.rows.filter((r) => r.step === "sweep.review_refilled").map((r) => r.pr_number), [3, 4]);
  } finally {
    await h.finish();
  }
});

test("a pass whose review met the gh budget floor refills nothing", async () => {
  const h = harness();
  const review = h.deps.postReview!;
  h.deps.postReview = async (p, mode) => {
    await review(p, mode);
    if (p.prNumber === 1) throw new GhPaceFloorStandDownError({ resource: "core", remaining: 20, limit: 5000 });
  };
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(h.started.includes(3), false, "provider capacity is account-wide: the tail waits for the next pass");
  } finally {
    await h.finish();
  }
});

test("a refilled review whose settlement throws still frees its lane and names the failure", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const h = harness({ log: (step, extra) => { logs.push({ step, extra }); } });
  const review = h.deps.postReview!;
  h.deps.postReview = async (p, mode) => {
    await review(p, mode);
    if (p.prNumber === 3) throw new Error("reviewer failed");
  };
  const append = h.deps.appendLine!;
  h.deps.appendLine = (path, row) => {
    if ((row as { step?: string }).step === "sweep.action_failed") throw new Error("ledger disk full");
    append(path, row);
  };
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    await eventually(() => h.started.includes(3), "the freed lane did not refill");
    h.hold(3).resolve();
    await eventually(() => h.started.includes(4), "the failed refill kept its lane");
    const failed = logs.find((l) => l.step === "sweep.post_review.failed" && l.extra?.pr_number === 3);
    assert.match(String(failed?.extra?.error), /ledger disk full/);
  } finally {
    await h.finish();
  }
});

test("a refill whose sweep call rejects frees its lane and names the failure", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let ledgerBroken = false;
  const h = harness({
    log: (step, extra) => { logs.push({ step, extra }); },
    readLedger: () => {
      if (ledgerBroken) throw new Error("ledger unreadable");
      return [];
    },
  });
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    ledgerBroken = true;
    h.hold(1).resolve();
    await eventually(() => logs.some((l) => l.step === "sweep.post_review.failed" && l.extra?.pr_number === 3),
      "the rejected refill was not named");
    assert.equal(h.started.includes(3), false);
    ledgerBroken = false;
    h.hold(2).resolve();
    await eventually(() => inFlightReviewCount() === 0, "a rejected refill held its lane");
  } finally {
    await h.finish();
  }
});

test("a refill whose admission row cannot be written returns its reservation and names the failure", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const h = harness({ log: (step, extra) => { logs.push({ step, extra }); } });
  const append = h.deps.appendLine!;
  let broken = true;
  h.deps.appendLine = (path, row) => {
    if (broken && (row as { step?: string }).step === "sweep.review_refilled") throw new Error("ledger disk full");
    append(path, row);
  };
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3), pr(4)], h.deps, twoLanes);
    await eventually(() => h.started.length === 2, "two reviews did not start");
    h.hold(1).resolve();
    await eventually(() => logs.some((l) => l.step === "sweep.review_refill.failed"), "the refill failure was not named");
    assert.match(String(logs.find((l) => l.step === "sweep.review_refill.failed")?.extra?.error), /ledger disk full/);
    assert.equal(h.started.includes(3), false);
    broken = false;
    h.hold(2).resolve();
    await eventually(() => h.started.includes(4), "the returned reservation was not reusable");
  } finally {
    await h.finish();
  }
});
