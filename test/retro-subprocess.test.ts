import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ContainedProcess, ContainedSpawnOptions } from "../src/lib/worker-containment.js";
import {
  AUTOMATED_RETRO_DECISION_ENV,
  AUTOMATED_RETRO_HEAP_LIMIT_MB,
  AUTOMATED_RETRO_OUTPUT_TAIL_BYTES,
  AutomatedRetroSubprocessError,
  decodeAutomatedRetroDecision,
  runAutomatedRetroSubprocess,
} from "../src/lib/retro-subprocess.js";
import type { RetroTriggerDecision } from "../src/lib/retro.js";

const FIRED: Extract<RetroTriggerDecision, { fire: true }> = {
  fire: true,
  reason: "days",
  mergesSinceMarker: 3,
  daysSinceMarker: Infinity,
  followupsPending: 2,
};

function fakeProcess(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
}

test("production-shaped adapter launches the current CLI in a distinct contained process with a bounded V8 heap", async () => {
  const child = fakeProcess();
  const childPid = process.pid + 10_000;
  let options: ContainedSpawnOptions | undefined;
  const tornDown: number[] = [];
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const spawn = (
    received: ContainedSpawnOptions,
  ): ContainedProcess => {
    options = received;
    queueMicrotask(() => child.emit("exit", 0, null));
    return { process: child, pid: childPid } as unknown as ContainedProcess;
  };

  await runAutomatedRetroSubprocess(FIRED, {
    spawn,
    teardown: (pid) => tornDown.push(pid),
    log: (step, extra = {}) => telemetry.push({ step, extra }),
    now: (() => { let now = 1_000; return () => (now += 25); })(),
  });

  assert.ok(options, "the contained spawn is reached");
  assert.equal(options.command, process.execPath);
  assert.ok(options.args.includes(`--max-old-space-size=${AUTOMATED_RETRO_HEAP_LIMIT_MB}`));
  assert.deepEqual(options.args.slice(-2), [expectRunTaskEntrypoint(options.args.at(-2)), "retro"]);
  assert.deepEqual(decodeAutomatedRetroDecision(options.env[AUTOMATED_RETRO_DECISION_ENV]), FIRED);
  assert.notEqual(childPid, process.pid, "the automated retro does not share the daemon pid");
  assert.deepEqual(tornDown, [childPid], "the child process group is released exactly once");
  assert.deepEqual(telemetry.map((row) => row.step), ["daemon.retro_subprocess.start", "daemon.retro_subprocess.terminal"]);
  assert.equal(telemetry[0]?.extra.child_pid, childPid);
  assert.equal(telemetry[0]?.extra.heap_limit_mb, AUTOMATED_RETRO_HEAP_LIMIT_MB);
  assert.equal(telemetry[1]?.extra.outcome, "success");
  assert.equal(telemetry[1]?.extra.exit_code, 0);
  assert.equal(telemetry[1]?.extra.duration_ms, 25);
});

function expectRunTaskEntrypoint(value: string | undefined): string {
  assert.match(value ?? "", /src\/run-task\.ts$/);
  return value!;
}

test("exit 134 emits one bounded redacted terminal row and throws a named failure", async () => {
  const child = fakeProcess();
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const secret = "sk-live-fixture-secret";
  const spawn = (
    _options: ContainedSpawnOptions,
    onStderr?: (chunk: string) => void,
  ): ContainedProcess => {
    queueMicrotask(() => {
      child.stdout.write(`${"x".repeat(AUTOMATED_RETRO_OUTPUT_TAIL_BYTES * 2)} ${secret}`);
      onStderr?.(`OPENAI_API_KEY=${secret} ${"y".repeat(AUTOMATED_RETRO_OUTPUT_TAIL_BYTES * 2)}`);
      child.emit("exit", 134, null);
    });
    return { process: child, pid: process.pid + 20_000 } as unknown as ContainedProcess;
  };

  await assert.rejects(
    runAutomatedRetroSubprocess(FIRED, {
      spawn,
      teardown: () => {},
      env: { OPENAI_API_KEY: secret },
      log: (step, extra = {}) => telemetry.push({ step, extra }),
      now: (() => { let now = 2_000; return () => (now += 50); })(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AutomatedRetroSubprocessError);
      assert.equal(error.exitCode, 134);
      assert.match(error.message, /exit 134/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  assert.deepEqual(telemetry.map((row) => row.step), ["daemon.retro_subprocess.start", "daemon.retro_subprocess.terminal"]);
  const terminal = telemetry[1]!.extra;
  assert.equal(terminal.outcome, "failure");
  assert.equal(terminal.failure_class, "nonzero_exit");
  assert.ok(Buffer.byteLength(String(terminal.stdout_tail)) <= AUTOMATED_RETRO_OUTPUT_TAIL_BYTES);
  assert.ok(Buffer.byteLength(String(terminal.stderr_tail)) <= AUTOMATED_RETRO_OUTPUT_TAIL_BYTES);
  assert.doesNotMatch(JSON.stringify(telemetry), new RegExp(secret));
});

test("a signal exit is classified distinctly and remains bounded", async () => {
  const child = fakeProcess();
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const spawn = (): ContainedProcess => {
    queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    return { process: child, pid: process.pid + 30_000 } as unknown as ContainedProcess;
  };

  await assert.rejects(
    runAutomatedRetroSubprocess(FIRED, {
      spawn,
      teardown: () => {},
      log: (step, extra = {}) => telemetry.push({ step, extra }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AutomatedRetroSubprocessError);
      assert.equal(error.signal, "SIGKILL");
      assert.match(error.message, /signal SIGKILL/);
      return true;
    },
  );
  assert.equal(telemetry[1]?.extra.failure_class, "signal");
  assert.equal(telemetry[1]?.extra.signal, "SIGKILL");
});

test("a contained spawn callback error is classified as a spawn failure and tears down its process group", async () => {
  const child = fakeProcess();
  const childPid = process.pid + 35_000;
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const tornDown: number[] = [];
  const spawn = (
    _options: ContainedSpawnOptions,
    _onStderr?: (chunk: string) => void,
    onSpawnError?: (error: NodeJS.ErrnoException) => void,
  ): ContainedProcess => {
    queueMicrotask(() => {
      const error = Object.assign(new Error("contained launch refused"), { code: "EACCES" });
      onSpawnError?.(error);
      child.emit("error", error);
    });
    return { process: child, pid: childPid } as unknown as ContainedProcess;
  };

  await assert.rejects(
    runAutomatedRetroSubprocess(FIRED, {
      spawn,
      teardown: (pid) => tornDown.push(pid),
      log: (step, extra = {}) => telemetry.push({ step, extra }),
    }),
    AutomatedRetroSubprocessError,
  );

  assert.deepEqual(tornDown, [childPid]);
  assert.equal(telemetry[1]?.extra.failure_class, "spawn_error");
  assert.equal(telemetry[1]?.extra.exit_code, null);
});

test("a teardown refusal turns an otherwise successful child into a distinct terminal failure", async () => {
  const child = fakeProcess();
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const spawn = (): ContainedProcess => {
    queueMicrotask(() => child.emit("exit", 0, null));
    return { process: child, pid: process.pid + 40_000 } as unknown as ContainedProcess;
  };

  await assert.rejects(
    runAutomatedRetroSubprocess(FIRED, {
      spawn,
      teardown: () => {
        throw new Error("process-group teardown refused");
      },
      log: (step, extra = {}) => telemetry.push({ step, extra }),
    }),
    AutomatedRetroSubprocessError,
  );

  assert.equal(telemetry[1]?.extra.outcome, "failure");
  assert.equal(telemetry[1]?.extra.failure_class, "teardown_error");
  assert.equal(telemetry[1]?.extra.exit_code, 0);
});

test("the default contained spawner produces a real short-lived child pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-child-"));
  const fixture = join(dir, "child.mjs");
  writeFileSync(fixture, "process.stdout.write(String(process.pid)); setTimeout(() => process.exit(0), 10);\n");
  const telemetry: Array<{ step: string; extra: Record<string, unknown> }> = [];
  try {
    await runAutomatedRetroSubprocess(FIRED, {
      entrypoint: fixture,
      log: (step, extra = {}) => telemetry.push({ step, extra }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const childPid = Number(telemetry[0]?.extra.child_pid);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.notEqual(childPid, process.pid);
  assert.equal(telemetry[1]?.extra.outcome, "success");
});
