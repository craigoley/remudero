import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, {
    name?: string;
    needs?: string[];
    if?: string;
    strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
    steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};

function runBodies(jobId: string): string {
  return (workflow.jobs[jobId].steps ?? []).map((step) => step.run ?? '').join('\n');
}

test('ci sharding: all four shards run through the retry harness and collapse to the existing ci check name', () => {
  const shards = workflow.jobs.ci;
  assert.deepEqual(shards.strategy?.matrix?.shard, [1, 2, 3, 4]);
  assert.equal(shards.strategy?.['fail-fast'], false, 'one red shard must not cancel evidence from its siblings');
  assert.equal(shards.name, 'ci-shard (${{ matrix.shard }}/4)');
  const ciRuns = runBodies('ci');
  assert.match(ciRuns, /node scripts\/test-with-retry\.mjs\s+\\\s+node scripts\/test-tier-manifest\.mjs --run fast --shard \$\{\{ matrix\.shard \}\}\/4 --base "\$TIER_BASE"/);
  assert.doesNotMatch(
    ciRuns,
    /"test\/\*\*\/\*\.test\.ts"[^\n]*--test-shard/,
    'Node runtime options after the positional test glob are file patterns, so every matrix member would run the full suite',
  );

  const required = workflow.jobs['ci-required'];
  assert.equal(required.name, 'ci');
  assert.deepEqual(required.needs, ['ci']);
  assert.equal(required.if, '${{ always() }}');
  assert.match(runBodies('ci-required'), /SHARD_RESULT.*success/s);
  assert.match(runBodies('ci-required'), /exit 1/);
});

test('the slow tier is required before duration sharding removes it from the four fast shards', () => {
  const gate = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci-gate.yml'), 'utf8')) as {
    jobs: Record<string, { env?: { REQUIRED?: string; ADVISORY?: string } }>;
  };
  const env = gate.jobs['ci-gate'].env ?? {};
  const required = JSON.parse(env.REQUIRED ?? '[]') as string[];
  const advisory = JSON.parse(env.ADVISORY ?? '[]') as string[];
  assert.ok(required.includes('test-slow'), 'the slow files are no longer in ci shards, so test-slow must gate ci-gate');
  assert.ok(!advisory.includes('test-slow'), 'one check cannot be both required and advisory');
});

test('duration sharding learns from structured per-file evidence without writing the test checkout', () => {
  const shardRuns = runBodies('ci');
  assert.match(shardRuns, /RMD_TEST_DURATION_OUTPUT="\$\{RUNNER_TEMP\}\/test-duration\/shard-\$\{\{ matrix\.shard \}\}\.json"/);
  const durationUpload = workflow.jobs.ci.steps?.find((step) => step.name?.startsWith('Upload this shard\'s duration evidence'));
  assert.match(durationUpload?.uses ?? '', /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(durationUpload?.with?.name, 'test-duration-shard-${{ matrix.shard }}');
  assert.equal(durationUpload?.with?.path, '${{ runner.temp }}/test-duration');

  const aggregateRuns = runBodies('flake-retry-aggregate');
  assert.match(aggregateRuns, /test-tier-manifest\.mjs --record-evidence/);
  assert.match(aggregateRuns, /--output test-tier-manifest\.next\.json/);
  const proposalUpload = workflow.jobs['flake-retry-aggregate'].steps?.find(
    (step) => step.name === 'Publish the next duration manifest proposal',
  );
  assert.equal(proposalUpload?.with?.path, 'test-tier-manifest.next.json');
});

test('coverage sharding: four lossless V8 bundles are required before Node-range merge and both gates', () => {
  const shards = workflow.jobs['coverage-ratchet'];
  assert.deepEqual(shards.strategy?.matrix?.shard, [1, 2, 3, 4]);
  assert.equal(shards.strategy?.['fail-fast'], false);
  assert.equal(shards.name, 'coverage-shard (${{ matrix.shard }}/4)');
  assert.match(runBodies('coverage-ratchet'), /--test-shard=\$\{\{ matrix\.shard \}\}\/4/);
  assert.match(runBodies('coverage-ratchet'), /NODE_V8_COVERAGE=coverage\/raw node/);
  assert.match(runBodies('coverage-ratchet'), /scripts\/coverage-merge-ratchet\.mjs --compact-output coverage\/compact/);
  assert.doesNotMatch(runBodies('coverage-ratchet'), /cp coverage\/raw\/coverage-\*\.json/);
  const upload = shards.steps?.find((step) => step.name === 'Upload coverage shard');
  assert.match(upload?.uses ?? '', /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload?.with?.['if-no-files-found'], 'error');

  const required = workflow.jobs['coverage-ratchet-required'];
  assert.equal(required.name, 'coverage-ratchet');
  assert.deepEqual(required.needs, ['coverage-ratchet']);
  assert.equal(required.if, '${{ always() }}');
  const download = required.steps?.find((step) => step.name === 'Download coverage shards');
  assert.match(download?.uses ?? '', /^actions\/download-artifact@[0-9a-f]{40}$/);
  const runs = runBodies('coverage-ratchet-required');
  assert.match(runs, /expected compact V8 coverage for shard/);
  assert.match(runs, /node --expose-internals scripts\/coverage-merge-ratchet\.mjs --output coverage\/lcov\.info/);
  assert.match(runs, /scripts\/diff-coverage\.mjs --lcov coverage\/lcov\.info/);
  assert.match(runs, /scripts\/coverage-ratchet\.mjs --lcov coverage\/lcov\.info/);
});

test('shard aggregators are the only always() jobs and no step can disappear conditionally', () => {
  // W1-T2904: `flake-retry-aggregate` is the third. It aggregates in the same sense as the other two
  // -- collect a per-shard artifact, collapse it into one report -- and needs `always()` for the same
  // reason: the shards whose flake evidence matters most are the ones that FAILED, so a job gated on
  // `ci` succeeding would never see them. It differs only in gating nothing, which is exactly why it
  // may not live inside `ci-required`: `scanner-gate-config` refuses `continue-on-error: true`
  // anywhere in a job ci-gate REQUIRES. It is bound by this invariant's no-conditional-step half
  // exactly like the other two.
  const aggregators = new Set(['ci-required', 'coverage-ratchet-required', 'flake-retry-aggregate']);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.if === '${{ always() }}') assert.ok(aggregators.has(jobId), `unexpected always() job: ${jobId}`);
    if (!aggregators.has(jobId)) continue;
    for (const step of job.steps ?? []) {
      assert.equal((step as { if?: string }).if, undefined, `${jobId}/${step.name ?? step.uses} must use fail-closed shell flow, not a step if:`);
    }
  }
});
