/**
 * W1-T4618 — an assignment records its task shape.
 *
 * MEASURED 2026-09-27: `benchmark_run.work` on worker.assignment carried only taskClass and risk, while
 * 57% of core work is implement/high/src — so every per-model rate mixed easy and hard work. Every lane
 * that writes worker.assignment now carries a bounded task-shape covariate block (counts and small enums,
 * explicit unavailable values), and the cohort projection stratifies by it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PROOF_DIALECT_PREFIX_RE,
  TASK_SHAPE_AREAS_MAX,
  TASK_SHAPE_DEPENDS_DEPTH_MAX,
  TASK_SHAPE_TOKEN_RE,
  TASK_SHAPE_VERSION,
  benchmarkNonDispatchSpawn,
  benchmarkRunAssignmentReceipt,
  dispatchTaskShape,
  fixLaneBenchmarkWork,
  nonDispatchBenchmarkWork,
  observeBenchmarkWork,
  proofDialect,
  taskShapeCountBucket,
  taskShapeCovariates,
  topLevelArea,
  type TaskShapeCovariates,
} from "../src/lib/benchmark-run.js";
import {
  TASK_SHAPE_DIMENSIONS,
  TASK_SHAPE_STRATA_VERSION,
  TASK_SHAPE_STRATUM_VALUE_RE,
  runBenchmarkCohortPass,
  taskShapeStratumValue,
} from "../src/lib/benchmark-cohort.js";
import { benchmarkRunLedgerLogger, buildInboxDraftSpawnArgs, harnessCommitForShellLessWorker, runFixRung, runTask } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

type Row = Record<string, unknown>;

const ASSIGNMENT: WorkerSelectionAssignment = {
  version: 1, id: "shape-assignment-1", phase: "pre-execution",
  requested: { model: "requested-model", effort: "high", maxTurns: null },
  selected: { provider: "codex", model: "selected-model", effort: "high" },
  routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
  candidates: [],
} as unknown as WorkerSelectionAssignment;

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "shape-session", costUsd: 0.25, numTurns: 1, text: "REPORT\nno PR opened\n",
    blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "selected-model", servedModel: "served-model",
    effort: "high", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, workerDurationMs: 27, ...over,
  };
}

function shapeOf(row: Row | undefined): TaskShapeCovariates {
  const receipt = row?.benchmark_run as { work?: { shape?: TaskShapeCovariates } } | undefined;
  assert.ok(receipt?.work?.shape, "the assignment receipt carries the task-shape block");
  return receipt.work.shape;
}

function readRows(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
}

const unavailable = (reason: string) => ({ state: "unavailable", reason });

test("a dispatched task's shape is recorded as bounded counts and enums", () => {
  const shape = taskShapeCovariates({
    task: {
      id: "T-SHAPE", repo: "remudero", depends_on: ["T-A"],
      files: ["src/lib/a.ts", "src/lib/b.ts", "./test/x.test.ts", "CLAUDE.md"],
      acceptance: [{ proof: "unit test: test/x.test.ts" }, { proof: "grep: foo in src/lib/a.ts" }, { proof: "it works" }],
    },
    tasks: [{ id: "T-A", depends_on: ["T-B"] }, { id: "T-B", depends_on: [] }],
    ledgerRows: [
      { task_id: "T-SHAPE", step: "run.start" }, { task_id: "T-SHAPE", step: "run.start" },
      { task_id: "T-SHAPE", step: "fix.dispatch" }, { task_id: "T-OTHER", step: "run.start" },
      { task_id: "T-SHAPE", step: "verdict" },
    ],
    lane: "run-task",
    reconUnavailableReason: "recon-not-yet-run",
  });
  assert.deepEqual(shape, {
    version: TASK_SHAPE_VERSION,
    declaredFiles: { state: "observed", value: { count: 4, bucket: "4-7" } },
    topLevelAreas: { state: "observed", value: ["root", "src", "test"] },
    acceptanceCriteria: { state: "observed", value: { count: 3, bucket: "2-3" } },
    proofDialects: { state: "observed", value: ["grep", "prose", "unit-test"] },
    dependsOnDepth: { state: "observed", value: { depth: 2, bucket: "2" } },
    attemptNumber: { state: "observed", value: { count: 3, bucket: "3+", basis: "live-ledger" } },
    priorStrikes: { state: "observed", value: { count: 1, bucket: "1", basis: "live-ledger" } },
    lane: { state: "observed", value: "run-task" },
    repo: { state: "observed", value: "remudero" },
    recon: unavailable("recon-not-yet-run"),
    reconSizeEstimate: unavailable("recon-not-yet-run"),
  });
  assert.doesNotMatch(JSON.stringify(shape), /lib\/a\.ts|foo|it works/, "no free text and no path below its area");
});

test("a covariate that cannot be computed is an explicit unavailable value, never 0 and never omitted", () => {
  const lane = nonDispatchBenchmarkWork("triage").shape!;
  const keys = Object.keys(lane).filter((key) => key !== "version");
  assert.deepEqual(keys, [...TASK_SHAPE_DIMENSIONS], "the cohort stratifies by exactly the block's covariates");
  assert.deepEqual(lane.lane, { state: "observed", value: "triage" });
  for (const key of keys.filter((key) => key !== "lane")) {
    assert.deepEqual(lane[key as keyof typeof lane], unavailable("non-dispatch-lane-has-no-task-record"), key);
  }

  const bare = taskShapeCovariates({ task: { id: "T-BARE" } });
  assert.deepEqual(bare.declaredFiles, unavailable("files-not-declared"));
  assert.deepEqual(bare.topLevelAreas, unavailable("files-not-declared"));
  assert.deepEqual(bare.acceptanceCriteria, unavailable("acceptance-not-declared"));
  assert.deepEqual(bare.proofDialects, unavailable("acceptance-not-declared"));
  assert.deepEqual(bare.dependsOnDepth, unavailable("plan-not-in-hand"));
  assert.deepEqual(bare.attemptNumber, unavailable("ledger-not-in-hand"));
  assert.deepEqual(bare.priorStrikes, unavailable("ledger-not-in-hand"));
  assert.deepEqual(bare.lane, unavailable("task-not-in-hand"));
  assert.deepEqual(bare.repo, unavailable("repo-not-declared"));

  const empty = taskShapeCovariates({ task: { id: "T-EMPTY", files: [], acceptance: [], depends_on: [], repo: "a/b" },
    tasks: [], ledgerRows: [], runStartWritten: true, lane: "no spaces allowed" });
  assert.deepEqual(empty.declaredFiles, { state: "observed", value: { count: 0, bucket: "0" } });
  assert.deepEqual(empty.proofDialects, { state: "observed", value: [] });
  assert.deepEqual(empty.dependsOnDepth, { state: "observed", value: { depth: 0, bucket: "0" } });
  assert.deepEqual(empty.attemptNumber, unavailable("run-start-not-in-live-ledger"));
  assert.deepEqual(empty.priorStrikes, { state: "observed", value: { count: 0, bucket: "0", basis: "live-ledger" } });
  assert.deepEqual(empty.repo, unavailable("repo-not-a-token"));
  assert.deepEqual(empty.lane, unavailable("lane-not-a-token"));

  const noId = taskShapeCovariates({ task: { files: ["src/x.ts"] }, ledgerRows: [{ step: "run.start" }] });
  assert.deepEqual(noId.attemptNumber, unavailable("task-not-in-hand"), "an unnamed task never counts other rows");
});

test("counts are bucketed at documented boundaries", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 50].map(taskShapeCountBucket), ["0", "1", "2-3", "2-3", "4-7", "4-7", "8+", "8+"]);
  const attempt = (starts: number) => taskShapeCovariates({ task: { id: "T" },
    ledgerRows: Array.from({ length: starts }, () => ({ task_id: "T", step: "run.start" })) }).attemptNumber;
  assert.deepEqual([0, 1, 2, 5].map((n) => (attempt(n) as { value: { bucket: string } }).value.bucket), ["1", "2", "3+", "3+"]);
  const strikes = (n: number) => taskShapeCovariates({ task: { id: "T" },
    ledgerRows: Array.from({ length: n }, () => ({ task_id: "T", step: "fix.dispatch" })) }).priorStrikes;
  assert.deepEqual([0, 1, 2, 9].map((n) => (strikes(n) as { value: { bucket: string } }).value.bucket), ["0", "1", "2+", "2+"]);
});

test("top-level areas and proof dialects stay bounded tokens", () => {
  assert.equal(topLevelArea("src/lib/x.ts"), "src");
  assert.equal(topLevelArea("./docs/a.md"), "docs");
  assert.equal(topLevelArea("README.md"), "root");
  assert.equal(topLevelArea("**/x.ts"), "other");
  const many = taskShapeCovariates({ task: { files: Array.from({ length: 10 }, (_, i) => `area${i}/f.ts`) } });
  const areas = (many.topLevelAreas as { value: string[] }).value;
  assert.equal(areas.length, TASK_SHAPE_AREAS_MAX);
  assert.ok(areas.includes("other"), "the tail folds into other");

  assert.equal(TASK_SHAPE_TOKEN_RE.test("inbox-draft"), true);
  assert.equal(TASK_SHAPE_TOKEN_RE.test("has space"), false);
  assert.equal(PROOF_DIALECT_PREFIX_RE.test("unit test: test/x.test.ts"), true);
  assert.equal(PROOF_DIALECT_PREFIX_RE.test("the tests pass"), false);
  assert.equal(proofDialect("demonstration: operator clicks"), "demonstration");
  assert.equal(proofDialect("GREP: x in y"), "grep");
  assert.equal(proofDialect("   "), "absent");
  assert.equal(proofDialect(undefined), "absent");
  assert.equal(proofDialect("prose"), "prose");
});

test("depends_on depth is walked through the plan, bounded, and refuses a cycle", () => {
  const depth = (depends_on: string[] | undefined, tasks: { id: string; depends_on?: string[] }[]) =>
    taskShapeCovariates({ task: { id: "T", depends_on }, tasks }).dependsOnDepth;
  assert.deepEqual(depth(["GONE"], []), { state: "observed", value: { depth: 1, bucket: "1" } }, "an archived dependency is a leaf");
  assert.deepEqual(depth(["A", "B"], [{ id: "A", depends_on: ["B"] }, { id: "B", depends_on: ["C"] }, { id: "C" }]),
    { state: "observed", value: { depth: 3, bucket: "3+" } });
  assert.deepEqual(depth(["A"], [{ id: "A", depends_on: ["B"] }, { id: "B", depends_on: ["A"] }]), unavailable("depends-on-cycle"));
  assert.deepEqual(depth(["A"], [{ id: "A", depends_on: ["T"] }]), unavailable("depends-on-cycle"));
  const chain = Array.from({ length: TASK_SHAPE_DEPENDS_DEPTH_MAX + 2 }, (_, i) => ({ id: `C${i}`, depends_on: [`C${i + 1}`] }));
  assert.deepEqual(depth(["C0"], chain), unavailable("depends-on-depth-bound"));
  assert.deepEqual(depth(undefined, []), unavailable("depends-on-not-declared"));
  const broken = taskShapeCovariates({ task: { id: "T", depends_on: ["A"] },
    tasks: [{ id: "A", get depends_on(): string[] { throw new Error("unreadable"); } }] }).dependsOnDepth;
  assert.deepEqual(broken, unavailable("depends-on-walk-failed"));
});

test("a dispatch reads its own attempt and strike counts from the live ledger, never throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4618-ledger-"));
  try {
    const ledger = join(root, "ledger.ndjson");
    writeFileSync(ledger, [
      JSON.stringify({ task_id: "T-L", step: "run.start" }),
      JSON.stringify({ task_id: "T-L", step: "fix.dispatch" }),
      JSON.stringify({ task_id: "T-OTHER", step: "run.start" }),
      "",
    ].join("\n"));
    const shape = dispatchTaskShape({ task: { id: "T-L" }, ledgerPath: ledger, lane: "run-task" });
    assert.deepEqual(shape.attemptNumber, { state: "observed", value: { count: 2, bucket: "2", basis: "live-ledger" } });
    assert.deepEqual(shape.priorStrikes, { state: "observed", value: { count: 1, bucket: "1", basis: "live-ledger" } });

    const fix = fixLaneBenchmarkWork({ id: "T-L" }, ledger).shape!;
    assert.deepEqual(fix.attemptNumber, { state: "observed", value: { count: 1, bucket: "1", basis: "live-ledger" } },
      "the fix rung's run.start is already written");
    assert.deepEqual(fix.lane, { state: "observed", value: "fix" });
    assert.deepEqual(fix.recon, unavailable("fix-lane-does-not-observe-recon"));
    const fixWork = fixLaneBenchmarkWork({ id: "T-L", files: ["docs/guide.md"], risk: "low" }, ledger);
    const fixReceipt = benchmarkRunAssignmentReceipt(ASSIGNMENT, fixWork);
    assert.deepEqual(fixReceipt.work.taskClass, { state: "observed", value: "docs" });
    assert.deepEqual(fixReceipt.work.risk, { state: "observed", value: "low" });

    assert.deepEqual(dispatchTaskShape({ task: { id: "T-L" }, ledgerPath: join(root, "absent.ndjson") }).attemptNumber,
      { state: "observed", value: { count: 1, bucket: "1", basis: "live-ledger" } }, "no ledger yet is a first attempt");
    assert.deepEqual(dispatchTaskShape({ task: { id: "T-L" }, ledgerPath: root }).attemptNumber, unavailable("ledger-unreadable"));
    assert.deepEqual(dispatchTaskShape({ task: { id: "T-L" } }).priorStrikes, unavailable("ledger-not-in-hand"));
    writeFileSync(ledger, `${JSON.stringify({ task_id: "T-L", step: "run.start" })}\n{"task_id":"T-L","step":"run.st\n`);
    assert.deepEqual(dispatchTaskShape({ task: { id: "T-L" }, ledgerPath: ledger }).attemptNumber,
      unavailable("torn-ledger-line-names-task"));
    const failed = dispatchTaskShape({ task: { id: "T-L", files: [7 as unknown as string] }, lane: "run-task" });
    assert.deepEqual(failed.declaredFiles, unavailable("task-shape-build-failed"));
    assert.deepEqual(failed.lane, { state: "observed", value: "run-task" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("run.start sets the shape and each recon step marks it for the assignments that follow", () => {
  const shape = taskShapeCovariates({ task: { id: "T" }, lane: "run-task", reconUnavailableReason: "recon-not-yet-run" });
  let work = observeBenchmarkWork({}, "run.start", { task_class: "src", risk: "high", task_shape: shape });
  assert.equal(work.shape, shape);
  assert.equal(observeBenchmarkWork(work, "toString", {}), work, "an inherited key is not a recon step");
  assert.equal(observeBenchmarkWork({}, "recon.done", {}).shape, undefined, "no shape to mark");
  work = observeBenchmarkWork(work, "recon.done", {});
  assert.deepEqual(work.shape?.recon, { state: "observed", value: "ran" });
  assert.deepEqual(work.shape?.reconSizeEstimate, unavailable("recon-report-has-no-size-estimate"));
  work = observeBenchmarkWork(work, "recon.degraded", {});
  assert.deepEqual(work.shape?.recon, { state: "observed", value: "degraded" });
  assert.deepEqual(work.shape?.reconSizeEstimate, unavailable("recon-degraded-no-report"));
  assert.deepEqual(observeBenchmarkWork(work, "recon.masked", {}).shape?.reconSizeEstimate, unavailable("recon-masked"));
  assert.deepEqual(observeBenchmarkWork(work, "recon.reused", {}).shape?.recon, { state: "observed", value: "reused" });
  assert.equal(observeBenchmarkWork(work, "run.start", { task_shape: { version: "other" } }).shape, undefined);

  const receipt = (work: Parameters<typeof benchmarkRunAssignmentReceipt>[1]) => benchmarkRunAssignmentReceipt(ASSIGNMENT, work).work.shape;
  assert.deepEqual(receipt({}).lane, unavailable("task-shape-not-supplied-by-caller"), "a caller with no shape still carries the block");
  assert.deepEqual(receipt({ shape: { version: "v0" } as unknown as TaskShapeCovariates }).repo, unavailable("task-shape-invalid"));
});

test("the dispatch logger stamps the run.start shape and recon state on every assignment", () => {
  const rows: { step: string; fields: Row }[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, fields }));
  const shape = taskShapeCovariates({ task: { id: "T", files: ["src/a.ts"] }, lane: "run-task", reconUnavailableReason: "recon-not-yet-run" });
  log("run.start", { task_class: "src", risk: "high", task_shape: shape });
  log("worker.assignment", { worker_assignment: { ...ASSIGNMENT, id: "recon-assignment" } });
  log("recon.done", {});
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  const assigned = rows.filter((row) => row.step === "worker.assignment").map((row) => shapeOf(row.fields));
  assert.deepEqual(assigned[0]!.recon, unavailable("recon-not-yet-run"), "recon's own worker precedes any recon result");
  assert.deepEqual(assigned[1]!.recon, { state: "observed", value: "ran" });
  assert.deepEqual(assigned[1]!.declaredFiles, { state: "observed", value: { count: 1, bucket: "1" } });
});

test("a real dispatch carries the task-shape block on every assignment it writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4618-dispatch-"));
  const bare = gitRepo({ bare: true, kind: "w1-t4618-origin" });
  const seed = gitRepo({ kind: "w1-t4618-seed" });
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare.dir, join(root, "repos", "remudero")]);
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  writeFileSync(ledger, `${JSON.stringify({ ts: "2026-09-26T00:00:00.000Z", run_id: "T-SHAPE-DISPATCH-1", task_id: "T-SHAPE-DISPATCH", step: "run.start" })}\n`
    + `${JSON.stringify({ ts: "2026-09-26T00:00:01.000Z", run_id: "T-SHAPE-DISPATCH-1", task_id: "T-SHAPE-DISPATCH", step: "verdict", verdict: "no_pr" })}\n`);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: T-SHAPE-DISPATCH
  title: task shape dispatch fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts, test/daemon.test.ts]
  acceptance:
    - claim: the fixture dispatches
      proof: "unit test: test/daemon.test.ts"
  status: queued
`);
  let calls = 0;
  const spawn = async (args: SpawnWorkerArgs) => {
    calls++;
    args.onSelectionAssignment?.({ ...ASSIGNMENT, id: `shape-dispatch-${calls}` });
    return worker({ sessionId: `shape-session-${calls}`, selectionAssignmentId: `shape-dispatch-${calls}`,
      text: calls === 1 ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" : "REPORT\nno PR opened\n" });
  };
  try {
    await withLiveWritesAllowed(() => runTask("T-SHAPE-DISPATCH", {
      skipGitSync: true, planPath,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    }));
    const rows = readRows(ledger);
    const start = rows.filter((row) => row.step === "run.start").at(-1);
    assert.equal((start?.task_shape as { version?: string })?.version, TASK_SHAPE_VERSION, "run.start records the shape");
    const assigned = rows.filter((row) => row.step === "worker.assignment");
    assert.ok(assigned.length >= 2, "recon and implement both reached assignment");
    for (const row of assigned) {
      const shape = shapeOf(row);
      assert.deepEqual(shape.declaredFiles, { state: "observed", value: { count: 2, bucket: "2-3" } });
      assert.deepEqual(shape.topLevelAreas, { state: "observed", value: ["src", "test"] });
      assert.deepEqual(shape.acceptanceCriteria, { state: "observed", value: { count: 1, bucket: "1" } });
      assert.deepEqual(shape.proofDialects, { state: "observed", value: ["unit-test"] });
      assert.deepEqual(shape.dependsOnDepth, { state: "observed", value: { depth: 0, bucket: "0" } });
      assert.deepEqual(shape.attemptNumber, { state: "observed", value: { count: 2, bucket: "2", basis: "live-ledger" } });
      assert.deepEqual(shape.priorStrikes, { state: "observed", value: { count: 0, bucket: "0", basis: "live-ledger" } });
      assert.deepEqual(shape.lane, { state: "observed", value: "run-task" });
      assert.deepEqual(shape.repo, { state: "observed", value: "remudero" });
    }
    assert.deepEqual(shapeOf(assigned[0]).recon, unavailable("recon-not-yet-run"));
    assert.deepEqual(shapeOf(assigned[1]).recon, { state: "observed", value: "ran" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    bare.cleanup();
  }
});

const MOUNT: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

test("a fix worker's assignment carries the fix lane's task shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4618-fix-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ task_id: "W1-T4618X", step: "run.start" })}\n`);
  const lines: Row[] = [];
  const issues: IssueGateway = { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} };
  try {
    await runFixRung({
      taskId: "W1-T4618X", runId: "DAEMON-4618",
      task: { id: "W1-T4618X", title: "the fix lands", files: ["src/run-task.ts"],
        acceptance: [{ claim: "the fix lands", proof: "unit test: the fix lands" }] },
      prUrl: "https://github.com/acme/remudero/pull/4618", branch: "run-W1-T4618X-1", worktreePath: process.cwd(),
      initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(root, "settings.json"),
      config: { root } as Config, budgetUsd: 10, strikeCap: 1, initialReview: failedReview(),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
      deps: {
        spawn: async (args: SpawnWorkerArgs) => {
          args.onSelectionAssignment?.({ ...ASSIGNMENT, id: "fix-assignment" });
          return worker({ selectionAssignmentId: "fix-assignment", text: "REPORT\nfixed it\nCOMMIT_MESSAGE: fix(ci): repair the red check" });
        },
        waitForCiGreen: async () => "green" as const,
        runReview: async () => failedReview(),
        fetchPrBody: async () => "REPORT",
        push: () => {},
        issues,
        ledgerPath,
        log: (step: string, extra?: Record<string, unknown>) => { lines.push({ step, ...(extra ?? {}) }); },
        say: () => {},
        account: (result: WorkerResult) => result,
        worktreeHasUncommittedChanges: () => false,
        harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
          harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: "new-head", undeclared: [] }), ahead: () => 1 }),
      },
    });
    const shape = shapeOf(lines.find((line) => line.step === "worker.assignment"));
    assert.deepEqual(shape.lane, { state: "observed", value: "fix" });
    assert.deepEqual(shape.declaredFiles, { state: "observed", value: { count: 1, bucket: "1" } });
    assert.deepEqual(shape.proofDialects, { state: "observed", value: ["unit-test"] });
    assert.deepEqual(shape.attemptNumber, { state: "observed", value: { count: 1, bucket: "1", basis: "live-ledger" } });
    assert.deepEqual(shape.dependsOnDepth, unavailable("plan-not-in-hand"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every non-dispatch lane's assignment carries the block with its lane observed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4618-lanes-"));
  try {
    const config = { root } as Config;
    const spawn = benchmarkNonDispatchSpawn("triage", async (args) => {
      args.onSelectionAssignment?.({ ...ASSIGNMENT, id: "triage-assignment" });
      return worker({ selectionAssignmentId: "triage-assignment" });
    });
    await spawn({ cwd: root, permissionMode: "bypassPermissions", settingsFile: "s", prompt: "p", config });
    const inbox = buildInboxDraftSpawnArgs({
      cwd: root, settingsFile: "settings.json", prompt: "draft", config,
      mount: { provider: "cash", model: "gpt-6-luna", effort: "low", maxTurns: 3 } as Parameters<typeof buildInboxDraftSpawnArgs>[0]["mount"],
      disallowedTools: [],
    });
    inbox.onSelectionAssignment?.({ ...ASSIGNMENT, id: "inbox-assignment" });
    const assigned = readRows(join(root, "state", "ledger.ndjson")).filter((row) => row.step === "worker.assignment");
    assert.deepEqual(assigned.map((row) => shapeOf(row).lane), [
      { state: "observed", value: "triage" }, { state: "observed", value: "inbox-draft" }]);
    for (const row of assigned) assert.deepEqual(shapeOf(row).declaredFiles, unavailable("non-dispatch-lane-has-no-task-record"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the cohort stratifies by each covariate with explicit unavailable values", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-w1-t4618-cohort-"));
  const assignmentRow = (id: string, model: string, shape: unknown, ts: string) => ({
    ts, run_id: `run-${id}`, task_id: "T", step: "worker.assignment",
    worker_assignment: { id, requested: { model }, selected: { provider: "codex", model } },
    benchmark_run: { version: "benchmark-run-v1", phase: "assignment",
      work: { taskClass: { state: "observed", value: "src" }, ...(shape === undefined ? {} : { shape }) } },
  });
  const full = taskShapeCovariates({ task: { id: "T", repo: "remudero", files: ["src/a.ts", "test/a.test.ts"],
    acceptance: [{ proof: "grep: x in src/a.ts" }], depends_on: [] }, tasks: [], ledgerRows: [], lane: "run-task" });
  const rows = [
    assignmentRow("a1", "m1", full, "2026-09-26T11:00:00.000Z"),
    { ts: "2026-09-26T11:00:05.000Z", run_id: "run-a1", step: "worker.attempt", selection_assignment_id: "a1", success: true },
    assignmentRow("a2", "m2", full, "2026-09-26T11:01:00.000Z"),
    { ts: "2026-09-26T11:01:05.000Z", run_id: "run-a2", step: "worker.attempt", selection_assignment_id: "a2", success: false },
    assignmentRow("a3", "m1", undefined, "2026-09-26T11:02:00.000Z"),
    assignmentRow("a4", "m1", { version: "task-shape-v9" }, "2026-09-26T11:03:00.000Z"),
    assignmentRow("a5", "m1", "not-a-block", "2026-09-26T11:04:00.000Z"),
  ];
  try {
    writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = await runBenchmarkCohortPass(stateDir, { maxSources: 4 });
    assert.equal(result.state, "complete");
    const shape = result.snapshot.taskShape;
    assert.equal(shape.version, TASK_SHAPE_STRATA_VERSION);
    const stratum = (dimension: string, value: string, model: string) =>
      shape.strata.find((s) => s.dimension === dimension && s.value === value && s.model === model);
    assert.deepEqual(stratum("declaredFiles", "2-3", "m1"), { dimension: "declaredFiles", value: "2-3", model: "m1",
      assignments: 1, joinedAttempts: 1, workerCallSuccess: 1, workerCallFailure: 0 });
    assert.equal(stratum("declaredFiles", "2-3", "m2")?.workerCallFailure, 1);
    assert.equal(stratum("topLevelAreas", "src+test", "m1")?.assignments, 1);
    assert.equal(stratum("proofDialects", "grep", "m2")?.assignments, 1);
    assert.equal(stratum("attemptNumber", "1", "m1")?.assignments, 1);
    assert.equal(stratum("recon", "unavailable:task-not-in-hand", "m1")?.assignments, 1);
    assert.equal(stratum("declaredFiles", "unavailable:not-recorded-at-assignment", "m1")?.assignments, 1, "legacy rows are counted, not dropped");
    assert.equal(stratum("repo", "unavailable:task-shape-version-unknown", "m1")?.assignments, 1);
    assert.equal(stratum("lane", "unavailable:task-shape-invalid", "m1")?.assignments, 1);
    assert.deepEqual(shape.coverage.declaredFiles, { denominator: 5, observed: 2, unavailable: 3 });
    assert.deepEqual(Object.keys(shape.coverage), [...TASK_SHAPE_DIMENSIONS]);
    assert.doesNotMatch(JSON.stringify(shape), /src\/a\.ts/, "the cohort keeps strata, never paths");

    const cached = await runBenchmarkCohortPass(stateDir, { maxSources: 4 });
    assert.deepEqual(cached.snapshot.taskShape, shape, "an unchanged ledger reuses the verified snapshot");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("a stratum value is a bounded token or an explicit unavailable reason", () => {
  assert.equal(taskShapeStratumValue(undefined), "unavailable:not-recorded-at-assignment");
  assert.equal(taskShapeStratumValue({ state: "unavailable" }), "unavailable:reason-missing");
  assert.equal(taskShapeStratumValue({ state: "guessed", value: "x" }), "unavailable:shape-evidence-invalid");
  assert.equal(taskShapeStratumValue({ state: "observed", value: [] }), "(none)");
  assert.equal(taskShapeStratumValue({ state: "observed", value: { count: 3 } }), "unavailable:shape-evidence-invalid");
  assert.equal(taskShapeStratumValue({ state: "observed", value: "has a space" }), "unavailable:value-not-bounded");
  assert.equal(TASK_SHAPE_STRATUM_VALUE_RE.test("unavailable:plan-not-in-hand"), true);
  assert.equal(TASK_SHAPE_STRATUM_VALUE_RE.test("src/lib/a.ts"), false);
});
