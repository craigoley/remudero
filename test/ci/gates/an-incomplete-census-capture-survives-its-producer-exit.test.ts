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
const SHARED = "scripts/lib/retained-fixtures.mjs";
const DRIVER = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {basename,dirname,join} from "node:path";
import {performance} from "node:perf_hooks";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const [root,fixture,mode]=process.argv.slice(1);
const {runCensusSuitesViaChild,censusReaderBudget}=await import(pathToFileURL(join(root,"scripts/census-precheck.mjs")).href);
const {retainFixture,fixtureRetentionReason}=await import(pathToFileURL(join(root,"test/setup/retained-fixtures.ts")).href);
const originalMake=fs.mkdtempSync,originalRead=fs.readFileSync,originalOpen=fs.openSync,originalStat=fs.fstatSync,originalLstat=fs.lstatSync,created=[],observed=new Map(),receipts=new Map();
let faulted=false,swapped=false;
fs.openSync=(path,...args)=>{
  const fd=originalOpen(path,...args);
  if(basename(String(path))==="native.json"&&observed.has(dirname(String(path))))receipts.set(fd,String(path));
  return fd;
};
function replaceAfterValidation(path,stat){
  if(mode==="fault-race"&&!swapped&&path&&basename(String(path))==="native.json"){
    const row=observed.get(dirname(String(path)));
    if(row?.native?.outputComplete===false){
      fs.renameSync(path,path+".closed");
      fs.writeFileSync(path,JSON.stringify({...row.native,finishedAt:"a replacement receipt"}));
      swapped=true;
    }
  }
  return stat;
}
fs.fstatSync=(fd,...args)=>replaceAfterValidation(receipts.get(fd),originalStat(fd,...args));
fs.lstatSync=(path,...args)=>replaceAfterValidation(path,originalLstat(path,...args));
fs.mkdtempSync=(...args)=>{
  const dir=originalMake(...args);
  if(basename(String(dir)).startsWith("rmd-census-capture-")){created.push(String(dir));observed.set(String(dir),{});}
  return dir;
};
fs.readFileSync=(path,...args)=>{
  const bytes=originalRead(path,...args),dir=dirname(String(path)),row=observed.get(dir);
  if(row&&basename(String(path))==="stdout")row.stdout=String(bytes);
  if(row&&basename(String(path))==="native.json"&&!row.native){
    row.native=JSON.parse(String(bytes));row.hash=createHash("sha256").update(bytes).digest("hex");
    if(!row.native.outputComplete&&mode.startsWith("fault-")&&mode!=="fault-race"&&!faulted){
      faulted=true;
      if(mode==="fault-malformed")fs.writeFileSync(path,"{not a native receipt");
      else if(mode==="fault-mismatched")fs.writeFileSync(path,JSON.stringify({...row.native,finishedAt:"a different capture"}));
      else if(mode==="fault-symlink"){fs.renameSync(path,path+".closed");fs.symlinkSync(path+".closed",path);}
      else {fs.unlinkSync(path);if(mode==="fault-directory")fs.mkdirSync(path);}
    }
  }
  return bytes;
};
syncBuiltinESMExports();
const began=performance.now();
assert.deepEqual(runCensusSuitesViaChild({root:fixture,files:["healthy.test.ts"]}),[]);
const finished=performance.now(),healthyDir=created[0],healthy=observed.get(healthyDir);
for(const [key,n] of [["tests",1],["pass",1],["fail",0],["cancelled",0],["skipped",0],["todo",0]])assert.match(healthy.stdout,new RegExp("^# "+key+" "+n+"$","m"));
assert.equal(healthy.native.outputComplete,true);assert.equal(healthy.native.status,0);
assert.equal(fs.existsSync(healthyDir),false,"complete healthy capture keeps its original cleanup");
const legacyDir=fs.mkdtempSync(join(tmpdir(),"rmd-explicit-custody-control-"));
fs.writeFileSync(join(legacyDir,"payload"),"explicit legacy fixture control");retainFixture(legacyDir,"explicit legacy fixture control");
let error=null,dir=null,native=null,nativeHash=null,closed=true;
if(mode!=="healthy"){
  const timeoutMs=censusReaderBudget({context:"actual-owned-startup",complete:true,passed:true,tests:1,elapsedMs:finished-began,finishedMs:finished},"actual-owned-startup",{floorMs:1000,multiple:4},finished);
  const controlled=mode.startsWith("fault-")?{priority:{wrap:()=>({file:process.execPath,args:["--input-type=commonjs","-e",'require("node:fs").writeFileSync("started-control",String(process.pid));process.kill(process.pid,"SIGTERM");']})}}:{};
  try{runCensusSuitesViaChild({root:fixture,files:["timeout.test.ts"],timeoutMs,...controlled});}
  catch(failure){error=String(failure.message);}
  assert.ok(error,"an incomplete child must never become a successful census");
  dir=created.at(-1);native=observed.get(dir)?.native;nativeHash=observed.get(dir)?.hash;
  assert.ok(dir&&native&&nativeHash,"the actual transport must have read its closed native receipt");
  assert.equal(native.outputComplete,false);assert.ok(native.finishedAt);
  if(mode.startsWith("fault-")){assert.equal(native.signal,"SIGTERM");assert.equal(native.error,null);}
  else assert.equal(native.error.code,"ERR_AUTHOR_STEP_TIMEOUT");
  const pid=Number(originalRead(join(fixture,"started-control"),"utf8"));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  try{process.kill(pid,0);closed=false;}catch(failure){closed=failure.code==="ESRCH";}
  assert.ok(closed,"only this fixture's runaway must be fully reaped before evidence is judged");
  if(mode==="explicit")retainFixture(dir,"explicit old API retains this same capture");
}
console.log("OBSERVATION:"+JSON.stringify({mode,healthyDir,legacyDir,error,dir,native,nativeHash,closed,faulted,swapped,reason:dir?fixtureRetentionReason(dir)??null:null}));
`;

interface Observation {
  mode: string;
  healthyDir: string;
  legacyDir: string;
  error: string | null;
  dir: string | null;
  nativeHash: string | null;
  native: { outputComplete: boolean; finishedAt: string; signal: string | null; error: { code: string } | null } | null;
  closed: boolean;
  faulted: boolean;
  swapped: boolean;
  reason: string | null;
}

function producer(t: TestContext, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-census-exit-proof-")), pin = lstatSync(dir);
  let checked = false;
  t.after(() => {
    if (!checked) { retainFixture(dir, "unexpected census custody proof failure; producer output and captures retained"); return; }
    const current = lstatSync(dir);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === pin.dev && current.ino === pin.ino && current.uid === pin.uid);
    rmSync(dir, { recursive: true, force: true });
  });
  const fixture = join(dir, "fixture"), scratch = join(dir, "producer");
  mkdirSync(fixture); mkdirSync(scratch);
  writeFileSync(join(fixture, "healthy.test.ts"), 'import {test} from "node:test";import assert from "node:assert/strict";test("actual healthy default child",()=>assert.equal(1,1));\n');
  writeFileSync(join(fixture, "timeout.test.ts"), 'import {test} from "node:test";import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{});writeFileSync("started-control",String(process.pid));test("owned incomplete capture",async()=>new Promise(()=>{setInterval(()=>{},100)}));\n');
  const argv = ["--import", "tsx", "--import", join(ROOT, "test/setup/tmp-hygiene.ts"), "--input-type=module", "-e", DRIVER, ROOT, fixture, mode];
  const result = spawnSync(process.execPath, argv, { cwd: ROOT, env: { ...process.env, TMPDIR: scratch }, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  writeFileSync(join(dir, "producer.stdout"), result.stdout ?? ""); writeFileSync(join(dir, "producer.stderr"), result.stderr ?? "");
  assert.equal(result.error, undefined, result.stderr); assert.equal(result.signal, null, result.stderr); assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter(line => line.startsWith("OBSERVATION:")); assert.equal(lines.length, 1, result.stdout);
  const observation = JSON.parse(lines[0]!.slice("OBSERVATION:".length)) as Observation;
  assert.equal(observation.mode, mode); assert.equal(existsSync(observation.healthyDir), false);
  assert.equal(readFileSync(join(observation.legacyDir, "payload"), "utf8"), "explicit legacy fixture control");
  return { observation, done() { checked = true; } };
}

function assertClosedCapture(observation: Observation): void {
  assert.ok(observation.dir, observation.error ?? "missing actual capture identity");
  assert.ok(existsSync(join(observation.dir, "native.json")), "the real incomplete capture disappeared at producer exit");
  const bytes = readFileSync(join(observation.dir, "native.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), observation.nativeHash, "custody must not rewrite native evidence");
  const native = JSON.parse(bytes.toString("utf8"));
  assert.equal(native.outputComplete, false); assert.equal(native.error.code, "ERR_AUTHOR_STEP_TIMEOUT"); assert.ok(native.finishedAt);
  assert.equal(observation.closed, true); assert.ok(observation.reason);
}

test("an incomplete census capture survives actual producer exit", (t) => {
  const run = producer(t, "automatic"); assertClosedCapture(run.observation); run.done();
});

test("census capture retention preserves healthy cleanup and explicit fixture custody", async (t) => {
  const run = producer(t, "healthy"); assert.equal(run.observation.error, null); assert.equal(run.observation.dir, null);
  const shared = await import(pathToFileURL(join(ROOT, SHARED)).href);
  assert.equal(shared.retainFixture, retainFixture, "the old typed API must re-export ONE actual production registry");
  assert.equal(shared.fixtureRetentionReason(Buffer.from(run.observation.legacyDir)), undefined, "another producer's retention is not this process's authority");
  assert.throws(() => shared.retainFixture(run.observation.legacyDir, " "), /reason/);
  retainFixture(run.observation.legacyDir, "this parent independently retains its own nested control");
  assert.equal(shared.fixtureRetentionReason(Buffer.from(run.observation.legacyDir)), "this parent independently retains its own nested control");
  run.done();
});

test("census capture custody failures stay unknown without widening author admission", (t) => {
  for (const mode of ["fault-missing", "fault-malformed", "fault-directory", "fault-mismatched", "fault-symlink"]) {
    const run = producer(t, mode), observation = run.observation;
    assert.equal(observation.faulted, true); assert.equal(observation.native?.outputComplete, false);
    assert.equal(observation.native?.signal, "SIGTERM"); assert.equal(observation.native?.error, null); assert.equal(observation.closed, true);
    assert.match(observation.error ?? "", /capture custody UNKNOWN/);
    assert.ok(observation.reason, "the owned partial diagnostic is retained without claiming readable native evidence");
    assert.ok(observation.dir && existsSync(observation.dir));
    run.done();
  }
});

test("census receipt validation reads the opened file when its path is replaced", (t) => {
  const run = producer(t, "fault-race"), observation = run.observation;
  assert.equal(observation.swapped, true, "the receipt path must change after file validation");
  assert.ok(observation.dir);
  assert.equal(JSON.parse(readFileSync(join(observation.dir, "native.json"), "utf8")).finishedAt, "a replacement receipt");
  assert.equal(createHash("sha256").update(readFileSync(join(observation.dir, "native.json.closed"))).digest("hex"), observation.nativeHash);
  assert.match(observation.reason ?? "", /^capture retained at /);
  assert.doesNotMatch(observation.error ?? "", /capture custody UNKNOWN/);
  assert.equal(observation.native?.signal, "SIGTERM");
  assert.equal(observation.native?.outputComplete, false);
  assert.equal(observation.closed, true);
  run.done();
});

test("actual census capture retention forwarding is load-bearing", async (t) => {
  const automatic = producer(t, "automatic"), explicit = producer(t, "explicit");
  assertClosedCapture(explicit.observation); assertClosedCapture(automatic.observation);
  assert.notEqual(automatic.observation.dir, explicit.observation.dir);
  assert.match(explicit.observation.reason ?? "", /explicit old API/);
  const census = await import(pathToFileURL(join(ROOT, "scripts/census-precheck.mjs")).href);
  const file = "test/ci/gates/an-incomplete-census-capture-survives-its-producer-exit.test.ts";
  const registration = census.PRECHECK_PATH_TRIGGERED_SUITES.find((row: Record<string, unknown>) => row.testFile === file);
  assert.ok(registration, "the semantic suite must join the real pre-push path admission");
  for (const path of [file, "scripts/census-precheck.mjs", SHARED, "scripts/lib/retained-fixtures.d.mts", "test/setup/retained-fixtures.ts", "test/setup/tmp-hygiene.ts"]) assert.equal(registration.trigger({ changed: [path] }), true);
  assert.equal(registration.trigger({ changed: ["README.md"] }), false);
  assert.equal(census.PRECHECK_PARITY[file]?.modeled, census.evaluateAdmittedCensusSuites);
  automatic.done(); explicit.done();
});
