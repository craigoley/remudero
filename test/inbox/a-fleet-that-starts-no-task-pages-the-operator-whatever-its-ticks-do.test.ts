/**
 * W1-T14608 — A FLEET THAT STARTS NO TASK FOR ITS MEASURED PICK GAP, WHILE A LANE IS FREE AND A TASK IS DISPATCHABLE,
 * PAGES THE OPERATOR ONCE, WHATEVER PATH ITS TICKS TAKE.
 *
 * These suites drive the REAL `runDaemon`. Only the worker (`runOne`), the target job runner, the adopted core child,
 * the WIP readings, the clock, the ledger reader and the log are faked, through the seams the daemon already injects.
 * The catalogue entries run for real against a scratch ledger and a fake issue gateway.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";

import {
  noStartBound, runDaemon, type DaemonDeps, type DaemonKick, type NoTaskStartedClearedInfo, type NoTaskStartedInfo,
} from "#src/lib/daemon.js";
import { escalateNoTaskStarted, escalateNoTaskStartedCleared } from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { isRecyclePauseDetail } from "#src/lib/fleet-control.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Row = Record<string, unknown>;
type Logged = { tick: number; step: string; fields: Row };
const RECYCLE_PAUSE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const JOB: DaemonKick & { repo: string } = { taskId: "WRECK-T1", origin: "product:p/b", repo: "wreckterra" };

function task(id: string, status = "queued"): Task {
  return {
    id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low",
    status, attempts: 0, files: [`src/${id}.ts`],
  } as unknown as Task;
}
function plan(tasks: readonly Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}
const merged = (id: string, runId = `${id}-run`): RunResult =>
  ({ taskId: id, runId, merged: true, verdict: "merged", costUsd: 0 } as RunResult);

/** `gaps + 1` started tasks, `gapMs` apart, the newest at `newestMs`: each a run.start with a passing claim. */
function startedTasks(gaps: number, gapMs: number, newestMs = T0, prefix = "old"): Row[] {
  return Array.from({ length: gaps + 1 }, (_, i) => {
    const at = newestMs - (gaps - i) * gapMs;
    return [
      { ts: iso(at), run_id: `${prefix}-${i}`, task_id: `OLD-${i}`, step: "run.start" },
      { ts: iso(at), run_id: `${prefix}-${i}`, task_id: `OLD-${i}`, step: "dispatch.claim", outcome: "created", proceed: true },
    ];
  }).flat();
}
/** Ten earlier builds, twelve minutes each from claim to verdict: the claim-silence window is 12 minutes. */
function measuredBuilds(): Row[] {
  return Array.from({ length: 10 }, (_, i) => {
    const at = T0 - 40 * 60 * MIN + i * 60 * MIN;
    return [
      { ts: iso(at), run_id: `b-${i}`, task_id: "B", step: "dispatch.claim", outcome: "created" },
      { ts: iso(at + 12 * MIN), run_id: `b-${i}`, task_id: "B", step: "verdict", verdict: "merged" },
    ];
  }).flat();
}

interface FleetOpts {
  ticks: number;
  laneCount: number;
  tickMs?: number;
  /** Queued core tasks. */
  core?: readonly string[];
  /** Tasks whose status is blocked, so no tick may dispatch them. */
  blocked?: readonly string[];
  /** Core run children in flight at boot; they never settle. */
  adopted?: readonly string[];
  /** A managed-target job: "closed" comes back refused without a dispatch, so its tick ends in the W1-T10799 branch. */
  job?: "closed" | "pending";
  /** Selection filters every core task out (an in-process hold) while the tick is below this. */
  filteredUntilTick?: number;
  pause?: string;
  wipLimit?: number;
  openPrCount?: number;
  seed?: readonly Row[];
  /** false leaves onNoTaskStarted and its cleared half unwired. */
  wired?: boolean;
  pageThrows?: boolean;
}

async function fleet(opts: FleetOpts) {
  const ledger: Row[] = [...(opts.seed ?? startedTasks(10, 20 * MIN))];
  const rows: Logged[] = [];
  const done = new Set<string>();
  const pages: Array<{ tick: number; info: NoTaskStartedInfo }> = [];
  const clears: Array<{ tick: number; info: NoTaskStartedClearedInfo }> = [];
  const started: Array<{ tick: number; id: string }> = [];
  const calls = { ledgerReads: 0, isOpenPr: 0, starvation: 0, claimStall: 0, targetJobStalled: 0 };
  let tick = 0;
  let nowMs = T0;
  let runs = 0;
  const adopted = (opts.adopted ?? []).map((id) => ({
    started: true, runId: `${id}-child`, taskId: id, dir: "/nonexistent", pid: 0,
    settled: new Promise<RunResult>(() => {}), abort: async () => ({}), acknowledge: () => {},
  }));
  const deps = {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(nowMs),
    sleep: async () => {},
    refreshMerged: () => (id: string) => done.has(id),
    checkFreshness: () => ({ stale: false }),
    checkStop: () => (tick > opts.ticks ? "test tick cap" : undefined),
    ...(opts.pause !== undefined ? { checkPause: () => opts.pause } : {}),
    readLedgerLines: () => { calls.ledgerReads++; return ledger.map((row) => JSON.stringify(row)); },
    adoptRunChildren: () => adopted,
    isOpenPr: () => { calls.isOpenPr++; return undefined; },
    isIndependentFailureBlocked: () => tick < (opts.filteredUntilTick ?? 0),
    ...(opts.openPrCount !== undefined ? { openPrCount: () => opts.openPrCount } : {}),
    log: (step: string, fields: Row = {}) => {
      if (step === "daemon.tick") {
        tick++;
        nowMs = T0 + (tick - 1) * (opts.tickMs ?? 5 * MIN);
      }
      rows.push({ tick, step, fields: { ...fields } });
    },
    runOne: async (id: string): Promise<RunResult> => {
      const runId = `${id}-run-${++runs}`;
      started.push({ tick, id });
      ledger.push({ ts: iso(nowMs), run_id: runId, task_id: id, step: "run.start" },
        { ts: iso(nowMs), run_id: runId, task_id: id, step: "dispatch.claim", outcome: "created", proceed: true });
      done.add(id);
      return merged(id, runId);
    },
    ...(opts.job ? {
      pendingTargetJobs: () => [JOB],
      runTargetJob: async () => ({ state: "refused" as const }),
    } : {}),
    onStarvation: () => { calls.starvation++; },
    onClaimStall: () => { calls.claimStall++; },
    onTargetJobStalled: () => { calls.targetJobStalled++; },
    ...(opts.wired === false ? {} : {
      onNoTaskStarted: (info: NoTaskStartedInfo) => {
        pages.push({ tick, info });
        if (opts.pageThrows) throw new Error("gh: 502 bad gateway");
      },
      onNoTaskStartedCleared: (info: NoTaskStartedClearedInfo) => { clears.push({ tick, info }); },
    }),
  } as unknown as DaemonDeps;
  const tasks = [...(opts.adopted ?? []), ...(opts.core ?? [])].map((id) => task(id))
    .concat((opts.blocked ?? []).map((id) => task(id, "blocked")));
  const summary = await runDaemon(plan(tasks), deps,
    { laneCount: opts.laneCount, max: 40, pollIntervalMs: 1000, ...(opts.wipLimit !== undefined ? { wipLimit: opts.wipLimit } : {}) });
  const noStartRows = rows.filter((r) => r.step.startsWith("dispatch.no_start."));
  return { summary, rows, pages, clears, started, calls, noStartRows, lastTick: tick };
}

function gateway() {
  const created: Array<{ title: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create: (title, body) => { created.push({ title, body }); return `https://github.com/o/r/issues/${created.length}`; },
    closeWithComment: (url, comment) => { closed.push({ url, comment }); },
  };
  return { issues, created, closed };
}
function scratch() {
  const fx = writeLedger([]);
  return {
    path: fx.path,
    rows: () => readFileSync(fx.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row),
    append: (row: Row) => fx.append([row]),
    cleanup: () => rmSync(fx.dir, { recursive: true, force: true }),
  };
}

const INFO: NoTaskStartedInfo = {
  ticksWithoutStart: 2, sinceLastStartMs: 25 * MIN, lastStartAt: iso(T0), boundMs: 20 * MIN, source: "pick-gap-p90",
  samples: 10, freeLanes: 1, dispatchable: 3, endStep: "target_job.capacity_deferred",
};

function assertOnePageAtTickSix(run: Awaited<ReturnType<typeof fleet>>) {
  assert.deepEqual(run.pages.map((p) => p.tick), [6], "the bound is 20 min and ticks are 5 min apart: the second tick past it pages");
  assert.ok(run.lastTick >= 12, "the daemon kept ticking after the page");
  assert.equal(run.started.length, 0, "no core task started");
  const info = run.pages[0]!.info;
  assert.equal(info.ticksWithoutStart, 2);
  assert.equal(info.sinceLastStartMs, 25 * MIN);
  assert.equal(info.boundMs, 20 * MIN);
  assert.equal(info.source, "pick-gap-p90");
  assert.equal(info.samples, 10);
  assert.equal(info.freeLanes, 1);
  assert.equal(info.dispatchable, 1);
  assert.equal(info.lastStartAt, iso(T0));
  assert.equal(run.noStartRows.length, 1);
  const row = run.noStartRows[0]!;
  assert.equal(row.step, "dispatch.no_start.detected");
  assert.equal(row.tick, 6);
  for (const key of ["ticks_without_start", "since_last_start_ms", "bound_ms", "bound_source", "samples", "free_lanes", "dispatchable", "end_step"]) {
    assert.ok(key in row.fields, `the row names ${key}`);
  }
  assert.equal(row.fields.end_step, info.endStep);
  const tickFive = run.rows.filter((r) => r.tick === 5).map((r) => r.step);
  assert.ok(info.endStep === null || (tickFive.includes(info.endStep) && info.endStep !== "daemon.tick"),
    `the end step ${info.endStep} is a row the newest judged tick wrote, never one from an earlier tick`);
  return info;
}

test("W1-T14608 criterion 1: every tick ends in the W1-T10799 branch with one core child in flight, and the second tick past the bound pages once", async () => {
  const run = await fleet({ ticks: 12, laneCount: 2, adopted: ["CORE-A"], core: ["A1"], job: "closed" });
  assert.ok(!run.rows.some((r) => r.step === "dispatch.selection_timing" && r.fields.site === "tick"), "no tick reached core selection");
  assertOnePageAtTickSix(run);
});

test("W1-T14608 criterion 1: every tick ends in the idle branch with the dispatchable task filtered out, and the second tick past the bound pages once", async () => {
  const run = await fleet({ ticks: 12, laneCount: 1, core: ["A1"], filteredUntilTick: Infinity });
  assert.ok(run.rows.some((r) => r.tick === 5 && r.step === "dispatch.selection_timing"), "the ticks reached core selection");
  const info = assertOnePageAtTickSix(run);
  assert.equal(info.endStep, "daemon.idle", "the page names the idle branch that ended the newest tick");
});

test("W1-T14608 criterion 2: noStartBound is the p90 (nearest rank) of the newest 50 started-task gaps within 7 days", () => {
  // Eleven gaps of 1..11 minutes: nearest-rank p90 of 11 samples is the 10th, 10 minutes.
  const starts: Row[] = [];
  let at = T0 - 100 * MIN;
  for (let i = 0; i <= 11; i++) {
    starts.push({ ts: iso(at), run_id: `s-${i}`, step: "run.start" });
    at += (i + 1) * MIN;
  }
  const bound = noStartBound(starts, 1000);
  assert.deepEqual(bound, { boundMs: 10 * MIN, source: "pick-gap-p90", samples: 11 });

  // A refused run's run.start, a repeated run.start and a review run are not started tasks: the bound is unchanged.
  const noise: Row[] = [
    { ts: iso(T0 - 99 * MIN), run_id: "refused", step: "run.start" },
    { ts: iso(T0 - 99 * MIN), run_id: "refused", step: "dispatch.claim", outcome: "taken", proceed: false },
    { ts: iso(T0 - 98 * MIN), run_id: "s-0", step: "run.start" },
    { ts: iso(T0 - 97 * MIN), run_id: "review", step: "run.start", type: "review" },
  ];
  assert.deepEqual(noStartBound([...starts, ...noise], 1000), bound);

  // Gaps older than 7 days do not count, and only the newest 50 count.
  const old = startedTasks(30, 300 * MIN, T0 - 8 * 24 * 60 * MIN, "aged").filter((r) => r.step === "run.start");
  assert.deepEqual(noStartBound([...old, ...starts], 1000).samples, 11, "a gap ending more than 7 days before the newest start is dropped");
  const many = [...startedTasks(60, 90 * MIN, T0 - 61 * 5 * MIN, "slow"), ...startedTasks(60, 5 * MIN, T0, "fast")].filter((r) => r.step === "run.start");
  assert.deepEqual(noStartBound(many, 1000), { boundMs: 5 * MIN, source: "pick-gap-p90", samples: 50 }, "the newest 50 gaps only");

  // Never shorter than two poll intervals.
  assert.equal(noStartBound(startedTasks(10, 100), 1000).boundMs, 2000);
});

test("W1-T14608 criterion 2: with fewer than 8 gaps the claim-silence window is the bound, and bound_source says so", async () => {
  const seed = [...startedTasks(5, 20 * MIN), ...measuredBuilds()];
  assert.deepEqual(noStartBound(seed, 1000), { boundMs: 12 * MIN, source: "claim-silence-window", samples: 10 });
  const run = await fleet({ ticks: 10, laneCount: 1, core: ["A1"], filteredUntilTick: Infinity, seed });
  assert.deepEqual(run.pages.map((p) => p.tick), [5], "12 min bound, 5 min ticks: ticks 3 and 4 are past it");
  assert.equal(run.pages[0]!.info.source, "claim-silence-window");
  assert.equal(run.pages[0]!.info.boundMs, 12 * MIN);
  assert.equal(run.noStartRows[0]!.fields.bound_source, "claim-silence-window");
  const bare = noStartBound(startedTasks(2, 20 * MIN), 1000);
  assert.equal(bare.source, "claim-silence-window");
  assert.ok(bare.boundMs >= 2000);
});

test("W1-T14608 criterion 2: escalateNoTaskStarted opens one issue per episode, deduped on the newest started run and never on a refused run's run.start", async () => {
  const fx = scratch();
  try {
    const gw = gateway();
    const ctx = { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues };
    fx.append({ ts: iso(T0), run_id: "r0", task_id: "A0", step: "run.start" });
    fx.append({ ts: iso(T0), run_id: "r0", task_id: "A0", step: "dispatch.claim", outcome: "created", proceed: true });
    await escalateNoTaskStarted(INFO, ctx);
    assert.equal(gw.created.length, 1);
    const text = `${gw.created[0]!.title}\n${gw.created[0]!.body}`;
    assert.ok(text.includes("25 min"), "names the time since the last start");
    assert.ok(text.includes("20 min") && text.includes("pick-gap-p90"), "names the bound and its source");
    assert.ok(text.includes("1 free lane"), "names the free lanes");
    assert.ok(text.includes("3 dispatchable"), "names the dispatchable count");
    assert.ok(text.includes("target_job.capacity_deferred"), "names the step that ended the newest tick");
    const marker = fx.rows().find((r) => r.step === "dispatch.no_start.escalated");
    assert.equal(marker?.issue_url, "https://github.com/o/r/issues/1");
    assert.equal(marker?.bound_source, "pick-gap-p90");
    assert.equal(marker?.end_step, "target_job.capacity_deferred");

    await escalateNoTaskStarted(INFO, ctx);
    for (let i = 0; i < 3; i++) {
      fx.append({ ts: iso(T0 + i), run_id: `x${i}`, task_id: "B2", step: "run.start" });
      fx.append({ ts: iso(T0 + i), run_id: `x${i}`, task_id: "B2", step: "dispatch.claim", outcome: "taken", proceed: false });
      await escalateNoTaskStarted(INFO, ctx);
    }
    assert.equal(gw.created.length, 1, "a repeat and a refused run's run.start never re-open the page");
    fx.append({ ts: iso(T0 + 10), run_id: "good", task_id: "C3", step: "run.start" });
    await escalateNoTaskStarted(INFO, ctx);
    assert.equal(gw.created.length, 2, "after a task started, a new episode opens its own issue");
  } finally { fx.cleanup(); }
});

test("W1-T14608 criterion 2: the first task started after the page calls onNoTaskStartedCleared once, which closes the issue and writes one cleared row", async () => {
  const run = await fleet({ ticks: 14, laneCount: 1, core: ["A1"], filteredUntilTick: 9 });
  assert.deepEqual(run.pages.map((p) => p.tick), [6]);
  assert.deepEqual(run.started, [{ tick: 9, id: "A1" }]);
  assert.deepEqual(run.clears.map((c) => c.tick), [9], "cleared once, by the start, never on a later tick");
  assert.equal(run.clears[0]!.info.taskId, "A1");
  assert.equal(run.clears[0]!.info.sinceLastStartMs, 40 * MIN);

  const fx = scratch();
  try {
    const gw = gateway();
    const ctx = { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues };
    await escalateNoTaskStartedCleared(run.clears[0]!.info, ctx);
    assert.equal(gw.closed.length, 0, "no open page, nothing to close");
    await escalateNoTaskStarted(run.pages[0]!.info, ctx);
    await escalateNoTaskStartedCleared(run.clears[0]!.info, ctx);
    assert.deepEqual(gw.closed.map((c) => c.url), ["https://github.com/o/r/issues/1"]);
    assert.ok(gw.closed[0]!.comment.includes("A1 started"));
    await escalateNoTaskStartedCleared(run.clears[0]!.info, ctx);
    assert.equal(gw.closed.length, 1, "a second clear finds the issue already closed");
    const cleared = fx.rows().filter((r) => r.step === "dispatch.no_start.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.delivered, true);
  } finally { fx.cleanup(); }
});

test("W1-T14608 criterion 2: a page that throws costs one daemon.escalation.failed row and the loop goes on", async () => {
  const run = await fleet({ ticks: 12, laneCount: 1, core: ["A1"], filteredUntilTick: Infinity, pageThrows: true });
  assert.equal(run.pages.length, 1);
  assert.equal(run.rows.filter((r) => r.step === "daemon.escalation.failed").length, 1);
  assert.ok(run.lastTick >= 12);
});

test("W1-T14608 criterion 3: invariant a-fleet-starting-work-pages-as-today — no free lane, a WIP budget below 1, no dispatchable task or a pause pages nothing", async () => {
  const cases: Array<[string, FleetOpts]> = [
    ["no free lane: the only lane holds a core child and a target job waits", { ticks: 12, laneCount: 1, adopted: ["CORE-A"], core: ["A1"], job: "pending" }],
    ["WIP budget below 1", { ticks: 12, laneCount: 2, core: ["A1"], wipLimit: 1, openPrCount: 1 }],
    ["no dispatchable task", { ticks: 12, laneCount: 1, blocked: ["A1"] }],
    ["an operator pause", { ticks: 12, laneCount: 1, core: ["A1"], pause: "operator hold" }],
    ["a recycle pause", { ticks: 12, laneCount: 1, core: ["A1"], pause: RECYCLE_PAUSE }],
  ];
  assert.ok(isRecyclePauseDetail(RECYCLE_PAUSE), "the fixture is the recycle's own PAUSE");
  for (const [name, opts] of cases) {
    const run = await fleet(opts);
    assert.ok(run.lastTick >= 12, `${name}: the daemon kept ticking`);
    assert.equal(run.started.length, 0, `${name}: nothing started`);
    assert.equal(run.pages.length, 0, `${name}: no page`);
    assert.equal(run.noStartRows.length, 0, `${name}: no dispatch.no_start row`);
  }
});

test("W1-T14608 criterion 3: a single tick past the bound, or a task started inside the bound, pages nothing", async () => {
  const single = await fleet({ ticks: 4, laneCount: 1, core: ["A1"], filteredUntilTick: Infinity });
  assert.equal(single.pages.length, 0, "one tick past the bound is not a stall");
  assert.equal(single.noStartRows.length, 0);
  const ids = Array.from({ length: 12 }, (_, i) => `A${i + 1}`);
  const busy = await fleet({ ticks: 12, laneCount: 1, core: ids });
  assert.ok(busy.started.length >= 10, "a task starts on every tick");
  assert.equal(busy.pages.length, 0);
  assert.equal(busy.noStartRows.length, 0);
});

test("W1-T14608 criterion 3: with onNoTaskStarted not wired the daemon makes the same rows, ledger reads and calls, and every other escalation is unchanged", async () => {
  for (const opts of [
    { ticks: 12, laneCount: 2, adopted: ["CORE-A"], core: ["A1"], job: "closed" as const },
    { ticks: 12, laneCount: 1, core: ["A1"], filteredUntilTick: Infinity },
  ]) {
    const unwired = await fleet({ ...opts, wired: false });
    const wired = await fleet(opts);
    assert.equal(unwired.pages.length + unwired.clears.length + unwired.noStartRows.length, 0);
    assert.equal(wired.pages.length, 1, "the same fleet wired pages");
    const steps = (run: typeof wired) => run.rows.filter((r) => !r.step.startsWith("dispatch.no_start.")).map((r) => `${r.tick}:${r.step}`);
    assert.deepEqual(steps(unwired), steps(wired), "the rows differ only by the no-start row");
    assert.equal(unwired.calls.ledgerReads, wired.calls.ledgerReads - 1, "unwired, no seed read of the ledger");
    for (const k of ["starvation", "claimStall", "targetJobStalled"] as const) {
      assert.equal(unwired.calls[k], wired.calls[k], `${k} is called as without the check`);
    }
    if (opts.job === "closed") {
      assert.equal(unwired.calls.isOpenPr, 0, "unwired, the dispatchable predicate never runs");
      assert.ok(wired.calls.isOpenPr > 0, "wired, it runs past the bound");
    }
  }
});
