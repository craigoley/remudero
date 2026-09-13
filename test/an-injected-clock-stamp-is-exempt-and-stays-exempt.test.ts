import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS_URL = pathToFileURL(join(REPO_ROOT, "scripts", "expiring-fixture-census.mjs")).href;

const { censusExpiringFixtures, EXEMPT_MARKER } = (await import(CENSUS_URL)) as {
  censusExpiringFixtures: (o: {
    files: string[];
    readFile: (p: string) => string;
    now: number;
    thresholdDays: number;
    marginDays?: number;
  }) => { population: number; reported: unknown[]; exempt: unknown[]; alreadyExpired: unknown[] };
  EXEMPT_MARKER: string;
};

// ── the census blocked every open PR for a stamp that cannot detonate ────────────────────────────
//
// `expiring-fixture-census` refused 11 of 20 open PRs — one-file `chore(plan):` filings among them —
// for two stamps in test/the-sweep-fan-out-respects-the-host-budget.test.ts. That test injects its
// clock (`const NOW = Date.parse(...)` handed to the policy as `now: () => NOW`), so the stamps sit a
// FIXED offset before a FIXED now and no date can move them. The census cannot see that: it matches a
// hardcoded stamp and assumes a live comparison.
//
// The exemption marker is the census's documented remedy for hardcoded stamps that cannot detonate.
// The sweep fixture now goes one better: it derives those dates from the injected clock, so there is
// no literal for the census to count. These tests keep both promises load-bearing.

const THRESHOLD_DAYS = 14;
const NOW = Date.parse("2026-09-12T00:00:00Z");
/** One day inside the margin, so this stamp WOULD be reported without a marker. */
const CROSSING_STAMP = new Date(NOW - (THRESHOLD_DAYS - 6) * 86_400_000).toISOString();

const withMarker = `    lastActivityAt: "${CROSSING_STAMP}", // ${EXEMPT_MARKER} -- injected clock\n`;
const withoutMarker = `    lastActivityAt: "${CROSSING_STAMP}",\n`;

function censusOver(text: string) {
  return censusExpiringFixtures({
    files: ["test/fixture.test.ts"],
    readFile: () => text,
    now: NOW,
    thresholdDays: THRESHOLD_DAYS,
  });
}

test("a stamp carrying the exemption marker is exempted, not reported", () => {
  const out = censusOver(withMarker);
  assert.equal(out.population, 1, "the stamp must still be COUNTED — an exemption is not a deletion");
  assert.equal(out.exempt.length, 1);
  assert.deepEqual(out.reported, [], "an exempt stamp must raise no report");
});

test("FALSIFIER: the same stamp WITHOUT the marker is reported, so the marker is what suppresses it", () => {
  // Without this, the test above would pass for a census that reports nothing at all, and the
  // exemption in the sweep fixture would be decoration rather than the thing doing the work.
  const out = censusOver(withoutMarker);
  assert.equal(out.population, 1);
  assert.deepEqual(out.exempt, []);
  assert.equal(out.reported.length, 1, "a crossing stamp with no marker MUST be reported");
});

test("the sweep fan-out fixture derives both activity stamps from its injected clock", () => {
  // The guard against a future edit reintroducing wall-clock-looking literals: the census would then
  // block the whole board again, and the cause would look like whichever PR happened to be open.
  const src = readFileSync(join(REPO_ROOT, "test", "the-sweep-fan-out-respects-the-host-budget.test.ts"), "utf8");
  const activityLines = src.split("\n").filter((l) => l.includes("lastActivityAt:")).map((l) => l.trim());
  assert.deepEqual(activityLines, ["lastActivityAt: recentActivityIso(1),", "lastActivityAt: recentActivityIso(2),"]);
  assert.equal(src.includes(EXEMPT_MARKER), false, "helper-derived stamps should not need exemption markers");
  assert.match(src, /function recentActivityIso\(hoursAgo: number\): string \{/);
  assert.match(src, /new Date\(NOW - hoursAgo \* HOUR\)\.toISOString\(\)/);
});

test("that sweep test really does inject its clock — the premise the exemption rests on", () => {
  // If this ever stops being true the exemption is no longer justified and must be revisited, so the
  // premise is asserted here rather than left in a comment.
  const src = readFileSync(join(REPO_ROOT, "test", "the-sweep-fan-out-respects-the-host-budget.test.ts"), "utf8");
  assert.match(src, /const NOW = Date\.parse\(/, "the test must define a frozen NOW");
  assert.match(src, /now: \(\) => NOW/, "and hand it to the policy, so no wall clock is consulted");
});
