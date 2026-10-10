import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSweep, type OpenPrView } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TASK = "W1-T6001";
const HEAD = "cd62a1800000000000000000000000000000000000";
const OLD_HEAD = "b95338c00000000000000000000000000000000000";
const PR = 9505;
const NOW = Date.now();
const REASON = `a needs-human escalation for this exact (task, PR, head ${HEAD}, cause) is ALREADY OPEN ` +
  "and awaiting a human (https://github.com/craigoley/remudero/issues/9507)";
const disposed = { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD,
  disposition: "blocked-fixable", acted: true };
const stoodDown = { step: "fix.stood_down", task_id: TASK, site: "rung.strike", strike: 1, reason: REASON };
const dispatch = (head: string, step = "fix.dispatch") => ({ step, task_id: TASK, head_sha: head });

async function pass(seed: Record<string, unknown>[], head = HEAD) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6001-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  let dispatched = 0;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`, taskId: TASK,
    reviewState: "failure", checksState: "green",
    unmetCriteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "unmet",
      proof_exec: "not_executable" }],
    priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: head,
    headRefName: "run-W1-T6001-1791665642527", autoMergeArmed: false,
  };
  try {
    await runSweep([pr], {
      arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => { dispatched++; },
      ledgerPath, runId: "SWEEP-W1-T6001", now: () => NOW,
      // A different head's completion masks the stand-down in the existing task-wide stalled fold.
      readLedger: () => [...seed, { step: "fix.resolved", task_id: TASK, head_sha: OLD_HEAD },
        ...readLedgerLines(ledgerPath)],
    });
    const row = readLedgerLines(ledgerPath).findLast(line => line.step === "sweep.disposed");
    assert.ok(row, "the pass dispositions the fixture PR");
    return { row, dispatched };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("test/a-fix-stand-down-is-not-read-as-a-dispatched-fix.test.ts: a stand-down names its reason instead of a dispatch", async () => {
  for (const stand of [stoodDown, { ...stoodDown, pr_number: PR, head_sha: HEAD }]) {
    for (const seed of [[dispatch(OLD_HEAD), disposed, stand], [dispatch(OLD_HEAD), stand, disposed]]) {
      const next = await pass(seed);
      assert.equal(next.dispatched, 0);
      assert.equal(next.row.acted, false);
      assert.equal(next.row.stand_down_reason, REASON);
      assert.doesNotMatch(String(next.row.reason), /fix already dispatched/);
    }
  }
});

test("a real dispatch, retrigger and pending detached dispatch retain their dispatch dedup", async () => {
  for (const seed of [
    [dispatch(OLD_HEAD), disposed],
    [disposed, stoodDown, dispatch(HEAD)],
    [disposed, dispatch(HEAD), stoodDown],
    [disposed, stoodDown, dispatch(HEAD, "fix.retrigger"), dispatch(OLD_HEAD)],
  ]) {
    const next = await pass(seed);
    assert.equal(next.dispatched, 0);
    assert.match(String(next.row.stand_down_reason), /fix already dispatched/);
  }
});

test("stand-downs for another task or head and ci handoffs do not become stand-down holds", async () => {
  for (const stand of [
    { ...stoodDown, task_id: "W1-T9999" },
    { ...stoodDown, head_sha: OLD_HEAD },
    { ...stoodDown, reason: REASON.replace(HEAD, OLD_HEAD) },
    { ...stoodDown, head_sha: HEAD, outcome: "handed_off" },
  ]) {
    const next = await pass([dispatch(OLD_HEAD), disposed, stand]);
    assert.match(String(next.row.stand_down_reason), /fix already dispatched/);
  }
  const fresh = await pass([dispatch(OLD_HEAD), disposed, stoodDown], "f00dface0000000000000000000000000000000000");
  assert.equal(fresh.dispatched, 1, "a new head re-earns its fix round");
});
