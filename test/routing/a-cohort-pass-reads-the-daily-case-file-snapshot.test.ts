import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkCohortCadence, readStateCaseFiles, runBenchmarkCohortIdlePass, runBenchmarkCohortPass,
  stateCaseFileSnapshotPath, type BenchmarkCohortPassResult } from "#src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";

const NO_JOIN = "unavailable-no-github-verification-join";
const cutoff = "2026-09-27T23:00:00.000Z";
const sha = "a".repeat(40);
const row = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";
const at = (i: number, seconds = 0) => `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };

function caseFile(i: number, model: string, pr: "MERGED" | "CLOSED"): TaskCaseFile {
  return {
    version: "task-case-file-v1", taskId: `W1-T${9000 + i}`, asOf: cutoff,
    plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
    ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
    runs: [{ runId: `run-${i}`, startedAt: at(i), assignmentId: `assign-${i}`, selectedProvider: "codex", selectedModel: model,
      servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 2000 + i }],
    pr: observed({ number: 2000 + i, url: `https://github.com/craigoley/remudero/pull/${2000 + i}`, headSha: sha, state: pr, taskCredit: pr === "MERGED" }),
    review: observed({ headSha: sha, status: "success" }), acceptance: observed({ headSha: sha, status: "success" }),
    ci: observed({ headSha: sha, status: "success" }),
    mergedSource: pr === "MERGED" ? observed({ prNumber: 2000 + i, mergedAt: "2026-09-27T22:00:00Z" }) : notCollected,
    deployment: notCollected, runtime: notCollected, next: null,
  } as TaskCaseFile;
}

const cases = [{ model: "gpt-luna", pr: "MERGED" }, { model: "gpt-luna", pr: "CLOSED" }, { model: "claude-opus", pr: "MERGED" }] as const;

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-cohort-state-cases-"));
  writeFileSync(join(stateDir, "ledger.ndjson"), cases.map(({ model }, i) => row({ ts: at(i), host: "core-host",
    task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.assignment",
    worker_assignment: { id: `assign-${i}`, requested: { model }, selected: { provider: "codex", model } },
    benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } } } })
    + row({ ts: at(i, 30), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.attempt",
      selection_assignment_id: `assign-${i}`, success: true, billing_mode: "api", total_cost_usd: 0.02 })).join(""));
  const writeCases = (text: string) => {
    mkdirSync(join(stateDir, "field-trials"), { recursive: true });
    writeFileSync(stateCaseFileSnapshotPath(stateDir), text);
  };
  return { stateDir, writeCases, close: () => rmSync(stateDir, { recursive: true, force: true }) };
}
const outcomes = (result: BenchmarkCohortPassResult) => result.snapshot.cohorts.map((cohort) => cohort.verifiedOutcome);
const goodSnapshot = () => JSON.stringify(cases.map(({ model, pr }, i) => caseFile(i, model, pr)));

test("W1-T14539 criterion 1: a pass that reads the state snapshot joins it, and a later pass keeps the join", async () => {
  const f = fixture();
  try {
    f.writeCases(goodSnapshot());
    const first = await runBenchmarkCohortPass(f.stateDir, { nowIso: cutoff, caseFilesFromState: true });
    assert.equal(first.caseFileJoin, "joined");
    assert.ok(first.snapshot.cohorts.length > 0, "the fixture builds cohort rows");
    for (const outcome of outcomes(first)) assert.notEqual(outcome, NO_JOIN);
    // The next pass of the same writer, with the same snapshot and no new ledger rows, must not erase the join.
    const second = await runBenchmarkCohortPass(f.stateDir, { nowIso: cutoff, caseFilesFromState: true });
    assert.deepEqual(outcomes(second), outcomes(first));
    // The idle pass (entrypoint-supervise.sh) reads the same snapshot and names the join on its event line.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    let seen: BenchmarkCohortPassResult | undefined;
    try {
      assert.equal(await runBenchmarkCohortIdlePass(f.stateDir, async (dir, opts) => {
        seen = await runBenchmarkCohortPass(dir, { ...opts, nowIso: cutoff });
        return seen;
      }), 0);
    } finally { console.log = original; }
    assert.equal(JSON.parse(lines[0]!).case_file_join, "joined");
    assert.deepEqual(outcomes(seen!), outcomes(first));
  } finally { f.close(); }
});

test("W1-T14539 criterion 2: a missing, unreadable, oversized or invalid snapshot leaves the pass unjoined and names why", async () => {
  const f = fixture();
  try {
    const absent = await runBenchmarkCohortPass(f.stateDir, { nowIso: cutoff, caseFilesFromState: true });
    assert.equal(absent.caseFileJoin, "absent");
    for (const outcome of outcomes(absent)) assert.equal(outcome, NO_JOIN);
    f.writeCases("not json");
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "invalid" });
    f.writeCases(JSON.stringify([{ version: "task-case-file-v0", taskId: "W1-T1", asOf: cutoff }]));
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "invalid" });
    const invalid = await runBenchmarkCohortPass(f.stateDir, { nowIso: cutoff, caseFilesFromState: true });
    assert.equal(invalid.caseFileJoin, "invalid");
    for (const outcome of outcomes(invalid)) assert.equal(outcome, NO_JOIN);
    f.writeCases(" ".repeat(4 * 1024 * 1024 + 1));
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "too-large" });
    rmSync(stateCaseFileSnapshotPath(f.stateDir));
    mkdirSync(stateCaseFileSnapshotPath(f.stateDir));
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "unreadable" });
    rmSync(stateCaseFileSnapshotPath(f.stateDir), { recursive: true });
    f.writeCases(goodSnapshot());
    // A pass that does not ask for the state snapshot reports nothing about it.
    assert.equal((await runBenchmarkCohortPass(f.stateDir, { nowIso: cutoff })).caseFileJoin, undefined);
  } finally { f.close(); }
});

test("W1-T14539 criterion 3: a new case-file snapshot makes the daemon cadence due", async () => {
  const f = fixture();
  try {
    let now = 1_000;
    const ran: string[] = [];
    const cadence = benchmarkCohortCadence({ stateDir: () => f.stateDir, clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
      run: async (dir) => { ran.push(dir); return runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFilesFromState: true }); } });
    assert.equal(cadence.checkBenchmarkCohort(), true, "boot is due");
    await cadence.runBenchmarkCohortPass();
    assert.equal(cadence.checkBenchmarkCohort(), false, "nothing changed");
    f.writeCases(goodSnapshot());
    assert.equal(cadence.checkBenchmarkCohort(), true, "a snapshot that appears is due");
    const joined = await cadence.runBenchmarkCohortPass();
    assert.equal(joined.dueBecause, "case_files");
    assert.equal(joined.caseFileJoin, "joined");
    assert.equal(cadence.checkBenchmarkCohort(), false);
    now += 1_000;
    utimesSync(stateCaseFileSnapshotPath(f.stateDir), new Date(now), new Date(now));
    assert.equal(cadence.checkBenchmarkCohort(), true, "a rewritten snapshot is due");
    assert.equal(ran.length, 2);
  } finally { f.close(); }
});
