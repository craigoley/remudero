import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { originWithClone } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

const record = (id: string, priority = 1, deps: string[] = []) => { const text = `- id: ${id}\n  title: migration fixture\n  repo: remudero\n  type: implement\n  priority: ${priority}\n  depends_on: ${JSON.stringify(deps)}\n`; assert.equal(parseTasksFromYaml(text,"fixture")[0]!.id,id); return text; };
function fixture(t: TestContext, records: Record<string, string> = {"W1-T1.yaml": record("W1-T1")}, opsText = "[]\n") {
  const root = ownedFixtureDir(t, "migration-preview").dir;
  const seed = {"plan/tasks.yaml": "[]\n", ...Object.fromEntries(Object.entries(records).map(([p,s]) => ["plan/tasks.d/"+p,s]))};
  const pub = originWithClone(join(root,"public"), {scope:t,seed});
  const ops = originWithClone(join(root,"ops"), {scope:t,seed:{"plan/tasks.yaml":opsText}});
  const pubCommit=pub.clone.git("rev-parse","HEAD"), opsCommit=ops.clone.git("rev-parse","HEAD");
  const closed = {number:1,state:"MERGED",body:"Remudero-Task: W1-T999",headRefName:"run-W1-T999-1",mergeCommit:{oid:pubCommit},repository:{databaseId:42,nameWithOwner:"fixture/remudero"}};
  const page=(nodes: unknown[])=>({totalCount:nodes.length,pageInfo:{hasNextPage:false,endCursor:null},nodes});
  const publicAnswer={databaseId:42,nameWithOwner:"fixture/remudero",defaultBranchRef:{name:"main",target:{oid:pubCommit}},open:page([]),merged:page([closed])};
  const opsAnswer={databaseId:43,nameWithOwner:"fixture/ops",defaultBranchRef:{name:"main",target:{oid:opsCommit}}};
  const credit={byTrailer:[] as unknown[],byBranch:[] as unknown[],control:publicAnswer.merged.nodes as unknown[]};
  const search=(nodes:unknown[])=>({issueCount:nodes.length,pageInfo:{hasNextPage:false},nodes});
  const response=join(root,"answer.json");
  const save=()=>writeFileSync(response,JSON.stringify({data:{public:publicAnswer,ops:opsAnswer,byTrailer:search(credit.byTrailer),byBranch:search(credit.byBranch),control:search(credit.control)}})); save();
  const shim=ghShim([{when:"api graphql",stdoutFile:response},{when:"",exit:97,stderr:"forbidden GitHub effect"}]);
  t.after(()=>rmSync(shim.dir,{recursive:true,force:true}));
  const home=join(root,"home");mkdirSync(home);
  let invocation=0;
  const run=(extra:string[]=[])=>{
    const cache=join(home,`github-fixture-${++invocation}`);mkdirSync(cache);
    save();
    const child=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),join(REPO_ROOT,"src/run-task.ts"),"migration-preview","--public-root",pub.clone.dir,"--public-commit",pubCommit,"--public-repo","fixture/remudero","--ops-root",ops.clone.dir,"--ops-commit",opsCommit,"--ops-repo","fixture/ops",...extra],{
      cwd:pub.clone.dir,encoding:"utf8",timeout:30_000,env:{PATH:`${shim.dir}:${process.env.PATH}`,HOME:home,RMD_GH_CACHE_HOME:cache,TMPDIR:tmpdir(),NODE_TEST_CONTEXT:process.env.NODE_TEST_CONTEXT,LANG:"C",GIT_ALLOW_PROTOCOL:"file",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null",RMD_SELF_SYNC_DONE:"1",GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:`url.${pub.origin.dir}.insteadOf`,GIT_CONFIG_VALUE_0:"https://github.com/fixture/remudero.git",GIT_CONFIG_KEY_1:`url.${ops.origin.dir}.insteadOf`,GIT_CONFIG_VALUE_1:"https://github.com/fixture/ops.git",
      ...(process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{}),...(process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{})}});
    assert.equal(child.error,undefined);
    let answer: any;try{answer=JSON.parse(child.stdout.trim());}catch{assert.fail(`actual CLI did not return a preview: ${child.status} ${child.stdout} ${child.stderr}`);}
    return {status:child.status,answer,stderr:child.stderr};
  };
  return {credit,pub,ops,pubCommit,opsCommit,run,publicAnswer,opsAnswer,shim,page,closed,records,root};
}

test("migration preview retains exact YAML bytes and refuses duplicate moved or malformed records", t => {
  const text=record("W1-T1").replace("migration fixture","café fixture").replaceAll("\n","\r\n")+"# preserved trailing comment\r\n";
  const f=fixture(t,{"W1-T1.yaml":text}); const r=f.run();
  assert.equal(r.status,0); assert.equal(r.answer.candidate.sourcePath,"plan/tasks.d/W1-T1.yaml");
  assert.equal(r.answer.candidate.sourceCommit,f.pubCommit); assert.equal(r.answer.candidate.yaml,text);
  assert.equal(Buffer.from(r.answer.candidate.originalBytesBase64,"base64").toString(),text);
  assert.equal(r.answer.candidate.prospectiveMovedFrom,`remudero@${f.pubCommit}`);
  const duplicate=fixture(t,undefined,record("W1-T1")); assert.equal(duplicate.run().answer.outcome,"unknown");
  const malformed=fixture(t,{"W1-T1.yaml":"not: [valid"}); assert.equal(malformed.run().answer.outcome,"unknown");
  const moved=fixture(t,{"W1-T1.yaml":record("W1-T1")+"  moved_from: remudero@"+"a".repeat(40)+"\n"}); assert.equal(moved.run().answer.outcome,"none");
});
