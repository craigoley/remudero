import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";
import { headroomPolicyFromCurve } from "#src/lib/headroom.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import {
  policyForCapability,
  writeProviderRoutingPolicyOverride,
  type EffectiveProviderRoutingPolicy,
} from "#src/lib/provider-routing-policy.js";
import type { ProviderCapacity, ProviderCapacityWindow, ProviderHeadroomTiming } from "#src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14298. OPERATOR RULING 2026-11-21: within the last hours before a reset the fleet spends what is left. W1-T14200
// made a window in the headroom curve's final rung eligible up to the relaxed ceiling, and W1-T14297 made balanced
// work prefer Codex. A capability preference now stands aside while ANOTHER routable, eligible subscription is in its
// final rung with budget left, so that subscription's expiring budget goes back to today's headroom auction. A
// subscription is in its final rung when every window it reports has a readable reset inside the rung: a five-hour
// window always resets inside it, so that window alone never stands a preference aside. A role preference and the
// operator's own policy are never stood aside. Every spawn below runs the real spawnWorker on the committed table
// and the committed reset curve; only the capacity reads and the provider calls are stubbed.

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const HOUR = 3600;
const COMMITTED = readFileSync(mountsPath(REPO_ROOT), "utf8");
/** plan/policy.yaml's own headroom curve, the one the daemon and the auction load. */
const loadCurve = () => headroomPolicyFromCurve(loadPolicy(policyPath(REPO_ROOT)).values.headroom.curve);
const TIMING: ProviderHeadroomTiming = { nowMs: NOW, policy: loadCurve() };

type Provider = "claude" | "codex";
type Role = "reviewer" | "implementer" | "fixer";

/** A window `hours` from its reset, as each provider reports it: Claude in ISO, Codex in epoch seconds. */
function window(provider: Provider, name: string, usedPercent: number, hours: number | null): ProviderCapacityWindow {
  if (hours === null) return { name, usedPercent };
  const seconds = NOW / 1000 + hours * HOUR;
  return { name, usedPercent, resetsAt: provider === "claude" ? new Date(seconds * 1000).toISOString() : seconds };
}

function capacity(provider: Provider, windows: ProviderCapacityWindow[], extra: Partial<ProviderCapacity> = {}): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows,
    ...(provider === "codex" ? { model: "gpt-6.2-sol", effort: "high" } : {}),
    ...extra,
  };
}

/** One weekly window `hours` from its reset. */
function weekly(provider: Provider, usedPercent: number, hours: number | null): ProviderCapacity {
  return capacity(provider, [window(provider, `${provider} weekly`, usedPercent, hours)]);
}

const unreadable = (provider: Provider): ProviderCapacity => ({ provider, readable: false, windows: [], detail: "usage read failed" });

interface Run {
  role: Role;
  taskId: string;
  model?: string;
  effort?: string;
  claude: ProviderCapacity;
  codex: ProviderCapacity;
  excludeProviders?: SpawnWorkerArgs["excludeProviders"];
}

/** A checkout with no mounts file routes by the committed table; one with `raw` routes by that table. */
function checkout(t: TestContext, raw?: string): string {
  const root = ownedFixtureDir(t, "rmd-expiring-budget-").dir;
  assert.equal(gitWorkTreeAncestor(root), undefined, "the fixture checkout must sit outside every Git work tree");
  if (raw !== undefined) {
    mkdirSync(dirname(mountsPath(root)), { recursive: true });
    writeFileSync(mountsPath(root), raw);
  }
  return root;
}

function codexResult(): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6.2-sol",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

function config(root: string) {
  return {
    claudeBin: "/unused",
    root,
    workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
  } as NonNullable<SpawnWorkerArgs["config"]>;
}

/** Route one spawn the way its lane does: the reviewer runs in the disposable review sandbox. */
async function route(root: string, run: Run): Promise<WorkerSelectionAssignment> {
  const assignments: WorkerSelectionAssignment[] = [];
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: `${REPO_ROOT}/settings/worker.json`,
    prompt: `${run.role} work`,
    model: run.model ?? "sonnet",
    effort: run.effort ?? "medium",
    taskId: run.taskId,
    runId: `run-${run.taskId}-2`,
    ...(run.role === "reviewer" ? { tools: ["Read", "Grep", "Glob"], sandboxIntent: "disposable-review" as const } : {}),
    ...(run.role === "fixer" ? { workerClass: "fix" as const } : {}),
    ...(run.excludeProviders ? { excludeProviders: run.excludeProviders } : {}),
    config: config(root),
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => run.claude,
      readCodex: async () => run.codex,
      spawnCodex: async () => codexResult(),
      writeStatus: () => undefined,
      now: () => NOW,
      loadHeadroomPolicy: loadCurve,
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
  const assignment = assignments.at(-1);
  assert.ok(assignment, "every spawn records its assignment before the provider call");
  assert.equal(result.provider, assignment.selected.provider, "the worker ran on the provider its row names");
  return assignment;
}

function tasks(count: number, from = 14_298): string[] {
  return Array.from({ length: count }, (_, index) => `W1-T${from + index}`);
}

/** What a routing decision is, less its recorded preference: the provider, the rule, the odds and the policy. */
function auctioned(assignment: WorkerSelectionAssignment) {
  return {
    provider: assignment.selected.provider,
    rule: assignment.routing.decision?.rule,
    ab: assignment.routing.decision?.ab,
    propensity: assignment.routing.propensity,
    experiment: assignment.routing.experiment,
    policy: assignment.routing.policy,
    preferenceBypass: assignment.routing.preferenceBypass,
    rolePreference: assignment.routing.rolePreference,
  };
}

function odds(assignment: WorkerSelectionAssignment, provider: Provider): number | "unavailable" | undefined {
  return assignment.routing.propensity?.candidates.find((candidate) => candidate.provider === provider)?.probability;
}

function automaticPolicy(routableProviders: Provider[] = ["claude", "codex"]): EffectiveProviderRoutingPolicy {
  return {
    provenance: "default",
    committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [], codexModelPreference: null },
    enabledProviders: ["claude", "codex"],
    routableProviders,
    preference: "automatic",
    reservePercent: 5,
    parks: [],
  };
}

const TABLE = loadMounts(mountsPath(REPO_ROOT)).capabilities;
const PREFERENCES = TABLE?.providerPreference;
const ROLES = TABLE?.rolePreference;

test("W1-T14298 criterion 1: Claude's final rung stands a balanced build's Codex preference aside, and 30 hours out it does not", async (t) => {
  assert.deepEqual(PREFERENCES, { frontier: "claude", balanced: "codex" }, "the committed capability preferences");
  assert.ok(COMMITTED.includes("    balanced: codex\n"));
  const committed = checkout(t);
  const before = checkout(t, COMMITTED.replace("    balanced: codex\n", ""));
  const codex = weekly("codex", 30, 4 * 24);
  const providers = new Set<string>();
  for (const taskId of tasks(12)) {
    for (const role of ["implementer", "fixer"] as const) {
      const run: Run = { role, taskId, claude: weekly("claude", 60, 6), codex };
      const is = await route(committed, run);
      assert.equal(is.routing.decision?.rule, "headroom-auction", `${role} ${taskId}: the build is drawn by the auction`);
      assert.deepEqual(is.routing.capabilityPreference, { capability: "balanced", provider: "codex", stoodAside: "expiring-budget" },
        `${role} ${taskId}: the row records the stand-aside and its reason`);
      assert.equal(is.routing.policy.preference, "automatic");
      assert.equal(is.routing.preferenceBypass, undefined, "a stand-aside is not a bypass");
      assert.ok(typeof odds(is, "claude") === "number" && (odds(is, "claude") as number) > 0, "Claude's expiring budget is in the draw");
      // Today's headroom auction is the one a table without the preference runs: the same provider and the same odds.
      const auction = await route(before, run);
      assert.equal(auction.routing.capabilityPreference, undefined);
      assert.deepEqual(auctioned(is), auctioned(auction), `${role} ${taskId}: today's headroom auction`);
      providers.add(is.selected.provider);
    }
  }
  assert.ok(providers.has("claude"), "the auction gave Claude some of the balanced work in its final rung");

  // The same reading 30 hours before Claude's reset is outside the final rung: the preference serves.
  for (const taskId of tasks(6)) {
    const is = await route(committed, { role: "implementer", taskId, claude: weekly("claude", 60, 30), codex });
    assert.equal(is.selected.provider, "codex", taskId);
    assert.equal(is.routing.decision?.rule, "capability-preference", taskId);
    assert.deepEqual(is.routing.capabilityPreference, { capability: "balanced", provider: "codex" });
    assert.equal(odds(is, "codex"), 1);
  }
});

test("W1-T14298 criterion 2: frontier's Claude preference stands aside for Codex's final rung, judged on every Codex window", async (t) => {
  const root = checkout(t);
  const claude = weekly("claude", 30, 4 * 24);
  const standsAside: Array<{ name: string; codex: ProviderCapacity }> = [
    { name: "one weekly window 6 h out", codex: weekly("codex", 60, 6) },
    { name: "a 5 h window and a weekly 6 h out", codex: capacity("codex", [
      window("codex", "codex primary 300m", 10, 2), window("codex", "codex secondary 10080m", 60, 6)]) },
    { name: "the weekly listed first", codex: capacity("codex", [
      window("codex", "codex secondary 10080m", 60, 6), window("codex", "codex primary 300m", 10, 2)]) },
  ];
  for (const { name, codex } of standsAside) {
    for (const taskId of tasks(4)) {
      const is = await route(root, { role: "implementer", model: "opus", taskId, claude, codex });
      assert.equal(is.routing.decision?.rule, "headroom-auction", `${name} ${taskId}`);
      assert.deepEqual(is.routing.capabilityPreference, { capability: "frontier", provider: "claude", stoodAside: "expiring-budget" }, name);
      assert.ok(typeof odds(is, "codex") === "number" && (odds(is, "codex") as number) > 0, `${name}: Codex is in the draw`);
    }
  }
  // And symmetric: a balanced build's Codex preference stands aside for a Claude reading that carries a session window.
  const session = capacity("claude", [window("claude", "session (5h)", 20, 3), window("claude", "weekly (all models)", 60, 6)]);
  const balanced = await route(root, { role: "implementer", taskId: "W1-T14298", claude: session, codex: weekly("codex", 30, 4 * 24) });
  assert.deepEqual(balanced.routing.capabilityPreference, { capability: "balanced", provider: "codex", stoodAside: "expiring-budget" });
});

test("W1-T14298 criterion 2: a non-preferred provider with no budget left, unreadable, excluded or with no readable reset leaves the preference in force", async (t) => {
  const root = checkout(t);
  const claude = weekly("claude", 30, 4 * 24);
  const inForce: Array<{ name: string; codex: ProviderCapacity; exclude?: SpawnWorkerArgs["excludeProviders"]; bypass?: string }> = [
    { name: "at its relaxed ceiling", codex: weekly("codex", 100, 6) },
    { name: "unreadable", codex: unreadable("codex") },
    { name: "excluded", codex: weekly("codex", 60, 6), exclude: ["codex"] },
    { name: "no reset", codex: weekly("codex", 60, null) },
    { name: "a reset that is not an instant", codex: capacity("codex", [{ name: "codex weekly", usedPercent: 60, resetsAt: "Nov 22 at 6pm" }]) },
    { name: "a 5 h window resets in the rung, the weekly 4 days out", codex: capacity("codex", [
      window("codex", "codex primary 300m", 10, 2), window("codex", "codex secondary 10080m", 60, 4 * 24)]) },
    { name: "the weekly 4 days out listed first", codex: capacity("codex", [
      window("codex", "codex secondary 10080m", 60, 4 * 24), window("codex", "codex primary 300m", 10, 2)]) },
    { name: "the final rung carried on prepaid credits only", codex: capacity("codex", [window("codex", "codex weekly", 100, 6)],
      { credits: { hasCredits: true, unlimited: true, balance: null } }) },
  ];
  let checked = 0;
  for (const { name, codex, exclude } of inForce) {
    for (const taskId of tasks(3)) {
      const is = await route(root, { role: "implementer", model: "opus", taskId, claude, codex, ...(exclude ? { excludeProviders: exclude } : {}) });
      assert.equal(is.selected.provider, "claude", `${name} ${taskId}`);
      assert.equal(is.routing.decision?.rule, "capability-preference", `${name} ${taskId}`);
      assert.deepEqual(is.routing.capabilityPreference, { capability: "frontier", provider: "claude" }, name);
      assert.equal(odds(is, "claude"), 1, name);
      checked += 1;
    }
  }
  assert.equal(checked, inForce.length * 3);
  // A provider that is parked is not routable: its final rung never stands a preference aside.
  const parked = policyForCapability(automaticPolicy(["claude"]), "frontier", PREFERENCES, undefined,
    { capacities: [claude, weekly("codex", 60, 6)], timing: TIMING });
  assert.deepEqual(parked.capabilityPreference, { capability: "frontier", provider: "claude" });
  assert.equal(parked.policy.preference, "claude");
});

test("W1-T14298 criterion 3: outside every final rung policyForCapability and the recorded row are origin/main's", async (t) => {
  const root = checkout(t);
  // Readings production emits, none with a non-preferred window inside the final rung.
  const outside: Array<{ claude: ProviderCapacity; codex: ProviderCapacity }> = [
    { claude: weekly("claude", 60, 30), codex: weekly("codex", 30, 4 * 24) },
    { claude: weekly("claude", 10, 5 * 24), codex: weekly("codex", 50, 30) },
    { claude: weekly("claude", 40, null), codex: weekly("codex", 40, null) },
    { claude: weekly("claude", 97, 30), codex: weekly("codex", 40, 25) },
    { claude: unreadable("claude"), codex: weekly("codex", 40, 48) },
    { claude: weekly("claude", 40, 48), codex: unreadable("codex") },
  ];
  const policies = [automaticPolicy(), automaticPolicy(["claude"]), automaticPolicy(["codex"])];
  let compared = 0;
  for (const reading of outside) {
    for (const policy of policies) {
      for (const capability of ["economy", "balanced", "frontier", undefined]) {
        for (const role of [undefined, "reviewer"]) {
          const roleArg = { role, preferences: ROLES };
          const today = policyForCapability(policy, capability, PREFERENCES, roleArg);
          const judged = policyForCapability(policy, capability, PREFERENCES, roleArg,
            { capacities: [reading.claude, reading.codex], timing: TIMING });
          assert.deepEqual(judged, today, `${capability} ${role} ${JSON.stringify(policy.routableProviders)} ${JSON.stringify(reading)}`);
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, outside.length * policies.length * 4 * 2);
  // The recorded row: the preference serves as on origin/main, and the row carries no stand-aside field.
  for (const reading of outside.slice(0, 2)) {
    for (const [model, capability, provider] of [["sonnet", "balanced", "codex"], ["opus", "frontier", "claude"]] as const) {
      const is = await route(root, { role: "implementer", model, taskId: "W1-T14298", ...reading });
      assert.equal(is.routing.decision?.rule, "capability-preference", `${capability} ${JSON.stringify(reading)}`);
      assert.equal(is.selected.provider, provider);
      assert.deepEqual(is.routing.capabilityPreference, { capability, provider });
    }
  }
});

test("W1-T14298 criterion 3: a role preference and the operator's own policy are never stood aside", async (t) => {
  // The reviewer prefers Claude by role; Codex is in its final rung with budget left.
  const root = checkout(t);
  for (const taskId of tasks(4)) {
    const review = await route(root, { role: "reviewer", taskId, claude: weekly("claude", 30, 4 * 24), codex: weekly("codex", 60, 6) });
    assert.equal(review.selected.provider, "claude", taskId);
    assert.equal(review.routing.decision?.rule, "role-preference");
    assert.deepEqual(review.routing.rolePreference, { role: "reviewer", provider: "claude" });
    assert.equal(review.routing.capabilityPreference, undefined);
  }
  // A role preference for Codex while Claude is in its final rung is not stood aside either.
  const pure = policyForCapability(automaticPolicy(), "balanced", PREFERENCES, { role: "reviewer", preferences: { reviewer: "codex" } },
    { capacities: [weekly("claude", 60, 6), weekly("codex", 30, 4 * 24)], timing: TIMING });
  assert.deepEqual(pure.rolePreference, { role: "reviewer", provider: "codex" });
  assert.equal(pure.policy.preference, "codex");

  // The operator's own preference, each way round, with the other provider in its final rung.
  for (const [preference, claude, codex] of [
    ["claude", weekly("claude", 30, 4 * 24), weekly("codex", 60, 6)],
    ["codex", weekly("claude", 60, 6), weekly("codex", 30, 4 * 24)],
  ] as const) {
    const operator = checkout(t);
    writeProviderRoutingPolicyOverride(operator, {
      enabledProviders: ["claude", "codex"], preference, reservePercent: 5, parks: [],
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    }, { config: config(operator), writerFingerprint: "unknown", now: () => NOW });
    for (const [model, taskId] of [["sonnet", "W1-T14298"], ["opus", "W1-T14299"]] as const) {
      const is = await route(operator, { role: "implementer", model, taskId, claude, codex });
      assert.equal(is.selected.provider, preference, `${preference} ${model}`);
      assert.equal(is.routing.decision?.rule, "operator-preference", `${preference} ${model}`);
      assert.equal(is.routing.policy.preference, preference);
      assert.equal(is.routing.capabilityPreference, undefined);
      assert.equal(odds(is, preference), 1, `${preference} ${model}: the operator's provider holds the whole share`);
    }
    // And policyForCapability hands the operator's policy back unchanged, whatever the other provider's rung.
    const own: EffectiveProviderRoutingPolicy = { ...automaticPolicy(), provenance: "overridden", preference };
    for (const capability of ["economy", "balanced", "frontier", undefined]) {
      for (const role of [undefined, "reviewer"]) {
        assert.deepEqual(
          policyForCapability(own, capability, PREFERENCES, { role, preferences: ROLES }, { capacities: [claude, codex], timing: TIMING }),
          { policy: own }, `${preference} ${capability} ${role}`);
      }
    }
  }
});
