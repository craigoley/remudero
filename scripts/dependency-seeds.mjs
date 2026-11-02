#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
// Standalone installs use Node's native type stripping, including the repository Clock port.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === './clock.js' && context.parentURL?.endsWith('/dependency-seeds.ts') ? './clock.ts' : specifier, context);
} });
const { configuredDependencySeedRoot, defaultDependencySeedRoot, dependencySeedConfigPath, materializeDependencySeed, observeDependencySeedReuse, sweepDependencySeeds } = await import('../src/lib/dependency-seeds.ts');

/** True when `seed` lies in a macOS home only its owner can enter (mode and ACL): no other
 * non-root account can then hold a file open there, so the owner's own lsof is the complete view. */
export function ownerOnlyHome(seed, uid, home = homedir(), exec = execFileSync, platform = process.platform) {
  if (platform !== 'darwin' || !isAbsolute(home) || !resolve(seed).startsWith(home + '/')) return false;
  const st = statSync(home);
  if (st.uid !== uid || st.mode & 0o011) return false;
  return !exec('/bin/ls', ['-led', home], { encoding: 'utf8' }).split('\n').slice(1).some(line => line.includes(' allow '));
}

export const OPEN_FILE_SCANS = '/Library/Application Support/Remudero/open-files';
const SCAN_MAX_AGE_MS = 15 * 60_000;

/** Whether root's latest scan (deploy/mac/seed-open-files.py) saw a file open in `seed`, or
 * undefined when there is no scan to trust: it and every folder above it must be root-owned and
 * writable by root alone, and it must be fresh and name this seed's store. */
export function attestedOpen(seed, { dir = OPEN_FILE_SCANS, now = Date.now(), rootUid = 0 } = {}) {
  const store = dirname(resolve(seed)), fold = p => p.toLowerCase(); // APFS here is case-insensitive
  const file = join(dir, createHash('sha256').update(fold(store)).digest('hex') + '.json');
  const trusted = st => !st.isSymbolicLink() && st.uid === rootUid && !(st.mode & 0o022);
  let fd;
  try {
    for (let p = dir; ; p = dirname(p)) {
      if (!trusted(lstatSync(p))) return undefined;
      if (p === '/' || (rootUid !== 0 && p === dir)) break; // fixtures stop at their own root-standin
    }
    // Judge and read the same open file, so nothing can swap it in between.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!trusted(fstatSync(fd))) return undefined;
    const scan = JSON.parse(readFileSync(fd, 'utf8'));
    const age = now - scan.scannedAt * 1000;
    if (scan.version !== 1 || fold(scan.root) !== fold(store) || !(age >= -60_000 && age < SCAN_MAX_AGE_MS)) return undefined;
    const prefix = fold(resolve(seed)) + '/';
    return scan.open.some(p => fold(p) === fold(resolve(seed)) || fold(p).startsWith(prefix));
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

export function seedIsOpen(seed, uid = process.getuid?.(), exec = execFileSync, ownerOnly = ownerOnlyHome, attested = attestedOpen) {
  // User lsof cannot rule out other accounts unless none of them can enter the seed's home;
  // a fresh root-owned scan of the store can.
  if (uid !== 0 && !ownerOnly(seed, uid)) {
    const seen = attested(seed);
    if (seen === undefined) throw new Error('administrator open-file scan required (or a seed store in an owner-only home)');
    return seen;
  }
  try { return exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '+D', seed], { encoding: 'utf8', timeout: 30_000 }).trim().length > 0; }
  catch (error) { if (error.status === 1 && !error.stdout?.length && !error.stderr?.length) return false; throw error; }
}

const OWNED_SCRATCH = '.rmd-owned-disposable.json';
const SCRATCH_KINDS = ['coverage', 'v8', 'dependency', 'browser'];
const pin = path => {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path ||
      st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('scratch is not a private owned directory');
  return { dev: st.dev, ino: st.ino, uid: st.uid };
};
const samePin = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const namespace = () => process.platform === 'linux'
  ? `${readlinkSync('/proc/self/ns/mnt')}:${readlinkSync('/proc/self/ns/pid')}` : 'host';

function durableJson(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 16384)
      throw new Error('unverified private receipt or ownership record');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), named = lstatSync(path);
    if ([after, named].some(s => !samePin(s, st) || s.size !== st.size || s.mtimeMs !== st.mtimeMs || s.ctimeMs !== st.ctimeMs))
      throw new Error('receipt or ownership record changed');
    fsyncSync(fd);
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}

/** Only newly allocated scratch is eligible. Existing producer trees never acquire deletion authority. */
export function allocateOwnedScratch(path, { owner, kind, consumers } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path || !/^[a-zA-Z0-9_-]{1,100}$/.test(owner ?? '') ||
      !SCRATCH_KINDS.includes(kind) || !Array.isArray(consumers) || consumers.length < 1 || consumers.length > 64 ||
      consumers.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('invalid owner scratch allocation');
  pin(dirname(path));
  // A seed or checkout is never a scratch parent, including a path nested inside one.
  for (let p = dirname(path); ; p = dirname(p)) {
    for (const name of ['.git', '.rmd-dependency-seed-root.json', '.rmd-dependency-seed.json']) {
      try {
        const st = lstatSync(join(p, name));
        if (name === '.git' && st.isDirectory()) lstatSync(join(p, name, 'HEAD'));
        throw new Error('protected scratch ancestor');
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (p === dirname(p)) break;
  }
  mkdirSync(path, { mode: 0o700 });
  const payload = join(path, 'payload'); mkdirSync(payload, { mode: 0o700 });
  const record = { version: 1, owner, kind, consumers, namespace: namespace(), root: pin(path), payload: pin(payload) };
  durableJson(join(path, OWNED_SCRATCH), record);
  return { scratch: path, payload, owner, kind, scratchRoot: { path: payload, ...record.payload } };
}

/** A producer attests closure/publication; the kernel and open-file scan independently veto activity. */
export function cleanupOwnedScratch(path, { owner, receipt, apply = false, isOpen = seedIsOpen } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('scratch path must be absolute and canonical');
  const root = pin(path), record = privateJson(join(path, OWNED_SCRATCH)).value, payload = join(path, 'payload');
  if (record.version !== 1 || record.owner !== owner || !samePin(root, record.root ?? {}) ||
      record.namespace !== namespace() || !SCRATCH_KINDS.includes(record.kind)) throw new Error('scratch owner or identity mismatch');
  if (!samePin(pin(payload), record.payload ?? {})) throw new Error('scratch payload identity changed');
  const cwd = realpathSync(process.cwd());
  if (cwd === payload || cwd.startsWith(payload + sep)) throw new Error('protected current working directory');
  if (!isAbsolute(receipt ?? '') || realpathSync(receipt) !== receipt || receipt.startsWith(path + sep))
    throw new Error('durable receipt must be outside scratch');
  const evidence = privateJson(receipt), r = evidence.value;
  if (r.version !== 1 || r.owner !== owner || r.scratch !== path || r.completed !== true || r.published !== true ||
      r.disposable !== true || r.exclusive !== true) throw new Error('receipt must attest completed exclusive disposable work and published evidence');
  const receiptDir = openSync(dirname(receipt), constants.O_RDONLY);
  try { fsyncSync(receiptDir); } finally { closeSync(receiptDir); }
  if (!Array.isArray(record.consumers) || !record.consumers.length || record.consumers.length > 64 ||
      record.consumers.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('invalid consumer ownership record');
  for (const pid of record.consumers) {
    try { process.kill(pid, 0); return { action: 'keep', reason: 'consumer still active' }; }
    catch (error) { if (error.code !== 'ESRCH') return { action: 'keep', reason: `consumer unverified: ${error.message}` }; }
  }
  if (process.platform === 'linux') {
    const mounted = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').some(line => {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
      if (!mount) throw new Error('unverified mount inventory');
      return mount === payload || mount.startsWith(payload + sep);
    });
    if (mounted) throw new Error('scratch contains borrowed mount');
  }
  // Bound traversal before deletion; linked, mounted, special or reserved content is never disposable.
  let entries = 0, observedPathBytes = 0;
  const inventory = [];
  const walk = item => {
    if (++entries > 10000) throw new Error('scratch inspection bound');
    const st = lstatSync(item);
    if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) throw new Error('scratch contains borrowed link');
    if (st.dev !== root.dev || st.uid !== root.uid || (!st.isFile() && !st.isDirectory())) throw new Error('scratch contains unverified payload');
    observedPathBytes += st.blocks * 512;
    inventory.push([item, st]);
    if (st.isDirectory()) {
      const dir = opendirSync(item);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          const name = entry.name;
          if (['.git', 'state', 'evidence', 'receipts', 'ready.json', '.rmd-dependency-seed-root.json', '.rmd-dependency-seed.json'].includes(name.toLowerCase()) || /(?:^|[.-])(lock|claim|reservation)s?$/i.test(name))
            throw new Error('scratch contains protected material');
          walk(join(item, name));
        }
      } finally { dir.closeSync(); }
    }
  };
  walk(payload);
  if (!apply) return { action: 'would-remove', reason: 'completed owner-disposable payload', observedPathBytes, entries };
  try {
    const open = isOpen(payload);
    if (open !== false) return { action: 'keep', reason: open === true ? 'open file or lent payload' : 'open-file scan unverified' };
  }
  catch (error) { return { action: 'keep', reason: `open-file scan unverified: ${error.message}` }; }
  // Record deletion intent durably before unlinking; partial failures never become confirmed cleanup.
  const result = { action: 'remove', receipt, receiptSha256: evidence.sha256, payload, entries, observedPathBytes };
  durableJson(join(path, 'cleanup-intent.json'), result);
  for (const [item, before] of inventory) {
    const current = lstatSync(item);
    if (!samePin(current, before) || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || current.nlink !== before.nlink)
      throw new Error('scratch changed before cleanup');
  }
  if (!samePin(pin(path), root) || !samePin(pin(payload), record.payload)) throw new Error('scratch identity changed before cleanup');
  rmSync(payload, { recursive: true });
  renameSync(join(path, 'cleanup-intent.json'), join(path, 'cleanup.json'));
  const dir = openSync(path, constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const checkout = ['prime', 'allocate', 'cleanup'].includes(command) ? args.shift() : undefined;
  const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  try {
  if (command === 'allocate' || command === 'cleanup') {
    if (!checkout) throw new Error('owner scratch path required');
    const result = command === 'allocate'
      ? allocateOwnedScratch(checkout, { owner: flag('--owner'), kind: flag('--kind'), consumers: flag('--consumers')?.split(',').map(Number) })
      : cleanupOwnedScratch(checkout, { owner: flag('--owner'), receipt: flag('--receipt'), apply: args.includes('--apply') });
    console.log(JSON.stringify(result)); return 0;
  }
  const root = flag('--root') ?? configuredDependencySeedRoot() ?? defaultDependencySeedRoot();
  if (command === 'enable') {
    if (!isAbsolute(root)) throw new Error('seed root must be absolute');
    const file = dependencySeedConfigPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { writeFileSync(file, JSON.stringify({ enabled: true, root }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('existing seed configuration must be reviewed before replacing it'); throw error; }
    console.log(JSON.stringify({ config: file, root }));
  } else if (command === 'prime' && checkout) {
    console.log(JSON.stringify(materializeDependencySeed(checkout, { root, sourceDir: flag('--source'), proof: args.includes('--proof') })));
  } else if (command === 'report') {
    if (args.includes('--apply')) throw new Error('report is read-only; --apply is not accepted');
    console.log(JSON.stringify(observeDependencySeedReuse(root), null, 2));
  } else if (command === 'sweep') {
    console.log(JSON.stringify(sweepDependencySeeds(root, { apply: args.includes('--apply'), isOpen: seedIsOpen }), null, 2));
  } else throw new Error('usage: dependency-seeds.mjs enable [--root PATH] | prime CHECKOUT [--source DONOR] [--proof] [--root PATH] | report [--root PATH] | sweep [--root PATH] [--apply] | allocate PATH --owner ID --kind coverage|v8|dependency|browser --consumers PID,... | cleanup PATH --owner ID --receipt FILE [--apply]');
    return 0;
  } catch (error) { console.error(`dependency-seeds: ${error.message}`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
