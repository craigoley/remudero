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

test("W1-T10954: real and duplicate settlement evidence affects only its exact request once while preserving all caps", async t => {
  for (const model of ["gpt-oss-120b", "gpt-6-luna", "gpt-6.1-sol"]) await t.test(`${model} late body settles its own held attempt`, async child => {
    const { dir } = ownedFixtureDir(child, "cash-late-body");
    const clock = fixedClock(Date.now());
    const config = { root: dir, dailyCapUsd: 25, workerProviders: {
      cashEndpoint: "https://mapped.example.test/",
    } } as Config;
    let deliverBody!: (value: unknown) => void;
    let calls = 0;
    const body = new Promise<unknown>(resolve => { deliverBody = resolve; });
    const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
      requestTimeoutMs: 20, env: { RMD_OPENWEIGHT_API_KEY: "fixture-only" }, fetchImpl: async () => {
        calls++;
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "json", { value: () => body });
        return response;
      } }, config, { model, effort: "low" });
    const before = readAllowance(dir);
    const [requestId, held] = Object.entries(before.reservations)[0]!;
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.equal(held.settledUsd, null);
    assert.equal(result.budgetHeldUsd, held.reservedUsd);
    const other: CashRequestIdentity = { ...held.identity!, requestId: "another-request", attemptId: "another-attempt" };
    const reserve = (identity: CashRequestIdentity) => reserveOpenWeightBudget(config, {
      requestId: identity.requestId, identity, deployment: model, requestBodyBytes: 100, atIso: clock.iso(),
    });
    const otherReservation = reserve(other);
    config.dailyCapUsd = held.reservedUsd + otherReservation.reservedUsd;
    assert.throws(() => reserve({ ...other, requestId: "third-request" }), OpenWeightAllowanceExhaustedError);
    const beforeReceipt = readAllowance(dir);
    deliverBody(model === "gpt-6.1-sol"
      ? { status: "completed", usage: { input_tokens: 10, output_tokens: 2,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        output: [{ type: "message", content: [{ type: "output_text", text: "late" }] }] }
      : { usage: { prompt_tokens: 10, completion_tokens: 2 },
        choices: [{ message: { content: "late" }, finish_reason: "stop" }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    const settled = readAllowance(dir);
    const actualUsd = openWeightUsageUsd(model, 10, 2);
    assert.equal(settled.reservations[requestId]!.settledUsd, actualUsd);
    assert.equal(settled.reservations[requestId]!.heldUsd, 0);
    assert.deepEqual(settled.reservations[other.requestId], beforeReceipt.reservations[other.requestId]);
    settleOpenWeightBudget(config, { requestId, identity: held.identity, actualUsd: 0, atIso: clock.iso() });
    assert.deepEqual(readAllowance(dir), settled, "a duplicate cannot revise the late receipt");
    reserve({ ...other, requestId: "third-request" });
    assert.equal(calls, 1, "settlement never issues a replacement request");
  });

  for (const model of ["gpt-oss-120b", "gpt-6-luna"]) {
    for (const adapterError of [false, true]) await t.test(`${model} adapterError=${adapterError}`, async child => {
      const { dir } = ownedFixtureDir(child, "cash-usage-settlement");
      const clock = fixedClock(Date.now());
      const config = { root: dir, dailyCapUsd: 25, workerProviders: {
        cashEndpoint: "https://default.example.test/",
        cashDeploymentEndpoints: { [model]: { endpoint: "https://mapped.example.test/", keyEnv: "RMD_CASH_EASTUS_API_KEY" } },
      } } as Config;
      let calls = 0;
      const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "fixture", tools: [], clock,
        env: { RMD_CASH_EASTUS_API_KEY: "mapped-fixture-only" }, fetchImpl: async url => {
          calls++;
          assert.equal(new URL(String(url)).hostname, "mapped.example.test");
          return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: adapterError ? [] : [{ message: { content: "completed" }, finish_reason: "stop" }] });
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
