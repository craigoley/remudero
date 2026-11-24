/**
 * W1-T14576 — A NATIVE TARGET JOB RUNS WHEN A LANE FREES.
 *
 * OBSERVED: a Console build for a repository with no daemon of its own was admitted and its kick marker sat under the
 * core root, but the core daemon ran its native job only with ZERO children: it wrote `target_job.capacity_deferred`
 * on every tick while one core child was in flight. A child leaves `children` only inside the lane pool, which a
 * waiting job's tick never reaches, so the job waited on a count that could not fall. The gate now counts the children
 * whose run has not settled against the lane limit core's own dispatch uses, logs a waiting job at most once a minute
 * with its age, and still never runs the job beside a full lane set. The job also never spends beside the dispatch
 * claim the target's own instance takes.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { runBoundedTargetJob, runDaemon, TARGET_JOB_DEFERRAL_LOG_INTERVAL_MS, type BoundedTargetJobPorts, type DaemonDeps, type DaemonOpts } from "#src/lib/daemon.js";
import type { TargetJobRecord } from "#src/lib/drain.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Row = { step: string; extra: Record<string, unknown> };
type Job = { taskId: string; origin: string; repo: string; requestedAt?: string };

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const TICK_MS = 20_000;

function plan(t: TestContext, body: string): Plan {
  const file = join(ownedFixtureDir(t, "w1-t14576-plan").dir, "tasks.yaml");
  writeFileSync(file, body);
  return loadPlan(file);
}
const CORE_PLAN = "- id: W1-T1\n  title: core\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n";

/** A controllable in-flight core child, adopted at boot the way a restart hands one over. */
function child(taskId: string) {
  let settle!: () => void;
  const settled = new Promise<never>((resolve) => { settle = () => resolve(undefined as never); });
  return { handle: { started: true, runId: `${taskId}-run`, dir: "/nowhere", pid: 1, taskId, settled }, settle };
}

/** Drive the CORE daemon's own loop over pending native jobs; `onTick` runs in each tick's sleep. */
async function drive(t: TestContext, o: {
  children: Array<ReturnType<typeof child>["handle"]>; jobs: Job[]; ticks: number; opts?: DaemonOpts;
  deps?: Partial<DaemonDeps>; onTick?: (tick: number) => void;
}) {
  const rows: Row[] = [];
  const ran: Array<{ job: Job; atTick: number }> = [];
  const pending = [...o.jobs];
  let tick = 0;
  let nowMs = T0;
  const summary = await runDaemon(plan(t, CORE_PLAN), {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false,
    runOne: async (id) => { throw new Error(`core task ${id} must not dispatch in this fixture`); },
    adoptRunChildren: () => o.children as never,
    pendingTargetJobs: () => [...pending],
    runTargetJob: async (job) => {
      ran.push({ job: job as Job, atTick: tick });
      pending.splice(pending.findIndex((p) => p.origin === job.origin), 1);
      return { state: "ended" };
    },
    // Stop at the top of a tick: once the job ran, or once the fixture's ticks are spent. Stopping before a tick with no
    // job keeps the loop out of the lane pool, which would await this fixture's never-settling children.
    checkStop: () => (tick >= o.ticks || (ran.length > 0 && pending.length === 0) ? "fixture done" : undefined),
    now: () => new Date(nowMs),
    sleep: async () => { tick++; nowMs += TICK_MS; o.onTick?.(tick); await new Promise<void>((resolve) => setImmediate(resolve)); },
    log: (step, extra = {}) => { rows.push({ step, extra }); },
    ...o.deps,
  }, { headroomEnabled: false, max: 5, ...o.opts });
  return { rows, ran, summary, deferrals: rows.filter((row) => row.step === "target_job.capacity_deferred") };
}

const JOB: Job = { taskId: "W9-T1", origin: "product:prd_a/op_1", repo: "wreckterra", requestedAt: new Date(T0 - 5_000).toISOString() };

test("W1-T14576: an admitted native target kick runs when a lane frees", async (t) => {
  // One core child in flight on a two-lane daemon: a lane is free, so the job takes it at once.
  const busy = child("W1-T7");
  const beside = await drive(t, { children: [busy.handle], jobs: [JOB], ticks: 4, opts: { laneCount: 2 } });
  assert.deepEqual(beside.ran.map((r) => [r.job.origin, r.atTick]), [[JOB.origin, 0]], "a free lane beside one in-flight child runs the job");
  assert.equal(beside.deferrals.length, 0, "a job with a free lane is never deferred");

  // Both lanes busy: the job waits, then takes the lane the first settled child frees, while the other still runs.
  const a = child("W1-T7");
  const b = child("W1-T8");
  const freed = await drive(t, { children: [a.handle, b.handle], jobs: [JOB], ticks: 6, opts: { laneCount: 2 },
    onTick: (tick) => { if (tick === 2) a.settle(); } });
  assert.deepEqual(freed.ran.map((r) => r.atTick), [2], "the job runs on the first tick after a lane frees");
  assert.equal(freed.deferrals[0]?.extra.in_flight, 2, "the deferral names the full lane set it waited on");
  assert.ok(freed.deferrals.every((row) => row.extra.origin === JOB.origin));

  // One lane, its child settles: the job runs in that lane.
  const only = child("W1-T7");
  const single = await drive(t, { children: [only.handle], jobs: [JOB], ticks: 5, onTick: (tick) => { if (tick === 1) only.settle(); } });
  assert.deepEqual(single.ran.map((r) => r.atTick), [1]);
});

test("W1-T14576: a waiting native job logs a bounded deferral with its age", async (t) => {
  const busy = child("W1-T7");
  const ticks = 9; // 9 ticks of 20 s: 180 s of waiting
  const waited = await drive(t, { children: [busy.handle], jobs: [JOB], ticks });
  assert.deepEqual(waited.ran, [], "the one lane stays busy, so the job never runs");
  assert.ok(waited.deferrals.length >= 2, "a waiting job stays visible");
  assert.ok(waited.deferrals.length < ticks, `one row per minute, not per tick: ${waited.deferrals.length}`);
  const ages = waited.deferrals.map((row) => row.extra.age_ms as number);
  assert.equal(ages[0], 5_000, "the age counts from the marker's own request time");
  for (let i = 1; i < ages.length; i++) assert.ok(ages[i]! - ages[i - 1]! >= TARGET_JOB_DEFERRAL_LOG_INTERVAL_MS, `rows ${i - 1} and ${i} are a minute apart: ${ages}`);
  assert.equal(TARGET_JOB_DEFERRAL_LOG_INTERVAL_MS, 60_000);

  // A job whose request time is unknown (a durable record) ages from when this daemon first saw it waiting, and a second
  // job waiting behind the one that runs is bounded the same way.
  const durable: Job = { taskId: "W9-T2", origin: "product:prd_b/op_2", repo: "wreckterra" };
  const other: Job = { taskId: "W9-T3", origin: "product:prd_c/op_3", repo: "wreckterra", requestedAt: "not a time" };
  const held = child("W1-T7");
  const queued = await drive(t, { children: [held.handle], jobs: [durable, other], ticks: 5 });
  assert.deepEqual(queued.deferrals.map((row) => [row.extra.origin, row.extra.age_ms]),
    [[durable.origin, 0], [durable.origin, 60_000]], "an unknown request time ages from first sight");
  const pair = await drive(t, { children: [], jobs: [durable, other, JOB], ticks: 2 });
  assert.deepEqual(pair.ran.map((r) => r.job.origin), [durable.origin, other.origin, JOB.origin]);
  const reserved = pair.deferrals.filter((row) => row.extra.reason === "lane reserved by another job");
  assert.deepEqual(reserved.map((row) => [row.extra.origin, row.extra.age_ms]), [[other.origin, 0], [JOB.origin, 5_000]],
    "each waiting job is logged once inside its minute, with its age");
});

test("W1-T14576: a native job does not run beside a full lane set", async (t) => {
  const a = child("W1-T7");
  const b = child("W1-T8");
  const full = await drive(t, { children: [a.handle, b.handle], jobs: [JOB], ticks: 6, opts: { laneCount: 2 } });
  assert.deepEqual(full.ran, [], "two busy lanes of two leave no lane for the job");
  assert.ok(full.deferrals.length >= 1 && full.deferrals.every((row) => row.extra.in_flight === 2));
  assert.ok(!full.rows.some((row) => row.step === "dispatch.concurrent_set"), "the wait adds no lane of its own");

  // Free local lanes do not count past the shared WIP budget: 1 child + 1 open-PR headroom is a full set.
  const one = child("W1-T7");
  const wip = await drive(t, { children: [one.handle], jobs: [JOB], ticks: 4, opts: { laneCount: 3, wipLimit: 2 }, deps: { openPrCount: () => 1 } });
  assert.deepEqual(wip.ran, [], "a free local lane cannot bypass a full shared WIP budget");
  assert.equal(wip.deferrals[0]?.extra.in_flight, 1);
});

/** `runBoundedTargetJob` over in-memory ports: a fresh admitted job whose target task is runnable. */
function boundedPorts(t: TestContext, claim: boolean | undefined) {
  const target = plan(t, "- id: W9-T1\n  title: target\n  repo: wreckterra\n  type: implement\n  depends_on: []\n  status: queued\n");
  const calls = { drains: 0, writes: [] as TargetJobRecord[], clears: [] as string[], claims: [] as string[], steps: [] as Row[] };
  const ports: BoundedTargetJobPorts = {
    readJob: () => ({ state: "absent" }),
    writeJob: (record) => { calls.writes.push(record); },
    admit: () => ({ state: "native", owner: "craigoley" }),
    syncPlan: async () => ({ plan: target }),
    claimHeld: async (taskId, repo) => { calls.claims.push(`${repo}:${taskId}`); return claim; },
    execution: () => ({ state: "unknown" }),
    drain: async (_plan, _opts, onDispatch) => { calls.drains++; onDispatch(); return { attempted: ["W9-T1"], merged: [], stopReason: "max_reached", costUsd: 0 } as never; },
    clearKick: (taskId, repo) => { calls.clears.push(`${repo}:${taskId}`); },
    log: (step, extra = {}) => { calls.steps.push({ step, extra }); },
    nowIso: () => new Date(T0).toISOString(),
  };
  return { ports, calls };
}

test("W1-T14576: a native job never spends beside the target instance's dispatch claim", async (t) => {
  const kick = { taskId: "W9-T1", origin: JOB.origin, repo: "wreckterra" };

  // The target's own instance holds refs/rmd-dispatch/W9-T1: the job closes, and the task is never run twice.
  const claimed = boundedPorts(t, true);
  const refused = await runBoundedTargetJob(kick, claimed.ports);
  assert.equal(refused.state, "refused");
  assert.match(refused.reason, /already claimed on wreckterra/);
  assert.equal(claimed.calls.drains, 0, "no drain, so no second run beside the claim's owner");
  assert.deepEqual(claimed.calls.writes.map((w) => [w.status, w.attempts]), [["refused", 0]], "no admission, no attempt spent");
  assert.deepEqual(claimed.calls.clears, ["wreckterra:W9-T1"]);
  assert.deepEqual(claimed.calls.claims, ["wreckterra:W9-T1"]);

  // An unreadable claim is never free: the job is held and keeps its marker.
  const unknown = boundedPorts(t, undefined);
  const held = await runBoundedTargetJob(kick, unknown.ports);
  assert.equal(held.state, "held");
  assert.equal(unknown.calls.drains, 0);
  assert.deepEqual([unknown.calls.writes, unknown.calls.clears], [[], []]);
  assert.ok(unknown.calls.steps.some((row) => row.step === "target_job.unknown" && row.extra.reason === "dispatch claim unreadable"));

  // Positive control: a free claim reaches the one maintained drain and spends once.
  const free = boundedPorts(t, false);
  const ended = await runBoundedTargetJob(kick, free.ports);
  assert.equal(free.calls.drains, 1);
  assert.equal(free.calls.writes[0]?.status, "admitted");
  assert.notEqual(ended.state, "refused");

  // A target with a live instance of its own is refused before any claim read: its own kick path owns the task.
  const own = boundedPorts(t, false);
  own.ports.admit = () => ({ state: "own_instance", instance: "wreckterra" });
  assert.equal((await runBoundedTargetJob(kick, own.ports)).state, "refused");
  assert.deepEqual([own.calls.drains, own.calls.claims], [0, []]);
});
