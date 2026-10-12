/**
 * W1-T5703 — A TEST_ONLY COVERAGE SKIP IS A SKIPPED SHADOW RUN, NOT AN INCOMPLETE ONE.
 *
 * coverage-shard prints `W1-T2428 fast-lane: class=<CLASS> — skipping Test with coverage` for every
 * class `classifyCoverage` (scripts/diff-class.mjs) returns except SOURCE. `explicitlySkippedRun`
 * matched only a literal PLAN_ONLY|DOCS_ONLY|NO_SRC alternation, so an eight-shard TEST_ONLY skip
 * counted as an INCOMPLETE run, and `selectorShadowReport` stays "insufficient" while any incomplete
 * run sits in its window (10-04: 45 complete runs, zero misses, 4 incomplete). The accepted classes
 * now come from one exported list, `SELECTOR_SHADOW_SKIP_CLASSES`, pinned here against the
 * classifier's own `COVERAGE_CLASSES` so a new skip class cannot silently read as missing evidence.
 *
 * FALSIFIER: restore the PLAN_ONLY|DOCS_ONLY alternation — the TEST_ONLY log counts incomplete and
 * the first test fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SELECTOR_SHADOW_MIN_FAILURES,
  SELECTOR_SHADOW_MIN_RUNS,
  SELECTOR_SHADOW_SHARDS,
  SELECTOR_SHADOW_SKIP_CLASSES,
  selectorShadowReport,
  type SelectorShadowRun,
} from "../src/lib/selector-shadow-gardener.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import { COVERAGE_CLASSES } from "../scripts/diff-class.mjs";

function skipLog(cls: string, shards = SELECTOR_SHADOW_SHARDS): string {
  return Array.from({ length: shards }, (_, i) =>
    `coverage-shard (${i + 1}/8)\t2026-10-04T18:17:00.0000000Z W1-T2428 fast-lane: class=${cls} — skipping Test with coverage (no src/**/test/** path in this diff, so coverage cannot newly move).`,
  ).join("\n");
}

function counts(log: string): [number, number, number] {
  const report = selectorShadowReport([{ id: 5703, headSha: "skip", log }], 100);
  return [report.runsSkipped, report.runsIncomplete, report.runsComplete];
}

test("W1-T5703: eight TEST_ONLY skip lines count as one skipped shadow run, eight PLAN_ONLY lines still do, and seven of eight stays incomplete", () => {
  assert.deepEqual(counts(skipLog("TEST_ONLY")), [1, 0, 0], "an eight-shard TEST_ONLY skip is not missing source evidence");
  assert.deepEqual(counts(skipLog("PLAN_ONLY")), [1, 0, 0], "an eight-shard PLAN_ONLY skip still counts as skipped");
  assert.deepEqual(counts(skipLog("TEST_ONLY", 7)), [0, 1, 0], "seven skips cannot hide a missing coverage shard");
  assert.deepEqual(counts(skipLog("PLAN_ONLY", 7)), [0, 1, 0], "seven skips cannot hide a missing coverage shard");
  assert.deepEqual(counts(""), [0, 1, 0], "a log with neither a selector line nor a skip line stays incomplete");
});

test("W1-T5703: every non-SOURCE coverage class the classifier emits is a skip class, and nothing else is", () => {
  const emitted = Object.values(COVERAGE_CLASSES as Record<string, string>).filter((c) => c !== "SOURCE").sort();
  assert.deepEqual([...SELECTOR_SHADOW_SKIP_CLASSES].sort(), emitted);
  for (const cls of SELECTOR_SHADOW_SKIP_CLASSES) {
    assert.deepEqual(counts(skipLog(cls)), [1, 0, 0], `${cls}: an eight-shard skip is a skipped run`);
  }
  assert.deepEqual(counts(skipLog("SOURCE")), [0, 1, 0], "SOURCE never skips coverage, so its line cannot excuse a run");
  assert.deepEqual(counts(skipLog("BOGUS")), [0, 1, 0], "an unknown class is not an explicit skip");
});

test("W1-T5703: TEST_ONLY skips in the window leave a zero-miss shadow ready instead of insufficient", () => {
  const perRun = Math.ceil(SELECTOR_SHADOW_MIN_FAILURES / SELECTOR_SHADOW_MIN_RUNS);
  const complete: SelectorShadowRun[] = Array.from({ length: SELECTOR_SHADOW_MIN_RUNS }, (_, i) => {
    const record = {
      fullRun: false, floorSize: 80, narrowSize: 20,
      failures: Array.from({ length: perRun }, (_, n) =>
        ({ file: `test/f-${i}-${n}.test.ts`, floor: "selected" as const, narrow: "selected" as const })),
    };
    const log = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, shard) =>
      `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}`,
    ).join("\n");
    return { id: i + 1, headSha: `head-${i + 1}`, log };
  });
  const testOnly = Array.from({ length: 4 }, (_, i) => ({ id: 900 + i, headSha: `test-only-${i}`, log: skipLog("TEST_ONLY") }));
  const report = selectorShadowReport([...complete, ...testOnly], 100);
  assert.deepEqual([report.runsComplete, report.runsSkipped, report.runsIncomplete], [SELECTOR_SHADOW_MIN_RUNS, 4, 0]);
  assert.equal(report.verdict, "ready", report.reason);
});
