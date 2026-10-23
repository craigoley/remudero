import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {parseArgv} from './argv.mjs';
import {captureStepSync, AUTHOR_OUTPUT_LIMIT_BYTES} from './author-step-capture.mjs';
import {focusedMacWorkload, readMacAuthorAdmission, readMacFocusedAdmission} from './mac-author-admission.mjs';
import {prepareJudgedRun, judgedNodeTestArgs, closeJudgedRun} from '../pure-test-pool.mjs';
import {acquireTestSlot, TEST_FILE_PEAK_BYTES, testSlotExecutionAllowed} from '../../src/lib/test-slot.ts';

const MIB = 1024 ** 2;
const HELP = 'preflight-author.mjs --low-footprint --scratch-mib <MiB> --timeout-ms <ms> --head-ref <branch> --test <tracked test file> [--test <file> ...]: explicitly scoped local tests, NOT full author assurance; hosted gates remain required.';

export function lowFootprintOptions(argv) {
  const parsed = parseArgv(argv, {
    'low-footprint': {type: 'boolean'}, 'scratch-mib': {type: 'string'}, 'timeout-ms': {type: 'string'},
    'head-ref': {type: 'string'}, 'head-sha': {type: 'string'}, test: {type: 'string', multiple: true},
  }, {allowPositionals: false, helpText: HELP});
  if (parsed.helpRequested) return {help: true};
  const v = parsed.values, scratchBytes = Number(v['scratch-mib']) * MIB, runtimeMs = Number(v['timeout-ms']);
  if (!v['low-footprint'] || !v['head-ref'] || !v.test?.length ||
      !Number.isSafeInteger(Number(v['scratch-mib'])) ||
      ![scratchBytes, runtimeMs].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error('low-footprint requires explicit positive scratch/runtime budgets, a publication target and physical test files');
  if (!Number.isSafeInteger(2 * scratchBytes + AUTHOR_OUTPUT_LIMIT_BYTES) ||
      new Set(v.test).size !== v.test.length || v.test.some(p => !/^test\/[^\0\r\n]+\.test\.ts$/.test(p) || /[*?\[\]{}]/.test(p) ||
      p.split('/').some(part => part === '..' || part === '.')))
    throw new Error('low-footprint tests must be unique literal repository test paths; no glob or discovery fallback');
  return {scratchBytes, runtimeMs, files: v.test, headRef: v['head-ref'], headSha: v['head-sha'],
    minimumFreeBytes: 2 * scratchBytes + AUTHOR_OUTPUT_LIMIT_BYTES};
}

export function nativeAuthorCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {encoding: 'utf8', timeout: 30_000, maxBuffer: MIB, ...options});
  if (result.status !== 0 || result.error || result.signal)
    throw new Error(`low-footprint command failed: ${file}: exit=${result.status}, ${result.error?.message ?? result.signal ?? (result.stderr?.trim() || 'no diagnostic')}`);
  return result.stdout;
}

export function lowFootprintSandbox(volume) {
  const path = JSON.stringify(realpathSync(volume));
  // Native write containment, inherited by descendants. Installs/copies into node_modules refuse.
  return `(version 1)(allow default)(deny network*)(deny file-write*)
    (allow file-write* (literal "/dev/null"))
    (allow file-write* (require-all (subpath ${path}) (require-not (regex #"/node_modules/"))))`;
}

export function createBoundedAuthorScratch(bytes, {parent = tmpdir(), command = nativeAuthorCommand} = {}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % MIB !== 0) throw new Error('invalid bounded scratch capacity');
  const dir = realpathSync(mkdtempSync(join(parent, 'rmd-author-'))), identity = lstatSync(dir);
  const image = join(dir, 'scratch.dmg'), volume = join(dir, 'v');
  mkdirSync(volume);
  let attached = false;
  const release = () => {
    if (attached) { command('/usr/bin/hdiutil', ['detach', volume]); attached = false; }
    const current = lstatSync(dir);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error('bounded scratch identity changed; retained');
    rmSync(dir, {recursive: true});
  };
  try {
    command('/usr/bin/hdiutil', ['create', '-size', `${bytes / MIB}m`, '-fs', 'HFS+',
      '-type', 'UDIF', '-nospotlight', '-quiet', image]);
    const imageStat = lstatSync(image);
    if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size > bytes + statfsSync(dir).bsize)
      throw new Error('scratch image exceeded its declared backing-file budget');
    // Mark uncertain attachment before the call: a failed mount may still own a device.
    attached = true;
    command('/usr/bin/hdiutil', ['attach', image, '-mountpoint', volume, '-nobrowse', '-noautoopen', '-quiet']);
    const fs = statfsSync(volume);
    if (lstatSync(volume).dev === identity.dev || fs.blocks * fs.bsize > bytes)
      throw new Error('scratch is not a separate capacity-bounded volume');
    return {dir, volume, imageBytes: imageStat.size, writableCapacityBytes: fs.blocks * fs.bsize, release};
  } catch (error) {
    try { release(); } catch (cleanup) { error.message += `; scratch retained at ${dir}: ${cleanup.message}`; }
    throw error;
  }
}

function requireAdmission(root, scratch, minimumFreeBytes, workload) {
  const admission = workload ? readMacFocusedAdmission(root, {scratch, minimumFreeBytes, workload}) :
    readMacAuthorAdmission(root, {scratch, minimumFreeBytes});
  if (admission.state !== 'admitted') throw new Error(`low-footprint capacity NOT_RUN: ${JSON.stringify(admission)}`);
  return admission;
}

export async function runLowFootprintAuthor(argv, {root, publicationIdentity, authorEnvironment, completeTestResult,
  platform = process.platform, command = nativeAuthorCommand, makeScratch = createBoundedAuthorScratch,
  admit = requireAdmission, capture = captureStepSync, acquire = acquireTestSlot} = {}) {
  let scratch, slot, diagnostics, judged;
  const receipt = {version: 1, assurance: 'explicit-scoped-tests-only', fullAuthorValidation: 'not-run',
    hostedFullSuiteAndCoverage: 'required-pending', verdict: 'refused', files: []};
  const started = Date.now();
  try {
    const options = lowFootprintOptions(argv);
    if (options.help) return 0;
    if (platform !== 'darwin') throw new Error('low-footprint containment is Mac-only; use ordinary author validation on this platform');
    const git = args => command('git', args, {cwd: root});
    if (process.versions.node !== readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, ''))
      throw new Error('pinned Node version required');
    if (git(['status', '--porcelain']).trim()) throw new Error('commit the author tree first');
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('complete Git history required');
    git(['fetch', 'origin', 'main']);
    receipt.headSha = git(['rev-parse', 'HEAD']).trim();
    receipt.baseSha = git(['rev-parse', 'origin/main']).trim();
    receipt.publicationIdentity = publicationIdentity({headRef: options.headRef, publicationSha: options.headSha,
      headSha: receipt.headSha, baseSha: receipt.baseSha}, git);
    if (receipt.publicationIdentity.state !== 'passed') throw new Error('publication identity refused');
    const tracked = new Set(git(['ls-files', '-z']).split('\0'));
    receipt.files = options.files;
    for (const file of options.files) {
      const full = resolve(root, file);
      if (!tracked.has(file) || !lstatSync(full).isFile() || lstatSync(full).isSymbolicLink() ||
          !realpathSync(full).startsWith(realpathSync(root) + sep))
        throw new Error(`unverified physical test file: ${file}`);
    }
    git(['diff', '--check', `${receipt.baseSha}...${receipt.headSha}`]);
    const workload = focusedMacWorkload(options);
    receipt.budgets = {scratchBytes: options.scratchBytes, runtimeMs: options.runtimeMs,
      focusedWorkload: workload,
      outputBytes: AUTHOR_OUTPUT_LIMIT_BYTES, minimumFreeBytes: options.minimumFreeBytes};
    receipt.entryAdmission = admit(root, tmpdir(), options.minimumFreeBytes, workload);
    slot = acquire('author-low-footprint', {perFileBytes: TEST_FILE_PEAK_BYTES, maxConcurrency: 1});
    if (slot.outcome !== 'acquired' || slot.concurrency !== 1 || !testSlotExecutionAllowed(slot))
      throw new Error(`low-footprint NOT_RUN: ${slot.note}`);
    receipt.slot = {outcome: slot.outcome, concurrency: slot.concurrency, waitedMs: slot.waitedMs};
    receipt.freshAdmission = admit(root, tmpdir(), options.minimumFreeBytes, workload);
    mkdirSync(join(root, 'coverage'), {recursive: true});
    diagnostics = mkdtempSync(join(root, 'coverage', 'author-low-footprint-'));
    scratch = makeScratch(options.scratchBytes);
    receipt.scratch = {writableCapacityBytes: scratch.writableCapacityBytes, imageBytes: scratch.imageBytes};
    for (const dir of ['t', 'h']) mkdirSync(join(scratch.volume, dir));
    const env = {...authorEnvironment(process.env), ...slot.childEnvironment, TMPDIR: join(scratch.volume, 't'),
      HOME: join(scratch.volume, 'h'), TSX_DISABLE_CACHE: '1', npm_config_offline: 'true',
      ...(workload ? {NODE_OPTIONS: `--max-old-space-size=${workload.heapMiB}`} : {})};
    const profile = lowFootprintSandbox(scratch.volume);
    const probe = join(scratch.volume, 'probe');
    const outside = join(scratch.dir, 'outside-probe');
    const forbidden = join(scratch.volume, 'node_modules', 'forbidden');
    mkdirSync(join(scratch.volume, 'node_modules'));
    const code = 'const f=require("node:fs");f.writeFileSync(process.argv[1],"control");' +
      'for(const p of process.argv.slice(2)){let denied=false;try{f.writeFileSync(p,"forbidden")}catch(e){denied=e.code==="EPERM"||e.code==="EACCES"}if(!denied)process.exit(2)}';
    command('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', code, probe, outside, forbidden], {env});
    if (!existsSync(probe) || existsSync(outside) || existsSync(forbidden)) throw new Error('native write containment control failed');
    receipt.testAdmission = admit(root, tmpdir(), options.minimumFreeBytes, workload);
    judged = prepareJudgedRun({makeDir: () => mkdtempSync(join(scratch.volume, 'j-'))});
    const args = judgedNodeTestArgs([...(workload ? [`--max-old-space-size=${workload.heapMiB}`] : []),
      '--test', '--test-reporter=tap', '--test-concurrency=1', '--import', 'tsx',
      '--import', './test/setup/tmp-hygiene.ts', ...options.files], judged.args);
    const native = capture('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, ...args], {
      cwd: root, env: {...env, ...judged.env}, stdoutPath: join(diagnostics, 'tests.stdout.log'),
      stderrPath: join(diagnostics, 'tests.stderr.log'), resultPath: join(diagnostics, 'native.json'),
      runtimeMs: options.runtimeMs, trackParent: true, heartbeat: slot.heartbeat});
    const result = closeJudgedRun(judged, options.files, {status: native.status ?? 1, root, role: 'low-footprint'});
    judged = undefined;
    receipt.tests = {status: native.status, signal: native.signal, durationMs: native.durationMs,
      outputComplete: native.outputComplete, judge: result.verdict, error: native.error?.message};
    const noOmissions = ['cancelled', 'skipped', 'todo'].every(key =>
      new RegExp(`^# ${key} 0$`, 'm').test(`${native.stdout ?? ''}\n${native.stderr ?? ''}`));
    if (!completeTestResult(native) || !result.verdict.complete || !noOmissions)
      throw new Error('scoped tests did not complete successfully; no fallback');
    if (git(['rev-parse', 'HEAD']).trim() !== receipt.headSha || git(['status', '--porcelain']).trim())
      throw new Error('committed author inputs changed during validation');
    receipt.verdict = 'scoped-pass';
  } catch (error) { receipt.error = error.message; }
  finally {
    if (judged) {
      receipt.verdict = 'refused';
      receipt.cleanup = 'retained-unproven-child-closure';
      receipt.retainedScratch = scratch?.dir;
    } else if (scratch) {
      try { scratch.release(); receipt.cleanup = 'closed-and-removed'; }
      catch (error) { receipt.verdict = 'refused'; receipt.cleanup = 'retained'; receipt.retainedScratch = scratch.dir; receipt.cleanupError = error.message; }
    }
    if (!judged) {
      try { slot?.release(); }
      catch (error) { receipt.verdict = 'refused'; receipt.slotCleanupError = error.message; }
    }
  }
  receipt.durationMs = Date.now() - started;
  if (diagnostics) writeFileSync(join(diagnostics, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({...receipt, diagnostics}));
  return receipt.verdict === 'scoped-pass' ? 0 : 3;
}
