import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";
import { renderGeneratedSubjectTask } from "#src/lib/wipe-test.js";

// Every wipetest.cadence.fired on the core daemon from 2026-09-25 to 2026-10-26 (68 of 68) ended in
// wipetest.cadence.refused: the pre-dispatch linter refused the generated subject `wt-sbx-2` for
// `[provenance] missing origin:`, and the escalation that refusal raised failed on a sandbox repo with issues
// disabled. So no wipe-test pair has been measured since 2026-08-23.
test("W1-T9940: wipetest.cadence.refused no longer recurs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9940-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tasks.d"));
  writeFileSync(join(dir, "tasks.yaml"), "[]\n");
  writeFileSync(
    join(dir, "tasks.d", "wt-sbx-2.yaml"),
    renderGeneratedSubjectTask({ id: "wt-sbx-2", files: ["docs/ci.md"] }, "craigoley/remudero-sandbox"),
  );
  const task = loadPlan(join(dir, "tasks.yaml")).tasks.find((x) => x.id === "wt-sbx-2");
  assert.ok(task, "the rendered subject loads as a plan task");
  const blocking = lintTask(task).violations.filter((v) => v.severity === "block");
  assert.deepEqual(blocking.map((v) => `${v.check}: ${v.message}`), [], "the pre-dispatch linter admits the generated subject");
  assert.match(task.origin ?? "", /wipe-test cadence/);
});
