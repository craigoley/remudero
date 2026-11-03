import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryPassInterval, canaryStreamClock, projectCanaryRuns, canaryTrialBlockId, type CanaryAttempt, type CanaryRun } from "../src/lib/model-canary-metrics.js";
import type { WorkerExecutionEvidenceV1 } from "#src/lib/worker-execution-evidence.js";
const attempt = (id: string, usd: number | null = .02): CanaryAttempt => ({ id, durationMs: 20, firstTextMs: null,
  generationMs: null, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null,
  reasoningTokens: null, usageRatedUsd: usd, billing: "api", servedModel: "model", terminal: "complete" });
const run = (id: string, verified: boolean | null = true): CanaryRun => ({ id, caseId: "case", suiteHash: "a".repeat(64),
  model: "model", route: "azure", effort: "low", family: "schema", verified, totalDurationMs: 100, attempts: [attempt(id)] });
const observed = <T>(value: T) => ({ state: "observed" as const, value });
const unavailable = (reason: string) => ({ state: "unavailable" as const, reason });
function executionEvidence(attemptId: string, billing: "api" | "subscription" = "api"): WorkerExecutionEvidenceV1 {
  const isApi = billing === "api";
  return {
    version: "worker-execution-evidence-v1", attemptId, unit: "worker-spawn", measurementScope: "returned-terminal-result",
    assignment: unavailable("assignment-not-needed-by-this-projection"), providerInvoked: observed(true),
    identity: { provider: observed(isApi ? "cash" : "claude"), configuredModel: observed("model"), routedModel: observed("model"),
      sdkRequestedModel: observed("model"), sdkRequestedEffort: observed("low"), servedModel: observed("model") },
    execution: { terminal: observed("success"), durationMs: observed(0), firstTextMs: observed(0),
      tokenUsage: { state: "observed", value: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } },
      requestEfforts: observed([]), invocationCount: unavailable("not-attempt-scoped"), fallbackCoverage: unavailable("not-joined"),
      peakRssBytes: unavailable("not-measured") },
    accounting: { billingMode: observed(billing), apiUsageRatedUsd: isApi ? observed(0) : unavailable("not-api"),
      subscriptionNotionalUsd: isApi ? unavailable("not-subscription") : observed(0),
      billedCashUsd: isApi ? observed(0) : unavailable("not-cash"), invoiceUsd: unavailable("not-invoice-evidence"),
      cashBudget: { reservedUsd: isApi ? observed(0) : unavailable("not-cash"),
        settledUsd: isApi ? observed(0) : unavailable("not-cash"), heldUsd: isApi ? observed(0) : unavailable("not-cash") } },
  };
}

function trialRun(id: string, position = 0): CanaryRun {
  const row = run(id), day = "2026-10-11", scheduleDigest = "b".repeat(64), plannedSlotIds = ["c".repeat(64), "d".repeat(64)];
  row.trial = { version: "canary-trial-block-v1", day, scheduleDigest, plannedSlotIds, position,
    slotId: plannedSlotIds[position]!, aaLabel: position ? "B" : "A",
    blockId: canaryTrialBlockId(day, row.suiteHash, row.caseId, scheduleDigest, plannedSlotIds) };
  return row;
}

test("canary projection keeps historical runs unpaired and repeated cases as one trial block", () => {
  const a = trialRun("one"), b = trialRun("two", 1), historical = run("historical");
  const projection = projectCanaryRuns([a, b, historical, structuredClone(a)]), g = projection.groups[0]!;
  assert.equal(projection.uniqueRuns, 3); assert.equal(g.tasks, 3); assert.equal(g.distinctCases, 1);
  assert.equal(g.trialBlocks, 1); assert.equal(g.unpairedRuns, 1);
  assert.equal(g.intervalBasis, "descriptive-run-not-independent-case");
  assert.equal(g.invoiceUsd, null);
});

test("canary metrics retain distinct canary and worker spawn identities through an explicit join", () => {
  const row = run("run-join"), call = attempt("canary-attempt");
  const workerSpawnAttemptId = "b2044072-86e2-4b85-b871-3735362cb492";
  call.executionEvidence = executionEvidence(workerSpawnAttemptId);
  call.workerExecutionJoin = { version: "canary-worker-execution-join-v1", runId: row.id,
    canaryAttemptId: call.id, workerSpawnAttemptId, unit: "worker-spawn", measurementScope: "returned-terminal-result" };
  row.attempts = [call];
  const projection = projectCanaryRuns([row]).groups[0]!.executionEvidence;
  assert.equal(projection.observed, 1);
  assert.equal(projection.attemptRows[0]!.attemptId, call.id);
  assert.equal(projection.attemptRows[0]!.workerSpawnAttemptId, workerSpawnAttemptId);
  const mismatched = { ...row, id: "run-other", attempts: [{ ...call,
    workerExecutionJoin: { ...call.workerExecutionJoin, runId: "run-wrong" } }] };
  const invalid = projectCanaryRuns([mismatched]).groups[0]!.executionEvidence;
  assert.equal(invalid.invalid, 1);
  assert.equal(invalid.attemptRows[0]!.workerSpawnAttemptId, workerSpawnAttemptId);
});

test("canary projection refuses case block corruption and reused durable slot identities", () => {
  const a = trialRun("one");
  const corruptions = [
    { version: "other" }, { day: "bad" }, { day: "2026-02-30" }, { scheduleDigest: "missing" },
    { slotId: "missing" }, { plannedSlotIds: null }, { plannedSlotIds: [] },
    { plannedSlotIds: Array(129).fill("c".repeat(64)) }, { plannedSlotIds: [null] },
    { plannedSlotIds: ["c".repeat(64), "c".repeat(64)] }, { position: -1 }, { position: .5 },
    { position: 128 }, { aaLabel: "wrong" }, { blockId: "missing" },
  ];
  for (const change of corruptions) {
    const changed = structuredClone(a);
    Object.assign(changed.trial!, change);
    assert.throws(() => projectCanaryRuns([changed]), /trial-block-invalid/, JSON.stringify(change));
  }
  assert.throws(() => projectCanaryRuns([{ ...a, trial: null } as unknown as CanaryRun]), /trial-block-invalid/);
  assert.throws(() => projectCanaryRuns([{ ...a, caseId: "other-case" }]), /trial-block-invalid/);
  assert.throws(() => projectCanaryRuns([a, { ...trialRun("other-id"), verified: false }]), /trial-slot-reused/);
  assert.notEqual(a.trial!.blockId, canaryTrialBlockId("2026-10-12", a.suiteHash, a.caseId,
    a.trial!.scheduleDigest, a.trial!.plannedSlotIds));
});

test("canary cost includes failed attempts and retries without fabricating missing prices", () => {
  const first = run("one"); first.attempts.push({ ...attempt("retry", .03), terminal: "error" });
  const failed = run("two", false);
  const group = projectCanaryRuns([first, failed]).groups[0]!;
  assert.equal(group.tasks, 2); assert.equal(group.attempts, 3); assert.equal(group.failedAttempts, 1);
  assert.equal(group.apiEstimate.perCorrectTaskUsd, .07); assert.equal(group.subscriptionNotional.totalUsd, null);
  assert.equal(group.invoiceUsd, null); assert.equal(group.completionP50Ms, 100); assert.equal(group.completionP95Ms, null);
  failed.attempts[0]!.usageRatedUsd = null;
  assert.equal(projectCanaryRuns([first, failed]).groups[0]!.apiEstimate.perCorrectTaskUsd, null);
  assert.equal(projectCanaryRuns([run("zero", false)]).groups[0]!.apiEstimate.perCorrectTaskUsd, null);
  assert.equal(projectCanaryRuns([run("unknown", null)]).groups[0]!.apiEstimate.perCorrectTaskUsd, null);
});

test("synthetic replay, native execution, and legacy unknown runs never share quality denominators", () => {
  const replay = run("replay"); replay.executionSource = "synthetic-control-replay";
  replay.sourceActivity = { kind: "synthetic-canary", source: "model-canary-v1", sourceReceiptId: "fixture-digest", lane: "offline-replay" };
  const native = run("native"); native.executionSource = "native-provider-execution";
  const legacy = run("legacy");
  const projection = projectCanaryRuns([replay, native, legacy]);
  const groups = projection.groups;
  assert.equal(projection.executionSourceTrust, "caller-declared-unverified");
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => [group.executionSource, group.tasks, group.correct]).sort(), [
    ["native-provider-execution", 1, 1], ["synthetic-control-replay", 1, 1], ["unclassified", 1, 1],
  ]);
  assert.throws(() => projectCanaryRuns([{ ...legacy, executionSource: "caller-claimed" } as unknown as CanaryRun]),
    /execution-source-invalid/);
});

test("canary cohort projection refuses conflicting duplicates and distinguishes served identity", () => {
  const a = run("same"); assert.equal(projectCanaryRuns([a, structuredClone(a)]).uniqueRuns, 1);
  assert.throws(() => projectCanaryRuns([a, { ...a, verified: false }]), /conflicting/);
  assert.throws(() => projectCanaryRuns([a, { ...run("other"), attempts: a.attempts }]), /identity-reused/);
  a.attempts[0]!.servedModel = null; assert.equal(projectCanaryRuns([a]).groups[0]!.identityComparable, false);
  a.attempts[0]!.servedModel = "different"; assert.equal(projectCanaryRuns([a]).groups[0]!.servedMismatch, 1);
  a.attempts[0]!.usageRatedUsd = NaN; assert.throws(() => projectCanaryRuns([a]), /measurement-invalid/);
  assert.throws(() => projectCanaryRuns(Array(8193).fill(run("x"))), /projection-bound/);
});

test("canary stream timing preserves unknown TTFT and refuses an invalid monotonic clock", () => {
  const c = canaryStreamClock(100); c.text(101, ""); c.text(120, "first"); c.text(160, "last");
  assert.deepEqual(c.finish(200), { durationMs: 100, firstTextMs: 20, generationMs: 40 });
  assert.deepEqual(canaryStreamClock(100).finish(150), { durationMs: 50, firstTextMs: null, generationMs: null });
  const invalid = canaryStreamClock(100); invalid.text(90, "bad"); assert.equal(invalid.finish(150).firstTextMs, null);
  assert.equal(canaryPassInterval(0, 0), null);
  assert.ok(canaryPassInterval(60, 60)![0] < 1);
});

test("W1-T10956: cost and resource drilldowns preserve missing evidence and keep non-dispatch reviews outside coding cohorts", () => {
  const measured = run("measured");
  measured.family = "review";
  measured.executionSource = "native-provider-execution";
  measured.attempts[0]!.executionEvidence = executionEvidence(measured.attempts[0]!.id);
  measured.sourceActivity = { kind: "coding-dispatch", source: "benchmark-run-v1", sourceReceiptId: "receipt-coding", lane: "impl" };
  const review = run("review");
  review.family = "review";
  review.sourceActivity = { kind: "non-dispatch-review", source: "benchmark-run-v1", sourceReceiptId: "receipt-review", lane: "review" };
  const syntheticReview = run("synthetic-review");
  syntheticReview.family = "review";
  syntheticReview.executionSource = "synthetic-control-replay";
  syntheticReview.sourceActivity = { kind: "synthetic-canary", source: "model-canary-v1", sourceReceiptId: "receipt-synthetic", lane: "canary" };
  const unknown = run("unknown");
  unknown.family = "review";
  const projected = projectCanaryRuns([measured, review, syntheticReview, unknown]);
  const native = projected.groups.find(group => group.executionSource === "native-provider-execution")!;
  const unclassified = projected.groups.find(group => group.executionSource === "unclassified" && group.tasks === 2)!;
  const replay = projected.groups.find(group => group.executionSource === "synthetic-control-replay")!;
  assert.equal(native.tasks, 1);
  assert.equal(native.passRate, 1);
  assert.equal(native.executionEvidence.observed, 1);
  assert.equal(native.executionEvidence.absent, 0);
  assert.equal(native.executionEvidence.invalid, 0);
  assert.equal(native.executionEvidence.freshness.state, "unknown");
  assert.equal(native.executionEvidence.workerDurationMs.observed, 1);
  assert.equal(native.executionEvidence.workerDurationMs.p50, 0);
  assert.equal(native.executionEvidence.peakRssBytes.observed, 0);
  assert.equal(native.executionEvidence.peakRssBytes.unavailable, 1);
  assert.equal(native.executionEvidence.accounting.apiUsageRatedUsd.observed, 1);
  assert.equal(native.executionEvidence.accounting.apiUsageRatedUsd.observedLowerBound, 0);
  assert.equal(native.executionEvidence.accounting.apiUsageRatedUsd.total, 0);
  assert.equal(native.executionEvidence.accounting.invoiceUsd.total, null);
  assert.equal(native.executionEvidence.accounting.invoiceUsd.observed, 0);
  assert.equal(native.apiEstimate.totalUsd, .02);
  assert.equal(native.codingCohort.includedAttempts, 1);
  assert.equal(native.codingCohort.excludedNonDispatchReviewAttempts, 0);
  assert.equal(native.codingCohort.excludedSyntheticCanaryAttempts, 0);
  assert.equal(native.codingCohort.unclassifiedAttempts, 0);
  assert.deepEqual(native.codingCohort.sourceReceiptIds, ["receipt-coding"]);
  assert.equal(unclassified.passRate, 1);
  assert.equal(unclassified.executionEvidence.observed, 0);
  assert.equal(unclassified.executionEvidence.absent, 2);
  assert.equal(unclassified.executionEvidence.invalid, 0);
  assert.equal(unclassified.executionEvidence.freshness.state, "unknown");
  assert.equal(unclassified.executionEvidence.workerDurationMs.unavailable, 2);
  assert.equal(unclassified.executionEvidence.peakRssBytes.unavailable, 2);
  assert.equal(unclassified.executionEvidence.accounting.apiUsageRatedUsd.total, null);
  assert.equal(unclassified.executionEvidence.accounting.invoiceUsd.total, null);
  assert.equal(unclassified.apiEstimate.totalUsd, .04);
  assert.equal(unclassified.codingCohort.includedAttempts, 0);
  assert.equal(unclassified.codingCohort.excludedNonDispatchReviewAttempts, 1);
  assert.equal(unclassified.codingCohort.excludedSyntheticCanaryAttempts, 0);
  assert.equal(unclassified.codingCohort.unclassifiedAttempts, 1);
  assert.deepEqual(unclassified.codingCohort.sourceReceiptIds, ["receipt-review"]);
  assert.equal(replay.tasks, 1);
  assert.equal(replay.executionEvidence.observed, 0);
  assert.equal(replay.executionEvidence.absent, 1);
  assert.equal(replay.executionEvidence.peakRssBytes.unavailable, 1);
  assert.equal(replay.executionEvidence.accounting.invoiceUsd.total, null);
  assert.equal(replay.apiEstimate.totalUsd, .02);
  assert.equal(replay.codingCohort.includedAttempts, 0);
  assert.equal(replay.codingCohort.excludedSyntheticCanaryAttempts, 1);
  assert.deepEqual(replay.codingCohort.sourceReceiptIds, ["receipt-synthetic"]);
});

test("canary execution evidence rejects mismatched identities and forged or malformed private JSON without changing quality", () => {
  const invalidCases: Array<(evidence: WorkerExecutionEvidenceV1) => void> = [
    evidence => { (evidence as unknown as { attemptId: string }).attemptId = "different-attempt"; },
    evidence => { (evidence as unknown as { version: string }).version = "worker-execution-evidence-v2"; },
    evidence => { (evidence as unknown as { unit: string }).unit = "provider-request"; },
    evidence => { (evidence.identity.servedModel as unknown as { value: string }).value = "m".repeat(201); },
    evidence => { (evidence.identity.servedModel as unknown as { value: string }).value = "different-served-model"; },
    evidence => { (evidence.identity.provider as unknown as { value: string }).value = "openweight"; },
    evidence => { (evidence.execution.durationMs as unknown as { value: unknown }).value = Number.NaN; },
    evidence => { (evidence.execution.tokenUsage as unknown as { value: { input: unknown } }).value.input = 1.5; },
    evidence => { (evidence.accounting.invoiceUsd as unknown as { state: string; value: number }).state = "observed"; },
    evidence => { (evidence.accounting.billingMode as unknown as { value: string }).value = "subscription"; },
  ];
  for (const corrupt of invalidCases) {
    const row = run("attempt-id");
    const evidence = executionEvidence(row.attempts[0]!.id);
    corrupt(evidence);
    row.attempts[0]!.executionEvidence = evidence;
    const projection = projectCanaryRuns([row]), group = projection.groups[0]!;
    assert.equal(group.passRate, 1);
    assert.equal(group.executionEvidence.observed, 0);
    assert.equal(group.executionEvidence.invalid, 1);
    assert.equal(group.executionEvidence.accounting.apiUsageRatedUsd.total, null);
    assert.equal(group.apiEstimate.totalUsd, .02);
  }
});

test("partial worker token evidence is visible as partial and never projected as exact counters", () => {
  const row = run("partial-token");
  const evidence = executionEvidence(row.attempts[0]!.id);
  (evidence.execution.tokenUsage as unknown as { state: string }).state = "partial";
  row.attempts[0]!.executionEvidence = evidence;
  const group = projectCanaryRuns([row]).groups[0]!;
  assert.equal(group.executionEvidence.inputTokens.partial, 1);
  assert.equal(group.executionEvidence.inputTokens.total, null);
  assert.equal(group.executionEvidence.inputTokens.observedLowerBound, null);
  assert.equal(group.executionEvidence.attemptRows[0]!.inputTokens, null);
});

test("unavailable token usage needs a bounded reason and is otherwise rejected as invalid evidence", () => {
  const withTokenUsage = (id: string, tokenUsage: unknown) => {
    const row = run(id);
    const evidence = executionEvidence(row.attempts[0]!.id);
    (evidence.execution as unknown as { tokenUsage: unknown }).tokenUsage = tokenUsage;
    row.attempts[0]!.executionEvidence = evidence;
    return projectCanaryRuns([row]).groups[0]!.executionEvidence;
  };
  const reasoned = withTokenUsage("token-unavailable-reasoned", unavailable("provider-reported-no-usage"));
  assert.equal(reasoned.observed, 1);
  assert.equal(reasoned.invalid, 0);
  for (const [id, malformed] of [
    ["token-unavailable-no-reason", { state: "unavailable" }],
    ["token-unavailable-empty-reason", { state: "unavailable", reason: "" }],
    ["token-unavailable-long-reason", { state: "unavailable", reason: "r".repeat(100_000) }],
  ] as const) {
    const projected = withTokenUsage(id, malformed);
    assert.equal(projected.observed, 0, id);
    assert.equal(projected.invalid, 1, id);
  }
});

test("unknown provider identity remains unavailable in cash accounting denominators", () => {
  const cash = run("known-cash"), unknownProvider = run("unknown-provider");
  cash.attempts[0]!.executionEvidence = executionEvidence(cash.attempts[0]!.id);
  const evidence = executionEvidence(unknownProvider.attempts[0]!.id);
  (evidence.identity.provider as unknown as { state: string; reason: string }).state = "unavailable";
  (evidence.identity.provider as unknown as { state: string; reason: string }).reason = "provider-not-recorded";
  const accountingEvidence = evidence.accounting as unknown as {
    billedCashUsd: { state: string; reason: string };
    cashBudget: { reservedUsd: { state: string; reason: string }; settledUsd: { state: string; reason: string };
      heldUsd: { state: string; reason: string } };
  };
  accountingEvidence.billedCashUsd = unavailable("provider-not-recorded");
  accountingEvidence.cashBudget.reservedUsd = unavailable("provider-not-recorded");
  accountingEvidence.cashBudget.settledUsd = unavailable("provider-not-recorded");
  accountingEvidence.cashBudget.heldUsd = unavailable("provider-not-recorded");
  unknownProvider.attempts[0]!.executionEvidence = evidence;

  const accounting = projectCanaryRuns([cash, unknownProvider]).groups[0]!.executionEvidence.accounting;
  for (const metric of [accounting.billedCashUsd, accounting.reservedUsd, accounting.settledUsd, accounting.heldUsd]) {
    assert.equal(metric.attempts, 2);
    assert.equal(metric.observed, 1);
    assert.equal(metric.unavailable, 1);
    assert.equal(metric.notApplicable, 0);
    assert.equal(metric.total, null);
  }
});
