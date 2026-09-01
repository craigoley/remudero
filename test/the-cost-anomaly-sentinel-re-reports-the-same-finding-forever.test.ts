import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  alreadyLedgeredCostAnomalyRunIds,
  COST_ANOMALY_STEP,
  costAnomalyLine,
  detectCostAnomalies,
  pendingCostAnomalies,
  recordCostAnomalies,
  type CostAnomalyDeps,
  type CostAnomalyPolicy,
} from "../src/lib/cost-anomaly.js";
import { appendLedger, DECISION_RELEVANT_LEDGER_STEPS, rotateLedger } from "../src/lib/ledger.js";
import { gatherRuns, parseLedger } from "../src/lib/retro.js";

// ── W1-T2558 — "THE COST-ANOMALY SENTINEL RE-REPORTS EVERY FINDING ON EVERY SWEEP, FOREVER"
// (plan/tasks.d/W1-T2558-...). MEASURED 2026-09-01: 471 raw `cost.anomaly` rows collapsing to 45
// distinct run ids, one run (W1-T2324-1787823430981) carrying 26 identical re-flags at $25.68, and
// the same five runs recurring at 06:25:46Z/09:29:16Z/10:18:04Z with nothing changing but
// `median_cost_usd` (5.03 -> 5.10 -> 5.07).
//
// ROOT CAUSE, TRACED HERE (not just asserted): `pendingCostAnomalies`/`alreadyLedgeredCostAnomalyRunIds`
// (src/lib/cost-anomaly.ts) already dedup correctly BY RUN ID off whatever ledger they are handed —
// see test/cost-anomaly.test.ts's own "TWO sequential passes ... never two" test, which passes
// today. What breaks the dedup in production is one level down, in `src/lib/ledger.ts`'s rotation:
// `rotateLedger`'s PASS 1 classifies every ledger line as either decision-relevant (survives,
// bounded to MAX_RETAINED_LINES_PER_STEP), health/render (survives a recency window), or NOISE
// (archived away, gone from the live file `readLedgerLines`/`recordCostAnomalies` ever reads
// again). `cost.anomaly` was in none of those three sets, so PASS 1 treated the sentinel's OWN
// idempotence marker as disposable noise — a rotation silently un-flags every already-reported
// run, and the very next sweep re-derives and re-appends the identical finding. This file's fix is
// registering `"cost.anomaly"` in `DECISION_RELEVANT_LEDGER_STEPS` (src/lib/ledger.ts), the exact
// remedy this codebase already applies to the same defect class for `review.unwired_advisory`
// (W1-T1017), `sweep.absent_repush`, and `coverage.improvement.filed` — "the line IS the dedup key;
// it must survive rotation."

function ledgerTmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "cost-anomaly-forever-ledger-")), "ledger.ndjson");
}

/** One settled run's `run.start` + `verdict` ndjson lines — same shape as test/cost-anomaly.test.ts's own helper. */
function runLines(opts: { runId: string; taskId: string; taskClass: string; costUsd: number; ts: string }): string {
  const start = JSON.stringify({ ts: opts.ts, run_id: opts.runId, task_id: opts.taskId, step: "run.start", type: "implement", task_class: opts.taskClass });
  const verdict = JSON.stringify({ ts: opts.ts, run_id: opts.runId, task_id: opts.taskId, step: "verdict", verdict: "merged", cost_usd: opts.costUsd });
  return `${start}\n${verdict}`;
}

function noiseLine(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

const POLICY: CostAnomalyPolicy = { multiplier: 3, minSamples: 5 };

const BASE_CLASS = [
  runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-27T09:00:00.000Z" }),
  runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-27T09:10:00.000Z" }),
  runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-27T09:20:00.000Z" }),
  runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-27T09:30:00.000Z" }),
];

// ── ACCEPTANCE: "one anomalous run is reported once, not once per sweep" + "a second sweep over
// unchanged data appends no new row for a run already reported" ───────────────────────────────

test("recordCostAnomalies: an anomalous run ledgers exactly one row across TWO sequential sweeps over the unchanged ledger, never two", () => {
  const path = ledgerTmpPath();
  const lines = [...BASE_CLASS, runLines({ runId: "W1-T2324", taskId: "W1-T2324", taskClass: "src", costUsd: 25.68, ts: "2026-08-27T09:37:41.000Z" })].join("\n");
  writeFileSync(path, `${lines}\n`);

  const pass1 = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  assert.equal(pass1.length, 1);
  assert.equal(pass1[0].runId, "W1-T2324");

  // A SECOND sweep, reading the SAME file back off disk (exactly what runSweep does every tick) —
  // over data that has not changed at all, this must append nothing new.
  const pass2 = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  assert.deepEqual(pass2, [], "a second sweep over unchanged data must find nothing pending");

  const rows = parseLedger(readFileSync(path, "utf8")).filter((r) => r.step === COST_ANOMALY_STEP);
  assert.equal(rows.length, 1, "exactly one row for the run — never 26 identical rows for the same $25.68 finding");
});

// ── THE MEASURED PRODUCTION DEFECT, REPRODUCED DIRECTLY: a ledger rotation between two sweeps
// must not resurrect an already-reported finding. Before this task's fix (cost.anomaly absent
// from DECISION_RELEVANT_LEDGER_STEPS), `rotateLedger` archived the sentinel's own dedup marker
// as noise and the second sweep below re-appended a duplicate — this is the FALSIFIER: reverting
// ledger.ts's registration (or reverting to appending detectCostAnomalies's output unconditionally,
// the pre-fix shape) makes this exact assertion fail. ───────────────────────────────────────────

test("recordCostAnomalies: a finding survives a ledger rotation between sweeps — the measured 06:25/09:29/10:18 re-flag never happens again", () => {
  const path = ledgerTmpPath();
  const lines = [...BASE_CLASS, runLines({ runId: "W1-T2324", taskId: "W1-T2324", taskClass: "src", costUsd: 25.68, ts: "2026-08-27T09:37:41.000Z" })].join("\n");
  writeFileSync(path, `${lines}\n`);

  const pass1 = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  assert.equal(pass1.length, 1);

  // Pad the ledger with realistic high-frequency noise (ci.polling — the exact kind of traffic
  // that drives real rotations) and force rotateLedger's ceiling.
  for (let n = 0; n < 200; n++) {
    appendLedger(path, { run_id: `noise-${n}`, task_id: "W1-NOISE", step: "ci.polling", detail: "x".repeat(64) } as never);
  }
  const rotated = rotateLedger(path, { ceilingBytes: 2000 });
  assert.equal(rotated.rotated, true, "test setup sanity: a real rotation must actually have fired");

  const afterRotation = parseLedger(readFileSync(path, "utf8"));
  assert.equal(
    afterRotation.filter((r) => r.step === COST_ANOMALY_STEP).length,
    1,
    "the cost.anomaly row must survive rotation into the live view, exactly like review.unwired_advisory/sweep.absent_repush do",
  );

  // The next sweep tick, hours later, over the post-rotation ledger — this is precisely the
  // 09:29:16Z/10:18:04Z re-check the task's own rationale measures.
  const pass2 = recordCostAnomalies(afterRotation, POLICY, { ledgerPath: path });
  assert.deepEqual(pass2, [], "a rotation must never re-open an already-reported finding");

  const finalRows = parseLedger(readFileSync(path, "utf8")).filter((r) => r.step === COST_ANOMALY_STEP);
  assert.equal(finalRows.length, 1, "still exactly one row after the rotation + second sweep, not a duplicate");
});

test("DECISION_RELEVANT_LEDGER_STEPS registers cost.anomaly, so a rotation cannot archive the sentinel's own dedup marker", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(COST_ANOMALY_STEP),
    "cost.anomaly must be pinned — it is pendingCostAnomalies's own idempotence marker, read back off the live ledger",
  );
});

// ── FALSIFIER, at the cost-anomaly.ts layer: ledgering `detectCostAnomalies`'s output directly —
// the pre-W1-931-dedup, "append a row per anomalous run per pass" shape the task describes — DOES
// re-report the identical finding on every pass. `recordCostAnomalies`'s own `pendingCostAnomalies`
// gate is what stands between this codebase and exactly that. ─────────────────────────────────

test("FALSIFIER: appending detectCostAnomalies's output unconditionally (bypassing pendingCostAnomalies) re-reports the same finding every pass", () => {
  const path = ledgerTmpPath();
  const lines = [...BASE_CLASS, runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" })].join("\n");
  writeFileSync(path, `${lines}\n`);

  for (let pass = 0; pass < 3; pass++) {
    const findings = detectCostAnomalies(gatherRuns(parseLedger(readFileSync(path, "utf8")) as never), POLICY);
    for (const f of findings) appendLedger(path, costAnomalyLine(f) as never);
  }

  const rows = parseLedger(readFileSync(path, "utf8")).filter((r) => r.step === COST_ANOMALY_STEP && r.run_id === "W1-T7");
  assert.equal(rows.length, 3, "the unconditional-append shape re-reports the SAME run once per pass — exactly the measured bug");

  // The real, fixed pipeline over the SAME starting ledger never does this.
  const fixedPath = ledgerTmpPath();
  writeFileSync(fixedPath, `${lines}\n`);
  for (let pass = 0; pass < 3; pass++) {
    recordCostAnomalies(parseLedger(readFileSync(fixedPath, "utf8")), POLICY, { ledgerPath: fixedPath });
  }
  const fixedRows = parseLedger(readFileSync(fixedPath, "utf8")).filter((r) => r.step === COST_ANOMALY_STEP && r.run_id === "W1-T7");
  assert.equal(fixedRows.length, 1, "recordCostAnomalies's dedup collapses the same three passes to one row");
});

// ── ACCEPTANCE: "a finding whose cost genuinely changed IS reported again — suppression never
// swallows a real change". Suppression is keyed on the exact RUN id, never the task id or class —
// a genuinely different run (a re-dispatch of the same task, landing a different cost) is a fresh
// run id, and must be reported on its own, never swallowed because an earlier run of the same task
// was already flagged. ─────────────────────────────────────────────────────────────────────────

test("pendingCostAnomalies: a re-run of the SAME task at a genuinely different cost is reported even though an earlier run of that task already carries a cost.anomaly row", () => {
  const firstRun = runLines({ runId: "W1-T500-run1", taskId: "W1-T500", taskClass: "src", costUsd: 12, ts: "2026-08-20T00:00:00.000Z" });
  const secondRun = runLines({ runId: "W1-T500-run2", taskId: "W1-T500", taskClass: "src", costUsd: 30, ts: "2026-08-25T00:00:00.000Z" });

  const beforeSecondRun = parseLedger([...BASE_CLASS, firstRun].join("\n"));
  const firstPending = pendingCostAnomalies(beforeSecondRun, POLICY);
  assert.equal(firstPending.length, 1);
  assert.equal(firstPending[0].runId, "W1-T500-run1");

  const ledgeredFirst = [
    ...BASE_CLASS,
    firstRun,
    JSON.stringify({ ts: "2026-08-20T00:00:01.000Z", ...costAnomalyLine(firstPending[0]) }),
    secondRun,
  ].join("\n");
  const afterSecondRun = parseLedger(ledgeredFirst);

  const second = pendingCostAnomalies(afterSecondRun, POLICY);
  assert.equal(second.length, 1, "the second run's own, genuinely different cost must still surface — same task, different run, different finding");
  assert.equal(second[0].runId, "W1-T500-run2");
  assert.equal(second[0].costUsd, 30);
  assert.notEqual(second[0].costUsd, firstPending[0].costUsd, "sanity: the two runs really do carry different costs");
});

// ── ACCEPTANCE: "a run that stops being anomalous stops being reported, and is not resurrected by
// a later sweep" ───────────────────────────────────────────────────────────────────────────────

test("pendingCostAnomalies: a run that no longer exceeds its class median once already ledgered is never resurrected by a later sweep", () => {
  const outlier = runLines({ runId: "W1-T600", taskId: "W1-T600", taskClass: "growing", costUsd: 10, ts: "2026-08-01T00:00:00.000Z" });
  const thinClass = [
    runLines({ runId: "G1", taskId: "G1", taskClass: "growing", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "G2", taskId: "G2", taskClass: "growing", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "G3", taskId: "G3", taskClass: "growing", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "G4", taskId: "G4", taskClass: "growing", costUsd: 1, ts: "2026-08-01T04:00:00.000Z" }),
  ];
  const originalLedger = parseLedger([outlier, ...thinClass].join("\n"));
  const firstPending = pendingCostAnomalies(originalLedger, POLICY);
  assert.equal(firstPending.length, 1);
  assert.equal(firstPending[0].runId, "W1-T600");

  const ledgeredLine = JSON.stringify({ ts: "2026-08-01T04:00:01.000Z", ...costAnomalyLine(firstPending[0]) });

  // The class grows: many more ordinary-cost runs land, pulling the median up until W1-T600's
  // $10 no longer clears `median * multiplier` — it has genuinely stopped being anomalous.
  const grownClassRuns = Array.from({ length: 10 }, (_, i) =>
    runLines({ runId: `G-new-${i}`, taskId: `G-new-${i}`, taskClass: "growing", costUsd: 5, ts: `2026-08-02T0${i}:00:00.000Z` }),
  );
  const grownLedger = parseLedger([outlier, ...thinClass, ledgeredLine, ...grownClassRuns].join("\n"));

  // Sanity: detectCostAnomalies itself, ignoring the ledger dedup entirely, now finds NOTHING for
  // this run — proving the class genuinely moved, not that dedup is merely hiding it.
  const recomputed = detectCostAnomalies(gatherRuns(grownLedger as never), POLICY);
  assert.ok(!recomputed.some((f) => f.runId === "W1-T600"), "sanity: the run truly stopped clearing the threshold");

  const secondPending = pendingCostAnomalies(grownLedger, POLICY);
  assert.deepEqual(secondPending, [], "no longer anomalous -> nothing new pending");

  // A LATER sweep still sees the run's OWN historical row untouched, never re-derived or removed —
  // "not resurrected" means the ledger keeps exactly the one row it always had, forever.
  const stillLedgered = alreadyLedgeredCostAnomalyRunIds(grownLedger);
  assert.ok(stillLedgered.has("W1-T600"));
  const rows = grownLedger.filter((r) => r.step === COST_ANOMALY_STEP && r.run_id === "W1-T600");
  assert.equal(rows.length, 1, "the one historical row for this run is neither duplicated nor deleted");
});

// ── ACCEPTANCE: "the full flagged set stays recoverable — this dedupes reporting, never deletes
// history" ─────────────────────────────────────────────────────────────────────────────────────

test("recordCostAnomalies: dedup never rewrites or deletes an existing cost.anomaly row — only appends", () => {
  const path = ledgerTmpPath();
  const lines = [...BASE_CLASS, runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" })].join("\n");
  writeFileSync(path, `${lines}\n`);

  recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  const afterFirst = readFileSync(path, "utf8");

  recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  const afterSecond = readFileSync(path, "utf8");

  assert.equal(afterSecond, afterFirst, "a no-op sweep must not touch a single existing byte of the ledger");
  assert.ok(afterFirst.includes(COST_ANOMALY_STEP), "the original finding is still present — recoverable, never deleted");
});

// ── ACCEPTANCE: "the module still only reports: no dispatch is deferred, no worker stopped, no
// merge blocked" — this task's fix must not widen the sentinel's own effect surface. ───────────

test("CostAnomalyDeps still carries nothing but a ledger sink — this task's fix adds no dispatch/merge/kill hook", () => {
  const deps: CostAnomalyDeps = { ledgerPath: ledgerTmpPath(), writeLedger: () => {} };
  assert.deepEqual(Object.keys(deps).sort(), ["ledgerPath", "writeLedger"]);
});

test("recordCostAnomalies: its only observable effect is ledger appends — the return value names exactly the newly-pending findings, nothing else", () => {
  const path = ledgerTmpPath();
  const lines = [...BASE_CLASS, runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" })].join("\n");
  writeFileSync(path, `${lines}\n`);

  let writeCalls = 0;
  const written = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, {
    ledgerPath: path,
    writeLedger: (p, line) => {
      writeCalls++;
      appendLedger(p, line as never);
    },
  });
  assert.equal(writeCalls, 1);
  assert.equal(written.length, 1);
});
