import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

const record = (id: string, priority = 1, deps: string[] = []) => { const text = `- id: ${id}\n  title: migration fixture\n  repo: remudero\n  type: implement\n  priority: ${priority}\n  depends_on: ${JSON.stringify(deps)}\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: the fixture holds\n      proof: \"grep: fixture in test/fixture.test.ts\"\n`; assert.equal(parseTasksFromYaml(text,"fixture")[0]!.id,id); return text; };
function fixture(t: TestContext, records: Record<string, string> = {"W1-T1.yaml": record("W1-T1")}, opsText = "[]\n") {
  const root = ownedFixtureDir(t, "migration-preview").dir;
  const seed = {"plan/tasks.yaml": "[]\n", ...Object.fromEntries(Object.entries(records).map(([p,s]) => ["plan/tasks.d/"+p,s]))};
  const pub = originWithClone(join(root,"public"), {scope:t,seed});
  // W1-T13680: a movable task holds its public reservation; seed one per fixture record.
  for (const text of Object.values(records)) for (const m of text.matchAll(/^- id: (\S+)/gm)) pub.origin.git("update-ref",`refs/rmd-id/${m[1]}`,"main");
  const ops = originWithClone(join(root,"ops"), {scope:t,seed:{"plan/tasks.yaml":opsText}});
  const pubCommit=pub.clone.git("rev-parse","HEAD"), opsCommit=ops.clone.git("rev-parse","HEAD");
  const closed = {number:1,state:"MERGED",body:"Remudero-Task: W1-T999",headRefName:"run-W1-T999-1",mergeCommit:{oid:pubCommit},repository:{databaseId:42,nameWithOwner:"fixture/remudero"}};
  const page=(nodes: unknown[])=>({totalCount:nodes.length,pageInfo:{hasNextPage:false,endCursor:null},nodes});
  const publicAnswer={databaseId:42,nameWithOwner:"fixture/remudero",defaultBranchRef:{name:"main",target:{oid:pubCommit}},open:page([]),merged:page([closed])};
  const opsAnswer={databaseId:43,nameWithOwner:"fixture/ops",defaultBranchRef:{name:"main",target:{oid:opsCommit}}};
  const credit={byTrailer:[] as unknown[],byBranch:[] as unknown[],control:publicAnswer.merged.nodes as unknown[]};
  const search=(nodes:unknown[])=>({issueCount:nodes.length,pageInfo:{hasNextPage:false},nodes});
  const response=join(root,"answer.json");
  const save=()=>writeFileSync(response,JSON.stringify({data:{public:publicAnswer,ops:opsAnswer,byTrailer:search(credit.byTrailer),byBranch:search(credit.byBranch),control:search(credit.control),refusedMoves:search([])}})); save();
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

test("migration preview requires current complete ownership and pinned catalog controls", t => {
  const f=fixture(t); const id="W1-T1";
  f.pub.clone.git("push","origin",`HEAD:refs/rmd-dispatch/${id}`);
  { const r=f.run();assert.equal(r.answer.outcome,"none",JSON.stringify(r)); }
  f.pub.clone.git("push","origin",`HEAD:refs/heads/run-${id}-1`);
  f.pub.clone.git("push","origin",`:refs/rmd-dispatch/${id}`);
  { const r=f.run();assert.equal(r.answer.outcome,"none",JSON.stringify(r)); }
  f.pub.clone.git("push","origin",`:refs/heads/run-${id}-1`);
  f.publicAnswer.open.nodes.push({number:2,state:"OPEN",headRefName:"operator-fix",headRefOid:f.pubCommit,body:"",files:f.page([{path:"plan/tasks.d/W1-T1.yaml"}])} as never);f.publicAnswer.open.totalCount++;
  { const r=f.run();assert.equal(r.answer.outcome,"none",JSON.stringify(r)); }
  f.publicAnswer.open.nodes=[];f.publicAnswer.open.totalCount=0;
  f.publicAnswer.open.pageInfo.hasNextPage=true;
  assert.equal(f.run().answer.outcome,"unknown");
  f.publicAnswer.open.pageInfo.hasNextPage=false;
  f.opsAnswer.defaultBranchRef.target.oid="a".repeat(40);
  assert.equal(f.run().answer.outcome,"unknown");
});


test("migration preview reads claims from the pinned repository even when local origin is a decoy", t => {
  const f = fixture(t);
  f.pub.clone.git("push", "origin", "HEAD:refs/rmd-dispatch/W1-T1");
  const decoy = gitRepo({ scope: t, bare: true, kind: "migration-decoy" });
  f.pub.clone.git("push", decoy.dir, "HEAD:refs/heads/main");
  f.pub.clone.git("remote", "set-url", "origin", decoy.dir);
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.answer.outcome, "none", "the real selected origin claim must not disappear behind a same-commit decoy");
  assert.ok(result.answer.refused.some((row: { id: string; reason: string }) => row.id === "W1-T1" && row.reason === "owned"));
});


test("migration preview refuses a merged credit revised while search indexing is behind", t => {
  const f = fixture(t);
  const response = join(f.root, "answer.json");
  const revised = JSON.parse(readFileSync(response, "utf8"));
  revised.data.public.merged.nodes[0].body += "\nRemudero-Task: W1-T1";
  // The first repository read sees the old body; the candidate's actual second read sees the
  // new authoritative credit even while both complete search connections still return no hits.
  f.shim.addRoute({ when: "byTrailer:search", stdoutFile: response,
    writes: { path: response, content: JSON.stringify(revised) } });
  const result = f.run();
  assert.equal(result.answer.outcome, "unknown", "revised authoritative credit cannot become unmerged through an indexing delay");
  assert.equal(result.answer.permission, "not_granted");
});


test("migration preview never calls a foreign target unclaimed from the public plan repository", t => {
  const f = fixture(t, { "W1-T1.yaml": record("W1-T1").replace("repo: remudero", "repo: remudero-console") });
  const target = gitRepo({ scope: t, bare: true, kind: "migration-foreign-claim" });
  f.pub.clone.git("push", target.dir, "HEAD:refs/rmd-dispatch/W1-T1");
  assert.equal(target.git("rev-parse", "refs/rmd-dispatch/W1-T1"), f.pubCommit);
  const result = f.run();
  assert.equal(result.answer.outcome, "none", "the supplied public repository does not bind the foreign target claim namespace");
  assert.equal(result.answer.permission, "not_granted");
  assert.ok(result.answer.refused.some((row: { id: string; reason: string }) => row.id === "W1-T1" && row.reason === "target_not_bound"));
});


test("migration preview distinguishes incomplete search evidence from a complete missing positive control", t => {
  const empty = fixture(t);
  empty.credit.control = [];
  const noControl = empty.run();
  assert.equal(noControl.answer.outcome, "unknown");
  assert.equal(noControl.answer.reason, "merge_credit_control_unreadable");
  assert.equal(noControl.answer.permission, "not_granted");
  const absent = fixture(t);
  const response = JSON.parse(readFileSync(join(absent.root, "answer.json"), "utf8"));
  delete response.data.control;
  absent.shim.addRoute({ when: "byTrailer:search", stdout: JSON.stringify(response) });
  const incomplete = absent.run();
  assert.equal(incomplete.answer.outcome, "unknown");
  assert.equal(incomplete.answer.reason, "incomplete_evidence");
  assert.equal(incomplete.answer.permission, "not_granted");
});
