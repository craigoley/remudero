import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
// @ts-expect-error — native capture is plain ESM outside tsconfig source roots.
import {captureStepSync} from '#scripts/lib/author-step-capture.mjs';
// @ts-expect-error — pure accounting ESM outside tsconfig source roots.
import {accountAuthorPhases} from '#scripts/lib/author-phase-accounting.mjs';
test('whole author gate accounting prices census and static work as well as tests and refuses partial training',()=>{
 const receipt={verdict:'passed',durationMs:1500,suites:['test/author-preflight.test.ts'],steps:[{name:'census-precheck',ok:true,durationMs:100},
  {name:'static-preflight',ok:true,durationMs:900},{name:'affected-tests',ok:true,durationMs:400,
   testSummary:{tests:5,suites:1,pass:5,fail:0,cancelled:0,skipped:0,todo:0}}]};
 const measured=accountAuthorPhases(receipt);assert.equal(measured.nativeDurationMs,1400);
 assert.equal(measured.selectionAndAdmissionOverheadMs,100);assert.equal(measured.trainingEligible,true);
 assert.equal(accountAuthorPhases({...receipt,verdict:'over-capacity'}).trainingEligible,false);
 assert.equal(accountAuthorPhases({...receipt,steps:[{name:'static-preflight',ok:true}]}).state,'unavailable');
 assert.equal(accountAuthorPhases({...receipt,durationMs:-1}).trainingEligible,false);
 const summary=receipt.steps[2]!.testSummary!;
 for(const override of [{skipped:1},{cancelled:1},{todo:1},{tests:0,pass:0},{pass:4},{skipped:null}]){
  assert.equal(accountAuthorPhases({...receipt,steps:[...receipt.steps.slice(0,2),
   {...receipt.steps[2],testSummary:{...summary,...override}}]}).trainingEligible,false);
 }
 assert.equal(accountAuthorPhases({...receipt,steps:[...receipt.steps.slice(0,2),
  {...receipt.steps[2],name:'affected-tests-subset'}]}).trainingEligible,false);
 assert.equal(accountAuthorPhases({...receipt,tiered:{ran:receipt.suites,skipped:['test/missing.test.ts']}}).trainingEligible,false);
 assert.equal(accountAuthorPhases({...receipt,suites:[]}).trainingEligible,false);
 assert.equal(accountAuthorPhases({...receipt,suites:[...receipt.suites,...receipt.suites]}).trainingEligible,false);
 assert.equal(accountAuthorPhases({...receipt,steps:[{...receipt.steps[0],ok:false},...receipt.steps.slice(1)]}).trainingEligible,false);
});
test('author capture records closed monotonic timing for successful and failed real subprocesses',t=>{
 const root=mkdtempSync(join(tmpdir(),'rmd-phase-accounting-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const code of [0,7]){
  const resultPath=join(root,`result-${code}.json`);
  const result=captureStepSync(process.execPath,['-e',`process.stdout.write('measured');process.exitCode=${code}`],
   {cwd:root,stdoutPath:join(root,`${code}.out`),stderrPath:join(root,`${code}.err`),resultPath,runtimeMs:5000,maxBytes:1024});
  const native=JSON.parse(readFileSync(resultPath,'utf8'));assert.equal(result.status,code);assert.equal(result.outputComplete,true);
  assert.ok(Number.isSafeInteger(native.durationMs)&&native.durationMs>0);assert.equal(result.durationMs,native.durationMs);
  assert.ok(Number.isFinite(Date.parse(native.startedAt)));assert.ok(Number.isFinite(Date.parse(native.finishedAt)));
 }
});
