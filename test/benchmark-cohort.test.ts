import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";

const row = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";

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

    const checkpoint = join(stateDir, "benchmark-cohort-v1.json");
    const corrupt = JSON.parse(readFileSync(checkpoint, "utf8"));
    corrupt.sources[0].rows[0].row = null;
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
    assert.equal(completed.state, "complete");
    assert.equal(completed.snapshot.cohorts[0].workerCallFailure, 1);
    assert.equal(completed.snapshot.sourceRows.assignments, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
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
    const checkpoint = JSON.parse(readFileSync(join(stateDir, "benchmark-cohort-v1.json"), "utf8"));
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
