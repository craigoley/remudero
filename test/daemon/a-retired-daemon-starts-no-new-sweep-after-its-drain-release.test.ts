// W1-T14916: since W1-T14873 a retiring daemon releases its drain lock before its SRE lane page settles. On 2026-11-26
// the retired process then ran 14 sweep passes and started 18 workers over 34 minutes, beside its successor.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { closeDaemonCleanup, createDaemonRetirement, retiringCiJudgeKick } from "#src/cli/commands/daemon.js";
import { withCiJudgeAfterSweep } from "#src/lib/ci-escalation-judge.js";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { spawnRunChild } from "#src/lib/run-child.js";
import { resolveFleetControlHold, type LightPassScope, type RestartAdmission } from "#src/lib/daemon.js";
import { spawnWorker, type SpawnWorkerArgs } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

/** A drafter start as the inbox draft rung makes it, with a provider seam that counts real starts. */
function drafterStart(t: TestContext, withheld: Array<Record<string, unknown>>, starts: string[]): SpawnWorkerArgs {
  const root = ownedFixtureDir(t, "retired-spawn").dir;
  return { cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config: { root, claudeBin: "/unused", dailyCapUsd: 25 }, model: "haiku", effort: "low", tools: ["Read"],
    workerClass: "review", prompt: "draft a proposal", taskId: "FB-DRAFT",
    admitWorkerMemory: async () => { starts.push("memory_admission"); return { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 1 }; },
    logWorkerSpawnWithheld: (row) => withheld.push(row),
    providerRouting: { writeStatus: () => {}, spawnCodex: async () => { starts.push("drafter_worker"); throw new Error("started"); } } };
}

/** A detached run child whose memory reservation is held open until `admit()`, as sweep.ts launches reviews and fixes. */
function runChildStart(t: TestContext, enginePin?: { sleep: (ms: number) => Promise<void> }) {
  const root = ownedFixtureDir(t, "retired-run-child").dir;
  const state = join(root, "state");
  const sha = "b".repeat(40);
  const hash = "a".repeat(64);
  mkdirSync(join(state, "engines", hash), { recursive: true });
  writeFileSync(join(state, "engines", hash, "engine.json"), JSON.stringify({ sha, sourceHash: hash, builtAt: Date.now() }));
  const rows: Row[] = [];
  const spawned: string[] = [];
  const released: string[] = [];
  let admit: () => void = () => {};
  const reserved = new Promise<void>((resolve) => { admit = resolve; });
  const handle = { id: "reservation-1", workerClass: "review", estimateMib: 1, estimateSource: "default", bindRoot: () => {},
    releaseOccupancy: () => { released.push("reservation-1"); } } as unknown as LearnedReservation;
  const launch = () => spawnRunChild({
    taskId: "T-1", stateRoot: state, repoDir: root, root,
    options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement",
      verify: "auto", status: "queued" }] } }) as never,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
  }, { mainSha: async () => sha, engine: { isCurrent: () => true }, ...(enginePin ? { enginePin } : {}), watch: false, pollMs: 60_000,
    reserve: async () => { await reserved; return handle; }, workerAdmissionHold: () => undefined,
    spawn: () => { spawned.push("run_child"); return Object.assign(new EventEmitter(), { pid: 424_242, unref() {} }) as never; } });
  return { rows, spawned, released, state, hash, admit: () => admit(), launch };
}

const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker", async (t) => {
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
  const withheld: Array<Record<string, unknown>> = [];
  let drafted: Awaited<ReturnType<typeof spawnWorker>> | undefined;
  const admissionHold = () => late.retirement.admissionHold(() => resolveFleetControlHold({}));
  // daemonCommand runs runDaemon, and so every pass, in the retirement's spawn scope.
  const inFlightSweep = late.retirement.inSpawnScope(() => late.retirement.refuse("sweep", withCiJudgeAfterSweep(async () => {
    await sweepGate;
    if (admissionHold() === undefined) spawned.push("fix_worker");
    // The inbox draft rung calls spawnWorker with no admission hold of its own (cli/commands/sweep.ts).
    drafted = await spawnWorker(drafterStart(t, withheld, spawned));
  }, retiringCiJudgeKick(late.retirement, () => { spawned.push("ci_judge_worker"); })))());
  const latch: RestartAdmission = Object.assign(() => true, { heldBy: undefined });
  const scope = late.retirement.lightPassScope<LightPassScope>({ reviewOnly: true, admit: latch });
  assert.equal(scope.admit?.("review", "light"), true, "before the release the latched pass admits its review");
  const lateExit = late.exit();
  await turns(5);
  finishSweep();
  await inFlightSweep;
  assert.deepEqual(spawned, [], "a sweep that settles after the release spawns no fix, CI judge or drafter worker");
  assert.equal(drafted?.notStarted, "admission-abandoned", "the drafter start returns not-started");
  assert.deepEqual(withheld, [{ step: "worker.spawn_withheld", task_id: "FB-DRAFT",
    hold: "retired: drain lock released; the successor owns this work" }], "the spawn path ledgers why it withheld the start");
  assert.deepEqual(admissionHold(), { control: "STOP", detail: "retired: drain lock released; the successor owns this work" });
  assert.equal(scope.admit?.("review", "light"), false, "a light pass still running admits no new review worker");
  assert.equal(scope.admit?.heldBy, "retired: drain lock released; the successor owns this work", "its stand-down names why");
  assert.deepEqual(late.rows.filter((row) => row.step === "daemon.retired_start_refused").map((row) => row.hook),
    ["ci_judge_kick", "light_pass_admission"]);
  late.settlePage();
  await lateExit;

  // A review admitted before the release launches a detached run child, and its memory wait outlasts the release.
  const child = runChildStart(t);
  const waiting = retiringExit();
  const launched = waiting.retirement.inSpawnScope(() => child.launch());
  await turns(5);
  const waitingExit = waiting.exit();
  await turns(5);
  child.admit();
  const outcome = await launched;
  assert.equal(outcome.started, false, "a run child whose wait ends after the release does not start");
  assert.equal("abandoned" in outcome && outcome.abandoned, true, "the caller treats it as not started, never in process");
  assert.deepEqual(child.spawned, [], "no child process is spawned");
  assert.deepEqual(child.released, ["reservation-1"], "the admitted reservation is released");
  assert.equal(child.rows.find((row) => row.step === "run_child.spawn_withheld")?.hold,
    "retired: drain lock released; the successor owns this work", "the launch gate ledgers why it withheld the child");
  waiting.settlePage();
  await waitingExit;

  // A review that already passed admission can then wait on the engine pin. Retirement during
  // that second async boundary must still clean its prepared spec/run directory and reservation.
  let markPinWaitStarted: () => void = () => {};
  const pinWaitStarted = new Promise<void>((resolve) => { markPinWaitStarted = resolve; });
  let releasePinWait: () => void = () => {};
  const pinReleased = new Promise<void>((resolve) => { releasePinWait = resolve; });
  const pinState = runChildStart(t, { sleep: async () => { markPinWaitStarted(); await pinReleased; } });
  const pinWaiting = retiringExit();
  mkdirSync(join(pinState.state, "engines"), { recursive: true });
  const pinLock = join(pinState.state, "engines", `${pinState.hash}.pin.lock`);
  writeFileSync(pinLock, JSON.stringify({ pid: process.pid,
    run_id: "advance-test", host: hostname(), startedAt: new Date().toISOString() }));
  const pinLaunch = pinWaiting.retirement.inSpawnScope(() => pinState.launch());
  pinState.admit();
  await pinWaitStarted;
  const pinExit = pinWaiting.exit();
  await turns(5);
  rmSync(pinLock, { force: true });
  releasePinWait();
  const pinOutcome = await pinLaunch;
  assert.equal(pinOutcome.started, false, "retirement during engine pin wait prevents detached launch");
  assert.equal("abandoned" in pinOutcome && pinOutcome.abandoned, true);
  assert.deepEqual(pinState.spawned, [], "the pin waiter starts no detached child");
  assert.deepEqual(pinState.released, ["reservation-1"], "the pin waiter releases its reservation");
  assert.equal(pinState.rows.find((row) => row.step === "run_child.spawn_withheld")?.hold,
    "retired: drain lock released; the successor owns this work");
  pinWaiting.settlePage();
  await pinExit;

  // A worker can cross memory admission after retirement. Re-reading the scope after admission
  // covers every worker caller, including inbox drafts whose provider work follows admission.
  const admissionRace = retiringExit();
  const admissionStarts: string[] = [];
  const admissionWithheld: Array<Record<string, unknown>> = [];
  let finishMemoryAdmission: () => void = () => {};
  const memoryAdmission = new Promise<void>((resolve) => { finishMemoryAdmission = resolve; });
  const admissionWorker = admissionRace.retirement.inSpawnScope(() => spawnWorker({
    ...drafterStart(t, admissionWithheld, admissionStarts),
    admitWorkerMemory: async () => {
      admissionStarts.push("memory_admission");
      await memoryAdmission;
      return { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 1 };
    },
  }));
  await turns(5);
  const admissionExit = admissionRace.exit();
  await turns(5);
  finishMemoryAdmission();
  const admissionResult = await admissionWorker;
  assert.equal(admissionResult.notStarted, "admission-abandoned");
  assert.deepEqual(admissionStarts, ["memory_admission"], "provider routing and spawn are skipped");
  assert.equal(admissionWithheld[0]?.hold,
    "retired: drain lock released; the successor owns this work");
  admissionRace.settlePage();
  await admissionExit;

  // The retirement belongs to that daemon's scope: a start outside it (the next daemon in a pooled process, or a
  // direct spawn) still reaches memory admission.
  const outside: string[] = [];
  const outsideWithheld: Array<Record<string, unknown>> = [];
  const elsewhere = await spawnWorker({ ...drafterStart(t, outsideWithheld, outside),
    admitWorkerMemory: async () => { outside.push("memory_admission"); return { kind: "abandoned", reason: "admission-abandoned", waitedMs: 0, attempts: 1 }; } });
  assert.deepEqual(outside, ["memory_admission"], "a spawn outside the retired scope is not withheld");
  assert.deepEqual(outsideWithheld, []);
  assert.equal(elsewhere.notStarted, "admission-abandoned");
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
