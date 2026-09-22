// W1-T4063 — EXIT ONLY AFTER THE OUTPUT HAS LEFT THE PROCESS.
//
// `process.exit()` ends the process with whatever is still queued on stdout/stderr unwritten. On POSIX a
// PIPE is written asynchronously, so a verb that prints more than the pipe's buffer and then exits loses the
// tail — silently, with exit code 0. MEASURED 2026-09-22: `rmd ledger-grep` delivered 522 of 280,672 lines
// through a pipe and all of them to a file. A file or TTY is written synchronously, which is why no
// interactive check ever saw it. This helper is the one process boundary every CLI exit goes through.

import type { Writable } from "node:stream";

export interface FlushExitDeps {
  streams?: readonly Writable[];
  /** Read at call time, so a test that stubs `process.exit` is honoured. */
  exit?: (code: number) => never;
}

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

/** Flush stdout and stderr, then exit with `code`. */
export async function flushThenExit(code: number, deps: FlushExitDeps = {}): Promise<never> {
  const streams = deps.streams ?? [process.stdout, process.stderr];
  await Promise.all(streams.map((stream) => drained(stream)));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  return exit(code);
}
