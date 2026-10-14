/**
 * W1-T8676 — A RESTORED CHECKPOINT OUTLIVES ITS RUN'S WORKER ERROR. On 2026-10-12 W1-T8502's resume restored
 * run-W1-T8502-1791807256528 at 12:45Z and ended `failed error_codex` at 13:17Z. That verdict consumed the receipt
 * its own restore had just used, so from 14:34Z every pass refused the P1 as run-branch-already-pushed, although
 * its latch had released. These tests drive the receipt fold, the real runTask restore path, the real runDaemon
 * selection pass and the real independent-failure latch with rows shaped like W1-T8502's.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs, runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS, rotateLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import {
  INDEPENDENT_BLOCK_BASE_BACKOFF_MS, INDEPENDENT_BLOCK_RELEASED_STEP, buildLedgerIndex,
  independentFailureLatch, type IndependentBlockRelease, type StatusProjection,
} from "../src/lib/status.js";
import * as status from "../src/lib/status.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { restoreBoundaryCheckpoint, runTask, type RunResult } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T9676";
const SOURCE = `run-${TASK}-1791807256528`;
const HEAD = "9b542262d".padEnd(40, "0");
const T0 = Date.parse("2026-10-12T12:14:25.000Z");
const MINUTE = 60_000;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));

const receipt = (): Record<string, unknown> =>
  ({ ts: at(0), task_id: TASK, run_id: "r1", step: "run.freshness_handoff", waiting_on: "worker", branch: SOURCE, head_sha: HEAD });
const restored = (run = "r2"): Record<string, unknown> =>
  ({ ts: at(31 * MINUTE), task_id: TASK, run_id: run, step: "implement.checkpoint_restored", source_branch: SOURCE,
    source_head_sha: HEAD, branch: `run-${TASK}-1791809077557`, base: "main" });
const workerFailure = (run = "r2", extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: at(63 * MINUTE), task_id: TASK, run_id: run, step: "verdict", verdict: "failed", stage: "implement.continued",
    subtype: "error_codex", provider: "codex", reason: "worker error at implement.continued: error_codex", ...extra });
const kept = (run = "r2", extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: at(63 * MINUTE + 1), task_id: TASK, run_id: run, step: "implement.checkpoint_kept", source_branch: SOURCE,
    head_sha: HEAD, failed_stage: "implement.continued", failed_subtype: "error_codex", ...extra });

function worker(text: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...overrides };
}

/** A checkpoint branch on a bare origin, a fresh clone as the run's managed checkout, and a ledger holding the
 *  handoff receipt for that branch's exact head — the state W1-T8502's 12:44:59Z run started from. */
function checkpointFixture() {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.git("config", "user.name", "checkpoint fixture");
  seed.git("config", "user.email", "checkpoint@fixture.invalid");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "--quiet", "-b", SOURCE);
  writeFileSync(join(seed.dir, "paid-work.txt"), "checkpoint work\n");
  seed.git("add", "paid-work.txt");
  seed.git("commit", "--quiet", "-m", "wip: checkpoint work");
  const headSha = seed.git("rev-parse", "HEAD");
  seed.git("push", "--quiet", "origin", SOURCE);
  seed.git("checkout", "--quiet", "main");
  const clone = gitRepo({ cloneFrom: `file://${origin.dir}` });
  clone.git("config", "user.name", "checkpoint fixture");
  clone.git("config", "user.email", "checkpoint@fixture.invalid");
  const root = gitRepo();
  mkdirSync(join(root.dir, "repos"));
  renameSync(clone.dir, join(root.dir, "repos", "remudero"));
  mkdirSync(join(root.dir, "state"));
  const ledgerPath = join(root.dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, lines([{ task_id: TASK, step: "run.freshness_handoff", waiting_on: "worker", branch: SOURCE,
    head_sha: headSha }]).join("\n") + "\n");
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, `- id: ${TASK}\n  title: checkpoint fixture\n  repo: remudero\n  type: implement\n  verify: auto\n` +
    `  risk: high\n  origin: test\n  status: queued\n  files: [paid-work.txt]\n`);
  const readRows = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const cleanup = () => { root.cleanup(); clone.cleanup(); seed.cleanup(); origin.cleanup(); };
  return { origin, root, headSha, ledgerPath, planPath, readRows, cleanup };
}

/** One real runTask dispatch of the fixture's task whose workers the caller scripts. */
function dispatch(f: ReturnType<typeof checkpointFixture>, spawn: (args: { cwd: string }, call: number) => Promise<WorkerResult>) {
  let calls = 0;
  return withLiveWritesAllowed(() => runTask(TASK, {
    config: { claudeBin: "/bin/true", root: f.root.dir, installRoot: process.cwd() },
    skipGitSync: true, planPath: f.planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "checkpoint-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: () => undefined,
    spawn: async (args) => spawn(args as { cwd: string }, ++calls),
  }));
}

const codexError = (subtype = "error_codex") => worker("", { isError: true, subtype, provider: "codex" } as Partial<WorkerResult>);

test("W1-T8676: a restored checkpoint stays pending after its run fails with a worker error", async () => {
  // The fold: W1-T8502's own rows. The verdict consumes the receipt; the kept row re-pends exactly that head.
  const history = [receipt(), restored(), workerFailure(), kept()];
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(history)).get(TASK), { branch: SOURCE, headSha: HEAD });
  assert.equal(pendingWorkerBoundaryHandoffs(lines(history.slice(0, 3))).size, 0, "without the kept row the verdict consumed it");

  // Rotation keeps the kept row beside the receipt it re-pends, so the receipt cannot read consumed again.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("implement.checkpoint_kept"));
  const store = gitRepo();
  try {
    const ledgerPath = join(store.dir, "ledger.ndjson");
    writeFileSync(ledgerPath, lines([...history, { step: "ci.polling", detail: "x".repeat(4096) }]).join("\n") + "\n");
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: 1024, smoothingWindowMs: 0 }).rotated, true);
    const rotated = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.ok(rotated.some((raw) => JSON.parse(raw).step === "implement.checkpoint_kept"), "rotation kept the kept row");
    assert.deepEqual(pendingWorkerBoundaryHandoffs(rotated).get(TASK), { branch: SOURCE, headSha: HEAD });
  } finally { store.cleanup(); }

  // The writer: a real dispatch restores the checkpoint, its implement worker errors, and run-task keeps it.
  const f = checkpointFixture();
  try {
    let implementCwd = "";
    const outcome = await dispatch(f, async (args, call) => {
      if (call === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
      implementCwd = args.cwd;
      assert.equal(readFileSync(join(args.cwd, "paid-work.txt"), "utf8"), "checkpoint work\n", "the worker sees the restored work");
      return codexError();
    });
    assert.equal(outcome.verdict, "failed");
    assert.ok(implementCwd, "the implement worker ran");
    const rows = f.readRows();
    const restoredRow = rows.find((row) => row.step === "implement.checkpoint_restored");
    assert.equal(restoredRow?.source_branch, SOURCE);
    const verdictAt = rows.findIndex((row) => row.step === "verdict");
    const keptAt = rows.findIndex((row) => row.step === "implement.checkpoint_kept");
    assert.ok(verdictAt >= 0 && keptAt === verdictAt + 1, "ONE kept row, right after the verdict");
    assert.equal(rows.filter((row) => row.step === "implement.checkpoint_kept").length, 1);
    const keptRow = rows[keptAt]!;
    assert.equal(keptRow.task_id, TASK);
    assert.equal(keptRow.run_id, rows[verdictAt]!.run_id);
    assert.equal(keptRow.source_branch, SOURCE);
    assert.equal(keptRow.head_sha, f.headSha);
    assert.equal(keptRow.failed_stage, "implement");
    assert.equal(keptRow.failed_subtype, "error_codex");
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(rows)).get(TASK), { branch: SOURCE, headSha: f.headSha });
  } finally { f.cleanup(); }
});

test("W1-T8676: any other verdict still consumes the receipt", async () => {
  for (const end of [
    { verdict: "no_pr", reason: "completed" },
    { verdict: "failed", reason: "tests failed" },
    { verdict: "blocked_budget", reason: "worker breached maxBudgetUsd — not retried (dollars are the backstop)" },
    { verdict: "handed_off", reason: "freshness_yield", pr_url: "https://github.com/o/r/pull/1" },
  ]) {
    const rows = [receipt(), restored(), { ...workerFailure(), ...end }];
    assert.equal(pendingWorkerBoundaryHandoffs(lines(rows)).size, 0, `${end.verdict} consumes the receipt`);
  }
  // A kept row only re-pends a well-formed run branch of its own task at a full sha.
  for (const bad of [{ source_branch: "main" }, { source_branch: `run-W1-T1-1` }, { head_sha: "abc" }, { source_branch: 7 }]) {
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(), workerFailure(), kept("r2", bad)])).size, 0);
  }
  // A later verdict consumes the kept receipt as it would any other.
  assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(), workerFailure(), kept(), { ...workerFailure("r3"), verdict: "no_pr" }])).size, 0);

  // A budget breach writes no kept row: dollars are the backstop.
  const budget = checkpointFixture();
  try {
    const outcome = await dispatch(budget, async () => worker("", { isError: true, subtype: "error_max_budget_usd" }));
    assert.equal(outcome.verdict, "blocked_budget");
    const rows = budget.readRows();
    assert.ok(rows.some((row) => row.step === "implement.checkpoint_restored"));
    assert.equal(rows.some((row) => row.step === "implement.checkpoint_kept"), false);
    assert.equal(pendingWorkerBoundaryHandoffs(lines(rows)).size, 0);
  } finally { budget.cleanup(); }

  // A run that pushed its own branch: that branch is the newer checkpoint (W1-T7837), so nothing is kept.
  const pushed = checkpointFixture();
  try {
    const outcome = await dispatch(pushed, async (args, call) => {
      if (call === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
      const own = pushed.origin.git("-C", args.cwd, "rev-parse", "--abbrev-ref", "HEAD");
      pushed.origin.git("-C", args.cwd, "push", "--quiet", "origin", `HEAD:refs/heads/${own}`);
      return codexError();
    });
    assert.equal(outcome.verdict, "failed");
    const rows = pushed.readRows();
    assert.ok(rows.some((row) => row.step === "implement.checkpoint_restored"));
    assert.equal(rows.some((row) => row.step === "implement.checkpoint_kept"), false);
    assert.equal(pendingWorkerBoundaryHandoffs(lines(rows)).size, 0);
  } finally { pushed.cleanup(); }
});

type Row = { step: string; extra?: Record<string, unknown> };

/** The real runDaemon at one lane over a ledger the fakes and the daemon both append to, with a projection that is
 *  the real latch over that ledger — the shape of the production status projection, with nothing else faked. */
async function daemonOver(opts: {
  runOne: (call: number, ledger: Record<string, unknown>[], stamp: () => string) => Promise<RunResult>;
  branches: () => string;
  stopWhen: (started: number) => boolean;
  readLedgerLines?: (ledger: Record<string, unknown>[], reads: number) => readonly string[];
}) {
  const store = gitRepo();
  const path = join(store.dir, "tasks.yaml");
  writeFileSync(path, `- id: ${TASK}\n  title: ${TASK}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/x.ts]\n`);
  let offset = 0;
  const stamp = () => at(++offset * 1000);
  const ledger: Record<string, unknown>[] = [];
  const rows: Row[] = [];
  const merged = new Set<string>();
  let started = 0;
  let checks = 0;
  let reads = 0;
  const latch = (id: string) => {
    const now = ledger.reduce((latest, row) => Math.max(latest, Date.parse(String(row.ts))), T0);
    return independentFailureLatch(ledger, id, undefined, now);
  };
  try {
    await runDaemon(loadPlan(path), {
      refreshMerged: () => (id: string) => merged.has(id),
      readPushedRunBranches: opts.branches,
      readLedgerLines: () => (opts.readLedgerLines ?? ((l) => lines(l)))(ledger, ++reads),
      isIndependentFailureBlocked: (id) => latch(id).blocked,
      independentBlockReleases: () => {
        const release = latch(TASK).release;
        return new Map(release ? [[TASK, release]] : []);
      },
      checkStop: () => (opts.stopWhen(started) || ++checks > 60 ? "test done" : undefined),
      log: (step, extra) => { rows.push({ step, extra }); ledger.push({ ts: stamp(), step, ...extra }); },
      runOne: async () => {
        const result = await opts.runOne(++started, ledger, stamp);
        if (result.merged) merged.add(TASK);
        return result;
      },
      sleep: async () => { await drainMicrotasks(); },
    } as DaemonDeps, { laneCount: 1, max: 60 });
  } finally { store.cleanup(); }
  return { rows, ledger, started };
}

const skippedForBranch = (rows: Row[]) =>
  rows.filter((r) => r.step === "dispatch.skipped" && r.extra?.reason === "run-branch-already-pushed");

test("W1-T8676: a kept checkpoint branch is not refused on the next pass", async () => {
  // One process: run 1 hands off (pushing SOURCE at HEAD and writing the receipt MID-PROCESS); run 2 restores it and
  // ends failed through a worker error; run 3 must still be offered, and must find the kept checkpoint to restore.
  let branches = "";
  let restoreInput: { branch: string; headSha: string } | undefined;
  const { rows, ledger, started } = await daemonOver({
    branches: () => branches,
    stopWhen: (n) => n >= 3,
    runOne: async (call, ledger, stamp) => {
      if (call === 1) {
        branches = `${HEAD}\trefs/heads/${SOURCE}\n`;
        ledger.push({ ts: stamp(), task_id: TASK, run_id: "r1", step: "verdict", verdict: "handed_off",
          reason: "freshness_yield", branch: SOURCE, head_sha: HEAD });
        return { taskId: TASK, runId: "r1", merged: false, verdict: "handed_off", costUsd: 0 } as RunResult;
      }
      if (call === 2) {
        ledger.push({ ...restored(), ts: stamp() }, { ...workerFailure(), ts: stamp() }, { ...kept(), ts: stamp() });
        // Another lane's codex worker ends clean: the provider has recovered.
        ledger.push({ ts: stamp(), task_id: "W1-T9999", run_id: "o1", step: "implement.done", provider: "codex", subtype: "success" });
        return { taskId: TASK, runId: "r2", merged: false, verdict: "failed", costUsd: 0 } as RunResult;
      }
      restoreInput = pendingWorkerBoundaryHandoffs(lines(ledger)).get(TASK);
      return { taskId: TASK, runId: "r3", merged: true, verdict: "merged", costUsd: 0, prUrl: "https://x/1" } as RunResult;
    },
  });
  assert.deepEqual(skippedForBranch(rows).map((r) => r.extra?.task), [], "no pass refused the kept checkpoint's branch");
  assert.equal(started, 3, "the handoff, the failed restore and the next dispatch all ran in one process");
  assert.ok(ledger.some((row) => row.step === "dispatch.blocked_independent" && row.run_id === "r2"), "run 2 latched");
  assert.deepEqual(restoreInput, { branch: SOURCE, headSha: HEAD }, "the next dispatch reads the kept checkpoint");

  // …and that dispatch's restore really restores the kept head from origin.
  const f = checkpointFixture();
  try {
    const workRoot = join(f.root.dir, "repos", "remudero");
    const git = async (args: string[]) => f.origin.git("-C", workRoot, ...args);
    const keptRows = lines([{ task_id: TASK, step: "run.freshness_handoff", waiting_on: "worker", branch: SOURCE, head_sha: f.headSha },
      workerFailure(), kept("r2", { head_sha: f.headSha })]);
    const checkpoint = pendingWorkerBoundaryHandoffs(keptRows).get(TASK)!;
    const result = await restoreBoundaryCheckpoint(checkpoint, TASK, git);
    assert.equal(result.base, "main");
    assert.equal(result.headSha, f.headSha);
    assert.equal(readFileSync(join(workRoot, "paid-work.txt"), "utf8"), "checkpoint work\n");
  } finally { f.cleanup(); }
});

test("W1-T8676: a settled run's receipt refresh keeps the prior receipt when the ledger read throws", async () => {
  let branches = "";
  const { rows, started } = await daemonOver({
    branches: () => branches,
    stopWhen: (n) => n >= 2,
    readLedgerLines: (ledger, reads) => {
      if (reads === 1) return lines([receipt()]);
      throw new Error("ledger unreadable");
    },
    runOne: async (call) => {
      branches = `${HEAD}\trefs/heads/${SOURCE}\n`;
      return { taskId: TASK, runId: `r${call}`, merged: call === 2, verdict: call === 2 ? "merged" : "handed_off", costUsd: 0 } as RunResult;
    },
  });
  assert.ok(rows.some((r) => r.step === "daemon.handoff_receipt_refresh_failed" && r.extra?.task_id === TASK));
  assert.deepEqual(skippedForBranch(rows), [], "the boot receipt still excuses its branch");
  assert.equal(started, 2);
});

/** A failed run of TASK and the block the daemon writes for it, `verdictExtra` shaping its verdict row. */
function latchedRun(run: string, offsetMs: number, verdictExtra: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    { ts: at(offsetMs), task_id: TASK, run_id: run, step: "run.start" },
    { ...workerFailure(run), ts: at(offsetMs + 1000), ...verdictExtra },
    { ts: at(offsetMs + 2000), task_id: TASK, task: TASK, run_id: run, step: "dispatch.blocked_independent", verdict: "failed" },
  ];
}
const clean = (offsetMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: at(offsetMs), task_id: "W1-T9999", run_id: "o1", step: "implement.done", provider: "codex", subtype: "success", ...extra });

test("W1-T8676: a worker-error latch re-offers once the provider serves a clean end", () => {
  const latched = latchedRun("r2", 0);
  for (const indexed of [false, true]) {
    const latch = (rows: Record<string, unknown>[], nowOffsetMs = 3 * MINUTE) =>
      independentFailureLatch(rows, TASK, indexed ? buildLedgerIndex(rows) : undefined, T0 + nowOffsetMs);
    assert.equal(latch(latched).blocked, true, "no clean result yet");
    for (const notYet of [
      clean(500), // before the failure
      clean(MINUTE, { provider: "claude" }), // another provider
      clean(MINUTE, { subtype: "error_codex" }), // not a clean end
      clean(MINUTE, { api_error: true }),
      clean(MINUTE, { step: "fix.dispatch" }), // not a worker result row
      { ...clean(MINUTE), ts: "not a time" },
    ]) assert.equal(latch([...latched, notYet]).blocked, true, JSON.stringify(notYet));
    for (const step of ["recon.done", "implement.done", "implement.continued", "fix.done"]) {
      const result = latch([...latched, clean(MINUTE, { step })]);
      assert.equal(result.blocked, false, `${step} from the same provider releases it`);
      assert.equal(result.release?.evidence, "provider_recovered");
      assert.equal(result.release?.backoffMs, 0, "no back-off");
      assert.equal(result.release?.blockingRunId, "r2");
      assert.equal(result.release?.provider, "codex");
      assert.equal(result.release?.recoveredStep, step);
      assert.equal(result.release?.recoveredAt, at(MINUTE));
    }
    const first = latch([...latched, clean(2 * MINUTE), clean(MINUTE, { step: "recon.done", task_id: "W1-T9998" })]);
    assert.equal(first.release?.recoveredAt, at(MINUTE), "the FIRST later clean row is the evidence");
    assert.equal(first.release?.recoveredTaskId, "W1-T9998");
  }
  // The verdict row may lack the provider: the run's own worker row names it.
  const unnamed = latchedRun("r2", 0, { provider: undefined });
  unnamed.splice(1, 0, { ts: at(500), task_id: TASK, run_id: "r2", step: "implement.continued", provider: "codex", subtype: "error_codex" });
  assert.equal(independentFailureLatch([...unnamed, clean(MINUTE)], TASK, undefined, T0 + 2 * MINUTE).blocked, false);
  // A run whose provider no row names cannot be judged recovered; it keeps W1-T7533's rule.
  assert.equal(independentFailureLatch([...latchedRun("r2", 0, { provider: undefined }), clean(MINUTE)], TASK, undefined, T0 + 2 * MINUTE).blocked, true);
  // A signal-ended worker is a worker error too.
  const signalled = latchedRun("r2", 0, { reason: "worker ended by signal SIGKILL at implement" });
  assert.equal(independentFailureLatch([...signalled, clean(MINUTE)], TASK, undefined, T0 + 2 * MINUTE).blocked, false);
  // A recorded release row marks the receipt, so the daemon does not ledger it again.
  const recorded = [...latched, clean(MINUTE), { ts: at(2 * MINUTE), task_id: TASK, step: INDEPENDENT_BLOCK_RELEASED_STEP, blocking_run_id: "r2" }];
  assert.equal(independentFailureLatch(recorded, TASK, undefined, T0 + 3 * MINUTE).release?.receiptRecorded, true);
});

test("W1-T8676: a task-caused latch keeps its back-off", () => {
  const merge = { ts: at(30 * MINUTE), task_id: "W1-T8000", step: "verdict.merged", pr_url: "https://github.com/o/r/pull/1" };
  for (const verdictExtra of [
    { reason: "tests failed" },
    { reason: undefined },
    { verdict: "no_pr", reason: "completed" },
  ]) {
    const rows = latchedRun("r2", 0, verdictExtra);
    if (verdictExtra.verdict === "no_pr") rows[2] = { ...rows[2]!, verdict: "no_pr" };
    const withClean = [...rows, clean(MINUTE), merge];
    const early = independentFailureLatch(withClean, TASK, undefined, T0 + 31 * MINUTE);
    assert.equal(early.blocked, true, "a clean provider result does not release a task-caused failure");
    assert.equal(early.release, undefined);
    const late = independentFailureLatch(withClean, TASK, undefined, T0 + INDEPENDENT_BLOCK_BASE_BACKOFF_MS + 3000);
    assert.equal(late.blocked, false, "W1-T7533's back-off and main_moved still release it");
    assert.equal(late.release?.evidence, "main_moved");
    assert.equal(late.release?.backoffMs, INDEPENDENT_BLOCK_BASE_BACKOFF_MS);
  }
  // A worker-error latch whose provider never recovers falls back to the same W1-T7533 rule.
  const unrecovered = independentFailureLatch([...latchedRun("r2", 0), merge], TASK, undefined, T0 + INDEPENDENT_BLOCK_BASE_BACKOFF_MS + 3000);
  assert.equal(unrecovered.release?.evidence, "main_moved");
});

test("W1-T8676: each latch release is ledgered once", async () => {
  const release = (blockingRunId: string, evidence: IndependentBlockRelease["evidence"], extra: Partial<IndependentBlockRelease> = {}) =>
    ({ blockingRunId, blockedAt: at(0), evidence, latchCount: 1, backoffMs: 0, receiptRecorded: false, ...extra }) as IndependentBlockRelease;
  const releases = new Map<string, IndependentBlockRelease>([
    ["A", release("ra", "provider_recovered", { provider: "codex", recoveredAt: at(MINUTE), recoveredTaskId: "W1-T9999", recoveredStep: "implement.done" })],
    ["B", release("rb", "main_moved", { mergedTaskId: "W1-T8000", mergedAt: at(2 * MINUTE), backoffMs: INDEPENDENT_BLOCK_BASE_BACKOFF_MS })],
    ["C", release("rc", "contract_revised")],
    ["D", release("rd", "main_moved", { receiptRecorded: true })],
  ]);
  // The projection reader the daemon command wires: every task's projected release, and nothing else.
  // Read off the namespace, so a checkout without the reader fails this test rather than the whole file's load.
  const { independentBlockReleasesFrom } = status as unknown as {
    independentBlockReleasesFrom: (p: ReadonlyMap<string, StatusProjection> | undefined) => ReadonlyMap<string, IndependentBlockRelease>;
  };
  const projection = new Map<string, StatusProjection>([...releases].map(([id, r]) => [id, { independentBlockRelease: r } as StatusProjection]));
  projection.set("E", {} as StatusProjection);
  assert.deepEqual([...independentBlockReleasesFrom(projection).keys()], ["A", "B", "C", "D"]);
  assert.equal(independentBlockReleasesFrom(undefined).size, 0);

  const store = gitRepo();
  const path = join(store.dir, "tasks.yaml");
  writeFileSync(path, ["A", "B", "C", "D"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const rows: Row[] = [];
  let reads = 0;
  try {
    await runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      isIndependentFailureBlocked: () => true,
      independentBlockReleases: () => { reads++; return releases; },
      checkStop: () => (reads >= 4 ? "test done" : undefined),
      log: (step, extra) => { rows.push({ step, extra }); },
      runOne: async () => { throw new Error("nothing is eligible"); },
      sleep: async () => { await drainMicrotasks(); },
    } as DaemonDeps, { laneCount: 1, max: 20 });
  } finally { store.cleanup(); }
  assert.ok(reads >= 3, `several selection passes read the releases (${reads})`);
  const written = rows.filter((r) => r.step === INDEPENDENT_BLOCK_RELEASED_STEP).map((r) => r.extra);
  assert.deepEqual(written.map((r) => r?.blocking_run_id), ["ra", "rb", "rc"], "once per blocking run; a recorded one never");
  assert.deepEqual(written[0], { task_id: "A", blocking_run_id: "ra", blocked_at: at(0), evidence: "provider_recovered",
    evidence_at: at(MINUTE), latch_count: 1, backoff_ms: 0, provider: "codex", recovered_task_id: "W1-T9999", recovered_step: "implement.done" });
  assert.deepEqual(written[1], { task_id: "B", blocking_run_id: "rb", blocked_at: at(0), evidence: "main_moved",
    evidence_at: at(2 * MINUTE), latch_count: 1, backoff_ms: INDEPENDENT_BLOCK_BASE_BACKOFF_MS, merged_task_id: "W1-T8000" });
  assert.deepEqual(written[2], { task_id: "C", blocking_run_id: "rc", blocked_at: at(0), evidence: "contract_revised",
    evidence_at: null, latch_count: 1, backoff_ms: 0 });
});
