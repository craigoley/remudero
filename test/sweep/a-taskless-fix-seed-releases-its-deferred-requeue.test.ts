import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixSeedRead,runSweep,CHECK_REQUEUE_DEFERRED_STEP,CHECK_REQUEUE_STEP,type OpenPrView} from '#src/lib/sweep.js';
import {readLedgerLines} from '#src/lib/status.js';
import {writeLedger} from '#test/helpers/ledger-fixture.js';

const HEAD='25ac6e7c377387fa00ea20af45ca89b647865e03',PR=13617,RUN='fixture-daemon';
const TASK=`PR-${PR}`,GATE='test-slow-shard (1/2)',NOW=Date.parse('2026-10-22T17:48:00Z');
const pr={prNumber:PR,headSha:HEAD};
const seed={step:'sweep.disposed',pr_number:PR,head_sha:HEAD,task_id:'SWEEP',run_id:RUN,
 disposition:'blocked-fixable',acted:true,ts:'2026-10-22T17:38:05.720Z'};
const dispatch={step:'fix.dispatch',task_id:TASK,head_sha:HEAD,run_id:RUN,mode:'ci-log'};
const done={step:'fix.done',task_id:TASK,head_sha:HEAD,run_id:RUN,subtype:'success',flake_claim:'requeue_deferred'};
const deferred={step:CHECK_REQUEUE_DEFERRED_STEP,pr_number:PR,head_sha:HEAD,check_name:GATE,
 job_id:'100',outcome:'deferred',refusal:'already_running',run_id:RUN};

test('a taskless fix seed reads only its own explicitly dispatched synthetic rung',()=>{
 assert.equal(fixSeedRead([seed,dispatch,done],pr,RUN)?.kind,'ended');
 assert.equal(fixSeedRead([seed,dispatch],pr,RUN)?.kind,'live','a live worker retains ownership');
 assert.equal(fixSeedRead([seed],pr,RUN),undefined,'no rung remains unknown');
 assert.equal(fixSeedRead([seed,{...dispatch,task_id:'PR-13618'},done],pr,RUN),undefined,'another PR never settles this seed');
 assert.equal(fixSeedRead([seed,{...dispatch,head_sha:'b'.repeat(40)},done],pr,RUN),undefined,'an older head supplies no dispatch evidence');
});

test('a taskless deferred FLAKE reaches the normal one-shot requeue after its parent settles',async t=>{
 for(const parentRunning of [true,false]){
  const fixture=writeLedger([seed,dispatch,{...deferred,step:CHECK_REQUEUE_STEP},deferred,done],{scope:t});
  let workers=0,reruns=0;
  const view:OpenPrView={...pr,prUrl:`https://github.com/craigoley/remudero/pull/${PR}`,
   headRefName:'garden/test-durations-fixture',reviewState:'success',checksState:'red',unmetCriteria:[],
   priorStrikes:0,lastActivityAt:seed.ts,autoMergeArmed:false,ciFailures:[{name:GATE,jobId:'100',logTail:'not ok - fixture'}]};
  const pass=()=>runSweep([view],{arm:()=>{},close:()=>{},escalate:()=>{throw Error('unexpected escalation');},
   dispatchFix:()=>{workers++;},requeueCheck:(_pr,check)=>{assert.equal(check.jobId,'200');reruns++;return true;},
   readCiGateRollup:()=>[
    {name:GATE,status:'COMPLETED',conclusion:'FAILURE',detailsUrl:'https://github.com/craigoley/remudero/actions/runs/900/job/200'},
    {name:'ci-gate',status:parentRunning?'IN_PROGRESS':'COMPLETED',...(parentRunning?{}:{conclusion:'FAILURE'}),
     detailsUrl:'https://github.com/craigoley/remudero/actions/runs/900/job/300'}],
   runId:RUN,now:()=>NOW,ledgerPath:fixture.path});
  await pass();
  assert.equal(workers,0,'the deferred job is handled before another fix strike');
  assert.equal(reruns,parentRunning?0:1);
  const rows=readLedgerLines(fixture.path),last=rows.filter(r=>r.step==='sweep.disposed').at(-1)!;
  assert.match(String(last.stand_down_reason),parentRunning?/run is still in flight/:/re-queued/);
  if(!parentRunning){await pass();assert.equal(reruns,1,'the accepted one-shot requeue is not repeated');}
 }
});
