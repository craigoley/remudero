import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadMounts, mountsPath, resolveMountForClass, validateMounts, TierInvariantError, MountsError } from "../src/lib/mounts.js";
import { DESIGN_RECORD_GLOB_RE, deriveTaskClass, implementRouteClass } from "../src/lib/task-class.js";
import { resolveRunMounts } from "../src/run-task.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  SubscriptionOnlyRefusedError,
  type SpawnWorkerArgs,
  type WorkerResult,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// Operator ruling 2026-09-24 (DECISIONS.md): Opus takes risk:high and design work on its FIRST
// attempt, as a peer of the Architect and judge (G-17 amended). A later operator ruling permits
// a bounded Foundry cash exception only when both subscriptions block and cash can serve the tools.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

test("a task that edits the design record is design work whatever else it touches", () => {
  assert.equal(deriveTaskClass({ files: ["docs/adr/0042-router.md"] }), "design");
  assert.equal(deriveTaskClass({ files: ["src/lib/worker.ts", "MASTER-PLAN.md"] }), "design");
  assert.equal(deriveTaskClass({ files: ["docs/architecture.md"] }), "design");
  assert.equal(deriveTaskClass({ files: ["docs/model-routing.md"] }), "docs", "an ordinary doc stays docs");
  assert.equal(deriveTaskClass({ files: ["src/lib/worker.ts"] }), "src");
});

test("DESIGN_RECORD_GLOB_RE names the design record and nothing beside it", () => {
  for (const path of ["docs/adr/0001-x.md", "docs/design-review/a.md", "docs/architecture.md", "docs/system-diagrams.md", "MASTER-PLAN.md"]) {
    assert.equal(DESIGN_RECORD_GLOB_RE.test(path), true, path);
  }
  for (const path of ["docs/architecture.md.bak", "docs/adrs.md", "plan/MASTER-PLAN.md.orig", "src/architecture.ts", "docs/model-routing.md"]) {
    assert.equal(DESIGN_RECORD_GLOB_RE.test(path), false, path);
  }
});

test("the shipped table sends risk:high and design implement work to Opus and nothing else", () => {
  const m = loadMounts(mountsPath(REPO_ROOT));
  assert.equal(resolveMountForClass(m, "implement", "high", "src").mount.model, "opus");
  for (const risk of ["low", "medium", "high"]) {
    assert.equal(resolveMountForClass(m, "implement", risk, "design").mount.model, "opus", risk);
  }
  assert.equal(resolveMountForClass(m, "implement", "medium", "src").mount.model, "sonnet");
  assert.equal(resolveMountForClass(m, "implement", "low", "docs").mount.model, "haiku");
  assert.deepEqual(m.capabilities?.subscriptionOnly, ["frontier"]);
});

function table(implementHigh: string, extraTiers: Record<string, number> = {}) {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3, ...extraTiers },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "sonnet", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "sonnet", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        medium: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 160000 } },
        high: { src: { model: implementHigh, effort: "high", max_turns: 50, context_budget: 180000 } },
      },
    },
  };
}

test("a high-risk span task does not start on Opus and a danger or design task does", () => {
  const route = (task: { risk: string; band_meaning?: string; files: string[] }) =>
    resolveRunMounts(REPO_ROOT, { type: "implement", ...task } as never, () => {}).mount.model;
  assert.equal(route({ risk: "high", band_meaning: "span", files: ["src/lib/a.ts", "src/lib/b.ts"] }), "sonnet", "large but routine: mid tier");
  assert.equal(route({ risk: "high", band_meaning: "span", files: ["docs/a.md"] }), "sonnet", "a span docs task does not fall back onto Opus");
  assert.equal(route({ risk: "high", band_meaning: "blast-radius", files: ["src/lib/a.ts"] }), "opus");
  assert.equal(route({ risk: "high", band_meaning: "span", files: ["docs/adr/0001.md"] }), "opus", "design work starts on Opus whatever its band");
  assert.equal(implementRouteClass({ type: "review", risk: "high", band_meaning: "span" }, "src"), "src", "only the implement route splits on band");
});

test("an unbanded high-risk task does not start on Opus", () => {
  const route = (files: string[], band_meaning?: string) =>
    resolveRunMounts(REPO_ROOT, { type: "implement", risk: "high", files, ...(band_meaning ? { band_meaning } : {}) } as never, () => {}).mount.model;
  assert.equal(route(["src/lib/a.ts"]), "sonnet", "no declared band is routine: mid tier");
  assert.equal(route(["docs/a.md"]), "sonnet", "nor does an unbanded docs task fall back onto Opus");
  assert.equal(route(["src/lib/a.ts"], "blast-radius"), "opus", "only a declared danger band starts on Opus");
  assert.equal(route(["MASTER-PLAN.md"]), "opus", "design work starts on Opus without any band");
  assert.equal(loadMounts(mountsPath(REPO_ROOT)).step_up?.model, "opus", "repeated failures still step up to Opus");
});

test("G-17 as amended admits a risk:high Opus worker row as a peer and never one above", () => {
  assert.doesNotThrow(() => validateMounts(table("opus")));
  assert.throws(() => validateMounts(table("mythos", { mythos: 4 })), TierInvariantError, "above the Architect is still refused");
  const medium = table("sonnet");
  medium.routes.implement.medium.src.model = "opus";
  assert.throws(() => validateMounts(medium), /routes\.implement\.medium\.src/, "a medium-risk src row may not be a peer");
});

test("the loader refuses a frontier mount pinned to cash", () => {
  const raw = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const root = mkdtempSync(join(tmpdir(), "rmd-subscription-only-"));
  try {
    const pinned = raw.replace(
      "retro:       { model: claude-opus-5-5, effort: high, max_turns: 400, context_budget: 180000 }",
      "retro:       { model: claude-opus-5-5, effort: high, max_turns: 400, context_budget: 180000, provider: cash }",
    );
    assert.notEqual(pinned, raw, "the fixture edit must land");
    writeFileSync(join(root, "pinned.yaml"), pinned);
    assert.throws(() => loadMounts(join(root, "pinned.yaml")), /synthesis\.retro.*subscription-only/);
    writeFileSync(join(root, "unknown.yaml"), raw.replace("subscription_only: [frontier]", "subscription_only: [genius]"));
    assert.throws(() => loadMounts(join(root, "unknown.yaml")), MountsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Through the real spawn path ─────────────────────────────────────────────────────────────────

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

const unreadable = (provider: "claude" | "codex"): ProviderCapacity => ({ provider, readable: false, windows: [], detail: "exhausted" });
const KEY = "test-only-overflow-factor-present";

async function spawnAs(root: string, model: string, over: Partial<SpawnWorkerArgs> = {}, enabled = ["claude", "codex", "cash"]) {
  let cashSpawns = 0;
  const cashSelections: Array<{ model: string; squeezed: boolean }> = [];
  let childEnv: Record<string, string | undefined> | undefined;
  const outcome = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    model,
    effort: "high",
    tools: ["Read", "Grep", "Glob", "RunCheck"],
    env: { ANTHROPIC_API_KEY: KEY },
    config: {
      claudeBin: "/unused",
      root,
      dailyCapUsd: 20,
      overflow: "api_key",
      workerProviders: { enabled, codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000, cashFallbackWhenBlocked: true },
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => unreadable("claude"),
      readCodex: async () => unreadable("codex"),
      spawnOpenWeight: async (args, _config, selection) => {
        cashSpawns += 1;
        cashSelections.push({ model: selection.model, squeezed: args.cashSqueezed === true });
        return { provider: "cash", model: selection.model, text: "done", isError: false, subtype: "success" } as never;
      },
      writeStatus: () => {},
      now: () => NOW,
    },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: ((input: { options: { env?: Record<string, string | undefined> } }) => {
      childEnv = input.options.env;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
    ...over,
  } as SpawnWorkerArgs).then((result: WorkerResult) => result, (error: unknown) => error);
  return { outcome, cashSpawns, cashSelections, childEnv };
}

test("a blocked auction holds frontier work instead of diverting it to cash or API credits", async () => {
  const root = fixtureRoot("rmd-opus-hold-");
  try {
    const opus = await spawnAs(root, "opus");
    assert.equal(opus.cashSpawns, 0, "frontier work never diverts to cash");
    assert.equal(opus.childEnv, undefined, "and never reaches an API-billed Claude spawn");
    assert.equal((opus.outcome as Error).name, "ProviderCapacityBlockedError", "it waits for a subscription");
    const sonnet = await spawnAs(root, "sonnet");
    assert.equal(sonnet.cashSpawns, 1, "balanced work still takes the cash arm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frontier spawn pinned to cash is refused by name", async () => {
  const root = fixtureRoot("rmd-opus-cash-");
  try {
    const opus = await spawnAs(root, "claude-opus-5-5", { mountProvider: "cash", env: {
      RMD_FOUNDRY_CLAUDE_API_KEY: "test-only", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://example.test/anthropic",
    } });
    assert.ok(opus.outcome instanceof SubscriptionOnlyRefusedError);
    assert.equal(opus.cashSpawns, 0);
    const haiku = await spawnAs(root, "haiku", { mountProvider: "cash" });
    assert.equal(haiku.cashSpawns, 1, "an economy lane pinned to cash still runs there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked frontier auction uses Foundry Opus only with a declared cash tool surface and endpoint", async () => {
  const root = fixtureRoot("rmd-opus-emergency-");
  try {
    const env = { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://example.test/anthropic" };
    const emergency = await spawnAs(root, "opus", { env });
    assert.deepEqual(emergency.cashSelections, [{ model: "claude-opus-5-5", squeezed: true }]);
    assert.equal((emergency.outcome as WorkerResult).isError, false);
    const shell = await spawnAs(root, "opus", { env, tools: ["Bash"] });
    assert.equal(shell.cashSpawns, 0, "unsupported tools keep the task held");
    assert.equal((shell.outcome as Error).name, "ProviderCapacityBlockedError");
    const missing = await spawnAs(root, "opus", { env: { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only" } });
    assert.equal(missing.cashSpawns, 0, "an unconfigured Foundry endpoint keeps the task held");
    const oneSubscription = await spawnAs(root, "opus", { env }, ["claude", "cash"]);
    assert.equal(oneSubscription.cashSpawns, 0, "a single observed subscription cannot assert that both are blocked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an Opus Claude spawn never carries the API key even with the overflow valve armed", async () => {
  const root = fixtureRoot("rmd-opus-key-");
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = KEY;
  try {
    const opus = await spawnAs(root, "opus", { env: {} }, ["claude"]);
    assert.ok(opus.childEnv, `the Claude spawn must run: ${String(opus.outcome)}`);
    assert.equal(opus.childEnv.ANTHROPIC_API_KEY, undefined, "Opus bills the subscription only");
    const sonnet = await spawnAs(root, "sonnet", { env: {} }, ["claude"]);
    assert.equal(sonnet.childEnv?.ANTHROPIC_API_KEY, KEY, "a balanced spawn still carries the armed valve");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
