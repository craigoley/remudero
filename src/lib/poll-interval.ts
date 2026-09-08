/**
 * `DEFAULT_POLL_INTERVAL_MS` — split out of `daemon.ts` (W1-T2895) so the constant lives in a
 * LEAF module. `daemon-health.ts` imports `daemon.ts` TYPE-ONLY (`GhRateLimitBuckets`) precisely
 * because a VALUE import back would be a genuine two-module cycle — see `daemon-health.ts`'s own
 * `isBucketExhausted` comment. Importing the value from here instead of from `daemon.ts` removes
 * that value edge, so the type-only edge no longer closes a loop.
 */

/** Default idle-poll pace: check back once a minute while nothing is runnable. The literal stays
 *  here because this module never touches the filesystem; `daemonCommand` threads the policy value
 *  on every real invocation, so this is provably dead for the operating path (W1-T253). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
