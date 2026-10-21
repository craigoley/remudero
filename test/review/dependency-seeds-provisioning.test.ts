import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { materializeDependencySeed, observeDependencySeedReuse } from '#src/lib/dependency-seeds.js';
// @ts-expect-error -- the standalone CLI has no declaration file.
import { main } from '#scripts/dependency-seeds.mjs';

function fixture(t: TestContext): { root: string; checkout: (name: string) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rmd-provision-observation-')));
  t.after(() => {
    const writable = (path: string): void => { const s=lstatSync(path);if(s.isSymbolicLink())return;chmodSync(path,s.mode|0o700);if(s.isDirectory())for(const n of readdirSync(path))writable(join(path,n)); };
    writable(root);rmSync(root,{recursive:true,force:true});
  });
  const checkout = (name: string): string => {
    const path=join(root,name);mkdirSync(path);
    writeFileSync(join(path,'package.json'),'{"name":"empty-proof","version":"1.0.0"}');
    writeFileSync(join(path,'package-lock.json'),'{"name":"empty-proof","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"empty-proof","version":"1.0.0"}}}');
    return path;
  };
  return {root,checkout};
}
function registeredFixture(t: TestContext) {
  const f=fixture(t),store=join(f.root,'seeds');let installs=0;
  const options={root:store,npmVersion:'fixture',proof:true,runInstall(stage:string){installs++;mkdirSync(join(stage,'node_modules'));}};
  const first=materializeDependencySeed(f.checkout('first'),options),second=materializeDependencySeed(f.checkout('second'),options);
  assert.equal(first.status,'materialized');assert.equal(second.status,'materialized');
  if(first.status!=='materialized'||second.status!=='materialized')throw Error('materialized controls required');
  return {...f,store,first,second,installs,consumers:join(first.seed,'consumers')};
}
test('dependency provisioning records one fresh generation and a real reuse without extra receipt files',t=>{
  const f=registeredFixture(t),report=observeDependencySeedReuse(f.store);
  assert.equal(f.installs,1);assert.equal(report.state,'complete');assert.equal(report.observedGenerations,1);
  assert.equal(report.knownProvisioningRegistrations,2);assert.equal(report.freshInstallGenerations,1);
  assert.equal(report.reusedRegistrations,1);assert.equal(report.reuseShare,.5);assert.equal(report.cleanupAuthorized,false);
  assert.deepEqual(report.failures,[]);assert.equal(report.failuresTruncated,false);
  for(const n of readdirSync(f.consumers)){const p=join(f.consumers,n);assert.equal(lstatSync(p).mode&0o077,0);assert.equal(JSON.parse(readFileSync(p,'utf8')).provisioning.version,1);}
  assert.deepEqual(readdirSync(f.first.seed).sort(),['consumers','node_modules','package-lock.json','package.json','ready.json']);
});
test('legacy provisioning observations stay unknown rather than inventing zero installs',t=>{
  const f=registeredFixture(t),path=join(f.consumers,readdirSync(f.consumers)[0]),row=JSON.parse(readFileSync(path,'utf8'));delete row.provisioning;writeFileSync(path,JSON.stringify(row));
  const report=observeDependencySeedReuse(f.store);assert.equal(report.state,'partial');assert.equal(report.unknownRegistrations,1);assert.equal(report.reuseShare,null);
  assert.ok(report.reasons.includes('legacy or incomplete provisioning observation'));
  assert.deepEqual(report.failures,[{scope:'registration',reason:'legacy or incomplete provisioning observation'}]);
});
test('foreign consumer namespaces and symbolic metadata cannot become observed reuse',t=>{
  const f=registeredFixture(t),paths=readdirSync(f.consumers).map(n=>join(f.consumers,n));
  const row=JSON.parse(readFileSync(paths[0],'utf8'));row.mountNamespace='unverified-namespace';writeFileSync(paths[0],JSON.stringify(row));
  rmSync(paths[1]);symlinkSync(join(f.first.seed,'ready.json'),paths[1]);
  const report=observeDependencySeedReuse(f.store);assert.equal(report.state,'partial');assert.equal(report.knownProvisioningRegistrations,0);assert.equal(report.unknownRegistrations,2);assert.equal(report.reuseShare,null);
});
test('registry inspection bounds preserve null rates and do not rewrite a single consumer',t=>{
  const f=registeredFixture(t),before=readdirSync(f.consumers).map(n=>readFileSync(join(f.consumers,n),'utf8'));
  const report=observeDependencySeedReuse(f.store,1);assert.equal(report.state,'partial');assert.equal(report.reuseShare,null);assert.ok(report.reasons.includes('registration inspection bound'));
  assert.deepEqual(report.failures,[{scope:'generation',reason:'registration inspection bound'}]);
  assert.deepEqual(readdirSync(f.consumers).map(n=>readFileSync(join(f.consumers,n),'utf8')),before);
  assert.equal(observeDependencySeedReuse(f.store,5001).state,'unknown');
});
test('missing and malformed stores never produce a positive observation or cleanup authority',t=>{
  const f=fixture(t);for(const root of [join(f.root,'missing'),f.root]){const r=observeDependencySeedReuse(root);assert.equal(r.state,'unknown');assert.equal(r.reuseShare,null);assert.equal(r.cleanupAuthorized,false);assert.equal(r.failures.length,1);assert.equal(r.failures[0].scope,'store');assert.match(r.failures[0].reason,/ENOENT/);}
});
test('bounded diagnostic samples declare truncation without inventing complete reuse rates',t=>{
  const f=registeredFixture(t);for(const n of readdirSync(f.consumers))rmSync(join(f.consumers,n));
  for(let i=0;i<9;i++)writeFileSync(join(f.consumers,`unrecognized-${i}`),'{}',{mode:0o600});
  const report=observeDependencySeedReuse(f.store);
  assert.equal(report.state,'partial');assert.equal(report.unknownRegistrations,9);assert.equal(report.reuseShare,null);
  assert.equal(report.failures.length,8);assert.equal(report.failuresTruncated,true);
  for(const failure of report.failures)assert.deepEqual(failure,{scope:'registration',reason:'unrecognized registry row'});
});
test('normal seed CLI priming and reporting use real defaults without enabling or installing a service',t=>{
  const f=fixture(t),checkout=f.checkout('cli'),store=join(f.root,'seeds'),script=resolve('scripts/dependency-seeds.mjs');
  const env={...process.env,npm_config_cache:join(f.root,'npm-cache'),npm_config_offline:'true',npm_config_update_notifier:'false'};
  const prime=spawnSync(process.execPath,[script,'prime',checkout,'--proof','--root',store],{env,encoding:'utf8',timeout:15000});assert.equal(prime.status,0,prime.stderr);
  const result=spawnSync(process.execPath,[script,'report','--root',store],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.state,'complete');assert.equal(report.freshInstallGenerations,1);assert.equal(report.knownProvisioningRegistrations,1);assert.equal(report.cleanupAuthorized,false);
  const refused=spawnSync(process.execPath,[script,'report','--apply','--root',store],{encoding:'utf8',timeout:5000});assert.equal(refused.status,1);assert.match(refused.stderr,/read-only/);
});
test('seed report command emits observed metadata in process and refuses any apply request',t=>{
  const f=registeredFixture(t),output:string[]=[],errors:string[]=[];
  t.mock.method(console,'log',(text:string)=>output.push(text));
  t.mock.method(console,'error',(text:string)=>errors.push(text));
  assert.equal(main(['report','--root',f.store]),0);
  assert.equal(JSON.parse(output[0]).knownProvisioningRegistrations,2);
  assert.equal(main(['report','--apply','--root',f.store]),1);
  assert.match(errors[0],/read-only/);
  assert.equal(main(['unknown','--root',f.store]),1);
  assert.match(errors[1],/usage:/);
});
