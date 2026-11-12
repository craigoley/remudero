import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

type CapacityRow = {filesystem: string; requiredFreeBytes: number; observedFreeBytes: number | null;
  shortfallBytes: number | null};
type Admission = Record<string, unknown>;
type AdmissionOptions = {minimumFreeBytes?: number; reserveBasis?: string};
type ReadAdmission = (root: string, options: AdmissionOptions) => Admission;
const admissionModule = '#scripts/lib/mac-author-admission.mjs';
const authorModule = '#scripts/preflight-author.mjs';
const {guardedAuthorEntry, readMacAuthorAdmission, requireMacAuthorCapacity, macAuthorReserveBytes,
  MAC_AUTHOR_JANITOR_DRY_RUN} = await import(admissionModule) as {
  guardedAuthorEntry: (argv: string[], options: {root: string; readAdmission: ReadAdmission;
    runAuthor: () => number}) => number;
  readMacAuthorAdmission: (root: string, options: object) => Admission;
  requireMacAuthorCapacity: (root: string, stage: string, readAdmission: ReadAdmission, workload?: object) => Admission;
  macAuthorReserveBytes: (options: {stage: string; selection?: string; workers?: number}) => {bytes: number};
  MAC_AUTHOR_JANITOR_DRY_RUN: string;
};

const NOT_RUN = 'author preflight NOT_RUN: ';
const entryRequired = macAuthorReserveBytes({stage: 'entry'}).bytes;

/** A darwin admission read with fixed free space per filesystem; `null` makes that read fail. */
function darwinAt(free: {workspace: number | null; scratch: number | null}, pressure = '1'): ReadAdmission {
  return (root, options) => readMacAuthorAdmission(root, {...options, platform: 'darwin', scratch: '/scratch',
    statfs: (path: string) => {
      const bytes = path === '/scratch' ? free.scratch : free.workspace;
      if (bytes === null) throw Object.assign(new Error('denied'), {code: 'EACCES'});
      return {bavail: bytes, bsize: 1};
    },
    spawn: () => ({status: 0, stdout: `${pressure}\n`})});
}

function captureStderr(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
  return lines;
}

function entryRefusal(t: TestContext, readAdmission: ReadAdmission) {
  const lines = captureStderr(t);
  let authorCalls = 0;
  const status = guardedAuthorEntry([], {root: '/workspace', readAdmission,
    runAuthor: () => { authorCalls++; return 0; }});
  t.mock.restoreAll();
  const diagnostic = lines.find(line => line.startsWith(NOT_RUN));
  assert.ok(diagnostic, 'a machine-readable refusal is printed');
  return {status, authorCalls, lines, refusal: JSON.parse(diagnostic.slice(NOT_RUN.length))};
}

test('W1-T12297 criterion 1: an entry refusal reports each filesystem shortfall and the janitor dry run', (t) => {
  // #17209's case: 9,627,631,616 bytes free on both filesystems against the entry reserve.
  const observed = 9_627_631_616;
  assert.equal(entryRequired, 11_274_289_152, 'the entry reserve is unchanged');
  const {status, authorCalls, lines, refusal} = entryRefusal(t, darwinAt({workspace: observed, scratch: observed}));
  assert.equal(status, 3, 'NOT_RUN keeps exit 3');
  assert.equal(authorCalls, 0, 'no author work starts');
  assert.equal(refusal.state, 'not-run');
  assert.equal(refusal.stage, 'entry');
  assert.equal(refusal.authorWorkStarted, false);
  const shortfall = entryRequired - observed;
  assert.deepEqual(refusal.capacityChecks, [
    {filesystem: 'workspaceFreeBytes', requiredFreeBytes: entryRequired, observedFreeBytes: observed, shortfallBytes: shortfall},
    {filesystem: 'scratchFreeBytes', requiredFreeBytes: entryRequired, observedFreeBytes: observed, shortfallBytes: shortfall},
  ] satisfies CapacityRow[]);
  assert.deepEqual(refusal.recoveryGuidance, {action: 'measure-free-space-again',
    dryRunCommand: MAC_AUTHOR_JANITOR_DRY_RUN, documentation: 'deploy/mac/JANITOR.md'});
  assert.match(MAC_AUTHOR_JANITOR_DRY_RUN, /Library\/Application Support\/remudero\/remudero-janitor\.sh" --dry-run$/);
  for (const name of ['workspaceFreeBytes', 'scratchFreeBytes'])
    assert.ok(lines.includes(`Capacity ${name}: required ${entryRequired} bytes; observed ${observed} bytes; ` +
      `shortfall ${shortfall} bytes.`), name);
  assert.ok(lines.includes('No slot, static checks, tests, dependency installation, cleanup or process termination started.'));
  assert.ok(lines.some(line => line.includes(MAC_AUTHOR_JANITOR_DRY_RUN) && line.includes('deploy/mac/JANITOR.md')));
  assert.equal(lines.join('\n').includes('--apply'), false, 'the guidance never authorizes deletion');
});

test('W1-T12297 criterion 2: a refusal before static-preflight says author work started and keeps over-capacity', async (t) => {
  const {makeRuntimeFixture} = await import('#test/helpers/native-runtime-fixture.js');
  const {main} = await import(authorModule) as {
    main: (argv: string[], options: {root: string; select: () => {fullRun: boolean; suites: string[]; reasons: string[]};
      admitHost: (stage: string, workload?: object) => Admission | undefined}) => number;
  };
  const fixture = makeRuntimeFixture(); t.after(() => fixture.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(fixture.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(fixture.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  fixture.git('add', 'package-lock.json'); fixture.git('commit', '-m', 'test: lock the native fixture tools');
  // The Mac lane's T12201 refusal: 18,938,732,544 bytes free against the 20 GiB reserve.
  const observed = 18_938_732_544, required = 21_474_836_480;
  const readAdmission = darwinAt({workspace: observed, scratch: observed});
  const lines = captureStderr(t);
  const status = main([], {root: fixture.dir,
    select: () => ({fullRun: false, suites: ['test/a.test.ts'], reasons: ['physical fixture']}),
    admitHost: (stage, workload) => requireMacAuthorCapacity(fixture.dir, stage, readAdmission,
      {...workload, selection: 'full-fallback'})});
  t.mock.restoreAll();
  const receipt = JSON.parse(readFileSync(join(fixture.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(status, 3, JSON.stringify(receipt.error));
  assert.equal(receipt.verdict, 'over-capacity');
  const row = receipt.hostCapacity.at(-1);
  assert.equal(row.stage, 'static-preflight');
  assert.equal(row.authorWorkStarted, true, 'selection and the census ran before this refusal');
  assert.deepEqual(row.capacityChecks, [
    {filesystem: 'workspaceFreeBytes', requiredFreeBytes: required, observedFreeBytes: observed, shortfallBytes: required - observed},
    {filesystem: 'scratchFreeBytes', requiredFreeBytes: required, observedFreeBytes: observed, shortfallBytes: required - observed},
  ] satisfies CapacityRow[]);
  assert.equal(row.recoveryGuidance.dryRunCommand, MAC_AUTHOR_JANITOR_DRY_RUN);
  assert.equal(receipt.steps.some((step: {name: string}) => step.name === 'static-preflight'), false, 'static checks did not start');
  assert.ok(lines.includes(`Capacity workspaceFreeBytes: required ${required} bytes; observed ${observed} bytes; ` +
    `shortfall ${required - observed} bytes.`));
  assert.ok(lines.some(line => line.startsWith('Author selection and the census precheck ran; static checks and tests did not start.')));
  assert.ok(lines.some(line => line.includes(MAC_AUTHOR_JANITOR_DRY_RUN)));
});

test('W1-T12297 criterion 3: an unmeasured filesystem reads unknown and a pressure-only refusal gets no disk guidance', (t) => {
  const unmeasured = entryRefusal(t, darwinAt({workspace: 30 * 1024 ** 3, scratch: null}));
  assert.equal(unmeasured.status, 3);
  assert.deepEqual(unmeasured.refusal.capacityChecks[1],
    {filesystem: 'scratchFreeBytes', requiredFreeBytes: entryRequired, observedFreeBytes: null, shortfallBytes: null});
  assert.ok(unmeasured.lines.includes(`Capacity scratchFreeBytes: required ${entryRequired} bytes; observed unknown; shortfall unknown.`));
  assert.ok(unmeasured.refusal.recoveryGuidance, 'an unmeasured filesystem may be short, so the guidance stays');
  const pressure = entryRefusal(t, darwinAt({workspace: 30 * 1024 ** 3, scratch: 30 * 1024 ** 3}, '2'));
  assert.equal(pressure.status, 3);
  assert.equal(pressure.authorCalls, 0);
  assert.equal(pressure.refusal.recoveryGuidance, undefined);
  assert.equal(pressure.lines.some(line => line.includes('janitor')), false);
});
