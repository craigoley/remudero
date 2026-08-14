/**
 * test/auto-triage-daily-cap.test.ts — impl-FO, updated for the W1 triage-cadence change.
 *
 * THE CHANGE (impl-FO). `plan/policy.yaml`'s `autoTriage.maxPerDay` went 4 -> 24, retiring the
 * daily cap as an instrument AT THE THEN-SHIPPED `minIntervalMinutes: 60`: 60m already capped a
 * rolling 24h window at 24 fires, so every `maxPerDay` value >= 24 was behaviourally identical.
 *
 * THE FOLLOW-ON CHANGE (policy/triage-cadence). `minIntervalMinutes` went 60 -> 15 to drain a
 * 58-entry backlog faster. This REACTIVATES the daily cap: 15m pacing alone would allow 96
 * fires/day, so `maxPerDay: 24` is now the binding constraint (worst-case daily spend is
 * unchanged; the short-run rate quadruples until the cap catches up). The tests below assert
 * that reactivated behaviour directly, rather than the old "cap is retired" claim.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY. A test asserting `maxPerDay === 24` would prove nothing —
 * it restates the constant it is meant to police and passes for a value that is wrong. Every
 * assertion below instead DRIVES the real `decideAutoTriage` and the real `recordAutoTriageFire`
 * over a simulated three-day span, polling once a minute, and counts what actually fires.
 *
 * THE SPAN IS OBSERVABLE TO THE CODE. The clock advances a full minute per poll across 4320 polls;
 * `minIntervalMinutes` is 15 and the window is 24h, so both bounds move many times inside the span.
 * (A prior session shipped two vacuous tests because its span was smaller than the 1-second
 * granularity the code could see.)
 *
 * THE POLICY IS READ FROM THE SHIPPED FILE, never hardcoded — that is what couples these tests to
 * `plan/policy.yaml` and makes the falsifier bite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  decideAutoTriage,
  readAutoTriageMarker,
  recordAutoTriageFire,
  type AutoTriagePolicy,
} from "../src/lib/auto-triage.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_ROOT = join(import.meta.dirname, "..");

/** The SHIPPED policy — not a fixture. A revert of plan/policy.yaml changes this. */
function shippedAutoTriagePolicy(): AutoTriagePolicy {
  return loadPolicy(policyPath(REPO_ROOT)).values.autoTriage;
}

/**
 * Poll the REAL decision once a minute for `days` days, advancing the REAL marker on every fire.
 * Returns the total fires and the per-calendar-day breakdown.
 */
function simulate(policy: AutoTriagePolicy, days = 3, opts: { candidates?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fo-cap-"));
  const markerPath = join(dir, "auto-triage.json");
  const start = Date.parse("2026-08-02T00:00:00.000Z");
  const perDay = new Map<string, number>();
  const reasons = new Set<string>();
  let total = 0;
  try {
    for (let m = 0; m < days * 24 * 60; m++) {
      const now = new Date(start + m * 60_000);
      const d = decideAutoTriage({
        policy,
        deferralPending: true,
        lockHeld: false,
        marker: readAutoTriageMarker(markerPath),
        now,
        candidates: opts.candidates ?? ["fb-alert-craigoley-remudero-code-scanning-17"],
      });
      if (d.fire) {
        recordAutoTriageFire(markerPath, now, DAY_MS); // the real marker advance the rung performs
        total++;
        const key = now.toISOString().slice(0, 10);
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
      } else {
        // Normalise NUMBERS only — a greedy [\d.]+ would also eat the dots in
        // "policy.autoTriage.enabled" and make the disabled assertion unreadable.
        reasons.add(d.reason.replace(/\d+(\.\d+)?/g, "N"));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { total, perDay, reasons };
}

// ── (5) THE NEW BOUND, through the real pacing logic ─────────────────────────

test("the shipped policy fires 24 times a day over a simulated 3-day span", () => {
  const policy = shippedAutoTriagePolicy();
  const { total, perDay } = simulate(policy, 3);

  // COUNTS, not the constant. At the old value of 4 these are 12 and 4.
  assert.equal(total, 72, `expected 72 fires over 3 days, got ${total}`);
  assert.deepEqual([...perDay.values()], [24, 24, 24], `per-day was ${JSON.stringify([...perDay])}`);
});

test("at the shipped 15m interval, the daily cap is REACTIVATED — no longer redundant", () => {
  const shipped = shippedAutoTriagePolicy();
  const unbounded = { ...shipped, maxPerDay: 1_000_000 };

  const a = simulate(shipped, 3);
  const b = simulate(unbounded, 3);

  // 15m pacing alone would allow 96 fires/day; the shipped 24/day cap now visibly holds it down.
  assert.equal(a.total, 72, `expected 72 capped fires over 3 days, got ${a.total}`);
  assert.equal(b.total, 288, `expected 288 unbounded fires over 3 days, got ${b.total}`);
  assert.notEqual(a.total, b.total, "the cap must now bind — shipped and unbounded should diverge");
  // And the daily-cap refusal must be reachable at the shipped value (it was not, at 60m).
  const capReasons = [...a.reasons].filter((r) => r.includes("daily cap reached"));
  assert.ok(capReasons.length > 0, "expected the daily cap refusal to be reachable at the shipped 15m value");
});

// ── (6) minInterval still holds, INDEPENDENTLY ───────────────────────────────

test("minIntervalMinutes alone still paces the rung when the daily cap cannot bind", () => {
  // maxPerDay deliberately enormous so ONLY minInterval can pace this.
  const { total, perDay, reasons } = simulate(
    { enabled: true, minIntervalMinutes: 60, maxPerDay: 1_000_000 },
    3,
  );
  assert.equal(total, 72, "60-minute spacing alone must still yield 24/day");
  assert.deepEqual([...perDay.values()], [24, 24, 24]);
  assert.ok(
    [...reasons].some((r) => r.includes("since the last fire")),
    `minInterval must be the refusal actually doing the work; saw ${JSON.stringify([...reasons])}`,
  );
});

test("a longer minInterval still throttles below 24 — the bound is live, not vestigial", () => {
  const { total, perDay } = simulate(
    { enabled: true, minIntervalMinutes: 180, maxPerDay: 1_000_000 },
    3,
  );
  assert.equal(total, 24, "180-minute spacing must yield 8/day, not 24");
  assert.deepEqual([...perDay.values()], [8, 8, 8]);
});

test("a fire inside the interval is refused naming minInterval, not the daily cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "fo-int-"));
  const markerPath = join(dir, "auto-triage.json");
  try {
    const t0 = new Date("2026-08-02T00:00:00.000Z");
    recordAutoTriageFire(markerPath, t0, DAY_MS);
    const d = decideAutoTriage({
      policy: shippedAutoTriagePolicy(),
      deferralPending: true,
      lockHeld: false,
      marker: readAutoTriageMarker(markerPath),
      now: new Date(t0.getTime() + 14 * 60_000), // 14m — one minute short of the shipped 15m floor
      candidates: ["fb-x"],
    });
    assert.equal(d.fire, false);
    assert.match(d.reason, /since the last fire \(minInterval 15m\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (7) THE DEFAULT-OFF LOCK: enabled false or absent means NEVER ────────────

test("enabled:false never fires, across the whole simulated span", () => {
  const { total, reasons } = simulate({ ...shippedAutoTriagePolicy(), enabled: false }, 3);
  assert.equal(total, 0, "a disabled rung must never fire, whatever maxPerDay says");
  assert.deepEqual([...reasons], ["auto-triage disabled (policy.autoTriage.enabled=false)"]);
});

test("an ABSENT enabled flag is treated as off — the kill switch fails closed", () => {
  // `enabled` missing entirely (undefined), not merely false.
  const policy = { minIntervalMinutes: 60, maxPerDay: 24 } as unknown as AutoTriagePolicy;
  const { total } = simulate(policy, 3);
  assert.equal(total, 0, "an absent flag must not be read as opted-in");
});

test("raising maxPerDay does not weaken the disabled lock even with a huge cap", () => {
  const { total } = simulate(
    { enabled: false, minIntervalMinutes: 1, maxPerDay: 1_000_000 },
    3,
  );
  assert.equal(total, 0);
});

// ── the schema ceiling survives, so the lever back is still one line ─────────

test("the shipped policy keeps its schema bounds, so tightening again stays a one-line edit", () => {
  const raw = loadPolicy(policyPath(REPO_ROOT));
  const p = raw.values.autoTriage;
  assert.equal(p.minIntervalMinutes, 15, "minIntervalMinutes must not have moved");
  assert.equal(p.enabled, true, "this PR does not change the opt-in");
  // The value must remain within the schema's own declared ceiling.
  assert.ok(p.maxPerDay <= 24, `maxPerDay ${p.maxPerDay} exceeds the schema max of 24`);
});
