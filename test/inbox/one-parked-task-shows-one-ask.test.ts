// W1-T13479: one parked task shows one Inbox ask. When the verify-human judge and the machine-filing
// judge both park a task, verify-human:<id> folds into machine-judge:<id> in needsYou, in its counts and
// in the human-gate projection every badge reads, and stays folded once the kept ask is answered.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { foldedTwinAsks, projectProposalHumanGates } from "#src/lib/ask-classification.js";
import type { InboxState } from "#src/lib/inbox.js";
import { inboxLanes } from "#src/lib/panel-graph.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function lanes(rows: ReadonlyArray<[string, InboxState]>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-parked-task-`));
  try {
    const proposals = rows.map(([id]) => ({ id, summary: id, evidenceAnchors: [] }));
    const classifications = rows.map(([proposalId, state]) => ({ proposalId, state, reasons: [] }));
    return inboxLanes({ proposals, classifications, ledgerLines: Object.assign([], { torn: 0, present: true }) } as never, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const gateSubjects = (projection: ReturnType<typeof projectProposalHumanGates>) =>
  projection.gates.map((gate) => decodeURIComponent(gate.key.split(":")[2]!)).sort();

test("W1-T13479 criterion 1: a task with both a verify-human and a machine-judge ask shows one needsYou row", () => {
  const built = lanes([["verify-human:W1-T9", "ready"], ["machine-judge:W1-T9", "ready"], ["verify-human:W1-T8", "ready"]]);
  const ids = built.needsYou.ready.map((item) => item.proposalId).sort();
  assert.deepEqual(ids, ["machine-judge:W1-T9", "verify-human:W1-T8"]);
  assert.equal(built.counts.needsYou.ready, 2);
  assert.deepEqual(gateSubjects(built.humanGates), ["machine-judge:W1-T9", "verify-human:W1-T8"]);
  // A verify-human ask with no machine-judge twin is untouched.
  assert.deepEqual([...foldedTwinAsks(["verify-human:W1-T8", "machine-judge:W1-T7"])], []);
});

test("W1-T13479 criterion 2: answering the kept ask settles its hidden twin", () => {
  for (const answered of ["declined", "drafting"] as const) {
    const built = lanes([["verify-human:W1-T9", "ready"], ["machine-judge:W1-T9", answered]]);
    assert.deepEqual(built.needsYou.ready.map((item) => item.proposalId), [], `twin resurfaced after the kept ask went ${answered}`);
    assert.equal(built.counts.needsYou.ready, 0);
    assert.deepEqual(gateSubjects(projectProposalHumanGates([
      { proposalId: "verify-human:W1-T9", state: "ready" }, { proposalId: "machine-judge:W1-T9", state: answered },
    ] as never)), []);
  }
});
