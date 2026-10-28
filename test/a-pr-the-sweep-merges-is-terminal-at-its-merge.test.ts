// A PR the sweep merges directly is ledgered terminal at the merge, not when a later tick reads it closed.
// #12292 (W1-T9541's scope amendment) merged 11:24:43Z on 2026-10-16 and got its `pr.terminal` row 11:34:09Z;
// #12289's fix round read "fix already dispatched for this head" until then.
import assert from "node:assert/strict";
import { test } from "node:test";
import { logArmAttribution } from "#src/lib/arm-auto-merge.js";
import { PR_TERMINAL_STEP } from "#src/lib/ledger-carry.js";
import { fixRungStalledWithoutNewHead } from "#src/lib/sweep.js";

const TASK = "W1-T9802";
const IMPL_HEAD = "b".repeat(40);
const amendmentUrl = "https://github.com/craigoley/remudero/pull/12292";

function armRows(outcome: Parameters<typeof logArmAttribution>[1]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  logArmAttribution((step, extra) => rows.push({ step, ...extra }), outcome, amendmentUrl, undefined, "sweep");
  return rows;
}

/** Fix round 1 on #12289 ended NEEDS_SCOPE and opened amendment #12292 — the rows core wrote on 2026-10-16. */
const awaitingAmendment: Array<Record<string, unknown>> = [
  { step: "fix.dispatch", task_id: TASK, mode: "ci-log", head_sha: IMPL_HEAD, round_id: "r1" },
  { step: "fix.scope_amendment", task_id: TASK, kind: "scope_amendment", pr_number: 12289, amendment_number: 12292, amendment_url: amendmentUrl },
  { step: "fix.scope_amendment", task_id: TASK, outcome: "created", amendmentNumber: 12292, pr_number: 12289, head_sha: IMPL_HEAD },
  { step: "fix.done", task_id: TASK, subtype: "scope_amendment_pending", worker_exit: "unobserved", head_sha: IMPL_HEAD },
];

test("W1-T9802: a direct merge by the sweep writes the merged pr.terminal row at the merge", () => {
  const terminal = armRows("direct-merged").filter((row) => row.step === PR_TERMINAL_STEP);
  assert.equal(terminal.length, 1, JSON.stringify(terminal));
  assert.equal(terminal[0]!.state, "merged");
  assert.equal(terminal[0]!.pr_number, 12292);
  assert.equal(terminal[0]!.pr_url, amendmentUrl);
  assert.equal(typeof terminal[0]!.merged_at, "string");
});

test("W1-T9802: an arm that has not merged writes no pr.terminal row", () => {
  for (const outcome of ["armed", "direct-merge-failed", "arm-error-ignored"] as const) {
    assert.equal(armRows(outcome).some((row) => row.step === PR_TERMINAL_STEP), false, outcome);
  }
});

test("W1-T9802: a fix round awaiting a scope amendment the sweep merged is released at the merge", () => {
  assert.equal(fixRungStalledWithoutNewHead(awaitingAmendment, TASK), false, "an open amendment holds the round");
  const merged = [...awaitingAmendment, ...armRows("direct-merged")];
  assert.equal(fixRungStalledWithoutNewHead(merged, TASK), true, "the merge itself releases the round");
});
