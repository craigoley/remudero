/**
 * Codex reset readiness, exposed WITHOUT the opaque credit id.
 *
 * `account/rateLimits/read` carries a `rateLimitResetCredits` block beside the rate-limit buckets.
 * Before this change `codexCapacityFromRateLimits` parsed only buckets and `accountId`, so an
 * operator could not tell from the dashboard that a manual reset was available.
 *
 * WHAT MAY CROSS THE BOUNDARY: the available count, and the earliest expiry when present.
 * WHAT MAY NOT: the credit `id` (`RateLimitResetCredit_…`), which is an actionable handle for
 * `account/rateLimitResetCredit/consume`. This module never calls that method and never persists
 * or renders an id, so a leaked status file cannot become a spend.
 *
 * THE MISSING/UNAVAILABLE DISTINCTION IS PRESERVED: an absent block yields NO field (missing), a
 * block whose count is readable but whose detail is not yields the count and no expiry
 * (unavailable) — never a synthesised zero, which would read as "no reset available".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { codexCapacityFromRateLimits } from "../src/lib/worker-provider.js";
import { writeProviderRoutingStatus, providerRoutingStatusPath } from "../src/lib/provider-routing-status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { readFileSync } from "node:fs";

const BUCKET = {
  limitId: "codex",
  primary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: 1789435673 },
};

/** The live shape, observed 2026-09-10 through the deployed app-server. The id is real-shaped. */
const AVAILABLE = {
  rateLimits: BUCKET,
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      {
        id: "RateLimitResetCredit_fd9907bc3e1c8191a340cefb6d13ca25",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1788582031,
        expiresAt: 1791174031,
        title: "Full reset",
        description: "Thanks for using Codex!",
      },
    ],
  },
};

test("a response with available credits exposes the count and the earliest expiry", () => {
  const capacity = codexCapacityFromRateLimits(AVAILABLE);
  assert.equal(capacity.readable, true, "control: the bucket still parses");
  assert.equal(capacity.resetCredits?.availableCount, 1);
  assert.equal(capacity.resetCredits?.earliestExpiresAt, 1791174031);
});

test("the EARLIEST expiry wins when several credits are granted", () => {
  const capacity = codexCapacityFromRateLimits({
    rateLimits: BUCKET,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: "RateLimitResetCredit_late", status: "available", expiresAt: 1791174031 },
        { id: "RateLimitResetCredit_early", status: "available", expiresAt: 1790000000 },
      ],
    },
  });
  assert.equal(capacity.resetCredits?.availableCount, 2);
  assert.equal(capacity.resetCredits?.earliestExpiresAt, 1790000000, "a later credit must not mask an earlier expiry");
});

test("a count-known but detail-unavailable response reports the count and NO expiry", () => {
  // UNAVAILABLE, not missing: the operator learns a reset exists even when the detail array is
  // absent or unreadable. A synthesised 0 here would read as "no reset available" and is refused.
  for (const block of [
    { availableCount: 1 },
    { availableCount: 1, credits: null },
    { availableCount: 1, credits: [{ id: "RateLimitResetCredit_x", status: "available" }] },
  ]) {
    const capacity = codexCapacityFromRateLimits({ rateLimits: BUCKET, rateLimitResetCredits: block });
    assert.equal(capacity.resetCredits?.availableCount, 1, `count must survive: ${JSON.stringify(block)}`);
    assert.equal(capacity.resetCredits?.earliestExpiresAt, undefined, "no expiry may be invented");
  }
});

test("absent credits leave the field ABSENT, never a zero", () => {
  // MISSING, distinct from unavailable. `hasCredits:false` is the live shape on an account with no
  // grant; it must not become `availableCount: 0`, which would claim a measurement never taken.
  for (const result of [
    { rateLimits: BUCKET },
    { rateLimits: BUCKET, rateLimitResetCredits: null },
    { rateLimits: BUCKET, rateLimitResetCredits: {} },
  ]) {
    const capacity = codexCapacityFromRateLimits(result);
    assert.equal(capacity.readable, true, "control: the bucket still parses");
    assert.equal(capacity.resetCredits, undefined, `absent must stay absent: ${JSON.stringify(result)}`);
  }
});

test("status serialization carries the count and CANNOT leak a credit id", () => {
  // Asserted over the BYTES ACTUALLY WRITTEN TO DISK, not the object graph — the route publishes
  // this file verbatim (`sendJson(res, 200, status)`), so the file is the real boundary.
  const capacity = codexCapacityFromRateLimits(AVAILABLE);
  const root = makeTempDir("reset-readiness-");
  writeProviderRoutingStatus(root, {
    enabledProviders: ["codex"],
    reservePercent: 5,
    observedAtMs: 1789000000000,
    cacheValidMs: 60_000,
    state: "blocked",
    capacities: [capacity],
  });
  const serialized = readFileSync(providerRoutingStatusPath(root), "utf8");

  assert.match(serialized, /"availableCount":1/, "the count must reach the console");
  assert.match(serialized, /"earliestExpiresAt":1791174031/, "and the expiry when present");
  assert.ok(!serialized.includes("RateLimitResetCredit_"), "no credit id prefix may appear in the written status");
  assert.ok(!serialized.includes("fd9907bc3e1c8191a340cefb6d13ca25"), "no credit id body may appear in the written status");
  assert.ok(!/"credits"\s*:/.test(serialized), "the raw credits array must not be projected at all");
});
