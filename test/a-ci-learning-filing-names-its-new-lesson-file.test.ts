import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlanFromYaml, machineFilingAdmissionViolations, type Task } from "#src/lib/plan.js";

const LESSON = "learnings/ci.d/ci-learning-12305-scan-pr-osv-scan.yaml";

function filing(overrides: Partial<Task> = {}): string[] {
  const plan = loadPlanFromYaml(`- id: W1-T10016
  title: A ci-learning lesson
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  status: queued
  attempts: 0
  author_class: machine
  origin: ci-learning:12305:scan-pr / osv-scan
  files: [${LESSON}]
`, "ci-learning-admission");
  const task = plan.tasks[0]!;
  Object.assign(task, overrides);
  return machineFilingAdmissionViolations(task, {
    plan,
    releasedIds: new Set(),
    isMerged: () => false,
    pathExists: () => false,
    pathExistsAtBase: () => false,
  });
}

test("W1-T10027: a ci-learning filing naming its own new lesson file is admitted", () => {
  assert.deepEqual(filing(), []);
});

test("W1-T10027: a ci-learning filing naming a missing src path is still refused", () => {
  const reasons = filing({ files: ["src/lib/missing-lesson.ts"] });
  assert.ok(reasons.some(reason => reason.includes("verify:human — not auto-runnable")));
  assert.ok(reasons.some(reason => reason.includes(
    "exist in neither the checkout nor the base tree: src/lib/missing-lesson.ts",
  )));
});

test("W1-T10027: a second declared path prevents the new lesson exemption", () => {
  for (const files of [[LESSON, "src/lib/missing.ts"], [LESSON, "learnings/ci.d/another.yaml"]]) {
    const reasons = filing({ files });
    assert.ok(reasons.some(reason => reason.includes("verify:human — not auto-runnable")));
    assert.ok(reasons.some(reason => reason.includes(`exist in neither the checkout nor the base tree: ${files.join(", ")}`)));
  }
});

test("W1-T10027: only the exact new lesson path shape is exempt", () => {
  for (const path of ["learnings/ci.yaml", "learnings/ci.d/Bad.yaml", "learnings/ci.d/a--b.yaml",
    "learnings/ci.d/a.yml", "learnings/ci.d/sub/a.yaml", "learnings/ci.d/../a.yaml"]) {
    assert.ok(filing({ files: [path] }).some(reason => reason.includes(
      `exist in neither the checkout nor the base tree: ${path}`,
    )), path);
  }
});

test("W1-T10027: other origins do not gain a new lesson exemption", () => {
  for (const origin of ["ci-friction:scan", "scout:scan", "unknown:scan"]) {
    assert.ok(filing({ origin }).some(reason => reason.includes(
      `exist in neither the checkout nor the base tree: ${LESSON}`,
    )), origin);
  }
});

test("W1-T10027: only a parked ci-learning proposal gains the exemption", () => {
  for (const overrides of [{ verify: "auto" }, { status: "blocked" }, { depends_on: ["W1-T99999"] }] satisfies Partial<Task>[]) {
    assert.ok(filing(overrides).some(reason => reason.includes(
      `exist in neither the checkout nor the base tree: ${LESSON}`,
    )), JSON.stringify(overrides));
  }
});
