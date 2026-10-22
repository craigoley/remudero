// Explicit idle-window migration only. Author validation never calls this writer.
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,realpathSync,mkdtempSync,linkSync,unlinkSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {borrowedWorkspaceWorker} from './shared-workspace.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const equal=(a,b)=>['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
function owned(path){
  if(resolve(path)!==path||realpathSync(path)!==path)throw Error('physical absolute pool required');
  for(let p=path;;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o022)||![0,process.getuid()].includes(s.uid))throw Error('protected owned directory required');if(p===path&&s.uid!==process.getuid())throw Error('owned pool required');if(p===dirname(p))break;}
}
function readConfig(path){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o022)||s.size>65536)throw Error('owned bounded config required');
    const bytes=readFileSync(fd);if(!equal(s,fstatSync(fd))||!equal(s,lstatSync(path)))throw Error('config changed during read');return{bytes,sha256:digest(bytes)};
  }finally{closeSync(fd);}
}
function git(pool,args,allowed=[0],linked=false){
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('GIT_'))delete env[k];
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'});
  // BACKSTOP: local metadata only, never fetch, maintenance, hooks or credential queries.
  const p=spawnSync('/usr/bin/git',[...(linked?['-C',pool]:['--git-dir='+pool]),...args],{env,encoding:'utf8',timeout:2000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  if(p.error||p.signal||!allowed.includes(p.status))throw Error('bounded migration Git read/write refused');return p.stdout;
}
function absent(path){if(lstatSync(path,{throwIfNoEntry:false}))throw Error('existing worktree config or migration lock requires operator review');}
/** Read-only, tightly scoped to an unmigrated bare pool. No filesystem writes. */
export function inspectSharedGitAuthorMigration(pool){
  owned(pool);const config=readConfig(join(pool,'config'));
  const value=key=>git(pool,['config','--file',join(pool,'config'),'--no-includes','--get-all',key],[0,1]).trim();
  if(value('core.bare')!=='true'||git(pool,['config','--file',join(pool,'config'),'--no-includes','--name-only','--get-regexp','^core[.]worktree$'],[0,1]).trim()||!['','false'].includes(value('extensions.worktreeConfig'))||
      git(pool,['config','--file',join(pool,'config'),'--no-includes','--get-regexp','^include'],[0,1]).trim())throw Error('unsupported common Git topology; no migration');
  if(git(pool,['rev-parse','--is-bare-repository']).trim()!=='true')throw Error('bare main repository required');
  absent(join(pool,'config.worktree'));absent(join(pool,'config.lock'));absent(join(pool,'config.worktree.lock'));
  const inventory=git(pool,['worktree','list','--porcelain','-z']);
  const paths=inventory.split('\0').filter(v=>v.startsWith('worktree ')).map(v=>v.slice(9));
  if(paths.length<1||paths.length>128||paths[0]!==pool)throw Error('bounded main-first inventory required');
  for(const path of paths.slice(1)){owned(path);const privateDir=git(path,['rev-parse','--absolute-git-dir'],[0],true).trim();
    if(git(path,['rev-parse','--path-format=absolute','--git-common-dir'],[0],true).trim()!==pool||!privateDir.startsWith(join(pool,'worktrees')+'/'))throw Error('linked identity unverified');
    absent(join(privateDir,'config.worktree'));
  }
  const plan={schema:'rmd-shared-git-author-migration/v1',pool,configSha256:config.sha256,inventorySha256:digest(inventory),worktreeCount:paths.length,mainBarePreserved:true,liveApplicationAuthorized:false};
  return{...plan,planSha256:digest(JSON.stringify(plan))};
}
/** The caller must arrange an idle window. A worker reservation alone does NOT prove idleness. */
export async function applySharedGitAuthorMigration(pool,expectedPlanSha256,{confirmIdle=false,borrowWorker=borrowedWorkspaceWorker}={}){
  if(confirmIdle!==true)throw Error('explicit operator-confirmed idle window required');
  const worker=await borrowWorker();if(!worker.admitted||typeof worker.verify!=='function')throw Error('genuine inherited worker required');worker.verify();
  const plan=inspectSharedGitAuthorMigration(pool);if(plan.planSha256!==expectedPlanSha256)throw Error('migration plan changed');
  const before=readConfig(join(pool,'config')),stage=mkdtempSync(join(pool,'.rmd-author-migration-'));
  writeFileSync(join(stage,'original.config'),before.bytes,{flag:'wx',mode:0o600});
  const next=join(stage,'next.config');writeFileSync(next,before.bytes,{flag:'wx',mode:0o600});
  git(pool,['config','--file',next,'--unset-all','core.bare']);git(pool,['config','--file',next,'extensions.worktreeConfig','true']);
  const after=readConfig(next),main=Buffer.from('[core]\n\tbare = true\n');
  const receipt={schema:'rmd-shared-git-author-migration-result/v1',plan,backup:join(stage,'original.config'),state:'NOT_APPLIED',modelCalls:0,automaticRollback:false};
  const locks=[];let mainPublished=false,commonPublished=false;
  try{
    for(const name of ['config.lock','config.worktree.lock']){const path=join(pool,name),fd=openSync(path,'wx',0o600);locks.push({path,fd,identity:fstatSync(fd)});}
    worker.verify();if(readConfig(join(pool,'config')).sha256!==plan.configSha256||digest(git(pool,['worktree','list','--porcelain','-z']))!==plan.inventorySha256)throw Error('pool changed after locking');
    absent(join(pool,'config.worktree'));
    writeFileSync(locks[1].fd,main);fsyncSync(locks[1].fd);
    // Publish the main-only value first; it is ignored until the atomic common-config flip.
    linkSync(locks[1].path,join(pool,'config.worktree'));mainPublished=true;
    writeFileSync(locks[0].fd,after.bytes);fsyncSync(locks[0].fd);worker.verify();
    if(readConfig(join(pool,'config')).sha256!==plan.configSha256)throw Error('common config changed before publish');
    renameSync(locks[0].path,join(pool,'config'));commonPublished=true;
    if(readConfig(join(pool,'config')).sha256!==after.sha256||git(pool,['rev-parse','--is-bare-repository']).trim()!=='true')throw Error('migration read-back unknown');
    for(const field of git(pool,['worktree','list','--porcelain','-z']).split('\0').filter(v=>v.startsWith('worktree ')).slice(1))if(git(field.slice(9),['rev-parse','--is-inside-work-tree'],[0],true).trim()!=='true')throw Error('linked worktree read-back unknown');
    receipt.state='APPLIED_MAIN_BARE_PRESERVED';receipt.configSha256=after.sha256;
  }catch(error){receipt.state=commonPublished?'APPLIED_READBACK_UNKNOWN':mainPublished?'STAGED_MAIN_CONFIG_RETAINED':'NOT_APPLIED';receipt.reason=error.message;}
  finally{
    for(const lock of locks){closeSync(lock.fd);const held=lstatSync(lock.path,{throwIfNoEntry:false});if(held&&held.dev===lock.identity.dev&&held.ino===lock.identity.ino)unlinkSync(lock.path);}
    writeFileSync(join(stage,'result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  return receipt;
}
