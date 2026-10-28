/**
 * W1-T10856 -- A CASH DEPLOYMENT LEARNS ITS PER-MINUTE TOKEN CEILING FROM ITS OWN RESPONSES.
 *
 * `x-ratelimit-limit-tokens` is a second fit ceiling beside the context window: learned per
 * deployment from every response, gating selection before transport, and a 429 whose own request
 * exceeds the limit that same response reported is a capacity shortfall that is never retried.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import {
  CASH_CAPACITY_FILENAME,
  CASH_CAPACITY_LEDGER_STEP,
  cashCapacityReadiness,
  learnedCashLimit,
  openWeightDeploymentHolds,
  resetLearnedCashCapacity,
  selectOpenWeightModel,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const AT_ISO = "2026-10-27T12:00:00.000Z";
const DEPLOYMENT = "gpt-5-nano";
const ENDPOINT = "https://synthwatch-foundry.cognitiveservices.azure.com/";
const KEY = "fixture-not-a-credential";

function configFor(root: string): Config {
  return { claudeBin: "/unused", root, dailyCapUsd: 25, workerProviders: { enabled: ["cash"], cashEndpoint: ENDPOINT } } as Config;
}

function limitHeaders(limit: string, renewal = "60"): Record<string, string> {
  return { "content-type": "application/json", "x-ratelimit-limit-tokens": limit, "x-ratelimit-renewalperiod-tokens": renewal };
}

function completion(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({
    id: "fixture", model: "served-fixture", usage: { prompt_tokens: 10, completion_tokens: 2 },
    choices: [{ finish_reason: "stop", message: { content: "DONE" } }],
  }), { status: 200, headers });
}

async function spawnCash(root: string, prompt: string, fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, maxTurns = 1) {
  return spawnOpenWeightWorker({
    cwd: root, workerHome: root, prompt, tools: [], maxTurns, env: { RMD_OPENWEIGHT_API_KEY: KEY },
    clock: fixedClock(Date.parse(AT_ISO)), fetchImpl,
  } as never, configFor(root), { model: DEPLOYMENT, effort: "low" });
}

function ledgerRows(root: string): Array<Record<string, unknown>> {
  const path = ledgerPathFor({ root });
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W1-T10856: a response teaches the deployment its per-minute token ceiling", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-learn");
  assert.equal(learnedCashLimit(DEPLOYMENT), undefined, "nothing is declared: a deployment starts with no learned limit");

  const first = await spawnCash(dir, "p", async () => completion(limitHeaders("20000")));
  assert.equal(first.isError, false, first.stderr);
  assert.equal(learnedCashLimit(DEPLOYMENT), 20000);
  const state = JSON.parse(readFileSync(join(dir, "state", CASH_CAPACITY_FILENAME), "utf8")) as Record<string, Record<string, unknown>>;
  assert.deepEqual(state[DEPLOYMENT], { limitTokens: 20000, renewalSeconds: 60, observedAt: AT_ISO });
  const rows = () => ledgerRows(dir).filter((row) => row.step === CASH_CAPACITY_LEDGER_STEP);
  assert.equal(rows().length, 1);
  assert.deepEqual({ d: rows()[0]!.deployment, l: rows()[0]!.limit_tokens, r: rows()[0]!.renewal_seconds, p: rows()[0]!.previous_limit_tokens },
    { d: DEPLOYMENT, l: 20000, r: 60, p: null });

  await spawnCash(dir, "p", async () => completion(limitHeaders("20000")));
  assert.equal(rows().length, 1, "an unchanged limit writes no ledger row");

  await spawnCash(dir, "p", async () => completion(limitHeaders("450000")));
  assert.equal(learnedCashLimit(DEPLOYMENT), 450000, "a changed limit replaces the old one");
  assert.equal(rows().length, 2);
  assert.equal(rows()[1]!.previous_limit_tokens, 20000);

  // A header that is not a bare integer teaches nothing and never reaches the file or the ledger.
  const { dir: other } = ownedFixtureDir(t, "cash-capacity-junk");
  resetLearnedCashCapacity();
  await spawnCash(other, "p", async () => completion(limitHeaders("20000 tokens; drop table", "sixty")));
  assert.equal(learnedCashLimit(DEPLOYMENT), undefined);
  assert.equal(existsSync(join(other, "state", CASH_CAPACITY_FILENAME)), false);
  assert.equal(ledgerRows(other).filter((row) => row.step === CASH_CAPACITY_LEDGER_STEP).length, 0);

  // A restart re-reads the file: a fresh process table is hydrated from it on the next cash spawn.
  resetLearnedCashCapacity();
  await spawnCash(dir, "p", async () => completion({ "content-type": "application/json" }));
  assert.equal(learnedCashLimit(DEPLOYMENT), 450000);
});

test("W1-T10856: a request above the learned ceiling walks the ladder before transport", (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const estimatedTokens = 100_000;
  const promptBytes = estimatedTokens * 4;
  const options = { ready: () => true };

  // Control: with no learned limit the deployment is gated by its context window alone.
  const before = selectOpenWeightModel(undefined, "sonnet", "low", promptBytes, options);
  assert.equal(before.model, DEPLOYMENT);
  assert.equal(before.capacityShortfalls, undefined);

  const { dir } = ownedFixtureDir(t, "cash-capacity-walk");
  // The deployment answers once, at a 20,000 TPM ceiling.
  const reported: unknown[] = [];
  return spawnCash(dir, "p", async () => completion(limitHeaders("20000"))).then(() => {
    assert.equal(openWeightDeploymentHolds(DEPLOYMENT, estimatedTokens), false, "the learned limit is the smaller ceiling");
    assert.equal(openWeightDeploymentHolds(DEPLOYMENT, 1_000), true, "a small request still fits");
    const after = selectOpenWeightModel(undefined, "sonnet", "low", promptBytes, {
      ...options, onCapacityShortfall: (row) => reported.push(row),
    });
    assert.notEqual(after.model, DEPLOYMENT, "selection walks to the next candidate");
    assert.equal(after.model, "gpt-oss-120b");
    const expected = { reason: "capacity_shortfall", deployment: DEPLOYMENT, estimatedTokens, limitTokens: 20000 };
    assert.deepEqual(after.capacityShortfalls, [expected]);
    assert.deepEqual(reported, [expected]);
    // The readiness seam answers from the same learned limit.
    assert.deepEqual(cashCapacityReadiness(learnedCashLimit(DEPLOYMENT), 108_000),
      { state: "shortfall", limitTokens: 20000, shortfallTokens: 88_000 });
    assert.deepEqual(cashCapacityReadiness(20000, 20000), { state: "covered", limitTokens: 20000 });
    assert.deepEqual(cashCapacityReadiness(undefined, 1), { state: "unlearned" });
  });
});

test("W1-T10856: an oversized 429 is a capacity shortfall and is never retried", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-429");
  let calls = 0;
  const oversized = await spawnCash(dir, "x".repeat(400_000), async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "RateLimitReached" } }), {
      status: 429, headers: { ...limitHeaders("20000"), "retry-after-ms": "1" },
    });
  }, 3);
  assert.equal(calls, 1, "the request can never fit, so it is not retried after retry-after");
  assert.equal(oversized.isError, true);
  assert.match(oversized.stderr, /capacity_shortfall/);
  assert.equal(learnedCashLimit(DEPLOYMENT), 20000, "the limit it reported is recorded for the next request");
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, 100_000), false, "the next request skips the deployment pre-transport");

  // Control: a 429 under the limit keeps today's transient handling and retries after retry-after.
  const { dir: small } = ownedFixtureDir(t, "cash-capacity-429-small");
  let smallCalls = 0;
  const retried = await spawnCash(small, "p", async () => {
    smallCalls += 1;
    return smallCalls === 1
      ? new Response("{}", { status: 429, headers: { ...limitHeaders("20000"), "retry-after-ms": "1" } })
      : completion(limitHeaders("20000"));
  }, 3);
  assert.equal(smallCalls, 2);
  assert.equal(retried.isError, false, retried.stderr);
});
