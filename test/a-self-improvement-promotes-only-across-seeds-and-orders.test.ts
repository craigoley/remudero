// test/a-self-improvement-promotes-only-across-seeds-and-orders.test.ts — W1-T4669: promoting a
// learned artifact (prompt, workflow, skill, learning) requires its effect to hold over several
// INDEPENDENT seeds, each with its own shuffled task order, with a confidence interval that
// excludes zero — never a single run's gain, and never the population's natural task order alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPERIMENT_PROMOTION_VERSION,
  MIN_SEED_SHUFFLE_SEEDS,
  evaluateSeedShuffleGate,
  runSeedShuffleGate,
  seedShuffleLedgerRow,
  shuffleTaskOrderForSeed,
  type SeedRunObservation,
} from "../src/lib/experiment-promotion.js";

const TASK_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];

function observation(seed: string, effect: number): SeedRunObservation {
  return { seed, order: shuffleTaskOrderForSeed(TASK_IDS, seed), effect };
}

test("W1-T4669: a gain seen on one seed alone is not promoted", () => {
  // A single seed's +1.5% looks like a real win in isolation (the rationale's own example), but
  // one seed can never clear MIN_SEED_SHUFFLE_SEEDS, so it must never read as "promote".
  const gate = evaluateSeedShuffleGate([observation("seed-1", 0.015)], 10);
  assert.notEqual(gate.decision, "promote");
  assert.equal(gate.decision, "undecided");
  assert.equal(gate.seeds.length, 1);
  assert.match(gate.reasons.join(" "), /fewer than 3 independent seeds/);
});

test("W1-T4669: a gain that holds across shuffled seeds is promoted", () => {
  // Several independent seeds, each with its OWN shuffled task order, all agreeing the candidate
  // beats the baseline: the interval excludes zero on the high side, so the gate promotes.
  const seeds = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];
  const observations = seeds.map((seed) => observation(seed, 0.05));
  const gate = evaluateSeedShuffleGate(observations, 0);
  assert.equal(gate.decision, "promote");
  assert.ok(gate.interval.low > 0, `expected the interval's low bound to exclude zero, got ${gate.interval.low}`);
  assert.equal(gate.seeds.length, seeds.length);
  // Every seed carries its OWN shuffled order, never the population's natural order.
  for (const seed of seeds) assert.notDeepEqual(gate.orders[seed], TASK_IDS);
});

test("shuffleTaskOrderForSeed is deterministic per seed and differs across seeds", () => {
  const first = shuffleTaskOrderForSeed(TASK_IDS, "seed-alpha");
  const again = shuffleTaskOrderForSeed(TASK_IDS, "seed-alpha");
  const other = shuffleTaskOrderForSeed(TASK_IDS, "seed-beta");
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.deepEqual([...first].sort(), [...TASK_IDS].sort());
});

test("evaluateSeedShuffleGate is undecided while the interval still straddles zero and seed budget remains", () => {
  const mixed = [observation("seed-1", 0.02), observation("seed-2", -0.01), observation("seed-3", 0.015)];
  const gate = evaluateSeedShuffleGate(mixed, 5);
  assert.equal(gate.decision, "undecided");
  assert.match(gate.reasons.join(" "), /interval still includes zero/);
});

test("evaluateSeedShuffleGate rejects once the seed budget is spent without deciding", () => {
  const mixed = [observation("seed-1", 0.02), observation("seed-2", -0.01), observation("seed-3", 0.015)];
  const gate = evaluateSeedShuffleGate(mixed, 0);
  assert.equal(gate.decision, "reject");
  assert.match(gate.reasons.join(" "), /seed budget was spent/);
});

test("evaluateSeedShuffleGate rejects outright when a seed is reused, however favorable", () => {
  const reused = [observation("seed-1", 0.05), observation("seed-1", 0.05), observation("seed-2", 0.05)];
  const gate = evaluateSeedShuffleGate(reused, 10);
  assert.equal(gate.decision, "reject");
  assert.match(gate.reasons.join(" "), /seed was reused/);
});

test("evaluateSeedShuffleGate demotes to reject on a decisively negative interval", () => {
  const negative = ["seed-1", "seed-2", "seed-3", "seed-4"].map((seed) => observation(seed, -0.06));
  const gate = evaluateSeedShuffleGate(negative, 0);
  assert.equal(gate.decision, "reject");
  assert.ok(gate.interval.high < 0, `expected the interval's high bound to exclude zero, got ${gate.interval.high}`);
});

test("runSeedShuffleGate grows the seed count one at a time until the interval decides", async () => {
  let ran = 0;
  const gate = await runSeedShuffleGate({
    taskIds: TASK_IDS,
    budget: { maxSeeds: 20 },
    nextSeed: (index) => `grown-seed-${index}`,
    run: (seed, order) => {
      ran += 1;
      assert.equal(order.length, TASK_IDS.length);
      return { seed, order, effect: 0.04 };
    },
  });
  assert.equal(gate.decision, "promote");
  // Decided at the minimum seed count, never the fixed maxSeeds budget.
  assert.equal(ran, MIN_SEED_SHUFFLE_SEEDS);
  assert.equal(gate.seeds.length, MIN_SEED_SHUFFLE_SEEDS);
});

test("runSeedShuffleGate stops at the seed budget and rejects an undecided artifact", async () => {
  let ran = 0;
  const gate = await runSeedShuffleGate({
    taskIds: TASK_IDS,
    budget: { maxSeeds: 4 },
    nextSeed: (index) => `noisy-seed-${index}`,
    run: (seed, order) => {
      ran += 1;
      const noisy = [0.05, -0.05, 0.04, -0.04][ran - 1] ?? 0;
      return { seed, order, effect: noisy };
    },
  });
  assert.equal(ran, 4);
  assert.equal(gate.decision, "reject");
  assert.equal(gate.seeds.length, 4);
});

test("seedShuffleLedgerRow names the promotion, every seed, its order and the interval", () => {
  const seeds = ["seed-1", "seed-2", "seed-3"];
  const gate = evaluateSeedShuffleGate(seeds.map((seed) => observation(seed, 0.06)), 0);
  const row = seedShuffleLedgerRow("promotion:repo:skill-x", gate);
  assert.equal(row.version, EXPERIMENT_PROMOTION_VERSION);
  assert.equal(row.promotionId, "promotion:repo:skill-x");
  assert.deepEqual(row.seeds, seeds);
  for (const seed of seeds) assert.ok(Array.isArray(row.orders[seed]));
  assert.equal(typeof row.interval.estimate, "number");
  assert.equal(typeof row.interval.low, "number");
  assert.equal(typeof row.interval.high, "number");
  assert.equal(row.decision, "promote");
});
