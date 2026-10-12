import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  missingTaskTrailerRepairDecision,
  runSweep,
  type MissingTaskTrailerRepair,
  type OpenPrView,
} from "./helpers/sweep-test.js";

function subject(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9367,
    prUrl: "https://github.com/craigoley/remudero/pull/9367",
    headSha: "b3e176d",
    headRefName: "run-unfiled-1791220000000",
    body: "Implementation report.\n",
    taskExistsOnMain: false,
    introducedTaskIds: [],
    reviewState: "failure",
    criteriaRecoverable: false,
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
    autoMergeArmed: false,
    ...overrides,
  };
}

test("W1-T6102: flow-escalated-review-failing clears without a person", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const edits: MissingTaskTrailerRepair[] = [];
  const pr = subject();
  const deps = {
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-flow-review-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T6102",
    readLedger: () => rows,
    appendLine: (_path: string, row: Record<string, unknown>) => { rows.push(row); },
    arm: () => { assert.fail("repair must await the authoritative review"); },
    close: () => { assert.fail("repair must not close the PR"); },
    dispatchFix: () => { assert.fail("body repair must not dispatch a code worker"); },
    escalate: () => { assert.fail("the derived trailer repair needs no person"); },
    repairMissingTaskTrailer: (_pr: OpenPrView, repair: MissingTaskTrailerRepair) => {
      edits.push(repair);
    },
  };
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].trailer, "Remudero-Task: unfiled");
  assert.match(edits[0].repairedBody, /Remudero-Task: unfiled\n$/);
  assert.equal(edits[0].refireEvent, "pull_request.edited");
  assert.equal(edits[0].rerunFailedJobs, false);
  assert.equal(rows.find(row => row.step === "sweep.missing_task_trailer_repaired")?.trailer,
    "Remudero-Task: unfiled");
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(edits.length, 1, "an unchanged head must not repeat the body write");
  assert.equal(missingTaskTrailerRepairDecision(subject({ body: edits[0].repairedBody })).action,
    "ignore");
});

test("W1-T6102: unfiled repair retains self-credit and unreadable-diff refusals", () => {
  for (const overrides of [
    { introducedTaskIds: undefined },
    { introducedTaskIds: ["unfiled"] },
    { headRefName: "run-W1-T6102-1791220000000", taskExistsOnMain: false },
    { headRefName: "operator/repair" },
  ]) {
    assert.equal(missingTaskTrailerRepairDecision(subject(overrides)).action, "stand-down");
  }
  assert.equal(missingTaskTrailerRepairDecision(subject({ body: "Acceptance:\n- existing claim | unit test: existing proof\n" })).action,
    "ignore");
});
