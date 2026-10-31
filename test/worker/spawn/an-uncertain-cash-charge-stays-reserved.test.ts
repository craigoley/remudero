import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  openWeightCommittedUsd,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("W1-T10954: an invoked request with unreadable reply and no usage retains its reserve as held unknown", async t => {
  const failures: Record<string, () => Promise<Response>> = {
    transport: async () => { throw Error("fixture transport lost"); },
    parse: async () => new Response('{"unfinished":'),
    unreadable: async () => {
      const response = new Response("body");
      Object.defineProperty(response, "json", { value: async () => { throw Error("fixture body unreadable"); } });
      return response;
    },
    truncated: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    missingUsage: async () => Response.json({ choices: [{ message: { content: "answer without receipt" } }] }),
    invalidUsage: async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: -1 },
      choices: [{ message: { content: "answer without trustworthy receipt" } }] }),
    unavailable: async () => new Response(null, { status: 503 }),
  };
  for (const model of ["gpt-oss-120b", "gpt-6-luna"]) {
    for (const [failure, reply] of Object.entries(failures)) await t.test(`${model} ${failure}`, async child => {
      const { dir } = ownedFixtureDir(child, "cash-held-unknown");
      const clock = fixedClock(Date.now());
      const config = { root: dir, dailyCapUsd: 25,
        workerProviders: { cashEndpoint: "https://cash.example.test/" } } as Config;
      let calls = 0;
      let endpoint = "";
      const args = { cwd: dir, workerHome: dir, prompt: "bounded fixture", tools: [], clock,
        env: { RMD_OPENWEIGHT_API_KEY: "fixture-only" },
        fetchImpl: async (url: string | URL | Request) => { calls++; endpoint = String(url); return reply(); } };
      const result = await spawnOpenWeightWorker(args, config, { model, effort: "low" });
      const read = () => JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
      const state = read();
      const entries = Object.entries(state.reservations);
      assert.equal(calls, 1, "one invoked attempt, without a paid retry");
      assert.equal(entries.length, 1);
      const [requestId, row] = entries[0]!;
      assert.ok(row.reservedUsd > 0);
      assert.equal(row.settledUsd, null, "no usage must not release the output reservation");
      assert.equal(row.accountingState, "held-unknown");
      assert.equal(row.heldUsd, row.reservedUsd);
      assert.equal(row.usageEstimateUsd, null);
      assert.equal(row.billedUsd, null);
      assert.equal(row.identity?.requestId, requestId);
      assert.ok(row.identity?.attemptId);
      assert.equal(row.identity?.provider, "cash");
      assert.equal(row.identity?.deployment, model);
      const url = new URL(endpoint);
      assert.equal(row.identity?.endpoint, `${url.origin}${url.pathname}`);
      assert.equal(openWeightCommittedUsd(state), row.reservedUsd);
      assert.equal(result.budgetHeldUsd, row.reservedUsd);
      assert.equal(result.usageEstimateUsd, null);
      assert.equal(result.billedUsd, null);
      assert.equal(result.tokenUsageState, failure === "invalidUsage" ? "partial" : "unavailable");
      assert.equal(result.tokens.input, failure === "invalidUsage" ? 10 : 0);
      assert.equal(result.tokens.output, 0, "invalid or missing output tokens remain unobserved");
      assert.equal(result.isError, !["missingUsage", "invalidUsage"].includes(failure));

      config.dailyCapUsd = row.reservedUsd;
      const blocked = await spawnOpenWeightWorker(args, config, { model, effort: "low" });
      assert.equal(blocked.budgetRefused, true, "uncertainty consumes the existing cap");
      assert.equal(calls, 1, "cap refusal happens before transport");
      assert.deepEqual(read().reservations, state.reservations, "refusal preserves the exact attempt");
    });
  }
});
