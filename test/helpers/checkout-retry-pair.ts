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

/** The retry step's exact name. */
export const CHECKOUT_RETRY_NAME = "Retry the checkout once after a stalled fetch (W1-T13825)";
/** Every key each step may carry, and no other. */
const FIRST_KEYS = ["continue-on-error", "env", "id", "timeout-minutes", "uses", "with"];
const RETRY_KEYS = ["env", "if", "name", "timeout-minutes", "uses", "with"];
/** The retry step's exact condition. */
export const CHECKOUT_RETRY_IF = "steps.checkout.outcome == 'failure'";

/** The pinned checkout both steps must use. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
/** W1-T13321's low-speed env, which both steps keep. */
export const CHECKOUT_LOW_SPEED_ENV = { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "120" };

/** The only `with:` inputs either step may carry: the full history, nothing that picks another ref or repository. */
export const CHECKOUT_WITH = { "fetch-depth": 0 };
/** The only jobs whose pair is admitted, as `<workflow file>:<job id>`. Every other job answers to the guards in full. */
export const CHECKOUT_RETRY_JOBS: ReadonlySet<string> = new Set(["ci.yml:ci", "ci.yml:coverage-ratchet"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** True when a checkout step uses the pinned action, the full history and the low-speed env. */
function isFullPinnedCheckout(step: WorkflowStep | undefined): boolean {
  return step?.uses === CHECKOUT_ACTION && same(step.with, CHECKOUT_WITH) && same(step.env, CHECKOUT_LOW_SPEED_ENV);
}

/** The index of the first step of an admitted pair, or -1. Admitted only when the first step is `id: checkout` with
 *  timeout-minutes 3, continue-on-error true and no if:, and the next step checks out with the same inputs, only on
 *  `steps.checkout.outcome == 'failure'`, with timeout-minutes 5 and no continue-on-error. Both must use the pinned
 *  action, `with: { fetch-depth: 0 }` and nothing else, and the W1-T13321 env, and the job must be one of
 *  CHECKOUT_RETRY_JOBS. The two steps must be the job's only checkouts, carry no key beyond FIRST_KEYS and
 *  RETRY_KEYS, and the retry must be named CHECKOUT_RETRY_NAME. */
export function checkoutRetryPairIndex(job: string, steps: readonly WorkflowStep[]): number {
  if (!CHECKOUT_RETRY_JOBS.has(job)) return -1;
  const i = steps.findIndex((s) => s?.id === "checkout");
  if (i < 0) return -1;
  // The pair must be the job's only checkouts: nothing checks out before it, after it, or in between.
  const checkouts = steps.flatMap((s, at) => (typeof s?.uses === "string" && s.uses.startsWith("actions/checkout@") ? [at] : []));
  if (!same(checkouts, [i, i + 1])) return -1;
  const first = steps[i]!;
  const retry = steps[i + 1];
  if (!same(Object.keys(first).sort(), FIRST_KEYS) || !same(Object.keys(retry ?? {}).sort(), RETRY_KEYS)) return -1;
  const admitted = isFullPinnedCheckout(first) && isFullPinnedCheckout(retry) &&
    first["timeout-minutes"] === 3 && first["continue-on-error"] === true && first.if === undefined &&
    retry!.if === CHECKOUT_RETRY_IF && retry!["continue-on-error"] === undefined && retry!["timeout-minutes"] === 5 &&
    retry!.name === CHECKOUT_RETRY_NAME;
  return admitted ? i : -1;
}

/** `steps` without the admitted pair, so every other step still answers to the guard. A pair that drifts from the
 *  admitted shape is left in, and the guard then names it. */
export function withoutCheckoutRetryPair<T extends WorkflowStep>(job: string, steps: readonly T[]): T[] {
  const i = checkoutRetryPairIndex(job, steps);
  return i < 0 ? [...steps] : [...steps.slice(0, i), ...steps.slice(i + 2)];
}
