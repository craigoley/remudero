import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SLOT_URL = new URL("../src/lib/test-slot.ts", import.meta.url).href;
const CAPACITY_URL = new URL("../src/lib/test-slot-capacity.ts", import.meta.url).href;
const MUTATION_URL = new URL("../src/lib/test-slot-mutation.ts", import.meta.url).href;

/** Each counterexample owns real temporary files and inodes; syscall faults stay in a fresh child.
 * The deadline is a backstop against a lost guard or blocking reopen, not a polling loop.
 */
function recoveryProbe(program: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-private-recovery-"));
  try {
    const child = spawnSync(process.execPath, ["--enable-source-maps", "--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {hostname} from 'node:os';
      import {join} from 'node:path';
      const root=process.argv[1],slot=join(root,'slot-1.json'),guardPath=join(root,'.slot-1.json.mutation');
      const directory=join(root,'capacity-'+process.getuid()),rows=[];
      const api=await import(${JSON.stringify(SLOT_URL)});
      const capacity=await import(${JSON.stringify(CAPACITY_URL)});
      const mutation=await import(${JSON.stringify(MUTATION_URL)});
      const options={dir:root,slots:1,waitBoundMs:0,pollMs:1,ownershipProtocol:'private-capacity-v1',
        privateCoordinationRequired:true,platform:'linux',hostname:()=>hostname(),
        bootId:()=>'private-recovery-fixture-boot',pidNamespace:()=>'pid:[private-recovery-fixture]',
        isPidAlive:()=>true,load:()=>({cores:4,load1:0}),memoryHeadroom:()=>undefined,memoryBytes:8192,
        log:line=>rows.push(JSON.parse(line))};
      const readOwner=()=>JSON.parse(fs.readFileSync(slot,'utf8'));
      const assertRefused=lease=>{assert.equal(lease.executionAllowed,false);
        assert.equal(api.testSlotExecutionAllowed(lease),false);assert.match(lease.note,/NOT_RUN/);
      if(lease.outcome!=='acquired')assert.equal(lease.childEnvironment,undefined);};
      ${program}
    `, root], { encoding: "utf8", timeout: 4000, killSignal: "SIGKILL",
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined, TSX_DISABLE_CACHE: "1",
        RMD_TEST_SLOT_PARENT: undefined, RMD_TEST_SLOT_DIR: root } });
    assert.equal(child.status, 0, String(child.error ?? child.stderr));
    return JSON.parse(child.stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const kind of ["sameJSON", "symlink"]) {
  test(`private recovery preserves a ${kind} replacement made by its final owner_recovery_intent callback`, () => {
    assert.deepEqual(recoveryProbe(`
      const first=api.acquireTestSlot('old callback owner',{...options,pid:999999});
      assert.equal(first.outcome,'acquired');assert.equal(capacity.observeSlotCapacity(slot,1).state,'observed');
      const original=fs.readFileSync(slot,'utf8'),identity=fs.lstatSync(slot),retained=join(root,'retained-owner');
      const sentinel=join(root,'callback-sentinel');fs.writeFileSync(sentinel,'callback sentinel',{mode:0o600});
      let intents=0,replacementIdentity;
      const attempted=api.acquireTestSlot('callback waiter',{...options,isPidAlive:()=>false,log:line=>{
        const row=JSON.parse(line);rows.push(row);
        if(row.step!=='test_slot.owner_recovery_intent')return;
        intents++;assert.equal(mutation.slotMutationPending(slot),true);
        assert.equal(capacity.observeSlotCapacity(slot,1).state,'unknown','metadata retired before canonical deletion');
        fs.renameSync(slot,retained);
        if(${JSON.stringify(kind)}==='symlink')fs.symlinkSync(sentinel,slot);
        else fs.writeFileSync(slot,original,{flag:'wx',mode:0o600});
        replacementIdentity=fs.lstatSync(slot);assert.notEqual(replacementIdentity.ino,identity.ino);
      }});
      assert.equal(intents,1,'the final audit callback actually executed');assertRefused(attempted);
      assert.equal(fs.lstatSync(slot).ino,replacementIdentity.ino);
      if(${JSON.stringify(kind)}==='symlink')assert.equal(fs.lstatSync(slot).isSymbolicLink(),true);
      else assert.equal(fs.readFileSync(slot,'utf8'),original,'identical JSON does not transfer inode authority');
      first.release();attempted.release();
      assert.equal(fs.lstatSync(slot).ino,replacementIdentity.ino);
      assert.equal(fs.readFileSync(sentinel,'utf8'),'callback sentinel');
      assert.equal(rows.some(row=>row.step==='test_slot.owner_recovery'),false,'an intent is not a successful reclaim');
      assert.equal(mutation.slotMutationPending(slot),false);
      console.log(JSON.stringify({intentExecuted:true,replacementPreserved:true,executionAllowed:false}));
    `), { intentExecuted: true, replacementPreserved: true, executionAllowed: false });
  });
}

test("cooperating nested acquisition refuses while private recovery holds its mutation guard", () => {
  assert.deepEqual(recoveryProbe(`
    const first=api.acquireTestSlot('nested original',{...options,pid:999999});assert.equal(first.outcome,'acquired');
    let nested,callbackCount=0;
    const outer=api.acquireTestSlot('nested outer',{...options,isPidAlive:()=>false,log:line=>{
      const row=JSON.parse(line);rows.push(row);if(row.step!=='test_slot.owner_recovery_intent')return;
      callbackCount++;const before=fs.readFileSync(slot,'utf8'),identity=fs.lstatSync(slot);
      assert.equal(mutation.slotMutationPending(slot),true);
      nested=api.acquireTestSlot('nested contender',{...options,isPidAlive:()=>false});assertRefused(nested);
      assert.equal(fs.lstatSync(slot).ino,identity.ino);assert.equal(fs.readFileSync(slot,'utf8'),before);
      assert.equal(mutation.slotMutationPending(slot),true);nested.release();
    }});
    assert.equal(callbackCount,1);assert(nested);assert.equal(outer.outcome,'acquired');
    assert.equal(readOwner().label,'nested outer');const replacement=fs.lstatSync(slot);
    first.release();assert.equal(fs.lstatSync(slot).ino,replacement.ino);
    outer.release();assert.equal(fs.existsSync(slot),false);assert.equal(mutation.slotMutationPending(slot),false);
    console.log(JSON.stringify({nestedRefused:true,outerAcquired:true}));
  `), { nestedRefused: true, outerAcquired: true });
});

for (const kind of ["zero", "partial"]) {
  test(`private exclusive creation rolls back a real ${kind} initial write without published JSON authority`, () => {
    assert.deepEqual(recoveryProbe(`
      const nativeOpen=fs.openSync,nativeWrite=fs.writeSync,nativeUnlink=fs.unlinkSync,nativeStat=fs.fstatSync;
      let ownerFd,writeCalls=0,written=0,canonicalUnlinks=0;
      fs.openSync=(name,flags,...args)=>{const fd=nativeOpen(name,flags,...args);if(name===slot&&flags==='wx+')ownerFd=fd;return fd;};
      fs.writeSync=(fd,...args)=>{
        if(fd===ownerFd){writeCalls++;
          if(${JSON.stringify(kind)}==='partial'&&writeCalls===1){const [buffer,offset,length,position]=args;
            const n=nativeWrite(fd,buffer,offset,Math.min(7,length),position);written+=n;return n;}
          return 0;
        }return nativeWrite(fd,...args);
      };
      fs.unlinkSync=name=>{if(name===slot){canonicalUnlinks++;assert.equal(mutation.slotMutationPending(slot),true);
          assert.equal(fs.lstatSync(slot).size,written);}return nativeUnlink(name);};
      syncBuiltinESMExports();
      const failed=api.acquireTestSlot('initial write fault',options);assertRefused(failed);
      assert.equal(writeCalls,${kind === 'partial' ? 2 : 1});assert.equal(written,${kind === 'partial' ? 7 : 0});
      assert.equal(canonicalUnlinks,1,'the original unpublished inode was actually rolled back');
      assert.throws(()=>nativeStat(ownerFd),{code:'EBADF'});
      assert.equal(fs.existsSync(slot),false);assert.equal(mutation.slotMutationPending(slot),false);
      assert.equal(fs.existsSync(directory),false,'publication never began');
      fs.openSync=nativeOpen;fs.writeSync=nativeWrite;fs.unlinkSync=nativeUnlink;syncBuiltinESMExports();
      const control=api.acquireTestSlot('healthy after rollback',options);assert.equal(control.outcome,'acquired');
      assert.equal(capacity.observeSlotCapacity(slot,1).state,'observed');control.release();
      assert.equal(fs.existsSync(slot),false);
      console.log(JSON.stringify({injected:true,unpublishedRolledBack:true,healthyControl:true}));
    `), { injected: true, unpublishedRolledBack: true, healthyControl: true });
  });
}

for (const target of ["canonical", "projection"]) {
  for (const persistent of [false, true]) {
    test(`private release handles ${persistent ? 'persistent' : 'transient'} ${target} unlink failure without losing live-owner recovery`, () => {
      assert.deepEqual(recoveryProbe(`
        const lease=api.acquireTestSlot('live releasing owner',options);assert.equal(lease.outcome,'acquired');
        const original=readOwner();assert.equal(original.pid,process.pid);assert.equal(original.releaseRequestedAt,undefined);
        const projection=join(directory,fs.readdirSync(directory)[0]);
        const blocked=api.acquireTestSlot('live-owner control',options);assertRefused(blocked);
        assert.equal(readOwner().ownerNonce,original.ownerNonce);
        const nativeUnlink=fs.unlinkSync;let attempts=0;
        const target=${JSON.stringify(target)}==='canonical'?slot:projection;
        fs.unlinkSync=name=>{if(name===target){attempts++;
            if(${JSON.stringify(persistent)}||attempts===1)throw Object.assign(Error('injected unlink denial'),{code:'EACCES'});
          }return nativeUnlink(name);};
        syncBuiltinESMExports();lease.release();
        assert.equal(attempts,${persistent ? 3 : 2});
        assert.equal(mutation.slotMutationPending(slot),false);
        if(${JSON.stringify(persistent)}){
          const terminal=readOwner();assert.equal(terminal.pid,process.pid);assert.equal(terminal.ownerNonce,original.ownerNonce);
          assert.equal(typeof terminal.releaseRequestedAt,'string');assert(Number.isFinite(Date.parse(terminal.releaseRequestedAt)));
          assert(Date.parse(terminal.releaseRequestedAt)<=Date.now());
          assert.equal(capacity.observeSlotCapacity(slot,1).state,${JSON.stringify(target === 'canonical' ? 'unknown' : 'observed')});
          assert(rows.some(row=>row.step==='test_slot.cleanup_incomplete'&&row.ownerRecoveryRequired===true));
          lease.release();assert.equal(attempts,3,'the closed lease does not repeatedly mutate its terminal record');
          fs.unlinkSync=nativeUnlink;syncBuiltinESMExports();
          const recovered=api.acquireTestSlot('terminal recovery while owner lives',{...options,isPidAlive:()=>true});
          assert.equal(recovered.outcome,'acquired',recovered.note);assert.equal(readOwner().pid,process.pid);
          assert.notEqual(readOwner().ownerNonce,original.ownerNonce);assert.equal(readOwner().releaseRequestedAt,undefined);
          assert(rows.some(row=>row.step==='test_slot.owner_recovery'));
          recovered.release();
        }else{
          assert.equal(fs.existsSync(slot),false);assert.equal(fs.existsSync(projection),false);
          assert.equal(rows.some(row=>row.step==='test_slot.cleanup_incomplete'),false);
          fs.unlinkSync=nativeUnlink;syncBuiltinESMExports();
          const control=api.acquireTestSlot('after transient release',options);assert.equal(control.outcome,'acquired');control.release();
        }
        assert.equal(fs.existsSync(slot),false);assert.equal(mutation.slotMutationPending(slot),false);
        console.log(JSON.stringify({injected:true,bounded:true,recoveryWhileAlive:${JSON.stringify(persistent)}}));
      `), { injected: true, bounded: true, recoveryWhileAlive: persistent });
    });
  }
}

test("failed allocation guard release refuses execution and closes every created ownership descriptor", () => {
  assert.deepEqual(recoveryProbe(`
    const nativeOpen=fs.openSync,nativeClose=fs.closeSync,nativeUnlink=fs.unlinkSync;
    const owners=new Set(),guards=new Set();let created=0,guardFailures=0;
    fs.openSync=(name,flags,...args)=>{const fd=nativeOpen(name,flags,...args);
      if(name===slot&&flags==='wx+'){owners.add(fd);created++;}
      if(name===guardPath&&flags==='wx')guards.add(fd);return fd;};
    fs.closeSync=fd=>{const result=nativeClose(fd);owners.delete(fd);guards.delete(fd);return result;};
    fs.unlinkSync=name=>{if(name===guardPath&&guardFailures===0){guardFailures++;throw Object.assign(Error('guard unlink denied'),{code:'EACCES'});}return nativeUnlink(name);};
    syncBuiltinESMExports();
    let diagnosticFailures=0;
    const throwingOptions={...options,log:line=>{const row=JSON.parse(line);rows.push(row);
      if(row.step==='test_slot.mutation_cleanup_incomplete'){diagnosticFailures++;throw Error('diagnostic failure');}}};
    const lease=api.acquireTestSlot('guard finalizer fault',throwingOptions);assertRefused(lease);
    assert.equal(diagnosticFailures,1,'the injected finalizer diagnostic really threw');
    assert.equal(created,1,'the fault occurs after a real ownership descriptor was created');assert.equal(guardFailures,1);
    assert.equal(owners.size,0,'a throwing finalizer must not discard an open ownership descriptor');assert.equal(guards.size,0);
    assert.equal(mutation.slotMutationPending(slot),true,'failed guard removal is occupied, not stolen');
    assert.equal(rows.some(row=>row.step==='test_slot.acquired'||row.step==='test_run.admitted'),false);
    fs.unlinkSync=nativeUnlink;syncBuiltinESMExports();
    const next=api.acquireTestSlot('contended guard control',options);assertRefused(next);assert.equal(created,1);
    console.log(JSON.stringify({executionAllowed:false,ownerDescriptorsClosed:true,guardOccupied:true}));
  `), { executionAllowed: false, ownerDescriptorsClosed: true, guardOccupied: true });
});

test("a release guard finalizer failure does not escape or skip the remaining bounded cleanup attempts", () => {
  assert.deepEqual(recoveryProbe(`
    const nativeOpen=fs.openSync,nativeClose=fs.closeSync,nativeUnlink=fs.unlinkSync;
    const owners=new Set();let guardOpens=0,guardFailures=0,canonicalFailures=0;
    fs.openSync=(name,flags,...args)=>{if(name===guardPath&&flags==='wx')guardOpens++;
      const fd=nativeOpen(name,flags,...args);if(name===slot&&flags==='wx+')owners.add(fd);return fd;};
    fs.closeSync=fd=>{const result=nativeClose(fd);owners.delete(fd);return result;};
    let diagnosticFailures=0;
    const throwingOptions={...options,log:line=>{const row=JSON.parse(line);rows.push(row);
      if(row.step==='test_slot.mutation_cleanup_incomplete'){diagnosticFailures++;throw Error('diagnostic failure');}}};
    syncBuiltinESMExports();const lease=api.acquireTestSlot('release finalizer fault',throwingOptions);assert.equal(lease.outcome,'acquired');
    guardOpens=0;
    fs.unlinkSync=name=>{
      if(name===slot&&canonicalFailures===0){canonicalFailures++;throw Object.assign(Error('canonical unlink denied'),{code:'EACCES'});}
      if(name===guardPath&&guardFailures===0){guardFailures++;throw Object.assign(Error('guard unlink denied'),{code:'EACCES'});}
      return nativeUnlink(name);
    };
    syncBuiltinESMExports();assert.doesNotThrow(()=>lease.release());
    assert.equal(canonicalFailures,1);assert.equal(guardFailures,1);
    assert.equal(diagnosticFailures,1,'the injected release diagnostic really threw');
    assert(guardOpens>=3&&guardOpens<=4,'guard-finalizer failure must not bypass the three-attempt release bound');
    assert.equal(owners.size,0);assert.equal(fs.existsSync(slot),true);assert.equal(mutation.slotMutationPending(slot),true);
    assert(rows.some(row=>row.step==='test_slot.cleanup_incomplete'&&row.ownerRecoveryRequired===true));
    console.log(JSON.stringify({bounded:true,ownerDescriptorsClosed:true,unresolvedOccupied:true}));
  `), { bounded: true, ownerDescriptorsClosed: true, unresolvedOccupied: true });
});

test("default reader refuses after real guard creation succeeds but its descriptor inspection fails", () => {
  assert.deepEqual(recoveryProbe(`
    const nativeOpen=fs.openSync,nativeStat=fs.fstatSync;let guardFd,created=0,inspections=0;
    fs.openSync=(name,flags,...args)=>{const fd=nativeOpen(name,flags,...args);
      if(name===guardPath&&flags==='wx'){guardFd=fd;created++;}return fd;};
    fs.fstatSync=(fd,...args)=>{if(fd===guardFd){inspections++;throw Object.assign(Error('guard inspection failure'),{code:'EIO'});}return nativeStat(fd,...args);};
    syncBuiltinESMExports();
    const {ownershipProtocol,privateCoordinationRequired,...legacyOptions}=options;
    const lease=api.acquireTestSlot('default reader after inspection failure',legacyOptions);assertRefused(lease);
    assert.equal(created,1);assert.equal(inspections,1);assert.throws(()=>nativeStat(guardFd),{code:'EBADF'});
    assert.equal(mutation.slotMutationPending(slot),true);assert.equal(fs.existsSync(slot),false);
    console.log(JSON.stringify({executionAllowed:false,guardOccupied:true,descriptorClosed:true}));
  `), { executionAllowed: false, guardOccupied: true, descriptorClosed: true });
});
