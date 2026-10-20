import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BoundedStorageCapture, evaluateStorageRetention, readStorageObservation, STORAGE_IDLE_MS } from '#src/lib/evidence-storage-policy.js';
import { systemClock } from '#src/lib/clock.js';
// @ts-expect-error -- the standalone CLI has no declarations.
import { main } from '#scripts/evidence-storage-policy.mjs';

const NOW = STORAGE_IDLE_MS + 10_000;
const row = () => ({ id:'cache-one',kind:'regenerable-cache',outcome:'passed',mtimeMs:0,ctimeMs:0,sizeBytes:123,ownerVerified:true,closed:true,unusedVerified:true,unreferencedVerified:true,regenerableVerified:true });
const packet = () => ({version:1,enabled:true,observedAtMs:NOW,rows:[row()]});
function fixture(t:TestContext){const root=realpathSync(mkdtempSync(join(tmpdir(),'rmd-retention-policy-')));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'storage-observation.json');writeFileSync(path,JSON.stringify({...packet(),observedAtMs:systemClock.now()}),{mode:0o600});return{root,path};}

test('retention eligibility is a proposal requiring both ages and every fresh safety observation',()=>{
  const p=packet(),pass=evaluateStorageRetention(p,NOW);assert.equal(pass.decisions[0].disposition,'ELIGIBLE_FOR_FRESH_RECHECK');assert.equal(pass.destructiveActionAllowed,false);assert.equal(pass.automaticPromotionAllowed,false);
  for(const key of ['mtimeMs','ctimeMs'] as const){const r=row();r[key]=NOW-1;assert.equal(evaluateStorageRetention({...p,rows:[r]},NOW).decisions[0].disposition,'KEEP');}
  for(const key of ['ownerVerified','closed','unusedVerified','unreferencedVerified','regenerableVerified'] as const){const r=row();r[key]=false;assert.equal(evaluateStorageRetention({...p,rows:[r]},NOW).decisions[0].disposition,'KEEP',key);}
});
test('retention remains default off and never expires durable failed or incomplete receipts',()=>{
  for(const enabled of [false,undefined])assert.equal(evaluateStorageRetention({...packet(),enabled},NOW).decisions[0].reason,'policy default-off');
  for(const outcome of ['failed','refused','incomplete',undefined])assert.match(evaluateStorageRetention({...packet(),rows:[{...row(),outcome}]},NOW).decisions[0].reason,/retain/);
  for(const kind of ['durable-evidence','dependency-generation','source','unknown'])assert.equal(evaluateStorageRetention({...packet(),rows:[{...row(),kind}]},NOW).decisions[0].disposition,'KEEP');
});
test('stale future malformed and over-bound manifests cannot propose cleanup',()=>{
  for(const p of [null,[],{...packet(),version:2},{...packet(),observedAtMs:NOW+1},{...packet(),observedAtMs:NOW-60001},{...packet(),rows:Array(1001).fill(row())}])assert.equal(evaluateStorageRetention(p,NOW).state,'unknown');
  assert.equal(evaluateStorageRetention(packet(),NaN).state,'unknown');
  for(const r of [{...row(),id:'../secret'},{...row(),mtimeMs:-1},{...row(),sizeBytes:'123'},null])assert.equal(evaluateStorageRetention({...packet(),rows:[r]},NOW).decisions[0].disposition,'KEEP');
  const duplicate=evaluateStorageRetention({...packet(),rows:[row(),row()]},NOW);assert.equal(duplicate.decisions[1].disposition,'KEEP');
});
test('producer pricing preserves the requested reserve and never turns overflow or missing data into fit',()=>{
  const producer={availableBytes:1000,reservedBytes:100,estimatedScratchBytes:200,estimatedOutputBytes:100,minimumReserveBytes:500,maxCaptureBytes:100};
  const p={...packet(),producer};assert.equal(evaluateStorageRetention(p,NOW).producer.disposition,'FIT_PROPOSAL');
  for(const patch of [{availableBytes:899},{maxCaptureBytes:99},{minimumReserveBytes:700}])assert.equal(evaluateStorageRetention({...p,producer:{...producer,...patch}},NOW).producer.disposition,'REFUSE');
  for(const patch of [{availableBytes:undefined},{estimatedScratchBytes:-1},{reservedBytes:Number.MAX_SAFE_INTEGER}])assert.equal(evaluateStorageRetention({...p,producer:{...producer,...patch}},NOW).producer.disposition,'UNKNOWN');
});
test('measured savings need an observed source and positive control; absent rates remain null',()=>{
  const measurement={kind:'observed',source:'bounded df receipt',positiveControlPassed:true,beforeFreeBytes:200,afterFreeBytes:100};
  assert.equal(evaluateStorageRetention({...packet(),measurement},NOW).observedFreeBytesDelta,-100);
  for(const patch of [{kind:'estimated'},{source:''},{positiveControlPassed:false},{afterFreeBytes:undefined}])assert.equal(evaluateStorageRetention({...packet(),measurement:{...measurement,...patch}},NOW).observedFreeBytesDelta,null);
});
test('bounded capture preserves bytes and overflow is irreversible',()=>{
  for(const n of [0,-1,NaN,1048577])assert.throws(()=>new BoundedStorageCapture(n),/bound/);
  const c=new BoundedStorageCapture(3);c.append(Buffer.from('ab'));assert.equal(c.finish().complete,true);c.append(Buffer.from('cd'));c.append(Buffer.alloc(0));assert.equal(c.finish().complete,false);assert.equal(c.finish().bytes.toString(),'abc');
});
test('private manifest reader uses bounded descriptors and refuses aliases shared modes and oversized files',t=>{
  const f=fixture(t);assert.equal((readStorageObservation(f.path) as {version:number}).version,1);
  const link=join(f.root,'link');symlinkSync(f.path,link);assert.throws(()=>readStorageObservation(link));rmSync(link);
  linkSync(f.path,link);assert.throws(()=>readStorageObservation(f.path),/unverified/);rmSync(link);
  chmodSync(f.path,0o644);assert.throws(()=>readStorageObservation(f.path),/unverified/);chmodSync(f.path,0o600);
  writeFileSync(f.path,'x'.repeat(1048577));assert.throws(()=>readStorageObservation(f.path),/unverified/);
  writeFileSync(f.path,'not json');assert.throws(()=>readStorageObservation(f.path));
  const alias=join(f.root,'alias');symlinkSync(f.root,alias);assert.throws(()=>readStorageObservation(join(alias,'storage-observation.json')),/directory/);
  const shared=join(f.root,'shared');mkdirSync(shared);chmodSync(shared,0o777);assert.throws(()=>readStorageObservation(join(shared,'missing')),/directory/);
});
test('policy command reads a real private fixture without mutating it and refuses apply',t=>{
  const f=fixture(t),before=readFileSync(f.path),logs:string[]=[],errors:string[]=[];
  t.mock.method(console,'log',(s:string)=>logs.push(s));t.mock.method(console,'error',(s:string)=>errors.push(s));
  assert.equal(main(['--manifest',f.path]),0);assert.equal(JSON.parse(logs[0]).destructiveActionAllowed,false);assert.equal(main(['--apply',f.path]),2);assert.equal(main(['--manifest',join(f.root,'missing')]),2);assert.equal(errors.length,2);
  writeFileSync(f.path,'{}');assert.equal(main(['--manifest',f.path]),2);writeFileSync(f.path,before);
  const child=spawnSync(process.execPath,[resolve('scripts/evidence-storage-policy.mjs'),'--manifest',f.path],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).state,'complete-proposal');assert.deepEqual(readFileSync(f.path),before);
});
