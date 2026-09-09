/**
 * W1-T3235 — the whole-plan lint scopes "open" by the CREDIT PROJECTION, not by `status:`.
 *
 * MEASURED on origin/main 2026-09-09: `rmd lint-plan` reported 172 open failing, of which 169 had
 * a merged implementation — and the three with none did not survive contact either (W1-T2 shipped
 * as PR #18 before trailers existed; W1-T326 is an operator ruling, open because nobody has ruled;
 * W1-T49 is docs coherence). `status:` is what the FILING wrote and nothing updates it on merge,
 * while the credit projection is this repo's only completion signal — so asking the wrong field
 * manufactured a 156-record landmine field out of finished work.
 *
 * THIS CHANGES WHICH TASKS ARE CHECKED, NOT HOW ANY CHECKED TASK IS GRADED. No severity, exit code
 * or reported violation moves, which is why W1-T2339's refusal to soften the GATE is untouched.
 *
 * The three cases below are the population this must separate: a credited record that should drop
 * out, an uncredited one that must NOT (or the narrower scope hides real work — strictly worse
 * than the noise it removes), and an unresolvable projection, which must fall back to `status:`
 * and SAY SO rather than silently narrow.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A task with a DIRTY proof, so it is a failing open task unless the scope drops it. */
function failingTask(id: string, status: string): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  files: [test/lint-plan-scopes-open-by-credit-not-status.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "the existing suite passes unchanged, verified by hand"',
    "",
  ].join("\n");
}

function buildFixture(body: string): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t3235-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(tasksPath, body, "utf8");
  return { tasksPath, dir };
}

async function runLintPlan(
  tasksPath: string,
  deps: Parameters<typeof lintPlanCommand>[1],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const [oL, oE, oW] = [console.log, console.error, console.warn];
  console.log = (m: string) => logs.push(m);
  console.error = (m: string) => errs.push(m);
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(["--plan", tasksPath], deps);
    return { exitCode, stdout: logs.join("\n"), stderr: errs.join("\n") };
  } finally {
    console.log = oL;
    console.error = oE;
    console.warn = oW;
  }
}

/** A projection where `credited` are merged and everything else is not. */
function projectionDeps(credited: readonly string[]): Parameters<typeof lintPlanCommand>[1] {
  return {
    loadConfig: (() => ({ root: "/synthetic" })) as never,
    resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
    ghGateway: (() => ({})) as never,
    projectPlan: ((plan: { tasks: { id: string }[] }) =>
      new Map(plan.tasks.map((t) => [t.id, { merged: credited.includes(t.id) }]))) as never,
  };
}

test("W1-T3235: a credited-merged task is out of scope even with status queued", async () => {
  const { tasksPath, dir } = buildFixture(failingTask("FIX-SHIPPED", "queued") + failingTask("FIX-REALLY-OPEN", "queued"));
  try {
    const { exitCode, stdout, stderr } = await runLintPlan(tasksPath, projectionDeps(["FIX-SHIPPED"]));

    // The shipped record is not merely hidden from the count — it is never checked, so its
    // violations do not print. That is the difference between a quieter report and a correct scope.
    assert.doesNotMatch(stderr, /FIX-SHIPPED/, "a credited-merged record must not be linted at all");
    assert.match(stderr, /FIX-REALLY-OPEN/, "the genuinely open failing task must still print");
    assert.match(stdout, /1 task\(s\) checked \(open tasks only\)/, "exactly one task is in scope");
    assert.match(stdout, /scoped by credit/, "the summary must name the key it used");
    assert.match(stdout, /1 status-open record\(s\) excluded as already credited merged/);
    assert.equal(exitCode, 1, "the one real failure still exits non-zero — this is not a quieter no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3235: an uncredited task is still checked", async () => {
  const { tasksPath, dir } = buildFixture(failingTask("FIX-REALLY-OPEN", "queued"));
  try {
    // Nothing is credited. A scope that dropped this would hide real work, which is strictly worse
    // than the over-report it replaces.
    const { exitCode, stdout, stderr } = await runLintPlan(tasksPath, projectionDeps([]));
    assert.match(stderr, /FIX-REALLY-OPEN/);
    assert.match(stdout, /1 task\(s\) checked \(open tasks only\)/);
    assert.match(stdout, /scoped by credit: 0 status-open record\(s\) excluded/);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3235: an unresolvable projection falls back to status and says so", async () => {
  const { tasksPath, dir } = buildFixture(failingTask("FIX-SHIPPED", "queued") + failingTask("FIX-REALLY-OPEN", "queued"));
  try {
    const { exitCode, stdout, stderr } = await runLintPlan(tasksPath, {
      loadConfig: (() => ({ root: "/synthetic" })) as never,
      resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
      ghGateway: (() => ({})) as never,
      projectPlan: (() => {
        throw new Error("gh unauthenticated");
      }) as never,
    });

    // FAIL OPEN: today's behaviour byte for byte — BOTH status-open tasks are checked.
    assert.match(stdout, /2 task\(s\) checked \(open tasks only\)/, "an outage must not narrow the scope");
    assert.match(stderr, /FIX-SHIPPED/);
    assert.match(stderr, /FIX-REALLY-OPEN/);

    // ...and it must SAY the count over-reports. A run that silently changes what its own number
    // means between invocations is the defect this task exists to remove, not a smaller version
    // of it.
    assert.match(stdout, /scoped by status/);
    assert.match(stdout, /UNRESOLVABLE/);
    assert.match(stdout, /OVER-reports/);
    assert.doesNotMatch(stdout, /excluded as already credited merged/, "no exclusion may be claimed without a projection");
    assert.equal(exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
