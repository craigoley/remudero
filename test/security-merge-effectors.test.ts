import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {test,type TestContext} from 'node:test';
import {realArmDeps,realArmDepsAsync} from '../src/lib/arm-auto-merge.js';
import {ghPrMergeSquash} from '../src/lib/worker.js';
import {SecurityMergeRefused} from '../src/lib/security-merge-admission.js';
import {withLiveWritesAllowed} from '../src/lib/live-write-guard.js';
import {ghShim} from './helpers/gh-shim.js';
const head='a'.repeat(40),url='https://github.com/craigoley/remudero/pull/11468';
const clean={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
 app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
 output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}};
function fixture(t:TestContext){
 const shim=ghShim([{when:'/files?',stdout:'[{"filename":"src/fixture.ts"}]'},
  {when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[clean]})},
  {when:'api repos/craigoley/remudero/pulls/11468',stdout:JSON.stringify({state:'open',head:{sha:head},
   base:{sha:'b'.repeat(40),ref:'main',repo:{full_name:'craigoley/remudero'}},changed_files:1})}]);
 const path=process.env.PATH,cache=process.env.RMD_GH_CACHE_HOME;
 process.env.PATH=shim.dir+':'+path;process.env.RMD_GH_CACHE_HOME=shim.dir;
 t.after(()=>{process.env.PATH=path;if(cache===undefined)delete process.env.RMD_GH_CACHE_HOME;else process.env.RMD_GH_CACHE_HOME=cache;
  rmSync(shim.dir,{recursive:true,force:true});});
 return shim;
}
test('default core merge effectors bind every actual arm, enqueue, worker and REST write to the verified head',async t=>{
 const shim=fixture(t),sync=realArmDeps(),asyncDeps=realArmDepsAsync();
 await withLiveWritesAllowed(async()=>{
  sync.armAuto(url);sync.enqueue!(url);sync.mergeDirect(url);
  await asyncDeps.armAuto(url);await asyncDeps.enqueue!(url);await asyncDeps.mergeDirect(url);
  ghPrMergeSquash(url,()=>({state:'clean',defused:[]}));
 });
 const writes=shim.calls().filter(call=>call.startsWith('pr merge ')||call.includes('PUT'));
 assert.equal(writes.length,7,'positive control: all seven real outward boundaries reached the offline executable');
 for(const write of writes)assert.ok(write.startsWith('pr merge ')?write.includes('--match-head-commit '+head):
  write.split(' ').filter(arg=>arg.startsWith('sha=')).join('')==='sha='+head,write);
});
test('default core merge effectors refuse new high and UNKNOWN evidence before any actual write',async t=>{
 const shim=fixture(t),sync=realArmDeps(),asyncDeps=realArmDepsAsync();
 for(const check of [{...clean,conclusion:'failure',output:{title:'1 new alert including 1 high severity security vulnerability',summary:' * 1 high\n'}},
  {...clean,status:'in_progress',conclusion:null}]){
  shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[check]})});
  await withLiveWritesAllowed(async()=>{
   assert.throws(()=>sync.armAuto(url),SecurityMergeRefused);assert.throws(()=>sync.enqueue!(url),SecurityMergeRefused);
   assert.throws(()=>sync.mergeDirect(url),SecurityMergeRefused);
   await assert.rejects(async()=>await asyncDeps.armAuto(url),SecurityMergeRefused);await assert.rejects(async()=>await asyncDeps.enqueue!(url),SecurityMergeRefused);
   await assert.rejects(async()=>await asyncDeps.mergeDirect(url),SecurityMergeRefused);
   assert.throws(()=>ghPrMergeSquash(url,()=>({state:'clean',defused:[]})),SecurityMergeRefused);
  });
 }
 assert.ok(shim.calls().some(call=>call.includes('/check-runs?')),'positive control: refused observations saw the security corpus');
 assert.equal(shim.calls().some(call=>call.startsWith('pr merge ')||call.includes('PUT')),false);
});
