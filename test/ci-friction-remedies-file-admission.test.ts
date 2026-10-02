/**
 * Machine-filing admission (W1-T3843) runs on every filing PR's `rmd lint-plan --base`. Until
 * 2026-10-02 the only ci-friction shape it admitted was one docs file nothing reads, so every remedy
 * the gardener filed was built as a paragraph (#8302 #8476 #8507 #8514 #8544 #8546). A remedy now
 * names the code that owns its cause and the regression test its build writes — a path that cannot
 * exist yet — and admission must take it as a parked proposal, as it does the legacy shape.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CI_FRICTION_REMEDIES_FILE, ciFrictionRemedyTestTitle, ciFrictionShardStem, ciFrictionShardYaml } from "../src/lib/ci-friction-gardener.js";
import { lintTask, sizingViolation } from "../src/lib/task-linter.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function admit(yaml: string, pathExists = (p: string) => existsSync(join(REPO_ROOT, p))): string[] {
  const plan = loadPlanFromYaml(yaml, "ci-friction-fixture");
  return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists });
}

test("a ci-friction remedy naming its owning code and a new regression test is admitted as a parked proposal", () => {
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "reviewer-unmet" }, minutes: 12, rounds: 3, prs: 2 }, rung: 1, owner: { files: ["src/run-task.ts"], why: [] }, rounds: [] },
    "W1-T99999",
  );
  const files = loadPlanFromYaml(yaml, "x").tasks[0]!.files;
  assert.deepEqual(files, ["src/run-task.ts", "test/check-reviewer-unmet.test.ts"]);
  assert.equal(existsSync(join(REPO_ROOT, files[1]!)), false, "the regression test does not exist before the build writes it");
  assert.deepEqual(admit(yaml), []);
});

test("an invented source path is still refused, and a remedy with no owning code is not a parked shape", () => {
  const invented = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "x" }, minutes: 1, rounds: 1, prs: 1 }, rung: 1, owner: { files: ["src/lib/no-such-module.ts"], why: [] }, rounds: [] },
    "W1-T99998",
  );
  assert.match(admit(invented).join("; "), /exist in neither the checkout nor the base tree: src\/lib\/no-such-module\.ts$/);
  const testOnly = invented.replace("    - src/lib/no-such-module.ts\n", "");
  const reasons = admit(testOnly).join("; ");
  assert.match(reasons, /verify:human — not auto-runnable/);
  assert.match(reasons, /exist in neither the checkout nor the base tree: test\/check-x\.test\.ts/);
});

test("the legacy docs-only ci-friction shard still files, so existing records keep admitting", () => {
  const legacy = [
    "- id: W1-T99996", '  title: "legacy"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", "  risk: low",
    "  status: queued", "  attempts: 0", "  author_class: machine", '  origin: "ci-friction:check:reviewer-unmet"', "  files:", `    - ${CI_FRICTION_REMEDIES_FILE}`,
    "  acceptance:", '    - claim: "c"', `      proof: "grep: ci-friction:check:reviewer-unmet in ${CI_FRICTION_REMEDIES_FILE}"`, "",
  ].join("\n");
  assert.deepEqual(admit(legacy), []);
});

test("a drafted remedy passes the base linter's sizing and admission checks with a grep proof its build makes true", () => {
  const key = "check:ci-log:coverage-ratchet";
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "ci-log:coverage-ratchet" }, minutes: 1441, rounds: 457, prs: 291 }, rung: 1, owner: { files: ["src/lib/ci-parity.ts", "src/run-task.ts"], why: ["a", "b"] }, rounds: [] },
    "W1-T99995",
  );
  const plan = loadPlanFromYaml(yaml, "x");
  const task = plan.tasks[0]!;
  const stem = ciFrictionShardStem(key);
  assert.deepEqual(task.files, ["src/lib/ci-parity.ts", `test/${stem}.test.ts`], "one owner file plus a test named for the shard");
  assert.equal(sizingViolation(task, { duplicateSlug: stem }), undefined, "the test is the shard's own falsifier, so the span is one concern");
  const proof = task.acceptance?.[0]?.proof ?? "";
  assert.equal(proof, `grep: test("${ciFrictionRemedyTestTitle("W1-T99995", key)}" in test/${stem}.test.ts`);
  assert.equal(proof.split(" in ").length, 2, "the title never splits the proof's path");
  assert.equal(ciFrictionRemedyTestTitle("W1-T1", "check:pass in ci"), "W1-T1: check:pass within ci is prevented, not retried");
  const lint = lintTask(task, { duplicateSlug: stem, machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block"), []);
});
