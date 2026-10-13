import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — trusted metadata script is plain ESM, outside tsconfig source roots.
import {readSecurityMergeDecision, publishSecurityMergeDecision} from '../scripts/lib/code-scanning-merge-adapter.mjs';
const head='a'.repeat(40),other='b'.repeat(40);
const target={owner:'craigoley',repo:'remudero',prNumber:11468,expectedHead:head};
const pr=()=>({state:'open',head:{sha:head},base:{sha:other,ref:'main',repo:{full_name:'craigoley/remudero'}},changed_files:1});
const clean=()=>({id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
 app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
 output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}});
function fixture({files=[{filename:'src/a.ts'}],checks=[clean()],row=pr()}:{files?:any[];checks?:any[];row?:any}={}){
 const reads:string[]=[];
 const read=async(path:string)=>{reads.push(path);return path.includes('/files?')?files:path.includes('/check-runs?')?{total_count:checks.length,check_runs:checks}:row;};
 return {reads,read};
}
test('security metadata adapter binds complete trusted CodeQL evidence and denies spoofed high results',async()=>{
 const f=fixture();assert.equal((await readSecurityMergeDecision(target,f.read)).decision.state,'safe');assert.equal(f.reads.length,4);
 const high=clean();high.conclusion='failure';high.output.summary=' * 1 high\n';
 assert.equal((await readSecurityMergeDecision(target,fixture({checks:[high]}).read)).decision.state,'blocked');
 high.app.id=1;assert.equal((await readSecurityMergeDecision(target,fixture({checks:[high]}).read)).decision.state,'unknown');
});
test('security metadata adapter requires complete paths including rename predecessors and stable head and base',async()=>{
 const f=fixture({files:[{filename:'docs/a.md'}]});assert.equal((await readSecurityMergeDecision(target,f.read)).decision.state,'not-applicable');
 assert.equal(f.reads.some(p=>p.includes('check-runs')),false);
 for(const files of [[],[{filename:'docs/a.md',previous_filename:'src/a.ts'}]]){
  assert.equal((await readSecurityMergeDecision(target,fixture({files,checks:[]}).read)).decision.mergeAllowed,false);
 }
 for(const field of ['head','base']){
  const f=fixture();let n=0;const read=async(p:string)=>{const x=await f.read(p);if(p.endsWith('/11468')&&++n>1)return {...x,[field]:{...x[field],sha:head===x[field].sha?other:head}};return x;};
  assert.equal((await readSecurityMergeDecision(target,read)).decision.mergeAllowed,false);
 }
});
test('security metadata adapter paginates physical corpora and refuses changing duplicate malformed and failed reads',async()=>{
 const row=pr();row.changed_files=101;const files=Array.from({length:101},(_,i)=>({filename:`src/f${i}.ts`}));const f=fixture({row});
 const read=async(p:string)=>p.includes('/files?')?p.endsWith('page=1')?files.slice(0,100):files.slice(100):f.read(p);
 assert.equal((await readSecurityMergeDecision(target,read)).decision.state,'safe');
 const checks=Array.from({length:101},(_,i)=>({...clean(),id:i+1}));
 const c=fixture();const paged=async(p:string)=>p.includes('check-runs?')?{total_count:101,check_runs:p.endsWith('page=1')?checks.slice(0,100):checks.slice(100)}:c.read(p);
 assert.equal((await readSecurityMergeDecision(target,paged)).decision.state,'safe');
 for(const read of [async()=>{throw Error('transport');},async()=>null,fixture({row:{...pr(),changed_files:3001}}).read,
 fixture({row:{...pr(),changed_files:2},files:[{filename:'src/a.ts'},{filename:'src/a.ts'}]}).read]){
  assert.equal((await readSecurityMergeDecision(target,read)).decision.mergeAllowed,false);
 }
 const drift=async(p:string)=>p.includes('check-runs?')?{total_count:p.endsWith('page=1')?101:102,check_runs:p.endsWith('page=1')?checks.slice(0,100):checks.slice(100)}:c.read(p);
 assert.equal((await readSecurityMergeDecision(target,drift)).decision.state,'unknown');
});
test('security status publication never paints another head green and UNKNOWN is a terminal actionable error',async()=>{
 const statuses:any[]=[];const f=fixture({checks:[]});
 const r=await publishSecurityMergeDecision(target,{read:f.read,status:async(s:any)=>statuses.push(s)},'https://github.com/craigoley/remudero/actions/runs/1');
 assert.equal(r.published,true);assert.equal(statuses[0].state,'error');assert.equal(statuses[0].sha,head);
 let n=0;const c=fixture();const read=async(p:string)=>{const x=await c.read(p);return p.endsWith('/11468')&&++n===3?{...x,head:{sha:other}}:x;};
 assert.equal((await publishSecurityMergeDecision(target,{read,status:async(s:any)=>statuses.push(s)})).published,false);
 assert.equal(statuses.length,1);
});
