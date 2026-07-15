import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTier } from "../src/lib/tier.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";

/** Dual-weekly-cap `/usage` shape (all-models + a model-specific cap). */
const DUAL_WEEKLY_USAGE: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 42, resetsAt: "8pm" },
  weekly: [
    { label: "all models", percentUsed: 63, resetsAt: "Mon" },
    { label: "Sonnet", percentUsed: 27, resetsAt: "Mon" },
  ],
};

/** Single-weekly-cap `/usage` shape. */
const SINGLE_WEEKLY_USAGE: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 10, resetsAt: "8pm" },
  weekly: [{ label: "all models", percentUsed: 30, resetsAt: "Mon" }],
};

test("detectTier: max5x — resolved confidently from ~/.claude.json rate-limit-tier string", () => {
  const d = detectTier({
    claudeJson: {
      oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" },
    },
  });
  assert.equal(d.tier, "max5x");
  assert.equal(d.confident, true);
  assert.equal(d.source, "claude_json_rate_limit_tier");
});

test("detectTier: max20x — resolved confidently from ~/.claude.json rate-limit-tier string (real shape, W1-T9b recon)", () => {
  const d = detectTier({
    claudeJson: {
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" },
    },
  });
  assert.equal(d.tier, "max20x");
  assert.equal(d.confident, true);
  assert.equal(d.source, "claude_json_rate_limit_tier");
});

test("detectTier: max20x — a per-seat userRateLimitTier overrides the org default", () => {
  const d = detectTier({
    claudeJson: {
      oauthAccount: {
        userRateLimitTier: "default_claude_max_20x",
        organizationRateLimitTier: "default_claude_max_5x",
      },
    },
  });
  assert.equal(d.tier, "max20x");
  assert.equal(d.confident, true);
});

test("detectTier: pro — resolved from a rate-limit-tier string naming pro", () => {
  const d = detectTier({
    claudeJson: { oauthAccount: { organizationRateLimitTier: "default_claude_pro" } },
  });
  assert.equal(d.tier, "pro");
  assert.equal(d.confident, true);
});

test("detectTier: ambiguous — no rate-limit-tier string, only organizationType confirms Max-family", () => {
  const d = detectTier({
    claudeJson: { oauthAccount: { organizationType: "claude_max" } },
  });
  assert.equal(d.tier, "unknown");
  assert.equal(d.confident, false);
  assert.equal(d.source, "claude_json_organization_type");
  assert.match(d.detail, /multiplier/);
});

test("detectTier: ambiguous — no ~/.claude.json at all, only dual-weekly /usage passively suggests Max-family", () => {
  const d = detectTier({ usage: DUAL_WEEKLY_USAGE });
  assert.equal(d.tier, "unknown");
  assert.equal(d.confident, false);
  assert.equal(d.source, "usage_dual_weekly_caps");
  assert.match(d.detail, /dual weekly caps/);
});

test("detectTier: ambiguous — single weekly window, no claude.json, is not confused for a confident answer", () => {
  const d = detectTier({ usage: SINGLE_WEEKLY_USAGE });
  assert.equal(d.tier, "unknown");
  assert.equal(d.confident, false);
  assert.equal(d.source, "usage_dual_weekly_caps");
});

test("detectTier: ambiguous — no inputs at all yields insufficient_evidence, never a guessed tier", () => {
  const d = detectTier({});
  assert.equal(d.tier, "unknown");
  assert.equal(d.confident, false);
  assert.equal(d.source, "insufficient_evidence");
});

test("detectTier: an unrecognized rate-limit-tier string degrades to unknown rather than misreporting", () => {
  const d = detectTier({
    claudeJson: { oauthAccount: { organizationRateLimitTier: "some_future_plan_name" } },
  });
  assert.equal(d.tier, "unknown");
  assert.equal(d.confident, false);
  assert.equal(d.source, "claude_json_rate_limit_tier");
});

test("detectTier: rung 2 (claude.json) wins over rung 3 (/usage) when both are present", () => {
  const d = detectTier({
    usage: SINGLE_WEEKLY_USAGE,
    claudeJson: { oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" } },
  });
  assert.equal(d.tier, "max5x");
  assert.equal(d.confident, true);
  assert.equal(d.source, "claude_json_rate_limit_tier");
});
