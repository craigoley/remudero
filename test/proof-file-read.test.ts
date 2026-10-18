import assert from 'node:assert/strict';
import {execFileSync,type ExecFileSyncOptionsWithStringEncoding} from 'node:child_process';
import childProcess, {type SpawnOptions} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {readProofFileInside,observeProofFileInside,PROOF_FILE_READ_TIMEOUT_MS} from '#src/lib/proof-file-read.js';
import {PROOF_FILE_READ_BYTES} from '#src/lib/proof-file-reader-child.js';

async function fixture(fn:(f:{root:string;tree:string;outside:string;target:string})=>void|Promise<void>) {
 const root=fs.mkdtempSync(join(tmpdir(),'rmd-pinned-proof-')),tree=join(root,'tree'),outside=join(root,'outside'),target='a/b/file.txt';
 try{for(const dir of [tree,outside]){fs.mkdirSync(dirname(join(dir,target)),{recursive:true});fs.writeFileSync(join(dir,target),dir===tree?'inside-positive\n':'outside-negative\n');}await fn({root,tree,outside,target});}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
function preload(root:string,source:string) {
 const path=join(root,'preload.mjs');fs.writeFileSync(path,"import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const real={...fs};let done=false;"+source+';syncBuiltinESMExports();');return path;
}
function withPreload(path:string) {return (file:string,args:string[],options:ExecFileSyncOptionsWithStringEncoding)=>execFileSync(file,['--import',path,...args],options);}

test('proof file reader reads the real default through a root alias and an internal file alias',async()=>fixture(async f=>{assert.equal(await readProofFileInside(f.tree,f.target),'inside-positive\n');const alias=join(f.root,'alias');fs.symlinkSync(f.tree,alias);assert.equal(await readProofFileInside(alias,f.target),'inside-positive\n');fs.symlinkSync(join(f.tree,f.target),join(f.tree,'alias.txt'));assert.equal(await readProofFileInside(f.tree,'alias.txt'),'inside-positive\n');}));
test('proof file reader never changes the parent working directory',async()=>fixture(async f=>{const before=process.cwd();await readProofFileInside(f.tree,f.target);assert.equal(process.cwd(),before);}));
test('proof file reader refuses missing, outside, directory and traversal targets',async()=>fixture(async f=>{fs.symlinkSync(join(f.outside,f.target),join(f.tree,'outside.txt'));for(const target of ['missing','outside.txt','a','../outside/a/b/file.txt'])assert.equal(await readProofFileInside(f.tree,target),undefined);}));
test('proof file reader refuses a root replaced between its open and child startup',async()=>fixture(async f=>{const actual=await readProofFileInside(f.tree,f.target,(file,args,options)=>{fs.renameSync(f.tree,f.tree+'-held');fs.symlinkSync(f.outside,f.tree);return execFileSync(file,args,options);});assert.equal(actual,undefined);}));
test('proof file reader refuses an ancestor replaced before its directory open',async()=>fixture(async f=>{const p=preload(f.root,`fs.openSync=function(path,...args){if(path==='a'&&!done){done=true;real.renameSync('a','a-held');real.symlinkSync(${JSON.stringify(join(f.outside,'a'))},'a');}return real.openSync(path,...args);}`);assert.equal(await readProofFileInside(f.tree,f.target,withPreload(p)),undefined);}));
test('proof file reader verifies the directory actually entered after an open to chdir replacement',async()=>fixture(async f=>{const p=preload(f.root,`fs.openSync=function(path,...args){const fd=real.openSync(path,...args);if(path==='a'&&!done){done=true;real.renameSync('a','a-held');real.symlinkSync(${JSON.stringify(join(f.outside,'a'))},'a');}return fd;}`);assert.equal(await readProofFileInside(f.tree,f.target,withPreload(p)),undefined);}));
test('proof file reader refuses a leaf changed to an outside symlink before open',async()=>fixture(async f=>{const p=preload(f.root,`fs.openSync=function(path,...args){if(path==='file.txt'&&!done){done=true;real.renameSync(path,path+'.held');real.symlinkSync(${JSON.stringify(join(f.outside,f.target))},path);}return real.openSync(path,...args);}`);assert.equal(await readProofFileInside(f.tree,f.target,withPreload(p)),undefined);}));
test('proof file reader reads the opened leaf descriptor after a pathname replacement',async()=>fixture(async f=>{const p=preload(f.root,`fs.openSync=function(path,...args){const fd=real.openSync(path,...args);if(path==='file.txt'&&!done){done=true;real.renameSync(path,path+'.held');real.symlinkSync(${JSON.stringify(join(f.outside,f.target))},path);}return fd;}`);assert.equal(await readProofFileInside(f.tree,f.target,withPreload(p)),'inside-positive\n');}));
test('proof file reader refuses observable writes to its open inode',async()=>fixture(async f=>{const p=preload(f.root,"let leaf;fs.openSync=function(path,...args){const fd=real.openSync(path,...args);if(path==='file.txt')leaf=fd;return fd;};fs.fstatSync=function(fd,...args){const result=real.fstatSync(fd,...args);if(fd===leaf&&!done){done=true;real.writeFileSync('file.txt','changed-size-and-bytes');}return result;}");assert.equal(await readProofFileInside(f.tree,f.target,withPreload(p)),undefined);}));
test('proof file reader rejects oversized source without reading unbounded bytes',async()=>fixture(async f=>{fs.writeFileSync(join(f.tree,f.target),Buffer.alloc(PROOF_FILE_READ_BYTES+1,65));assert.equal(await readProofFileInside(f.tree,f.target),undefined);}));
test('proof file reader keeps a fifo nonblocking and refuses non-regular source',async()=>fixture(async f=>{const path=join(f.tree,'pipe');execFileSync('mkfifo',[path]);assert.equal(await readProofFileInside(f.tree,'pipe'),undefined);}));
test('proof file reader closes its own root descriptor on child construction failure',async()=>fixture(async f=>{let descriptor:number|undefined;assert.equal(await readProofFileInside(f.tree,f.target,(_file,_args,options)=>{descriptor=(options.stdio as Array<number|string>)[3] as number;throw Error('constructor failure');}),undefined);assert(descriptor!==undefined);const closed=descriptor;assert.throws(()=>fs.fstatSync(closed));}));
test('proof file reader gives the real child a fixed timeout and no inherited preload or credentials',async()=>fixture(async f=>{const text=await readProofFileInside(f.tree,f.target,(file,args,options)=>{assert.equal(options.timeout,PROOF_FILE_READ_TIMEOUT_MS);assert.deepEqual(Object.keys(options.env??{}),process.env.NODE_V8_COVERAGE?['PATH','NODE_V8_COVERAGE']:['PATH']);assert.equal(options.maxBuffer,PROOF_FILE_READ_BYTES);return execFileSync(file,args,options);});assert.equal(text,'inside-positive\n');}));
test('proof file child refuses malformed or escaping protocol through its real entrypoint',async()=>fixture(async f=>{const fd=fs.openSync(f.tree,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),child=fileURLToPath(import.meta.resolve('#src/lib/proof-file-reader-child.ts'));try{for(const input of ['{',JSON.stringify({parts:[]}),JSON.stringify({parts:['..']}),JSON.stringify({parts:['a/b']}),JSON.stringify({parts:['a\\b']}),' '.repeat(8193)])assert.throws(()=>execFileSync(process.execPath,[child],{cwd:f.tree,stdio:['pipe','pipe','pipe',fd],input,encoding:'utf8',timeout:2000,maxBuffer:65536,env:{PATH:process.env.PATH}}));}finally{fs.closeSync(fd);}}));
test('proof file default async reader preserves event-loop progress and closes a timed-out own leaf',async t=>fixture(async f=>{
 const original=childProcess.spawn;let ownPid:number|undefined,progress=false;
 t.mock.method(childProcess,'spawn',((file:string,_args:readonly string[],options:SpawnOptions)=>{const own=original(file,['-e','setInterval(()=>{},1000)'],options);ownPid=own.pid;return own;}) as typeof childProcess.spawn);syncBuiltinESMExports();
 const progressTimer=setTimeout(()=>{progress=true;},20);
 try{assert.equal(await readProofFileInside(f.tree,f.target),undefined);assert.equal(progress,true);assert(ownPid);assert.throws(()=>process.kill(ownPid!,0),{code:'ESRCH'});}
 finally{clearTimeout(progressTimer);t.mock.restoreAll();syncBuiltinESMExports();}
}));
test('proof file default async reader refuses failed construction without leaving an open root descriptor',async t=>fixture(async f=>{
 const original=childProcess.spawn;let rootFd:number|undefined;
 t.mock.method(childProcess,'spawn',((_file:string,args:readonly string[],options:SpawnOptions)=>{rootFd=(options.stdio as Array<number|string>)[3] as number;return original(join(f.root,'missing-executable'),args,options);}) as typeof childProcess.spawn);syncBuiltinESMExports();
 try{assert.equal(await readProofFileInside(f.tree,f.target),undefined);assert(rootFd!==undefined);assert.throws(()=>fs.fstatSync(rootFd!));}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));
test('proof file default async reader bounds actual stdout and stderr before accepting bytes',async t=>fixture(async f=>{
 const original=childProcess.spawn;let script='',ownPid:number|undefined;
 t.mock.method(childProcess,'spawn',((file:string,_args:readonly string[],options:SpawnOptions)=>{const own=original(file,['-e',script],options);ownPid=own.pid;return own;}) as typeof childProcess.spawn);syncBuiltinESMExports();
 try{for(const stream of ['stdout','stderr']){script='process.'+stream+'.write(Buffer.alloc('+String(stream==='stdout'?PROOF_FILE_READ_BYTES+65536:131072)+'));setInterval(()=>{},1000)';assert.equal(await readProofFileInside(f.tree,f.target),undefined);assert(ownPid);assert.throws(()=>process.kill(ownPid!,0),{code:'ESRCH'});}}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));
test('proof source observations distinguish descriptor absence from denied root and escaping aliases',async()=>fixture(async f=>{
 assert.deepEqual(await observeProofFileInside(f.tree,f.target),{state:'read',text:'inside-positive\n'});
 for(const target of ['missing','missing-parent/leaf'])assert.equal((await observeProofFileInside(f.tree,target)).state,'absent');
 assert.equal((await observeProofFileInside(join(f.root,'missing-root'),f.target)).state,'unavailable');
 fs.symlinkSync(join(f.outside,'missing'),join(f.tree,'dangling-outside'));
 for(const target of ['a','dangling-outside','../outside/a/b/file.txt'])assert.equal((await observeProofFileInside(f.tree,target)).state,'unavailable');
}));
test('proof source absence requires exact child status empty stdout and the fixed stderr marker',async t=>fixture(async f=>{
 const original=childProcess.spawn;let script='';
 t.mock.method(childProcess,'spawn',((file:string,_args:readonly string[],options:SpawnOptions)=>original(file,['-e',script],options)) as typeof childProcess.spawn);syncBuiltinESMExports();
 try{for(const body of ['process.stderr.write("proof file absent\\n");process.exitCode=1','process.stderr.write("proof file absent\\n");process.stdout.write("not absence");process.exitCode=3','process.stderr.write("other failure\\n");process.exitCode=3','process.stderr.write("unexpected warning\\n");process.stdout.write("not qualified")']){script=body;assert.equal((await observeProofFileInside(f.tree,f.target)).state,'unavailable');}}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));
test('proof source bounded protocol refuses an oversized canonical request before a child is constructed',async t=>fixture(async f=>{
 const original=fs.realpathSync;let calls=0;
 t.mock.method(fs,'realpathSync',((path:fs.PathLike)=>String(path)===join(f.tree,f.target)?f.tree+'/'+'a'.repeat(8193):original(path)) as typeof fs.realpathSync);syncBuiltinESMExports();
 try{assert.equal((await observeProofFileInside(f.tree,f.target,()=>{calls++;return 'must not run'})).state,'unavailable');assert.equal(calls,0);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));
