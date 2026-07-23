import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TASK_CLASS, deriveTaskClass } from "../src/lib/task-class.js";

test("deriveTaskClass: an all-docs files list classifies as 'docs'", () => {
  assert.equal(deriveTaskClass({ files: ["docs/operator-guide.md"] }), "docs");
  assert.equal(deriveTaskClass({ files: ["README.md", "CHANGELOG.md"] }), "docs");
  assert.equal(deriveTaskClass({ files: ["learnings/index.yaml"] }), "docs");
});

test("deriveTaskClass: an all-plan-machinery files list classifies as 'plan-lint'", () => {
  assert.equal(deriveTaskClass({ files: ["plan/tasks.yaml"] }), "plan-lint");
});

test("deriveTaskClass: a plan/*.md file is plan-lint, not docs (plan-lint checked first)", () => {
  assert.equal(deriveTaskClass({ files: ["plan/notes.md"] }), "plan-lint");
});

test("deriveTaskClass: a src file (or any non-doc/plan path) classifies as the DEFAULT class ('src')", () => {
  assert.equal(deriveTaskClass({ files: ["src/lib/mounts.ts"] }), DEFAULT_TASK_CLASS);
  assert.equal(deriveTaskClass({ files: [] }), DEFAULT_TASK_CLASS);
  assert.equal(deriveTaskClass({}), DEFAULT_TASK_CLASS);
});

test("deriveTaskClass: a MIXED files list (docs + src) is never cheapened — falls back to 'src'", () => {
  assert.equal(deriveTaskClass({ files: ["docs/operator-guide.md", "src/lib/mounts.ts"] }), DEFAULT_TASK_CLASS);
});
