// W1-T13694: a ready Inbox card is not ratified, so its stamp previews what approval records; and a folded twin
// leaves every lane, so section=ready and its count list a parked task once (W1-T13113, 2026-11-18).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InboxState } from "#src/lib/inbox.js";
import { inboxLanes, pendingStampLine } from "#src/lib/panel-graph.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function lanes(rows: ReadonlyArray<[string, InboxState]>, stampLine?: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ready-card-stamp-`));
  try {
    const proposals = rows.map(([id]) => ({ id, summary: id, evidenceAnchors: [] }));
    const classifications = rows.map(([proposalId, state]) => ({
      proposalId, state, reasons: [], ...(stampLine ? { draft: { fragmentYaml: "", stampLine } } : {}),
    }));
    return inboxLanes({ proposals, classifications, ledgerLines: Object.assign([], { torn: 0, present: true }) } as never, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T13694 criterion 1: a ready card's stamp reads on approval, never RATIFIED with a date", () => {
  const stamp = "- machine-judge:W1-T9 (release the task) — RATIFIED 2026-11-18 -> NEW-1.";
  assert.equal(pendingStampLine(stamp), "- machine-judge:W1-T9 (release the task) — on approval -> NEW-1.");
  const built = lanes([["machine-judge:W1-T9", "ready"]], stamp);
  const served = built.needsYou.ready[0]?.stampLine ?? "";
  assert.doesNotMatch(served, /RATIFIED/);
  assert.match(served, /on approval -> NEW-1/);
  assert.equal(pendingStampLine(undefined), undefined);
});

test("W1-T13694 criterion 2: section ready lists a task with both asks once, and counts it once", () => {
  const built = lanes([["verify-human:W1-T9", "ready"], ["machine-judge:W1-T9", "ready"], ["verify-human:W1-T8", "ready"]]);
  assert.deepEqual(built.ready.map((item) => item.proposalId).sort(), ["machine-judge:W1-T9", "verify-human:W1-T8"]);
  assert.equal(built.counts.ready, 2);
  assert.deepEqual(built.needsYou.ready.map((item) => item.proposalId).sort(), ["machine-judge:W1-T9", "verify-human:W1-T8"]);
});
