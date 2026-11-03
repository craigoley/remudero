import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canaryCommand, executeOwnedCodingCanarySchedule } from "#src/lib/model-canary-command.js";
import { codingAttemptConsumptionBinding, CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { bindCodingExecutionAuthority, executeCodingCandidate, parseCodingCandidate,
  type CodingConfiguredBounds, type CodingRunnerResult } from "#src/lib/model-canary-coding.js";
import { registerQualifiedCodingExecutionPort } from "#src/lib/model-canary-coding-port-capability.js";
import { buildCanarySchedule } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { validatePrivateCorpus, type PrivateCanaryBundleV1,
  type PrivateCanaryCaseV1 } from "#src/lib/model-canary-private-corpus.js";
import { workerExecutionEvidence } from "#src/lib/worker-execution-evidence.js";
import { codingLedgerSave } from "#src/lib/model-canary-ledger.js";
import { executeCanary, type CanaryExecutionPorts } from "#src/lib/model-canary-runner.js";
import type { CanaryRun } from "#src/lib/model-canary-metrics.js";
import { codingProviderRequestState } from "#src/lib/model-canary-coding-capabilities.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CODING_ITEM = commonCanarySuite().find(item => item.family === "coding")!;

function fixture(root: string) {
  const privateCase: PrivateCanaryCaseV1 = { item: CODING_ITEM, provenance: {
    sourceFamilyId: "coding-test-family", incidentRootId: "coding-test-root", sourceDigest: sha("coding-test-source"),
    observedAt: "2026-11-03T00:00:00.000Z", splitId: "coding-development-v1", split: "development", role: "coder",
  }, expectedToolTrace: [], scorerVersion: "coding-control-v1" };
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } };
  const validation = validatePrivateCorpus(bundle);
  assert.equal(validation.state, "available");
  if (validation.state !== "available") throw new Error("private-coding-fixture-unavailable");
  const ownerDir = join(root, "owner"); mkdirSync(ownerDir, { mode: 0o700 });
  const owner = new CanarySlotOwner(ownerDir);
  const pin = { model: "unit-control-model", route: "subscription", effort: "low",
    suiteHash: canarySuiteDigest([CODING_ITEM]), billing: "subscription" as const };
  const plan = buildCanarySchedule("2026-11-03", "coding-command-control", [CODING_ITEM], [pin]);
  return { owner, ownerDir, bundle, corpus: validation.corpus, plan, pin, slot: plan.slots[0]! };
}

/** Source-unit-only fixture backend: its output and finite counters are simulation, never Linux qualification evidence. */
function simulatedCodingPort(owner: CanarySlotOwner, events: string[]): NonNullable<CanaryExecutionPorts["executeCoding"]> {
  const configured: CodingConfiguredBounds = { profileId: "source-unit-simulation", profileDigest: "1".repeat(64),
    binaryDigest: "2".repeat(64), runtimeId: "node-source-stdin-stdout-v1", cpuQuotaMicros: 100_000,
    memoryMaxBytes: 1024 * 1024, swapMaxBytes: 0, tasksMax: 4, scratchMaxBytes: 64 * 1024,
    wallMaxMs: 10_000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 512 * 1024 };
  const port = async (request: Parameters<NonNullable<CanaryExecutionPorts["executeCoding"]>>[0]): Promise<CodingRunnerResult> => {
    const candidate = parseCodingCandidate(request.responseText);
    const consumed = owner.consumeCodingAttempt({ id: request.slotId, caseId: request.caseId,
      pin: { model: "unit-control-model", route: "subscription", effort: "low",
        suiteHash: request.suiteHash, billing: "subscription" }, aaLabel: null }, {
      runId: request.runId, canaryAttemptId: request.canaryAttemptId,
      workerSpawnAttemptId: request.workerSpawnAttemptId, sourceDigest: candidate.sourceDigest });
    if (consumed.state !== "consumed") throw new Error("unit-control-owner-consume-failed");
    const binding = codingAttemptConsumptionBinding(consumed.capability);
    if (!binding) throw new Error("unit-control-owner-capability-missing");
    events.push("simulated-candidate-backend");
    const authority = bindCodingExecutionAuthority({ binding, configured, consumption: consumed.capability,
      execute: async () => ({ state: "complete" as const, raw: {
        binding, hostExecutionId: "source-unit-simulated-host", candidateDigest: candidate.sourceDigest,
        exitCode: 0, stdout: request.fixture.expectedStdout, stderr: "", configured,
        // These values exercise the schema and join only. They are never written to a live ledger.
        observed: { cpuUsec: 2, memoryPeakBytes: 1024, swapPeakBytes: 0, pidsPeak: 1,
          scratchPeakBytes: 1024, wallMs: 1, stdoutBytes: Buffer.byteLength(request.fixture.expectedStdout),
          stderrBytes: 0, heapPeakBytes: 512 },
        restrictions: { privateNonGitRoot: true, networkNamespaceIsolated: true, noHostDataMounts: true,
          noCredentialMounts: true, noPackageInstall: true, oracleNotMounted: true },
        lifecycle: { cancelled: false, candidateClosedBeforeMetrics: true,
          metricsCapturedBeforeCollection: true, unitEmptyAfterStop: true },
      } }) });
    return executeCodingCandidate({ binding, fixture: request.fixture, responseText: request.responseText,
      authority, signal: request.signal });
  };
  return port;
}

function ordinaryPorts(events: string[], workerId: string): CanaryExecutionPorts {
  return { admit: async () => { events.push("admit"); return { state: "admitted" }; }, monotonicMs: () => 10,
    save: async (run: CanaryRun) => { events.push("save"); assert.equal(run.family, "coding"); },
    request: async (_request, context) => {
      events.push("request"); assert.ok(context); assert.equal(context.version, "canary-internal-attempt-context-v1");
      const source = "/* deterministic source-unit fixture backend control */";
      return { text: JSON.stringify({ source }), toolCalls: [], resources: {
        durationMs: 1, firstTextMs: 0, generationMs: 1, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
        billing: "subscription", servedModel: "unit-control-model", terminal: "complete",
        executionEvidence: workerExecutionEvidence(workerId, { provider: "claude", childEnvKeys: [],
          model: "unit-control-model", routedModel: "unit-control-model", servedModel: "unit-control-model",
          isError: false, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }),
      } };
    } };
}

test("W1-T10957: prepare-coding emits a prompt request without scorer oracle or execution authority", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-prepare-"));
  const data = fixture(root);
  try {
    const corpusPath = join(root, "corpus.json"), outDir = join(root, "out");
    writeFileSync(corpusPath, JSON.stringify(data.bundle), { mode: 0o600 }); mkdirSync(outDir, { mode: 0o700 });
    const result = canaryCommand(["prepare-coding", outDir, corpusPath]);
    const requestText = readFileSync(join(outDir, "model-canary-coding-requests.json"), "utf8");
    const joins = JSON.parse(readFileSync(join(outDir, "model-canary-coding-joins.json"), "utf8"));
    assert.equal(result.state, "prepared-not-activated");
    assert.equal(joins.execution, "requires-native-owner-and-qualified-linux-profile");
    assert.equal(requestText.includes("expectedStdout"), false);
    assert.equal(requestText.includes("codingExecutionAttemptId"), false);
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: default coding composition defers before eligibility, claim, admission, or request without a native profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-unarmed-"));
  const data = fixture(root);
  try {
    let eligible = 0, ports = 0, admitted = 0, requested = 0;
    const result = await executeOwnedCodingCanarySchedule({ owner: data.owner, profile: null, privateCorpus: data.corpus,
      ledgerPath: join(root, "ledger.ndjson"), schedulePorts: {
        eligibility: async () => { eligible++; return { sourceAdopted: true, adapterQualified: true,
          productionBusy: false, squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }; },
        ports: () => { ports++; return { ...ordinaryPorts([], "019f5ab2-4420-4ea0-993f-470a56362e04"),
          admit: async () => { admitted++; return { state: "admitted" }; },
          request: async () => { requested++; throw new Error("unarmed coding cannot request"); } }; },
      } }, data.plan, [CODING_ITEM]);
    assert.equal(result.state, "deferred");
    assert.deepEqual({ eligible, ports, admitted, requested }, { eligible: 0, ports: 0, admitted: 0, requested: 0 });
    assert.equal(data.owner.claim(data.slot), "claimed", "preflight did not consume the real owner slot");
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: complete coding tool denial is preserved while coding grade remains unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-denied-action-"));
  const data = fixture(root);
  try {
    const events: string[] = [], workerId = "019f5ab2-4420-4ea0-993f-470a56362e04";
    const ports = ordinaryPorts(events, workerId);
    const request = ports.request;
    ports.request = async (input, context) => ({ ...(await request(input, context)),
      toolCalls: [{ name: "shell", args: { command: "attempted" } }] });
    let hostCalls = 0;
    ports.executeCoding = registerQualifiedCodingExecutionPort(async () => {
      hostCalls++; throw new Error("denied tool must not reach isolated executor");
    });
    assert.equal(data.owner.claim(data.slot), "claimed");
    const outcome = await executeCanary(CODING_ITEM, data.pin, ports, undefined,
      { corpus: data.corpus, slotId: data.slot.id });
    assert.equal(outcome.reason, "coding-tool-request-denied");
    assert.equal(outcome.codingResult?.state, "refused");
    if (outcome.codingResult?.state === "refused")
      assert.equal(outcome.codingResult.reason, "coding-tool-request-denied");
    assert.equal(outcome.codingGrade?.state, "unavailable");
    assert.equal(outcome.run.verified, null);
    assert.equal(hostCalls, 0);
    data.owner.terminal(data.slot, outcome);
    let row: Record<string, unknown> | undefined;
    codingLedgerSave(join(root, "ledger.ndjson"), outcome, (_path, written) => { row = written; });
    assert.equal(row?.observed_unauthorized_action, true);
    assert.equal(row?.grade_state, "unavailable");
    assert.equal(row?.passed, null);
    assert.equal(row?.observed_resources, null);
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: unresolved coding provider request leaves the real owner started and skips ledger append", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-provider-open-"));
  const data = fixture(root); let requests = 0, ledgerCalls = 0;
  const executeCoding = registerQualifiedCodingExecutionPort(async () => {
    throw new Error("host executor must not run before provider response");
  });
  const ports: CanaryExecutionPorts = { admit: async () => ({ state: "admitted" }), monotonicMs: () => 0,
    executeCoding, save: async () => {}, request: async () => {
      requests++;
      return await new Promise<never>(() => {});
    } };
  try {
    assert.equal(data.owner.claim(data.slot), "claimed");
    const outcome = await executeCanary(CODING_ITEM, data.pin, ports,
      { maxCalls: 1, wallMs: 20, maxOutputBytes: 16_384 }, { corpus: data.corpus, slotId: data.slot.id });
    assert.equal(requests, 1);
    assert.equal(codingProviderRequestState(outcome.codingProviderRequestLifecycle), "uncertain");
    assert.throws(() => {
      data.owner.terminal(data.slot, outcome);
      codingLedgerSave(join(root, "ledger.ndjson"), outcome, () => { ledgerCalls++; });
    }, /canary-owner-coding-provider-closure-unproved/);
    assert.equal(ledgerCalls, 0);
    const db = new DatabaseSync(join(data.ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT phase FROM canary_slots_v1 WHERE id=?").get(data.slot.id) as { phase?: string } | undefined;
      assert.equal(row?.phase, "started");
    } finally { db.close(); }
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: simulated source-unit composition joins attempt IDs and terminals the real owner before ledger append", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-composition-"));
  const data = fixture(root), events: string[] = [], rows: Record<string, unknown>[] = [];
  const workerId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  const input = { owner: data.owner, profile: null, privateCorpus: data.corpus, ledgerPath: join(root, "ledger.ndjson"),
    appendCodingLedger: (_path: string, row: Record<string, unknown>) => {
      events.push("ledger"); rows.push(row);
      assert.equal(data.owner.claim(data.slot), "already-owned-or-terminal");
    },
    schedulePorts: { eligibility: async () => ({ sourceAdopted: true, adapterQualified: true,
      productionBusy: false, squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
      ports: () => ordinaryPorts(events, workerId) } };
  const testDependencies = { codingPortFactory: (slot: typeof data.slot, owner: CanarySlotOwner) =>
    registerQualifiedCodingExecutionPort(simulatedCodingPort(owner, events)) };
  try {
    const first = await executeOwnedCodingCanarySchedule(input, data.plan, [CODING_ITEM], testDependencies);
    assert.equal(first.state, "finished"); assert.equal(first.completed, 1);
    assert.deepEqual(events, ["admit", "request", "simulated-candidate-backend", "save", "ledger"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.execution_source, "native-provider-execution");
    assert.deepEqual(rows[0]!.source_activity, { kind: "synthetic-canary", source: "model-canary-v1",
      sourceReceiptId: rows[0]!.run_id, lane: "coding-control" });
    assert.notEqual(rows[0]!.run_id, rows[0]!.canary_attempt_id);
    assert.notEqual(rows[0]!.canary_attempt_id, rows[0]!.worker_spawn_attempt_id);
    assert.notEqual(rows[0]!.worker_spawn_attempt_id, rows[0]!.coding_execution_attempt_id);
    assert.equal(rows[0]!.passed, true);
    assert.equal((await executeOwnedCodingCanarySchedule(input, data.plan, [CODING_ITEM], testDependencies)).skipped, 1);
    assert.equal(rows.length, 1, "terminal owner prevents duplicate model and host work");
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: ledger append failure leaves the canonical owner terminal and prevents a second provider attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-ledger-failure-"));
  const data = fixture(root), events: string[] = [], workerId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  const input = { owner: data.owner, profile: null, privateCorpus: data.corpus, ledgerPath: join(root, "ledger.ndjson"),
    appendCodingLedger: () => { events.push("ledger-failed"); throw new Error("ledger-append-control"); },
    schedulePorts: { eligibility: async () => ({ sourceAdopted: true, adapterQualified: true,
      productionBusy: false, squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
      ports: () => ordinaryPorts(events, workerId) } };
  const testDependencies = { codingPortFactory: (slot: typeof data.slot, owner: CanarySlotOwner) =>
    registerQualifiedCodingExecutionPort(simulatedCodingPort(owner, events)) };
  try {
    await assert.rejects(() => executeOwnedCodingCanarySchedule(input, data.plan, [CODING_ITEM], testDependencies), /ledger-append-control/);
    assert.deepEqual(events, ["admit", "request", "simulated-candidate-backend", "save", "ledger-failed"]);
    assert.equal(data.owner.claim(data.slot), "already-owned-or-terminal");
    const retry = await executeOwnedCodingCanarySchedule(input, data.plan, [CODING_ITEM], testDependencies);
    assert.equal(retry.skipped, 1);
    assert.equal(events.filter(event => event === "request").length, 1);
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});
