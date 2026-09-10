/**
 * W1-T3336 — a filing-time ruling is useful only if it survives the plan persistence boundary.
 *
 * W1-T2977 proved the linter with hand-built Task objects. W1-T3143 proved the producer's returned
 * object. Neither suite serialized a ruling to YAML and loaded it through plan.ts, where the field
 * was dropped. Every case here starts with YAML and drives the real consumer after loading.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { loadPlanFromYaml, PlanError, type Task } from "../src/lib/plan.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";

const baseRecord = (): Record<string, unknown> => ({
  id: "W1-TFIXTURE",
  title: "a machine-filed lesson",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  verify: "auto",
  risk: "medium",
  status: "queued",
  attempts: 0,
  author_class: "machine",
  origin: "test#persisted-risk-ruling",
  files: ["src/lib/x.ts", "test/x.test.ts"],
  acceptance: [{ claim: "the lesson reaches the worker", proof: "grep: lesson in learnings/ci-gate-lessons.yaml" }],
});

function load(record: Record<string, unknown>): Task {
  return loadPlanFromYaml(stringifyYaml([record]), "persisted-risk-ruling-fixture").tasks[0];
}

function validRuling(record: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const task = load(record);
  return {
    verdict: "low",
    action: "proceed",
    confidence: 0.91,
    reasons: ["the declared change is one bounded learning entry"],
    judged_at: "2026-09-10T15:00:00.000Z",
    pin: taskRulingPin(task),
    ...over,
  };
}

test("W1-T3336: a pinned proceed ruling survives plan YAML and clears the real machine-author gate", () => {
  const record = baseRecord();
  const riskRuling = validRuling(record);
  const loaded = load({ ...record, risk_ruling: riskRuling });

  assert.deepEqual(loaded.risk_ruling, riskRuling, "the loader must preserve every recorded judge field");
  assert.equal(
    machineAuthorVerifyViolation(loaded),
    undefined,
    "the persisted, matching proceed ruling must reach and clear the real consumer",
  );
});

test("W1-T3336: a persisted escalate ruling survives and blocks with its reasons", () => {
  const record = baseRecord();
  const riskRuling = validRuling(record, {
    verdict: "high",
    action: "escalate",
    confidence: 0.86,
    reasons: ["the proposed lesson rewrites an arming predicate"],
  });
  const loaded = load({ ...record, risk_ruling: riskRuling });

  assert.deepEqual(loaded.risk_ruling, riskRuling);
  const violation = machineAuthorVerifyViolation(loaded);
  assert.ok(violation, "an escalate ruling must remain blocking after persistence");
  assert.match(violation.message, /rewrites an arming predicate/, "the recorded judge reason must reach the refusal");
});

test("W1-T3336: missing is absent while malformed risk rulings fail plan load", async (t) => {
  const record = baseRecord();
  assert.equal(load(record).risk_ruling, undefined, "an omitted optional ruling remains a supported absence");

  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["mapping", "not-a-mapping"],
    ["verdict", { ...validRuling(record), verdict: "   " }],
    ["action", { ...validRuling(record), action: "land" }],
    ["confidence type", { ...validRuling(record), confidence: "0.91" }],
    ["confidence finite", { ...validRuling(record), confidence: Number.NaN }],
    ["confidence lower bound", { ...validRuling(record), confidence: -0.01 }],
    ["confidence upper bound", { ...validRuling(record), confidence: 1.01 }],
    ["reasons list", { ...validRuling(record), reasons: "safe" }],
    ["reason element", { ...validRuling(record), reasons: ["safe", 7] }],
    ["judged_at", { ...validRuling(record), judged_at: "" }],
    ["pin", { ...validRuling(record), pin: "ABC123" }],
  ];

  for (const [name, riskRuling] of malformed) {
    await t.test(name, () => {
      assert.throws(
        () => load({ ...record, risk_ruling: riskRuling }),
        (error: unknown) =>
          error instanceof PlanError && /W1-TFIXTURE/.test(error.message) && /risk_ruling/.test(error.message),
        "a present malformed ruling must be named and rejected, never erased into absence",
      );
    });
  }
});

test("W1-T3336: a persisted ruling re-blocks when a pin-covered field changes", () => {
  const record = baseRecord();
  const loaded = load({ ...record, risk_ruling: validRuling(record) });
  assert.equal(machineAuthorVerifyViolation(loaded), undefined, "control: the persisted ruling initially matches");

  const changed: Task = { ...loaded, files: [...(loaded.files ?? []), "src/lib/deployer.ts"] };
  const violation = machineAuthorVerifyViolation(changed);
  assert.ok(violation, "changing the judged record must invalidate its persisted ruling");
  assert.match(violation.message, /pin is stale/, "the refusal must name drift rather than inventing a fresh judgment");
});
