# Storage permission fixtures: paired controls and Azure evidence limits

Paired worker controls reproduce ten storage refusals from the reported eleven; the preflight failure remains unattributed.

## Reproduction

Measured on 2026-10-20 at `30b1984104d7e3ca852cfe3cf72731b6d730ec2d`,
the checkout's HEAD and locally stored `origin/main` when the task was opened. No source, fixture or guard
was changed between runs. This is the dispatched Linux worker container
`8a353e86e898`, Node `v24.21.0`, uid/gid `1000:1000`, **not a measurement of the
Azure operator environment**. No live remote freshness or current CI claim is made.

The task record reports `68 tests / 57 pass / 11 fail` at historical main
`4c83ace0f` under `heavy-run.sh`. That log and the Azure operator directory are
not present in this checkout, and `heavy-run.sh` was not found on PATH or in
the available repository scripts. The measurements below use the three actual
test files directly, serially, with the repository's normal test setup. They
do not establish an eleven-title reproduction on Azure.

Before writing this document, all three acceptance grep commands against this
path failed because the file was absent, also confirmed with `git show
origin/main:docs/forensics/storage-permission-fixtures-on-the-azure-host.md`.
The source premises were checked at this HEAD:

| Source | Verified behavior |
| --- | --- |
| `scripts/lib/shared-workspace.mjs`, `ownedDirectory` | Requires a physical path inside its supplied home, current uid ownership and no `mode & 0o022`; walks through that home, not its ancestors. |
| `scripts/lib/evidence-storage.mjs`, `privateParents` | Walks parents of the candidate, stopping before `/`; rejects writable non-sticky directories and symlinks. Sticky parents owned by uid 0 or this process are accepted. |
| `scripts/lib/evidence-storage.mjs`, `compactEvidenceRoot` | Calls `privateParents(join(root, 'candidate'))`, so the evidence root itself is checked. |
| `test/setup/tmp-hygiene.ts`, `TEST_HOME_PREFIX` | Replaces HOME with an account-owned `mkdtemp` directory beneath TMPDIR. |
| `test/review/shared-git-storage.test.ts`, `fixture` | Explicitly creates workspaces, origin, dependencies and configuration directories with `0o700`; the cloned pool and its Git store are not normalized. |
| `test/review/evidence-storage.test.ts`, evidence root symlink test | Creates `source` with plain `mkdirSync(source)` before inspecting it. |
| `test/preflight-ci-parity.test.ts`, additive preflight test | The exact reported test still exists. It passed in every control below. |

The inherited environment had umask `0022` and
`RMD_TEST_SLOT_DIR=/home/node/rmd-scratch/test-slots`, without an inherited
worker claim. Two preliminary runs retaining that setting produced:

| UTC window | Umask | TAP summary | Exit |
| --- | --- | --- | --- |
| 17:06:11.123449–17:06:24.013963 | `0022` | `# tests 68`, `# pass 67`, `# fail 1` | 1 |
| 17:06:34.678827–17:06:54.440302 | `0002` | `# tests 68`, `# pass 57`, `# fail 11` | 1 |

That apparent eleven-failure reproduction is **not the reported eleven**.
Its extra failure was `inherited reservation fixtures require the real ancestor
start, nonce, pool and one-worker identity`: expected scope `test-process`,
actual `configured`. Inspection of `resolveTestSlotDir` in
`src/lib/test-slot.ts` explains that result: a configured slot directory without
an inherited worker claim wins over the private test-process fallback. No
shared reservation was edited or deleted. The subsequent controls explicitly
unset only `RMD_TEST_SLOT_DIR` in their test children, exercising that fallback.

The controlled `0002` run failed these exact titles. `F` below means the
shared-Git child's HOME followed by `/.rmd-shared-git-fixture-`:

| Test file | Failing title | First refused path |
| --- | --- | --- |
| `test/review/evidence-storage.test.ts` | evidence root refuses symlinked roots and never recursively enters checkouts | evidence HOME + `/.rmd-evidence-storage-criONl/source` |
| `test/review/shared-git-storage.test.ts` | capacity and genuine-worker refusals precede every Git or receipt mutation | `F` + `NPCraM/pool` |
| same | real linked workspaces share the common Git store and reuse dependencies with no fresh install | `F` + `REEjKQ/pool` |
| same | occupied and dangling workspace paths are retained without retry or new receipts | `F` + `kn4qCm/pool` |
| same | dependency refusal preserves the real created worktree and never invokes an npm fallback | `F` + `FWZAh7/pool` |
| same | a dependency installer attempting fresh npm is refused and its workspace remains harness-owned | `F` + `u5s8QD/pool` |
| same | bare pools require their own full initial integrity proof and current connectivity | `F` + `PhY49Y/pool` |
| same | Git alternates, changed store kinds and invalid identities refuse without worktree creation | `F` + `j94NLj/pool` |
| same | shared workspace CLI status is read-only and rejects filed tasks and overrides | `F` + `nWrBSU/pool` |
| same | a lost inherited worker is rechecked before the next Git phase, without worktree creation | `F` + `hSoeAA/pool` |

Each listed directory was a real directory, not a symlink, mode `0775`,
uid/gid `1000:1000`. The evidence exception was `unsafe-parent`; the nine Git
failures were preceded by `storage path is not account-owned and protected`.
The metadata-rejection test also encountered `F` + `eUV6xu/pool` at `0775`,
but already expected a throw and therefore passed.

In-process parent observations were collected by wrapping `fs.lstatSync` in a
one-off import and synchronizing its ESM exports. Only calls whose stack named
`ownedDirectory` or `privateParents` were recorded. The wrapper returned the
original stat unchanged; no guard, assertion, ownership or fixture mode was
modified. HOME's ancestor metadata was captured during those calls, before
the test exit cleanup removed HOME. `/` was recorded for context, not as a
guard visit.

Let `R=/tmp/rmd-storage-diagnosis-m50vfe7b`. The actual HOME values were:

| Run | Preflight child HOME, relative to R | Evidence child HOME, relative to R | Shared-Git child HOME, relative to R |
| --- | --- | --- | --- |
| `controlled022` | `controlled-tmp/rmd-test-home-10-4026532933-pJwVHH` | `controlled-tmp/rmd-test-home-174-4026532933-n3UTxy` | `controlled-tmp/rmd-test-home-277-4026532933-mAwf9k` |
| `controlled002` | `controlled-tmp/rmd-test-home-9-4026532741-NS563a` | `controlled-tmp/rmd-test-home-156-4026532741-j81PtE` | `controlled-tmp/rmd-test-home-246-4026532741-uPUibb` |
| `layout-sticky022` | `layout-tmp/rmd-test-home-9-4026532872-bNsEUK` | `layout-tmp/rmd-test-home-172-4026532872-2pNezK` | `layout-tmp/rmd-test-home-274-4026532872-ZUQ2cB` |
| `layout-group022` | `layout-tmp/rmd-test-home-9-4026532743-pEdM4v` | `layout-tmp/rmd-test-home-156-4026532743-sVjd0X` | `layout-tmp/rmd-test-home-246-4026532743-4dzR6A` |

The preflight child made no calls to either storage guard. HOME path strings
were recorded at exit in every child; the following modes are live guard-time
observations, not stats of already-deleted fixtures. Random fixture suffixes
are grouped below only when every observed member had the same metadata.
These rows enumerate every distinct path shape the guards actually visited:

| Guard and observed path | `0022` mode | `0002` mode | uid:gid |
| --- | --- | --- | --- |
| `ownedDirectory`: fixture `.config/remudero`, `.config`, fixture home | `0700` | `0700` | `1000:1000` |
| `ownedDirectory`: fixture `pool` (including bare replacement) | `0755` | `0775` | `1000:1000` |
| `ownedDirectory`: fixture `workspaces`, `dependencies` | `0700` | Not reached after pool refusal | `1000:1000` |
| `ownedDirectory`: fixture `pool/.git` | `0755` | Not reached after pool refusal | `1000:1000` |
| `ownedDirectory`: `dependencies/e8c703e8621ac526d6f915ba2d00894361d5320e42f97bc8a2bd8d50f477b0da` | `0700` | Not reached after pool refusal | `1000:1000` |
| `privateParents`: evidence fixture `source` | `0755` | `0775` | `1000:1000` |
| `privateParents`: evidence fixture roots, evidence child HOME | `0700` | `0700` on other inspections | `1000:1000` |
| `privateParents`: `R/controlled-tmp`, `R` | `0700` | `0700` on other inspections | `1000:1000` |
| `privateParents`: `/tmp` | `0755` | `0755` on other inspections | `1000:1000` |
| Context only: `/` | `0755` | `0755` | `65534:65534` |

The shared-Git supplied `home` is the fixture home, **not** the child's HOME;
its guard stops there. It never visits the TMPDIR or checkout ancestors.
The evidence traversal for the failing `source` stops immediately at `source`
under `0002`; other evidence inspections reached the remaining parents above.

The deduplicated inventories contain 70 shared-Git guard paths under `0022`
(55 at `0700`, 15 at `0755`) and 43 under `0002` (33 at `0700`, 10 at `0775`).
The evidence inventories contain nine paths under `0022` (seven at `0700`,
two at `0755`) and eight under `0002` (six at `0700`, one each at `0755` and
`0775`). The sticky layout preserves the shared-Git inventory and records
nine evidence paths: six at `0700`, two at `0755`, one at `1777`. The group
layout also preserves the shared-Git inventory but reaches only six evidence
paths: four at `0700`, one at `0755`, one at `0775`. Every guard-visited path
in these inventories had uid/gid `1000:1000`, directory=true, symlink=false.

## Positive controls

The controlled window was 2026-10-20 **17:07:22–17:09:23 UTC**, at the same
SHA, container, uid/gid and Node version. Each invocation selected the same
three verified files, with `--test-concurrency=1`; each runner exited before
the next was started. No full repository suite or full preflight was run.
All four runs reported zero skipped and zero cancelled tests.

| Run | UTC start–end | Child umask | TMPDIR and mode | TAP summary | Exit |
| --- | --- | --- | --- | --- | --- |
| `controlled022` | 17:07:22.168515–17:07:52.990948 | `0022` | `R/controlled-tmp`, `0700` | `# tests 68`, `# pass 68`, `# fail 0` | 0 |
| `controlled002` | 17:08:02.068171–17:08:06.115971 | `0002` | Same physical path, `0700` | `# tests 68`, `# pass 58`, `# fail 10` | 1 |
| `layout-sticky022` | 17:08:24.425112–17:08:39.619396 | `0022` | `R/layout-tmp`, `1777` | `# tests 68`, `# pass 68`, `# fail 0` | 0 |
| `layout-group022` | 17:08:45.555874–17:09:22.341783 | `0022` | Same physical path, `0775` | `# tests 68`, `# pass 65`, `# fail 3` | 1 |

The TMPDIR controls changed only the mode of a newly created disposable
directory, not the operator's directory. Its owner was `1000:1000` in both
runs. Sticky mode admitted the complete evidence-parent chain. Without
sticky mode the evidence guard stopped at `R/layout-tmp` (`0775`), while
HOME, evidence fixture roots and `R` remained `0700`; `source` was `0755`.
The three layout failures were:

- `evidence root refuses symlinked roots and never recursively enters checkouts`
- `evidence root inspection refuses before allocating beyond its explicit entry budget`
- `no-op evidence pass preserves referenced-sized history and creates no receipt files`

All three threw `unsafe-parent`. All shared-Git tests and the reported
preflight test passed in this run. Thus a writable TMPDIR ancestor has a
different failure signature from umask-dependent pool creation.

**Unfulfilled host control:** this account-owned sticky directory exercises
the guard's current-uid sticky arm. It is not a root-owned sticky directory,
and the synthetic `0775` path is not the Azure operator directory. The worker
has no writable root-owned sticky directory in its permitted filesystem;
its `/tmp` is `0755`, uid `1000`, and `/var/tmp` is `1777`, uid `65534`.
The Azure `heavy-run.sh` reproduction, genuine root-owned sticky TMPDIR
control and actual `0775` operator-parent control still require host access.
A matching numeric failure count is insufficient evidence for those controls.

The exact runner argv used by all four controlled runs was:

```sh
node --test --test-concurrency=1 --test-reporter=tap \
  --import tsx --import ./test/setup/tmp-hygiene.ts \
  --import /tmp/rmd-storage-diagnosis-m50vfe7b/diagnostic.mjs \
  test/review/shared-git-storage.test.ts \
  test/review/evidence-storage.test.ts test/preflight-ci-parity.test.ts
```

Python `subprocess.run` set the child umask and environment, avoiding a
process-wide umask change to the worker. The essential invocation was:

```python
env = {**os.environ, 'TMPDIR': str(tmp), 'DIAG_DIR': str(run / 'diagnostics')}
env.pop('RMD_TEST_SLOT_DIR', None)
with (run / 'tap.log').open('w') as output:
    result = subprocess.run(args, env=env, umask=mask,
                            stdout=output, stderr=subprocess.STDOUT)
```

Here `mask` was `0o022`, `0o002`, `0o022`, `0o022` respectively; `tmp` was
`R/controlled-tmp` for the first pair and `R/layout-tmp` for the second pair.
`R` was allocated with `tempfile.mkdtemp(prefix='rmd-storage-diagnosis-',
dir='/tmp')`. Each run's diagnostics directory and the two TMPDIR directories
were explicitly created with mode `0o700`; `layout-tmp` was then chmodded to
`0o1777` or `0o775` just before its corresponding invocation. The six initial
and controlled TAP summaries and their failing titles are preserved above;
the scratch fixtures and diagnostic files can be removed after recording.

For repeating the observation without editing production guards, the
diagnostic import is reproduced here. It records actual guard visits and
live HOME ancestors, deduplicated by guard and physical path:

```js
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {dirname} from 'node:path';
import {hostname} from 'node:os';
const original=fs.lstatSync, seen=new Map(), chains=new Map();
const metadata=(path,s)=>({path,mode:(s.mode&0o7777).toString(8).padStart(4,'0'),uid:s.uid,gid:s.gid,directory:s.isDirectory(),symlink:s.isSymbolicLink()});
fs.lstatSync=function(path,...args){
 const s=original.call(this,path,...args);
 const stack=new Error().stack??'';
 const guard=stack.includes('at ownedDirectory (')?'ownedDirectory':stack.includes('at privateParents (')?'privateParents':undefined;
 if(guard&&s){
  const row=metadata(String(path),s);seen.set(guard+':'+row.path,{guard,...row});
  for(let p=process.env.HOME;p; p=p==='/'?undefined:dirname(p)){
   if(!chains.has(p)){try{chains.set(p,metadata(p,original(p)));}catch(error){chains.set(p,{path:p,error:error.message});}}
  }
 }
 return s;
};
syncBuiltinESMExports();
process.on('exit',()=>{
 const parents=[];
 for(let p=process.env.HOME;p; p=p==='/'?undefined:dirname(p)){
  try{parents.push(metadata(p,original(p)));}catch(error){parents.push({path:p,error:error.message});}
 }
 fs.writeFileSync(process.env.DIAG_DIR+'/'+process.pid+'.json',JSON.stringify({pid:process.pid,host:hostname(),node:process.version,uid:process.getuid(),gid:process.getgid(),umask:process.umask().toString(8),HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,parents,liveParents:[...chains.values()],walks:[...seen.values()]},null,2)+'\n');
});
```

## Cause

**H1 is supported for the ten reproduced storage failures:** ambient umask
changes cloned pools and the plain-mkdir evidence `source` from `0755` to
`0775`. The private HOME and explicitly protected directories remain `0700`.
The actual group-writable pool or `source` is the first rejection point.
The `0022` run passes every test on identical code and TMPDIR, and the
`0002` run fails the nine reported Git titles plus the reported evidence
title. These are fixture assumptions about the runner's umask; no host
permission or guard correction is needed to explain this reproduction.

**H2 is unnecessary for those ten failures**, because the umask control has
no writable non-sticky ancestor above HOME, and shared-Git's fixture-home
boundary prevents it from reading the checkout's parents at all. H2 is
nevertheless independently demonstrated for evidence traversal: with
`0022`, changing the same TMPDIR from owned sticky `1777` to non-sticky
`0775` creates three evidence failures at that ancestor. An Azure host
layout contribution cannot be ruled out without its in-process paths.

**H3 is not supported by these failures.** The refused directories actually
have the unsafe permissions the guards test for. The passing `0022` run
rules out a blanket rejection of these physical fixture paths or account
ownership. The sticky control rules out unconditional rejection of writable
parents for the current-uid sticky case. It does not qualify root-owned
sticky handling on Azure, macOS compression/publication, or all other guard
behavior; this Linux `compactEvidenceRoot` observation reaches a guard that
is independent of the macOS-only `compressEvidenceFile` publication path.

The remaining historical preflight failure has no measured connection to
either storage guard: the additive preflight test passed under both umasks
and both TMPDIR layouts, and its process produced zero visits to these guards.
The historical log's preflight assertion and environment must be obtained
before attributing the eleventh failure. The unrelated configured-slot
failure above is not a substitute for that evidence.

## Remedy proposal

For H1, the separate fixture repair should explicitly create the evidence
`source` with `0o700` and ensure both the cloned shared-Git pool and its
common Git directory are `0o700`, including the bare-pool replacement.
Setting mode on the pool alone leaves the later common-store check exposed.
Its acceptance should preserve the existing unsafe-path refusals and run
the affected files under both `0022` and `0002`, with private parents.

For H2, an operator should use a protected TMPDIR ancestry or an appropriate
root-owned sticky temp directory after measuring the actual Azure traversal.
Changing unrelated checkout ancestors cannot fix a shared-Git fixture-home
check that never visits them. The synthetic layout result alone does not
justify changing any live host permissions.

For H3, no guard repair is supported by this evidence. A separate guard task
would need a concrete safe path that is wrongly refused, with its real
ownership, mode and traversal. This diagnosis changes no guard, skips no
test and makes no live host modification.

Document validation: the three literal acceptance grep invocations now match
the requested headings. `censusMembershipCommand` was called with the two
pending paths explicitly, because harness-owned commits have not happened;
it named `test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts`
and the additional text reader `test/docs-index.test.ts`. Those verified
files ran together serially: `# tests 36`, `# pass 36`, `# fail 0`, runner
exit 0. The command also reported unmodelled census candidates; this is not
a claim to have executed all population walkers or full CI. The comment-load
and source-size signals passed; source-size's remote refresh was refused by
the read-only Git administrative directory, so it used local refs and found
zero changed source files. The generated docs index and its path checks
passed. The source SHA remained the measured SHA throughout validation.

Follow-on validation on 2026-10-20: the pre-open harness reported a failed
`typecheck` step. In the resumed worker, `npm run --silent typecheck` exited
0 with no diagnostics. The reported failure was not reproduced; this result
does not establish its original cause. The forensic Markdown is outside the
TypeScript config's include patterns, and no compiler source, fixture, guard,
baseline or TypeScript configuration was changed to obtain that pass.

The resumed `bin/rmd preflight --fast` finished with exit 1 after 869 seconds:
26 steps passed, including `typecheck`, and two failed (`rule-checks` and
`no-shallowing-census`). The rule runner named
`test/every-test-finds-the-repo-root-through-one-helper.test.ts` and
`test/no-shallowing-of-the-canonical-checkout.test.ts`. Both encountered
`ERR_SWC_NATIVE_CACHE`: the installed SWC native carrier rejected its cache
ancestry as writable by another user without trusted sticky protection.
An independent `SWC_NATIVE_BINDING_CACHE=/tmp node -e
'require("@swc/core")'` control also refused cache materialization. In this
container `/` is mode `0755`, uid/gid `65534:65534`, while `/tmp` is `0755`,
`1000:1000`. These are current worker-environment observations, not evidence
for the historical Azure preflight failure. The failed fast preflight does
not qualify as a passing validation; repairing the container's native-cache
environment remains separate from this document's storage-fixture diagnosis.
