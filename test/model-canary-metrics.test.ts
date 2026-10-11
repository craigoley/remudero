import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryPassInterval, canaryStreamClock, projectCanaryRuns, type CanaryAttempt, type CanaryRun } from "../src/lib/model-canary-metrics.js";
const attempt = (id: string, usd: number | null = .02): CanaryAttempt => ({ id, durationMs: 20, firstTextMs: null,
  generationMs: null, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null,
  reasoningTokens: null, usageRatedUsd: usd, billing: "api", servedModel: "model", terminal: "complete" });
const run = (id: string, verified: boolean | null = true): CanaryRun => ({ id, caseId: "case", suiteHash: "a".repeat(64),
  model: "model", route: "azure", effort: "low", family: "schema", verified, totalDurationMs: 100, attempts: [attempt(id)] });

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
