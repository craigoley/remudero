// W1-T14916: since W1-T14873 a retiring daemon releases its drain lock before its SRE lane page settles. On 2026-11-26
// the retired process then ran 14 sweep passes and started 18 workers over 34 minutes, beside its successor.
import assert from "node:assert/strict";
import test from "node:test";
import { closeDaemonCleanup, createDaemonRetirement, retiringCiJudgeKick } from "#src/cli/commands/daemon.js";
import { withCiJudgeAfterSweep } from "#src/lib/ci-escalation-judge.js";
import { resolveFleetControlHold, type LightPassScope, type RestartAdmission } from "#src/lib/daemon.js";

type Row = { step: string } & Record<string, unknown>;

/** A retiring exit with its SRE lane page still in flight, and the hooks that start sweep passes and workers. */
function retiringExit() {
  const rows: Row[] = [];
  const started: string[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...extra }); };
  const retirement = createDaemonRetirement(log);
  const sweep = retirement.refuse("sweep", async () => { started.push("sweep_pass"); return { swept: true }; });
  const sweepLight = retirement.refuse("sweep_light", () => { started.push("light_pass"); });
  const autoTriage = retirement.refuse("auto_triage", async (feedbackId: string) => { started.push(`worker:${feedbackId}`); });
  let settlePage: () => void = () => {};
  let pageDone = false;
  const page = new Promise<void>((resolve) => { settlePage = () => { pageDone = true; resolve(); }; });
  let lockReleased = false;
  const exit = () => closeDaemonCleanup(
    [{ resource: "drain_lock", close: () => { lockReleased = true; } }, { resource: "stop_marker", close: () => {} }],
    log, { now: () => 0 }, [{ resource: "sre_lane_page", settled: page }], retirement.retire,
  );
  return { rows, started, retirement, sweep, sweepLight, autoTriage, settlePage, exit,
    pageDone: () => pageDone, lockReleased: () => lockReleased };
}

const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker", async () => {
  const run = retiringExit();
  assert.deepEqual(await run.sweep(), { swept: true }, "before the release a sweep pass runs as before");
  await run.sweepLight();
  await run.autoTriage("FB-1");
  assert.deepEqual(run.started, ["sweep_pass", "light_pass", "worker:FB-1"]);

  const exit = run.exit();
  await turns(5);
  assert.ok(run.lockReleased() && !run.pageDone(), "the lock is released while the page is still in flight");
  assert.equal(run.retirement.retired(), true, "the release retires the process");
  assert.equal(await run.sweep(), undefined, "a sweep pass after the release starts nothing");
  assert.equal(await run.sweepLight(), undefined, "a light pass after the release starts nothing");
  assert.equal(await run.autoTriage("FB-2"), undefined, "a worker after the release is not spawned");
  assert.deepEqual(run.started, ["sweep_pass", "light_pass", "worker:FB-1"], "nothing new started after the release");
  assert.deepEqual(run.rows.filter((row) => row.step === "daemon.retired_start_refused").map((row) => row.hook),
    ["sweep", "sweep_light", "auto_triage"], "each refusal is ledgered with the hook it refused");
  run.settlePage();
  await exit;

  // A full sweep and a latched light pass that were already running when the lock was released.
  const late = retiringExit();
  const spawned: string[] = [];
  let finishSweep: () => void = () => {};
  const sweepGate = new Promise<void>((resolve) => { finishSweep = resolve; });
  const admissionHold = () => late.retirement.admissionHold(() => resolveFleetControlHold({}));
  const inFlightSweep = late.retirement.refuse("sweep", withCiJudgeAfterSweep(async () => {
    await sweepGate;
    if (admissionHold() === undefined) spawned.push("fix_worker");
  }, retiringCiJudgeKick(late.retirement, () => { spawned.push("ci_judge_worker"); })))();
  const latch: RestartAdmission = Object.assign(() => true, { heldBy: undefined });
  const scope = late.retirement.lightPassScope<LightPassScope>({ reviewOnly: true, admit: latch });
  assert.equal(scope.admit?.("review", "light"), true, "before the release the latched pass admits its review");
  const lateExit = late.exit();
  await turns(5);
  finishSweep();
  await inFlightSweep;
  assert.deepEqual(spawned, [], "a sweep that settles after the release spawns no fix worker and no CI judge worker");
  assert.deepEqual(admissionHold(), { control: "STOP", detail: "retired: drain lock released; the successor owns this work" });
  assert.equal(scope.admit?.("review", "light"), false, "a light pass still running admits no new review worker");
  assert.equal(scope.admit?.heldBy, "retired: drain lock released; the successor owns this work", "its stand-down names why");
  assert.deepEqual(late.rows.filter((row) => row.step === "daemon.retired_start_refused").map((row) => row.hook),
    ["ci_judge_kick", "light_pass_admission"]);
  late.settlePage();
  await lateExit;
});

test("W1-T14916 criterion 2: in-flight SRE lane page work still completes", async () => {
  const run = retiringExit();
  let passDone = false;
  let finishPass: () => void = () => {};
  const inFlightPass = run.retirement.refuse("sweep", () => new Promise<void>((resolve) => {
    finishPass = () => { passDone = true; resolve(); };
  }))();
  let exited = false;
  const exit = run.exit().then(() => { exited = true; });
  await turns(5);
  assert.equal(run.retirement.retired(), true);
  assert.equal(exited, false, "the exit still waits for the in-flight page");
  finishPass();
  await inFlightPass;
  assert.equal(passDone, true, "a pass that started before the release still finishes");
  run.settlePage();
  await exit;
  assert.equal(run.pageDone(), true, "the in-flight page settled");
  assert.ok(run.rows.some((row) => row.step === "daemon.exit_after_release"), "the page's settle is still timed");
});
