import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { lintPlan, lintTask, sizingViolation } from "../src/lib/task-linter.js";

const SLUG = "a-test-process-never-reads-the-hosts-scratch-switch";

function fixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T5631",
    title: "isolate the scratch switch",
    repo: "remudero",
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    depends_on: [],
    attempts: 0,
    origin: "architect",
    sourcePath: `/checkout/plan/tasks.d/W1-T5631-${SLUG}.yaml`,
    files: ["test/setup/no-live-remote.ts", `test/${SLUG}.test.ts`],
    acceptance: [{ claim: "the scratch switch is isolated", proof: `unit test: test/${SLUG}.test.ts` }],
    ...overrides,
  };
}

test("test/every-lint-pass-sizes-a-shard-by-its-own-slug.test.ts: all lint passes agree", () => {
  const task = fixture();
  const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) };
  const scoped = lintPlan(plan, () => ({ duplicateSlug: SLUG }), new Set([task.id]));
  const whole = lintPlan(plan);
  const sizing = (result: ReturnType<typeof lintTask>) => result.violations.filter((v) => v.check === "sizing");

  assert.deepEqual(sizing(scoped.get(task.id)!), [], "control: the scoped pass discounts its own test");
  assert.deepEqual(sizing(whole.get(task.id)!), sizing(scoped.get(task.id)!));
  assert.deepEqual(sizing(lintTask(task, { proofResolvability: "warn" })), []);
});

test("the path fallback keeps unrelated tests as concerns and explicit slugs take precedence", () => {
  const task = fixture({ files: ["src/lib/foo.ts", "test/unrelated.test.ts"] });
  assert.equal(sizingViolation(task)?.severity, "block");
  assert.equal(sizingViolation(task, { duplicateSlug: " UNRELATED " }), undefined);
  assert.equal(sizingViolation(fixture(), { duplicateSlug: "different-slug" })?.severity, "block");
  assert.equal(sizingViolation(fixture(), { duplicateSlug: " " }), undefined);
  assert.equal(sizingViolation(fixture({ sourcePath: `plan/tasks.d/W1-T5631-${SLUG}.yml` })), undefined);
});

test("tasks without a shard path retain the existing sizing behavior", () => {
  for (const sourcePath of [undefined, "plan/tasks.yaml"]) {
    assert.equal(sizingViolation(fixture({ sourcePath }))?.severity, "block");
    assert.equal(sizingViolation(fixture({ sourcePath }), { duplicateSlug: SLUG }), undefined);
  }
  assert.equal(sizingViolation(fixture({ risk: "high", band_meaning: "span" })), undefined);
  assert.equal(sizingViolation(fixture({ files: ["src/lib/foo.ts", "src/lib/bar.ts", `test/${SLUG}.test.ts`] }))?.severity, "block");
  assert.equal(lintTask(fixture()).violations.some((v) => v.check === "duplicate-title"), false);
});
