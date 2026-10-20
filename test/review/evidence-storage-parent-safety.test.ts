import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { compressEvidenceFile, EVIDENCE_IDLE_MS } from '#scripts/lib/evidence-storage.mjs';

function fixture(t: TestContext, parent = homedir(), mode?: number) {
  const base = fs.mkdtempSync(join(parent, '.rmd-evidence-parent-'));
  const dir = join(base, 'private');
  fs.mkdirSync(dir, { mode: 0o700 });
  if (mode !== undefined) fs.chmodSync(base, mode);
  const path = join(dir, 'closed.log');
  const bytes = Buffer.from('qualified closed evidence\n'.repeat(12000));
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  t.after(() => { fs.chmodSync(base, 0o700); fs.rmSync(base, { recursive: true }); });
  return { base, dir, path, bytes, now: Date.now() + EVIDENCE_IDLE_MS + 1000 };
}

// These publication operations are qualified on macOS only. Other platforms
// must assert the production refusal, not silently skip or claim native proof.
function refusesUnqualifiedPlatform(f: ReturnType<typeof fixture>): boolean {
  if (process.platform === 'darwin') return false;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
  assert.equal(result.disposition, 'KEEP');
  assert.equal(result.reason, 'platform-not-qualified');
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
  return true;
}

function compressed(f: ReturnType<typeof fixture>) {
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
  assert.equal(result.disposition, 'LOSSLESSLY_COMPRESSED', result.reason);
  assert.equal(result.publicationMethod, 'pinned-directory-atomic-exchange');
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
  assert.deepEqual(fs.readdirSync(f.dir), ['closed.log']);
}

test('evidence compaction accepts a real root-owned sticky ancestor with private publication', t => {
  const root = fs.realpathSync('/tmp'), stat = fs.lstatSync(root);
  assert.equal(stat.uid, 0); assert.ok(stat.mode & 0o1000); assert.ok(stat.mode & 0o022);
  const f = fixture(t, root); if (refusesUnqualifiedPlatform(f)) return;
  compressed(f);
});

test('evidence compaction accepts an owned sticky ancestor without changing its mode', t => {
  const f = fixture(t, homedir(), 0o1777), before = fs.lstatSync(f.base).mode;
  if (refusesUnqualifiedPlatform(f)) return;
  compressed(f); assert.equal(fs.lstatSync(f.base).mode, before);
});

test('evidence compaction refuses a non-sticky writable ancestor and preserves its bytes', t => {
  const f = fixture(t, homedir(), 0o777); if (refusesUnqualifiedPlatform(f)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
  assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'unsafe-parent');
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
});

test('evidence compaction refuses foreign sticky ownership without changing live ownership', t => {
  const f = fixture(t, homedir(), 0o1777); if (refusesUnqualifiedPlatform(f)) return;
  const original = fs.lstatSync;
  // Only this fixture metadata is substituted. Production uses the real default
  // lstat seam, and finally restores its ESM binding even if an assertion fails.
  fs.lstatSync = new Proxy(original, { apply(fn, receiver, args) {
    const stat = Reflect.apply(fn, receiver, args) as fs.Stats;
    return args[0] === f.base ? new Proxy(stat, { get(value, key, receiver) {
      return key === 'uid' ? process.getuid!() + 1 : Reflect.get(value, key, receiver);
    } }) : stat;
  } });
  syncBuiltinESMExports();
  try {
    const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
    assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'unsafe-parent');
    assert.deepEqual(fs.readFileSync(f.path), f.bytes);
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
});

test('evidence compaction still refuses shared publication beneath a trusted sticky ancestor', t => {
  const f = fixture(t, homedir(), 0o1777); fs.chmodSync(f.dir, 0o1777);
  if (refusesUnqualifiedPlatform(f)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
  assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'unverified-publication-directory');
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
});

test('evidence compaction keeps an atomic writer under a trusted sticky ancestor', t => {
  const f = fixture(t, fs.realpathSync('/tmp')); if (refusesUnqualifiedPlatform(f)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, beforeExchange() {
    const writer = join(f.dir, 'writer');
    fs.writeFileSync(writer, 'new atomic writer', { mode: 0o600 }); fs.renameSync(writer, f.path);
  } });
  assert.equal(result.disposition, 'UNKNOWN_AFTER_PUBLICATION'); assert.equal(result.reason, 'detached-original-changed');
  assert.equal(fs.readFileSync(result.retainedDisplacedPath!, 'utf8'), 'new atomic writer');
  assert.deepEqual(fs.readFileSync(result.retainedOriginalPath!), f.bytes);
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
});

test('evidence compaction refuses a symlinked ancestor before publication', t => {
  const f = fixture(t); if (refusesUnqualifiedPlatform(f)) return;
  const alias = join(f.base, 'alias'); fs.symlinkSync(f.dir, alias);
  const result = compressEvidenceFile(join(alias, 'closed.log'), { apply: true, now: f.now });
  assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'unsafe-parent');
  assert.deepEqual(fs.readFileSync(f.path), f.bytes);
});
