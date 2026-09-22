// W1-T4063 — EXIT ONLY AFTER THE OUTPUT HAS LEFT THE PROCESS.
//
// `process.exit()` ends the process with whatever is still queued on stdout/stderr unwritten. On POSIX a
// PIPE is written asynchronously, so a verb that prints more than the pipe's buffer and then exits loses the
// tail — silently, with exit code 0. MEASURED 2026-09-22: `rmd ledger-grep` delivered 522 of 280,672 lines
// through a pipe and all of them to a file. A file or TTY is written synchronously, which is why no
// interactive check ever saw it. This helper is the one process boundary every CLI exit goes through.

import type { Writable } from "node:stream";

/** Resolve once every byte already written to `stream` has been handed to the OS — or immediately when
 *  the stream can no longer deliver anything (destroyed, ended, or its reader went away: EPIPE). A reader
 *  that closes early (`rmd … | head`) must never keep the process alive. */
export function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded || !stream.writable) {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      stream.off("error", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("error", done);
    stream.once("close", done);
    try {
      // A zero-length write's callback fires after every earlier write has been flushed: writes on one
      // stream complete in order.
      stream.write("", () => done());
    } catch {
      // deliberate: a write that throws means the stream cannot deliver anything more (ERR_STREAM_DESTROYED,
      // a synchronous EPIPE) — there is nothing left to wait for, so the exit proceeds.
      done();
    }
  });
}

/**
 * Flush stdout and stderr, then exit with `code`.
 *
 * NO INJECTION SEAM, deliberately. A `FlushExitDeps` shape here was never constructed by anything —
 * `deps-interface-census` counts all three spellings -- the named shape, the inline object literal
 * and the `*Seams` alias -- against a
 * baseline that cannot grow, and its remedy is to reuse a seam or move the wiring to the boundary,
 * not to rename the shape. There is nothing to reuse: the only other `exit` seams belong to
 * self-sync and serve. So the wiring stays at the boundary, and it costs no testability — the
 * substance is {@link drained}, which takes any `Writable`, and the streams are read HERE at call
 * time, so a test that stubs `process.exit` or replaces a stream is still honoured. The suite that
 * proves this drives a real child process through a slow pipe rather than stubbing either one.
 */
export async function flushThenExit(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) => drained(stream)));
  return process.exit(code);
}
