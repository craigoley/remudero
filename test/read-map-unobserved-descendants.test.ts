import assert from 'node:assert/strict';
import child, {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {buildReadMap,readMapProblem,selectAffectedSuites} from '../src/lib/affected-suites.js';
import {installReadMap,installReadMapFromEnv} from './setup/read-map.js';

const suite='test/descendant-fixture.test.ts';
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'rmd-read-child-'));writeFileSync(join(root,'child-only.json'),'owned child bytes');return root;};
const args=(root:string)=>['-e','process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))',join(root,'child-only.json')];
test('unobserved descendant reads force UNKNOWN and full-run fallback rather than a trusted empty map',async()=>{
 const root=fixture(),original=child.execFileSync,map=await installReadMap({root,suite,dir:join(root,'records')});
 try{
  assert.equal(execFileSync(process.execPath,args(root),{encoding:'utf8',env:{PATH:process.env.PATH}}),'owned child bytes');
  const record=map.recorder.snapshot();assert.equal(record.unknownDescriptors,true);assert(!record.reads.includes('child-only.json'),'the parent did not observe this child read');
  const readMap={map:buildReadMap([record],{sha:'a'.repeat(40)}),drift:{distance:0,changedSinceMap:[]}};
  assert.match(readMapProblem(readMap)!,/coverage is incomplete/);
  assert.equal(selectAffectedSuites(['child-only.json'],{files:new Map([[suite,'export {};']]),pathReaders:[],readMap}).fullRun,true);
 }finally{map.restore();assert.equal(child.execFileSync,original);rmSync(root,{recursive:true});}
});
test('descendant observation preserves real promisified execFile output and custom function properties',async()=>{
 const root=fixture(),original=child.execFile,custom=Object.getOwnPropertyDescriptor(original,promisify.custom)!.value as Function,map=await installReadMap({root,suite,dir:join(root,'records')});
 try{const patched=Object.getOwnPropertyDescriptor(child.execFile,promisify.custom)!.value as Function;assert.equal(patched.name,custom.name);const result=await promisify(child.execFile)(process.execPath,args(root),{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(result.stdout,'owned child bytes');assert.equal(result.stderr,'');assert.equal(map.recorder.snapshot().unknownDescriptors,true);}
 finally{map.restore();assert.equal(child.execFile,original);rmSync(root,{recursive:true});}
});
test('a refused child launch remains UNKNOWN and preserves the original spawn error',async()=>{
 const root=fixture(),map=await installReadMap({root,suite,dir:join(root,'records')});
 try{assert.throws(()=>child.execFileSync(join(root,'does-not-exist'),[],{env:{}}),{code:'ENOENT'});assert.equal(map.recorder.snapshot().unknownDescriptors,true);}
 finally{map.restore();rmSync(root,{recursive:true});}
});
test('read-map child observation stays default-off and a fake fs seam never patches real child APIs',async()=>{
 const root=fixture(),original=child.spawnSync;
 try{assert.equal(await installReadMapFromEnv({},join(root,suite)),undefined);assert.equal(child.spawnSync,original);const map=await installReadMap({root,suite,dir:join(root,'records'),target:{promises:{}}});try{assert.equal(child.spawnSync,original);assert.equal(map.recorder.snapshot().unknownDescriptors,false);}finally{map.restore();}}
 finally{assert.equal(child.spawnSync,original);rmSync(root,{recursive:true});}
});
test('all public child launch APIs are conservatively marked and restored without changing their properties',async()=>{
 const names=['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'] as const;
 const root=fixture(),originals=names.map(name=>child[name]),map=await installReadMap({root,suite,dir:join(root,'records')});
 try{for(let i=0;i<names.length;i++){const fn=child[names[i]],original=originals[i];assert.notEqual(fn,original,names[i]);for(const key of Reflect.ownKeys(original)){const a=Object.getOwnPropertyDescriptor(fn,key)!,b=Object.getOwnPropertyDescriptor(original,key)!;if(key===promisify.custom&&typeof b.value==='function'){assert.deepEqual({...a,value:null},{...b,value:null});assert.equal(a.value.name,b.value.name);assert.equal(a.value.length,b.value.length);}else assert.deepEqual(a,b);}}assert.deepEqual(fs.readFileSync(join(root,'child-only.json'),'utf8'),'owned child bytes');assert.equal(map.recorder.snapshot().unknownDescriptors,false);}
 finally{map.restore();for(let i=0;i<names.length;i++)assert.equal(child[names[i]],originals[i]);rmSync(root,{recursive:true});}
});
