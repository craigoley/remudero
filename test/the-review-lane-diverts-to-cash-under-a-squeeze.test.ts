/**
 * REVIEW-CASH-DIVERT (successor to W1-T3726) — THE REVIEW LANE MUST SURVIVE AN EXHAUSTED SUBSCRIPTION.
 *
 * MEASURED on the live fleet 2026-09-17, with the claude weekly allowance at 100% used:
 *
 *   {"event":"worker.provider.cash_fallback_refused",
 *    "refusal":"this spawn's tool surface is not implementable by cash (Read, Grep, Glob, Bash)"}
 *   remudero-review=failure posted to 7d1a71f — ... (reviewer_outcome: spawn_error; ...)
 *
 * `remudero-review` is a REQUIRED check on this repo's main branch, so a review lane that cannot
 * spawn is not one degraded rung among several — it is every PR on the board held unmergeable for
 * the whole squeeze window, no matter which other lane repaired them.
 *
 * The lane needed no new capability, only a row in the table that already answers this question
 * for its identical siblings: the reviewer's Claude surface IS `SPECIALIST_TOOLS`, byte-for-byte
 * what `recon` and `diagnose` declare, and those two have carried an `openweight` row since
 * W1-T3726.
 *
 * WHAT EACH TEST BELOW WOULD CATCH, stated as the failure it reddens on:
 *   1. the table row going missing, or its cash surface regaining a shell (the exact refusal above);
 *   2. `SPECIALIST_TOOLS` drifting away from the claude row this table now duplicates — the
 *      duplication exists because specialist-panel.ts imports worker.ts, so worker.ts importing it
 *      back would close a cycle, and a copy nothing compares is a copy that silently rots;
 *   3. the cash surface naming a tool the cash adapter cannot actually run, which would convert a
 *      clean capacity block into an opaque crash at spawn time;
 *   4. the harness — not the diverted worker — still owning git for this surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISPATCH_LANE_TOOL_BOUNDS,
  cashDivertToolsForLane,
  cashDivertSpawnFields,
  harnessOwnsGitFor,
} from "../src/lib/worker.js";
import { cashCanServeToolSurface } from "../src/lib/worker.js";
import { SPECIALIST_TOOLS, isReadOnlyToolset } from "../src/lib/specialist-panel.js";

test("review-cash-divert: the review lane declares a cash surface, and it carries no shell", () => {
  const tools = cashDivertToolsForLane("review");
  assert.notEqual(tools, undefined, "review must be divertable — an undefined row IS the outage");
  assert.deepEqual([...tools!], ["Read", "Grep", "Glob", "RunCheck"]);
  assert.equal(tools!.includes("Bash"), false, "a shell is the one thing cash refuses");
});

test("review-cash-divert: the review lane's cash surface is identical to recon's and diagnose's", () => {
  // Not decoration: the argument for diverting review AT ALL is that its Claude surface is the
  // same as theirs, so its cash surface must be too. If someone widens one and not the others,
  // that argument has quietly stopped holding.
  const review = cashDivertToolsForLane("review");
  assert.deepEqual([...review!], [...cashDivertToolsForLane("recon")!]);
  assert.deepEqual([...review!], [...cashDivertToolsForLane("diagnose")!]);
});

test("review-cash-divert: the table's claude row for review still equals SPECIALIST_TOOLS", () => {
  // THE ANTI-ROT ASSERTION. worker.ts cannot import specialist-panel.ts (that module imports
  // worker.ts, so the edge would close a cycle), so the claude row is a hand copy. This test is
  // the only thing keeping the copy honest — delete it and the table can describe a surface the
  // reviewer no longer spawns with, while every other test here still passes.
  assert.deepEqual([...DISPATCH_LANE_TOOL_BOUNDS.review.claude], [...SPECIALIST_TOOLS]);
});

test("review-cash-divert: cashDivertSpawnFields('review') yields a spread-able cashTools field", () => {
  // The call site spreads this unconditionally (run-task.ts, the reviewer spawn). An empty object
  // there would be a SILENT no-op — the spawn would look wired and still refuse under a squeeze.
  const fields = cashDivertSpawnFields("review");
  assert.notEqual(fields.cashTools, undefined, "an empty object here is the outage, spelled differently");
  assert.deepEqual([...fields.cashTools!], ["Read", "Grep", "Glob", "RunCheck"]);
});

test("review-cash-divert: diverting review grants no write authority and no forge verbs", () => {
  // The reviewer is read-only BY CONSTRUCTION on Claude; the divert must not quietly buy it more.
  const tools = [...cashDivertToolsForLane("review")!];
  assert.equal(isReadOnlyToolset(tools), true, "a reviewer that can write is not a reviewer");
  for (const forbidden of ["Write", "Edit", "Bash", "Task", "WebFetch", "WebSearch"]) {
    assert.equal(tools.includes(forbidden), false, `review's cash surface must not carry ${forbidden}`);
  }
});

test("review-cash-divert: the harness owns git for review's cash surface — and the lane never needed it to", () => {
  // `harnessOwnsGitFor` reads true for any shell-less bound. For review that is a statement about
  // nothing: this lane commits no work, so unlike implement/fix there is no output contract to
  // re-word and no `harnessCommitForShellLessWorker` call to make. Pinned so a later reader does
  // not go looking for the commit half of this change and conclude it was forgotten.
  assert.equal(harnessOwnsGitFor(cashDivertToolsForLane("review")), true);
  assert.equal(harnessOwnsGitFor(DISPATCH_LANE_TOOL_BOUNDS.review.claude), false);
});

test("review-cash-divert: THE REAL PREDICATE — the cash adapter can serve review's surface, and refuses today's", () => {
  // THIS IS THE ONE THAT MATTERS. Every assertion above reads the table; the auction reads
  // `cashCanServeToolSurface`, which asks `OPENWEIGHT_FUNCTIONS` whether each tool is actually
  // implemented. A table row naming a tool the adapter cannot run would turn a clean capacity
  // block into an opaque crash at spawn time — so the divert is only real if this passes.
  assert.equal(cashCanServeToolSurface(cashDivertToolsForLane("review")), true);

  // THE NEGATIVE CONTROL, and the measured outage restated as an assertion: the surface the
  // reviewer spawns with on Claude is exactly the one the live fleet's refusal named, and it
  // must still be refused — this change adds an alternative, it does not weaken the boundary.
  assert.equal(cashCanServeToolSurface(DISPATCH_LANE_TOOL_BOUNDS.review.claude), false);

  // And an unbounded spawn stays ineligible: absent bound means the unrestricted surface, which
  // carries Bash. Never "probably fine".
  assert.equal(cashCanServeToolSurface(undefined), false);
});
