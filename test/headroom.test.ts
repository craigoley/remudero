import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseUsage, UsageParseError } from "../src/lib/headroom.js";

/**
 * WS-0-shaped `/usage` capture (values are illustrative; the real capture is
 * redacted in FINDINGS §(f)). The middle dot `·` separator and the session-only
 * `(<tz>)` are reproduced exactly.
 */
const WS0_FIXTURE = [
  "You are currently using your subscription to power your Claude Code usage",
  "Current session: 42% used · resets Jul 14, 8:00pm (America/New_York)",
  "Current week (all models): 63% used · resets Jul 18, 12:00am",
  "Current week (Sonnet): 27% used · resets Jul 18, 12:00am",
  "Last 24h · 812 requests · 9 sessions · Last 7d · 41 sessions",
].join("\n");

/** Same shape, DIFFERENT model label on the model-specific weekly window. */
const ALT_LABEL_FIXTURE = WS0_FIXTURE.replace(
  "Current week (Sonnet):",
  "Current week (Fable):",
);

test("parses session % + both weekly windows + reset timestamps", () => {
  const u = parseUsage(WS0_FIXTURE);

  // Field 1: session percent. Field 2: session reset timestamp (+ tz).
  assert.equal(u.session.percentUsed, 42);
  assert.equal(u.session.resetsAt, "Jul 14, 8:00pm");
  assert.equal(u.session.tz, "America/New_York");

  // Fields 3 & 4: the all-models weekly window (percent + reset).
  assert.equal(u.weekly.length, 2);
  assert.equal(u.weekly[0].label, "all models");
  assert.equal(u.weekly[0].percentUsed, 63);
  assert.equal(u.weekly[0].resetsAt, "Jul 18, 12:00am");

  // Field 5: the model-specific weekly window (percent + reset + data label).
  assert.equal(u.weekly[1].label, "Sonnet");
  assert.equal(u.weekly[1].percentUsed, 27);
  assert.equal(u.weekly[1].resetsAt, "Jul 18, 12:00am");

  assert.equal(u.billingMode, "subscription");
});

test("weekly label is read as DATA — a different model label parses identically", () => {
  const base = parseUsage(WS0_FIXTURE);
  const alt = parseUsage(ALT_LABEL_FIXTURE);

  // Only the label differs; every numeric/timestamp field is identical.
  assert.equal(alt.weekly[1].label, "Fable");
  assert.notEqual(alt.weekly[1].label, base.weekly[1].label);
  assert.equal(alt.weekly[1].percentUsed, base.weekly[1].percentUsed);
  assert.equal(alt.weekly[1].resetsAt, base.weekly[1].resetsAt);
  assert.deepEqual(alt.session, base.session);
  assert.deepEqual(alt.weekly[0], base.weekly[0]);
});

test("fractional percentages parse", () => {
  const u = parseUsage(
    "Current session: 7.5% used · resets soon\nCurrent week (all models): 0% used · resets later",
  );
  assert.equal(u.session.percentUsed, 7.5);
  assert.equal(u.weekly[0].percentUsed, 0);
});

test("fails closed on a garbled capture (never reads as 0% used)", () => {
  assert.throws(() => parseUsage("total garbage, no windows here"), UsageParseError);
  // Missing the weekly line is also fatal.
  assert.throws(
    () => parseUsage("Current session: 10% used · resets now"),
    UsageParseError,
  );
});

test("this parser never consults the notional spend figure (window math only)", () => {
  // Guard the invariant at the source: the window-math module must not reference
  // the notional per-run cost field (subscription cost is notional — a runaway
  // tripwire, not a window signal). Enforced here so a later edit can't smuggle
  // it into headroom accounting.
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/headroom.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(
    /total_cost_usd/.test(src),
    false,
    "src/lib/headroom.ts must not reference total_cost_usd",
  );
});
