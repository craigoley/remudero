import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import { runOpenWeightWalkingLadder, spawnWorker } from "../src/lib/worker.js";
import { clearOpenWeightAbsence } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function assignment(id: string, provider: "cash" | "codex", model: string): WorkerSelectionAssignment {
  return { version: 1, id, phase: "pre-execution",
    requested: { model: "requested", effort: "medium", maxTurns: 2 },
    selected: { provider, model, effort: "medium" },
    routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [] };
}

function result(provider: "cash" | "codex", model: string, id: string, isError = false): WorkerResult {
  return { sessionId: id, costUsd: 0.25, numTurns: 1, text: "", blocks: [], stderr: "",
    subtype: isError ? "error" : "success", isError, apiError: false,
    permissionDenials: [], childEnvKeys: [], model, routedModel: model, servedModel: model,
    effort: "medium", provider, tokens: { input: 4, output: 2, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    selectionAssignmentId: id, workerDurationMs: 11 } as WorkerResult;
}

function rows(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function args(root: string): SpawnWorkerArgs {
  return { cwd: root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "sensitive-prompt-sentinel",
    config: { root } as Config };
}

test("non-dispatch benchmark attempts cover cash review triage and judge lanes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-nondispatch-"));
  try {
    for (const [index, lane, provider] of [[0, "inbox-draft", "cash"], [1, "review", "codex"],
      [2, "triage", "codex"], [3, "verify-human-judge", "codex"]] as const) {
      const id = `assignment-${index}`;
      const raw = (async (input: SpawnWorkerArgs) => {
        input.onSelectionAssignment?.(assignment(id, provider, `model-${index}`));
        return result(provider, `model-${index}`, id);
      }) as typeof spawnWorker;
      const returned = await benchmarkNonDispatchSpawn(lane, raw)(args(root));
      assert.equal(returned.selectionAssignmentId, id, "instrumentation does not alter the worker result");
    }
    const ledger = rows(root);
    assert.equal(ledger.filter((row) => row.step === "worker.assignment").length, 4);
    const attempts = ledger.filter((row) => row.step === "worker.attempt");
    assert.equal(attempts.length, 4);
    assert.ok(attempts.every((row) => (row.benchmark_run as Record<string, unknown>)?.phase === "attempt"));
    assert.equal(ledger.filter((row) => row.step === "verdict").length, 0, "worker calls are not task outcomes");
    const cash = attempts.find((row) => row.lane === "inbox-draft")!;
    assert.deepEqual(((cash.benchmark_run as Record<string, unknown>).accounting as Record<string, unknown>).apiCostUsd,
      { state: "observed", value: 0.25 });
    assert.equal((((cash.benchmark_run as Record<string, unknown>).accounting as Record<string, unknown>)
      .subscriptionNotionalUsd as Record<string, unknown>).state, "unavailable");
    assert.doesNotMatch(JSON.stringify(ledger.map((row) => row.benchmark_run)), /sensitive-prompt-sentinel|assignment-0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("codex subscription cost and token placeholders remain unknown while measured cash zero remains zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-cost-missingness-"));
  try {
    for (const [provider, lane] of [["codex", "review"], ["cash", "inbox-draft"]] as const) {
      const raw = (async (input: SpawnWorkerArgs) => {
        input.onSelectionAssignment?.(assignment(`${provider}-assignment`, provider, `${provider}-model`));
        return { ...result(provider, `${provider}-model`, `${provider}-assignment`), costUsd: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
      }) as typeof spawnWorker;
      await benchmarkNonDispatchSpawn(lane, raw)(args(root));
    }
    const attempts = rows(root).filter((row) => row.step === "worker.attempt");
    const accounting = (provider: string) => (attempts.find((row) => row.lane ===
      (provider === "codex" ? "review" : "inbox-draft"))!.benchmark_run as Record<string, unknown>)
      .accounting as Record<string, unknown>;
    assert.deepEqual(accounting("codex").subscriptionNotionalUsd,
      { state: "unavailable", reason: "worker-cost-not-reported" });
    assert.deepEqual(accounting("cash").apiCostUsd, { state: "observed", value: 0 });
    const codex = attempts.find((row) => row.lane === "review")!.benchmark_run as Record<string, unknown>;
    const cash = attempts.find((row) => row.lane === "inbox-draft")!.benchmark_run as Record<string, unknown>;
    assert.deepEqual(codex.tokens, { state: "unavailable", reason: "worker-tokens-not-reported" });
    assert.deepEqual(cash.tokens, { state: "observed", value: { input: 0, output: 0 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-dispatch benchmark attempts separate fallback calls from task outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-fallback-"));
  try {
    for (const [id, provider, failed] of [["fallback-first", "codex", true], ["fallback-second", "cash", false]] as const) {
      const raw = (async (input: SpawnWorkerArgs) => {
        input.onSelectionAssignment?.(assignment(id, provider, id));
        return result(provider, id, id, failed);
      }) as typeof spawnWorker;
      await benchmarkNonDispatchSpawn("review", raw)(args(root));
    }
    const ledger = rows(root);
    const attempts = ledger.filter((row) => row.step === "worker.attempt");
    assert.deepEqual(attempts.map((row) => row.selection_assignment_id), ["fallback-first", "fallback-second"]);
    assert.deepEqual(attempts.map((row) => row.success), [false, true]);
    assert.deepEqual(attempts.map((row) => row.billing_mode), ["subscription", "api"]);
    assert.equal(ledger.some((row) => row.step === "verdict"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cash ladder fallback attempts keep each selected model and cost on its own assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-cash-rungs-"));
  clearOpenWeightAbsence();
  try {
    const raw = (async (input: SpawnWorkerArgs) => {
      let id = "rung-one";
      input.onSelectionAssignment?.(assignment(id, "cash", "cash-a"));
      return runOpenWeightWalkingLadder(async (selection) => {
        if (selection.model === "cash-a") return { ...result("cash", "cash-a", id, true),
          costUsd: 0, openWeightDeploymentAbsent: "cash-a" };
        id = "rung-two";
        input.onSelectionAssignment?.(assignment(id, "cash", "cash-b"));
        return result("cash", "cash-b", id);
      }, { model: "cash-a", effort: "medium", capability: "balanced", alternatives: ["cash-b"] } as never,
      (attempt) => input.onModelFallbackAttempt?.({ selectionAssignmentId: id,
        model: attempt.selection.model, reason: attempt.reason, result: attempt.result }));
    }) as typeof spawnWorker;
    const final = await benchmarkNonDispatchSpawn("inbox-draft", raw)(args(root));
    assert.equal(final.selectionAssignmentId, "rung-two");
    const ledger = rows(root);
    assert.deepEqual(ledger.filter((row) => row.step === "worker.assignment")
      .map((row) => (row.worker_assignment as WorkerSelectionAssignment).selected.model), ["cash-a", "cash-b"]);
    const attempts = ledger.filter((row) => row.step === "worker.attempt");
    assert.deepEqual(attempts.map((row) => row.selection_assignment_id), ["rung-one", "rung-two"]);
    assert.deepEqual(attempts.map((row) => row.success), [false, true]);
    assert.deepEqual(attempts.map((row) => row.total_cost_usd), [0, 0.25]);
    assert.equal(ledger.some((row) => row.step === "verdict"), false);
  } finally { clearOpenWeightAbsence(); rmSync(root, { recursive: true, force: true }); }
});

test("real cash worker boundary emits a distinct assignment for each walked model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-real-cash-"));
  clearOpenWeightAbsence();
  try {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const models: string[] = [];
    const final = await benchmarkNonDispatchSpawn("inbox-draft", spawnWorker)({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile,
      prompt: "bounded cash request",
      model: "sonnet",
      effort: "low",
      mountProvider: "cash",
      config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
        workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
      providerRouting: { spawnOpenWeight: async (_args: SpawnWorkerArgs, _config: Config,
        selection: { model: string; effort: string }) => {
        models.push(selection.model);
        return models.length === 1
          ? { ...result("cash", selection.model, "pending", true), costUsd: 0,
            openWeightDeploymentAbsent: selection.model }
          : result("cash", selection.model, "pending");
      } },
    } as never);
    assert.deepEqual(models, ["gpt-5-nano", "gpt-oss-120b"]);
    const ledger = rows(root);
    const assignments = ledger.filter((row) => row.step === "worker.assignment");
    const attempts = ledger.filter((row) => row.step === "worker.attempt");
    assert.deepEqual(assignments.map((row) => (row.worker_assignment as WorkerSelectionAssignment).selected.model), models);
    assert.deepEqual(attempts.map((row) => row.success), [false, true]);
    assert.deepEqual(attempts.map((row) => row.selection_assignment_id), assignments.map((row) =>
      (row.worker_assignment as WorkerSelectionAssignment).id));
    assert.equal(final.selectionAssignmentId, (assignments[1]!.worker_assignment as WorkerSelectionAssignment).id);
  } finally { clearOpenWeightAbsence(); rmSync(root, { recursive: true, force: true }); }
});

test("non-dispatch benchmark receipt failure preserves normal flow", async () => {
  const selected = assignment("unpersisted", "cash", "model");
  const returned = result("cash", "model", selected.id);
  const raw = (async (input: SpawnWorkerArgs) => {
    input.onSelectionAssignment?.(selected);
    return returned;
  }) as typeof spawnWorker;
  let originalAssignmentCalls = 0;
  assert.equal(await benchmarkNonDispatchSpawn("triage", raw)({ ...args("/dev/null"),
    onSelectionAssignment: () => { originalAssignmentCalls += 1; } }), returned,
    "an unavailable ledger root cannot fail or change the worker");
  assert.equal(originalAssignmentCalls, 1, "benchmark sink failure cannot skip the original callback");
  const thrown = new Error("worker failed");
  const failing = (async (input: SpawnWorkerArgs) => {
    input.onSelectionAssignment?.(selected);
    throw thrown;
  }) as typeof spawnWorker;
  await assert.rejects(benchmarkNonDispatchSpawn("triage", failing)(args("/dev/null")),
    (error: unknown) => error === thrown, "telemetry cannot replace the worker's error");
});
