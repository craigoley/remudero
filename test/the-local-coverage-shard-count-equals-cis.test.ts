import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

import { CI_COVERAGE_SHARD_COUNT, coverageShardConcurrency } from "../src/lib/ci-parity.js";

test("test/the-local-coverage-shard-count-equals-cis.test.ts: local coverage matches CI's matrix and stays CPU-bounded", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, { strategy: { matrix: { shard: number[] } } }>;
  };
  const shards = workflow.jobs["coverage-ratchet"].strategy.matrix.shard;
  assert.ok(Array.isArray(shards) && shards.length > 0, "CI must declare coverage shards");
  assert.equal(CI_COVERAGE_SHARD_COUNT, shards.length);

  for (const cpus of [1, 2, 3, 4, shards.length, shards.length + 1, shards.length * 2]) {
    assert.equal(coverageShardConcurrency(cpus), Math.min(cpus, shards.length), `CPU count ${cpus}`);
  }
  assert.equal(coverageShardConcurrency(2.9), 2);
  for (const cpus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(coverageShardConcurrency(cpus), 1, `invalid CPU count ${cpus}`);
  }
});
