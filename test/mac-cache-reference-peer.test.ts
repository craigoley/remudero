/** Real, read-only peer processes; no account keys or permission changes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("deploy/mac/cache-reclaim.py");
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reference-peer-")));
  const root = join(home, "Developer/opaque"), target = join(home, ".codex/work-artifacts/candidate/node_modules");
  mkdirSync(root, { recursive: true }); mkdirSync(target, { recursive: true }); mkdirSync(join(home, "tmp"));
  const config = join(home, ".local/state/remudero/cache-reference-peers.json");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "private-source.ts"), "preserve source\n");
  symlinkSync(target, join(root, "borrowed-dependencies"));
  const run = (code = "", setup = "") => {
    const program = String.raw`import os,sys,runpy,pathlib,json,hashlib
ns=runpy.run_path(os.environ['CACHE_SCRIPT']);g=ns['main'].__globals__;home=pathlib.Path(os.environ['HOME'])
root=home/'Developer/opaque';target=home/'.codex/work-artifacts/candidate/node_modules'
config=home/'.local/state/remudero/cache-reference-peers.json'
config.write_text(json.dumps([{'uid':os.getuid(),'argv':[sys.executable,os.environ['CACHE_SCRIPT'],'--reference-probe']}]))
config.chmod(0o600)
` + setup + String.raw`
original=g['directory_entries']
def private(*args,**kwargs):
 if args[0]==root:raise PermissionError('owned opaque-census control')
 yield from original(*args,**kwargs)
g['directory_entries']=private
budget=ns['Budget']()
` + code + String.raw`
try:
 shared=g['references'](home,[(target.parent,target,'packages')],budget)
 print(json.dumps({'shared':sorted(str(p) for p in shared),'peers':getattr(budget,'peer_probes',0),'entries':budget.entries,'bytesRead':budget.read_bytes}))
except (ns['Hold'],OSError) as error:
 print(json.dumps({'held':str(error),'entries':budget.entries,'bytesRead':budget.read_bytes}))
`;
    const r = spawnSync("python3", ["-c", program], { encoding: "utf8", timeout: 15000,
      env: { ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CACHE_SCRIPT: script } });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(r.stderr, "");
    return JSON.parse(r.stdout);
  };
  return { home, root, target, config, run, clean: () => rmSync(home, { recursive: true, force: true }) };
}

test("cache reference peer fills an opaque subtree with fresh read-only evidence and retains its shared target", () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.deepEqual(r.shared, [f.target]); assert.equal(r.peers, 1); assert.ok(r.entries > 0);
    assert.equal(readFileSync(join(f.root, "private-source.ts"), "utf8"), "preserve source\n");
    assert.ok(existsSync(join(f.root, "borrowed-dependencies")));
    assert.equal(existsSync(join(f.home, ".cache")), false, "peer must not acquire cleanup locks");
    assert.equal(existsSync(join(f.home, ".local/state/remudero/cache-reclaim-progress")), false, "peer must not write checkpoints");
  } finally { f.clean(); }
});

test("cache reference peer refuses unbound, incomplete and over-budget responses", () => {
  for (const fault of ["nonce", "uid", "writer", "rootIdentity", "requestSha256", "complete", "shared", "entriesInspected", "bytesRead"]) {
    const f = fixture();
    try {
      const r = f.run(String.raw`original_exchange=g['peer_exchange']
def faulty(*args):
 response=original_exchange(*args)
 key=` + JSON.stringify(fault) + String.raw`
 if key=='rootIdentity':response[key]=[0]*8
 elif key=='complete':response[key]=False
 elif key=='shared':response[key]=['/unrequested/target']
 elif key=='entriesInspected':response[key]=500001
 elif key=='bytesRead':response[key]=-1
 elif key=='uid':response[key]=-1
 else:response[key]='wrong'
 return response
g['peer_exchange']=faulty
`);
      assert.equal(r.held, "reference-peer-response-invalid", JSON.stringify({ fault, r }));
      assert.ok(existsSync(join(f.root, "borrowed-dependencies")));
    } finally { f.clean(); }
  }
});

test("cache reference peer requires explicit private configuration and keeps unavailable subtrees", () => {
  for (const fault of ["absent", "permissions", "symlink", "invalid"]) {
    const f = fixture();
    try {
      const r = f.run("", String.raw`fault=` + JSON.stringify(fault) + String.raw`
if fault=='absent':config.unlink()
elif fault=='permissions':config.chmod(0o644)
elif fault=='symlink':
 other=home/'retained-config';config.rename(other);config.symlink_to(other)
else:config.write_text('{}')
`);
      assert.match(r.held, /reference-peer-(unconfigured|config-untrusted|config-invalid)/);
      assert.ok(existsSync(join(f.root, "private-source.ts")));
    } finally { f.clean(); }
  }
});

test("cache reference peer rejects swapped physical roots and never follows a replacement", () => {
  const f = fixture();
  try {
    const r = f.run(String.raw`original_exchange=g['peer_exchange']
def swap(*args):
 response=original_exchange(*args)
 root.rename(root.with_name('retained-opaque'))
 root.symlink_to(home/'tmp',target_is_directory=True)
 return response
g['peer_exchange']=swap
`);
    assert.equal(r.held, "reference-peer-root-changed");
    assert.equal(readFileSync(join(f.home, "Developer/retained-opaque/private-source.ts"), "utf8"), "preserve source\n");
  } finally { f.clean(); }
});

test("cache reference peer bounds output, wall time and the probe child without granting reference completeness", () => {
  for (const fault of ["oversized", "timeout", "failure"]) {
    const f = fixture();
    try {
      const body = fault === "oversized" ? "print('x'*2097152)" : fault === "timeout" ? "import time;time.sleep(60)" : "raise SystemExit(2)";
      const r = f.run("g['MAX_SECONDS']=0.5\n", "config.write_text(json.dumps([{'uid':os.getuid(),'argv':[sys.executable,'-c'," + JSON.stringify(body) + "]}]))\n");
      assert.match(r.held, /reference-peer-(output-size|unavailable)|inspection-budget/);
      assert.ok(r.bytesRead < 2 * 1024 ** 2); assert.ok(existsSync(f.target));
    } finally { f.clean(); }
  }
});

test("cache reference peer CLI refuses apply mode without creating cleanup state", () => {
  const f = fixture();
  try {
    const r = spawnSync("python3", [script, "--reference-probe", "--apply"], { encoding: "utf8", env: { ...process.env, HOME: f.home } });
    assert.equal(r.status, 2); assert.match(r.stderr, /cannot apply/);
    assert.equal(existsSync(join(f.home, ".cache")), false); assert.ok(existsSync(f.target));
  } finally { f.clean(); }
});

test("cache reference peer returns caller-private alias resolution instead of inventing a negative reference", () => {
  const f = fixture();
  try {
    const r = f.run("", String.raw`peer_code="import runpy,os,pathlib;ns=runpy.run_path(os.environ['CACHE_SCRIPT']);g=ns['main'].__globals__;original=g['resolved_reference']\ndef private(parent,raw,budget):\n if raw.endswith('/node_modules'):raise PermissionError('caller-private alias control')\n return original(parent,raw,budget)\ng['resolved_reference']=private\nraise SystemExit(ns['main'](['--reference-probe']))"
config.write_text(json.dumps([{'uid':os.getuid(),'argv':[sys.executable,'-c',peer_code]}]))
`);
    assert.deepEqual(r.shared, [f.target]); assert.equal(r.peers, 1);
    assert.ok(existsSync(join(f.root, "private-source.ts")));
  } finally { f.clean(); }
});

test("cache reference resolver preserves lexical parent semantics, dangling suffixes and symlink loops safely", () => {
  const f = fixture();
  try {
    const r = f.run(String.raw`alias=home/'tmp/target-alias';alias.symlink_to(target,target_is_directory=True)
resolve=g['resolved_reference']
assert resolve(home/'tmp','target-alias/../node_modules',budget)==target
assert resolve(home/'tmp','missing/../target-alias',budget)==target
assert resolve(home/'tmp','uncreated/descendant',budget)==home/'tmp/uncreated/descendant'
(home/'tmp/cycle-a').symlink_to('cycle-b');(home/'tmp/cycle-b').symlink_to('cycle-a')
try: resolve(home/'tmp','cycle-a',budget)
except ns['Hold'] as error: assert str(error)=='reference-symlink-unresolvable'
else: raise AssertionError('symlink loop was accepted')
`);
    assert.equal(r.held, "reference-symlink-unresolvable");
    assert.ok(existsSync(f.target));
  } finally { f.clean(); }
});

test("cache reference resolver canonicalizes double-root aliases and holds replaced intermediate directories", () => {
  for (const fault of ["direct-double-root", "intermediate-double-root", "replace-directory"]) {
    const f = fixture();
    try {
      const r = f.run(String.raw`fault=` + JSON.stringify(fault) + String.raw`
if fault=='direct-double-root':
 (root/'borrowed-dependencies').unlink();(root/'borrowed-dependencies').symlink_to('/'+str(target))
elif fault=='intermediate-double-root':
 alias=home/'tmp/alias';alias.symlink_to('/'+str(target))
 (root/'borrowed-dependencies').unlink();(root/'borrowed-dependencies').symlink_to(alias)
else:
 pivot=home/'Developer/pivot';pivot.mkdir();(pivot/'placeholder').write_text('retained')
 original_stat=os.stat;swapped=[False]
 def changed(path,*args,**kwargs):
  result=original_stat(path,*args,**kwargs)
  if path=='pivot' and not swapped[0]:
   swapped[0]=True;pivot.rename(pivot.with_name('retained-pivot'));pivot.symlink_to(target.parent,target_is_directory=True)
  return result
 os.stat=changed
 try:g['resolved_reference'](home/'Developer','pivot/node_modules',budget)
 except (ns['Hold'],OSError):pass
 else:raise AssertionError('intermediate replacement accepted')
 os.stat=original_stat
`);
      assert.deepEqual(r.shared, [f.target], JSON.stringify(r));
      assert.ok(existsSync(join(f.root, "private-source.ts")));
    } finally { f.clean(); }
  }
});

test("cache reference resolver closes every pinned directory on success and refusal", () => {
  const f = fixture();
  try {
    const r = f.run(String.raw`original_open,original_close=os.open,os.close
opened=set()
def tracked_open(*a,**kw):
 fd=original_open(*a,**kw);opened.add(fd);return fd
def tracked_close(fd):
 original_close(fd);opened.discard(fd)
os.open,os.close=tracked_open,tracked_close
try:
 for n in range(20):
  assert g['resolved_reference'](root,str(target),budget)==target
  assert opened==set(),opened
  before=g['MAX_ENTRIES'];g['MAX_ENTRIES']=budget.entries+4
  try:g['resolved_reference'](root,str(target),budget)
  except ns['Hold'] as error:assert str(error)=='inspection-budget'
  else:raise AssertionError('missing budget refusal')
  finally:g['MAX_ENTRIES']=before;budget.exhausted=None
  assert opened==set(),opened
finally:os.open,os.close=original_open,original_close
`);
    assert.deepEqual(r.shared, [f.target]); assert.ok(existsSync(f.target));
  } finally { f.clean(); }
});

test("cache reference resolver tolerates unrelated sibling churn but refuses a changed directory edge", () => {
  for (const fault of ["sibling", "mode"]) {
    const f = fixture();
    try {
      const r = f.run(String.raw`fault=` + JSON.stringify(fault) + String.raw`
original_stat=os.stat;changed=[False]
def sibling_change(path,*args,**kwargs):
 result=original_stat(path,*args,**kwargs)
 if path=='borrowed-dependencies' and not changed[0]:
  changed[0]=True
  if fault=='sibling':(root/'unrelated-sibling').write_text('preserve')
  else:root.chmod(0o700)
 return result
os.stat=sibling_change
try:
 try:resolved=g['resolved_reference'](root,str(root/'borrowed-dependencies'),budget)
 except ns['Hold'] as error:
  assert fault=='mode' and str(error)=='scan-directory-changed',(fault,error)
 else:assert fault=='sibling' and resolved==target,(fault,resolved)
 assert changed[0]
finally:os.stat=original_stat
`);
      assert.deepEqual(r.shared, [f.target], JSON.stringify({ fault, r }));
      assert.equal(readFileSync(join(f.root, "private-source.ts"), "utf8"), "preserve source\n");
    } finally { f.clean(); }
  }
});

test("cache reference resolver rechecks intermediate symlinks after deeper descriptor teardown", () => {
  const f = fixture();
  try {
    const r = f.run(String.raw`elsewhere=home/'retained-elsewhere';elsewhere.mkdir()
alias=home/'tmp/late-alias';alias.symlink_to(elsewhere,target_is_directory=True)
other_inode=elsewhere.stat().st_ino;original_close=os.close;changed=[False]
def closing(fd):
 swap=os.fstat(fd).st_ino==other_inode and not changed[0]
 original_close(fd)
 if swap:
  changed[0]=True;alias.unlink();alias.symlink_to(target,target_is_directory=True)
os.close=closing
try:
 try:g['resolved_reference'](root,str(alias),budget)
 except ns['Hold'] as error:assert str(error)=='reference-symlink-changed',error
 else:raise AssertionError('symlink retargeted during descriptor teardown was accepted')
 assert changed[0]
finally:os.close=original_close
`);
    assert.deepEqual(r.shared, [f.target], JSON.stringify(r));
    assert.ok(existsSync(f.target));
  } finally { f.clean(); }
});

test("cache reference resolver seals a directory binding after its child descriptor closes", () => {
  const f = fixture();
  try {
    const r = f.run(String.raw`pivot=home/'tmp/pivot';pivot.mkdir()
elsewhere=home/'retained-elsewhere';elsewhere.mkdir()
(pivot/'alias').symlink_to(elsewhere,target_is_directory=True)
other_inode=pivot.stat().st_ino;original_close=os.close;changed=[False]
def closing(fd):
 swap=os.fstat(fd).st_ino==other_inode and not changed[0]
 original_close(fd)
 if swap:
  changed[0]=True;pivot.rename(pivot.with_name('retained-pivot'));pivot.mkdir()
  (pivot/'alias').symlink_to(target,target_is_directory=True)
os.close=closing
try:
 try:g['resolved_reference'](root,str(pivot/'alias'),budget)
 except ns['Hold'] as error:assert str(error)=='scan-directory-changed',error
 else:raise AssertionError('directory rebound after descriptor teardown was accepted')
 assert changed[0]
finally:os.close=original_close
`);
    assert.deepEqual(r.shared, [f.target], JSON.stringify(r));
    assert.ok(existsSync(f.target));
  } finally { f.clean(); }
});
