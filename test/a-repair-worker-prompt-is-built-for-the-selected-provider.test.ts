import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config, WorkerProviderId } from "#src/lib/config.js";
import type { AlertLaneAlert } from "#src/lib/alert-lane.js";
import type { MainRepairFixRequest } from "#src/lib/main-health-rung.js";
import { alertTaskId } from "#src/lib/ops.js";
import { openWeightAllowancePath, OpenWeightRequestTooLargeError } from "#src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs,
  type WorkerResult, type WorkerSelectionAssignment } from "#src/lib/worker.js";
import { withWorkspaceCleanup } from "#src/lib/workspace-cleanup-contract.js";
import { alertFixPrompt, dispatchAlertFixRun, dispatchMainRepairFixRun,
  mainRepairFixPrompt, type AlertFixDispatchDeps } from "#src/run-task.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const alert: AlertLaneAlert = { source: "code-scanning", id: "9705", severity: "medium",
  state: "open", createdAt: "2026-10-15T00:00:00Z", summary: "fixture repair",
  url: "https://github.com/fixture/repair/security/code-scanning/9705" };
const request: MainRepairFixRequest = { branch: "main", headSha: "a".repeat(40),
  offendingSha: "b".repeat(40), diffStat: "src/widget.ts | +1 -1", failingChecks: ["ci"],
  failingTestTitles: ["fixture red"], testFiles: ["test/widget.test.ts"],
  logExcerpt: "not ok 1 - fixture red", reason: "fixture check failed" };

function fixture(t: TestContext, selected: "claude" | "codex" | "cash") {
  const root = ownedFixtureDir(t, "repair-prompt").dir;
  const now = Date.now();
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true,
      cashEndpoint: "https://foundry.example.test/" } };
  const allowance = openWeightAllowancePath(config);
  mkdirSync(dirname(allowance), { recursive: true });
  writeFileSync(allowance, JSON.stringify({ utcDay: new Date(now).toISOString().slice(0, 10), reservations: {} }));
  const captured: Array<{ provider: WorkerProviderId; prompt: string }> = [];
  const assignments: WorkerSelectionAssignment[] = [];
  const result = (provider: WorkerProviderId): WorkerResult => ({ provider, sessionId: "fixture-session",
    text: "done", blocks: [], stderr: "", isError: false, apiError: false, subtype: "success",
    costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false });
  const args: SpawnWorkerArgs = {
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config, model: "haiku", effort: "low", tools: ["Read", "Write", "Edit", "Bash"], prompt: "original prompt",
    egress: { mode: "off" }, onSelectionAssignment: a => assignments.push(a),
    providerRouting: {
      now: () => now, draw: 0, writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: now }),
      readClaude: async () => ({ provider: "claude", readable: true,
        windows: [{ name: "fixture", usedPercent: selected === "claude" ? 0 : 100 }] }),
      readCodex: async () => ({ provider: "codex", readable: true, model: "gpt-6.1-sol", effort: "low",
        windows: [{ name: "fixture", usedPercent: selected === "codex" ? 0 : 100 }] }),
      spawnCodex: async a => { captured.push({ provider: "codex", prompt: a.prompt }); return result("codex"); },
      spawnOpenWeight: async a => { captured.push({ provider: "cash", prompt: a.prompt }); return result("cash"); },
    },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: now + 3_600_000 },
    }) },
    queryFn: ((a: { prompt: string }) => {
      captured.push({ provider: "claude", prompt: a.prompt });
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done",
          session_id: "fixture-session", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as SpawnWorkerArgs["queryFn"],
  };
  const spawnArgs: SpawnWorkerArgs[] = [];
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: (_repo, path) => { mkdirSync(path, { recursive: true }); }, worktreeRemove: () => {},
    renderWorkerSettings: () => args.settingsFile, loadMounts: () => ({}) as never,
    resolveMount: () => ({ model: "haiku", effort: "low", maxTurns: 5, contextBudget: 1000 }),
    spawn: async a => {
      spawnArgs.push(a);
      return spawnWorker({ ...args, ...a, providerRouting: args.providerRouting });
    },
    ensureTaskTrailer: () => {}, checkAcceptance: () => ({ ok: true }) as never,
    readPrBody: () => "", fetch: (() => { throw new Error("unexpected PR open"); }) as never,
    readDiff: () => "", readHeadSubject: () => "fix(widget): repair fixture",
    pushBranch: async () => { throw new Error("unexpected push"); }, readRemoteBranchHead: async () => undefined,
  };
  return { root, config, args, captured, assignments, spawnArgs, deps };
}

async function repairLanes(t: TestContext, provider: "claude" | "codex") {
  const f = fixture(t, provider);
  const ledger = join(f.root, "ledger.ndjson");
  await dispatchMainRepairFixRun("fixture", "repair", f.config, request, ledger, "main-fixture", f.deps);
  await dispatchAlertFixRun("fixture", "repair", f.config, alert, ledger, "alert-fixture", f.deps);
  assert.equal(f.captured.length, 2, "both dispatchers reached the selected adapter");
  assert.deepEqual(f.captured.map(c => c.provider), [provider, provider]);
  return f;
}

test("W1-T9705: a codex-selected repair worker is prompted that the harness owns git", async t => {
  const f = await repairLanes(t, "codex");
  for (const [i, c] of f.captured.entries()) {
    assert.doesNotMatch(c.prompt, /git push|gh pr create|PR_URL:/);
    assert.match(c.prompt, /COMMIT_MESSAGE:/);
    assert.match(c.prompt, /run NO git or gh command/);
    assert.equal(typeof f.spawnArgs[i].promptFor, "function");
    assert.equal(f.assignments[i].harness_owns_git, true);
  }
});

test("W1-T9705: a claude-selected repair worker keeps the push-and-open prompt", async t => {
  const f = await repairLanes(t, "claude");
  const bodyFile = /THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: (\S+)/.exec(f.captured[0].prompt)![1];
  assert.equal(f.captured[0].prompt, withWorkspaceCleanup(mainRepairFixPrompt(request, bodyFile)));
  assert.equal(f.captured[1].prompt, withWorkspaceCleanup(alertFixPrompt(alert, alertTaskId(alert))));
  for (const [i, c] of f.captured.entries()) {
    assert.match(c.prompt, /git push/);
    assert.match(c.prompt, /gh pr create/);
    assert.equal(typeof f.spawnArgs[i].promptFor, "function");
    assert.equal(f.assignments[i].harness_owns_git, false);
  }
});

test("W1-T9705: a spawn without promptFor passes its prompt through on every provider", async t => {
  for (const provider of ["claude", "codex", "cash", "openweight"] as const) {
    const f = fixture(t, provider === "openweight" ? "cash" : provider);
    f.args.mountProvider = provider;
    f.args.tools = ["Read", "Write", "Edit"];
    await spawnWorker(f.args);
    assert.deepEqual(f.captured, [{ provider: provider === "openweight" ? "cash" : provider,
      prompt: withWorkspaceCleanup(f.args.prompt) }]);
    assert.equal(Object.hasOwn(f.assignments[0], "harness_owns_git"), false);
  }
});

test("a routed prompt is built once for affinity and cash divert using the adapter's git ownership", async t => {
  for (const scenario of [
    { provider: "claude", tools: ["Read", "Write"], owned: true },
    { provider: "codex", tools: ["Read", "Write", "Bash"], owned: true },
    { provider: "codex", tools: ["Read", "Write"], owned: false },
    { provider: "codex", tools: ["Read"], intent: "disposable-review", owned: false },
    { provider: "openweight", tools: ["Read", "Write"], owned: true },
    { provider: undefined, tools: ["Read", "Write", "Bash"], cashTools: ["Read", "Write"], owned: true },
  ] as const) {
    const f = fixture(t, "cash");
    f.args.mountProvider = scenario.provider;
    f.args.tools = [...scenario.tools];
    if ("intent" in scenario) f.args.sandboxIntent = scenario.intent;
    if ("cashTools" in scenario) f.args.cashTools = scenario.cashTools;
    const calls: unknown[] = [];
    f.args.promptFor = route => { calls.push(route); return `selected ${route.provider} owns git ${route.harnessOwnsGit}`; };
    await spawnWorker(f.args);
    const provider = scenario.provider === "openweight" || scenario.provider === undefined ? "cash" : scenario.provider;
    assert.deepEqual(calls, [{ provider, harnessOwnsGit: scenario.owned }]);
    assert.equal(f.assignments[0].harness_owns_git, scenario.owned);
    assert.equal(f.captured[0].prompt, withWorkspaceCleanup(`selected ${provider} owns git ${scenario.owned}`));
  }
});

test("cash admission measures the rebuilt prompt before transport", async t => {
  for (const divert of [false, true]) {
    const f = fixture(t, "cash");
    f.args.mountProvider = divert ? undefined : "cash";
    f.args.tools = [];
    f.args.routingTrial = { id: "fixture-only", arm: "cash", reason: "fixture model", models: ["gpt-6-luna"] };
    f.args.promptFor = () => "x".repeat(4_000_000);
    await assert.rejects(() => spawnWorker(f.args), OpenWeightRequestTooLargeError);
    assert.deepEqual(f.captured, [], "a short original prompt cannot admit an oversized rebuilt prompt");
  }
});
