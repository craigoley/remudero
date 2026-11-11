import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  lightPassArmAdmitted, lightPassFixAdmitted, startInterphaseReviewClock, type DaemonDeps, type LightPassScope,
  type RestartAdmission,
} from "#src/lib/daemon.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  drainDetachedSweepActions, runSweepLightPass, trackInFlightReview,
  type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { lightPassActionable, reviewOnlyLightPassDeps } from "#src/run-task.js";

// W1-T11502 — A DUE REPAIR GETS A SERIALIZED TURN BETWEEN OVERLAPPING REVIEW PASSES. Consecutive review passes kept
// the clock's "any active pass or in-flight review" condition true, so every pass was review-only and a due repair
// (PR16962) waited behind a stream of reviews. The fixture below drives the real clock and the real light pass.

const NOW = Date.now();
const CONFLICT = {
  files: [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "a", theirsLog: "b",
};

function dirty(headSha = "conflicted-head-a"): OpenPrView {
  return {
    prNumber: 16962, prUrl: "https://github.com/o/r/pull/16962", taskId: "W1-T8830", headSha,
    checksState: "green", reviewState: "success", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW).toISOString(), mergeState: "dirty", headRefName: "run-W1-T8830-1791982973874",
    mergeConflict: CONFLICT,
  };
}

function settled(headSha = "settled-head"): OpenPrView {
  return { ...dirty(headSha), mergeState: "clean", mergeConflict: undefined, autoMergeArmed: true };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate: () => boolean, message: string, pump?: () => void): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    pump?.();
    await tick();
  }
  assert.fail(message);
}

/** The clock and the light pass as `buildSweepLightHook` wires them, with every completion under test control. */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11502-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatched: Array<{ headSha: string; evidence: FixDispatchEvidence }> = [];
  const admitted: string[] = [];
  const state = {
    prs: [dirty()] as OpenPrView[],
    capacity: undefined as string | undefined,
    workerHold: undefined as string | undefined,
  };
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T11502", now: () => NOW,
    arm: () => { assert.fail("a conflicted head cannot arm"); },
    close: () => { assert.fail("a conflicted head cannot close"); },
    escalate: () => { assert.fail("a first conflict round cannot escalate"); },
    dispatchFix: (pr, evidence) => { dispatched.push({ headSha: pr.headSha, evidence }); },
    claimFixAdmission: (pr) => {
      admitted.push(pr.headSha);
      return state.capacity === undefined ? { admitted: true } : { admitted: false, reason: state.capacity };
    },
    workerAdmissionHold: () => state.workerHold,
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
  };
  const scopes: Array<LightPassScope | undefined> = [];
  const gates: Array<Promise<void>> = [];
  const passes: Array<{ scope: LightPassScope | undefined; settleAt: () => void }> = [];
  const steps: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let blockNext = 0;
  const sweepLight = async (scope?: LightPassScope): Promise<void> => {
    scopes.push(scope);
    const fixAdmitted = lightPassFixAdmitted(scope);
    await runSweepLightPass(state.prs, {
      ...deps,
      actionable: (d) => lightPassActionable(d, false, false, lightPassArmAdmitted(scope), fixAdmitted),
      ...reviewOnlyLightPassDeps(scope),
      ...(scope?.observeRepairTurn ? { observeRepairTurn: scope.observeRepairTurn } : {}),
    });
    if (blockNext > 0) {
      blockNext -= 1;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      gates.push(gate);
      passes.push({ scope, settleAt: release });
      await gate;
    }
  };
  let waiter: ((result: "wake" | "timeout") => void) | undefined;
  const wake = (result: "wake" | "timeout" = "wake") => { const w = waiter; waiter = undefined; w?.(result); };
  const clockDeps = (extra: Partial<DaemonDeps> = {}): DaemonDeps => ({
    refreshMerged: () => { assert.fail("the review clock never refreshes merged tasks"); },
    runOne: async () => { assert.fail("the review clock never dispatches tasks"); },
    sleep: async () => { assert.fail("the review clock uses sleepUntilSweepWake"); },
    sleepUntilSweepWake: () => new Promise((resolve) => (waiter = resolve)),
    sweepLight,
    ...extra,
  });
  const disposed = () => readLedgerLines(deps.ledgerPath).filter((row) => row.step === "sweep.disposed");
  const named = (step: string) => steps.filter((s) => s.step === step).map((s) => s.extra);
  return {
    deps, state, dispatched, admitted, scopes, passes, steps, disposed, named, wake, clockDeps,
    block: (n: number) => { blockNext = n; },
    log: (step: string, extra: Record<string, unknown> = {}) => { steps.push({ step, extra }); },
    waiting: () => waiter !== undefined,
    drain: drainDetachedSweepActions,
  };
}

/** An unrelated review that stays in flight until `finish`, as one admitted by the full sweep would. */
function unrelatedReview(t: TestContext): () => void {
  let finish!: () => void;
  const work = new Promise<void>((resolve) => { finish = resolve; });
  void trackInFlightReview(work, { prNumber: 1, kind: "review" });
  t.after(() => finish());
  return finish;
}

test("W1-T11502 criterion 1: under continuing review arrivals a due plan repair gets a serialized ordinary turn", async (t) => {
  const f = fixture(t);
  const finishReview = unrelatedReview(t);
  f.block(1);
  const clock = startInterphaseReviewClock(f.clockDeps(), 60_000, f.log);
  try {
    await eventually(() => f.waiting(), "the clock never waited");
    f.wake();
    await eventually(() => f.scopes.length === 1, "the first pass never ran", () => f.wake("timeout"));
    // An unrelated review is in flight, so the first pass is review-only and stands the repair down as debt.
    assert.equal(f.scopes[0]!.reviewOnly, true);
    assert.equal(f.dispatched.length, 0, "the review-only pass opens no repair lane");
    await eventually(() => f.named("daemon.review_clock.repair_requested").length === 1, "no repair request was retained");
    assert.deepEqual(f.named("daemon.review_clock.repair_requested")[0]!.head_sha, "conflicted-head-a");

    // Review arrivals keep coming while the incumbent is still open: no new overlapping pass starts.
    for (let i = 0; i < 5; i++) {
      await eventually(() => f.waiting(), "the clock never waited again");
      f.wake();
      await tick();
    }
    assert.equal(f.scopes.length, 1, "the pending repair reserves the next pass instead of a new overlapping review");
    assert.equal(f.dispatched.length, 0);

    // The incumbent settles; the repair takes the next permitted turn although arrivals have not stopped
    // and the unrelated review is still in flight.
    f.passes[0]!.settleAt();
    await eventually(() => f.scopes.length === 2, "the repair never got its turn", () => f.wake());
    assert.equal(f.scopes[1]!.reviewOnly, false, "the handed-off pass is the ordinary, repair-capable pass");
    await f.drain();
    assert.equal(f.dispatched.length, 1, "exactly one repair starts");
    assert.equal(f.dispatched[0]!.headSha, "conflicted-head-a", "the repair is bound to the exact observed head");
    assert.deepEqual(f.dispatched[0]!.evidence.mergeConflict, CONFLICT);
    assert.deepEqual(f.admitted, ["conflicted-head-a"], "the repair takes the ordinary fix-capacity claim");
    assert.equal(f.named("daemon.review_clock.repair_handoff").length, 1);
    assert.equal(f.named("daemon.review_clock.repair_handoff")[0]!.review_only, false);
    assert.equal(f.named("daemon.review_clock.repair_discarded").length, 0);
  } finally {
    finishReview();
    f.passes.forEach((p) => p.settleAt());
    const stopped = clock.stop();
    f.wake("timeout");
    await stopped;
  }
});

test("W1-T11502 criterion 2: overlap stays bounded, wake debt survives and stale requests are discarded with a reason", async (t) => {
  // Without a due repair the existing width holds: a second pass overlaps, a third waits.
  const plain = fixture(t);
  plain.state.prs = [settled()];
  plain.block(2);
  const plainClock = startInterphaseReviewClock(plain.clockDeps(), 60_000, plain.log);
  try {
    await eventually(() => plain.waiting(), "the clock never waited");
    plain.wake();
    await eventually(() => plain.scopes.length === 1, "first pass", () => plain.wake("timeout"));
    await eventually(() => plain.waiting(), "waiting");
    plain.wake();
    await eventually(() => plain.scopes.length === 2, "the overlapping pass");
    for (let i = 0; i < 4; i++) {
      await eventually(() => plain.waiting(), "waiting again");
      plain.wake();
      await tick();
    }
    assert.equal(plain.scopes.length, 2, "review overlap stays at its existing width");
    assert.equal(plain.named("daemon.review_clock.repair_requested").length, 0);
  } finally {
    plain.passes.forEach((p) => p.settleAt());
    const stopped = plainClock.stop();
    plain.wake("timeout");
    await stopped;
  }

  // A new-green wake that arrived during the hold is still pending: the handoff pass consumes it.
  const woken = fixture(t);
  const finishReview = unrelatedReview(t);
  woken.block(1);
  const wokenClock = startInterphaseReviewClock(woken.clockDeps(), 60_000, woken.log);
  try {
    await eventually(() => woken.waiting(), "waiting");
    woken.wake();
    await eventually(() => woken.scopes.length === 1, "first pass", () => woken.wake("timeout"));
    await eventually(() => woken.named("daemon.review_clock.repair_requested").length === 1, "request");
    // The same head observed again is one request, never a second repair.
    woken.scopes[0]!.observeRepairTurn!({ prNumber: 16962, headSha: "conflicted-head-a", disposition: "conflicted", due: true });
    assert.equal(woken.named("daemon.review_clock.repair_requested").length, 1);
    await eventually(() => woken.waiting(), "waiting again");
    woken.wake();
    await tick();
    woken.passes[0]!.settleAt();
    await eventually(() => woken.scopes.length === 2, "handoff", () => woken.wake("timeout"));
    await woken.drain();
    assert.ok(woken.named("daemon.review_clock.wake_consumed").length >= 1, "the new-green wake survived the hold");
    assert.equal(woken.dispatched.length, 1, "no duplicate repair starts");
  } finally {
    finishReview();
    woken.passes.forEach((p) => p.settleAt());
    const stopped = wokenClock.stop();
    woken.wake("timeout");
    await stopped;
  }

  // A head that changed, a PR that settled and a PR that left the open set are each discarded with their own reason.
  const cases: Array<{ reason: string; after: () => OpenPrView[]; dispatches: number }> = [
    { reason: "head_changed", after: () => [dirty("conflicted-head-b")], dispatches: 1 },
    { reason: "settled", after: () => [settled("conflicted-head-a")], dispatches: 0 },
    { reason: "not_observed_due", after: () => [], dispatches: 0 },
  ];
  for (const c of cases) {
    const f = fixture(t);
    const finish = unrelatedReview(t);
    f.block(1);
    const clock = startInterphaseReviewClock(f.clockDeps(), 60_000, f.log);
    try {
      await eventually(() => f.waiting(), "waiting");
      f.wake();
      await eventually(() => f.scopes.length === 1, "first pass", () => f.wake("timeout"));
      await eventually(() => f.named("daemon.review_clock.repair_requested").length === 1, "request");
      f.state.prs = c.after();
      f.passes[0]!.settleAt();
      await eventually(() => f.scopes.length === 2, "handoff", () => f.wake());
      await f.drain();
      await eventually(() => f.named("daemon.review_clock.repair_discarded").length === 1, `${c.reason} discard`);
      assert.equal(f.named("daemon.review_clock.repair_discarded")[0]!.reason, c.reason);
      assert.equal(f.named("daemon.review_clock.repair_discarded")[0]!.head_sha, "conflicted-head-a");
      assert.equal(f.dispatched.length, c.dispatches, c.reason);
      if (c.dispatches > 0) assert.equal(f.dispatched[0]!.headSha, "conflicted-head-b", "the new head is handled by its own ordinary rules");
    } finally {
      finish();
      f.passes.forEach((p) => p.settleAt());
      const stopped = clock.stop();
      f.wake("timeout");
      await stopped;
    }
  }
});

test("W1-T11502 criterion 3: pause, boot, drain, freshness, capacity and worker holds keep the repair held and say why", async (t) => {
  // PAUSE: the due request waits and records the actual hold; lifting it lets the repair take its turn.
  const paused = fixture(t);
  const finish = unrelatedReview(t);
  let pause: string | undefined;
  paused.block(1);
  const pausedClock = startInterphaseReviewClock(paused.clockDeps({ checkPause: () => pause }), 60_000, paused.log);
  try {
    await eventually(() => paused.waiting(), "waiting");
    paused.wake();
    await eventually(() => paused.scopes.length === 1, "first pass", () => paused.wake("timeout"));
    await eventually(() => paused.named("daemon.review_clock.repair_requested").length === 1, "request");
    pause = "PAUSE held by operator";
    paused.passes[0]!.settleAt();
    await eventually(() => paused.named("daemon.review_clock.repair_held").length === 1, "pause hold", () => paused.wake("timeout"));
    for (let i = 0; i < 5; i++) { paused.wake("timeout"); await tick(); }
    assert.equal(paused.named("daemon.review_clock.repair_held").length, 1, "one hold row per reason");
    assert.equal(paused.named("daemon.review_clock.repair_held")[0]!.reason, "stop_or_pause");
    assert.equal(paused.named("daemon.review_clock.repair_held")[0]!.detail, "PAUSE held by operator");
    assert.equal(paused.scopes.length, 1, "no pass runs under the pause");
    assert.equal(paused.dispatched.length, 0);
    assert.equal(paused.named("daemon.review_clock.repair_handoff").length, 0, "a held request never claims a handoff");
    pause = undefined;
    await eventually(() => paused.scopes.length === 2, "handoff after the pause lifts", () => paused.wake("timeout"));
    await paused.drain();
    assert.equal(paused.dispatched.length, 1);
  } finally {
    finish();
    paused.passes.forEach((p) => p.settleAt());
    const stopped = pausedClock.stop();
    paused.wake("timeout");
    await stopped;
  }

  // The pause and drain clocks are scoped: they never request, never hand off, never dispatch.
  for (const scope of ["pause", "drain"] as const) {
    const f = fixture(t);
    const clock = startInterphaseReviewClock(f.clockDeps(), 60_000, f.log, scope);
    try {
      await eventually(() => f.waiting(), "waiting");
      f.wake();
      await eventually(() => f.scopes.length === 1, `${scope} pass`, () => f.wake("timeout"));
      await f.drain();
      assert.equal(f.scopes[0]!.reviewOnly, true);
      assert.equal(f.scopes[0]!.scope, scope);
      assert.equal(f.scopes[0]!.observeRepairTurn, undefined, `${scope} never carries repair debt`);
      assert.equal(f.dispatched.length, 0);
      assert.equal(f.named("daemon.review_clock.repair_requested").length, 0);
    } finally {
      const stopped = clock.stop();
      f.wake("timeout");
      await stopped;
    }
  }

  // BOOT (and idle): a review-only scope that is not the interphase clock stands the repair down at the pass itself.
  const boot = fixture(t);
  await (async () => {
    const scope: LightPassScope = { reviewOnly: true, scope: "boot" };
    await runSweepLightPass([dirty()], {
      ...boot.deps,
      actionable: (d) => lightPassActionable(d, false, false, lightPassArmAdmitted(scope), lightPassFixAdmitted(scope)),
      ...reviewOnlyLightPassDeps(scope),
    });
  })();
  assert.equal(boot.dispatched.length, 0);
  assert.equal(boot.admitted.length, 0);
  assert.equal(boot.disposed()[0]!.acted, false);
  assert.equal(boot.disposed()[0]!.light_pass_scope, "boot");
  assert.match(String(boot.disposed()[0]!.stand_down_reason), /^review-only boot pass: repair lanes closed/);

  // FRESHNESS LATCH: a refusing restart admission holds the handoff (and names the latch); a latch that
  // admits reviews but refuses fixes lets the ordinary pass stand the repair down with its own row.
  for (const mode of ["holds-all", "refuses-fix"] as const) {
    const f = fixture(t);
    const fin = unrelatedReview(t);
    let latched = false;
    const admit: RestartAdmission = Object.assign(
      (kind: string) => !latched || (mode === "refuses-fix" && kind !== "fix-dispatch"),
      { heldBy: "restart latch: drain in progress" },
    );
    f.block(1);
    const clock = startInterphaseReviewClock(f.clockDeps(), 60_000, f.log, undefined, admit);
    try {
      await eventually(() => f.waiting(), "waiting");
      f.wake();
      await eventually(() => f.scopes.length === 1, "first pass", () => f.wake("timeout"));
      await eventually(() => f.named("daemon.review_clock.repair_requested").length === 1, "request");
      latched = true;
      f.passes[0]!.settleAt();
      if (mode === "holds-all") {
        await eventually(() => f.named("daemon.review_clock.repair_held").length === 1, "latch hold", () => f.wake("timeout"));
        assert.equal(f.named("daemon.review_clock.repair_held")[0]!.reason, "restart_latch");
        assert.equal(f.named("daemon.review_clock.repair_held")[0]!.detail, "restart latch: drain in progress");
        assert.equal(f.scopes.length, 1);
        assert.equal(f.named("daemon.review_clock.repair_handoff").length, 0);
      } else {
        await eventually(() => f.scopes.length === 2, "handoff", () => f.wake("timeout"));
        await f.drain();
        assert.equal(f.admitted.length, 0, "a refused fix lane never claims a slot");
        assert.equal(f.disposed().filter((row) => row.acted === true).length, 0);
      }
      assert.equal(f.dispatched.length, 0);
    } finally {
      fin();
      f.passes.forEach((p) => p.settleAt());
      const stopped = clock.stop();
      f.wake("timeout");
      await stopped;
    }
  }

  // CAPACITY and WORKER ADMISSION: the ordinary refusal text reaches the row; nothing claims a dispatch.
  for (const refusal of ["capacity", "worker"] as const) {
    const f = fixture(t);
    const fin = unrelatedReview(t);
    f.block(1);
    const text = refusal === "capacity" ? "live host capacity exhausted for this light pass" : "fleet HEAP hold: near limit";
    if (refusal === "capacity") f.state.capacity = text; else f.state.workerHold = text;
    const clock = startInterphaseReviewClock(f.clockDeps(), 60_000, f.log);
    try {
      await eventually(() => f.waiting(), "waiting");
      f.wake();
      await eventually(() => f.scopes.length === 1, "first pass", () => f.wake("timeout"));
      await eventually(() => f.named("daemon.review_clock.repair_requested").length === 1, "request");
      f.passes[0]!.settleAt();
      await eventually(() => f.scopes.length === 2, "handoff", () => f.wake("timeout"));
      await f.drain();
      assert.equal(f.dispatched.length, 0, `${refusal} refusal dispatches nothing`);
      const row = f.disposed().findLast((r) => r.disposition === "conflicted")!;
      assert.equal(row.acted, false);
      assert.match(String(row.stand_down_reason), new RegExp(text.slice(0, 20)));
    } finally {
      fin();
      f.passes.forEach((p) => p.settleAt());
      const stopped = clock.stop();
      f.wake("timeout");
      await stopped;
    }
  }
});
