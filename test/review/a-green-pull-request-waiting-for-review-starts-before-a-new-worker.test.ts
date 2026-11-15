/**
 * W1-T12712 — a green pull request waiting for review starts before a new fix or build worker.
 *
 * The sweep cases run `runSweepLightPass` with the production fix admission controller; the daemon cases run
 * `runDaemon` on the reading that light pass recorded. Nothing stands in for the precedence.
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
  PRECEDENCE_WIDTH_REASON, reviewPrecedence, reviewPrecedenceHold, waitingGreenHeadsFromLedger, yieldingFixClaim,
} from "#src/lib/review-precedence.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, drainDetachedSweepActions, drainInFlightReviews, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const T0 = Date.UTC(2026, 10, 14, 20, 0, 0);
const CADENCE = DEFAULT_POLL_INTERVAL_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

function green(prNumber: number): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, headSha: `green-${prNumber}`,
    checksState: "green", reviewState: "none", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: iso(T0 - 600_000), createdAt: iso(T0 - 900_000),
  };
}

function ownRed(prNumber: number): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, headSha: `red-${prNumber}`,
    checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: iso(T0), redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
  };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12712-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: T0 };
  const dispatched: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T12712", now: () => clock.ms,
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 65_536, floorMib: 1_024 }),
    actionable: (d) => d === "post-review" || d === "blocked-fixable",
    arm: () => { assert.fail("nothing here arms"); },
    close: () => { assert.fail("nothing here closes"); },
    escalate: () => { assert.fail("nothing here escalates"); },
    dispatchFix: (pr) => { dispatched.push(pr.prNumber); },
    postReview: async () => {},
  };
  deps.log = (step, extra = {}) => appendLedger(deps.ledgerPath, { run_id: "SWEEP-T12712", task_id: "SWEEP", step, ...extra });
  const rows = () => readLedgerLines(deps.ledgerPath);
  const yields = () => rows().filter((row) => row.step === "sweep.budget_yield");
  const disposed = (prNumber: number) => rows().filter((row) => row.step === "sweep.disposed" && row.pr_number === prNumber);
  /** The last width decision's reason, as the review capacity controller writes it. */
  const width = (reason: string) => appendLedger(deps.ledgerPath, { run_id: "SWEEP", task_id: "SWEEP", step: "review.capacity", reason });
  /** A head the sweep has seen waiting for review since `sinceMs`. */
  const waiting = (pr: OpenPrView, sinceMs: number) => appendLedger(deps.ledgerPath, {
    run_id: "SWEEP", task_id: pr.taskId!, step: "sweep.disposed", pr_number: pr.prNumber, disposition: "post-review",
    blocker: "awaiting-review", blocker_since: iso(sinceMs), head_sha: pr.headSha,
  });
  const pass = async (prs: OpenPrView[]) => {
    await runSweepLightPass(prs, deps, ONE_LANE);
    await drainInFlightReviews({ boundMs: 1_000 });
    await drainDetachedSweepActions();
  };
  return { deps, clock, dispatched, rows, yields, disposed, width, waiting, pass };
}

/** Ends any held spell this process carries from an earlier test, through the public entry points. */
function endSpells(): void {
  yieldingFixClaim("light", () => ({ admitted: true }), [], T0, undefined, [])({ prNumber: 1 });
  reviewPrecedenceHold("dispatch", T0, CADENCE);
}

test("W1-T12712 criterion 1 reviewPrecedence yields only for a green head past one cadence under host-worker-budget", () => {
  const head = { prNumber: 7, sinceMs: T0 - CADENCE - 1 };
  const at = { cadenceMs: CADENCE, nowMs: T0, widthReason: PRECEDENCE_WIDTH_REASON };
  assert.equal(reviewPrecedence({ ...at, waitingGreenHeads: [head] }), "yield");
  assert.equal(reviewPrecedence({ ...at, waitingGreenHeads: [{ prNumber: 7, sinceMs: T0 - CADENCE }] }), "proceed",
    "a wait of exactly one cadence is not longer than it");
  assert.equal(reviewPrecedence({ ...at, waitingGreenHeads: [] }), "proceed");
  for (const widthReason of ["backlog-not-sustained", "cpu-pressure", "healthy-window", undefined]) {
    assert.equal(reviewPrecedence({ ...at, widthReason, waitingGreenHeads: [head] }), "proceed", String(widthReason));
  }
  assert.equal(reviewPrecedence({ ...at, cadenceMs: 0, waitingGreenHeads: [head] }), "proceed");
  // Only a green head whose newest row waits for review at the same head is a waiting green head.
  const lines = [
    { step: "sweep.disposed", pr_number: 7, blocker: "awaiting-review", blocker_since: iso(T0 - 600_000), head_sha: "a" },
    { step: "sweep.disposed", pr_number: 8, blocker: "awaiting-review", blocker_since: iso(T0 - 600_000), head_sha: "old" },
    { step: "sweep.disposed", pr_number: 9, blocker: "own-red", blocker_since: iso(T0 - 600_000), head_sha: "c" },
  ];
  const heads = waitingGreenHeadsFromLedger(lines, [
    { prNumber: 7, headSha: "a", checksState: "green" }, { prNumber: 8, headSha: "new", checksState: "green" },
    { prNumber: 9, headSha: "c", checksState: "green" }, { prNumber: 7, headSha: "a", checksState: "red" },
  ]);
  assert.deepEqual(heads, [{ prNumber: 7, sinceMs: T0 - 600_000 }]);
});

test("W1-T12712 criterion 2 while precedence yields the light pass starts no fix round and writes one row per held spell", async (t) => {
  endSpells();
  const f = fixture(t);
  const [admitted, waits, red] = [green(18001), green(18002), ownRed(18003)];
  f.width(PRECEDENCE_WIDTH_REASON);
  f.waiting(admitted, T0 - 900_000);
  f.waiting(waits, T0 - 600_000);
  await f.pass([admitted, waits, red]);
  assert.deepEqual(f.dispatched, [], "no new fix round starts");
  assert.match(String(f.disposed(red.prNumber).at(-1)!.stand_down_reason), /^review precedence: 1 green head\(s\) wait for review .*#18002/);
  assert.equal(f.yields().length, 1);
  const row = f.yields()[0]!;
  assert.equal(row.lane, "fix");
  assert.equal(row.surface, "light");
  assert.deepEqual(row.waiting_heads, [waits.prNumber], "the head given a review lane this pass does not wait");
  assert.equal(row.width_reason, PRECEDENCE_WIDTH_REASON);
  f.clock.ms += 1_000;
  await f.pass([admitted, waits, red]);
  assert.deepEqual(f.dispatched, [], "still held on the next pass");
  assert.equal(f.yields().length, 1, "one row for the whole held spell");
});

function daemonFixture(dir: string, ids: string[], opts: { at: () => number; runOne?: DaemonDeps["runOne"]; ticks?: number }) {
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const started: string[] = [];
  const finished: string[] = [];
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let sleeps = 0;
  const deps: DaemonDeps = {
    refreshMerged: () => (id) => finished.includes(id),
    runOne: opts.runOne ?? (async (id) => {
      started.push(id);
      finished.push(id);
      return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
    }),
    sleep: async () => { sleeps++; await flush(); },
    now: () => new Date(opts.at()),
    checkStop: () => sleeps >= (opts.ticks ?? 2) ? "fixture done" : undefined,
    workerAdmissionHold: () => undefined,
    log: (step, fields = {}) => rows.push({ step, fields }),
  };
  return { path, deps, started, finished, rows, yields: () => rows.filter((r) => r.step === "sweep.budget_yield") };
}

test("W1-T12712 criterion 2 while precedence yields the daemon's build dispatch starts no worker", async (t) => {
  endSpells();
  const f = fixture(t);
  f.width(PRECEDENCE_WIDTH_REASON);
  f.waiting(green(18002), T0 - 600_000);
  await f.pass([green(18001), green(18002), ownRed(18003)]);
  const d = daemonFixture(join(f.deps.ledgerPath, ".."), ["W1-T1"], { at: () => T0 + 1_000 });
  await runDaemon(loadPlan(d.path), d.deps, { pollIntervalMs: CADENCE, max: 1 });
  assert.deepEqual(d.started, [], "no build worker starts");
  assert.equal(d.yields().length, 1, "one row for the held spell across ticks");
  assert.equal(d.yields()[0]!.fields.lane, "build");
  assert.equal(d.yields()[0]!.fields.surface, "dispatch");
  assert.deepEqual(d.yields()[0]!.fields.waiting_heads, [18002]);
});

test("W1-T12712 criterion 3 held fix and build work starts on the first pass with no green head past the cadence", async (t) => {
  endSpells();
  const f = fixture(t);
  const [admitted, waits, red] = [green(18001), green(18002), ownRed(18003)];
  f.width(PRECEDENCE_WIDTH_REASON);
  f.waiting(waits, T0 - 600_000);
  await f.pass([admitted, waits, red]);
  assert.deepEqual(f.dispatched, []);
  // The waiting head got its review: it is no longer a green head waiting for review.
  f.clock.ms += 1_000;
  await f.pass([admitted, red]);
  assert.deepEqual(f.dispatched, [red.prNumber], "the held fix round starts on the first clear pass");
  const d = daemonFixture(join(f.deps.ledgerPath, ".."), ["W1-T1"], { at: () => f.clock.ms + 1_000 });
  await runDaemon(loadPlan(d.path), d.deps, { pollIntervalMs: CADENCE, max: 1 });
  assert.deepEqual(d.started, ["W1-T1"], "the build dispatch starts once no head waits");
  assert.equal(d.yields().length, 0);
  // The width decision leaving host-worker-budget clears the hold as well.
  const g = fixture(t);
  g.width(PRECEDENCE_WIDTH_REASON);
  g.waiting(waits, T0 - 600_000);
  await g.pass([admitted, waits, red]);
  assert.deepEqual(g.dispatched, []);
  g.width("backlog-not-sustained");
  await g.pass([admitted, waits, red]);
  assert.deepEqual(g.dispatched, [red.prNumber]);
});

test("W1-T12712 criterion 4 a running worker is never stopped or paused by the precedence", async (t) => {
  endSpells();
  const kill = t.mock.method(process, "kill", () => { throw Error("the precedence must not signal anything"); });
  const f = fixture(t);
  const [admitted, waits, first, second] = [green(18001), green(18002), ownRed(18003), ownRed(18004)];
  // A fix round already running when the precedence starts to yield.
  let finishFix!: () => void;
  const running = new Promise<void>((resolve) => { finishFix = resolve; });
  let fixDone = false;
  f.deps.dispatchFix = (pr) => { f.dispatched.push(pr.prNumber); return running.then(() => { fixDone = true; }); };
  await runSweepLightPass([first], f.deps, ONE_LANE);
  assert.deepEqual(f.dispatched, [first.prNumber]);
  f.width(PRECEDENCE_WIDTH_REASON);
  f.waiting(waits, T0 - 600_000);
  f.clock.ms += 1_000;
  await runSweepLightPass([admitted, waits, first, second], f.deps, ONE_LANE);
  assert.deepEqual(f.dispatched, [first.prNumber], "the new round yields; the running one is not dispatched again");
  assert.equal(fixDone, false, "the running round is still running");
  finishFix();
  await drainInFlightReviews({ boundMs: 1_000 });
  await drainDetachedSweepActions();
  assert.equal(fixDone, true, "the running round ran to its own end");
  // A build lane already running when the reading turns to yield finishes; only the refill is held.
  endSpells();
  const g = fixture(t);
  let releaseA!: () => void;
  const aRunning = new Promise<void>((resolve) => { releaseA = resolve; });
  const d = daemonFixture(join(g.deps.ledgerPath, ".."), ["A", "B"], {
    at: () => T0 + 2_000,
    ticks: 3,
    runOne: async (id, ...rest) => {
      d.started.push(id);
      assert.equal((rest as Array<{ signal?: AbortSignal }>).some((arg) => arg?.signal?.aborted), false);
      if (id === "A") {
        g.width(PRECEDENCE_WIDTH_REASON);
        g.waiting(waits, T0 - 600_000);
        await g.pass([admitted, waits]);
        releaseA();
        await aRunning;
      }
      d.finished.push(id);
      return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
    },
  });
  await runDaemon(loadPlan(d.path), d.deps, { pollIntervalMs: CADENCE, max: 2 });
  assert.deepEqual(d.started, ["A"], "B does not start while the review waits");
  assert.deepEqual(d.finished, ["A"], "A ran to its own end");
  assert.equal(d.yields().length, 1);
  assert.equal(kill.mock.callCount(), 0);
});

test("W1-T12712 criterion 5 with no review waiting every fix and build decision equals the one before", async (t) => {
  endSpells();
  // The wrapped claim returns the controller's own answer, admitted or refused.
  const yes = { admitted: true as const };
  const no = { admitted: false as const, reason: "live host capacity exhausted for this light pass" };
  for (const answer of [yes, no]) {
    const claim = yieldingFixClaim("light", () => answer, [{ step: "review.capacity", reason: PRECEDENCE_WIDTH_REASON }], T0, undefined, []);
    assert.equal(claim({ prNumber: 5 }), answer);
  }
  assert.equal(yieldingFixClaim("full", undefined, [], T0, undefined, []), undefined, "no claim stays no claim");
  assert.equal(reviewPrecedenceHold("dispatch", T0, CADENCE), undefined);
  // Under host-worker-budget with only red heads, the light pass dispatches exactly as before.
  const f = fixture(t);
  f.width(PRECEDENCE_WIDTH_REASON);
  await f.pass([ownRed(18003)]);
  assert.deepEqual(f.dispatched, [18003]);
  assert.equal(f.yields().length, 0);
  // A head waiting under one cadence is not yet a wait that holds anything.
  const g = fixture(t);
  g.width(PRECEDENCE_WIDTH_REASON);
  g.waiting(green(18002), T0 - CADENCE / 2);
  await g.pass([green(18001), green(18002), ownRed(18003)]);
  assert.deepEqual(g.dispatched, [18003]);
  const d = daemonFixture(join(g.deps.ledgerPath, ".."), ["W1-T1"], { at: () => T0 + 1_000 });
  await runDaemon(loadPlan(d.path), d.deps, { pollIntervalMs: CADENCE, max: 1 });
  assert.deepEqual(d.started, ["W1-T1"]);
  // Other worker starts (intake, retro, triage) are never held by the precedence.
  for (const surface of ["intake", "retro", "auto-triage", "wipe-test"]) {
    assert.equal(reviewPrecedenceHold(surface, T0, CADENCE), undefined, surface);
  }
});
