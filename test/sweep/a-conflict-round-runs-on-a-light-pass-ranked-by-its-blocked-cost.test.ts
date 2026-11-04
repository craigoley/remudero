import assert from "node:assert/strict";
import { test } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Plan, Task } from "#src/lib/plan.js";

/**
 * W1-T11171. A light pass (the actionable gate denies "conflicted" whenever the fix rung is closed) still runs a
 * conflicted PR's NO-WORKER resolution, and only a worker round stands down "deferred to full sweep (light pass)".
 * A full pass walks conflicted PRs by blocked cost: conflict age at this head times one plus the queued plan tasks
 * that depend on the PR's task, transitively.
 */

const MAIN = "m".repeat(40);
const HOUR = 3_600_000;

function view(prNumber: number, headSha: string, taskId: string): sweep.OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/example/fixture/pull/${prNumber}`, taskId,
    headRefName: `run-${taskId}-1793666131000`, headSha, mergeState: "dirty", mergeableState: "dirty",
    checksState: "none", reviewState: "none", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), createdAt: new Date(Date.UTC(2026, 10, 4) + prNumber).toISOString(),
    autoMergeArmed: false,
    mergeConflict: { files: [{ path: "a.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "head", theirsLog: "main" },
  } as sweep.OpenPrView;
}

function fixture(rows: Record<string, unknown>[] = []) {
  const ledger: Record<string, unknown>[] = [...rows];
  const calls = { regenerate: [] as number[], dispatch: [] as number[], admissions: [] as number[] };
  const deps: sweep.SweepDeps = {
    ledgerPath: "/nonexistent-for-this-fixture/ledger.ndjson", runId: "light-conflict-test",
    readLedger: () => ledger, appendLine: (_path, row) => { ledger.push(row); },
    arm: () => assert.fail("a conflicted PR cannot arm"), close: () => assert.fail("cannot close"),
    escalate: () => assert.fail("cannot escalate"), readMainTip: () => MAIN,
    dispatchFix: (pr) => { calls.dispatch.push(pr.prNumber); },
    claimFixAdmission: (pr) => { calls.admissions.push(pr.prNumber); return { admitted: true }; },
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    regenerateConflict: (pr, main) => {
      calls.regenerate.push(pr.prNumber);
      return { outcome: "pushed", paths: [], newHeadSha: `${pr.headSha.slice(0, 38)}ff`, ...(main ? {} : {}) };
    },
  };
  const rowsFor = (step: string) => ledger.filter((row) => row.step === step);
  const disposed = (prNumber: number) => ledger.findLast((row) => row.step === "sweep.disposed" && row.pr_number === prNumber);
  return { ledger, deps, calls, rowsFor, disposed };
}

/** A merge probe saying git merges this head cleanly at main: W1-T11167's no-worker clean-merge route. */
const cleanProbe = (prNumber: number, headSha: string) =>
  ({ step: "sweep.merge_probe", pr_number: prNumber, head_sha: headSha, main_sha: MAIN, verdict: "clean", conflict_paths: [] });

/** The light ticker's gate when the fix rung is closed: only the review lanes act. */
const lightGate = (d: sweep.Disposition) => sweep.isReviewLaneDisposition(d);

test("W1-T11171 criterion 1: a light pass runs a conflicted PR's no-worker resolution and still defers a worker round", async () => {
  const noWorker = view(11001, "a".repeat(40), "W1-T90001");
  const workerOnly = view(11002, "b".repeat(40), "W1-T90002");
  const f = fixture([cleanProbe(noWorker.prNumber, noWorker.headSha)]);
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([noWorker, workerOnly], { ...f.deps, actionable: lightGate, repairAdmissionSurface: "light" });
    await sweep.drainDetachedSweepActions();
  });
  // Positive control: the gate really denies a conflicted round on this pass.
  assert.equal(lightGate("conflicted"), false);
  assert.deepEqual(f.calls.regenerate, [noWorker.prNumber], "the no-worker route acts on the light pass");
  const receipt = f.rowsFor("sweep.conflict_regenerated").find((row) => row.pr_number === noWorker.prNumber);
  assert.equal(receipt?.mode, "clean-merge");
  assert.equal(f.disposed(noWorker.prNumber)?.acted, true);
  assert.deepEqual(f.calls.dispatch, [], "a light pass spawns no worker");
  assert.deepEqual(f.calls.admissions, [], "a light pass claims no fix admission");
  assert.equal(f.disposed(workerOnly.prNumber)?.acted, false);
  assert.equal(f.disposed(workerOnly.prNumber)?.stand_down_reason, "deferred to full sweep (light pass)");
});

test("W1-T11171 criterion 1: a no-worker route already attempted at this head and main defers to the full sweep on a light pass", async () => {
  const pr = view(11003, "c".repeat(40), "W1-T90003");
  const f = fixture([cleanProbe(pr.prNumber, pr.headSha), {
    step: "sweep.conflict_regenerated", pr_number: pr.prNumber, head_sha: pr.headSha, main_sha: MAIN,
    mode: "clean-merge", outcome: "fell-through", paths: [],
  }]);
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([pr], { ...f.deps, actionable: lightGate, repairAdmissionSurface: "light" });
    await sweep.drainDetachedSweepActions();
  });
  assert.deepEqual(f.calls.regenerate, [], "one attempt per head and main, on any pass");
  assert.deepEqual(f.calls.dispatch, []);
  assert.equal(f.disposed(pr.prNumber)?.stand_down_reason, "deferred to full sweep (light pass)");
});

function plan(tasks: Array<{ id: string; depends_on?: string[]; status?: string }>): Plan {
  const full = tasks.map((t) => ({ depends_on: [], status: "queued", ...t }) as unknown as Task);
  return { tasks: full, byId: new Map(full.map((t) => [t.id, t])) };
}

test("W1-T11171 criterion 2: queued transitive dependents come from the plan the production effects read", () => {
  const p = plan([
    { id: "W1-T90010" },
    { id: "W1-T90011", depends_on: ["W1-T90010"] },
    { id: "W1-T90012", depends_on: ["W1-T90011"] },
    { id: "W1-T90013", depends_on: ["W1-T90010"], status: "merged" },
    { id: "W1-T90014" },
  ]);
  assert.equal(sweep.queuedTransitiveDependents(p, "W1-T90010"), 2, "W1-T90011 and W1-T90012; the merged one does not wait");
  assert.equal(sweep.queuedTransitiveDependents(p, "W1-T90014"), 0);
  // The production effects builder wires the same count over its own plan.
  const effects = sweep.buildSweepEffects({
    owner: "example", repo: "fixture", config: { root: "/nonexistent-for-this-fixture" } as never,
    ledgerPath: "/nonexistent-for-this-fixture/ledger.ndjson", runId: "RUN-dependents", plan: p, log: () => {},
  } as never);
  assert.equal(effects.conflictDependents?.(view(1, "d".repeat(40), "W1-T90010")), 2);
  assert.equal(effects.conflictDependents?.({ ...view(2, "e".repeat(40), "W1-T90014") }), 0);
});

test("W1-T11171 criterion 2: a full pass admits conflict rounds in descending blocked cost, age times one plus dependents", async () => {
  const now = Date.now();
  // Walked first by snapshot order (lower createdAt), but young and depended on by nothing.
  const young = view(11020, "f".repeat(40), "W1-T90020");
  // Older at its current head, with two queued tasks waiting behind it.
  const old = view(11021, "1".repeat(40), "W1-T90021");
  const conflictRow = (pr: sweep.OpenPrView, hoursAgo: number) => ({
    ts: new Date(now - hoursAgo * HOUR).toISOString(), step: "sweep.disposed", pr_number: pr.prNumber,
    head_sha: pr.headSha, disposition: "conflicted", blocker: "conflict",
  });
  const f = fixture([conflictRow(young, 1), conflictRow(old, 3)]);
  const dependents = new Map([[old.taskId!, 2], [young.taskId!, 0]]);
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([young, old], { ...f.deps, conflictDependents: (pr) => dependents.get(pr.taskId ?? "") ?? 0 });
    await sweep.drainDetachedSweepActions();
  });
  assert.deepEqual(f.calls.admissions, [old.prNumber, young.prNumber], "3 h x 3 is admitted before 1 h x 1");
  // Ties keep today's order: equal cost walks in snapshot order.
  const tieA = view(11030, "2".repeat(40), "W1-T90030");
  const tieB = view(11031, "3".repeat(40), "W1-T90031");
  const g = fixture([conflictRow(tieA, 2), conflictRow(tieB, 2)]);
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([tieA, tieB], g.deps);
    await sweep.drainDetachedSweepActions();
  });
  assert.deepEqual(g.calls.admissions, [tieA.prNumber, tieB.prNumber]);
  // The ranking reads the pass clock ONCE: a clock that advances between reads (a slower runner) must not make the
  // later-measured of two equal conflicts look older and jump the tie.
  let tick = 0;
  const h = fixture([conflictRow(tieA, 2), conflictRow(tieB, 2)]);
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([tieA, tieB], { ...h.deps, now: () => now + (tick++) });
    await sweep.drainDetachedSweepActions();
  });
  assert.deepEqual(h.calls.admissions, [tieA.prNumber, tieB.prNumber], "an advancing clock keeps equal conflicts in snapshot order");
});

test("W1-T11171 criterion 3: conflicted rows record age, dependents and blocked cost, and a light pass counts acted and deferred conflicts", async () => {
  const now = Date.now();
  const noWorker = view(11040, "4".repeat(40), "W1-T90040");
  const workerOnly = view(11041, "5".repeat(40), "W1-T90041");
  const f = fixture([cleanProbe(noWorker.prNumber, noWorker.headSha), {
    ts: new Date(now - 2 * HOUR).toISOString(), step: "sweep.disposed", pr_number: workerOnly.prNumber,
    head_sha: workerOnly.headSha, disposition: "conflicted", blocker: "conflict",
  }]);
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([noWorker, workerOnly], {
      ...f.deps, actionable: lightGate, repairAdmissionSurface: "light", conflictDependents: () => 1,
      log: (step, extra) => { logged.push([step, extra]); },
    });
    await sweep.drainDetachedSweepActions();
  });
  const row = f.disposed(workerOnly.prNumber)!;
  assert.ok(typeof row.conflict_age_ms === "number" && row.conflict_age_ms >= 2 * HOUR - 60_000, String(row.conflict_age_ms));
  assert.equal(row.dependents, 1);
  assert.equal(row.blocked_cost, (row.conflict_age_ms as number) * 2);
  // The first observation at a head has age 0, so its cost is 0, never a guess.
  assert.equal(f.disposed(noWorker.prNumber)?.conflict_age_ms, 0);
  // The pass summary (sweep.summary, written once the walk ends) carries the light pass's conflict shares.
  const summary = logged.findLast(([step]) => step === "sweep.summary")?.[1];
  assert.ok(summary, "the pass wrote its summary");
  assert.equal(summary.light_conflict_acted, 1);
  assert.equal(summary.light_conflict_deferred, 1);
});

test("W1-T11171 criterion 3: a full pass writes no light-pass conflict counts", async () => {
  const pr = view(11050, "6".repeat(40), "W1-T90050");
  const f = fixture();
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  await withLiveWritesAllowed(async () => {
    await sweep.runSweep([pr], { ...f.deps, log: (step, extra) => { logged.push([step, extra]); } });
    await sweep.drainDetachedSweepActions();
  });
  const summary = logged.findLast(([step]) => step === "sweep.summary")?.[1];
  assert.ok(summary && !("light_conflict_acted" in summary) && !("light_conflict_deferred" in summary));
  assert.equal(f.disposed(pr.prNumber)?.conflict_age_ms, 0);
});
