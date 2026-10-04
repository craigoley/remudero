import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PROCEDURAL_STEP_TEXT,
  renderSkillDraft,
  scanSkillDraft,
  stageSkillDraft,
  type SkillDraft,
} from "../src/lib/skill-workshop.js";

const ALLOWLIST = { allowedHosts: [], deniedPathPatterns: [], allowedTools: [] };

function rendered(signal: string): SkillDraft {
  return renderSkillDraft({
    shapeKey: `implement:${signal}`,
    taskType: "implement",
    signals: [signal],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  })!;
}

function described(description: string, ...steps: string[]): SkillDraft {
  return {
    name: "future-signal",
    description,
    candidateHash: "candidate",
    procedureKey: "procedure",
    supportingRuns: 2,
    markdown: `## Procedure\n\n${steps.map((step) => `- ${step}`).join("\n")}\n\n## Evidence\n\n- unrelated evidence\n`,
  };
}

test("W1-T4283: the clean_single_strike step is refused as restating its own outcome", () => {
  const draft = rendered("clean_single_strike");
  assert.ok(draft.markdown.includes(`- ${PROCEDURAL_STEP_TEXT.clean_single_strike}`));
  assert.equal(scanSkillDraft(draft, ALLOWLIST).ok, false);
});

test("W1-T4283: mined transcript steps replace the outcome-only step, so the draft scans clean", () => {
  const tool = (runId: string, taskId: string, name: string) => ({ run_id: runId, task_id: taskId, step: "worker.activity", event_kind: "tool-executing", tool_name: name });
  const runs = [
    { runId: "P1", taskId: "W1-T300", type: "implement", verdict: "merged" },
    { runId: "P2", taskId: "W1-T301", type: "implement", verdict: "merged" },
    { runId: "D1", taskId: "W1-T302", type: "implement", verdict: "merged" },
  ];
  const records = [
    tool("P1", "W1-T300", "Grep"), tool("P1", "W1-T300", "Edit"),
    tool("P2", "W1-T301", "Grep"), tool("P2", "W1-T301", "Edit"),
    tool("D1", "W1-T302", "Edit"),
    { ts: "2026-05-01T00:00:01.000Z", run_id: "D1", task_id: "W1-T302", step: "fix.dispatch" },
  ];
  const draft = renderSkillDraft({
    shapeKey: "implement:clean_single_strike",
    taskType: "implement",
    signals: ["clean_single_strike"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  }, { runs, records })!;
  assert.ok(!draft.markdown.includes(PROCEDURAL_STEP_TEXT.clean_single_strike));
  assert.match(draft.markdown, /Call `Grep`/);
  assert.deepEqual(scanSkillDraft(draft, ALLOWLIST), { ok: true });
});

test("W1-T4283: the fully_executed_proof step passes unchanged", () => {
  const draft = rendered("fully_executed_proof");
  assert.ok(draft.markdown.includes(`- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`));
  assert.deepEqual(scanSkillDraft(draft, ALLOWLIST), { ok: true });
  const registry = join(mkdtempSync(join(tmpdir(), "rmd-test-actionable-proof-")), "proposals.json");
  assert.equal(stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" }).staged, true);
});

test("W1-T4283: a refused draft names the offending step verbatim with offendingLine and reason", () => {
  const draft = rendered("clean_single_strike");
  const line = `- ${PROCEDURAL_STEP_TEXT.clean_single_strike}`;
  const result = scanSkillDraft(draft, ALLOWLIST);
  assert.equal(result.offendingLine, line);
  assert.match(result.reason!, /outcome-only.*restates.*outcome/i);
  const registry = join(mkdtempSync(join(tmpdir(), "rmd-test-actionable-refusal-")), "proposals.json");
  const staged = stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" });
  assert.equal(staged.refused, true);
  assert.equal(staged.staged, false);
  assert.ok(staged.reason!.includes(line));
  assert.equal(existsSync(registry), false, "refusal happens before the registry is written");
});

test("W1-T4283: future outcome restatements are refused without naming a shipped signal key", () => {
  const draft = described("The repaired tasks merge after the checks pass.", "Merge the repaired task after checks pass!");
  assert.equal(scanSkillDraft(draft, ALLOWLIST).ok, false);
  assert.deepEqual(scanSkillDraft(described(draft.description, "Run the checks before merging the repaired task."), ALLOWLIST), { ok: true });
});

test("W1-T4283: punctuation, case and grammatical filler add no behavioral content", () => {
  for (const step of ["SHIP the verified result!", "The verified result is shipped.", "Ship a verified result.", "..."]) {
    assert.equal(scanSkillDraft(described("Verified results shipped.", step), ALLOWLIST).ok, false, step);
  }
});

test("W1-T4283: an actionable sibling cannot hide the first outcome-only step", () => {
  const draft = described("Verified results shipped.", "Run tests before shipping.", "Ship verified results.", "Verified results shipped.");
  assert.equal(scanSkillDraft(draft, ALLOWLIST).offendingLine, "- Ship verified results.");
  const shipped = rendered("clean_single_strike");
  assert.equal(scanSkillDraft({ ...shipped, markdown: shipped.markdown.replace("## Evidence", "- Call `Grep` before editing.\n\n## Evidence") }, ALLOWLIST).ok, false);
});

test("W1-T4283: outcome comparisons use only Procedure steps, not frontmatter or Evidence", () => {
  const draft = described("Verified results shipped.", "Run tests before shipping.");
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: `---\ndescription: Verified results shipped.\n---\n\n${draft.markdown}- Ship verified results.\n` }, ALLOWLIST), { ok: true });
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: "## Evidence\n\n- Ship verified results.\n" }, ALLOWLIST), { ok: true });
});

test("W1-T4283: an unmapped signal cannot stage its raw key as a procedure", () => {
  assert.equal(scanSkillDraft(rendered("future_outcome"), ALLOWLIST).ok, false);
});

test("W1-T4283: caller-supplied outcome metadata reaches the scanner without changing the signal table", () => {
  const draft = renderSkillDraft({
    shapeKey: "implement:fast_delivery",
    taskType: "implement",
    signals: ["fast_delivery"],
    outcomeDescriptions: { fast_delivery: "Verified results shipped." },
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  })!;
  const restatement = { ...draft, markdown: "## Procedure\n\n- Ship verified results.\n" };
  assert.equal(scanSkillDraft(restatement, ALLOWLIST).ok, false);
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: "## Procedure\n\n- Inspect failing tests before shipping.\n" }, ALLOWLIST), { ok: true });
});

test("W1-T4283: comparisons keep each mined outcome distinct instead of combining their vocabularies", () => {
  const draft = described("A pair of independent outcomes.", "Check shipped results.");
  assert.deepEqual(scanSkillDraft({ ...draft, outcomeDescriptions: ["Checks passed.", "Results shipped."] }, ALLOWLIST), { ok: true });
});

test("W1-T4283: empty outcome metadata falls back to the draft description", () => {
  const draft = described("Verified results shipped.", "Ship verified results.");
  assert.equal(scanSkillDraft({ ...draft, outcomeDescriptions: [] }, ALLOWLIST).ok, false);
});
