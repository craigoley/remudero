#!/usr/bin/env node
import {resolve} from 'node:path';import{fileURLToPath}from'node:url';
import {readSharedGitPolicy,createSharedWorkspace} from './lib/shared-workspace.mjs';
export async function main(args=process.argv.slice(2),home){
  try{
    if(args.length===1&&args[0]==='status'){console.log(JSON.stringify({schema:'rmd-shared-workspace-status/v1',policy:readSharedGitPolicy(home),automaticPruning:false,activeMigration:false}));return 0;}
    if(args.length!==2||args[0]!=='create'||args[1]!=='unfiled')throw Error('usage: shared-workspace.mjs status | create unfiled; filed tasks use the maintained task workflow');
    const result=await createSharedWorkspace('unfiled',{home});console.log(JSON.stringify(result));return result.state==='CREATED_SHARED_OBJECTS_NO_FRESH_INSTALL'?0:75;
  }catch(error){console.error(JSON.stringify({state:'UNKNOWN',reason:error instanceof Error?error.message:String(error)}));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
