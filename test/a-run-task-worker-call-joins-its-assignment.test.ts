/**
 * W1-T4639 — a run-task worker call joins its assignment.
 *
 * MEASURED 2026-09-27 over the core fleet's ledger union (2026-09-20T22:45Z..2026-09-27T22:45Z):
 * 64 of 522 run-task `worker.assignment` rows joined a `worker.attempt` receipt through
 * `selection_assignment_id`, and 1381 verify-human-judge / escalation-summary failure receipts
 * carried no assignment id and no reason. This suite drives the real run-task paths — recon,
 * implement, a spawn that throws before a result, a fix rung — and the verify-human and
 * escalation judges' failure paths with fake spawns, and pins: exactly one receipt per assignment
 * id, carrying that id, with served model, billing mode and cost each observed or named
 * unavailable; and a receipt with no assignment names why.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { attemptAssignmentJoin, benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import type { Config } from "../src/lib/config.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { spawnEscalationJudgeWorker } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { GitHub } from "../src/lib/status.js";
import { spawnVerifyHumanJudgeWorker } from "../src/lib/verify-human-judge.js";
import type { spawnWorker, SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { harnessCommitForShellLessWorker, runFixRung, runTask } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

type Row = { step: string } & Record<string, unknown>;

const MOUNT: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };

function assignment(id: string): WorkerSelectionAssignment {
  return {
    version: 1, id, phase: "pre-execution",
    requested: { model: "sonnet", effort: "high", maxTurns: 20 },
    selected: { provider: "claude", model: "claude-sonnet-5", effort: "high" },
    routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [],
  } as unknown as WorkerSelectionAssignment;
}

function worker(text: string, over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "session-4639", costUsd: 0.5, numTurns: 1, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "claude", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", effort: "high",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, workerDurationMs: 30,
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over,
  };
}

function rowsAt(path: string): Row[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
    : [];
}

/** Every assignment id has exactly one `worker.attempt` naming it; every attempt names an assignment
 *  or a reason it has none; served model, billing mode and cost are each observed or named unavailable. */
function assertOneReceiptPerAssignment(rows: readonly Row[]): { assigned: string[]; attempts: Row[] } {
  const assigned = rows.filter((r) => r.step === "worker.assignment")
    .map((r) => (r.worker_assignment as { id: string }).id);
  const attempts = rows.filter((r) => r.step === "worker.attempt");
  assert.equal(new Set(assigned).size, assigned.length, "each assignment is written once");
  for (const id of assigned) {
    const receipts = attempts.filter((a) => a.selection_assignment_id === id);
    assert.equal(receipts.length, 1, `assignment ${id} has exactly one worker.attempt receipt`);
  }
  for (const attempt of attempts) {
    if (typeof attempt.selection_assignment_id === "string") {
      assert.ok(assigned.includes(attempt.selection_assignment_id), "a receipt joins an assignment that was written");
    } else {
      assert.equal(typeof attempt.selection_assignment_unavailable_reason, "string", "an unjoined receipt names why");
    }
    const run = attempt.benchmark_run as Record<string, Record<string, unknown>>;
    assert.equal(run.phase, "attempt");
    const accounting = run.accounting as Record<string, Record<string, unknown>>;
    for (const evidence of [run.servedModel, accounting.billingMode, accounting.apiCostUsd]) {
      assert.ok(evidence.state === "observed" || (evidence.state === "unavailable" && typeof evidence.reason === "string"),
        `evidence is observed or names its gap: ${JSON.stringify(evidence)}`);
    }
  }
  return { assigned, attempts };
}

// ─── the dispatch lane: recon, implement, and a spawn that throws ────────────────────────────────

const TASK_ID = "T-W1-T4639-DISPATCH";

async function dispatch(spawn: typeof spawnWorker): Promise<{ rows: Row[]; outcome: unknown }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4639-dispatch-"));
  const origin = gitRepo({ bare: true, kind: "w1-t4639-origin" });
  const seed = gitRepo({ kind: "w1-t4639-seed" });
  try {
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    mkdirSync(join(root, "repos"), { recursive: true });
    execFileSync("git", ["clone", "--quiet", origin.dir, join(root, "repos", "remudero")]);
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, `- id: ${TASK_ID}
  title: worker receipt fixture
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts]
  status: queued
`);
    const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const outcome = await withLiveWritesAllowed(() => runTask(TASK_ID, {
      skipGitSync: true, planPath,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
      github, spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    })).catch((error: unknown) => error);
    return { rows: rowsAt(join(root, "state", "ledger.ndjson")), outcome };
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    origin.cleanup();
  }
}

const RECON = "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";

test("W1-T4639: recon and implement each write one worker.attempt receipt carrying their assignment id", async () => {
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls++;
    const id = `asg-dispatch-${calls}`;
    args.onSelectionAssignment?.(assignment(id));
    return worker(calls === 1 ? RECON : "REPORT\nno PR opened\n", { selectionAssignmentId: id, sessionId: `s-${calls}` });
  };
  const { rows, outcome } = await dispatch(spawn);
  assert.equal((outcome as { verdict?: string }).verdict, "no_pr");
  const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
  assert.ok(calls >= 2, "recon and implement both spawned");
  assert.equal(assigned.length, calls, "every worker call wrote its assignment");
  assert.equal(attempts.length, calls, "and exactly one receipt each");
  for (const attempt of attempts) {
    assert.equal(attempt.lane, "run-task");
    assert.equal(attempt.success, true);
    const run = attempt.benchmark_run as Record<string, Record<string, unknown>>;
    assert.deepEqual(run.assignmentJoin, { state: "observed", value: true });
    assert.deepEqual(run.servedModel, { state: "observed", value: "claude-sonnet-5" });
  }
});

test("W1-T4639: an implement spawn that throws before a result still writes its one receipt", async () => {
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls++;
    const id = `asg-throw-${calls}`;
    args.onSelectionAssignment?.(assignment(id));
    if (calls === 1) return worker(RECON, { selectionAssignmentId: id });
    throw Object.assign(new Error("worker home could not be materialized"), { code: "EACCES" });
  };
  const { rows } = await dispatch(spawn);
  const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
  assert.deepEqual(assigned, ["asg-throw-1", "asg-throw-2"]);
  const thrown = attempts.find((a) => a.selection_assignment_id === "asg-throw-2");
  assert.ok(thrown, "the thrown call is receipted under its own assignment");
  assert.equal(thrown.success, false);
  assert.equal(thrown.worker_failure, "spawn-threw-before-result");
  assert.equal(thrown.pre_selection, false, "an assignment was selected before the throw");
  assert.equal(thrown.error_code, "EACCES");
  assert.equal(thrown.selection_assignment_unavailable_reason, undefined);
});

test("W1-T4639: a dispatch spawn that throws before any assignment names why its receipt has none", async () => {
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls++;
    if (calls === 1) {
      args.onSelectionAssignment?.(assignment("asg-pre-1"));
      return worker(RECON, { selectionAssignmentId: "asg-pre-1" });
    }
    throw new Error("provider capacity blocked before selection");
  };
  const { rows } = await dispatch(spawn);
  const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
  assert.deepEqual(assigned, ["asg-pre-1"]);
  const unjoined = attempts.filter((a) => a.selection_assignment_id === undefined);
  assert.equal(unjoined.length, 1);
  assert.equal(unjoined[0]!.selection_assignment_unavailable_reason, "spawn-threw-before-assignment");
  assert.equal(unjoined[0]!.pre_selection, true);
});

// ─── the fix rung ────────────────────────────────────────────────────────────────────────────────

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

async function fixRung(raw: (args: SpawnWorkerArgs) => Promise<WorkerResult>): Promise<{ rows: Row[]; thrown: unknown }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4639-fix-"));
  const lines: Row[] = [];
  let thrown: unknown;
  try {
    await runFixRung({
      taskId: "W1-T4639X", runId: "DAEMON-4639",
      task: { id: "W1-T4639X", title: "the fix lands", files: ["src/run-task.ts"] },
      prUrl: "https://github.com/acme/remudero/pull/4639", branch: "run-W1-T4639X-1",
      worktreePath: process.cwd(), initialSessionId: "initial-session", mount: MOUNT,
      settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 10, strikeCap: 1,
      initialReview: failedReview(),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
      deps: {
        // The sweep's receipt wrapper sits beneath the rung, as in production: it must stand aside.
        spawn: benchmarkNonDispatchSpawn("sweep-fix", raw),
        waitForCiGreen: async () => "green" as const,
        runReview: async () => failedReview(),
        fetchPrBody: async () => "REPORT",
        push: () => {},
        issues: issues(),
        ledgerPath: join(root, "ledger.ndjson"),
        log: (step: string, extra?: Record<string, unknown>) => { lines.push({ step, ...(extra ?? {}) }); },
        say: () => {},
        account: (result: WorkerResult) => result,
        worktreeHasUncommittedChanges: () => false,
        harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
          harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: "new-head", undeclared: [] }), ahead: () => 1 }),
      },
    } as Parameters<typeof runFixRung>[0]).catch((error: unknown) => { thrown = error; });
    return { rows: [...lines, ...rowsAt(join(root, "state", "ledger.ndjson"))], thrown };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4639: a fix rung's worker writes exactly one receipt carrying its assignment id", async () => {
  const { rows, thrown } = await fixRung(async (args) => {
    args.onSelectionAssignment?.(assignment("asg-fix-1"));
    return worker("REPORT\nfixed it\nCOMMIT_MESSAGE: fix(ci): repair the red check", { selectionAssignmentId: "asg-fix-1" });
  });
  const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
  assert.equal(thrown, undefined);
  assert.deepEqual(assigned, ["asg-fix-1"]);
  assert.equal(attempts.length, 1, "the wrapper beneath stood aside: no second receipt");
  assert.equal(attempts[0]!.worker_rung, "fix");
  assert.equal(rows.find((r) => r.step === "fix.done")?.selection_assignment_id, "asg-fix-1");
});

test("W1-T4639: a fix rung's spawn that throws before any assignment names why its receipt has none", async () => {
  const { rows, thrown } = await fixRung(async () => { throw new Error("no provider could be selected"); });
  assert.match(String(thrown), /no provider could be selected/, "the worker's own error still reaches the rung");
  const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
  assert.deepEqual(assigned, []);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.selection_assignment_unavailable_reason, "spawn-threw-before-assignment");
  assert.equal(attempts[0]!.worker_failure, "spawn-threw-before-result");
});

// ─── the verify-human and escalation judges' failure receipts ───────────────────────────────────

test("W1-T4639: verify-human-judge and escalation-summary failure receipts carry their assignment id or name why not", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4639-judges-"));
  try {
    const config = { root } as Config;
    // The judges build their own spawn args; the explicit config names this fixture's ledger.
    const lane = (name: string, raw: typeof spawnWorker): typeof spawnWorker =>
      (args) => benchmarkNonDispatchSpawn(name, raw)({ ...args, config });
    const afterAssignment: typeof spawnWorker = async (args) => {
      args.onSelectionAssignment?.(assignment("asg-judge-1"));
      throw new Error("judge worker exited before a result");
    };
    const beforeAssignment: typeof spawnWorker = async () => { throw new Error("configuration file not found"); };
    const shard = { id: "W1-T9", title: "t", rationale: "r", acceptance: [], ageDays: 1, depsAllMerged: true, citedInSrc: false };
    await assert.rejects(spawnVerifyHumanJudgeWorker({ shard, mount: MOUNT, cwd: root, settingsFile: "s.json", spawn: lane("verify-human-judge", afterAssignment) }));
    await assert.rejects(spawnVerifyHumanJudgeWorker({ shard, mount: MOUNT, cwd: root, settingsFile: "s.json", spawn: lane("verify-human-judge", beforeAssignment) }));
    const escalation = { class: "blocked", taskId: "W1-T9", summary: "s", detail: "d", options: [{ label: "a", consequence: "c" }], recommendation: "a" };
    await assert.rejects(spawnEscalationJudgeWorker({ escalation: escalation as never, mount: MOUNT, cwd: root, settingsFile: "s.json", spawn: lane("escalation-summary", beforeAssignment) }));

    const rows = rowsAt(join(root, "state", "ledger.ndjson"));
    const { assigned, attempts } = assertOneReceiptPerAssignment(rows);
    assert.deepEqual(assigned, ["asg-judge-1"]);
    assert.equal(attempts.length, 3);
    const joined = attempts.find((a) => a.selection_assignment_id === "asg-judge-1");
    assert.equal(joined?.lane, "verify-human-judge");
    assert.equal(joined?.worker_failure, "spawn-threw-before-result");
    const unjoined = attempts.filter((a) => a.selection_assignment_id === undefined);
    assert.deepEqual(unjoined.map((a) => a.lane).sort(), ["escalation-summary", "verify-human-judge"]);
    for (const row of unjoined) assert.equal(row.selection_assignment_unavailable_reason, "spawn-threw-before-assignment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4639: a returned result with no observed assignment names the gap instead of reading unjoined", async () => {
  assert.deepEqual(attemptAssignmentJoin("asg-x", true), { selection_assignment_id: "asg-x" });
  assert.deepEqual(attemptAssignmentJoin(undefined, false), { selection_assignment_unavailable_reason: "assignment-not-observed" });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4639-unobserved-"));
  try {
    const spawn = benchmarkNonDispatchSpawn("escalation-summary", async () => worker("{}"));
    await spawn({ cwd: root, permissionMode: "bypassPermissions", settingsFile: "s.json", prompt: "p", config: { root } as Config });
    const [attempt] = rowsAt(join(root, "state", "ledger.ndjson")).filter((r) => r.step === "worker.attempt");
    assert.equal(attempt?.selection_assignment_unavailable_reason, "assignment-not-observed");
    assert.equal(attempt?.selection_assignment_id, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
