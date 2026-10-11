import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { analyzeCanaryPairs } from "../src/lib/model-canary-paired-analysis.js";
import { canaryTrialBlockId, type CanaryRun } from "../src/lib/model-canary-metrics.js";
import { renderCanaryReport } from "../src/lib/model-canary-report.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function block(day = "2026-10-10", caseId = "case-1", aa = false): CanaryRun[] {
  const slots = [hash(day+caseId+"a"), hash(day+caseId+"b")], suiteHash = hash("suite"), scheduleDigest = hash(day);
  return [0, 1].map(i => ({ id: day+caseId+i, caseId, suiteHash, family: "schema", model: aa ? "model-a" : "model-"+(i ? "b" : "a"),
    route: "subscription", effort: "medium", verified: i === 0, totalDurationMs: 10+i*5,
    attempts: [{ id: day+caseId+i+"attempt", durationMs: 10, firstTextMs: 1, generationMs: 9,
      inputTokens: 20, outputTokens: 3+i, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      usageRatedUsd: 0.01+i*0.01, billing: "subscription", servedModel: aa ? "model-a" : "model-"+(i ? "b" : "a"), terminal: "complete" }],
    trial: { version: "canary-trial-block-v1", day, scheduleDigest, plannedSlotIds: slots, slotId: slots[i]!, position: i,
      blockId: canaryTrialBlockId(day, suiteHash, caseId, scheduleDigest, slots), aaLabel: aa ? i ? "B" : "A" : null } }));
}

test("paired canary analysis requires complete scheduled blocks and retains descriptive metric provenance", () => {
  const rows = block(), result = analyzeCanaryPairs(rows), c = result.comparisons[0]!;
  assert.equal(result.completeBlocks, 1); assert.equal(result.inference, "descriptive-only");
  assert.equal(c.pairs[0]!.differences.correct, -1); assert.equal(c.pairs[0]!.differences.durationMs, 5);
  assert.equal(c.pairs[0]!.leftRunId, rows[0]!.id); assert.equal(c.billing, "subscription");
  assert.equal(c.metrics.outputTokens.caseBalancedMeanDifference, 1); assert.equal(c.metrics.correct.uncertainty, null);
  const incomplete = analyzeCanaryPairs(rows.slice(0, 1));
  assert.equal(incomplete.comparisons.length, 0); assert.equal(incomplete.exclusions[0]!.reason, "incomplete-planned-block");
});

test("paired canary analysis averages repeated case differences before averaging distinct cases", () => {
  const one = block(), repeat = block("2026-10-11"), other = block("2026-10-10", "case-2");
  other[1]!.totalDurationMs = 25;
  const c = analyzeCanaryPairs([...one, ...repeat, ...other]).comparisons[0]!;
  assert.equal(c.distinctCases, 2); assert.equal(c.observedDays, 2);
  assert.equal(c.metrics.durationMs.observedPairs, 3); assert.equal(c.metrics.durationMs.observedCases, 2);
  assert.equal(c.metrics.durationMs.caseBalancedMeanDifference, 10);
});

test("paired canary analysis withholds missing usage identity and outcomes without synthesizing zeros", () => {
  const rows = block(); rows[1]!.attempts[0]!.inputTokens = null; rows[1]!.verified = null;
  let c = analyzeCanaryPairs(rows).comparisons[0]!;
  assert.equal(c.metrics.inputTokens.caseBalancedMeanDifference, null); assert.equal(c.metrics.correct.observedPairs, 0);
  assert.equal(c.metrics.durationMs.observedPairs, 1);
  rows[1]!.attempts[0]!.servedModel = null; c = analyzeCanaryPairs(rows).comparisons[0]!;
  assert.equal(c.metrics.durationMs.observedPairs, 0); assert.equal(c.metrics.durationMs.plannedPairs, 1);
});

test("paired canary analysis counts retry tokens and costs inside a task and excludes incomparable configurations", () => {
  const rows = block(); rows[1]!.attempts.push({ ...rows[1]!.attempts[0]!, id: "retry", terminal: "error" });
  let c = analyzeCanaryPairs(rows).comparisons[0]!;
  assert.equal(c.metrics.outputTokens.caseBalancedMeanDifference, 5);
  assert.equal(c.pairs.length, 1);
  rows[1]!.route = "cash"; assert.equal(analyzeCanaryPairs(rows).comparisons.length, 0);
  rows[1]!.route = "subscription"; rows[1]!.effort = "max"; assert.equal(analyzeCanaryPairs(rows).comparisons.length, 0);
  rows[1]!.effort = "medium"; rows[1]!.attempts[1]!.billing = "api";
  assert.equal(analyzeCanaryPairs(rows).exclusions[0]!.reason, "billing-scope-unavailable");
});

test("paired canary A/A differences retain labels and never become a comparative winner", () => {
  const rows = block("2026-10-10", "case-1", true), c = analyzeCanaryPairs(rows).comparisons[0]!;
  assert.equal(c.mode, "A/A"); assert.equal(c.left, c.right); assert.equal(c.metrics.correct.caseBalancedMeanDifference, -1);
  assert.deepEqual(analyzeCanaryPairs([...rows].reverse()), analyzeCanaryPairs(rows));
  rows[1]!.trial!.aaLabel = "A";
  assert.equal(analyzeCanaryPairs(rows).exclusions[0]!.reason, "arm-multiplicity-unproven");
});

test("paired canary analysis preserves canonical duplicates and refuses contradictions and malformed blocks", () => {
  const rows = block(); assert.equal(analyzeCanaryPairs([...rows, structuredClone(rows[0]!)]).uniqueRuns, 2);
  assert.throws(() => analyzeCanaryPairs([...rows, { ...rows[0]!, verified: false }]), /conflicting-duplicate/);
  rows[1]!.trial!.blockId = hash("wrong"); assert.throws(() => analyzeCanaryPairs(rows), /trial-block-invalid/);
  const unpaired = block().map(r => { const c = { ...r }; delete c.trial; return c; });
  assert.equal(analyzeCanaryPairs(unpaired).unpairedRuns, 2); assert.equal(analyzeCanaryPairs(unpaired).observedBlocks, 0);
  assert.equal(analyzeCanaryPairs([]).comparisons.length, 0);
});

test("private canary report consumes actual paired analysis and keeps incomplete blocks and cash basis explicit", () => {
  const rows = block(), html = renderCanaryReport(rows);
  const json = html.match(/<script type="application\/json" id="data">([^<]+)<\/script>/)![1]!;
  const data = JSON.parse(json);
  assert.equal(data.analysis.comparisons[0].metrics.correct.caseBalancedMeanDifference, -1);
  assert.match(html, /Matched task differences/); assert.match(html, /subscription notional/);
  assert.match(html, /uncertainty and winners remain unavailable/);
  assert.equal(JSON.parse(renderCanaryReport(rows.slice(0, 1)).match(/<script type="application\/json" id="data">([^<]+)<\/script>/)![1]!).analysis.exclusions.length, 1);
});
