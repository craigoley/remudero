import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDefuseShard, type GateGardenAction } from "../src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";
import { scoutShard } from "../src/lib/scout-gardener.js";

const FIXTURE = "test/some-expiring.test.ts";
const symptom = (files: string[]) => ({ step: "ci.some_step_failed", older: 2, newer: 3, total: 5, files });

function violations(text: string, existing: string[]): string[] {
  const plan = loadPlanFromYaml(text, "draft.yaml");
  return machineFilingAdmissionViolations(plan.tasks[0]!, {
    plan, releasedIds: new Set(), pathExists: (p) => existing.includes(p), pathExistsAtBase: () => false,
  });
}

test("W1-T8523: a gate-gardener defuse draft passes machine-filing admission", () => {
  const action: GateGardenAction = {
    class: "defuse", target: `expiring-fixture:${FIXTURE}`, file: FIXTURE, reason: "expires soon",
    edit: { kind: "defuse", leadDays: 14, urgent: false,
      finding: { file: FIXTURE, line: 3, stamp: "2026-11-01", field: "stamp", threshold: "30d", expiresAt: Date.parse("2026-12-01T00:00:00Z"), daysLeft: 10 } },
  } as GateGardenAction;
  const shard = renderDefuseShard(action, "NEW-1");
  assert.equal(shard.refused, undefined);
  assert.deepEqual(violations(shard.text, [FIXTURE]), []);
});

test("W1-T8523: a scout draft with its new test path passes machine-filing admission", () => {
  const shard = scoutShard(symptom(["src/lib/plan.ts"]), "NEW-2", [1, 5]);
  assert.equal(shard.refused, undefined);
  assert.deepEqual(violations(shard.text, ["src/lib/plan.ts"]), []);
});

test("W1-T8523: a scout draft naming a missing source path is still refused", () => {
  const shard = scoutShard(symptom(["src/lib/nope.ts"]), "NEW-3", [1, 5]);
  const reasons = violations(shard.text, []);
  assert.match(reasons.join("; "), /src\/lib\/nope\.ts/);
  assert.doesNotMatch(reasons.join("; "), /test\/scout-/);
});

test("W1-T8523: an unjudged record of an unlisted origin is still refused", () => {
  const shard = scoutShard(symptom(["src/lib/plan.ts"]), "NEW-4", [1, 5]);
  const text = shard.text.replace(/origin: "scout:[^"]*"/, 'origin: "mystery:thing"');
  assert.match(violations(text, ["src/lib/plan.ts"]).join("; "), /verify:human — not auto-runnable/);
});
