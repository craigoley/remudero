import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parse} from 'yaml';
import {ghShim} from './helpers/gh-shim.js';
// @ts-expect-error — shared trusted-metadata companion is plain ESM.
import {readSecurityMergeDecision,readSecurityMergeDecisionSync,publishSecurityMergeDecision} from '../src/lib/code-scanning-merge-adapter.mjs';
// @ts-expect-error — producer is plain ESM outside tsconfig roots.
import {runSecurityMergeProducer} from '../scripts/security-merge-producer.mjs';
// @ts-expect-error — metadata companion is plain ESM outside tsconfig roots.
import {semgrepRuntimeMetadataRequests} from '../src/lib/semgrep-runtime-merge-policy.mjs';
// @ts-expect-error — shared read-only CLI argument mapping is plain ESM.
import {securityMetadataGhArgs} from '../src/lib/security-metadata-gh-args.mjs';

const head='a'.repeat(40),base='b'.repeat(40),blob='c'.repeat(40),foreign='d'.repeat(40);
const workflow='.github/workflows/semgrep-runtime-compatibility.yml',context='semgrep-runtime-compatibility';
const prefix='repos/craigoley/remudero',prPath=prefix+'/pulls/11468';
const target={owner:'craigoley',repo:'remudero',prNumber:11468,expectedHead:head};
function fixture(){
 const pr:any={state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:{full_name:'craigoley/remudero'}},changed_files:1};
 const files:any[]=[{filename:'.github/semgrep/requirements.txt'}];
 const security:any={id:11,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
  app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
  output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}};
 const runtime:any={id:22,name:context,head_sha:head,status:'completed',conclusion:'success',
  app:{id:15368,slug:'github-actions',owner:{login:'github'}},check_suite:{id:33},
  details_url:'https://github.com/craigoley/remudero/actions/runs/44/job/55'};
 const checks:any[]=[security,runtime];
 const run:any={id:44,node_id:'WFR_runtime_fixture_44',repository:{full_name:'craigoley/remudero'},event:'pull_request',head_sha:head,
  path:workflow,workflow_id:66,run_attempt:1,check_suite_id:33,status:'completed',conclusion:'success',
  pull_requests:[{number:11468,head:{sha:head},base:{sha:base,repo:{url:'https://api.github.com/repos/craigoley/remudero'}}}]};
 const job:any={id:55,run_id:44,run_attempt:1,head_sha:head,name:context,
  check_run_url:'https://api.github.com/'+prefix+'/check-runs/22',status:'completed',conclusion:'success',
  steps:['Detect runtime lock changes','Set up pinned Python','Verify hash-locked install and dependency closure']
   .map((name,i)=>({name,number:i+1,status:'completed',conclusion:'success'}))};
 const trusted:any={type:'file',path:workflow,sha:blob,size:4096},proposed:any={...trusted};
 const executed:any={data:{node:{__typename:'WorkflowRun',url:'https://github.com/craigoley/remudero/actions/runs/44',runAttempt:1,file:{path:workflow,
  repositoryName:'craigoley/remudero',repositoryFileUrl:'https://github.com/craigoley/remudero/blob/'+foreign+'/'+workflow,
  run:{url:'https://github.com/craigoley/remudero/actions/runs/44',runAttempt:1}}}}};
 const reads:string[]=[];
 const read=(path:string):any=>{
  reads.push(path);
  if(path===prPath)return structuredClone(pr);
  if(path===prPath+'/files?per_page=100&page=1')return files;
  if(path===prefix+'/commits/'+head+'/check-runs?filter=all&per_page=100&page=1')return {total_count:checks.length,check_runs:checks};
  if(path===prefix+'/actions/runs/44')return run;
  if(path===prefix+'/actions/jobs/55')return job;
  if(path==='security-workflow-source:'+run.node_id)return executed;
  if(path===prefix+'/contents/'+workflow+'?ref='+base)return trusted;
  if(path===prefix+'/contents/'+workflow+'?ref='+head)return proposed;
  if(path===prefix+'/contents/'+workflow+'?ref='+foreign)return trusted;
  throw Error('unexpected metadata read: '+path);
 };
 return {pr,files,security,runtime,checks,run,job,trusted,proposed,executed,reads,read};
}

test('runtime metadata helper has an explicit unchanged-lock fast path and refuses incomplete identity',()=>{
 assert.deepEqual(semgrepRuntimeMetadataRequests({files:[{filename:'docs/a.md'}]}).next(),
  {value:{state:'not-applicable',mergeAllowed:true,reason:'semgrep-runtime-lock-unchanged'},done:true});
 for(const input of [{headSha:foreign,baseSha:base,prNumber:0,checksComplete:true,checks:[]},
  {headSha:'invalid',baseSha:base,prNumber:11468,checksComplete:true,checks:[]},
  {headSha:head,baseSha:base,prNumber:11468,checksComplete:false,checks:[]},
  {headSha:head,baseSha:base,prNumber:11468,checksComplete:true,checks:null}]){
  const row=semgrepRuntimeMetadataRequests({...input,files:[{filename:'.github/semgrep/requirements.txt'}]}).next();
  assert.equal(row.done,true);assert.equal(row.value.mergeAllowed,false);
 }
});

test('workflow-source metadata mapping can issue only its fixed read-only query and preserves ordinary REST reads',()=>{
 assert.deepEqual(securityMetadataGhArgs('repos/craigoley/remudero/pulls/11468'),['api','repos/craigoley/remudero/pulls/11468']);
 const args=securityMetadataGhArgs('security-workflow-source:WFR_fixture_123');
 assert.deepEqual(args.slice(0,3),['api','graphql','-f']);assert.ok(args[3].startsWith('query=query{node(id:"WFR_fixture_123")'));
 assert.equal(args[3].includes('mutation'),false);assert.equal(args[3].includes('databaseId'),false);
 assert.ok(args[3].includes('repositoryFileUrl'));
 for(const input of [null,'security-workflow-source','security-workflow-source:short','security-workflow-source:WFR_12345\n',
  'security-workflow-source:WFR_bad"}mutation{x}','security-workflow-source:'+('x'.repeat(201))]){
  assert.throws(()=>securityMetadataGhArgs(input));
 }
});

test('runtime lock changes require trusted workflow bytes and exact-head run/job closure in both merge effectors',async()=>{
 const f=fixture(),sync=readSecurityMergeDecisionSync(target,f.read),asyncResult=await readSecurityMergeDecision(target,async p=>f.read(p));
 assert.deepEqual(sync,asyncResult);
 assert.deepEqual(sync.decision,{state:'safe',mergeAllowed:true,reason:'trusted-exact-head-security-and-runtime-compatible'});
 assert.equal(f.reads.filter(p=>p.includes('/actions/runs/')).length,2);
 assert.equal(f.reads.filter(p=>p.includes('/contents/')).length,6);
 for(const filename of ['.github/semgrep/requirements.txt','.github/semgrep/build-requirements.txt']){
  const renamed=fixture();renamed.files[0]={filename:'docs/retired.txt',previous_filename:filename};renamed.checks.pop();
  assert.equal(readSecurityMergeDecisionSync(target,renamed.read).decision.mergeAllowed,false);
 }
});

test('unchanged runtime locks preserve existing CodeQL and advisory findings policy without extra Actions reads',()=>{
 for(const filename of ['src/product.ts','docs/runtime.md','.github/workflows/semgrep.yml']){
  const f=fixture();f.files[0]={filename};f.checks.pop();
  const result=readSecurityMergeDecisionSync(target,f.read);
  assert.equal(result.decision.mergeAllowed,true);
  assert.equal(f.reads.some(p=>p.includes('/actions/')||p.includes('/contents/')),false);
 }
 const f=fixture();f.checks.pop();f.files[0]={filename:'docs/runtime.md',previous_filename:'src/old.ts'};
 assert.equal(readSecurityMergeDecisionSync(target,f.read).decision.state,'safe');
});

const mutations:[string,(f:ReturnType<typeof fixture>)=>void][]=[
 ['missing check',f=>{f.checks.pop();}],['old-head success',f=>{f.runtime.head_sha=foreign;}],
 ['wrong app ID',f=>{f.runtime.app.id=1;}],['wrong app slug',f=>{f.runtime.app.slug='attacker';}],
 ['wrong app owner',f=>{f.runtime.app.owner.login='attacker';}],['pending',f=>{f.runtime.status='in_progress';}],
 ['invalid generation',f=>{f.runtime.id=0;}],['duplicate generation',f=>{f.checks.push({...f.runtime});}],
 ['newer pending generation',f=>{f.checks.push({...f.runtime,id:23,status:'queued'});}],
 ['foreign run link',f=>{f.runtime.details_url='https://github.com/attacker/repo/actions/runs/44/job/55';}],
 ['missing suite',f=>{delete f.runtime.check_suite;}],['unsafe numeric run',f=>{f.runtime.details_url='https://github.com/craigoley/remudero/actions/runs/99999999999999999/job/55';}],
 ['wrong run ID',f=>{f.run.id=45;}],['foreign run repo',f=>{f.run.repository.full_name='attacker/repo';}],
 ['privileged trigger',f=>{f.run.event='pull_request_target';}],['wrong run head',f=>{f.run.head_sha=foreign;}],
 ['same-name other workflow',f=>{f.run.path='.github/workflows/spoof.yml';}],['invalid workflow ID',f=>{f.run.workflow_id=0;}],
 ['missing run attempt',f=>{delete f.run.run_attempt;}],['wrong suite',f=>{f.run.check_suite_id=34;}],
 ['wrong job ID',f=>{f.job.id=56;}],['wrong job run',f=>{f.job.run_id=45;}],
 ['old job attempt',f=>{f.job.run_attempt=2;}],['wrong job head',f=>{f.job.head_sha=foreign;}],
 ['wrong job name',f=>{f.job.name='Scan';}],['wrong check link',f=>{f.job.check_run_url='https://api.github.com/'+prefix+'/check-runs/23';}],
 ['unfinished job',f=>{f.job.status='in_progress';}],['job conclusion mismatch',f=>{f.job.conclusion='failure';}],
 ['changed workflow bytes',f=>{f.proposed.sha=foreign;}],['changed workflow size',f=>{f.proposed.size++;}],
 ['workflow symlink',f=>{f.proposed.type='symlink';}],['missing trusted workflow',f=>{f.trusted.sha='';}],
 ['wrong content path',f=>{f.trusted.path='other.yml';}],['oversized workflow',f=>{f.trusted.size=f.proposed.size=65537;}],
 ['empty workflow',f=>{f.trusted.size=f.proposed.size=0;}],['unclosed run',f=>{f.run.status='in_progress';}],
 ['run conclusion mismatch',f=>{f.run.conclusion='failure';}],['skipped check',f=>{f.runtime.conclusion=f.job.conclusion=f.run.conclusion='skipped';}],
 ['missing base identity',f=>{delete f.pr.base.sha;}],
 ['other PR',f=>{f.run.pull_requests[0].number++;}],
 ['old associated head',f=>{f.run.pull_requests[0].head.sha=foreign;}],['missing PR association',f=>{f.run.pull_requests=[];}],
 ['ambiguous PR association',f=>{f.run.pull_requests.push(f.run.pull_requests[0]);}],
 ['foreign associated base',f=>{f.run.pull_requests[0].base.repo.url='https://api.github.com/repos/attacker/repo';}],
 ['missing steps',f=>{delete f.job.steps;}],['installation skipped',f=>{f.job.steps[2].conclusion='skipped';}],
 ['duplicate installation step',f=>{f.job.steps.push({...f.job.steps[2]});}],
 ['unfinished installation step',f=>{f.job.steps[2].status='in_progress';}],['invalid step number',f=>{f.job.steps[2].number=0;}],
 ['generation bound',f=>{for(let i=0;i<8;i++)f.checks.push({...f.runtime,id:30+i});}],
 ['missing workflow node',f=>{delete f.run.node_id;}],['malformed workflow node',f=>{f.run.node_id='bad" query';}],
 ['GraphQL errors',f=>{(f.executed as any).errors=[{message:'unavailable'}];}],
 ['wrong source run',f=>{f.executed.data.node.url='https://github.com/craigoley/remudero/actions/runs/45';}],['wrong source attempt',f=>{f.executed.data.node.runAttempt=2;}],
 ['wrong source type',f=>{f.executed.data.node.__typename='Commit';}],['wrong source path',f=>{f.executed.data.node.file.path='other.yml';}],
 ['wrong source repo',f=>{f.executed.data.node.file.repositoryName='attacker/repo';}],
 ['mutable source URL',f=>{f.executed.data.node.file.repositoryFileUrl='https://github.com/craigoley/remudero/blob/main/'+workflow;}],
 ['wrong source parent run',f=>{f.executed.data.node.file.run.url='https://github.com/craigoley/remudero/actions/runs/45';}],
 ['wrong source parent attempt',f=>{f.executed.data.node.file.run.runAttempt=2;}],
];
for(const [label,mutate] of mutations)test('runtime compatibility refuses '+label,()=>{
 const f=fixture();mutate(f);const result=readSecurityMergeDecisionSync(target,f.read);
 assert.equal(result.decision.state,'unknown');assert.equal(result.decision.mergeAllowed,false);
});

test('a genuine incompatible runtime is blocked but compatibility does not waive security alerts',()=>{
 const f=fixture();f.runtime.conclusion=f.run.conclusion=f.job.conclusion='failure';
 assert.deepEqual(readSecurityMergeDecisionSync(target,f.read).decision,
  {state:'blocked',mergeAllowed:false,reason:'semgrep-runtime-incompatible-or-install-failed'});
 const high=fixture();high.security.output.summary=' * 1 high\n';high.security.conclusion='failure';
 assert.equal(readSecurityMergeDecisionSync(target,high.read).decision.reason,'new-high-or-critical-security-alert');
 assert.equal(high.reads.some(p=>p.includes('/actions/')),false);
});

test('unavailable compatibility metadata or head drift cannot publish a reusable green decision',async()=>{
 const f=fixture(),writes:any[]=[];
 const unavailable=await publishSecurityMergeDecision(target,{read:async(p:string)=>{
  if(p.includes('/actions/jobs/'))throw Error('unavailable');return f.read(p);
 },status:async(s:any)=>writes.push(s)});
 assert.equal(unavailable.decision.mergeAllowed,false);assert.equal(writes[0].state,'error');assert.equal(writes[0].sha,head);
 let n=0;const drift=fixture();
 const changed=await publishSecurityMergeDecision(target,{read:async(p:string)=>{
  const value=drift.read(p);if(p===prPath&&++n===3)value.head.sha=foreign;return value;
 },status:async(s:any)=>writes.push(s)});
 assert.equal(changed.published,false);assert.equal(writes.length,1);
 let baseReads=0;const baseDrift=fixture();
 const movedBase=await publishSecurityMergeDecision(target,{read:async(p:string)=>{
  const value=baseDrift.read(p);if(p===prPath&&++baseReads===3)value.base.sha=foreign;return value;
 },status:async(s:any)=>writes.push(s)});
 assert.equal(movedBase.published,false);assert.equal(writes.length,1);
});

test('a verified other-workflow name collision cannot mask the newest genuine runtime generation',()=>{
 const f=fixture(),collision={...f.runtime,id:23,details_url:'https://github.com/craigoley/remudero/actions/runs/77/job/88',check_suite:{id:99}};
 f.checks.push(collision);
 const read=(p:string)=>p===prefix+'/actions/runs/77'?{...f.run,id:77,check_suite_id:99,path:'.github/workflows/other.yml'}:f.read(p);
 assert.equal(readSecurityMergeDecisionSync(target,read).decision.mergeAllowed,true);
 f.runtime.status='in_progress';
 assert.equal(readSecurityMergeDecisionSync(target,read).decision.reason,'semgrep-runtime-compatibility-pending');
});

test('a changed association base cannot substitute for immutable executed workflow bytes or force an unnecessary head refresh',()=>{
 const f=fixture();f.run.pull_requests[0].base.sha=foreign;
 assert.equal(readSecurityMergeDecisionSync(target,f.read).decision.mergeAllowed,true);
 const actual={...f.trusted,sha:head};
 const read=(p:string)=>p===prefix+'/contents/'+workflow+'?ref='+foreign?actual:f.read(p);
 assert.equal(readSecurityMergeDecisionSync(target,read).decision.mergeAllowed,false);
});

test('runtime completion wakes the trusted policy producer using metadata only',async()=>{
 const f=fixture(),writes:any[]=[];
 const results=await runSecurityMergeProducer('workflow_run',{repository:{full_name:'craigoley/remudero'},
  workflow_run:{name:'Semgrep runtime compatibility',head_sha:head}},
 {read:async(p:string)=>p===prefix+'/commits/'+head+'/pulls?per_page=100'?[{number:11468,state:'open',head:{sha:head}}]:f.read(p),
  status:async(s:any)=>writes.push(s)});
 assert.equal(results[0].published,true);assert.equal(writes[0].state,'success');assert.equal(writes[0].sha,head);
});

test('runtime compatibility uses the real producer CLI and preserves genuine installation failure as a denied status',t=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'rmd-runtime-policy-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const eventPath=join(dir,'event.json');
 writeFileSync(eventPath,JSON.stringify({repository:{full_name:'craigoley/remudero'},pull_request:{number:11468,head:{sha:head}}}));
 const shim=ghShim([{when:'POST',stdout:'{}'},{when:'/files?',stdout:JSON.stringify(f.files)},
  {when:'/check-runs?',stdout:JSON.stringify({total_count:2,check_runs:f.checks})},
  {when:'/actions/runs/44',stdout:JSON.stringify(f.run)},{when:'/actions/jobs/55',stdout:JSON.stringify(f.job)},
  {when:'graphql',stdout:JSON.stringify(f.executed)},{when:'/contents/',stdout:JSON.stringify(f.trusted)},{when:'GET',stdout:JSON.stringify(f.pr)}]);
 t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
 const run=()=>spawnSync(process.execPath,[new URL('../scripts/security-merge-producer.mjs',import.meta.url).pathname],
  {env:{...process.env,PATH:shim.dir+':'+process.env.PATH,GH_TOKEN:'',GITHUB_EVENT_PATH:eventPath,
   GITHUB_EVENT_NAME:'pull_request_target',GITHUB_RUN_ID:'99'},encoding:'utf8',timeout:10000});
 const good=run();assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).results[0].decision.mergeAllowed,true);
 assert.ok(shim.calls().some(call=>call.includes('/actions/jobs/55')));
 for(const item of [f.runtime,f.run,f.job])item.conclusion='failure';
 shim.addRoute({when:'/check-runs?',stdout:JSON.stringify({total_count:2,check_runs:f.checks})});
 shim.addRoute({when:'/actions/runs/44',stdout:JSON.stringify(f.run)});shim.addRoute({when:'/actions/jobs/55',stdout:JSON.stringify(f.job)});
 const from=shim.calls().length,bad=run();assert.equal(bad.status,0,bad.stderr);
 assert.equal(JSON.parse(bad.stdout).results[0].decision.state,'blocked');
 const writes=shim.calls().slice(from).filter(call=>call.includes('/statuses/'+head));
 assert.equal(writes.length,1);assert.ok(writes[0].includes('state=failure'));
});

test('runtime workflow is unprivileged exact-head closure-only and never makes scan findings required',()=>{
 const text=readFileSync(new URL('../.github/workflows/semgrep-runtime-compatibility.yml',import.meta.url),'utf8'),flow=parse(text);
 assert.deepEqual(Object.keys(flow.on),['pull_request']);assert.equal(flow.on.pull_request['paths-ignore'],undefined);
 assert.deepEqual(flow.permissions,{contents:'read'});
 const job=flow.jobs['runtime-compatibility'];assert.equal(job.name,context);assert.equal(job['timeout-minutes'],10);
 assert.equal(job['runs-on'],'ubuntu-24.04');assert.equal(job.permissions,undefined);
 assert.equal(job.steps[0].with.ref,'${{ github.event.pull_request.head.sha }}');assert.equal(job.steps[0].with['persist-credentials'],false);
 const install=job.steps.find((s:any)=>s.name==='Verify hash-locked install and dependency closure');
 assert.equal(install['continue-on-error'],undefined);assert.ok(install.run.includes('"$VENV/bin/python" -I -m pip check'));
 assert.ok(install.run.includes('"$VENV/bin/semgrep" --version'));assert.ok(install.run.includes('SemgrepCore.executable_path()'));
 assert.ok(install.run.includes('--require-hashes'));assert.ok(install.run.includes('--no-index'));
 assert.equal(text.includes('security-events: write'),false);assert.equal(text.includes('secrets.'),false);
 assert.equal(text.includes('scripts/'),false);assert.equal(text.includes('semgrep scan'),false);
 for(const step of job.steps.filter((s:any)=>s.run)){
  const result=spawnSync('bash',['-n'],{input:step.run,encoding:'utf8',timeout:1000});assert.equal(result.status,0,result.stderr);
 }
 const producer=parse(readFileSync(new URL('../.github/workflows/security-merge-policy.yml',import.meta.url),'utf8'));
 assert.ok(producer.on.workflow_run.workflows.includes('Semgrep runtime compatibility'));
 assert.equal(producer.jobs.metadata.permissions.actions,'read');assert.equal(producer.jobs.metadata.steps[0].with.ref,'main');
});

test('real isolated Python stages only committed closed locks and rejects PR module shadowing and expanded inputs',t=>{
 const flow=parse(readFileSync(new URL('../.github/workflows/semgrep-runtime-compatibility.yml',import.meta.url),'utf8'));
 const install=flow.jobs['runtime-compatibility'].steps.find((s:any)=>s.name==='Verify hash-locked install and dependency closure');
 const match=/<<'PY'\n([\s\S]*?)\nPY\n/.exec(install.run);assert.ok(match);
 const script=match[1],dir=mkdtempSync(join(tmpdir(),'rmd-runtime-inputs-')),repo=join(dir,'repo');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(repo);mkdirSync(join(repo,'.github','semgrep'),{recursive:true});
 const invoke=(file:string,args:string[],input?:string)=>spawnSync(file,args,{cwd:repo,encoding:'utf8',input,timeout:10000,
  env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
 const git=(args:string[])=>{const r=invoke('git',args);assert.equal(r.status,0,r.stderr);};
 git(['init','--quiet']);
 for(const name of ['build-requirements.txt','requirements.txt'])writeFileSync(join(repo,'.github','semgrep',name),
  readFileSync(new URL('../.github/semgrep/'+name,import.meta.url)));
 const marker=join(repo,'shadow-ran');writeFileSync(join(repo,'pathlib.py'),'open("shadow-ran", "w").write("not isolated")\nraise RuntimeError("PR module executed")\n');
 const commit=()=>{git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','--allow-empty','-m','fixture']);};
 commit();
 const stage=(isolated:boolean)=>{const out=mkdtempSync(join(dir,'out-'));
  const r=invoke('python3',[...(isolated?['-I']:[]),'-',out,repo],script);return {...r,out};};
 const negative=stage(false);assert.notEqual(negative.status,0);assert.match(negative.stderr,/PR module executed/);
 assert.equal(readFileSync(marker,'utf8'),'not isolated');unlinkSync(marker);
 const positive=stage(true);assert.equal(positive.status,0,positive.stderr);
 for(const name of ['build-requirements.txt','requirements.txt'])assert.deepEqual(readFileSync(join(positive.out,name)),readFileSync(join(repo,'.github','semgrep',name)));
 assert.throws(()=>readFileSync(marker),/ENOENT/);
 const lock=join(repo,'.github','semgrep','requirements.txt'),original=readFileSync(lock,'utf8');
 for(const invalid of [original+'-r extra.txt\n',original+'--index-url https://example.invalid\n',original.replace('semgrep==1.180.0','semgrep==1.181.0')]){
  writeFileSync(lock,invalid);commit();const r=stage(true);assert.notEqual(r.status,0);assert.match(r.stderr,/AssertionError/);
 }
 writeFileSync(join(repo,'outside.txt'),original);unlinkSync(lock);symlinkSync('../../outside.txt',lock);commit();
 const linked=stage(true);assert.notEqual(linked.status,0);assert.match(linked.stderr,/committed regular file/);
});
