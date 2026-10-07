import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gatherRuns, type LedgerRecord } from "../src/lib/retro.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts/mount-headroom-sweep.mjs");
interface Report {
  corpus: { rawRowsWithRunId: number; newestTs?: string; formsOpened: string[] };
  classes: unknown;
  synthesis: unknown;
  cells: unknown;
  assignments: unknown;
}
const m = await import(pathToFileURL(SCRIPT).href) as {
  ledgerRecordCollector(opts?: { retainRecord(row: LedgerRecord): boolean }): { add(line: string): void; result(): { records: LedgerRecord[]; rawRowsWithRunId: number }; identityCount(): number };
  isMountSweepEvidence(row: LedgerRecord): boolean;
  buildMountHeadroomSweep(dir: string): Report;
  readLedgerCorpus(dir: string): { rawLines: string[] };
  parseAndDedupeLedgerLines(lines: string[]): { records: LedgerRecord[]; rawRowsWithRunId: number };
  computeClassSweep(runs: ReturnType<typeof gatherRuns>): unknown;
  computeSynthesisSweep(rows: LedgerRecord[]): unknown;
  armFieldsByRunId(rows: LedgerRecord[]): Map<string, unknown>;
  windowEvidenceByRunId(rows: LedgerRecord[], arms: Map<string, unknown>): Map<string, unknown>;
  assignmentFieldsByRunId(rows: LedgerRecord[]): { fieldsByRunId: Map<string, unknown>; integrity: unknown };
  computeArmSweep(runs: ReturnType<typeof gatherRuns>, arms: Map<string, unknown>, newestTs: string | undefined, windows: Map<string, unknown>): unknown;
  computeAssignmentSweep(runs: ReturnType<typeof gatherRuns>, assignments: Map<string, unknown>, newestTs: string | undefined): unknown;
};

test("unpriced mount observations consume neither retained records nor dedupe identities", () => {
  const collector = m.ledgerRecordCollector({ retainRecord: m.isMountSweepEvidence });
  const kept = { step: "run.start", run_id: "work", task_id: "TASK" };
  collector.add(JSON.stringify(kept));
  collector.add(JSON.stringify(kept));
  for (let i = 0; i < 20_000; i++) collector.add(JSON.stringify({ step: "probe", run_id: `probe-${i}`, cost_usd: 99, payload: "x".repeat(200) }));
  const result = collector.result();
  assert.equal(result.records.length, 1, "report the regression's count before formatting its entire discarded corpus");
  assert.deepEqual(result.records, [kept]);
  assert.equal(collector.identityCount(), 1, "excluded rows are rejected before their identities enter the Set");
  assert.equal(result.rawRowsWithRunId, 20_002, "raw counts include ignored rows and duplicates, as before");
});

test("the filtered mount report equals the full-corpus reducers including credits, assignments and arbitrary PR fallbacks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mount-filter-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ts = "2026-09-01T00:00:00.000Z";
  const start = (id: string) => ({ step: "run.start", run_id: id, task_id: id, type: "implement", risk: "low", task_class: "src", ts });
  const rows = [
    start("A"), start("B"), start("C"),
    { step: "worker.assignment", worker_assignment: { version: 1, phase: "pre-execution", id: "chosen", selected: { provider: "codex", model: "luna", effort: "low" } }, ts },
    { step: "implement.done", run_id: "A", num_turns: 5, cost_usd: 2, provider: "codex", served_model: "luna", routed_model: "luna", effort: "low", selection_assignment_id: "chosen", ts },
    { step: "implement.resumed", run_id: "A", num_turns: 3, cost_usd: 1, provider: "codex", served_model: "luna", effort: "low", ts },
    { step: "verdict", run_id: "A", verdict: "blocked_ci", cost_usd: 3, pr_url: "https://fixture/pr/1", ts },
    { step: "verdict.merged", pr_url: "https://fixture/pr/1", ts: "2026-09-02T00:00:00.000Z" },
    { step: "verdict", run_id: "B", verdict: "thrown", stage: "recon", ts },
    { step: "recon.done", run_id: "C", cost_usd: 4, num_turns: 6, ts },
    { step: "unknown.pr_source", run_id: "C", pr_url: "https://fixture/old", ts },
    { step: "correction.provenance", run_id: "C", actual_pr_url: "https://fixture/corrected", ts },
    { step: "verdict.merged", pr_url: "https://fixture/corrected", ts },
    { step: "retro.synthesized", run_id: "retro", cost_usd: 7, num_turns: 8, ts },
    { step: "triage.synthesized", run_id: "triage", cost_usd: 1, num_turns: 1, ts },
    { step: "inbox.draft_synthesized", run_id: "draft", cost_usd: 2, num_turns: 2, ts },
    { step: "inbox.draft_synthesized", cost_usd: 2, ts },
    { step: "irrelevant", run_id: "A", cost_usd: 10000, num_turns: 5000, ts: "2026-09-03T00:00:00.000Z" },
  ];
  writeLedger(rows.slice(6), { dir: root, rotations: [
    { at: "2026-09-01T00:00:00.000Z", rows: rows.slice(0, 10), gz: true },
    { at: "2026-09-02T00:00:00.000Z", rows: rows.slice(4, 14) },
  ] });
  const full = m.parseAndDedupeLedgerLines(m.readLedgerCorpus(root).rawLines);
  const report = m.buildMountHeadroomSweep(root);
  const runs = gatherRuns(full.records);
  const arms = m.armFieldsByRunId(full.records);
  const assignments = m.assignmentFieldsByRunId(full.records);
  assert.deepEqual(report.corpus.formsOpened, ["gzip", "live", "plain"]);
  assert.equal(report.corpus.rawRowsWithRunId, full.rawRowsWithRunId);
  assert.equal(report.corpus.newestTs, "2026-09-03T00:00:00.000Z", "a discarded row still advances the freshness measurement");
  assert.equal(runs.find((r) => r.runId === "A")?.verdict, "merged");
  assert.equal(runs.find((r) => r.runId === "C")?.correctedFromPrUrl, "https://fixture/old");
  assert.equal(assignments.fieldsByRunId.size, 0, "an incomplete resume assignment remains explicitly excluded");
  assert.deepEqual(report.classes, m.computeClassSweep(runs));
  assert.deepEqual(report.synthesis, m.computeSynthesisSweep(full.records));
  assert.deepEqual(report.cells, m.computeArmSweep(runs, arms, report.corpus.newestTs, m.windowEvidenceByRunId(full.records, arms)));
  assert.deepEqual(report.assignments, { integrity: assignments.integrity, cells: m.computeAssignmentSweep(runs, assignments.fieldsByRunId, report.corpus.newestTs) });
});

test("the mount sweep completes under a 256 MiB heap with 350000 unpriced rows", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mount-filter-heap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const entry = join(root, "heap-control.mjs");
  writeFileSync(entry, `
    import assert from "node:assert/strict";
    import { buildMountHeadroomSweep } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    const n = 350000;
    const pad = "x".repeat(512);
    const row = (i) => JSON.stringify({ step: "unpriced", run_id: "probe-" + String(i).padStart(6, "0"), pad }) + "\\n";
    const evidence = [
      { step: "run.start", run_id: "real", task_id: "REAL", type: "implement", task_class: "src", ts: "2026-09-01T00:00:00Z" },
      { step: "implement.done", run_id: "real", cost_usd: 2, num_turns: 3 },
      { step: "verdict", run_id: "real", verdict: "merged", cost_usd: 2 }
    ].map(r => JSON.stringify(r) + "\\n").join("");
    const width = Buffer.byteLength(row(0));
    const buf = Buffer.alloc(n * width + Buffer.byteLength(evidence));
    for (let i = 0; i < n; i++) buf.write(row(i), i * width);
    buf.write(evidence, n * width);
    const report = buildMountHeadroomSweep("fixture", {
      readdirSync: () => [], existsSync: () => true, readFileSync: () => buf,
      gunzipSync: () => { throw new Error("the live fixture is not gzip"); }
    });
    assert.equal(report.corpus.rawRowsWithRunId, n + 3);
    assert.equal(report.corpus.distinctRunCount, 1);
    assert.equal(report.classes[0].totalSettledCostUsd, 2);
    assert.ok(process.memoryUsage().heapUsed < 128 * 1024 * 1024);
    console.log(JSON.stringify({ rows: n, heapUsed: process.memoryUsage().heapUsed }));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=256", "--import", "tsx", entry], {
    cwd: REPO, timeout: 30_000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" },
  });
  assert.equal(JSON.parse(stdout.trim()).rows, 350_000);
});
