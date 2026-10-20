// Account-private linked workspaces. No clone, fresh npm fallback, pruning or filed-task dispatch.
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,existsSync,statfsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {captureStepSync} from './author-step-capture.mjs';

const MIN_FREE_BYTES=2*1024**3,MAX_JSON_BYTES=16384;
const same=(a,b)=>['dev','ino','size','uid','mode','nlink','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
function readPrivateJson(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==process.getuid()||before.nlink!==1||(before.mode&0o077)||before.size>MAX_JSON_BYTES)throw Error('unverified private Git configuration');
    const bytes=Buffer.alloc(before.size+1);let used=0;
    while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}
    if(used!==before.size||!same(before,fstatSync(fd))||!same(before,lstatSync(path)))throw Error('private Git configuration changed during read');
    return JSON.parse(bytes.subarray(0,used).toString('utf8'));
  }finally{closeSync(fd);}
}
function ownedDirectory(path,home) {
  if(typeof path!=='string'||resolve(path)!==path||!path.startsWith(home+sep)||realpathSync(path)!==path)throw Error('storage path must be physical and inside this account');
  for(let p=path;p!==dirname(home);p=dirname(p)){
    const s=lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022))throw Error('storage path is not account-owned and protected');
  }
}
export function readSharedGitPolicy(home=homedir()) {
  const file=join(home,'.config/remudero/git-storage.json');
  try{
    ownedDirectory(dirname(file),home);
    const config=readPrivateJson(file);
    if(config.schema!=='rmd-git-storage/v1'||typeof config.enabled!=='boolean')throw Error('versioned Git storage policy required');
    if(!config.enabled)return{enabled:false};
    for(const key of ['pool','parent','dependencyRoot'])ownedDirectory(config[key],home);
    if(typeof config.dependencyDonor!=='string'||resolve(config.dependencyDonor)!==config.dependencyDonor||realpathSync(config.dependencyDonor)!==config.dependencyDonor)throw Error('physical explicit dependency donor required');
    if(config.poolKind!=='existing-checkout'&&config.poolKind!=='qualified-bare')throw Error('explicit Git store kind required');
    return{enabled:true,pool:config.pool,poolKind:config.poolKind,parent:config.parent,dependencyRoot:config.dependencyRoot,dependencyDonor:config.dependencyDonor};
  }catch(error){if(error.code==='ENOENT'&&!existsSync(file))return{enabled:false};throw error;}
}
export function readSharedWorkspaceCapacity(parent) {
  const volume=statfsSync(parent),freeBytes=Number(volume.bavail)*Number(volume.bsize);
  const pressure=process.platform==='darwin'?spawnSync('/usr/sbin/sysctl',['-n','kern.memorystatus_vm_pressure_level'],{encoding:'utf8',timeout:2000,maxBuffer:4096}):undefined;
  return{admitted:Number.isSafeInteger(freeBytes)&&freeBytes>=MIN_FREE_BYTES&&pressure?.status===0&&pressure.stdout.trim()==='1',freeBytes,minimumFreeBytes:MIN_FREE_BYTES,pressure:pressure?.status===0?pressure.stdout.trim():'UNKNOWN'};
}
// Borrow only a live ancestor's exact reservation. This command never allocates,
// reclaims, chmods, releases or replaces any test-slot or dispatch record.
export async function borrowedWorkspaceWorker() {
  if(!process.env.RMD_TEST_SLOT_PARENT)return{admitted:false,reason:'no inherited genuine worker'};
  if(process.env.RMD_TEST_SLOT_PARENT.length>MAX_JSON_BYTES)throw Error('oversized inherited worker claim');
  const {testSlotProcessFacts,testSlotHasAncestor}=await import('../../src/lib/test-slot.ts');
  const claim=JSON.parse(process.env.RMD_TEST_SLOT_PARENT),fd=openSync(claim.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.size>MAX_JSON_BYTES)throw Error('unverified inherited reservation');
    const bytes=Buffer.alloc(s.size+1),n=readSync(fd,bytes,0,bytes.length,0),held=JSON.parse(bytes.subarray(0,n).toString('utf8'));
    if(n!==s.size||!same(s,fstatSync(fd))||!same(s,lstatSync(claim.path))||!Number.isSafeInteger(claim.pid)||claim.pid<=0||held.pid!==claim.pid||held.ownerNonce!==claim.nonce||held.processStart!==claim.start||!claim.nonce||!claim.start||!testSlotHasAncestor(claim.pid)||testSlotProcessFacts(claim.pid)?.start!==claim.start||held.concurrency!==1||claim.concurrency!==1)throw Error('inherited worker identity unverified');
    return{admitted:true,pid:claim.pid,nonce:claim.nonce,start:claim.start};
  }finally{closeSync(fd);}
}
function cleanGitEnvironment(){const env={...process.env,GIT_TERMINAL_PROMPT:'0'};for(const key of Object.keys(env))if(/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|CONFIG.*)$/.test(key))delete env[key];return env;}
const defaultMaterialize=async(path,options)=>{const {materializeDependencySeed}=await import('../../src/lib/dependency-seeds.ts');return materializeDependencySeed(path,options);};

/** Create one unfiled linked worktree; uncertainty never authorizes a clone or install. */
export async function createSharedWorkspace(taskId,{home=homedir(),readCapacity=readSharedWorkspaceCapacity,borrowWorker=borrowedWorkspaceWorker,materialize=defaultMaterialize,now=Date.now}={}) {
  const result={schema:'rmd-shared-workspace/v1',state:'NOT_RUN',modelCalls:0,freshNpmInstalls:0,automaticPruning:false};
  let receiptDir,created=false;
  try{
    if(taskId!=='unfiled')throw Error('filed tasks require the maintained task, claim and merged-credit workflow');
    const config=readSharedGitPolicy(home);if(!config.enabled){result.reason='Git storage policy disabled';return result;}
    result.capacity=readCapacity(config.parent);if(!result.capacity.admitted)throw Error('bounded workspace capacity unavailable');
    result.worker=await borrowWorker();if(!result.worker.admitted)throw Error('genuine inherited worker unavailable');
    const stamp=now();if(!Number.isSafeInteger(stamp)||stamp<0)throw Error('invalid workspace identity');
    const branch='run-unfiled-'+stamp,path=join(config.parent,branch);if(lstatSync(path,{throwIfNoEntry:false}))throw Error('workspace path occupied; no retry');
    receiptDir=mkdtempSync(join(config.parent,'.rmd-shared-workspace-receipt-'));result.receiptDir=receiptDir;
    let step=0;const deadline=Date.now()+90000,env=cleanGitEnvironment();
    const git=(args,cwd=config.pool)=>{
      const remaining=deadline-Date.now();if(remaining<=0)throw Error('whole workspace Git budget expired');
      const prefix=join(receiptDir,String(++step).padStart(2,'0'));
      const p=captureStepSync('/usr/bin/git',['-c','gc.auto=0','-c','maintenance.auto=false',...args],{cwd,env,runtimeMs:Math.min(30000,remaining),maxBytes:1024**2,trackParent:true,stdoutPath:prefix+'.out',stderrPath:prefix+'.err',resultPath:prefix+'.json'});
      if(p.error||p.signal||!p.outputComplete||p.status!==0)throw Error('bounded Git step '+step+' refused or incomplete');return p.stdout.trim();
    };
    const common=git(['rev-parse','--path-format=absolute','--git-common-dir']);ownedDirectory(common,home);
    const bare=git(['rev-parse','--is-bare-repository'])==='true';if(bare!==(config.poolKind==='qualified-bare'))throw Error('Git store kind changed');
    if(existsSync(join(common,'objects/info/alternates'))||process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES)throw Error('fragile Git alternates refused');
    if(bare){const proof=readPrivateJson(join(config.pool,'.rmd-git-pool-full-integrity.json'));if(proof.schema!=='rmd-git-pool-full-integrity/v1'||proof.pool!==config.pool||proof.qualification!==true||proof.disposition!=='PASS')throw Error('initial full bare-pool integrity proof required');}
    git(['fetch','--quiet','origin','main']);git(['fsck','--connectivity-only','--no-reflogs','--no-dangling']);
    const base=git(['rev-parse','origin/main^{commit}']);git(['worktree','add','--quiet','--no-track','-b',branch,path,base]);created=true;Object.assign(result,{path,branch,base});
    if(git(['rev-parse','--path-format=absolute','--git-common-dir'],path)!==common)throw Error('new workspace does not share expected Git objects');result.commonGitDir=common;
    result.dependencies=await materialize(path,{root:config.dependencyRoot,sourceDir:config.dependencyDonor,lockWaitMs:0,runInstall(){throw Error('fresh npm fallback refused; retain workspace for harness retirement');}});
    if(result.dependencies.status!=='materialized'&&result.dependencies.status!=='present')throw Error('dependency result incomplete');
    result.state='CREATED_SHARED_OBJECTS_NO_FRESH_INSTALL';
  }catch(error){result.reason=error instanceof Error?error.message:String(error);if(created)result.state='CREATED_DEPENDENCIES_OR_READBACK_UNKNOWN_RETAINED';}
  finally{if(receiptDir)writeFileSync(join(receiptDir,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});}
  return result;
}
