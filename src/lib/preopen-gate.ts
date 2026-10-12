/**
 * THE HARNESS ASKS THE FAST GATE BEFORE IT OPENS A BUILD'S PULL REQUEST.
 *
 * A worker's own `rmd preflight --fast` is advisory: `preflightFailureNotice` only reports it. On
 * 2026-10-09 four fleet builds opened PRs carrying reds that gate names in seconds — #10482
 * (depcruise cycle, bound-kind, ledger-rotation, reach ratchet), #10491 (catch-erasure,
 * ledger-rotation, reach ratchet), #10516 (env-registry) — and each cost one or more fix rounds.
 * This module runs the same gate as a child process (never on the daemon's event loop), reads its
 * durable summary back, and names the failing steps so the worker can be handed them before the PR
 * opens.
 *
 * Only the census/ratchet fast gate runs here, not the selector's neighbouring suites: those take
 * minutes per build and already run under CI; the fast gate is the set a build can satisfy alone.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { preflightSummaryPath } from "./ci-parity.js";
import { systemClock, type Clock } from "./clock.js";

export const PREOPEN_GATE_STEP = "implement.preopen_gate";

/** BACKSTOP only: a gate that has not answered by then is reported unmeasured, never a pass. */
export const PREOPEN_GATE_BACKSTOP_MS = 15 * 60_000;

export type PreopenGateResult =
  | { kind: "pass"; durationMs: number }
  | { kind: "fail"; failedSteps: string[]; durationMs: number }
  | { kind: "unmeasured"; reason: string; durationMs: number };

export interface PreopenGateOptions {
  /** Runs the fast gate in `cwd`; resolves when the child exits, whatever its status. */
  runGate?: (cwd: string) => Promise<{ exitCode: number | null; error?: string }>;
  readFile?: (path: string) => string;
  clock?: Clock;
}

function defaultRunGate(cwd: string): Promise<{ exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    execFile(join(cwd, "bin", "rmd"), ["preflight", "--fast"], { cwd, timeout: PREOPEN_GATE_BACKSTOP_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, _stderr) => {
        if (!error) return resolve({ exitCode: 0 });
        const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
        const killed = (error as { killed?: boolean }).killed === true;
        resolve({ exitCode: code, ...(code === null || killed ? { error: killed ? "fast gate exceeded its backstop" : error.message } : {}) });
      });
  });
}

/** The failing step names recorded by a summary written at or after `startedAt`, or why it can't be read. */
export function readGateSummary(
  worktreePath: string,
  startedAt: number,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { failedSteps: string[] } | { unreadable: string } {
  let parsed: { ok?: unknown; finishedAt?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(readFile(preflightSummaryPath(worktreePath))) as typeof parsed;
  } catch (e) {
    return { unreadable: `no readable preflight summary (${(e as Error).message})` };
  }
  const finished = typeof parsed.finishedAt === "string" ? Date.parse(parsed.finishedAt) : NaN;
  if (!Number.isFinite(finished) || finished < startedAt) return { unreadable: "the preflight summary predates this gate run" };
  const steps = Array.isArray(parsed.steps) ? (parsed.steps as Array<{ name?: unknown; ok?: unknown }>) : [];
  const failedSteps = steps.filter((s) => s && s.ok === false).map((s) => (typeof s.name === "string" && s.name ? s.name : "(unnamed step)"));
  if (parsed.ok === false && failedSteps.length === 0) return { failedSteps: ["(summary reported FAIL with no step named)"] };
  return { failedSteps };
}

/** Run the fast gate in a build's worktree and classify the result. */
export async function runPreopenGate(worktreePath: string, deps: PreopenGateOptions = {}): Promise<PreopenGateResult> {
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const startedAt = now();
  const run = await (deps.runGate ?? defaultRunGate)(worktreePath);
  const durationMs = now() - startedAt;
  if (run.error !== undefined) return { kind: "unmeasured", reason: run.error, durationMs };
  const read = readGateSummary(worktreePath, startedAt, deps.readFile);
  if ("unreadable" in read) return { kind: "unmeasured", reason: read.unreadable, durationMs };
  if (read.failedSteps.length === 0) return { kind: "pass", durationMs };
  return { kind: "fail", failedSteps: read.failedSteps, durationMs };
}

/** The continuation prompt that hands a worker the fast-gate steps its tree fails. */
export function renderPreopenGatePrompt(failedSteps: readonly string[], harnessOwnsGit: boolean): string {
  return [
    "Before your pull request opens, the harness ran `rmd preflight --fast` on your tree and these steps FAILED:",
    ...failedSteps.map((s) => `  - ${s}`),
    "",
    "Fix each one in your own change (never by lowering a baseline your change did not move), then re-run",
    "`rmd preflight --fast` until it passes.",
    harnessOwnsGit
      ? "Leave your edits in the worktree; the harness commits them."
      : "Commit the fixes with a proper conventional-commit subject (not a wip checkpoint).",
  ].join("\n");
}
