// W1-T1049 — THE REVIEW LANE'S OWN CONCURRENCY BUDGET.
//
// Proves the four acceptance criteria from
// plan/tasks.d/W1-T1049-drainage-has-no-concurrency-budget-of-its-own.yaml:
//   1. the review lane ceiling is read from its own policy row, not from dispatchLanes
//   2. a pass with no eligible review starts no review lanes
//   3. a misconfigured zero still reviews one PR rather than none
//   4. dispatchLanes still governs dispatch and no longer governs the review lane
//
// Before this task, `runSweep`'s review ceiling was `Math.max(1, policy.dispatchLanes)` — the
// dispatch field read a SECOND time (W1-T473), with no sibling policy row of its own. That
// silently coupled two unrelated ceilings: any future retune of either moved both, and the two
// ceilings ADD on the host with nothing naming their sum (3 dispatch lanes + 3 review lanes = 6
// concurrent Claude workers on a host measured to fit about 4 — plan/tasks.d/W1-T1049's own
// rationale (4)). `policy.reviewLanes` is now the review lane's own, independently-tunable row
// (`plan/policy.yaml`'s `sweep.reviewLanes`) — this file proves it actually bounds the lane, and
// that `dispatchLanes` no longer does.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyError } from "../src/lib/policy.js";
import { DEFAULT_SWEEP_POLICY, runSweep, validateReviewLanesRow, type OpenPrView, type SweepDeps, type SweepPolicy } from "../src/lib/sweep.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-review-lane-budget-")), "ledger.ndjson");
}

/** A checks-green, review-never-posted PR — `deriveDisposition` routes this to
 *  "post-review" (src/lib/sweep.ts), the ONE disposition `policy.reviewLanes` bounds. */
function reviewablePr(n: number): OpenPrView {
  return {
    prNumber: n,
    prUrl: `url/${n}`,
    taskId: `W1-BUDGET-${n}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-19T12:00:00Z",
    headSha: `sha${n}`,
    autoMergeArmed: false,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "REVIEW-LANE-BUDGET-1",
    now: () => Date.parse("2026-08-20T12:00:00Z"),
    ...overrides,
  };
}

// ── acceptance 1: the ceiling is read from reviewLanes, NOT dispatchLanes ──────────────────

test("W1-T1049/W1-T2584 acceptance 1 — reviewLanes, not dispatchLanes, bounds simultaneous reviewers while the pass drains every eligible head", async () => {
  // dispatchLanes is generous (4, its own committed max). If the pre-W1-T1049 defect (runSweep
  // reading dispatchLanes a second time) were still live, all 3 PRs below would run this pass.
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dispatchLanes: 4, reviewLanes: 1 };
  const prs = [reviewablePr(1101), reviewablePr(1102), reviewablePr(1103)];

  const attempts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = fakeDeps({ postReview: async (p) => {
    attempts.push(p.prNumber);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
  } });
  const summary = await runSweep(prs, deps, policy);

  assert.equal(summary.byDisposition["post-review"], 3, "eligibility is unaffected — all 3 PRs still derive post-review");
  assert.equal(attempts.length, 3, "the pass drains all eligible reviews");
  assert.equal(maxInFlight, 1, "reviewLanes (1), not dispatchLanes (4), bounds simultaneous reviewers");
});

// ── acceptance 2: a pass with no eligible review starts no review lanes ────────────────────

test("W1-T1049 acceptance 2 — a pass with NO post-review-eligible PRs starts ZERO review lanes, however large reviewLanes is", async () => {
  const wideOpen: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 3 };
  const calls: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { calls.push(p.prNumber); } });

  const summary = await runSweep([], deps, wideOpen);
  assert.equal(summary.total, 0);
  assert.deepEqual(calls, [], "no open PRs at all -> postReview is never invoked, however large the lane budget is");
});

// ── acceptance 3: a misconfigured zero still reviews one PR, never none ────────────────────

test("W1-T1049/W1-T2584 acceptance 3 — reviewLanes: 0 retains a one-reviewer concurrency floor while draining the pass", async () => {
  const misconfigured: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 0 };
  const prs = [reviewablePr(1201), reviewablePr(1202)];

  const attempts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = fakeDeps({ postReview: async (p) => {
    attempts.push(p.prNumber);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
  } });
  const summary = await runSweep(prs, deps, misconfigured);

  assert.equal(summary.byDisposition["post-review"], 2, "eligibility is unaffected by the misconfigured ceiling");
  assert.equal(attempts.length, 2, "the floor does not become a per-pass throughput cap");
  assert.equal(maxInFlight, 1, "the floor of 1 survives a reviewLanes: 0 misconfiguration");
});

// ── acceptance 4: dispatchLanes still governs dispatch, and no longer governs review ───────

test("W1-T1049 acceptance 4 — dispatchLanes remains independent while reviewLanes alone bounds review concurrency", async () => {
  // The inverse of acceptance 1: dispatchLanes is now the TIGHT one (1, its own committed
  // floor) and reviewLanes is wide (3). If dispatchLanes still governed review (the
  // pre-W1-T1049 defect), this pass would run only 1 — it must run all 3.
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dispatchLanes: 1, reviewLanes: 3 };
  const prs = [reviewablePr(1301), reviewablePr(1302), reviewablePr(1303)];

  const attempts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release: () => void = () => {};
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const deps = fakeDeps({ postReview: async (p) => {
    attempts.push(p.prNumber);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (attempts.length === 3) release();
    await allStarted;
    inFlight -= 1;
  } });
  const summary = await runSweep(prs, deps, policy);

  assert.equal(summary.byDisposition["post-review"], 3);
  assert.equal(attempts.length, 3, "the pass drains every eligible review");
  assert.equal(maxInFlight, 3, "reviewLanes (3), not dispatchLanes (1), supplies the review concurrency width");
  // dispatchLanes' own field carries exactly what the caller set it to — this task does not
  // retune or reinterpret its MEANING, only stops runSweep consulting it for review concurrency.
  assert.equal(policy.dispatchLanes, 1, "dispatchLanes' own value is untouched — still whatever dispatch set it to");
});

// ── the split is a no-op today: the shipped default preserves today's effective behavior ──

test("W1-T1049 — DEFAULT_SWEEP_POLICY.reviewLanes defaults to dispatchLanes' own shipped value: the split changes NO effective behavior by itself, only who controls the number", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLanes, DEFAULT_SWEEP_POLICY.dispatchLanes);
});

// ── every refusal arm of the policy row's validator, one test each ─────────────────────────
//
// `loadReviewLanesPolicy` runs at module load against the SHIPPED plan/policy.yaml, so its happy
// path is covered by importing this module at all — and every refusal arm is unreachable that
// way, because the shipped row is well-formed. Splitting the decisions out of the file read
// (`validateReviewLanesRow`) makes each arm reachable directly, with no temp policy file and no
// override seam on `installPolicyPath`. Each arm gets its own test: a single "a malformed row
// throws" case would pass while four of the five arms stayed dead.

test("W1-T1049 — a 'sweep.reviewLanes' that is not a mapping is refused, naming the shape it needed", () => {
  for (const row of [undefined, null, 3, "3"]) {
    assert.throws(() => validateReviewLanesRow(row), (e: unknown) => e instanceof PolicyError && /must be a mapping/.test((e as Error).message));
  }
});

test("W1-T1049 — a non-finite 'sweep.reviewLanes.value' is refused, naming the value it got", () => {
  for (const value of ["3", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateReviewLanesRow({ value, min: 1, max: 8 }),
      (e: unknown) => e instanceof PolicyError && /'sweep\.reviewLanes\.value' must be a finite number/.test((e as Error).message),
    );
  }
});

test("W1-T1049 — 'sweep.reviewLanes' without finite numeric min and max bounds is refused", () => {
  for (const [min, max] of [[undefined, 8], [1, undefined], ["1", 8], [1, "8"], [Number.NaN, 8], [1, Number.POSITIVE_INFINITY]]) {
    assert.throws(
      () => validateReviewLanesRow({ value: 3, min, max }),
      (e: unknown) => e instanceof PolicyError && /must carry numeric 'min' and 'max' bounds/.test((e as Error).message),
    );
  }
});

test("W1-T1049 — a 'sweep.reviewLanes' bound with min greater than max is refused as unsatisfiable", () => {
  assert.throws(
    () => validateReviewLanesRow({ value: 3, min: 8, max: 1 }),
    (e: unknown) => e instanceof PolicyError && /min \(8\) > max \(1\) — an unsatisfiable bound/.test((e as Error).message),
  );
});

test("W1-T1049 — a 'sweep.reviewLanes.value' outside its own declared bound is refused, on either side", () => {
  for (const value of [0, 9]) {
    assert.throws(
      () => validateReviewLanesRow({ value, min: 1, max: 8 }),
      (e: unknown) => e instanceof PolicyError && /is out of its declared bound \[1, 8\]/.test((e as Error).message),
    );
  }
});

// The positive control for the five refusals above: the same validator accepts a well-formed row
// and returns its value, so those throws are arm-specific rather than the function refusing
// everything handed to it.
test("W1-T1049 — a well-formed 'sweep.reviewLanes' row returns its value, including at either bound", () => {
  assert.equal(validateReviewLanesRow({ value: 3, min: 1, max: 8 }), 3);
  assert.equal(validateReviewLanesRow({ value: 1, min: 1, max: 8 }), 1);
  assert.equal(validateReviewLanesRow({ value: 8, min: 1, max: 8 }), 8);
});
