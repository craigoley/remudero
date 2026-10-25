/**
 * W1-T9556 — THE PRE-OPEN FAST GATE'S BACKSTOP HOLDS WHILE THE PARENT'S EVENT LOOP IS FROZEN.
 *
 * The backstop used to be execFile's `timeout`, a timer on the daemon's own loop: on 2026-10-14 a frozen loop let
 * W1-T7651's gate run 1,792 s and W1-T7898's 2,028 s against 900 s. These tests freeze THIS process's loop with
 * `Atomics.wait` past a short deadline while a stub gate (which spawns a grandchild) runs, and read the stub's and
 * the grandchild's own last-alive times from files they write — evidence no parent timer can fake.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { CHILD_ENTRY_SPAWNED_STEP } from "../src/lib/child-entry-argv.js";
import {
  armedEnforcers, classifyGateExit, DEADLINE_RUNNER, defaultRunGate, findOnPath, GATE_DEADLINE_EXIT_CODE,
  GATE_DEADLINE_MARKER, gateTimeoutBin, runPreopenGate, type GateContain, type PreopenGateResult,
} from "../src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const DEADLINE_MS = 1_000;
const FREEZE_MS = 4_000;
/** The stub and its grandchild end themselves well after the freeze, so a missing kill shows and nothing hangs. */
const STUB_SELF_EXIT_MS = 7_000;
const GRANDCHILD_SELF_EXIT_MS = 9_000;
/** Spawn and teardown slack past the deadline; the freeze outlasts deadline + slack by a clear margin. */
const SLACK_MS = 1_500;

const dirs: string[] = [];
function scratch(kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9556-${kind}-`));
  dirs.push(dir);
  return dir;
}

/** Kill every stub and grandchild a test started, by the exact pid each wrote, then remove the scratch dirs. */
after(() => {
  for (const dir of dirs) {
    for (const name of ["stub.pid", "gc.pid"]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
      } catch {
        // Already gone (ESRCH): the kill under test did its job.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stub gate: records its pid, spawns a grandchild in its own process group, and both beat a last-alive file. */
function writeStubGate(dir: string): string {
  const stub = join(dir, "stub-gate");
  const at = (name: string) => JSON.stringify(join(dir, name));
  const grandchild = `const fs = require("fs"); const beat = () => fs.writeFileSync(${at("gc.alive")}, String(Date.now()));` +
    ` beat(); setInterval(beat, 25); setTimeout(() => process.exit(0), ${GRANDCHILD_SELF_EXIT_MS});`;
  writeFileSync(stub, `#!${process.execPath}\n` +
    `const fs = require("fs"); const cp = require("child_process");\n` +
    `const gc = cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });\n` +
    `fs.writeFileSync(${at("gc.pid")}, String(gc.pid)); fs.writeFileSync(${at("stub.pid")}, String(process.pid));\n` +
    `const beat = () => fs.writeFileSync(${at("stub.alive")}, String(Date.now()));\n` +
    `beat(); setInterval(beat, 25); setTimeout(() => process.exit(0), ${STUB_SELF_EXIT_MS});\n`);
  chmodSync(stub, 0o755);
  return stub;
}

const lastAlive = (dir: string, name: string): number => Number(readFileSync(join(dir, name), "utf8"));

/** A runner can reach its deadline before the stub writes anything. Never poll a dead child forever. */
async function waitForStartupMarker(marker: string, child: ReturnType<typeof spawn>, deadlineAt: number): Promise<void> {
  let spawnError: Error | undefined;
  const onError = (error: Error) => { spawnError = error; };
  child.once("error", onError);
  try {
    while (!existsSync(marker)) {
      if (spawnError) throw new Error(`startup marker ${marker}: child could not start: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`startup marker ${marker}: child exited before startup (code=${child.exitCode}, signal=${child.signalCode})`);
      }
      if (Date.now() >= deadlineAt + SLACK_MS) throw new Error(`startup marker ${marker}: runner deadline passed without startup`);
      await sleep(25);
    }
  } catch (error) {
    // This fixture owns the runner. Resume a stopped one so its ordinary TERM handler can reap its group.
    child.kill("SIGCONT");
    child.kill("SIGTERM");
    throw error;
  } finally {
    child.off("error", onError);
  }
}

/** Rescue only a broken wait, so reverting the fix fails the assertion instead of hanging the suite. */
async function expectStartupFailure(child: ReturnType<typeof spawn>, marker: string, message: RegExp): Promise<void> {
  let rescue: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  child.once("close", () => {
    if (!finished) rescue = setTimeout(() => writeFileSync(marker, "test cleanup marker, not a startup receipt"), 100);
  });
  try {
    await assert.rejects(waitForStartupMarker(marker, child, Date.now() + 60_000), message);
  } finally {
    finished = true;
    clearTimeout(rescue);
  }
}

test("startup marker wait fails fast when its real child exits before writing the marker", async () => {
  const dir = scratch("startup-exit");
  const child = spawn(process.execPath, ["-e", "process.exit(17)"], { stdio: "ignore" });
  await expectStartupFailure(child, join(dir, "absent.alive"), /child exited before startup \(code=17, signal=null\)/);
});

test("startup marker wait fails fast when its real child cannot spawn", async () => {
  const dir = scratch("startup-error");
  const child = spawn(join(dir, "absent-command"), [], { stdio: "ignore" });
  await expectStartupFailure(child, join(dir, "absent.alive"), /child could not start:.*ENOENT/);
});

/** W1-T9619: a stand-in sandbox (the gate is never run uncontained) that runs the command after `--` as a child. */
function passThroughSandbox(dir: string): GateContain {
  const file = join(dir, "pass-through-sandbox");
  writeFileSync(file, `#!${process.execPath}\nconst args = process.argv.slice(2); const at = args.indexOf("--");\n` +
    `const r = require("child_process").spawnSync(args[at + 1], args.slice(at + 2), { stdio: "inherit" }); process.exit(r.status ?? 1);\n`);
  chmodSync(file, 0o755);
  return () => ({ mode: "sandboxed", file, argv: ["--"] });
}

interface FrozenRun {
  dir: string;
  startedAt: number;
  freezeEnd: number;
  result: PreopenGateResult;
  stubLast: number;
  gcLastAtResolve: number;
  gcLastLater: number;
}

/** One gate run under the runner alone (timeoutBin null — macOS's case), with this process's loop frozen past the deadline. */
async function frozenRun(): Promise<FrozenRun> {
  const dir = scratch("frozen");
  const work = join(dir, "work");
  mkdirSync(work);
  const stub = writeStubGate(dir);
  const startedAt = Date.now();
  const contain = passThroughSandbox(dir);
  const pending = runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, stub, undefined, { backstopMs: DEADLINE_MS, timeoutBin: null }, { contain }) });
  // The freeze: no timer, no I/O callback, nothing on this loop runs until it ends.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FREEZE_MS);
  const freezeEnd = Date.now();
  const result = await pending;
  const gcLastAtResolve = lastAlive(dir, "gc.alive");
  await sleep(500);
  return { dir, startedAt, freezeEnd, result, stubLast: lastAlive(dir, "stub.alive"), gcLastAtResolve, gcLastLater: lastAlive(dir, "gc.alive") };
}

let shared: Promise<FrozenRun> | undefined;
const frozen = (): Promise<FrozenRun> => (shared ??= frozenRun());

test("W1-T9556: a gate child ends at its deadline while the parent loop is frozen", async () => {
  const run = await frozen();
  assert.ok(run.freezeEnd - run.startedAt >= FREEZE_MS - 50, "the parent's loop really was frozen past the deadline");
  const ranFor = run.stubLast - run.startedAt;
  assert.ok(ranFor < DEADLINE_MS + SLACK_MS, `the stub gate beat ${ranFor} ms after start; its deadline was ${DEADLINE_MS} ms`);
  assert.ok(run.stubLast < run.freezeEnd - 1_000, "the stub ended during the freeze, not when the parent's loop next ran");
});

test("W1-T9556: the deadline kill takes the whole gate process group", async () => {
  const run = await frozen();
  assert.ok(run.gcLastAtResolve - run.startedAt < DEADLINE_MS + SLACK_MS, `the grandchild beat ${run.gcLastAtResolve - run.startedAt} ms after start`);
  assert.equal(run.gcLastLater, run.gcLastAtResolve, "the grandchild is still beating after the gate was killed");
});

test("W1-T9556: a deadline kill is unmeasured as exceeded its backstop", async () => {
  const run = await frozen();
  assert.equal(run.result.kind, "unmeasured", JSON.stringify(run.result));
  assert.equal(run.result.kind === "unmeasured" ? run.result.reason : "", "fast gate exceeded its backstop");
  assert.equal(run.result.kind === "unmeasured" ? run.result.deadlineEnforcedBy : undefined, "runner");
});

test("W1-T9556: each enforcer's kill classifies as exceeded its backstop and names that enforcer", () => {
  const failed = (code: unknown, killed = false) => Object.assign(new Error("Command failed"), { code, killed });
  assert.deepEqual(classifyGateExit(null, ""), { exitCode: 0 });
  assert.deepEqual(classifyGateExit(failed(null, true), ""), { exitCode: null, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "parent" });
  assert.deepEqual(classifyGateExit(failed(GATE_DEADLINE_EXIT_CODE), `x\n${GATE_DEADLINE_MARKER} enforced_by=runner deadline=…\n`),
    { exitCode: GATE_DEADLINE_EXIT_CODE, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "runner" });
  assert.deepEqual(classifyGateExit(failed(GATE_DEADLINE_EXIT_CODE), ""),
    { exitCode: GATE_DEADLINE_EXIT_CODE, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "timeout" });
  // An ordinary red gate stays measurable (its summary is read); a spawn failure carries its message.
  assert.deepEqual(classifyGateExit(failed(1), ""), { exitCode: 1 });
  assert.deepEqual(classifyGateExit(failed("ENOENT"), ""), { exitCode: null, error: "Command failed" });
});

test("W1-T9556: coreutils timeout is found by a spawn-free PATH walk, and the row names the armed enforcers", async () => {
  const dir = scratch("path");
  const bin = join(dir, "bin");
  const notExec = join(dir, "noexec");
  const asDir = join(dir, "asdir");
  mkdirSync(bin);
  mkdirSync(notExec);
  mkdirSync(join(asDir, "timeout"), { recursive: true });
  writeFileSync(join(notExec, "timeout"), "");
  writeFileSync(join(bin, "timeout"), "#!/bin/sh\n");
  chmodSync(join(bin, "timeout"), 0o755);
  assert.equal(findOnPath("timeout", ["", notExec, asDir, bin].join(":")), join(bin, "timeout"));
  assert.equal(findOnPath("timeout", [notExec, asDir].join(":")), null);
  // An UNSET PATH, not an `undefined` argument: that takes the process.env.PATH default, which on a Linux runner
  // holds /usr/bin/timeout.
  const savedPath = process.env.PATH;
  delete process.env.PATH;
  try {
    assert.equal(findOnPath("timeout"), null);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(gateTimeoutBin(), gateTimeoutBin(), "resolved once");
  assert.deepEqual(armedEnforcers("/usr/bin/timeout"), ["timeout", "runner", "parent"]);
  assert.deepEqual(armedEnforcers(null), ["runner", "parent"]);

  // A gate run through the default launch (W1-T9619: the harness's bin/rmd, against the worktree): it passes
  // through the runner, and the row says which enforcers held its deadline.
  const work = scratch("own");
  const harness = scratch("harness");
  mkdirSync(join(harness, "bin"));
  writeFileSync(join(harness, "bin", "rmd"), `#!${process.execPath}\nprocess.exit(0);\n`);
  chmodSync(join(harness, "bin", "rmd"), 0o755);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, undefined, log, {}, { contain: passThroughSandbox(harness), harnessRoot: harness }) });
  assert.equal(result.kind, "pass", JSON.stringify(result));
  const spawned = rows.filter((r) => r.step === CHILD_ENTRY_SPAWNED_STEP);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.extra?.deadline_enforced_by, armedEnforcers(gateTimeoutBin()));
});

test("W1-T9556: the runner passes a gate's own status through, and a runner told to stop takes the group", async () => {
  const dir = scratch("runner");
  const runner = (deadlineAt: number, command: string[], extra: string[] = []) =>
    spawn(process.execPath, [DEADLINE_RUNNER, String(deadlineAt), "200", ...extra, "--", ...command], { stdio: ["ignore", "ignore", "pipe"] });
  const exit = (child: ReturnType<typeof runner>) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const far = Date.now() + 60_000;

  assert.equal((await exit(runner(far, [process.execPath, "-e", "process.exit(3)"]))).code, 3);
  assert.equal((await exit(runner(far, [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"]))).code, 128 + 9);
  assert.equal((await exit(runner(far, [join(dir, "absent")]))).code, 127);
  const usage = await exit(spawn(process.execPath, [DEADLINE_RUNNER, "not-a-deadline"], { stdio: ["ignore", "ignore", "pipe"] }));
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage: run-with-deadline/);

  // The parent's last-line timeout signals the runner; the runner ends the stub and its grandchild with it.
  const stub = writeStubGate(dir);
  const child = runner(far, [stub]);
  const done = exit(child);
  await waitForStartupMarker(join(dir, "gc.alive"), child, far);
  child.kill("SIGTERM");
  const stopped = await done;
  assert.equal(stopped.code, 128 + 15);
  const gcLast = lastAlive(dir, "gc.alive");
  await sleep(300);
  assert.equal(lastAlive(dir, "gc.alive"), gcLast, "the grandchild outlived its stopped runner");
});

test("W1-T9556: a gate that ignores SIGTERM at the deadline is SIGKILLed once the grace is spent", async () => {
  const dir = scratch("stubborn");
  const pidFile = join(dir, "stubborn.pid");
  const gate = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    ` setInterval(() => {}, 1000); setTimeout(() => process.exit(0), ${STUB_SELF_EXIT_MS});`;
  const startedAt = Date.now();
  const child = spawn(process.execPath, [DEADLINE_RUNNER, String(startedAt + DEADLINE_MS), "200", "--", process.execPath, "-e", gate],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += String(d)));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, GATE_DEADLINE_EXIT_CODE, stderr);
  assert.match(stderr, new RegExp(`${GATE_DEADLINE_MARKER} enforced_by=runner`));
  assert.ok(Date.now() - startedAt < STUB_SELF_EXIT_MS, "the runner waited for the gate's own exit instead of killing it");
  // The runner exits as it sends SIGKILL, so the orphan may still be listed (a zombie) for a moment.
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive() && waited < 2_000; waited += 25) await sleep(25);
  assert.equal(alive(), false, "the SIGTERM-ignoring gate is gone");
});

test("W1-T9556: a command that exits past the deadline before the runner's own timer ran is credited to timeout", async () => {
  // Deterministic stand-in for "the runner's loop was frozen across the deadline": the runner's wall clock jumps an
  // hour 200 ms in, while its deadline timer (monotonic) is still a minute out, so the command's exit is the first
  // thing the runner sees past the deadline. The --kernel-timeout bin is a pass-through shim: only the label matters.
  const dir = scratch("late-exit");
  const preload = join(dir, "clock-jump.mjs");
  writeFileSync(preload, "const real = Date.now; const t0 = real(); Date.now = () => real() + (real() - t0 > 200 ? 3_600_000 : 0);\n");
  const shim = join(dir, "timeout");
  writeFileSync(shim, "#!/bin/sh\nshift 3\nexec \"$@\"\n");
  chmodSync(shim, 0o755);
  const child = spawn(process.execPath, ["--import", preload, DEADLINE_RUNNER, String(Date.now() + 60_000), "200", "--kernel-timeout", shim,
    "--", process.execPath, "-e", "setTimeout(() => {}, 500)"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += String(d)));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, GATE_DEADLINE_EXIT_CODE, stderr);
  assert.match(stderr, new RegExp(`${GATE_DEADLINE_MARKER} enforced_by=timeout`));
});

test("W1-T9556: signalGroup rethrows an error that is not an empty group", async () => {
  const { signalGroup } = (await import(new URL("../scripts/run-with-deadline.mjs", import.meta.url).href)) as
    { signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => boolean };
  assert.equal(signalGroup(2 ** 22 + 12345, 0), false, "an empty group reads as gone");
  assert.throws(() => signalGroup(process.pid, "SIGNOTASIGNAL" as NodeJS.Signals), { code: "ERR_UNKNOWN_SIGNAL" });
});

/** Resume this fixture's runner even if observing the frozen interval throws. */
async function whileRunnerStopped<T>(child: ReturnType<typeof spawn>, observe: () => Promise<T>): Promise<T> {
  assert.equal(child.kill("SIGSTOP"), true, "the owned runner is present for the freeze");
  try {
    return await observe();
  } finally { child.kill("SIGCONT"); }
}

test("a failed frozen-clock observation resumes its owned runner before cleanup", async () => {
  const dir = scratch("observation-error");
  const marker = join(dir, "runner.ready");
  const child = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => process.exit(0));
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000);`], { stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  let rescued = false;
  const rescue = setTimeout(() => {
    rescued = true;
    child.kill("SIGCONT");
    child.kill("SIGKILL");
  }, 6_000);
  try {
    await waitForStartupMarker(marker, child, Date.now() + DEADLINE_MS);
    await assert.rejects(whileRunnerStopped(child, async () => {
      await sleep(50);
      readFileSync(join(dir, "missing.alive"), "utf8");
    }), /ENOENT/);
    child.kill("SIGTERM");
    await closed;
    assert.equal(rescued, false, "a thrown observation must not leave the runner stopped until rescue");
  } finally {
    clearTimeout(rescue);
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    await closed;
  }
});

const timeoutBin = gateTimeoutBin();
test("W1-T9556: coreutils timeout ends the gate group at the deadline even while the runner itself is frozen", { skip: timeoutBin ? false : "no coreutils timeout on PATH" }, async () => {
  const dir = scratch("kernel");
  const stub = writeStubGate(dir);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [DEADLINE_RUNNER, String(startedAt + DEADLINE_MS), "200", "--kernel-timeout", timeoutBin!, "--", stub],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += String(d)));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  await waitForStartupMarker(join(dir, "stub.alive"), child, startedAt + DEADLINE_MS);
  // Stop the runner outright: its own deadline timer cannot run, so only `timeout` can end the group.
  const { stubLast, gcLast } = await whileRunnerStopped(child, async () => {
    await sleep(FREEZE_MS);
    return { stubLast: lastAlive(dir, "stub.alive"), gcLast: lastAlive(dir, "gc.alive") };
  });
  assert.equal(await closed, GATE_DEADLINE_EXIT_CODE, stderr);
  assert.ok(stubLast - startedAt < DEADLINE_MS + SLACK_MS, `the stub beat ${stubLast - startedAt} ms after start`);
  assert.ok(gcLast - startedAt < DEADLINE_MS + SLACK_MS, `the grandchild beat ${gcLast - startedAt} ms after start`);
  // The label may read either: on SIGCONT the runner's overdue timer can run before it sees its child's exit. The
  // proof that `timeout` did the killing is the beat times above, taken while the runner could run nothing.
  assert.match(stderr, new RegExp(`${GATE_DEADLINE_MARKER} enforced_by=(timeout|runner)`));
});
