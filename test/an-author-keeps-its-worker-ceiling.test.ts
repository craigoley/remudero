import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { acquireTestSlot, TEST_SLOT_DIR_ENV } from "../src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { makeRuntimeFixture } from "./helpers/native-runtime-fixture.js";
const { main } = await import(new URL("../scripts/preflight-author.mjs", import.meta.url).href) as {
  main: (argv: string[], deps: { root: string; select: () => { fullRun: boolean; suites: string[]; reasons: string[] } }) => number;
};

test("an explicit test-worker ceiling lowers a real lease and native descendants without widening slots", t => {
  const dir=mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}serial-ceiling-`));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const capacity={dir,slots:1,load:()=>({cores:32,load1:0}),perFileBytes:512*1024**2,
    memoryHeadroom:()=>32*1024**3,log:()=>{}};
  const uncapped=acquireTestSlot("positive capacity control",capacity);
  assert.ok(uncapped.concurrency>1);uncapped.release();
  const lease=acquireTestSlot("explicit serial owner",{...capacity,maxConcurrency:1});
  t.after(()=>lease.release());assert.equal(lease.outcome,"acquired");assert.equal(lease.concurrency,1);
  const claim=JSON.parse(lease.childEnvironment!.RMD_TEST_SLOT_PARENT!);
  const before=readFileSync(claim.path,"utf8");const held=JSON.parse(before);
  assert.equal(held.concurrency,1);assert.equal(held.memoryBytes,512*1024**2);
  const module=new URL("../src/lib/test-slot.ts",import.meta.url).href;
  const code=`import {acquireTestSlot} from ${JSON.stringify(module)};
    const l=acquireTestSlot("real native descendant",{maxConcurrency:1,waitBoundMs:0});
    process.stdout.write(JSON.stringify({concurrency:l.concurrency,note:l.note}));l.release();`;
  const child=JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{
    cwd:process.cwd(),encoding:"utf8",timeout:15000,
    env:{...process.env,...lease.childEnvironment,[TEST_SLOT_DIR_ENV]:dir,NODE_TEST_CONTEXT:undefined}}));
  assert.equal(child.concurrency,1);assert.match(child.note,/inherited live parent test slot/);
  assert.equal(readFileSync(claim.path,"utf8"),before);
});

test("a worker ceiling refuses invalid input and a wider inherited owner without editing its record",t=>{
  const dir=mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}serial-refusal-`));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const maxConcurrency of [0,-1,1.5,NaN,Infinity])
    assert.throws(()=>acquireTestSlot("invalid ceiling",{dir,maxConcurrency}),/positive safe integer/);
  const owner=acquireTestSlot("wide positive control",{dir,slots:1,load:()=>({cores:8,load1:0}),log:()=>{}});
  t.after(()=>owner.release());assert.ok(owner.concurrency>1);
  const claim=JSON.parse(owner.childEnvironment!.RMD_TEST_SLOT_PARENT!);const bytes=readFileSync(claim.path,"utf8");
  const module=new URL("../src/lib/test-slot.ts",import.meta.url).href;
  const code=`import {acquireTestSlot} from ${JSON.stringify(module)};
    try{acquireTestSlot("refuse wider ancestor",{maxConcurrency:1});throw Error("accepted wider ancestor");}
    catch(e){process.stdout.write(JSON.stringify({message:e.message}));}`;
  const result=JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{
    cwd:process.cwd(),encoding:"utf8",timeout:15000,
    env:{...process.env,...owner.childEnvironment,[TEST_SLOT_DIR_ENV]:dir,NODE_TEST_CONTEXT:undefined}}));
  assert.match(result.message,/inherited test slot exceeds explicit worker ceiling/);
  assert.equal(readFileSync(claim.path,"utf8"),bytes);
});

test("a worker ceiling cannot raise CPU or memory capacity and survives a real unavailable slot directory",t=>{
  const dir=mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}serial-fallback-`));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const one=acquireTestSlot("memory cap preserved",{dir,slots:1,maxConcurrency:99,
    load:()=>({cores:8,load1:0}),perFileBytes:512*1024**2,memoryHeadroom:()=>512*1024**2,log:()=>{}});
  assert.equal(one.concurrency,1);one.release();
  const blocked=join(dir,"not-a-directory");writeFileSync(blocked,"fixture");
  const fallback=acquireTestSlot("real path refusal",{dir:blocked,maxConcurrency:1,slots:1,
    load:()=>({cores:32,load1:0}),log:()=>{}});
  assert.equal(fallback.outcome,"slot_unavailable");assert.equal(fallback.concurrency,1);fallback.release();
});

test("the shipped author acquires one real worker before static and native execution",t=>{
  const f=makeRuntimeFixture();t.after(()=>f.cleanup());
  for(const name of ["a","b"])writeFileSync(join(f.dir,`test/${name}.test.ts`),
    'import assert from "node:assert/strict";import{test}from"node:test";'+
    'test("actual serial child",()=>{assert.ok(process.execArgv.includes("--test-concurrency=1"),JSON.stringify(process.execArgv));});\n');
  f.git("add","test");f.git("commit","-m","test: observe real serial author children");
  const prior=process.env[TEST_SLOT_DIR_ENV];process.env[TEST_SLOT_DIR_ENV]=join(f.dir,"slots");
  try{
    assert.equal(main([],{root:f.dir,select:()=>({fullRun:false,suites:["test/a.test.ts","test/b.test.ts"],reasons:["real serial fixture"]})}),0);
    const r=JSON.parse(readFileSync(join(f.dir,"coverage/preflight-author.json"),"utf8"));
    assert.equal(r.verdict,"passed");assert.equal(r.testSlot.concurrency,1);
    assert.equal(r.steps.at(-1).testSummary.fail,0);
  }finally{if(prior===undefined)delete process.env[TEST_SLOT_DIR_ENV];else process.env[TEST_SLOT_DIR_ENV]=prior;}
});

test("a serial author refuses a wider real ancestor before any static or native work",t=>{
  const f=makeRuntimeFixture();t.after(()=>f.cleanup());
  // A bad author can reach only this failing static marker. No negative control
  // ever starts a parallel native pool, regardless of the inherited width.
  writeFileSync(join(f.dir,"src/run-task.ts"),
    'import{writeFileSync}from"node:fs";writeFileSync("coverage/static-started","bad admission");process.exit(1);\n');
  f.git("add","src/run-task.ts");f.git("commit","-m","test: stop bad inherited admission before native work");
  const dir=mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}wide-author-parent-`));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const owner=acquireTestSlot("deterministic wider real ancestor",{dir,slots:1,
    load:()=>({cores:32,load1:0}),log:()=>{}});
  t.after(()=>owner.release());assert.ok(owner.concurrency>1);
  const claim=JSON.parse(owner.childEnvironment!.RMD_TEST_SLOT_PARENT!);const held=readFileSync(claim.path,"utf8");
  const module=new URL("../scripts/preflight-author.mjs",import.meta.url).href;
  const code=`import {main} from ${JSON.stringify(module)};import fs from "node:fs";
    const root=${JSON.stringify(f.dir)};
    const code=main([],{root,select:()=>({fullRun:false,suites:["test/a.test.ts"],reasons:["real wider-parent refusal"]})});
    const receipt=JSON.parse(fs.readFileSync(root+"/coverage/preflight-author.json","utf8"));
    console.log("SERIAL_WITNESS="+JSON.stringify({code,verdict:receipt.verdict,error:receipt.error,
      steps:receipt.steps.map(s=>s.name),staticStarted:fs.existsSync(root+"/coverage/static-started")}));`;
  const output=execFileSync(process.execPath,["--enable-source-maps","--import","tsx","--input-type=module","-e",code],{
    cwd:process.cwd(),encoding:"utf8",timeout:30000,
    env:{...process.env,...owner.childEnvironment,[TEST_SLOT_DIR_ENV]:dir,NODE_TEST_CONTEXT:undefined}});
  const line=output.split("\n").find(l=>l.startsWith("SERIAL_WITNESS="));assert.ok(line,output);
  const result=JSON.parse(line.slice("SERIAL_WITNESS=".length));assert.equal(result.code,1);
  assert.equal(result.verdict,"refused",JSON.stringify(result));
  assert.match(result.error,/inherited test slot exceeds explicit worker ceiling/);
  assert.equal(result.staticStarted,false);assert.deepEqual(result.steps,["census-precheck"]);
  assert.equal(readFileSync(claim.path,"utf8"),held);
});


test("an explicit ceiling also limits an ordinary unprofiled lease", t => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}unprofiled-ceiling-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capacity = { dir, slots: 1, load: () => ({ cores: 32, load1: 0 }), log: () => {} };
  const wide = acquireTestSlot("unprofiled positive capacity control", capacity);
  try { assert.ok(wide.concurrency > 1); } finally { wide.release(); }
  const one = acquireTestSlot("unprofiled explicit ceiling", { ...capacity, maxConcurrency: 1 });
  try {
    assert.equal(one.outcome, "acquired");
    assert.equal(one.concurrency, 1);
    const claim = JSON.parse(one.childEnvironment!.RMD_TEST_SLOT_PARENT!);
    assert.equal(JSON.parse(readFileSync(claim.path, "utf8")).concurrency, 1);
  } finally { one.release(); }
  const cpu = acquireTestSlot("unprofiled CPU capacity stays lower", {
    ...capacity, maxConcurrency: 99, load: () => ({ cores: 2, load1: 0 }),
  });
  try { assert.equal(cpu.concurrency, 1); } finally { cpu.release(); }
});
