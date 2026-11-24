import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readStateCaseFiles, runBenchmarkCohortPass, stateCaseFileSnapshotPath,
  type BenchmarkCohortPassResult, type CohortVerifiedOutcome } from "#src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";

// The daily refresh builds its snapshot hours before the daemon and idle passes read it.
const snapshotAt = "2026-09-27T23:00:00.000Z";
const passAt = "2026-09-28T05:00:00.000Z";
const NO_JOIN = "unavailable-no-github-verification-join";
const sha = "b".repeat(40);
const row = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";
const at = (i: number, seconds = 0) => `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
const notCollected = (asOf: string) => ({ state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf });

function caseFile(i: number, model: string, asOf = snapshotAt): TaskCaseFile {
  const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  return {
    version: "task-case-file-v1", taskId: `W1-T${9100 + i}`, asOf,
    plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
    ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
    runs: [{ runId: `run-${i}`, startedAt: at(i), assignmentId: `assign-${i}`, selectedProvider: "codex", selectedModel: model,
      servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 3000 + i }],
    pr: observed({ number: 3000 + i, url: `https://github.com/craigoley/remudero/pull/${3000 + i}`, headSha: sha,
      state: "MERGED", taskCredit: true }),
    review: observed({ headSha: sha, status: "success" }), acceptance: observed({ headSha: sha, status: "success" }),
    ci: observed({ headSha: sha, status: "success" }),
    mergedSource: observed({ prNumber: 3000 + i, mergedAt: "2026-09-27T22:00:00Z" }),
    deployment: notCollected(asOf), runtime: notCollected(asOf), next: null,
  } as TaskCaseFile;
}

const models = ["gpt-luna", "claude-opus"] as const;

/** Two called tasks with merged PRs, plus one call on the first task made after the snapshot was built. */
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-cohort-snapshot-time-"));
  const assignment = (i: number, task: number, runId: string, ts: string, model: string) =>
    row({ ts, host: "core-host", task_id: `W1-T${9100 + task}`, run_id: runId, step: "worker.assignment",
      worker_assignment: { id: `assign-${i}`, requested: { model }, selected: { provider: "codex", model } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } } } })
    + row({ ts, host: "core-host", task_id: `W1-T${9100 + task}`, run_id: runId, step: "worker.attempt",
      selection_assignment_id: `assign-${i}`, success: true, billing_mode: "api", total_cost_usd: 0.02 });
  writeFileSync(join(stateDir, "ledger.ndjson"), models.map((model, i) => assignment(i, i, `run-${i}`, at(i), model)).join("")
    + assignment(9, 0, "run-late", "2026-09-28T01:00:00.000Z", models[0]));
  const writeCases = (files: TaskCaseFile[]) => {
    mkdirSync(join(stateDir, "field-trials"), { recursive: true });
    writeFileSync(stateCaseFileSnapshotPath(stateDir), JSON.stringify(files));
  };
  return { stateDir, writeCases, close: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const outcomes = (result: BenchmarkCohortPassResult) => result.snapshot.cohorts.map((cohort) => cohort.verifiedOutcome);
const joined = (result: BenchmarkCohortPassResult) => outcomes(result).filter((o): o is CohortVerifiedOutcome => typeof o === "object");
const total = (result: BenchmarkCohortPassResult, key: "assignments" | "completed") =>
  joined(result).reduce((sum, outcome) => sum + outcome[key], 0);
const reasons = (result: BenchmarkCohortPassResult) => joined(result).flatMap((outcome) => Object.keys(outcome.reasons));

test("W1-T14601 criterion 1: a pass hours after the daily snapshot joins its calls at the snapshot's time, never stale", async () => {
  const f = fixture();
  try {
    f.writeCases(models.map((model, i) => caseFile(i, model)));
    const result = await runBenchmarkCohortPass(f.stateDir, { nowIso: passAt, caseFilesFromState: true });
    assert.equal(result.caseFileJoin, "joined");
    assert.equal(result.snapshot.asOf, passAt, "the snapshot itself is still stamped at the pass time");
    assert.equal(total(result, "completed"), 2, "both calls made before the snapshot read completed");
    assert.ok(!reasons(result).includes("case-file-stale"), `no call reads stale: ${reasons(result).join(",")}`);
    // The cached path (no new ledger rows) keeps the same join at the same cutoff.
    const again = await runBenchmarkCohortPass(f.stateDir, { nowIso: "2026-09-28T09:00:00.000Z", caseFilesFromState: true });
    assert.deepEqual(outcomes(again), outcomes(result));
  } finally { f.close(); }
});

test("W1-T14601 criterion 2: every case-file consumer uses the snapshot time, and a later call is never completed", async () => {
  const f = fixture();
  try {
    f.writeCases(models.map((model, i) => caseFile(i, model)));
    const result = await runBenchmarkCohortPass(f.stateDir, { nowIso: passAt, caseFilesFromState: true });
    const verified = result.snapshot.verifiedTaskOutcome;
    assert.equal(typeof verified === "object" && verified.cutoff, snapshotAt);
    assert.equal(result.snapshot.modelDrift.asOf, snapshotAt);
    assert.equal(result.snapshot.selfForecastCalibration.asOf, snapshotAt);
    // Three calls ran; the one made at 01:00Z, after the 23:00Z snapshot, has no run in its task's case file.
    assert.equal(total(result, "assignments"), 3);
    assert.equal(total(result, "completed"), 2);
    assert.ok(reasons(result).includes("run-not-in-case-file"), `the late call is named: ${reasons(result).join(",")}`);
  } finally { f.close(); }
});

test("W1-T14601 criterion 3: a spread or empty snapshot joins nothing and says why; explicit case files keep the pass time", async () => {
  const f = fixture();
  try {
    f.writeCases([caseFile(0, models[0]), caseFile(1, models[1], "2026-09-27T23:15:00.001Z")]);
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "as-of-spread" });
    const spread = await runBenchmarkCohortPass(f.stateDir, { nowIso: passAt, caseFilesFromState: true });
    assert.equal(spread.caseFileJoin, "as-of-spread");
    for (const outcome of outcomes(spread)) assert.equal(outcome, NO_JOIN);
    // Fifteen minutes apart exactly is one time: the join's own bound.
    f.writeCases([caseFile(0, models[0]), caseFile(1, models[1], "2026-09-27T23:15:00.000Z")]);
    const edge = readStateCaseFiles(f.stateDir);
    assert.equal("cutoff" in edge && edge.cutoff, "2026-09-27T23:15:00.000Z");
    f.writeCases([]);
    assert.deepEqual(readStateCaseFiles(f.stateDir), { reason: "empty" });
    assert.equal((await runBenchmarkCohortPass(f.stateDir, { nowIso: passAt, caseFilesFromState: true })).caseFileJoin, "empty");
    // The overlay pass hands its own files in: they are judged at the pass time, as before, so these read stale.
    const explicit = await runBenchmarkCohortPass(f.stateDir,
      { nowIso: passAt, caseFiles: models.map((model, i) => caseFile(i, model)) });
    assert.equal(explicit.caseFileJoin, undefined);
    assert.equal(total(explicit, "completed"), 0);
    assert.ok(reasons(explicit).includes("case-file-stale"));
  } finally { f.close(); }
});
