import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import {
  PROCEDURAL_STEP_TEXT,
  renderSkillDraft,
  scanSkillDraft,
  skillDraftProposalId,
  stageSkillDraft,
  type SkillDraft,
} from "../src/lib/skill-workshop.js";

const ALLOWLIST = { allowedHosts: [], deniedPathPatterns: [], allowedTools: [] };

/** W1-T13857: P1 and P2 (two tasks) both ran the type check and then changed a lib file. */
const MINED = {
  runs: ["P1", "P2"].map((runId, i) => ({ runId, taskId: `W1-T30${i}`, type: "implement", verdict: "merged" })),
  records: ["P1", "P2"].flatMap((runId) => ["Bash:npm run typecheck", "Edit:src/lib/plan.ts"].map((tool_signature) =>
    ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: tool_signature.split(":")[0], tool_signature }))),
};

function rendered(signal: string): SkillDraft {
  return renderSkillDraft({
    shapeKey: `implement:${signal}`,
    taskType: "implement",
    signals: [signal],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  }, MINED)!;
}

/** W1-T4270: renderSkillDraft no longer drafts an outcome-only or unmapped signal, but a draft
 *  staged before it (or built by another caller) still reaches the scanner. This rebuilds that
 *  shape from a mixed render, which carries every mined outcome, with its Procedure swapped to the
 *  given signal's own step alone. */
function outcomeOnly(signal = "clean_single_strike"): SkillDraft {
  const mixed = renderSkillDraft({
    shapeKey: `implement:${signal}`,
    taskType: "implement",
    signals: [signal, "fully_executed_proof"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  }, MINED)!;
  const line = `- ${PROCEDURAL_STEP_TEXT[signal] ?? signal}`;
  return { ...mixed, markdown: mixed.markdown.replace(/## Procedure\n[\s\S]*?(?=## Evidence)/, `## Procedure\n\n${line}\n\n`) };
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
  assert.equal(rendered("clean_single_strike"), undefined, "W1-T4270: an outcome label is never drafted");
  const draft = outcomeOnly("clean_single_strike");
  assert.ok(draft.markdown.includes(`- ${PROCEDURAL_STEP_TEXT.clean_single_strike}`));
  assert.equal(scanSkillDraft(draft, ALLOWLIST).ok, false);
});

test("W1-T13857: the recurring commands are the Procedure, never the outcome-only step, so the draft scans clean", () => {
  const draft = renderSkillDraft({
    shapeKey: "implement:clean_single_strike+fully_executed_proof",
    taskType: "implement",
    signals: ["clean_single_strike", "fully_executed_proof"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  }, MINED)!;
  assert.ok(!draft.markdown.includes(PROCEDURAL_STEP_TEXT.clean_single_strike));
  assert.match(draft.markdown, /- Run `npm run typecheck`\.\n- Change `src\/lib\/\*\.ts`\./);
  assert.deepEqual(scanSkillDraft(draft, ALLOWLIST), { ok: true });
});

test("W1-T13857: the fully_executed_proof step alone is not an action, and the draft is refused", () => {
  const draft = outcomeOnly("fully_executed_proof");
  const result = scanSkillDraft(draft, ALLOWLIST);
  assert.equal(result.offendingLine, `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`);
  assert.match(result.reason ?? "", /^not-an-action/);
  // W1-T13858: the whole-draft check still names the outcome-only draft first.
  const registry = join(mkdtempSync(join(tmpdir(), "rmd-test-actionable-proof-")), "proposals.json");
  const staged = stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" });
  assert.equal(staged.refused, true);
  assert.match(staged.reason ?? "", /^outcome-only:/);
  assert.equal(existsSync(registry), false);
});

test("W1-T4283: a refused draft names the offending step verbatim with offendingLine and reason", () => {
  const draft = outcomeOnly("clean_single_strike");
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
  assert.deepEqual(scanSkillDraft(described(draft.description, "Run `npm run check` before merging the repaired task."), ALLOWLIST), { ok: true });
});

test("W1-T4283: punctuation, case and grammatical filler add no behavioral content", () => {
  for (const step of ["SHIP the verified result!", "The verified result is shipped.", "Ship a verified result.", "..."]) {
    assert.equal(scanSkillDraft(described("Verified results shipped.", step), ALLOWLIST).ok, false, step);
  }
});

test("W1-T4283: an actionable sibling cannot hide the first outcome-only step", () => {
  const draft = described("Verified results shipped.", "Run `npm test` before shipping.", "Ship verified results.", "Verified results shipped.");
  assert.equal(scanSkillDraft(draft, ALLOWLIST).offendingLine, "- Ship verified results.");
  const shipped = outcomeOnly("clean_single_strike");
  assert.equal(scanSkillDraft({ ...shipped, markdown: shipped.markdown.replace("## Evidence", "- Run `npm test` before editing.\n\n## Evidence") }, ALLOWLIST).ok, false);
});

test("W1-T4283: outcome comparisons use only Procedure steps, not frontmatter or Evidence", () => {
  const draft = described("Verified results shipped.", "Run `npm test` before shipping.");
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: `---\ndescription: Verified results shipped.\n---\n\n${draft.markdown}- Ship verified results.\n` }, ALLOWLIST), { ok: true });
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: "## Evidence\n\n- Ship verified results.\n" }, ALLOWLIST), { ok: true });
});

test("W1-T4283: an unmapped signal cannot stage its raw key as a procedure", () => {
  assert.equal(rendered("future_outcome"), undefined, "W1-T4270: an uncatalogued signal is never drafted");
  assert.equal(scanSkillDraft(outcomeOnly("future_outcome"), ALLOWLIST).ok, false);
});

test("W1-T4283: caller-supplied outcome metadata reaches the scanner without changing the signal table", () => {
  const draft = renderSkillDraft({
    shapeKey: "implement:fast_delivery+fully_executed_proof",
    taskType: "implement",
    signals: ["fast_delivery", "fully_executed_proof"],
    outcomeDescriptions: { fast_delivery: "Verified results shipped." },
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  }, MINED)!;
  const restatement = { ...draft, markdown: "## Procedure\n\n- Ship verified results.\n" };
  assert.equal(scanSkillDraft(restatement, ALLOWLIST).ok, false);
  assert.deepEqual(scanSkillDraft({ ...draft, markdown: "## Procedure\n\n- Rerun `npm test` on failing tests before shipping.\n" }, ALLOWLIST), { ok: true });
});

test("W1-T4283: comparisons keep each mined outcome distinct instead of combining their vocabularies", () => {
  const draft = described("A pair of independent outcomes.", "Run `checks` on shipped results.");
  assert.deepEqual(scanSkillDraft({ ...draft, outcomeDescriptions: ["Checks run.", "Results shipped."] }, ALLOWLIST), { ok: true });
});

test("W1-T4283: empty outcome metadata falls back to the draft description", () => {
  const draft = described("Verified results shipped.", "Ship verified results.");
  assert.equal(scanSkillDraft({ ...draft, outcomeDescriptions: [] }, ALLOWLIST).ok, false);
});

test("W1-T4283: removing outcome-only bullets does not prevent a behavioral draft refresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-test-actionable-refresh-"));
  const registry = join(dir, "proposals.json");
  const staged = outcomeOnly("clean_single_strike");
  const id = skillDraftProposalId(staged.procedureKey);
  const draft = {
    ...staged,
    markdown: staged.markdown.replace(PROCEDURAL_STEP_TEXT.clean_single_strike, "Run `npm test` before editing."),
  };
  try {
    writeFileSync(registry, JSON.stringify({ proposals: [{ id, summary: "staged earlier", evidenceAnchors: [], skillFile: { name: staged.name, markdown: staged.markdown } }] }));
    const result = stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" });
    assert.equal(result.refreshed, true);
    assert.equal(result.alreadyStaged, true);
    assert.equal(result.refused, false);
    assert.equal(loadProposalRegistry(registry)[0].skillFile!.markdown, draft.markdown);
    assert.equal(stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" }).refreshed, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4283: a staged restatement is discounted against the fallback draft description", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-test-actionable-refresh-fallback-"));
  const registry = join(dir, "proposals.json");
  const outcomeOnly = described("Verified results shipped.", "Ship verified results.");
  const id = skillDraftProposalId(outcomeOnly.procedureKey);
  const draft = described(outcomeOnly.description, "Rerun `npm test` on failing tests before shipping.");
  try {
    writeFileSync(registry, JSON.stringify({ proposals: [{ id, summary: "staged earlier", evidenceAnchors: [], skillFile: { name: outcomeOnly.name, markdown: outcomeOnly.markdown } }] }));
    assert.equal(stageSkillDraft(registry, draft, ALLOWLIST, { reachable: true, reason: "fixture" }).refreshed, true);
    assert.equal(loadProposalRegistry(registry)[0].skillFile!.markdown, draft.markdown);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
