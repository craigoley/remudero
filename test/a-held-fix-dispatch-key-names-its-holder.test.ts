import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  drainDetachedSweepActions, installDetachedWorkHost, registerChildWork, resetChildWork, runSweep, settleChildWork,
  type FixChildLaunch, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const taskId = "W1-T13287";
const headSha = "e1493c7aaa";
const fixKey = `${taskId}@${headSha}`;
const runId = "work-fix-dispatch-W1-T13287-1";
const pr = (prNumber: number): OpenPrView => ({
  prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId, headSha, headRefName: `run-${taskId}-1`,
  reviewState: "failure", checksState: "green", priorStrikes: 0, autoMergeArmed: false,
  lastActivityAt: new Date(Date.now()).toISOString(),
  unmetCriteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "broken", proof_exec: "executed_fail" }],
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const rows: Record<string, unknown>[] = [];
  const log = (step: string, fields?: Record<string, unknown>) => rows.push({ ts: new Date(now).toISOString(), step, ...fields });
  const deps: SweepDeps = {
    runId: "SWEEP-T13287", ledgerPath: "/unused/t13287-ledger.ndjson", now: () => now, detachFixWait: true,
    readLedger: () => [...rows], appendLine: (_path, row) => { log(String(row.step), row); }, log,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    escalate: () => assert.fail("unexpected escalation"), dispatchFix: () => assert.fail("unexpected in-process dispatch"),
  };
  return {
    deps, log, advance: (ms: number) => { now += ms; }, pass: (number = 18855) => runSweep([pr(number)], deps),
    disposed: () => rows.findLast(row => row.step === "sweep.disposed" && row.acted === false),
    rounds: () => rows.filter(row => row.step === "fix.dispatch" || row.step === "sweep.fix.child").map(row => row.step),
  };
}

test("W1-T13287 criterion 1 and W1-T13287 criterion 3: a refused sweep records the registered fix child and its age", async t => {
  const f = fixture(t);
  registerChildWork({ kind: "fix-dispatch", taskId, fixKey, runId });
  t.after(resetChildWork);
  f.advance(12_345);
  await f.pass();
  assert.equal(f.disposed()?.stand_down_reason,
    `duplicate fix-dispatch key (${fixKey}) is held by fix run child ${runId}, running for 12s`);
  assert.equal(f.disposed()?.in_flight_action, "fix-child");
  assert.equal(f.disposed()?.in_flight_run_id, runId);
  assert.equal(f.disposed()?.in_flight_age_ms, 12_345);
  assert.deepEqual(f.rounds(), []);
  assert.equal(settleChildWork(runId), true);
  f.deps.dispatchFix = () => { f.log("fix.dispatch"); };
  await f.pass();
  await drainDetachedSweepActions();
  assert.deepEqual(f.rounds(), ["fix.dispatch"]);
});

test("W1-T13287 criterion 2 and W1-T13287 criterion 4: a pending launch hands its key to one adopted child", async t => {
  const f = fixture(t);
  const entered = deferred();
  const launch = deferred<FixChildLaunch | undefined>();
  const child = deferred();
  const acknowledged = deferred();
  let launches = 0;
  installDetachedWorkHost({
    hosts: new Set(["fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined,
    spawnFix: () => { launches++; entered.resolve(); return launch.promise; },
  });
  const first = f.pass();
  t.after(async () => {
    launch.resolve(undefined);
    child.resolve();
    try {
      await first;
    } finally {
      installDetachedWorkHost(undefined);
      resetChildWork();
    }
  });
  await entered.promise;
  f.advance(4_500);
  await f.pass();
  assert.equal(f.disposed()?.stand_down_reason,
    `duplicate fix-dispatch key (${fixKey}) is held by a fix child launch in progress for 4s`);
  assert.equal(f.disposed()?.in_flight_action, "fix-child-launch");
  assert.equal(f.disposed()?.in_flight_age_ms, 4_500);
  assert.equal(launches, 1);
  assert.deepEqual(f.rounds(), []);

  launch.resolve({ runId, settled: child.promise, acknowledge: () => acknowledged.resolve() });
  await first;
  f.advance(8_000);
  await f.pass();
  assert.equal(f.disposed()?.stand_down_reason,
    `duplicate fix-dispatch key (${fixKey}) is held by fix run child ${runId}, running for 8s`);
  assert.equal(f.disposed()?.in_flight_action, "fix-child");
  assert.equal(f.disposed()?.in_flight_run_id, runId);
  assert.equal(f.disposed()?.in_flight_age_ms, 8_000);
  assert.equal(launches, 1);
  assert.deepEqual(f.rounds(), ["sweep.fix.child"]);

  child.resolve();
  await acknowledged.promise;
  installDetachedWorkHost(undefined);
  f.deps.dispatchFix = () => { f.log("fix.dispatch"); };
  await f.pass(18856);
  await drainDetachedSweepActions();
  assert.deepEqual(f.rounds(), ["sweep.fix.child", "fix.dispatch"]);
});

test("W1-T13287 criterion 4: disposal distinguishes a detached holder from a bare claim", async t => {
  const f = fixture(t);
  const worker = deferred();
  f.deps.dispatchFix = async (_pr, _evidence, phase) => {
    f.log("fix.dispatch");
    phase?.("worker");
    await worker.promise;
  };
  t.after(async () => { worker.resolve(); await drainDetachedSweepActions(); });
  await f.pass();
  f.advance(6_000);
  await f.pass(18856);
  assert.match(String(f.disposed()?.stand_down_reason), /held by its own detached fix dispatch, worker for 6s/);
  assert.equal(f.disposed()?.in_flight_action, "fix-dispatch");
  assert.equal(f.disposed()?.in_flight_age_ms, 6_000);
  assert.deepEqual(f.rounds(), ["fix.dispatch"]);
  worker.resolve();
  await drainDetachedSweepActions();

  f.deps.detachFixWait = false;
  const inlineEntered = deferred();
  const inlineRound = deferred();
  f.deps.dispatchFix = async () => {
    f.log("fix.dispatch");
    inlineEntered.resolve();
    await inlineRound.promise;
  };
  const first = f.pass(18856);
  try {
    await inlineEntered.promise;
    await f.pass(18857);
    const row = f.disposed();
    assert.equal(row?.stand_down_reason, `duplicate fix-dispatch key (${fixKey}) already claimed this pass`);
    assert.deepEqual(Object.keys(row ?? {}).filter(key => key.startsWith("in_flight_")), []);
    assert.deepEqual(f.rounds(), ["fix.dispatch", "fix.dispatch"]);
  } finally {
    inlineRound.resolve();
    await first;
  }
});
