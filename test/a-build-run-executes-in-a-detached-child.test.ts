// test/a-build-run-executes-in-a-detached-child.test.ts — W1-T9085.
//
// Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.1-A.4, A.7). Under `sweep.runChild.mode: on` a dispatched run executes
// in a detached child process: the daemon writes the spec, spawns the child as a process-group leader and settles from the child's
// status file. The five titled tests really spawn that child (a tsx driver around the real `runChildMain` with a fake `runTask`);
// the rest drive the daemon side against a fake child process, one branch at a time.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveLedgerActor, markRunChildProcessActor } from "#src/lib/ledger.js";
import { isFleetAutomationActor } from "#src/lib/operator-interventions.js";
import { TaskAdmissionError } from "#src/lib/plan.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import {
  RUN_CHILD_ABORT_STEP, RUN_CHILD_FALLBACK_STEP, RUN_CHILD_LOST_STEP, RUN_CHILD_SPAWNED_STEP, RUN_CHILD_STDERR_FILE,
  abortRunChild, boundStderrLog, chainAbortSignal, pruneTerminalRunDirs, readFileTail, runChildModeIsOn, spawnRunChild, writePlanSnapshot,
  type RunChildHandle, type RunChildLaunch, type SpawnRunChildPorts,
} from "#src/lib/run-child.js";
import {
  RUN_CHILD_SCHEMA, classifyRunChildError, readSpec, readStatus, runDir, writeSpec, writeStatus,
  type RunChildProbe, type RunChildState, type RunChildStatus,
} from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";
import { killProcessGroup } from "#src/lib/worker-containment.js";
import { runChildMain, type RunChildRunTask } from "#src/run-child-main.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const GEN = { containerId: "c", initStart: "i" };
const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-child-spawn-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(what: string, ready: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

type Row = Record<string, unknown> & { step: string };
const TASKS = [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
const RESULT: RunResult = { taskId: "T-1", runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" };

interface Fixture {
  root: string;
  state: string;
  rows: Row[];
  reservation: { bound: number[]; released: number };
  input: Parameters<typeof spawnRunChild>[0];
  ports: SpawnRunChildPorts;
}

/** A state root holding one engine record, a fake reservation and a log that collects every row. */
function fixture(label: string, overrides: Partial<SpawnRunChildPorts> = {}): Fixture {
  const root = tmp(label);
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const rows: Row[] = [];
  const reservation = { bound: [] as number[], released: 0 };
  const handle: LearnedReservation = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default",
    bindRoot: (pid: number) => { reservation.bound.push(pid); },
    releaseOccupancy: () => { reservation.released += 1; },
  } as unknown as LearnedReservation;
  const input = {
    taskId: "T-1", stateRoot: state, repoDir: root, root, options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: TASKS } }),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
  };
  const ports: SpawnRunChildPorts = {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, reserve: async () => handle, pollMs: 20,
    abort: { pollMs: 20 }, ...overrides,
  };
  return { root, state, rows, reservation, input, ports };
}

// ── a real child: a tsx driver around the real runChildMain, with a fake runTask ───────────────────────────

const SRC = join(REPO_ROOT, "src").replace(/\\/g, "/");
const DRIVER = `
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChildMain } from "file://${SRC}/run-child-main.ts";
import { acquireInflightLock } from "file://${SRC}/lib/inflight-lock.ts";
import { deriveLedgerActor } from "file://${SRC}/lib/ledger.ts";
import { TaskAdmissionError } from "file://${SRC}/lib/plan.ts";

const mode = process.env.DRIVER_MODE;
const dir = process.argv[process.argv.indexOf("--run-dir") + 1];
const root = join(dir, "..", "..", "..");
const runTask = async (taskId, options) => {
  if (mode === "admission") throw new TaskAdmissionError("task " + taskId + " is not admissible");
  const lock = acquireInflightLock(join(root, "state", "inflight"), taskId, { run_id: "r1" });
  copyFileSync(lock.path, join(dir, "lock.json"));
  writeFileSync(join(dir, "actor.txt"), deriveLedgerActor());
  if (mode === "die") {
    process.stderr.write("boom-stderr\\n");
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  if (mode === "abort") {
    const keepAlive = setInterval(() => {}, 1000); // a real run holds sockets and timers; this stand-in must too
    await new Promise((_, reject) => {
      const stop = () => clearInterval(keepAlive) || reject(Object.assign(new Error("worker query aborted"), { name: "AbortError" }));
      if (options.abortSignal.aborted) stop();
      else options.abortSignal.addEventListener("abort", stop);
      writeFileSync(join(dir, "ready"), "1");
    });
  }
  if (mode === "stubborn") {
    setInterval(() => {}, 1000);
    writeFileSync(join(dir, "ready"), "1");
    await new Promise(() => {});
  }
  lock.release();
  return { taskId, runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" };
};
process.exit(await runChildMain(process.argv.slice(2), { loadRunPath: async () => ({}), runTask, env: {} }));
`;

/** Spawns a REAL detached child running the driver in `mode`. */
async function realChild(label: string, mode: string, abort: SpawnRunChildPorts["abort"] = {}): Promise<{ fx: Fixture; launched: RunChildHandle; signals: Array<[string, number]> }> {
  const fx = fixture(label);
  const driver = join(fx.root, "driver.mjs");
  writeFileSync(driver, DRIVER);
  const env: NodeJS.ProcessEnv = { ...process.env, DRIVER_MODE: mode };
  delete env.NODE_TEST_CONTEXT; // a test runner's marker would make every child row's actor `test`
  env.NODE_V8_COVERAGE = undefined; // delete is a no-op under a coverage session; the child must not enrol
  delete env.REMUDERO_WORKER_SCOPE; // and a worker's marker (this suite can run inside one) outranks run_child
  const signals: Array<[string, number]> = [];
  const launched = await spawnRunChild(fx.input, {
    ...fx.ports, env,
    launch: (engine, args) => ({ kind: "tsx", reason: "test driver", argv: ["--import", "tsx", driver, ...args], cwd: REPO_ROOT, engineRoot: engine.root }),
    abort: {
      pollMs: 25,
      kill: (pgid, signal) => { signals.push([signal, Date.now()]); killProcessGroup(pgid, signal); },
      ...abort,
    },
  });
  assert.ok(launched.started, JSON.stringify(launched));
  launched.settled.catch(() => {}); // the test awaits the abort first; the rejection is asserted after
  return { fx, launched, signals };
}

test("W1-T9085: a run under mode on executes in a child that holds the inflight lock", { timeout: 120_000 }, async () => {
  const { fx, launched } = await realChild("lock", "ok");
  const result = await launched.settled;
  assert.equal(result.verdict, "no_pr");
  assert.equal(result.taskId, "T-1", "the child's RunResult reaches the settle loop");
  assert.notEqual(launched.pid, process.pid);
  const lock = JSON.parse(readFileSync(join(launched.dir, "lock.json"), "utf8")) as { pid: number };
  assert.equal(lock.pid, launched.pid, "the inflight lock records the CHILD's pid, not the daemon's");
  assert.notEqual(lock.pid, process.pid);
  const status = readStatus(launched.dir);
  assert.ok(status.ok && status.value.state === "done", JSON.stringify(status));
  assert.equal(status.value.identity.pid, launched.pid);
  assert.equal(readFileSync(join(launched.dir, "actor.txt"), "utf8"), "run_child", "its ledger rows carry the actor run_child");
  assert.deepEqual(fx.reservation.bound, [launched.pid], "the reservation is bound to the child's pid");
  assert.equal(fx.reservation.released, 1, "and released once the run settles");
  assert.ok(fx.rows.some((row) => row.step === RUN_CHILD_SPAWNED_STEP && row.child_pid === launched.pid));
  const spec = JSON.parse(readFileSync(join(launched.dir, "spec.json"), "utf8")) as { reservationId: string; options: { pairedTrialHost: string } };
  assert.equal(spec.reservationId, "reservation-1");
  assert.equal(spec.options.pairedTrialHost, "daemon");
});

test("W1-T9085: a child task-admission failure classifies as the in-process one", { timeout: 120_000 }, async () => {
  const { launched } = await realChild("admission", "admission");
  const inProcess = new TaskAdmissionError("task T-1 is not admissible");
  await assert.rejects(launched.settled, (error: unknown) => {
    assert.ok(error instanceof TaskAdmissionError, "the settle loop's own instanceof test holds");
    assert.equal((error as Error).message, inProcess.message);
    assert.equal(classifyRunChildError(error), classifyRunChildError(inProcess));
    assert.equal(classifyRunChildError(error), "task_admission");
    return true;
  });
  const status = readStatus(launched.dir);
  assert.ok(status.ok && status.value.state === "failed" && status.value.failure?.class === "task_admission", JSON.stringify(status));
});

test("W1-T9085: a child that dies mid-run settles as lost", { timeout: 120_000 }, async () => {
  const { fx, launched } = await realChild("lost", "die");
  await assert.rejects(launched.settled, /run child .* lost/);
  const lost = fx.rows.find((row) => row.step === RUN_CHILD_LOST_STEP);
  assert.ok(lost, JSON.stringify(fx.rows.map((row) => row.step)));
  assert.match(String(lost.stderr_tail), /boom-stderr/, "the lost row carries the stderr tail");
  const status = readStatus(launched.dir);
  assert.ok(status.ok && status.value.state === "running", "the child never wrote a terminal status");
  assert.equal(fx.reservation.released, 1);
});

test("W1-T9085: an abort ends at a safe point and kills only past the learned teardown", { timeout: 180_000 }, async () => {
  // (a) a child that honours the abort: SIGTERM only, `aborted`, no SIGKILL however long the teardown allowance is.
  const polite = await realChild("abort-safe", "abort", { teardownMs: () => 60_000 });
  await until("the run to start", () => existsSync(join(polite.launched.dir, "ready")));
  const ended = await polite.launched.abort();
  assert.deepEqual(ended, { signalled: true, ended: "terminal", killed: false });
  assert.deepEqual(polite.signals.map(([signal]) => signal), ["SIGTERM"]);
  await assert.rejects(polite.launched.settled, (error: unknown) => (error as Error).name === "AbortError");
  const aborted = readStatus(polite.launched.dir);
  assert.ok(aborted.ok && aborted.value.state === "aborted" && aborted.value.failure?.class === "aborted", JSON.stringify(aborted));

  // (b) a child that ignores it: SIGKILL follows, and only after the learned teardown time has passed.
  const stubborn = await realChild("abort-kill", "stubborn", { teardownMs: () => 400 });
  await until("the run to start", () => existsSync(join(stubborn.launched.dir, "ready")));
  const killed = await stubborn.launched.abort();
  assert.deepEqual(killed, { signalled: true, ended: "lost", killed: true });
  assert.deepEqual(stubborn.signals.map(([signal]) => signal), ["SIGTERM", "SIGKILL"]);
  assert.ok(stubborn.signals[1]![1] - stubborn.signals[0]![1] >= 400, "SIGKILL waited out the teardown time");
  await assert.rejects(stubborn.launched.settled, /lost/);

  // (c) with no history there is no number to wait for: it never kills, and waits for the status or the loss.
  const silent = await realChild("abort-wait", "stubborn", { teardownMs: () => undefined });
  await until("the run to start", () => existsSync(join(silent.launched.dir, "ready")));
  let finished = false;
  const waiting = silent.launched.abort().then((outcome) => { finished = true; return outcome; });
  await sleep(1_500);
  assert.equal(finished, false, "no fixed timeout ends the wait");
  assert.deepEqual(silent.signals.map(([signal]) => signal), ["SIGTERM"], "and nothing was killed");
  killProcessGroup(silent.launched.pid);
  assert.deepEqual(await waiting, { signalled: true, ended: "lost", killed: false });
  await assert.rejects(silent.launched.settled, /lost/);
});

/** A spec and plan snapshot for an in-process `runChildMain`. */
function runDirFor(label: string, options: Record<string, unknown> = { skipGitSync: true }): { dir: string; state: string } {
  const root = tmp(label);
  const state = join(root, "state");
  const dir = runDir(state, `run-${label}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = writePlanSnapshot(state, TASKS);
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: "T-1", runId: `run-${label}`, instance: "i", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: snapshot.path, reservationId: "reservation-1", options,
  });
  return { dir, state };
}
const noSignals = { on() {}, off() {} };
const probe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => GEN };

test("W1-T9085: the child awaits its paired trials before its terminal status", async () => {
  const { dir } = runDirFor("trials");
  let release: () => void = () => {};
  const trial = new Promise<void>((resolve) => { release = resolve; });
  let returned = false;
  const runTask: RunChildRunTask = async (_taskId, options) => {
    (options.onBackgroundWork as (work: Promise<unknown>) => void)(trial);
    returned = true;
    return RESULT;
  };
  let settled = false;
  const main = runChildMain(["--run-dir", dir], { runTask, loadRunPath: async () => ({}), signals: noSignals, probe, env: {}, stderr: () => {} })
    .then((code) => { settled = true; return code; });
  await until("runTask to return", () => returned);
  await sleep(150);
  assert.equal(settled, false, "runTask's return does not end the child");
  const during = readStatus(dir);
  assert.ok(during.ok && during.value.state === "running", `the status stays non-terminal while the trial runs: ${JSON.stringify(during)}`);
  release();
  assert.equal(await main, 0);
  const after = readStatus(dir);
  assert.ok(after.ok && after.value.state === "done" && after.value.result?.verdict === "no_pr", JSON.stringify(after));
});

// ── the run verb, in-process ─────────────────────────────────────────────────────────────────────────────

test("the run verb hands runTask the spec's options and the plan snapshot as its plan, and marks the actor", async () => {
  const originals = { kind: process.env.REMUDERO_PROCESS_ACTOR, daemon: process.env.REMUDERO_DAEMON_PROCESS };
  const putBack = (name: string, value: string | undefined): void => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  after(() => { putBack("REMUDERO_PROCESS_ACTOR", originals.kind); putBack("REMUDERO_DAEMON_PROCESS", originals.daemon); });
  process.env.REMUDERO_PROCESS_ACTOR = "daemon";
  process.env.REMUDERO_DAEMON_PROCESS = "1";
  const before = { kind: process.env.REMUDERO_PROCESS_ACTOR, daemon: process.env.REMUDERO_DAEMON_PROCESS };
  const { dir } = runDirFor("options", { owner: "o", allowStale: true, skipGitSync: true, planPath: "/p/tasks.yaml", handOffAtPrOpen: true, pairedTrialHost: "daemon" });
  let seen: Record<string, unknown> = {};
  let actor = "";
  const code = await runChildMain(["--run-dir", dir], {
    signals: noSignals, probe, env: {}, stderr: () => {}, loadRunPath: async () => ({}),
    runTask: async (_id, options) => {
      seen = options;
      actor = deriveLedgerActor({ ...process.env, NODE_TEST_CONTEXT: undefined, REMUDERO_WORKER_SCOPE: undefined }, false);
      return RESULT;
    },
  });
  assert.equal(code, 0);
  assert.equal(actor, "run_child", "while the run executes its ledger rows carry the actor run_child");
  assert.equal(process.env.REMUDERO_PROCESS_ACTOR, before.kind, "the daemon's own marker is put back");
  assert.equal(process.env.REMUDERO_DAEMON_PROCESS, before.daemon);
  assert.equal(seen.owner, "o");
  assert.equal(seen.planSnapshot, undefined, "an explicit --plan (skipGitSync) is read literally, so no snapshot stands in for it");
  assert.ok(seen.abortSignal instanceof AbortSignal);
  assert.equal(seen.pairedTrialHost, "daemon");

  const synced = runDirFor("snapshot", { allowStale: false });
  let plan: { plan: { tasks: unknown[]; byId: Map<string, unknown> }; staleDispatch: boolean } | undefined;
  await runChildMain(["--run-dir", synced.dir], {
    signals: noSignals, probe, env: {}, stderr: () => {}, loadRunPath: async () => ({}),
    runTask: async (_id, options) => {
      plan = (options.planSnapshot as (o: object) => typeof plan)({});
      return RESULT;
    },
  });
  assert.equal(plan?.plan.tasks.length, 1);
  assert.ok(plan?.plan.byId.has("T-1"));
  assert.equal(plan?.staleDispatch, false);
});

test("the run verb writes failed for a thrown error, a missing runTask and an unreadable plan snapshot", async () => {
  const thrown = runDirFor("thrown");
  const errors: string[] = [];
  const common = { signals: noSignals, probe, env: {}, stderr: (text: string) => { errors.push(text); }, loadRunPath: async () => ({}) };
  assert.equal(await runChildMain(["--run-dir", thrown.dir], { ...common, runTask: async () => { throw new TaskAdmissionError("nope"); } }), 1);
  const failed = readStatus(thrown.dir);
  assert.ok(failed.ok && failed.value.state === "failed" && failed.value.failure?.class === "task_admission", JSON.stringify(failed));
  assert.match(errors.join(""), /run failed/);

  const missing = runDirFor("missing");
  assert.equal(await runChildMain(["--run-dir", missing.dir], common), 1);
  const noRun = readStatus(missing.dir);
  assert.ok(noRun.ok && noRun.value.state === "failed" && /exports no runTask/.test(noRun.value.failure?.message ?? ""), JSON.stringify(noRun));

  const unreadable = runDirFor("unreadable", {});
  rmSync(join(unreadable.state, "plan-snapshots"), { recursive: true, force: true });
  assert.equal(await runChildMain(["--run-dir", unreadable.dir], { ...common, runTask: async () => RESULT }), 1);
  const noPlan = readStatus(unreadable.dir);
  assert.ok(noPlan.ok && noPlan.value.failure?.reasonClass === "plan_snapshot_unreadable", JSON.stringify(noPlan));
});

test("a SIGTERM aborts the run through its signal; a run that returns anyway is done, one that throws is aborted", async () => {
  const listeners: Array<() => void> = [];
  const signals = { on: (_s: "SIGTERM", h: () => void) => { listeners.push(h); }, off: (_s: "SIGTERM", h: () => void) => { listeners.splice(listeners.indexOf(h), 1); } };
  const common = { signals, probe, env: {}, stderr: () => {}, loadRunPath: async () => ({}), heartbeatMs: 10 };

  const throwing = runDirFor("sigterm-throw");
  const aborted = runChildMain(["--run-dir", throwing.dir], {
    ...common,
    runTask: (_id, options) => new Promise((_resolve, reject) => {
      (options.abortSignal as AbortSignal).addEventListener("abort", () => reject(new Error("stopped")));
      listeners.forEach((listener) => listener());
    }),
  });
  assert.equal(await aborted, 3);
  const status = readStatus(throwing.dir);
  assert.ok(status.ok && status.value.state === "aborted" && status.value.failure?.class === "aborted" && status.value.failure.message === "stopped", JSON.stringify(status));
  assert.equal(listeners.length, 0, "the handler is removed");

  const returning = runDirFor("sigterm-return");
  const finished = runChildMain(["--run-dir", returning.dir], {
    ...common,
    runTask: async () => { listeners.forEach((listener) => listener()); await sleep(40); return RESULT; },
  });
  assert.equal(await finished, 0);
  const done = readStatus(returning.dir);
  assert.ok(done.ok && done.value.state === "done", "the work finished, so it is not reported as aborted");

  const early = runDirFor("sigterm-early");
  let beats = 0;
  const before = runChildMain(["--run-dir", early.dir], {
    ...common,
    loadRunPath: async () => { listeners.forEach((listener) => listener()); },
    runTask: async () => { beats += 1; return RESULT; },
  });
  assert.equal(await before, 3);
  assert.equal(beats, 0, "an abort heard before the run starts never starts it");
  const earlyStatus = readStatus(early.dir);
  assert.ok(earlyStatus.ok && earlyStatus.value.state === "aborted");
});

test("the actor run_child outranks the daemon markers a child inherits, and a worker outranks it", () => {
  const inherited: NodeJS.ProcessEnv = { REMUDERO_PROCESS_ACTOR: "daemon", REMUDERO_DAEMON_PROCESS: "1" };
  assert.equal(deriveLedgerActor({ ...inherited }, false), "daemon");
  const marked = { ...inherited };
  const restore = markRunChildProcessActor(marked);
  assert.equal(deriveLedgerActor({ ...marked }, false), "run_child", "the daemon marker a child inherits is replaced");
  assert.equal(deriveLedgerActor({ ...marked, REMUDERO_WORKER_SCOPE: "rmd-v1-x" }, false), "worker");
  assert.equal(deriveLedgerActor({ ...marked, NODE_TEST_CONTEXT: "child-v8" }, false), "test");
  restore();
  assert.deepEqual(marked, inherited, "and put back");
  const bare: NodeJS.ProcessEnv = {};
  markRunChildProcessActor(bare)();
  assert.deepEqual(bare, {});
  assert.equal(isFleetAutomationActor("run_child"), true, "a run child's rows are fleet automation, never an operator's hand");
});

// ── the daemon side, against a fake child process ────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  pid: number | undefined = 424_242;
  unrefs = 0;
  unref(): void { this.unrefs += 1; }
}

function status(runId: string, state: RunChildState, extra: Partial<RunChildStatus> = {}, generation = GEN): RunChildStatus {
  return {
    schema: RUN_CHILD_SCHEMA, runId, identity: { pid: 424_242, startTicks: "proc:1", containerGeneration: generation },
    engineSha: SHA, entryKind: "tsx", phase: "run", heartbeatAt: Date.now(), state, ...extra,
  };
}

/** Starts a run child on a fake process and returns the handle with the fake. */
async function fakeStart(label: string, overrides: Partial<SpawnRunChildPorts> = {}): Promise<{ fx: Fixture; child: FakeChild; launched: RunChildHandle }> {
  const child = new FakeChild();
  const fx = fixture(label, { spawn: () => child as never, probe, ...overrides });
  const launched = await spawnRunChild(fx.input, fx.ports);
  assert.ok(launched.started, JSON.stringify(launched));
  launched.settled.catch(() => {}); // the rejection is asserted by the test, which may attach after the file is written
  return { fx, child, launched };
}

test("a done status without a result, and a failed status without a failure, both settle as lost", async () => {
  for (const [state, pattern] of [["done", /without a result/], ["failed", /unclassified failure/]] as const) {
    const { launched, child } = await fakeStart(`bad-${state}`);
    assert.equal(child.unrefs, 1, "the child is unref'd so it never holds the daemon open");
    writeStatus(launched.dir, status(launched.runId, state));
    await assert.rejects(launched.settled, pattern);
  }
});

test("an aborted status without a failure rejects as an abort; a done status resolves its result", async () => {
  const a = await fakeStart("aborted-bare");
  writeStatus(a.launched.dir, status(a.launched.runId, "aborted"));
  await assert.rejects(a.launched.settled, (error: unknown) => (error as Error).name === "AbortError");
  const b = await fakeStart("done-ok", { watch: false });
  writeStatus(b.launched.dir, status(b.launched.runId, "done", { result: RESULT }));
  assert.deepEqual(await b.launched.settled, RESULT);
});

test("an exit with no readable status, and a status from another container generation, both settle as lost", async () => {
  const exited = await fakeStart("exit-unreadable");
  writeFileSync(join(exited.launched.dir, RUN_CHILD_STDERR_FILE), "x".repeat(10) + "tail-line\n");
  exited.child.emit("exit", 1, null);
  await assert.rejects(exited.launched.settled, /exited \(1\) in state unreadable/);
  assert.match(String(exited.fx.rows.find((row) => row.step === RUN_CHILD_LOST_STEP)?.stderr_tail), /tail-line/);

  const dead = await fakeStart("dead-generation", { watch: false });
  writeStatus(dead.launched.dir, status(dead.launched.runId, "running", {}, { containerId: "other", initStart: "x" }));
  await assert.rejects(dead.launched.settled, /another container|names container/);

  const gone = await fakeStart("pid-gone", { probe: { process: () => ({ state: "gone" }), generation: () => GEN } });
  writeStatus(gone.launched.dir, status(gone.launched.runId, "running"));
  await assert.rejects(gone.launched.settled, /is gone/);

  const spawnError = await fakeStart("spawn-error");
  spawnError.child.emit("error", new Error("EACCES"));
  await assert.rejects(spawnError.launched.settled, /spawn error: EACCES/);
});

test("a child that cannot be started falls the run back to in-process, with the reason ledgered", async () => {
  const none = fixture("no-engine");
  rmSync(join(none.state, "engines"), { recursive: true });
  const noEngine = await spawnRunChild(none.input, none.ports);
  assert.deepEqual(noEngine, { started: false, reason: "no engine tree has been built yet" });
  assert.ok(none.rows.some((row) => row.step === RUN_CHILD_FALLBACK_STEP && row.reason === "no engine tree has been built yet"));

  const stale = fixture("stale-engine", { engine: { isCurrent: () => false } });
  assert.deepEqual(await spawnRunChild(stale.input, stale.ports), { started: false, reason: "no current engine tree for main" });

  const noPlan = fixture("plan-throws");
  const planFailed = await spawnRunChild({ ...noPlan.input, plan: async () => { throw new Error("fetch failed"); } }, noPlan.ports);
  assert.ok(!planFailed.started && /fetch failed/.test(planFailed.reason), JSON.stringify(planFailed));
  assert.equal(noPlan.reservation.released, 0, "nothing was reserved before the plan was read");

  const child = new FakeChild();
  child.pid = undefined;
  const noPid = fixture("no-pid", { spawn: () => child as never });
  const refused: RunChildLaunch = await spawnRunChild(noPid.input, noPid.ports);
  assert.ok(!refused.started && /no pid/.test(refused.reason), JSON.stringify(refused));
  assert.equal(noPid.reservation.released, 1, "the reservation is released when the spawn fails");

  const throwingLog = fixture("log-throws", { reserve: async () => { throw new Error("memory admission refused"); } });
  const logged = await spawnRunChild({ ...throwingLog.input, log: () => { throw new Error("ledger down"); } }, throwingLog.ports);
  assert.ok(!logged.started && /memory admission refused/.test(logged.reason), "a failing ledger changes nothing about the answer");
});

/** A reservation whose release always throws: the cleanup arms must swallow it and still report. */
const throwingRelease = (): LearnedReservation => ({
  id: "reservation-2", workerClass: "implement", estimateMib: 1, estimateSource: "default",
  bindRoot: () => {},
  releaseOccupancy: () => { throw new Error("ledger is read-only"); },
} as unknown as LearnedReservation);

test("W1-T9085: the default reservation opens a real learned reservation, named in the spec, and releases it at settle", async () => {
  const child = new FakeChild();
  child.pid = process.pid; // a live pid, so the real reservation can bind its root
  const { launched } = await fakeStart("default-reserve", { reserve: undefined, spawn: () => child as never });
  const spec = readSpec(launched.dir);
  assert.ok(spec.ok && spec.value.reservationId.length > 0, "the spec names the reservation the real default opened");
  writeStatus(launched.dir, status(launched.runId, "done", { result: RESULT }));
  assert.deepEqual(await launched.settled, RESULT);
});

test("W1-T9085: a failing reservation release never hides why the child could not start", async () => {
  const child = new FakeChild();
  child.pid = undefined;
  const fx = fixture("release-throws-at-start", { spawn: () => child as never, reserve: async () => throwingRelease() });
  const refused = await spawnRunChild(fx.input, fx.ports);
  assert.ok(!refused.started && /no pid/.test(refused.reason), JSON.stringify(refused));
  assert.ok(fx.rows.some((row) => row.step === RUN_CHILD_FALLBACK_STEP && /no pid/.test(String(row.reason))));
});

test("W1-T9085: a failing settle cleanup is ledgered and the run still settles", async () => {
  const { fx, launched } = await fakeStart("cleanup-throws", { reserve: async () => throwingRelease() });
  writeStatus(launched.dir, status(launched.runId, "done", { result: RESULT }));
  assert.deepEqual(await launched.settled, RESULT);
  const row = fx.rows.find((r) => r.step === RUN_CHILD_FALLBACK_STEP);
  assert.ok(row && /settle cleanup failed: ledger is read-only/.test(String(row.reason)), JSON.stringify(fx.rows));
});

test("W1-T9085: a run directory that cannot be watched is read by the poll alone", async () => {
  const child = new FakeChild();
  const { launched } = await fakeStart("watch-unavailable", {
    launch: (engine, args) => ({ kind: "tsx", reason: "test", argv: [...args], cwd: REPO_ROOT, engineRoot: engine.root }),
    spawn: (_command, args) => {
      rmSync(String(args[args.indexOf("--run-dir") + 1]), { recursive: true, force: true }); // fs.watch on a missing directory throws
      return child as never;
    },
  });
  child.emit("exit", 1, null);
  await assert.rejects(launched.settled, /exited \(1\) in state unreadable/);
});

test("an abort signal from the caller aborts the child, and a failing abort is ledgered", async () => {
  const controller = new AbortController();
  const sent: string[] = [];
  const second = new FakeChild();
  const fx = fixture("signal-abort-2", {
    spawn: () => second as never, probe,
    abort: { pollMs: 10, kill: (_pgid, signal) => { sent.push(signal); writeStatus(runDirOf(fx), status(runIdOf(fx), "aborted", { failure: { class: "aborted", reasonClass: "aborted", message: "stopped" } })); } },
  });
  fx.input.signal = controller.signal;
  const launched = await spawnRunChild(fx.input, fx.ports);
  assert.ok(launched.started);
  controller.abort();
  await assert.rejects(launched.settled, (error: unknown) => (error as Error).name === "AbortError");
  assert.deepEqual(sent, ["SIGTERM"]);
  assert.ok(fx.rows.some((row) => row.step === RUN_CHILD_ABORT_STEP && row.signal === "SIGTERM"));

  const broken = new FakeChild();
  const failing = fixture("signal-abort-3", { spawn: () => broken as never, probe, abort: { pollMs: 10, kill: () => { throw new Error("EPERM"); } } });
  failing.input.signal = AbortSignal.abort();
  const handle = await spawnRunChild(failing.input, failing.ports);
  assert.ok(handle.started);
  await until("the failed abort to be ledgered", () => failing.rows.some((row) => row.step === RUN_CHILD_ABORT_STEP && row.error === "EPERM"));
  broken.emit("exit", null, "SIGKILL");
  await assert.rejects(handle.settled, /lost/);
});
const runDirOf = (fx: Fixture): string => runDir(fx.state, runIdOf(fx));
const runIdOf = (fx: Fixture): string => String(fx.rows.find((row) => row.step === RUN_CHILD_SPAWNED_STEP)?.run_id);

test("abortRunChild signals only a child whose identity is proven live", async () => {
  const fx = fixture("abort-identity");
  const dir = runDir(fx.state, "run-abort-identity");
  mkdirSync(dir, { recursive: true });
  const sent: Array<[number, string]> = [];
  const kill = (pgid: number, signal: NodeJS.Signals): void => { sent.push([pgid, signal]); writeStatus(dir, status("run-abort-identity", "aborted")); };

  const unreadable = await abortRunChild(dir, { probe, kill });
  assert.ok(!unreadable.signalled && /unreadable/.test(unreadable.reason), JSON.stringify(unreadable));
  writeStatus(dir, status("run-abort-identity", "running", {}, { containerId: "other", initStart: "x" }));
  const dead = await abortRunChild(dir, { probe, kill });
  assert.ok(!dead.signalled && /dead/.test(dead.reason), JSON.stringify(dead));
  assert.deepEqual(sent, [], "a reused pid or another container's child is never signalled");

  writeStatus(dir, status("run-abort-identity", "running"));
  const live = await abortRunChild(dir, { probe, kill, wait: async () => {}, log: (step, extra) => fx.rows.push({ step, ...extra }) });
  assert.deepEqual(live, { signalled: true, ended: "terminal", killed: false });
  assert.deepEqual(sent, [[424_242, "SIGTERM"]]);
});

test("the stderr log is read from its tail and bounded", () => {
  const dir = tmp("stderr");
  const path = join(dir, RUN_CHILD_STDERR_FILE);
  assert.equal(readFileTail(path), "");
  assert.equal(boundStderrLog(path, 10), false);
  writeFileSync(path, "0123456789abcdef");
  assert.equal(readFileTail(path, 6), "abcdef");
  assert.equal(boundStderrLog(path, 100), false);
  assert.equal(boundStderrLog(path, 10), true);
  assert.equal(readFileTail(path), "");
});

test("the mode helper reads on, off and an unreadable policy; the abort signals chain", () => {
  assert.deepEqual(runChildModeIsOn(() => "on"), { on: true });
  assert.deepEqual(runChildModeIsOn(() => "shadow"), { on: false });
  assert.deepEqual(runChildModeIsOn(() => { throw new Error("policy broken"); }), { on: false, unreadable: "policy broken" });
  const own = { signal: undefined as AbortSignal | undefined };
  assert.equal(chainAbortSignal(own, undefined), own);
  const a = new AbortController();
  const b = new AbortController();
  assert.equal(chainAbortSignal(own, a.signal).signal, a.signal);
  const both = chainAbortSignal({ signal: b.signal }, a.signal).signal!;
  assert.equal(both.aborted, false);
  a.abort();
  assert.equal(both.aborted, true, "either signal ends the worker's query");
});

test("terminal run directories are pruned beyond the newest, and a live one never", () => {
  const root = tmp("prune");
  const state = join(root, "state");
  const make = (name: string, state_: RunChildState, age: number): string => {
    const dir = runDir(state, name);
    mkdirSync(dir, { recursive: true });
    writeStatus(dir, status(name, state_));
    utimesSync(dir, Date.now() / 1000 - age, Date.now() / 1000 - age);
    return dir;
  };
  const newest = make("run-a", "done", 1);
  const older = make("run-b", "failed", 100);
  const running = make("run-c", "running", 1_000);
  const probeDir = make("probe-a", "done", 2_000);
  const removed = pruneTerminalRunDirs(state, "run-", 1);
  assert.deepEqual(removed, [older]);
  assert.ok(existsSync(newest) && existsSync(running) && existsSync(probeDir));
});

// ── the daemon's wiring: when `runOne` starts a child and when it stays in-process ───────────────────────────

test("the daemon's runOne starts a child only under mode on, and falls back with a reason otherwise", async () => {
  const { runInChildWhenOn } = await import("#src/run-task.js");
  const root = tmp("wiring");
  mkdirSync(join(root, "state"));
  const config = { claudeBin: "/bin/true", root, installRoot: process.cwd() } as never;
  const rows: Row[] = [];
  const base = {
    taskId: "T-1", config, repoDir: root, allowStale: true, options: { handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    planSync: async () => ({ plan: { tasks: TASKS, byId: new Map() }, staleDispatch: false }) as never,
  };
  const seen: Array<{ input: Parameters<typeof spawnRunChild>[0]; ports: SpawnRunChildPorts | undefined }> = [];
  const started = (settled: Promise<RunResult>): typeof spawnRunChild => async (input, ports) => {
    seen.push({ input, ports });
    return { started: true, runId: "r", dir: "d", pid: 1, settled, abort: async () => ({ signalled: false, reason: "n/a" }) };
  };

  assert.equal(await runInChildWhenOn(base, { readMode: () => "shadow", spawn: started(Promise.resolve(RESULT)) }), undefined);
  assert.equal(seen.length, 0, "mode shadow never starts a child");
  assert.equal(rows.length, 0);

  assert.equal(await runInChildWhenOn(base, { readMode: () => { throw new Error("policy broken"); } }), undefined);
  assert.match(String(rows.at(-1)?.reason), /unreadable: policy broken/);

  assert.equal(await runInChildWhenOn({ ...base, options: { skipGitSync: true } }, { readMode: () => "on", spawn: started(Promise.resolve(RESULT)) }), undefined);
  assert.match(String(rows.at(-1)?.reason), /explicit --plan/);
  assert.equal(seen.length, 0);

  const launched = await runInChildWhenOn(base, { readMode: () => "on", spawn: started(Promise.resolve(RESULT)) });
  assert.deepEqual(await launched?.settled, RESULT, "the child's result is the run's result");
  assert.equal(seen[0]!.input.stateRoot, join(root, "state"));
  assert.equal(seen[0]!.input.root, root);
  const admitted = await seen[0]!.input.plan();
  assert.equal(admitted.plan.tasks.length, 1);
  assert.equal(seen[0]!.ports?.abort?.teardownMs?.(), undefined, "with no yield history there is no learned teardown time");

  const failed: typeof spawnRunChild = async () => ({ started: false, reason: "no engine tree has been built yet" });
  assert.equal(await runInChildWhenOn(base, { readMode: () => "on", spawn: failed }), undefined);

  // The default spawn is the real one: with no engine tree it answers `started: false` and ledgers why.
  assert.equal(await runInChildWhenOn(base, { readMode: () => "on" }), undefined);
  assert.ok(rows.some((row) => row.step === RUN_CHILD_FALLBACK_STEP && row.reason === "no engine tree has been built yet"));
});
