import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECISION_RELEVANT_LEDGER_STEPS, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";

function rotated(step: string): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t12047-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const core = JSON.stringify({ step, run_id: "R", pr_url: "u" }) + "\n";
    const bytes = Buffer.byteLength(core);
    writeFileSync(ledgerPath, core + JSON.stringify({ step: "ci.polling", padding: "x".repeat(bytes * 4) }) + "\n");
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: bytes * 2 }).rotated, true);
    return readLedgerLines(ledgerPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T12047 criterion 1: a review.claim_repeated row survives a rotation", () => {
  assert.ok(rotated("review.claim_repeated").some(row => row.step === "review.claim_repeated"));
});

test("W1-T12047 criterion 2: no other step is newly kept", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("review.claim_repeated"));
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("review.claim_repeated_other"), false);
  assert.equal(rotated("review.claim_repeated_other").some(row => row.step === "review.claim_repeated_other"), false);
});
