import assert from "node:assert/strict";
import { test } from "node:test";
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { fixedClock } from "#src/lib/clock.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { mergePlanBlobs } from "#src/lib/plan.js";

async function observed(stages: unknown[], enabled=true, stop=false){
  const clock=fixedClock(Date.parse("2026-01-01T00:00:00Z"));
  const plan=mergePlanBlobs([{label:"fixture",text:[1,2,3].map(n=>`- id: PUBLIC-T${n}\n  title: public fixture\n  repo: remudero\n  type: implement\n`).join("")}]);
  const merged=new Set<string>(),ran:string[]=[],rows:Array<{step:string;data:Record<string,unknown>}>=[];let completed=0;
  const deps:DaemonDeps={
    refreshMerged:()=>id=>merged.has(id),targetRepo:"remudero",
    runOne:async id=>{ran.push(id);merged.add(id);completed++;return {taskId:id,runId:id,merged:true,costUsd:0,verdict:"merged"};},
    checkPause:()=>undefined,checkStop:()=>stop?"operator STOP":undefined,
    sleep:async()=>{},now:clock.date,bootCheckoutBlocked:"",
    memoryGovernor:createDaemonMemoryGovernor({read:()=>({rss_bytes:1}),heapUsed:()=>1,setFlags:()=>{}}),
    heapStatistics:()=>({used_heap_size:1,heap_size_limit:1_000_000_000}),
    log:(step,data={})=>{rows.push({step,data});},
    readOpsTaskDispatch:()=>enabled?({outcome:"unavailable",reason:"malformed",source:{outcome:"malformed",refusalStage:stages[Math.min(completed,stages.length-1)]}} as OpsTaskDispatchRead):{outcome:"off"},
  };
  const result=await runDaemon(plan,deps,{max:3,laneCount:1});return {ran,result,held:rows.filter(r=>r.step==="dispatch.ops_catalog_held").map(r=>r.data)};
}

test("W13319: changed safe stages produce bounded held observations and preserve public effects",async()=>{
  const baseline=await observed([undefined]),actual=await observed(["root_tree","root_tree","strict_parse"]);
  assert.deepEqual(actual.ran,baseline.ran);assert.equal(actual.ran.length,3,"healthy public dispatch positive control");
  assert.deepEqual(actual.result.attempted,baseline.result.attempted);assert.deepEqual(actual.result.merged,baseline.result.merged);
  assert.deepEqual(actual.held.map(r=>r.refusal_stage),["root_tree","strict_parse"]);
  assert.ok(actual.held.every(r=>r.outcome==="malformed"));assert.equal(baseline.held.length,1,"same outcome without stage stays deduplicated");
  const hostile=await observed(["PRIVATE_PATH_AND_TOKEN_SENTINEL",{private:"PRIVATE_PATH_AND_TOKEN_SENTINEL"}]);assert.equal(hostile.held.length,1);assert.doesNotMatch(JSON.stringify(hostile.held),/PRIVATE_PATH_AND_TOKEN_SENTINEL/);
  const off=await observed(["strict_parse"],false);assert.deepEqual(off.ran,baseline.ran);assert.deepEqual(off.held,[]);
  const stopped=await observed(["strict_parse"],true,true);assert.deepEqual(stopped.ran,[],"owner STOP remains authoritative");
});
