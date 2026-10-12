import assert from "node:assert/strict";
import test from "node:test";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { resolveClaudeModelHealth } from "../src/lib/claude-model-health.js";
import { ROUTING_EXPERIMENTS, routingExperimentFor } from "../src/lib/routing-experiments.js";
import { openWeightDeploymentReady, selectOpenWeightModel } from "../src/lib/worker-provider.js";

const MODEL = "claude-haiku-5-5";
const table = loadMounts(mountsPath(new URL("..", import.meta.url).pathname)).capabilities!;

test("Haiku 5.5 leads Claude economy with a same-capability legacy fallback and preserves cheap cash ordering", () => {
  assert.equal(table.claude[MODEL], "economy");
  assert.deepEqual(table.claudeCandidates!.economy, [MODEL, "claude-haiku-4-5-20251001"]);
  assert.equal(resolveClaudeModelHealth("haiku", table, { source: "fresh", degradedModels: [] }).routedModel, MODEL);
  assert.equal(resolveClaudeModelHealth("haiku", table, { source: "fresh", degradedModels: [MODEL] }).routedModel,
    "claude-haiku-4-5-20251001");
  assert.equal(resolveClaudeModelHealth("claude-haiku-4-5-20251001", table, { source: "fresh", degradedModels: [] }).routedModel,
    "claude-haiku-4-5-20251001");
  assert.equal(openWeightDeploymentReady(MODEL), true);
  for (const effort of ["low", "medium", "high"]) {
    assert.deepEqual(table.cash!.economy[effort], ["gpt-oss-120b", "gpt-5-nano", "gpt-6-luna", "gpt-5.6-luna", MODEL]);
    assert.equal(selectOpenWeightModel(table, MODEL, effort, 100).model, "gpt-oss-120b");
    assert.equal(selectOpenWeightModel(table, MODEL, effort, 100, { only: [MODEL] }).model, MODEL);
    assert.equal(table.cash!.balanced[effort].includes(MODEL), false);
    assert.equal(table.cash!.frontier[effort].includes(MODEL), false);
  }
});

test("Haiku 5.5 starts daily effort-specific Luna experiments only for both eligible concrete models", () => {
  assert.equal(ROUTING_EXPERIMENTS[0]?.id, "sol-vs-sonnet", "new epochs append without changing historical CLI report order");
  const classify = (effort: string, claude = MODEL, codex = "gpt-6-luna", eligible = true) => routingExperimentFor({
    capability: "economy", effort, considered: [
      { provider: "claude", model: claude, eligible }, { provider: "codex", model: codex, eligible: true },
    ],
  });
  for (const effort of ["low", "medium", "high"]) {
    const id = `haiku55-vs-luna6-${effort}`;
    assert.equal(classify(effort), id);
    const epoch = ROUTING_EXPERIMENTS.find((entry) => entry.id === id)!;
    assert.equal(epoch.reviewCadence, "daily");
    assert.equal(epoch.startedOn, "2026-10-07");
    assert.equal(epoch.revisitOn, epoch.startedOn);
    assert.equal(epoch.minTasksPerArm, 20);
    assert.deepEqual(epoch.arms, { claude: "haiku55", codex: "luna6" });
    assert.equal(classify(effort, "claude-haiku-4-5-20251001"), undefined);
    assert.equal(classify(effort, MODEL, "gpt-5.6-luna"), undefined);
    assert.equal(classify(effort, MODEL, "gpt-6-luna", false), undefined);
  }
});
