// W1-T13270 — the coverage-shard matrix runs sixteen shards (W1-T14558; twelve under W1-T13270), on its own count apart from ci-shard's eight.
// MEASURED 2026-11-16 (Actions jobs API, 88 coverage-shard jobs): the slowest steady shard took 38-46 min against
// its 49-min ceiling, and ci-gate's 75-min WAIT_CAP leaves no room to raise it. Twelve shards cut each shard's
// files and its post-test coverage work by a third. W1-T4436 (#7029) needed four fix rounds for consumers that
// still spelled the old count, so this suite reads every spelling of both lanes' counts and holds them apart.
// coverage-nightly.yml keeps its own 8: its shards took 21-35 min of their 45 on 2026-11-16 (run 43807112604),
// and coverage-floor's nightly producer reads NIGHTLY_SHARD_COUNT, never the PR lane's count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
// @ts-expect-error -- plain .mjs script, no type declarations
import { CI_COVERAGE_SHARD_COUNT as FLOOR_CI_COUNT, NIGHTLY_SHARD_COUNT, PRODUCERS } from "#scripts/coverage-floor.mjs";
// @ts-expect-error -- plain .mjs script, no type declarations
import { DEFAULT_CI_SHARD_COUNT } from "#scripts/test-tier-manifest.mjs";
import { CI_COVERAGE_SHARD_COUNT } from "#src/lib/ci-parity.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; run?: string };
type Job = { name?: string; strategy?: { matrix?: { shard?: number[] } }; steps?: Step[]; env?: Record<string, string> };
type Workflow = { jobs: Record<string, Job> };

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const workflow = (path: string) => parseYaml(read(path)) as Workflow;
const runOf = (job: Job) => (job.steps ?? []).map((s) => s.run ?? "").join("\n");
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
/** ci-gate's per-shard entries are ADVISORY; the aggregate `coverage-ratchet` and `ci` checks are the REQUIRED ones. */
const advisory = () => JSON.parse(workflow(".github/workflows/ci-gate.yml").jobs["ci-gate"].env!.ADVISORY) as string[];

/** Every `--shard <i>/<n>` count, and every `--shard-count <n>`, spelled in a job's own steps. */
function countsIn(run: string) {
  const shard = [...run.matchAll(/--shard (?:\$\{\{ matrix\.shard \}\}|\d+)\/(\d+)/g)].map((m) => Number(m[1]));
  const shardCount = [...run.matchAll(/--shard-count (\d+)/g)].map((m) => Number(m[1]));
  return { shard, shardCount };
}

test("W1-T13270 criterion 1 and W1-T14558 criterion 1: one coverage shard count, 16, is read the same from every place it is spelled", () => {
  assert.equal(CI_COVERAGE_SHARD_COUNT, 16, "src/lib/ci-parity.ts");
  assert.equal(FLOOR_CI_COUNT, CI_COVERAGE_SHARD_COUNT, "scripts/coverage-floor.mjs CI_COVERAGE_SHARD_COUNT");
  const merged = PRODUCERS.find((p: { artifact: string }) => p.artifact === "coverage-merged");
  assert.equal(merged.shards, CI_COVERAGE_SHARD_COUNT, "the merge-group producer's provenance counts ci.yml's shards");
  const nightly = PRODUCERS.find((p: { artifact: string }) => p.artifact === "coverage-nightly");
  assert.equal(nightly.shards, NIGHTLY_SHARD_COUNT, "the nightly producer counts its own workflow's shards");

  const ci = workflow(".github/workflows/ci.yml").jobs;
  const shardJob = ci["coverage-ratchet"];
  assert.equal(shardJob.name, `coverage-shard (\${{ matrix.shard }}/${CI_COVERAGE_SHARD_COUNT})`);
  assert.deepEqual(shardJob.strategy?.matrix?.shard, range(CI_COVERAGE_SHARD_COUNT));
  const selections = countsIn(runOf(shardJob));
  assert.equal(selections.shard.length, 2, "the narrow --select-candidates and the full --select-all selections");
  for (const n of selections.shard) assert.equal(n, CI_COVERAGE_SHARD_COUNT);

  const aggregator = runOf(ci["coverage-ratchet-required"]);
  assert.deepEqual(countsIn(aggregator).shardCount, [CI_COVERAGE_SHARD_COUNT], "the merge's --shard-count");
  for (const n of range(CI_COVERAGE_SHARD_COUNT)) {
    assert.ok(aggregator.includes(`--line-lcov coverage-shards/coverage-shard-${n}/lcov.info`), `line lcov ${n}`);
    assert.ok(aggregator.includes(`coverage-shards/coverage-shard-${n}/raw`), `raw dir ${n}`);
  }
  assert.ok(!aggregator.includes(`coverage-shard-${CI_COVERAGE_SHARD_COUNT + 1}/`), "no shard past the count");
  const loops = [...aggregator.matchAll(/for SHARD in ([\d ]+); do/g)].map((m) => m[1].trim());
  assert.equal(loops.length, 3, "the class, partition and merge-input loops");
  for (const loop of loops) assert.equal(loop, range(CI_COVERAGE_SHARD_COUNT).join(" "));
  assert.match(aggregator, new RegExp(`"\\$\\{#SELECTIONS\\[@\\]\\}" -eq ${CI_COVERAGE_SHARD_COUNT} \\]`));

  const coverageListed = advisory().filter((name) => name.startsWith("coverage-shard ("));
  assert.deepEqual(coverageListed, range(CI_COVERAGE_SHARD_COUNT).map((n) => `coverage-shard (${n}/${CI_COVERAGE_SHARD_COUNT})`));

  const nightlyJobs = workflow(".github/workflows/coverage-nightly.yml").jobs;
  assert.deepEqual(nightlyJobs.shards.strategy?.matrix?.shard, range(NIGHTLY_SHARD_COUNT));
  assert.deepEqual(countsIn(runOf(nightlyJobs.merge)).shardCount, [NIGHTLY_SHARD_COUNT, NIGHTLY_SHARD_COUNT]);
});

test("W1-T13270 criterion 2 and W1-T14558 criterion 3: invariant ci-shard-unchanged, every ci-shard spelling stays at 8", () => {
  assert.equal(DEFAULT_CI_SHARD_COUNT, 8, "scripts/test-tier-manifest.mjs DEFAULT_CI_SHARD_COUNT");
  const job = workflow(".github/workflows/ci.yml").jobs.ci;
  assert.equal(job.name, `ci-shard (\${{ matrix.shard }}/${DEFAULT_CI_SHARD_COUNT})`);
  assert.deepEqual(job.strategy?.matrix?.shard, range(DEFAULT_CI_SHARD_COUNT));
  const { shard } = countsIn(runOf(job));
  assert.ok(shard.length >= 3, "the plan-reading and fast-tier selections");
  for (const n of shard) assert.equal(n, DEFAULT_CI_SHARD_COUNT);
  const ciListed = advisory().filter((name) => name.startsWith("ci-shard ("));
  assert.deepEqual(ciListed, range(DEFAULT_CI_SHARD_COUNT).map((n) => `ci-shard (${n}/${DEFAULT_CI_SHARD_COUNT})`));
});
