import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  FOUNDRY_CLAUDE_PRICES,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  reserveOpenWeightBudget,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "../src/lib/worker.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const ISO = "2026-09-29T12:00:00.000Z";
const env = { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-sonnet-"));
  const config = { root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" } } as Config;
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function allowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
}

const blocked = (provider: "claude" | "codex"): ProviderCapacity => ({ provider, readable: false, windows: [], detail: "exhausted" });

async function blockedBalanced(root: string, options: {
  env?: Record<string, string>;
  cashResult?: (model: string) => Partial<WorkerResult>;
} = {}) {
  const selections: string[] = [];
  const result = await spawnWorker({
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(import.meta.dirname, "..", "settings", "worker.json"),
    prompt: "Read the finding", model: "sonnet", effort: "high", tools: ["Read"],
    env: options.env ?? env,
    config: { root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
      workerProviders: { enabled: ["claude", "codex", "cash"], codexBin: "/unused/codex", reservePercent: 5,
        capacityCacheMs: 60_000, cashFallbackWhenBlocked: true } } as Config,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => blocked("claude"), readCodex: async () => blocked("codex"),
      spawnOpenWeight: async (_args, _config, selection) => {
        selections.push(selection.model);
        return { provider: "cash", model: selection.model, text: "done", isError: false, subtype: "success",
          ...options.cashResult?.(selection.model) } as never;
      },
      writeStatus: () => {}, now: () => NOW,
    },
    claudeExecutable: { cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true,
        which: () => "/fake/claude", canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }) },
  } as SpawnWorkerArgs);
  return { result, selections };
}

test("W1-T4785: a squeezed balanced task runs on Foundry Sonnet 5.5", async () => {
  const f = fixture();
  try {
    const routed = await blockedBalanced(f.root);
    assert.deepEqual(routed.selections, ["claude-sonnet-5-5"]);
    assert.equal(routed.result.isError, false);
    const missing = await blockedBalanced(f.root, { env: {} });
    assert.deepEqual(missing.selections, ["gpt-6-luna"]);
  } finally { f.cleanup(); }
});

test("W1-T4785: an exhausted Foundry Claude cap falls back to the Luna cash ladder", async () => {
  const f = fixture();
  try {
    const routed = await blockedBalanced(f.root, { cashResult: (model) => model === "claude-sonnet-5-5"
      ? { isError: true, budgetRefused: true, budgetReservedUsd: 0 } : {} });
    assert.deepEqual(routed.selections, ["claude-sonnet-5-5", "gpt-6-luna"]);
    assert.equal(routed.result.isError, false);
    const billed = await blockedBalanced(f.root, { cashResult: (model) => model === "claude-sonnet-5-5"
      ? { isError: true, budgetRefused: true, budgetReservedUsd: 0.08 } : {} });
    assert.deepEqual(billed.selections, ["claude-sonnet-5-5"], "an already billed turn cannot silently run another model");
  } finally { f.cleanup(); }
});

test("W1-T4785: Opus and Sonnet reservations share one Foundry Claude daily cap", () => {
  const f = fixture();
  try {
    assert.deepEqual([FOUNDRY_CLAUDE_PRICES["claude-opus-5-5"]?.inputUsdPerMillion,
      FOUNDRY_CLAUDE_PRICES["claude-sonnet-5-5"]?.inputUsdPerMillion], [4, 2]);
    const reserve = (id: string, deployment: string, squeezed: boolean) =>
      reserveOpenWeightBudget(f.config, { requestId: id, deployment, requestBodyBytes: 10, atIso: ISO, squeezed });
    for (let i = 0; i < 31; i++) reserve(`opus-${i}`, "claude-opus-5-5", false);
    assert.throws(() => reserve("sonnet-normal-over", "claude-sonnet-5-5", false), /\$5\.00 dailyCapUsd/);
    for (let i = 0; i < 62; i++) reserve(`sonnet-${i}`, "claude-sonnet-5-5", true);
    assert.throws(() => reserve("opus-squeeze-over", "claude-opus-5-5", true), /\$10\.00 dailyCapUsd/);
    assert.equal(Object.keys(allowance(f.root).reservations).length, 93);
  } finally { f.cleanup(); }
});

test("W1-T4785: the spawn path calls the generalized Foundry Claude worker", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const result = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "Answer", cashSqueezed: true,
      env, clock: fixedClock(NOW),
      fetchImpl: async (url, init) => {
        sent++;
        assert.equal(String(url), "https://foundry.example.test/anthropic/v1/messages");
        assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "claude-sonnet-5-5");
        return new Response(JSON.stringify({ id: "msg-sonnet", stop_reason: "end_turn",
          content: [{ type: "text", text: "Done" }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } }), { status: 200 });
      },
    }, f.config, { model: "claude-sonnet-5-5", effort: "medium" });
    assert.equal(result.isError, false, result.stderr);
    assert.equal(result.costUsd, (100 * 2 + 20 * 10 + 50 * 0.2 + 10 * 4) / 1_000_000);
    assert.equal(sent, 1);
    assert.equal(Object.values(allowance(f.root).reservations)[0]?.settledUsd, result.costUsd);
  } finally { f.cleanup(); }
});
