import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalWorkerProviderId, type Config, type WorkerProviderId } from "#src/lib/config.js";
import { OpenWeightRequestTooLargeError, openWeightAllowancePath, openWeightReservationUsd } from "#src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, workerContinuation, workerExecutionForProvider,
  workerLedgerFields, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const prior = (provider?: WorkerProviderId) => ({ provider, text: "The edits are saved; the pre-open gate needs repair.", blocks: [] });
const task = "Task: repair the widget. Only edit src/widget.ts. OUTPUT: the harness commits; no git or gh.";
const action = "The pre-open typecheck failed. Repair it without weakening the check.";

function fixture(t: TestContext, provider: WorkerProviderId | undefined, selected: "claude" | "codex" | "cash" = "claude") {
  const root = ownedFixtureDir(t, "provider-continuation").dir;
  const now = Date.now();
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true,
      cashEndpoint: "https://foundry.example.test/" } };
  const allowance = openWeightAllowancePath(config);
  mkdirSync(dirname(allowance), { recursive: true });
  writeFileSync(allowance, JSON.stringify({ utcDay: new Date(now).toISOString().slice(0, 10), reservations: {} }));
  const captured: Array<{ prompt: string; resume?: string }> = [];
  const result = (p: WorkerProviderId): WorkerResult => ({ provider: p, sessionId: "new-session",
    text: "done", blocks: [], stderr: "", isError: false, apiError: false, subtype: "success",
    costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false });
  const args: SpawnWorkerArgs = {
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config, model: "haiku", effort: "low", tools: ["Read", "Write", "Edit"],
    mountProvider: selected, prompt: action, resumeSessionId: "original-session",
    continuation: workerContinuation(prior(provider), task, root),
    providerRouting: {
      now: () => now, writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: now }),
      readClaude: async () => ({ provider: "claude", readable: false, windows: [], detail: "fixture blocked" }),
      readCodex: async () => ({ provider: "codex", readable: false, windows: [], detail: "fixture blocked" }),
      spawnCodex: async a => { captured.push({ prompt: a.prompt, resume: a.resumeSessionId }); return result("codex"); },
      spawnOpenWeight: async a => { captured.push({ prompt: a.prompt, resume: a.resumeSessionId }); return result("cash"); },
    },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: now + 3_600_000 },
    }) },
    queryFn: ((a: { prompt: string; options: { resume?: string } }) => {
      captured.push({ prompt: a.prompt, resume: a.options.resume });
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done",
          session_id: "new-session", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as SpawnWorkerArgs["queryFn"],
  };
  return { root, now, config, args, captured };
}

test("a continuation never resumes another provider session", async t => {
  for (const source of ["codex", "cash", "openweight", undefined] as const) {
    const f = fixture(t, source);
    const result = await spawnWorker(f.args);
    assert.equal(f.captured.length, 1);
    assert.equal(f.captured[0].resume, undefined);
    assert.equal(result.continuation?.mode, "fresh-handoff");
    assert.equal(result.continuation?.from, source === undefined ? undefined : canonicalWorkerProviderId(source));
    assert.equal(result.continuation?.reason, source === undefined ? "origin-unavailable" : "provider-changed");
    assert.equal(workerLedgerFields(result).continuation?.to, "claude");
    assert.doesNotMatch(JSON.stringify(workerLedgerFields(result).continuation), /original-session|Task:|pre-open/);
  }
  const own = fixture(t, "claude");
  const result = await spawnWorker(own.args);
  assert.equal(own.captured[0].resume, "original-session");
  assert.ok(own.captured[0].prompt.startsWith(action));
  assert.equal(own.captured[0].prompt.includes(task), false, "a real resume does not duplicate original context");
  assert.equal(result.continuation?.mode, "resumed");
});

test("a routed fresh continuation carries its task and pending action", async t => {
  const f = fixture(t, "codex");
  await spawnWorker(f.args);
  assert.ok(f.captured[0].prompt.includes(task));
  assert.ok(f.captured[0].prompt.includes(action));
  assert.ok(f.captured[0].prompt.includes(f.root));
  assert.match(f.captured[0].prompt, /edits are saved/);
  assert.ok(f.captured[0].prompt.startsWith(workerExecutionForProvider(f.args, "claude").prompt));
  assert.equal(f.captured[0].prompt.indexOf(task), f.captured[0].prompt.lastIndexOf(task));
  const missing = fixture(t, undefined);
  delete missing.args.continuation;
  await assert.rejects(() => spawnWorker(missing.args), /self-contained fresh handoff/);
  assert.equal(missing.captured.length, 0, "missing provenance and context cannot spend a call");
});

test("same-provider Codex writers get fresh context but read-only continuations still resume", async t => {
  const writer = fixture(t, "codex", "codex");
  const result = await spawnWorker(writer.args);
  assert.equal(writer.captured[0].resume, undefined);
  assert.ok(writer.captured[0].prompt.includes(task));
  assert.equal(result.continuation?.reason, "provider-fresh-only");
  const reader = fixture(t, "codex", "codex");
  reader.args.tools = ["Read", "Grep", "Glob", "Bash"];
  await spawnWorker(reader.args);
  assert.equal(reader.captured[0].resume, "original-session");
  assert.ok(reader.captured[0].prompt.startsWith(action));
  assert.equal(reader.captured[0].prompt.includes(task), false);
  const foreign = fixture(t, "claude", "codex");
  await spawnWorker(foreign.args);
  assert.equal(foreign.captured[0].resume, undefined);
  assert.ok(foreign.captured[0].prompt.includes(task));
  const disposable = fixture(t, "codex", "codex");
  disposable.args.tools = ["Read"];
  disposable.args.sandboxIntent = "disposable-review";
  await spawnWorker(disposable.args);
  assert.equal(disposable.captured[0].resume, undefined);
});

test("continuation sizing accounts for the selected provider prompt", async t => {
  const f = fixture(t, "claude", "cash");
  f.args.tools = [];
  f.args.routingTrial = { id: "fixture-only", arm: "cash", reason: "fixture model", models: ["gpt-6-luna"] };
  f.args.continuation = workerContinuation(prior("claude"), task + "x".repeat(300_000), f.root);
  const execution = workerExecutionForProvider(f.args, "cash").prompt;
  const shortWant = openWeightReservationUsd("gpt-6-luna", Buffer.byteLength(action));
  const longWant = openWeightReservationUsd("gpt-6-luna", Buffer.byteLength(execution));
  assert.ok(longWant > shortWant);
  f.config.dailyCapUsd = (shortWant + longWant) / 2;
  delete f.args.mountProvider; // both subscriptions blocked: exercise the real fallback's allowance read
  await assert.rejects(() => spawnWorker(f.args), /cash daily allowance exhausted/);
  assert.equal(f.captured.length, 0, "a fitting short follow-up must not hide the handoff's real cost");

  const roomy = fixture(t, "claude", "cash");
  roomy.args.tools = [];
  roomy.args.continuation = workerContinuation(prior("claude"), task, roomy.root);
  await spawnWorker(roomy.args);
  assert.equal(roomy.captured[0].resume, undefined);
  assert.ok(roomy.captured[0].prompt.includes(task));
  const oversized = fixture(t, "claude", "cash");
  oversized.args.tools = [];
  oversized.args.routingTrial = { id: "fixture-only", arm: "cash", reason: "fixture model", models: ["gpt-6-luna"] };
  oversized.args.continuation = workerContinuation(prior("claude"), task + "x".repeat(4_000_000), oversized.root);
  await assert.rejects(() => spawnWorker(oversized.args), OpenWeightRequestTooLargeError);
  assert.equal(oversized.captured.length, 0, "the final handoff must fit before any transport");
});

test("ordinary spawns and bounded prior-report handoffs keep their own contracts", () => {
  assert.deepEqual(workerExecutionForProvider({ prompt: "ordinary" }, "claude"), { prompt: "ordinary" });
  const c = workerContinuation({ provider: "claude", text: "x".repeat(8000) + "tail", blocks: [] }, task, "/fixture");
  assert.ok(c.contextPrompt.length < task.length + 4500);
  assert.ok(c.contextPrompt.includes("tail"));
  const noSession = workerExecutionForProvider({ prompt: action, continuation: c }, "claude");
  assert.equal(noSession.receipt?.reason, "session-unavailable");
  const cash = workerExecutionForProvider({ prompt: action, resumeSessionId: "cash-id", continuation: { ...c, provider: "openweight" } }, "cash");
  assert.equal(cash.resumeSessionId, undefined);
  assert.equal(cash.receipt?.reason, "provider-fresh-only");
});
