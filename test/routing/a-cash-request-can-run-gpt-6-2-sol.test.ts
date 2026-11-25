import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "#src/lib/config-schema.js";
import { cashDeploymentTarget, DEFAULT_CASH_KEY_ENV } from "#src/lib/config-schema.js";
import { CASH_RESPONSES_DEPLOYMENTS, CashResponsesConversation } from "#src/lib/cash-responses.js";
import { BAKEOFF_CANDIDATES, learnedBakeoffLimit } from "#src/lib/inbox-bakeoff.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import * as worker from "#src/lib/worker.js";
import {
  CODEX_NOTIONAL_PRICES, OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_PRICES,
  OPENWEIGHT_RESPONSE_FORMATS, OPENWEIGHT_TEMPERATURE, clearOpenWeightAbsence,
  markOpenWeightDeploymentAbsent, openWeightCandidatesForCapability, openWeightDeploymentKnownAbsent, openWeightDeploymentReady,
  openWeightUsageUsd, recordCashCapacity, resetLearnedCashCapacity, selectOpenWeightModel,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { systemClock } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TERRA = "gpt-6.1-terra";
const SOL = "gpt-6.1-sol";
const SOL62 = "gpt-6.2-sol";
const DEFAULT_HOST = "default.openai.azure.com";
const EASTUS_HOST = "synthwatch-foundry-eus.cognitiveservices.azure.com";
const EASTUS_ENDPOINT = `https://${EASTUS_HOST}/`;
const table = loadMounts(mountsPath(REPO_ROOT)).capabilities!;

/** Config fixtures only: nothing here reads the host's ~/.config/remudero/config.json. */
function configFor(root: string, mapSol62: boolean): Config {
  return { root, claudeBin: "/unused", dailyCapUsd: 50, workerProviders: {
    cashEndpoint: `https://${DEFAULT_HOST}/`,
    cashDeploymentEndpoints: {
      [TERRA]: { endpoint: EASTUS_ENDPOINT, keyEnv: "RMD_CASH_EASTUS_API_KEY" },
      ...(mapSol62 ? { [SOL62]: { endpoint: EASTUS_ENDPOINT, keyEnv: "RMD_CASH_EASTUS_API_KEY" } } : {}),
    },
  } } as Config;
}

test("W1-T13446 criterion 1: gpt-6.2-sol is a ready cash deployment, priced $2/$0.10/$10, and its Responses body is built only at the listed efforts", () => {
  assert.equal(Object.hasOwn(OPENWEIGHT_PRICES, SOL62), true);
  assert.equal(Object.hasOwn(OPENWEIGHT_TEMPERATURE, SOL62), true);
  assert.equal(Object.hasOwn(OPENWEIGHT_CONTEXT_WINDOWS, SOL62), true);
  assert.equal(openWeightDeploymentReady(SOL62), true);
  const price = OPENWEIGHT_PRICES[SOL62]!;
  assert.equal(price.inputUsdPerMillion, 2);
  assert.equal(price.cachedInputUsdPerMillion, 0.1);
  assert.equal(price.outputUsdPerMillion, 10);
  assert.equal(price.unbilledAzureOpenAi429, true);
  assert.equal(price.readAt, "2026-11-18");
  // No Microsoft long-context figure was read: threshold -1 reserves EVERY request at the long-context
  // rate, as the Terra row does, and the rates are 6.1 Sol's.
  assert.deepEqual(price.longContext, { thresholdInputTokens: -1, inputUsdPerMillion: 4, outputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 5, reservationInputUsdPerMillion: 5 });
  assert.equal(openWeightUsageUsd(SOL62, 1_000_000, 0, 0, 0), 4);
  assert.equal(openWeightUsageUsd(SOL62, 1_000_000, 0, 1_000_000, 0), 0.2);
  assert.equal(openWeightUsageUsd(SOL62, 0, 1_000_000, 0, 0), 15);
  // The spread carries the one price row under one key: CODEX_NOTIONAL_PRICES holds no 6.2 override.
  assert.equal(CODEX_NOTIONAL_PRICES[SOL62], price);
  // No input limit was published or read: a deliberate floor, not 6.1 Sol's 922K.
  assert.equal(OPENWEIGHT_CONTEXT_WINDOWS[SOL62]!.totalTokens, 128_000);
  // No probe (d): temperature omitted and no response_format claimed.
  assert.equal(OPENWEIGHT_TEMPERATURE[SOL62], null);
  assert.equal(OPENWEIGHT_RESPONSE_FORMATS[SOL62], undefined);

  // No per-effort probe is recorded: only the efforts a cash row or the bake-off requests.
  assert.deepEqual(CASH_RESPONSES_DEPLOYMENTS[SOL62], ["low", "medium", "high"]);
  const conversation = new CashResponsesConversation("contract", "prompt");
  for (const effort of CASH_RESPONSES_DEPLOYMENTS[SOL62]!) {
    assert.equal(JSON.parse(conversation.body(SOL62, effort, 8000, [])).reasoning.effort, effort);
  }
  for (const effort of ["none", "xhigh", "max", "ultra"]) {
    assert.throws(() => conversation.body(SOL62, effort, 8000, []), (error: Error) => {
      assert.ok(error.message.includes(SOL62));
      assert.ok(error.message.includes("low, medium, high"));
      return true;
    }, `${effort} is refused before transport`);
  }
  // The listed efforts are not copied from 6.1 Sol or the Codex list.
  assert.notDeepEqual(CASH_RESPONSES_DEPLOYMENTS[SOL62], CASH_RESPONSES_DEPLOYMENTS[SOL]);
});

test("W1-T13446 criterion 2: every cash row offering gpt-6.1-sol lists gpt-6.2-sol directly ahead of it, and cashSonnetAlternatives offers terra, 6.2 sol, 6.1 sol, passing over absent or capacity-short members", (t) => {
  const withoutSol62 = (row: string[]) => row.filter((model) => model !== SOL62);
  const originBalanced = ["gpt-5-nano", "gpt-oss-120b", "gpt-6-luna", TERRA, SOL];
  const balanced = ["gpt-5-nano", "gpt-oss-120b", "gpt-6-luna", TERRA, SOL62, SOL];
  for (const effort of ["low", "medium", "high"]) {
    // mounts.yaml: every cash row offering 6.1 Sol has 6.2 Sol directly ahead, others in origin/main order.
    for (const tier of ["economy", "balanced", "frontier"] as const) {
      const row = table.cash![tier][effort]!;
      if (row.includes(SOL)) assert.equal(row.indexOf(SOL62) + 1, row.indexOf(SOL), `${tier}/${effort}`);
      else assert.equal(row.includes(SOL62), false, `${tier}/${effort} offers no 6.1 Sol, so no 6.2 Sol`);
    }
    const row = table.cash!.balanced[effort]!;
    assert.deepEqual(row, balanced);
    assert.deepEqual(withoutSol62(row), originBalanced);
    // FALLBACK_OPENWEIGHT_MODELS (no mounts table) carries the same order.
    assert.deepEqual(openWeightCandidatesForCapability(undefined, "balanced", effort), balanced);
    for (const tier of ["economy", "frontier"] as const) {
      assert.equal(openWeightCandidatesForCapability(undefined, tier, effort).includes(SOL62), false);
    }
  }

  const { dir } = ownedFixtureDir(t, "sol62-alternatives");
  const config = { root: dir, claudeBin: "/unused", workerProviders: { cashEndpoint: `https://${DEFAULT_HOST}/` } } as Config;
  const capShort = (model: string) =>
    recordCashCapacity(config, model, new Headers({ "x-ratelimit-limit-tokens": "1" }), { clock: systemClock });
  try {
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [TERRA, SOL62, SOL]);
    // Absent members are passed over, one at a time.
    markOpenWeightDeploymentAbsent(SOL62);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [TERRA, SOL]);
    markOpenWeightDeploymentAbsent(TERRA);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [SOL]);
    markOpenWeightDeploymentAbsent(SOL);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), []);
    clearOpenWeightAbsence();
    // Capacity-short members are passed over too.
    capShort(SOL62);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [TERRA, SOL]);
    capShort(TERRA);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [SOL]);
    capShort(SOL);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), []);
  } finally { clearOpenWeightAbsence(); resetLearnedCashCapacity(); }
});

test("W1-T13446 criterion 3: the bake-off trials gpt-6.2-sol at low, medium and high on the sonnet mount, and a mapped entry sends its requests to that endpoint and key env", async (t) => {
  const arms = BAKEOFF_CANDIDATES.filter((candidate) => candidate.model === SOL62);
  assert.deepEqual(arms.map((candidate) => candidate.effort), ["low", "medium", "high"]);
  assert.deepEqual(arms.map((candidate) => candidate.id), ["cash-gpt-6.2-sol-low", "cash-gpt-6.2-sol-medium", "cash-gpt-6.2-sol-high"]);
  assert.ok(arms.every((candidate) => candidate.billing === "cash" && candidate.mountModel === "sonnet" && candidate.tools));
  const ids = BAKEOFF_CANDIDATES.map((candidate) => candidate.id);
  assert.ok(ids.indexOf("cash-gpt-6.1-terra-high") < ids.indexOf("cash-gpt-6.2-sol-low"), "the 6.2 Sol arms follow the Terra arms");
  for (const arm of arms) {
    const selection = selectOpenWeightModel(table, arm.mountModel, arm.effort, Buffer.byteLength("fixture prompt"), { only: [arm.model] });
    assert.equal(selection.model, SOL62);
    assert.equal(selection.effort, arm.effort);
  }

  const { dir } = ownedFixtureDir(t, "sol62-mapped");
  const mapped = configFor(dir, true);
  const env = { RMD_OPENWEIGHT_API_KEY: "default-fixture", RMD_CASH_EASTUS_API_KEY: "eastus-fixture" };
  assert.deepEqual(cashDeploymentTarget(mapped, SOL62, env),
    { ok: true, endpoint: EASTUS_ENDPOINT, key: "eastus-fixture", keyEnv: "RMD_CASH_EASTUS_API_KEY", mapped: true });
  // The bake-off's learned-limit port resolves each arm through the same map entry.
  // A separate root, so the learned limit never reaches the spawn below.
  const { dir: limitDir } = ownedFixtureDir(t, "sol62-limit");
  try {
    recordCashCapacity(configFor(limitDir, true), SOL62, new Headers({ "x-ratelimit-limit-tokens": "777" }), { clock: systemClock });
    assert.equal(learnedBakeoffLimit(configFor(limitDir, true))(SOL62), 777);
    assert.equal(learnedBakeoffLimit(configFor(limitDir, false))(SOL62), undefined, "an unmapped config reads another endpoint's limit");
  } finally { resetLearnedCashCapacity(); }

  let calls = 0;
  const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "say done", tools: [], maxTurns: 2,
    runId: "sol62-mapped", env,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(String(url), `https://${EASTUS_HOST}/openai/v1/responses`);
      assert.equal((init?.headers as Record<string, string>)["api-key"], "eastus-fixture");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, SOL62);
      assert.equal(body.reasoning.effort, "medium");
      assert.equal(body.temperature, undefined);
      return Response.json({ id: "r", model: SOL62, status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } } });
    } }, mapped, { model: SOL62, effort: "medium" });
  assert.equal(calls, 1);
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.text, "done");
});

test("W1-T13446 criterion 4: a config that does not name gpt-6.2-sol targets the default account, a DeploymentNotFound answer marks it absent, and balanced cash serves gpt-6.1-sol", async (t) => {
  const { dir } = ownedFixtureDir(t, "sol62-unmapped");
  const config = configFor(dir, false);
  const env = { RMD_OPENWEIGHT_API_KEY: "default-fixture", RMD_CASH_EASTUS_API_KEY: "eastus-fixture" };
  assert.equal(config.workerProviders?.cashDeploymentEndpoints?.[SOL62], undefined);
  assert.deepEqual(cashDeploymentTarget(config, SOL62, env),
    { ok: true, endpoint: `https://${DEFAULT_HOST}/`, key: "default-fixture", keyEnv: DEFAULT_CASH_KEY_ENV, mapped: false });

  try {
    // The balanced cash row lists gpt-6.2-sol directly before gpt-6.1-sol, at every effort.
    for (const effort of ["low", "medium", "high"]) {
      const row = table.cash!.balanced[effort]!;
      assert.equal(row.indexOf(SOL62) + 1, row.indexOf(SOL), `${effort}: gpt-6.2-sol sits directly before gpt-6.1-sol`);
    }
    const select = () => selectOpenWeightModel(table, "sonnet", "high", Buffer.byteLength("fixture prompt"), { only: [SOL62, SOL] });
    assert.equal(select().model, SOL62, "before any answer the row leads with gpt-6.2-sol");

    let calls = 0;
    const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "say done", tools: [], maxTurns: 2,
      runId: "sol62-unmapped", env,
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(String(url), `https://${DEFAULT_HOST}/openai/v1/responses`, "the request goes to the default account");
        assert.equal((init?.headers as Record<string, string>)["api-key"], "default-fixture");
        return new Response('{"error":{"code":"DeploymentNotFound"}}', { status: 404 });
      } }, config, { model: SOL62, effort: "high" });
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.equal(result.openWeightDeploymentAbsent, SOL62, "a DeploymentNotFound answer reports the deployment absent");
    // worker.ts marks the reported deployment absent before the next rung.
    markOpenWeightDeploymentAbsent(result.openWeightDeploymentAbsent!);
    assert.equal(openWeightDeploymentKnownAbsent(SOL62), true);
    assert.equal(openWeightDeploymentReady(SOL62), false);

    assert.equal(select().model, SOL, "a balanced cash selection then serves gpt-6.1-sol from the same row");
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [TERRA, SOL]);
  } finally { clearOpenWeightAbsence(); resetLearnedCashCapacity(); }
});
