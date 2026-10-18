import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinWorkspaceScratchRoot, sampleWorkspaceUsage } from '#src/lib/workspace-usage.js';
import { ownedFixtureDir } from '#test/helpers/owned-fixture-dir.js';

test('workspace usage charges registered external scratch and avoids double counting nested roots', t => {
  const { dir } = ownedFixtureDir(t, 'external-scratch-observation');
  const workspace = join(dir, 'workspace'), scratch = join(dir, 'scratch');
  mkdirSync(workspace); mkdirSync(scratch); writeFileSync(join(scratch, 'payload'), Buffer.alloc(65536, 1));
  const pin = pinWorkspaceScratchRoot(scratch);
  const absent = sampleWorkspaceUsage(workspace, { roots: [], maxMs: 1000 });
  assert.equal(absent.generatedPathBytes, null);
  const measured = sampleWorkspaceUsage(workspace, { roots: [], scratchRoots: [pin], maxMs: 1000 });
  assert.equal(measured.completeness, 'complete');
  assert.ok(measured.generatedPathBytes! >= statSync(join(scratch, 'payload')).blocks * 512);
  const repeated = sampleWorkspaceUsage(workspace, { roots: [], scratchRoots: [pin, pin], maxMs: 1000 });
  assert.equal(repeated.generatedPathBytes, measured.generatedPathBytes);
  mkdirSync(join(workspace, 'coverage')); writeFileSync(join(workspace, 'coverage', 'evidence'), 'data');
  const plain = sampleWorkspaceUsage(workspace, { roots: ['coverage'], maxMs: 1000 });
  const both = sampleWorkspaceUsage(workspace, { roots: ['coverage'], scratchRoots: [pinWorkspaceScratchRoot(join(workspace, 'coverage'))], maxMs: 1000 });
  assert.equal(plain.generatedPathBytes, both.generatedPathBytes);
});

test('workspace usage retains replaced missing linked and foreign scratch as unknown rather than empty', t => {
  const { dir } = ownedFixtureDir(t, 'external-scratch-identity');
  const workspace = join(dir, 'workspace'), scratch = join(dir, 'scratch'); mkdirSync(workspace); mkdirSync(scratch);
  writeFileSync(join(scratch, 'evidence'), 'preserve'); const pin = pinWorkspaceScratchRoot(scratch);
  const observe = (root = pin) => sampleWorkspaceUsage(workspace, { roots: [], scratchRoots: [root], maxMs: 1000 });
  assert.equal(observe({ ...pin, uid: pin.uid + 1 }).completeness, 'unknown');
  renameSync(scratch, scratch + '-original'); mkdirSync(scratch);
  assert.equal(observe().completeness, 'unknown');
  rmSync(scratch, { recursive: true }); assert.equal(observe().completeness, 'unknown');
  symlinkSync(scratch + '-original', scratch);
  assert.equal(observe().completeness, 'unknown');
  assert.throws(() => pinWorkspaceScratchRoot(scratch), /private owned directory/);
  assert.equal(statSync(join(scratch + '-original', 'evidence')).size, 8);
});

test('workspace external scratch shares the unchanged inspection budget and never scans a borrowed child', t => {
  const { dir } = ownedFixtureDir(t, 'external-scratch-budget');
  const workspace = join(dir, 'workspace'), scratch = join(dir, 'scratch'); mkdirSync(workspace); mkdirSync(scratch);
  for (let i = 0; i < 10; i++) writeFileSync(join(scratch, String(i)), 'entry');
  const roots = [pinWorkspaceScratchRoot(scratch)];
  const bounded = sampleWorkspaceUsage(workspace, { roots: [], scratchRoots: roots, maxEntries: 2, maxMs: 1000 });
  assert.equal(bounded.completeness, 'lower-bound'); assert.ok(bounded.entries <= 2);
  symlinkSync(workspace, join(scratch, 'borrowed'));
  const linked = sampleWorkspaceUsage(workspace, { roots: [], scratchRoots: roots, maxMs: 1000 });
  assert.equal(linked.completeness, 'lower-bound');
});
