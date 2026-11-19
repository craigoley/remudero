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

/** The pinned checkout both steps must use. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
/** W1-T13321's low-speed env, which both steps keep. */
export const CHECKOUT_LOW_SPEED_ENV = { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "120" };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** True when a checkout step uses the pinned action, the full history and the low-speed env. */
function isFullPinnedCheckout(step: WorkflowStep | undefined): boolean {
  return step?.uses === CHECKOUT_ACTION && step.with?.["fetch-depth"] === 0 && same(step.env, CHECKOUT_LOW_SPEED_ENV);
}

/** The index of the first step of an admitted pair, or -1. Admitted only when the first step is `id: checkout` with
 *  timeout-minutes 3, continue-on-error true and no if:, and the next step checks out with the same inputs, only on
 *  `steps.checkout.outcome == 'failure'`, with timeout-minutes 5 and no continue-on-error. Both must use the pinned
 *  action, fetch-depth 0 and the W1-T13321 env. */
export function checkoutRetryPairIndex(steps: readonly WorkflowStep[]): number {
  const i = steps.findIndex((s) => s?.id === "checkout");
  if (i < 0) return -1;
  const first = steps[i]!;
  const retry = steps[i + 1];
  const admitted = isFullPinnedCheckout(first) && isFullPinnedCheckout(retry) &&
    first["timeout-minutes"] === 3 && first["continue-on-error"] === true && first.if === undefined &&
    retry!.if === CHECKOUT_RETRY_IF && retry!["continue-on-error"] === undefined && retry!["timeout-minutes"] === 5 &&
    retry!.id === undefined && retry!.run === undefined && same(retry!.with, first.with);
  return admitted ? i : -1;
}

/** `steps` without the admitted pair, so every other step still answers to the guard. A pair that drifts from the
 *  admitted shape is left in, and the guard then names it. */
export function withoutCheckoutRetryPair<T extends WorkflowStep>(steps: readonly T[]): T[] {
  const i = checkoutRetryPairIndex(steps);
  return i < 0 ? [...steps] : [...steps.slice(0, i), ...steps.slice(i + 2)];
}
