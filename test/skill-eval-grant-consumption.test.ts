import { repoRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeReservedEvalGrant, RESERVED_EVAL_GRANT_TABLE_SQL } from "#src/lib/skill-eval-grant-consumption.js";
import type { ReservedEvalQualificationInput } from "#src/lib/skill-eval-reservation.js";
// @ts-expect-error — plain service-plan ESM is outside tsconfig source roots.
import {ownedRunServicePlan} from "#scripts/lib/owned-run-service-plan.mjs";
function fixture(): ReservedEvalQualificationInput {
 const nowMs=100001000,readyAtMs=100000000,finishByMs=readyAtMs+10800000;
 const binding={proposalId:'draft',draftSha256:'a'.repeat(64),heldOutSetHash:'b'.repeat(64),stackHash:'stack',sourceHead:'c'.repeat(40),
  nodeVersion:'v24.21.0',lockSha256:'d'.repeat(64),host:'native-host',commandSha256:'e'.repeat(64)};
 return {mode:'reservation-backed',nowMs,binding,ready:{requestId:'f'.repeat(64),readyAtMs,expiresAtMs:readyAtMs+3600000},
  grant:{id:'grant',requestId:'f'.repeat(64),binding,readyAtMs,approvedAtMs:readyAtMs+500,admitByMs:readyAtMs+900000,
   finishByMs,minWorkers:3,maxCostUsd:180,perAttemptBudgetUsd:15,state:'fresh'},
  calibration:{binding,receiptSha256:'1'.repeat(64),observedAtMs:nowMs,workers:3,fullRunUpperBoundMs:4800000,
   shutdownReserveMs:30000,perWorkerPeakBytes:1024,peakDiskBytes:1024,attempts:12,perAttemptBudgetUsd:15,state:'closed-native'},
  capacity:{observedAtMs:nowMs,host:binding.host,cpuFreeWorkers:3,memoryFreeBytes:4096,diskFreeBytes:4096,
   lease:{id:'own-lease',owned:true,workers:3,heldThroughMs:finishByMs}},
  safeguards:{holdScope:'NEW-implement-only',reservationConsumerVerified:true,independentReadyDeadlineVerified:true,
   durableEscalationAckVerified:true,wholeRunTerminationVerified:true,atomicGrantConsumptionVerified:true,ownLeaseReleaseVerified:true}};
}
function database(t: {after(fn:()=>void):void},input=fixture()) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(RESERVED_EVAL_GRANT_TABLE_SQL);
 db.prepare("INSERT INTO reserved_eval_grants(id,grant_json,approval_ref,state) VALUES(?,?,?,'fresh')").run('grant',JSON.stringify(input.grant),'operator-receipt');
 return db;
}
test('reserved eval consumes the canonical grant once and restart or caller-fresh replay cannot reopen it',t=>{
 const input=fixture(),db=database(t,input);const opts={enabled:true,grantId:'grant',runId:'run-1',input,db};
 const receipt=consumeReservedEvalGrant(opts);assert.equal(receipt.state,'consumed');assert.equal(receipt.dispatchAllowed,false);
 assert.equal(receipt.finishByMs,input.grant!.finishByMs);assert.match(receipt.grantSha256!,/^[a-f0-9]{64}$/);
 assert.equal(consumeReservedEvalGrant({...opts,runId:'run-2'}).state,'refused');
 assert.equal(db.prepare('SELECT state FROM reserved_eval_grants').get()!.state,'consumed');
});
test('reserved eval consumption is default-off, refuses stale capacity and ignores a substituted caller grant',t=>{
 const poison=new Proxy({enabled:false},{get(target,key){if(key!=='enabled')assert.fail(String(key));return target.enabled;}});
 assert.equal(consumeReservedEvalGrant(poison as any).state,'inert');
 const input=fixture(),db=database(t,input);input.grant!.maxCostUsd=9999;input.grant!.finishByMs+=9999;
 const receipt=consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'run',input,db});
 assert.equal(receipt.finishByMs,fixture().grant!.finishByMs,'only canonical limits count');
 const stale=fixture(),db2=database(t,stale);stale.capacity!.observedAtMs-=10001;
 assert.equal(consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'stale',input:stale,db:db2}).state,'refused');
 assert.equal(db2.prepare('SELECT state FROM reserved_eval_grants').get()!.state,'fresh');
});
test('reserved eval transaction failures and malformed approvals never turn into authority',t=>{
 const input=fixture(),db=database(t,input),opts={enabled:true,grantId:'grant',runId:'run',input,db};
 db.exec('BEGIN IMMEDIATE');assert.equal(consumeReservedEvalGrant(opts).state,'unavailable');db.exec('ROLLBACK');
 db.prepare("UPDATE reserved_eval_grants SET approval_ref='' ").run();assert.equal(consumeReservedEvalGrant(opts).state,'refused');
 db.prepare("UPDATE reserved_eval_grants SET approval_ref='operator', grant_json='private-not-json'").run();
 const malformed=consumeReservedEvalGrant(opts);assert.equal(malformed.state,'unavailable');assert.equal(malformed.errorKind,'invalid-canonical-json');
 assert.equal(JSON.stringify(malformed).includes('private-not-json'),false,'private grant bytes are never an error diagnostic');
 assert.equal(consumeReservedEvalGrant({...opts,grantId:'bad id'}).state,'refused');
});
test('reserved eval file-backed consumption survives reopen and a competing connection cannot use the same grant',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rmd-grant-canonical-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'grants.sqlite'),input=fixture(),db=new DatabaseSync(path),other=new DatabaseSync(path);
 t.after(()=>other.close());db.exec(RESERVED_EVAL_GRANT_TABLE_SQL);
 db.prepare("INSERT INTO reserved_eval_grants(id,grant_json,approval_ref,state) VALUES(?,?,?,'fresh')")
  .run('grant',JSON.stringify(input.grant),'operator-receipt');
 const opts={enabled:true,grantId:'grant',runId:'first',input,db};
 other.exec('BEGIN IMMEDIATE');
 assert.equal(consumeReservedEvalGrant(opts).state,'unavailable','lock contention is not admission');
 other.exec('ROLLBACK');assert.equal(consumeReservedEvalGrant(opts).state,'consumed');db.close();
 const reopened=new DatabaseSync(path);t.after(()=>reopened.close());
 assert.equal(consumeReservedEvalGrant({...opts,db:reopened,runId:'after-crash'}).state,'refused');
 assert.equal(consumeReservedEvalGrant({...opts,db:other,runId:'other-controller'}).state,'refused');
 assert.equal(other.prepare('SELECT run_id FROM reserved_eval_grants').get()!.run_id,'first');
});
// Actual disposable process crashes, not a live approval store, fleet controller,
// power-loss durability proof or permission to dispatch. The child kills ONLY itself.
for (const crashPoint of ['before-commit','after-commit'] as const) {
 test(`reserved eval canonical consumption survives a real process crash ${crashPoint}`,t=>{
  const dir=mkdtempSync(join(tmpdir(),'rmd-grant-process-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'grants.sqlite'),input=fixture(),seed=new DatabaseSync(path);
  try {
   seed.exec(RESERVED_EVAL_GRANT_TABLE_SQL);
   seed.prepare("INSERT INTO reserved_eval_grants(id,grant_json,approval_ref,state) VALUES(?,?,?,'fresh')")
    .run('grant',JSON.stringify(input.grant),'private-fixture-approval');
  } finally { seed.close(); }
  const program=`
   import {DatabaseSync} from 'node:sqlite';
   import {writeSync} from 'node:fs';
   const [path,inputJson,point,moduleUrl]=process.argv.slice(1);
   const {consumeReservedEvalGrant}=await import(moduleUrl);
   const db=new DatabaseSync(path);
   function crash() {
    const row=db.prepare('SELECT state,run_id FROM reserved_eval_grants').get();
    writeSync(1,JSON.stringify({point,row,inTransaction:db.isTransaction}));
    process.kill(process.pid,'SIGKILL');
   }
   const port=point==='before-commit'?new Proxy(db,{get(target,key){
    if(key==='exec')return sql=>{if(sql==='COMMIT')crash();return target.exec(sql);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }}):db;
   const result=consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'crashed-fixture',input:JSON.parse(inputJson),db:port});
   if(result.state!=='consumed'||result.dispatchAllowed!==false)throw Error('fixture never reached canonical commit');
   crash();
  `;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program,path,JSON.stringify(input),crashPoint,
   pathToFileURL(join(repoRoot(), "src/lib/skill-eval-grant-consumption.ts")).href],
   {encoding:'utf8',timeout:10000,maxBuffer:64<<10});
  assert.equal(child.error,undefined,child.stderr);
  assert.equal(child.status,null);assert.equal(child.signal,'SIGKILL','the owned child really died, not a synthetic exception');
  const control=JSON.parse(child.stdout);
  assert.deepEqual(control,{point:crashPoint,row:{state:'consumed',run_id:'crashed-fixture'},inTransaction:crashPoint==='before-commit'},
   'positive control: death follows the actual canonical update on the intended side of COMMIT');
  const recovered=new DatabaseSync(path);t.after(()=>recovered.close());
  const row=recovered.prepare('SELECT state,run_id FROM reserved_eval_grants').get()!;
  assert.deepEqual({...row},crashPoint==='before-commit'?{state:'fresh',run_id:null}:{state:'consumed',run_id:'crashed-fixture'});
  const retry=consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'replacement-fixture',input,db:recovered});
  assert.equal(retry.state,crashPoint==='before-commit'?'consumed':'refused');
  assert.equal(retry.dispatchAllowed,false);
  assert.equal(recovered.prepare('SELECT run_id FROM reserved_eval_grants').get()!.run_id,
   crashPoint==='before-commit'?'replacement-fixture':'crashed-fixture');
 });
}
test('reserved eval failed rollback remains UNKNOWN and never promises a fresh retry',t=>{
 const input=fixture(),db=database(t,input);db.prepare("UPDATE reserved_eval_grants SET approval_ref='' ").run();
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='exec')return (sql:string)=>{if(sql==='ROLLBACK')throw Error('rollback transport unavailable');return target.exec(sql);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const receipt=consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'run',input,db:wrapped});
 assert.equal(receipt.state,'unavailable');assert.equal(receipt.reason,'canonical-grant-rollback-unavailable');
 assert.equal(receipt.errorKind,'native-error');
 assert.equal(receipt.dispatchAllowed,false);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
});
test('reserved eval non-Error transaction failures retain UNKNOWN without disclosing thrown contents',t=>{
 const input=fixture(),db=database(t,input);
 const wrapped=new Proxy(db,{get(target,key){if(key==='exec')return ()=>{throw 'private-canonical-store-detail';};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const receipt=consumeReservedEvalGrant({enabled:true,grantId:'grant',runId:'run',input,db:wrapped});
 assert.equal(receipt.state,'unavailable');assert.equal(receipt.errorKind,'non-error');assert.equal(receipt.dispatchAllowed,false);
 assert.equal(JSON.stringify(receipt).includes('private-canonical-store-detail'),false);
});
test('whole-run service planning reserves startup and shutdown within a fixed deadline and never dispatches',()=>{
 assert.equal(ownedRunServicePlan({enabled:false}).state,'inert');
 const input={enabled:true,unitId:'80f03329-e69b-4c89-a43c-d416b3c8922e',nowMs:1000,finishByMs:11000,
  startReserveMs:1000,shutdownReserveMs:2000,cpuPercent:5,memoryMaxBytes:67108864,command:['/usr/bin/node','/private/owned-run.mjs']};
 const plan=ownedRunServicePlan(input);assert.equal(plan.dispatchAllowed,false);assert.equal(plan.runtimeMs,7000);
 for(const arg of ['--property=ExitType=cgroup','--property=KillMode=control-group','--property=RuntimeMaxSec=7000ms',
  '--property=TimeoutStopSec=2000ms','--property=Restart=no','--property=SendSIGKILL=yes'])assert.ok(plan.args.includes(arg));
 assert.equal(ownedRunServicePlan({...input,nowMs:10000}).state,'refused');
 assert.equal(ownedRunServicePlan({...input,unitId:'foreign-service'}).state,'refused');
});
