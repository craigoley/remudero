// W1-T12024: from 2026-11-07 to 2026-11-10 the core daemon stood 39 PR heads down for the 60 minute pending ceiling
// because a synchronous GitHub read met a pacing gap on its loop (25 ms in 36 of 45 throws). One of the 39 was
// reviewed again on the same head; #17601 took 75 minutes from open to merge and opened a stuck-PR escalation.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GhPaceWouldBlockError } from "#src/lib/github-transport.js";
import { readLedgerLines } from "#src/lib/status.js";
import { postReviewPastPacerGaps, REVIEW_PACER_GAP_RETRIES } from "#src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.now();

function reviewPr(n = 12024): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW - 120 * 60_000).toISOString(), headSha: `sha-${n}`,
    reviewInputDigest: `digest-${n}`, autoMergeArmed: false,
  };
}

function sweepDeps(postReview: NonNullable<SweepDeps["postReview"]>, rows: Array<[string, Record<string, unknown>]>): SweepDeps {
  return {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-review-pacer-gap-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T12024", now: () => NOW, log: (step, extra) => void rows.push([step, extra ?? {}]),
  };
}

test("W1-T12024 criterion 1: a review attempt that meets a pacing gap before any phase waits it out and reviews the same head in the same pass", async () => {
  const rows: Array<[string, Record<string, unknown>]> = [];
  let calls = 0;
  const deps = sweepDeps(() => {
    calls += 1;
    if (calls <= 2) throw new GhPaceWouldBlockError(25);
  }, rows);
  await runSweep([reviewPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls, 3, "two gaps were waited out and the third attempt ran");
  const ledger = readLedgerLines(deps.ledgerPath);
  assert.deepEqual(ledger.filter((line) => line.step === "review.post_refused"), [], "no retry key is left on the head");
  assert.equal(ledger.findLast((line) => line.step === "sweep.disposed")?.acted, true);
  const gaps = rows.filter(([step]) => step === "sweep.post_review.pacer_gap_waited").map(([, extra]) => extra);
  assert.deepEqual(gaps.map((gap) => [gap.pr_number, gap.head_sha, gap.wait_ms, gap.attempt]), [[12024, "sha-12024", 25, 1], [12024, "sha-12024", 25, 2]]);
  assert.match(String(gaps[0]!.site), /a-review-attempt-waits-out-a-github-pacing-gap/, "the row names the caller that met the gap");
});

test("W1-T12024 criterion 2: any other throw, and a pacing gap after a review phase has run, keep the existing bounded retry key and are never retried in place", async () => {
  for (const [name, post] of [
    ["another throw", (): void => { throw new Error("transient transport"); }],
    ["a gap after a phase", (_pr: unknown, _mode: unknown, _id: unknown, onPhase?: (phase: string) => void): void => {
      onPhase?.("posted");
      throw new GhPaceWouldBlockError(25);
    }],
  ] as const) {
    const rows: Array<[string, Record<string, unknown>]> = [];
    let calls = 0;
    const deps = sweepDeps((...args) => { calls += 1; return post(...args); }, rows);
    await runSweep([reviewPr()], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(calls, 1, `${name}: one attempt`);
    const refused = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "review.post_refused");
    assert.equal(refused.length, 1, name);
    assert.match(String(refused[0]!.reason), /^post-review attempt threw — standing down rather than retrying this head unbounded:/);
    assert.deepEqual(rows.filter(([step]) => step === "sweep.post_review.pacer_gap_waited"), [], name);
  }
});

test("W1-T12024 criterion 3: the waits are bounded and sleep exactly the gap the pacer named, on a timer", async () => {
  const slept: number[] = [];
  let calls = 0;
  await assert.rejects(postReviewPastPacerGaps(() => {
    calls += 1;
    throw new GhPaceWouldBlockError(100 + calls);
  }, { sleep: async (ms) => void slept.push(ms) }), GhPaceWouldBlockError);
  assert.equal(calls, REVIEW_PACER_GAP_RETRIES + 1, "the attempt after the last wait throws to the caller");
  assert.deepEqual(slept, [101, 102, 103]);
  // Control: with no gap nothing sleeps and the phase reaches the caller's observer.
  const phases: string[] = [];
  await postReviewPastPacerGaps((onPhase) => onPhase("posted"), { onPhase: (phase) => void phases.push(phase), sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual([phases, slept.length], [["posted"], 3]);
});
