import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import {
  ROUTING_DRAW_METHOD,
  routingDrawValue,
  selectWorkerProvider,
  selectionPropensity,
  spawnDecisionPoint,
  type ProviderCapacity,
  type RoutingDrawSeed,
} from "../src/lib/worker-provider.js";
import { selectWorkerProviderForPolicy, type EffectiveProviderRoutingPolicy } from "../src/lib/provider-routing-policy.js";
import {
  evaluateRoutingExperiment,
  experimentArmForTask,
  experimentDrawSeed,
  experimentIntentionToTreat,
  ROUTING_EXPERIMENTS,
} from "../src/lib/routing-experiments.js";
import {
  auctionDrawSeed,
  createClaudeExecutableCache,
  spawnWorker,
  workerSelectionAssignment,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// W1-T4617: every routed assignment records each candidate's selection probability, the draw and
// its seed, and an experiment keeps ONE arm per task across retries and fix rungs.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const SOL_VS_SONNET = ROUTING_EXPERIMENTS.find((experiment) => experiment.id === "sol-vs-sonnet")!;
const AUTOMATIC = { preference: "automatic" as const, reservePercent: 5, provenance: "default" as const };

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

function spawnKey(index: number): RoutingDrawSeed {
  return { unit: "spawn", taskId: `W1-T${index}`, attempt: `run-W1-T${index}-1`, point: "spawn:00000000" };
}

/** The share each provider takes over a fixed list of seeds: deterministic, so the tolerance never flakes. */
function empiricalShare(capacities: ProviderCapacity[], seeds: RoutingDrawSeed[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const seed of seeds) {
    const provider = selectWorkerProvider(capacities, 5, seed).provider;
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([provider, count]) => [provider, count / seeds.length]));
}

test("distribution: over many seeds each provider's share matches its normalised weight", () => {
  const seeds = Array.from({ length: 4000 }, (_, index) => spawnKey(index));
  const cases: Array<[ProviderCapacity[], number]> = [
    // (60 - 5)^2 = 3025 against (30 - 5)^2 = 625: Claude's normalised weight is 3025 / 3650.
    [[capacity("claude", 40), capacity("codex", 70)], 3025 / 3650],
    // A tie used to alternate by counter; the same weights now split it by the draw.
    [[capacity("claude", 50), capacity("codex", 50)], 0.5],
    // Headroom order reversed: the draw follows the weights, not the listing order.
    [[capacity("claude", 70), capacity("codex", 40)], 625 / 3650],
  ];
  for (const [capacities, claudeWeight] of cases) {
    const share = empiricalShare(capacities, seeds);
    assert.ok(Math.abs((share.claude ?? 0) - claudeWeight) < 0.02, `claude share ${share.claude} vs weight ${claudeWeight}`);
    assert.ok(Math.abs((share.codex ?? 0) - (1 - claudeWeight)) < 0.02, `codex share ${share.codex} vs weight ${1 - claudeWeight}`);
  }
  // An experiment's fixed walk order moves no probability either.
  const ordered = seeds.map((seed) => ({ ...seed, order: ["codex", "claude"] as const }));
  const share = empiricalShare([capacity("claude", 40), capacity("codex", 70)], ordered);
  assert.ok(Math.abs((share.claude ?? 0) - 3025 / 3650) < 0.02, `ordered walk claude share ${share.claude}`);
  // A drawn value outside [0, 1) is clamped, never read as an index.
  assert.equal(selectWorkerProvider([capacity("claude", 40), capacity("codex", 70)], 5, 7).provider, "codex");
  assert.equal(selectWorkerProvider([capacity("claude", 40), capacity("codex", 70)], 5, Number.NaN).provider, "claude");
});

test("determinism: the same task, attempt and decision point give the same draw, whatever the clock says", () => {
  const key = { unit: "spawn" as const, taskId: "W1-T4617", attempt: "run-W1-T4617-1790549053521", point: "spawn:1a2b3c4d" };
  const timers = mock.timers;
  timers.enable({ apis: ["Date"], now: NOW });
  const atNoon = routingDrawValue(key);
  timers.setTime(NOW + 11 * 3_600_000);
  const atNight = routingDrawValue(key);
  timers.reset();
  assert.deepEqual(atNoon, atNight, "the draw reads no clock");
  assert.match(atNoon.seed, /^[0-9a-f]{8}$/);
  assert.ok(atNoon.value >= 0 && atNoon.value < 1);
  assert.notEqual(routingDrawValue({ ...key, attempt: "run-W1-T4617-2" }).value, atNoon.value, "a new attempt draws anew");
  assert.notEqual(routingDrawValue({ ...key, point: "spawn:ffffffff" }).value, atNoon.value, "a new decision point draws anew");
  const capacities = [capacity("claude", 45), capacity("codex", 40)];
  const first = selectWorkerProvider(capacities, 5, key);
  const again = selectWorkerProvider(capacities, 5, key);
  assert.equal(first.provider, again.provider);
  assert.deepEqual(first.draw, again.draw);
  assert.equal(first.draw?.method, ROUTING_DRAW_METHOD);
  assert.deepEqual(first.draw?.key, key);
  // The decision point is a digest of what the spawn asks for: a fix rung's prompt is a new point.
  const point = spawnDecisionPoint({ model: "sonnet", effort: "high", prompt: "implement" });
  assert.equal(point, spawnDecisionPoint({ model: "sonnet", effort: "high", prompt: "implement" }));
  assert.notEqual(point, spawnDecisionPoint({ model: "sonnet", effort: "high", prompt: "fix rung 1" }));
  assert.match(point, /^spawn:[0-9a-f]{8}$/);
});

function record(input: Partial<Parameters<typeof workerSelectionAssignment>[1]>, args: Partial<SpawnWorkerArgs> = {}) {
  return workerSelectionAssignment({ cwd: "/w", prompt: "p", ...args } as SpawnWorkerArgs, {
    provider: "claude",
    model: "claude-sonnet-5",
    effort: "high",
    mode: "multi-provider",
    selectionPath: "auction",
    policy: AUTOMATIC,
    ...input,
  });
}

test("probability row: the recorded probabilities sum to 1 over eligible candidates", () => {
  const capacities = [capacity("claude", 40), capacity("codex", 70), capacity("codex", 97)];
  const selection = selectWorkerProvider(capacities.slice(0, 2), 5, spawnKey(1));
  const row = record({ provider: selection.provider, capacity: selection.capacity, capacities: capacities.slice(0, 2), selection });
  const propensity = row.routing.propensity!;
  assert.equal(propensity.method, ROUTING_DRAW_METHOD);
  const total = propensity.candidates.reduce((sum, entry) => sum + (entry.probability as number), 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `probabilities sum to ${total}`);
  const claude = propensity.candidates.find((entry) => entry.provider === "claude")!;
  assert.ok(Math.abs((claude.probability as number) - 3025 / 3650) < 1e-12);
  assert.equal(propensity.selectedProbability, propensity.candidates.find((entry) => entry.provider === selection.provider)!.probability);
  assert.equal(propensity.draw?.value, selection.draw?.value);
  assert.equal(propensity.draw?.seed, selection.draw?.seed);
  assert.deepEqual(propensity.draw?.key, spawnKey(1));

  // A candidate below the reserve could not be drawn: its probability is a known 0, the rest still sum to 1.
  const blocked = [capacity("claude", 40), capacity("codex", 97)];
  const single = selectWorkerProvider(blocked, 5, spawnKey(2));
  const singleRow = record({ provider: single.provider, capacity: single.capacity, capacities: blocked, selection: single });
  assert.deepEqual(singleRow.routing.propensity?.candidates, [
    { provider: "claude", probability: 1 },
    { provider: "codex", probability: 0 },
  ]);
  assert.equal(singleRow.routing.propensity?.selectedProbability, 1, "a single eligible candidate has probability 1");

  // No auction at all (a pinned mount, a Claude-only install): the one candidate is certain.
  const pinned = record({ provider: "codex", mode: "mount-affinity", selectionPath: "mount-affinity" });
  assert.deepEqual(pinned.routing.propensity, {
    method: "single-candidate",
    selectedProbability: 1,
    candidates: [{ provider: "codex", probability: 1 }],
  });
});

test("unavailable path: a probability that cannot be computed is named with a reason, never 0 and never omitted", () => {
  const capacities = [capacity("claude", 99), capacity("codex", 98)];
  const fallback = record(
    { provider: "cash", mode: "mount-affinity", selectionPath: "mount-affinity" },
    { routingFallback: { rule: "cash-fallback", capacities } },
  );
  assert.deepEqual(fallback.routing.propensity, {
    method: "unavailable",
    selectedProbability: "unavailable",
    candidates: [
      { provider: "claude", probability: "unavailable" },
      { provider: "codex", probability: "unavailable" },
      { provider: "cash", probability: "unavailable" },
    ],
    unavailableReason: "no-eligible-candidates",
  });

  const trial = record(
    { provider: "cash", mode: "mount-affinity", selectionPath: "mount-affinity" },
    { routingTrial: { id: "cash-simple", arm: "cash", reason: "cash arm by stable task hash" } },
  );
  assert.equal(trial.routing.propensity?.unavailableReason, "assigned-by-cash-trial");
  assert.equal(trial.routing.propensity?.selectedProbability, "unavailable");

  // A selection that carries no draw has no weight to normalise.
  const both = [capacity("claude", 40), capacity("codex", 70)];
  const bare = { provider: "claude" as const, capacity: both[0]!, tightestRemainingPercent: 60 };
  const missing = record({ capacity: both[0], capacities: both, selection: bare });
  assert.equal(missing.routing.propensity?.method, "unavailable");
  assert.equal(missing.routing.propensity?.unavailableReason, "missing-weight");
  assert.ok(missing.routing.propensity?.candidates.every((entry) => entry.probability === "unavailable"));

  // A draw that somehow omits the selected provider still refuses to invent its probability.
  const partial = selectionPropensity({
    selected: "codex",
    considered: ["claude"],
    selection: { draw: { method: ROUTING_DRAW_METHOD, value: 0.1, seed: "supplied", probabilities: [{ provider: "claude", probability: 1 }] } },
  });
  assert.equal(partial.selectedProbability, "unavailable");
});

function routingPolicy(): EffectiveProviderRoutingPolicy {
  return {
    provenance: "default",
    committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [], codexModelPreference: null },
    enabledProviders: ["claude", "codex"],
    routableProviders: ["claude", "codex"],
    preference: "automatic",
    reservePercent: 5,
    parks: [],
  };
}

test("stable arm: an experiment task keeps one arm across retries and fix rungs", () => {
  const capacities = [capacity("claude", 40, "claude-sonnet-5"), capacity("codex", 40, "gpt-6-sol")];
  const armsPerTask = new Map<string, Set<string>>();
  const servedPerTask = new Map<string, Set<string>>();
  for (let index = 0; index < 40; index += 1) {
    const taskId = `W1-T${9000 + index}`;
    const spawns = [
      { runId: `run-${taskId}-1`, prompt: "implement" },
      { runId: `run-${taskId}-2`, prompt: "implement" },
      { runId: `run-${taskId}-2`, prompt: "fix rung 1: address the review" },
      { runId: `run-${taskId}-3`, prompt: "fix rung 2: address the review" },
    ];
    for (const spawn of spawns) {
      const args = { taskId, model: "sonnet", effort: "high", ...spawn };
      const seed = auctionDrawSeed(args, AUTOMATIC, capacities, "balanced");
      assert.equal(seed.unit, "task", "an experiment auction keys its draw on the task");
      const selection = selectWorkerProviderForPolicy(capacities, routingPolicy(), seed).selection;
      const row = record(
        { provider: selection.provider, model: selection.capacity.model ?? "claude-sonnet-5", capacity: selection.capacity, capacities, selection, capability: "balanced" },
        { ...args, cwd: "/w" },
      );
      assert.equal(row.routing.decision?.ab, "sol-vs-sonnet");
      armsPerTask.set(taskId, (armsPerTask.get(taskId) ?? new Set()).add(row.routing.experiment!.assignedArm));
      servedPerTask.set(taskId, (servedPerTask.get(taskId) ?? new Set()).add(row.routing.experiment!.servedArm));
    }
  }
  assert.ok([...armsPerTask.values()].every((arms) => arms.size === 1), "no task is re-randomised into a second arm");
  assert.ok([...servedPerTask.values()].every((arms) => arms.size === 1), "unchanged weights serve every attempt the same arm");
  const assigned = [...armsPerTask.values()].map((arms) => [...arms][0]);
  assert.ok(assigned.includes("sonnet") && assigned.includes("sol"), "the task-keyed draw still splits tasks across both arms");

  // Outside an experiment the draw stays keyed on the spawn, so a retry is a fresh draw.
  const plain = auctionDrawSeed({ taskId: "W1-T1", runId: "run-W1-T1-1", model: "haiku", effort: "low", prompt: "p" }, AUTOMATIC, capacities, "economy");
  assert.equal(plain.unit, "spawn");
  assert.equal(plain.attempt, "run-W1-T1-1");
  const anonymous = auctionDrawSeed({ prompt: "p" }, AUTOMATIC, capacities, "balanced");
  assert.deepEqual([anonymous.unit, anonymous.taskId, anonymous.attempt], ["spawn", "no-task", "no-run"]);
  const preferred = auctionDrawSeed({ taskId: "W1-T1", effort: "high", prompt: "p" }, { ...AUTOMATIC, preference: "claude" }, capacities, "balanced");
  assert.equal(preferred.unit, "spawn", "an operator preference, not the draw, picks the arm");
  assert.deepEqual(experimentDrawSeed(SOL_VS_SONNET, "W1-T1").order, ["claude", "codex"]);
});

test("crossover: a decision serving another arm than the task was assigned is recorded as one", () => {
  const taskId = Array.from({ length: 200 }, (_, index) => `W1-T${7000 + index}`)
    .find((candidate) => experimentArmForTask(SOL_VS_SONNET, candidate).arm === "sonnet")!;
  assert.ok(taskId, "some task is assigned the sonnet arm");
  const assigned = experimentArmForTask(SOL_VS_SONNET, taskId);
  assert.deepEqual(assigned, { arm: "sonnet", probability: 0.5 });
  assert.deepEqual(experimentIntentionToTreat("sol-vs-sonnet", taskId, "codex"), {
    id: "sol-vs-sonnet",
    unit: "task",
    assignedArm: "sonnet",
    assignedProbability: 0.5,
    servedArm: "sol",
    crossover: true,
  });
  assert.equal(experimentIntentionToTreat("sol-vs-sonnet", taskId, "claude")?.crossover, false);
  assert.equal(experimentIntentionToTreat("no-such-experiment", taskId, "claude"), undefined);

  const codex = capacity("codex", 40, "gpt-6-sol");
  const row = record(
    { provider: "codex", model: "gpt-6-sol", capacity: codex, capacities: [capacity("claude", 40, "claude-sonnet-5"), codex], capability: "balanced" },
    { taskId, model: "sonnet", effort: "high" },
  );
  assert.equal(row.routing.experiment?.crossover, true);
  assert.equal(row.routing.experiment?.assignedArm, "sonnet");
  assert.equal(record({}, { taskId }).routing.experiment, undefined, "an untagged decision carries no intention to treat");

  // The evaluator counts the task under its ASSIGNED arm and reports the crossover.
  const rows = [
    { ts: "2026-09-27T01:00:00Z", task_id: taskId, step: "worker.assignment", worker_assignment: row },
    { ts: "2026-09-27T02:00:00Z", task_id: taskId, step: "verdict.merged" },
  ];
  const report = evaluateRoutingExperiment(rows, SOL_VS_SONNET, "2026-09-28");
  assert.equal(report.crossoverTasks, 1);
  assert.equal(report.mixedTasks, 0);
  assert.equal(report.arms.find((arm) => arm.arm === "sonnet")?.tasks, 1, "intention to treat: counted under the assigned arm");
  assert.equal(report.arms.find((arm) => arm.arm === "sol")?.tasks, 0);
});

// ── Through the real spawn path ─────────────────────────────────────────────────────────────────

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

async function spawnExperiment(root: string, taskId: string, runId: string, prompt: string): Promise<WorkerSelectionAssignment> {
  const assignments: WorkerSelectionAssignment[] = [];
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt,
    model: "sonnet",
    effort: "high",
    taskId,
    runId,
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => capacity("claude", 40),
      readCodex: async (_config, request) => capacity("codex", 40, request.selectedModel ?? "gpt-6-sol"),
      spawnCodex: async () => codexResult(),
      writeStatus: () => undefined,
      now: () => NOW,
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
  assert.equal(assignments.length, 1);
  return assignments[0]!;
}

test("stable arm through the real spawn: a retry and a fix rung of one task reuse its task-keyed draw", async () => {
  const root = fixtureRoot("rmd-routing-propensity-");
  try {
    for (const taskId of ["W1-T9100", "W1-T9101", "W1-T9102", "W1-T9103"]) {
      const rows = [
        await spawnExperiment(root, taskId, `run-${taskId}-1`, "implement"),
        await spawnExperiment(root, taskId, `run-${taskId}-2`, "implement"),
        await spawnExperiment(root, taskId, `run-${taskId}-2`, "fix rung 1"),
      ];
      for (const row of rows) {
        assert.equal(row.routing.decision?.ab, "sol-vs-sonnet55");
        assert.equal(row.routing.propensity?.draw?.key?.unit, "task");
        assert.equal(row.routing.propensity?.selectedProbability, 0.5, "equal headroom, equal weights");
      }
      assert.equal(new Set(rows.map((row) => row.routing.propensity?.draw?.value)).size, 1, `${taskId} drew once`);
      assert.equal(new Set(rows.map((row) => row.selected.provider)).size, 1, `${taskId} served one provider`);
      assert.equal(new Set(rows.map((row) => row.routing.experiment?.assignedArm)).size, 1, `${taskId} kept one arm`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
