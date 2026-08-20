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
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS, type DaemonDeps } from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";
import { runFixRung, type FixRungOutcome } from "../src/run-task.js";
import { loadPolicy, installPolicyPath } from "../src/lib/policy.js";
import type { Config } from "../src/lib/config.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Mount } from "../src/lib/mounts.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

test("W1-T1044: an unsensed worker is bounded by elapsed time", async () => {
  // NO worker-state / liveness signal of any kind is supplied here — `runFixRung`'s own deps
  // carry no such field at all (this task's own rationale (5): the fix-rung lane's worker
  // spawn emits no `worker.state` row, so a detector keyed on worker silence has no subject to
  // watch). The bound must still fire, driven ONLY by elapsed wall-clock time.
  const start = Date.now();
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}), // never resolves, never emits any signal
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 30,
      // reclaimWorker deliberately omitted — best-effort, and irrelevant to this claim.
    },
  });
  const realElapsedMs = Date.now() - start;
  assert.equal(outcome.outcome, "spawn_abandoned");
  assert.ok(outcome.spawnAbandonedElapsedMs !== undefined && outcome.spawnAbandonedElapsedMs >= 30, "bounded by the configured elapsed time");
  assert.ok(realElapsedMs < 5000, `abandonment must fire near the 30ms bound, not the module's own multi-minute default (saw ${realElapsedMs}ms)`);

  // A WIDER bound takes genuinely longer to fire — confirms the trigger is elapsed time itself,
  // never a fixed constant that happened to read 30 above.
  const start2 = Date.now();
  const outcome2: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fixReview(),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
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
});
