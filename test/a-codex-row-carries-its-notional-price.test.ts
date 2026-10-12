import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { groupSpendByAccount } from "../src/lib/ledger.js";
import { architectLaneShare, architectLaneShareTable } from "../src/lib/retro.js";
import { isCashSpendProducer, isProducedSpendRow, notionalSpendUsd, spendAmountUsd } from "../src/lib/spend-rows.js";
import { deriveDayCostUsd } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import { codexNotionalCostUsd, spawnCodexWorker } from "../src/lib/worker-provider.js";

/**
 * W1-T5629 — A CODEX ROW CARRIES ITS NOTIONAL PRICE, NOT A HARD-CODED $0.
 *
 * The codex worker returned `costUsd: 0` unconditionally, so every codex retro/triage row read $0 in the
 * architect-lane table beside Claude's notional dollars. The price is NOTIONAL: it rides its own
 * `notional_cost_usd` key, and `cost_usd`/`total_cost_usd` stay 0, so no budget, cash cap or spend
 * series moves. An unpriced routed model leaves the key ABSENT, never 0.
 */

const NOW = "2026-10-04T12:00:00.000Z";
const TS = "2026-10-04T01:00:00.000Z";
// 1M input of which 400k cached, 100k output. Base rate for gpt-6.1-sol: $2 in, $0.10 cached, $10 out.
const USAGE = { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 };
const BASE_RATE_USD = (600_000 * 2 + 400_000 * 0.1 + 100_000 * 10) / 1_000_000; // 2.24
// The long-context tier would bill this session sum at $3.98 — a per-request tier, which a session sum cannot apply.
const LONG_CONTEXT_USD = (600_000 * 4 + 400_000 * 0.2 + 100_000 * 15) / 1_000_000;

function codexProcess(usage: Record<string, number>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  return {
    process,
    finish() {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-notional" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage })}\n`);
      stdout.end();
      queueMicrotask(() => process.emit("exit", 0));
    },
  };
}

async function runCodexAs(model: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-notional-`));
  try {
    const controlled = codexProcess(USAGE);
    const promise = spawnCodexWorker(
      {
        workerHome: mkdtempSync(join(root, "home-")),
        cwd: root,
        prompt: "probe",
        settingsFile: join(process.cwd(), "settings", "worker.json"),
        tools: ["Bash"],
        containment: { spawn: () => ({ process: controlled.process as never, pid: 41_001 }), teardown: () => {} },
      },
      { claudeBin: "/unused/claude", root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: model, codexHome: join(root, "codex-home") } },
    );
    controlled.finish();
    return await promise;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function close(actual: number | undefined, expected: number, message?: string): void {
  assert.equal(typeof actual, "number", message);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${message ?? ""}: ${actual} != ${expected}`);
}

test("W1-T5629: a codex worker prices its routed model's tokens at base rate, and costUsd stays 0", async () => {
  const result = await runCodexAs("gpt-6.1-sol");
  assert.equal(result.costUsd, 0, "the cash figure is unchanged: a subscription bills no per-request dollar");
  close(result.notionalCostUsd, BASE_RATE_USD, "the notional is the base-rate price of the session's tokens");
  assert.notEqual(result.notionalCostUsd, LONG_CONTEXT_USD, "a session sum never takes the per-request long-context tier");
  // W1-T5664 prices gpt-6-sol and gpt-5.6-sol notionally; a model no table prices stays absent.
  const unpriced = await runCodexAs("unknown-model");
  assert.equal(unpriced.costUsd, 0);
  assert.equal(unpriced.notionalCostUsd, undefined, "an unpriced model is absent, never $0");
  assert.equal(codexNotionalCostUsd("unknown-model", { input: 10, output: 10, cacheRead: 0 }), undefined);
  // Cached input never exceeds input, even when a provider reports it so.
  close(codexNotionalCostUsd("gpt-6.1-sol", { input: 100, output: 0, cacheRead: 500 }), (100 * 0.1) / 1_000_000);
});

test("W1-T5629: workerLedgerFields writes notional_cost_usd beside a total_cost_usd that stays 0", () => {
  const base = {
    provider: "codex", sessionId: "S", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "opus", routedModel: "gpt-6.1-sol",
    effort: "high", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false,
  } as unknown as WorkerResult;
  const priced = workerLedgerFields({ ...base, notionalCostUsd: 2.24 });
  assert.equal(priced.notional_cost_usd, 2.24);
  assert.equal(priced.total_cost_usd, 0);
  const unpriced = workerLedgerFields(base);
  assert.equal(Object.hasOwn(unpriced, "notional_cost_usd"), false, "absent, never written as 0");
});

const codexRetro = {
  ts: TS, task_id: "RETRO", run_id: "RETRO-1", step: "retro.synthesized", provider: "codex", model: "opus", routed_model: "gpt-6.1-sol",
  cost_usd: 0, total_cost_usd: 0, notional_cost_usd: BASE_RATE_USD, account_label: "codex-main",
};
const unpricedTriage = {
  ts: TS, run_id: "TRIAGE-1", step: "triage.synthesized", provider: "codex", model: "opus", routed_model: "gpt-6-sol",
  cost_usd: 0, total_cost_usd: 0, account_label: "codex-main",
};
const claudeRetro = { ts: TS, run_id: "RETRO-2", step: "retro.synthesized", model: "opus", cost_usd: 3, total_cost_usd: 3 };

test("W1-T5629: notionalSpendUsd reads a codex row's notional, and a Claude row's own cost", () => {
  close(notionalSpendUsd(codexRetro), BASE_RATE_USD);
  assert.equal(notionalSpendUsd(unpricedTriage), undefined, "the $0 total is not a price: absent stays absent");
  assert.equal(notionalSpendUsd(claudeRetro), 3);
});

test("W1-T5629: the notional never reaches a cash, budget or spend reader", () => {
  assert.equal(spendAmountUsd(codexRetro), 0, "spend reads the billed figure");
  assert.equal(isProducedSpendRow(codexRetro), true);
  assert.equal(isCashSpendProducer(codexRetro), false, "a codex row is never cash");
  assert.equal(deriveDayCostUsd([codexRetro], Date.parse(NOW)), 0, "the cost governor's day total is unmoved");
  const accounts = groupSpendByAccount([codexRetro]);
  assert.equal(accounts.byAccount.reduce((s, g) => s + g.totalCostUsd, 0), 0);
  const modeled = deriveAnalyticsSnapshot([codexRetro], NOW).consoleV1.metrics.find((m) => m.key === "cost.modeled.usd");
  assert.equal(modeled?.value, 0, "the analytics spend series is unchanged");
});

test("W1-T5629: a codex retro row prices at its notional in architectLaneShare and is attributed to its routed model", () => {
  const report = architectLaneShare([codexRetro, claudeRetro, unpricedTriage]);
  const retro = report.architectLanes.find((l) => l.lane === "retro");
  const triage = report.architectLanes.find((l) => l.lane === "triage");
  assert.ok(retro && triage);
  close(retro.costUsd, BASE_RATE_USD + 3, "the codex row prices at its base-rate notional beside Claude's");
  assert.deepEqual(retro.models, [{ model: "gpt-6.1-sol", rows: 1 }, { model: "opus", rows: 1 }]);
  assert.equal(retro.unpricedRows, undefined);
  assert.equal(triage.costUsd, 0);
  assert.equal(triage.unpricedRows, 1, "an unpriced codex row is counted as unpriced, never as $0");
  assert.deepEqual(triage.models, [{ model: "gpt-6-sol", rows: 1 }]);
  const table = architectLaneShareTable(report);
  assert.match(table, /\| triage \(`triage\.synthesized`\) \| 1 \| \$0\.00 \(\+1 unpriced\) \|/);
  assert.match(table, /\| retro \(`retro\.synthesized`\) \| 2 \| \$5\.24 \|/);
});
