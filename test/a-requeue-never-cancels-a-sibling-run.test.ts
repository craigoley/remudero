// W1-T4586: two CI runs on one head share ci.yml's `ci-<pr>` concurrency group with
// cancel-in-progress, so re-queueing one run's cancelled job cancels the OTHER run's in-progress
// shards, and the sweep then re-queues those. OBSERVED 2026-09-26 on #7333 (head bd5ae661): a reopen
// created a second run, re-runs alternated (attempts 2, 3, 4), 18 coverage shards were cancelled, and
// the older run's aggregate `coverage-ratchet` "failure" (over cancelled shards) spent two ci-log fix
// strikes. It ended only when a new head was pushed. While a run for the head is live, the sweep waits.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-09-26T21:10:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 7333,
    prUrl: "https://github.com/craigoley/remudero/pull/7333",
    taskId: "W1-T4576",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "bd5ae661",
    headRefName: "run-W1-T4576-1790454708597",
    autoMergeArmed: false,
    ...over,
  };
}

function deps(live: boolean): SweepDeps & { requeued: string[]; fixed: number; asked: number } {
  const state = { requeued: [] as string[], fixed: 0, asked: 0 };
  return Object.assign(state, {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {
      state.fixed++;
    },
    escalate: () => {},
    requeueCheck: async (_p: OpenPrView, check: { name: string }) => {
      state.requeued.push(check.name);
    },
    escalateCancelledCheck: async () => {},
    liveCiRunForHead: () => {
      state.asked++;
      return live;
    },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1t4586-")), "ledger.ndjson"),
    runId: "SWEEP-W1T4586",
    now: () => NOW,
  }) as unknown as SweepDeps & { requeued: string[]; fixed: number; asked: number };
}

test("W1-T4586: while another run for the head is live, a cancelled job is not re-queued and no fix strike is spent", async () => {
  const cancelled = pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "" }], cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "108483661210" }] });
  const waiting = deps(true);
  await runSweep([cancelled], waiting, DEFAULT_SWEEP_POLICY);
  assert.equal(waiting.asked, 1, "the live-run read is taken once, only because the sweep was about to act on red CI");
  assert.deepEqual(waiting.requeued, [], "no re-queue over a live sibling run — that re-queue is what cancelled it");
  assert.equal(waiting.fixed, 0, "and no fix strike on a red the live run supersedes");

  const genuine = pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "diff-coverage: BLOCKED -- src/lib/x.ts:12" }] });
  const stillWaiting = deps(true);
  await runSweep([genuine], stillWaiting, DEFAULT_SWEEP_POLICY);
  assert.equal(stillWaiting.fixed, 0, "an older run's failure waits for the live run's verdict too");
});

test("W1-T4586: with no live run for the head, the existing bounded re-queue still happens", async () => {
  const cancelled = pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "" }], cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "108483661210" }] });
  const idle = deps(false);
  await runSweep([cancelled], idle, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(idle.requeued, ["coverage-ratchet"], "one bounded re-queue, exactly as W1-T1223 ships it");
  assert.equal(idle.fixed, 0);
});

test("a stale red snapshot cannot re-queue an old job over a new PR head's CI", async () => {
  const cancelled = pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "" }], cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "110537194330" }] });
  const stale = deps(false);
  stale.readLiveState = () => ({ ok: true, state: "OPEN", headSha: "new-head" });
  await runSweep([cancelled], stale, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(stale.requeued, [], "the old job is never rerun after a new head appears");
  assert.equal(stale.fixed, 0, "the old red spends no fix strike");
  assert.match(readFileSync(stale.ledgerPath, "utf8"), /PR head advanced from bd5ae661 to new-head/);
});
