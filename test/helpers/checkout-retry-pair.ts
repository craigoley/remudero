// W1-T13825: the one step shape the no-continue-on-error and no-step-if: guards admit.
// A shard's first checkout is bounded at 3 minutes and may fail without failing the job; the step right after it
// re-runs the same checkout only when the first one failed, and has no continue-on-error, so a second failure still
// fails the job. Skipping that retry step never skips the job, so the #729 deadlock (a skipped REQUIRED check)
// cannot arise from it. Craig approved admitting exactly this pair on 2026-11-19.

export interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/** The retry step's exact condition. */
export const CHECKOUT_RETRY_IF = "steps.checkout.outcome == 'failure'";

function isCheckout(step: WorkflowStep | undefined): boolean {
  return typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@");
}

/** The index of the first step of an admitted pair, or -1. Admitted only when the first step is `id: checkout`
 *  with timeout-minutes 3, continue-on-error true and no if:, and the next step checks out the same action with
 *  the same inputs, only on `steps.checkout.outcome == 'failure'`, with a timeout and no continue-on-error. */
export function checkoutRetryPairIndex(steps: readonly WorkflowStep[]): number {
  const i = steps.findIndex((s) => s?.id === "checkout");
  if (i < 0) return -1;
  const first = steps[i]!;
  const retry = steps[i + 1];
  const admitted = isCheckout(first) && first["timeout-minutes"] === 3 && first["continue-on-error"] === true &&
    first.if === undefined && retry !== undefined && retry.uses === first.uses && retry.if === CHECKOUT_RETRY_IF &&
    retry["continue-on-error"] === undefined && typeof retry["timeout-minutes"] === "number" &&
    JSON.stringify(retry.with ?? {}) === JSON.stringify(first.with ?? {});
  return admitted ? i : -1;
}

/** `steps` without the admitted pair, so every other step still answers to the guard. A pair that drifts from the
 *  admitted shape is left in, and the guard then names it. */
export function withoutCheckoutRetryPair<T extends WorkflowStep>(steps: readonly T[]): T[] {
  const i = checkoutRetryPairIndex(steps);
  return i < 0 ? [...steps] : [...steps.slice(0, i), ...steps.slice(i + 2)];
}
