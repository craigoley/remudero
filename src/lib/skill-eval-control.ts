import { systemClock, type Clock } from "./clock.js";

export interface SkillEvalControlInput {
  /** Fixed approved finish boundary; progress and retries cannot renew it. */
  finishByMs: number;
  shutdownReserveMs: number;
  signal?: AbortSignal;
  clock?: Clock;
}
export interface SkillEvalControl {
  readonly signal: AbortSignal;
  checkpoint(): boolean;
  dispose(): void;
}
/** BACKSTOP: cooperative polling of a fixed deadline, not proof of descendant termination. */
export const SKILL_EVAL_CONTROL_POLL_MS = 100;

/** Absent input is inert. This cancels the entire attempt loop, not an inactivity clock.
 * It is NOT a process-tree boundary. No caller may release capacity on this signal alone. */
export function createSkillEvalControl(input?: SkillEvalControlInput): SkillEvalControl | undefined {
  if (input === undefined) return undefined;
  const { finishByMs, shutdownReserveMs, signal } = input, clock = input.clock ?? systemClock;
  if (!Number.isSafeInteger(finishByMs) || finishByMs < 0 || !Number.isSafeInteger(shutdownReserveMs) ||
      shutdownReserveMs <= 0 || finishByMs < shutdownReserveMs) throw new Error("invalid fixed eval deadline/shutdown reserve");
  const controller = new AbortController();
  const cancel = (): void => { controller.abort("operator-cancellation"); };
  const checkpoint = (): boolean => {
    try {
      const now = clock.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("eval clock unavailable");
      if (now >= finishByMs - shutdownReserveMs) controller.abort("fixed-eval-shutdown-deadline");
    } catch { controller.abort("eval-deadline-observation-unavailable"); }
    return !controller.signal.aborted;
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  checkpoint();
  const timer = setInterval(checkpoint, SKILL_EVAL_CONTROL_POLL_MS);
  timer.unref();
  return { signal: controller.signal, checkpoint, dispose: () => { clearInterval(timer);signal?.removeEventListener("abort", cancel); } };
}
