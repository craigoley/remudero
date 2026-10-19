#!/usr/bin/env node
// Explicit opt-in, account-private policy; absence is NOT permission to scan.
import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync, realpathSync,
  mkdirSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compactEvidenceRoot } from './lib/evidence-storage.mjs';

function privateJson(path, maxBytes = 16384) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o077) || s.size > maxBytes) throw Error('unverified-private-json');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function evidenceStorageConfig(home = homedir()) {
  let config;
  try { config = privateJson(join(home, '.config/remudero/evidence-storage.json')); }
  catch (e) { if (e.code === 'ENOENT') return { enabled: false, roots: [] }; throw e; }
  if (config.schema !== 'rmd-evidence-storage/v1' || typeof config.enabled !== 'boolean'
      || !Array.isArray(config.roots) || config.roots.length > 16
      || config.roots.some(p => typeof p !== 'string' || !p.startsWith(home + '/') || resolve(p) !== p
        || /\/(\.git|node_modules|sessions|archived_sessions)(\/|$)/.test(p))
      || new Set(config.roots).size !== config.roots.length) throw Error('unverified-evidence-policy');
  return { enabled: config.enabled, roots: config.roots };
}
export function main(args = process.argv.slice(2), home = homedir()) {
  const command = args[0] ?? '--status';
  if (args.length > 1 || !['--status','--scheduled'].includes(command)) throw Error('usage: maintain-evidence-storage.mjs [--status|--scheduled]');
  const config = evidenceStorageConfig(home);
  if (command === '--status') { console.log(JSON.stringify({ schema: 'rmd-evidence-storage-status/v1', ...config, idleHours: 6, historyExpiry: false, createsSchedule: false })); return 0; }
  if (!config.enabled || config.roots.length === 0) { console.log(JSON.stringify({ disposition: 'NOT_RUN_POLICY_DISABLED', roots: config.roots.length })); return 0; }
  if (process.platform !== 'darwin') { console.log(JSON.stringify({ disposition: 'NOT_RUN_PLATFORM_UNQUALIFIED' })); return 0; }
  const pressure = spawnSync('/usr/sbin/sysctl', ['-n','kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 3000 });
  if (pressure.error || pressure.status !== 0 || pressure.stdout.trim() !== '1') { console.log(JSON.stringify({ disposition: 'NOT_RUN_MEMORY' })); return 0; }
  const state = join(home, '.local/state/remudero/evidence-maintenance');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (realpathSync(state) !== state || lstatSync(state).uid !== process.getuid() || (lstatSync(state).mode & 0o077)) throw Error('unverified-state-directory');
  const lock = join(state, 'source-maintenance.lock'), nonce = randomUUID();
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; console.log(JSON.stringify({ disposition: 'NOT_RUN_EXISTING_LOCK' })); return 0; }
  const lockIdentity = lstatSync(lock), token = join(lock, 'nonce');
  writeFileSync(token, nonce, { flag: 'wx', mode: 0o600 });
  const owned = () => {
    const s = lstatSync(lock);
    return s.dev === lockIdentity.dev && s.ino === lockIdentity.ino && s.uid === process.getuid() && readFileSync(token, 'utf8') === nonce;
  };
  try {
    const cursorPath = join(state, 'source-cursor.json');
    let cursor = 0;
    try { cursor = privateJson(cursorPath).nextRoot; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= config.roots.length) throw Error('invalid-root-cursor');
    const result = compactEvidenceRoot(config.roots[cursor], { apply: true });
    if (!owned()) throw Error('own-lock-changed');
    let receipt = null;
    // No-op scheduled passes do not create another immutable raw receipt.
    if (result.entries.length || result.incomplete) {
      receipt = join(state, 'source-evidence-' + Date.now() + '-' + nonce + '.json');
      writeFileSync(receipt, JSON.stringify({ schema: 'rmd-evidence-compaction/v1', at: new Date().toISOString(), root: config.roots[cursor], ...result }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    }
    const next = cursorPath + '.' + nonce;
    writeFileSync(next, JSON.stringify({ nextRoot: (cursor + 1) % config.roots.length }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(next, cursorPath);
    console.log(JSON.stringify({ disposition: result.entries.some(e => e.disposition === 'UNKNOWN_AFTER_PUBLICATION') ? 'UNKNOWN' : 'CLOSED_PHASE', receipt, inspectedRoot: cursor, results: result.entries.length, incomplete: result.incomplete }));
    return 0;
  } finally {
    if (!owned()) throw Error('own-lock-changed-retained');
    unlinkSync(token); rmdirSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { console.error(JSON.stringify({ disposition: 'UNKNOWN', reason: e.message })); process.exitCode = 1; }
}
