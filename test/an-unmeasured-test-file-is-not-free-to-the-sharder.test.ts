// W1-T3699: the duration-manifest proposal expired unread every CI run, so 300 of 1,566 test
// files stayed at the recorded-0 "unmeasured" placeholder forever and the shard allocator
// distributed them as though they cost nothing. This suite proves the five falsifiable claims:
// an unmeasured file is weighted at the measured median (not zero), the tool reports its own
// blind spot, an unchanged or sub-shard-boundary proposal opens no pull request, and a blank
// entry's first real measurement does.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type Manifest = { thresholdMs: number; files: Record<string, number> };

const SCRIPT = join(process.cwd(), "scripts", "test-tier-manifest.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  medianMeasuredDurationMs: (manifest: Manifest) => number;
  weightedDurationMs: (file: string, manifest: Manifest, medianMs?: number) => number;
  unmeasuredSummary: (
    testFiles: string[],
    manifest: Manifest,
  ) => { unmeasuredCount: number; total: number; share: number };
  balanceFilesByDuration: (testFiles: string[], manifest: Manifest, shardCount: number) => string[][];
  proposalIsMaterial: (committed: Manifest, proposed: Manifest, shardCount?: number) => boolean;
};

const { medianMeasuredDurationMs, weightedDurationMs, unmeasuredSummary, balanceFilesByDuration, proposalIsMaterial } =
  mod;

function manifest(files: Record<string, number>, thresholdMs = 5_000): Manifest {
  return { thresholdMs, files };
}

test("an unmeasured file is weighted at the median not zero", () => {
  // Measured durations: 10, 20, 90 -> median 20. An absent entry and an explicit 0 seed placeholder
  // must both land on that median, never on 0 (the bug this task exists to close).
  const m = manifest({ "test/a.test.ts": 10, "test/b.test.ts": 20, "test/c.test.ts": 90, "test/seeded.test.ts": 0 });
  const median = medianMeasuredDurationMs(m);
  assert.equal(median, 20);
  assert.equal(weightedDurationMs("test/seeded.test.ts", m, median), 20);
  assert.equal(weightedDurationMs("test/never-recorded.test.ts", m, median), 20);
  // A real measurement is never overridden by the median.
  assert.equal(weightedDurationMs("test/a.test.ts", m, median), 10);

  // The effect must actually reach the allocator: with two big measured files and two unmeasured
  // ones, weighting the unmeasured files at 0 would stack both onto the same shard as "free";
  // weighting them at the median spreads them.
  const files = ["test/big1.test.ts", "test/big2.test.ts", "test/blank1.test.ts", "test/blank2.test.ts"];
  const balancerManifest = manifest({ "test/big1.test.ts": 1000, "test/big2.test.ts": 1000 });
  const shards = balanceFilesByDuration(files, balancerManifest, 2);
  assert.equal(shards.flat().length, 4);
  assert.ok(
    shards.every((shard) => shard.includes("test/blank1.test.ts") || shard.includes("test/blank2.test.ts")),
    "each shard should receive at least one unmeasured file once it is weighted above zero",
  );
});

test("the manifest tool reports its unmeasured count and share", () => {
  const testFiles = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts"];
  const m = manifest({
    "test/a.test.ts": 10,
    "test/b.test.ts": 0, // seeded, unmeasured
    "test/c.test.ts": 30,
    // test/d.test.ts absent entirely -- also unmeasured
    "test/e.test.ts": 5,
  });
  const summary = unmeasuredSummary(testFiles, m);
  assert.equal(summary.unmeasuredCount, 2);
  assert.equal(summary.total, 5);
  assert.equal(summary.share, 0.4);
});

test("an unchanged proposal opens no pull request", () => {
  const committed = manifest({ "test/a.test.ts": 100, "test/b.test.ts": 200, "test/c.test.ts": 0 });
  const proposed = manifest({ "test/a.test.ts": 100, "test/b.test.ts": 200, "test/c.test.ts": 0 });
  assert.equal(proposalIsMaterial(committed, proposed, 2), false);
});

test("a sub-shard-boundary change opens no pull request", () => {
  // Two well-separated measured files on two shards; nudging one by a few milliseconds of
  // measurement noise must not flip which shard either lands on.
  const committed = manifest({ "test/a.test.ts": 1000, "test/b.test.ts": 10 });
  const proposed = manifest({ "test/a.test.ts": 1003, "test/b.test.ts": 11 });
  assert.equal(proposalIsMaterial(committed, proposed, 2), false);
});

test("a first real measurement produces a proposal", () => {
  const committed = manifest({ "test/a.test.ts": 100, "test/b.test.ts": 0 });
  const proposed = manifest({ "test/a.test.ts": 100, "test/b.test.ts": 5 });
  assert.equal(proposalIsMaterial(committed, proposed, 2), true);

  // Also true when the file had no entry at all before.
  const committedAbsent = manifest({ "test/a.test.ts": 100 });
  const proposedMeasured = manifest({ "test/a.test.ts": 100, "test/b.test.ts": 5 });
  assert.equal(proposalIsMaterial(committedAbsent, proposedMeasured, 2), true);
});

test("a measured entry moving enough to change its shard produces a proposal", () => {
  const committed = manifest({
    "test/a.test.ts": 1000,
    "test/b.test.ts": 900,
    "test/c.test.ts": 10,
  });
  // Shard count 2, LPT: a(1000) -> shard0, b(900) -> shard1, c(10) -> shard1 (lighter).
  const before = balanceFilesByDuration(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], committed, 2);
  assert.ok(before.some((shard) => shard.includes("test/c.test.ts") && shard.includes("test/b.test.ts")));

  // Boosting c far past b flips which shard c is greedily assigned to first, and changes the
  // resulting membership -- a real reallocation, not noise.
  const proposed = manifest({
    "test/a.test.ts": 1000,
    "test/b.test.ts": 900,
    "test/c.test.ts": 2000,
  });
  assert.equal(proposalIsMaterial(committed, proposed, 2), true);
});
