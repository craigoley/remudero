/**
 * W1-T10856 -- A CASH DEPLOYMENT LEARNS ITS PER-MINUTE TOKEN CEILING FROM ITS OWN RESPONSES.
 *
 * `x-ratelimit-limit-tokens` is a second fit ceiling beside the context window: learned per
 * deployment from every response, gating selection before transport, and a 429 whose own request
 * exceeds the limit that same response reported is a capacity shortfall that is never retried.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import {
  CASH_TPM_STATE_FILE,
  CASH_TPM_OBSERVED_STEP,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OpenWeightRequestTooLargeError,
  cashCapacityReadiness,
  learnedCashLimit,
  openWeightDeploymentHolds,
  resetLearnedCashCapacity,
  selectOpenWeightModel,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { runOpenWeightWalkingLadder, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
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

async function spawnCash(root: string, prompt: string, fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, maxTurns = 1, config = configFor(root), model = DEPLOYMENT) {
  return spawnOpenWeightWorker({
    cwd: root, workerHome: root, prompt, tools: [], maxTurns, env: { RMD_OPENWEIGHT_API_KEY: KEY },
    clock: fixedClock(Date.parse(AT_ISO)), fetchImpl,
  } as never, config, { model, effort: "low" });
}

function observedRows(root: string): Array<Record<string, unknown>> {
  const path = ledgerPathFor({ root });
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W1-T10856: a response teaches the deployment its per-minute token ceiling", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-learn");
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), undefined, "nothing is declared: a deployment starts with no learned limit");

  const first = await spawnCash(dir, "p", async () => completion(limitHeaders("20000")));
  assert.equal(first.isError, false, first.stderr);
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 20000);
  const state = JSON.parse(readFileSync(join(dir, "state", CASH_TPM_STATE_FILE), "utf8")) as Record<string, Record<string, unknown>>;
  assert.deepEqual(state[JSON.stringify([ENDPOINT.replace(/\/+$/, ""), DEPLOYMENT])], { limitTokens: 20000, renewalSeconds: 60, observedAt: AT_ISO });
  const rows = () => observedRows(dir).filter((row) => row.step === CASH_TPM_OBSERVED_STEP);
  assert.equal(rows().length, 1);
  assert.deepEqual({ d: rows()[0]!.deployment, l: rows()[0]!.limit_tokens, r: rows()[0]!.renewal_seconds, p: rows()[0]!.previous_limit_tokens },
    { d: DEPLOYMENT, l: 20000, r: 60, p: null });

  await spawnCash(dir, "p", async () => completion(limitHeaders("20000")));
  assert.equal(rows().length, 1, "an unchanged limit writes no ledger row");

  await spawnCash(dir, "p", async () => completion(limitHeaders("450000")));
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 450000, "a changed limit replaces the old one");
  assert.equal(rows().length, 2);
  assert.equal(rows()[1]!.previous_limit_tokens, 20000);

  const movedEndpoint = "https://another-foundry.cognitiveservices.azure.com/";
  const moved = configFor(dir);
  moved.workerProviders!.cashDeploymentEndpoints = { [DEPLOYMENT]: { endpoint: movedEndpoint, keyEnv: "RMD_OPENWEIGHT_API_KEY" } };
  assert.equal(learnedCashLimit(DEPLOYMENT, movedEndpoint), undefined);
  assert.equal(selectOpenWeightModel(undefined, "sonnet", "low", 400_000, { config: moved, ready: () => true }).model, DEPLOYMENT,
    "the new endpoint cannot inherit the old endpoint's quota");
  await spawnCash(dir, "p", async () => completion(limitHeaders("20000")), 1, moved);
  assert.equal(rows().length, 3);
  assert.equal(rows()[2]!.endpoint, movedEndpoint);
  assert.equal(rows()[2]!.previous_limit_tokens, null, "first observation belongs to the new endpoint");
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 450000);
  assert.equal(learnedCashLimit(DEPLOYMENT, movedEndpoint), 20000);
  resetLearnedCashCapacity();
  assert.equal(selectOpenWeightModel(undefined, "sonnet", "low", 400_000, { config: moved, ready: () => true }).model, "gpt-oss-120b");
  assert.equal(selectOpenWeightModel(undefined, "sonnet", "low", 400_000, { config: configFor(dir), ready: () => true }).model, DEPLOYMENT);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, "state", CASH_TPM_STATE_FILE), "utf8"))).length, 2);

  // A header that is not a bare integer teaches nothing and never reaches the file or the ledger.
  const { dir: other } = ownedFixtureDir(t, "cash-capacity-junk");
  resetLearnedCashCapacity();
  await spawnCash(other, "p", async () => completion(limitHeaders("20000 tokens; drop table", "sixty")));
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), undefined);
  assert.equal(existsSync(join(other, "state", CASH_TPM_STATE_FILE)), false);
  assert.equal(observedRows(other).filter((row) => row.step === CASH_TPM_OBSERVED_STEP).length, 0);

  // A restart re-reads the file: a fresh process table is hydrated from it on the next cash spawn.
  resetLearnedCashCapacity();
  await spawnCash(dir, "p", async () => completion({ "content-type": "application/json" }));
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 450000);
});

test("cash chat and Responses learn on success and failure using bounded unsigned headers", async t => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  for (const model of [DEPLOYMENT, "gpt-6.1-sol"]) {
    const { dir } = ownedFixtureDir(t, "cash-capacity-apis");
    const ok = await spawnCash(dir, "p", async () => model === DEPLOYMENT ? completion(limitHeaders("30000"))
      : Response.json({ id: "response", model, status: "completed", usage: { input_tokens: 10, output_tokens: 2 },
        output: [{ type: "message", content: [{ type: "output_text", text: "DONE" }] }] }, { headers: limitHeaders("30000") }),
    1, configFor(dir), model);
    assert.equal(ok.isError, false, ok.stderr);
    assert.equal(learnedCashLimit(model, ENDPOINT), 30000);
    const failed = await spawnCash(dir, "p", async () => new Response("{}", { status: 503, headers: limitHeaders("25000", "120") }),
      1, configFor(dir), model);
    assert.equal(failed.isError, true);
    assert.equal(learnedCashLimit(model, ENDPOINT), 25000);
    assert.equal(observedRows(dir).filter(row => row.step === CASH_TPM_OBSERVED_STEP).length, 2);
    await spawnCash(dir, "p", async () => completion(limitHeaders("25000", "60")), 1, configFor(dir), model);
    assert.equal(observedRows(dir).filter(row => row.step === CASH_TPM_OBSERVED_STEP).length, 2, "renewal alone emits no quota change");
    for (const invalid of ["-1", "1.5", "9007199254740992", "12345678901234567"]) {
      await spawnCash(dir, "p", async () => completion(limitHeaders(invalid)), 1, configFor(dir), model);
      assert.equal(learnedCashLimit(model, ENDPOINT), 25000);
    }
    await spawnCash(dir, "p", async () => completion(limitHeaders("0")), 1, configFor(dir), model);
    assert.equal(learnedCashLimit(model, ENDPOINT), 0, "zero is a valid unsigned quota cut");
  }
});

test("W1-T10856: a state file that cannot be read or written never fails the request it rode on", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-unrecordable");
  const logged: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { logged.push(String(line)); });
  // The state path is a directory by the time the response lands (after the pre-spawn hydrate), so
  // the record step throws when it reads the file back.
  const result = await spawnCash(dir, "p", async () => {
    mkdirSync(join(dir, "state", CASH_TPM_STATE_FILE), { recursive: true });
    return completion(limitHeaders("20000"));
  });
  assert.equal(result.isError, false, result.stderr);
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), undefined, "nothing was learned from the unrecordable response");
  const failures = logged.map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.event === "cash.capacity.record_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.deployment, DEPLOYMENT);
  assert.equal(typeof failures[0]!.reason, "string");
  assert.match(String(failures[0]!.reason), /EISDIR/);
  const selected = selectOpenWeightModel(undefined, "sonnet", "low", 400_000, { config: configFor(dir), ready: () => true });
  assert.equal(selected.model, DEPLOYMENT, "unreadable persisted state leaves the context-only gate usable");
  assert.ok(logged.some(line => {
    const row = JSON.parse(line);
    return row.event === "cash.capacity.state_unreadable" && /EISDIR/.test(row.reason);
  }));
  const { dir: corrupt } = ownedFixtureDir(t, "cash-capacity-corrupt");
  mkdirSync(join(corrupt, "state"));
  writeFileSync(join(corrupt, "state", CASH_TPM_STATE_FILE), "{torn");
  assert.equal(selectOpenWeightModel(undefined, "sonnet", "low", 400_000, { config: configFor(corrupt), ready: () => true }).model, DEPLOYMENT);
  const repaired = await spawnCash(corrupt, "p", async () => completion(limitHeaders("30000")));
  assert.equal(repaired.isError, false, repaired.stderr);
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 30000);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(corrupt, "state", CASH_TPM_STATE_FILE), "utf8"))).length, 1);
});

async function driveCash(root: string, prompt: string, fetchImpl: NonNullable<Parameters<typeof spawnOpenWeightWorker>[0]["fetchImpl"]>,
  onFallbackAttempt?: SpawnWorkerArgs["onModelFallbackAttempt"]) {
  const models: string[] = [];
  const estimates: number[] = [];
  const result = await spawnWorker({
    cwd: root, settingsFile: join(REPO_ROOT, "settings/worker.json"), permissionMode: "bypassPermissions",
    config: configFor(root), model: "sonnet", effort: "low", mountProvider: "cash", prompt, tools: [], maxTurns: 3,
    runId: "capacity-run", taskId: "W1-T10856", onModelFallbackAttempt: onFallbackAttempt,
    providerRouting: { spawnOpenWeight: async (args, config, selection) => {
      models.push(selection.model);
      estimates.push(Math.ceil(Buffer.byteLength(args.prompt, "utf8") / 4));
      return await spawnOpenWeightWorker({ ...args, env: { RMD_OPENWEIGHT_API_KEY: KEY },
        clock: fixedClock(Date.parse(AT_ISO)), fetchImpl } as never, config, selection) as WorkerResult;
    } },
  });
  return { result, models, estimates };
}

test("W1-T10856: a request above the learned ceiling walks the ladder before transport", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-walk");
  const estimatedTokens = 100_000;
  const prompt = "x".repeat(estimatedTokens * 4);
  const options = { ready: () => true, config: configFor(dir), runId: "capacity-run", taskId: "W1-T10856" };
  assert.equal(selectOpenWeightModel(undefined, "sonnet", "low", prompt.length, options).model, DEPLOYMENT);
  await spawnCash(dir, "p", async () => completion(limitHeaders("20000")));
  resetLearnedCashCapacity();
  const transported: string[] = [];
  const { result, models, estimates } = await driveCash(dir, prompt, async (url) => {
    transported.push(String(url));
    return completion({ "content-type": "application/json" });
  });
  assert.equal(result.isError, false, result.stderr);
  assert.deepEqual(models, ["gpt-oss-120b"], "the first production selection after restart skips nano");
  assert.equal(transported.length, 1);
  assert.match(transported[0]!, /gpt-oss-120b/);
  const rows = observedRows(dir).filter(row => row.reason === "capacity_shortfall");
  assert.equal(rows.length, 1, "production selection records the reason without an injected callback");
  assert.equal(rows[0]!.deployment, DEPLOYMENT);
  assert.equal(rows[0]!.estimated_tokens, estimates[0], "the event uses the prepared production prompt's estimate");
  assert.ok(estimates[0]! >= estimatedTokens);
  assert.equal(rows[0]!.limit_tokens, 20000);
  assert.equal(rows[0]!.run_id, "capacity-run");
  assert.equal(rows[0]!.task_id, "W1-T10856");
  const limit = learnedCashLimit(DEPLOYMENT, ENDPOINT);
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, estimatedTokens, limit), false);
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, 1_000, limit), true);
  const remainingPromptTokens = limit! - OPENWEIGHT_MAX_COMPLETION_TOKENS;
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, remainingPromptTokens, limit), true, "completion allowance is included exactly");
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, remainingPromptTokens + 1, limit), false);
  assert.throws(() => selectOpenWeightModel(undefined, "sonnet", "low", prompt.length, { ...options, only: [DEPLOYMENT] }),
    (error: unknown) => error instanceof OpenWeightRequestTooLargeError && /learned per-minute limit 20000/.test(error.message));
  assert.deepEqual(cashCapacityReadiness(limit, 108_000),
    { state: "shortfall", limitTokens: 20000, shortfallTokens: 88_000 });
  assert.deepEqual(cashCapacityReadiness(20000, 20000), { state: "covered", limitTokens: 20000 });
  assert.deepEqual(cashCapacityReadiness(undefined, 1), { state: "unlearned" });
});

test("W1-T10856: an oversized 429 is a capacity shortfall and is never retried", async (t) => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-429");
  const transported: string[] = [];
  const attempts: NonNullable<WorkerResult["openWeightCapacityShortfall"]>[] = [];
  const reasons: string[] = [];
  let failedEstimate = 0;
  const { result: oversized, models } = await driveCash(dir, "x".repeat(400_000), async (url, init) => {
    transported.push(String(url));
    if (String(url).includes(DEPLOYMENT)) {
      failedEstimate = Math.ceil(Buffer.byteLength(String(init?.body), "utf8") / 4);
      return new Response(JSON.stringify({ error: { code: "RateLimitReached" } }), {
        status: 429, headers: { ...limitHeaders("20000"), "retry-after-ms": "1" },
      });
    }
    return completion({ "content-type": "application/json" });
  }, attempt => {
    reasons.push(attempt.reason);
    if (attempt.result?.openWeightCapacityShortfall) attempts.push(attempt.result.openWeightCapacityShortfall);
  });
  assert.deepEqual(models, [DEPLOYMENT, "gpt-oss-120b"], "the same production run advances to its next alternative");
  assert.equal(transported.length, 2, "one failed request and one alternative, without retrying the oversized request");
  assert.equal(oversized.isError, false, oversized.stderr);
  assert.equal(oversized.routedModel, "gpt-oss-120b");
  assert.deepEqual(reasons, ["capacity_shortfall"]);
  assert.deepEqual(attempts, [{ reason: "capacity_shortfall", deployment: DEPLOYMENT, estimatedTokens: failedEstimate, limitTokens: 20000 }]);
  const rows = observedRows(dir).filter(row => row.reason === "capacity_shortfall");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.estimated_tokens, failedEstimate);
  assert.equal(rows[0]!.limit_tokens, 20000);
  assert.equal(learnedCashLimit(DEPLOYMENT, ENDPOINT), 20000);
  assert.equal(openWeightDeploymentHolds(DEPLOYMENT, 100_000, learnedCashLimit(DEPLOYMENT, ENDPOINT)), false);
  const next = await driveCash(dir, "x".repeat(400_000), async () => completion({ "content-type": "application/json" }));
  assert.deepEqual(next.models, ["gpt-oss-120b"], "the next request skips the deployment before transport");
  assert.equal(next.result.isError, false, next.result.stderr);

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

test("a capacity-shortfall walk survives a failed fallback telemetry sink and retains an exhausted result", async t => {
  resetLearnedCashCapacity();
  t.after(resetLearnedCashCapacity);
  const { dir } = ownedFixtureDir(t, "cash-capacity-walk-telemetry");
  const logs: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { logs.push(String(line)); });
  const calls: string[] = [];
  const run = async ({ model }: { model: string }) => {
    calls.push(model);
    return await spawnCash(dir, "x".repeat(400_000), async () => model === DEPLOYMENT
      ? new Response("{}", { status: 429, headers: { ...limitHeaders("20000"), "retry-after-ms": "1" } })
      : completion({ "content-type": "application/json" }), 3, configFor(dir), model) as WorkerResult;
  };
  const selection = { model: DEPLOYMENT, effort: "low", capability: "balanced" as const, alternatives: ["gpt-oss-120b"] };
  const result = await runOpenWeightWalkingLadder(run, selection, () => { throw new Error("fixture telemetry unavailable"); });
  assert.equal(result.isError, false, result.stderr);
  assert.deepEqual(calls, [DEPLOYMENT, "gpt-oss-120b"]);
  assert.ok(logs.some(line => {
    const row = JSON.parse(line);
    return row.event === "worker.openweight.rung_telemetry_unavailable" && /fixture telemetry unavailable/.test(row.reason);
  }));
  const exhausted = await runOpenWeightWalkingLadder(run, { ...selection, alternatives: [] });
  assert.equal(exhausted.isError, true);
  assert.equal(exhausted.openWeightCapacityShortfall?.deployment, DEPLOYMENT);
  assert.equal(exhausted.openWeightCapacityShortfall?.limitTokens, 20000);
  assert.match(exhausted.stderr, /capacity_shortfall/);
});
