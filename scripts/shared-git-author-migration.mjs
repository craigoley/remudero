#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectSharedGitAuthorMigration,applySharedGitAuthorMigration} from './lib/shared-git-author-migration.mjs';
export async function main(args=process.argv.slice(2)){
  try{
    if(args.length===2&&args[0]==='inspect'){console.log(JSON.stringify(inspectSharedGitAuthorMigration(args[1])));return 0;}
    if(args.length!==4||args[0]!=='apply'||!/^[a-f0-9]{64}$/.test(args[2])||args[3]!=='--confirm-idle')throw Error('usage: shared-git-author-migration.mjs inspect <pool> | apply <pool> <plan-sha256> --confirm-idle; application requires a separately approved idle window and inherited worker');
    const result=await applySharedGitAuthorMigration(args[1],args[2],{confirmIdle:true});console.log(JSON.stringify(result));return result.state==='APPLIED_MAIN_BARE_PRESERVED'?0:3;
  }catch(error){console.error(JSON.stringify({state:'NOT_APPLIED',reason:error.message}));return 3;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
