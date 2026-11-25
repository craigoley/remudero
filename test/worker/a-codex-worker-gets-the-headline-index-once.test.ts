import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config, WorkerProviderId } from "#src/lib/config.js";
import type { Task } from "#src/lib/plan.js";
import { renderImplementPromptWithParts, withProviderRuleHeadlines } from "#src/lib/prompt-render.js";
import { createClaudeExecutableCache, spawnWorker, workerContinuation, type SpawnWorkerArgs,
  type WorkerResult } from "#src/lib/worker.js";
import { withWorkspaceCleanup } from "#src/lib/workspace-cleanup-contract.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const task: Task = {
  id: "W1-T13768-FIXTURE", title: "implement a fixture", repo: "remudero", depends_on: [],
  type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0,
  files: ["src/x.ts"],
  acceptance: [{ claim: "a claim", proof: "unit test: a claim" }],
};
/** Stands in for the built headline index. The dispatch's `spawn` (run-task-verb.ts) hands every spawn
 *  to `withProviderRuleHeadlines` with the part it built; importing src/run-task.ts here would raise the
 *  affected-suite reach ceiling, so this drives that same wrapper through the real router instead. */
const HEADLINE_PART = "- CLAUDE.md's rule headlines (progressive disclosure) — headlines only\n    Always keep the fixture headline first.";
const FULL = renderImplementPromptWithParts(task, "", "RUN", "", "", HEADLINE_PART).prompt;
const WITHOUT = renderImplementPromptWithParts(task, "", "RUN").prompt;
const PENDING = "Finish the work from before.";

/** The REAL router, with only the capacity readers and the two provider adapters replaced. */
function router(t: TestContext, selected: "claude" | "codex") {
  const root = ownedFixtureDir(t, "rule-headlines-route").dir;
  const now = Date.now();
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex"] } };
  const sent: Array<{ provider: WorkerProviderId; prompt: string }> = [];
  const result = (provider: WorkerProviderId): WorkerResult => ({ provider, sessionId: "fixture-session",
    text: "done", blocks: [], stderr: "", isError: false, apiError: false, subtype: "success",
    costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false });
  const args: SpawnWorkerArgs = {
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config, model: "haiku", effort: "low", tools: ["Read", "Write", "Edit", "Bash"], prompt: FULL,
    egress: { mode: "off" },
    providerRouting: {
      now: () => now, draw: 0, writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: now }),
      readClaude: async () => ({ provider: "claude", readable: true,
        windows: [{ name: "fixture", usedPercent: selected === "claude" ? 0 : 100 }] }),
      readCodex: async () => ({ provider: "codex", readable: true, model: "gpt-6.1-sol", effort: "low",
        windows: [{ name: "fixture", usedPercent: selected === "codex" ? 0 : 100 }] }),
      spawnCodex: async a => { sent.push({ provider: "codex", prompt: a.prompt }); return result("codex"); },
    },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: now + 3_600_000 },
    }) },
    queryFn: ((a: { prompt: string }) => {
      sent.push({ provider: "claude", prompt: a.prompt });
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done",
          session_id: "fixture-session", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as SpawnWorkerArgs["queryFn"],
  };
  return { root, args, sent };
}

/** One routed spawn built the way the dispatch builds it; returns what the selected adapter was sent. */
async function send(t: TestContext, selected: "claude" | "codex", over: (root: string) => Partial<SpawnWorkerArgs> = () => ({})) {
  const r = router(t, selected);
  await spawnWorker(withProviderRuleHeadlines({ ...r.args, ...over(r.root) }, HEADLINE_PART));
  assert.deepEqual(r.sent.map((s) => s.provider), [selected]);
  return { root: r.root, prompt: r.sent[0]!.prompt };
}

/** A resumed round whose handoff quotes the first prompt, from a writer on `from`. */
const resumed = (from: WorkerProviderId) => (root: string): Partial<SpawnWorkerArgs> => ({
  prompt: PENDING, resumeSessionId: "earlier-session",
  continuation: workerContinuation({ provider: from, text: "earlier report", blocks: [] }, FULL, root),
});
const handoffOf = (taskPrompt: string, from: WorkerProviderId, root: string) => withWorkspaceCleanup(
  `${workerContinuation({ provider: from, text: "earlier report", blocks: [] }, taskPrompt, root).contextPrompt}` +
    `\n\nPending action:\n${PENDING}`);

test("W1-T13768 criterion 1: a Codex-routed prompt carries no rule_headlines part", async (t) => {
  assert.ok(FULL.includes(HEADLINE_PART), "control: the unrouted prompt carries the part");
  // The auction resolves an unpinned mount to Codex.
  assert.equal((await send(t, "codex")).prompt, withWorkspaceCleanup(WITHOUT));
  // A mount pinned to Codex.
  assert.equal((await send(t, "codex", () => ({ mountProvider: "codex" }))).prompt, withWorkspaceCleanup(WITHOUT));
  // A diagnose-informed retry: the same prompt with findings appended.
  const retry = await send(t, "codex", () => ({ prompt: `${FULL}\n\n## DIAGNOSE FINDINGS\nfixture` }));
  assert.equal(retry.prompt, withWorkspaceCleanup(`${WITHOUT}\n\n## DIAGNOSE FINDINGS\nfixture`));
  // A fresh-session handoff that quotes the first prompt, from either writer.
  for (const from of ["codex", "claude"] as const) {
    const handoff = await send(t, "codex", resumed(from));
    assert.equal(handoff.prompt, handoffOf(WITHOUT, from, handoff.root));
  }
});

test("W1-T13768 criterion 2: a Claude-routed prompt keeps the rule_headlines part, byte-identical", async (t) => {
  assert.equal((await send(t, "claude")).prompt, withWorkspaceCleanup(FULL));
  assert.equal((await send(t, "claude", () => ({ mountProvider: "claude" }))).prompt, withWorkspaceCleanup(FULL));
  const handoff = await send(t, "claude", resumed("codex"));
  assert.equal(handoff.prompt, handoffOf(FULL, "codex", handoff.root));
});

test("W1-T13768: routing leaves the caller's spawn alone, and a spawn without the part is returned as given", (t) => {
  const { root, args } = router(t, "codex");
  const given = { ...args, ...resumed("codex")(root) };
  const before = given.continuation!.contextPrompt;
  const routed = withProviderRuleHeadlines(given, HEADLINE_PART);
  routed.promptFor!({ provider: "codex", harnessOwnsGit: true });
  assert.equal(given.continuation!.contextPrompt, before);
  routed.promptFor!({ provider: "claude", harnessOwnsGit: false });
  assert.equal(routed.continuation!.contextPrompt, before, "a later Claude route gets the headlines back");
  // A prompt the caller already builds per route is gated too.
  const composed = withProviderRuleHeadlines({ ...args, promptFor: ({ provider }) => `${provider}\n${HEADLINE_PART}` }, HEADLINE_PART);
  assert.equal(composed.promptFor!({ provider: "codex", harnessOwnsGit: true }), "codex");
  // Recon, diagnose and a disabled row carry no part, so nothing about their spawn changes.
  const other = { ...args, prompt: "recon prompt" };
  assert.equal(withProviderRuleHeadlines(other, HEADLINE_PART), other);
  assert.equal(withProviderRuleHeadlines(args, ""), args);
});
