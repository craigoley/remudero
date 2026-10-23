import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const subject = '#scripts/lib/author-low-footprint.mjs';
const {createBoundedAuthorScratch, lowFootprintSandbox, nativeAuthorCommand} = await import(subject) as {
  createBoundedAuthorScratch: (bytes: number, options?: object) => {
    dir: string; volume: string; writableCapacityBytes: number; release: () => void;
  };
  lowFootprintSandbox: (path: string) => string;
  nativeAuthorCommand: (file: string, args: string[], options?: object) => string;
};

test('native low-footprint volume enforces capacity and its sandbox refuses escaped writes and installs',
  {skip: process.platform !== 'darwin'}, t => {
    const parent = mkdtempSync(join(tmpdir(), 'rmd-lf-native-'));
    let scratch: ReturnType<typeof createBoundedAuthorScratch> | undefined;
    t.after(() => {
      scratch?.release();
      rmSync(parent, {recursive: true});
    });
    scratch = createBoundedAuthorScratch(64 * 1024 ** 2, {parent});
    const {volume, dir} = scratch;
    assert.ok(scratch.writableCapacityBytes <= 64 * 1024 ** 2);
    const allowed = join(volume, 'control');
    const escaped = join(dir, 'escaped');
    mkdirSync(join(volume, 'node_modules'));
    const forbidden = join(volume, 'node_modules', 'package.js');
    const code = 'const f=require("node:fs");f.writeFileSync(process.argv[1],"ok");' +
      'for(const p of process.argv.slice(2)){let denied=false;try{f.writeFileSync(p,"bad")}catch(e){denied=e.code==="EPERM"||e.code==="EACCES"}if(!denied)process.exit(2)}';
    nativeAuthorCommand('/usr/bin/sandbox-exec', ['-p', lowFootprintSandbox(volume), process.execPath, '-e', code,
      allowed, escaped, forbidden]);
    assert.equal(existsSync(allowed), true); assert.equal(existsSync(escaped), false); assert.equal(existsSync(forbidden), false);
    const fill = 'const f=require("node:fs");try{f.writeFileSync(process.argv[1],Buffer.alloc(128*1024**2));process.exit(2)}catch(e){if(e.code!=="ENOSPC")throw e}';
    nativeAuthorCommand('/usr/bin/sandbox-exec', ['-p', lowFootprintSandbox(volume), process.execPath, '-e', fill, join(volume, 'full')]);
    scratch.release(); scratch = undefined;
    assert.equal(existsSync(dir), false);
  });

test('native low-footprint command runs the exact committed files and reports scoped assurance',
  {skip: process.platform !== 'darwin'}, async t => {
    const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
    const f = makeRuntimeFixture(); t.after(() => f.cleanup());
    const authorPath = '#scripts/preflight-author.mjs';
    const author = await import(authorPath) as {authorPublicationIdentity: Function; authorEnvironment: Function; completeTestResult: Function};
    const low = await import(subject) as {runLowFootprintAuthor: (args: string[], deps: object) => Promise<number>};
    const status = await low.runLowFootprintAuthor(['--low-footprint', '--scratch-mib', '64', '--timeout-ms', '30000',
      '--head-ref', 'run-unfiled-1234567890123', '--test', 'test/a.test.ts'], {root: f.dir, ...author,
      // This native test qualifies containment and execution, not the fluctuating host.
      // Real default admission has its own native-probe and fail-closed controls.
      admit: () => ({state: 'admitted', fixtureOnly: true}),
      publicationIdentity: author.authorPublicationIdentity});
    assert.equal(status, 0);
    const dirs = readdirSync(join(f.dir, 'coverage')).filter(name => name.startsWith('author-low-footprint-'));
    assert.equal(dirs.length, 1);
    const receipt = JSON.parse(readFileSync(join(f.dir, 'coverage', dirs[0]!, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, 'scoped-pass');
    assert.equal(receipt.fullAuthorValidation, 'not-run');
    assert.equal(receipt.hostedFullSuiteAndCoverage, 'required-pending');
    assert.deepEqual(receipt.files, ['test/a.test.ts']);
    assert.equal(receipt.tests.judge.complete, true);
    assert.equal(receipt.cleanup, 'closed-and-removed');
    assert.equal(existsSync(join(f.dir, 'coverage/preflight-author.json')), false);
  });

test('native low-footprint command refuses failing and ghost suites without fallback',
  {skip: process.platform !== 'darwin'}, async t => {
    const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
    const f = makeRuntimeFixture(true); t.after(() => f.cleanup());
    const authorPath = '#scripts/preflight-author.mjs';
    const author = await import(authorPath) as {authorPublicationIdentity: Function; authorEnvironment: Function; completeTestResult: Function};
    const low = await import(subject) as {runLowFootprintAuthor: (args: string[], deps: object) => Promise<number>};
    const base = ['--low-footprint', '--scratch-mib', '64', '--timeout-ms', '30000',
      '--head-ref', 'run-unfiled-1234567890123', '--test'];
    for (const file of ['test/ghost.test.ts', 'test/b.test.ts']) {
      assert.equal(await low.runLowFootprintAuthor([...base, file], {root: f.dir, ...author,
        admit: () => ({state: 'admitted', fixtureOnly: true}),
        publicationIdentity: author.authorPublicationIdentity}), 3);
    }
    const dirs = readdirSync(join(f.dir, 'coverage')).filter(name => name.startsWith('author-low-footprint-'));
    assert.equal(dirs.length, 1, 'the missing physical file must refuse before starting work');
    const receipt = JSON.parse(readFileSync(join(f.dir, 'coverage', dirs[0]!, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, 'refused'); assert.equal(receipt.tests.judge.failed, 1);
    assert.equal(receipt.cleanup, 'closed-and-removed');
  });

test('native low-footprint default admission observes the host or records an explicit capacity refusal',
  {skip: process.platform !== 'darwin'}, async t => {
    const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
    const f = makeRuntimeFixture(); t.after(() => f.cleanup());
    const authorPath = '#scripts/preflight-author.mjs';
    const author = await import(authorPath) as {authorPublicationIdentity: Function; authorEnvironment: Function; completeTestResult: Function};
    const low = await import(subject) as {runLowFootprintAuthor: (args: string[], deps: object) => Promise<number>};
    const reports: string[] = [];
    t.mock.method(console, 'log', (value: string) => {reports.push(value);});
    // No fake admission: the actual sysctl/vm_stat and disk probes execute.
    const status = await low.runLowFootprintAuthor(['--low-footprint', '--scratch-mib', '64', '--timeout-ms', '30000',
      '--head-ref', 'run-unfiled-1234567890123', '--test', 'test/a.test.ts'], {root: f.dir, ...author,
      publicationIdentity: author.authorPublicationIdentity});
    const row = JSON.parse(reports.at(-1)!);
    assert.equal(row.fullAuthorValidation, 'not-run');
    if (status === 0) {
      assert.equal(row.verdict, 'scoped-pass');
      for (const observation of [row.entryAdmission, row.freshAdmission, row.testAdmission]) {
        assert.equal(observation.platform, 'darwin'); assert.equal(observation.state, 'admitted');
        assert.ok(['normal', 'warning'].includes(observation.pressure));
      }
      assert.equal(row.tests.judge.complete, true);
    } else {
      assert.equal(status, 3); assert.equal(row.verdict, 'refused');
      assert.match(row.error, /^low-footprint capacity NOT_RUN: /);
      const observed = JSON.parse(row.error.slice('low-footprint capacity NOT_RUN: '.length));
      assert.equal(observed.platform, 'darwin'); assert.equal(observed.state, 'not-run');
      assert.ok(observed.reasons.length > 0);
      assert.equal(row.tests, undefined, 'refused phase starts no test child');
    }
  });
