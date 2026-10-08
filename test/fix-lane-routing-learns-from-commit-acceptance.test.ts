import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  FIX_ROUTING_HALF_LIFE_MS,
  FIX_ROUTING_LEARNER,
  clearFixRoutingEvidenceCache,
  readFixRoutingRows,
  fixArmEvidence,
  fixRoutingDecisionFields,
  fixRoutingWeights,
  type FixLearnedArms,
  type FixRoutingCandidate,
} from "../src/lib/fix-routing-learner.js";
import {
  routingDrawValue,
  selectWorkerProvider,
  type ProviderCapacity,
  type ProviderMixing,
  type RoutingDrawSeed,
} from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// W1-T5535: the fix lane's auction learns from whether an arm's fix rounds COMMIT. Measured over
// 2026-09-26..10-03, codex/gpt-6.1-sol was refused on 23 of 37 rounds and claude-opus-5-5 on 1 of 8.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const DAY = 24 * 3_600_000;

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

function fixDone(provider: string | undefined, model: string | undefined, subtype: string, ageMs = 0, extra: Record<string, unknown> = {}) {
  return {
    ts: new Date(NOW - ageMs).toISOString(),
    task_id: "W1-T1",
    step: "fix.done",
    subtype,
    ...(provider ? { provider } : {}),
    ...(model ? { selected_model: model } : {}),
    ...extra,
  };
}

/** `refused` commit_refused rounds and `accepted` clean ones for one arm, all `ageMs` old. */
function armRounds(provider: string, model: string, refused: number, accepted: number, ageMs = 0) {
  return [
    ...Array.from({ length: refused }, () => fixDone(provider, model, "commit_refused", ageMs)),
    ...Array.from({ length: accepted }, () => fixDone(provider, model, "success", ageMs)),
  ];
}

const CANDIDATES: FixRoutingCandidate[] = [
  { provider: "claude", model: "claude-opus-5-5" },
  { provider: "codex", model: "gpt-6.1-sol" },
];

function spawnKey(index: number): RoutingDrawSeed {
  return { unit: "spawn", taskId: `W1-T${index}`, attempt: `run-W1-T${index}-1`, point: "spawn:00000000" };
}

/** Each provider's mean final probability over a fixed list of seeds: deterministic, so tolerances never flake. */
function meanShare(rows: Array<Record<string, unknown>>, candidates: FixRoutingCandidate[], headroom: ProviderCapacity[], seeds = 300) {
  const evidence = fixArmEvidence(rows, NOW);
  const totals: Record<string, number> = {};
  let minFinal = 1;
  for (let index = 0; index < seeds; index += 1) {
    const key = spawnKey(index);
    const weights = fixRoutingWeights(evidence, candidates, routingDrawValue(key).seed);
    const mixing: ProviderMixing = { epsilon: weights.epsilon, multipliers: weights.multipliers as ProviderMixing["multipliers"] };
    const selection = selectWorkerProvider(headroom, 5, key, mixing);
    for (const entry of selection.draw!.probabilities) {
      totals[entry.provider] = (totals[entry.provider] ?? 0) + entry.probability;
      minFinal = Math.min(minFinal, entry.probability);
    }
  }
  return { share: Object.fromEntries(Object.entries(totals).map(([provider, total]) => [provider, total / seeds])), minFinal };
}

const EVEN_HEADROOM = [capacity("claude", 50), capacity("codex", 50)];

test("W1-T5535: an arm with more refused fix rounds draws a smaller selection share", () => {
  // 37 rounds with 23 refused against 8 rounds with 1 refused, at equal headroom.
  const rows = [...armRounds("codex", "gpt-6.1-sol", 23, 14), ...armRounds("claude", "claude-opus-5-5", 1, 7)];
  const { share } = meanShare(rows, CANDIDATES, EVEN_HEADROOM);
  assert.ok(share.claude > 0.6, `the committing arm takes the larger share, got ${share.claude}`);
  assert.ok(share.codex < 0.4, `the refused arm takes the smaller share, got ${share.codex}`);
  assert.ok(Math.abs(share.claude + share.codex - 1) < 1e-9, "the shares are a distribution");
  // With no evidence at all the same headroom splits evenly: the skew above is the learner's, not the auction's.
  const blank = meanShare([], CANDIDATES, EVEN_HEADROOM);
  assert.ok(Math.abs(blank.share.claude - 0.5) < 1e-9, `no evidence leaves pure headroom, got ${blank.share.claude}`);
});

test("W1-T5535: every eligible arm keeps a positive exploration share", () => {
  // One arm has only ever been refused, the other only ever committed.
  const refusedOnly = [...armRounds("codex", "gpt-6.1-sol", 40, 0), ...armRounds("claude", "claude-opus-5-5", 0, 40)];
  const { share, minFinal } = meanShare(refusedOnly, CANDIDATES, EVEN_HEADROOM);
  assert.ok(minFinal > 0, "no draw ever cut an arm off");
  assert.ok(share.codex > 0, "the refused arm keeps a positive share");
  const evidence = fixArmEvidence(refusedOnly, NOW);
  const weights = fixRoutingWeights(evidence, CANDIDATES, "00000001");
  assert.ok(weights.epsilon > 0 && weights.epsilon < 1);
  // The exploration share shrinks only as evidence accumulates, and has no fixed floor to stop at.
  const epsilonAt = (rounds: number) => fixRoutingWeights(
    fixArmEvidence([...armRounds("codex", "gpt-6.1-sol", rounds, 0), ...armRounds("claude", "claude-opus-5-5", 0, rounds)], NOW),
    CANDIDATES,
    "00000001",
  ).epsilon;
  assert.ok(epsilonAt(10) > epsilonAt(40) && epsilonAt(40) > epsilonAt(400), "more evidence, less exploration");
  assert.ok(epsilonAt(400) > 0, "never zero");
  // A candidate with no recorded rounds is weighed on the prior alone, so it is neither favoured nor cut off.
  const fresh = fixRoutingWeights(evidence, [...CANDIDATES, { provider: "codex", model: "gpt-9-new" }], "00000001");
  assert.equal(fresh.arms.find((arm) => arm.model === "gpt-9-new")?.rounds, 0);
});

test("W1-T5535: old refusals decay so a recovered arm regains share", () => {
  const healthy = armRounds("claude", "claude-opus-5-5", 0, 30);
  const freshRefusals = [...armRounds("codex", "gpt-6.1-sol", 30, 0), ...healthy];
  const oldRefusals = [...armRounds("codex", "gpt-6.1-sol", 30, 0, 24 * DAY), ...healthy];
  const fresh = meanShare(freshRefusals, CANDIDATES, EVEN_HEADROOM).share.codex;
  const old = meanShare(oldRefusals, CANDIDATES, EVEN_HEADROOM).share.codex;
  assert.ok(fresh < 0.3, `fresh refusals suppress the arm, got ${fresh}`);
  assert.ok(old > fresh + 0.15, `refusals many half-lives old no longer suppress it: ${old} vs ${fresh}`);
  // A refusal one half-life old weighs half as much as a fresh one.
  const one = fixArmEvidence([fixDone("codex", "gpt-6.1-sol", "commit_refused", FIX_ROUTING_HALF_LIFE_MS)], NOW);
  assert.ok(Math.abs(one.arms[0].refusedWeight - 0.5) < 1e-9);
});

test("W1-T5535: rows with no provider are excluded and counted", () => {
  const rows = [
    fixDone(undefined, undefined, "commit_refused"),
    fixDone(undefined, undefined, "commit_refused"),
    fixDone(undefined, "claude-sonnet-5", "commit_refused"),
    fixDone("codex", undefined, "commit_refused"),
    ...armRounds("claude", "claude-sonnet-5", 1, 3),
  ];
  const evidence = fixArmEvidence(rows, NOW);
  assert.equal(evidence.unattributedExcluded, 4);
  assert.deepEqual(evidence.arms.map((arm) => [arm.provider, arm.model, arm.rounds]), [["claude", "claude-sonnet-5", 4]]);
  assert.equal(evidence.arms[0].refusedWeight, 1, "an excluded refusal is not pooled into any arm");
  const weights = fixRoutingWeights(evidence, [{ provider: "claude", model: "claude-sonnet-5" }], "0000000a");
  const fields = fixRoutingDecisionFields({
    weights,
    probabilities: [{ provider: "claude", headroom: 1, learned: 1, final: 1 }],
    selected: { provider: "claude", model: "claude-sonnet-5" },
  });
  assert.equal(fields.unattributed_excluded, 4);
  // A pushed round whose head later failed CI is worth half a round, joined on the pushed head.
  const red = fixArmEvidence([
    fixDone("codex", "gpt-6-sol", "success", 0, { pushed_head_sha: "abc" }),
    { ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.ci_not_green", sha: "abc" },
  ], NOW);
  assert.equal(red.arms[0].acceptedWeight, 0.5);
  assert.equal(red.arms[0].refusedWeight, 0.5);
});

// ── The selector and the real spawn path ───────────────────────────────────────────────────────

test("W1-T5535: a spawn outside the fix lane routes exactly as before", async () => {
  const capacities = [capacity("claude", 40), capacity("codex", 70)];
  const selection = selectWorkerProvider(capacities, 5, spawnKey(3));
  assert.deepEqual(Object.keys(selection), ["provider", "capacity", "tightestRemainingPercent", "allocationWeight", "allocationSharePercent", "draw"]);
  assert.deepEqual(selection.draw?.probabilities, [
    { provider: "claude", probability: 3025 / 3650 },
    { provider: "codex", probability: 625 / 3650 },
  ]);
  assert.equal("learned" in selection.draw!, false, "no learned block without a mixing");
  assert.equal(selection.allocationWeight, 3025);

  const root = fixtureRoot("rmd-fix-learner-");
  try {
    const row = await spawnFix(root, { taskId: "W1-T9300", effort: "medium" });
    assert.equal(row.assignment.routing.decision?.learner, undefined);
    assert.equal(row.assignment.routing.propensity?.selectedProbability, 0.5, "equal headroom, pure headroom weights");
    assert.deepEqual(row.decisions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5535: the fix routing decision row names each arm acceptance and denominator", async () => {
  const root = fixtureRoot("rmd-fix-learner-");
  try {
    const rows = [...armRounds("codex", "gpt-6.1-sol", 23, 14), ...armRounds("claude", "claude-sonnet-5-5", 2, 20), ...armRounds("claude", "claude-sonnet-5-5", 0, 0)];
    const row = await spawnFix(root, { taskId: "W1-T9301", effort: "medium", rows: [...rows, fixDone(undefined, undefined, "commit_refused")] });
    const { assignment, decisions } = row;
    assert.equal(decisions.length, 1, "one decision row per fix spawn");
    const decision = decisions[0]!;
    assert.equal(decision.learner, FIX_ROUTING_LEARNER);
    assert.equal(decision.applied, true);
    assert.equal(decision.unattributed_excluded, 1);
    assert.equal(decision.half_life_ms, FIX_ROUTING_HALF_LIFE_MS);
    assert.ok((decision.epsilon as number) > 0);
    const arms = decision.arms as Array<Record<string, number | string | null>>;
    const codex = arms.find((arm) => arm.model === "gpt-6.1-sol")!;
    assert.equal(codex.model, "gpt-6.1-sol");
    assert.equal(codex.rounds, 37);
    assert.equal(codex.refused_weight, 23);
    assert.equal(codex.accepted_weight, 14);
    assert.equal(codex.n_eff, 37, "the denominator");
    for (const arm of arms) {
      for (const field of ["alpha", "beta", "n_eff", "accepted_weight", "refused_weight"]) assert.equal(typeof arm[field], "number", `${arm.provider} ${field}`);
    }
    assert.equal(codex.draw, null, "an arm no candidate would serve is named but not drawn");
    assert.equal(codex.p_final, null);
    const drawn = arms.filter((arm) => arm.draw !== null);
    for (const arm of drawn) for (const field of ["draw", "p_headroom", "p_final"]) assert.equal(typeof arm[field], "number", `${arm.provider} ${field}`);
    assert.ok(Math.abs(arms.reduce((sum, arm) => sum + ((arm.p_final as number | null) ?? 0), 0) - 1) < 1e-9, "final probabilities form a distribution");
    assert.equal(decision.selected_provider, assignment.selected.provider);
    // The assignment row records the learner, and its propensity is the MIXED probability the draw used.
    assert.equal(assignment.routing.decision?.learner, FIX_ROUTING_LEARNER);
    assert.equal(assignment.routing.decision?.ab, undefined, "a learned draw is never read as an experiment crossover");
    const served = drawn.find((arm) => arm.provider === assignment.selected.provider)!;
    assert.equal(assignment.routing.propensity?.selectedProbability, served.p_final);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5535: an experiment task keeps its arm for fix rounds", async () => {
  const root = fixtureRoot("rmd-fix-learner-");
  try {
    const rows = [...armRounds("codex", "gpt-6-sol", 30, 0), ...armRounds("claude", "claude-sonnet-5-5", 0, 30)];
    const plain = await spawnFix(root, { taskId: "W1-T9100", effort: "high" });
    const learned = await spawnFix(root, { taskId: "W1-T9100", effort: "high", rows });
    assert.equal(learned.assignment.routing.decision?.ab, "sol-vs-sonnet55");
    assert.equal(learned.assignment.routing.decision?.learner, undefined, "no learner on an experiment arm");
    assert.equal(learned.assignment.selected.provider, plain.assignment.selected.provider, "the experiment arm is unchanged");
    assert.equal(learned.assignment.routing.propensity?.selectedProbability, 0.5, "pure headroom, as the experiment recorded it");
    assert.deepEqual(learned.decisions.map((entry) => [entry.applied, entry.reason]), [[false, "live-routing-experiment"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── helpers: the real spawn path ───────────────────────────────────────────────────────────────

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

/** W1-T6360: the learner ranks only mounted Codex models, so a fixture arm must be in the balanced row to compete. */
function mountCodexBalanced(root: string, row: string[]): void {
  const mounts = parseYaml(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as {
    capabilities: { codex: Record<string, Record<string, string[]>> };
  };
  mounts.capabilities.codex.balanced = { low: row, medium: row, high: row };
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "mounts.yaml"), stringifyYaml(mounts));
}

function codexResult(): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6-sol",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

/** One spawn through the real auction; `rows` present means the fix rung supplied learned arms. */
async function spawnFix(
  root: string,
  input: {
    taskId: string; effort: string; rows?: Array<Record<string, unknown>>;
    readCodex?: (request: { preferredModel?: { model: string }; selectedModel?: string }) => Promise<ProviderCapacity>;
    onDecision?: (fields: Record<string, unknown>) => void;
  },
): Promise<{ assignment: WorkerSelectionAssignment; decisions: Array<Record<string, unknown>> }> {
  const assignments: WorkerSelectionAssignment[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  const evidence = input.rows ? fixArmEvidence(input.rows, NOW) : undefined;
  const learnedArms: FixLearnedArms | undefined = evidence
    ? { evidence, weigh: (candidates, seed) => fixRoutingWeights(evidence, candidates, seed), onDecision: input.onDecision ?? ((fields) => decisions.push(fields)) }
    : undefined;
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "fix rung 1",
    model: "sonnet",
    effort: input.effort,
    taskId: input.taskId,
    runId: `run-${input.taskId}-2`,
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
    } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => capacity("claude", 50),
      readCodex: async (_config, request) => (input.readCodex
        ? input.readCodex(request)
        : capacity("codex", 50, request.preferredModel?.model ?? request.selectedModel ?? "gpt-6-sol")),
      spawnCodex: async () => codexResult(),
      writeStatus: () => undefined,
      now: () => NOW,
      ...(learnedArms ? { learnedArms } : {}),
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
  return { assignment: assignments[0]!, decisions };
}

test("W1-T5535: the ledger read is cached for a short time and a failed read is never cached", async () => {
  clearFixRoutingEvidenceCache();
  let reads = 0;
  const rows = [fixDone("codex", "gpt-6-sol", "success")];
  const read = async () => { reads += 1; return rows; };
  assert.equal((await readFixRoutingRows("/state", NOW, read)).length, 1);
  assert.equal((await readFixRoutingRows("/state", NOW + 60_000, read)).length, 1);
  assert.equal(reads, 1, "a strike inside the TTL reuses the read");
  await readFixRoutingRows("/state", NOW + 10 * 60_000, read);
  assert.equal(reads, 2, "an expired read is taken again");
  const failing = async () => { throw new Error("unreadable"); };
  await assert.rejects(readFixRoutingRows("/other", NOW, failing), /unreadable/);
  assert.equal((await readFixRoutingRows("/other", NOW, read)).length, 1, "the failure left nothing in the cache");
  clearFixRoutingEvidenceCache();
});

test("W1-T5535: a codex arm that out-draws the served model is re-read and adopted", async () => {
  const root = fixtureRoot("rmd-fix-learner-reread-");
  mountCodexBalanced(root, ["gpt-6-sol", "gpt-better"]);
  try {
    const asked: string[] = [];
    const rows = [...armRounds("codex", "gpt-6-sol", 30, 0), ...armRounds("codex", "gpt-better", 0, 30), ...armRounds("claude", "claude-sonnet-5-5", 30, 0)];
    const { decisions } = await spawnFix(root, {
      taskId: "W1-T9302", effort: "medium", rows,
      readCodex: async (request) => {
        if (request.preferredModel?.model) asked.push(request.preferredModel.model);
        return capacity("codex", 50, request.preferredModel?.model ?? request.selectedModel ?? "gpt-6-sol");
      },
    });
    assert.ok(asked.includes("gpt-better"), "the better-drawn codex arm is re-read");
    const arms = (decisions[0]?.arms ?? []) as Array<Record<string, unknown>>;
    assert.ok(arms.some((arm) => arm.model === "gpt-better" && arm.draw !== null), "the adopted model is a drawn candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5535: a codex re-read that throws is logged and keeps the served capacity", async (t) => {
  const root = fixtureRoot("rmd-fix-learner-reread-throws-");
  mountCodexBalanced(root, ["gpt-6-sol", "gpt-better"]);
  const errors: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { errors.push(String(line)); });
  try {
    const rows = [...armRounds("codex", "gpt-6-sol", 30, 0), ...armRounds("codex", "gpt-better", 0, 30), ...armRounds("claude", "claude-sonnet-5-5", 30, 0)];
    const { assignment } = await spawnFix(root, {
      taskId: "W1-T9303", effort: "medium", rows,
      readCodex: async (request) => {
        if (request.preferredModel?.model === "gpt-better") throw new Error("codex app-server unavailable");
        return capacity("codex", 50, request.preferredModel?.model ?? request.selectedModel ?? "gpt-6-sol");
      },
    });
    assert.ok(errors.some((line) => line.includes("worker.fix_routing_codex_reread_failed") && line.includes("codex app-server unavailable")));
    assert.ok(assignment.selected.provider, "the spawn still routes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5535: a decision sink that throws is logged and never changes routing", async (t) => {
  const root = fixtureRoot("rmd-fix-learner-sink-throws-");
  const errors: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { errors.push(String(line)); });
  try {
    const rows = [...armRounds("codex", "gpt-6.1-sol", 5, 5), ...armRounds("claude", "claude-sonnet-5-5", 5, 5)];
    const { assignment } = await spawnFix(root, {
      taskId: "W1-T9304", effort: "medium", rows,
      onDecision: () => { throw new Error("ledger append failed"); },
    });
    assert.ok(assignment.selected.provider, "the spawn still routes");
    assert.ok(errors.some((line) => line.includes("worker.fix_routing_decision_write_failed") && line.includes("ledger append failed")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5535: an unreadable routing ledger is named on its own row and the round routes by headroom", async () => {
  const { fixLearnedArmsFor } = await import("../src/run-task.js");
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push([step, extra]); };
  const strike = { strike: 1, round: "ci-log" };
  const none = await fixLearnedArmsFor(
    { ledgerPath: "/state/ledger.ndjson", log, readFixRoutingRows: async () => { throw new Error("ledger unreadable"); } }, strike);
  assert.equal(none, undefined, "no learned arms: the auction weighs headroom alone");
  assert.deepEqual(rows.map(([step]) => step), ["fix.routing_learner_unavailable"]);
  assert.equal(rows[0]![1]?.reason, "ledger-read-failed");
  assert.match(String(rows[0]![1]?.error), /ledger unreadable/);
  const learned = await fixLearnedArmsFor(
    { ledgerPath: "/state/ledger.ndjson", log, readFixRoutingRows: async () => armRounds("codex", "gpt-6.1-sol", 1, 3) }, strike);
  assert.ok(learned, "a readable ledger yields learned arms");
  learned!.onDecision?.({ applied: true });
  assert.deepEqual(rows.at(-1), ["fix.routing_decision", { strike: 1, round: "ci-log", applied: true }]);
});

