/**
 * test/sweep-age-clamp.test.ts — W1-T1201 (A PR CANNOT BE IDLE LONGER THAN IT HAS EXISTED).
 *
 * THE INCIDENT this locks against: eleven live PRs, hours old, were each closed
 * `Closed by rmd sweep: abandoned — no activity in 400d (>= 14d threshold)` by a shifted-clock
 * test run. `ageDays` (`deriveDisposition`, lib/sweep.ts) was derived from `pr.lastActivityAt`
 * alone, measured against the sweep-pass clock, with NOTHING bounding the result relative to the
 * PR's own creation — shift the clock (or corrupt the `lastActivityAt` reading any other way) and
 * every PR reads as abandoned regardless of how young it actually is.
 *
 * THE FIX (design i): `ageDays` becomes the LESSER of "days since last activity" and "days since
 * `OpenPrView.createdAt`" — arithmetic evaluated ONCE in `deriveDisposition`, before any
 * `DISPOSITION_RULES` row reads it, so the bound holds no matter how `lastActivityAt` went wrong.
 * `createdAt <= lastActivityAt` always holds for a genuinely healthy PR (activity cannot precede
 * creation), so the clamp is a pure no-op there — it only ever fires when `lastActivityAt` reads
 * as OLDER than the PR's own creation, which is exactly the broken-clock/corrupted-projection
 * shape design note (ii) names.
 *
 * A FIXED, POLICY-DRIVEN CLOCK throughout (never `Date.now()`/an un-pinned default) — the SAME
 * wall-clock-time-bomb lesson test/sweep.test.ts's own REGRESSION LOCK section documents: an
 * age-sensitive assertion that omits `now` is judged against the REAL clock and eventually reads
 * as stale for reasons that have nothing to do with the code under test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse("2026-08-22T12:00:00Z");
const STALE_DAYS = DEFAULT_SWEEP_POLICY.staleDays;

/** `d` days before the pinned `NOW`, as an ISO-8601 string — `d` may be fractional (hours). */
function daysAgo(d: number): string {
  return new Date(NOW - d * MS_PER_DAY).toISOString();
}

/** A clean `mergeable`-shaped PR (review success, checks green) — the default DISPOSITION_RULES
 *  row this falls to once the bare `stale` row is out of the running, so a suppressed clamp has
 *  somewhere unambiguous to land. */
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1201,
    prUrl: "https://github.com/o/r/pull/1201",
    taskId: "W1-T1201X",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: daysAgo(0.1),
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

test("REGRESSION LOCK: the fixture clock stays fixed — every assertion below passes an explicit `now`", () => {
  // Mirrors test/sweep.test.ts's own wall-clock-time-bomb lock: nothing in this file may rely on
  // deriveDisposition's `Date.now()` default, or every assertion here silently reclassifies once
  // real time moves past NOW.
  assert.equal(typeof NOW, "number");
  assert.ok(Number.isFinite(NOW));
});

// ── acceptance 1 + 2: never idle longer than existed / a shifted clock spares a young PR ──────

test("W1-T1201: a PR whose lastActivityAt reads 400d idle is NOT stale once createdAt shows it is hours old", () => {
  const p = pr({
    // The exact incident shape: `lastActivityAt` reads as catastrophically stale (the shifted-
    // clock/corrupted-projection symptom design note (ii) names), while `createdAt` — read off
    // the SAME PR — shows the PR is genuinely young.
    lastActivityAt: daysAgo(400),
    createdAt: daysAgo(0.1),
  });
  const unclamped = deriveDisposition({ ...p, createdAt: undefined }, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(unclamped.disposition, "stale", "sanity: without the clamp this fixture WOULD be judged stale — the incident's own mechanism");

  const clamped = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(clamped.disposition, "stale", "a PR cannot be idle longer than it has existed — the clamp must suppress the stale row");
  assert.equal(clamped.disposition, "mergeable", "falls through to whatever the PR's OTHER state actually dispositions it as");
});

test("W1-T1201: a shifted clock no longer routes a young pull request to the stale disposition", () => {
  // Same mechanism, framed as the acceptance criterion states it: a PR objectively hours old
  // (a fresh createdAt) must never be routed to `stale`, no matter how far past the threshold its
  // (corrupted) `lastActivityAt` reads.
  const youngPr = pr({ lastActivityAt: daysAgo(STALE_DAYS * 50), createdAt: daysAgo(0.2) });
  const result = deriveDisposition(youngPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(result.disposition, "stale");
});

// ── acceptance 3: a genuinely abandoned PR still reaches stale, unchanged ─────────────────────

test("W1-T1201: a genuinely abandoned PR — idle longer than staleDays, and that idleness is real (createdAt predates it) — still goes stale", () => {
  const created = daysAgo(STALE_DAYS + 19);
  const lastActivity = daysAgo(STALE_DAYS + 3); // still >= staleDays, and AFTER createdAt — self-consistent
  const genuinelyStale = pr({ createdAt: created, lastActivityAt: lastActivity });
  const result = deriveDisposition(genuinelyStale, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "stale");
  assert.match(result.reason, new RegExp(`abandoned — no activity in ${STALE_DAYS + 3}d \\(>= ${STALE_DAYS}d threshold\\)`));
  assert.doesNotMatch(result.reason, /AGE CLAMP/, "the clamp never fired here — this reason must read byte-identical to the pre-clamp text");
});

test("W1-T1201: the same genuinely-abandoned PR, with NO createdAt at all, is unaffected (today's pre-clamp behaviour is preserved)", () => {
  const p = pr({ createdAt: undefined, lastActivityAt: daysAgo(STALE_DAYS + 3) });
  const result = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "stale", "an absent createdAt clamps to no bound — the pre-W1-T1201 arithmetic, unchanged");
});

test("W1-T1201: a malformed createdAt fails OPEN (treated as absent), never throws, never spuriously rescues", () => {
  const p = pr({ createdAt: "not-a-real-timestamp", lastActivityAt: daysAgo(STALE_DAYS + 3) });
  assert.doesNotThrow(() => deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW));
  const result = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "stale", "an unparseable createdAt must clamp to no bound, exactly like an absent one");
});

// ── acceptance 4: a suppression is recorded, never silent ─────────────────────────────────────

test("W1-T1201: a clock-skew suppression is recorded in the reason, naming both ages and the creation timestamp", () => {
  const created = daysAgo(0.1);
  const p = pr({ createdAt: created, lastActivityAt: daysAgo(400) });
  const result = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(result.disposition, "stale");
  assert.match(result.reason, /AGE CLAMP \(W1-T1201\)/, "the suppression must be legible in the reason, not merely inferable from an absence");
  assert.match(result.reason, /raw activity age 400d/, "names the RAW (unclamped) activity age that would have crossed the threshold");
  assert.match(result.reason, new RegExp(`${STALE_DAYS}d stale threshold`), "names the threshold that was crossed");
  assert.match(result.reason, /existed only 0d/, "names the clamped (real) lifetime age");
  assert.ok(result.reason.includes(created), "names the actual createdAt timestamp read, so a reader can verify the claim itself");
});

test("W1-T1201: a PR that merely CARRIES a createdAt, with no suppression to report, gets the ordinary unadorned reason", () => {
  // The clamp must not decorate every reason just because createdAt happens to be populated —
  // only an ACTUAL suppression earns the annotation (design iii: "when it actually changes the
  // outcome"), otherwise every disposition in the fleet grows unreadable noise.
  const p = pr({ createdAt: daysAgo(0.1), lastActivityAt: daysAgo(0.1) });
  const result = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "mergeable");
  assert.equal(result.reason, "review success, required checks green — arming auto-merge", "byte-identical to the pre-W1-T1201 reason — no clamp noise");
});

// ── acceptance 5: OpenPrView carries the creation timestamp the clamp reads ────────────────────

test("W1-T1201: OpenPrView carries createdAt, and deriveDisposition genuinely reads it (not merely typed)", () => {
  const stale = daysAgo(400);
  const withCreatedAt: OpenPrView = pr({ createdAt: daysAgo(0.1), lastActivityAt: stale });
  const withoutCreatedAt: OpenPrView = pr({ createdAt: undefined, lastActivityAt: stale });
  assert.equal(withCreatedAt.createdAt, daysAgo(0.1), "the field round-trips on the view");

  const withResult = deriveDisposition(withCreatedAt, DEFAULT_SWEEP_POLICY, NOW);
  const withoutResult = deriveDisposition(withoutCreatedAt, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(withResult.disposition, withoutResult.disposition, "the SAME lastActivityAt, differing only by createdAt, must dispose differently");
  assert.equal(withoutResult.disposition, "stale");
  assert.notEqual(withResult.disposition, "stale");
});
