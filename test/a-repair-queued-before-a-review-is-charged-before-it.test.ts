// W1-T9582 — a repair queued before a review is charged before it.
//
// The fixture is the full-pass row #11785 read at 2026-10-15T00:42:26Z: "headroom 2406 MiB over the floor; charged
// 2651 MiB for 3 reviews at 1130 ... a fix needs 1283 MiB (measured)", the repair's blocker 114 min old. The three
// reviews' PRs began waiting minutes before the pass. Every planned review was charged before the repair, however
// long the repair had waited; the pass now charges them in the order their PRs began waiting.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, createSweepFixAdmissionController, drainDetachedSweepActions, runSweep,
  withFullSweepRepairAdmission, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-15T00:42:26Z");
const MIN = 60_000;
const FLOOR = 3_072;
const HEADROOM = 2_406;
const REVIEW_MIB = 1_130;
const FIX_MIB = 1_283;
const iso = (ms: number): string => new Date(ms).toISOString();

const repair = { prNumber: 11785 } as OpenPrView;

function controller(input: {
  repairSinceMs: number;
  reviews: ReadonlyArray<{ prNumber: number; sinceMs: number }>;
  rows: Record<string, unknown>[];
  headroomMib?: number;
}) {
  return createSweepFixAdmissionController({
    surface: "full",
    queueDepth: input.reviews.length,
    hostWorkerBudget: 8,
    activeWorkers: 2,
    reviewReservations: input.reviews.length,
    readReviewReservations: () => input.reviews.length,
    readActiveWorkers: () => 2,
    readPressure: () => ({ availableMib: FLOOR + (input.headroomMib ?? HEADROOM), floorMib: FLOOR }),
    readEstimate: (workerClass) => workerClass === "review"
      ? { estimateMib: REVIEW_MIB, samples: 40 }
      : { estimateMib: FIX_MIB, samples: 12 },
    readResidents: () => ({ review: [], fix: [] }),
    reviewQueue: input.reviews,
    waitSinceMs: () => input.repairSinceMs,
    log: (step, extra) => void input.rows.push({ step, ...extra }),
  });
}

test("W1-T9582: a repair queued before every planned review is admitted ahead of them", () => {
  const rows: Record<string, unknown>[] = [];
  const c = controller({
    repairSinceMs: NOW - 114 * MIN,
    reviews: [
      { prNumber: 11901, sinceMs: NOW - 9 * MIN },
      { prNumber: 11902, sinceMs: NOW - 4 * MIN },
      { prNumber: 11903, sinceMs: NOW - 1 * MIN },
    ],
    rows,
  });
  const claim = c.claim(repair);
  assert.equal(claim.admitted, true, "the 114-min repair is charged before reviews whose PRs waited under 10 min");
  const row = rows.at(-1)!;
  assert.equal(row.step, "sweep.fix_capacity");
  assert.equal(row.pr_number, 11785);
  assert.equal(row.headroom_mib, HEADROOM);
  assert.equal(row.review_charge_mib, 0, "no review queued after the repair is charged ahead of it");
  assert.equal(row.fix_charge_mib, FIX_MIB, "the admitted fix is charged its measured estimate");
  assert.deepEqual(row.ordered_ahead, [], "nothing was charged ahead of this claim");
  assert.equal(row.blocker_since, iso(NOW - 114 * MIN), "the row names the claim's own wait");
  // 2,406 - 1,283 leaves 1,123 MiB, short of one review at 1,130: all three wait for the next pass.
  assert.deepEqual([...c.overtaken()].sort(), [11901, 11902, 11903]);
  assert.deepEqual(row.overtaken_reviews, [11901, 11902, 11903]);
  assert.equal(c.claim(repair).admitted, false, "a second fix does not fit in what the first left");
});

test("W1-T9582: a review queued before the repair is still charged first", () => {
  const rows: Record<string, unknown>[] = [];
  const reviews = [
    { prNumber: 11901, sinceMs: NOW - 9 * MIN },
    { prNumber: 11800, sinceMs: NOW - 120 * MIN },
    { prNumber: 11903, sinceMs: NOW - 1 * MIN },
  ];
  const c = controller({ repairSinceMs: NOW - 114 * MIN, reviews, rows });
  const refused = c.claim(repair);
  assert.equal(refused.admitted, false, "the review queued 120 min ago is charged first: 2,406 - 1,130 = 1,276 < 1,283");
  if (refused.admitted) return;
  assert.match(refused.reason, /charged 1130 MiB for 1 reviews/, "only the review queued before the repair is charged");
  assert.deepEqual(rows.at(-1)!.ordered_ahead, [11800], "the refusal row names the review that went first");
  assert.equal(rows.at(-1)!.review_charge_mib, REVIEW_MIB);
  assert.equal(c.overtaken().size, 0, "a refused repair overtakes nothing");

  // A tie keeps today's order: a review whose PR began waiting at the same instant is charged first.
  const tied = controller({ repairSinceMs: NOW - 114 * MIN, reviews: [{ prNumber: 11800, sinceMs: NOW - 114 * MIN }], rows });
  assert.equal(tied.claim(repair).admitted, false, "equal waits: the review, then the repair");
  assert.deepEqual(rows.at(-1)!.ordered_ahead, [11800]);

  // With room for both, the older review is kept and the later ones the repair left no room for are overtaken.
  const roomy = controller({ repairSinceMs: NOW - 114 * MIN, reviews, rows, headroomMib: REVIEW_MIB + FIX_MIB + 1_200 });
  assert.equal(roomy.claim(repair).admitted, true);
  assert.deepEqual(rows.at(-1)!.ordered_ahead, [11800]);
  assert.deepEqual([...roomy.overtaken()], [11903], "the review that waited 9 min fits; the 1-min one waits");

  // Without a pressure reading the stand-in counts workers the same way: a budget of 3 with one active worker holds
  // the review queued first and the repair, and the review queued after the repair has no worker left.
  const standIn = createSweepFixAdmissionController({
    surface: "full", queueDepth: 2, hostWorkerBudget: 3, activeWorkers: 1, reviewReservations: 2,
    reviewQueue: [{ prNumber: 11800, sinceMs: NOW - 120 * MIN }, { prNumber: 11903, sinceMs: NOW - MIN }],
    waitSinceMs: () => NOW - 114 * MIN,
  });
  assert.equal(standIn.claim(repair).admitted, true, "3 - 1 active - 1 review ahead leaves one worker");
  assert.deepEqual([...standIn.overtaken()], [11903]);
});

const FLOOR_MIB = 1_024;
const REVIEW_DEFAULT = 1_024;
const FIX_DEFAULT = 2_048;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9582-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.ndjson");
}

function view(n: number, over: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`, headSha: `head-${n}`,
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: iso(NOW - 2 * MIN), createdAt: iso(NOW - 30 * MIN), ...over,
  };
}

function waiting(path: string, n: number, blocker: string, sinceMs: number): void {
  appendLedger(path, { run_id: "earlier", task_id: `W1-T${n}`, step: "sweep.disposed", pr_number: n,
    head_sha: `head-${n}`, disposition: blocker === "awaiting-review" ? "post-review" : "blocked-fixable",
    acted: false, blocker, blocker_since: iso(sinceMs) });
}

test("W1-T9582: a review the repair overtook stays queued with its own wait", async (t) => {
  const path = fixture(t);
  const repairPr = view(11785, {
    reviewState: "failure", createdAt: iso(NOW - 300 * MIN),
    unmetCriteria: [{ claim: "repair it", proof: "unit test: repair", met: false, reason: "not done", proof_exec: "executed_fail" }],
  });
  const reviewPrs = [view(11901, { createdAt: iso(NOW - 40 * MIN) }), view(11902, { createdAt: iso(NOW - 20 * MIN) }),
    view(11903, { createdAt: iso(NOW - 10 * MIN) })];
  waiting(path, 11785, "review-failed", NOW - 114 * MIN);
  waiting(path, 11901, "awaiting-review", NOW - 3 * MIN);
  waiting(path, 11902, "awaiting-review", NOW - 8 * MIN);
  waiting(path, 11903, "awaiting-review", NOW - 5 * MIN);
  const dispatched: number[] = [];
  const reviewed: number[] = [];
  const logged: Record<string, unknown>[] = [];
  const pass = async (ledgerPath: string, prs: OpenPrView[], availableMib: number): Promise<void> => {
    const deps: SweepDeps = withFullSweepRepairAdmission({
      ledgerPath, runId: "SWEEP-W1-T9582", now: () => NOW,
      arm: () => {}, close: () => {}, escalate: () => {},
      dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
      postReview: (candidate) => { reviewed.push(candidate.prNumber); },
      readActiveWorkerCount: () => 0,
      log: (step, extra) => void logged.push({ step, ...extra }),
      readFixPressure: () => ({ availableMib, floorMib: FLOOR_MIB }),
    });
    await runSweep(prs, deps, {
      ...DEFAULT_SWEEP_POLICY, reviewLanes: 3, reviewLaneMin: 1, reviewLaneMax: 3,
      reviewCapacity: { ...DEFAULT_SWEEP_POLICY.reviewCapacity, hostWorkerBudget: 8 },
    });
    await drainDetachedSweepActions();
  };
  // One fix and one review fit (2,048 + 1,024 of 3,172); the two later reviews do not.
  await pass(path, [repairPr, ...reviewPrs], FLOOR_MIB + FIX_DEFAULT + REVIEW_DEFAULT + 100);
  assert.deepEqual(dispatched, [11785], "the repair queued 114 min ago is admitted");
  assert.deepEqual(reviewed, [11902], "only the review queued longest of the three starts beside it");
  const disposed = (n: number) => readLedgerLines(path).findLast((row) => row.step === "sweep.disposed" && row.pr_number === n
    && row.run_id === "SWEEP-W1-T9582");
  for (const [n, since] of [[11901, NOW - 3 * MIN], [11903, NOW - 5 * MIN]] as const) {
    const row = disposed(n);
    assert.ok(row, `#${n} has a disposed row this pass`);
    assert.equal(row.acted, false, `#${n} is not started this pass`);
    assert.match(String(row.stand_down_reason), /overtaken by a repair queued before it/);
    assert.equal(row.blocker, "awaiting-review");
    assert.equal(row.blocker_since, iso(since), `#${n} keeps its own wait for the next pass`);
  }
  const admitted = logged.findLast((row) => row.step === "sweep.fix_capacity" && row.pr_number === 11785);
  assert.ok(admitted, "the claim's capacity row is written");
  assert.deepEqual(admitted.ordered_ahead, []);
  assert.deepEqual(admitted.overtaken_reviews, [11903, 11901], "walked in wait order");
  assert.equal(admitted.review_charge_mib, 0);

  // Room for the fix alone: every planned review is overtaken, so the pass starts no review, and a fourth candidate
  // past the planned three is not started in the lanes they gave up.
  const lanesPath = fixture(t);
  const second = view(11786, { ...repairPr, prNumber: 11786, prUrl: "https://github.com/o/r/pull/11786", headSha: "head-11786",
    taskId: "W1-T11786" });
  const fourth = view(11904, { createdAt: iso(NOW - 5 * MIN) });
  waiting(lanesPath, 11786, "review-failed", NOW - 114 * MIN);
  for (const n of [11901, 11902, 11903]) waiting(lanesPath, n, "awaiting-review", NOW - 3 * MIN);
  reviewed.length = 0;
  await pass(lanesPath, [second, ...reviewPrs, fourth], FLOOR_MIB + FIX_DEFAULT + 100);
  assert.deepEqual(dispatched, [11785, 11786]);
  assert.deepEqual(reviewed, [], "no review starts on headroom the repair took");
  const lanes = readLedgerLines(lanesPath).findLast((row) => row.step === "sweep.disposed" && row.pr_number === 11904);
  assert.match(String(lanes?.stand_down_reason), /review lanes taken by repairs queued before their reviews/);
});
