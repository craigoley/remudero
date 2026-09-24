import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { providerEligibility, type ProviderCapacity } from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  workerSelectionAssignment,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// Every worker.assignment row must say WHY its provider was chosen: the rule that fired, the
// providers it weighed, and each subscription's headroom at that moment. The console explains a
// decision from this record alone.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const POLICY = { preference: "automatic" as const, reservePercent: 5, provenance: "default" as const };

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

const unreadable = (provider: "claude" | "codex"): ProviderCapacity => ({ provider, readable: false, windows: [], detail: "exhausted" });

function record(input: Partial<Parameters<typeof workerSelectionAssignment>[1]>, args: Partial<SpawnWorkerArgs> = {}) {
  return workerSelectionAssignment({ cwd: "/w", prompt: "p", ...args } as SpawnWorkerArgs, {
    provider: "claude",
    model: "claude-sonnet-5",
    effort: "high",
    mode: "multi-provider",
    selectionPath: "auction",
    policy: POLICY,
    ...input,
  });
}

test("the decision record reuses the auction admission test for eligibility and headroom", () => {
  assert.deepEqual(providerEligibility(capacity("claude", 40), 5), { eligible: true, headroomPercent: 60 });
  assert.deepEqual(providerEligibility(capacity("codex", 96), 5), { eligible: false, reason: "below-reserve", headroomPercent: 4 });
  assert.deepEqual(providerEligibility(unreadable("codex"), 5), { eligible: false, reason: "unreadable", headroomPercent: null });
});

test("a headroom auction records its rule and every subscription headroom", () => {
  const claude = capacity("claude", 40);
  const codex = capacity("codex", 70, "gpt-6-luna");
  const row = record({ capacity: claude, capacities: [claude, codex] });
  assert.equal(row.routing.decision?.rule, "headroom-auction");
  assert.deepEqual(row.routing.decision?.headroomPercent, { claude: 60, codex: 30 });
  assert.deepEqual(row.routing.decision?.considered, [
    { provider: "claude", model: "claude-sonnet-5", eligible: true, selected: true },
    { provider: "codex", model: "gpt-6-luna", eligible: true, selected: false },
  ]);
});

test("each auction branch names its own rule", () => {
  const claude = capacity("claude", 40);
  const both = [claude, capacity("codex", 70)];
  const frontier = { capability: "frontier", provider: "claude" as const };
  assert.equal(record({ capacities: both, capabilityPreference: frontier }).routing.decision?.rule, "capability-preference");
  assert.equal(
    record({ capacities: both, capabilityPreference: frontier, preferenceBypass: { provider: "claude", reason: "below-reserve" } })
      .routing.decision?.rule,
    "preference-bypassed",
  );
  assert.equal(record({ capacities: both, policy: { ...POLICY, preference: "codex" } }).routing.decision?.rule, "operator-preference");
  assert.equal(record({ mode: "claude-only" }).routing.decision?.rule, "claude-only");
  assert.equal(record({ mode: "mount-affinity", selectionPath: "mount-affinity" }).routing.decision?.rule, "mount-affinity");
});

test("the decision names the capability tier that was requested", () => {
  assert.equal(record({ capability: "frontier" }).routing.decision?.capability, "frontier");
  assert.equal("capability" in (record({}).routing.decision ?? {}), false, "no requested model means no invented tier");
});

test("a pinned lane with no capacity reading still names the provider it was pinned to", () => {
  const row = record({ provider: "cash", model: "gpt-oss-120b", mode: "mount-affinity", selectionPath: "mount-affinity", alternatives: ["gpt-5-nano"] });
  assert.deepEqual(row.routing.decision, {
    rule: "mount-affinity",
    considered: [
      { provider: "cash", model: "gpt-oss-120b", eligible: true, selected: true },
      { provider: "cash", model: "gpt-5-nano", eligible: true, selected: false, reason: "ladder-alternative" },
    ],
    headroomPercent: {},
  });
});

// ── Through the real spawn path ─────────────────────────────────────────────────────────────────

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

function cashResult(): WorkerResult {
  return { provider: "cash", text: "done", isError: false, subtype: "success" } as unknown as WorkerResult;
}

type BlockedOverrides = Omit<Partial<SpawnWorkerArgs>, "config"> & { config?: Record<string, unknown> };

async function spawnBlocked(root: string, over: BlockedOverrides) {
  const assignments: WorkerSelectionAssignment[] = [];
  let cashSpawns = 0;
  const { config: configOver, ...argsOver } = over;
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    model: "sonnet",
    effort: "high",
    config: {
      claudeBin: "/unused",
      root,
      dailyCapUsd: 20,
      workerProviders: {
        enabled: ["claude", "codex", "cash"],
        codexBin: "/unused/codex",
        reservePercent: 5,
        capacityCacheMs: 60_000,
        cashFallbackWhenBlocked: true,
      },
      ...configOver,
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => capacity("claude", 99),
      readCodex: async () => unreadable("codex"),
      spawnOpenWeight: async () => { cashSpawns += 1; return cashResult() as never; },
      writeStatus: () => {},
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
    ...argsOver,
  } as SpawnWorkerArgs).catch((error: unknown) => error);
  return { assignments, cashSpawns };
}

test("a blocked auction diverted to cash records cash-fallback with the readings that blocked it", async () => {
  const root = fixtureRoot("rmd-decision-cash-");
  try {
    const run = await spawnBlocked(root, { tools: ["Read", "Grep", "Glob", "RunCheck"] });
    assert.equal(run.cashSpawns, 1);
    const decision = run.assignments.at(-1)?.routing.decision;
    assert.equal(decision?.rule, "cash-fallback");
    assert.equal(decision?.capability, "balanced", "a sonnet request is balanced work on every provider");
    assert.deepEqual(decision?.headroomPercent, { claude: 1, codex: null });
    assert.deepEqual(
      decision?.considered
        .filter((entry) => entry.provider !== "cash")
        .map(({ provider, eligible, selected, reason }) => ({ provider, eligible, selected, reason })),
      [
        { provider: "claude", eligible: false, selected: false, reason: "below-reserve" },
        { provider: "codex", eligible: false, selected: false, reason: "unreadable" },
      ],
    );
    assert.equal(decision?.considered.find((entry) => entry.selected)?.provider, "cash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked auction billed to API credits records overflow-fallback", async () => {
  const root = fixtureRoot("rmd-decision-overflow-");
  try {
    const run = await spawnBlocked(root, {
      config: { overflow: "api_key" },
      env: { ANTHROPIC_API_KEY: "test-only-overflow-factor-present" },
    });
    assert.equal(run.cashSpawns, 0, "an unbounded surface is never handed to cash");
    const decision = run.assignments.at(-1)?.routing.decision;
    assert.equal(decision?.rule, "overflow-fallback");
    assert.equal(decision?.capability, "balanced");
    assert.deepEqual(decision?.headroomPercent, { claude: 1, codex: null });
    assert.equal(decision?.considered.find((entry) => entry.selected)?.provider, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function codexResult(): WorkerResult {
  return { provider: "codex", text: "done", isError: false, subtype: "success", model: "gpt-6-luna" } as unknown as WorkerResult;
}

test("a Codex spawn records the tier on both the auction and the pinned path", async () => {
  const root = fixtureRoot("rmd-decision-codex-");
  try {
    for (const mountProvider of [undefined, "codex" as const]) {
      const assignments: WorkerSelectionAssignment[] = [];
      await spawnWorker({
        cwd: root,
        permissionMode: "bypassPermissions" as const,
        settingsFile: join(REPO_ROOT, "settings", "worker.json"),
        prompt: "work",
        model: "sonnet",
        effort: "high",
        ...(mountProvider ? { mountProvider } : {}),
        config: {
          claudeBin: "/unused",
          root,
          workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
        } as never,
        providerRouting: {
          readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
          readClaude: async () => capacity("claude", 97),
          readCodex: async () => capacity("codex", 20, "gpt-6-luna"),
          spawnCodex: async () => codexResult() as never,
          writeStatus: () => {},
          now: () => NOW,
        },
        onSelectionAssignment: (assignment) => assignments.push(assignment),
      } as SpawnWorkerArgs);
      const decision = assignments.at(-1)?.routing.decision;
      assert.equal(decision?.capability, "balanced", String(mountProvider));
      assert.equal(decision?.rule, mountProvider ? "mount-affinity" : "headroom-auction");
      if (!mountProvider) assert.deepEqual(decision?.headroomPercent, { claude: 3, codex: 80 });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
