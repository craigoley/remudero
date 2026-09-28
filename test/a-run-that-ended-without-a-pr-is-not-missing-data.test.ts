// test/a-run-that-ended-without-a-pr-is-not-missing-data.test.ts — W1-T4648: a run whose PR read
// SUCCEEDED and found no PR, and whose ledger carries a terminal verdict, is an observed ending
// (`ended-without-completion`), never `current-pr-unavailable` beside a real GitHub read failure —
// and never a model failure either. Every timestamp is compared only against the injected asOf/cutoff.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aaArmFor, buildBenchmarkAaReport, parseAaTrialManifest, readAaLedgerEvidence } from "../src/lib/benchmark-aa.js";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "../src/lib/benchmark-verified-outcome.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";
import { buildTaskCaseFile, type CaseLedgerRead, type CasePrRead, type TaskCaseFile } from "../src/lib/task-case-file.js";

const NOW = "2026-09-28T12:10:00.000Z";
const SHA = "a".repeat(40);
type Row = Record<string, unknown>;

// The two PR reads the case-file command can record when no PR is observed: the read SUCCEEDED and the
// projection holds none (`report-commands.ts`'s own reason), or the GitHub read itself FAILED.
const readFoundNoPr: CasePrRead = { state: "unavailable", reason: "no-pr-in-current-projection" };
const readFailed: CasePrRead = { state: "unavailable", reason: "github-read-failed:Error" };
const noPrProjection = (taskId: string) => ({ taskId, status: "queued", merged: false, source: "none" }) as StatusProjection;

const taskOf = (id: string) => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "low", status: "queued", attempts: 0 }) as unknown as Task;
const ledger = (rows: Row[]): CaseLedgerRead => ({ state: "observed", rows, asOf: NOW,
  windowStart: "2026-08-29T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, unread: [], malformed: 0, truncated: false });

/** One run's own ledger rows as the case file reads them: start, assignment, and (optionally) a verdict. */
function runLedger(taskId: string, n: number, verdict: string | null): Row[] {
  const row = (step: string, rest: Row) => ({ ts: "2026-09-28T11:00:00.000Z", task_id: taskId, run_id: `${taskId}-${n}`, step, ...rest });
  return [row("run.start", {}),
    row("worker.assignment", { worker_assignment: { id: `${taskId}-a${n}`, selected: { provider: "claude", model: "claude-sonnet-5" } } }),
    ...(verdict === null ? [] : [row("verdict", { selection_assignment_id: `${taskId}-a${n}`, verdict })])];
}

const caseFile = (taskId: string, verdict: string | null, prRead: CasePrRead): TaskCaseFile =>
  buildTaskCaseFile({ task: taskOf(taskId), projection: noPrProjection(taskId), ledger: ledger(runLedger(taskId, 1, verdict)), prRead, asOf: NOW });

const assignmentOf = (taskId: string): VerifiedAssignment => ({ assignmentId: `${taskId}-a1`, taskId, runId: `${taskId}-1`,
  assignedAt: "2026-09-28T11:00:00.000Z", taskClass: "fix", selectedModel: "claude-sonnet-5", servedModel: "claude-sonnet-5",
  billingMode: "subscription", costUsd: 0.5, attempted: true });

test("a no_pr or failed run whose projection holds no PR reads ended-without-completion with its verdict named", () => {
  for (const verdict of ["no_pr", "failed", "blocked_budget"]) {
    const file = caseFile("FX-T1", verdict, readFoundNoPr);
    assert.equal(file.pr.state === "unavailable" && file.pr.reason, "no-pr-in-current-projection", "the builder's own marker");
    const result = joinVerifiedTaskOutcomes([assignmentOf("FX-T1")], [file], NOW);
    assert.equal(result.coverage.endedWithoutCompletion, 1, verdict);
    assert.equal(result.coverage.unavailable, 0, `${verdict} is observed, not missing`);
    assert.equal(result.coverage.completed, 0, `${verdict} is never completion`);
    assert.deepEqual(result.coverage.reasons, { [`ended-without-pr:${verdict}`]: 1 });
    assert.equal(result.groups[0]!.endedWithoutCompletion, 1);
    assert.equal(result.state, "observed", "an observed ending is an observation");
  }
});

test("a FAILED PR read with a no_pr verdict still reads current-pr-unavailable, never an ending", () => {
  const result = joinVerifiedTaskOutcomes([assignmentOf("FX-T1")], [caseFile("FX-T1", "no_pr", readFailed)], NOW);
  assert.equal(result.coverage.endedWithoutCompletion, 0);
  assert.equal(result.coverage.unavailable, 1);
  assert.deepEqual(result.coverage.reasons, { "current-pr-unavailable": 1 });
  assert.equal(result.state, "unavailable");
});

test("a run with no terminal verdict, an unrecognized one, a completion verdict or its own PR stays unavailable", () => {
  const read = (file: TaskCaseFile) => joinVerifiedTaskOutcomes([assignmentOf(file.taskId)], [file], NOW).coverage;
  assert.deepEqual(read(caseFile("FX-T1", null, readFoundNoPr)).reasons, { "run-without-terminal-verdict": 1 });
  assert.deepEqual(read(caseFile("FX-T1", "passed", readFoundNoPr)).reasons, { "run-verdict-unrecognized": 1 });
  for (const verdict of ["merged", "already_satisfied", "awaiting_merge", "task_already_merged", "pr_attribution_failed"])
    assert.deepEqual(read(caseFile("FX-T1", verdict, readFoundNoPr)).reasons, { "current-pr-unavailable": 1 }, verdict);
  const opened = caseFile("FX-T1", "failed", readFoundNoPr);
  const ownPr = { ...opened, runs: opened.runs.map((run) => ({ ...run, prNumber: 7 })) };
  assert.deepEqual(read(ownPr).reasons, { "current-pr-unavailable": 1 }, "a run that opened a PR the projection lacks is not an ending");
});

test("assignments = completed + endedWithoutCompletion + censored + unavailable, overall and per group", () => {
  const files = [caseFile("FX-T1", "no_pr", readFoundNoPr), caseFile("FX-T2", "failed", readFoundNoPr),
    caseFile("FX-T3", "no_pr", readFailed), caseFile("FX-T4", null, readFoundNoPr)];
  const result = joinVerifiedTaskOutcomes(["FX-T1", "FX-T2", "FX-T3", "FX-T4", "FX-T5"].map(assignmentOf), files, NOW);
  const { coverage } = result;
  assert.equal(coverage.assignments, 5);
  assert.equal(coverage.completed + coverage.endedWithoutCompletion + coverage.censored + coverage.unavailable, coverage.assignments);
  assert.equal(coverage.endedWithoutCompletion, 2);
  assert.equal(coverage.unavailable, 3);
  assert.equal(Object.values(coverage.reasons).reduce((sum, n) => sum + n, 0), coverage.endedWithoutCompletion + coverage.unavailable,
    "reasons name every assignment neither completed nor censored");
  assert.equal(coverage.reasons["case-file-missing"], 1);
  assert.equal(result.state, "observed-partial");
  for (const group of result.groups)
    assert.equal(group.completed + group.endedWithoutCompletion + group.censored + group.unavailable, group.assignments);
});

// ── the A/A: an ending is observed, reported per arm, and never a failure ──

function manifestOf(taskCount: number) {
  const parsed = parseAaTrialManifest({
    version: "benchmark-aa-trial-v1", trialId: "aa-fixture-1", cohort: { kind: "public-fixture" },
    stack: { provider: "claude", model: "claude-sonnet-5", effort: "high", harnessRevision: SHA, promptRevision: SHA,
      toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA },
    strataRevision: "strata-v1",
    tasks: Array.from({ length: taskCount }, (_, i) => ({ taskId: `FX-T${i + 1}`, taskClass: "fix", risk: "low" })),
    protocolText: "A/A: identical arms, verified completion, task unit.\n", preRegisteredAt: "2026-09-01T00:00:00.000Z",
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.manifest;
}

/** The A/A's own receipts for one run: assignment, attempt and terminal, on the pinned stack. */
function aaRows(taskId: string, minute: number): Row[] {
  const ts = (s: number) => `2026-09-28T11:${String(minute).padStart(2, "0")}:0${s}.000Z`;
  const pin = { state: "observed", value: SHA };
  const assignment = { ts: ts(0), step: "worker.assignment", task_id: taskId, run_id: `${taskId}-1`,
    worker_assignment: { id: `${taskId}-a1`, selected: { provider: "claude", model: "claude-sonnet-5", effort: "high" } },
    benchmark_run: { work: { taskClass: { state: "observed", value: "fix" }, risk: { state: "observed", value: "low" } },
      stack: { harnessRevision: pin, promptRevision: pin, toolRevision: pin, scorerRevision: pin, environmentRevision: pin },
      allocation: { method: "observational" } } };
  const call = (step: string, s: number) => ({ ts: ts(s), step, task_id: taskId, run_id: `${taskId}-1`,
    selection_assignment_id: `${taskId}-a1`, success: false, served_model: "claude-sonnet-5", billing_mode: "subscription",
    total_cost_usd: 0.5, tokens: { input: 10, output: 5 }, worker_duration_ms: 1000 });
  return [assignment, call("worker.attempt", 1), call("verdict", 2)];
}

test("the A/A counts an ended-without-PR unit as observed per arm, never missing and never failed", async () => {
  const manifest = manifestOf(40);
  const inArm = (label: string) => manifest.tasks.map((task) => task.taskId)
    .filter((id) => aaArmFor(manifest.trialId, id, ["A1", "A2"]) === label);
  const [ended1, ended2] = inArm("A1");
  const [unread] = inArm("A2");
  const dir = mkdtempSync(join(tmpdir(), "rmd-aa-ended-"));
  try {
    mkdirSync(dir, { recursive: true });
    const rows = [...aaRows(ended1!, 1), ...aaRows(ended2!, 2), ...aaRows(unread!, 3)];
    writeFileSync(join(dir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const evidence = await readAaLedgerEvidence(dir, new Set(manifest.tasks.map((task) => task.taskId)));
    const caseFiles = [caseFile(ended1!, "no_pr", readFoundNoPr), caseFile(ended2!, "failed", readFoundNoPr),
      caseFile(unread!, "no_pr", readFailed)];
    const report = buildBenchmarkAaReport({ manifest, evidence, nowIso: NOW, caseFiles });
    const [a1, a2] = [report.arms!.A1!, report.arms!.A2!];
    assert.equal(a1.outcomes.endedWithoutCompletion, 2, "both A1 endings are reported on their arm");
    // Allocated tasks never started stay unavailable as `non-starter`; only exposed units are at issue here.
    assert.equal(a1.outcomes.unavailable, a1.nonStarters, "an observed ending is not missing");
    assert.deepEqual(a1.outcomes.reasons, { "non-starter": a1.nonStarters });
    assert.equal(a1.outcomes.failed, 0, "an ending is not a model failure");
    assert.equal(a2.outcomes.endedWithoutCompletion, 0);
    assert.deepEqual(a2.outcomes.reasons, { "non-starter": a2.nonStarters, "current-pr-unavailable": 1 }, "a failed read stays missing");
    assert.equal(report.maturity.unavailable, a1.nonStarters + a2.nonStarters + 1, "only the failed read joins missingness");
    const incomplete = report.findings.find((item) => item.kind === "verified-join-incomplete");
    assert.equal(incomplete?.detail, "1 exposed units have no verified outcome", "the endings are not unjoined");
    const a1Outcomes = report.evalCardInput!.evidence.outcomes.filter((outcome) => outcome.arm === "A1");
    assert.equal(a1Outcomes.length, a1.allocatedUnits);
    assert.ok(a1Outcomes.every((outcome) => outcome.success === null), "nothing labels an ending a loss");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
