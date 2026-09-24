import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// @ts-expect-error — plain .mjs, no declaration file (same convention as this repo's other
// scripts/*.mjs-importing suites, e.g. test/an-unmeasured-test-file-is-not-free-to-the-sharder.test.ts).
import { DEFAULT_CI_SHARD_COUNT, proposalIsMaterial } from "../scripts/test-tier-manifest.mjs";
// @ts-expect-error — plain .mjs, no declaration file.
import { assertExpectedShardCount } from "../scripts/coverage-merge-ratchet.mjs";

// ── W1-T4436 ──────────────────────────────────────────────────────────────────────────────────
//
// MEASURED 2026-09-24 over the 150 most recent merged PRs: final-head CI is only 16% of total PR
// time, but its own p75 is 25 minutes (the SOURCE coverage lane), while runner-queueing delay is
// negligible (job-start p90 41s). Doubling the `ci` and `coverage-ratchet` matrices from 4 to 8
// shards roughly halves that slowest stage without adding queueing cost.
//
// design (i): ONE canonical shard count, read by both GitHub Actions matrices
// (.github/workflows/ci.yml), test-tier-manifest.mjs's own `--shard`/`--shard-count` defaults,
// and the coverage aggregator (scripts/coverage-merge-ratchet.mjs + the ci.yml steps that
// require every shard's artifact). YAML has no import statement, so ci.yml's own occurrences are
// kept in lockstep BY HAND, the same convention this file already uses for cross-file constants
// (see e.g. ci.yml's HEAVY-band `timeout-minutes` comments against ci-gate.yml's
// WAIT_CAP_SECONDS) — this suite is what pins that hand-kept invariant with a falsifier.
//
// design (ii): set to 8 for both lanes — pinned directly below, never re-derived from a comment.
//
// FALSIFIER (named by the task record): leave the aggregator at four and this suite's second
// test finds shards 5-8 ignored — exercised directly against
// scripts/coverage-merge-ratchet.mjs's own artifact-count guard, not just against ci.yml's text.

const CANONICAL_SHARD_COUNT = 8;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const CI_GATE_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");
const TEST_TIER_MANIFEST_SOURCE_PATH = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

type CiStep = { name?: string; run?: string };
type CiJob = {
  name?: string;
  strategy?: { matrix?: { shard?: unknown[] } };
  steps?: CiStep[];
};
type CiDoc = { jobs: Record<string, CiJob> };

function loadCiDoc(): CiDoc {
  return parseYaml(readFileSync(CI_YAML_PATH, "utf8")) as CiDoc;
}

function loadCiYamlText(): string {
  return readFileSync(CI_YAML_PATH, "utf8");
}

function loadCiGateYamlText(): string {
  return readFileSync(CI_GATE_YAML_PATH, "utf8");
}

function stepNamed(job: CiJob, name: string): CiStep {
  const step = job.steps?.find((s) => s.name === name);
  assert.ok(step?.run, `expected a "${name}" step with a run body`);
  return step!;
}

const SHARD_LIST = Array.from({ length: CANONICAL_SHARD_COUNT }, (_unused, i) => i + 1);

// ── acceptance 1: every shard consumer derives one shard count ─────────────────────────────────

test('W1-T4436: every shard consumer derives one shard count', () => {
  const doc = loadCiDoc();

  // The two GitHub Actions matrices this task's rationale names ("both lanes").
  const ciJob = doc.jobs.ci;
  const coverageJob = doc.jobs["coverage-ratchet"];
  assert.ok(ciJob && coverageJob, "expected ci.yml to still define the `ci` and `coverage-ratchet` jobs");

  assert.deepEqual(ciJob.strategy?.matrix?.shard, SHARD_LIST, "the `ci` matrix must shard 1..8, not 1..4");
  assert.deepEqual(
    coverageJob.strategy?.matrix?.shard,
    SHARD_LIST,
    "the `coverage-ratchet` matrix must shard 1..8, not 1..4",
  );
  assert.equal(ciJob.name, "ci-shard (${{ matrix.shard }}/8)");
  assert.equal(coverageJob.name, "coverage-shard (${{ matrix.shard }}/8)");

  // No stray shard-total literal left behind: every place ci.yml passed `--shard <n>/4` (or
  // `4/4` as a fallback denominator, or a loop bound `1 2 3 4`) to test-tier-manifest.mjs must
  // now read 8 — this is the "derives one shard count" property applied to the actual text a
  // reverted or half-finished edit would leave behind.
  const ciYamlText = loadCiYamlText();
  assert.ok(!ciYamlText.includes("matrix.shard }}/4"), "no `matrix.shard }}/4` denominator may remain in ci.yml");
  assert.ok(!/shard: \[1, 2, 3, 4\]/.test(ciYamlText), "no 4-element `shard:` matrix array may remain in ci.yml");
  assert.ok(!ciYamlText.includes("--shard 1/4"), "test-slow's plan-reading probe must also read 8, not 4");
  assert.ok(ciYamlText.includes("--shard 1/8"), "test-slow's plan-reading probe must read the canonical 8");

  // test-slow (not itself a matrix job) derives the same count for its own probe shard.
  const testSlowStep = stepNamed(doc.jobs["test-slow"], "Establish whether the exact plan-reading matrix owns this diff (W1-T3191)");
  assert.match(testSlowStep.run!, /--shard 1\/8\b/);

  // ci-gate.yml's own registry (test/every-pr-check-is-required-or-advisory.test.ts's own
  // subject) must name exactly the real derived check-run set — one ADVISORY entry per real
  // shard, at the real denominator, or that census suite reddens on a stale/missing entry.
  const ciGateYamlText = loadCiGateYamlText();
  for (const n of SHARD_LIST) {
    assert.ok(ciGateYamlText.includes(`"ci-shard (${n}/8)"`), `ci-gate.yml must register ci-shard (${n}/8)`);
    assert.ok(ciGateYamlText.includes(`"coverage-shard (${n}/8)"`), `ci-gate.yml must register coverage-shard (${n}/8)`);
  }
  assert.ok(!ciGateYamlText.includes('"ci-shard (1/4)"'), "no stale 4-shard ci-gate.yml entry may remain");
  assert.ok(!ciGateYamlText.includes('"coverage-shard (1/4)"'), "no stale 4-shard ci-gate.yml entry may remain");

  // The flake-retry-aggregate job's `--propose` call must name the coverage matrix's own count
  // explicitly (the function it drives, proposalIsMaterial, documents that it "does not guess").
  assert.ok(
    ciYamlText.includes("--propose --proposed test-tier-manifest.next.json --shard-count 8"),
    "the --propose call must pass --shard-count 8 explicitly, matching the real coverage matrix",
  );

  // scripts/test-tier-manifest.mjs's own single JS-side constant — the one export a caller
  // outside ci.yml (a local run, `rmd preflight`-style tooling, or another script) derives when
  // it does not pass its own --shard/--shard-count.
  assert.equal(DEFAULT_CI_SHARD_COUNT, CANONICAL_SHARD_COUNT);

  // Prove that constant is actually WIRED as the default, not merely declared and unused
  // elsewhere: a fixture whose shard assignment differs between 4 and 8 shards but not between
  // (nothing) and 8 shards proves the unqualified call really resolves to 8.
  function manifestFrom(durations: number[]) {
    const files: Record<string, number> = {};
    durations.forEach((d, i) => {
      files[String.fromCharCode(97 + i)] = d;
    });
    return { thresholdMs: 5000, files };
  }
  const committed = manifestFrom([800, 700, 600, 500, 400, 300, 200, 100]);
  const proposed = manifestFrom([100, 700, 600, 500, 400, 300, 200, 800]); // swap the endpoints
  assert.equal(
    proposalIsMaterial(committed, proposed, 4),
    false,
    "sanity: this fixture's endpoint swap must NOT move any file's shard at count=4",
  );
  assert.equal(
    proposalIsMaterial(committed, proposed, 8),
    true,
    "sanity: this fixture's endpoint swap MUST move a file's shard at count=8",
  );
  assert.equal(
    proposalIsMaterial(committed, proposed),
    true,
    "proposalIsMaterial's own default parameter must resolve to 8, not the old 4",
  );

  // And the source text names DEFAULT_CI_SHARD_COUNT as both defaults' expression — a second,
  // independent reader of the same fact as the behavioural checks above, in case a future edit
  // reintroduces a second, un-derived literal beside the shared constant.
  const manifestSource = readFileSync(TEST_TIER_MANIFEST_SOURCE_PATH, "utf8");
  assert.match(manifestSource, /shardCount = DEFAULT_CI_SHARD_COUNT/);
  assert.match(manifestSource, /Number\(shardCountRaw\) : DEFAULT_CI_SHARD_COUNT/);
});

// ── acceptance 2: the coverage aggregator requires exactly that many shard artifacts ───────────

test('W1-T4436: the coverage aggregator requires exactly that many shard artifacts', () => {
  const doc = loadCiDoc();
  const coverageRequired = doc.jobs["coverage-ratchet-required"];
  assert.ok(coverageRequired, "expected ci.yml to still define coverage-ratchet-required");

  const artifactStep = stepNamed(coverageRequired, "Require downloaded coverage shard artifacts");
  assert.match(artifactStep.run!, /for SHARD in 1 2 3 4 5 6 7 8; do/);
  assert.ok(!/for SHARD in 1 2 3 4; do/.test(artifactStep.run!), "the artifact-count loop must not still stop at 4");

  const mergeStep = stepNamed(coverageRequired, "Merge raw V8 coverage shards before assigning LCOV branch indexes");
  assert.match(mergeStep.run!, /for SHARD in 1 2 3 4 5 6 7 8; do/);
  for (const n of SHARD_LIST) {
    assert.ok(
      mergeStep.run!.includes(`coverage-shards/coverage-shard-${n}/raw`),
      `the merge command must list shard ${n}'s raw directory`,
    );
  }
  assert.match(mergeStep.run!, /--shard-count 8\b/);

  // THE FALSIFIER, EXERCISED DIRECTLY: scripts/coverage-merge-ratchet.mjs's own artifact-count
  // guard (assertExpectedShardCount) is what ci.yml's `--shard-count 8` flag drives. If the
  // aggregator had stayed at 4 (either by never adding this guard, or by a caller still passing
  // --shard-count 4 against 8 real shard directories), this is exactly where shards 5-8 would
  // have gone silently ignored — here, giving it real 8-shard evidence against an unmoved
  // expectation of 4 is refused outright, naming the mismatch, rather than quietly merging only
  // the first 4 and dropping the rest.
  const eightRealShardDirs = SHARD_LIST.map((n) => `coverage-shards/coverage-shard-${n}/raw`);
  assert.doesNotThrow(() => assertExpectedShardCount(eightRealShardDirs, 8));
  assert.throws(
    () => assertExpectedShardCount(eightRealShardDirs, 4),
    /expected exactly 4 shard director\(y\/ies\), got 8/,
    "an aggregator still expecting 4 shards must refuse 8 real shard directories rather than silently dropping 5-8",
  );
  // The symmetric case: an aggregator that only assembled 4 directories while 8 shards actually
  // ran (e.g. a partial download) must also refuse, rather than certifying a partial merge.
  assert.throws(
    () => assertExpectedShardCount(eightRealShardDirs.slice(0, 4), 8),
    /expected exactly 8 shard director\(y\/ies\), got 4/,
  );
  // A caller that never states an expectation (the per-shard --compact-output invocation, which
  // stages exactly one directory at a time) is untouched — this guard is additive, not a new
  // requirement on every caller.
  assert.doesNotThrow(() => assertExpectedShardCount(["coverage/raw"], undefined));
});
