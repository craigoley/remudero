/**
 * W1-T3223 — the bounded ledger scan may forget a correction after rotation, but the writer must
 * not. These tests exercise the real atomic credit store and put the original correction behind
 * more rotations than `readMergeCreditedTaskIds` is allowed to open.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  CREDIT_SCAN_MAX_ROTATIONS,
  defaultCreditStorePath,
  hasCreditBackfillReceipt,
  loadCreditStore,
  recordCredit,
  saveCreditStore,
  singlePathCreditedIds,
  type CreditStore,
} from "../src/lib/status.js";
import { runCreditBackfill, type CreditCandidate } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tempState(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}credit-receipt-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { dir, ledgerPath };
}

function candidate(taskId: string, prNumber: number): CreditCandidate {
  return {
    taskId,
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    merged: true,
  };
}

function ledgerRow(taskId: string, prNumber: number): string {
  return JSON.stringify({
    ts: "2026-09-09T00:00:00.000Z",
    run_id: "prior",
    task_id: taskId,
    step: "verdict.merged",
    verdict: "merged",
    pr_number: prNumber,
    pr_url: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    source: "sweep.credit_backfill",
  });
}

/** Put `oldestRows` just outside the production reader's newest-first rotation budget. */
function exhaustBoundedScan(dir: string, oldestRows: string[] = []): void {
  const oldest = join(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz");
  writeFileSync(oldest, gzipSync(Buffer.from(`${oldestRows.join("\n")}${oldestRows.length ? "\n" : ""}`)));
  for (let i = 0; i < CREDIT_SCAN_MAX_ROTATIONS; i++) {
    const stamp = String(i).padStart(2, "0");
    const path = join(dir, `ledger.2026-09-02T${stamp}-00-00-000Z.ndjson.gz`);
    const noise = JSON.stringify({ ts: `2026-09-02T${stamp}:00:00.000Z`, step: "daemon.poll", n: i });
    writeFileSync(path, gzipSync(Buffer.from(`${noise}\n`)));
  }
}

test("a successful correction remains suppressed after its ledger row rotates beyond the bounded scan", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    const c = candidate("W1-T-RECEIPT", 4101);
    const first = await runCreditBackfill([c], { ledgerPath, runId: "first" });
    assert.equal(first.corrected, 1);
    assert.equal(hasCreditBackfillReceipt(loadCreditStore(defaultCreditStorePath(ledgerPath)), c.taskId), true);

    const appended = readFileSync(ledgerPath, "utf8").trim();
    writeFileSync(ledgerPath, "");
    exhaustBoundedScan(dir, [appended]);

    const second = await runCreditBackfill([c], { ledgerPath, runId: "second" });
    assert.equal(second.creditScanExhaustedBudget, true, "the ledger reader must genuinely miss the old correction");
    assert.equal(second.corrected, 0, "the durable writer receipt, not the bounded scan, prevents the duplicate");
    assert.equal(second.durableReceiptSuppressions, 1);
    assert.equal(second.results[0]?.durablyBackfilled, true);
    assert.equal(readFileSync(ledgerPath, "utf8"), "", "the second pass appends no correction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuinely new merge is corrected once even when the bounded scan exhausts", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    exhaustBoundedScan(dir);
    const c = candidate("W1-T-NEW", 4102);
    const summary = await runCreditBackfill([c], { ledgerPath, runId: "new" });

    assert.equal(summary.creditScanExhaustedBudget, true);
    assert.equal(summary.corrected, 1, "budget exhaustion alone must not stand down a real correction");
    assert.equal(summary.durableReceiptSuppressions, 0);
    assert.equal(hasCreditBackfillReceipt(loadCreditStore(defaultCreditStorePath(ledgerPath)), c.taskId), true);
    assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary durable merge evidence does not suppress the first ledger correction", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    exhaustBoundedScan(dir);
    const c = candidate("W1-T-EVIDENCE-NOT-RECEIPT", 4103);
    const storePath = defaultCreditStorePath(ledgerPath);
    const withTrailer = recordCredit({}, c.taskId, {
      source: "trailer",
      prUrl: c.prUrl,
      prNumber: c.prNumber,
      prState: "MERGED",
    });
    saveCreditStore(storePath, withTrailer);

    const summary = await runCreditBackfill([c], { ledgerPath, runId: "first-backfill" });
    const after = loadCreditStore(storePath);
    assert.equal(summary.corrected, 1, "merge evidence is not proof that this writer already ran");
    assert.equal(hasCreditBackfillReceipt(after, c.taskId), true);
    assert.deepEqual(singlePathCreditedIds(after), [c.taskId], "receipt bookkeeping cannot alter credit-path semantics");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append failure persists no receipt, and a completed multi-candidate pass writes the store once", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    let writesAfterFailure = 0;
    await assert.rejects(
      runCreditBackfill([candidate("W1-T-APPEND-FAIL", 4104)], {
        ledgerPath,
        runId: "append-fails",
        readLedger: () => [],
        readCreditStore: () => ({}),
        appendLine: () => {
          throw new Error("simulated append failure");
        },
        writeCreditStore: () => {
          writesAfterFailure++;
        },
      }),
      /simulated append failure/,
    );
    assert.equal(writesAfterFailure, 0, "an unwritten correction must never receive a receipt");

    let appends = 0;
    const writes: CreditStore[] = [];
    const candidates = [candidate("W1-T-BATCH-A", 4105), candidate("W1-T-BATCH-B", 4106)];
    const summary = await runCreditBackfill(candidates, {
      ledgerPath,
      runId: "batch",
      readLedger: () => [],
      readCreditStore: () => ({}),
      appendLine: () => {
        appends++;
      },
      writeCreditStore: (store) => {
        writes.push(store);
      },
    });
    assert.equal(summary.corrected, 2);
    assert.equal(appends, 2);
    assert.equal(writes.length, 1, "all successful appends are persisted by one store write per pass");
    assert.equal(hasCreditBackfillReceipt(writes[0], candidates[0].taskId), true);
    assert.equal(hasCreditBackfillReceipt(writes[0], candidates[1].taskId), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run writes neither surface and still reports durable suppressions", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    const c = candidate("W1-T-DRY", 4107);
    const store: CreditStore = {
      [c.taskId]: {
        backfillReceipt: { source: "sweep.credit_backfill", prUrl: c.prUrl, prNumber: c.prNumber },
      },
    };
    let appends = 0;
    let writes = 0;
    const summary = await runCreditBackfill([c], {
      ledgerPath,
      runId: "dry",
      dryRun: true,
      readLedger: () => [],
      readCreditStore: () => store,
      appendLine: () => {
        appends++;
      },
      writeCreditStore: () => {
        writes++;
      },
    });
    assert.equal(summary.corrected, 0);
    assert.equal(summary.durableReceiptSuppressions, 1);
    assert.equal(appends, 0);
    assert.equal(writes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falsifier: removing the durable lookup re-credits the same correction after bounded-scan loss", async () => {
  const { dir, ledgerPath } = tempState();
  try {
    const c = candidate("W1-T-LOOKUP-FALSIFIER", 4108);
    const durable: CreditStore = {
      [c.taskId]: {
        backfillReceipt: { source: "sweep.credit_backfill", prUrl: c.prUrl, prNumber: c.prNumber },
      },
    };
    saveCreditStore(defaultCreditStorePath(ledgerPath), durable);
    exhaustBoundedScan(dir, [ledgerRow(c.taskId, c.prNumber)]);

    const withLookup = await runCreditBackfill([c], { ledgerPath, runId: "with-lookup" });
    assert.equal(withLookup.corrected, 0);

    const withoutLookup = await runCreditBackfill([c], {
      ledgerPath,
      runId: "lookup-removed",
      readCreditStore: () => ({}),
      writeCreditStore: () => {},
    });
    assert.equal(
      withoutLookup.corrected,
      1,
      "FALSIFIER: without the receipt lookup, the unchanged production bounded scan repeats the correction",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
