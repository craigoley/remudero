/**
 * W1-T5362: on 2026-10-02 `view.shadow_diff` rows were 51% of the day's ledger bytes, almost all of them
 * timing or legacy_horizon noise. A sample now writes that row only when a diff is `real`; every class
 * still counts in the view's persisted state, and one `view.shadow_summary` row per view per hour carries
 * the per-class counts since that view's last one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import * as viewShadow from "../src/lib/view-shadow.js";
import {
  VIEW_SHADOW_DIFF_STEP,
  createViewShadow,
  type ShadowEvidence,
  type ShadowLegacy,
  type ShadowStore,
  type ViewShadowState,
} from "../src/lib/view-shadow.js";

/** Spelled out, not imported, so the suite loads against a base that has no summary and fails there on its assertions. */
const VIEW_SHADOW_SUMMARY_STEP = "view.shadow_summary";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function steppedClock(start = T0): Clock & { set(ms: number): void } {
  let ms = start;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), set: (to) => void (ms = to) };
}

/** Evidence as the comparator asks for it: W1-T1 is named only by a row older than legacy's horizon. */
function evidence(input: { ids: readonly string[]; legacyAsOfMs: number | null; viewAsOfMs: number | null; legacyHorizonMs?: number }): ShadowEvidence {
  return {
    legacyAsOfMs: input.legacyAsOfMs, viewAsOfMs: input.viewAsOfMs,
    ...(input.legacyHorizonMs !== undefined ? { legacyHorizonMs: input.legacyHorizonMs } : {}),
    named: new Set(input.ids), namedBeforeHorizon: new Set(["W1-T1"]), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0,
  };
}

/** One sample whose three diffs are timing (an age leaf, ages apart), legacy_horizon (W1-T1) and dedupe (a duplicate legacy listed). */
function noiseSample(now: number): { legacy: ShadowLegacy; body: { data: unknown; asOf: string } } {
  return {
    legacy: { data: { health: { lastPollAgeMs: 1 }, groups: { blocked: [] }, ids: ["a", "b", "a"] }, asOfMs: now - 1_000, horizonMs: now - DAY },
    body: { data: { health: { lastPollAgeMs: 2 }, groups: { blocked: ["W1-T1"] }, ids: ["a", "b"] }, asOf: new Date(now).toISOString() },
  };
}

/** One sample whose only diff is real: a status nothing explains, at equal ages. */
function realSample(now: number): { legacy: ShadowLegacy; body: { data: unknown; asOf: string } } {
  return {
    legacy: { data: { status: "queued" }, asOfMs: now, inputs: { generation: 7 } },
    body: { data: { status: "running" }, asOf: new Date(now).toISOString() },
  };
}

function memoryStore(): ShadowStore & { states: Record<string, ViewShadowState> } {
  const states: Record<string, ViewShadowState> = {};
  return { states, load: () => JSON.parse(JSON.stringify(states)) as Record<string, ViewShadowState>, save: (view, state) => void (states[view] = JSON.parse(JSON.stringify(state)) as ViewShadowState) };
}

test("a sample whose diffs are all timing, legacy_horizon or dedupe writes no view.shadow_diff row but still counts in the view's state", () => {
  const clock = steppedClock();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const shadow = createViewShadow({ clock, log: (step, extra) => logged.push([step, extra]), evidence });
  const result = shadow.compare({ view: "now", key: "instance=core", requests: 1, ...noiseSample(T0) });
  assert.deepEqual(result.diffs.map((d) => [d.path, d.classification]).sort(), [
    ["groups.blocked", "legacy_horizon"], ["health.lastPollAgeMs", "timing"], ["ids", "dedupe"],
  ], "the comparator still returns every classified diff");
  assert.deepEqual(logged.filter(([step]) => step === VIEW_SHADOW_DIFF_STEP), [], "no real difference, so no diff row");
  const [state] = shadow.readiness();
  assert.equal(state!.samples, 1);
  assert.deepEqual(state!.diffs, { legacy_horizon: 1, timing: 1, dedupe: 1, real: 0 }, "every class still counts in the view's state");
  assert.equal(state!.streakSamples, 1);
  assert.equal("summary" in state!, false, "the summary window is not part of the readiness the status view shows");
});

test("a sample with a real diff writes the view.shadow_diff row with its excerpts", () => {
  const clock = steppedClock();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const shadow = createViewShadow({ clock, log: (step, extra) => logged.push([step, extra]), evidence });
  const sample = realSample(T0);
  const result = shadow.compare({ view: "now", key: "instance=core", requests: 1, ...sample });
  assert.deepEqual(result.diffs.map((d) => d.classification), ["real"]);
  const rows = logged.filter(([step]) => step === VIEW_SHADOW_DIFF_STEP);
  assert.equal(rows.length, 1, "a real difference writes its row");
  const [, extra] = rows[0]!;
  assert.equal(extra.view, "now");
  assert.equal(extra.key, "instance=core");
  assert.deepEqual(extra.classes, { legacy_horizon: 0, timing: 0, dedupe: 0, real: 1 });
  assert.deepEqual(extra.inputs, { generation: 7 });
  assert.deepEqual(extra.diffs, [{ ...result.diffs[0]!, legacy: '"queued"', view: '"running"' }], "the real path carries both sides' excerpts");
  assert.equal(shadow.readiness()[0]!.lastRealMs, T0);
});

test("one view.shadow_summary row per view per hour carries the per-class counts since the last one", () => {
  const clock = steppedClock();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const shadow = createViewShadow({ clock, log: (step, extra) => logged.push([step, extra]), evidence });
  // Two hours of samples every ten minutes on `now`; one real sample at +30m. `repositories` samples every half hour.
  for (let at = T0; at <= T0 + 2 * HOUR; at += 10 * MINUTE) {
    clock.set(at);
    shadow.compare({ view: "now", key: "instance=core", requests: 1, ...(at === T0 + 30 * MINUTE ? realSample(at) : noiseSample(at)) });
    if ((at - T0) % (30 * MINUTE) === 0) shadow.compare({ view: "repositories", key: "", requests: 0, ...noiseSample(at) });
  }
  const summaries = logged.filter(([step]) => step === VIEW_SHADOW_SUMMARY_STEP).map(([, extra]) => extra);
  const of = (view: string): Array<Record<string, unknown>> => summaries.filter((s) => s.view === view);
  assert.equal(of("now").length, 2, "two hours, two summaries for now");
  assert.equal(of("repositories").length, 2, "two hours, two summaries for repositories");
  const [first, second] = of("now");
  assert.deepEqual({ sinceMs: first!.sinceMs, samples: first!.samples, diffs: first!.diffs }, { sinceMs: T0, samples: 7, diffs: { legacy_horizon: 6, timing: 6, dedupe: 6, real: 1 } });
  assert.deepEqual({ sinceMs: second!.sinceMs, samples: second!.samples, diffs: second!.diffs }, { sinceMs: T0 + HOUR, samples: 6, diffs: { legacy_horizon: 6, timing: 6, dedupe: 6, real: 0 } }, "counts restart at each summary");
  assert.equal(second!.streakSamples, 9, "the readiness streak counts the samples since the real one");
  assert.equal(second!.lastRealMs, T0 + 30 * MINUTE);
  assert.equal(second!.ready, false);
  assert.deepEqual(of("repositories").map((s) => s.samples), [3, 2]);
  assert.equal(logged.filter(([step]) => step === VIEW_SHADOW_DIFF_STEP).length, 1, "only the real sample wrote a diff row");
});

test("the summary step the suite spells is the one the comparator writes", () => {
  assert.equal((viewShadow as Record<string, unknown>).VIEW_SHADOW_SUMMARY_STEP, VIEW_SHADOW_SUMMARY_STEP);
});

test("a restart neither repeats nor skips an hour's summary: its window persists with the view's state", () => {
  const clock = steppedClock();
  const store = memoryStore();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const log = (step: string, extra: Record<string, unknown>): void => void logged.push([step, extra]);
  const before = createViewShadow({ clock, log, evidence, store });
  for (let at = T0; at < T0 + HOUR; at += 10 * MINUTE) {
    clock.set(at);
    before.compare({ view: "now", key: "", requests: 1, ...noiseSample(at) });
  }
  assert.equal(logged.filter(([step]) => step === VIEW_SHADOW_SUMMARY_STEP).length, 0, "no hour has passed yet");
  const after = createViewShadow({ clock, log, evidence, store });
  clock.set(T0 + HOUR);
  after.compare({ view: "now", key: "", requests: 1, ...noiseSample(T0 + HOUR) });
  clock.set(T0 + HOUR + 10 * MINUTE);
  after.compare({ view: "now", key: "", requests: 1, ...noiseSample(T0 + HOUR + 10 * MINUTE) });
  const summaries = logged.filter(([step]) => step === VIEW_SHADOW_SUMMARY_STEP).map(([, extra]) => extra);
  assert.equal(summaries.length, 1, "the restarted comparator summarized the hour once");
  assert.equal(summaries[0]!.sinceMs, T0, "the window began before the restart");
  assert.equal(summaries[0]!.samples, 7, "the samples before the restart are in it");
});

test("a skipped sample counts in the summary, and a view only ever skipped still summarizes its hour", () => {
  const clock = steppedClock();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const shadow = createViewShadow({ clock, log: (step, extra) => logged.push([step, extra]), evidence });
  for (const at of [T0, T0 + 30 * MINUTE, T0 + HOUR]) {
    clock.set(at);
    shadow.compare({ view: "now", key: "", requests: 1, legacy: { data: {}, asOfMs: at, unready: "ledger catching_up" }, body: { data: {}, asOf: null } });
  }
  const summaries = logged.filter(([step]) => step === VIEW_SHADOW_SUMMARY_STEP).map(([, extra]) => extra);
  assert.deepEqual(summaries.map((s) => [s.samples, s.skipped]), [[0, 3]]);
});
