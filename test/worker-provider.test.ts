import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CodexToolchainBlockedError,
  ProviderCapacityBlockedError,
  abandonProviderWindowMeasurement,
  beginProviderWindowMeasurement,
  claudeCapacityFromUsage,
  clearCodexCapacityCache,
  clearProviderWindowMeasurements,
  codexCapacityFromRateLimits,
  codexGitWritableRoots,
  parseCodexJsonl,
  readCodexCapacity,
  providerWindowConsumption,
  finishProviderWindowMeasurement,
  selectCodexModel,
  selectWorkerProvider,
  spawnCodexWorker,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";
import {
  clearClaudeCapacityCache,
  createClaudeExecutableCache,
  readClaudeProviderCapacity,
  spawnWorker,
  workerLedgerFields,
} from "../src/lib/worker.js";
import { withLiveSpawnAllowed } from "../src/lib/spawn-guard.js";
import type { CapabilityLadder } from "../src/lib/mounts.js";

function capacity(provider: "claude" | "codex", ...usedPercent: number[]): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: usedPercent.map((value, index) => ({ name: `window-${index}`, usedPercent: value })),
  };
}

test("provider selector uses the subscription with the most tight-window headroom", () => {
  assert.equal(selectWorkerProvider([capacity("claude", 30, 70), capacity("codex", 25, 40)]).provider, "codex");
});

test("provider selector excludes an exhausted provider even when another window is empty", () => {
  assert.equal(selectWorkerProvider([capacity("claude", 0, 95), capacity("codex", 80, 81)]).provider, "codex");
});

test("provider selector fails closed when every capacity source is unreadable or at reserve", () => {
  assert.throws(
    () => selectWorkerProvider([
      { provider: "claude", readable: false, windows: [], detail: "offline" },
      capacity("codex", 95),
    ]),
    ProviderCapacityBlockedError,
  );
});

test("toolchain failures keep the blocked classification", () => {
  const error = new CodexToolchainBlockedError("missing");
  assert.equal(error.name, "CodexToolchainBlockedError");
  assert.equal(error.reasonClass, "blocked_toolchain");
});

test("provider selector rejects an out-of-range percentage instead of treating it as headroom", () => {
  assert.throws(() => selectWorkerProvider([capacity("codex", -1)]), ProviderCapacityBlockedError);
});

test("provider selector alternates exact ties using its supplied tie breaker", () => {
  const values = [capacity("claude", 10), capacity("codex", 10)];
  assert.equal(selectWorkerProvider(values, 5, 0).provider, "claude");
  assert.equal(selectWorkerProvider(values, 5, 1).provider, "codex");
});

test("window consumption uses the largest reset-stable provider-window delta", () => {
  const before: ProviderCapacity = {
    provider: "codex",
    readable: true,
    windows: [
      { name: "5h", usedPercent: 10, resetsAt: 100 },
      { name: "7d", usedPercent: 20, resetsAt: 200 },
    ],
  };
  const after: ProviderCapacity = {
    provider: "codex",
    readable: true,
    windows: [
      { name: "5h", usedPercent: 12.5, resetsAt: 100 },
      { name: "7d", usedPercent: 21, resetsAt: 200 },
    ],
  };
  assert.deepEqual(providerWindowConsumption(before, after), {
    provider: "codex",
    percentConsumed: 2.5,
    windowName: "5h",
    resetsAt: 100,
  });
});

test("window consumption refuses a reset, unreadable source, provider mismatch, or counter regression", () => {
  const before: ProviderCapacity = {
    provider: "claude",
    readable: true,
    windows: [{ name: "5h", usedPercent: 80, resetsAt: "09:00" }],
  };
  assert.equal(
    providerWindowConsumption(before, {
      provider: "claude",
      readable: true,
      windows: [{ name: "5h", usedPercent: 2, resetsAt: "14:00" }],
    }).reason,
    "no-reset-stable-window",
  );
  assert.equal(
    providerWindowConsumption(before, { provider: "claude", readable: false, windows: [], detail: "offline" }).reason,
    "capacity-unreadable",
  );
  assert.equal(providerWindowConsumption(before, capacity("codex", 82)).reason, "provider-mismatch");
  assert.equal(
    providerWindowConsumption(before, {
      provider: "claude",
      readable: true,
      windows: [{ name: "5h", usedPercent: 79, resetsAt: "09:00" }],
    }).reason,
    "counter-regressed",
  );
  assert.equal(
    providerWindowConsumption(
      { ...before, windows: [{ name: "5h", usedPercent: 101, resetsAt: "09:00" }] },
      { ...before, windows: [{ name: "5h", usedPercent: 100, resetsAt: "09:00" }] },
    ).reason,
    "no-reset-stable-window",
    "invalid percentages must not become attribution candidates",
  );
});

test("window attribution refuses overlapping work on the same provider but not another provider", () => {
  clearProviderWindowMeasurements();
  const claudeBefore: ProviderCapacity = {
    provider: "claude",
    readable: true,
    windows: [{ name: "5h", usedPercent: 10, resetsAt: "09:00" }],
  };
  const codexBefore: ProviderCapacity = {
    provider: "codex",
    readable: true,
    windows: [{ name: "5h", usedPercent: 20, resetsAt: 123 }],
  };
  const first = beginProviderWindowMeasurement(claudeBefore);
  const codex = beginProviderWindowMeasurement(codexBefore);
  assert.equal(
    finishProviderWindowMeasurement(codex, {
      provider: "codex",
      readable: true,
      windows: [{ name: "5h", usedPercent: 21, resetsAt: 123 }],
    }).percentConsumed,
    1,
  );
  const second = beginProviderWindowMeasurement(claudeBefore);
  assert.equal(
    finishProviderWindowMeasurement(first, {
      provider: "claude",
      readable: true,
      windows: [{ name: "5h", usedPercent: 12, resetsAt: "09:00" }],
    }).reason,
    "overlapping-provider-work",
  );
  assert.equal(
    finishProviderWindowMeasurement(second, {
      provider: "claude",
      readable: true,
      windows: [{ name: "5h", usedPercent: 12, resetsAt: "09:00" }],
    }).reason,
    "overlapping-provider-work",
  );
});

test("abandoning a window measurement removes it from future overlap accounting", () => {
  clearProviderWindowMeasurements();
  const before: ProviderCapacity = {
    provider: "claude",
    readable: true,
    windows: [{ name: "5h", usedPercent: 10, resetsAt: "09:00" }],
  };
  const abandoned = beginProviderWindowMeasurement(before);
  abandonProviderWindowMeasurement(abandoned);
  const next = beginProviderWindowMeasurement(before);
  assert.equal(
    finishProviderWindowMeasurement(next, {
      provider: "claude",
      readable: true,
      windows: [{ name: "5h", usedPercent: 11, resetsAt: "09:00" }],
    }).percentConsumed,
    1,
  );
});

test("Codex write workers grant only an in-root linked worktree's Git administrative directories", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-git-roots-"));
  const repo = join(root, "repos", "fixture");
  const worktree = join(root, "worktrees", "run-fixture");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "seed"), "seed\n");
  execFileSync("git", ["add", "seed"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"], { cwd: repo });
  mkdirSync(join(root, "worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: repo });

  const roots = codexGitWritableRoots(worktree, root);
  assert.equal(roots.length, 2);
  assert.ok(roots.every((candidate) => candidate.startsWith(realpathSync(root))));
  assert.ok(roots.some((candidate) => candidate.endsWith(join(".git", "worktrees", "run-fixture"))));
  assert.ok(roots.some((candidate) => candidate.endsWith(join("repos", "fixture", ".git"))));
  assert.deepEqual(codexGitWritableRoots(worktree, join(root, "unrelated")), []);

  const nonRepo = join(root, "not-a-repo");
  mkdirSync(nonRepo);
  assert.deepEqual(codexGitWritableRoots(nonRepo, root), []);
});

test("Claude usage maps every reported subscription window", () => {
  const mapped = claudeCapacityFromUsage({
    billingMode: "subscription",
    session: { percentUsed: 12, resetsAt: "soon" },
    weekly: [{ label: "all models", percentUsed: 34 }],
  });
  assert.deepEqual(mapped.windows.map((window) => window.usedPercent), [12, 34]);
});

test("Claude capacity reads, caches, and tears down a control-only SDK session", async () => {
  clearClaudeCapacityCache();
  let opens = 0;
  let returns = 0;
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["claude", "codex"] as Array<"claude" | "codex"> } };
  const first = await readClaudeProviderCapacity(config, {
    now: () => 100,
    openSession: () => {
      opens += 1;
      return {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 20 },
            seven_day: { utilization: 30 },
          },
        }),
        return: async () => {
          returns += 1;
          throw new Error("teardown is best effort");
        },
      };
    },
  });
  const cached = await readClaudeProviderCapacity(config, {
    now: () => 101,
    openSession: () => {
      throw new Error("cache miss");
    },
  });
  assert.equal(first.readable, true);
  assert.deepEqual(first.windows.map((window) => window.usedPercent), [20, 30]);
  assert.deepEqual(cached, first);
  assert.equal(opens, 1);
  assert.equal(returns, 1);

  const refreshed = await readClaudeProviderCapacity(config, {
    now: () => 102,
    forceRefresh: true,
    openSession: () => {
      opens += 1;
      return {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 21 },
            seven_day: { utilization: 31 },
          },
        }),
        return: async () => {
          returns += 1;
        },
      };
    },
  });
  assert.deepEqual(refreshed.windows.map((window) => window.usedPercent), [21, 31]);
  assert.equal(opens, 2, "an attribution boundary must bypass the routing cache");
  assert.equal(returns, 2);
});

test("Claude capacity distinguishes an absent SDK method from a thrown reading", async () => {
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["claude", "codex"] as Array<"claude" | "codex"> } };
  clearClaudeCapacityCache();
  const absent = await readClaudeProviderCapacity(config, {
    openSession: () => ({ return: async () => undefined }),
  });
  assert.equal(absent.readable, false);
  assert.match(absent.detail ?? "", /unreadable/);

  clearClaudeCapacityCache();
  const failed = await readClaudeProviderCapacity(config, {
    openSession: () => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error("usage refused");
      },
      return: async () => undefined,
    }),
  });
  assert.equal(failed.readable, false);
  assert.match(failed.detail ?? "", /usage refused/);
});

test("Codex app-server rate limits map primary and secondary windows", () => {
  const mapped = codexCapacityFromRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 123 },
        secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 456 },
        rateLimitReachedType: null,
        spendControlReached: false,
      },
    },
    accountId: "account-1",
  });
  assert.equal(mapped.readable, true);
  assert.deepEqual(mapped.windows.map((window) => window.usedPercent), [28, 4]);
  assert.equal(mapped.accountLabel, "account-1");
});

test("Codex capacity never turns an absent percentage into zero", () => {
  assert.equal(codexCapacityFromRateLimits(undefined).readable, false);
  assert.deepEqual(codexCapacityFromRateLimits({ rateLimits: { primary: {}, secondary: null } }), {
    provider: "codex",
    readable: false,
    windows: [],
    detail: "no usable rate-limit windows",
  });
});

const visibleCodexModels = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
];

const splitCodexLimits = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 80 } },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 80 } },
    codex_bengalfox: { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 10 } },
  },
};

// A capability ladder fixture (W1-T2573) equivalent, per (capability, effort), to the retired
// hardcoded DEFAULT_CODEX_MODELS table — so tests exercise the new TABLE LOOKUP mechanism while
// keeping the old tier-resolution expectations intact for models these fixture rows cover.
const CAPABILITY_FIXTURE: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 },
  claude: { haiku: "economy", sonnet: "balanced", opus: "frontier", "claude-opus-5": "frontier" },
  codex: {
    economy: {
      low: ["gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
      medium: ["gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
      high: ["gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
    },
    balanced: {
      low: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
      medium: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
      high: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
    },
    frontier: {
      low: ["gpt-5.6-sol", "gpt-5.5"],
      medium: ["gpt-5.6-sol", "gpt-5.5"],
      high: ["gpt-5.6-sol", "gpt-5.5"],
    },
  },
};

type RpcRequest = { id?: number; method?: string };

function fakeAppServer(
  onRequest: (
    request: RpcRequest,
    io: { stdout: PassThrough; stderr: PassThrough; proc: EventEmitter },
  ) => void,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (line) onRequest(JSON.parse(line) as RpcRequest, { stdout, stderr, proc });
    }
  });
  return proc;
}

test("Codex model selector uses independent model headroom for economy mounts", () => {
  const selected = selectCodexModel(
    visibleCodexModels,
    splitCodexLimits,
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] } },
    "haiku",
    "low",
    CAPABILITY_FIXTURE,
  );
  assert.equal(selected.model, "gpt-5.3-codex-spark");
  assert.equal(selected.effort, "low");
  assert.deepEqual(selected.windows.map((window) => window.usedPercent), [10]);
});

test("Codex model selector preserves balanced and frontier quality tiers", () => {
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };
  assert.equal(selectCodexModel(visibleCodexModels, splitCodexLimits, config, "sonnet", "high", CAPABILITY_FIXTURE).model, "gpt-5.6-terra");
  assert.equal(selectCodexModel(visibleCodexModels, splitCodexLimits, config, "claude-opus-5", "high", CAPABILITY_FIXTURE).model, "gpt-5.6-sol");
});

test("Codex model selector resolves a model whose name carries neither 'haiku' nor 'opus' by its DECLARED capability, not a substring guess (W1-T2573)", () => {
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };
  // "sonnet" contains neither "haiku" nor "opus" — the retired substring function silently fell
  // through to "balanced" for it by ACCIDENT (the same fallback every unmatched name got). Here
  // it resolves through the SAME declared capability row, on purpose, via the table.
  assert.equal(selectCodexModel(visibleCodexModels, splitCodexLimits, config, "sonnet", "medium", CAPABILITY_FIXTURE).model, "gpt-5.6-terra");
});

test("Codex model selector: effort changes the resolved candidates when the table declares different rows (W1-T2573)", () => {
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };
  const effortAwareFixture: CapabilityLadder = {
    ...CAPABILITY_FIXTURE,
    codex: {
      ...CAPABILITY_FIXTURE.codex,
      balanced: { low: ["gpt-5.6-terra"], medium: ["gpt-5.6-terra"], high: ["gpt-5.6-sol"] },
    },
  };
  const mediumSelection = selectCodexModel(visibleCodexModels, splitCodexLimits, config, "sonnet", "medium", effortAwareFixture);
  const highSelection = selectCodexModel(visibleCodexModels, splitCodexLimits, config, "sonnet", "high", effortAwareFixture);
  assert.equal(mediumSelection.model, "gpt-5.6-terra");
  assert.equal(highSelection.model, "gpt-5.6-sol");
  assert.notEqual(mediumSelection.model, highSelection.model, "a sonnet/high mount must not resolve the same Codex request as sonnet/medium");
});

test("Codex model override fails closed when the account does not expose it", () => {
  const selected = selectCodexModel(
    visibleCodexModels,
    splitCodexLimits,
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexModel: "not-on-account" } },
  );
  assert.equal(selected.readable, false);
  assert.match(selected.detail ?? "", /not available/);
});

test("Codex capacity RPC discovers models and selects the matching independent bucket", async () => {
  clearCodexCapacityCache();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: string[] = [];
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.method) requests.push(request.method);
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: splitCodexLimits })}\n`);
      if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: visibleCodexModels, nextCursor: null } })}\n`);
    }
  });
  const selected = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    { requestedModel: "haiku", requestedEffort: "low", spawn: () => proc as never, capabilities: CAPABILITY_FIXTURE },
  );
  assert.equal(selected.model, "gpt-5.3-codex-spark");
  assert.deepEqual(requests, ["initialize", "initialized", "account/rateLimits/read", "model/list"]);

  const cached = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    { requestedModel: "haiku", requestedEffort: "low", spawn: () => { throw new Error("cache miss"); }, capabilities: CAPABILITY_FIXTURE },
  );
  assert.equal(cached.model, selected.model);

  const refreshedProc = fakeAppServer((request, { stdout }) => {
    if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: splitCodexLimits })}\n`);
    if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: visibleCodexModels, nextCursor: null } })}\n`);
  });
  const refreshed = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    {
      requestedModel: "haiku",
      requestedEffort: "low",
      forceRefresh: true,
      selectedModel: "gpt-5.6-terra",
      spawn: () => refreshedProc as never,
      capabilities: CAPABILITY_FIXTURE,
    },
  );
  assert.equal(refreshed.model, "gpt-5.6-terra", "an attribution boundary must pin the model selected before the worker ran");
});

test("Codex capacity makes toolchain and synchronous spawn failures unreadable", async () => {
  clearCodexCapacityCache();
  const unresolved = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] } },
    { resolveEnv: { PATH: "" } },
  );
  assert.equal(unresolved.readable, false);
  assert.match(unresolved.detail ?? "", /no codex executable/);

  const absent = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/not/a/codex" } },
  );
  assert.equal(absent.readable, false);
  assert.match(absent.detail ?? "", /not executable/);

  const spawnFailed = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexHome: "/tmp/codex-spawn-fail" } },
    { spawn: () => { throw new Error("spawn refused"); } },
  );
  assert.equal(spawnFailed.readable, false);
  assert.match(spawnFailed.detail ?? "", /spawn refused/);
});

test("Codex capacity fails closed on malformed, exited, errored, and paginated RPC sessions", async () => {
  const config = (home: string) => ({
    claudeBin: "/unused",
    root: "/tmp",
    workerProviders: { enabled: ["codex"] as Array<"codex">, codexBin: "/bin/sh", codexHome: home },
  });
  const run = async (
    home: string,
    handler: Parameters<typeof fakeAppServer>[0],
    timeoutMs = 50,
  ) => {
    clearCodexCapacityCache();
    const proc = fakeAppServer(handler);
    return readCodexCapacity(config(home), { timeoutMs, spawn: () => proc as never });
  };
  const initialize = (request: RpcRequest, stdout: PassThrough) => {
    if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  };

  const rateError = await run("/tmp/codex-rate-error", (request, { stdout }) => {
    initialize(request, stdout);
    if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, error: { message: "rate RPC refused" } })}\n`);
  });
  assert.match(rateError.detail ?? "", /rate RPC refused/);

  const modelError = await run("/tmp/codex-model-error", (request, { stdout }) => {
    initialize(request, stdout);
    if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: splitCodexLimits })}\n`);
    if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, error: { message: "model RPC refused" } })}\n`);
  });
  assert.match(modelError.detail ?? "", /model RPC refused/);

  const paginated = await run("/tmp/codex-paginated", (request, { stdout }) => {
    initialize(request, stdout);
    if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: splitCodexLimits })}\n`);
    if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: [], nextCursor: "more" } })}\n`);
  });
  assert.match(paginated.detail ?? "", /100-model page/);

  const malformed = await run("/tmp/codex-malformed", (request, { stdout }) => {
    if (request.id === 1) stdout.write("not-json\n");
  }, 5);
  assert.match(malformed.detail ?? "", /timed out/);

  const exited = await run("/tmp/codex-exited", (request, { stderr, proc }) => {
    if (request.id === 1) {
      stderr.write("diagnostic tail");
      proc.emit("exit", 7);
    }
  });
  assert.match(exited.detail ?? "", /exited 7: diagnostic tail/);
});

test("Codex capacity accepts model-list-first response ordering", async () => {
  clearCodexCapacityCache();
  let heldRateRequest = false;
  const proc = fakeAppServer((request, { stdout }) => {
    if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (request.id === 2) heldRateRequest = true;
    if (request.id === 3) {
      stdout.write(`${JSON.stringify({ id: 3, result: { data: visibleCodexModels, nextCursor: null } })}\n`);
      if (heldRateRequest) stdout.write(`${JSON.stringify({ id: 2, result: splitCodexLimits })}\n`);
    }
  });
  const selected = await readCodexCapacity(
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexHome: "/tmp/codex-model-first" } },
    { spawn: () => proc as never },
  );
  assert.equal(selected.readable, true);
});

test("Codex JSONL maps thread, final message, and token usage to the worker envelope", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 } }),
  ].join("\n"));
  assert.equal(parsed.sessionId, "thread-1");
  assert.equal(parsed.text, "done");
  assert.deepEqual(parsed.tokens, { input: 100, output: 10, cacheRead: 25, cacheCreation: 0 });
  assert.equal(parsed.isError, false);
});

test("Codex JSONL preserves turn failure as an error verdict", () => {
  const parsed = parseCodexJsonl([
    "not-json",
    JSON.stringify({ type: "turn.failed", error: { message: "rate limit reached" } }),
  ].join("\n"));
  assert.equal(parsed.isError, true);
  assert.match(parsed.errors.join(" "), /unparseable Codex event/);
  assert.match(parsed.errors.join(" "), /rate limit/);
});

test("Codex JSONL normalizes a pinned subscription refusal only from terminal error evidence", () => {
  const message =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.";
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
    JSON.stringify({ type: "error", error: { message } }),
    JSON.stringify({ type: "turn.failed", error: { message } }),
  ].join("\n"), Date.parse("2026-09-01T16:00:00.000Z"));
  assert.equal(parsed.isError, true);
  assert.equal(parsed.subtype, "error_codex");
  assert.equal(parsed.usageRefusal?.matched, "You've hit your usage limit");

  const proseOnly = parseCodexJsonl(
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
  );
  assert.equal(proseOnly.usageRefusal, undefined, "agent prose must never classify the account as refused");
});

test("Codex spawn carries a subscription refusal through the shared ledger seam", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const message =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.";
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-refused" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    stdout.write(`${JSON.stringify({ type: "error", error: { message } })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.failed", error: { message } })}\n`);
    stdout.end();
    queueMicrotask(() => proc.emit("exit", 1));
  });
  const result = await spawnCodexWorker(
    {
      cwd: process.cwd(),
      prompt: "do the task",
      containment: {
        spawn: () => ({ process: proc as never, pid: 42_425 }),
        teardown: () => {},
      },
    },
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
  );
  assert.equal(result.isError, true, "Codex 0.152.0's turn.failed remains an error");
  assert.equal(result.subtype, "error_codex");
  assert.equal(result.usageRefusal?.matched, "You've hit your usage limit");
  assert.equal(workerLedgerFields(result).verdict, "usage_refused");
});

test("spawnWorker routes an opted-in call to Codex, preserves containment, and ledgers the provider", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let prompt = "";
  let tornDown = 0;
  let spawnedArgs: string[] = [];
  let spawnedEnv: Record<string, string | undefined> = {};
  const codexCapacityRequests: Array<{ forceRefresh?: boolean; selectedModel?: string }> = [];
  stdin.on("data", (chunk: Buffer) => {
    prompt += chunk.toString("utf8");
  });
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-thread" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "REPORT\nPR_URL: https://github.com/acme/repo/pull/1" } })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
    stdout.end();
    queueMicrotask(() => proc.emit("exit", 0));
  });
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-route-"));
  const result = await withLiveSpawnAllowed(() =>
    spawnWorker({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      prompt: "do the task",
      env: { SAFE_VALUE: "kept", OPENAI_API_KEY: "removed", ANTHROPIC_API_KEY: "removed" },
      config: {
        claudeBin: "/unused/claude",
        root,
        workerProviders: { enabled: ["claude", "codex"], codexBin: "/bin/sh" },
      },
      providerRouting: {
        readClaude: async () => capacity("claude", 80),
        readCodex: async (_config, request) => {
          codexCapacityRequests.push(request);
          const usedPercent = codexCapacityRequests.length === 3 ? 12 : 10;
          return {
            provider: "codex",
            readable: true,
            windows: [{ name: "codex 7d", usedPercent, resetsAt: 123 }],
            accountLabel: "codex-account",
            model: "gpt-5.6-terra",
            effort: "high",
          };
        },
        tieBreaker: 0,
      },
      containment: {
        spawn: (options) => {
          spawnedArgs = options.args;
          spawnedEnv = options.env;
          return { process: proc as never, pid: 42_424 };
        },
        teardown: (pid) => {
          assert.equal(pid, 42_424);
          tornDown += 1;
        },
      },
    }),
  );
  assert.equal(result.provider, "codex");
  assert.equal(result.accountLabel, "codex-account");
  assert.equal(result.sessionId, "codex-thread");
  assert.equal(result.model, "gpt-5.6-terra");
  assert.deepEqual(spawnedArgs.slice(spawnedArgs.indexOf("--model"), spawnedArgs.indexOf("--model") + 2), ["--model", "gpt-5.6-terra"]);
  assert.ok(spawnedArgs.includes('model_reasoning_effort="high"'));
  assert.equal(spawnedEnv.SAFE_VALUE, "kept");
  assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
  assert.equal(spawnedEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(tornDown, 1);
  assert.match(prompt, /read and follow.*CLAUDE\.md/s);
  assert.equal(workerLedgerFields(result).provider, "codex");
  assert.deepEqual(codexCapacityRequests, [
    { requestedModel: undefined, requestedEffort: undefined },
    { requestedModel: undefined, requestedEffort: undefined, forceRefresh: true, selectedModel: "gpt-5.6-terra" },
    { requestedModel: undefined, requestedEffort: undefined, forceRefresh: true, selectedModel: "gpt-5.6-terra" },
  ]);
  assert.deepEqual(workerLedgerFields(result).window_consumption, {
    provider: "codex",
    percent_consumed: 2,
    window: "codex 7d",
    resets_at: 123,
  });
});

test("the unchanged Claude spawn path labels its successful provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-claude-provider-"));
  const result = await spawnWorker({
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    settingsFile: join(process.cwd(), "settings", "worker.json"),
    prompt: "legacy Claude path",
    config: { claudeBin: "/unused", root },
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
      platform: "linux",
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "claude-session",
        total_cost_usd: 0,
        num_turns: 1,
      };
    })()) as never,
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.text, "done");
  assert.equal(result.windowConsumption, undefined, "Claude-only installs must perform no attribution reads");
});

async function spawnMeasuredClaude(
  readClaude: (request?: { forceRefresh?: boolean }) => Promise<ProviderCapacity>,
) {
  const root = mkdtempSync(join(tmpdir(), "rmd-claude-window-consumption-"));
  return spawnWorker({
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    settingsFile: join(process.cwd(), "settings", "worker.json"),
    prompt: "measure Claude",
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/bin/sh" },
    },
    providerRouting: {
      readClaude,
      readCodex: async () => capacity("codex", 80),
    },
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
      platform: "linux",
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "claude-session",
        total_cost_usd: 0,
        num_turns: 1,
      };
    })()) as never,
  });
}

test("a multi-provider Claude call ledgers reset-stable exclusive window consumption", async () => {
  const claudeRequests: Array<{ forceRefresh?: boolean } | undefined> = [];
  const result = await spawnMeasuredClaude(async (request) => {
    claudeRequests.push(request);
    const usedPercent = claudeRequests.length === 3 ? 11.5 : 10;
    return {
      provider: "claude",
      readable: true,
      windows: [{ name: "session (5h)", usedPercent, resetsAt: "09:00" }],
    };
  });
  assert.deepEqual(claudeRequests, [undefined, { forceRefresh: true }, { forceRefresh: true }]);
  assert.deepEqual(workerLedgerFields(result).window_consumption, {
    provider: "claude",
    percent_consumed: 1.5,
    window: "session (5h)",
    resets_at: "09:00",
  });
});

test("an unreadable opening boundary does not prevent a selected worker from running", async () => {
  clearProviderWindowMeasurements();
  let reads = 0;
  const result = await spawnMeasuredClaude(async () => {
    reads += 1;
    if (reads === 2) throw new Error("opening boundary offline");
    return {
      provider: "claude",
      readable: true,
      windows: [{ name: "session (5h)", usedPercent: 10, resetsAt: "09:00" }],
    };
  });
  assert.equal(reads, 2, "no closing read is possible without an opening measurement");
  assert.equal(result.text, "done");
  assert.equal(result.windowConsumption, undefined);
});

test("an unreadable closing boundary is explicit and releases the provider measurement", async () => {
  clearProviderWindowMeasurements();
  let reads = 0;
  const result = await spawnMeasuredClaude(async () => {
    reads += 1;
    if (reads === 3) throw new Error("closing boundary offline");
    return {
      provider: "claude",
      readable: true,
      windows: [{ name: "session (5h)", usedPercent: 10, resetsAt: "09:00" }],
    };
  });
  assert.equal(reads, 3);
  assert.deepEqual(workerLedgerFields(result).window_consumption, {
    provider: "claude",
    percent_consumed: null,
    reason: "capacity-unreadable",
  });

  const next = beginProviderWindowMeasurement({
    provider: "claude",
    readable: true,
    windows: [{ name: "session (5h)", usedPercent: 10, resetsAt: "09:00" }],
  });
  assert.equal(
    finishProviderWindowMeasurement(next, {
      provider: "claude",
      readable: true,
      windows: [{ name: "session (5h)", usedPercent: 11, resetsAt: "09:00" }],
    }).percentConsumed,
    1,
    "failed closing telemetry must not poison later attribution",
  );
});

test("Codex worker clock bound tears down the contained process and fails the run", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let teardownCalls = 0;
  let exited = false;
  await assert.rejects(
    spawnCodexWorker(
      {
        cwd: process.cwd(),
        prompt: "wait forever",
        clockBound: { boundMs: 1 },
        containment: {
          spawn: () => ({ process: proc as never, pid: 9_001 }),
          teardown: (pid) => {
            assert.equal(pid, 9_001);
            teardownCalls += 1;
            if (!exited) {
              exited = true;
              proc.emit("exit", null);
            }
          },
        },
      },
      { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    ),
    /exceeded the 1ms clock bound/,
  );
  assert.ok(teardownCalls >= 1);
});
