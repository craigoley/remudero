/**
 * TRIAGE-CASH-DIVERT (W1-T3749) — TRIAGE WAS ONE TOOL FROM SURVIVING A SQUEEZE.
 *
 * MEASURED (`cashCanServeToolSurface` over every declared spawn surface in the tree, live
 * squeeze 2026-09-17): offering `TRIAGE_WORKER_TOOLS` verbatim to a blocked-auction divert
 * REFUSES — `WebSearch` is the only entry the check-runner does not implement, and it is the
 * only lane's own list carrying it among today's dispatch lanes with an open-weight row. Dropping
 * WebSearch alone flips the answer to DIVERTABLE.
 *
 * THE DECISION (run-task.ts, beside `TRIAGE_WORKER_TOOLS`): keep WebSearch on the Claude surface
 * — `LEARNINGS.md` already treats it as an Architect-tier privilege, and `triagePrompt`'s own
 * STEP 2 (lib/triage.ts) already conditions research on "a genuine platform-facts gap",
 * instructing the worker to "skip this step entirely" otherwise. Drop WebSearch only from the
 * surface a squeeze diverts to (`TRIAGE_CASH_TOOLS`), never from `OPENWEIGHT_FUNCTIONS` itself —
 * triage reads untrusted inbound feedback text, the same exposure W1-T210 bounded the fix rung
 * against.
 *
 * WHAT EACH TEST BELOW WOULD CATCH, stated as the failure it reddens on:
 *   1. `TRIAGE_WORKER_TOOLS` losing WebSearch outright (the Architect-tier research grant vanishing);
 *   2. the REAL PREDICATE flipping back — `cashCanServeToolSurface` refusing `TRIAGE_WORKER_TOOLS`
 *      is the bug this task exists to hold visible, not to silently fix by widening the adapter;
 *   3. `TRIAGE_CASH_TOOLS` regaining WebSearch, or losing any OTHER entry `TRIAGE_WORKER_TOOLS`
 *      carries — the divert must degrade by exactly one capability, never more, never a different one;
 *   4. the cash surface naming a tool the cash adapter cannot actually run, converting a clean
 *      capacity block into an opaque crash at spawn time (the same failure mode this task's
 *      squeeze-day measurement observed for the whole lane).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cashCanServeToolSurface } from "../src/lib/worker.js";
import { TRIAGE_CASH_TOOLS, TRIAGE_WORKER_TOOLS } from "../src/run-task.js";

test("triage-cash-divert: the Claude surface keeps WebSearch — the Architect-tier research grant", () => {
  assert.ok(TRIAGE_WORKER_TOOLS.includes("WebSearch"), "triage's own STEP 2 (lib/triage.ts) instructs it to research");
});

test("triage-cash-divert: THE REAL PREDICATE — the cash adapter refuses TRIAGE_WORKER_TOOLS as-is", () => {
  // This is the bug the task names: WebSearch is the one entry the check-runner does not
  // implement, so offering the Claude surface unmodified to a blocked-auction divert refuses the
  // whole lane for that one entry.
  assert.equal(cashCanServeToolSurface(TRIAGE_WORKER_TOOLS), false);
});

test("triage-cash-divert: the cash adapter accepts TRIAGE_CASH_TOOLS — the divert this task fixes", () => {
  assert.equal(cashCanServeToolSurface(TRIAGE_CASH_TOOLS), true);
});

test("triage-cash-divert: TRIAGE_CASH_TOOLS drops WebSearch and nothing else", () => {
  assert.equal(TRIAGE_CASH_TOOLS.includes("WebSearch"), false);
  const everyOtherEntry = TRIAGE_WORKER_TOOLS.filter((tool) => tool !== "WebSearch");
  assert.deepEqual([...TRIAGE_CASH_TOOLS], everyOtherEntry, "the divert must degrade by exactly one capability");
});
