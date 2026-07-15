/**
 * Tier detection — PURE (MASTER-PLAN §9 "detect → confirm, never silent" ladder,
 * rungs 1 & 2; W1-T9b).
 *
 * `detectTier()` takes already-captured data as INPUTS and returns a best-effort
 * tier + the evidence it came from. It makes NO live calls (no spawning `claude
 * -p "/usage"`, no reading `~/.claude.json` off disk) and is never interactive —
 * that split (capture vs. infer) is what makes this module unit-testable over
 * fixtures. The caller (a future `rmd init` wizard, W1-T9c) owns the I/O:
 * capture `/usage` (headroom.ts, W1-T4), read `~/.claude.json`, then call this.
 *
 * Evidence ladder (highest confidence first):
 *
 *   Rung 2 — `~/.claude.json` `oauthAccount.{userRateLimitTier,
 *   organizationRateLimitTier}`. CONFIRMED shape (Standing rule 7: read the
 *   installed file, don't guess) carries a plan label directly, e.g. the string
 *   `"default_claude_max_20x"` — the most direct signal available, when present.
 *   `userRateLimitTier` (a per-seat override) is preferred over the
 *   organization default when both are set.
 *
 *   Rung 2b — `oauthAccount.organizationType` (observed value `"claude_max"`).
 *   Confirms "some Max-family plan" but NOT the multiplier, so on its own it
 *   only yields an UNCONFIDENT "max family, multiplier undetermined" result.
 *
 *   Rung 3 — `/usage` passive inference (`headroom.ts`'s `hasDualWeeklyCaps`).
 *   Presence of a model-specific weekly cap alongside the all-models cap is a
 *   Max-family signature (MASTER-PLAN §9: "presence of dual weekly caps
 *   distinguish tiers"), but — same as 2b — it cannot resolve the multiplier
 *   from a single snapshot, so it is also UNCONFIDENT on its own.
 *
 * No rung ever fabricates a confident tier it cannot support: an unrecognized
 * or absent signal degrades to `tier: "unknown", confident: false` rather than
 * guessing. rung3 magnitude-based inference (comparing observed dollar caps
 * across tiers) is EXPLICITLY deferred — it needs calibration data this pure
 * function does not have — not implemented speculatively here.
 */

import type { UsageSnapshot } from "./headroom.js";
import { hasDualWeeklyCaps } from "./headroom.js";

/** A Claude Code subscription tier this harness knows how to route for. */
export type Tier = "pro" | "max5x" | "max20x" | "unknown";

/** Which rung of the detection ladder produced the result. */
export type TierEvidenceSource =
  | "claude_json_rate_limit_tier"
  | "claude_json_organization_type"
  | "usage_dual_weekly_caps"
  | "insufficient_evidence";

/** The tier `detectTier` settled on, plus WHY (never silent — MASTER-PLAN §9). */
export interface TierDetection {
  tier: Tier;
  /** False when the tier is a weak guess rather than a resolved signal. */
  confident: boolean;
  source: TierEvidenceSource;
  /** Human-readable explanation, safe to log/show in a confirm prompt. */
  detail: string;
}

/**
 * The subset of `~/.claude.json` keys this module reads (rung 2, MASTER-PLAN
 * §9(h)). Fields are OPTIONAL and loosely typed: the file is not ours, and a
 * future Claude Code release may add/rename fields around them.
 */
export interface ClaudeJsonKeys {
  hasAvailableSubscription?: boolean | null;
  oauthAccount?: {
    /** Per-seat override, e.g. `"default_claude_max_20x"`. Usually absent. */
    userRateLimitTier?: string | null;
    /** Org default, e.g. `"default_claude_max_20x"`. Present on this spike's account. */
    organizationRateLimitTier?: string | null;
    /** Observed value `"claude_max"`. Confirms Max-family, not the multiplier. */
    organizationType?: string | null;
  } | null;
}

/** Everything `detectTier` accepts. Every field is optional (any rung may be missing). */
export interface TierInput {
  /** Parsed `/usage` capture (rung 1/3 — headroom.ts, W1-T4). */
  usage?: UsageSnapshot;
  /** Locally-cached `~/.claude.json` keys (rung 2). */
  claudeJson?: ClaudeJsonKeys;
}

/**
 * Normalizes a rate-limit-tier string, e.g. `"default_claude_max_20x"` (the
 * confirmed real shape — W1-T9b recon), to a {@link Tier}. Tokenizes on
 * non-alphanumerics rather than using `\b` word boundaries: `_` is a `\w`
 * character in JS regex, so `\bpro\b` does NOT match inside `claude_pro`.
 */
function parseRateLimitTier(raw: string): Tier | null {
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (t: string) => tokens.includes(t);
  if (has("max20x") || (has("max") && has("20x"))) return "max20x";
  if (has("max5x") || (has("max") && has("5x"))) return "max5x";
  if (has("pro")) return "pro";
  return null;
}

/**
 * Detect the operator's tier from already-captured `/usage` output and
 * `~/.claude.json` keys. PURE: same inputs always produce the same output, no
 * I/O, no prompting. Always returns a tier (falling back to `"unknown"`) WITH
 * its evidence source — MASTER-PLAN §9's "detect → confirm, never silent."
 */
export function detectTier(input: TierInput): TierDetection {
  const oauth = input.claudeJson?.oauthAccount;

  // Rung 2: an explicit rate-limit-tier string (user override, then org default).
  const rateLimitTierRaw = oauth?.userRateLimitTier ?? oauth?.organizationRateLimitTier;
  if (rateLimitTierRaw) {
    const tier = parseRateLimitTier(rateLimitTierRaw);
    if (tier) {
      return {
        tier,
        confident: true,
        source: "claude_json_rate_limit_tier",
        detail: `~/.claude.json oauthAccount rate-limit-tier "${rateLimitTierRaw}" parsed as ${tier}.`,
      };
    }
    return {
      tier: "unknown",
      confident: false,
      source: "claude_json_rate_limit_tier",
      detail: `~/.claude.json oauthAccount rate-limit-tier "${rateLimitTierRaw}" did not match a known pattern.`,
    };
  }

  // Rung 2b: organizationType confirms Max-family but not the multiplier.
  if (oauth?.organizationType && /max/i.test(oauth.organizationType)) {
    return {
      tier: "unknown",
      confident: false,
      source: "claude_json_organization_type",
      detail: `~/.claude.json oauthAccount.organizationType "${oauth.organizationType}" confirms a Max-family plan, but the 5x/20x multiplier is not present in this key.`,
    };
  }

  // Rung 3: passive /usage inference — dual weekly caps are a Max-family signature.
  if (input.usage) {
    if (hasDualWeeklyCaps(input.usage)) {
      return {
        tier: "unknown",
        confident: false,
        source: "usage_dual_weekly_caps",
        detail: `/usage reports ${input.usage.weekly.length} weekly windows (dual weekly caps) — consistent with a Max-family plan, but the multiplier can't be resolved from /usage alone.`,
      };
    }
    return {
      tier: "unknown",
      confident: false,
      source: "usage_dual_weekly_caps",
      detail: `/usage reports a single weekly window — consistent with a non-Max plan, but not confirmed.`,
    };
  }

  return {
    tier: "unknown",
    confident: false,
    source: "insufficient_evidence",
    detail: "no /usage capture and no ~/.claude.json keys were provided.",
  };
}
