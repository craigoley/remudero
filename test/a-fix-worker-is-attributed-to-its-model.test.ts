/**
 * W1-T4613 — a fix worker is attributed to its model.
 *
 * MEASURED 2026-09-27: 0% of 577 core `fix.done` rows carried provider/model/effort/tokens/duration
 * or a selection_assignment_id, 1 of 577 fix runs could be matched to an assignment within 2h, and
 * every fix row logged under the daemon's run id, so no fix worker had a run id of its own. The fix
 * rung now owns each worker's assignment + attempt receipt, mints the worker its own run id, and puts
 * the standard worker fields on `fix.done` — and a broken receipt sink never blocks the fix.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { harnessCommitForShellLessWorker, runFixRung } from "../src/run-task.js";
import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import { ledgerPathFor } from "../src/lib/ledger-path.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";

const MOUNT: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };

function assignment(id: string): WorkerSelectionAssignment {
  return {
    version: 1,
    id,
    phase: "pre-execution",
    requested: { model: "sonnet", effort: "high", maxTurns: 20 },
    selected: { provider: "claude", model: "claude-sonnet-4-5", effort: "high" },
    routing: { mode: "claude-only", policy: { preference: "balanced", reservePercent: 10, provenance: "default" } },
    candidates: [],
  } as unknown as WorkerSelectionAssignment;
}

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 1.25,
    numTurns: 3,
    text: "REPORT\nfixed it\nCOMMIT_MESSAGE: fix(ci): repair the red check",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    provider: "claude",
    model: "claude-sonnet-4-5",
    effort: "high",
    tokens: { input: 1200, output: 340, cacheRead: 0, cacheCreation: 0 },
    workerDurationMs: 4321,
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

type Row = { step: string } & Record<string, unknown>;

/** One fix rung under the daemon's run id, every seam recorded. `raw` is the worker the rung spawns. */
function fixRung(opts: {
  raw: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
  failSink?: boolean;
  wrap?: (raw: (args: SpawnWorkerArgs) => Promise<WorkerResult>) => (args: SpawnWorkerArgs) => Promise<WorkerResult>;
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4613-"));
  const lines: Row[] = [];
  const spawns: SpawnWorkerArgs[] = [];
  const recorded = async (args: SpawnWorkerArgs) => {
    spawns.push(args);
    return opts.raw(args);
  };
  const config = { root } as Config;
  const run = {
    taskId: "W1-T4613X",
    runId: "DAEMON-4613",
    task: { id: "W1-T4613X", title: "the fix lands", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/4613",
    branch: "run-W1-T4613X-1",
    worktreePath: process.cwd(),
    initialSessionId: "initial-session",
    mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config,
    budgetUsd: 10,
    strikeCap: 1,
    initialReview: failedReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    deps: {
      spawn: opts.wrap ? opts.wrap(recorded) : recorded,
      waitForCiGreen: async () => "green" as const,
      runReview: async () => failedReview(),
      fetchPrBody: async () => "REPORT",
      push: () => {},
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => {
        if (opts.failSink && (step === "worker.assignment" || step === "worker.attempt")) throw new Error("ledger disk full");
        lines.push({ step, ...(extra ?? {}) });
      },
      say: () => {},
      account: (result: WorkerResult) => result,
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
        harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: "new-head", undeclared: [] }), ahead: () => 1 }),
    },
  };
  return { run, lines, spawns, config };
}

/** A worker that is routed like a real spawn: the assignment is announced before it runs. */
function routedWorker(id: string, over: Partial<WorkerResult> = {}) {
  return async (args: SpawnWorkerArgs) => {
    args.onSelectionAssignment?.(assignment(id));
    return worker({ selectionAssignmentId: id, ...over });
  };
}

test("W1-T4613: fix.done names the fix worker's own run id, assignment, provider, model, effort, tokens and duration", async () => {
  const rung = fixRung({ raw: routedWorker("asg-fix-1") });
  await runFixRung(rung.run);

  const done = rung.lines.find((l) => l.step === "fix.done");
  assert.ok(done, "the fix round finished");
  assert.equal(typeof done.worker_run_id, "string", "the fix worker carries a run id of its own");
  assert.notEqual(done.worker_run_id, rung.run.runId, "never the daemon's run id");
  assert.equal(done.selection_assignment_id, "asg-fix-1");
  assert.equal(done.provider, "claude");
  assert.equal(done.model, "claude-sonnet-4-5");
  assert.equal(done.effort, "high");
  assert.deepEqual(done.tokens, { input: 1200, output: 340, cacheRead: 0, cacheCreation: 0 });
  assert.equal(done.worker_duration_ms, 4321);
  // The pre-existing fields keep their values.
  assert.equal(done.cost_usd, 1.25);
  assert.equal(done.num_turns, 3);
  assert.equal(done.session_id, "fix-session");

  // The same assignment + attempt receipt pair dispatch writes, joined to fix.done by both ids.
  const assigned = rung.lines.filter((l) => l.step === "worker.assignment");
  const attempts = rung.lines.filter((l) => l.step === "worker.attempt");
  assert.equal(assigned.length, 1, "one assignment receipt per fix worker");
  assert.equal(attempts.length, 1, "one attempt receipt per fix worker");
  assert.equal((assigned[0]!.worker_assignment as { id: string }).id, "asg-fix-1");
  assert.equal((assigned[0]!.benchmark_run as { phase: string }).phase, "assignment");
  assert.equal(assigned[0]!.worker_run_id, done.worker_run_id);
  assert.equal(attempts[0]!.selection_assignment_id, "asg-fix-1");
  assert.equal(attempts[0]!.worker_run_id, done.worker_run_id);
  const receipt = attempts[0]!.benchmark_run as { phase: string; assignmentJoin: { state: string } };
  assert.equal(receipt.phase, "attempt");
  assert.equal(receipt.assignmentJoin.state, "observed");

  // The process marker is untouched: reclaim and the orphan sweep still match the caller's run.
  assert.equal(rung.spawns[0]!.runId, rung.run.runId);
});

test("W1-T4613: two fix workers under one daemon run id get distinct run ids", async () => {
  // The measured shape: every fix invocation in a daemon run logs under the same `DAEMON-<ms>`.
  const first = fixRung({ raw: routedWorker("asg-fix-1") });
  await runFixRung(first.run);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = fixRung({ raw: routedWorker("asg-fix-2") });
  await runFixRung(second.run);
  const a = first.lines.find((l) => l.step === "fix.done");
  const b = second.lines.find((l) => l.step === "fix.done");
  assert.equal(first.run.runId, second.run.runId, "the control: both ran under the daemon's one run id");
  assert.ok(a?.worker_run_id && b?.worker_run_id);
  assert.notEqual(a.worker_run_id, b.worker_run_id);
  assert.deepEqual([a.selection_assignment_id, b.selection_assignment_id], ["asg-fix-1", "asg-fix-2"]);
});

test("W1-T4613: a receipt failure never blocks or changes the fix", async () => {
  const control = fixRung({ raw: routedWorker("asg-ok") });
  const controlOutcome = await runFixRung(control.run);

  // The sink refuses every receipt row, and the worker result cannot even be turned into fields.
  const broken = fixRung({ failSink: true, raw: routedWorker("asg-broken", { tokens: undefined as unknown as WorkerResult["tokens"] }) });
  const brokenOutcome = await runFixRung(broken.run);

  assert.equal(brokenOutcome.outcome, controlOutcome.outcome, "the fix outcome is unchanged");
  assert.equal(brokenOutcome.strikes, controlOutcome.strikes);
  assert.equal(broken.spawns.length, control.spawns.length, "no retry, no extra spawn");
  const done = broken.lines.find((l) => l.step === "fix.done");
  assert.ok(done, "fix.done is still written");
  assert.equal(done.cost_usd, 1.25);
  assert.equal(done.selection_assignment_id, "asg-broken", "the join survives a lost receipt");
  assert.equal(done.worker_fields_unavailable_reason, "worker-result-fields-unavailable");
  assert.equal(done.benchmark_receipt_unavailable_reason, "worker.assignment-ledger-write-failed");
  assert.equal(typeof done.worker_run_id, "string");
});

test("W1-T4613: a worker with no observed assignment says so on fix.done", async () => {
  const rung = fixRung({ raw: async () => worker() });
  await runFixRung(rung.run);
  const done = rung.lines.find((l) => l.step === "fix.done");
  assert.ok(done);
  assert.equal(done.selection_assignment_id, undefined);
  assert.equal(done.selection_assignment_unavailable_reason, "assignment-not-observed");
  assert.equal(done.provider, "claude", "the worker's own fields are still recorded");
});

test("W1-T4613: the sweep's receipt wrapper stands aside, so a fix worker is receipted exactly once", async () => {
  const rung = fixRung({ raw: routedWorker("asg-sweep"), wrap: (raw) => benchmarkNonDispatchSpawn("sweep-fix", raw) });
  await runFixRung(rung.run);
  const sweepLedger = ledgerPathFor(rung.config);
  const sweepRows = existsSync(sweepLedger)
    ? readFileSync(sweepLedger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row)
    : [];
  const all = [...rung.lines, ...sweepRows];
  assert.equal(all.filter((l) => l.step === "worker.assignment").length, 1);
  assert.equal(all.filter((l) => l.step === "worker.attempt").length, 1);
  const done = rung.lines.find((l) => l.step === "fix.done");
  assert.equal(done?.selection_assignment_id, "asg-sweep");

  // The control: the same wrapper on a spawn the fix rung does NOT own still writes its receipts.
  const direct = benchmarkNonDispatchSpawn("sweep-fix", routedWorker("asg-direct"));
  await direct({ cwd: process.cwd(), permissionMode: "bypassPermissions", settingsFile: "x", prompt: "p", config: rung.config, runId: "DAEMON-x", taskId: "W1-T4613X" });
  const after = readFileSync(sweepLedger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
  assert.equal(after.filter((l) => l.step === "worker.assignment").length, 1);
  assert.equal(after.filter((l) => l.step === "worker.attempt").length, 1);
});
