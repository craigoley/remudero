import { REPO_ROOT } from "#test/helpers/repo-root.js";
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {RMD_TMP_PREFIX} from '#src/lib/tmp.js';

type CgroupSample = {state: string; identity: string | null; currentBytes: number | null;
  lifetimePeakBytes: number | null; basis: string; source?: string};
type MemorySample = {version: number; observerMaxRSSBytes: number | null; cgroup: CgroupSample; reasons: string[]};
type ScratchSample = {state: string; volumeUsedBytes: number | null; identity: string | null; separateVolumeRoot?: boolean};
const resourcePath = '#scripts/lib/author-step-resources.mjs';
type ResourceModule = {
  sampleAuthorResources: (options?: object) => MemorySample;
  authorResourceEvidence: (before: MemorySample, after: MemorySample, output?: object) => Record<string, unknown>;
  pinAuthorScratch: (path: string) => {path: string; identity: string; separateVolumeRoot: boolean};
  sampleAuthorScratch: (pin: {path: string; identity: string; separateVolumeRoot: boolean}) => ScratchSample;
  authorScratchEvidence: (samples: ScratchSample[], options?: object) => Record<string, unknown>;
};
async function requiredResources(): Promise<ResourceModule> {
  assert.ok(existsSync(join(REPO_ROOT, 'scripts/lib/author-step-resources.mjs')),
    'this source tree must contain the native resource evidence implementation');
  return await import(resourcePath) as ResourceModule;
}

function fixture(t: {after: (fn: () => void) => void}) {
  const root = resolve(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}author-resource-`)));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const self = join(root, 'self-cgroup'); writeFileSync(self, '0::/\n');
  writeFileSync(join(root, 'memory.current'), '4096\n');
  writeFileSync(join(root, 'memory.peak'), '8192\n');
  return {root, options: {platform: 'linux', cgroupRoot: root, selfCgroup: self}};
}

test('native resource observations preserve unknown workload peaks and real observer RSS', async () => {
  const resource = await requiredResources();
  const before = resource.sampleAuthorResources(), after = resource.sampleAuthorResources();
  assert.ok(after.observerMaxRSSBytes !== null && after.observerMaxRSSBytes > 0);
  const evidence = resource.authorResourceEvidence(before, after);
  assert.equal(evidence.workloadPeakBytes, null);
  assert.equal(evidence.workloadPeakState, 'unavailable-no-per-stage-kernel-peak');
  assert.equal(evidence.admissionAuthorized, false);
  assert.equal(evidence.policyChanged, false);
});

test('a cgroup lifetime high water is never subtracted into a stage peak', async t => {
  const resource = await requiredResources();
  const f = fixture(t), before = resource.sampleAuthorResources(f.options);
  writeFileSync(join(f.root, 'memory.current'), '2048\n');
  const after = resource.sampleAuthorResources(f.options);
  assert.equal(after.cgroup.state, 'observed');
  assert.equal(after.cgroup.source, 'explicit-fixture-root');
  const evidence = resource.authorResourceEvidence(before, after, {storedBytes: 4, observedBytes: 8});
  assert.equal(evidence.cgroupPeakLifetimeUpperBoundBytes, 8192);
  assert.equal(evidence.cgroupCurrentObservedMaxBytes, 4096);
  assert.equal(evidence.workloadPeakBytes, null);
  assert.equal(evidence.outputStoredBytes, 4); assert.equal(evidence.outputObservedBytes, 8);
});

test('changed cgroup generations and regressing peaks remain unknown', async t => {
  const resource = await requiredResources();
  const f = fixture(t), before = resource.sampleAuthorResources(f.options);
  for (const change of [{identity: 'another-generation'}, {lifetimePeakBytes: 4096}]) {
    const after = {...before, cgroup: {...before.cgroup, ...change}};
    const evidence = resource.authorResourceEvidence(before, after);
    assert.equal(evidence.cgroupPeakLifetimeUpperBoundBytes, null);
    assert.equal(evidence.cgroupCurrentObservedMaxBytes, null);
  }
});

test('foreign namespace roots and malformed oversized linked or absent memory counters refuse', async t => {
  const resource = await requiredResources();
  const f = fixture(t), path = join(f.root, 'memory.peak');
  for (const value of ['-1', 'NaN', '9007199254740992', 'x'.repeat(1025), '2048']) {
    writeFileSync(path, value);
    assert.equal(resource.sampleAuthorResources(f.options).cgroup.state, 'unavailable');
  }
  rmSync(path); symlinkSync(join(f.root, 'memory.current'), path);
  assert.equal(resource.sampleAuthorResources(f.options).cgroup.state, 'unavailable');
  rmSync(path);
  assert.equal(resource.sampleAuthorResources(f.options).cgroup.state, 'unavailable');
  writeFileSync(path, '8192'); writeFileSync(f.options.selfCgroup, '0::/shared-host/slice\n');
  assert.equal(resource.sampleAuthorResources(f.options).cgroup.state, 'unavailable');
});

test('unsupported platforms and real resource failures never manufacture zeros', async () => {
  const resource = await requiredResources();
  for (const usage of [() => {throw new Error('unavailable');}, () => ({maxRSS: NaN})]) {
    const sample = resource.sampleAuthorResources({platform: 'darwin', usage});
    assert.equal(sample.observerMaxRSSBytes, null);
    assert.equal(sample.cgroup.state, 'unavailable');
    assert.ok(sample.reasons.includes('observer-resource-usage-unavailable'));
  }
});

test('private scratch observations preserve identity and distinguish retained bytes from reclaim', async t => {
  const resource = await requiredResources();
  const f = fixture(t), pin = resource.pinAuthorScratch(f.root);
  const before = resource.sampleAuthorScratch(pin);
  writeFileSync(join(f.root, 'generated'), 'actual generated fixture');
  const after = resource.sampleAuthorScratch(pin);
  assert.equal(before.state, 'observed'); assert.equal(after.state, 'observed');
  const evidence = resource.authorScratchEvidence([before, after], {childClosureProven: true, cleanup: 'unknown'});
  assert.equal(evidence.completeness, 'boundary-observations-only');
  assert.equal(evidence.retainedVolumeUsedBytesAtChildClosure, null, 'the fixture shares its host filesystem');
  assert.equal(evidence.boundaryGrowthBytes, null, 'host free-space change is not a job allocation');
  const privateVolume = resource.authorScratchEvidence([
    {...before, separateVolumeRoot: true, volumeUsedBytes: 4096},
    {...after, separateVolumeRoot: true, volumeUsedBytes: 8192},
  ], {childClosureProven: true});
  assert.equal(privateVolume.retainedVolumeUsedBytesAtChildClosure, 8192);
  assert.equal(privateVolume.boundaryGrowthBytes, 4096);
  assert.equal(evidence.physicalReclaimedBytes, null);
  const uncertain = resource.authorScratchEvidence([before, after]);
  assert.equal(uncertain.retainedVolumeUsedBytesAtChildClosure, null);
});

test('missing replaced and borrowed scratch roots remain unavailable', async t => {
  const resource = await requiredResources();
  const f = fixture(t), pin = resource.pinAuthorScratch(f.root);
  const wrong = resource.sampleAuthorScratch({...pin, identity: 'different'});
  assert.equal(wrong.state, 'unavailable');
  assert.equal(resource.authorScratchEvidence([wrong, wrong]).boundaryGrowthBytes, null);
  const link = join(f.root, 'borrowed'); symlinkSync(f.root, link);
  assert.throws(() => resource.pinAuthorScratch(link), /not-literal-directory/);
  assert.equal(resource.sampleAuthorScratch({...pin, path: join(f.root, 'absent')}).state, 'unavailable');
});

test('real native capture returns persisted resource evidence without changing its verdict', async t => {
  await requiredResources();
  const f = fixture(t), capturePath = '#scripts/lib/author-step-capture.mjs';
  const {captureStepSync} = await import(capturePath) as {
    captureStepSync: (file: string, args: string[], options: object) => {
      status: number | null; outputComplete: boolean; resources: Record<string, unknown> | null;
    };
  };
  const resultPath = join(f.root, 'result.json');
  const result = captureStepSync(process.execPath, ['-e', 'process.stdout.write("resource witness\\n")'], {
    stdoutPath: join(f.root, 'stdout'), stderrPath: join(f.root, 'stderr'), resultPath, runtimeMs: 3000,
  });
  assert.equal(result.status, 0); assert.equal(result.outputComplete, true);
  assert.ok(result.resources);
  const persisted = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.deepEqual(result.resources, persisted.resources);
  assert.equal(result.resources.workloadPeakBytes, null);
  assert.equal(result.resources.outputStoredBytes, Buffer.byteLength('resource witness\n'));
});
