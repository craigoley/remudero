import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
import { openLedgerUnion, type OpenLedgerUnionOptions } from "#src/lib/ledger-union.js";

const reviewModule = "#scripts/private-routing-daily-review.mjs";
const { dailyRoutingReview } = await import(reviewModule);

const asOf = "2026-10-02T14:00:00.000Z";
const ts = "2026-10-02T10:00:00.000Z";
const epoch = ROUTING_EXPERIMENTS.find(item => item.id === "sol61-vs-sonnet55")!;
const assignment = { ts, step: "worker.assignment", task_id: "W1-T1", worker_assignment: {
  id: "a-1", selected: { provider: "codex" }, routing: { decision: { ab: epoch.id,
    considered: [{ provider: "claude", model: "claude-sonnet-5-5" }] },
    experiment: { assignedArm: "sol61", crossover: false } } } };
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

async function review(rows: unknown[], check: (source: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bounded-review-"));
  try {
    const stateDir = join(dir, "state"); mkdirSync(stateDir);
    writeFileSync(join(stateDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(encode([assignment])));
    writeFileSync(join(stateDir, "ledger.ndjson"), encode(rows));
    let unionDedupe: boolean | undefined;
    const result = await dailyRoutingReview({ sources: [{ label: "core", stateDir }], outDir: join(dir, "out"), asOf,
      openUnion: (path: string, options: OpenLedgerUnionOptions) => {
        unionDedupe = options.dedupe;
        return openLedgerUnion(path, options);
      } });
    assert.equal(unionDedupe, false, "the union must not retain unrelated lines in its replay Set");
    check(result.snapshot.sources[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("W1-T10830: the routing review dedupes only the rows its reports read", async () => {
  const noise = Array.from({ length: 10_000 }, (_, n) => ({ ts, step: "unrelated", n }));
  await review([...noise, assignment, null, { ts: "invalid", step: "unrelated" },
    { ts: "2026-11-01T00:00:00Z", step: "unrelated" }], source => {
    assert.equal(source.dedupeRows, 1);
    assert.equal(source.retainedRows, 1);
    assert.equal(source.rowsRead, 10_001);
    assert.equal(source.invalidTimestampRows, 1);
    assert.equal(source.futureRows, 1);
    assert.equal(source.malformedRows, 1);
    assert.equal(source.findings.length, 3);
    assert.equal(source.newestTs, ts);
    assert.equal(source.reports.find((report: any) => report.id === epoch.id).assignments, 1);
  });
});

test("W1-T10830: assignment-stamped activity rows do not fill the retained set", async () => {
  const noise = Array.from({ length: 100_001 }, (_, n) => ({ ts, step: n % 2 ? "worker.activity" : "inbox.draft_synthesized",
    selection_assignment_id: "a-1", n }));
  await review([...noise, { ts, step: "worker.attempt", selection_assignment_id: "a-1", success: true,
    served_model: "gpt-6.1-sol", total_cost_usd: 0.2 }, { ts, step: "verdict", selection_assignment_id: "a-1", success: true },
    { ts, step: "worker.done", selection_assignment_id: "a-1", success: true }], source => {
    assert.equal(source.state, "observed");
    assert.equal(source.retainedRowsOmitted, 0);
    assert.equal(source.retainedRows, 4);
    assert.equal(source.dedupeRows, 4);
    const report = source.reports.find((report: any) => report.id === epoch.id);
    assert.equal(report.assignments, 1);
    assert.equal(report.arms.find((arm: any) => arm.arm === "sol61").receiptCoverage.servedModelKnownAssignments, 1);
  });
});
