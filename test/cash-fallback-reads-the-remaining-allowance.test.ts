import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import * as provider from "#src/lib/worker-provider.js";
import { cashAllowanceFallbackRefusal, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { reviewerOutcome } from "#src/lib/review.js";
import { finishTransientRetry, implementAttemptOutcome, runDiagnoseThenRetry } from "#test/helpers/run-task-test.js";

const NOW = Date.parse("2026-10-17T09:50:29.000Z"), ISO = fixedClock(NOW).iso();
const RESET = "2026-10-18T00:00:00.000Z";
function fixture(t: test.TestContext, committed = 24.95) {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-room-"));
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true,
      cashEndpoint: "https://foundry.example.test/" } };
  const path = provider.openWeightAllowancePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ utcDay: "2026-10-17", reservations: {
    earlier: { reservedUsd: committed, settledUsd: null, deployment: "gpt-6-luna" },
  } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config, path };
}
function blockedArgs(f: ReturnType<typeof fixture>, cash: () => void): SpawnWorkerArgs {
  return { cwd: f.root, config: f.config, prompt: "x".repeat(300_000), model: "haiku", tools: [],
    settingsFile: join(process.cwd(), "settings/worker.json"), permissionMode: "bypassPermissions",
    routingTrial: { id: "fixture-only", arm: "cash", reason: "fixture candidate", models: ["gpt-6-luna"] },
    providerRouting: { now: () => NOW, writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => ({ provider: "claude", readable: false, windows: [], detail: "fixture blocked" }),
      readCodex: async () => ({ provider: "codex", readable: false, windows: [], detail: "fixture blocked" }),
      spawnOpenWeight: async () => { cash(); return { provider: "cash", text: "ran", isError: false } as WorkerResult; } } };
}
async function capResult(f: ReturnType<typeof fixture>) {
  return provider.spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "x".repeat(300_000),
    env: { RMD_OPENWEIGHT_API_KEY: "fixture-only-key" }, clock: fixedClock(NOW), tools: [],
    fetchImpl: async () => { throw new Error("transport must not run"); } },
  f.config, { model: "gpt-6-luna", effort: "low" });
}

test("W1-T10040: an exhausted allowance refuses the cash fallback and names its reset", async t => {
  const f = fixture(t); let cash = 0, api = 0;
  const args = blockedArgs(f, () => cash++);
  args.config = { ...f.config, overflow: "api_key" };
  args.env = { ANTHROPIC_API_KEY: "fixture-only-never-spend" };
  args.queryFn = (() => { api++; throw new Error("no new overflow spend"); }) as never;
  await assert.rejects(() => spawnWorker(args), /cash daily allowance exhausted until 2026-10-18T00:00:00.000Z/);
  assert.equal(cash, 0);
  assert.equal(api, 0);
});

test("W1-T10040: an allowance with room still takes the cash fallback", async t => {
  const f = fixture(t, 0); let cash = 0;
  const result = await spawnWorker(blockedArgs(f, () => cash++));
  assert.equal(result.text, "ran");
  assert.equal(cash, 1);
});

test("W1-T10040: a cap refusal is cash_allowance_exhausted not an api error", async t => {
  const result = await capResult(fixture(t));
  assert.equal(result.isError, true);
  assert.equal(result.budgetRefused, true);
  assert.equal(result.apiError, false);
  assert.equal(result.subtype, "cash_allowance_exhausted");
  assert.equal(result.cashAllowanceResetAt, RESET);
  assert.equal(result.costUsd, 0);
});

test("W1-T10040: a cap-refused reviewer is recorded as cash_allowance_exhausted", async t => {
  const worker = await capResult(fixture(t));
  assert.equal(reviewerOutcome({ attempted: true, subtype: worker.subtype, exit: worker.exit }), "cash_allowance_exhausted");
});

test("W1-T10040: the retry driver stops on a cap refusal and names it", async t => {
  const f = fixture(t);
  const worker = await capResult(f);
  let attempts = 0, diagnoses = 0, judges = 0, removals = 0;
  const sleeps: number[] = [], rows: Array<{ step: string } & Record<string, unknown>> = [];
  const result = await runDiagnoseThenRetry({ now: () => NOW,
    attempt: async () => { attempts++; return implementAttemptOutcome(worker); },
    diagnose: async () => { diagnoses++; return { text: "unused" }; },
    sleep: async ms => { sleeps.push(ms); },
    fixProgressJudge: async () => { judges++; return undefined; } });
  assert.equal(result.outcome, "gave_up");
  assert.equal(attempts, 1);
  assert.equal(diagnoses, 0);
  assert.equal(judges, 0);
  assert.deepEqual(sleeps, []);
  assert.equal(result.strikes, 0);
  assert.match(result.reason ?? "", /cash daily allowance exhausted until 2026-10-18T00:00:00.000Z/);
  const terminal = finishTransientRetry(result, { taskId: "FIXTURE", runId: "fixture", repoDir: f.root,
    worktreePath: f.root, costUsd: 0, worker, log: (step, extra) => rows.push({ step, ...extra }), say: () => {} },
  () => { removals++; });
  assert.equal(terminal?.verdict, "blocked_transient");
  const verdict = rows.find(row => row.step === "verdict");
  assert.match(String(verdict?.reason), /cash daily allowance exhausted until 2026-10-18T00:00:00.000Z/);
  assert.doesNotMatch(String(verdict?.reason), /repeated transient API error|fix progress/);
  assert.equal(removals, 0);
  assert.ok(rows.some(row => row.step === "worktree.retained"));
});

test("cash allowance observation is read-only and shares normal squeezed fleet and Claude limits", t => {
  const f = fixture(t, 3);
  assert.equal(typeof provider.readOpenWeightAllowance, "function");
  const observe = (model: string, squeezed = false) => provider.readOpenWeightAllowance(f.config,
    { deployments: [model], atIso: ISO, squeezed });
  const before = readFileSync(f.path, "utf8"), mtime = statSync(f.path).mtimeMs;
  f.config.dailyCapUsd = { normal: 4, squeezed: 25 };
  assert.equal(observe("gpt-6-luna").deployments[0]?.remainingUsd, 1);
  assert.equal(observe("gpt-6-luna", true).deployments[0]?.remainingUsd, 22);
  assert.equal(readFileSync(f.path, "utf8"), before);
  assert.equal(statSync(f.path).mtimeMs, mtime);
  f.config.workerProviders!.fleetCashAllowancePath = f.path;
  writeFileSync(f.path, JSON.stringify({ utcDay: "2026-10-17", fleetCapUsd: 3.5,
    reservations: { a: { reservedUsd: 3, settledUsd: null, deployment: "gpt-6-luna" } } }));
  assert.equal(observe("gpt-6-luna", true).deployments[0]?.remainingUsd, 0.5);
  writeFileSync(f.path, JSON.stringify({ utcDay: "2026-10-17", fleetCapUsd: 100,
    reservations: { a: { reservedUsd: 3, settledUsd: null, deployment: "claude-haiku-5-5" },
      b: { reservedUsd: 1, settledUsd: 0.5, deployment: "gpt-6-luna" } } }));
  f.config.dailyCapUsd = 100;
  const claude = observe("claude-haiku-5-5");
  assert.equal(claude.deployments[0]?.remainingUsd, provider.FOUNDRY_CLAUDE_DAILY_CAP_USD.normal - 3);
  assert.equal(observe("claude-haiku-5-5", true).deployments[0]?.remainingUsd, provider.FOUNDRY_CLAUDE_DAILY_CAP_USD.squeezed - 3);
  assert.equal(observe("gpt-6-luna").deployments[0]?.remainingUsd, 96.5);
  writeFileSync(f.path, "{broken");
  assert.throws(() => observe("gpt-6-luna"), /unreadable/);
  rmSync(f.path);
  assert.throws(() => observe("gpt-6-luna"), /missing/);
  assert.equal(existsSync(f.path), false);
});

test("cash observation preserves UTC rollover unknown data and every reservation refusal", t => {
  const f = fixture(t);
  const observe = () => provider.readOpenWeightAllowance(f.config, { deployments: ["gpt-6-luna"], atIso: ISO });
  for (const body of ["null", "1", "{}", JSON.stringify({ utcDay: "2026-10-17", reservations: [] }),
    JSON.stringify({ utcDay: "2026-10-17", reservations: { a: { reservedUsd: -1, settledUsd: null } } }),
    JSON.stringify({ utcDay: "2026-10-17", reservations: { a: { reservedUsd: 1, settledUsd: 2 } } })]) {
    writeFileSync(f.path, body);
    assert.throws(observe, /unreadable|readable/);
  }
  writeFileSync(f.path, JSON.stringify({ utcDay: "2026-10-16", reservations: {
    old: { reservedUsd: 25, settledUsd: null } } }));
  const prior = readFileSync(f.path, "utf8");
  assert.equal(observe().deployments[0]?.remainingUsd, 25);
  assert.equal(readFileSync(f.path, "utf8"), prior, "observing rollover never rewrites yesterday");
  rmSync(f.path);
  assert.equal(observe().deployments[0]?.remainingUsd, 25);
  assert.equal(existsSync(f.path), false, "an absent local allowance can be observed without creating it");
  f.config.workerProviders!.fleetCashAllowancePath = f.path;
  writeFileSync(f.path, JSON.stringify({ utcDay: "2026-10-17", reservations: {} }));
  assert.throws(observe, /no valid fleet cap/);
  writeFileSync(f.path, JSON.stringify({ utcDay: "2026-10-18", fleetCapUsd: 25, reservations: {} }));
  assert.throws(observe, /refusing an older/);
  f.config.workerProviders!.fleetCashAllowancePath = undefined;
  for (const cap of [undefined, 0, Infinity]) {
    f.config.dailyCapUsd = cap;
    assert.throws(observe, /requires a dailyCapUsd/);
  }
});

test("cash routing can use an affordable successor but unknown observation never opens overflow", async t => {
  const f = fixture(t, 24.99);
  assert.equal(cashAllowanceFallbackRefusal(f.config, "small", ["gpt-6.1-sol", "gpt-6-luna"], ISO), undefined);
  assert.match(cashAllowanceFallbackRefusal(f.config, "x", [], ISO) ?? "", /observation unavailable/);
  writeFileSync(f.path, "{broken");
  assert.match(cashAllowanceFallbackRefusal(f.config, "x", ["gpt-6-luna"], ISO) ?? "", /unreadable/);
  let cash = 0;
  await assert.rejects(() => spawnWorker(blockedArgs(f, () => cash++)), /observation unavailable/);
  assert.equal(cash, 0);
});

test("both Foundry squeeze arms read the allowance without changing their healthy routing", async t => {
  for (const model of ["sonnet", "opus"]) {
    for (const spent of [0, 25]) {
      const f = fixture(t, spent); let cash = 0;
      const args = blockedArgs(f, () => cash++);
      args.model = model;
      args.env = { RMD_FOUNDRY_CLAUDE_API_KEY: "fixture-only", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
      if (spent === 25) {
        await assert.rejects(() => spawnWorker(args), /cash daily allowance exhausted until/);
        assert.equal(cash, 0);
      } else {
        const result = await spawnWorker(args);
        assert.equal(cash, 1);
        assert.equal(result.routedModel, model === "sonnet" ? "claude-sonnet-5-5" : "claude-opus-5-5");
      }
    }
  }
});

test("allowance admission preserves a viable Sonnet arm when the plain ladder cannot select", async t => {
  const f = fixture(t, 0); let cash = 0;
  const args = blockedArgs(f, () => cash++);
  args.model = "sonnet";
  args.routingTrial!.models = ["not-a-deployment"];
  args.env = { RMD_FOUNDRY_CLAUDE_API_KEY: "fixture-only", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
  const result = await spawnWorker(args);
  assert.equal(result.routedModel, "claude-sonnet-5-5");
  assert.equal(cash, 1);
  args.env = {};
  await assert.rejects(() => spawnWorker(args));
  assert.equal(cash, 1, "an unselectable plain ladder does not become a cash assignment");
});

test("allowance admission never counts a deployment the spawn must avoid", async t => {
  const f = fixture(t, 0); let cash = 0;
  const args = blockedArgs(f, () => cash++);
  args.avoidModels = ["gpt-6-luna"];
  await assert.rejects(() => spawnWorker(args), /no eligible cash deployment/);
  assert.equal(cash, 0);
});
