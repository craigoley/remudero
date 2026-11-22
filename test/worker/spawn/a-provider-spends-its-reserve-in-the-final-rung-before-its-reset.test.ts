import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { resolveHeadroomLimitPct as daemonResolveHeadroomLimitPct } from "#src/lib/daemon.js";
import { buildDefaultHeadroomPolicy, resolveHeadroomLimitPct } from "#src/lib/headroom.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import {
  providerHeadroomTiming,
  selectWorkerProviderForPolicy,
  type EffectiveProviderRoutingPolicy,
} from "#src/lib/provider-routing-policy.js";
import { providerRoutingStatusPath, writeProviderRoutingStatus, type ProviderRoutingWriteInput } from "#src/lib/provider-routing-status.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import {
  clearCodexCapacityCache,
  providerEligibility,
  readCodexCapacity,
  selectCodexModel,
  selectWorkerProvider,
  windowHoursToReset,
  type CodexModelInfo,
  type ProviderCapacity,
  type ProviderHeadroomTiming,
} from "#src/lib/worker-provider.js";
import {
  auctionDrawSeed,
  createClaudeExecutableCache,
  selectWorkerProviderWithExclusions,
  spawnWorker,
  workerSelectionAssignment,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14200. Operator ruling 2026-11-21: keep the 5 percent reserve normally, but spend what is left in the last
// hours before a reset. The dispatch gate already relaxes on plan/policy.yaml's headroom curve; the auction now
// judges each window on the same curve, and outside the final rung nothing changes.

const HOUR = 3_600_000;
// The 2026-11-21 21:39Z host reading: weekly (all models) 95 percent used, resetting 2026-11-22T04:59:59Z.
const RESET_ISO = "2026-11-22T04:59:59Z";
const RESET_MS = Date.parse(RESET_ISO);
const NOW = RESET_MS - 7.3 * HOUR;
const timingAt = (nowMs: number): ProviderHeadroomTiming => ({ nowMs, policy: buildDefaultHeadroomPolicy() });
const TIMING = timingAt(NOW);

function claudeReading(resetsAt: string | number | undefined, usedPercent = 95): ProviderCapacity {
  return {
    provider: "claude",
    readable: true,
    windows: [
      { name: "weekly (all models)", usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) },
      { name: "weekly (Fable)", usedPercent: 0 },
    ],
  };
}
const CLAUDE_2139Z = claudeReading(RESET_ISO);
const epochSeconds = (ms: number) => Math.floor(ms / 1000);
function codexReading(usedPercent: number, resetMs: number | undefined, extra: Partial<ProviderCapacity> = {}): ProviderCapacity {
  return {
    provider: "codex",
    readable: true,
    windows: [{ name: "codex weekly", usedPercent, ...(resetMs === undefined ? {} : { resetsAt: epochSeconds(resetMs) }) }],
    model: "gpt-6-sol",
    effort: "high",
    ...extra,
  };
}
const CREDITS = { hasCredits: true, unlimited: false, balance: 250 };

const AUTOMATIC: EffectiveProviderRoutingPolicy = {
  provenance: "default",
  committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [], codexModelPreference: null },
  enabledProviders: ["claude", "codex"],
  routableProviders: ["claude", "codex"],
  preference: "automatic",
  reservePercent: 5,
  parks: [],
};

test("W1-T14200 criterion 1: the 21:39Z claude reading is admitted on subscription headroom 7.3 h before its reset", () => {
  // The default policy is plan/policy.yaml's curve: the final 24 h rung at 100 percent, the reserve at 95 otherwise.
  const loaded = providerHeadroomTiming(NOW, REPO_ROOT);
  assert.equal(loaded.nowMs, NOW);
  assert.deepEqual(loaded.policy, buildDefaultHeadroomPolicy(), "plan/policy.yaml's headroom.curve is the default curve");
  assert.equal(resolveHeadroomLimitPct(7.3, loaded.policy), 100);
  assert.equal(daemonResolveHeadroomLimitPct, resolveHeadroomLimitPct, "the dispatch gate and the auction share one curve function");

  assert.deepEqual(providerEligibility(CLAUDE_2139Z, 5, loaded), { eligible: true, headroomPercent: 5 });
  const drawn = selectWorkerProvider([CLAUDE_2139Z], 5, 0, undefined, loaded);
  assert.equal(drawn.provider, "claude");
  assert.equal(drawn.lane, undefined, "subscription headroom, not a credits lane");
  assert.equal(selectWorkerProviderForPolicy([CLAUDE_2139Z], AUTOMATIC, 0.5, loaded).selection.provider, "claude");
  // Without the curve (origin/main's judgement) the same reading is below the reserve.
  assert.deepEqual(providerEligibility(CLAUDE_2139Z, 5), { eligible: false, reason: "below-reserve", headroomPercent: 5 });
});

test("W1-T14200 criterion 2: each window is judged on its own rung, and both reset encodings are read", () => {
  const belowReserve = { eligible: false, reason: "below-reserve", headroomPercent: 5 };
  // 30 h before the reset is beyond the final rung.
  assert.deepEqual(providerEligibility(CLAUDE_2139Z, 5, timingAt(RESET_MS - 30 * HOUR)), belowReserve);
  // An absent, unparseable (human /usage text), malformed or already past reset keeps the strict rung.
  for (const resetsAt of [undefined, "Nov 22 at 5am", "not-a-date", "2026-11-21T20:00:00Z", Number.NaN]) {
    assert.deepEqual(providerEligibility(claudeReading(resetsAt), 5, TIMING), belowReserve, `resetsAt ${String(resetsAt)}`);
  }
  // A second window at 96 percent that resets in 3 days holds the reserve even though the first is in its final day.
  const twoWindows: ProviderCapacity = {
    provider: "claude",
    readable: true,
    windows: [
      { name: "weekly (all models)", usedPercent: 95, resetsAt: RESET_ISO },
      { name: "weekly (Fable)", usedPercent: 96, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
    ],
  };
  assert.deepEqual(providerEligibility(twoWindows, 5, TIMING), { eligible: false, reason: "below-reserve", headroomPercent: 4 });
  // Full is still full in the final rung.
  assert.equal(providerEligibility(claudeReading(RESET_ISO, 100), 5, TIMING).eligible, false);

  // Claude's ISO instant and codex's epoch seconds both read as hours-to-reset.
  assert.ok(Math.abs(windowHoursToReset(RESET_ISO, NOW)! - 7.3) < 1e-9);
  assert.ok(Math.abs(windowHoursToReset(RESET_MS / 1000, NOW)! - 7.3) < 1e-9);
  assert.equal(windowHoursToReset("Sat Nov 22 2026 05:00", NOW), null);
  assert.equal(windowHoursToReset(undefined, NOW), null);
  assert.deepEqual(providerEligibility(codexReading(97, NOW + 7 * HOUR), 5, TIMING), { eligible: true, headroomPercent: 3 });
  assert.equal(providerEligibility(codexReading(97, NOW + 72 * HOUR), 5, TIMING).reason, "below-reserve");
});

// ── Criterion 3: every production caller judges with the one timing ─────────────────────────────

const CAPABILITIES = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
const CODEX_CONFIG = { claudeBin: "/unused", root: REPO_ROOT, workerProviders: { enabled: ["claude" as const, "codex" as const], reservePercent: 5 } };
const SPARK: CodexModelInfo = {
  id: "gpt-5.3-codex-spark",
  displayName: "GPT-5.3-Codex-Spark",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const codexRateLimits = (usedPercent: number, resetMs: number, extra: Record<string, unknown> = {}) => ({
  rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent, windowDurationMins: 10080, resetsAt: epochSeconds(resetMs) }, ...extra } },
});

test("W1-T14200 criterion 3: the auction's helpers, its draw key and its recorded decision share the timing", () => {
  const claudeFull = claudeReading(new Date(NOW + 72 * HOUR).toISOString(), 99);
  const codex = codexReading(97, NOW + 7 * HOUR);
  const capacities = [claudeFull, codex];

  const routed = selectWorkerProviderWithExclusions(capacities, AUTOMATIC, 0, [], TIMING);
  assert.equal(routed.selection.provider, "codex");
  assert.equal(routed.selection.lane, undefined);
  // An exclusion is honoured only when another provider is eligible on the same curve.
  assert.deepEqual(selectWorkerProviderWithExclusions(capacities, AUTOMATIC, 0, ["claude"], TIMING).excludeProviders, ["claude"]);
  const preferClaude = selectWorkerProviderForPolicy(capacities, { ...AUTOMATIC, preference: "claude" }, 0, TIMING);
  assert.equal(preferClaude.selection.provider, "codex");
  assert.deepEqual(preferClaude.preferenceBypass, { provider: "claude", reason: "below-reserve" });

  const args = { cwd: "/w", prompt: "p", taskId: "W1-T14200", runId: "run-W1-T14200-1", model: "sonnet" } as SpawnWorkerArgs;
  const seed = auctionDrawSeed(args, AUTOMATIC, capacities, undefined, TIMING);
  assert.equal(seed.unit, "spawn");
  const row = workerSelectionAssignment(args, {
    provider: "codex", model: "gpt-6-sol", effort: "high", capacity: codex, capacities, mode: "multi-provider",
    selectionPath: "auction", policy: AUTOMATIC, selection: routed.selection, headroomTiming: TIMING,
  });
  const considered = Object.fromEntries((row.routing.decision?.considered ?? []).map((entry) => [entry.provider, entry]));
  assert.equal(considered.codex?.eligible, true, "the record names the eligibility the auction used");
  assert.equal(considered.codex?.lane, undefined);
  assert.equal(considered.claude?.eligible, false);
  assert.equal(considered.claude?.reason, "below-reserve");
  const untimed = workerSelectionAssignment(args, {
    provider: "codex", model: "gpt-6-sol", effort: "high", capacity: codex, capacities, mode: "multi-provider",
    selectionPath: "auction", policy: AUTOMATIC, selection: routed.selection,
  });
  assert.equal(untimed.routing.decision?.considered.find((entry) => entry.provider === "codex")?.eligible, false, "control: no timing, flat reserve");
});

test("W1-T14200 criterion 3: selectCodexModel admits a final-rung codex window on subscription, not only on credits", () => {
  const select = (rateLimits: unknown, timing?: ProviderHeadroomTiming) => selectCodexModel([SPARK], rateLimits, CODEX_CONFIG,
    "haiku", "low", CAPABILITIES, timing ? { headroomTiming: timing } : {});
  const finalRung = select(codexRateLimits(97, NOW + 7 * HOUR), TIMING);
  assert.equal(finalRung.readable, true);
  assert.equal(finalRung.exhausted, undefined);
  const option = finalRung.modelDecision?.options.find((entry) => entry.id === SPARK.id);
  assert.equal(option?.eligible, true);
  assert.equal(option?.lane, undefined);
  assert.equal(providerEligibility(finalRung, 5, TIMING).lane, undefined);
  // With credits on the bucket the subscription still carries it, so the credits lane is not drawn.
  const withCredits = select(codexRateLimits(97, NOW + 7 * HOUR, { credits: { hasCredits: true, unlimited: false, balance: "250" } }), TIMING);
  assert.equal(withCredits.modelDecision?.options.find((entry) => entry.id === SPARK.id)?.lane, undefined);
  // Control: the flat reserve marks the same reading exhausted.
  const flat = select(codexRateLimits(97, NOW + 7 * HOUR));
  assert.equal(flat.readable, false);
  assert.equal(flat.exhausted, true);
});

const CARRY_START = Date.parse("2026-11-21T12:00:00.000Z");
const CARRY_MODELS = [{ id: "gpt-6.1-sol", displayName: "Sol", isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
/** A codex app-server stand-in that answers, then times out, so the second read carries the first forward. */
function carryFixture(t: test.TestContext, used: number, resetMs: number, durationMins: number) {
  clearCodexCapacityCache();
  const root = mkdtempSync(join(tmpdir(), "rmd-final-rung-carry-"));
  const cfg: Config = { root, claudeBin: "/unused", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexHome: join(root, "codex"), capacityCacheMs: 1 } };
  const state = { now: CARRY_START, timeout: false };
  const spawn = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
    stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const request = JSON.parse(line) as { id?: number };
        if (state.timeout) continue;
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) {
          const bucket = { limitId: "codex", primary: { usedPercent: used, windowDurationMins: durationMins, resetsAt: epochSeconds(resetMs) } };
          stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: bucket } })}\n`);
        }
        if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: CARRY_MODELS, nextCursor: null } })}\n`);
      }
    });
    return proc as never;
  };
  const read = (timing?: ProviderHeadroomTiming) => readCodexCapacity(cfg, { spawn, now: () => state.now, timeoutMs: 10,
    requestedModel: "sonnet", requestedEffort: "medium", reservePercent: 5, ...(timing ? { headroomTiming: timing } : {}) });
  t.after(() => { clearCodexCapacityCache(); rmSync(root, { recursive: true, force: true }); });
  return { state, read };
}

test("W1-T14200 criterion 3: carryCodexCapacity projects a final-rung window against the curve", async (t) => {
  for (const timed of [true, false]) {
    // 90 percent used an hour before its reset: the projected burn reaches 96 percent four minutes later.
    const f = carryFixture(t, 90, CARRY_START + HOUR, 120);
    assert.equal((await f.read()).readable, true);
    f.state.timeout = true;
    f.state.now = CARRY_START + 4 * 60_000;
    const carried = await f.read(timed ? timingAt(f.state.now) : undefined);
    assert.equal(carried.readable, timed, `timed=${timed}`);
    assert.equal(carried.carriedForward?.readAt, timed ? CARRY_START : undefined, `timed=${timed}`);
    if (timed) assert.ok(carried.windows[0]!.usedPercent >= 95 && carried.windows[0]!.usedPercent < 100);
  }
});

test("W1-T14200 criterion 3: the published routing status names the lane the auction drew", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-final-rung-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codex = codexReading(97, NOW + 7 * HOUR, { credits: CREDITS });
  const publish = (timing?: ProviderHeadroomTiming) => {
    writeProviderRoutingStatus(root, {
      state: "blocked", enabledProviders: ["codex"], reservePercent: 5, observedAtMs: NOW, cacheValidMs: 60_000,
      capacities: [codex], ...(timing ? { headroomTiming: timing } : {}),
    });
    return JSON.parse(readFileSync(providerRoutingStatusPath(root), "utf8")) as { providers: Array<{ creditsLane?: true }> };
  };
  assert.equal(publish(TIMING).providers[0]?.creditsLane, undefined, "subscription headroom in the final rung");
  assert.equal(publish().providers[0]?.creditsLane, true, "control: the flat reserve reads it as the credits lane");
});

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

function codexResult(): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6-sol",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

test("W1-T14200 criterion 3: spawnWorker threads ONE timing through the codex read, the auction, its record and its status", async (t) => {
  const root = fixtureRoot("rmd-final-rung-spawn-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = buildDefaultHeadroomPolicy();
  const codexRequests: Array<{ headroomTiming?: ProviderHeadroomTiming; selectedModel?: string }> = [];
  const statuses: ProviderRoutingWriteInput[] = [];
  const assignments: WorkerSelectionAssignment[] = [];
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "implement",
    model: "sonnet",
    effort: "high",
    taskId: "W1-T14200",
    runId: "run-W1-T14200-1",
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => claudeReading(new Date(NOW + 72 * HOUR).toISOString(), 99),
      readCodex: async (_config, request) => {
        codexRequests.push(request);
        return codexReading(97, NOW + 7 * HOUR);
      },
      spawnCodex: async () => codexResult(),
      writeStatus: (_root, input) => { statuses.push(input); },
      now: () => NOW,
      loadHeadroomPolicy: () => policy,
    },
    onSelectionAssignment: (assignment) => assignments.push(assignment),
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
    })()) as never,
  });
  assert.equal(result.provider, "codex", "the final-rung codex window carried the work");
  // The auction's reads judge the reserve; the attribution re-read of the chosen model judges none, so it carries none.
  const auctionReads = codexRequests.filter((request) => request.selectedModel === undefined);
  assert.ok(auctionReads.length >= 1);
  const timing = auctionReads[0]!.headroomTiming;
  assert.deepEqual(timing, { nowMs: NOW, policy });
  for (const request of auctionReads) assert.equal(request.headroomTiming, timing, "every auction codex read gets the same timing");
  const timedStatuses = statuses.filter((input) => input.state === "selected");
  assert.ok(timedStatuses.length >= 1, "the selection is published");
  for (const input of timedStatuses) assert.equal(input.headroomTiming, timing, "the published status judges with the same timing");
  assert.equal(assignments.length, 1);
  const considered = Object.fromEntries((assignments[0]!.routing.decision?.considered ?? []).map((entry) => [entry.provider, entry]));
  assert.equal(considered.codex?.eligible, true);
  assert.equal(considered.codex?.selected, true);
  assert.equal(considered.claude?.eligible, false);
});

test("W1-T14200 criterion 3: every production caller of providerEligibility passes a timing", () => {
  const srcRoot = join(REPO_ROOT, "src");
  const files = (readdirSync(srcRoot, { recursive: true }) as string[]).filter((path) => path.endsWith(".ts"));
  const calls: Array<{ file: string; args: string }> = [];
  for (const file of files) {
    const text = readFileSync(join(srcRoot, file), "utf8");
    for (const match of text.matchAll(/(?<!function )\bproviderEligibility\(/g)) {
      // Read the call's argument list up to its balanced closing paren and count top-level arguments.
      let depth = 0, end = match.index! + match[0].length - 1;
      for (; end < text.length; end++) {
        if ("([{".includes(text[end]!)) depth++;
        if (")]}".includes(text[end]!) && --depth === 0) break;
      }
      calls.push({ file, args: text.slice(match.index! + match[0].length, end) });
    }
  }
  const topLevelArgs = (args: string) => {
    let depth = 0, count = 1;
    for (const char of args) {
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) depth--;
      else if (char === "," && depth === 0) count++;
    }
    return count;
  };
  // Today's callers: provider-routing-policy.ts (3), provider-routing-status.ts (1), worker-provider.ts (3),
  // worker.ts (4) and run-task.ts (1). A scan that finds fewer has lost its corpus, not passed.
  assert.ok(calls.length >= 12, `found ${calls.length} providerEligibility calls`);
  for (const call of calls) assert.equal(topLevelArgs(call.args), 3, `${call.file}: providerEligibility(${call.args.replace(/\s+/g, " ")})`);
  for (const file of ["lib/provider-routing-policy.ts", "lib/provider-routing-status.ts", "lib/worker-provider.ts", "lib/worker.ts", "run-task.ts"]) {
    assert.ok(calls.some((call) => call.file === file), `a caller in src/${file}`);
  }
  // run-task.ts is never imported by a test (the reach ratchet): its draft rescue is read as source.
  const runTask = readFileSync(join(srcRoot, "run-task.ts"), "utf8");
  const rescue = runTask.slice(runTask.indexOf("export async function spawnEscalatedInboxDraft("));
  assert.match(rescue.slice(0, rescue.indexOf("\n}\n")),
    /providerEligibility\(capacity, policy\.reservePercent, providerHeadroomTiming\(systemClock\.now\(\), args\.config\.root\)\)\.eligible/);
  // The codex reader keeps no flat-reserve test of its own beside providerEligibility's.
  assert.doesNotMatch(readFileSync(join(srcRoot, "lib", "worker-provider.ts"), "utf8"), />=\s*100 - reserve\b/);
});

test("W1-T14200 criterion 3: an unloadable policy falls back to the daemon's own default curve", () => {
  const timing = providerHeadroomTiming(NOW, REPO_ROOT, () => { throw new Error("policy.yaml is not valid YAML"); });
  assert.deepEqual(timing, { nowMs: NOW, policy: buildDefaultHeadroomPolicy() });
  // A root with no plan/policy.yaml (every tmp fixture root) takes the same default.
  assert.deepEqual(providerHeadroomTiming(NOW, tmpdir()), { nowMs: NOW, policy: buildDefaultHeadroomPolicy() });
});

// ── Criterion 4: outside the final rung, origin/main's judgement exactly ───────────────────────

test("W1-T14200 criterion 4: invariant:the-reserve-holds-outside-the-final-rung", () => {
  const beyond = [25, 30, 72, 167].map((hours) => NOW + hours * HOUR);
  const readings: ProviderCapacity[] = [];
  for (const used of [0, 50, 89.9, 90, 94, 94.99, 95, 96, 99, 100]) {
    for (const resetMs of beyond) {
      readings.push(claudeReading(new Date(resetMs).toISOString(), used));
      readings.push(codexReading(used, resetMs));
      readings.push(codexReading(used, resetMs, { credits: CREDITS }));
    }
    // A weekly line with no reset, and unreadable resets of both shapes.
    readings.push(claudeReading(undefined, used), claudeReading("Nov 23 at 9pm", used), claudeReading(new Date(NOW - HOUR).toISOString(), used));
    readings.push(codexReading(used, undefined, { credits: CREDITS }), codexReading(used, NOW - HOUR));
  }
  readings.push({ ...codexReading(97, NOW + 72 * HOUR, { credits: CREDITS }), readable: false, exhausted: true });
  readings.push({ provider: "claude", readable: false, windows: [] });
  let compared = 0;
  for (const reading of readings) {
    for (const reserve of [0, 3, 5, 10, 20, 50]) {
      assert.deepEqual(providerEligibility(reading, reserve, TIMING), providerEligibility(reading, reserve),
        `${JSON.stringify(reading.windows)} credits=${Boolean(reading.credits)} reserve=${reserve}`);
      compared++;
    }
  }
  assert.ok(compared >= 900, `compared ${compared} readings`);
  // W1-T10382's credits lane beyond the final rung is unchanged.
  assert.deepEqual(providerEligibility(codexReading(97, NOW + 72 * HOUR, { credits: CREDITS }), 5, TIMING),
    { eligible: true, lane: "codex-credits", headroomPercent: 3 });
  // The codex reader agrees: beyond the final rung it is exhausted with or without the curve.
  for (const used of [94, 95, 97]) {
    const rateLimits = codexRateLimits(used, NOW + 30 * HOUR);
    const timed = selectCodexModel([SPARK], rateLimits, CODEX_CONFIG, "haiku", "low", CAPABILITIES, { headroomTiming: TIMING });
    const flat = selectCodexModel([SPARK], rateLimits, CODEX_CONFIG, "haiku", "low", CAPABILITIES);
    assert.deepEqual(timed, flat, `codex ${used}% resetting in 30 h`);
  }
});
