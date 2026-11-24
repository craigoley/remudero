/**
 * W1-T14600 — A DEFERRED TARGET JOB NEVER STOPS CORE TASK SELECTION.
 *
 * 2026-11-23/24: a Console product build left one managed-target job (WRECK-T1) pending on the core daemon. One core
 * run child was in flight, so the W1-T10799 branch deferred the job on every tick and then `continue`d before core
 * selection: for more than three hours neither the job nor any core task started, and nothing paged the operator.
 *
 * These suites drive the REAL `runDaemon`. Only the worker (`runOne`), the target job runner, the adopted core child,
 * the WIP readings, the clock and the log are faked, through the seams the daemon already injects. The catalogue entry
 * runs for real against a scratch ledger and a fake issue gateway.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";

import {
  runDaemon, TARGET_JOB_STALL_BOUND_MS, type DaemonDeps, type DaemonKick, type TargetJobStallInfo,
} from "#src/lib/daemon.js";
import { escalateTargetJobStalled, TARGET_JOB_STALL_ESCALATED_STEP } from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const MIN = 60_000;
const ORIGIN = "product:prd_ca604fb6/pbuild_50ebbb26";
const JOB: DaemonKick & { repo: string } = { taskId: "WRECK-T1", origin: ORIGIN, repo: "wreckterra" };

type Row = { tick: number; step: string; fields: Record<string, unknown> };
type Event = { tick: number; kind: "core" | "target"; id: string };
type JobOutcome = "dispatch-and-end" | "dispatch-and-resume" | "held" | "resumed";

function task(id: string): Task {
  return {
    id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low",
    status: "queued", attempts: 0, files: [`src/${id}.ts`],
  } as unknown as Task;
}
function plan(ids: readonly string[]): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}
const merged = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 } as RunResult);

interface DriveOpts {
  laneCount: number;
  /** The daemon stops once this many ticks have begun. */
  ticks: number;
  tickMs?: number;
  startMs?: number;
  /** Runnable core tasks. */
  core?: readonly string[];
  /** Core run children in flight at boot. One with `settleBeforeTick` finishes in the pause before that tick; every
   *  child still running finishes, one after another, once a dispatch pass awaits it. */
  adopted?: ReadonlyArray<string | { id: string; settleBeforeTick: number }>;
  admission?: { wipLimit: number; observedOpenCount: number };
  wipLimit?: number;
  openPrCount?: number;
  /** "unwired" leaves both target-job deps off; "throws" makes the durable job read throw. */
  jobs?: ReadonlyArray<DaemonKick & { repo: string }> | "unwired" | "throws";
  outcome?: JobOutcome;
  /** A core console kick, pending until the daemon clears it. */
  kick?: string;
  onTargetJobStalled?: (info: TargetJobStallInfo) => void | Promise<void>;
}

async function drive(opts: DriveOpts) {
  const rows: Row[] = [];
  const events: Event[] = [];
  const done = new Set<string>();
  const stalls: Array<{ tick: number; info: TargetJobStallInfo }> = [];
  let pending = opts.jobs === "unwired" || opts.jobs === "throws" ? [] : [...(opts.jobs ?? [JOB])];
  let kick = opts.kick;
  let tick = 0;
  let nowMs = opts.startMs ?? T0;
  const settlers: Array<{ id: string; at?: number; settle: () => void }> = [];
  const settledChildren: Array<{ tick: number; id: string }> = [];
  const adopted = (opts.adopted ?? []).map((entry) => {
    const { id, settleBeforeTick: at } = typeof entry === "string" ? { id: entry, settleBeforeTick: undefined } : entry;
    let resolve!: (r: RunResult) => void;
    const settled = new Promise<RunResult>((r) => { resolve = r; });
    settlers.push({ id, at, settle: () => { settledChildren.push({ tick, id }); done.add(id); resolve(merged(id)); } });
    return { started: true, runId: `${id}-child`, taskId: id, dir: "/nonexistent", pid: 0, settled, abort: async () => ({}), acknowledge: () => {} };
  });
  const take = (due: (s: (typeof settlers)[number]) => boolean) => {
    const taken = settlers.filter(due);
    for (const s of taken) settlers.splice(settlers.indexOf(s), 1);
    return taken;
  };
  const settleAll = () => { for (const s of take(() => true)) s.settle(); };
  const settleInTurn = async () => {
    for (const s of take(() => true)) {
      s.settle();
      for (let i = 0; i < 20; i++) await flush();
    }
  };
  const deps = {
    now: () => new Date(nowMs),
    sleep: async () => {
      for (const s of take((c) => c.at !== undefined && c.at <= tick + 1)) s.settle();
      await flush();
    },
    refreshMerged: () => (id: string) => done.has(id),
    checkFreshness: () => ({ stale: false }),
    checkStop: () => (tick > opts.ticks ? "test tick cap" : undefined),
    readLedgerLines: () => [],
    adoptRunChildren: () => adopted,
    ...(opts.admission ? { readQueueAdmission: () => opts.admission } : {}),
    ...(opts.openPrCount !== undefined ? { openPrCount: () => opts.openPrCount } : {}),
    ...(kick !== undefined ? {
      pendingKicks: () => (kick === undefined ? [] : [{ taskId: kick, origin: "console:operator" }]),
      clearKick: () => { kick = undefined; },
    } : {}),
    log: (step: string, fields: Record<string, unknown> = {}) => {
      if (step === "daemon.tick") {
        tick++;
        nowMs = (opts.startMs ?? T0) + (tick - 1) * (opts.tickMs ?? MIN);
      }
      rows.push({ tick, step, fields: { ...fields } });
      // A pass has begun: it awaits the adopted children, so they finish now.
      if (step === "dispatch.refill_bound") void settleInTurn();
    },
    runOne: async (id: string): Promise<RunResult> => {
      events.push({ tick, kind: "core", id });
      await flush();
      done.add(id);
      return merged(id);
    },
    ...(opts.jobs === "unwired" ? {} : {
      pendingTargetJobs: () => {
        if (opts.jobs === "throws") throw new Error("job store unreadable");
        return pending;
      },
      runTargetJob: async (job: DaemonKick & { repo: string }, _deps: DaemonDeps, onDispatch?: () => void) => {
        events.push({ tick, kind: "target", id: job.taskId });
        const outcome = opts.outcome ?? "dispatch-and-end";
        if (outcome.startsWith("dispatch")) onDispatch?.();
        if (outcome === "dispatch-and-end") {
          pending = pending.filter((p) => p.origin !== job.origin);
          return { state: "ended" as const };
        }
        return { state: outcome === "held" ? "held" as const : "resumed" as const };
      },
    }),
    ...(opts.onTargetJobStalled ? { onTargetJobStalled: async (info: TargetJobStallInfo) => {
      stalls.push({ tick, info });
      await opts.onTargetJobStalled!(info);
    } } : {}),
  } as unknown as DaemonDeps;
  const summary = await runDaemon(plan([...settlers.map((s) => s.id), ...(opts.core ?? [])]), deps,
    { laneCount: opts.laneCount, max: 40, pollIntervalMs: 1000, ...(opts.wipLimit !== undefined ? { wipLimit: opts.wipLimit } : {}) });
  settleAll();
  const inTick = (n: number) => rows.filter((r) => r.tick === n);
  const coreSelected = (n: number) => inTick(n).some((r) => (r.step === "dispatch.selection_timing" && r.fields.site === "tick")
    || r.step === "dispatch.wip_deferred" || r.step === "dispatch.lane_target_held");
  return { summary, rows, events, stalls, settledChildren, inTick, coreSelected };
}

function gateway() {
  const created: Array<{ title: string; body: string }> = [];
  const issues: IssueGateway = {
    create: (title, body) => { created.push({ title, body }); return `https://github.com/o/r/issues/${created.length}`; },
    closeWithComment: () => {},
  };
  return { issues, created };
}
function scratch() {
  const fx = writeLedger([]);
  return {
    path: fx.path,
    rows: () => readFileSync(fx.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
    append: (row: Record<string, unknown>) => fx.append([row]),
    cleanup: () => rmSync(fx.dir, { recursive: true, force: true }),
  };
}

test("W1-T14600 criterion 1: a target job deferred for capacity lets the same tick reach core selection", async () => {
  // Two lanes, room for two, both occupied: the job is deferred, and the tick goes on to core selection.
  const full = await drive({ laneCount: 2, ticks: 2, adopted: ["CORE-A", "CORE-B"], core: ["C1"], admission: { wipLimit: 2, observedOpenCount: 0 } });
  const deferred = full.inTick(1).find((r) => r.step === "target_job.capacity_deferred");
  assert.equal(deferred?.fields.reason, "no free lane");
  assert.ok(full.coreSelected(1), "the deferring tick wrote core's own selection rows");

  // At one lane the WIP budget defers the job while core still has its lane: a core task is picked in that tick.
  const wip = await drive({ laneCount: 1, ticks: 1, core: ["C1"], wipLimit: 1, openPrCount: 1 });
  assert.equal(wip.inTick(1).find((r) => r.step === "target_job.capacity_deferred")?.fields.reason, "wip budget");
  assert.ok(wip.inTick(1).some((r) => r.step === "dispatch.pick_scored" && r.fields.task === "C1"), "C1 is picked in the deferring tick");
  assert.deepEqual(wip.events.filter((e) => e.tick === 1), [{ tick: 1, kind: "core", id: "C1" }], "runOne ran C1 in that tick");
});

test("W1-T14600 criterion 1: a job that ran and came back held or resumed without a dispatch lets the tick go on to core selection", async () => {
  for (const outcome of ["held", "resumed"] as const) {
    const run = await drive({ laneCount: 2, ticks: 1, core: ["C1"], outcome });
    assert.deepEqual(run.events.filter((e) => e.tick === 1).map((e) => [e.kind, e.id]), [["target", "WRECK-T1"], ["core", "C1"]],
      `${outcome}: the job ran, then core picked C1 in the same tick`);
    assert.ok(run.inTick(1).some((r) => r.step === "dispatch.pick_scored" && r.fields.task === "C1"));
  }
  // An unreadable durable job store is no reason to stop core either.
  const unreadable = await drive({ laneCount: 2, ticks: 1, core: ["C1"], jobs: "throws" });
  assert.ok(unreadable.inTick(1).some((r) => r.step === "target_job.unknown"));
  assert.deepEqual(unreadable.events.map((e) => e.id), ["C1"]);
});

test("W1-T14600 criterion 1: only a job that dispatched in this tick ends the tick", async () => {
  const run = await drive({ laneCount: 2, ticks: 1, core: ["C1"], outcome: "dispatch-and-resume" });
  assert.deepEqual(run.events.map((e) => [e.tick, e.kind, e.id]), [[1, "target", "WRECK-T1"]], "no core task started in the dispatching tick");
  assert.equal(run.coreSelected(1), false, "the dispatching tick ended before core selection");
});

test("W1-T14600 criterion 2: with 3 lanes, WIP room for 3 and one core child in flight, the pending job runs in that tick", async () => {
  const run = await drive({ laneCount: 3, ticks: 2, adopted: ["CORE-A"], core: ["C1"], admission: { wipLimit: 3, observedOpenCount: 0 } });
  assert.deepEqual(run.events[0], { tick: 1, kind: "target", id: "WRECK-T1" }, "the job ran in the first tick, beside the core child");
  assert.ok(!run.rows.some((r) => r.step === "target_job.capacity_deferred"), "one core child in flight no longer defers the job");
});

test("W1-T14600 criterion 2: with every lane under the shared minimum occupied, core leaves the freed lane for the deferred job", async () => {
  // Three lanes but WIP room for two: min(lane target, WIP budget) is 2, and two core children hold both lanes.
  const run = await drive({ laneCount: 3, ticks: 6, adopted: [{ id: "CORE-A", settleBeforeTick: 2 }, "CORE-B"], core: ["C1", "C2"],
    admission: { wipLimit: 2, observedOpenCount: 0 } });
  assert.equal(run.inTick(1).find((r) => r.step === "target_job.capacity_deferred")?.fields.reason, "no free lane");
  const held = run.inTick(1).find((r) => r.step === "dispatch.wip_deferred" || r.step === "dispatch.lane_target_held");
  assert.equal(held?.fields.reserved_for_target_job, ORIGIN, "core's zero tick budget names the job its lane is held for");
  assert.ok(!run.inTick(1).some((r) => r.step === "dispatch.refill_bound"), "the holding tick never waits in the lane pool for every lane");
  const first = run.events[0];
  assert.deepEqual(first && [first.tick, first.kind, first.id], [2, "target", "WRECK-T1"],
    `when CORE-A ended, the next tick ran the job before core filled that lane: ${JSON.stringify(run.events)}`);
  assert.ok(!run.settledChildren.some((c) => c.id === "CORE-B" && c.tick <= 2), "CORE-B was still running beside the job");
  // Once the job ran the reservation is gone: core takes its lanes again.
  assert.deepEqual(run.events.slice(1).map((e) => [e.kind, e.id]).sort(), [["core", "C1"], ["core", "C2"]]);
  assert.ok(!run.rows.some((r) => r.tick > 1 && "reserved_for_target_job" in r.fields), "no lane is held after the job ran");
});

test("W1-T14600 criterion 2: a WIP-deferred job reserves no lane, so core keeps the lane it may use", async () => {
  // One lane: the WIP budget is zero for the job (min < 1), while core's own one-lane budget still has its lane.
  const run = await drive({ laneCount: 1, ticks: 1, core: ["C1"], wipLimit: 1, openPrCount: 1 });
  assert.equal(run.inTick(1).find((r) => r.step === "target_job.capacity_deferred")?.fields.reason, "wip budget");
  assert.deepEqual(run.events.map((e) => e.id), ["C1"], "core used its lane; no lane was held for the WIP-deferred job");
  const twoLanes = await drive({ laneCount: 2, ticks: 1, core: ["C1"], admission: { wipLimit: 1, observedOpenCount: 1 } });
  const row = twoLanes.inTick(1).find((r) => r.step === "dispatch.wip_deferred");
  assert.ok(row, "core is WIP-deferred too");
  assert.equal(row.fields.reserved_for_target_job, undefined, "and no lane is named as reserved");
});

test("W1-T14600 criterion 3: a job deferred past the stall bound pages once per episode, and the catalogue opens one issue", async () => {
  assert.equal(TARGET_JOB_STALL_BOUND_MS, 60 * MIN);
  const fx = scratch();
  try {
    const gw = gateway();
    const ctx = { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues };
    // Twenty minutes a tick, the WIP budget defers the job on every one of nine ticks (160 minutes).
    const page = (info: TargetJobStallInfo) => escalateTargetJobStalled(info, ctx);
    const first = await drive({ laneCount: 1, ticks: 9, tickMs: 20 * MIN, wipLimit: 1, openPrCount: 1, onTargetJobStalled: page });
    assert.equal(first.stalls.length, 1, "one page for the whole episode, not one per tick past the bound");
    assert.equal(first.stalls[0]!.tick, 4, "the tick 60 minutes after the first deferral pages");
    const info = first.stalls[0]!.info;
    assert.deepEqual(info, { taskId: "WRECK-T1", origin: ORIGIN, repo: "wreckterra", deferredForMs: 60 * MIN, reason: "wip budget",
      inFlight: 0, laneTarget: null, wipBudget: 0 });
    const stalled = first.rows.filter((r) => r.step === "target_job.stalled");
    assert.equal(stalled.length, 1);
    assert.deepEqual(Object.keys(stalled[0]!.fields).sort(),
      ["deferred_for_ms", "in_flight", "lane_target", "origin", "reason", "repo", "task", "wip_budget"]);
    assert.equal(gw.created.length, 1, "one escalation opened");
    const text = `${gw.created[0]!.title}\n${gw.created[0]!.body}`;
    assert.ok(text.includes("WRECK-T1") && text.includes("wreckterra") && text.includes("60 min"), text);
    assert.ok(text.includes("free WIP room"), "a WIP deferral offers freeing WIP room");
    const escalated = () => fx.rows().filter((r) => r.step === TARGET_JOB_STALL_ESCALATED_STEP);
    assert.equal(escalated().length, 1);
    assert.deepEqual([escalated()[0]!.origin, escalated()[0]!.repo, escalated()[0]!.deferred_for_ms, escalated()[0]!.reason,
      escalated()[0]!.issue_url, escalated()[0]!.delivered], [ORIGIN, "wreckterra", 60 * MIN, "wip budget", "https://github.com/o/r/issues/1", true]);

    // A later call in the same episode: a restart re-reaches the bound before the job dispatches.
    const restarted = await drive({ laneCount: 1, ticks: 5, tickMs: 20 * MIN, startMs: T0 + 200 * MIN, wipLimit: 1, openPrCount: 1, onTargetJobStalled: page });
    assert.equal(restarted.stalls.length, 1, "the new process pages its own deferral once");
    await escalateTargetJobStalled(info, ctx);
    assert.equal(gw.created.length, 1, "no second issue in the same episode");
    assert.equal(escalated().length, 1, "no second stall_escalated row");

    // Once the job dispatched, a fresh stall is a new episode and opens its own issue.
    fx.append({ ts: new Date(T0 + 400 * MIN).toISOString(), run_id: "daemon-run", task_id: "WRECK-T1", step: "console.kick_dispatched", origin: ORIGIN });
    await escalateTargetJobStalled(info, ctx);
    assert.equal(gw.created.length, 2);
    assert.equal(escalated().length, 2);
  } finally { fx.cleanup(); }
});

test("W1-T14600 criterion 3: a failed stall notification costs one row and never stops the loop", async () => {
  const run = await drive({ laneCount: 1, ticks: 6, tickMs: 30 * MIN, core: [], wipLimit: 1, openPrCount: 1,
    onTargetJobStalled: () => { throw new Error("gh down"); } });
  assert.equal(run.stalls.length, 1);
  assert.equal(run.rows.filter((r) => r.step === "daemon.escalation.failed").length, 1);
  assert.ok(run.rows.some((r) => r.tick === 6 && r.step === "daemon.tick"), "the loop kept ticking");
});

test("W1-T14600 criterion 4: invariant:no-pending-job-is-today — no pending job leaves dispatch as it was, and a core kick keeps priority", async () => {
  const shape = (run: Awaited<ReturnType<typeof drive>>) => ({
    events: run.events,
    dispatch: run.rows.filter((r) => r.step.startsWith("dispatch.") && r.step !== "dispatch.selection_timing" && r.step !== "dispatch.refill_bound")
      .map((r) => [r.tick, r.step, r.fields]),
  });
  for (const base of [
    { laneCount: 2, ticks: 3, core: ["C1", "C2", "C3"] },
    { laneCount: 2, ticks: 3, adopted: ["CORE-A"], core: ["C1", "C2"], admission: { wipLimit: 1, observedOpenCount: 0 } },
  ] as const) {
    const unwired = await drive({ ...base, jobs: "unwired" });
    const empty = await drive({ ...base, jobs: [] });
    assert.deepEqual(shape(empty), shape(unwired), "an empty pending list changes no dispatch row and no runOne call");
    assert.ok(!empty.rows.some((r) => r.step.startsWith("target_job.") || "reserved_for_target_job" in r.fields));
  }
  // The tick budget is the whole of min(lanes, WIP) less what is in flight: two free lanes start two core tasks at once.
  const twoLanes = await drive({ laneCount: 2, ticks: 1, core: ["C1", "C2", "C3"], jobs: [] });
  assert.deepEqual(twoLanes.inTick(1).filter((r) => r.step === "dispatch.pick_scored" && r.fields.site === "tick").map((r) => r.fields.task),
    ["C1", "C2"]);
  // And a freed lane refills from core as before, with no hold for a job that does not exist.
  const refill = await drive({ laneCount: 3, ticks: 1, adopted: ["CORE-A", "CORE-B"], core: ["C1"], admission: { wipLimit: 2, observedOpenCount: 0 }, jobs: [] });
  assert.ok(refill.inTick(1).some((r) => r.step === "dispatch.lane_refilled" && r.fields.next_task === "C1"));

  // A core kick and a pending target job in the same tick: the kicked core task dispatches and the target branch is not entered.
  const kicked = await drive({ laneCount: 2, ticks: 1, adopted: ["CORE-A"], core: ["C1"], kick: "C1", admission: { wipLimit: 1, observedOpenCount: 0 } });
  assert.deepEqual(kicked.events.filter((e) => e.tick === 1).map((e) => [e.kind, e.id]), [["core", "C1"]], "the kicked core task ran, the job did not");
  assert.ok(!kicked.inTick(1).some((r) => r.step.startsWith("target_job.")), "the target branch was not entered");
  assert.ok(!kicked.rows.some((r) => "reserved_for_target_job" in r.fields), "no lane is reserved");
});
