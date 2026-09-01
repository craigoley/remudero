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
  assert.match(runBodies('ci'), /npm run test:ci -- --test-shard=\$\{\{ matrix\.shard \}\}\/4/);

  const required = workflow.jobs['ci-required'];
  assert.equal(required.name, 'ci');
  assert.deepEqual(required.needs, ['ci']);
  assert.equal(required.if, '${{ always() }}');
  assert.match(runBodies('ci-required'), /SHARD_RESULT.*success/s);
  assert.match(runBodies('ci-required'), /exit 1/);
});

test('coverage sharding: four complete raw V8 artifacts are required before Node-range merge and both gates', () => {
  const shards = workflow.jobs['coverage-ratchet'];
  assert.deepEqual(shards.strategy?.matrix?.shard, [1, 2, 3, 4]);
  assert.equal(shards.strategy?.['fail-fast'], false);
  assert.equal(shards.name, 'coverage-shard (${{ matrix.shard }}/4)');
  assert.match(runBodies('coverage-ratchet'), /--test-shard=\$\{\{ matrix\.shard \}\}\/4/);
  assert.match(runBodies('coverage-ratchet'), /NODE_V8_COVERAGE=coverage\/raw node/);
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
  assert.match(runs, /expected raw V8 coverage for shard/);
  assert.match(runs, /node --expose-internals scripts\/merge-lcov\.mjs --output coverage\/lcov\.info/);
  assert.match(runs, /scripts\/diff-coverage\.mjs --lcov coverage\/lcov\.info/);
  assert.match(runs, /scripts\/coverage-ratchet\.mjs --lcov coverage\/lcov\.info/);
});

test('shard aggregators are the only always() jobs and no step can disappear conditionally', () => {
  const aggregators = new Set(['ci-required', 'coverage-ratchet-required']);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.if === '${{ always() }}') assert.ok(aggregators.has(jobId), `unexpected always() job: ${jobId}`);
    if (!aggregators.has(jobId)) continue;
    for (const step of job.steps ?? []) {
      assert.equal((step as { if?: string }).if, undefined, `${jobId}/${step.name ?? step.uses} must use fail-closed shell flow, not a step if:`);
    }
  }
});
