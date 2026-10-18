import fs from 'node:fs';
import cp from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
const [mode,configPath]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const {source,head,base,publicationBranch,deadline,output,privateHome,privateTmp,browsers}=config;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git=args=>cp.execFileSync('git',['-C',source,...args],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}).trim();
const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const sample=()=>{
 const mem=Object.fromEntries(fs.readFileSync('/proc/meminfo','utf8').split('\n').filter(l=>/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/.test(l)).map(l=>[l.split(':')[0],Number(l.trim().split(/\s+/)[1])*1024]));
 const vm=Object.fromEntries(fs.readFileSync('/proc/vmstat','utf8').trim().split('\n').map(l=>l.split(/\s+/)));
 const psi=Object.fromEntries(fs.readFileSync('/proc/pressure/memory','utf8').split('\n').find(l=>l.startsWith('full ')).split(' ').slice(1).map(x=>x.split('=')));
 return{at:new Date().toISOString(),memory:mem,swapInPages:Number(vm.pswpin),fullAvg60:Number(psi.avg60),workspaceFree:Number(fs.statfsSync(source).bavail)*Number(fs.statfsSync(source).bsize),tempFree:Number(fs.statfsSync(privateTmp).bavail)*Number(fs.statfsSync(privateTmp).bsize)};
};
if(mode==='prepare'){
 assert(/^[a-f0-9]{40}$/.test(head)&&/^[a-f0-9]{40}$/.test(base));
 assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['rev-parse','--is-shallow-repository']),'false');assert.equal(git(['status','--porcelain']),'');
 assert.equal(fs.readFileSync(path.join(source,'.nvmrc'),'utf8').trim().replace(/^v/,''),process.versions.node);
 assert(Date.parse(deadline)>Date.now(),'Fixed pilot deadline already elapsed');
 for(const dir of[output,privateHome,privateTmp])fs.mkdirSync(dir,{recursive:false,mode:0o700});
 assert(!fs.existsSync(path.join(source,'.git','objects','info','alternates')),'Borrowed Git objects are not admitted');
 git(['checkout','-b',publicationBranch,head]);git(['config','core.hooksPath','hooks']);
 const mirror=path.join(path.dirname(output),'pilot-main.git');assert(!fs.existsSync(mirror));cp.execFileSync('git',['clone','--mirror','--no-local','--no-hardlinks',source,mirror],{encoding:'utf8',timeout:120000});
 cp.execFileSync('git',['-C',mirror,'update-ref','refs/heads/main',base],{encoding:'utf8',timeout:10000});
 git(['remote','set-url','origin','file://'+mirror]);
 const out={pilot:12667,stage:'prepared',at:new Date().toISOString(),head,base,tree:git(['rev-parse','HEAD^{tree}']),publicationBranch,deadline,node:process.version,platform:process.platform,arch:process.arch,kernel:os.release(),cpus:os.availableParallelism(),source,mirror,locks:{package:hash(path.join(source,'package-lock.json')),manifest:hash(path.join(source,'scripts/test-tier-manifest.json'))},limits:'Fresh public source and lockfile-installed dependencies only; source gate will fetch captured public main from a complete file-only mirror. No production state, credentials or test result reuse.'};save('prepared.json',out);console.log(JSON.stringify(out));
}else if(mode==='run'){
 assert.equal(process.getuid(),config.uid,'Validation must retain the non-root runner identity');assert.equal(process.env.HOME,privateHome);assert.equal(process.env.TMPDIR,privateTmp);
 assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),config.hostNetNamespace,'Validation network namespace was not isolated');
 const server=net.createServer(socket=>socket.end('loopback-control'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;
 const loopback=await new Promise((resolve,reject)=>{let text='';const socket=net.connect(port,'127.0.0.1');socket.on('data',b=>text+=b);socket.once('error',reject);socket.once('end',()=>resolve(text));});
 await new Promise(resolve=>server.close(resolve));assert.equal(loopback,'loopback-control');
 save('network-control.json',{pilot:12667,isolatedNamespace:fs.readlinkSync('/proc/self/ns/net'),hostNamespace:config.hostNetNamespace,loopback:'passed',routeTable:fs.readFileSync('/proc/net/route','utf8'),limits:'Loopback positive in a fresh network namespace; no production endpoint or credentials used.'});
 assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['status','--porcelain']),'');assert.equal(process.versions.node,fs.readFileSync(path.join(source,'.nvmrc'),'utf8').trim());
 const first=sample();await new Promise(r=>setTimeout(r,30000));const last=sample();
 const checks={memory:min(first.memory.MemAvailable,last.memory.MemAvailable)>=7*1024**3,disk:min(first.workspaceFree,last.workspaceFree,first.tempFree,last.tempFree)>=20*1024**3,noSwapIn:first.swapInPages===last.swapInPages,pressure:Math.max(first.fullAvg60,last.fullAvg60)<0.5};
 save('admission.json',{pilot:12667,at:new Date().toISOString(),head,deadline,first,last,checks,admitted:Object.values(checks).every(Boolean)});assert(Object.values(checks).every(Boolean),'Hosted admission refused after setup; no gate started');
 const command=(name,args,program=process.execPath,input=undefined)=>{
  assert(Date.now()<Date.parse(deadline),'Fixed deadline elapsed');
  const stdout=fs.openSync(path.join(output,name+'.stdout.log'),'wx',0o600),stderr=fs.openSync(path.join(output,name+'.stderr.log'),'wx',0o600),started=Date.now();
  let result;try{result=cp.spawnSync(program,args,{cwd:source,env:process.env,stdio:[input===undefined?'ignore':'pipe',stdout,stderr],...(input===undefined?{}:{input}),timeout:Math.max(1,Date.parse(deadline)-Date.now()),killSignal:'SIGTERM'});}finally{fs.closeSync(stdout);fs.closeSync(stderr);}
  const row={pilot:12667,stage:name,head,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-started,status:result.status,signal:result.signal,error:result.error?{code:result.error.code,message:result.error.message}:null};save(name+'.native.json',row);console.log(JSON.stringify(row));return row;
 };
 let final;
 try{
  const sourcePrepush=command('source-pre-push',['hooks/pre-push','origin',git(['remote','get-url','origin'])],'/bin/sh',`refs/heads/${publicationBranch} ${head} refs/heads/${publicationBranch} ${'0'.repeat(40)}\n`);assert.equal(sourcePrepush.status,0,'Unchanged source pre-push hook did not pass');assert(!sourcePrepush.error&&!sourcePrepush.signal);
  const selection=command('selection',['--import','tsx','scripts/preflight-author.mjs','--dry-run','--head-ref',publicationBranch,'--head-sha',head]);assert.equal(selection.status,0);assert(!selection.error&&!selection.signal);
  fs.copyFileSync(path.join(source,'coverage/preflight-author.json'),path.join(output,'selection.json'),fs.constants.COPYFILE_EXCL);
  const selected=JSON.parse(fs.readFileSync(path.join(output,'selection.json'),'utf8'));assert.equal(selected.headSha,head);assert.equal(selected.baseSha,base);assert(selected.suites.length>0);for(const file of selected.suites)assert(fs.lstatSync(path.join(source,file)).isFile(),file);
  const calibration=command('calibration',['--import','tsx','scripts/calibrate-author-runtime.mjs']);assert.equal(calibration.status,0);assert(!calibration.error&&!calibration.signal);
  const rows=fs.readFileSync(path.join(output,'calibration.stdout.log'),'utf8').trim().split('\n').flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}});const profile=rows.findLast(r=>r.head===head&&r.samples===32&&r.path);assert(profile,'No source-bound32-file maintained profile');
  const author=command('author',['--import','tsx','scripts/preflight-author.mjs','--head-ref',publicationBranch,'--head-sha',head,'--deadline',deadline,'--runtime-profile',profile.path]);
  const receipt=JSON.parse(fs.readFileSync(path.join(source,'coverage/preflight-author.json'),'utf8'));fs.copyFileSync(path.join(source,'coverage/preflight-author.json'),path.join(output,'author-receipt.json'),fs.constants.COPYFILE_EXCL);
  const test=receipt.steps.find(s=>s.name==='affected-tests'),summary=test?.testSummary;
  const passed=author.status===0&&!author.error&&!author.signal&&receipt.verdict==='passed'&&receipt.headSha===head&&receipt.baseSha===base&&receipt.steps.every(s=>s.ok===true)&&!receipt.tiered&&test?.judge?.complete===true&&summary?.tests>0&&summary.fail===0&&summary.cancelled===0&&summary.todo===0&&summary.pass+summary.skipped===summary.tests;
  final={pilot:12667,at:new Date().toISOString(),head,base,tree:git(['rev-parse','HEAD^{tree}']),deadline,passed,status:author.status,selectedPhysicalFiles:receipt.suites.length,summary,conditionalSkips:summary?.skipped??null,judge:test?.judge,slot:receipt.testSlot,executionWorkers:receipt.executionWorkers,runtimeAdmission:receipt.runtimeAdmission,capacity:receipt.capacity,finalResources:sample(),phaseAccounting:receipt.phaseAccounting??null,limits:'Exact-head author gate only. Conditional platform test skips are disclosed, never tests credited as passed; no required check or selected physical suite was manually omitted. Hosted required CI/security/review, publication/reopening and live adoption remain separate.'};
  save('final.json',final);assert(passed,'Actual maintained author gate did not qualify this head');
 }catch(error){if(!final){final={pilot:12667,at:new Date().toISOString(),head,base,deadline,passed:false,error:{message:error.message},limits:'Terminal pilot failure/refusal; no retry, deadline reset, source publication or production action.'};save('final.json',final);}throw error;}
 finally{for(const name of fs.readdirSync(path.join(source,'coverage')).filter(n=>n.startsWith('rmd-author-')||n.startsWith('rmd-native-runtime-')||n==='preflight-author-static.json'))fs.cpSync(path.join(source,'coverage',name),path.join(output,name),{recursive:true,errorOnExist:true,force:false});}
 console.log(JSON.stringify(final));
}else throw Error('Unknown pilot mode');
function min(...values){return Math.min(...values);}
