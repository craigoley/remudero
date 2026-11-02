import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeSlotCapacity, publishSlotCapacity, retireOwnedSlotCapacity, SlotCapacityCleanupError } from "#src/lib/test-slot-capacity.js";
import { acquireSlotMutation, slotMutationPending } from "#src/lib/test-slot-mutation.js";

const MUTATION_URL = new URL("../src/lib/test-slot-mutation.ts", import.meta.url).href;
const CAPACITY_URL = new URL("../src/lib/test-slot-capacity.ts", import.meta.url).href;
const allocation = { concurrency: 2, memoryBytes: 8192 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-private-mutation-"));
  return { root, path: join(root, "slot-1.json"), guard: join(root, ".slot-1.json.mutation"),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Faults affect only an isolated child's fs bindings; the assertions use real temporary inodes. */
function probe(root: string, program: string) {
  const child = spawnSync(process.execPath, ["--enable-source-maps", "--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const root=process.argv[1],slot=join(root,'slot-1.json'),guardPath=join(root,'.slot-1.json.mutation');
    const mutationUrl=${JSON.stringify(MUTATION_URL)},capacityUrl=${JSON.stringify(CAPACITY_URL)};
    ${program}
  `, root], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, TSX_DISABLE_CACHE: "1" } });
  assert.equal(child.status, 0, String(child.error ?? child.stderr));
  return JSON.parse(child.stdout.trim());
}

function capacityProbe(root: string, program: string) {
  return probe(root, `
    const fd=fs.openSync(slot,'wx+',0o600);fs.writeSync(fd,'small private fixture');
    const input={concurrency:2,memoryBytes:8192};
    const directory=join(root,'capacity-'+process.getuid()),projection=join(directory,'v1.1.2.8192');
    const {acquireSlotMutation}=await import(mutationUrl),guard=acquireSlotMutation(slot);
    assert.equal(guard.state,'acquired');
    try { ${program} } finally { guard.release();fs.closeSync(fd); }
  `);
}

test("slot mutation guards are empty private exclusive per-slot claims and release is idempotent", () => {
  const fx = fixture();
  const first = acquireSlotMutation(fx.path), other = acquireSlotMutation(join(fx.root, "slot-2.json"));
  try {
    assert.equal(first.state, "acquired"); assert.equal(other.state, "acquired");
    if (first.state !== "acquired" || other.state !== "acquired") assert.fail("real guard acquisition failed");
    const held = lstatSync(fx.guard);
    assert.equal(held.size, 0); assert.equal(held.mode & 0o777, 0o600); assert.equal(held.uid, process.getuid?.());
    assert.equal(existsSync(fx.path), false, "the guard never creates or opens ownership JSON");
    assert.equal(slotMutationPending(fx.path), true);
    assert.deepEqual(acquireSlotMutation(fx.path), { state: "busy", reason: "contended" });
    first.release(); first.release();
    assert.equal(slotMutationPending(fx.path), false);
    const next = acquireSlotMutation(fx.path);
    assert.equal(next.state, "acquired"); if (next.state === "acquired") next.release();
  } finally {
    if (first.state === "acquired") first.release();
    if (other.state === "acquired") other.release();
    fx.cleanup();
  }
});

test("another real process cannot acquire an occupied mutation guard", () => {
  const fx = fixture(), held = acquireSlotMutation(fx.path);
  try {
    assert.equal(held.state, "acquired");
    const attempt = `const {acquireSlotMutation}=await import(mutationUrl);
      const result=acquireSlotMutation(slot);if(result.state==='acquired')result.release();
      console.log(JSON.stringify({state:result.state,...(result.reason?{reason:result.reason}:{})}));`;
    assert.deepEqual(probe(fx.root, attempt), { state: "busy", reason: "contended" });
    if (held.state === "acquired") held.release();
    assert.deepEqual(probe(fx.root, attempt), { state: "acquired" });
  } finally { if (held.state === "acquired") held.release(); fx.cleanup(); }
});

test("abandoned mutation guards are occupied regardless of age and never stolen", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.guard, "", { mode: 0o600 }); utimesSync(fx.guard, 1, 1);
    const original = lstatSync(fx.guard);
    assert.deepEqual(acquireSlotMutation(fx.path), { state: "busy", reason: "contended" });
    assert.equal(slotMutationPending(fx.path), true);
    assert.equal(lstatSync(fx.guard).ino, original.ino); assert.equal(lstatSync(fx.guard).mtimeMs, original.mtimeMs);
  } finally { fx.cleanup(); }
});

test("non-file guards remain contended and an unusable parent remains unavailable", () => {
  const fx = fixture();
  try {
    mkdirSync(fx.guard);
    assert.deepEqual(acquireSlotMutation(fx.path), { state: "busy", reason: "contended" });
    assert.equal(slotMutationPending(fx.path), true);
    const blocker = join(fx.root, "not-a-directory"); writeFileSync(blocker, "blocker");
    const path = join(blocker, "slot-1.json");
    assert.deepEqual(acquireSlotMutation(path), { state: "busy", reason: "unavailable" });
    assert.equal(slotMutationPending(path), true, "ENOTDIR is not evidence of free capacity");
  } finally { fx.cleanup(); }
});

for (const kind of ["file", "symlink"]) {
  test(`old mutation release preserves a ${kind} replacement instead of unlinking it`, () => {
    const fx = fixture(), held = acquireSlotMutation(fx.path);
    try {
      assert.equal(held.state, "acquired"); if (held.state !== "acquired") assert.fail();
      renameSync(fx.guard, join(fx.root, "retained-guard"));
      const sentinel = join(fx.root, "sentinel"); writeFileSync(sentinel, "foreign replacement");
      if (kind === "symlink") symlinkSync(sentinel, fx.guard);
      else {
        // Same uid, mode and zero length as the old guard: identity must be load-bearing.
        writeFileSync(fx.guard, "", { mode: 0o600 });
        assert.notEqual(lstatSync(fx.guard).ino, lstatSync(join(fx.root, "retained-guard")).ino);
      }
      assert.throws(() => held.release(), /ownership changed/);
      assert.equal(readFileSync(fx.guard, "utf8"), kind === "symlink" ? "foreign replacement" : "");
      if (kind === "symlink") assert.equal(lstatSync(fx.guard).isSymbolicLink(), true);
      assert.equal(slotMutationPending(fx.path), true);
      assert.deepEqual(acquireSlotMutation(fx.path), { state: "busy", reason: "contended" });
      held.release();
    } finally { if (held.state === "acquired") held.release(); fx.cleanup(); }
  });
}

test("unknown guard lookup and create failures report unavailable without establishing free capacity", () => {
  const fx = fixture();
  try {
    assert.deepEqual(probe(fx.root, `
      const api=await import(mutationUrl);assert.equal(api.slotMutationPending(slot),false);
      const nativeStat=fs.lstatSync,nativeOpen=fs.openSync;let looked=0,opened=0;
      fs.lstatSync=(name,...args)=>{if(name===guardPath){looked++;throw Object.assign(Error('denied'),{code:'EACCES'});}return nativeStat(name,...args);};
      fs.openSync=(name,...args)=>{if(name===guardPath){opened++;throw Object.assign(Error('io'),{code:'EIO'});}return nativeOpen(name,...args);};
      syncBuiltinESMExports();
      assert.equal(api.slotMutationPending(slot),true);
      assert.deepEqual(api.acquireSlotMutation(slot),{state:'busy',reason:'unavailable'});
      assert.equal(looked,1);assert.equal(opened,1);
      assert.throws(()=>nativeStat(guardPath),{code:'ENOENT'});
      console.log(JSON.stringify({unknown:true}));
    `), { unknown: true });
  } finally { fx.cleanup(); }
});

test("guard inspection failure closes the real descriptor and retains an occupied guard", () => {
  const fx = fixture();
  try {
    assert.deepEqual(probe(fx.root, `
      const nativeOpen=fs.openSync,nativeStat=fs.fstatSync;let fd,inspected=0;
      fs.openSync=(name,...args)=>{const opened=nativeOpen(name,...args);if(name===guardPath)fd=opened;return opened;};
      fs.fstatSync=(opened,...args)=>{if(opened===fd){inspected++;throw Object.assign(Error('inspection failed'),{code:'EIO'});}return nativeStat(opened,...args);};
      syncBuiltinESMExports();const api=await import(mutationUrl);
      assert.deepEqual(api.acquireSlotMutation(slot),{state:'busy',reason:'unavailable'});
      assert.equal(inspected,1);assert.throws(()=>nativeStat(fd),{code:'EBADF'});
      assert.equal(api.slotMutationPending(slot),true);
      assert.deepEqual(api.acquireSlotMutation(slot),{state:'busy',reason:'contended'});
      console.log(JSON.stringify({closed:true,occupied:true}));
    `), { closed: true, occupied: true });
  } finally { fx.cleanup(); }
});

test("guard release tolerates its already-unlinked pathname and closes the retained descriptor", () => {
  const fx = fixture();
  try {
    assert.deepEqual(probe(fx.root, `
      const nativeOpen=fs.openSync,nativeStat=fs.fstatSync,nativeUnlink=fs.unlinkSync;
      let guardFd,guardOpens=0;
      fs.openSync=(name,flags,...args)=>{const fd=nativeOpen(name,flags,...args);
        if(name===guardPath&&flags==='wx'){guardFd=fd;guardOpens++;}return fd;};
      syncBuiltinESMExports();const api=await import(mutationUrl),held=api.acquireSlotMutation(slot);
      assert.equal(held.state,'acquired');assert.equal(guardOpens,1);
      assert.equal(nativeStat(guardFd).size,0);assert.equal(api.slotMutationPending(slot),true);
      nativeUnlink(guardPath);
      assert.throws(()=>fs.lstatSync(guardPath),{code:'ENOENT'});
      assert.equal(nativeStat(guardFd).size,0,'raw unlink leaves the real ownership descriptor open until release');
      assert.doesNotThrow(()=>held.release());
      assert.throws(()=>nativeStat(guardFd),{code:'EBADF'});
      assert.doesNotThrow(()=>held.release());
      assert.equal(api.slotMutationPending(slot),false);
      console.log(JSON.stringify({missingPathReleased:true,descriptorClosed:true,pending:false}));
    `), { missingPathReleased: true, descriptorClosed: true, pending: false });
  } finally { fx.cleanup(); }
});

test("guard release aggregates unlink and close failures without retrying or claiming free capacity", () => {
  const fx = fixture();
  try {
    assert.deepEqual(probe(fx.root, `
      const nativeOpen=fs.openSync,nativeStat=fs.fstatSync,nativeClose=fs.closeSync,nativeUnlink=fs.unlinkSync;
      let fd,unlinks=0,closes=0;
      fs.openSync=(name,...args)=>{const opened=nativeOpen(name,...args);if(name===guardPath)fd=opened;return opened;};
      syncBuiltinESMExports();const api=await import(mutationUrl),held=api.acquireSlotMutation(slot);assert.equal(held.state,'acquired');
      assert.equal(nativeStat(fd).size,0,'the descriptor is retained while held');
      const unlinkError=Object.assign(Error('unlink denied'),{code:'EACCES'}),closeError=Error('close diagnostic');
      fs.unlinkSync=(name)=>{if(name===guardPath){unlinks++;throw unlinkError;}return nativeUnlink(name);};
      fs.closeSync=(opened)=>{if(opened===fd){closes++;nativeClose(opened);throw closeError;}return nativeClose(opened);};
      syncBuiltinESMExports();
      assert.throws(()=>held.release(),error=>error instanceof AggregateError&&error.errors[0]===unlinkError&&error.errors[1]===closeError);
      held.release();assert.equal(unlinks,1);assert.equal(closes,1);
      assert.throws(()=>nativeStat(fd),{code:'EBADF'});assert.equal(api.slotMutationPending(slot),true);
      console.log(JSON.stringify({aggregated:true,occupied:true}));
    `), { aggregated: true, occupied: true });
  } finally { fx.cleanup(); }
});

test("returned capacity cleanup handles a later caller failure while its original descriptor and guard remain held", () => {
  const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
  try {
    assert.equal(guard.state, "acquired"); writeSync(fd, "small private fixture");
    const remove = publishSlotCapacity(fx.path, fd, 1, allocation);
    assert.equal(observeSlotCapacity(fx.path, 1).state, "observed", "the owner may read capacity under its own guard");
    const directory = join(fx.root, `capacity-${lstatSync(fx.path).uid}`);
    assert.equal(readdirSync(directory).length, 1);
    const failure = Error("caller failed after publication");
    try { throw failure; } catch (error) { assert.equal(error, failure); remove(); }
    remove(); assert.deepEqual(readdirSync(directory), []);
    assert.equal(existsSync(fx.path), true, "metadata cleanup leaves canonical deletion to the owner");
  } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
});

test("capacity validation precedes directory writes and retirement tolerates unpublished own metadata", () => {
  const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
  try {
    writeSync(fd, "small private fixture"); const owner = lstatSync(fx.path), before = readdirSync(fx.root).sort();
    assert.throws(() => publishSlotCapacity(fx.path, fd, 1, { concurrency: 0 }), /invalid slot capacity/);
    assert.deepEqual(readdirSync(fx.root).sort(), before);
    retireOwnedSlotCapacity(fx.path, 1, allocation, owner);
    const directory = join(fx.root, `capacity-${owner.uid}`); mkdirSync(directory, { mode: 0o755 });
    retireOwnedSlotCapacity(fx.path, 1, allocation, owner);
    chmodSync(directory, 0o700);
    assert.throws(() => retireOwnedSlotCapacity(fx.path, 1, allocation, owner),
      error => error instanceof SlotCapacityCleanupError && /unsafe slot capacity directory/.test(error.message));
    assert.equal(existsSync(fx.path), true);
  } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
});

test("capacity retirement leaves a canonical UNKNOWN anchor until the validated owner deletes it", () => {
  const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
  try {
    assert.equal(guard.state, "acquired"); writeSync(fd, "small private fixture");
    publishSlotCapacity(fx.path, fd, 1, allocation);
    assert.equal(observeSlotCapacity(fx.path, 1).state, "observed");
    const owner = lstatSync(fx.path);
    retireOwnedSlotCapacity(fx.path, 1, allocation, owner);
    assert.equal(lstatSync(fx.path).ino, owner.ino);
    assert.equal(readFileSync(fx.path, "utf8"), "small private fixture");
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
    assert.deepEqual(acquireSlotMutation(fx.path), { state: "busy", reason: "contended" });
  } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
});

test("capacity cleanup refuses a substituted directory symlink and retries after the safe directory returns", () => {
  const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
  try {
    assert.equal(guard.state, "acquired"); writeSync(fd, "small private fixture");
    const remove = publishSlotCapacity(fx.path, fd, 1, allocation), owner = lstatSync(fx.path);
    const directory = join(fx.root, `capacity-${owner.uid}`), retained = join(fx.root, "retained-capacity");
    renameSync(directory, retained); symlinkSync(retained, directory);
    assert.throws(() => remove(), error => error instanceof SlotCapacityCleanupError && error.cleanupIncomplete);
    assert.throws(() => retireOwnedSlotCapacity(fx.path, 1, allocation, owner), SlotCapacityCleanupError);
    assert.equal(lstatSync(join(retained, "v1.1.2.8192")).ino, owner.ino);
    assert.equal(lstatSync(fx.path).ino, owner.ino);
    rmSync(directory); renameSync(retained, directory);
    remove(); assert.deepEqual(readdirSync(directory), []);
    assert.equal(existsSync(fx.path), true);
  } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
});

for (const kind of ["file", "symlink"]) {
  test(`capacity retirement and returned cleanup preserve a later ${kind} projection replacement`, () => {
    const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
    try {
      assert.equal(guard.state, "acquired"); writeSync(fd, "small private fixture");
      const remove = publishSlotCapacity(fx.path, fd, 1, allocation), owner = lstatSync(fx.path);
      const projection = join(fx.root, `capacity-${owner.uid}`, "v1.1.2.8192"), retained = join(fx.root, "retained-projection");
      renameSync(projection, retained);
      const sentinel = join(fx.root, "projection-sentinel"); writeFileSync(sentinel, "foreign projection");
      if (kind === "symlink") symlinkSync(sentinel, projection);
      else writeFileSync(projection, "", { mode: 0o600 });
      const replacement = lstatSync(projection);
      assert.notEqual(replacement.ino, owner.ino);
      remove(); retireOwnedSlotCapacity(fx.path, 1, allocation, owner);
      assert.equal(lstatSync(projection).ino, replacement.ino);
      assert.equal(readFileSync(projection, "utf8"), kind === "symlink" ? "foreign projection" : "");
      assert.equal(lstatSync(fx.path).ino, owner.ino);
    } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
  });
}

for (const kind of ["foreign", "same-inode"]) {
  test(`capacity publication preserves an EEXIST ${kind} projection it did not create`, () => {
    const fx = fixture(), guard = acquireSlotMutation(fx.path), fd = openSync(fx.path, "wx+", 0o600);
    try {
      writeSync(fd, "small private fixture");
      const directory = join(fx.root, `capacity-${lstatSync(fx.path).uid}`), projection = join(directory, "v1.1.2.8192");
      mkdirSync(directory, { mode: 0o755 });
      if (kind === "same-inode") linkSync(fx.path, projection); else writeFileSync(projection, "foreign", { mode: 0o600 });
      const original = lstatSync(projection), bytes = readFileSync(projection, "utf8");
      assert.throws(() => publishSlotCapacity(fx.path, fd, 1, allocation), { code: "EEXIST" });
      assert.equal(lstatSync(projection).ino, original.ino); assert.equal(readFileSync(projection, "utf8"), bytes);
    } finally { closeSync(fd); if (guard.state === "acquired") guard.release(); fx.cleanup(); }
  });
}

test("capacity verification failure rolls back a real small hard link and permits identical re-publication", () => {
  const fx = fixture();
  try {
    assert.deepEqual(capacityProbe(fx.root, `
      const nativeLink=fs.linkSync,nativeStat=fs.lstatSync;let linked=0,failures=0;
      const primary=Object.assign(Error('verification failed'),{code:'EIO'});
      fs.linkSync=(from,to)=>{nativeLink(from,to);if(to===projection)linked++;};
      fs.lstatSync=(name,...args)=>{if(name===projection&&linked===1&&failures===0){failures++;throw primary;}return nativeStat(name,...args);};
      syncBuiltinESMExports();const api=await import(capacityUrl);
      assert.throws(()=>api.publishSlotCapacity(slot,fd,1,input),error=>error===primary);
      assert.equal(linked,1);assert.equal(failures,1);assert.equal(fs.existsSync(projection),false);
      assert.equal(fs.readFileSync(slot,'utf8'),'small private fixture');
      const remove=api.publishSlotCapacity(slot,fd,1,input);assert.equal(linked,2);
      assert.equal(nativeStat(projection).ino,nativeStat(slot).ino);remove();
      assert.equal(fs.existsSync(projection),false);console.log(JSON.stringify({rolledBack:true,reused:true}));
    `), { rolledBack: true, reused: true });
  } finally { fx.cleanup(); }
});

test("capacity rollback failure aggregates both errors and leaves the canonical anchor available for retry", () => {
  const fx = fixture();
  try {
    assert.deepEqual(capacityProbe(fx.root, `
      const nativeStat=fs.lstatSync,nativeUnlink=fs.unlinkSync;let failures=0,unlinks=0;
      const primary=Object.assign(Error('verification failed'),{code:'EIO'}),cleanup=Object.assign(Error('unlink denied'),{code:'EACCES'});
      fs.lstatSync=(name,...args)=>{if(name===projection&&failures===0){failures++;throw primary;}return nativeStat(name,...args);};
      fs.unlinkSync=(name)=>{if(name===projection){unlinks++;throw cleanup;}return nativeUnlink(name);};
      syncBuiltinESMExports();const api=await import(capacityUrl);
      assert.throws(()=>api.publishSlotCapacity(slot,fd,1,input),error=>error instanceof api.SlotCapacityCleanupError&&error.cleanupIncomplete===true&&error.errors[0]===primary&&error.errors[1]===cleanup);
      assert.equal(failures,1);assert.equal(unlinks,1);
      assert.equal(nativeStat(projection).ino,nativeStat(slot).ino);assert.equal(fs.existsSync(slot),true);
      fs.unlinkSync=nativeUnlink;syncBuiltinESMExports();
      api.retireOwnedSlotCapacity(slot,1,input,nativeStat(slot));
      assert.equal(fs.existsSync(projection),false);assert.equal(fs.existsSync(slot),true);
      console.log(JSON.stringify({aggregated:true,anchorRetained:true}));
    `), { aggregated: true, anchorRetained: true });
  } finally { fx.cleanup(); }
});

test("capacity rollback preserves a foreign inode installed during publication verification", () => {
  const fx = fixture();
  try {
    assert.deepEqual(capacityProbe(fx.root, `
      const nativeStat=fs.lstatSync,nativeUnlink=fs.unlinkSync;let swapped=false;
      fs.lstatSync=(name,...args)=>{if(name===projection&&!swapped){swapped=true;nativeUnlink(projection);fs.writeFileSync(projection,'foreign replacement',{mode:0o600});}return nativeStat(name,...args);};
      syncBuiltinESMExports();const api=await import(capacityUrl);
      assert.throws(()=>api.publishSlotCapacity(slot,fd,1,input),/slot changed during capacity publication/);
      assert.equal(swapped,true);assert.equal(fs.readFileSync(projection,'utf8'),'foreign replacement');
      assert.equal(fs.readFileSync(slot,'utf8'),'small private fixture');
      console.log(JSON.stringify({preserved:true}));
    `), { preserved: true });
  } finally { fx.cleanup(); }
});

test("returned capacity cleanup reports incomplete removal and can retry without deleting canonical ownership", () => {
  const fx = fixture();
  try {
    assert.deepEqual(capacityProbe(fx.root, `
      const api=await import(capacityUrl),remove=api.publishSlotCapacity(slot,fd,1,input);
      const nativeUnlink=fs.unlinkSync;let failures=0;
      const denied=Object.assign(Error('cleanup denied'),{code:'EACCES'});
      fs.unlinkSync=(name)=>{if(name===projection&&failures===0){failures++;throw denied;}return nativeUnlink(name);};
      syncBuiltinESMExports();
      assert.throws(()=>remove(),error=>error instanceof api.SlotCapacityCleanupError&&error.errors[0]===denied);
      assert.equal(failures,1);assert.equal(fs.existsSync(projection),true);assert.equal(fs.existsSync(slot),true);
      remove();assert.equal(fs.existsSync(projection),false);assert.equal(fs.existsSync(slot),true);
      console.log(JSON.stringify({retryable:true,anchorRetained:true}));
    `), { retryable: true, anchorRetained: true });
  } finally { fx.cleanup(); }
});
