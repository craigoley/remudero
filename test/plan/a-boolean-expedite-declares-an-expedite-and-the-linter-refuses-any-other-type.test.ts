import assert from "node:assert/strict";
import { test } from "node:test";

import * as deployJudge from "#src/lib/deploy-judge.js";
import { expediteReason, runnableCandidates } from "#src/lib/drain.js";
import { loadPlanFromYaml, parseTasksFromYaml } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";

const EXPEDITED_ID = "W1-T1";
const ORDINARY_ID = "W1-T2";
const ORIGIN = "operator-session#x-2026-11-28";
const REASON = `expedite: true (origin ${ORIGIN})`;

function record(id: string, fields = ""): string {
  return [
    `- id: ${id}`,
    `  title: Test task ${id}`,
    "  repo: remudero",
    "  type: implement",
    `  files: [src/${id}.ts]`,
    fields,
    "",
  ].join("\n");
}

function expeditedRecord(value: string): string {
  return record(EXPEDITED_ID, `  origin: ${ORIGIN}\n  priority: 0.2\n  expedite: ${value}`);
}

test("W1-T15193 criterion 1: a boolean expedite supplies the record origin to dispatch", () => {
  const [task] = parseTasksFromYaml(expeditedRecord("true"), "test-catalog.yaml");
  assert.equal(task!.expedite, REASON);
  assert.equal(expediteReason(task!), REASON);
  assert.equal(lintTask(task!).violations.some((finding) => finding.check === "dispatch-expedite"), false);

  const [withoutOrigin] = parseTasksFromYaml(record(EXPEDITED_ID, "  expedite: true"), "test-catalog.yaml");
  assert.equal(withoutOrigin!.expedite, "expedite: true (no origin)");
  assert.equal(expediteReason(withoutOrigin!), "expedite: true (no origin)");
});

test("W1-T15193 criterion 2: the boolean expedite takes the first lane and reports its reason", () => {
  const ordinary = record(ORDINARY_ID, "  priority: 0.1");
  const starts: { id: string; reason: string }[] = [];
  const pick = (value: string) => {
    const plan = loadPlanFromYaml(expeditedRecord(value) + ordinary, "test-catalog.yaml");
    return runnableCandidates(plan, () => false, 2, {
      onExpedited: (task, start) => starts.push({ id: task.id, reason: start.reason }),
    }).map((task) => task.id);
  };

  assert.deepEqual(pick("false"), [ORDINARY_ID, EXPEDITED_ID]);
  assert.deepEqual(starts, []);
  assert.deepEqual(pick("true"), [EXPEDITED_ID, ORDINARY_ID]);
  assert.deepEqual(starts, [{ id: EXPEDITED_ID, reason: REASON }]);
});

test("W1-T15193 criterion 3: a pending boolean expedite releases the deploy freshness hold", () => {
  const minute = 60_000;
  const nowMs = 120 * minute;
  const staleSinceMs = nowMs - 70 * minute;
  const changes = [{ sha: "f".repeat(40), subject: "fix(plan): repair loading", files: ["src/lib/plan.ts"], tasks: [EXPEDITED_ID] }];
  const decision = deployJudge.decideFreshnessRestart({
    changes, busy: true, staleSinceMs, nowMs, state: { total: 0, scoredShas: [] }, ageHorizonMs: 60 * minute,
  });
  const input = {
    decision, newSha: changes[0]!.sha, lastAdvanceAtMs: nowMs - minute, staleSinceMs, nowMs,
    window: { value: 60 * minute, reason: "merges are still landing" },
    lifetimeStartedAtMs: nowMs - minute,
  };
  assert.equal(deployJudge.coalesceFreshnessRestart(input).reason, deployJudge.MIN_LIFETIME_HOLD);

  for (const value of ["true", JSON.stringify(REASON)]) {
    const plan = loadPlanFromYaml(expeditedRecord(value), "test-catalog.yaml");
    const expedite = deployJudge.pendingExpedite(changes, (id) => plan.byId.get(id)?.expedite);
    assert.deepEqual(expedite, { taskId: EXPEDITED_ID, reason: REASON });
    const outcome = deployJudge.coalesceFreshnessRestart({ ...input, expedite });
    assert.equal(outcome.action, "restart");
    assert.equal(outcome.reason, deployJudge.EXPEDITE_RELEASE);
    assert.deepEqual(outcome.expedite, expedite);
  }
});

test("W1-T15193 criterion 4: string reasons stay verbatim and false, blank, and absent declare nothing", () => {
  const reason = "  fix for a live cost leak  ";
  const [text, disabled, blank, absent] = parseTasksFromYaml(
    expeditedRecord(JSON.stringify(reason)) +
    record("W1-T2", "  expedite: false") +
    record("W1-T3", '  expedite: "   "') +
    record("W1-T4"),
    "test-catalog.yaml",
  );
  assert.equal(text!.expedite, reason);
  assert.equal(expediteReason(text!), reason.trim());
  assert.deepEqual([disabled!.expedite, blank!.expedite, absent!.expedite], [undefined, "   ", undefined]);
  for (const task of [text!, disabled!, blank!, absent!]) {
    assert.equal(lintTask(task).violations.some((finding) => finding.check === "dispatch-expedite"), false, task.id);
  }
  for (const task of [disabled!, blank!, absent!]) {
    assert.equal(expediteReason(task), undefined, task.id);
  }
});

test("W1-T15193 criterion 5: lint blocks invalid expedite values and names their YAML types", () => {
  const invalid = [["42", "number"], ["[urgent]", "array"], ["{reason: urgent}", "object"], ["null", "null"]] as const;
  for (const [value, type] of invalid) {
    const [task] = parseTasksFromYaml(expeditedRecord(value), "test-catalog.yaml");
    assert.equal(task!.expedite, undefined, value);
    assert.equal(expediteReason(task!), undefined, value);
    assert.deepEqual(lintTask(task!).violations.filter((finding) => finding.check === "dispatch-expedite"), [{
      check: "dispatch-expedite",
      severity: "block",
      message: `task ${EXPEDITED_ID}: expedite must be a string or boolean, got ${type}`,
    }]);
  }
});
