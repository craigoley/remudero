import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { CI_DEPENDENCY_EVIDENCE_SCHEMA, ciDependencyEvidenceForInvocation, readCiDependencyEvidence, type CiDependencyEvidenceContext } from '#scripts/lib/ci-dependency-evidence.mjs';
import { ownedFixtureDir } from '#test/helpers/owned-fixture-dir.js';
import { gitRepo } from '#test/helpers/git-repo.js';
import { lintPlanCommand } from '#src/run-task.js';
import { parseTasksFromYaml } from '#src/lib/plan.js';
import { taskRulingPin } from '#src/lib/task-linter.js';
import { recordFilingRiskRuling } from '#src/lib/risk-judge.js';
import { stringify } from 'yaml';
import { INSTRUMENT_SURFACE } from '#src/lib/review.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), producerSha = 'c'.repeat(40);
const repository = 'fixture-owner/remudero';
const credit = { source: 'trailer', prUrl: 'https://github.com/fixture-owner/remudero/pull/17', prNumber: 17, prState: 'MERGED' };
const observation = () => ({ schema: CI_DEPENDENCY_EVIDENCE_SCHEMA, complete: true,
  repository, head, base, producerSha, runId: '123', attempt: '2', producerJob: 'commitlint',
  observedAtMs: 1000, taskIds: ['ZZ-T1'], credits: { 'ZZ-T1': { trailer: credit } }, overrides: [] });

test('CI dependency receipt: producer and subtractive rulings remain review instruments', () => {
  const instruments = new RegExp(INSTRUMENT_SURFACE.join('|'));
  assert.equal(instruments.test('scripts/lib/ci-dependency-evidence.mjs'), true);
  assert.equal(instruments.test('plan/credit-overrides.yaml'), true);
  assert.equal(instruments.test('plan/credit-overrides.yaml.extra'), false);
});

function fixture(t: Parameters<typeof ownedFixtureDir>[0]) {
  const root = ownedFixtureDir(t, 'ci-dependency-receipt').dir;
  const runnerTemp = join(root, 'runner'), checkout = join(root, 'checkout');
  mkdirSync(runnerTemp); mkdirSync(checkout);
  const path = join(runnerTemp, 'evidence.json');
  // Replace only this fixture's named file. Its descriptor MODE is the policy input; no fixture
  // relies on EACCES, uid, umask-based denial or changing host permissions after creation.
  const raw = (text: string, mode = 0o400) => {
    rmSync(path, { force: true });
    const bytes = Buffer.from(text); writeFileSync(path, bytes, { mode });
    return createHash('sha256').update(bytes).digest('hex');
  };
  const write = (value: unknown, mode = 0o400) => raw(JSON.stringify(value), mode);
  const expected: CiDependencyEvidenceContext = { actions: true, repository, head, base, producerSha,
    runId: '123', attempt: '2', producerJob: 'commitlint', digest: write(observation()),
    nowMs: 2000, maxAgeMs: 5000, runnerTemp, checkout };
  return { path, expected, write, raw, root, checkout };
}

test('CI dependency receipt: canonical positive is private, immutable and closure scoped', t => {
  const f = fixture(t), before = readFileSync(f.path);
  const result = readCiDependencyEvidence(f.path, f.expected);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.dependencyEvidence({ id: 'ZZ-T1' }), { state: 'merged' });
  assert.equal(result.dependencyEvidence({ id: 'ZZ-T2' }).state, 'unknown');
  assert.deepEqual(readFileSync(f.path), before, 'consumer cannot change temporary credit, much less a native store');
});

test('CI dependency receipt: every independent invocation binding fails closed', t => {
  const f = fixture(t);
  const changes = { actions: false, repository: 'foreign/remudero', head: 'd'.repeat(40), base: 'd'.repeat(40),
    producerSha: 'd'.repeat(40), runId: '124', attempt: '3', producerJob: 'other', digest: '0'.repeat(64),
    nowMs: 999, maxAgeMs: 1 };
  for (const [key, value] of Object.entries(changes)) {
    const result = readCiDependencyEvidence(f.path, { ...f.expected, [key]: value });
    assert.equal(result.state, 'unknown', key);
    assert.equal(result.dependencyEvidence({ id: 'ZZ-T1' }).state, 'unknown', key);
  }
  for (const [key, value] of Object.entries({ runId: 123, attempt: 2, repository: '../remudero', nowMs: -1 })) {
    const digest = f.write({ ...observation(), [key]: value });
    assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest, [key]: value } as never).state, 'unknown', 'matching malformed ' + key);
  }
});

test('CI dependency receipt: incomplete malformed or extra authority cannot supply a merged answer', t => {
  const f = fixture(t);
  const values = [null, [], {}, { ...observation(), complete: false },
    { ...observation(), taskIds: ['ZZ-T1', 'ZZ-T1'] }, { ...observation(), taskIds: Array.from({ length: 33 }, (_, i) => 'ZZ-T' + i) },
    { ...observation(), credits: { 'ZZ-T2': { trailer: credit } } },
    { ...observation(), observedAtMs: '1000' }, { ...observation(), observedAtMs: -1 },
    { ...observation(), overrides: [{ task: 'ZZ-T1', pr: 17, action: 'grant-credit' }] }];
  for (const value of values) {
    const result = readCiDependencyEvidence(f.path, { ...f.expected, digest: f.write(value) });
    assert.equal(result.state, 'unknown', JSON.stringify(value));
    assert.equal(result.dependencyEvidence({ id: 'ZZ-T1' }).state, 'unknown');
  }
});

test('CI dependency receipt: native override quarantine and identity checks remain load bearing', t => {
  const f = fixture(t);
  const mark = { prUrl: credit.prUrl, prNumber: 17, reason: 'durable-credit-plan-only' };
  const values = [
    { ...observation(), overrides: [{ task: 'ZZ-T1', pr: 17, action: 'remove-credit' }] },
    { ...observation(), credits: { 'ZZ-T1': { trailer: credit, invalidated: { 'head-branch': mark } } } },
    { ...observation(), credits: { 'ZZ-T1': { trailer: { ...credit, prState: 'OPEN' } } } },
    { ...observation(), credits: { 'ZZ-T1': { trailer: { ...credit, prUrl: 'https://github.com/foreign/remudero/pull/17' } } } },
  ];
  for (const value of values) {
    const result = readCiDependencyEvidence(f.path, { ...f.expected, digest: f.write(value) });
    assert.equal(result.state, 'ready', 'valid receipt is not the same thing as qualifying credit');
    assert.equal(result.dependencyEvidence({ id: 'ZZ-T1' }).state, 'unknown');
  }
  const sibling = { source: 'head-branch', prUrl: 'https://github.com/fixture-owner/remudero/pull/18', prNumber: 18, prState: 'MERGED' };
  const value = { ...observation(), credits: { 'ZZ-T1': { trailer: credit, 'head-branch': sibling, invalidated: { trailer: mark } } } };
  assert.deepEqual(readCiDependencyEvidence(f.path, { ...f.expected, digest: f.write(value) }).dependencyEvidence({ id: 'ZZ-T1' }), { state: 'merged' });
});

test('CI dependency receipt: real filesystem rejects missing corrupt writable oversized checkout and symlink inputs', t => {
  const f = fixture(t);
  assert.equal(readCiDependencyEvidence(join(f.root, 'absent'), f.expected).state, 'unknown');
  const writableDigest = f.write(observation(), 0o600);
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest: writableDigest }).state, 'unknown');
  const corruptDigest = f.raw('{');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest: corruptDigest }).state, 'unknown');
  const huge = f.write('x'.repeat(65536));
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest: huge }).state, 'unknown');
  f.expected.digest = f.write(observation());
  const link = join(f.expected.runnerTemp, 'symlink'); symlinkSync(f.path, link);
  assert.equal(readCiDependencyEvidence(link, f.expected).state, 'unknown');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, checkout: f.expected.runnerTemp }).state, 'unknown');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, runnerTemp: f.checkout }).state, 'unknown');
  const fifo = join(f.expected.runnerTemp, 'fifo');
  execFileSync('mkfifo', [fifo]);
  assert.equal(readCiDependencyEvidence(fifo, f.expected).state, 'unknown', 'FIFO without a writer must not block');
});

test('CI dependency receipt: actual invocation binds git head base and clean plan without changing local defaults', t => {
  const f = fixture(t), repo = gitRepo({ scope: t, kind: 'ci-receipt-checkout' });
  const sha = repo.git('rev-parse', 'HEAD');
  const value = { ...observation(), head: sha, base: sha, observedAtMs: Date.now() };
  const env: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: repo.dir,
    GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', RUNNER_TEMP: f.expected.runnerTemp,
    RMD_CI_DEPENDENCY_EVIDENCE: f.path, RMD_CI_DEPENDENCY_PRODUCER_SHA: producerSha,
    RMD_CI_DEPENDENCY_DIGEST: f.write(value) };
  assert.deepEqual(ciDependencyEvidenceForInvocation(['--base', 'HEAD'], env, repo.dir)!({ id: 'ZZ-T1' }), { state: 'merged' });
  for (const args of [[], ['--base'], ['--base', 'missing-branch'], ['--base', 'HEAD', '--plan', 'elsewhere/tasks.yaml']]) {
    assert.equal(ciDependencyEvidenceForInvocation(args, env, repo.dir)!({ id: 'ZZ-T1' }).state, 'unknown');
  }
  assert.equal(ciDependencyEvidenceForInvocation([], {}, repo.dir), undefined);
  assert.equal(ciDependencyEvidenceForInvocation([], { ...env, GITHUB_ACTIONS: 'false' }, repo.dir), undefined);
  assert.equal(ciDependencyEvidenceForInvocation([], env, f.checkout), undefined, 'unrelated fixture checkouts receive no authority');
  mkdirSync(join(repo.dir, 'plan')); writeFileSync(join(repo.dir, 'plan/tasks.yaml'), '[]\n');
  repo.git('add', 'plan'); repo.git('commit', '-qm', 'test: changed plan');
  const next = repo.git('rev-parse', 'HEAD');
  env.RMD_CI_DEPENDENCY_DIGEST = f.write({ ...value, head: next, base: next });
  mkdirSync(join(repo.dir, 'plan/tasks.d')); writeFileSync(join(repo.dir, 'plan/tasks.d/untracked.yaml'), '[]\n');
  assert.equal(ciDependencyEvidenceForInvocation(['--base', 'HEAD'], env, repo.dir)!({ id: 'ZZ-T1' }).state, 'unknown');
  writeFileSync(join(repo.dir, '.gitignore'), 'plan/tasks.d/untracked.yaml\n');
  assert.equal(ciDependencyEvidenceForInvocation(['--base', 'HEAD'], env, repo.dir)!({ id: 'ZZ-T1' }).state, 'unknown', 'ignored shards are still consumed plan inputs');
  writeFileSync(join(repo.dir, 'plan/tasks.yaml'), '# dirty\n[]\n');
  assert.equal(ciDependencyEvidenceForInvocation(['--base', 'HEAD'], env, repo.dir)!({ id: 'ZZ-T1' }).state, 'unknown');
});

test('CI dependency receipt: merge-base invocation binds the fork rather than a moving main tip', t => {
  const f = fixture(t), repo = gitRepo({ scope: t, kind: 'ci-receipt-fork' });
  const fork = repo.git('rev-parse', 'HEAD');
  repo.git('branch', 'feature');
  repo.git('commit', '--allow-empty', '-qm', 'test: main advances');
  repo.git('checkout', '-q', 'feature');
  repo.git('commit', '--allow-empty', '-qm', 'test: feature advances');
  const head = repo.git('rev-parse', 'HEAD');
  const env: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: repo.dir,
    GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', RUNNER_TEMP: f.expected.runnerTemp,
    RMD_CI_DEPENDENCY_EVIDENCE: f.path, RMD_CI_DEPENDENCY_PRODUCER_SHA: producerSha,
    RMD_CI_DEPENDENCY_DIGEST: f.write({ ...observation(), head, base: fork, observedAtMs: Date.now() }) };
  assert.deepEqual(ciDependencyEvidenceForInvocation(['--base', 'main', '--merge-base'], env, repo.dir)!({ id: 'ZZ-T1' }), { state: 'merged' });
  assert.equal(ciDependencyEvidenceForInvocation(['--base', 'main'], env, repo.dir)!({ id: 'ZZ-T1' }).state, 'unknown');
});

test('online filing lint consumes verified dependency evidence while retaining its online checks', async t => {
  const repo = gitRepo({ scope: t, kind: 'online-dependency-evidence' });
  mkdirSync(join(repo.dir, 'plan/tasks.d'), { recursive: true });
  mkdirSync(join(repo.dir, 'src/lib'), { recursive: true });
  writeFileSync(join(repo.dir, 'src/lib/subject.ts'), 'export const value = 1;\n');
  mkdirSync(join(repo.dir, 'test'));
  writeFileSync(join(repo.dir, 'test/proof.test.ts'), 'import { test } from "node:test"; test("controlled dependency evidence fixture", () => {});\n');
  const record = (id: string, depends: string[], machine = false) => `- id: ${id}\n  title: "A dependency evidence fixture ${id}"\n  repo: remudero\n  depends_on: [${depends.join(', ')}]\n  type: implement\n  verify: human\n  risk: low\n  status: queued\n  attempts: 0\n  ${machine ? 'author_class: machine\n  origin: flow-blocker:own-red:required checks red' : 'origin: fixture'}\n  files: [src/lib/subject.ts, test/proof.test.ts]\n  acceptance:\n    - claim: "The controlled fixture holds"\n      proof: "unit test: controlled dependency evidence fixture"\n`;
  writeFileSync(join(repo.dir, 'plan/tasks.yaml'), record('ZZ-T1', []));
  repo.git('add', '.'); repo.git('commit', '-qm', 'test: dependency plan');
  const base = repo.git('rev-parse', 'HEAD');
  const pending = parseTasksFromYaml(record('ZZ-T2', ['ZZ-T1'], true).replace('verify: human', 'verify: auto'), 'online-evidence-fixture')[0]!;
  const admitted = recordFilingRiskRuling(pending, { verdict: 'operator', action: 'proceed', confidence: 1,
    reasons: ['isolated fixture ruling'], judgedAt: new Date(0).toISOString() }, taskRulingPin);
  writeFileSync(join(repo.dir, 'plan/tasks.d/ZZ-T2-filing.yaml'), stringify([admitted]));
  repo.git('add', '.'); repo.git('commit', '-qm', 'test: machine filing');
  const effects: string[] = [], lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts: unknown[]) => void lines.push(parts.join(' '));
  try {
    const result = await lintPlanCommand(['--base', base], { repoRoot: repo.dir,
      loadConfig: () => { effects.push('online-config'); throw new Error('fixture has no instance configuration'); },
      resolveOwnerRepo: () => ({ owner: 'fixture-owner', repo: 'remudero' }),
      openPlanShardSlugs: () => { effects.push('online-open-heads'); return []; },
      dependencyEvidence: task => { effects.push('verified:' + task.id); return { state: 'merged' }; } });
    assert.ok(effects.includes('online-config'), 'online projection is still attempted');
    assert.ok(effects.includes('online-open-heads'), 'the duplicate/open-head check remains online');
    assert.ok(effects.includes('verified:ZZ-T1'), 'dependency evidence reaches the actual admission gate: ' + lines.join('\n'));
    assert.ok(!lines.join('\n').includes('dependency credit unavailable (UNKNOWN)'), lines.join('\n'));
    assert.equal(result, 0, lines.join('\n'));
  } finally { Object.assign(console, original); }
});
