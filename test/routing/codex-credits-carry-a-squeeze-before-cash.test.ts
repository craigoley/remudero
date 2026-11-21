import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { providerRoutingOwnsHeadroom, resolveHeadroomEnabled, type Config } from "#src/lib/config.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { runDaemon } from "#src/lib/daemon.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import type { UsageSnapshot } from "#src/lib/headroom.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { loadPlan } from "#src/lib/plan.js";
import { resolveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
// Read off the namespace: at a base without the export a named import fails the whole file at LOAD,
// which reads as "could not execute" rather than the red each criterion must show.
import * as routingStatus from "#src/lib/provider-routing-status.js";
import {
  providerRoutingStatusPath,
  readProviderRoutingStatus,
  writeProviderRoutingStatus,
  type ProviderRoutingStatus,
} from "#src/lib/provider-routing-status.js";
import {
  initialReviewCapacityState,
  reviewProviderObservation,
  selectAdaptiveReviewWidth,
  selectRuntimeReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import {
  clearCodexCapacityCache,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  providerEligibility,
  readCodexCapacity,
  selectCodexModel,
  selectWorkerProvider,
  type CodexModelInfo,
  type ProviderCapacity,
} from "#src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  workerSelectionAssignment,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13855. While every subscription window is at or below its reserve, spendable Codex credits
// are the tier before cash and before holding work: a carried reading, a per-model bucket with no
// credits block and the review widener all honour them.
// Readings follow the acceptance: a last-good reading with generic and codex buckets at 97 percent
// (balance 38997.84), and the 14:47:59Z review.capacity row (claude 95, codex 99, reserve 5, base width 4).

const CAPABILITIES = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
const START = Date.parse("2026-11-19T15:00:00.000Z");
const BALANCE = "38997.8437045000";
const SOL: CodexModelInfo = {
  id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
};
const SOL61: CodexModelInfo = {
  id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
};
const claudeAt = (usedPercent: number): ProviderCapacity =>
  ({ provider: "claude", readable: true, windows: [{ name: "claude weekly", usedPercent }], model: "claude-sonnet-5-5", effort: "high" });

/** Scratch under the OS temp dir, outside every Git work tree, as a worker home must be. */
function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13855-`));
}

type Mode = "ok" | "timeout" | "starved" | "rpc" | "null-quota";
type GenericSource = "both" | "top-level" | "by-id";
/** A Codex app-server stand-in over stdio with configurable quota results. */
function codexAccount(t: test.TestContext) {
  clearCodexCapacityCache();
  const root = scratchRoot();
  const cfg: Config = { root, claudeBin: "/unused", workerProviders: {
    enabled: ["claude", "codex"], codexBin: "/bin/sh", codexHome: join(root, "codex"), capacityCacheMs: 1, reservePercent: 5 } };
  const state = { now: START, used: 97, mode: "ok" as Mode, balance: BALANCE as string,
    genericSource: "both" as GenericSource, extras: {} as Record<string, unknown>,
    reset: Math.floor((START + 3 * 86_400_000) / 1000), buckets: {} as Record<string, unknown>, models: [SOL] };
  const spawn = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
    stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const request = JSON.parse(line) as { id?: number };
        if (state.mode === "timeout" || state.mode === "starved") continue;
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) {
          if (state.mode === "rpc") { stdout.write(`${JSON.stringify({ id: 2, error: { message: "fixture RPC refused" } })}\n`); continue; }
          const bucket = { limitId: "codex", primary: { usedPercent: state.used, windowDurationMins: 10080, resetsAt: state.reset },
            credits: { hasCredits: true, unlimited: false, balance: state.balance }, ...state.extras };
          const result = state.mode === "null-quota" ? null : {
            ...(state.genericSource === "by-id" ? {} : { rateLimits: bucket }),
            rateLimitsByLimitId: { ...(state.genericSource === "top-level" ? {} : { codex: bucket }), ...state.buckets } };
          stdout.write(`${JSON.stringify({ id: 2, result })}\n`);
        }
        if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: state.models, nextCursor: null } })}\n`);
      }
    });
    return proc as never;
  };
  const read = (over: Record<string, unknown> = {}) => {
    let probeClock = 0;
    const probeTiming = state.mode === "starved" ? { monotonicNow: () => (probeClock += 2_000) } : {};
    return readCodexCapacity(cfg, { spawn, now: () => state.now, timeoutMs: 10,
      requestedModel: "sonnet", requestedEffort: "high", reservePercent: 5, capabilities: CAPABILITIES, ...probeTiming, ...over });
  };
  /** The next probe times out `ageMs` after the last good reading. */
  const fail = (ageMs = 61_000) => { state.now += ageMs; state.mode = "timeout"; };
  t.after(() => { clearCodexCapacityCache(); rmSync(root, { recursive: true, force: true }); });
  return { cfg, state, read, fail, spawn, lastGood: join(root, "state", "codex-capacity-last-good.json") };
}

function codexResult(): WorkerResult {
  return { provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: SOL.id, effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], compactionConfigured: false,
    compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "Codex JSONL reports no served model" } as WorkerResult;
}

/** The real spawnWorker with measured Claude capacity, real Codex carry, and counted cash spawns. */
async function routeSpawn(account: ReturnType<typeof codexAccount>, claudeUsed = 99,
  status: { root: string; write: true } | undefined = undefined) {
  const root = status?.root ?? scratchRoot();
  const assignments: WorkerSelectionAssignment[] = [];
  let cashSpawns = 0, codexSpawns = 0;
  try {
    const result = await spawnWorker({
      cwd: root, permissionMode: "bypassPermissions" as const, settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work", env: {}, model: "sonnet", effort: "high", tools: ["Read", "Grep", "Glob", "RunCheck"],
      config: { claudeBin: "/unused", root, dailyCapUsd: 20, workerProviders: { enabled: ["claude", "codex", "cash"],
        codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000, cashFallbackWhenBlocked: true } } as never,
      providerRouting: {
        readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: account.state.now }),
        readClaude: async () => claudeAt(claudeUsed),
        readCodex: async (_config, request) => account.read({ ...request }),
        spawnCodex: async () => { codexSpawns += 1; return codexResult(); },
        spawnOpenWeight: async () => { cashSpawns += 1; return { provider: "cash", text: "done", isError: false, subtype: "success" } as never; },
        writeStatus: status ? writeProviderRoutingStatus : () => {},
        now: () => account.state.now,
      },
      onSelectionAssignment: (assignment) => assignments.push(assignment),
      claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root,
        exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] } },
      keychain: { platform: "linux" as const,
        readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }) },
      queryFn: (() => (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })()) as never,
    } as SpawnWorkerArgs);
    return { result, assignments, cashSpawns, codexSpawns, decision: assignments.at(-1)?.routing.decision };
  } finally {
    if (!status) rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T13855 criterion 1: a timed-out probe carries a credits-lane last-good reading to codex instead of cash", async (t) => {
  const account = codexAccount(t);
  const seeded = await account.read();
  assert.equal(providerEligibility(seeded, 5).lane, "codex-credits", "control: the 97 percent reading is on the credits lane");
  account.fail();
  const carried = await account.read();
  assert.equal(carried.readable, true, `a carried credits-lane reading is readable, not refused at the reserve: ${carried.detail}`);
  assert.equal(carried.carriedForward?.ageMs, 61_000);
  assert.ok(carried.windows.every((window) => window.usedPercent >= 95 && window.usedPercent <= 100), "projected, held at most 100");
  assert.deepEqual(providerEligibility(carried, 5), { eligible: true, lane: "codex-credits", headroomPercent: 100 - carried.windows[0].usedPercent });
  const routed = selectWorkerProvider([claudeAt(99), carried], 5, 0.999);
  assert.equal(routed.provider, "codex");
  assert.equal(routed.lane, "codex-credits");

  // The live spawn path: on origin/main the carry threw "projected burn reaches the reserve" and the spawn took cash.
  const spawn = await routeSpawn(account);
  assert.equal(spawn.decision?.rule, "codex-credits", "the rule is codex-credits, never cash-fallback");
  assert.equal(spawn.cashSpawns, 0, "no cash spawn while credits carry codex");
  assert.equal(spawn.codexSpawns, 1);

  // No age limit: a 24-hour-old last-good reading carries the same way, its window held at 100.
  const old = codexAccount(t);
  await old.read();
  old.fail(24 * 3_600_000);
  const day = await old.read();
  assert.equal(day.readable, true, `a 24-hour carry is not refused for its age: ${day.detail}`);
  assert.equal(day.carriedForward?.ageMs, 24 * 3_600_000);
  assert.equal(day.windows[0].usedPercent, 100, "the projection is held at 100, not past it");
  assert.equal(providerEligibility(day, 5).lane, "codex-credits");
  assert.equal(selectWorkerProvider([claudeAt(99), day], 5, 0.5).lane, "codex-credits");

  for (const other of [{ spendControlReached: true }, { credits: { hasCredits: true, unlimited: false, balance: "0" } }]) {
    const split = codexAccount(t);
    const primary = { usedPercent: 97, windowDurationMins: 10080, resetsAt: split.state.reset };
    split.state.buckets = { sol: { limitName: SOL.id, primary }, other: { limitName: SOL61.id, primary, ...other } };
    split.state.models.push(SOL61);
    const fresh = await split.read();
    assert.equal(fresh.modelDecision?.options.find((option) => option.id === SOL61.id)?.reason, "below-reserve");
    split.fail();
    const carriedSol = await split.read();
    assert.equal(carriedSol.readable, true, carriedSol.detail);
    assert.equal(carriedSol.model, SOL.id);
    assert.equal(carriedSol.credits?.balance, Number(BALANCE));
    assert.deepEqual(carriedSol.windows.map((window) => window.usedPercent), [97 + 97 / (4 * 86_400_000) * 61_000]);
    assert.equal(carriedSol.modelDecision?.options.find((option) => option.id === SOL61.id)?.reason, "quota-unreadable");
    assert.equal(selectWorkerProvider([claudeAt(99), carriedSol], 5, 0.999).lane, "codex-credits");
  }
});

test("W1-T13855 criterion 1: a starved probe carries the funded 97 percent reading into the worker assignment", async (t) => {
  const account = codexAccount(t);
  const seeded = await account.read();
  assert.equal(seeded.windows[0]?.usedPercent, 97);
  assert.equal(seeded.credits?.balance, Number(BALANCE));
  account.fail();
  account.state.mode = "starved";

  const carried = await account.read();
  const spawn = await routeSpawn(account);
  assert.match(carried.detail ?? "", /app-server deadline overran/);
  assert.equal(spawn.decision?.rule, "codex-credits", carried.detail);
  assert.equal(carried.carriedForward?.failureKind, "starved");
  assert.equal(carried.windows[0]?.usedPercent, 97 + 97 / (4 * 86_400_000) * 61_000);
  assert.equal(providerEligibility(carried, 5).lane, "codex-credits");
  assert.deepEqual(spawn.decision?.considered.find((entry) => entry.provider === "codex")?.creditsRescue,
    { path: "carried", tier: "codex-credits", projectedBalance: Number(BALANCE), ageMs: 61_000, failureKind: "starved" });
  assert.equal(spawn.codexSpawns, 1);
  assert.equal(spawn.cashSpawns, 0);
});

test("borrowed credits project from the generic bucket's own history", async (t) => {
  const split = codexAccount(t);
  const sol = { limitName: SOL.id, primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: split.state.reset } };
  split.state.balance = "10";
  split.state.buckets.sol = { ...sol, credits: { hasCredits: true, unlimited: false, balance: "20" } };
  await split.read();
  split.state.now += 3_600_000;
  split.state.buckets.sol = sol;
  await split.read();
  split.fail(3_600_000);
  const carriedSol = await split.read();
  assert.equal(carriedSol.readable, true, carriedSol.detail);
  assert.equal(carriedSol.model, SOL.id);
  assert.equal(carriedSol.credits?.balance, 10, "the inherited pool's burn comes from its own history");
  assert.equal(providerEligibility(carriedSol, 5).lane, "codex-credits");
});

test("W1-T13855 criterion 9: cash carries when a model's projected window reaches the reserve without spendable credits", async (t) => {
  const funded = { hasCredits: true, unlimited: false, balance: BALANCE };
  for (const [label, generic] of [
    ["absent", { credits: null }],
    ["zero", { credits: { ...funded, balance: "0" } }],
    ["blocked", { credits: funded, spendControlReached: true }],
    ["projected depletion", { credits: { ...funded, balance: "10" } }],
  ] as const) {
    const account = codexAccount(t);
    // This model has headroom on the fresh read, but its own window reaches the reserve on carry.
    account.state.buckets.sol = { limitName: SOL.id,
      primary: { usedPercent: 94.99, windowDurationMins: 10080, resetsAt: account.state.reset } };
    if (label === "projected depletion") {
      account.state.balance = "20";
      assert.equal((await account.read()).credits?.balance, 20);
      account.state.now += 3_600_000;
    }
    Object.assign(account.state.extras, generic);
    const fresh = await account.read();
    assert.equal(fresh.readable, true);
    assert.equal(fresh.windows[0]?.usedPercent, 94.99);
    assert.equal(providerEligibility(fresh, 5).lane, undefined, "control: the fresh read is subscription headroom");

    account.fail(label === "projected depletion" ? 6 * 3_600_000 : undefined);
    const capacity = await account.read();
    assert.equal(capacity.readable, false, `${label}: ${capacity.detail}`);
    assert.equal(capacity.probeFailure, "timeout", label);
    assert.match(capacity.detail ?? "", /projected burn reaches the reserve/, label);
    const routed = await routeSpawn(account);
    assert.equal(routed.decision?.rule, "cash-fallback", label);
    assert.equal(routed.cashSpawns, 1, label);
    assert.equal(routed.codexSpawns, 0, label);
    assert.equal(routed.decision?.considered.find((entry) => entry.provider === "codex")?.failureKind, "timeout", label);
    const withClaude = await routeSpawn(account, 60);
    assert.equal(withClaude.assignments.at(-1)?.selected.provider, "claude", label);
    assert.equal(withClaude.cashSpawns, 0, label);
  }
});

test("W1-T13855 criterion 6: a carried model past its reserve on borrowed credits names the carried rescue", async (t) => {
  const account = codexAccount(t);
  account.state.used = 40; // the generic bucket has headroom and the account's credits
  account.state.buckets.sol = { limitName: SOL.id,
    primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: account.state.reset } };
  await account.read();
  account.fail();
  const capacity = await account.read();
  assert.equal(capacity.readable, true, capacity.detail);
  assert.equal(capacity.model, SOL.id);
  assert.equal(providerEligibility(capacity, 5).lane, "codex-credits");
  assert.deepEqual(capacity.creditsRescue,
    { path: "carried", projectedBalance: Number(BALANCE), ageMs: 61_000, failureKind: "timeout" });
});

test("W1-T13855 criterion 6: unfunded generic reserve breach refuses carry beside model headroom", async (t) => {
  const account = codexAccount(t);
  account.state.used = 97;
  account.state.balance = "0";
  account.state.buckets.sol = { limitName: SOL.id,
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: account.state.reset },
    credits: { hasCredits: true, unlimited: false, balance: "0" } };
  const fresh = await account.read();
  assert.equal(fresh.model, SOL.id);
  assert.equal(fresh.windows[0]?.usedPercent, 40);
  assert.deepEqual(providerEligibility(fresh, 5), { eligible: true, headroomPercent: 3 });

  account.fail();
  const carried = await account.read();
  assert.equal(carried.readable, false, carried.detail);
  assert.equal(carried.probeFailure, "timeout");
  assert.match(carried.detail ?? "", /projected burn reaches the reserve/);
  assert.equal(carried.carriedForward, undefined);
  const routed = await routeSpawn(account);
  assert.equal(routed.decision?.rule, "cash-fallback");
  assert.equal(routed.codexSpawns, 0);
  assert.equal(routed.cashSpawns, 1);
});

test("W1-T13855 criterion 9: carried subscription headroom wins beside an unfunded generic window and a funded model", async (t) => {
  const account = codexAccount(t);
  const primary = { usedPercent: 97, windowDurationMins: 10080, resetsAt: account.state.reset };
  const credits = { hasCredits: true, unlimited: false, balance: "10" };
  const other = { limitName: SOL61.id, primary: { ...primary, usedPercent: 40 } };
  account.state.used = 97;
  account.state.balance = "0";
  account.state.models.push(SOL61);
  account.state.buckets = {
    sol: { limitName: SOL.id, primary, credits },
    other,
  };
  assert.equal((await account.read()).model, SOL61.id, "the fresh read prefers the model with subscription headroom");
  account.fail();
  const carried = await account.read();
  assert.equal(carried.readable, true, carried.detail);
  assert.equal(carried.model, SOL61.id, "subscription headroom is drawn before the peer's credits");
  assert.equal(providerEligibility(carried, 5).lane, undefined);
  assert.equal(carried.creditsRescue, undefined);
  assert.equal(carried.modelDecision?.options.find((option) => option.id === SOL.id)?.lane, "codex-credits");
  const routed = await routeSpawn(account);
  assert.equal(routed.assignments.at(-1)?.selected.model, SOL61.id);
  assert.equal(routed.codexSpawns, 1);
  assert.equal(routed.cashSpawns, 0);
  const attribution = await account.read({ selectedModel: SOL61.id });
  assert.equal(attribution.readable, true, attribution.detail);
  assert.equal(providerEligibility(attribution, 5).lane, undefined);

  account.state.mode = "ok";
  account.state.now += 61_000;
  account.state.buckets.other = { ...other, credits };
  await account.read();
  account.fail();
  const withHeadroom = await account.read();
  assert.equal(withHeadroom.model, SOL61.id);
  assert.equal(withHeadroom.readable, true, withHeadroom.detail);
  assert.equal(providerEligibility(withHeadroom, 5).lane, undefined);
});

test("a model balance projects from the prior generic balance when its bucket lacked credits", async (t) => {
  const account = codexAccount(t);
  const primary = { usedPercent: 40, windowDurationMins: 10080, resetsAt: account.state.reset };
  const modelBucket = { limitId: "codex", primary };
  account.state.used = 40;
  account.state.balance = "20";
  account.state.buckets.codex = modelBucket;
  assert.equal((await account.read()).credits?.balance, 20);

  account.state.now += 3_600_000;
  account.state.buckets.codex = { ...modelBucket, primary: { ...primary, usedPercent: 97 },
    credits: { hasCredits: true, unlimited: false, balance: "10" } };
  const fresh = await account.read();
  assert.equal(fresh.credits?.balance, 10);
  assert.equal(providerEligibility(fresh, 5).lane, "codex-credits");

  account.fail(6 * 3_600_000);
  const capacity = await account.read();
  assert.equal(capacity.readable, false, capacity.detail);
  assert.match(capacity.detail ?? "", /projected burn reaches the reserve/);
  const routed = await routeSpawn(account);
  assert.equal(routed.decision?.rule, "cash-fallback");
  assert.equal(routed.cashSpawns, 1);
  assert.equal(routed.codexSpawns, 0);
});

// A rateLimitsByLimitId split: the selected model's own bucket at 99 percent carries no credits block.
const splitReading = (model: Record<string, unknown> = {}, generic: Record<string, unknown> = {}) => {
  const codex = { limitId: "codex", primary: { usedPercent: 60, windowDurationMins: 10080 },
    credits: { hasCredits: true, unlimited: false, balance: BALANCE }, ...generic };
  return { rateLimits: codex, rateLimitsByLimitId: { codex,
    sol: { limitId: "gpt-6.2-sol", limitName: "gpt-6.2-sol", primary: { usedPercent: 99, windowDurationMins: 10080 }, ...model } } };
};
const CONFIG = { claudeBin: "/unused", root: REPO_ROOT, workerProviders: { enabled: ["claude" as const, "codex" as const], reservePercent: 5 } };

test("W1-T13855 criterion 2: a model bucket without a credits block is carried by the generic bucket's credits", () => {
  const capacity = selectCodexModel([SOL], splitReading(), CONFIG, "sonnet", "high", CAPABILITIES);
  assert.equal(capacity.readable, true, `origin/main returned below-reserve and exhausted: ${capacity.detail}`);
  assert.equal(capacity.exhausted, undefined);
  assert.equal(capacity.model, SOL.id);
  assert.deepEqual(capacity.windows.map((window) => window.usedPercent), [99], "the model's own bucket still supplies the windows");
  assert.deepEqual(capacity.credits, { hasCredits: true, unlimited: false, balance: 38997.8437045 });
  assert.equal(capacity.modelDecision?.options.find((option) => option.id === SOL.id)?.lane, "codex-credits");
  assert.deepEqual(providerEligibility(capacity, 5), { eligible: true, lane: "codex-credits", headroomPercent: 1 });

  // An exhausted capacity that carries spendable credits is the credits lane; without them it stays below-reserve.
  const exhausted: ProviderCapacity = { provider: "codex", readable: false, exhausted: true, model: SOL.id,
    windows: [{ name: "gpt-6.2-sol primary 10080m", usedPercent: 99 }], credits: { hasCredits: true, unlimited: false, balance: 10 } };
  assert.deepEqual(providerEligibility(exhausted, 5), { eligible: true, lane: "codex-credits", headroomPercent: 1 });
  const { credits: _spent, ...dry } = exhausted;
  assert.deepEqual(providerEligibility(dry, 5), { eligible: false, reason: "below-reserve", headroomPercent: 1 });

  // A model bucket whose own reached type or spend control blocks credits is not rescued by the generic bucket.
  for (const own of [{ spendControlReached: true }, { rateLimitReachedType: "workspace_member_usage_limit_reached" }]) {
    const blocked = selectCodexModel([SOL], splitReading(own), CONFIG, "sonnet", "high", CAPABILITIES);
    assert.equal(blocked.readable, false, JSON.stringify(own));
    assert.equal(blocked.exhausted, true, JSON.stringify(own));
    assert.ok(blocked.credits?.blocked, JSON.stringify(own));
    assert.equal(providerEligibility(blocked, 5).reason, "below-reserve", JSON.stringify(own));
  }
  const incomplete = selectCodexModel([SOL], splitReading({ credits: { hasCredits: false } }), CONFIG, "sonnet", "high", CAPABILITIES);
  assert.equal(incomplete.readable, false, "a present credits block with incomplete flags cannot borrow");
  assert.equal(incomplete.exhausted, true);
  assert.equal(providerEligibility(incomplete, 5).reason, "below-reserve");
});

function statusFor(root: string, nowMs: number, capacities: ProviderCapacity[], state: "selected" | "blocked" = "selected"): ProviderRoutingStatus {
  const base = { enabledProviders: ["claude", "codex"] as const, reservePercent: 5, observedAtMs: nowMs, cacheValidMs: 60_000 };
  if (state === "blocked") writeProviderRoutingStatus(root, { ...base, enabledProviders: [...base.enabledProviders], state, capacities });
  else writeProviderRoutingStatus(root, { ...base, enabledProviders: [...base.enabledProviders], state,
    capacities, selection: selectWorkerProvider(capacities, 5, 0.5) });
  return readProviderRoutingStatus(root, { now: () => nowMs });
}
const creditsCodex = (): ProviderCapacity => selectCodexModel([SOL], splitReading(), CONFIG, "sonnet", "high", CAPABILITIES);

test("W1-T13855 criterion 3: the routing status marks a credits-lane codex row and publishes no balance", (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nowMs = START;
  const status = statusFor(root, nowMs, [claudeAt(95), creditsCodex()]);
  const raw = readFileSync(providerRoutingStatusPath(root), "utf8");
  const rows = (JSON.parse(raw) as { providers: Array<Record<string, unknown>> }).providers;
  assert.equal(rows.find((row) => row.provider === "codex")?.creditsLane, true);
  assert.equal(rows.find((row) => row.provider === "claude")?.creditsLane, undefined, "a refused provider carries no flag");
  assert.doesNotMatch(raw, /38997|"balance"|creditsBalance/, "the served row carries no balance");
  assert.equal(status.providers?.find((row) => row.provider === "codex")?.creditsLane, true, "the reader parses the flag back");

  // A provider admitted on subscription headroom writes no flag.
  const healthy = selectCodexModel([SOL], splitReading({ primary: { usedPercent: 40, windowDurationMins: 10080 } }), CONFIG,
    "sonnet", "high", CAPABILITIES);
  statusFor(root, nowMs, [claudeAt(95), healthy]);
  const plain = JSON.parse(readFileSync(providerRoutingStatusPath(root), "utf8")) as { providers: Array<Record<string, unknown>> };
  assert.ok(plain.providers.every((row) => row.creditsLane === undefined));

  const exhausted: ProviderCapacity = { ...creditsCodex(), readable: false, exhausted: true };
  const selected = statusFor(root, nowMs, [claudeAt(95), exhausted]);
  assert.equal(selected.selected?.provider, "codex");
  assert.equal(selected.selected?.tightestRemainingPercent, 1);
  assert.equal(selected.providers?.find((row) => row.provider === "codex")?.creditsLane, true);
  assert.doesNotMatch(readFileSync(providerRoutingStatusPath(root), "utf8"), /38997|"balance"|creditsBalance/);
});

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 8, workerMemoryReserveMib: 1536, healthyWindowSamples: 3, sampleCadenceMs: 60_000, telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5, memoryPsiLowPct: 5, memoryPsiHighPct: 15, providerAllowancePct: 2, settlementWindowMs: 1_800_000,
  unhealthySettlementThreshold: 2, minHealthySettlements: 1, latencyExpansionRatio: 2,
};
const BOUNDS = { baseWidth: 4, minWidth: 1, maxWidth: 5 };
function hostHealthy(nowMs: number, provider: ProviderRoutingStatus, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return { nowMs, queueDepth: 12, activeWorkers: 2, memAvailableMib: 6_700, cpuPsiSomeAvg10Pct: 1, cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 1, memoryPsiSomeAvg10Pct: 0, provider: reviewProviderObservation(provider, nowMs),
    settlements: { successes: 4, failures: 0, timeouts: 0 }, ...over };
}
/** The same status as origin/main reads it: no row carries the flag this record adds. */
const unflagged = (status: ProviderRoutingStatus): ProviderRoutingStatus =>
  ({ ...status, providers: status.providers?.map(({ creditsLane: _flag, ...row }) => row) });
function widen(samples: number, status: (nowMs: number) => ProviderRoutingStatus, over: Partial<ReviewCapacityObservation> = {}) {
  let state = initialReviewCapacityState(BOUNDS.baseWidth);
  const decisions = [];
  for (let i = 0; i < samples; i += 1) {
    const nowMs = START + i * 60_000;
    const result = selectAdaptiveReviewWidth(state, POLICY, hostHealthy(nowMs, status(nowMs), over), BOUNDS);
    state = result.state;
    decisions.push(result.decision);
  }
  return decisions;
}

test("W1-T13855 criterion 4: the review widener does not hold base for provider-headroom while the credits lane carries", (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The 14:47:59Z reading: claude 95, codex 99 on a fresh credits lane, reserve 5 -> provider_headroom_pct 5.
  const squeeze = statusFor(root, START, [claudeAt(95), creditsCodex()]);
  const replay = widen(5, (nowMs) => ({ ...squeeze, observedAt: new Date(nowMs).toISOString(), freshUntil: new Date(nowMs + 60_000).toISOString() }));
  assert.ok(replay.every((decision) => decision.reason !== "provider-headroom"), "origin/main held base for provider-headroom");
  assert.ok(replay.every((decision) => decision.evidence.providerCreditsLane === true), "the evidence names the credits lane");
  assert.equal(replay.at(-1)!.effectiveWidth, BOUNDS.maxWidth, "a healthy host earns its lane above base");
  const observed = reviewProviderObservation(squeeze, START);
  assert.equal(observed.headroomPct, 5);
  assert.equal(observed.creditsLane, true);
  assert.equal(routingStatus.creditsLaneRoom(squeeze, START), true);

  // Claude above its reserve beside the same credits lane: origin/main's reason and width.
  const above = statusFor(root, START, [claudeAt(90), creditsCodex()]);
  assert.equal(routingStatus.creditsLaneRoom(above, START), false, "subscription headroom is not a credits squeeze");
  const aboveDecisions = widen(3, () => above);
  assert.deepEqual(aboveDecisions.map((d) => [d.reason, d.effectiveWidth]), widen(3, () => unflagged(above)).map((d) => [d.reason, d.effectiveWidth]));
  // Claude at 94 is above its reserve (6 left) but inside the allowance: origin/main holds for provider-headroom, and so does this.
  const thin = statusFor(root, START, [claudeAt(94), creditsCodex()]);
  assert.equal(routingStatus.creditsLaneRoom(thin, START), false);
  assert.deepEqual(widen(3, () => thin).map((d) => [d.reason, d.effectiveWidth]),
    [["provider-headroom", 4], ["provider-headroom", 4], ["provider-headroom", 4]]);

  // A lapsed reading past the age bound, or a blocked one, is not trusted: origin/main's reason and width.
  const lapsed = statusFor(root, START - 900_001, [claudeAt(95), creditsCodex()]);
  const lapsedNow = { ...readProviderRoutingStatus(root, { now: () => START }) };
  assert.equal(routingStatus.creditsLaneRoom(lapsedNow, START), false);
  assert.equal(routingStatus.creditsLaneRoom(lapsed, START - 900_001 + 640_000), true, "a lapsed cache inside the age bound still counts");
  assert.deepEqual(widen(3, () => lapsedNow).map((d) => [d.reason, d.effectiveWidth]),
    widen(3, () => unflagged(lapsedNow)).map((d) => [d.reason, d.effectiveWidth]));
  const blocked: ProviderRoutingStatus = { ...squeeze, state: "blocked", blockedReason: "no-provider-headroom" };
  assert.equal(routingStatus.creditsLaneRoom(blocked, START), false);
  assert.deepEqual(widen(3, () => blocked).map((d) => [d.reason, d.effectiveWidth]),
    widen(3, () => unflagged(blocked)).map((d) => [d.reason, d.effectiveWidth]));

  // The production adapter's row records the field.
  statusFor(root, START, [claudeAt(95), creditsCodex()]);
  const rows: Array<Record<string, unknown>> = [];
  selectRuntimeReviewWidth({ root, ...BOUNDS, queueDepth: 12, activeWorkers: 2, nowMs: START, ledgerLines: [], policy: POLICY,
    cpuWeightShare: 1, laneCpuBound: 8, log: (_step, extra = {}) => rows.push(extra) });
  assert.equal(rows.at(-1)?.provider_credits_lane, true);
});

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  acceptance:
    - claim: a
      proof: unit test
  verify: auto
  status: queued
`;
const OVER_CEILING: UsageSnapshot = { billingMode: "subscription",
  session: { percentUsed: 42, resetsAt: "2026-07-25T18:00:00.000Z" },
  weekly: [{ label: "all models", percentUsed: 99, resetsAt: "2026-07-28T04:00:00.000Z" }] };
const DAEMON_NOW = Date.parse("2026-07-20T22:00:00.000Z");

function daemonHostPins() {
  return {
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    bootCheckoutBlocked: "",
  };
}

async function governedTick(dir: string, headroomEnabled: boolean, usage: UsageSnapshot | "unreadable" = OVER_CEILING) {
  writeFileSync(join(dir, "tasks.yaml"), PLAN_YAML);
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let spawned = 0, sleeps = 0;
  const summary = await runDaemon(loadPlan(join(dir, "tasks.yaml")), {
    ...daemonHostPins(),
    refreshMerged: () => () => false,
    runOne: async (id) => { spawned += 1; return { taskId: id, runId: `RUN-${id}`, merged: true, costUsd: 0, verdict: "merged" } as never; },
    readUsage: () => (usage === "unreadable" ? undefined : usage),
    fleetLane: { stateDir: join(dir, "state"), ledgerPath: join(dir, "state", "ledger.ndjson"),
      mergedLastDay: () => 0, approve: () => assert.fail("there are no fleet findings") },
    now: () => new Date(DAEMON_NOW),
    checkStop: () => stopDetail(dir),
    sleep: async () => { sleeps += 1; if (sleeps >= 3) requestStop(dir, "test done polling"); },
    log: (step, extra = {}) => lines.push({ step, extra }),
  }, { headroomEnabled, max: 1, unreadableDegradedLimit: 0 });
  return { summary, spawned, lines, beats: lines.filter((line) => line.step === "daemon.headroom").map((line) => line.extra) };
}

test("a restart into Claude-only still enforces the governor beside a lapsed Codex credits snapshot", async (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claudeOnly: Config = { root, claudeBin: "/unused", headroom: { enabled: true }, workerProviders: { enabled: ["claude"] } };
  const enforcing = (config: Config) => resolveHeadroomEnabled(config, {}) && !providerRoutingOwnsHeadroom(config, {});
  const codexEnabled: Config = { ...claudeOnly, workerProviders: { enabled: ["claude", "codex"] } };
  assert.equal(enforcing(codexEnabled), false);
  assert.equal(enforcing(claudeOnly), true);

  statusFor(root, DAEMON_NOW - 120_000, [claudeAt(95), creditsCodex()]);
  const cached = readProviderRoutingStatus(root, { now: () => DAEMON_NOW });
  assert.equal(cached.freshness, "stale");
  assert.equal(routingStatus.creditsLaneRoom(cached, DAEMON_NOW), true, "control: the prior snapshot would lift a squeeze");
  const restarted = await governedTick(root, enforcing(claudeOnly));
  assert.equal(restarted.spawned, 0, "Claude-only must idle at the ceiling");
  assert.equal(restarted.summary.stopReason, "stopped");
  assert.equal(restarted.beats[0]?.enforced, true);
  assert.equal(restarted.beats[0]?.over_ceiling, true);
  assert.equal(restarted.beats[0]?.tick, 1);
});

test("W1-T13855 criterion 6: a rescued assignment names its rescue and an unreadable codex entry its failure kind", async (t) => {
  const assign = (codex: ProviderCapacity) => {
    const capacities = [claudeAt(99), codex];
    const selection = selectWorkerProvider(capacities, 5, 0.5);
    return workerSelectionAssignment({ cwd: REPO_ROOT, prompt: "work", model: "sonnet", effort: "high",
      permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json") }, {
      provider: selection.provider, model: selection.capacity.model, effort: "high", capacity: selection.capacity, capacities,
      mode: "multi-provider", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 5, provenance: "default" }, selection,
    }).routing.decision?.considered.find((entry) => entry.provider === "codex");
  };
  const account = codexAccount(t);
  await account.read();
  account.fail();
  assert.deepEqual(assign(await account.read())?.creditsRescue,
    { path: "carried", tier: "codex-credits", projectedBalance: 38997.8437045, ageMs: 61_000, failureKind: "timeout" });
  assert.deepEqual(assign(creditsCodex())?.creditsRescue, { path: "generic-bucket", tier: "codex-credits", projectedBalance: 38997.8437045 });

  // The live spawn's own row names the carried rescue.
  const spawn = await routeSpawn(account);
  assert.equal(spawn.decision?.considered.find((entry) => entry.provider === "codex")?.creditsRescue?.path, "carried");

  // Unreadable: a probe that times out with no last-good, a terminal refusal, and a starved read each name their kind.
  const fresh = codexAccount(t);
  fresh.fail();
  const unreadable = (capacity: ProviderCapacity) => {
    const capacities = [claudeAt(40), capacity];
    const selection = selectWorkerProvider(capacities, 5, 0);
    return workerSelectionAssignment({ cwd: REPO_ROOT, prompt: "work", model: "sonnet", effort: "high",
      permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json") }, {
      provider: selection.provider, model: "claude-sonnet-5-5", effort: "high", capacity: selection.capacity, capacities,
      mode: "multi-provider", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 5, provenance: "default" }, selection,
    }).routing.decision?.considered.find((entry) => entry.provider === "codex");
  };
  const timedOut = unreadable(await fresh.read());
  assert.equal(timedOut?.reason, "unreadable");
  assert.equal(timedOut?.failureKind, "timeout");
  fresh.state.mode = "rpc";
  clearCodexCapacityCache();
  assert.equal(unreadable(await fresh.read())?.failureKind, "terminal");
  const unusable = codexAccount(t);
  await unusable.read();
  unusable.state.now += 61_000;
  unusable.state.mode = "null-quota";
  const nullQuota = unreadable(await unusable.read());
  assert.equal(nullQuota?.reason, "unreadable");
  assert.equal(nullQuota?.failureKind, "terminal");
  unusable.fail();
  assert.match((await unusable.read()).detail ?? "", /last-good invalidated/);
  assert.equal(unreadable({ provider: "codex", readable: false, windows: [], detail: "starved", probeFailure: "starved" })?.failureKind, "starved");
  fresh.cfg.workerProviders!.codexBin = join(fresh.cfg.root, "absent-codex");
  const missing = await fresh.read();
  assert.match(missing.detail ?? "", /Codex executable is absent or not executable/);
  assert.equal(unreadable(missing)?.failureKind, "terminal");
});

test("W1-T13855 criterion 9: subscription headroom first, credits next, and cash only when credits cannot carry", async (t) => {
  const account = codexAccount(t);
  const primary = { usedPercent: 97, windowDurationMins: 10080, resetsAt: account.state.reset };
  const otherCredits = { hasCredits: true, unlimited: false, balance: "20" };
  const other = { limitName: SOL61.id, primary, credits: otherCredits };
  account.state.buckets = { sol: { limitName: SOL.id, primary: { ...primary, usedPercent: 99 } }, other };
  account.state.models.push(SOL61);
  await account.read();
  account.state.now += 3_600_000;
  account.state.buckets.other = { ...other, credits: { ...otherCredits, balance: "10" } };
  const fresh = await account.read();
  assert.equal(fresh.model, SOL61.id, "the tighter SOL window loses while SOL61's credits are spendable");
  assert.equal(fresh.credits?.balance, 10);
  account.fail(6 * 3_600_000);
  const carried = await account.read();
  assert.equal(carried.readable, true, carried.detail);
  assert.equal(carried.model, SOL.id);
  assert.equal(carried.credits?.balance, Number(BALANCE));
  assert.equal(carried.modelDecision?.options.find((option) => option.id === SOL61.id)?.reason, "quota-unreadable");
  const spawn = await routeSpawn(account);
  assert.equal(spawn.decision?.rule, "codex-credits");
  assert.equal(spawn.assignments.at(-1)?.selected.model, SOL.id);
  assert.equal(spawn.codexSpawns, 1);
  assert.equal(spawn.cashSpawns, 0);
  // Claude with headroom is chosen over a carried credits lane at every draw.
  for (const draw of [0, 0.5, 0.999, 0.99999]) {
    const pick = selectWorkerProvider([claudeAt(60), carried], 5, draw);
    assert.equal(pick.provider, "claude", `draw ${draw}`);
    assert.equal(pick.lane, undefined, `draw ${draw}`);
  }
  // A Codex model with headroom is chosen over the one its credits carry.
  const both = { ...splitReading(), rateLimitsByLimitId: { ...splitReading().rateLimitsByLimitId,
    sol61: { limitId: "gpt-6.1-sol", limitName: "gpt-6.1-sol", primary: { usedPercent: 30, windowDurationMins: 10080 } } } };
  const preferred = selectCodexModel([SOL, SOL61], both, CONFIG, "sonnet", "high", CAPABILITIES);
  assert.equal(preferred.model, SOL61.id);
  assert.equal(providerEligibility(preferred, 5).lane, undefined);

  const ownPool = codexAccount(t);
  ownPool.state.balance = "20";
  ownPool.state.buckets.sol = { limitName: SOL.id,
    primary: { ...primary, usedPercent: 99, resetsAt: ownPool.state.reset },
    credits: { hasCredits: true, unlimited: false, balance: "10" } };
  assert.equal((await ownPool.read()).credits?.balance, 10);
  ownPool.state.now += 3_600_000;
  ownPool.state.balance = "10";
  assert.equal((await ownPool.read()).credits?.balance, 10);
  ownPool.fail(6 * 3_600_000);
  const ownPoolSpawn = await routeSpawn(ownPool);
  assert.equal(ownPoolSpawn.decision?.rule, "codex-credits", "the model keeps its steady 10 while generic credits project to -50");
  assert.equal(ownPoolSpawn.assignments.at(-1)?.selected.model, SOL.id);
  assert.deepEqual(ownPoolSpawn.decision?.considered.find((entry) => entry.provider === "codex")?.creditsRescue,
    { path: "carried", tier: "codex-credits", projectedBalance: 10, ageMs: 6 * 3_600_000, failureKind: "timeout" });
  assert.equal(ownPoolSpawn.codexSpawns, 1);
  assert.equal(ownPoolSpawn.cashSpawns, 0);
  const withClaudeHeadroom = await routeSpawn(ownPool, 60);
  assert.equal(withClaudeHeadroom.assignments.at(-1)?.selected.provider, "claude");
  assert.equal(withClaudeHeadroom.codexSpawns, 0);
  assert.equal(withClaudeHeadroom.cashSpawns, 0);

  const refused = async (label: string, prepare: (a: ReturnType<typeof codexAccount>) => Promise<void>) => {
    const a = codexAccount(t);
    await prepare(a);
    const read = await a.read();
    assert.equal(read.readable, false, `${label}: ${read.detail}`);
    const fallback = await routeSpawn(a);
    assert.equal(fallback.decision?.rule, "cash-fallback", label);
    assert.equal(fallback.cashSpawns, 1, label);
    assert.equal(fallback.codexSpawns, 0, label);
  };
  // Blocked credits on the carried reading.
  await refused("blocked", async (a) => {
    a.state.buckets.sol = { limitName: SOL.id, primary: { ...primary, resetsAt: a.state.reset }, spendControlReached: true,
      credits: { hasCredits: true, unlimited: false, balance: "10" } };
    await a.read();
    a.fail();
  });
  // A burn-projected balance at or below zero: 20 then 10 an hour apart, projected six hours on.
  await refused("burned out", async (a) => {
    a.state.balance = "20"; await a.read();
    a.state.now += 3_600_000; a.state.balance = "10"; clearCodexCapacityCache(); await a.read();
    a.fail(6 * 3_600_000);
  });
  for (const source of ["by-id", "both"] as const) {
    await refused(`burned out when the generic bucket gains a by-ID entry (${source})`, async (a) => {
      a.state.balance = "20";
      a.state.genericSource = "top-level";
      assert.equal((await a.read()).credits?.balance, 20);
      a.state.now += 3_600_000;
      a.state.balance = "10";
      a.state.genericSource = source;
      assert.equal((await a.read()).credits?.balance, 10);
      a.fail(6 * 3_600_000);
    });
  }
  // Control: the same burn half an hour on still carries (10 - 5 > 0), so the projection is what refuses.
  const soon = codexAccount(t);
  soon.state.balance = "20"; await soon.read();
  soon.state.now += 3_600_000; soon.state.balance = "10"; clearCodexCapacityCache(); await soon.read();
  soon.fail(1_800_000);
  const halfHour = await soon.read();
  assert.equal(halfHour.readable, true, halfHour.detail);
  assert.ok(Math.abs((halfHour.credits?.balance ?? 0) - 5) < 1e-6, "the projected balance is what the selection sees");
  const tiny = codexAccount(t);
  tiny.state.balance = "0.00000000004";
  await tiny.read();
  tiny.fail();
  const tinyBalance = await tiny.read();
  assert.equal(tinyBalance.credits?.balance, 4e-11, tinyBalance.detail);
  const tinySpawn = await routeSpawn(tiny);
  assert.equal(tinySpawn.decision?.rule, "codex-credits");
  assert.equal(tinySpawn.codexSpawns, 1);
  assert.equal(tinySpawn.cashSpawns, 0);
  // A terminal probe failure, an invalidated last-good reading, and an absent one.
  await refused("terminal", async (a) => { await a.read(); a.state.now += 61_000; a.state.mode = "rpc"; });
  await refused("invalidated", async (a) => {
    await a.read(); a.state.now += 61_000; a.state.mode = "rpc"; await a.read(); clearCodexCapacityCache(); a.fail();
  });
  await refused("absent", async (a) => { await a.read(); rmSync(a.lastGood); clearCodexCapacityCache(); a.fail(); });
});

test("W1-T13855 criterion 9: the by-ID generic bucket keeps its own credit history when the top-level reading falls", async (t) => {
  const account = codexAccount(t);
  account.state.balance = "20";
  account.state.buckets.codex = { limitId: "codex",
    primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: account.state.reset },
    credits: { hasCredits: true, unlimited: false, balance: "10" } };
  assert.equal((await account.read()).credits?.balance, 10);
  account.state.now += 3_600_000;
  account.state.balance = "10";
  assert.equal((await account.read()).credits?.balance, 10);
  account.fail(6 * 3_600_000);

  const spawn = await routeSpawn(account);
  assert.equal(spawn.decision?.rule, "codex-credits");
  assert.deepEqual(spawn.decision?.considered.find((entry) => entry.provider === "codex")?.creditsRescue,
    { path: "carried", tier: "codex-credits", projectedBalance: 10, ageMs: 6 * 3_600_000, failureKind: "timeout" });
  assert.equal(spawn.codexSpawns, 1);
  assert.equal(spawn.cashSpawns, 0);
});

test("W1-T13855 criterion 9: a newly visible model with its own credits starts without measured credit burn", async (t) => {
  const account = codexAccount(t);
  account.state.balance = "20";
  account.state.models = [SOL61];
  const previous = await account.read();
  assert.equal(previous.model, SOL61.id);
  assert.equal(previous.credits?.balance, 20);

  account.state.now += 3_600_000;
  account.state.balance = "10";
  account.state.models.push(SOL);
  account.state.buckets.sol = { limitName: SOL.id,
    primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: account.state.reset },
    credits: { hasCredits: true, unlimited: false, balance: "10" } };
  assert.equal((await account.read()).credits?.balance, 10);
  account.fail(6 * 3_600_000);

  const spawn = await routeSpawn(account);
  assert.equal(spawn.decision?.rule, "codex-credits");
  assert.equal(spawn.assignments.at(-1)?.selected.model, SOL.id);
  assert.deepEqual(spawn.decision?.considered.find((entry) => entry.provider === "codex")?.creditsRescue,
    { path: "carried", tier: "codex-credits", projectedBalance: 10, ageMs: 6 * 3_600_000, failureKind: "timeout" });
  assert.equal(spawn.codexSpawns, 1);
  assert.equal(spawn.cashSpawns, 0);
});

test("W1-T13855 criterion 10: the credits lane lifts no memory, CPU or host-worker bound", async (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const squeeze = statusFor(root, START, [claudeAt(95), creditsCodex()]);
  const live = (nowMs: number) => ({ ...squeeze, observedAt: new Date(nowMs).toISOString(), freshUntil: new Date(nowMs + 60_000).toISOString() });
  // The host-worker budget binding: the reason stays host-worker-budget beside a fresh credits lane.
  const bound = widen(4, live, { activeWorkers: 4 });
  assert.ok(bound.every((d) => d.reason === "host-worker-budget" && d.effectiveWidth === BOUNDS.baseWidth));
  assert.ok(bound.every((d) => d.evidence.providerCreditsLane === true), "control: the credits lane was seen");
  // The widener never passes its max width, however long the credits lane carries.
  const long = widen(20, live);
  assert.ok(long.every((d) => d.effectiveWidth <= BOUNDS.maxWidth));
  assert.equal(long.at(-1)!.effectiveWidth, BOUNDS.maxWidth);
  // Memory pressure still sheds beside the credits lane.
  assert.ok(widen(3, live, { memAvailableMib: 1_000 }).every((d) => d.reason === "memory-reserve"));

  statusFor(root, DAEMON_NOW - 120_000, [claudeAt(95), creditsCodex()]);
  const parked = await governedTick(root, true, "unreadable");
  const empty = scratchRoot();
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const plain = await governedTick(empty, true, "unreadable");
  const degraded = (run: typeof parked) => run.lines.filter((line) => line.step.startsWith("daemon.headroom")).map((line) => line.step);
  assert.ok(degraded(parked).includes("daemon.headroom.degraded"), "control: the unreadable usage parked the governor");
  assert.deepEqual(degraded(parked), degraded(plain));
  assert.equal(parked.spawned, 0);
  assert.equal(plain.spawned, 0);
});

test("W1-T13855 criterion 4: a lapsed credits row outside the current routing policy is not credits-lane room", (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const both = resolveProviderRoutingPolicy(root, { workerProviders: { enabled: ["claude", "codex"], reservePercent: 5 } });
  const capacities = [claudeAt(95), creditsCodex()];
  writeProviderRoutingStatus(root, { enabledProviders: ["claude", "codex"], reservePercent: 5, observedAtMs: START,
    cacheValidMs: 60_000, policy: both, state: "selected", capacities, selection: selectWorkerProvider(capacities, 5, 0.5) });
  assert.equal(routingStatus.creditsLaneRoom(readProviderRoutingStatus(root, { now: () => START }), START), true,
    "control: the codex credits row counts while codex is routable");
  // A restart into Claude-only: the not-probed write keeps the prior reading and replaces only the policy.
  const claudeOnly = resolveProviderRoutingPolicy(root, { workerProviders: { enabled: ["claude"], reservePercent: 5 } });
  assert.deepEqual(claudeOnly.routableProviders, ["claude"]);
  writeProviderRoutingStatus(root, { enabledProviders: ["claude"], reservePercent: 5, observedAtMs: START + 120_000,
    cacheValidMs: 60_000, policy: claudeOnly, state: "not-probed" });
  const nowMs = START + 120_000;
  const kept = readProviderRoutingStatus(root, { now: () => nowMs });
  assert.equal(kept.providers?.find((row) => row.provider === "codex")?.creditsLane, true, "the lapsed codex row is retained");
  assert.deepEqual(kept.policy?.routableProviders, ["claude"]);
  assert.equal(routingStatus.creditsLaneRoom(kept, nowMs), false, "codex is not routable, so its credits carry nothing");
  assert.deepEqual(widen(5, (at) => ({ ...kept, observedAt: new Date(at - 120_000).toISOString() })).map((d) => [d.reason, d.effectiveWidth]),
    widen(5, (at) => ({ ...unflagged(kept), observedAt: new Date(at - 120_000).toISOString() })).map((d) => [d.reason, d.effectiveWidth]));
});

test("W1-T13855 criterion 6 (carryCodexCapacity reserve pass): a malformed unreset window still makes the carry unreadable", async (t) => {
  const account = codexAccount(t);
  account.state.extras = { primary: { usedPercent: "unknown", windowDurationMins: 10080, resetsAt: account.state.reset } };
  account.state.buckets.codex = { limitId: "codex",
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: account.state.reset },
    credits: { hasCredits: true, unlimited: false, balance: BALANCE } };
  await account.read();
  assert.ok(readFileSync(account.lastGood, "utf8").includes("unknown"), "control: the last-good reading holds the malformed window");
  account.fail();
  const carried = await account.read();
  assert.equal(carried.readable, false, `a malformed window is unreadable, never dropped: ${carried.detail}`);
  assert.match(carried.detail ?? "", /unreadable quota window/);
  assert.equal(carried.carriedForward, undefined);
});

test("W1-T13855 criterion 7: lapsed Claude headroom cannot veto Codex credits after a Codex-only policy update", (t) => {
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nowMs = START + 120_000;
  const capacities = [claudeAt(94), creditsCodex()];
  statusFor(root, START, capacities);
  const before = readProviderRoutingStatus(root, { now: () => nowMs });
  assert.equal(before.freshness, "stale");
  assert.equal(reviewProviderObservation(before, nowMs).creditsLane, undefined, "Claude is above reserve and routable");

  const policy = resolveProviderRoutingPolicy(root, { workerProviders: { enabled: ["codex"], reservePercent: 5 } });
  writeProviderRoutingStatus(root, { enabledProviders: ["codex"], reservePercent: 5, observedAtMs: nowMs,
    cacheValidMs: 60_000, policy, state: "not-probed" });
  const after = readProviderRoutingStatus(root, { now: () => nowMs });
  assert.equal(after.freshness, "stale");
  assert.equal(after.providers?.find((row) => row.provider === "claude")?.windows[0]?.usedPercent, 94);
  assert.deepEqual(after.policy?.routableProviders, ["codex"]);
  assert.equal(reviewProviderObservation(after, nowMs).creditsLane, true);
  const width = (status: ProviderRoutingStatus) =>
    selectAdaptiveReviewWidth(initialReviewCapacityState(BOUNDS.baseWidth), POLICY, hostHealthy(nowMs, status), BOUNDS).decision;
  assert.equal(width(before).reason, "provider-headroom");
  assert.equal(width(after).reason, "healthy-window");
});

test("W1-T13855 criterion 4: an ordinary successful cash fallback leaves a healthy review observation intact", async (t) => {
  const account = codexAccount(t);
  const root = account.cfg.root;
  account.state.used = 40;
  await routeSpawn(account, 80, { root, write: true });
  const before = readProviderRoutingStatus(root, { now: () => account.state.now });
  assert.equal(before.state, "selected");
  assert.equal(before.providers?.find((row) => row.provider === "codex")?.creditsLane, undefined);

  account.state.now += 5_000;
  account.state.used = 99;
  account.state.balance = "0";
  const fallback = await routeSpawn(account, 99, { root, write: true });
  assert.equal(fallback.decision?.rule, "cash-fallback");
  assert.equal(fallback.cashSpawns, 1);
  assert.equal(fallback.result.isError, false);
  const after = readProviderRoutingStatus(root, { now: () => account.state.now });
  assert.deepEqual(after, before);
  const review = selectAdaptiveReviewWidth(initialReviewCapacityState(BOUNDS.baseWidth), POLICY,
    hostHealthy(account.state.now, after), BOUNDS).decision;
  assert.equal(review.reason, "healthy-window");
  assert.equal(review.effectiveWidth, BOUNDS.baseWidth);
});

test("W1-T13855 criterion 4: a blocked auction with exhausted cash allowance sheds review width", async (t) => {
  const account = codexAccount(t);
  const root = account.cfg.root;
  account.state.used = 40;
  await routeSpawn(account, 80, { root, write: true });
  const before = readProviderRoutingStatus(root, { now: () => account.state.now });
  const review = (status: ProviderRoutingStatus) => selectAdaptiveReviewWidth(initialReviewCapacityState(BOUNDS.baseWidth),
    POLICY, hostHealthy(account.state.now, status), BOUNDS).decision;
  assert.equal(before.state, "selected");
  assert.equal(review(before).reason, "healthy-window");
  assert.equal(review(before).effectiveWidth, 4);

  writeFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), JSON.stringify({ utcDay: "2026-11-19", reservations: {
    earlier: { reservedUsd: 20, settledUsd: null, deployment: "gpt-6-luna" },
  } }));
  account.state.now += 5_000;
  account.state.used = 99;
  account.state.balance = "0";
  await assert.rejects(routeSpawn(account, 99, { root, write: true }), /cash daily allowance exhausted until/);

  const after = readProviderRoutingStatus(root, { now: () => account.state.now });
  const decision = review(after);
  assert.deepEqual([decision.reason, decision.effectiveWidth], ["provider-refused", 3]);
  assert.equal(after.state, "blocked");
  assert.equal(after.observedAt, new Date(account.state.now).toISOString());
  assert.equal(decision.evidence.providerCreditsLane, undefined);
});

test("W1-T13855 criterion 7 (creditsLaneRoom from review-capacity): a cash fallback after credits ran out leaves no credits room", async (t) => {
  const account = codexAccount(t);
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await routeSpawn(account, 99, { root, write: true });
  assert.equal(first.decision?.rule, "codex-credits", "control: the first spawn rides the credits lane");
  const before = readProviderRoutingStatus(root, { now: () => account.state.now });
  assert.equal(routingStatus.creditsLaneRoom(before, account.state.now), true,
    "control: the first spawn's status shows credits room");
  account.state.now += 5_000;
  account.state.balance = "0";
  const second = await routeSpawn(account, 99, { root, write: true });
  assert.equal(second.decision?.rule, "cash-fallback", "control: with no credits the auction falls to cash");
  assert.equal(second.cashSpawns, 1);
  const status = readProviderRoutingStatus(root, { now: () => account.state.now });
  assert.deepEqual(status, unflagged(before), "fallback removes only the prior credits signal");
  assert.equal(routingStatus.creditsLaneRoom(status, account.state.now), false, "the newer auction refused codex");
  assert.equal(reviewProviderObservation(status, account.state.now).creditsLane, undefined);

  const newerAt = account.state.now + 1_000;
  const newer = statusFor(root, newerAt, [claudeAt(99), creditsCodex()]);
  assert.equal((await routeSpawn(account, 99, { root, write: true })).decision?.rule, "cash-fallback");
  assert.deepEqual(readProviderRoutingStatus(root, { now: () => newerAt }), newer,
    "a fallback cannot invalidate a more recent credits observation");
});

test("W1-T13855 criterion 7: a funded publication racing fallback invalidation keeps the review credits lane", async (t) => {
  const account = codexAccount(t);
  const root = scratchRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await routeSpawn(account, 99, { root, write: true });
  assert.equal(first.decision?.rule, "codex-credits");
  account.state.now += 5_000;
  account.state.balance = "0";
  const newerAt = account.state.now + 1_000;
  const publishFunded = () => statusFor(root, newerAt, [claudeAt(99), creditsCodex()]);

  const target = providerRoutingStatusPath(root);
  const rename = fs.renameSync;
  const realNow = Date.now;
  let interleaved = false;
  let queued = false;
  const hook = t.mock.method(fs, "renameSync", (from: PathLike, to: PathLike) => {
    if (to === target && !interleaved) {
      interleaved = true;
      // Distinct staging paths model separate worker processes, even within the same millisecond.
      const clock = t.mock.method(Date, "now", () => realNow() + 60_000);
      try { publishFunded(); }
      catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        queued = true;
      } finally {
        clock.mock.restore();
      }
    }
    rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await routeSpawn(account, 99, { root, write: true })).decision?.rule, "cash-fallback");
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(interleaved, true, "publication was attempted after fallback staged its update");
  if (queued) {
    const invalidated = readProviderRoutingStatus(root, { now: () => newerAt });
    assert.equal(routingStatus.creditsLaneRoom(invalidated, newerAt), false);
    publishFunded();
  }
  const status = readProviderRoutingStatus(root, { now: () => newerAt });
  assert.equal(status.observedAt, new Date(newerAt).toISOString());
  assert.equal(routingStatus.creditsLaneRoom(status, newerAt), true);
  assert.equal(reviewProviderObservation(status, newerAt).creditsLane, true);
});

test("W1-T13855 criterion 7: a delayed funded publication cannot restore the review credits lane after cash fallback", async (t) => {
  const account = codexAccount(t);
  const root = account.cfg.root;
  const funded = [claudeAt(99), creditsCodex()];
  const before = statusFor(root, START, funded);
  assert.equal(reviewProviderObservation(before, START).creditsLane, true);

  const fallbackAt = START + 5_000;
  account.state.now = fallbackAt;
  account.state.balance = "0";
  assert.equal((await routeSpawn(account, 99, { root, write: true })).decision?.rule, "cash-fallback");
  const readStatus = () => readProviderRoutingStatus(root, { now: () => fallbackAt });
  const invalidated = readStatus();
  assert.equal(reviewProviderObservation(invalidated, fallbackAt).creditsLane, undefined);

  for (const delayedAt of [fallbackAt - 1, fallbackAt]) {
    statusFor(root, delayedAt, funded);
    const after = readStatus();
    assert.deepEqual(after, invalidated);
    const observation = hostHealthy(fallbackAt, after);
    assert.equal(observation.provider.creditsLane, undefined);
    const { decision } = selectAdaptiveReviewWidth(initialReviewCapacityState(BOUNDS.baseWidth), POLICY,
      observation, BOUNDS);
    assert.equal(decision.reason, "provider-headroom");
  }

  const newer = statusFor(root, fallbackAt + 1, funded);
  assert.equal(reviewProviderObservation(newer, fallbackAt + 1).creditsLane, true);
  statusFor(root, fallbackAt - 1, funded);
  assert.deepEqual(readStatus(), newer, "a later publication preserves the cutoff for delayed writers");
});

test("W1-T13855 criterion 4: cash fallback preserves delayed Claude subscription headroom", async (t) => {
  const account = codexAccount(t);
  const root = account.cfg.root;
  const codex = creditsCodex();
  const before = statusFor(root, START - 5_000, [claudeAt(95), codex]);
  assert.equal(reviewProviderObservation(before, START).creditsLane, true);

  account.state.balance = "0";
  assert.equal((await routeSpawn(account, 99, { root, write: true })).decision?.rule, "cash-fallback");
  const readStatus = (nowMs: number) => readProviderRoutingStatus(root, { now: () => nowMs });
  assert.deepEqual(widen(3, readStatus).map(({ reason, effectiveWidth }) => [reason, effectiveWidth]),
    [["provider-headroom", 4], ["provider-headroom", 4], ["provider-headroom", 4]]);

  const delayedAt = START - 1;
  statusFor(root, delayedAt, [claudeAt(90), codex]);
  const delayed = readStatus(START);
  assert.equal(delayed.selected?.provider, "claude");
  assert.equal(delayed.observedAt, new Date(delayedAt).toISOString());
  assert.equal(delayed.providers?.find((row) => row.provider === "codex")?.creditsLane, undefined);
  assert.equal(reviewProviderObservation(delayed, START).headroomPct, 10);
  const decision = widen(3, readStatus).at(-1)!;
  assert.deepEqual([decision.reason, decision.effectiveWidth, decision.evidence.providerCreditsLane],
    ["healthy-window", 5, undefined]);

  const newer = statusFor(root, START + 1, [claudeAt(95), codex]);
  statusFor(root, delayedAt, [claudeAt(90), codex]);
  assert.deepEqual(readStatus(START + 1), newer);
});

test("a first cash fallback records the credits cutoff before any funded status reaches disk", async (t) => {
  const account = codexAccount(t);
  const root = account.cfg.root;
  const fallbackAt = START + 5_000;
  account.state.now = fallbackAt;
  account.state.balance = "0";
  assert.equal((await routeSpawn(account, 99, { root, write: true })).decision?.rule, "cash-fallback");

  const delayed = statusFor(root, START, [claudeAt(99), creditsCodex()]);
  assert.equal(delayed.state, "not-probed");
  assert.equal(reviewProviderObservation(delayed, fallbackAt).creditsLane, undefined);
  const newer = statusFor(root, fallbackAt + 1, [claudeAt(99), creditsCodex()]);
  assert.equal(reviewProviderObservation(newer, fallbackAt + 1).creditsLane, true);
});
