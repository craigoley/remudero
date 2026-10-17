/** Private process groups and fixture-only trees; no account or host census. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("deploy/mac/cache-reclaim.py");
function run(code: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-peer-resources-")));
  mkdirSync(join(home, "tmp"));
  const prelude = String.raw`import os,sys,runpy,pathlib,json,signal,subprocess,time,errno
ns=runpy.run_path(os.environ['CACHE_SCRIPT']);g=ns['main'].__globals__;home=pathlib.Path(os.environ['HOME'])
`;
  try {
    const r = spawnSync("python3", ["-c", prelude + code], { encoding: "utf8", timeout: 15000,
      env: { ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CACHE_SCRIPT: script } });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stderr, "");
    return JSON.parse(r.stdout.trim());
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const groupControls = String.raw`
original_popen=subprocess.Popen;original_killpg=os.killpg;groups=[];signals=[]
def owned_popen(*args,**kwargs):
 child=original_popen(*args,**kwargs);groups.append(child.pid);return child
def owned_signal(group,sig):
 assert group in groups,('signalled unrelated group',group,sig)
 signals.append((group,sig));return original_killpg(group,sig)
def closed(group):
 try:original_killpg(group,0)
 except ProcessLookupError:return True
 return False
`;

test("cache peer resource cleanup verifies its group before returning a successful response", () => {
  const r = run(groupControls + String.raw`
subprocess.Popen=owned_popen;os.killpg=owned_signal
response=ns['peer_exchange']([sys.executable,'-c',"import sys;sys.stdin.buffer.read();print('{\"ok\":true}')"],{},ns['Budget']())
assert response=={'ok':True} and len(groups)==1 and closed(groups[0]),(response,groups,signals)
assert [sig for _,sig in signals if sig]!=[] and signals[-1][1]==0
print(json.dumps({'closed':True,'response':response}))
`);
  assert.equal(r.closed, true); assert.deepEqual(r.response, { ok: true });
});

for (const mode of ["exited", "term-exits"]) {
  test(`cache peer resource cleanup closes ${mode} leader and TERM-resistant grandchild without touching another worker`, () => {
    const r = run(groupControls + String.raw`
unrelated=original_popen([sys.executable,'-c','import time;time.sleep(60)'])
mode=` + JSON.stringify(mode) + String.raw`
body="""import os,sys,time,signal,pathlib
home=pathlib.Path(os.environ['HOME'])
def term(*_):
 (home/'leader-term').write_text('received');raise SystemExit(0)
signal.signal(signal.SIGTERM,term)
pid=os.fork()
if pid==0:
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 (home/'grandchild-ready').write_text(str(os.getpid()))
 while True:time.sleep(1)
while not (home/'grandchild-ready').exists():time.sleep(0.005)
marker=home/'leader-ready-stage';marker.write_text(str(os.getpid()));marker.replace(home/'leader-ready')
if sys.argv[1]=='exited':raise SystemExit(0)
while True:time.sleep(1)
"""
try:
 subprocess.Popen=owned_popen;os.killpg=owned_signal
 # Trigger the real deadline check after both fixture roles are ready, not
 # after an assumed interpreter-startup duration on a contended host.
 g['MAX_SECONDS']=5;started=time.monotonic()
 class ReadyBudget(ns['Budget']):
  def check(self,*args,**kwargs):
   ready=(home/'leader-ready').exists()
   if ready and mode=='exited':
    try:os.kill(int((home/'leader-ready').read_text()),0)
    except ProcessLookupError:pass
    else:ready=False
   if ready:self.started=min(self.started,time.monotonic()-6)
   return super().check(*args,**kwargs)
 try:ns['peer_exchange']([sys.executable,'-c',body,mode],{},ReadyBudget())
 except ns['Hold'] as error:reason=str(error);cause=repr(error.__cause__)
 else:raise AssertionError('hung descendants granted a response')
 assert (home/'leader-ready').exists() and (home/'grandchild-ready').exists(),reason
 # A transiently unverifiable teardown must also refuse, never grant a
 # response. Independently require this fixture's group to be gone now.
 assert reason in ('inspection-budget','reference-peer-closure-unverified') and closed(groups[0]),(reason,cause,signals)
 assert unrelated.poll() is None,'unrelated worker was interrupted'
 assert (home/'leader-term').exists()==(mode=='term-exits')
 assert any(sig==signal.SIGKILL for _,sig in signals) and time.monotonic()-started<8
 print(json.dumps({'closed':True,'unrelatedAlive':True,'reason':reason}))
finally:
 subprocess.Popen=original_popen;os.killpg=original_killpg
 unrelated.terminate();unrelated.wait(timeout=2)
`);
    assert.equal(r.closed, true); assert.equal(r.unrelatedAlive, true);
  });
}

test("cache peer resource cleanup refuses unverified closure and sends no signals after reaping", () => {
  const r = run(groupControls + String.raw`
def unknown(group,sig):
 assert group in groups
 signals.append((group,sig))
 if sig==0:raise PermissionError(errno.EACCES,'owned closure-control')
 return original_killpg(group,sig)
subprocess.Popen=owned_popen;os.killpg=unknown;started=time.monotonic()
try:ns['peer_exchange']([sys.executable,'-c',"print('{}')"],{},ns['Budget']())
except ns['Hold'] as error:assert str(error)=='reference-peer-closure-unverified',error
else:raise AssertionError('unknown closure granted a response')
assert closed(groups[0]) and signals[-1][1]==0 and time.monotonic()-started<4,signals
print(json.dumps({'held':True,'closed':True}))
`);
  assert.deepEqual(r, { held: true, closed: true });
});

test("cache peer resource referrals stop at the encoded byte cap before collecting the whole corpus", () => {
  const r = run(String.raw`
root=home/'Developer/opaque';root.mkdir(parents=True);(root/'private-source').write_text('preserve')
for n in range(700):(root/('alias-'+str(n))).symlink_to('/private/'+chr(0x1f9ed)*200+str(n))
def denied(*args):raise PermissionError(errno.EACCES,'owned referral-control')
g['resolved_reference']=denied
budget=ns['Budget']();budget.unresolved_references=[]
try:ns['scan_reference_tree'](home,root,0,[],budget,set(),expected=ns['identity'](root.lstat()),allow_peer=False)
except ns['Hold'] as error:assert str(error)=='reference-peer-output-size',error
else:raise AssertionError('oversized referrals completed')
size=len(ns['DirectoryProgress'].encode(budget.unresolved_references))
assert 0<len(budget.unresolved_references)<700 and size<=1024*1024
assert size==budget.unresolved_reference_bytes and budget.entries<500000
assert (root/'private-source').read_text()=='preserve'
print(json.dumps({'referrals':len(budget.unresolved_references),'bytes':size}))
`);
  assert.ok(r.referrals > 0 && r.referrals < 700); assert.ok(r.bytes <= 1024 ** 2);
});

test("cache peer resource deadline charges input and initialization against the original allowance", () => {
  const r = run(String.raw`import io,contextlib
root=home/'Developer/opaque';root.mkdir(parents=True)
original_clock=time.monotonic;original_read=os.read;original_stdin=sys.stdin;original_budget=g['Budget']
outcomes=[]
for input_delay in (0.5,2.5):
 clock=[0.0];time.monotonic=lambda:clock[0]
 class StartupBudget(original_budget):
  def __init__(self):super().__init__();clock[0]+=0.25
 g['Budget']=StartupBudget
 request={'version':1,'nonce':'ab'*24,'root':str(root),'identity':list(ns['identity'](root.lstat())),
          'depth':0,'candidates':[],'limits':{'entries':500000,'seconds':2.0}}
 reader,writer=os.pipe();os.write(writer,json.dumps(request).encode());os.close(writer)
 consumed=[False];calls=[]
 def delayed_read(fd,n):
  block=original_read(fd,n)
  if fd==reader and not consumed[0]:clock[0]+=input_delay;consumed[0]=True
  return block
 def scanned(*args,**kwargs):calls.append(45-(clock[0]-args[4].started))
 os.read=delayed_read;g['scan_reference_tree']=scanned;g['regular_digest']=lambda *a:'f'*64
 try:
  with os.fdopen(reader,'rb') as stream,contextlib.redirect_stdout(io.StringIO()):
   sys.stdin=stream
   try:result=ns['reference_probe']()
   except ns['Hold'] as error:
    assert input_delay==2.5 and str(error)=='inspection-budget' and calls==[],(error,calls)
    outcomes.append('held')
   else:
    assert result==0 and calls==[1.25],calls
    outcomes.append('within-original-deadline')
 finally:sys.stdin=original_stdin;os.read=original_read
time.monotonic=original_clock;g['Budget']=original_budget
print(json.dumps({'outcomes':outcomes}))
`);
  assert.deepEqual(r.outcomes, ["within-original-deadline", "held"]);
});

test("cache peer resource future opaque subtree without explicit peer configuration remains held", () => {
  const r = run(String.raw`
root=home/'Developer/opaque';root.mkdir(parents=True);(root/'source').write_text('preserve')
target=home/'.codex/work-artifacts/candidate/node_modules';target.mkdir(parents=True)
original=g['directory_entries']
def opaque(*args,**kwargs):
 if args[0]==root:raise PermissionError(errno.EACCES,'future opaque-control')
 yield from original(*args,**kwargs)
g['directory_entries']=opaque
try:ns['references'](home,[(target.parent,target,'packages')],ns['Budget']())
except ns['Hold'] as error:assert str(error).startswith('reference-peer-unconfigured:'),error
else:raise AssertionError('opaque future subtree granted completeness')
assert (root/'source').read_text()=='preserve' and target.exists() and not (home/'.cache').exists()
print(json.dumps({'held':True}))
`);
  assert.equal(r.held, true);
});
