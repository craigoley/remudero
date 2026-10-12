import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readMergeCreditedTaskIds } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runCreditBackfill } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T6275 — THE SWEEP'S LEDGER-HISTORY READS RUN OFF THE DAEMON LOOP. readFleetState read the whole ledger union with
 * readLedgerUnionRawLinesSync, and runCreditBackfill's credit scan read it with readLedgerUnionRecordsSync: 32.3 s and
 * 29.8 s unbroken daemon-loop blocks in a live CPU profile (2026-10-07 21:42Z).
 *
 * THE DISCRIMINATOR: a setImmediate armed before the call has fired by the time the work AFTER the read runs only if
 * the read gave the loop a turn. A synchronous read finishes inside the same macrotask, so it has not.
 * FIXTURES ONLY: every ledger and rotation lives in a throwaway directory.
 */

const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", ...o });

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6275-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

test("W1-T6275: the fleet-state history read is asynchronous", async () => {
  const root = stateDir();
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, `${row({ task_id: "SWEEP", step: "deploy.ok", run_id: "d" })}\n`);
    writeFileSync(join(root, "state", "ledger.2026-10-06T00-00-00-000Z.ndjson"), `${row({ task_id: "SWEEP", step: "reconcile.repaired", run_id: "r" })}\n`);
    let turned = false;
    let turnedAtFirstRead: boolean | undefined;
    const effects = buildSweepEffects({
      owner: "acme", repo: "widgets", repoRoot: join(import.meta.dirname, ".."),
      config: { root } as never, ledgerPath, runId: "t6275", plan: { tasks: [], byId: new Map() } as never,
      policy: DEFAULT_SWEEP_POLICY, log: () => {},
      readJsonImpl: async () => { turnedAtFirstRead ??= turned; return []; },
      ghRunImpl: () => {},
    });
    setImmediate(() => { turned = true; });
    const state = await effects.readFleetState!([]);
    assert.equal(turnedAtFirstRead, true, "the history read gave the event loop a turn before the GitHub reads began");
    assert.ok(state.history.some((r) => r.step === "reconcile.repaired"), "and it still read the rotated history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6275: the credit backfill reads merge credits asynchronously with the same result", async () => {
  const root = stateDir();
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, `${row({ task_id: "W1-T2", step: "run.start", run_id: "x" })}\n`);
    writeFileSync(join(root, "state", "ledger.2026-10-06T00-00-00-000Z.ndjson"), `${row({ task_id: "W1-T1", step: "verdict.merged", verdict: "merged" })}\n`);
    const candidates = [
      { taskId: "W1-T1", prNumber: 1, prUrl: "https://github.com/o/r/pull/1", merged: true },
      { taskId: "W1-T2", prNumber: 2, prUrl: "https://github.com/o/r/pull/2", merged: true },
    ];
    const syncScan = readMergeCreditedTaskIds(ledgerPath, { candidates: candidates.map((c) => c.taskId) });
    let turned = false;
    let turnedAtFirstAppend: boolean | undefined;
    setImmediate(() => { turned = true; });
    const summary = await runCreditBackfill(candidates, {
      ledgerPath, runId: "t6275", readCreditStore: () => ({}) as never, writeCreditStore: () => {},
      appendLine: () => { turnedAtFirstAppend ??= turned; },
    } as never);
    assert.equal(turnedAtFirstAppend, true, "the credit scan gave the event loop a turn before the first correction");
    assert.deepEqual(summary.results.map((r) => [r.taskId, r.corrected]), [["W1-T1", false], ["W1-T2", true]],
      "the rotated credit still suppresses W1-T1's correction and W1-T2 is still corrected");
    assert.equal(summary.creditScanFilesRead, syncScan.filesRead, "the same walk as the synchronous scan");
    assert.equal(summary.creditScanComplete, syncScan.complete);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
