import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadMounts, MountsError, mountsPath } from "#src/lib/mounts.js";
import { policyForCapability, writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import { evaluateRoutingExperiment, experimentArmForTask, ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12172. DECIDED by the operator on 2026-11-10: a review goes to Sonnet first and the balanced Codex model is
// the backup. The reviewer shares the balanced capability with builds and fixes, so the preference is keyed by
// worker role. Every routing test below runs the real spawnWorker; only the capacity reads and the provider
// calls are stubbed.

const NOW = Date.parse("2026-11-10T19:00:00.000Z");
const ROLE_ROW = "  role_preference:\n    reviewer: claude\n";
const EXPERIMENT = ROUTING_EXPERIMENTS.find((experiment) => experiment.id === "sol61-vs-sonnet55")!;
const COMMITTED = readFileSync(mountsPath(REPO_ROOT), "utf8");

type Role = "reviewer" | "implementer" | "fixer";

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} primary`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high", accountLabel: "assigned-subscription" } : {}),
  };
}

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

/** A worker's own checkout names its mounts file first, so a fixture can run the router without the new key. */
function writeMounts(root: string, raw: string): void {
  mkdirSync(dirname(mountsPath(root)), { recursive: true });
  writeFileSync(mountsPath(root), raw);
}

function codexResult(): WorkerResult {
  return {
    provider: "codex",
    sessionId: "codex-session",
    costUsd: 0,
    numTurns: 1,
    text: "done",
    blocks: ["done"],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "gpt-6.1-sol",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    compactionConfigured: false,
    compactionFailures: [],
    qualitySuspect: false,
    servedModel: null,
    servedModelReason: "Codex JSONL reports no served model",
  };
}

interface Run {
  role: Role;
  taskId: string;
  claude?: ProviderCapacity;
  claudeUsed?: number;
  codexUsed?: number;
  excludeProviders?: SpawnWorkerArgs["excludeProviders"];
}

function config(root: string) {
  return {
    claudeBin: "/unused",
    root,
    workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
  } as NonNullable<SpawnWorkerArgs["config"]>;
}

/** Route one spawn the way its lane does: the reviewer is the spawn in the disposable review sandbox. */
async function route(root: string, run: Run): Promise<WorkerSelectionAssignment> {
  const assignments: WorkerSelectionAssignment[] = [];
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: `${run.role} work`,
    model: "sonnet",
    effort: "high",
    taskId: run.taskId,
    runId: `run-${run.taskId}`,
    ...(run.role === "reviewer" ? { tools: ["Read", "Grep", "Glob"], sandboxIntent: "disposable-review" as const } : {}),
    ...(run.role === "fixer" ? { workerClass: "fix" as const } : {}),
    ...(run.excludeProviders ? { excludeProviders: run.excludeProviders } : {}),
    config: config(root),
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => run.claude ?? capacity("claude", run.claudeUsed ?? 40),
      readCodex: async (_config, request) => capacity("codex", run.codexUsed ?? 40, request.selectedModel ?? "gpt-6.1-sol"),
      spawnCodex: async () => codexResult(),
      now: () => NOW,
    },
    onSelectionAssignment: (assignment) => assignments.push(assignment),
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: {
        env: { RMD_CLAUDE_BIN: "/fake/claude" },
        home: root,
        exists: () => true,
        which: () => "/fake/claude",
        canExecute: () => true,
        locations: [],
      },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
    })()) as never,
  });
  const assignment = assignments.at(-1);
  assert.ok(assignment, "every spawn records its assignment before the provider call");
  assert.equal(result.provider, assignment.selected.provider, "the worker ran on the provider its row names");
  return assignment;
}

function tasks(count: number, from = 12_000): string[] {
  return Array.from({ length: count }, (_, index) => `W1-T${from + index}`);
}

/** The first task at or after `from` that the live experiment assigns to `arm`. */
function taskInArm(arm: string, from: number): string {
  const found = tasks(200, from).find((taskId) => experimentArmForTask(EXPERIMENT, taskId).arm === arm);
  assert.ok(found, `no task near ${from} draws the ${arm} arm`);
  return found;
}

/** What a routing decision is: the provider, the rule, and the odds the row records. Row ids are random and left out. */
function decided(assignment: WorkerSelectionAssignment) {
  return {
    provider: assignment.selected.provider,
    model: assignment.selected.model,
    rule: assignment.routing.decision?.rule,
    ab: assignment.routing.decision?.ab,
    propensity: assignment.routing.propensity,
    experiment: assignment.routing.experiment,
    policy: assignment.routing.policy,
    preferenceBypass: assignment.routing.preferenceBypass,
    rolePreference: assignment.routing.rolePreference,
    capabilityPreference: assignment.routing.capabilityPreference,
  };
}

test("W1-T12172 criterion 1: the mounts file names a preferred provider for a worker role, and the committed file names Claude for the reviewer", () => {
  const committed = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.deepEqual(committed?.rolePreference, { reviewer: "claude" });
  assert.deepEqual(committed?.providerPreference, { frontier: "claude" }, "the capability preference is unchanged");
  assert.ok(COMMITTED.includes(ROLE_ROW));

  const root = mkdtempSync(join(tmpdir(), "rmd-role-preference-"));
  try {
    const load = (name: string, raw: string) => {
      writeFileSync(join(root, name), raw);
      return loadMounts(join(root, name));
    };
    assert.deepEqual(load("codex.yaml", COMMITTED.replace("    reviewer: claude\n", "    reviewer: codex\n")).capabilities?.rolePreference,
      { reviewer: "codex" });
    assert.throws(() => load("cash.yaml", COMMITTED.replace("    reviewer: claude\n", "    reviewer: cash\n")),
      /role_preference\.reviewer' must be "claude" or "codex"/);
    // A role the router cannot tell apart would be a preference that never applies, so the loader refuses it.
    assert.throws(() => load("unknown.yaml", COMMITTED.replace("    reviewer: claude\n", "    implementer: claude\n")), MountsError);
    assert.throws(() => load("proto.yaml", COMMITTED.replace("    reviewer: claude\n", "    constructor: claude\n")), MountsError);
    assert.throws(() => load("scalar.yaml", COMMITTED.replace(ROLE_ROW, "  role_preference: claude\n")),
      /must be a mapping of worker role -> provider/);
    assert.throws(() => load("list.yaml", COMMITTED.replace(ROLE_ROW, "  role_preference:\n    - claude\n")),
      /must be a mapping of worker role -> provider/);
    const absent = load("absent.yaml", COMMITTED.replace(ROLE_ROW, "")).capabilities;
    assert.equal(absent?.rolePreference, undefined, "an absent key declares no role preference");
    assert.deepEqual({ ...committed, rolePreference: undefined }, { ...absent, rolePreference: undefined },
      "the key changes nothing else the loader returns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12172 criterion 2: a reviewer goes to Claude whenever Claude is enabled, readable, above its reserve and not excluded", async () => {
  const root = fixtureRoot("rmd-review-claude-first-");
  try {
    // Codex has far more headroom (95% against 20%), so the headroom auction alone would give Codex most reviews.
    for (const taskId of tasks(10)) {
      const row = await route(root, { role: "reviewer", taskId, claudeUsed: 80, codexUsed: 5 });
      assert.equal(row.selected.provider, "claude", taskId);
      assert.equal(row.selected.model, "claude-sonnet-5-5", taskId);
      assert.equal(row.routing.decision?.rule, "role-preference", taskId);
      assert.deepEqual(row.routing.rolePreference, { role: "reviewer", provider: "claude" });
      assert.equal(row.routing.preferenceBypass, undefined);
      assert.equal(row.routing.policy.preference, "automatic", "the row keeps the operator's own policy");
    }
    // The same reviews without the key: the auction of today, which sends most of them to Codex.
    writeMounts(root, COMMITTED.replace(ROLE_ROW, ""));
    const before = await Promise.all(tasks(10).map((taskId) => route(root, { role: "reviewer", taskId, claudeUsed: 80, codexUsed: 5 })));
    assert.ok(before.filter((row) => row.selected.provider === "codex").length > 5, "without the key, headroom decides");
    for (const row of before) {
      assert.equal(row.routing.decision?.rule, "headroom-auction");
      assert.equal(row.routing.rolePreference, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12172 criterion 3: when Claude is not eligible the reviewer goes to Codex by the rules of today, and an exclusion still holds", async () => {
  const root = fixtureRoot("rmd-review-codex-backup-");
  try {
    const belowReserve = await route(root, { role: "reviewer", taskId: "W1-T12172", claudeUsed: 97, codexUsed: 40 });
    assert.equal(belowReserve.selected.provider, "codex");
    assert.equal(belowReserve.selected.model, "gpt-6.1-sol");
    assert.equal(belowReserve.routing.decision?.rule, "preference-bypassed", "the existing rule names the fallback");
    assert.deepEqual(belowReserve.routing.preferenceBypass, { provider: "claude", reason: "below-reserve" });
    assert.deepEqual(belowReserve.routing.rolePreference, { role: "reviewer", provider: "claude" },
      "the row says which preference was passed over");

    const unreadable = await route(root, {
      role: "reviewer", taskId: "W1-T12172", claude: { provider: "claude", readable: false, windows: [], detail: "usage read failed" },
    });
    assert.equal(unreadable.selected.provider, "codex");
    assert.equal(unreadable.routing.decision?.rule, "preference-bypassed");
    assert.deepEqual(unreadable.routing.preferenceBypass, { provider: "claude", reason: "unreadable" });

    // A review re-admitted after a Claude reviewer was unable excludes Claude. Claude has headroom and is still not chosen.
    for (const taskId of tasks(6)) {
      const excluded = await route(root, { role: "reviewer", taskId, claudeUsed: 10, codexUsed: 60, excludeProviders: ["claude"] });
      assert.equal(excluded.selected.provider, "codex", taskId);
      assert.deepEqual(excluded.routing.excludeProviders, ["claude"]);
      assert.equal(excluded.routing.exclusion_unhonoured, undefined, "Codex was an eligible alternative");
      assert.equal(excluded.routing.decision?.rule, "preference-bypassed");
    }
    // An exclusion of Codex leaves the preference in force.
    const codexExcluded = await route(root, { role: "reviewer", taskId: "W1-T12172", excludeProviders: ["codex"] });
    assert.equal(codexExcluded.selected.provider, "claude");
    assert.equal(codexExcluded.routing.decision?.rule, "role-preference");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12172 criterion 4: the assignment row still records the arm the live experiment drew, and that the role preference chose the provider", async () => {
  const root = fixtureRoot("rmd-review-experiment-");
  try {
    const sol = taskInArm("sol61", 12_172);
    const sonnet = taskInArm("sonnet", 12_172);
    const crossed = await route(root, { role: "reviewer", taskId: sol });
    assert.equal(crossed.selected.provider, "claude");
    assert.equal(crossed.routing.decision?.rule, "role-preference");
    assert.equal(crossed.routing.decision?.ab, "sol61-vs-sonnet55");
    assert.deepEqual(crossed.routing.experiment, {
      id: "sol61-vs-sonnet55", unit: "task", assignedArm: "sol61", assignedProbability: 0.5, servedArm: "sonnet", crossover: true,
    });
    const kept = await route(root, { role: "reviewer", taskId: sonnet });
    assert.equal(kept.routing.decision?.rule, "role-preference");
    assert.deepEqual(kept.routing.experiment, {
      id: "sol61-vs-sonnet55", unit: "task", assignedArm: "sonnet", assignedProbability: 0.5, servedArm: "sonnet", crossover: false,
    });
    // A re-admitted review that excludes Claude is served by Codex, and its row still names the arm the task drew.
    const excluded = await route(root, { role: "reviewer", taskId: sonnet, excludeProviders: ["claude"] });
    assert.equal(excluded.selected.provider, "codex");
    assert.equal(excluded.routing.experiment?.assignedArm, "sonnet");
    assert.equal(excluded.routing.experiment?.crossover, true);
    // Below its reserve Claude could not have been drawn, so the row joins no experiment: the rule of today.
    const blocked = await route(root, { role: "reviewer", taskId: sol, claudeUsed: 97 });
    assert.equal(blocked.routing.decision?.ab, undefined);
    assert.equal(blocked.routing.experiment, undefined);

    // The experiment's own reader counts each task under the arm it was assigned, and counts the crossover.
    const rows = [[sol, crossed], [sonnet, kept]].map(([taskId, assignment], index) => ({
      ts: `2026-11-10T19:0${index}:00Z`, task_id: taskId, step: "worker.assignment", worker_assignment: assignment,
    }));
    const report = evaluateRoutingExperiment(rows, EXPERIMENT, "2026-11-10");
    assert.equal(report.assignments, 2);
    assert.equal(report.crossoverTasks, 1);
    assert.deepEqual(report.arms.map((arm) => [arm.arm, arm.tasks]), [["sonnet", 1], ["sol61", 1]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12172 criterion 5: a worker in any other role is routed as today, with the same odds", async () => {
  const before = fixtureRoot("rmd-role-before-");
  const after = fixtureRoot("rmd-role-after-");
  try {
    writeMounts(before, COMMITTED.replace(ROLE_ROW, ""));
    writeMounts(after, COMMITTED);
    assert.equal(loadMounts(mountsPath(before)).capabilities?.rolePreference, undefined);
    assert.deepEqual(loadMounts(mountsPath(after)).capabilities?.rolePreference, { reviewer: "claude" });
    const served = new Set<string>();
    for (const role of ["implementer", "fixer"] as const) {
      for (const taskId of tasks(16)) {
        // Uneven headroom, so the odds are not one half and a moved share would show.
        const run = { role, taskId, claudeUsed: 55, codexUsed: 30 };
        const was = decided(await route(before, run));
        const is = decided(await route(after, run));
        assert.deepEqual(is, was, `${role} ${taskId}`);
        assert.equal(is.rule, "headroom-auction");
        assert.equal(is.rolePreference, undefined);
        assert.equal(is.ab, "sol61-vs-sonnet55", "builds and fixes stay in the experiment as drawn");
        assert.equal(is.propensity?.candidates.length, 2);
        const claudeOdds = is.propensity?.candidates.find((candidate) => candidate.provider === "claude")?.probability;
        assert.ok(typeof claudeOdds === "number" && claudeOdds > 0 && claudeOdds < 0.5, "Claude keeps its headroom share and no more");
        served.add(is.provider);
      }
    }
    assert.deepEqual([...served].sort(), ["claude", "codex"], "both providers still serve builds and fixes");
  } finally {
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
});

test("W1-T12172 criterion 5: an operator's own preference in the console is routed as today", async () => {
  const root = fixtureRoot("rmd-role-operator-");
  try {
    writeProviderRoutingPolicyOverride(root, {
      enabledProviders: ["claude", "codex"], preference: "codex", reservePercent: 5, parks: [],
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    }, { config: config(root), writerFingerprint: "unknown", now: () => NOW });
    const row = await route(root, { role: "reviewer", taskId: "W1-T12172", claudeUsed: 10, codexUsed: 60 });
    assert.equal(row.selected.provider, "codex", "the operator asked for Codex and Codex has headroom");
    assert.equal(row.routing.decision?.rule, "operator-preference");
    assert.equal(row.routing.policy.preference, "codex");
    assert.equal(row.routing.rolePreference, undefined);

    // The same rule, read at the function the router calls.
    const policy = {
      provenance: "default", enabledProviders: ["claude", "codex"], routableProviders: ["claude", "codex"],
      preference: "automatic", reservePercent: 5, parks: [],
    } as unknown as Parameters<typeof policyForCapability>[0];
    const reviewer = { role: "reviewer", preferences: { reviewer: "claude" as const } };
    assert.deepEqual(policyForCapability(policy, "balanced", { frontier: "claude" }, reviewer).rolePreference,
      { role: "reviewer", provider: "claude" });
    assert.equal(policyForCapability({ ...policy, preference: "codex" }, "balanced", { frontier: "claude" }, reviewer).policy.preference, "codex");
    assert.equal(policyForCapability({ ...policy, routableProviders: ["codex"] }, "balanced", undefined, reviewer).policy.preference,
      "automatic", "a parked or disabled provider is never preferred");
    const noRole = policyForCapability(policy, "frontier", { frontier: "claude" }, { role: undefined, preferences: reviewer.preferences });
    assert.deepEqual(noRole.capabilityPreference, { capability: "frontier", provider: "claude" }, "no role: the capability preference of today");
    assert.equal(noRole.rolePreference, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
