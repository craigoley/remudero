import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus, projectPlan, type DeriveDeps } from "../src/lib/status.js";
import { FIXED_NOW_ISO, corpusLedgerPath, loadCorpusGithub, loadCorpusPlan } from "./fixtures/w1-t187/load.js";

/**
 * W1-T187 acceptance criterion 4 — "deriveStatus still works standalone, with no pre-read
 * lines supplied". Proof required: "unit test: deriveStatus called directly for ONE task, with
 * no injected readLedger, returns the same projection as before."
 *
 * FALSIFIER this guards: a fix that makes pre-read lines mandatory breaks every per-task
 * caller OUTSIDE projectPlan (board.ts's lastActivityByTask scan aside, real per-task callers
 * exist in run-task.ts/panel-graph.ts/task-card.ts) and turns a contained performance fix into
 * a ripple through the codebase. The W1-T187 fix lives ENTIRELY inside projectPlan (status.ts)
 * -- deriveStatus's own signature and body are untouched -- so this is a regression guard, not
 * new behavior: deriveStatus(task, deps) with a bare `deps` (no `readLedger` field at all)
 * must keep resolving via the DEFAULT readLedgerLines exactly as it did before this task.
 */

test("W1-T187 criterion 4: deriveStatus called directly for ONE task, with no injected readLedger, still resolves via the default readLedgerLines", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const task = plan.tasks[0]; // bucket 0 in the corpus generator: merged via ledger pr.opened
  // Deliberately NO `readLedger` field on this deps object -- exercises `deps.readLedger ??
  // readLedgerLines` inside deriveStatus itself, the exact standalone path the criterion names.
  const deps: DeriveDeps = { ledgerPath: corpusLedgerPath(), github, now: () => Date.parse(FIXED_NOW_ISO) };

  const projection = deriveStatus(task, deps);

  assert.equal(projection.taskId, task.id);
  assert.equal(projection.source, "ledger");
  assert.equal(projection.merged, true);
  assert.equal(projection.status, "merged");
});

test("W1-T187 criterion 4: standalone deriveStatus (no injected readLedger) is IDENTICAL to the same task's projection inside a hoisted projectPlan pass, for one task per corpus bucket", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const deps: DeriveDeps = { ledgerPath: corpusLedgerPath(), github, now: () => Date.parse(FIXED_NOW_ISO) };

  // The corpus generator cycles tasks through 6 derivation buckets (merged / running-open-PR /
  // blocked-closed-PR / queued-no-evidence / in-flight-ledger-only / orphaned-stale-dispatch),
  // i % 6 === bucket. One representative per bucket is enough to prove the projectPlan-level
  // hoist changed NOTHING about deriveStatus's own standalone contract, across every branch of
  // its precedence ladder -- not just the "happy path" merged case above.
  const hoisted = projectPlan(plan, deps);
  for (let bucket = 0; bucket < 6; bucket++) {
    const task = plan.tasks[bucket];
    assert.ok(task, `corpus must carry a task at index ${bucket}`);
    const standalone = deriveStatus(task, deps); // no readLedger override -- the default path
    assert.deepEqual(
      standalone,
      hoisted.get(task.id),
      `bucket ${bucket} task ${task.id}: standalone deriveStatus diverged from the hoisted projectPlan result`,
    );
  }
});
