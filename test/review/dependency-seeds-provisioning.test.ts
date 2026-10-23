import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { materializeDependencySeed, observeDependencySeedReuse } from '#src/lib/dependency-seeds.js';
import { ensureDeps, ensureDepsAsync, proofDependencyProvisioning, refreshProofToolchain, refreshProofToolchainAsync, registerReviewerCheckout } from '#src/lib/review.js';
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

function existingProofInputs(t: TestContext) {
  const f=fixture(t),store=join(f.root,'seeds'),donor=f.checkout('donor');
  const manifest={name:'empty-proof',version:'1.0.0',type:'module',workspaces:['packages/*'],dependencies:{'proof-input':'1.0.0'}};
  const lock={name:'empty-proof',lockfileVersion:3,packages:{'':manifest,'node_modules/proof-input':{version:'1.0.0'},'node_modules/local-input':{link:true,resolved:'packages/local'},'packages/local':{name:'local-input',version:'1.0.0'}}};
  function checkout(name: string) {
    const root=name==='donor'?donor:f.checkout(name);
    writeFileSync(join(root,'package.json'),JSON.stringify(manifest));writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock));
    mkdirSync(join(root,'packages/local'),{recursive:true});writeFileSync(join(root,'packages/local/package.json'),JSON.stringify({name:'local-input',version:'1.0.0',type:'module',exports:'./index.js'}));
    writeFileSync(join(root,'packages/local/index.js'),`export default ${JSON.stringify(name)};\n`);
    return root;
  }
  checkout('donor');mkdirSync(join(donor,'node_modules/proof-input'),{recursive:true});
  writeFileSync(join(donor,'node_modules/proof-input/package.json'),JSON.stringify({name:'proof-input',version:'1.0.0',type:'module',exports:'./index.js'}));
  writeFileSync(join(donor,'node_modules/proof-input/index.js'),'export default "sealed-external-input";\n');
  symlinkSync(join(donor,'packages/local'),join(donor,'node_modules/local-input'),'dir');
  const input=checkout('input'),seed=materializeDependencySeed(input,{root:store,sourceDir:donor});
  assert.equal(seed.status,'materialized');if(seed.status!=='materialized')throw Error('existing generation required');
  assert.equal(seed.installed,false);
  return {...f,store,seed,checkout};
}

test('explicit read-only generation consumers share package bytes and bind workspace code to their own checkout',t=>{
  const f=existingProofInputs(t),target=f.checkout('target');
  const result=materializeDependencySeed(target,{root:f.store,sourceSeed:f.seed.seed,readOnlyLinks:true});
  assert.equal(result.status,'materialized');if(result.status!=='materialized')throw Error('consumer required');
  assert.equal(result.method,'readonly-links');assert.equal(result.installed,false);
  assert.ok(lstatSync(join(target,'node_modules/proof-input')).isSymbolicLink());
  assert.equal(realpathSync(join(target,'node_modules/proof-input')),realpathSync(join(result.seed,'node_modules/proof-input')));
  assert.equal(realpathSync(join(target,'node_modules/local-input')),join(target,'packages/local'));
  const observed=spawnSync(process.execPath,['--input-type=module','-e','import external from "proof-input";import local from "local-input";console.log(JSON.stringify({external,local}));'],{cwd:target,encoding:'utf8',timeout:5000});
  assert.equal(observed.status,0,observed.stderr);assert.deepEqual(JSON.parse(observed.stdout),{external:'sealed-external-input',local:'target'});
  assert.throws(()=>materializeDependencySeed(f.checkout('no-source'),{root:f.store,readOnlyLinks:true}),/explicit source seed/);
});

test('real sync and async proof provisioning reuse explicit inputs without invoking an installer',async t=>{
  const f=existingProofInputs(t),bin=join(f.root,'bin'),calls=join(f.root,'installer-calls');mkdirSync(bin);
  const realNpm=realpathSync(join(dirname(process.execPath),'npm'));
  writeFileSync(join(bin,'npm'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args.length===1&&args[0]==='--version'){const p=cp.spawnSync(process.execPath,[${JSON.stringify(realNpm)},...args],{stdio:'inherit'});process.exit(p.status??1);}fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');process.exit(89);\n`,{mode:0o700});
  const prior={PATH:process.env.PATH,RMD_DEPENDENCY_SEED_ROOT:process.env.RMD_DEPENDENCY_SEED_ROOT,RMD_PROOF_DEPENDENCY_SEED:process.env.RMD_PROOF_DEPENDENCY_SEED};
  t.after(()=>{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  process.env.PATH=bin+':'+process.env.PATH;process.env.RMD_DEPENDENCY_SEED_ROOT=f.store;process.env.RMD_PROOF_DEPENDENCY_SEED=f.seed.seed;
  for(const [name,asyncMode]of [['sync',false],['async',true]] as const){
    const target=f.checkout(name);registerReviewerCheckout(target);
    assert.equal(asyncMode?await ensureDepsAsync(target):ensureDeps(target),true);
    assert.ok(lstatSync(join(target,'node_modules/proof-input')).isSymbolicLink());
    assert.equal(realpathSync(join(target,'node_modules/local-input')),join(target,'packages/local'));
    assert.equal(refreshProofToolchain(target),false);assert.equal(await refreshProofToolchainAsync(target),false);
  }
  assert.equal(readdirSync(f.root).includes('installer-calls'),false);
});

test('existing-input proof refusals retain unknown qualification and never fall back to installation',async t=>{
  const f=existingProofInputs(t),prior={RMD_DEPENDENCY_SEED_ROOT:process.env.RMD_DEPENDENCY_SEED_ROOT,RMD_PROOF_DEPENDENCY_SEED:process.env.RMD_PROOF_DEPENDENCY_SEED};
  t.after(()=>{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  assert.throws(()=>proofDependencyProvisioning(f.root,{RMD_PROOF_DEPENDENCY_SEED:'relative',RMD_DEPENDENCY_SEED_ROOT:f.store}),/absolute source seed/);
  assert.throws(()=>proofDependencyProvisioning(f.root,{RMD_PROOF_DEPENDENCY_SEED:f.seed.seed,RMD_DEPENDENCY_SEED_ROOT:''}),/configured store/);
  process.env.RMD_DEPENDENCY_SEED_ROOT=f.store;process.env.RMD_PROOF_DEPENDENCY_SEED=join(f.store,'missing');
  const sync=f.checkout('refuse-sync'),async=f.checkout('refuse-async');
  assert.throws(()=>ensureDeps(sync),/installation refused/);
  assert.throws(()=>ensureDeps(sync),/installation refused/);
  await assert.rejects(()=>ensureDepsAsync(async),/installation refused/);
  await assert.rejects(()=>ensureDepsAsync(async),/installation refused/);
});
