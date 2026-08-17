// W1-T930: "the retro measures turns per run and calls it efficiency" — ClassCalibration
// carried `avgTurns` over ALL runs (a class with more refused runs reads CHEAPER, because
// a refusal is short and dilutes the mean) and no output-token column at all, even though
// output tokens are the dominant spend term (~5x input price) and were already captured on
// every worker ledger line (`workerLedgerFields`, src/lib/worker.ts) and simply never read
// back by any calibration aggregate. This file pins the four acceptance criteria in the
// task record (plan/tasks.d/W1-T930-turn-efficiency-per-merge.yaml) directly against
// `aggregateByClass`/`classCalibrationTable`/`buildGather` — the SAME class aggregate the
// existing per-run columns already come from (no second accounting path).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByClass,
  buildGather,
  classCalibrationTable,
  gatherRuns,
  MIN_TURN_COVERAGE_FOR_PER_MERGE,
  parseLedger,
  type ShippedRecord,
} from "../src/lib/retro.js";

// ── Fixture: the "docs" class — two merged runs + one refused run, WITH the
// nested `tokens: {output, ...}` shape workerLedgerFields actually writes on
// every recon.done/implement.done/implement.resumed line. Turn coverage is
// 100% (every run logged a nonzero num_turns), so nothing here is blacked out.
const DOCS_LEDGER = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"D1","task_id":"TD1","step":"run.start","type":"implement","task_class":"docs"}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"D1","task_id":"TD1","step":"implement.done","num_turns":10,"tokens":{"input":100,"output":1000,"cacheRead":0,"cacheCreation":0}}`,
  `{"ts":"2026-01-01T00:02:00.000Z","run_id":"D1","task_id":"TD1","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/501"}`,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"D2","task_id":"TD2","step":"run.start","type":"implement","task_class":"docs"}`,
  `{"ts":"2026-01-02T00:01:00.000Z","run_id":"D2","task_id":"TD2","step":"implement.done","num_turns":20,"tokens":{"input":200,"output":2000,"cacheRead":0,"cacheCreation":0}}`,
  `{"ts":"2026-01-02T00:02:00.000Z","run_id":"D2","task_id":"TD2","step":"verdict","verdict":"merged","cost_usd":2.0,"pr_url":"https://github.com/o/r/pull/502"}`,
  `{"ts":"2026-01-03T00:00:00.000Z","run_id":"D3","task_id":"TD3","step":"run.start","type":"implement","task_class":"docs"}`,
  `{"ts":"2026-01-03T00:01:00.000Z","run_id":"D3","task_id":"TD3","step":"implement.done","num_turns":5,"tokens":{"input":50,"output":500,"cacheRead":0,"cacheCreation":0}}`,
  `{"ts":"2026-01-03T00:02:00.000Z","run_id":"D3","task_id":"TD3","step":"verdict","verdict":"blocked_budget","cost_usd":0.5}`,
].join("\n");

// ── Fixture: "infra" class — one run, never merged (ledger OR shipped) — the
// genuine zero-merge case (division by zero must never be computed).
const INFRA_LEDGER = [
  `{"ts":"2026-01-04T00:00:00.000Z","run_id":"INFRA1","task_id":"TINFRA1","step":"run.start","type":"implement","task_class":"infra"}`,
  `{"ts":"2026-01-04T00:01:00.000Z","run_id":"INFRA1","task_id":"TINFRA1","step":"implement.done","num_turns":8,"tokens":{"output":800}}`,
  `{"ts":"2026-01-04T00:02:00.000Z","run_id":"INFRA1","task_id":"TINFRA1","step":"verdict","verdict":"blocked_review","cost_usd":0.8}`,
].join("\n");

// ── Fixture: "plan-lint" class — 4 runs, 3 merged, only ONE reports a nonzero
// num_turns (25% coverage, under MIN_TURN_COVERAGE_FOR_PER_MERGE) — the thin-
// coverage case: the figure must still be COMPUTED and printed, flagged, never
// suppressed (MASTER-PLAN's own "37 ⚠ 29% coverage — DO NOT USE" discipline).
const PLAN_LINT_LEDGER = [
  `{"ts":"2026-01-05T00:00:00.000Z","run_id":"P1","task_id":"TP1","step":"run.start","type":"implement","task_class":"plan-lint"}`,
  `{"ts":"2026-01-05T00:01:00.000Z","run_id":"P1","task_id":"TP1","step":"implement.done","num_turns":0,"tokens":{"output":0}}`,
  `{"ts":"2026-01-05T00:02:00.000Z","run_id":"P1","task_id":"TP1","step":"verdict","verdict":"merged","cost_usd":0.1,"pr_url":"https://github.com/o/r/pull/601"}`,
  `{"ts":"2026-01-06T00:00:00.000Z","run_id":"P2","task_id":"TP2","step":"run.start","type":"implement","task_class":"plan-lint"}`,
  `{"ts":"2026-01-06T00:01:00.000Z","run_id":"P2","task_id":"TP2","step":"implement.done","num_turns":0,"tokens":{"output":0}}`,
  `{"ts":"2026-01-06T00:02:00.000Z","run_id":"P2","task_id":"TP2","step":"verdict","verdict":"merged","cost_usd":0.1,"pr_url":"https://github.com/o/r/pull/602"}`,
  `{"ts":"2026-01-07T00:00:00.000Z","run_id":"P3","task_id":"TP3","step":"run.start","type":"implement","task_class":"plan-lint"}`,
  `{"ts":"2026-01-07T00:01:00.000Z","run_id":"P3","task_id":"TP3","step":"implement.done","num_turns":40,"tokens":{"output":4000}}`,
  `{"ts":"2026-01-07T00:02:00.000Z","run_id":"P3","task_id":"TP3","step":"verdict","verdict":"merged","cost_usd":0.1,"pr_url":"https://github.com/o/r/pull/603"}`,
  `{"ts":"2026-01-08T00:00:00.000Z","run_id":"P4","task_id":"TP4","step":"run.start","type":"implement","task_class":"plan-lint"}`,
  `{"ts":"2026-01-08T00:01:00.000Z","run_id":"P4","task_id":"TP4","step":"implement.done","num_turns":0,"tokens":{"output":0}}`,
  `{"ts":"2026-01-08T00:02:00.000Z","run_id":"P4","task_id":"TP4","step":"verdict","verdict":"blocked_budget","cost_usd":0.1}`,
].join("\n");

const ALL_LEDGER = [DOCS_LEDGER, INFRA_LEDGER, PLAN_LINT_LEDGER].join("\n");

// ── Acceptance (1): output tokens and turns per MERGED PR, per class, ALONGSIDE
// the existing per-run figures — never replacing avgTurns/merged/mergeRate. ──

test("gatherRuns reads TokenUsage.output off DONE_STEPS lines into RunSummary.outputTokens", () => {
  const runs = gatherRuns(parseLedger(DOCS_LEDGER));
  const d1 = runs.find((r) => r.runId === "D1")!;
  assert.equal(d1.outputTokens, 1000);
  const d2 = runs.find((r) => r.runId === "D2")!;
  assert.equal(d2.outputTokens, 2000);
});

test("gatherRuns tolerates a ledger line with no tokens field (predates token ledgering) — 0, never a throw", () => {
  const noTokens = `{"ts":"2026-01-01T00:00:00.000Z","run_id":"X","task_id":"TX","step":"run.start","type":"implement"}\n{"ts":"2026-01-01T00:01:00.000Z","run_id":"X","task_id":"TX","step":"implement.done","num_turns":3}`;
  const runs = gatherRuns(parseLedger(noTokens));
  assert.equal(runs[0].outputTokens, 0);
});

test("aggregateByClass: turnsPerMerge/outputTokensPerMerge sit ALONGSIDE avgTurns/merged/mergeRate — never replace them", () => {
  const runs = gatherRuns(parseLedger(DOCS_LEDGER));
  const [docs] = aggregateByClass(runs);
  // the per-run figures, unchanged, still present:
  assert.equal(docs.runs, 3);
  assert.equal(docs.merged, 2);
  assert.equal(docs.mergeRate, 0.667); // round(2/3) -- untouched, still ledger-verdict/RUN count
  assert.equal(docs.avgTurns, 11.667); // round((10+20+5)/3)
  assert.equal(docs.totalCostUsd, 3.5);
  // the NEW per-merge figures, alongside them (ledger denominator: 2 merges):
  assert.equal(docs.totalOutputTokens, 3500);
  assert.equal(docs.mergedForDenominator, 2);
  assert.equal(docs.turnsPerMerge, 17.5); // (10+20+5)/2 -- ALL turns, incl. the refused run
  assert.equal(docs.outputTokensPerMerge, 1750); // (1000+2000+500)/2
  // gaming resistance: turns-per-MERGE (17.5) is HIGHER than turns-per-RUN
  // (avgTurns, 11.667) precisely because the refused run's turns still count
  // toward the numerator but not the denominator -- the defect this task fixes.
  assert.ok(docs.turnsPerMerge! > docs.avgTurns);
});

test("classCalibrationTable renders output tokens and turns/output-tokens per merge beside the existing columns", () => {
  const table = classCalibrationTable(aggregateByClass(gatherRuns(parseLedger(DOCS_LEDGER))));
  assert.match(table, /task_class \| runs \| merged \| merge rate \| avg \$ \| avg turns \| total \$ \| output tokens \| merge source \| turns\/merge \| output tokens\/merge/);
  // existing per-run prefix is untouched:
  assert.match(table, /\| docs \| 3 \| 2 \| 67% \| \$1\.167 \| 11\.667 \| \$3\.500 \|/);
  // the new per-merge figures appear in the SAME row:
  assert.match(table, /\| 3500 \| ledger \(n=2\) \| 17\.5 \| 1750 \|/);
});

// ── Acceptance (2): the row NAMES which merge denominator produced it, and a
// row that cannot name its merge source is never emitted. ──

test("aggregateByClass names mergeSource=ledger when no shipped union is supplied (the historic, undercounting path)", () => {
  const runs = gatherRuns(parseLedger(DOCS_LEDGER));
  const [docs] = aggregateByClass(runs);
  assert.equal(docs.mergeSource, "ledger");
  assert.equal(docs.mergedForDenominator, docs.merged);
});

test("aggregateByClass names mergeSource=shipped and re-derives the denominator via the W1-T51 union when it IS supplied -- closing the ledger-verdict undercount", () => {
  const runs = gatherRuns(parseLedger(DOCS_LEDGER));
  // D3 ended blocked_budget in the ledger but the SHIPPED union credits it too
  // (a gate-side merge discovered via the Remudero-Task trailer) -- exactly the
  // "77-point method gap" the task's rationale names: ledger says 2 merged,
  // the real ship count for this class is 3.
  const shipped: ShippedRecord[] = [
    { taskId: "TD1", runId: "D1", prUrl: "https://github.com/o/r/pull/501", costUsd: 1.0, numTurns: 10, source: "ledger" },
    { taskId: "TD2", runId: "D2", prUrl: "https://github.com/o/r/pull/502", costUsd: 2.0, numTurns: 20, source: "ledger" },
    {
      taskId: "TD3",
      runId: "D3",
      prUrl: "https://github.com/o/r/pull/503",
      costUsd: 0.5,
      numTurns: 5,
      source: "github",
      annotation: "gate-side merge; run ended blocked_budget",
    },
  ];
  const [docs] = aggregateByClass(runs, shipped);
  assert.equal(docs.mergeSource, "shipped");
  assert.equal(docs.mergedForDenominator, 3); // NOT 2 -- the ledger-only count `merged` still is
  assert.equal(docs.merged, 2); // the OLD field is untouched -- still ledger-verdict-only
  assert.equal(docs.turnsPerMerge, 11.667); // round(35/3), a DIFFERENT figure than the ledger denominator gave (17.5)
  const table = classCalibrationTable([docs]);
  assert.match(table, /shipped \(n=3\)/);
});

test("buildGather always wires its own computed `shipped` union into aggregateByClass -- production rows are never left naming the weaker ledger-only denominator by omission", () => {
  const g = buildGather({ ledgerNdjson: DOCS_LEDGER, learningsMd: "# L\n" });
  const docs = g.byClass.find((c) => c.taskClass === "docs")!;
  assert.equal(docs.mergeSource, "shipped");
  assert.match(classCalibrationTable(g.byClass), /ledger \(n=2\)|shipped \(n=\d+\)/); // always named, never blank
});

// ── Acceptance (3): thin turn coverage OR zero merges is flagged with its
// coverage fraction -- never a divide-by-zero, never a bare/unflagged number. ──

test("MIN_TURN_COVERAGE_FOR_PER_MERGE is the documented, testable threshold (0.5) -- not a magic number re-derived per call site", () => {
  assert.equal(MIN_TURN_COVERAGE_FOR_PER_MERGE, 0.5);
});

test("a class with ZERO merges in the window: turnsPerMerge/outputTokensPerMerge are null (never NaN/Infinity from a division by zero)", () => {
  const runs = gatherRuns(parseLedger(INFRA_LEDGER));
  const [infra] = aggregateByClass(runs);
  assert.equal(infra.mergedForDenominator, 0);
  assert.equal(infra.turnsPerMerge, null);
  assert.equal(infra.outputTokensPerMerge, null);
  const table = classCalibrationTable([infra]);
  assert.match(table, /\| infra \|.*\| n\/a \(0 merges\) \| n\/a \(0 merges\) \|/);
  assert.doesNotMatch(table, /NaN|Infinity/);
});

test("a class with THIN turn coverage (below 50%): the figure is still COMPUTED and printed WITH its coverage fraction -- never suppressed, laundered, or left bare", () => {
  const runs = gatherRuns(parseLedger(PLAN_LINT_LEDGER));
  const [planLint] = aggregateByClass(runs);
  assert.equal(planLint.turnCoverage, 0.25); // 1 of 4 runs reports nonzero turns
  assert.ok(planLint.turnCoverage < MIN_TURN_COVERAGE_FOR_PER_MERGE);
  // the number itself is STILL the real computed figure -- never null'd or zeroed
  // out just because coverage is thin (only a truly-zero denominator does that):
  assert.equal(planLint.mergedForDenominator, 3);
  assert.equal(planLint.turnsPerMerge, 13.333); // round(40/3) -- the raw figure, unmodified
  const table = classCalibrationTable([planLint]);
  // MASTER-PLAN's own discipline, reused verbatim: the number is printed AND flagged.
  assert.match(table, /13\.333 ⚠ 25% coverage — DO NOT USE/);
});

// ── Acceptance (4): the per-merge figures come off the EXISTING class
// aggregate (aggregateByClass), never a second accounting path. ──

test("turnsPerMerge/outputTokensPerMerge are fields on the SAME ClassCalibration aggregateByClass has always produced -- not a parallel structure", () => {
  const runs = gatherRuns(parseLedger(ALL_LEDGER));
  const byClass = aggregateByClass(runs);
  for (const c of byClass) {
    assert.ok("turnsPerMerge" in c, `${c.taskClass} row is missing turnsPerMerge`);
    assert.ok("outputTokensPerMerge" in c, `${c.taskClass} row is missing outputTokensPerMerge`);
    // every per-merge row still carries every pre-existing per-run field too:
    assert.ok("avgTurns" in c && "merged" in c && "mergeRate" in c && "totalCostUsd" in c);
  }
});
