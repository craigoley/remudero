/**
 * `DEFAULT_POLL_INTERVAL_MS` — a LEAF-module restatement of `daemon.ts`'s own constant of the
 * same name (W1-T2895), not a re-export: `test/reap-cadence.test.ts` reads `daemon.ts`'s source
 * text for the literal `export const DEFAULT_POLL_INTERVAL_MS = 60_000;` declaration, so that
 * file keeps its own canonical copy. `daemon-health.ts` imports `daemon.ts` TYPE-ONLY
 * (`GhRateLimitBuckets`) precisely because a VALUE import back would be a genuine two-module
 * cycle — see `daemon-health.ts`'s own `isBucketExhausted` comment. Importing the value from
 * here instead of from `daemon.ts` removes that value edge, so the type-only edge no longer
 * closes a loop; this module imports nothing, so it cannot reopen one itself.
 */

/** Default idle-poll pace: check back once a minute while nothing is runnable. The literal stays
 *  here because this module never touches the filesystem; `daemonCommand` threads the policy value
 *  on every real invocation, so this is provably dead for the operating path (W1-T253). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Shared GitHub label for operator-facing escalation issues. */
export const NEEDS_HUMAN_LABEL = "needs-human";
