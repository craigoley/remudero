import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CI_DEPENDENCY_EVIDENCE_SCHEMA, readCiDependencyEvidence, type CiDependencyEvidenceContext } from '../../../scripts/lib/ci-dependency-evidence.mjs';
import { ownedFixtureDir } from '../../helpers/owned-fixture-dir.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), producerSha = 'c'.repeat(40);
const repository = 'fixture-owner/remudero';
const credit = { source: 'trailer', prUrl: 'https://github.com/fixture-owner/remudero/pull/17', prNumber: 17, prState: 'MERGED' };
const observation = () => ({ schema: CI_DEPENDENCY_EVIDENCE_SCHEMA, complete: true,
  repository, head, base, producerSha, runId: '123', attempt: '2', producerJob: 'commitlint',
  observedAtMs: 1000, taskIds: ['ZZ-T1'], credits: { 'ZZ-T1': { trailer: credit } }, overrides: [] });

function fixture(t: Parameters<typeof ownedFixtureDir>[0]) {
  const root = ownedFixtureDir(t, 'ci-dependency-receipt').dir;
  const runnerTemp = join(root, 'runner'), checkout = join(root, 'checkout');
  mkdirSync(runnerTemp); mkdirSync(checkout);
  const path = join(runnerTemp, 'evidence.json');
  const write = (value: unknown) => {
    try { chmodSync(path, 0o600); } catch { /* The first write has no file yet. */ }
    const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(path, bytes, { mode: 0o400 }); chmodSync(path, 0o400);
    return createHash('sha256').update(bytes).digest('hex');
  };
  const expected: CiDependencyEvidenceContext = { actions: true, repository, head, base, producerSha,
    runId: '123', attempt: '2', producerJob: 'commitlint', digest: write(observation()),
    nowMs: 2000, maxAgeMs: 5000, runnerTemp, checkout };
  return { path, expected, write, root, checkout };
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
});

test('CI dependency receipt: incomplete malformed or extra authority cannot supply a merged answer', t => {
  const f = fixture(t);
  const values = [null, [], {}, { ...observation(), complete: false },
    { ...observation(), taskIds: ['ZZ-T1', 'ZZ-T1'] }, { ...observation(), taskIds: Array.from({ length: 33 }, (_, i) => 'ZZ-T' + i) },
    { ...observation(), credits: { 'ZZ-T2': { trailer: credit } } },
    { ...observation(), observedAtMs: '1000' }, { ...observation(), overrides: [{ task: 'ZZ-T1', pr: 17, action: 'grant-credit' }] }];
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
  chmodSync(f.path, 0o600);
  assert.equal(readCiDependencyEvidence(f.path, f.expected).state, 'unknown');
  writeFileSync(f.path, '{'); chmodSync(f.path, 0o400);
  const corruptDigest = createHash('sha256').update('{').digest('hex');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest: corruptDigest }).state, 'unknown');
  const huge = f.write('x'.repeat(65536));
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, digest: huge }).state, 'unknown');
  f.expected.digest = f.write(observation());
  const link = join(f.expected.runnerTemp, 'symlink'); symlinkSync(f.path, link);
  assert.equal(readCiDependencyEvidence(link, f.expected).state, 'unknown');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, checkout: f.expected.runnerTemp }).state, 'unknown');
  assert.equal(readCiDependencyEvidence(f.path, { ...f.expected, runnerTemp: f.checkout }).state, 'unknown');
});
