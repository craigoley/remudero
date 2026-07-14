/**
 * THE BILLING BOUNDARY (FIELD FINDING 1, MASTER-PLAN §9).
 *
 * Worker environments are CONSTRUCTED, never inherited. `ANTHROPIC_API_KEY` is
 * exported from this operator's login shell and TAKES PRECEDENCE over the
 * claude.ai OAuth login — any child that inherits it silently bills API rates
 * instead of the Max subscription. By building each child env from an explicit
 * allowlist and asserting no `ANTHROPIC_*` key survives, Claude Code falls back
 * to subscription OAuth. `billing_mode` becomes a decision the harness makes and
 * records, never an accident it inherits.
 *
 * launchd happens to be clean (it never sources `.zshrc`), but a daemon started
 * from a dev shell inherits the key — this function is what makes BOTH paths
 * safe. The API key is injected ONLY when an overflow valve is deliberately
 * engaged (not in this spike).
 */

/**
 * Base variables a worker legitimately needs, copied from the parent by name.
 *
 * `USER` is load-bearing on macOS: the subscription OAuth token is stored in the
 * login Keychain (not a file), and the CLI resolves the keychain identity from
 * `USER`. With PATH/HOME/TMPDIR/LANG but no USER, a headless run returns
 * "Not logged in · Please run /login" (verified: SDK 0.3.209 / CLI 2.1.209).
 * `LOGNAME` alone is NOT sufficient. None of these carry secrets.
 */
const ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "USER"] as const;

/** Any key matching this is a billing-boundary violation and must not survive. */
const ANTHROPIC_KEY = /^ANTHROPIC_/i;

/**
 * Build a child environment from an explicit allowlist plus caller-supplied
 * vars. Never inherits `process.env` wholesale. Throws if any `ANTHROPIC_*`
 * key survives (including one a caller passed in), so a leak fails loud at the
 * boundary rather than silently on the invoice.
 */
export function buildWorkerEnv(
  extra: Record<string, string> = {},
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};

  for (const key of ALLOWLIST) {
    const val = parent[key];
    if (typeof val === "string") child[key] = val;
  }

  for (const [key, val] of Object.entries(extra)) {
    child[key] = val;
  }

  const survivors = Object.keys(child).filter((k) => ANTHROPIC_KEY.test(k));
  if (survivors.length > 0) {
    throw new Error(
      `buildWorkerEnv: billing-boundary violation — ANTHROPIC_* keys survived: ${survivors.join(", ")}`,
    );
  }

  return child;
}

/** True iff `env` carries zero ANTHROPIC_* keys. Proof helper for callers. */
export function isBillingClean(env: Record<string, string | undefined>): boolean {
  return !Object.keys(env).some((k) => ANTHROPIC_KEY.test(k));
}
