/**
 * W1-T13203: serve's request loop was blocked for 14.8 minutes on 2026-11-16 and the loop-lag invariant never named
 * it: runtime.loop_lag at 14:39:37Z had p99Ms 108.6 and maxMs 887,447.6, and the rule read only p99Ms.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateIncidentInvariants, INCIDENT_INPUT_LINE, LOOP_LAG_MAX_STALL_BOUND_MS, LOOP_LAG_P99_BOUND_MS,
  LOOP_LAG_RULE_ID } from "#src/lib/incident-invariants.js";

const NOW = Date.parse("2026-11-16T14:45:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const lag = (minutesAgo: number, p99Ms: number, maxMs: number) =>
  ({ ts: at(minutesAgo), run_id: `RUNTIME-${NOW - minutesAgo * 60_000}`, task_id: "INCIDENT", step: "runtime.loop_lag", p50Ms: 20, p99Ms, maxMs, windowMs: 60_000 });
const loopLag = (rows: Array<Record<string, unknown>>) => evaluateIncidentInvariants(rows, NOW).find((finding) => finding.ruleId === LOOP_LAG_RULE_ID);

test("W1-T13203 criterion 1: one stall over the max bound is bad even with p99 at 108 ms, and the message names it", () => {
  const rows = [lag(10, 108.6, 200), lag(5, 108.6, 300), lag(0.5, 108.6, 887_447.6)];
  const finding = loopLag(rows);
  assert.ok(finding, "the loop-lag rule fires on the one long stall");
  assert.match(finding.message, /p99=108\.6ms/);
  assert.match(finding.message, new RegExp(`max=887447\\.6ms, bound=${LOOP_LAG_MAX_STALL_BOUND_MS}ms`));
});

test("W1-T13203 criterion 2: the message names up to three top frames from the profile on the long row's run", () => {
  const long = lag(0.5, 108.6, 887_447.6);
  const profile = { ts: long.ts, run_id: long.run_id, task_id: "INCIDENT", step: "runtime.loop_stall_profile", lag_ms: 887_447,
    top_inclusive: [
      { function: "classifyAllProposals", url: "file:///home/node/rmd/src/lib/panel-graph.ts", total_ms: 880_000 },
      { function: "loadPlan", url: "file:///home/node/rmd/src/lib/plan.ts", total_ms: 4_000 },
      { function: "readJson", url: "file:///home/node/rmd/src/lib/fs.ts", total_ms: 1_000 },
      { function: "fourth", url: "file:///x/y.ts", total_ms: 10 },
    ] };
  const other = { ...profile, run_id: "RUNTIME-1", top_inclusive: [{ function: "wrong", url: "file:///w.ts" }] };
  const finding = loopLag([lag(10, 108.6, 200), other, long, profile]);
  assert.ok(finding);
  assert.match(finding.message, /top: classifyAllProposals \(panel-graph\.ts\), loadPlan \(plan\.ts\), readJson \(fs\.ts\)$/);
  assert.doesNotMatch(finding.message, /wrong|fourth/);
  assert.ok(INCIDENT_INPUT_LINE.test(JSON.stringify(profile)), "serve's tail keeps the profile rows the rule now reads");
  assert.doesNotMatch(loopLag([lag(10, 108.6, 200), long])!.message, /top:/, "no profile row: no top text");
});

test("W1-T13203 criterion 3: invariant:p99-path-unchanged — a p99 breach under the max bound reads as before", () => {
  const p99 = loopLag([lag(10, LOOP_LAG_P99_BOUND_MS + 100, 2_000), lag(0.5, LOOP_LAG_P99_BOUND_MS + 100, 2_000)]);
  assert.ok(p99);
  assert.equal(p99.message, `p99=${LOOP_LAG_P99_BOUND_MS + 100}ms over 2 sample(s), bound=${LOOP_LAG_P99_BOUND_MS}ms`);
  assert.equal(loopLag([lag(10, 100, 2_000), lag(0.5, 100, LOOP_LAG_MAX_STALL_BOUND_MS)]), undefined, "under both bounds is not bad");
});
