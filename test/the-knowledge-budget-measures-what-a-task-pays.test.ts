import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  entryBudgetWeight,
  measureTaskDropPressure,
  selectLearnings,
} from "../src/lib/learnings.js";
import type { LearningEntry } from "../src/lib/learnings.js";

// W1-T3733. `learnings-budget-ratchet` blocks a PR on the CORPUS-WIDE sum of entryBudgetWeight.
// Its own baseline file says that number is "orthogonal to DEFAULT_KNOWLEDGE_BUDGET_CHARS, which
// caps what any ONE task's matched selection actually injects" — true, deliberate, and the reason
// nothing has ever measured the per-task side. These tests pin the measurement that does.

const entry = (id: string, fact: string, files: string[]): LearningEntry =>
  ({ id, subsystem: "t", lifecycle: "active", files, fact } as unknown as LearningEntry);

test("an entry that matches NO task costs that task nothing, however big the corpus grows", () => {
  const relevant = entry("relevant", "x".repeat(200), ["src/a.ts"]);
  const irrelevant = Array.from({ length: 50 }, (_, i) => entry(`noise${i}`, "y".repeat(400), ["src/elsewhere.ts"]));
  const small = selectLearnings([relevant], ["src/a.ts"]);
  const huge = selectLearnings([relevant, ...irrelevant], ["src/a.ts"]);
  assert.deepEqual(huge.selected.map((e) => e.id), small.selected.map((e) => e.id));
  assert.equal(huge.dropped.length, 0, "unmatched entries are not even candidates, so they cannot be 'dropped'");
});

test("no task can inject more than the per-task budget, whatever the corpus totals", () => {
  const many = Array.from({ length: 80 }, (_, i) => entry(`e${i}`, "z".repeat(500), ["src/a.ts"]));
  const { selected } = selectLearnings(many, ["src/a.ts"]);
  const injected = selected.reduce((s, e) => s + entryBudgetWeight(e), 0);
  assert.ok(injected <= DEFAULT_KNOWLEDGE_BUDGET_CHARS, `injected ${injected} must not exceed the budget`);
  // and the corpus here is far larger than that budget, which is the whole point
  assert.ok(many.reduce((s, e) => s + entryBudgetWeight(e), 0) > DEFAULT_KNOWLEDGE_BUDGET_CHARS * 4);
});

test("the pressure measure counts TASKS LOSING MATCHES, not corpus size", () => {
  const fat = Array.from({ length: 40 }, (_, i) => entry(`f${i}`, "q".repeat(600), ["src/a.ts"]));
  const p = measureTaskDropPressure(fat, [
    { id: "OVER", files: ["src/a.ts"] },      // matches all 40, cannot carry them
    { id: "UNDER", files: ["src/other.ts"] }, // matches none
  ]);
  assert.equal(p.tasksMeasured, 2);
  assert.equal(p.tasksLosingMatches, 1, "only the task that matched more than it could carry");
  assert.ok(p.droppedMatches > 0);
  assert.equal(p.worst?.taskId, "OVER");
  assert.ok(p.worst!.injectedChars <= DEFAULT_KNOWLEDGE_BUDGET_CHARS);
});

test("a task with no declared files is not measured — absent files is not repo-wide", () => {
  // selectLearnings admits an entry on a symbol or error hit alone, but a files-less task has no
  // declared surface to measure against, so counting it would invent a denominator.
  const p = measureTaskDropPressure([entry("a", "x".repeat(100), ["src/a.ts"])], [{ id: "NOFILES" }, { id: "EMPTY", files: [] }]);
  assert.equal(p.tasksMeasured, 0);
  assert.equal(p.tasksLosingMatches, 0);
  assert.equal(p.worst, undefined);
});

test("a corpus nobody matches reports ZERO pressure, which is the honest reading", () => {
  const p = measureTaskDropPressure(
    Array.from({ length: 30 }, (_, i) => entry(`u${i}`, "w".repeat(900), ["src/unrelated.ts"])),
    [{ id: "T", files: ["src/a.ts"] }],
  );
  assert.equal(p.tasksMeasured, 1);
  assert.equal(p.tasksLosingMatches, 0, "a big corpus is not, by itself, pressure");
  assert.equal(p.droppedMatches, 0);
});
