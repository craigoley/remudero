/** Offline Git closure qualification; every source and recipient is a disposable fixture. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const prelude = `import importlib.util,os,sys,json,pathlib,subprocess
spec=importlib.util.spec_from_file_location('pr',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);home=root/'home';home.mkdir(mode=0o700)
(home/'.local/state/remudero').mkdir(parents=True,mode=0o700)
for p in [home/'.local',home/'.local/state']:p.chmod(0o700)
c=home/m.CONFIG_REL;c.write_text(json.dumps({'enabled':True}));c.chmod(0o600);m.account_home=lambda:str(home)
work=home/'saved';work.mkdir();cfg={'preserve_root':str(work),'temp_base':str(root),'max_untracked_mb':50}
r=m.Repo(str(root),'clone');snap=m.git_snapshot(r)
`;
function probe(code: string) {
  const r = gitRepo({kind:"all-recorded-roots"});
  try {
    const x = spawnSync("python3", ["-I", "-B", "-c", prelude + code, join(REPO_ROOT,"deploy/mac/preserve-retire.py"), r.dir], {
      encoding:"utf8", timeout:60_000, maxBuffer:2*1024*1024,
    });
    assert.equal(x.error,undefined,String(x.error)); assert.equal(x.status,0,`${x.stdout}\n${x.stderr}`);
  } finally {r.cleanup();}
}

test("self-contained preservation restores private checkpoint and remote refs, detached HEAD, annotated tags and blob roots without an upstream", () => probe(`
def git(*a,inp=None):
 x=m.copy_git(r,*a,inp=inp);assert x.returncode==0,x.stderr;return x.stdout.decode().strip()
head=snap['head'];blob=git('hash-object','-w','--stdin',inp=b'private blob\\n')
private=git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit-tree',git('rev-parse','HEAD^{tree}'),inp=b'private checkpoint\\n')
git('update-ref','refs/checkpoints/private',private);git('update-ref','refs/remotes/retained/historical',private)
git('update-ref','refs/private/blob',blob);git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','tag','-a','saved-tag','-m','annotation')
git('checkout','--detach','--quiet',head);snap=m.git_snapshot(r)
count=m.save_git_copy(r,snap,str(work),cfg);assert count>=5
header=(work/'unpublished.bundle').read_bytes().split(b'\\n\\n')[0];assert b'\\n-' not in header
assert blob.encode()+b' refs/private/blob' in header
# A second empty store independently verifies the first qualification, with no source environment.
second=work/'second';second.mkdir();expected=m.copy_git(r,'rev-list','--objects','--no-object-names','--all','HEAD').stdout.splitlines()
m.verify_git_copy(str(work/'unpublished.bundle'),snap,expected,str(second))
`));

test("independent Git copy verification rejects a producer omitting the private blob while healthy packing succeeds", () => probe(`
blob=m.copy_git(r,'hash-object','-w','--stdin',inp=b'orphan blob').stdout.decode().strip()
assert m.copy_git(r,'update-ref','refs/private/blob',blob).returncode==0
snap=m.git_snapshot(r);healthy=work/'healthy';healthy.mkdir();m.save_git_copy(r,snap,str(healthy),cfg)
real=m.subprocess.run
def omitted(cmd,**kw):
 if 'pack-objects' in cmd:kw['input']=(snap['head']+'\\n').encode()
 return real(cmd,**kw)
m.subprocess.run=omitted
try:m.save_git_copy(r,snap,str(work),cfg)
except m.Hold as e:assert 'independent-git-copy' in str(e),str(e)
else:raise AssertionError('omitted private blob was accepted')
`));

test("complete Git copy holds before packing when the independent-copy space bound cannot fit and admits a healthy control", () => probe(`
m.save_git_copy(r,snap,str(work),cfg)
real=m.free_bytes;m.free_bytes=lambda _:m.MIN_FREE_BYTES+1
try:m.save_git_copy(r,snap,str(work),cfg)
except m.Hold as e:assert 'git-copy-disk-floor' in str(e),str(e)
else:raise AssertionError('insufficient complete-copy space was accepted')
`));

test("complete Git copy sizes its bound from reused stored deltas, so a history far larger uncompressed than free space is saved compactly", () => probe(`
def git(*a):
 x=m.copy_git(r,'-c','user.name=fixture','-c','user.email=fixture@example.invalid',*a);assert x.returncode==0,x.stderr;return x
base=os.urandom(1<<20)
for i in range(24):
 (root/'big.bin').write_bytes(base+f'version {i}\\n'.encode());git('add','big.bin');git('commit','-q','-m',f'v{i}')
git('repack','-adq');snap=m.git_snapshot(r)
oids=m.copy_git(r,'rev-list','--objects','--no-object-names','--all').stdout
raw=sum(int(l.split()[1]) for l in m.copy_git(r,'cat-file','--batch-check=%(objectname) %(objectsize)',inp=oids).stdout.splitlines())
assert raw>20<<20,raw
m.free_bytes=lambda _:m.MIN_FREE_BYTES+(8<<20)
m.save_git_copy(r,snap,str(work),cfg)
size=(work/'unpublished.bundle').stat().st_size;assert size<(4<<20),size
`));

test("complete Git copy holds before verification when the written bundle leaves no room for the verifier store", () => probe(`
calls=[]
def free(_):
 calls.append(1);return 1<<50 if len(calls)==1 else m.MIN_FREE_BYTES+1
m.free_bytes=free
try:m.save_git_copy(r,snap,str(work),cfg)
except m.Hold as e:assert 'verifier store would not fit' in str(e),str(e)
else:raise AssertionError('verification ran without room for its store')
assert len(calls)==2 and not list(work.glob('.verify-*'))
`));

test("Git snapshot notices private ref and symbolic HEAD transitions even with unchanged commit HEAD", () => probe(`
assert m.git_snapshot(r)==snap
assert m.copy_git(r,'update-ref','refs/checkpoints/new',snap['head']).returncode==0
assert m.git_snapshot(r)!=snap
assert m.copy_git(r,'update-ref','-d','refs/checkpoints/new').returncode==0
assert m.git_snapshot(r)==snap
assert m.copy_git(r,'checkout','--detach','--quiet','HEAD').returncode==0
assert m.git_snapshot(r)!=snap
`));

test("retirement rechecks recorded refs after the last activity probe while an unchanged checkout retires", () => probe(`
roots=home/'Remudero';roots.mkdir();changing=roots/'changing';healthy=roots/'healthy'
for p in [changing,healthy]:
 out=m.run(['git','clone','--quiet',str(root),str(p)]);assert out.returncode==0,out.stderr
c.write_text(json.dumps({'enabled':True,'idle_hours':24,'interval_hours':0,'roots':['Remudero'],
 'preserve_root':'saved','published_remotes':[],'temp_roots':[]}));c.chmod(0o600)
m.process_snapshot=lambda:([],set())
original_preserve=m.preserve;original_scope=m.keep_scope;copied=set();changed=False
def preserve(*args):
 result=original_preserve(*args);copied.add(args[0].path);return result
def scope(path,below=True):
 global changed
 if path==str(changing) and path in copied and not changed:
  changed=True
  rr=m.Repo(path,'clone');out=m.copy_git(rr,'update-ref','refs/checkpoints/late',snap['head']);assert out.returncode==0
 return original_scope(path,below)
m.preserve=preserve;m.keep_scope=scope
sys.argv=['helper','--home',str(home),'--apply','--temp-base',str(home/'tmp'),'--now',str(int(m.time.time())+48*3600)]
assert m.main()==0
assert changed,'did not reach late retirement boundary'
assert changing.is_dir(),'changed ref was retired'
assert not healthy.exists(),'healthy unmarked positive control never retired'
`));

test("preservation packs a private blob even when every commit is already counted as published", () => probe(`
blob=m.copy_git(r,'hash-object','-w','--stdin',inp=b'blob outside all commits').stdout.decode().strip()
assert m.copy_git(r,'update-ref','refs/private/blob',blob).returncode==0
class Published:
 def excludes(self,repo):return [snap['head']]
# Put preservation outside its source so untracked collection cannot ingest its own output.
source=home/'source';out=m.run(['git','clone','--quiet',str(root),str(source)]);assert out.returncode==0
rr=m.Repo(str(source),'clone')
assert m.copy_git(rr,'hash-object','-w','--stdin',inp=b'blob outside all commits').stdout.decode().strip()==blob
assert m.copy_git(rr,'update-ref','refs/private/blob',blob).returncode==0
saved,summary=m.preserve(rr,Published(),cfg,str(home),m.time.time())
assert summary['unpublished_commits']==0
assert summary['packed_objects']>=3
assert (pathlib.Path(saved)/'unpublished.bundle').exists()
assert ['%s'%blob,'refs/private/blob'] in summary['git_snapshot']['refs']
`));
