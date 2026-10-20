// Local closed-evidence compaction. Never expires history or follows artifact links.
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, opendirSync,
  realpathSync, linkSync, renameSync, unlinkSync, fsyncSync, statfsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_IDLE_MS = 6 * 60 * 60 * 1000;
export const EVIDENCE_MAX_FILE_BYTES = 256 * 1024 ** 2;
const identityFields = ['dev','ino','size','mode','uid','gid','nlink','mtimeMs','ctimeMs'];
export const sameEvidenceIdentity = (a, b) => identityFields.every(k => a[k] === b[k]);
export function eligibleEvidence(s, now, uid) {
  return s.isFile() && s.uid === uid && s.nlink === 1 && (s.mode & 0o077) === 0
    && Number.isFinite(now) && Number.isFinite(s.mtimeMs) && Number.isFinite(s.ctimeMs)
    && now - Math.max(s.mtimeMs, s.ctimeMs) >= EVIDENCE_IDLE_MS;
}
export function evidenceDigest(fd, expectedSize) {
  const hash = createHash('sha256'), bytes = Buffer.alloc(1024 * 1024);
  let position = 0, n;
  while ((n = readSync(fd, bytes, 0, bytes.length, position)) > 0) {
    position += n;
    if (position > expectedSize || position > EVIDENCE_MAX_FILE_BYTES) throw Error('evidence-read-budget-or-growth');
    hash.update(bytes.subarray(0, n));
  }
  if (position !== expectedSize) throw Error('evidence-size-changed');
  return hash.digest('hex');
}
function privateParents(file) {
  if (resolve(file) !== file) throw Error('noncanonical-path');
  for (let p = dirname(file); p !== '/'; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022)) throw Error('unsafe-parent');
  }
}
function noOtherOpenFiles(file) {
  const p = spawnSync('/usr/sbin/lsof', ['-nP','-a','-p','^' + process.pid,'-Fpn','--',file], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 ** 2,
  });
  if (p.error || p.status !== 1 || p.stdout !== '' || p.stderr !== '') throw Error('open-or-unverified');
}
function samePayloadMetadata(a, b) {
  return ['dev','ino','size','mode','uid','gid','mtimeMs'].every(k => a[k] === b[k]);
}
export function compressEvidenceFile(file, options = {}) {
  const { apply = false, now = Date.now(), beforePublish = () => {}, afterPublish = () => {} } = options;
  const entry = { path: file, disposition: 'KEEP' };
  let fd, stagedFd, stagedIdentity, snapshot, stage, backup, published = false;
  try {
    if (process.platform !== 'darwin') throw Error('platform-not-qualified');
    privateParents(file);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const original = fstatSync(fd);
    if (!eligibleEvidence(original, now, process.getuid())) throw Error('recent-foreign-linked-or-not-private');
    if (original.size < 65536 || original.size > EVIDENCE_MAX_FILE_BYTES
        || original.blocks * 512 < original.size * .9) throw Error('small-oversize-or-already-compressed');
    if (!sameEvidenceIdentity(original, lstatSync(file))) throw Error('open-race');
    noOtherOpenFiles(file);
    entry.sha256 = evidenceDigest(fd, original.size);
    entry.logicalBytes = original.size;
    entry.beforeAllocatedBytes = original.blocks * 512;
    if (!sameEvidenceIdentity(original, fstatSync(fd)) || !sameEvidenceIdentity(original, lstatSync(file))) throw Error('hash-race');
    if (!apply) { entry.disposition = 'ELIGIBLE_SNAPSHOT_NOT_REMOVAL'; return entry; }
    const space = statfsSync(dirname(file));
    if (space.bavail * space.bsize < Math.max(64 * 1024 ** 2, original.size * 2.2)) throw Error('insufficient-stage-space');
    snapshot = join(dirname(file), '.rmd-evidence-snapshot-' + randomUUID());
    const snap = spawnSync('/usr/bin/python3', ['-I', fileURLToPath(new URL('./evidence-fd-snapshot.py', import.meta.url)), snapshot], {
      stdio: ['ignore','pipe','pipe',fd], timeout: 30000, encoding: 'utf8', maxBuffer: 65536,
    });
    if (snap.error || snap.status !== 0 || snap.stderr) throw Error('descriptor-snapshot-incomplete');
    entry.copyMethod = 'pinned-fd-fcopyfile';
    stage = join(dirname(file), '.rmd-evidence-compress-' + randomUUID());
    // ditto requires a pathname: use only our exclusive descriptor snapshot.
    const copied = spawnSync('/usr/bin/ditto', ['--hfsCompression','--noclone','--nocache','--rsrc','--extattr','--acl','--qtn',snapshot,stage], {
      timeout: 30000, encoding: 'utf8', maxBuffer: 65536,
    });
    if (copied.error || copied.status !== 0 || copied.stderr) throw Error('compression-incomplete');
    stagedFd = openSync(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const staged = fstatSync(stagedFd);
    stagedIdentity = staged;
    if (!staged.isFile() || staged.nlink !== 1 || staged.size !== original.size || staged.mode !== original.mode
        || staged.uid !== original.uid || staged.gid !== original.gid || staged.mtimeMs !== original.mtimeMs) throw Error('staged-metadata-mismatch');
    if (evidenceDigest(stagedFd, original.size) !== entry.sha256
        || !sameEvidenceIdentity(staged, fstatSync(stagedFd))
        || !sameEvidenceIdentity(staged, lstatSync(stage))) throw Error('staged-bytes-or-identity-mismatch');
    fsyncSync(stagedFd);
    if (staged.blocks * 512 >= original.blocks * 512 * .9) throw Error('insufficient-saving');
    beforePublish();
    noOtherOpenFiles(file);
    if (!sameEvidenceIdentity(original, fstatSync(fd)) || !sameEvidenceIdentity(original, lstatSync(file))) throw Error('publish-race');
    if (!sameEvidenceIdentity(staged, fstatSync(stagedFd)) || !sameEvidenceIdentity(staged, lstatSync(stage))) throw Error('stage-changed-before-publish');
    backup = join(dirname(file), '.rmd-evidence-original-' + randomUUID());
    linkSync(file, backup);
    if (!samePayloadMetadata(original, lstatSync(backup)) || lstatSync(backup).nlink !== 2) throw Error('recovery-link-race');
    renameSync(stage, file);
    stage = undefined;
    published = true;
    afterPublish({ path: file, original: backup });
    // The detached original must still be unchanged AND unused. A pre-rename
    // writer can hold that inode even after the public pathname is replaced.
    noOtherOpenFiles(backup);
    const detached = fstatSync(fd);
    if (!samePayloadMetadata(original, detached) || detached.nlink !== 1
        || !sameEvidenceIdentity(detached, lstatSync(backup))
        || evidenceDigest(fd, original.size) !== entry.sha256
        || !sameEvidenceIdentity(detached, fstatSync(fd))) throw Error('detached-original-changed');
    // Keep the verified staged descriptor across rename instead of reopening a
    // pathname whose earlier metadata check can no longer authorize an open.
    const output = fstatSync(stagedFd);
    if (evidenceDigest(stagedFd, original.size) !== entry.sha256
        || !sameEvidenceIdentity(output, fstatSync(stagedFd))
        || !sameEvidenceIdentity(output, lstatSync(file))) throw Error('published-reader-changed');
    const dirfd = openSync(dirname(file), constants.O_RDONLY);
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    if (!sameEvidenceIdentity(detached, fstatSync(fd)) || !sameEvidenceIdentity(detached, lstatSync(backup))) throw Error('original-changed-before-release');
    unlinkSync(backup); backup = undefined;
    entry.disposition = 'LOSSLESSLY_COMPRESSED';
    entry.afterAllocatedBytes = output.blocks * 512;
    entry.allocatedSavingBytes = entry.beforeAllocatedBytes - entry.afterAllocatedBytes;
  } catch (error) {
    entry.reason = error.message;
    if (published) entry.disposition = 'UNKNOWN_AFTER_PUBLICATION';
    if (backup) entry.retainedOriginalPath = backup;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (stagedFd !== undefined) closeSync(stagedFd);
    if (snapshot) { try { unlinkSync(snapshot); } catch (e) { if (e.code !== 'ENOENT') entry.snapshotCleanup = 'UNKNOWN'; } }
    if (stage) { try {
      if (!stagedIdentity || !sameEvidenceIdentity(stagedIdentity, lstatSync(stage))) throw Error('unverified-stage-cleanup');
      unlinkSync(stage);
    } catch { entry.stageCleanup = 'UNKNOWN_RETAINED'; } }
  }
  return entry;
}
export function compactEvidenceRoot(root, { apply = false, now = Date.now(), maxEntries = 10000, maxPricedBytes = 1024 ** 3 } = {}) {
  const s = lstatSync(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || realpathSync(root) !== root) throw Error('unverified-evidence-root');
  privateParents(join(root, 'candidate'));
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw Error('invalid-root-entry-budget');
  if (!Number.isSafeInteger(maxPricedBytes) || maxPricedBytes < 1 || maxPricedBytes > 1024 ** 3) throw Error('invalid-root-byte-budget');
  const started = Date.now(), result = { entries: [], incomplete: false, historyDeleted: false, modelCalls: 0 };
  let inspected = 0, pricedBytes = 0;
  const directory = opendirSync(root), names = [];
  try {
    for (let next = directory.readSync(); next; next = directory.readSync()) {
      if (names.length === maxEntries) throw Error('root-entry-budget');
      names.push(next.name);
    }
  } finally { directory.closeSync(); }
  for (const name of names.sort()) {
    if (Date.now() - started >= 45000 || ++inspected > 10000) { result.incomplete = true; break; }
    if (name.startsWith('.') || !/\.(jsonl?|log|txt|lcov)$/.test(name) || /token|credential|secret|password/i.test(name)) continue;
    const path = join(root, name), file = lstatSync(path);
    if (!eligibleEvidence(file, now, process.getuid()) || file.size < 65536 || file.size > EVIDENCE_MAX_FILE_BYTES || file.blocks * 512 < file.size * .9) continue;
    if (pricedBytes + file.size * 6 > maxPricedBytes || result.entries.length >= 256) { result.incomplete = true; break; }
    pricedBytes += file.size * 6;
    result.entries.push(compressEvidenceFile(path, { apply, now }));
  }
  return result;
}
