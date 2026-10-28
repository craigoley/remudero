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

import { CI_FRICTION_REMEDIES_FILE, ciFrictionRemedyTestTitle, ciFrictionShardStem, ciFrictionShardYaml } from "#src/lib/ci-friction-gardener.js";
import { lintTask, sizingViolation } from "#src/lib/task-linter.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, newTestPath } from "#src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function admit(yaml: string, pathExists = (p: string) => existsSync(join(REPO_ROOT, p))): string[] {
  const plan = loadPlanFromYaml(yaml, "ci-friction-fixture");
  return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists });
}

test("a ci-friction remedy naming its owning code and a new regression test is admitted as a parked proposal", () => {
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "fixture-never-built" }, minutes: 12, rounds: 3, prs: 2 }, rung: 1, owner: { files: ["src/run-task.ts"], why: [] }, rounds: [] },
    "W1-T99999",
  );
  const files = loadPlanFromYaml(yaml, "x").tasks[0]!.files;
  assert.deepEqual(files, ["src/run-task.ts", newTestPath("check-fixture-never-built", ["src/run-task.ts"], "ci-friction-gardener")]);
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
  assert.match(reasons, /exist in neither the checkout nor the base tree: test\/[\w-]+\/check-x\.test\.ts/);
});

test("the legacy docs-only ci-friction shard still files, so existing records keep admitting", () => {
  const legacy = [
    "- id: W1-T99996", '  title: "legacy"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", "  risk: low",
    "  status: queued", "  attempts: 0", "  author_class: machine", '  origin: "ci-friction:check:reviewer-unmet"', "  files:", `    - ${CI_FRICTION_REMEDIES_FILE}`,
    "  acceptance:", '    - claim: "c"', `      proof: "grep: ci-friction:check:reviewer-unmet in ${CI_FRICTION_REMEDIES_FILE}"`, "",
  ].join("\n");
  assert.deepEqual(admit(legacy), []);
});

test("a drafted remedy passes the base linter's sizing and admission checks with an executable proof its build must pass", () => {
  const key = "check:ci-log:coverage-ratchet";
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "ci-log:coverage-ratchet" }, minutes: 1441, rounds: 457, prs: 291 }, rung: 1, owner: { files: ["src/lib/ci-parity.ts", "src/run-task.ts"], why: ["a", "b"] }, rounds: [] },
    "W1-T99995",
  );
  const plan = loadPlanFromYaml(yaml, "x");
  const task = plan.tasks[0]!;
  const stem = ciFrictionShardStem(key);
  const testPath = newTestPath(stem, ["src/lib/ci-parity.ts"], "ci-friction-gardener");
  assert.deepEqual(task.files, ["src/lib/ci-parity.ts", testPath], "one owner file plus a test named for the shard, in its computed folder");
  assert.equal(sizingViolation(task, { duplicateSlug: stem }), undefined, "the test is the shard's own falsifier, so the span is one concern");
  const proof = task.acceptance?.[0]?.proof ?? "";
  assert.equal(proof, `unit test: ${ciFrictionRemedyTestTitle("W1-T99995", key)}`);
  assert.equal(proof.split(" in ").length, 1, "the executable title has no grep path delimiter");
  assert.equal(ciFrictionRemedyTestTitle("W1-T1", "check:pass in ci"), "W1-T1: check:pass within ci is prevented, not retried");
  const lint = lintTask(task, { duplicateSlug: stem, machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block"), []);
});

test("a long measured cause gets an executable proof admitted by the unchanged plan policy", () => {
  const name = "ci-log:coverage-ratchet:diff-coverage-blocked-this-diff-adds-source-line-s-with-zero";
  const key = `check:${name}`;
  const yaml = ciFrictionShardYaml({ price: { cause: { kind: "check", name }, minutes: 1441, rounds: 457, prs: 291 },
    rung: 1, owner: { files: ["src/lib/ci-parity.ts"], why: ["real diff-coverage refusal"] }, rounds: [] }, "W1-T99990");
  const plan = loadPlanFromYaml(yaml, "long measured cause");
  const task = plan.tasks[0]!;
  const verdict = lintTask(task, { duplicateSlug: ciFrictionShardStem(key),
    machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: p => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(verdict.violations.filter(v => v.severity === "block"), [], "the actual rendered task must file");
  assert.equal(task.acceptance![0]!.proof, `unit test: ${ciFrictionRemedyTestTitle(task.id, key)}`);
  assert.ok(task.origin?.includes(key), "the full measured cause is retained in provenance");
  assert.ok(JSON.stringify(task.rationale).includes(key), "compacting a test title does not discard diagnosis");
});


test("a census remedy proves its diagnosed mechanism while retaining healthy refusals and measured costs", () => {
  const owner = "src/lib/ci-friction-remedy.ts";
  const cause = { kind: "fix_refusal" as const, name: "census-precheck" };
  const key = "fix_refusal:census-precheck";
  const price = { cause, minutes: 6, rounds: 2, prs: 2 };
  const details = ["census-precheck: this branch grows 1 census count(s) CI will refuse: fixture-copy: real branch finding",
    "census-precheck: census snapshot reader crashed"];
  const rounds = details.map((detail, index) => ({ pr: 13000 + index, causeKey: key, minutes: 3,
    at: "2026-10-26T12:00:00Z", detail }));
  const retained = JSON.stringify({ price, rounds });
  const yaml = ciFrictionShardYaml({ price, rung: 1, owner: { files: [owner], why: ["concrete runner signature"] }, rounds }, "W1-T99989");
  const task = loadPlanFromYaml(yaml, "census mechanism contract").tasks[0]!;
  assert.equal(task.acceptance![0]!.claim, `the diagnosed census runner failure owned by ${owner} is prevented or self-healed while healthy branch findings still refuse publication`);
  assert.equal(task.acceptance![0]!.proof, "unit test: W1-T99989: the diagnosed census runner failure is prevented while healthy findings remain refused");
  assert.match(task.note!, /execute the diagnosed failure through the real owner path/);
  assert.match(task.note!, /retain a control that a healthy branch finding is still refused/);
  assert.match(task.note!, /class-wide cost observations and after-window measurement remain unchanged/);
  assert.ok(details.every(detail => task.rationale!.includes(detail)));
  assert.equal(JSON.stringify({ price, rounds }), retained);
  assert.equal(task.verify, "human");
  assert.ok(task.origin!.includes(key));
  const plan = loadPlanFromYaml(yaml, "census mechanism admission");
  assert.deepEqual(lintTask(task, { duplicateSlug: ciFrictionShardStem(key), machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: p => existsSync(join(REPO_ROOT, p)) } }).violations.filter(v => v.severity === "block"), []);
  for (const name of ["other-refusal", "census-precheck-other"]) {
    const other = loadPlanFromYaml(ciFrictionShardYaml({ price: { ...price, cause: { ...cause, name } }, rung: 1,
      owner: { files: [owner], why: [] }, rounds: [] }, "W1-T99988"), "unrelated contract").tasks[0]!;
    assert.equal(other.acceptance![0]!.claim, `the harness no longer spends a fix round on fix_refusal:${name}`);
    assert.equal(other.acceptance![0]!.proof, `unit test: W1-T99988: fix_refusal:${name} is prevented, not retried`);
  }
});
