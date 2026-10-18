#!/usr/bin/env node
// Read-only operator planning: never launches a gate, grants capacity or changes fleet policy.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {isMainModule,parseArgv} from './lib/argv.mjs';
import {runtimeBindings,readRuntimeProfile,readWholeAuthorPhases,sourceHead,wholeAuthorDeadlineFit} from './lib/native-author-runtime.mjs';
import {listTestFiles} from './test-tier-manifest.mjs';

export function planAuthorRuntime({root=process.cwd(),profilePath,authorReceipt,workers,deadline,now=Date.now()}={}) {
  const head=sourceHead(root),bindings=runtimeBindings(root,head),profile=readRuntimeProfile(root,profilePath,bindings);
  const phases=readWholeAuthorPhases(root,authorReceipt,bindings,now);
  const manifest=JSON.parse(readFileSync(resolve(root,'scripts/test-tier-manifest.json'),'utf8'));
  const files=listTestFiles(root);
  return {head,...wholeAuthorDeadlineFit(files,manifest,profile,phases,{workers,deadline,now}),
    selection:'full-corpus',selectedFiles:files.length,calibratedSampleFiles:profile.samples.length,
    fullSelectionQualified:false,scope:'ESTIMATE_ONLY for the full physical corpus, sample-calibrated; no full-repository or author PASS claim'};
}

if(isMainModule(import.meta.url)) {
  try {
    const {values,helpRequested}=parseArgv(process.argv.slice(2),{root:{type:'string'},'runtime-profile':{type:'string'},
      'author-receipt':{type:'string'},workers:{type:'string'},deadline:{type:'string'}},
      {allowPositionals:false,helpText:'plan-author-runtime.mjs --runtime-profile <owned coverage file> --author-receipt <owned coverage file> --workers <observed count> --deadline <fixed ISO>: read-only whole-phase ESTIMATE, never execution authority'});
    if(!helpRequested) {
      const result=planAuthorRuntime({root:values.root,profilePath:values['runtime-profile'],authorReceipt:values['author-receipt'],
        workers:Number(values.workers),deadline:Date.parse(values.deadline)});
      console.log(JSON.stringify(result,null,2));process.exitCode=result.fits?0:3;
    }
  }catch(error) {
    console.error(JSON.stringify({state:'not-measured',dispatchAllowed:false,capacityGranted:false,authorPassReused:false,error:String(error.message??error)}));process.exitCode=2;
  }
}
