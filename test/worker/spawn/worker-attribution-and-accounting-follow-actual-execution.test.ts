import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { sdkRequestedEffort, workerExecutionEvidence, type WorkerExecutionEvidenceV1 } from "#src/lib/worker-execution-evidence.js";
import {
  collectWorkerResult,
  createClaudeExecutableCache,
  spawnWorker,
  workerLedgerFields,
  type SpawnWorkerArgs,
  type WorkerResult,
} from "#src/lib/worker.js";
import type { WorkerSelectionAssignment } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-W1-T10956-execution-evidence-"));
}

function assignment(): WorkerSelectionAssignment {
  return {
    version: 1,
    id: "assignment-1",
    phase: "pre-execution",
    requested: { model: "requested-model", effort: "low", maxTurns: 2 },
    selected: { provider: "claude", model: "selected-model", effort: "high" },
    routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [],
  };
}

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    provider: "cash",
    sessionId: "provider-session",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "configured-model",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tokenUsageState: "observed",
    modelUsage: {},
    servedModel: null,
    servedModelReason: "provider did not report identity",
    compactionEvents: [],
    qualitySuspect: false,
    ...overrides,
  } as WorkerResult;
}

test("W1-T10956: execution evidence keeps assignment, request, served identity, measured zero, and accounting facts separate", () => {
  const evidence = workerExecutionEvidence("attempt-1", result({
    provider: "cash",
    model: "configured-model",
    routedModel: "selected-model",
    servedModel: null,
    servedModelReason: "provider response omitted model",
    workerDurationMs: 0,
    workerFirstTextMs: 0,
    tokenUsageState: "observed",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    usageEstimateUsd: 0,
    billedUsd: null,
    budgetReservedUsd: 0.25,
    budgetSettledUsd: 0,
    budgetHeldUsd: 0.25,
  }), assignment());

  assert.equal(evidence.attemptId, "attempt-1");
  assert.equal(evidence.assignment.state, "observed");
  if (evidence.assignment.state === "observed") assert.equal(evidence.assignment.value.selected.model, "selected-model");
  assert.deepEqual(evidence.identity.servedModel, { state: "unavailable", reason: "provider response omitted model" });
  assert.deepEqual(evidence.execution.durationMs, { state: "observed", value: 0 });
  assert.deepEqual(evidence.execution.tokenUsage, { state: "observed", value: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } });
  assert.deepEqual(evidence.accounting.apiUsageRatedUsd, { state: "observed", value: 0 });
  assert.deepEqual(evidence.accounting.billedCashUsd, { state: "unavailable", reason: "cash-billing-receipt-unavailable" });
  assert.deepEqual(evidence.accounting.invoiceUsd, { state: "unavailable", reason: "worker-result-is-not-an-invoice" });
  assert.deepEqual(evidence.accounting.cashBudget.heldUsd, { state: "observed", value: 0.25 });
  assert.deepEqual(evidence.execution.firstTextMs, { state: "observed", value: 0 });
});

test("W1-T10956: unavailable usage, cost, and resource values remain explicit", () => {
  const evidence = workerExecutionEvidence("attempt-with-gaps", result({
    provider: undefined,
    servedModel: undefined,
    servedModelReason: undefined,
    tokenUsageState: undefined,
    workerDurationMs: undefined,
    costUsd: 0,
    notionalCostUsd: undefined,
    usageEstimateUsd: null,
    billedUsd: null,
    budgetReservedUsd: undefined,
    budgetSettledUsd: undefined,
    budgetHeldUsd: undefined,
  }));

  assert.deepEqual(evidence.identity.provider, { state: "unavailable", reason: "provider-not-recorded" });
  assert.deepEqual(evidence.identity.servedModel, { state: "unavailable", reason: "served-model-not-recorded" });
  assert.deepEqual(evidence.execution.durationMs, { state: "unavailable", reason: "worker-duration-not-recorded" });
  assert.deepEqual(evidence.execution.tokenUsage, { state: "unavailable", reason: "token-usage-state-not-recorded" });
  assert.deepEqual(evidence.accounting.apiUsageRatedUsd, { state: "unavailable", reason: "billing-mode-not-recorded" });
  assert.deepEqual(evidence.accounting.subscriptionNotionalUsd, { state: "unavailable", reason: "billing-mode-not-recorded" });
  assert.deepEqual(evidence.accounting.cashBudget.reservedUsd, { state: "unavailable", reason: "provider-not-recorded" });
  assert.deepEqual(evidence.accounting.billedCashUsd, { state: "unavailable", reason: "provider-not-recorded" });
  assert.deepEqual(evidence.accounting.invoiceUsd, { state: "unavailable", reason: "worker-result-is-not-an-invoice" });

  const heldCash = workerExecutionEvidence("held-cash", result({ usageEstimateUsd: null,
    sdkReportedUsageRatedUsd: 8, budgetHeldUsd: 0.2 }));
  assert.deepEqual(heldCash.accounting.apiUsageRatedUsd,
    { state: "unavailable", reason: "usage-rating-not-reported" });
  assert.deepEqual(heldCash.accounting.cashBudget.reservedUsd,
    { state: "unavailable", reason: "cash-reservation-not-recorded" });
  const legacy = workerExecutionEvidence("legacy-environment-missing", result({
    provider: "codex", childEnvKeys: undefined,
  }));
  assert.deepEqual(legacy.accounting.billingMode,
    { state: "unavailable", reason: "billing-environment-not-recorded" });
  assert.deepEqual(legacy.accounting.subscriptionNotionalUsd,
    { state: "unavailable", reason: "billing-environment-not-recorded" });
});

test("W1-T10956: partial usage stays partial and an admission-abandoned worker is not marked invoked or successful", () => {
  const partial = workerExecutionEvidence("partial-usage", result({
    tokenUsageState: "partial",
    tokens: { input: 4, output: 0, cacheRead: 0, cacheCreation: 0 },
  }));
  assert.deepEqual(partial.execution.tokenUsage, {
    state: "partial", value: { input: 4, output: 0, cacheRead: 0, cacheCreation: 0 },
  });

  const notStarted = workerExecutionEvidence("not-started", result({
    notStarted: "admission-abandoned",
    isError: false,
  }));
  assert.deepEqual(notStarted.providerInvoked, { state: "observed", value: false });
  assert.deepEqual(notStarted.execution.terminal, {
    state: "unavailable", reason: "worker-not-started-after-admission-refusal",
  });

  const transientApiError = workerExecutionEvidence("transient-api-error", result({ apiError: true, isError: false }));
  assert.deepEqual(transientApiError.execution.terminal, { state: "observed", value: "success" });

  const terminalApiError = workerExecutionEvidence("terminal-api-error", result({ apiError: true, isError: true }));
  assert.deepEqual(terminalApiError.execution.terminal, { state: "observed", value: "error" });

  const usageRefusal = workerExecutionEvidence("usage-refusal", result({
    usageRefusal: { matched: "account-limit" }, isError: true,
  }));
  assert.deepEqual(usageRefusal.execution.terminal, { state: "observed", value: "refused" });

  const budgetRefusal = workerExecutionEvidence("budget-refusal", result({ budgetRefused: true, isError: true }));
  assert.deepEqual(budgetRefusal.execution.terminal, { state: "observed", value: "refused" });
});

test("W1-T10956: first-text timing uses the first nonempty assistant text and preserves unknown clock and usage states", async (t) => {
  const fixedNow = t.mock.method(Date, "now", () => 100);
  const collect = (withText: boolean, usage?: Record<string, unknown>, totalCost?: number) => {
    const stream = async function* () {
      if (withText) {
        yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "not text" }, { type: "text", text: "" }] } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "first" }] } };
      }
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "timed",
        ...(totalCost === undefined ? {} : { total_cost_usd: totalCost }),
        num_turns: 1, ...(usage === undefined ? {} : { usage }) };
    };
    return collectWorkerResult(stream(), { childEnvKeys: [] });
  };

  const zero = await collect(true, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0);
  assert.equal(zero.workerFirstTextMs, 0);
  assert.equal(zero.tokenUsageState, "observed");
  assert.equal(zero.sdkReportedUsageRatedUsd, 0);
  assert.deepEqual(workerExecutionEvidence("sdk-zero-subscription", {
    ...zero, provider: "claude", childEnvKeys: [],
  }).accounting.subscriptionNotionalUsd, { state: "observed", value: 0 });
  fixedNow.mock.restore();

  const missing = await collect(false, undefined, undefined);
  assert.equal(missing.workerFirstTextMs, null);
  assert.equal(missing.workerFirstTextReason, "no-nonempty-assistant-text");
  assert.equal(missing.tokenUsageState, "unavailable");
  assert.equal(missing.sdkReportedUsageRatedUsd, undefined);
  assert.deepEqual(workerExecutionEvidence("sdk-missing-cost", {
    ...missing, provider: "claude", childEnvKeys: ["ANTHROPIC_API_KEY"],
  }).accounting.apiUsageRatedUsd, { state: "unavailable", reason: "sdk-usage-rating-not-reported" });

  const rated = await collect(false, undefined, 1.25);
  assert.equal(rated.sdkReportedUsageRatedUsd, 1.25);
  assert.deepEqual(workerExecutionEvidence("sdk-rated-api", {
    ...rated, provider: "claude", childEnvKeys: ["ANTHROPIC_API_KEY"],
  }).accounting.apiUsageRatedUsd, { state: "observed", value: 1.25 });

  const partial = await collect(false, { input_tokens: 3 });
  assert.equal(partial.tokenUsageState, "partial");
  assert.deepEqual(partial.tokens, { input: 3, output: 0, cacheRead: 0, cacheCreation: 0 });

  let times = [100, 99, 101];
  const shiftedNow = t.mock.method(Date, "now", () => times.shift() ?? 101);
  const nonmonotonic = await collect(true, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(nonmonotonic.workerFirstTextMs, null);
  assert.equal(nonmonotonic.workerFirstTextReason, "first-text-clock-nonmonotonic");
  shiftedNow.mock.restore();

  let endTimes = [100, 101, 100];
  const backwardsAtEnd = t.mock.method(Date, "now", () => endTimes.shift() ?? 100);
  const regressedDuration = await collect(true,
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(regressedDuration.workerDurationMs, 0);
  assert.equal(regressedDuration.workerFirstTextMs, null);
  assert.equal(regressedDuration.workerFirstTextReason, "first-text-clock-nonmonotonic");
  backwardsAtEnd.mock.restore();
});

test("W1-T10956: attempt metrics join actual execution and measured identity without substituting router selection for provider evidence", async (t) => {
  assert.deepEqual(sdkRequestedEffort({ effort: "high" }), { state: "observed", value: "high" });
  assert.deepEqual(sdkRequestedEffort({}), { state: "unavailable", reason: "sdk-effort-option-omitted" });

  const root = temporaryRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  let requestOptions: { model?: string; effort?: string; disallowedTools?: string[] } | undefined;
  const stream = async function* () {
    yield { type: "assistant", message: { model: "served-by-provider", content: [{ type: "text", text: "done" }] } };
    yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "sdk-session",
      total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
  const config = { root, claudeBin: "/fixture/claude", workerHomeRoot: join(root, "worker-home") } as Config;
  const worker = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions",
    settingsFile: join(REPO_ROOT, "settings/worker.json"),
    prompt: "synthetic fixture",
    model: "requested-model",
    effort: "high",
    disallowedTools: ["Write", "Edit", "Bash"],
    mountProvider: "claude",
    config,
    egress: { mode: "off" },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: now + 3_600_000 },
    }) },
    queryFn: ((input: { options: { model?: string; effort?: string; disallowedTools?: string[] } }) => {
      requestOptions = { model: input.options.model, effort: input.options.effort,
        disallowedTools: input.options.disallowedTools ? [...input.options.disallowedTools] : undefined };
      return stream();
    }) as unknown as SpawnWorkerArgs["queryFn"],
  });

  assert.equal(requestOptions?.effort, "high");
  assert.equal(requestOptions?.model, "requested-model");
  assert.ok(["Write", "Edit", "Bash"].every(tool => requestOptions?.disallowedTools?.includes(tool)));
  assert.deepEqual(worker.sdkRequest?.effort, { state: "observed", value: "high" });
  assert.deepEqual(worker.sdkRequest?.model, { state: "observed", value: "requested-model" });
  assert.equal(worker.servedModel, "served-by-provider");
  assert.deepEqual(workerLedgerFields(worker).execution_evidence, worker.executionEvidence);
  assert.deepEqual(worker.executionEvidence?.execution.tokenUsage, {
    state: "observed", value: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  });
  assert.deepEqual(worker.executionEvidence?.accounting.subscriptionNotionalUsd, { state: "observed", value: 0 });
  assert.equal(worker.executionEvidence?.attemptId.length! > 0, true);
  assert.equal((worker.executionEvidence as WorkerExecutionEvidenceV1 | undefined)?.accounting.invoiceUsd.state, "unavailable");
  assert.equal(Object.hasOwn(workerLedgerFields(result()), "execution_evidence"), false);
});
