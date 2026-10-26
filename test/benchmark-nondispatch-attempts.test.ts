import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import { spawnFlightJudgeWorker } from "../src/lib/flight-judge.js";
import { spawnSpecialistWorker } from "../src/lib/specialist-panel.js";
import { runOpenWeightWalkingLadder, spawnWorker } from "../src/lib/worker.js";
import { clearOpenWeightAbsence } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { spendRoleOf } from "#src/lib/spend-rows.js";
import { captureGardenerSpendSource, foldGardenerSpend } from "#src/lib/gardener-spend.js";

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

test("fresh judge and specialist entrypoints record attempts through injected workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-judge-entrypoints-"));
  const mount = { model: "opus", effort: "medium" as const, maxTurns: 2, contextBudget: 1_000 };
  try {
    const fake = (async (input: SpawnWorkerArgs) => {
      const id = input.tools?.length ? "specialist-assignment" : "judge-assignment";
      input.onSelectionAssignment?.(assignment(id, "codex", "opus"));
      return result("codex", "opus", id);
    }) as typeof spawnWorker;
    const judge = await spawnFlightJudgeWorker({ input: { taskId: "T-JUDGE", goal: "assess",
      acceptanceCriteria: [], recentTurns: [] }, mount, cwd: root, settingsFile: "settings.json",
    config: { root } as Config }, fake);
    const specialist = await spawnSpecialistWorker({ input: { specialist: "security", taskId: "T-SPECIALIST",
      prUrl: "https://github.com/example/example/pull/1", triggers: [] }, mount, cwd: root,
    settingsFile: "settings.json", config: { root } as Config }, fake);
    assert.equal(judge.selectionAssignmentId, "judge-assignment");
    assert.equal(specialist.selectionAssignmentId, "specialist-assignment");
    const ledger = rows(root);
    assert.deepEqual(ledger.filter((entry) => entry.step === "worker.attempt").map((entry) => entry.lane),
      ["flight-judge", "specialist"]);
    assert.equal(ledger.filter((entry) => entry.step === "verdict").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an auxiliary fallback caller hook failure leaves the worker and attempt intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-fallback-hook-"));
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (line: string) => { warnings.push(line); };
  try {
    const selected = assignment("fallback-hook-assignment", "cash", "cash-a");
    const final = result("cash", "cash-a", selected.id);
    const fake = (async (input: SpawnWorkerArgs) => {
      input.onSelectionAssignment?.(selected);
      input.onModelFallbackAttempt?.({ selectionAssignmentId: selected.id, model: "cash-a",
        reason: "deployment-absent", result: final });
      return final;
    }) as typeof spawnWorker;
    assert.equal(await benchmarkNonDispatchSpawn("review", fake)({ ...args(root),
      onModelFallbackAttempt: () => { throw new Error("observer failure"); } }), final);
    assert.equal(rows(root).filter((entry) => entry.step === "worker.attempt").length, 1,
      "replaying a terminal selection through the final result does not count it twice");
    assert.ok(warnings.some((line) => line.includes("benchmark.non_dispatch_fallback_hook_unavailable")));
  } finally { console.error = originalError; rmSync(root, { recursive: true, force: true }); }
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

test("malformed fallback and final resource envelopes remain named unknown without changing worker flow", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-malformed-resource-"));
  const broken = { ...result("cash", "cash-a", "a1"), tokens: undefined } as unknown as WorkerResult;
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
  try {
    const raw = (async (input: SpawnWorkerArgs) => {
      input.onSelectionAssignment?.(assignment("a1", "cash", "cash-a"));
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "a1", model: "cash-a",
        reason: "deployment-absent", result: broken });
      return broken;
    }) as typeof spawnWorker;
    assert.equal(await benchmarkNonDispatchSpawn("review", raw)(args(root)), broken);
    const attempts = rows(root).filter((entry) => entry.step === "worker.attempt");
    assert.equal(attempts.length, 1, "the same malformed terminal envelope is retained once");
    assert.ok(attempts.every((entry) => entry.benchmark_run_unavailable_reason === "worker-result-fields-unavailable"));
    assert.ok(attempts.every((entry) => entry.total_cost_usd === undefined && entry.tokens === undefined));
    assert.equal(logged.filter((line) => line.includes("benchmark.non_dispatch_resource_unavailable")).length, 2);
    assert.ok(logged.every((line) => line.includes('"error_class":"TypeError"')
      && !line.includes("sensitive-prompt-sentinel")), "only a bounded error class is logged");
  } finally { console.error = originalError; rmSync(root, { recursive: true, force: true }); }
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
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }), "utf8");
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

test("real cash ladder continues when a fallback telemetry callback throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-cash-hook-"));
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (line: string) => { warnings.push(line); };
  clearOpenWeightAbsence();
  try {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }), "utf8");
    const models: string[] = [];
    const final = await spawnWorker({
      cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, prompt: "bounded cash request",
      model: "sonnet", effort: "low", mountProvider: "cash",
      config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
        workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
      onModelFallbackAttempt: () => { throw new Error("observer failed"); },
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
    assert.equal(final.isError, false, "the telemetry sink cannot cancel the fallback rung");
    assert.ok(warnings.some((line) => line.includes("worker.openweight.rung_telemetry_unavailable")));
  } finally { clearOpenWeightAbsence(); console.error = originalError;
    rmSync(root, { recursive: true, force: true }); }
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

test("Codex attempts preserve explicit notional pricing without turning it into cash or a served model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-notional-receipt-"));
  try {
    const raw = (async (input: SpawnWorkerArgs) => {
      input.onSelectionAssignment?.(assignment("notional", "codex", "gpt-6.1-sol"));
      return { ...result("codex", "gpt-6.1-sol", "notional"), costUsd: 0, notionalCostUsd: 0.75,
        servedModel: null, servedModelReason: "CLI reports no served identity" };
    }) as typeof spawnWorker;
    await benchmarkNonDispatchSpawn("review", raw)(args(root));
    const receipt = rows(root).find(row => row.step === "worker.attempt")!;
    assert.equal(receipt.notional_cost_usd, 0.75);
    assert.equal(receipt.total_cost_usd, undefined);
    assert.equal(receipt.served_model, null);
    const accounting = (receipt.benchmark_run as Record<string, any>).accounting;
    assert.deepEqual(accounting.subscriptionNotionalUsd, { state: "observed", value: 0.75 });
    assert.equal(accounting.apiCostUsd.state, "unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("W1-T10668: outer fallback retains both selection receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-outer-terminal-"));
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true,
    allowUnsandboxedCommands: false } }));
  const models: string[] = [];
  const callbacks: NonNullable<Parameters<NonNullable<SpawnWorkerArgs["onModelFallbackAttempt"]>>[0]>[] = [];
  let successor: WorkerResult | undefined;
  clearOpenWeightAbsence();
  try {
    const returned = await benchmarkNonDispatchSpawn("inbox-draft", spawnWorker)({
      cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, prompt: "bounded outer fallback fixture",
      model: "sonnet", effort: "low", mountProvider: "cash", cashSonnetEmergency: true,
      config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
        workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
      onModelFallbackAttempt: (attempt) => {
        callbacks.push(attempt);
        assert.equal(models.length, 1, "the first terminal callback precedes the successor's adapter");
        assert.equal(rows(root).filter(row => row.step === "worker.attempt").length, 1);
      },
      providerRouting: { spawnOpenWeight: async (_args, _config, selection) => {
        models.push(selection.model);
        if (models.length === 1) return { ...result("cash", selection.model, "pending", true),
          costUsd: 0, budgetRefused: true, budgetReservedUsd: 0, budgetSettledUsd: 0,
          servedModel: null, sessionId: "", text: "", blocks: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
        successor = result("cash", selection.model, "pending");
        return successor;
      } },
    });
    const ledger = rows(root);
    const selections = ledger.filter(row => row.step === "worker.assignment");
    const attempts = ledger.filter(row => row.step === "worker.attempt");
    assert.deepEqual(models, ["claude-sonnet-5-5", "gpt-5-nano"]);
    assert.equal(returned, successor, "the observer never replaces the actual successor result");
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]!.reason, "cash-sonnet-refused");
    assert.equal(callbacks[0]!.model, models[0]);
    assert.equal(callbacks[0]!.result?.budgetRefused, true);
    assert.deepEqual(ledger.map(row => row.step), ["worker.assignment", "worker.attempt", "worker.assignment", "worker.attempt"]);
    const ids = selections.map(row => (row.worker_assignment as WorkerSelectionAssignment).id);
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(attempts.map(row => row.selection_assignment_id), ids);
    assert.deepEqual(attempts.map(row => row.success), [false, true]);
    assert.equal(returned.selectionAssignmentId, ids[1]);
    assert.equal(callbacks[0]!.selectionAssignmentId, ids[0]);
    assert.ok(attempts.every(row => ((row.benchmark_run as Record<string, unknown>)
      .assignmentJoin as Record<string, unknown>).state === "observed"));
    assert.deepEqual(selections.map(row => row.run_id), attempts.map(row => row.run_id));
    assert.ok(attempts.every(row => spendRoleOf(row) !== "produced"),
      "coverage receipts must not become a second monetary producer");
  } finally { clearOpenWeightAbsence(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10668: canonical money is counted once", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-terminal-replay-"));
  let originalCalls = 0;
  try {
    const first = result("cash", "cash-a", "a", true);
    const second = result("cash", "cash-b", "b");
    const raw = (async (input: SpawnWorkerArgs) => {
      input.onSelectionAssignment?.(assignment("a", "cash", "cash-a"));
      input.onSelectionAssignment?.(assignment("b", "cash", "cash-b"));
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "a", model: "cash-a", reason: "cash-sonnet-refused", result: first });
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "a", model: "cash-a", reason: "cash-sonnet-refused", result: first });
      return second;
    }) as typeof spawnWorker;
    assert.equal(await benchmarkNonDispatchSpawn("triage", raw)({ ...args(root),
      onModelFallbackAttempt: () => { originalCalls += 1; } }), second);
    const ledger = rows(root);
    const attempts = ledger.filter(row => row.step === "worker.attempt");
    assert.deepEqual(attempts.map(row => row.selection_assignment_id), ["a", "b"]);
    assert.deepEqual(attempts.map(row => row.total_cost_usd), [0.25, 0.25]);
    assert.ok(attempts.every(row => ((row.benchmark_run as Record<string, unknown>)
      .assignmentJoin as Record<string, unknown>).state === "observed"),
      "a late terminal callback still joins its earlier durable assignment");
    assert.equal(attempts[0]!.run_id, "triage-a");
    assert.equal(originalCalls, 2, "deduplication does not suppress the existing caller's observer");
    const canonical = { step: "machine_judge.attempt_spend", model: "cash-a",
      billing_mode: "api", total_cost_usd: 0.25 };
    assert.equal(spendRoleOf(canonical), "produced");
    assert.deepEqual([canonical, ...attempts].filter(row => spendRoleOf(row) === "produced"), [canonical],
      "terminal coverage and canonical monetary producer ownership remain separate");

    const at = new Date().toISOString();
    const repository = "fixture/outer-fallback";
    const passId = "12345678-1234-4123-8123-123456789abc";
    const origin = { state: "linked", version: 1, name: "config", passId };
    const parent = { ts: at, step: "garden.lifecycle", name: "config", passId, repository,
      daemon_run_id: "fixture-generation", phase: "completed", exit: 0 };
    const priced = { ...canonical, ts: at, run_id: "priced-a", task_id: "FIXTURE", gardener_origin: origin };
    writeFileSync(join(root, "state", "gardener-runtime.json"), JSON.stringify({ version: 1, repository,
      daemonRunId: "fixture-generation", codeSha: null, configuredAt: at, observedAt: at,
      gardens: [{ name: "config", enabled: true, scope: "repository", cadenceMs: 1_000, phase: "completed",
        observedAt: at, passId, nextDueAt: null, queueMs: null, executionMs: null, exit: 0, reason: null,
        attempts: 1, completions: 1, failures: 0, lastCompletedAt: at, lastSuccessAt: at, lastFailureAt: null }] }));
    writeFileSync(join(root, "state", "ledger.ndjson"), [parent, priced, priced,
      ...attempts.map(row => ({ ...row, ts: at, gardener_origin: origin }))].map(row => JSON.stringify(row)).join("\n") + "\n");
    const spend = foldGardenerSpend(await captureGardenerSpendSource(join(root, "state"), undefined, { repository }), repository, at);
    assert.equal(spend.totalUsd, 0.25, "the real exact-parent collector retains canonical money once despite replayed coverage");
    assert.equal(spend.counts.priced, 1);

    const unknown = result("cash", "cash-unknown", "placeholder");
    delete unknown.selectionAssignmentId;
    const missing = (async (input: SpawnWorkerArgs) => {
      input.onModelFallbackAttempt?.({ model: "cash-unknown", reason: "cash-sonnet-refused", result: unknown });
      input.onModelFallbackAttempt?.({ model: "cash-unknown", reason: "cash-sonnet-refused", result: unknown });
      return unknown;
    }) as typeof spawnWorker;
    await benchmarkNonDispatchSpawn("review", missing)(args(root));
    const unjoined = rows(root).filter(row => row.step === "worker.attempt" && row.lane === "review");
    assert.equal(unjoined.length, 1);
    assert.deepEqual((unjoined[0]!.benchmark_run as Record<string, unknown>).assignmentJoin,
      { state: "unavailable", reason: "assignment-not-observed-in-run" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("W1-T10668: observer failures preserve flow and removal fails", async () => {
  for (const fault of ["caller", "resource", "ledger"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-outer-fault-"));
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true,
      allowUnsandboxedCommands: false } }));
    if (fault === "ledger") mkdirSync(join(root, "state", "ledger.ndjson"), { recursive: true });
    const originalError = console.error;
    const warnings: string[] = [];
    const models: string[] = [];
    let callbacks = 0;
    console.error = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    clearOpenWeightAbsence();
    try {
      const run = fault === "caller" ? spawnWorker : benchmarkNonDispatchSpawn("review", spawnWorker);
      const final = await run({
        cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, prompt: "bounded outer fault fixture",
        model: "sonnet", effort: "low", mountProvider: "cash", cashSonnetEmergency: true,
        config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
          workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
        onModelFallbackAttempt: () => { callbacks += 1; if (fault === "caller") throw new Error("caller observer unavailable"); },
        providerRouting: { spawnOpenWeight: async (_args, _config, selection) => {
          models.push(selection.model);
          if (models.length !== 1) return result("cash", selection.model, "pending");
          const first = { ...result("cash", selection.model, "pending", true),
            budgetRefused: true, budgetReservedUsd: 0, budgetSettledUsd: 0, costUsd: 0 };
          return fault === "resource" ? Object.defineProperty(first, "tokens", {
            get: () => { throw new TypeError("fixture usage unavailable"); },
          }) : first;
        } },
      });
      assert.deepEqual(models, ["claude-sonnet-5-5", "gpt-5-nano"], "the successor runs with the same two adapter calls");
      assert.equal(final.isError, false);
      assert.equal(final.routedModel, models[1]);
      assert.equal(callbacks, 1, "removing only the outer observer loses this terminal notification, not the successor");
      const event = fault === "caller" ? "worker.outer_fallback_telemetry_unavailable"
        : fault === "resource" ? "benchmark.non_dispatch_resource_unavailable" : "benchmark.non_dispatch_attempt_unavailable";
      assert.ok(warnings.some(line => line.includes(event)), `${fault} failure has a bounded diagnostic`);
      if (fault === "resource") {
        const attempts = rows(root).filter(row => row.step === "worker.attempt");
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0]!.benchmark_run_unavailable_reason, "worker-result-fields-unavailable");
        assert.equal(attempts[0]!.total_cost_usd, undefined);
        assert.equal(attempts[1]!.success, true);
      }
    } finally { clearOpenWeightAbsence(); console.error = originalError;
      rmSync(root, { recursive: true, force: true }); }
  }
});
test("W1-T10668: terminal invocation and price uncertainty stay explicit", async () => {
  const zeroWork = { ...result("cash", "pending", "pending", true), subtype: "error_budget_refused",
    numTurns: 0, costUsd: 0, budgetRefused: true, budgetReservedUsd: 0, budgetSettledUsd: 0,
    sessionId: "", servedModel: null, text: "", blocks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
  const paidRefusal = { ...result("cash", "pending", "pending", true), budgetRefused: true,
    budgetReservedUsd: 0.75, budgetSettledUsd: 0 };
  const unknown = { ...result("cash", "pending", "pending", true), subtype: "", costUsd: 0 };
  const completed = result("cash", "pending", "pending");
  for (const [kind, first] of [["zero-work-refusal", zeroWork], ["paid-later-refusal", paidRefusal],
    ["unknown", unknown], ["completed", completed]] as const) {
    const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-terminal-evidence-"));
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true,
      allowUnsandboxedCommands: false } }));
    const models: string[] = [];
    clearOpenWeightAbsence();
    try {
      const final = await benchmarkNonDispatchSpawn("inbox-draft", spawnWorker)({
        cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, prompt: "bounded terminal evidence fixture",
        model: "sonnet", effort: "low", mountProvider: "cash", cashSonnetEmergency: true,
        config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
          workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
        providerRouting: { spawnOpenWeight: async (_args, _config, selection) => {
          models.push(selection.model);
          return models.length === 1 ? first : result("cash", selection.model, "successor");
        } },
      });
      assert.equal(models[0], "claude-sonnet-5-5");
      assert.equal(models.length, kind === "completed" ? 1 : 2, "only the existing routing predicate chooses a successor");
      assert.equal(final.isError, false);
      const attempts = rows(root).filter(row => row.step === "worker.attempt");
      assert.equal(attempts.length, models.length);
      const terminal = attempts[0]!.terminal_evidence as Record<string, unknown>;
      assert.equal(terminal.state, "observed");
      assert.deepEqual(terminal.invocation, { state: "unavailable", reason: "provider-invocation-not-reported" },
        "routing, complete zero-work quality evidence and scalar prices never manufacture a transport receipt");
      if (kind === "zero-work-refusal") {
        assert.deepEqual(terminal.allowanceRefused, { state: "observed", value: true });
        assert.deepEqual(terminal.reservedUsd, { state: "observed", value: 0 });
        assert.deepEqual(terminal.settledUsd, { state: "observed", value: 0 });
        assert.deepEqual(terminal.resultSubtype, { state: "observed", value: "error_budget_refused" });
        assert.equal(attempts[0]!.total_cost_usd, 0, "preserve the existing explicit zero-work estimate");
      } else if (kind === "paid-later-refusal") {
        assert.deepEqual(terminal.allowanceRefused, { state: "observed", value: true });
        assert.deepEqual(terminal.reservedUsd, { state: "observed", value: 0.75 });
        assert.equal(attempts[0]!.total_cost_usd, 0.25, "a later allowance refusal does not erase prior reported cost");
      } else {
        assert.deepEqual(terminal.allowanceRefused, { state: "unavailable", reason: "terminal-field-not-reported" });
        assert.deepEqual(terminal.reservedUsd, { state: "unavailable", reason: "terminal-field-not-reported" });
        if (kind === "unknown") {
          assert.equal(attempts[0]!.total_cost_usd, undefined);
          assert.equal(attempts[0]!.tokens, undefined, "empty envelopes' defaults are not measurements");
        } else {
          assert.deepEqual(terminal.resultSubtype, { state: "observed", value: "success" });
          assert.deepEqual(terminal.isError, { state: "observed", value: false });
        }
      }
    } finally { clearOpenWeightAbsence(); rmSync(root, { recursive: true, force: true }); }
  }

  const root = mkdtempSync(join(tmpdir(), "rmd-benchmark-terminal-contract-"));
  try {
    // This is a projection-contract control. Only the worker's explicit admission marker establishes not-started.
    const notStarted = { ...result("cash", "pending", "pending", true), notStarted: "admission-abandoned" as const,
      subtype: "", costUsd: 0 };
    delete notStarted.selectionAssignmentId;
    const noCall = (async () => notStarted) as typeof spawnWorker;
    assert.equal(await benchmarkNonDispatchSpawn("review", noCall)(args(root)), notStarted);
    const stopped = rows(root).find(row => row.step === "worker.attempt")!;
    assert.deepEqual((stopped.terminal_evidence as Record<string, unknown>).invocation,
      { state: "observed", value: "not-started", reason: "admission-abandoned" });
    assert.equal(stopped.total_cost_usd, undefined);

    const bad = Object.defineProperty({ ...result("cash", "bad", "bad", true) }, "subtype",
      { get: () => { throw new TypeError("private terminal getter"); } });
    const good = result("codex", "subscription", "sub");
    good.costUsd = 0;
    good.notionalCostUsd = 0.75;
    const raw = (async (input: SpawnWorkerArgs) => {
      input.onSelectionAssignment?.(assignment("bad", "cash", "bad"));
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "bad", model: "bad", reason: "cash-sonnet-refused", result: bad });
      input.onSelectionAssignment?.(assignment("invalid", "cash", "invalid"));
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "invalid", model: "invalid", reason: "cash-sonnet-refused",
        result: { ...result("cash", "invalid", "invalid", true), subtype: "private invalid status",
          budgetRefused: "invalid", budgetReservedUsd: Number.NaN, budgetSettledUsd: -1 } as unknown as WorkerResult });
      input.onSelectionAssignment?.(assignment("no-result", "cash", "missing"));
      input.onModelFallbackAttempt?.({ selectionAssignmentId: "no-result", model: "missing", reason: "unsupported-response-format" });
      input.onSelectionAssignment?.(assignment("sub", "codex", "subscription"));
      return good;
    }) as typeof spawnWorker;
    assert.equal(await benchmarkNonDispatchSpawn("triage", raw)(args(root)), good);
    const ledger = rows(root).filter(row => row.step === "worker.attempt" && row.lane === "triage");
    assert.deepEqual(ledger[0]!.terminal_evidence, { state: "unavailable", reason: "worker-terminal-fields-unavailable" });
    assert.equal(ledger[0]!.benchmark_run_unavailable_reason, "worker-result-fields-unavailable");
    const invalid = ledger[1]!.terminal_evidence as Record<string, unknown>;
    for (const field of ["resultSubtype", "allowanceRefused", "reservedUsd", "settledUsd"])
      assert.deepEqual(invalid[field], { state: "unavailable", reason: "invalid-terminal-field" });
    assert.doesNotMatch(JSON.stringify(invalid), /private invalid status/);
    assert.deepEqual(ledger[2]!.terminal_evidence, { state: "unavailable", reason: "worker-result-not-reported" });
    assert.equal(ledger[2]!.total_cost_usd, undefined);
    assert.equal(ledger[3]!.billing_mode, "subscription");
    assert.equal(ledger[3]!.total_cost_usd, undefined);
    assert.equal(ledger[3]!.notional_cost_usd, 0.75);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
