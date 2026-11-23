import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import type { Config } from "#src/lib/config.js";
import * as fixProgress from "#src/lib/fix-progress-judge.js";
import { fixArmEvidence, fixRoutingWeights } from "#src/lib/fix-routing-learner.js";
import { loadMounts, mountsPath, resolveMount } from "#src/lib/mounts.js";
import { writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult,
  type WorkerSelectionAssignment } from "#src/lib/worker.js";
import * as codex from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const LUNA = "gpt-6-luna";
const SOL = "gpt-6.2-sol";
const table = loadMounts(mountsPath(REPO_ROOT));
const capabilities = table.capabilities!;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const CANDIDATES = [LUNA, SOL].map(id => ({ id, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }));

test("W1-T13967 criterion 1: the Codex economy decision retains the requested Sonnet mount", () => {
  const codexCapability = codex.codexCapabilityBelow(capabilities, "sonnet");
  assert.equal(codexCapability, "economy");
  const rates = { rateLimits: { primary: { usedPercent: 25 } } };
  const base = codex.selectCodexModel(CANDIDATES, rates, {} as Config, "sonnet", "high", capabilities);
  const first = codex.selectCodexModel(CANDIDATES, rates, {} as Config, "sonnet", "high", capabilities, { codexCapability });
  assert.equal(base.model, SOL);
  assert.equal(first.model, LUNA);
  assert.equal(first.modelDecision?.requestedModel, "sonnet");
  assert.equal(first.modelDecision?.requestedCapability, "economy");
  assert.deepEqual(first.modelDecision?.capabilityOverride, { from: "balanced", reason: "fix-economy-first" });
});

type Row = Record<string, unknown>;
const defaultMount = resolveMount(table, "fix", "medium");
function checkout(t: TestContext): Config {
  const root = ownedFixtureDir(t, "fix-economy").dir;
  return { root, claudeBin: "/unused", workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex",
    reservePercent: 5 } } as Config;
}

function result(provider: "codex" | "claude", model: string, subtype = "success"): WorkerResult {
  return { provider, model, routedModel: model, servedModel: model, effort: "high", subtype, isError: subtype !== "success",
    sessionId: "fixture", costUsd: 0, numTurns: 1, text: "done", blocks: [], stderr: "", apiError: false,
    permissionDenials: [], childEnvKeys: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

async function route(config: Config, options: {
  first?: boolean; economy?: "healthy" | "exhausted" | "unreadable" | "no-model" | "credits";
  claudeUsed?: number; draw?: number;
}) {
  const decisions: Row[] = [], reads: Array<codex.CodexCapacityDeps["codexCapability"]> = [], starts: string[] = [];
  const assignments: WorkerSelectionAssignment[] = [];
  const evidence = fixArmEvidence([], NOW);
  const routing: NonNullable<SpawnWorkerArgs["providerRouting"]> = {
    now: () => NOW, draw: options.draw ?? 0, writeStatus: () => {},
    readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
    // Claude's expiring subscription budget makes the committed balanced preference stand aside.
    readClaude: async () => ({ provider: "claude", readable: true,
      windows: [{ name: "weekly", usedPercent: options.claudeUsed ?? 5, resetsAt: NOW / 1000 + 3600 }] }),
    readCodex: async (_config, request) => {
      reads.push(request.codexCapability);
      const economy = request.codexCapability === "economy" ? options.economy ?? "healthy" : "healthy";
      const models = economy === "no-model" ? CANDIDATES.filter(m => m.id !== LUNA) : CANDIDATES;
      const rateLimits = economy === "unreadable" ? undefined : { primary: { usedPercent: economy === "healthy" ? 60 : 99 },
        ...(economy === "credits" ? { credits: { hasCredits: true, unlimited: true, balance: null } } : {}) };
      return codex.selectCodexModel(models, { rateLimits }, config, request.requestedModel, request.requestedEffort,
        request.capabilities, { codexCapability: request.codexCapability, preferredModel: request.preferredModel,
          reservePercent: request.reservePercent, headroomTiming: request.headroomTiming });
    },
    spawnCodex: async (_args, _config, selection) => result("codex", selection!.model!),
    learnedArms: { evidence, weigh: (candidates, seed) => fixRoutingWeights(evidence, candidates, seed),
      onDecision: (decision) => decisions.push(decision) },
  };
  await spawnWorker({
    cwd: config.root, settingsFile: join(REPO_ROOT, "settings/worker.json"), permissionMode: "bypassPermissions",
    model: "sonnet", effort: "high", prompt: "fix this check", config, providerRouting: routing,
    ...(options.first ? { economyFirst: { codexCapability: "economy", onDecision: (reason) => starts.push(reason) } } : {}),
    onSelectionAssignment: (assignment) => assignments.push(assignment),
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" },
      home: config.root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub",
      expiresAt: 4_102_444_800_000 } }) },
    queryFn: (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "fixture",
        total_cost_usd: 0, num_turns: 1 };
    })()) as never,
  });
  assert.equal(assignments.length, 1);
  return { selected: assignments[0]!.selected, assignment: assignments[0]!, decisions, reads, starts };
}

test("test/fix-lane/a-codex-fix-round-starts-on-the-economy-model-and-escalates-after-a-failed-round.test.ts: with both providers eligible, Codex economy wins the first fix round", async t => {
  const config = checkout(t);
  const baseline = await route(config, {});
  assert.equal(baseline.selected.provider, "claude");
  const first = await route(config, { first: true });
  assert.deepEqual(first.selected, { provider: "codex", model: LUNA, effort: "high" });
  assert.equal(first.assignment.requested.model, "sonnet");
  assert.equal(first.assignment.routing.decision?.rule, "fix-economy-first");
  const decision = first.assignment.candidates.find(candidate => candidate.provider === "codex")?.modelDecision;
  assert.equal(decision?.requestedCapability, "economy");
  assert.deepEqual(decision?.capabilityOverride, { from: "balanced", reason: "fix-economy-first" });
  assert.deepEqual(first.decisions.map(({ applied, reason }) => ({ applied, reason })),
    [{ applied: false, reason: "fix-economy-first" }]);
  assert.deepEqual(first.starts, ["economy-first"]);
});

test("W1-T13967 criterion 2: unavailable economy capacity keeps the base auction and learner", async t => {
  const config = checkout(t);
  const baseline = await route(config, {});
  assert.equal(baseline.selected.provider, "claude");
  assert.equal(baseline.decisions[0]?.applied, true);
  for (const economy of ["exhausted", "unreadable", "no-model", "credits"] as const) {
    const attempt = await route(config, { first: true, economy });
    assert.deepEqual(attempt.starts, ["no-codex-capacity"], economy);
    assert.deepEqual(attempt.reads, ["economy", undefined], economy);
    assert.deepEqual(attempt.selected, baseline.selected, economy);
    assert.deepEqual(attempt.decisions, baseline.decisions, economy);
  }
  const creditsOnly = await route(config, { first: true, economy: "credits", claudeUsed: 100 });
  assert.equal(creditsOnly.selected.model, LUNA);
  assert.deepEqual(creditsOnly.starts, ["economy-first"]);
});

test("W1-T13967 criterion 5: operator provider and model preferences keep their normal route", async t => {
  for (const modelPreference of [false, true]) {
    const config = checkout(t);
    writeProviderRoutingPolicyOverride(config.root, {
      enabledProviders: ["claude", "codex"], preference: modelPreference ? "automatic" : "claude",
      reservePercent: 5, parks: [], expiresAt: new Date(NOW + 3_600_000).toISOString(),
      ...(modelPreference ? { codexModelPreference: { capability: "balanced", effort: "high", model: SOL } } : {}),
    }, { config, now: () => NOW, writerFingerprint: "unknown" });
    const baseline = await route(config, { draw: 0.9999 });
    const attempt = await route(config, { first: true, draw: 0.9999 });
    assert.equal(baseline.selected.provider, modelPreference ? "codex" : "claude");
    assert.deepEqual(attempt.selected, baseline.selected);
    assert.deepEqual(attempt.reads, baseline.reads);
    assert.deepEqual(attempt.starts, ["operator-preference"]);
  }
});

test("W1-T13967 criterion 5: routing receipts preserve the stall ladder, judge input and input key", async () => {
  const rows = round("first", "a", { pushed_head_sha: "b", subtype: "success" });
  const legacy = rows.map(({ start_capability: _tier, ...row }) => row);
  const withRouting = [...rows, { step: "fix.economy_escalated", task_id: "unfiled", pr_number: 42, failed_round_id: "first" }];
  const original = progress(legacy, "b");
  const decorated = progress(withRouting, "b");
  assert.deepEqual(decorated, original);
  const judge = async () => ({ verdict: "continue", reason: "the judge has the same evidence" } as const);
  const first = await fixProgress.resolveFixProgress(original, legacy, { judge });
  const second = await fixProgress.resolveFixProgress(decorated, withRouting, { judge });
  assert.equal(second.receipt.input_key, first.receipt.input_key);
  const remedies = (ledger: Row[]) => fixProgress.stallRemedyRows(ledger, 42, check);
  assert.deepEqual(remedies(withRouting), remedies(legacy));
  assert.deepEqual(fixProgress.nextStallRemedy(remedies(withRouting), { fixModelOrder: ["fix", "step_up"] }),
    { remedy: "stronger-worker", mount: "step_up", skipped: [] });
  assert.equal(fixProgress.sameCriterionStall(decorated.rounds, check), 1);
});

const check = "typecheck";
const reviewClaim = "the worker selects a model";
const round = (id: string, head: string, done: Row, dispatch: Row = {}): Row[] => [
  { step: "fix.dispatch", task_id: "unfiled", pr_number: 42, round_id: id, head_sha: head, start_capability: "economy",
    ci_failures: [check], ...dispatch },
  { step: "fix.done", task_id: "unfiled", pr_number: 42, round_id: id, head_sha: head, provider: "codex",
    selected_model: LUNA, ...done },
];
function progress(ledger: Row[], headSha = "a", currentRed = [check], pendingChecks: string[] = []) {
  return fixProgress.buildFixProgressInput({ taskId: "unfiled", prNumber: 42, headSha, currentRed, ledger, pendingChecks });
}
function start(ledger: Row[], head = "a", red = [check], pending: string[] = []) {
  return fixProgress.fixRoundCapabilityFor({ rounds: progress(ledger, head, red, pending).rounds, ledger, currentHead: head });
}

test("W1-T13967 criterion 3: a refused or incomplete Luna repair escalates once and stays at the mount tier", () => {
  for (const subtype of ["commit_refused", "error_incomplete_output"]) {
    const failed = round("first", "a", { subtype });
    const decision = { start: "mount-tier", escalation: { failedRoundId: "first", fromModel: LUNA,
      cause: { kind: "not-landed", subtype } } };
    assert.deepEqual(start(failed), decision);
    assert.deepEqual(start([...failed, ...round("next", "a", { subtype: "commit_refused", selected_model: SOL },
      { start_capability: "balanced" })]), decision);
  }
  assert.deepEqual(start(round("first", "a", { subtype: "commit_refused", selected_model: SOL },
    { start_capability: "balanced", start_reason: "no-codex-capacity" })), { start: "mount-tier" });
});

test("W1-T13967 criterion 3: a landed repair with the same failing criterion escalates on its pushed head", () => {
  const rows = round("first", "a", { pushed_head_sha: "b", subtype: "success" });
  const decision = { start: "mount-tier", escalation: {
    failedRoundId: "first", fromModel: LUNA, cause: { kind: "unmet", criterion: check },
  } };
  assert.deepEqual(start(rows, "b"), decision);
  const ciRetry = round("retry", "a", { subtype: "commit_refused", selected_model: SOL },
    { start_capability: "balanced", start_head_sha: "b" });
  assert.deepEqual(start([...rows, ...ciRetry], "b"), decision);
  assert.equal(fixProgress.sameCriterionStall(progress(rows, "b").rounds, check), 1);
});

test("W1-T13967 criterion 4: infrastructure ends and partial after-reads preserve the routing state", () => {
  const ignored: Row[] = [
    { subtype: "round_yielded" }, { subtype: "admission_abandoned" }, { subtype: "scope_amendment_pending" },
    { subtype: "push_failed" }, { subtype: "signal_terminated", worker_exit: "signal" }, { subtype: "error_exit_null" },
  ];
  for (const [index, outcome] of ignored.entries()) {
    const rows = round(`ignored-${index}`, "a", outcome);
    assert.deepEqual(start(rows), { start: "economy-first" });
    assert.equal(start([...round("failed", "a", { subtype: "commit_refused" }), ...rows]).start, "mount-tier");
  }
  const partial = round("partial", "a", { subtype: "success", pushed_head_sha: "b" });
  assert.deepEqual(start(partial, "b", [check], ["unit"]), { start: "economy-first" });
  assert.equal(start([...round("failed", "a", { subtype: "commit_refused" }), ...partial], "b", [], ["unit"]).start, "mount-tier");
  const scope = round("scope", "a", { subtype: "commit_refused" });
  scope.splice(1, 0, { step: "fix.scope_amendment", task_id: "unfiled", pr_number: 42,
    amendment_number: 113, outcome: "created" });
  assert.deepEqual(start(scope), { start: "economy-first" });
  assert.deepEqual(start([...scope, { step: "pr.terminal", pr_number: 113, state: "merged" }]), { start: "economy-first" });
});

test("W1-T13967 criterion 4: progress, an external head, and another pull request each allow the Luna start", () => {
  const failed = round("failed", "a", { subtype: "commit_refused" });
  assert.deepEqual(start(failed, "operator-push"), { start: "economy-first" });
  assert.deepEqual(start([...failed, ...round("mid-tier", "a", { pushed_head_sha: "b", subtype: "success" },
    { start_capability: "balanced" })], "b", ["lint"]), { start: "economy-first" });
  assert.deepEqual(start(failed.map(row => ({ ...row, pr_number: 43 }))), { start: "economy-first" });
  const before = { claim: reviewClaim, proof_exec: "executed_fail", proofFailureOutput: "old error" };
  const revised = round("revised", "a", { pushed_head_sha: "b", subtype: "success" },
    { ci_failures: [], unmet_claims: [reviewClaim], reviewer_proof_failures: fixProgress.reviewerProofFailures([before]) });
  const after = { ...before, proofFailureOutput: "new error" };
  revised.push({ step: "review.posted", task_id: "unfiled", pr_number: 42, head_sha: "b",
    decision_verdict: { criteria: [after] } });
  const read = progress(revised, "b", [`review:${reviewClaim}`]);
  assert.equal(fixProgress.sameCriterionStall(read.rounds, `review:${reviewClaim}`), 0);
  assert.deepEqual(fixProgress.fixRoundCapabilityFor({ rounds: read.rounds, ledger: revised, currentHead: "b" }), { start: "economy-first" });
});

type FixRun = Parameters<typeof runFixRung>[0];
async function runRung(t: TestContext, options: {
  history?: Row[]; mount?: FixRun["mount"]; attempts?: number;
  onSpawn?: (args: SpawnWorkerArgs) => WorkerResult;
}) {
  const config = checkout(t);
  const rows = [...options.history ?? []];
  const initialRowCount = rows.length;
  const spawns: SpawnWorkerArgs[] = [];
  const review = {
    state: "failure", headSha: "a", summary: "unmet", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, reviewerOutcome: "success", testTheater: false,
    criteria: [{ claim: reviewClaim, proof: "unit test: model selection", met: false, reason: "unmet",
      proof_exec: "executed_fail" }],
  } as const;
  const initialReview: FixRun["initialReview"] = { ...review, criteria: [...review.criteria] };
  await runFixRung({
    taskId: "unfiled", runId: "fix-routing-fixture", task: { id: "unfiled", title: "Model selection" },
    prUrl: "https://github.com/o/r/pull/42", branch: "fixture", worktreePath: config.root,
    initialSessionId: "", mount: options.mount ?? defaultMount, stepUpMount: table.step_up,
    settingsFile: join(REPO_ROOT, "settings/worker.json"), config,
    budgetUsd: 1, strikeCap: options.attempts ?? 1, initialReview,
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: config.root, reviewerMount: defaultMount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      fixProgressJudge: async () => ({ verdict: "continue", reason: "fixture next round" }),
      spawn: async (args) => {
        spawns.push(args);
        assert.ok(spawns.length <= (options.attempts ?? 1), "the fixture only permits its declared rounds");
        return options.onSpawn?.(args) ?? result("codex", SOL);
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...initialReview, headSha: `head-${spawns.length}`,
        state: spawns.length < (options.attempts ?? 1) ? "failure" : "success" }),
      fetchPrBody: async () => "", fetchPrDiffFiles: async () => [],
      push: () => {}, issues: { create: () => "https://github.com/o/r/issues/1" },
      ledgerPath: join(config.root, "ledger.ndjson"), ledgerLines: () => rows,
      readFixRoutingRows: async () => [],
      log: (step, fields) => rows.push({ task_id: "unfiled", ...fields, step }),
      say: () => {}, account: worker => worker,
    },
  });
  return { spawns, rows: rows.slice(initialRowCount) };
}

test("W1-T13967 criterion 2: the dispatch records why the worker used its original mount tier", async t => {
  const run = await runRung(t, { onSpawn: args => {
    assert.equal(args.economyFirst?.codexCapability, "economy");
    args.economyFirst?.onDecision?.("no-codex-capacity");
    return result("claude", "claude-sonnet-5-5");
  } });
  const dispatch = run.rows.find(row => row.step === "fix.dispatch");
  assert.equal(dispatch?.start_reason, "no-codex-capacity");
  assert.equal(dispatch?.start_capability, "balanced");
});

test("W1-T13967 criterion 3: the rung keeps the normal Sonnet/Sol auction and records one escalation", async t => {
  const history = round("failed", "a", { subtype: "error_incomplete_output" });
  const config = checkout(t);
  for (const draw of [0, 0.9999]) {
    const baseline = await route(config, { draw });
    assert.equal(baseline.selected.provider, draw === 0 ? "claude" : "codex");
    assert.equal(baseline.decisions[0]?.applied, true);
    const run = await runRung(t, { history, onSpawn: args => {
      assert.equal(args.economyFirst, undefined);
      assert.equal(args.model, "sonnet");
      assert.ok(args.providerRouting?.learnedArms);
      return result(draw === 0 ? "claude" : "codex", baseline.selected.model);
    } });
    const escalations = run.rows.filter(row => row.step === "fix.economy_escalated");
    assert.equal(escalations.length, 1);
    const { strike, from, to, from_model, to_model, failed_round_id, cause } = escalations[0]!;
    assert.deepEqual({ strike, from, to, from_model, to_model, failed_round_id, cause }, {
      strike: 1, from: "economy", to: "balanced", from_model: LUNA, to_model: baseline.selected.model,
      failed_round_id: "failed", cause: { kind: "not-landed", subtype: "error_incomplete_output" },
    });
    const next = await runRung(t, { history: [...history, ...run.rows.filter(row => row.step === "fix.economy_escalated")] });
    assert.equal(next.spawns[0]?.economyFirst, undefined);
    assert.equal(next.rows.filter(row => row.step === "fix.economy_escalated").length, 0);
  }
});

test("W1-T13967 criterion 4: a different repository's equal PR number does not spend this PR's first round", async t => {
  const history = round("failed", "a", { subtype: "commit_refused" })
    .map(row => ({ ...row, repair_pr_url: "https://github.com/elsewhere/repo/pull/42" }));
  const run = await runRung(t, { history });
  assert.equal(run.spawns[0]?.economyFirst?.codexCapability, "economy");
  assert.equal(run.rows.some(row => row.step === "fix.economy_escalated"), false);
});

test("W1-T13967 criterion 5: the stronger mount and final fresh strike bypass the economy start", async t => {
  const stronger = await runRung(t, { mount: table.step_up });
  assert.equal(stronger.spawns[0]?.model, table.step_up?.model);
  assert.equal(stronger.spawns[0]?.economyFirst, undefined);
  assert.equal(stronger.rows.find(row => row.step === "fix.dispatch")?.start_reason, "step-up");
  const final = await runRung(t, { attempts: 2 });
  assert.deepEqual(final.spawns.map(args => args.model), [defaultMount.model, table.step_up?.model]);
  assert.equal(final.spawns[0]?.economyFirst?.codexCapability, "economy");
  assert.equal(final.spawns[1]?.economyFirst, undefined);
  assert.deepEqual(final.rows.filter(row => row.step === "fix.step_up").map(({ strike, from, to }) => ({ strike, from, to })),
    [{ strike: 2, from: defaultMount.model, to: table.step_up?.model }]);
});
