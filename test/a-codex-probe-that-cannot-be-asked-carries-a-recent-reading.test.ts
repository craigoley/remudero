import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {spawnSync} from "node:child_process";
import fs, {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import test from "node:test";
import type {Config} from "#src/lib/config.js";
import {clearCodexCapacityCache, readCodexCapacity} from "#src/lib/worker-provider.js";

const START = Date.parse("2026-10-17T12:00:00.000Z");
const MODELS = [{id:"gpt-6.1-sol",displayName:"Sol",isDefault:true,defaultReasoningEffort:"medium",
  supportedReasoningEfforts:[{reasoningEffort:"medium"}]}];
type Mode = "ok" | "timeout" | "rpc" | "malformed" | "empty";
function fixture(t: test.TestContext) {
  clearCodexCapacityCache();
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-last-good-"));
  const cfg: Config = {root,claudeBin:"/unused",workerProviders:{enabled:["codex"],codexBin:"/bin/sh",codexHome:join(root,"codex"),capacityCacheMs:1}};
  const state = {now:START, used:20, mode:"ok" as Mode, spawns:0, duration:120 as number | undefined,
    reset:Math.floor((START+60*60_000)/1000), quotaExtras:{} as Record<string,unknown>, models:structuredClone(MODELS), byLimitId:false};
  const spawn = () => {
    state.spawns++;
    const stdin=new PassThrough(), stdout=new PassThrough(), stderr=new PassThrough();
    const proc=Object.assign(new EventEmitter(),{stdin,stdout,stderr,kill:()=>true});
    stdin.on("data",chunk=>{
      for(const line of String(chunk).trim().split("\n")) {
        const request=JSON.parse(line);
        if(state.mode==="timeout") continue;
        if(request.id===1) stdout.write(JSON.stringify({id:1,result:{}})+"\n");
        if(request.id===2) {
          if(state.mode==="rpc") stdout.write(JSON.stringify({id:2,error:{message:"fixture RPC refused"}})+"\n");
          else if(state.mode==="malformed") stdout.write("not-json\n");
          else if(state.mode==="empty") stdout.write(JSON.stringify({id:2,result:null})+"\n");
          else {
            const bucket={limitId:"codex",primary:{usedPercent:state.used,windowDurationMins:state.duration,resetsAt:state.reset,...state.quotaExtras}};
            stdout.write(JSON.stringify({id:2,result:{rateLimits:bucket,
              ...(state.byLimitId?{rateLimitsByLimitId:{codex:bucket}}:{})}})+"\n");
          }
        }
        if(request.id===3) stdout.write(JSON.stringify({id:3,result:{data:state.models,nextCursor:null}})+"\n");
      }
    });
    return proc as never;
  };
  const read = (forceRefresh=false) => readCodexCapacity(cfg,{spawn,now:()=>state.now,timeoutMs:10,
    requestedModel:"sonnet",requestedEffort:"medium",reservePercent:5,forceRefresh});
  const fail = () => {state.now+=61_000;state.mode="timeout";};
  t.after(()=>{clearCodexCapacityCache();rmSync(root,{recursive:true,force:true});});
  return {cfg,state,read,fail,path:join(root,"state","codex-capacity-last-good.json")};
}

test("W1-T10037: an initialize timeout carries a recent healthy reading forward",async t=>{
  const f=fixture(t);
  assert.equal((await f.read()).readable,true);
  f.fail();
  const read=await f.read();
  assert.equal(read.readable,true);
  assert.equal(read.model,"gpt-6.1-sol");
  assert.ok(read.windows[0].usedPercent>20);
  assert.ok(read.windows[0].usedPercent<21);
  assert.equal(read.carriedForward?.readAt,START);
  assert.equal(read.carriedForward?.ageMs,61_000);
  assert.match(read.detail??"",/carried forward.*timed out/);
  f.state.now+=1_000;
  const backedOff=await f.read();
  assert.equal(backedOff.readable,true);
  assert.ok(backedOff.windows[0].usedPercent>read.windows[0].usedPercent,"backoff reprojects rather than freezing headroom");
});

test("W1-T10037: a reading whose projected burn crosses the reserve stays unreadable",async t=>{
  for(const shape of ["reserve","reset","no-duration"] as const) {
    const f=fixture(t);
    if(shape==="reserve")f.state.used=90;
    if(shape==="no-duration")f.state.duration=undefined;
    assert.equal((await f.read()).readable,true);
    f.fail();
    f.state.now=shape==="reserve"?START+4*60_000:shape==="reset"?START+60*60_000:f.state.now;
    const read=await f.read();
    assert.equal(read.readable,false);
    assert.equal(read.carriedForward,undefined);
  }
});

test("W1-T10037: an RPC error or a forced refresh never carries a reading forward",async t=>{
  for(const mode of ["rpc","malformed","timeout"] as const) {
    const f=fixture(t);await f.read();f.fail();f.state.mode=mode;
    const read=await f.read(mode==="timeout");
    assert.equal(read.readable,false);
    assert.equal(read.carriedForward,undefined);
  }
});

test("W1-T10037: a reading stored by one process is carried by another",async t=>{
  const f=fixture(t);await f.read();
  const stored=readFileSync(f.path,"utf8");
  assert.ok(stored.includes("gpt-6.1-sol"));
  assert.doesNotMatch(stored,/access_token|refresh_token|Authorization/);
  clearCodexCapacityCache();f.fail();
  const script = `import{EventEmitter}from"node:events";import{PassThrough}from"node:stream";
    import{readCodexCapacity}from"#src/lib/worker-provider.js";
    const spawn=()=>Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
    const read=await readCodexCapacity(${JSON.stringify(f.cfg)},{spawn,now:()=>${f.state.now},timeoutMs:10,requestedModel:"sonnet",requestedEffort:"medium"});
    console.log(JSON.stringify({readable:read.readable,carriedForward:read.carriedForward}));`;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],
    {cwd:process.cwd(),encoding:"utf8",env:{...process.env,NODE_V8_COVERAGE:"",NODE_TEST_CONTEXT:undefined}});
  assert.equal(child.status,0,child.stderr);
  const read=JSON.parse(child.stdout);
  assert.equal(read.readable,true);
  assert.equal(read.carriedForward.readAt,START);
  assert.equal(readFileSync(f.path,"utf8"),stored,"a carry is never saved as a fresh reading");
});

test("a newer stored reading survives a late older success and stored windows omit foreign fields",async t=>{
  const f=fixture(t);f.state.quotaExtras={access_token:"fixture-only-must-not-persist"};await f.read();
  const stored=readFileSync(f.path,"utf8");
  assert.doesNotMatch(stored,/fixture-only-must-not-persist|access_token/);
  clearCodexCapacityCache();f.state.now=START-1;await f.read();
  assert.equal(readFileSync(f.path,"utf8"),stored);
});

test("a recent measured acceleration dominates the window-average burn",async t=>{
  const f=fixture(t);await f.read();f.state.now+=60_000;f.state.used=30;await f.read();
  f.fail();f.state.now+=6*60_000;
  assert.equal((await f.read()).readable,false,"the 10-percent-per-minute delta reaches reserve before the average");
});

test("a definite RPC refusal cannot be revived by a later initialize timeout",async t=>{
  const f=fixture(t);await f.read();f.fail();f.state.mode="rpc";
  assert.equal((await f.read()).readable,false);
  const invalidated=readFileSync(f.path,"utf8");
  clearCodexCapacityCache();f.state.now=START;f.state.mode="ok";await f.read();
  assert.equal(readFileSync(f.path,"utf8"),invalidated,"an older late success cannot erase newer terminal evidence");
  clearCodexCapacityCache();f.fail();
  assert.equal((await f.read()).readable,false,"known terminal evidence must survive a new process's timeout");
});

test("a different Codex identity corrupt store and backwards clock never revive quota",async t=>{
  for(const shape of ["home","bin","corrupt","future","missing"] as const) {
    const f=fixture(t);await f.read();clearCodexCapacityCache();f.fail();
    if(shape==="home")f.cfg.workerProviders!.codexHome+="-other";
    if(shape==="bin")f.cfg.workerProviders!.codexBin="/bin/bash";
    if(shape==="corrupt")writeFileSync(f.path,"{broken");
    if(shape==="future")f.state.now=START-1;
    if(shape==="missing")rmSync(f.path);
    assert.equal((await f.read()).readable,false,shape);
  }
});

test("a fresh measured read stays measured when real persistence fails",async t=>{
  const f=fixture(t);
  writeFileSync(join(f.cfg.root,"state"),"not a directory");
  const read=await f.read();
  assert.equal(read.readable,true);
  assert.match(read.detail??"",/persistence unavailable/);
  f.fail();
  assert.equal((await f.read()).readable,false);
});

test("a null quota answer stays unreadable instead of throwing from persistence",async t=>{
  const f=fixture(t);f.state.mode="empty";
  const read=await f.read();
  assert.equal(read.readable,false);
  assert.equal(read.carriedForward,undefined);
  assert.match(read.detail??"",/persistence unavailable/);
});

test("empty oversized and invalid last-good records are explicit unavailable evidence",async t=>{
  const f=fixture(t);await f.read();const original=JSON.parse(readFileSync(f.path,"utf8"));
  for(const text of ["","x".repeat(2*1024*1024+1),"null",JSON.stringify({...original,version:2}),
    JSON.stringify({...original,current:{readAt:"unknown",value:original.current.value}}),
    JSON.stringify({...original,previous:{readAt:1,value:{models:[],rateLimits:{}}}})]) {
    clearCodexCapacityCache();writeFileSync(f.path,text);f.fail();
    const read=await f.read();
    assert.equal(read.readable,false);
    assert.match(read.detail??"",/last-good unavailable/);
  }
  f.state.mode="ok";f.state.models[0].displayName="x".repeat(2*1024*1024);
  rmSync(f.path);clearCodexCapacityCache();
  assert.match((await f.read()).detail??"",/persistence unavailable.*byte bound/);
  assert.equal(existsSync(f.path),false);
});

test("a file growing during its real bounded read cannot become carried capacity",async t=>{
  const f=fixture(t);await f.read();f.fail();
  const real=fs.readSync;let changed=false;
  const patch=t.mock.method(fs,"readSync",function(...args: Parameters<typeof fs.readSync>) {
    const result=Reflect.apply(real,fs,args);
    if(!changed){changed=true;fs.appendFileSync(f.path,"x");}
    return result;
  });
  syncBuiltinESMExports();
  try {assert.match((await f.read()).detail??"",/changed while reading/);}
  finally {patch.mock.restore();syncBuiltinESMExports();}
});

test("a concurrent telemetry publisher wins over this default atomic stage",async t=>{
  const f=fixture(t);await f.read();const peer=JSON.parse(readFileSync(f.path,"utf8"));
  peer.current.readAt+=120_000;
  const published=JSON.stringify(peer), real=fs.openSync;let opens=0;
  const patch=t.mock.method(fs,"openSync",function(...args: Parameters<typeof fs.openSync>) {
    if(String(args[0])===f.path&&++opens===2)fs.writeFileSync(f.path,published);
    return Reflect.apply(real,fs,args);
  });
  syncBuiltinESMExports();f.state.now+=60_000;
  try {
    assert.match((await f.read()).detail??"",/stood aside for a concurrent reading/);
    assert.equal(readFileSync(f.path,"utf8"),published);
  } finally {patch.mock.restore();syncBuiltinESMExports();}
});

test("projection keeps real independent buckets and refuses unreadable quota or invisible models",async t=>{
  const zero=fixture(t);zero.state.byLimitId=true;zero.state.used=0;zero.state.reset+=60*60;
  await zero.read();zero.fail();assert.equal((await zero.read()).readable,true);
  const invalid=fixture(t);await invalid.read();const raw=JSON.parse(readFileSync(invalid.path,"utf8"));
  raw.current.value.rateLimits.rateLimits.primary.usedPercent="unknown";
  writeFileSync(invalid.path,JSON.stringify(raw));invalid.fail();
  assert.match((await invalid.read()).detail??"",/unreadable quota window/);
  const hidden=fixture(t);await hidden.read();hidden.cfg.workerProviders!.codexModel="not-a-visible-model";hidden.fail();
  assert.match((await hidden.read()).detail??"",/last-good unavailable/);
});
