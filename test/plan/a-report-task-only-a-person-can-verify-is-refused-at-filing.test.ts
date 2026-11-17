/**
 * W1-T13439 — A REPORT ONLY A PERSON CAN VERIFY IS REFUSED AT FILING.
 *
 * 2026-11-17: W1-T13352 (docs/forensics/pooled-test-exit-latches.md) was filed verify: human with three
 * `demonstration:` proofs. #19122 went green, remudero-review posted success CAPPED (0/3 proofs executed), auto-merge
 * never armed, and the operator merged it by hand. The plan linter now refuses that shape on a NEW shard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Task } from "#src/lib/plan.js";
import { humanOnlyReportViolations, lintTask } from "#src/lib/task-linter.js";

const NEW = { riskTransition: { baseTask: undefined } } as const;
const REPORT = "docs/forensics/pooled-test-exit-latches.md";

function task(overrides: Partial<Task> & Record<string, unknown> = {}): Task {
  return {
    id: "W1-T9999",
    title: "write the pooled-test report",
    repo: "remudero",
    type: "recon",
    verify: "human",
    files: [REPORT, "docs/docs-index.json"],
    acceptance: [
      { claim: "the report names the writer", proof: "demonstration: the operator reads the report and sees the writer" },
      { claim: "the report recommends a task", proof: "demonstration: the operator reads the report and sees one task" },
    ],
    rationale: "a measured finding",
    ...overrides,
  } as unknown as Task;
}

test("W1-T13439 criterion 1: a new verify: human docs-only shard with only demonstration: proofs is refused with the runnable form", () => {
  const found = humanOnlyReportViolations(task(), NEW);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.check, "human-only-report");
  assert.equal(found[0]!.severity, "block");
  assert.match(found[0]!.message, /CAPPED/);
  assert.match(found[0]!.message, /auto-merge never arms/);
  assert.ok(found[0]!.message.includes(`grep: ^## Recommendation$ in ${REPORT}`), found[0]!.message);
  assert.ok(
    lintTask(task(), NEW).violations.some((v) => v.check === "human-only-report"),
    "lintTask reaches the check",
  );
});

test("W1-T13439 criterion 2: a NO-AUTO-VERIFY: line with a reason keeps the human gate", () => {
  assert.deepEqual(humanOnlyReportViolations(task({ rationale: "a finding\nNO-AUTO-VERIFY: the operator asked to read it first" }), NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task({ note: "  NO-AUTO-VERIFY: legal sign-off" }), NEW), []);
  assert.equal(humanOnlyReportViolations(task({ rationale: "NO-AUTO-VERIFY:" }), NEW).length, 1, "a bare marker gives no reason");
});

test("W1-T13439 criterion 3: a runnable proof, a non-docs file, verify: auto, or an existing shard draws no new violation", () => {
  const runnable = task({
    acceptance: [
      { claim: "the report names the writer", proof: "demonstration: the operator reads the report" },
      { claim: "the report exists", proof: `grep: ^# Pooled in ${REPORT}` },
    ],
  });
  assert.deepEqual(humanOnlyReportViolations(runnable, NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task({ files: [REPORT, "src/lib/sweep.ts"] }), NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task({ verify: "auto" }), NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task({ files: [] }), NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task({ acceptance: [] }), NEW), []);
  assert.deepEqual(humanOnlyReportViolations(task(), { riskTransition: { baseTask: task() } }), [], "an existing shard is backlog");
  assert.deepEqual(humanOnlyReportViolations(task(), {}), [], "no base to compare against reads as not new");
  const amended = { postMergeAmendment: { baseTask: undefined }, baseAcceptance: [] } as unknown as Parameters<typeof humanOnlyReportViolations>[1];
  assert.equal(humanOnlyReportViolations(task(), amended).length, 1, "a shard new against the merge base is new");
});
