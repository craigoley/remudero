// W1-T13968 — A RUN CHILD THE DAEMON STARTS RUNS BELOW THE DAEMON'S CPU PRIORITY, AS GARDEN CHILDREN ALREADY DO. MEASURED in the
// daemon container on 2026-11-20 (ps -eo ni,pcpu): the daemon, every run child, their codex workers and their git children all ran
// at NI 0; only test children (test-slot.ts lowPriorityCommand) and garden children (childGardenPassSpawn) yielded. The daemon's
// loop is one thread, so it waited for CPU behind the builds, fixes and reviews it had started. These tests drive the real
// spawnRunChild through its spawn seam: a fake child pid with injected priority seams, and a real short child read back with
// os.getPriority.

import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { after, test } from "node:test";
import { childHeapPolicyArgs } from "#src/lib/daemon-memory-policy.js";
import { childGardenPassSpawn, GARDEN_CHILD_NICENESS } from "#src/lib/garden-registry.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { INSTALLATION_SHARE_DIVISOR_ENV, runChildInstallationEnv } from "#src/lib/installation-budget-start.js";
import * as runChild from "#src/lib/run-child.js";
import { RUN_CHILD_STDERR_FILE } from "#src/lib/run-child.js";
import { runDir } from "#src/lib/run-child-contract.js";
import { lowPriorityCommand, TEST_RUN_NICENESS } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** The literal the ledger carries; the exported constant must name it. */
const DEGRADED = "run_child.priority_degraded";
const FAKE_PID = 424_242;

const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13968-${label}-`));
  scratch.push(dir);
  return dir;
};
const live: ChildProcess[] = [];
after(() => {
  for (const child of live) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  pid: number | undefined = FAKE_PID;
  unref(): void {}
}

const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const TASKS = [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
const LAUNCH_ARGV = ["/engine/dist/child-entries/run-child.mjs"];

type SpawnCall = { command: string; args: readonly string[]; options: { cwd: string; env: NodeJS.ProcessEnv; stderrFd: number; offerPipe?: true } };

/** One engine tree, a held reservation, and a spawn seam that records its call and returns `makeChild()`. */
function spawnFixture(label: string, makeChild: () => ChildProcess = () => new FakeChild() as unknown as ChildProcess) {
  const root = tmp(label);
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const bound: number[] = [];
  const handle = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default",
    bindRoot: (pid: number) => { bound.push(pid); }, releaseOccupancy: () => {},
  } as unknown as LearnedReservation;
  const calls: SpawnCall[] = [];
  const env = { PATH: process.env.PATH ?? "", T13968_MARK: "kept" };
  const input = {
    taskId: "T-1", stateRoot: state, repoDir: root, root, options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: TASKS } }),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
  };
  const base = {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, watch: false, pollMs: 60_000, reserve: async () => handle, env,
    workerAdmissionHold: () => undefined,
    launch: () => ({ argv: [...LAUNCH_ARGV], cwd: engine, engineRoot: engine, kind: "bundle", reason: "test" }) as never,
    spawn: (command: string, args: readonly string[], options: SpawnCall["options"]) => { calls.push({ command, args, options }); return makeChild(); },
  };
  return { root, state, rows, bound, calls, env, input, base };
}

/** Records every priority call; `refuse` makes the named kinds fail as a host that forbids them would. */
function prioritySeams(refuse: { nice?: Error; ionice?: Error; ioniceHangs?: boolean } = {}) {
  const niced: Array<[number, number]> = [];
  const ioniced: Array<[string, readonly string[]]> = [];
  return {
    niced, ioniced,
    ports: {
      setPriority: (pid: number, niceness: number) => {
        niced.push([pid, niceness]);
        if (refuse.nice) throw refuse.nice;
      },
      ionice: "/usr/bin/ionice",
      runIonice: (file: string, args: readonly string[]) => {
        ioniced.push([file, args]);
        if (refuse.ioniceHangs) return new Promise<never>(() => {});
        return refuse.ionice ? Promise.reject(refuse.ionice) : Promise.resolve();
      },
      noted: new Set<string>(),
    },
  };
}

async function launched(fx: ReturnType<typeof spawnFixture>, ports: Record<string, unknown>) {
  const launch = await runChild.spawnRunChild(fx.input, { ...fx.base, ...ports } as never);
  assert.ok(launch.started, JSON.stringify(launch));
  launch.settled.catch(() => {});
  launch.detach?.();
  return launch;
}

async function settleIonice(): Promise<void> {
  for (let i = 0; i < 20; i++) await flush();
}

test("W1-T13968 criterion 1: spawnRunChild sets the garden child's niceness on the run child's pid and the test child's IO class", async () => {
  const fx = spawnFixture("nice");
  const seams = prioritySeams();
  const launch = await launched(fx, { priority: seams.ports });
  assert.equal(launch.pid, FAKE_PID);
  assert.deepEqual(seams.niced, [[FAKE_PID, GARDEN_CHILD_NICENESS]], "the run child's own pid gets the garden child's niceness, once");
  assert.ok(GARDEN_CHILD_NICENESS > 0, "a positive niceness lowers the CPU priority");
  await settleIonice();
  assert.deepEqual(seams.ioniced, [["/usr/bin/ionice", ["-c", "2", "-n", "7", "-p", String(FAKE_PID)]]],
    "best-effort lowest, the class a test child runs in (never the idle class a garden takes)");
  assert.deepEqual(fx.rows.filter((r) => r.step === DEGRADED), [], "a host that allows both logs nothing");
});

test("W1-T13968 criterion 1: the ionice binary is the first of the paths test children look up, and none is run where none exists", async () => {
  const runs: string[] = [];
  const runIonice = async (file: string) => { runs.push(file); };
  const noop = () => {};
  await runChild.lowerRunChildPriority(FAKE_PID, noop, { setPriority: noop, exists: (path) => path === "/bin/ionice", runIonice, noted: new Set() });
  assert.deepEqual(runs, ["/bin/ionice"]);
  await runChild.lowerRunChildPriority(FAKE_PID, noop, { setPriority: noop, exists: () => true, runIonice, noted: new Set() });
  assert.deepEqual(runs, ["/bin/ionice", "/usr/bin/ionice"], "/usr/bin/ionice first, as test-slot.ts lowPriorityCommand looks");
  const rows: string[] = [];
  await runChild.lowerRunChildPriority(FAKE_PID, (step) => { rows.push(step); }, { setPriority: noop, exists: () => false, runIonice, noted: new Set() });
  assert.deepEqual(runs, ["/bin/ionice", "/usr/bin/ionice"], "no binary, no IO class change");
  assert.deepEqual(rows, [], "a host without ionice is not a refusal");
});

test("W1-T13968 criterion 1: a real run child reads back the garden child's niceness, and the real ionice seam is called with its pid", async (t) => {
  const own = getPriority();
  if (own >= GARDEN_CHILD_NICENESS) {
    t.skip(`this test process already runs at niceness ${own}, at or below the run child's ${GARDEN_CHILD_NICENESS}`);
    return;
  }
  const dir = tmp("real");
  const ioniceArgs = join(dir, "ionice-args");
  const ionice = join(dir, "fake-ionice");
  writeFileSync(ionice, `#!/bin/sh\necho "$@" > '${ioniceArgs}'\n`);
  chmodSync(ionice, 0o755);
  const fx = spawnFixture("real", () => {
    const child = nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: "ignore" });
    live.push(child);
    return child;
  });
  const launch = await launched(fx, { priority: { ionice, noted: new Set<string>() } });
  assert.equal(getPriority(launch.pid), GARDEN_CHILD_NICENESS, `the run child runs at the garden niceness, not the daemon's ${own}`);
  assert.equal(getPriority(), own, "the daemon's own niceness is unchanged");
  for (let waited = 0; waited < 10_000; waited += 25) {
    try {
      if (readFileSync(ioniceArgs, "utf8").trim() !== "") break;
    } catch (error) {
      void error; // ENOENT until the fake ionice has run.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(readFileSync(ioniceArgs, "utf8").trim(), `-c 2 -n 7 -p ${launch.pid}`);
  assert.deepEqual(fx.rows.filter((r) => r.step === DEGRADED), []);
  process.kill(-launch.pid, "SIGKILL");
});

test("W1-T13968 criterion 2: a host that refuses either change writes one row per refusal kind, and the child still starts", async () => {
  const seams = prioritySeams({ nice: new Error("EPERM: operation not permitted"), ionice: new Error("ioprio_set failed: Operation not permitted") });
  const first = spawnFixture("refused-1");
  const one = await launched(first, { priority: seams.ports });
  assert.equal(one.pid, FAKE_PID, "the run child started");
  assert.equal(first.calls.length, 1, "the refusal neither skipped nor repeated the spawn");
  assert.ok(first.rows.some((r) => r.step === runChild.RUN_CHILD_SPAWNED_STEP), "the run went on");
  await settleIonice();
  // A second spawn on the same host meets the same refusals: they were noted already, so no second row is written.
  const second = spawnFixture("refused-2");
  const two = await runChild.spawnRunChild(second.input, { ...second.base, priority: seams.ports } as never);
  assert.ok(two.started, JSON.stringify(two));
  two.settled.catch(() => {});
  two.detach?.();
  await settleIonice();
  assert.deepEqual(seams.niced.map(([, n]) => n), [GARDEN_CHILD_NICENESS, GARDEN_CHILD_NICENESS], "both spawns asked");
  const notes = [...first.rows, ...second.rows].filter((r) => r.step === DEGRADED);
  assert.deepEqual(notes.map((r) => r.how).sort(), ["ionice", "nice"], "one row per refusal kind, not one per spawn");
  assert.match(String(notes.find((r) => r.how === "nice")?.error), /EPERM/);
  assert.match(String(notes.find((r) => r.how === "ionice")?.error), /ioprio_set failed/);
  assert.equal(runChild.RUN_CHILD_PRIORITY_DEGRADED_STEP, DEGRADED);
});

test("W1-T13968 criterion 2: an ionice that never returns does not delay the spawn, and a child gone before it is lowered is no refusal", async () => {
  const fx = spawnFixture("hang");
  const seams = prioritySeams({ ioniceHangs: true });
  const launch = await launched(fx, { priority: seams.ports });
  assert.equal(launch.pid, FAKE_PID, "the spawn resolved while ionice still runs");
  const rows: string[] = [];
  const log = (step: string) => { rows.push(step); };
  const gone = Object.assign(new Error("uv_os_setpriority returned ESRCH (no such process)"), { info: { code: "ESRCH" } });
  await runChild.lowerRunChildPriority(FAKE_PID, log, {
    setPriority: () => { throw gone; }, ionice: "/usr/bin/ionice", runIonice: () => Promise.reject(new Error("ioprio_set failed: No such process")),
    noted: new Set(),
  });
  assert.deepEqual(rows, [], "an exited child cannot be lowered, and that is not the host refusing");
});

test("W1-T13968 criterion 2: by default each refusal kind is noted once for the whole daemon, across spawns", async () => {
  const rows: string[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push(`${step}:${String(extra?.how)}`); };
  const refuse = () => { throw new Error("EACCES: permission denied"); };
  // No `noted` passed: the module's own set, shared by every spawn this process makes.
  runChild.lowerRunChildPriority(FAKE_PID, log, { setPriority: refuse, ionice: null });
  runChild.lowerRunChildPriority(FAKE_PID + 1, log, { setPriority: refuse, ionice: null });
  assert.deepEqual(rows, [`${DEGRADED}:nice`]);
});

/** The pid of a real child that has exited and been reaped: a signal-0 probe of it answers ESRCH. */
async function goneChildPid(): Promise<number> {
  const child = nodeSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  assert.ok(child.pid !== undefined);
  assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "the pid is gone");
  return child.pid;
}

/** An ionice failure as execFileRouted rejects with it: the exit code in `code`, the reason on stderr. */
const ioniceFailed = (stderr: string): Error =>
  Object.assign(new Error(`Command failed: /usr/bin/ionice -c 2 -n 7 -p 1\n${stderr}`), { code: 1, stderr });

test("W1-T13968 criterion 2: a permission refusal whose answer arrives after the run child exited still writes its row", async () => {
  let real: ChildProcess | undefined;
  const fx = spawnFixture("refused-after-exit", () => {
    real = nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    live.push(real);
    return real;
  });
  let goneWhenAnswered = false;
  const ports = {
    setPriority: () => {}, ionice: "/usr/bin/ionice", noted: new Set<string>(),
    // ionice is refused while the child runs, and its answer is read only once the child has exited.
    runIonice: async (_file: string, args: readonly string[]) => {
      const child = real!;
      assert.equal(args.at(-1), String(child.pid));
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      goneWhenAnswered = (() => {
        try {
          process.kill(child.pid!, 0);
          return false;
        } catch (error) {
          return (error as { code?: unknown }).code === "ESRCH";
        }
      })();
      throw ioniceFailed("ionice: ioprio_set failed: Operation not permitted\n");
    },
  };
  const launch = await launched(fx, { priority: ports });
  assert.equal(launch.pid, real!.pid, "the run child started");
  let notes: Array<Record<string, unknown>> = [];
  for (let waited = 0; waited < 5_000 && notes.length === 0; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    notes = fx.rows.filter((r) => r.step === DEGRADED);
  }
  assert.ok(goneWhenAnswered, "the refusal's answer arrived after the child had exited");
  assert.deepEqual(notes.map((r) => r.how), ["ionice"], "a permission refusal is the host refusing, whether or not the child still runs");
  assert.match(String(notes[0]!.error), /Operation not permitted/);
  assert.equal(notes[0]!.child_pid, launch.pid);
});

test("W1-T13968 criterion 2: each refusal is classed by its own error code, and only no such process is silent", async () => {
  const pid = await goneChildPid();
  const systemError = (code: string) => Object.assign(new Error(`A system error occurred: uv_os_setpriority returned ${code}`),
    { code: "ERR_SYSTEM_ERROR", info: { code } });
  const cases: Array<{ name: string; nice?: Error; ionice?: Error; rows: string[] }> = [
    { name: "nice EPERM", nice: systemError("EPERM"), rows: ["nice"] },
    { name: "nice EACCES", nice: systemError("EACCES"), rows: ["nice"] },
    { name: "nice any other refusal", nice: systemError("EINVAL"), rows: ["nice"] },
    { name: "nice ESRCH", nice: systemError("ESRCH"), rows: [] },
    { name: "ionice Operation not permitted", ionice: ioniceFailed("ionice: ioprio_set failed: Operation not permitted\n"), rows: ["ionice"] },
    { name: "ionice spawn EACCES", ionice: Object.assign(new Error("spawn /usr/bin/ionice EACCES"), { code: "EACCES" }), rows: ["ionice"] },
    { name: "ionice any other exit", ionice: ioniceFailed("ionice: bad usage\n"), rows: ["ionice"] },
    { name: "ionice No such process", ionice: ioniceFailed("ionice: ioprio_set failed: No such process\n"), rows: [] },
    { name: "ionice ESRCH", ionice: Object.assign(new Error("ESRCH"), { code: "ESRCH" }), rows: [] },
  ];
  for (const c of cases) {
    const rows: string[] = [];
    await runChild.lowerRunChildPriority(pid, (step, extra) => { if (step === DEGRADED) rows.push(String(extra?.how)); }, {
      setPriority: () => { if (c.nice) throw c.nice; },
      ionice: "/usr/bin/ionice",
      runIonice: () => (c.ionice ? Promise.reject(c.ionice) : Promise.resolve()),
      noted: new Set(),
    });
    assert.deepEqual(rows, c.rows, `${c.name}, for a child already gone`);
  }
});

test("W1-T13968 criterion 3: the run child's argv, env, pid, stderr file and reservation are unchanged, and the daemon is never reniced", async () => {
  const fx = spawnFixture("invariant");
  const seams = prioritySeams();
  const launch = await launched(fx, { priority: seams.ports });
  assert.equal(fx.calls.length, 1);
  const [call] = fx.calls;
  const dir = runDir(fx.state, launch.runId);
  assert.equal(call!.command, process.execPath, "no nice or ionice wrapper on the command");
  assert.deepEqual(call!.args, [...childHeapPolicyArgs(), ...LAUNCH_ARGV, "--run-dir", dir]);
  const { [INSTALLATION_SHARE_DIVISOR_ENV]: divisor, ...rest } = call!.options.env;
  assert.match(String(divisor), /^\d+$/);
  assert.deepEqual(rest, { ...fx.env, ...runChildInstallationEnv() }, "the env is the daemon's with only the share divisor and hand-over added");
  assert.equal(typeof call!.options.stderrFd, "number");
  assert.equal(call!.options.offerPipe, undefined);
  assert.equal(launch.dir, dir);
  readFileSync(join(dir, RUN_CHILD_STDERR_FILE), "utf8"); // the stderr file is opened in the run directory
  assert.equal(launch.pid, FAKE_PID);
  assert.deepEqual(fx.bound, [FAKE_PID], "the reservation is bound to the child's pid once");
  assert.ok(seams.niced.length > 0 && seams.niced.every(([pid]) => pid === FAKE_PID && pid !== process.pid),
    "only the child is reniced, never the daemon (pid 0 would be this process)");
  await settleIonice();
  assert.ok(seams.ioniced.length > 0 && seams.ioniced.every(([, args]) => args.at(-1) === String(FAKE_PID)), "only the child's IO class changes");
});

test("W1-T13968 criterion 3: a test child keeps its relative nice -n of TEST_RUN_NICENESS, and a garden child its niceness and idle IO class", async (t) => {
  const wrapped = lowPriorityCommand("node", ["--test", "x.test.ts"], () => true);
  assert.deepEqual(wrapped.args, ["-c", "2", "-n", "7", "/usr/bin/nice", "-n", String(TEST_RUN_NICENESS), "node", "--test", "x.test.ts"],
    "nice -n is relative to its parent, so a test under a run child runs at or below the run child's priority");
  assert.equal(TEST_RUN_NICENESS, 10);
  assert.equal(GARDEN_CHILD_NICENESS, 10);

  const dir = tmp("garden");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "pass.mjs");
  writeFileSync(entry, "\n");
  const ioniceArgs = join(dir, "ionice-args");
  const ionice = join(dir, "fake-ionice");
  writeFileSync(ionice, `#!/bin/sh\necho "$@" > '${ioniceArgs}'\n`);
  chmodSync(ionice, 0o755);
  const priorities: Array<[number, number]> = [];
  const spawnPass = childGardenPassSpawn({
    execPath: process.execPath, execArgv: [], entry, root: dir, reserve: () => undefined,
    setPriority: (pid, priority) => void priorities.push([pid, priority]), ionice, log: () => {},
  });
  assert.equal(await spawnPass("plan", [], { stopped: false }), 0);
  assert.equal(priorities.length, 1);
  assert.equal(priorities[0]![1], GARDEN_CHILD_NICENESS, "a garden child keeps its niceness");
  assert.equal(readFileSync(ioniceArgs, "utf8").trim(), `-c 3 -p ${priorities[0]![0]}`, "a garden child keeps the idle IO class");
});

test("W1-T13968 criterion 3: a run child whose pid is the daemon's own is never lowered, through any seam", async () => {
  const own = getPriority();
  const fx = spawnFixture("own-pid", () => {
    const child = new FakeChild();
    child.pid = process.pid; // the W1-T9085 reservation suite's fake spawn returns this process's pid
    return child as unknown as ChildProcess;
  });
  const seams = prioritySeams();
  const launch = await launched(fx, { priority: seams.ports });
  assert.equal(launch.pid, process.pid, "the spawn still went on");
  assert.deepEqual(fx.bound, [process.pid], "and its reservation bound");
  await settleIonice();
  assert.deepEqual(seams.niced, [], "no setPriority on this process");
  assert.deepEqual(seams.ioniced, [], "no ionice on this process");
  assert.deepEqual(fx.rows.filter((r) => r.step === DEGRADED), [], "a skipped pid is no refusal");
  assert.equal(getPriority(), own, "the daemon keeps its niceness");
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    const direct = prioritySeams();
    const rows: string[] = [];
    await runChild.lowerRunChildPriority(pid, (step) => { rows.push(step); }, direct.ports);
    assert.deepEqual([direct.niced, direct.ioniced, rows], [[], [], []], `pid ${pid} is never lowered (0 is the caller itself)`);
  }
});

// Last in the file: at a base without the guard, the real setPriority lowers this test process and cannot raise it back.
test("W1-T13968 criterion 3: with the real default seams, a fake spawn returning this process's pid leaves its niceness unchanged", async () => {
  const own = getPriority();
  const fx = spawnFixture("own-pid-default", () => {
    const child = new FakeChild();
    child.pid = process.pid;
    return child as unknown as ChildProcess;
  });
  const launch = await launched(fx, {});
  assert.equal(launch.pid, process.pid);
  await settleIonice();
  assert.equal(getPriority(), own, "the real os.setPriority was never pointed at this process");
  assert.equal(getPriority(process.pid), own);
  assert.deepEqual(fx.rows.filter((r) => r.step === DEGRADED), []);
});
