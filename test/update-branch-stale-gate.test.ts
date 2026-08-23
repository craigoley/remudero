import assert from "node:assert/strict";
import { test } from "node:test";
import { redPrWithStaleGate, selectUpdateBranchTarget, type OpenPrView } from "../src/lib/sweep.js";

// ── W1-T1212: a red PR runs a FROZEN copy of the very gate that blocks it ──────────────────────
//
// `pull_request` evaluates `refs/pull/<n>/merge`, whose base parent is pinned at this PR's last
// `synchronize` — so a gate fixed on main (the #2477 shape) never reaches a PR sitting on an
// older merge ref, and `armedButStalled` can never reach this population at all: a red PR is
// never armed, so it never enters that predicate's own `autoMergeArmed === true` gate. See
// `redPrWithStaleGate`'s own doc (lib/sweep.ts) for the full design this locks.

const NOW = Date.parse("2026-08-22T12:00:00Z");
const RECENT = "2026-08-21T12:00:00Z";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ciFailures: [{ name: "ci-gate", logTail: "clock-sweep: FAILURE" }],
    ...over,
  };
}

// ── acceptance 1: a red unarmed PR whose failing workflow moved on main is selected ───────────

test("a red unarmed PR whose failing workflow moved on main is selected for an update", () => {
  const target = pr({ prNumber: 2434, headSha: "533d8d84" });
  const staleGateWorkflowsByPr = new Map([[2434, ["ci-gate"]]]);

  const found = redPrWithStaleGate([target], staleGateWorkflowsByPr);
  assert.deepEqual(found, [
    { prNumber: 2434, prUrl: "https://github.com/o/r/pull/1", taskId: "W1-TX", headSha: "533d8d84", staleWorkflow: "ci-gate" },
  ]);

  // Wired through the same public selector `armedButStalled`'s own action half uses.
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), staleGateWorkflowsByPr)?.prNumber, 2434);
});

// ── acceptance 2: a red PR whose failing workflow is identical to main's is not selected ──────

test("a red PR whose failing workflow is identical to main's is not selected", () => {
  const target = pr({ prNumber: 2435 });
  // The caller (run-task.ts) read both blob shas, found them equal, and so never populated an
  // entry for this PR at all — the same "quiet is free" contract `armedButStalled` already keeps.
  const staleGateWorkflowsByPr = new Map<number, readonly string[]>();

  assert.deepEqual(redPrWithStaleGate([target], staleGateWorkflowsByPr), []);
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), staleGateWorkflowsByPr), undefined);
});

// ── acceptance 3: a conflicted PR is never selected however stale its gate copy is ────────────

test("a conflicted PR is never selected however stale its gate copy is", () => {
  const dirty = pr({ prNumber: 2436, mergeState: "dirty" });
  const unmergeable = pr({ prNumber: 2437, mergeable: false });
  const staleGateWorkflowsByPr = new Map([
    [2436, ["ci-gate"]],
    [2437, ["ci-gate"]],
  ]);

  assert.deepEqual(redPrWithStaleGate([dirty, unmergeable], staleGateWorkflowsByPr), []);
  assert.equal(selectUpdateBranchTarget([dirty], NOW, new Set(), staleGateWorkflowsByPr), undefined);
  assert.equal(selectUpdateBranchTarget([unmergeable], NOW, new Set(), staleGateWorkflowsByPr), undefined);
});

// ── acceptance 4: being behind main with no failing workflow selects nothing ──────────────────

test("being behind main with no failing workflow selects nothing", () => {
  // Checks are GREEN (nothing failing at all) — merely `behind` and unarmed selects nothing on
  // EITHER axis: not `armedButStalled` (never armed) and not `redPrWithStaleGate` (not red).
  const behindButGreen = pr({ prNumber: 2438, checksState: "green", mergeState: "behind", ciFailures: [] });

  assert.deepEqual(redPrWithStaleGate([behindButGreen], new Map([[2438, ["ci-gate"]]])), []);
  assert.equal(selectUpdateBranchTarget([behindButGreen], NOW, new Set(), new Map([[2438, ["ci-gate"]]])), undefined);

  // And a genuinely red PR with no stale-gate fact for it (the caller found nothing stale)
  // selects nothing either — behind-ness alone is never the trigger (rationale (4)).
  const redNoStale = pr({ prNumber: 2439, mergeState: "behind" });
  assert.deepEqual(redPrWithStaleGate([redNoStale], new Map()), []);
  assert.equal(selectUpdateBranchTarget([redNoStale], NOW, new Set(), new Map()), undefined);
});

// ── acceptance 5: the same PR is not selected a second time for the same workflow ─────────────

test("the same PR is not selected a second time for the same workflow", () => {
  const target = pr({ prNumber: 2440 });
  const staleGateWorkflowsByPr = new Map([[2440, ["ci-gate"]]]);
  const updatedForWorkflow = new Set(["2440:ci-gate"]);

  assert.deepEqual(redPrWithStaleGate([target], staleGateWorkflowsByPr, updatedForWorkflow), []);
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), staleGateWorkflowsByPr, updatedForWorkflow), undefined);

  // A DIFFERENT stale name on the SAME PR is still fresh and still fires — only the exact
  // pr+workflow pair already spent is remembered, never the whole PR.
  const twoNames = pr({ prNumber: 2441, ciFailures: [{ name: "ci-gate", logTail: "x" }] });
  const staleTwo = new Map([[2441, ["ci-gate", "other-check"]]]);
  const alreadySpent = new Set(["2441:ci-gate"]);
  const stillFresh = redPrWithStaleGate([twoNames], staleTwo, alreadySpent);
  assert.equal(stillFresh.length, 1);
  assert.equal(stillFresh[0].staleWorkflow, "other-check");
});

// ── acceptance 6: a draft and an in-flight head stay vetoed on the widened set ─────────────────

test("a draft and an in-flight head stay vetoed on the widened set", () => {
  const draft = pr({ prNumber: 2442, isDraft: true, lastActivityAt: "2026-08-01T00:00:00Z" });
  const notDraft = pr({ prNumber: 2443, lastActivityAt: "2026-08-15T00:00:00Z" });
  const staleGateWorkflowsByPr = new Map([
    [2442, ["ci-gate"]],
    [2443, ["ci-gate"]],
  ]);

  // The draft is OLDER (would win on age alone) but the operator's hold vetoes it outright —
  // `redPrWithStaleGate` itself does not re-check this (design note v); `selectUpdateBranchTarget`
  // does, exactly once, over the union.
  assert.equal(selectUpdateBranchTarget([draft, notDraft], NOW, new Set(), staleGateWorkflowsByPr)?.prNumber, 2443);
  assert.equal(selectUpdateBranchTarget([draft], NOW, new Set(), staleGateWorkflowsByPr), undefined);

  const inFlight = pr({
    prNumber: 2444,
    headRefName: "run-W1-T900-1786845000000",
    lastActivityAt: "2026-08-01T00:00:00Z",
  });
  const settled = pr({ prNumber: 2445, lastActivityAt: "2026-08-15T00:00:00Z" });
  const inFlightTaskIds = new Set(["W1-T900"]);
  const staleGateTwo = new Map([
    [2444, ["ci-gate"]],
    [2445, ["ci-gate"]],
  ]);

  assert.equal(
    selectUpdateBranchTarget([inFlight, settled], NOW, inFlightTaskIds, staleGateTwo)?.prNumber,
    2445,
    "a live worker is still pushing to this exact head — skipped, not raced",
  );
  assert.equal(selectUpdateBranchTarget([inFlight], NOW, inFlightTaskIds, staleGateTwo), undefined);
});
