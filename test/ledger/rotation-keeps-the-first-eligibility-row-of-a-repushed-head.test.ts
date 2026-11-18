import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";

function rotate(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t12756-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const full = body + JSON.stringify({ step: "ci.polling", padding: "x".repeat(64) }) + "\n";
    writeFileSync(ledgerPath, full);
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: Buffer.byteLength(full) - 1 }).rotated, true);
    return readLedgerLines(ledgerPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function eligible(n: number, pr: number, head: string, i: number): Record<string, unknown> {
  return { ts: new Date(Date.UTC(2026, 10, 14, 0, 0, i)).toISOString(), run_id: "R", step: "sweep.review_eligible", pr_number: pr, head_sha: head, n };
}

function fixture(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  rows.push(eligible(0, 7, "newh", 0), eligible(1, 8, "other", 1));
  for (let i = 2; i < 260; i++) rows.push(eligible(i, 9, `h${i}`, i));
  rows.push({ ts: "2026-11-14T01:00:00.000Z", run_id: "R", step: "sweep.absent_repush", pr_number: 7, old_head: "o", new_head: "newh", reason: "r" });
  return rows;
}

test("W1-T12756 criterion 1: rotation keeps the first eligibility row of a repushed head", () => {
  const out = rotate(fixture()).filter((r) => r.step === "sweep.review_eligible");
  assert.ok(out.some((r) => r.pr_number === 7 && r.head_sha === "newh" && r.n === 0));
});

test("W1-T12756 criterion 2: cap unchanged for other heads and extras bounded by kept repush rows", () => {
  const out = rotate(fixture()).filter((r) => r.step === "sweep.review_eligible");
  assert.equal(out.some((r) => r.pr_number === 8 && r.head_sha === "other"), false);
  assert.equal(out.length, 200 + 1);
});
