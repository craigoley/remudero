import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import {
  configForMountExploration,
  exploreMount,
  MOUNT_EXPLORATION_POLICY,
  mountExplorationLedgerFields,
} from "../src/lib/mount-exploration.js";
import type { Mount, Mounts } from "../src/lib/mounts.js";
import type { MountHeadroomCell } from "../src/lib/mount-recommender.js";

function mounts(): Mounts {
  const sonnetHigh = { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 160000 };
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3, "claude-sonnet-5": 2, "claude-haiku-4-5-20251001": 1 },
    efforts: { low: 1, medium: 2, high: 3 },
    capabilities: {
      ladder: { economy: 1, balanced: 2, frontier: 3 },
      claude: {
        haiku: "economy",
        sonnet: "balanced",
        opus: "frontier",
        "claude-sonnet-5": "balanced",
        "claude-haiku-4-5-20251001": "economy",
      },
      claudeCandidates: {
        economy: ["claude-haiku-4-5-20251001"],
        balanced: ["claude-sonnet-5"],
        frontier: ["opus"],
      },
      codex: {
        economy: { low: ["gpt-5.3-codex-spark"], medium: ["gpt-5.6-luna"], high: ["gpt-5.3-codex-spark"] },
        balanced: { low: ["gpt-5.4"], medium: ["gpt-5.6-terra"], high: ["gpt-5.5"] },
        frontier: { low: ["gpt-5.5"], medium: ["gpt-5.6-sol"], high: ["gpt-5.6-sol"] },
      },
    },
    architect: { model: "opus", effort: "high", maxTurns: 400, contextBudget: 180000 },
    judge: { model: "opus", effort: "high", maxTurns: 400, contextBudget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", maxTurns: 400, contextBudget: 180000 },
      triage: { model: "sonnet", effort: "low", maxTurns: 400, contextBudget: 180000 },
      inbox_draft: { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 180000 },
    },
    routes: {
      implement: {
        medium: { src: sonnetHigh },
        high: { src: { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 200000 } },
      },
    },
  };
}

function arm(cellKey: string, provider: string, servedModel: string, effort: string, n: number) {
  return {
    cellKey,
    armKey: `${provider}::${servedModel}::${effort}`,
    provider,
    servedModel,
    effort,
    n,
    outcomes: { passing: n, blockedCi: 0, redispatched: 0 },
    costP50: 1,
    costP90: 2,
    costMax: 3,
    costPerCompletedTaskUsd: 1,
  };
}

function cells(): MountHeadroomCell[] {
  return [
    {
      cellKey: "implement::medium::src",
      type: "implement",
      risk: "medium",
      taskClass: "src",
      arms: [
        arm("implement::medium::src", "claude", "claude-sonnet-5", "high", 200),
        arm("implement::medium::src", "codex", "gpt-5.5", "high", 25),
      ],
      comparisons: [],
    },
    {
      cellKey: "implement::low::src",
      type: "implement",
      risk: "low",
      taskClass: "src",
      arms: [arm("implement::low::src", "codex", "gpt-5.3-codex-spark", "low", 999)],
      comparisons: [],
    },
  ];
}

const currentMount: Mount = { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 160000 };

// ── the refusal arms: criterion 2 says a refusal must NAME which exclusion applied ─────────────
//
// The suite covered the two exclusions an operator sets deliberately (risk:high, architect/judge
// lanes). These are the four that fire on the SHAPE of the data — an operator-set policy that
// cannot be sampled, a cell whose arms no longer include the mount actually in use, and a runner-up
// that cannot be expressed as spawn knobs. Each refusal is the difference between "we chose not to
// explore" and "we silently explored nothing", so each has to name itself.

function baseInput(over: Record<string, unknown> = {}) {
  return {
    cells: cells(),
    mounts: mounts(),
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    runId: "run-refusals",
    enabledProviders: ["claude", "codex"] as const,
    ...over,
  };
}

test("a policy fraction outside (0, 1] is REFUSED as invalid-policy rather than sampled", () => {
  for (const fraction of [0, 1.5]) {
    const decision = exploreMount(
      baseInput({ policy: { ...MOUNT_EXPLORATION_POLICY, fraction }, sampleUnit: 0 }) as never,
    );
    assert.equal(decision.kind, "refusal");
    assert.equal(decision.kind === "refusal" ? decision.reason : "", "invalid-policy");
    assert.match(decision.kind === "refusal" ? decision.detail : "", /must be > 0 and <= 1/);
  }
  // CONTROL: the shipped fraction is inside the range and the same input explores.
  assert.equal(exploreMount(baseInput({ sampleUnit: 0 }) as never).kind, "explore");
});

test("a cell with no arm matching the mount in use is REFUSED as on-policy-arm-missing", () => {
  const decision = exploreMount(
    baseInput({ currentMount: { ...currentMount, model: "opus" }, sampleUnit: 0 }) as never,
  );
  assert.equal(decision.kind, "refusal");
  assert.equal(decision.kind === "refusal" ? decision.reason : "", "on-policy-arm-missing");
  assert.match(decision.kind === "refusal" ? decision.detail : "", /implement::medium::src/, "the refusal names the cell");
});

test("a runner-up that cannot be expressed as spawn knobs is REFUSED as runner-up-unavailable", () => {
  // Two enabled arms, so the arms-count guard passes; the on-policy arm matches; the only other arm
  // names a model the tier table does not carry, so expressArm cannot turn it into a spawn.
  const unexpressible = [
    {
      cellKey: "implement::medium::src",
      type: "implement",
      risk: "medium",
      taskClass: "src",
      arms: [
        arm("implement::medium::src", "claude", "claude-sonnet-5", "high", 200),
        arm("implement::medium::src", "claude", "model-not-in-the-tier-table", "high", 25),
      ],
      comparisons: [],
    },
  ];
  const decision = exploreMount(baseInput({ cells: unexpressible, sampleUnit: 0 }) as never);
  assert.equal(decision.kind, "refusal");
  assert.equal(decision.kind === "refusal" ? decision.reason : "", "runner-up-unavailable");
  assert.match(decision.kind === "refusal" ? decision.detail : "", /implement::medium::src/);
});

test("with no sampleUnit supplied the decision is derived from the run's own identity, deterministically", () => {
  // Every other test pins sampleUnit; nothing exercised the derivation, which is what decides
  // whether a real dispatch explores at all.
  const first = exploreMount(baseInput({ runId: "run-A", taskId: "W1-T1" }) as never);
  const again = exploreMount(baseInput({ runId: "run-A", taskId: "W1-T1" }) as never);
  assert.deepEqual(first, again, "the same run must always reach the same decision");
  assert.ok(first.kind === "explore" || first.kind === "refusal");
});

test("an eligible cell explores only inside the declared bounded fraction and names the runner-up arm in that same cell", () => {
  const decision = exploreMount({
    cells: cells(),
    mounts: mounts(),
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    runId: "run-explores",
    taskId: "W1-T3095",
    enabledProviders: ["claude", "codex"],
    sampleUnit: MOUNT_EXPLORATION_POLICY.fraction / 2,
  });

  assert.equal(MOUNT_EXPLORATION_POLICY.kind, "bounded-fraction");
  assert.equal(decision.kind, "explore");
  if (decision.kind !== "explore") return;
  assert.equal(decision.policy, MOUNT_EXPLORATION_POLICY);
  assert.equal(decision.cellKey, "implement::medium::src");
  assert.equal(decision.onPolicyArm.armKey, "claude::claude-sonnet-5::high");
  assert.equal(decision.exploredArm.armKey, "codex::gpt-5.5::high");
  assert.equal(decision.mount.model, "claude-sonnet-5");
  assert.equal(decision.mount.effort, "high");
  assert.deepEqual(decision.codexModelPreference, { capability: "balanced", effort: "high", model: "gpt-5.5" });

  const outside = exploreMount({
    cells: cells(),
    mounts: mounts(),
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    runId: "run-skips",
    taskId: "W1-T3095",
    enabledProviders: ["claude", "codex"],
    sampleUnit: MOUNT_EXPLORATION_POLICY.fraction,
  });
  assert.equal(outside.kind, "refusal");
  assert.equal(outside.reason, "outside-fraction");
});

test("risk:high and the Architect/judge lanes are excluded with the applied exclusion named", () => {
  const high = exploreMount({
    cells: [],
    mounts: mounts(),
    taskType: "implement",
    risk: "high",
    taskClass: "src",
    currentMount,
    runId: "run-high",
    enabledProviders: ["claude", "codex"],
    sampleUnit: 0,
  });
  assert.equal(high.kind, "refusal");
  assert.equal(high.reason, "excluded-risk");
  assert.equal(high.exclusion, "risk");
  assert.match(high.detail, /risk:high/);

  for (const taskType of ["architect", "judge"]) {
    const lane = exploreMount({
      cells: [],
      mounts: mounts(),
      taskType,
      risk: "medium",
      taskClass: "src",
      currentMount,
      runId: `run-${taskType}`,
      enabledProviders: ["claude", "codex"],
      sampleUnit: 0,
    });
    assert.equal(lane.kind, "refusal");
    assert.equal(lane.reason, "excluded-lane");
    assert.equal(lane.exclusion, "lane");
    assert.match(lane.detail, new RegExp(taskType));
  }
});

test("an exploration dispatch carries ledger fields that distinguish it from a routing decision", () => {
  const decision = exploreMount({
    cells: cells(),
    mounts: mounts(),
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    runId: "run-ledger",
    taskId: "W1-T3095",
    enabledProviders: ["claude", "codex"],
    sampleUnit: 0,
  });
  assert.equal(decision.kind, "explore");
  if (decision.kind !== "explore") return;

  assert.deepEqual(mountExplorationLedgerFields(decision), {
    cell: "implement::medium::src",
    task_type: "implement",
    risk: "medium",
    task_class: "src",
    on_policy_arm: "claude::claude-sonnet-5::high",
    explored_arm: "codex::gpt-5.5::high",
    on_policy: { provider: "claude", served_model: "claude-sonnet-5", effort: "high", n: 200 },
    explored: { provider: "codex", served_model: "gpt-5.5", effort: "high", n: 25 },
    sample_unit: 0,
    reason: "bounded-fraction-runner-up",
    policy: MOUNT_EXPLORATION_POLICY,
  });
});

test("exploration returns a per-dispatch perturbation without mutating mounts or config", () => {
  const table = mounts();
  const beforeTable = structuredClone(table);
  const cellInput = cells();
  const beforeCells = structuredClone(cellInput);
  const config: Config = {
    claudeBin: "/bin/claude",
    root: "/repo",
    workerProviders: { enabled: ["claude", "codex"], reservePercent: 5, codexHome: "/codex-home" },
  };
  const beforeConfig = structuredClone(config);

  const decision = exploreMount({
    cells: cellInput,
    mounts: table,
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    runId: "run-pure",
    enabledProviders: ["claude", "codex"],
    sampleUnit: 0,
  });
  assert.equal(decision.kind, "explore");
  if (decision.kind !== "explore") return;

  const patched = configForMountExploration(config, decision);
  assert.deepEqual(table, beforeTable);
  assert.deepEqual(cellInput, beforeCells);
  assert.deepEqual(config, beforeConfig);
  assert.notEqual(patched, config);
  assert.deepEqual(patched.workerProviders, {
    enabled: ["codex"],
    reservePercent: 5,
    codexHome: "/codex-home",
    codexModel: "gpt-5.5",
  });
});
