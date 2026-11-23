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
import { PreviewUnknown, selectPlanTaskMigration } from "#src/lib/plan-task-migration.js";
import type { OpsCatalogBoundsIo } from "#src/lib/ops-catalog-source.js";

const record = (id: string, priority = 1, deps: string[] = []) => { const text = `- id: ${id}\n  title: migration fixture\n  repo: remudero\n  type: implement\n  priority: ${priority}\n  depends_on: ${JSON.stringify(deps)}\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: the fixture holds\n      proof: \"grep: fixture in test/fixture.test.ts\"\n`; assert.equal(parseTasksFromYaml(text,"fixture")[0]!.id,id); return text; };
function fixture(t: TestContext, records: Record<string, string> = {"W1-T1.yaml": record("W1-T1")}, opsText = "[]\n", publicSeed: Record<string, string> = {}, opsSeed: Record<string, string> = {}) {
  const root = ownedFixtureDir(t, "migration-preview").dir;
  const seed = {"plan/tasks.yaml": "[]\n", ...Object.fromEntries(Object.entries(records).map(([p,s]) => ["plan/tasks.d/"+p,s])), ...publicSeed};
  const pub = originWithClone(join(root,"public"), {scope:t,seed});
  // W1-T13680: a movable task holds its public reservation; seed one per fixture record.
  for (const text of Object.values({...records,...publicSeed})) for (const m of text.matchAll(/^- id: (\S+)/gm)) pub.origin.git("update-ref",`refs/rmd-id/${m[1]}`,"main");
  const ops = originWithClone(join(root,"ops"), {scope:t,seed:{"plan/tasks.yaml":opsText,...opsSeed}});
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


test("migration preview resolves only committed layout metadata", t => {
  const live = fixture(t);
  mkdirSync(join(live.pub.clone.dir, ".remudero"));
  writeFileSync(join(live.pub.clone.dir, ".remudero/layout.json"), "not valid JSON");
  assert.equal(live.run().answer.candidate.id, "W1-T1", "uncommitted layout bytes cannot change the pinned catalog");
  const moved = fixture(t, undefined, "[]\n", {
    ".remudero/layout.json": JSON.stringify({ planDir: "backlog", planMonolith: "backlog/tasks.yaml" }),
    "backlog/tasks.yaml": "[]\n", "backlog/tasks.d/W1-T2.yaml": record("W1-T2"),
  });
  const result = moved.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.answer.candidate.id, "W1-T2");
  assert.equal(result.answer.candidate.sourcePath, "backlog/tasks.d/W1-T2.yaml");
});


test("migration preview refuses layout paths the actual private reader cannot consume", t => {
  const f = fixture(t, undefined, "[]\n", {}, {
    ".remudero/layout.json": JSON.stringify({ planDir: "private-backlog", planMonolith: "private-backlog/tasks.yaml" }),
    "private-backlog/tasks.yaml": "[]\n",
  });
  const result = f.run();
  assert.equal(result.answer.outcome, "unknown", "a layout unsupported by the real private reader is not migration permission");
  assert.equal(result.answer.permission, "not_granted");
});


test("migration preview preserves separate committed monolith and shard-directory layout", t => {
  const f = fixture(t, undefined, "[]\n", {
    ".remudero/layout.json": JSON.stringify({ planDir: "backlog", planMonolith: "manifests/task-set.yaml" }),
    "manifests/task-set.yaml": "[]\n", "backlog/tasks.d/W1-T2.yaml": record("W1-T2"),
  });
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.answer.candidate.id, "W1-T2");
  assert.equal(result.answer.candidate.sourcePath, "backlog/tasks.d/W1-T2.yaml");
});


test("migration preview reads a measured healthy catalog above 32 MiB and still refuses its bounded maximum", t => {
  // The real 2026-11-17 public catalog is 34,444,886 bytes across 5,647 Git blobs.
  // Repeated comment bytes compress in Git; the fixture exercises the actual CLI reader, not a fake.
  const atSize = (mib: number) => Object.fromEntries(Array.from({ length: mib }, (_, i) =>
    [`plan/tasks.d/padding-${i}.yaml`, "[]\n#" + "x".repeat(1024 * 1024) + "\n"]));
  const healthy = fixture(t, undefined, "[]\n", atSize(33));
  const result = healthy.run();
  assert.equal(result.status, 0, JSON.stringify(result.answer));
  assert.equal(result.answer.candidate.id, "W1-T1");
  assert.equal(result.answer.permission, "not_granted");
  const tooLarge = fixture(t, undefined, "[]\n", atSize(49));
  const refused = tooLarge.run();
  assert.equal(refused.status, 1);
  assert.equal(refused.answer.outcome, "unknown");
  assert.equal(refused.answer.reason, "catalog_unreadable");
  assert.equal(refused.answer.permission, "not_granted");
});

test("migration preview respects the actual private reader capacity contract", async t => {
  // Published reader limits, not host-admission overrides: 256 KiB/blob, 8 MiB total,
  // 500 YAML shards and 10,000 cumulative tree entries. All cases use real Git; the fixed bounds run the CLI.
  const emptyAtBytes = (bytes: number) => "[]\n#" + "x".repeat(bytes - 5) + "\n";
  const maximum = 8 * 1024 * 1024;
  const blob = 256 * 1024;
  await t.test("a healthy private snapshot at the byte limit remains usable", sub => {
    const seed = Object.fromEntries(Array.from({ length: 32 }, (_, i) =>
      [`plan/tasks.d/empty-${i}.yaml`, emptyAtBytes(i === 31 ? blob - 3 : blob)]));
    const result = fixture(sub, undefined, "[]\n", {}, seed).run();
    assert.equal(Object.values(seed).reduce((sum, text) => sum + Buffer.byteLength(text), 3), maximum);
    assert.equal(result.status, 0, JSON.stringify(result.answer));
    assert.equal(result.answer.candidate.id, "W1-T1");
    assert.equal(result.answer.permission, "not_granted");
  });
  const cases = [
    { name: "a blob larger than the private reader accepts", text: emptyAtBytes(blob + 1), seed: {} },
    { name: "unselected root entries still count toward the private tree bound", text: "[]\n", seed: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`metadata-${i}`, ""])) },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const result = fixture(sub, undefined, entry.text, {}, entry.seed).run();
    assert.equal(result.status, 1, JSON.stringify(result.answer));
    assert.equal(result.answer.outcome, "unknown");
    assert.equal(result.answer.permission, "not_granted");
  });
  // The catalog's growth is not bounded: past 500 shards the copy's one more shard is admitted, however fast it grew.
  await t.test("many private YAML shards are no refusal", async sub => {
    const f = fixture(sub, undefined, "[]\n", {}, Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`plan/tasks.d/empty-${i}.yaml`, "[]\n"])));
    const admitted = await selectInProcess(f, {});
    assert.equal(admitted.selection?.candidate?.id, "W1-T1", `a copy past the shard baseline is admitted ${JSON.stringify(admitted)}`);
  });
  // W1-T14368: past 8 MiB the reader's heap bound judges the catalog the copy would produce. It is driven past it with
  // an injected reading, and the same selection without it is the control.
  const derived: Array<{ name: string; seed: Record<string, string>; bounds: OpsCatalogBoundsIo }> = [
    { name: "too many private snapshot bytes", seed: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`plan/tasks.d/empty-${i}.yaml`, emptyAtBytes(blob)])),
      // A heap with no headroom left below the daemon's heap-limit exit: no byte past the baseline fits.
      bounds: { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) } },
  ];
  for (const entry of derived) await t.test(entry.name, async sub => {
    const f = fixture(sub, undefined, "[]\n", {}, entry.seed);
    const refused = await selectInProcess(f, entry.bounds);
    assert.equal(refused.reason, "catalog_incompatible", JSON.stringify(refused));
    const control = await selectInProcess(f, {});
    assert.equal(control.selection?.candidate?.id, "W1-T1", `positive control: without the reading the copy is admitted ${JSON.stringify(control)}`);
  });
});

/** The CLI's own selection, in process, so a test can hand it the bound readings the reader takes. */
async function selectInProcess(f: ReturnType<typeof fixture>, bounds: OpsCatalogBoundsIo) {
  const env: Record<string, string> = { PATH: `${f.shim.dir}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${f.pub.origin.dir}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/fixture/remudero.git",
    GIT_CONFIG_KEY_1: `url.${f.ops.origin.dir}.insteadOf`, GIT_CONFIG_VALUE_1: "https://github.com/fixture/ops.git" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const o = { publicRoot: f.pub.clone.dir, publicCommit: f.pubCommit, publicRepo: "fixture/remudero",
      opsRoot: f.ops.clone.dir, opsCommit: f.opsCommit, opsRepo: "fixture/ops" };
    const answer = JSON.parse(readFileSync(join(f.root, "answer.json"), "utf8"));
    return { selection: await selectPlanTaskMigration(o, async () => answer, bounds), reason: undefined };
  } catch (error) {
    if (!(error instanceof PreviewUnknown)) throw error;
    return { selection: undefined, reason: error.reason };
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
