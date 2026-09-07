/**
 * W1-T3019 — THE CREDIT BACKFILL ACTS ON AN ABSENCE ITS OWN READER SAYS IT DID NOT PROVE.
 *
 * `readMergeCreditedTaskIds` walks the live ledger plus up to `CREDIT_SCAN_MAX_ROTATIONS`
 * rotations, stopping early once every candidate resolves. When it runs out with candidates still
 * unresolved it returns `complete: false`, and its own doc says of those: "those get re-credited,
 * which is today's behaviour". `runCreditBackfill` destructured `.credited` and threw `complete`
 * away, so a correction written on a PROVEN absence and one written on an UNFINISHED WALK were
 * indistinguishable in the ledger.
 *
 * MEASURED ON THE LIVE CORPUS 2026-09-07, which is why this is worth a row rather than a comment:
 *   distinct task ids ever carrying merge credit : 1,227
 *   MAX_RETAINED_LINES_PER_STEP (live file cap)  :   200  <- measured: exactly 200 live credit rows
 *     => tasks whose credit is ONLY in rotations : 1,027, re-walked on every pass
 *   walk at the full candidate set               : filesRead 25, complete FALSE, 2 unresolved
 *   ...whose credit DOES exist deeper            : 2 of 2 (found at filesRead 277)
 * So the cap is adequate for 1,225 of 1,227 — widening it is NOT the fix — and exactly two tasks
 * are re-credited every pass on an absence that is false.
 *
 * TELEMETRY ONLY. Nothing here changes which corrections are written; the last two tests assert
 * that, because "no behaviour change" is the load-bearing half of this claim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_SCAN_MAX_ROTATIONS, readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runCreditBackfill } from "../src/lib/sweep.js";

const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: "2026-09-07T00:00:00.000Z", ...o });
const credit = (taskId: string) => row({ task_id: taskId, step: "verdict.merged", verdict: "merged" });
const candidate = (taskId: string) => ({ taskId, prNumber: 7, prUrl: "https://github.com/o/r/pull/7", merged: true });

/** A state dir. `rotations` are UNCOMPRESSED dated files, the shape ledgerRotationEntries accepts. */
function corpus(opts: { live?: string[]; rotations?: Record<string, string[]> }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3019-`));
  writeFileSync(join(dir, "ledger.ndjson"), (opts.live ?? []).join("\n") + (opts.live?.length ? "\n" : ""));
  for (const [name, lines] of Object.entries(opts.rotations ?? {})) writeFileSync(join(dir, name), lines.join("\n") + "\n");
  return dir;
}

/** More rotations than the cap, none of them carrying the candidate's credit — so the walk runs
 *  out of budget rather than out of corpus, which is the production shape. */
function overCapRotations(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < CREDIT_SCAN_MAX_ROTATIONS + 4; i++) {
    const stamp = `2026-09-0${1 + (i % 7)}T${String(i).padStart(2, "0")}-00-00-000Z`;
    out[`ledger.${stamp}.ndjson`] = [row({ task_id: `FILLER-${i}`, step: "run.start" })];
  }
  return out;
}

// ── the completed walk: a not-found IS a proven absence ──────────────────────────────────────

test("W1-T3019: a NEW merge exhausts the corpus, not the budget — complete is false but the absence is PROVEN", async () => {
  // The trap this task nearly shipped: `complete` is false here, yet crediting is exactly right.
  const dir = corpus({ live: [row({ task_id: "W1-T1", step: "run.start" })] });
  const s = await runCreditBackfill([candidate("W1-T1")], { ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-1" });
  assert.equal(s.creditScanComplete, false, "an unresolved candidate always reads incomplete — which is why it is the WRONG discriminator");
  assert.equal(s.creditScanExhaustedBudget, false, "…but the walk ran out of CORPUS, so the absence is proven");
  assert.equal(s.creditScanUnknown, 0, "and nothing is counted as unproven");
  assert.equal(s.corrected, 1, "the correction is right: this task really is uncredited");
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T3019: a credit found in a rotation still suppresses the correction, and the walk is complete", async () => {
  const dir = corpus({
    live: [row({ task_id: "W1-T1", step: "run.start" })],
    rotations: { "ledger.2026-09-06T00-00-00-000Z.ndjson": [credit("W1-T1")] },
  });
  const s = await runCreditBackfill([candidate("W1-T1")], { ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-1" });
  assert.equal(s.corrected, 0, "the pre-existing idempotence is untouched");
  assert.equal(s.creditScanComplete, true);
  assert.equal(s.creditScanUnknown, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── the exhausted walk: a not-found is UNKNOWN, and the row says so ──────────────────────────

test("W1-T3019: a walk that hits the rotation cap reports complete=false and COUNTS the unproven absences", async () => {
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations: overCapRotations() });
  const ledgerPath = join(dir, "ledger.ndjson");
  const s = await runCreditBackfill([candidate("W1-T404"), candidate("W1-T405")], { ledgerPath, runId: "SWEEP-1" });

  assert.equal(s.creditScanComplete, false, "the corpus is deeper than the cap, so the walk gave up");
  assert.equal(s.creditScanFilesRead, CREDIT_SCAN_MAX_ROTATIONS + 1, "live + the cap in rotations");
  assert.equal(s.creditScanUnknown, 2, "BOTH corrections were written on an absence the walk never proved");
  assert.equal(s.corrected, 2, "and they are still written — this task changes measurement, not behaviour");
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T3019: each correction row carries credit_scan_complete, so a re-credit loop names itself", async () => {
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations: overCapRotations() });
  const ledgerPath = join(dir, "ledger.ndjson");
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runCreditBackfill([candidate("W1-T404")], { ledgerPath, runId: "SWEEP-1", log: (step, extra) => rows.push({ step, extra }) });
  const corrections = rows.filter((l) => l.step === "sweep.credit_backfill");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].extra?.credit_scan_exhausted_budget, true, "the diagnostic that separates repair from churn");
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T3019: the summary row publishes all three figures", async () => {
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations: overCapRotations() });
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runCreditBackfill([candidate("W1-T404")], {
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "SWEEP-1",
    log: (step, extra) => logs.push({ step, extra }),
  });
  const sum = logs.find((l) => l.step === "sweep.credit_backfill.summary");
  assert.ok(sum, "the summary still fires on every pass");
  assert.equal(sum.extra?.credit_scan_complete, false);
  assert.equal(sum.extra?.credit_scan_exhausted_budget, true);
  assert.equal(sum.extra?.credit_scan_unknown, 1);
  assert.equal(sum.extra?.credit_scan_files_read, CREDIT_SCAN_MAX_ROTATIONS + 1);
  assert.equal(sum.extra?.total, 1, "and the pre-existing fields are unchanged");
  assert.equal(sum.extra?.corrected, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── THE BOUNDARY. A first pass at this file did not pin it, and an off-by-one in the budget test
// (`>= cap` instead of `>= cap + 1`) survived every other assertion here. A corpus that ends ONE
// rotation short of the cap is the only shape that separates them.

test("W1-T3019: a corpus that stops one rotation SHORT of the cap has exhausted the corpus, not the budget", async () => {
  const rotations: Record<string, string[]> = {};
  for (let i = 0; i < CREDIT_SCAN_MAX_ROTATIONS - 1; i++) {
    rotations[`ledger.2026-09-0${1 + (i % 7)}T${String(i).padStart(2, "0")}-00-00-000Z.ndjson`] = [row({ task_id: `FILLER-${i}`, step: "run.start" })];
  }
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations });
  const s = await runCreditBackfill([candidate("W1-T404")], { ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-1" });
  assert.equal(s.creditScanFilesRead, CREDIT_SCAN_MAX_ROTATIONS, "live + (cap - 1) rotations — every file there is");
  assert.equal(s.creditScanExhaustedBudget, false, "it read everything and found nothing: a PROVEN absence, not an unknown");
  assert.equal(s.creditScanUnknown, 0, "an off-by-one here would report this proven absence as churn");
  rmSync(dir, { recursive: true, force: true });
});

// ── NO BEHAVIOUR CHANGE — the load-bearing half ──────────────────────────────────────────────

test("W1-T3019: dryRun still writes nothing, and still reports what it would have done", async () => {
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations: overCapRotations() });
  const ledgerPath = join(dir, "ledger.ndjson");
  const s = await runCreditBackfill([candidate("W1-T404")], { ledgerPath, runId: "SWEEP-1", dryRun: true });
  assert.equal(s.corrected, 0, "dryRun leaves no trace");
  assert.equal(readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.credit_backfill").length, 0);
  assert.equal(s.creditScanExhaustedBudget, true, "…but the scan is still MEASURED, so --dry-run can diagnose the loop");
  assert.equal(s.creditScanUnknown, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T3019: an unmerged candidate is still a no-op regardless of what the scan reported", async () => {
  const dir = corpus({ live: [row({ task_id: "SEED", step: "run.start" })], rotations: overCapRotations() });
  const ledgerPath = join(dir, "ledger.ndjson");
  const s = await runCreditBackfill([{ ...candidate("W1-T404"), merged: false }], { ledgerPath, runId: "SWEEP-1" });
  assert.equal(s.corrected, 0, "merged:false is the first gate and this task does not touch it");
  assert.equal(s.creditScanUnknown, 1, "the candidate is still counted as unproven — measurement is not gated on merge state");
  rmSync(dir, { recursive: true, force: true });
});
