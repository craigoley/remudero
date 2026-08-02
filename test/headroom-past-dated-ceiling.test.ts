import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDefaultHeadroomPolicy, resolveHeadroomLimitPct, parseResetInstant } from "../src/lib/daemon.js";

// ── recon-FH: `claude -p "/usage"` keeps printing a window's OLD reset time for minutes after that
// reset has passed, so a `daemon.headroom` line can carry a `resets_at` already behind its own `ts`
// — measured at 36 of 2368 ISO-shaped lines (1.5%), intermittent since 2026-07-28.
//
// A negative `hoursToReset` satisfied `<= 24` and selected the LAXER rung. It cost nothing only
// because every observed instance was the session (5h) window, whose true ceiling is that laxer rung
// anyway. The same lag on the WEEKLY window — true ceiling the STRICTER rung — would genuinely relax
// the gate on the window that actually binds.
//
// EVERY ASSERTION BELOW DRIVES THE REAL `resolveHeadroomLimitPct` against the REAL default policy.
// "The condition has three clauses" would prove nothing about which ceiling gets selected, and these
// are one-line changes to code that gates spending.
//
// NO DATE LITERALS ANYWHERE. Fixtures are derived at run time from the policy itself and from `now`,
// because main went red at noon today on a fixture that hardcoded a date relative to a staleness
// window. Where a margin matters, it is asserted against the policy that judges it.

const POLICY = buildDefaultHeadroomPolicy();

/** The two rungs, read OFF THE POLICY rather than restated — so a retune cannot silently invert
 *  these tests' meaning. */
const STRICT = POLICY[POLICY.length - 1]!.limitPct;
const NEAR_RESET_RUNG = POLICY[0]!;
const LAX = NEAR_RESET_RUNG.limitPct;

test("the fixture's own premise: the policy really does have a laxer near-reset rung", () => {
  // Without this, every assertion below could pass on a single-rung policy where strict === lax and
  // the whole suite would be vacuous.
  assert.ok(POLICY.length >= 2, `expected a multi-rung policy, got ${JSON.stringify(POLICY)}`);
  assert.ok(LAX > STRICT, `the near-reset rung (${LAX}) must be laxer than the fallback (${STRICT})`);
  assert.equal(typeof NEAR_RESET_RUNG.maxHoursToReset, "number");
});

test("a PAST-DATED reset selects the STRICT ceiling, not the laxer near-reset rung", () => {
  // Derived from the policy, never a literal: any negative value is "already reset".
  for (const hours of [-0.001, -0.05, -0.3, -5, -NEAR_RESET_RUNG.maxHoursToReset!]) {
    assert.equal(
      resolveHeadroomLimitPct(hours, POLICY),
      STRICT,
      `hoursToReset=${hours} is in the PAST — upstream lag, not an imminent reset — and must take the strict fallback`,
    );
  }
});

test("a genuinely UNKNOWN reset is unchanged — past-dated and unknown are the same epistemic state", () => {
  assert.equal(resolveHeadroomLimitPct(null, POLICY), STRICT);
  assert.equal(resolveHeadroomLimitPct(Number.NaN, POLICY), STRICT);
  assert.equal(resolveHeadroomLimitPct(Number.POSITIVE_INFINITY, POLICY), STRICT);
});

test("a VALID FUTURE reset is unaffected — the near rung still relaxes, the far rung still does not", () => {
  const near = NEAR_RESET_RUNG.maxHoursToReset! / 2;
  const atBoundary = NEAR_RESET_RUNG.maxHoursToReset!;
  const far = NEAR_RESET_RUNG.maxHoursToReset! * 7;
  assert.equal(resolveHeadroomLimitPct(near, POLICY), LAX, "a genuinely close reset must still relax");
  assert.equal(resolveHeadroomLimitPct(atBoundary, POLICY), LAX, "the boundary is inclusive and must stay so");
  assert.equal(resolveHeadroomLimitPct(far, POLICY), STRICT, "a far reset must still take the strict rung");
  assert.equal(resolveHeadroomLimitPct(0, POLICY), LAX, "exactly-now is not past — it must not be swept into the strict arm");
});

test("end to end from a real lagging /usage string: the weekly hazard takes the strict ceiling", () => {
  // THE LATENT HAZARD, reconstructed from the real shapes rather than asserted abstractly. A weekly
  // window whose reset has just passed parses to an instant behind `now`; that is the case which
  // would have relaxed the gate on the window that actually binds.
  //
  // `now` is derived at run time and the reset text is built FROM it, so there is no date literal
  // and no wall-clock dependence.
  const now = new Date();
  const justPassed = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][justPassed.getMonth()]!;
  const h24 = justPassed.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "am" : "pm";
  const text = `${month} ${justPassed.getDate()} at ${h12}:${String(justPassed.getMinutes()).padStart(2, "0")}${ampm}`;

  const instant = parseResetInstant(text, now);
  assert.ok(instant, `the real parser must still recognise this shape: ${text}`);

  const hoursToReset = (instant.getTime() - now.getTime()) / 3_600_000;
  // The parser's own +1-year roll may fire here; that is DELIBERATELY left alone (it is fail-safe).
  // Either way the ceiling must not be the lax rung: past ⇒ strict by this fix, rolled ⇒ strict
  // because a year out exceeds the near rung.
  assert.notEqual(
    resolveHeadroomLimitPct(hoursToReset, POLICY),
    LAX,
    `a reset that has just passed (${text}, hoursToReset=${hoursToReset.toFixed(3)}) must never select the lax rung`,
  );
  assert.equal(resolveHeadroomLimitPct(hoursToReset, POLICY), STRICT);
});
