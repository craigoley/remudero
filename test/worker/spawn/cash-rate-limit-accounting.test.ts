import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CashReservation } from "#src/lib/cash-accounting.js";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function assertHeld(row: CashReservation) {
  assert.ok(row.reservedUsd > 0);
  assert.equal(row.settledUsd, null, "no usage receipt can release the output ceiling");
  assert.equal(row.accountingState, "held-unknown");
  assert.equal(row.heldUsd, row.reservedUsd);
  assert.equal(row.usageEstimateUsd, null);
  assert.equal(row.billedUsd, null);
}

const fixtureSecret = "cash-accounting-fixture-not-a-credential";

async function attempt(t: TestContext, fetchImpl: typeof fetch, options: {
  model?: string; endpoint?: string; maxTurns?: number; requestTimeoutMs?: number;
  existing?: Record<string, { reservedUsd: number; settledUsd: number | null; settledReason?: string }>;
} = {}) {
  const { dir } = ownedFixtureDir(t, "cash-rate-limit-accounting");
  const clock = fixedClock(Date.now());
  if (options.existing) {
    mkdirSync(join(dir, "state"));
    writeFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), JSON.stringify({
      utcDay: clock.iso().slice(0, 10), fleetCapUsd: 25, reservations: options.existing,
    }));
  }
  const result = await spawnOpenWeightWorker({
    cwd: dir, workerHome: dir, prompt: "bounded accounting replay", tools: [],
    maxTurns: options.maxTurns ?? 3,
    env: { RMD_OPENWEIGHT_API_KEY: fixtureSecret, RMD_FOUNDRY_CLAUDE_API_KEY: fixtureSecret,
      RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://fixture.cognitiveservices.azure.com/anthropic" },
    clock, requestTimeoutMs: options.requestTimeoutMs ?? 1000, fetchImpl,
  }, { root: dir, dailyCapUsd: 25, workerProviders: {
    cashEndpoint: options.endpoint ?? "https://fixture.openai.azure.com/",
  } } as Config, { model: options.model ?? "gpt-6-luna", effort: "low" });
  const allowance = JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as {
    reservations: Record<string, CashReservation>;
  };
  return { result, rows: Object.values(allowance.reservations), reservations: allowance.reservations };
}

test("cash rate-limit accounting zero-settles only definite Azure OpenAI throttles", async t => {
  for (const model of ["gpt-5-nano", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna", "gpt-6.1-sol"]) {
    await t.test(model, async child => {
      let calls = 0;
      const { result, rows } = await attempt(child, async () => { calls++; return new Response(null, { status: 429 }); }, {
        model, ...(model === "gpt-6.1-sol" ? { endpoint: "https://fixture.cognitiveservices.azure.com/" } : {}),
      });
      assert.equal(calls, 1, "no retry without a server cooldown");
      assert.equal(result.isError, true);
      assert.match(result.stderr, /HTTP 429/);
      assert.equal(result.budgetRefused, false, "a provider refusal is not a local cap refusal");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.settledUsd, 0);
      assert.equal(result.budgetSettledUsd, 0);
      assert.match(rows[0]!.settledReason!, /HTTP 429/);
    });
  }
});

test("cash rate-limit accounting preserves fresh reservations and server cooldown on retry", async t => {
  const bodies: string[] = [];
  const { result, rows } = await attempt(t, async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? new Response(null, { status: 429, headers: { "retry-after-ms": "1" } })
      : Response.json({ id: "successful-retry", model: "gpt-6-luna-2026-09-22",
        usage: { prompt_tokens: 1000, completion_tokens: 2 },
        choices: [{ finish_reason: "stop", message: { content: "DONE" } }] });
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], "the retry uses the same payload");
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.numTurns, 2, "a refused request still consumes the existing attempt bound");
  assert.equal(rows.length, 2, "the successful retry gets a distinct reservation");
  assert.equal(rows[0]!.settledUsd, 0);
  assert.equal(rows[1]!.settledUsd, 0.000101);
  assert.equal(result.budgetSettledUsd, rows[1]!.settledUsd);
});

test("cash rate-limit accounting keeps retry estimates conservative outside verified Azure endpoints", async t => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol"]) {
    const bodies: string[] = [];
    const { result, rows } = await attempt(t, async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return new Response(null, { status: 429, headers: { "retry-after-ms": "1" } });
      return model === "gpt-6.1-sol"
        ? Response.json({ id: "conservative-response", model, status: "completed",
          usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [{ type: "message", content: [{ type: "output_text", text: "DONE" }] }] })
        : Response.json({ id: "conservative-chat", model, usage: { prompt_tokens: 10, completion_tokens: 2 },
          choices: [{ finish_reason: "stop", message: { content: "DONE" } }] });
    }, { model, endpoint: "https://fixture.invalid/" });
    assert.equal(result.isError, false, result.stderr);
    assert.equal(result.text, "DONE");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(rows.length, 2);
    assertHeld(rows[0]!);
    assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
    assert.equal(result.budgetSettledUsd, rows[0]!.reservedUsd + rows[1]!.settledUsd!);
    assert.equal(result.usageEstimateUsd, null);
  }
});

test("cash rate-limit accounting does not remove the request-attempt ceiling", async t => {
  let calls = 0;
  const { result, rows } = await attempt(t, async () => {
    calls++; return new Response(null, { status: 429, headers: { "retry-after-ms": "1" } });
  }, { maxTurns: 2 });
  assert.equal(calls, 2);
  assert.equal(result.numTurns, 2);
  assert.equal(result.isError, true);
  assert.match(result.stderr, /HTTP 429/);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.settledUsd), [0, 0]);
});

test("cash rate-limit accounting refuses a cooldown outside the original deadline", async t => {
  let calls = 0;
  const { result, rows } = await attempt(t, async () => {
    calls++; return new Response(null, { status: 429, headers: { "retry-after-ms": "2000" } });
  });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.equal(rows[0]!.settledUsd, 0);
});

test("cash rate-limit accounting keeps unknown endpoint and open-weight refusals conservative", async t => {
  for (const options of [{ endpoint: "https://fixture.invalid/" },
    { endpoint: "https://fixture.openai.azure.com.evil.invalid/" },
    { endpoint: "https://fixture.openai.azure.com:8443/" }, { model: "gpt-oss-120b" }]) {
    const { result, rows } = await attempt(t, async () => new Response(null, { status: 429 }), options);
    assert.equal(result.isError, true);
    assertHeld(rows[0]!);
    assert.equal(result.budgetSettledUsd, rows[0]!.reservedUsd);
    assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
  }
});

test("cash rate-limit accounting does not grant Foundry Claude an OpenAI billing rule", async t => {
  const { result, rows } = await attempt(t, async () => new Response(null, { status: 429 }), { model: "claude-haiku-5-5" });
  assert.equal(result.isError, true);
  assert.equal(rows[0]!.settledUsd, null, "the Claude adapter retains its conservative reservation");
});

test("cash rate-limit accounting keeps uncertain transport and spoofed errors charged", async t => {
  for (const error of [new TypeError("fixture transport unavailable"), Object.assign(new Error("HTTP 429"), { status: 429 })]) {
    const { result, rows } = await attempt(t, async () => { throw error; });
    assert.equal(result.isError, true);
    assertHeld(rows[0]!);
    assert.equal(result.budgetSettledUsd, rows[0]!.reservedUsd);
    assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
  }
});

test("cash rate-limit accounting keeps other HTTP failures charged", async t => {
  for (const status of [400, 500, 503]) {
    const { result, rows } = await attempt(t, async () => new Response(null, { status }));
    assert.equal(result.isError, true);
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assertHeld(rows[0]!);
    assert.equal(result.budgetSettledUsd, rows[0]!.reservedUsd);
    assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
  }
});

test("cash rate-limit accounting keeps an unobserved timeout charged", async t => {
  const { result, rows } = await attempt(t, async () => new Promise<Response>(() => {}), { requestTimeoutMs: 100 });
  assert.equal(result.isError, true);
  assert.match(result.stderr, /exceeded 100ms/);
  assertHeld(rows[0]!);
  assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
});

test("cash rate-limit accounting preserves the existing definite deployment-absence settlement", async t => {
  const { result, rows } = await attempt(t, async () => new Response(null, { status: 404 }));
  assert.equal(result.isError, true);
  assert.equal(rows[0]!.settledUsd, 0);
});

test("cash rate-limit accounting does not rewrite earlier charges or unsettled reservations", async t => {
  const existing = { "older-failure": { reservedUsd: 1, settledUsd: 0.75, settledReason: "earlier input estimate" },
    "unknown-inflight": { reservedUsd: 1.75, settledUsd: null } };
  const { result, reservations } = await attempt(t, async () => new Response(null, { status: 429 }), { existing });
  assert.equal(result.budgetSettledUsd, 0);
  for (const [id, row] of Object.entries(existing)) assert.deepEqual(reservations[id], row);
});

test("cash rate-limit accounting still reserves against the fixed cap before transport", async t => {
  let calls = 0;
  const existing = { spent: { reservedUsd: 24.9999, settledUsd: 24.9999 } };
  const { result, reservations } = await attempt(t, async () => {
    calls++; return new Response(null, { status: 429 });
  }, { existing });
  assert.equal(calls, 0);
  assert.equal(result.budgetRefused, true);
  assert.equal(result.subtype, "cash_allowance_exhausted");
  assert.deepEqual(reservations, existing);
});
