import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import {
  FOUNDRY_CLAUDE_PRICES,
  openWeightUsageUsd,
  reserveOpenWeightBudget,
  spawnOpenWeightWorker,
  type OpenWeightModelSelection,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// W1-T4785: a balanced task squeezed off BOTH subscriptions runs on Foundry Sonnet 5.5 through the
// Opus emergency's /anthropic adapter and shared Claude cap, with the Luna ladder kept as fallback.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const ISO = "2026-09-29T12:00:00.000Z";
const FOUNDRY_ENV = {
  RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic",
  RMD_OPENWEIGHT_API_KEY: "test-only-cash-key",
};

const exhausted = (provider: "claude" | "codex"): ProviderCapacity => ({
  provider, readable: false, windows: [], detail: "exhausted",
});
const nearlyFull = (provider: "claude" | "codex"): ProviderCapacity => ({
  provider, readable: true, windows: [{ name: `${provider} weekly`, usedPercent: 99, resetsAt: NOW / 1000 + 3600 }],
});

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

function cashConfig(root: string): Config {
  return {
    root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
    workerProviders: {
      enabled: ["claude", "codex", "cash"], codexBin: "/unused/codex", reservePercent: 5,
      capacityCacheMs: 60_000, cashFallbackWhenBlocked: true, cashEndpoint: "https://openai.example.test/",
    },
  } as unknown as Config;
}

async function spawnBlocked(
  root: string,
  runCash: (args: SpawnWorkerArgs, config: Config, selection: OpenWeightModelSelection) => Promise<WorkerResult>,
  over: Partial<SpawnWorkerArgs> = {},
) {
  const assignments: WorkerSelectionAssignment[] = [];
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    model: "sonnet",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "RunCheck"],
    env: FOUNDRY_ENV,
    config: cashConfig(root),
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => nearlyFull("claude"),
      readCodex: async () => exhausted("codex"),
      spawnOpenWeight: runCash as never,
      writeStatus: () => {},
      now: () => NOW,
    },
    onSelectionAssignment: (assignment: WorkerSelectionAssignment) => assignments.push(assignment),
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
    ...over,
  } as SpawnWorkerArgs).catch((error: unknown) => error);
  return assignments;
}

const ok = (text: string): WorkerResult =>
  ({ provider: "cash", text, isError: false, subtype: "success", budgetReservedUsd: 0.1, budgetSettledUsd: 0.01 }) as unknown as WorkerResult;

function sonnetReply(input = 100, output = 20): Response {
  return new Response(JSON.stringify({
    id: "msg-sonnet", model: "claude-sonnet-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: "Balanced work done." }],
    usage: { input_tokens: input, output_tokens: output },
  }), { status: 200 });
}

test("W1-T4785: a squeezed balanced task runs on Foundry Sonnet 5.5", async () => {
  const root = fixtureRoot("rmd-sonnet-squeeze-");
  try {
    const selections: string[] = [];
    const assignments = await spawnBlocked(root, async (_args, _config, selection) => {
      selections.push(selection.model);
      assert.equal(_args.cashSqueezed, true, "only a squeeze may select Foundry Sonnet");
      return ok("sonnet ran");
    });
    assert.deepEqual(selections, ["claude-sonnet-5-5"]);
    const decision = assignments.at(-1)?.routing.decision;
    assert.equal(decision?.rule, "cash-sonnet-fallback");
    assert.equal(decision?.capability, "balanced");

    // The adapter itself: same /anthropic URL, its own $2/$10 row, refuses a non-squeeze call.
    const f = fixtureRoot("rmd-sonnet-adapter-");
    try {
      let sent = 0;
      const call = (cashSqueezed: boolean) => spawnOpenWeightWorker({
        cwd: f, workerHome: join(f, "home"), prompt: "Do the work", cashSqueezed, env: FOUNDRY_ENV, clock: fixedClock(NOW),
        fetchImpl: async (url, init) => {
          sent++;
          assert.equal(String(url), "https://foundry.example.test/anthropic/v1/messages");
          assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "claude-sonnet-5-5");
          return sonnetReply();
        },
      }, cashConfig(f), { model: "claude-sonnet-5-5", effort: "medium" });
      const refused = await call(false);
      assert.equal(refused.isError, true);
      assert.equal(sent, 0);
      const served = await call(true);
      assert.equal(served.isError, false, served.text);
      assert.equal(served.costUsd, (100 * 2 + 20 * 10) / 1_000_000);
      assert.equal(openWeightUsageUsd("claude-sonnet-5-5", 100, 20), served.costUsd);
      assert.equal(FOUNDRY_CLAUDE_PRICES["claude-sonnet-5-5"]?.inputUsdPerMillion, 2);
      assert.equal(FOUNDRY_CLAUDE_PRICES["claude-sonnet-5-5"]?.outputUsdPerMillion, 10);
    } finally { rmSync(f, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4785: an exhausted Foundry Claude cap falls back to the Luna cash ladder", async () => {
  const root = fixtureRoot("rmd-sonnet-cap-");
  try {
    const config = cashConfig(root);
    // Fill the shared Foundry Claude squeeze cap ($10) with Opus reservations.
    for (let i = 0; i < 1000; i++) {
      try {
        reserveOpenWeightBudget(config, { requestId: `pre-${i}`, deployment: "claude-opus-5-5", requestBodyBytes: 10, atIso: ISO, squeezed: true });
      } catch { break; }
    }
    const ladder: string[] = [];
    let anthropicRequests = 0;
    const assignments = await spawnBlocked(root, async (args, _config, selection) => {
      ladder.push(selection.model);
      return spawnOpenWeightWorker({
        ...args, clock: fixedClock(NOW),
        fetchImpl: async (url: unknown) => {
          if (String(url).includes("/anthropic")) { anthropicRequests++; return sonnetReply(); }
          return new Response(JSON.stringify({
            id: "chat-1", choices: [{ message: { content: "luna carried it" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          }), { status: 200 });
        },
      } as never, config, selection);
    }, { config });
    assert.equal(ladder[0], "claude-sonnet-5-5", "Sonnet is tried first");
    assert.equal(anthropicRequests, 0, "a refused cap must stop before the paid request");
    assert.ok(ladder.length >= 2, `the task must not be held: ${ladder.join(",")}`);
    assert.ok(!ladder[1]!.startsWith("claude-"), `the fallback is the cash ladder, got ${ladder[1]}`);
    assert.equal(assignments.at(-1)?.routing.decision?.rule, "cash-fallback");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4785: an absent Foundry endpoint never diverts to Sonnet and a non-balanced task never does", async () => {
  const root = fixtureRoot("rmd-sonnet-gate-");
  try {
    const noKey: string[] = [];
    const a = await spawnBlocked(root, async (_args, _config, selection) => { noKey.push(selection.model); return ok("x"); },
      { env: { RMD_OPENWEIGHT_API_KEY: "k" } });
    assert.ok(noKey.length === 1 && !noKey[0]!.startsWith("claude-"), noKey.join(","));
    assert.equal(a.at(-1)?.routing.decision?.rule, "cash-fallback");

    const haiku: string[] = [];
    await spawnBlocked(root, async (_args, _config, selection) => { haiku.push(selection.model); return ok("x"); }, { model: "haiku" });
    assert.ok(haiku.every((model) => !model.startsWith("claude-")), haiku.join(","));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4785: Opus and Sonnet reservations share one Foundry Claude daily cap", () => {
  const root = fixtureRoot("rmd-sonnet-shared-");
  try {
    const config = cashConfig(root);
    const reserve = (id: string, deployment: string, squeezed = false) =>
      reserveOpenWeightBudget(config, { requestId: id, deployment, requestBodyBytes: 10, atIso: ISO, squeezed });
    // 30 Opus reservations ($0.16008 each) commit $4.80 of the $5 ordinary Foundry Claude cap.
    for (let i = 0; i < 30; i++) reserve(`opus-${i}`, "claude-opus-5-5");
    // Sonnet reserves $0.08004: two fit under the remaining $0.20, the third breaches the SHARED $5 cap.
    let sonnetAdmitted = 0;
    assert.throws(() => {
      for (let i = 0; i < 10; i++) { reserve(`sonnet-${i}`, "claude-sonnet-5-5"); sonnetAdmitted++; }
    }, /\$5\.00 dailyCapUsd/);
    assert.equal(sonnetAdmitted, 2);
    // And the other direction: Sonnet's reservations count against Opus.
    assert.throws(() => reserve("opus-over", "claude-opus-5-5"), /\$5\.00 dailyCapUsd/);
    // The squeeze keeps its own, larger $10 ceiling for both deployments.
    reserve("sonnet-squeezed", "claude-sonnet-5-5", true);
    reserve("opus-squeezed", "claude-opus-5-5", true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
