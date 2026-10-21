import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-expect-error — native script ESM is outside this project's tsconfig source roots.
import { assessReadMapCorpus, collectReadMapCorpus, corpusDigest, prepareReadMapCorpus, readCorpusBytes, readMapSummary, validateCorpusManifest } from "../scripts/lib/read-map-corpus.mjs";
// @ts-expect-error — native CLI ESM is outside this project's tsconfig source roots.
import { main } from "../scripts/read-map-corpus.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TSX = import.meta.resolve("tsx");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
function control() {
  const suites = ["test/a-reader.test.ts", "test/b-other.test.ts"].map(path => ({ path, blob: "a".repeat(40), sha256: sha(path), bytes: 1 }));
  const manifest = { format: "rmd-read-map-run-manifest-v1", root: ROOT, head: "a".repeat(40), tree: "b".repeat(40), runId: "12345678-1234-1234-1234-123456789012", preparedAtMs: 1,
    suites, suitesSha256: corpusDigest(suites), nodeVersion: process.version, nodeSha256: "c".repeat(64), mode: "shadow", skipsNothing: true,
    inputs: ["package-lock.json", "test/setup/read-map.ts", "test/setup/tmp-hygiene.ts", "scripts/lib/read-map-summary-reporter.mjs", "scripts/lib/read-map-corpus.mjs", "scripts/read-map-corpus.mjs"].map(path => ({ path, sha256: "c".repeat(64) })) };
  const summaries = [...suites.map(x => readMapSummary({ type: "test:summary", data: { file: join(ROOT, x.path), success: true, counts: { ...counts } } }, manifest)),
    readMapSummary({ type: "test:summary", data: { success: true, counts: { ...counts, tests: 2, passed: 2 } } }, manifest)];
  const records = new Map(suites.map(x => [x.path, { sha256: "d".repeat(64), modifiedMs: 2,
    value: { format: "rmd-read-record-v2", suite: x.path, reads: x.path.includes("reader") ? ["deploy/unit.json"] : [], listed: [], unknownDescriptors: false } }]));
  return { manifest, summaries, records };
}
test("read map corpus producer keeps complete observations shadow-only and never exports a pruning grant", () => {
  const { manifest, summaries, records } = control(), report = assessReadMapCorpus(manifest, summaries, records, true);
  assert.equal(report.state, "OBSERVED_NOT_QUALIFIED"); assert.equal(report.problems.length, 0);
  assert.equal(report.expectedSuites, 2); assert.equal(report.observedSuites, 2);
  assert.equal(report.dispatchAllowed, false); assert.equal(report.liveNarrowingAllowed, false);
  assert.equal(report.qualification.heldOutFalseNegatives, "NOT_ESTABLISHED");
});
test("a missing read record cannot be promoted into trustworthy empty corpus evidence", () => {
  const { manifest, summaries, records } = control(); records.delete("test/a-reader.test.ts");
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /record is absent malformed or stale/);
});
test("unrun suites and unclosed global output stay incomplete", () => {
  const { manifest, summaries, records } = control(); summaries.splice(0, 1);
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /suite outcome is missing/);
  summaries.pop(); assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /closed positive final summary/);
});
test("a suite skip cancellation failure or zero tests is not producer qualification", () => {
  for (const key of ["skipped", "cancelled", "failed"]) {
    const { manifest, summaries, records } = control(); summaries[0]!.counts[key] = 1;
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
  const { manifest, summaries, records } = control(); summaries[0]!.counts.tests = 0;
  assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
});
test("a stale record unknown descriptor or legacy record keeps the observation incomplete", () => {
  for (const mutate of [(x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.modifiedMs = 0; },
    (x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.value.unknownDescriptors = true; },
    (x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.value.format = "rmd-read-record-v1"; }]) {
    const { manifest, summaries, records } = control(); mutate(records);
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
});
test("foreign repeated or mixed-head summaries cannot substitute for missing suites", () => {
  for (const mutate of [(s: ReturnType<typeof control>["summaries"]) => { s[1] = s[0]; },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.suite = "test/foreign.test.ts"; },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.head = "c".repeat(40); },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.runId = "different-run"; }]) {
    const { manifest, summaries, records } = control(); mutate(summaries);
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
});
test("drifted source and mismatched whole-run counts remain explicit", () => {
  const { manifest, summaries, records } = control();
  assert.match(assessReadMapCorpus(manifest, summaries, records, false).problems.join("\n"), /runtime drifted/);
  summaries.at(-1)!.counts.tests = 3; summaries.at(-1)!.counts.passed = 3;
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /does not reconcile/);
});
test("repeated or early global summary and records without outcomes refuse", () => {
  const { manifest, summaries, records } = control(); summaries.unshift(summaries.at(-1));
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /repeated or not final/);
  records.set("test/foreign.test.ts", records.values().next().value!);
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /no closed suite outcome/);
});
test("physical manifest cannot hide duplicate paths changed bytes traversal or changed producer inputs", () => {
  const { manifest } = control(); assert.equal(validateCorpusManifest(manifest), manifest);
  manifest.suites[0]!.sha256 = "e".repeat(64); assert.throws(() => validateCorpusManifest(manifest), /physical/);
  manifest.suitesSha256 = corpusDigest(manifest.suites); manifest.suites[0]!.path = "test/../unsafe.test.ts";
  assert.throws(() => validateCorpusManifest(manifest), /physical/);
  const other = control().manifest; other.inputs[0]!.path = "../outside.json";
  assert.throws(() => validateCorpusManifest(other), /runtime inputs/);
});
test("custom read map reporter captures summary only never private stdout or test bodies", () => {
  const { manifest } = control(); assert.equal(readMapSummary({ type: "test:stdout", data: { message: "private" } }, manifest), undefined);
  const event = readMapSummary({ type: "test:summary", data: { file: join(ROOT, "test/a-reader.test.ts"), success: false, counts } }, manifest)!;
  assert.equal(event.suite, "test/a-reader.test.ts"); assert.equal(event.success, false); assert.equal("message" in event, false);
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "rmd-read-map-producer-")), repo = gitRepo({ seedCommit: false, kind: "read-map-source" }), root = repo.dir, directory = join(home, "run");
  const put = (path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  for (const path of ["scripts/lib/read-map-corpus.mjs", "scripts/lib/read-map-summary-reporter.mjs", "scripts/read-map-corpus.mjs", "scripts/lib/argv.mjs", "test/setup/read-map.ts"]) put(path, readFileSync(join(ROOT, path), "utf8"));
  put("package.json", '{"type":"module"}'); put("package-lock.json", "{}");
  put("test/setup/tmp-hygiene.ts", 'import {installReadMapFromEnv} from "./read-map.ts"; await installReadMapFromEnv();\n');
  put("deploy/unit.json", '{"positive":true}\n');
  put("test/a-reader.test.ts", 'import {test} from "node:test"; import {readFileSync} from "node:fs"; test("actual reader",()=>readFileSync("deploy/unit.json"));\n');
  put("test/b-other.test.ts", 'import {test} from "node:test"; test("actual non-reader",()=>{});\n');
  const git = repo.git; git("add", "."); git("commit", "-m", "source-bound corpus fixture");
  return { home, root, directory, git, cleanup: () => { repo.cleanup(); rmSync(home, { recursive: true, force: true }); } };
}
test("real Node per-file summaries and real fs reads produce a committed two-suite observation", () => {
  const fx = fixture();
  try {
    const prepared = prepareReadMapCorpus(fx.root, fx.directory);
    assert.equal(prepared.manifest.suites.length, 2);
    const clean = { ...process.env, ...prepared.env, NODE_V8_COVERAGE: "", RMD_TEST_SLOT_MANAGED: process.env.RMD_TEST_SLOT_MANAGED };
    delete clean.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--import", TSX, "--import", join(fx.root, "test/setup/tmp-hygiene.ts"), "--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
      "--test-reporter=" + prepared.reporter, "--test-reporter-destination=" + prepared.reporterDestination, "test/a-reader.test.ts", "test/b-other.test.ts"], { cwd: fx.root, env: clean, encoding: "utf8", timeout: 30000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /# tests 2/); assert.match(run.stdout, /# fail 0/);
    const report = collectReadMapCorpus(fx.directory);
    assert.equal(report.state, "OBSERVED_NOT_QUALIFIED", report.problems.join("\n"));
    assert(report.observations.find((x: {suite: string}) => x.suite === "test/a-reader.test.ts")!.record.reads.includes("deploy/unit.json"));
    assert(!report.observations.find((x: {suite: string}) => x.suite === "test/b-other.test.ts")!.record.reads.includes("deploy/unit.json"));
    assert.equal(report.liveNarrowingAllowed, false);
    writeFileSync(join(fx.root, "deploy/unit.json"), "changed");
    assert.equal(collectReadMapCorpus(fx.directory).state, "INCOMPLETE");
  } finally { fx.cleanup(); }
});
test("prepare refuses reuse dirty trees and output inside the source checkout", () => {
  const fx = fixture();
  try {
    assert.throws(() => prepareReadMapCorpus(fx.root, join(fx.root, "records")), /outside/);
    prepareReadMapCorpus(fx.root, fx.directory); assert.throws(() => prepareReadMapCorpus(fx.root, fx.directory), /never reused/);
    writeFileSync(join(fx.root, "untracked"), "not committed"); assert.throws(() => prepareReadMapCorpus(fx.root, join(fx.home, "second")), /clean committed/);
  } finally { fx.cleanup(); }
});
test("unbounded symlink and unclosed artifacts are not empty successful observations", () => {
  const fx = fixture();
  try {
    prepareReadMapCorpus(fx.root, fx.directory);
    const alias = join(fx.home, "alias"); symlinkSync(join(fx.directory, "manifest.json"), alias);
    assert.throws(() => readCorpusBytes(alias), /bounded regular/);
    assert.throws(() => readCorpusBytes(join(fx.directory, "manifest.json"), 1), /bounded regular/);
    writeFileSync(join(fx.directory, "summaries.ndjson"), "{}"); assert.throws(() => collectReadMapCorpus(fx.directory), /unclosed/);
    assert.equal(existsSync(join(fx.root, "dist")), false);
  } finally { fx.cleanup(); }
});
test("producer CLI refuses an implicit run and exposes explicit prepare and collect commands", () => {
  assert.equal(main([]), 2); assert.equal(main(["run", "--directory", "/nonexistent"]), 2);
  assert.equal(main(["--help"]), 0);
});

// Child isolation keeps syncBuiltinESMExports interception out of other tests. Except for the explicitly
// simulated capability/metadata cases, the default production helper performs real open/stat/read/close.
function corpusProbe(body: string, timeout = 3000) {
  const program = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    import {runInNewContext} from "node:vm";
    import {createHash} from "node:crypto";
    import {spawnSync} from "node:child_process";
    import {tmpdir} from "node:os";
    import {join} from "node:path";
    const moduleUrl = ${JSON.stringify(new URL("../scripts/lib/read-map-corpus.mjs", import.meta.url).href)};
    const {readCorpusBytes} = await import(moduleUrl);
    const real = {openSync:fs.openSync, closeSync:fs.closeSync, fstatSync:fs.fstatSync, readSync:fs.readSync};
    const home = fs.mkdtempSync(join(tmpdir(), "rmd-corpus-descriptor-")), path = join(home, "input");
    const epoch = Math.floor(Date.now()/1000)-60;
    const reset = () => {fs.writeFileSync(path,"ORIGINAL");fs.utimesSync(path,epoch,epoch);};
    let evidence = {};
    try { reset(); ${body}; console.log(JSON.stringify(evidence)); }
    finally {Object.assign(fs,real);syncBuiltinESMExports();fs.rmSync(home,{recursive:true,force:true});}
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: ROOT, encoding: "utf8", timeout, env: { ...process.env },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

test("corpus byte bounds reject invalid limits before open and retain every caller limit", () => {
  const result = corpusProbe(`
    let opens=0;fs.openSync=(...args)=>{opens++;return real.openSync(...args);};syncBuiltinESMExports();
    for(const limit of [NaN,Infinity,-Infinity,0,-1,8.5,"8",null,2**53,256*1024**2+1])
      assert.throws(()=>readCorpusBytes(path,limit),/maximumBytes/);
    assert.equal(opens,0);
    for(const limit of [8,4*1024**2,8*1024**2,16*1024**2,256*1024**2])
      assert.equal(readCorpusBytes(path,limit).bytes.toString(),"ORIGINAL");
    assert.throws(()=>readCorpusBytes(path,7),/bounded regular/);
    evidence={invalidRefusedBeforeOpen:true,validCallerLimits:5,opens};
  `);
  assert.equal(result.invalidRefusedBeforeOpen, true);
  assert.equal(result.opens, 6);
});

test("corpus byte reads refuse simulated unavailable or meaningless flags before open", () => {
  const result = corpusProbe(`
    const source=fs.readFileSync(new URL(moduleUrl),"utf8");
    const text=source.match(/export function readCorpusBytes[\\s\\S]*?\\n}/)[0].replace(/^export /,"");
    let refused=0;
    for(const key of ["O_NOFOLLOW","O_NONBLOCK"])for(const value of [undefined,0,-1,NaN,Infinity,2**32,1.5]){
      let opens=0;
      const helper=runInNewContext("("+text+")",{...real,
        constants:{...fs.constants,[key]:value},Buffer,
        openSync:()=>{opens++;throw Error("must refuse before open");},
        digest:bytes=>createHash("sha256").update(bytes).digest("hex")});
      assert.throws(()=>helper(path),/file flags unavailable/);assert.equal(opens,0);refused++;
    }
    evidence={simulated:true,refused};
  `);
  assert.equal(result.simulated, true); assert.equal(result.refused, 14);
});

test("corpus descriptor snapshot rejects real partial-read mutation despite restored mtime", () => {
  const result = corpusProbe(`
    let reads=0,closed=0,mutation;
    fs.readSync=(fd,buffer,offset,length,position)=>{
      const count=real.readSync(fd,buffer,offset,Math.min(length,4),position);reads++;
      if(reads===1){const before=real.fstatSync(fd),tick=performance.now();while(performance.now()-tick<3){}
        fs.writeFileSync(path,"MUTATED!");fs.utimesSync(path,epoch,epoch);const after=real.fstatSync(fd);
        mutation={sameInode:before.ino===after.ino,sameDev:before.dev===after.dev,sameSize:before.size===after.size,
          sameMtime:before.mtimeMs===after.mtimeMs,changedCtime:before.ctimeMs!==after.ctimeMs};}
      return count;
    };
    fs.closeSync=fd=>{closed++;return real.closeSync(fd);};syncBuiltinESMExports();
    assert.throws(()=>readCorpusBytes(path),/changed during capture/);
    assert.deepEqual(mutation,{sameInode:true,sameDev:true,sameSize:true,sameMtime:true,changedCtime:true});
    assert.equal(reads,2);assert.equal(closed,1);
    evidence={controlledInterception:true,mutation,reads,closed};
  `);
  assert.equal(result.mutation.changedCtime, true); assert.equal(result.reads, 2);
});

test("corpus descriptor snapshot reads the opened inode rather than a replacement pathname", () => {
  const result = corpusProbe(`
    const saved=join(home,"opened"),sentinel=join(home,"sentinel");fs.writeFileSync(sentinel,"FORBIDDEN");
    let opened=0,reads=0;
    fs.openSync=(...args)=>{const fd=real.openSync(...args);opened++;
      fs.renameSync(path,saved);fs.symlinkSync(sentinel,path);return fd;};
    fs.readSync=(...args)=>{reads++;return real.readSync(...args);};syncBuiltinESMExports();
    assert.equal(readCorpusBytes(path).bytes.toString(),"ORIGINAL");
    assert.equal(opened,1);assert.equal(reads,1);assert.equal(fs.readFileSync(path,"utf8"),"FORBIDDEN");
    evidence={opened,reads,replacementNotRead:true};
  `);
  assert.equal(result.replacementNotRead, true);
});

test("corpus descriptor snapshot accepts stable partial reads and refuses EOF growth and truncation", () => {
  const result = corpusProbe(`
    let partialReads=0;fs.readSync=(fd,b,o,n,p)=>{partialReads++;return real.readSync(fd,b,o,Math.min(2,n),p);};
    syncBuiltinESMExports();assert.equal(readCorpusBytes(path).bytes.toString(),"ORIGINAL");assert.equal(partialReads,4);
    for(const kind of ["EOF","growth","truncation"]){reset();let reads=0;
      fs.readSync=(fd,b,o,n,p)=>{reads++;if(reads===1){
        const got=real.readSync(fd,b,o,Math.min(2,n),p);
        if(kind==="growth")fs.appendFileSync(path,"extra");if(kind==="truncation")fs.truncateSync(path,2);return got;}
        return kind==="EOF"?0:real.readSync(fd,b,o,n,p);};syncBuiltinESMExports();
      assert.throws(()=>readCorpusBytes(path),/changed during capture/);assert.ok(reads>=2);
    }
    evidence={partialReads,refused:["EOF","growth","truncation"]};
  `);
  assert.equal(result.partialReads, 4); assert.equal(result.refused.length, 3);
});

test("corpus descriptor metadata must remain observable and device-bound", () => {
  const result = corpusProbe(`
    let refused=0;
    for(const change of [{ctimeMs:NaN},{dev:undefined},{ino:2**53}]){
      fs.fstatSync=fd=>Object.assign(real.fstatSync(fd),change);syncBuiltinESMExports();
      assert.throws(()=>readCorpusBytes(path),/bounded regular/);refused++;
    }
    let stats=0;fs.fstatSync=fd=>{const s=real.fstatSync(fd);if(++stats===2)s.dev++;return s;};
    syncBuiltinESMExports();assert.throws(()=>readCorpusBytes(path),/changed during capture/);assert.equal(stats,2);
    evidence={simulatedMetadata:true,refused,deviceChangeRefused:true};
  `);
  assert.equal(result.refused, 3); assert.equal(result.deviceChangeRefused, true);
});

test("corpus FIFO without writer refuses as nonregular within a hard child deadline", () => {
  const result = corpusProbe(`
    // Fixture creation shares the enclosing 1500ms deadline; a shorter setup bound can fail before the read is tested.
    const made=spawnSync("mkfifo",[path+".fifo"],{encoding:"utf8",timeout:1500});
    assert.equal(made.error,undefined,made.error?.message);assert.equal(made.signal,null);assert.equal(made.status,0,made.stderr);
    assert.equal(fs.lstatSync(path+".fifo").isFIFO(),true);
    let closed=0;fs.closeSync=fd=>{closed++;return real.closeSync(fd);};syncBuiltinESMExports();
    assert.throws(()=>readCorpusBytes(path+".fifo"),/bounded regular/);assert.equal(closed,1);
    evidence={realFIFO:true,closed};
  `, 1500);
  assert.equal(result.realFIFO, true); assert.equal(result.closed, 1);
});

test("corpus descriptors close on refusals and propagate open stat read and close errors", () => {
  const result = corpusProbe(`
    let cases=0;
    for(const kind of ["success","oversize","empty","directory","stat","read","close"]){
      Object.assign(fs,real);reset();if(kind==="empty")fs.writeFileSync(path,"");
      let fd,closed=0;fs.openSync=(...args)=>fd=real.openSync(...args);
      fs.closeSync=value=>{real.closeSync(value);closed++;if(kind==="close")throw Error("controlled close failure");};
      if(kind==="stat")fs.fstatSync=()=>{throw Error("controlled stat failure");};
      if(kind==="read")fs.readSync=()=>{throw Error("controlled read failure");};syncBuiltinESMExports();
      if(kind==="success")assert.equal(readCorpusBytes(path).bytes.length,8);
      else assert.throws(()=>readCorpusBytes(kind==="directory"?home:path,kind==="oversize"?1:8),
        kind==="stat"?/controlled stat/:kind==="read"?/controlled read/:kind==="close"?/controlled close/:/bounded regular/);
      assert.equal(closed,1);assert.throws(()=>real.fstatSync(fd),{code:"EBADF"});cases++;
    }
    Object.assign(fs,real);syncBuiltinESMExports();assert.throws(()=>readCorpusBytes(path+".absent"),{code:"ENOENT"});
    const alias=join(home,"alias");fs.symlinkSync(path,alias);assert.throws(()=>readCorpusBytes(alias),/bounded regular/);
    evidence={closedCases:cases,openErrorsRefused:true};
  `);
  assert.equal(result.closedCases, 7); assert.equal(result.openErrorsRefused, true);
});
