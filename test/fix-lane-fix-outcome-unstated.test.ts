import assert from "node:assert/strict";
import { test } from "node:test";
import { defectEventsOf } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.UTC(2026, 9, 14, 12);
const row = (ts: string, id: string): LedgerRecord[] => [
  { step: "fix.dispatch", pr_number: 7, ts, round_id: id, head_sha: id },
  { step: "fix.done", pr_number: 7, ts, round_id: id, fix_outcome: "unstated", head_sha: id },
];

test("W1-T7739: fix-lane-fix-outcome-unstated clears without a person", () => {
  const before = defectEventsOf(row("2026-10-08T12:00:00.000Z", "old"), NOW);
  assert.equal(before.filter(e => e.key === "fix-outcome:unstated").length, 0);
  const after = defectEventsOf(row("2026-10-12T12:00:00.000Z", "new"), NOW);
  assert.equal(after.filter(e => e.key === "fix-outcome:unstated").length, 1);
});
