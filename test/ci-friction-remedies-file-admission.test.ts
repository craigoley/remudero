/**
 * Machine-filing admission (W1-T3843) runs on every filing PR's `rmd lint-plan --base`. Until
 * 2026-10-02 the only ci-friction shape it admitted was one docs file nothing reads, so every remedy
 * the gardener filed was built as a paragraph (#8302 #8476 #8507 #8514 #8544 #8546). A remedy now
 * names the code that owns its cause and the regression test its build writes — a path that cannot
 * exist yet — and admission must take it as a parked proposal, as it does the legacy shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CI_FRICTION_REMEDIES_FILE, ciFrictionRemedyTestTitle, ciFrictionShardStem, ciFrictionShardYaml } from "#src/lib/ci-friction-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";
import { assertLintClean, lintTask, sizingViolation, taskRulingPin } from "#src/lib/task-linter.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, newPathApprovalIntentDigest, newTestPath, type NewPathApprovalFacts, type Task } from "#src/lib/plan.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

test("a drafted remedy passes the base linter's sizing and admission checks with a grep proof its build makes true", () => {
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
  assert.equal(proof, `grep: test("${ciFrictionRemedyTestTitle("W1-T99995", key)}" in ${testPath}`);
  assert.equal(proof.split(" in ").length, 2, "the title never splits the proof's path");
  assert.equal(ciFrictionRemedyTestTitle("W1-T1", "check:pass in ci"), "W1-T1: check:pass within ci is prevented, not retried");
  const lint = lintTask(task, { duplicateSlug: stem, machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block"), []);
});

const APPROVAL_RECORD_PATH = "plan/tasks.d/W1-T99001-approved-new-path.yaml";
const APPROVAL_REFERENCE = `npa1_${"A".repeat(43)}`;

function approvalFixture(mode: "human" | "auto" = "human") {
  const plan = loadPlanFromYaml([
    "- id: W1-T99001", "  title: Create the explicitly approved fixture module", "  repo: remudero",
    "  depends_on: []", "  type: implement", "  verify: human", "  risk: medium", "  status: queued",
    "  attempts: 0", "  author_class: machine", "  files: [src/lib/operator-approved-fixture.ts]",
    "  design: Exact approved fixture behavior", "  rationale: A fixture, not an issued approval",
  ].join("\n"), APPROVAL_RECORD_PATH);
  const task = Object.assign(plan.tasks[0]!, { new_path_approval_ref: APPROVAL_REFERENCE });
  if (mode === "auto") {
    task.verify = "auto";
    task.acceptance = [{ claim: "The approved fixture is created", proof: "unit test: approved fixture behavior" }];
    task.risk_ruling = { verdict: "operator", action: "proceed", confidence: 1, reasons: ["fixture-only approval"],
      judged_at: "2026-10-23T00:00:00Z", pin: taskRulingPin(task) };
  }
  const binding = {
    issuerId: "fixture-issuer", origin: "https://fixture.invalid", epoch: "fixture-epoch-1", policy: "new-path-approval-v1",
    repositoryId: 7, repository: "acme/remudero", instance: "fixture-core", audience: "fixture-filer",
  };
  // Independent protocol fixture: sourcePath binds the canonical destination, not a host's
  // temporary checkout prefix. The reference alone is excluded to avoid signing itself.
  const canonicalTask = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
  delete canonicalTask.new_path_approval_ref;
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const serialized = JSON.stringify(value);
    assert.ok(serialized !== undefined, "the protocol fixture contains only JSON values");
    return serialized;
  };
  const intentDigest = createHash("sha256").update("remudero:new-path-approval-v1:task-intent\0").update(
    stable({ protocol: "new-path-approval-v1", recordPath: APPROVAL_RECORD_PATH, task: canonicalTask }),
  ).digest("hex");
  const record = {
    protocol: "new-path-approval-v1" as const, reference: APPROVAL_REFERENCE, binding, taskId: task.id, taskRepo: task.repo,
    intentDigest, recordPath: APPROVAL_RECORD_PATH, declaredPaths: [...task.files!], approvedMissingPaths: [...task.files!],
    operatorId: "operator:fixture-user", confirmationId: "fixture-confirmation", issuedAt: 1_000, expiresAt: 2_000,
  };
  const facts = {
    state: "verified" as const, reference: APPROVAL_REFERENCE, binding, record, observedAt: 1_200,
    currentSourcePath: task.sourcePath!, recordPath: APPROVAL_RECORD_PATH,
    paths: { "src/lib/operator-approved-fixture.ts": { checkout: "missing" as const, base: "missing" as const } },
  };
  const context = {
    plan, releasedIds: new Set([task.id]), pathExists: () => false, pathExistsAtBase: () => false,
    clock: fixedClock(1_200), newPathApproval: facts,
  };
  return { plan, task, context, facts, record };
}

test("new path admission binds the explicit approval to the exact task and declared paths", () => {
  const { task, context } = approvalFixture();
  assert.deepEqual(machineFilingAdmissionViolations(task, context), [], "qualified facts admit only the explicitly approved missing path");
  for (const changed of [
    { ...task, id: "W1-T99002" }, { ...task, repo: "other-repo" },
    { ...task, design: "Different requested behavior" }, { ...task, rationale: "A different justification" },
    { ...task, files: [...task.files!, "src/lib/unapproved-extra.ts"] },
  ]) assert.notDeepEqual(machineFilingAdmissionViolations(changed, context), [], "task or full intent drift must not inherit permission");
});

test("new path admission agrees between the real filing precheck and plan lint", () => {
  const { task, context, facts } = approvalFixture("auto");
  const raw = JSON.parse(JSON.stringify(task));
  delete raw.sourcePath;
  const text = JSON.stringify([raw]);
  const paths = { pathExists: () => false, pathExistsAtBase: () => false, clock: context.clock,
    newPathApprovals: new Map([[task.id, facts]]) };
  assert.equal(machineShardFilingRefusal(text, APPROVAL_RECORD_PATH, paths), undefined,
    "the actual maintained precheck receives the same selected facts as plan lint");
  assert.deepEqual(lintTask(task, { machineFilingAdmission: context }).violations.filter(v => v.severity === "block"), []);
  assert.doesNotThrow(() => assertLintClean(task, { machineFilingAdmission: context }));
  for (const approval of [undefined, { state: "unknown" as const, reason: "authority unavailable" },
    { ...facts, record: { ...facts.record, taskId: "W1-T99002" } }]) {
    const selected = new Map<string, NewPathApprovalFacts>();
    if (approval) selected.set(task.id, approval);
    assert.match(machineShardFilingRefusal(text, APPROVAL_RECORD_PATH, { ...paths, newPathApprovals: selected }) ?? "", /new-path approval UNKNOWN/);
    assert.match(lintTask(task, { machineFilingAdmission: { ...context, newPathApproval: approval } }).violations
      .filter(v => v.severity === "block").map(v => v.message).join(";"), /new-path approval UNKNOWN/);
  }
});

test("new path admission preserves legacy proposals and independent owner holds", () => {
  const { task, context } = approvalFixture("auto");
  const pin = taskRulingPin(task);
  assert.equal(taskRulingPin({ ...task, new_path_approval_ref: `npa1_${"B".repeat(43)}` }), pin,
    "the independent receipt does not silently change the legacy ruling pin");
  const withoutApproval = { ...task };
  delete withoutApproval.new_path_approval_ref;
  const legacyContext = { ...context, newPathApproval: undefined, pathExists: () => true,
    clock: { now() { throw new Error("legacy admission must not read the approval clock"); } } };
  assert.deepEqual(machineFilingAdmissionViolations(withoutApproval, legacyContext), []);
  assert.equal(Object.hasOwn(loadPlanFromYaml("- id: W1-T99009\n  title: legacy\n  repo: remudero\n  type: implement\n", "legacy").tasks[0]!, "new_path_approval_ref"), false);
  const held = { ...task, dispatch_hold: true };
  assert.throws(() => assertLintClean(held, { machineFilingAdmission: context }), /dispatch.hold|ruling/i,
    "a path receipt does not release an independent owner hold or re-sign drifted intent");
  assert.notDeepEqual(machineFilingAdmissionViolations({ ...task, status: "blocked" }, context), []);
  assert.notDeepEqual(machineFilingAdmissionViolations({ ...task, depends_on: ["W1-T99002"] }, context), []);
});

test("new path admission refuses missing drifted and unsupported authority before staging", async (t) => {
  await t.test("missing or expired prepared evidence never reaches the staging effect", () => {
    const { task, context, facts, record } = approvalFixture();
    let staged = 0;
    for (const evidence of [undefined, { state: "unknown" as const, reason: "issuer unavailable" },
      { ...facts, record: { ...record, expiresAt: 1_100 } },
      { ...facts, binding: { ...facts.binding, epoch: "replacement-epoch" } },
      { ...facts, paths: { "src/lib/operator-approved-fixture.ts": { checkout: "unknown" as const, base: "missing" as const } } },
    ]) {
      const reasons = machineFilingAdmissionViolations(task, { ...context, newPathApproval: evidence });
      if (reasons.length === 0) staged++;
      assert.match(reasons.join(";"), /new-path approval UNKNOWN:/);
    }
    assert.equal(staged, 0);
  });
  await t.test("an unsupported task cannot match an omitted digest", () => {
    const { task, context, facts, record } = approvalFixture();
    const malformed = { ...task, unsupported: "acted-on-looking data" } as Task;
    const evidence = { ...facts, record: { ...record, intentDigest: undefined } } as unknown as NewPathApprovalFacts;
    assert.notDeepEqual(machineFilingAdmissionViolations(malformed, { ...context, newPathApproval: evidence }), []);
  });
  await t.test("a digest never invokes a nested array accessor", () => {
    const { task } = approvalFixture();
    const files = [...task.files!];
    let invoked = 0;
    Object.defineProperty(files, "0", { enumerable: true, get() { invoked++; return "src/lib/operator-approved-fixture.ts"; } });
    assert.equal(newPathApprovalIntentDigest({ ...task, files }, APPROVAL_RECORD_PATH), undefined);
    assert.equal(invoked, 0, "unsupported data is rejected without executing accessors");
  });
  await t.test("hidden and symbol task fields are unsupported rather than unsigned data", () => {
    const { task } = approvalFixture();
    for (const key of ["hidden", Symbol("hidden")]) {
      const changed = { ...task };
      Object.defineProperty(changed, key, { value: "unsupported", enumerable: false });
      assert.equal(newPathApprovalIntentDigest(changed, APPROVAL_RECORD_PATH), undefined);
    }
  });
  await t.test("selected YAML refuses unsupported fields instead of dropping their bytes", () => {
    const { task } = approvalFixture();
    const raw = JSON.parse(JSON.stringify(task));
    delete raw.sourcePath;
    for (const changed of [{ ...raw, unsupported: "silently lost" }, { ...raw, design: { nested: "lost" } },
      { ...raw, depends_on: "not-a-sequence" }, { ...raw, files: "not-a-sequence" },
      { ...raw, verify: "unsupported" }, { ...raw, sourcePath: "a-spoofed-destination" }]) {
      assert.throws(() => loadPlanFromYaml(JSON.stringify([changed]), APPROVAL_RECORD_PATH), /new.path approval.*unsupported/i);
    }
  });
  await t.test("selected aliases and cyclic input refuse without recursing into detachment", () => {
    const text = `- &task\n  id: W1-T99001\n  title: fixture\n  repo: remudero\n  type: implement\n  new_path_approval_ref: ${APPROVAL_REFERENCE}\n  context: [*task]\n`;
    assert.throws(() => loadPlanFromYaml(text, APPROVAL_RECORD_PATH), /new.path approval.*unsupported/i);
  });
});
