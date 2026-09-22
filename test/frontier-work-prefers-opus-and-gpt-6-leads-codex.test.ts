import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadMounts, MountsError, mountsPath, type CapabilityLadder } from "../src/lib/mounts.js";
import {
  policyForCapability,
  selectWorkerProviderForPolicy,
  type EffectiveProviderRoutingPolicy,
} from "../src/lib/provider-routing-policy.js";
import { selectCodexModel, type CodexModelInfo, type ProviderCapacity } from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// 2026-09-22 model change: GPT-5.6 Luna -> GPT-6 Luna, Terra phased out, and Sol 6 "only if
// absolutely necessary" behind Claude Opus. Measured before this change: 84 of 127 Opus-requested runs
// went to Codex gpt-5.6-sol, because the auction split frontier work by headroom alone.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-22T19:00:00.000Z");

function mounts() {
  return loadMounts(mountsPath(REPO_ROOT));
}

function ladder(): CapabilityLadder {
  const value = mounts().capabilities;
  assert.ok(value);
  return value;
}

function policy(overrides: Partial<EffectiveProviderRoutingPolicy> = {}): EffectiveProviderRoutingPolicy {
  return {
    committed: false,
    enabledProviders: ["claude", "codex"],
    routableProviders: ["claude", "codex"],
    preference: "automatic",
    reservePercent: 5,
    parks: [],
    provenance: "default",
    ...overrides,
  } as EffectiveProviderRoutingPolicy;
}

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} primary`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high", accountLabel: "assigned-subscription" } : {}),
  };
}

// The account's model/list as read from the fleet daemon on 2026-09-22 (ids and efforts only).
const LIVE_MODELS: CodexModelInfo[] = [
  ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], true],
  ["gpt-6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
].map(([id, efforts, isDefault]) => ({
  id: id as string,
  model: id as string,
  isDefault: isDefault === true,
  supportedReasoningEfforts: (efforts as string[]).map((reasoningEffort) => ({ reasoningEffort })),
}));
// One shared bucket for every model, as measured: headroom ties, so row order decides.
const LIVE_LIMITS = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 71, windowDurationMins: 10080 } } } };

test("GPT-6 Luna leads every Codex row GPT-5.6 Luna led, and Terra is in no Codex row", () => {
  const codex = ladder().codex;
  for (const [capability, byEffort] of Object.entries(codex)) {
    for (const [effort, row] of Object.entries(byEffort)) {
      assert.equal(row.includes("gpt-5.6-terra"), false, `${capability}.${effort} still routes Terra`);
      const old = row.indexOf("gpt-5.6-luna");
      if (old >= 0) assert.ok(row.indexOf("gpt-6-luna") >= 0 && row.indexOf("gpt-6-luna") < old, `${capability}.${effort}`);
    }
  }
  for (const effort of ["low", "medium", "high"]) {
    assert.equal(codex.balanced[effort][0], "gpt-6-luna");
    assert.equal(codex.frontier[effort][0], "gpt-6-sol");
    assert.equal(codex.balanced[effort].some((model) => model.includes("sol")), false, "no Sol in a balanced row");
  }
});

test("replayed against the live account, balanced and economy pick GPT-6 Luna and frontier picks Sol 6", () => {
  const table = ladder();
  for (const [model, effort, expected] of [
    ["sonnet", "high", "gpt-6-luna"],
    ["sonnet", "medium", "gpt-6-luna"],
    ["haiku", "low", "gpt-6-luna"],
    ["claude-opus-5", "high", "gpt-6-sol"],
    ["opus", "high", "gpt-6-sol"],
  ] as const) {
    const picked = selectCodexModel(LIVE_MODELS, LIVE_LIMITS, {} as never, model, effort, table);
    assert.equal(picked.model, expected, `${model}/${effort}`);
    assert.equal(picked.readable, true);
  }
});

test("without GPT-6 Luna on the account, balanced falls to GPT-5.6 Luna and never to Terra", () => {
  const withoutSix = LIVE_MODELS.filter((model) => model.id !== "gpt-6-luna");
  const picked = selectCodexModel(withoutSix, LIVE_LIMITS, {} as never, "sonnet", "high", ladder());
  assert.equal(picked.model, "gpt-5.6-luna");
});

test("an automatic policy takes the frontier preference and nothing else changes", () => {
  const preferences = ladder().providerPreference;
  assert.deepEqual(preferences, { frontier: "claude" });
  const frontier = policyForCapability(policy(), "frontier", preferences);
  assert.equal(frontier.policy.preference, "claude");
  assert.deepEqual(frontier.capabilityPreference, { capability: "frontier", provider: "claude" });
  for (const capability of ["balanced", "economy", undefined]) {
    const other = policyForCapability(policy(), capability, preferences);
    assert.equal(other.policy.preference, "automatic", String(capability));
    assert.equal(other.capabilityPreference, undefined);
  }
});

test("an operator's explicit preference wins over the capability preference", () => {
  const operator = policyForCapability(policy({ preference: "codex" }), "frontier", { frontier: "claude" });
  assert.equal(operator.policy.preference, "codex");
  assert.equal(operator.capabilityPreference, undefined);
  const unroutable = policyForCapability(policy({ routableProviders: ["codex"] }), "frontier", { frontier: "claude" });
  assert.equal(unroutable.policy.preference, "automatic", "a parked or disabled provider is never preferred");
});

test("frontier work takes Claude with headroom even when Codex has far more, and Sol 6 only when Claude is blocked", () => {
  const frontier = policyForCapability(policy(), "frontier", { frontier: "claude" }).policy;
  const capacities = [capacity("claude", 80), capacity("codex", 5, "gpt-6-sol")];
  for (let tieBreaker = 0; tieBreaker < 20; tieBreaker += 1) {
    assert.equal(selectWorkerProviderForPolicy(capacities, frontier, tieBreaker).selection.provider, "claude");
  }
  // The same capacities under the old automatic auction hand Codex most of the frontier work.
  const automaticPicks = Array.from({ length: 20 }, (_, tieBreaker) =>
    selectWorkerProviderForPolicy(capacities, policy(), tieBreaker).selection.provider);
  assert.ok(automaticPicks.filter((provider) => provider === "codex").length > 10);

  const blocked = selectWorkerProviderForPolicy([capacity("claude", 97), capacity("codex", 5, "gpt-6-sol")], frontier);
  assert.equal(blocked.selection.provider, "codex");
  assert.deepEqual(blocked.preferenceBypass, { provider: "claude", reason: "below-reserve" });
});

test("the loader refuses a preference for cash or for a capability the ladder does not declare", () => {
  const raw = readFileSync(mountsPath(REPO_ROOT), "utf8");
  assert.ok(raw.includes("  provider_preference:\n    frontier: claude\n"));
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-preference-"));
  try {
    writeFileSync(join(root, "cash.yaml"), raw.replace("    frontier: claude\n", "    frontier: cash\n"));
    assert.throws(() => loadMounts(join(root, "cash.yaml")), /must be "claude" or "codex"/);
    writeFileSync(join(root, "unknown.yaml"), raw.replace("    frontier: claude\n", "    genius: claude\n"));
    assert.throws(() => loadMounts(join(root, "unknown.yaml")), MountsError);
    writeFileSync(join(root, "scalar.yaml"), raw.replace("  provider_preference:\n    frontier: claude\n", "  provider_preference: claude\n"));
    assert.throws(() => loadMounts(join(root, "scalar.yaml")), /must be a mapping of capability -> provider/);
    writeFileSync(join(root, "absent.yaml"), raw.replace("  provider_preference:\n    frontier: claude\n", ""));
    assert.equal(loadMounts(join(root, "absent.yaml")).capabilities?.providerPreference, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Through the real spawn path ─────────────────────────────────────────────────────────────────

function workerFixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
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
    model: "gpt-6-sol",
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

async function spawnFrontier(root: string, claudeUsed: number, model = "opus") {
  const assignments: WorkerSelectionAssignment[] = [];
  let claudeModel: string | undefined;
  let codexSpawned = 0;
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "frontier work",
    model,
    effort: "high",
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    },
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => capacity("claude", claudeUsed),
      readCodex: async (_config, request) => capacity("codex", 5, request.selectedModel ?? "gpt-6-sol"),
      spawnCodex: async () => { codexSpawned += 1; return codexResult(); },
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
    queryFn: ((input: { options: { model?: string } }) => {
      claudeModel = input.options.model;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
  });
  const expectedClaudeModel = mounts().capabilities?.claudeCandidates?.frontier[0];
  return { result, assignments, claudeModel, codexSpawned, expectedClaudeModel };
}

test("an opus lane with Claude headroom runs on Claude Opus and its assignment names the preference", async () => {
  const root = workerFixtureRoot("rmd-frontier-claude-");
  try {
    for (const model of ["opus", "claude-opus-5"]) {
      const run = await spawnFrontier(root, 80, model);
      assert.equal(run.codexSpawned, 0, "Codex has 95% headroom and still must not take frontier work");
      assert.equal(run.result.provider, "claude");
      assert.equal(run.claudeModel, run.expectedClaudeModel);
      const assignment = run.assignments.at(-1);
      assert.equal(assignment?.selected.provider, "claude");
      assert.deepEqual(assignment?.routing.capabilityPreference, { capability: "frontier", provider: "claude" });
      assert.equal(assignment?.routing.policy.preference, "automatic", "the ledger keeps the operator's own policy");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an opus lane with Claude below reserve runs on Sol 6 and records why", async () => {
  const root = workerFixtureRoot("rmd-frontier-sol-");
  try {
    const run = await spawnFrontier(root, 97);
    assert.equal(run.codexSpawned, 1);
    assert.equal(run.result.provider, "codex");
    assert.equal(run.result.routedModel, "gpt-6-sol");
    const assignment = run.assignments.at(-1);
    assert.equal(assignment?.selected.model, "gpt-6-sol");
    assert.deepEqual(assignment?.routing.preferenceBypass, { provider: "claude", reason: "below-reserve" });
    assert.deepEqual(assignment?.routing.capabilityPreference, { capability: "frontier", provider: "claude" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
