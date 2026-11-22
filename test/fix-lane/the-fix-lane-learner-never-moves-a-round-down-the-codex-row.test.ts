import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  fixArmEvidence, fixRoutingWeights, mountedFixArms, type FixLearnedArms, type FixRoutingCandidate,
} from "#src/lib/fix-routing-learner.js";
import { writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13450: a Codex row is an order, not a pool. Every Sol shares one quota bucket, so a trailing entry is only an
// availability fallback, reached when the ones ahead are absent or cannot serve the effort. The fix-lane learner
// treated every mounted member of the row as a rival to the served model, so an older Sol with fix-lane evidence
// could take a round from the row's lead. The learner's Codex rivals are now only the mounted arms AHEAD of the
// served model. The rows here are fixtures, so these tests hold whichever Sol leads the committed table.

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const LEAD = "gpt-6.2-sol";
const SECOND = "gpt-6.1-sol";
const THIRD = "gpt-6-sol";
const ROW = [LEAD, SECOND, THIRD];

type Row = Record<string, unknown>;

/** `accepted` clean and `refused` commit_refused fix rounds for one arm: an acceptance rate of accepted / total. */
function arm(provider: "claude" | "codex", model: string, accepted: number, refused: number): Row[] {
  const row = (subtype: string) => ({ ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.done", subtype, provider, selected_model: model });
  return [...Array.from({ length: accepted }, () => row("success")), ...Array.from({ length: refused }, () => row("commit_refused"))];
}

/** A weak Claude arm keeps the pooled prior low, so an evidence-free lead draws far below a strong trailing arm. */
const WEAK_CLAUDE = arm("claude", "claude-sonnet-5", 100, 900);

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

/** A checkout whose `.remudero/mounts.yaml` is the committed table with the balanced Codex row replaced by `row`. */
function checkoutMounting(t: TestContext, row: readonly string[]): string {
  const root = ownedFixtureDir(t, "rmd-fix-learner-row-").dir;
  assert.equal(gitWorkTreeAncestor(root), undefined, "the fixture checkout must sit outside every Git work tree");
  const mounts = parseYaml(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as {
    capabilities: { codex: Record<string, Record<string, string[]>> };
  };
  mounts.capabilities.codex.balanced = { low: [...row], medium: [...row], high: [...row] };
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "mounts.yaml"), stringifyYaml(mounts));
  return root;
}

function codexResult(model: string): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model,
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

interface FixSpawn {
  decision: Record<string, unknown> | undefined;
  /** Every model the learner asked Codex to re-read. */
  asked: string[];
  /** Every candidate list the learner weighed, in order: a rival draw (if any), then the provider weighting. */
  weighed: FixRoutingCandidate[][];
  assignment: WorkerSelectionAssignment;
}

/**
 * One balanced (sonnet) fix spawn through the real auction. The Codex read serves `served` unless the learner asks
 * it for another model; Claude's weekly window is at `claudeUsed` percent (99 leaves Codex alone in the auction).
 */
async function spawnFix(root: string, taskId: string, input: { served: string; rows: Row[]; claudeUsed?: number }): Promise<FixSpawn> {
  const assignments: WorkerSelectionAssignment[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const weighed: FixRoutingCandidate[][] = [];
  const evidence = fixArmEvidence(input.rows, NOW);
  const learnedArms: FixLearnedArms = {
    evidence,
    weigh: (candidates, seed) => {
      weighed.push(candidates.map((candidate) => ({ ...candidate })));
      return fixRoutingWeights(evidence, candidates, seed);
    },
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
      readClaude: async () => capacity("claude", input.claudeUsed ?? 99),
      readCodex: async (_config, request) => {
        if (request.preferredModel?.model) asked.push(request.preferredModel.model);
        return capacity("codex", 50, request.preferredModel?.model ?? request.selectedModel ?? input.served);
      },
      spawnCodex: async () => codexResult(input.served),
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
  assert.equal(assignments.length, 1, "one selection assignment per fix spawn");
  assert.equal(decisions.length, 1, "one fix.routing_decision row per fix spawn");
  return { decision: decisions[0], asked, weighed, assignment: assignments[0]! };
}

function decisionArms(decision: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (decision?.arms ?? []) as Array<Record<string, unknown>>;
}

/** The Codex models a weigh call drew, in order. */
const codexModels = (candidates: readonly FixRoutingCandidate[]) =>
  candidates.filter((candidate) => candidate.provider === "codex").map((candidate) => candidate.model);

test("W1-T13450 criterion 1: with the lead served, a trailing Sol never takes the round however high its weight", async (t) => {
  const root = checkoutMounting(t, ROW);
  // Both trailing Sols accept 99% of their rounds; the lead has no evidence and draws from the (low) pooled prior.
  const rows = [...WEAK_CLAUDE, ...arm("codex", SECOND, 990, 10), ...arm("codex", THIRD, 990, 10)];
  for (const taskId of ["W1-T9450", "W1-T9451", "W1-T9452"]) {
    const { decision, asked, weighed, assignment } = await spawnFix(root, taskId, { served: LEAD, rows });
    assert.equal(decision?.applied, true, `${taskId}: the learner ran on this round`);
    assert.deepEqual(asked, [], `${taskId}: no other Codex model is re-read`);
    for (const candidates of weighed) {
      assert.deepEqual(codexModels(candidates), [LEAD], `${taskId}: the learner drew no Codex rival to the served lead`);
    }
    assert.equal(assignment.selected.provider, "codex");
    assert.equal(assignment.selected.model, LEAD, `${taskId}: the round runs on the row's lead`);
    assert.equal(decision?.selected_model, LEAD);
  }
});

test("W1-T13450 criterion 1: the W1-T6360 row [gpt-6.1-sol, gpt-6-sol] keeps the lead, reversing that test's earlier arm", async (t) => {
  // W1-T6028 measured gpt-6-sol at 0.53 and gpt-6.1-sol at 0.39; W1-T6360 let the trailing 6.0 take the round.
  const root = checkoutMounting(t, [SECOND, THIRD]);
  const rows = [...arm("codex", THIRD, 530, 470), ...arm("codex", SECOND, 390, 610)];
  const { decision, asked, assignment } = await spawnFix(root, "W1-T9453", { served: SECOND, rows });
  assert.equal(decision?.applied, true);
  assert.deepEqual(asked, [], "the trailing, higher-weighted gpt-6-sol is never re-read");
  assert.equal(assignment.selected.model, SECOND);
  assert.equal(decision?.selected_model, SECOND, "the round stays on the row's lead");
});

test("W1-T13450 criterion 2: a served fallback still yields to a higher-weighted arm ahead of it in the row", async (t) => {
  const root = checkoutMounting(t, ROW);
  // The lead could not serve, so the read fell back to the second entry; the lead's arm out-scores it.
  const rows = [...arm("codex", LEAD, 990, 10), ...arm("codex", SECOND, 390, 610), ...arm("codex", THIRD, 300, 700)];
  const { decision, asked, weighed, assignment } = await spawnFix(root, "W1-T9454", { served: SECOND, rows });
  assert.equal(decision?.applied, true);
  assert.ok(codexModels(weighed[0] ?? []).includes(LEAD), "the arm ahead of the served fallback is drawn against it");
  assert.deepEqual(asked, [LEAD], "the higher-weighted arm ahead of the fallback is re-read");
  assert.equal(assignment.selected.model, LEAD);
  assert.equal(decision?.selected_model, LEAD, "the arm ahead wins the round");
});

test("W1-T13450 criterion 3: a served fallback's rival draw holds only the arms ahead of it, never one behind it", async (t) => {
  const root = checkoutMounting(t, ROW);
  // The trailing gpt-6-sol out-scores the served fallback, but it sits behind it in the row.
  const rows = [...WEAK_CLAUDE, ...arm("codex", LEAD, 300, 700), ...arm("codex", SECOND, 390, 610), ...arm("codex", THIRD, 990, 10)];
  const { decision, asked, weighed, assignment } = await spawnFix(root, "W1-T9457", { served: SECOND, rows });
  assert.equal(decision?.applied, true);
  assert.deepEqual(codexModels(weighed[0] ?? []).sort(), [LEAD, SECOND].sort(), "the rival draw is the arms ahead plus the served one");
  for (const candidates of weighed) assert.ok(!codexModels(candidates).includes(THIRD), "the trailing arm is never drawn");
  assert.ok(!asked.includes(THIRD), "the trailing arm is never re-read");
  assert.equal(assignment.selected.model, SECOND, "the lower-weighted lead does not beat the served fallback here");
  const trailing = decisionArms(decision).find((entry) => entry.provider === "codex" && entry.model === THIRD);
  assert.ok(trailing, "the trailing arm's evidence is named on the decision row");
  assert.equal(trailing.draw, null, "with no draw");
});

test("W1-T13450 criterion 3: mountedFixArms keeps only the evidence arms ahead of the served model in the row", () => {
  const evidence = fixArmEvidence([
    ...arm("codex", LEAD, 5, 5), ...arm("codex", SECOND, 5, 5), ...arm("codex", THIRD, 5, 5),
    ...arm("codex", "gpt-5.6-sol", 5, 5), ...arm("claude", "claude-sonnet-5", 5, 5),
  ], NOW);
  const models = (served: string | undefined, row: readonly string[] = ROW) =>
    mountedFixArms(evidence, "codex", row, served).map((candidate) => candidate.model);
  assert.deepEqual(models(LEAD), [], "the lead has no rival");
  assert.deepEqual(models(SECOND), [LEAD], "a fallback's rivals are the arms ahead of it");
  assert.deepEqual(models(THIRD).sort(), [LEAD, SECOND].sort(), "the last entry's rivals are every arm ahead of it");
  assert.deepEqual(models("gpt-5.6-sol").sort(), [...ROW].sort(), "a served model the row does not name keeps every mounted arm");
  assert.deepEqual(models(undefined).sort(), [...ROW].sort(), "an unknown served model keeps every mounted arm");
  assert.deepEqual(models(THIRD, ["gpt-7-sol", SECOND, THIRD]), [SECOND], "an arm with no evidence is never a candidate");
  for (const candidate of mountedFixArms(evidence, "codex", ROW, THIRD)) assert.equal(candidate.provider, "codex");
});

test("W1-T13450 criterion 3: a trailing arm is named on the decision row with no draw, and the provider weighting is unchanged", async (t) => {
  const root = checkoutMounting(t, ROW);
  // W1-T14297: strip only the balanced provider preference, so this round is still the learner's mixed auction alone.
  const table = parseYaml(readFileSync(join(root, ".remudero", "mounts.yaml"), "utf8")) as {
    capabilities: { provider_preference: Record<string, string> };
  };
  assert.equal(table.capabilities.provider_preference.balanced, "codex", "the committed table carries the row stripped here");
  delete table.capabilities.provider_preference.balanced;
  writeFileSync(join(root, ".remudero", "mounts.yaml"), stringifyYaml(table));
  const rows = [...arm("claude", "claude-sonnet-5", 500, 500), ...arm("codex", SECOND, 990, 10), ...arm("codex", THIRD, 990, 10)];
  // Claude has headroom here, so the round is a Claude-versus-Codex auction over each provider's served arm.
  const { decision, asked, weighed } = await spawnFix(root, "W1-T9455", { served: LEAD, rows, claudeUsed: 10 });
  assert.equal(decision?.applied, true);
  assert.deepEqual(asked, []);
  assert.equal(weighed.length, 1, "with no rival ahead of the lead, the only weigh call is the provider weighting");
  const providers = weighed[0]!.map((candidate) => candidate.provider).sort();
  assert.deepEqual(providers, ["claude", "codex"], "the provider weighting weighs one served arm per eligible provider");
  assert.deepEqual(codexModels(weighed[0]!), [LEAD]);
  const arms = decisionArms(decision);
  for (const model of [SECOND, THIRD]) {
    const trailing = arms.find((entry) => entry.provider === "codex" && entry.model === model);
    assert.ok(trailing, `the trailing ${model} arm's evidence is named on the decision row`);
    assert.equal(trailing.draw, null, `the trailing ${model} arm is not drawn`);
    assert.equal(trailing.p_final, null);
  }
  const served = arms.filter((entry) => entry.draw !== null);
  assert.deepEqual(served.map((entry) => entry.provider).sort(), ["claude", "codex"], "each eligible provider's served arm is drawn");
  for (const entry of served) {
    assert.equal(typeof entry.p_final, "number", `${String(entry.provider)} holds a share of the mixed auction`);
    assert.ok((entry.p_final as number) > 0, `${String(entry.provider)}'s share is positive`);
  }
  const total = served.reduce((sum, entry) => sum + (entry.p_final as number), 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `the provider shares sum to one (${total})`);
});

test("W1-T13450 criterion 3: a selection carrying a Codex preference skips the learner's draw, even for a trailing model", async (t) => {
  const root = checkoutMounting(t, ROW);
  writeProviderRoutingPolicyOverride(root, {
    enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [],
    codexModelPreference: { capability: "balanced", effort: "medium", model: THIRD },
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
  }, {
    config: { workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 } } as never,
    now: () => NOW,
    writerFingerprint: "unknown",
  });
  const rows = [...WEAK_CLAUDE, ...arm("codex", LEAD, 990, 10), ...arm("codex", SECOND, 990, 10), ...arm("codex", THIRD, 100, 900)];
  const { decision, asked, weighed, assignment } = await spawnFix(root, "W1-T9456", { served: LEAD, rows });
  assert.equal(decision?.applied, true);
  assert.equal(weighed.length, 1, "a preferred selection skips the rival draw; only the provider weighting runs");
  assert.deepEqual(asked.filter((model) => model !== THIRD), [], "only the preferred model is ever asked for");
  assert.equal(assignment.selected.model, THIRD, "the preferred trailing model carries the round, as before");
  assert.equal(decision?.selected_model, THIRD);
});
