import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const fixtureSecret = "cash-accounting-fixture-not-a-credential";

async function attempt(t: TestContext, fetchImpl: typeof fetch, prompt = "bounded accounting replay", tools: string[] = []) {
  const { dir } = ownedFixtureDir(t, "cash-request-accounting");
  writeFileSync(join(dir, "evidence.txt"), "one real contained tool result");
  const result = await spawnOpenWeightWorker({
    cwd: dir, workerHome: dir, prompt, tools, maxTurns: 3,
    env: { RMD_OPENWEIGHT_API_KEY: fixtureSecret }, clock: fixedClock(Date.now()),
    requestTimeoutMs: 1000, fetchImpl,
  }, { root: dir, dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://fixture.invalid/" } } as Config,
  { model: "gpt-6-luna", effort: "low" });
  const allowance = JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as {
    reservations: Record<string, { reservedUsd: number; settledUsd: number | null; settledReason?: string }>;
  };
  return { result, rows: Object.values(allowance.reservations) };
}

test("cash accounting replay keeps a definite rate-limit refusal separate from billed input", async t => {
  let calls = 0;
  const { result, rows } = await attempt(t, async () => {
    calls++;
    return new Response(null, { status: 429 });
  });
  assert.equal(calls, 1, "no retry without a server cooldown");
  assert.equal(result.isError, true);
  assert.match(result.stderr, /HTTP 429/);
  assert.equal(result.budgetRefused, false, "a provider refusal is not a local cap refusal");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.settledUsd, 0, "a definite Azure OpenAI throttle did not process the input");
  assert.equal(result.budgetSettledUsd, 0);
});

test("cash accounting replay preserves nested Chat cache receipt categories", async t => {
  const { result } = await attempt(t, async () => Response.json({
    id: "cache-receipt", model: "gpt-6-luna-2026-09-22",
    usage: { prompt_tokens: 1000, completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } },
    choices: [{ finish_reason: "stop", message: { content: "DONE" } }],
  }));
  assert.equal(result.isError, false);
  assert.deepEqual(result.tokens, { input: 1000, output: 1, cacheRead: 800, cacheCreation: 100 });
});

test("cash accounting replay prices each successful turn at its own context tier", async t => {
  let calls = 0;
  const { result, rows } = await attempt(t, async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    calls++;
    if (calls === 2) assert.ok(request.messages.some(x => x.role === "tool" && x.content.includes("one real contained tool result")));
    return Response.json({ id: `turn-${calls}`, model: "gpt-6-luna-2026-09-22",
      usage: { prompt_tokens: 200000, completion_tokens: 5 },
      choices: [{ finish_reason: calls === 1 ? "tool_calls" : "stop", message: calls === 1
        ? { content: null, tool_calls: [{ id: "contained-read", type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) } }] }
        : { content: "DONE" } }],
    });
  }, "x".repeat(300000), ["Read"]);
  assert.equal(calls, 2);
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.tokens.input, 400000);
  assert.equal(rows.length, 2);
  const settled = rows.reduce((sum, row) => sum + row.settledUsd!, 0);
  assert.equal(settled, 0.040005);
  assert.equal(result.costUsd, settled, "two short-context requests do not become one long-context request");
});

test("cash accounting replay leaves uncertain transport failure conservatively charged", async t => {
  const { result, rows } = await attempt(t, async () => { throw new TypeError("fixture transport unavailable"); });
  assert.equal(result.isError, true);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.settledUsd! > 0);
  assert.equal(result.budgetSettledUsd, rows[0]!.settledUsd);
  assert.ok(rows[0]!.settledUsd! < rows[0]!.reservedUsd);
});

test("cash accounting replay keeps bad-request input conservatively charged", async t => {
  const { result, rows } = await attempt(t, async () => new Response(null, { status: 400 }));
  assert.equal(result.isError, true);
  assert.match(result.stderr, /HTTP 400/);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.settledUsd! > 0);
  assert.equal(result.budgetSettledUsd, rows[0]!.settledUsd);
});
