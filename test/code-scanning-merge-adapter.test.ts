import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — trusted metadata script is plain ESM, outside tsconfig source roots.
import {readSecurityMergeDecision, publishSecurityMergeDecision} from '#src/lib/code-scanning-merge-adapter.mjs';
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


test('security decision receipts bind the exact native generation and summary without changing permission',async()=>{
 const first=clean(),latest={...clean(),id:2,conclusion:'neutral',output:{title:'1 configuration not found',summary:'unrecognized comparison state'}};
 const spoof={...clean(),id:3,app:{...clean().app,id:1}};
 const f=fixture({checks:[first,latest,spoof]});
 const result=await readSecurityMergeDecision(target,f.read);
 assert.equal(result.decision.state,'unknown');assert.equal(result.decision.mergeAllowed,false);
 assert.equal(result.observation.checksComplete,true);assert.equal(result.observation.checkCount,3);
 assert.equal(result.observation.trustedCodeqlCount,2);assert.equal(result.observation.latest.id,2);
 assert.equal(result.observation.latest.conclusion,'neutral');assert.equal(result.observation.latest.title,'1 configuration not found');
 assert.equal(result.observation.latest.summarySha256,'b9a1072a9117a12327e25988081e5b13dd04fc9cee4c9a4a7433f569afa869fc');
 assert.equal(JSON.stringify(result.observation).includes('unrecognized comparison state'),false);
 const changed=await readSecurityMergeDecision(target,fixture({checks:[{...latest,output:{...latest.output,summary:'new comparison state'}}]}).read);
 assert.notEqual(changed.observation.latest.summarySha256,result.observation.latest.summarySha256);
 assert.equal(changed.decision.mergeAllowed,false);
 const missing=await readSecurityMergeDecision(target,fixture({checks:[{...latest,output:{title:latest.output.title}}]}).read);
 assert.equal(missing.observation.latest.summarySha256,null);assert.equal(missing.decision.mergeAllowed,false);
 for(const checks of [[first,first],[{...first,id:NaN}]]){
  const refused=await readSecurityMergeDecision(target,fixture({checks}).read);
  assert.equal(refused.observation.latest,undefined);assert.equal(refused.decision.mergeAllowed,false);
 }
 const absent=await readSecurityMergeDecision(target,fixture({checks:[]}).read);
 assert.equal(absent.observation.trustedCodeqlCount,0);assert.equal(absent.observation.latest,undefined);
 const safe=await readSecurityMergeDecision(target,fixture().read);
 assert.equal(safe.observation.latest.id,1);assert.equal(safe.observation.latest.status,'completed');
 assert.equal(safe.observation.latest.startedAt,null);assert.equal(safe.observation.latest.completedAt,null);
 assert.equal(safe.decision.mergeAllowed,true);
});

// ---- W1-T10976: missing-configuration recovery evidence ----
// @ts-expect-error — trusted policy module is plain ESM outside tsconfig roots.
import {missingConfigurationSummary} from '#src/lib/code-scanning-merge-policy.mjs';
const merge='c'.repeat(40),KEY='.github/workflows/codeql.yml:analyze';
const CATS=['/language:javascript-typescript','/language:actions','/language:python'];
const an=(category:string,id:number,extra:any={})=>({id,ref:'refs/pull/11468/merge',commit_sha:merge,analysis_key:KEY,category,error:'',warning:'',
 results_count:0,created_at:`2026-11-09T03:${String(10+id%40).padStart(2,'0')}:00Z`,tool:{name:'CodeQL'},...extra});
const three=()=>CATS.map((c,i)=>an(c,i+1));
const missing=()=>({...clean(),id:2,conclusion:'neutral',output:{title:'1 configuration not found',summary:missingConfigurationSummary(11468,'/language:python')}});
const instance=(extra:any={})=>({ref:'refs/pull/11468/merge',commit_sha:merge,analysis_key:KEY,category:'/language:python',...extra});
const high=(number:number,extra:any={})=>({number,tool:{name:'CodeQL'},rule:{security_severity_level:'high',severity:'error'},most_recent_instance:instance(),...extra});
function recoveryFixture(o:{analyses?:any[]|((page:number)=>any);alerts?:any[];baseAlerts?:any[];row?:any;ref?:any;commit?:any}={}){
 const reads:string[]=[];
 const read=async(path:string)=>{
  reads.push(path);
  if(path.includes('/files?'))return [{filename:'src/a.ts'}];
  if(path.includes('/check-runs?'))return {total_count:1,check_runs:[missing()]};
  if(path.includes('/git/ref/pull/'))return o.ref??{object:{sha:merge}};
  if(path.endsWith('/commits/'+merge))return o.commit??{sha:merge,parents:[{sha:other},{sha:head}]};
  if(path.includes('/code-scanning/analyses?')){const page=Number(/&page=(\d+)/.exec(path)![1]);
   return typeof o.analyses==='function'?o.analyses(page):page===1?o.analyses??three():[];}
  if(path.includes('/code-scanning/alerts?'))return path.includes('refs/heads/main')?o.baseAlerts??[]:o.alerts??[];
  return {...pr(),merge_commit_sha:merge,...o.row};
 };
 return {reads,read};
}
const decide=async(o:Parameters<typeof recoveryFixture>[0]={})=>readSecurityMergeDecision(target,recoveryFixture(o).read);

test('complete paginated same-merge analyses with a below-threshold alert corpus reconcile the missing configuration',async()=>{
 const f=recoveryFixture({analyses:page=>page===1?[...Array.from({length:97},(_,i)=>an(CATS[0],1000+i,{tool:{name:'Semgrep'}})),...three().slice(0,3)]
  :page===2?[an(CATS[1],2000,{commit_sha:other})]:[]});
 const r=await readSecurityMergeDecision(target,f.read);
 assert.equal(r.decision.state,'safe');assert.equal(r.decision.reason,'trusted-missing-configuration-reconciled-by-complete-analyses');
 assert.equal(r.mergeSha,merge);assert.equal(r.observation.recovery.state,'complete');
 assert.deepEqual(r.observation.recovery.analysisIds,{'/language:javascript-typescript':1,'/language:actions':2,'/language:python':3});
 assert.ok(f.reads.some(p=>p.includes('/analyses?')&&p.endsWith('page=2')),'pagination continues beyond page one');
 assert.equal(f.reads.some(p=>p.includes('tool_name')),false);
 const low={number:3,tool:{name:'CodeQL'},rule:{security_severity_level:'medium',severity:'warning'},most_recent_instance:instance()};
 const quality={number:4,tool:{name:'CodeQL'},rule:{security_severity_level:null,severity:'note'}};
 assert.equal((await decide({alerts:[low,quality]})).decision.state,'safe');
});
test('missing categories stay pending and every identity, completeness or shape defect stays UNKNOWN',async()=>{
 const pending=await decide({analyses:three().slice(0,2)});
 assert.equal(pending.decision.reason,'codeql-configuration-recovery-pending');assert.deepEqual(pending.observation.recovery.missing,['/language:python']);
 const older=an(CATS[2],3,{created_at:'2026-11-09T03:00:00Z'}),newer=an(CATS[2],4,{created_at:'2026-11-09T04:00:00Z'});
 const cases:Array<[string,any]>=[
  ['newer failed row masks an older clean row',[...three().slice(0,2),older,{...newer,error:'boom'}]],
  ['warning-bearing analysis',[...three().slice(0,2),{...an(CATS[2],3),warning:'ignored files'}]],
  ['duplicate id',[...three(),an(CATS[0],1,{created_at:'2026-11-10T00:00:00Z'})]],
  ['ambiguous generation',[...three(),an(CATS[2],9,{created_at:an(CATS[2],3).created_at})]],
  ['missing tool object',[...three(),{...an(CATS[0],8),tool:undefined}]],
  ['non-integer results_count',[...three().slice(0,2),{...an(CATS[2],3),results_count:'0'}]],
  ['bad timestamp',[...three().slice(0,2),{...an(CATS[2],3),created_at:'later'}]],
  ['not an array',{rows:three()}]];
 for(const [label,analyses] of cases){
  const r=await decide({analyses});
  assert.equal(r.decision.mergeAllowed,false,label);
  assert.equal(r.decision.reason,'codeql-configuration-recovery-invalid-evidence',label);
 }
 const foreign=await decide({analyses:[an(CATS[0],1,{tool:{name:'Semgrep'}}),an(CATS[1],2,{commit_sha:other}),an(CATS[2],3,{analysis_key:'other:key'}),
  an(CATS[2],4,{ref:'refs/heads/main'})]});
 assert.equal(foreign.decision.reason,'codeql-configuration-recovery-pending','foreign rows cannot fill a category');
 assert.equal(foreign.observation.recovery.missing.length,3);
});
test('a full final analyses page needs a next page and the page ceiling is incomplete',async()=>{
 const full=(page:number)=>Array.from({length:100},(_,i)=>an(CATS[0],(page+1)*1000+i,{tool:{name:'Semgrep'}}));
 const ended=await decide({analyses:page=>page===1?[...full(0).slice(0,97),...three()]:[]});
 assert.equal(ended.decision.state,'safe');
 const ceiling=await decide({analyses:page=>full(page)});
 assert.equal(ceiling.decision.reason,'codeql-configuration-recovery-invalid-evidence');assert.equal(ceiling.observation.recovery.cause,'analysis-corpus-incomplete');
 const lastFullThenEmpty=await decide({analyses:page=>page===1?[...full(0).slice(0,97),...three()].slice(0,100):page===2?[]:[]});
 assert.equal(lastFullThenEmpty.decision.state,'safe');
});
test('merge-ref and parent identity, alert shape and instance identity are required and a new high alert blocks',async()=>{
 const bad:Array<[string,Parameters<typeof recoveryFixture>[0],string]>=[
  ['merge ref points elsewhere',{ref:{object:{sha:other}}},'merge-ref-identity-mismatch'],
  ['parents do not match head and base',{commit:{sha:merge,parents:[{sha:other},{sha:other}]}},'merge-parents-mismatch'],
  ['no merge sha',{row:{merge_commit_sha:null}},'merge-sha-unavailable'],
  ['alert page malformed',{alerts:{}as any},'alert-corpus-incomplete'],
  ['alert tool malformed',{alerts:[{number:1}]},'alert-tool-malformed'],
  ['alert severity unreadable',{alerts:[{number:1,tool:{name:'CodeQL'},rule:{security_severity_level:'urgent'}}]},'alert-severity-unreadable'],
  ['alert with unreadable quality severity',{alerts:[{number:1,tool:{name:'CodeQL'},rule:{}}]},'alert-severity-unreadable'],
  ['alert instance from another commit',{alerts:[high(5,{most_recent_instance:instance({commit_sha:other})})]},'alert-instance-identity-mismatch'],
  ['alert instance foreign category',{alerts:[high(5,{most_recent_instance:instance({category:'/language:ruby'})})]},'alert-instance-identity-mismatch'],
  ['duplicate alert number',{alerts:[high(5),high(5)]},'alert-identity-malformed']];
 for(const [label,o,cause] of bad){
  const r=await decide(o);assert.equal(r.decision.mergeAllowed,false,label);assert.equal(r.observation?.recovery?.cause,cause,label);
 }
 const blocked=await decide({alerts:[high(5),high(6,{rule:{security_severity_level:'critical'}})],baseAlerts:[{number:6}]});
 assert.equal(blocked.decision.state,'blocked');assert.deepEqual(blocked.observation.recovery.newHighCritical,[5]);
 const foreignAlert=await decide({alerts:[high(5,{tool:{name:'Semgrep'}})]});
 assert.equal(foreignAlert.decision.state,'safe','a foreign-tool alert is not CodeQL evidence');
});
test('merge sha drift during observation or before publication refuses a stale success',async()=>{
 let n=0;const f=recoveryFixture();
 const drift=async(p:string)=>{const x=await f.read(p);return p.endsWith('/11468')&&++n>1?{...x,merge_commit_sha:'d'.repeat(40)}:x;};
 const r=await readSecurityMergeDecision(target,drift);
 assert.equal(r.decision.reason,'head-or-base-changed-during-observation');
 const statuses:any[]=[];let m=0;
 const late=async(p:string)=>{const x=await f.read(p);return p.endsWith('/11468')&&++m>=3?{...x,merge_commit_sha:'d'.repeat(40)}:x;};
 const pub=await publishSecurityMergeDecision(target,{read:late,status:async(s:any)=>statuses.push(s)});
 assert.equal(pub.published,false);assert.equal(statuses.length,0);
 assert.equal(pub.decision.reason,'head-or-base-changed-before-publication');
 const ok=await publishSecurityMergeDecision(target,{read:f.read,status:async(s:any)=>statuses.push(s)});
 assert.equal(ok.published,true);assert.equal(statuses[0].state,'success');
 const exhausted=await publishSecurityMergeDecision(target,{read:recoveryFixture({analyses:three().slice(0,1)}).read,status:async(s:any)=>statuses.push(s)},undefined,{exhausted:true});
 assert.equal(statuses.at(-1).state,'error');assert.match(statuses.at(-1).description,/codeql-configuration-recovery-exhausted/);assert.equal(exhausted.published,true);
});
