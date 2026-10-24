import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDaemon, startInterphaseReviewClock, type DaemonDeps, type LightPassScope } from "#src/lib/daemon.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runSweepLightPass, type LightPassScopeName, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { lightPassActionable, reviewOnlyLightPassDeps } from "#src/run-task.js";

// W1-T9569 — A REVIEW-ONLY LIGHT PASS NAMES ITS SCOPE. Through the orphaned recycle PAUSE of 2026-10-14
// (08:12-10:57Z) the pause clock's review-only passes ledgered every fix and conflict stand-down as
// "deferred to full sweep (light pass)", so 487 PAUSE-held deferrals read as routine light-pass ones.

const NOW = Date.now();
const DEFERRED = "deferred to full sweep (light pass)";
const SCOPES: readonly LightPassScopeName[] = ["pause", "drain", "boot", "idle", "interphase-review"];

function conflicted(): OpenPrView {
  return {
    prNumber: 11679, prUrl: "https://github.com/o/r/pull/11679", taskId: "W1-T8830",
    headSha: "conflicted-head", checksState: "green", reviewState: "success", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    mergeState: "dirty", headRefName: "run-W1-T8830-1791982973874",
    mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "a", theirsLog: "b" },
  };
}

function ownRed(): OpenPrView {
  return {
    prNumber: 10866, prUrl: "https://github.com/o/r/pull/10866", taskId: "W1-T8086",
    headSha: "own-red-head", checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
  };
}

/** The light hook's ordinary batch, as `buildSweepLightHook` wires it for `scope`; the fix rung is closed. */
async function lightPassRows(t: TestContext, scope: LightPassScope | undefined): Promise<Array<Record<string, unknown>>> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9569-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reviewOnly = scope?.reviewOnly === true;
  const fixAdmitted = !reviewOnly && scope?.admit?.("fix-dispatch", "light") !== false;
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T9569", now: () => NOW,
    arm: () => { assert.fail("neither head can arm"); },
    close: () => { assert.fail("neither head can close"); },
    escalate: () => { assert.fail("neither head can escalate"); },
    dispatchFix: () => { assert.fail("a stood-down lane never dispatches"); },
    claimFixAdmission: () => { assert.fail("a stood-down lane never claims a fix slot"); },
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    actionable: (d) => lightPassActionable(d, false, false, !reviewOnly, fixAdmitted),
    ...reviewOnlyLightPassDeps(scope),
  };
  await runSweepLightPass([conflicted(), ownRed()], deps);
  return readLedgerLines(deps.ledgerPath).filter((row) => row.step === "sweep.disposed");
}

test("a review-only pause pass names the pause in its stand-down and light_pass_scope", async (t) => {
  const rows = await lightPassRows(t, { reviewOnly: true, scope: "pause" });
  assert.deepEqual(rows.map((row) => row.disposition).sort(), ["blocked-fixable", "conflicted"]);
  for (const row of rows) {
    assert.equal(row.acted, false, `${row.disposition} stands down under the PAUSE`);
    assert.equal(row.stand_down_reason, "review-only pause pass: repair lanes closed until the PAUSE lifts");
    assert.equal(row.light_pass_scope, "pause", `${row.disposition} carries the scope as a field`);
  }
  for (const scope of SCOPES) {
    const scoped = await lightPassRows(t, { reviewOnly: true, scope });
    assert.equal(scoped.length, 2);
    for (const row of scoped) {
      assert.match(String(row.stand_down_reason), new RegExp(`^review-only ${scope} pass: repair lanes closed until `));
      assert.notEqual(row.stand_down_reason, DEFERRED);
      assert.equal(row.light_pass_scope, scope);
    }
  }
});

// ── the callers ──────────────────────────────────────────────────────────────────────────────────

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

/** The interphase clock's passes under `scope`; the first pass is held open so a second wake overlaps it. */
async function clockScopes(scope?: "pause" | "drain"): Promise<Array<LightPassScope | undefined>> {
  let waiter: ((result: "wake" | "timeout") => void) | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const seen: Array<LightPassScope | undefined> = [];
  const clock = startInterphaseReviewClock({
    refreshMerged: () => { assert.fail("the review clock never refreshes merged tasks"); },
    runOne: async () => { assert.fail("the review clock never dispatches tasks"); },
    sleep: async () => { assert.fail("the review clock uses sleepUntilSweepWake"); },
    sleepUntilSweepWake: () => new Promise((resolve) => (waiter = resolve)),
    sweepLight: async (s) => {
      seen.push(s);
      if (seen.length === 1) await held;
    },
  } satisfies DaemonDeps, 60_000, () => {}, scope);
  const wake = () => { const w = waiter; waiter = undefined; w?.("wake"); };
  try {
    await eventually(() => waiter !== undefined, "the clock never waited");
    wake();
    await eventually(() => seen.length === 1, "the first pass never ran");
    await eventually(() => waiter !== undefined, "the clock never waited again");
    wake();
    await eventually(() => seen.length === 2, "the overlapping pass never ran");
  } finally {
    release();
    const stopped = clock.stop();
    waiter?.("timeout");
    await stopped;
  }
  return seen;
}

function planOf(yaml: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9569-plan-`));
  writeFileSync(join(dir, "tasks.yaml"), yaml);
  return loadPlan(join(dir, "tasks.yaml"));
}

/** A boot with a full sweep and a garden to gate, so tick 1 admits its restricted boot review (W1-T5720). */
async function bootScopes(): Promise<Array<LightPassScope | undefined>> {
  const seen: Array<LightPassScope | undefined> = [];
  const merged = new Set<string>();
  await runDaemon(planOf(`
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" };
    },
    sweep: async () => {},
    sweepLight: async (scope) => { seen.push(scope); },
    gardens: [() => ({ stop: () => {} })],
    checkStop: () => undefined,
    checkPause: () => undefined,
    sleep: async () => { await settle(); },
    log: () => {},
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 60_000 });
  return seen;
}

/** An idle daemon: one idle light pass under eligible review demand. */
async function idleScopes(): Promise<Array<LightPassScope | undefined>> {
  const seen: Array<LightPassScope | undefined> = [];
  const rows: string[] = [];
  let sleeps = 0;
  await runDaemon(planOf(`
- id: W1-T9569-HOLD
  title: no dispatch in this idle fixture
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`), {
    refreshMerged: () => () => false,
    runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    sleepUntilSweepWake: async () => {
      sleeps++;
      await settle();
      return "timeout";
    },
    checkStop: () => (rows.includes("daemon.idle_light_pass") || sleeps > 200 ? "fixture complete" : undefined),
    sweepLight: async (scope) => { seen.push(scope); },
    readIdleReviewDemand: () => ({ eligible: 2, cadenceMs: 700, medianReviewMs: 1_400, pushesPerPrHour: 0.5 }),
    log: (step) => { rows.push(step); },
  }, { pollIntervalMs: 5_000 });
  assert.ok(rows.includes("daemon.idle_light_pass"), "positive control: the idle light pass ran");
  return seen;
}

/** A dispatch phase PAUSEd while its lane is still in flight (W1-T5343's paused-phase review). */
async function pausedPhaseScopes(): Promise<Array<{ paused: boolean; scope: LightPassScope | undefined }>> {
  const seen: Array<{ paused: boolean; scope: LightPassScope | undefined }> = [];
  let paused = false;
  let releaseRunOne!: () => void;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let sleeps = 0;
  const merged = new Set<string>();
  await runDaemon(planOf(`
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      await runOneGate;
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" };
    },
    sweepLight: async (scope) => { seen.push({ paused, scope }); },
    checkStop: () => undefined,
    checkPause: () => (paused ? "operator hold while the batch drains" : undefined),
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) paused = true;
      if (sleeps >= 6) releaseRunOne();
    },
    log: () => {},
  }, { max: 1 });
  await settle();
  return seen;
}

test("every review-only light pass caller names its scope", async () => {
  for (const scope of ["pause", "drain"] as const) {
    const passes = await clockScopes(scope);
    assert.deepEqual(passes.map((p) => [p?.reviewOnly, p?.scope]), [[true, scope], [true, scope]], `the ${scope} clock`);
  }
  const interphase = await clockScopes();
  assert.equal(interphase[0], undefined, "an ordinary interphase pass passes no scope");
  assert.deepEqual([interphase[1]?.reviewOnly, interphase[1]?.scope], [true, "interphase-review"],
    "a pass review-only only because another is in flight names interphase-review");

  const boot = (await bootScopes()).filter((s) => s?.reviewOnly === true);
  assert.ok(boot.length >= 1, "positive control: the boot review ran");
  assert.equal(boot[0]?.scope, "boot", "the boot review names boot");

  const idle = (await idleScopes()).filter((s) => s?.reviewOnly === true);
  assert.ok(idle.length >= 1, "positive control: the idle light pass ran review-only");
  for (const pass of idle) assert.equal(pass?.scope, "idle", "the idle light pass names idle");

  const paused = (await pausedPhaseScopes()).filter((c) => c.paused);
  assert.ok(paused.length >= 1, "positive control: the paused dispatch phase ran a review-only pass");
  for (const call of paused) assert.deepEqual([call.scope?.reviewOnly, call.scope?.scope], [true, "pause"]);

  for (const scope of SCOPES) {
    assert.ok(reviewOnlyLightPassDeps({ reviewOnly: true, scope }).standDownReasonFor, `${scope} wires its own stand-down`);
  }
});

test("an ordinary light pass keeps its deferral text and writes no light_pass_scope", async (t) => {
  assert.deepEqual(reviewOnlyLightPassDeps(), {}, "an ordinary pass passes no scope and wires nothing");
  // A latched restart refuses the fix: the ordinary pass stands both repair lanes down with today's text.
  const rows = await lightPassRows(t, { reviewOnly: false, admit: (kind) => kind !== "fix-dispatch" });
  assert.deepEqual(rows.map((row) => row.disposition).sort(), ["blocked-fixable", "conflicted"]);
  for (const row of rows) {
    assert.equal(row.acted, false);
    assert.equal(row.stand_down_reason, DEFERRED, `${row.disposition} keeps the ordinary deferral`);
    assert.equal(Object.hasOwn(row, "light_pass_scope"), false, `${row.disposition} writes no light_pass_scope`);
  }
});
