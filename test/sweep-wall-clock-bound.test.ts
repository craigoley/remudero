/**
 * test/sweep-wall-clock-bound.test.ts — W1-T1044 (A SWEEP TICK HAS NO WALL-CLOCK BOUND, SO A
 * FIX-RUNG WORKER THAT NEVER RETURNS PARKS THE DAEMON INDEFINITELY).
 *
 * A NEW, DEDICATED file (per the task's own `note:` — a coverage-load-bearing test stays out
 * of a shared suite), never `test/daemon.test.ts`/`test/run-task.test.ts`. Covers BOTH bound
 * placements the task requires together:
 *   (a) `await deps.sweep()` in `src/lib/daemon.ts`'s poll loop — frees the DAEMON.
 *   (b) ONE `deps.spawn` call inside `runFixRung` (`src/run-task.ts`) — RECLAIMS the worker.
 * Neither alone is sufficient (see the task's `note:`): (a) alone converts a parked daemon
 * into an orphan nothing reaps; (b) alone bounds only the fix-rung spawner, not whatever else
 * a sweep might hang on.
 */
import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS, type DaemonDeps } from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { appendLedger } from "../src/lib/ledger.js";
import type { MergedSet } from "../src/lib/drain.js";
import { reclaimAbandonedWorker, runFixRung, runTask, type FixRungOutcome } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { loadPolicy, installPolicyPath } from "../src/lib/policy.js";
import type { Config } from "../src/lib/config.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Mount } from "../src/lib/mounts.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

const NONE_MERGED: MergedSet = () => false;

/** One independent, runnable task — no deps, nothing else in the plan to race it. */
function fixturePlanWithOneRunnableTask(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `
- id: W1-T1044FIX
  title: a runnable task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
  );
  return loadPlan(f);
}

function emptyPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-empty-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "[]\n");
  return loadPlan(f);
}

/**
 * The bound is a REAL `setTimeout` (see daemon.ts's own sweep-call-site comment for why: the
 * in-flight ticker already owns the injected `deps.sleep` cadence for its `daemon.alive`
 * heartbeat, and racing a SECOND consumer against that SAME fake clock would double the
 * sleep-call count every other daemon.ts suite counts as its idle proxy). These tests drive it
 * with small REAL millisecond values instead — the identical choice `spawnFixWorkerBounded`'s
 * own tests (below) make for the worker-spawn bound.
 */
const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── (a) the daemon-side bound on `await deps.sweep()` ──────────────────────────────────────

test("W1-T1044: an over-running sweep returns control to the loop", async () => {
  // An EMPTY plan (nothing ever dispatches, ever) — `DaemonOpts.max` counts DISPATCH attempts,
  // never idle ticks, so this test's own stop condition is `checkStop`/`requestStop`
  // (fleet-control.ts, the same mechanism every idle-tick daemon.test.ts fixture uses).
  const root = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-"));
  const plan = emptyPlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepStarted = false;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("nothing runnable in this fixture — runOne must never be called");
      },
      sleep: REAL_SLEEP,
      // Never resolves, never rejects — the falsifier this test exists to catch is `runDaemon`
      // hanging forever on this exact await, the measured incident's own shape.
      sweep: () => {
        sweepStarted = true;
        return new Promise<void>(() => {});
      },
      checkStop: () => stopDetail(root),
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.sweep.abandoned") requestStop(root, "test observed the abandonment");
      },
    },
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.ok(sweepStarted, "the sweep genuinely started");
  assert.equal(s.stopReason, "stopped", "the tick completed — control returned to the loop rather than hanging");
  const abandoned = lines.find((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandoned, `expected a daemon.sweep.abandoned line, saw steps: ${lines.map((l) => l.step).join(", ")}`);
  assert.equal(abandoned!.extra.bound_ms, 20);
  assert.ok((abandoned!.extra.elapsed_ms as number) >= 15, "elapsed_ms reflects the bound that fired it");
});

test("W1-T1044: the tick after an abandoned sweep reaches dispatch", async () => {
  const plan = fixturePlanWithOneRunnableTask();
  const dispatched: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        dispatched.push(id);
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sleep: REAL_SLEEP,
      sweep: () => new Promise<void>(() => {}), // same never-returning occupant as above
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(
    lines.some((l) => l.step === "daemon.sweep.abandoned"),
    "the sweep was genuinely abandoned this tick, not skipped for some other reason",
  );
  assert.deepEqual(dispatched, ["W1-T1044FIX"], "dispatch ran, in the SAME tick, once the abandoned sweep stopped blocking it");
});

test("W1-T1044: a sweep inside the bound completes untouched", async () => {
  // THE FIRST TEST THE TASK'S OWN NOTE DEMANDS BE WRITTEN (design note: "so a sweep that is
  // merely slow is never abandoned") — proven here as a dedicated, independently-titled case
  // rather than folded into the abandonment tests above. Same `checkStop`/`requestStop`
  // mechanism as the over-running case above — an empty plan never trips `DaemonOpts.max`.
  const root = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-inside-"));
  const plan = emptyPlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepCompleted = false;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("nothing runnable in this fixture");
      },
      sleep: REAL_SLEEP,
      sweep: async () => {
        // Slow, but well inside a 200ms bound.
        await new Promise((resolve) => setTimeout(resolve, 20));
        sweepCompleted = true;
        requestStop(root, "test observed the sweep complete");
      },
      checkStop: () => stopDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { pollIntervalMs: 30, sweepWallClockBoundMs: 200 },
  );
  assert.equal(s.stopReason, "stopped");
  assert.ok(sweepCompleted, "the sweep ran to completion, untouched by the bound");
  assert.ok(
    !lines.some((l) => l.step === "daemon.sweep.abandoned"),
    "a merely-slow, healthy sweep must never be abandoned",
  );
});

// ── the bound is policy data ────────────────────────────────────────────────────────────────

test("W1-T1044: the sweep bound is read from policy", () => {
  // The COMMITTED row parses to the SAME default this task's daemon.ts/run-task.ts code falls
  // back to when no override is threaded — proving daemon.ts's own default MIRRORS the policy
  // row rather than the two silently drifting apart.
  const committed = loadPolicy(installPolicyPath());
  assert.equal(
    committed.values.sweepWallClockBoundMs,
    DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS,
    "plan/policy.yaml's sweepWallClockBoundMs row and daemon.ts's own default must agree",
  );

  // AND it is genuinely READ, not a literal masquerading as one: a policy.yaml carrying a
  // DIFFERENT value must produce that DIFFERENT value out of `loadPolicy` — never the
  // committed row's number no matter what the file on disk actually says.
  const real = readFileSync(installPolicyPath(), "utf8");
  assert.match(real, /sweepWallClockBoundMs:/, "the row must actually exist in the committed file");
  const distinctValue = DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS + 12_345;
  const mutated = real.replace(
    /sweepWallClockBoundMs:\n(\s+)value: \d+/,
    `sweepWallClockBoundMs:\n$1value: ${distinctValue}`,
  );
  assert.notEqual(mutated, real, "the regex must actually have matched and rewritten the row");
  const dir = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-policy-"));
  const mutatedPath = join(dir, "policy.yaml");
  writeFileSync(mutatedPath, mutated);
  const reloaded = loadPolicy(mutatedPath);
  assert.equal(reloaded.values.sweepWallClockBoundMs, distinctValue, "loadPolicy must reflect the file on disk, not a hardcoded literal");
});

// ── (b) the worker-spawn bound + reclaim inside runFixRung ─────────────────────────────────

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criteria: CriterionVerdict[] = [
    { claim: "criterion A merges cleanly", met: false, reason: "reason-A-missing", proof: "proof", proof_exec: "not_executable" },
  ];
  return {
    state: "failure",
    criteria,
    testTheater: false,
    summary: "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
}

function fixRungBaseOpts() {
  return {
    taskId: "W1-T1044FIX",
    runId: "W1-T1044FIX-1730000000000",
    task: { id: "W1-T1044FIX", title: "a task whose fix worker never returns" },
    prUrl: "https://github.com/acme/remudero/pull/1044",
    branch: "run-W1-T1044FIX-1730000000000",
    worktreePath: "/tmp/rmd-sweep-wall-clock-bound-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-sweep-wall-clock-bound-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 2,
    initialReview: fixReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-sweep-wall-clock-bound-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-sweep-wall-clock-bound-ledger-")), "ledger.ndjson");
}

const NEVER_ISSUES: IssueGateway = {
  create() {
    throw new Error("no escalation expected — a spawn that never returns is never a strike, so the rung never exhausts");
  },
};

test("W1-T1044: an abandoned worker is reclaimed not orphaned", async () => {
  const reclaimCalls: Array<{ runId: string; taskId: string; elapsedMs: number }> = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      // A worker that NEVER RETURNS — the measured incident's own shape (an `until` loop with
      // no exit condition it can reach).
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: (info) => {
        reclaimCalls.push(info);
      },
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  assert.equal(reclaimCalls.length, 1, "the abandoned worker was reclaimed exactly once — never left running");
  assert.equal(reclaimCalls[0].runId, "W1-T1044FIX-1730000000000");
  assert.equal(reclaimCalls[0].taskId, "W1-T1044FIX");
  assert.ok(reclaimCalls[0].elapsedMs >= 15, `expected roughly the 20ms bound, saw ${reclaimCalls[0].elapsedMs}ms`);
});

test("W1-T1044: abandoning a sweep records the task and elapsed time", async () => {
  const events: Array<{ kind: "log" | "reclaim"; step?: string; extra?: Record<string, unknown> }> = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra = {}) => events.push({ kind: "log", step, extra }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: () => {
        events.push({ kind: "reclaim" });
      },
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  const abandonedLine = events.find((e) => e.kind === "log" && e.step === "fix.spawn_abandoned");
  assert.ok(abandonedLine, "abandoning a spawn must be recorded, never silent");
  assert.equal(abandonedLine!.extra!.task_id, "W1-T1044FIX", "the task is named");
  assert.equal(abandonedLine!.extra!.run_id, "W1-T1044FIX-1730000000000", "the run is named");
  // A real `setTimeout`, not a fake clock — allow a few ms either side of the requested bound
  // rather than pinning exact timer precision; the claim under test is that a real, non-zero
  // duration is NAMED at all, not that it lands on the millisecond.
  assert.ok((abandonedLine!.extra!.elapsed_ms as number) >= 15, "the elapsed time is named");

  // RECORDS BEFORE IT RECLAIMS (the task's own design note): a killed worker's own `verdict`
  // row never lands (it only writes when a run ENDS), so the ledger line is the only record
  // this abandonment ever happened — it must exist BEFORE the reclaim, not merely alongside it.
  const abandonedIndex = events.findIndex((e) => e.kind === "log" && e.step === "fix.spawn_abandoned");
  const reclaimIndex = events.findIndex((e) => e.kind === "reclaim");
  assert.ok(abandonedIndex >= 0 && reclaimIndex >= 0);
  assert.ok(abandonedIndex < reclaimIndex, "the abandonment is ledgered BEFORE the worker is reclaimed");
  assert.equal(outcome.spawnAbandonedElapsedMs, abandonedLine!.extra!.elapsed_ms, "the outcome and the ledger line report the SAME elapsed time");
});

/** Parse an NDJSON ledger file's lines into plain records — the same shape `readLedgerLines`
 *  (status.ts) reads, kept local so this file's own claim ("no recorded state") is checked
 *  against the REAL bytes on disk, not a second in-memory recorder that could drift from what
 *  `appendLedger` actually writes. */
function readLedgerRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T1044: an unsensed worker is bounded by elapsed time", async () => {
  // "NO RECORDED STATE" IS A LEDGER FACT, NOT MERELY AN OMITTED CALLBACK — this task's own
  // rationale (5): ALL `worker.state` rows in the production corpus carry a dispatch-lane
  // run_id and ZERO carry a sweep-/fix-shaped one, so a detector keyed on worker silence has no
  // subject to watch for THIS lane. Proven here against a REAL ledger file (`deps.log` wired to
  // the real `appendLedger`, never a swallowing no-op): after the run, the ledger is read back
  // off disk and asserted to carry ZERO `worker.state` rows for this run — the worker was
  // genuinely never sensed — while STILL carrying the abandonment. The bound is not merely
  // "untested against a liveness signal"; it demonstrably does not need one to fire.
  const ledgerPath = tmpLedgerPath();
  const runId = "W1-T1044FIX-1730000000001";
  const start = Date.now();
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    runId,
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}), // never resolves, never emits any signal
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath,
      log: (step, extra = {}) => appendLedger(ledgerPath, { run_id: runId, task_id: "W1-T1044FIX", step, ...extra }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 30,
      // reclaimWorker deliberately omitted — best-effort, and irrelevant to this claim.
    },
  });
  const realElapsedMs = Date.now() - start;
  assert.equal(outcome.outcome, "spawn_abandoned");
  // A real `setTimeout`, not a fake clock (see spawnFixWorkerBounded's own doc) — allow a few ms
  // either side of the requested bound rather than pinning exact timer precision, the same
  // tolerance the sibling "abandoning a sweep records the task and elapsed time" test uses.
  assert.ok(outcome.spawnAbandonedElapsedMs !== undefined && outcome.spawnAbandonedElapsedMs >= 25, "bounded by the configured elapsed time");
  assertWallClockBound(realElapsedMs, 5000, `abandonment must fire near the 30ms bound, not the module's own multi-minute default (saw ${realElapsedMs}ms)`);

  const records = readLedgerRecords(ledgerPath);
  assert.ok(records.length > 0, "the ledger genuinely received writes — this is not an unused path");
  const workerStateRows = records.filter((r) => r.step === "worker.state");
  assert.equal(
    workerStateRows.length,
    0,
    `this run's OWN real ledger must carry zero worker.state rows (saw ${workerStateRows.length}) — ` +
      "the worker was never sensed, exactly as rationale (5) measured for this lane",
  );
  const abandonedRow = records.find((r) => r.step === "fix.spawn_abandoned");
  assert.ok(abandonedRow, "the SAME real ledger still carries the abandonment — bounded despite no recorded state");
  assert.equal(abandonedRow!.run_id, runId);

  // A WIDER bound takes genuinely longer to fire — confirms the trigger is elapsed time itself,
  // never a fixed constant that happened to read 30 above, and still with no worker.state row.
  const ledgerPath2 = tmpLedgerPath();
  const runId2 = "W1-T1044FIX-1730000000002";
  const start2 = Date.now();
  const outcome2: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    runId: runId2,
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: ledgerPath2,
      log: (step, extra = {}) => appendLedger(ledgerPath2, { run_id: runId2, task_id: "W1-T1044FIX", step, ...extra }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 120,
    },
  });
  const realElapsedMs2 = Date.now() - start2;
  assert.equal(outcome2.outcome, "spawn_abandoned");
  assert.ok(
    realElapsedMs2 > realElapsedMs - 10,
    `a wider bound must take at least as long to fire (saw ${realElapsedMs}ms then ${realElapsedMs2}ms)`,
  );
  assert.equal(
    readLedgerRecords(ledgerPath2).filter((r) => r.step === "worker.state").length,
    0,
    "the wider-bound run's own ledger is ALSO free of worker.state rows",
  );
});

// ── the reclaim primitive itself, and the abandon path's two error arms ────────────────────────
//
// The tests above prove the RUNG reclaims; these prove what the reclaim actually does, and what
// happens when the two things that can go wrong afterwards do. All three are error/branch arms
// that a passing run never takes, which is why none of them was observed.

test("W1-T1044: reclaimAbandonedWorker kills only the candidate whose marker names THIS run", () => {
  const killed: number[] = [];
  const markers: Record<number, { runId: string } | undefined> = {
    11: { runId: "OTHER-RUN" },
    22: { runId: "THIS-RUN" },
    33: undefined, // a process carrying no marker at all
  };
  reclaimAbandonedWorker(
    { runId: "THIS-RUN", taskId: "W1-T1044FIX", elapsedMs: 20 },
    {
      listCandidates: () => [{ pid: 11 }, { pid: 22 }, { pid: 33 }] as never,
      readMarkers: ((pid: number) => markers[pid]) as never,
      kill: (pid: number) => void killed.push(pid),
    },
  );
  assert.deepEqual(killed, [22], "only the run's own worker is signalled — a foreign or marker-less process is left alone");
});

test("W1-T1044: reclaimAbandonedWorker swallows a failing process enumeration rather than throwing back into the rung", () => {
  assert.doesNotThrow(() =>
    reclaimAbandonedWorker(
      { runId: "THIS-RUN", taskId: "W1-T1044FIX", elapsedMs: 20 },
      {
        listCandidates: () => {
          throw new Error("ps: cannot read the process table");
        },
      },
    ),
  );
  // The same swallow when the KILL itself fails — a signal race is the likelier of the two, and
  // the rung has already ledgered the abandonment by this point.
  assert.doesNotThrow(() =>
    reclaimAbandonedWorker(
      { runId: "THIS-RUN", taskId: "W1-T1044FIX", elapsedMs: 20 },
      {
        listCandidates: () => [{ pid: 22 }] as never,
        readMarkers: (() => ({ runId: "THIS-RUN" })) as never,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
    ),
  );
});

test("W1-T1044: a reclaim that THROWS is ledgered, never propagated out of the rung", async () => {
  const steps: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra = {}) => steps.push({ step, extra: extra ?? {} }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: () => {
        throw new Error("reclaim exploded");
      },
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned", "a failed reclaim never changes the rung's outcome");
  const failed = steps.find((s) => s.step === "fix.spawn_reclaim_failed");
  assert.ok(failed, "a reclaim failure is recorded — otherwise the worker is left running with nothing saying so");
  assert.match(String(failed!.extra.error), /reclaim exploded/);
  assert.equal(failed!.extra.task_id, "W1-T1044FIX");
});

test("W1-T1044: a spawn that REJECTS after the rung abandoned it is ledgered, never an unhandled rejection", async () => {
  const steps: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let rejectSpawn: ((e: Error) => void) | undefined;
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      spawn: () =>
        new Promise<WorkerResult>((_resolve, reject) => {
          rejectSpawn = reject;
        }),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra = {}) => steps.push({ step, extra: extra ?? {} }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: () => {},
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  // The rung has moved on; the real spawn settles LATER. Without the attached handler this is an
  // unhandled rejection that takes the process down.
  rejectSpawn?.(new Error("worker died long after the bound"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settled = steps.find((s) => s.step === "fix.spawn_settled_after_abandon");
  assert.ok(settled, "a post-abandon rejection is recorded rather than crashing the daemon");
  assert.match(String(settled!.extra.error), /worker died long after the bound/);
  assert.equal(settled!.extra.run_id, "W1-T1044FIX-1730000000000");
});

test("W1-T1044: a sweep that REJECTS after the tick abandoned it is ledgered, never an unhandled rejection", async () => {
  // The sibling of `fix.spawn_settled_after_abandon` above, on the daemon's own sweep bound: the
  // tick has already moved on, so without the attached handler this rejection is unhandled and
  // takes the daemon down. A passing run never reaches it, which is why it was unobserved.
  const root = mkdtempSync(join(tmpdir(), "sweep-wall-clock-bound-"));
  const plan = emptyPlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let rejectSweep: ((e: Error) => void) | undefined;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("nothing runnable in this fixture — runOne must never be called");
      },
      sleep: REAL_SLEEP,
      sweep: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSweep = reject;
        }),
      checkStop: () => stopDetail(root),
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.sweep.abandoned") {
          // Settle the abandoned sweep LATE, exactly as a real one would: the tick has already
          // recorded the abandonment and moved on by the time this rejects.
          rejectSweep?.(new Error("sweep died long after the bound"));
          requestStop(root, "test observed the abandonment");
        }
      },
    },
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.equal(s.stopReason, "stopped", "the daemon survived the late rejection rather than crashing on it");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = lines.find((l) => l.step === "daemon.sweep.failed");
  assert.ok(failed, `expected a daemon.sweep.failed line, saw steps: ${lines.map((l) => l.step).join(", ")}`);
  assert.equal(failed!.extra.after_abandon, true, "the row says the failure arrived AFTER the abandonment, not instead of it");
  assert.match(String(failed!.extra.error), /sweep died long after the bound/);
});

// ── the abandoned fix spawn's own VERDICT, through a REAL runTask() ────────────────────────────
//
// Everything above proves `runFixRung` returns `spawn_abandoned`. This proves what `runTaskBody`
// then DOES with it: a terminal `blocked` verdict naming the bound, rather than the run vanishing.
// That branch is reachable only end-to-end — the rung is called from inside `runTaskBody`, which
// is not exported — so this is a real run against a throwaway origin, an offline gateway, an
// injected spawn and a fake `gh` on PATH, modelled on test/arm-at-open.test.ts's own (B) fixture.
// The one difference: that fixture answers CI RED so the run stops before review; this one answers
// GREEN and injects a FAILING review, which is what routes the run into the fix rung at all.

const ABANDON_FIXTURE_PLAN = [
  "- id: T-FIXABANDON",
  "  title: a fix worker whose spawn never returns",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");


const abandonHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const abandonCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function abandonGitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "fix-abandon-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "fix-abandon-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "fix-abandon-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "fix-abandon-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fix-abandon-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "fix-abandon-test"]);
}

/** A fake `gh` answering CI GREEN on the first poll (the difference from arm-at-open's, which
 *  answers RED), plus the reads and the status POST the review gate makes on the way through. */
function abandonFakeGh(repoDir: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "fix-abandon-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      // The ownership guard compares the PR's head branch against this run's own, and the branch
      // is minted inside runTask with an epoch suffix nothing outside it can predict. Read it back
      // off the repo's own refs rather than hardcoding a name that can only ever mismatch.
      `REPO=${JSON.stringify(repoDir)}`,
      'RUNBRANCH=$(git -C "$REPO" for-each-ref --format="%(refname:short)" "refs/heads/run-*" | head -1)',
      'if [[ "$1" == "pr" && "$2" == "view" ]]; then',
      '  if [[ "$5" == "headRefName" ]]; then echo "{\\"headRefName\\":\\"$RUNBRANCH\\"}"; exit 0; fi',
      '  if [[ "$5" == "body" ]]; then echo \'{"body":""}\'; exit 0; fi',
      "  echo '{}'; exit 0",
      "fi",
      'if [[ "$1" == "pr" ]]; then exit 0; fi',
      // The fix rung reads the PR's LIVE lifecycle state before it works, and stands down on
      // anything but OPEN — an unanswered read resolves UNKNOWN and the rung never spawns.
      // W1-T2268: `pollToGate`/`waitForCiGreen` now read the SAME `pulls/{n}` endpoint (never
      // `gh pr view --json statusCheckRollup`), so it carries a `head.sha` too, plus the
      // composed rollup's own check-runs (CI green on the very first poll) + combined-status.
      'if [[ "$1" == "api" ]]; then',
      '  case "$2" in',
      '    */pulls/*) echo \'{"number":1044,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}\'; exit 0;;',
      '    */check-runs*) echo \'{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\'; exit 0;;',
      '    */status) echo \'{"statuses":[]}\'; exit 0;;',
      '  esac',
      '  echo "{}"; exit 0',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function abandonWorkerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

test("W1-T1044: an abandoned fix spawn ends the RUN with a blocked verdict naming the bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "fix-abandon-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ABANDON_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  abandonGitFixture(root);

  const savedPath = process.env.PATH;
  process.env.PATH = `${abandonFakeGh(join(root, "repos", "remudero"))}:${savedPath}`;

  // The run's own branch is `run-<taskId>-<epochMs>`, minted inside runTask, so the test cannot
  // know it up front — and the ownership guard reads it back through the injected gateway, which
  // answering `undefined` turns into `pr_attribution_failed` before the review gate is reached.
  // Capture it from the worktree the first spawn is handed, and answer with that.
  let runBranch: string | undefined;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => runBranch,
    prBody: () => undefined,
  };

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    runBranch ??= execFileSync("git", ["-C", args.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim();
    if (spawnCalls.length === 1) {
      return abandonWorkerResult({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
    }
    if (spawnCalls.length === 2) {
      return abandonWorkerResult({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1044\n" });
    }
    // The FIX worker — never returns, the measured incident's own shape.
    return new Promise<WorkerResult>(() => {});
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FIXABANDON", {
        skipGitSync: true,
        planPath,
        config,
        github,
        spawn,
        containmentExec: abandonHoldingContainmentExec,
        isolationExec: abandonCleanIsolationExec,
        // A FAILING review is what routes this run into the fix rung at all.
        runReview: async () => fixReview(),
        spawnWallClockBoundMs: 20,
      }),
    );

    assert.equal(res.verdict, "blocked", "the run ENDS on a terminal verdict rather than vanishing with its worker");
    assert.equal(res.merged, false);
    assert.ok(spawnCalls.length >= 3, `expected recon, implement and a fix spawn — saw ${spawnCalls.length}`);

    const lines = readLedgerRecords(join(root, "state", "ledger.ndjson"));
    const verdict = lines.find((l) => l.step === "verdict" && l.verdict === "blocked" && /wall-clock bound/.test(String(l.reason ?? "")));
    assert.ok(verdict, `expected a blocked verdict naming the bound, saw: ${[...new Set(lines.map((l) => l.step))].join(", ")}`);
    assert.match(String(verdict!.reason), /fix rung abandoned — worker spawn exceeded its \d+ms wall-clock bound/);
    // The positive control on the same ledger: the abandonment itself was recorded first, so the
    // verdict reads as the rung's OUTCOME rather than a branch that invented one.
    assert.ok(lines.some((l) => l.step === "fix.spawn_abandoned"), "the abandonment row still lands before the verdict");
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
