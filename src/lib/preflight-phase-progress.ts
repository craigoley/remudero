import { performance } from "node:perf_hooks";
import { clockFromMillisFn, type Clock } from "./clock.js";

export interface PreflightPhaseEvent {
  step: "preflight.phase";
  phaseId: number;
  phase: string;
  event: "started" | "returned" | "threw";
  durationMs: number | null;
  trainingEligible: false;
}

/** Data only: an observer never receives the check closure, arguments, environment or result. */
export type PreflightPhaseReporter = (event: Readonly<PreflightPhaseEvent>) => unknown;
let nextPhaseId = 0;

function samplePreflightPhaseClock(clock: Clock): number | null {
  try { const value = clock.now(); return Number.isFinite(value) ? value : null; }
  catch {
    // A failed clock is unknown elapsed cost, never a measured zero or a check verdict.
    return null;
  }
}

function emitPreflightPhaseEvent(report: PreflightPhaseReporter, event: PreflightPhaseEvent): void {
  try {
    const pending = report(Object.freeze(event));
    // TypeScript's void-return convention also admits async observers. Their rejection is
    // missing telemetry, not an unhandled rejection allowed to overturn the check verdict.
    if (pending && typeof (pending as PromiseLike<unknown>).then === "function")
      void Promise.resolve(pending).catch(() => {
        // A rejected diagnostic is missing telemetry; only the original check owns its verdict.
      });
  } catch { /* Diagnostic failure must not skip a check or replace its result/error. */ }
}

/** Synchronous phase observation only, never an async-completion or resource-admission proof. */
export function observeSynchronousPreflightPhase<T>(
  phase: string, run: () => T, report?: PreflightPhaseReporter,
  clock: Clock = clockFromMillisFn(() => performance.now()),
): T {
  if (report === undefined) return run();
  const phaseId = ++nextPhaseId;
  const started = samplePreflightPhaseClock(clock);
  emitPreflightPhaseEvent(report, {step: "preflight.phase", phaseId, phase, event: "started", durationMs: null, trainingEligible: false});
  let returned = false;
  try {
    const result = run();
    returned = true;
    return result;
  } finally {
    const finished = samplePreflightPhaseClock(clock);
    const delta = started !== null && finished !== null ? finished - started : NaN;
    const rounded = Math.ceil(delta);
    const durationMs = Number.isFinite(delta) && delta >= 0 && Number.isSafeInteger(rounded) ? rounded : null;
    emitPreflightPhaseEvent(report, {step: "preflight.phase", phaseId, phase, event: returned ? "returned" : "threw", durationMs, trainingEligible: false});
  }
}

/** One bounded data line before blocking work; no argv, output, error payload or credentials. */
export function reportPreflightPhase(event: Readonly<PreflightPhaseEvent>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
