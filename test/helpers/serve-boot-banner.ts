import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { assertWallClockBound } from "./wall-clock-bound.js";

// ── W1-T6031: a serve child's boot wait names its own timeout ──────────────────────────────────
//
// The suites that spawn a REAL `rmd serve` wait for "listening on" in its redirected log and then
// assert on that log's content. Each kept that wait as a fixed inline deadline, so a child that
// was simply still BOOTING when it ran out failed as whatever content assertion came next ("the
// child must visibly reach the refusal") — a guard regression on its face. MEASURED 2026-10-06 on
// the loaded fleet host: boots of 3.6–148.7s, every one healthy once it finished, against 4.7s on
// CI. This is the one wait those suites share, and its deadline is declared through
// assertWallClockBound so a timeout says it is wall-clock dependent.
//
// Three outcomes, kept apart because their remedies differ:
//   - the banner appears          → the log is returned for the caller's own assertions;
//   - the child exits before it   → a real failure, reported at once as an exit with the log;
//   - the bound passes, child up  → assertWallClockBound's WALL-CLOCK DEPENDENT failure.

/** The slice of a ChildProcess this wait reads — a fake child in a test supplies only this. */
export interface ServeChildState {
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

const readLog = (logPath: string): string => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");

/** Resolve with the log once it holds "listening on"; see the outcomes above for every other end. */
export async function waitForServeBanner(
  logPath: string,
  child: ServeChildState,
  boundMs: number,
  pollMs = 200,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const log = readLog(logPath);
    if (log.includes("listening on")) return log;
    if (child.exitCode !== null || (child.signalCode ?? null) !== null) {
      // Re-read: a child can print its banner and exit between the read above and this check.
      const finalLog = readLog(logPath);
      if (finalLog.includes("listening on")) return finalLog;
      assert.fail(
        `serve exited (code ${child.exitCode}, signal ${child.signalCode ?? null}) before printing its banner. Log:\n${finalLog}`,
      );
    }
    assertWallClockBound(
      Date.now() - startedAt,
      boundMs,
      `serve child did not print its banner within ${boundMs}ms and is still running. Log:\n${log}`,
    );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
