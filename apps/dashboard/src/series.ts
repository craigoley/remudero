// apps/dashboard/src/series.ts — THE SERIES CONTRACT, as a pure module.
//
// W1-T3177 design (ii): W1-T3159 wrote this contract to survive a renderer swap, and this IS the
// swap, so the four properties are inherited rather than re-derived:
//
//   1. every series STATES its window and its bucket, so a reader knows what one point covers;
//   2. a series that cannot be read renders ABSENT, never as a flat line at zero — "nothing
//      happened" and "we could not tell" are different facts and must not share a shape;
//   3. the bucket is fine enough that a repeating sub-hourly event is VISIBLE rather than averaged
//      away (a daily bucket hides a 2.5-minute loop, which is the defect the series exists to
//      surface), and
//   4. the contract is stated as window/bucket/absent-vs-zero so it holds under any renderer.
//
// It is PURE and lives outside the component on purpose: the two criteria that turn on bucketing
// are then testable without mounting anything, and the render test asserts only that the component
// shows what this module decided.

/** One observation. `at` is epoch millis. */
export interface SeriesSample {
  readonly at: number;
  readonly value: number;
}

export interface SeriesSpec {
  readonly label: string;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly unit: string;
}

/** `value: null` is ABSENT — outside the span we actually observed. Inside it, no events is 0. */
export interface SeriesBucket {
  readonly startMs: number;
  readonly value: number | null;
}

export type SeriesView =
  | { readonly kind: "absent"; readonly spec: SeriesSpec; readonly reason: string }
  | {
      readonly kind: "present";
      readonly spec: SeriesSpec;
      readonly buckets: readonly SeriesBucket[];
      readonly specLabel: string;
    };

function humanDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

/** Property 1, as one string a reader can see: what the window is and what a point covers. */
export function describeSpec(spec: SeriesSpec): string {
  return `last ${humanDuration(spec.windowMs)} · ${humanDuration(spec.bucketMs)} buckets · ${spec.unit}`;
}

/**
 * Bucket `samples` into `spec`'s window ending at `nowMs`.
 *
 * ABSENT, not zero (property 2), in four distinct ways — a null/undefined series (the read failed),
 * a series with no samples at all, a spec that cannot produce buckets, and a window in which every
 * sample falls outside. All four are "we could not tell", and each names itself.
 */
export function bucketSamples(
  samples: readonly SeriesSample[] | null | undefined,
  spec: SeriesSpec,
  nowMs: number,
): SeriesView {
  if (samples === null || samples === undefined) {
    return { kind: "absent", spec, reason: "series could not be read" };
  }
  if (spec.bucketMs <= 0 || spec.windowMs <= 0 || spec.bucketMs > spec.windowMs) {
    return { kind: "absent", spec, reason: "series window and bucket do not describe a readable span" };
  }
  if (samples.length === 0) {
    return { kind: "absent", spec, reason: "no samples" };
  }
  const from = nowMs - spec.windowMs;
  const inWindow = samples.filter((s) => Number.isFinite(s.at) && Number.isFinite(s.value) && s.at >= from && s.at <= nowMs);
  if (inWindow.length === 0) {
    return { kind: "absent", spec, reason: "no samples inside the stated window" };
  }
  // OBSERVED SPAN. Buckets before the first observation are ABSENT: we were not watching, which is
  // not the same as watching and seeing nothing. This is where property 2 bites per-bucket.
  const firstObservedAt = Math.min(...inWindow.map((s) => s.at));
  const count = Math.ceil(spec.windowMs / spec.bucketMs);
  const buckets: SeriesBucket[] = [];
  for (let i = 0; i < count; i += 1) {
    const startMs = from + i * spec.bucketMs;
    const endMs = startMs + spec.bucketMs;
    if (endMs <= firstObservedAt) {
      buckets.push({ startMs, value: null });
      continue;
    }
    let total = 0;
    for (const s of inWindow) if (s.at >= startMs && s.at < endMs) total += s.value;
    buckets.push({ startMs, value: total });
  }
  return { kind: "present", spec, buckets, specLabel: describeSpec(spec) };
}

/**
 * How many DISTINCT observed levels the view carries — property 3, made measurable.
 *
 * A repeating spike under a fine bucket alternates between its peak and its floor and so reads 2 or
 * more; the same samples under a bucket as wide as the window collapse into ONE total and read 1.
 * That is exactly "averaged away", and a renderer cannot show what the bucketing has already lost,
 * which is why this is asserted on the data and then again on the rendered output.
 */
export function distinctObservedLevels(view: SeriesView): number {
  if (view.kind === "absent") return 0;
  return new Set(view.buckets.filter((b) => b.value !== null).map((b) => b.value)).size;
}

/** True when nothing in the view varies — the flat line property 2 forbids standing in for ABSENT. */
export function isFlat(view: SeriesView): boolean {
  return distinctObservedLevels(view) <= 1;
}
