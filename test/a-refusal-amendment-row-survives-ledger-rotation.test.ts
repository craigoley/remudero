import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import { REFUSAL_AMENDMENT_STEP, noPrVerdictRowsFromLedger } from "../src/lib/refusal-amendment.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5675. A drafted refusal amendment settles a no_pr verdict; rotation must keep that row.
const TASK = "W1-T9998";

function rotated(): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refusal-amend-rotation-`));
  try {
    const path = join(dir, "ledger.ndjson");
    const noCeiling = { ceilingBytes: Number.MAX_SAFE_INTEGER };
    appendLedger(path, { run_id: "R1", task_id: TASK, step: "verdict", verdict: "no_pr", report_excerpt: "refused: criterion 1" } as LedgerLine, noCeiling);
    appendLedger(path, { run_id: "SWEEP-1", task_id: TASK, step: REFUSAL_AMENDMENT_STEP, source_run_id: "R1", outcome: "drafted" } as LedgerLine, noCeiling);
    const ceiling = statSync(path).size * 4;
    const noise = JSON.stringify({ step: "ci.polling", run_id: "n", task_id: "W1-NOISE", detail: "x".repeat(64) });
    for (let n = 0; n < Math.ceil(ceiling / (noise.length + 1)) + 50; n++) appendFileSync(path, noise + "\n");
    assert.equal(rotateLedger(path, { ceilingBytes: ceiling }).rotated, true);
    return readLedgerLines(path) as Record<string, unknown>[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("after rotateLedger, a no_pr verdict whose amendment was drafted is not re-offered by noPrVerdictRowsFromLedger", () => {
  const after = rotated();
  assert.ok(after.some((l) => l.step === REFUSAL_AMENDMENT_STEP && l.task_id === TASK), "amendment row retained");
  const offered = noPrVerdictRowsFromLedger(after as never, Date.now());
  assert.ok(!(offered as unknown as Array<{ task_id?: string }>).some((r) => r.task_id === TASK), "settled refusal not re-offered");
});
