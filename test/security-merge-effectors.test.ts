import assert from 'node:assert/strict';
import {rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {makeTempDir} from '#src/lib/tmp.js';
import type {Config} from '#src/lib/config.js';
import {test,type TestContext} from 'node:test';
import {attemptArmAsync,armFailureAction,armFailureIsRateLimited,realArmDeps,realArmDepsAsync} from '../src/lib/arm-auto-merge.js';
import {ghPrMergeSquash} from '../src/lib/worker.js';
import {SecurityMergeRefused} from '../src/lib/security-merge-admission.js';
import {withLiveWritesAllowed} from '../src/lib/live-write-guard.js';
import {ghShim} from './helpers/gh-shim.js';
const head='a'.repeat(40),url='https://github.com/craigoley/remudero/pull/11468';
const clean={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
 app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
 output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}};
function fixture(t:TestContext){
 const root=makeTempDir('merge-hold-fence');
 mkdirSync(join(root,'state'));
 const ledger=join(root,'state','ledger.ndjson');
 writeFileSync(ledger,'');
 const shim=ghShim([{when:'/files?',stdout:'[{"filename":"src/fixture.ts"}]'},
  {when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[clean]})},
  {when:'api repos/craigoley/remudero/pulls/11468',stdout:JSON.stringify({state:'open',head:{sha:head},
   base:{sha:'b'.repeat(40),ref:'main',repo:{full_name:'craigoley/remudero'}},changed_files:1})}]);
 const path=process.env.PATH,cache=process.env.RMD_GH_CACHE_HOME;
 process.env.PATH=shim.dir+':'+path;process.env.RMD_GH_CACHE_HOME=shim.dir;
 t.after(()=>{process.env.PATH=path;if(cache===undefined)delete process.env.RMD_GH_CACHE_HOME;else process.env.RMD_GH_CACHE_HOME=cache;
  rmSync(shim.dir,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});});
 return Object.assign(shim,{root,ledger});
}
test('default core merge effectors bind every actual arm, enqueue, worker and REST write to the verified head',async t=>{
 const shim=fixture(t),sync=realArmDeps(()=>({root:shim.root} as Config)),asyncDeps=realArmDepsAsync(()=>({root:shim.root} as Config));
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
 const shim=fixture(t),sync=realArmDeps(()=>({root:shim.root} as Config)),asyncDeps=realArmDepsAsync(()=>({root:shim.root} as Config));
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
test('security UNKNOWN recovery rechecks the same head without a fresh SHA or an ungated fallback',async t=>{
 const shim=fixture(t),port=realArmDepsAsync(()=>({root:shim.root} as Config));
 shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[{...clean,status:'in_progress',conclusion:null}]})});
 await withLiveWritesAllowed(async()=>{
  await assert.rejects(async()=>await port.armAuto(url),(error:unknown)=>{
   assert.ok(error instanceof SecurityMergeRefused);assert.equal(error.state,'unknown');
   assert.equal(armFailureAction(error.message),'retryable');assert.equal(armFailureIsRateLimited(error.message),false);return true;
  });
  assert.equal(shim.calls().some(call=>call.startsWith('pr merge ')),false);
  shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[clean]})});
  await port.armAuto(url);
 });
 const writes=shim.calls().filter(call=>call.startsWith('pr merge '));assert.equal(writes.length,1);
 assert.ok(writes[0]!.includes('--match-head-commit '+head));
 assert.equal(armFailureAction(new SecurityMergeRefused('blocked','new-high-alert').message),'retryable');
 assert.equal(armFailureIsRateLimited(new SecurityMergeRefused('blocked','new-high-alert').message),false);
});
test('all seven default merge effectors refuse a core URL case alias before any executable write',async t=>{
 const shim=fixture(t),sync=realArmDeps(()=>({root:shim.root} as Config)),asyncDeps=realArmDepsAsync(()=>({root:shim.root} as Config)),alias='https://github.com/CRAIGOLEY/REMUDERO/pull/11468';
 const errors:unknown[]=[];
 await withLiveWritesAllowed(async()=>{
  const syncCalls=[()=>sync.armAuto(alias),()=>sync.enqueue!(alias),()=>sync.mergeDirect(alias),()=>ghPrMergeSquash(alias,()=>({state:'clean',defused:[]}))];
  for(const invoke of syncCalls)try{invoke();errors.push(null);}catch(error){errors.push(error);}
  for(const invoke of [()=>asyncDeps.armAuto(alias),()=>asyncDeps.enqueue!(alias),()=>asyncDeps.mergeDirect(alias)])try{await invoke();errors.push(null);}catch(error){errors.push(error);}
 });
 assert.equal(errors.length,7,'positive control: every real boundary was called');
 assert.equal(shim.calls().filter(call=>call.startsWith('pr merge ')||call.includes('PUT')).length,0,'no alias can escape the guard into an executable merge');
 for(const error of errors)assert(error instanceof SecurityMergeRefused&&error.state==='unknown'&&error.reason==='noncanonical-pr-target');
});

for(const asyncMode of [false,true])for(const method of ['armAuto','mergeDirect','enqueue'] as const){
 test(`real ${asyncMode?'async':'sync'} ${method} refuses a hold arriving during security metadata`,async t=>{
  const shim=fixture(t);
  const row={ts:'2026-10-27T16:07:27.884Z',step:'automerge.hold_engaged',authority:'console-confirmed',
   by:'fixture-operator',reason:'retain this exact PR hold',pr_number:11468};
  shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[clean]}),
   writes:{path:shim.ledger,content:JSON.stringify(row)+'\n'}});
  const deps=asyncMode?realArmDepsAsync(()=>({root:shim.root} as Config)):realArmDeps(()=>({root:shim.root} as Config));
  await withLiveWritesAllowed(async()=>{
   await assert.rejects(async()=>await deps[method]!(url),/operator merge hold stands/);
  });
  assert.ok(shim.calls().some(call=>call.includes('/check-runs?')),'the real security read ran before the hold fence');
  assert.equal(shim.calls().some(call=>call.startsWith('pr merge ')||call.includes('PUT')),false);
 });
}

test('final merge fences refuse unreadable configuration and torn hold evidence',async t=>{
 const shim=fixture(t);
 await withLiveWritesAllowed(async()=>{
  assert.throws(()=>realArmDeps(()=>{throw Error('fixture config unavailable');}).armAuto(url),/fixture config unavailable/);
  writeFileSync(shim.ledger,'{torn-hold');
  await assert.rejects(async()=>await realArmDepsAsync(()=>({root:shim.root} as Config)).armAuto(url),/hold evidence is unavailable or torn/);
  rmSync(shim.ledger);
  await assert.rejects(async()=>await realArmDepsAsync(()=>({root:shim.root} as Config)).armAuto(url),/hold evidence is unavailable or torn/);
 });
 assert.equal(shim.calls().some(call=>call.startsWith('pr merge ')||call.includes('PUT')),false);
});

for(const route of ['auto','queue-auto','direct','queue-enqueue','quota','quota-retry'] as const){
 test(`a late real-effector hold remains a named refusal through the ${route} path`,async t=>{
  const shim=fixture(t),real=realArmDepsAsync(()=>({root:shim.root} as Config));
  shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[clean]}),writes:{path:shim.ledger,
   content:JSON.stringify({step:'automerge.hold_engaged',authority:'console-confirmed',by:'fixture-operator',
    reason:'hold arrived during trusted metadata',pr_number:11468})+'\n'}});
  let attempts=0;
  const deps={...real,ledgerLines:()=>[],say:()=>{},contributorAdmission:async()=>{},
   stackPrerequisite:async()=>({state:'unstacked' as const,parentNumbers:[]}),
   closingReferences:async()=>({state:'clean' as const,defused:[]}),
   mergeQueue:async()=>route.startsWith('queue'),readPlanTouch:async()=> 'untouched' as const,
   readMergedRatchets:undefined,readMergeFacts:async()=>({mergeable:'MERGEABLE' as const,mergeableState:'clean',behindBy:0}),
   updateBranch:async()=>({ok:true}),isMerged:async()=>false,
   armAuto:['auto','queue-auto'].includes(route)?real.armAuto:async()=>{
    throw Error(route.startsWith('quota')?'GraphQL: API rate limit already exceeded for user ID 4397075.':'Pull request is in clean status');
   },mergeDirect:async(p:string)=>{
    if(route==='quota-retry' && attempts++===0)throw Error('HTTP 405: mergeability is unsettled');
    await real.mergeDirect(p);
   }};
  await withLiveWritesAllowed(async()=>{
   const result=await attemptArmAsync(url,deps);
   assert.equal(result.outcome,'hold-refused');
  });
  assert.ok(shim.calls().some(call=>call.includes('/check-runs?')),'the actual metadata-to-write interval was reached');
  assert.equal(shim.calls().some(call=>call.startsWith('pr merge ')||call.includes('PUT')),false);
 });
}
