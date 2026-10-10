/**
 * W1-T5723 — the measurement cadence runs out of process, and a restart does not discard it.
 *
 * In-process, the cadence's synchronous work froze the daemon loop (one 365.7 s block, 2026-10-08)
 * and every restart killed it. These drive `runDaemon` with a fake spawner over a real state file.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FIXTURE_CONFIG_PATH_SEGMENTS } from "../src/lib/config.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";
import {
  childMeasurementCadenceSpawn,
  MEASUREMENT_CADENCE_CHILD_FLAG,
  measurementCadenceChildLogPath,
  measurementCadenceChildAlive,
  measurementCadenceChildAttempt,
  measurementCadenceChildRun,
  measurementCadenceChildMain,
  measurementCadenceChildRunner,
  type MeasurementCadenceChildOutcome,
  type MeasurementCadenceChildState,
  type MeasurementCadenceRunResult,
} from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5723-`));
}

function fixturePlan(): Plan {
  const path = join(scratch(), "tasks.yaml");
  writeFileSync(path, YAML);
  return loadPlan(path);
}

function cadenceResult(): MeasurementCadenceRunResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ruleEfficacy: "SENTINEL_ruleEfficacy" } as any as MeasurementCadenceRunResult;
}

/** A fake child table: `spawn` records each start, `alive` is what the probe answers. */
function fakeChildren() {
  const spawned: { runId: string; pid: number }[] = [];
  const alive = new Set<number>();
  let nextPid = 1000;
  return {
    spawned,
    alive,
    spawn: (runId: string) => {
      const pid = ++nextPid;
      spawned.push({ runId, pid });
      alive.add(pid);
      return pid;
    },
  };
}

function runnerFor(statePath: string, children: ReturnType<typeof fakeChildren>, runIds: string[] = ["RUN-1", "RUN-2"]) {
  return measurementCadenceChildRunner({
    statePath,
    spawn: children.spawn,
    isAlive: (pid) => children.alive.has(pid),
    newRunId: () => runIds.shift() ?? "RUN-X",
    pollMs: 5,
  });
}

type Row = { step: string; extra: Record<string, unknown> };

async function boot(rows: Row[], deps: Record<string, unknown>): Promise<void> {
  await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async () => { throw new Error("no task should run"); },
    sleep: async () => {},
    sweep: async () => {},
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
    ...deps,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, { max: 1 });
}

const childRows = (rows: Row[]) => rows.filter((r) => r.step === "measurement_cadence.child").map((r) => r.extra);
const settledOf = (o: MeasurementCadenceChildOutcome) => (o.kind === "none" ? undefined : o.settled);
const readState = (path: string) => JSON.parse(readFileSync(path, "utf8")) as MeasurementCadenceChildState;

test("W1-T5723: with a fake spawner the cadence starts a child rather than running in-process", { timeout: 5_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in");
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  let inProcess = 0;
  const rows: Row[] = [];
  await boot(rows, {
    checkMeasurementCadence: () => ({ fire: true, reason: "due" }),
    runMeasurementCadence: async () => { inProcess += 1; return cadenceResult(); },
    measurementCadenceChild: runnerFor(statePath, children),
  });

  assert.equal(children.spawned.length, 1, "the fire starts exactly one child");
  assert.equal(inProcess, 0, "and never runs the cadence in the daemon's own process");
  assert.equal(childRows(rows)[0]?.outcome, "started");
  assert.equal(childRows(rows)[0]?.run_id, "RUN-1");
  assert.deepEqual(
    { runId: readState(statePath).runId, pid: readState(statePath).pid, status: readState(statePath).status },
    { runId: "RUN-1", pid: children.spawned[0].pid, status: "running" },
    "the run id and pid are on disk for the next boot",
  );
  assert.ok(!rows.some((r) => r.step === "measurement_cadence.ran"), "the iteration finished ahead of the child");

  // The child records its result row and exits; the daemon reads it back.
  assert.equal(await measurementCadenceChildMain(statePath, "RUN-1", async () => cadenceResult()), 0);
  children.alive.clear();
  await drainDetachedSweepActions();
  const ran = rows.find((r) => r.step === "measurement_cadence.ran");
  assert.equal(ran?.extra.rule_efficacy, "SENTINEL_ruleEfficacy", "the child's result row is ledgered by the daemon");
});

test("W1-T5723: a second boot with the child still alive adopts the run instead of starting another", { timeout: 5_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in");
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  // Boot 1: the previous daemon process started the child, then restarted.
  const first = runnerFor(statePath, children).start({ fire: true });
  assert.equal(first.kind, "started");
  void settledOf(first)?.catch(() => {});

  const rows: Row[] = [];
  await boot(rows, {
    checkMeasurementCadence: () => ({ fire: true, reason: "first tick of the boot" }),
    runMeasurementCadence: async () => { throw new Error("must not run in-process"); },
    measurementCadenceChild: runnerFor(statePath, children, ["RUN-FRESH"]),
  });

  assert.equal(children.spawned.length, 1, "the live child is adopted, never started twice");
  assert.equal(childRows(rows)[0]?.outcome, "adopted");
  assert.equal(childRows(rows)[0]?.run_id, "RUN-1");
  assert.equal(childRows(rows)[0]?.pid, children.spawned[0].pid);

  await measurementCadenceChildMain(statePath, "RUN-1", async () => cadenceResult());
  children.alive.clear();
  await drainDetachedSweepActions();
  assert.ok(rows.some((r) => r.step === "measurement_cadence.ran"), "the adopted run's result reaches the ledger");
});

test("W1-T5723: a dead child's run is logged and restarted once, then discarded", { timeout: 5_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in");
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  const first = runnerFor(statePath, children).start({ fire: true });
  void settledOf(first)?.catch(() => {});
  const deadPid = children.spawned[0].pid;
  children.alive.delete(deadPid);

  const rows: Row[] = [];
  const quiet = { checkMeasurementCadence: () => ({ fire: false, reason: "not due" }) };
  await boot(rows, { ...quiet, measurementCadenceChild: runnerFor(statePath, children) });
  assert.equal(children.spawned.length, 2, "the dead child's run is restarted");
  assert.equal(children.spawned[1].runId, "RUN-1", "under the same run id");
  assert.deepEqual(
    { outcome: childRows(rows)[0]?.outcome, previous_pid: childRows(rows)[0]?.previous_pid, rule: childRows(rows)[0]?.previous_rule, attempt: childRows(rows)[0]?.attempt },
    { outcome: "restarted", previous_pid: deadPid, rule: "restart_once", attempt: 2 },
  );

  children.alive.clear();
  await drainDetachedSweepActions();
  assert.ok(rows.some((r) => r.step === "measurement_cadence.run_failed"), "the second death is ledgered");

  const third: Row[] = [];
  await boot(third, { ...quiet, measurementCadenceChild: runnerFor(statePath, children) });
  assert.equal(children.spawned.length, 2, "restarted ONCE: the second death is not restarted again");
  assert.equal(childRows(third)[0]?.outcome, "discarded");
  assert.equal(childRows(third)[0]?.previous_rule, "discard");
  assert.equal(readState(statePath).status, "discarded");
  await drainDetachedSweepActions();
});

test("W1-T5723: a child whose cadence throws records a failure the daemon reads", { timeout: 5_000 }, async () => {
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  const started = runnerFor(statePath, children).start({ fire: true });
  assert.equal(await measurementCadenceChildMain(statePath, "RUN-1", async () => { throw new Error("verb exploded"); }), 1);
  assert.equal(readState(statePath).status, "failed");
  await assert.rejects(settledOf(started) ?? Promise.resolve(), /verb exploded/);
  assert.equal(runnerFor(statePath, children).pending(), false, "a recorded failure is not restarted");
});

test("W1-T5723: an unreadable state file is discarded and logged, never trusted", () => {
  const statePath = join(scratch(), "state.json");
  writeFileSync(statePath, "{not json");
  const children = fakeChildren();
  const outcome = runnerFor(statePath, children).start({ fire: false });
  assert.equal(outcome.kind, "discarded");
  assert.equal(outcome.kind === "discarded" ? outcome.previous?.rule : undefined, "unreadable");
  assert.equal(children.spawned.length, 0);
  const fired = runnerFor(statePath, children).start({ fire: true });
  assert.equal(fired.kind, "started");
  void settledOf(fired)?.catch(() => {});
});

test("W1-T5723: the production spawn is detached, heap-capped and niced", () => {
  const statePath = join(scratch(), "state.json");
  const calls: { file: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  let unrefs = 0;
  const niced: number[] = [];
  const spawn = childMeasurementCadenceSpawn({
    entry: "/entry.ts",
    execPath: "/node",
    execArgv: ["--import", "tsx"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnChild: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return { pid: 77, unref: () => { unrefs += 1; } };
    }) as any,
    setPriority: (pid) => niced.push(pid),
    parentHeapLimitBytes: () => 3000 * 1024 * 1024,
  });
  assert.equal(spawn("RUN-9", statePath), 77);
  assert.deepEqual(calls[0].args, ["--import", "tsx", "--max-old-space-size=3000", "/entry.ts", MEASUREMENT_CADENCE_CHILD_FLAG, statePath, "RUN-9"]);
  assert.equal(calls[0].opts.detached, true, "a daemon restart must not take the child with it");
  assert.equal(unrefs, 1);
  assert.deepEqual(niced, [77]);

  const refused = childMeasurementCadenceSpawn({
    entry: "/entry.ts",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnChild: (() => ({ pid: 78, unref: () => {} })) as any,
    setPriority: () => { throw new Error("EACCES"); },
  });
  assert.equal(refused("RUN-10", statePath), 78, "a refused nice still starts the child");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unstarted = childMeasurementCadenceSpawn({ entry: "/entry.ts", spawnChild: (() => ({ pid: undefined, unref: () => {} })) as any });
  assert.throws(() => unstarted("RUN-11", statePath), /did not start/);
});

test("W1-T5723: the liveness probe reads this process alive and a reaped pid dead", () => {
  assert.equal(measurementCadenceChildAlive(process.pid), true);
  assert.equal(measurementCadenceChildAlive(2 ** 22 + 12345), false);
});

test("W1-T5723: the child entry does nothing when imported without its flag", async () => {
  const before = process.exitCode;
  await import("../src/measurement-cadence-child.js");
  assert.equal(process.exitCode, before);
});

test("W1-T5723: a runner whose start throws is ledgered as a failed child run and the boot carries on", { timeout: 5_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in");
  let inProcess = 0;
  const rows: Row[] = [];
  await boot(rows, {
    checkMeasurementCadence: () => ({ fire: true, reason: "due" }),
    runMeasurementCadence: async () => { inProcess += 1; return cadenceResult(); },
    measurementCadenceChild: { pending: () => false, start: () => { throw new Error("EAGAIN: spawn refused"); } },
  });
  const failed = rows.find((r) => r.step === "measurement_cadence.run_failed");
  assert.deepEqual(failed?.extra, { error: "EAGAIN: spawn refused", flow: "child" });
  assert.equal(childRows(rows).length, 0, "no child outcome is claimed for a start that threw");
  assert.equal(inProcess, 0, "a refused child never falls back to running the cadence in-process");
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "nothing was detached");
});

test("W1-T5723: the real child entry runs the real cadence and records its failure in the state file", { timeout: 120_000 }, () => {
  // A temp HOME whose config is malformed: the real cadence's first act, `loadConfig()`, throws before it
  // records a fire or reads any repository, so the child exits fast and touches nothing outside this HOME.
  const home = scratch();
  const configFile = join(home, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, "{not json");
  const statePath = join(scratch(), "state.json");
  const entry = fileURLToPath(new URL("../src/measurement-cadence-child.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "tsx", entry, MEASUREMENT_CADENCE_CHILD_FLAG, statePath, "RUN-REAL"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 110_000,
  });
  assert.equal(child.status, 1, `the child exits 1 on a failed cadence (stderr: ${child.stderr})`);
  const state = readState(statePath);
  assert.equal(state.runId, "RUN-REAL");
  assert.equal(state.status, "failed");
  assert.match(String(state.error), /JSON/, "the recorded error is the config parse failure");
});

test("the cadence child runs on the daemon's own heap budget, never a fixed 2048 MB cap", () => {
  // 2026-10-08..09: the daemon ran with an 8192 MB heap (NODE_OPTIONS) and the in-process cadence fit in it; the
  // child's argv cap of 2048 MB overrode that, and every child died mid-run without a result.
  const args: (readonly string[])[] = [];
  const spawn = childMeasurementCadenceSpawn({
    entry: "/entry.ts",
    execPath: "/node",
    execArgv: [],
    parentHeapLimitBytes: () => 8192 * 1024 * 1024,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnChild: ((_file: string, a: readonly string[]) => { args.push(a); return { pid: 91, unref: () => {} }; }) as any,
    setPriority: () => {},
  });
  spawn("RUN-HEAP", join(scratch(), "state.json"));
  assert.ok(args[0].includes("--max-old-space-size=8192"), `the child inherits the daemon's 8192 MB budget: ${args[0].join(" ")}`);
  assert.ok(!args[0].includes("--max-old-space-size=2048"), "and never the old fixed cap");
});

test("a cadence child that dies without a result names its stderr tail on the failure and the restart", { timeout: 5_000 }, async () => {
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  const first = runnerFor(statePath, children).start({ fire: true });
  // What V8 prints on a heap abort: the child itself can record nothing, so this log is the only account.
  writeFileSync(measurementCadenceChildLogPath(statePath), "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
  children.alive.clear();
  await assert.rejects(settledOf(first) ?? Promise.resolve(), /exited without a result; stderr: [\s\S]*Reached heap limit/);

  const restarted = runnerFor(statePath, children).start({ fire: false });
  assert.equal(restarted.kind, "restarted");
  assert.match(String(restarted.kind === "restarted" ? restarted.previous?.detail : ""), /Reached heap limit/, "the restart row names why the first child died");
  void settledOf(restarted)?.catch(() => {});
  children.alive.clear();
  const discarded = runnerFor(statePath, children).start({ fire: false });
  assert.equal(discarded.kind, "discarded");
  assert.match(String(readState(statePath).error), /died on attempt 2: /, "the discard records the death's account too");
});

test("the real cadence spawn keeps the child's stderr and exit status in its log", { timeout: 30_000 }, async () => {
  const dir = scratch();
  const entry = join(dir, "dies.mjs");
  writeFileSync(entry, 'process.stderr.write("FATAL ERROR: simulated heap abort\\n"); process.exit(134);\n');
  const statePath = join(dir, "state.json");
  const spawn = childMeasurementCadenceSpawn({ entry, execArgv: [], heapLimitMb: 64, setPriority: () => {} });
  const pid = spawn("RUN-LOG", statePath);
  const logPath = measurementCadenceChildLogPath(statePath);
  const deadline = Date.now() + 25_000;
  let log = "";
  while (Date.now() < deadline) {
    try { log = readFileSync(logPath, "utf8"); } catch { log = ""; }
    if (/exited: code=134/.test(log)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(log, /FATAL ERROR: simulated heap abort/, "the child's own stderr reaches the log");
  assert.match(log, new RegExp(`child ${pid} exited: code=134 signal=null heap_limit_mb=64`), "and its exit status is appended");
});

test("a restarted cadence child does not record a second fire against the daily cap", { timeout: 5_000 }, async () => {
  // 2026-10-09: two dead runs, each restarted once, recorded four fires (06:26, 06:57, 18:39, 18:47) and filled the
  // rolling-24h maxPerDay of 4, so the 00:47Z run never came. One run is one fire, however many attempts it takes.
  const statePath = join(scratch(), "state.json");
  const children = fakeChildren();
  const first = runnerFor(statePath, children).start({ fire: true });
  void settledOf(first)?.catch(() => {});
  assert.equal(measurementCadenceChildAttempt(statePath, "RUN-1"), 1);
  children.alive.clear();
  const restarted = runnerFor(statePath, children).start({ fire: false });
  assert.equal(restarted.kind, "restarted");
  void settledOf(restarted)?.catch(() => {});
  assert.equal(measurementCadenceChildAttempt(statePath, "RUN-1"), 2, "the restarted child reads its own attempt");
  assert.equal(measurementCadenceChildAttempt(statePath, "RUN-OTHER"), 1, "another run's state is never borrowed");

  const recorded: boolean[] = [];
  const build = (_config: unknown, opts: { recordFire: boolean }) => {
    recorded.push(opts.recordFire);
    return { runMeasurementCadence: async () => cadenceResult() };
  };
  await measurementCadenceChildRun({}, build, measurementCadenceChildAttempt(statePath, "RUN-1"))();
  await measurementCadenceChildRun({}, build, 1)();
  assert.deepEqual(recorded, [false, true], "only the first attempt spends a fire");
});
