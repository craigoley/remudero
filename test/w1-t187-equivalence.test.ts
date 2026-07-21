import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus, projectPlan, type DeriveDeps } from "../src/lib/status.js";
import {
  CORPUS_MIN_LEDGER_LINES,
  CORPUS_MIN_TASKS,
  FIXED_NOW_ISO,
  corpusLedgerPath,
  loadCorpusGithub,
  loadCorpusLedgerLines,
  loadCorpusPlan,
} from "./fixtures/w1-t187/load.js";

/**
 * W1-T187 acceptance criterion 1 — "the hoisted read is DERIVATION-EQUIVALENT — every task's
 * verdict is byte-identical to the per-task path over the FULL real corpus".
 *
 * This is a CORRECTNESS test, not a perf assertion (that is criterion 3, in
 * w1-t187-benchmark.test.ts). It runs the SAME plan/ledger/github fixture through TWO
 * independent code paths and asserts every task's {@link StatusProjection} compares IDENTICAL
 * (assert.deepEqual, data not spot-checked):
 *
 *   (1) projectPlan(plan, deps)              -- the HOISTED path (status.ts's fix): reads +
 *       parses the ledger ONCE, hands the SAME parsed array to every deriveStatus call.
 *   (2) a manual per-task loop calling deriveStatus(task, deps) directly, deps carrying NO
 *       readLedger override -- so each call falls through to the DEFAULT readLedgerLines and
 *       re-reads + re-parses ledger.ndjson fresh from disk, exactly the PRE-FIX per-task
 *       behavior this task's rationale measured at 5,229ms warm / 8,207ms cold.
 *
 * The FALSIFIER this guards: a hoist that shares mutable parsed state across derivations, or
 * that reads the ledger at a different instant than a per-task read would, could silently
 * change a verdict for one task while every timing number improves. Both paths below run
 * against the SAME fixed `now` clock (FIXED_NOW_ISO) precisely so "different instant" cannot
 * even arise as a confound -- the only variable under test is "read once vs. read per task".
 */

test("W1-T187 criterion 1: the production-scale corpus fixture meets its own stated scale (>= 200 tasks, >= 18,000 ledger lines)", () => {
  const plan = loadCorpusPlan();
  const lines = loadCorpusLedgerLines();
  assert.ok(
    plan.tasks.length >= CORPUS_MIN_TASKS,
    `corpus must carry >= ${CORPUS_MIN_TASKS} tasks, has ${plan.tasks.length}`,
  );
  assert.ok(
    lines.length >= CORPUS_MIN_LEDGER_LINES,
    `corpus ledger must carry >= ${CORPUS_MIN_LEDGER_LINES} lines, has ${lines.length}`,
  );
});

test("W1-T187 criterion 1: projectPlan's hoisted read is DERIVATION-EQUIVALENT to the per-task path, for EVERY task in the production-scale corpus (byte-identical, compared as data)", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const now = () => Date.parse(FIXED_NOW_ISO);
  const deps: DeriveDeps = { ledgerPath: corpusLedgerPath(), github, now };

  // (1) THE HOISTED PATH -- projectPlan reads the ledger once and shares it across all 220+ tasks.
  const hoisted = projectPlan(plan, deps);

  // (2) THE PER-TASK PATH -- deriveStatus called directly per task, `deps` carrying no
  // `readLedger` override, so EVERY call independently re-reads + re-parses ledger.ndjson from
  // disk via the default readLedgerLines. This is deliberately NOT projectPlan -- it is the
  // exact shape projectPlan had BEFORE this task's fix (status.ts:754-755 in the rationale).
  const perTask = new Map(plan.tasks.map((t) => [t.id, deriveStatus(t, deps)]));

  assert.equal(hoisted.size, plan.tasks.length);
  assert.equal(perTask.size, plan.tasks.length);

  const mismatches: string[] = [];
  for (const task of plan.tasks) {
    const a = hoisted.get(task.id);
    const b = perTask.get(task.id);
    try {
      assert.deepEqual(a, b);
    } catch {
      mismatches.push(`${task.id}: hoisted=${JSON.stringify(a)} perTask=${JSON.stringify(b)}`);
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length}/${plan.tasks.length} task projections diverged between the hoisted and per-task paths:\n${mismatches.slice(0, 5).join("\n")}`,
  );
});
