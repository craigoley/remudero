import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

// @ts-ignore the executable .mjs module has no declaration file.
import { AUTHOR_REFUSAL_CLASSES, authorVerdictRow, main, runGuardedAuthor } from '#scripts/preflight-author.mjs';
// @ts-ignore the executable .mjs module has no declaration file.
import { MacAuthorCapacityRefusal, readMacAuthorAdmission } from '#scripts/lib/mac-author-admission.mjs';
import { RMD_TMP_PREFIX } from '#src/lib/tmp.js';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), GiB = 1024 ** 3;
const headRef = 'run-W1-T13147-1795056127859';
type Row = Record<string, unknown>;

function recordRows() {
  const rows: Row[] = [];
  const verdictLedger = { ledger: () => ({ root: '/fixture' }), log() {}, append(row: Row) {
    rows.push(row);
    return { written: true };
  } };
  return { rows, verdictLedger };
}

function authorTree(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}author-refusal-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'node_modules/fixture'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'));
  writeFileSync(join(root, '.nvmrc'), `${process.versions.node}\n`);
  writeFileSync(join(root, 'test/leaf.test.ts'), '');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/fixture': { version: '1.0.0' } } }));
  writeFileSync(join(root, 'node_modules/fixture/package.json'), '{"version":"1.0.0"}');
  for (const tool of ['tsx', 'tsc', 'commitlint']) writeFileSync(join(root, 'node_modules/.bin', tool), 'fixture');
  return root;
}

const child = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr, signal: null });

function gitAnswer(args: string[]) {
  if (args[0] === 'config') return child(1);
  if (args[0] === 'diff') return child(0, 'src/leaf.ts\0');
  switch (args.join(' ')) {
    case 'rev-parse --is-inside-work-tree': return child(0, 'true\n');
    case 'rev-parse --is-shallow-repository': return child(0, 'false\n');
    case 'rev-parse HEAD': return child(0, `${HEAD}\n`);
    case 'rev-parse origin/main': return child(0, `${BASE}\n`);
    default: return child();
  }
}

function runFixture(t: TestContext, runChild: (args: string[], root: string) => ReturnType<typeof child>, admitHost?: (stage: string) => never) {
  const { rows, verdictLedger } = recordRows();
  const root = authorTree(t);
  const exit = main([], { root, verdictLedger, admitHost,
    select: () => ({ fullRun: false, suites: ['test/leaf.test.ts'], reasons: ['fixture'] }),
    spawn: (file: string, args: string[]) => file === 'git' ? gitAnswer(args) : runChild(args, root),
    host: () => ({ cores: 4, load1: 0, headroomBytes: 32 * GiB }),
    testSlot: { dir: join(root, 'slots'), memoryHeadroom: () => 32 * GiB, log() {} },
    enqueueTestSlot: () => ({ setPrice() {}, cancel() {}, admit() { assert.fail('affected tests started'); } }),
  });
  assert.equal(rows.length, 1);
  return { exit, row: rows[0]! };
}

test('W1-T13147 criterion 1: entry and stage capacity refusals use the admission reason tokens', (t) => {
  for (const [free, pressure, expected] of [[0, '1', 'disk-reserve'], [40 * GiB, '2', 'memory-pressure'], [0, '2', 'disk-reserve']] as const) {
    const { rows, verdictLedger } = recordRows();
    const exit = runGuardedAuthor([`--head-ref=${headRef}`], { root: '/fixture', verdictLedger,
      readAdmission: (root: string, opts: object) => readMacAuthorAdmission(root, { ...opts, platform: 'darwin',
        statfs: () => ({ bavail: free, bsize: 1 }), spawn: () => child(0, `${pressure}\n`) }),
      runAuthor: () => assert.fail('author ran despite an entry refusal'),
    });
    assert.equal(exit, 3);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.first_step, rows[0]!.refusal_class], ['entry', expected]);
  }

  for (const [token, expected] of [['allocation:workspace:below-bounded-profile-reserve', 'disk-reserve'],
    ['memory:below-measured-peak', 'memory-pressure']] as const) {
    const { exit, row } = runFixture(t, () => child(), (stage) => {
      const refusal = new MacAuthorCapacityRefusal(stage, { state: 'not-run', reasons: [token] });
      refusal.message = 'unrelated wording';
      throw refusal;
    });
    assert.equal(exit, 3);
    assert.deepEqual([row.first_step, row.refusal_class, row.capacity_reasons], ['static-preflight', expected, [token]]);
  }
});

test('W1-T13147 criterion 2: a failed census or static gate names the failing suite or check', (t) => {
  const suite = 'test/host-capability-fixtures.test.ts';
  const census = runFixture(t, () => child(1, '', 'census-precheck: this branch grows 1 census count(s) CI will refuse:\n' +
    `  census-suite: ${suite} fails — run node --test --import tsx ${suite}\n`));
  assert.equal(census.exit, 1);
  assert.deepEqual([census.row.first_step, census.row.refusal_class, census.row.failed_check], ['census-precheck', 'census-precheck', suite]);

  const staticGate = runFixture(t, (args) => {
    const at = args.indexOf('--summary-file');
    if (at < 0) return child();
    writeFileSync(args[at + 1]!, JSON.stringify({ ok: false, headSha: HEAD,
      steps: [{ name: 'commitlint', ok: true }, { name: 'typecheck', ok: false }, { name: 'rule-checks', ok: false }] }));
    return child(1);
  });
  assert.equal(staticGate.exit, 1);
  assert.deepEqual([staticGate.row.first_step, staticGate.row.refusal_class, staticGate.row.failed_check], ['static-preflight', 'static-preflight', 'typecheck']);

  const noSummary = runFixture(t, (args, root) => {
    if (!args.includes('--summary-file')) return child();
    writeFileSync(join(root, 'coverage/preflight-author-static.json'), JSON.stringify({ ok: false, headSha: HEAD,
      steps: [{ name: 'stale-check', ok: false }] }));
    return child(1);
  });
  assert.equal(noSummary.exit, 1);
  assert.equal(noSummary.row.refusal_class, 'static-preflight');
  assert.equal(noSummary.row.failed_check, undefined);

  const earlierFailure = authorVerdictRow({ verdict: 'failed', steps: [{ name: 'workflow-contract-precheck', ok: false },
    { name: 'static-preflight', ok: false, failedCheck: 'typecheck' }] });
  assert.equal(earlierFailure.refusal_class, 'other');
  assert.equal(earlierFailure.failed_check, undefined);
});

test('W1-T13147 criterion 3: the refusal taxonomy stays closed and retains the previous meanings', () => {
  assert.deepEqual([...AUTHOR_REFUSAL_CLASSES].sort(), ['affected-tests', 'census-precheck', 'census-time-bound', 'dependency-precheck',
    'disk-reserve', 'lint-plan', 'memory-pressure', 'node-version', 'other', 'static-preflight', 'static-wait-bound', 'test-slot-wait-bound']);
  const refused = { verdict: 'refused', error: 'disk-reserve and pressure:critical', steps: [] };
  for (const explicit of ['node-version', 'dependency-precheck', 'static-wait-bound', 'test-slot-wait-bound']) {
    assert.equal(authorVerdictRow(refused, { refusalClass: explicit }).refusal_class, explicit);
  }
  const capacity = { verdict: 'over-capacity', steps: [] };
  assert.equal(authorVerdictRow(capacity).refusal_class, 'affected-tests');
  assert.equal(authorVerdictRow(capacity, { refusalClass: 'invented', capacityReasons: ['unrecognised'] }).refusal_class, 'other');
  assert.equal(authorVerdictRow(capacity, { refusalClass: 'invented' }).refusal_class, 'other');
  assert.equal(authorVerdictRow(refused).refusal_class, 'other');
  assert.equal(authorVerdictRow({ ...capacity, steps: [{ name: 'census-precheck', ok: true, notMeasured: 'time-bound' },
    { name: 'static-preflight', ok: true }, { name: 'affected-tests-subset', ok: true }] }).refusal_class, 'census-time-bound');
  assert.equal(authorVerdictRow({ verdict: 'failed', steps: [{ name: 'lint-plan-fast', ok: false }] }).refusal_class, 'lint-plan');
  assert.equal(authorVerdictRow({ verdict: 'failed', steps: [{ name: 'affected-tests', ok: false }] }).refusal_class, undefined);
  assert.equal(authorVerdictRow({ verdict: 'passed', steps: [] }).refusal_class, undefined);
});
