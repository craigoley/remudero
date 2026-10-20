import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "#test/helpers/repo-root.js";
import { retainFixture } from "#test/setup/retained-fixtures.js";

const ROOT = repoRoot();
const FILE = "test/ci/a-rejected-census-measurement-retains-its-complete-capture.test.ts";
const DRIVER = String.raw`
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {basename,join} from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
const [root,fixture,mode]=process.argv.slice(1);
const {runCensusSuitesViaChild}=await import(pathToFileURL(join(root,"scripts/census-precheck.mjs")).href);
const {fixtureRetentionReason,retainFixture}=await import(pathToFileURL(join(root,"test/setup/retained-fixtures.ts")).href);
const make=fs.mkdtempSync,read=fs.readFileSync,open=fs.openSync,remove=fs.rmSync,stat=fs.lstatSync,dirs=[],observed=[],fds=new Map();
let faulted=false,clock=0,contexts=0;
fs.mkdtempSync=(...args)=>{const dir=make(...args);if(basename(dir).startsWith("rmd-census-capture-"))dirs.push(dir);return dir;};
fs.openSync=(path,...args)=>{const fd=open(path,...args);fds.set(fd,String(path));return fd;};
fs.readFileSync=(path,...args)=>{
  if(mode==="transport-read"&&String(path).endsWith("/stdout")&&dirs.includes(String(path).slice(0,-7)))throw Object.assign(new Error("transport stdout unreadable"),{code:"EACCES"});
  if(faulted&&mode==="fault-unreadable"&&String(fds.get(path)??path).endsWith("/stdout"))throw Object.assign(new Error("owned stdout unreadable"),{code:"EACCES"});
  if(mode==="fault-binding"&&basename(String(path))==="native.json"&&typeof path!=="number"){
    const bytes=JSON.parse(read(path,...args));return JSON.stringify({...bytes,durationMs:bytes.durationMs+1});
  }
  return read(path,...args);
};
fs.lstatSync=(path,...args)=>{
  if(mode==="pin-read"&&String(path).endsWith("/stdout"))throw Object.assign(new Error("capture pin unreadable"),{code:"EACCES"});
  return stat(path,...args);
};
fs.rmSync=(path,...args)=>{
  if(mode==="fault-cleanup"&&dirs.includes(String(path))){faulted=true;throw Object.assign(new Error("owned cleanup unwritable"),{code:"EACCES"});}
  return remove(path,...args);
};
syncBuiltinESMExports();
const body=(kind)=>'import {test} from "node:test";import assert from "node:assert/strict";console.error("native stderr control");'+
  (kind==="missing"?'process.exit(0);':kind==="incomplete"?'process.kill(process.pid,"SIGTERM");':
  kind==="calibration-skipped"?'test.skip("actual case",()=>{});':
  'test('+JSON.stringify(kind==="inventory"?"changed case":"actual case")+',()=>assert.equal(1,'+(kind==="failed"?'2':'1')+'));');
fs.writeFileSync(join(fixture,"reader.test.ts"),body(mode==="failed-calibration"?"failed":mode==="calibration-skipped"?mode:"healthy"));
function observe(){
  const dir=dirs.at(-1);if(!dir||observed.some(row=>row.dir===dir))return;
  const hashes={};let native=null;
  for(const name of ["stdout","stderr","native.json"]){
    try{const bytes=read(join(dir,name));hashes[name]=createHash("sha256").update(bytes).digest("hex");if(name==="native.json")native=JSON.parse(String(bytes));}catch(error){hashes[name]=null;}
  }
  observed.push({dir,hashes,native});
}
const times=mode==="timing"?[0,100,101,102,5102,5103,10103]:mode==="duration"?[0,100,101,102,NaN]:
  mode==="calibration-budget"?[0,70000,70001]:mode==="calibration-duration"?[0,NaN,101]:[0,100,101,102,202];
const now=()=>{
  clock++;if(clock===2||clock===5||clock===7)observe();
  if(clock===5&&mode.startsWith("fault-")&&mode!=="fault-cleanup"){
    faulted=true;const path=join(dirs.at(-1),mode==="fault-directory"?"stderr":"native.json");
    if(mode==="fault-missing")fs.unlinkSync(path);
    if(mode==="fault-malformed")fs.writeFileSync(path,"{invalid");
    if(mode==="fault-mismatch"){const native=JSON.parse(read(path));fs.writeFileSync(path,JSON.stringify({...native,finishedAt:"replacement"}));}
    if(mode==="fault-replaced"){fs.renameSync(path,path+".closed");fs.writeFileSync(path,read(path+".closed"));}
    if(mode==="fault-symlink"){fs.renameSync(path,path+".closed");fs.symlinkSync(path+".closed",path);}
    if(mode==="fault-directory"){fs.unlinkSync(path);fs.mkdirSync(path);}
    if(mode==="fault-owner"){fs.renameSync(dirs.at(-1),dirs.at(-1)+".closed");fs.mkdirSync(dirs.at(-1));}
  }
  return times[clock-1]??(clock*100);
};
const readContext=()=>{
  contexts++;
  if(contexts===2&&["inventory","failed","missing"].includes(mode))fs.writeFileSync(join(fixture,"reader.test.ts"),body(mode));
  return ((mode==="context"||mode.startsWith("fault-")&&mode!=="fault-cleanup")&&contexts===3)||mode==="calibration-context"&&contexts===2?"changed":"original";
};
let error=null,result=null;
try{result=runCensusSuitesViaChild({root:fixture,files:["reader.test.ts"],priority:{wrap:(file,args)=>
  ["incomplete","explicit"].includes(mode)?{file:process.execPath,args:["-e",'process.kill(process.pid,"SIGTERM")']}:{file,args}},
  readerRuntimePolicy:{floorMs:1000,multiple:4,remeasureMargin:1.1},now,readContext});}
catch(cause){error=cause.message;}
observe();
if(mode==="explicit")for(const dir of dirs)if(fs.existsSync(dir))retainFixture(dir,"explicit retained incomplete control");
console.log("OBSERVATION:"+JSON.stringify({mode,error,result,faulted,rows:observed.map(row=>({...row,reason:fixtureRetentionReason(row.dir)??null}))}));
`;

interface Row { dir: string; hashes: Record<string, string | null>; native: { outputComplete: boolean; status: number; finishedAt: string } | null; reason: string | null }
interface Observation { mode: string; error: string | null; result: string[] | null; faulted: boolean; rows: Row[] }

function producer(t: TestContext, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rejected-census-proof-")), pin = lstatSync(dir);
  let checked = false;
  t.after(() => {
    if (!checked) { retainFixture(dir, "unexpected rejected census proof failure; preserve producer evidence"); return; }
    const current = lstatSync(dir);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === pin.dev && current.ino === pin.ino && current.uid === pin.uid);
    rmSync(dir, { recursive: true });
  });
  const fixture = join(dir, "fixture"), scratch = join(dir, "producer");
  mkdirSync(fixture); mkdirSync(scratch);
  const output = spawnSync(process.execPath, ["--import", "tsx", "--import", join(ROOT, "test/setup/tmp-hygiene.ts"),
    "--input-type=module", "-e", DRIVER, ROOT, fixture, mode], {
    cwd: ROOT, env: { ...process.env, TMPDIR: scratch }, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  writeFileSync(join(dir, "producer.stdout"), output.stdout ?? ""); writeFileSync(join(dir, "producer.stderr"), output.stderr ?? "");
  assert.equal(output.error, undefined, output.stderr); assert.equal(output.signal, null, output.stderr); assert.equal(output.status, 0, output.stderr);
  const lines = output.stdout.split("\n").filter(line => line.startsWith("OBSERVATION:")); assert.equal(lines.length, 1, output.stdout);
  const observation = JSON.parse(lines[0]!.slice("OBSERVATION:".length)) as Observation;
  assert.equal(observation.mode, mode);
  return { observation, done() { checked = true; } };
}

function retained(row: Row, complete = true) {
  assert.equal(row.native?.outputComplete, complete); assert.ok(row.native?.finishedAt);
  for (const name of ["stdout", "stderr", "native.json"]) {
    assert.ok(row.hashes[name], "the real child transport must have captured the original bytes");
    assert.equal(createHash("sha256").update(readFileSync(join(row.dir, name))).digest("hex"), row.hashes[name], "native evidence must survive producer exit unchanged");
  }
  assert.ok(row.reason, "the decision must register custody with the producer exit sweep");
}

test("a rejected complete census measurement survives producer exit", (t) => {
  for (const [mode, reason] of [["context", /inputs changed during qualification/], ["calibration-context", /inputs changed during calibration/],
    ["inventory", /case inventory differs/], ["duration", /invalid native duration/], ["timing", /exceeded its 4000ms measured budget/],
    ["calibration-budget", /exceeded the existing backstop/], ["calibration-duration", /UNKNOWN/], ["calibration-skipped", /no complete unskipped pass/],
    ["missing", /case inventory differs/], ["failed", null], ["failed-calibration", null]] as const) {
    const run = producer(t, mode), { observation: o } = run;
    if (reason) { assert.match(o.error ?? "", reason); assert.equal(o.result, null); }
    else { assert.equal(o.error, null); assert.deepEqual(o.result, ["reader.test.ts"]); }
    retained(o.rows.at(-1)!);
    assert.equal(o.rows.at(-1)!.native!.status, mode.startsWith("failed") ? 1 : 0);
    for (const row of o.rows.slice(0, -1)) {
      if (mode === "timing" && row !== o.rows[0]) retained(row);
      else assert.equal(existsSync(row.dir), false, "accepted calibration is cleaned independently");
    }
    run.done();
  }
});

test("census qualification custody preserves healthy and incomplete controls", (t) => {
  const healthy = producer(t, "healthy"); assert.equal(healthy.observation.error, null); assert.deepEqual(healthy.observation.result, []);
  assert.equal(healthy.observation.rows.length, 2);
  for (const row of healthy.observation.rows) { assert.equal(row.native?.outputComplete, true); assert.equal(existsSync(row.dir), false); assert.equal(row.reason, null); }
  healthy.done();
  for (const mode of ["incomplete", "explicit"]) {
    const run = producer(t, mode);
    assert.match(run.observation.error ?? "", /SIGTERM|incomplete/); assert.equal(run.observation.result, null);
    if (mode === "explicit") assert.match(run.observation.rows[0]!.reason ?? "", /explicit retained incomplete control/);
    retained(run.observation.rows[0]!, false); run.done();
  }
});

test("complete census custody failures remain unknown without admission changes", (t) => {
  for (const mode of ["fault-missing", "fault-malformed", "fault-mismatch", "fault-replaced", "fault-symlink", "fault-directory", "fault-unreadable", "fault-owner", "fault-cleanup", "fault-binding", "pin-read", "transport-read"]) {
    const run = producer(t, mode), o = run.observation;
    if (mode.startsWith("fault-") && mode !== "fault-binding") assert.equal(o.faulted, true);
    assert.equal(o.result, null);
    assert.match(o.error ?? "", /capture custody UNKNOWN/);
    if (mode.startsWith("fault-") && !["fault-cleanup", "fault-binding"].includes(mode)) assert.match(o.error ?? "", /inputs changed during qualification/);
    assert.ok(o.rows.at(-1)!.reason); run.done();
  }
});

test("rejected census measurement retention forwarding is load-bearing", async (t) => {
  const run = producer(t, "context"); retained(run.observation.rows.at(-1)!);
  const census = await import(pathToFileURL(join(ROOT, "scripts/census-precheck.mjs")).href);
  const registration = census.PRECHECK_PATH_TRIGGERED_SUITES.find((row: { testFile: string }) => row.testFile === FILE);
  assert.ok(registration);
  for (const path of [FILE, "scripts/census-precheck.mjs", "scripts/lib/author-step-capture.mjs", "scripts/lib/retained-fixtures.mjs", "test/setup/tmp-hygiene.ts", "test/setup/retained-fixtures.ts"]) assert.equal(registration.trigger({ changed: [path] }), true);
  assert.equal(registration.trigger({ changed: ["README.md"] }), false);
  assert.equal(census.PRECHECK_PARITY[FILE]?.modeled, census.evaluateAdmittedCensusSuites);
  run.done();
});
