import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { formatReservationAnchorMessage } from "#src/lib/task-id-reservation.js";
import { describeMint, mintNextTaskId } from "#src/lib/task-id.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function plan(id: number): string {
  return `- id: W1-T${id}\n  title: fixture task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n`;
}
function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "ops-id-namespace").dir;
  const origin = gitRepo({ bare: true, scope: t, kind: "public-id-origin" });
  const pub = gitRepo({ scope: t, kind: "public-id-reader" });
  pub.addRemote("origin", origin.dir);
  const publicPlan = join(pub.dir, "plan/tasks.yaml");
  put(publicPlan, plan(100));
  pub.git("add", "plan/tasks.yaml"); pub.git("commit", "-qm", "public plan");
  pub.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const opsOrigin = gitRepo({ bare: true, scope: t, kind: "ops-id-origin" });
  const ops = join(root, "repos", "fixture-ops");
  pub.git("clone", "--quiet", opsOrigin.dir, ops);
  const opsPlan = join(ops, "plan/tasks.yaml");
  put(opsPlan, plan(200));
  pub.git("-C", ops, "add", "plan/tasks.yaml"); pub.git("-C", ops, "commit", "-qm", "ops plan");
  pub.git("-C", ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const state = join(root, "state");
  const switchPath = join(state, "plan-destination.json");
  put(switchPath, JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: [] }));
  return { root, origin, pub, opsOrigin, ops, publicPlan, opsPlan, state, switchPath };
}

// Run the actual exported command in a normal child, without importing the monolithic CLI into the test runner.
// Every git writer is confined to the two disposable bare fixtures; a reap deletion is trapped before it runs.
const CHILD = String.raw`
const req=JSON.parse(process.env.RMD_OPS_ID_CASE);
const {spawnSync}=await import('node:child_process');
const mod=await import(req.source+'/src/run-task.ts');
const reservations=await import(req.source+'/src/lib/task-id-reservation.ts');
const calls=[],out=[],err=[];console.log=(...a)=>out.push(a.join(' '));console.error=(...a)=>err.push(a.join(' '));
const runGit=(args)=>{calls.push({root:req.pub,args});if(args[0]==='push'&&args.some(x=>x.startsWith(':refs/rmd-id/')))throw Error('forbidden reservation deletion');const r=spawnSync('git',['-C',req.pub,...args],{encoding:'utf8'});return{status:r.status,stdout:r.stdout??'',stderr:r.stderr??''};};
const deps={repoRoot:req.pub,runGit,openPrTexts:()=>[],destinationStateDir:()=>req.state,
 destinationPrFetch:(args)=>{calls.push({root:'ops-gh',args});if(req.prFailure)throw Error('private response must not escape');const page=Number(/[?&]page=(\d+)/.exec(args[1])?.[1]??'1');return(req.prPages?.[page-1]??(page===1?req.prTexts??[]:[])).map((text,i)=>({number:(page-1)*100+i+1,title:text,body:'',state:'open',head:{ref:'ops-plan-'+((page-1)*100+i),sha:'a'.repeat(40)},created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z'}));},
 destinationGit:(cwd,args,input)=>{calls.push({root:cwd,args});if(req.fetchFailure)throw Error('private fetch response must not escape');const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',input});if(r.status!==0)throw Error('fixture destination git failed');return r.stdout;},
 auditHistoryIds:()=>[],auditPullRequests:()=>req.auditPulls??[],auditNowMs:()=>Date.now(),reapLedgerPath:req.root+'/reap-ledger.ndjson'};
if(req.defaultGit)delete deps.destinationGit;
if(req.defaultPr)delete deps.destinationPrFetch;
if(req.reserve)deps.reserver=reservations.gitRemoteRefReserver({run:mod.gitRunAdapter(runGit),filingBranch:'fixture-plan'});
const {existsSync}=await import('node:fs');let asyncTicks=0;
const timer=req.observePrivateFetch?setInterval(()=>{if(existsSync(req.observePrivateFetch+'-start')&&!existsSync(req.observePrivateFetch+'-done'))asyncTicks++;},10):undefined;
let code;try{if(req.learningMode){if(req.learningMode==='mint-refusal'){const mint=mod.ciLearningTaskIdMinter(req.pub,undefined,undefined,{destinationSnapshot:null,destinationFailure:'plan destination is unreadable at fetch'});mint('fixture');code=0;}else if(req.learningMode==='default-command'){code=await mod.ciLearningCommandWithDestination(['--days','0'],deps);}else{code=await mod.ciLearningCommandWithDestination([],deps,(_args,prepared)=>{out.push(JSON.stringify({ids:prepared.destinationSnapshot?.ids??null,failure:prepared.destinationFailure??null}));return 0;});}}else if(req.historyMode){const mint=await(req.historyMode==='async'?mod.mintNextTaskIdWithHistoryAsync:mod.mintNextTaskIdWithHistory)({planPath:req.pub+'/plan/tasks.yaml',repoRoot:req.pub,openPrTexts:()=>[],destination:deps});out.push(mint.id);code=0;}else code=await mod.nextTaskIdCommand(req.flags??['--no-reserve'],{},deps);}catch(error){err.push(error.message);code=2;}finally{if(timer)clearInterval(timer);}
process.stdout.write(JSON.stringify({code,out,err,calls,asyncTicks})+'\n');
`;
interface FixturePull { body: string; head: { ref: string }; created_at: string; state: string; }
interface CaseOptions { auditPulls?: FixturePull[]; flags?: string[]; reserve?: boolean; prTexts?: string[]; prPages?: string[][]; prFailure?: boolean; fetchFailure?: boolean; defaultGit?: boolean; defaultPr?: boolean; observePrivateFetch?: string; gitBin?: string; historyMode?: "async" | "sync"; learningMode?: "observe" | "default-command" | "mint-refusal"; }
function invoke(f: ReturnType<typeof fixture>, options: CaseOptions = {}) {
  const r = spawnSync(process.execPath, ["--enable-source-maps", "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", CHILD], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: options.gitBin ? options.gitBin + delimiter + process.env.PATH : process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      RMD_GH_CACHE_HOME: join(f.root, "gh-cache"), RMD_OPS_ID_CASE: JSON.stringify({ source: REPO_ROOT, root: f.root, pub: f.pub.dir, state: f.state, ...options }) },
  });
  assert.equal(r.error, undefined, "the command child terminates within its test bound");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()) as { code: number; out: string[]; err: string[]; calls: Array<{ root: string; args: string[] }>; asyncTicks: number };
}

test("W1-T12206 criterion 1: the library includes an explicitly supplied second plan and its open PRs", (t) => {
  const f = fixture(t);
  const result = mintNextTaskId({ planPath: f.publicPlan,
    additionalPlanTexts: () => [readFileSync(f.opsPlan, "utf8")], additionalOpenPrTexts: () => ["W1-T201"] });
  assert.equal(result.id, "W1-T202");
  assert.match(describeMint(result), /destination plan 200/);
});

test("W1-T12206 criterion 1: the real command fetches the named catalog and counts its open PRs even with no kinds enabled", (t) => {
  const f = fixture(t);
  const r = invoke(f, { prTexts: ["W1-T201"] });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /^W1-T202 /m);
  assert.ok(r.calls.some(c => c.root === f.ops && c.args[0] === "fetch"));
});

test("W1-T12206 criterion 2: the existing real reserver writes only the public origin namespace", (t) => {
  const f = fixture(t); const r = invoke(f, { reserve: true, flags: ["--reserve"], prTexts: ["W1-T201"] });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /^RESERVED W1-T202 on origin/m);
  assert.match(f.origin.git("rev-parse", "refs/rmd-id/W1-T202"), /^[a-f0-9]{40}$/);
  assert.equal(f.opsOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/"), "");
});

test("W1-T12206 criterion 3: an ops-filed id is HELD by both audit and reap, without a deletion attempt", (t) => {
  const f = fixture(t);
  const day = 24 * 60 * 60 * 1000, now = Date.now();
  const message = (branch: string) => formatReservationAnchorMessage({ branch, startedAt: new Date(now - 20 * day).toISOString() });
  const sha = f.pub.git("commit-tree", "HEAD^{tree}", "-m", message("ops-filing"));
  const sample = f.pub.git("commit-tree", "HEAD^{tree}", "-m", message("public-sample"));
  f.pub.git("push", "--quiet", "origin", `${sha}:refs/rmd-id/W1-T200`, `${sample}:refs/rmd-id/W1-T100`);
  const auditPulls = [{ body: "Remudero-Task: W1-T100", head: { ref: "public-sample" },
    created_at: new Date(now - 19 * day).toISOString(), state: "closed" }];
  const audit = invoke(f, { flags: ["--audit"] });
  assert.equal(audit.code, 0, audit.err.join("\n"));
  assert.match(audit.out.join("\n"), /W1-T200 HELD.*(declared|filed)/);
  const reap = invoke(f, { flags: ["--audit", "--reap", "--apply"], auditPulls });
  assert.equal(reap.code, 0, JSON.stringify(reap));
  assert.match(reap.out.join("\n"), /W1-T200 HELD.*(declared|filed)/);
  assert.equal(f.origin.git("rev-parse", "refs/rmd-id/W1-T200"), sha);
  assert.equal(reap.calls.some(c => c.args[0] === "push"), false);
});

test("W1-T12206 criterion 4: a failed destination fetch or PR read refuses the mint before a reservation", (t) => {
  const f = fixture(t);
  for (const failure of [{ fetchFailure: true }, { prFailure: true }]) {
    const r = invoke(f, { ...failure, reserve: true, flags: ["--reserve"] });
    assert.equal(r.code, 2, JSON.stringify(r));
    assert.match(r.err.join("\n"), /destination.*(unreadable|fetch|pull|PR)/i);
    assert.equal(r.out.some(s => /^(W1-T|RESERVED )/.test(s)), false);
    assert.equal(r.calls.some(c => c.args[0] === "push"), false);
    assert.doesNotMatch(r.err.join("\n"), /private .* must not escape/);
  }
});

test("W1-T12206 criterion 4: missing or malformed destination plan bytes are not an empty catalog", (t) => {
  const f = fixture(t);
  put(f.opsPlan, "malformed: [\n");
  f.pub.git("-C", f.ops, "add", "plan/tasks.yaml"); f.pub.git("-C", f.ops, "commit", "-qm", "malformed plan");
  f.pub.git("-C", f.ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const r = invoke(f);
  assert.equal(r.code, 2, JSON.stringify(r));
  assert.match(r.err.join("\n"), /destination.*(unreadable|malformed|plan)/i);
  assert.equal(r.out.some(s => /^W1-T/.test(s)), false);
});

test("W1-T12206 criterion 5: no host switch preserves the legacy id and performs no destination read", (t) => {
  const f = fixture(t);
  // A configured instance with no destination file has the same off behavior as an unconfigured instance.
  unlinkSync(f.switchPath);
  const r = invoke(f, { fetchFailure: true, prFailure: true });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /^W1-T101 /m);
  assert.equal(r.calls.some(c => c.root === f.ops), false);
});


test("W1-T12206 criterion 1: the maintained open-PR walker reads the second page", (t) => {
  const f = fixture(t);
  const r = invoke(f, { prPages: [Array.from({ length: 100 }, () => "fixture without an id"), ["W1-T201"]] });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /^W1-T202 /m);
  assert.ok(r.calls.some(c => c.root === "ops-gh" && /[?&]page=2(?:&|$)/.test(c.args[1])));
});

test("W1-T12206 criterion 4: explicit offline mode never guesses when a second catalog is selected", (t) => {
  const f = fixture(t); const r = invoke(f, { flags: ["--offline"] });
  assert.equal(r.code, 2, JSON.stringify(r));
  assert.match(r.err.join("\n"), /destination.*offline/i);
  assert.equal(r.calls.some(c => c.root === f.ops || c.root === "ops-gh" || c.args[0] === "push"), false);
});

test("W1-T12206 criterion 1: default bounded Git reads the fetched commit rather than stale checkout bytes", (t) => {
  const f = fixture(t);
  put(f.opsPlan, plan(220)); f.pub.git("-C", f.ops, "add", "plan/tasks.yaml");
  f.pub.git("-C", f.ops, "commit", "-qm", "new ops generation");
  f.pub.git("-C", f.ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  put(f.opsPlan, plan(100)); // Deliberately stale/dirty checkout bytes must not lower the committed ceiling.
  const r = invoke(f, { defaultGit: true });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /^W1-T221 /m);
});

test("W1-T12206 criterion 1: the default GitHub transport uses the actual selected repository", async (t) => {
  const f = fixture(t);
  const rows = [{ number: 1, title: "W1-T201", body: "", state: "open", head: { ref: "ops-filing", sha: "a".repeat(40) },
    updated_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z" }];
  await withGhShim([{ when: "fixture/control", stdout: "controlled" },
    { when: "repos/fixture-owner/fixture-ops/pulls?", stdout: JSON.stringify(rows) }], shim => {
    // Exercise the same shipped transport as the default reader instead of a separate raw executable launch.
    const controlProgram = `const {ghExec}=await import(${JSON.stringify(join(REPO_ROOT, "src/lib/github-transport.ts"))});process.stdout.write(ghExec(["api","fixture/control"],{encoding:"utf8",timeout:10000}));`;
    const control = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", controlProgram], {
      env: { ...process.env, RMD_GH_CACHE_HOME: join(f.root, "control-gh-cache") }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(control.status, 0); assert.equal(control.stdout.trim(), "controlled");
    const r = invoke(f, { defaultPr: true, defaultGit: true });
    assert.equal(r.code, 0, r.err.join("\n")); assert.match(r.out.join("\n"), /^W1-T202 /m);
    assert.ok(shim.calls().some(c => c.includes("repos/fixture-owner/fixture-ops/pulls?")));
    assert.equal(shim.calls().some(c => /(?:pr (?:create|merge|close)|--method (?:POST|PATCH|DELETE))/.test(c)), false);
  });
});

test("W1-T12206 criterion 3: a still-open ops filing protects its public reservation", (t) => {
  const f = fixture(t);
  const sha = f.pub.git("commit-tree", "HEAD^{tree}", "-m", "reserve W1-T201 fixture");
  f.pub.git("push", "--quiet", "origin", `${sha}:refs/rmd-id/W1-T201`);
  for (const flags of [["--audit"], ["--audit", "--reap"]]) {
    const r = invoke(f, { flags, prTexts: ["Remudero-Task: W1-T201"] });
    assert.match(r.out.join("\n"), /W1-T201 HELD.*open PR/);
    assert.equal(r.calls.some(c => c.args[0] === "push"), false);
    assert.equal(f.origin.git("rev-parse", "refs/rmd-id/W1-T201"), sha);
  }
});

test("W1-T12206 criterion 4: malformed host selection refuses without reading another repository", (t) => {
  const f = fixture(t); put(f.switchPath, "not json"); const r = invoke(f);
  assert.equal(r.code, 2, JSON.stringify(r)); assert.match(r.err.join("\n"), /destination.*switch/);
  assert.equal(r.calls.some(c => c.root === f.ops || c.root === "ops-gh"), false);
  assert.doesNotMatch(r.err.join("\n"), new RegExp(f.root));
});

test("W1-T12206 criterion 4: duplicate private ids are refused, while public dependency edges stay readable", (t) => {
  const f = fixture(t); put(f.opsPlan, plan(200).replace("depends_on: []", "depends_on: [W1-T100]"));
  f.pub.git("-C", f.ops, "add", "plan/tasks.yaml"); f.pub.git("-C", f.ops, "commit", "-qm", "public dependency");
  f.pub.git("-C", f.ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const healthy = invoke(f); assert.equal(healthy.code, 0, healthy.err.join("\n"));
  put(join(f.ops, "plan/tasks.d/duplicate.yaml"), plan(200));
  f.pub.git("-C", f.ops, "add", "plan/tasks.d/duplicate.yaml"); f.pub.git("-C", f.ops, "commit", "-qm", "duplicate id");
  f.pub.git("-C", f.ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const r = invoke(f); assert.equal(r.code, 2, JSON.stringify(r)); assert.match(r.err.join("\n"), /destination.*plan/);
  assert.equal(r.out.some(s => /^W1-T/.test(s)), false);
});


test("W1-T12206 criterion 1: the real default private Git fetch yields the caller loop", t => {
  const f = fixture(t); const marker = join(f.root, "private-fetch"); const bin = join(f.root, "git-bin");
  mkdirSync(bin);
  const program = `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const args=process.argv.slice(2), fetching=args.includes('fetch');
if(fetching)writeFileSync(${JSON.stringify(marker + "-start")},'started');
const launch=()=>{const p=spawn('/usr/bin/git',args,{stdio:'inherit'});p.on('error',()=>process.exit(127));p.on('exit',code=>{if(fetching)writeFileSync(${JSON.stringify(marker + "-done")},'done');process.exit(code??1);});};
if(fetching)setTimeout(launch,300);else launch();`;
  writeFileSync(join(bin, "git"), "#!" + process.execPath + "\n" + program, { mode: 0o700, flag: "wx" });
  const r = invoke(f, { defaultGit: true, observePrivateFetch: marker, gitBin: bin });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(readFileSync(marker + "-start", "utf8"), "started");
  assert.equal(readFileSync(marker + "-done", "utf8"), "done");
  assert.ok(r.asyncTicks > 0, "the caller timer must advance while the actual private fetch is pending");
});


test("W1-T12206 criterion 1: the shared awaited minter includes the destination for every writer", t => {
  const f = fixture(t); const healthy = invoke(f, { historyMode: "async", prTexts: ["W1-T201"] });
  assert.equal(healthy.code, 0, healthy.err.join("\n")); assert.equal(healthy.out[0], "W1-T202");
  const unavailable = invoke(f, { historyMode: "async", fetchFailure: true });
  assert.equal(unavailable.code, 2); assert.match(unavailable.err.join("\n"), /destination.*fetch/);
  assert.deepEqual(unavailable.out, []); assert.equal(unavailable.calls.some(c => c.args[0] === "push"), false);
});

test("W1-T12206 criterion 4: a synchronous writer cannot omit a named catalog's awaited population", t => {
  const f = fixture(t); const r = invoke(f, { historyMode: "sync" });
  assert.equal(r.code, 2); assert.match(r.err.join("\n"), /destination needs an awaited snapshot/);
  assert.deepEqual(r.out, []); assert.deepEqual(r.calls, []);
});


test("W1-T12206 criterion 1: the production learning entry preserves its prepared population and failure stage", t => {
  const f = fixture(t); const healthy = invoke(f, { learningMode: "observe" });
  assert.equal(healthy.code, 0); assert.deepEqual(JSON.parse(healthy.out[0]!), { ids: ["W1-T200"], failure: null });
  const unavailable = invoke(f, { learningMode: "observe", fetchFailure: true });
  assert.equal(unavailable.code, 0); assert.deepEqual(JSON.parse(unavailable.out[0]!), { ids: null, failure: "plan destination is unreadable at fetch" });
  const command = invoke(f, { learningMode: "default-command" });
  assert.equal(command.code, 2); assert.match(command.err.join("\n"), /--days must be a positive number/);
});

test("W1-T12206 criterion 4: a learning report's deferred failure stops its minter before any reservation", t => {
  const f = fixture(t); const r = invoke(f, { learningMode: "mint-refusal" });
  assert.equal(r.code, 2); assert.match(r.err.join("\n"), /destination is unreadable at fetch/);
  assert.deepEqual(r.calls, []); assert.deepEqual(r.out, []);
});
