import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryPassInterval, canaryStreamClock, projectCanaryRuns, canaryTrialBlockId, type CanaryAttempt, type CanaryRun } from "../src/lib/model-canary-metrics.js";
const attempt = (id: string, usd: number | null = .02): CanaryAttempt => ({ id, durationMs: 20, firstTextMs: null,
  generationMs: null, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null,
  reasoningTokens: null, usageRatedUsd: usd, billing: "api", servedModel: "model", terminal: "complete" });
const run = (id: string, verified: boolean | null = true): CanaryRun => ({ id, caseId: "case", suiteHash: "a".repeat(64),
  model: "model", route: "azure", effort: "low", family: "schema", verified, totalDurationMs: 100, attempts: [attempt(id)] });

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


test("descriptive attempt resources retain ungraded unpriced failures and measured zero without inventing missing totals", () => {
  const a = run("ungraded", null); a.attempts[0]!.usageRatedUsd = null;
  a.attempts[0]!.firstTextMs = 0; a.attempts[0]!.cacheReadTokens = 0;
  a.attempts.push({ ...attempt("failed", null), terminal: "error", durationMs: null, outputTokens: null, servedModel: null });
  const g = projectCanaryRuns([a]).groups[0]!, m = g.attemptMeasurements;
  assert.deepEqual(m.durationMs, { sampleUnit: "attempt", observed: 1, missing: 1, p50: 20, p95: null, observedTotal: 20, total: null, overflow: false });
  assert.equal(m.firstTextMs.p50, 0); assert.equal(m.cacheReadTokens.observedTotal, 0);
  assert.equal(m.outputTokens.total, null); assert.equal(m.outputTokens.p50, 10);
  assert.equal(g.failedAttempts, 1); assert.equal(g.observed, 0); assert.equal(g.passRate, null);
  assert.equal(g.apiEstimate.totalUsd, null); assert.equal(g.identityComparable, false); assert.equal(g.invoiceUsd, null);
  const empty = run("no-attempt", null); empty.attempts = [];
  const zero = projectCanaryRuns([empty]).groups[0]!.attemptMeasurements.inputTokens;
  assert.equal(zero.observed, 0); assert.equal(zero.missing, 0); assert.equal(zero.p50, null);
  assert.equal(zero.total, null); assert.equal(zero.observedTotal, null);
});

test("descriptive resource tails require twenty measured attempts and overflow cannot become a finite total", () => {
  const rows = Array.from({ length: 20 }, (_, i) => { const r = run("tail-" + i, null); r.attempts[0]!.durationMs = i; return r; });
  assert.equal(projectCanaryRuns(rows.slice(0, 19)).groups[0]!.attemptMeasurements.durationMs.p95, null);
  const g = projectCanaryRuns([...rows, structuredClone(rows[0]!)]).groups[0]!;
  assert.equal(g.attemptMeasurements.durationMs.observed, 20); assert.equal(g.attemptMeasurements.durationMs.p95, 18);
  assert.equal(g.attemptMeasurements.durationMs.total, 190);
  rows[0]!.attempts[0]!.durationMs = Number.MAX_VALUE; rows[1]!.attempts[0]!.durationMs = Number.MAX_VALUE;
  const overflow = projectCanaryRuns(rows).groups[0]!.attemptMeasurements.durationMs;
  assert.equal(overflow.overflow, true); assert.equal(overflow.total, null); assert.equal(overflow.observedTotal, null);
});
