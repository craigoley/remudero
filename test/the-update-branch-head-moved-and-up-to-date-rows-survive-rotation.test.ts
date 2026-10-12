import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendLedger,
  DECISION_RELEVANT_LEDGER_STEPS,
  ledgerExceedsRotationCeiling,
  rotateLedger,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { reviewOrphansFor } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T5949: W1-T5933 taught the sweep's update-branch call two new outcomes, `head-moved` (the
 * expected_head_sha lease no longer matched) and `up-to-date` (nothing to merge), each written as a
 * `sweep.update_branch.<outcome>` row beside `.conflict` and `.error`. Those siblings are retained
 * through rotation and read as evidence in run-task.ts's `sweepUpdatedHeadsForTask`; the two new
 * rows were neither, so a rotation could drop the only record of why a refresh stood down.
 */

const NEW_STEPS = ["sweep.update_branch.head-moved", "sweep.update_branch.up-to-date"] as const;
const SIBLINGS = ["sweep.update_branch.conflict", "sweep.update_branch.error"] as const;
const CONTROL_STEP = "sweep.update_branch.unregistered_control_step";

function srcText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Every `UpdateBranchOutcome` literal sweep.ts declares — the population its rows are named from. */
function updateBranchOutcomes(): string[] {
  const m = /export type UpdateBranchOutcome\s*=\s*([^;]+);/.exec(srcText("../src/lib/sweep.ts"));
  assert.ok(m, "sanity: sweep.ts still declares UpdateBranchOutcome");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** The step literals `sweepUpdatedHeadsForTask` compares a row against before it reads it. */
function stepsReadBySweepUpdatedHeads(): Set<string> {
  const src = srcText("../src/run-task.ts");
  const start = src.indexOf("function sweepUpdatedHeadsForTask(");
  assert.ok(start >= 0, "sanity: run-task.ts still defines sweepUpdatedHeadsForTask");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  return new Set([...body.matchAll(/\.step\s*!==\s*"([^"]+)"/g)].map((x) => x[1]));
}

test("W1-T5949: head-moved and up-to-date rows survive a rotation that drops an unregistered control step", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5949-rotation-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-UPDATE-BRANCH-OUTCOMES";
    const unbounded = { ceilingBytes: Number.MAX_SAFE_INTEGER };
    for (const step of [...NEW_STEPS, ...SIBLINGS, CONTROL_STEP]) {
      appendLedger(ledgerPath, { run_id: "r0", task_id: taskId, step, pr_number: 7, head_sha: "a".repeat(40) } as LedgerLine, unbounded);
    }
    for (let n = 0; n < 250; n++) {
      const noise = { step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) };
      writeFileSync(ledgerPath, JSON.stringify(noise) + "\n", { flag: "a" });
    }
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "setup sanity: padded past the ceiling");
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: ceiling }).rotated, true);

    const survivors = new Set(readLedgerLines(ledgerPath).filter((l) => l.task_id === taskId).map((l) => l.step as string));
    for (const step of [...NEW_STEPS, ...SIBLINGS]) {
      assert.ok(survivors.has(step), `${step} must survive rotation like its conflict/error siblings`);
    }
    assert.ok(
      !survivors.has(CONTROL_STEP),
      "FALSIFIER: an unregistered step of identical shape is evicted by the same rotation — registration is what keeps the rows",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5949: every update-branch outcome sweep.ts can write is decision-relevant", () => {
  const outcomes = updateBranchOutcomes();
  for (const o of ["updated", "conflict", "error", "head-moved", "up-to-date"]) {
    assert.ok(outcomes.includes(o), `sanity: UpdateBranchOutcome still names ${o}`);
  }
  const missing = outcomes.map((o) => `sweep.update_branch.${o}`).filter((s) => !DECISION_RELEVANT_LEDGER_STEPS.has(s));
  assert.deepEqual(missing, [], "every sweep.update_branch.<outcome> row is retained through rotation");
});

test("W1-T5949: sweepUpdatedHeadsForTask reads head-moved and up-to-date rows where it reads conflict and error", () => {
  const read = stepsReadBySweepUpdatedHeads();
  for (const step of SIBLINGS) assert.ok(read.has(step), `sanity: the sibling ${step} is still read as evidence`);
  for (const step of NEW_STEPS) assert.ok(read.has(step), `${step} must be read as evidence beside conflict/error`);
  const missing = updateBranchOutcomes().map((o) => `sweep.update_branch.${o}`).filter((s) => !read.has(s));
  assert.deepEqual(missing, [], "every update-branch outcome is read as evidence");
});

test("W1-T5949: a head-moved or up-to-date row, like a conflict, suppresses no orphan — no new head was minted", () => {
  // (W1-T5713 note: even .updated no longer hides the orphan; it only stays out of the count.)
  const PRIOR = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  const CURRENT = "cafe1234cafe1234cafe1234cafe1234cafe1234";
  for (const step of [...NEW_STEPS, ...SIBLINGS]) {
    const facts = reviewOrphansFor(
      [
        { step: "review.posted", task_id: "W1-A", head_sha: PRIOR },
        { step: "sweep.update_branch.attempted", task_id: "W1-A", head_sha: PRIOR },
        { step, task_id: "W1-A", head_sha: PRIOR },
      ],
      "W1-A",
      CURRENT,
    );
    assert.equal(facts.orphanedByPush, true, `${step}: the prior review is still orphaned`);
    assert.equal(facts.priorOrphans, 1, `${step}: a stood-down update minted no replacement head`);
  }
  const updated = reviewOrphansFor(
    [
      { step: "review.posted", task_id: "W1-A", head_sha: PRIOR },
      { step: "sweep.update_branch.updated", task_id: "W1-A", head_sha: PRIOR },
    ],
    "W1-A",
    CURRENT,
  );
  // W1-T5713: a successful update still supersedes the head, so the orphan stays visible to review
  // reuse — but it joins neither the count nor the clock. Only .updated differs from the siblings.
  assert.equal(updated.orphanedByPush, true, "control: .updated leaves the superseded head visible as an orphan");
  assert.equal(updated.priorOrphans, 0, "control: only .updated is excluded from the foreign-push count");
});
