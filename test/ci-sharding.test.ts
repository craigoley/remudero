import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

const CI_SHARD_COUNT = workflow.jobs.ci?.strategy?.matrix?.shard?.length ?? 0;
assert.ok(CI_SHARD_COUNT > 0, "ci.yml must declare at least one shard");

function runBodies(jobId: string): string {
  return (workflow.jobs[jobId].steps ?? []).map((step) => step.run ?? '').join('\n');
}

test('ci sharding: every declared shard runs through the retry harness and collapses to the existing ci check name', () => {
  const shards = workflow.jobs.ci;
  assert.deepEqual(shards.strategy?.matrix?.shard, Array.from({ length: CI_SHARD_COUNT }, (_unused, index) => index + 1));
  assert.equal(shards.strategy?.['fail-fast'], false, 'one red shard must not cancel evidence from its siblings');
  assert.equal(shards.name, `ci-shard (\${{ matrix.shard }}/${CI_SHARD_COUNT})`);
  const ciRuns = runBodies('ci');
  assert.match(
    ciRuns,
    new RegExp(String.raw`node scripts\/test-with-retry\.mjs\s+\\\s+node scripts\/test-tier-manifest\.mjs --run fast --shard \$\{\{ matrix\.shard \}\}\/${CI_SHARD_COUNT} --base "\$TIER_BASE"`),
  );
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

test('the slow tier is required before duration sharding removes it from the fast shard matrix', () => {
  const gate = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci-gate.yml'), 'utf8')) as {
    jobs: Record<string, { env?: { REQUIRED?: string; ADVISORY?: string } }>;
  };
  const env = gate.jobs['ci-gate'].env ?? {};
  const required = JSON.parse(env.REQUIRED ?? '[]') as string[];
  const advisory = JSON.parse(env.ADVISORY ?? '[]') as string[];
  assert.ok(required.includes('test-slow'), 'the slow files are no longer in ci shards, so test-slow must gate ci-gate');
  assert.ok(!advisory.includes('test-slow'), 'one check cannot be both required and advisory');

  const slowRuns = runBodies('test-slow-shard');
  assert.match(
    slowRuns,
    /npm run --silent test:tier:check -- --base "origin\/\$\{GITHUB_BASE_REF\}"/,
    'invoke the package script so unwired-gate can prove that the tier checker is an actual gate',
  );
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

  const aggregateSteps = workflow.jobs['flake-retry-aggregate'].steps ?? [];
  const checkoutIndex = aggregateSteps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const firstDownloadIndex = aggregateSteps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.ok(checkoutIndex >= 0, 'the aggregate job must check out the scripts it executes');
  assert.ok(firstDownloadIndex > checkoutIndex, 'checkout clean deletes artifacts, so downloads must happen after checkout');
});

test('coverage sharding: every declared lossless V8 bundle is required before Node-range merge and both gates', () => {
  const shards = workflow.jobs['coverage-ratchet'];
  assert.deepEqual(shards.strategy?.matrix?.shard, Array.from({ length: CI_SHARD_COUNT }, (_unused, index) => index + 1));
  assert.equal(shards.strategy?.['fail-fast'], false);
  assert.equal(shards.name, `coverage-shard (\${{ matrix.shard }}/${CI_SHARD_COUNT})`);
  assert.match(
    runBodies('coverage-ratchet'),
    new RegExp(String.raw`test-tier-manifest\.mjs --select-all --shard \$\{\{ matrix\.shard \}\}\/${CI_SHARD_COUNT} --base HEAD\^1`),
  );
  assert.match(runBodies('coverage-ratchet'), /mapfile -t COVERAGE_TEST_FILES < coverage-test-files\.txt/);
  assert.doesNotMatch(runBodies('coverage-ratchet'), /--test-shard=/, 'coverage must use the recorded-duration selector rather than Node\'s opaque shard assignment');
  // W1-T4398: the retry wrapper hands coverage/raw to the instrumented first pass alone.
  assert.match(runBodies('coverage-ratchet'), /test-with-retry\.mjs --coverage-first-pass coverage\/raw \\\s+node --enable-source-maps/);
  // W1-T5923: each shard ships its reports already source-mapped; the aggregator replays only the range merge.
  assert.match(runBodies('coverage-ratchet'), /scripts\/coverage-merge-ratchet\.mjs --premap-output coverage\/premapped coverage\/raw/);
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

test('hosted coverage admission accepts legacy bundles and bounded manifests but refuses chunks without a manifest', () => {
  const step = workflow.jobs['coverage-ratchet-required'].steps?.find(
    candidate => candidate.name === 'Merge raw V8 coverage shards before assigning LCOV branch indexes',
  )?.run;
  assert.ok(step);
  const start = step.lastIndexOf('for SHARD in ');
  const end = step.indexOf('mkdir -p coverage', start);
  assert.ok(start >= 0 && end > start, 'execute the actual shipped artifact-admission loop');
  const guard = step.slice(start, end);
  const root = mkdtempSync(join(tmpdir(), 'rmd-hosted-corpus-admission-'));
  try {
    for (const [kind, name, accepted] of [
      ['legacy', 'coverage-bundle-1-0000000000000-0.json', true],
      ['bounded', 'coverage-corpus-1-0000000000000.json', true],
      ['premapped', 'coverage-premapped-1-0000000000000.json', true],
      ['partial', 'coverage-reports-1-0000000000000-00000000.json', false],
      ['missing', undefined, false],
    ] as const) {
      const directory = join(root, kind); mkdirSync(directory);
      for (let shard = 1; shard <= CI_SHARD_COUNT; shard++) {
        const raw = join(directory, 'coverage-shards', `coverage-shard-${shard}`, 'raw');
        mkdirSync(raw, { recursive: true });
        if (name) writeFileSync(join(raw, name), '{}');
      }
      const run = () => execFileSync('bash', ['-e', '-c', guard], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
      if (accepted) assert.doesNotThrow(run);
      else assert.throws(run, (error: unknown) => {
        const failure = error as { status: number; stdout: string };
        assert.equal(failure.status, 1);
        assert.match(failure.stdout, /expected compact V8 coverage for shard 1/);
        return true;
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shard aggregators are the only always() jobs and no step can disappear conditionally', () => {
  // W1-T2904: `flake-retry-aggregate` is the third. It aggregates in the same sense as the other two
  // -- collect a per-shard artifact, collapse it into one report -- and needs `always()` for the same
  // reason: the shards whose flake evidence matters most are the ones that FAILED, so a job gated on
  // `ci` succeeding would never see them. It differs only in gating nothing, which is exactly why it
  // may not live inside `ci-required`: `scanner-gate-config` refuses `continue-on-error: true`
  // anywhere in a job ci-gate REQUIRES. It is bound by this invariant's no-conditional-step half
  // exactly like the other two.
  const aggregators = new Set(['ci-required', 'coverage-ratchet-required', 'flake-retry-aggregate', 'test-slow']);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.if === '${{ always() }}') assert.ok(aggregators.has(jobId), `unexpected always() job: ${jobId}`);
    if (!aggregators.has(jobId)) continue;
    for (const step of job.steps ?? []) {
      assert.equal((step as { if?: string }).if, undefined, `${jobId}/${step.name ?? step.uses} must use fail-closed shell flow, not a step if:`);
    }
  }
});
