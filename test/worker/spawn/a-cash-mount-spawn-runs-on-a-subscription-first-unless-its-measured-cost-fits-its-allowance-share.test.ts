import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { draftStatsFromRows, type DraftStats } from "#src/lib/draft-routing.js";
import { mountsPath } from "#src/lib/mounts.js";
import { openWeightAllowancePath, openWeightReservationUsd, readOpenWeightAllowance, type ProviderCapacity } from "#src/lib/worker-provider.js";
import {
  buildInboxDraftWorkerArgs,
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13672. OPERATOR RULING 2026-11-18: the Claude and Codex subscriptions have headroom left, so the cash lane serves
// only the cheap judge and summary calls that would not fill the cap. MEASURED that day by 11:10Z: cash had settled
// $9.32 of the $10 cap, $8.87 of it on inbox drafts (gpt-6-luna $6.25 for 1 success in 15, claude-haiku-5-5 $2.59 for
// 2 in 30), while every judge and summary lane together took $0.45 for 260 calls. Every test below runs the real
// spawnWorker; only the capacity reads and the provider calls are stubbed. The cash billing module is imported
// dynamically so this suite still loads where it does not exist, and criterion 1 can go red there for its own reason.

const NOW = Date.parse("2026-11-18T11:10:00.000Z");
const ISO = fixedClock(NOW).iso();
const COMMITTED_MOUNTS = readFileSync(mountsPath(REPO_ROOT), "utf8");
const ENDPOINT = "https://foundry.example.test/";
/** A proposal draft embeds the whole plan: 550k estimated tokens, which only gpt-6-luna and claude-haiku-5-5 hold. */
const DRAFT_PROMPT = "x".repeat(2_200_000);
/** The escalation judge's shape: a short prompt, haiku at low effort, no tools. */
const JUDGE_PROMPT = "judge this escalation ".repeat(80);

async function billing() {
  return import("#src/lib/cash-lane-billing.js");
}

type Reservations = Record<string, unknown>;

/** One cash attempt's paid turns, in the allowance file's own shape: each turn a settled request of the attempt. */
function attempt(into: Reservations, attemptId: string, deployment: string, turnsUsd: readonly number[]): Reservations {
  turnsUsd.forEach((usd, turn) => {
    const requestId = `${attemptId}-${turn}`;
    into[requestId] = {
      reservedUsd: usd * 2, settledUsd: usd, deployment, accountingState: "usage-rated", usageEstimateUsd: usd, billedUsd: null, heldUsd: 0,
      identity: { requestId, attemptId, provider: "cash", deployment, endpoint: ENDPOINT },
    };
  });
  return into;
}

/** The judge and summary lanes' traffic: many attempts, each a fraction of a cent. */
function judgeTraffic(count: number, usd = 0.0015, into: Reservations = {}): Reservations {
  for (let i = 0; i < count; i++) attempt(into, `judge-${i}`, "gpt-oss-120b", [usd]);
  return into;
}

/** 2026-11-18 by 11:10Z, in miniature: 300 judge attempts and the 08:03Z gpt-6-luna attempt that settled $3.4473 over its
 *  paid turns before the allowance refused its next one. */
function measuredDay(): Reservations {
  return attempt(judgeTraffic(300), "luna-0803", "gpt-6-luna", [1.2, 1.2, 1.0473]);
}

/** The draft lane's measured posteriors, with haiku's last ten outcomes refused inside the hour so the router skips it. */
function measuredDraftStats(): DraftStats {
  const ts = systemClock.iso();
  const rows: Record<string, unknown>[] = [];
  const outcome = (deployment: string, clean: boolean, cost: number, end: string) => rows.push({
    step: "draft.routing.outcome", lane: "inbox-draft", deployment, ts, draft_cost_usd: cost, clean, contract_failed: false, outcome: end,
  });
  for (let i = 0; i < 15; i++) outcome("gpt-6-luna", i === 0, 6.2544 / 15, i === 0 ? "clean" : "not-clean");
  for (let i = 0; i < 20; i++) outcome("claude-haiku-5-5", i < 2, 2.5922 / 20, i < 2 ? "clean" : "not-clean");
  for (let i = 0; i < 10; i++) outcome("claude-haiku-5-5", false, 0, "refused");
  return draftStatsFromRows(rows, "inbox-draft");
}

interface Fixture { root: string; config: Config; allowance: string }

function fixture(t: test.TestContext, reservations: Reservations, cap = 10): Fixture {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  const root = mkdtempSync(join(parent, "rmd-cash-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The worker reads its capability table from its own checkout: the committed rows, unchanged.
  mkdirSync(dirname(mountsPath(root)), { recursive: true });
  writeFileSync(mountsPath(root), COMMITTED_MOUNTS);
  const config = {
    root, claudeBin: "/unused", workerHomeRoot: join(root, "worker-home"), dailyCapUsd: { normal: cap, squeezed: cap },
    workerProviders: { enabled: ["claude", "codex", "cash"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000,
      cashEndpoint: ENDPOINT },
  } as Config;
  const allowance = openWeightAllowancePath(config);
  mkdirSync(dirname(allowance), { recursive: true });
  writeFileSync(allowance, JSON.stringify({ utcDay: "2026-11-18", reservations }));
  return { root, config, allowance };
}

function capacity(provider: "claude" | "codex", usedPercent: number | undefined): ProviderCapacity {
  if (usedPercent === undefined) return { provider, readable: false, windows: [], detail: "fixture blocked" };
  return { provider, readable: true, windows: [{ name: `${provider} primary`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(provider === "codex" ? { model: "gpt-6-luna", effort: "high", accountLabel: "assigned-subscription" } : {}) };
}

function workerResult(provider: WorkerResult["provider"], model: string): WorkerResult {
  return {
    provider, sessionId: `${provider}-session`, costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model, routedModel: model, effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], compactionConfigured: false,
    compactionFailures: [], qualitySuspect: false, servedModel: null,
  };
}

interface Run {
  claudeUsed?: number;
  codexUsed?: number;
}

interface Observed {
  result: WorkerResult;
  assignments: WorkerSelectionAssignment[];
  cash: Array<{ model: string; squeezed: boolean }>;
  reads: { claude: number; codex: number };
  claudeRuns: number;
  codexRuns: number;
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
}

/** Run one spawn through the real router with stubbed capacity reads and provider calls. */
async function run(f: Fixture, args: SpawnWorkerArgs, subscriptions: Run = { claudeUsed: 20 }): Promise<Observed> {
  const observed: Observed = { result: undefined as never, assignments: [], cash: [], reads: { claude: 0, codex: 0 }, claudeRuns: 0, codexRuns: 0, rows: [] };
  if (args.draftRouting) {
    const log = args.draftRouting.log;
    args.draftRouting.log = (step, extra = {}) => { observed.rows.push({ step, extra }); log(step, extra); };
  }
  observed.result = await spawnWorker({
    ...args,
    config: f.config,
    onSelectionAssignment: (assignment) => observed.assignments.push(assignment),
    providerRouting: {
      now: () => NOW,
      writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => { observed.reads.claude++; return capacity("claude", subscriptions.claudeUsed); },
      readCodex: async () => { observed.reads.codex++; return capacity("codex", subscriptions.codexUsed); },
      spawnCodex: async () => { observed.codexRuns++; return workerResult("codex", "gpt-6-luna"); },
      spawnOpenWeight: async (spawnArgs, _config, selection) => {
        observed.cash.push({ model: selection.model, squeezed: spawnArgs.cashSqueezed === true });
        return workerResult("cash", selection.model);
      },
    },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: f.root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => {
      observed.claudeRuns++;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
  });
  return observed;
}

function draftArgs(f: Fixture, stats: () => DraftStats | Promise<DraftStats> = measuredDraftStats): SpawnWorkerArgs {
  return {
    ...buildInboxDraftWorkerArgs({
      cwd: f.root, settingsFile: join(REPO_ROOT, "settings", "worker.json"), prompt: DRAFT_PROMPT, config: f.config,
      mount: { model: "haiku", effort: "high", provider: "cash", maxTurns: 400, contextBudget: 180000 },
      disallowedTools: [], maxBudgetUsd: 5, tools: ["Read", "Grep", "Glob"],
    }),
    draftRouting: {
      lane: "inbox-draft", proposalId: "P1", log: () => {}, readStats: stats, random: () => 0.5,
      evaluate: () => ({ clean: true, contractFailed: false }),
    },
  };
}

function judgeArgs(f: Fixture, extra: Partial<SpawnWorkerArgs> = {}): SpawnWorkerArgs {
  return {
    cwd: f.root, settingsFile: join(REPO_ROOT, "settings", "worker.json"), permissionMode: "bypassPermissions",
    prompt: JUDGE_PROMPT, model: "haiku", effort: "low", maxTurns: 400, tools: [], mountProvider: "cash", ...extra,
  };
}

test("W1-T13672 criterion 1: a draft spawn whose measured cost misses its share runs on the subscription with headroom, never on cash", async (t) => {
  for (const subscriptions of [{ claudeUsed: 20 }, { codexUsed: 20 }] as const) {
    const f = fixture(t, measuredDay());
    const before = readFileSync(f.allowance, "utf8");
    const seen = await run(f, draftArgs(f), subscriptions);
    // At origin/main this is ["gpt-6-luna"]: the mount's cash affinity bought the draft with subscription headroom unused.
    assert.deepEqual(seen.cash, [], "the cash adapter is never called");
    const provider = subscriptions.claudeUsed !== undefined ? "claude" : "codex";
    assert.ok(seen.reads.claude + seen.reads.codex > 0, "the subscription capacity read decided the route");
    assert.equal(seen.result.provider, provider);
    assert.equal(provider === "claude" ? seen.claudeRuns : seen.codexRuns, 1);
    const assignment = seen.assignments.at(-1)!;
    assert.equal(assignment.selected.provider, provider);
    const deferred = assignment.routing.cash_deferred;
    assert.ok(deferred, "the assignment says the cash route was deferred");
    assert.ok(["gpt-6-luna", "claude-haiku-5-5"].includes(deferred.deployment));
    assert.equal(deferred.expectedCostSource, "draft-stats");
    assert.equal(deferred.shareSource, "projected-attempts");
    assert.ok(deferred.expectedCostUsd > deferred.shareUsd, JSON.stringify(deferred));
    assert.equal(seen.assignments.filter((row) => row.selected.provider === "cash").length, 0);
    assert.equal(readFileSync(f.allowance, "utf8"), before, "no cash reservation is written");
    assert.equal(seen.rows.filter((row) => row.step === "draft.routing.choice").length, 0, "no draft.routing.choice row");
  }
});

test("W1-T13672 criterion 2: the escalation judge's shape fits its share and runs on cash first, as on origin/main", async (t) => {
  const f = fixture(t, measuredDay());
  const seen = await run(f, judgeArgs(f));
  assert.deepEqual(seen.cash, [{ model: "gpt-oss-120b", squeezed: false }]);
  assert.deepEqual(seen.reads, { claude: 0, codex: 0 }, "a fitting judge never consults a subscription");
  assert.equal(seen.claudeRuns + seen.codexRuns, 0);
  assert.equal(seen.assignments.length, 1);
  const assignment = seen.assignments[0]!;
  assert.deepEqual(assignment.selected, { provider: "cash", model: "gpt-oss-120b", effort: "low" });
  assert.equal(assignment.routing.mode, "mount-affinity");
  assert.equal(assignment.routing.selectionPath, "mount-affinity");
  assert.equal(assignment.routing.decision?.rule, "mount-affinity");
  assert.equal(assignment.routing.cash_deferred, undefined);
});

test("W1-T13672 criterion 3: the share is the remaining room over today's projected attempts, and the same spawn flips with the measured rate and the reset", async () => {
  const { cashAdmission } = await billing();
  const judgeBytes = Buffer.byteLength(JUDGE_PROMPT, "utf8");
  const nanoReservation = openWeightReservationUsd("gpt-5-nano", 40_000);
  const read = (reservations: Reservations, atIso: string, deployments = ["gpt-5-nano"]) => {
    const config = fixtureConfigFor(reservations);
    try { return readOpenWeightAllowance(config.config, { deployments, atIso }); }
    finally { rmSync(config.root, { recursive: true, force: true }); }
  };
  // Low measured rate: 10 attempts in the 11 h 10 min since the reset.
  const low = read(judgeTraffic(10), ISO);
  assert.equal(low.attemptsToday, 10);
  const lowDecision = cashAdmission({ candidates: ["gpt-5-nano"], reading: low, promptBytes: 40_000, nowIso: ISO });
  const elapsed = 11 + 10 / 60, toReset = 12 + 50 / 60;
  const projected = 10 / elapsed * toReset;
  assert.equal(lowDecision.shareSource, "projected-attempts");
  assert.ok(Math.abs(lowDecision.shareUsd - (10 - 10 * 0.0015) / projected) < 1e-9, JSON.stringify(lowDecision));
  assert.ok(Math.abs(lowDecision.projectedAttempts - projected) < 1e-9);
  assert.equal(lowDecision.expectedCostSource, "first-request-reservation");
  assert.ok(Math.abs(lowDecision.expectedCostUsd - nanoReservation) < 1e-12);
  assert.equal(lowDecision.verdict, "admit");
  // High measured rate: 3,000 attempts by the same hour leave each projected attempt a fraction of a cent.
  const high = read(judgeTraffic(3000, 0.001), ISO);
  const highDecision = cashAdmission({ candidates: ["gpt-5-nano"], reading: high, promptBytes: 40_000, nowIso: ISO });
  assert.ok(Math.abs(highDecision.shareUsd - (10 - 3) / (3000 / elapsed * toReset)) < 1e-9);
  assert.equal(highDecision.verdict, "defer", JSON.stringify(highDecision));
  // After the reset the day's attempts are gone: the remaining room spread over the hours to the next reset.
  const nextIso = fixedClock(Date.parse("2026-11-19T00:30:00.000Z")).iso();
  const reset = read(judgeTraffic(3000, 0.001), nextIso);
  assert.equal(reset.attemptsToday, 0);
  const resetDecision = cashAdmission({ candidates: ["gpt-5-nano"], reading: reset, promptBytes: 40_000, nowIso: nextIso });
  assert.equal(resetDecision.shareSource, "hours-to-reset");
  assert.ok(Math.abs(resetDecision.shareUsd - 10 / 23.5) < 1e-9);
  assert.equal(resetDecision.verdict, "admit");
  // The projected attempts are at least one: a spawn late in the day is never offered more than the room left.
  const late = fixedClock(Date.parse("2026-11-18T23:59:00.000Z")).iso();
  const lateDecision = cashAdmission({ candidates: ["gpt-5-nano"], reading: read(judgeTraffic(1), late), promptBytes: 40_000, nowIso: late });
  assert.equal(lateDecision.projectedAttempts, 1);
  assert.ok(Math.abs(lateDecision.shareUsd - (10 - 0.0015)) < 1e-9);
  // The expected cost is the larger of the draft posterior's cost per clean draft and today's settled dollars per attempt.
  const stats: DraftStats = { "gpt-5-nano": { attempts: 9, clean: 4, contractFailures: 0, costUsd: 0.09 } };
  const draft = cashAdmission({ candidates: ["gpt-5-nano"], reading: low, draftStats: stats, promptBytes: 40_000, nowIso: ISO });
  assert.equal(draft.expectedCostSource, "draft-stats");
  assert.ok(Math.abs(draft.expectedCostUsd - 0.01 / (5 / (5 + 6))) < 1e-12, JSON.stringify(draft));
  const settledHeavy = read(attempt(judgeTraffic(10), "nano-a", "gpt-5-nano", [0.05, 0.05]), ISO);
  assert.equal(settledHeavy.settledToday["gpt-5-nano"]?.attempts, 1);
  const settled = cashAdmission({ candidates: ["gpt-5-nano"], reading: settledHeavy, draftStats: stats, promptBytes: 40_000, nowIso: ISO });
  assert.equal(settled.expectedCostSource, "settled-today");
  assert.ok(Math.abs(settled.expectedCostUsd - 0.1) < 1e-12);
  // The judge's cheapest holding candidate decides: gpt-oss-120b fits where the others are not even asked.
  const judge = cashAdmission({ candidates: ["gpt-oss-120b", "gpt-6-luna"], reading: read(measuredDay(), ISO, ["gpt-oss-120b", "gpt-6-luna"]),
    promptBytes: judgeBytes, nowIso: ISO });
  assert.equal(judge.verdict, "admit");
  assert.equal(judge.deployment, "gpt-oss-120b");
});

function fixtureConfigFor(reservations: Reservations): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-share-"));
  const config = { root, claudeBin: "/unused", dailyCapUsd: 10, workerProviders: { enabled: ["cash"], cashEndpoint: ENDPOINT } } as Config;
  const path = openWeightAllowancePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ utcDay: "2026-11-18", reservations }));
  return { root, config };
}

test("W1-T13672 criterion 4: a deployment whose attempts today each settled several paid turns is deferred before its first turn", async (t) => {
  const { cashAdmission } = await billing();
  const f = fixture(t, measuredDay());
  // Only gpt-6-luna is left to this spawn, and its FIRST request is cheap: the reservation alone would fit the share.
  const avoid = ["gpt-oss-120b", "gpt-5-nano", "gpt-5.6-luna", "claude-haiku-5-5"];
  const prompt = "y".repeat(40_000);
  const reading = readOpenWeightAllowance(f.config, { deployments: ["gpt-6-luna"], atIso: ISO });
  assert.equal(reading.settledToday["gpt-6-luna"]?.attempts, 1, "three paid turns are one attempt");
  assert.ok(Math.abs(reading.settledToday["gpt-6-luna"]!.settledUsd - 3.4473) < 1e-9);
  const firstRequestOnly = cashAdmission({ candidates: ["gpt-6-luna"], reading: { ...reading, settledToday: {} },
    promptBytes: Buffer.byteLength(prompt, "utf8"), nowIso: ISO });
  assert.equal(firstRequestOnly.verdict, "admit", "judged by its first request's reservation alone, the luna attempt would start");
  const before = readFileSync(f.allowance, "utf8");
  const seen = await run(f, judgeArgs(f, { prompt, avoidModels: avoid }));
  assert.deepEqual(seen.cash, [], "no partly paid refused attempt is started");
  assert.equal(seen.result.provider, "claude");
  const deferred = seen.assignments.at(-1)!.routing.cash_deferred!;
  assert.equal(deferred.deployment, "gpt-6-luna");
  assert.equal(deferred.expectedCostSource, "settled-today");
  assert.ok(Math.abs(deferred.expectedCostUsd - 3.4473) < 1e-9);
  assert.ok(deferred.shareUsd > firstRequestOnly.expectedCostUsd, JSON.stringify({ deferred, firstRequestOnly }));
  assert.equal(readFileSync(f.allowance, "utf8"), before);
});

test("W1-T13672 criterion 6: with every subscription blocked a deferred draft is served by the cash route of origin/main", async (t) => {
  const f = fixture(t, measuredDay());
  // The squeeze fallback is enabled, so a deferred spawn that reached it would show its raised posture and rule here.
  f.config.workerProviders!.cashFallbackWhenBlocked = true;
  const seen = await run(f, draftArgs(f), {});
  assert.ok(seen.reads.claude + seen.reads.codex > 0, "the subscriptions were asked first");
  // The origin/main route: the mount's cash affinity in its normal posture, and the draft router's own choice.
  assert.deepEqual(seen.cash, [{ model: "gpt-6-luna", squeezed: false }]);
  assert.equal(seen.result.provider, "cash");
  const assignment = seen.assignments.at(-1)!;
  assert.equal(assignment.selected.provider, "cash");
  assert.equal(assignment.routing.decision?.rule, "mount-affinity", "not the squeeze fallback");
  const choice = seen.rows.find((row) => row.step === "draft.routing.choice");
  assert.equal(choice?.extra.deployment, "gpt-6-luna");
  assert.equal(choice?.extra.reason, "thompson-clean-per-dollar");
});

test("W1-T13672 criterion 6: trial pins, emergency spawns and routing fallbacks are never deferred", async (t) => {
  const pinned: Array<[string, Partial<SpawnWorkerArgs>, string]> = [
    ["inbox bake-off", { routingTrial: { id: "inbox-bakeoff", arm: "cash", reason: "bake-off candidate", models: ["gpt-6-luna"] } }, "gpt-6-luna"],
    ["judge shadow", { routingTrial: { id: "judge-shadow", arm: "cash", reason: "shadow", models: ["gpt-6-luna"] } }, "gpt-6-luna"],
    ["cash-simple", { routingTrial: { id: "cash-simple", arm: "cash", reason: "cash arm", models: ["gpt-6-luna"] } }, "gpt-6-luna"],
    ["cash Opus emergency", { model: "opus", cashOpusEmergency: true, cashSqueezed: true,
      routingFallback: { rule: "cash-opus-fallback", capacities: [] } }, "claude-opus-5-5"],
    ["cash Sonnet emergency", { model: "sonnet", cashSonnetEmergency: true, cashSqueezed: true,
      routingFallback: { rule: "cash-sonnet-fallback", capacities: [] } }, "claude-sonnet-5-5"],
    ["routing fallback", { cashSqueezed: true, routingFallback: { rule: "cash-fallback", capacities: [] } }, "gpt-6-luna"],
  ];
  for (const [name, extra, model] of pinned) {
    // Today's measured spend would defer each of these if it were ordinary mount work.
    const f = fixture(t, attempt(measuredDay(), "luna-b", "gpt-6-luna", [2]));
    const seen = await run(f, { ...judgeArgs(f, { prompt: DRAFT_PROMPT, ...extra }) });
    assert.equal(seen.cash.length, 1, name);
    assert.equal(seen.cash[0]!.model, model, name);
    assert.deepEqual(seen.reads, { claude: 0, codex: 0 }, `${name} never consults a subscription`);
    assert.equal(seen.assignments.at(-1)!.routing.cash_deferred, undefined, name);
  }
});

test("W1-T13672 criterion 6: an unreadable allowance or draft stats read keeps the cash-first route of origin/main", async (t) => {
  const broken = fixture(t, measuredDay());
  writeFileSync(broken.allowance, "{broken");
  const unreadable = await run(broken, draftArgs(broken));
  assert.deepEqual(unreadable.cash, [{ model: "gpt-6-luna", squeezed: false }]);
  assert.deepEqual(unreadable.reads, { claude: 0, codex: 0 });
  const f = fixture(t, measuredDay());
  const noStats = await run(f, draftArgs(f, () => { throw new Error("unreadable corpus"); }));
  assert.equal(noStats.cash.length, 1);
  assert.deepEqual(noStats.reads, { claude: 0, codex: 0 });
  assert.equal(noStats.rows.find((row) => row.step === "draft.routing.choice")?.extra.reason, "stats-read-failed-row-order");
  assert.equal(noStats.rows.filter((row) => row.step === "draft.routing.error").length, 1, "the stats are read once");
});
