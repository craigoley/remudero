import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { Series } from "../SeriesChart";
import {
  bucketSamples,
  describeSpec,
  distinctObservedLevels,
  isFlat,
  type SeriesSample,
  type SeriesSpec,
} from "../series";

// ── W1-T3177 — THE SERIES CONTRACT, inherited from W1-T3159 and not re-derived ────────────────
//
// Two acceptance criteria live here: a series STATES its window and bucket and renders an
// unreadable or empty series as ABSENT rather than a flat zero line; and the bucket is fine enough
// that a repeating sub-hourly event is VISIBLE rather than averaged away — the same fixture under a
// daily bucket is not. Both are asserted on the bucketed data AND on the rendered output, because
// the second criterion says "visible in the rendered output" and a renderer cannot show what the
// bucketing has already destroyed.

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const FINE: SeriesSpec = { label: "Fleet state changes", windowMs: 2 * 3_600_000, bucketMs: 2 * 60_000, unit: "changes" };
const DAILY: SeriesSpec = { label: "Fleet state changes", windowMs: 24 * 3_600_000, bucketMs: 24 * 3_600_000, unit: "changes" };

/** A REPEATING SUB-HOURLY EVENT: a burst every 20 minutes across the last two hours — the shape of
 *  a dispatch loop, which is the defect a daily bucket hides and this series exists to surface. */
function repeatingSpikes(): SeriesSample[] {
  const out: SeriesSample[] = [];
  for (let minutesAgo = 110; minutesAgo >= 10; minutesAgo -= 20) {
    for (let i = 0; i < 5; i += 1) out.push({ at: NOW - minutesAgo * 60_000 + i * 1_000, value: 1 });
  }
  return out;
}

describe("a series states its window and its bucket", () => {
  test("the spec is a readable sentence naming both, and it reaches the rendered output", () => {
    expect(describeSpec(FINE)).toBe("last 2 h · 2 min buckets · changes");
    render(<Series view={bucketSamples(repeatingSpikes(), FINE, NOW)} />);
    expect(screen.getByText("last 2 h · 2 min buckets · changes")).toBeDefined();
  });
});

describe("an unreadable or empty series is ABSENT, never a flat zero line", () => {
  test.each([
    ["could not be read", null, "series could not be read"],
    ["read but empty", [] as SeriesSample[], "no samples"],
    ["every sample outside the window", [{ at: NOW - 99 * 3_600_000, value: 4 }], "no samples inside the stated window"],
  ])("%s", (_name, samples, reason) => {
    const view = bucketSamples(samples, FINE, NOW);
    expect(view.kind).toBe("absent");
    if (view.kind !== "absent") throw new Error("unreachable");
    expect(view.reason).toBe(reason);

    const { container } = render(<Series view={view} />);
    expect(screen.getByTestId("series-absent")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("ABSENT");
    // THE POINT OF THE CRITERION: no plot at all. A chart frame with a line along the bottom is
    // exactly the lie — it asserts "we watched and it was zero" when we could not tell.
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByTestId("series-present")).toBeNull();
  });

  test("a bucket before the first observation is ABSENT while a quiet bucket after it is zero", () => {
    // The distinction the flat-zero rule turns on, per bucket: we were not watching vs we watched
    // and nothing happened.
    const view = bucketSamples([{ at: NOW - 10 * 60_000, value: 3 }], FINE, NOW);
    if (view.kind !== "present") throw new Error("expected present");
    expect(view.buckets[0]?.value).toBeNull();
    const afterFirst = view.buckets.filter((b) => b.startMs > NOW - 10 * 60_000);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.every((b) => b.value === 0)).toBe(true);

    render(<Series view={view} />);
    const cells = within(screen.getByTestId("series-table")).getAllByText("absent");
    expect(cells.length).toBeGreaterThan(0);
  });
});

describe("the bucket is fine enough to show a repeating sub-hourly event", () => {
  const samples = repeatingSpikes();

  test("the SAME fixture is varied under a 2-minute bucket and flat under a daily one", () => {
    const fine = bucketSamples(samples, FINE, NOW);
    const daily = bucketSamples(samples, DAILY, NOW);
    expect(distinctObservedLevels(fine)).toBeGreaterThan(1);
    expect(isFlat(fine)).toBe(false);
    // Averaged away: one bucket as wide as the window carries one total and cannot vary.
    expect(distinctObservedLevels(daily)).toBe(1);
    expect(isFlat(daily)).toBe(true);
  });

  test("and the difference survives to the rendered output, not just the data", () => {
    const readLevels = (spec: SeriesSpec) => {
      const { unmount } = render(<Series view={bucketSamples(samples, spec, NOW)} />);
      const values = within(screen.getByTestId("series-table"))
        .getAllByRole("cell")
        .map((c) => c.getAttribute("data-value"))
        .filter((v): v is string => v !== null && v !== "absent");
      unmount();
      return new Set(values);
    };
    expect(readLevels(FINE).size).toBeGreaterThan(1);
    expect(readLevels(DAILY).size).toBe(1);
  });

  test("the peak the fine bucket preserves is the real burst size, not an average", () => {
    const fine = bucketSamples(samples, FINE, NOW);
    if (fine.kind !== "present") throw new Error("expected present");
    const peak = Math.max(...fine.buckets.map((b) => b.value ?? 0));
    expect(peak).toBe(5);
    const daily = bucketSamples(samples, DAILY, NOW);
    if (daily.kind !== "present") throw new Error("expected present");
    // 30 events in one bucket: the burst is gone, only the total remains.
    expect(daily.buckets.filter((b) => b.value !== null)).toHaveLength(1);
    expect(daily.buckets.find((b) => b.value !== null)?.value).toBe(30);
  });
});

// ── Gaps found by mutation, each closing a mutant that survived the suite above ───────────────

describe("the contract holds at its own edges", () => {
  test("distinctObservedLevels ignores ABSENT buckets — otherwise 'absent' reads as a level and a flat series looks varied", () => {
    // S5: one observed value plus leading unobserved buckets must read exactly ONE level. Counting
    // nulls made this 2, which would have reported a flat series as varied — the exact confusion
    // between "we could not tell" and "it changed" that property 2 exists to prevent.
    // The sample sits in the LAST bucket, so every earlier bucket is unobserved and there is exactly
    // ONE observed level. (A sample earlier in the window would leave real 0 buckets after it, and
    // spike-then-quiet is legitimately two levels — that is the contract working, not a gap.)
    const view = bucketSamples([{ at: NOW - 30_000, value: 3 }], FINE, NOW);
    if (view.kind !== "present") throw new Error("expected present");
    expect(view.buckets.some((b) => b.value === null)).toBe(true);
    expect(view.buckets.filter((b) => b.value !== null)).toHaveLength(1);
    expect(distinctObservedLevels(view)).toBe(1);
    expect(isFlat(view)).toBe(true);
  });

  test("a sample exactly on a bucket boundary is counted ONCE, not by both neighbours", () => {
    // S6: a half-open bucket [start, end) is what makes the totals sum to the sample count. An
    // inclusive upper bound double-counts every boundary sample and inflates the peak.
    const bucket = FINE.bucketMs;
    const boundary = NOW - 10 * bucket; // exactly a bucket start
    const view = bucketSamples([{ at: boundary, value: 1 }, { at: boundary + bucket, value: 1 }], FINE, NOW);
    if (view.kind !== "present") throw new Error("expected present");
    const total = view.buckets.reduce((n, b) => n + (b.value ?? 0), 0);
    expect(total).toBe(2);
    expect(view.buckets.filter((b) => (b.value ?? 0) > 0)).toHaveLength(2);
  });

  test("a spec whose bucket is wider than its window is ABSENT, not a single meaningless point", () => {
    // S7: without the sanity check this produced one bucket covering more than the window it claims
    // to describe — a point whose stated coverage is a lie, which is worse than no series.
    for (const bad of [
      { ...FINE, bucketMs: FINE.windowMs * 2 },
      { ...FINE, bucketMs: 0 },
      { ...FINE, windowMs: 0 },
    ]) {
      const view = bucketSamples(repeatingSpikes(), bad, NOW);
      expect(view.kind).toBe("absent");
      if (view.kind !== "absent") throw new Error("unreachable");
      expect(view.reason).toBe("series window and bucket do not describe a readable span");
    }
  });
});
