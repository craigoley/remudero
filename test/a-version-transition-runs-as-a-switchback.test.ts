// test/a-version-transition-runs-as-a-switchback.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSwitchback, switchbackArmFor, type SwitchbackOutcome, type VersionSwitchbackWindow } from "../src/lib/version-switchback.js";
import { selectCodexModel, type CodexModelInfo } from "../src/lib/worker-provider.js";
import type { CapabilityLadder } from "../src/lib/mounts.js";

const window: VersionSwitchbackWindow = {
  id: "sol-5.6-to-6", provider: "codex", startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-09-15T00:00:00Z", oldModel: "gpt-5.6-sol", newModel: "gpt-6-sol",
};
const at = "2026-09-08T12:00:00Z";
const both = [window.oldModel, window.newModel];
const models: CodexModelInfo[] = both.map((id) => ({
  id, model: id, supportedReasoningEfforts: [{ reasoningEffort: "high" }],
}));
const limits = { rateLimitsByLimitId: {
  codex: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 10080 } },
} };
const ladder: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 }, claude: { sonnet: "balanced" },
  codex: { economy: {}, balanced: { high: both }, frontier: {} },
};

test("a version overlap assigns eligible tasks by a stable logged propensity and closes automatically", () => {
  const allocations = Array.from({ length: 100 }, (_, i) => switchbackArmFor(window, `W1-T${i}`, at, both)!);
  assert.equal(allocations.length, 100);
  assert.equal(new Set(allocations.map((row) => row.arm)).size, 2);
  for (const row of allocations) {
    assert.deepEqual(switchbackArmFor(window, row.taskId, "2026-09-09T00:00:00Z", both)?.arm, row.arm);
    assert.equal(row.propensity, 0.5);
    assert.equal(row.window.endsAt, window.endsAt);
    assert.equal(row.model, row.arm === "old" ? window.oldModel : window.newModel);
  }
  assert.equal(switchbackArmFor(window, "W1-T1", window.startsAt, both)?.taskId, "W1-T1");
  assert.equal(switchbackArmFor(window, "W1-T1", window.endsAt, both), null);
  assert.equal(switchbackArmFor(window, "W1-T1", "2026-08-31T23:59:59Z", both), null);
  assert.equal(switchbackArmFor(window, "W1-T1", at, [window.newModel]), null);
  assert.throws(() => switchbackArmFor({ ...window, endsAt: window.startsAt }, "W1-T1", at, both),
    /invalid version switchback window/);
});

test("the production Codex selector routes to the assigned version only when both models can serve", () => {
  for (let i = 0; i < 20; i++) {
    const taskId = `W1-T${i}`;
    const selected = selectCodexModel(models, limits, {} as never, "sonnet", "high", ladder,
      { switchback: { window, taskId, at } });
    assert.equal(selected.model, switchbackArmFor(window, taskId, at, both)?.model);
    assert.equal(selected.modelDecision?.switchback?.taskId, taskId);
    assert.equal(selected.modelDecision?.switchback?.model, selected.model);
  }
  const defaultSelection = selectCodexModel(models, limits, {} as never, "sonnet", "high", ladder);
  assert.equal(defaultSelection.modelDecision?.switchback, undefined);
  const closed = selectCodexModel(models, limits, {} as never, "sonnet", "high", ladder,
    { switchback: { window, taskId: "W1-T1", at: window.endsAt } });
  assert.equal(closed.modelDecision?.switchback, undefined);
  assert.equal(closed.model, defaultSelection.model);
  const oneVisible = selectCodexModel(models.slice(1), limits, {} as never, "sonnet", "high", ladder,
    { switchback: { window, taskId: "W1-T1", at } });
  assert.equal(oneVisible.modelDecision?.switchback, undefined);
  const oldExhausted = { rateLimitsByLimitId: {
    old: { limitId: "old", limitName: window.oldModel, primary: { usedPercent: 99 } },
    new: { limitId: "new", limitName: window.newModel, primary: { usedPercent: 20 } },
  } };
  const unhealthy = selectCodexModel(models, oldExhausted, {} as never, "sonnet", "high", ladder,
    { switchback: { window, taskId: "W1-T1", at } });
  assert.equal(unhealthy.modelDecision?.switchback, undefined);
  assert.equal(unhealthy.model, window.newModel);
});

test("analysis uses verified served versions and intervals, retaining absent and wrong receipts", () => {
  const assignments = Array.from({ length: 80 }, (_, i) => switchbackArmFor(window, `W1-T${i}`, at, both)!);
  const outcomes: SwitchbackOutcome[] = assignments.map((assignment) => ({ assignment, servedModel: assignment.model, success: true }));
  outcomes[0] = { ...outcomes[0]!, servedModel: "other-model" };
  outcomes[1] = { ...outcomes[1]!, servedModel: null };
  const report = analyzeSwitchback(window, outcomes, 0.2);
  assert.equal(report.misrouted, 1);
  assert.equal(report.missingServedModel, 1);
  assert.equal(report.arms.old.tasks + report.arms.new.tasks, 78);
  assert.equal(report.difference, 0);
  assert.match(report.conclusion, /^no detected change \(power /);
  assert.ok(report.interval95![0] < 0 && report.interval95![1] > 0);
  assert.equal(analyzeSwitchback(window, outcomes.slice(0, 1)).conclusion, "insufficient verified outcomes");
  assert.throws(() => analyzeSwitchback(window, outcomes, 0), /invalid detectable effect/);
  const forged = { ...assignments[2]!, arm: (assignments[2]!.arm === "old" ? "new" : "old") as "old" | "new" };
  assert.equal(analyzeSwitchback(window, [{ assignment: forged, servedModel: forged.model, success: true }]).arms.old.tasks, 0);
  const clearDifference = assignments.map((assignment): SwitchbackOutcome => ({
    assignment, servedModel: assignment.model, success: assignment.arm === "new",
  }));
  const detected = analyzeSwitchback(window, clearDifference);
  assert.equal(detected.conclusion, "detected change");
  assert.ok(detected.interval95![0] > 0);
});
