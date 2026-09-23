/**
 * A fake `exec` for the console server's `GET /v1/daemon-health` route (W1-T4226).
 *
 * `buildServeServer` reads the gh rate limit through `readGhRateLimitRemaining(deps.exec)`
 * (src/lib/daemon-health.ts), whose DEFAULT exec shells out `gh api rate_limit`. Under
 * test/setup/tmp-hygiene.ts that `gh` is a refusing stub, so a browser suite that never injects
 * an exec fails its file on the refusal. Inject this through `ServeDeps.daemonHealth.exec` so the
 * suite reads a fixed, well-formed payload instead.
 *
 * It answers ONLY `["api", "rate_limit"]` and THROWS for any other argv, so an unexpected gh call
 * is loud rather than a silent success.
 */

/** Fixed Unix-epoch-seconds `reset` (2026-01-01T00:00:00Z) — never the real clock. */
const FIXED_RESET_EPOCH_S = 1767225600;

export function fakeGhRateLimitExec(remaining = 4999): (args: string[]) => string {
  return (args: string[]): string => {
    if (args.length === 2 && args[0] === "api" && args[1] === "rate_limit") {
      const bucket = { remaining, limit: 5000, reset: FIXED_RESET_EPOCH_S };
      return JSON.stringify({ resources: { core: bucket, graphql: { ...bucket } } });
    }
    throw new Error(`fakeGhRateLimitExec: unexpected gh argv ${JSON.stringify(args)} (only ["api","rate_limit"] is faked)`);
  };
}
