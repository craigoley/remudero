import assert from "node:assert/strict";
import { test } from "node:test";
import { retroPrompt } from "#src/run-task.js";

// W1-T4048: the retro prompt used to say "PROPOSALS ONLY … Do NOT edit plan/tasks.yaml", which
// contradicted standing rule 27 (automatic filing is permitted). These pin the corrected text.
// The subject here genuinely IS the prompt text: retroPrompt() returns prose handed to a worker.

const prompt = (shellLess = false): string =>
  retroPrompt("gather", "calibration", "RETRO-123", shellLess);

test("W1-T4048: the retro prompt no longer forbids filing", () => {
  for (const shellLess of [false, true]) {
    const text = prompt(shellLess);
    assert.doesNotMatch(text, /PROPOSALS ONLY/);
    assert.doesNotMatch(text, /Do NOT edit plan\/tasks\.yaml/i);
  }
  assert.match(prompt(), /no 'proposals only' restriction on this lane/);
});

test("W1-T4048: the retro prompt writes proposal records", () => {
  const text = prompt();
  assert.match(text, /proposal RECORDS/);
  assert.match(text, /plan\/proposals\.d\/P<N>-<slug>\.yaml/);
  assert.match(text, /falsifier must be EXECUTABLE/);
  assert.match(text, /edit ONLY MASTER-PLAN\.md\s+and the proposal records under plan\/proposals\.d\//);
  // The one-time migration is said in the prompt, with the count to be re-derived, not copied.
  assert.match(text, /ONE-TIME MIGRATION/);
  assert.match(text, /AND plan\/proposals\.d\/\s+does not exist/);
  assert.match(text, /reduce the MASTER-PLAN\.md section\s+to a short pointer/);
  assert.match(text, /RE-DERIVE the bullet count/);
  assert.match(text, /21 at 855dcb0b6/);
});

test("W1-T4048: the retro prompt cites rule 27", () => {
  const text = prompt();
  assert.match(text, /rule 27 PERMITS\s+automatic filing/);
  assert.match(text, /may be filed as a task/);
});

test("W1-T4048: the retro prompt keeps the next unused proposal id rule", () => {
  const text = prompt();
  assert.match(text, /BEFORE MINTING ANY NEW PROPOSAL ID: take the NEXT UNUSED number/);
  assert.match(text, /never reuse or guess one/);
  assert.match(text, /rmd next-task-id/);
  // The discipline now spans both stores: the records and the not-yet-migrated bullets.
  assert.match(text, /plan\/proposals\.d\/ records AND the '- \*\*\[★ \]P<N>' bullets/);
});
