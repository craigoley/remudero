import { execFile, spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { clockFromMillisFn, type Clock } from "./clock.js";

/** The sub-millisecond reading a spawn's loop time is measured with, through the Clock port. */
const monotonicClock = (): Clock => clockFromMillisFn(() => performance.now());

/**
 * W1-T9754 — A SMALL LONG-LIVED PROCESS THAT FORKS ON THE DAEMON'S BEHALF.
 *
 * The synchronous part of a child spawn (the fork copying the parent's page tables) runs on the calling thread and
 * grows with the parent's resident size: measured on this host, p50 2 ms at 50 MB, 87 ms at 587 MB, 161 ms at 1.1 GB.
 * The daemon runs at 1.5-2 GB and awaits hundreds of children a landing pass. The helper is one node process started
 * once, with a small heap: the daemon writes a request line to its stdin, the helper forks, and the answer comes back
 * on its stdout, so the fork costs the helper's size and the daemon's loop pays only a pipe write.
 *
 * Any doubt falls back to a direct spawn and the result names why. A request already written when the helper dies is
 * never re-run: it may have had an effect, so it settles as failed with `helper_died_in_flight`.
 */

export type SpawnVia = "helper" | "direct";

export interface SpawnRequest {
  file: string;
  args?: readonly string[];
  cwd?: string;
  /** The child's whole environment; absent means this process's own at call time, exactly as a direct spawn. */
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  maxBuffer?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** A spawn that never produced an exit: `ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, `helper_died_in_flight`. */
  error?: string;
  via: SpawnVia;
  /** Why a request meant for the helper ran directly. */
  reason?: string;
  /** The time the call held this process's loop before it returned. */
  sync_ms: number;
}

export interface SpawnHelper {
  readonly pid: number | undefined;
  /** Undefined while the helper can take a request; otherwise why it cannot. */
  unhealthy(): string | undefined;
  run(request: SpawnRequest): Promise<SpawnResult>;
  stop(): void;
}

export interface SpawnHelperOptions {
  /** Each routed spawn's row: `spawn.routed` with `via`, its synchronous loop ms and any fallback reason. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** The helper's old-space ceiling, in MB. Its resident size is what it touches, not this bound. */
  heapMb?: number;
  /** The monotonic reading `sync_ms` is measured with; absent, `performance.now()`. */
  clock?: Clock;
  /** The helper's program; absent, {@link HELPER_SOURCE}. A test seam for a helper that dies or garbles. */
  source?: string;
}

/** The helper's whole program: CommonJS on `node -e`, so it loads nothing from this repository. */
export const HELPER_SOURCE = String.raw`
const cp = require("node:child_process");
const rl = require("node:readline").createInterface({ input: process.stdin });
const b64 = (v) => Buffer.isBuffer(v) ? v.toString("base64") : Buffer.from(String(v ?? "")).toString("base64");
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch (error) {
    return; /* Reason: the parent writes only JSON lines; a line with no id has no request to answer. */
  }
  const answer = (err, stdout, stderr) => process.stdout.write(JSON.stringify({ id: req.id,
    code: err ? err.code : 0, signal: err ? err.signal ?? null : null, stdout: b64(stdout), stderr: b64(stderr) }) + "\n");
  let child;
  try {
    child = cp.execFile(req.file, req.args, { cwd: req.cwd, env: req.env, timeout: req.timeoutMs,
      killSignal: req.killSignal, maxBuffer: req.maxBuffer, encoding: "buffer" }, answer);
  } catch (error) {
    answer(error, "", ""); /* Reason: a spawn that throws settles as that error, as execFile's own does. */
  }
  if (!child) return;
  child.stdin?.on("error", () => {});
  child.stdin?.end(req.input === undefined ? undefined : Buffer.from(req.input, "base64"));
});
rl.on("close", () => process.exit(0));
`;

const decode = (text: unknown): string => Buffer.from(String(text ?? ""), "base64").toString("utf8");

/** One shape for both paths: execFile's error carries a numeric exit code, or a string code when nothing exited. */
function settled(code: unknown, signal: unknown, stdout: string, stderr: string):
  Pick<SpawnResult, "exitCode" | "signal" | "stdout" | "stderr" | "error"> {
  const out: Pick<SpawnResult, "exitCode" | "signal" | "stdout" | "stderr" | "error"> = {
    exitCode: code === undefined || code === null ? (signal ? null : 0) : typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? signal as NodeJS.Signals : null, stdout, stderr };
  if (typeof code === "string") out.error = code;
  return out;
}

/** The direct path, the one every fallback takes: a spawn from this process, its fork on this loop. */
export function runDirect(request: SpawnRequest, clock: Clock = monotonicClock(), reason?: string):
  Promise<SpawnResult> {
  const now = clock.now;
  const began = now();
  let syncMs = 0;
  return new Promise((resolve) => {
    const answer = (err: (Error & { code?: unknown; signal?: unknown }) | null, stdout: unknown, stderr: unknown): void =>
      resolve({ ...settled(err?.code, err?.signal, String(stdout ?? ""), String(stderr ?? "")), via: "direct",
        ...(reason === undefined ? {} : { reason }), sync_ms: syncMs });
    let child: ChildProcess;
    try {
      child = execFile(request.file, [...(request.args ?? [])], { cwd: request.cwd, env: request.env,
        timeout: request.timeoutMs, killSignal: request.killSignal, maxBuffer: request.maxBuffer, encoding: "utf8" },
      answer);
    } catch (error) {
      // Reason: execFile throws on an argument it refuses; that settles as its error code, never as a throw.
      syncMs = now() - began;
      answer(error as Error & { code?: unknown }, "", "");
      return;
    }
    child.stdin?.on("error", () => { /* Reason: a child that exits before reading its input settles by its exit. */ });
    child.stdin?.end(request.input);
    syncMs = now() - began;
  });
}

type Pending = { resolve: (result: SpawnResult) => void; syncMs: number };

/** Start the helper once; every `run` after that writes one line and awaits one answer. */
export function startSpawnHelper(options: SpawnHelperOptions = {}): SpawnHelper {
  const clock = options.clock ?? monotonicClock();
  const now = clock.now;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let dead: string | undefined;
  // The one fork this process pays for the helper, at boot while the daemon is still small.
  const child = spawn(process.execPath, [`--max-old-space-size=${options.heapMb ?? 256}`, "-e",
    options.source ?? HELPER_SOURCE], { stdio: ["pipe", "pipe", "ignore"] });
  const refs = (): void => {
    const ref = pending.size > 0 ? "ref" : "unref";
    child[ref]();
    (child.stdout as unknown as { [k: string]: (() => void) | undefined } | null)?.[ref]?.();
    (child.stdin as unknown as { [k: string]: (() => void) | undefined } | null)?.[ref]?.();
  };
  const die = (why: string): void => {
    dead ??= why;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", error: "helper_died_in_flight",
        via: "helper", reason: dead, sync_ms: waiting.syncMs });
    }
    refs();
  };
  child.on("error", (error) => die(`helper_error: ${String(error?.message ?? error).slice(0, 120)}`));
  child.on("exit", (code, signal) => die(`helper_exited: ${signal ?? code}`));
  child.stdin?.on("error", (error) => die(`helper_stdin_closed: ${String(error?.message ?? error).slice(0, 120)}`));
  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      let answer: { id?: number; code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
      try { answer = JSON.parse(line); } catch (error) {
        // Reason: an unreadable answer means the protocol is lost; every waiting request is failed and named.
        die(`helper_garbled: ${String((error as Error)?.message ?? error).slice(0, 80)}`);
        return;
      }
      const waiting = pending.get(Number(answer.id));
      if (!waiting) return;
      pending.delete(Number(answer.id));
      refs();
      waiting.resolve({ ...settled(answer.code, answer.signal, decode(answer.stdout), decode(answer.stderr)),
        via: "helper", sync_ms: waiting.syncMs });
    });
  }
  refs();
  function routed(result: Promise<SpawnResult>, file: string): Promise<SpawnResult> {
    const log = options.log;
    if (!log) return result;
    return result.then((settledResult) => {
      try {
        log("spawn.routed", { via: settledResult.via, sync_ms: Math.round(settledResult.sync_ms * 100) / 100,
          command: file.split("/").pop(),
          ...(settledResult.reason === undefined ? {} : { reason: settledResult.reason }) });
      } catch (error) {
        void error; // Reason: the row is observability; a throwing logger must never cost the spawn's result.
      }
      return settledResult;
    });
  }
  const unhealthy = (): string | undefined =>
    dead ?? (child.stdin && !child.stdin.destroyed && child.stdin.writable ? undefined : "helper_stdin_closed");
  return {
    pid: child.pid,
    unhealthy,
    run(request) {
      const began = now();
      const why = unhealthy();
      if (why !== undefined) return routed(runDirect(request, clock, why), request.file);
      const id = nextId++;
      const line = JSON.stringify({ id, file: request.file, args: request.args ?? [], cwd: request.cwd,
        env: request.env ?? process.env, timeoutMs: request.timeoutMs, killSignal: request.killSignal,
        maxBuffer: request.maxBuffer,
        input: request.input === undefined ? undefined : Buffer.from(request.input).toString("base64") });
      return routed(new Promise<SpawnResult>((resolve) => {
        const waiting: Pending = { resolve, syncMs: 0 };
        pending.set(id, waiting);
        refs();
        child.stdin?.write(`${line}\n`);
        waiting.syncMs = now() - began;
      }), request.file);
    },
    stop() {
      die("helper_stopped");
      child.stdin?.end();
      child.kill();
    },
  };
}

let installed: SpawnHelper | undefined;

/** The daemon's one helper, installed at boot (W1-T9754); a caller that awaits a child routes through it. */
export function installSpawnHelper(helper: SpawnHelper | undefined): void {
  installed = helper;
}

/** The helper {@link installSpawnHelper} holds, if any. */
export function installedSpawnHelper(): SpawnHelper | undefined {
  return installed;
}

/** Through the installed helper while it is healthy; otherwise a direct spawn whose result names why. */
export function runRouted(request: SpawnRequest): Promise<SpawnResult> {
  return installed ? installed.run(request) : runDirect(request, undefined, "helper_not_installed");
}
