import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBenchmarkCohortPass, runBenchmarkVerifiedOverlayPass } from "../src/lib/benchmark-cohort.js";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "../src/lib/benchmark-verified-outcome.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";

const cutoff = "2026-09-27T12:10:00.000Z";
const sha = "a".repeat(40);
const evidence = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const unavailable = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf: cutoff });
const assignment = (changes: Partial<VerifiedAssignment> = {}): VerifiedAssignment => ({
  assignmentId: "a1", taskId: "W1-T99", runId: "W1-T99-1", assignedAt: "2026-09-27T12:00:00.000Z",
  taskClass: "fix", selectedModel: "gpt-6-luna", servedModel: "gpt-6-sol",
  billingMode: "api", costUsd: 0.02, attempted: true, ...changes,
});
const caseFile = (changes: Partial<TaskCaseFile> = {}): TaskCaseFile => ({
  version: "task-case-file-v1", taskId: "W1-T99", asOf: cutoff,
  plan: evidence({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
  ledger: evidence({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 4 }),
  runs: [{ runId: "W1-T99-1", startedAt: "2026-09-27T11:59:00.000Z", assignmentId: "a1",
    selectedProvider: "cash", selectedModel: "gpt-6-luna", servedModel: "gpt-6-sol",
    billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 123 }],
  pr: evidence({ number: 123, url: "https://github.com/craigoley/remudero/pull/123", headSha: sha,
    state: "MERGED", taskCredit: true }),
  review: evidence({ headSha: sha, status: "success" }),
  acceptance: evidence({ headSha: sha, status: "success" }),
  ci: evidence({ headSha: sha, status: "success" }),
  mergedSource: evidence({ prNumber: 123, mergedAt: "2026-09-27T12:08:00Z" }),
  deployment: unavailable("not-collected"), runtime: unavailable("not-collected"), next: null,
  ...changes,
});

test("verified completion requires exact assignment, run, task, PR and accepted head", () => {
  const result = joinVerifiedTaskOutcomes([assignment()], [caseFile()], cutoff);
  assert.equal(result.coverage.completed, 1);
  assert.equal(result.groups[0].latency.meanMs, 8 * 60_000);
  assert.equal(result.groups[0].cost.apiUsd, 0.02);
  assert.equal(result.groups[0].cost.subscriptionNotionalUsd, 0);
  const missingCost = joinVerifiedTaskOutcomes([assignment({ costUsd: null })], [caseFile()], cutoff);
  assert.equal(missingCost.groups[0].cost.missing, 1, "unknown cost stays visible in coverage");
  assert.equal(missingCost.groups[0].cost.observed, 0);
  assert.equal(result.groups[0].selectedModel, "gpt-6-luna", "served model never replaces selected model");
  assert.equal(result.experimentEffect, "unavailable-no-randomized-allocation");
  assert.equal(JSON.stringify(result).includes("W1-T99"), false, "task IDs stay out of public groups");
});

test("worker success, stale identity and an unaccepted head cannot fabricate a completion", () => {
  const variants: Array<[VerifiedAssignment, TaskCaseFile[], string]> = [
    [assignment({ taskId: null }), [caseFile()], "pre-instrumentation-keys-missing"],
    [assignment({ assignmentId: "wrong" }), [caseFile()], "assignment-run-mismatch"],
    [assignment(), [{ ...caseFile(), asOf: "2026-09-27T11:00:00.000Z" }], "case-file-stale"],
    [assignment(), [caseFile({ acceptance: unavailable("check-missing") })], "head-gates-unverified"],
    [assignment(), [caseFile({ review: evidence({ headSha: "b".repeat(40), status: "success" }) })], "head-gates-unverified"],
    [assignment(), [caseFile({ pr: unavailable("github-read-failed") })], "current-pr-unavailable"],
  ];
  for (const [input, files, reason] of variants) {
    const result = joinVerifiedTaskOutcomes([input], files, cutoff);
    assert.equal(result.coverage.completed, 0, reason);
    assert.equal(result.coverage.unavailable, 1, reason);
    assert.equal(result.coverage.reasons[reason], 1, reason);
  }
});

test("open work is censored; closed unmerged work is unavailable, not a model failure", () => {
  const open = caseFile({ pr: evidence({ number: 123, url: "https://github.com/craigoley/remudero/pull/123",
    headSha: sha, state: "OPEN", taskCredit: false }), mergedSource: unavailable("not-merged") });
  const closed = caseFile({ pr: evidence({ number: 123, url: "https://github.com/craigoley/remudero/pull/123",
    headSha: sha, state: "CLOSED", taskCredit: false }), mergedSource: unavailable("not-merged") });
  const result = joinVerifiedTaskOutcomes([assignment(), assignment({ assignmentId: "a2", runId: "W1-T99-2" })],
    [open], cutoff);
  assert.equal(result.coverage.censored, 1);
  assert.equal(result.coverage.unavailable, 1, "unmatched run cannot borrow another run's open PR");
  assert.equal(joinVerifiedTaskOutcomes([assignment()], [closed], cutoff).coverage.reasons["closed-unmerged-unadjudicated"], 1);
});

test("a freshness hand-off keeps its open PR censored and an unreadable PR unavailable", () => {
  const handedOffRun = { ...caseFile().runs[0]!, verdict: "handed_off" };
  const open = caseFile({ runs: [handedOffRun], pr: evidence({ number: 123,
    url: "https://github.com/craigoley/remudero/pull/123", headSha: sha, state: "OPEN", taskCredit: false }),
    mergedSource: unavailable("not-merged") });
  const openOutcome = joinVerifiedTaskOutcomes([assignment()], [open], cutoff);
  assert.equal(openOutcome.coverage.censored, 1, "the handed-off PR is still pending adjudication");

  const missing = caseFile({ runs: [{ ...handedOffRun, prNumber: null }],
    pr: { state: "unavailable", reason: "no-pr-in-current-projection", source: "github-pr-read", asOf: cutoff },
    mergedSource: unavailable("not-merged") });
  const missingOutcome = joinVerifiedTaskOutcomes([assignment()], [missing], cutoff);
  assert.equal(missingOutcome.coverage.unavailable, 1, "a missing projected PR cannot turn a hand-off into a failure");
  assert.equal(missingOutcome.coverage.reasons["current-pr-unavailable"], 1);
});

test("cohort refreshes the read-only GitHub overlay on a cached ledger without rescanning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verified-outcome-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), [
      { ts: "2026-09-27T12:00:00.000Z", task_id: "W1-T99", run_id: "W1-T99-1", step: "worker.assignment",
        worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-6-luna" } },
        benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } } } },
      { ts: "2026-09-27T12:01:00.000Z", task_id: "W1-T99", run_id: "W1-T99-1", step: "worker.attempt",
        selection_assignment_id: "a1", success: true, billing_mode: "api", total_cost_usd: 0.02 },
    ].map((row) => JSON.stringify(row) + "\n").join(""));
    const initial = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.equal(initial.snapshot.verifiedTaskOutcome, "unavailable-no-github-verification-join");
    const joined = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: [caseFile()] });
    assert.equal(joined.scannedSources, 0);
    assert.equal(typeof joined.snapshot.verifiedTaskOutcome, "object");
    if (typeof joined.snapshot.verifiedTaskOutcome !== "object") return;
    assert.equal(joined.snapshot.verifiedTaskOutcome.coverage.completed, 1);
    const missing = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: [] });
    assert.equal(typeof missing.snapshot.verifiedTaskOutcome, "object");
    if (typeof missing.snapshot.verifiedTaskOutcome !== "object") return;
    assert.equal(missing.snapshot.verifiedTaskOutcome.coverage.reasons["case-file-missing"], 1);
    const snapshotPath = join(dir, "case-files.json");
    writeFileSync(snapshotPath, JSON.stringify([{ ...caseFile(), asOf: new Date().toISOString() }]));
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (line: string) => { output.push(line); };
    try {
      assert.equal(await runBenchmarkVerifiedOverlayPass(dir, snapshotPath), 0);
    } finally { console.log = originalLog; }
    const printed = JSON.parse(output[0]!);
    assert.equal(printed.event, "benchmark_cohort.verified_overlay");
    assert.equal(printed.verified_task_outcome.coverage.completed, 1);
    assert.equal(output[0]!.includes("W1-T99"), false, "analyst output has no private task ID");
    const changedErrors: string[] = [];
    const savedError = console.error;
    console.error = (line: string) => { changedErrors.push(line); };
    try {
      assert.equal(await runBenchmarkVerifiedOverlayPass(dir, snapshotPath, () => writeFileSync(snapshotPath, "{}")), 1);
    } finally { console.error = savedError; }
    assert.equal(JSON.parse(changedErrors[0]!).error_class, "type-error", "a changed open inode cannot become a verified snapshot");
    writeFileSync(snapshotPath, "{}");
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (line: string) => { errors.push(line); };
    try { assert.equal(await runBenchmarkVerifiedOverlayPass(dir, snapshotPath), 1); }
    finally { console.error = originalError; }
    assert.equal(JSON.parse(errors[0]!).reason, "snapshot-unavailable");
    writeFileSync(snapshotPath, " ".repeat(4 * 1024 * 1024 + 1));
    console.error = (line: string) => { errors.push(line); };
    try { assert.equal(await runBenchmarkVerifiedOverlayPass(dir, snapshotPath), 1); }
    finally { console.error = originalError; }
    assert.equal(JSON.parse(errors[1]!).error_class, "type-error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
