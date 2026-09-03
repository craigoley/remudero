import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INCIDENT_SCOPE_RE,
  MAX_CLAUDE_STATUS_BYTES,
  clearClaudeModelHealthCache,
  fetchBoundedStatusJson,
  parseDegradedClaudeModels,
  readClaudeModelHealth,
  resolveClaudeModelHealth,
  type ClaudeModelHealthReading,
} from "../src/lib/claude-model-health.js";
import { loadMounts, MountsError, mountsPath, type CapabilityLadder } from "../src/lib/mounts.js";
import { ProviderCapacityBlockedError, type ProviderCapacity } from "../src/lib/worker-provider.js";
import { readProviderRoutingStatus } from "../src/lib/provider-routing-status.js";
import { createClaudeExecutableCache, spawnWorker, workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const STATUS_FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "anthropic-status-2026-09-03.json"), "utf8"));
const NOW = Date.parse("2026-09-03T14:00:00.000Z");

function capabilities(): CapabilityLadder {
  const value = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.ok(value);
  return value;
}

function reading(degradedModels: string[], source: ClaudeModelHealthReading["source"] = "fresh"): ClaudeModelHealthReading {
  return { degradedModels, source, observedAtMs: NOW };
}

test("INCIDENT_SCOPE_RE matches only an explicit only-affected or exhaustive-list scope statement, not ordinary incident prose", () => {
  assert.equal(INCIDENT_SCOPE_RE.test("The only affected models right now are Opus 5 and Opus 4.8."), true);
  assert.equal(INCIDENT_SCOPE_RE.test("This is the exhaustive list of affected models: Opus 5."), true);
  assert.equal(INCIDENT_SCOPE_RE.test("We are investigating elevated error rates for some Claude models."), false);
});

test("the observed incident routes opus and claude-opus-5 to healthy Opus 4.7 without matching Opus 5.1", () => {
  const ladder = capabilities();
  const degraded = parseDegradedClaudeModels(STATUS_FIXTURE, ladder);
  assert.deepEqual(degraded, ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"]);
  assert.equal(degraded.includes("claude-opus-4-7"), false);

  for (const requested of ["opus", "claude-opus-5"]) {
    const route = resolveClaudeModelHealth(requested, ladder, reading(degraded));
    assert.equal(route.eligible, true);
    assert.equal(route.state, "degraded");
    assert.equal(route.routedModel, "claude-opus-4-7");
  }

  const collision = parseDegradedClaudeModels({
    incidents: [{ incident_updates: [{ body: "Only Opus 5.1 is affected." }] }],
  }, ladder);
  assert.equal(collision.includes("claude-opus-5"), false, "Opus 5 must not collide with Opus 5.1");
});

test("a newer explicit incident scope removes recovered models instead of unioning stale updates forever", () => {
  const incident = structuredClone(STATUS_FIXTURE.incidents[0]);
  incident.name = "Elevated Opus 4.6 errors";
  incident.incident_updates.unshift({
    created_at: "2026-09-03T15:25:20.192Z",
    body: "The only affected models right now are Opus 4.8 and Opus 5. The rest of the models have recovered to baseline error rate.",
  });
  const degraded = parseDegradedClaudeModels({ incidents: [incident] }, capabilities());
  assert.deepEqual(degraded, ["claude-opus-5", "claude-opus-4-8"]);
  assert.equal(
    resolveClaudeModelHealth("claude-opus-4-6", capabilities(), reading(degraded)).routedModel,
    "claude-opus-4-6",
  );
});

test("candidate ladders are complete same-capability policy and an explicit pin never upgrades", () => {
  const ladder = capabilities();
  assert.deepEqual(ladder.claudeCandidates?.frontier, [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
  ]);
  assert.equal(resolveClaudeModelHealth("claude-opus-4-7", ladder, reading([])).routedModel, "claude-opus-4-7");
  assert.equal(
    resolveClaudeModelHealth("claude-opus-4-7", ladder, reading(["claude-opus-4-7"])).routedModel,
    "claude-opus-4-6",
  );

  const raw = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const root = mkdtempSync(join(tmpdir(), "rmd-health-mounts-"));
  try {
    const duplicate = raw.replace(
      "[claude-haiku-4-5-20251001]",
      "[claude-haiku-4-5-20251001, claude-haiku-4-5-20251001]",
    );
    writeFileSync(join(root, "duplicate.yaml"), duplicate);
    assert.throws(() => loadMounts(join(root, "duplicate.yaml")), MountsError);

    const aliasCandidate = raw.replace("[claude-haiku-4-5-20251001]", "[haiku]");
    writeFileSync(join(root, "alias.yaml"), aliasCandidate);
    assert.throws(() => loadMounts(join(root, "alias.yaml")), /supported concrete Claude model id/);

    const wrongCapability = raw.replace(
      "claude-opus-4-7: frontier",
      "claude-opus-4-7: balanced",
    );
    writeFileSync(join(root, "wrong.yaml"), wrongCapability);
    assert.throws(() => loadMounts(join(root, "wrong.yaml")), MountsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent reads share one bounded request and a fresh reading is cached", async () => {
  clearClaudeModelHealthCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchJson = async () => {
    calls += 1;
    await gate;
    return STATUS_FIXTURE;
  };
  const requests = Array.from({ length: 3 }, () => readClaudeModelHealth(capabilities(), { fetchJson, now: () => NOW }));
  release();
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.source === "fresh"));
  await readClaudeModelHealth(capabilities(), { fetchJson, now: () => NOW + 59_999 });
  assert.equal(calls, 1, "the one-minute fresh cache prevents one status request per worker");
});

test("status transport is size-bounded, and failures use only bounded stale success before becoming unknown", async () => {
  await assert.rejects(
    () => fetchBoundedStatusJson("https://status.invalid", {
      fetchImpl: async () => new Response("x".repeat(MAX_CLAUDE_STATUS_BYTES + 1), { status: 200 }),
    }),
    /size bound/,
  );

  clearClaudeModelHealthCache();
  let now = NOW;
  let fail = false;
  const fetchJson = async () => {
    if (fail) throw new Error("status unavailable");
    return STATUS_FIXTURE;
  };
  const first = await readClaudeModelHealth(capabilities(), { fetchJson, now: () => now });
  assert.equal(first.source, "fresh");
  fail = true;
  now += 60_001;
  const stale = await readClaudeModelHealth(capabilities(), { fetchJson, now: () => now });
  assert.equal(stale.source, "stale");
  assert.deepEqual(stale.degradedModels, first.degradedModels);
  now += 5 * 60_000;
  const unknown = await readClaudeModelHealth(capabilities(), { fetchJson, now: () => now });
  assert.equal(unknown.source, "unknown");
  assert.deepEqual(unknown.degradedModels, []);

  clearClaudeModelHealthCache();
  const timedOut = await readClaudeModelHealth(capabilities(), {
    fetchJson: async () => new Promise<never>(() => {}),
    timeoutMs: 5,
  });
  assert.equal(timedOut.source, "unknown");
  assert.match(timedOut.detail ?? "", /timed out/);

  clearClaudeModelHealthCache();
  const malformed = await readClaudeModelHealth(capabilities(), { fetchJson: async () => ({ incidents: "wrong" }) });
  assert.equal(malformed.source, "unknown");
  assert.match(malformed.detail ?? "", /malformed/);
});

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} primary`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high", accountLabel: "assigned-subscription" } : {}),
  };
}

function codexResult(model = "gpt-5.6-sol"): WorkerResult {
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
    model,
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

function workerArgs(
  root: string,
  providerRouting: NonNullable<Parameters<typeof spawnWorker>[0]["providerRouting"]>,
  enabled: Array<"claude" | "codex">,
  captureClaudeModel?: (model: string | undefined) => void,
) {
  return {
    // Deliberately not a repository: the real isolation preflight runs from config.root/tmp
    // before a task worktree exists. Capability routing must fall back to the installed checkout.
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "exercise health routing",
    model: "opus",
    effort: "high",
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled, codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    },
    providerRouting,
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
      captureClaudeModel?.(input.options.model);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "claude-session",
          total_cost_usd: 0,
          num_turns: 1,
        };
      })();
    }) as never,
  };
}

test("the Claude SDK receives Opus 4.7 while durable evidence keeps requested, routed, and served identities distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-health-claude-worker-"));
  let spawnedModel: string | undefined;
  try {
    const result = await spawnWorker(workerArgs(root, {
      readClaudeHealth: async () => reading(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"]),
      now: () => NOW,
    }, ["claude"], (model) => { spawnedModel = model; }));
    assert.equal(spawnedModel, "claude-opus-4-7");
    assert.equal(result.model, "opus");
    assert.equal(result.routedModel, "claude-opus-4-7");
    assert.equal(result.modelHealthState, "degraded");
    assert.equal(result.modelHealthSource, "fresh");
    const fields = workerLedgerFields(result);
    assert.equal(fields.model, "opus");
    assert.equal(fields.routed_model, "claude-opus-4-7");
    assert.equal(fields.served_model, null);
    assert.equal(fields.model_health_state, "degraded");
    assert.equal(fields.model_health_source, "fresh");
    const status = readProviderRoutingStatus(root, { now: () => NOW });
    assert.equal(status.state, "not-probed", "Claude-only capacity remains unprobed");
    assert.deepEqual(status.modelHealth, {
      requestedModel: "opus",
      routedModel: "claude-opus-4-7",
      state: "degraded",
      source: "fresh",
      eligible: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all degraded Claude candidates admit only an enabled assigned Codex subscription above reserve", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-health-codex-worker-"));
  const allFrontier = [...(capabilities().claudeCandidates?.frontier ?? [])];
  assert.ok(allFrontier.length > 0);
  let codexSpawned = 0;
  type ProviderRouting = NonNullable<Parameters<typeof spawnWorker>[0]["providerRouting"]>;
  type ReadCodex = NonNullable<ProviderRouting["readCodex"]>;
  let initialRequest: Parameters<ReadCodex>[1] | undefined;
  try {
    const result = await spawnWorker(workerArgs(root, {
      readClaudeHealth: async () => reading(allFrontier),
      readClaude: async () => { throw new Error("known-degraded Claude must not spend a capacity probe"); },
      readCodex: async (_config, request) => {
        if (!request.forceRefresh) initialRequest = request;
        return capacity("codex", 20, request.selectedModel ?? "gpt-5.6-sol");
      },
      spawnCodex: async () => { codexSpawned += 1; return codexResult(); },
      now: () => NOW,
    }, ["claude", "codex"]));
    assert.equal(initialRequest?.requestedModel, "opus");
    assert.equal(initialRequest?.capabilities?.claude.opus, "frontier");
    assert.equal(codexSpawned, 1);
    assert.equal(result.provider, "codex");
    assert.equal(result.model, "opus");
    assert.equal(result.routedModel, "gpt-5.6-sol");
    assert.equal(result.modelHealthState, "degraded");

    codexSpawned = 0;
    await assert.rejects(
      () => spawnWorker(workerArgs(root, {
        readClaudeHealth: async () => reading(allFrontier),
        readCodex: async () => capacity("codex", 95, "gpt-5.6-sol"),
        spawnCodex: async () => { codexSpawned += 1; return codexResult(); },
        now: () => NOW,
      }, ["claude", "codex"])),
      ProviderCapacityBlockedError,
    );
    assert.equal(codexSpawned, 0);

    await assert.rejects(
      () => spawnWorker(workerArgs(root, {
        readClaudeHealth: async () => reading(allFrontier),
        now: () => NOW,
      }, ["claude"])),
      ProviderCapacityBlockedError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown advisory health preserves a Claude-only request and Codex-only installs never call Anthropic status", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-health-unknown-worker-"));
  let spawnedModel: string | undefined;
  try {
    const claude = await spawnWorker(workerArgs(root, {
      readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "status unavailable" }),
      now: () => NOW,
    }, ["claude"], (model) => { spawnedModel = model; }));
    assert.equal(spawnedModel, "opus");
    assert.equal(claude.modelHealthState, "unknown");

    let healthReads = 0;
    const codex = await spawnWorker(workerArgs(root, {
      readClaudeHealth: async () => { healthReads += 1; return reading([]); },
      readCodex: async (_config, request) => capacity("codex", 10, request.selectedModel ?? "gpt-5.6-sol"),
      spawnCodex: async () => codexResult(),
      now: () => NOW,
    }, ["codex"]));
    assert.equal(codex.provider, "codex");
    assert.equal(healthReads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
