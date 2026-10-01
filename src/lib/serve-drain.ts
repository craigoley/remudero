/**
 * Drain v2 (arch-phase3-design.md §1, §4): how serve stops without resetting a request.
 *
 * `http.Server.close()` runs `closeIdleConnections()` at once. That races a keep-alive client
 * already sending its next request on an idle socket: the client sees ECONNRESET, and a POST is
 * not retried by cloudflared. The prototype measured 74 resets (17 POSTs) across 5 swaps, even
 * with a perfect socket handoff. This drain instead:
 *   1. stops accepting at the NET level, so queued connections stay with the listener;
 *   2. answers every request for a short grace with `Connection: close`, so clients retire their
 *      own sockets; only then sweeps the idle ones;
 *   3. ends every open stream with a `handover` event and answers a NEW stream with one at once,
 *      so a reconnect cannot pin the draining process to its bound.
 * A request in flight is never cut before the bound, which is a backstop for a hung connection.
 *
 * {@link exitWithin} bounds the exit itself. `process.exit` joins every worker thread, and a worker
 * blocked inside a native call (a long SQLite statement) cannot be interrupted: measured 26.7 s
 * for one 300M-row query, against 0.1 s for a JS loop. Only a SIGKILL from outside escapes that.
 */
import { spawn } from "node:child_process";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Server as NetServer } from "node:net";
import { systemClock, type Clock } from "./clock.js";
import type { Route, SseRoute, SseSend } from "./service.js";

/** Long enough that a client mid-loop sends one more request and reads `Connection: close`. */
export const SERVE_DRAIN_CLOSE_GRACE_MS = 1_000;
/** A backstop on a wedged exit only: a healthy `process.exit` takes milliseconds. */
export const SERVE_EXIT_DEADLINE_MS = 5_000;
const DRAIN_IDLE_SWEEP_MS = 50;

export type DrainOutcome = "closed" | "bound";

export interface ServeDrainOptions {
  /** The backstop for a connection that never ends by itself. */
  boundMs: number;
  graceMs?: number;
  clock?: Clock;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  schedule?: (run: () => void, ms: number) => () => void;
}

export interface ServeDrain {
  draining(): boolean;
  /** Ends an open stream with `handover` at drain start; a stream opened during the drain gets one at once. */
  wrapSse(route: SseRoute): SseRoute;
  /** A stream served as a plain route (the view events stream): refused with `handover` during the drain. */
  wrapStream(route: Route): Route;
  /** Install on the built server BEFORE it listens, so every in-flight response is known at drain start. */
  attach(server: Server): void;
  /** Resolves at once when nothing was attached. */
  drain(reason: string): Promise<DrainOutcome>;
}

function handoverFrame(reason: string): string {
  return `event: handover\ndata: ${JSON.stringify({ reason, retryMs: 0 })}\n\n`;
}

function unrefTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function retire(res: ServerResponse): void {
  if (!res.headersSent) res.setHeader("connection", "close");
}

export function createServeDrain(opts: ServeDrainOptions): ServeDrain {
  const clock = opts.clock ?? systemClock;
  const schedule = opts.schedule ?? unrefTimer;
  const graceMs = opts.graceMs ?? SERVE_DRAIN_CLOSE_GRACE_MS;
  const inFlight = new Set<ServerResponse>();
  const streams = new Set<SseSend>();
  let reason: string | undefined;
  let draining: Promise<DrainOutcome> | undefined;
  let server: Server | undefined;

  const endStream = (send: SseSend, why: string): void => {
    if (send.end) send.end("handover", { reason: why, retryMs: 0 });
    else send("handover", { reason: why, retryMs: 0 });
  };

  const drain = (why: string): Promise<DrainOutcome> => {
    if (draining) return draining;
    reason = why;
    const startedAt = clock.now();
    for (const res of inFlight) retire(res);
    inFlight.clear();
    for (const send of [...streams]) endStream(send, why);
    streams.clear();
    opts.log?.("serve.drain_phase", { phase: "start", reason: why, graceMs, boundMs: opts.boundMs });
    const target = server;
    if (!target) return (draining = Promise.resolve("closed"));
    draining = new Promise((resolve) => {
      let sweep: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const finish = (outcome: DrainOutcome): void => {
        if (done) return;
        done = true;
        cancelGrace();
        cancelBound();
        clearInterval(sweep);
        opts.log?.("serve.drain_phase", { phase: "done", reason: why, outcome, ms: clock.now() - startedAt });
        resolve(outcome);
      };
      const cancelBound = schedule(() => {
        target.closeAllConnections();
        finish("bound");
      }, opts.boundMs);
      const cancelGrace = schedule(() => {
        target.closeIdleConnections();
        sweep = setInterval(() => target.closeIdleConnections(), DRAIN_IDLE_SWEEP_MS);
        sweep.unref?.();
      }, graceMs);
      // NET-level close: http's own close() would sweep idle keep-alive sockets now, mid-race.
      NetServer.prototype.close.call(target, () => finish("closed"));
    });
    return draining;
  };

  return {
    draining: () => reason !== undefined,
    wrapSse: (route) => ({
      ...route,
      subscribe: (send, req) => {
        if (reason !== undefined) {
          endStream(send, reason);
          return () => {};
        }
        streams.add(send);
        const unsubscribe = route.subscribe(send, req);
        return () => {
          streams.delete(send);
          unsubscribe();
        };
      },
    }),
    wrapStream: (route) => ({
      ...route,
      handler: (req, res, ctx) => {
        if (reason === undefined) return route.handler(req, res, ctx);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
        res.end(handoverFrame(reason));
      },
    }),
    attach: (built) => {
      server = built;
      built.prependListener("request", (_req: IncomingMessage, res: ServerResponse) => {
        if (reason !== undefined) return retire(res);
        inFlight.add(res);
        res.once("close", () => inFlight.delete(res));
      });
    },
    drain,
  };
}

/** A watchdog in its own process: it SIGKILLs `pid` after `ms` unless `pid` already died (so it is no longer the parent). */
export const EXIT_WATCHDOG_SCRIPT = [
  "const [pid, ms] = process.argv.slice(1).map(Number);",
  "setTimeout(() => {",
  "  if (process.ppid !== pid) return;",
  "  process.stderr.write(`rmd serve: exit still blocked after ${ms} ms (a worker thread in a native call); SIGKILL ${pid}\\n`);",
  "  process.kill(pid, 'SIGKILL');",
  "}, ms);",
].join("\n");

export interface ExitWithinIo {
  exit: (code: number) => void;
  pid: number;
  execPath: string;
  spawnWatchdog: (execPath: string, args: string[]) => { unref(): void };
}

const processExitIo: ExitWithinIo = {
  exit: (code) => process.exit(code),
  pid: process.pid,
  execPath: process.execPath,
  spawnWatchdog: (execPath, args) => spawn(execPath, args, { stdio: ["ignore", "ignore", "inherit"] }),
};

/** `process.exit(code)`, with a deadline: arm the out-of-process watchdog first, because exit blocks the loop. */
export function exitWithin(code: number, deadlineMs: number = SERVE_EXIT_DEADLINE_MS, io: ExitWithinIo = processExitIo): void {
  io.spawnWatchdog(io.execPath, ["-e", EXIT_WATCHDOG_SCRIPT, String(io.pid), String(deadlineMs)]).unref();
  io.exit(code);
}
