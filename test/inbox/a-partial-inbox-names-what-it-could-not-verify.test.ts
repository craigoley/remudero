import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, type BoardReferentRead, type ReadinessContext } from "#src/lib/inbox.js";
import { inboxClassificationEvidence } from "#src/lib/panel-graph.js";
import type { StatusProjection } from "#src/lib/status.js";

const prefix = "the GitHub projection or a proposal referent is indeterminate";
const missingReferent: BoardReferentRead = { kind: "ok", states: new Map() };
const openReferent: BoardReferentRead = { kind: "ok", states: new Map([["#42", { status: "open" }]]) };
const context: ReadinessContext = {
  plan: { tasks: [], byId: new Map() },
  isMerged: () => false,
  grepAnchorTrue: () => true,
  openProposalIds: new Set(),
  isRatified: () => false,
};

function classify(id: string, boardReferents?: BoardReferentRead) {
  return classifyProposal({ id, summary: "Internal proposal summary", evidenceAnchors: [] }, undefined, { ...context, boardReferents });
}

function taskRow(taskId: string, indeterminate: boolean): StatusProjection {
  return {
    taskId, status: "queued", merged: false, source: indeterminate ? "throttled" : "none",
    prUrl: "https://github.com/fixture/ops/pull/42",
    ...(indeterminate ? { indeterminate: true, unavailableReason: "unknown" } as const : {}),
  };
}

function projection(...rows: StatusProjection[]): Map<string, StatusProjection> {
  return new Map(rows.map(row => [row.taskId, row]));
}

test("W1-T14154 partial inbox names the proposal when the board read is absent or unreadable", () => {
  const id = "board-review:stale:#42";
  for (const read of [undefined, { kind: "unreadable" }] as const) {
    const classification = classify(id, read);
    assert.equal(classification.referentUnverified, true);
    assert.equal(classification.referentUnverifiedReason, "board-unreadable");
    assert.deepEqual(inboxClassificationEvidence({ classifications: [classification], projection: projection() }), {
      complete: false, incompleteReason: `${prefix}: ${id} (board-unreadable)`,
    });
  }
});

test("W1-T14154 partial inbox names the proposal when the board referent is missing", () => {
  const id = "board-review:stale:#42";
  const classification = classify(id, missingReferent);
  assert.equal(classification.referentUnverified, true);
  assert.equal(classification.referentUnverifiedReason, "referent-missing");
  assert.deepEqual(inboxClassificationEvidence({ classifications: [classification], projection: projection() }), {
    complete: false, incompleteReason: `${prefix}: ${id} (referent-missing)`,
  });
});

test("W1-T14154 partial inbox names the escalation proposal when the count is unverified", () => {
  const id = "board-review:escalation:#42";
  const classification = classify(id, openReferent);
  assert.equal(classification.referentUnverified, true);
  assert.equal(classification.referentUnverifiedReason, "escalation-count-unverified");
  assert.deepEqual(inboxClassificationEvidence({ classifications: [classification], projection: projection() }), {
    complete: false, incompleteReason: `${prefix}: ${id} (escalation-count-unverified)`,
  });
});

test("W1-T14154 partial inbox names sorted proposal and task IDs from public evidence", () => {
  const classifications = [classify("board-review:stale:#42", missingReferent),
    classify("board-review:escalation:#42", openReferent), classify("fixture:verified")];
  const rows = [taskRow("W1-T94", true), taskRow("W1-T93", false), taskRow("W1-T92", true)];
  const expected = {
    complete: false,
    incompleteReason: `${prefix}: board-review:escalation:#42 (escalation-count-unverified), ` +
      "board-review:stale:#42 (referent-missing), W1-T92, W1-T94",
  };
  assert.deepEqual(inboxClassificationEvidence({ classifications, projection: projection(...rows) }), expected);
  assert.deepEqual(inboxClassificationEvidence({ classifications: classifications.toReversed(), projection: projection(...rows.toReversed()) }), expected);
  assert.deepEqual(inboxClassificationEvidence({ classifications: [], projection: projection(rows[0]) }), {
    complete: false, incompleteReason: `${prefix}: W1-T94`,
  });
});

test("W1-T14154 partial inbox names at most ten entries across proposals and tasks", () => {
  const ids = ["#41", "#42", "#43", "#44"];
  const classifications = ids.toReversed().map(id => classify(`board-review:stale:${id}`, missingReferent));
  const taskIds = Array.from({ length: 9 }, (_, index) => `W1-T${91 + index}`);
  const rows = taskIds.toReversed().map(id => taskRow(id, true));
  const names = [...ids.map(id => `board-review:stale:${id} (referent-missing)`), ...taskIds.slice(0, 6)];
  assert.deepEqual(inboxClassificationEvidence({ classifications, projection: projection(...rows) }), {
    complete: false, incompleteReason: `${prefix}: ${names.join(", ")}, and 3 more`,
  });
});

test("W1-T14154 partial inbox names whole entries within the 1000 character limit", () => {
  const oversizedId = `board-review:stale:#${"9".repeat(1_000)}`;
  const oversized = classify(oversizedId, missingReferent);
  const detail = " (referent-missing), and 1 more";
  const exactId = `board-review:stale:#${"1".repeat(1_000 - prefix.length - 2 - detail.length - "board-review:stale:#".length)}`;
  const exact = inboxClassificationEvidence({ classifications: [oversized, classify(exactId, missingReferent)], projection: projection() });
  assert.deepEqual(exact, { complete: false, incompleteReason: `${prefix}: ${exactId}${detail}` });
  assert.equal(exact.incompleteReason?.length, 1_000);
  const overflow = inboxClassificationEvidence({ classifications: [oversized, classify(`${exactId}1`, missingReferent)], projection: projection() });
  assert.deepEqual(overflow, { complete: false, incompleteReason: `${prefix}: and 2 more` });

  const fullFitId = `${exactId}1111`;
  const allFit = inboxClassificationEvidence({ classifications: [classify(fullFitId, missingReferent)], projection: projection(taskRow("W1-T92", true)) });
  assert.deepEqual(allFit, { complete: false, incompleteReason: `${prefix}: ${fullFitId} (referent-missing), W1-T92` });
  assert.equal(allFit.incompleteReason?.length, 1_000);
});

test("W1-T14154 partial inbox names no reason when a classification is complete", () => {
  const classification = classify("board-review:stale:#42", openReferent);
  assert.equal(classification.referentUnverified, undefined);
  assert.equal(classification.referentUnverifiedReason, undefined);
  assert.deepEqual(inboxClassificationEvidence({ classifications: [classification], projection: projection(taskRow("W1-T92", false)) }), {
    complete: true,
  });
});
