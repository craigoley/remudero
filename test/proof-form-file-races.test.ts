import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';import {test} from 'node:test';
import {proofFormCorrection} from '#src/lib/review.js';
const target='plan/tasks.d/W1-T9991-race.yaml',needle='still needs a file-shaped artifact',proof=`grep: ${needle} in ${target}`;
function fixture(){const root=fs.mkdtempSync(join(tmpdir(),'rmd-proof-file-race-')),head=join(root,'head'),base=join(root,'base'),outside=join(root,'outside');for(const dir of [head,base,outside])fs.mkdirSync(dirname(join(dir,target)),{recursive:true});fs.writeFileSync(join(head,target),'no claimed literal here\n');fs.writeFileSync(join(outside,target),needle+'\n');return{root,head,base,outside};}
test('proof-form correction never credits an outside leaf substituted after its pathname check',async t=>{
 const f=fixture(),real={...fs};let replaced=false;const path=join(f.head,target);
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();real.rmSync(f.root,{recursive:true,force:true});});
 t.mock.method(fs,'statSync',((name:fs.PathLike,...args:unknown[])=>{const value=(real.statSync as (...args:unknown[])=>fs.Stats)(name,...args);if(String(name)===path&&!replaced){replaced=true;real.renameSync(path,path+'.held');real.symlinkSync(join(f.outside,target),path);}return value;}) as typeof fs.statSync);syncBuiltinESMExports();
 assert.equal(await proofFormCorrection(proof,{cwd:f.head,baseCwd:f.base}),undefined,'outside text must never manufacture a proof-form advisory');
});
test('proof-form correction never credits an outside ancestor substituted after canonical resolution',async t=>{
 const f=fixture(),real={...fs};let replaced=false;const path=join(f.head,target);
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();real.rmSync(f.root,{recursive:true,force:true});});
 t.mock.method(fs,'realpathSync',((name:fs.PathLike,...args:unknown[])=>{const value=(real.realpathSync as (...args:unknown[])=>string)(name,...args);if(String(name)===path&&!replaced){replaced=true;real.renameSync(join(f.head,'plan'),join(f.head,'plan-held'));real.symlinkSync(join(f.outside,'plan'),join(f.head,'plan'));}return value;}) as typeof fs.realpathSync);syncBuiltinESMExports();
 assert.equal(await proofFormCorrection(proof,{cwd:f.head,baseCwd:f.base}),undefined,'outside ancestry must never manufacture a proof-form advisory');
});
