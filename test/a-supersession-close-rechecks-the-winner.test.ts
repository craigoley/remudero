import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type LiveStateResult,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.now();

function supersededPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6070,
    prUrl: "https://github.com/craigoley/remudero/pull/6070",
    taskId: "W1-T3502",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    headSha: "loser-head",
    supersededBy: 6071,
    supersessionVerdict: {
      status: "superseded",
      evidence: {
        supersedingPrNumber: 6071,
        taskId: "W1-T3502",
        diff: { rawLineCount: 20, matchedHunks: 2 },
      },
    },
    autoMergeArmed: false,
    ...over,
  } as OpenPrView;
}

function deps(
  readWinner: (pr: OpenPrView) => LiveStateResult | Promise<LiveStateResult>,
): SweepDeps & { closed: OpenPrView[]; reads: OpenPrView[]; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-supersession-close-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const closed: OpenPrView[] = [];
  const reads: OpenPrView[] = [];
  return {
    closed,
    reads,
    ledgerPath,
    runId: "SWEEP-W1-T3784",
    now: () => NOW,
    arm: () => {},
    close: (pr) => { closed.push(pr); },
    dispatchFix: () => {},
    escalate: () => {},
    readLiveState: (pr) => {
      reads.push(pr);
      return readWinner(pr);
    },
  } as SweepDeps & { closed: OpenPrView[]; reads: OpenPrView[]; ledgerPath: string };
}

test("W1-T3784 winner closed after the snapshot produces a named stand-down and never closes the loser", async () => {
  const sweep = deps(() => ({ ok: true, state: "CLOSED" }));

  const summary = await runSweep([supersededPr()], sweep, DEFAULT_SWEEP_POLICY);

  assert.equal(sweep.closed.length, 0);
  assert.equal(sweep.reads.length, 1);
  assert.equal(sweep.reads[0]?.prNumber, 6071);
  assert.equal(summary.actions[0]?.acted, false);
  const rows = readLedgerLines(sweep.ledgerPath).filter((row) => row.step === "sweep.supersession_close.stood_down");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.pr_number, 6070);
  assert.equal(rows[0]?.superseding_pr_number, 6071);
  assert.match(String(rows[0]?.reason), /successor #6071 is CLOSED/);
});

test("W1-T3784 winner remains open closes duplicate", async () => {
  const sweep = deps(() => ({ ok: true, state: "OPEN" }));

  await runSweep([supersededPr()], sweep, DEFAULT_SWEEP_POLICY);

  assert.equal(sweep.reads.length, 1);
  assert.equal(sweep.reads[0]?.prNumber, 6071);
  assert.deepEqual(sweep.closed.map((pr) => pr.prNumber), [6070]);
});

test("W1-T3784 unreadable successor stands down", async () => {
  for (const readWinner of [
    () => { throw new Error("GitHub unavailable"); },
    () => ({ ok: true } as LiveStateResult),
  ]) {
    const sweep = deps(readWinner);

    await runSweep([supersededPr()], sweep, DEFAULT_SWEEP_POLICY);

    assert.equal(sweep.closed.length, 0);
    const row = readLedgerLines(sweep.ledgerPath).find((entry) => entry.step === "sweep.supersession_close.stood_down");
    assert.ok(row);
    assert.match(String(row.reason), /successor #6071 is (UNREADABLE|MALFORMED)/);
  }
});

test("W1-T3784 non-supersession stale does not read winner", async () => {
  const sweep = deps(() => { throw new Error("winner read must not run"); });
  const abandoned = supersededPr({
    supersededBy: undefined,
    supersessionVerdict: undefined,
    lastActivityAt: "2026-01-01T00:00:00Z",
  });

  await runSweep([abandoned], sweep, DEFAULT_SWEEP_POLICY);

  assert.equal(sweep.reads.length, 0);
  assert.deepEqual(sweep.closed.map((pr) => pr.prNumber), [6070]);
});
