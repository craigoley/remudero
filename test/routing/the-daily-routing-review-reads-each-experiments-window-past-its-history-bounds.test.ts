/**
 * W1-T14473: the daily routing review's audit read sent the whole ledger history through the exact-dedupe index.
 * One row over the index's row bound ended the read, and a long history filled the index's disk bound, so the
 * review kept no window rows and reported every experiment at zero tasks. Rows before the earliest experiment now
 * stay out of the index, and an oversized row is counted and skipped; either still keeps the source partial.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";

// `scripts/**` has no declarations, so the review loads through a dynamic specifier, as its other suites load it.
const reviewModule = "#scripts/private-routing-daily-review.mjs";
const { dailyRoutingReview } = await import(reviewModule);

const asOf = "2026-10-02T14:00:00.000Z";
const ts = "2026-10-02T10:00:00.000Z";
const before = ROUTING_EXPERIMENTS.map((item) => item.startedOn).sort()[0]!;
const oldTs = (n: number) => new Date(Date.parse(`${before}T00:00:00Z`) - 86_400_000 - n * 1000).toISOString();
const epoch = ROUTING_EXPERIMENTS.find((item) => item.id === "sol61-vs-sonnet55")!;
const assignment = (id: string) => ({ ts, step: "worker.assignment", task_id: `W1-T${id}`,
  worker_assignment: { id: `a-${id}`, selected: { provider: "codex" }, routing: { decision: { ab: epoch.id,
    considered: [{ provider: "claude", model: "claude-sonnet-5-5" }] }, experiment: { assignedArm: "sol61", crossover: false } } } });
const encode = (rows: unknown[]) => rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n";

type Layout = { archive: unknown[]; live: unknown[] };
async function review({ archive, live }: Layout, retention: Record<string, number> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14473-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    // The oldest rotation holds history from before the first experiment; the live file holds the window.
    writeFileSync(join(stateDir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), gzipSync(encode(archive)));
    writeFileSync(join(stateDir, "ledger.ndjson"), encode(live));
    const { snapshot } = await dailyRoutingReview({ sources: [{ label: "core", stateDir }], outDir: join(dir, "out"), asOf,
      retention: { scratchDir: dir, ...retention } });
    const { stateDir: _stateDir, findings, ...source } = snapshot.sources[0];
    return { ...source, findings: findings.map((item: { path?: string }) => ({ ...item, path: item.path?.replace(stateDir, "<state>") })) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const tasks = (source: { reports: { id: string; arms: { arm: string; tasks: number }[] }[] }) =>
  source.reports.find((report) => report.id === epoch.id)!.arms.find((arm) => arm.arm === "sol61")!.tasks;

test("W1-T14473 criterion 1: an oversized row before the window is counted, not the end of the read", async () => {
  const oversized = JSON.stringify({ ts: oldTs(0), step: "unrelated", blob: "x".repeat(4096) });
  const source = await review({ archive: [oversized, { ts: oldTs(1), step: "unrelated" }],
    live: [assignment("1"), assignment("2")] }, { maxRowBytes: 2048 });
  assert.equal(source.oversizedRows, 1, "the oversized row is a counted exclusion");
  assert.deepEqual(source.findings.filter((item: { kind: string }) => item.kind === "oversized-row"),
    [{ kind: "oversized-row", form: "gzip", path: "<state>/ledger.2026-09-01T00-00-00-000Z.ndjson.gz", rowOrdinal: 1 }]);
  assert.equal(source.retainedRows, 2, "the window's experiment rows are still retained");
  assert.equal(tasks(source), 2, "the experiment reports its assigned tasks");
  assert.equal(source.rowsRead, 3, "the rows after the oversized one are still read");
});

test("W1-T14473 criterion 2: history before the earliest experiment cannot fill the exact-dedupe index", async () => {
  // 12288 bytes is the index's smallest disk bound; these rows alone fill it several times over.
  const history = Array.from({ length: 400 }, (_, n) => ({ ts: oldTs(n), step: "unrelated", pad: "y".repeat(200), n }));
  const source = await review({ archive: history, live: [assignment("1"), assignment("2"), assignment("3")] },
    { maxDiskBytes: 12288 });
  assert.equal(source.dedupe.state, "observed", "the index never reached its disk bound");
  assert.equal(source.dedupe.rows, 3, "only rows at or after the earliest experiment start entered the index");
  assert.ok(!source.reasons.includes("ledger-dedupe-disk-bound"));
  assert.equal(source.rowsRead, 403, "the older history is still read and counted");
  assert.equal(tasks(source), 3);
  assert.equal(source.state, "observed");
});

test("W1-T14473 criterion 3: an exclusion keeps the source partial and names why, and a clean corpus reads as before", async () => {
  const oversized = JSON.stringify({ ts, step: "unrelated", blob: "x".repeat(4096) });
  const partial = await review({ archive: [{ ts: oldTs(0), step: "unrelated" }], live: [assignment("1"), oversized] },
    { maxRowBytes: 2048 });
  assert.equal(partial.state, "observed-partial");
  assert.ok(partial.reasons.includes("ledger-row-over-bound"));
  assert.ok(!partial.reasons.includes("ledger-row-byte-bound"), "the read did not end at the oversized row");
  assert.equal(partial.completeness.complete, false);
  assert.equal(partial.reports.find((report: { id: string }) => report.id === epoch.id).reviewState, "source-incomplete");

  const clean = await review({ archive: [{ ts: oldTs(0), step: "unrelated" }], live: [assignment("1"), assignment("2")] });
  assert.equal(clean.state, "observed");
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.oversizedRows, 0);
  assert.equal(clean.rowsRead, 3);
  assert.equal(clean.dedupe.rows, 2);
  assert.equal(tasks(clean), 2);
});
