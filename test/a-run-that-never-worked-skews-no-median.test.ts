import assert from "node:assert/strict";
import { test } from "node:test";
import {
  costAnomalyIncidentEvent,
  costAnomalyLine,
  detectRunningLong,
  pendingCostAnomalies,
  runningLongIncidentEvent,
  runningLongLine,
  settledSpansByClass,
  type CostAnomalyPolicy,
} from "../src/lib/cost-anomaly.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { THROWN_RUN_VERDICT_STAGES } from "../src/lib/status.js";

// W1-T4709 — a run that threw or deferred before doing any work now ends with `verdict: "failed"`
// and a `stage` in THROWN_RUN_VERDICT_STAGES (W1-T4655/W1-T4701), and the operator's backfill adds
// `backfilled: true` verdicts for historical phantom runs. Each such span is setup time only; folded
// into a class's settled median it pulls the running-long threshold down onto healthy runs.

const POLICY: CostAnomalyPolicy = { multiplier: 2, minSamples: 3 };
const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const SEC = 1_000;
const MIN = 60 * SEC;
const THROWN_STAGES = [...THROWN_RUN_VERDICT_STAGES];

function run(runId: string, startMs: number, spanMs: number, verdict: Record<string, unknown>): LedgerRecord[] {
  return [
    { ts: new Date(startMs).toISOString(), run_id: runId, task_id: `W1-${runId}`, step: "run.start", task_class: "src" },
    { ts: new Date(startMs + spanMs).toISOString(), run_id: runId, task_id: `W1-${runId}`, step: "verdict", ...verdict },
  ];
}

/** Ten real `src` runs of 30 minutes and $1 each — the class's honest median. */
function realRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) => run(`REAL-${i}`, T0 + i * 40 * MIN, 30 * MIN, { verdict: i % 2 ? "merged" : "blocked_ci", cost_usd: 1 })).flat();
}

/** Ten runs that never worked: a ~10-second span and $0, each ending on a thrown-run stage. */
function thrownRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) =>
    run(`THROWN-${i}`, T0 + i * 40 * MIN + 31 * MIN, 10 * SEC, { verdict: "failed", stage: THROWN_STAGES[i % THROWN_STAGES.length], cost_usd: 0 }),
  ).flat();
}

/** Ten backfilled phantom verdicts: no thrown stage at all, so `backfilled: true` alone must exclude them. */
function backfilledRuns(): LedgerRecord[] {
  return Array.from({ length: 10 }, (_, i) =>
    run(`BACKFILL-${i}`, T0 + i * 40 * MIN + 32 * MIN, 10 * SEC, { verdict: "failed", backfilled: true, cost_usd: 0 }),
  ).flat();
}

const NOW = T0 + 1_000 * MIN;

function inFlight(runId: string, elapsedMs: number): LedgerRecord {
  return { ts: new Date(NOW - elapsedMs).toISOString(), run_id: runId, task_id: `W1-${runId}`, step: "run.start", task_class: "src" };
}

test("W1-T4709: ten real 30-minute runs and ten thrown-run rows keep a 30-minute median, never ~15", () => {
  const records = [...realRuns(), ...thrownRuns(), inFlight("HEALTHY", 45 * MIN), inFlight("LONG", 70 * MIN)];
  const fold = settledSpansByClass(records).get("src");
  assert.ok(fold, "the src class is folded");
  assert.equal(fold.spansMs.length, 10, "only the ten real runs enter the sample");
  assert.ok(fold.spansMs.every((ms) => ms === 30 * MIN), `every kept span is 30 minutes: ${fold.spansMs.join(",")}`);
  assert.equal(fold.excluded, 10, "the ten thrown runs are counted as excluded");

  const findings = detectRunningLong(records, POLICY, NOW);
  assert.deepEqual(findings.map((f) => f.runId), ["LONG"], "a 45-minute run is healthy against a 30-minute median at x2");
  assert.equal(findings[0]!.medianMs, 30 * MIN);
  assert.equal(findings[0]!.sampleSize, 10);
  assert.equal(findings[0]!.excludedCount, 10, "the excluded count is reported beside the median");
});

test("W1-T4709: every THROWN_RUN_VERDICT_STAGES stage is excluded, read from the set itself", () => {
  for (const stage of THROWN_STAGES) {
    const records = [...realRuns(), ...run("ONE", T0, 10 * SEC, { verdict: "failed", stage })];
    const fold = settledSpansByClass(records).get("src")!;
    assert.equal(fold.spansMs.length, 10, `stage ${stage} left the median`);
    assert.equal(fold.excluded, 1, `stage ${stage} is counted`);
  }
});

test("W1-T4709: backfilled verdicts are excluded and counted", () => {
  const records = [...realRuns(), ...backfilledRuns(), ...thrownRuns(), inFlight("HEALTHY", 45 * MIN), inFlight("LONG", 70 * MIN)];
  const fold = settledSpansByClass(records).get("src")!;
  assert.equal(fold.spansMs.length, 10);
  assert.equal(fold.excluded, 20, "ten backfilled plus ten thrown");
  const [finding] = detectRunningLong(records, POLICY, NOW);
  assert.equal(finding!.runId, "LONG");
  assert.equal(finding!.excludedCount, 20);
  assert.equal(runningLongLine(finding!).excluded_count, 20, "the ledgered row carries the excluded count");
  assert.match(String(runningLongIncidentEvent(finding!).message), /n=10, excluded=20\)/);
});

test("W1-T4709: a normal failed verdict with no thrown stage still counts, and nothing new is reported", () => {
  const normalFailed = Array.from({ length: 10 }, (_, i) =>
    run(`FAILED-${i}`, T0 + i * 40 * MIN + 31 * MIN, 10 * SEC, { verdict: "failed", stage: "implement", cost_usd: 0 }),
  ).flat();
  const records = [...realRuns(), ...normalFailed, inFlight("HEALTHY", 45 * MIN)];
  const fold = settledSpansByClass(records).get("src")!;
  assert.equal(fold.spansMs.length, 20, "a real failed run is a real sample");
  assert.equal(fold.excluded, 0);
  const [finding] = detectRunningLong(records, POLICY, NOW);
  assert.equal(finding!.runId, "HEALTHY", "its ~15-minute median flags the 45-minute run, as before");
  assert.equal(finding!.sampleSize, 20);
  assert.equal("excludedCount" in finding!, false, "no field when nothing was excluded");
  assert.equal("excluded_count" in runningLongLine(finding!), false, "the ledgered row is byte-for-byte unchanged");
  assert.doesNotMatch(String(runningLongIncidentEvent(finding!).message), /excluded/);
});

test("W1-T4709: the cost median excludes the same rows and reports the count", () => {
  const pricey = run("PRICEY", T0 + 900 * MIN, 30 * MIN, { verdict: "merged", cost_usd: 2.5 });
  const records = [...realRuns(), ...thrownRuns(), ...backfilledRuns(), ...pricey];
  const findings = pendingCostAnomalies(records, POLICY);
  assert.deepEqual(findings.map((f) => f.runId), ["PRICEY"], "a $0 phantom median would flag every $1 run");
  assert.equal(findings[0]!.medianCostUsd, 1);
  assert.equal(findings[0]!.sampleSize, 11);
  assert.equal(findings[0]!.excludedCount, 20);
  assert.equal(costAnomalyLine(findings[0]!).excluded_count, 20);
  assert.match(String(costAnomalyIncidentEvent(findings[0]!).message), /n=11, excluded=20\)/);

  const clean = pendingCostAnomalies([...realRuns(), ...pricey], POLICY);
  assert.equal("excludedCount" in clean[0]!, false);
  assert.equal("excluded_count" in costAnomalyLine(clean[0]!), false);
  assert.doesNotMatch(String(costAnomalyIncidentEvent(clean[0]!).message), /excluded/);
});
