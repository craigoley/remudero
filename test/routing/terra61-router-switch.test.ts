import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { systemClock } from "#src/lib/clock.js";
import * as responses from "#src/lib/cash-responses.js";
import { BAKEOFF_CANDIDATES } from "#src/lib/inbox-bakeoff.js";
import { classifySuccessors } from "#src/lib/model-availability.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import * as worker from "#src/lib/worker.js";
import {
  CODEX_NOTIONAL_PRICES, OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_PRICES,
  OPENWEIGHT_RESPONSE_FORMATS, OPENWEIGHT_TEMPERATURE, clearOpenWeightAbsence,
  markOpenWeightDeploymentAbsent, openWeightCandidatesForCapability,
  openWeightDeploymentReady, openWeightReservationUsd, openWeightUsageUsd,
  recordCashCapacity, resetLearnedCashCapacity, spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { inboxBakeoffCommand } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TERRA = "gpt-6.1-terra";
const SOL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const table = loadMounts(mountsPath(REPO_ROOT)).capabilities!;

test("W1-T10839: Terra 6.1 is priced, shaped and ready on the cash lane", () => {
  const price = OPENWEIGHT_PRICES[TERRA];
  assert.ok(price);
  assert.deepEqual(price, {
    unbilledAzureOpenAi429: true, inputUsdPerMillion: 1, outputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.05, cacheWriteUsdPerMillion: 1.25,
    reservationInputUsdPerMillion: 1.25,
    longContext: { thresholdInputTokens: -1, inputUsdPerMillion: 2, outputUsdPerMillion: 7.5,
      cachedInputUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2.5, reservationInputUsdPerMillion: 2.5 },
    readAt: "2026-10-27",
  });
  assert.deepEqual(OPENWEIGHT_CONTEXT_WINDOWS[TERRA], { totalTokens: 922_000, readAt: "2026-10-27" });
  assert.equal(OPENWEIGHT_TEMPERATURE[TERRA], null);
  assert.equal(OPENWEIGHT_RESPONSE_FORMATS[TERRA], undefined);
  assert.equal(openWeightDeploymentReady(TERRA), true);
  assert.equal(CODEX_NOTIONAL_PRICES[TERRA], price);
  assert.equal(openWeightUsageUsd(TERRA, 100, 20, 60, 10), 0.000241);
  assert.equal(openWeightUsageUsd(TERRA, 0, 20), 0.00015);
  assert.equal(openWeightUsageUsd(TERRA, 500_000, 100), 1.00075);
  assert.equal(openWeightReservationUsd(TERRA, 100), 0.06025);
});

test("W1-T10839: the Responses deployment set carries Sol and Terra and its errors name the deployment", async (t) => {
  const declared = responses.CASH_RESPONSES_DEPLOYMENTS;
  assert.deepEqual(declared[SOL], EFFORTS);
  assert.deepEqual(declared[TERRA], ["none", ...EFFORTS]);
  const conversation = new responses.CashResponsesConversation("contract", "prompt");
  for (const model of [SOL, TERRA]) {
    for (const effort of declared[model]!) {
      assert.equal(JSON.parse(conversation.body(model, effort, 8000, [])).reasoning.effort, effort);
    }
    assert.equal(JSON.parse(conversation.body(model, "default", 8000, [])).reasoning.effort, "medium");
    assert.throws(() => conversation.body(model, "ultra", 8000, []), (error: Error) => {
      assert.ok(error.message.includes(model));
      assert.ok(error.message.includes(declared[model]!.join(", ")));
      return true;
    });
    const { dir } = ownedFixtureDir(t, "terra61-responses");
    const config = { root: dir, claudeBin: "/unused", dailyCapUsd: 50, workerProviders: {
      cashEndpoint: "https://default.openai.azure.com/",
      cashDeploymentEndpoints: { [TERRA]: {
        endpoint: "https://synthwatch-foundry-eus.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_EASTUS_API_KEY",
      } },
    } } as Config;
    writeFileSync(join(dir, "input.txt"), "verified-terra-input");
    let calls = 0;
    const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "read input.txt", tools: ["Read"], maxTurns: 2,
      runId: "terra61-responses",
      env: { RMD_OPENWEIGHT_API_KEY: "default-fixture", RMD_CASH_EASTUS_API_KEY: "eastus-fixture" },
      fetchImpl: async (url, init) => {
        calls++;
        const host = model === TERRA ? "synthwatch-foundry-eus.cognitiveservices.azure.com" : "default.openai.azure.com";
        assert.equal(String(url), `https://${host}/openai/v1/responses`);
        assert.equal((init?.headers as Record<string, string>)["api-key"], model === TERRA ? "eastus-fixture" : "default-fixture");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, model);
        assert.equal(body.reasoning.effort, model === TERRA ? "none" : "high");
        assert.equal(body.temperature, undefined);
        assert.ok(Array.isArray(body.input));
        if (calls === 2) {
          assert.equal(body.input.find((item: Record<string, unknown>) => item.type === "reasoning").encrypted_content, "encrypted");
          assert.match(body.input.find((item: Record<string, unknown>) => item.type === "function_call_output").output, /verified-terra-input/);
        }
        return Response.json({ id: "r", model, status: "completed",
          output: calls === 1 ? [
            { type: "reasoning", id: "rs", encrypted_content: "encrypted", summary: [] },
            { type: "function_call", call_id: "read-1", name: "read_file", arguments: '{"path":"input.txt"}' },
          ] : [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } } });
      } }, config, { model, effort: model === TERRA ? "none" : "high" });
    assert.equal(calls, 2);
    assert.equal(result.isError, false, result.stderr);
    assert.equal(result.text, "done");
    assert.equal(result.costUsd, 2 * openWeightUsageUsd(model, 100, 20, 60, 10));
    const lineage = readFileSync(join(dir, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).filter((row) => row.step === "worker.tool_lineage");
    assert.equal(lineage.length, 2);
    assert.ok(lineage.every((row) => row.tool_lineage.provider === "cash-responses"));
    assert.equal(lineage[1].tool_lineage.result, "success");
  }
  assert.throws(() => conversation.body(SOL, "none", 8000, []), /gpt-6\.1-sol.*none/);
  assert.throws(() => conversation.body("undeclared", "low", 8000, []), /undeclared/);
});

test("W1-T10839: cash balanced puts Terra ahead of Sol and cash frontier swaps in Terra 6.1", () => {
  for (const effort of ["low", "medium", "high"]) {
    const balanced = ["gpt-5-nano", "gpt-oss-120b", "gpt-6-luna", "gpt-5.6-luna", TERRA, SOL];
    const frontier = ["gpt-6-luna", "gpt-5.6-luna", TERRA, "gpt-5.6-terra"];
    assert.deepEqual(table.cash!.balanced[effort], balanced);
    assert.deepEqual(table.cash!.frontier[effort], frontier);
    assert.deepEqual(openWeightCandidatesForCapability(undefined, "balanced", effort), balanced);
    assert.deepEqual(openWeightCandidatesForCapability(undefined, "frontier", effort), frontier);
    assert.deepEqual(table.cash!.economy[effort], ["gpt-oss-120b", "gpt-5-nano", "gpt-6-luna", "gpt-5.6-luna", "claude-haiku-5-5"]);
    assert.deepEqual(table.codex.economy[effort], effort === "medium"
      ? ["gpt-6-luna", "gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.4-mini"]
      : ["gpt-5.3-codex-spark", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"]);
    assert.deepEqual(table.codex.balanced[effort], [SOL, "gpt-6-sol", "gpt-5.6-sol"]);
    assert.deepEqual(table.codex.frontier[effort], [SOL, "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"]);
  }
});

test("W1-T10839: the Sonnet fallback offers Terra 6.1 before Sol 6.1", (t) => {
  const { dir } = ownedFixtureDir(t, "terra61-sonnet");
  const config = { root: dir, claudeBin: "/unused", workerProviders: { cashEndpoint: "https://default.openai.azure.com/" } } as Config;
  try {
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [TERRA, SOL]);
    markOpenWeightDeploymentAbsent(TERRA);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [SOL]);
    markOpenWeightDeploymentAbsent(SOL);
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), []);
    clearOpenWeightAbsence();
    assert.deepEqual(worker.cashSonnetAlternatives("x".repeat(4_000_000), config, {}), []);
    recordCashCapacity(config, TERRA, new Headers({ "x-ratelimit-limit-tokens": "1" }), { clock: systemClock });
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), [SOL]);
    recordCashCapacity(config, SOL, new Headers({ "x-ratelimit-limit-tokens": "1" }), { clock: systemClock });
    assert.deepEqual(worker.cashSonnetAlternatives("small", config, {}), []);
    const rows = readFileSync(join(dir, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.deployment === TERRA && row.reason === "capacity_shortfall"));
    assert.ok(rows.some((row) => row.deployment === SOL && row.reason === "capacity_shortfall"));
  } finally { clearOpenWeightAbsence(); resetLearnedCashCapacity(); }
});

test("W1-T10839: the inbox bake-off trials Terra at low, medium and high", async (t) => {
  const terra = BAKEOFF_CANDIDATES.filter((candidate) => candidate.model === TERRA);
  assert.deepEqual(terra.map((candidate) => candidate.effort), ["low", "medium", "high"]);
  assert.equal(new Set(terra.map((candidate) => candidate.id)).size, 3);
  assert.ok(terra.every((candidate) => candidate.tools && candidate.billing === "cash"));
  const origin = gitRepo({ bare: true, scope: t, kind: "terra61-bakeoff-origin" });
  const seed = gitRepo({ scope: t, kind: "terra61-bakeoff-seed" });
  mkdirSync(join(seed.dir, "plan"));
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  seed.git("add", "plan/tasks.yaml");
  seed.git("commit", "-qm", "fixture");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const { dir } = ownedFixtureDir(t, "terra61-bakeoff");
  const home = join(dir, "home");
  const root = join(dir, "state-root");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
    claudeBin: "/bin/true", root, installRoot: REPO_ROOT,
  }));
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{
    id: "P1", summary: "fixture", evidenceAnchors: [{ description: "fixture", pattern: "landed" }],
  }] }));
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  process.env.HOME = home;
  console.log = () => {};
  try {
    const calls: worker.SpawnWorkerArgs[] = [];
    const code = await inboxBakeoffCommand([], async (args) => {
      calls.push(args); return {} as worker.WorkerResult;
    }, async ({ proposals, spawnFor }) => {
      for (const candidate of BAKEOFF_CANDIDATES) await spawnFor(candidate)(proposals[0]!, "fixture prompt");
      return [];
    }, (args) => {
      mkdirSync(join(root, "repos"), { recursive: true });
      seed.git("clone", "-q", origin.dir, args.at(-1)!);
    });
    assert.equal(code, 0);
    assert.equal(calls.length, BAKEOFF_CANDIDATES.length);
    for (const candidate of terra) {
      const args = calls.find((call) => call.routingTrial?.reason === `bake-off candidate ${candidate.id}`);
      assert.ok(args);
      assert.deepEqual(args.routingTrial?.models, [TERRA]);
      assert.equal(args.effort, candidate.effort);
      assert.notDeepEqual(args.tools, []);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    console.log = previousLog;
  }
});

test("W1-T10839: the successor watcher reads a deployed Terra 6.1 as ready", () => {
  const [successor] = classifySuccessors(["gpt-5.6-terra"], [{ source: "cash", models: [TERRA] }]);
  assert.equal(successor?.model, TERRA);
  assert.equal(successor.state, "ready");
  assert.equal(successor.actionable, false);
});
