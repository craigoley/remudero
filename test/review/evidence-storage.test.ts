import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { compactEvidenceRoot, compressEvidenceFile, eligibleEvidence, evidenceDigest,
  EVIDENCE_IDLE_MS, sameEvidenceIdentity } from '#scripts/lib/evidence-storage.mjs';
import { evidenceStorageConfig, main } from '#scripts/maintain-evidence-storage.mjs';

const uid = process.getuid!();
function fixture(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rmd-evidence-storage-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function payload(t: TestContext): { dir: string; path: string; bytes: Buffer; now: number } {
  const dir = fixture(t), path = join(dir, 'closed.log');
  writeFileSync(path, 'closed evidence bytes\n'.repeat(12000), { mode: 0o600 });
  return { dir, path, bytes: readFileSync(path), now: Date.now() + EVIDENCE_IDLE_MS + 1000 };
}
function platformRefusal(path: string, now: number): boolean {
  if (process.platform === 'darwin') return false;
  const r = compressEvidenceFile(path, { apply: true, now });
  assert.equal(r.disposition, 'KEEP'); assert.equal(r.reason, 'platform-not-qualified');
  return true;
}
test('evidence storage requires six hours on both clocks, private ownership and one link', () => {
  const now = Date.now(), s = { isFile: () => true, uid, nlink: 1, mode: 0o100600, mtimeMs: now - EVIDENCE_IDLE_MS - 1, ctimeMs: now - EVIDENCE_IDLE_MS - 1 } as Stats;
  assert.equal(eligibleEvidence(s, now, uid), true);
  for (const change of [{ mtimeMs: now }, { ctimeMs: now }, { uid: uid + 1 }, { nlink: 2 }, { mode: 0o100640 }, { isFile: () => false }, { ctimeMs: NaN }]) {
    assert.equal(eligibleEvidence({ ...s, ...change } as Stats, now, uid), false);
  }
});
test('evidence descriptor identity includes every content and ownership field', () => {
  const s = { dev: 1, ino: 2, size: 3, mode: 4, uid: 5, gid: 6, nlink: 1, mtimeMs: 7, ctimeMs: 8 } as Stats;
  assert.equal(sameEvidenceIdentity(s, { ...s } as Stats), true);
  for (const key of Object.keys(s)) assert.equal(sameEvidenceIdentity(s, { ...s, [key]: (s as unknown as Record<string, number>)[key] + 1 } as Stats), false);
});
test('evidence hashing refuses a growing or shortened physical file', t => {
  const dir = fixture(t), path = join(dir, 'fixture'); writeFileSync(path, 'two');
  const fd = openSync(path, 'r');
  try {
    assert.throws(() => evidenceDigest(fd, 1), /budget-or-growth/);
    assert.throws(() => evidenceDigest(fd, 10), /size-changed/);
    assert.match(evidenceDigest(fd, 3), /^[a-f0-9]{64}$/);
  } finally { closeSync(fd); }
});
test('missing evidence policy is default-off without scanning or creating state', t => {
  const dir = fixture(t), before = readdirSync(dir), rows: string[] = [];
  t.mock.method(console, 'log', (s: string) => rows.push(s));
  assert.deepEqual(evidenceStorageConfig(dir), { enabled: false, roots: [] });
  assert.equal(main(['--scheduled'], dir), 0);
  assert.equal(JSON.parse(rows[0]).disposition, 'NOT_RUN_POLICY_DISABLED');
  assert.deepEqual(readdirSync(dir), before);
});
test('evidence policy refuses public, linked, oversized or escaping configuration', t => {
  const dir = fixture(t), config = join(dir, '.config/remudero'); mkdirSync(config, { recursive: true });
  const path = join(config, 'evidence-storage.json');
  const policy = { schema: 'rmd-evidence-storage/v1', enabled: true, roots: [join(dir, 'closed')] };
  writeFileSync(path, JSON.stringify(policy), { mode: 0o600 });
  assert.equal(evidenceStorageConfig(dir).enabled, true);
  chmodSync(path, 0o644); assert.throws(() => evidenceStorageConfig(dir), /private-json/); chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ ...policy, roots: ['/outside'] })); assert.throws(() => evidenceStorageConfig(dir), /evidence-policy/);
  writeFileSync(path, ' '.repeat(16385)); assert.throws(() => evidenceStorageConfig(dir), /private-json/);
  rmSync(path); symlinkSync('/not/a/readable/credential', path); assert.throws(() => evidenceStorageConfig(dir));
});
test('evidence policy cannot target Git, dependency payloads or Codex sessions', t => {
  const dir = fixture(t), config = join(dir, '.config/remudero'); mkdirSync(config, { recursive: true });
  for (const suffix of ['repo/.git', 'repo/node_modules', '.codex/archived_sessions', '.codex/sessions']) {
    writeFileSync(join(config, 'evidence-storage.json'), JSON.stringify({ schema: 'rmd-evidence-storage/v1', enabled: true, roots: [join(dir, suffix)] }), { mode: 0o600 });
    assert.throws(() => evidenceStorageConfig(dir), /evidence-policy/);
  }
});
test('evidence root refuses symlinked roots and never recursively enters checkouts', t => {
  const dir = fixture(t), source = join(dir, 'source'), link = join(dir, 'link'); mkdirSync(source); symlinkSync(source, link);
  assert.throws(() => compactEvidenceRoot(link), /unverified-evidence-root/);
  mkdirSync(join(source, 'nested')); writeFileSync(join(source, 'nested/closed.log'), 'retained', { mode: 0o600 });
  assert.equal(compactEvidenceRoot(source).entries.length, 0);
  assert.equal(readFileSync(join(source, 'nested/closed.log'), 'utf8'), 'retained');
});
test('evidence root inspection refuses before allocating beyond its explicit entry budget', t => {
  const dir = fixture(t); writeFileSync(join(dir, 'one.txt'), 'retain'); writeFileSync(join(dir, 'two.txt'), 'retain');
  assert.throws(() => compactEvidenceRoot(dir, { maxEntries: 1 }), /root-entry-budget/);
  for (const maxEntries of [0, 10001, NaN]) assert.throws(() => compactEvidenceRoot(dir, { maxEntries }), /invalid-root-entry-budget/);
  assert.deepEqual(readdirSync(dir).sort(), ['one.txt', 'two.txt']);
  const f = payload(t), bounded = compactEvidenceRoot(f.dir, { now: f.now, maxPricedBytes: 1 });
  assert.equal(bounded.incomplete, true); assert.equal(bounded.entries.length, 0); assert.deepEqual(readFileSync(f.path), f.bytes);
  const eligible = compactEvidenceRoot(f.dir, { now: f.now });
  assert.equal(eligible.entries.length, 1); assert.equal(eligible.historyDeleted, false); assert.deepEqual(readFileSync(f.path), f.bytes);
  for (const maxPricedBytes of [0, 1024 ** 3 + 1, NaN]) assert.throws(() => compactEvidenceRoot(f.dir, { maxPricedBytes }), /invalid-root-byte-budget/);
});
test('evidence compression refuses real fresh files and links without changing bytes', t => {
  const f = payload(t), link = join(f.dir, 'linked.log'); symlinkSync(f.path, link);
  for (const path of [f.path, link]) assert.equal(compressEvidenceFile(path, { apply: true }).disposition, 'KEEP');
  assert.deepEqual(readFileSync(f.path), f.bytes);
});
test('closed evidence compresses through a pinned descriptor and retains ordinary-reader bytes', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const before = lstatSync(f.path), result = compressEvidenceFile(f.path, { apply: true, now: f.now });
  assert.equal(result.disposition, 'LOSSLESSLY_COMPRESSED', result.reason);
  assert.equal(result.copyMethod, 'pinned-fd-fcopyfile');
  assert.deepEqual(readFileSync(f.path), f.bytes);
  assert.ok(lstatSync(f.path).blocks < before.blocks);
  assert.deepEqual(readdirSync(f.dir), ['closed.log']);
});
test('pre-publication evidence writer is retained without replacement', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, beforePublish: () => writeFileSync(f.path, 'new writer content') });
  assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'publish-race');
  assert.equal(readFileSync(f.path, 'utf8'), 'new writer content'); assert.deepEqual(readdirSync(f.dir), ['closed.log']);
});
test('detached-original evidence writer is UNKNOWN and its newer bytes keep a recovery path', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, afterPublish: ({ original }) => writeFileSync(original, 'new detached writer content') });
  assert.equal(result.disposition, 'UNKNOWN_AFTER_PUBLICATION'); assert.equal(result.reason, 'detached-original-changed');
  assert.ok(result.retainedOriginalPath); assert.equal(readFileSync(result.retainedOriginalPath, 'utf8'), 'new detached writer content');
  assert.deepEqual(readFileSync(f.path), f.bytes);
});
test('post-publication public-path writer is not overwritten and the original is retained', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, afterPublish: ({ path }) => writeFileSync(path, 'new public writer content') });
  assert.equal(result.disposition, 'UNKNOWN_AFTER_PUBLICATION'); assert.ok(result.retainedOriginalPath);
  assert.equal(readFileSync(f.path, 'utf8'), 'new public writer content'); assert.deepEqual(readFileSync(result.retainedOriginalPath), f.bytes);
});
test('a replaced stage pathname is refused before publication and its new bytes are retained', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  let replaced: string | undefined;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, beforePublish: () => {
    replaced = join(f.dir, readdirSync(f.dir).find(n => n.startsWith('.rmd-evidence-compress-'))!);
    renameSync(replaced, join(f.dir, 'verified-stage-held')); writeFileSync(replaced, 'foreign replacement', { mode: 0o600 });
  } });
  assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'stage-changed-before-publish');
  assert.equal(readFileSync(replaced!, 'utf8'), 'foreign replacement'); assert.deepEqual(readFileSync(f.path), f.bytes);
});
test('a replaced public pathname cannot be confused with the retained published descriptor', t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const result = compressEvidenceFile(f.path, { apply: true, now: f.now, afterPublish: ({ path }) => {
    renameSync(path, join(f.dir, 'published-inode-held')); writeFileSync(path, 'new public inode', { mode: 0o600 });
  } });
  assert.equal(result.disposition, 'UNKNOWN_AFTER_PUBLICATION'); assert.equal(result.reason, 'published-reader-changed');
  assert.equal(readFileSync(f.path, 'utf8'), 'new public inode'); assert.deepEqual(readFileSync(result.retainedOriginalPath!), f.bytes);
});
test('another process holding the evidence descriptor prevents compaction', async t => {
  const f = payload(t); if (platformRefusal(f.path, f.now)) return;
  const child = spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1],"r"); process.stdout.write("ready\\n"); setTimeout(()=>{},5000)', f.path], { stdio: ['ignore','pipe','pipe'] });
  try {
    await once(child.stdout!, 'data');
    const result = compressEvidenceFile(f.path, { apply: true, now: f.now });
    assert.equal(result.disposition, 'KEEP'); assert.equal(result.reason, 'open-or-unverified');
    assert.deepEqual(readFileSync(f.path), f.bytes);
  } finally { child.kill('SIGTERM'); await once(child, 'close'); }
});
test('no-op evidence pass preserves referenced-sized history and creates no receipt files', t => {
  const dir = fixture(t), path = join(dir, 'history.json'); writeFileSync(path, '{"retained":true}', { mode: 0o600 });
  const result = compactEvidenceRoot(dir, { apply: true });
  assert.equal(result.historyDeleted, false); assert.equal(result.entries.length, 0);
  assert.deepEqual(readdirSync(dir), ['history.json']); assert.equal(readFileSync(path, 'utf8'), '{"retained":true}');
});
test('evidence maintenance CLI rejects apply, arbitrary roots and retention-expiry overrides', () => {
  for (const args of [['--apply'], ['--root=/'], ['--expire=1'], ['--scheduled','--force']]) assert.throws(() => main(args), /usage:/);
  const r = spawnSync(process.execPath, ['scripts/maintain-evidence-storage.mjs', '--force'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stderr).disposition, 'UNKNOWN');
});
test('enabled maintenance executes its real no-op defaults and preserves immutable non-no-op receipts', t => {
  const home = fixture(t), root = join(home, 'evidence'); mkdirSync(root);
  const config = join(home, '.config/remudero'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'evidence-storage.json'), JSON.stringify({ schema: 'rmd-evidence-storage/v1', enabled: true, roots: [root] }), { mode: 0o600 });
  const logs: string[] = []; t.mock.method(console, 'log', (s: string) => logs.push(s));
  assert.equal(main(['--status'], home), 0); assert.equal(JSON.parse(logs.at(-1)!).enabled, true);
  assert.equal(main(['--scheduled'], home), 0); // Real native pressure query and default compaction when normal.
  if (process.platform !== 'darwin') return;
  const normal = { readPressure: () => ({ status: 0, stdout: '1' }) };
  assert.equal(main(['--scheduled'], home, normal), 0);
  const state = join(home, '.local/state/remudero/evidence-maintenance');
  assert.deepEqual(readdirSync(state), ['source-cursor.json']);
  const uncertain = { ...normal, compactRoot: () => ({ entries: [{ path: 'fixture-only', disposition: 'UNKNOWN_AFTER_PUBLICATION' }], incomplete: true, historyDeleted: false as const, modelCalls: 0 as const }) };
  assert.equal(main(['--scheduled'], home, uncertain), 0); const receipt = JSON.parse(logs.at(-1)!).receipt;
  assert.equal(JSON.parse(logs.at(-1)!).disposition, 'UNKNOWN'); assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).incomplete, true);
  const retained = readFileSync(receipt); assert.equal(main(['--scheduled'], home, normal), 0); assert.deepEqual(readFileSync(receipt), retained);
  assert.equal(existsSync(join(state, 'source-maintenance.lock')), false);
  assert.equal(main(['--scheduled'], home, { readPressure: () => ({ status: 0, stdout: '2' }) }), 0); assert.equal(JSON.parse(logs.at(-1)!).disposition, 'NOT_RUN_MEMORY');
});
test('maintenance never steals an existing lock and releases only its own lock on invalid cursor', t => {
  if (process.platform !== 'darwin') return;
  const home = fixture(t), root = join(home, 'evidence'), config = join(home, '.config/remudero'); mkdirSync(root); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'evidence-storage.json'), JSON.stringify({ schema: 'rmd-evidence-storage/v1', enabled: true, roots: [root] }), { mode: 0o600 });
  const state = join(home, '.local/state/remudero/evidence-maintenance'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, 'source-maintenance.lock'); mkdirSync(lock); writeFileSync(join(lock, 'foreign'), 'retain');
  const normal = { readPressure: () => ({ status: 0, stdout: '1' }) }, logs: string[] = []; t.mock.method(console, 'log', (s: string) => logs.push(s));
  assert.equal(main(['--scheduled'], home, normal), 0); assert.equal(JSON.parse(logs.at(-1)!).disposition, 'NOT_RUN_EXISTING_LOCK'); assert.equal(readFileSync(join(lock, 'foreign'), 'utf8'), 'retain');
  rmSync(lock, { recursive: true }); writeFileSync(join(state, 'source-cursor.json'), '{"nextRoot":99}', { mode: 0o600 });
  assert.throws(() => main(['--scheduled'], home, normal), /invalid-root-cursor/); assert.equal(existsSync(lock), false);
});
test('evidence installer is explicit, quote-safe, preserves policy and adds no schedule', t => {
  const dir = fixture(t), prefix = join(dir, "account with ' quote"); mkdirSync(prefix, { mode: 0o700 });
  const args = ['deploy/mac/install-evidence-storage.sh', '--prefix', prefix];
  const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') };
  const first = spawnSync('/bin/bash', args, { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(first.status, 0, first.stderr);
  const policyPath = join(prefix, '.config/remudero/evidence-storage.json');
  assert.equal(JSON.parse(readFileSync(policyPath, 'utf8')).enabled, false);
  const wrapper = join(prefix, '.local/bin/remudero-storage-maintenance');
  const command = spawnSync(wrapper, ['--force'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(command.status, 1); assert.equal(JSON.parse(command.stderr).disposition, 'UNKNOWN');
  const keepPolicy = '{"schema":"rmd-evidence-storage/v1","enabled":false,"roots":[],"operatorNote":"retain"}';
  writeFileSync(policyPath, keepPolicy);
  const second = spawnSync('/bin/bash', args, { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(second.status, 0, second.stderr); assert.equal(readFileSync(policyPath, 'utf8'), keepPolicy);
  assert.ok(!existsSync(join(prefix, 'Library/LaunchAgents')));
  assert.ok(!existsSync(join(prefix, '.config/systemd')));
});
