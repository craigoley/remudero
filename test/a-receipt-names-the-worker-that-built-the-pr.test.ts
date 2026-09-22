/**
 * A RECEIPT MUST NAME WHAT ACTUALLY BUILT THE PULL REQUEST, NOT ONLY WHAT WAS ASKED FOR.
 *
 * `rmd receipt <pr>` is the one place a merged pull request can be traced back to the run that
 * produced it. Before this, its `implement` section carried `model`/`effort`/`num_turns`/
 * `cost_usd` — and `model` is the REQUEST, not the fact. The same `sonnet` request is served by a
 * subscription or diverted to the cash adapter depending on auction headroom, and those two runs
 * differ in cost, in failure mode, and in how far you would trust the diff.
 *
 * MEASURED ON THE FLEET, 2026-09-22, over the live ledger plus all 422 archives — 83,665
 * `implement.done` rows, every one already carrying the fields this test pins:
 *
 *     provider   cash 39,330 · claude 35,167 · codex 8,604
 *     verdict    cash: openweight_error 22,356 (57%) vs success 16,974
 *                claude: success 32,883 (94%)
 *                codex:  success 8,601 (99.9%)
 *
 * That 57% cash error rate went unnoticed for three days across ~22,000 runs. The data was in the
 * ledger the whole time; no per-PR surface could reach it, because the receipt — the thing built
 * to answer "what produced this PR" — did not carry the provider or the run's own verdict.
 *
 * WHY `verdict` AND `reviewer_outcome` ARE BOTH NEEDED: they judge different things. The reviewer
 * judges the DIFF; the verdict judges the RUN. A receipt with only the former cannot tell "the
 * worker failed" from "the worker succeeded and its work was rejected" — opposite repairs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReceipt } from "../src/lib/receipt.js";

const TASK_ID = "W1-T4100";
const PR_URL = "https://github.com/craigoley/remudero/pull/1";
const RUN_ID = "RUN-W1-T4100";

function ledgerWith(implementDone: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [
    { run_id: RUN_ID, task_id: TASK_ID, step: "run.start" },
    { run_id: RUN_ID, task_id: TASK_ID, step: "pr.opened", pr_url: PR_URL, branch: `run-${TASK_ID}-1` },
  ];
  if (implementDone) rows.splice(1, 0, { run_id: RUN_ID, task_id: TASK_ID, step: "implement.done", ...implementDone });
  return rows;
}

test("a receipt names the PROVIDER that billed the run, not just the model requested", () => {
  const r = buildReceipt(ledgerWith({ provider: "cash", model: "sonnet", verdict: "success", session_id: "s1" }), {
    taskId: TASK_ID,
    prUrl: PR_URL,
  });
  assert.deepEqual(r.predicate.implement.provider, { value: "cash" });
  // The model is UNCHANGED and still the requested one — this adds a fact, it does not replace one.
  assert.deepEqual(r.predicate.implement.model, { value: "sonnet" });
});

test("a receipt carries the RUN's own verdict, which the reviewer's outcome cannot substitute for", () => {
  // The exact shape that hid on the fleet for three days: a run that FAILED on the cash adapter.
  const r = buildReceipt(ledgerWith({ provider: "cash", model: "gpt-5-nano", verdict: "openweight_error", session_id: "s2" }), {
    taskId: TASK_ID,
    prUrl: PR_URL,
  });
  assert.deepEqual(r.predicate.implement.verdict, { value: "openweight_error" });
  assert.deepEqual(r.predicate.implement.provider, { value: "cash" });
});

test("a receipt carries the session id — the join key back to the worker instance", () => {
  const r = buildReceipt(ledgerWith({ provider: "claude", model: "sonnet", verdict: "success", session_id: "sess-abc" }), {
    taskId: TASK_ID,
    prUrl: PR_URL,
  });
  assert.deepEqual(r.predicate.implement.session_id, { value: "sess-abc" });
});

test("a run predating provider routing is ABSENT WITH A REASON, never defaulted to claude", () => {
  // THE SAFETY PROPERTY. Defaulting an unknown provider to the subscription would attribute every
  // diverted run to a lane that never ran it — and would do so silently, in the one artifact built
  // to be trusted about provenance. "Every field with no ledger source prints null with a named
  // reason, never a fabricated value" is this command's own contract.
  const r = buildReceipt(ledgerWith({ model: "sonnet", num_turns: 3 }), { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(r.predicate.implement.provider.value, null);
  assert.match((r.predicate.implement.provider as { reason: string }).reason, /implement\.done/);
  assert.equal(r.predicate.implement.verdict.value, null);
  assert.equal(r.predicate.implement.session_id.value, null);
  // ...while the fields that WERE recorded still resolve, so one absence never blanks the section.
  assert.deepEqual(r.predicate.implement.model, { value: "sonnet" });
});

test("no implement.done at all leaves every implement field absent with a reason", () => {
  const r = buildReceipt(ledgerWith(undefined), { taskId: TASK_ID, prUrl: PR_URL });
  for (const field of ["provider", "model", "effort", "num_turns", "cost_usd", "verdict", "session_id"] as const) {
    assert.equal(r.predicate.implement[field].value, null, `${field} must be null`);
    assert.match((r.predicate.implement[field] as { reason: string }).reason, /no "implement\.done"/);
  }
});
