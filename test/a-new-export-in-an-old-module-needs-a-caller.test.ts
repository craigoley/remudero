import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPlan, type Task } from "../src/lib/plan.js";
import { addedExportsFromPatch, callSiteViolations, lintTask, type AddedExport } from "../src/lib/task-linter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE: Task = {
  id: "W1-T3218-FIXTURE",
  title: "a task that adds an export to an existing module",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  verify: "auto",
  files: ["src/lib/existing.ts"],
  acceptance: [],
} as never;

const allModulesExist = () => true;
const addedExport: AddedExport = { path: "src/lib/existing.ts", symbol: "newReader" };
const presentAtBase = (path: string) => path !== "src/lib/new-module.ts";

function withProofs(proofs: string[]): Task {
  return { ...BASE, acceptance: proofs.map((proof, i) => ({ claim: `c${i}`, proof })) } as never;
}

function opts(exports: readonly AddedExport[] = [addedExport]) {
  return { moduleExists: allModulesExist, addedExports: exports };
}

test("new export in existing src module without a call-site criterion is reported", () => {
  const task = withProofs(["unit test: new reader is covered"]);

  const v = callSiteViolations(task, opts());

  assert.equal(v.length, 1);
  assert.equal(v[0].check, "call-site");
  assert.equal(v[0].severity, "warn");
  assert.match(v[0].message, /new exported value/);
  assert.match(v[0].message, /newReader/);
});

test("new export in existing src module with a src call-site criterion is not reported", () => {
  const task = withProofs(["grep: newReader( in src/lib/consumer.ts"]);

  assert.deepEqual(callSiteViolations(task, opts()), []);
});

test("new export in existing src module is not satisfied by a test-only caller", () => {
  const task = withProofs(["grep: newReader( in test/existing.test.ts"]);

  const v = callSiteViolations(task, opts());

  assert.equal(v.length, 1);
  assert.match(v[0].message, /test\/existing\.test\.ts/);
});

test("editing an existing exported value without adding one is not reported", () => {
  const task = withProofs(["unit test: existing export still works"]);

  assert.deepEqual(callSiteViolations(task, opts([])), []);
});

test("diff predicate names only added exports in existing src modules", () => {
  const diff = [
    "diff --git a/src/lib/existing.ts b/src/lib/existing.ts",
    "+++ b/src/lib/existing.ts",
    "@@",
    " export function oldReader() {}",
    "+export function newReader() {}",
    "+export const newValue = 1;",
    "+export class NewThing {}",
    "+const privateValue = 2;",
    "diff --git a/src/lib/new-module.ts b/src/lib/new-module.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/lib/new-module.ts",
    "@@",
    "+export function moduleEntry() {}",
  ].join("\n");

  assert.deepEqual(addedExportsFromPatch(diff, presentAtBase), [
    { path: "src/lib/existing.ts", symbol: "newReader" },
    { path: "src/lib/existing.ts", symbol: "newValue" },
    { path: "src/lib/existing.ts", symbol: "NewThing" },
  ]);
});

test("W1-T3206 real files and criteria are reported by the new-export arm", () => {
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  const task = plan.byId.get("W1-T3206");
  assert.ok(task, "fixture task exists");

  const result = lintTask(task, {
    moduleExists: allModulesExist,
    addedExports: [{ path: "src/lib/plan.ts", symbol: "releasedTaskIds" }],
  });

  assert.ok(result.violations.some((v) => v.check === "call-site" && /releasedTaskIds/.test(v.message)));
});
