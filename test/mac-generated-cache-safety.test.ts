/** Actual generated-cache entrypoint and real private Git/filesystem fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("deploy/mac/cache-reclaim.py");
const retire = resolve("deploy/mac/retire-legacy-sweeper.py");
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
  const run = (code = "", old = true, apply = true) => {
    // ctime cannot be backdated. Shift only this private Python process's
    // clock; the actual CLI test below uses the real default clock instead.
    const program = `import runpy,os,time,sys,pathlib,json\nns=runpy.run_path(os.environ['CACHE_SCRIPT'])\n` +
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

test("artifact cache cleanup restores staging when activity appears and reports post-removal uncertainty honestly", () => {
  const fx = fixture();
  try {
    const p = fx.workspace("candidate"), cache = fx.cache(p);
    const held = fx.run(String.raw`original=ns['main'].__globals__['inactive'];calls=0
def activity(workspace):
 global calls
 calls+=1
 if calls==3:raise ns['Hold']('active-after-staging')
 original(workspace)
ns['main'].__globals__['inactive']=activity`);
    assert.equal(held.status, 0, held.stderr + held.stdout); assert.ok(existsSync(cache)); assert.match(held.stdout, /active-after-staging/);
    const changed = fx.run(String.raw`original=ns['shutil'].rmtree
def deletion(path):
 original(path)
 p=pathlib.Path(path).parents[2]/'after-removal.txt'
 p.write_text('external source writer')
deletion.avoids_symlink_attacks=original.avoids_symlink_attacks
ns['shutil'].rmtree=deletion`);
    assert.equal(changed.status, 2, changed.stderr + changed.stdout); assert.match(changed.stdout, /removed-unverified/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});

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
