import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {parse} from 'yaml';
import {ghShim} from '#test/helpers/gh-shim.js';
import {ghStubPath} from '#test/helpers/gh-stub.js';
// @ts-expect-error — trusted metadata producer is plain ESM outside tsconfig roots.
import {runSecurityMergeProducer,createSecurityMetadataReader} from '#scripts/security-merge-producer.mjs';
const head='a'.repeat(40),base='b'.repeat(40);
const repository={full_name:'craigoley/remudero'};
// A verified repository-local CodeQL run: id, live attempt, trusted workflow path and non-fork head repository.
const codeqlRun=(extra:object={})=>({id:7,name:'CodeQL',head_sha:head,run_attempt:1,path:'.github/workflows/codeql.yml',
 status:'completed',conclusion:'success',repository,head_repository:repository,...extra});

test('CodeQL workflow completion reobserves its asynchronous analysis without granting stale or unknown permission',async()=>{
 for(const outcome of ['safe','blocked','pending','drift','unreadable'] as const){
  let waits=0;const writes:any[]=[];
  const event={repository,workflow_run:codeqlRun()};
  const api={
   wait:async(ms:number)=>{assert.equal(ms,60_000);waits++;},
   read:async(p:string)=>{
    if(p.includes('/actions/runs/'))return codeqlRun();
    if(p.includes('/pulls?'))return [{number:1,state:'open',head:{sha:head}}];
    if(p.includes('/files?'))return [{filename:'src/security.ts'}];
    if(p.includes('/check-runs?')){
     if(waits && outcome==='unreadable')throw Error('metadata unavailable');
     const completed=waits>0 && outcome!=='pending';
     return {total_count:1,check_runs:[{id:1,name:'CodeQL',head_sha:head,
      app:{slug:'github-advanced-security',id:57789,owner:{login:'github'}},
      status:completed?'completed':'queued',conclusion:completed?'success':null,
      output:completed?{title:'No new alerts in code changed by this pull request',summary:outcome==='blocked'
       ?'Security Alerts:\n * 1 high\n'
       :'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A1+tool%3ACodeQL+is%3Aopen).'}:{}}]};
    }
    return {state:'open',head:{sha:waits && outcome==='drift'?'c'.repeat(40):head},
     base:{sha:base,ref:'main',repo:repository},changed_files:1};
   },status:async(s:any)=>writes.push(s),
  };
  const [result]=await runSecurityMergeProducer('workflow_run',event,api);
  assert.equal(waits,outcome==='pending'?3:1,outcome);
  assert.equal(writes[0].state,'error',outcome);
  assert.equal(result.decision.mergeAllowed,outcome==='safe',outcome);
  assert.equal(writes.some(s=>s.state==='success'),outcome==='safe',outcome);
  assert.ok(writes.every(s=>s.sha===head),outcome);
  if(outcome==='pending')assert.equal(writes.length,4);
  if(outcome==='blocked')assert.equal(writes.at(-1).state,'failure');
  if(outcome==='drift'){assert.equal(writes.length,1);assert.equal(result.published,false);}
  if(outcome==='unreadable')assert.equal(writes.at(-1).state,'error');
 }
});

test('security completion reobservation excludes unrelated events and untrusted analysis identities',async()=>{
 for(const scenario of ['pull-request','running','failed-workflow','untrusted'] as const){
  const event={repository,pull_request:{number:1,head:{sha:head}},workflow_run:{name:'CodeQL',head_sha:head,
   status:scenario==='running'?'in_progress':'completed',conclusion:scenario==='failed-workflow'?'failure':'success'}};
  const writes:any[]=[];
  const api={wait:async()=>{throw Error('must not wait');},status:async(s:any)=>writes.push(s),read:async(p:string)=>
   p.includes('/pulls?')?[{number:1,state:'open',head:{sha:head}}]:p.includes('/files?')?[{filename:'src/security.ts'}]:
   p.includes('/check-runs?')?{total_count:1,check_runs:[{id:1,name:'CodeQL',head_sha:head,status:'queued',
    app:{slug:'github-advanced-security',id:scenario==='untrusted'?123:57789,owner:{login:'github'}}}]}:
   {state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1}};
  const [result]=await runSecurityMergeProducer(scenario==='pull-request'?'pull_request_target':'workflow_run',event,api);
  assert.equal(result.decision.mergeAllowed,false);assert.equal(writes.length,1);assert.equal(writes[0].state,'error');
 }
});
test('trusted security producer covers fork and Dependabot metadata without executing their code',async()=>{
 const writes:any[]=[];
 const api={read:async(p:string)=>p.includes('/files?')?[{filename:'docs/a.md'}]:{state:'open',head:{sha:head},
  base:{sha:base,ref:'main',repo:repository},changed_files:1},status:async(s:any)=>writes.push(s)};
 for(const user of ['fork-owner','dependabot[bot]']){
  const rows=await runSecurityMergeProducer('pull_request_target',{repository,pull_request:{number:1,head:{sha:head},user:{login:user}}},api);
  assert.equal(rows[0].decision.state,'not-applicable');assert.equal(writes.at(-1).state,'success');
 }
 await assert.rejects(()=>runSecurityMergeProducer('pull_request_target',{repository:{full_name:'attacker/repo'}},api));
 assert.equal(writes.length,2);
});
test('trusted security producer follows exact-head CodeQL completion and refuses truncated association or unsupported events',async()=>{
 const statuses:any[]=[];const read=async(p:string)=>p.includes('/pulls?')?[{number:1,state:'open',head:{sha:head}},{number:2,state:'open',head:{sha:base}}]:
 p.includes('/files?')?[{filename:'docs/a.md'}]:{state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1};
 const api={read,status:async(s:any)=>statuses.push(s)};
 assert.equal((await runSecurityMergeProducer('workflow_run',{repository,workflow_run:{name:'CodeQL',head_sha:head}},api)).length,1);
 await assert.rejects(()=>runSecurityMergeProducer('workflow_run',{repository,workflow_run:{name:'CodeQL',head_sha:head}},
 {...api,read:async()=>Array(100).fill({})}),/incomplete/);
 await assert.rejects(()=>runSecurityMergeProducer('push',{repository},api),/unsupported/);
 await assert.rejects(()=>runSecurityMergeProducer('workflow_dispatch',{repository,inputs:{pr_number:'1; bad'}},api),/invalid/);
});
test('merge-group security evidence is explicitly UNKNOWN until separately qualified, never a native-ruleset bypass',async()=>{
 const statuses:any[]=[];
 const result=await runSecurityMergeProducer('merge_group',{repository,merge_group:{head_sha:head}},
 {read:async()=>{throw Error('must not execute group source');},status:async(s:any)=>statuses.push(s)});
 assert.equal(result[0].decision.mergeAllowed,false);assert.equal(statuses[0].state,'error');assert.equal(statuses[0].sha,head);
});
test('security producer workflow always checks out trusted main with no credentials or dependencies',()=>{
 const text=readFileSync(new URL('../.github/workflows/security-merge-policy.yml',import.meta.url),'utf8');
 const flow=parse(text);assert.ok(flow.on.pull_request_target);assert.ok(flow.on.workflow_run);assert.ok(flow.on.merge_group);
 assert.equal(flow.jobs.metadata.steps[0].with.ref,'main');assert.equal(flow.jobs.metadata.steps[0].with['persist-credentials'],false);
 assert.equal(flow.jobs.metadata.permissions['statuses'],'write');
 assert.equal(text.includes('npm ci'),false);assert.equal(text.includes('pull_request.head.sha'),false);
 assert.equal(text.includes('schedule:'),false);
});
test('security producer real CLI transport shells out, publishes exact-head metadata and preserves API failure as UNKNOWN',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-security-transport-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json');
 writeFileSync(eventPath,JSON.stringify({repository,pull_request:{number:1,head:{sha:head}}}));
 const shim=ghShim([{when:'POST',stdout:'{}'},{when:'/files?',stdout:JSON.stringify([{filename:'docs/a.md'}])},
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1})}]);
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const env={...process.env,PATH:shim.dir+':'+process.env.PATH,GH_TOKEN:'',GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'pull_request_target',GITHUB_RUN_ID:'1'};
 const command=new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname;
 const run=()=>spawnSync(process.execPath,[command],{env,encoding:'utf8',timeout:10000});
 const good=run();assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).results[0].decision.state,'not-applicable');
 assert.ok(shim.calls().some(call=>call.includes('/statuses/'+head)));
 shim.addRoute({when:'POST',exit:1});assert.equal(run().status,1,'failed publication cannot claim success');
 shim.addRoute({when:'GET',exit:1});
 const unavailable=run();assert.equal(unavailable.status,1);assert.equal(JSON.parse(unavailable.stdout).results[0].decision.state,'unknown');
});

test('security producer delivery succeeds for published UNKNOWN and blocked decisions without granting merge permission',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-security-delivery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json');
 const check={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'failure',
  app:{slug:'github-advanced-security',id:57789,owner:{login:'github'}},
  output:{title:'1 new alert',summary:'Security Alerts:\n * 1 high\n'}};
 const shim=ghShim([{when:'POST',stdout:'{}'},{when:'/files?',stdout:JSON.stringify([{filename:'src/security.ts'}])},
  {when:'/check-runs?',stdout:JSON.stringify({total_count:0,check_runs:[]})},
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1})}]);
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const env={...process.env,PATH:shim.dir+':'+process.env.PATH,GH_TOKEN:'',GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'pull_request_target',GITHUB_RUN_ID:'1'};
 const command=new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname;
 const run=()=>spawnSync(process.execPath,[command],{env,encoding:'utf8',timeout:10000});
 const verify=(expected:string,status:string)=>{
  const from=shim.calls().length,child=run();
  assert.equal(child.status,0,child.stderr||child.stdout);
  const result=JSON.parse(child.stdout).results[0];
  assert.equal(result.headSha,head);assert.equal(result.published,true);
  assert.equal(result.decision.state,expected);assert.equal(result.decision.mergeAllowed,false);
  const writes=shim.calls().slice(from).filter(call=>call.includes('/statuses/'+head));
  assert.equal(writes.length,1);assert.ok(writes[0].includes('state='+status));assert.equal(writes[0].includes('state=success'),false);
 };
 writeFileSync(eventPath,JSON.stringify({repository,pull_request:{number:1,head:{sha:head}}}));
 verify('unknown','error');
 shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[check]})});
 verify('blocked','failure');
 env.GITHUB_EVENT_NAME='merge_group';
 writeFileSync(eventPath,JSON.stringify({repository,merge_group:{head_sha:head}}));
 verify('unknown','error');
});


test('security metadata reads bound truncated CLI recovery without retrying permanent or malformed evidence',async()=>{
 const path=`repos/craigoley/remudero/commits/${head}/pulls?per_page=100`;
 for(const kind of ['transient','persistent','permanent','other-json','malformed-output','signalled'] as const){
  const calls:any[]=[];const waits:number[]=[];
  const failure=Object.assign(Error('metadata unavailable'),{status:kind==='signalled'?null:1,
   stderr:kind==='permanent'?'HTTP 403':kind==='other-json'?'invalid character in JSON':'unexpected end of JSON input\n'});
  const read=createSecurityMetadataReader({exec:(command:string,args:string[],options:any)=>{
   calls.push({command,args:[...args],options});
   if(kind==='malformed-output')return '{';
   if(kind==='transient'&&calls.length===2)return '[{"number":1}]';
   throw failure;
  },wait:async(ms:number)=>{waits.push(ms);}});
  if(kind==='transient')assert.deepEqual(await read(path),[{number:1}]);
  else await assert.rejects(()=>read(path),kind==='malformed-output'?SyntaxError:(error:unknown)=>error===failure);
  assert.equal(calls.length,kind==='persistent'?4:kind==='transient'?2:1,kind);
  assert.deepEqual(waits,kind==='persistent'?[1000,2000,4000]:kind==='transient'?[1000]:[],kind);
  assert.ok(calls.every(call=>JSON.stringify(call)===JSON.stringify(calls[0])), 'retry keeps every argv and transport limit');
  assert.deepEqual(calls[0].args,['api','--method','GET',path]);
 }
});

test('security producer CLI recovers a truncated association read and publishes only its exact-head decision',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-security-read-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json'),log=join(dir,'calls.jsonl'),marker=join(dir,'failed-once');
 writeFileSync(eventPath,JSON.stringify({repository,workflow_run:{name:'CodeQL',head_sha:head}}));
 const shim=ghShim([{when:'POST',stdout:'{}'},
  {when:'/commits/'+head+'/pulls?',stdout:JSON.stringify([{number:1,state:'open',head:{sha:head}}])},
  {when:'/files?',stdout:JSON.stringify([{filename:'docs/a.md'}])},
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1})}],{command:'security-metadata-answer'});
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const answer=join(shim.dir,'security-metadata-answer');
 const wrapper=ghStubPath(`#!/usr/bin/env node
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'failed');process.stderr.write('unexpected end of JSON input\\n');process.exit(1);}
const child=spawnSync(${JSON.stringify(answer)},args,{encoding:'utf8'});process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);
`);
 t.after(()=>rmSync(dirname(wrapper),{recursive:true,force:true}));
 const child=spawnSync(process.execPath,[new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname],{
  encoding:'utf8',timeout:15000,env:{...process.env,PATH:wrapper+':'+process.env.PATH,GH_TOKEN:'',
   GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'1'}});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const result=JSON.parse(child.stdout).results[0];assert.equal(result.headSha,head);
 assert.equal(result.decision.state,'not-applicable');assert.equal(result.published,true);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(calls[0],calls[1],'only the same association read is repeated');
 assert.equal(calls.filter(call=>call.includes('POST')).length,1,'status writes retain their single attempt');
});


test('security metadata retries a recorded HTTP 503 within the existing budget and keeps permanent failures closed',async()=>{
 const path=`repos/craigoley/remudero/commits/${head}/pulls?per_page=100`;
 for(const kind of ['transient-503','persistent-503','permanent-403','signalled-503','text-only-503'] as const){
  const calls:any[]=[];const waits:number[]=[];
  const failure=Object.assign(Error('metadata unavailable'),{status:kind==='signalled-503'?null:1,
   stderr:kind==='permanent-403'?'gh: HTTP 403':kind==='text-only-503'?'body mentioned gh: HTTP 503':'gh: HTTP 503\n'});
  const read=createSecurityMetadataReader({exec:(command:string,args:string[],options:any)=>{
   calls.push({command,args:[...args],options});
   if(kind==='transient-503'&&calls.length===2)return '[{"number":1}]';
   throw failure;
  },wait:async(ms:number)=>{waits.push(ms);}});
  if(kind==='transient-503')assert.deepEqual(await read(path),[{number:1}]);
  else await assert.rejects(()=>read(path),(error:unknown)=>error===failure);
  assert.equal(calls.length,kind==='persistent-503'?4:kind==='transient-503'?2:1,kind);
  assert.deepEqual(waits,kind==='persistent-503'?[1000,2000,4000]:kind==='transient-503'?[1000]:[],kind);
  assert.ok(calls.every(call=>JSON.stringify(call)===JSON.stringify(calls[0])), 'only the identical bounded read repeats');
 }
});


test('security producer CLI recovers HTTP 503 and publishes its exact-head decision once',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-security-503-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json'),log=join(dir,'calls.jsonl'),marker=join(dir,'failed-once');
 writeFileSync(eventPath,JSON.stringify({repository,workflow_run:{name:'CodeQL',head_sha:head}}));
 const shim=ghShim([{when:'POST',stdout:'{}'},
  {when:'/commits/'+head+'/pulls?',stdout:JSON.stringify([{number:1,state:'open',head:{sha:head}}])},
  {when:'/files?',stdout:JSON.stringify([{filename:'docs/a.md'}])},
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1})}],{command:'security-metadata-answer'});
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const answer=join(shim.dir,'security-metadata-answer');
 const wrapper=ghStubPath(`#!/usr/bin/env node
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'failed');process.stderr.write('gh: HTTP 503\\n');process.exit(1);}
const child=spawnSync(${JSON.stringify(answer)},args,{encoding:'utf8'});process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);
`);
 t.after(()=>rmSync(dirname(wrapper),{recursive:true,force:true}));
 const child=spawnSync(process.execPath,[new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname],{
  encoding:'utf8',timeout:15000,env:{...process.env,PATH:wrapper+':'+process.env.PATH,GH_TOKEN:'',
   GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'1'}});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const result=JSON.parse(child.stdout).results[0];assert.equal(result.headSha,head);
 assert.equal(result.decision.state,'not-applicable');assert.equal(result.published,true);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(calls[0],calls[1],'only the same association read is repeated');
 assert.equal(calls.filter(call=>call.includes('POST')).length,1,'status writes retain their single attempt');
});

// ---- W1-T10976: a missing CodeQL configuration recovers only from complete same-merge analyses ----
const merge='c'.repeat(40);
const KEY='.github/workflows/codeql.yml:analyze';
const CATEGORIES=['/language:javascript-typescript','/language:actions','/language:python'];
const analysis=(category:string,id:number,extra:object={})=>({id,ref:'refs/pull/1/merge',commit_sha:merge,analysis_key:KEY,category,
 error:'',warning:'',results_count:0,created_at:'2026-11-09T03:29:00Z',tool:{name:'CodeQL'},...extra});
type Knobs={arrived:(waits:number)=>any[];alerts?:any[];baseAlerts?:any[];run?:(waits:number)=>any;pr?:(waits:number)=>object;clock?:{t:number};waitCost?:number};
async function recover(summaryFor:(c:string)=>string,knobs:Knobs,runExtra:object={}) {
 let waits=0;const writes:any[]=[],paths:string[]=[],clock=knobs.clock??{t:0};
 const warning={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'neutral',
  app:{slug:'github-advanced-security',id:57789,owner:{login:'github'}},
  output:{title:'1 configuration not found',summary:summaryFor('/language:python')}};
 const api={now:()=>clock.t,wait:async(ms:number)=>{assert.equal(ms,60_000);waits++;clock.t+=knobs.waitCost??ms;},
  status:async(s:any)=>writes.push(s),read:async(p:string)=>{
   paths.push(p);
   if(p.includes('/actions/runs/'))return knobs.run?.(waits)??codeqlRun();
   if(p.includes('/pulls?'))return [{number:1,state:'open',head:{sha:head}}];
   if(p.includes('/files?'))return [{filename:'src/security.ts'}];
   if(p.includes('/check-runs?'))return {total_count:1,check_runs:[warning]};
   if(p.includes('/git/ref/pull/1/merge'))return {object:{sha:merge}};
   if(p.endsWith('/commits/'+merge))return {sha:merge,parents:[{sha:base},{sha:head}]};
   if(p.includes('/code-scanning/analyses?'))return p.endsWith('page=1')?knobs.arrived(waits):[];
   if(p.includes('/code-scanning/alerts?'))return p.includes('refs/heads/main')?knobs.baseAlerts??[]:knobs.alerts??[];
   return {state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1,merge_commit_sha:merge,
    ...knobs.pr?.(waits)};
  }};
 const [result]=await runSecurityMergeProducer('workflow_run',{repository,workflow_run:codeqlRun(runExtra)},api);
 return {result,writes,paths,waits:()=>waits,clock};
}
// @ts-expect-error — trusted policy module is plain ESM outside tsconfig roots.
import {missingConfigurationSummary} from '#src/lib/code-scanning-merge-policy.mjs';
const all=()=>CATEGORIES.map((c,i)=>analysis(c,10+i));

test('delayed category arrival recovers a missing configuration only after complete same-merge evidence',async()=>{
 const r=await recover(c=>missingConfigurationSummary(1,c),{arrived:w=>w===0?all().slice(0,2):all()});
 assert.equal(r.waits(),1);
 assert.deepEqual(r.writes.map(s=>s.state),['error','success']);
 assert.match(r.writes[0].description,/codeql-configuration-recovery-pending/);
 assert.match(r.writes[1].description,/trusted-missing-configuration-reconciled-by-complete-analyses/);
 assert.ok(r.writes.every(s=>s.sha===head));assert.equal(r.result.decision.mergeAllowed,true);
 assert.deepEqual(r.result.observation.recovery.categories.sort(),[...CATEGORIES].sort());
 assert.equal(r.paths.some(p=>p.includes('tool_name')),false,'no tool_name filter is requested');
});
test('a permanently missing category exhausts the shared window with a distinct UNKNOWN, never success',async()=>{
 const r=await recover(c=>missingConfigurationSummary(1,c),{arrived:()=>all().slice(0,2)});
 assert.equal(r.waits(),3);
 assert.equal(r.writes.some(s=>s.state==='success'),false);
 assert.equal(r.writes.at(-1).state,'error');assert.match(r.writes.at(-1).description,/^unknown: codeql-configuration-recovery-exhausted/);
 assert.equal(r.result.recoveryAttempts,3);assert.equal(r.result.recoveryRun.verified,true);
});
test('the monotonic 240-second deadline never starts a wait that cannot fit and still publishes the final disposition',async()=>{
 const r=await recover(c=>missingConfigurationSummary(1,c),{arrived:()=>all().slice(0,2),waitCost:100_000});
 assert.equal(r.waits(),2,'a third wait would end at 300s, past the 240s budget');
 assert.match(r.writes.at(-1).description,/recovery-exhausted/);
 assert.equal(r.writes.some(s=>s.state==='success'),false);
});
test('failed, foreign, spoofed or superseded CodeQL workflow runs never enter the missing-configuration recovery',async()=>{
 const cases:Array<[string,object,((w:number)=>any)?]>=[
  ['wrong path',{path:'.github/workflows/evil.yml'}],['fork head',{head_repository:{full_name:'x/remudero'}}],
  ['no attempt',{run_attempt:undefined}],['no id',{id:undefined}],
  ['superseded attempt',{},()=>codeqlRun({run_attempt:2})],['live run failed',{},()=>codeqlRun({conclusion:'failure'})],
  ['live run foreign head',{},()=>codeqlRun({head_sha:base})]];
 for(const [label,extra,run] of cases){
  const r=await recover(c=>missingConfigurationSummary(1,c),{arrived:()=>all().slice(0,2),run},extra);
  assert.equal(r.waits(),0,label);assert.equal(r.writes.some(s=>s.state==='success'),false,label);
 }
});
test('merge, head or base drift during recovery never posts a stale success',async()=>{
 const drifts:Array<[string,(w:number)=>object]>=[
  ['merge sha changes',w=>w===0?{}:{merge_commit_sha:'d'.repeat(40)}],
  ['pr closed',w=>w===0?{}:{state:'closed'}],
  ['base changes',w=>w===0?{}:{base:{sha:'e'.repeat(40),ref:'main',repo:repository}}]];
 for(const [label,pr] of drifts){
  const r=await recover(c=>missingConfigurationSummary(1,c),{arrived:w=>w===0?all().slice(0,2):all(),pr});
  assert.equal(r.writes.some(s=>s.state==='success'),false,label);assert.ok(r.writes.every(s=>s.sha===head),label);
 }
});
test('an unrecognized warning or a genuine new high alert is never reconciled to success',async()=>{
 const odd=await recover(()=>'unrecognized comparison state',{arrived:()=>all()});
 assert.equal(odd.waits(),0);assert.equal(odd.writes.length,1);assert.match(odd.writes[0].description,/unrecognized-warning/);
 const alert={number:9,tool:{name:'CodeQL'},rule:{security_severity_level:'high'},most_recent_instance:{ref:'refs/pull/1/merge',
  commit_sha:merge,analysis_key:KEY,category:'/language:python'}};
 const blocked=await recover(c=>missingConfigurationSummary(1,c),{arrived:()=>all(),alerts:[alert]});
 assert.equal(blocked.writes.at(-1).state,'failure');assert.deepEqual(blocked.result.observation.recovery.newHighCritical,[9]);
 const inherited=await recover(c=>missingConfigurationSummary(1,c),{arrived:()=>all(),alerts:[alert],baseAlerts:[{number:9}]});
 assert.equal(inherited.writes.at(-1).state,'success','an alert already open on main is not new in this PR');
});
test('security producer workflow grants only job-level security-events read for the recovery reads',()=>{
 const flow=parse(readFileSync(new URL('../.github/workflows/security-merge-policy.yml',import.meta.url),'utf8'));
 assert.equal(flow.jobs.metadata.permissions['security-events'],'read');
 assert.equal(flow.permissions['security-events'],undefined);assert.equal(flow.jobs.metadata['timeout-minutes'],5);
});
test('security producer real CLI transport carries the recovery reads through the gh shim without a tool_name filter',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-security-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json');
 writeFileSync(eventPath,JSON.stringify({repository,workflow_run:codeqlRun()}));
 const warning={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'neutral',
  app:{slug:'github-advanced-security',id:57789,owner:{login:'github'}},
  output:{title:'1 configuration not found',summary:missingConfigurationSummary(1,'/language:python')}};
 const shim=ghShim([{when:'POST',stdout:'{}'},
  {when:'/commits/'+head+'/pulls?',stdout:JSON.stringify([{number:1,state:'open',head:{sha:head}}])},
  {when:'/files?',stdout:JSON.stringify([{filename:'src/security.ts'}])},
  {when:'/check-runs?',stdout:JSON.stringify({total_count:1,check_runs:[warning]})},
  {when:'/actions/runs/',stdout:JSON.stringify(codeqlRun())},
  {when:'/git/ref/pull/1/merge',stdout:JSON.stringify({object:{sha:merge}})},
  {when:'/code-scanning/analyses?',stdout:JSON.stringify(all())},
  {when:'/code-scanning/alerts?',stdout:'[]'},
  {when:'/commits/'+merge,stdout:JSON.stringify({sha:merge,parents:[{sha:base},{sha:head}]})},
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1,merge_commit_sha:merge})}]);
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const child=spawnSync(process.execPath,[new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:15000,
  env:{...process.env,PATH:shim.dir+':'+process.env.PATH,GH_TOKEN:'',GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'1'}});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const result=JSON.parse(child.stdout).results[0];assert.equal(result.decision.mergeAllowed,true);
 const calls=shim.calls();assert.ok(calls.some(c=>c.includes('/code-scanning/analyses?')));
 assert.equal(calls.some(c=>c.includes('tool_name')),false);
 assert.equal(calls.filter(c=>c.includes('/statuses/'+head)&&c.includes('state=success')).length,1);
});
