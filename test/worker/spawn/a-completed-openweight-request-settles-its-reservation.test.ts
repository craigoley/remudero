import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { CashRequestIdentity } from "#src/lib/cash-accounting.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OpenWeightAllowanceExhaustedError,
  openWeightCommittedUsd,
  openWeightUsageUsd,
  reserveOpenWeightBudget,
  settleOpenWeightBudget,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function readAllowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8"));
}

const models = ["gpt-oss-120b", "gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"];
const env = { RMD_CASH_EASTUS_API_KEY: "mapped-fixture-only",
  RMD_FOUNDRY_CLAUDE_API_KEY: "fixture-only",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://mapped.example.test/anthropic" };

function receipt(model: string, adapterError = false) {
  if (model === "claude-haiku-5-5") return { usage: { input_tokens: 10, output_tokens: 2 },
    content: adapterError ? [null] : [{ type: "text", text: "completed" }], stop_reason: "end_turn" };
  if (model === "gpt-6.1-sol") return { status: "completed",
    usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    output: adapterError ? [null] : [{ type: "message", content: [{ type: "output_text", text: "completed" }] }] };
  return { usage: { prompt_tokens: 10, completion_tokens: 2 },
    choices: adapterError ? [] : [{ message: { content: "completed" }, finish_reason: "stop" }] };
}

test("W1-T10954: real and duplicate settlement evidence affects only its exact request once while preserving all caps", async t => {
  for (const model of models) for (const failure of ["none", "adapter", "observer", "rolled-day", "observer-rollover"]) {
    await t.test(`${model} midnight receipt with ${failure}`, async child => {
      const { dir } = ownedFixtureDir(child, "cash-midnight-receipt");
      const day = new Date().toISOString().slice(0, 10);
      const reservedAt = `${day}T23:59:59.990Z`;
      let now = Date.parse(reservedAt);
      const clock = { now: () => now, iso: () => new Date(now).toISOString() };
      const config = { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: {
        cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
      } } as Config;
      let before!: OpenWeightAllowanceState;
      let afterObserver: OpenWeightAllowanceState | undefined;
      let otherId = "";
      let calls = 0;
      const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
        env, streamObserver: event => {
          if (event.kind !== "working" || !failure.startsWith("observer")) return;
          if (failure === "observer-rollover") {
            const settled = readAllowance(dir);
            const [requestId, own] = Object.entries(before.reservations).find(([id]) => id !== otherId)!;
            assert.equal(settled.reservations[requestId]!.settledUsd, openWeightUsageUsd(model, 10, 2));
            reserveOpenWeightBudget(config, { requestId: "observer-new-day",
              identity: { ...own.identity!, requestId: "observer-new-day" }, deployment: model,
              requestBodyBytes: 100, atIso: clock.iso() });
            afterObserver = readAllowance(dir);
          }
          throw new Error("fixture working observer failed");
        }, fetchImpl: async url => {
          calls++;
          assert.equal(new URL(String(url)).hostname, "mapped.example.test");
          const own = Object.values(readAllowance(dir).reservations)[0]!;
          otherId = "other-request";
          reserveOpenWeightBudget(config, { requestId: otherId,
            identity: { ...own.identity!, requestId: otherId, attemptId: "other-attempt" },
            deployment: model, requestBodyBytes: 100, atIso: reservedAt,
            extraInputTokens: model === "claude-haiku-5-5" ? 4_900_000 : 0 });
          before = readAllowance(dir);
          config.dailyCapUsd = openWeightCommittedUsd(before);
          now += 20;
          if (failure === "rolled-day") {
            reserveOpenWeightBudget(config, { requestId: "new-day-request",
              identity: { ...own.identity!, requestId: "new-day-request", attemptId: "new-day-attempt" },
              deployment: model, requestBodyBytes: 100, atIso: clock.iso() });
            before = readAllowance(dir);
          }
          return Response.json(receipt(model, failure === "adapter"));
        } }, config, { model, effort: "low" });
      const state = readAllowance(dir);
      assert.equal(calls, 1);
      assert.equal(result.isError, failure === "adapter" || failure.startsWith("observer"));
      assert.equal(result.tokens.input, 10);
      assert.equal(result.tokens.output, 2);
      assert.equal(result.billedUsd, null);
      if (failure === "rolled-day") {
        assert.deepEqual(state, before, "an old receipt cannot reset or settle the next day's allowance");
        assert.equal(result.budgetHeldUsd, result.budgetReservedUsd);
        assert.equal(result.usageEstimateUsd, null, "a settlement that was not recorded must not be reported");
        return;
      }
      const [requestId, own] = Object.entries(before.reservations).find(([id]) => id !== otherId)!;
      const actualUsd = openWeightUsageUsd(model, 10, 2);
      if (failure === "observer-rollover") {
        assert.ok(afterObserver, "the observer opened the next day's allowance after usage settled");
        assert.deepEqual(state, afterObserver);
        assert.equal(result.budgetSettledUsd, actualUsd);
        assert.equal(result.budgetHeldUsd, 0);
        assert.equal(result.usageEstimateUsd, actualUsd, "preserve recorded usage through a later observer failure");
        return;
      }
      assert.equal(state.utcDay, day);
      assert.deepEqual(state.reservations[requestId], { ...own, settledUsd: actualUsd,
        accountingState: "usage-rated", usageEstimateUsd: actualUsd, heldUsd: 0 });
      assert.deepEqual(state.reservations[otherId], before.reservations[otherId]);
      assert.equal(result.budgetSettledUsd, actualUsd);
      assert.equal(result.costUsd, actualUsd);
      assert.equal(result.budgetHeldUsd, 0);
      assert.equal(result.usageEstimateUsd, actualUsd);
      assert.equal(openWeightCommittedUsd(state), actualUsd + state.reservations[otherId]!.reservedUsd);
      settleOpenWeightBudget(config, { requestId, identity: own.identity, actualUsd: 0, atIso: reservedAt });
      assert.deepEqual(readAllowance(dir), state, "a duplicate cannot change the first receipt or another request");
      assert.throws(() => reserveOpenWeightBudget(config, { requestId: "over-cap", deployment: model,
        requestBodyBytes: 20_000_000, atIso: reservedAt }), OpenWeightAllowanceExhaustedError);
      assert.deepEqual(readAllowance(dir), state, "settlement preserves cap enforcement");
      if (model === "claude-haiku-5-5") {
        config.dailyCapUsd = 25;
        assert.throws(() => reserveOpenWeightBudget(config, { requestId: "over-subcap", deployment: model,
          requestBodyBytes: 200_000, atIso: reservedAt }), (error: unknown) =>
          error instanceof OpenWeightAllowanceExhaustedError && error.limit === "foundry-claude");
        assert.deepEqual(readAllowance(dir), state, "the provider subcap still counts the other request's hold");
      }
    });
  }

  for (const rolledDay of [false, true]) await t.test(`brokered midnight search with rolledDay=${rolledDay}`, async child => {
    const { dir } = ownedFixtureDir(child, "cash-midnight-search");
    let now = Date.parse(`${new Date().toISOString().slice(0, 10)}T23:59:59.990Z`);
    const reservedAt = new Date(now).toISOString();
    const clock = { now: () => now, iso: () => new Date(now).toISOString() };
    const model = "gpt-6-luna";
    const config = { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: { cashWebSearch: true,
      cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
    } } as Config;
    let before!: OpenWeightAllowanceState;
    let searchId = "";
    let calls = 0;
    const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: ["WebSearch"],
      maxTurns: 2, clock, env: { ...env, RMD_CASH_WEB_SEARCH_API_KEY: "search-fixture-only" },
      fetchImpl: async url => {
        calls++;
        assert.equal(new URL(String(url)).hostname, "mapped.example.test");
        if (!String(url).includes("/openai/responses")) return Response.json({ ...receipt(model),
          choices: [{ message: { content: null, tool_calls: [
            { id: "search", function: { name: "web_search", arguments: '{"query":"fixture"}' } },
            { id: "invalid", function: { name: "undeclared", arguments: "{}" } },
          ] } }] });
        before = readAllowance(dir);
        searchId = Object.keys(before.reservations).find(id => id.includes("-search-"))!;
        assert.ok(searchId, "the broker reserved its own request before sending");
        now += 20;
        if (rolledDay) {
          const identity = before.reservations[searchId]!.identity!;
          reserveOpenWeightBudget(config, { requestId: "new-day-request",
            identity: { ...identity, requestId: "new-day-request" }, deployment: model,
            requestBodyBytes: 100, atIso: clock.iso() });
          before = readAllowance(dir);
        }
        return Response.json({ usage: { input_tokens: 10, output_tokens: 2 },
          output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "found",
            annotations: [{ type: "url_citation", url: "https://example.test/source" }] }] }] });
      } }, config, { model, effort: "low" });
    const state = readAllowance(dir);
    assert.equal(calls, 2);
    assert.equal(result.isError, true);
    assert.match(result.stderr, /undeclared tool/);
    assert.equal(result.webSearchAccepted, 1);
    if (rolledDay) {
      assert.deepEqual(state, before);
      assert.ok(result.budgetHeldUsd > 0);
      assert.equal(result.usageEstimateUsd, null);
      return;
    }
    const actualUsd = openWeightUsageUsd(model, 10, 2);
    assert.equal(state.utcDay, reservedAt.slice(0, 10));
    assert.equal(state.reservations[searchId]!.settledUsd, actualUsd);
    assert.equal(state.reservations[searchId]!.heldUsd, 0);
    for (const id of Object.keys(before.reservations).filter(id => id !== searchId))
      assert.deepEqual(state.reservations[id], before.reservations[id]);
    assert.equal(result.budgetHeldUsd, 0);
    assert.equal(result.usageEstimateUsd, 2 * actualUsd);
    assert.equal(result.budgetSettledUsd, openWeightCommittedUsd(state));
  });

  for (const model of models) for (const phase of ["fetch", "body"]) await t.test(`${model} late ${phase} settles its own held attempt`, async child => {
    const { dir } = ownedFixtureDir(child, "cash-late-body");
    let now = Date.parse(`${new Date().toISOString().slice(0, 10)}T23:59:59.990Z`);
    const clock = { now: () => now, iso: () => new Date(now).toISOString() };
    const reservedAt = clock.iso();
    const config = { root: dir, dailyCapUsd: 25, workerProviders: {
      cashEndpoint: "https://default.example.test/",
      cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
    } } as Config;
    let deliver!: () => void;
    let calls = 0;
    const ready = new Promise<void>(resolve => { deliver = resolve; });
    const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
      requestTimeoutMs: 20, env, fetchImpl: async url => {
        calls++;
        assert.equal(new URL(String(url)).hostname, "mapped.example.test");
        if (phase === "fetch") await ready;
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "json", { value: async () => {
          if (phase === "body") await ready;
          return receipt(model, true);
        } });
        return response;
      } }, config, { model, effort: "low" });
    const before = readAllowance(dir);
    const [requestId, held] = Object.entries(before.reservations)[0]!;
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.equal(held.settledUsd, null);
    assert.equal(result.budgetHeldUsd, held.reservedUsd);
    assert.equal(result.usageEstimateUsd, null);
    assert.equal(held.identity?.deployment, model);
    assert.equal(new URL(held.identity!.endpoint).hostname, "mapped.example.test");
    const other: CashRequestIdentity = { ...held.identity!, requestId: "another-request", attemptId: "another-attempt" };
    const reserve = (identity: CashRequestIdentity) => reserveOpenWeightBudget(config, {
      requestId: identity.requestId, identity, deployment: model, requestBodyBytes: 100, atIso: clock.iso(),
    });
    const otherReservation = reserve(other);
    config.dailyCapUsd = held.reservedUsd + otherReservation.reservedUsd;
    assert.throws(() => reserve({ ...other, requestId: "third-request" }), OpenWeightAllowanceExhaustedError);
    const beforeReceipt = readAllowance(dir);
    now += 20;
    deliver();
    await new Promise<void>(resolve => setImmediate(resolve));
    const settled = readAllowance(dir);
    const actualUsd = openWeightUsageUsd(model, 10, 2);
    assert.equal(settled.reservations[requestId]!.settledUsd, actualUsd);
    assert.equal(settled.reservations[requestId]!.heldUsd, 0);
    assert.equal(settled.reservations[requestId]!.billedUsd, null);
    assert.equal(settled.reservations[requestId]!.usageEstimateUsd, actualUsd);
    assert.deepEqual(settled.reservations[other.requestId], beforeReceipt.reservations[other.requestId]);
    settleOpenWeightBudget(config, { requestId, identity: held.identity, actualUsd: 0, atIso: reservedAt });
    assert.deepEqual(readAllowance(dir), settled, "a duplicate cannot revise the late receipt");
    reserveOpenWeightBudget(config, { requestId: "third-request", identity: { ...other, requestId: "third-request" },
      deployment: model, requestBodyBytes: 100, atIso: reservedAt });
    assert.equal(calls, 1, "settlement never issues a replacement request");
  });

  for (const model of models) for (const failure of ["http", "unreadable", "invalid-usage"]) {
    await t.test(`${model} late fetch ${failure} keeps its original hold`, async child => {
      const { dir } = ownedFixtureDir(child, "cash-late-unknown");
      const clock = fixedClock(Date.now());
      const config = { root: dir, dailyCapUsd: 25, workerProviders: {
        cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
      } } as Config;
      let deliver!: () => void;
      const ready = new Promise<void>(resolve => { deliver = resolve; });
      let reads = 0;
      const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
        requestTimeoutMs: 20, env, fetchImpl: async () => {
          await ready;
          const response = new Response(null, { status: failure === "http" ? 503 : 200 });
          Object.defineProperty(response, "json", { value: async () => {
            reads++;
            if (failure === "unreadable") throw new Error("fixture body unreadable");
            return failure === "invalid-usage" ? { ...receipt(model), usage: { input_tokens: 10,
              prompt_tokens: 10, output_tokens: -1, completion_tokens: -1 } } : receipt(model);
          } });
          return response;
        } }, config, { model, effort: "low" });
      const before = readAllowance(dir);
      const held = Object.values(before.reservations)[0]!;
      assert.equal(result.isError, true);
      assert.equal(result.budgetHeldUsd, held.reservedUsd);
      deliver();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(reads, failure === "http" ? 0 : 1);
      assert.deepEqual(readAllowance(dir), before, "failed late evidence cannot change money or attempt identity");
      assert.equal(held.settledUsd, null);
      assert.equal(held.usageEstimateUsd, null);
      assert.equal(held.billedUsd, null);
    });
  }

  for (const model of models) {
    for (const adapterError of [false, true]) await t.test(`${model} adapterError=${adapterError}`, async child => {
      const { dir } = ownedFixtureDir(child, "cash-usage-settlement");
      const clock = fixedClock(Date.now());
      const config = { root: dir, dailyCapUsd: 25, workerProviders: {
        cashEndpoint: "https://default.example.test/",
        cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
      } } as Config;
      let calls = 0;
      const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
        env, fetchImpl: async url => {
          calls++;
          assert.equal(new URL(String(url)).hostname, "mapped.example.test");
          return Response.json(receipt(model, adapterError));
        } }, config, { model, effort: "low" });
      const state = readAllowance(dir);
      const [requestId, row] = Object.entries(state.reservations)[0]!;
      const actualUsd = openWeightUsageUsd(model, 10, 2);
      assert.equal(calls, 1);
      assert.equal(result.isError, adapterError);
      assert.equal(row.settledUsd, actualUsd, "valid usage settles even when the adapter later rejects the reply");
      assert.equal(row.accountingState, "usage-rated");
      assert.equal(row.heldUsd, 0);
      assert.equal(row.usageEstimateUsd, actualUsd);
      assert.equal(row.billedUsd, null, "usage-rated estimates are not invoices");
      assert.equal(result.usageEstimateUsd, actualUsd);
      assert.equal(result.budgetHeldUsd, 0);
      assert.equal(result.billedUsd, null);
      assert.equal(result.tokens.input, 10);
      assert.equal(result.tokens.output, 2);
      assert.equal(openWeightCommittedUsd(state), actualUsd);
      assert.equal(row.identity?.deployment, model);
      assert.equal(new URL(row.identity!.endpoint).hostname, "mapped.example.test");
      settleOpenWeightBudget(config, { requestId, identity: row.identity, actualUsd: 0, atIso: clock.iso() });
      assert.deepEqual(readAllowance(dir), state, "a duplicate cannot revise the first settlement");
    });
  }

  await t.test("late receipt requires every identity field and settles only once", child => {
    const { dir } = ownedFixtureDir(child, "cash-late-receipt");
    const config = { root: dir, dailyCapUsd: 25 } as Config;
    const atIso = new Date().toISOString();
    const identity: CashRequestIdentity = { requestId: "request", attemptId: "attempt", provider: "cash",
      deployment: "gpt-6-luna", endpoint: "https://mapped.example.test/chat/completions" };
    const reserve = (id: CashRequestIdentity) => reserveOpenWeightBudget(config, { requestId: id.requestId, identity: id,
      deployment: id.deployment, requestBodyBytes: 100, atIso });
    reserve(identity);
    reserve({ ...identity, requestId: "other-request", attemptId: "other-attempt" });
    settleOpenWeightBudget(config, { requestId: identity.requestId, identity, reason: "reply unreadable", atIso });
    const held = readAllowance(dir);
    for (const key of ["requestId", "attemptId", "provider", "deployment", "endpoint"] as const) {
      settleOpenWeightBudget(config, { requestId: identity.requestId,
        identity: { ...identity, [key]: "wrong" } as CashRequestIdentity, actualUsd: 0, atIso });
      assert.deepEqual(readAllowance(dir), held, `${key} mismatch must not release another attempt`);
    }
    for (const actualUsd of [NaN, Infinity, -1]) {
      settleOpenWeightBudget(config, { requestId: identity.requestId, identity, actualUsd, atIso });
      assert.deepEqual(readAllowance(dir), held, "invalid money is not a receipt");
    }
    const actualUsd = openWeightUsageUsd(identity.deployment, 10, 2);
    settleOpenWeightBudget(config, { requestId: identity.requestId, identity, actualUsd, atIso });
    const settled = readAllowance(dir);
    assert.equal(settled.reservations.request!.settledUsd, actualUsd);
    assert.equal(settled.reservations.request!.heldUsd, 0);
    assert.deepEqual(settled.reservations["other-request"], held.reservations["other-request"]);
    settleOpenWeightBudget(config, { requestId: identity.requestId, identity, actualUsd: 0, atIso });
    assert.deepEqual(readAllowance(dir), settled);
    assert.throws(() => reserve(identity), /already reserved/);
    const nextDay = new Date(Date.parse(atIso) + 86_400_000).toISOString();
    settleOpenWeightBudget(config, { requestId: "other-request", identity: held.reservations["other-request"]!.identity,
      actualUsd: 0, atIso: nextDay });
    assert.deepEqual(readAllowance(dir), settled, "wrong-day late evidence cannot reset the allowance");
  });

  for (const limit of ["fleet", "foundry-claude"] as const) await t.test(`${limit} counts held cash until exact settlement`, child => {
    const { dir } = ownedFixtureDir(child, "cash-held-cap");
    const config = { root: dir, dailyCapUsd: 25 } as Config;
    const atIso = new Date().toISOString();
    const identity: CashRequestIdentity = { requestId: "held", attemptId: "attempt", provider: "cash",
      deployment: "claude-haiku-5-5", endpoint: "https://foundry.example.test/anthropic/v1/messages" };
    const reserve = (requestId: string, extraInputTokens: number) => reserveOpenWeightBudget(config, {
      requestId, identity: { ...identity, requestId }, deployment: identity.deployment,
      requestBodyBytes: 100, extraInputTokens, atIso,
    });
    const first = reserve("held", 4_950_000);
    if (limit === "fleet") config.dailyCapUsd = first.reservedUsd;
    settleOpenWeightBudget(config, { requestId: "held", identity, reason: "no usage", atIso });
    assert.throws(() => reserve("next", 100_000), (error: unknown) =>
      error instanceof OpenWeightAllowanceExhaustedError && error.limit === limit);
    assert.equal(Object.keys(readAllowance(dir).reservations).length, 1);
    settleOpenWeightBudget(config, { requestId: "held", identity, actualUsd: 0.01, atIso });
    reserve("next", 100_000);
    const state = readAllowance(dir);
    assert.equal(state.reservations.held!.settledUsd, 0.01);
    assert.equal(state.reservations.next!.settledUsd, null);
    assert.ok(openWeightCommittedUsd(state) < Math.min(5, config.dailyCapUsd as number));
  });
});
