import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { benchmarkCohortDaemonPass, runBenchmarkCohortIdlePass, runBenchmarkCohortPass, stateCaseFileSnapshotPath,
  type BenchmarkCohortPassResult } from "#src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const NO_JOIN = "unavailable-no-github-verification-join";
const cutoff = "2026-09-27T23:00:00.000Z";
const sha = "a".repeat(40);
// More sources than the 4 the daemon pass once scanned, so any count below 7 leaves one pending.
const SOURCES = 7;
// Each rotation plus the (empty) live ledger is a source.
const SCANNED = SOURCES + 1;
const at = (i: number, seconds = 0) => `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };

function caseFile(i: number): TaskCaseFile {
  return {
    version: "task-case-file-v1", taskId: `W1-T${9000 + i}`, asOf: cutoff,
    plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
    ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 1, live: 0 }, matchingRows: 2 }),
    runs: [{ runId: `run-${i}`, startedAt: at(i), assignmentId: `assign-${i}`, selectedProvider: "codex", selectedModel: "gpt-luna",
      servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 2000 + i }],
    pr: observed({ number: 2000 + i, url: `https://github.com/craigoley/remudero/pull/${2000 + i}`, headSha: sha, state: "MERGED", taskCredit: true }),
    review: observed({ headSha: sha, status: "success" }), acceptance: observed({ headSha: sha, status: "success" }),
    ci: observed({ headSha: sha, status: "success" }),
    mergedSource: observed({ prNumber: 2000 + i, mergedAt: "2026-09-27T22:00:00Z" }),
    deployment: notCollected, runtime: notCollected, next: null,
  } as TaskCaseFile;
}

/** One sealed rotation per task, each holding that task's assignment and attempt, plus an empty live ledger. */
function manySources(t: TestContext, name: string): string {
  return writeLedger([], { dir: ownedFixtureDir(t, name).dir, rotations: Array.from({ length: SOURCES }, (_, i) => ({
    at: `2026-09-27T10:${String(i).padStart(2, "0")}:59.000Z`,
    rows: [{ ts: at(i), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.assignment",
      worker_assignment: { id: `assign-${i}`, requested: { model: "gpt-luna" }, selected: { provider: "codex", model: "gpt-luna" } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } } } },
    { ts: at(i, 30), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.attempt",
      selection_assignment_id: `assign-${i}`, success: true, billing_mode: "api", total_cost_usd: 0.02 }],
  })) }).dir;
}

test("W1-T14727 criterion 1: a cohort pass scans every changed source in one pass", async (t) => {
  const stateDir = manySources(t, "cohort-every-source");
  mkdirSync(join(stateDir, "field-trials"), { recursive: true });
  writeFileSync(stateCaseFileSnapshotPath(stateDir), JSON.stringify(Array.from({ length: SOURCES }, (_, i) => caseFile(i))));
  // The idle pass's own options, with only the clock pinned to the snapshot.
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  let seen: BenchmarkCohortPassResult | undefined;
  try {
    assert.equal(await runBenchmarkCohortIdlePass(stateDir, async (dir, opts) => {
      seen = await runBenchmarkCohortPass(dir, { ...opts, nowIso: cutoff });
      return seen;
    }), 0);
  } finally { console.log = original; }
  assert.equal(seen!.scannedSources, SCANNED, "every changed source scanned");
  assert.equal(seen!.pendingSources, 0, "invariant:every-changed-source-per-pass");
  assert.notEqual(seen!.state, "partial");
  assert.equal(seen!.caseFileJoin, "joined");
  assert.equal(seen!.snapshot.sourceRows.assignments, SOURCES);
  for (const cohort of seen!.snapshot.cohorts) assert.notEqual(cohort.verifiedOutcome, NO_JOIN, "the verified join is present");
  assert.equal(JSON.parse(lines[0]!).pending_sources, 0);
  // The default with no options at all scans every source too.
  const fresh = manySources(t, "cohort-every-source-default");
  const plain = await runBenchmarkCohortPass(fresh, { nowIso: cutoff });
  assert.equal(plain.scannedSources, SCANNED);
  assert.equal(plain.pendingSources, 0);
  // maxSources stays a test seam, and still refuses a non-positive count.
  await assert.rejects(runBenchmarkCohortPass(fresh, { maxSources: 0 }), /maxSources must be a positive integer/);
});

test("W1-T14727 criterion 2: the cohort daemon pass names no source count", async (t) => {
  const stateDir = manySources(t, "cohort-daemon-every-source");
  // The hook's real default: the off-loop worker, with no count passed in.
  const result = await benchmarkCohortDaemonPass(stateDir);
  assert.equal(result.scannedSources, SCANNED);
  assert.equal(result.pendingSources, 0);
  assert.equal(result.snapshot.sourceRows.assignments, SOURCES);
});
