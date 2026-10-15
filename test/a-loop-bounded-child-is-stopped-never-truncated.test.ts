/**
 * W1-T9651 — A LOOP-BOUNDED CHILD IS STOPPED, NEVER TRUNCATED.
 *
 * #11985 found execFile's own `timeout` firing ahead of an exit already pending after a held loop: the timer destroyed
 * the unread stdout and the call RESOLVED with an empty listing, so three pushes ran with no credential helper. The
 * helpers in src/lib/loop-bounded-child.ts bound a child by loop-available time instead, and a child they stop is a
 * failure. This drives the real helpers with real children (the fixture of
 * test/a-host-git-call-keeps-its-credential-helper-through-a-held-loop.test.ts): a child that exits at once while
 * the loop is held past its budget keeps its full stdout; a child that outlives its budget on a free loop is stopped
 * and REJECTS, even when it traps the signal and exits 0.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, execFile, spawn } from "node:child_process";

import { boundChildByLoopTime, execFileLoopBounded, LoopBoundedChildTimeout } from "../src/lib/loop-bounded-child.js";
import { clockFromMillisFn, systemClock } from "../src/lib/clock.js";
import { withGhKillEscalation } from "../src/lib/github-transport.js";

/** Holds the event loop the way the daemon's synchronous spawns did. */
function holdLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* held */ }
}

/** A child that prints `lines` numbered lines and exits 0 at once. */
const PRINT_AND_EXIT = (lines: number) => `for (let i = 0; i < ${lines}; i++) process.stdout.write("line " + i + "\\n");`;
/** A child that prints a partial line, traps SIGTERM to exit 0, and would otherwise run for a minute. */
const TRAP_AND_EXIT_ZERO =
  'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("partial\\n"); setTimeout(() => {}, 60000);';

function expectedLines(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `line ${i}\n`;
  return out;
}

/** Waits until the child has printed `marker`, so the budget expires on a child that already produced output. */
function printed(child: { stdout: NodeJS.ReadableStream | null }, marker: string): Promise<void> {
  return new Promise((resolve) => {
    let seen = "";
    child.stdout!.on("data", (chunk: Buffer | string) => {
      seen += String(chunk);
      if (seen.includes(marker)) resolve();
    });
  });
}

test("W1-T9651: a held loop never kills a child whose exit is already pending", async () => {
  // Control: execFile's own timeout, held past it, cuts the output away and still resolves (#11985).
  const plain = new Promise<string>((resolve) => {
    execFile(process.execPath, ["-e", PRINT_AND_EXIT(2000)], { encoding: "utf8", timeout: 200 }, (_err, stdout) => resolve(stdout));
  });
  holdLoop(1500);
  assert.notEqual(await plain, expectedLines(2000), "control: a plain timeout loses the output of a child that already exited");

  // The promise form: the same child, the same budget, the same hold.
  const bounded = execFileLoopBounded(process.execPath, ["-e", PRINT_AND_EXIT(2000)], { encoding: "utf8", timeout: 200 });
  holdLoop(1500);
  const { stdout } = await bounded;
  assert.equal(stdout, expectedLines(2000), "the loop-bounded read keeps every line");

  // The callback form: a callback execFile bounded by boundChildByLoopTime.
  let bound: ReturnType<typeof boundChildByLoopTime> | undefined;
  const viaCallback = new Promise<{ stdout: string; timedOut: boolean }>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", PRINT_AND_EXIT(2000)], { encoding: "utf8" }, (err, out) =>
      err ? reject(err) : resolve({ stdout: out, timedOut: bound!.timedOut }));
    bound = boundChildByLoopTime(child, 200);
  });
  holdLoop(1500);
  assert.deepEqual(await viaCallback, { stdout: expectedLines(2000), timedOut: false }, "the callback form keeps every line and is not timed out");

  // The spawn form.
  const child = spawn(process.execPath, ["-e", PRINT_AND_EXIT(2000)], { stdio: ["ignore", "pipe", "pipe"] });
  const spawnBound = boundChildByLoopTime(child, 200);
  let spawned = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => void (spawned += c));
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  holdLoop(1500);
  assert.equal(await closed, 0);
  assert.equal(spawned, expectedLines(2000), "the spawned child keeps every line");
  assert.equal(spawnBound.timedOut, false, "a child that exited during the hold is never reported timed out");
});

test("W1-T9651: a child stopped at its budget rejects and never resolves with partial stdout", async () => {
  // The promise form: the child traps SIGTERM and exits 0 with partial output; the call still rejects, named.
  const command = execFileLoopBounded(process.execPath, ["-e", TRAP_AND_EXIT_ZERO], { encoding: "utf8", timeout: 300 });
  await printed(command.child, "partial");
  const error = await command.then(
    (r) => assert.fail(`a stopped child resolved as a success with stdout ${JSON.stringify(r.stdout)}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof LoopBoundedChildTimeout, `rejects with LoopBoundedChildTimeout, got ${String(error)}`);
  assert.equal(error.killed, true);
  assert.equal(error.code, null, "never an exit status a caller could read as success");
  assert.equal(error.childExitCode, 0, "the child did exit 0 after trapping the signal");
  assert.equal(error.stdout, "partial\n", "the partial output is carried on the error, never returned as a result");
  assert.match(error.message, /^Command failed: /, "keeps execFile's message shape for callers that classify it");
  assert.match(error.message, /stopped by SIGTERM at its 300ms loop-available budget/);

  // A child that dies by the signal rejects named too.
  await assert.rejects(
    execFileLoopBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { encoding: "utf8", timeout: 300 }),
    (e: unknown) => e instanceof LoopBoundedChildTimeout && e.killed && e.signal === "SIGTERM",
  );

  // The callback form reports timedOut, so its caller refuses the result.
  let bound: ReturnType<typeof boundChildByLoopTime> | undefined;
  const viaCallback = await new Promise<{ err: unknown; stdout: string; timedOut: boolean }>((resolve) => {
    const child = execFile(process.execPath, ["-e", TRAP_AND_EXIT_ZERO], { encoding: "utf8" }, (err, stdout) =>
      resolve({ err, stdout, timedOut: bound!.timedOut }));
    bound = boundChildByLoopTime(child, 300);
  });
  assert.equal(viaCallback.err, null, "execFile itself saw exit 0");
  assert.equal(viaCallback.timedOut, true, "the bound reports the stop, so the exit 0 is not a success");
  assert.ok(bound!.timeoutError("node -e") instanceof LoopBoundedChildTimeout);

  // The escalation: a child that ignores SIGTERM gets SIGKILL after the grace, on the same deadline.
  const stubborn = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("up\\n"); setTimeout(() => {}, 60000);'], { stdio: ["ignore", "pipe", "ignore"] });
  let escalated = false;
  await printed(stubborn, "up");
  const stubbornBound = boundChildByLoopTime(stubborn, 200, { escalateAfterMs: 200, onEscalate: () => void (escalated = true) });
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => stubborn.on("exit", (_c, s) => resolve(s)));
  assert.equal(signal, "SIGKILL", "the stubborn child was escalated to SIGKILL");
  assert.equal(escalated, true);
  assert.equal(stubbornBound.timedOut, true);
});

test("without a positive budget the promise form is plain execFile", async () => {
  const { stdout } = await execFileLoopBounded(process.execPath, ["-e", PRINT_AND_EXIT(3)], { encoding: "utf8" });
  assert.equal(stdout, expectedLines(3));
  await assert.rejects(
    execFileLoopBounded(process.execPath, ["-e", "process.exit(3)"], { encoding: "utf8", timeout: 5_000 }),
    (e: unknown) => !(e instanceof LoopBoundedChildTimeout) && (e as { code?: unknown }).code === 3,
    "a child that fails inside its budget keeps execFile's own error",
  );
});

test("GH grace follows actual primary expiry after a held loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(systemClock, "now", () => now);
  const signals: Array<{ at: number; signal: NodeJS.Signals | number }> = [];
  const warnings: string[] = [];
  const child = Object.assign(new ChildProcess(), {
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals | number) { signals.push({ at: now, signal }); return true; },
  });
  const primary = boundChildByLoopTime(child, 6000, { clock: clockFromMillisFn(() => now) });
  let finish!: (out: { stdout: string; stderr: string }) => void;
  const command = Object.assign(new Promise<{ stdout: string; stderr: string }>(resolve => { finish = resolve; }), { child });
  const result = withGhKillEscalation(command, ["fixture-no-gh-call"], 6000, { graceMs: 500, warn: line => warnings.push(line) });
  try {
    now = 6550;
    t.mock.timers.tick(6550);
    assert.deepEqual(signals, [], "a held loop cannot let KILL overtake the re-armed primary");
    now = 7100;
    t.mock.timers.tick(550);
    assert.deepEqual(signals, [{ at: 7100, signal: "SIGTERM" }]);
    now = 7600;
    t.mock.timers.tick(500);
    assert.deepEqual(signals, [{ at: 7100, signal: "SIGTERM" }, { at: 7600, signal: "SIGKILL" }]);
    assert.equal(warnings.length, 1);
    assert.equal(primary.timedOut, true);
  } finally {
    primary.cancel();
    finish({ stdout: "", stderr: "" });
    await result;
    child.removeAllListeners();
  }
});

test("GH grace cancels on child exit, error, and explicit cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(systemClock, "now", () => now);
  for (const event of ["exit", "error", "cancel"] as const) {
    const signals: Array<NodeJS.Signals | number> = [];
    const child = Object.assign(new ChildProcess(), {
      exitCode: null, signalCode: null,
      kill(signal: NodeJS.Signals | number) { signals.push(signal); return true; },
    });
    const bound = boundChildByLoopTime(child, 1000);
    let finish!: (out: { stdout: string; stderr: string }) => void;
    const command = Object.assign(new Promise<{ stdout: string; stderr: string }>(resolve => { finish = resolve; }), { child });
    const result = withGhKillEscalation(command, ["fixture-no-gh-call"], 1000, { graceMs: 500, warn: () => assert.fail("cancelled escalation warned") });
    now += 1000;
    t.mock.timers.tick(1000);
    assert.deepEqual(signals, ["SIGTERM"]);
    if (event === "cancel") bound.cancel();
    else child.emit(event, event === "error" ? new Error("fixture child error") : 0);
    now += 500;
    t.mock.timers.tick(500);
    assert.deepEqual(signals, ["SIGTERM"], `${event} cancels the attached grace`);
    finish({ stdout: "", stderr: "" });
    await result;
    child.removeAllListeners();
  }
});

/** Real helper + GH wrapper, with a readiness marker and an independent hard cleanup, never a live gh call. */
async function readyGhCommand(t: TestContext, script: string) {
  const warnings: string[] = [];
  const command = execFileLoopBounded(process.execPath, ["-e", script], { encoding: "utf8", timeout: 2000 });
  const closed = new Promise<void>(resolve => command.child.once("close", () => resolve()));
  const hardCleanup = setTimeout(() => command.child.kill("SIGKILL"), 10_000);
  t.after(async () => {
    clearTimeout(hardCleanup);
    if (command.child.exitCode === null && command.child.signalCode === null) command.child.kill("SIGKILL");
    await closed;
  });
  const result = withGhKillEscalation(command, ["fixture-no-gh-call"], 2000, { graceMs: 200, warn: line => warnings.push(line) });
  // Observe rejection before waiting for readiness; an early spawn/exit failure cannot become unhandled.
  const outcome = result.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  await Promise.race([printed(command.child, "ready\n"), closed.then(() => assert.fail("child closed before readiness"))]);
  return { outcome, warnings };
}

for (const [name, handler, expectedSignal, childExitCode, warningCount] of [
  ["TERM", "", "SIGTERM", null, 0],
  ["exit zero after TERM", 'process.on("SIGTERM", () => process.exit(0));', "SIGTERM", 0, 0],
  ["ignored TERM", 'process.on("SIGTERM", () => {});', "SIGKILL", null, 1],
] as const) {
  test(`real GH-bound child preserves refusal for ${name}`, async (t) => {
    const { outcome, warnings } = await readyGhCommand(t, `${handler} process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { error, value } = await outcome;
    assert.equal(value, undefined, "a stopped child never resolves successfully");
    assert.ok(error instanceof LoopBoundedChildTimeout);
    assert.equal(error.kind, "child_process");
    assert.equal(error.exitCode, 1, "CLI refusal stays nonzero even if the child reports zero");
    assert.equal(error.code, null);
    assert.equal(error.childExitCode, childExitCode);
    assert.equal(error.signal, expectedSignal);
    assert.equal(error.stdout, "ready\n");
    assert.match(error.message, /^Command failed: /);
    assert.equal(warnings.length, warningCount);
  });
}

test("GH grace keeps spawn failures and successful output unchanged", async (t) => {
  const good = execFileLoopBounded(process.execPath, ["-e", 'process.stdout.write("complete\\n")'], { encoding: "utf8", timeout: 2000 });
  t.after(() => { if (good.child.exitCode === null && good.child.signalCode === null) good.child.kill("SIGKILL"); });
  assert.deepEqual(await withGhKillEscalation(good, ["fixture-no-gh-call"], 2000), { stdout: "complete\n", stderr: "" });
  const absent = execFileLoopBounded("/nonexistent/remudero-w9651-child", [], { encoding: "utf8", timeout: 2000 });
  await assert.rejects(withGhKillEscalation(absent, ["fixture-no-gh-call"], 2000), (error: unknown) =>
    !(error instanceof LoopBoundedChildTimeout) && (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("zero GH grace retains TERM then KILL at the same primary deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(systemClock, "now", () => now);
  const signals: Array<NodeJS.Signals | number> = [];
  const child = Object.assign(new ChildProcess(), {
    exitCode: null, signalCode: null,
    kill(signal: NodeJS.Signals | number) { signals.push(signal); return true; },
  });
  const primary = boundChildByLoopTime(child, 1000);
  let finish!: (out: { stdout: string; stderr: string }) => void;
  const command = Object.assign(new Promise<{ stdout: string; stderr: string }>(resolve => { finish = resolve; }), { child });
  const warnings: string[] = [];
  const result = withGhKillEscalation(command, ["fixture-no-gh-call"], 1000, { graceMs: 0, warn: line => warnings.push(line) });
  try {
    now = 1000;
    t.mock.timers.tick(1000);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(warnings.length, 1);
  } finally {
    primary.cancel();
    finish({ stdout: "", stderr: "" });
    await result;
    child.removeAllListeners();
  }
});
