/**
 * W1-T7955 — a light pass names a review already in flight.
 *
 * Overlapping light passes share review admissions through a process-wide reservation keyed by
 * head (W1-T4732). A head another pass holds is dropped from this pass's selection, so it used to
 * fall into the not-admitted branch and read "not admitted this pass: semantic post-review admission
 * bound N" for a review that was in fact running. These tests drive two overlapping
 * `runSweepLightPass` calls, the first holding its review open.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { readLedgerLines } from "#src/lib/status.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const IN_FLIGHT = "review already in flight for this head (admitted by an overlapping light pass)";

function postReviewPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10,
    prUrl: "https://github.com/o/r/pull/10",
    taskId: "W1-T10",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-10T00:00:00Z",
    headSha: "sha10",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(ledgerPath: string, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath,
    runId: "SWEEP-T7955",
    now: () => NOW,
    ...overrides,
  };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t7955-")), "ledger.ndjson");
}

/** Start a first light pass whose review stays open until `release()`; resolves once the review began. */
async function holdReviewOpen(prs: OpenPrView[], policy = DEFAULT_SWEEP_POLICY): Promise<{
  release: () => Promise<void>;
}> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
  const first = runSweepLightPass(prs, fakeDeps(ledgerPath(), {
    postReview: async () => {
      started();
      await gate;
    },
  }), policy);
  await reviewStarted;
  return { release: async () => { release(); await first; } };
}

function disposedRow(path: string, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(path).find((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
}

test("W1-T7955: an overlapping light pass names the review already in flight", async () => {
  const held = postReviewPr();
  const first = await holdReviewOpen([held]);
  try {
    const lp = ledgerPath();
    const posted: number[] = [];
    await runSweepLightPass([held], fakeDeps(lp, { postReview: (p) => { posted.push(p.prNumber); } }), DEFAULT_SWEEP_POLICY);
    const row = disposedRow(lp, 10);
    assert.deepEqual(posted, [], "the overlapping pass does not start a second review for the held head");
    assert.equal(row?.acted, false);
    assert.equal(row?.stand_down_reason, IN_FLIGHT);
    assert.doesNotMatch(String(row?.stand_down_reason), /^not admitted this pass/);
  } finally {
    await first.release();
  }
});

test("W1-T7955: a PR that lost admission keeps the admission-bound text", async () => {
  const lp = ledgerPath();
  const queue = [30, 20, 10].map((prNumber) =>
    postReviewPr({
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      taskId: `W1-T${prNumber}`,
      headSha: `sha${prNumber}`,
      lastActivityAt: `2026-10-0${prNumber / 10}T00:00:00Z`,
    }));
  await runSweepLightPass(queue, fakeDeps(lp, { postReview: () => {} }), { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2 });
  const row = disposedRow(lp, 30);
  assert.equal(row?.acted, false);
  assert.equal(
    row?.stand_down_reason,
    "not admitted this pass: semantic post-review admission bound 2; admitted #10, #20 ahead",
  );
});

test("W1-T7955: a reservation for an older head is not this head in flight", async () => {
  const first = await holdReviewOpen([postReviewPr({ headSha: "sha-old" })]);
  try {
    const lp = ledgerPath();
    // The same PR, pushed since: a new head. One lane, already used by the older head's review.
    await runSweepLightPass(
      [postReviewPr({ headSha: "sha-new" })],
      fakeDeps(lp, { postReview: () => {} }),
      { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 },
    );
    const row = disposedRow(lp, 10);
    assert.equal(row?.acted, false);
    assert.notEqual(row?.stand_down_reason, IN_FLIGHT, "an older head's review is not this head's review");
    assert.match(String(row?.stand_down_reason), /^not admitted this pass: semantic post-review admission bound/);
  } finally {
    await first.release();
  }
});
