/**
 * W1-T10877 — the field-trials snapshot counts guardrail fires per model.
 *
 * Truncations, refused formats, dirty drafts, exhausted fix rounds and unnamed served models were
 * scattered across ledger rows with no per-model rate. The snapshot's private `guardrails` family
 * counts fires and opportunities per (model, public category, public guardrail class), through the
 * one public vocabulary (src/lib/public-model-vocabulary.ts), from attributable attempts only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { buildFieldTrialsFlowSnapshot, projectFlowRow, type FieldTrialsLedgerRead } from "#src/lib/field-trials-flow.js";
import { emptyRepoStore } from "#src/lib/field-trials-github.js";
import { benchmarkNonDispatchSpawn, benchmarkWorkerAttemptResources } from "#src/lib/benchmark-run.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";
import { realRiskJudge } from "#src/lib/risk-judge.js";
import { runRelintLoop } from "#src/lib/relint.js";
import { spawnEscalationJudgeWorker } from "#src/lib/escalate.js";
import { inboxDraftExampleFragmentYaml, runDraftRung } from "#src/lib/inbox.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { laneMappedExplicitly, PUBLIC_CATEGORIES, PUBLIC_GUARDRAIL_CLASSES, GUARDRAIL_SIGNALS, publicCategoryOfLane,
  publicGuardrailClassOf } from "#src/lib/public-model-vocabulary.js";
import { CODEX_SERVED_MODEL_REASON, OpenWeightRequestTooLargeError, OpenWeightTruncatedReplyError } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

test("W1-T10877: the public vocabulary is exactly the contract lists", () => {
  assert.deepEqual([...PUBLIC_CATEGORIES], ["repository-change", "code-review", "short-judgment", "summarization",
    "long-context-drafting", "diagnosis-triage"]);
  assert.deepEqual([...PUBLIC_GUARDRAIL_CLASSES], ["independent-model-review", "executable-acceptance-checks",
    "schema-validated-output", "deterministic-sampling", "context-and-rate-fit", "output-cap-truncation-check",
    "bounded-retry-then-escalate", "served-model-verification", "strongest-model-for-high-risk", "per-lane-budget-cap"]);
  // Every signal lands in the closed list, and only the two route properties are never fired by a signal.
  const fired = new Set(GUARDRAIL_SIGNALS.map((signal) => publicGuardrailClassOf(signal)));
  for (const cls of fired) assert.ok(cls !== null && (PUBLIC_GUARDRAIL_CLASSES as readonly string[]).includes(cls), String(cls));
  assert.deepEqual(PUBLIC_GUARDRAIL_CLASSES.filter((cls) => !fired.has(cls)), ["independent-model-review", "executable-acceptance-checks"]);
  assert.equal(publicGuardrailClassOf("truncated-reply"), "output-cap-truncation-check");
  assert.equal(publicGuardrailClassOf("served-model-unnamed"), "served-model-verification");
  // An internal mechanism name the table does not know is never mapped onto a public class.
  assert.equal(publicGuardrailClassOf("OpenWeightTruncatedReplyError"), null);
  assert.equal(publicGuardrailClassOf("toString"), null);
});

test("W1-T10877: every routed lane maps to a public category or explicitly to none", () => {
  const mounts = parse(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as Record<string, unknown>;
  const keys = (value: unknown) => value !== null && typeof value === "object" ? Object.keys(value) : [];
  const rows = Object.entries(mounts).filter(([, value]) => typeof (value as { model?: unknown } | null)?.model === "string")
    .map(([key]) => key);
  const lanes = [...keys(mounts.routes), ...keys(mounts.synthesis), ...rows];
  // Positive control: the walk saw the routes table, the synthesis rows and the standalone mount rows.
  for (const known of ["implement", "reviewer", "inbox_draft", "triage", "escalation_judge", "architect"]) {
    assert.ok(lanes.includes(known), `the routing walk saw ${known}`);
  }
  for (const lane of lanes) {
    assert.ok(laneMappedExplicitly(lane), `${lane} is mapped to a public category or explicitly to null`);
    const category = publicCategoryOfLane(lane);
    assert.ok(category === null || (PUBLIC_CATEGORIES as readonly string[]).includes(category), `${lane} -> ${category}`);
  }
  assert.equal(publicCategoryOfLane("implement"), "repository-change");
  assert.equal(publicCategoryOfLane("inbox_draft"), "long-context-drafting");
  assert.equal(publicCategoryOfLane("escalation_judge"), "short-judgment");
  // A lane nobody mapped is never published by default.
  assert.equal(laneMappedExplicitly("brand-new-lane"), false);
  assert.equal(publicCategoryOfLane("brand-new-lane"), null);
  for (const unpublished of ["containment", "isolation", "worker-smoke"]) {
    assert.equal(laneMappedExplicitly(unpublished), true);
    assert.equal(publicCategoryOfLane(unpublished), null);
  }
  assert.equal(publicCategoryOfLane(null), null);
});

function observedRead(rows: Record<string, unknown>[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: rows.map((row, i) => projectFlowRow(row, `fp-${i}`)) };
}

/** A dispatch assignment: its lane rides the benchmark receipt's task shape, as run-task writes it. */
function dispatched(id: string, model: string): Record<string, unknown> {
  return { ts: T(10), step: "worker.assignment", host: "host-a", task_id: `task-${id}`, run_id: `run-${id}`,
    worker_assignment: { id, selected: { provider: "codex", model, effort: "high" } },
    benchmark_run: { work: { shape: { lane: { state: "observed", value: "run-task" } } } } };
}

function attempt(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { ts: T(10, 1), step: "worker.attempt", host: "host-a", task_id: `task-${id}`, run_id: `run-${id}`,
    selection_assignment_id: id, ...fields };
}

const TOKENS = { input: 1200, output: 300 };

function retainedCodexAttempt(id: string, outputRetention: WorkerResult["outputRetention"]) {
  const result: WorkerResult = { provider: "codex", sessionId: id, model: "gpt-6.1-sol", effort: "high",
    costUsd: 0, numTurns: 1, text: "private reply", blocks: ["private block"], stderr: "private stderr",
    subtype: "error_incomplete_output", isError: true, apiError: false, exit: { kind: "exit", code: 0 },
    permissionDenials: [], childEnvKeys: [], modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    tokens: { ...TOKENS, cacheRead: 0, cacheCreation: 0 }, outputRetention };
  return attempt(id, { success: !result.isError, ...benchmarkWorkerAttemptResources(result) });
}

const RETAINED: NonNullable<WorkerResult["outputRetention"]> = {
  text: { state: "truncated", bytesRead: 1024 }, blocks: { state: "truncated", bytesRead: 1024 },
  stdout: { state: "complete", bytesRead: 2048 }, stderr: { state: "complete", bytesRead: 0 },
  completion: { state: "complete" }, originalSubtype: "success",
};

function fixRound(id: string, model: string, fields: Record<string, unknown> = {}): Record<string, unknown>[] {
  const receipt = { host: "host-a", task_id: "task-fix", run_id: "fix-run", repair_round_id: id,
    worker_run_id: `worker-${id}`, worker_rung: "fix", selection_assignment_id: `selection-${id}` };
  return [
    { ts: T(10, 4), step: "worker.attempt", ...receipt, success: true, served_model: model, tokens: TOKENS, ...fields },
    { ts: T(10, 5), step: "fix.done", ...receipt, round_id: id, requested_model: "sonnet", served_model: model },
  ];
}

function snapshotOf(rows: Record<string, unknown>[], prior?: ReturnType<typeof buildFieldTrialsFlowSnapshot>) {
  return buildFieldTrialsFlowSnapshot({ asOf: T(11), sources: [{ label: "core", repo: "acme/core", ledger: observedRead(rows) }],
    github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } }, ...(prior ? { prior } : {}) });
}

test("W1-T10877: guardrail fires are counted per model, category and class", async t => {
  const sol = "gpt-6.1-sol";
  const sonnet = "claude-sonnet-5-5";
  const rows: Record<string, unknown>[] = [
    // Three attributable Sol attempts: a clean success, a truncated reply, and a success whose served model is unnamed.
    dispatched("a1", sol), attempt("a1", { success: true, served_model: sol, tokens: TOKENS }),
    dispatched("a2", sol), attempt("a2", { success: false, served_model: sol, tokens: TOKENS,
      error_class: OpenWeightTruncatedReplyError.name }),
    dispatched("a3", sol), attempt("a3", { success: true, served_model: null, served_model_reason: CODEX_SERVED_MODEL_REASON,
      tokens: TOKENS }),
    // A Codex incomplete-output result has usage but no served model or reply error class.
    dispatched("a6", sol), retainedCodexAttempt("a6", RETAINED),
    // A pre-request refusal and an infrastructure kill are not the model's: neither a fire nor an opportunity.
    dispatched("a4", sol), attempt("a4", { success: false, served_model: null, worker_failure: "spawn-threw-before-result",
      error_class: OpenWeightRequestTooLargeError.name }),
    dispatched("a5", sol), attempt("a5", { success: false, served_model: null, worker_exit: "signal", worker_exit_signal: "SIGKILL" }),
    // A non-dispatch review attempt that broke the draft contract.
    { ts: T(10, 2), step: "worker.attempt", lane: "review", task_id: "REVIEW", run_id: "review-1", selection_assignment_id: "r1",
      success: false, served_model: sonnet, worker_failure: "draft-contract", tokens: TOKENS },
    // Unpublished, unmapped and draft-unit lanes never count as attempts.
    { ts: T(10, 2), step: "worker.attempt", lane: "containment", run_id: "c-1", selection_assignment_id: "c1", success: true, served_model: sonnet },
    { ts: T(10, 2), step: "worker.attempt", lane: "brand-new-lane", run_id: "n-1", selection_assignment_id: "n1", success: true, served_model: sonnet },
    { ts: T(10, 2), step: "worker.attempt", lane: "inbox-draft", run_id: "d-1", selection_assignment_id: "d1", success: true, served_model: null },
    // Drafts are the long-context-drafting unit: a dirty draft, and a clean one whose served model is unnamed.
    { ts: T(10, 3), step: "inbox.drafted", proposal_id: "p1", requested_model: "haiku", served_model: "gpt-oss-120b", lint_clean: false },
    { ts: T(10, 3), step: "inbox.drafted", proposal_id: "p2", requested_model: "haiku", served_model: null,
      served_model_reason: "the provider reported no served model for this call", lint_clean: true },
    // Fix rows join their own worker receipts. Refusal + done + exhaustion still describe one round.
    ...fixRound("f1", sonnet),
    { ts: T(10, 5), step: "fix.commit_refused", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      round_id: "f1", requested_model: "sonnet", served_model: sonnet },
    { ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      requested_model: "sonnet", served_model: sonnet },
    ...fixRound("f2", sonnet).map((row) => ({ ...row, ts: T(10, row.step === "worker.attempt" ? 7 : 8) })),
    { ts: T(10, 4), step: "fix.done", task_id: "task-f3", run_id: "fix-3" },
  ];
  const snapshot = snapshotOf(rows);
  const cells = Object.fromEntries(Object.entries(snapshot.families.guardrails).map(([key, partition]) => [key, partition.cells]));
  const cell = (modelId: string, category: string, guardrailClass: string, opportunities: number, fires: number) =>
    [`${modelId}|${category}|${guardrailClass}`, { modelId, category, guardrailClass, opportunities, fires }] as const;
  assert.deepEqual(cells, Object.fromEntries([
    cell(sonnet, "code-review", "output-cap-truncation-check", 1, 0),
    cell(sonnet, "code-review", "schema-validated-output", 1, 1),
    cell(sonnet, "code-review", "served-model-verification", 1, 0),
    cell(sonnet, "repository-change", "bounded-retry-then-escalate", 2, 1),
    cell(sonnet, "repository-change", "output-cap-truncation-check", 2, 0),
    cell(sonnet, "repository-change", "schema-validated-output", 2, 0),
    cell(sonnet, "repository-change", "served-model-verification", 2, 0),
    cell(sol, "repository-change", "output-cap-truncation-check", 4, 2),
    cell(sol, "repository-change", "schema-validated-output", 4, 0),
    cell(sol, "repository-change", "served-model-verification", 4, 2),
    cell("gpt-oss-120b", "long-context-drafting", "schema-validated-output", 1, 1),
    cell("gpt-oss-120b", "long-context-drafting", "served-model-verification", 1, 0),
    cell("haiku", "long-context-drafting", "schema-validated-output", 1, 0),
    cell("haiku", "long-context-drafting", "served-model-verification", 1, 1),
  ].sort(([a], [b]) => a.localeCompare(b))));
  assert.ok(snapshot.rebuild.rebuiltPartitions.includes(`guardrails:${sol}|repository-change|output-cap-truncation-check`));
  // The family follows the rebuild pattern: an unchanged ledger reuses every guardrail partition verbatim.
  const again = snapshotOf(rows, snapshot);
  assert.equal(again.rebuild.rebuiltPartitions.some((key) => key.startsWith("guardrails:")), false);
  assert.deepEqual(again.families.guardrails, snapshot.families.guardrails);
  // The family is private: the internal lane and mechanism names never appear in it.
  const text = JSON.stringify(snapshot.families.guardrails);
  for (const internal of ["run-task", "inbox-draft", "fix.exhausted", OpenWeightTruncatedReplyError.name, "draft-contract\""]) {
    assert.equal(text.includes(internal), false, internal);
  }
  await productionJudgeGuardrails(t);
  await productionSamplingPins(t);
});

/** The deterministic-sampling cell from production receipts: a cash request to a pinned deployment fires, one to a
 *  default-only deployment is an unfired opportunity, and a non-cash request is no opportunity at all. */
async function productionSamplingPins(t: TestContext) {
  const root = ownedFixtureDir(t, "sampling-pin-receipts").dir;
  const served: Array<{ provider: "cash" | "codex"; model: string }> = [
    { provider: "cash", model: "gpt-oss-120b" }, { provider: "cash", model: "gpt-5-nano" }, { provider: "codex", model: "gpt-6.1-sol" }];
  let calls = 0;
  const spawn = benchmarkNonDispatchSpawn("risk-judge", async args => {
    const { provider, model } = served[calls++]!;
    const id = `pin-${calls}`;
    args.onSelectionAssignment?.({ version: 1, id, phase: "pre-execution", requested: { model, effort: "medium", maxTurns: 1 },
      selected: { provider, model, effort: "medium" },
      routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] });
    return { sessionId: id, selectionAssignmentId: id, provider, model, servedModel: model, effort: "medium", costUsd: 0,
      numTurns: 1, text: LOW_RISK, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
      permissionDenials: [], childEnvKeys: [], tokens: { ...TOKENS, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
      compactionEvents: [], qualitySuspect: false } as WorkerResult;
  });
  for (const _ of served) {
    await spawn({ cwd: root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "judge",
      model: MOUNT.model, effort: MOUNT.effort, maxTurns: 1, config: { root } as Config });
  }
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map(line => ({ ...JSON.parse(line), ts: T(10) }) as Record<string, unknown>);
  assert.deepEqual(rows.filter(row => row.step === "worker.attempt").map(row => row.sampling_pin), [
    { deployment: "gpt-oss-120b", temperature: 0 }, { deployment: "gpt-5-nano", temperature: null }, undefined],
    "the producer records the pin each cash request carried");
  const guardrails = snapshotOf(rows).families.guardrails;
  const sampling = (modelId: string) => guardrails[`${modelId}|short-judgment|deterministic-sampling`]?.cells;
  assert.deepEqual(sampling("gpt-oss-120b"), { modelId: "gpt-oss-120b", category: "short-judgment",
    guardrailClass: "deterministic-sampling", opportunities: 1, fires: 1 }, "a pinned request fires");
  assert.deepEqual(sampling("gpt-5-nano"), { modelId: "gpt-5-nano", category: "short-judgment",
    guardrailClass: "deterministic-sampling", opportunities: 1, fires: 0 }, "a default-only deployment is an unfired opportunity");
  assert.equal(sampling("gpt-6.1-sol"), undefined, "a non-cash request is no sampling opportunity");
}

const MOUNT = { model: "haiku", effort: "medium" as const, maxTurns: 1, contextBudget: 1000 };
const LOW_RISK = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: routine change";
const judgeInput = { change: { description: "routine change", files: ["src/lib/inbox.ts"] },
  gatesState: { lint: "pass" as const, typecheck: "pass" as const, tests: "pass" as const },
  planContext: { taskId: "W1-T10877", planRefs: [] } };

function productionReceipts(t: TestContext, lane: string, replies: Array<{ model: string; text: string }>) {
  const root = ownedFixtureDir(t, "guardrail-receipts").dir;
  let calls = 0;
  const spawn = benchmarkNonDispatchSpawn(lane, async args => {
    const reply = replies[calls++];
    assert.ok(reply, "the production loop stays within its supplied response bound");
    const id = `production-${calls}`;
    const assignment: WorkerSelectionAssignment = { version: 1, id, phase: "pre-execution",
      requested: { model: MOUNT.model, effort: MOUNT.effort, maxTurns: 1 },
      selected: { provider: "codex", model: reply.model, effort: MOUNT.effort },
      routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] };
    args.onSelectionAssignment?.(assignment);
    return { sessionId: id, selectionAssignmentId: id, provider: "codex", model: reply.model,
      servedModel: reply.model, effort: MOUNT.effort, costUsd: 0, numTurns: 1, text: reply.text,
      blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [],
      childEnvKeys: [], tokens: { ...TOKENS, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
      compactionEvents: [], qualitySuspect: false };
  });
  return { root, spawn: (args: SpawnWorkerArgs) => spawn({ ...args, config: { root } as Config }),
    rows: () => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map(line => ({ ...JSON.parse(line), ts: T(10) }) as Record<string, unknown>) };
}

function assertRetryCell(rows: Record<string, unknown>[], modelId: string, category: string, opportunities: number, fires: number) {
  const guardrailClass = "bounded-retry-then-escalate";
  assert.deepEqual(snapshotOf(rows).families.guardrails[`${modelId}|${category}|${guardrailClass}`]?.cells,
    { modelId, category, guardrailClass, opportunities, fires });
}

async function productionJudgeGuardrails(t: TestContext) {
  const sol = "gpt-6.1-sol", sonnet = "claude-sonnet-5-5";
  for (const exhausted of [false, true]) {
    const receipts = productionReceipts(t, "risk-judge", [
      { model: sol, text: "private unparseable output" }, { model: sol, text: "still malformed" },
      { model: sonnet, text: exhausted ? "also malformed" : LOW_RISK }]);
    const judge = realRiskJudge({ mount: MOUNT, cwd: receipts.root, settingsFile: "settings.json",
      spawn: receipts.spawn, maxAttempts: 3 });
    const verdict = await judge(judgeInput);
    assert.equal(verdict.verdict, exhausted ? "high" : "low");
    if (exhausted) assert.equal(verdict.availability, "unavailable");
    const rows = receipts.rows();
    assert.deepEqual(rows.filter(row => row.step === "worker.attempt").map(row => row.guardrail_attempt),
      [1, 2, 3].map(attempt => ({ signal: "judge-retry", attempt })));
    assertRetryCell(rows, sol, "short-judgment", 2, 1);
    assertRetryCell(rows, sonnet, "short-judgment", 1, 1);
    const initial = snapshotOf(rows);
    const key = `${sonnet}|short-judgment|bounded-retry-then-escalate`;
    const cleaned = rows.map(row => row.step === "worker.attempt" && row.served_model === sonnet
      ? { ...row, guardrail_attempt: { signal: "judge-retry", attempt: 1 } } : row);
    const rebuilt = snapshotOf(cleaned, initial);
    assert.equal(rebuilt.families.guardrails[key]?.cells.fires, 0);
    assert.ok(rebuilt.rebuild.rebuiltPartitions.includes(`guardrails:${key}`));
    assert.deepEqual(snapshotOf(cleaned, rebuilt).families.guardrails, rebuilt.families.guardrails);
    for (const excluded of [{ worker_exit: "signal", worker_exit_signal: "SIGKILL", success: false },
      { worker_failure: "orphaned-by-process-exit", success: false }, { success: null }, { lane: "worker-smoke" }]) {
      const altered = rows.map(row => row.step === "worker.attempt" && row.served_model === sonnet ? { ...row, ...excluded } : row);
      assert.equal(snapshotOf(altered).families.guardrails[key], undefined);
      assertRetryCell(altered, sol, "short-judgment", 2, 1);
    }
    for (const invalid of [{ signal: "private unknown signal", attempt: 2 }, { signal: "judge-retry", attempt: 0 },
      { signal: "judge-retry", attempt: 1.5 }, { signal: "judge-retry", attempt: "2" }]) {
      const row = rows.find(row => row.step === "worker.attempt")!;
      const projected = projectFlowRow({ ...row, guardrail_attempt: invalid }, "invalid");
      assert.equal(projected.outcomeSignals?.guardrail_attempt, undefined);
      assert.equal(JSON.stringify(projected).includes("private"), false);
    }
  }
}

test("W1-T10877: production relints count initial opportunities and retried calls", async t => {
  const model = "gpt-6.1-sol";
  const receipts = productionReceipts(t, "triage", [{ model, text: "filed" }, { model, text: "filed" }]);
  const result = await runRelintLoop({ lane: "triage", filedIds: ["W1-T10877"], initialPrompt: "file tasks", maxAttempts: 2,
    run: (prompt) => receipts.spawn({ cwd: receipts.root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt }),
    filed: () => true, lint: () => [{ severity: "block", check: "draft-parse", message: "malformed task" }], log: () => {} });
  assert.equal(result.stop, "exhausted");
  assertRetryCell(receipts.rows(), model, "diagnosis-triage", 2, 1);
  // The async context ends with the loop; an unrelated call is never a retry opportunity.
  const other = productionReceipts(t, "triage", [{ model, text: "ordinary call" }]);
  await other.spawn({ cwd: other.root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "ordinary" });
  assertRetryCell([...receipts.rows(), ...other.rows()], model, "diagnosis-triage", 2, 1);
});

test("W1-T10877: inbox retries count calls while draft checks count the final draft", async t => {
  const model = "gpt-6.1-sol", rescue = "claude-sonnet-5-5";
  const dirty = "=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: model attribution";
  const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: model attribution`;
  const receipts = productionReceipts(t, "inbox-draft", [{ model, text: dirty }, { model, text: dirty },
    { model, text: dirty }, { model: rescue, text: clean }]);
  const drafted: Record<string, unknown>[] = [];
  const spawn = (_proposal: unknown, prompt: string) => receipts.spawn({ cwd: receipts.root,
    permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt });
  const outcomes = await runDraftRung([{ id: "P9", summary: "model attribution", evidenceAnchors: [] }], "- id: W1-T1\n",
    { spawn, escalate: spawn, log: (step, fields) => { drafted.push({ step, ...fields, ts: T(10) }); } }, "guardrail-draft");
  assert.equal(outcomes[0]!.ok, true);
  const rows = [...receipts.rows(), ...drafted];
  assertRetryCell(rows, model, "long-context-drafting", 3, 2);
  assertRetryCell(rows, rescue, "long-context-drafting", 1, 1);
  assert.deepEqual(snapshotOf(rows).families.guardrails[`${rescue}|long-context-drafting|schema-validated-output`]?.cells,
    { modelId: rescue, category: "long-context-drafting", guardrailClass: "schema-validated-output", opportunities: 1, fires: 0 });
  assert.equal(snapshotOf(rows).families.guardrails[`${model}|long-context-drafting|schema-validated-output`], undefined);
});

test("W1-T10877: production escalation judgments retain their short judgment category", async t => {
  const model = "gpt-6.1-sol";
  const receipts = productionReceipts(t, "escalation-summary", [{ model, text: "deliver" }, { model, text: "summary" }]);
  await spawnEscalationJudgeWorker({ escalation: { class: "BLOCKED", taskId: "W1-T10877", summary: "blocked",
    detail: "operator decision", options: [{ label: "retry", detail: "retry the task" }], recommendation: "retry" },
    mount: MOUNT, cwd: receipts.root, settingsFile: "settings.json", spawn: receipts.spawn });
  await receipts.spawn({ cwd: receipts.root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "summarize" });
  const rows = receipts.rows();
  assert.deepEqual(rows.filter(row => row.step === "worker.attempt").map(row => [row.lane, row.guardrail_lane]),
    [["escalation-summary", "escalation-judge"], ["escalation-summary", undefined]], "the receipt keeps its spawn lane");
  for (const category of ["short-judgment", "summarization"]) {
    assert.deepEqual(snapshotOf(rows).families.guardrails[`${model}|${category}|served-model-verification`]?.cells,
      { modelId: model, category, guardrailClass: "served-model-verification", opportunities: 1, fires: 0 });
  }
});

test("W1-T10877: output retention survives the producer and projection and fires once per attempt", () => {
  const key = "gpt-6.1-sol|repository-change|output-cap-truncation-check";
  const expected = (fires: number) => ({ modelId: "gpt-6.1-sol", category: "repository-change",
    guardrailClass: "output-cap-truncation-check", opportunities: 1, fires });
  for (const channel of ["text", "blocks", "stdout", "stderr", "completion"] as const) {
    const states = channel === "completion" ? ["complete", "absent", "malformed"] as const
      : ["complete", "truncated", "unreadable", "malformed", "absent"] as const;
    for (const state of states) {
      const retention = { text: { state: "complete", bytesRead: 0 }, blocks: { state: "complete", bytesRead: 0 },
        stdout: { state: "complete", bytesRead: 0 }, stderr: { state: "complete", bytesRead: 0 },
        completion: { state: "complete" }, originalSubtype: "success",
        [channel]: { state, bytesRead: 0, reason: "private retention reason" } } as NonNullable<WorkerResult["outputRetention"]>;
      const row = retainedCodexAttempt("retained", retention);
      const projected = projectFlowRow(row, "retained");
      assert.equal(JSON.stringify(projected).includes("private"), false);
      assert.deepEqual(snapshotOf([dispatched("retained", "gpt-6.1-sol"), row]).families.guardrails[key]?.cells,
        expected(state === "complete" ? 0 : 1), `${channel}: ${state}`);
    }
  }
  const row = retainedCodexAttempt("both", RETAINED);
  const rows = [dispatched("both", "gpt-6.1-sol"), row];
  const initial = snapshotOf(rows);
  assert.deepEqual(initial.families.guardrails[key]?.cells, expected(1));
  const replyAndRetention = { ...row, error_class: OpenWeightTruncatedReplyError.name };
  assert.deepEqual(snapshotOf([rows[0]!, replyAndRetention]).families.guardrails[key]?.cells, expected(1));
  for (const excluded of [{ worker_exit: "signal", worker_exit_signal: "SIGKILL" },
    { worker_failure: "orphaned-by-process-exit" }, { success: null }, { lane: "worker-smoke" }]) {
    assert.equal(snapshotOf([rows[0]!, { ...row, ...excluded }]).families.guardrails[key], undefined);
  }
  const clean = { ...row, output_retention: { text: { state: "complete" } } };
  const rebuilt = snapshotOf([rows[0]!, clean], initial);
  assert.deepEqual(rebuilt.families.guardrails[key]?.cells, expected(0));
  assert.ok(rebuilt.rebuild.rebuiltPartitions.includes(`guardrails:${key}`));
  const untrusted = { ...row, output_retention: { text: { state: "private unknown state" },
    prompt: { state: "truncated", reason: "private" } } };
  assert.equal(JSON.stringify(projectFlowRow(untrusted, "unknown")).includes("private"), false);
  assert.deepEqual(snapshotOf([rows[0]!, untrusted]).families.guardrails[key]?.cells, expected(0));
});

test("W1-T10877: an attributable inbox-draft call counts its truncation fires, and its draft contract only on inbox.drafted", () => {
  const model = "gpt-6.1-sol";
  const truncation = `${model}|long-context-drafting|output-cap-truncation-check`;
  const contract = `${model}|long-context-drafting|schema-validated-output`;
  const call = { ...retainedCodexAttempt("draft", RETAINED), lane: "inbox-draft" };
  const alone = snapshotOf([dispatched("draft", model), call]).families.guardrails;
  assert.deepEqual(alone[truncation]?.cells, { modelId: model, category: "long-context-drafting",
    guardrailClass: "output-cap-truncation-check", opportunities: 1, fires: 1 }, "a truncated draft call fires");
  assert.equal(alone[contract], undefined, "the producing call is never a draft-contract opportunity");
  const clean = { ...call, output_retention: { text: { state: "complete" } } };
  assert.equal(snapshotOf([dispatched("draft", model), clean]).families.guardrails[truncation]?.cells.fires, 0);
  const drafted = { ts: T(10, 3), step: "inbox.drafted", proposal_id: "p9", requested_model: model, served_model: model, lint_clean: false };
  const both = snapshotOf([dispatched("draft", model), call, drafted]).families.guardrails;
  assert.deepEqual(both[contract]?.cells, { modelId: model, category: "long-context-drafting",
    guardrailClass: "schema-validated-output", opportunities: 1, fires: 1 }, "the draft contract is counted once, on inbox.drafted");
  assert.equal(both[truncation]?.cells.opportunities, 1, "inbox.drafted adds no truncation opportunity");
});

test("W1-T10877: fix opportunities exclude infrastructure, refusals, unknown and missing attempts", () => {
  const model = "claude-sonnet-5-5";
  const excluded = [
    { success: false, worker_exit: "signal", worker_exit_signal: "SIGKILL" },
    { success: false, worker_failure: "orphaned-by-process-exit" },
    { success: false, served_model: null, tokens: {}, error_class: OpenWeightRequestTooLargeError.name },
    { success: false, served_model: null, tokens: {} },
    { success: null },
  ];
  for (const [index, fields] of excluded.entries()) {
    const rows = [...fixRound("control", model), ...fixRound(`excluded-${index}`, model, fields)];
    rows.push({ ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      round_id: `excluded-${index}`, requested_model: "sonnet", served_model: model });
    const cell = snapshotOf(rows).families.guardrails[`${model}|repository-change|bounded-retry-then-escalate`]?.cells;
    assert.deepEqual(cell, { modelId: model, category: "repository-change",
      guardrailClass: "bounded-retry-then-escalate", opportunities: 1, fires: 0 }, JSON.stringify(fields));
  }
  const [, done] = fixRound("no-attempt", model);
  assert.deepEqual(snapshotOf([done!]).families.guardrails, {});
  // A terminal signal is authoritative even when a worker receipt reports a success envelope.
  const signalled = fixRound("signal", model);
  signalled[1] = { ...signalled[1], worker_exit: "signal", worker_exit_signal: "SIGTERM" };
  assert.equal(snapshotOf(signalled).families.guardrails[`${model}|repository-change|bounded-retry-then-escalate`], undefined);
});

test("W1-T10877: fix events consolidate by round and cannot borrow another run's attribution", () => {
  const model = "claude-sonnet-5-5";
  const rows = fixRound("round-1", model, { success: false, worker_failure: "draft-contract" });
  rows.push({ ...rows[1], step: "fix.commit_refused" }, { ...rows[1], step: "fix.stood_down" },
    { ...rows[1], step: "fix.exhausted", ts: T(10, 6) });
  const key = `${model}|repository-change|bounded-retry-then-escalate`;
  const expected = { modelId: model, category: "repository-change", guardrailClass: "bounded-retry-then-escalate",
    opportunities: 1, fires: 1 };
  const snapshot = snapshotOf(rows);
  assert.deepEqual(snapshot.families.guardrails[key]?.cells, expected);
  assert.deepEqual(snapshotOf([...rows].reverse()).families.guardrails[key]?.cells, expected);
  // Older receipts can join by worker or assignment id when round fields are absent.
  for (const identity of ["worker_run_id", "selection_assignment_id"]) {
    const legacy = { ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      [identity]: rows[0]![identity], requested_model: "sonnet", served_model: model };
    assert.deepEqual(snapshotOf([rows[0]!, legacy]).families.guardrails[key]?.cells, expected, identity);
  }
  const anonymous = rows.map((row) => ({ ...row, task_id: null, run_id: null }));
  assert.equal(snapshotOf([anonymous[0]!, { ts: T(10, 6), step: "fix.exhausted", host: "host-a",
    requested_model: "sonnet", served_model: model }]).families.guardrails[key], undefined);
  for (const field of ["host", "task_id", "run_id", "round_id"]) {
    const foreign = { ...rows[1], [field]: "another", step: "fix.exhausted" };
    assert.equal(snapshotOf([rows[0]!, foreign]).families.guardrails[key], undefined, field);
  }
  // A later infrastructure result in the same round cannot reuse an earlier model fallback.
  const killed = { ...rows[0], ts: T(10, 5), success: false, worker_failure: "spawn-threw-before-result",
    worker_exit: "signal", worker_exit_signal: "SIGKILL" };
  const repaired = snapshotOf([rows[0]!, killed, ...rows.slice(1)], snapshot);
  assert.equal(repaired.families.guardrails[key], undefined);
  assert.deepEqual(snapshotOf(rows, repaired).families.guardrails[key]?.cells, expected);
});
