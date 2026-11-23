import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11559,
    prUrl: "https://github.com/craigoley/remudero/pull/11559",
    taskId: "W1-T9408",
    headSha: "old-head",
    headRefName: "run-W1-T9408-1794830854006",
    checksState: "none",
    reviewState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    autoMergeArmed: false,
    lastActivityAt: new Date(NOW - DEFAULT_SWEEP_POLICY.absentCeilingMinutes * 60_000).toISOString(),
    ...overrides,
  };
}

test("W1-T9408: flow-other-not-positively-mergeable clears without a person", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-flow-mergeable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const effects: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "flow-recovery",
    now: () => NOW,
    repushAbsent: async () => { effects.push("recover-ci"); return "recovered-head"; },
    postReview: () => { effects.push("review"); },
    arm: () => { effects.push("arm"); },
    close: () => assert.fail("recovery must not close the PR"),
    dispatchFix: () => assert.fail("absent checks need no code repair"),
    escalate: () => assert.fail("a recoverable CI absence needs no person"),
  };
  await runSweep([pr()], deps);
  assert.deepEqual(effects, ["recover-ci"]);
  const disposed = readLedgerLines(deps.ledgerPath).find((row) => row.step === "sweep.disposed");
  assert.ok(disposed);
  assert.equal(disposed.blocker, "awaiting-ci");
  assert.equal(disposed.blocker_owner, "ci");
  assert.doesNotMatch(String(disposed.reason), /not positively mergeable/);

  const recovered = pr({ headSha: "recovered-head", lastActivityAt: new Date(NOW).toISOString() });
  await runSweep([recovered], deps);
  await runSweep([{ ...recovered, checksState: "pending" }], deps);
  assert.deepEqual(effects, ["recover-ci"], "a fresh head waits for CI without another push");
  await runSweep([{ ...recovered, checksState: "green" }], deps);
  assert.deepEqual(effects, ["recover-ci", "review"]);
  appendFileSync(deps.ledgerPath, JSON.stringify({ ts: new Date(NOW).toISOString(), run_id: "REVIEW", task_id: recovered.taskId,
    step: "review.posted", pr_url: recovered.prUrl, head_sha: recovered.headSha, capped: false, plan_only: false }) + "\n");
  await runSweep([{ ...recovered, checksState: "green", reviewState: "success" }], deps);
  assert.deepEqual(effects, ["recover-ci", "review", "arm"]);
});

test("CI recovery ownership does not claim an unreadable or certified head", () => {
  for (const overrides of [
    { lastActivityAt: "unreadable" },
    { headRefName: undefined },
    { reviewState: "success" as const },
  ]) {
    const result = deriveDisposition(pr(overrides), DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(result.disposition, "blocked-ambiguous");
    assert.equal(result.blocker, "other");
  }
});

test("CI recovery remains bounded when its new head still has no checks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-flow-bounded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const effects: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "flow-bounded",
    now: () => NOW,
    repushAbsent: async () => { effects.push("recover-ci"); return "still-absent"; },
    arm: () => assert.fail("missing checks cannot be armed"),
    close: () => assert.fail("missing checks cannot close the PR"),
    dispatchFix: () => assert.fail("missing checks need no code repair"),
    escalate: () => { effects.push("escalate"); },
  };
  await runSweep([pr()], deps);
  await runSweep([pr({ headSha: "still-absent" })], deps);
  assert.deepEqual(effects, ["recover-ci", "escalate"]);
});
