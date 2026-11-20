import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { runBenchmarkCohortIdlePass, runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";
import type { BenchmarkCohort } from "#src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";

const row = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";

test("benchmark cohort idle failure reports a bounded class without leaking error text", async () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: string) => { lines.push(line); };
  try {
    const code = await runBenchmarkCohortIdlePass("unused", async () => {
      throw Object.assign(new Error("sensitive path and source text"), { code: "EACCES" });
    });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(lines[0]!), { event: "benchmark_cohort.idle_pass_failed",
      reason: "projection-failed", error_class: "EACCES" });
  } finally { console.error = original; }
});

test("benchmark cohort live append retains a stable prefix watermark", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-live-prefix-"));
  const live = join(stateDir, "ledger.ndjson");
  const first = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
  const second = row({ ts: "2026-09-26T11:01:00.000Z", step: "worker.assignment",
    worker_assignment: { id: "a2", selected: { provider: "codex", model: "gpt-6-sol" } } });
  try {
    writeFileSync(live, first);
    const prefix = await runBenchmarkCohortPass(stateDir, { onLiveWatermark: () => {
      writeFileSync(live, first + second);
    } });
    assert.equal(prefix.state, "complete");
    assert.equal(prefix.snapshot.state, "observed");
    assert.equal(prefix.snapshot.sourceRows.assignments, 1, "the newly appended row is not in the declared prefix");
    assert.equal(prefix.snapshot.liveWatermark?.prefixBytes, Buffer.byteLength(first));
    assert.equal(prefix.snapshot.liveWatermark?.tailPendingBytes, Buffer.byteLength(second));
    const catchup = await runBenchmarkCohortPass(stateDir);
    assert.equal(catchup.state, "complete");
    assert.equal(catchup.snapshot.sourceRows.assignments, 2);
    assert.equal(catchup.snapshot.liveWatermark?.tailPendingBytes, 0);
    assert.equal(readFileSync(live, "utf8"), first + second, "source remains immutable to the gardener");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort refuses a live prefix rewritten or lost after scanning", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-prefix-race-"));
  const live = join(stateDir, "ledger.ndjson");
  const assignment = (id: string) => row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } });
  const first = assignment("a1");
  try {
    writeFileSync(live, first);
    const rewritten = await runBenchmarkCohortPass(stateDir, { onBeforeLivePrefixVerify: () => {
      writeFileSync(live, assignment("a2"));
    } });
    assert.equal(rewritten.state, "partial");
    assert.equal(rewritten.snapshot.state, "unavailable", "a rewritten prefix is not a healthy cohort");
    assert.equal(rewritten.snapshot.reason, "ledger-live-changed-after-scan");
    writeFileSync(live, first);
    const vanished = await runBenchmarkCohortPass(stateDir, { onBeforeLivePrefixVerify: () => {
      unlinkSync(live);
    } });
    assert.equal(vanished.state, "partial");
    assert.equal(vanished.snapshot.reason, "ledger-live-unreadable-after-scan");
    writeFileSync(live, first);
    assert.equal((await runBenchmarkCohortPass(stateDir)).state, "complete", "restored evidence can be retried");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort live prefix repairs rotation and truncation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-live-rotate-"));
  const live = join(stateDir, "ledger.ndjson");
  const assignment = (id: string) => row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } });
  const first = assignment("a1");
  const second = assignment("a2");
  const third = assignment("a3");
  try {
    writeFileSync(live, first);
    assert.equal((await runBenchmarkCohortPass(stateDir)).snapshot.sourceRows.assignments, 1);
    writeFileSync(join(stateDir, "ledger.2026-09-26T11-01-00-000Z.ndjson"), first);
    writeFileSync(live, second);
    const rotated = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(rotated.state, "complete");
    assert.equal(rotated.snapshot.sourceRows.assignments, 2, "the archived replay is not counted twice");
    writeFileSync(live, "");
    const lost = await runBenchmarkCohortPass(stateDir);
    assert.equal(lost.state, "unavailable", "unarchived truncated evidence is not a healthy zero");
    assert.equal(lost.snapshot.reason, "retired-source-evidence-not-reconciled");
    writeFileSync(join(stateDir, "ledger.2026-09-26T11-02-00-000Z.ndjson"), second);
    writeFileSync(live, third);
    const repaired = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(repaired.state, "complete");
    assert.equal(repaired.snapshot.sourceRows.assignments, 3);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort leaves an unscanned changed live source pending behind archive work", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-pending-live-"));
  const live = join(stateDir, "ledger.ndjson");
  const assignment = (id: string) => row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } });
  try {
    writeFileSync(live, assignment("a1"));
    assert.equal((await runBenchmarkCohortPass(stateDir)).state, "complete");
    writeFileSync(join(stateDir, "ledger.2026-09-26T11-02-00-000Z.ndjson"), assignment("a2"));
    writeFileSync(live, assignment("a1") + assignment("a3"));
    const archiveOnly = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(archiveOnly.state, "partial", "an old live prefix is not a complete new cohort");
    assert.equal(archiveOnly.pendingSources, 1);
    const finished = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(finished.state, "complete");
    assert.equal(finished.snapshot.sourceRows.assignments, 3);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohorts reconcile the three-form ledger union exactly", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-cohort-"));
  try {
    const assignment = row({
      ts: "2026-09-26T12:00:00.000Z", step: "worker.assignment", selection_assignment_id: "a1",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano", effort: "low" } },
      benchmark_run: { version: "benchmark-run-v1", phase: "assignment", work: {
        taskClass: { state: "observed", value: "fix" },
      }, stack: { harnessRevision: { state: "unavailable", reason: "not-pinned-by-harness" } } },
    });
    writeFileSync(join(stateDir, "ledger.2026-09-26T12-01-00-000Z.ndjson.gz"), gzipSync(assignment));
    writeFileSync(join(stateDir, "ledger.2026-09-26T12-02-00-000Z.ndjson"), assignment);
    writeFileSync(join(stateDir, "ledger.ndjson"), row({
      ts: "2026-09-26T12:03:00.000Z", step: "worker.attempt", selection_assignment_id: "a1",
      success: true, billing_mode: "api", total_cost_usd: 0.01,
      benchmark_run: { version: "benchmark-run-v1", phase: "attempt" },
    }));

    const first = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(first.state, "partial");
    assert.equal(first.snapshot.state, "unavailable", "a partial scan never publishes a healthy zero");
    const second = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(second.state, "partial");
    const third = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(third.state, "complete");
    assert.equal(third.snapshot.state, "observed");
    assert.equal(third.snapshot.sourceLineage.length, 3, "gzip, plain and live are all positive controls");
    assert.deepEqual(third.snapshot.sourceLineage.map((source) => source.form).sort(), ["gzip", "live", "plain"]);
    assert.equal(third.snapshot.sourceRows.assignments, 1, "exact replay is not a second assignment");
    assert.equal(third.snapshot.sourceRows.attempts, 1);
    assert.equal(third.snapshot.sourceRows.terminals, 0);
    assert.equal(third.snapshot.cohorts.length, 1);
    assert.deepEqual(third.snapshot.cohorts[0].dimensions, {
      day: "2026-09-26", taskClass: "fix", provider: "cash", model: "gpt-5-nano", harnessRevision: null,
    });
    assert.equal(third.snapshot.cohorts[0].assignments, 1);
    assert.equal(third.snapshot.cohorts[0].joinedAttempts, 1);
    assert.equal(third.snapshot.cohorts[0].apiCostUsd, 0.01);
    assert.equal(third.snapshot.cohorts[0].subscriptionNotionalUsd, 0);
    assert.equal(third.snapshot.cohorts[0].servedModelObserved, 0, "unknown served model never becomes selected model");
    assert.deepEqual(third.snapshot.coverage.servedModel,
      { denominator: 1, observed: 0, noAttempt: 0, notRecorded: 1 });
    assert.deepEqual(third.snapshot.coverage.harnessRevision,
      { denominator: 1, observed: 0, noAttempt: 0, notRecorded: 1 });
    assert.equal(third.snapshot.verifiedTaskOutcome, "unavailable-no-github-verification-join");
    assert.equal(third.snapshot.experimentEffect, "unavailable-no-randomized-allocation");
    assert.equal(readFileSync(join(stateDir, "ledger.ndjson"), "utf8").length > 0, true, "raw source remains untouched");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts replay late and withdrawn evidence without inventing zeros", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-late-"));
  try {
    for (const [id, day] of [["a1", "2026-09-25"], ["a2", "2026-09-26"]]) {
      writeFileSync(join(stateDir, `ledger.${day}T12-00-00-000Z.ndjson`), row({
        ts: `${day}T11:00:00.000Z`, step: "worker.assignment",
        worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } },
      }));
    }
    const livePath = join(stateDir, "ledger.ndjson");
    writeFileSync(livePath, row({ ts: "2026-09-26T12:00:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a1", success: true, billing_mode: "api", total_cost_usd: 0.02 }));
    const initial = await runBenchmarkCohortPass(stateDir, { maxSources: 3, nowIso: "2026-09-26T12:01:00.000Z" });
    assert.equal(initial.state, "complete");
    assert.equal(initial.snapshot.pressure.rebuiltPartitions, 2);
    assert.equal(initial.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-26")?.joinedAttempts, 0);
    const replay = await runBenchmarkCohortPass(stateDir, { maxSources: 3, nowIso: "2026-09-26T12:01:00.000Z" });
    assert.deepEqual(replay.snapshot, initial.snapshot, "same corpus and clock are idempotent");

    writeFileSync(livePath, readFileSync(livePath, "utf8") + row({
      ts: "2026-09-26T12:02:00.000Z", step: "worker.attempt", selection_assignment_id: "a2",
      success: false, billing_mode: "subscription", total_cost_usd: 0.03,
    }));
    const late = await runBenchmarkCohortPass(stateDir, { maxSources: 1, nowIso: "2026-09-26T12:03:00.000Z" });
    assert.equal(late.state, "complete");
    assert.equal(late.snapshot.pressure.rebuiltPartitions, 1, "the unaffected day keeps its materialized cohort");
    assert.equal(late.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-26")?.joinedAttempts, 1);
    assert.equal(late.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-25")?.joinedAttempts, 1);
    assert.equal(late.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-26")?.subscriptionNotionalUsd, 0.03);

    writeFileSync(livePath, readFileSync(livePath, "utf8") + row({
      ts: "2026-09-26T12:04:00.000Z", step: "worker.attempt", selection_assignment_id: "a1",
      evidence_action: "retract", reason: "operator-corrected-evidence",
    }));
    const withdrawn = await runBenchmarkCohortPass(stateDir, { maxSources: 1, nowIso: "2026-09-26T12:05:00.000Z" });
    assert.equal(withdrawn.state, "complete");
    assert.equal(withdrawn.snapshot.pressure.rebuiltPartitions, 1);
    assert.equal(withdrawn.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-25")?.joinedAttempts, 0);
    assert.equal(withdrawn.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-25")?.apiCostUsd, 0);
    assert.equal(withdrawn.snapshot.cohorts.find((cohort) => cohort.dimensions.day === "2026-09-26")?.joinedAttempts, 1);
    assert.equal(withdrawn.snapshot.sourceRows.attempts, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts account for storage pressure without raw deletion", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-pressure-"));
  try {
    const archive = join(stateDir, "ledger.2026-09-26T12-00-00-000Z.ndjson");
    const first = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    writeFileSync(archive, first);
    const initial = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(initial.state, "complete");
    assert.equal(initial.snapshot.pressure.sourceBytes, Buffer.byteLength(first));
    assert.equal(initial.snapshot.pressure.dimensionCardinality, 1);
    assert.equal(initial.snapshot.pressure.eventsPerAssignment, 1);
    assert.ok(initial.snapshot.pressure.derivedBytes > 0);
    assert.ok(initial.checkpointBytes! >= initial.snapshot.pressure.derivedBytes);
    assert.equal(initial.snapshot.pressure.auditedSourceBytes, Buffer.byteLength(first));
    assert.deepEqual(initial.snapshot.pressure.evidenceBytesByDay,
      [{ day: "2026-09-26", bytes: Buffer.byteLength(first.trim()) }]);
    assert.equal(initial.snapshot.pressure.runsWithId, 0);
    assert.equal(initial.snapshot.pressure.eventsPerRun, null);
    assert.equal(initial.snapshot.pressure.snapshotGrowthBytes, null);
    assert.ok(initial.snapshot.pressure.sourceToDerivedRatio! > 0);
    assert.equal(initial.snapshot.cohorts[0].dimensions.harnessRevision, null);
    assert.equal(initial.snapshot.cohorts[0].servedModelObserved, 0);

    writeFileSync(archive, first + "{malformed\n");
    const refused = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(refused.state, "unavailable");
    assert.equal(refused.snapshot.reason, "ledger-source-malformed");
    assert.equal(refused.snapshot.lastGoodAt, initial.snapshot.asOf);
    assert.equal(refused.snapshot.state, "unavailable", "last good is visible but cannot masquerade as fresh");
    assert.equal(readFileSync(archive, "utf8"), first + "{malformed\n", "the gardener owns no raw deletion");

    writeFileSync(archive, first);
    const repaired = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(repaired.state, "complete");
    assert.equal(repaired.snapshot.sourceRows.assignments, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts use terminal worker evidence only when a per-call attempt is absent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-terminal-"));
  try {
    const live = join(stateDir, "ledger.ndjson");
    const assignment = row({ ts: "2026-09-26T11:00:00.000Z", run_id: "r1", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const terminal = row({ ts: "2026-09-26T11:02:00.000Z", run_id: "r1", step: "verdict",
      selection_assignment_id: "a1", success: false, served_model: "gpt-5-nano", total_cost_usd: 0.04 });
    writeFileSync(live, assignment + terminal);
    const legacy = await runBenchmarkCohortPass(stateDir);
    assert.equal(legacy.state, "complete");
    assert.equal(legacy.snapshot.cohorts[0].joinedAttempts, 0);
    assert.equal(legacy.snapshot.cohorts[0].joinedTerminals, 1);
    assert.equal(legacy.snapshot.cohorts[0].workerCallFailure, 1);
    assert.equal(legacy.snapshot.cohorts[0].apiCostUsd, 0, "unknown billing mode is not cash spent");
    assert.equal(legacy.snapshot.pressure.eventsPerRun, 2);
    assert.equal(legacy.snapshot.coverage.billingMode.notRecorded, 1);

    const attempt = row({ ts: "2026-09-26T11:01:00.000Z", run_id: "r1", step: "worker.attempt",
      selection_assignment_id: "a1", success: true, billing_mode: "api", total_cost_usd: 0.02 });
    writeFileSync(live, assignment + terminal + attempt);
    const corrected = await runBenchmarkCohortPass(stateDir);
    assert.equal(corrected.snapshot.cohorts[0].joinedTerminals, 1);
    assert.equal(corrected.snapshot.cohorts[0].joinedAttempts, 1);
    assert.equal(corrected.snapshot.cohorts[0].workerCallSuccess, 1, "the attempt wins over terminal fallback");
    assert.equal(corrected.snapshot.cohorts[0].workerCallFailure, 0);
    assert.equal(corrected.snapshot.cohorts[0].apiCostUsd, 0.02, "the terminal cost is not counted twice");
    assert.equal(corrected.snapshot.pressure.snapshotGrowthBytes !== null, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts replay an invalid checkpoint and resume a changed source batch", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-checkpoint-"));
  try {
    const firstPath = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson");
    const secondPath = join(stateDir, "ledger.2026-09-26T12-00-00-000Z.ndjson");
    const first = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const second = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a2", selected: { provider: "codex", model: "gpt-6-sol" } } });
    writeFileSync(firstPath, first);
    writeFileSync(secondPath, second);
    const initial = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(initial.snapshot.sourceRows.assignments, 2);

    writeFileSync(firstPath, first + row({ ts: "2026-09-25T11:01:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a1", success: true }));
    writeFileSync(secondPath, second + row({ ts: "2026-09-26T11:01:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a2", success: false }));
    const partial = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(partial.state, "partial");
    assert.equal(partial.snapshot.state, "unavailable");
    assert.equal(partial.snapshot.lastGoodAt, initial.snapshot.asOf);
    const complete = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(complete.state, "complete");
    assert.equal(complete.snapshot.cohorts.reduce((sum, cohort) => sum + cohort.joinedAttempts, 0), 2);
    assert.equal(complete.snapshot.pressure.rebuiltPartitions, 2);

    const checkpoint = join(stateDir, "benchmark-cohort-index.json");
    const corrupt = JSON.parse(readFileSync(checkpoint, "utf8"));
    corrupt.sources[0].segment = "../outside.ndjson";
    writeFileSync(checkpoint, JSON.stringify(corrupt));
    const replay = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(replay.state, "partial", "a damaged checkpoint cannot return a cached observed snapshot");
    assert.equal(replay.snapshot.state, "unavailable");
    const replayComplete = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(replayComplete.state, "complete");
    assert.equal(replayComplete.snapshot.sourceRows.assignments, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts expose unjoinable rows and refuse conflicting assignment IDs", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-conflict-"));
  try {
    const live = join(stateDir, "ledger.ndjson");
    const valid = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const invalid = row({ ts: "2026-09-26T11:01:00.000Z", step: "worker.assignment",
      worker_assignment: { selected: { provider: "cash", model: "gpt-5-nano" } } });
    const unjoined = row({ ts: "2026-09-26T11:02:00.000Z", step: "worker.attempt", success: true });
    const terminal = row({ ts: "2026-09-26T11:03:00.000Z", step: "verdict", success: true });
    writeFileSync(live, valid + invalid + unjoined + terminal);
    const initial = await runBenchmarkCohortPass(stateDir);
    assert.equal(initial.state, "complete");
    assert.equal(initial.snapshot.sourceRows.assignments, 1);
    assert.equal(initial.snapshot.sourceRows.invalidAssignmentRows, 1);
    assert.equal(initial.snapshot.sourceRows.attemptRowsWithoutAssignmentId, 1);
    assert.equal(initial.snapshot.sourceRows.terminalRowsWithoutAssignmentId, 1);
    assert.equal(initial.snapshot.coverage.workerCall.noAttempt, 1);

    const conflicting = row({ ts: "2026-09-26T11:04:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "codex", model: "gpt-6-sol" } } });
    writeFileSync(live, valid + invalid + unjoined + terminal + conflicting);
    const unavailable = await runBenchmarkCohortPass(stateDir);
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.snapshot.reason, "conflicting-assignment-ids");
    assert.equal(unavailable.snapshot.lastGoodAt, initial.snapshot.asOf);
    assert.equal(unavailable.snapshot.cohorts[0].dimensions.model, "gpt-5-nano",
      "a conflicting ID cannot silently move a prior worker into another model cohort");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts reconcile a retired rotation with its successor before publishing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-retire-"));
  try {
    const old = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson");
    const successor = join(stateDir, "ledger.2026-09-25T13-00-00-000Z.ndjson.gz");
    const live = join(stateDir, "ledger.ndjson");
    const assignment = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    writeFileSync(old, assignment);
    writeFileSync(live, row({ ts: "2026-09-26T11:00:00.000Z", step: "cycle.heartbeat" }));
    const initial = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(initial.state, "complete");
    unlinkSync(old);
    const lost = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(lost.state, "unavailable");
    assert.equal(lost.snapshot.reason, "retired-source-evidence-not-reconciled");
    assert.equal(lost.snapshot.lastGoodAt, initial.snapshot.asOf);

    writeFileSync(successor, gzipSync(assignment));
    const reconciled = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(reconciled.state, "complete");
    assert.equal(reconciled.snapshot.sourceRows.assignments, 1);
    assert.equal(reconciled.snapshot.sourceLineage.some((source) => source.form === "gzip"), true);
    assert.equal(reconciled.snapshot.sourceLineage.some((source) => source.name === "ledger.ndjson"), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts refuse unproven live rewrites and recover a completed torn tail", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-live-cursor-"));
  try {
    const live = join(stateDir, "ledger.ndjson");
    const assignment = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    writeFileSync(live, assignment);
    const initial = await runBenchmarkCohortPass(stateDir);
    assert.equal(initial.snapshot.cohorts[0].dimensions.model, "gpt-5-nano");
    const corrected = assignment.replace("gpt-5-nano", "gpt-6-luna");
    const attempt = row({ ts: "2026-09-26T11:01:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a1", success: true });
    writeFileSync(live, corrected + attempt);
    const rewritten = await runBenchmarkCohortPass(stateDir);
    assert.equal(rewritten.state, "unavailable", "a raw rewrite loses the prior assignment without a successor receipt");
    assert.equal(rewritten.snapshot.reason, "retired-source-evidence-not-reconciled");
    assert.equal(rewritten.snapshot.cohorts[0].dimensions.model, "gpt-5-nano",
      "an unproven edit cannot silently relabel prior model evidence");

    writeFileSync(live, assignment + attempt);
    const restored = await runBenchmarkCohortPass(stateDir);
    assert.equal(restored.state, "complete");
    assert.equal(restored.snapshot.sourceRows.assignments, 1);

    const later = row({ ts: "2026-09-26T11:02:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a1", success: false });
    writeFileSync(live, assignment + attempt + later.slice(0, 12));
    const torn = await runBenchmarkCohortPass(stateDir);
    assert.equal(torn.state, "complete", "complete lines remain eligible while the torn tail waits");
    assert.equal(torn.snapshot.liveWatermark?.tailPendingBytes, 12);
    writeFileSync(live, assignment + attempt + later);
    const completed = await runBenchmarkCohortPass(stateDir);
    assert.equal(completed.state, "complete", JSON.stringify({ reason: completed.snapshot.reason,
      scannedSources: completed.scannedSources, pendingSources: completed.pendingSources,
      watermark: completed.snapshot.liveWatermark }));
    assert.equal(completed.snapshot.cohorts[0].workerCallFailure, 1);
    assert.equal(completed.snapshot.sourceRows.assignments, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark live rewrites and restorations are checked even when size and mtime match", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-equal-generation-"));
  try {
    const live = join(stateDir, "ledger.ndjson");
    const assignment = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const attempt = row({ ts: "2026-09-26T11:01:00.000Z", step: "worker.attempt",
      selection_assignment_id: "a1", success: true });
    const stamp = new Date("2026-09-26T12:00:00.000Z");
    const write = (text: string) => { writeFileSync(live, text); utimesSync(live, stamp, stamp); return statSync(live); };
    const first = write(assignment + attempt);
    const initial = await runBenchmarkCohortPass(stateDir);
    assert.equal(initial.state, "complete");
    const cached = await runBenchmarkCohortPass(stateDir);
    assert.equal(cached.state, "complete");
    assert.equal(cached.scannedSources, 0, "an unchanged prefix still uses the existing projection");
    const corrected = assignment.replace("gpt-5-nano", "gpt-6-luna") + attempt;
    const rewrittenStat = write(corrected);
    assert.equal(first.size, rewrittenStat.size, "different bytes share the same actual size");
    assert.equal(first.mtimeMs, rewrittenStat.mtimeMs, "the file really has the same actual mtime");
    assert.notEqual(readFileSync(live, "utf8"), assignment + attempt, "a real rewrite is present");
    const rewritten = await runBenchmarkCohortPass(stateDir);
    assert.equal(rewritten.state, "unavailable", "metadata equality cannot authorize changed evidence");
    assert.equal(rewritten.snapshot.reason, "retired-source-evidence-not-reconciled");
    assert.equal(rewritten.snapshot.cohorts[0].dimensions.model, "gpt-5-nano");
    const restoredStat = write(assignment + attempt);
    assert.equal(restoredStat.size, rewrittenStat.size);
    assert.equal(restoredStat.mtimeMs, rewrittenStat.mtimeMs);
    const restored = await runBenchmarkCohortPass(stateDir);
    assert.equal(restored.state, "complete", "restored bytes are actually rescanned, not left indefinitely partial");
    assert.equal(restored.scannedSources, 1);
    assert.equal(restored.snapshot.sourceRows.assignments, 1);
    assert.equal(restored.snapshot.cohorts[0].joinedAttempts, 1);
    assert.equal(readFileSync(live, "utf8"), assignment + attempt, "the reader never repairs source bytes itself");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cached live verification preserves evidence when its real source disappears", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-cache-read-refused-"));
  try {
    const live = join(stateDir, "ledger.ndjson");
    const assignment = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    writeFileSync(live, assignment);
    const initial = await runBenchmarkCohortPass(stateDir);
    assert.equal(initial.state, "complete");
    const checkpoint = join(stateDir, "benchmark-cohort-index.json");
    const saved = readFileSync(checkpoint, "utf8");
    const missing = await runBenchmarkCohortPass(stateDir, { onBeforeLiveCacheVerify: () => unlinkSync(live) });
    assert.equal(missing.state, "unavailable");
    assert.equal(missing.snapshot.reason, "ledger-live-missing-before-scan");
    assert.equal(missing.snapshot.lastGoodAt, initial.snapshot.asOf);
    assert.equal(missing.snapshot.sourceRows.assignments, 1, "last good evidence is retained, never an invented empty ledger");
    assert.equal(missing.scannedSources, 0);
    assert.equal(missing.pendingSources, 1);
    assert.equal(readFileSync(checkpoint, "utf8"), saved, "an unreadable cache check cannot overwrite the checkpoint");
    writeFileSync(live, assignment);
    assert.equal((await runBenchmarkCohortPass(stateDir)).state, "complete");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cached empty live evidence still requires an existing regular source", async () => {
  for (const replacement of ["missing", "directory"] as const) {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-empty-cache-refused-"));
    try {
      const live = join(stateDir, "ledger.ndjson");
      writeFileSync(live, "");
      const initial = await runBenchmarkCohortPass(stateDir);
      assert.equal(initial.state, "complete");
      assert.equal(initial.snapshot.sourceLineage.length, 1, "a real empty source was audited");
      const checkpoint = join(stateDir, "benchmark-cohort-index.json");
      const saved = readFileSync(checkpoint, "utf8");
      const missing = await runBenchmarkCohortPass(stateDir, { onBeforeLiveCacheVerify: () => {
        unlinkSync(live);
        if (replacement === "directory") mkdirSync(live);
      } });
      assert.equal(missing.state, "unavailable", `${replacement} source is not verified empty evidence`);
      assert.equal(missing.snapshot.reason, replacement === "missing" ? "ledger-live-missing-before-scan" : "ledger-live-invalid-before-scan");
      assert.equal(missing.pendingSources, 1);
      assert.equal(readFileSync(checkpoint, "utf8"), saved);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }
});

test("benchmark cached live failures retain bounded missing denied invalid and unknown reasons", async () => {
  const source = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
  // Actual disappearing/non-file source controls above cover ENOENT and invalid.
  // Inject the remaining error arms without changing filesystem permissions or
  // assuming root/platform permissions; the source and cached projection are real.
  const failures = [
    { error: Object.assign(new Error("private source path and token"), { code: "EACCES" }), reason: "ledger-live-denied-before-scan" },
    { error: Object.assign(new Error("private source path and token"), { code: "EPERM" }), reason: "ledger-live-denied-before-scan" },
    { error: Object.assign(new Error("private source path and token"), { code: "EIO" }), reason: "ledger-live-unreadable-before-scan" },
    { error: null, reason: "ledger-live-unreadable-before-scan" },
  ];
  for (const failure of failures) {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-cache-error-class-"));
    try {
      writeFileSync(join(stateDir, "ledger.ndjson"), source);
      const initial = await runBenchmarkCohortPass(stateDir);
      assert.equal(initial.state, "complete");
      const checkpoint = join(stateDir, "benchmark-cohort-index.json");
      const saved = readFileSync(checkpoint, "utf8");
      const refused = await runBenchmarkCohortPass(stateDir, { onBeforeLiveCacheVerify: () => { throw failure.error; } });
      assert.equal(refused.state, "unavailable");
      assert.equal(refused.snapshot.reason, failure.reason);
      assert.equal(refused.snapshot.lastGoodAt, initial.snapshot.asOf);
      assert.equal(refused.snapshot.sourceRows.assignments, 1);
      assert.equal(refused.pendingSources, 1);
      assert.equal(JSON.stringify(refused).includes("private source path and token"), false);
      assert.equal(readFileSync(checkpoint, "utf8"), saved);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }
});

test("benchmark cohorts distinguish an unreadable state root from a ledger with no sources", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-empty-"));
  try {
    const empty = await runBenchmarkCohortPass(stateDir);
    assert.equal(empty.state, "unavailable");
    assert.equal(empty.snapshot.reason, "ledger-source-missing");
    const unreadable = await runBenchmarkCohortPass(join(stateDir, "does-not-exist"));
    assert.equal(unreadable.state, "unavailable");
    assert.equal(unreadable.snapshot.reason, "ledger-source-unreadable");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohorts quarantine a malformed source while continuing to audit later evidence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-fault-progress-"));
  try {
    const badPath = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const goodPath = join(stateDir, "ledger.2026-09-26T12-00-00-000Z.ndjson");
    const older = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const newer = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a2", selected: { provider: "codex", model: "gpt-6-sol" } } });
    writeFileSync(badPath, gzipSync(older + "{malformed\n"));
    writeFileSync(goodPath, newer);
    const partial = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(partial.state, "partial");
    assert.equal(partial.pendingSources, 1);
    const audited = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(audited.state, "unavailable");
    assert.equal(audited.snapshot.reason, "ledger-source-malformed");
    assert.equal(audited.scannedSources, 1, "a bad old archive does not starve later sources");
    const checkpoint = JSON.parse(readFileSync(join(stateDir, "benchmark-cohort-index.json"), "utf8"));
    assert.equal(checkpoint.sources.length, 1);
    assert.equal(checkpoint.sources[0].name, "ledger.2026-09-26T12-00-00-000Z.ndjson");
    assert.equal(checkpoint.sourceFaults[0].name, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const stable = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(stable.state, "unavailable");
    assert.equal(stable.scannedSources, 0, "the unchanged bad source is not retried every daemon tick");

    writeFileSync(badPath, gzipSync(older));
    const recovered = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(recovered.state, "complete");
    assert.equal(recovered.snapshot.sourceRows.assignments, 2);
    assert.equal(recovered.snapshot.sourceLineage.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("benchmark cohort quarantines malformed source and keeps clean windows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-bounded-fault-"));
  try {
    const bad = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const good = join(stateDir, "ledger.2026-09-27T12-00-00-000Z.ndjson");
    const beforeId = "73c51838-05b9-4d44-8987-f02610fb7268";
    const afterId = "0aa02d38-05b9-4d44-8987-f02610fb7268";
    const archived = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: beforeId, selected: { provider: "cash", model: "gpt-5-nano" } } })
      + '{"ts":"2026-09-25T11:01:00.000Z","step":"worker.attempt",BAD}\n';
    writeFileSync(bad, gzipSync(archived));
    utimesSync(bad, new Date("2026-09-25T12:00:00.000Z"), new Date("2026-09-25T12:00:00.000Z"));
    writeFileSync(good, row({ ts: "2026-09-27T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: afterId, selected: { provider: "cash", model: "gpt-6-luna" } } })
      + row({ ts: "2026-09-27T11:01:00.000Z", step: "worker.attempt", selection_assignment_id: afterId,
        success: true, billing_mode: "api", total_cost_usd: 0.02 }));
    const result = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(result.state, "quarantined");
    assert.equal(result.snapshot.state, "observed-partial");
    assert.equal(result.snapshot.cohorts.length, 1);
    assert.equal(result.snapshot.cohorts[0].dimensions.model, "gpt-6-luna");
    assert.equal(result.snapshot.cohorts[0].workerCallSuccess, 1);
    assert.equal(result.snapshot.coverage.workerCall.denominator, 1);
    assert.equal(result.snapshot.quarantine?.excludedAssignments, 0);
    assert.equal(result.snapshot.quarantine?.sources[0].malformedRows, 1);
    assert.equal(result.snapshot.quarantine?.sources[0].maxTimestamp, "2026-09-25T11:01:00.000Z");
    assert.equal(readFileSync(bad).equals(gzipSync(archived)), true, "the projection does not rewrite raw evidence");
    const memoized = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(memoized.state, "quarantined");
    assert.equal(memoized.scannedSources, 0, "unchanged bad evidence is not replayed on every daemon tick");
    utimesSync(bad, new Date("2026-09-28T12:00:00.000Z"), new Date("2026-09-28T12:00:00.000Z"));
    const laterWrite = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(laterWrite.state, "unavailable", "a later archive write invalidates the clean suffix");
    assert.equal(laterWrite.snapshot.cohorts.length, 0);
    assert.equal(laterWrite.snapshot.quarantine?.excludedAssignments, 1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort excludes joins crossing a quarantined source", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-unbounded-fault-"));
  try {
    const bad = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const good = join(stateDir, "ledger.2026-09-27T12-00-00-000Z.ndjson");
    const id = "0aa02d38-05b9-4d44-8987-f02610fb7268";
    writeFileSync(bad, gzipSync('{"step":"worker.attempt",BAD}\n'));
    writeFileSync(good, row({ ts: "2026-09-27T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id, selected: { provider: "cash", model: "gpt-6-luna" } } }));
    const result = await runBenchmarkCohortPass(stateDir, { maxSources: 2 });
    assert.equal(result.state, "unavailable");
    assert.equal(result.snapshot.cohorts.length, 0, "an unbounded fault cannot contribute a model denominator");
    assert.equal(result.snapshot.quarantine?.sources[0].maxTimestamp, null);
    assert.equal(result.snapshot.quarantine?.excludedAssignments, 1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort retains dated last good during faulty partial replay", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-fault-transition-"));
  try {
    const archive = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const later = join(stateDir, "ledger.2026-09-26T12-00-00-000Z.ndjson");
    const old = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "old", selected: { provider: "cash", model: "gpt-5-nano" } } });
    const newer = row({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "new", selected: { provider: "cash", model: "gpt-6-luna" } } });
    writeFileSync(archive, gzipSync(old));
    writeFileSync(later, newer);
    const baseline = await runBenchmarkCohortPass(stateDir, { maxSources: 2, nowIso: "2026-09-26T12:00:00.000Z" });
    assert.equal(baseline.state, "complete");
    writeFileSync(archive, gzipSync(old + '{"ts":"2026-09-25T11:01:00.000Z",BAD}\n'));
    writeFileSync(later, newer + row({ ts: "2026-09-26T11:02:00.000Z", step: "cycle.heartbeat" }));
    const pending = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(pending.state, "partial");
    assert.equal(pending.snapshot.lastGoodAt, baseline.snapshot.asOf);
    const settled = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(settled.state, "unavailable");
    assert.equal(settled.snapshot.lastGoodAt, baseline.snapshot.asOf,
      "a fault arriving during replay must not erase the dated healthy baseline");
    assert.equal(settled.snapshot.cohorts.length, 0);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("benchmark cohort repairs a quarantined source without raw deletion", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-fault-repair-"));
  try {
    const older = join(stateDir, "ledger.2026-09-25T10-30-00-000Z.ndjson");
    const bad = join(stateDir, "ledger.2026-09-25T12-00-00-000Z.ndjson.gz");
    const good = join(stateDir, "ledger.2026-09-27T12-00-00-000Z.ndjson");
    const id = "0aa02d38-05b9-4d44-8987-f02610fb7268";
    const assignment = row({ ts: "2026-09-27T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id, selected: { provider: "cash", model: "gpt-6-luna" } } });
    writeFileSync(older, row({ ts: "2026-09-25T10:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "older", selected: { provider: "cash", model: "gpt-5-nano" } } }));
    writeFileSync(bad, gzipSync('{"ts":"2026-09-25T11:00:00.000Z",BAD}\n'));
    utimesSync(bad, new Date("2026-09-25T12:00:00.000Z"), new Date("2026-09-25T12:00:00.000Z"));
    writeFileSync(good, assignment);
    const partial = await runBenchmarkCohortPass(stateDir, { maxSources: 3 });
    assert.equal(partial.state, "quarantined");
    assert.equal(partial.snapshot.pressure.rebuiltPartitions, 1);
    assert.equal(partial.snapshot.quarantine?.excludedAssignments, 1);
    const corrected = row({ ts: "2026-09-25T11:00:00.000Z", step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } });
    writeFileSync(bad, gzipSync(corrected));
    const repaired = await runBenchmarkCohortPass(stateDir, { maxSources: 1 });
    assert.equal(repaired.state, "complete");
    assert.equal(repaired.snapshot.cohorts.length, 2);
    assert.equal(repaired.snapshot.pressure.rebuiltPartitions, 1, "unaffected clean cohort is reused");
    assert.equal(repaired.snapshot.cohorts.find((cohort) => cohort.dimensions.model === "gpt-5-nano")?.assignments, 2,
      "repair releases a formerly excluded clean assignment in the affected partition");
    assert.equal(readFileSync(bad).equals(gzipSync(corrected)), true);
    assert.equal(repaired.snapshot.quarantine, undefined);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("W1-T13867 criterion 1: every cohort row carries its calls' verified task outcomes, or the named reason no join exists", async () => {
  const cutoff = "2026-09-27T23:00:00.000Z";
  const sha = "a".repeat(40);
  const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
  const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };
  const at = (i: number, seconds = 0) => `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
  // Model and PR state per assignment; no `pr` = no case file for that task.
  // `noCall`: the assignment was written but no worker call followed it.
  const cases: { model: string; pr?: "MERGED" | "CLOSED" | "OPEN"; noCall?: true }[] = [
    { model: "gpt-luna", pr: "MERGED" }, { model: "gpt-luna", pr: "CLOSED" }, { model: "gpt-luna", pr: "OPEN" },
    { model: "gpt-luna" }, { model: "claude-opus", pr: "MERGED" }, { model: "claude-opus", pr: "MERGED" },
    { model: "claude-opus", pr: "MERGED", noCall: true },
  ];
  const caseFiles: TaskCaseFile[] = cases.flatMap(({ model, pr }, i) => pr === undefined ? [] : [{
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
  } as TaskCaseFile]);
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-benchmark-call-outcome-"));
  try {
    writeFileSync(join(stateDir, "ledger.ndjson"), cases.map(({ model, noCall }, i) => row({ ts: at(i), host: "core-host",
      task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.assignment",
      worker_assignment: { id: `assign-${i}`, requested: { model }, selected: { provider: "codex", model } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } } } })
      + (noCall ? "" : row({ ts: at(i, 30), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`, step: "worker.attempt",
        selection_assignment_id: `assign-${i}`, success: true, billing_mode: "api", total_cost_usd: 0.02 }))).join(""));
    // Each pass's rows come from the same join as that pass's own cohort-level total: both joined, or both unavailable.
    const agrees = (snapshot: Awaited<ReturnType<typeof runBenchmarkCohortPass>>["snapshot"], label: string): void => {
      for (const cohort of snapshot.cohorts) assert.equal(typeof cohort.verifiedOutcome === "string",
        typeof snapshot.verifiedTaskOutcome === "string", `${label}: a row and its snapshot's total agree on whether a join exists`);
    };
    const joined = (await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, caseFiles })).snapshot;
    const byModel = Object.fromEntries(joined.cohorts.map((cohort) => [cohort.dimensions.model, cohort]));
    assert.deepEqual(Object.keys(byModel).sort(), ["claude-opus", "gpt-luna"]);
    for (const cohort of joined.cohorts) {
      assert.notEqual(typeof cohort.verifiedOutcome, "string", "case files were joined, so no row may name the no-join reason");
      const outcome = cohort.verifiedOutcome as Exclude<typeof cohort.verifiedOutcome, string>;
      assert.equal(outcome.assignments, cohort.joinedAttempts, "every call in the row is accounted for, and only calls");
      assert.equal(outcome.completed + outcome.endedWithoutCompletion + outcome.censored + outcome.unavailable, outcome.assignments);
    }
    const luna = byModel["gpt-luna"]!.verifiedOutcome as Exclude<BenchmarkCohort["verifiedOutcome"], string>;
    assert.equal(luna.completed, 1); assert.equal(luna.censored, 1); assert.equal(luna.unavailable, 2);
    assert.equal(Object.values(luna.reasons).reduce((sum, count) => sum + count, 0), luna.endedWithoutCompletion + luna.unavailable + luna.censored,
      "each call not completed names why");
    assert.ok(luna.reasons["closed-unmerged-unadjudicated"] === 1, "a closed PR names its reason");
    assert.equal(luna.reasons["open-at-cutoff"], 1, "a censored call names why it is not completed");
    assert.equal(byModel["claude-opus"]!.assignments, 3, "positive control: the row holds the assignment that made no call");
    assert.deepEqual(byModel["claude-opus"]!.verifiedOutcome, { assignments: 2, completed: 2, endedWithoutCompletion: 0,
      censored: 0, unavailable: 0, reasons: {} }, "an assignment with no worker call is not a call, so no outcome counts it");
    agrees(joined, "joined");
    const totals = joined.verifiedTaskOutcome as Exclude<typeof joined.verifiedTaskOutcome, string>;
    assert.equal(totals.coverage.completed, 4, "the cohort-level join is unchanged: it counts assignments, the no-call one included");
    // The joined pass left its rows in the index on disk. A later pass reads that index (scannedSources 0).
    const indexPath = join(stateDir, "benchmark-cohort-index.json");
    const onDisk = (): unknown => (JSON.parse(readFileSync(indexPath, "utf8")) as { lastGood: { cohorts: BenchmarkCohort[] } })
      .lastGood.cohorts.map((cohort) => cohort.verifiedOutcome);
    assert.deepEqual(onDisk(), joined.cohorts.map((cohort) => cohort.verifiedOutcome));
    // A cached pass reports what a fresh pass with the same case files and cutoff reports, rows and totals alike.
    // Without case files that is the unavailable reason: the earlier join is never reported as this pass's own.
    const cached = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff });
    assert.equal(cached.scannedSources, 0, "positive control: this pass is a cache hit");
    rmSync(indexPath, { force: true }); // a fresh pass, with no cached snapshot
    const unjoined = (await runBenchmarkCohortPass(stateDir, { nowIso: cutoff })).snapshot;
    assert.equal(unjoined.cohorts.length, 2);
    for (const cohort of unjoined.cohorts) assert.equal(cohort.verifiedOutcome, "unavailable-no-github-verification-join");
    assert.equal(unjoined.verifiedTaskOutcome, "unavailable-no-github-verification-join", "a fresh pass with no case files joins nothing");
    agrees(unjoined, "fresh without case files");
    assert.deepEqual(cached.snapshot.cohorts.map((cohort) => cohort.verifiedOutcome), unjoined.cohorts.map((cohort) => cohort.verifiedOutcome),
      "cached and fresh rows agree without case files");
    assert.deepEqual(cached.snapshot.verifiedTaskOutcome, unjoined.verifiedTaskOutcome, "cached and fresh totals agree without case files");
    agrees(cached.snapshot, "cached without case files");
    // A cached pass WITH case files over an index written without them reports what the fresh joined pass did, and
    // publishes those rows to the index on disk.
    const rejoined = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, caseFiles });
    assert.equal(rejoined.scannedSources, 0, "positive control: this pass is a cache hit");
    assert.deepEqual(rejoined.snapshot.cohorts.map((cohort) => cohort.verifiedOutcome), joined.cohorts.map((cohort) => cohort.verifiedOutcome));
    assert.deepEqual(rejoined.snapshot.verifiedTaskOutcome, joined.verifiedTaskOutcome);
    assert.deepEqual(onDisk(), joined.cohorts.map((cohort) => cohort.verifiedOutcome), "the cache hit publishes its rows");
    agrees(rejoined.snapshot, "cached with case files");
    const again = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, caseFiles });
    assert.equal(again.checkpointBytes, undefined, "an unchanged cache hit writes nothing");
    // A cache hit's rewrite yields to a newer index another pass published after this one read: it neither
    // replaces that index nor retires the segment it names.
    const joinedOnDisk = onDisk();
    const concurrentSegment = join(stateDir, "benchmark-cohort-segment-concurrent-0.ndjson");
    const yielded = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, onBeforeLiveCacheVerify: () => {
      writeFileSync(concurrentSegment, "");
      const newer = { ...(JSON.parse(readFileSync(indexPath, "utf8")) as object), concurrentRebuild: true };
      writeFileSync(`${indexPath}.concurrent.tmp`, JSON.stringify(newer));
      renameSync(`${indexPath}.concurrent.tmp`, indexPath);
    } });
    assert.equal(yielded.scannedSources, 0, "positive control: this pass is a cache hit");
    for (const cohort of yielded.snapshot.cohorts) assert.equal(cohort.verifiedOutcome, "unavailable-no-github-verification-join");
    assert.equal((JSON.parse(readFileSync(indexPath, "utf8")) as { concurrentRebuild?: boolean }).concurrentRebuild, true,
      "the newer index stays published");
    assert.equal(existsSync(concurrentSegment), true, "the newer index's segment is not retired");
    assert.equal(yielded.checkpointBytes, undefined, "no write is claimed for a rewrite that yielded");
    // A pass that stops before joining, here because the live ledger vanished, names the unavailable reason in its
    // rows and total, and leaves no earlier join on disk.
    assert.deepEqual(onDisk(), joinedOnDisk, "positive control: the index on disk still holds the earlier join");
    const stopped = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff,
      onBeforeLiveCacheVerify: () => rmSync(join(stateDir, "ledger.ndjson")) });
    assert.equal(stopped.state, "unavailable");
    assert.equal(stopped.snapshot.reason, "ledger-live-missing-before-scan");
    assert.equal(stopped.snapshot.cohorts.length, 2, "the carried rows are still reported");
    for (const cohort of stopped.snapshot.cohorts) assert.equal(cohort.verifiedOutcome, "unavailable-no-github-verification-join");
    assert.equal(stopped.snapshot.verifiedTaskOutcome, "unavailable-no-github-verification-join");
    agrees(stopped.snapshot, "stopped before joining");
    assert.deepEqual(onDisk(), stopped.snapshot.cohorts.map(() => "unavailable-no-github-verification-join"),
      "the index on disk no longer holds the earlier join");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
