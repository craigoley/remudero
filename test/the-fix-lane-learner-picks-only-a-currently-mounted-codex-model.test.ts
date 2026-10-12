import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fixArmEvidence, fixRoutingWeights, type FixLearnedArms } from "../src/lib/fix-routing-learner.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// W1-T6360: the fix-lane learner re-read Codex for ANY historical selected_model whose draw won, so after the
// 2026-10-02 Sol 6.1 switch it kept routing the lane back to gpt-6-sol (W1-T6028 measured gpt-6-sol at 0.53 and
// gpt-6.1-sol at 0.39 here). The operator ruled 2026-10-08 to use Sol 6.1 everywhere: the learner's candidate arms
// are now only the models the lane's CURRENT capability row mounts.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-08T12:00:00.000Z");

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

/** `accepted` clean and `refused` commit_refused fix rounds for one Codex arm: an acceptance rate of accepted / total. */
function codexArm(model: string, accepted: number, refused: number) {
  const row = (subtype: string) => ({ ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.done", subtype, provider: "codex", selected_model: model });
  return [...Array.from({ length: accepted }, () => row("success")), ...Array.from({ length: refused }, () => row("commit_refused"))];
}

/** gpt-6-sol at 0.53 and gpt-6.1-sol at 0.39, with enough rounds that the higher arm out-draws the lower one. */
const MEASURED = [...codexArm("gpt-6-sol", 530, 470), ...codexArm("gpt-6.1-sol", 390, 610)];

/** A checkout whose `.remudero/mounts.yaml` is the committed table with the balanced Codex row replaced by `row`. */
function checkoutMounting(row: string[]): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  const root = mkdtempSync(join(parent, "rmd-fix-learner-mounted-"));
  const mounts = parseYaml(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as {
    capabilities: { codex: Record<string, Record<string, string[]>> };
  };
  mounts.capabilities.codex.balanced = { low: row, medium: row, high: row };
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "mounts.yaml"), stringifyYaml(mounts));
  return root;
}

function codexResult(): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6.1-sol",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

/**
 * One balanced (sonnet) fix spawn through the real auction. Claude is below reserve, so Codex carries the round;
 * the Codex read serves gpt-6.1-sol, the mounts' lead, unless the learner asks it for another model.
 */
async function spawnFix(root: string, taskId: string): Promise<{ decision: Record<string, unknown> | undefined; asked: string[]; assignment: WorkerSelectionAssignment }> {
  const assignments: WorkerSelectionAssignment[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const evidence = fixArmEvidence(MEASURED, NOW);
  const learnedArms: FixLearnedArms = {
    evidence,
    weigh: (candidates, seed) => fixRoutingWeights(evidence, candidates, seed),
    onDecision: (fields) => decisions.push(fields),
  };
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "fix rung 1",
    model: "sonnet",
    effort: "medium",
    taskId,
    runId: `run-${taskId}-2`,
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => capacity("claude", 99),
      readCodex: async (_config, request) => {
        if (request.preferredModel?.model) asked.push(request.preferredModel.model);
        return capacity("codex", 50, request.preferredModel?.model ?? request.selectedModel ?? "gpt-6.1-sol");
      },
      spawnCodex: async () => codexResult(),
      writeStatus: () => undefined,
      now: () => NOW,
      learnedArms,
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
  assert.equal(assignments.length, 1);
  assert.equal(decisions.length, 1, "one fix.routing_decision row per fix spawn");
  return { decision: decisions[0], asked, assignment: assignments[0]! };
}

test("W1-T6360: an unmounted arm is never selected", async () => {
  const root = checkoutMounting(["gpt-6.1-sol"]);
  try {
    const { decision, asked, assignment } = await spawnFix(root, "W1-T9360");
    assert.equal(decision?.applied, true, "the learner ran on this round");
    assert.equal(assignment.selected.provider, "codex");
    assert.equal(decision?.selected_model, "gpt-6.1-sol", "the only mounted model carries the round");
    assert.deepEqual(asked, [], "an unmounted historical arm is never re-read, however high its weight");
    const arms = (decision?.arms ?? []) as Array<Record<string, unknown>>;
    const unmounted = arms.find((arm) => arm.model === "gpt-6-sol");
    assert.ok(unmounted, "the unmounted arm's evidence is still named on the decision row");
    assert.equal(unmounted.draw, null, "but it is not drawn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6360: the learner still ranks mounted arms", async () => {
  const root = checkoutMounting(["gpt-6.1-sol", "gpt-6-sol"]);
  try {
    const { decision, asked, assignment } = await spawnFix(root, "W1-T9361");
    assert.equal(decision?.applied, true);
    assert.equal(assignment.selected.provider, "codex");
    assert.deepEqual(asked, ["gpt-6-sol"], "the higher-weighted mounted arm out-draws the served one and is re-read");
    assert.equal(decision?.selected_model, "gpt-6-sol", "among mounted arms the higher-weighted one wins");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
