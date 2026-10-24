/** Actual generated-cache entrypoint and real private Git/filesystem fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("deploy/mac/cache-reclaim.py");
const retire = resolve("deploy/mac/retire-legacy-sweeper.py");
function receipt(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr) + String(result.stdout));
  const line = String(result.stdout).split("\n").find(line => line.startsWith("cache-reclaim: "));
  assert.ok(line, String(result.stdout));
  return JSON.parse(line.slice("cache-reclaim: ".length));
}
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-cache-safety-")));
  mkdirSync(join(home, "tmp"));
  const root = join(home, ".codex/work-artifacts/session"); mkdirSync(root, { recursive: true });
  const git = (path: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const workspace = (name: string) => {
    const path = join(root, name); mkdirSync(path);
    git(path, "init", "-q"); git(path, "config", "user.name", "fixture"); git(path, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(path, "package.json"), '{"private":true,"dependencies":{"next":"16.4.0"}}\n');
    writeFileSync(join(path, ".gitignore"), "node_modules/\n.next/\nstate/\n");
    git(path, "add", "."); git(path, "commit", "-qm", "fixture source");
    return path;
  };
  const packages = (path: string, result: string) => {
    const modules = join(path, "node_modules"); mkdirSync(join(modules, "pkg"), { recursive: true });
    mkdirSync(join(modules, ".vite/vitest"), { recursive: true });
    writeFileSync(join(modules, ".package-lock.json"), '{"lockfileVersion":3}\n');
    writeFileSync(join(modules, "pkg/index.js"), "export default 1;\n");
    writeFileSync(join(modules, ".vite/vitest/results.json"), result);
    writeFileSync(join(modules, ".rmd-dependency-seed.json"), JSON.stringify({ checkout: path }));
    return modules;
  };
  const cache = (path: string) => {
    const dir = join(path, ".next/cache/turbopack/v16"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001.sst"), "generated compiler DB\n");
    writeFileSync(join(path, ".next/cache/.previewinfo"), "retain preview metadata\n");
    mkdirSync(join(path, ".next/server")); writeFileSync(join(path, ".next/server/compiled.js"), "retain compiled evidence\n");
    return join(path, ".next/cache/turbopack");
  };
  const run = (code = "", old = true, apply = true, cwdReadError = false) => {
    // ctime cannot be backdated. Shift only this private Python process's
    // clock; the actual CLI test below uses the real default clock instead.
    const program = `import runpy,os,time,sys,pathlib,json\nns=runpy.run_path(os.environ['CACHE_SCRIPT'])\n` +
      (cwdReadError ? "host_command=ns['main'].__globals__['command']\ndef unavailable_cwd(argv):\n if argv==['lsof','-nP','-a','-d','cwd','-Fn']:return ns['subprocess'].CompletedProcess(argv,1,'','controlled unread cwd inventory')\n return host_command(argv)\nns['main'].__globals__['command']=unavailable_cwd\n" : "") +
      (old ? "observed=time.time();ns['time'].time=lambda:observed+8*3600\n" : "") + code +
      `\nsys.exit(ns['main'](['--home',os.environ['CACHE_HOME']]${apply ? "+['--apply']" : ""}))\n`;
    return spawnSync("python3", ["-c", program], { encoding: "utf8", timeout: 45_000,
      env: { ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CACHE_HOME: home, CACHE_SCRIPT: script } });
  };
  return { home, root, workspace, packages, cache, run, git };
}

test("artifact cache cleanup preserves unpublished source, unique Vitest results, receipts and a full dependency anchor", () => {
  const fx = fixture();
  try {
    const a = fx.workspace("a-anchor"), b = fx.workspace("b-duplicate");
    const am = fx.packages(a, "anchor result"), bm = fx.packages(b, "unique candidate result");
    writeFileSync(join(b, "private.ts"), "unpublished source\n");
    mkdirSync(join(b, "state")); writeFileSync(join(b, "state/openweight-allowance.json"), '{"uncertain":"held"}\n');
    const marker = readFileSync(join(bm, ".rmd-dependency-seed.json"));
    const r = fx.run(); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(am, "pkg/index.js")), r.stdout);
    assert.equal(existsSync(join(bm, "pkg/index.js")), false, r.stdout);
    assert.equal(readFileSync(join(bm, ".vite/vitest/results.json"), "utf8"), "unique candidate result");
    assert.deepEqual(readFileSync(join(bm, ".rmd-dependency-seed.json")), marker);
    assert.equal(readFileSync(join(b, "private.ts"), "utf8"), "unpublished source\n");
    assert.equal(readFileSync(join(b, "state/openweight-allowance.json"), "utf8"), '{"uncertain":"held"}\n');
    assert.equal(fx.git(b, "status", "--porcelain").trim(), "?? private.ts");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache cleanup removes only Turbopack cache and preserves preview metadata and compiled evidence", () => {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const r = fx.run(); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(cache), false, r.stdout);
    assert.equal(readFileSync(join(p, ".next/cache/.previewinfo"), "utf8"), "retain preview metadata\n");
    assert.equal(readFileSync(join(p, ".next/server/compiled.js"), "utf8"), "retain compiled evidence\n");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache real CLI preserves the fixed six-hour mtime and ctime rule", () => {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const r = spawnSync("python3", [script, "--home", fx.home, "--apply"], { encoding: "utf8", env: { ...process.env, HOME: fx.home, TMPDIR: join(fx.home, "tmp") } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(cache)); assert.match(r.stdout, /recent-foreign-or-flagged/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache cleanup preserves shared references, unique package changes and parent symlink targets", () => {
  const fx = fixture();
  try {
    const a = fx.workspace("a-anchor"), b = fx.workspace("b-shared"), c = fx.workspace("c-unique");
    fx.packages(a, "a"); const bm = fx.packages(b, "b"), cm = fx.packages(c, "c");
    writeFileSync(join(cm, "pkg/index.js"), "unpublished package modification\n");
    const consumer = join(fx.home, "rmd-work/consumer"); mkdirSync(consumer, { recursive: true }); symlinkSync(bm, join(consumer, "node_modules"));
    const external = join(fx.home, "external/cache/turbopack"); mkdirSync(external, { recursive: true }); writeFileSync(join(external, "keep.sst"), "shared\n");
    const p = fx.workspace("symlink-parent"); mkdirSync(join(p, ".next")); symlinkSync(join(fx.home, "external/cache"), join(p, ".next/cache"));
    const sharedProject = fx.workspace("shared-project"), sharedCache = fx.cache(sharedProject);
    symlinkSync(sharedProject, join(consumer, "project-alias"));
    const r = fx.run(); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(bm, "pkg/index.js")), r.stdout);
    assert.equal(readFileSync(join(cm, "pkg/index.js"), "utf8"), "unpublished package modification\n");
    assert.ok(existsSync(join(external, "keep.sst")), r.stdout); assert.match(r.stdout, /shared-reference/);
    assert.ok(existsSync(sharedCache), r.stdout);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache dry run and inspection budget never delete generated data", () => {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const preview = fx.run("", true, false); assert.equal(preview.status, 0, preview.stderr + preview.stdout);
    assert.match(preview.stdout, /would-remove/); assert.ok(existsSync(cache));
    const bounded = fx.run("ns['main'].__globals__['MAX_ENTRIES']=1"); assert.equal(bounded.status, 0, bounded.stderr + bounded.stdout);
    assert.match(bounded.stdout, /inspection-budget/); assert.ok(existsSync(cache));
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache streaming scan charges flat-directory children and reports entry exhaustion", () => {
  const fx = fixture();
  try {
    for (let n = 0; n < 40; n++) writeFileSync(join(fx.root, `entry-${n}`), "untouched");
    const report = receipt(fx.run("ns['main'].__globals__['MAX_ENTRIES']=12", true, false));
    assert.equal(report.entriesInspected, 12);
    assert.equal(report.bytesRead, report.inspection.progress.metadataBytesRead, "only checkpoint metadata, never payload contents");
    assert.equal(report.inspection.discoveryComplete, false);
    assert.equal(report.inspection.exhausted.limit, "entries");
    assert.equal(report.inspection.exhausted.stage, "discovery");
    assert.equal(report.inspection.undiscoveredCandidateCount, null);
    const scans = report.inspection.scans;
    assert.equal(scans.reduce((sum: number, row: any) => sum + row.entriesInspected, 0), 12);
    assert.ok(scans[0].childrenEnumerated > 0 && scans[0].childrenEnumerated <= 12);
    assert.equal(scans[0].complete, false);
    assert.equal(readFileSync(join(fx.root, "entry-39"), "utf8"), "untouched");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache streaming scan checks wall budget within one flat directory", () => {
  const fx = fixture();
  try {
    for (let n = 0; n < 40; n++) writeFileSync(join(fx.root, `entry-${n}`), "untouched");
    const report = receipt(fx.run(String.raw`clock=[0.0];ns['time'].monotonic=lambda:clock[0]
original=ns['os'].scandir
class TimedEntries:
 def __init__(self,fd):self.entries=original(fd)
 def __enter__(self):self.entries.__enter__();return self
 def __exit__(self,*args):return self.entries.__exit__(*args)
 def __iter__(self):return self
 def __next__(self):
  entry=next(self.entries);clock[0]+=20;return entry
ns['os'].scandir=TimedEntries`, true, false));
    assert.equal(report.inspection.exhausted.limit, "seconds");
    assert.equal(report.inspection.discoveryComplete, false);
    assert.ok(report.inspection.scans[0].childrenEnumerated <= 3);
    assert.ok(report.entriesInspected < 10);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache interrupted discovery retains known candidate rows without reference clearance", () => {
  const fx = fixture();
  try {
    const modules = fx.packages(fx.workspace("candidate"), "private result");
    const report = receipt(fx.run(String.raw`g=ns['main'].__globals__;original=g['directory_entries']
def interrupted(*args,**kwargs):
 for row in original(*args,**kwargs):
  yield row
  if row[0].name=='node_modules':raise ns['Hold']('inspection-budget')
g['directory_entries']=interrupted
def forbidden(*args):raise AssertionError('incomplete discovery reached reference or removal inspection')
g['references']=forbidden;g['old_owned']=forbidden`));
    assert.equal(report.inspection.discoveryComplete, false);
    assert.equal(report.inspection.discoveredCandidateCount, 1);
    assert.equal(report.inspection.deferredCandidateCount, 1);
    assert.equal(report.inspection.undiscoveredCandidateCount, null);
    const row = report.decisions.find((row: any) => row.path === modules);
    assert.equal(row.reason, "discovery-incomplete"); assert.equal(row.deferred, true);
    assert.ok(existsSync(join(modules, "pkg/index.js")));
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache incomplete reference corpus defers every candidate before payload inspection", () => {
  const fx = fixture();
  try {
    const cache = fx.cache(fx.workspace("candidate"));
    const flat = join(fx.home, "Remudero/flat"); mkdirSync(flat, { recursive: true });
    for (let n = 0; n < 40; n++) writeFileSync(join(flat, `entry-${n}`), "reference corpus");
    symlinkSync(cache, join(fx.home, "tmp/late-shared-cache"));
    const report = receipt(fx.run(String.raw`g=ns['main'].__globals__;original=g['references']
def bounded(home,candidates,budget):
 g['MAX_ENTRIES']=budget.entries+8
 return original(home,candidates,budget)
def forbidden(*args):raise AssertionError('partial references reached payload inspection')
g['references']=bounded;g['old_owned']=forbidden`));
    assert.equal(report.inspection.discoveryComplete, true);
    assert.equal(report.inspection.referencesRequired, true);
    assert.equal(report.inspection.referencesComplete, false);
    assert.equal(report.inspection.exhausted.stage, "references");
    assert.equal(report.inspection.exhausted.root, join(fx.home, "Remudero"));
    assert.equal(report.inspection.deferredCandidateCount, 1);
    assert.equal(report.decisions.find((row: any) => row.path === cache).reason, "reference-corpus-incomplete");
    assert.ok(existsSync(cache)); assert.equal(report.bytesRead, report.inspection.progress.metadataBytesRead, "only checkpoint metadata, never payload contents");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("artifact cache reference errors and directory symlink swaps fail closed without following the replacement", () => {
  for (const variant of ["error", "swap", "changed"]) {
    const fx = fixture();
    try {
      const cache = fx.cache(fx.workspace("candidate"));
      mkdirSync(join(fx.home, "Developer/consumer"), { recursive: true });
      mkdirSync(join(fx.home, "external")); writeFileSync(join(fx.home, "external/private.txt"), "unpublished");
      const report = receipt(fx.run(String.raw`g=ns['main'].__globals__;home=pathlib.Path(os.environ['CACHE_HOME'])
external=home/'external';consumer=home/'Developer/consumer';original_scan=os.scandir;original_open=os.open
external_inode=external.stat().st_ino;consumer_inode=consumer.stat().st_ino;swapped=[False];writes=[0]
def scanned(fd):
 inode=os.fstat(fd).st_ino
 assert inode!=external_inode,'followed swapped directory symlink'
 if ${JSON.stringify(variant)}=='error' and inode==consumer_inode:raise PermissionError('private-reference-unreadable')
 # A namespace that settles is re-read (namespaceRetries); one that never settles still holds.
 if ${JSON.stringify(variant)}=='changed' and inode==consumer_inode:
  writes[0]+=1;(consumer/('new-private-%d.txt'%writes[0])).write_text('concurrent source')
 return original_scan(fd)
def opened(path,flags,*args,**kwargs):
 if ${JSON.stringify(variant)}=='swap' and path=='consumer' and not swapped[0]:
  swapped[0]=True;consumer.rename(consumer.with_name('held-consumer'));consumer.symlink_to(external,target_is_directory=True)
  assert flags & os.O_NOFOLLOW
 return original_open(path,flags,*args,**kwargs)
os.scandir=scanned;os.open=opened
def forbidden(*args):raise AssertionError('incomplete references reached payload inspection')
g['old_owned']=forbidden`));
      assert.equal(report.inspection.referencesComplete, false, variant);
      assert.equal(report.inspection.blockedStage, "references", variant);
      assert.equal(report.inspection.blockedRoot, join(fx.home, "Developer"), variant);
      assert.equal(report.inspection.deferredCandidateCount, 1, variant);
      assert.equal(report.decisions.find((row: any) => row.path === cache).reason, "reference-corpus-incomplete");
      assert.equal(readFileSync(join(fx.home, "external/private.txt"), "utf8"), "unpublished");
      assert.ok(existsSync(cache));
    } finally { rmSync(fx.home, { recursive: true, force: true }); }
  }
});

test("artifact cache young KEEP avoids global references while complete scans retain the final-root shared target", () => {
  const fx = fixture();
  try {
    const cache = fx.cache(fx.workspace("candidate"));
    const young = receipt(fx.run(String.raw`def forbidden(*args):raise AssertionError('young KEEP scanned global references')
ns['main'].__globals__['references']=forbidden`, false));
    assert.equal(young.inspection.prefilterKeepCount, 1);
    assert.equal(young.inspection.referencesRequired, false);
    assert.equal(young.inspection.referencesComplete, false);
    assert.equal(young.inspection.candidateEvaluationComplete, true);
    assert.equal(young.inspection.deferredCandidateCount, 0);
    assert.ok(!young.inspection.scans.some((row: any) => row.stage === "references"));
    symlinkSync(cache, join(fx.home, "tmp/last-root-shared-cache"));
    const shared = receipt(fx.run());
    assert.equal(shared.inspection.referencesComplete, true);
    assert.equal(shared.inspection.candidateEvaluationComplete, true);
    const roots = shared.inspection.scans.filter((row: any) => row.stage === "references");
    assert.deepEqual(roots.map((row: any) => row.root), ["Remudero", "rmd-work", "Developer", ".codex/work-artifacts", "tmp"].map(path => join(fx.home, path)));
    assert.ok(roots.every((row: any) => row.complete && row.elapsedMs >= 0));
    assert.equal(shared.decisions.find((row: any) => row.path === cache).reason, "shared-reference");
    assert.ok(existsSync(cache));
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

function stagingAndRemovalCase(cwdReadError = false) {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const liveness = String.raw`g=ns['main'].__globals__;real_command=g['command']
package=pathlib.Path(os.environ['CACHE_HOME'])/'.codex/work-artifacts/session/candidate/package.json'
def private_process_inventory(argv):
 if argv==['ps','-axww','-o','pid=,command=']:
  return ns['subprocess'].CompletedProcess(argv,0,str(os.getpid())+' private-cache-fixture\n','')
 if argv==['lsof','-nP','-a','-d','cwd','-Fn']:
  return ns['subprocess'].CompletedProcess(argv,0,'p'+str(os.getpid())+'\nn'+str(pathlib.Path.cwd())+'\n','')
 if argv==['lsof','-nP','-p',str(os.getpid()),'-Fn']:
  return ns['subprocess'].CompletedProcess(argv,0,'p'+str(os.getpid())+'\nn'+str(package)+'\n','')
 if argv==['lsof','-nP','+D',str(package.parent)]:
  return ns['subprocess'].CompletedProcess(argv,1,'','')
 return real_command(argv)
g['command']=private_process_inventory
`;
    const held = fx.run(liveness + String.raw`original=ns['main'].__globals__['inactive'];calls=0
def activity(workspace):
 global calls
 calls+=1
 if calls==3:raise ns['Hold']('active-after-staging')
 original(workspace)
ns['main'].__globals__['inactive']=activity`, true, true, cwdReadError);
    assert.equal(held.status, 0, held.stderr + held.stdout); assert.ok(existsSync(cache)); assert.match(held.stdout, /active-after-staging/);
    const changed = fx.run(liveness + String.raw`original=ns['shutil'].rmtree
def deletion(path):
 original(path)
 p=pathlib.Path(path).parents[2]/'after-removal.txt'
 p.write_text('external source writer')
deletion.avoids_symlink_attacks=original.avoids_symlink_attacks
ns['shutil'].rmtree=deletion`, true, true, cwdReadError);
    assert.equal(changed.status, 2, changed.stderr + changed.stdout); assert.match(changed.stdout, /removed-unverified/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
}

test("artifact cache cleanup restores staging when activity appears and reports post-removal uncertainty honestly", () => stagingAndRemovalCase());

test("the cache staging fixture reaches its lifecycle controls despite an unread host cwd inventory", () => stagingAndRemovalCase(true));

test("artifact cache probe errors retain data and never become successful deletions", () => {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const r = fx.run("ns['main'].__globals__['inactive']=lambda p: (_ for _ in ()).throw(ns['Hold']('cwd-query-unavailable'))");
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.ok(existsSync(cache)); assert.match(r.stdout, /cwd-query-unavailable/);
    const direct = spawnSync("python3", ["-c", "import runpy,sys; ns=runpy.run_path(sys.argv[1]);\ntry:ns['command'](['__rmd_missing_command__'])\nexcept ns['Hold']:sys.exit(0)\nsys.exit(1)", script], { encoding: "utf8" });
    assert.equal(direct.status, 0, direct.stderr);
    const unsupported = fx.run("ns['shutil'].rmtree=lambda path: None");
    assert.equal(unsupported.status, 0, unsupported.stderr + unsupported.stdout); assert.ok(existsSync(cache)); assert.match(unsupported.stdout, /fd-safe-removal-unavailable/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("legacy sweeper retirement identifies the exact job and never stops a process", () => {
  const fx = fixture();
  try {
    const program = String.raw`import runpy,pathlib,sys,plistlib,types
ns=runpy.run_path(sys.argv[1]);home=pathlib.Path(sys.argv[2]);p=home/'Library/LaunchAgents/com.craigoley.disk-sweep.plist';p.parent.mkdir(parents=True)
p.write_bytes(plistlib.dumps({'Label':ns['LABEL'],'ProgramArguments':ns['LEGACY_ARGS']}))
(home/'bin').mkdir();script=home/'bin/covtmp-sweep.zsh';script.write_bytes(b'known legacy fixture')
ns['retire'].__globals__['LEGACY_SCRIPT_SHA256']=ns['hashlib'].sha256(script.read_bytes()).hexdigest()
assert ns['retire'](home)['state']=='would-disable-identified-legacy-job'
p.write_bytes(plistlib.dumps({'Label':ns['LABEL'],'ProgramArguments':ns['LEGACY_ARGS'],'Program':ns['LEGACY_ARGS'][0]}))
assert ns['retire'](home)['state']=='would-disable-identified-legacy-job'
calls=[]
def run(argv,**kw):
 calls.append(argv)
 return types.SimpleNamespace(returncode=0,stdout='"com.craigoley.disk-sweep" => true',stderr='')
ns['subprocess'].run=run
result=ns['retire'](home,True)
assert result['state']=='disabled-legacy-job-plist-preserved',result
assert result['runningProcessesStopped']==0 and not p.exists() and pathlib.Path(result['archive']).is_file()
assert [a[1] for a in calls]==['disable','print-disabled'],calls
assert ns['retire'](home,True)['state']=='absent'
`;
    const r = spawnSync("python3", ["-c", program, retire, fx.home], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + r.stdout);
    const real = spawnSync("python3", [retire], { encoding: "utf8", env: { ...process.env, HOME: fx.home } }); assert.equal(real.status, 0, real.stderr + real.stdout); assert.match(real.stdout, /absent/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("legacy sweeper retirement refuses Program overrides without launchctl or plist changes", () => {
  const fx = fixture();
  try {
    const program = String.raw`import runpy,pathlib,sys,plistlib
ns=runpy.run_path(sys.argv[1]);home=pathlib.Path(sys.argv[2]);p=home/'Library/LaunchAgents/com.craigoley.disk-sweep.plist';p.parent.mkdir(parents=True)
(home/'bin').mkdir();script=home/'bin/covtmp-sweep.zsh';script.write_bytes(b'known legacy fixture')
ns['retire'].__globals__['LEGACY_SCRIPT_SHA256']=ns['hashlib'].sha256(script.read_bytes()).hexdigest()
calls=[]
def unexpected_launchctl(argv,**kw):
 calls.append(argv)
 raise AssertionError('a different executable must never reach launchctl')
ns['subprocess'].run=unexpected_launchctl
for value in ['/usr/bin/sleep','/bin/zsh ','',0,False,[],{}]:
 raw=plistlib.dumps({'Label':ns['LABEL'],'ProgramArguments':ns['LEGACY_ARGS'],'Program':value})
 p.write_bytes(raw);before=p.stat()
 for apply in [False,True]:
  result=ns['retire'](home,apply)
  assert result=={'state':'held-different-job','changed':False},(value,result)
  after=p.stat()
  assert p.read_bytes()==raw and (before.st_ino,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_mtime_ns,after.st_ctime_ns)
 assert list(p.parent.iterdir())==[p],list(p.parent.iterdir())
assert calls==[],calls
`;
    const r = spawnSync("python3", ["-c", program, retire, fx.home], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("legacy sweeper retirement verifies exact macOS disabled tokens and retains ambiguous evidence", () => {
  const fx = fixture();
  try {
    const program = String.raw`import runpy,pathlib,sys,plistlib,types
ns=runpy.run_path(sys.argv[1]);home=pathlib.Path(sys.argv[2]);p=home/'Library/LaunchAgents/com.craigoley.disk-sweep.plist';p.parent.mkdir(parents=True)
(home/'bin').mkdir();script=home/'bin/covtmp-sweep.zsh';script.write_bytes(b'known legacy fixture')
ns['retire'].__globals__['LEGACY_SCRIPT_SHA256']=ns['hashlib'].sha256(script.read_bytes()).hexdigest()
raw=plistlib.dumps({'Label':ns['LABEL'],'ProgramArguments':ns['LEGACY_ARGS']})
for token in ['enabled','false','trueish','disabled-extra','unknown']:
 p.write_bytes(raw);calls=[]
 def run(argv,**kw):
  calls.append(argv);return types.SimpleNamespace(returncode=0,stdout='"com.craigoley.disk-sweep" => '+token,stderr='')
 ns['subprocess'].run=run
 assert ns['retire'](home,True)=={'state':'disable-unverified','changed':True}
 assert p.read_bytes()==raw and [a[1] for a in calls]==['disable','print-disabled']
for output in ['"comXcraigoleyXdisk-sweep" => disabled','"com.craigoley.disk-sweep" => disabled\n"com.craigoley.disk-sweep" => enabled','']:
 assert ns['confirmed_disabled'](output) is False
p.write_bytes(raw);calls=[]
def run(argv,**kw):
 calls.append(argv);return types.SimpleNamespace(returncode=0,stdout='disabled services = {\n\t"com.craigoley.disk-sweep" => disabled\n}',stderr='')
ns['subprocess'].run=run
result=ns['retire'](home,True)
assert result['state']=='disabled-legacy-job-plist-preserved',result
assert pathlib.Path(result['archive']).read_bytes()==raw and not p.exists()
assert [a[1] for a in calls]==['disable','print-disabled']
`;
    const r = spawnSync("python3", ["-c", program, retire, fx.home], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

test("Node compile-cache batching preserves the six-hour rule, fresh files, unrelated data and cache root", () => {
  const fx = fixture();
  try {
    const cache = join(fx.home, "tmp/node-compile-cache"), version = join(cache, `v24.21.0-arm64-12345678-${process.getuid!()}`);
    mkdirSync(version, { recursive: true });
    const old = join(version, "abcdef12"); writeFileSync(old, Buffer.from("b2dbdf8a01020304", "hex"));
    const program = String.raw`import runpy,os,time,sys,pathlib,json
ns=runpy.run_path(os.environ['CACHE_SCRIPT']);root=pathlib.Path(os.environ['NODE_CACHE']);observed=time.time()
# Production clock refuses a genuinely recent file.
assert ns['main'](['--node-compile-cache',str(root),'--apply'])==0
assert (root/os.environ['NODE_VERSION']/'abcdef12').exists()
fresh=root/os.environ['NODE_VERSION']/'12345678';fresh.write_bytes(bytes.fromhex('b2dbdf8a01020304'))
os.utime(fresh,(observed+7*3600,observed+7*3600))
ns['time'].time=lambda:observed+8*3600
assert ns['main'](['--node-compile-cache',str(root),'--apply'])==0
assert root.exists() and fresh.exists() and not (root/os.environ['NODE_VERSION']/'abcdef12').exists()
`;
    const r = spawnSync("python3", ["-c", program], { encoding: "utf8", env: { ...process.env, HOME: fx.home, TMPDIR: join(fx.home, "tmp"), CACHE_SCRIPT: script, NODE_CACHE: cache, NODE_VERSION: version.split("/").at(-1)! } });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /"removedFiles":1/);
    writeFileSync(old, Buffer.from("b2dbdf8a01020304", "hex")); writeFileSync(join(version, "unpublished.txt"), "keep me");
    const held = fx.run(`original=ns['main'];ns['main']=lambda argv: original(['--node-compile-cache',${JSON.stringify(cache)},'--apply'])`);
    assert.equal(held.status, 0, held.stderr + held.stdout); assert.ok(existsSync(old)); assert.equal(readFileSync(join(version, "unpublished.txt"), "utf8"), "keep me");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});
