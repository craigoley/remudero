import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syntheticCodingFixture, codingRequestFixture, parseCodingCandidate, scoreCodingControl,
  executeCodingCandidate, refuseCodingBeforeHost, bindCodingExecutionAuthority } from "#src/lib/model-canary-coding.js";
import { CanarySlotOwner, type CodingAttemptConsumptionCapability } from "#src/lib/model-canary-owner.js";
import { buildCanarySchedule } from "#src/lib/model-canary-schedule.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { rotatingCanarySuite } from "#src/lib/model-canary-rotation.js";
import { canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { validatePrivateCorpus, type PrivateCanaryBundleV1 } from "#src/lib/model-canary-private-corpus.js";
import { executeOwnedCodingCanarySchedule } from "#src/lib/model-canary-command.js";
import { codingAttemptConsumptionBinding } from "#src/lib/model-canary-coding-capabilities.js";
import { projectCanaryRuns, type CanaryRun } from "#src/lib/model-canary-metrics.js";
import { analyzeCanaryPairs } from "#src/lib/model-canary-paired-analysis.js";
import { workerExecutionEvidence } from "#src/lib/worker-execution-evidence.js";
import type { CodingGrade, CodingRunnerResult } from "#src/lib/model-canary-coding.js";
import { randomUUID } from "node:crypto";

function privateTestRoot(): string {
  const outsideGit = (candidate: string): boolean => {
    let current = realpathSync(candidate);
    while (true) {
      if (existsSync(join(current, ".git"))) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  };
  const parent = [tmpdir(), dirname(REPO_ROOT)].find(outsideGit);
  assert.ok(parent, "test host provides scratch outside git markers");
  return mkdtempSync(join(parent, "rmd-coding-authority-"));
}

function assertImportedCodingMetrics(run: CanaryRun): void {
  // Import private JSON through the public projection, without relying on executor validation.
  const imported: CanaryRun = JSON.parse(JSON.stringify(run));
  const importedProjection = () => projectCanaryRuns([imported]).groups[0]!.codingExecution!;
  assert.equal(importedProjection().observed, 1, "complete imported native measurements qualify");
  const receipt = imported.attempts[0]!.codingExecution!;
  const original = structuredClone(receipt);
  const configured = original.configured!;
  const rejectImport = (reason: string, label: string) => {
    const projected = importedProjection();
    assert.equal(projected.observed, 0, label);
    assert.equal(projected.invalid, 1, label);
    assert.equal(projected.rows[0]!.state, "invalid", label);
    assert.equal(projected.rows[0]!.reason, reason, label);
    Object.assign(receipt, structuredClone(original));
  };
  for (const field of Object.keys(original.observed!)) Reflect.set(receipt.observed!, field, null);
  rejectImport("coding-execution-score-unqualified", "all nine null counters cannot qualify an imported score");
  for (const field of Object.keys(original.observed!)) {
    for (const value of [null, undefined, -1, 0.5, "0", true, {}, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      Reflect.set(receipt.observed!, field, value);
      rejectImport(value === null ? "coding-execution-score-unqualified" : "coding-execution-resources-invalid",
        `${field}=${String(value)}`);
    }
  }
  for (const field of Object.keys(original.configured!)) {
    for (const value of [null, undefined, -1, 0.5, "", "x".repeat(129), true, {}, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      Reflect.set(receipt.configured!, field, value);
      rejectImport("coding-execution-resources-invalid", `configured ${field}=${String(value)}`);
    }
  }
  for (const field of ["cpuQuotaMicros", "memoryMaxBytes", "tasksMax", "scratchMaxBytes", "wallMaxMs",
    "stdoutMaxBytes", "stderrMaxBytes", "heapMaxBytes"]) {
    Reflect.set(receipt.configured!, field, 0);
    rejectImport("coding-execution-resources-invalid", `configured ${field} must be positive`);
  }
  for (const field of ["stdoutMaxBytes", "stderrMaxBytes"]) {
    Reflect.set(receipt.configured!, field, 4097);
    rejectImport("coding-execution-resources-invalid", `configured ${field} exceeds the protocol bound`);
  }
  for (const [field, cap] of Object.entries({ memoryPeakBytes: configured.memoryMaxBytes,
    swapPeakBytes: configured.swapMaxBytes, pidsPeak: configured.tasksMax, scratchPeakBytes: configured.scratchMaxBytes,
    wallMs: configured.wallMaxMs, stdoutBytes: configured.stdoutMaxBytes, stderrBytes: configured.stderrMaxBytes,
    heapPeakBytes: configured.heapMaxBytes })) {
    Reflect.set(receipt.observed!, field, cap + 1);
    rejectImport("coding-execution-score-unqualified", `${field} exceeds its configured bound`);
  }
  receipt.observed!.cpuUsec = configured.cpuQuotaMicros + 1;
  assert.equal(importedProjection().observed, 1, "cumulative cpu use is not the configured quota rate");
  Object.assign(receipt, structuredClone(original));
  receipt.state = "unavailable";
  receipt.reason = "resource-readback-incomplete";
  receipt.observed!.scratchPeakBytes = null;
  assert.equal(importedProjection().unavailable, 1);
  assert.equal(importedProjection().rows[0]!.observedResources!.scratchPeakBytes, null);
  for (const field of Object.keys(original.observed!)) Reflect.set(receipt.observed!, field, null);
  assert.equal(importedProjection().unavailable, 1, "absent measurements remain explicitly unavailable");
  assert.equal(importedProjection().observed, 0);
  Object.assign(receipt.observed!, original.observed);
  receipt.observed!.scratchPeakBytes = null;
  receipt.observed!.cpuUsec = -1;
  rejectImport("coding-execution-resources-invalid", "unavailable receipts still reject malformed observations");
}

test("imported coding scores require complete bounded native resource receipts", () => {
  const runId = randomUUID(), canaryAttemptId = randomUUID(), workerSpawnAttemptId = randomUUID();
  const run: CanaryRun = { id: runId, caseId: "coding-sum-four-v1", suiteHash: "a".repeat(64),
    model: "coder-a", route: "subscription", effort: "low", family: "coding", verified: true,
    totalDurationMs: 7, attempts: [{ id: canaryAttemptId, durationMs: 7, firstTextMs: 2, generationMs: 5,
      inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null,
      usageRatedUsd: null, billing: "subscription", servedModel: null, terminal: "complete",
      workerExecutionJoin: { version: "canary-worker-execution-join-v1", runId, canaryAttemptId,
        workerSpawnAttemptId, unit: "worker-spawn", measurementScope: "returned-terminal-result" },
      codingExecution: { version: "canary-coding-execution-observation-v1", canaryAttemptId, workerSpawnAttemptId,
        codingExecutionAttemptId: randomUUID(), hostExecutionId: "rmd-coding-import-control.service",
        sourceDigest: "b".repeat(64), fixtureDigest: "c".repeat(64), state: "scored", reason: "scored",
        closure: "proven", configured: { profileId: "import-control", profileDigest: "1".repeat(64),
          binaryDigest: "2".repeat(64), runtimeId: "node-source-stdin-stdout-v1", cpuQuotaMicros: 100_000,
          memoryMaxBytes: 32 * 1024 * 1024, swapMaxBytes: 0, tasksMax: 8, scratchMaxBytes: 1024 * 1024,
          wallMaxMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 8 * 1024 * 1024 },
        observed: { cpuUsec: 23, memoryPeakBytes: 4096, swapPeakBytes: 0, pidsPeak: 2,
          scratchPeakBytes: 128, wallMs: 4, stdoutBytes: 2, stderrBytes: 0, heapPeakBytes: 512 } } }] };
  assertImportedCodingMetrics(run);
});

test("W1-T10957: paired trial results retain correctness, native resource and missing-identity evidence without changing schedules", async () => {
  const root = privateTestRoot(), ownerDir = join(root, "owner");
  mkdirSync(ownerDir, { mode: 0o700 });
  const owner = new CanarySlotOwner(ownerDir);
  const rotated = rotatingCanarySuite("2026-11-03", "a".repeat(64)).cases.find(item => item.family === "coding")!;
  const partial = { ...rotated, id: "coding-partial-resource-control" }, cases = [rotated, partial];
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: cases.map((item, index) => ({ item,
      provenance: { sourceFamilyId: `paired-family-${index}`, incidentRootId: `paired-root-${index}`,
        sourceDigest: String(index + 1).repeat(64), observedAt: "2026-11-03T00:00:00.000Z",
        splitId: "paired-development", split: "development", role: "coder" },
      expectedToolTrace: [], scorerVersion: "coding-control-v1" })) } };
  const validated = validatePrivateCorpus(bundle);
  assert.equal(validated.state, "available");
  if (validated.state !== "available") assert.fail("paired private corpus unavailable");
  const pins = ["coder-a", "coder-b"].map(model => ({ model, route: "subscription", effort: "low",
    suiteHash: canarySuiteDigest(cases), billing: "subscription" as const }));
  const plan = buildCanarySchedule("2026-11-03", "paired-coding-control", cases, pins);
  const before = structuredClone({ plan, cases });
  const runs: CanaryRun[] = [], ledger: Record<string, unknown>[] = [];
  const outcomes: { codingResult: CodingRunnerResult; codingGrade: CodingGrade }[] = [];
  const configured = { profileId: "simulated-retention-control", profileDigest: "1".repeat(64), binaryDigest: "2".repeat(64),
    runtimeId: "node-source-stdin-stdout-v1" as const, cpuQuotaMicros: 100_000, memoryMaxBytes: 32 * 1024 * 1024,
    swapMaxBytes: 0, tasksMax: 8, scratchMaxBytes: 1024 * 1024, wallMaxMs: 1000,
    stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 8 * 1024 * 1024 };
  try {
    const result = await executeOwnedCodingCanarySchedule({ owner, profile: null, privateCorpus: validated.corpus,
      ledgerPath: join(root, "control-ledger"), appendCodingLedger: (_path, row) => { ledger.push(row); },
      schedulePorts: {
        eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false,
          squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
        ports: slot => ({ admit: async () => ({ state: "admitted" }), monotonicMs: () => 10,
          save: async run => { runs.push(run); }, request: async () => ({
            text: JSON.stringify({ source: "/* simulated backend output retention control */" }), toolCalls: [],
            resources: { durationMs: 7, firstTextMs: 2, generationMs: 5, inputTokens: 10, outputTokens: 3,
              cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, usageRatedUsd: null,
              billing: "subscription", servedModel: slot.pin.model === "coder-a" ? slot.pin.model : null,
              terminal: "complete", executionEvidence: workerExecutionEvidence(randomUUID(), {
                provider: "claude", childEnvKeys: [], isError: false, model: slot.pin.model,
                servedModel: slot.pin.model === "coder-a" ? slot.pin.model : null,
                tokens: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 } }) } }) }),
      } }, plan, cases, { codingPortFactory: (slot, slotOwner) => async request => {
        assert.equal(request.fixture.caseId, slot.caseId, "validated task-instance identity reaches the result join");
        const consumed = slotOwner.consumeCodingAttempt(slot, { runId: request.runId,
          canaryAttemptId: request.canaryAttemptId, workerSpawnAttemptId: request.workerSpawnAttemptId,
          sourceDigest: request.sourceDigest });
        if (consumed.state !== "consumed") assert.fail("paired owner consumption failed");
        const binding = codingAttemptConsumptionBinding(consumed.capability)!;
        const hostExecutionId = `simulated-host-${binding.codingExecutionAttemptId}`;
        const missing = slot.caseId === partial.id;
        const stdout = missing || slot.pin.model === "coder-a" ? request.fixture.expectedStdout : "incorrect\n";
        // Source-unit simulation tests retention only; these counters never qualify a Linux host.
        const observed = { cpuUsec: 23, memoryPeakBytes: 4096, swapPeakBytes: 0, pidsPeak: 2,
          scratchPeakBytes: missing ? null : 128, wallMs: 4, stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 0, heapPeakBytes: missing ? null : 512 };
        const authority = bindCodingExecutionAuthority({ binding, configured, consumption: consumed.capability,
          execute: async () => missing ? { state: "unavailable", reason: "resource-readback-incomplete", configured,
            execution: { hostStarted: "yes", closure: "proven", hostExecutionId }, partial: {
              binding, hostExecutionId, candidateDigest: request.sourceDigest, exitCode: 0, stdout, stderr: "", observed,
              candidateClosedBeforeMetrics: true, metricsCapturedBeforeCollection: true, unitEmptyAfterStop: true } }
            : { state: "complete", raw: { binding, hostExecutionId, candidateDigest: request.sourceDigest,
              configured, observed, exitCode: 0, stdout, stderr: "", restrictions: { privateNonGitRoot: true,
                networkNamespaceIsolated: true, noHostDataMounts: true, noCredentialMounts: true,
                noPackageInstall: true, oracleNotMounted: true }, lifecycle: { cancelled: false,
                candidateClosedBeforeMetrics: true, metricsCapturedBeforeCollection: true, unitEmptyAfterStop: true } } } });
        const codingResult = await executeCodingCandidate({ binding, fixture: request.fixture,
          responseText: request.responseText, authority, signal: request.signal });
        const codingGrade = scoreCodingControl(request.fixture, codingResult);
        outcomes.push({ codingResult, codingGrade });
        return codingResult;
      } });
    assert.equal(result.completed, 3);
    assert.equal(result.state, "deferred", "missing native peaks remain unavailable");
    assert.deepEqual({ plan, cases }, before, "execution never changes the prepared schedule or rotated task contracts");
    assert.equal(ledger.length, 3);
    const pairedRuns = runs.filter(run => run.caseId === rotated.id);
    assert.equal(pairedRuns.length, 2);
    assert.equal(pairedRuns.find(run => run.model === "coder-a")!.verified, true);
    assert.equal(pairedRuns.find(run => run.model === "coder-b")!.verified, false);
    for (const run of runs) {
      assert.equal(run.trial!.scheduleDigest, before.plan.digest);
      assert.deepEqual(run.trial!.plannedSlotIds, plan.slots.filter(slot => slot.caseId === run.caseId).map(slot => slot.id));
      const attempt = run.attempts[0]!, observation = attempt.codingExecution!;
      assert.notEqual(run.id, attempt.id);
      assert.notEqual(attempt.id, observation.workerSpawnAttemptId);
      assert.notEqual(observation.workerSpawnAttemptId, observation.codingExecutionAttemptId);
      assert.notEqual(observation.hostExecutionId, observation.codingExecutionAttemptId);
      assert.equal(observation.observed!.memoryPeakBytes, 4096);
      assert.notEqual(observation.configured!.memoryMaxBytes, observation.observed!.memoryPeakBytes);
    }
    const projection = projectCanaryRuns(runs);
    assertImportedCodingMetrics(pairedRuns.find(run => run.model === "coder-a")!);
    const unknown = projection.groups.find(group => group.model === "coder-b")!;
    assert.equal(unknown.identityComparable, false);
    assert.equal(unknown.servedIdentityKnown, 0);
    assert.equal(unknown.subscriptionNotional.totalUsd, null);
    assert.ok(unknown.codingExecution!.rows.every(row => row.observedResources!.cpuUsec === 23));
    const unavailable = runs.find(run => run.caseId === partial.id)!;
    assert.equal(unavailable.verified, null);
    assert.equal(outcomes.at(-1)!.codingGrade!.observedCorrectness, true);
    assert.equal(outcomes.at(-1)!.codingGrade!.passed, null);
    const retained = projection.groups.flatMap(group => group.codingExecution!.rows)
      .find(row => row.state === "unavailable")!;
    assert.equal(retained.reason, "resource-readback-incomplete");
    assert.equal(retained.observedResources!.scratchPeakBytes, null);
    assert.equal(retained.observedResources!.heapPeakBytes, null);
    const pairs = analyzeCanaryPairs(runs);
    assert.equal(pairs.completeBlocks, 1);
    assert.equal(pairs.comparisons[0]!.pairs[0]!.caseId, rotated.id);
    assert.deepEqual(pairs.comparisons[0]!.pairs[0]!.differences,
      { correct: null, durationMs: null, inputTokens: null, outputTokens: null, usageRatedUsd: null });
    assert.equal(pairs.exclusions[0]!.reason, "incomplete-planned-block");
    const wrongFixture = syntheticCodingFixture(rotated.codingControl!.seed);
    assert.equal(scoreCodingControl(wrongFixture, outcomes[0]!.codingResult!).reason, "coding-case-binding-mismatch");
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("coding candidate schema is bounded and expected output never enters the provider request", () => {
  const fixture = syntheticCodingFixture("request-split-control");
  const request = codingRequestFixture(fixture);
  assert.equal(request.fixtureDigest, fixture.digest);
  assert.equal(JSON.stringify(request).includes(fixture.expectedStdout), false);
  assert.equal(parseCodingCandidate(JSON.stringify({ source: "process.stdout.write('ok\\n')" })).source,
    "process.stdout.write('ok\\n')");
  assert.throws(() => parseCodingCandidate(JSON.stringify({ source: "x", expectedStdout: "secret" })), /shape-invalid/);
  assert.throws(() => parseCodingCandidate(JSON.stringify({ source: "\0" })), /source-bound/);
  assert.throws(() => scoreCodingControl({ ...fixture, expectedStdout: "forged\n" }, refuseCodingBeforeHost("native-backend-unavailable")),
    /coding-fixture-invalid/);
});

test("pre-host refusal stays unavailable and cannot create a qualified coding score", () => {
  const fixture = syntheticCodingFixture("missing-worker-identity");
  const refused = refuseCodingBeforeHost("worker-spawn-identity-unavailable");
  assert.equal(refused.binding, null);
  assert.deepEqual(refused.execution, { hostStarted: "no", closure: "proven", hostExecutionId: null });
  const grade = scoreCodingControl(fixture, refused);
  assert.equal(grade.state, "unavailable");
  assert.equal(grade.passed, null);
  assert.equal(grade.observedCorrectness, null);
});

test("coding execution authority requires the exact opaque owner consumption capability", () => {
  const fixture = syntheticCodingFixture("authority-owner-binding");
  const candidate = parseCodingCandidate(JSON.stringify({ source: "process.stdout.write('0\\n')" }));
  const binding = { caseId: fixture.caseId, suiteHash: "d".repeat(64),
    runId: "572f08c0-7ed1-4a89-a5ef-40b5cd4e4fbe", slotId: "e".repeat(64),
    canaryAttemptId: "a16d15b1-5644-4a7e-b68a-58d454cc4ab1",
    workerSpawnAttemptId: "019f5ab2-4420-4ea0-993f-470a56362e04",
    codingExecutionAttemptId: "74353ef1-5ea2-4a81-930f-cb31399f5e3c", sourceDigest: candidate.sourceDigest };
  const jsonLookalike = Object.freeze({ kind: "canary-coding-attempt-consumed-v1", binding });
  assert.throws(() => bindCodingExecutionAuthority({ binding, configured: {} as never,
    execute: async () => { throw new Error("must-not-run"); },
    consumption: jsonLookalike as unknown as CodingAttemptConsumptionCapability }),
  /coding-owner-consumption-capability-required/);
});

test("one owner consumption capability invokes the coding executor at most once", async () => {
  const root = privateTestRoot();
  const directory = join(root, "owner"); mkdirSync(directory, { mode: 0o700 });
  const owner = new CanarySlotOwner(directory);
  const fixture = syntheticCodingFixture("one-shot-executor");
  const responseText = JSON.stringify({ source: "process.stdout.write('0\\n')" });
  const candidate = parseCodingCandidate(responseText);
  const slot = { id: "e".repeat(64), caseId: fixture.caseId,
    pin: { model: "synthetic", route: "coding-control", effort: "medium", suiteHash: "d".repeat(64), billing: "api" as const },
    aaLabel: null };
  const runId = "572f08c0-7ed1-4a89-a5ef-40b5cd4e4fbe";
  const canaryAttemptId = "a16d15b1-5644-4a7e-b68a-58d454cc4ab1";
  const workerSpawnAttemptId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  assert.equal(owner.claim(slot), "claimed");
  const consumed = owner.consumeCodingAttempt(slot, { runId, canaryAttemptId, workerSpawnAttemptId,
    sourceDigest: candidate.sourceDigest });
  assert.equal(consumed.state, "consumed");
  if (consumed.state !== "consumed") throw new Error("owner-consumption-control-failed");
  const binding = { caseId: slot.caseId, suiteHash: slot.pin.suiteHash, runId, slotId: slot.id,
    canaryAttemptId, workerSpawnAttemptId, codingExecutionAttemptId: consumed.capability.binding.codingExecutionAttemptId,
    sourceDigest: candidate.sourceDigest };
  const configured = { profileId: "test-profile", profileDigest: "1".repeat(64), binaryDigest: "2".repeat(64),
    runtimeId: "node-source-stdin-stdout-v1" as const, cpuQuotaMicros: 100_000, memoryMaxBytes: 32 * 1024 * 1024,
    swapMaxBytes: 0, tasksMax: 8, scratchMaxBytes: 1024 * 1024, wallMaxMs: 1000,
    stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 8 * 1024 * 1024 };
  let calls = 0;
  const authority = bindCodingExecutionAuthority({ binding, configured, consumption: consumed.capability,
    execute: async () => { calls++; throw new Error("executor-closure-unknown-control"); } });
  try {
    const first = await executeCodingCandidate({ binding, fixture, responseText, authority, signal: new AbortController().signal });
    assert.equal(first.state, "unavailable");
    assert.equal(first.reason, "native-executor-error");
    const duplicate = await executeCodingCandidate({ binding, fixture, responseText, authority, signal: new AbortController().signal });
    assert.equal(duplicate.state, "unavailable");
    assert.equal(duplicate.reason, "owner-attempt-already-consumed");
    assert.equal(calls, 1);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});
