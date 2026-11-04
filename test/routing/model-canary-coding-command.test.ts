import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canaryCommand, executeOwnedCodingCanarySchedule, replayPrivateCli } from "#src/lib/model-canary-command.js";
import { codingAttemptConsumptionBinding, CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { bindCodingExecutionAuthority, executeCodingCandidate, parseCodingCandidate,
  refuseCodingBeforeHost, scoreCodingControl, syntheticCodingFixture,
  type CodingConfiguredBounds, type CodingRunnerResult } from "#src/lib/model-canary-coding.js";
import { registerQualifiedCodingExecutionPort } from "#src/lib/model-canary-coding-port-capability.js";
import { buildCanarySchedule, type CanarySlot } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { validatePrivateCorpus, privateCorpusMetadata, type PrivateCanaryBundleV1,
  type PrivateCanaryCaseV1 } from "#src/lib/model-canary-private-corpus.js";
import { workerExecutionEvidence } from "#src/lib/worker-execution-evidence.js";
import { codingLedgerSave } from "#src/lib/model-canary-ledger.js";
import { executeCanary, type CanaryExecutionPorts, type CanaryRequest } from "#src/lib/model-canary-runner.js";
import type { CanaryRun } from "#src/lib/model-canary-metrics.js";
import { codingProviderRequestState } from "#src/lib/model-canary-coding-capabilities.js";
import { resolveProducerIdentity } from "#src/lib/producer-identity.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { codingWorkerRequestPorts, type CodingWorker } from "#src/lib/model-canary-coding-adapter.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CODING_ITEM = commonCanarySuite().find(item => item.family === "coding")!;

function codingBundle(): PrivateCanaryBundleV1 {
  const privateCase: PrivateCanaryCaseV1 = { item: CODING_ITEM, provenance: {
    sourceFamilyId: "coding-test-family", incidentRootId: "coding-test-root", sourceDigest: sha("coding-test-source"),
    observedAt: "2026-11-03T00:00:00.000Z", splitId: "coding-development-v1", split: "development", role: "coder",
  }, expectedToolTrace: [], scorerVersion: "coding-control-v1" };
  return { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } };
}

function fixture(root: string) {
  const bundle = codingBundle();
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
function simulatedCodingPort(owner: CanarySlotOwner, events: string[], preparedSlot?: CanarySlot): NonNullable<CanaryExecutionPorts["executeCoding"]> {
  const configured: CodingConfiguredBounds = { profileId: "source-unit-simulation", profileDigest: "1".repeat(64),
    binaryDigest: "2".repeat(64), runtimeId: "node-source-stdin-stdout-v1", cpuQuotaMicros: 100_000,
    memoryMaxBytes: 1024 * 1024, swapMaxBytes: 0, tasksMax: 4, scratchMaxBytes: 64 * 1024,
    wallMaxMs: 10_000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 512 * 1024 };
  const port = async (request: Parameters<NonNullable<CanaryExecutionPorts["executeCoding"]>>[0]): Promise<CodingRunnerResult> => {
    const candidate = parseCodingCandidate(request.responseText);
    const consumed = owner.consumeCodingAttempt(preparedSlot ?? { id: request.slotId, caseId: request.caseId,
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
    const native = JSON.parse(readFileSync(join(outDir, "model-canary-coding-native.json"), "utf8"));
    assert.equal(native.released, false);
    assert.equal(native.plan, null);
    assert.equal(native.eligibility.sourceAdopted, false);
    assert.equal(native.eligibility.adapterQualified, false);
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("prepared native replay keeps existing controls closed before native qualification or worker runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-native-unreleased-"));
  try {
    const bundle = codingBundle(), validation = validatePrivateCorpus(bundle);
    if (validation.state !== "available") assert.fail("native preparation corpus invalid");
    const corpusPath = join(root, "corpus.json"), requestPath = join(root, "native.json");
    writeFileSync(corpusPath, JSON.stringify(bundle), { mode: 0o600 });
    const eligibility = { sourceAdopted: true, adapterQualified: true, productionBusy: false,
      squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false };
    const request = { version: "model-canary-coding-native-v1", corpusDigest: validation.metadata.digest,
      cases: [CODING_ITEM], plan: null, seed: null, released: false, eligibility };
    let runtimeCalls = 0;
    const internal = { workerRuntime: async (): Promise<never> => { runtimeCalls++; throw new Error("must-stay-unarmed"); } };
    const invoke = async () => {
      writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
      return replayPrivateCli(["replay-private", corpusPath, requestPath, join(root, "absent-owner")], internal);
    };
    assert.equal((await invoke()).state, "prepared-not-activated");
    request.released = true;
    for (const [field, blocked] of Object.entries({ sourceAdopted: false, adapterQualified: false,
      productionBusy: true, squeeze: true, spareSubscription: false })) {
      const before = { ...eligibility };
      Object.assign(eligibility, { [field]: blocked });
      assert.equal((await invoke()).state, "prepared-not-activated", field);
      Object.assign(eligibility, before);
    }
    assert.equal(runtimeCalls, 0);
    assert.equal(existsSync(join(root, "absent-owner")), false);
    request.corpusDigest = "0".repeat(64);
    await assert.rejects(invoke, /coding-native-prepared-corpus-mismatch/);
    assert.equal(runtimeCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coding worker request port retains terminal evidence and only cleans scratch after observed closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-request-port-"));
  const config = { root, installRoot: REPO_ROOT, claudeBin: "unused-unit-worker" };
  const workerId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  let workerCalls = 0, workerCwd = "";
  let exit: Awaited<ReturnType<CodingWorker>>["exit"] = { kind: "exit", code: 0 };
  const worker: CodingWorker = async args => {
    workerCalls++; workerCwd = args.cwd;
    assert.deepEqual(args.tools, []); assert.deepEqual(args.cashTools, []);
    assert.equal(args.mcpIsolation, "repo-knowledge-only");
    assert.equal(args.mountProvider, "claude");
    assert.equal(args.maxTurns, 1); assert.equal(args.permissionMode, "dontAsk");
    assert.equal(args.runId, "run-control");
    assert.equal(readFileSync(args.settingsFile, "utf8").includes("${HOOKS_DIR}"), false);
    return { exit, text: JSON.stringify({ source: "/* transport control */" }), isError: false, apiError: false,
      workerDurationMs: 7, workerFirstTextMs: 2, tokens: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 },
      tokenUsageState: "partial", servedModel: null, executionEvidence: workerExecutionEvidence(workerId, {
        provider: "claude", childEnvKeys: [], isError: false, servedModel: null,
        tokens: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 } }) };
  };
  const request: CanaryRequest = { prompt: "synthetic task", pin: { model: "unit-model", route: "claude",
    effort: "low", billing: "subscription" }, history: [], allowedTools: [],
    signal: new AbortController().signal, maxOutputBytes: 16_384 };
  const context = { version: "canary-internal-attempt-context-v1" as const,
    runId: "run-control", canaryAttemptId: "attempt-control" };
  const ports = codingWorkerRequestPorts(config, root, worker);
  try {
    const response = await ports.request(request, context);
    assert.equal(response.resources.servedModel, null);
    assert.equal(response.resources.inputTokens, null, "partial tokens never become exact observations");
    assert.equal(response.resources.outputTokens, null);
    assert.equal(response.resources.usageRatedUsd, null);
    assert.equal(response.resources.durationMs, 7);
    assert.equal(response.resources.executionEvidence!.attemptId, workerId);
    assert.equal(response.resources.terminal, "complete");
    assert.equal(existsSync(workerCwd), false);
    exit = { kind: "signal", signal: "SIGTERM" };
    assert.equal((await ports.request(request, context)).resources.terminal, "error");
    assert.equal(existsSync(workerCwd), false);
    exit = { kind: "unobserved" };
    await assert.rejects(() => ports.request(request, context), /coding-worker-closure-unavailable/);
    assert.equal(existsSync(workerCwd), true, "ambiguous work remains beside the held owner for recovery");
    assert.equal(workerCalls, 3);
    await assert.rejects(() => ports.request(request), /coding-worker-request-contract-invalid/);
    await assert.rejects(() => ports.request({ ...request, allowedTools: ["paid_lookup"] }, context), /contract-invalid/);
    assert.equal(workerCalls, 3);
    const pin = { ...request.pin, suiteHash: canarySuiteDigest([CODING_ITEM]) };
    assert.equal((await ports.admit(pin, request.signal)).state, "admitted");
    assert.equal((await ports.admit({ ...pin, billing: "api" }, request.signal)).state, "refused");
    assert.equal((await ports.admit({ ...pin, route: "cash" }, request.signal)).state, "refused");
    assert.equal((await codingWorkerRequestPorts({ ...config, overflow: "api_key" }, root, worker)
      .admit(pin, request.signal)).state, "refused");
    assert.equal(workerCalls, 3);
    const retained = readdirSync(root);
    await assert.rejects(() => codingWorkerRequestPorts({ ...config, installRoot: join(root, "missing-install") }, root, worker)
      .request(request, context), /ENOENT/);
    assert.deepEqual(readdirSync(root), retained, "a pre-spawn settings failure leaves no disposable workspace");
    assert.equal(workerCalls, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native replay entry composes worker identity, coding scorer, existing owner and canonical ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-native-entry-"));
  const data = fixture(root), events: string[] = [];
  const config = { root, installRoot: REPO_ROOT, claudeBin: "unused-unit-worker" };
  const workerId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  const plan = buildCanarySchedule("2026-11-03", "native-entry-control", [CODING_ITEM],
    [{ ...data.pin, route: "claude" }]);
  const before = structuredClone(plan);
  const corpusPath = join(root, "corpus.json"), requestPath = join(root, "native.json");
  const request = { version: "model-canary-coding-native-v1", corpusDigest: privateCorpusMetadata(data.corpus)!.digest,
    cases: [CODING_ITEM], plan, seed: "native-entry-control", released: true,
    eligibility: { sourceAdopted: true, adapterQualified: true, productionBusy: false,
      squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false } };
  writeFileSync(corpusPath, JSON.stringify(data.bundle), { mode: 0o600 });
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  mkdirSync(join(root, "state"), { mode: 0o700 });
  let workerCalls = 0;
  const worker: CodingWorker = async args => {
    workerCalls++;
    assert.deepEqual(args.tools, []); assert.deepEqual(args.cashTools, []);
    assert.equal(args.permissionMode, "dontAsk"); assert.equal(args.maxTurns, 1);
    assert.equal(args.mountProvider, "claude");
    assert.equal(args.model, data.pin.model); assert.equal(args.effort, data.pin.effort);
    assert.equal(existsSync(join(args.cwd, ".git")), false);
    assert.ok(args.cwd.startsWith(data.ownerDir + "/coding-request-"));
    assert.ok(args.settingsFile.startsWith(args.cwd + "/"));
    assert.equal(args.prompt.includes("expectedStdout"), false);
    assert.equal(args.prompt.includes(data.ownerDir), false);
    return { text: JSON.stringify({ source: "/* source-unit worker fixture */" }),
      isError: false, apiError: false, exit: { kind: "exit", code: 0 },
      workerDurationMs: 7, workerFirstTextMs: 2, tokens: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 },
      tokenUsageState: "observed", servedModel: null,
      executionEvidence: workerExecutionEvidence(workerId, { provider: "claude", childEnvKeys: [],
        model: data.pin.model, servedModel: null, isError: false,
        tokens: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 } }) };
  };
  const internal = { workerRuntime: async () => ({ config, worker }),
    codingPortFactory: (slot: CanarySlot, owner: CanarySlotOwner) => simulatedCodingPort(owner, events, slot) };
  data.owner.close();
  try {
    const argv = ["replay-private", corpusPath, requestPath, data.ownerDir];
    const outcome = await replayPrivateCli(argv, internal);
    assert.equal(outcome.state, "finished");
    assert.ok("completed" in outcome);
    assert.equal(outcome.completed, 1);
    assert.equal(workerCalls, 1);
    const rows = readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, "MODEL-CANARY-CODING");
    assert.equal(rows[0].passed, true);
    assert.equal(rows[0].worker_spawn_attempt_id, workerId);
    assert.notEqual(rows[0].canary_attempt_id, workerId);
    assert.ok(rows[0].host_execution_id);
    assert.deepEqual(plan, before);
    assert.equal(readdirSync(data.ownerDir).some(name => name.startsWith("coding-request-")), false);
    const db = new DatabaseSync(join(data.ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const stored = db.prepare("SELECT phase,receipt FROM canary_slots_v1 WHERE id=?").get(plan.slots[0]!.id);
      assert.equal(stored!.phase, "terminal");
      const run = JSON.parse(String(stored!.receipt)).run;
      assert.equal(run.attempts[0].servedModel, null);
      assert.equal(run.verified, true);
    } finally { db.close(); }
    const duplicate = await replayPrivateCli(argv, internal);
    assert.ok("completed" in duplicate);
    assert.equal(duplicate.completed, 0);
    assert.equal(workerCalls, 1, "existing owner prevents a duplicate worker and native host execution");
    request.seed = "changed-seed";
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    await assert.rejects(() => replayPrivateCli(argv, internal), /coding-native-prepared-schedule-changed/);
    assert.equal(workerCalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("coding ledger producer resolves to its declared identity", () => {
  const codingResult = refuseCodingBeforeHost("native-backend-unavailable");
  const codingGrade = scoreCodingControl(syntheticCodingFixture("ledger-identity-control"), codingResult);
  const run: CanaryRun = { id: "ledger-identity-control", caseId: CODING_ITEM.id,
    suiteHash: canarySuiteDigest([CODING_ITEM]), model: "unit-control-model", route: "subscription",
    effort: "low", family: "coding", verified: null, totalDurationMs: null, attempts: [] };
  const rows: Record<string, unknown>[] = [];
  codingLedgerSave("unused-unit-ledger", { run, trace: [], codingResult, codingGrade },
    (_path, row) => { rows.push(row); });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task_id, "MODEL-CANARY-CODING");
  assert.equal(rows[0]!.step, "model_canary.coding_execution");
  const sender = rows[0]!.task_id;
  if (typeof sender !== "string") assert.fail("coding ledger sender must be declared");
  assert.deepEqual(resolveProducerIdentity(sender), { id: "model-canary-coding", displayName: "Model Canary Coding" });
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

test("W1-T10957: a coding provider request that throws or rejects is uncertain and never terminals the owner", async () => {
  for (const shape of ["throws", "rejects"] as const) {
    const root = mkdtempSync(join(tmpdir(), `rmd-canary-coding-provider-${shape}-`));
    const data = fixture(root); let requests = 0;
    const executeCoding = registerQualifiedCodingExecutionPort(async () => {
      throw new Error("host executor must not run without a provider response");
    });
    const failure = new Error(`unit-control-provider-${shape}`);
    const request: CanaryExecutionPorts["request"] = shape === "throws"
      ? () => { requests++; throw failure; }
      : () => { requests++; return Promise.reject(failure); };
    const ports: CanaryExecutionPorts = { admit: async () => ({ state: "admitted" }), monotonicMs: () => 0,
      executeCoding, save: async () => {}, request };
    try {
      assert.equal(data.owner.claim(data.slot), "claimed");
      const outcome = await executeCanary(CODING_ITEM, data.pin, ports,
        { maxCalls: 1, wallMs: 10_000, maxOutputBytes: 16_384 }, { corpus: data.corpus, slotId: data.slot.id });
      assert.equal(requests, 1, shape);
      assert.equal(outcome.reason, "transport-error", shape);
      assert.equal(codingProviderRequestState(outcome.codingProviderRequestLifecycle), "uncertain", shape);
      assert.throws(() => data.owner.terminal(data.slot, outcome), /canary-owner-coding-provider-closure-unproved/, shape);
    } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("W1-T10957: the owner refuses a coding outcome whose trace cannot be snapshotted and keeps the slot started", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-trace-bound-"));
  const data = fixture(root), events: string[] = [];
  const ports: CanaryExecutionPorts = { ...ordinaryPorts(events, "019f5ab2-4420-4ea0-993f-470a56362e05"),
    executeCoding: registerQualifiedCodingExecutionPort(simulatedCodingPort(data.owner, events, data.slot)) };
  try {
    assert.equal(data.owner.claim(data.slot), "claimed");
    const outcome = await executeCanary(CODING_ITEM, data.pin, ports,
      { maxCalls: 1, wallMs: 10_000, maxOutputBytes: 16_384 }, { corpus: data.corpus, slotId: data.slot.id });
    assert.equal(outcome.state, "scored", "positive control: the real simulated composition scores");
    const oversized = { ...outcome, trace: [{ name: "unit", args: { padding: "x".repeat(40 * 1024) },
      denied: true, result: null }] };
    assert.throws(() => data.owner.terminal(data.slot, oversized), /canary-owner-coding-trace-invalid/);
    const db = new DatabaseSync(join(data.ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT phase FROM canary_slots_v1 WHERE id=?").get(data.slot.id) as { phase?: string } | undefined;
      assert.equal(row?.phase, "started", "a refused terminal record leaves the claim held");
    } finally { db.close(); }
    data.owner.terminal(data.slot, outcome);
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10957: an unparseable coding response is refused before the host executor runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-canary-coding-unparseable-"));
  const data = fixture(root), events: string[] = []; let hostCalls = 0;
  const base = ordinaryPorts(events, "019f5ab2-4420-4ea0-993f-470a56362e06");
  const ports: CanaryExecutionPorts = { ...base,
    executeCoding: registerQualifiedCodingExecutionPort(async () => {
      hostCalls++; throw new Error("host executor must not run for an unparseable response");
    }),
    request: async (request, context) => {
      const response = await base.request(request, context);
      return { ...response, text: "this is not a coding candidate" };
    } };
  try {
    assert.equal(data.owner.claim(data.slot), "claimed");
    const outcome = await executeCanary(CODING_ITEM, data.pin, ports,
      { maxCalls: 1, wallMs: 10_000, maxOutputBytes: 16_384 }, { corpus: data.corpus, slotId: data.slot.id });
    assert.equal(hostCalls, 0);
    assert.equal(outcome.codingResult?.state, "refused");
    assert.equal(outcome.codingResult?.reason, "coding-response-invalid");
    assert.equal(outcome.codingResult?.execution.hostStarted, "no");
  } finally { data.owner.close(); rmSync(root, { recursive: true, force: true }); }
});
