/**
 * W1-T11148 — A CHEAP REVIEW NEVER WAITS BEHIND THE CPU REVIEW BOUND.
 *
 * MEASURED 2026-11-02: #16191, a one-shard filing, waited 6.3 h for a 1.2-minute review, and 60 of 438 plan reviews
 * waited 68.3 h in the code lane. A plan review met the CPU-gated `reviewAdmissionBound` three ways: the full pass had
 * one pool, a running plan child counted as a code review in flight, and an unread files classification sent a plan
 * diff to the code lane. Each fixture holds the only code slot (width 1) and asks whether a plan review still starts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PLAN_FILING_FILE_MISS_CAP } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  adoptChildWork,
  registerChildWork,
  resetChildWork,
  resetPlanLaneHeadDiffs,
  reviewAdmissionBound,
  reviewsInPlanLane,
  runSweep,
  runSweepLightPass,
  withFullSweepRepairAdmission,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-02T22:00:00Z");
const ONE_LANE: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

function eligible(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: false,
    createdAt: new Date(NOW - prNumber * 1000).toISOString(),
    ...over,
  };
}
const planFiling = (prNumber: number): OpenPrView => eligible(prNumber, { isPlanFiling: true, planFilingSource: "github-files" });
const unread = (prNumber: number): OpenPrView => eligible(prNumber, { planFilingSource: "unreadable" });

const PLAN_DIFF = [
  "diff --git a/plan/tasks.d/W1-T1-x.yaml b/plan/tasks.d/W1-T1-x.yaml",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/plan/tasks.d/W1-T1-x.yaml",
  "@@ -0,0 +1 @@",
  "+- id: W1-T1",
  "",
].join("\n");
const CODE_DIFF = PLAN_DIFF.replaceAll("plan/tasks.d/W1-T1-x.yaml", "src/lib/x.ts");

function harness(held: readonly number[] = []) {
  const started: number[] = [];
  const gates = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  for (const n of held) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    gates.set(n, { promise, resolve });
  }
  const deps: SweepDeps = {
    log: () => {},
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await gates.get(p.prNumber)?.promise;
    },
    ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11148-`)), "ledger.ndjson"),
    runId: "SWEEP-T11148-1",
    now: () => NOW,
  };
  const releaseAll = () => { for (const gate of gates.values()) gate.resolve(); };
  return { deps, started, releaseAll };
}

const standDown = (deps: SweepDeps, prNumber: number): unknown =>
  readLedgerLines(deps.ledgerPath).findLast((l) => l.step === "sweep.disposed" && l.pr_number === prNumber)?.stand_down_reason;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("W1-T11148 criterion 1: a full pass starts a plan filing while the only code slot is taken", async () => {
  const h = harness([9401]);
  try {
    await runSweepLightPass([eligible(9401)], h.deps, ONE_LANE);
    assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 }, "precondition: the code slot is held");
    await runSweep([planFiling(9402), eligible(9403)], withFullSweepRepairAdmission(h.deps), ONE_LANE);
    assert.deepEqual(h.started, [9401, 9402], "the plan filing starts through its own pool");
    assert.equal(standDown(h.deps, 9402), undefined);
    assert.equal(standDown(h.deps, 9403), "not admitted this pass: semantic post-review admission bound 0, in-flight 1",
      "a code review still waits for the CPU-gated bound");
    assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 }, "the plan review never took a code slot");
  } finally {
    h.releaseAll();
    await settle();
  }
});

test("W1-T11148 criterion 2: a running plan-lane review child is not a code review in flight", async () => {
  resetChildWork();
  let settle1!: () => void;
  let settle2!: () => void;
  try {
    registerChildWork({ runId: "work-review-plan-1", kind: "review", taskId: "PR-1", prNumber: 1, headSha: "a", reviewKey: "k1", planLane: true });
    assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 }, "a plan child leaves the code slot free");
    // After a boot the child is adopted from its spec, whose inputs carry the plan-only flag the sweep spawned it with.
    void adoptChildWork({ runId: "work-review-plan-2", taskId: "PR-2",
      work: { kind: "review", prNumber: 2, headSha: "b", reviewKey: "k2", inputs: { repo: "remudero", planOnlyFiling: true } },
      settled: new Promise((resolve) => { settle1 = () => resolve(undefined); }) }, () => {});
    assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 }, "an adopted plan child leaves it free too");
    const h = harness();
    await runSweepLightPass([eligible(9411)], h.deps, ONE_LANE);
    assert.deepEqual(h.started, [9411], "a code review starts while only plan children run");
    void adoptChildWork({ runId: "work-review-code-3", taskId: "PR-3",
      work: { kind: "review", prNumber: 3, headSha: "c", reviewKey: "k3", inputs: { repo: "remudero", planOnlyFiling: false } },
      settled: new Promise((resolve) => { settle2 = () => resolve(undefined); }) }, () => {});
    assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 }, "a code child still takes the code slot");
  } finally {
    settle1?.();
    settle2?.();
    await settle();
    resetChildWork();
  }
});

test("W1-T11148 criterion 3: an unread classification whose head diff is plan-only joins the plan lane, read once per head", async () => {
  resetPlanLaneHeadDiffs();
  const h = harness([9421]);
  const reads: number[] = [];
  h.deps.readPrHeadDiff = async (pr) => {
    reads.push(pr.prNumber);
    if (pr.prNumber === 9424) throw new Error("gh pr diff failed");
    return pr.prNumber === 9422 ? PLAN_DIFF : CODE_DIFF;
  };
  try {
    await runSweepLightPass([eligible(9421)], h.deps, ONE_LANE);
    await runSweepLightPass([unread(9422), unread(9423), unread(9424)], h.deps, ONE_LANE);
    await settle();
    assert.deepEqual(h.started, [9421, 9422], "only the plan-only head starts beside the held code review");
    assert.equal(reviewsInPlanLane(unread(9422)), true, "the reviewer's own predicate routed it");
    assert.equal(reviewsInPlanLane(unread(9423)), false, "a code diff stays in the code lane");
    assert.equal(reviewsInPlanLane(unread(9424)), false, "an unread diff stays in the code lane, as today");
    assert.equal(reviewsInPlanLane(unread(9422)) && !reviewsInPlanLane({ ...unread(9422), headSha: "pushed" }), true,
      "the answer belongs to the head it read");
    assert.match(String(standDown(h.deps, 9423)), /semantic post-review admission bound 0/);
    await runSweepLightPass([unread(9423), unread(9424)], h.deps, ONE_LANE);
    assert.deepEqual(reads.sort(), [9422, 9423, 9424], "each head's diff is read once, not once per pass");
  } finally {
    h.releaseAll();
    await settle();
    resetPlanLaneHeadDiffs();
  }
});

test("W1-T11148 criterion 5: the plan-filing count is gone and a pass admits every eligible plan review", async () => {
  assert.ok(!("planFilingAdmissionBound" in DEFAULT_SWEEP_POLICY), "no literal count survives beside the queue");
  assert.ok(Number.isInteger(PLAN_FILING_FILE_MISS_CAP) && PLAN_FILING_FILE_MISS_CAP > 0,
    "the files-read miss cap it doubled as keeps a value under its own name");
  const filings = [9431, 9432, 9433, 9434, 9435];
  const h = harness([9430, ...filings]);
  try {
    await runSweepLightPass([eligible(9430), ...filings.map(planFiling)], h.deps, ONE_LANE);
    await settle();
    assert.deepEqual([...h.started].sort(), [9430, ...filings], "five plan filings start in one pass beside the code review");
    assert.ok(filings.every((n) => standDown(h.deps, n) === undefined), "none stands down on a count");
  } finally {
    h.releaseAll();
    await settle();
  }
});
