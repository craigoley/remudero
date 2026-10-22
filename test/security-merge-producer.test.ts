import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {parse} from 'yaml';
import {ghShim} from './helpers/gh-shim.js';
import {ghStubPath} from './helpers/gh-stub.js';
// @ts-expect-error — trusted metadata producer is plain ESM outside tsconfig roots.
import {runSecurityMergeProducer,createSecurityMetadataReader} from '../scripts/security-merge-producer.mjs';
const head='a'.repeat(40),base='b'.repeat(40);
const repository={full_name:'craigoley/remudero'};
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
  {when:'GET',stdout:JSON.stringify({state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:repository},changed_files:1})}]);
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const answer=join(shim.dir,'gh');
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
