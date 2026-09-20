import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

const MISSING = "test/w1-t3747-does-not-exist.test.ts";
const PROOF = `unit test: ${MISSING}`;
const gate = (await import(pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts", "acceptance-author-gate.mjs")).href)) as {
  evaluateGate: (input: Record<string, unknown>) => { ok: boolean; defect?: string; message: string };
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3747",
    title: "a credited build must reconcile its declared test path",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    files: ["src/lib/task-linter.ts", MISSING],
    acceptance: [{ claim: "the declared test is present", proof: PROOF }],
    origin: "architect",
    ...over,
  } as Task;
}

function creditedTestPathViolations(t: Task, opts: Parameters<typeof lintTask>[1] = {}) {
  return lintTask(t, opts).violations.filter((violation) => violation.check === "credited-test-path");
}

test("W1-T3747: a credited build with an absent declared test path is refused", () => {
  const violations = creditedTestPathViolations(task(), {
    creditedBuild: true,
    moduleExists: () => false,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.check, "credited-test-path");
  assert.equal(violations[0]?.severity, "block");
  assert.match(violations[0]?.message ?? "", new RegExp(MISSING.replaceAll(".", "\\.")));
  assert.equal(
    lintTask(task(), { creditedBuild: true, moduleExists: () => false }).ok,
    false,
    "the aggregate linter must expose the refusal, not leave the exported check dormant",
  );
});

test("W1-T3747: a credited build whose declared test path shipped passes", () => {
  const shipped = "test/task-linter.test.ts";
  const t = task({ files: ["src/lib/task-linter.ts", shipped], acceptance: [{ claim: "the suite shipped", proof: `unit test: ${shipped}` }] });
  assert.deepEqual(
    creditedTestPathViolations(t, { creditedBuild: true, moduleExists: (path) => path === shipped || path === "src/lib/task-linter.ts" }),
    [],
  );
  assert.equal(
    lintTask(t, { creditedBuild: true, moduleExists: (path) => path === shipped || path === "src/lib/task-linter.ts" }).violations.some((v) => v.check === "credited-test-path"),
    false,
  );
});

test("W1-T3747: a plan-only filing is exempt", () => {
  assert.deepEqual(
    creditedTestPathViolations(task(), {
      creditedBuild: true,
      planOnlyFiling: true,
      moduleExists: () => false,
    }),
    [],
    "a filing may name the test its later implementation will add",
  );
});

test("W1-T3747 wiring: the author-time gate applies the same refusal to a credited trailer", () => {
  const result = gate.evaluateGate({
    body: "Remudero-Task: W1-T3747",
    authorLogin: "a-human",
    trailerResolves: (id: string) => id === "W1-T3747",
    changedPaths: ["src/lib/task-linter.ts", MISSING],
    taskFilesForId: (id: string) => (id === "W1-T3747" ? ["src/lib/task-linter.ts", MISSING] : undefined),
    taskAcceptanceForId: (id: string) => (id === "W1-T3747" ? [{ claim: "the declared test is present", proof: PROOF }] : undefined),
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "credited-test-path");
});
