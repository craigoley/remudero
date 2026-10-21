import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { SCOUT_WINDOW_MS, isFailureShapedStep, scoutGardenSpec, scoutSymptoms } from "#src/lib/scout-gardener.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 8, 12);
const at = (fractionOfWindow: number): string => new Date(NOW - SCOUT_WINDOW_MS * fractionOfWindow).toISOString();
const recurringRows = (step: string): Record<string, unknown>[] => [
  { ts: at(0.8), step },
  { ts: at(0.2), step },
  { ts: at(0.1), step },
];

test("W1-T9265: expected draft escalation stays in the ledger but is not a recurring failure", () => {
  const rows = [...recurringRows("inbox.draft_escalated"), ...recurringRows("pr.escalated")];
  const originalRows = structuredClone(rows);

  assert.equal(isFailureShapedStep("inbox.draft_escalated"), false);
  assert.deepEqual(scoutSymptoms(rows, NOW, () => false).map(({ step, older, newer }) => ({ step, older, newer })), [
    { step: "pr.escalated", older: 1, newer: 2 },
  ]);
  assert.deepEqual(rows, originalRows, "classification leaves every input ledger row intact");
  assert.equal(rows.filter((row) => row.step === "inbox.draft_escalated").length, 3);
});

test("W1-T9265: actual draft and escalation failures remain recurring scout symptoms", (t) => {
  const steps = ["inbox.draft_error", "inbox.draft_escalation_error", "inbox.draft_failed", "pr.escalated"];
  const rows = [...recurringRows("inbox.draft_escalated"), ...steps.flatMap(recurringRows)];
  const { dir } = writeLedger(rows);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const step of steps) assert.equal(isFailureShapedStep(step), true, step);
  const spec = scoutGardenSpec({
    repoRoot: "/unused", stateDir: dir, clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  }, {
    mintTaskId: () => "W1-T9265", plan: () => ({ open: [], all: [], shards: new Map() }),
    mergedTasks: () => new Map(), mergedLastDay: () => steps.length,
  });
  const inventory = spec.inventory();
  assert.deepEqual(inventory.symptoms.map(({ step, older, newer }) => ({ step, older, newer })),
    steps.map((step) => ({ step, older: 1, newer: 2 })).sort((a, b) => a.step.localeCompare(b.step)));
  assert.deepEqual(inventory.selected.map(({ step }) => step), inventory.symptoms.map(({ step }) => step));
  assert.equal(inventory.symptoms.some(({ step }) => step === "inbox.draft_escalated"), false);
});
