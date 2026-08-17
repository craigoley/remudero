import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CHARS_PER_TOKEN,
  TRIVIAL_DROPPED_WEIGHT_CHARS,
  deriveKnowledgeBudgetCap,
  measureKnowledgeBudgetPressure,
  type LedgerLine,
} from "../src/lib/digest.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, buildEntryWeightIndex, type LearningEntry } from "../src/lib/learnings.js";

// ── W1-T941: THE KNOWLEDGE BUDGET IS A DERIVED CAP, NOT A PICKED NUMBER ─────────────────────
//
// DEFAULT_KNOWLEDGE_BUDGET_CHARS (src/lib/learnings.ts) used to be a bare literal (1800) with no
// derivation anywhere in the tree. This suite proves the replacement machinery: (1) the exported
// constant is PINNED to scripts/knowledge-budget-baseline.json's `capChars` -- a drift test that
// goes red the moment either side moves without the other; (2) the derivation itself is driven by
// measured dropped-fact WEIGHT (not a count) and the priced cache-mix delta, in BOTH falsifier
// directions design note (v) names: heavy sustained pressure derives a cap ABOVE the current
// figure, and negligible pressure derives the CURRENT figure unchanged -- never a raise dressed as
// a measurement.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "knowledge-budget-baseline.json");

function loadBaseline(): { capChars: number } {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function injectedRow(dropped: string[]): LedgerLine {
  return { step: "learnings.injected", matched: dropped.length, matched_ids: [], dropped, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS };
}

// ── (1) THE PIN: the exported constant can only move together with the baseline's arithmetic ──

test("DEFAULT_KNOWLEDGE_BUDGET_CHARS is pinned to scripts/knowledge-budget-baseline.json's capChars", () => {
  const baseline = loadBaseline();
  assert.equal(
    DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    baseline.capChars,
    "the literal in src/lib/learnings.ts and scripts/knowledge-budget-baseline.json's capChars have drifted apart -- " +
      "delete this pin and it goes red (design note v): a cap change must land as a reviewed baseline diff, never a bare edit of the literal",
  );
});

test("the recorded baseline's capChars is a finite non-negative number (a real figure, not a placeholder)", () => {
  const baseline = loadBaseline();
  assert.equal(typeof baseline.capChars, "number");
  assert.ok(Number.isFinite(baseline.capChars) && baseline.capChars >= 0);
});

// ── (2a) PRESSURE MEASUREMENT: weight, not count, and the right percentiles ─────────────────────

test("measureKnowledgeBudgetPressure: undefined when no learnings.injected rows carry a resolvable dropped id", () => {
  assert.equal(measureKnowledgeBudgetPressure([], {}), undefined);
  assert.equal(measureKnowledgeBudgetPressure([{ step: "run.start" }], { a: 100 }), undefined);
  // dropped ids present, but none resolve against entryWeights (e.g. a deleted/renamed entry) -> zero weight, uncounted
  assert.equal(measureKnowledgeBudgetPressure([injectedRow(["ghost"])], { a: 100 }), undefined);
});

test("measureKnowledgeBudgetPressure: sums per-spawn dropped WEIGHT (chars), not a dropped COUNT", () => {
  const entryWeights = { a: 60, b: 80, c: 100 };
  // one spawn drops two entries: weight is 60+80=140, NOT the count (2)
  const pressure = measureKnowledgeBudgetPressure([injectedRow(["a", "b"])], entryWeights);
  assert.ok(pressure);
  assert.equal(pressure.spawnsMeasured, 1);
  assert.equal(pressure.droppedWeightP50, 140);
  assert.equal(pressure.droppedWeightP90, 140);
});

test("measureKnowledgeBudgetPressure: p50/p90 are distinct nearest-rank percentiles across spawns", () => {
  const entryWeights: Record<string, number> = {};
  const weights = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
  weights.forEach((w, i) => (entryWeights[`e${i}`] = w));
  const lines = weights.map((_, i) => injectedRow([`e${i}`]));
  const pressure = measureKnowledgeBudgetPressure(lines, entryWeights);
  assert.ok(pressure);
  assert.equal(pressure.spawnsMeasured, 10);
  assert.equal(pressure.droppedWeightP50, 50); // nearest-rank 5th of 10 sorted ascending
  assert.equal(pressure.droppedWeightP90, 90); // nearest-rank 9th of 10 sorted ascending
});

// ── (2b) THE DERIVATION: both falsifier directions (design note v) ─────────────────────────────

test("deriveKnowledgeBudgetCap: HEAVY, SUSTAINED dropped weight + priceable cache mix -> cap ABOVE the current figure", () => {
  const entryWeights = { a: 60, b: 80, c: 100 }; // one dropped spawn = 240 chars, well over the trivial floor
  const lines = Array.from({ length: 12 }, () => injectedRow(["a", "b", "c"]));
  const pressure = measureKnowledgeBudgetPressure(lines, entryWeights);
  const cacheMix = { cacheRead: 8000, input: 1000, cacheCreation: 1000 };
  const derivation = deriveKnowledgeBudgetCap(pressure, cacheMix, DEFAULT_KNOWLEDGE_BUDGET_CHARS);

  assert.ok(pressure && pressure.droppedWeightP90 >= TRIVIAL_DROPPED_WEIGHT_CHARS);
  assert.equal(derivation.changed, true);
  assert.ok(
    derivation.recommendedCapChars > DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    `expected a raise above ${DEFAULT_KNOWLEDGE_BUDGET_CHARS}, got ${derivation.recommendedCapChars}`,
  );
  assert.equal(derivation.recommendedCapChars, DEFAULT_KNOWLEDGE_BUDGET_CHARS + derivation.deltaChars);
  assert.equal(derivation.deltaChars, 240);
  assert.equal(derivation.deltaTokens, Math.ceil(240 / CHARS_PER_TOKEN));
  assert.ok(typeof derivation.cacheHitRatioUsed === "number");
});

test("deriveKnowledgeBudgetCap: NEGLIGIBLE dropped weight -> derives the CURRENT figure unchanged, never a raise", () => {
  const entryWeights = { z: 10 }; // one short dropped entry, well under the trivial floor
  const lines = Array.from({ length: 12 }, () => injectedRow(["z"]));
  const pressure = measureKnowledgeBudgetPressure(lines, entryWeights);
  const cacheMix = { cacheRead: 8000, input: 1000, cacheCreation: 1000 }; // cache data IS available here
  const derivation = deriveKnowledgeBudgetCap(pressure, cacheMix, DEFAULT_KNOWLEDGE_BUDGET_CHARS);

  assert.ok(pressure && pressure.droppedWeightP90 < TRIVIAL_DROPPED_WEIGHT_CHARS);
  assert.equal(derivation.changed, false);
  assert.equal(derivation.recommendedCapChars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.equal(derivation.deltaChars, 0);
  assert.match(derivation.reason, /trivial|floor/i);
});

test("deriveKnowledgeBudgetCap: no measurable pressure at all (no ledger history) -> unchanged, recordable (design note iv)", () => {
  const derivation = deriveKnowledgeBudgetCap(undefined, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.equal(derivation.changed, false);
  assert.equal(derivation.recommendedCapChars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.equal(derivation.pressure, undefined);
  assert.equal(derivation.cacheHitRatioUsed, undefined);
});

test("deriveKnowledgeBudgetCap: non-trivial pressure but NO cache-mix data -> a raise that cannot be priced is not recommended", () => {
  const entryWeights = { a: 60, b: 80, c: 100 };
  const lines = Array.from({ length: 12 }, () => injectedRow(["a", "b", "c"]));
  const pressure = measureKnowledgeBudgetPressure(lines, entryWeights);
  const derivation = deriveKnowledgeBudgetCap(pressure, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS);

  assert.ok(pressure && pressure.droppedWeightP90 >= TRIVIAL_DROPPED_WEIGHT_CHARS);
  assert.equal(derivation.changed, false);
  assert.equal(derivation.recommendedCapChars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.equal(derivation.cacheHitRatioUsed, undefined);
  assert.match(derivation.reason, /cache/i);
});

// ── (2c) buildEntryWeightIndex: the id -> weight lookup the pressure derivation joins against ──

test("buildEntryWeightIndex: id -> entryBudgetWeight+1, matching selectLearnings' own budget-cost formula", () => {
  const entries: LearningEntry[] = [
    { id: "w1-x", subsystem: "test", fact: "short fact", files: [], lifecycle: "active", src: "test" },
  ];
  const index = buildEntryWeightIndex(entries);
  assert.equal(typeof index["w1-x"], "number");
  assert.ok(index["w1-x"] > 0);
  // rendered line is `- short fact [src: learnings#w1-x]` + 1 for the joining "\n"
  const expected = `- short fact [src: learnings#w1-x]`.length + 1;
  assert.equal(index["w1-x"], expected);
});
