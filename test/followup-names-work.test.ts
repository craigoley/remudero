// test/followup-names-work.test.ts — W1-T2613.
//
// THE DEFECT THIS CLOSES, MEASURED (this task's own recon, 2026-09-01): `routeFollowupsToRegistry`
// (src/lib/retro.ts) had exactly two refusal arms — "title-dedup" and "type-not-plan-shaped" —
// and neither declined an entry whose whole content is "task X is ready, hand it off". Over the
// live 317-proposal registry, 2 such entries were routed as ratifiable operator decisions: one for
// W1-T2457, which the ordinary drain had already merged as #3272 (ratifying it could only
// re-dispatch merged work); one for W1-T2482, still `status: queued` (ratifying it could only
// duplicate a task already in the plan).
//
// This file proves, in order (matching the task's own acceptance criteria):
//   (1) a bare dispatch ask naming an already-filed task is declined, and the outcome names the
//       arm ("dispatch-only") that declined it;
//   (2) the W1-T2470 control — an entry that mentions a task id AND names real work (a
//       re-verification ask) — is still routed, so the arm is not a blanket decline of every
//       task-typed entry that happens to mention its own id;
//   (3) the decline happens at routing, before any proposal is minted: the declined entry never
//       reaches the registry, and the registry writer is never even called when nothing else in
//       the harvest is routable;
//   (4) the arm's own declined outcome states which live entries it wrongly declines, rather than
//       claiming none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mineFollowups, routeFollowupsToRegistry, type LedgerRecord } from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

/** A minimal `report.followups` ledger row — the shape `harvestFollowupsFromReport` (run-task.ts)
 *  actually appends, reduced to what `mineFollowups` reads. */
function followupRow(opts: {
  runId: string;
  ts: string;
  taskId: string;
  entries: Array<{ type: string; text: string }>;
}): LedgerRecord {
  return {
    run_id: opts.runId,
    ts: opts.ts,
    task_id: opts.taskId,
    step: "report.followups",
    entries: opts.entries,
  };
}

/** Board-review-wiring.test.ts's own `updateRegistry` fake shape (test/board-review.test.ts) —
 *  an in-memory registry, never touching disk, mirroring `updateProposalRegistry`'s real
 *  read-current/apply-update/return-next-or-null contract. */
function fakeRegistry() {
  let state: Proposal[] = [];
  let calls = 0;
  return {
    calls: () => calls,
    state: () => state,
    updateRegistry: (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
      calls += 1;
      const next = update(state);
      if (next !== null) state = next;
      return next;
    },
  };
}

// The two fixtures this task's own rationale quotes verbatim (W1-T2457's proposal summary,
// W1-T2482 paraphrased) plus the W1-T2470 control the rationale names as "the falsifier for
// anyone later proposing" a blanket task-typed decline.

const DISPATCH_ONLY_W1_T2457 =
  "This recon confirms W1-T2457 is ready to implement (task file complete, clean worktree, " +
  "no blockers) — hand off to the implement worker.";

const DISPATCH_ONLY_W1_T2482 =
  "Implement W1-T2482 per its acceptance criteria — task file complete, no blockers, ready to " +
  "implement.";

// The control MUST mention its own task id (same shape as the two entries above) and carry a
// dispatch-marker phrase too, so this actually exercises the NAMES_REAL_WORK override rather than
// merely never matching DISPATCH_ONLY_MARKERS in the first place.
const NAMES_REAL_WORK_W1_T2470 =
  "Re-run W1-T2470's own falsifier check now that the underlying data changed — the task must " +
  "be closed rather than built if that's confirmed, otherwise it stays ready to implement.";

const RECORDS: LedgerRecord[] = [
  followupRow({
    runId: "run-2457",
    ts: "2026-08-29T16:00:00Z",
    taskId: "W1-T2457",
    entries: [{ type: "task", text: DISPATCH_ONLY_W1_T2457 }],
  }),
  followupRow({
    runId: "run-2482",
    ts: "2026-08-30T09:00:00Z",
    taskId: "W1-T2482",
    entries: [{ type: "task", text: DISPATCH_ONLY_W1_T2482 }],
  }),
  followupRow({
    runId: "run-2470",
    ts: "2026-08-31T12:00:00Z",
    taskId: "W1-T2470",
    entries: [{ type: "task", text: NAMES_REAL_WORK_W1_T2470 }],
  }),
];

function harvest() {
  return mineFollowups(RECORDS, []);
}

test("sanity: the fixture mints all three as unharvested candidates (none dedupes, none is 'action')", () => {
  const h = harvest();
  assert.equal(h.candidates.length, 3);
  assert.equal(h.deduped.length, 0);
});

// ── acceptance 1: a bare dispatch ask naming an already-filed task is declined, arm is named ────

test("a dispatch-only entry naming its own already-filed task is declined under the 'dispatch-only' arm", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  for (const taskId of ["W1-T2457", "W1-T2482"]) {
    const declined = outcomes.find((o) => o.candidate.taskId === taskId);
    assert.ok(declined, `${taskId}'s entry must appear in the outcomes, not silently dropped`);
    assert.ok(!declined!.routed, `${taskId}'s dispatch-only entry must not be routed`);
    if (!declined!.routed) {
      assert.equal(declined!.arm, "dispatch-only");
      assert.match(declined!.reason, new RegExp(taskId), "the reason names the referent it declined");
    }
    assert.ok(
      !reg.state().some((p) => p.summary.includes(taskId)),
      `${taskId} must never reach the registry as a minted proposal`,
    );
  }
});

// ── acceptance 2: the W1-T2470 control — mentions a task id AND names real work — stays routed ──

test("an entry that mentions its own task id AND names real work (the W1-T2470 re-verification control) is still routed", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  const outcome = outcomes.find((o) => o.candidate.taskId === "W1-T2470");
  assert.ok(outcome);
  assert.ok(outcome!.routed, "the control must NOT be declined by the new arm — it names real work");
  if (outcome!.routed) {
    assert.ok(
      reg.state().some((p) => p.id === outcome!.proposalId),
      "the control's proposal must actually be present in the registry the writer produced",
    );
  }
});

// ── acceptance 3: the decline happens AT ROUTING, before any proposal is minted ─────────────────

test("a dispatch-only decline happens before minting: the declined entry never reaches the registry, and nothing else routable means the writer is never called", () => {
  const dispatchOnlyRecords: LedgerRecord[] = [
    followupRow({
      runId: "run-2457",
      ts: "2026-08-29T16:00:00Z",
      taskId: "W1-T2457",
      entries: [{ type: "task", text: DISPATCH_ONLY_W1_T2457 }],
    }),
  ];
  const h = mineFollowups(dispatchOnlyRecords, []);
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(h, { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry });

  assert.equal(reg.calls(), 0, "no routable candidate at all — the registry writer is never invoked, so no draft can be spawned");
  assert.equal(reg.state().length, 0);
  assert.equal(outcomes.length, 1);
  assert.ok(!outcomes[0]!.routed);
});

// ── acceptance 4: the arm states which live entries it wrongly declines, rather than claiming none ─

test("the dispatch-only arm's reason names its own false-decline risk rather than claiming none", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  const declined = outcomes.find((o) => o.candidate.taskId === "W1-T2457");
  assert.ok(declined && !declined.routed);
  if (declined && !declined.routed) {
    assert.match(
      declined.reason,
      /wrongly declined/i,
      "the reason must name the risk of wrongly declining a live entry, not assert perfect precision",
    );
    assert.match(declined.reason, /heuristic/i, "the reason must state this is a free-prose heuristic, not a parser");
  }
});

// ── the existing two arms are untouched by this addition ────────────────────────────────────────

test("the pre-existing title-dedup and type-not-plan-shaped arms are unaffected by the new arm", () => {
  const openTitle = "harden the deploy-lock retry pathway against concurrent workers";
  const mixedRecords: LedgerRecord[] = [
    ...RECORDS,
    followupRow({
      runId: "run-dup",
      ts: "2026-08-20T00:03:00Z",
      taskId: "W1-T9004",
      entries: [{ type: "task", text: openTitle }],
    }),
    followupRow({
      runId: "run-action",
      ts: "2026-08-20T00:04:00Z",
      taskId: "W1-T9005",
      entries: [{ type: "action", text: "an operator should flip the canary flag once merged" }],
    }),
  ];
  const h = mineFollowups(mixedRecords, [openTitle]);
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(h, { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry });

  const dedup = outcomes.find((o) => o.candidate.taskId === "W1-T9004");
  assert.ok(dedup && !dedup.routed);
  if (dedup && !dedup.routed) assert.equal(dedup.arm, "title-dedup");

  const action = outcomes.find((o) => o.candidate.taskId === "W1-T9005");
  assert.ok(action && !action.routed);
  if (action && !action.routed) assert.equal(action.arm, "type-not-plan-shaped");
});
