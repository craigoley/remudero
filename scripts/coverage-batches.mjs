#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireTestSlotAsync, lowPriorityCommand, TEST_SLOT_LEASE_MS, testSlotProcessFacts } from '../src/lib/test-slot.ts';
import { testFileEstimates } from '../src/lib/host-memory-learning.ts';
import { prepareJudgedRun, judgedNodeTestArgs, judgeRun, testFilesInArgv } from './pure-test-pool.mjs';
import { extractCoverageFlags, readCiYaml, withLcovDestination } from './diff-coverage-local.mjs';
import { gitOrThrow } from './lib/git.mjs';
import { isMainModule } from './lib/argv.mjs';
import { pinWorkspaceScratchRoot, sampleWorkspaceUsage, workspaceUsageEvidence } from '../src/lib/workspace-usage.ts';
import { coverageDiskAdmission, coverageDiskProfile } from './lib/coverage-disk-profile.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const MERGER = fileURLToPath(new URL('./coverage-merge-ratchet.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('./diff-coverage.mjs', import.meta.url));

/** Inspect and hash one opened artifact, with fixed-size reads. A prior path stat cannot pin
 * the file subsequently read; reject links, truncation, mutation and a replaced final path. */
export function coverageArtifactDigest(path, { read = readSync } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1) {
      throw new Error('coverage artifact must be a non-empty regular file');
    }
    const digest = createHash('sha256'), bytes = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(bytes.length, before.size - offset);
      const count = read(fd, bytes, 0, length, offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > length) throw new Error('coverage artifact read is incomplete');
      digest.update(bytes.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
        current.uid !== before.uid || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) throw new Error('coverage artifact changed while being hashed');
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

/** Await actual child close, including its stdio. Forward only this runner's signals and retain
 * the original outcome; an interrupted child which reports zero cannot qualify a batch. */
export function runCoverageCommand(args, { cwd, env, signal: abort, terminateAfterMs = 5000, log = console.error,
  spawnProcess = spawn } = {}) {
  return new Promise((done) => {
    const command = lowPriorityCommand(process.execPath, args);
    const child = spawnProcess(command.file, command.args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    let error, interrupted, escalation;
    const stop = (reason = 'lease-lost', signal = 'SIGTERM') => {
      interrupted = reason; child.kill(signal);
      if (!escalation) escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, Number.isFinite(terminateAfterMs) && terminateAfterMs >= 0 ? Math.min(5000, terminateAfterMs) : 5000);
    };
    const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => stop(signal, signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const onAbort = () => stop();
    abort?.addEventListener('abort', onAbort, { once: true });
    if (abort?.aborted) onAbort();
    child.on('error', (failure) => { error = failure.message; log(error); });
    child.on('close', (status, signal) => {
      for (const [name, handler] of handlers) process.off(name, handler);
      abort?.removeEventListener('abort', onAbort); clearTimeout(escalation);
      done({ status: status ?? 1, signal, error, interrupted });
    });
  });
}

/** Refresh is not proof of ownership: existing lease writers may report a lost refresh through
 * diagnostics. Pin and re-read the actual authority before/after each phase and while it runs. */
export function guardCoverageLease(slot) {
  const claim = JSON.parse(slot.childEnvironment?.RMD_TEST_SLOT_PARENT ?? 'null');
  if (!claim || typeof claim.path !== 'string' || !claim.nonce || !claim.start || !Number.isSafeInteger(claim.pid) ||
      claim.pid < 1 || !Number.isSafeInteger(claim.concurrency) || claim.concurrency < 1) throw new Error('slot has no physical owner claim');
  const pin = lstatSync(claim.path);
  const parent = lstatSync(dirname(claim.path)), parentReal = realpathSync(dirname(claim.path));
  const namespace = () => process.platform === 'linux' ? readlinkSync('/proc/self/ns/mnt') : 'host';
  const initialNamespace = namespace();
  const verify = () => {
    const dir = lstatSync(dirname(claim.path));
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.dev !== parent.dev || dir.ino !== parent.ino ||
        realpathSync(dirname(claim.path)) !== parentReal || namespace() !== initialNamespace) throw new Error('slot parent or namespace changed');
    const fd = openSync(claim.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 65536 || st.dev !== pin.dev || st.ino !== pin.ino || st.uid !== pin.uid ||
          (process.getuid && st.uid !== process.getuid())) throw new Error('slot physical identity changed');
      const bytes = Buffer.alloc(65537), count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count === bytes.length) throw new Error('slot record exceeds byte bound');
      const held = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (Object.hasOwn(held, 'releaseRequestedAt') || held.pid !== claim.pid || held.ownerNonce !== claim.nonce ||
          held.processStart !== claim.start || held.concurrency !== claim.concurrency ||
          testSlotProcessFacts(held.pid)?.start !== held.processStart) throw new Error('slot authority lost');
      const after = lstatSync(claim.path);
      if (after.dev !== st.dev || after.ino !== st.ino || after.uid !== st.uid || after.isSymbolicLink()) throw new Error('slot path replaced');
    } finally { closeSync(fd); }
  };
  verify(); return verify;
}

export function releaseCoverageLease(slot) {
  const claim = JSON.parse(slot.childEnvironment?.RMD_TEST_SLOT_PARENT ?? 'null');
  slot.release();
  // Borrowed parent leases deliberately remain. A lease this process created must leave no
  // same-owner canonical reservation; silent release diagnostics are not cleanup confirmation.
  if (claim?.pid !== process.pid) return;
  let fd;
  try {
    fd = openSync(claim.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd), bytes = Buffer.alloc(65537);
    if (!st.isFile() || st.size > 65536) throw new Error('released slot state is unknown');
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count === bytes.length) throw new Error('released slot state exceeds byte bound');
    const holder = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (holder.ownerNonce === claim.nonce) throw new Error('owned slot release is unconfirmed');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function batchFlags(flags, dir, lcov) {
  const args = withLcovDestination(flags, lcov);
  // Keep every reporter, with private destinations for this batch's TAP and durations.
  for (let i = 0; i < args.length; i++) {
    const prefix = '--test-reporter-destination=';
    if (!args[i].startsWith(prefix)) continue;
    const value = args[i].slice(prefix.length);
    if (value === 'stderr') args[i] = prefix + join(dir, 'tap.log');
    else if (value !== 'stdout' && value !== lcov) args[i] = prefix + join(dir, `reporter-${i}.json`);
  }
  return [...args.filter((arg) => !arg.startsWith('--test-concurrency=')), '--test-concurrency=1'];
}

/** Serial batches reuse the pinned raw-range merger. Only a closed, fully judged batch may
 * compact and dispose its raw scratch; all manifests, per-batch LCOV and failures remain. */
export async function runCoverageBatches({ cwd = process.cwd(), flags, files, batchSize, lcov, keepRaw = false,
  base = 'origin/main', diskProfile, diskProfileMode = 'caller-supplied',
  estimatedPeakBasis = diskProfile ? 'declared-profile' : 'not-supplied' }, { run = runCoverageCommand, acquire = acquireTestSlotAsync, log = console.error } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batch size must be a positive integer');
  const root = realpathSync(cwd);
  const selected = [...new Set(files.flatMap((file) => {
    const expanded = testFilesInArgv([file], root);
    if (!expanded.length) throw new Error(`test selection is empty: ${file}`);
    return expanded;
  }))];
  if (!selected.length) throw new Error('coverage batches require physical test files');
  for (const file of selected) {
    const path = realpathSync(resolve(root, file));
    if (!path.startsWith(root + sep) || !statSync(path).isFile()) throw new Error(`test path escapes checkout: ${file}`);
  }
  gitOrThrow(['ls-files', '--error-unmatch', '--', ...selected], { cwd: root });
  const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: root }).trim();
  gitOrThrow(['diff', '--exit-code', 'HEAD', '--'], { cwd: root });
  mkdirSync(dirname(lcov), { recursive: true });
  const output = mkdtempSync(join(dirname(lcov), 'rmd-local-batches-'));
  const receiptPath = join(output, 'execution.json');
  const scratchRoots = new Map([[output, pinWorkspaceScratchRoot(output)]]);
  const observe = () => sampleWorkspaceUsage(root, { scratchRoots: [...scratchRoots.values()] });
  const samples = [observe()];
  const receipt = { version: 1, head, selected, batchSize, state: 'not-run', batches: [],
    resourceScope: 'workspace-and-registered-scratch', diskProfileMode, diskProfile: diskProfile ?? null, estimatedPeakBasis,
    inputs: selected.map((file) => ({ file, sha256: hash(readFileSync(resolve(root, file))) })) };
  const save = () => {
    receipt.resources = workspaceUsageEvidence(samples);
    writeFileSync(receiptPath + '.part', JSON.stringify(receipt, null, 2) + '\n');
    renameSync(receiptPath + '.part', receiptPath);
  };
  save(); log(`coverage-batches: receipt ${receiptPath}`);
  const slot = await acquire('coverage:local-batches', { slots: 1, waitBoundMs: 0, filePeaks: testFileEstimates(selected) });
  let heartbeat, monitor, lost, released = false;
  const abort = new AbortController();
  const env = { ...process.env, ...slot.childEnvironment, NODE_TEST_CONTEXT: undefined,
    NODE_DISABLE_COMPILE_CACHE: '1', NODE_V8_COVERAGE: '' };
  try {
    if (slot.outcome !== 'acquired' || slot.executionAllowed === false) {
      receipt.reason = slot.note; save(); return { status: 75, receiptPath };
    }
    const verify = guardCoverageLease(slot);
    const check = () => { if (lost) throw lost; verify(); };
    const failLease = (error) => { lost = error; abort.abort(); };
    heartbeat = setInterval(() => { try { slot.refresh(); check(); } catch (error) { failLease(error); } }, TEST_SLOT_LEASE_MS / 3); heartbeat.unref();
    monitor = setInterval(() => { try { check(); } catch (error) { failLease(error); } }, 1000); monitor.unref();
    const phase = async (args, opts) => {
      check();
      const result = await run(args, { ...opts, signal: abort.signal });
      receipt.phases ??= []; receipt.phases.push({ args, result }); save();
      check(); return result;
    };
    const compact = [], lineLcov = [];
    for (let offset = 0; offset < selected.length; offset += batchSize) {
      slot.refresh(); check();
      samples.push(observe());
      const admission = diskProfile ? coverageDiskAdmission([root, dirname(lcov), tmpdir()], diskProfile) : undefined;
      if (admission) { receipt.diskAdmission = admission; save(); }
      if (admission && admission.state !== 'admitted') {
        receipt.state = 'not-run-disk-capacity'; receipt.reason = 'next batch cannot satisfy the supplied unchanged disk profile';
        save(); return { status: 75, receiptPath };
      }
      const batch = selected.slice(offset, offset + batchSize), dir = join(output, String(receipt.batches.length));
      mkdirSync(dir);
      const raw = mkdtempSync(join(tmpdir(), 'rmd-diff-coverage-raw-'));
      scratchRoots.set(raw, pinWorkspaceScratchRoot(raw));
      const batchLcov = join(dir, 'lcov.info'), packed = join(dir, 'compact');
      const judged = prepareJudgedRun({ makeDir: () => { const p = join(dir, 'judge'); mkdirSync(p); return p; } });
      const record = { files: batch, raw, lcov: batchLcov, tap: join(dir, 'tap.log'), state: 'running' };
      receipt.batches.push(record); receipt.state = 'running'; save();
      const result = await phase(judgedNodeTestArgs([...batchFlags(flags, dir, batchLcov), ...batch], judged.args),
        { cwd: root, env: { ...env, ...judged.env, NODE_V8_COVERAGE: raw } });
      samples.push(observe());
      const evidence = judged.read();
      const verdict = judgeRun(batch, { status: result.interrupted ? 1 : result.status, pool: false, root, ...evidence });
      Object.assign(record, { result, verdict }); save();
      if (verdict.status !== 0 || !verdict.complete) throw new Error(`coverage batch failed: ${verdict.problems.join('; ')}`);
      const batchDigest = coverageArtifactDigest(batchLcov);
      const compressed = await phase(['--expose-internals', MERGER, '--compact-output', packed, raw], { cwd: root, env });
      if (compressed.status !== 0 || compressed.interrupted) throw new Error('coverage batch compaction failed');
      Object.assign(record, { state: 'complete', lcov: batchLcov, lcovSha256: batchDigest, compact: packed });
      samples.push(observe());
      if (!keepRaw) {
        const owned = scratchRoots.get(raw), current = pinWorkspaceScratchRoot(raw);
        if (current.path !== owned.path || current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid)
          throw new Error('raw scratch identity changed; retained without disposal');
        rmSync(raw, { recursive: true, force: true }); record.rawDisposed = true; scratchRoots.delete(raw);
      }
      samples.push(observe());
      compact.push(packed); lineLcov.push('--line-lcov', batchLcov); save();
    }
    rmSync(lcov, { force: true });
    const merged = await phase(['--expose-internals', MERGER, '--output', lcov, ...lineLcov, ...compact], { cwd: root, env });
    if (merged.status !== 0 || merged.interrupted) throw new Error('coverage aggregate failed');
    const aggregateDigest = coverageArtifactDigest(lcov);
    gitOrThrow(['diff', '--exit-code', 'HEAD', '--'], { cwd: root });
    if (gitOrThrow(['rev-parse', 'HEAD'], { cwd: root }).trim() !== head) throw new Error('head changed during coverage');
    const diff = join(output, 'head.diff');
    writeFileSync(diff, gitOrThrow(['diff', `${base}...${head}`], { cwd: root }));
    const gate = await phase([GATE, '--lcov', lcov, '--diff', diff], { cwd: root, env });
    receipt.state = gate.status === 0 && !gate.interrupted ? 'complete' : 'failed';
    receipt.aggregateSha256 = aggregateDigest; receipt.gate = gate;
    check(); releaseCoverageLease(slot); released = true; save();
    return { status: receipt.state === 'complete' ? 0 : gate.status || 1, receiptPath };
  } catch (error) {
    receipt.state = 'failed'; receipt.reason = error.message; save(); log(error.message);
    return { status: receipt.batches.find((batch) => batch.result?.status)?.result.status || 1, receiptPath };
  } finally {
    clearInterval(heartbeat); clearInterval(monitor);
    if (!released) {
      try { slot.release(); }
      catch (error) { receipt.state = 'failed'; receipt.releaseFailure = error.message; save(); throw error; }
    }
  }
}

export async function main(argv = process.argv.slice(2), { run = runCoverageBatches } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'batch-size': { type: 'string' }, base: { type: 'string', default: 'origin/main' },
    lcov: { type: 'string', default: 'coverage/lcov.info' }, 'keep-raw': { type: 'boolean', default: false },
    'disk-profile': { type: 'string' },
  } });
  const disk = coverageDiskProfile(values['disk-profile']);
  const result = await run({ flags: extractCoverageFlags(readCiYaml()), files: positionals,
    batchSize: Number(values['batch-size']), lcov: resolve(values.lcov), base: values.base, keepRaw: values['keep-raw'],
    diskProfile: disk.profile, diskProfileMode: disk.mode, estimatedPeakBasis: disk.estimatedPeakBasis });
  return result.status;
}
if (isMainModule(import.meta.url)) main().then((status) => { process.exitCode = status; }).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
