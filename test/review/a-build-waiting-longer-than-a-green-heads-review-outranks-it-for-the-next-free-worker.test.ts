/**
 * W1-T15291 — a build waiting longer than a green head's review outranks it for the next free worker.
 *
 * W1-T12712 held every NEW build lane and fix round while the review width sat at host-worker-budget and a green head
 * had waited longer than one cadence. On 2026-11-28 the heads waited for hours (fix rounds already running held the
 * budget), so no build started from 14:35Z. The next free worker now goes to the oldest waiter, a tie to the review.
 *
 * The daemon cases run `runDaemon`; the sweep cases run `runSweepLightPass` with the production fix admission.
 * Nothing stands in for the precedence or for the daemon's record of when build demand began.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { appendLedger } from "#src/lib/ledger.js";
import { loadPlan } from "#src/lib/plan.js";
import { DEFAULT_POLL_INTERVAL_MS } from "#src/lib/poll-interval.js";
import {
  PRECEDENCE_WIDTH_REASON, recordBuildDemandSince, reviewPrecedence, reviewPrecedenceHold, yieldingFixClaim,
} from "#src/lib/review-precedence.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, drainDetachedSweepActions, drainInFlightReviews, runSweepLightPass,
  type OpenPrView, type QueueGovernorResult, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const CADENCE = DEFAULT_POLL_INTERVAL_MS;
const MINUTE = 60_000;
const at = (time: string): number => Date.parse(`2026-11-28T${time}Z`);
const iso = (ms: number): string => new Date(ms).toISOString();
/** Today's reading: the last dispatch claim, the two heads' wait, and the operator session's measurement. */
const BUILD_SINCE = at("14:35:53");
const HEADS_SINCE = at("16:39:35");
const NOW = at("18:01:00");
const HEADS = [21041, 20913];
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

type Row = Record<string, unknown>;
type Logged = { step: string; fields: Record<string, unknown> };

/** The newest width decision; `null` is a ledger with none. */
const widthRows = (reason: string | null): Row[] => reason === null ? [] : [{ step: "review.capacity", reason }];
const waitingRow = (prNumber: number, sinceMs: number, blocker = "awaiting-review"): Row => ({
  step: "sweep.disposed", pr_number: prNumber, blocker, blocker_since: iso(sinceMs), head_sha: `head-${prNumber}`,
});
const headView = (prNumber: number) => ({ prNumber, headSha: `head-${prNumber}`, checksState: "green" });

/** The sweep's reading at `nowMs`: the width reason and the green heads waiting for review since `sinceMs`. */
function recordReading(nowMs: number, sinceMs = HEADS_SINCE, width: string | null = PRECEDENCE_WIDTH_REASON,
  heads = HEADS): void {
  yieldingFixClaim("light", () => ({ admitted: true }), [...widthRows(width), ...heads.map((pr) => waitingRow(pr, sinceMs))],
    nowMs, undefined, heads.map(headView));
}

/** One NEW fix round for `prNumber`, whose pull request has waited since `sinceMs`, decided at `nowMs`. */
function fixRound(prNumber: number, sinceMs: number, nowMs: number, width: string | null = PRECEDENCE_WIDTH_REASON,
  answer: { admitted: true } | { admitted: false; reason: string } = { admitted: true }) {
  let consulted = 0;
  const claim = yieldingFixClaim("light", () => { consulted++; return answer; },
    [...widthRows(width), waitingRow(prNumber, sinceMs, "own-red")], nowMs, undefined, []);
  const grant = claim({ prNumber });
  return { grant, consulted, answer };
}

/** Ends any held spell and recorded build demand this process carries from an earlier test. */
function reset(): void {
  recordBuildDemandSince(undefined);
  yieldingFixClaim("light", () => ({ admitted: true }), [], NOW, undefined, [])({ prNumber: 1 });
  reviewPrecedenceHold("dispatch", NOW, CADENCE);
}

const memoryHeld = (tier: "container-short" | "host-short" = "container-short"): QueueGovernorResult => ({
  deferred: true, observedOpenCount: 6, wipLimit: 12, measuredBound: 0, tier: "draining",
  pressure: { tier, binding: tier === "container-short" ? "container" : "host", availableMib: 1_800, floorMib: 3_072 },
});

/**
 * The memory governor holding each lane's dispatch while `on()`: the tick-wide gate (the first read of a tick) admits,
 * and the per-dispatch gate (the second) holds, so the held tick samples its idle lane, as a held dispatch does.
 */
function memoryGovernor(on: () => boolean, tier: "container-short" | "host-short" = "container-short") {
  let reads = 0;
  return (): QueueGovernorResult | undefined => ++reads % 2 === 0 && on() ? memoryHeld(tier) : undefined;
}

function daemonFixture(t: TestContext, ids: string[], opts: {
  clock: { ms: number }; ticks: number; governed?: () => QueueGovernorResult | undefined;
  onSleep?: (sleeps: number) => void; runOne?: DaemonDeps["runOne"];
}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15291-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const started: string[] = [];
  const finished: string[] = [];
  const rows: Logged[] = [];
  let sleeps = 0;
  const deps: DaemonDeps = {
    // The host's memory, heap and boot checkout never decide here; the fixture's clock replaces the pinned one.
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => (id) => finished.includes(id),
    runOne: opts.runOne ?? (async (id) => {
      started.push(id);
      finished.push(id);
      return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
    }),
    sleep: async () => { sleeps++; opts.onSleep?.(sleeps); await flush(); },
    now: () => new Date(opts.clock.ms),
    checkStop: () => sleeps >= opts.ticks ? "fixture done" : undefined,
    workerAdmissionHold: () => undefined,
    ...(opts.governed ? { checkQueueGovernor: opts.governed } : {}),
    log: (step, fields = {}) => rows.push({ step, fields }),
  };
  return {
    run: (max = 1) => runDaemon(loadPlan(path), deps, { pollIntervalMs: CADENCE, max }),
    started, finished, rows,
    yields: () => rows.filter((row) => row.step === "sweep.budget_yield"),
  };
}

/**
 * Today's day on one build lane: from the last claim at 14:35:53 the memory governor holds the build (as it did from
 * 14:20Z to 17:32Z) and the daemon ticks every 20 minutes; at 18:01 the memory hold has lifted and the sweep's newest
 * reading has the two heads waiting for review since 16:39:35 under host-worker-budget.
 */
function todaysDay(t: TestContext, opts: { buildFrom?: number; onSleep?: (clockMs: number) => void; runOne?: DaemonDeps["runOne"] } = {}) {
  const clock = { ms: opts.buildFrom ?? BUILD_SINCE };
  let governed = true;
  const d = daemonFixture(t, ["W1-T15182"], {
    clock, ticks: 20, runOne: opts.runOne,
    governed: memoryGovernor(() => governed),
    onSleep: () => {
      clock.ms = Math.min(NOW, clock.ms + 20 * MINUTE);
      opts.onSleep?.(clock.ms);
      if (clock.ms === NOW) { governed = false; recordReading(NOW); }
    },
  });
  return { ...d, clock };
}

test("W1-T15291 criterion 1: build demand older than every waiting green head is not held by review precedence on dispatch or lane-refill", async (t) => {
  reset();
  recordReading(NOW);
  const logged: Logged[] = [];
  const log = (step: string, fields: Record<string, unknown> = {}) => logged.push({ step, fields });
  assert.equal(reviewPrecedence({
    waitingGreenHeads: HEADS.map((prNumber) => ({ prNumber, sinceMs: HEADS_SINCE })), cadenceMs: CADENCE, nowMs: NOW,
    widthReason: PRECEDENCE_WIDTH_REASON, buildWaitingSinceMs: BUILD_SINCE,
  }), "proceed", "the build (about 205 minutes) has waited longer than the heads (about 81)");
  for (const surface of ["dispatch", "lane-refill"]) {
    assert.equal(reviewPrecedenceHold(surface, NOW, CADENCE, log, BUILD_SINCE), undefined, surface);
  }
  assert.deepEqual(logged.filter((row) => row.step === "sweep.budget_yield"), [], "no held spell opens");

  // End to end: the daemon's own record of when the build demand began is what decides, and the build starts.
  reset();
  const d = todaysDay(t);
  await d.run();
  assert.deepEqual(d.started, ["W1-T15182"], "the build takes the next freed slot");
  assert.equal(d.yields().length, 0);
});

test("W1-T15291 criterion 2: a build whose demand began after the oldest waiting head still yields, and a tie goes to the review", async (t) => {
  reset();
  const heads = HEADS.map((prNumber) => ({ prNumber, sinceMs: HEADS_SINCE }));
  const pure = { waitingGreenHeads: heads, cadenceMs: CADENCE, nowMs: NOW, widthReason: PRECEDENCE_WIDTH_REASON };
  assert.equal(reviewPrecedence({ ...pure, buildWaitingSinceMs: at("17:00:00") }), "yield", "the heads waited longer");
  assert.equal(reviewPrecedence({ ...pure, buildWaitingSinceMs: HEADS_SINCE }), "yield", "a tie goes to the review");
  assert.equal(reviewPrecedence({ ...pure, buildWaitingSinceMs: HEADS_SINCE - 1 }), "proceed");

  // The hold names the same heads as origin/main's, and one row opens the spell.
  recordReading(NOW);
  const before = reviewPrecedenceHold("dispatch", NOW, CADENCE);
  reset();
  recordReading(NOW);
  const logged: Logged[] = [];
  const log = (step: string, fields: Record<string, unknown> = {}) => logged.push({ step, fields });
  for (const buildSince of [at("17:00:00"), HEADS_SINCE]) {
    const hold = reviewPrecedenceHold("dispatch", NOW, CADENCE, log, buildSince);
    assert.equal(hold?.control, "REVIEW", iso(buildSince));
    assert.deepEqual(hold, before, "the same hold, naming the same heads");
    assert.match(hold!.detail, /2 green head\(s\) wait for review .*\(#21041, #20913\)/);
  }
  const spell = logged.filter((row) => row.step === "sweep.budget_yield");
  assert.equal(spell.length, 1, "one row for the held spell");
  assert.equal(spell[0]!.fields.lane, "build");
  assert.deepEqual(spell[0]!.fields.waiting_heads, HEADS);
  assert.equal(spell[0]!.fields.build_waiting_since, iso(at("17:00:00")), "the row carries when the build began waiting");

  // End to end: a daemon whose build demand begins at 17:00, after the heads, is still held at 18:01.
  reset();
  const d = todaysDay(t, { buildFrom: at("17:00:00") });
  await d.run();
  assert.deepEqual(d.started, [], "the build yields to the heads that waited longer");
  assert.equal(d.yields().length, 1, "one row for the held spell across ticks");
  assert.equal(d.yields()[0]!.fields.lane, "build");
  assert.deepEqual(d.yields()[0]!.fields.waiting_heads, HEADS);
});

function sweepFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15291-sweep-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: NOW };
  const dispatched: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T15291", now: () => clock.ms,
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 65_536, floorMib: 1_024 }),
    actionable: (d) => d === "post-review" || d === "blocked-fixable",
    arm: () => { assert.fail("nothing here arms"); },
    close: () => { assert.fail("nothing here closes"); },
    escalate: () => { assert.fail("nothing here escalates"); },
    dispatchFix: (pr) => { dispatched.push(pr.prNumber); },
    postReview: async () => {},
  };
  deps.log = (step, extra = {}) => appendLedger(deps.ledgerPath, { run_id: "SWEEP-T15291", task_id: "SWEEP", step, ...extra });
  const rows = () => readLedgerLines(deps.ledgerPath);
  const append = (row: Row) => appendLedger(deps.ledgerPath, { run_id: "SWEEP", task_id: "SWEEP", step: String(row.step), ...row });
  const pass = async (prs: OpenPrView[]) => {
    await runSweepLightPass(prs, deps, ONE_LANE);
    await drainInFlightReviews({ boundMs: 1_000 });
    await drainDetachedSweepActions();
  };
  return { deps, clock, dispatched, rows, append, pass };
}

function ownRed(prNumber: number): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, headSha: `head-${prNumber}`,
    checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: iso(NOW), redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
  };
}

test("W1-T15291 criterion 3: a new fix round yields to build demand that has waited longer than its pull request", async (t) => {
  reset();
  recordBuildDemandSince(BUILD_SINCE);
  const younger = fixRound(21100, at("15:10:00"), NOW);
  assert.equal(younger.grant.admitted, false);
  assert.equal(younger.consulted, 0, "the claim is not consulted: no reservation is taken or touched");
  assert.match((younger.grant as { reason: string }).reason,
    /^review precedence: dispatchable build demand has waited 205 min \(since 2026-11-28T14:35:53\.000Z\), longer than #21100 has waited \(since 2026-11-28T15:10:00\.000Z\)/);
  assert.match((younger.grant as { reason: string }).reason, /repair remains queued and will be re-derived next pass$/);
  // A fix round older than the build demand, or exactly as old, is the controller's own answer.
  for (const sinceMs of [at("11:38:00"), BUILD_SINCE]) {
    for (const answer of [{ admitted: true as const }, { admitted: false as const, reason: "live host capacity exhausted" }]) {
      const older = fixRound(21101, sinceMs, NOW, PRECEDENCE_WIDTH_REASON, answer);
      assert.equal(older.consulted, 1, iso(sinceMs));
      assert.equal(older.grant, answer, iso(sinceMs));
    }
  }

  // End to end through the light pass: the round re-derives and starts once the build demand ends.
  reset();
  const f = sweepFixture(t);
  const red = ownRed(21100);
  f.append(widthRows(PRECEDENCE_WIDTH_REASON)[0]!);
  f.append(waitingRow(red.prNumber, at("15:10:00"), "own-red"));
  recordBuildDemandSince(BUILD_SINCE);
  await f.pass([red]);
  assert.deepEqual(f.dispatched, [], "the new fix round yields to the longer-waiting build");
  const disposed = f.rows().filter((row) => row.step === "sweep.disposed" && row.pr_number === red.prNumber).at(-1)!;
  assert.match(String(disposed.stand_down_reason), /^review precedence: dispatchable build demand has waited/);
  recordBuildDemandSince(undefined);
  f.clock.ms += MINUTE;
  await f.pass([red]);
  assert.deepEqual(f.dispatched, [red.prNumber], "the repair was re-derived and starts on the next pass");
});

test("W1-T15291 criterion 4: the daemon records when build demand began, clears it on a task start or nothing dispatchable, and decides on that start", async (t) => {
  // The first sample stamps the demand; later ticks keep that start, and both readers decide on it.
  reset();
  const mirror: Array<{ atMs: number; admitted: boolean; reason?: string }> = [];
  const askFixRound = (atMs: number) => {
    const round = fixRound(21100, at("15:10:00"), atMs);
    mirror.push({ atMs, admitted: round.consulted === 1, ...(round.grant.admitted ? {} : { reason: round.grant.reason }) });
  };
  let afterStart: boolean | undefined;
  const d = todaysDay(t, {
    onSleep: (clockMs) => { if (clockMs === at("17:15:53")) askFixRound(clockMs); },
    runOne: async (id) => {
      d.started.push(id);
      await flush(); // the pool notes the start once the worker's promise is in hand
      afterStart = fixRound(21100, at("15:10:00"), NOW).consulted === 1;
      recordReading(NOW);
      d.finished.push(id);
      return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
    },
  });
  await d.run();
  assert.equal(mirror.length, 1);
  assert.equal(mirror[0]!.admitted, false, "at 17:15 the build demand recorded at 14:35:53 outranks a round waiting since 15:10");
  assert.match(mirror[0]!.reason!, /since 2026-11-28T14:35:53\.000Z/, "the recorded start, not a fresh one per tick");
  assert.deepEqual(d.started, ["W1-T15182"], "reviewPrecedenceHold decided on the recorded start");
  assert.equal(afterStart, true, "the task start cleared the build demand");

  // A sample with nothing dispatchable clears it.
  reset();
  const clock = { ms: BUILD_SINCE };
  const seen: boolean[] = [];
  const e = daemonFixture(t, ["W1-T15193"], {
    clock, ticks: 2, governed: memoryGovernor(() => true),
    onSleep: (sleeps) => {
      clock.ms += 5 * MINUTE;
      seen.push(fixRound(21100, at("14:40:00"), clock.ms).consulted === 1);
      if (sleeps === 1) e.finished.push("W1-T15193"); // merged elsewhere: nothing is dispatchable on the next tick
    },
  });
  await e.run();
  assert.deepEqual(e.started, []);
  assert.deepEqual(seen, [false, true], "held demand outranks the round; once nothing is dispatchable it does not");
});

test("W1-T15291 criterion 5: invariant:order-by-wait-only — only who starts next changes", async (t) => {
  // No dispatchable build demand: every hold and fix admission is origin/main's.
  reset();
  for (const answer of [{ admitted: true as const }, { admitted: false as const, reason: "live host capacity exhausted" }]) {
    const round = fixRound(21100, at("15:10:00"), NOW, PRECEDENCE_WIDTH_REASON, answer);
    assert.equal(round.grant, answer);
  }
  recordReading(NOW);
  const held = reviewPrecedenceHold("dispatch", NOW, CADENCE, undefined, undefined);
  assert.equal(held?.control, "REVIEW", "with no build demand the heads hold the build as before");

  // A width reason other than host-worker-budget: nothing yields, whatever the build has waited.
  for (const width of ["backlog-not-sustained", "cpu-pressure", "healthy-window", null]) {
    reset();
    recordBuildDemandSince(BUILD_SINCE);
    for (const answer of [{ admitted: true as const }, { admitted: false as const, reason: "live host capacity exhausted" }]) {
      const round = fixRound(21100, at("15:10:00"), NOW, width, answer);
      assert.equal(round.grant, answer, String(width));
    }
    recordReading(NOW, HEADS_SINCE, width);
    assert.equal(reviewPrecedenceHold("dispatch", NOW, CADENCE, undefined, BUILD_SINCE), undefined, String(width));
    assert.equal(reviewPrecedenceHold("dispatch", NOW, CADENCE, undefined, undefined), undefined, String(width));
  }
  // Other worker starts are never held.
  reset();
  recordReading(NOW);
  for (const surface of ["intake", "retro", "auto-triage", "wipe-test"]) {
    assert.equal(reviewPrecedenceHold(surface, NOW, CADENCE, undefined, at("17:00:00")), undefined, surface);
  }

  // The memory governor's container-short hold still holds a build the precedence no longer holds.
  reset();
  const clock = { ms: BUILD_SINCE };
  const d = daemonFixture(t, ["W1-T15182"], {
    clock, ticks: 4, governed: memoryGovernor(() => true, "container-short"),
    onSleep: () => { clock.ms = clock.ms < NOW ? NOW : clock.ms + MINUTE; recordReading(clock.ms); },
  });
  await d.run();
  assert.deepEqual(d.started, [], "the container-short hold still holds the build");
  assert.equal(d.yields().length, 0, "review precedence no longer holds it");
  const governor = d.rows.filter((row) => row.step === "daemon.queue_governor" && row.fields.held_by === "memory");
  assert.ok(governor.length >= 3, `the memory hold is named on every tick (${governor.length})`);
  assert.equal(governor.at(-1)!.fields.pressure_tier, "container-short");

  // A running fix round is never stopped or re-dispatched, and a running build lane runs to its own end.
  reset();
  const kill = t.mock.method(process, "kill", () => { throw Error("the precedence must not signal anything"); });
  const f = sweepFixture(t);
  const [running, fresh] = [ownRed(21100), ownRed(21101)];
  let finishFix!: () => void;
  const fixRunning = new Promise<void>((resolve) => { finishFix = resolve; });
  let fixDone = false;
  f.deps.dispatchFix = (pr) => { f.dispatched.push(pr.prNumber); return fixRunning.then(() => { fixDone = true; }); };
  f.append(widthRows(PRECEDENCE_WIDTH_REASON)[0]!);
  await runSweepLightPass([running], f.deps, ONE_LANE);
  assert.deepEqual(f.dispatched, [running.prNumber]);
  const budgetBefore = f.rows().filter((row) => row.step === "sweep.fix_capacity").map((row) => row.host_worker_budget);
  recordBuildDemandSince(BUILD_SINCE);
  f.append(waitingRow(fresh.prNumber, at("15:10:00"), "own-red"));
  f.clock.ms += MINUTE;
  await runSweepLightPass([running, fresh], f.deps, ONE_LANE);
  assert.deepEqual(f.dispatched, [running.prNumber], "the new round yields; the running one is not dispatched again");
  assert.equal(fixDone, false, "the running round is still running");
  const budgetAfter = f.rows().filter((row) => row.step === "sweep.fix_capacity").map((row) => row.host_worker_budget);
  assert.ok(budgetBefore.length > 0, "the controller wrote its capacity row");
  assert.deepEqual(new Set(budgetAfter), new Set(budgetBefore), "the host worker budget value is unchanged");
  finishFix();
  await drainInFlightReviews({ boundMs: 1_000 });
  await drainDetachedSweepActions();
  assert.equal(fixDone, true, "the running round ran to its own end");

  reset();
  let aborted = false;
  const e = todaysDay(t, {
    runOne: async (id, ...rest) => {
      e.started.push(id);
      // While it runs, older heads arrive and a newer build demand is recorded: nothing reaches the running lane.
      recordReading(NOW, at("10:00:00"));
      recordBuildDemandSince(NOW);
      await flush();
      aborted = (rest as Array<{ signal?: AbortSignal }>).some((arg) => arg?.signal?.aborted === true);
      e.finished.push(id);
      return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
    },
  });
  await e.run();
  assert.deepEqual(e.finished, ["W1-T15182"], "the running build ran to its own end");
  assert.equal(aborted, false);
  assert.equal(kill.mock.callCount(), 0);
});
