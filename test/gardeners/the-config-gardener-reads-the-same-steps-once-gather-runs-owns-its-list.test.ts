import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_GARDEN_LEDGER_STEPS } from "#src/lib/config-gardener.js";
import { GATHER_RUNS_LEDGER_STEPS } from "#src/lib/retro.js";

// The steps `gatherRuns` reads moved out of CONFIG_GARDEN_LEDGER_STEPS into GATHER_RUNS_LEDGER_STEPS (retro.ts),
// beside the function that reads them, so a second reader (`rmd procedures`) spreads the same list. The config
// gardener must read EXACTLY the step set it read before the move: this is that list, copied from it verbatim.
const CONFIG_GARDEN_STEPS_BEFORE_THE_MOVE = [
  // gatherRuns, by name.
  "run.start", "verdict", "verdict.merged", "recon.done", "implement.done", "implement.resumed", "implement.continued", "implement.preopen_continued", "pr.opened", "correction.provenance",
  // gatherRuns' pr_url fallback.
  "report.followups", "pr.head_provider", "dispatch.blocked_independent", "automerge.armed", "automerge.arm_skipped",
  "automerge.arm_failed", "automerge.clean_status_direct_merge", "review.posted", "review.pending_posted",
  "review.semantic_setup_refused", "review.semantic_incomplete", "review.replay_input",
  "review.unwired_advisory", "review.post_refused", "review.stood_down", "acceptance.repaired", "trailer_stamp.failed",
  // capDerivation: the knowledge-budget pressure, and the cache-hit mix's call rows.
  "learnings.injected", "review.reviewer", "inbox.draft_synthesized", "triage.synthesized", "retro.synthesized",
  "retro.preflight_repair", "fix.done", "fix.contract_hold", "fix.commit_line_answered", "census_push.strike", "plan.synthesized", "diagnose.worker_done",
  // W1-T5668: the rest that can be a worker run's first pr_url row.
  "acceptance.repair.unrepresentable", "changeset_claim.repaired", "retro.pr.recovered", "pr.body_normalize.error",
];

test("the config gardener reads the same step set after GATHER_RUNS_LEDGER_STEPS moved to retro.ts", () => {
  assert.deepEqual(new Set(CONFIG_GARDEN_LEDGER_STEPS), new Set(CONFIG_GARDEN_STEPS_BEFORE_THE_MOVE));
  assert.equal(CONFIG_GARDEN_LEDGER_STEPS.length, new Set(CONFIG_GARDEN_LEDGER_STEPS).size, "no step is listed twice");
});

test("GATHER_RUNS_LEDGER_STEPS is the gatherRuns groups the config gardener's list now spreads", () => {
  assert.deepEqual(GATHER_RUNS_LEDGER_STEPS, CONFIG_GARDEN_STEPS_BEFORE_THE_MOVE.slice(0, 27));
  assert.deepEqual(CONFIG_GARDEN_LEDGER_STEPS.slice(0, GATHER_RUNS_LEDGER_STEPS.length), GATHER_RUNS_LEDGER_STEPS);
});
