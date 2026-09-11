import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Config, WorkerProviderId } from "../src/lib/config.js";
import {
  configForMountExploration,
  exploreMount,
  MOUNT_EXPLORATION_POLICY,
  mountExplorationLedgerFields,
  resolveMountExplorationDispatch,
  type MountExplorationDispatch,
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

// ── the explored arm has to reach the WORKER, or exploration samples nothing ──────────────────────
//
// `configForMountExploration` was imported by this suite and never called, so `diff-coverage` reported
// its declaration and body as added-and-uncovered. That is not a tidiness gap: this function is the
// ONLY thing that makes an explored arm actually run. `exploreMount` decides which arm to sample and
// `mountExplorationLedgerFields` records that it did — but if the spawn still goes out on the
// on-policy provider, every ledgered "exploration" measures the arm it was already using, and the
// bounded-fraction experiment silently compares a thing to itself. The tests below drive the real
// function on a real decision.

/** A real `explore` decision — the codex-arm case this suite already proves `exploreMount` produces. */
function exploreDecision() {
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
  assert.equal(decision.kind, "explore", "the fixture must yield an explore decision for these tests to mean anything");
  if (decision.kind !== "explore") throw new Error("unreachable");
  return decision;
}

/** `workerProviders` is optional on Config, so every assertion below reads it through this. */
const providers = (c: Config) => c.workerProviders ?? {};

test("W1-T3095: the explored arm REPLACES the enabled provider list, so the sampled arm is the one that runs", () => {
  const decision = exploreDecision();
  const base = {
    workerProviders: { enabled: ["claude", "codex"], reservePercent: 12, codexModel: "gpt-5.4" },
    root: "/preserved",
  } as unknown as Config;

  const explored = configForMountExploration(base, decision);

  // THE POINT: exactly the explored provider, not the union and not the on-policy one. A config that
  // still admitted "claude" would let the spawn pick it and the experiment would measure nothing.
  assert.deepEqual(providers(explored).enabled, [decision.exploredArm.provider]);
  assert.equal(decision.exploredArm.provider, "codex", "fixture sanity: this case explores the codex arm");

  // Everything else is carried through — this narrows the provider, it does not rebuild the config.
  assert.equal(explored.root, "/preserved");
  assert.equal(providers(explored).reservePercent, 12);
  // and the original is not mutated
  assert.deepEqual(providers(base).enabled, ["claude", "codex"]);
});

test("W1-T3095: a CODEX arm also pins the served model, or codex would serve whatever its default is", () => {
  const decision = exploreDecision();
  const explored = configForMountExploration(
    { workerProviders: { enabled: ["claude"], codexModel: "gpt-5.4" } } as unknown as Config,
    decision,
  );
  assert.equal(providers(explored).codexModel, decision.exploredArm.servedModel);
  assert.notEqual(
    providers(explored).codexModel,
    "gpt-5.4",
    "the pre-existing codexModel must be overridden, or the arm key and the served model disagree",
  );
});

test("W1-T3095 (control): a NON-codex arm leaves codexModel alone — the pin is conditional, not blanket", () => {
  // Same function, the other branch. Without this the codex assertion above would pass for an
  // implementation that pinned codexModel unconditionally, which would corrupt a claude-arm dispatch.
  const decision = exploreDecision();
  const claudeArm: MountExplorationDispatch = {
    ...decision,
    exploredArm: { ...decision.exploredArm, provider: "claude", servedModel: "claude-sonnet-5" },
  };
  const explored = configForMountExploration(
    { workerProviders: { enabled: ["claude", "codex"], codexModel: "gpt-5.4" } } as unknown as Config,
    claudeArm,
  );
  assert.deepEqual(providers(explored).enabled, ["claude"]);
  assert.equal(providers(explored).codexModel, "gpt-5.4", "a claude arm must not rewrite the codex model");
});

// ── the wiring arms nothing could reach ──────────────────────────────────────────────────────────
//
// These two arms were written inline in `runTask` and had ZERO covering tests. That is not an
// oversight to paper over with a harness: `runId` inside `runTask` is `${taskId}-${Date.now()}` and
// the sampler hashes it, so steering the real call onto the explore arm means steering the clock.
// Seaming the cell source and the mounts table is what makes both arms testable at all.

function wiringInput(over: Partial<Parameters<typeof resolveMountExplorationDispatch>[0]> = {}) {
  return {
    taskType: "implement",
    risk: "medium",
    taskClass: "src",
    currentMount,
    config: { workerProviders: { enabled: ["claude", "codex"] }, root: "/state-root" } as unknown as Config,
    // THE SAMPLER IS KEYED ON runId, and this path does NOT accept an explicit sampleUnit — that is
    // the whole reason the arm was unreachable. This id is a real `${taskId}-${Date.now()}` value
    // found by search: it hashes to sampleUnit 0.0452, inside the 0.05 fraction, for this cell's arm
    // pair. It is a FIXED string, so the test is deterministic; change the fixture's arms and it
    // reverts to a refusal, which the assertions below will say out loud rather than pass quietly.
    runId: "W1-T3095-1789117400019",
    taskId: "W1-T3095",
    enabledProviders: ["claude", "codex"] as WorkerProviderId[],
    ...over,
  };
}

/**
 * A `loadCells` that COUNTS rather than throws.
 *
 * The obvious way to assert "this source was never read" is a fake whose body throws — but that body
 * is then an added line no test ever enters, which `diff-coverage` flags, correctly: a never-executed
 * line is a never-verified line, even in a test. A shared counter reads zero just as loudly and the
 * body is exercised by the cases that DO read.
 */
function countingCells() {
  const state = { reads: 0 };
  return {
    state,
    loadCells: async () => {
      state.reads += 1;
      return cells();
    },
  };
}

test("W1-T3095: the EXPLORE arm redirects the spawn AND ledgers that it did — both, or the sample is unattributable", async () => {
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const onPolicy = wiringInput().currentMount;
  const out = await resolveMountExplorationDispatch(wiringInput(), {
    loadCells: async () => cells(),
    loadMountsTable: () => mounts(),
    log: (step, fields) => logged.push({ step, fields }),
  });

  // 1. THE SPAWN MOVES. Without this the rung logs an exploration that never happened.
  assert.deepEqual(out.config.workerProviders?.enabled, ["codex"], "the explored provider must be the only one enabled");
  assert.notDeepEqual(out.mount, onPolicy, "the explored mount must differ from the on-policy mount");

  // 2. THE LEDGER SAYS SO, on the same call. An unledgered exploration is an unattributable arm in
  //    the next sweep: the comparison would credit the on-policy arm with the explored arm's result.
  const row = logged.find((l) => l.step === "mount.exploration");
  assert.ok(row, `no mount.exploration row was logged; saw ${JSON.stringify(logged.map((l) => l.step))}`);
  assert.equal(row.fields.run_id, "W1-T3095-1789117400019");
  assert.equal(row.fields.explored_arm, "codex::gpt-5.5::high", "the row must name the arm that actually ran");
  assert.equal(logged.filter((l) => l.step === "mount.exploration.error").length, 0, "a clean explore must log no error");
});

test("W1-T3095: a REFUSAL leaves the on-policy mount and config EXACTLY as they were", async () => {
  const logged: string[] = [];
  const input = wiringInput({ risk: "high" }); // excluded by policy
  const sweep = countingCells();
  const out = await resolveMountExplorationDispatch(input, {
    loadCells: sweep.loadCells,
    loadMountsTable: () => mounts(),
    log: (step) => logged.push(step),
  });
  assert.equal(out.mount, input.currentMount, "a refusal must return the identical on-policy mount");
  assert.equal(out.config, input.config, "a refusal must return the identical config object, not a copy");
  assert.deepEqual(logged, [], "a refusal is the normal case and must not write a ledger row");
  assert.equal(sweep.state.reads, 0, "an excluded risk must not read the sweep at all");
});

test("W1-T3095: a FAULTING sweep NEVER takes the dispatch down — it degrades and says why", async () => {
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const input = wiringInput();
  const out = await resolveMountExplorationDispatch(input, {
    loadCells: async () => {
      throw new Error("state/ledger.ndjson: ENOENT");
    },
    loadMountsTable: () => mounts(),
    log: (step, fields) => logged.push({ step, fields }),
  });
  // THE WHOLE POINT: exploration is a measurement rung. A rung that can fail a real dispatch is
  // worse than no rung, so this resolves rather than rejects…
  assert.equal(out.mount, input.currentMount);
  assert.equal(out.config, input.config);
  // …but it is NOT silent. A swallowed fault would read as "exploration is just never eligible",
  // which is indistinguishable from the rung working correctly and sampling nothing.
  assert.deepEqual(logged.map((l) => l.step), ["mount.exploration.error"]);
  assert.match(String(logged[0].fields.reason), /ENOENT/, "the ledgered reason must carry the real fault");
});

test("W1-T3095: a faulting MOUNTS TABLE degrades the same way — the catch covers the whole rung", async () => {
  // The second data source. A catch that only covered the sweep would let a mounts parse error
  // propagate out of runTask, which is the failure mode this arm exists to prevent.
  const logged: string[] = [];
  const input = wiringInput();
  const out = await resolveMountExplorationDispatch(input, {
    loadCells: async () => cells(),
    loadMountsTable: () => {
      throw new Error("mounts.yaml: unexpected token");
    },
    log: (step) => logged.push(step),
  });
  assert.equal(out.mount, input.currentMount);
  assert.deepEqual(logged, ["mount.exploration.error"]);
});

test("W1-T3095: an EXCLUDED risk short-circuits the sweep read, because that read costs a dynamic import", async () => {
  // Asserted by counting reads, not by timing. The real `loadCells` imports a script off disk and
  // builds the whole headroom sweep; doing that for a task policy has already excluded is pure waste.
  // ONE counter across BOTH calls, so the zero and the one are the same instrument reading twice.
  const sweep = countingCells();
  const deps = { loadCells: sweep.loadCells, loadMountsTable: () => mounts(), log: () => {} };

  await resolveMountExplorationDispatch(wiringInput({ risk: "high" }), deps);
  assert.equal(sweep.state.reads, 0, "a high-risk task must not read the sweep at all");

  // CONTROL: the same counter, the same fake, an eligible risk — it reads. Without this the zero
  // above would also be satisfied by a counter that can never increment.
  await resolveMountExplorationDispatch(wiringInput({ risk: "medium" }), deps);
  assert.equal(sweep.state.reads, 1, "an eligible risk must read the sweep");
});

test("W1-T3095: run-task wires the seam and keeps NO exploration branch of its own", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(src, /resolveMountExplorationDispatch\(/, "runTask must call the seamed resolver");
  // The arms must not be duplicated back into runTask, where nothing can reach them again.
  assert.doesNotMatch(src, /exploration\.kind === "explore"/, "the explore branch belongs in lib, not in runTask");
  assert.doesNotMatch(src, /mount\.exploration\.error/, "the failure arm belongs in lib, not in runTask");
  // and the real data sources stay wired there, since only runTask knows repoRoot.
  assert.match(src, /mount-headroom-sweep\.mjs/);
  assert.match(src, /loadMountsTable: \(\) => loadMounts\(mountsPath\(repoRoot\)\)/);
});
