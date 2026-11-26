/**
 * W1-T14988 — THE COHORT VERIFIED OUTCOME COUNTS ONLY BUILD CALLS.
 *
 * OBSERVED 2026-11-26 on the host (state/benchmark-cohort-index.json at 14:40Z plus all 286 ledger files, deduped): the
 * verified-outcome join counted every worker call, and calls that build nothing (risk-judge 18,000, inbox-draft 10,164,
 * review 9,113, ...) read case-file-missing or run-not-in-case-file, so every model read mostly "unavailable". Only a
 * lane run-task call is now joined; every other call is counted by lane in `nonBuildCalls`, so none is hidden.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runBenchmarkCohortPass, stateCaseFileSnapshotPath, type BenchmarkCohort, type CohortVerifiedOutcome }
  from "#src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const cutoff = "2026-09-27T23:00:00.000Z";
const sha = "a".repeat(40);
const MODEL = "claude-sonnet-5-5";
const at = (i: number, seconds = 0) => `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };

/** Build i's task: merged (completed), closed (unadjudicated) or open (censored). */
function caseFile(i: number, pr: "MERGED" | "CLOSED" | "OPEN"): TaskCaseFile {
  return {
    version: "task-case-file-v1", taskId: `W1-T${9000 + i}`, asOf: cutoff,
    plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
    ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
    runs: [{ runId: `run-${i}`, startedAt: at(i), assignmentId: `assign-${i}`, selectedProvider: "claude", selectedModel: MODEL,
      servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 2000 + i }],
    pr: observed({ number: 2000 + i, url: `https://github.com/craigoley/remudero/pull/${2000 + i}`, headSha: sha, state: pr,
      taskCredit: pr === "MERGED" }),
    review: observed({ headSha: sha, status: "success" }), acceptance: observed({ headSha: sha, status: "success" }),
    ci: observed({ headSha: sha, status: "success" }),
    mergedSource: pr === "MERGED" ? observed({ prNumber: 2000 + i, mergedAt: "2026-09-27T22:00:00Z" }) : notCollected,
    deployment: notCollected, runtime: notCollected, next: null,
  } as TaskCaseFile;
}

const BUILDS = [{ pr: "MERGED", lane: "run-task" }, { pr: "CLOSED", lane: "run-task" }, { pr: "OPEN", lane: "run-task" },
  // A call row from before lane stamping stays a build call.
  { pr: "MERGED", lane: undefined }] as const;
/** Calls that build nothing, each on a task that also has a build, as the host's review and judge calls do. */
const NON_BUILDS = [{ lane: "risk-judge", task: "RISK-JUDGE" }, { lane: "inbox-draft", task: "INBOX-DRAFT" },
  { lane: "review", task: "W1-T9000" }, { lane: "review", task: "W1-T9001" }] as const;

function call(i: number, taskId: string, runId: string, lane: string | undefined, taskClass: unknown): string {
  const base = { host: "core-host", task_id: taskId, run_id: runId };
  return JSON.stringify({ ...base, ts: at(i), step: "worker.assignment", ...(lane === undefined ? {} : { lane }),
    worker_assignment: { id: `assign-${i}`, requested: { model: "sonnet" }, selected: { provider: "claude", model: MODEL } },
    benchmark_run: { work: { taskClass } } }) + "\n"
    + JSON.stringify({ ...base, ts: at(i, 30), step: "worker.attempt", selection_assignment_id: `assign-${i}`, success: true,
      billing_mode: "api", total_cost_usd: 0.02 }) + "\n";
}

async function pass(t: TestContext, withNonBuilds: boolean) {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14988-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const builds = BUILDS.map(({ lane }, i) => call(i, `W1-T${9000 + i}`, `run-${i}`, lane, { state: "observed", value: "src" }));
  const others = NON_BUILDS.map(({ lane, task }, j) => call(20 + j, task, `${lane}-${j}`, lane,
    { state: "unavailable", reason: task.startsWith("W1-") ? "task-record-not-read-by-lane" : "work-has-no-task" }));
  writeFileSync(join(stateDir, "ledger.ndjson"), [...builds, ...(withNonBuilds ? others : [])].join(""));
  mkdirSync(join(stateDir, "field-trials"), { recursive: true });
  writeFileSync(stateCaseFileSnapshotPath(stateDir), JSON.stringify(BUILDS.map(({ pr }, i) => caseFile(i, pr))));
  const result = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, caseFilesFromState: true });
  assert.equal(result.caseFileJoin, "joined");
  return { result, stateDir };
}

const outcomeOf = (cohort: BenchmarkCohort) => {
  assert.notEqual(typeof cohort.verifiedOutcome, "string", "the case files were joined");
  return cohort.verifiedOutcome as CohortVerifiedOutcome;
};
interface Tally { assignments: number; completed: number; endedWithoutCompletion: number; censored: number;
  unavailable: number; reasons: Record<string, number>; nonBuildCalls: Record<string, number> }
const sum = (cohorts: readonly BenchmarkCohort[]): Tally => cohorts.map(outcomeOf).reduce<Tally>((total, o) => ({
  assignments: total.assignments + o.assignments, completed: total.completed + o.completed,
  endedWithoutCompletion: total.endedWithoutCompletion + o.endedWithoutCompletion, censored: total.censored + o.censored,
  unavailable: total.unavailable + o.unavailable,
  reasons: Object.entries(o.reasons).reduce<Record<string, number>>((r, [k, n]) => ({ ...r, [k]: (r[k] ?? 0) + n }), total.reasons),
  nonBuildCalls: Object.entries(o.nonBuildCalls ?? {}).reduce<Record<string, number>>((r, [k, n]) => ({ ...r, [k]: (r[k] ?? 0) + n }), total.nonBuildCalls),
}), { assignments: 0, completed: 0, endedWithoutCompletion: 0, censored: 0, unavailable: 0, reasons: {}, nonBuildCalls: {} });

test("W1-T14988 criterion 1: a judge, draft or review call is not counted as a build outcome", async (t) => {
  const { result, stateDir } = await pass(t, true);
  const total = sum(result.snapshot.cohorts);
  assert.equal(total.assignments, BUILDS.length, "only the four build calls are joined");
  assert.deepEqual(total.nonBuildCalls, { "risk-judge": 1, "inbox-draft": 1, review: 2 }, "every other call is counted by lane");
  assert.equal(total.reasons["case-file-missing"], undefined, "no judge or draft call reads as a missing case file");
  assert.equal(total.reasons["run-not-in-case-file"], undefined, "no review call reads as a run outside its case file");
  assert.deepEqual(total.reasons, { "closed-unmerged-unadjudicated": 1, "open-at-cutoff": 1 },
    "the only reasons named are the builds' own: one closed unmerged, one open at the cutoff");
  // The non-build calls stay in the cohort rows' own call counts; nothing is dropped from the index.
  assert.equal(result.snapshot.cohorts.reduce((n, cohort) => n + cohort.assignments, 0), BUILDS.length + NON_BUILDS.length);
  // A later pass from the stored checkpoint keeps the lanes: the projection carries `lane`.
  const again = await runBenchmarkCohortPass(stateDir, { nowIso: cutoff, caseFilesFromState: true });
  assert.deepEqual(sum(again.snapshot.cohorts).nonBuildCalls, total.nonBuildCalls);
});

test("W1-T14988 criterion 2: a build call's disposition is unchanged", async (t) => {
  const alone = sum((await pass(t, false)).result.snapshot.cohorts);
  const beside = sum((await pass(t, true)).result.snapshot.cohorts);
  const disposition = (o: typeof alone) => ({ assignments: o.assignments, completed: o.completed,
    endedWithoutCompletion: o.endedWithoutCompletion, censored: o.censored, unavailable: o.unavailable, reasons: o.reasons });
  assert.deepEqual(disposition(beside), disposition(alone), "non-build calls beside them change no build call's disposition");
  assert.deepEqual(disposition(alone), { assignments: 4, completed: 2, endedWithoutCompletion: 0, censored: 1, unavailable: 1,
    reasons: { "closed-unmerged-unadjudicated": 1, "open-at-cutoff": 1 } }, "merged, closed, open and a laneless merged build");
  assert.deepEqual(alone.nonBuildCalls, {}, "a ledger of builds alone names no non-build call");
});
