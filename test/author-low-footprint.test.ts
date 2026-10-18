import assert from 'node:assert/strict';
import fs, {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, realpathSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const subject = '#scripts/lib/author-low-footprint.mjs';
const {lowFootprintOptions, lowFootprintSandbox, nativeAuthorCommand, runLowFootprintAuthor} = await import(subject) as {
  lowFootprintOptions: (args: string[]) => {scratchBytes: number; minimumFreeBytes: number; files: string[]};
  lowFootprintSandbox: (path: string) => string;
  nativeAuthorCommand: (file: string, args: string[], options?: object) => string;
  runLowFootprintAuthor: (args: string[], options: object) => Promise<number>;
};
const args = ['--low-footprint', '--scratch-mib', '32', '--timeout-ms', '30000',
  '--head-ref', 'run-unfiled-1234567890123', '--test', 'test/a.test.ts'];

test('low-footprint author requires explicit bounded inputs and never discovers a full suite', () => {
  const r = lowFootprintOptions(args);
  assert.equal(r.scratchBytes, 32 * 1024 ** 2);
  assert.equal(r.minimumFreeBytes, 2 * r.scratchBytes + 100 * 1024 ** 2);
  assert.deepEqual(r.files, ['test/a.test.ts']);
  for (const flag of ['--scratch-mib', '--timeout-ms', '--head-ref', '--test']) {
    const i = args.indexOf(flag);
    assert.throws(() => lowFootprintOptions(args.filter((_, n) => n !== i && n !== i + 1)));
  }
  for (const invalid of ['0', '-1', '0.5', 'NaN', 'Infinity', '999999999999999999999'])
    assert.throws(() => lowFootprintOptions(args.map((a, i) => i === 2 ? invalid : a)));
  for (const invalid of ['test/*.test.ts', 'test/../other.test.ts', '/tmp/a.test.ts', 'test/a.test.ts\n'])
    assert.throws(() => lowFootprintOptions([...args.slice(0, -1), invalid]));
  assert.throws(() => lowFootprintOptions([...args, '--test', 'test/a.test.ts']));
  for (const flag of ['--coverage', '--full-suite', '--runtime-profile'])
    assert.throws(() => lowFootprintOptions([...args, flag]));
});

test('low-footprint author confines writes and refuses dependency payloads and networking', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rmd-low-policy-'));
  t.after(() => rmSync(dir, {recursive: true}));
  const policy = lowFootprintSandbox(dir);
  assert.ok(policy.includes('(deny file-write*)'));
  assert.ok(policy.includes('(deny network*)'));
  assert.ok(policy.includes('(require-not (regex #"/node_modules/"))'));
  assert.ok(policy.includes(JSON.stringify(realpathSync(dir))));
});

test('low-footprint command default observes real success, nonzero, spawn failure and timeout', () => {
  assert.equal(nativeAuthorCommand(process.execPath, ['-e', 'process.stdout.write("native-control")']), 'native-control');
  assert.throws(() => nativeAuthorCommand(process.execPath, ['-e', 'process.exit(7)']), /command failed/);
  assert.throws(() => nativeAuthorCommand('/rmd-no-such-author-command', []), /command failed/);
  assert.throws(() => nativeAuthorCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeout: 100}), /command failed/);
});

test('low-footprint unsupported hosts refuse rather than weakening the ordinary author path', async () => {
  assert.equal(await runLowFootprintAuthor(args, {platform: 'linux'}), 3);
});

test('low-footprint CLI selects the scoped path before the ordinary capacity guard', () => {
  const output = nativeAuthorCommand(process.execPath, ['--import', 'tsx',
    fileURLToPath(import.meta.resolve('#scripts/preflight-author.mjs')), '--low-footprint', '--help']);
  assert.ok(output.includes('explicitly scoped local tests'));
  assert.ok(output.includes('NOT full author assurance'));
});

test('low-footprint scratch rejects invalid capacities before any native command', async () => {
  const {createBoundedAuthorScratch} = await import(subject) as {createBoundedAuthorScratch: (n: number) => unknown};
  for (const n of [0, -1, 1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createBoundedAuthorScratch(n), /invalid bounded scratch/);
});

test('low-footprint explicit reserve preserves native pressure and the default heavyweight reserve', async () => {
  const admission = '#scripts/lib/mac-author-admission.mjs';
  const {readMacAuthorAdmission, MAC_AUTHOR_FREE_RESERVE_BYTES} = await import(admission) as {
    MAC_AUTHOR_FREE_RESERVE_BYTES: number;
    readMacAuthorAdmission: (root: string, options: object) => {state: string; minimumFreeBytes: number; reasons: string[]};
  };
  const deps = {platform: 'darwin', scratch: '/s', statfs: () => ({bavail: 7 * 1024 ** 3, bsize: 1}),
    spawn: () => ({status: 0, stdout: '1'})};
  const required = lowFootprintOptions(args).minimumFreeBytes;
  assert.equal(readMacAuthorAdmission('/w', deps).state, 'not-run');
  assert.equal(readMacAuthorAdmission('/w', deps).minimumFreeBytes, MAC_AUTHOR_FREE_RESERVE_BYTES);
  assert.equal(readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: required}).state, 'admitted');
  assert.equal(readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: required,
    spawn: () => ({status: 0, stdout: '2'})}).state, 'not-run');
  const low = readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: required,
    statfs: () => ({bavail: required - 1, bsize: 1})});
  assert.equal(low.state, 'not-run'); assert.ok(low.reasons.includes('workspaceFreeBytes:below-bounded-job-reserve'));
  for (const invalid of [0, -1, Infinity, NaN])
    assert.throws(() => readMacAuthorAdmission('/w', {...deps, minimumFreeBytes: invalid}));
});

test('low-footprint image qualification refuses missing, oversized and unmounted artifacts and retains failed detach', async t => {
  const {createBoundedAuthorScratch} = await import(subject) as {
    createBoundedAuthorScratch: (bytes: number, opts: {parent: string; command: Function}) => {release: () => void};
  };
  const parent = mkdtempSync(join(tmpdir(), 'rmd-lf-errors-'));
  t.after(() => rmSync(parent, {recursive: true}));
  const bytes = 64 * 1024 ** 2;
  assert.throws(() => createBoundedAuthorScratch(bytes, {parent, command: () => {throw new Error('create refused');}}), /create refused/);
  assert.deepEqual(readdirSync(parent), []);
  for (const kind of ['missing', 'oversized', 'unmounted', 'attach-failed']) {
    const command = (_file: string, args: string[]) => {
      if (args[0] === 'create' && kind !== 'missing') {
        writeFileSync(args.at(-1)!, '');
        if (kind === 'oversized') fs.truncateSync(args.at(-1)!, bytes * 2);
      }
      if (args[0] === 'attach' && kind === 'attach-failed') throw new Error('attach refused');
      if (args[0] === 'detach') throw new Error('detach refused');
      return '';
    };
    assert.throws(() => createBoundedAuthorScratch(bytes, {parent, command}),
      kind === 'oversized' ? /backing-file budget/ : kind === 'missing' ? /ENOENT/ : /scratch retained/);
  }
});

test('low-footprint modeled image lifecycle verifies capacity and identity before cleanup', async t => {
  const {createBoundedAuthorScratch} = await import(subject) as {
    createBoundedAuthorScratch: (bytes: number, opts: object) => {dir: string; release: () => void};
  };
  const parent = mkdtempSync(join(tmpdir(), 'rmd-lf-modeled-'));
  t.after(() => rmSync(parent, {recursive: true}));
  const stat = fs.lstatSync, statfs = fs.statfsSync;
  t.mock.method(fs, 'lstatSync', (path: fs.PathLike, opts?: object) => {
    const r = stat(path, opts);
    return String(path).endsWith('/v') ? new Proxy(r, {get: (target, key) => key === 'dev' ? target.dev + 1 : Reflect.get(target, key)}) : r;
  });
  t.mock.method(fs, 'statfsSync', (path: fs.PathLike) => String(path).endsWith('/v')
    ? {blocks: 32, bsize: 4096} : statfs(path));
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const scratch = createBoundedAuthorScratch(64 * 1024 ** 2, {parent,
    command: (_file: string, args: string[]) => {if (args[0] === 'create') writeFileSync(args.at(-1)!, ''); return '';}});
  scratch.release();
  assert.equal(existsSync(scratch.dir), false);
});

test('low-footprint portable workflow keeps native test failures and incomplete output refused', async t => {
  const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
  const authorPath = '#scripts/preflight-author.mjs', capturePath = '#scripts/lib/author-step-capture.mjs';
  const author = await import(authorPath) as {authorPublicationIdentity: Function; authorEnvironment: Function; completeTestResult: Function};
  const {captureStepSync} = await import(capturePath) as {captureStepSync: (file: string, args: string[], opts: object) => object};
  for (const kind of ['pass', 'fail', 'incomplete', 'skipped', 'changed', 'cleanup-failed', 'capture-threw']) {
    const f = makeRuntimeFixture(kind === 'fail'); t.after(() => f.cleanup());
    const volume = mkdtempSync(join(tmpdir(), 'rmd-lf-portable-'));
    t.after(() => rmSync(volume, {recursive: true, force: true}));
    const command = (file: string, argv: string[], opts?: object) => {
      if (file === '/usr/bin/sandbox-exec') {writeFileSync(argv[5]!, 'control'); return '';}
      return nativeAuthorCommand(file, argv, opts);
    };
    const status = await runLowFootprintAuthor([...args.slice(0, -1), kind === 'fail' ? 'test/b.test.ts' : 'test/a.test.ts'], {
      root: f.dir, platform: 'darwin', ...author, publicationIdentity: author.authorPublicationIdentity,
      command, admit: () => ({state: 'admitted', fixtureOnly: true}),
      makeScratch: () => ({dir: volume, volume, imageBytes: 0, writableCapacityBytes: 32 * 1024 ** 2,
        release: () => {if (kind === 'cleanup-failed') throw new Error('fixture detach refused'); rmSync(volume, {recursive: true});}}),
      capture: (_file: string, argv: string[], opts: object) => {
        if (kind === 'capture-threw') throw new Error('fixture capture unavailable');
        const result = captureStepSync(argv[2]!, argv.slice(3), opts) as {stdout: string};
        if (kind === 'changed') {
          writeFileSync(join(f.dir, 'src/changed.ts'), 'export const changed = true;\n');
          f.git('add', 'src/changed.ts'); f.git('commit', '-m', 'test: changed during validation');
        }
        return kind === 'incomplete' ? {...result, outputComplete: false} :
          kind === 'skipped' ? {...result, stdout: result.stdout.replace('# skipped 0', '# skipped 1')} : result;
      },
    });
    assert.equal(status, kind === 'pass' ? 0 : 3);
    const dirs = readdirSync(join(f.dir, 'coverage')).filter(name => name.startsWith('author-low-footprint-'));
    const receipt = JSON.parse(readFileSync(join(f.dir, 'coverage', dirs[0]!, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, kind === 'pass' ? 'scoped-pass' : 'refused');
    assert.equal(receipt.fullAuthorValidation, 'not-run');
    assert.equal(receipt.cleanup, kind === 'cleanup-failed' ? 'retained' :
      kind === 'capture-threw' ? 'retained-unproven-child-closure' : 'closed-and-removed');
  }
});

test('low-footprint author never uses an unslotted fallback after capacity refusal', async t => {
  const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const authorPath = '#scripts/preflight-author.mjs';
  const author = await import(authorPath) as {authorPublicationIdentity: Function; authorEnvironment: Function; completeTestResult: Function};
  let images = 0, released = 0;
  assert.equal(await runLowFootprintAuthor(args, {root: f.dir, platform: 'darwin', ...author,
    publicationIdentity: author.authorPublicationIdentity, admit: () => ({state: 'admitted'}),
    acquire: () => ({outcome: 'wait_bound_exceeded', note: 'fixture occupied', release: () => {released++;}}),
    makeScratch: () => {images++; throw new Error('must never start');},
  }), 3);
  assert.equal(images, 0); assert.equal(released, 1);
  assert.equal(existsSync(join(f.dir, 'coverage')), false);
});
