import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { cashSonnetAlternatives } from "#src/lib/worker.js";
import {
  OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_MAX_COMPLETION_TOKENS, OPENWEIGHT_OUTPUT_CONTRACT,
  OPENWEIGHT_PRICES, OPENWEIGHT_RESPONSE_FORMATS, OPENWEIGHT_TEMPERATURE,
  OpenWeightUnsupportedResponseFormatError, openWeightCandidatesForCapability,
  openWeightDeploymentReady, openWeightReservationUsd, openWeightResponseFormatField,
  openWeightUsageUsd, spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const rows = [
  { model: "DeepSeek-V4-Flash", input: 0.19, output: 0.51, cached: 0.028, context: 1_000_000 },
  { model: "DeepSeek-V4.1-Flash", input: 0.30, output: 1.20, cached: 0.006, context: 1_000_000 },
  { model: "Kimi-K2.6", input: 0.95, output: 4, cached: 0.16, context: 262_144 },
] as const;

function fixture(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "three-open-weight-arms");
  return { dir, config: { root: dir, dailyCapUsd: 100,
    workerProviders: { cashEndpoint: "https://foundry.example.test/" } } as Config };
}

async function request(t: TestContext, model: string, effort: string, tools: string[] = [], responseFormat?: string) {
  const { dir, config } = fixture(t);
  const bodies: string[] = [];
  const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "answer in JSON", tools,
    responseFormat, env: { RMD_OPENWEIGHT_API_KEY: "fixture-key" }, fetchImpl: async (url, init) => {
      assert.equal(String(url), `https://foundry.example.test/openai/deployments/${model}/chat/completions?api-version=2024-10-21`);
      bodies.push(String(init?.body));
      return Response.json({ id: "reply", model, choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 8 } });
    } }, config, { model, effort });
  return { bodies, result };
}

test("W1-T10855: the three open-weight deployments are ready with their published rows", (t) => {
  for (const { model, input, output, cached, context } of rows) {
    assert.deepEqual(OPENWEIGHT_PRICES[model], { inputUsdPerMillion: input, outputUsdPerMillion: output,
      cachedInputUsdPerMillion: cached, reservationInputUsdPerMillion: input, readAt: "2026-10-27" });
    assert.deepEqual(OPENWEIGHT_CONTEXT_WINDOWS[model], { totalTokens: context, readAt: "2026-10-27" });
    assert.equal(OPENWEIGHT_TEMPERATURE[model], 0);
    assert.equal(openWeightDeploymentReady(model), true);
  }
  const cash = loadMounts(mountsPath(REPO_ROOT)).capabilities?.cash;
  assert.ok(cash);
  const routed = Object.values(cash).flatMap(efforts => Object.values(efforts).flat());
  assert.ok(routed.includes("gpt-oss-120b"), "positive control: the mounted cash ladder was read");
  const { config } = fixture(t);
  const alternatives = cashSonnetAlternatives("small prompt", config, {});
  assert.ok(alternatives.includes("gpt-6.1-terra"), "positive control: Sonnet alternatives were enumerated");
  const fallback = ["economy", "balanced", "frontier"].flatMap(tier =>
    openWeightCandidatesForCapability(undefined, tier as "economy" | "balanced" | "frontier", "high"));
  assert.ok(fallback.includes("gpt-oss-120b"));
  for (const { model } of rows) {
    assert.equal(routed.includes(model), false);
    assert.equal(fallback.includes(model), false);
    assert.equal(alternatives.includes(model), false);
  }
});

test("W1-T10855: a cached DeepSeek token is reserved at the full input rate", () => {
  for (const { model, input, output, cached } of rows) {
    const outputReserve = OPENWEIGHT_MAX_COMPLETION_TOKENS * output / 1_000_000;
    assert.equal(openWeightReservationUsd(model, 1_000_000), input + outputReserve);
    assert.equal(openWeightReservationUsd(model, 0, 1_000_000), input + outputReserve);
    assert.equal(openWeightReservationUsd(model, 0), outputReserve);
    assert.equal(openWeightUsageUsd(model, 1_000_000, 0, 1_000_000), cached);
    assert.equal(openWeightUsageUsd(model, 1_000_000, 0), input);
    assert.ok(input > cached, "a full-cache reservation must exceed the discounted usage receipt");
  }
});

test("W1-T10855: json_object is declared for both DeepSeek deployments and refused for Kimi", async (t) => {
  for (const { model } of rows.slice(0, 2)) {
    assert.deepEqual(OPENWEIGHT_RESPONSE_FORMATS[model], ["json_object"]);
    assert.deepEqual(openWeightResponseFormatField(model, "json_object"), { response_format: { type: "json_object" } });
    const { bodies, result } = await request(t, model, "high", [], "json_object");
    assert.equal(result.isError, false, result.stderr);
    assert.equal(bodies.length, 1);
    assert.deepEqual(JSON.parse(bodies[0]!).response_format, { type: "json_object" });
    assert.throws(() => openWeightResponseFormatField(model, "json_schema"), OpenWeightUnsupportedResponseFormatError);
  }
  assert.equal(OPENWEIGHT_RESPONSE_FORMATS["Kimi-K2.6"], undefined);
  assert.throws(() => openWeightResponseFormatField("Kimi-K2.6", "json_object"), OpenWeightUnsupportedResponseFormatError);
  const refused = await request(t, "Kimi-K2.6", "high", [], "json_object");
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.stderr, /cannot honour response_format/);
  assert.deepEqual(refused.bodies, []);
});

test("W1-T10855: reasoning_effort is sent only for an admitted effort", async (t) => {
  for (const { model } of rows) {
    for (const effort of ["low", "medium", "high", "default", "none", "minimal", "xhigh", "max", "ultra", "HIGH"]) {
      for (const tools of [[], ["Read"]]) {
        const { bodies, result } = await request(t, model, effort, tools);
        assert.equal(result.isError, false, result.stderr);
        assert.equal(bodies.length, 1);
        const body = JSON.parse(bodies[0]!);
        const admitted = model !== "Kimi-K2.6" && ["low", "medium", "high"].includes(effort);
        assert.equal(Object.hasOwn(body, "reasoning_effort"), admitted, `${model}/${effort}`);
        if (admitted) assert.equal(body.reasoning_effort, effort);
        assert.equal(body.temperature, 0);
        assert.equal(Object.hasOwn(body, "response_format"), false);
        assert.equal(result.requestEfforts[0]!.state, admitted ? "parameter-present" : "parameter-omitted");
        assert.equal(result.requestEfforts[0]!.value, admitted ? effort : null);
      }
    }
  }
  for (const model of ["gpt-oss-120b", "gpt-5-nano", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna"]) {
    for (const tools of [[], ["Read"]]) {
      const high = await request(t, model, "high", tools);
      const low = await request(t, model, "low", tools);
      assert.equal(high.result.isError, false, high.result.stderr);
      assert.equal(low.result.isError, false, low.result.stderr);
      assert.equal(high.bodies.length, 1);
      assert.deepEqual(high.bodies, low.bodies, "legacy bodies remain independent of the selected effort");
      const body = JSON.parse(high.bodies[0]!);
      assert.equal(Object.hasOwn(body, "reasoning_effort"), model === "gpt-6-luna" && tools.length > 0);
      if (model === "gpt-6-luna" && tools.length > 0) assert.equal(body.reasoning_effort, "none");
      if (tools.length === 0) assert.equal(high.bodies[0], JSON.stringify({ model, messages: [
        { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT }, { role: "user", content: "answer in JSON" },
      ], ...(model === "gpt-oss-120b" ? { temperature: 0 } : {}), max_completion_tokens: OPENWEIGHT_MAX_COMPLETION_TOKENS }));
    }
  }
});
