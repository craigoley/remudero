import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, ledgerExceedsRotationCeiling, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import { MAIN_RUN_GAP_STEP, mainRunGapHistoryFromLedger } from "../src/lib/main-run-gaps.js";
import { REFUSAL_AMENDMENT_STEP, noPrVerdictRowsFromLedger } from "../src/lib/refusal-amendment.js";
import { SRE_GOVERNOR_STEP, governorTiersFromLedger } from "../src/lib/sre-governor.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  CI_GATE_REAGGREGATE_STEP,
  CODEQL_BLOCKER_DISPATCH_STEP,
  MISSING_TASK_TRAILER_REPAIR_STEP,
  PLAN_REPAIR_DISPATCH_STEP,
  PLAN_REPAIR_STEP,
  codeqlBlockerDedupeKey,
  planRepairHistoryFromLedger,
  priorPlanRepairStrikesFromLedger,
  reaggregatedCiGateKeysFromLedger,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5958. W1-T5935's census (test/a-spent-check-requeue-survives-ledger-rotation.test.ts) found
// seven steps a `*FromLedger` fold reads back that DECISION_RELEVANT_LEDGER_STEPS did not retain,
// and W1-T5951 found an eighth read inline by the CodeQL dedupe. Each fold is a dedupe or a bound:
// once rotation archives its row, the fold answers "never happened" and the act repeats. This file
// drives ONE real rotation over a ledger holding a row of each and checks every row, and every
// exported fold over it, comes through unchanged.

const HEAD = "b".repeat(40);
const TASK = "W1-T9999";
const PR = 9002;

type Row = Record<string, unknown>;
type Fold = (lines: Row[]) => unknown;

/** One row per read-back step, shaped exactly as its fold keys on, plus that fold (where exported). */
const READ_BACK: ReadonlyArray<{ step: string; row: Row; fold?: Fold }> = [
  {
    step: MAIN_RUN_GAP_STEP,
    row: { commit: "c".repeat(40), head: HEAD, workflows: ["acr-build.yml"], failed: [] },
    fold: (lines) => mainRunGapHistoryFromLedger(lines),
  },
  {
    step: REFUSAL_AMENDMENT_STEP,
    row: { task_id: TASK, source_run_id: "RUN-NOPR-1", outcome: "drafted" },
    // Settled while the amendment row is live; rotated away, the same refusal is re-offered.
    fold: (lines) => noPrVerdictRowsFromLedger(lines, Date.now()),
  },
  {
    step: SRE_GOVERNOR_STEP,
    row: { runbook: "restart-serve", from: "live", to: "stopped", reason: "flapping", global: false },
    fold: (lines) => governorTiersFromLedger(lines),
  },
  {
    step: CI_GATE_REAGGREGATE_STEP,
    row: { pr_number: PR, head_sha: HEAD, sibling_name: "lint", sibling_started_at: "2026-10-06T00:00:00Z" },
    fold: (lines) => reaggregatedCiGateKeysFromLedger(lines),
  },
  {
    step: PLAN_REPAIR_STEP,
    row: { pr_number: PR, head_sha: HEAD, signature: "title", action: "retitle", cause: "stale-base" },
    fold: (lines) => planRepairHistoryFromLedger(lines),
  },
  {
    step: PLAN_REPAIR_DISPATCH_STEP,
    row: { task_id: TASK, pr_number: PR, head_sha: HEAD },
    fold: (lines) => priorPlanRepairStrikesFromLedger({ taskId: TASK }, lines),
  },
  // sweep.ts's priorActionsFromLedger and codeqlBlockerDispatched are module-private; their rows
  // carry the exact key fields they read.
  { step: MISSING_TASK_TRAILER_REPAIR_STEP, row: { pr_number: PR, head_sha: HEAD, task_id: TASK } },
  {
    step: CODEQL_BLOCKER_DISPATCH_STEP,
    row: { pr_number: PR, head_sha: HEAD, dedupe_key: codeqlBlockerDedupeKey({ prNumber: PR, headSha: HEAD }, { alertNumber: 7 }) },
  },
];

function noiseRow(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** A ledger with one row of every read-back step (and the `no_pr` verdict the amendment settles),
 *  padded with noise past four times its size, then really rotated. Returns the rows read before
 *  and after the rotation. */
function rotatedReadBackRows(retainedSteps?: ReadonlySet<string>): { before: Row[]; after: Row[] } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fold-read-rotation-`));
  try {
    const path = join(dir, "ledger.ndjson");
    const noCeiling = { ceilingBytes: Number.MAX_SAFE_INTEGER };
    const base = { run_id: "SWEEP-1" };
    const verdict = { task_id: TASK, run_id: "RUN-NOPR-1", step: "verdict", verdict: "no_pr", report_excerpt: "refused: criterion 1" };
    appendLedger(path, { ...base, ...verdict } as LedgerLine, noCeiling);
    for (const { step, row } of READ_BACK) appendLedger(path, { ...base, task_id: TASK, ...row, step } as LedgerLine, noCeiling);
    const ceiling = statSync(path).size * 4;
    const padding = Math.ceil(ceiling / (noiseRow(0).length + 1)) + 50;
    for (let n = 0; n < padding; n++) appendFileSync(path, noiseRow(n) + "\n");
    assert.ok(ledgerExceedsRotationCeiling(path, ceiling), "setup: padded past the ceiling");
    const before = readLedgerLines(path);
    assert.equal(rotateLedger(path, { ceilingBytes: ceiling, ...(retainedSteps ? { retainedSteps } : {}) }).rotated, true);
    const after = readLedgerLines(path);
    assert.ok(after.filter((l) => l.step === "ci.polling").length < 50, "the rotation really archived the noise");
    return { before, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const { step, row, fold } of READ_BACK) {
  test(`W1-T5958: a ${step} row survives a real ledger rotation and its fold answers the same`, () => {
    const { before, after } = rotatedReadBackRows();
    const live = after.filter((l) => l.step === step);
    assert.equal(live.length, 1, `${step} is still live after rotation — add it to DECISION_RELEVANT_LEDGER_STEPS`);
    for (const [k, v] of Object.entries(row)) assert.deepEqual(live[0]![k], v, `${step}.${k} survives intact`);
    if (fold) assert.deepEqual(fold(after), fold(before), `the fold over ${step} answers identically after rotation`);
  });
}

test("W1-T5958: the guard can see a dropped read-back row — rotation without the registration loses it", () => {
  // POSITIVE CONTROL: the same rotation with sweep.ci_gate_reaggregated taken out of the retained
  // set archives its row, and the once-per-head key the fold bounds the recompute by is gone.
  const without = new Set([...DECISION_RELEVANT_LEDGER_STEPS].filter((s) => s !== CI_GATE_REAGGREGATE_STEP));
  const { before, after } = rotatedReadBackRows(without);
  assert.equal(reaggregatedCiGateKeysFromLedger(before).size, 1, "sanity: the key is bounded before rotation");
  assert.equal(after.some((l) => l.step === CI_GATE_REAGGREGATE_STEP), false);
  assert.equal(reaggregatedCiGateKeysFromLedger(after).size, 0);
});

test("W1-T5958: the shrink-only unretained fold-read allowlist is empty and names none of the eight", () => {
  const census = readFileSync(fileURLToPath(new URL("./a-spent-check-requeue-survives-ledger-rotation.test.ts", import.meta.url)), "utf8");
  const block = /const KNOWN_UNRETAINED_FOLD_READS[^=]*=\s*new Set(?:<string>)?\(([^)]*)\)/.exec(census);
  assert.ok(block, "sanity: the allowlist declaration is still where W1-T5935 put it");
  const entries = [...block[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(entries.filter((s) => READ_BACK.some((r) => r.step === s)), [], "a registered step left on the allowlist");
  assert.deepEqual(entries, [], "every read-back step is retained — the allowlist holds nothing");
  for (const { step } of READ_BACK) assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), `${step} is registered`);
});
