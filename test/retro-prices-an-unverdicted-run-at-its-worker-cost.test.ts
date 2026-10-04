// W1-T5526: a run with no verdict line (a `verdict.merged` credit can still settle it) is priced at
// its worker's own DONE_STEPS rows. On the live ledger its FIRST `cost_usd` row was a probe on 141 of
// 143 such settled runs, and `gatherRuns` used to price the whole run at that probe's cost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherRuns, type LedgerRecord } from "../src/lib/retro.js";

const RUN = "W1-T9001-1786606793018";
const PR = "https://github.com/craigoley/remudero/pull/9001";

function row(step: string, extra: Record<string, unknown> = {}): LedgerRecord {
  return { ts: "2026-08-13T07:40:16.398Z", run_id: RUN, task_id: "W1-T9001", step, ...extra } as LedgerRecord;
}

/** The live settled shape: start, two probes, recon, implement, PR, then a sweep's credit row. */
function settledRun(beforeWorker: LedgerRecord[] = [], afterWorker: LedgerRecord[] = []): LedgerRecord[] {
  return [
    row("run.start", { type: "implement", risk: "low" }),
    row("containment.probe", { contained: true, cost_usd: 0.07 }),
    row("isolation.probe", { isolated: true, cost_usd: 0.08 }),
    ...beforeWorker,
    row("recon.done", { cost_usd: 0.41, num_turns: 6 }),
    row("implement.done", { cost_usd: 2.5, num_turns: 40 }),
    ...afterWorker,
    row("pr.opened", { pr_url: PR }),
    { ts: "2026-08-13T11:00:00.000Z", run_id: "sweep-1", step: "verdict.merged", pr_url: PR } as LedgerRecord,
  ];
}

function onlyRun(records: LedgerRecord[]) {
  const runs = gatherRuns(records).filter((r) => r.runId === RUN);
  assert.equal(runs.length, 1);
  return runs[0];
}

test("a settled run with no verdict line is priced at its recon and implement rows, not its first probe", () => {
  const run = onlyRun(settledRun());
  assert.equal(run.verdict, "merged");
  assert.equal(run.verdictSource, "ledger-credit");
  assert.equal(run.costUsd, 0.41 + 2.5);
  assert.notEqual(run.costUsd, 0.07, "priced at the containment.probe row");
  assert.equal(run.costSource, undefined);
});

for (const step of ["cost.anomaly", "risk_judge.decision", "budget.warning"]) {
  test(`a ${step} row ahead of the worker never sets an unverdicted run's cost`, () => {
    const run = onlyRun(settledRun([row(step, { cost_usd: 99 })], [row(step, { cost_usd: 77 })]));
    assert.equal(run.costUsd, 0.41 + 2.5);
  });
}

test("a worker row carrying only total_cost_usd is priced from it", () => {
  const records = settledRun().map((r) =>
    r.step === "implement.done" ? ({ ...r, cost_usd: undefined, total_cost_usd: 3 } as LedgerRecord) : r,
  );
  assert.equal(onlyRun(records).costUsd, 0.41 + 3);
});

test("an implement.resumed row adds its cost to the unverdicted run", () => {
  const run = onlyRun(settledRun([], [row("implement.resumed", { cost_usd: 1 })]));
  assert.equal(run.costUsd, 0.41 + 2.5 + 1);
});

test("a run with no worker cost row and no verdict line is marked costSource none, not read as free", () => {
  const run = onlyRun([
    row("run.start", { type: "implement" }),
    row("containment.probe", { cost_usd: 0.07 }),
    row("isolation.probe", { cost_usd: 0.08 }),
    row("cost.anomaly", { cost_usd: 5 }),
  ]);
  assert.equal(run.costUsd, 0);
  assert.equal(run.costSource, "none");
});

test("a run with a verdict line keeps the verdict line's cost and carries no costSource marker", () => {
  const priced = onlyRun([...settledRun(), row("verdict", { verdict: "merged", cost_usd: 4.2, pr_url: PR })]);
  assert.equal(priced.costUsd, 4.2);
  assert.equal(priced.costSource, undefined);
  const unpriced = onlyRun([row("run.start", { type: "implement" }), row("verdict", { verdict: "failed" })]);
  assert.equal(unpriced.costUsd, 0);
  assert.equal(unpriced.costSource, undefined);
});
