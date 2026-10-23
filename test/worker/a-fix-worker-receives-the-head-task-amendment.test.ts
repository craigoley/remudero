import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import { resolvePlanCriteriaAtHead, type PlanCriteriaAtHeadResult } from "#src/lib/review.js";
import { fixRungTaskAtHead } from "#src/lib/sweep.js";
import { taskSemanticRevision } from "#src/lib/escalate.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const id = "W1-T1";
const criterion = { claim: "the canonical head claim", proof: "unit test: canonical head regression" };
const snapshot = () => ({
  task: { id, title: "fixture", risk: "low" as const, acceptance: [criterion], files: ["src/x.ts"],
    design: "stale snapshot design", amendment: "stale snapshot amendment" }, synthetic: false,
});
const head = (over: Partial<PlanCriteriaAtHeadResult> = {}): PlanCriteriaAtHeadResult => ({
  taskId: id, criteria: [criterion], taskRisk: "low", taskDeclaredFiles: ["src/x.ts"], ...over,
});

test("a fix worker receives the canonical head amendment through the real plan resolver", t => {
  const repo = gitRepo({ scope: t, kind: "fix-head-narrative" });
  const narrative = { design: "canonical head design", amendment: "retain the 4096 identity backstop" };
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), JSON.stringify([{
    id, title: "fixture", repo: "remudero", type: "implement", verify: "auto", risk: "low",
    status: "queued", attempts: 0, depends_on: [], files: ["src/x.ts"], acceptance: [criterion], ...narrative,
  }]));
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-m", "test: record canonical task narrative");
  const resolved = resolvePlanCriteriaAtHead(`Remudero-Task: ${id}`, repo.dir, "plan/tasks.yaml", repo.git("rev-parse", "HEAD"));
  assert.equal(resolved.divergence, undefined, JSON.stringify(resolved));
  assert.equal(resolved.taskId, id);
  assert.deepEqual(resolved.taskNarrative, narrative, "positive control: the canonical reader saw the head's narrative");
  const result = fixRungTaskAtHead(snapshot(), id, resolved);
  if ("standDown" in result) assert.fail(result.standDown);
  assert.equal(result.task.design, narrative.design);
  assert.equal(result.task.amendment, narrative.amendment);
  assert.equal(taskSemanticRevision(result.task), taskSemanticRevision(narrative));
  const prompt = renderFixPrompt({ task: result.task, round: 1, branch: "fixture", evidence: { ciFailures: [{ name: "ci", logTail: "fixture" }] } });
  assert.ok(prompt.includes(narrative.design));
  assert.ok(prompt.includes(narrative.amendment));
  assert.equal(prompt.includes("stale snapshot"), false);
});

test("a readable head without narrative clears stale snapshot narrative and its unavailable flag", () => {
  const current = snapshot();
  const result = fixRungTaskAtHead({ ...current, task: { ...current.task, narrativeUnavailable: true } }, id, head());
  if ("standDown" in result) assert.fail(result.standDown);
  assert.equal(result.task.design, undefined);
  assert.equal(result.task.amendment, undefined);
  assert.equal(result.task.narrativeUnavailable, undefined);
});

test("an unreadable canonical head narrative refuses the fix rather than using snapshot prose", () => {
  for (const taskNarrative of [{ narrativeUnavailable: true as const }, { design: 42 }, { amendment: {} }]) {
    const result = fixRungTaskAtHead(snapshot(), id, head({ taskNarrative }));
    assert.ok("standDown" in result);
    assert.match(result.standDown, /PR-head task narrative unreadable/);
  }
});

test("a narrative-only canonical record remains authoritative without borrowing snapshot files", () => {
  const result = fixRungTaskAtHead(snapshot(), id, { taskId: id, criteria: [], taskNarrative: { amendment: "canonical amendment" } });
  if ("standDown" in result) assert.fail(result.standDown);
  assert.equal(result.task.amendment, "canonical amendment");
  assert.equal(result.task.design, undefined);
  assert.deepEqual(result.task.files, []);
  assert.deepEqual(result.task.acceptance, []);
});

test("an unreadable head contract still refuses and a readable absent task keeps the established fallback", () => {
  assert.ok("standDown" in fixRungTaskAtHead(snapshot(), id, undefined));
  const current = snapshot();
  assert.equal(fixRungTaskAtHead(current, id, { taskId: id, criteria: [] }), current);
});
