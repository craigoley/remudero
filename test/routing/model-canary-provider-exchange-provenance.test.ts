import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectWorkerResult, type ProviderExchangeBindingV1, type WorkerResult } from "#src/lib/worker.js";
import { workerExecutionEvidence } from "#src/lib/worker-execution-evidence.js";
import { codingWorkerRequestPorts, type CodingWorker } from "#src/lib/model-canary-coding-adapter.js";
import { executeCanary } from "#src/lib/model-canary-runner.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { validatePrivateCorpus, type PrivateCanaryCaseV1, type PrivateCanaryBundleV1 } from "#src/lib/model-canary-private-corpus.js";
import { refuseCodingBeforeHost } from "#src/lib/model-canary-coding.js";
import { registerQualifiedCodingExecutionPort } from "#src/lib/model-canary-coding-port-capability.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const binding: ProviderExchangeBindingV1 = { runId: "run-1", canaryAttemptId: "canary-1", workerSpawnAttemptId: "spawn-1" };
const assistant = (model: string, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { model, content: [] }, ...extra });
const terminal = { type: "result", subtype: "success", is_error: false, result: "{}", session_id: "offline",
  total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} };
async function* scripted(messages: unknown[]) { for (const message of messages) yield message; }
async function collect(messages: unknown[]) {
  return collectWorkerResult(scripted(messages), { childEnvKeys: [], providerExchangeBinding: binding });
}

test("W1-T11597: only a provider-originated assistant message with a real non-synthetic model, or an allowlisted provider response error actually received, seals provider-exchange evidence", async () => {
  const positive = await collect([assistant("claude-real"), terminal]);
  const receipt = positive.providerExchange;
  assert.deepEqual(receipt, { version: "canary-provider-exchange-v1", ...binding,
    outcome: "assistant-model", model: "claude-real" });
  const padded = await collect([assistant(" claude-real "), terminal]);
  assert.equal(padded.servedModel, " claude-real ");
  assert.equal(padded.providerExchange?.model, "claude-real");
  const providerError = await collect([assistant("<synthetic>", { error: "rate_limit" }), terminal]);
  assert.equal(providerError.providerExchange?.error, "rate_limit");
  // The reducer receives only scripted in-memory messages; no provider client or transport is constructed here.
});

test("W1-T11597 criterion 2: excluded signals including cloud_credential_error and unknown issue no provider exchange evidence in test/routing/model-canary-provider-exchange-provenance.test.ts", async () => {
  const excluded: unknown[][] = [
    [assistant("<synthetic>", { error: "cloud_credential_error" }), terminal],
    [assistant("<synthetic>", { error: "unknown" }), terminal],
    [assistant("claude-real", { error: "cloud_credential_error" }), terminal],
    [assistant("claude-real", { error: "unknown" }), terminal],
    [assistant("<synthetic>", { isApiErrorMessage: true }), terminal],
    [{ type: "assistant", message: { content: [] }, isApiErrorMessage: true }, terminal],
    [assistant("<synthetic>"), terminal],
    [assistant("  <synthetic>  "), terminal],
    [],
    [terminal],
    [{ type: "system", subtype: "query_start" }],
    [{ type: "system", subtype: "query_start" }, terminal],
    [{ type: "system", subtype: "init" }, terminal],
  ];
  for (const messages of excluded) assert.equal((await collect(messages)).providerExchange, undefined);
  for (const failure of ["aborted", "timed out", "local spawn failed", "tool failed"]) {
    async function* interrupted() { throw new Error(failure); }
    await assert.rejects(collectWorkerResult(interrupted(), { childEnvKeys: [], providerExchangeBinding: binding }));
  }
  async function* assistantThenAbort() { yield assistant("claude-real"); throw new Error("aborted before terminal result"); }
  await assert.rejects(collectWorkerResult(assistantThenAbort(), { childEnvKeys: [], providerExchangeBinding: binding }));
  // Abort, timeout, local spawn/tool failure, bare api-error flag, empty/query-start-only and ambiguous streams are absent.
});

test("W1-T11597 criterion 3: workerExecutionEvidence providerInvoked contract is unchanged in test/routing/model-canary-provider-exchange-provenance.test.ts", () => {
  const ordinary = { provider: "claude", servedModel: "claude-real", servedModelReason: undefined,
    workerDurationMs: 0, workerFirstTextMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tokenUsageState: "observed", notStarted: undefined } as unknown as WorkerResult;
  const evidence = workerExecutionEvidence("spawn-1", ordinary);
  assert.deepEqual(evidence.providerInvoked, { state: "unavailable", reason: "provider-invocation-not-individually-observed" });
  const abandoned = workerExecutionEvidence("spawn-abandoned", { ...ordinary, notStarted: "admission-abandoned" });
  assert.deepEqual(abandoned.providerInvoked, { state: "observed", value: false });
  assert.deepEqual(binding, { runId: "run-1", canaryAttemptId: "canary-1", workerSpawnAttemptId: "spawn-1" });
});

test("W1-T11597 criterion 4: sealed evidence binds run canary attempt and worker spawn attempt in test/routing/model-canary-provider-exchange-provenance.test.ts", async () => {
  const result = await collect([assistant("claude-real"), terminal]);
  const token = result.providerExchange;
  assert.ok(token);
  assert.deepEqual(token, { version: "canary-provider-exchange-v1", ...binding,
    outcome: "assistant-model", model: "claude-real" });
});

test("W1-T11597 criterion 5: offline provider exchange controls use zero transport and zero spend in test/routing/model-canary-provider-exchange-provenance.test.ts", async () => {
  const observed = await collect([assistant("claude-offline-model"), terminal]);
  assert.equal(observed.providerExchange?.model, "claude-offline-model");
  assert.equal(observed.sdkReportedUsageRatedUsd, 0);
  // This path consumes an in-memory script and does not construct a provider transport or billing client.
});


test("W1-T11597 criterion 8: provider exchange receipt round-trips through JSON at the owner boundary as a typed attempt subtype in test/routing/model-canary-provider-exchange-provenance.test.ts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-W1-T11597-provider-exchange-"));
  const item = commonCanarySuite().find(candidate => candidate.family === "coding")!;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const privateCase: PrivateCanaryCaseV1 = { item, provenance: { sourceFamilyId: "exchange-family",
    incidentRootId: "exchange-root", sourceDigest: sha("source"), observedAt: "2026-11-07T00:00:00.000Z",
    splitId: "exchange-development", split: "development", role: "coder" }, expectedToolTrace: [], scorerVersion: "coding-control-v1" };
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } };
  const validation = validatePrivateCorpus(bundle);
  assert.equal(validation.state, "available");
  if (validation.state !== "available") throw new Error("offline-private-corpus-unavailable");
  const workerSpawnAttemptId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  let workerCalls = 0;
  let saved: unknown;
  const worker: CodingWorker = async args => {
    workerCalls++;
    const observed = await collectWorkerResult(scripted([assistant("claude-offline-model"), terminal]), {
      childEnvKeys: [], providerExchangeBinding: { runId: args.runId!, canaryAttemptId: args.canaryAttemptId!, workerSpawnAttemptId },
    });
    return { exit: { kind: "exit", code: 0 }, text: JSON.stringify({ source: "/* offline control */" }),
      isError: false, apiError: false, workerDurationMs: 1, workerFirstTextMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, tokenUsageState: "observed",
      sdkReportedUsageRatedUsd: 0, notionalCostUsd: 0, servedModel: "claude-offline-model", executionEvidence:
        workerExecutionEvidence(workerSpawnAttemptId, { provider: "claude", childEnvKeys: [], servedModel: "claude-offline-model",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, tokenUsageState: "observed" }),
      providerExchange: observed.providerExchange };
  };
  try {
    const ports = codingWorkerRequestPorts({ root, installRoot: REPO_ROOT, claudeBin: "offline-scripted-worker" }, root, worker);
    ports.save = async run => { saved = JSON.parse(JSON.stringify(run)); };
    ports.executeCoding = registerQualifiedCodingExecutionPort(async () => refuseCodingBeforeHost("native-backend-unavailable"));
    const outcome = await executeCanary(item, { model: "offline-model", route: "claude", effort: "low",
      suiteHash: canarySuiteDigest([item]), billing: "subscription" }, ports, undefined,
      { corpus: validation.corpus, slotId: "offline-owner-slot" });
    const savedRun = saved as { attempts: Array<Record<string, unknown>> };
    const receipt = savedRun.attempts[0]?.providerExchange as Record<string, unknown> | undefined;
    assert.equal(receipt?.version, "canary-provider-exchange-v1");
    assert.equal(receipt?.runId, outcome.run.id);
    assert.equal(receipt?.canaryAttemptId, outcome.run.attempts[0]?.id);
    assert.equal(receipt?.workerSpawnAttemptId, workerSpawnAttemptId);
    assert.equal(savedRun.attempts[0]?.usageRatedUsd, 0);
    assert.equal(workerCalls, 1);
    // `worker` above is the only injected execution port: it consumes a scripted stream and has no network capability.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
