import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// W1-T3748 — the branch-name credit path asks only which task a PR belongs to, never whether the
// diff covered the scope the record declared. `creditedFileCoverageViolations` gives that second
// question a home in the deterministic linter: on a credited build, every non-plan/ path the task's
// `files:` declares must appear in the diff, or the check names the ones that did not.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3727",
    title: "retro and alert_fix stop dead under a squeeze",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    // risk:high, not medium: the real W1-T3727 shape spans two subsystems (run-task, worker),
    // which is `sizingViolation`'s own concern (Rule 19) at risk:medium — a different check this
    // fixture must not also trip, so the "ok" assertions below isolate credited-file-coverage.
    risk: "high",
    status: "queued",
    attempts: 0,
    files: ["src/lib/worker.ts", "src/run-task.ts"],
    acceptance: [{ claim: "both lanes recover", proof: "unit test: alert_fix and retro both resume" }],
    origin: "architect",
    ...over,
  } as Task;
}

function coverageViolations(t: Task, opts: Parameters<typeof lintTask>[1] = {}) {
  return lintTask(t, opts).violations.filter((v) => v.check === "credited-file-coverage");
}

test("W1-T3748: a credited diff reports its uncovered declared files", () => {
  // PR #5941's real shape: W1-T3727 declared src/lib/worker.ts AND src/run-task.ts, and the build
  // that merged touched only the first.
  const violations = coverageViolations(task(), {
    creditedBuild: true,
    creditedDiffFiles: ["src/lib/worker.ts", "test/worker.test.ts"],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.check, "credited-file-coverage");
  assert.match(violations[0]?.message ?? "", /src\/run-task\.ts/);
  assert.doesNotMatch(violations[0]?.message ?? "", /src\/lib\/worker\.ts,/, "the touched file must not be reported as uncovered");
});

test("W1-T3748: full coverage reports nothing", () => {
  assert.deepEqual(
    coverageViolations(task(), {
      creditedBuild: true,
      creditedDiffFiles: ["src/lib/worker.ts", "src/run-task.ts", "test/worker.test.ts"],
    }),
    [],
  );
  // Live control, paired: the same task under-covered still fires, so this pass is not vacuous.
  assert.equal(
    coverageViolations(task(), { creditedBuild: true, creditedDiffFiles: ["src/lib/worker.ts"] }).length,
    1,
  );
});

test("W1-T3748: under-coverage is advisory", () => {
  const opts = { creditedBuild: true, creditedDiffFiles: ["src/lib/worker.ts"] } as const;
  const violations = coverageViolations(task(), opts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.severity, "warn", "under-coverage must never be a block, even at first landing");
  assert.equal(
    lintTask(task(), opts).ok,
    true,
    "a WARN-only credited-file-coverage violation must not flip the aggregate linter's ok to false",
  );
});

test("absent creditedDiffFiles leaves the check silent", () => {
  assert.deepEqual(coverageViolations(task(), { creditedBuild: true }), []);
});

test("a plan-only filing is exempt, same contract as credited-test-path", () => {
  assert.deepEqual(
    coverageViolations(task(), {
      creditedBuild: true,
      planOnlyFiling: true,
      creditedDiffFiles: ["src/lib/worker.ts"],
    }),
    [],
  );
});

test("a declared plan/ path is never reported as uncovered", () => {
  const t = task({ files: ["src/lib/worker.ts", "plan/tasks.d/w1-t3727.yaml"] });
  assert.deepEqual(
    coverageViolations(t, { creditedBuild: true, creditedDiffFiles: ["src/lib/worker.ts"] }),
    [],
  );
});

test("an uncredited (queued, non-build) task is silent regardless of coverage", () => {
  assert.deepEqual(coverageViolations(task(), { creditedDiffFiles: ["src/lib/worker.ts"] }), []);
});
