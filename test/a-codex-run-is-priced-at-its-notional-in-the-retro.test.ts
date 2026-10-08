import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalVerdictFields } from "../src/run-task.js";
import { gatherRuns, type LedgerRecord } from "../src/lib/retro.js";
import { notionalSpendUsd, spendAmountUsd } from "../src/lib/spend-rows.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import { codexNotionalCostUsd, openWeightPriceFor, OpenWeightUnpricedDeploymentError } from "../src/lib/worker-provider.js";

const tokens = { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheCreation: 0 };

function worker(model: string, provider: WorkerResult["provider"] = "codex"): WorkerResult {
  return {
    provider, model: "opus", routedModel: model, costUsd: 0, numTurns: 1,
    tokens, notionalCostUsd: codexNotionalCostUsd(model, tokens),
    isError: false, apiError: false, subtype: "success", childEnvKeys: [],
    sessionId: "codex-session", text: "done", blocks: ["done"], stderr: "",
    permissionDenials: [], effort: "high", modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, qualitySuspect: false,
  };
}

function row(step: string, fields: Record<string, unknown> = {}): LedgerRecord {
  return { ts: "2026-10-08T12:00:00.000Z", run_id: "codex-run", task_id: "W1-T5664", step, ...fields };
}

for (const [model, expected] of [["gpt-6-sol", 2.28], ["gpt-5.6-sol", 4.56]] as const) {
  test(`a codex run with ${model} tokens carries its notional through the verdict into gatherRuns`, () => {
    const result = worker(model);
    assert.equal(result.notionalCostUsd, expected);
    const fields = terminalVerdictFields(result);
    assert.equal(notionalSpendUsd(fields), expected);
    assert.equal(spendAmountUsd(fields), 0);
    assert.equal(fields.spend_role, "restated");
    const runs = gatherRuns([row("run.start", { type: "implement" }), row("verdict", { verdict: "merged", cost_usd: 0, ...fields })]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].costUsd, expected);
    assert.equal(runs[0].costSource, undefined);
    assert.throws(() => openWeightPriceFor(model), OpenWeightUnpricedDeploymentError);
  });
}

test("an unverdicted codex run sums worker notionals and ignores probe cash", () => {
  const fields = workerLedgerFields(worker("gpt-6-sol"));
  const [run] = gatherRuns([
    row("run.start", { type: "implement" }), row("containment.probe", { cost_usd: 99 }),
    row("recon.done", fields), row("implement.done", fields), row("implement.resumed", fields),
  ]);
  assert.equal(run.costUsd, 2.28 * 3);
});

test("an unpriced codex verdict has no notional receipt and is marked unknown in gatherRuns", () => {
  const fields = terminalVerdictFields(worker("unknown-model"));
  assert.equal(Object.hasOwn(fields, "notional_cost_usd"), false);
  assert.equal(notionalSpendUsd(fields), undefined);
  const [run] = gatherRuns([row("run.start"), row("verdict", { verdict: "failed", cost_usd: 0, ...fields })]);
  assert.equal(run.costSource, "none");
  assert.equal(run.costUsd, 0);
});

test("an unpriced codex worker leaves an unverdicted run marked unknown", () => {
  const fields = workerLedgerFields(worker("unknown-model"));
  const [run] = gatherRuns([row("run.start"), row("implement.done", fields)]);
  assert.equal(run.costSource, "none");
  assert.equal(run.costUsd, 0);
});

test("claude verdict cash retains its existing precedence and never takes a codex notional", () => {
  const fields = terminalVerdictFields({ ...worker("gpt-6-sol", "claude"), costUsd: 3 });
  assert.equal(Object.hasOwn(fields, "notional_cost_usd"), false);
  const [run] = gatherRuns([row("run.start"), row("verdict", { cost_usd: 7, ...fields })]);
  assert.equal(run.costUsd, 7);
  assert.deepEqual(terminalVerdictFields(null), { model: null, served_model: null });
});

test("codex notional pricing preserves existing base rates and bounds cached input", () => {
  assert.equal(codexNotionalCostUsd("gpt-6.1-sol", tokens), 2.24);
  assert.equal(codexNotionalCostUsd("gpt-6-sol", { input: 100, output: 0, cacheRead: 500 }), 0.00002);
  assert.equal(codexNotionalCostUsd("gpt-6-sol", { input: 0, output: 0, cacheRead: 0 }), 0);
  assert.equal(codexNotionalCostUsd("toString", tokens), undefined);
});


test("a partly priced codex worker run is marked unknown while a measured zero stays a price", () => {
  const [partial] = gatherRuns([row("run.start"), row("recon.done", workerLedgerFields(worker("gpt-6-sol"))),
    row("implement.done", workerLedgerFields(worker("unknown-model")))]);
  assert.equal(partial.costSource, "none");
  assert.equal(partial.costUsd, 0);
  const [zero] = gatherRuns([row("run.start"), row("verdict", { provider: "codex", notional_cost_usd: 0, cost_usd: 0 })]);
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.costSource, undefined);
});
