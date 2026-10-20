import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "../helpers/owned-fixture-dir.js";

const requestId = "3a2c1a77-453a-4cad-9165-a6bb1cb26400";
const secret = "test-only-private-key-do-not-record";

async function refusal(t: TestContext, response: Response, model = "gpt-6-luna") {
  const { dir } = ownedFixtureDir(t, "cash-http-evidence");
  let calls = 0;
  const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "private prompt", tools: [],
    env: { RMD_OPENWEIGHT_API_KEY: secret, RMD_FOUNDRY_CLAUDE_API_KEY: secret,
      RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
    clock: fixedClock(Date.now()), fetchImpl: async () => { calls++; return response; },
  }, { root: dir, dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://foundry.example.test/" } } as Config,
  { model, effort: "low" });
  const allowance = readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8");
  return { result, calls, allowance };
}

test("cash HTTP refusals retain allowlisted rate evidence through every real adapter without retrying", async t => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"]) {
    await t.test(model, async child => {
      const { result, calls, allowance } = await refusal(child, new Response("private response body", { status: 429, headers: {
        "retry-after-ms": "1500", "retry-after": "9", "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "42", "apim-request-id": requestId,
        "authorization": secret, "api-key": secret, "set-cookie": secret,
      } }), model);
      assert.equal(result.isError, true);
      assert.equal(result.subtype, "openweight_error");
      assert.equal(result.budgetRefused, false);
      assert.equal(calls, 1, "observing a refusal adds no paid retry");
      for (const literal of ['"retry_after_ms":1500', '"remaining_requests":0', '"remaining_tokens":42', `"request_id":"${requestId}"`]) {
        assert.ok(result.stderr.includes(literal), result.stderr);
        assert.ok(allowance.includes(literal.replaceAll('"', '\\"')), "existing settlement reason retains the same evidence");
      }
      for (const hidden of [secret, "private response body", "private prompt", "authorization", "api-key", "set-cookie"])
        assert.equal(result.stderr.includes(hidden), false);
    });
  }
});

test("cash HTTP diagnostics preserve zero and fall back to valid seconds without inventing unreadable values", async t => {
  const { result } = await refusal(t, new Response("untrusted error body", { status: 503, headers: {
    "retry-after-ms": "not-a-number", "retry-after": "0", "x-ratelimit-remaining-requests": "-1",
    "x-ratelimit-remaining-tokens": "9007199254740992", "x-request-id": requestId,
  } }));
  assert.match(result.stderr, /HTTP 503/);
  assert.ok(result.stderr.includes('"retry_after_ms":0'));
  assert.ok(result.stderr.includes(`"request_id":"${requestId}"`));
  assert.equal(result.stderr.includes("remaining_"), false);
  assert.equal(result.stderr.includes("not-a-number"), false);
});

test("cash HTTP diagnostics omit arbitrary header text and never read the failure body", async t => {
  for (const value of ["1.5", "NaN", "Infinity", "9e3", "-5", "9007199254740992", secret]) {
    const response = new Response(secret, { status: 429, headers: {
      "retry-after-ms": value, "retry-after": value,
      "x-ratelimit-remaining-requests": value, "x-ratelimit-remaining-tokens": value,
      "apim-request-id": value, "x-request-id": value, "x-private-header": secret,
    } });
    Object.defineProperty(response, "json", { value: () => { throw Error("must not consume an error body"); } });
    const { result } = await refusal(t, response);
    assert.equal(result.stderr, "openweight request failed with HTTP 429");
  }
});

test("cash HTTP diagnostics retain the original status when the response headers are unreadable", async t => {
  const response = new Response(secret, { status: 429 });
  Object.defineProperty(response, "headers", { get() { throw Error(secret); } });
  const { result } = await refusal(t, response);
  assert.match(result.stderr, /HTTP 429/);
  assert.ok(result.stderr.includes('"diagnostics":"unreadable"'));
  assert.equal(result.stderr.includes(secret), false);
});

test("cash HTTP observation leaves missing deployments and conservative settlements distinct", async t => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"]) {
    const { result, calls } = await refusal(t, new Response(secret, { status: 404, headers: { "retry-after-ms": "1500" } }), model);
    assert.equal(result.openWeightDeploymentAbsent, model);
    assert.equal(result.budgetSettledUsd, 0);
    assert.equal(calls, 1);
    assert.equal(result.stderr.includes("retry_after"), false);
  }
});
