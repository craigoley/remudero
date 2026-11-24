// W1-T13342 — the coverage nightly runs ci.yml's coverage shard count (twelve then, sixteen since W1-T14558), so its
// shards fit their 45-minute ceiling
// with the premap step W1-T13275 added.
// MEASURED 2026-11-17 (Actions jobs API, run 44033818223, the first nightly with the premap step): at eight shards,
// shards 4 and 6 were cancelled at 45m. Their tests took 36 and 39 minutes, and compaction plus premapping added
// 5 to 9 minutes more. ci.yml's twelve-shard coverage lane runs the same selection and premap in 30 to 34 minutes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
// @ts-expect-error -- plain .mjs script, no type declarations
import { CI_COVERAGE_SHARD_COUNT, NIGHTLY_SHARD_COUNT } from "#scripts/coverage-floor.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; run?: string };
type Job = { name?: string; "timeout-minutes"?: number; strategy?: { matrix?: { shard?: number[] } }; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

const nightly = () =>
  parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/coverage-nightly.yml"), "utf8")) as Workflow;
const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? "").join("\n");
const range = (n: number) => Array.from({ length: n }, (_, k) => k + 1);

test("W1-T13342 criterion 1 and W1-T14558 criterion 2: the nightly runs sixteen shards, the same width as ci.yml's coverage lane", () => {
  assert.equal(NIGHTLY_SHARD_COUNT, 16, "coverage-floor's nightly producer expects sixteen shard exits (W1-T14558)");
  assert.equal(NIGHTLY_SHARD_COUNT, CI_COVERAGE_SHARD_COUNT, "the nightly and the PR coverage lane split the suite alike");
  const { shards } = nightly().jobs;
  assert.deepEqual(shards!.strategy!.matrix!.shard, range(NIGHTLY_SHARD_COUNT));
  assert.equal(shards!.name, `coverage-nightly-shard (\${{ matrix.shard }}/${NIGHTLY_SHARD_COUNT})`);
  const selects = [...runs(shards!).matchAll(/--shard \$\{\{ matrix\.shard \}\}\/(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(selects.length > 0, "the shard selects its slice of the suite");
  assert.deepEqual([...new Set(selects)], [NIGHTLY_SHARD_COUNT], "every slice is a sixteenth");
});

test("W1-T13342 criterion 2: every step that walks the shards walks all sixteen", () => {
  const { merge, notify } = nightly().jobs;
  const mergeRuns = runs(merge!);
  for (const counts of mergeRuns.matchAll(/--shard-count (\d+)/g)) assert.equal(Number(counts[1]), NIGHTLY_SHARD_COUNT);
  for (const kind of ["premapped", "raw"]) {
    const named = [...mergeRuns.matchAll(new RegExp(`coverage-shard-(\\d+)/${kind}\\b`, "g"))].map((m) => Number(m[1]));
    assert.deepEqual(named, range(NIGHTLY_SHARD_COUNT), `the ${kind} list names every shard once, in order`);
  }
  assert.match(mergeRuns, new RegExp(`for \\(let n = 1; n <= ${NIGHTLY_SHARD_COUNT}; n \\+= 1\\)`), "the summary records every shard's exit");
  const loops = [...`${mergeRuns}\n${runs(notify!)}`.matchAll(/for SHARD in ([\d ]+); do/g)].map((m) => m[1]!.trim().split(/ +/).map(Number));
  assert.equal(loops.length, 2, "the red-shard exit gate and the delivery verdict");
  for (const loop of loops) assert.deepEqual(loop, range(NIGHTLY_SHARD_COUNT));
  assert.doesNotMatch(runs(notify!), /\/8\b/, "the delivery names no shard out of eight");
});

test("W1-T13342 criterion 3: invariant ceiling-unchanged, the shards keep their 45-minute ceiling and the merge its 30", () => {
  const { shards, merge } = nightly().jobs;
  assert.equal(shards!["timeout-minutes"], 45, "more shards, not a higher ceiling");
  assert.equal(merge!["timeout-minutes"], 30);
});
