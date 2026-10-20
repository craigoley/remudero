import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';import{join,resolve}from'node:path';import test,{type TestContext}from'node:test';
import {readSharedGitPolicy,readSharedWorkspaceCapacity,borrowedWorkspaceWorker,createSharedWorkspace} from '#scripts/lib/shared-workspace.mjs';
import {main} from '#scripts/shared-workspace.mjs';
import {resolveTestSlotDir,testSlotProcessFacts} from '#src/lib/test-slot.js';
function fixture(t:TestContext){
  const home=realpathSync(mkdtempSync(join(homedir(),'.rmd-shared-git-fixture-'))),parent=join(home,'workspaces'),seed=join(home,'origin'),pool=join(home,'pool'),root=join(home,'dependencies'),configDir=join(home,'.config/remudero'),config=join(configDir,'git-storage.json');
  for(const p of[parent,seed,root,configDir])mkdirSync(p,{recursive:true,mode:0o700});
  t.after(()=>{const writable=(p:string):void=>{const s=lstatSync(p);if(s.isSymbolicLink())return;chmodSync(p,s.mode|0o700);if(s.isDirectory())for(const n of readdirSync(p))writable(join(p,n));};writable(home);rmSync(home,{recursive:true,force:true});});
  const git=(cwd:string,...args:string[])=>{const p=spawnSync('/usr/bin/git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8',timeout:10000,maxBuffer:65536,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  git(seed,'init','-q','--initial-branch=main');mkdirSync(join(home,'empty-hooks'));git(seed,'config','core.hooksPath',join(home,'empty-hooks'));
  writeFileSync(join(seed,'package.json'),'{"name":"shared-git-fixture","version":"1.0.0"}');writeFileSync(join(seed,'package-lock.json'),'{"name":"shared-git-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"shared-git-fixture","version":"1.0.0"}}}');
  git(seed,'add','package.json','package-lock.json');git(seed,'commit','-qm','fixture');mkdirSync(join(seed,'node_modules'));
  git(home,'clone','-q',seed,pool);git(pool,'config','core.hooksPath',join(home,'empty-hooks'));
  const policy={schema:'rmd-git-storage/v1',enabled:true,pool,poolKind:'existing-checkout',parent,dependencyRoot:root,dependencyDonor:seed};
  const save=(value:unknown=policy)=>writeFileSync(config,JSON.stringify(value),{mode:0o600});save();
  const options={home,readCapacity:()=>({admitted:true}),borrowWorker:async()=>({admitted:true}),now:()=>100};
  return{home,parent,seed,pool,root,config,policy,save,git,options};
}
test('shared Git policy is versioned, absent/default-off and creates no configuration',async t=>{
  const f=fixture(t);rmSync(f.config);assert.deepEqual(readSharedGitPolicy(f.home),{enabled:false});
  assert.equal((await createSharedWorkspace('unfiled',f.options)).state,'NOT_RUN');assert.equal(existsSync(f.config),false);
  f.save({...f.policy,enabled:false});assert.deepEqual(readSharedGitPolicy(f.home),{enabled:false});
  f.save({pool:f.pool});assert.throws(()=>readSharedGitPolicy(f.home),/versioned/);
});
test('shared Git policy rejects linked, public, oversized, malformed and escaping metadata',t=>{
  const f=fixture(t);rmSync(f.config);writeFileSync(f.config,JSON.stringify(f.policy),{mode:0o644});assert.throws(()=>readSharedGitPolicy(f.home),/private/);
  rmSync(f.config);symlinkSync(join(f.home,'absent'),f.config);assert.throws(()=>readSharedGitPolicy(f.home));rmSync(f.config);
  f.save();writeFileSync(f.config,' '.repeat(16385));assert.throws(()=>readSharedGitPolicy(f.home),/private/);
  writeFileSync(f.config,'{');assert.throws(()=>readSharedGitPolicy(f.home));
  for(const change of[{pool:'/outside'},{poolKind:'guess'},{dependencyDonor:'.'},{parent:join(f.home,'missing')}]){f.save({...f.policy,...change});assert.throws(()=>readSharedGitPolicy(f.home));}
});
test('filed tasks never read storage policy, bypass claims or allocate a workspace',async()=>{
  const r=await createSharedWorkspace('W1-T999999999',{home:'/absent/fixture'});assert.equal(r.state,'NOT_RUN');assert.match(r.reason!,/filed tasks require/);assert.equal(r.receiptDir,undefined);
});
test('capacity and genuine-worker refusals precede every Git or receipt mutation',async t=>{
  const f=fixture(t),before=readdirSync(f.parent);let borrowed=0;
  const capacity=await createSharedWorkspace('unfiled',{...f.options,readCapacity:()=>({admitted:false}),borrowWorker:async()=>{borrowed++;return{admitted:true};}});
  assert.equal(capacity.state,'NOT_RUN');assert.match(capacity.reason!,/capacity/);assert.equal(borrowed,0);
  const worker=await createSharedWorkspace('unfiled',{...f.options,borrowWorker:async()=>({admitted:false})});assert.match(worker.reason!,/genuine/);assert.deepEqual(readdirSync(f.parent),before);
});
test('real linked workspaces share the common Git store and reuse dependencies with no fresh install',async t=>{
  const f=fixture(t),r=await createSharedWorkspace('unfiled',f.options);assert.equal(r.state,'CREATED_SHARED_OBJECTS_NO_FRESH_INSTALL',r.reason);
  assert.equal(r.commonGitDir,join(f.pool,'.git'));assert.equal(r.base,f.git(f.pool,'rev-parse','origin/main'));
  assert.equal(lstatSync(join(r.path!,'node_modules')).isSymbolicLink(),false);assert.equal(r.freshNpmInstalls,0);
  assert.equal(f.git(r.path!,'rev-parse','--path-format=absolute','--git-common-dir'),r.commonGitDir);
  assert.equal(JSON.parse(readFileSync(join(r.receiptDir!,'result.json'),'utf8')).state,r.state);
  const second=await createSharedWorkspace('unfiled',{...f.options,now:()=>101});assert.equal(second.state,'CREATED_SHARED_OBJECTS_NO_FRESH_INSTALL',second.reason);
  assert.notEqual(spawnSync('/usr/bin/git',['-C',r.path!,'rev-parse','--abbrev-ref','@{u}'],{encoding:'utf8',timeout:3000}).status,0);
});
test('occupied and dangling workspace paths are retained without retry or new receipts',async t=>{
  const f=fixture(t),path=join(f.parent,'run-unfiled-100');symlinkSync(join(f.home,'absent'),path);const before=readdirSync(f.parent);
  const r=await createSharedWorkspace('unfiled',f.options);assert.equal(r.state,'NOT_RUN');assert.match(r.reason!,/occupied/);assert.equal(lstatSync(path).isSymbolicLink(),true);assert.deepEqual(readdirSync(f.parent),before);
});
test('dependency refusal preserves the real created worktree and never invokes an npm fallback',async t=>{
  const f=fixture(t);writeFileSync(join(f.seed,'package.json'),'{"name":"mismatch"}');
  const r=await createSharedWorkspace('unfiled',f.options);assert.equal(r.state,'CREATED_DEPENDENCIES_OR_READBACK_UNKNOWN_RETAINED');assert.match(r.reason!,/donor inputs/);
  assert.ok(existsSync(join(r.path!,'package.json')));assert.equal(existsSync(join(r.path!,'node_modules')),false);assert.equal(r.freshNpmInstalls,0);
});
test('a dependency installer attempting fresh npm is refused and its workspace remains harness-owned',async t=>{
  const f=fixture(t);const r=await createSharedWorkspace('unfiled',{...f.options,materialize:async(_path,options)=>{options.runInstall();return{status:'materialized'};}});
  assert.equal(r.state,'CREATED_DEPENDENCIES_OR_READBACK_UNKNOWN_RETAINED');assert.match(r.reason!,/fresh npm fallback refused/);assert.ok(existsSync(r.path!));
});
test('bare pools require their own full initial integrity proof and current connectivity',async t=>{
  const f=fixture(t);rmSync(f.pool,{recursive:true});f.git(f.home,'clone','-q','--bare',f.seed,f.pool);f.git(f.pool,'config','core.hooksPath',join(f.home,'empty-hooks'));f.save({...f.policy,poolKind:'qualified-bare'});
  const missing=await createSharedWorkspace('unfiled',f.options);assert.equal(missing.state,'NOT_RUN');assert.match(missing.reason!,/ENOENT/);
  writeFileSync(join(f.pool,'.rmd-git-pool-full-integrity.json'),JSON.stringify({schema:'rmd-git-pool-full-integrity/v1',pool:f.pool,qualification:true,disposition:'PASS'}),{mode:0o600});
  const r=await createSharedWorkspace('unfiled',f.options);assert.equal(r.state,'CREATED_SHARED_OBJECTS_NO_FRESH_INSTALL',r.reason);assert.equal(r.commonGitDir,f.pool);
});
test('Git alternates, changed store kinds and invalid identities refuse without worktree creation',async t=>{
  const f=fixture(t);f.save({...f.policy,poolKind:'qualified-bare'});assert.match((await createSharedWorkspace('unfiled',f.options)).reason!,/kind changed/);
  f.save();writeFileSync(join(f.pool,'.git/objects/info/alternates'),'');assert.match((await createSharedWorkspace('unfiled',f.options)).reason!,/alternates/);
  rmSync(join(f.pool,'.git/objects/info/alternates'));assert.match((await createSharedWorkspace('unfiled',{...f.options,now:()=>NaN})).reason!,/identity/);
});
test('shared workspace CLI status is read-only and rejects filed tasks and overrides',async t=>{
  const f=fixture(t),out:string[]=[],err:string[]=[];t.mock.method(console,'log',(s:string)=>out.push(s));t.mock.method(console,'error',(s:string)=>err.push(s));
  assert.equal(await main(['status'],f.home),0);assert.equal(JSON.parse(out[0]).automaticPruning,false);
  assert.equal(await main(['create','W1-T99'],f.home),1);assert.match(err[0],/filed tasks/);
  f.save({...f.policy,enabled:false});assert.equal(await main(['create','unfiled'],f.home),75);assert.equal(JSON.parse(out.at(-1)!).state,'NOT_RUN');
  const bad=spawnSync(process.execPath,[resolve('scripts/shared-workspace.mjs'),'--apply'],{encoding:'utf8',timeout:3000});assert.equal(bad.status,1);assert.match(bad.stderr,/usage:/);
});
test('native capacity and inherited-worker diagnostics never create or reclaim reservations',async()=>{
  const c=readSharedWorkspaceCapacity(homedir());assert.equal(typeof c.admitted,'boolean');assert.equal(c.minimumFreeBytes,2*1024**3);assert.ok(Number.isSafeInteger(c.freeBytes));
  const probe="import{borrowedWorkspaceWorker}from'./scripts/lib/shared-workspace.mjs';console.log(JSON.stringify(await borrowedWorkspaceWorker()));";
  const p=spawnSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',timeout:3000,env:{...process.env,RMD_TEST_SLOT_PARENT:''}});
  assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),{admitted:false,reason:'no inherited genuine worker'});
  assert.equal(typeof borrowedWorkspaceWorker,'function');
});
test('inherited reservation fixtures require the real ancestor start, nonce, pool and one-worker identity',async t=>{
  // Unit identity fixtures, NOT global allocation or a native capacity qualification.
  // Keep NODE_TEST_CONTEXT and coverage intact. The maintained resolver gives
  // this test process its own private pool; no host reservation is modified.
  const pool=resolveTestSlotDir();assert.equal(pool.scope,'test-process');
  const path=join(pool.dir,'slot-9999999.json'),start=testSlotProcessFacts(process.ppid)!.start;
  const held={pid:process.ppid,ownerNonce:'fixture-nonce',processStart:start,concurrency:1};writeFileSync(path,JSON.stringify(held),{flag:'wx',mode:0o600});
  const owned=lstatSync(path),old=process.env.RMD_TEST_SLOT_PARENT;
  t.after(()=>{const current=lstatSync(path);assert.equal(current.ino,owned.ino);assert.equal(current.dev,owned.dev);rmSync(path);});
  const claim={pid:process.ppid,nonce:held.ownerNonce,start,concurrency:1,path};
  const read=async(value:unknown)=>{process.env.RMD_TEST_SLOT_PARENT=typeof value==='string'?value:JSON.stringify(value);try{return await borrowedWorkspaceWorker();}catch(e){return{admitted:false,reason:(e as Error).message};}};
  try{
    const positive=await read(claim);assert.equal(positive.admitted,true,JSON.stringify(positive));
    for(const value of[{...claim,nonce:'wrong'},{...claim,start:'wrong'},{...claim,concurrency:2},{...claim,path:join(pool.dir,'not-a-slot')},'x'.repeat(16385),'{'])assert.equal((await read(value)).admitted,false);
    writeFileSync(path,JSON.stringify({...held,pid:process.ppid+1000000}));assert.equal((await read(claim)).admitted,false);
  }finally{if(old===undefined)delete process.env.RMD_TEST_SLOT_PARENT;else process.env.RMD_TEST_SLOT_PARENT=old;}
});
