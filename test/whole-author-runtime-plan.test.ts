import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {makeRuntimeFixture} from '#test/helpers/native-runtime-fixture.js';

const runtime=await import(pathToFileURL(join(process.cwd(),'scripts/lib/native-author-runtime.mjs')).href);
const phasesModule=await import(pathToFileURL(join(process.cwd(),'scripts/lib/author-phase-accounting.mjs')).href);
const head='a'.repeat(40),tree='b'.repeat(40),files=['test/a.test.ts','test/b.test.ts','test/unknown.test.ts'];
const manifest={version:1,files:{'test/a.test.ts':1000,'test/b.test.ts':3000}};
const profile={at:new Date().toISOString(),bindings:{head,inputTree:tree},files:{'test/a.test.ts':1200,'test/b.test.ts':3500}};
function control(){
  const receipt={verdict:'passed',durationMs:150000,suites:['test/a.test.ts','test/b.test.ts'],steps:[
    {name:'census-precheck',ok:true,durationMs:40000},
    {name:'static-preflight',ok:true,durationMs:50000},
    {name:'affected-tests',ok:true,durationMs:1000,testSummary:{tests:2,suites:1,pass:2,fail:0,cancelled:0,skipped:0,todo:0}},
  ]};
  return{receipt,phases:{head,inputTree:tree,accounting:phasesModule.accountAuthorPhases(receipt)},options:{workers:1,now:1000,deadline:1000000}};
}

test('whole author plan rejects a tests-only fit when serial census and static exhaust the deadline',()=>{
  assert.equal(typeof runtime.wholeAuthorDeadlineFit,'function','the whole-run planner must exist');
  const{phases,options}=control(),bounded={...options,deadline:100000};
  assert.equal(runtime.runtimeDeadlineFit(files,manifest,profile,{...bounded,staticReserveMs:0}).fits,true,'positive test-only fit control');
  const result=runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,bounded);
  assert.equal(result.state,'estimated');assert.equal(result.fits,false);assert.equal(result.serialObservedMs,149000);
  assert.equal(result.serialPredictedMs,Math.ceil(149000*runtime.AUTHOR_RUNTIME_SAFETY_FACTOR));
  assert.equal(result.dispatchAllowed,false);assert.equal(result.capacityGranted,false);assert.equal(result.authorPassReused,false);
});

test('whole author plan preserves exact deadline boundaries and subtracts elapsed time once',()=>{
  const{phases,options}=control(),initial=runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,options);
  const deadline=options.now+initial.requiredMs;
  assert.equal(runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,{...options,deadline}).fits,true);
  const late=runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,{...options,deadline,now:options.now+1});
  assert.equal(late.fits,false);assert.equal(late.requiredMs,initial.requiredMs);assert.equal(late.deadline,deadline);
  assert.equal(late.availableMs,initial.requiredMs-1);
});

test('whole author plan never divides serial prechecks by test workers or counts prior tests twice',()=>{
  const{phases,options}=control(),one=runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,options);
  const four=runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,{...options,workers:4});
  assert.equal(four.serialPredictedMs,one.serialPredictedMs);assert.ok(four.testPredictedMs<=one.testPredictedMs);
  assert.equal(one.requiredMs,one.serialPredictedMs+one.testPredictedMs+runtime.AUTHOR_SHUTDOWN_RESERVE_MS);
  const changed=structuredClone(phases);changed.accounting.phases.find((x:{name:string})=>x.name==='affected-tests').durationMs=900000;
  changed.accounting.nativeDurationMs+=899000;changed.accounting.wallDurationMs+=899000;
  assert.equal(runtime.wholeAuthorDeadlineFit(files,manifest,profile,changed,options).requiredMs,one.requiredMs);
});

test('whole author plan keeps missing partial duplicate and foreign phase evidence explicitly unmeasured',()=>{
  const{phases,options}=control();assert.equal(runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,options).fits,true);
  const variants=[undefined,{...phases,head:'c'.repeat(40)},{...phases,inputTree:'d'.repeat(40)},
    {...phases,accounting:{...phases.accounting,trainingEligible:false}},
    {...phases,accounting:{...phases.accounting,state:'partial'}},
    {...phases,accounting:{...phases.accounting,selectionAndAdmissionOverheadMs:null}},
    {...phases,accounting:{...phases.accounting,wallDurationMs:0}},
    {...phases,accounting:{...phases.accounting,phases:[...phases.accounting.phases,null]}},
    {...phases,accounting:{...phases.accounting,phases:phases.accounting.phases.filter((x:{name:string})=>x.name!=='census-precheck')}},
    {...phases,accounting:{...phases.accounting,phases:[...phases.accounting.phases,phases.accounting.phases[0]]}},
    {...phases,accounting:{...phases.accounting,phases:[{name:'census-precheck',ok:true,durationMs:null},...phases.accounting.phases.slice(1)]}},
  ];
  for(const input of variants){const r=runtime.wholeAuthorDeadlineFit(files,manifest,profile,input,options);
    assert.equal(r.state,'not-measured');assert.equal(r.fits,false);assert.equal(r.requiredMs,null);assert.equal(r.serialPredictedMs,null);assert.equal(r.dispatchAllowed,false);}
});

test('whole author plan refuses unsafe phase totals and never treats unavailable resources as granted',()=>{
  const{phases,options}=control(),huge=structuredClone(phases);
  huge.accounting.phases[0].durationMs=7.5e15;huge.accounting.phases[1].durationMs=0;
  huge.accounting.nativeDurationMs=7.5e15+1000;huge.accounting.wallDurationMs=7.5e15+1000;huge.accounting.selectionAndAdmissionOverheadMs=0;
  assert.throws(()=>runtime.wholeAuthorDeadlineFit(files,manifest,profile,huge,options),/unsafe timing total/);
  assert.equal(runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,options).resourceFitQualified,false);
  for(const workers of [0,5,1.5])assert.throws(()=>runtime.wholeAuthorDeadlineFit(files,manifest,profile,phases,{...options,workers}),/invalid/);
});

function phaseEvidence(dir:string,sourceHead:string){
  const now=new Date().toISOString(),testSummary={tests:2,suites:1,pass:2,fail:0,cancelled:0,skipped:0,todo:0};
  mkdirSync(join(dir,'coverage','phase-control'),{recursive:true});
  const steps=['census-precheck','static-preflight','affected-tests'].map((name,index)=>{
    const prefix='coverage/phase-control/'+name,stdout=name==='affected-tests'?'# tests 2\n# suites 1\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n':'closed '+name+'\n';
    const native={status:0,signal:null,error:null,outputComplete:true,durationMs:10+index,startedAt:now,finishedAt:now,observedBytes:Buffer.byteLength(stdout),storedBytes:Buffer.byteLength(stdout)};
    writeFileSync(join(dir,prefix+'.stdout'),stdout);writeFileSync(join(dir,prefix+'.stderr'),'');writeFileSync(join(dir,prefix+'.native.json'),JSON.stringify(native));
    return{name,ok:true,exitCode:0,durationMs:native.durationMs,startedAt:now,finishedAt:now,
      ...(name==='affected-tests'?{testSummary,judge:{complete:true,given:2,reported:2,unreported:[],exitSite:null}}:{}),diagnostics:{nativeResult:prefix+'.native.json',stdout:prefix+'.stdout',stderr:prefix+'.stderr',stdoutBytes:Buffer.byteLength(stdout),stderrBytes:0,mayBeIncomplete:false}};
  });
  const path='coverage/phase-control/author.json',receipt={version:1,node:process.version,headSha:sourceHead,verdict:'passed',durationMs:100,suites:['test/a.test.ts','test/b.test.ts'],steps};
  const save=()=>writeFileSync(join(dir,path),JSON.stringify(receipt));save();return{path,receipt,save};
}

test('whole author phase reader rereads physical native captures and refuses partial or tampered evidence',t=>{
  const f=makeRuntimeFixture();t.after(()=>f.cleanup());const bindings=runtime.runtimeBindings(f.dir,f.git('rev-parse','HEAD')),e=phaseEvidence(f.dir,bindings.head);
  assert.equal(runtime.readWholeAuthorPhases(f.dir,e.path,bindings).accounting.trainingEligible,true);
  const original=readFileSync(join(f.dir,e.path),'utf8');
  for(const override of [{verdict:'over-capacity'},{headSha:'f'.repeat(40)},{node:'v0.0.0'},{steps:e.receipt.steps.slice(1)}]){
    writeFileSync(join(f.dir,e.path),JSON.stringify({...e.receipt,...override}));assert.throws(()=>runtime.readWholeAuthorPhases(f.dir,e.path,bindings));
  }
  writeFileSync(join(f.dir,e.path),original);
  const incomplete=JSON.parse(original);incomplete.steps[0].diagnostics.nativeResult='';
  writeFileSync(join(f.dir,e.path),JSON.stringify(incomplete));
  assert.throws(()=>runtime.readWholeAuthorPhases(f.dir,e.path,bindings),/missing closed native capture/);
  writeFileSync(join(f.dir,e.path),original);
  const nativePath=join(f.dir,'coverage/phase-control/static-preflight.native.json'),raw=readFileSync(nativePath,'utf8'),native=JSON.parse(raw);
  for(const change of [{status:1},{signal:'SIGTERM'},{outputComplete:false},{durationMs:999},{storedBytes:0},{finishedAt:new Date(Date.now()+60000).toISOString()}]){
    writeFileSync(nativePath,JSON.stringify({...native,...change}));assert.throws(()=>runtime.readWholeAuthorPhases(f.dir,e.path,bindings));
  }
  writeFileSync(nativePath,raw);
  const stdout=join(f.dir,'coverage/phase-control/affected-tests.stdout'),captured=readFileSync(stdout,'utf8');
  for(const [from,to]of [['# pass 2','# pass 1'],['# suites 1','# suites 0']]){
    writeFileSync(stdout,captured.replace(from,to));
    assert.throws(()=>runtime.readWholeAuthorPhases(f.dir,e.path,bindings),/summary does not match/);
  }
});

test('whole author planning CLI uses validated native profile and complete phases without granting execution',async t=>{
  const f=makeRuntimeFixture();t.after(()=>f.cleanup());
  const{calibrateAuthorRuntime}=await import(pathToFileURL(join(process.cwd(),'scripts/calibrate-author-runtime.mjs')).href);
  const observed=calibrateAuthorRuntime({root:f.dir}),e=phaseEvidence(f.dir,f.git('rev-parse','HEAD'));
  const{planAuthorRuntime}=await import(pathToFileURL(join(process.cwd(),'scripts/plan-author-runtime.mjs')).href);
  const now=Date.now(),result=planAuthorRuntime({root:f.dir,profilePath:observed.path,authorReceipt:e.path,workers:1,now,deadline:now+1000000});
  assert.equal(result.selection,'full-corpus');assert.equal(result.selectedFiles,2);assert.equal(result.calibratedSampleFiles,2);
  assert.equal(result.dispatchAllowed,false);assert.equal(result.capacityGranted,false);assert.equal(result.authorPassReused,false);assert.equal(result.fullSelectionQualified,false);
  const script=join(process.cwd(),'scripts/plan-author-runtime.mjs');
  const runCLI=(deadline:number)=>spawnSync(process.execPath,['--import','tsx',script,'--root',f.dir,
    '--runtime-profile',observed.path,'--author-receipt',e.path,'--workers','1','--deadline',new Date(deadline).toISOString()],
    {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  const actual=runCLI(now+1000000);assert.equal(actual.status,0,actual.stderr);
  const parsed=JSON.parse(actual.stdout);assert.equal(parsed.selection,'full-corpus');assert.equal(parsed.selectedFiles,2);assert.equal(parsed.dispatchAllowed,false);
  const expired=runCLI(now);assert.equal(expired.status,3,expired.stderr);assert.equal(JSON.parse(expired.stdout).fits,false);
  e.receipt.verdict='over-capacity';e.save();
  assert.throws(()=>planAuthorRuntime({root:f.dir,profilePath:observed.path,authorReceipt:e.path,workers:1,deadline:now+1000000}),/incomplete or unsuccessful/);
});

test('whole author phase reader refuses ghost suites and unclosed physical file denominators',t=>{
  const f=makeRuntimeFixture();t.after(()=>f.cleanup());const bindings=runtime.runtimeBindings(f.dir,f.git('rev-parse','HEAD')),e=phaseEvidence(f.dir,bindings.head);
  assert.equal(runtime.readWholeAuthorPhases(f.dir,e.path,bindings).accounting.trainingEligible,true,'complete physical positive control');
  const original=readFileSync(join(f.dir,e.path),'utf8'),valid=JSON.parse(original);
  const ghost={...valid,suites:['test/a.test.ts','test/does-not-exist.test.ts']};
  const variants=[ghost,...[undefined,{complete:false},{given:3},{reported:1},{unreported:['test/b.test.ts']},{exitSite:'premature-exit'}].map(change=>{
    const copy=JSON.parse(original),step=copy.steps.find((s:{name:string})=>s.name==='affected-tests');
    if(change===undefined)delete step.judge;else Object.assign(step.judge,change);return copy;
  })];
  for(const data of variants){writeFileSync(join(f.dir,e.path),JSON.stringify(data));assert.throws(()=>runtime.readWholeAuthorPhases(f.dir,e.path,bindings),/unverified physical suite denominator/);}
  writeFileSync(join(f.dir,e.path),original);
  assert.equal(runtime.readWholeAuthorPhases(f.dir,e.path,bindings).accounting.trainingEligible,true,'exact restored positive');
});

test('whole author planning real CLI help and missing evidence never launch validation',()=>{
  const script=join(process.cwd(),'scripts/plan-author-runtime.mjs');
  const help=spawnSync(process.execPath,['--import','tsx',script,'--help'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/read-only whole-phase ESTIMATE/);
  const missing=spawnSync(process.execPath,['--import','tsx',script],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(missing.status,2,missing.stdout);assert.match(missing.stderr,/"state":"not-measured"/);
  assert.match(missing.stderr,/"dispatchAllowed":false/);assert.match(missing.stderr,/"capacityGranted":false/);
});
